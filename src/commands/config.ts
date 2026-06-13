import chalk from "chalk";
import type { GatewayClient } from "../client.js";
import { sanitizeConfigForOutput } from "../redact.js";

// Re-exported so existing importers (diagnose, tests) keep their import path.
export { sanitizeConfigForOutput };

/**
 * Config layers returned by config.get, in priority order — used by BOTH the
 * whole-config view (canonicalConfig) and single-key lookup (getConfigDottedPath)
 * so the two never disagree on which layer a value comes from. Prefer `parsed`
 * (the user's actual openclaw.json) over the resolved/runtime copies.
 */
const CONFIG_LAYER_ORDER = ["parsed", "resolved", "config", "runtimeConfig", "sourceConfig"];

export type ConfigOptions = { json?: boolean };

export async function configGetCommand(client: GatewayClient, key?: string, opts: ConfigOptions = {}) {
  let payload: unknown;
  try {
    payload = await client.request<unknown>("config.get");
  } catch (err) {
    console.error(chalk.red(`Failed to get config: ${err}`));
    process.exitCode = 1;
    return;
  }

  // Single dotted key.
  if (key) {
    const value = getConfigDottedPath(payload, key);
    if (value === undefined) {
      console.error(chalk.red(`No config value at '${key}'.`));
      const keys = availableTopKeys(payload);
      if (keys.length > 0) {
        console.error(chalk.dim(`Available top-level keys: ${keys.join(", ")}`));
      }
      process.exitCode = 1;
      return;
    }
    const keyHint = key.split(".").filter(Boolean).at(-1);
    const sanitized = sanitizeConfigForOutput(value, keyHint);
    if (opts.json) {
      console.log(formatJsonValue(sanitized));
      return;
    }
    console.log(chalk.bold(`config.${key}:`));
    console.log(formatJsonValue(sanitized));
    return;
  }

  // Whole config. --json prints the full raw payload (redacted); the default prints
  // a single canonical layer, since config.get returns ~5 near-identical copies.
  if (opts.json) {
    console.log(formatJsonValue(sanitizeConfigForOutput(payload)));
    return;
  }
  const { layer, value } = canonicalConfig(payload);
  console.log(chalk.bold("Gateway configuration") + chalk.dim(" (read-only, secrets redacted)"));
  const meta = configMeta(payload);
  if (meta) console.log(chalk.dim(`  ${meta}`));
  console.log(
    chalk.dim(`  showing '${layer}' layer — use --json for the full payload, or 'config <key>' for one value`),
  );
  console.log(formatJsonValue(sanitizeConfigForOutput(value)));
}

/**
 * config.get wraps the real config in several near-identical layers
 * (parsed / sourceConfig / resolved / runtimeConfig / config). Pick one to show
 * by default — see CONFIG_LAYER_ORDER.
 */
export function canonicalConfig(payload: unknown): { layer: string; value: unknown } {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>;
    for (const layer of CONFIG_LAYER_ORDER) {
      const v = p[layer];
      if (v && typeof v === "object") return { layer, value: v };
    }
  }
  return { layer: "raw", value: payload };
}

function availableTopKeys(payload: unknown): string[] {
  const { value } = canonicalConfig(payload);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

function configMeta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof p.path === "string") parts.push(p.path);
  if (typeof p.valid === "boolean") parts.push(p.valid ? "valid" : chalk.red("invalid"));
  const issues = Array.isArray(p.issues) ? p.issues.length : 0;
  const warnings = Array.isArray(p.warnings) ? p.warnings.length : 0;
  if (issues > 0 || warnings > 0) parts.push(`${issues} issue(s), ${warnings} warning(s)`);
  return parts.join(" · ");
}

export function getConfigDottedPath(configPayload: unknown, key: string): unknown {
  const direct = getDottedPath(configPayload, key);
  if (direct !== undefined) return direct;

  if (!configPayload || typeof configPayload !== "object") return undefined;
  const payload = configPayload as Record<string, unknown>;
  for (const root of CONFIG_LAYER_ORDER) {
    const value = getDottedPath(payload[root], key);
    if (value !== undefined) return value;
  }

  return undefined;
}

function getDottedPath(obj: unknown, key: string): unknown {
  let current = obj;
  for (const part of key.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function formatJsonValue(value: unknown): string {
  const formatted = JSON.stringify(value, null, 2);
  return formatted === undefined ? "undefined" : formatted;
}
