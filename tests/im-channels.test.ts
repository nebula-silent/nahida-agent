// 8.9 新增：飞书 / 钉钉真实通道的单元测试。
// 依据：内部规格 §2 验收（mock WS/消息 API：验证 start 建立连接、
//       onMessage 转 IncomingMessage、sendMessage 走发送函数、断线重连退避）。
// 零 mock electron、零真实网络：端口全用假实现注入（真机端口 createFeishuSdkPort / createDingTalkSdkPort
// 里才 require 官方 SDK，本文件 import 时不加载它们）。
import { describe, expect, it } from "vitest";
import { maskSecretValue, sanitizeImChannelConfig, type ImChannelConfig } from "../src/shared/config";
import { BoundedSeenSet } from "../src/main/im/dedup";
import { nextBackoffDelay, ConnectionSupervisor, type ConnectablePort } from "../src/main/im/supervisor";
import {
  FeishuChannel, parseFeishuMessageEvent, testFeishuCredentials,
  type FeishuPort, type FeishuPortFactory,
} from "../src/main/im/channels/feishu";
import {
  DingTalkChannel, parseDingTalkRobotMessage,
  type DingTalkPort, type DingTalkPortFactory,
} from "../src/main/im/channels/dingtalk";
import { ImRegistry, type ImConfigStore, type ImSessionLike, type ImSessions } from "../src/main/im/registry";
import type { ChannelAdapter, IncomingMessage } from "../src/main/im/types";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ==================== 1. 退避 + 监督器 ====================

describe("nextBackoffDelay：指数退避 + 封顶", () => {
  it("1/2/3 次 = base、2×base、4×base", () => {
    expect(nextBackoffDelay(1, 1000, 30000)).toBe(1000);
    expect(nextBackoffDelay(2, 1000, 30000)).toBe(2000);
    expect(nextBackoffDelay(3, 1000, 30000)).toBe(4000);
  });
  it("封顶 max 不越界；非正 / 小数 attempt 一律按第 1 次算", () => {
    expect(nextBackoffDelay(10, 1000, 30000)).toBe(30000);
    expect(nextBackoffDelay(20, 1000, 30000)).toBe(30000);
    expect(nextBackoffDelay(0, 1000, 30000)).toBe(1000);
    expect(nextBackoffDelay(-5, 1000, 30000)).toBe(1000);
  });
});

