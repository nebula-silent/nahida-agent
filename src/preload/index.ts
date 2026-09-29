// 参考自 Cyrene-Agent src/preload/index.ts
// 已精简：只暴露骨架窗口需要的 API；contextIsolation 开启时统一通过 contextBridge 暴露
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC } from "../shared/ipc-channels";
import type { ChatMessage, ChatRequest, ChatSearchResult, ChatSession, ChatSessionMeta } from "../shared/chat";
import type { AppConfig, ImChannelView, WeixinQrPollView, WeixinQrStartView } from "../shared/config";
import type { DeepPartial } from "../shared/types";
import type { PresetSummary, TestConnectionResult } from "../shared/provider/types";
import type { PermissionSnapshot, ToolAccessLevel, ToolSummary } from "../shared/tools";
import type { AuditView } from "../shared/audit";
import type { ApprovalRequest, ToolCallEvent } from "../shared/tool-call";
import type { VoiceEngineSummary, VoicePathPickRequest } from "../shared/voice/types";
import type { CallAsrEvent, CallStartRequest, CallStartResult, CallStateEvent, CallTranscribeResult, CallTtsEvent } from "../shared/voice/call";
import type { McpMutationResult, McpServerInput, McpServerView } from "../shared/mcp";
import type { LongTermMemory, TidyReportView, TidyStatusView, UserProfileView } from "../shared/memory";
import type { RelationshipPatch, RelationshipView } from "../shared/relationship";
import type { Chapter, StoryContextExtras, StoryGenerateRequest, StoryGenerateResult, StorySave } from "../shared/story";
import type {
  AreaSelection, AudioDeviceView, CaptureLibrary, CaptureRequest, CaptureShot,
  CaptureSourceView, FfmpegStatus, LiveEvent, LiveResult, LiveStartRequest,
  RecordClip, RecordSaveRequest,
} from "../shared/media";
import type { OrbExpandState, OrbView } from "../shared/orb";
import type { SkillSummary } from "../shared/skill";
import type { ToolboxOpenPayload } from "../shared/toolbox";
import type { DirEntry, RenameOutcome, RenameRunPayload } from "../shared/rename"; // 8.7.10
import type { ClipMutationResult, ClipPinPayload, ClipRecord } from "../shared/clip"; // 8.7.17
import type { PdfJobResult, PdfSplitPayload } from "../shared/pdf-tool"; // 8.7.18
import type { RssAddResult, RssFeed, RssFeedResult } from "../shared/rss"; // 8.7.19
import type { FfmpegStatus as TranscodeFfmpegStatus, TranscodeResult, TranscodeStartPayload } from "../shared/transcode"; // 8.7.20
import type { MusicIpcEnvelope, MusicPlaybackView } from "../shared/music-types";
import type { MusicStatusSnapshot } from "../shared/music-view-state";
import type { MusicCardData } from "../shared/music-card";

/** 订阅主进程推送，返回取消订阅函数 */
function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/** 8.7.21：外观视觉项广播载荷（只带变化的键） */
interface UiVisualPatch {
  theme?: string;
  accent?: string;
  bgType?: string;
  bgImage?: string;
}

