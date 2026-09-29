// 5.7.3.1：结构化输出纯逻辑单测（指令 §4 清单）。
// 只 import shared/provider/structured.ts —— 该模块零依赖（不碰 I/O / 不读时钟），node 环境直接跑。
import { describe, expect, it } from "vitest";
import {
  buildSchemaHint,
  extractJsonCandidates,
  pickValidCandidate,
  tierChain,
} from "../src/shared/provider/structured";

/** 本测试共用的一个小 schema（object + required + properties 声明） */
const SCENE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" },
    count: { type: "number" },
  },
  required: ["title"],
};

describe("tierChain：档序固定（json_schema → json_object → prompt_json，只降不升）", () => {
  it("json_schema 声明 → 三档全走，顺序固定", () => {
    expect(tierChain("json_schema").map((p) => p.tier)).toEqual(["json_schema", "json_object", "prompt_json"]);
  });

  it("json_object 声明 → 两条（从声明档起降，不会先试 json_schema —— 声明档不是上限）", () => {
    expect(tierChain("json_object").map((p) => p.tier)).toEqual(["json_object", "prompt_json"]);
  });

  it("prompt_json 声明 → 只有一条", () => {
    expect(tierChain("prompt_json").map((p) => p.tier)).toEqual(["prompt_json"]);
  });

  it("档 1/2 带 responseFormat，档 3 不带（它靠 system 提示）", () => {
    const chain = tierChain("json_schema");
    expect(chain[0].tier === "json_schema" && chain[0].responseFormat.kind).toBe("json_schema");
    expect(chain[1].tier === "json_object" && chain[1].responseFormat.kind).toBe("json_object");
    expect(chain[2].tier).toBe("prompt_json");
  });
});

describe("buildSchemaHint：三档共用的 system 提示", () => {
  const hint = buildSchemaHint({
    schema: SCENE_SCHEMA,
    name: "probe_scene",
    instruction: "根据这段对话生成一幕剧情。",
  });

  it("含「只输出 JSON」约束语（不许解释、不许围栏）", () => {
    expect(hint).toContain("只输出 JSON");
  });

  it("含 schema 的 JSON 文本（字段名 / required 都在）", () => {
    expect(hint).toContain("title");
    expect(hint).toContain("required");
  });

  it("含 instruction 原文（丢了它 = 丢了业务要求）", () => {
    expect(hint).toContain("根据这段对话生成一幕剧情。");
  });
});

describe("extractJsonCandidates：按可信度收集候选", () => {
  it("整段就是纯 JSON", () => {
    expect(extractJsonCandidates('{"a":1}')).toContainEqual({ a: 1 });
  });

  it("```json 围栏（前后带解释文字）", () => {
    const text = '好的，如下：\n```json\n{"a":1}\n```\n以上。';
    expect(extractJsonCandidates(text)).toContainEqual({ a: 1 });
  });

  it("无语言标记的 ``` 围栏", () => {
    expect(extractJsonCandidates("```\n[1,2]\n```")).toContainEqual([1, 2]);
  });

  it("前后带解释文字的平衡片段", () => {
    const text = '这是结果 {"name":"纳西妲","n":2} 请查收';
    expect(extractJsonCandidates(text)).toContainEqual({ name: "纳西妲", n: 2 });
  });

  it("JSON 字符串里含花括号与转义引号：字符串感知，串内括号不算结构", () => {
    const text = '前缀 {"text":"a { b } \\"c\\"","ok":true} 后缀';
    expect(extractJsonCandidates(text)).toContainEqual({ text: 'a { b } "c"', ok: true });
  });

  it("没闭合的片段丢弃", () => {
    expect(extractJsonCandidates('{"a": ')).toEqual([]);
  });

  it("完全无 JSON → 空数组", () => {
    expect(extractJsonCandidates("这里没有任何结构化内容。")).toEqual([]);
  });
});

describe("pickValidCandidate：最小校验（type / required / 数组元素）", () => {
  it("合法对象 → 返回该值", () => {
    const value = { title: "x", count: 3 };
    expect(pickValidCandidate([value], SCENE_SCHEMA)).toEqual(value);
  });

  it("缺 required 键 → null", () => {
    expect(pickValidCandidate([{ count: 3 }], SCENE_SCHEMA)).toBeNull();
  });

  it("声明过的键类型不符 → null", () => {
    expect(pickValidCandidate([{ title: 42 }], SCENE_SCHEMA)).toBeNull();
  });

  it("数组元素坏 → null；全好 → 返回", () => {
    const arrSchema: Record<string, unknown> = { type: "array", items: { type: "string" } };
    expect(pickValidCandidate([["ok", 1]], arrSchema)).toBeNull();
    expect(pickValidCandidate([["ok", "fine"]], arrSchema)).toEqual(["ok", "fine"]);
  });

  it("NaN 不算 number → null", () => {
    expect(pickValidCandidate([Number.NaN], { type: "number" })).toBeNull();
  });

  it("object 声明下数组不算合法 → null", () => {
    expect(pickValidCandidate([[1, 2]], SCENE_SCHEMA)).toBeNull();
  });

  it("未声明 / 未知类型 → 放行", () => {
    expect(pickValidCandidate([{ any: true }], { type: "weird" })).toEqual({ any: true });
    expect(pickValidCandidate(["whatever"], {})).toBe("whatever");
  });
});

describe("组合：收集全部再挑，不是命中即停", () => {
  it("坏候选在前、好候选在后（两个平衡片段都被收集）→ 取到好的", () => {
    const text = '先给一版错误的：{"title": 42}，修正后：{"title": "对"}';
    const candidates = extractJsonCandidates(text);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    expect(pickValidCandidate(candidates, SCENE_SCHEMA)).toEqual({ title: "对" });
  });

  it("坏候选在围栏、好候选在正文 → 最终仍取到好值", () => {
    const text = '```json\n{"title": 1}\n```\n正文里的正确结果：{"title": "好"}';
    expect(pickValidCandidate(extractJsonCandidates(text), SCENE_SCHEMA)).toEqual({ title: "好" });
  });
});