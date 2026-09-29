// 8.7.7：工具箱 · 工具独立子窗口（主进程）
// 同 id 只存在一个窗口：已有就 restore + show + focus，否则新建。
// preload / html / devURL 一律由 main/index.ts 注入（本文件不许自己拼层级），
// 工具信息经 ur 参数透传给子窗渲染层（tool-window.ts 读取画标题栏 + 占位面板）。
import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { ToolboxOpenPayload } from "../../shared/toolbox";

export interface ToolboxWindowDeps {
  preloadPath: string;
  /** dist/renderer/tool-window/index.html（生产 loadFile 用） */
  htmlPath: string;
  devServerUrl: string;
  isDev: boolean;
}

const TOOL_WINDOW_WIDTH = 780;
const TOOL_WINDOW_HEIGHT = 580;

/** 透传给子窗的字段白名单（只传这 5 个，防脏数据灌进 ur 参数） */
function toQuery(payload: ToolboxOpenPayload): Record<string, string> {
  return {
    t: String(payload.id ?? ""),
    title: String(payload.title ?? ""),
    sub: String(payload.sub ?? ""),
    kind: payload.kind === "launcher" ? "launcher" : "self",
    hint: String(payload.hint ?? ""),
  };
}

function toQueryString(q: Record<string, string>): string {
  return Object.entries(q)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

export function registerToolboxHandlers(deps: ToolboxWindowDeps): void {
  const windows = new Map<string, BrowserWindow>();

  ipcMain.on(IPC.TOOLBOX_OPEN, (_event, payload: ToolboxOpenPayload) => {
    const id = payload?.id;
    if (typeof id !== "string" || id.length === 0) return;

    const existing = windows.get(id);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }

    const query = toQuery(payload);
    const win = new BrowserWindow({
      width: TOOL_WINDOW_WIDTH,
      height: TOOL_WINDOW_HEIGHT,
      // 无边框自绘标题栏（tool-window.css #tool-titlebar），同主窗口 frame:false 口径
      frame: false,
      backgroundColor: "#eefaf4",
      show: false,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    win.once("ready-to-show", () => win.show());
    win.on("closed", () => windows.delete(id));
    windows.set(id, win);

    if (deps.isDev) {
      void win.loadURL(`${deps.devServerUrl}/tool-window/index.html?${toQueryString(query)}`);
    } else {
      void win.loadFile(deps.htmlPath, { query });
    }
  });
}