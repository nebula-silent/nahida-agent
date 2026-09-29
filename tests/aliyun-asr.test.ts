// 4.8.1 验收主依据（4.8.1 指令 §12.A）：阿里云实时 ASR 引擎 34 条表驱动用例。
// 核心：一个假 WSS 服务端（用已在 dependencies 里的 ws@8.21.0，只在 tests/** 里 import —— D2 的例外条款）。
// 为什么必须假服务端（同 4.4/4.5/4.8）：① 要能在**没有付费 Key** 的机器上跑；
//   ② 401 / 超时 / task-failed / 心跳包 / 不认识的 event 这些分支，真服务造不出来。
// ⚠️ 一律 new VoiceRegistry()，**不许用单例 voiceRegistry** —— 单例全局共享，
//    两个用例 register 同样的 id，第二个就抛「语音引擎 id 重复」，且随执行顺序时红时绿（同 4.5 / 4.8）。
import { afterEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import {
  AliyunAsrEngine,
  buildFinishTask,
  buildRunTask,
  chunkBytes,
  normalizeWsUrl,
  parseServerEvent,
} from "../src/main/voice/engines/aliyun-asr";
import { float32ToPcmS16le, pcmS16leToFloat32 } from "../src/main/voice/audio-pcm";
import { VoiceRegistry } from "../src/main/voice/registry";
import type { VoiceConfigValues } from "../src/main/voice/config-resolver";
import { VoiceError, type VoiceEngine } from "../src/shared/voice/types";

/** 合法 wav：44 字节头 + N 个 int16 采样（引擎会**真解 wav** —— 假头会被 decodeWav 打回） */
function wavOf(data: Int16Array, sampleRate = 16000): Uint8Array {
  const out = new Uint8Array(44 + data.byteLength);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode("RIFF"), 0);
  dv.setUint32(4, 36 + data.byteLength, true);
  out.set(new TextEncoder().encode("WAVE"), 8);
  out.set(new TextEncoder().encode("fmt "), 12);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // 单声道
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  out.set(new TextEncoder().encode("data"), 36);
  dv.setUint32(40, data.byteLength, true);
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 44);
  return out;
}

const FAKE_TEXT = "你好，我是纳西妲。";
/** 1600 采样 @16k = 100ms → PCM 3200 字节 → **正好一片**（用例 22 的算式基础） */
const FAKE_WAV = wavOf(new Int16Array(1600));

interface Seen {
  url?: string;
  auth?: string;
  ua?: string;
  runTask?: { header: Record<string, unknown>; payload: Record<string, unknown> };
  finishTask?: { header: Record<string, unknown> };
  audioBytes: number; // 收到的二进制总字节
  audioChunks: number; // 收到的二进制帧数
  connected: number; // 握手次数（用例 17/18/27/28 断言 0）
  audioBytesAtRunTask?: number; // 收到 run-task 那一刻已收到的音频字节（用例 21 的时序断言）
  audioBytesAtStarted?: number; // 发送 task-started 前一刻已收到的音频字节（抓「抢发」：E1 验证过能红）
}

