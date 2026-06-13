import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeHealth, analyzeChannels, analyzeConfig, type DiagnosticFinding } from "./diagnose.js";

describe("analyzeHealth (Bug 1: must read health.ok)", () => {
  it("reports healthy only when health.ok === true", () => {
    const f: DiagnosticFinding[] = [];
    analyzeHealth({ ok: true }, f);
    assert.equal(f.length, 1);
    assert.equal(f[0].severity, "info");
    assert.match(f[0].message, /healthy/i);
  });

  it("reports an error when the gateway responds but health.ok is false", () => {
    const f: DiagnosticFinding[] = [];
    analyzeHealth({ ok: false }, f);
    assert.equal(f[0].severity, "error");
  });

  it("reports an error when health.ok is missing (never silently 'healthy')", () => {
    const f: DiagnosticFinding[] = [];
    analyzeHealth({ ts: 123 }, f);
    assert.equal(f[0].severity, "error");
  });
});

describe("analyzeChannels (Bug 2: object shape, not array)", () => {
  // Mirrors the real channels.status payload (see status.ts).
  const payload = {
    channelOrder: ["telegram", "slack"],
    channels: { telegram: { running: true }, slack: { running: false } },
    channelAccounts: {
      telegram: [
        { accountId: "default", enabled: true, connected: true },
        { accountId: "bot2", enabled: true, connected: false, lastError: "401 Unauthorized" },
        { accountId: "old", enabled: false, connected: false }, // disabled → not a fault
      ],
      slack: [],
    },
  };

  it("flags a failed-to-connect account as an error, with its lastError", () => {
    const f: DiagnosticFinding[] = [];
    analyzeChannels(payload, f);
    const errs = f.filter((x) => x.severity === "error");
    assert.equal(errs.length, 1);
    assert.match(errs[0].message, /bot2/);
    assert.match(errs[0].message, /401 Unauthorized/);
  });

  it("does not flag a deliberately disabled account", () => {
    const f: DiagnosticFinding[] = [];
    analyzeChannels(payload, f);
    assert.ok(!f.some((x) => x.message.includes('"old"')));
  });

  it("warns about a configured-but-not-running channel", () => {
    const f: DiagnosticFinding[] = [];
    analyzeChannels(payload, f);
    const warns = f.filter((x) => x.severity === "warn");
    assert.equal(warns.length, 1);
    assert.match(warns[0].message, /slack/);
  });

  it("yields no error for an all-healthy payload", () => {
    const f: DiagnosticFinding[] = [];
    analyzeChannels(
      {
        channelOrder: ["telegram"],
        channels: { telegram: { running: true } },
        channelAccounts: { telegram: [{ accountId: "default", enabled: true, connected: true }] },
      },
      f,
    );
    assert.equal(f.filter((x) => x.severity === "error").length, 0);
  });
});

describe("analyzeConfig (regression: still works)", () => {
  it("flags ambiguous auth (token + password, no explicit mode)", () => {
    const f: DiagnosticFinding[] = [];
    analyzeConfig({ gateway: { auth: { token: "x", password: "y" } } }, f);
    assert.ok(f.some((x) => x.severity === "error" && /ambiguous/i.test(x.message)));
  });
});