class FakePort implements ConnectablePort {
  alive = true;
  disposed = false;
  connectError: Error | null = null;
  connectCalls = 0;
  async connect(): Promise<void> {
    this.connectCalls += 1;
    if (this.connectError) throw this.connectError;
  }
  isAlive(): boolean {
    return this.alive;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

describe("ConnectionSupervisor：首连抛错 / 掉线退避重建 / stop 清干净", () => {
  it("首连失败直接抛（绝不在这里无限重试，否则启停 IPC 会挂住）", async () => {
    const bad = new FakePort();
    bad.connectError = new Error("连不上");
    const sup = new ConnectionSupervisor(() => bad, { label: "t", healthIntervalMs: 5, baseMs: 5, maxMs: 10 });
    await expect(sup.start()).rejects.toThrow("连不上");
    await sup.stop();
  });

  it("首连成功挂健康轮询；端口不活了 → 旧端口 dispose + 新建端口重建", async () => {
    const ports: FakePort[] = [];
    const sup = new ConnectionSupervisor(
      () => {
        const port = new FakePort();
        ports.push(port);
        return port;
      },
      { label: "t", healthIntervalMs: 5, baseMs: 5, maxMs: 10 },
    );
    await sup.start();
    expect(ports).toHaveLength(1);

    ports[0].alive = false; // 模拟 SDK 彻底放弃连接
    await sleep(80);
    expect(ports.length).toBeGreaterThanOrEqual(2);
    expect(ports[0].disposed).toBe(true);
    expect(ports[ports.length - 1].connectCalls).toBe(1);
    await sup.stop();
  });

  it("端口一直健康 → 不重建", async () => {
    const ports: FakePort[] = [];
    const sup = new ConnectionSupervisor(
      () => {
        const port = new FakePort();
        ports.push(port);
        return port;
      },
      { label: "t", healthIntervalMs: 5, baseMs: 5, maxMs: 10 },
    );
    await sup.start();
    await sleep(60);
    expect(ports).toHaveLength(1);
    await sup.stop();
  });

  it("stop() 掐掉轮询并释放当前端口；stop 后不再重建", async () => {
    const ports: FakePort[] = [];
    const sup = new ConnectionSupervisor(
      () => {
        const port = new FakePort();
        ports.push(port);
        return port;
      },
      { label: "t", healthIntervalMs: 5, baseMs: 5, maxMs: 10 },
    );
    await sup.start();
    ports[0].alive = false;
    await sup.stop();
    expect(ports[0].disposed).toBe(true);
    await sleep(60);
    expect(ports).toHaveLength(1);
  });
});

// ==================== 2. 去重 ====================

describe("BoundedSeenSet：按 message_id 判重 + 容量封顶", () => {
  it("首见 true、重复 false", () => {
    const seen = new BoundedSeenSet(8);
    expect(seen.add("m1")).toBe(true);
    expect(seen.add("m1")).toBe(false);
    expect(seen.size).toBe(1);
  });
  it("空 id 不去重（宁可重复也不丢消息）", () => {
    const seen = new BoundedSeenSet(8);
    expect(seen.add("")).toBe(true);
    expect(seen.add("")).toBe(true);
    expect(seen.size).toBe(0);
  });
  it("超出容量按 FIFO 淘汰最旧的（被淘汰的 id 再次出现算新消息）", () => {
    const seen = new BoundedSeenSet(2);
    expect(seen.add("a")).toBe(true);
    expect(seen.add("b")).toBe(true);
    expect(seen.add("c")).toBe(true); // 挤掉 a
    expect(seen.size).toBe(2);
    expect(seen.add("b")).toBe(false);
    expect(seen.add("a")).toBe(true); // a 已被淘汰 → 当新的
  });
});

// ==================== 3. 飞书：事件解析 ====================

/** 一条合规的 im.message.receive_v1 事件体 */
function feishuEvent(over: Record<string, unknown> = {}): unknown {
  return {
    header: { event_type: "im.message.receive_v1" },
    event: {
      sender: { sender_type: "user", sender_id: { open_id: "ou_sender" } },
      message: {
        message_id: "om_1",
        chat_id: "oc_chat",
        message_type: "text",
        content: JSON.stringify({ text: "  你好，帮我看下安排  " }),
        ...(over.message as Record<string, unknown> | undefined),
      },
      ...(over.event as Record<string, unknown> | undefined),
    },
  };
}

describe("parseFeishuMessageEvent：事件体 → 来信", () => {
  it("文本消息 → target 取 chat_id、text 去首尾空白、带 message_id", () => {
    expect(parseFeishuMessageEvent(feishuEvent())).toEqual({
      target: "oc_chat", text: "你好，帮我看下安排", messageId: "om_1",
    });
  });

  it("没有 chat_id（1:1 场景）→ target 回落发送者 open_id", () => {
    const ev = {
      event: {
        sender: { sender_type: "user", sender_id: { open_id: "ou_sender" } },
        message: { message_id: "om_2", message_type: "text", content: JSON.stringify({ text: "hi" }) },
      },
    };
    expect(parseFeishuMessageEvent(ev)?.target).toBe("ou_sender");
  });

  it("非 text 消息一律丢弃（图片 / 文件 / 富文本）—— 且不产生任何回复", () => {
    const ev = feishuEvent({ message: { message_id: "om_3", chat_id: "oc_chat", message_type: "image", content: "{}" } });
    expect(parseFeishuMessageEvent(ev)).toBeNull();
  });

  it("发送者不是真人（sender_type=bot）→ 丢弃（防机器人回环）", () => {
    const ev = feishuEvent({
      event: { sender: { sender_type: "app", sender_id: { open_id: "ou_bot" } } },
    });
    expect(parseFeishuMessageEvent(ev)).toBeNull();
  });

  it("内容为空 / content 不是合法 JSON / 结构完全不对 → 丢弃且不抛", () => {
    expect(parseFeishuMessageEvent(feishuEvent({ message: { message_id: "m", chat_id: "c", message_type: "text", content: JSON.stringify({ text: "   " }) } }))).toBeNull();
    expect(parseFeishuMessageEvent(feishuEvent({ message: { message_id: "m", chat_id: "c", message_type: "text", content: "not-json" } }))).toBeNull();
    expect(parseFeishuMessageEvent(null)).toBeNull();
    expect(parseFeishuMessageEvent("garbage")).toBeNull();
  });
});

describe("testFeishuCredentials：换 token 校验凭证（不建长连接）", () => {
  it("code=0 → 返回人话", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ code: 0, tenant_access_token: "t-1" }))) as unknown as typeof fetch;
    await expect(testFeishuCredentials({ appId: "cli", appSecret: "s" }, fakeFetch)).resolves.toContain("凭证有效");
  });
  it("code≠0 → 抛错并带上飞书返回的 msg", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ code: 10003, msg: "invalid app_secret" }))) as unknown as typeof fetch;
    await expect(testFeishuCredentials({ appId: "cli", appSecret: "bad" }, fakeFetch)).rejects.toThrow(/invalid app_secret/);
  });
});

