// orb-geometry 单测（A 重做后）：defaultOrbOrigin（球口径）/ clampOrbBallOrigin / 固定窗口几何。
// 被测模块 electron-free，node 环境直接 import；不 mock electron（指令 §4 坑 10）。
import { describe, expect, it } from "vitest";
import {
  ORB_BALL_SIZE,
  ORB_CHROME_INSET,
  ORB_WINDOW_SIZE,
  clampOrbBallOrigin,
  defaultOrbOrigin,
  orbBallOffsetInWindow,
  orbDockSideForOrigin,
  orbDockedTabBounds,
  orbExpandDirection,
  orbFixedWindowBounds,
  orbInsideOrigin,
  orbOffScreenOrigin,
} from "../src/main/orb/orb-geometry";

describe("defaultOrbOrigin（球口径：球 72）", () => {
  it("1440×900：水平居中、竖直中心 +8%", () => {
    const o = defaultOrbOrigin({ x: 0, y: 0, width: 1440, height: 900 });
    expect(o.x).toBe(684); // (1440 - 72) / 2
    expect(o.y).toBe(486); // (900 - 72) / 2 + 900 * 0.08 = 414 + 72
  });

  it("副屏（x=1920）：结果整体带偏移", () => {
    const o = defaultOrbOrigin({ x: 1920, y: 0, width: 1440, height: 900 });
    expect(o.x).toBe(1920 + 684);
    expect(o.y).toBe(486);
  });

  it("工作区比球还小时：落回 workArea.x/y", () => {
    const o = defaultOrbOrigin({ x: 0, y: 0, width: 80, height: 60 });
    expect(o).toEqual({ x: 4, y: 0 }); // x=(80-72)/2=4 未越界；y 负值被夹回 0
  });
});

describe("clampOrbBallOrigin（球视角：球整颗可见，内衬允许出屏）", () => {
  const work = { x: 100, y: 50, width: 1440, height: 900 };

  it("屏内原样返回", () => {
    expect(clampOrbBallOrigin({ x: 700, y: 400 }, work)).toEqual({ x: 700, y: 400 });
  });

  it("四向越界都夹到「球贴边」极限（窗口内衬可出屏）", () => {
    expect(clampOrbBallOrigin({ x: -500, y: 400 }, work).x).toBe(100); // 球贴左缘
    expect(clampOrbBallOrigin({ x: 5000, y: 400 }, work).x).toBe(100 + 1440 - ORB_BALL_SIZE); // 球贴右缘
    expect(clampOrbBallOrigin({ x: 400, y: -500 }, work).y).toBe(50);
    expect(clampOrbBallOrigin({ x: 400, y: 5000 }, work).y).toBe(50 + 900 - ORB_BALL_SIZE);
  });

  it("滑回落点（离边 5px、窗口内衬出屏 7px）夹紧后原样保留", () => {
    const ballX = 100 + 1440 - ORB_BALL_SIZE - 5; // orbInsideOrigin("right")
    expect(clampOrbBallOrigin({ x: ballX, y: 400 }, work)).toEqual({ x: ballX, y: 400 });
  });
});

// ==================== A 重做：固定窗口几何 ====================
const screen1440 = { x: 0, y: 0, width: 1440, height: 900 };

describe("orbBallOffsetInWindow", () => {
  it("方向决定球贴哪个角：right/down → 左上角（内衬）；left/up → 右下角", () => {
    expect(orbBallOffsetInWindow({ horizontal: "right", vertical: "down" })).toEqual({
      x: ORB_CHROME_INSET,
      y: ORB_CHROME_INSET,
    });
    expect(orbBallOffsetInWindow({ horizontal: "left", vertical: "up" })).toEqual({
      x: ORB_WINDOW_SIZE.width - ORB_CHROME_INSET - ORB_BALL_SIZE,
      y: ORB_WINDOW_SIZE.height - ORB_CHROME_INSET - ORB_BALL_SIZE,
    });
  });
});

describe("orbExpandDirection", () => {
  it("四象限：球心在左半 → 面板向右长；上方空间不足 344 → 向下长", () => {
    expect(orbExpandDirection({ x: 100, y: 100 }, screen1440)).toEqual({ horizontal: "right", vertical: "down" });
    expect(orbExpandDirection({ x: 1300, y: 100 }, screen1440)).toEqual({ horizontal: "left", vertical: "down" });
    expect(orbExpandDirection({ x: 100, y: 600 }, screen1440)).toEqual({ horizontal: "right", vertical: "up" });
    expect(orbExpandDirection({ x: 1300, y: 600 }, screen1440)).toEqual({ horizontal: "left", vertical: "up" });
  });

  it("边界：球心恰在中线 → right；球顶恰在 344 → up", () => {
    expect(orbExpandDirection({ x: 684, y: 344 }, screen1440)).toEqual({ horizontal: "right", vertical: "up" });
  });
});

