import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: "spki", format: "der" }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

export function publicKeyRawBase64Url(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

export function signPayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, "utf8"), key);
  return base64UrlEncode(sig);
}

function normalizeMetadata(value?: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

export function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
  platform?: string | null;
  deviceFamily?: string | null;
}): string {
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    params.scopes.join(","),
    String(params.signedAtMs),
    params.token ?? "",
    params.nonce,
    normalizeMetadata(params.platform),
    normalizeMetadata(params.deviceFamily),
  ].join("|");
}

/**
 * Load the existing device identity from ~/.openclaw/identity/device.json.
 * Returns null if the file doesn't exist or is invalid.
 * Never creates a new identity — that's openclaw's job.
 */
export function loadDeviceIdentity(): DeviceIdentity | null {
  const filePath = path.join(homedir(), ".openclaw", "identity", "device.json");
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed?.version === 1 &&
      typeof parsed.deviceId === "string" &&
      typeof parsed.publicKeyPem === "string" &&
      typeof parsed.privateKeyPem === "string"
    ) {
      return {
        deviceId: parsed.deviceId,
        publicKeyPem: parsed.publicKeyPem,
        privateKeyPem: parsed.privateKeyPem,
      };
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Load the platform from the paired device entry in ~/.openclaw/devices/paired.json.
 * Needed to avoid metadata-upgrade re-pairing when connecting from host to Docker gateway.
 */
export function loadPairedPlatform(deviceId: string): string | null {
  const filePath = path.join(homedir(), ".openclaw", "devices", "paired.json");
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const entry = parsed?.[deviceId];
    if (entry && typeof entry.platform === "string") {
      return entry.platform;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Load the stored device auth token from ~/.openclaw/identity/device-auth.json.
 * This token is issued during device pairing and used for subsequent auth.
 */
export function loadDeviceToken(role = "operator"): string | null {
  const filePath = path.join(homedir(), ".openclaw", "identity", "device-auth.json");
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const entry = parsed?.tokens?.[role];
    if (entry && typeof entry.token === "string" && entry.token.length > 0) {
      return entry.token;
    }
  } catch {
    // ignore
  }
  return null;
}
