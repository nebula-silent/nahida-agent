// 8.9 新增：钉钉企业机器人适配器（Stream 模式，**免公网服务器**）。
// 依据：内部规格 §1.2
//
// 接入方式（不买服务器、不要公网回调 URL）：
//   ① 接收 —— 官方 `dingtalk-stream` 的 WSS 长连接（Stream 模式），订阅机器人消息回调
//      `/v1.0/im/bot/messages/get`；同样是**出站**长连接，本机不需要任何入站端口。
//   ② 发送 —— Stream 推来的机器人消息体里带 `sessionWebhook`（一次性回复地址，含过期时间），
//      回复就走它 —— 原路回发，不必再换 access_token。
//   ③ 凭证 —— clientId / clientSecret（= 企业内部应用的 AppKey / AppSecret）存 config，落盘 enc:。
//
// 分层与 feishu.ts 同构：纯函数 parseDingTalkRobotMessage 可单测；网络端口 DingTalkPort 可注入假实现。
import { BoundedSeenSet } from "../dedup";
import { ConnectionSupervisor, type ConnectablePort } from "../supervisor";
import type { ChannelAdapter, IncomingMessage } from "../types";

export const DINGTALK_ID = "dingtalk";

export interface DingTalkCreds {
  clientId: string;
  clientSecret: string;
}

// ==================== ① 机器人消息 → 来信（纯函数）====================

export interface ParsedDingTalkMessage {
  /** 回发目标：conversationId（1:1 与群会话都稳，且与 sessionWebhook 一一对应） */
  target: string;
  text: string;
  /** 消息 id（去重用） */
  messageId: string;
  /** 回复地址（回复靠它，不需鉴权；空 = 该消息不带 webhook，只能留在会话里） */
  webhook: string;
  /** webhook 过期时间（ms 时间戳；0 = 未提供） */
  webhookExpireAt: number;
}

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

/**
 * Stream 回调帧的 `data`（JSON 串或已解析对象）→ 一条可注入的来信；不符合条件返回 null。
 * 丢弃规则同飞书（第一版只收文本）：非 text / 内容为空 / 无 conversationId。
 */
export function parseDingTalkRobotMessage(data: unknown): ParsedDingTalkMessage | null {
  const raw = typeof data === "string" ? safeJson(data) : (data as Record<string, unknown> | null);
  if (!raw || typeof raw !== "object") return null;
  if (raw.msgtype !== "text") return null;
  const textObj = raw.text as { content?: unknown } | undefined;
  const text = typeof textObj?.content === "string" ? textObj.content.trim() : "";
  if (!text) return null;
  const target = typeof raw.conversationId === "string" ? raw.conversationId.trim() : "";
  if (!target) return null;
  const webhook = typeof raw.sessionWebhook === "string" ? raw.sessionWebhook.trim() : "";
  const expire = raw.sessionWebhookExpiredTime;
  return {
    target,
    text,
    messageId: typeof raw.msgId === "string" ? raw.msgId : "",
    webhook,
    webhookExpireAt: typeof expire === "number" && Number.isFinite(expire) ? expire : 0,
  };
}

// ==================== ② 网络端口 ====================

/** 一次连接的网络端口（真机 = dingtalk-stream；单测 = 假实现） */
export interface DingTalkPort extends ConnectablePort {
  /** 经会话 webhook 回发文本 */
  postWebhook(webhookUrl: string, text: string): Promise<void>;
}

export type DingTalkPortFactory = (
  creds: DingTalkCreds,
  /** 收到一帧回调（原始帧，解析交给适配器） */
  onFrame: (frame: unknown) => void,
) => DingTalkPort;

/** 官方 SDK 的最小形状（只声明用到的部分） */
interface DingTalkSdkModule {
  DWClient: new (opts: { clientId: string; clientSecret: string; keepAlive?: boolean }) => DingTalkSdkClient;
  TOPIC_ROBOT: string;
}

interface DingTalkSdkClient {
  connected: boolean;
  reconnecting: boolean;
  config: { autoReconnect?: boolean };
  connect(): Promise<void>;
  disconnect(): void;
  registerCallbackListener(topic: string, cb: (frame: DingTalkFrame) => void): unknown;
  socketCallBackResponse(messageId: string, result: unknown): void;
}

interface DingTalkFrame {
  headers: { messageId: string; topic?: string };
  data: string;
}

/** 首连就绪的等待上限（DWClient 的 connect() 会把失败吞掉并自己重试，只能靠轮询 connected 判定） */
const DINGTALK_READY_TIMEOUT_MS = 15000;
const DINGTALK_READY_POLL_MS = 200;
/** 回发 HTTP 的超时（webhook 是钉钉侧地址，卡住不能拖垮会话） */
const DINGTALK_SEND_TIMEOUT_MS = 8000;

/** 等 predicate 变真；超时抛错。实现在 connect() 里（轮询，SDK 不发连接事件） */
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, DINGTALK_READY_POLL_MS));
  }
  throw new Error(`钉钉 Stream ${timeoutMs}ms 内未连接（检查 ClientId / ClientSecret 与网络）`);
}

/**
 * 真机端口：dingtalk-stream 长连接。
 *
 * 关键取舍（踩坑点）：
 *   · `DWClient.connect()` **不抛错** —— 它 catch 掉失败并在 1s 后自己重试（autoReconnect 默认 true），
 *     promise 立刻 resolve。所以既不能靠它判成败，也不能 await 到「连上」；改为轮询 `connected`。
 *   · 日常掉线交给 SDK 自己重连（connected=false / reconnecting=true）；SDK 彻底放弃后
 *     由 ConnectionSupervisor 兜底重建（退避）。
 *   · 收到 CALLBACK 帧必须回一个响应，否则钉钉 60s 后会重推同一条消息。
 */
