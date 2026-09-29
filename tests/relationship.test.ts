// 5.6.1：relationship 纯函数单测（指令 §4 第 9 条清单：等级边界 / clamp / gap·nextLevelName / daysSince /
// 周归零 / sanitize 修复与判损坏 / applyPatch 校验）。被测模块零依赖，node 环境直接 import。
import { describe, expect, it } from "vitest";
import {
  AFFECTION_LEVELS,
  RELATIONSHIP_LIMITS,
  RELATIONSHIP_SCHEMA_VERSION,
  applyPatch,
  clampAffection,
  daysSince,
  initialRelationshipState,
  levelLabel,
  levelName,
  levelOf,
  nextLevelGap,
  nextLevelLabel,
  nextLevelName,
  sanitizeRelationshipState,
  viewOf,
  weekStartOf,
  type RelationshipState,
} from "../src/shared/relationship";

/** 本地时区构造时间（月份 0 起：8 = 9 月）。2026-09-27 是周日，2026-09-21 是周一 */
const SUNDAY_NOON = new Date(2026, 8, 27, 12, 0).getTime();
const MONDAY_0000 = new Date(2026, 8, 21, 0, 0, 0, 0).getTime();

describe("等级边界 10 点（0/19/20/39/40/59/60/79/80/100）", () => {
  it("levelOf 落段正确，80 起即顶级「依赖」", () => {
    const expectLevel = (v: number, id: string, name: string) => {
      expect(levelOf(v).id).toBe(id);
      expect(levelLabel(v)).toBe(`${id} ${name}`);
    };
    expectLevel(0, "Lv.1", "初识");
    expectLevel(19, "Lv.1", "初识");
    expectLevel(20, "Lv.2", "熟识");
    expectLevel(39, "Lv.2", "熟识");
    expectLevel(40, "Lv.3", "亲近");
    expectLevel(59, "Lv.3", "亲近");
    expectLevel(60, "Lv.4", "知心");
    expectLevel(79, "Lv.4", "知心");
    expectLevel(80, "Lv.5", "依赖");
    expectLevel(100, "Lv.5", "依赖");
  });

  it("nextLevelLabel：逐级递进，顶级 → 空串（不是 Lv.6 / 已满级）", () => {
    expect(nextLevelLabel(0)).toBe("Lv.2 熟识");
    expect(nextLevelLabel(39)).toBe("Lv.3 亲近");
    expect(nextLevelLabel(60)).toBe("Lv.5 依赖");
    expect(nextLevelLabel(79)).toBe("Lv.5 依赖");
    expect(nextLevelLabel(80)).toBe("");
    expect(nextLevelLabel(100)).toBe("");
  });

  it("越界值先 clamp 再判级（120 / -5）", () => {
    expect(levelOf(120).id).toBe("Lv.5");
    expect(levelOf(-5).id).toBe("Lv.1");
  });
});

describe("clampAffection 三例", () => {
  it("-5 → 0 / 120 → 100 / 82.6 → 83", () => {
    expect(clampAffection(-5)).toBe(0);
    expect(clampAffection(120)).toBe(100);
    expect(clampAffection(82.6)).toBe(83);
  });
  it("非有限数 → 0", () => {
    expect(clampAffection(NaN)).toBe(0);
    expect(clampAffection(Infinity)).toBe(0);
  });
});

describe("gap 与 nextLevelName（0 / 19 / 20 / 80 / 100）", () => {
  it("gap = 下一级 min - value（绝对差距，与环故意不相等）", () => {
    expect(nextLevelGap(0)).toBe(20);
    expect(nextLevelGap(19)).toBe(1);
    expect(nextLevelGap(20)).toBe(20);
  });
  it("顶级 gap=null（80 / 100 都是，90 也是）", () => {
    expect(nextLevelGap(80)).toBeNull();
    expect(nextLevelGap(100)).toBeNull();
  });
  it("nextLevelName / levelName：裸名不带 Lv.N；顶级 → 空串（不是 Lv.6 / 已满级）", () => {
    expect(nextLevelName(0)).toBe("熟识");
    expect(nextLevelName(19)).toBe("熟识");
    expect(nextLevelName(20)).toBe("亲近");
    expect(nextLevelName(79)).toBe("依赖");
    expect(nextLevelName(80)).toBe("");
    expect(nextLevelName(100)).toBe("");
    expect(levelName(60)).toBe("知心");
    expect(levelName(80)).toBe("依赖");
  });
});

