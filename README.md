**中文** | [English](README.en.md)

# ocdiag

*ocdiag — OpenClaw diagnostics · OpenClaw 诊断（工具）*

OpenClaw 网关的只读诊断 CLI。通过网关的 WebSocket 协议检查网关健康状况、查看（脱敏后的）配置、运行本地诊断，并与网关里的智能体对话。

`ocdiag` **从不写入**网关配置。它只调用只读方法（`health`、`status`、`config.get`、`channels.status` 等），并通过一个专用的诊断会话与智能体通信。

## 功能

- **`status`** — 精简概览：网关版本/健康、各通道连通性、智能体（`--verbose` 看完整原始负载，`--json` 输出机器可读 JSON）。
- **`config`** — 读取网关配置（密钥已脱敏；默认只展示单层规范配置，`--json` 输出完整原始负载），可选只读取某个点分路径的键。
- **`diagnose`** — 收集健康 / 配置 / 通道状态，先在本地标记问题，再请智能体给出建议。
- **`chat`** — 与智能体单次或交互式（REPL）对话，流式输出回复。

## 环境要求

- Node.js >= 22
- 一个可通过 WebSocket 访问的 OpenClaw 网关
- 本机已有 OpenClaw 设备身份（由 `openclaw` 自己创建 —— `ocdiag` 绝不创建或修改它）

## 安装

```bash
git clone https://github.com/Meari-Prototype/ocdiag.git
cd ocdiag
npm install
npm run build
npm link        # 可选：把 `ocdiag` 命令暴露到全局
```

或者不构建，直接从源码运行：

```bash
npm run dev -- status
```

## 配置

`ocdiag` 默认连接 `ws://127.0.0.1:18789`。可通过环境变量或命令行参数覆盖：

| 环境变量 | 默认值 | 含义 |
|---|---|---|
| `OPENCLAW_GATEWAY_HOST` | `127.0.0.1` | 网关主机 |
| `OPENCLAW_GATEWAY_PORT` | `18789` | 网关端口 |
| `OPENCLAW_GATEWAY_TOKEN` | — | 网关共享 token（仅当网关启用 token 认证时需要） |
| `OCDIAG_DEBUG` | — | 设为 `1` 时把原始协议帧打印到 stderr |

全局参数（优先级高于环境变量）：

```
--url <url>      网关 WebSocket 地址
--token <token>  网关认证 token
--json           以机器可读 JSON 输出（status / config）
--verbose        显示完整原始负载（status）
```

当未显式提供 token 时，若网关使用 token 认证，token 也会从 `~/.openclaw/openclaw.json`（`gateway.auth.token`）读取。

## 使用

```bash
ocdiag status                       # 精简概览：网关 + 通道 + 智能体
ocdiag status --verbose             # 完整原始 health/status/channels
ocdiag status --json                # 机器可读 JSON
ocdiag config                       # 配置（默认单层，密钥脱敏）
ocdiag config auth                  # 单个点分路径键
ocdiag config --json                # 完整原始配置（脱敏后），供 jq 使用
ocdiag diagnose                     # 收集诊断 + 询问智能体
ocdiag chat "telegram 通道还正常吗？"   # 单次
ocdiag chat                         # 交互式 REPL（/quit 退出）
```

## 认证

当从网关宿主机之外连接时（例如宿主机连 Docker 里的网关），连接**不会**被视为本地连接，因此需要设备身份认证。`ocdiag` 读取 OpenClaw 已创建的身份与配对数据 —— 绝不生成新凭据。

读取的文件（只读）：

| 文件 | 用途 |
|---|---|
| `~/.openclaw/identity/device.json` | Ed25519 设备密钥对 |
| `~/.openclaw/identity/device-auth.json` | 配对时颁发的设备 token |
| `~/.openclaw/devices/paired.json` | 配对的平台元数据 |
| `~/.openclaw/openclaw.json` | 可选的网关 token |

## 隐私与安全

- Ed25519 **私钥仅用于在本地对握手挑战（challenge）签名**。发给网关的是签名结果 —— 私钥本身绝不外传。
- ⚠️ 默认连接是明文 `ws://`，**无 TLS**。本机或 Docker 桥接没问题；但若把 `OPENCLAW_GATEWAY_HOST` 指向远程主机，设备 token 与签名负载会**明文过网**。跨网络场景请走 SSH 隧道 / VPN，或在网关前置 TLS（`wss://`）。
- `ocdiag` 对网关**配置**是只读的，不发出任何写操作（如 `config.set`）方法。
- ℹ️ `chat` 与 `diagnose` 不修改配置，但会在网关侧创建并向专用诊断会话（sessionKey `gateway:direct`）追加消息，并触发一次智能体的 LLM 运行。这是网关侧的状态变更，不影响你的配置或本地身份。
- `config` 和 `diagnose` 在打印前会按常见密钥名（token、password、API key、authorization、cookie 等）对疑似密钥做**启发式**脱敏；非常规命名或非字符串的键可能漏网，分享前请自行复核。
- ⚠️ `diagnose` 会把**脱敏后**的配置副本发给网关智能体以获取建议。如果该智能体由远程 LLM 驱动，脱敏后的配置文本会离开你的机器。请在你能接受这一点时再运行 `diagnose`。

## 开发

```bash
npm run dev -- <command>   # 通过 tsx 从源码运行
npm test                   # 跑单元测试
npm run build              # 编译到 dist/
```

## 许可证

[MIT](LICENSE) © Meari-Prototype
