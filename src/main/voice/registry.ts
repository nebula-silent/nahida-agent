// 4.3 新增：语音引擎注册表。TTS / ASR 共用（P3）。
// 单一出口的思路参考自 Cyrene-Agent 的 TTS 分发模块，但**不搬**它的硬编码 if 链、
// 顶部静态 import 全部引擎、以及每个引擎一组专属 IPC 通道 —— 那些正是本步要消灭的。
// ⚠️ 本文件**不许 import electron**，也不许 import src/main 下的其它模块 ——
//    保持零依赖，才能被 vitest 直接 import（§9.A 靠这个）。
import {
  VoiceError,
  type SynthesizeOutput,
  type SynthesizeRequest,
  type SynthesizeResult,
  type TranscribeOutput,
  type TranscribeRequest,
  type TranscribeResult,
  type VoiceEngine,
  type VoiceEngineSummary,
  type VoiceHealth,
  type VoiceKind,
} from "../../shared/voice/types";
import { createGptSovitsEngine } from "./engines/gpt-sovits";
import { createOpenAiTtsEngine } from "./engines/openai-tts";
import { createMiniMaxEngine } from "./engines/minimax";
import { createEdgeTtsEngine } from "./engines/edge-tts";
import { createOpenAiAsrEngine } from "./engines/openai-asr"; // 云端识别（4.8）
import { createAliyunAsrEngine } from "./engines/aliyun-asr"; // 云端识别·流式（4.8.1）
import { createSherpaAsrEngine } from "./engines/sherpa-onnx"; // 本地识别（4.7）
import type { VoiceConfigValues } from "../../shared/voice/types";

/**
 * 4.6：stored 层读取器（engineId → 用户配置）。
 * **必须由主进程注入**，不能在这里 import config-store ——
 * config-store 顶层 import electron，一引进来 registry 就无法被 vitest 直接 import（4.3 §9.A）。
 */
export type ReadVoiceConfig = (engineId: string) => VoiceConfigValues;

export interface VoiceRunOptions {
  /** 置顶优先尝试的引擎 id（用户在设置页手选的那个，4.6 传进来）；不传 = 纯按本地优先 */
  preferredId?: string;
}

/** 注册时的形状校验 —— 把错误拦在启动期，别等到用户点了播放才炸 */
function assertEngineShape(e: VoiceEngine): void {
  if (!e.id || e.id !== e.id.trim()) throw new VoiceError("语音引擎的 id 不能为空、也不能带首尾空格");
  if (!e.name) throw new VoiceError(`语音引擎 ${e.id} 缺中文名 name`);
  if (e.kind === "tts" && typeof e.synthesize !== "function") {
    throw new VoiceError(`TTS 引擎 ${e.id} 没有实现 synthesize()`);
  }
  if (e.kind === "asr" && typeof e.transcribe !== "function") {
    throw new VoiceError(`ASR 引擎 ${e.id} 没有实现 transcribe()`);
  }
  for (const f of e.configSchema) {
    if (!f.key || !f.label) throw new VoiceError(`引擎 ${e.id} 的 configSchema 里有字段缺 key 或 label`);
    if (f.type === "select" && !f.options?.length) {
      throw new VoiceError(`引擎 ${e.id} 的字段 ${f.key} 是 select，但没给 options`);
    }
  }
}

export class VoiceRegistry {
  private readonly engines = new Map<string, VoiceEngine>();

  register(engine: VoiceEngine): void {
    assertEngineShape(engine);
    if (this.engines.has(engine.id)) throw new VoiceError(`语音引擎 id 重复：${engine.id}`);
    // ⚠️ 直接存引用，别 { ...engine } —— 展开只拷自有可枚举属性，原型上的方法会全丢
    //（4.4 起的本地引擎会是 class 实例，持有 HTTP 客户端 / 进程句柄）
    this.engines.set(engine.id, engine);
  }

  get(id: string): VoiceEngine | undefined {
    return this.engines.get(id);
  }

  has(id: string): boolean {
    return this.engines.has(id);
  }

  /** 注册顺序 */
  list(): VoiceEngine[] {
    return [...this.engines.values()];
  }

  listByKind(kind: VoiceKind): VoiceEngine[] {
    return this.list().filter((e) => e.kind === kind);
  }

  async summaries(): Promise<VoiceEngineSummary[]> {
    const out: VoiceEngineSummary[] = [];
    for (const e of this.engines.values()) {
      const h = await this.health(e.id);
      out.push({
        id: e.id,
        name: e.name,
        kind: e.kind,
        locality: e.locality,
        streaming: e.streaming,
        configSchema: e.configSchema,
        availability: h.availability,
        detail: h.detail,
      });
    }
    return out;
  }

