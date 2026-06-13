import chalk from "chalk";
import type { GatewayClient } from "../client.js";

export async function statusCommand(client: GatewayClient) {
  const info = client.serverInfo;
  if (info) {
    console.log(chalk.bold("Gateway connected"));
    console.log(`  Version:  ${info.server.version}`);
    console.log(`  ConnId:   ${info.server.connId}`);
    console.log(`  Protocol: ${info.protocol}`);
    console.log(`  Methods:  ${info.features.methods.length}`);
    console.log(`  Events:   ${info.features.events.length}`);
  }

  // Health check
  try {
    const health = await client.request<Record<string, unknown>>("health");
    console.log(chalk.bold("\nHealth"));
    printObject(health, 2);
  } catch (err) {
    console.log(chalk.red(`\nHealth check failed: ${err}`));
  }

  // Overall status
  try {
    const status = await client.request<Record<string, unknown>>("status");
    console.log(chalk.bold("\nStatus"));
    printObject(status, 2);
  } catch (err) {
    console.log(chalk.red(`\nStatus check failed: ${err}`));
  }

  // Channel status
  try {
    const channels = await client.request<unknown>("channels.status");
    console.log(chalk.bold("\nChannels"));
    if (Array.isArray(channels)) {
      for (const ch of channels) {
        const name = ch.channel ?? ch.id ?? "unknown";
        const ok = ch.ok ?? ch.connected ?? ch.status === "ok";
        const icon = ok ? chalk.green("OK") : chalk.red("ERR");
        const detail = ch.error ?? ch.statusLabel ?? "";
        console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ""}`);
      }
    } else {
      printObject(channels as Record<string, unknown>, 2);
    }
  } catch (err) {
    console.log(chalk.yellow(`\nChannels status unavailable: ${err}`));
  }
}

function printObject(obj: unknown, indent: number) {
  const pad = " ".repeat(indent);
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        console.log(`${pad}${k}:`);
        printObject(v, indent + 2);
      } else {
        console.log(`${pad}${k}: ${formatValue(v)}`);
      }
    }
  } else {
    console.log(`${pad}${JSON.stringify(obj)}`);
  }
}

function formatValue(v: unknown): string {
  if (v === true) return chalk.green("true");
  if (v === false) return chalk.red("false");
  if (v === null || v === undefined) return chalk.dim("null");
  return String(v);
}