describe("weekStartOf（本地时区本周一 00:00）", () => {
  it("周日正午 → 本周一；周一 00:00 → 自身；周一 00:00 前一毫秒（周日）→ 上周一", () => {
    expect(weekStartOf(SUNDAY_NOON)).toBe(MONDAY_0000);
    expect(weekStartOf(MONDAY_0000)).toBe(MONDAY_0000);
    expect(weekStartOf(MONDAY_0000 - 1)).toBe(MONDAY_0000 - 7 * 86_400_000);
  });
});

describe("daysSince（日历天差 + 1，最小 1）", () => {
  it("同天 → 1 / 昨天 → 2 / 30 天前 → 31", () => {
    const sameDay = new Date(2026, 8, 27, 8, 0).getTime();
    const yesterday = new Date(2026, 8, 26, 23, 59).getTime();
    const thirtyAgo = new Date(2026, 7, 28, 12, 0).getTime();
    expect(daysSince(sameDay, SUNDAY_NOON)).toBe(1);
    expect(daysSince(yesterday, SUNDAY_NOON)).toBe(2);
    expect(daysSince(thirtyAgo, SUNDAY_NOON)).toBe(31);
  });
  it("firstMetAt 晚于 now（脏数据）→ 最小 1，不出 0 / 负数", () => {
    const future = SUNDAY_NOON + 86_400_000;
    expect(daysSince(future, SUNDAY_NOON)).toBe(1);
  });
});

describe("initialRelationshipState", () => {
  it("新装 = 0 / Lv.1 / days 1，周锚点 = 本周一", () => {
    const state = initialRelationshipState(SUNDAY_NOON);
    expect(state).toStrictEqual({
      value: 0,
      levelId: "Lv.1",
      firstMetAt: SUNDAY_NOON,
      totalDays: 1,
      weekQuests: 0,
      weekStartAt: MONDAY_0000,
      schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
    });
  });
});

describe("sanitizeRelationshipState（修复 vs 判损坏）", () => {
  it("判损坏：{} / \"x\" / firstMetAt NaN / value 非数字 / null / 数组 → null", () => {
    expect(sanitizeRelationshipState({}, SUNDAY_NOON)).toBeNull();
    expect(sanitizeRelationshipState("x", SUNDAY_NOON)).toBeNull();
    expect(sanitizeRelationshipState({ value: 50, firstMetAt: NaN }, SUNDAY_NOON)).toBeNull();
    expect(sanitizeRelationshipState({ value: "x", firstMetAt: 1 }, SUNDAY_NOON)).toBeNull();
    expect(sanitizeRelationshipState(null, SUNDAY_NOON)).toBeNull();
    expect(sanitizeRelationshipState([], SUNDAY_NOON)).toBeNull();
  });

  it("修复：派生字段重算覆盖（levelId / totalDays 不信盘上的），value 夹界取整", () => {
    const firstMetAt = new Date(2026, 8, 25, 9, 0).getTime(); // 两天前
    const fixed = sanitizeRelationshipState(
      { value: 82.7, firstMetAt, levelId: "Lv.1", totalDays: 999, weekQuests: 3, weekStartAt: MONDAY_0000, schemaVersion: 1 },
      SUNDAY_NOON,
    );
    expect(fixed).not.toBeNull();
    expect(fixed!.value).toBe(83);
    expect(fixed!.levelId).toBe("Lv.5"); // 重算，不认盘上的 "Lv.1"
    expect(fixed!.totalDays).toBe(3); // 重算，不认盘上的 999
    expect(fixed!.weekQuests).toBe(3);
    expect(fixed!.weekStartAt).toBe(MONDAY_0000);
  });

  it("越界 value 修复夹界（120 → 100）", () => {
    const fixed = sanitizeRelationshipState({ value: 120, firstMetAt: SUNDAY_NOON }, SUNDAY_NOON);
    expect(fixed!.value).toBe(100);
    expect(fixed!.levelId).toBe("Lv.5");
  });

  it("周归零只认时间：跨 7 天（含应用没开的日子）→ weekQuests 0、锚点挪本周一；周内不归零", () => {
    const stale = weekStartOf(SUNDAY_NOON) - 8 * 86_400_000;
    const crossed = sanitizeRelationshipState(
      { value: 50, firstMetAt: SUNDAY_NOON, weekQuests: 5, weekStartAt: stale },
      SUNDAY_NOON,
    );
    expect(crossed!.weekQuests).toBe(0);
    expect(crossed!.weekStartAt).toBe(MONDAY_0000);

    const within = sanitizeRelationshipState(
      { value: 50, firstMetAt: SUNDAY_NOON, weekQuests: 5, weekStartAt: MONDAY_0000 },
      SUNDAY_NOON,
    );
    expect(within!.weekQuests).toBe(5); // 锚点就是本周一，距 now 不足 7 天，不归零
  });

  it("脏 weekStartAt / weekQuests 修复：非有限锚点 → 本周一；负数 / 小数计数 → 非负整数", () => {
    const fixed = sanitizeRelationshipState(
      { value: 50, firstMetAt: SUNDAY_NOON, weekQuests: -7.9, weekStartAt: "junk" },
      SUNDAY_NOON,
    );
    expect(fixed!.weekStartAt).toBe(MONDAY_0000);
    expect(fixed!.weekQuests).toBe(0);
  });
});

