// 4.1.1 §9.2：三协议流式累积纯函数单测（OpenAI 分片拼接 / Anthropic 草稿 / Ollama 归一）
import { describe, it, expect } from "vitest";
import { mergeOpenAiToolDeltas, draftsToToolCalls, type OpenAiToolDraft } from "../src/main/provider/transport/openai-compat";
import { mergeAnthropicToolBlock, anthropicDraftsToToolCalls, type AnthropicToolDraft } from "../src/main/provider/transport/anthropic";
import { normalizeOllamaToolCalls } from "../src/main/provider/transport/ollama-native";

describe("OpenAI 兼容：流式 tool_calls 分片累积", () => {
  it("用例10 · 三片喂（首片 id+name，后两片参数两半）→ 1 条且 JSON 拼完整", () => {
    const drafts = new Map<number, OpenAiToolDraft>();
    mergeOpenAiToolDeltas(drafts, [{ index: 0, id: "call_1", type: "function", function: { name: "write_note" } }]);
    mergeOpenAiToolDeltas(drafts, [{ index: 0, function: { arguments: '{"title":"测试",' } }]);
    mergeOpenAiToolDeltas(drafts, [{ index: 0, function: { arguments: '"content":"hi"}' } }]);
    const calls = draftsToToolCalls(drafts);
    expect(calls.length).toBe(1);
    expect(calls[0].id).toBe("call_1");
    expect(calls[0].name).toBe("write_note");
    expect(JSON.parse(calls[0].arguments)).toEqual({ title: "测试", content: "hi" });
  });

  it("用例11 · 两个 index 并行 → 2 条且按 index 升序", () => {
    const drafts = new Map<number, OpenAiToolDraft>();
    mergeOpenAiToolDeltas(drafts, [{ index: 1, id: "call_b", function: { name: "tool_b", arguments: "{}" } }]);
    mergeOpenAiToolDeltas(drafts, [{ index: 0, id: "call_a", function: { name: "tool_a", arguments: "{}" } }]);
    const calls = draftsToToolCalls(drafts);
    expect(calls.map((c) => c.name)).toEqual(["tool_a", "tool_b"]);
  });

  it("用例12 · 只给 arguments 不给 name → 过滤掉（无名字碎片不进循环）", () => {
    const drafts = new Map<number, OpenAiToolDraft>();
    mergeOpenAiToolDeltas(drafts, [{ index: 0, function: { arguments: "{}" } }]);
    expect(draftsToToolCalls(drafts)).toEqual([]);
  });
});

describe("Anthropic：tool_use 块累积", () => {
  it("用例13 · content_block_start + 两片 input_json_delta → 1 条合法 JSON", () => {
    const drafts = new Map<number, AnthropicToolDraft>();
    mergeAnthropicToolBlock(drafts, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "write_note" } });
    mergeAnthropicToolBlock(drafts, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"title":"笔记",' } });
    mergeAnthropicToolBlock(drafts, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"content":"正文"}' } });
    const calls = anthropicDraftsToToolCalls(drafts);
    expect(calls.length).toBe(1);
    expect(calls[0].id).toBe("toolu_1");
    expect(JSON.parse(calls[0].arguments)).toEqual({ title: "笔记", content: "正文" });
  });

  it("用例14 · 没有 content_block_start 直接喂 delta → 不抛，出 0 条", () => {
    const drafts = new Map<number, AnthropicToolDraft>();
    expect(() =>
      mergeAnthropicToolBlock(drafts, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } }),
    ).not.toThrow();
    expect(anthropicDraftsToToolCalls(drafts)).toEqual([]);
  });
});

describe("Ollama 原生：tool_calls 归一", () => {
  it("用例15 · 对象形式 arguments → JSON 字符串，id 是 ollama-0", () => {
    const calls = normalizeOllamaToolCalls([{ function: { name: "write_note", arguments: { title: "测试" } } }]);
    expect(calls.length).toBe(1);
    expect(calls[0].id).toBe("ollama-0");
    expect(calls[0].arguments).toBe(JSON.stringify({ title: "测试" }));
  });

  it("用例16 · undefined / \"abc\" / [{}] → 一律 []，不抛", () => {
    expect(normalizeOllamaToolCalls(undefined)).toEqual([]);
    expect(normalizeOllamaToolCalls("abc")).toEqual([]);
    expect(normalizeOllamaToolCalls([{}])).toEqual([]);
  });
});
