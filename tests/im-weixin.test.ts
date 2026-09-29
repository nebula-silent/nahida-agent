// 8.10 新增：微信（iLink）通道的单元测试。
// 依据：内部规格 §2 / §4 / §5.1。
// 零 mock electron、零真实网络：协议解析全用纯函数，网络端口注入假 fetch，适配器注入假端口。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEIXIN_BASE_URL,
  WeixinChannel,
  buildWeixinSendBody,
  createWeixinIlinkPort,
  encodeWeixinUin,
  fetchWeixinQrCode,
  isWeixinSourceAllowed,
  parseWeixinAllowList,
  parseWeixinIncomingMessage,
  parseWeixinQrStart,
  parseWeixinQrStatus,
  parseWeixinUpdates,
  queryWeixinQrStatus,
  readWeixinCreds,
  type WeixinContextStore,
  type WeixinIncoming,
  type WeixinPort,
  type WeixinPortFactory,
} from "../src/main/im/channels/weixin";
import type { ChannelAdapter, IncomingMessage } from "../src/main/im/types";
import { createWeixinLogin } from "../src/main/im/weixin-login";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error("waitFor 超时");
}

/**
 * 假 fetch：`plan` 为数组时按调用序号给响应（到末尾后一直用最后一条）；
 * 为函数时按 URL 路由 —— **并发场景（长轮询 + 发送同时在飞）必须用函数**，
 * 否则长轮询会把「给发送准备的那条响应」抢走，测试变成看运气。
 * `"hang"` = 一直挂到被 abort（模拟长轮询被客户端掐断）。
 */
interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
type Canned = { json?: unknown; empty?: boolean; status?: number } | "hang";

function makeFetch(plan: Canned[] | ((url: string) => Canned), seen: RecordedRequest[]): typeof fetch {
  let index = 0;
  const impl = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const chosen: Canned = typeof plan === "function"
      ? plan(url)
      : plan[Math.min(index, plan.length - 1)];
    index += 1;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    seen.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
    });
    if (chosen === "hang") {
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal ?? null;
        const onAbort = (): void => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    if (chosen.status && chosen.status !== 200) return new Response("nope", { status: chosen.status });
    if (chosen.empty) return new Response("", { status: 200 });
    return new Response(JSON.stringify(chosen.json ?? {}), { status: 200 });
  };
  return impl as unknown as typeof fetch;
}

// ==================== 1. 二维码 / 扫码状态 ====================

