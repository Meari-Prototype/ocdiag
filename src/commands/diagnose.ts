import chalk from "chalk";
import type { GatewayClient } from "../client.js";
import { sendToAgent } from "./chat.js";
import { sanitizeConfigForOutput } from "../redact.js";
import { canonicalConfig, viewHealth, viewChannels } from "../openclaw-schema.js";

export type DiagnosticFinding = {
  severity: "error" | "warn" | "info";
  area: string;
  message: string;
};

/**
 * Diagnose command: collect system state, analyze locally, then ask the agent
 * for advice. This never writes config, but the agent advice request can
 * update the dedicated diagnostic chat session.
 */
export async function diagnoseCommand(client: GatewayClient) {
  console.log(chalk.bold("Collecting diagnostics...\n"));
  const findings: DiagnosticFinding[] = [];

  // 1. Health
  let health: Record<string, unknown> | null = null;
  try {
    health = await client.request<Record<string, unknown>>("health");
    analyzeHealth(health, findings);
  } catch (err) {
    findings.push({ severity: "error", area: "health", message: `Health check failed: ${err}` });
  }

  // 2. Config — config.get returns several near-identical layers; analyze/send just one.
  let config: Record<string, unknown> | null = null;
  try {
    const raw = await client.request<unknown>("config.get");
    config = canonicalConfig(raw).value as Record<string, unknown>;
  } catch (err) {
    findings.push({ severity: "error", area: "config", message: `Cannot read config: ${err}` });
  }

  if (config) {
    analyzeConfig(config, findings);
  }

  // 3. Channel status — channels.status returns an OBJECT
  // ({ channelOrder, channels, channelAccounts, … }), never an array.
  let channels: Record<string, unknown> | null = null;
  try {
    const result = await client.request<unknown>("channels.status");
    channels =
      result && typeof result === "object" && !Array.isArray(result)
        ? (result as Record<string, unknown>)
        : null;
  } catch (err) {
    findings.push({
      severity: "warn",
      area: "channels",
      message: `Cannot get channel status: ${err}`,
    });
  }

  if (channels) {
    analyzeChannels(channels, findings);
  }

  // 4. Memory status
  try {
    const memStatus = await client.request<Record<string, unknown>>("doctor.memory.status");
    if (memStatus) {
      findings.push({
        severity: "info",
        area: "memory",
        message: `Memory status: ${JSON.stringify(memStatus)}`,
      });
    }
  } catch {
    // Optional — not all gateways support this.
  }

  // 5. Usage
  try {
    const usage = await client.request<Record<string, unknown>>("usage.status");
    if (usage) {
      findings.push({
        severity: "info",
        area: "usage",
        message: `Usage: ${JSON.stringify(usage)}`,
      });
    }
  } catch {
    // Optional.
  }

  // Print local findings.
  console.log(chalk.bold("Findings:\n"));
  for (const f of findings) {
    const icon =
      f.severity === "error"
        ? chalk.red("ERR")
        : f.severity === "warn"
          ? chalk.yellow("WARN")
          : chalk.blue("INFO");
    console.log(`  ${icon} [${f.area}] ${f.message}`);
  }

  const errors = findings.filter((f) => f.severity === "error");
  const warns = findings.filter((f) => f.severity === "warn");

  if (errors.length === 0 && warns.length === 0) {
    console.log(chalk.green("\nNo issues detected."));
    return;
  }

  // Build a summary to send to the agent.
  console.log(chalk.bold("\nAsking agent for diagnosis...\n"));
  const summary = buildDiagnosticSummary(findings, config, channels);

  try {
    await sendToAgent(client, summary, {
      extraSystemPrompt:
        "You are helping diagnose OpenClaw configuration issues. " +
        "The user has collected the following diagnostic data. " +
        "Analyze the findings and suggest fixes. " +
        "Be specific about which config keys to change and what values to use. " +
        "Do NOT make changes yourself — just explain what the user should do.",
    });
  } catch (err) {
    console.error(chalk.red(`Agent communication failed: ${err}`));
  }
}

