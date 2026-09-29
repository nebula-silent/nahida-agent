// 悬浮球窗口（A 重做）：固定尺寸透明窗（360×440）—— 展开/收起不再改窗口尺寸，
// 面板开合由渲染端 CSS scale 完成（orb.css #panel transform + body.open），主进程只管：
// 拖拽换位 / 四象限定方向摆窗 / 贴边停靠细条 / 头像 / 右键菜单。
// 几何纯函数在 orb-geometry.ts；preload / html / devURL 一律由 main/index.ts 注入。
import { BrowserWindow, Menu, dialog, ipcMain, screen, type MenuItemConstructorOptions } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { OrbExpandState, OrbView } from "../../shared/orb";
import {
  ORB_BALL_SIZE,
  ORB_CHROME_INSET,
  ORB_DOCK_SLIDE_IN_MS,
  ORB_DOCK_SLIDE_OFF_MS,
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
  type OrbDirection,
  type OrbDockSide,
  type OrbOrigin,
  type OrbWorkArea,
} from "./orb-geometry";
import { defaultOrbAvatarDataUrl, readOrbAvatarDataUrl } from "./orb-avatar";

export interface OrbWindowDeps {
  /** 由 index.ts 注入（PRELOAD_PATH）—— 本文件不许自己拼层级 */
  preloadPath: string;
  /** 由 index.ts 注入（dist/renderer/orb/index.html） */
  htmlPath: string;
  /** 由 index.ts 注入（DEV_SERVER_URL） */
  devServerUrl: string;
  isDev: boolean;
  /** 「打开主窗口」：有窗口就 restore + show + focus；没有就新建 */
  onOpenMain: () => void;
  /** 「语音通话」：带出主窗口 + 唤起通话浮层（浮层在主窗口里，所以必须先 show） */
  onStartCall: () => void;
  /** 菜单「退出」 */
  onQuit: () => void;
  /** 落 `ui` 段（拖动结束 / 换头像 / 恢复默认 / 重置位置时各调一次）；orb.x/orb.y 存「球原点」 */
  persist: (patch: Record<string, string | number>) => void;
  /** 读初始球原点（index.ts 从 loadConfig().ui 取；没存过是 NaN，由本文件用默认落点兜底） */
  readOrigin: () => { x: number; y: number };
  /** 读停靠边（"" = 未停靠）—— 启动恢复细条用 */
  readDock: () => string;
  /** 读初始头像路径（"" = 内置默认） */
  readAvatarPath: () => string;
  /** 头像变更广播（换头像 / 恢复默认）：通话窗等其它窗口跟随（语音通话窗的头像同步靠它） */
  onAvatarChange?: (dataUrl: string) => void;
}

/** 取点所在显示器的工作区（多屏：夹紧必须用球所在屏，不许写死主屏） */
function workAreaNear(point: OrbOrigin): OrbWorkArea {
  const { workArea } = screen.getDisplayNearestPoint({
    x: Math.round(point.x),
    y: Math.round(point.y),
  });
  return { x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height };
}

// ==================== 模块级状态 + 停靠动画编排 ====================

/** 停靠记录（key = 窗口）：side + 竖直位置（球 Y）；无值 = 未停靠 */
const orbDock = new WeakMap<BrowserWindow, { side: OrbDockSide; y: number }>();
/** 展开方向（key = 窗口）：球贴窗口哪个角由此决定；摆窗/拖动落点时更新 */
const orbDirection = new WeakMap<BrowserWindow, OrbDirection>();
/** 动画句柄（key = 窗口，停靠滑出/滑回专用）：setInterval 16ms 推进，可被新动画/拖动/销毁取消 */
interface OrbAnim {
  cancelled: boolean;
  timer: ReturnType<typeof setInterval> | null;
  resolve: () => void;
}
const orbAnim = new WeakMap<BrowserWindow, OrbAnim>();

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

