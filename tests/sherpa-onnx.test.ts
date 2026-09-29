// 4.7 验收主依据（指令 §15.A）：24 条表驱动 + 3 条注册链 + 1 条 health 分支。
// **全部纯函数 + 形状断言，零网络、零插件**（D4/D5 换来的：单测不 require .node 二进制）。
// ⚠️ configSchema 不从引擎模块导出（同 4.5.1 的规矩：不为测试改产品代码），一律 new 实例取。
import { beforeEach, describe, expect, it } from "vitest";
import { SherpaOnnxAsrEngine, createSherpaAsrEngine } from "../src/main/voice/engines/sherpa-onnx";
import { clearSherpaCache, loadSherpaModule } from "../src/main/voice/sherpa-loader";
import {
  joinSegmentTexts,
  linearResample,
  pcmS16leToFloat32,
  takeWindows,
  toModelAudio,
  decodeWav,
} from "../src/main/voice/audio-pcm";
import { createGptSovitsEngine } from "../src/main/voice/engines/gpt-sovits";
import { createOpenAiTtsEngine } from "../src/main/voice/engines/openai-tts";
import { createMiniMaxEngine } from "../src/main/voice/engines/minimax";
import { createEdgeTtsEngine } from "../src/main/voice/engines/edge-tts";
import { VoiceRegistry } from "../src/main/voice/registry";
import { VoiceError, type VoiceEngine, type VoiceConfigValues } from "../src/shared/voice/types";

const SCHEMA = new SherpaOnnxAsrEngine().configSchema;

/** 手拼一个 16bit PCM wav；chunks 可插额外块（用来验「奇数长度对齐」） */
function wavOf(opts: {
  channels?: number;
  sampleRate?: number;
  data: Int16Array;
  extra?: { id: string; body: Uint8Array }[]; // 插在 fmt 与 data 之间的块
}): Uint8Array {
  const { channels = 1, sampleRate = 16000, data, extra = [] } = opts;
  const fmt = new Uint8Array(24);
  const fv = new DataView(fmt.buffer);
  fv.setUint32(0, 0x666d7420, false); // "fmt "
  fv.setUint32(4, 16, true);
  fv.setUint16(8, 1, true); // PCM
  fv.setUint16(10, channels, true);
  fv.setUint32(12, sampleRate, true);
  fv.setUint32(16, sampleRate * channels * 2, true);
  fv.setUint16(20, channels * 2, true);
  fv.setUint16(22, 16, true);
  const extras = extra
    .map((e) => {
      const head = new Uint8Array(8);
      const hv = new DataView(head.buffer);
      hv.setUint32(
        0,
        e.id.charCodeAt(0) * 0x1000000 + (e.id.charCodeAt(1) << 16) + (e.id.charCodeAt(2) << 8) + e.id.charCodeAt(3),
        false,
      );
      hv.setUint32(4, e.body.length, true);
      const pad = e.body.length % 2; // 奇数长度补 1 字节
      return [head, e.body, new Uint8Array(pad)];
    })
    .flat();
  const dataHead = new Uint8Array(8);
  const dv = new DataView(dataHead.buffer);
  dv.setUint32(0, 0x64617461, false); // "data"
  dv.setUint32(4, data.byteLength, true);
  const body = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const total = 12 + fmt.length + extras.reduce((n, c) => n + c.length, 0) + dataHead.length + body.length;
  const out = new Uint8Array(total);
  out.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(out.buffer).setUint32(4, total - 8, true);
  out.set(new TextEncoder().encode("WAVE"), 8);
  out.set(fmt, 12);
  let off = 12 + fmt.length;
  for (const c of extras) {
    out.set(c, off);
    off += c.length;
  }
  out.set(dataHead, off);
  off += 8;
  out.set(body, off);
  return out;
}