describe("viewOf（app-state 的 character.affection 就是这个形状，不另设 AffectionSlice）", () => {
  const base: RelationshipState = {
    value: 40,
    levelId: "Lv.3",
    firstMetAt: SUNDAY_NOON,
    totalDays: 12,
    weekQuests: 4,
    weekStartAt: MONDAY_0000,
    schemaVersion: RELATIONSHIP_SCHEMA_VERSION,
  };

  it("viewOf 投影完整（gap / nextLevelName / days），days 直接取重算后的 totalDays", () => {
    expect(viewOf(base)).toStrictEqual({
      value: 40,
      level: "Lv.3 亲近",
      nextLevel: "Lv.4 知心",
      nextLevelName: "知心",
      gap: 20,
      days: 12,
      weekQuests: 4,
    });
  });
});

describe("applyPatch（校验 + 应用）", () => {
  const base = initialRelationshipState(SUNDAY_NOON);

  it("delta 模式：值推进、levelId 同步、返回有效增量", () => {
    const { state, delta } = applyPatch(base, { source: "chat", reason: "本轮对话 2 分钟", delta: 3 }, SUNDAY_NOON);
    expect(delta).toBe(3);
    expect(state.value).toBe(3);
    expect(state.levelId).toBe("Lv.1");
    expect(state.schemaVersion).toBe(RELATIONSHIP_SCHEMA_VERSION);
  });

  it("value 模式（绝对设定）：90 → Lv.5，返回 delta = 80", () => {
    const { state, delta } = applyPatch(base, { source: "settings", reason: "手动测试", value: 90 }, SUNDAY_NOON);
    expect(state.value).toBe(90);
    expect(state.levelId).toBe("Lv.5");
    expect(delta).toBe(90);
  });

  it("delta 溢出夹界不抛（95 + 10 → 100），返回真实增量 5", () => {
    const near = applyPatch(base, { source: "settings", reason: "测试", value: 95 }, SUNDAY_NOON).state;
    const { state, delta } = applyPatch(near, { source: "chat", reason: "聊天", delta: 10 }, SUNDAY_NOON);
    expect(state.value).toBe(100);
    expect(delta).toBe(5);
  });

  it("source === tool → weekQuests + 1；其他来源不涨", () => {
    const quested = applyPatch(base, { source: "tool", reason: "完成委托", delta: 2 }, SUNDAY_NOON).state;
    expect(quested.weekQuests).toBe(1);
    const chatted = applyPatch(base, { source: "chat", reason: "聊天", delta: 2 }, SUNDAY_NOON).state;
    expect(chatted.weekQuests).toBe(0);
  });

  it("totalDays 按传入 now 重算（跨天调用不涨假的）", () => {
    const tomorrow = SUNDAY_NOON + 86_400_000;
    const state = applyPatch(base, { source: "chat", reason: "聊天", delta: 1 }, tomorrow).state;
    expect(state.totalDays).toBe(2);
  });

  it("抛错：非法 source（不许静默改 system）/ 都给 / 都不给 / delta 超 20 / reason 超 80 字 / reason 非字符串 / delta 非有限数", () => {
    expect(() => applyPatch(base, { source: "hack" as never, reason: "x", delta: 1 }, SUNDAY_NOON)).toThrow(/来源/);
    expect(() => applyPatch(base, { source: "chat", reason: "x", delta: 1, value: 5 }, SUNDAY_NOON)).toThrow(/恰好给一个/);
    expect(() => applyPatch(base, { source: "chat", reason: "x" }, SUNDAY_NOON)).toThrow(/恰好给一个/);
    expect(() => applyPatch(base, { source: "chat", reason: "x", delta: RELATIONSHIP_LIMITS.maxDeltaPerWrite + 1 }, SUNDAY_NOON)).toThrow(/上限/);
    expect(() => applyPatch(base, { source: "chat", reason: "长".repeat(RELATIONSHIP_LIMITS.maxReasonLength + 1), delta: 1 }, SUNDAY_NOON)).toThrow(/80/);
    expect(() => applyPatch(base, { source: "chat", reason: 42 as never, delta: 1 }, SUNDAY_NOON)).toThrow(/reason/);
    expect(() => applyPatch(base, { source: "chat", reason: "x", delta: Number.NaN }, SUNDAY_NOON)).toThrow(/delta/);
  });

  it("delta 恰好 ±20 边界合法（只限超界）", () => {
    expect(() => applyPatch(base, { source: "system", reason: "x", delta: RELATIONSHIP_LIMITS.maxDeltaPerWrite }, SUNDAY_NOON)).not.toThrow();
    expect(() => applyPatch(base, { source: "system", reason: "x", delta: -RELATIONSHIP_LIMITS.maxDeltaPerWrite }, SUNDAY_NOON)).not.toThrow();
  });
});