/** 按缓动插值窗口矩形（四维都 round，setBounds 要求整数）——只服务停靠滑出/滑回（纯平移） */
function lerpRect(start: OrbWorkArea, end: OrbWorkArea, t: number): OrbWorkArea {
  return {
    x: Math.round(start.x + (end.x - start.x) * t),
    y: Math.round(start.y + (end.y - start.y) * t),
    width: Math.round(start.width + (end.width - start.width) * t),
    height: Math.round(start.height + (end.height - start.height) * t),
  };
}

/** 取消动画并放行等待方（在已销毁窗口上 setBounds 会抛，所以动画必须可取消） */
function cancelOrbAnim(win: BrowserWindow): void {
  const anim = orbAnim.get(win);
  if (anim === undefined) return;
  anim.cancelled = true;
  if (anim.timer !== null) clearInterval(anim.timer);
  anim.resolve();
  orbAnim.delete(win);
}

/** 滑出 / 滑回动画：终点矩形 + 时长 + 缓动；Promise 在动画结束或被取消时 resolve */
function animateOrbBounds(
  win: BrowserWindow,
  end: OrbWorkArea,
  durationMs: number,
  ease: (t: number) => number,
): Promise<void> {
  cancelOrbAnim(win);
  if (win.isDestroyed()) return Promise.resolve();
  const start = win.getBounds();
  if (durationMs <= 0) {
    win.setBounds(end);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const anim: OrbAnim = { cancelled: false, timer: null, resolve };
    orbAnim.set(win, anim);
    const t0 = Date.now();
    anim.timer = setInterval(() => {
      if (anim.cancelled) return;
      if (win.isDestroyed()) {
        if (anim.timer !== null) clearInterval(anim.timer);
        orbAnim.delete(win);
        resolve();
        return;
      }
      const t = Math.min(1, (Date.now() - t0) / durationMs);
      win.setBounds(lerpRect(start, end, ease(t)));
      if (t < 1) return;
      if (anim.timer !== null) clearInterval(anim.timer);
      orbAnim.delete(win);
      resolve();
    }, 16);
  });
}

/** 取窗口所在显示器：bounds 用于贴边判定（屏幕物理边），workArea 用于夹紧 */
function displayNear(point: OrbOrigin): { bounds: OrbWorkArea; workArea: OrbWorkArea } {
  const { bounds, workArea } = screen.getDisplayNearestPoint({
    x: Math.round(point.x),
    y: Math.round(point.y),
  });
  return { bounds, workArea };
}

/** 球的竖直位置夹进屏幕 bounds：细条落点 / 滑出点共用 */
function clampOrbBallY(ballY: number, bounds: OrbWorkArea): number {
  const clamp = (value: number, min: number, max: number): number =>
    Math.min(Math.max(value, min), Math.max(min, max));
  return clamp(Math.round(ballY), bounds.y, bounds.y + bounds.height - ORB_BALL_SIZE);
}

/** 当前球原点 = 窗口原点 + 按 dir 的角偏移（窗口尺寸恒定，球永远贴窗口一角） */
function currentOrbBallOrigin(win: BrowserWindow): OrbOrigin {
  const [x, y] = win.getPosition();
  const dir = orbDirection.get(win);
  if (dir === undefined) return { x: x + ORB_CHROME_INSET, y: y + ORB_CHROME_INSET };
  const off = orbBallOffsetInWindow(dir);
  return { x: x + off.x, y: y + off.y };
}

/** 当前几何投影（ORB_STATE / ORB_STATE_GET 共用）：停靠边 + 展开方向。
 *  面板开合态归渲染端自持（A 重做），主进程不再知道也不推 expanded。docked 不许是 undefined（线上用 null）。 */
function currentOrbState(win: BrowserWindow): OrbExpandState {
  const ball = currentOrbBallOrigin(win);
  const display = displayNear(ball);
  const docked = orbDock.get(win);
  const dir = orbDirection.get(win) ?? orbExpandDirection(ball, display.workArea);
  return {
    docked: docked === undefined ? null : docked.side,
    horizontal: dir.horizontal,
    vertical: dir.vertical,
  };
}