  async health(id: string): Promise<VoiceHealth> {
    const e = this.engines.get(id);
    if (!e) return { availability: "unavailable", detail: `未注册的语音引擎：${id}` };
    if (!e.health) return { availability: "ready" }; // 无状态引擎不必实现 health()
    try {
      return await e.health();
    } catch (err) {
      return { availability: "unavailable", detail: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * 降级链**顺序**（P5：本地优先）：preferred → 本地（注册顺序）→ 云端（注册顺序）。
   * **同步**且**不查健康** —— 健康检查是异步的，逐次 await 会拖慢列表；
   * 跳过不可用引擎这件事交给下面的执行器做（这是唯一正确的分工）。
   */
  resolveChain(kind: VoiceKind, opts: VoiceRunOptions = {}): string[] {
    const all = this.list().filter((e) => e.kind === kind);
    const ordered = [
      ...all.filter((e) => e.locality === "local").map((e) => e.id),
      ...all.filter((e) => e.locality === "cloud").map((e) => e.id),
    ];
    // ⚠️ 必须连 kind 一起校验：preferredId 是 TTS 引擎时，ASR 链里塞进它 →
    //    runChain 会调它不存在的 transcribe()，记一条**假的**降级原因（4.6 首次消费时发现）
    const preferred = opts.preferredId ? this.engines.get(opts.preferredId) : undefined;
    if (preferred && preferred.kind === kind) {
      return [preferred.id, ...ordered.filter((id) => id !== preferred.id)];
    }
    return ordered;
  }

  /** 沿降级链逐个试：不可用的跳过、抛错的记下来换下一个；全失败才抛 */
  private async runChain<T>(
    kind: VoiceKind,
    run: (e: VoiceEngine) => Promise<T>,
    opts: VoiceRunOptions,
  ): Promise<{ value: T; engine: VoiceEngine; degraded: string[] }> {
    const chain = this.resolveChain(kind, opts);
    if (chain.length === 0) {
      throw new VoiceError(kind === "tts" ? "没有可用的语音合成引擎" : "没有可用的语音识别引擎");
    }
    // failures 就是 degraded：第一个引擎就成功时它自然是空数组（= 未降级）
    const failures: string[] = [];
    for (const id of chain) {
      const engine = this.engines.get(id)!;
      const h = await this.health(id);
      if (h.availability === "unavailable") {
        failures.push(`${engine.name}：${h.detail ?? "当前不可用"}`);
        continue;
      }
      try {
        return { value: await run(engine), engine, degraded: failures };
      } catch (err) {
        failures.push(`${engine.name}：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new VoiceError(`语音引擎全部失败 —— ${failures.join("；")}`);
  }

  async synthesize(req: SynthesizeRequest, opts: VoiceRunOptions = {}): Promise<SynthesizeResult> {
    const { value, engine, degraded } = await this.runChain<SynthesizeOutput>(
      "tts",
      (e) => e.synthesize!(req),
      opts,
    );
    return { ...value, engineId: engine.id, locality: engine.locality, degraded };
  }

  async transcribe(req: TranscribeRequest, opts: VoiceRunOptions = {}): Promise<TranscribeResult> {
    const { value, engine, degraded } = await this.runChain<TranscribeOutput>(
      "asr",
      (e) => e.transcribe!(req),
      opts,
    );
    return { ...value, engineId: engine.id, locality: engine.locality, degraded };
  }

  /** 测试用：清空（vitest 每个用例 new 一个实例就不用它，留着是给将来热重载） */
  clear(): void {
    this.engines.clear();
  }
}

export const voiceRegistry = new VoiceRegistry();

/**
 * 内置引擎注册入口。
 * 引擎随各自步骤落地时在这里加一行（项目规矩：不预埋，用到再加）：
 *   4.4 本地合成（gpt-sovits）/ 4.5 云端合成两件套（openai-tts · minimax）
 *   / 4.5.1 Edge 朗读（零配置兜底）/ 4.7 本地识别 sherpa-onnx（+ silero-vad 静音检测）
 *   / 4.8 云端识别 openai-asr / 4.8.1 阿里云实时（流式）
 * 4.6：`readConfig` 由 main/index.ts 注入（见上方 ReadVoiceConfig 的理由）。
 */
export function registerBuiltinVoiceEngines(readConfig?: ReadVoiceConfig, baseDir?: string): void {
  // 每个引擎拿一个「只读自己那份」的闭包；不传 readConfig（单测）时 stored 恒空，行为同 4.4
  const stored = (id: string) => (readConfig ? () => readConfig(id) : undefined);
  voiceRegistry.register(createGptSovitsEngine(stored("gpt-sovits"))); // 本地（4.4）
  voiceRegistry.register(createOpenAiTtsEngine(stored("openai-tts"))); // 云端（4.5）
  voiceRegistry.register(createMiniMaxEngine(stored("minimax"))); // 云端（4.5）
  // ⚠️ 必须排在所有云端引擎之后 —— 它是「零配置兜底」，要最后才轮到（4.5.1 §0）
  voiceRegistry.register(createEdgeTtsEngine(stored("edge-tts"))); // 云端·零配置兜底（4.5.1）
  // 本地识别（4.7）：ASR 链的**唯一**一环。resolveChain 会把它排到 ASR 链最前（locality=local 优先），
  // 与 TTS 链互不干扰 —— 4.8 的云端识别注册在它后面。
  // 4.9.8 S2：baseDir（相对模型路径的基准目录）只透传，本文件不许碰 electron / cwd 来算它
  voiceRegistry.register(createSherpaAsrEngine(stored("sherpa-onnx"), baseDir));
  // 云端识别（4.8）：ASR 链的云端兜底。**注册顺序在本地之后无所谓** ——
  // resolveChain 会先把所有 locality=local 的排前面（L119-122），所以 ASR 链自然是 [本地, 云端]。
  // 4.8.1 的阿里云实时注册在它后面。
  voiceRegistry.register(createOpenAiAsrEngine(stored("openai-asr"))); // 云端（4.8）
  // 云端识别（4.8.1）：阿里云实时（DashScope WebSocket 流式）。ASR 链的**第三个**引擎 ——
  // 它也是 cloud，所以排在 openai-asr 之后（同 locality 按注册顺序，见 resolveChain）。
  // 唯一一个 streaming=true 的引擎，但**不影响 resolveChain**（那个函数不看 streaming）。
  voiceRegistry.register(createAliyunAsrEngine(stored("aliyun-asr")));
}