describe("4.7 sherpa-onnx 本地识别（纯函数 + 形状，零插件）", () => {
  // 1~4 configSchema 形状：§6 的四条硬规矩
  it("1 configSchema 必填项恰好 2 个，且是 modelPath/tokensPath", () => {
    expect(SCHEMA.filter((f) => f.required).map((f) => f.key)).toEqual(["modelPath", "tokensPath"]);
  });

  it("2 configSchema 里一个 secret 都没有", () => {
    expect(SCHEMA.every((f) => !f.secret)).toBe(true);
  });

  it("3 三个 path 字段都带 pathMode: file", () => {
    const paths = SCHEMA.filter((f) => f.type === "path");
    expect(paths.map((f) => f.key)).toEqual(["modelPath", "tokensPath", "vadModelPath"]);
    expect(paths.every((f) => f.pathMode === "file")).toBe(true);
  });

  it("4 四个 number 字段都有 min/max/step，且 default 落在区间内", () => {
    const nums = SCHEMA.filter((f) => f.type === "number");
    expect(nums.map((f) => f.key)).toEqual([
      "numThreads",
      "vadThreshold",
      "minSpeechDuration",
      "minSilenceDuration",
    ]);
    for (const f of nums) {
      expect(f.min).toBeDefined();
      expect(f.max).toBeDefined();
      expect(f.step).toBeDefined();
      expect(f.default as number).toBeGreaterThanOrEqual(f.min!);
      expect(f.default as number).toBeLessThanOrEqual(f.max!);
    }
  });

  // 5~11 decodeWav：RIFF/WAVE 解析
  it("5 decodeWav：16k 单声道原样（长度 + 首尾值）", () => {
    const w = wavOf({ data: Int16Array.from([1000, -1000]) });
    const { samples, sampleRate } = decodeWav(w);
    expect(sampleRate).toBe(16000);
    expect(samples.length).toBe(2);
    expect(samples[0]).toBeCloseTo(1000 / 32768, 7);
    expect(samples[1]).toBeCloseTo(-1000 / 32768, 7);
  });

  it("6 decodeWav：立体声取平均（不是取第 0 声道）", () => {
    const w = wavOf({ channels: 2, data: Int16Array.from([1000, 3000]) });
    const { samples } = decodeWav(w);
    expect(samples.length).toBe(1);
    expect(samples[0]).toBeCloseTo(2000 / 32768, 7);
  });

  it("7 decodeWav：48k 经 toModelAudio 后长度 ≈ 1/3", () => {
    const w = wavOf({ sampleRate: 48000, data: new Int16Array(9000) });
    const out = toModelAudio(w, "wav");
    expect(Math.abs(out.length - Math.round(9000 / 3))).toBeLessThanOrEqual(1);
  });

  it("8 decodeWav：头不是 RIFF → VoiceError，信息含 RIFF", () => {
    expect(() => decodeWav(new Uint8Array(100))).toThrow(VoiceError);
    expect(() => decodeWav(new Uint8Array(100))).toThrow(/RIFF/);
  });

  it("9 decodeWav：8bit → VoiceError，信息含 16bit", () => {
    const w = wavOf({ data: Int16Array.from([1000]) });
    new DataView(w.buffer).setUint16(34, 8, true); // fmt 块内 bits 字段（偏移 12+8+14=34）改成 8
    expect(() => decodeWav(w)).toThrow(VoiceError);
    expect(() => decodeWav(w)).toThrow(/16bit/);
  });

  it("10 decodeWav：data 长度写 0xFFFFFFFF → 按剩余裁掉，不越界", () => {
    const w = wavOf({ data: Int16Array.from([1000, -1000]) });
    new DataView(w.buffer).setUint32(40, 0xffffffff, true); // data 块长度字段（偏移 36+4=40）
    const { samples } = decodeWav(w);
    expect(samples.length).toBe(2);
    expect(samples[0]).toBeCloseTo(1000 / 32768, 7);
  });

  it("11 decodeWav：fmt 与 data 之间插奇数长度的 LIST 块仍能找到 data", () => {
    const w = wavOf({ data: Int16Array.from([1000, -1000]), extra: [{ id: "LIST", body: new Uint8Array(3) }] });
    const { samples } = decodeWav(w);
    expect(samples.length).toBe(2);
    expect(samples[0]).toBeCloseTo(1000 / 32768, 7);
  });

  // 12~13 pcmS16leToFloat32
  it("12 pcmS16leToFloat32：端点正确", () => {
    const bytes = new Uint8Array(Int16Array.from([-32768, 32767]).buffer);
    const out = pcmS16leToFloat32(bytes);
    expect(out[0]).toBe(-1);
    expect(out[1]).toBeCloseTo(32767 / 32768, 7);
  });

  it("13 pcmS16leToFloat32：奇数长度 → VoiceError", () => {
    expect(() => pcmS16leToFloat32(new Uint8Array(3))).toThrow(VoiceError);
  });

  // 14~16 linearResample
  it("14 linearResample：同采样率原样返回同一引用", () => {
    const s = new Float32Array([0.1, 0.2]);
    expect(linearResample(s, 16000, 16000)).toBe(s);
  });

  it("15 linearResample：2 倍上采样长度翻倍", () => {
    const out = linearResample(new Float32Array([0, 1]), 8000, 16000);
    expect(out.length).toBe(4);
  });

  it("16 linearResample：线性插值中点正确（末点夹取）", () => {
    const out = linearResample(new Float32Array([0, 1]), 8000, 16000);
    expect([...out]).toEqual([0, 0.5, 1, 1]);
  });

  // 17~18 takeWindows
  it("17 takeWindows：1024 点 / 512 → 2 窗 + 空余数", () => {
    const { windows, rest } = takeWindows(new Float32Array(1024), 512);
    expect(windows.length).toBe(2);
    expect(rest.length).toBe(0);
  });

  it("18 takeWindows：不足一窗 → 0 窗 + 全部进 rest", () => {
    const { windows, rest } = takeWindows(new Float32Array(300), 512);
    expect(windows.length).toBe(0);
    expect(rest.length).toBe(300);
  });

  // 19~20 joinSegmentTexts
  it("19 joinSegmentTexts：丢空段、原样相接不补标点", () => {
    expect(joinSegmentTexts(["你好", "", "  世界 "])).toBe("你好世界");
  });

  it("20 joinSegmentTexts：全空 → 空串", () => {
    expect(joinSegmentTexts(["", ""])).toBe("");
  });

  // 21 引擎形状
  it("21 引擎形状：kind=asr / locality=local / 有 transcribe / 没有 synthesize", () => {
    const e: VoiceEngine = new SherpaOnnxAsrEngine();
    expect(e.kind).toBe("asr");
    expect(e.locality).toBe("local");
    expect(e.streaming).toBe(false);
    expect(typeof e.transcribe).toBe("function");
    expect(e.synthesize).toBeUndefined();
  });

  // 22 加载器的人话错误（不依赖插件是否安装）
  it("22 loadSherpaModule('__no_such_module__') → VoiceError，信息含 npm install", async () => {
    await expect(loadSherpaModule("__no_such_module__")).rejects.toThrow(VoiceError);
    await expect(loadSherpaModule("__no_such_module__")).rejects.toThrow(/npm install/);
  });

  // 23 mp3 明确报错（D6）
  it("23 toModelAudio(mp3) → VoiceError，信息含 mp3", () => {
    expect(() => toModelAudio(new Uint8Array(10), "mp3")).toThrow(VoiceError);
    expect(() => toModelAudio(new Uint8Array(10), "mp3")).toThrow(/mp3/);
  });

  // 24 空音频守卫在 ensureStarted 之前（插件缺失也过 —— 证明不加载插件）
  it("24 空音频 transcribe() → { text:'', isFinal:true }，且不加载插件", async () => {
    const e = createSherpaAsrEngine();
    await expect(e.transcribe!({ audio: new Uint8Array(0), format: "wav" })).resolves.toEqual({
      text: "",
      isFinal: true,
    });
  });

  // ===== 注册链（与 4.5.1 §10.A 第 17 条同形）=====
  it("25 注册后 ASR 链只有 sherpa-onnx，TTS 链里没有它", () => {
    const reg = new VoiceRegistry();
    reg.register(createSherpaAsrEngine());
    reg.register(createGptSovitsEngine());
    expect(reg.resolveChain("asr")).toEqual(["sherpa-onnx"]);
    expect(reg.resolveChain("tts")).toEqual(["gpt-sovits"]);
  });

  it("26 五引擎全注册后：ASR 链 ['sherpa-onnx']，TTS 链顺序不变（registry 只加一行不搅局）", () => {
    const reg = new VoiceRegistry();
    reg.register(createGptSovitsEngine());
    reg.register(createOpenAiTtsEngine());
    reg.register(createMiniMaxEngine());
    reg.register(createEdgeTtsEngine());
    reg.register(createSherpaAsrEngine());
    expect(reg.resolveChain("asr")).toEqual(["sherpa-onnx"]);
    expect(reg.resolveChain("tts")).toEqual(["gpt-sovits", "openai-tts", "minimax", "edge-tts"]);
  });

  it("27 preferredId 传 TTS 引擎 id 时 ASR 链不串台", () => {
    const reg = new VoiceRegistry();
    reg.register(createSherpaAsrEngine());
    reg.register(createEdgeTtsEngine());
    expect(reg.resolveChain("asr", { preferredId: "edge-tts" })).toEqual(["sherpa-onnx"]);
  });

  // ===== health() 只查文件（D8：不需要插件就能测）=====
  it("28 health()：文件不存在 → unavailable，detail 含「不存在」", async () => {
    const stored: VoiceConfigValues = {
      modelPath: "Z:\\no-such-dir\\model.int8.onnx",
      tokensPath: "Z:\\no-such-dir\\tokens.txt",
    };
    const e = createSherpaAsrEngine(() => stored);
    const h = await e.health!();
    expect(h.availability).toBe("unavailable");
    expect(h.detail).toContain("不存在");
  });
});
