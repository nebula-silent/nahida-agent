// 8.8 新增：IM 通道注册表 + 会话绑定桥。
// 依据：内部规格 §1.1 / §1.2 / §1.4
// 惯例照 weather/open-meteo.ts、memory/tidy-runner.ts：**运行时不 import electron**（IPC 注册函数体内 require），
// 依赖（会话存储 / 配置 / runChat）全部**注入** —— 于是本文件能在 vitest 里直接单测（用假适配器 + 假会话 + 假 chat）。
// 红线（§1.6）：外部消息只进**通道自己的独立会话**，绝不进主会话；不新增 ChatMessage 形状（复用 role="user"）。
import { resolvePath, type ChatMessage, type MessageNode } from "../../shared/chat";
import {
  imChannelKeys,
  imSecretKeys,
  maskSecretValue,
  sanitizeImChannelConfig,
  type ImChannelConfig,
  type ImChannelView,
} from "../../shared/config";
import { IPC } from "../../shared/ipc-channels";
import { expressionToEmojiText } from "../../shared/expression"; // 8.12.2：IM 出站表情替换（[词]→emoji，只认独立标签）
import type { ChannelAdapter, IncomingMessage, ImSource } from "./types";

// ==================== 注入依赖（真机 = chats-store / config-store / provider/chat 的薄包装）====================

/** 会话的最小形状（真机传 chats-store 的 ChatSession，结构兼容） */
export interface ImSessionLike {
  id: string;
  title: string;
  messages: MessageNode[];
  activeLeafId: string | null;
}

export interface ImSessions {
  create(initialMessages?: ChatMessage[]): ImSessionLike;
  get(id: string): ImSessionLike | null;
  append(id: string, message: ChatMessage): ImSessionLike | null;
  /** 8.10.2「清空会话」：真删会话文件。可选（测试桩可不实现） */
  delete?(id: string): boolean;
}

export interface ImConfigStore {
  readChannels(): ImChannelConfig[];
  writeChannels(channels: ImChannelConfig[]): void;
}

/** 一轮外部对话（真机 = runChat；**approve 不传** → 不启用本地工具，安全默认） */
export type ImChatRunner = (messages: ChatMessage[], source: ImSource) => Promise<string>;

export interface ImRegistryDeps {
  adapters: ChannelAdapter[];
  sessions: ImSessions;
  config: ImConfigStore;
  chat: ImChatRunner;
}

// ==================== 注册表 ====================

