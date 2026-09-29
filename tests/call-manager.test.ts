// 4.9.7 §4（N11）：通话状态机 + 能量门的假 deps 测试。
// call-manager 零 electron / 零 I/O（D1）—— 假 deps 顶替挑 ASR / 合成 / chat / 会话 / 事件，
// 不加载 onnx、不碰窗口，vitest 裸跑。能量门用例（§4.3）并入本文件。
import { describe, expect, it } from "vitest";
import { FRAME_MS, type CallStateEvent, type CallTtsEvent } from "../src/shared/voice/call";
import { EnergyGate, SilenceDetector, rmsOf } from "../src/main/voice/energy-gate";
import { CallManager, type CallDeps } from "../src/main/voice/call-manager";

const ASR_INFO = { id: "fake", name: "假引擎", locality: "local" } as const;
const TTS_ENGINE = { id: "fake", name: "假TTS", locality: "local" } as const;

/**
 * 一帧采集字节：200ms @ 16k 单声道 16bit = 6400 字节（全 0 = 静音）。
 * ⚠️ 必须 ≥ MIN_TURN_BYTES（200ms）：单帧 100ms 会被 endTurn 当「没听见」整轮丢掉，用例全空转。
 */
const silentFrame = (): Uint8Array => new Uint8Array(6400);
/** 一帧「响」的字节：全部采样 0.5（16384）→ rms 0.5 ≥ 打断阈值 */
const loudFrame = (): Uint8Array => {
  const bytes = new Uint8Array(6400);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 3200; i += 1) view.setInt16(i * 2, 16384, true);
  return bytes;
};
const loudSamples = (): Float32Array => new Float32Array(1600).fill(0.5);