// ==================== 4. 飞书通道 ====================

class FakeFeishuPort implements FeishuPort {
  alive = true;
  disposed = false;
  connectError: Error | null = null;
  readonly sent: Array<{ target: string; text: string }> = [];
  constructor(readonly onEvent: (payload: unknown) => void) {}
  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
  }
  isAlive(): boolean {
    return this.alive;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
  async sendText(target: string, text: string): Promise<void> {
    this.sent.push({ target, text });
  }
}

function feishuSetup(creds: Record<string, string> = { appId: "cli_app", appSecret: "secret" }): {
  channel: FeishuChannel; ports: FakeFeishuPort[]; got: IncomingMessage[];
} {
  const ports: FakeFeishuPort[] = [];
  const got: IncomingMessage[] = [];
  const factory: FeishuPortFactory = (_c, onEvent) => {
    const port = new FakeFeishuPort(onEvent);
    ports.push(port);
    return port;
  };
  const channel = new FeishuChannel(() => creds, { portFactory: factory, healthIntervalMs: 100000 });
  channel.onMessage((m) => got.push(m));
  return { channel, ports, got };
}

describe("FeishuChannel：连接 / 收事件 / 发消息", () => {
  it("缺凭证 → start 立刻抛，且不建端口（registry 会落 state=error）", async () => {
    const { channel, ports } = feishuSetup({});
    await expect(channel.start()).rejects.toThrow(/凭证不完整/);
    expect(ports).toHaveLength(0);
  });

  it("start() 建立连接；事件体 → IncomingMessage（channelId=feishu）", async () => {
    const { channel, ports, got } = feishuSetup();
    await channel.start();
    expect(ports).toHaveLength(1);

    ports[0].onEvent(feishuEvent());
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ channelId: "feishu", target: "oc_chat", text: "你好，帮我看下安排" });
    expect(got[0].loopback).toBeUndefined();
    await channel.stop();
  });

  it("同一条事件重放（message_id 相同）只进一条来信 —— 断线重连不重复回复", async () => {
    const { channel, ports, got } = feishuSetup();
    await channel.start();
    ports[0].onEvent(feishuEvent());
    ports[0].onEvent(feishuEvent());
    expect(got).toHaveLength(1);
    await channel.stop();
  });

  it("sendMessage 走端口的 sendText（target = chat_id / open_id）", async () => {
    const { channel, ports } = feishuSetup();
    await channel.start();
    await channel.sendMessage("oc_chat", "收到，这就看");
    expect(ports[0].sent).toEqual([{ target: "oc_chat", text: "收到，这就看" }]);
    await channel.stop();
  });

  it("连接已死 / 未连接时发送 → 抛错（不静默丢回复）", async () => {
    const { channel, ports } = feishuSetup();
    await channel.start();
    ports[0].alive = false;
    await expect(channel.sendMessage("oc_chat", "x")).rejects.toThrow(/未连接/);
    await channel.stop();
  });

  it("start 失败 → 自动 stop 释放端口后把错抛出（不留后台重试）", async () => {
    const ports: FakeFeishuPort[] = [];
    const channel = new FeishuChannel(() => ({ appId: "a", appSecret: "b" }), {
      portFactory: (_c, onEvent) => {
        const port = new FakeFeishuPort(onEvent);
        port.connectError = new Error("握手失败");
        ports.push(port);
        return port;
      },
      healthIntervalMs: 100000,
    });
    await expect(channel.start()).rejects.toThrow("握手失败");
    expect(ports[0].disposed).toBe(true);
  });

  it("testConnection：走注入的 tester；缺凭证抛错", async () => {
    const seen: Array<{ appId: string; appSecret: string }> = [];
    const channel = new FeishuChannel(() => ({}), {
      tester: async (creds) => {
        seen.push(creds);
        return "凭证有效";
      },
    });
    await expect(channel.testConnection({ appId: "cli", appSecret: "s", junk: "x" }))
      .resolves.toBe("凭证有效");
    expect(seen).toEqual([{ appId: "cli", appSecret: "s" }]); // junk 被白名单丢掉
    await expect(channel.testConnection({ appId: "cli" })).rejects.toThrow(/凭证不完整/);
  });
});

