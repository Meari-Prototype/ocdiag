import chalk from "chalk";
import type { GatewayClient } from "../client.js";
import type { HelloOk } from "../protocol.js";
import { viewServer, viewHealth, viewChannels, viewAgents, stripControl } from "../openclaw-schema.js";
import { sanitizeConfigForOutput } from "../redact.js";

export type StatusOptions = { json?: boolean; verbose?: boolean };

type Fetched = { ok: true; value: unknown } | { ok: false; error: string };

async function fetch(client: GatewayClient, method: string): Promise<Fetched> {
  try {
    return { ok: true, value: await client.request(method) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function unwrap(f: Fetched): unknown {
  return f.ok ? f.value : { error: f.error };
}

export async function statusCommand(client: GatewayClient, opts: StatusOptions = {}) {
  const info = client.serverInfo;
  const health = await fetch(client, "health");
  const status = await fetch(client, "status");
  const channels = await fetch(client, "channels.status");

  if (opts.json) {
    // raw payload 直出前：先脱敏（凭据不裸出），再 stripControl 整段 JSON 文本。
    // JSON.stringify 已把 C0(含 ESC) 转义成 \uXXXX，stripControl 补掉它放过的
    // DEL(0x7f)/C1(0x80-9f)——其中 0x9b/0x9d 是 8-bit CSI/OSC 引导符。
    const payload = {
      server: info
        ? {
            version: info.server.version,
            connId: info.server.connId,
            protocol: info.protocol,
            methods: info.features.methods.length,
            events: info.features.events.length,
          }
        : null,
      health: sanitizeConfigForOutput(unwrap(health)),
      status: sanitizeConfigForOutput(unwrap(status)),
      channels: sanitizeConfigForOutput(unwrap(channels)),
    };
    console.log(stripControl(JSON.stringify(payload, null, 2)));
    return;
  }

  if (opts.verbose) {
    rawSection("Server", info);
    rawSection("Health", sanitizeConfigForOutput(unwrap(health)));
    rawSection("Status", sanitizeConfigForOutput(unwrap(status)));
    rawSection("Channels", sanitizeConfigForOutput(unwrap(channels)));
    return;
  }

  // Default: concise overview.
  printGateway(info, health);
  printChannels(channels, health);
  printAgents(health);
}

function rawSection(title: string, value: unknown) {
  console.log(chalk.bold(title));
  // JSON.stringify 已转义 C0(含 ESC)；stripControl 再补掉它放过的 DEL/C1 控制字节。
  console.log(stripControl(JSON.stringify(value, null, 2)));
  console.log();
}

function printGateway(info: HelloOk | null, health: Fetched) {
  const server = viewServer(info);
  const hv = health.ok ? viewHealth(health.value) : null;
  const version = server.version ?? hv?.runtimeVersion ?? "unknown";
  const meta = info
    ? chalk.dim(`protocol ${server.protocol ?? "?"} · ${server.methodCount} methods · ${server.eventCount} events`)
    : "";
  console.log(`${chalk.green("●")} ${chalk.bold("Gateway")} ${version}   ${meta}`);

  if (hv) {
    const dur = hv.durationMs !== undefined ? ` (${(hv.durationMs / 1000).toFixed(1)}s)` : "";
    const plugins = hv.plugins
      ? chalk.dim(`   plugins: ${hv.plugins.loaded} loaded, ${hv.plugins.errors} errors`)
      : "";
    console.log(`  health: ${hv.healthy ? chalk.green("ok") : chalk.red("not ok")}${dur}${plugins}`);
  } else {
    console.log(`  health: ${chalk.red("unavailable")} ${chalk.dim(health.ok ? "" : `(${health.error})`)}`);
  }
}

function printChannels(channels: Fetched, health: Fetched) {
  console.log();
  console.log(chalk.bold("Channels"));
  if (!channels.ok) {
    console.log(chalk.yellow(`  unavailable (${channels.error})`));
    return;
  }
  const views = viewChannels(channels.value, health.ok ? health.value : undefined);
  if (views.length === 0) {
    console.log(chalk.dim("  (none configured)"));
    return;
  }

  for (const ch of views) {
    const running = ch.running === true;
    const mode = ch.mode ? chalk.dim(` · ${ch.mode}`) : "";
    const dot = running ? chalk.green("●") : chalk.dim("○");
    console.log(`  ${dot} ${ch.name}   ${running ? chalk.green("running") : chalk.dim("stopped")}${mode}`);

    for (const acc of ch.accounts) {
      const icon = acc.connected ? chalk.green("✔") : chalk.red("✘");
      const handle = acc.username ? chalk.cyan(`@${acc.username}`) : "";
      const state = acc.connected
        ? "connected"
        : acc.lastError
          ? chalk.red(acc.lastError)
          : chalk.dim("disconnected");
      const id = acc.accountId.padEnd(10);
      console.log(`      ${icon} ${id} ${handle}${handle ? "  " : ""}${state}`);
    }
  }
}

function printAgents(health: Fetched) {
  if (!health.ok) return;
  const { defaultAgentId, agents } = viewAgents(health.value);
  if (agents.length === 0) return;

  console.log();
  console.log(chalk.bold("Agents") + (defaultAgentId ? chalk.dim(`  (default: ${defaultAgentId})`) : ""));
  for (const a of agents) {
    const dot = a.isDefault ? chalk.green("●") : chalk.dim("○");
    const hb = a.heartbeatEnabled ? chalk.green("on") : chalk.dim("off");
    const seen = a.lastActiveAge !== undefined ? chalk.dim(` · last active ${relTime(a.lastActiveAge)}`) : "";
    const id = a.agentId.padEnd(12);
    console.log(`  ${dot} ${id} heartbeat: ${hb}   ${a.sessionCount} session${a.sessionCount === 1 ? "" : "s"}${seen}`);
  }
}

/** Human-readable "N{s,m,h,d} ago" from a millisecond age. */
function relTime(ms: number): string {
  if (!(ms >= 0)) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}