const nahidaApi = {
  minimize: () => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
  maximize: () => ipcRenderer.send(IPC.WINDOW_MAXIMIZE),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke(IPC.WINDOW_IS_MAXIMIZED),
  onMaximizeChange: (callback: (maximized: boolean) => void): (() => void) =>
    subscribe<boolean>(IPC.WINDOW_MAXIMIZE_CHANGED, callback),
  close: () => ipcRenderer.send(IPC.WINDOW_CLOSE),
  quit: () => ipcRenderer.send(IPC.APP_QUIT),
  getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.APP_GET_VERSION),
  ping: (stamp: string): Promise<string> => ipcRenderer.invoke(IPC.APP_PING, stamp),
  /** 运行时版本信息（渲染进程无法直接读 process，需由 preload 透出） */
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },

  /** 本地 Ollama 对话（一轮对话同一时刻只允许一个流） */
  chat: {
    listModels: (): Promise<string[]> => ipcRenderer.invoke(IPC.CHAT_LIST_MODELS),
    start: (request: ChatRequest): Promise<void> => ipcRenderer.invoke(IPC.CHAT_START, request),
    abort: (): void => {
      ipcRenderer.send(IPC.CHAT_ABORT);
    },
    onDelta: (callback: (text: string) => void): (() => void) =>
      subscribe<string>(IPC.CHAT_DELTA, callback),
    onDone: (callback: () => void): (() => void) => subscribe<undefined>(IPC.CHAT_DONE, callback),
    onError: (callback: (message: string) => void): (() => void) =>
      subscribe<string>(IPC.CHAT_ERROR, callback),
    /** 4.1.1：工具生命周期事件（start / done），渲染进程据此画卡片 */
    onToolCall: (callback: (evt: ToolCallEvent) => void): (() => void) =>
      subscribe<ToolCallEvent>(IPC.TOOL_CALL, callback),
  },

  /** 应用配置：渲染进程只拿掩码，敏感字段明文永远不出主进程 */
  config: {
    get: (): Promise<AppConfig> => ipcRenderer.invoke(IPC.CONFIG_GET),
    set: (patch: DeepPartial<AppConfig>): Promise<AppConfig> =>
      ipcRenderer.invoke(IPC.CONFIG_SET, patch),
  },

  /** 8.7.21：外观视觉项广播（主题/强调色/背景样式变更 → 独立子窗实时跟随） */
  ui: {
    onThemeChanged: (callback: (patch: UiVisualPatch) => void): (() => void) =>
      subscribe<UiVisualPatch>(IPC.UI_THEME_CHANGED, callback),
    /** 8.7.22：背景图文件选择（背景样式=自定义图片）；取消返回 "" */
    pickBgImage: (): Promise<string> => ipcRenderer.invoke(IPC.UI_PICK_BG_IMAGE),
  },

  /** 模型配置（3.7）：预设投影 + 连接测试（表单值当 override，草稿合并在主进程做） */
  provider: {
    listPresets: (): Promise<PresetSummary[]> => ipcRenderer.invoke(IPC.PROVIDER_LIST_PRESETS),
    test: (override?: Partial<AppConfig["model"]>): Promise<TestConnectionResult> =>
      ipcRenderer.invoke(IPC.PROVIDER_TEST, override),
  },

  /** 视觉旁路（8.1）：视觉模型连接测试（独立于聊天模型；配置读写仍走 config:*） */
  vision: {
    test: (override?: Partial<AppConfig["vision"]>): Promise<TestConnectionResult> =>
      ipcRenderer.invoke(IPC.VISION_TEST, override),
  },

  /** 对话存储：多会话结构（当前 UI 只用最近一条，其余为 4.9 / 5.7 预留） */
  chats: {
    list: (): Promise<ChatSessionMeta[]> => ipcRenderer.invoke(IPC.CHATS_LIST),
    create: (initialMessages?: ChatMessage[]): Promise<ChatSession> =>
      ipcRenderer.invoke(IPC.CHATS_CREATE, initialMessages),
    get: (id: string): Promise<ChatSession | null> => ipcRenderer.invoke(IPC.CHATS_GET, id),
    append: (id: string, message: ChatMessage, parentId?: string, branchId?: string): Promise<ChatSession | null> =>
      ipcRenderer.invoke(IPC.CHATS_APPEND, id, message, parentId, branchId),
    setActive: (id: string, nodeId: string): Promise<ChatSession | null> =>
      ipcRenderer.invoke(IPC.CHATS_SET_ACTIVE, id, nodeId),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.CHATS_DELETE, id),
    rename: (id: string, title: string): Promise<ChatSession | null> =>
      ipcRenderer.invoke(IPC.CHATS_RENAME, id, title),
    search: (query: string, limit?: number): Promise<ChatSearchResult> =>
      ipcRenderer.invoke(IPC.CHATS_SEARCH, query, limit),
    /** 9.1：设/清对话绑定目录（id 传 null = 会话还没建，只更新主进程内存；dir 空串 = 清除） */
    setWorkDir: (id: string | null, dir: string): Promise<ChatSession | null> =>
      ipcRenderer.invoke(IPC.CHATS_SET_WORK_DIR, id, dir),
  },

  /** 工具注册表（4.1）：只读投影，execute 永远不出主进程；4.1.1 加审批往返 */
  tools: {
    list: (): Promise<ToolSummary[]> => ipcRenderer.invoke(IPC.TOOLS_LIST),
    setEnabled: (id: string, enabled: boolean): Promise<ToolSummary[]> =>
      ipcRenderer.invoke(IPC.TOOLS_SET_ENABLED, id, enabled),
    onApprovalRequest: (callback: (req: ApprovalRequest) => void): (() => void) =>
      subscribe<ApprovalRequest>(IPC.TOOL_APPROVAL_REQUEST, callback),
    respondApproval: (callId: string, allowed: boolean): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(IPC.TOOL_APPROVAL_RESPOND, callId, allowed),
  },

  /** 权限档位（4.1） */
  permission: {
    get: (): Promise<PermissionSnapshot> => ipcRenderer.invoke(IPC.PERMISSION_GET),
    set: (level: ToolAccessLevel): Promise<{ ok: boolean; snapshot: PermissionSnapshot }> =>
      ipcRenderer.invoke(IPC.PERMISSION_SET, level),
  },

  /** 操作审计（8.4）：只读最近记录 + 打开审计目录（路径主进程自解析，渲染层不传路径） */
  audit: {
    list: (): Promise<AuditView> => ipcRenderer.invoke(IPC.AUDIT_LIST),
    openDir: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.AUDIT_OPEN_DIR),
  },

  /** 文件工具（8.2）：allowedDirs 白名单的「添加目录」；只弹框返回路径，取消返回空串（落盘走 config:set） */
  fs: {
    pickDir: (): Promise<string> => ipcRenderer.invoke(IPC.FS_PICK_DIR),
  },

  /** 批量重命名（8.7.10）：列目录条目 / 执行改名（后者由主进程做安全校验，单条失败不中断） */
  rename: {
    listDir: (dir: string): Promise<DirEntry[]> => ipcRenderer.invoke(IPC.RENAME_LIST, dir),
    run: (payload: RenameRunPayload): Promise<RenameOutcome[]> => ipcRenderer.invoke(IPC.RENAME_RUN, payload),
  },

  /** 剪贴板历史（8.7.17）：历史在主进程内存环形维护；copy 写回系统剪贴板并置顶 */
  clip: {
    list: (): Promise<ClipRecord[]> => ipcRenderer.invoke(IPC.CLIP_LIST),
    clear: (): Promise<ClipMutationResult> => ipcRenderer.invoke(IPC.CLIP_CLEAR),
    pin: (payload: ClipPinPayload): Promise<ClipMutationResult> => ipcRenderer.invoke(IPC.CLIP_PIN, payload),
    copy: (text: string): void => { void ipcRenderer.invoke(IPC.CLIP_COPY, text); },
  },

  /** PDF 合并 / 拆分（8.7.18）：文件由主进程 dialog 选定，渲染层只下发页范围 */
  pdfTool: {
    merge: (): Promise<PdfJobResult> => ipcRenderer.invoke(IPC.PDF_MERGE),
    split: (payload: PdfSplitPayload): Promise<PdfJobResult> => ipcRenderer.invoke(IPC.PDF_SPLIT, payload),
  },

  /** RSS 阅读器（8.7.19）：订阅列表主进程持久化，抓取用 rss-parser */
  rss: {
    list: (): Promise<RssFeed[]> => ipcRenderer.invoke(IPC.RSS_LIST),
    add: (url: string): Promise<RssAddResult> => ipcRenderer.invoke(IPC.RSS_ADD, url),
    remove: (id: string): Promise<RssFeed[]> => ipcRenderer.invoke(IPC.RSS_REMOVE, id),
    fetch: (id: string): Promise<RssFeedResult> => ipcRenderer.invoke(IPC.RSS_FETCH, id),
  },

  /** 音视频格式转换（8.7.20）：用项目便携 ffmpeg；缺 ffmpeg 时 start 返回 ffmpegMissing 引导设置 */
  transcode: {
    ffmpegStatus: (): Promise<TranscodeFfmpegStatus> => ipcRenderer.invoke(IPC.TRANSCODE_FFMPEG),
    start: (payload: TranscodeStartPayload): Promise<TranscodeResult> => ipcRenderer.invoke(IPC.TRANSCODE_START, payload),
  },

  /** 语音引擎注册表（4.3）+ 配置（4.6，值读写走 config:*） */
  voice: {
    listEngines: (): Promise<VoiceEngineSummary[]> => ipcRenderer.invoke(IPC.VOICE_LIST_ENGINES),
    /** 4.6：path 字段的「浏览」；取消返回空串（渲染层据此**不清空**已有值） */
    pickPath: (req?: VoicePathPickRequest): Promise<string> => ipcRenderer.invoke(IPC.VOICE_PICK_PATH, req),
  },

  /** 通话（4.9）：状态机在主进程；渲染端只送帧、收事件、回报播放完成 */
  call: {
    start: (req?: CallStartRequest): Promise<CallStartResult> => ipcRenderer.invoke(IPC.CALL_START, req),
    frame: (bytes: ArrayBuffer): void => { ipcRenderer.send(IPC.CALL_FRAME, bytes); },
    playbackDone: (): void => { ipcRenderer.send(IPC.CALL_PLAYBACK_DONE); },
    hangup: (): void => { ipcRenderer.send(IPC.CALL_HANGUP); },
    onState: (cb: (e: CallStateEvent) => void): (() => void) => subscribe<CallStateEvent>(IPC.CALL_STATE, cb),
    onAsr: (cb: (e: CallAsrEvent) => void): (() => void) => subscribe<CallAsrEvent>(IPC.CALL_ASR, cb),
    onTts: (cb: (e: CallTtsEvent) => void): (() => void) => subscribe<CallTtsEvent>(IPC.CALL_TTS, cb),
    onError: (cb: (message: string) => void): (() => void) => subscribe<string>(IPC.CALL_ERROR, cb),
    /** 6.2 语音转文字：整段 PCM 一次性识别（不走通话状态机），失败转 {ok:false,error} 不抛 */
    transcribe: (bytes: ArrayBuffer): Promise<CallTranscribeResult> => ipcRenderer.invoke(IPC.CALL_TRANSCRIBE, bytes),
  },

  /** MCP 服务器（4.2）：生命周期全在主进程，配置存 config.json 的 mcp.servers */
  mcp: {
    list: (): Promise<McpServerView[]> => ipcRenderer.invoke(IPC.MCP_LIST),
    add: (input: McpServerInput): Promise<McpMutationResult> => ipcRenderer.invoke(IPC.MCP_ADD, input),
    remove: (id: string): Promise<McpMutationResult> => ipcRenderer.invoke(IPC.MCP_REMOVE, id),
    setEnabled: (id: string, enabled: boolean): Promise<McpMutationResult> =>
      ipcRenderer.invoke(IPC.MCP_SET_ENABLED, id, enabled),
    reconnect: (id: string): Promise<McpMutationResult> => ipcRenderer.invoke(IPC.MCP_RECONNECT, id),
  },

  /** 长期记忆 + 人设（5.1.2）：共用一个 memory 桥（同一个 store），内容落独立文件、不进 config.json */
  memory: {
    getLongTerm: (): Promise<LongTermMemory> => ipcRenderer.invoke(IPC.LONG_TERM_GET),
    setLongTerm: (input: LongTermMemory): Promise<LongTermMemory> => ipcRenderer.invoke(IPC.LONG_TERM_SET, input),
    // 9.x persona v2：分层人设（main=persona.md 身份+规则 / soul=soul.md 人格 / canon=canon.md 台词锚）。
    // part 缺省 = main（旧调用零破坏）；part 只允许白名单字面量（主进程 isPersonaPart 二次校验），
    // 路径由主进程拼，渲染层不传路径（6.6.2 口径不变）
    getPersona: (part?: "main" | "soul" | "canon"): Promise<string> =>
      ipcRenderer.invoke(IPC.PERSONA_GET, part ?? "main"),
    setPersona: (text: string, part?: "main" | "soul" | "canon"): Promise<string> =>
      ipcRenderer.invoke(IPC.PERSONA_SET, text, part ?? "main"),
    // 6.6.2：人设文件「系统编辑器打开 / 资源管理器定位」—— 渲染层只传白名单 part，不传路径
    openPersona: (part?: "main" | "soul" | "canon"): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.PERSONA_OPEN, part ?? "main"),
    revealPersona: (part?: "main" | "soul" | "canon"): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(IPC.PERSONA_REVEAL, part ?? "main"),
    // 5.1.6：用户档案（user.md 常驻块）—— 自动段只读（重写器维护），写只写手写段
    getUserProfile: (): Promise<UserProfileView> => ipcRenderer.invoke(IPC.USER_PROFILE_GET),
    setUserProfile: (manual: string): Promise<UserProfileView> => ipcRenderer.invoke(IPC.USER_PROFILE_SET, manual),
    // 5.1.5：睡前整理 —— 手动整理 / 状态投影 / 回滚（判定与落盘都在主进程）
    tidyNow: (): Promise<TidyReportView> => ipcRenderer.invoke(IPC.MEMORY_TIDY_NOW),
    tidyState: (): Promise<TidyStatusView> => ipcRenderer.invoke(IPC.MEMORY_TIDY_STATE),
    tidyRollback: (backupName: string): Promise<{ ok: boolean; reason: string }> =>
      ipcRenderer.invoke(IPC.MEMORY_TIDY_ROLLBACK, backupName),
  },

  /** 天气（6.6.4）：主进程只取数（Open-Meteo）；渲染侧拿到结果自己 patch env.weather */
  weather: {
    fetchOnline: (input: { lat: number; lon: number }): Promise<{ ok: boolean; text?: string; temp?: string; error?: string }> =>
      ipcRenderer.invoke(IPC.WEATHER_FETCH_ONLINE, input),
  },

  /** 好感度（5.6.1）：真相在主进程独立文件存储，渲染层只拿投影 */
  relationship: {
    get: (): Promise<RelationshipView> => ipcRenderer.invoke(IPC.RELATIONSHIP_GET),
    patch: (patch: RelationshipPatch): Promise<RelationshipView> => ipcRenderer.invoke(IPC.RELATIONSHIP_PATCH, patch),
  },

  /** 剧情系统（5.7.2）：章节 / 分支 / 存档三张表 + 触发判定。与 global.d.ts 同名桥逐字同形 */
  story: {
    listChapters: (): Promise<Chapter[]> => ipcRenderer.invoke(IPC.STORY_LIST_CHAPTERS),
    upsertChapter: (input: { chapter: unknown; branches?: unknown }): Promise<Chapter[]> =>
      ipcRenderer.invoke(IPC.STORY_UPSERT_CHAPTER, input),
    evaluate: (extras?: StoryContextExtras): Promise<Chapter[]> => ipcRenderer.invoke(IPC.STORY_EVALUATE, extras),
    listSaves: (): Promise<StorySave[]> => ipcRenderer.invoke(IPC.STORY_LIST_SAVES),
    createSave: (input: {
      chapterId: string;
      nodeId: string;
      messageTreeRef: { sessionId: string; nodeId: string };
    }): Promise<StorySave | null> => ipcRenderer.invoke(IPC.STORY_CREATE_SAVE, input),
    deleteSave: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.STORY_DELETE_SAVE, id),
    // 5.7.3.2：生成场景与选项（主进程跑三档结构化输出；永不抛错，失败看 ok=false）
    generate: (req: StoryGenerateRequest): Promise<StoryGenerateResult> =>
      ipcRenderer.invoke(IPC.STORY_GENERATE, req),
  },

  /** 影像线（2.7b/c/d）：截图 / 录屏 / 直播。FFmpeg 是外部二进制，路径由主进程探测 */
  media: {
    listSources: (): Promise<CaptureSourceView[]> => ipcRenderer.invoke(IPC.MEDIA_LIST_SOURCES),
    ffmpegStatus: (): Promise<FfmpegStatus> => ipcRenderer.invoke(IPC.MEDIA_FFMPEG_STATUS),
    setFfmpegPath: (): Promise<FfmpegStatus> => ipcRenderer.invoke(IPC.MEDIA_SET_FFMPEG_PATH),
    listAudioDevices: (): Promise<AudioDeviceView[]> => ipcRenderer.invoke(IPC.MEDIA_LIST_AUDIO_DEVICES),

    takeShot: (req: CaptureRequest): Promise<CaptureShot> => ipcRenderer.invoke(IPC.CAPTURE_TAKE, req),
    library: (): Promise<CaptureLibrary> => ipcRenderer.invoke(IPC.CAPTURE_LIBRARY),
    reveal: (p: string): void => { ipcRenderer.send(IPC.CAPTURE_REVEAL, p); },
    readImage: (p: string): Promise<string> => ipcRenderer.invoke(IPC.CAPTURE_READ_IMAGE, p),
    deleteShot: (p: string): Promise<void> => ipcRenderer.invoke(IPC.CAPTURE_DELETE, p),
    pickCaptureDir: (): Promise<CaptureLibrary> => ipcRenderer.invoke(IPC.CAPTURE_PICK_DIR),

    selectRecordSource: (sourceId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.RECORD_SELECT_SOURCE, sourceId),
    saveRecord: (req: RecordSaveRequest): Promise<RecordClip> => ipcRenderer.invoke(IPC.RECORD_SAVE, req),
    listRecords: (): Promise<RecordClip[]> => ipcRenderer.invoke(IPC.RECORD_LIST),
    pickRecordDir: (): Promise<string> => ipcRenderer.invoke(IPC.RECORD_PICK_DIR),

    liveTest: (req: LiveStartRequest): Promise<LiveResult> => ipcRenderer.invoke(IPC.LIVE_TEST, req),
    liveStart: (req: LiveStartRequest): Promise<LiveResult> => ipcRenderer.invoke(IPC.LIVE_START, req),
    liveStop: (): Promise<LiveResult> => ipcRenderer.invoke(IPC.LIVE_STOP),
    clearLiveLogs: (): Promise<number> => ipcRenderer.invoke(IPC.LIVE_CLEAR_LOGS),
    onLiveEvent: (cb: (evt: LiveEvent) => void): (() => void) => subscribe<LiveEvent>(IPC.LIVE_EVENT, cb),

    // 区域截图遮罩窗专用三条（指令 §3.2④）
    onOverlayImage: (cb: (dataUrl: string) => void): (() => void) =>
      subscribe<string>(IPC.CAPTURE_OVERLAY_IMAGE, cb),
    submitArea: (sel: AreaSelection): Promise<void> => ipcRenderer.invoke(IPC.CAPTURE_AREA_SUBMIT, sel),
    cancelArea: (): Promise<void> => ipcRenderer.invoke(IPC.CAPTURE_AREA_CANCEL),
  },

  /** 悬浮球（5.9.1 / 5.9.2）：与 global.d.ts 的 orb 桥逐字同形 */
  orb: {
    getState: (): Promise<OrbView> => ipcRenderer.invoke(IPC.ORB_STATE_GET),
    onAvatar: (cb: (dataUrl: string) => void): (() => void) => subscribe<string>(IPC.ORB_AVATAR, cb),
    drag: (p: { phase: "move" | "end"; x: number; y: number }): void => { ipcRenderer.send(IPC.ORB_DRAG, p); },
    setPassthrough: (on: boolean): void => { ipcRenderer.send(IPC.ORB_SET_PASSTHROUGH, on); },
    unsnap: (): void => { ipcRenderer.send(IPC.ORB_UNSNAP); },
    onState: (cb: (state: OrbExpandState) => void): (() => void) => subscribe<OrbExpandState>(IPC.ORB_STATE, cb),
    onPointerLeft: (cb: () => void): (() => void) => subscribe<undefined>(IPC.ORB_POINTER_LEFT, cb),
  },

  /** 外部消息通道（8.8）：通道真相 / 启停 / 自检注入全在主进程，渲染层只拿状态投影 */
  im: {
    listChannels: (): Promise<ImChannelView[]> => ipcRenderer.invoke(IPC.IM_LIST_CHANNELS),
    setEnabled: (id: string, enabled: boolean): Promise<ImChannelView[]> =>
      ipcRenderer.invoke(IPC.IM_SET_ENABLED, id, enabled),
    /** 8.10.2 清空通道上下文：真删绑定的独立会话 + 解绑 sessionId，返回最新视图 */
    clearSession: (id: string): Promise<ImChannelView[]> =>
      ipcRenderer.invoke(IPC.IM_CLEAR_SESSION, id),
    /** 假适配器（echo）自检：模拟一条外部来信；真实通道会返回 ok:false */
    inject: (input: { channelId: string; target?: string; text: string }): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke(IPC.IM_INJECT, input),
    /** 8.9 凭证写入（飞书 / 钉钉）：值走主进程白名单消毒 + enc: 落盘；传入当前掩码 = 未改动 */
    setConfig: (id: string, config: Record<string, string>): Promise<ImChannelView[]> =>
      ipcRenderer.invoke(IPC.IM_SET_CONFIG, id, config),
    /** 8.9 连接测试：草稿与已落盘值在主进程合并后试连，返回一句人话（不抛） */
    testConnection: (input: { channelId: string; config: Record<string, string> }): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke(IPC.IM_TEST_CONNECTION, input),
    /** 8.10 微信（iLink）扫码登录：取码 → 约 2s 轮询 → 成功时凭证已在主进程落盘（渲染层只负责展示） */
    weixinQr: {
      start: (): Promise<WeixinQrStartView> => ipcRenderer.invoke(IPC.IM_WEIXIN_QR_START),
      poll: (): Promise<WeixinQrPollView> => ipcRenderer.invoke(IPC.IM_WEIXIN_QR_POLL),
      cancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(IPC.IM_WEIXIN_QR_CANCEL),
    },
  },

  /** 技能（8.7）：技能目录 userData/skills，扫描与启用状态全在主进程，渲染层只拿投影 */
  skills: {
    list: (): Promise<SkillSummary[]> => ipcRenderer.invoke(IPC.SKILLS_LIST),
    setEnabled: (id: string, enabled: boolean): Promise<SkillSummary[]> =>
      ipcRenderer.invoke(IPC.SKILLS_SET_ENABLED, id, enabled),
    refresh: (): Promise<SkillSummary[]> => ipcRenderer.invoke(IPC.SKILLS_REFRESH),
    openDir: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(IPC.SKILLS_OPEN_DIR),
  },

  /** 工具箱 · 工具独立窗口（8.7.7）：点卡片 → 主进程弹/聚焦该工具的子窗口（fire-and-forget）。
   *  目录选择复用 fs:pick-dir（8.2，只弹框不落盘），不在这层重复暴露 */
  toolbox: {
    open: (payload: ToolboxOpenPayload): void => { ipcRenderer.send(IPC.TOOLBOX_OPEN, payload); },
  },

  /** 音乐 · 网易云（9.x）：后端 / 账号 / 播放真相全在主进程 MusicService，这里只做通道转发。
   *  全部走 MusicIpcEnvelope 信封（失败带错误码与三轴快照，不抛错）；
   *  卡片数据在渲染层过 normalizeMusicCardData 再用（shared/music-card.ts） */
  music: {
    getStatus: (): Promise<MusicIpcEnvelope<MusicStatusSnapshot>> => ipcRenderer.invoke(IPC.MUSIC_GET_STATUS),
    beginLogin: (): Promise<MusicIpcEnvelope<{ qrContent: string } | { status: string }>> =>
      ipcRenderer.invoke(IPC.MUSIC_BEGIN_LOGIN),
    cancelLogin: (): Promise<MusicIpcEnvelope<unknown>> => ipcRenderer.invoke(IPC.MUSIC_CANCEL_LOGIN),
    logout: (): Promise<MusicIpcEnvelope<unknown>> => ipcRenderer.invoke(IPC.MUSIC_LOGOUT),
    getDaily: (): Promise<MusicIpcEnvelope<MusicCardData | null>> => ipcRenderer.invoke(IPC.MUSIC_GET_DAILY),
    search: (keyword: string, limit?: number): Promise<MusicIpcEnvelope<MusicCardData | null>> =>
      ipcRenderer.invoke(IPC.MUSIC_SEARCH, { keyword, limit }),
    presentTracks: (args: {
      setId: string; conversationId: string; trackIds: string[]; reasons?: string[];
    }): Promise<MusicIpcEnvelope<unknown>> => ipcRenderer.invoke(IPC.MUSIC_PRESENT_TRACKS, args),
    playTrack: (trackId: string): Promise<MusicIpcEnvelope<MusicPlaybackView>> =>
      ipcRenderer.invoke(IPC.MUSIC_PLAY_TRACK, trackId),
    playPlaylist: (playlistId: string): Promise<MusicIpcEnvelope<MusicPlaybackView>> =>
      ipcRenderer.invoke(IPC.MUSIC_PLAY_PLAYLIST, playlistId),
    detectPlayer: (): Promise<MusicIpcEnvelope<"unknown" | "available" | "unavailable">> =>
      ipcRenderer.invoke(IPC.MUSIC_DETECT_PLAYER),
    /** 登录进度 / 后端生命周期变化时主进程主动推快照（可替代轮询 getStatus） */
    onStateChanged: (callback: (snapshot: MusicStatusSnapshot) => void): (() => void) =>
      subscribe<MusicStatusSnapshot>(IPC.MUSIC_STATE_CHANGED, callback),
    /** 点歌卡片推送（AI 点歌链路预留；本次 UI 不消费也保留订阅口子） */
    onCard: (callback: (card: MusicCardData) => void): (() => void) =>
      subscribe<MusicCardData>(IPC.MUSIC_CARD, callback),
  },
};

contextBridge.exposeInMainWorld("nahida", nahidaApi);