// ==================== 5. 钉钉：消息解析 + 通道 ====================

function dingFrame(over: Record<string, unknown> = {}): unknown {
  return {
    headers: { topic: "/v1.0/im/bot/messages/get" },
    data: JSON.stringify({
      msgtype: "text",
      text: { content: " 你好 " },
      conversationId: "cid_1",
      conversationType: "1",
      msgId: "msg_1",
      senderStaffId: "staff_1",
      sessionWebhook: "https://oapi.dingtalk.com/robot/sendBySession?session=abc",
      sessionWebhookExpiredTime: Date.now() + 3600_000,
      ...over,
    }),
  };
}

describe("parseDingTalkRobotMessage：Stream 帧 → 来信", () => {
  it("文本消息 → target 取 conversationId、带 message_id 与回复地址", () => {
    const parsed = parseDingTalkRobotMessage((dingFrame() as { data: string }).data);
    expect(parsed).toMatchObject({
      target: "cid_1", text: "你好", messageId: "msg_1",
      webhook: "https://oapi.dingtalk.com/robot/sendBySession?session=abc",
    });
    expect(parsed!.webhookExpireAt).toBeGreaterThan(Date.now());
  });

  it("已解析对象也能吃（SDK 可能直接给 data 字符串，两种都兼容）", () => {
    const parsed = parseDingTalkRobotMessage(JSON.parse((dingFrame() as { data: string }).data));
    expect(parsed?.text).toBe("你好");
  });

  it("非 text / 空内容 / 无 conversationId / 坏 JSON → 一律丢弃且不抛", () => {
    expect(parseDingTalkRobotMessage(JSON.stringify({ msgtype: "picture", conversationId: "c" }))).toBeNull();
    expect(parseDingTalkRobotMessage(JSON.stringify({ msgtype: "text", text: { content: "  " }, conversationId: "c" }))).toBeNull();
    expect(parseDingTalkRobotMessage(JSON.stringify({ msgtype: "text", text: { content: "hi" } }))).toBeNull();
    expect(parseDingTalkRobotMessage("{not json")).toBeNull();
    expect(parseDingTalkRobotMessage(null)).toBeNull();
  });
});

class FakeDingTalkPort implements DingTalkPort {
  alive = true;
  disposed = false;
  connectError: Error | null = null;
  readonly posted: Array<{ url: string; text: string }> = [];
  constructor(readonly onFrame: (frame: unknown) => void) {}
  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
  }
  isAlive(): boolean {
    return this.alive;
  }
  async dispose(): Promise<void> {
    this.disposed = true;
  }
  async postWebhook(webhookUrl: string, text: string): Promise<void> {
    this.posted.push({ url: webhookUrl, text });
  }
}

function dingSetup(): { channel: DingTalkChannel; ports: FakeDingTalkPort[]; got: IncomingMessage[] } {
  const ports: FakeDingTalkPort[] = [];
  const got: IncomingMessage[] = [];
  const factory: DingTalkPortFactory = (_c, onFrame) => {
    const port = new FakeDingTalkPort(onFrame);
    ports.push(port);
    return port;
  };
  const channel = new DingTalkChannel(() => ({ clientId: "id", clientSecret: "sec" }), {
    portFactory: factory, healthIntervalMs: 100000,
  });
  channel.onMessage((m) => got.push(m));
  return { channel, ports, got };
}

