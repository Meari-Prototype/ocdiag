import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import WebSocket from "ws";
import type {
  ConnectParams,
  EventFrame,
  GatewayFrame,
  HelloOk,
} from "./protocol.js";
import { MIN_CLIENT_PROTOCOL_VERSION, PROTOCOL_VERSION } from "./protocol.js";
import {
  type DeviceIdentity,
  buildDeviceAuthPayloadV3,
  publicKeyRawBase64Url,
  signPayload,
} from "./device-identity.js";
import { VERSION } from "./version.js";
import { sanitizeConfigForOutput } from "./redact.js";

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
};

export type GatewayClientOptions = {
  url: string;
  /** Shared gateway token (if gateway uses token auth). */
  token?: string;
  /** Device-specific auth token (from pairing). */
  deviceToken?: string;
  /** Device identity for authentication. Required unless gateway has auth=none + localhost. */
  deviceIdentity?: DeviceIdentity | null;
  /** Called for every event frame. */
  onEvent?: (frame: EventFrame) => void;
  /** Override platform string to match paired device metadata. */
  pairedPlatform?: string;
  /** Timeout for the initial handshake in ms. Default: 10_000. */
  handshakeTimeoutMs?: number;
  /** Timeout for each individual RPC request in ms. Default: 30_000. */
  requestTimeoutMs?: number;
};

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private onEvent: ((frame: EventFrame) => void) | undefined;
  private helloOk: HelloOk | null = null;
  private url: string;
  private token: string | undefined;
  private deviceToken: string | undefined;
  private deviceIdentity: DeviceIdentity | null;
  private pairedPlatform: string | undefined;
  private handshakeTimeoutMs: number;
  private requestTimeoutMs: number;

  constructor(opts: GatewayClientOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.deviceToken = opts.deviceToken;
    this.deviceIdentity = opts.deviceIdentity ?? null;
    this.pairedPlatform = opts.pairedPlatform;
    this.onEvent = opts.onEvent;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 10_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  /** Connect and complete the handshake. Resolves with HelloOk. */
  async connect(): Promise<HelloOk> {
    return new Promise<HelloOk>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error(`Handshake timed out after ${this.handshakeTimeoutMs}ms`));
      }, this.handshakeTimeoutMs);

      let handshakeDone = false;

      ws.on("error", (err) => {
        if (!handshakeDone) {
          clearTimeout(timeout);
          reject(err);
        }
      });

      ws.on("close", () => {
        if (!handshakeDone) {
          clearTimeout(timeout);
          reject(new Error("Connection closed before handshake completed"));
        }
        // Reject all pending requests.
        for (const [id, req] of this.pending) {
          if (req.timer) clearTimeout(req.timer);
          req.reject(new Error("Connection closed"));
          this.pending.delete(id);
        }
      });

      ws.on("message", (data) => {
        let frame: GatewayFrame;
        try {
          frame = JSON.parse(data.toString());
        } catch {
          return;
        }

        // Phase 1: wait for connect.challenge, send connect request.
        if (
          !handshakeDone &&
          frame.type === "event" &&
          frame.event === "connect.challenge"
        ) {
          const challengePayload = frame.payload as { nonce: string } | undefined;
          const nonce = challengePayload?.nonce ?? "";
          const clientId = "cli";
          const clientMode = "cli";
          const role = "operator";
          const scopes = ["operator.admin"];
          const signedAtMs = Date.now();
          // Use the platform from the paired device entry to avoid
          // metadata-upgrade re-pairing. The identity is the same device
          // accessed from outside Docker.
          const plat = this.pairedPlatform ?? platform();

          // The server resolves the signature token as:
          // auth.token ?? auth.deviceToken ?? auth.bootstrapToken ?? null
          // So we sign with whichever token we're sending.
          const signatureToken = this.token ?? this.deviceToken ?? null;

          // Build device identity block if available.
          const device = this.deviceIdentity
            ? (() => {
                const payload = buildDeviceAuthPayloadV3({
                  deviceId: this.deviceIdentity.deviceId,
                  clientId,
                  clientMode,
                  role,
                  scopes,
                  signedAtMs,
                  token: signatureToken,
                  nonce,
                  platform: plat,
                });
                const signature = signPayload(this.deviceIdentity.privateKeyPem, payload);
                return {
                  id: this.deviceIdentity.deviceId,
                  publicKey: publicKeyRawBase64Url(this.deviceIdentity.publicKeyPem),
                  signature,
                  signedAt: signedAtMs,
                  nonce,
                };
              })()
            : undefined;

          // Build auth block — include token and/or deviceToken.
          const auth: Record<string, string> = {};
          if (this.token) auth.token = this.token;
          if (this.deviceToken) auth.deviceToken = this.deviceToken;
          const hasAuth = Object.keys(auth).length > 0;

          const connectParams: ConnectParams = {
            minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client: {
              id: clientId,
              displayName: "ocdiag",
              version: VERSION,
              platform: plat,
              mode: clientMode,
            },
            caps: ["tool-events"],
            role,
            scopes,
            ...(hasAuth ? { auth } : {}),
            ...(device ? { device } : {}),
          };
          this.send({ type: "req", id: "__connect__", method: "connect", params: connectParams });
          return;
        }

        // Phase 2: wait for hello-ok response.
        if (
          !handshakeDone &&
          frame.type === "res" &&
          frame.id === "__connect__"
        ) {
          clearTimeout(timeout);
          handshakeDone = true;
          if (frame.ok) {
            this.helloOk = frame.payload as HelloOk;
            resolve(this.helloOk);
          } else {
            const msg = frame.error?.message ?? "Handshake rejected";
            reject(new Error(msg));
          }
          return;
        }

        // Normal operation: dispatch responses and events.
        if (frame.type === "res") {
          if (process.env.OCDIAG_DEBUG === "1") {
            // Redact before logging — config.get responses carry tokens / API keys,
            // and the command-layer redaction doesn't cover raw debug output.
            const safe = JSON.stringify(sanitizeConfigForOutput(frame.payload)).slice(0, 200);
            console.error(`[debug] res id=${frame.id} ok=${frame.ok} payload=${safe}`);
          }
          const req = this.pending.get(frame.id);
          if (req) {
            this.pending.delete(frame.id);
            if (req.timer) clearTimeout(req.timer);
            if (frame.ok) {
              req.resolve(frame.payload);
            } else {
              req.reject(new Error(frame.error?.message ?? "Request failed"));
            }
          }
          return;
        }

        if (frame.type === "event") {
          this.onEvent?.(frame);
        }
      });
    });
  }

  /** Send an RPC request and wait for the response (or time out). */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request '${method}' timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        this.send({ type: "req", id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  /** Close the connection. */
  close() {
    this.ws?.close();
    this.ws = null;
  }

  get serverInfo() {
    return this.helloOk;
  }

  private send(obj: unknown) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected");
    }
    this.ws.send(JSON.stringify(obj));
  }
}