export function analyzeConfig(config: Record<string, unknown>, findings: DiagnosticFinding[]) {
  // Gateway server config (gateway.mode / gateway.auth) is optional and absent in
  // newer schemas — only flag issues when the section is actually present.
  const gateway = config.gateway as Record<string, unknown> | undefined;
  if (gateway) {
    if (!gateway.mode) {
      findings.push({
        severity: "warn",
        area: "config",
        message: "gateway.mode is not set — gateway may not start properly",
      });
    }

    const auth = gateway.auth as Record<string, unknown> | undefined;
    if (auth) {
      const hasToken = Boolean(auth.token);
      const hasPassword = Boolean(auth.password);
      const hasMode = Boolean(auth.mode);
      if (hasToken && hasPassword && !hasMode) {
        findings.push({
          severity: "error",
          area: "config",
          message:
            "Both gateway token AND password are configured but auth mode is not explicit — ambiguous auth",
        });
      }
      if (!hasToken && !hasPassword && auth.mode !== "none") {
        findings.push({
          severity: "warn",
          area: "config",
          message: "No gateway auth credentials configured",
        });
      }
    }
  }

  // Check default agent (only when an agents section exists).
  const agents = config.agents as Record<string, unknown> | undefined;
  if (agents && !agents.default && !agents.defaultId) {
    findings.push({
      severity: "warn",
      area: "config",
      message: "No default agent configured",
    });
  }

  // Check channels config exists
  const channels = config.channels as Record<string, unknown> | undefined;
  if (!channels || Object.keys(channels).length === 0) {
    findings.push({
      severity: "info",
      area: "config",
      message: "No channels configured",
    });
  }
}

export function analyzeHealth(health: Record<string, unknown>, findings: DiagnosticFinding[]) {
  // 经防腐层归一后再判断；规则本身不变：healthy 才 info，否则一律 error。
  // (网关即便不健康也会应答 RPC，所以「调用成功」不等于健康，必须看 health.ok。)
  if (viewHealth(health).healthy) {
    findings.push({ severity: "info", area: "health", message: "Gateway healthy" });
  } else {
    findings.push({
      severity: "error",
      area: "health",
      message: "Gateway reports unhealthy (health.ok is not true)",
    });
  }
}

export function analyzeChannels(channels: Record<string, unknown>, findings: DiagnosticFinding[]) {
  // 字段拆解全部交给防腐层，这里只跑判断规则（与原实现逐条等价）。
  for (const ch of viewChannels(channels)) {
    // 仅当显式声明未运行 (running === false) 才告警；缺失不触发。
    if (ch.running === false) {
      findings.push({ severity: "warn", area: "channels", message: `Channel "${ch.name}" is not running` });
    }

    for (const acc of ch.accounts) {
      // A deliberately disabled account being disconnected is not a fault.
      if (!acc.connected && acc.enabled !== false) {
        const reason = acc.lastError ? `: ${acc.lastError}` : "";
        findings.push({
          severity: "error",
          area: "channels",
          message: `Channel "${ch.name}" account "${acc.accountId}" is not connected${reason}`,
        });
      }
    }
  }
}

function buildDiagnosticSummary(
  findings: DiagnosticFinding[],
  config: Record<string, unknown> | null,
  channels: Record<string, unknown> | null,
): string {
  const lines: string[] = [
    "I ran diagnostics on my OpenClaw gateway. Here are the findings:\n",
  ];

  for (const f of findings) {
    lines.push(`[${f.severity.toUpperCase()}] [${f.area}] ${f.message}`);
  }

  if (config) {
    // Include a sanitized config summary (strip secrets). Reuses the shared
    // redactor so array-valued secrets (e.g. fallbackTokens) are stripped too.
    const sanitized = sanitizeConfigForOutput(config);
    lines.push("\nCurrent config (secrets redacted):");
    lines.push(JSON.stringify(sanitized, null, 2));
  }

  if (channels) {
    lines.push("\nChannel status:");
    lines.push(JSON.stringify(channels, null, 2));
  }

  lines.push(
    "\nPlease analyze these findings and tell me what I should fix. " +
      "Give me specific instructions (config keys, values, commands to run). " +
      "Do NOT make any changes — just tell me what to do.",
  );

  return lines.join("\n");
}