describe("DingTalkChannel：连接 / 收帧 / 走 webhook 回发", () => {
  it("缺凭证 → start 抛错且不建端口", async () => {
    const ports: FakeDingTalkPort[] = [];
    const channel = new DingTalkChannel(() => ({}), {
      portFactory: (_c, onFrame) => {
        const port = new FakeDingTalkPort(onFrame);
        ports.push(port);
        return port;
      },
    });
    await expect(channel.start()).rejects.toThrow(/凭证不完整/);
    expect(ports).toHaveLength(0);
  });

  it("帧回调 → IncomingMessage（channelId=dingtalk），重复 msgId 只进一条", async () => {
    const { channel, ports, got } = dingSetup();
    await channel.start();
    ports[0].onFrame(dingFrame());
    ports[0].onFrame(dingFrame());
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ channelId: "dingtalk", target: "cid_1", text: "你好" });
    await channel.stop();
  });

  it("回复走来信自带的 sessionWebhook（Stream 模式唯一出口）", async () => {
    const { channel, ports } = dingSetup();
    await channel.start();
    ports[0].onFrame(dingFrame());
    await channel.sendMessage("cid_1", "收到");
    expect(ports[0].posted).toEqual([{
      url: "https://oapi.dingtalk.com/robot/sendBySession?session=abc", text: "收到",
    }]);
    await channel.stop();
  });

  it("该会话还没发过消息（地址未知）→ 抛错并说明原因", async () => {
    const { channel } = dingSetup();
    await channel.start();
    await expect(channel.sendMessage("cid_unknown", "x")).rejects.toThrow(/地址未知/);
    await channel.stop();
  });

  it("webhook 已过期 → 抛错提示让用户再发一条", async () => {
    const { channel, ports } = dingSetup();
    await channel.start();
    ports[0].onFrame(dingFrame({ sessionWebhookExpiredTime: Date.now() - 1000 }));
    await expect(channel.sendMessage("cid_1", "x")).rejects.toThrow(/已过期/);
    await channel.stop();
  });

  it("连接已死 → 发送抛错", async () => {
    const { channel, ports } = dingSetup();
    await channel.start();
    ports[0].onFrame(dingFrame());
    ports[0].alive = false;
    await expect(channel.sendMessage("cid_1", "x")).rejects.toThrow(/未连接/);
    await channel.stop();
  });
});

// ==================== 6. registry：凭证写入 / 连接测试 ====================

class FakeSessions implements ImSessions {
  private readonly map = new Map<string, ImSessionLike>();
  create(): ImSessionLike {
    const id = `s${this.map.size + 1}`;
    const session: ImSessionLike = { id, title: "新会话", messages: [], activeLeafId: null };
    this.map.set(id, session);
    return session;
  }
  get(id: string): ImSessionLike | null {
    return this.map.get(id) ?? null;
  }
  append(): ImSessionLike | null {
    return null;
  }
}

class FakeConfigStore implements ImConfigStore {
  writes = 0;
  constructor(public channels: ImChannelConfig[] = []) {}
  readChannels(): ImChannelConfig[] {
    return this.channels;
  }
  writeChannels(next: ImChannelConfig[]): void {
    this.channels = next;
    this.writes += 1;
  }
}

/** 真通道的假替身：只记 start/stop 次数。**不含 testConnection**（= 不支持连接测试的通道） */
class FakeRealChannel implements ChannelAdapter {
  readonly id: string;
  readonly displayName: string;
  started = 0;
  stopped = 0;
  constructor(id: string) {
    this.id = id;
    this.displayName = id === "feishu" ? "飞书" : id;
  }
  async start(): Promise<void> {
    this.started += 1;
  }
  async stop(): Promise<void> {
    this.stopped += 1;
  }
  async sendMessage(): Promise<void> {}
  onMessage(): void {}
}

/** 带连接测试能力的版本（飞书走这个） */
class FakeTestableChannel extends FakeRealChannel {
  readonly testCalls: Array<Record<string, string>> = [];
  testError: Error | null = null;
  async testConnection(config: Record<string, string>): Promise<string> {
    this.testCalls.push(config);
    if (this.testError) throw this.testError;
    return "凭证有效，可以启用飞书通道";
  }
}

function regHarness(adapters: ChannelAdapter[]): { registry: ImRegistry; config: FakeConfigStore; views: () => ReturnType<ImRegistry["listViews"]> } {
  const config = new FakeConfigStore();
  const registry = new ImRegistry({
    adapters, sessions: new FakeSessions(), config,
    chat: async () => "ok",
  });
  return { registry, config, views: () => registry.listViews() };
}

