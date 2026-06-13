import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  viewHealth,
  viewServer,
  viewChannels,
  viewAgents,
  viewConfigMeta,
  stripControl,
} from "./openclaw-schema.js";

describe("viewHealth", () => {
  it("healthy only when health.ok === true (missing / non-bool → unhealthy)", () => {
    assert.equal(viewHealth({ ok: true }).healthy, true);
    assert.equal(viewHealth({ ok: false }).healthy, false);
    assert.equal(viewHealth({ ts: 123 }).healthy, false);
    assert.equal(viewHealth(null).healthy, false);
    assert.equal(viewHealth("nope").healthy, false);
  });

  it("counts plugins, and omits the block entirely when absent", () => {
    const v = viewHealth({ ok: true, plugins: { loaded: [1, 2, 3], errors: [1] } });
    assert.deepEqual(v.plugins, { loaded: 3, errors: 1 });
    assert.equal(viewHealth({ ok: true }).plugins, undefined);
  });

  it("passes through durationMs / runtimeVersion only when the right type", () => {
    assert.equal(viewHealth({ ok: true, durationMs: 1500, runtimeVersion: "2026.4.25" }).durationMs, 1500);
    assert.equal(viewHealth({ ok: true, durationMs: "1500" }).durationMs, undefined);
    assert.equal(viewHealth({ ok: true, runtimeVersion: 42 }).runtimeVersion, undefined);
  });
});

describe("viewServer", () => {
  it("extracts version / protocol / counts", () => {
    const v = viewServer({
      server: { version: "1.2.3" },
      protocol: 3,
      features: { methods: ["a", "b"], events: ["x"] },
    });
    assert.deepEqual(v, { version: "1.2.3", protocol: 3, methodCount: 2, eventCount: 1 });
  });

  it("degrades safely on null / missing features", () => {
    assert.deepEqual(viewServer(null), {
      version: undefined,
      protocol: undefined,
      methodCount: 0,
      eventCount: 0,
    });
  });
});

describe("viewChannels", () => {
  const raw = {
    channelOrder: ["telegram", "slack"],
    channels: { telegram: { running: true, mode: "polling" }, slack: { running: false } },
    channelAccounts: {
      telegram: [
        { accountId: "default", enabled: true, connected: true },
        { accountId: "bot2", enabled: true, connected: false, lastError: "401 Unauthorized" },
      ],
      slack: [],
    },
  };

  it("normalizes running as a tri-state (true / false / undefined)", () => {
    const v = viewChannels(raw);
    assert.equal(v.find((c) => c.name === "telegram")?.running, true);
    assert.equal(v.find((c) => c.name === "slack")?.running, false);
    // running absent → undefined, so neither status (=== true) nor diagnose (=== false) fires.
    const noRun = viewChannels({ channels: { x: {} }, channelAccounts: {} });
    assert.equal(noRun[0].running, undefined);
  });

  it("maps account fields and tolerates missing ones", () => {
    const v = viewChannels(raw);
    const tg = v.find((c) => c.name === "telegram")!;
    assert.deepEqual(tg.accounts[1], {
      accountId: "bot2",
      connected: false,
      enabled: true,
      lastError: "401 Unauthorized",
      username: undefined,
    });
    // an account with nothing usable still yields a safe shape
    const bare = viewChannels({ channels: { c: {} }, channelAccounts: { c: [{}] } });
    assert.deepEqual(bare[0].accounts[0], {
      accountId: "?",
      connected: false,
      enabled: undefined,
      lastError: undefined,
      username: undefined,
    });
  });

  it("falls back to channel keys when channelOrder is missing", () => {
    const v = viewChannels({ channels: { a: { running: true }, b: { running: true } }, channelAccounts: {} });
    assert.deepEqual(v.map((c) => c.name), ["a", "b"]);
  });

  it("returns [] for non-object input", () => {
    assert.deepEqual(viewChannels(null), []);
    assert.deepEqual(viewChannels("x"), []);
  });

  it("resolves bot username from the health payload when provided", () => {
    const health = {
      channels: { telegram: { accounts: { default: { probe: { bot: { username: "MyBot" } } } } } },
    };
    const v = viewChannels(raw, health);
    assert.equal(v.find((c) => c.name === "telegram")?.accounts[0].username, "MyBot");
  });

  it("strips terminal escape sequences from untrusted display fields", () => {
    const evil = {
      channels: { tg: { running: true, mode: "\x1b[31mpolling\x1b[0m" } },
      channelAccounts: { tg: [{ accountId: "a", connected: false, lastError: "\x1b]0;pwn\x07boom\r" }] },
    };
    const v = viewChannels(evil);
    assert.equal(v[0].mode, "polling");
    assert.equal(v[0].accounts[0].lastError, "boom");
  });
});

