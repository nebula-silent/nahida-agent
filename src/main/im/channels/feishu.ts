// 8.9 新增：飞书企业自建应用机器人适配器（**免公网服务器**）。
// 依据：内部规格 §1.1
//
// 接入方式（不买服务器、不要公网回调 URL）：
//   ① 事件接收 —— 官方 SDK 的 **WebSocket 长连接**（`@larksuiteoapi/node-sdk` 的 WSClient），
//      订阅 `im.message.receive_v1`；出站长连接，本机就是客户端，不需要任何入站端口。
//   ② 发送 —— 官方 `im.v1.message.create`（机器人回复）。
//   ③ 凭证 —— appId / appSecret 存 config.im.channels[feishu].config，落盘走 enc:（config-store 统一管）。
//
// 分层（同 registry 的口径：能在 vitest 里直接单测）：
//   · 纯函数 parseFeishuMessageEvent —— 事件体 → 来信，最容易写错的部分单独可测；
//   · FeishuPort —— 网络端口接口；真机实现 createFeishuSdkPort（懒 require SDK），单测注入假端口；
//   · FeishuChannel —— ChannelAdapter 实现：只管「连接 → 收 → 发」，会话绑定 / 注入 / 审批全在 8.8 的桥里。
import { sanitizeImChannelConfig } from "../../../shared/config";
import { BoundedSeenSet } from "../dedup";
import { ConnectionSupervisor, type ConnectablePort } from "../supervisor";
import type { ChannelAdapter, IncomingMessage } from "../types";

export const FEISHU_ID = "feishu";

/** 飞书凭证（config.im.channels[feishu].config 的两个键） */
export interface FeishuCreds {
  appId: string;
  appSecret: string;
}

// ==================== ① 事件体 → 来信（纯函数）====================

export interface ParsedFeishuMessage {
  /** 回发目标：优先 chat_id（会话内回，1:1 与群都稳），缺了才回落发送者 open_id */
  target: string;
  text: string;
  /** 事件里的 message_id（去重用） */
  messageId: string;
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
 * `im.message.receive_v1` 事件体 → 一条可注入的来信；不符合条件返回 null。
 * 丢弃规则（第一版只收文本，见指令 §1.1）：
 *   ① 非 text 消息（图片/文件/富文本…）—— 第一版不收，**且绝不回一句"看不懂"骚扰用户**；
 *   ② 发送者不是真人（sender_type !== "user"）—— 机器人自己的消息进来会形成回环；
 *   ③ 内容解析不出 text / 目标标识缺失。
 */
export function parseFeishuMessageEvent(payload: unknown): ParsedFeishuMessage | null {
  const root = payload as { event?: unknown } | null;
  const event = (root?.event ?? null) as {
    sender?: { sender_type?: unknown; sender_id?: { open_id?: unknown } };
    message?: {
      message_id?: unknown;
      chat_id?: unknown;
      message_type?: unknown;
      content?: unknown;
    };
  } | null;
  const message = event?.message;
  if (!message || typeof message !== "object") return null;
  if (message.message_type !== "text") return null;
  const senderType = event?.sender?.sender_type;
  if (typeof senderType === "string" && senderType !== "user") return null;

  const content = typeof message.content === "string" ? safeJson(message.content) : null;
  const rawText = content?.text;
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text) return null;

  const chatId = typeof message.chat_id === "string" ? message.chat_id.trim() : "";
  const openId = typeof event?.sender?.sender_id?.open_id === "string"
    ? String(event.sender.sender_id.open_id).trim()
    : "";
  const target = chatId || openId;
  if (!target) return null;

  return {
    target,
    text,
    messageId: typeof message.message_id === "string" ? message.message_id : "",
  };
}

// ==================== ② 网络端口 ====================

/** 一次连接的网络端口（真机 = 官方 SDK；单测 = 假实现） */
export interface FeishuPort extends ConnectablePort {
  /** 发文本给 target（chat_id 或 open_id） */
  sendText(target: string, text: string): Promise<void>;
}

