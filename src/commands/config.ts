import chalk from "chalk";
import type { GatewayClient } from "../client.js";

export async function configGetCommand(client: GatewayClient, key?: string) {
  try {
    const config = await client.request<unknown>("config.get");
    const result = key ? getConfigDottedPath(config, key) : config;
    const keyHint = key?.split(".").filter(Boolean).at(-1);
    const sanitized = sanitizeConfigForOutput(result, keyHint);
    if (key) {
      console.log(chalk.bold(`config.${key}:`));
    } else {
      console.log(chalk.bold("Full configuration (read-only, secrets redacted):"));
    }
    console.log(formatJsonValue(sanitized));
  } catch (err) {
    console.error(chalk.red(`Failed to get config: ${err}`));
    process.exitCode = 1;
  }
}

function getConfigDottedPath(configPayload: unknown, key: string): unknown {
  const direct = getDottedPath(configPayload, key);
  if (direct !== undefined) return direct;

  if (!configPayload || typeof configPayload !== "object") return undefined;
  const payload = configPayload as Record<string, unknown>;
  for (const root of ["config", "parsed", "runtimeConfig", "resolved", "sourceConfig"]) {
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

export function sanitizeConfigForOutput(obj: unknown, keyHint?: string): unknown {
  if (keyHint && isSecretKey(keyHint) && typeof obj === "string") {
    return obj.length > 0 ? "[REDACTED]" : "";
  }

  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => sanitizeConfigForOutput(item, keyHint));

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (isSecretKey(key) && typeof value === "string") {
      result[key] = value.length > 0 ? "[REDACTED]" : "";
    } else {
      result[key] = sanitizeConfigForOutput(value, key);
    }
  }
  return result;
}

function isSecretKey(key: string): boolean {
  return /token|password|secret|credential|api[_-]?key|access[_-]?key|private[_-]?key/i.test(key);
}
