// 悬浮球几何（A 重做）：纯函数、electron-free —— 唯一可单测的 orb 文件。
// 常量取数自参考实现 deepseek-harness-orb-main/apps/desktop/src/floating-window.ts:131-224。
// 禁止 import electron / 读 screen：工作区由调用方（floating-window.ts）算好传进来。
// A 重做后窗口尺寸恒定（面板 CSS scale 开合），不再有「展开态窗口矩形」这类随形态变化的几何。

/** 球直径（CSS px = DIP） */
export const ORB_BALL_SIZE = 72;
/** 透明内衬：给阴影 / 描边留空间，别被窗口裁掉 */
export const ORB_CHROME_INSET = 12;
/** 默认位置：工作区竖直中心再往下 8% */
export const ORB_DEFAULT_BELOW_CENTER = 0.08;

/** 固定窗口尺寸（A 重做）：球与面板同窗，展开/收起永不改窗口大小 */
export const ORB_WINDOW_SIZE = { width: 360, height: 440 } as const;
/** 面板尺寸 = 固定窗口 - 2*内衬（渲染端 #panel inset:12 与此对应） */
export const ORB_PANEL_SIZE = {
  width: ORB_WINDOW_SIZE.width - 2 * ORB_CHROME_INSET,
  height: ORB_WINDOW_SIZE.height - 2 * ORB_CHROME_INSET,
} as const;

export interface OrbOrigin {
  x: number;
  y: number;
}

export interface OrbWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 球态球原点夹紧：球必须整颗可见，内衬允许出屏 ORB_CHROME_INSET（参考 :527-535 clampedBallOrigin）。
 * 启动恢复 / 拖动落点用它（球口径），面板摆位再由 orbFixedWindowBounds 按方向夹。
 */
export function clampOrbBallOrigin(ball: OrbOrigin, workArea: OrbWorkArea): OrbOrigin {
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), Math.max(min, max));
  return {
    x: clamp(Math.round(ball.x), workArea.x, workArea.x + workArea.width - ORB_BALL_SIZE),
    y: clamp(Math.round(ball.y), workArea.y, workArea.y + workArea.height - ORB_BALL_SIZE),
  };
}

/** 首次启动的球落点：工作区水平居中、竖直中心下偏 ORB_DEFAULT_BELOW_CENTER（球口径已夹紧） */
export function defaultOrbOrigin(workArea: OrbWorkArea): OrbOrigin {
  const x = workArea.x + (workArea.width - ORB_BALL_SIZE) / 2;
  const y =
    workArea.y +
    (workArea.height - ORB_BALL_SIZE) / 2 +
    workArea.height * ORB_DEFAULT_BELOW_CENTER;
  return clampOrbBallOrigin({ x, y }, workArea);
}

// ==================== 展开 / 贴边收纳（纯函数，electron-free）====================
// 停靠常量取数自参考实现 floating-window.ts:131-224；方向公式对齐 :489-499。

export const ORB_DOCK_OVERLAP = 14; // round(72/5)：球压过屏幕边这么多才算停靠
export const ORB_DOCK_TAB_WIDTH = 6; // 画出来的细条宽
export const ORB_DOCK_TAB_HEIGHT = 72;
export const ORB_DOCK_GLOW = 8; // 细条两侧光晕（命中区用）
export const ORB_DOCK_HOVER_MARGIN = 20; // 命中区在光晕外再放宽的容错
export const ORB_DOCK_HIT_WIDTH = 34; // 6+8+20：细条窗口的可点宽度
export const ORB_DOCK_HIT_HEIGHT = 88; // 72+2*8
export const ORB_DOCK_OFF_GAP = 2; // 滑出屏幕外留的缝
export const ORB_DOCK_IN_PAD = 5; // 滑回后离屏幕边
export const ORB_DOCK_SLIDE_OFF_MS = 250;
export const ORB_DOCK_SLIDE_IN_MS = 300;

export type OrbHorizontal = "left" | "right";
export type OrbVertical = "up" | "down";
export type OrbDockSide = "left" | "right";
export interface OrbDirection {
  horizontal: OrbHorizontal;
  vertical: OrbVertical;
}

/**
 * 展开方向（四象限）：面板要长向有空间的那侧。
 * 球心在工作区左半 → 面板向右长；球顶离工作区顶不足「面板高 - 球高」→ 面板向下长（参考 :489-499）。
 */
export function orbExpandDirection(ball: OrbOrigin, workArea: OrbWorkArea): OrbDirection {
  const centerX = ball.x + ORB_BALL_SIZE / 2;
  const horizontal: OrbHorizontal = centerX - workArea.x > workArea.width / 2 ? "left" : "right";
  const vertical: OrbVertical =
    ball.y - workArea.y < ORB_PANEL_SIZE.height - ORB_BALL_SIZE ? "down" : "up";
  return { horizontal, vertical };
}

