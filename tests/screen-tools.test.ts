// 8.6 §1.2 验收：坐标换算 + vlm-locator 注入假 chat → 断言解析；screen_find / screen_status 注入假依赖。
// 被测模块 keys/vlm-locator.ts / keys/screen-tools.ts 顶层**不 import electron / nut-js** —— vitest 直接跑。
//
// ⚠️ 坐标约定（2026-09-29 真机实测定案，8.6 验收）：VLM 输出的是**绝对像素**（相对它看到的那张图），
//    不是 0-1000 归一化 —— qwen2.5vl:3b 实测无视归一化要求。故 parseClickCoord 不做 /1000 换算，
//    screen_find 只做「图坐标 → 屏幕物理像素」的比例换算。详见 vlm-locator.ts 的坐标约定注。
import { describe, expect, it, vi } from "vitest";
import { parseBoolAnswer, parseClickCoord, type ChatFn } from "../src/main/keys/vlm-locator";
import { physicalScreenSize, screenFindTool, screenStatusTool, type ScreenToolDeps } from "../src/main/keys/screen-tools";

/** 假 chat：固定返回一段文本（忽略 config / instruction / images） */
function fakeChat(text: string): ChatFn {
  return vi.fn(async () => text);
}

/** 假依赖：默认「图 1920×1080、屏幕物理 1920×1080」（比例 1）+ 假视觉配置；chat 由用例传入 */
function makeDeps(over: Partial<ScreenToolDeps> = {}): ScreenToolDeps {
  return {
    grab: async () => ({ base64: "FAKE_PNG_BASE64", width: 1920, height: 1080 }),
    screenPhysicalSize: () => ({ width: 1920, height: 1080 }),
    vlmConfig: () => ({ baseUrl: "https://example.test/v1", apiKey: "k", model: "m" }),
    ...over,
  };
}

describe("parseClickCoord（模型输出即绝对像素，不做归一化换算）", () => {
  it('{"x":500,"y":500} @1920×1080 → (500, 500)（不是 960/540）', () => {
    expect(parseClickCoord('{"x":500,"y":500}', 1920, 1080)).toEqual({ x: 500, y: 500 });
  });

  it("边界：0 → 0；等于图尺寸 → 图尺寸（clamp 上界 = 图尺寸）", () => {
    expect(parseClickCoord('{"x":0,"y":0}', 1920, 1080)).toEqual({ x: 0, y: 0 });
    expect(parseClickCoord('{"x":1920,"y":1080}', 1920, 1080)).toEqual({ x: 1920, y: 1080 });
  });

  it("越界被 clamp：2000 → 1920；-100 → 0", () => {
    expect(parseClickCoord('{"x":2000,"y":-100}', 1920, 1080)).toEqual({ x: 1920, y: 0 });
  });

  it("脏文本仍能解析：```json 围栏 / JSON 夹在说明文字里", () => {
    expect(parseClickCoord("```json\n{\"x\":560,\"y\":460}\n```", 1920, 1080)).toEqual({ x: 560, y: 460 });
    expect(parseClickCoord("我找到了：{\"x\":560,\"y\":460} 就这儿", 1920, 1080)).toEqual({ x: 560, y: 460 });
  });

  it("括号配平（8.6 复验实测）：模型多写一个右括号也能解析", () => {
    // 真机原始输出就是这个形态；旧实现（首个 { ~ 最后一个 }）会切片含多余括号 → parse 失败 → null
    expect(parseClickCoord('{"x": 560, "y": 506}}', 1920, 1080)).toEqual({ x: 560, y: 506 });
    expect(parseClickCoord("```json\n{\"x\":559,\"y\":375}}\n```", 1920, 1080)).toEqual({ x: 559, y: 375 });
    expect(parseClickCoord('好的：{"x":250,"y":750}} 后面还有字', 1920, 1080)).toEqual({ x: 250, y: 750 });
  });

  it("非数字 / 无 JSON → null", () => {
    expect(parseClickCoord('{"x":"a","y":1}', 1920, 1080)).toBeNull();
    expect(parseClickCoord("没有坐标", 1920, 1080)).toBeNull();
    expect(parseClickCoord("", 1920, 1080)).toBeNull();
  });

  it("回归（8.6 首轮真机 FAIL 根因）：模型原始输出 (584,478) 必须原样保留，不许再 ×屏宽/1000", () => {
    // 旧逻辑 584/1000×1920 = 1121 → 偏 561px；探针实测该值正是靶子真值 (560,460) 附近的绝对像素
    expect(parseClickCoord('{"x":584,"y":478}', 1920, 1080)).toEqual({ x: 584, y: 478 });
  });
});

describe("parseBoolAnswer", () => {
  it("「没有」→ false（false 关键词优先，不被「有」误判成 true）", () => {
    expect(parseBoolAnswer("没有")).toBe(false);
  });

  it('{"answer":true} → true；{"answer":false} → false', () => {
    expect(parseBoolAnswer('{"answer":true}')).toBe(true);
    expect(parseBoolAnswer('{"answer":false}')).toBe(false);
  });

  it("判不了 / 空串 → null", () => {
    expect(parseBoolAnswer("???")).toBeNull();
    expect(parseBoolAnswer("")).toBeNull();
  });
});

