import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { configGetCommand, sanitizeConfigForOutput } from "./config.js";
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
});
