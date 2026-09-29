// 8.8 IM 通道架构：注册表 + echo 闭环单测。
// 依据：内部规格 §2 验收（注册 echo → 模拟收消息 → 断言进入绑定会话 →
//       reply 走 sendMessage 回吐，路由正确）。
// 惯例照 tests/tidy-runner.test.ts：零 mock electron（registry 顶层不依赖 electron，IPC 注册函数体内才 require），
// 会话存储 / 配置存储 / runChat 全部注入假实现 —— 不碰真实 userData、不联任何外部服务。
import { describe, expect, it } from "vitest";
import type { ChatMessage, MessageNode } from "../src/shared/chat";
import { sanitizeImChannels, type ImChannelConfig } from "../src/shared/config";
import { EchoChannel } from "../src/main/im/channels/echo";
import { buildImPrefix, withImPrefix } from "../src/main/im/prompt";
import {
  ImRegistry,
  type ImConfigStore,
  type ImSessionLike,
  type ImSessions,
} from "../src/main/im/registry";
import type { ChannelAdapter, IncomingMessage, ImSource } from "../src/main/im/types";

// ==================== 假夹具 ====================

/** 假会话存储：仿 chats-store 的「线性追加 + activeLeafId 跟尾」语义，够 resolvePath 走通 */
class FakeSessions implements ImSessions {
  readonly map = new Map<string, ImSessionLike>();
  /** 8.10.2：clearSession 单测 —— 记录 delete 收到的 id（没删过 = 空数组） */
  readonly deletedIds: string[] = [];
  private sessionSeq = 0;
  private nodeSeq = 0;

  create(initialMessages: ChatMessage[] = []): ImSessionLike {
    this.sessionSeq += 1;
    const id = `s${this.sessionSeq}`;
    this.map.set(id, { id, title: "新会话", messages: [], activeLeafId: null });
    for (const m of initialMessages) this.append(id, m);
    return this.map.get(id)!;
  }

  get(id: string): ImSessionLike | null {
    return this.map.get(id) ?? null;
  }

  append(id: string, message: ChatMessage): ImSessionLike | null {
    const session = this.map.get(id);
    if (!session) return null;
    this.nodeSeq += 1;
    const node: MessageNode = {
      id: `n${this.nodeSeq}`,
      parentId: session.activeLeafId,
      childrenIds: [],
      role: message.role,
      content: message.content,
      at: this.nodeSeq,
    };
    session.messages.push(node);
    session.activeLeafId = node.id;
    // 标题跟首条来信走（真机 chats-store 的 create 用首条消息当标题，这里只在首条时补）
    if (message.role === "user" && session.messages.length === 1) session.title = message.content;
    return session;
  }

  /** 8.10.2：可选方法 —— 真 chats-store.deleteSession 的假身：真删到了才 true */
  delete(id: string): boolean {
    this.deletedIds.push(id);
    return this.map.delete(id);
  }
}

class FakeConfig implements ImConfigStore {
  channels: ImChannelConfig[];
  writes = 0;
  constructor(channels: ImChannelConfig[] = []) {
    this.channels = channels;
  }
  readChannels(): ImChannelConfig[] {
    return this.channels;
  }
  writeChannels(next: ImChannelConfig[]): void {
    this.channels = next;
    this.writes += 1;
  }
}

interface Harness {
  echo: EchoChannel;
  sessions: FakeSessions;
  config: FakeConfig;
  calls: Array<{ messages: ChatMessage[]; source: ImSource }>;
  loopbacks: IncomingMessage[];
  registry: ImRegistry;
}

/** 组装一套真 registry + 假依赖；reply 固定返回一段文本 */
function harness(reply = "好的，收到。"): Harness {
  const echo = new EchoChannel();
  const sessions = new FakeSessions();
  const config = new FakeConfig();
  const calls: Harness["calls"] = [];
  const loopbacks: IncomingMessage[] = [];
  echo.onMessage((msg) => { if (msg.loopback) loopbacks.push(msg); });
  const registry = new ImRegistry({
    adapters: [echo],
    sessions,
    config,
    chat: async (messages, source) => {
      calls.push({ messages, source });
      return reply;
    },
  });
  return { echo, sessions, config, calls, loopbacks, registry };
}