describe("扫码：解析二维码与状态机", () => {
  it("parseWeixinQrStart：正常 / 缺字段一律 null", () => {
    expect(parseWeixinQrStart({ qrcode: "q1", qrcode_img_content: "https://liteapp.weixin.qq.com/q/x" }))
      .toEqual({ qrcode: "q1", qrUrl: "https://liteapp.weixin.qq.com/q/x" });
    expect(parseWeixinQrStart({ qrcode: "q1" })).toBeNull();
    expect(parseWeixinQrStart({ qrcode: "", qrcode_img_content: "u" })).toBeNull();
    expect(parseWeixinQrStart(null)).toBeNull();
  });

  it("parseWeixinQrStatus：wait / scaned（协议拼写）/ scanned / expired / 不认识的串按 wait", () => {
    expect(parseWeixinQrStatus({ status: "wait" })).toEqual({ state: "wait" });
    expect(parseWeixinQrStatus({ status: "scaned" })).toEqual({ state: "scanned" });
    expect(parseWeixinQrStatus({ status: "SCANNED" })).toEqual({ state: "scanned" });
    expect(parseWeixinQrStatus({ status: "expired" })).toEqual({ state: "expired" });
    expect(parseWeixinQrStatus({ status: "???" })).toEqual({ state: "wait" });
    expect(parseWeixinQrStatus(null)).toEqual({ state: "wait" });
  });

  it("confirmed：四件套落进 creds；baseurl 缺失回落默认值、有值则用返回值", () => {
    const withBase = parseWeixinQrStatus({
      status: "confirmed",
      bot_token: "tk",
      ilink_bot_id: "a1b2@im.bot",
      ilink_user_id: "wxid_abc@im.wechat",
      baseurl: "https://ilinkai.weixin.qq.com",
    });
    expect(withBase).toEqual({
      state: "confirmed",
      creds: { botToken: "tk", accountId: "a1b2@im.bot", userId: "wxid_abc@im.wechat", baseUrl: "https://ilinkai.weixin.qq.com" },
    });
    const noBase = parseWeixinQrStatus({ status: "confirmed", bot_token: "tk" });
    expect(noBase.state).toBe("confirmed");
    if (noBase.state === "confirmed") expect(noBase.creds.baseUrl).toBe(DEFAULT_WEIXIN_BASE_URL);
  });

  it("confirmed 但没给 bot_token → invalid（不能当成功）", () => {
    const bad = parseWeixinQrStatus({ status: "confirmed", ilink_bot_id: "x@im.bot" });
    expect(bad.state).toBe("invalid");
  });

  it("fetchWeixinQrCode / queryWeixinQrStatus：走 GET，非 2xx 抛错", async () => {
    const seen: RecordedRequest[] = [];
    const ok = makeFetch([{ json: { qrcode: "q9", qrcode_img_content: "u9" } }], seen);
    await expect(fetchWeixinQrCode(DEFAULT_WEIXIN_BASE_URL, ok)).resolves.toEqual({ qrcode: "q9", qrUrl: "u9" });
    expect(seen[0].url).toContain("/ilink/bot/get_bot_qrcode?bot_type=3");

    const seen2: RecordedRequest[] = [];
    const status = makeFetch([{ json: { status: "scaned" } }], seen2);
    await expect(queryWeixinQrStatus("q9", DEFAULT_WEIXIN_BASE_URL, status)).resolves.toEqual({ state: "scanned" });
    expect(seen2[0].url).toContain("qrcode=q9");

    const bad = makeFetch([{ status: 401 }], []);
    await expect(fetchWeixinQrCode(DEFAULT_WEIXIN_BASE_URL, bad)).rejects.toThrow("HTTP 401");
  });
});

// ==================== 2. 来信解析 ====================

const userMsg = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  from_user_id: "wxid_a@im.wechat",
  client_id: "m1",
  message_type: 1,
  context_token: "ctx-1",
  item_list: [{ type: 1, text_item: { text: "你好" } }],
  ...over,
});

describe("getupdates 解析：只收文本私聊 + 回环过滤", () => {
  it("正常多条约来信 + 游标前进", () => {
    const parsed = parseWeixinUpdates(
      { ret: 0, msgs: [userMsg(), userMsg({ client_id: "m2", from_user_id: "wxid_b@im.wechat", item_list: [{ type: 1, text_item: { text: "在吗" } }] })], get_updates_buf: "c1" },
    );
    expect(parsed.sessionExpired).toBe(false);
    expect(parsed.cursor).toBe("c1");
    expect(parsed.messages).toEqual([
      { target: "wxid_a@im.wechat", text: "你好", contextToken: "ctx-1", messageId: "m1" },
      { target: "wxid_b@im.wechat", text: "在吗", contextToken: "ctx-1", messageId: "m2" },
    ]);
  });

  it("丢弃 BOT 方向（message_type=2）与非文本 / 空文本 / 缺 from_user_id", () => {
    expect(parseWeixinIncomingMessage(userMsg({ message_type: 2 }))).toBeNull();
    expect(parseWeixinIncomingMessage(userMsg({ item_list: [{ type: 2, image_item: {} }] }))).toBeNull();
    expect(parseWeixinIncomingMessage(userMsg({ item_list: [{ type: 1, text_item: { text: "   " } }] }))).toBeNull();
    expect(parseWeixinIncomingMessage(userMsg({ from_user_id: "" }))).toBeNull();
    expect(parseWeixinIncomingMessage(userMsg({ item_list: [] }))).toBeNull();
    // 漏了 message_type 的来信按用户消息处理（宁可多收也不丢真消息）
    expect(parseWeixinIncomingMessage(userMsg({ message_type: undefined }))?.text).toBe("你好");
  });

  it("client_id 命中本端口已发出的 id → 回环丢弃", () => {
    expect(parseWeixinIncomingMessage(userMsg({ client_id: "mine" }), (id) => id === "mine")).toBeNull();
    expect(parseWeixinIncomingMessage(userMsg({ client_id: "other" }), (id) => id === "mine")?.text).toBe("你好");
  });

  it("errcode -14 → sessionExpired 且游标清空", () => {
    const parsed = parseWeixinUpdates({ ret: -14, errcode: -14, errmsg: "sessiontimeout" }, () => false, "old");
    expect(parsed.sessionExpired).toBe(true);
    expect(parsed.cursor).toBe("");
    expect(parsed.messages).toEqual([]);
  });

  it("响应没带游标时保留上一次的（不透明游标不许被清掉）", () => {
    expect(parseWeixinUpdates({ ret: 0, msgs: [] }, () => false, "keep").cursor).toBe("keep");
    expect(parseWeixinUpdates(null, () => false, "keep").cursor).toBe("keep");
  });

  it("空 from_user_id 的消息被丢弃（白名单判据不能是空串）", () => {
    expect(parseWeixinIncomingMessage(userMsg({ from_user_id: "  " }))).toBeNull();
  });

  it("重复 client_id 由适配器层去重（这里只保证解析给出 id）", () => {
    expect(parseWeixinIncomingMessage(userMsg())?.messageId).toBe("m1");
  });
});

