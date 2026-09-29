// 参考自 Cyrene-Agent src/main/index.ts
// 骨架版：只保留应用生命周期、主窗口创建、基础 IPC 注册；Live2D / TTS 等业务逻辑未搬入
// 已接入：统一 chat 接口（3.6：loadConfig → resolveRequestContext → getTransport().chat，
//         默认本地 Ollama；chat:list-models / chat:start / chat:abort）
//         应用配置存储（config:get / config:set，明文凭据不出主进程）
//         对话存储（chats:list/create/get/append/delete，轻索引 + 重会话）
//         模型配置（provider:list-presets 预设投影 / provider:test 连接测试，3.7）
//         音乐（9.x：网易云，bootstrapMusicService —— music:* IPC + Python MCP 后端生命周期）
import { app, BrowserWindow, ipcMain, session, shell, type WebContents } from "electron";
import * as path from "path";
import { IPC } from "../shared/ipc-channels";
import type { ChatMessage, ChatRequest } from "../shared/chat";
import type { AppConfig } from "../shared/config";
import { PROVIDER_PRESETS } from "../shared/provider/presets";
import { getCapabilityOrOpenAI } from "../shared/provider/capabilities";
import type { PresetSummary } from "../shared/provider/types";
import { runChat, listModelsForProvider } from "./provider/chat";
import { testConnection } from "./provider/test-connection";
import { testVisionConnection } from "./provider/vision"; // 8.1：视觉旁路（连接测试 IPC）
import { registerConfigHandlers, loadConfig, saveConfig } from "./config/config-store"; // 4.6：+loadConfig（注入 stored 读取器用）；5.9.1：+saveConfig（悬浮球落 ui 段）
import { registerChatsHandlers, getSession, listSessions, createSession, appendMessage, deleteSession } from "./chats/chats-store";
import { registerBuiltinTools, registerFsHandlers } from "./tools/builtin-tools";
import { toolRegistry } from "./tools/tool-registry"; // 8.12：启动时应用持久化的停用清单
import { registerToolPermissionHandlers } from "./tools/permission";
import { registerToolApprovalHandlers, requestApproval, rejectAllApprovals, resolveApproval } from "./tools/approval";
import { appendAudit, registerAuditHandlers } from "./tools/audit"; // 8.4：操作审计（落盘 + 查看 / 打开目录两条 IPC）
import { registerBuiltinVoiceEngines } from "./voice/registry";
import { registerVoiceHandlers } from "./voice/ipc-register"; // 4.6：voice 引擎/通话 IPC（4.9.8 S7 由 register.ts 改名）
import { initMcpManager, registerMcpHandlers, shutdownMcp } from "./tools/mcp-manager";
import { registerMediaHandlers } from "./media/register"; // 2.7b/c/d：影像线
import { registerMemoryHandlers } from "./memory/long-term-store"; // 5.1.2：长期记忆 + 人设（独立文件）
import { registerWeatherHandlers } from "./weather/open-meteo"; // 6.6.4：在线天气（Open-Meteo 取数，不含状态）
// 5.1.5：睡前整理（抽取器 + 触发接线在独立文件；这里只组装依赖并接上 5 个触发点）
import {
  maybeTidy, registerTidyHandlers, renderConversation, startTidyScheduler, stopTidyScheduler,
  type TidyDeps,
} from "./memory/tidy-runner";
import { registerRelationshipHandlers } from "./relationship/relationship-store"; // 5.6.1：好感度（state.json + log.jsonl，独立文件）
import { registerStoryHandlers } from "./story/story-store"; // 5.7.2：剧情存档 + 触发判定
import { registerStoryGenerateHandler } from "./story/story-generator"; // 5.7.3.2：剧情生成（三档结构化输出 → 落分支）
import { getPendingRecordSourceId } from "./media/record";
import { stopLive } from "./media/live"; // 2.7d：退出时杀 FFmpeg 推流子进程
import type { ApprovalRequest, ToolCallEvent } from "../shared/tool-call";
import { createWindowLifecycleTracker } from "./electron-window-lifecycle";
import { createOrbWindow } from "./orb/floating-window"; // 5.9.1：悬浮球独立窗（几何全在 main/orb/*，这里只注入路径与回调）
import { createCallWindowController, type CallWindowController } from "./voice/call-window"; // 语音通话独立窗（微信式）
// 8.8：外部消息通道（IM）—— registry 本体 electron-free（可单测），依赖在这里组装注入
import { ImRegistry, registerImHandlers, type ImRegistryDeps } from "./im/registry";
import { EchoChannel } from "./im/channels/echo";
// 8.9：两个真实通道。构造入参是**凭证读取器**（调用时求值）—— 凭证落在 config.im.channels[i].config，
// 由 registry 写、由这里按 id 读回；绝不在构造时缓存（改完凭证要能生效）
import { DingTalkChannel, DINGTALK_ID } from "./im/channels/dingtalk";
import { FeishuChannel, FEISHU_ID } from "./im/channels/feishu";
// 8.10：微信（腾讯官方 iLink 协议）—— 适配器 += 扫码登录会话（取码 / 轮询 / 落凭证三条 IPC）
import { WEIXIN_ID, WeixinChannel, createWeixinContextFileStore } from "./im/channels/weixin";
import { createWeixinLogin, registerWeixinLoginHandlers } from "./im/weixin-login";
// 8.7：技能系统（唯一扩展载体）—— registry 本体 electron-free（可单测），目录 / 启用读写在这里注入
import { SkillRegistry, registerSkillHandlers, setSkillRegistry } from "./skills/skill-registry";
import { registerSkillTool } from "./skills/skill-tool";
// 8.7.3（方案 B）：技能目录作为 run_shell 的 cwd 窄例外
import { setShellCwdAllowance } from "./tools/shell-tool";
// 8.7.7：工具箱 · 工具独立子窗口（主进程建/聚焦）
import { registerToolboxHandlers } from "./toolbox/tool-window";
import { registerRenameHandlers } from "./toolbox/rename"; // 8.7.10：批量重命名
import { registerClipboardHandlers } from "./toolbox/clipboard"; // 8.7.17：剪切板历史
import { registerPdfToolHandlers } from "./toolbox/pdf-tool"; // 8.7.18：PDF 合并/拆分
import { registerRssHandlers } from "./toolbox/rss"; // 8.7.19：RSS 阅读器
import { registerTranscodeHandlers } from "./toolbox/transcode"; // 8.7.20：音视频转换
// 9.x：音乐（网易云）—— 服务引导 + 路径解析（vendor MCP 后端 / runtime / 账号文件）
import { bootstrapMusicService, type MusicBootstrap } from "./music/bootstrap";
import { resolveMusicPaths } from "./music/paths";