/** 推进微/宏任务：registry 的收信链路是 fire-and-forget 的串行链，测试需等它跑完 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

// ==================== 用例 ====================

describe("ImRegistry：注册与状态总览", () => {
  it("注册 echo 后 listViews 出一条，初始 stopped / enabled=false / 无绑定会话", () => {
    const h = harness();
    expect(h.registry.listViews()).toEqual([
      {
        id: "echo", displayName: "echo 自检通道", enabled: false, state: "stopped",
        sessionId: "", sessionTitle: "",
        configMasked: {}, canTest: false, // 8.9：无凭证规格 → 空掩码投影；未实现 testConnection → false
      },
    ]);
  });

  it("setEnabled(true) → 真 start() 到 running 并落盘；再关 → stopped 并落盘（IPC 立即回，等 settle 拿终态）", async () => {
    const h = harness();
    await h.registry.setEnabled("echo", true);
    await h.registry.settle();
    const on = h.registry.listViews();
    expect(on[0]).toMatchObject({ enabled: true, state: "running" });
    expect(h.echo.isRunning()).toBe(true);
    expect(h.config.channels[0]).toMatchObject({ id: "echo", enabled: true, state: "running" });

    await h.registry.setEnabled("echo", false);
    await h.registry.settle();
    const off = h.registry.listViews();
    expect(off[0]).toMatchObject({ enabled: false, state: "stopped" });
    expect(h.echo.isRunning()).toBe(false);
    expect(h.config.channels[0]).toMatchObject({ enabled: false, state: "stopped" });
  });

  it("构造时落盘的 running 快照回落 stopped（进程刚起不可能还在跑），且不立刻写盘", () => {
    const config = new FakeConfig([{ id: "echo", enabled: true, sessionId: "", state: "running", config: {} }]);
    const registry = new ImRegistry({ adapters: [new EchoChannel()], sessions: new FakeSessions(), config, chat: async () => "x" });
    expect(registry.listViews()[0]).toMatchObject({ enabled: true, state: "stopped" });
    expect(config.writes).toBe(0);
  });

  it("保留未注册 id 的落盘条目（8.9 写入的 feishu 条目不被本步保存动作抹掉）", async () => {
    const config = new FakeConfig([{ id: "feishu", enabled: true, sessionId: "s9", state: "stopped", config: { appId: "a" } }]);
    const registry = new ImRegistry({ adapters: [new EchoChannel()], sessions: new FakeSessions(), config, chat: async () => "x" });
    await registry.setEnabled("echo", true);
    await registry.settle();
    expect(config.channels.map((c) => c.id).sort()).toEqual(["echo", "feishu"]);
    expect(config.channels.find((c) => c.id === "feishu")).toMatchObject({ sessionId: "s9", config: { appId: "a" } });
  });
});

describe("echo 闭环：来信 → 独立会话 → 回复原路发回", () => {
  it("启用后收一条来信：建立独立会话、回复落会话、并按 target 回吐", async () => {
    const h = harness("我的回复");
    await h.registry.setEnabled("echo", true);
    await h.registry.settle();

    h.echo.receive("u-open-id-1", "帮我看下今天的安排");
    await flush();

    // ① 独立会话已建立并绑定；标题跟首条来信
    const view = h.registry.listViews()[0];
    expect(view.sessionId).not.toBe("");
    expect(view.sessionTitle).toBe("帮我看下今天的安排");
    const session = h.sessions.get(view.sessionId)!;
    expect(session.messages.map((n) => [n.role, n.content])).toEqual([
      ["user", "帮我看下今天的安排"],
      ["assistant", "我的回复"],
    ]);

    // ② runChat 收到的是「该会话可见路径」+ 来源标记
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].source).toEqual({ channelId: "echo", target: "u-open-id-1" });
    expect(h.calls[0].messages).toEqual([{ role: "user", content: "帮我看下今天的安排" }]);

    // ③ 回复按会话绑定的通道 + 该 target 原路发回（echo 的出口 = loopback 回吐）
    expect(h.loopbacks).toEqual([
      expect.objectContaining({ channelId: "echo", target: "u-open-id-1", text: "我的回复", loopback: true }),
    ]);
  });

  it("loopback 只记日志、不当新来信：绝不递归触发第二轮 runChat", async () => {
    const h = harness("只回一次");
    await h.registry.setEnabled("echo", true);
    await h.registry.settle();
    h.echo.receive("u1", "在吗");
    await flush();
    // 回吐被桥接层跳过 → runChat 仍只跑了一次（自激防护）
    expect(h.loopbacks).toHaveLength(1);
    expect(h.calls).toHaveLength(1);
    expect(h.sessions.map.size).toBe(1);
  });

  it("第二条来信追加进同一会话（不新建、不串到主会话）", async () => {
    const h = harness("嗯");
    await h.registry.setEnabled("echo", true);
    await h.registry.settle();

    h.echo.receive("u1", "第一条");
    await flush();
    h.echo.receive("u1", "第二条");
    await flush();

    expect(h.sessions.map.size).toBe(1);
    const view = h.registry.listViews()[0];
    const session = h.sessions.get(view.sessionId)!;
    expect(session.messages.map((n) => [n.role, n.content])).toEqual([
      ["user", "第一条"],
      ["assistant", "嗯"],
      ["user", "第二条"],
      ["assistant", "嗯"],
    ]);
    // 第二轮上下文带着前面的历史（可见路径全量）
    expect(h.calls[1].messages.map((m) => m.content)).toEqual(["第一条", "嗯", "第二条"]);
  });

  it("未启用时来信被丢弃：不建会话、不跑 runChat", async () => {
    const h = harness();
    h.echo.receive("u1", "没人听");
    await flush();
    expect(h.sessions.map.size).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(h.loopbacks).toHaveLength(0);
  });

  it("start 期间到达的来信不丢（8.10 ③b 启动竞态）：startOne 先标记 running 再 start", async () => {
    // 复刻 weixin 就绪探针的时序：start() 内部同步吐出来信（服务端暂存补投），
    // 之后 start 的 promise 才 resolve —— 旧实现要等 start 完才标记 running，这条信就被丢了
    const sessions = new FakeSessions();
    const config = new FakeConfig();
    const sent: Array<{ target: string; content: string }> = [];
    let onMessageCb: ((msg: IncomingMessage) => void) | null = null;
    const early: ChannelAdapter = {
      id: "early",
      displayName: "启动期来信通道",
      start(): Promise<void> {
        onMessageCb?.({ channelId: "early", target: "u1", text: "启动首条", receivedAt: Date.now() });
        return new Promise((r) => setTimeout(r, 0));
      },
      async stop(): Promise<void> {},
      async sendMessage(target: string, content: string): Promise<void> {
        sent.push({ target, content });
      },
      onMessage(cb: (msg: IncomingMessage) => void): void {
        onMessageCb = cb;
      },
    };
    const registry = new ImRegistry({ adapters: [early], sessions, config, chat: async () => "启动期回复" });
    await registry.setEnabled("early", true);
    await registry.settle(); // 启停落定（start() 内同步吐的来信才会被处理）
    await flush();

    // 来信进了独立会话、runChat 跑了、回复原路发出 —— 而不是被「未运行」丢掉
    const view = registry.listViews()[0];
    expect(view).toMatchObject({ enabled: true, state: "running" });
    expect(view.sessionTitle).toBe("启动首条");
    const session = sessions.get(view.sessionId)!;
    expect(session.messages.map((n) => [n.role, n.content])).toEqual([
      ["user", "启动首条"],
      ["assistant", "启动期回复"],
    ]);
    expect(sent).toEqual([{ target: "u1", content: "启动期回复" }]);
  });

  it("模型返回空回复：不落 assistant、不发空消息", async () => {
    const h = harness("   ");
    await h.registry.setEnabled("echo", true);
    await h.registry.settle();
    h.echo.receive("u1", "在吗");
    await flush();
    const view = h.registry.listViews()[0];
    const session = h.sessions.get(view.sessionId)!;
    expect(session.messages.map((n) => n.role)).toEqual(["user"]);
    expect(h.loopbacks).toHaveLength(0);
  });

  it("runChat 抛错：本轮不发回复，来信仍留在会话里", async () => {
    const sessions = new FakeSessions();
    const config = new FakeConfig();
    const echo = new EchoChannel();
    const registry = new ImRegistry({
      adapters: [echo], sessions, config,
      chat: async () => { throw new Error("模型挂了"); },
    });
    await registry.setEnabled("echo", true);
    await registry.settle();
    echo.receive("u1", "会失败");
    await flush();
    const session = sessions.get(registry.listViews()[0].sessionId)!;
    expect(session.messages.map((n) => n.role)).toEqual(["user"]);
  });

  it("inject 只对实现了 receive 的假适配器生效，未知通道返回 false", async () => {
    const h = harness();
    await h.registry.setEnabled("echo", true);
    await h.registry.settle();
    expect(h.registry.inject("echo", "u1", "自检来信")).toBe(true);
    await flush();
    expect(h.calls).toHaveLength(1);
    expect(h.registry.inject("feishu", "u1", "无此通道")).toBe(false);
  });

  it("stopAll 停掉在跑的通道并落盘 stopped", async () => {
    const h = harness();
    await h.registry.setEnabled("echo", true);
    await h.registry.settle();
    await h.registry.stopAll();
    expect(h.echo.isRunning()).toBe(false);
    expect(h.config.channels[0]).toMatchObject({ state: "stopped" });
  });
});

describe("IM 来源 system 前缀（runChat 注入用）", () => {
  it("已知通道给中文名，未知通道回落到 id", () => {
    expect(buildImPrefix({ channelId: "feishu", target: "ou_x" })).toContain("飞书");
    expect(buildImPrefix({ channelId: "weixin", target: "wxid_x" })).toContain("微信");
    expect(buildImPrefix({ channelId: "custom", target: "u" })).toContain("custom");
    expect(buildImPrefix({ channelId: "echo", target: "tester" })).toContain("tester");
  });

  it("withImPrefix 前缀为空时返回原数组引用（与好感度/心情/表情同款短路）", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "你好" }];
    expect(withImPrefix(messages, "")).toBe(messages);
    expect(withImPrefix(messages, "X")[0]).toEqual({ role: "system", content: "X" });
    expect(withImPrefix(messages, "X")).toHaveLength(2);
  });
});

describe("sanitizeImChannels：config 落盘消毒", () => {
  it("整条重建 + id 必填去重 + 非法 state 回落 stopped + config 过滤危险键与非字符串", () => {
    const out = sanitizeImChannels([
      { id: " echo ", enabled: 1, sessionId: 7, state: "weird", config: { a: "1", b: 2, __proto__: "x" } },
      { id: "echo", enabled: true, state: "running" },
      { id: 5, enabled: true },
      "nope",
      { id: "feishu", enabled: true, state: "error", config: { appId: "ok" } },
    ]);
    expect(out.map((c) => c.id)).toEqual(["echo", "feishu"]);
    expect(out[0]).toEqual({ id: "echo", enabled: false, sessionId: "", state: "stopped", config: { a: "1" } });
    expect(out[1]).toEqual({ id: "feishu", enabled: true, sessionId: "", state: "error", config: { appId: "ok" } });
  });

  it("非数组一律空数组", () => {
    expect(sanitizeImChannels(undefined)).toEqual([]);
    expect(sanitizeImChannels({ id: "echo" })).toEqual([]);
  });
});

// 8.10.2：设置页 IM 卡片的「清空会话」按钮（清空上下文 = 删会话文件 + 解绑 sessionId）
describe("clearSession：清空会话（清空上下文）", () => {
  it("有绑定会话 → sessions.delete 收到该 id、sessionId 清空并落盘；下一封来信自动建新会话", async () => {
    const h = harness("我的回复");
    await h.registry.setEnabled("echo", true);
    await h.registry.settle();
    h.echo.receive("u-open-id-1", "第一条");
    await flush();
    const before = h.registry.listViews()[0];
    expect(before.sessionId).not.toBe("");

    const after = await h.registry.clearSession("echo");
    expect(h.sessions.deletedIds).toEqual([before.sessionId]); // delete 只收到这一个 id
    expect(h.sessions.get(before.sessionId)).toBeNull(); // 会话真被删掉
    expect(after[0]).toMatchObject({ sessionId: "", sessionTitle: "" });
    expect(h.config.channels[0]).toMatchObject({ sessionId: "" }); // 解绑落盘

    // 下一封来信走「无绑定会话」路径：自动建新会话（与旧的 id 无关）
    h.echo.receive("u-open-id-1", "第二条");
    await flush();
    const renewed = h.registry.listViews()[0];
    expect(renewed.sessionId).not.toBe("");
    expect(renewed.sessionId).not.toBe(before.sessionId);
  });

  it("没绑定会话 → 无事发生（delete 不被调、不写盘）", async () => {
    const h = harness();
    await h.registry.clearSession("echo");
    expect(h.sessions.deletedIds).toEqual([]);
    expect(h.config.writes).toBe(0);
  });

  it("通道不存在 → 原样返回视图，不动任何东西", async () => {
    const h = harness();
    await h.registry.clearSession("feishu");
    expect(h.sessions.deletedIds).toEqual([]);
    expect(h.config.writes).toBe(0);
  });
});
// 8.12.2：出站表情替换走真闭环 —— 回复落会话存原文，发出的是 emoji 版
describe("出站表情替换：独立 [词] → emoji，句中文字一字不动", () => {
  it("句尾与单独一行的独立标签 → emoji 发出", async () => {
    const h = harness("好呀 [嘿嘿]\n[抱抱]");
    await h.registry.setEnabled("echo", true);
    await h.registry.settle();
    h.echo.receive("u-open-id-1", "在吗");
    await flush();
    const sent = h.loopbacks[h.loopbacks.length - 1].text;
    expect(sent).toContain("😏");
    expect(sent).toContain("🤗");
    expect(sent).not.toContain("[嘿嘿]");
    expect(sent).not.toContain("[抱抱]");
    // 会话里存的是原文（标签仍在），只有出站才替换
    const session = h.sessions.get(h.registry.listViews()[0].sessionId)!;
    expect(session.messages[session.messages.length - 1].content).toContain("[嘿嘿]");
  });

  it("句中紧贴文字的标签原样发出（表情绝不替代正文词语）", async () => {
    const h = harness("我真想[抱抱]你，也想你了");
    await h.registry.setEnabled("echo", true);
    await h.registry.settle();
    h.echo.receive("u-open-id-1", "想我了吗");
    await flush();
    expect(h.loopbacks[h.loopbacks.length - 1].text).toBe("我真想[抱抱]你，也想你了");
  });
});
