// 4.5.1 验收主依据（任务清单 §11.A）：Edge 朗读引擎 16 条表驱动用例。
// **全部纯函数、零网络** —— 这也是引擎里那些 `export` 的原因（§6 已注明「只为单测」）。
// ⚠️ configSchema 不从引擎模块导出（同 4.5 的规矩：不为测试改产品代码），一律 new 实例取。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EdgeTtsEngine,
  buildSsml,
  edgeTimestamp,
  escapeXml,
  generateSecMsGec,
  parseAudioFrame,
  removeIncompatibleChars,
  resolveEdgeVersion,
  speechConfigMessage,
  speedToRatePercent,
  ssmlMessage,
} from "../src/main/voice/engines/edge-tts";
import { createEdgeTtsEngine } from "../src/main/voice/engines/edge-tts";
import { createGptSovitsEngine } from "../src/main/voice/engines/gpt-sovits";
import { createOpenAiTtsEngine } from "../src/main/voice/engines/openai-tts";
import { createMiniMaxEngine } from "../src/main/voice/engines/minimax";
import { VoiceRegistry } from "../src/main/voice/registry";
import { VoiceError, type VoiceEngine } from "../src/shared/voice/types";

/** 每次从实例上取同一份只读引用（schema 不从引擎模块导出） */
const SCHEMA = new EdgeTtsEngine().configSchema;

