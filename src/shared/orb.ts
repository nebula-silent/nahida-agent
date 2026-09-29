// 悬浮球（5.9.1 / 5.9.2）：主进程 / preload / 渲染端共享的类型。
// 只放类型，不放常量 —— 几何常量在 main/orb/orb-geometry.ts，通道在 shared/ipc-channels.ts。

/** 展开方向：面板长向哪侧（5.9.2） */
export type OrbHorizontal = "left" | "right";
export type OrbVertical = "up" | "down";
/** 停靠边：只做左 / 右（上 / 下不停靠） */
export type OrbDockSide = "left" | "right";

/** 几何投影（ORB_STATE / OrbView.expand）：渲染端唯一几何真相。
 *  A 重做后面板开合归渲染端自持（切 class），此投影只含停靠边 + 展开方向（决定球贴窗口哪个角）。 */
export interface OrbExpandState {
  docked: OrbDockSide | null;
  horizontal: OrbHorizontal;
  vertical: OrbVertical;
}

/** ORB_STATE_GET 返回 / 球窗口视图：头像 dataURL（已解析好，不会是空串）+ 窗口左上角坐标（DIP）+ 几何投影 */
export interface OrbView {
  avatar: string;
  x: number;
  y: number;
  expand: OrbExpandState;
}