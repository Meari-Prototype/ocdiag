/** OpenClaw gateway WebSocket protocol types (read-only subset). */

export type RequestFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

export type ResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
};

export type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

export type ErrorShape = {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
  retryAfterMs?: number;
};

export type GatewayFrame = RequestFrame | ResponseFrame | EventFrame;

export type ConnectParams = {
  minProtocol: number;
  maxProtocol: number;
  client: {
    id: string;
    displayName?: string;
    version: string;
    platform: string;
    mode: string;
  };
  caps?: string[];
  role?: string;
  scopes?: string[];
  auth?: {
    token?: string;
    deviceToken?: string;
  };
  device?: {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce: string;
  };
};

export type HelloOk = {
  type: "hello-ok";
  protocol: number;
  server: { version: string; connId: string };
  features: { methods: string[]; events: string[] };
  snapshot: unknown;
  pluginSurfaceUrls?: Record<string, string>;
  auth: {
    deviceToken?: string;
    role: string;
    scopes: string[];
    issuedAtMs?: number;
    deviceTokens?: Array<{
      deviceToken: string;
      role: string;
      scopes: string[];
      issuedAtMs: number;
    }>;
  };
  policy: {
    maxPayload: number;
    maxBufferedBytes: number;
    tickIntervalMs: number;
  };
};

export type AgentEventPayload = {
  runId: string;
  seq: number;
  stream: string; // "lifecycle" | "tool" | "assistant" | "error"
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string;
};

export const MIN_CLIENT_PROTOCOL_VERSION = 4;
export const PROTOCOL_VERSION = 4;
