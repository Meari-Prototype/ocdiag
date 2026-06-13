import chalk from "chalk";
import type { GatewayClient } from "../client.js";
import { sanitizeConfigForOutput } from "../redact.js";
import { canonicalConfig, getConfigDottedPath, availableTopKeys, viewConfigMeta } from "../openclaw-schema.js";

// 原始字段提取 / 层级选择已迁入防腐层 (openclaw-schema)。此处只负责命令编排与输出格式化。
// 重新导出以保持既有 importer（diagnose、tests）的引用路径不变。
export { sanitizeConfigForOutput, canonicalConfig, getConfigDottedPath };

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
  const meta = formatConfigMeta(payload);
  if (meta) console.log(chalk.dim(`  ${meta}`));
  console.log(
    chalk.dim(`  showing '${layer}' layer — use --json for the full payload, or 'config <key>' for one value`),
  );
  console.log(formatJsonValue(sanitizeConfigForOutput(value)));
}

/** 把防腐层取出的 config 元信息染色成一行摘要。 */
function formatConfigMeta(payload: unknown): string {
  const m = viewConfigMeta(payload);
  const parts: string[] = [];
  if (m.path) parts.push(m.path);
  if (m.valid !== undefined) parts.push(m.valid ? "valid" : chalk.red("invalid"));
  if (m.issues > 0 || m.warnings > 0) parts.push(`${m.issues} issue(s), ${m.warnings} warning(s)`);
  return parts.join(" · ");
}

function formatJsonValue(value: unknown): string {
  const formatted = JSON.stringify(value, null, 2);
  return formatted === undefined ? "undefined" : formatted;
}