function startFakeAsr(
  opts: {
    /** run-task 到达后先发的事件名；默认 ["task-started"]；给 [] = 服务端装死（超时用例 30） */
    onRunTask?: string[];
    /** finish-task 到达后发的结果；默认一条 sentence_end=true 的 FAKE_TEXT */
    results?: Array<{ text: string; sentenceEnd?: boolean; heartbeat?: boolean }>;
    /** finish-task 之后发什么；默认 task-finished；"task-failed" 带错误；"nothing" = 不回（超时用例） */
    closeWith?: "task-finished" | "task-failed" | "nothing";
    errorCode?: string;
    errorMessage?: string;
    /** 握手直接拒（模拟 401/403）—— verifyClient 里 return false，ws 回 401 */
    rejectHandshake?: boolean;
    /** run-task 处理完后立刻 terminate（模拟服务端中途崩）—— 用例 33 */
    killAfterRunTask?: boolean;
    /** task-started 延迟发送（用例 21 用 100ms：给「抢发音频」留出到达窗口，时序断言才抓得住 E1） */
    delayStartedMs?: number;
    /** task-finished 前延迟（超时用例用） */
    delayMs?: number;
  } = {},
) {
  const seen: Seen = { audioBytes: 0, audioChunks: 0, connected: 0 };
  const wss = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    path: "/api-ws/v1/inference",
    verifyClient: (info) => {
      seen.connected += 1;
      seen.url = info.req.url;
      seen.auth = info.req.headers.authorization;
      seen.ua = info.req.headers["user-agent"];
      return !opts.rejectHandshake;
    },
  });
  wss.on("connection", (ws: WsSocket) => {
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        seen.audioBytes += raw.length;
        seen.audioChunks += 1;
        return;
      }
      const msg = JSON.parse(raw.toString()) as { header: Record<string, unknown> };
      const taskId = msg.header.task_id;
      if (msg.header.action === "run-task") {
        seen.runTask = msg as Seen["runTask"];
        seen.audioBytesAtRunTask = seen.audioBytes; // 用例 21：此刻必须还没发音频
        const sendStarted = () => {
          seen.audioBytesAtStarted = seen.audioBytes; // 发 task-started 前再快照一次：抢发的音频此刻已到
          for (const e of opts.onRunTask ?? ["task-started"]) {
            ws.send(JSON.stringify({ header: { event: e, task_id: taskId } }));
          }
          if (opts.killAfterRunTask) setTimeout(() => ws.terminate(), 50);
        };
        if (opts.delayStartedMs) setTimeout(sendStarted, opts.delayStartedMs);
        else sendStarted();
        return;
      }
      if (msg.header.action === "finish-task") {
        seen.finishTask = msg as Seen["finishTask"];
        // 用例 33：服务端已「崩」，不能再回结果 —— 否则本机 3200 字节的会话在 50ms terminate
        // 之前就正常跑完 resolve 了，「中途崩」测不到（实测踩过：成功路径赢了竞速）。
        if (opts.killAfterRunTask) return;
        const emit = () => {
          for (const r of opts.results ?? [{ text: FAKE_TEXT }]) {
            ws.send(
              JSON.stringify({
                header: { event: "result-generated", task_id: taskId },
                payload: {
                  output: {
                    sentence: { text: r.text, sentence_end: r.sentenceEnd ?? true, heartbeat: r.heartbeat ?? false },
                  },
                },
              }),
            );
          }
          const close = opts.closeWith ?? "task-finished";
          if (close === "nothing") return;
          if (close === "task-failed") {
            ws.send(
              JSON.stringify({
                header: {
                  event: "task-failed",
                  task_id: taskId,
                  error_code: opts.errorCode ?? "InvalidParameter",
                  error_message: opts.errorMessage ?? "boom",
                },
              }),
            );
            return;
          }
          ws.send(JSON.stringify({ header: { event: "task-finished", task_id: taskId } }));
          ws.close(1000);
        };
        if (opts.delayMs) setTimeout(emit, opts.delayMs);
        else emit();
      }
    });
  });
  wss.on("error", () => undefined); // 握手被拒时 ws 往 socket 写 401 会报错，吞掉
  const base = () => `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/api-ws/v1/inference`;
  return {
    seen,
    url: () => new Promise<string>((resolve) => (wss.address() ? resolve(base()) : wss.once("listening", () => resolve(base())))),
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(() => Promise.all(servers.splice(0).map((s) => s.close())));

function asrWith(stored: VoiceConfigValues): AliyunAsrEngine {
  return new AliyunAsrEngine({ readStoredConfig: () => stored });
}
/** 从实例上取同一份只读引用（schema 不从引擎模块导出，不为测试改产品代码 —— 同 4.5 / 4.8） */
const ASR_SCHEMA = new AliyunAsrEngine().configSchema;

/** 起假服务端 + 拼出引擎（stored.baseUrl 指向它）—— 用例 20 起的主力 */
async function withServer(
  opts: Parameters<typeof startFakeAsr>[0] = {},
  extra: VoiceConfigValues = {},
): Promise<{ s: ReturnType<typeof startFakeAsr>; engine: AliyunAsrEngine }> {
  const s = startFakeAsr(opts);
  servers.push(s);
  return { s, engine: asrWith({ baseUrl: await s.url(), apiKey: "sk-test", ...extra }) };
}

describe("4.8.1 阿里云实时 ASR 引擎（aliyun-asr）", () => {
  // 1~3 normalizeWsUrl（D4）
  it("1 normalizeWsUrl(base, \"\")：原样返回；尾斜杠被去掉", () => {
    expect(normalizeWsUrl("wss://x/api-ws/v1/inference/", "")).toBe("wss://x/api-ws/v1/inference");
    expect(normalizeWsUrl("wss://x/api-ws/v1/inference", "")).toBe("wss://x/api-ws/v1/inference");
  });

  it("2 normalizeWsUrl(base, \"llm-abc\")：覆盖 baseUrl 走专属域名（D4）", () => {
    const url = normalizeWsUrl("wss://ignored/api-ws/v1/inference", "llm-abc");
    expect(url).toContain("llm-abc.cn-beijing.maas.aliyuncs.com");
    expect(url).toContain("/api-ws/v1/inference");
  });

  it("3 normalizeWsUrl(\"https://x/y\")：VoiceError 且信息含 wss://（连之前报人话）", () => {
    expect(() => normalizeWsUrl("https://x/y", "")).toThrow(VoiceError);
    expect(() => normalizeWsUrl("https://x/y", "")).toThrow(/wss:\/\//);
  });

  // 4~7 run-task / finish-task 报文
  it("4 buildRunTask 骨架：header 三件 + payload 三件", () => {
    const msg = buildRunTask("t1", {}, "zh") as {
      header: Record<string, unknown>;
      payload: Record<string, unknown>;
    };
    expect(msg.header.action).toBe("run-task");
    expect(msg.header.task_id).toBe("t1");
    expect(msg.header.streaming).toBe("duplex");
    expect(msg.payload.task_group).toBe("audio");
    expect(msg.payload.task).toBe("asr");
    expect(msg.payload.function).toBe("recognition");
  });

  it("5 language_hints：\"zh\" → [\"zh\"]；\"\" → 整个字段不发（D12 关键一条）", () => {
    const withHints = buildRunTask("t", {}, "zh") as { payload: { parameters: Record<string, unknown> } };
    expect(withHints.payload.parameters.language_hints).toEqual(["zh"]);
    const withoutHints = buildRunTask("t", {}, "") as { payload: { parameters: Record<string, unknown> } };
    expect("language_hints" in withoutHints.payload.parameters).toBe(false);
  });

  it("6 parameters：punctuation / maxSentenceSilence 透传；format/sample_rate 恒 pcm/16000（D5+D13）", () => {
    const msg = buildRunTask("t", { punctuation: false, maxSentenceSilence: 800 }, "") as {
      payload: { parameters: Record<string, unknown> };
    };
    expect(msg.payload.parameters.punctuation_prediction_enabled).toBe(false);
    expect(msg.payload.parameters.max_sentence_silence).toBe(800);
    expect(msg.payload.parameters.format).toBe("pcm");
    expect(msg.payload.parameters.sample_rate).toBe(16000);
  });

  it("7 buildFinishTask：action=finish-task 且 task_id 与 run-task 同一个（官方硬要求）", () => {
    const msg = buildFinishTask("t1") as { header: Record<string, unknown> };
    expect(msg.header.action).toBe("finish-task");
    expect(msg.header.task_id).toBe("t1");
  });

  // 8~9 parseServerEvent
  it("8 parseServerEvent：result-generated 取 sentence 路径；task-failed 取 error 路径", () => {
    const ok = parseServerEvent(
      JSON.stringify({
        header: { event: "result-generated" },
        payload: { output: { sentence: { text: "你好", sentence_end: true, heartbeat: false } } },
      }),
    );
    expect(ok).not.toBeNull();
    expect(ok!.text).toBe("你好");
    expect(ok!.sentenceEnd).toBe(true);
    expect(ok!.heartbeat).toBe(false);
    const failed = parseServerEvent(
      JSON.stringify({ header: { event: "task-failed", error_code: "E1", error_message: "bad" } }),
    );
    expect(failed).not.toBeNull();
    expect(failed!.errorCode).toBe("E1");
    expect(failed!.errorMessage).toBe("bad");
  });

  it("9 parseServerEvent：非法 JSON / 缺 header 都返回 null（不抛）", () => {
    expect(parseServerEvent("not-json{")).toBeNull();
    expect(parseServerEvent('{"payload":{}}')).toBeNull();
  });

  // 10 chunkBytes
  it("10 chunkBytes：最后一片允许不足；空输入 → 空数组；片长 0 → VoiceError", () => {
    const chunks = chunkBytes(new Uint8Array(6500), 3200);
    expect(chunks.map((c) => c.byteLength)).toEqual([3200, 3200, 100]);
    expect(chunkBytes(new Uint8Array(0), 3200)).toEqual([]);
    expect(() => chunkBytes(new Uint8Array(10), 0)).toThrow(VoiceError);
  });

  // 11~14 元数据 / schema / 形状
  it("11 元数据：id/kind/locality/streaming=true（D8）", () => {
    const e = new AliyunAsrEngine();
    expect(e.id).toBe("aliyun-asr");
    expect(e.kind).toBe("asr");
    expect(e.locality).toBe("cloud");
    expect(e.streaming).toBe(true);
  });

  it("12 configSchema：select 都有 options；required 恰好 [baseUrl, apiKey]；有 boolean 字段（本仓首次）", () => {
    for (const f of ASR_SCHEMA) {
      if (f.type === "select") expect(f.options?.length ?? 0).toBeGreaterThan(0);
    }
    expect(ASR_SCHEMA.filter((f) => f.required).map((f) => f.key)).toEqual(["baseUrl", "apiKey"]);
    expect(ASR_SCHEMA.some((f) => f.type === "boolean")).toBe(true);
  });

  it("13 apiKey 字段是 password + secret（同 4.5 用例 4）", () => {
    const key = ASR_SCHEMA.find((f) => f.key === "apiKey");
    expect(key?.type).toBe("password");
    expect(key?.secret).toBe(true);
  });

  it("14 形状：有 transcribe 和 transcribeStream（都是 function）；没有 synthesize", () => {
    const e = new AliyunAsrEngine() as unknown as Record<string, unknown>;
    expect(typeof e.transcribe).toBe("function");
    expect(typeof e.transcribeStream).toBe("function");
    expect(e.synthesize).toBeUndefined();
  });

  // 15~16 注册 + 降级链
  it("15 注册进真 VoiceRegistry 不抛；listByKind(asr) = [aliyun-asr]", () => {
    const r = new VoiceRegistry();
    expect(() => r.register(new AliyunAsrEngine())).not.toThrow();
    expect(r.listByKind("asr").map((e) => e.id)).toEqual(["aliyun-asr"]);
  });

  it("16 降级链：本地在前，两个云端按注册序 → [sherpa-onnx, openai-asr, aliyun-asr]", () => {
    const fakeLocal: VoiceEngine = {
      id: "sherpa-onnx",
      name: "本地 sherpa-onnx",
      kind: "asr",
      locality: "local",
      streaming: false,
      configSchema: [],
      transcribe: () => Promise.resolve({ text: "", isFinal: true }),
    };
    const fakeCloud: VoiceEngine = {
      id: "openai-asr",
      name: "云端 openai-asr",
      kind: "asr",
      locality: "cloud",
      streaming: false,
      configSchema: [],
      transcribe: () => Promise.resolve({ text: "", isFinal: true }),
    };
    const r = new VoiceRegistry();
    r.register(fakeLocal);
    r.register(fakeCloud);
    r.register(new AliyunAsrEngine());
    expect(r.resolveChain("asr")).toEqual(["sherpa-onnx", "openai-asr", "aliyun-asr"]);
  });

  // 17~19 health()：只查配置，不发请求（D9）
  it("17 health()：没填 Key → unavailable 且 detail 含「API Key」；假服务 connected===0", async () => {
    const s = startFakeAsr();
    servers.push(s);
    const engine = asrWith({ baseUrl: await s.url() }); // 故意不给 apiKey
    const h = await engine.health();
    expect(h.availability).toBe("unavailable");
    expect(h.detail).toContain("API Key");
    expect(s.seen.connected).toBe(0);
  });

  it("18 health()：地址 + Key 齐 → ready；connected===0（D9）", async () => {
    const { s } = await withServer();
    expect((await asrWith({ baseUrl: await s.url(), apiKey: "sk-test" }).health()).availability).toBe("ready");
    expect(s.seen.connected).toBe(0);
  });

  it("19 health()：baseUrl=https://x/y → unavailable 且 detail 含 wss://（D4 地址校验在设置页可见）", async () => {
    const h = await asrWith({ baseUrl: "https://x/y", apiKey: "sk-test" }).health();
    expect(h.availability).toBe("unavailable");
    expect(h.detail).toContain("wss://");
  });

  // 20~22 握手与音频
  it("20 握手三件套：路径 / Authorization: Bearer sk-test / user-agent 非空（D3）", async () => {
    const { s, engine } = await withServer();
    await engine.transcribe({ audio: FAKE_WAV, format: "wav" });
    expect(s.seen.url).toContain("/api-ws/v1/inference");
    expect(s.seen.auth).toBe("Bearer sk-test");
    expect(s.seen.ua).toBeTruthy();
  });

  it("21 顺序：run-task 到达时音频字节为 0；task-started 发出前仍为 0；整段跑完后 audioBytes>0（官方硬要求）", async () => {
    // delayStartedMs：给「抢发」的音频留 100ms 到达窗口 —— 没有它，本机 TCP FIFO 下时序违规测不到（E1 实证）
    const { s, engine } = await withServer({ delayStartedMs: 100 });
    await engine.transcribe({ audio: FAKE_WAV, format: "wav" });
    expect(s.seen.audioBytesAtRunTask).toBe(0);
    expect(s.seen.audioBytesAtStarted).toBe(0);
    expect(s.seen.audioBytes).toBeGreaterThan(0);
  });

  it("22 音频字节与帧数：3200 字节一片 + 静音尾巴 19200 → audioBytes===22400、audioChunks===2（D5+D11）", async () => {
    const { s, engine } = await withServer();
    await engine.transcribe({ audio: FAKE_WAV, format: "wav" });
    expect(s.seen.audioBytes).toBe(3200 + 19200); // FAKE_WAV 改采样数时这两个数必须同步改
    expect(s.seen.audioChunks).toBe(2);
  });

  // 23~26 结果与回调
  it("23 正常会话：transcribe → { text: FAKE_TEXT, isFinal: true }", async () => {
    const { engine } = await withServer();
    const out = await engine.transcribe({ audio: FAKE_WAV, format: "wav" });
    expect(out).toEqual({ text: FAKE_TEXT, isFinal: true });
  });

  it("24 多句拼接：两条 sentence_end=true → 首尾相接、不补标点（D13）", async () => {
    const { engine } = await withServer({
      results: [{ text: "你好" }, { text: "我是纳西妲" }],
    });
    const out = await engine.transcribe({ audio: FAKE_WAV, format: "wav" });
    expect(out.text).toBe("你好我是纳西妲");
  });

  it("25 心跳包跳过：heartbeat:true 的「垃圾」不进结果（§7.3 自查 4）", async () => {
    const { engine } = await withServer({
      results: [{ text: "垃圾", heartbeat: true }, { text: FAKE_TEXT }],
    });
    const out = await engine.transcribe({ audio: FAKE_WAV, format: "wav" });
    expect(out.text).toBe(FAKE_TEXT);
    expect(out.text).not.toContain("垃圾");
  });

  it("26 transcribeStream：onPartial 收中间结果、onSentence 收句子；返回值 = 整段文本（D7）", async () => {
    const { engine } = await withServer({
      results: [{ text: "你好，", sentenceEnd: false }, { text: "你好，我是纳西妲。", sentenceEnd: true }],
    });
    const partials: string[] = [];
    const sentences: string[] = [];
    const out = await engine.transcribeStream({
      audio: FAKE_WAV,
      format: "wav",
      handlers: {
        onPartial: (t) => partials.push(t),
        onSentence: (t) => sentences.push(t),
      },
    });
    expect(partials).toEqual(["你好，"]);
    expect(sentences).toEqual(["你好，我是纳西妲。"]);
    expect(out).toEqual({ text: "你好，我是纳西妲。", isFinal: true });
  });

  // 27~28 守卫
  it("27 空音频 → { text:\"\", isFinal:true } 且 connected===0（别拿空 buffer 去连网）", async () => {
    const { s, engine } = await withServer();
    const out = await engine.transcribe({ audio: new Uint8Array(0), format: "wav" });
    expect(out).toEqual({ text: "", isFinal: true });
    expect(s.seen.connected).toBe(0);
  });

  it("28 format=mp3 → VoiceError 含 mp3 且 connected===0（D6，转码前就拒）", async () => {
    const { s, engine } = await withServer();
    await expect(engine.transcribe({ audio: FAKE_WAV, format: "mp3" })).rejects.toThrow(/mp3/);
    expect(s.seen.connected).toBe(0);
  });

  // 29~33 错误分支
  it("29 task-failed → VoiceError 含错误码与「阿里云实时识别」", async () => {
    const { engine } = await withServer({ closeWith: "task-failed", errorCode: "InvalidParameter", errorMessage: "boom" });
    await expect(engine.transcribe({ audio: FAKE_WAV, format: "wav" })).rejects.toThrow(/InvalidParameter/);
    await expect(engine.transcribe({ audio: FAKE_WAV, format: "wav" })).rejects.toThrow(/阿里云实时识别/);
  });

  it("30 超时（服务端装死）：onRunTask:[] + timeoutMs:200 → VoiceError 含「超时」（D10）", async () => {
    const { engine } = await withServer({ onRunTask: [] }, { timeoutMs: 200 });
    await expect(engine.transcribe({ audio: FAKE_WAV, format: "wav" })).rejects.toThrow(/超时/);
  });

  it("31 signal 已 abort → 原样抛 AbortError（不是 VoiceError，判序护栏）", async () => {
    const { engine } = await withServer();
    const ac = new AbortController();
    ac.abort(); // 先中止再调用（barge-in 场景）
    const err = await engine
      .transcribe({ audio: FAKE_WAV, format: "wav", signal: ac.signal })
      .catch((e: unknown) => e);
    expect(err).toBeDefined();
    expect((err as Error).name).toBe("AbortError");
    expect(err instanceof VoiceError).toBe(false);
  });

  it("32 握手被拒（401）→ VoiceError 含「连接失败」（成因三选一的人话）", async () => {
    const { engine } = await withServer({ rejectHandshake: true });
    await expect(engine.transcribe({ audio: FAKE_WAV, format: "wav" })).rejects.toThrow(/连接失败/);
  });

  it("33 连接中断（非 1000）→ VoiceError 匹配 /连接失败|连接中断/", async () => {
    const { engine } = await withServer({ killAfterRunTask: true });
    await expect(engine.transcribe({ audio: FAKE_WAV, format: "wav" })).rejects.toThrow(/连接失败|连接中断/);
  });

  // 34 float32ToPcmS16le（§8 的新函数）
  it("34 float32ToPcmS16le：长度 ×2；往返误差 ≤ 1/32767；超范围硬夹；+1 → 32767（不是 -32768）", () => {
    const src = new Float32Array([0, 0.5, -0.5]);
    const out = float32ToPcmS16le(src);
    expect(out.byteLength).toBe(src.length * 2);
    const back = pcmS16leToFloat32(out);
    for (let i = 0; i < src.length; i++) {
      expect(Math.abs(back[i] - src[i])).toBeLessThanOrEqual(1 / 32767);
    }
    const clamped = new DataView(float32ToPcmS16le(new Float32Array([2, -2, 1])).buffer);
    expect(clamped.getInt16(0, true)).toBe(32767); // 2 → +1（不是回绕成反相噪声）
    expect(clamped.getInt16(2, true)).toBe(-32767); // -2 → -1
    expect(clamped.getInt16(4, true)).toBe(32767); // +1 → 32767（不是 -32768）
  });
});
