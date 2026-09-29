// 6.3：心情语气注入单测 —— 纯函数，坑位口径照 relationship.test.ts 的 5.6.2 段（prompt.ts 同规格）。
import { describe, expect, it } from "vitest";
import { buildMoodPrefix, MOOD_TONES, withMoodPrefix } from "../src/main/relationship/mood";
import { buildAffectionPrefix, withAffectionPrefix } from "../src/main/relationship/prompt";
import type { ChatMessage } from "../src/shared/chat";

const MOODS = Object.keys(MOOD_TONES);

describe("MOOD_TONES（6.3 §3.2）", () => {
  it("四档齐全：平和 / 好奇 / 温柔 / 灵感迸发，与 panel chips 表一致", () => {
    expect(Object.keys(MOOD_TONES).sort()).toEqual(["好奇", "平和", "灵感迸发", "温柔"].sort());
  });
});

describe("buildMoodPrefix（6.3 §3.2）", () => {
  it("四档各出一段且互不相同，每段都含心情名与「行为要求」", () => {
    const texts = MOODS.map(buildMoodPrefix);
    expect(new Set(texts).size).toBe(MOODS.length);
    for (let i = 0; i < MOODS.length; i++) {
      expect(texts[i]).toContain(`「${MOODS[i]}」`);
      expect(texts[i]).toContain("行为要求：");
      expect(texts[i]).toContain(MOOD_TONES[MOODS[i]]);
    }
  });

  it("同心情两次调用逐字相同（无时间戳 / 随机量，坑 6）", () => {
    expect(buildMoodPrefix("好奇")).toBe(buildMoodPrefix("好奇"));
  });

  it("模板带「不要主动复述」约束", () => {
    expect(buildMoodPrefix("平和")).toContain("不要主动复述");
  });

  it("脏值（表外词）与空串 → 空串，不注入（坑 9）", () => {
    expect(buildMoodPrefix("雀跃")).toBe("");
    expect(buildMoodPrefix("")).toBe("");
  });
});

describe("withMoodPrefix（6.3 §3.2，withAffectionPrefix 同规格）", () => {
  const base: ChatMessage[] = [
    { role: "user", content: "早" },
    { role: "assistant", content: "早安" },
  ];

  it("prefix 为空 → 返回原引用（零改动，坑 3）", () => {
    expect(withMoodPrefix(base, "")).toBe(base);
  });

  it("prefix 非空 → 新数组、首条 system、原数组未被改（坑 2）", () => {
    const out = withMoodPrefix(base, "[内部状态] 心情注入");
    expect(out).not.toBe(base);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: "system", content: "[内部状态] 心情注入" });
    expect(base).toEqual([
      { role: "user", content: "早" },
      { role: "assistant", content: "早安" },
    ]);
  });

  it("与好感度并列挂接：两条独立 system、心情在前、互不覆盖（6.3 §3.2 注入链）", () => {
    const messages = withMoodPrefix(
      withAffectionPrefix(base, buildAffectionPrefix({ value: 50, levelId: "Lv.3", totalDays: 10, firstMetAt: 0 }, 0)),
      buildMoodPrefix("好奇"),
    );
    expect(messages).toHaveLength(4);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("system");
    expect(messages[0].content).toContain("心情");
    expect(messages[1].content).toContain("关系阶段");
    // 两条 system 互不覆盖：心情段不含好感度语料，反之亦然
    expect(messages[0].content).not.toContain("关系阶段");
    expect(messages[1].content).not.toContain("心情是");
  });
});
