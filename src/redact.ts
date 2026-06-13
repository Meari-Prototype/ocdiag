/**
 * Heuristic, key-name based secret redaction. Shared by the config command's
 * output formatting AND the client's debug logging, so secrets never leak
 * through either path (config.get payloads carry tokens / API keys).
 *
 * This is defense-in-depth, not a guarantee: secrets under unusual key names or
 * non-scalar values may still slip through.
 */

export function sanitizeConfigForOutput(obj: unknown, keyHint?: string): unknown {
  if (isScalar(obj)) {
    // 两条触发线，命中其一即脱敏：
    //  ① key 名像密钥（且不论值类型，数值/布尔密钥也不漏）；
    //  ② 值本身呈现高置信度密钥特征——兜住 isSecretKey 故意放过的裸 `key` 等字段名。
    if ((keyHint !== undefined && isSecretKey(keyHint)) || looksLikeSecretValue(obj)) {
      return redactScalar(obj);
    }
    return obj;
  }

  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => sanitizeConfigForOutput(item, keyHint));

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    result[key] = sanitizeConfigForOutput(value, key);
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
 * Substring-based, so we deliberately avoid short/ambiguous tokens (key, pin, sk,
 * pat, seed, salt, auth …) that would over-redact innocuous keys.
 */
export function isSecretKey(key: string): boolean {
  // Token-count / context-size config (maxTokens, contextTokens, totalTokensUsed …)
  // contains "token" but is NOT a credential — exclude before the secret match so we
  // don't redact numeric counters.
  if (/(max|min|total|input|output|prompt|completion|context|remaining|cache|num|used|count)[_-]?tokens?/i.test(key)) {
    return false;
  }
  // token 的「元信息」字段（tokenSource / tokenStatus / tokenType …）是枚举/描述，不是凭据本身。
  if (/token[_-]?(source|status|state|type|kind|format|usage|count)/i.test(key)) {
    return false;
  }
  return /token|password|passwd|pwd|passphrase|secret|credential|api[_-]?key|access[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|session[_-]?key|client[_-]?key|authorization|bearer|cookie|connection[_-]?string|dsn|webhook|mnemonic/i.test(
    key,
  );
}

/**
 * 值形态启发式：只匹配高置信度的密钥前缀/格式，作为 key 名脱敏的兜底——
 * 覆盖 isSecretKey 故意放过的裸 `key` 等字段名下的真密钥。阈值取保守，
 * 正常 URL / 描述 / 版本号 / UUID / 数字不会命中。
 */
export function looksLikeSecretValue(v: unknown): boolean {
  if (typeof v !== "string") return false;
  return (
    /^sk-[A-Za-z0-9_-]{16,}/.test(v) || // OpenAI / DeepSeek / Anthropic
    /^(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/.test(v) || // GitHub PAT
    /^xox[baprs]-[A-Za-z0-9-]{10,}/.test(v) || // Slack
    /^AKIA[0-9A-Z]{16}$/.test(v) || // AWS access key id
    /^Bearer\s+[A-Za-z0-9._~+/-]{16,}/.test(v) || // Bearer 头
    /^[0-9]{8,10}:[A-Za-z0-9_-]{35}$/.test(v) || // Telegram bot token
    /^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./.test(v) || // JWT
    /-----BEGIN[A-Z ]*PRIVATE KEY-----/.test(v) // PEM 私钥
  );
}
