/**
 * OpenClaw 防腐层 (anti-corruption layer)。
 *
 * 唯一一处把 OpenClaw 网关的原始 payload（health / channels.status / config.get /
 * hello-ok）映射成 ocdiag 内部的规范化视图。下游的渲染 (status.ts) 与判断
 * (diagnose.ts) 只认这些视图，不再直接触碰原始字段名。
 *
 * 设计约定：
 *  - 字段名钉在「当前编译针对的 OpenClaw 版本」(2026.6.10)，不堆防御性别名——
 *    schema 变了就改这一层、按新版本重新解析编译，下游与判断规则零改动。
 *    每个 view 函数都用注释标出它对应的原始路径，就是给将来改 schema 的人/AI 的索引。
 *  - 容错：任何字段缺失 / 类型不符都安全降级（绝不抛），保证诊断工具面对异常或
 *    不可信的网关数据时不崩。
 *  - 纯 TS、纯函数，不喂运行时 LLM、不烧 token。
 */

// --- 容错取值原语 -----------------------------------------------------------
// 任何 unknown 输入都安全收窄；不符合预期类型一律降级，绝不抛。

export function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
export function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
export function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
export function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
export function asNum(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

// --- 终端注入防护 -----------------------------------------------------------

/**
 * 剥掉来自网关/智能体的不可信文本里的终端转义序列与裸控制字符，再交给终端显示。
 * 防的是「非中文/非文本内容」的注入：ANSI/OSC 转义可改写屏幕、伪造健康状态、改窗口
 * 标题、甚至在部分终端写剪贴板；\r 可把光标拉回行首覆写内容。
 *
 * 仅保留 \n 与 \t。我们自己用 chalk 上的色不受影响——只净化「内容」，渲染在外层。
 *
 * 流式安全性：chat 的 agent 输出按 chunk 到达，一个转义序列可能被切到两个 chunk。
 * 但无论是否跨界，引导字节 ESC(0x1b) 都会被本函数移除，序列因此无法被终端解释；
 * 跨界时至多遗留几个可见的参数字符（无害），注入被中和。
 */
export function stripControl(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC: ESC ] … (BEL | ST)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI: ESC [ … final
    .replace(/\x1b[@-_]/g, "") // 其余 ESC 引导的双字符序列
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""); // 裸控制字符（含落单 ESC、\r、DEL、C1），保留 \t \n
}

/** asStr + stripControl：用于会被写入终端的不可信展示字段。 */
function cleanStr(v: unknown): string | undefined {
  const s = asStr(v);
  return s === undefined ? undefined : stripControl(s);
}

// --- 规范化视图类型 ---------------------------------------------------------

export type HealthView = {
  healthy: boolean;
  runtimeVersion?: string;
  durationMs?: number;
  /** undefined 表示原始数据没有 plugins 段（与「有但为空」区分，决定是否显示该行）。 */
  plugins?: { loaded: number; errors: number };
};

export type ServerView = {
  version?: string;
  protocol?: number;
  methodCount: number;
  eventCount: number;
};

export type AccountView = {
  accountId: string;
  connected: boolean;
  /** 三态：true/false/undefined(未声明)。判断侧靠 `enabled !== false` 区分「显式禁用」。 */
  enabled?: boolean;
  lastError?: string;
  username?: string;
};

export type ChannelView = {
  name: string;
  /** 三态：渲染看 `=== true`(运行中)，诊断看 `=== false`(显式未运行才告警)，缺失两者都不触发。 */
  running?: boolean;
  mode?: string;
  accounts: AccountView[];
};

export type AgentView = {
  agentId: string;
  isDefault: boolean;
  heartbeatEnabled: boolean;
  sessionCount: number;
  lastActiveAge?: number;
};

// --- health → HealthView ----------------------------------------------------

/** 来源 (health): { ok, runtimeVersion, durationMs, plugins:{ loaded[], errors[] } } */
export function viewHealth(healthRaw: unknown): HealthView {
  const h = asObj(healthRaw);
  const plugins = asObj(h.plugins);
  return {
    healthy: h.ok === true, // 严格 === true：缺失 / 非布尔一律视为不健康
    runtimeVersion: cleanStr(h.runtimeVersion),
    durationMs: asNum(h.durationMs),
    plugins: h.plugins ? { loaded: asArr(plugins.loaded).length, errors: asArr(plugins.errors).length } : undefined,
  };
}

// --- hello-ok → ServerView --------------------------------------------------

/** 来源 (hello-ok): { server:{ version }, protocol, features:{ methods[], events[] } } */
export function viewServer(helloOk: unknown): ServerView {
  const i = asObj(helloOk);
  const features = asObj(i.features);
  return {
    version: cleanStr(asObj(i.server).version),
    protocol: asNum(i.protocol),
    methodCount: asArr(features.methods).length,
    eventCount: asArr(features.events).length,
  };
}

// --- channels.status → ChannelView[] ---------------------------------------

/** 来源 (health): channels[<channel>].accounts[<accountId>].probe.bot.username */
function lookupUsername(healthRaw: unknown, channel: string, accountId: string): string | undefined {
  const channels = asObj(asObj(healthRaw).channels);
  const accounts = asObj(asObj(channels[channel]).accounts);
  const bot = asObj(asObj(asObj(accounts[accountId]).probe).bot);
  return cleanStr(bot.username); // 来自远端（如 Telegram），高危，净化
}

/**
 * 来源 (channels.status): { channelOrder[], channels:{<name>:{ running, mode }},
 *   channelAccounts:{<name>:[{ accountId, connected, enabled, lastError }]} }
 * 可选传入 health raw 以补每个 account 的 bot username（仅 status 渲染需要）。
 */
