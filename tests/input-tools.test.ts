// 8.6 §1.1 验收：parseCombo + 四个键鼠工具（依赖倒置，假 driver）
// 被测模块 keys/input-tools.ts / keys/key-combo.ts 顶层**不 import nut-js / electron** —— vitest 直接跑，
//   绝不真动鼠标键盘（native 只在 keys/nut-driver.ts 里，本测试不 import 它）。
import { describe, expect, it, vi } from "vitest";
import { parseCombo, resolveKeyName } from "../src/main/keys/key-combo";
import { clickAtTool, pressKeyTool, scrollTool, typeTextTool, type InputDriver } from "../src/main/keys/input-tools";

/** 假 driver：默认主屏 1920×1080；四个能力都是 vi.fn，便于断言收到的实参 */
function makeDriver(over: Partial<InputDriver> = {}): {
  deps: InputDriver;
  screenSize: ReturnType<typeof vi.fn>;
  moveClick: ReturnType<typeof vi.fn>;
  typeText: ReturnType<typeof vi.fn>;
  pressKeys: ReturnType<typeof vi.fn>;
  scroll: ReturnType<typeof vi.fn>;
} {
  const screenSize = vi.fn(async () => ({ width: 1920, height: 1080 }));
  const moveClick = vi.fn(async (_x: number, _y: number) => {});
  const typeText = vi.fn(async (_t: string) => {});
  const pressKeys = vi.fn(async (_n: string[]) => {});
  const scroll = vi.fn(async (_x: number, _y: number, _a: number) => {});
  const deps: InputDriver = { screenSize, moveClick, typeText, pressKeys, scroll, ...over };
  return { deps, screenSize, moveClick, typeText, pressKeys, scroll };
}

describe("resolveKeyName / parseCombo", () => {
  it("特殊键：Esc→Escape、Return→Enter、Ctrl/Control→LeftControl、Alt→LeftAlt、Shift→LeftShift、Win/Meta→LeftSuper", () => {
    expect(resolveKeyName("Esc")).toBe("Escape");
    expect(resolveKeyName("Return")).toBe("Enter");
    expect(resolveKeyName("Ctrl")).toBe("LeftControl");
    expect(resolveKeyName("Control")).toBe("LeftControl");
    expect(resolveKeyName("Alt")).toBe("LeftAlt");
    expect(resolveKeyName("Shift")).toBe("LeftShift");
    expect(resolveKeyName("Win")).toBe("LeftSuper");
    expect(resolveKeyName("Meta")).toBe("LeftSuper");
    expect(resolveKeyName("F4")).toBe("F4");
  });

  it("单字母：A-Z 原样（小写规范成大写）；未知返回 null", () => {
    expect(resolveKeyName("V")).toBe("V");
    expect(resolveKeyName("v")).toBe("V");
    expect(resolveKeyName("Foo")).toBeNull();
    expect(resolveKeyName("")).toBeNull();
    expect(resolveKeyName("F13")).toBeNull();
  });

  it('组合键："Alt+F4" → ["LeftAlt","F4"]', () => {
    expect(parseCombo("Alt+F4")).toEqual(["LeftAlt", "F4"]);
  });

  it('单键："Esc" → ["Escape"]；单字母 "V" → ["V"]', () => {
    expect(parseCombo("Esc")).toEqual(["Escape"]);
    expect(parseCombo("V")).toEqual(["V"]);
  });

  it('多修饰键："Ctrl+Shift+S" → ["LeftControl","LeftShift","S"]', () => {
    expect(parseCombo("Ctrl+Shift+S")).toEqual(["LeftControl", "LeftShift", "S"]);
  });

  it("大小写不敏感 + 首尾空格被 trim：\" ctrl + alt + delete \"", () => {
    expect(parseCombo(" ctrl + alt + delete ")).toEqual(["LeftControl", "LeftAlt", "Delete"]);
  });

  it('混合可识别 / 不可识别：只留可识别的（"Bogus+Ctrl" → ["LeftControl"]）', () => {
    expect(parseCombo("Bogus+Ctrl")).toEqual(["LeftControl"]);
    expect(parseCombo("Foo")).toEqual([]);
  });

  it("空串 → []（一个都认不出来）", () => {
    expect(parseCombo("")).toEqual([]);
    expect(parseCombo("  ")).toEqual([]);
  });
});

describe("click_at", () => {
  it("成功：clamp 后调 moveClick，返回点击坐标", async () => {
    const { deps, moveClick } = makeDriver();
    const r = await clickAtTool({ x: 500, y: 400 }, deps);
    expect(moveClick).toHaveBeenCalledWith(500, 400);
    expect(r).toBe("已点击屏幕坐标 (500, 400)。");
  });

  it("越界：(9999, -5) → clamp 到 (w-1, 0) = (1919, 0)", async () => {
    const { deps, moveClick } = makeDriver();
    const r = await clickAtTool({ x: 9999, y: -5 }, deps);
    expect(moveClick).toHaveBeenCalledWith(1919, 0);
    expect(r).toBe("已点击屏幕坐标 (1919, 0)。");
  });

  it("错误路径：非数字坐标 → [错误]，不调 driver", async () => {
    const { deps, moveClick } = makeDriver();
    expect(await clickAtTool({ x: "a", y: 1 }, deps)).toBe("[错误] 坐标必须是数字。");
    expect(await clickAtTool({ x: Number.NaN, y: 1 }, deps)).toBe("[错误] 坐标必须是数字。");
    expect(await clickAtTool({}, deps)).toBe("[错误] 坐标必须是数字。");
    expect(moveClick).not.toHaveBeenCalled();
  });

  it("driver 抛错 → 返回 [错误]… 而不是 throw", async () => {
    const { deps } = makeDriver({ moveClick: vi.fn(async () => { throw new Error("native boom"); }) });
    await expect(clickAtTool({ x: 1, y: 1 }, deps)).resolves.toBe("[错误] 键鼠操作失败：native boom");
  });
});