export class ImRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();
  /** 落盘配置（含尚未注册的 id —— 8.9 写入的条目不能被本步的保存动作抹掉） */
  private readonly configs = new Map<string, ImChannelConfig>();
  private readonly running = new Set<string>();
  /** 每通道一条串行链：同通道两条来信并发跑 runChat 会把同一会话的消息树写乱 */
  private readonly tails = new Map<string, Promise<void>>();
  /** 每通道一条**启停**串行链（8.10 真机抓到的连点竞态）：开关 IPC 没回包时用户再点，
   *  on/off 交错到达 —— 不串行会出现 stop 插进 start 中间、双 start 各拉一条长轮询。
   *  串行 + start/stop 幂等后，「最后一次操作」必然是终态。 */
  private readonly lifecycles = new Map<string, Promise<void>>();
  /** 落盘配置是否已读进内存（延后到首次真正用到 —— 见 ensureLoaded 的说明） */
  private loaded = false;

  constructor(private readonly deps: ImRegistryDeps) {
    for (const adapter of deps.adapters) {
      this.adapters.set(adapter.id, adapter);
      adapter.onMessage((msg) => { void this.handleIncoming(msg); });
    }
  }

  /**
   * 落盘配置的**首次读取时机**（8.9 真机验收抓出来的坑）：
   * 本类在 main/index.ts 顶层就被构造，而那时 `app.whenReady()` 还没跑 ——
   * Electron 的 safeStorage 在 ready 之前 `isEncryptionAvailable()` 恒为 false，
   * config-store 的解密分支会**回落空串**（并打 warn）。若在构造时读一次盘并长期持有快照，
   * 内存里的 IM 密钥就全是空串：界面掩码显示成空，之后任何一次 persist() 还会把空串写回去 →
   * **把用户已存的凭证抹掉**。所以改成「**首次真正用到时**才读盘」，那时进程已 ready、解密可用。
   *
   * 一次性副作用（进程刚起不可能还在跑）也在这一刻做：落盘的 state 快照回落 stopped，且不立刻写盘。
   */
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    for (const cfg of this.deps.config.readChannels()) this.configs.set(cfg.id, cfg);
    for (const [id, cfg] of [...this.configs]) {
      if (cfg.state !== "stopped") this.configs.set(id, { ...cfg, state: "stopped", enabled: cfg.enabled });
    }
  }

  /** 通道状态总览（渲染层只拿这个投影；顺序 = 注册顺序） */
  listViews(): ImChannelView[] {
    const views: ImChannelView[] = [];
    for (const adapter of this.adapters.values()) {
      const cfg = this.cfgOf(adapter.id);
      const session = cfg.sessionId ? this.deps.sessions.get(cfg.sessionId) : null;
      const secretKeys = new Set(imSecretKeys(adapter.id));
      // 凭证投影：**密钥字段只出掩码**（明文不出主进程），非敏感字段（appId / clientId）出明文便于用户核对。
      // 界面把这两个形态原样回传时都被识别成「未改动」（密钥走掩码比对，非密钥走 sameConfig 值比对）
      const configMasked: Record<string, string> = {};
      for (const key of imChannelKeys(adapter.id)) {
        const value = cfg.config[key] ?? "";
        configMasked[key] = secretKeys.has(key) ? maskSecretValue(value) : value;
      }
      views.push({
        id: adapter.id,
        displayName: adapter.displayName,
        enabled: cfg.enabled,
        state: cfg.state,
        sessionId: cfg.sessionId,
        sessionTitle: session?.title ?? "",
        configMasked,
        canTest: typeof adapter.testConnection === "function",
      });
    }
    return views;
  }

  /** 用户开关：改落盘 enabled + 真启停适配器。**不等握手**：微信 start() 要好几秒（登录 +
   *  getconfig + 长轮询探针），IPC 若等它，设置页开关几秒无响应（8.10 真机抓到的「点了没反应/
   *  点钉钉微信跟着变」根源）—— 启停转后台按串行链落定，state 随后由界面定时刷新拿真值。 */
  async setEnabled(id: string, enabled: boolean): Promise<ImChannelView[]> {
    const adapter = this.adapters.get(id);
    if (!adapter) return this.listViews();
    this.patch(id, { enabled });
    if (enabled) void this.startOne(adapter);
    else void this.stopOne(adapter);
    this.persist();
    return this.listViews();
  }

  /** 等所有通道的在途启停落定（测试用；也是将来优雅退出该等的链条） */
  async settle(): Promise<void> {
    let pending: Promise<void>[] = [];
    do {
      pending = [...this.lifecycles.values()];
      await Promise.all(pending);
    } while (this.lifecycles.size !== pending.length);
  }

  /** 清空通道上下文（8.10.2 设置页「清空会话」）：真删绑定的独立会话 + 解绑 sessionId。
   *  不用重启通道 —— 下一封来信见 sessionId 为空会自动建新会话；回复路由用的 context.json
   *  是「发给谁」的地址簿，与聊天历史无关，留着无害。 */
  async clearSession(id: string): Promise<ImChannelView[]> {
    const cfg = this.cfgOf(id);
    if (cfg.sessionId) {
      try {
        this.deps.sessions.delete?.(cfg.sessionId);
      } catch (err) {
        console.warn(`[im] 清空会话删除文件失败：${id}`, err);
      }
      this.patch(id, { sessionId: "" });
      this.persist();
    }
    return this.listViews();
  }

  /** 启动时按落盘 enabled 拉起（调用方 fire-and-forget；失败只落到 state，不挡窗口出现） */
  async startEnabled(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      if (this.cfgOf(adapter.id).enabled) await this.startOne(adapter);
    }
  }

  /**
   * 写通道凭证（8.9 设置页表单）。
   * 三条要点：
   *   ① 入参过 `sanitizeImChannelConfig` 白名单 —— 未登记通道 / 未登记键一律丢弃（IPC 输入不可信）；
   *   ② 值 === 当前明文的**掩码** → 视为「用户没改」，丢掉这一键（否则掩码会被当密钥存下去）；
   *   ③ 正在跑的连接还拿着旧凭证 → 落盘后**重启**它（失败只落 state="error"，不抛）。
   */
  async setChannelConfig(id: string, patch: Record<string, string>): Promise<ImChannelView[]> {
    const adapter = this.adapters.get(id);
    if (!adapter) return this.listViews();
    const current = this.cfgOf(id);
    const next: Record<string, string> = { ...current.config };
    for (const [key, value] of Object.entries(sanitizeImChannelConfig(id, patch))) {
      if (value !== "" && value === maskSecretValue(next[key] ?? "")) continue; // 掩码 = 未改动
      next[key] = value;
    }
    if (sameConfig(current.config, next)) return this.listViews(); // 一个字节都没改 → 不写盘、不重启
    this.patch(id, { config: next });
    this.persist();
    if (this.running.has(id)) {
      await this.stopOne(adapter);
      await this.startOne(adapter);
      this.persist();
    }
    return this.listViews();
  }

  /** 连接测试：把草稿与已落盘值合并后交给适配器；不实现 testConnection 的通道回「不支持」（绝不抛） */
  async testConnection(id: string, patch: Record<string, string>): Promise<{ ok: boolean; message: string }> {
    const adapter = this.adapters.get(id);
    if (!adapter) return { ok: false, message: `未知通道：${id}` };
    if (typeof adapter.testConnection !== "function") {
      return { ok: false, message: "该通道不支持连接测试" };
    }
    const current = this.cfgOf(id);
    const merged: Record<string, string> = { ...current.config };
    for (const [key, value] of Object.entries(sanitizeImChannelConfig(id, patch))) {
      if (value !== "" && value === maskSecretValue(merged[key] ?? "")) continue; // 掩码 = 未改动
      merged[key] = value;
    }
    try {
      return { ok: true, message: await adapter.testConnection(merged) };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** 退出前停掉全部在跑的通道 */
  async stopAll(): Promise<void> {
    this.ensureLoaded();
    for (const adapter of this.adapters.values()) {
      if (this.running.has(adapter.id)) await this.stopOne(adapter);
    }
    this.persist();
  }

  /** 真机自检：模拟一条外部来信（只有假适配器实现了 receive）；返回是否送进去了 */
  inject(channelId: string, target: string, text: string): boolean {
    const adapter = this.adapters.get(channelId);
    if (!adapter || typeof adapter.receive !== "function") return false;
    adapter.receive(target, text);
    return true;
  }

  // ---------- 收消息 → 注入绑定会话 → runChat → 原路发回 ----------

  private handleIncoming(msg: IncomingMessage): Promise<void> {
    // 假适配器回吐（loopback）：这是**我们刚发出去的回复**，只留闭环日志，绝不当新来信（否则自激无限循环）
    if (msg.loopback) {
      console.log(`[im] echo 回吐（闭环）→ channel=${msg.channelId} target=${msg.target} text=${msg.text}`);
      return Promise.resolve();
    }
    const prev = this.tails.get(msg.channelId) ?? Promise.resolve();
    const task = prev.then(() => this.processIncoming(msg), () => this.processIncoming(msg));
    this.tails.set(msg.channelId, task.catch(() => undefined));
    return task;
  }

  private async processIncoming(msg: IncomingMessage): Promise<void> {
    const adapter = this.adapters.get(msg.channelId);
    if (!adapter) {
      console.warn(`[im] 收到未知通道的来信，已丢弃：${msg.channelId}`);
      return;
    }
    if (!this.cfgOf(msg.channelId).enabled || !this.running.has(msg.channelId)) {
      console.warn(`[im] 通道未启用 / 未运行，来信已丢弃：${msg.channelId}`);
      return;
    }
    console.log(`[im] 收到来信 channel=${msg.channelId} target=${msg.target} text=${msg.text}`);

    // ① 绑定独立会话（懒创建：标题跟着首条来信走，不留空壳会话）
    let session = this.cfgOf(msg.channelId).sessionId
      ? this.deps.sessions.get(this.cfgOf(msg.channelId).sessionId)
      : null;
    if (!session) {
      session = this.deps.sessions.create([{ role: "user", content: msg.text }]);
      this.patch(msg.channelId, { sessionId: session.id });
      this.persist();
      console.log(`[im] 已为通道 ${msg.channelId} 建立独立会话 ${session.id}（"${session.title}"）`);
    } else {
      const appended = this.deps.sessions.append(session.id, { role: "user", content: msg.text });
      if (!appended) {
        console.warn(`[im] 来信写入会话失败，已放弃这一条：${session.id}`);
        return;
      }
      session = appended;
    }

    // ② 走 runChat（工具不启用 —— approve 链路由调用方掌握；来源标记前缀由 runChat 内部注入）
    const messages: ChatMessage[] = resolvePath(session.messages, session.activeLeafId)
      .map((node) => ({ role: node.role, content: node.content }));
    let reply = "";
    try {
      reply = await this.deps.chat(messages, { channelId: msg.channelId, target: msg.target });
    } catch (err) {
      console.warn(`[im] 通道 ${msg.channelId} 对话失败，本轮不发回复：`, err);
      return;
    }
    if (!reply.trim()) {
      console.warn(`[im] 通道 ${msg.channelId} 模型返回空回复，不发空消息`);
      return;
    }

    // ③ 回复落进该通道会话 + 按会话绑定的通道原路发回
    this.deps.sessions.append(session.id, { role: "assistant", content: reply });
    try {
      // 8.12.2：出站表情替换 —— 只认独立出现的 [词] 标签（单独一条/句尾/单独一行），句中文字一字不动
      await adapter.sendMessage(msg.target, expressionToEmojiText(reply));
    } catch (err) {
      console.warn(`[im] 通道 ${msg.channelId} 发送失败（回复已落会话）：`, err);
    }
  }

  // ---------- 落盘小工具 ----------

  private cfgOf(id: string): ImChannelConfig {
    this.ensureLoaded();
    return this.configs.get(id) ?? { id, enabled: false, sessionId: "", state: "stopped", config: {} };
  }

  private patch(id: string, next: Partial<ImChannelConfig>): void {
    this.configs.set(id, { ...this.cfgOf(id), ...next });
  }

  private persist(): void {
    this.ensureLoaded(); // 双保险：绝不能在「还没读盘」的状态下把内存里的空表写回去
    this.deps.config.writeChannels([...this.configs.values()]);
  }

  /** 启停操作进该通道的串行链：到达顺序逐个落定（上一环不会抛，op 也吞错，链永不断） */
  private enqueueLifecycle(id: string, op: () => Promise<void>): Promise<void> {
    const prev = this.lifecycles.get(id) ?? Promise.resolve();
    const next = prev.then(op, op);
    this.lifecycles.set(id, next);
    return next;
  }

  private async startOne(adapter: ChannelAdapter): Promise<void> {
    await this.enqueueLifecycle(adapter.id, async () => {
      // 幂等：已在跑（或正在启动）→ 不重复 start（连点开关不再双拉长轮询 / 报「已停止」）
      if (this.running.has(adapter.id)) return;
      // 先标记 running 再 start（8.10 ③b 真机抓到的启动竞态）：weixin 的就绪探针会在 start()
      // 尚未 resolve 时把服务端暂存的来信吐回来 —— 若等 start 完才标记，这批首条来信会被
      // 「未启用 / 未运行」丢掉。start 失败再移除；失败前已进串行链的来信继续走完，无害。
      this.running.add(adapter.id);
      try {
        await adapter.start();
        this.patch(adapter.id, { state: "running" });
        this.persist(); // 启停异步落定后补写盘（setEnabled 的同步 persist 只赶上了 enabled）
        console.log(`[im] 通道已启动：${adapter.id}`);
      } catch (err) {
        this.running.delete(adapter.id);
        this.patch(adapter.id, { state: "error" });
        this.persist();
        console.warn(`[im] 通道启动失败：${adapter.id}`, err);
      }
    });
  }

  private async stopOne(adapter: ChannelAdapter): Promise<void> {
    await this.enqueueLifecycle(adapter.id, async () => {
      if (this.running.has(adapter.id)) {
        try {
          await adapter.stop();
        } catch (err) {
          console.warn(`[im] 通道停止失败：${adapter.id}`, err);
        }
        this.running.delete(adapter.id);
      }
      // 没在跑也把 state 归位 stopped（幂等 stop：重复关、关一个 error 态的通道都落终态）
      this.patch(adapter.id, { state: "stopped" });
      this.persist();
    });
  }
}

// ==================== 小工具 ====================

/** 两份凭证是否逐键相等（键集合与值都相同）；用于「一个字节都没改就别写盘、别重启连接」 */
function sameConfig(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

// ==================== IPC（5 条：状态总览 / 开关 / 凭证写入 / 连接测试 / 假适配器自检注入）====================

/** 注册 im:list-channels / im:set-enabled / im:set-config / im:test-connection / im:inject（在 main/index.ts 里调用） */
export function registerImHandlers(registry: ImRegistry): void {
  const { ipcMain } = require("electron") as typeof import("electron");
  ipcMain.handle(IPC.IM_LIST_CHANNELS, () => registry.listViews());
  ipcMain.handle(IPC.IM_SET_ENABLED, (_event: unknown, id: unknown, enabled: unknown) =>
    registry.setEnabled(String(id), Boolean(enabled)),
  );
  ipcMain.handle(IPC.IM_CLEAR_SESSION, (_event: unknown, id: unknown) =>
    registry.clearSession(String(id)),
  );
  // 凭证写入：白名单消毒在 registry.setChannelConfig 内做（未登记通道/未登记键一律丢弃），这里只保证入参是对象
  ipcMain.handle(IPC.IM_SET_CONFIG, (_event: unknown, id: unknown, config: unknown) =>
    registry.setChannelConfig(
      String(id),
      (typeof config === "object" && config !== null ? config : {}) as Record<string, string>,
    ),
  );
  // 连接测试：入参 = { channelId, config }；草稿与已落盘值由 registry 合并（掩码视为未改动）
  ipcMain.handle(IPC.IM_TEST_CONNECTION, (_event: unknown, input: unknown) => {
    const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const channelId = typeof raw.channelId === "string" ? raw.channelId : "";
    const config = (typeof raw.config === "object" && raw.config !== null ? raw.config : {}) as Record<string, string>;
    return registry.testConnection(channelId, config);
  });
  // 自检注入：入参不过 IPC 边界就直接用会埋坑（§0.3 的「IPC 输入不可信」），这里逐字段白名单
  ipcMain.handle(IPC.IM_INJECT, (_event: unknown, input: unknown): { ok: boolean; reason?: string } => {
    const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const channelId = typeof raw.channelId === "string" ? raw.channelId : "";
    const target = typeof raw.target === "string" && raw.target.trim() ? raw.target.trim() : "tester";
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!channelId) return { ok: false, reason: "缺少 channelId" };
    if (!text) return { ok: false, reason: "消息内容不能为空" };
    return registry.inject(channelId, target, text) ? { ok: true } : { ok: false, reason: "该通道不支持自检注入" };
  });
}