/** 球在固定窗口内的角偏移：面板向左长（horizontal="left"）→ 球贴窗口右缘，其余对称 */
export function orbBallOffsetInWindow(dir: OrbDirection): OrbOrigin {
  return {
    x:
      dir.horizontal === "left"
        ? ORB_WINDOW_SIZE.width - ORB_CHROME_INSET - ORB_BALL_SIZE
        : ORB_CHROME_INSET,
    y:
      dir.vertical === "up"
        ? ORB_WINDOW_SIZE.height - ORB_CHROME_INSET - ORB_BALL_SIZE
        : ORB_CHROME_INSET,
  };
}

/**
 * 固定窗口矩形：球落点固定为窗口某角（按 dir），宽高恒等于 ORB_WINDOW_SIZE。
 * 球所在侧允许出屏 ORB_CHROME_INSET（与旧展开窗口同一夹紧口径）：球可贴屏幕边，
 * 而面板（inset 12）仍完整在屏内不出屏。
 */
export function orbFixedWindowBounds(
  ball: OrbOrigin,
  dir: OrbDirection,
  workArea: OrbWorkArea,
): OrbWorkArea {
  const off = orbBallOffsetInWindow(dir);
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), Math.max(min, max));
  const x = clamp(
    Math.round(ball.x) - off.x,
    dir.horizontal === "right" ? workArea.x - ORB_CHROME_INSET : workArea.x,
    dir.horizontal === "right"
      ? workArea.x + workArea.width - ORB_WINDOW_SIZE.width
      : workArea.x + workArea.width - ORB_WINDOW_SIZE.width + ORB_CHROME_INSET,
  );
  const y = clamp(
    Math.round(ball.y) - off.y,
    dir.vertical === "down" ? workArea.y - ORB_CHROME_INSET : workArea.y,
    dir.vertical === "down"
      ? workArea.y + workArea.height - ORB_WINDOW_SIZE.height
      : workArea.y + workArea.height - ORB_WINDOW_SIZE.height + ORB_CHROME_INSET,
  );
  return { x, y, width: ORB_WINDOW_SIZE.width, height: ORB_WINDOW_SIZE.height };
}

/** 球压过左/右屏幕边 ≥ ORB_DOCK_OVERLAP 时的停靠边；上/下不停靠（参考 :292-301） */
export function orbDockSideForOrigin(ball: OrbOrigin, bounds: OrbWorkArea): OrbDockSide | undefined {
  const leftOverlap = bounds.x - ball.x;
  const rightOverlap = ball.x + ORB_BALL_SIZE - (bounds.x + bounds.width);
  if (leftOverlap >= ORB_DOCK_OVERLAP && leftOverlap >= rightOverlap) return "left";
  if (rightOverlap >= ORB_DOCK_OVERLAP) return "right";
  return undefined;
}

/** 贴边细条的窗口矩形：宽 34 高 88、贴左/右屏边、竖直跟随球（参考 :310-326） */
export function orbDockedTabBounds(side: OrbDockSide, ballY: number, bounds: OrbWorkArea): OrbWorkArea {
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), Math.max(min, max));
  return {
    x: side === "left" ? bounds.x : bounds.x + bounds.width - ORB_DOCK_HIT_WIDTH,
    y: clamp(Math.round(ballY - ORB_DOCK_GLOW), bounds.y, bounds.y + bounds.height - ORB_DOCK_HIT_HEIGHT),
    width: ORB_DOCK_HIT_WIDTH,
    height: ORB_DOCK_HIT_HEIGHT,
  };
}

/** 球滑出屏幕外的原点（滑出动画终点；左/右对称；参考 :332-344） */
export function orbOffScreenOrigin(side: OrbDockSide, ballY: number, bounds: OrbWorkArea): OrbOrigin {
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), Math.max(min, max));
  return {
    x:
      side === "left"
        ? bounds.x - ORB_BALL_SIZE - ORB_DOCK_OFF_GAP
        : bounds.x + bounds.width + ORB_DOCK_OFF_GAP,
    y: clamp(Math.round(ballY), bounds.y, bounds.y + bounds.height - ORB_BALL_SIZE),
  };
}

/** 滑回后球的原点（离屏边 ORB_DOCK_IN_PAD，竖直夹进工作区；参考 :346-361） */
export function orbInsideOrigin(side: OrbDockSide, ballY: number, workArea: OrbWorkArea): OrbOrigin {
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), Math.max(min, max));
  return {
    x:
      side === "left"
        ? workArea.x + ORB_DOCK_IN_PAD
        : workArea.x + workArea.width - ORB_BALL_SIZE - ORB_DOCK_IN_PAD,
    y: clamp(Math.round(ballY), workArea.y, workArea.y + workArea.height - ORB_BALL_SIZE),
  };
}