describe("等级表契约守卫", () => {
  it("5 级连续覆盖 0..100，段间无缝无重叠", () => {
    expect(AFFECTION_LEVELS).toHaveLength(5);
    expect(AFFECTION_LEVELS[0].min).toBe(0);
    expect(AFFECTION_LEVELS[AFFECTION_LEVELS.length - 1].max).toBe(100);
    for (let i = 1; i < AFFECTION_LEVELS.length; i++) {
      expect(AFFECTION_LEVELS[i].min).toBe(AFFECTION_LEVELS[i - 1].max + 1);
    }
  });
});

// ==================== 5.6.2：语气注入（指令 §3.5） ====================

import { buildAffectionPrefix, withAffectionPrefix } from "../src/main/relationship/prompt";
import type { ChatMessage } from "../src/shared/chat";

/** 造合法 state（levelId 派生自 value，与读盘重算链路一致），可覆写个别字段造脏数据 */
const stateAt = (value: number, over: Partial<RelationshipState> = {}): RelationshipState => ({
  ...initialRelationshipState(SUNDAY_NOON),
  value,
  levelId: levelOf(value).id,
  totalDays: 10,
  ...over,
});

describe("buildAffectionPrefix（5.6.2 §3.5）", () => {
  it("五个等级各出一段且互不相同，每段 ≤ 300 字", () => {
    const texts = [0, 25, 50, 70, 90].map((v) => buildAffectionPrefix(stateAt(v), SUNDAY_NOON));
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(300);
    expect(new Set(texts).size).toBe(5); // 同等级同文本、不同等级必不同
  });

  it("同等级两次调用逐字相同（无时间戳 / 随机量，坑 6）", () => {
    expect(buildAffectionPrefix(stateAt(50), SUNDAY_NOON)).toBe(
      buildAffectionPrefix(stateAt(50), SUNDAY_NOON + 123_456),
    );
  });

  it("value 85 的那段含「依赖」", () => {
    expect(buildAffectionPrefix(stateAt(85), SUNDAY_NOON)).toContain("依赖");
  });

  it("levelId 脏值（Lv.9）→ 空串，不注入（坑 9）", () => {
    expect(buildAffectionPrefix(stateAt(85, { levelId: "Lv.9" }), SUNDAY_NOON)).toBe("");
  });

  it("模板三要素齐全：等级标签 / 相识天数 / 语气要求", () => {
    const t = buildAffectionPrefix(stateAt(50, { totalDays: 30 }), SUNDAY_NOON);
    expect(t).toContain("Lv.3 亲近");
    expect(t).toContain("相识 30 天");
    expect(t).toContain("语气要求：");
  });
});

describe("withAffectionPrefix（5.6.2 §3.5）", () => {
  const base: ChatMessage[] = [
    { role: "user", content: "早" },
    { role: "assistant", content: "早安" },
  ];

  it("prefix 为空 → 返回原引用（零改动，坑 3）", () => {
    expect(withAffectionPrefix(base, "")).toBe(base);
  });

  it("prefix 非空 → 新数组、首条 system、原数组长度与内容未被改（坑 2）", () => {
    const snapshot = JSON.parse(JSON.stringify(base));
    const result = withAffectionPrefix(base, "PFX");
    expect(result).not.toBe(base);
    expect(result).toHaveLength(3);
    expect(result[0]).toStrictEqual({ role: "system", content: "PFX" });
    expect(result.slice(1)).toStrictEqual(base);
    expect(base).toStrictEqual(snapshot); // 调用方的数组保持原样
  });
});