/** 推 ORB_STATE：几何每次变化后都推（渲染端唯一几何真相，渲染端不许自己推几何） */
function pushOrbState(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  win.webContents.send(IPC.ORB_STATE, currentOrbState(win));
}

/** 摆成贴边细条 + 记停靠（松手停靠 / 折叠回细条 / 显示器变化 / 启动恢复共用；不播动画） */
function applyOrbDockedTab(win: BrowserWindow, side: OrbDockSide, ballY: number, bounds: OrbWorkArea): void {
  const y = clampOrbBallY(ballY, bounds);
  orbDock.set(win, { side, y });
  cancelOrbAnim(win);
  win.setBounds(orbDockedTabBounds(side, y, bounds));
}

/** 停靠滑出动画：固定窗口整体平移出屏（球保持贴窗口角，不会被窗口边裁掉）→ 落细条；
 *  尾部校验 dock 仍在且 side 相同 */
async function snapOrbToEdge(win: BrowserWindow, side: OrbDockSide, ballY: number, bounds: OrbWorkArea): Promise<void> {
  const y = clampOrbBallY(ballY, bounds);
  orbDock.set(win, { side, y });
  const off = orbBallOffsetInWindow(
    orbDirection.get(win) ?? { horizontal: "right", vertical: "down" },
  );
  const target = orbOffScreenOrigin(side, y, bounds);
  await animateOrbBounds(
    win,
    {
      x: Math.round(target.x - off.x),
      y: Math.round(target.y - off.y),
      width: ORB_WINDOW_SIZE.width,
      height: ORB_WINDOW_SIZE.height,
    },
    ORB_DOCK_SLIDE_OFF_MS,
    easeInOutCubic,
  );
  if (win.isDestroyed()) return;
  const docked = orbDock.get(win);
  if (docked === undefined || docked.side !== side) return;
  applyOrbDockedTab(win, side, y, bounds);
}

/** 拖动松手：球态压边 ≥ 阈值 → 停靠滑出；否则按球落点重摆固定窗口（重算方向 + 夹紧） */
async function clampOrbWindow(win: BrowserWindow): Promise<OrbDockSide | undefined> {
  const docked = orbDock.get(win);
  if (docked !== undefined) {
    // 防御：拖动只能从球发起，停靠态理论到不了；到则摆正细条
    applyOrbDockedTab(win, docked.side, docked.y, displayNear(currentOrbBallOrigin(win)).bounds);
    return docked.side;
  }
  const raw = currentOrbBallOrigin(win);
  const { bounds, workArea } = displayNear(raw);
  const side = orbDockSideForOrigin(raw, bounds);
  if (side !== undefined) {
    await snapOrbToEdge(win, side, raw.y, bounds);
    return side;
  }
  placeOrbWindow(win, clampOrbBallOrigin(raw, workArea), workArea);
  return undefined;
}

/** 把固定窗口摆到球落点：重算四象限方向 + 夹紧 + 记方向；
 *  返回夹紧后的真实球位（拖动落点 / 重置位置 / 显示器变化共用；启动走 createOrbWindow 内联逻辑） */
function placeOrbWindow(win: BrowserWindow, ball: OrbOrigin, workArea: OrbWorkArea): OrbOrigin {
  const dir = orbExpandDirection(ball, workArea);
  orbDirection.set(win, dir);
  cancelOrbAnim(win);
  const rect = orbFixedWindowBounds(ball, dir, workArea);
  win.setBounds(rect);
  const off = orbBallOffsetInWindow(dir);
  return { x: rect.x + off.x, y: rect.y + off.y };
}