describe("ImRegistry.setChannelConfig：白名单 + 掩码视为未改动 + 运行中重启", () => {
  it("未登记通道 / 未登记键一律丢弃（IPC 输入不可信）", async () => {
    const feishu = new FakeTestableChannel("feishu");
    const { registry, config } = regHarness([feishu]);
    await registry.setChannelConfig("nope", { appId: "x" });
    await registry.setChannelConfig("feishu", { appId: "cli_a", root: "hacked", appSecret: "s1" });
    const stored = config.channels.find((c) => c.id === "feishu")!;
    expect(stored.config).toEqual({ appId: "cli_a", appSecret: "s1" }); // root 被丢
  });

  it("密钥只出掩码；把掩码原样回传当 = 未改动（不写盘、不重启）", async () => {
    const feishu = new FakeTestableChannel("feishu");
    const { registry, config } = regHarness([feishu]);
    await registry.setChannelConfig("feishu", { appId: "cli_a", appSecret: "supersecret" });
    const masked = maskSecretValue("supersecret");
    expect(registry.listViews()[0].configMasked).toEqual({ appId: "cli_a", appSecret: masked });

    const writes = config.writes;
    await registry.setChannelConfig("feishu", { appId: "cli_a", appSecret: masked });
    expect(config.writes).toBe(writes); // 一个字节都没改 → 不写盘
    expect(feishu.stopped).toBe(0); // 也没重启
    expect(config.channels.find((c) => c.id === "feishu")!.config.appSecret).toBe("supersecret");
  });

  it("空串 = 真的清空该字段", async () => {
    const feishu = new FakeTestableChannel("feishu");
    const { registry, config } = regHarness([feishu]);
    await registry.setChannelConfig("feishu", { appId: "cli_a", appSecret: "s" });
    await registry.setChannelConfig("feishu", { appSecret: "" });
    expect(config.channels.find((c) => c.id === "feishu")!.config.appSecret).toBe("");
  });

  it("正在运行的通道改凭证 → stop 后用新凭证重新 start", async () => {
    const feishu = new FakeTestableChannel("feishu");
    const { registry } = regHarness([feishu]);
    await registry.setEnabled("feishu", true);
    await registry.settle(); // setEnabled 不等握手，等后台启停落定再断言
    expect(feishu.started).toBe(1);

    await registry.setChannelConfig("feishu", { appId: "cli_new" });
    expect(feishu.stopped).toBe(1);
    expect(feishu.started).toBe(2);
    expect(registry.listViews()[0].state).toBe("running");
  });

  it("canTest 跟着适配器能力走（没实现 testConnection = false）", () => {
    const { registry } = regHarness([new FakeRealChannel("dingtalk")]);
    expect(registry.listViews()[0].canTest).toBe(false);
  });

  it("构造时**不读盘**，首次真正用到才读（真机坑：构造发生在 app ready 之前，那时 safeStorage 不可用，读盘会把 IM 密钥读成空串 → 界面掩码为空 + 后续 persist 把凭证抹掉）", () => {
    const stored: ImChannelConfig[] = [{
      id: "feishu", enabled: false, sessionId: "", state: "stopped",
      config: { appId: "cli_a", appSecret: "s3cr3t" },
    }];
    let reads = 0;
    const spy: ImConfigStore = {
      readChannels: () => {
        reads += 1;
        return stored;
      },
      writeChannels: () => {},
    };
    const registry = new ImRegistry({
      adapters: [new FakeTestableChannel("feishu")],
      sessions: new FakeSessions(),
      config: spy,
      chat: async () => "ok",
    });
    expect(reads).toBe(0); // 构造零读盘
    expect(registry.listViews()[0].configMasked.appSecret).toBe(maskSecretValue("s3cr3t")); // 用到时才读，且密钥只出掩码
    expect(reads).toBe(1);
  });
});

