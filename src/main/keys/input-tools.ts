// 8.6 §1.1：键鼠工具四个（click_at / type_text / press_key / scroll）
// 依据：内部规格 §1.1
//
// 本文件只做**工具语义**（校验 → clamp → 调注入的键鼠能力 → 回文本），键鼠能力一律注入：
//   · 真机由 builtin-tools 注入 createNutDriver()（唯一 import @nut-tree-fork/nut-js 的地方）；
//   · 单测注入假 driver（依赖倒置，同 vision-tools / shell-tool 的范式）——顶层不 import electron / nut-js。
// 规矩：
//   ① **顶层不 import nut-js、不 import electron** —— vitest 可直接 import，绝不拉 native 模块；
//   ② **绝不 throw** —— 每个函数体内 catch，错误也返回 `[错误]…`（对齐 8.5 口径，调用侧不用包 try）；
//   ③ 坐标统一用屏幕物理像素（VLM locator 已转像素）；clamp 上界用 w-1 / h-1。
// 已知限制：nut-js screen.width()/height() 只返回**主屏**尺寸，而 setPosition 吃**虚拟桌面全局坐标**
//   （副屏可能为负值）→ 本步只支持主屏，多屏偏移留待将来。
import { parseCombo } from "./key-combo";

/** 键鼠驱动：真机 = createNutDriver()；单测 = 假实现（断言收到的实参）。全是「能力」而非「数据」。 */
export interface InputDriver {
  /** 主屏物理像素尺寸 */
  screenSize: () => Promise<{ width: number; height: number }>;
  /** 移动到 (x,y) 并左键单击 */
  moveClick: (x: number, y: number) => Promise<void>;
  /** 键入一段文本（原样输入，不做 trim）。**真机仅支持 ASCII**（nut-js 走物理按键事件，中文实测打不出，见 nut-driver.ts） */
  typeText: (text: string) => Promise<void>;
  /** 依次按下并逆序释放若干键（names = 规范 Key 名） */
  pressKeys: (names: string[]) => Promise<void>;
  /** 把鼠标移到 (x,y) 后滚动；amount>0 向下、<0 向上 */
  scroll: (x: number, y: number, amount: number) => Promise<void>;
}

/** 坐标 clamp：取整后压进 [0, max]（max 传 w-1 / h-1，setPosition 传边界值即可） */
function clampCoord(v: number, max: number): number {
  const r = Math.round(v);
  if (r < 0) return 0;
  if (r > max) return max;
  return r;
}

/** 统一的兜底错误文案（绝不 throw，与 8.5 同形） */
function driverError(e: unknown): string {
  return "[错误] 键鼠操作失败：" + (e instanceof Error ? e.message : String(e));
}

/** 判断一个值是不是有限数字 */
function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** click_at：移动到屏幕物理像素 (x,y) 并左键单击一次 */
export async function clickAtTool(args: Record<string, unknown>, deps: InputDriver): Promise<string> {
  try {
    const { x, y } = args;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return "[错误] 坐标必须是数字。";
    const { width, height } = await deps.screenSize();
    const cx = clampCoord(x, width - 1);
    const cy = clampCoord(y, height - 1);
    await deps.moveClick(cx, cy);
    return `已点击屏幕坐标 (${cx}, ${cy})。`;
  } catch (e) {
    return driverError(e);
  }
}

/** type_text：把一段文本原样键入（空格不 trim 掉） */
export async function typeTextTool(args: Record<string, unknown>, deps: InputDriver): Promise<string> {
  try {
    const { text } = args;
    if (typeof text !== "string" || text.trim() === "") return "[错误] 要键入的文字是空的。";
    await deps.typeText(text);
    return `已键入 ${text.length} 个字符。`;
  } catch (e) {
    return driverError(e);
  }
}

/** press_key：解析组合键（丢无法识别的）后按下并释放 */
export async function pressKeyTool(args: Record<string, unknown>, deps: InputDriver): Promise<string> {
  try {
    const combo = typeof args.combo === "string" ? args.combo : String(args.combo ?? "");
    const names = parseCombo(combo);
    if (names.length === 0) return `[错误] 无法识别的按键组合「${combo}」。`;
    await deps.pressKeys(names);
    return `已按下 ${names.join("+")}。`;
  } catch (e) {
    return driverError(e);
  }
}

/** scroll：把鼠标移到 (x,y) 后滚动 amount 格（>0 向下 / <0 向上；0 非法） */
export async function scrollTool(args: Record<string, unknown>, deps: InputDriver): Promise<string> {
  try {
    const { x, y, amount } = args;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(amount)) {
      return "[错误] 滚动参数必须是数字。";
    }
    const cells = Math.round(amount);
    if (cells === 0) return "[错误] 滚动格数不能是 0。";
    const { width, height } = await deps.screenSize();
    const cx = clampCoord(x, width - 1);
    const cy = clampCoord(y, height - 1);
    await deps.scroll(cx, cy, cells);
    return `已在 (${cx}, ${cy}) 滚动 ${Math.abs(cells)} 格（${cells > 0 ? "向下" : "向上"}）。`;
  } catch (e) {
    return driverError(e);
  }
}