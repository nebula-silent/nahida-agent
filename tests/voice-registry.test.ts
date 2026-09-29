// 4.3 §9.A：注册表 / 降级链 / 形状校验的表驱动测试。
// 这是本步验收的**主要**依据 —— 「她能不能降级」用截图和手点是验不出来的。
// ⚠️ 假引擎的 id 一律用占位名（local-a / cloud-a …），**不许用真实引擎名**
//    —— 真实引擎要到 4.4~4.8 才落地，这里出现名字就违反了 §8 第 3 条。
import { describe, expect, it } from "vitest";
import { VoiceRegistry } from "../src/main/voice/registry";
import { VoiceError, type VoiceEngine, type SynthesizeOutput } from "../src/shared/voice/types";

/** 造一个假引擎；over 里传什么就覆盖什么（显式传 undefined 也会覆盖） */
function fakeEngine(over: Partial<VoiceEngine> & Pick<VoiceEngine, "id">): VoiceEngine {
  return {
    name: over.id,
    kind: "tts",
    locality: "local",
    streaming: false,
    configSchema: [],
    synthesize: async (): Promise<SynthesizeOutput> => ({ audio: new Uint8Array([1]), format: "wav" }),
    ...over,
  };
}

describe("1. 空注册表", () => {
  it("list / summaries / listByKind 都是空数组", async () => {
    const r = new VoiceRegistry();
    expect(r.list()).toEqual([]);
    expect(await r.summaries()).toEqual([]);
    expect(r.listByKind("tts")).toEqual([]);
    expect(r.listByKind("asr")).toEqual([]);
  });
});

describe("2. 注册顺序", () => {
  it("list() 长度 2 且顺序 = 注册顺序", () => {
    const r = new VoiceRegistry();
    r.register(fakeEngine({ id: "local-b" }));
    r.register(fakeEngine({ id: "local-a" }));
    expect(r.list().map((e) => e.id)).toEqual(["local-b", "local-a"]);
  });
});

describe("3~7. 形状校验（把错误拦在启动期）", () => {
  it("3. 重复 id → 抛 VoiceError，message 含那个 id", () => {
    const r = new VoiceRegistry();
    r.register(fakeEngine({ id: "local-a" }));
    expect(() => r.register(fakeEngine({ id: "local-a" }))).toThrow(VoiceError);
    expect(() => r.register(fakeEngine({ id: "local-a" }))).toThrow(/local-a/);
  });

  it("4. id 为空串 / 带首尾空格 → 抛", () => {
    const r = new VoiceRegistry();
    expect(() => r.register(fakeEngine({ id: "" }))).toThrow(VoiceError);
    expect(() => r.register(fakeEngine({ id: " local-a " }))).toThrow(VoiceError);
  });

  it("5. tts 引擎不传 synthesize → 抛", () => {
    const r = new VoiceRegistry();
    expect(() => r.register(fakeEngine({ id: "local-a", synthesize: undefined }))).toThrow(VoiceError);
  });

  it("6. asr 引擎不传 transcribe → 抛", () => {
    const r = new VoiceRegistry();
    expect(() =>
      r.register(fakeEngine({ id: "local-a", kind: "asr", synthesize: undefined, transcribe: undefined })),
    ).toThrow(VoiceError);
  });

  it("7. configSchema 里 select 没给 options → 抛", () => {
    const r = new VoiceRegistry();
    expect(() =>
      r.register(
        fakeEngine({
          id: "local-a",
          configSchema: [{ key: "voice", label: "音色", type: "select" }],
        }),
      ),
    ).toThrow(VoiceError);
  });
});

describe("8. listByKind 分类", () => {
  it("2 tts + 1 asr 时各回各的", () => {
    const r = new VoiceRegistry();
    r.register(fakeEngine({ id: "local-a" }));
    r.register(fakeEngine({ id: "cloud-a", locality: "cloud" }));
    r.register(
      fakeEngine({
        id: "local-asr",
        kind: "asr",
        synthesize: undefined,
        transcribe: async () => ({ text: "hi", isFinal: true }),
      }),
    );
    expect(r.listByKind("tts").map((e) => e.id)).toEqual(["local-a", "cloud-a"]);
    expect(r.listByKind("asr").map((e) => e.id)).toEqual(["local-asr"]);
  });
});

describe("9~10. 降级链顺序", () => {
  it("9. 本地全在云端之前（注册 1 云端 + 2 本地）", () => {
    const r = new VoiceRegistry();
    r.register(fakeEngine({ id: "cloud-a", locality: "cloud" }));
    r.register(fakeEngine({ id: "local-a" }));
    r.register(fakeEngine({ id: "local-b" }));
    expect(r.resolveChain("tts")).toEqual(["local-a", "local-b", "cloud-a"]);
  });

  it("10. preferredId 置顶且不重复出现", () => {
    const r = new VoiceRegistry();
    r.register(fakeEngine({ id: "cloud-a", locality: "cloud" }));
    r.register(fakeEngine({ id: "local-a" }));
    r.register(fakeEngine({ id: "local-b" }));
    const chain = r.resolveChain("tts", { preferredId: "cloud-a" });
    expect(chain).toEqual(["cloud-a", "local-a", "local-b"]);
    expect(new Set(chain).size).toBe(chain.length);
  });
});

