import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { statusCommand } from "./status.js";
import type { GatewayClient } from "../client.js";

/** Mock a client whose channels.status carries a malicious lastError. */
function clientWith(lastError: string): GatewayClient {
  return {
    get serverInfo() {
      return null;
    },
    request: async (method: string) => {
      if (method === "channels.status") {
        return {
          channelOrder: ["tg"],
          channels: { tg: { running: true } },
          channelAccounts: { tg: [{ accountId: "a", connected: false, lastError }] },
        };
      }
      return { ok: true };
    },
  } as unknown as GatewayClient;
}

async function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (v?: unknown) => {
    logs.push(String(v));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return logs.join("\n");
}

describe("statusCommand raw output (control-byte defense)", () => {
  // ESC(0x1b) + 8-bit CSI(0x9b) + DEL(0x7f) hidden in an untrusted error string.
  const evil = "boom\x1b[2K\x9b2K\x7fEND";

  it("--json strips DEL/C1 bytes that JSON.stringify passes through", async () => {
    const out = await captureLog(() => statusCommand(clientWith(evil), { json: true }));
    assert.match(out, /boom/); // real content kept
    assert.match(out, /END/);
    assert.match(out, /\\u001b/); // ESC neutralized by JSON as visible  text
    assert.doesNotMatch(out, /[\x7f-\x9f]/); // no bare DEL / C1 leaks through
  });

  it("--verbose strips DEL/C1 bytes too", async () => {
    const out = await captureLog(() => statusCommand(clientWith(evil), { verbose: true }));
    assert.match(out, /boom/);
    assert.doesNotMatch(out, /[\x7f-\x9f]/);
  });
});
