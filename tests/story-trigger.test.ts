// 5.7.2：触发引擎 + 文档消毒纯函数单测（指令 §4 清单：七类条件正反例 / weather·pomodoro 恒 false /
// time 窗口内外·单边·跨零点 / affection 闭区间边界 / chat 三键 AND / evaluateTriggers 空数组恒真 /
// matchedChapters 排序稳定 / sanitizeStoryDoc 空档·坏 kind 丢条·值类型过滤·孤儿处理·去重·
// schemaVersion 恒 1·order 回落下标）。
// 只 import shared/story.ts —— trigger-engine 顶层 import chats-store（会拉起 electron），tests 绝不许碰。
import { describe, expect, it } from "vitest";
import {
  STORY_SCHEMA_VERSION,
  evaluateTrigger,
  evaluateTriggers,
  matchedChapters,
  sanitizeStoryDoc,
  type Chapter,
  type StoryContext,
  type Trigger,
} from "../src/shared/story";

/** 本地时区造时间（月份 0 起：8 = 9 月）。2026-09-27 是周日 */
function at(hour: number, minute = 0): number {
  return new Date(2026, 8, 27, hour, minute).getTime();
}

/** 默认上下文：好感 50 / 无聊天 / 无任务 / 无心情（各用例只覆写关心的那几项） */
function ctx(over?: Partial<StoryContext>): StoryContext {
  return {
    now: at(12),
    affection: 50,
    messageCount: 0,
    lastUserText: "",
    lastChatAt: null,
    tasksDoneToday: 0,
    mood: "",
    ...over,
  };
}

function tr(kind: Trigger["kind"], params: Record<string, string | number | boolean> = {}): Trigger {
  return { kind, params };
}

