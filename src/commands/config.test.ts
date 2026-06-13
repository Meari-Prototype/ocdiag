import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configGetCommand, sanitizeConfigForOutput, getConfigDottedPath, canonicalConfig } from "./config.js";
import type { GatewayClient } from "../client.js";

describe("sanitizeConfigForOutput", () => {
  it("redacts secrets in nested OpenClaw config output", () => {
    const sanitized = sanitizeConfigForOutput({
      gateway: {
        auth: {
          token: "gateway-token",
          password: "gateway-password",
        },
      },
      models: {
        providers: {
          deepseek: {
            apiKey: "deepseek-key",
          },
        },
      },
      channels: {
        telegram: {
          accounts: {
            default: {
              botToken: "telegram-token",
              fallbackTokens: ["old-token"],
              timeoutSeconds: 90,
            },
          },
        },
      },
    });

    assert.deepEqual(sanitized, {
      gateway: {
        auth: {
          token: "[REDACTED]",
          password: "[REDACTED]",
        },
      },
      models: {
        providers: {
          deepseek: {
            apiKey: "[REDACTED]",
          },
        },
      },
      channels: {
        telegram: {
          accounts: {
            default: {
              botToken: "[REDACTED]",
              fallbackTokens: ["[REDACTED]"],
              timeoutSeconds: 90,
            },
          },
        },
      },
    });
  });

  it("redacts a direct secret value requested by key path", () => {
    assert.equal(sanitizeConfigForOutput("gateway-token", "token"), "[REDACTED]");
  });

  it("resolves dotted config keys locally because config.get accepts no key param", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = {
      request: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        return {
          config: {
            gateway: {
              auth: {
                token: "gateway-token",
                password: "gateway-password",
              },
            },
          },
        };
      },
    } as unknown as GatewayClient;

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => {
      logs.push(String(value));
    };

    try {
      await configGetCommand(client, "gateway.auth");
    } finally {
      console.log = originalLog;
    }

    assert.deepEqual(calls, [{ method: "config.get", params: undefined }]);
    const output = logs.join("\n");
    assert.match(output, /config\.gateway\.auth:/);
    assert.match(output, /\[REDACTED\]/);
    assert.doesNotMatch(output, /gateway-token|gateway-password/);
  });

  it("redacts non-string secrets and additional secret key names", () => {
    const sanitized = sanitizeConfigForOutput({
      gateway: { auth: { token: 12345678 } }, // numeric secret must not slip through
      sentry: { dsn: "https://abc@sentry.io/1" },
      session: { sessionKey: "sk_live_xyz" },
      http: { authorization: "Bearer xyz", cookie: "sid=abc" },
      misc: { timeoutSeconds: 90, mode: "default" }, // non-secret values untouched
    });

    assert.deepEqual(sanitized, {
      gateway: { auth: { token: "[REDACTED]" } },
      sentry: { dsn: "[REDACTED]" },
      session: { sessionKey: "[REDACTED]" },
      http: { authorization: "[REDACTED]", cookie: "[REDACTED]" },
      misc: { timeoutSeconds: 90, mode: "default" },
    });
  });

  it("does not over-redact token-count config (maxTokens / contextTokens / totalTokens)", () => {
    const sanitized = sanitizeConfigForOutput({
      models: {
        providers: {
          x: { apiKey: "real-key", maxTokens: 200000, maxTokensField: "max_tokens", contextTokens: 1000000 },
        },
      },
      usage: { totalTokens: 4096, inputTokens: 100, outputTokens: 50 },
      // a real credential whose plural key must still be redacted:
      telegram: { fallbackTokens: ["bot-token"] },
    });

    assert.deepEqual(sanitized, {
      models: {
        providers: {
          x: { apiKey: "[REDACTED]", maxTokens: 200000, maxTokensField: "max_tokens", contextTokens: 1000000 },
        },
      },
      usage: { totalTokens: 4096, inputTokens: 100, outputTokens: 50 },
      telegram: { fallbackTokens: ["[REDACTED]"] },
    });
  });

  it("redacts secret-shaped values even under non-secret key names (bare `key`)", () => {
    const sanitized = sanitizeConfigForOutput({
      openai: { key: "sk-abcdefghij0123456789ABCDEF" }, // 裸 key，名字不在 isSecretKey
      gh: { value: "ghp_ABCDEFGHIJ0123456789abcdefghij012345" },
      tg: { note: "123456789:AAAAAAAAAABBBBBBBBBBCCCCCCCCCCDDDDD" },
      jwt: { x: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.sig123abc" },
      pem: { blob: "-----BEGIN PRIVATE KEY-----\nMIIEvg...\n-----END PRIVATE KEY-----" },
    });

    assert.deepEqual(sanitized, {
      openai: { key: "[REDACTED]" },
      gh: { value: "[REDACTED]" },
      tg: { note: "[REDACTED]" },
      jwt: { x: "[REDACTED]" },
      pem: { blob: "[REDACTED]" },
    });
  });

  it("does not redact ordinary values, nor token-metadata keys (tokenSource / tokenType)", () => {
    const input = {
      baseUrl: "https://api.deepseek.com",
      version: "2026.4.25",
      connId: "22970917-41a5-47da-a062-58e9a11bc6c6",
      mode: "default",
      note: "this is a short note",
      count: 8192,
      tokenSource: "none", // token 元信息，应保留可读
      tokenType: "bearer",
    };
    assert.deepEqual(sanitizeConfigForOutput(input), input);
  });
});

describe("config layer ordering (Bug 4: whole-config and single-key must agree)", () => {
  it("getConfigDottedPath reads the same layer canonicalConfig shows (parsed wins)", () => {
    // Same key present in both `parsed` and `config` layers, different values.
    const payload = {
      parsed: { gateway: { mode: "from-parsed" } },
      config: { gateway: { mode: "from-config" } },
    };
    assert.equal(canonicalConfig(payload).layer, "parsed");
    // Single-key lookup must NOT disagree by reading the `config` layer first.
    assert.equal(getConfigDottedPath(payload, "gateway.mode"), "from-parsed");
  });
});