describe("11. health()", () => {
  it("未注册 → unavailable + 人话 detail", async () => {
    const r = new VoiceRegistry();
    const h = await r.health("nope");
    expect(h.availability).toBe("unavailable");
    expect(h.detail).toBeTruthy();
  });

  it("没实现 health() 的引擎 → ready", async () => {
    const r = new VoiceRegistry();
    r.register(fakeEngine({ id: "local-a" }));
    expect((await r.health("local-a")).availability).toBe("ready");
  });

  it("health() 抛错 → unavailable + 那个错的人话", async () => {
    const r = new VoiceRegistry();
    r.register(
      fakeEngine({
        id: "local-a",
        health: async () => {
          throw new Error("服务没起来");
        },
      }),
    );
    const h = await r.health("local-a");
    expect(h.availability).toBe("unavailable");
    expect(h.detail).toBe("服务没起来");
  });
});

describe("12~14. 降级链执行", () => {
  it("12. 第 1 个不可用跳过、第 2 个抛错、第 3 个成功 → engineId = 第 3 个、degraded 长度 2", async () => {
    const r = new VoiceRegistry();
    // 注册顺序故意把云端放最前：链的顺序必须是「本地优先」，不是注册顺序
    r.register(fakeEngine({ id: "cloud-a", locality: "cloud" }));
    r.register(
      fakeEngine({
        id: "local-a",
        health: async () => ({ availability: "unavailable", detail: "没起服务" }),
      }),
    );
    r.register(
      fakeEngine({
        id: "local-b",
        synthesize: async () => {
          throw new Error("合成失败");
        },
      }),
    );

    const res = await r.synthesize({ text: "你好" });
    expect(res.engineId).toBe("cloud-a"); // 本地两个都失败 → 降级到云端
    expect(res.locality).toBe("cloud");
    expect(res.degraded).toHaveLength(2);
    expect(res.degraded[0]).toContain("没起服务");
    expect(res.degraded[1]).toContain("合成失败");
    expect(res.format).toBe("wav");
  });

  it("13. 第 1 个就成功 → degraded 是 []", async () => {
    const r = new VoiceRegistry();
    r.register(fakeEngine({ id: "local-a" }));
    r.register(fakeEngine({ id: "local-b" }));
    const res = await r.synthesize({ text: "你好" });
    expect(res.engineId).toBe("local-a");
    expect(res.degraded).toEqual([]);
  });

  it("14. 全失败 → 抛 VoiceError，且每个引擎的名字与原因都在 message 里", async () => {
    const r = new VoiceRegistry();
    r.register(
      fakeEngine({ id: "local-a", health: async () => ({ availability: "unavailable", detail: "没起服务" }) }),
    );
    r.register(
      fakeEngine({
        id: "local-b",
        synthesize: async () => {
          throw new Error("超时了");
        },
      }),
    );
    r.register(
      fakeEngine({
        id: "local-c",
        synthesize: async () => {
          throw new Error("返回了空音频");
        },
      }),
    );

    await expect(r.synthesize({ text: "你好" })).rejects.toThrow(VoiceError);
    try {
      await r.synthesize({ text: "你好" });
      throw new Error("不该走到这里");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("没起服务");
      expect(msg).toContain("超时了");
      expect(msg).toContain("返回了空音频");
    }
  });

  it("14b. 链上没有任何引擎 → 抛 VoiceError（人话）", async () => {
    const r = new VoiceRegistry();
    await expect(r.synthesize({ text: "你好" })).rejects.toThrow(/没有可用的语音合成引擎/);
  });
});

describe("15. summaries() 是纯数据投影（没有函数漏出去）", () => {
  it("每一项可 JSON 往返不丢数据", async () => {
    const r = new VoiceRegistry();
    r.register(
      fakeEngine({
        id: "local-a",
        name: "占位本地引擎",
        streaming: true,
        configSchema: [
          { key: "endpoint", label: "服务地址", type: "text", required: true, default: "http://127.0.0.1:1" },
          { key: "speed", label: "语速", type: "number", min: 0.5, max: 2, step: 0.1, default: 1 },
          {
            key: "tone",
            label: "音色",
            type: "select",
            options: [
              { value: "a", label: "甲" },
              { value: "b", label: "乙" },
            ],
          },
        ],
      }),
    );
    r.register(
      fakeEngine({
        id: "cloud-a",
        locality: "cloud",
        name: "占位云端引擎",
        health: async () => ({ availability: "unavailable", detail: "没配密钥" }),
      }),
    );

    const list = await r.summaries();
    const round = JSON.parse(JSON.stringify(list)) as typeof list;

    expect(round).toEqual(list);
    // 投影里不许出现任何函数（证明 synthesize / health / start / stop 都没漏出去）
    for (const s of list) {
      for (const v of Object.values(s)) expect(typeof v).not.toBe("function");
    }
    expect(round[0].configSchema).toHaveLength(3);
    expect(round[1].availability).toBe("unavailable");
    expect(round[1].detail).toBe("没配密钥");
  });
});

describe("16. preferredId 必须同 kind（4.6 D6，指令 §10.A 第 13 条）", () => {
  it("preferredId 是别的 kind 的引擎 → 被忽略，退回纯本地优先", () => {
    const r = new VoiceRegistry();
    r.register(fakeEngine({ id: "a" })); // tts
    r.register(
      fakeEngine({
        id: "b",
        kind: "asr",
        synthesize: undefined,
        transcribe: async () => ({ text: "hi", isFinal: true }),
      }),
    );
    // 用 TTS 引擎 a 当 ASR 链的 preferred → 被忽略（否则 runChain 会调它不存在的 transcribe()，
    // 记一条假的降级原因 —— 「幻影降级」）
    expect(r.resolveChain("asr", { preferredId: "a" })).toEqual(["b"]);
    // 同 kind 的 preferred 照常置顶
    expect(r.resolveChain("tts", { preferredId: "a" })).toEqual(["a"]);
  });
});