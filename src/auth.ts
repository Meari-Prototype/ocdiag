import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Resolve gateway token: env var first, then ~/.openclaw/openclaw.json.
 * Returns undefined if no token is configured (auth may be "none").
 */
export function resolveGatewayToken(): string | undefined {
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (envToken) {
    return envToken;
  }

  try {
    const configPath = join(homedir(), ".openclaw", "openclaw.json");
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    const token = config?.gateway?.auth?.token;
    if (typeof token === "string" && token.length > 0) {
      return token;
    }
  } catch {
    // Config not found or unreadable — that's fine.
  }

  return undefined;
}

export function resolveGatewayUrl(): string {
  const host = process.env.OPENCLAW_GATEWAY_HOST ?? "127.0.0.1";
  const port = process.env.OPENCLAW_GATEWAY_PORT ?? "18789";
  return `ws://${host}:${port}`;
}