// ==================== 3. 发送报文组装 ====================

describe("发送：报文与请求头", () => {
  it("buildWeixinSendBody：隐藏必填字段一个都不能少", () => {
    const body = buildWeixinSendBody({ toUserId: "wxid_a@im.wechat", contextToken: "ctx", text: "hi", clientId: "cid" });
    expect(body).toEqual({
      msg: {
        from_user_id: "", // 必须存在且为空串
        to_user_id: "wxid_a@im.wechat",
        client_id: "cid",
        message_type: 2,
        message_state: 2,
        context_token: "ctx",
        item_list: [{ type: 1, text_item: { text: "hi" } }],
      },
      base_info: { channel_version: "2.0.0" },
    });
  });

  it("encodeWeixinUin = base64(随机 uint32 的十进制串)", () => {
    expect(encodeWeixinUin(12345)).toBe(Buffer.from("12345", "utf8").toString("base64"));
    expect(encodeWeixinUin(-1)).toBe(Buffer.from("4294967295", "utf8").toString("base64"));
  });
});

// ==================== 4. 来源白名单（fail-closed）====================

describe("来源白名单：空名单 = 全拒", () => {
  it("parseWeixinAllowList 支持逗号 / 顿号 / 空白，去空去重", () => {
    expect(parseWeixinAllowList("a@im.wechat, b@im.wechat、a@im.wechat\n c@im.wechat")).toEqual([
      "a@im.wechat", "b@im.wechat", "c@im.wechat",
    ]);
    expect(parseWeixinAllowList("  ")).toEqual([]);
  });

  it("空名单全拒；命中放行；未命中拒绝；显式 * 才放开", () => {
    expect(isWeixinSourceAllowed("a@im.wechat", [])).toBe(false);
    expect(isWeixinSourceAllowed("a@im.wechat", ["a@im.wechat"])).toBe(true);
    expect(isWeixinSourceAllowed("b@im.wechat", ["a@im.wechat"])).toBe(false);
    expect(isWeixinSourceAllowed("*", ["a@im.wechat"])).toBe(false); // 目标是空/星号不成立
    expect(isWeixinSourceAllowed("b@im.wechat", ["*"])).toBe(true);
    expect(isWeixinSourceAllowed("", ["*"])).toBe(false);
  });
});

// ==================== 5. 网络端口（假 fetch）====================

const creds = { botToken: "tk", accountId: "a@im.bot", userId: "u@im.wechat", baseUrl: "https://ilinkai.weixin.qq.com" };