export type FeishuPortFactory = (
  creds: FeishuCreds,
  onEvent: (payload: unknown) => void,
) => FeishuPort;

/** 官方 SDK 的最小形状（**只声明我们用到的部分**；用 require 拿，避免把 SDK 的类型树拉进编译） */
interface FeishuSdkModule {
  Client: new (params: Record<string, unknown>) => {
    im: { v1: { message: { create(args: unknown): Promise<{ code?: number; msg?: string }> } } };
  };
  WSClient: new (params: Record<string, unknown>) => FeishuSdkWsClient;
  EventDispatcher: new (params: Record<string, unknown>) => {
    register(handlers: Record<string, (data: unknown) => void>): unknown;
  };
  AppType: Record<string, unknown>;
  Domain: Record<string, unknown>;
  LoggerLevel: Record<string, unknown>;
}

interface FeishuSdkWsClient {
  start(params: { eventDispatcher: unknown }): Promise<void>;
  close(params?: { force?: boolean }): void;
  getConnectionStatus?(): { state: string };
}

/** 首连就绪的等待上限：超时按失败处理（决不允许 await 挂住 registry 的启停 IPC） */
const FEISHU_READY_TIMEOUT_MS = 15000;

/**
 * 真机端口：官方 SDK 长连接。
 *
 * 关键取舍（踩坑点）：
 *   · `ws.start()` 在首连失败时**会在 SDK 内部无限重试**（autoReconnect 默认 true），
 *     所以**不能 await 它**（否则 registry 的 setEnabled IPC 永远不返回）；改为
 *     「发起 start + 等 onReady / onError / 超时」三者先到先得。
 *   · 日常掉线交给 SDK 自己的重连（onReconnecting / onReconnected 只打日志）；
 *     SDK 重试耗尽进 'failed' 态后，由 ConnectionSupervisor 兜底重建（退避）。
 */
export function createFeishuSdkPort(creds: FeishuCreds, onEvent: (payload: unknown) => void): FeishuPort {
  // 懒 require：本文件被 vitest import 时不会加载 SDK（也不触发它的网络初始化）
  const lark = require("@larksuiteoapi/node-sdk") as FeishuSdkModule;
  const http = new lark.Client({
    appId: creds.appId,
    appSecret: creds.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  });
  let ws: FeishuSdkWsClient | null = null;

  return {
    connect(): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (err?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        };
        const timer = setTimeout(
          () => finish(new Error(`飞书长连接 ${FEISHU_READY_TIMEOUT_MS}ms 内未就绪（检查网络与凭证）`)),
          FEISHU_READY_TIMEOUT_MS,
        );
        const client = new lark.WSClient({
          appId: creds.appId,
          appSecret: creds.appSecret,
          loggerLevel: lark.LoggerLevel.warn,
          onReady: () => finish(),
          onError: (err: unknown) => finish(err instanceof Error ? err : new Error(String(err))),
          onReconnecting: () => console.warn(`[im] ${FEISHU_ID} 连接断开，SDK 自动重连中…`),
          onReconnected: () => console.log(`[im] ${FEISHU_ID} 重连成功`),
        });
        ws = client;
        const dispatcher = new lark.EventDispatcher({}).register({
          "im.message.receive_v1": (data: unknown) => onEvent(data),
        });
        void client.start({ eventDispatcher: dispatcher }).catch((err: unknown) => {
          // 首连彻底失败（非重试类错误，例如凭证无效）会走到这里
          finish(err instanceof Error ? err : new Error(String(err)));
        });
      });
    },

    async sendText(target: string, text: string): Promise<void> {
      const receiveIdType = target.startsWith("ou_") ? "open_id" : "chat_id";
      const res = await http.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: { receive_id: target, msg_type: "text", content: JSON.stringify({ text }) },
      });
      if (res?.code !== 0) {
        throw new Error(`飞书发送失败：code=${res?.code ?? "?"} ${res?.msg ?? ""}`.trim());
      }
    },

    isAlive(): boolean {
      const state = ws?.getConnectionStatus?.().state;
      return state === "connected" || state === "connecting" || state === "reconnecting";
    },

    async dispose(): Promise<void> {
      const client = ws;
      ws = null;
      if (!client) return;
      try {
        client.close({ force: true });
      } catch (err) {
        console.warn(`[im] ${FEISHU_ID} 断开时出错（忽略）：`, err);
      }
    },
  };
}

