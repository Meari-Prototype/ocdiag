import chalk from "chalk";
import type { GatewayClient } from "../client.js";
import type { HelloOk } from "../protocol.js";

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
    console.log(
      JSON.stringify(
        {
          server: info
            ? {
                version: info.server.version,
                connId: info.server.connId,
                protocol: info.protocol,
                methods: info.features.methods.length,
                events: info.features.events.length,
              }
            : null,
          health: unwrap(health),
          status: unwrap(status),
          channels: unwrap(channels),
        },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.verbose) {
    rawSection("Server", info);
    rawSection("Health", unwrap(health));
    rawSection("Status", unwrap(status));
    rawSection("Channels", unwrap(channels));
    return;
  }

  // Default: concise overview.
  printGateway(info, health);
  printChannels(channels, health);
  printAgents(health);
}

function rawSection(title: string, value: unknown) {
  console.log(chalk.bold(title));
  // JSON.stringify formats arrays/nesting correctly (unlike the old per-line printer).
  console.log(JSON.stringify(value, null, 2));
  console.log();
}

function arrLen(x: unknown): number {
  return Array.isArray(x) ? x.length : 0;
}

function printGateway(info: HelloOk | null, health: Fetched) {
  const h = (health.ok ? health.value : null) as Record<string, any> | null;
  const version = info?.server?.version ?? h?.runtimeVersion ?? "unknown";
  const meta = info
    ? chalk.dim(
        `protocol ${info.protocol} · ${info.features.methods.length} methods · ${info.features.events.length} events`,
      )
    : "";
  console.log(`${chalk.green("●")} ${chalk.bold("Gateway")} ${version}   ${meta}`);

  if (h) {
    const ok = h.ok === true;
    const dur = typeof h.durationMs === "number" ? ` (${(h.durationMs / 1000).toFixed(1)}s)` : "";
    const plugins = h.plugins
      ? chalk.dim(`   plugins: ${arrLen(h.plugins.loaded)} loaded, ${arrLen(h.plugins.errors)} errors`)
      : "";
    console.log(`  health: ${ok ? chalk.green("ok") : chalk.red("not ok")}${dur}${plugins}`);
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
  const ch = channels.value as Record<string, any>;
  const meta = ch?.channels ?? {};
  const accountsByChannel = ch?.channelAccounts ?? {};
  const order: string[] = Array.isArray(ch?.channelOrder) ? ch.channelOrder : Object.keys(meta);
  if (order.length === 0) {
    console.log(chalk.dim("  (none configured)"));
    return;
  }
  const h = (health.ok ? health.value : null) as Record<string, any> | null;

  for (const name of order) {
    const cm = (meta[name] ?? {}) as Record<string, any>;
    const running = cm.running === true;
    const mode = cm.mode ? chalk.dim(` · ${cm.mode}`) : "";
    const dot = running ? chalk.green("●") : chalk.dim("○");
    console.log(`  ${dot} ${name}   ${running ? chalk.green("running") : chalk.dim("stopped")}${mode}`);

    const accounts: any[] = Array.isArray(accountsByChannel[name]) ? accountsByChannel[name] : [];
    for (const acc of accounts) {
      const connected = acc?.connected === true;
      const icon = connected ? chalk.green("✔") : chalk.red("✘");
      const username = h?.channels?.[name]?.accounts?.[acc?.accountId]?.probe?.bot?.username;
      const handle = username ? chalk.cyan(`@${username}`) : "";
      const state = connected
        ? "connected"
        : acc?.lastError
          ? chalk.red(String(acc.lastError))
          : chalk.dim("disconnected");
      const id = String(acc?.accountId ?? "?").padEnd(10);
      console.log(`      ${icon} ${id} ${handle}${handle ? "  " : ""}${state}`);
    }
  }
}

function printAgents(health: Fetched) {
  if (!health.ok) return;
  const h = health.value as Record<string, any>;
  const agents = h?.agents;
  if (!Array.isArray(agents) || agents.length === 0) return;

  console.log();
  const def = h?.defaultAgentId;
  console.log(chalk.bold("Agents") + (def ? chalk.dim(`  (default: ${def})`) : ""));
  for (const a of agents) {
    const isDefault = a?.isDefault === true || a?.agentId === def;
    const dot = isDefault ? chalk.green("●") : chalk.dim("○");
    const hb = a?.heartbeat?.enabled ? chalk.green("on") : chalk.dim("off");
    const count = a?.sessions?.count ?? 0;
    const age = a?.sessions?.recent?.[0]?.age;
    const seen = typeof age === "number" ? chalk.dim(` · last active ${relTime(age)}`) : "";
    const id = String(a?.agentId ?? "?").padEnd(12);
    console.log(`  ${dot} ${id} heartbeat: ${hb}   ${count} session${count === 1 ? "" : "s"}${seen}`);
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
