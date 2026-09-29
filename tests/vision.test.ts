// 8.1：视觉旁路服务单测（假 fetch 注入；本模块不 import electron，vitest 可直接 import）
import { afterEach, describe, expect, it, vi } from "vitest";
import { captionImage, resolveVisionConfig } from "../src/main/provider/vision";
import type { VisionConfig } from "../src/shared/provider/types";

const realFetch = globalThis.fetch;

/** 假 fetch：记录入参，返回指定响应 */
function stubFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response): {
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return handler(String(url), init as RequestInit);
  }) as unknown as typeof fetch;
  return { calls };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

const CFG: VisionConfig = { baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "qwen-vl-max" };
const IMG = { base64: "AAAA", mime: "image/png" };

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe("captionImage", () => {
  it("有 query：请求体含问题指令 + image_url(dataURL) + max_tokens 512，且走 Bearer 鉴权", async () => {
    const { calls } = stubFetch(() => jsonResponse({ choices: [{ message: { content: "图里有两只猫" } }] }));
    const text = await captionImage(IMG, "图里有几只猫？", CFG);

    expect(text).toBe("图里有两只猫");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.test/v1/chat/completions");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("qwen-vl-max");
    expect(body.max_tokens).toBe(512);
    expect(body.stream).toBe(false);
    expect(body.temperature).toBeUndefined(); // 不传 temperature（各家默认不同）
    const content = body.messages[0].content;
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("图里有几只猫？");
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
  });

  it("无 query：走「客观描述」通用指令", async () => {
    const { calls } = stubFetch(() => jsonResponse({ choices: [{ message: { content: "描述" } }] }));
    await captionImage(IMG, "   ", CFG);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.messages[0].content[0].text).toContain("客观描述");
    expect(body.messages[0].content[0].text).toContain("200 字以内");
  });

  it("HTTP 非 2xx：返回 [错误·运行时] 字符串，不 throw", async () => {
    stubFetch(() => jsonResponse({ error: "unauthorized" }, 401));
    const text = await captionImage(IMG, "q", CFG);
    expect(text.startsWith("[错误·运行时]")).toBe(true);
    expect(text).toContain("401");
  });

  it("超时：返回 [错误·运行时] 视觉模型请求超时", async () => {
    vi.useFakeTimers();
    globalThis.fetch = ((_url: unknown, init: unknown) =>
      new Promise((_resolve, reject) => {
        const signal = (init as RequestInit).signal as AbortSignal;
        signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      })) as unknown as typeof fetch;

    const pending = captionImage(IMG, "q", CFG);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe("[错误·运行时] 视觉模型请求超时");
  });

  it("apiKey 为空：返回 [错误·配置]，且不发请求", async () => {
    const { calls } = stubFetch(() => jsonResponse({}));
    const text = await captionImage(IMG, "q", { ...CFG, apiKey: "" });
    expect(text.startsWith("[错误·配置]")).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("baseUrl / model 为空：同样返回 [错误·配置]，不崩", async () => {
    const { calls } = stubFetch(() => jsonResponse({}));
    expect((await captionImage(IMG, "q", { ...CFG, baseUrl: "" })).startsWith("[错误·配置]")).toBe(true);
    expect((await captionImage(IMG, "q", { ...CFG, model: "" })).startsWith("[错误·配置]")).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("resolveVisionConfig", () => {
  it("空串回落 provider 预设（与 model 段同口径）", () => {
    expect(resolveVisionConfig({ provider: "ollama", baseUrl: "", model: "", apiKey: "" })).toEqual({
      baseUrl: "http://localhost:11434",
      model: "",
      apiKey: "",
    });
  });

  it("显式填的值优先于预设；未选 provider 时原样透传", () => {
    expect(
      resolveVisionConfig({ provider: "openai", baseUrl: "https://my.gw/v1", model: "my-vl", apiKey: "k" }),
    ).toEqual({ baseUrl: "https://my.gw/v1", model: "my-vl", apiKey: "k" });
    expect(resolveVisionConfig({ provider: "", baseUrl: "", model: "", apiKey: "" })).toEqual({
      baseUrl: "",
      model: "",
      apiKey: "",
    });
  });
});