/** 把 header 长度写进前 2 字节大端，拼一个「[2 字节 len][header][audio]」帧 */
function frameOf(header: string, audio: Buffer): Buffer {
  const head = Buffer.from(header, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(head.length, 0);
  return Buffer.concat([len, head, audio]);
}

afterEach(() => {
  vi.useRealTimers(); // 用例 5 / 6 会冻结时间，必须还原，否则污染后续用例
});

describe("4.5.1 Edge 朗读引擎（edge-tts）", () => {
  // 1~4 configSchema 形状：零配置在契约层的体现
  it("1 configSchema 里一个必填项都没有", () => {
    expect(SCHEMA.every((f) => !f.required)).toBe(true);
  });

  it("2 configSchema 里一个 secret 都没有", () => {
    expect(SCHEMA.every((f) => !f.secret)).toBe(true);
  });

  it("3 voice 是 select 且有 8 个选项，value 都以 zh- 开头", () => {
    const voice = SCHEMA.find((f) => f.key === "voice");
    expect(voice?.type).toBe("select");
    expect(voice?.options?.length).toBe(8);
    for (const o of voice?.options ?? []) expect(o.value.startsWith("zh-")).toBe(true);
  });

  it("4 speed 键名与 4.4 一致，范围 0.5~2", () => {
    const speed = SCHEMA.find((f) => f.key === "speed");
    expect(speed?.type).toBe("number");
    expect(speed?.min).toBe(0.5);
    expect(speed?.max).toBe(2);
  });

  // 5~6 令牌
  it("5 generateSecMsGec 确定性：同参数两次相同，且是 64 位大写十六进制", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T12:00:01Z"));
    const a = generateSecMsGec();
    const b = generateSecMsGec();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9A-F]{64}$/);
  });

  it("6 5 分钟窗口内令牌相同，跨窗口不同", () => {
    vi.useFakeTimers();

    vi.setSystemTime(new Date("2026-09-27T12:00:01Z"));
    const t1 = generateSecMsGec();
    vi.setSystemTime(new Date("2026-09-27T12:04:59Z"));
    const t2 = generateSecMsGec();
    vi.setSystemTime(new Date("2026-09-27T12:05:01Z"));
    const t3 = generateSecMsGec();

    expect(t2).toBe(t1); // 同属 [12:00, 12:05)
    expect(t3).not.toBe(t1); // 进了下一个窗口
  });

  // 7~10 文本处理与时间戳
  it("7 removeIncompatibleChars 把控制字符换成空格，中文原样", () => {
    expect(removeIncompatibleChars("a\u000bb\u0007c")).toBe("a b c");
    expect(removeIncompatibleChars("你好，纳西妲")).toBe("你好，纳西妲");
  });

  it("8 escapeXml 先换 & 再换 < >（不许出现 &amp;amp;）", () => {
    expect(escapeXml("a&b<c>d")).toBe("a&amp;b&lt;c&gt;d");
  });

  it("9 speedToRatePercent 倍率换算", () => {
    expect(speedToRatePercent(1)).toBe("+0%");
    expect(speedToRatePercent(1.15)).toBe("+15%");
    expect(speedToRatePercent(0.85)).toBe("-15%");
    expect(speedToRatePercent(2)).toBe("+100%");
  });

  it("10 edgeTimestamp 是服务端要的 UTC 格式", () => {
    const s = edgeTimestamp(new Date(Date.UTC(2026, 8, 27, 4, 30, 0)));
    expect(s).toBe("Sun Sep 27 2026 04:30:00 GMT+0000 (Coordinated Universal Time)");
    expect(s).toMatch(/^\w{3} \w{3} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT\+0000 \(Coordinated Universal Time\)$/);
  });

  // 11~12 两条报文
  it("11 speechConfigMessage：X-Timestamp 开头 + Path:speech.config + body 可 JSON.parse", () => {
    const msg = speechConfigMessage();
    expect(msg.startsWith("X-Timestamp:")).toBe(true);
    expect(msg).toContain("Path:speech.config\r\n\r\n");

    const body = msg.slice(msg.indexOf("\r\n\r\n") + 4);
    const parsed = JSON.parse(body.trim());
    expect(parsed.context.synthesis.audio.outputFormat).toBe("audio-24khz-48kbitrate-mono-mp3");
  });

  it("12 ssmlMessage：Path:ssml + X-Timestamp 尾部多余的 Z", () => {
    const ssml = buildSsml("zh-CN-XiaoxiaoNeural", "+0%", "你好");
    const msg = ssmlMessage("abc123", ssml);
    expect(msg).toContain("Path:ssml\r\n\r\n");
    expect(msg).toMatch(/X-Timestamp:.+Z\r\n/);
    expect(msg.endsWith(ssml)).toBe(true);
  });

  // 13~14 二进制帧解析（偏移量是本步最容易错的地方）
  it("13 parseAudioFrame 偏移：audio 恰好是分隔后的那 4 字节", () => {
    const audio = Buffer.from([0xff, 0xf3, 0x11, 0x22]);
    const frame = frameOf("Path:audio", audio); // header 恰 10 字节

    const out = parseAudioFrame(frame);
    expect(out.path).toBe("audio");
    expect(out.audio.length).toBe(4);
    expect(out.audio.equals(audio)).toBe(true);
  });

  it("14 parseAudioFrame 从头部取 Path（audio.metadata）", () => {
    const out = parseAudioFrame(frameOf("Path:audio.metadata\r\n", Buffer.alloc(0)));
    expect(out.path).toBe("audio.metadata");
    expect(out.audio.length).toBe(0);
  });

  // 15~16 synthesize 的入口校验（都在连接之前抛出，故零网络）
  it("15 音色名校验：合法名过、非法名与空串被拒", async () => {
    const engine = new EdgeTtsEngine();

    // 合法音色 → 校验通过，错误停在后面的「文本是空的」（说明音色那关已过）
    const ok = await engine
      .synthesize({ text: "   ", overrides: { voice: "zh-CN-XiaoxiaoNeural" } })
      .catch((e: unknown) => e);
    expect(ok).toBeInstanceOf(VoiceError);
    expect((ok as Error).message).toContain("文本是空的");

    for (const bad of ["a'b", "a b", ""]) {
      const err = await engine.synthesize({ text: "你好", overrides: { voice: bad } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VoiceError);
      expect((err as Error).message).toContain("音色名不合法");
    }
  });

  it("16 超长文本被拒（在连接之前抛，零网络）", async () => {
    const long = "啊".repeat(2000); // 6000 字节 > 4096
    const err = await new EdgeTtsEngine().synthesize({ text: long }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceError);
    expect((err as Error).message).toContain("文本过长");
  });

  // 4.9.8 S4：Edge 版本常量提成配置项 —— 只测「配置项能覆盖默认值」，不测默认值本身的有效性
  it("17 resolveEdgeVersion：留空回落内置默认，填了就覆盖（major/gec 跟着派生）", () => {
    const fallback = resolveEdgeVersion({});
    expect(fallback.full).toBeTruthy();
    expect(fallback.gec).toBe(`1-${fallback.full}`);
    expect(fallback.major).toBe(fallback.full.split(".")[0]);
    // 留空串 / 未配置 = 同一个内置默认
    expect(resolveEdgeVersion({ edgeVersion: "" })).toEqual(fallback);
    // 填了 → 覆盖，三个派生值一致跟着走
    const v = resolveEdgeVersion({ edgeVersion: "999.0.1.2" });
    expect(v.full).toBe("999.0.1.2");
    expect(v.major).toBe("999");
    expect(v.gec).toBe("1-999.0.1.2");
    expect(v).not.toEqual(fallback);
  });
});

// 注册链形状：确认 edge-tts 能被注册表认下来，且排在所有云端引擎之后（零配置兜底）
describe("4.5.1 注册链形状", () => {
  it("edge-tts 通过 assertEngineShape，且是 tts 链的最后一环", () => {
    const r = new VoiceRegistry();
    for (const e of [
      createGptSovitsEngine(),
      createOpenAiTtsEngine(),
      createMiniMaxEngine(),
      createEdgeTtsEngine(),
    ] as VoiceEngine[]) {
      expect(() => r.register(e)).not.toThrow();
    }
    expect(r.resolveChain("tts")).toEqual(["gpt-sovits", "openai-tts", "minimax", "edge-tts"]);
  });
});