describe("iLink 端口：探针 / 长轮询 / 发送 / 处置", () => {
  it("connect：探针被客户端超时掐断 = 长轮询可用 → resolve 且 isAlive", async () => {
    const seen: RecordedRequest[] = [];
    const port = createWeixinIlinkPort(creds, () => undefined, undefined, {
      fetchImpl: makeFetch(["hang"], seen),
      readyTimeoutMs: 20,
      pollTimeoutMs: 30,
    });
    await port.connect();
    expect(port.isAlive()).toBe(true);
    expect(seen[0].url).toContain("/ilink/bot/getupdates");
    expect(seen[0].headers.Authorization).toBe("Bearer tk");
    expect(seen[0].headers.AuthorizationType).toBe("ilink_bot_token");
    expect(seen[0].headers["X-WECHAT-UIN"]).toBeTruthy();
    expect(seen[0].body.base_info).toEqual({ channel_version: "2.0.0" });
    await port.dispose();
    expect(port.isAlive()).toBe(false);
  });

  it("connect：服务端快速返回 errcode -14 → 直接抛（不能算连上）", async () => {
    const port = createWeixinIlinkPort(creds, () => undefined, undefined, {
      fetchImpl: makeFetch([{ json: { errcode: -14, errmsg: "sessiontimeout" } }], []),
      readyTimeoutMs: 20,
    });
    await expect(port.connect()).rejects.toThrow("重新扫码");
    expect(port.isAlive()).toBe(false);
    await port.dispose();
  });

  it("connect：HTTP 401 → 抛（凭证无效）", async () => {
    const port = createWeixinIlinkPort(creds, () => undefined, undefined, {
      fetchImpl: makeFetch([{ status: 401 }], []),
      readyTimeoutMs: 20,
    });
    await expect(port.connect()).rejects.toThrow("HTTP 401");
    await port.dispose();
  });

  it("长轮询把来信抛给 onMessage，并把新游标回传下一轮", async () => {
    const seen: RecordedRequest[] = [];
    const got: WeixinIncoming[] = [];
    const port = createWeixinIlinkPort(creds, (m) => got.push(m), undefined, {
      fetchImpl: makeFetch(["hang", { json: { ret: 0, msgs: [userMsg({ client_id: "m9" })], get_updates_buf: "c9" } }, "hang"], seen),
      readyTimeoutMs: 20,
      pollTimeoutMs: 30,
      pollRetryMs: 5,
    });
    await port.connect();
    await waitFor(() => got.length === 1);
    await waitFor(() => seen.length >= 3);
    expect(got[0]).toEqual({ target: "wxid_a@im.wechat", text: "你好", contextToken: "ctx-1", messageId: "m9" });
    expect(seen[2].body.get_updates_buf).toBe("c9");
    await port.dispose();
  });

  it("发送：报文与 headers 正确；空体按成功", async () => {
    const seen: RecordedRequest[] = [];
    // 长轮询永远挂住（正常空转），发送才给响应 —— 避免两条请求抢同一个序号
    const port = createWeixinIlinkPort(creds, () => undefined, undefined, {
      fetchImpl: makeFetch((url) => (url.endsWith("/ilink/bot/sendmessage") ? { empty: true } : "hang"), seen),
      readyTimeoutMs: 20,
      pollTimeoutMs: 30,
    });
    await port.connect();
    await port.sendText("wxid_a@im.wechat", "回复内容", "ctx-1");
    const sent = seen.find((r) => r.url.endsWith("/ilink/bot/sendmessage"));
    expect(sent).toBeTruthy();
    const msg = sent?.body.msg as Record<string, unknown>;
    expect(msg.to_user_id).toBe("wxid_a@im.wechat");
    expect(msg.context_token).toBe("ctx-1");
    expect(msg.message_type).toBe(2);
    expect(msg.message_state).toBe(2);
    expect(String(msg.client_id).startsWith("nahida-")).toBe(true);
    await port.dispose();
  });

  it("发送：ret=-2 报错文案要点明「会话令牌过期 / 可能限流」；缺 token 直接拦", async () => {
    const seen: RecordedRequest[] = [];
    const port = createWeixinIlinkPort(creds, () => undefined, undefined, {
      fetchImpl: makeFetch((url) => (url.endsWith("/ilink/bot/sendmessage") ? { json: { ret: -2 } } : "hang"), seen),
      readyTimeoutMs: 20,
      pollTimeoutMs: 30,
    });
    await port.connect();
    await expect(port.sendText("wxid_a@im.wechat", "x", "ctx")).rejects.toThrow("ret=-2");
    await expect(port.sendText("wxid_a@im.wechat", "x", "")).rejects.toThrow("对方先发一条消息");
    await port.dispose();
  });

  it("发送时收到 errcode -14 → 置 isAlive=false 并回调 onSessionExpired", async () => {
    let expired = 0;
    const port = createWeixinIlinkPort(creds, () => undefined, () => { expired += 1; }, {
      fetchImpl: makeFetch((url) => (url.endsWith("/ilink/bot/sendmessage") ? { json: { errcode: -14 } } : "hang"), []),
      readyTimeoutMs: 20,
      pollTimeoutMs: 30,
    });
    await port.connect();
    await expect(port.sendText("a", "x", "ctx")).rejects.toThrow("重新扫码");
    expect(expired).toBe(1);
    expect(port.isAlive()).toBe(false);
    await port.dispose();
  });
});

