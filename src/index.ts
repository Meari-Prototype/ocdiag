#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import { GatewayClient } from "./client.js";
import { resolveGatewayToken, resolveGatewayUrl } from "./auth.js";
import { loadDeviceIdentity, loadDeviceToken, loadPairedPlatform } from "./device-identity.js";
import { statusCommand } from "./commands/status.js";
import { configGetCommand } from "./commands/config.js";
import { chatRepl, sendToAgent, dispatchAgentEvent } from "./commands/chat.js";
import { diagnoseCommand } from "./commands/diagnose.js";
import type { EventFrame } from "./protocol.js";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("ocdiag")
  .description("Diagnostics CLI for OpenClaw gateway")
  .version(VERSION)
  .option("--url <url>", "Gateway WebSocket URL", resolveGatewayUrl())
  .option("--token <token>", "Gateway auth token (or set OPENCLAW_GATEWAY_TOKEN)");

/** Create and connect a GatewayClient from global options. */
async function createClient(opts: { url?: string; token?: string }): Promise<GatewayClient> {
  const url = opts.url ?? resolveGatewayUrl();
  const token = opts.token ?? resolveGatewayToken();

  const deviceIdentity = loadDeviceIdentity();
  const deviceToken = loadDeviceToken();
  const pairedPlatform = deviceIdentity ? loadPairedPlatform(deviceIdentity.deviceId) : null;
  if (!deviceIdentity) {
    console.error(chalk.yellow("Warning: No device identity found at ~/.openclaw/identity/device.json"));
    console.error(chalk.yellow("Run 'openclaw' first to create one."));
  }

  const client = new GatewayClient({
    url,
    token,
    deviceToken: deviceToken ?? undefined,
    deviceIdentity,
    pairedPlatform: pairedPlatform ?? undefined,
    onEvent: (frame: EventFrame) => {
      dispatchAgentEvent(frame);
    },
  });

  try {
    await client.connect();
  } catch (err) {
    console.error(chalk.red(`Failed to connect to gateway at ${url}`));
    console.error(chalk.red(String(err)));
    process.exit(1);
  }

  return client;
}

// --- Commands ---

program
  .command("status")
  .description("Show gateway health, status, and channel connectivity")
  .action(async () => {
    const client = await createClient(program.opts());
    try {
      await statusCommand(client);
    } finally {
      client.close();
    }
  });

program
  .command("config [key]")
  .description("Read gateway configuration (read-only)")
  .action(async (key?: string) => {
    const client = await createClient(program.opts());
    try {
      await configGetCommand(client, key);
    } finally {
      client.close();
    }
  });

program
  .command("diagnose")
  .description("Collect diagnostics and ask the agent for configuration advice")
  .action(async () => {
    const client = await createClient(program.opts());
    try {
      await diagnoseCommand(client);
    } finally {
      client.close();
    }
  });

program
  .command("chat [message]")
  .description("Chat with the agent (one-shot or interactive REPL)")
  .action(async (message?: string) => {
    const client = await createClient(program.opts());
    try {
      if (message) {
        process.stdout.write(chalk.green("agent> "));
        await sendToAgent(client, message);
        console.log();
      } else {
        await chatRepl(client);
      }
    } finally {
      client.close();
    }
  });

program.parse();
