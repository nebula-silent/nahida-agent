// 5.7.3.2：生成契约纯函数单测（指令 §4 第 7 条：entryNodeId / buildStoryInstruction /
// sanitizeGeneratedScene / STORY_SCENE_SCHEMA 形状）。
// 只 import shared/story.ts —— story-generator 顶层 import story-store / trigger-engine（会拉起 electron），tests 绝不许碰。
import { describe, expect, it } from "vitest";
import {
  STORY_LIMITS,
  STORY_SCENE_SCHEMA,
  buildStoryInstruction,
  entryNodeId,
  sanitizeGeneratedScene,
  type Branch,
  type Chapter,
  type StoryContext,
} from "../src/shared/story";

/** 默认上下文：好感 50 / 无聊天 / 无任务 / 无心情（各用例只覆写关心的那几项） */
function ctx(over?: Partial<StoryContext>): StoryContext {
  return {
    now: 0,
    affection: 50,
    messageCount: 0,
    lastUserText: "",
    lastChatAt: null,
    tasksDoneToday: 0,
    mood: "",
    ...over,
  };
}

function ch(id: string, branchIds: string[] = []): Chapter {
  return { id, title: "初见", order: 1, entryConditions: [], branchIds };
}

function br(id: string, fromNodeId: string): Branch {
  return { id, chapterId: "ch1", fromNodeId, options: [] };
}

describe("entryNodeId", () => {
  it("取 branchIds 里首个「能找到的分支」的 fromNodeId（悬空 id 跳到下一个）", () => {
    expect(entryNodeId(ch("ch1", ["ghost", "b2", "b1"]), [br("b1", "n1"), br("b2", "n2")])).toBe("n2");
  });

  it("无分支 / 全部悬空 → `${chapterId}#entry`", () => {
    expect(entryNodeId(ch("ch1"), [])).toBe("ch1#entry");
    expect(entryNodeId(ch("ch1", ["ghost"]), [br("b1", "n1")])).toBe("ch1#entry");
  });

  it("坏数据不抛错：branches 非数组 / chapter 缺 branchIds → 入口占位 id", () => {
    expect(entryNodeId(ch("ch1"), "x" as unknown as Branch[])).toBe("ch1#entry");
    expect(entryNodeId({ id: "ch1" } as unknown as Chapter, [])).toBe("ch1#entry");
  });
});

describe("buildStoryInstruction", () => {
  it("包含章节标题与全部上下文数值（好感度 / 消息数 / 任务数 / 时刻）", () => {
    const text = buildStoryInstruction(
      ch("ch1"),
      ctx({ affection: 72, messageCount: 18, tasksDoneToday: 3, mood: "开心", lastUserText: "今天天气不错" }),
      "21:05",
    );
    expect(text).toContain("初见");
    expect(text).toContain("72");
    expect(text).toContain("18");
    expect(text).toContain("3");
    expect(text).toContain("21:05");
    expect(text).toContain("今天天气不错");
    expect(text).toContain("开心");
  });

  it("mood 空不写心情行；lastUserText 空不写末条消息行", () => {
    const text = buildStoryInstruction(ch("ch1"), ctx(), "08:00");
    expect(text).not.toContain("当前心情");
    expect(text).not.toContain("最后一条用户消息");
  });

  it("硬要求齐全：中文 / 2–4 句 / 2–3 条选项 / o1 风格 id / reward 空串 / 只输出 JSON", () => {
    const text = buildStoryInstruction(ch("ch1"), ctx(), "08:00");
    expect(text).toContain("中文");
    expect(text).toContain("2–4 句");
    expect(text).toContain("2–3 条");
    expect(text).toContain("o1");
    expect(text).toContain("reward");
    expect(text).toContain("只输出 JSON");
  });
});