export function viewChannels(channelsRaw: unknown, healthRaw?: unknown): ChannelView[] {
  const root = asObj(channelsRaw);
  const meta = asObj(root.channels);
  const accountsByChannel = asObj(root.channelAccounts);
  // 显示顺序：优先显式 channelOrder，缺失则退化为 meta 的 key 顺序（容错降级，非字段别名）。
  const explicitOrder = asArr(root.channelOrder).filter((x): x is string => typeof x === "string");
  const order = explicitOrder.length > 0 ? explicitOrder : Object.keys(meta);

  return order.map((name) => {
    const cm = asObj(meta[name]);
    const accounts = asArr(accountsByChannel[name]).map((raw) => {
      const acc = asObj(raw);
      const accountId = asStr(acc.accountId) ?? "?"; // 原始值：用于 health 里查 username
      return {
        accountId: stripControl(accountId), // 输出净化（索引用原始值，正常标识符净化恒等）
        connected: acc.connected === true,
        enabled: asBool(acc.enabled),
        lastError: cleanStr(acc.lastError), // 可能含远端报文，高危，净化
        username: lookupUsername(healthRaw, name, accountId),
      } satisfies AccountView;
    });
    // name 用原始值索引 meta/accounts，仅输出净化。
    return { name: stripControl(name), running: asBool(cm.running), mode: cleanStr(cm.mode), accounts } satisfies ChannelView;
  });
}

// --- health → AgentView[] ---------------------------------------------------

/**
 * 来源 (health): { defaultAgentId, agents:[{ agentId, isDefault,
 *   heartbeat:{ enabled, every, everyMs, target }, sessions:{ count, recent:[{ age }] } }] }
 */
export function viewAgents(healthRaw: unknown): { defaultAgentId?: string; agents: AgentView[] } {
  const h = asObj(healthRaw);
  const defaultAgentId = asStr(h.defaultAgentId); // 原始值：用于 isDefault 比对
  const agents = asArr(h.agents).map((raw) => {
    const a = asObj(raw);
    const agentId = asStr(a.agentId) ?? "?"; // 原始值：用于比对
    const sessions = asObj(a.sessions);
    const heartbeat = asObj(a.heartbeat);
    const everyMs = asNum(heartbeat.everyMs);
    const every = asStr(heartbeat.every);
    const target = asStr(heartbeat.target);
    const hasInterval =
      everyMs !== undefined ? everyMs > 0 : every !== undefined ? every !== "0" && every.trim() !== "" : true;
    return {
      agentId: stripControl(agentId), // 输出净化
      // 显式 isDefault，或 agentId 命中 defaultAgentId；两者都缺失时不误标（defaultAgentId 必须存在）。
      isDefault: a.isDefault === true || (defaultAgentId !== undefined && agentId === defaultAgentId),
      heartbeatEnabled: heartbeat.enabled === true && hasInterval && target !== "none",
      sessionCount: asNum(sessions.count) ?? 0,
      lastActiveAge: asNum(asObj(asArr(sessions.recent)[0]).age),
    } satisfies AgentView;
  });
  return { defaultAgentId: cleanStr(h.defaultAgentId), agents };
}

// --- config.get 适配 --------------------------------------------------------
// config.get 把真实配置包在若干近乎一致的层里。这里集中「选哪一层」「按 key 取值」
// 「读顶层元信息」三件事，让整 config 视图与单 key 查询永远对同一层、同一份数据。

/**
 * config.get 返回的若干配置层，按优先级排列——整 config 视图 (canonicalConfig) 与
 * 单 key 查询 (getConfigDottedPath) 共用，两者永不在「值来自哪一层」上分歧。
 * 优先 `parsed`（用户真实的 openclaw.json），而非 resolved/runtime 拷贝。
 */
export const CONFIG_LAYER_ORDER = ["parsed", "resolved", "config", "runtimeConfig", "sourceConfig"];

/** 从 config.get 包裹中选出要展示的规范层（见 CONFIG_LAYER_ORDER）。 */
export function canonicalConfig(payload: unknown): { layer: string; value: unknown } {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const p = payload as Record<string, unknown>;
    for (const layer of CONFIG_LAYER_ORDER) {
      const v = p[layer];
      if (v && typeof v === "object") return { layer, value: v };
    }
  }
  return { layer: "raw", value: payload };
}

/** 规范层的顶层 key 列表（单 key 查不到时给用户提示用）。 */
export function availableTopKeys(payload: unknown): string[] {
  const { value } = canonicalConfig(payload);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>);
  }
  return [];
}

/** 点分 key 取值：先按原样在整个 payload 上找，再逐层 (CONFIG_LAYER_ORDER) 兜底。 */
export function getConfigDottedPath(configPayload: unknown, key: string): unknown {
  const direct = getDottedPath(configPayload, key);
  if (direct !== undefined) return direct;

  if (!configPayload || typeof configPayload !== "object") return undefined;
  const payload = configPayload as Record<string, unknown>;
  for (const root of CONFIG_LAYER_ORDER) {
    const value = getDottedPath(payload[root], key);
    if (value !== undefined) return value;
  }
  return undefined;
}

function getDottedPath(obj: unknown, key: string): unknown {
  let current = obj;
  for (const part of key.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export type ConfigMetaView = { path?: string; valid?: boolean; issues: number; warnings: number };

/** 来源 (config.get 顶层): { path, valid, issues[], warnings[] } */
export function viewConfigMeta(payload: unknown): ConfigMetaView {
  const p = asObj(payload);
  return {
    path: cleanStr(p.path),
    valid: asBool(p.valid),
    issues: asArr(p.issues).length,
    warnings: asArr(p.warnings).length,
  };
}
