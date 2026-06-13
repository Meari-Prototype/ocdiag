import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import chalk from "chalk";
import type { GatewayClient } from "../client.js";
import type { AgentEventPayload, EventFrame } from "../protocol.js";

/**
 * The fixed sessionKey for all ocdiag ↔ agent communication.
 * This maps to the "agent:main:gateway:direct" session entry,
 * avoiding context pollution in the heartbeat or other sessions.
 */
const OCDIAG_SESSION_KEY = "gateway:direct";

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
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (text: string) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (fullText) process.stdout.write("\n");
      resolve(text);
    };

    const fail = (err: Error) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      reject(err);
    };

    const debug = process.env.OCDIAG_DEBUG === "1";

    const onEvent = (frame: EventFrame) => {
      if (debug) console.error("[debug] event:", frame.event, JSON.stringify(frame.payload).slice(0, 200));
      if (frame.event !== "agent") return;
      const payload = frame.payload as AgentEventPayload | undefined;
      if (!payload) return;

      // Once we know the server runId, filter by it.
      // Before that, accept all agent events (only one request in flight).
      if (serverRunId && payload.runId !== serverRunId) return;

      if (payload.stream === "assistant") {
        const delta = payload.data?.delta ?? payload.data?.text ?? "";
        if (typeof delta === "string" && delta) {
          process.stdout.write(delta);
          fullText += delta;
        }
      }

      if (payload.stream === "lifecycle") {
        const phase = payload.data?.phase;
        const status = payload.data?.status;
        if (phase === "end" || status === "complete" || status === "error") {
          finish(fullText);
        }
      }

      if (payload.stream === "error") {
        const msg = payload.data?.message ?? payload.data?.error ?? "Agent error";
        fail(new Error(String(msg)));
      }
    };

    // Subscribe to events BEFORE sending the request to avoid missing any.
    addAgentEventListener(onEvent);

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
        if (debug) console.error("[debug] preliminary response:", JSON.stringify(preliminary));
        // Capture the server's runId for event filtering.
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
    timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        resolve(fullText || "(timeout — no response within 5 minutes)");
      }
    }, 5 * 60 * 1000);
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

    process.stdout.write(chalk.green("agent> "));
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