/** dev 模式由 npm run dev 注入（concurrently 启动 vite + electron） */
const isDev = process.env.VITE_DEV === "1";

// 编译产物布局（与 tsconfig.main/preload 的 rootDir=src、outDir=dist/* 对应）：
//   __dirname = dist/main/main
//   ../../preload/preload/index.js
//   ../../renderer/index.html
const DIST_ROOT = path.join(__dirname, "..", "..");
const PRELOAD_PATH = path.join(DIST_ROOT, "preload", "preload", "index.js");
const RENDERER_HTML_PATH = path.join(DIST_ROOT, "renderer", "index.html");
const ORB_HTML_PATH = path.join(DIST_ROOT, "renderer", "orb", "index.html"); // 5.9.1：悬浮球页面（vite input orb）
const TOOL_WINDOW_HTML_PATH = path.join(DIST_ROOT, "renderer", "tool-window", "index.html"); // 8.7.7：工具箱工具子窗（vite input toolWindow）
const CALL_WINDOW_HTML_PATH = path.join(DIST_ROOT, "renderer", "call-window", "index.html"); // 语音通话独立窗（vite input callWindow，漏了 = 打包后 404 白屏）
const DEV_SERVER_URL = "http://localhost:5173";

// 窗口尺寸 v2：1440×900（玻璃拟态需留背景呼吸空间，右栏 320px）；最小 1180×720
const MAIN_WINDOW_WIDTH = 1440;
const MAIN_WINDOW_HEIGHT = 900;
const MAIN_WINDOW_MIN_WIDTH = 1180;
const MAIN_WINDOW_MIN_HEIGHT = 720;

const mainWindowLifecycle = createWindowLifecycleTracker<BrowserWindow>("main");

