// 语音通话独立窗口（微信式重做）：悬浮球右键「语音通话」→ 弹出**独立小窗**，
// 不再带出主窗口内的浮层。窗口职责只有「显示 + 采集/播放生命周期」（判断全在主进程状态机）。
// 联动：开窗即隐藏悬浮球，窗口关闭（挂断/Alt+F4）即恢复悬浮球（showInactive 不抢焦点）。
// 头像跟随悬浮球：初始由渲染端 orb.getState() 拉取，变更经 forwardAvatar 转发 ORB_AVATAR。
// 结构照 toolbox/tool-window.ts：preload / html / devURL 由 main/index.ts 注入，本文件不拼层级。
import { BrowserWindow, ipcMain, screen } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { hangupActiveCall } from "./ipc-register";

export interface CallWindowDeps {
  preloadPath: string;
  /** dist/renderer/call-window/index.html（生产 loadFile 用） */
  htmlPath: string;
  devServerUrl: string;
  isDev: boolean;
  /** 悬浮球窗引用（index.ts 持有）：通话时隐藏，挂断后恢复 */
  getOrbWindow: () => BrowserWindow | null;
}

export interface CallWindowController {
  /** 打开（或聚焦已存在的）通话窗口；同时隐藏悬浮球 */
  open(): void;
  /** 悬浮球头像变更 → 转发给通话窗口（ORB_AVATAR；窗口加载中早到的广播会丢，渲染端开屏自拉兜底） */
  forwardAvatar(dataUrl: string): void;
}

/** 窗体尺寸：卡片 + 透明留白（圆角/阴影画在页面里，窗口本身全透明） */
const CALL_WINDOW_WIDTH = 420;
const CALL_WINDOW_HEIGHT = 640;

export function createCallWindowController(deps: CallWindowDeps): CallWindowController {
  let win: BrowserWindow | null = null;

  const hideOrb = (): void => {
    const orb = deps.getOrbWindow();
    if (orb && !orb.isDestroyed() && orb.isVisible()) orb.hide();
  };

  /** 恢复悬浮球：showInactive —— 通话挂断不该从用户手里抢焦点 */
  const restoreOrb = (): void => {
    const orb = deps.getOrbWindow();
    if (orb && !orb.isDestroyed() && !orb.isVisible()) orb.showInactive();
  };

  function open(): void {
    if (win && !win.isDestroyed()) {
      hideOrb();
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }
    // 居中：优先取悬浮球所在显示器（窗口跟人走），球不在退主屏
    const orb = deps.getOrbWindow();
    const orbBounds = orb && !orb.isDestroyed() ? orb.getBounds() : null;
    const display = orbBounds
      ? screen.getDisplayNearestPoint({ x: orbBounds.x + orbBounds.width / 2, y: orbBounds.y + orbBounds.height / 2 })
      : screen.getPrimaryDisplay();
    const wa = display.workArea;
    win = new BrowserWindow({
      width: CALL_WINDOW_WIDTH,
      height: CALL_WINDOW_HEIGHT,
      x: Math.round(wa.x + (wa.width - CALL_WINDOW_WIDTH) / 2),
      y: Math.round(wa.y + (wa.height - CALL_WINDOW_HEIGHT) / 2),
      frame: false,
      transparent: true, // 圆角卡片 + 阴影画在页面里（同悬浮球的全透明口径）
      backgroundColor: "#00000000",
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      roundedCorners: false,
      show: false,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.once("ready-to-show", () => {
      hideOrb(); // ready 前就 hide 过，这里再兜一次（防两次 open 竞态）
      win?.show();
      win?.focus();
    });
    // 关窗 = 通话结束（渲染端挂断时自己 close；Alt+F4 也走这）→ 挂干净状态机 + 悬浮球回来
    win.on("closed", () => {
      win = null;
      hangupActiveCall();
      restoreOrb();
    });

    if (deps.isDev) void win.loadURL(`${deps.devServerUrl}/call-window/index.html`);
    else void win.loadFile(deps.htmlPath);
  }

  return {
    open,
    forwardAvatar: (dataUrl: string): void => {
      if (win && !win.isDestroyed()) win.webContents.send(IPC.ORB_AVATAR, dataUrl);
    },
  };
}
