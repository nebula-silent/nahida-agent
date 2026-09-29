// 7.7：表情标签清单 + system 声明纯函数单测（不碰 DOM / electron）
// 8.12.2：+ IM 出站表情替换（独立 [词] → emoji）+ IM 表情使用提示
import { describe, expect, it } from "vitest";
import { EXPRESSIONS, expressionText, expressionToEmojiText } from "../src/shared/expression";
import {
  buildExpressionPrefix,
  buildImExpressionHint,
  withExpressionPrefix,
} from "../src/main/relationship/expression";

describe("shared/expression 清单", () => {
  it("10 条、key 唯一、label 唯一", () => {
    expect(EXPRESSIONS).toHaveLength(10);
    expect(new Set(EXPRESSIONS.map((e) => e.key)).size).toBe(10);
    expect(new Set(EXPRESSIONS.map((e) => e.label)).size).toBe(10);
    for (const e of EXPRESSIONS) {
      // 清单里 [哇] 是单字，其余两三个字；只要求非空、够短
      expect(e.label.length).toBeGreaterThanOrEqual(1);
      expect(e.label.length).toBeLessThanOrEqual(3);
      expect(e.meaning.length).toBeGreaterThan(0);
    }
  });

  it("发送文本 = [词]", () => {
    expect(expressionText({ key: "hug", label: "抱抱", meaning: "想靠近你（撒娇或求安慰，看语境）" })).toBe("[抱抱]");
  });
});

describe("buildExpressionPrefix", () => {
  it("10 个标签与各自默认倾向都在声明里", () => {
    const text = buildExpressionPrefix();
    for (const e of EXPRESSIONS) {
      expect(text).toContain(`[${e.label}]`);
      expect(text).toContain(`${expressionText(e)}=${e.meaning}`);
    }
  });

  it("逐字确定（无时间戳 / 随机量）", () => {
    expect(buildExpressionPrefix()).toBe(buildExpressionPrefix());
  });

  // 2026-09-28 用户拍板修正的回归锁：含义只作「默认倾向」，语气一律归语境
  it("语境优先 + 负面情绪兜底 + 反例都在，且不再有情绪定性", () => {
    const text = buildExpressionPrefix();
    expect(text).toContain("以语境为准");
    expect(text).toContain("求安慰");
    expect(text).toContain("禁止用欢快");
    expect(text).toContain("求安慰 / 求支持");
    // 曾经的 bug 源：含义表把 [抱抱] 定义成「开心」→ 用户难过时被欢快回应。
    // 含义表里不许再出现情绪定性（声明正文里的反例「不是开心」是有意保留的，故不锁正文）
    expect(EXPRESSIONS.every((e) => !/开心|撒娇亲近|俏皮|无辜/.test(e.meaning))).toBe(true);
    expect(EXPRESSIONS.find((e) => e.key === "hug")?.meaning).toContain("安慰");
  });
});

describe("withExpressionPrefix", () => {
  it("prefix 为空 → 返回原引用（零改动）", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    expect(withExpressionPrefix(messages, "")).toBe(messages);
  });

  it("非空 → 首插一条 system，不改原数组", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    const out = withExpressionPrefix(messages, "X");
    expect(out).not.toBe(messages);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: "system", content: "X" });
    expect(messages).toHaveLength(1);
  });
});
// 8.12.2：IM 出站表情替换 + IM 表情使用提示
describe("expressionToEmojiText：只认独立标签，绝不替代正文词语", () => {
  it("整条 / 句尾留空格 / 单独一行 → emoji", () => {
    expect(expressionToEmojiText("[抱抱]")).toBe("🤗");
    expect(expressionToEmojiText("好呀 [嘿嘿]")).toBe("好呀 😏");
    expect(expressionToEmojiText("先聊到这\n[好困]")).toBe("先聊到这\n💤");
  });

  it("句中紧贴文字的标签、裸文本、微信表情文本 → 一字不动", () => {
    expect(expressionToEmojiText("我真想抱抱你")).toBe("我真想抱抱你");
    expect(expressionToEmojiText("我真想[抱抱]你")).toBe("我真想[抱抱]你");
    expect(expressionToEmojiText("微信表情 [微笑] 也不动")).toBe("微信表情 [微笑] 也不动");
  });

  it("空串原样；连写 [哇][哇] 不算独立（铁律一致性优先）", () => {
    expect(expressionToEmojiText("")).toBe("");
    expect(expressionToEmojiText("[哇][哇]")).toBe("[哇][哇]");
  });
});

describe("buildImExpressionHint：教模型主动发（IM 通道专用）", () => {
  it("含全部 10 个标签 + 「绝不替代文字」铁律", () => {
    const hint = buildImExpressionHint();
    for (const e of EXPRESSIONS) expect(hint).toContain(expressionText(e));
    expect(hint).toContain("绝不替代文字");
  });
});
