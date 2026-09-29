// 4.6 §10.A：语音配置消毒 + 接缝闭环的表驱动测试。
// 纯函数、零 electron、零网络（第 12 条靠「不存在的路径」证明注入真的接上了，不碰文件系统）。
import { describe, expect, it } from "vitest";
import {
  sanitizeVoiceValues,
  sanitizeVoiceEngines,
  sanitizeVoiceConfig,
} from "../src/shared/voice/types";
import { createGptSovitsEngine } from "../src/main/voice/engines/gpt-sovits";

describe("sanitizeVoiceValues：只留白名单叶子", () => {
  it("1. 对象 / 数组 / null 叶子一律丢，string·number·boolean 留下", () => {
    const out = sanitizeVoiceValues({ a: "x", b: 1, c: true, d: null, e: {}, f: [1] });
    expect(out).toEqual({ a: "x", b: 1, c: true });
  });

  it("2. NaN / ±Infinity 挡掉，有限 number 保留（0 也是合法值）", () => {
    const out = sanitizeVoiceValues({ a: NaN, b: Infinity, c: -Infinity, d: 0 });
    expect(out).toEqual({ d: 0 });
  });

  it("3. 原型污染键静默丢弃", () => {
    const out = sanitizeVoiceValues(JSON.parse('{"__proto__":1,"constructor":2,"prototype":3,"ok":4}'));
    expect(out).toEqual({ ok: 4 });
  });

  it("4. 非对象入参（null / 字符串 / 数字 / 数组）→ 空对象", () => {
    expect(sanitizeVoiceValues(null)).toEqual({});
    expect(sanitizeVoiceValues("x")).toEqual({});
    expect(sanitizeVoiceValues(42)).toEqual({});
    expect(sanitizeVoiceValues([1, 2])).toEqual({}); // 数组也要当非对象
  });

  it("5. 嵌套对象叶子被丢（结果里没有那个键，不会出现 undefined 值）", () => {
    const out = sanitizeVoiceValues({ a: { b: 1 } });
    expect(Object.hasOwn(out, "a")).toBe(false);
  });
});

describe("sanitizeVoiceEngines：未知 id 保留", () => {
  it("6. 引擎临时未注册时配置不丢", () => {
    const out = sanitizeVoiceEngines({ "future-engine": { k: "v" } });
    expect(Object.hasOwn(out, "future-engine")).toBe(true);
    expect(out["future-engine"]).toEqual({ k: "v" });
  });

  it("7. 引擎值不是对象 → id 不丢、值清空", () => {
    const out = sanitizeVoiceEngines({ a: 5 });
    expect(out).toEqual({ a: {} });
  });

  it("8. 引擎 id 是原型污染键 → 被丢，其余保留", () => {
    const out = sanitizeVoiceEngines(JSON.parse('{"__proto__":{"a":1},"ok":{"k":2}}'));
    expect(Object.hasOwn(out, "__proto__")).toBe(false);
    expect(out).toEqual({ ok: { k: 2 } });
  });
});

describe("sanitizeVoiceConfig：整个 voice 段", () => {
  it("9. 正常入参原样通过", () => {
    const out = sanitizeVoiceConfig({ preferredId: "edge-tts", engines: { a: { k: 1 } } });
    expect(out).toEqual({ preferredId: "edge-tts", engines: { a: { k: 1 } } });
  });

  it("10. preferredId 非字符串一律回落空串（不许 String() 强转）", () => {
    expect(sanitizeVoiceConfig({ preferredId: 123 }).preferredId).toBe("");
    expect(sanitizeVoiceConfig({ preferredId: null }).preferredId).toBe("");
  });

  it("11. 脏入参不炸", () => {
    expect(sanitizeVoiceConfig(undefined)).toEqual({ preferredId: "", engines: {} });
  });
});

describe("接缝闭环（D4）：工厂把 stored 读取器真的转给了引擎", () => {
  it("12. 注入后 health() 读的是注入值（不传时走 default 路径，detail 必然不同）", async () => {
    const missing = "Z:\\nahida-test\\不存在.mp3"; // 不存在的路径：零网络、零文件依赖
    const engine = createGptSovitsEngine(() => ({ refAudioPath: missing }));
    const h = await engine.health();
    expect(h.availability).toBe("unavailable");
    expect(h.detail).toContain(missing);
  });
});