// ==================== ③ 连接测试（用户按「连接测试」时跑）====================

/** 结果里的字段多，这里只声明用到的两个 */
export interface FeishuCredentialsTester {
  (creds: FeishuCreds): Promise<string>;
}

/**
 * 凭证校验：换一次 tenant_access_token（最便宜的鉴权接口），**不建长连接**。
 * 成功返回一句人话，失败抛错（错误文案给用户看）。默认走全局 fetch。
 */
export async function testFeishuCredentials(
  creds: FeishuCreds,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<string> {
  const res = await fetchImpl("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
    signal: AbortSignal.timeout(8000),
  });
  const body = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string };
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`飞书返回 code=${body.code ?? "?"}：${body.msg ?? "凭证校验失败"}`);
  }
  return "凭证有效，可以启用飞书通道";
}

// ==================== ④ 适配器 ====================

export interface FeishuChannelDeps {
  /** 端口工厂（单测注入假端口）；不传 = 官方 SDK */
  portFactory?: FeishuPortFactory;
  /** 凭证校验实现（单测注入假实现）；不传 = 真请求飞书 */
  tester?: FeishuCredentialsTester;
  baseMs?: number;
  maxMs?: number;
  healthIntervalMs?: number;
}

/** 从 config 里取凭证；缺一不可（缺了直接抛 → registry 落 state="error"） */
function readFeishuCreds(config: Record<string, string>): FeishuCreds {
  const appId = (config.appId ?? "").trim();
  const appSecret = (config.appSecret ?? "").trim();
  if (!appId || !appSecret) {
    throw new Error("飞书凭证不完整：请先填写 App ID 与 App Secret");
  }
  return { appId, appSecret };
}

export class FeishuChannel implements ChannelAdapter {
  readonly id = FEISHU_ID;
  readonly displayName = "飞书";

  private readonly listeners: Array<(msg: IncomingMessage) => void> = [];
  private readonly seen = new BoundedSeenSet();
  private supervisor: ConnectionSupervisor | null = null;
  private port: FeishuPort | null = null;

  /**
   * @param getConfig 当前落盘凭证的读取器（**调用时求值**，别在构造时缓存）
   */
  constructor(
    private readonly getConfig: () => Record<string, string>,
    private readonly deps: FeishuChannelDeps = {},
  ) {}

  async start(): Promise<void> {
    readFeishuCreds(this.getConfig()); // 缺凭证 → 立刻抛，不建端口
    const factory: FeishuPortFactory = this.deps.portFactory ?? createFeishuSdkPort;
    const supervisor = new ConnectionSupervisor(
      () => {
        const port = factory(readFeishuCreds(this.getConfig()), (payload) => this.handleEvent(payload));
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
      await this.stop(); // 启不起来的端口不能留着（SDK 内部可能还在重试）
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
    if (!port || !port.isAlive()) throw new Error("飞书通道未连接，无法发送");
    await port.sendText(target, content);
  }

  onMessage(cb: (msg: IncomingMessage) => void): void {
    this.listeners.push(cb);
  }

  /** 设置页「连接测试」：草稿与落盘值已由 registry 合并，这里只校验 */
  async testConnection(config: Record<string, string>): Promise<string> {
    return (this.deps.tester ?? testFeishuCredentials)(readFeishuCreds(sanitizeImChannelConfig(this.id, config)));
  }

  // ---------- 内部 ----------

  private handleEvent(payload: unknown): void {
    const parsed = parseFeishuMessageEvent(payload);
    if (!parsed) return;
    if (!this.seen.add(parsed.messageId)) {
      console.log(`[im] ${this.id} 重复事件已丢弃：${parsed.messageId}`);
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