// ==================== 6. 适配器 ====================

class FakePort implements WeixinPort {
  alive = true;
  disposed = false;
  connectCalls = 0;
  connectError: Error | null = null;
  readonly sent: Array<{ target: string; text: string; token: string }> = [];
  constructor(private readonly emit: (msg: WeixinIncoming) => void = () => undefined) {}
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
  async sendText(target: string, text: string, contextToken: string): Promise<void> {
    this.sent.push({ target, text, token: contextToken });
  }
  receive(msg: WeixinIncoming): void {
    this.emit(msg);
  }
}

function makeChannel(config: Record<string, string>, ports: FakePort[]) {
  const factory: WeixinPortFactory = (_creds, onMessage) => {
    const port = new FakePort(onMessage);
    ports.push(port);
    return port;
  };
  return new WeixinChannel(() => config, { portFactory: factory, healthIntervalMs: 10_000 });
}

const baseConfig = { botToken: "tk", accountId: "a@im.bot", userId: "u@im.wechat", sourceAllow: "wxid_a@im.wechat" };

describe("WeixinChannel：白名单 / 去重 / 令牌 / 收发", () => {
  it("readWeixinCreds：缺 token 抛人话；baseUrl 缺省回落默认", () => {
    expect(() => readWeixinCreds({})).toThrow("请先扫码连接");
    expect(readWeixinCreds({ botToken: "tk" }).baseUrl).toBe(DEFAULT_WEIXIN_BASE_URL);
    expect(readWeixinCreds({ botToken: "tk", baseUrl: "https://x.example" }).baseUrl).toBe("https://x.example");
  });

  it("start 建连；缺凭证直接抛（registry 会落 error 态）", async () => {
    const ports: FakePort[] = [];
    const ch = makeChannel(baseConfig, ports);
    await ch.start();
    expect(ports.length).toBe(1);
    expect(ports[0].connectCalls).toBe(1);
    await ch.stop();
    expect(ports[0].disposed).toBe(true);

    const bad = makeChannel({ sourceAllow: "*" }, []);
    await expect(bad.start()).rejects.toThrow("请先扫码连接");
    await bad.stop();
  });

  it("白名单内来信 → IncomingMessage（channelId=weixin）；白名单外只记日志不注入", async () => {
    const ports: FakePort[] = [];
    const ch = makeChannel(baseConfig, ports);
    const got: IncomingMessage[] = [];
    ch.onMessage((m) => got.push(m));
    await ch.start();

    ports[0].receive({ target: "wxid_a@im.wechat", text: "在吗", contextToken: "ctx", messageId: "m1" });
    ports[0].receive({ target: "stranger@im.wechat", text: "陌生人", contextToken: "ctx2", messageId: "m2" });
    expect(got).toEqual([{ channelId: "weixin", target: "wxid_a@im.wechat", text: "在吗", receivedAt: expect.any(Number) }]);
    await ch.stop();
  });

  it("重复 messageId 只注入一次", async () => {
    const ports: FakePort[] = [];
    const ch = makeChannel(baseConfig, ports);
    const got: IncomingMessage[] = [];
    ch.onMessage((m) => got.push(m));
    await ch.start();
    ports[0].receive({ target: "wxid_a@im.wechat", text: "1", contextToken: "ctx", messageId: "same" });
    ports[0].receive({ target: "wxid_a@im.wechat", text: "1", contextToken: "ctx", messageId: "same" });
    expect(got.length).toBe(1);
    await ch.stop();
  });

  it("sendMessage 用该 target 的 context_token 回发；无令牌 / 未连接都拦下来", async () => {
    const ports: FakePort[] = [];
    const ch = makeChannel(baseConfig, ports);
    await ch.start();
    await expect(ch.sendMessage("wxid_a@im.wechat", "hi")).rejects.toThrow("对方先发一条消息");

    ports[0].receive({ target: "wxid_a@im.wechat", text: "在吗", contextToken: "ctx-9", messageId: "m1" });
    await ch.sendMessage("wxid_a@im.wechat", "在的");
    expect(ports[0].sent).toEqual([{ target: "wxid_a@im.wechat", text: "在的", token: "ctx-9" }]);

    ports[0].alive = false;
    await expect(ch.sendMessage("wxid_a@im.wechat", "hi")).rejects.toThrow("未连接");
    await ch.stop();
  });

  it("context_token 落盘后可跨重启复用", async () => {
    const memory: Record<string, string> = {};
    const store: WeixinContextStore = { read: () => ({ ...memory }), write: (t) => { for (const k of Object.keys(memory)) delete memory[k]; Object.assign(memory, t); } };
    const ports: FakePort[] = [];
    const factory: WeixinPortFactory = (_c, onMessage) => { const p = new FakePort(onMessage); ports.push(p); return p; };
    const first = new WeixinChannel(() => baseConfig, { portFactory: factory, contextStore: store, healthIntervalMs: 10_000 });
    await first.start();
    ports[0].receive({ target: "wxid_a@im.wechat", text: "在吗", contextToken: "ctx-persist", messageId: "m1" });
    await first.stop();
    expect(memory["wxid_a@im.wechat"]).toBe("ctx-persist");

    const second = new WeixinChannel(() => baseConfig, { portFactory: factory, contextStore: store, healthIntervalMs: 10_000 });
    await second.start();
    await second.sendMessage("wxid_a@im.wechat", "重启后仍能回");
    expect(ports[1].sent[0].token).toBe("ctx-persist");
    await second.stop();
  });

  it("stop 会释放端口（supervisor.stop → dispose）", async () => {
    const ports: FakePort[] = [];
    const ch = makeChannel(baseConfig, ports);
    await ch.start();
    await ch.stop();
    expect(ports[0].disposed).toBe(true);
  });

  it("满足 ChannelAdapter 形状（id / displayName）", () => {
    const adapter: ChannelAdapter = new WeixinChannel(() => baseConfig, {});
    expect(adapter.id).toBe("weixin");
    expect(adapter.displayName).toBe("微信");
  });
});