function createWindow(): void {
  const win = new BrowserWindow({
    width: MAIN_WINDOW_WIDTH,
    height: MAIN_WINDOW_HEIGHT,
    minWidth: MAIN_WINDOW_MIN_WIDTH,
    minHeight: MAIN_WINDOW_MIN_HEIGHT,
    // v2 玻璃拟态：无边框自绘标题栏（顶部栏 drag + 三按钮 IPC）。
    // Windows 上 frame:false 就是直角，不上 transparent:true（缩放错位 + 性能问题）
    frame: false,
    backgroundColor: "#eefaf4", // 对齐 --bg-page 中段，避免启动白屏闪烁
    show: false,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindowLifecycle.attach(win);

  // 9.29：关于页「联系与反馈」开源仓库外链 —— 一律丢系统浏览器，不在 app 内弹新窗
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  // 最大化状态变化回推：renderer 收到后切换 #win-max 的图标 / title
  win.on("maximize", () => win.webContents.send(IPC.WINDOW_MAXIMIZE_CHANGED, true));
  win.on("unmaximize", () => win.webContents.send(IPC.WINDOW_MAXIMIZE_CHANGED, false));

  win.once("ready-to-show", () => win.show());

  if (isDev) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadFile(RENDERER_HTML_PATH);
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.APP_GET_VERSION, () => app.getVersion());
  ipcMain.handle(IPC.APP_PING, (_event, stamp: string) => `pong:${stamp}`);

  ipcMain.on(IPC.WINDOW_MINIMIZE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  // 最大化切换：已最大化则还原（标题栏按钮 / 双击标题栏共用）
  ipcMain.on(IPC.WINDOW_MAXIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  // 最大化状态查询（win-max 按钮初始图标用）
  ipcMain.handle(IPC.WINDOW_IS_MAXIMIZED, (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false;
  });

  ipcMain.on(IPC.WINDOW_CLOSE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.on(IPC.APP_QUIT, () => {
    app.quit();
  });

  registerConfigHandlers();
  registerChatHandlers();
  registerChatsHandlers();
  registerProviderHandlers();
  // 顺序有意义（4.1 §3.9）：先把内置工具注册进注册表，再注册读它的 IPC
  registerBuiltinTools();
  // 8.12：应用持久化的停用清单 —— 必须插在注册表有工具之后（否则 setEnabled 查无此工具）、
  // 权限 IPC 之前（渲染层 tools:list 第一次读就是应用后的现状）
  for (const id of loadConfig().permissions.disabledTools) toolRegistry.setEnabled(id, false);
  registerToolPermissionHandlers();
  registerToolApprovalHandlers(); // 4.1.1：审批回传通道
  registerAuditHandlers(); // 8.4：审计查看 / 打开审计目录
  registerFsHandlers(); // 8.2：fs:pick-dir（allowedDirs 的「添加目录」，只弹框不落盘）

  // 4.6：语音线 —— 先注册引擎（**注入** stored 读取器），再注册读它的 IPC。
  // 注入的这一行就是 4.4/4.5/4.5.1 三个 D 决策里「4.6 接真读取器」的落点
  // 4.9.8 S2：sherpa 相对模型路径的基准目录 —— 打包后 cwd 不保证是 app 根，由这里算好注入
  const voiceBaseDir = app.isPackaged ? process.resourcesPath : app.getAppPath();
  registerBuiltinVoiceEngines((id) => loadConfig().voice.engines[id] ?? {}, voiceBaseDir);
  registerVoiceHandlers(); // 4.6：voice:list-engines + voice:pick-path

  registerMcpHandlers(); // 4.2：MCP 服务器生命周期 5 条通道
  registerMediaHandlers(); // 2.7b/c/d：截图 / 录屏 / 直播
  registerMemoryHandlers(); // 5.1.2：长期记忆 + 人设（独立文件读写，不进 config.json）
  registerTidyHandlers(tidyDeps); // 5.1.5：睡前整理 —— 立即整理 / 状态 / 回滚 3 条通道
  registerRelationshipHandlers(); // 5.6.1：好感度（真相在主进程独立文件，渲染层只拿投影）
  registerStoryHandlers(); // 5.7.2：剧情存档 + 触发判定
  registerStoryGenerateHandler(); // 5.7.3.2：剧情生成（单独挂 —— 塞进 registerStoryHandlers 会形成 import 环）
  registerWeatherHandlers(); // 6.6.4：weather:fetch-online（主进程只取数，状态归渲染层 patch）
  registerImHandlers(imRegistry); // 8.8/8.9：im:list-channels / set-enabled / set-config / test-connection / inject
  registerWeixinLoginHandlers(weixinLogin); // 8.10：im:weixin-qr-start / -poll / -cancel（扫码登录三条）
  // 8.7：技能系统 —— 先注册 skill(id) 工具（进工具注册表 / 授权面板），再注册设置页 4 条 IPC，最后扫一次目录
  registerSkillTool(skillRegistry);
  registerSkillHandlers(skillRegistry);
  skillRegistry.refresh(); // 启动即扫（首次会播种内置示例技能）：重启 = 重扫（指令 §1.2）
}

/**
 * 3.7：预设投影 + 连接测试。
 * 预设不让渲染进程直接 import（shared 虽可见，但 transport/authStyle 这类协议细节
 * 不该漏到界面层）—— 在这里投影成 PresetSummary 的 7 个字段经 IPC 给出去。
 */
function registerProviderHandlers(): void {
  ipcMain.handle(IPC.PROVIDER_LIST_PRESETS, (): PresetSummary[] =>
    PROVIDER_PRESETS.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      baseUrl: p.baseUrl,
      defaultModel: p.defaultModel,
      apiKeyRequired: p.apiKeyRequired,
      baseUrlRequired: p.baseUrlRequired, // 5.1.1（P17 收口）：补投影，渲染层据此禁用「测试连接」+ 必填错误
      supportsStreaming: getCapabilityOrOpenAI(p.id).supportsStreaming,
    })),
  );
  // override = 设置页当前表单值（可能是未保存的草稿），草稿合并在 test-connection 内部做
  ipcMain.handle(IPC.PROVIDER_TEST, (_event, override?: Partial<AppConfig["model"]>) =>
    testConnection(override),
  );
  // 8.1：视觉模型连接测试（带最小图，链路独立于聊天模型）
  ipcMain.handle(IPC.VISION_TEST, (_event, override?: Partial<AppConfig["vision"]>) =>
    testVisionConnection(override),
  );
}

/** 每个窗口同一时刻只保留一个进行中的对话流，重复发起会先中止上一个 */
const activeChats = new Map<number, AbortController>();

/** B：悬浮球窗引用（whenReady 里 createOrbWindow 的返回值）。sender 判定 / 重活转发用 */
let orbWindow: BrowserWindow | null = null;

// 9.x：音乐服务单例（whenReady 里 bootstrap）。MCP 后端是 Python 子进程，
// start() 失败只广播 backend="failed" 不抛出 —— UI 按 get-status 快照自行降级
let musicBootstrap: MusicBootstrap | null = null;
/** 本轮已发出的工具调用 callId（key = 发起 sender.id）：中止时精准作废被路由到主窗口的
 *  未决审批卡 —— rejectAllApprovals 按「收到审批的窗口」键控，悬浮球中止时直接调它杀不到自己的卡 */
const runApprovalCallIds = new Map<number, Set<string>>();

function send(sender: WebContents, channel: string, payload?: unknown): void {
  if (!sender.isDestroyed()) sender.send(channel, payload);
}

// ==================== 5.1.5：睡前整理的运行时依赖（外部能力全在这里注入） ====================
// 触发接线与编排在 memory/tidy-runner.ts（可在 vitest 里直接单测）；这里只组装生产依赖，
// 并在下面五个位置接上触发点：registerIpcHandlers / whenReady / handleChatStart / before-quit。

/** 抽取用的一次性对话：runChat 的薄包装，**不传审批通道**（不启用工具 → tools = []，抽取不许走工具循环），
 *  也不注入人设（8.12 noPersona —— 结构化抽取不吃人设，免得拉低抽取稳定性） */
async function chatOnce(messages: ChatMessage[]): Promise<string> {
  let text = "";
  await runChat({ messages, noPersona: true, onDelta: (t) => { text += t; } });
  return text;
}

const tidyDeps: TidyDeps = {
  // dir / memoryTidy 都是「调用时求值」：注册时求一次 = 与打包 / 多实例时机错位（5.1.3 同款）
  dir: () => app.getPath("userData"),
  chat: chatOnce,
  // 对话来源每次调用都重读（不许在注册时缓存会话对象）：最近一条会话的正文
  conversation: (since) => {
    const latest = listSessions()[0];
    return latest === undefined ? "" : renderConversation(getSession(latest.id), since);
  },
  memoryTidy: () => {
    const v: string | number | boolean | undefined = loadConfig().ui?.memoryTidy;
    return typeof v === "string" ? v : ""; // 非字符串（脏值）当「未识别」交给 shouldTidy 判定
  },
  now: () => Date.now(),
};

// ==================== 8.8：外部消息通道的运行时依赖（能力全在这里注入） ====================
// registry 只管路由 / 启停 / 落盘，不 import electron、不 import chats-store —— 于是能直接被 vitest 驱动。

/** 8.9：按通道 id 读回落盘的凭证（读的是 config-store 里已解密的明文，只在主进程内存中流转） */
function imChannelCreds(id: string): Record<string, string> {
  return loadConfig().im.channels.find((c) => c.id === id)?.config ?? {};
}

const imDeps: ImRegistryDeps = {
  adapters: [
    new EchoChannel(),
    // 8.9 真实通道：凭证读取器「调用时求值」—— registry 写完盘后重启连接即可拿到新凭证
    new FeishuChannel(() => imChannelCreds(FEISHU_ID)),
    new DingTalkChannel(() => imChannelCreds(DINGTALK_ID)),
    // 8.10 微信：context_token 是「同一 target 的会话状态」，单独落 userData/weixin/context.json
    // （绝不塞 config.json —— 那里有掩码比对与消毒，状态类数据会被搅乱）；路径同样「调用时求值」
    new WeixinChannel(() => imChannelCreds(WEIXIN_ID), {
      contextStore: createWeixinContextFileStore(() => path.join(app.getPath("userData"), "weixin", "context.json")),
    }),
  ],
  sessions: { create: createSession, get: getSession, append: appendMessage, delete: deleteSession },
  config: {
    // 读写都「调用时求值」：注册时读一次会与打包 / 多实例时机错位（同 5.1.3 / tidyDeps 口径）
    readChannels: () => loadConfig().im.channels,
    writeChannels: (channels) => { saveConfig({ im: { channels } }); },
  },
  // 外部通道的一轮对话：**不传 approve**（不启用本地工具，安全默认）+ 不传 expressionHint（不是用户对话界面）；
  // 来源标记前缀由 runChat 依 opts.imSource 注入（与好感度 / 心情 / 表情并列，各自独立一条 system）
  chat: async (messages, source) => {
    let text = "";
    await runChat({ messages, imSource: source, onDelta: (t) => { text += t; } });
    return text;
  },
};

const imRegistry = new ImRegistry(imDeps);

// 8.10：微信扫码登录会话（进程内单例）。凭证写入复用 registry.setChannelConfig ——
// 白名单消毒 / enc: 落盘 / 「运行中就重启连接」全都自动生效，这里不自己碰 store。
const weixinLogin = createWeixinLogin({
  saveCreds: (creds) => { void imRegistry.setChannelConfig(WEIXIN_ID, creds); },
  // 白名单自动放行：confirmed 时若白名单为空，把本次扫码的 userId 填进去（已有白名单不动）。
  // sourceAllow 非密钥 → configMasked 里就是明文，读视图投影即可，不用给 registry 加新口子
  currentAllow: () =>
    imRegistry.listViews().find((v) => v.id === WEIXIN_ID)?.configMasked.sourceAllow ?? "",
});

// 8.7：技能注册表（技能目录 = userData/skills；启用开关落 config.ui 的 skill.<id>.enabled）。
// 三个依赖都「调用时求值」—— 构造发生在 ready 之前，那时 app.getPath 还不可用（同 5.1.3 / imDeps 口径）
const skillRegistry = new SkillRegistry({
  rootDir: () => path.join(app.getPath("userData"), "skills"),
  readEnabled: (id) => {
    const v = loadConfig().ui[`skill.${id}.enabled`];
    return typeof v === "boolean" ? v : undefined; // 没设置过 = undefined → 用 frontmatter 默认
  },
  writeEnabled: (id, enabled) => { saveConfig({ ui: { [`skill.${id}.enabled`]: enabled } }); },
});
setSkillRegistry(skillRegistry); // chat.ts 的 catalog 注入只读这个单例

// 8.7.3（方案 B，用户拍板）：把技能目录开成 run_shell 的 **cwd 窄例外** —— 技能脚本按
// 「cwd = 技能目录 + args 里相对脚本路径」跑（skill-tool 正文就是这么指引的）。
// 只放宽 8.4「AppData 不在允许目录内」这一条（path-guard.verdictFor）；盘根 / 系统目录 /
// 凭据文件名照旧硬拒，且 run_shell 的审批 / 黑名单 / 审计一分不减。
setShellCwdAllowance(() => [path.join(app.getPath("userData"), "skills")]);

/** B：拉起主窗口并返回其 webContents（悬浮球发起的审批卡要落在主窗口）。窗口没开就新建
 *  并等 did-finish-load —— 渲染端在脚本顶层才订阅审批通道，提前 send 会丢卡（还会被
 *  approval.ts 的 did-start-navigation 兜底立即判拒绝，等于永远没人能点允许）。 */
async function raiseMainWindowWebContents(): Promise<WebContents | null> {
  let w = mainWindowLifecycle.getWindow();
  if (!w) {
    createWindow();
    w = mainWindowLifecycle.getWindow();
  } else {
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  }
  if (!w || w.webContents.isDestroyed()) return null;
  if (w.webContents.isLoading()) {
    await new Promise<void>((resolve) => w.webContents.once("did-finish-load", () => resolve()));
  }
  return w.webContents.isDestroyed() ? null : w.webContents;
}

async function handleChatStart(sender: WebContents, request: ChatRequest): Promise<void> {
  const controller = new AbortController();
  activeChats.get(sender.id)?.abort();
  activeChats.set(sender.id, controller);

  // B：悬浮球发起的一轮 —— 卡片只落主窗口，悬浮球只收文字（外加一行工具提示）
  const isOrb = orbWindow !== null && !orbWindow.isDestroyed() && sender.id === orbWindow.webContents.id;
  const runCallIds = new Set<string>();
  runApprovalCallIds.set(sender.id, runCallIds);

  try {
    // 7.4：模式门控（唯一一个门）—— 只有渲染层显式传 "work" 才给审批通道。
    // runChat 的工具启用条件之一是 opts.approve：聊天态不传 → tools=[] → 走无工具原路径，
    // 模型不拿到 tools、不产出工具调用，TOOL_CALL 事件也不发（渲染层审批卡天然不出现）
    // 9.x：lite = 悬浮球轻量档 —— 工具启用与 work 同路（approve / 事件 / 审计照旧），
    //      但白名单只放行联网三件套，shell / fs / 键鼠 / 视觉一概不进模型视野
    const toolsAllowed = request?.mode === "work" || request?.mode === "lite";
    const toolFilter = request?.mode === "lite" ? ["web_search", "fetch_url", "deep_search"] : undefined;
    const result = await runChat({
      // request.model 映射到 modelOverride（不是 model）—— 语义是「覆盖」，不是「唯一来源」
      modelOverride: request?.model,
      toolFilter,
      messages: request?.messages ?? [],
      // 6.3：心情快照透传（语音/抽取等内部 runChat 调用不传 → 自然不注入）
      mood: request?.mood,
      // 7.7：表情标签声明只进用户对话界面（语音 / 抽取路径不传 → 不注入）
      expressionHint: true,
      signal: controller.signal,
      onDelta: (text) => send(sender, IPC.CHAT_DELTA, text),
      // 4.1.1：工具事件转发 + 审批询问（给了 approve 才会启用工具；7.4 起受模式门控）
      // B：悬浮球发起的轮次，主窗口也收一份卡片（每次事件现取窗口引用，窗口中途建起来也能跟上）；
      // 悬浮球自己同收一份只为渲染一行提示（其渲染端不建卡）。主窗口没开 → 自然丢（send 有守卫）
      onToolCall: toolsAllowed
        ? (evt: ToolCallEvent) => {
            if (evt.phase === "start") runCallIds.add(evt.callId);
            if (isOrb) {
              const main = mainWindowLifecycle.getWindow();
              if (main) send(main.webContents, IPC.TOOL_CALL, evt);
            }
            send(sender, IPC.TOOL_CALL, evt);
          }
        : undefined,
      // 7.4 + B：审批卡永远落在主窗口 —— 悬浮球发起的轮次先拉起主窗口（没开就新建并等加载完），
      // 审批定向主窗口 webContents；执行结果照常以文字流回悬浮球
      approve: toolsAllowed
        ? async (req: ApprovalRequest) => {
            if (isOrb) await raiseMainWindowWebContents();
            const target = isOrb ? mainWindowLifecycle.getWindow()?.webContents : sender;
            return target ? requestApproval(target, req) : false;
          }
        : undefined,
      // 8.4：审计落盘（append 到 userData/audit/audit-YYYYMM.jsonl）。独立 sink ——
      // 与 approve / onToolCall 无关；没工具调用时自然不会有记录进来
      onAudit: (entry) => appendAudit(app.getPath("userData"), entry),
    });
    // 验证要靠它：日志里能看出这次真的走了哪套协议、有没有降级、调了几次工具
    console.log(
      `[nahida] chat done provider=${result.providerId} model=${result.model} transport=${result.transport} streamed=${result.streamed}` +
        ` tools=${result.toolCalls} rounds=${result.toolRounds}` +
        (result.degraded.length ? ` degraded=${result.degraded.join(" / ")}` : ""),
    );
    send(sender, IPC.CHAT_DONE);
  } catch (err) {
    if (controller.signal.aborted) {
      // 用户点"停止"：不算错误，按正常结束处理
      send(sender, IPC.CHAT_DONE);
    } else {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[nahida] chat failed:", message);
      send(sender, IPC.CHAT_ERROR, message);
    }
  } finally {
    if (activeChats.get(sender.id) === controller) activeChats.delete(sender.id);
    runApprovalCallIds.delete(sender.id);
    // 5.1.5：一轮对话结束后顺带问一次睡前整理（内部自判触发 / 自 catch；**绝不 await**，不许打断对话）
    void maybeTidy(tidyDeps);
  }
}

function registerChatHandlers(): void {
  ipcMain.handle(IPC.CHAT_LIST_MODELS, () => listModelsForProvider());

  // 立即返回，真正的流式结果通过 CHAT_DELTA / CHAT_DONE / CHAT_ERROR 回推
  ipcMain.handle(IPC.CHAT_START, (event, request: ChatRequest) => {
    void handleChatStart(event.sender, request);
  });

  ipcMain.on(IPC.CHAT_ABORT, (event) => {
    activeChats.get(event.sender.id)?.abort();
    rejectAllApprovals(event.sender.id);
    // B：悬浮球发起的审批卡挂在主窗口（pending 按收到审批的窗口键控），上面那句杀不到 ——
    // 按本轮 callId 精准作废，不误伤主窗口自己那轮的未决审批
    for (const callId of runApprovalCallIds.get(event.sender.id) ?? []) resolveApproval(callId, false);
    runApprovalCallIds.delete(event.sender.id);
  });
}

app.whenReady().then(() => {
  // ===== 2.7b/c/d 底座（指令 §2.6）：权限与 display-media 裁决，必须在任何窗口创建前 =====
  // 2.7c 前置：麦克风 / 屏幕采集权限。
  // 不设这个 handler，getUserMedia 会被静默拒绝，表现成「没声音」而不是报错。
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    const allow = ["media", "display-capture", "clipboard-sanitized-write", "clipboard-read"];
    callback(allow.includes(permission));
  });

  // 2.7c 前置：getDisplayMedia 的来源裁决。
  // 不用 { useSystemPicker: true } —— 系统选择器一开，这个 handler 就不被调用，
  // 我们面板里选的「采集源」就失效了。
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    void (async () => {
      try {
        const { desktopCapturer } = await import("electron");
        const want = getPendingRecordSourceId(); // 来自 media/record.ts
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
        const video = sources.find((s) => s.id === want) ?? sources[0];
        // audio: "loopback" = 系统声音（Windows 原生支持，不需要虚拟声卡）
        callback(video ? { video, audio: "loopback" } : {});
      } catch {
        callback({});
      }
    })();
  });

  registerIpcHandlers();
  // 8.7.7：工具箱工具子窗口（路径 / devURL 注入同悬浮球口径；同 id 复用一个窗口）
  registerToolboxHandlers({
    preloadPath: PRELOAD_PATH,
    htmlPath: TOOL_WINDOW_HTML_PATH,
    devServerUrl: DEV_SERVER_URL,
    isDev,
  });
  registerRenameHandlers(); // 8.7.10：批量重命名（rename:list / rename:run）
  registerClipboardHandlers(); // 8.7.17：剪切板历史
  registerPdfToolHandlers(); // 8.7.18：PDF 合并/拆分
  registerRssHandlers(); // 8.7.19：RSS 阅读器
  registerTranscodeHandlers(); // 8.7.20：音视频转换
  createWindow();

  // 语音通话独立窗控制器（微信式）：onStartCall / 头像转发都要用，先于悬浮球创建。
  // getOrbWindow 读模块级 orbWindow（闭包延迟求值，此刻还没赋值也没关系）
  const callWindowCtl: CallWindowController = createCallWindowController({
    preloadPath: PRELOAD_PATH,
    htmlPath: CALL_WINDOW_HTML_PATH,
    devServerUrl: DEV_SERVER_URL,
    isDev,
    getOrbWindow: () => orbWindow,
  });

  // 5.9.1：悬浮球独立窗 —— 路径 / devURL 全在这里注入（main/orb/* 不许自己算层级）。
  // 球窗常驻：关掉主窗口它还在，window-all-closed 因此不会被触发，只有菜单「退出」才 app.quit()。
  // B：引用存模块级 orbWindow —— handleChatStart 据此判定悬浮球 sender（卡片过滤 / 审批转发）
  orbWindow = createOrbWindow({
    preloadPath: PRELOAD_PATH,
    htmlPath: ORB_HTML_PATH,
    devServerUrl: DEV_SERVER_URL,
    isDev,
    onOpenMain: () => {
      const w = mainWindowLifecycle.getWindow();
      if (w) {
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
      } else {
        createWindow();
      }
    },
    onStartCall: () => { callWindowCtl.open(); },
    // 通话窗头像跟随悬浮球：换头像 / 恢复默认时广播一份给通话窗
    onAvatarChange: (dataUrl) => { callWindowCtl.forwardAvatar(dataUrl); },
    onQuit: () => app.quit(),
    // 浅合并由 saveConfig 的 mergeDeep 保证：只带要改的键，别三键同写
    persist: (patch) => { saveConfig({ ui: patch }); },
    // 没存过 → NaN，由 floating-window.ts 用默认落点兜底
    readOrigin: () => {
      const ui = loadConfig().ui;
      return { x: Number(ui["orb.x"]), y: Number(ui["orb.y"]) };
    },
    // 5.9.2：停靠边（"" = 未停靠）—— 启动恢复细条用；sanitizeUi 是类型白名单，字符串直接过
    readDock: () => String(loadConfig().ui["orb.dock"] ?? ""),
    readAvatarPath: () => {
      const v = loadConfig().ui["orb.avatarPath"];
      return typeof v === "string" ? v : "";
    },
  });

  // 4.2（D8）：启动连接 fire-and-forget —— 绝不 await，失败只记日志，不能拖慢窗口出现
  void initMcpManager();

  // 9.x：音乐服务引导（fire-and-forget，同 MCP 口径）—— 建 MusicService + 挂 music:* IPC +
  // 起 Python MCP 后端；bootstrap 内部 start() 自带 catch，失败经 backendState 传达给 UI
  musicBootstrap = bootstrapMusicService(resolveMusicPaths());

  // 5.1.5：睡前整理 —— 启动补跑一次（覆盖「应用没开着时错过 22:00」）+ 每半小时问一次；
  // 内部全是 fire-and-forget（自判触发 / 自 catch），不拖慢启动
  startTidyScheduler(tidyDeps);

  // 8.8：按落盘 enabled 拉起 IM 通道（fire-and-forget，失败只落到 state，不拖慢启动）
  void imRegistry.startEnabled();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// MCP 的 stdio 服务器是子进程：异步清理必须拦一次 quit，否则进程先退、清理没跑完，留下孤儿子进程
let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return; // 第二次进来（清理完自己调的 quit）不再拦
  quitting = true;
  event.preventDefault();
  stopTidyScheduler(); // 5.1.5：清掉睡前整理的低频 tick（进程要退了，别留定时器）
  // FFmpeg 推流也是子进程：关窗时不杀会变孤儿继续推流（2.7d §5.5 第 13 条）
  // 9.x：音乐 MCP 后端同为 Python 子进程，一并纳入关停清单（杀进程树 + 清 runtime 目录）
  void Promise.all([shutdownMcp(), stopLive(), imRegistry.stopAll(), musicBootstrap?.shutdown() ?? Promise.resolve()])
    .finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
