// 8.6 §1.2：VLM 定位工具两个（screen_find / screen_status）—— 工具语义层（纯模块 + 依赖注入）。
// 依据：内部规格 §1.2 / §1.4
//
// 范式照 keys/input-tools.ts：能力一律注入（截图 / 屏幕尺寸 / 视觉配置 / chat），真机由 builtin-tools 绑定；
//   纯模块顶层**不 import electron / nut-js** —— vitest 可直接 import。
// 规矩：
//   ① **绝不 throw** —— 每个函数体内 catch，错误也返回 `[错误]…`（对齐 8.5 / 1.1 口径，调用侧不用包 try）；
//   ② 坐标单位 = **屏幕物理像素**（最终报给模型的 (x,y)），换算口径与 media/capture.grab 的 thumbSize 同源
//      （DIP × scaleFactor，四舍五入）；
//   ③ **screen_find 只报坐标、绝不自动点**（红线 §1.4）—— 点击权交给模型，走 click_at 的审批链路。
//
// ⚠️ 坐标链路（2026-09-29 真机实测定案，8.6 验收）：
//   VLM 返回的是**相对它所看到那张图**的绝对像素（qwen2.5vl:3b 无视归一化要求，见 vlm-locator 注），
//   而截图可能被缩过（capture.grab 非原尺寸时长边缩到 1920）→ 必须按「屏幕物理尺寸 / 图尺寸」换算，
//   否则 4K 屏上会偏。**图尺寸随图一起注入（grab 的返回值里带 width/height）**，不靠调用方另行配对。
import type { VisionConfig } from "../../shared/provider/types";
import { check, locate, type ChatFn } from "./vlm-locator";

/** 送给 VLM 的那张截图：base64 + **这张图自己的像素尺寸**（VLM 坐标的基准） */
export interface GrabbedScreen {
  base64: string;
  width: number;
  height: number;
}

/** screen_find / screen_status 的依赖（能力注入，真机由 builtin-tools 绑定） */
export interface ScreenToolDeps {
  /** 截当前主屏 → base64 + 图尺寸；null = 截不到 */
  grab: () => Promise<GrabbedScreen | null>;
  /** 主屏**物理像素**尺寸（DIP × scaleFactor）—— 把 VLM 在图上的坐标换算回屏幕物理像素 */
  screenPhysicalSize: () => { width: number; height: number };
  /** 视觉模型配置（执行时求值，不缓存） */
  vlmConfig: () => VisionConfig;
  /** 传给 vlm-locator 的 chat 注入点；**不传 = 用 vlm-locator 内部默认实现**（真机走这条，自己 fetch） */
  chat?: ChatFn;
}

/** DIP 尺寸 × 缩放 → 物理像素（四舍五入）。与 media/capture.grab 的 thumbSize 同源（capture.ts L57-62） */
export function physicalScreenSize(
  size: { width: number; height: number },
  scaleFactor: number,
): { width: number; height: number } {
  return {
    width: Math.round(size.width * scaleFactor),
    height: Math.round(size.height * scaleFactor),
  };
}

/** 截不到屏幕的统一文案 */
const NO_SCREEN = "[错误] 截不到当前屏幕（屏幕权限可能被系统拒绝，或画面受保护）。";

/** 统一兜底错误文案（绝不 throw，与 input-tools 同形） */
function toolError(e: unknown): string {
  return "[错误] " + (e instanceof Error ? e.message : String(e));
}

/** 截图 → {base64, 图尺寸}；抛错 / 空图 / 零尺寸都当「截不到」（返回 null） */
async function grabOrNull(deps: ScreenToolDeps): Promise<GrabbedScreen | null> {
  try {
    const shot = await deps.grab();
    return shot && shot.base64 && shot.width > 0 && shot.height > 0 ? shot : null;
  } catch {
    return null;
  }
}

/** screen_find：按描述在当前屏幕上找目标 → 报中心像素坐标（**只报坐标，绝不自动点**） */
export async function screenFindTool(args: Record<string, unknown>, deps: ScreenToolDeps): Promise<string> {
  try {
    const target = typeof args.target === "string" ? args.target.trim() : "";
    if (!target) return "[错误] 要定位的目标不能为空。";

    const shot = await grabOrNull(deps);
    if (!shot) return NO_SCREEN;

    // VLM 返回的是「这张图里」的绝对像素（图尺寸由 vlm-locator 告知模型，并作为解析 clamp 上界）
    const r = await locate(
      deps.vlmConfig(),
      { base64: shot.base64, mime: "image/png" },
      [],
      target,
      shot.width,
      shot.height,
      deps.chat,
    );
    // 失败分两种、报不同的话（真机实测：模型常多写一个右括号 → 解析失败，与「真没找到」不是一回事）
    if (!r.ok) {
      if (r.reason === "chat-failed") {
        return "[错误] 视觉模型没有响应（可能没配置好，或服务暂时不可用），这次没能看上屏幕。";
      }
      return `[错误] 视觉模型的回答里没有可用的坐标 —— 可能没找到「${target}」，也可能是它的输出格式不合规；换个更具体的描述再试一次。`;
    }

    // 图坐标 → 屏幕物理像素：图被缩过时按比例放大（图 = 原尺寸时比例正好是 1）
    const screen = deps.screenPhysicalSize();
    const x = Math.max(0, Math.min(screen.width, Math.round((r.x * screen.width) / shot.width)));
    const y = Math.max(0, Math.min(screen.height, Math.round((r.y * screen.height) / shot.height)));
    return `已在屏幕上找到「${target}」，中心坐标约 (${x}, ${y})。`;
  } catch (e) {
    return toolError(e);
  }
}

/** screen_status：看一眼当前屏幕，回答一个是非问题 */
export async function screenStatusTool(args: Record<string, unknown>, deps: ScreenToolDeps): Promise<string> {
  try {
    const ask = typeof args.ask === "string" ? args.ask.trim() : "";
    if (!ask) return "[错误] 要判断的问题不能为空。";
    const shot = await grabOrNull(deps);
    if (!shot) return NO_SCREEN;
    const ans = await check(deps.vlmConfig(), { base64: shot.base64, mime: "image/png" }, ask, undefined, deps.chat);
    if (ans === true) return "看屏幕后判断：是。";
    if (ans === false) return "看屏幕后判断：否。";
    return "[错误] 没能判断（可以换个更明确的是非问题再试）。";
  } catch (e) {
    return toolError(e);
  }
}