/** 细条 → 滑回球（300ms）：窗口瞬移到屏幕外起点（球贴角），整体滑回工作区落位 */
async function unsnapOrbBall(win: BrowserWindow): Promise<void> {
  const docked = orbDock.get(win);
  if (docked === undefined) return;
  const { bounds, workArea } = displayNear(currentOrbBallOrigin(win));
  const endBall = orbInsideOrigin(docked.side, docked.y, workArea);
  const dir = orbExpandDirection(endBall, workArea);
  orbDock.delete(win);
  orbDirection.set(win, dir);
  const off = orbBallOffsetInWindow(dir);
  const startBall = orbOffScreenOrigin(docked.side, docked.y, bounds);
  win.setBounds({
    x: Math.round(startBall.x - off.x),
    y: Math.round(startBall.y - off.y),
    width: ORB_WINDOW_SIZE.width,
    height: ORB_WINDOW_SIZE.height,
  });
  await animateOrbBounds(win, orbFixedWindowBounds(endBall, dir, workArea), ORB_DOCK_SLIDE_IN_MS, easeOutCubic);
}

export function createOrbWindow(deps: OrbWindowDeps): BrowserWindow {
  // 初始落点：存过「球原点」→ 夹紧（球整颗可见、内衬允许出屏，重启不跳位）；
  // 没存过（NaN）→ 主屏居中下偏 8%。方向由球落点四象限定，窗口原点再由方向反推。
  const stored = deps.readOrigin();
  const hasStored = Number.isFinite(stored.x) && Number.isFinite(stored.y);
  const startWork = hasStored ? workAreaNear(stored) : screen.getPrimaryDisplay().workArea;
  const ball = hasStored ? clampOrbBallOrigin(stored, startWork) : defaultOrbOrigin(startWork);
  const dir = orbExpandDirection(ball, workAreaNear(ball));
  const rect = orbFixedWindowBounds(ball, dir, workAreaNear(ball));

  const win = new BrowserWindow({
    x: rect.x,
    y: rect.y,
    width: ORB_WINDOW_SIZE.width, // 固定尺寸：展开/收起永不改窗口大小（面板 CSS scale 开合）
    height: ORB_WINDOW_SIZE.height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000", // 全透明底：面板开合全程窗口不动，收起后只剩透明区不闪白
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    hasShadow: false,
    roundedCorners: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    webPreferences: {
      // 注入的 preloadPath —— 不自己拼（编译后 dist/main/main/orb/，层级数一变就静默失效）
      preload: deps.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  orbDirection.set(win, dir);
  win.setAlwaysOnTop(true, "screen-saver");
  // 球窗没有链接 / 弹窗需求：一律拒绝
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  win.once("ready-to-show", () => win.show());

  // 启动恢复：存过停靠边 → 直接摆成细条（不播动画）；存的是球原点，ballY 直接用。
  const dockSide = deps.readDock();
  if (dockSide === "left" || dockSide === "right") {
    applyOrbDockedTab(win, dockSide, ball.y, displayNear(ball).bounds);
  }

  /** 当前该显示的头像：路径可用 → 用户图；否则内置默认图（读盘失败也不白屏） */
  const currentAvatar = (): string =>
    readOrbAvatarDataUrl(deps.readAvatarPath()) || defaultOrbAvatarDataUrl();

  const pushAvatar = (dataUrl: string): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.ORB_AVATAR, dataUrl);
    deps.onAvatarChange?.(dataUrl);
  };

  // ==================== 右键菜单（原生 Menu）====================
  /** 换头像：用户取消什么都不做；文件不可用（超 2MB / 魔数不符）提示且不落盘 */
  async function pickAvatar(): Promise<void> {
    const r = await dialog.showOpenDialog(win, {
      title: "选择悬浮球头像",
      properties: ["openFile"],
      filters: [{ name: "图片（gif / png / webp）", extensions: ["gif", "png", "webp"] }],
    });
    const picked = r.canceled ? "" : (r.filePaths[0] ?? "");
    if (!picked) return;
    const dataUrl = readOrbAvatarDataUrl(picked);
    if (!dataUrl) {
      await dialog.showMessageBox(win, {
        type: "warning",
        message: "头像不可用",
        detail: "请选择 2MB 以内的 gif / png / webp 图片。",
      });
      return;
    }
    pushAvatar(dataUrl);
    deps.persist({ "orb.avatarPath": picked });
  }

  /** 重置位置：回到球当前所在屏的默认落点（停靠态一并回球态，并清掉 dock） */
  function resetPosition(): void {
    if (win.isDestroyed()) return;
    orbDock.delete(win);
    const workArea = workAreaNear(currentOrbBallOrigin(win));
    const final = placeOrbWindow(win, defaultOrbOrigin(workArea), workArea);
    deps.persist({ "orb.dock": "", "orb.x": final.x, "orb.y": final.y });
    pushOrbState(win);
  }

  /** 恢复默认头像：清掉存储路径 + 推内置图 */
  function restoreDefaultAvatar(): void {
    deps.persist({ "orb.avatarPath": "" });
    pushAvatar(defaultOrbAvatarDataUrl());
  }

  const template: MenuItemConstructorOptions[] = [
    { label: "语音通话", enabled: true, click: () => deps.onStartCall() },
    { type: "separator" },
    { label: "打开主窗口", click: () => deps.onOpenMain() },
    {
      label: "悬浮球设置",
      submenu: [
        { label: "更换头像…", click: () => { void pickAvatar(); } },
        { label: "重置位置", click: resetPosition },
        { label: "恢复默认头像", click: restoreDefaultAvatar },
      ],
    },
    { type: "separator" },
    { label: "退出", click: () => deps.onQuit() },
  ];
  const menu = Menu.buildFromTemplate(template);
  win.webContents.on("context-menu", () => menu.popup({ window: win }));

  // ==================== IPC ====================
  ipcMain.handle(IPC.ORB_STATE_GET, (): OrbView => {
    if (win.isDestroyed()) {
      return {
        avatar: currentAvatar(),
        x: rect.x,
        y: rect.y,
        expand: { docked: null, horizontal: dir.horizontal, vertical: dir.vertical },
      };
    }
    // x/y = 窗口原点（渲染端拖拽换算基准；球在窗口内的角位由方向决定，渲染端不用算）
    const [x, y] = win.getPosition();
    return { avatar: currentAvatar(), x, y, expand: currentOrbState(win) };
  });

  // 拖动：move 只挪窗口、**不夹紧**（球要能被拖到屏幕边外，停靠判定才有前提）；
  // end 才夹紧 / 判停靠 / 落盘一次（拖拽期间不写盘）
  ipcMain.on(IPC.ORB_DRAG, (_event, p: { phase: "move" | "end"; x: number; y: number }) => {
    if (win.isDestroyed()) return;
    if (p.phase === "move") {
      cancelOrbAnim(win); // 动画途中用户又拖：动画必须让路
      win.setPosition(Math.round(p.x), Math.round(p.y));
      return;
    }
    void handleOrbDragEnd(p);
  });

  /** 松手落盘：停靠 → 写「滑回落点」（球原点）+ dock 边；未停靠 → 写夹紧后的球原点 + 清 dock */
  async function handleOrbDragEnd(p: { x: number; y: number }): Promise<void> {
    const side = await clampOrbWindow(win);
    if (win.isDestroyed()) return;
    if (side !== undefined) {
      const workArea = workAreaNear(currentOrbBallOrigin(win));
      const docked = orbDock.get(win);
      const landing = orbInsideOrigin(side, docked !== undefined ? docked.y : p.y + ORB_CHROME_INSET, workArea);
      deps.persist({ "orb.dock": side, "orb.x": landing.x, "orb.y": landing.y });
    } else {
      const final = currentOrbBallOrigin(win);
      deps.persist({ "orb.dock": "", "orb.x": final.x, "orb.y": final.y });
    }
    pushOrbState(win);
  }

  // 穿透：forward:true 必须 —— 否则穿透后渲染端再也收不到 pointermove，球回不来。
  // 状态缓存放这：光标轮询（下方）只在「不穿透」时跑 —— 穿透 = 收起态，面板必然已收，无需盯
  let passthroughOn = false;
  ipcMain.on(IPC.ORB_SET_PASSTHROUGH, (_event, on: boolean) => {
    if (win.isDestroyed()) return;
    passthroughOn = !!on;
    win.setIgnoreMouseEvents(!!on, { forward: true });
  });

  // 光标轮询兜底「移走即缩回」：Windows 透明无边框窗上鼠标滑出时 Chromium 经常不派发
  // mouseleave / pointerleave / mouseout（实测三个全不触发），DOM 侧没有任何「离开」事件可用。
  // 主进程每 200ms 用系统光标位置判出窗，连续 2 次（≈400ms，防贴边抖动误报）才通知渲染端折叠。
  const CURSOR_POLL_MS = 200;
  const CURSOR_EDGE_SLACK = 2; // 出界容差（px）：光标贴窗口边缘抖动不算离开
  let outsideStreak = 0;
  const cursorPoll = setInterval(() => {
    if (win.isDestroyed() || passthroughOn) {
      outsideStreak = 0;
      return;
    }
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const outside =
      p.x < b.x - CURSOR_EDGE_SLACK ||
      p.x > b.x + b.width + CURSOR_EDGE_SLACK ||
      p.y < b.y - CURSOR_EDGE_SLACK ||
      p.y > b.y + b.height + CURSOR_EDGE_SLACK;
    outsideStreak = outside ? outsideStreak + 1 : 0;
    if (outsideStreak >= 2) {
      outsideStreak = 0;
      win.webContents.send(IPC.ORB_POINTER_LEFT);
    }
  }, CURSOR_POLL_MS);
  win.on("closed", () => clearInterval(cursorPoll));

  // 细条悬停 → 滑回球（动画走完才落盘 + 推状态）
  ipcMain.on(IPC.ORB_UNSNAP, () => {
    void (async (): Promise<void> => {
      if (win.isDestroyed()) return;
      await unsnapOrbBall(win);
      if (win.isDestroyed()) return;
      const final = currentOrbBallOrigin(win);
      deps.persist({ "orb.dock": "", "orb.x": final.x, "orb.y": final.y });
      pushOrbState(win);
    })();
  });

  // 显示器变化（加 / 拔 / 改缩放会连发）→ 去抖 100ms 后按当前形态重排，球 / 细条不许跑丢
  let displayDebounce: ReturnType<typeof setTimeout> | null = null;
  const onDisplayChange = (): void => {
    if (win.isDestroyed()) return;
    if (displayDebounce !== null) clearTimeout(displayDebounce);
    displayDebounce = setTimeout(() => {
      displayDebounce = null;
      if (win.isDestroyed()) return;
      const docked = orbDock.get(win);
      if (docked !== undefined) {
        applyOrbDockedTab(win, docked.side, docked.y, displayNear(currentOrbBallOrigin(win)).bounds);
      } else {
        const cur = currentOrbBallOrigin(win);
        placeOrbWindow(win, clampOrbBallOrigin(cur, workAreaNear(cur)), workAreaNear(cur));
      }
      pushOrbState(win);
    }, 100);
  };
  screen.on("display-added", onDisplayChange);
  screen.on("display-removed", onDisplayChange);
  screen.on("display-metrics-changed", onDisplayChange);

  win.on("closed", () => {
    screen.removeListener("display-added", onDisplayChange);
    screen.removeListener("display-removed", onDisplayChange);
    screen.removeListener("display-metrics-changed", onDisplayChange);
    if (displayDebounce !== null) clearTimeout(displayDebounce);
    cancelOrbAnim(win);
  });

  // 启动即推一次头像：渲染端可能早于 ORB_STATE_GET 就绪，两条路都要能用
  win.webContents.on("did-finish-load", () => pushAvatar(currentAvatar()));

  if (deps.isDev) void win.loadURL(`${deps.devServerUrl}/orb/index.html`);
  else void win.loadFile(deps.htmlPath);

  return win;
}