describe("ImRegistry.testConnection：草稿 + 已落盘值合并后试连，绝不抛", () => {
  it("草稿只改一半 → 另一半用已落盘值补齐", async () => {
    const feishu = new FakeTestableChannel("feishu");
    const { registry } = regHarness([feishu]);
    await registry.setChannelConfig("feishu", { appId: "cli_a", appSecret: "stored_secret" });
    const res = await registry.testConnection("feishu", { appId: "cli_b" });
    expect(res.ok).toBe(true);
    expect(feishu.testCalls[0]).toEqual({ appId: "cli_b", appSecret: "stored_secret" });
  });

  it("掩码回传同样视为未改动（不会拿掩码去试连）", async () => {
    const feishu = new FakeTestableChannel("feishu");
    const { registry } = regHarness([feishu]);
    await registry.setChannelConfig("feishu", { appId: "cli_a", appSecret: "stored_secret" });
    await registry.testConnection("feishu", { appId: "cli_a", appSecret: maskSecretValue("stored_secret") });
    expect(feishu.testCalls[0].appSecret).toBe("stored_secret");
  });

  it("适配器抛错 → {ok:false} 带上错误文案（不把 IPC 炸掉）", async () => {
    const feishu = new FakeTestableChannel("feishu");
    feishu.testError = new Error("飞书返回 code=10003：invalid app_secret");
    const { registry } = regHarness([feishu]);
    const res = await registry.testConnection("feishu", { appId: "a", appSecret: "b" });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("invalid app_secret");
  });

  it("不支持连接测试的通道 / 未知通道 → {ok:false} 人话", async () => {
    const ding = new FakeRealChannel("dingtalk");
    const { registry } = regHarness([ding]);
    expect(await registry.testConnection("dingtalk", {})).toEqual({ ok: false, message: "该通道不支持连接测试" });
    expect(await registry.testConnection("nope", {})).toEqual({ ok: false, message: "未知通道：nope" });
  });
});

// ==================== 7. 契约层：凭证消毒 ====================

describe("sanitizeImChannelConfig：逐键白名单 + 只收字符串 + 长度上限", () => {
  it("未登记通道一律空对象；非敏感字段 trim、密钥字段原样", () => {
    expect(sanitizeImChannelConfig("nope", { appId: "x" })).toEqual({});
    expect(sanitizeImChannelConfig("feishu", { appId: "  cli_a  ", appSecret: "  s  " }))
      .toEqual({ appId: "cli_a", appSecret: "  s  " });
  });
  it("非字符串值丢掉；空串保留（语义 = 清空）", () => {
    expect(sanitizeImChannelConfig("dingtalk", { clientId: 123, clientSecret: "", other: "x" }))
      .toEqual({ clientSecret: "" });
  });
  it("超长值截断到上限", () => {
    const long = "a".repeat(1000);
    expect(sanitizeImChannelConfig("feishu", { appSecret: long }).appSecret).toHaveLength(512);
  });
});
describe("ImRegistry 启停幂等 + 串行（8.10 真机连点竞态：点不开 / 双拉长轮询 / 已停止）", () => {
  it("已在跑的通道再 start → 不重复 start（连点两次 true 只拉一条连接）", async () => {
    const feishu = new FakeRealChannel("feishu");
    const { registry } = regHarness([feishu]);
    await registry.setEnabled("feishu", true);
    await registry.setEnabled("feishu", true); // 连点：回包前方向读旧值，又发了一次 true
    await registry.settle();
    expect(feishu.started).toBe(1);
    expect(registry.listViews()[0].state).toBe("running");
  });

  it("没在跑的通道 stop → 不调 adapter.stop，state 落 stopped", async () => {
    const feishu = new FakeRealChannel("feishu");
    const { registry } = regHarness([feishu]);
    await registry.setEnabled("feishu", false); // 从没启动过
    await registry.settle();
    expect(feishu.stopped).toBe(0);
    expect(registry.listViews()[0].state).toBe("stopped");
  });

  it("on→off→on 快速连点并发到达：串行落定，最终 started=2 / stopped=1 / running", async () => {
    const feishu = new FakeRealChannel("feishu");
    const { registry } = regHarness([feishu]);
    await Promise.all([
      registry.setEnabled("feishu", true),
      registry.setEnabled("feishu", false),
      registry.setEnabled("feishu", true),
    ]);
    await registry.settle();
    expect(feishu.started).toBe(2);
    expect(feishu.stopped).toBe(1);
    const view = registry.listViews()[0];
    expect(view.enabled).toBe(true);
    expect(view.state).toBe("running");
  });
});