describe("orbFixedWindowBounds", () => {
  it("宽高恒等于 ORB_WINDOW_SIZE；球相对窗口按方向落角", () => {
    const dir = { horizontal: "right", vertical: "up" } as const;
    const b = orbFixedWindowBounds({ x: 672, y: 474 }, dir, screen1440);
    expect(b.width).toBe(ORB_WINDOW_SIZE.width);
    expect(b.height).toBe(ORB_WINDOW_SIZE.height);
    expect(b.x + ORB_CHROME_INSET).toBe(672); // right：球贴窗口左
    expect(b.y + b.height - ORB_CHROME_INSET - ORB_BALL_SIZE).toBe(474); // up：球贴窗口底
  });

  it("贴右下角的球：窗口球侧允许出屏一个内衬，球仍贴屏边", () => {
    const b = orbFixedWindowBounds({ x: 1368, y: 828 }, { horizontal: "left", vertical: "up" }, screen1440);
    expect(b.x).toBe(1440 - ORB_WINDOW_SIZE.width + ORB_CHROME_INSET);
    expect(b.y).toBe(900 - ORB_WINDOW_SIZE.height + ORB_CHROME_INSET);
    expect(b.x + b.width - ORB_CHROME_INSET - ORB_BALL_SIZE).toBe(1368); // 球没被夹动
  });

  it("贴左上角的球：窗口原点夹到 -12（内衬出屏），面板（inset 12）仍完整在屏内", () => {
    const b = orbFixedWindowBounds({ x: 0, y: 0 }, { horizontal: "right", vertical: "down" }, screen1440);
    expect(b).toEqual({ x: -12, y: -12, width: ORB_WINDOW_SIZE.width, height: ORB_WINDOW_SIZE.height });
  });

  it("方向不同也不改尺寸：同一球位任意方向 → 宽高一致（A 核心约束）", () => {
    const dirs = [
      { horizontal: "left", vertical: "up" },
      { horizontal: "left", vertical: "down" },
      { horizontal: "right", vertical: "up" },
      { horizontal: "right", vertical: "down" },
    ] as const;
    const rects = dirs.map((d) => orbFixedWindowBounds({ x: 672, y: 474 }, d, screen1440));
    for (const r of rects) {
      expect(r.width).toBe(ORB_WINDOW_SIZE.width);
      expect(r.height).toBe(ORB_WINDOW_SIZE.height);
    }
  });
});

describe("orbDockSideForOrigin", () => {
  it("左侧压边 13 不停靠 / 14 停靠", () => {
    expect(orbDockSideForOrigin({ x: -13, y: 400 }, screen1440)).toBeUndefined();
    expect(orbDockSideForOrigin({ x: -14, y: 400 }, screen1440)).toBe("left");
  });

  it("右侧压边 13 不停靠 / 14 停靠", () => {
    expect(orbDockSideForOrigin({ x: 1440 - 72 + 13, y: 400 }, screen1440)).toBeUndefined();
    expect(orbDockSideForOrigin({ x: 1440 - 72 + 14, y: 400 }, screen1440)).toBe("right");
  });

  it("屏内 / 上边压出 / 下边压出：不停靠", () => {
    expect(orbDockSideForOrigin({ x: 400, y: 400 }, screen1440)).toBeUndefined();
    expect(orbDockSideForOrigin({ x: 400, y: -14 }, screen1440)).toBeUndefined();
    expect(orbDockSideForOrigin({ x: 400, y: 900 - 72 + 14 }, screen1440)).toBeUndefined();
  });
});

describe("orbDockedTabBounds", () => {
  it("贴左屏边、竖直跟随球（-GLOW）", () => {
    expect(orbDockedTabBounds("left", 400, screen1440)).toEqual({ x: 0, y: 392, width: 34, height: 88 });
  });

  it("贴右屏边：x 差一个命中宽度", () => {
    expect(orbDockedTabBounds("right", 400, screen1440).x).toBe(1440 - 34);
  });

  it("竖直夹紧：越界回 [bounds.y, bounds.y + height - 88]", () => {
    expect(orbDockedTabBounds("left", -500, screen1440).y).toBe(0);
    expect(orbDockedTabBounds("left", 5000, screen1440).y).toBe(900 - 88);
  });
});

describe("orbOffScreenOrigin / orbInsideOrigin", () => {
  it("滑出：左右对称（各离屏 72+2）", () => {
    expect(orbOffScreenOrigin("left", 400, screen1440)).toEqual({ x: -74, y: 400 });
    expect(orbOffScreenOrigin("right", 400, screen1440)).toEqual({ x: 1442, y: 400 });
  });

  it("滑回：离屏边 IN_PAD（5），左右对称", () => {
    expect(orbInsideOrigin("left", 400, screen1440)).toEqual({ x: 5, y: 400 });
    expect(orbInsideOrigin("right", 400, screen1440)).toEqual({ x: 1440 - 72 - 5, y: 400 });
    expect(orbInsideOrigin("left", 400, screen1440).x - screen1440.x).toBe(
      screen1440.x + screen1440.width - (orbInsideOrigin("right", 400, screen1440).x + 72),
    );
  });

  it("竖直夹紧：越界回 [区顶, 区底 - 72]", () => {
    expect(orbOffScreenOrigin("left", -500, screen1440).y).toBe(0);
    expect(orbOffScreenOrigin("left", 5000, screen1440).y).toBe(900 - 72);
    expect(orbInsideOrigin("left", -500, screen1440).y).toBe(0);
    expect(orbInsideOrigin("left", 5000, screen1440).y).toBe(900 - 72);
  });
});
