// 8.10 新增：微信通道适配器（腾讯官方 iLink / ClawBot 协议，**免公网服务器**）。
// 依据：内部规格 §2 接入步骤 / §4 对接形状。
//
// 接入方式（不买服务器、不做内网穿透、不要公网回调）：
//   ① 登录 —— 官方二维码接口 `GET /ilink/bot/get_bot_qrcode` + 轮询 `get_qrcode_status`，
//      手机扫码确认后拿到 bot_token / ilink_bot_id / ilink_user_id / baseurl（落盘复用，重扫才失效）。
//   ② 接收 —— `POST /ilink/bot/getupdates` **长轮询**（服务端 hold ~35s），纯出站请求，
//      本机不需要任何入站端口。游标 `get_updates_buf` 原样回传（不透明）。
//   ③ 发送 —— `POST /ilink/bot/sendmessage`，**必须回带来信携带的 context_token**（约 24h 无互动即失效）。
//
// 三条硬边界（预研结论 §0，实现必须照做）：
//   · **只支持私聊**，协议侧没有群聊；
//   · 回复依赖 context_token → 只能「收到即回复」，不做定时主动推送；
//   · 发送报文有若干「文档没写但缺了就静默丢消息」的必填字段，见 buildWeixinSendBody。
//
// 分层与 feishu.ts / dingtalk.ts 同构：纯函数（解析 / 组装 / 白名单）可单测；网络端口 WeixinPort 可注入假实现。
// 零新增依赖：只用 Node 内置 fetch 与 node:crypto / node:fs。
import { randomUUID } from "node:crypto";
import { BoundedSeenSet } from "../dedup";
import { ConnectionSupervisor, type ConnectablePort } from "../supervisor";
import type { ChannelAdapter, IncomingMessage } from "../types";

export const WEIXIN_ID = "weixin";

/** iLink 服务默认地址；扫码返回的 baseurl 若不同必须以返回值为准 */
export const DEFAULT_WEIXIN_BASE_URL = "https://ilinkai.weixin.qq.com";
/** 请求体必带的协议版本号（社区资料里出现过 1.0.3 / 2.0.0 两种取值，真机需复验） */
export const WEIXIN_CHANNEL_VERSION = "2.0.0";

/** 服务端长轮询 hold 约 35s，客户端留一点余量 */
const WEIXIN_POLL_TIMEOUT_MS = 40000;
/** 首连探针的等待上限 */
const WEIXIN_READY_TIMEOUT_MS = 10000;
/** 发送 / 扫码请求的超时 */
const WEIXIN_SEND_TIMEOUT_MS = 10000;
/** 查询扫码状态的客户端上限：必须**大于服务端 hold 时长**，否则每拍都被自己掐断（真机实测 hold >10s） */
const WEIXIN_QR_TIMEOUT_MS = 35000;
/** 长轮询出错后的最小重试间隔（避免打爆服务端） */
const WEIXIN_POLL_RETRY_MS = 2000;

// ==================== ① 协议解析 / 组装（纯函数）====================

export interface WeixinCreds {
  /** 登录令牌（Bearer） */
  botToken: string;
  /** ilink_bot_id（形如 xxxx@im.bot） */
  accountId: string;
  /** ilink_user_id（扫码者标识，形如 xxx@im.wechat） */
  userId: string;
  /** 服务地址（扫码返回值优先） */
  baseUrl: string;
}

/** 一条可注入的来信（协议层 → 适配器内部形状；不进 IncomingMessage） */
export interface WeixinIncoming {
  /** 发送方标识 = from_user_id（私聊无群 id） */
  target: string;
  text: string;
  /** 回带用令牌（约 24h 失效）；缺失则可收不可回 */
  contextToken: string;
  /** 去重用消息 id（client_id） */
  messageId: string;
}

export type WeixinQrStatus =
  | { state: "wait" }
  /** 已扫码待手机确认（协议里拼写为 "scaned"） */
  | { state: "scanned" }
  | { state: "expired" }
  | { state: "confirmed"; creds: WeixinCreds }
  /** 返回了 confirmed 但四件套不全 —— 不能当成成功 */
  | { state: "invalid"; reason: string };

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 取二维码：`{ qrcode, qrcode_img_content }`。后者是**网页地址不是图片**（见预研 §2.2） */
export function parseWeixinQrStart(payload: unknown): { qrcode: string; qrUrl: string } | null {
  const root = (payload ?? null) as Record<string, unknown> | null;
  if (!root || typeof root !== "object") return null;
  const qrcode = str(root.qrcode);
  const qrUrl = str(root.qrcode_img_content);
  if (!qrcode || !qrUrl) return null;
  return { qrcode, qrUrl };
}