// ==================== 7. 扫码登录会话（8.10 接线层）====================

describe("createWeixinLogin：取码 / 轮询 / 落凭证", () => {
  const QR_URL = "https://liteapp.weixin.qq.com/q/x";

  /** 假服务：取码固定成功；状态查询由 status() 逐次决定 */
  const loginFetch = (status: () => Canned): typeof fetch =>
    makeFetch(
      (url) => (url.includes("/get_bot_qrcode")
        ? { json: { qrcode: "q1", qrcode_img_content: QR_URL } }
        : status()),
      [],
    );

  it("start：返回本地渲染的二维码 + 官方地址；renderQr 拿到的就是 qrcode_img_content", async () => {
    const rendered: string[] = [];
    const login = createWeixinLogin({
      fetchImpl: loginFetch(() => ({ json: { status: "wait" } })),
      renderQr: async (text) => { rendered.push(text); return "data:image/png;base64,FAKE"; },
      saveCreds: () => { throw new Error("取码阶段不该写凭证"); },
    });
    await expect(login.start()).resolves.toEqual({
      ok: true, qrImage: "data:image/png;base64,FAKE", qrUrl: QR_URL, baseUrl: DEFAULT_WEIXIN_BASE_URL,
    });
    expect(rendered).toEqual([QR_URL]);
  });

  it("二维码本地渲染失败 → 仍 ok，qrImage 为空（回落 qrUrl 兜底）", async () => {
    const login = createWeixinLogin({
      fetchImpl: loginFetch(() => ({ json: { status: "wait" } })),
      renderQr: async () => { throw new Error("渲染炸了"); },
      saveCreds: () => undefined,
    });
    const view = await login.start();
    expect(view.ok).toBe(true);
    expect(view.qrImage).toBe("");
    expect(view.qrUrl).toBe(QR_URL);
  });

  it("取码失败（HTTP 500）→ ok:false + error，且不留会话（poll 回 idle）", async () => {
    const login = createWeixinLogin({
      fetchImpl: makeFetch([{ status: 500 }], []),
      renderQr: async () => "img",
      saveCreds: () => undefined,
    });
    const view = await login.start();
    expect(view.ok).toBe(false);
    expect(view.error).toContain("HTTP 500");
    expect((await login.poll()).state).toBe("idle");
  });

  it("poll：wait / scanned 文案；expired 之后会话清掉", async () => {
    const states = ["wait", "scaned", "expired"];
    let i = 0;
    const login = createWeixinLogin({
      fetchImpl: loginFetch(() => ({ json: { status: states[Math.min(i++, states.length - 1)] } })),
      renderQr: async () => "img",
      saveCreds: () => undefined,
    });
    await login.start();
    expect(await login.poll()).toEqual({ state: "wait", message: "等待手机扫码…" });
    expect(await login.poll()).toEqual({ state: "scanned", message: "已扫码，请在手机上确认" });
    expect((await login.poll()).state).toBe("expired");
    expect((await login.poll()).state).toBe("idle");
  });

  it("confirmed：四件套交给 saveCreds（不多写其他键），会话结束", async () => {
    const saved: Array<Record<string, string>> = [];
    const login = createWeixinLogin({
      fetchImpl: loginFetch(() => ({
        json: {
          status: "confirmed", bot_token: "tk", ilink_bot_id: "a@im.bot",
          ilink_user_id: "u@im.wechat", baseurl: "https://ilinkai.weixin.qq.com",
        },
      })),
      renderQr: async () => "img",
      saveCreds: (c) => saved.push(c),
    });
    await login.start();
    expect((await login.poll()).state).toBe("confirmed");
    expect(saved).toEqual([{
      botToken: "tk", accountId: "a@im.bot", userId: "u@im.wechat", baseUrl: "https://ilinkai.weixin.qq.com",
    }]);
    expect((await login.poll()).state).toBe("idle");
  });

  it("confirmed + 白名单为空 → 自动把本次 userId 填进 sourceAllow（纯空白也算空）", async () => {
    const saved: Array<Record<string, string>> = [];
    const allows = ["", "  、，"]; // 第一次扫码：真空；第二次：只有分隔符和空白 = 空名单
    const login = createWeixinLogin({
      fetchImpl: loginFetch(() => ({
        json: {
          status: "confirmed", bot_token: "tk", ilink_bot_id: "a@im.bot",
          ilink_user_id: "u@im.wechat", baseurl: "https://ilinkai.weixin.qq.com",
        },
      })),
      renderQr: async () => "img",
      saveCreds: (c) => saved.push(c),
      currentAllow: () => allows[saved.length] ?? "",
    });
    await login.start();
    await login.poll();
    expect(saved[0]).toEqual({
      botToken: "tk", accountId: "a@im.bot", userId: "u@im.wechat",
      baseUrl: "https://ilinkai.weixin.qq.com", sourceAllow: "u@im.wechat",
    });
    // 再扫一次（重新取码后确认）：纯空白白名单仍视为空 → 照样自动填
    await login.start();
    await login.poll();
    expect(saved[1]?.sourceAllow).toBe("u@im.wechat");
  });

  it("confirmed + 白名单已有值 → 把本次 userId **追加**进去（扫码者就是设备用户，绝不删除已有条目）", async () => {
    const saved: Array<Record<string, string>> = [];
    const login = createWeixinLogin({
      fetchImpl: loginFetch(() => ({
        json: {
          status: "confirmed", bot_token: "tk", ilink_bot_id: "a@im.bot",
          ilink_user_id: "u@im.wechat", baseurl: "https://ilinkai.weixin.qq.com",
        },
      })),
      renderQr: async () => "img",
      saveCreds: (c) => saved.push(c),
      currentAllow: () => "other@im.wechat",
    });
    await login.start();
    expect((await login.poll()).state).toBe("confirmed");
    expect(saved[0]).toEqual({
      botToken: "tk", accountId: "a@im.bot", userId: "u@im.wechat",
      baseUrl: "https://ilinkai.weixin.qq.com", sourceAllow: "other@im.wechat,u@im.wechat",
    });
  });

  it("confirmed + 扫码者已在白名单 → 不重复添加（patch 不含 sourceAllow）", async () => {
    const saved: Array<Record<string, string>> = [];
    const login = createWeixinLogin({
      fetchImpl: loginFetch(() => ({
        json: {
          status: "confirmed", bot_token: "tk", ilink_bot_id: "a@im.bot",
          ilink_user_id: "u@im.wechat", baseurl: "https://ilinkai.weixin.qq.com",
        },
      })),
      renderQr: async () => "img",
      saveCreds: (c) => saved.push(c),
      currentAllow: () => "someone@im.wechat, u@im.wechat",
    });
    await login.start();
    expect((await login.poll()).state).toBe("confirmed");
    expect(saved[0]).toEqual({
      botToken: "tk", accountId: "a@im.bot", userId: "u@im.wechat", baseUrl: "https://ilinkai.weixin.qq.com",
    });
  });

  it("confirmed 但缺 bot_token → invalid（绝不写凭证）", async () => {
    const saved: Array<Record<string, string>> = [];
    const login = createWeixinLogin({
      fetchImpl: loginFetch(() => ({ json: { status: "confirmed", ilink_bot_id: "a@im.bot" } })),
      renderQr: async () => "img",
      saveCreds: (c) => saved.push(c),
    });
    await login.start();
    expect((await login.poll()).state).toBe("invalid");
    expect(saved).toEqual([]);
  });

  it("查询失败 → state=error 但**会话保留**（下一次轮询接着成功）", async () => {
    let i = 0;
    const login = createWeixinLogin({
      fetchImpl: loginFetch(() => (i++ === 0 ? { status: 500 } : { json: { status: "scaned" } })),
      renderQr: async () => "img",
      saveCreds: () => undefined,
    });
    await login.start();
    expect((await login.poll()).state).toBe("error");
    expect((await login.poll()).state).toBe("scanned");
  });

  it("cancel 幂等：清会话后 poll 回 idle", async () => {
    const login = createWeixinLogin({
      fetchImpl: loginFetch(() => ({ json: { status: "wait" } })),
      renderQr: async () => "img",
      saveCreds: () => undefined,
    });
    await login.start();
    expect(login.cancel()).toEqual({ ok: true });
    expect((await login.poll()).state).toBe("idle");
    expect(login.cancel()).toEqual({ ok: true });
  });

  // 真机实测（2026-09-29）：状态查询是服务端 long-poll，会 hold 住直到状态变化 ——
  // 期间用户完全可能已经取消 / 重新取码，这两条就是那个竞态的回归
  it("查询被自己的超时掐断 → 算 wait（服务端还在 hold = 没人扫码），不报错", async () => {
    const status = await queryWeixinQrStatus("q1", DEFAULT_WEIXIN_BASE_URL, makeFetch(["hang"], []), 20);
    expect(status).toEqual({ state: "wait" });
  });

  it("hold 期间取消 → 回来的 confirmed 作废：不写凭证、回 idle", async () => {
    const saved: Array<Record<string, string>> = [];
    let release: (() => void) | null = null;
    const fetchImpl = (async (input: unknown) => {
      if (String(input).includes("/get_bot_qrcode")) {
        return new Response(JSON.stringify({ qrcode: "q1", qrcode_img_content: QR_URL }));
      }
      // 卡住不返回，模拟服务端 hold
      return await new Promise<Response>((res) => {
        release = () => res(new Response(JSON.stringify({
          status: "confirmed", bot_token: "tk", ilink_bot_id: "a@im.bot",
          ilink_user_id: "u@im.wechat", baseurl: "https://ilinkai.weixin.qq.com",
        })));
      });
    }) as unknown as typeof fetch;
    const login = createWeixinLogin({ fetchImpl, renderQr: async () => "img", saveCreds: (c) => saved.push(c) });

    await login.start();
    const pending = login.poll(); // 不 await：这一拍正卡在服务端 hold 上
    await sleep(10);
    login.cancel(); // 用户点了「取消」
    release?.(); // 服务端这时才回「已确认」
    expect((await pending).state).toBe("idle");
    expect(saved).toEqual([]);
  });
});