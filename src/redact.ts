/**
 * Heuristic, key-name based secret redaction. Shared by the config command's
 * output formatting AND the client's debug logging, so secrets never leak
 * through either path (config.get payloads carry tokens / API keys).
 *
 * This is defense-in-depth, not a guarantee: secrets under unusual key names or
 * non-scalar values may still slip through.
 */

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
  return /token|password|passwd|pwd|passphrase|secret|credential|api[_-]?key|access[_-]?key|private[_-]?key|signing[_-]?key|encryption[_-]?key|session[_-]?key|client[_-]?key|authorization|bearer|cookie|connection[_-]?string|dsn|webhook|mnemonic/i.test(
    key,
  );
}