/** 扫码状态：wait → scaned → confirmed（或 expired）。状态串不认识时按 wait 处理（保守） */
export function parseWeixinQrStatus(payload: unknown): WeixinQrStatus {
  const root = (payload ?? null) as Record<string, unknown> | null;
  if (!root || typeof root !== "object") return { state: "wait" };
  const status = str(root.status).toLowerCase();
  if (status === "expired") return { state: "expired" };
  if (status === "scaned" || status === "scanned") return { state: "scanned" };
  if (status !== "confirmed") return { state: "wait" };
  const botToken = str(root.bot_token);
  const accountId = str(root.ilink_bot_id);
  const userId = str(root.ilink_user_id);
  // baseurl 可能不返回：回落默认值；token 缺失则整次登录算失败
  const baseUrl = str(root.baseurl) || str(root.base_url) || DEFAULT_WEIXIN_BASE_URL;
  if (!botToken) return { state: "invalid", reason: "confirmed 但没返回 bot_token" };
  return { state: "confirmed", creds: { botToken, accountId, userId, baseUrl } };
}

/**
 * `getupdates` 响应 → 可注入来信 + 新游标。
 * 丢弃规则（第一版只收文本）：
 *   ① BOT 方向（`message_type !== 1`）—— 我们自己发出去的消息可能被回吐，形成自激循环；
 *   ② `client_id` 命中本端口已发出的 id（更精确的回环过滤）；
 *   ③ 非文本 item / 文本为空 / 缺 `from_user_id`。
 * 注：**漏掉 `message_type` 的来信按用户消息处理**（宁可多收也不丢真消息）。
 */
export function parseWeixinUpdates(
  payload: unknown,
  isOwnClientId: (id: string) => boolean = () => false,
  previousCursor = "",
): { messages: WeixinIncoming[]; cursor: string; sessionExpired: boolean } {
  const root = (payload ?? null) as Record<string, unknown> | null;
  const empty = { messages: [] as WeixinIncoming[], cursor: previousCursor, sessionExpired: false };
  if (!root || typeof root !== "object") return empty;

  if (root.errcode === -14 || root.ret === -14) {
    return { messages: [], cursor: "", sessionExpired: true };
  }

  const cursor = str(root.get_updates_buf) || previousCursor;
  const msgs = Array.isArray(root.msgs) ? root.msgs : [];
  const messages: WeixinIncoming[] = [];
  for (const raw of msgs) {
    const parsed = parseWeixinIncomingMessage(raw, isOwnClientId);
    if (parsed) messages.push(parsed);
  }
  return { messages, cursor, sessionExpired: false };
}

/** 单条 `msgs[i]` → 来信；不符合条件返回 null（规则同上） */
export function parseWeixinIncomingMessage(
  raw: unknown,
  isOwnClientId: (id: string) => boolean = () => false,
): WeixinIncoming | null {
  const msg = (raw ?? null) as Record<string, unknown> | null;
  if (!msg || typeof msg !== "object") return null;
  if (msg.message_type !== undefined && msg.message_type !== 1) return null; // 1 = 用户，2 = BOT

  const messageId = str(msg.client_id);
  if (messageId && isOwnClientId(messageId)) return null; // 我们自己发出去的 → 回环，绝不当新来信

  const target = str(msg.from_user_id);
  if (!target) return null;

  const items = Array.isArray(msg.item_list) ? msg.item_list : [];
  const first = (items[0] ?? null) as Record<string, unknown> | null;
  if (!first || first.type !== 1) return null; // 第一版只收文本
  const textItem = (first.text_item ?? null) as Record<string, unknown> | null;
  const text = str(textItem?.text);
  if (!text) return null;

  return { target, text, contextToken: str(msg.context_token), messageId };
}

/**
 * 发送报文（**逐字段对齐，缺一个就被服务端静默丢弃：HTTP 200 但不送达**）。
 * `from_user_id` 必须存在且为空串；`client_id` 每条唯一（去重与路由）；
 * `message_type: 2` / `message_state: 2` 表示「BOT 的完整消息」。
 */