export function createDingTalkSdkPort(creds: DingTalkCreds, onFrame: (frame: unknown) => void): DingTalkPort {
  // 懒 require：vitest import 本文件时不会加载 SDK
  const sdk = require("dingtalk-stream") as DingTalkSdkModule;
  let client: DingTalkSdkClient | null = null;

  return {
    async connect(): Promise<void> {
      const c = new sdk.DWClient({ clientId: creds.clientId, clientSecret: creds.clientSecret });
      client = c;
      c.registerCallbackListener(sdk.TOPIC_ROBOT, (frame) => {
        try {
          onFrame(frame);
        } finally {
          // 明确响应（避免服务端重推）：失败也不影响本轮处理
          try {
            c.socketCallBackResponse(frame.headers.messageId, {});
          } catch (err) {
            console.warn(`[im] ${DINGTALK_ID} 回执失败（钉钉可能重推这一条）：`, err);
          }
        }
      });
      // 不能 await：connect() 吞错并自己重试，await 会立刻 resolve 却根本没连上
      void c.connect().catch((err: unknown) => console.warn(`[im] ${DINGTALK_ID} 连接错误：`, err));
      await waitUntil(() => c.connected, DINGTALK_READY_TIMEOUT_MS);
    },

    async postWebhook(webhookUrl: string, text: string): Promise<void> {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ msgtype: "text", text: { content: text } }),
        signal: AbortSignal.timeout(DINGTALK_SEND_TIMEOUT_MS),
      });
      const body = (await res.json()) as { errcode?: number; errmsg?: string };
      if (body.errcode !== 0) {
        throw new Error(`钉钉发送失败：errcode=${body.errcode ?? "?"} ${body.errmsg ?? ""}`.trim());
      }
    },

    isAlive(): boolean {
      return client !== null && (client.connected || client.reconnecting);
    },

    async dispose(): Promise<void> {
      const c = client;
      client = null;
      if (!c) return;
      try {
        // 先掐掉 SDK 自己的重试，再断开：否则已排队的重试可能把连接又拉起来（无人回收）
        c.config.autoReconnect = false;
        c.disconnect();
      } catch (err) {
        console.warn(`[im] ${DINGTALK_ID} 断开时出错（忽略）：`, err);
      }
    },
  };
}

// ==================== ③ 适配器 ====================

export interface DingTalkChannelDeps {
  portFactory?: DingTalkPortFactory;
  baseMs?: number;
  maxMs?: number;
  healthIntervalMs?: number;
}

function readDingTalkCreds(config: Record<string, string>): DingTalkCreds {
  const clientId = (config.clientId ?? "").trim();
  const clientSecret = (config.clientSecret ?? "").trim();
  if (!clientId || !clientSecret) {
    throw new Error("钉钉凭证不完整：请先填写 Client ID 与 Client Secret");
  }
  return { clientId, clientSecret };
}

export class DingTalkChannel implements ChannelAdapter {
  readonly id = DINGTALK_ID;
  readonly displayName = "钉钉";

  private readonly listeners: Array<(msg: IncomingMessage) => void> = [];
  private readonly seen = new BoundedSeenSet();
  /** conversationId → 回复地址（消息自带，回复原路发出）。随适配器存活，不随重连丢失 */
  private readonly webhooks = new Map<string, { url: string; expireAt: number }>();
  private supervisor: ConnectionSupervisor | null = null;
  private port: DingTalkPort | null = null;

  constructor(
    private readonly getConfig: () => Record<string, string>,
    private readonly deps: DingTalkChannelDeps = {},
  ) {}

  async start(): Promise<void> {
    readDingTalkCreds(this.getConfig());
    const factory: DingTalkPortFactory = this.deps.portFactory ?? createDingTalkSdkPort;
    const supervisor = new ConnectionSupervisor(
      () => {
        const port = factory(readDingTalkCreds(this.getConfig()), (frame) => this.handleFrame(frame));
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
    if (!port || !port.isAlive()) throw new Error("钉钉通道未连接，无法发送");
    const hook = this.webhooks.get(target);
    if (!hook) {
      throw new Error("钉钉会话地址未知：该会话还没发过消息（Stream 模式的回复地址由用户消息带出）");
    }
    if (hook.expireAt > 0 && Date.now() > hook.expireAt) {
      this.webhooks.delete(target);
      throw new Error("钉钉会话地址已过期：让用户再发一条消息即可恢复");
    }
    await port.postWebhook(hook.url, content);
  }

  onMessage(cb: (msg: IncomingMessage) => void): void {
    this.listeners.push(cb);
  }

  // ---------- 内部 ----------

  /** 一帧回调：`frame.data` 是消息体 JSON；解析 → 去重 → 缓存回复地址 → 抛给桥接层 */
  private handleFrame(frame: unknown): void {
    const data = (frame as DingTalkFrame | null)?.data;
    const parsed = parseDingTalkRobotMessage(data);
    if (!parsed) return;
    if (parsed.webhook) {
      this.webhooks.set(parsed.target, { url: parsed.webhook, expireAt: parsed.webhookExpireAt });
    }
    if (!this.seen.add(parsed.messageId)) {
      console.log(`[im] ${this.id} 重复消息已丢弃：${parsed.messageId}`);
      return;
    }
    this.emit({
      channelId: this.id,
      target: parsed.target,
      text: parsed.text,
      receivedAt: Date.now(),
    });
  }

  private emit(msg: IncomingMessage): void {
    for (const cb of this.listeners) cb(msg);
  }
}