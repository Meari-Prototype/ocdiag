import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import chalk from "chalk";
import type { GatewayClient } from "../client.js";
import type { AgentEventPayload, EventFrame } from "../protocol.js";
import { stripControl } from "../openclaw-schema.js";
import { sanitizeConfigForOutput } from "../redact.js";

/**
 * The fixed sessionKey for all ocdiag ↔ agent communication.
 * This maps to the "agent:main:gateway:direct" session entry,
 * avoiding context pollution in the heartbeat or other sessions.
 */
const OCDIAG_SESSION_KEY = "gateway:direct";

/** A transient stderr "thinking…" spinner, shown only when stderr is a TTY. */
function createSpinner() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let timer: ReturnType<typeof setInterval> | undefined;
  let i = 0;
  let active = false;
  return {
    start() {
      if (!process.stderr.isTTY) return;
      active = true;
      timer = setInterval(() => {
        process.stderr.write(`\r${chalk.dim(`${frames[i++ % frames.length]} thinking…`)}`);
      }, 80);
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (active) {
        process.stderr.write("\r\x1b[2K"); // clear the spinner line
        active = false;
      }
    },
  };
}

/**
 * Send a single message to the agent, stream the response, then return.
 * Used by both one-shot `chat` and the `diagnose` command.
 *
 * The gateway agent handler uses a two-phase response pattern:
 *   1. Preliminary res frame: { runId, status: "accepted" }
 *   2. Streaming "agent" event frames with that runId
 *   3. Final res frame: { runId, status: "ok"|"error" } (same request id)
 *
 * We capture the runId from the preliminary response, then resolve when
 * we see a lifecycle complete/error event or a final response.
 *
 * The "agent> " prefix is printed here on the first streamed token (after the
 * thinking spinner clears), so callers don't print a dangling prefix on failure.
 */
export async function sendToAgent(
  client: GatewayClient,
  message: string,
  opts?: { agentId?: string; sessionKey?: string; extraSystemPrompt?: string },
): Promise<string> {
  const idempotencyKey = randomUUID();
  let fullText = "";
  let serverRunId: string | null = null;

  return new Promise<string>((resolve, reject) => {
    let finished = false;
    let started = false; // whether the "agent> " prefix has been printed yet
    let timer: ReturnType<typeof setTimeout> | undefined;
    const spinner = createSpinner();

    const finish = (text: string) => {
      if (finished) return;
      finished = true;
      spinner.stop();
      if (timer) clearTimeout(timer);
      if (fullText) process.stdout.write("\n");
      resolve(text);
    };

    const fail = (err: Error) => {
      if (finished) return;
      finished = true;
      spinner.stop();
      if (timer) clearTimeout(timer);
      reject(err);
    };

    const debug = process.env.OCDIAG_DEBUG === "1";

    const onEvent = (frame: EventFrame) => {
      if (debug)
        console.error("[debug] event:", frame.event, JSON.stringify(sanitizeConfigForOutput(frame.payload)).slice(0, 200));
      if (frame.event !== "agent") return;
      const payload = frame.payload as AgentEventPayload | undefined;
      if (!payload) return;

      // Once we know the server runId, filter by it.
      // Before that, accept all agent events (only one request in flight).
      if (serverRunId && payload.runId !== serverRunId) return;

      if (payload.stream === "assistant") {
        const delta = payload.data?.delta ?? payload.data?.text ?? "";
        if (typeof delta === "string" && delta) {
          const safe = stripControl(delta); // 不可信智能体输出：剥终端转义序列，防注入
          spinner.stop();
          if (!started) {
            process.stdout.write(chalk.green("agent> "));
            started = true;
          }
          process.stdout.write(safe);
          fullText += safe;
        }
      }

      if (payload.stream === "lifecycle") {
        const phase = payload.data?.phase;
        const status = payload.data?.status;
        if (status === "error") {
          // lifecycle 报错单独走失败路径，别把半截输出当成功完成（即便没收到独立 error 帧）。
          const msg = payload.data?.message ?? payload.data?.error ?? "Agent run ended with error";
          fail(new Error(stripControl(String(msg))));
        } else if (phase === "end" || status === "complete") {
          finish(fullText);
        }
      }

      if (payload.stream === "error") {
        const msg = payload.data?.message ?? payload.data?.error ?? "Agent error";
        fail(new Error(stripControl(String(msg))));
      }
    };

    // Subscribe to events BEFORE sending the request to avoid missing any,
    // and start the spinner so the user knows we're waiting on the agent.
    addAgentEventListener(onEvent);
    spinner.start();

    // Send the request. The first res frame is the preliminary "accepted"
    // response containing the server-generated runId.
    client
      .request<{ runId: string; status: string }>("agent", {
        message,
        idempotencyKey,
        agentId: opts?.agentId ?? "main",
        sessionKey: opts?.sessionKey ?? OCDIAG_SESSION_KEY,
        extraSystemPrompt: opts?.extraSystemPrompt,
      })
      .then((preliminary) => {
        if (debug) console.error("[debug] preliminary response:", JSON.stringify(sanitizeConfigForOutput(preliminary)));
        if (preliminary?.runId) {
          serverRunId = preliminary.runId;
        }
        // Don't resolve here — this is just the "accepted" ack.
        // We wait for lifecycle events or the safety timeout.
      })
      .catch((err) => {
        if (debug) console.error("[debug] request error:", err);
        fail(err);
      });

    // Safety timeout: 5 minutes. Cleared on finish/fail, and unref'd so it
    // never keeps the process alive on its own (e.g. one-shot `chat` exiting).
    timer = setTimeout(
      () => {
        if (finished) return;
        finished = true;
        spinner.stop();
        if (started) {
          // Partial text already streamed — mark it as truncated, not complete.
          process.stdout.write(chalk.dim("\n[truncated: no completion within 5 minutes]\n"));
        } else {
          process.stderr.write(chalk.yellow("(timed out after 5 minutes with no response)\n"));
        }
        resolve(fullText);
      },
      5 * 60 * 1000,
    );
    timer.unref?.();
  }).finally(() => {
    removeAgentEventListener();
  });
}

// Simple global event listener slot for agent events.
// In a real app you'd want a proper EventEmitter, but this is a CLI tool.
let _agentEventListener: ((frame: EventFrame) => void) | null = null;

export function addAgentEventListener(fn: (frame: EventFrame) => void) {
  _agentEventListener = fn;
}

export function removeAgentEventListener() {
  _agentEventListener = null;
}

export function dispatchAgentEvent(frame: EventFrame) {
  _agentEventListener?.(frame);
}

/**
 * Interactive REPL: read messages from stdin, send to agent, stream responses.
 */
export async function chatRepl(client: GatewayClient) {
  console.log(chalk.dim(`Interactive chat with OpenClaw agent (session: ${OCDIAG_SESSION_KEY}). Type /quit to exit.\n`));

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan("you> "),
  });

  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }
    if (trimmed === "/quit" || trimmed === "/exit") {
      break;
    }

    try {
      await sendToAgent(client, trimmed);
    } catch (err) {
      console.error(chalk.red(`Error: ${err}`));
    }
    console.log();
    rl.prompt();
  }

  rl.close();
}