describe("physicalScreenSize（DIP × scaleFactor → 物理像素）", () => {
  it("1920×1080 @1 → 1920×1080", () => {
    expect(physicalScreenSize({ width: 1920, height: 1080 }, 1)).toEqual({ width: 1920, height: 1080 });
  });

  it("1920×1080 @1.5 → 2880×1620", () => {
    expect(physicalScreenSize({ width: 1920, height: 1080 }, 1.5)).toEqual({ width: 2880, height: 1620 });
  });

  it("1920×1080 @1.25 → 2400×1350", () => {
    expect(physicalScreenSize({ width: 1920, height: 1080 }, 1.25)).toEqual({ width: 2400, height: 1350 });
  });
});

describe("screen_find", () => {
  it('定位成功：假 chat 返回 {"x":250,"y":750} → 原样报出（图 = 屏，比例 1）', async () => {
    const deps = makeDeps({ chat: fakeChat('{"x":250,"y":750}') });
    const r = await screenFindTool({ target: "登录按钮" }, deps);
    expect(r).toContain("(250, 750)");
    expect(r).toContain("登录按钮");
  });

  it("图被缩过：图 960×540、屏幕物理 1920×1080 → 坐标按比例放大 2 倍", async () => {
    const deps = makeDeps({
      grab: async () => ({ base64: "FAKE", width: 960, height: 540 }),
      screenPhysicalSize: () => ({ width: 1920, height: 1080 }),
      chat: fakeChat('{"x":240,"y":270}'),
    });
    expect(await screenFindTool({ target: "x" }, deps)).toContain("(480, 540)");
  });

  it('截不到屏幕（grab 返回 null）→ [错误]，不 throw', async () => {
    const deps = makeDeps({ grab: async () => null, chat: fakeChat('{"x":1,"y":1}') });
    await expect(screenFindTool({ target: "x" }, deps)).resolves.toBe(
      "[错误] 截不到当前屏幕（屏幕权限可能被系统拒绝，或画面受保护）。",
    );
  });

  it("grab 抛错也当截不到 → [错误]，不 throw", async () => {
    const deps = makeDeps({
      grab: async () => {
        throw new Error("boom");
      },
      chat: fakeChat('{"x":1,"y":1}'),
    });
    await expect(screenFindTool({ target: "x" }, deps)).resolves.toBe(
      "[错误] 截不到当前屏幕（屏幕权限可能被系统拒绝，或画面受保护）。",
    );
  });

  it("模型答了但解不出坐标 → 报「没有可用的坐标」（与「模型没响应」文案不同）", async () => {
    const deps = makeDeps({ chat: fakeChat("我不知道") });
    const r = await screenFindTool({ target: "蓝色按钮" }, deps);
    expect(r).toContain("没有可用的坐标");
    expect(r).toContain("蓝色按钮");
  });

  it("模型没响应（chat 返回空串）→ 报「视觉模型没有响应」", async () => {
    const deps = makeDeps({ chat: fakeChat("") });
    await expect(screenFindTool({ target: "x" }, deps)).resolves.toBe(
      "[错误] 视觉模型没有响应（可能没配置好，或服务暂时不可用），这次没能看上屏幕。",
    );
  });

  it("多余右括号也能定位成功（8.6 复验回归）", async () => {
    const deps = makeDeps({ chat: fakeChat('{"x": 560, "y": 506}}') });
    expect(await screenFindTool({ target: "红圆" }, deps)).toContain("(560, 506)");
  });

  it("target 空 / 纯空白 / 缺失 → [错误]", async () => {
    const deps = makeDeps({ chat: fakeChat('{"x":1,"y":1}') });
    expect(await screenFindTool({}, deps)).toBe("[错误] 要定位的目标不能为空。");
    expect(await screenFindTool({ target: "   " }, deps)).toBe("[错误] 要定位的目标不能为空。");
    expect(await screenFindTool({ target: 42 }, deps)).toBe("[错误] 要定位的目标不能为空。");
  });
});

describe("screen_status", () => {
  it('假 chat 返回 {"answer":false} → 文本含否定', async () => {
    const deps = makeDeps({ chat: fakeChat('{"answer":false}') });
    const r = await screenStatusTool({ ask: "有没有弹登录框" }, deps);
    expect(r).toContain("否");
  });

  it("假 chat 返回 true → 文本含肯定", async () => {
    const deps = makeDeps({ chat: fakeChat('{"answer":true}') });
    expect(await screenStatusTool({ ask: "是否已登录" }, deps)).toBe("看屏幕后判断：是。");
  });

  it("ask 空 → [错误]", async () => {
    const deps = makeDeps({ chat: fakeChat('{"answer":true}') });
    expect(await screenStatusTool({}, deps)).toBe("[错误] 要判断的问题不能为空。");
    expect(await screenStatusTool({ ask: "  " }, deps)).toBe("[错误] 要判断的问题不能为空。");
  });

  it('判不了（chat 返回 ""）→ [错误]，不 throw', async () => {
    const deps = makeDeps({ chat: fakeChat("") });
    await expect(screenStatusTool({ ask: "x" }, deps)).resolves.toBe(
      "[错误] 没能判断（可以换个更明确的是非问题再试）。",
    );
  });
});