describe("evaluateTrigger：七类条件", () => {
  it("weather / pomodoro 恒 false —— 哪怕 params 给了值（本阶段无数据源，恒假是约定）", () => {
    expect(evaluateTrigger(tr("weather", { from: "00:00", to: "23:59", min: 0 }), ctx())).toBe(false);
    expect(evaluateTrigger(tr("pomodoro", { minDoneToday: 0 }), ctx({ tasksDoneToday: 9 }))).toBe(false);
  });

  it("time：窗口内 / 窗口外 / 单边（只给 from = from 之后；只给 to = to 之前）", () => {
    const window = tr("time", { from: "09:00", to: "18:00" });
    expect(evaluateTrigger(window, ctx({ now: at(12) }))).toBe(true);
    expect(evaluateTrigger(window, ctx({ now: at(20) }))).toBe(false);
    expect(evaluateTrigger(tr("time", { from: "09:00" }), ctx({ now: at(8) }))).toBe(false);
    expect(evaluateTrigger(tr("time", { from: "09:00" }), ctx({ now: at(9) }))).toBe(true);
    expect(evaluateTrigger(tr("time", { to: "18:00" }), ctx({ now: at(12) }))).toBe(true);
    expect(evaluateTrigger(tr("time", { to: "18:00" }), ctx({ now: at(20) }))).toBe(false);
    expect(evaluateTrigger(tr("time"), ctx())).toBe(false); // 都缺 → false
    expect(evaluateTrigger(tr("time", { from: "25:00", to: "abc" }), ctx())).toBe(false); // 格式不对 → false
  });

  it("time：from > to = 跨零点窗口（22:00–06:00 在 23:00 命中、12:00 不命中、06:00 端点命中）", () => {
    const overnight = tr("time", { from: "22:00", to: "06:00" });
    expect(evaluateTrigger(overnight, ctx({ now: at(23) }))).toBe(true);
    expect(evaluateTrigger(overnight, ctx({ now: at(12) }))).toBe(false);
    expect(evaluateTrigger(overnight, ctx({ now: at(6) }))).toBe(true);
  });

  it("affection：闭区间边界（min / max 各命中一次，越界不命中）+ 单边", () => {
    const band = tr("affection", { min: 20, max: 80 });
    expect(evaluateTrigger(band, ctx({ affection: 19 }))).toBe(false);
    expect(evaluateTrigger(band, ctx({ affection: 20 }))).toBe(true);
    expect(evaluateTrigger(band, ctx({ affection: 80 }))).toBe(true);
    expect(evaluateTrigger(band, ctx({ affection: 81 }))).toBe(false);
    expect(evaluateTrigger(tr("affection", { min: 60 }), ctx({ affection: 60 }))).toBe(true);
    expect(evaluateTrigger(tr("affection", { min: 60 }), ctx({ affection: 59 }))).toBe(false);
    expect(evaluateTrigger(tr("affection", { max: 60 }), ctx({ affection: 60 }))).toBe(true);
    expect(evaluateTrigger(tr("affection", { max: 60 }), ctx({ affection: 61 }))).toBe(false);
    expect(evaluateTrigger(tr("affection"), ctx())).toBe(false); // 都缺 → false
  });

  it("chat：三键 AND（只满足两键 → false）；contains 大小写不敏感", () => {
    const all3 = tr("chat", { contains: "天气", minMessages: 5, idleMinutes: 10 });
    const base: Partial<StoryContext> = {
      now: at(12),
      lastUserText: "今天天气怎么样",
      messageCount: 5,
      lastChatAt: at(12) - 15 * 60_000, // 已闲 15 分钟
    };
    expect(evaluateTrigger(all3, ctx(base))).toBe(true);
    expect(evaluateTrigger(all3, ctx({ ...base, messageCount: 4 }))).toBe(false); // 三缺一
    expect(evaluateTrigger(all3, ctx({ ...base, lastChatAt: at(12) - 9 * 60_000 }))).toBe(false); // 只闲 9 分钟
    expect(evaluateTrigger(all3, ctx({ ...base, lastUserText: "今天吃什么" }))).toBe(false); // contains 不中
    expect(evaluateTrigger(tr("chat", { contains: "HOWDY" }), ctx({ lastUserText: "howdy there" }))).toBe(true);
    expect(evaluateTrigger(tr("chat"), ctx())).toBe(false); // 全缺 → false
  });

  it("task / mood：正反例（mood 全等；ctx.mood 为空不命中）", () => {
    expect(evaluateTrigger(tr("task", { minDoneToday: 3 }), ctx({ tasksDoneToday: 3 }))).toBe(true);
    expect(evaluateTrigger(tr("task", { minDoneToday: 3 }), ctx({ tasksDoneToday: 2 }))).toBe(false);
    expect(evaluateTrigger(tr("task"), ctx({ tasksDoneToday: 9 }))).toBe(false);
    expect(evaluateTrigger(tr("mood", { is: "开心" }), ctx({ mood: "开心" }))).toBe(true);
    expect(evaluateTrigger(tr("mood", { is: "开心" }), ctx({ mood: "难过" }))).toBe(false);
    expect(evaluateTrigger(tr("mood", { is: "开心" }), ctx({ mood: "" }))).toBe(false);
  });

  it("坏数据永不抛错：kind 不认识 / params 不是对象 / 键类型不对 → false", () => {
    expect(evaluateTrigger({ kind: "不存在的类型", params: {} } as unknown as Trigger, ctx())).toBe(false);
    expect(evaluateTrigger({ kind: "affection", params: "x" } as unknown as Trigger, ctx())).toBe(false);
    expect(evaluateTrigger(tr("affection", { min: "20" }), ctx())).toBe(false); // 字符串不是 number
  });
});

describe("evaluateTriggers / matchedChapters", () => {
  it("evaluateTriggers：空数组恒真（无条件章节）；一条假 → false", () => {
    expect(evaluateTriggers([], ctx())).toBe(true);
    expect(evaluateTriggers([tr("affection", { min: 0 })], ctx())).toBe(true);
    expect(evaluateTriggers([tr("affection", { min: 0 }), tr("affection", { min: 99 })], ctx())).toBe(false);
  });

  it("matchedChapters：按 order 升序；order 相同按 title 升序（稳定）", () => {
    const mk = (id: string, order: number, min: number, title = id): Chapter => ({
      id,
      title,
      order,
      entryConditions: [tr("affection", { min })],
      branchIds: [],
    });
    const list = [mk("c2", 2, 0), mk("c1b", 1, 0, "b"), mk("c1a", 1, 0, "a"), mk("c9", 9, 99)];
    expect(matchedChapters(list, ctx()).map((c) => c.id)).toEqual(["c1a", "c1b", "c2"]);
  });
});