describe("STORY_SCENE_SCHEMA：strict 形状", () => {
  it("两层 object 都带 additionalProperties: false 且 required 列全（reward 必填）", () => {
    const schema = STORY_SCENE_SCHEMA as {
      additionalProperties: unknown;
      required: unknown;
      properties: { options: { minItems: unknown; maxItems: unknown; items: Record<string, unknown> } };
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["scene", "options"]);
    const items = schema.properties.options.items as {
      additionalProperties: unknown;
      required: unknown;
      properties: Record<string, unknown>;
    };
    expect(items.additionalProperties).toBe(false);
    expect(items.required).toEqual(["id", "label", "reward"]);
    expect(Object.keys(items.properties).sort()).toEqual(["id", "label", "reward"]);
    expect(schema.properties.options.minItems).toBe(1);
    expect(schema.properties.options.maxItems).toBe(4);
  });
});

describe("sanitizeGeneratedScene：永不抛错的校验兜底", () => {
  it("非普通对象 / scene 缺失 / scene 空白 → null（整份判死）", () => {
    expect(sanitizeGeneratedScene(null)).toBeNull();
    expect(sanitizeGeneratedScene("x")).toBeNull();
    expect(sanitizeGeneratedScene([])).toBeNull();
    expect(sanitizeGeneratedScene({})).toBeNull();
    expect(sanitizeGeneratedScene({ scene: "  ", options: [{ id: "o1", label: "a" }] })).toBeNull();
    expect(sanitizeGeneratedScene({ scene: 123, options: [{ id: "o1", label: "a" }] })).toBeNull();
  });

  it("options 非数组 / 选项全非法（0 条）→ null（没有选项的剧情没意义）", () => {
    expect(sanitizeGeneratedScene({ scene: "场景", options: "x" })).toBeNull();
    expect(sanitizeGeneratedScene({ scene: "场景", options: [] })).toBeNull();
    expect(sanitizeGeneratedScene({ scene: "场景", options: [{ id: "", label: "a" }, { id: "o2" }, "x"] })).toBeNull();
  });

  it("scene 去首尾空白；label 截 40 字 / id 截 64 字", () => {
    const long = "字".repeat(STORY_LIMITS.maxLabelLength + 10);
    const scene = sanitizeGeneratedScene({ scene: "  她笑了笑。 ", options: [{ id: "o1", label: long }] });
    expect(scene?.scene).toBe("她笑了笑。");
    expect(scene?.options[0].label).toHaveLength(STORY_LIMITS.maxLabelLength);
    const longId = "i".repeat(STORY_LIMITS.maxIdLength + 5);
    const withLongId = sanitizeGeneratedScene({ scene: "场景", options: [{ id: longId, label: "a" }] });
    expect(withLongId?.options[0].id).toHaveLength(STORY_LIMITS.maxIdLength);
  });

  it("reward 非空才带上（空串 / 非 string → 字段不出现）；toNodeId 是 string 才带上", () => {
    const scene = sanitizeGeneratedScene({
      scene: "场景",
      options: [
        { id: "o1", label: "a", reward: "" },
        { id: "o2", label: "b", reward: 7 },
        { id: "o3", label: "c", reward: "好感 +2", toNodeId: "n9" },
      ],
    });
    expect(scene?.options[0]).toEqual({ id: "o1", label: "a" });
    expect(scene?.options[1]).toEqual({ id: "o2", label: "b" });
    expect(scene?.options[2]).toEqual({ id: "o3", label: "c", reward: "好感 +2", toNodeId: "n9" });
  });

  it("按 id 去重（保首现）；> 4 条截前 4", () => {
    const dup = sanitizeGeneratedScene({
      scene: "场景",
      options: [{ id: "o1", label: "先" }, { id: "o1", label: "后" }, { id: "o2", label: "b" }],
    });
    expect(dup?.options.map((o) => o.label)).toEqual(["先", "b"]);

    const many = sanitizeGeneratedScene({
      scene: "场景",
      options: ["o1", "o2", "o3", "o4", "o5", "o6"].map((id) => ({ id, label: id })),
    });
    expect(many?.options.map((o) => o.id)).toEqual(["o1", "o2", "o3", "o4"]);
  });

  it("坏条目丢条不判死：非对象 / 缺 label 的选项跳过，合法的留下", () => {
    const scene = sanitizeGeneratedScene({
      scene: "场景",
      options: ["x", { id: "o1" }, { id: "", label: "a" }, { id: "o2", label: "留下" }],
    });
    expect(scene?.options).toEqual([{ id: "o2", label: "留下" }]);
  });
});