describe("type_text", () => {
  it("成功：原样传入（空格不 trim），返回字符数", async () => {
    const { deps, typeText } = makeDriver();
    const r = await typeTextTool({ text: " hello " }, deps);
    expect(typeText).toHaveBeenCalledWith(" hello ");
    expect(r).toBe("已键入 7 个字符。");
  });

  it("错误路径：空 / 纯空白 / 非字符串 → [错误]，不调 driver", async () => {
    const { deps, typeText } = makeDriver();
    expect(await typeTextTool({ text: "" }, deps)).toBe("[错误] 要键入的文字是空的。");
    expect(await typeTextTool({ text: "   " }, deps)).toBe("[错误] 要键入的文字是空的。");
    expect(await typeTextTool({}, deps)).toBe("[错误] 要键入的文字是空的。");
    expect(typeText).not.toHaveBeenCalled();
  });

  it("driver 抛错 → 返回 [错误]…", async () => {
    const { deps } = makeDriver({ typeText: vi.fn(async () => { throw new Error("type fail"); }) });
    await expect(typeTextTool({ text: "x" }, deps)).resolves.toBe("[错误] 键鼠操作失败：type fail");
  });
});

describe("press_key", () => {
  it('成功："Alt+F4" → pressKeys(["LeftAlt","F4"])，返回规范名拼接', async () => {
    const { deps, pressKeys } = makeDriver();
    const r = await pressKeyTool({ combo: "Alt+F4" }, deps);
    expect(pressKeys).toHaveBeenCalledWith(["LeftAlt", "F4"]);
    expect(r).toBe("已按下 LeftAlt+F4。");
  });

  it("错误路径：乱码 combo → [错误] 且原样回显，不调 driver", async () => {
    const { deps, pressKeys } = makeDriver();
    expect(await pressKeyTool({ combo: "Bogus" }, deps)).toBe("[错误] 无法识别的按键组合「Bogus」。");
    expect(await pressKeyTool({ combo: "" }, deps)).toBe("[错误] 无法识别的按键组合「」。");
    expect(pressKeys).not.toHaveBeenCalled();
  });

  it("driver 抛错 → 返回 [错误]…", async () => {
    const { deps } = makeDriver({ pressKeys: vi.fn(async () => { throw new Error("key fail"); }) });
    await expect(pressKeyTool({ combo: "Enter" }, deps)).resolves.toBe("[错误] 键鼠操作失败：key fail");
  });
});

describe("scroll", () => {
  it("成功（正数向下）：clamp 后调 scroll，返回向下文案", async () => {
    const { deps, scroll } = makeDriver();
    const r = await scrollTool({ x: 500, y: 400, amount: 3 }, deps);
    expect(scroll).toHaveBeenCalledWith(500, 400, 3);
    expect(r).toBe("已在 (500, 400) 滚动 3 格（向下）。");
  });

  it("成功（负数向上）：amount 取整后原样带符号传给 driver，文案取绝对值", async () => {
    const { deps, scroll } = makeDriver();
    const r = await scrollTool({ x: 1, y: 2, amount: -2.4 }, deps);
    expect(scroll).toHaveBeenCalledWith(1, 2, -2);
    expect(r).toBe("已在 (1, 2) 滚动 2 格（向上）。");
  });

  it("越界坐标 clamp：(-10, 99999, 1) → (0, 1079, 1)", async () => {
    const { deps, scroll } = makeDriver();
    const r = await scrollTool({ x: -10, y: 99999, amount: 1 }, deps);
    expect(scroll).toHaveBeenCalledWith(0, 1079, 1);
    expect(r).toBe("已在 (0, 1079) 滚动 1 格（向下）。");
  });

  it("错误路径：amount=0 → [错误]，不调 driver；非数字 → [错误]", async () => {
    const { deps, scroll } = makeDriver();
    expect(await scrollTool({ x: 1, y: 1, amount: 0 }, deps)).toBe("[错误] 滚动格数不能是 0。");
    expect(await scrollTool({ x: 1, y: 1, amount: 0.2 }, deps)).toBe("[错误] 滚动格数不能是 0。");
    expect(await scrollTool({ x: 1, y: 1, amount: "x" }, deps)).toBe("[错误] 滚动参数必须是数字。");
    expect(await scrollTool({ x: 1, y: 1 }, deps)).toBe("[错误] 滚动参数必须是数字。");
    expect(scroll).not.toHaveBeenCalled();
  });

  it("driver 抛错 → 返回 [错误]…", async () => {
    const { deps } = makeDriver({ scroll: vi.fn(async () => { throw new Error("scroll fail"); }) });
    await expect(scrollTool({ x: 1, y: 1, amount: 1 }, deps)).resolves.toBe("[错误] 键鼠操作失败：scroll fail");
  });
});