describe("viewAgents", () => {
  it("extracts agents, default flag, heartbeat, session count and last-active age", () => {
    const { defaultAgentId, agents } = viewAgents({
      defaultAgentId: "main",
      agents: [
        { agentId: "main", heartbeat: { enabled: true }, sessions: { count: 2, recent: [{ age: 5000 }] } },
        { agentId: "baiqiu", isDefault: false, sessions: { count: 0 } },
      ],
    });
    assert.equal(defaultAgentId, "main");
    assert.deepEqual(agents[0], {
      agentId: "main",
      isDefault: true, // matched defaultAgentId
      heartbeatEnabled: true,
      sessionCount: 2,
      lastActiveAge: 5000,
    });
    assert.equal(agents[1].isDefault, false);
    assert.equal(agents[1].sessionCount, 0);
    assert.equal(agents[1].lastActiveAge, undefined);
  });

  it("honors an explicit isDefault === true", () => {
    const { agents } = viewAgents({ agents: [{ agentId: "x", isDefault: true }] });
    assert.equal(agents[0].isDefault, true);
  });

  it("does NOT mark an agent default when both agentId and defaultAgentId are missing", () => {
    const { agents } = viewAgents({ agents: [{ heartbeat: { enabled: false } }] });
    assert.equal(agents[0].agentId, "?");
    assert.equal(agents[0].isDefault, false);
  });

  it("returns no agents for a non-array agents field", () => {
    assert.deepEqual(viewAgents({ agents: "nope" }).agents, []);
    assert.deepEqual(viewAgents(null).agents, []);
  });
});

describe("viewConfigMeta", () => {
  it("reads path / valid / issue+warning counts", () => {
    assert.deepEqual(
      viewConfigMeta({ path: "/x/openclaw.json", valid: false, issues: [1, 2], warnings: [1] }),
      { path: "/x/openclaw.json", valid: false, issues: 2, warnings: 1 },
    );
  });

  it("degrades to zero counts / undefined on missing fields", () => {
    assert.deepEqual(viewConfigMeta({}), { path: undefined, valid: undefined, issues: 0, warnings: 0 });
  });
});

describe("stripControl (terminal injection defense)", () => {
  it("removes ANSI color (CSI) sequences", () => {
    assert.equal(stripControl("\x1b[31mred\x1b[0m"), "red");
    assert.equal(stripControl("\x1b[2K\x1b[1Ghidden"), "hidden");
  });

  it("removes OSC sequences (window title / clipboard write)", () => {
    assert.equal(stripControl("\x1b]0;evil title\x07hi"), "hi");
    assert.equal(stripControl("\x1b]52;c;ZXZpbA==\x07x"), "x"); // OSC 52 clipboard
  });

  it("removes bare control chars (lone ESC, CR, DEL, C1) but keeps \\n and \\t", () => {
    assert.equal(stripControl("a\rb"), "ab");
    assert.equal(stripControl("a\x7fb"), "ab");
    assert.equal(stripControl("a\x9bb"), "ab"); // C1 CSI introducer
    assert.equal(stripControl("a\x1bb"), "ab"); // lone ESC
    assert.equal(stripControl("line1\nline2\tcol"), "line1\nline2\tcol");
  });

  it("leaves normal multilingual text intact", () => {
    assert.equal(stripControl("你好，master ✨ ok"), "你好，master ✨ ok");
  });

  it("neutralizes an escape split across stream chunks (ESC dropped → inert)", () => {
    assert.equal(stripControl("text\x1b"), "text"); // 引导 ESC 被删
    assert.equal(stripControl("[31mmore"), "[31mmore"); // 下一 chunk 无 ESC → 当可见文本，不被解释
  });
});