/**
 * endTurn / speakChain 全是 then 微任务链 —— 断言前把链冲落定：
 * 20 轮微任务 + 一个宏任务，足够覆盖「识别 → chat → 入队 → 合成 → 事件」整条链。
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function makeDeps(over: Partial<CallDeps> = {}): {
  deps: CallDeps;
  events: CallStateEvent[];
  tts: CallTtsEvent[];
  errors: string[];
} {
  const events: CallStateEvent[] = [];
  const tts: CallTtsEvent[] = [];
  const errors: string[] = [];
  const deps: CallDeps = {
    pickAsr: async () => ({ info: ASR_INFO, degraded: [], run: async () => "你好" }),
    synthesize: async () => ({
      audio: new Uint8Array([1, 2]),
      format: "wav",
      engine: TTS_ENGINE,
      degraded: [],
    }),
    runChat: async ({ onDelta }) => {
      onDelta("好。");
      onDelta("我在。");
    },
    readLatestSession: () => [],
    appendMessages: () => {},
    createTurnDetector: async () => ({
      // 假 detector：一喂就判「一轮结束」（比指令骨架多补 isSpeaking —— TurnDetector 接口要求它）
      detector: { mode: "rms", feed() {}, takeTurnEnd: () => true, isSpeaking: () => false, reset() {} },
      note: undefined,
    }),
    createBargeGate: () => new EnergyGate({ frameMs: FRAME_MS }),
    emit: {
      state: (e) => events.push(e),
      asr: () => {},
      tts: (e) => tts.push(e),
      error: (message) => errors.push(message),
    },
    ...over,
  };
  return { deps, events, tts, errors };
}

describe("CallManager：状态迁移与打断", () => {
  it("1. 全链 IDLE→LISTENING→THINKING→SPEAKING→LISTENING", async () => {
    const { deps, events } = makeDeps();
    const call = new CallManager(deps);
    expect(call.getState()).toBe("IDLE");
    const started = await call.start();
    expect(started.ok).toBe(true);
    expect(call.getState()).toBe("LISTENING");
    call.handleFrame(silentFrame()); // 假 detector 一喂就判轮次结束
    await flush(); // → THINKING → 尾巴「好。我在。」入队合成 → SPEAKING
    expect(call.getState()).toBe("SPEAKING");
    call.onPlaybackDone(); // turnSynthDone 已置真 → 这次回报生效
    expect(call.getState()).toBe("LISTENING");
    expect(events.map((e) => e.state)).toEqual(["LISTENING", "THINKING", "SPEAKING", "LISTENING"]);
  });

  it("2. 挑不到 ASR：start 返回 {ok:false}，状态 ERROR", async () => {
    const { deps, events, errors } = makeDeps({
      pickAsr: async () => {
        throw new Error("没有可用的识别引擎");
      },
    });
    const call = new CallManager(deps);
    const result = await call.start();
    expect(result.ok).toBe(false);
    expect(result.error).toBe("没有可用的识别引擎");
    expect(call.getState()).toBe("ERROR");
    expect(events.at(-1)?.state).toBe("ERROR");
    expect(errors).toEqual(["没有可用的识别引擎"]);
  });

  it("3. 识别为空：静默回 LISTENING，无 error 事件", async () => {
    const { deps, errors, tts } = makeDeps({
      pickAsr: async () => ({ info: ASR_INFO, degraded: [], run: async () => "  " }),
    });
    const call = new CallManager(deps);
    await call.start();
    call.handleFrame(silentFrame());
    await flush();
    expect(call.getState()).toBe("LISTENING");
    expect(errors).toEqual([]);
    expect(tts).toEqual([]);
  });

  it("4. THINKING 期丢帧：不触发打断、状态不变", async () => {
    let resolveAsr!: (text: string) => void;
    const { deps, tts } = makeDeps({
      pickAsr: async () => ({
        info: ASR_INFO,
        degraded: [],
        run: () =>
          new Promise<string>((resolve) => {
            resolveAsr = resolve;
          }),
      }),
    });
    const call = new CallManager(deps);
    await call.start();
    call.handleFrame(silentFrame()); // endTurn 的同步段立即执行：THINKING
    expect(call.getState()).toBe("THINKING");
    call.handleFrame(silentFrame()); // THINKING 期再喂 → 丢弃（D8）
    call.handleFrame(silentFrame());
    expect(call.getState()).toBe("THINKING");
    expect(tts).toEqual([]);
    resolveAsr("你好"); // 放行收尾，别让用例留下悬空的识别
    await flush();
    expect(call.getState()).toBe("SPEAKING");
    call.hangup();
  });

  it("5. 打断：连续够 BARGE_IN_HOLD_MS 的有声帧 → stop + 回 LISTENING + 预滚帧并入新一轮", async () => {
    const asrAudios: Uint8Array[] = [];
    const { deps, tts } = makeDeps();
    deps.pickAsr = async () => ({
      info: ASR_INFO,
      degraded: [],
      run: async (audio) => {
        asrAudios.push(audio);
        return "你好";
      },
    });
    const call = new CallManager(deps);
    await call.start();
    call.handleFrame(silentFrame());
    await flush();
    expect(call.getState()).toBe("SPEAKING");
    expect(asrAudios[0].byteLength).toBe(44 + 6400); // 首轮：1 帧 + wav 头
    call.handleFrame(loudFrame()); // loudMs=100 < 300
    expect(call.getState()).toBe("SPEAKING");
    call.handleFrame(loudFrame()); // loudMs=200 < 300
    call.handleFrame(loudFrame()); // loudMs=300 → bargeIn！
    expect(call.getState()).toBe("LISTENING");
    expect(tts.at(-1)).toEqual({ kind: "stop" }); // 渲染端立即停播
    // 预滚帧（3×6400）当新一轮开头（D7）：下一帧触发 endTurn，识别收到 44 + 4×6400 的 wav
    call.handleFrame(silentFrame());
    await flush();
    expect(asrAudios).toHaveLength(2);
    expect(asrAudios[1].byteLength).toBe(44 + 4 * 6400);
    call.hangup();
  });

  it("6. 早排空忽略：turnSynthDone=false 时 onPlaybackDone → 仍 SPEAKING", async () => {
    let releaseChat!: () => void;
    const { deps } = makeDeps({
      runChat: async ({ onDelta }) => {
        onDelta("今天辛苦啦，我们慢慢来。"); // 12 字 ≥ 8 → 早播入队
        await new Promise<void>((resolve) => {
          releaseChat = resolve;
        });
        onDelta("我在。"); // 尾巴：runChat 返回后才入队
      },
    });
    const call = new CallManager(deps);
    await call.start();
    call.handleFrame(silentFrame());
    await flush(); // 第一句已送出 → SPEAKING；runChat 还挂着 → turnSynthDone=false
    expect(call.getState()).toBe("SPEAKING");
    call.onPlaybackDone(); // 后面还有句子要播 → 忽略
    expect(call.getState()).toBe("SPEAKING");
    releaseChat();
    await flush(); // 尾巴「我在。」入队播完 → turnSynthDone=true
    expect(call.getState()).toBe("SPEAKING");
    call.onPlaybackDone(); // 最后一句播完的那次回报才生效
    expect(call.getState()).toBe("LISTENING");
  });

  it("7. 挂断：LISTENING 期 hangup → IDLE + 停播事件", async () => {
    const { deps, tts } = makeDeps();
    const call = new CallManager(deps);
    await call.start();
    expect(call.getState()).toBe("LISTENING");
    call.hangup();
    expect(call.getState()).toBe("IDLE");
    expect(tts.at(-1)).toEqual({ kind: "stop" });
  });

  it("8. 空回复不卡死：runChat 不吐字 → THINKING 直接回 LISTENING", async () => {
    const { deps, events, errors, tts } = makeDeps({
      runChat: async () => {}, // 一句都不吐
    });
    const call = new CallManager(deps);
    await call.start();
    call.handleFrame(silentFrame());
    await flush();
    expect(call.getState()).toBe("LISTENING"); // 不卡在 THINKING / SPEAKING
    expect(errors).toEqual([]);
    expect(tts).toEqual([]);
    expect(events.at(-1)?.state).toBe("LISTENING");
  });
});

describe("能量门与静音检测（D6）", () => {
  const makeGate = () => new EnergyGate({ threshold: 0.1, holdMs: 300, frameMs: 100 });
  const quietSamples = (): Float32Array => new Float32Array(1600).fill(0.01); // rms 0.01 < 0.1

  it("1. 恒静音 → feed 恒 false", () => {
    const gate = makeGate();
    for (let i = 0; i < 10; i += 1) expect(gate.feed(quietSamples())).toBe(false);
  });

  it("2. 连续有声：累计达 holdMs 那一帧才 true", () => {
    const gate = makeGate();
    expect(gate.feed(loudSamples())).toBe(false); // 100ms
    expect(gate.feed(loudSamples())).toBe(false); // 200ms
    expect(gate.feed(loudSamples())).toBe(true); // 300ms 达标
    expect(gate.feed(loudSamples())).toBe(true); // 之后仍保持
  });

  it("3. 中途一帧静音 → loudMs 归零，不触发", () => {
    const gate = makeGate();
    gate.feed(loudSamples());
    gate.feed(loudSamples());
    gate.feed(quietSamples()); // 清零：断续的响不许累加
    expect(gate.feed(loudSamples())).toBe(false); // 重新数：100ms
    expect(gate.feed(loudSamples())).toBe(false); // 200ms
    expect(gate.feed(loudSamples())).toBe(true); // 300ms 才算
  });

  it("4. rms 低于阈值 → 永不触发（哪怕贴着阈值）", () => {
    const gate = makeGate();
    const almost = new Float32Array(1600).fill(0.09); // rms 0.09 < 0.1
    for (let i = 0; i < 10; i += 1) expect(gate.feed(almost)).toBe(false);
  });

  it("5. rmsOf 空数组 → 0（不是 NaN）", () => {
    expect(rmsOf(new Float32Array(0))).toBe(0);
  });

  it("6. SilenceDetector：没开口不算说完；开口后静音够久才置 ended，取一次清一次", () => {
    const detector = new SilenceDetector({ threshold: 0.1, silenceMs: 300, frameMs: 100 });
    const loud = new Float32Array(1600).fill(0.5);
    const quiet = new Float32Array(1600).fill(0);
    for (let i = 0; i < 5; i += 1) detector.feed(quiet); // 没开过口：静音再久也不算说完
    expect(detector.takeEnded()).toBe(false);
    detector.feed(loud); // 开口
    detector.feed(quiet);
    detector.feed(quiet); // 静音 200ms < 300ms
    expect(detector.takeEnded()).toBe(false);
    detector.feed(quiet); // 300ms 达标
    expect(detector.takeEnded()).toBe(true); // 取走
    expect(detector.takeEnded()).toBe(false); // 取一次清一次
  });
});