export function buildWeixinSendBody(input: {
  toUserId: string;
  contextToken: string;
  text: string;
  clientId: string;
  channelVersion?: string;
}): Record<string, unknown> {
  return {
    msg: {
      from_user_id: "",
      to_user_id: input.toUserId,
      client_id: input.clientId,
      message_type: 2,
      message_state: 2,
      context_token: input.contextToken,
      item_list: [{ type: 1, text_item: { text: input.text } }],
    },
    base_info: { channel_version: input.channelVersion ?? WEIXIN_CHANNEL_VERSION },
  };
}

/** `X-WECHAT-UIN` = base64(十进制字符串形式的随机 uint32)（负数按 uint32 回绕，NaN 归 0） */
export function encodeWeixinUin(value: number): string {
  const n = Math.floor(value) >>> 0;
  return Buffer.from(String(n), "utf8").toString("base64");
}

/** 逗号 / 顿号 / 空白分隔的白名单串 → 数组（去空、去重） */
export function parseWeixinAllowList(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(/[,，、\s]+/)) {
    const id = piece.trim();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * 白名单判定：**空名单 = 全部拒绝（fail-closed）**。
 * 判据是 `from_user_id`（稳定标识），不用昵称/备注名（可改可重名）。
 * 只有用户显式写 `*` 才放开（预研 §2.4 要求自建白名单，不依赖生态侧配置）。
 */
export function isWeixinSourceAllowed(target: string, allowList: readonly string[]): boolean {
  const id = target.trim();
  if (!id) return false;
  return allowList.some((entry) => entry === "*" || entry === id);
}

// ==================== ② 扫码登录（独立于常驻连接）====================

/** 取登录二维码（GET，无需鉴权） */
export async function fetchWeixinQrCode(
  baseUrl = DEFAULT_WEIXIN_BASE_URL,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ qrcode: string; qrUrl: string }> {
  const res = await fetchImpl(`${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`, {
    method: "GET",
    headers: { "iLink-App-ClientVersion": "1" },
    signal: AbortSignal.timeout(WEIXIN_QR_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`获取微信登录二维码失败：HTTP ${res.status}`);
  const parsed = parseWeixinQrStart(safeJson(text));
  if (!parsed) throw new Error("获取微信登录二维码失败：返回体缺少 qrcode / qrcode_img_content");
  return parsed;
}

/** 查询扫码状态（GET，无需鉴权）。**注意：这个接口也是服务端 long-poll** ——
 *  真机实测（2026-09-29）它不立刻返回，而是 hold 住直到「扫码状态真的变了」才回（10s 客户端超时被掐断 4/4 次）。
 *  所以超时按「还没人扫码」处理，不许报错；调用方按 ~0.5s 间隔续拍即可（服务端变了会立刻回）。 */
export async function queryWeixinQrStatus(
  qrcode: string,
  baseUrl = DEFAULT_WEIXIN_BASE_URL,
  fetchImpl: typeof fetch = globalThis.fetch,
  /** 客户端上限（默认 35s；单测注入小值以验证「超时算 wait」） */
  timeoutMs: number = WEIXIN_QR_TIMEOUT_MS,
): Promise<WeixinQrStatus> {
  let res: Response;
  try {
    res = await fetchImpl(
      `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      {
        method: "GET",
        headers: { "iLink-App-ClientVersion": "1" },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
  } catch (err) {
    // 我们自己的超时掐断 = 服务端还在 hold = 没人扫码（同 connect() 探针的判定口径）
    if (err instanceof Error && err.name === "AbortError") return { state: "wait" };
    throw err;
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`查询微信扫码状态失败：HTTP ${res.status}`);
  return parseWeixinQrStatus(safeJson(text));
}

// ==================== ③ 网络端口（真机 = iLink HTTP；单测 = 假实现）====================

/** 一次连接的网络端口 */
export interface WeixinPort extends ConnectablePort {
  /** 回发文本给 target（**必须带该会话的 context_token**） */
  sendText(target: string, text: string, contextToken: string): Promise<void>;
}

export type WeixinPortFactory = (
  creds: WeixinCreds,
  /** 收到一条用户来信 */
  onMessage: (msg: WeixinIncoming) => void,
  /** 登录态失效（errcode -14）：只能重新扫码 */
  onSessionExpired?: () => void,
) => WeixinPort;

export interface WeixinPortOptions {
  fetchImpl?: typeof fetch;
  channelVersion?: string;
  /** 长轮询单次超时（测试里调小） */
  pollTimeoutMs?: number;
  /** 首连探针等待上限（测试里调小） */
  readyTimeoutMs?: number;
  /** 出错后的重试间隔 */
  pollRetryMs?: number;
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * 真机端口：iLink 长轮询 + 发送。
 *
 * 关键取舍（踩坑点）：
 *   · `connect()` 不能 await 一次完整长轮询（服务端会挂 35s，registry 的启停 IPC 会卡住）——
 *     改为「发一次探针请求 + 客户端主动超时」：**被我们自己的超时掐断 = 服务端确实挂住了 = 连接正常**；
 *     若对方快速返回 401 / errcode -14，则判为失败直接 reject。
 *   · 日常断链（系统休眠 / 切网）由本循环自己重试；登录态失效（-14）只能重新扫码，
 *     本端口置 isAlive()=false，交给 ConnectionSupervisor 记录并退避（重启也救不回来，日志会说明）。
 *   · 客户端超时（AbortError）不算故障 —— 它是长轮询的正常空转形态，继续下一轮即可。
 */
export function createWeixinIlinkPort(
  creds: WeixinCreds,
  onMessage: (msg: WeixinIncoming) => void,
  onSessionExpired?: () => void,
  opts: WeixinPortOptions = {},
): WeixinPort {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const channelVersion = opts.channelVersion ?? WEIXIN_CHANNEL_VERSION;
  const pollTimeoutMs = opts.pollTimeoutMs ?? WEIXIN_POLL_TIMEOUT_MS;
  const readyTimeoutMs = opts.readyTimeoutMs ?? WEIXIN_READY_TIMEOUT_MS;
  const pollRetryMs = opts.pollRetryMs ?? WEIXIN_POLL_RETRY_MS;
  const baseUrl = (creds.baseUrl || DEFAULT_WEIXIN_BASE_URL).replace(/\/+$/, "");

  /** 本端口发出过的 client_id（用于精确回环过滤） */
  const ownIds = new BoundedSeenSet();
  const base = new AbortController();
  let alive = false;
  let disposed = false;
  let cursor = "";
  let loop: Promise<void> | null = null;
  let sleeping: ReturnType<typeof setTimeout> | null = null;

  const headers = (): Record<string, string> => ({
    "Content-Type": "application/json; charset=utf-8",
    AuthorizationType: "ilink_bot_token",
    Authorization: `Bearer ${creds.botToken}`,
    "X-WECHAT-UIN": encodeWeixinUin(Math.floor(Math.random() * 0xffffffff)),
  });

  /** 一次 POST；返回已解析的响应体（空体 = {}）。客户端超时按 AbortError 抛给调用方判断 */
  async function post(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    const perReq = new AbortController();
    const onOuterAbort = (): void => perReq.abort();
    base.signal.addEventListener("abort", onOuterAbort, { once: true });
    const timer = setTimeout(() => perReq.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ ...body, base_info: { channel_version: channelVersion } }),
        signal: perReq.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`iLink ${path} HTTP ${res.status}${text ? `：${text.slice(0, 200)}` : ""}`);
      }
      if (!text.trim()) return {};
      const parsed = safeJson(text);
      if (!parsed) throw new Error(`iLink ${path} 返回了非 JSON 内容`);
      return parsed;
    } finally {
      clearTimeout(timer);
      base.signal.removeEventListener("abort", onOuterAbort);
    }
  }

  /** 消费一轮响应：游标前进 + 抛出来信。返回 false = 登录态失效（本连接到此为止） */
  function consume(payload: Record<string, unknown>): boolean {
    const parsed = parseWeixinUpdates(payload, (id) => ownIds.has(id), cursor);
    if (parsed.sessionExpired) {
      alive = false;
      console.warn(`[im] ${WEIXIN_ID} 登录态已失效（errcode -14）：需要用户在设置页重新扫码`);
      onSessionExpired?.();
      return false;
    }
    cursor = parsed.cursor;
    for (const msg of parsed.messages) onMessage(msg);
    return true;
  }

  async function runLoop(): Promise<void> {
    while (!disposed && !base.signal.aborted) {
      try {
        const payload = await post("/ilink/bot/getupdates", { get_updates_buf: cursor }, pollTimeoutMs);
        if (!consume(payload)) return;
      } catch (err) {
        if (disposed || base.signal.aborted) return;
        // 客户端超时 = 长轮询正常空转（服务端没消息），直接下一轮
        if (!isAbortError(err)) {
          console.warn(`[im] ${WEIXIN_ID} 长轮询出错，${pollRetryMs}ms 后重试：`, err);
          await new Promise<void>((resolve) => {
            sleeping = setTimeout(resolve, pollRetryMs);
          });
          sleeping = null;
          if (disposed || base.signal.aborted) return;
        }
      }
    }
  }

  return {
    async connect(): Promise<void> {
      try {
        const payload = await post("/ilink/bot/getupdates", { get_updates_buf: "" }, readyTimeoutMs);
        if (!consume(payload)) throw new Error("微信登录态已失效（errcode -14）：请重新扫码登录");
      } catch (err) {
        // 我们自己掐断的探针 = 服务端 hold 住了 = 长轮询可用
        if (!isAbortError(err)) throw err;
        if (disposed || base.signal.aborted) throw new Error("微信通道已停止");
      }
      alive = true;
      loop = runLoop();
    },

    async sendText(target: string, text: string, contextToken: string): Promise<void> {
      if (disposed || !alive) throw new Error("微信通道未连接，无法发送");
      if (!contextToken) {
        throw new Error("微信会话令牌缺失：iLink 只允许回复，需要对方先发一条消息");
      }
      const clientId = `nahida-${randomUUID()}`;
      ownIds.add(clientId); // 先登记再发：回吐回来时能认出是我们自己的
      const payload = await post(
        "/ilink/bot/sendmessage",
        buildWeixinSendBody({ toUserId: target, contextToken, text, clientId, channelVersion }),
        WEIXIN_SEND_TIMEOUT_MS,
      );
      // 空体（HTTP 200 + 空）按社区口径视为成功；有 ret/errcode 才判定
      const ret = payload.ret;
      const errcode = payload.errcode;
      if (errcode === -14) {
        alive = false;
        onSessionExpired?.();
        throw new Error("微信登录态已失效（errcode -14）：请重新扫码登录");
      }
      if (typeof ret === "number" && ret !== 0) {
        // ret=-2 既可能是 context_token 过期，也可能是真限流 —— 两者同码，无法从错误码区分
        throw new Error(
          ret === -2
            ? "微信发送失败（ret=-2）：多为会话令牌已过期（约 24h 无互动），也可能是限流；让对方先发一条消息即可恢复"
            : `微信发送失败：ret=${ret}`,
        );
      }
    },

    isAlive(): boolean {
      return alive && !disposed;
    },

    async dispose(): Promise<void> {
      disposed = true;
      alive = false;
      base.abort();
      if (sleeping !== null) {
        clearTimeout(sleeping);
        sleeping = null;
      }
      try {
        await loop;
      } catch (err) {
        console.warn(`[im] ${WEIXIN_ID} 断开时出错（忽略）：`, err);
      }
      loop = null;
    },
  };
}

// ==================== ④ context_token 落盘（私有状态，不进 config.json）====================

/** token 缓存的读写口（真机 = userData 下的 json 文件；不传 = 仅内存） */
export interface WeixinContextStore {
  read(): Record<string, string>;
  write(tokens: Record<string, string>): void;
}

/** 文件版：单独落 `userData/weixin/context.json`（config.json 里有掩码比对与消毒，状态类数据不能混进去）。
 *  `filePath` 允许传函数：真机构造发生在 app ready 之前，那时 `app.getPath` 还不可用（「调用时求值」口径） */
export function createWeixinContextFileStore(filePath: string | (() => string)): WeixinContextStore {
  const resolve = (): string => (typeof filePath === "function" ? filePath() : filePath);
  return {
    read(): Record<string, string> {
      try {
        const fs = require("node:fs") as typeof import("node:fs");
        const parsed = safeJson(fs.readFileSync(resolve(), "utf8"));
        if (!parsed) return {};
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string" && value) out[key] = value;
        }
        return out;
      } catch {
        return {}; // 首次运行 / 文件损坏都按空处理
      }
    },
    write(tokens: Record<string, string>): void {
      try {
        const fs = require("node:fs") as typeof import("node:fs");
        const path = require("node:path") as typeof import("node:path");
        const file = resolve();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(tokens, null, 2), "utf8");
      } catch (err) {
        console.warn(`[im] ${WEIXIN_ID} context_token 落盘失败（忽略）：`, err);
      }
    },
  };
}

// ==================== ⑤ 适配器 ====================

export interface WeixinChannelDeps {
  portFactory?: WeixinPortFactory;
  /** context_token 落盘（真机注入 userData 文件；不传 = 仅内存，重启需等下次来信） */
  contextStore?: WeixinContextStore;
  baseMs?: number;
  maxMs?: number;
  healthIntervalMs?: number;
}

/** 从 config 里取凭证；baseUrl 缺省回落默认值（token 缺失直接抛 → registry 落 state="error"） */
export function readWeixinCreds(config: Record<string, string>): WeixinCreds {
  const botToken = (config.botToken ?? "").trim();
  if (!botToken) {
    throw new Error("微信未登录：请先扫码连接（设置页 → 消息通道 → 微信）");
  }
  return {
    botToken,
    accountId: (config.accountId ?? "").trim(),
    userId: (config.userId ?? "").trim(),
    baseUrl: (config.baseUrl ?? "").trim() || DEFAULT_WEIXIN_BASE_URL,
  };
}

export class WeixinChannel implements ChannelAdapter {
  readonly id = WEIXIN_ID;
  readonly displayName = "微信";

  private readonly listeners: Array<(msg: IncomingMessage) => void> = [];
  private readonly seen = new BoundedSeenSet();
  /** target（from_user_id）→ context_token；随适配器存活，落盘后可跨重启 */
  private readonly tokens = new Map<string, string>();
  private supervisor: ConnectionSupervisor | null = null;
  private port: WeixinPort | null = null;

  constructor(
    private readonly getConfig: () => Record<string, string>,
    private readonly deps: WeixinChannelDeps = {},
  ) {}

  async start(): Promise<void> {
    readWeixinCreds(this.getConfig());
    this.loadTokens();
    const factory: WeixinPortFactory = this.deps.portFactory ?? createWeixinIlinkPort;
    const supervisor = new ConnectionSupervisor(
      () => {
        const port = factory(
          readWeixinCreds(this.getConfig()),
          (msg) => this.handleIncoming(msg),
          () => console.warn(`[im] ${this.id} 需要重新扫码登录`),
        );
        this.port = port;
        return port;
      },
      {
        label: this.id,
        baseMs: this.deps.baseMs,
        maxMs: this.deps.maxMs,
        healthIntervalMs: this.deps.healthIntervalMs,
      },
    );
    this.supervisor = supervisor;
    try {
      await supervisor.start();
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  async stop(): Promise<void> {
    const supervisor = this.supervisor;
    this.supervisor = null;
    this.port = null;
    if (supervisor) await supervisor.stop();
  }

  async sendMessage(target: string, content: string): Promise<void> {
    const port = this.port;
    if (!port || !port.isAlive()) throw new Error("微信通道未连接，无法发送");
    const token = this.tokens.get(target) ?? "";
    if (!token) {
      throw new Error("微信会话令牌未知：需要对方先发一条消息（iLink 只允许回复，不能主动发起）");
    }
    await port.sendText(target, content, token);
  }

  onMessage(cb: (msg: IncomingMessage) => void): void {
    this.listeners.push(cb);
  }

  // ---------- 内部 ----------

  /** 一条来信：白名单 → 去重 → 缓存令牌 → 抛给桥接层。白名单外只记日志，绝不回复 */
  private handleIncoming(msg: WeixinIncoming): void {
    const allow = parseWeixinAllowList(this.getConfig().sourceAllow ?? "");
    if (!isWeixinSourceAllowed(msg.target, allow)) {
      console.warn(`[im] ${this.id} 来源不在白名单，已丢弃：from=${msg.target}（如需放行，把它填进「来源白名单」）`);
      return;
    }
    if (!this.seen.add(msg.messageId)) {
      console.log(`[im] ${this.id} 重复消息已丢弃：${msg.messageId}`);
      return;
    }
    if (msg.contextToken) {
      this.tokens.set(msg.target, msg.contextToken);
      this.persistTokens();
    }
    this.emit({
      channelId: this.id,
      target: msg.target,
      text: msg.text,
      receivedAt: Date.now(),
    });
  }

  private loadTokens(): void {
    const store = this.deps.contextStore;
    if (!store) return;
    this.tokens.clear();
    for (const [key, value] of Object.entries(store.read())) this.tokens.set(key, value);
  }

  private persistTokens(): void {
    const store = this.deps.contextStore;
    if (!store) return;
    store.write(Object.fromEntries(this.tokens));
  }

  private emit(msg: IncomingMessage): void {
    for (const cb of this.listeners) cb(msg);
  }
}