describe("sanitizeStoryDoc：唯一消毒入口", () => {
  it("非对象 → 空档（不许返回 null —— 空档是合法态）", () => {
    const empty = { version: STORY_SCHEMA_VERSION, chapters: [], branches: [], saves: [] };
    expect(sanitizeStoryDoc("x", 7)).toEqual(empty);
    expect(sanitizeStoryDoc(null, 7)).toEqual(empty);
  });

  it("坏 kind 丢条 + params 值类型过滤（只留 string / number / boolean）", () => {
    const doc = sanitizeStoryDoc(
      {
        chapters: [
          {
            id: "c1",
            title: "一",
            order: 0,
            entryConditions: [
              { kind: "不存在的类型", params: { min: 1 } },
              { kind: "affection", params: { min: 10, label: "x", flag: true, obj: { a: 1 }, arr: [1], nil: null } },
            ],
          },
        ],
      },
      7,
    );
    expect(doc.chapters).toHaveLength(1);
    expect(doc.chapters[0].entryConditions).toHaveLength(1);
    expect(doc.chapters[0].entryConditions[0]).toEqual({
      kind: "affection",
      params: { min: 10, label: "x", flag: true },
    });
  });

  it("孤儿处理不搞反：分支指向不存在章节 → 丢分支（chapter.branchIds 同步过滤）；存档指向不存在章节 → 保留", () => {
    const doc = sanitizeStoryDoc(
      {
        chapters: [{ id: "c1", title: "一", branchIds: ["b1", "b2"] }],
        branches: [
          { id: "b1", chapterId: "c1", fromNodeId: "n1", options: [{ id: "o1", label: "继续" }] },
          { id: "b2", chapterId: "幽灵章", fromNodeId: "n2", options: [] },
        ],
        saves: [
          { id: "s1", chapterId: "幽灵章", nodeId: "n1", messageTreeRef: { sessionId: "s", nodeId: "m1" }, at: 5 },
        ],
      },
      7,
    );
    expect(doc.branches.map((b) => b.id)).toEqual(["b1"]);
    expect(doc.chapters[0].branchIds).toEqual(["b1"]); // b2 不存在 → 从章节侧也过滤掉
    expect(doc.saves).toHaveLength(1); // 存档是用户资产：章节没了也留着
    expect(doc.saves[0].at).toBe(5); // 合法 at 原样保留
    expect(doc.saves[0].schemaVersion).toBe(STORY_SCHEMA_VERSION);
  });

  it("三表各自按 id 去重（保首现）", () => {
    const doc = sanitizeStoryDoc(
      {
        chapters: [
          { id: "c1", title: "先", order: 1 },
          { id: "c1", title: "后", order: 2 },
        ],
        branches: [
          { id: "b1", chapterId: "c1", fromNodeId: "n1", options: [] },
          { id: "b1", chapterId: "c1", fromNodeId: "n2", options: [] },
        ],
        saves: [
          { id: "s1", chapterId: "c1", nodeId: "n1", messageTreeRef: { sessionId: "s", nodeId: "m1" }, at: 2 },
          { id: "s1", chapterId: "c1", nodeId: "n2", messageTreeRef: { sessionId: "s", nodeId: "m2" }, at: 1 },
        ],
      },
      7,
    );
    expect(doc.chapters.map((c) => c.title)).toEqual(["先"]);
    expect(doc.branches.map((b) => b.fromNodeId)).toEqual(["n1"]);
    expect(doc.saves.map((s) => s.nodeId)).toEqual(["n1"]);
  });

  it("章节 order 缺失 / 非有限数 → 回落到数组下标；存档 at 非有限数 → now、schemaVersion 一律 1", () => {
    const doc = sanitizeStoryDoc(
      {
        chapters: [
          { id: "c1", title: "一" },
          { id: "c2", title: "二", order: "x" },
          { id: "c3", title: "三", order: 0.5 },
        ],
        saves: [
          {
            id: "s1",
            chapterId: "c1",
            nodeId: "n1",
            messageTreeRef: { sessionId: "s", nodeId: "m" },
            at: "不是数字",
            schemaVersion: 99,
          },
        ],
      },
      7,
    );
    expect(doc.chapters.map((c) => c.order)).toEqual([0, 1, 0.5]);
    expect(doc.saves[0].at).toBe(7);
    expect(doc.saves[0].schemaVersion).toBe(1);
  });
});