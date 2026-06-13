[中文](README.md) | **English**

# ocdiag

A read-only diagnostics CLI for the OpenClaw gateway.
Check gateway health, inspect (redacted) configuration, run local diagnostics,
and chat with the gateway's agents — all over the gateway's WebSocket protocol.

`ocdiag` **never writes** gateway configuration. It only calls read-only methods
(`health`, `status`, `config.get`, `channels.status`, …) and talks to agents
through a dedicated diagnostic session.

## Features

- **`status`** — concise overview: gateway version/health, per-channel connectivity, and agents (`--verbose` for full raw payloads, `--json` for machine-readable JSON).
- **`config`** — read the gateway configuration (secrets redacted; one canonical layer by default, `--json` for the full raw payload), optionally a single dotted key.
- **`diagnose`** — collect health/config/channel state, flag issues locally, then ask the agent for advice.
- **`chat`** — one-shot or interactive REPL chat with an agent, with streamed responses.

## Requirements

- Node.js >= 22
- A running OpenClaw gateway reachable over WebSocket
- An OpenClaw device identity on this machine (created by `openclaw` itself —
  `ocdiag` never creates or modifies one)

## Install

```bash
git clone https://github.com/Meari-Prototype/ocdiag.git
cd ocdiag
npm install
npm run build
npm link        # optional: exposes the `ocdiag` command globally
```

Or run straight from source without building:

```bash
npm run dev -- status
```

## Configuration

By default `ocdiag` connects to `ws://127.0.0.1:18789`. Override via environment
variables or flags:

| Env var | Default | Meaning |
|---|---|---|
| `OPENCLAW_GATEWAY_HOST` | `127.0.0.1` | Gateway host |
| `OPENCLAW_GATEWAY_PORT` | `18789` | Gateway port |
| `OPENCLAW_GATEWAY_TOKEN` | — | Shared gateway token (only if the gateway uses token auth) |
| `OCDIAG_DEBUG` | — | Set to `1` to print raw protocol frames to stderr |

Global flags (override env vars):

```
--url <url>      Gateway WebSocket URL
--token <token>  Gateway auth token
--json           Output machine-readable JSON (status / config)
--verbose        Show full raw payloads (status)
```

If the gateway uses token auth, the token is also read from
`~/.openclaw/openclaw.json` (`gateway.auth.token`) when not provided.

## Usage

```bash
ocdiag status                    # concise overview: gateway + channels + agents
ocdiag status --verbose          # full raw health/status/channels
ocdiag status --json             # machine-readable JSON
ocdiag config                    # config (one canonical layer, secrets redacted)
ocdiag config auth               # a single dotted key
ocdiag config --json             # full raw config (redacted), for jq
ocdiag diagnose                  # collect diagnostics + ask the agent
ocdiag chat "is the telegram channel up?"   # one-shot
ocdiag chat                      # interactive REPL (/quit to exit)
```

## Authentication

When connecting from outside the gateway host (e.g. a host machine to a gateway
running in Docker), the connection is **not** treated as local, so device
identity authentication is required. `ocdiag` reads the existing identity and
pairing data created by OpenClaw — it never generates new credentials.

Files read (read-only):

| File | Used for |
|---|---|
| `~/.openclaw/identity/device.json` | Ed25519 device key pair |
| `~/.openclaw/identity/device-auth.json` | device token issued during pairing |
| `~/.openclaw/devices/paired.json` | paired platform metadata |
| `~/.openclaw/openclaw.json` | optional gateway token |

## Privacy & security

- The Ed25519 **private key is used only to sign the handshake challenge
  locally**. The signature — never the private key — is sent to the gateway.
- `ocdiag` is **read-only** toward gateway *config*; it issues no write methods
  (e.g. `config.set`).
- ℹ️ `chat` and `diagnose` don't change config, but they do create and append
  messages to a dedicated diagnostic agent session (sessionKey `gateway:direct`)
  and trigger an LLM run on the gateway — server-side state that never touches
  your config or local identity.
- `config` and `diagnose` redact secret-looking keys (tokens, passwords, API
  keys, authorization, cookie, …) heuristically before printing; secrets under
  unusual key names or non-string values may slip through, so review before sharing.
- ⚠️ `diagnose` sends a **redacted** copy of your config to the gateway agent for
  advice. If that agent is backed by a remote LLM, redacted config text leaves
  your machine. Run `diagnose` only when you're comfortable with that.

## Development

```bash
npm run dev -- <command>   # run from source via tsx
npm test                   # run unit tests
npm run build              # compile to dist/
```

## License

[MIT](LICENSE) © Meari-Prototype
