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
  // A secret-named key whose value is a scalar is redacted outright — regardless of
  // type — so numeric/boolean secrets don't slip through a string-only check.
  if (keyHint && isSecretKey(keyHint) && isScalar(obj)) {
    return redactScalar(obj);
  }

  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => sanitizeConfigForOutput(item, keyHint));

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (isSecretKey(key) && isScalar(value)) {
      result[key] = redactScalar(value);
    } else {
      result[key] = sanitizeConfigForOutput(value, key);
    }
  }
  return result;
}

function isScalar(v: unknown): boolean {
  return (
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean" ||
    typeof v === "bigint"
  );
}

function redactScalar(v: unknown): unknown {
  // Keep genuinely-empty strings empty so "unset" stays visible; redact anything real.
  if (typeof v === "string") return v.length > 0 ? "[REDACTED]" : "";
  return "[REDACTED]";
}

/**
 * Heuristic, key-name based secret matcher (defense-in-depth, not a guarantee).
 * Substring-based, so we deliberately avoid short/ambiguous tokens (key, pin, sk,
 * pat, seed, salt, auth …) that would over-redact innocuous keys.
 */
function isSecretKey(key: string): boolean {
  return /token|password|passwd|pwd|passphrase|secret|credential|api[_-]?key|access[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|session[_-]?key|client[_-]?key|authorization|bearer|cookie|connection[_-]?string|dsn|webhook|mnemonic/i.test(
    key,
  );
}
