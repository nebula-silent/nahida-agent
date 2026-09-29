// 参考自 Cyrene-Agent src/renderer/global.d.ts
// 渲染进程全局类型声明：与 src/preload/index.ts 暴露的 nahidaApi 保持一致
import type { ChatMessage, ChatRequest, ChatSearchResult, ChatSession, ChatSessionMeta } from "../shared/chat";
import type { AppConfig, ImChannelView, WeixinQrPollView, WeixinQrStartView } from "../shared/config";
import type { DeepPartial } from "../shared/types";
import type { PresetSummary, TestConnectionResult } from "../shared/provider/types";
import type { PermissionSnapshot, ToolAccessLevel, ToolSummary } from "../shared/tools";
import type { AuditView } from "../shared/audit";
import type { ApprovalRequest, ToolCallEvent } from "../shared/tool-call";
import type { VoiceEngineSummary, VoicePathPickRequest } from "../shared/voice/types";
import type { DirEntry, RenameOutcome, RenameRunPayload } from "../shared/rename";
import type { ClipMutationResult, ClipPinPayload, ClipRecord } from "../shared/clip";
import type { PdfJobResult, PdfSplitPayload } from "../shared/pdf-tool";
import type { RssAddResult, RssFeed, RssFeedResult } from "../shared/rss";
import type { FfmpegStatus as TranscodeFfmpegStatus, TranscodeResult, TranscodeStartPayload } from "../shared/transcode";
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
import type { MusicIpcEnvelope, MusicPlaybackView } from "../shared/music-types";
import type { MusicStatusSnapshot } from "../shared/music-view-state";
import type { MusicCardData } from "../shared/music-card";

// 9.x：qrcode 浏览器入口没有自带类型（主进程冒烟入口用的是 require + 局部形状声明，同口径）
declare module "qrcode/lib/browser" {
  const QRCode: { toDataURL(text: string): Promise<string> };
  export default QRCode;
}

interface NahidaApi {
  minimize: () => void;
  maximize: () => void;
  isMaximized: () => Promise<boolean>;
  onMaximizeChange: (callback: (maximized: boolean) => void) => () => void;
  close: () => void;
  quit: () => void;
  getVersion: () => Promise<string>;
  ping: (stamp: string) => Promise<string>;
  versions: {
    electron: string;
    chrome: string;
    node: string;
  };
  chat: {
    listModels: () => Promise<string[]>;
    start: (request: ChatRequest) => Promise<void>;
    abort: () => void;
    onDelta: (callback: (text: string) => void) => () => void;
    onDone: (callback: () => void) => () => void;
    onError: (callback: (message: string) => void) => () => void;
    /** 4.1.1：工具生命周期事件（start / done） */
    onToolCall: (callback: (evt: ToolCallEvent) => void) => () => void;
  };
  config: {
    get: () => Promise<AppConfig>;
    set: (patch: DeepPartial<AppConfig>) => Promise<AppConfig>;
  };
  /** 8.7.21：外观视觉项广播（主题/强调色/背景样式变更 → 独立子窗实时跟随）。与 preload 的 ui 桥逐字同形 */
  ui: {
    onThemeChanged: (callback: (patch: { theme?: string; accent?: string; bgType?: string; bgImage?: string }) => void) => () => void;
    /** 8.7.22：背景图文件选择（背景样式=自定义图片）；取消返回 "" */
    pickBgImage: () => Promise<string>;
  };
  provider: {
    listPresets: () => Promise<PresetSummary[]>;
    test: (override?: Partial<AppConfig["model"]>) => Promise<TestConnectionResult>;
  };
  /** 视觉旁路（8.1）：视觉模型连接测试（独立于聊天模型；配置读写仍走 config:*） */
  vision: {
    test: (override?: Partial<AppConfig["vision"]>) => Promise<TestConnectionResult>;
  };
  chats: {
    list: () => Promise<ChatSessionMeta[]>;
    create: (initialMessages?: ChatMessage[]) => Promise<ChatSession>;
    get: (id: string) => Promise<ChatSession | null>;
    append: (id: string, message: ChatMessage, parentId?: string, branchId?: string) => Promise<ChatSession | null>;
    setActive: (id: string, nodeId: string) => Promise<ChatSession | null>;
    delete: (id: string) => Promise<boolean>;
    rename: (id: string, title: string) => Promise<ChatSession | null>;
    search: (query: string, limit?: number) => Promise<ChatSearchResult>;
    /** 9.1：设/清对话绑定目录（id 传 null = 会话还没建，只更新主进程内存；dir 空串 = 清除） */
    setWorkDir: (id: string | null, dir: string) => Promise<ChatSession | null>;
  };
  tools: {
    list: () => Promise<ToolSummary[]>;
    setEnabled: (id: string, enabled: boolean) => Promise<ToolSummary[]>;
    /** 4.1.1：审批卡片 */
    onApprovalRequest: (callback: (req: ApprovalRequest) => void) => () => void;
    respondApproval: (callId: string, allowed: boolean) => Promise<{ ok: boolean }>;
  };
  permission: {
    get: () => Promise<PermissionSnapshot>;
    set: (level: ToolAccessLevel) => Promise<{ ok: boolean; snapshot: PermissionSnapshot }>;
  };
  /** 操作审计（8.4）：只读最近记录 + 打开审计目录。与 preload 的 audit 桥逐字同形 */
  audit: {
    list: () => Promise<AuditView>;
    openDir: () => Promise<{ ok: boolean; error?: string }>;
  };
  /** 文件工具（8.2）：allowedDirs 白名单的「添加目录」（只弹框返回路径，取消返回空串）。与 preload 的 fs 桥逐字同形 */
  fs: {
    pickDir: () => Promise<string>;
  };
  /** 批量重命名（8.7.10）：与 preload 的 rename 桥逐字同形 */
  rename: {
    listDir: (dir: string) => Promise<DirEntry[]>;
    run: (payload: RenameRunPayload) => Promise<RenameOutcome[]>;
  };
  /** 剪贴板历史（8.7.17）：真相在主进程，渲染层只展示 + 操作。与 preload 的 clip 桥逐字同形 */
  clip: {
    list: () => Promise<ClipRecord[]>;
    clear: () => Promise<ClipMutationResult>;
    pin: (payload: ClipPinPayload) => Promise<ClipMutationResult>;
    copy: (text: string) => void;
  };
  /** PDF 合并 / 拆分（8.7.18）：文件选择/保存走主进程 dialog。与 preload 的 pdfTool 桥逐字同形 */
  pdfTool: {
    merge: () => Promise<PdfJobResult>;
    split: (payload: PdfSplitPayload) => Promise<PdfJobResult>;
  };
  /** RSS 阅读器（8.7.19）：订阅持久化 + 抓取都在主进程。与 preload 的 rss 桥逐字同形 */
  rss: {
    list: () => Promise<RssFeed[]>;
    add: (url: string) => Promise<RssAddResult>;
    remove: (id: string) => Promise<RssFeed[]>;
    fetch: (id: string) => Promise<RssFeedResult>;
  };
  /** 音视频转换（8.7.20）：用项目便携 ffmpeg；缺时引导设置。与 preload 的 transcode 桥逐字同形 */
  transcode: {
    ffmpegStatus: () => Promise<TranscodeFfmpegStatus>;
    start: (payload: TranscodeStartPayload) => Promise<TranscodeResult>;
  };
  /** 语音引擎注册表（4.3）+ 配置（4.6，值读写走 config:*）。与 preload 的 voice 桥逐字同形 */
  voice: {
    listEngines: () => Promise<VoiceEngineSummary[]>;
    /** 4.6：path 字段的「浏览」；取消返回空串（渲染层据此**不清空**已有值） */
    pickPath: (req?: VoicePathPickRequest) => Promise<string>;
  };
  /** 通话（4.9）：与 preload 的 call 桥逐字同形 */
  call: {
    start: (req?: CallStartRequest) => Promise<CallStartResult>;
    frame: (bytes: ArrayBuffer) => void;
    playbackDone: () => void;
    hangup: () => void;
    onState: (cb: (e: CallStateEvent) => void) => () => void;
    onAsr: (cb: (e: CallAsrEvent) => void) => () => void;
    onTts: (cb: (e: CallTtsEvent) => void) => () => void;
    onError: (cb: (message: string) => void) => () => void;
    /** 6.2 语音转文字：整段 PCM 一次性识别（不走通话状态机），失败转 {ok:false,error} 不抛 */
    transcribe: (bytes: ArrayBuffer) => Promise<CallTranscribeResult>;
  };
  /** MCP 服务器（4.2）：生命周期全在主进程，配置存 config.json 的 mcp.servers */
  mcp: {
    list: () => Promise<McpServerView[]>;
    add: (input: McpServerInput) => Promise<McpMutationResult>;
    remove: (id: string) => Promise<McpMutationResult>;
    setEnabled: (id: string, enabled: boolean) => Promise<McpMutationResult>;
    reconnect: (id: string) => Promise<McpMutationResult>;
  };
  /** 长期记忆 + 人设（5.1.2）：共用一个 memory 桥（同一个 store），内容落独立文件、不进 config.json。与 preload 的 memory 桥逐字同形 */
  memory: {
    getLongTerm: () => Promise<LongTermMemory>;
    setLongTerm: (input: LongTermMemory) => Promise<LongTermMemory>;
    /** 9.x persona v2：分层人设 —— part 缺省 = main（persona.md 身份+规则）；soul=soul.md 人格；canon=canon.md 台词锚 */
    getPersona: (part?: "main" | "soul" | "canon") => Promise<string>;
    setPersona: (text: string, part?: "main" | "soul" | "canon") => Promise<string>;
    /** 6.6.2：人设文件「系统编辑器打开 / 资源管理器定位」—— 渲染层只传白名单 part，不传路径 */
    openPersona: (part?: "main" | "soul" | "canon") => Promise<{ ok: boolean; error?: string }>;
    revealPersona: (part?: "main" | "soul" | "canon") => Promise<{ ok: boolean; error?: string }>;
    /** 5.1.6：用户档案（user.md 常驻块）—— 自动段只读，写只写手写段 */
    getUserProfile: () => Promise<UserProfileView>;
    setUserProfile: (manual: string) => Promise<UserProfileView>;
    /** 5.1.5：睡前整理 —— 手动整理 / 状态投影 / 回滚（判定与落盘都在主进程） */
    tidyNow: () => Promise<TidyReportView>;
    tidyState: () => Promise<TidyStatusView>;
    tidyRollback: (backupName: string) => Promise<{ ok: boolean; reason: string }>;
  };
  /** 天气（6.6.4）：主进程只取数（Open-Meteo）；渲染侧拿到结果自己 patch env.weather。与 preload 同名桥逐字同形 */
  weather: {
    fetchOnline: (input: { lat: number; lon: number }) => Promise<{ ok: boolean; text?: string; temp?: string; error?: string }>;
  };
  /** 好感度（5.6.1）：真相在主进程独立文件存储，渲染层只拿投影。与 preload 同名桥逐字同形 */
  relationship: {
    get: () => Promise<RelationshipView>;
    patch: (patch: RelationshipPatch) => Promise<RelationshipView>;
  };
  /** 剧情系统（5.7.2）：章节 / 分支 / 存档三张表 + 触发判定。与 preload 同名桥逐字同形 */
  story: {
    listChapters: () => Promise<Chapter[]>;
    upsertChapter: (input: { chapter: unknown; branches?: unknown }) => Promise<Chapter[]>;
    evaluate: (extras?: StoryContextExtras) => Promise<Chapter[]>;
    listSaves: () => Promise<StorySave[]>;
    createSave: (input: {
      chapterId: string;
      nodeId: string;
      messageTreeRef: { sessionId: string; nodeId: string };
    }) => Promise<StorySave | null>;
    deleteSave: (id: string) => Promise<boolean>;
    /** 5.7.3.2：生成场景与选项（主进程跑三档结构化输出；永不抛错，失败看 ok=false） */
    generate: (req: StoryGenerateRequest) => Promise<StoryGenerateResult>;
  };
  /** 影像线（2.7b/c/d）：截图 / 录屏 / 直播。FFmpeg 是外部二进制，路径由主进程探测。与 preload 的 media 桥逐字同形 */
  media: {
    listSources: () => Promise<CaptureSourceView[]>;
    ffmpegStatus: () => Promise<FfmpegStatus>;
    setFfmpegPath: () => Promise<FfmpegStatus>;
    listAudioDevices: () => Promise<AudioDeviceView[]>;

    takeShot: (req: CaptureRequest) => Promise<CaptureShot>;
    library: () => Promise<CaptureLibrary>;
    reveal: (p: string) => void;
    /** 读截图转 dataURL（file:// 被拦，主进程代读） */
    readImage: (p: string) => Promise<string>;
    /** 应用内删除一张截图（路径须在归档目录内） */
    deleteShot: (p: string) => Promise<void>;
    /** 弹目录选择框配置截图保存目录，返回最新影像库 */
    pickCaptureDir: () => Promise<CaptureLibrary>;

    selectRecordSource: (sourceId: string) => Promise<void>;
    saveRecord: (req: RecordSaveRequest) => Promise<RecordClip>;
    listRecords: () => Promise<RecordClip[]>;
    pickRecordDir: () => Promise<string>;

    liveTest: (req: LiveStartRequest) => Promise<LiveResult>;
    liveStart: (req: LiveStartRequest) => Promise<LiveResult>;
    liveStop: () => Promise<LiveResult>;
    clearLiveLogs: () => Promise<number>;
    onLiveEvent: (cb: (evt: LiveEvent) => void) => () => void;

    onOverlayImage: (cb: (dataUrl: string) => void) => () => void;
    submitArea: (sel: AreaSelection) => Promise<void>;
    cancelArea: () => Promise<void>;
  };
  /** 悬浮球：与 preload 的 orb 桥逐字同形（A 重做：开合归渲染端，无 setExpanded） */
  orb: {
    getState: () => Promise<OrbView>;
    onAvatar: (cb: (dataUrl: string) => void) => () => void;
    drag: (p: { phase: "move" | "end"; x: number; y: number }) => void;
    setPassthrough: (on: boolean) => void;
    unsnap: () => void;
    onState: (cb: (state: OrbExpandState) => void) => () => void;
    onPointerLeft: (cb: () => void) => () => void;
  };
  /** 外部消息通道（8.8）：通道真相 / 启停 / 自检注入全在主进程。与 preload 的 im 桥逐字同形 */
  im: {
    listChannels: () => Promise<ImChannelView[]>;
    setEnabled: (id: string, enabled: boolean) => Promise<ImChannelView[]>;
    /** 8.10.2 清空通道上下文：真删绑定的独立会话 + 解绑 sessionId */
    clearSession: (id: string) => Promise<ImChannelView[]>;
    /** 假适配器（echo）自检：模拟一条外部来信；真实通道返回 ok:false */
    inject: (input: { channelId: string; target?: string; text: string }) => Promise<{ ok: boolean; reason?: string }>;
    /** 8.9 凭证写入：值走主进程白名单消毒 + enc: 落盘；传入当前掩码 = 未改动 */
    setConfig: (id: string, config: Record<string, string>) => Promise<ImChannelView[]>;
    /** 8.9 连接测试：草稿与已落盘值在主进程合并后试连，返回一句人话 */
    testConnection: (input: { channelId: string; config: Record<string, string> }) => Promise<{ ok: boolean; message: string }>;
    /** 8.10 微信（iLink）扫码登录：凭证写入在主进程完成，渲染层只负责展示 */
    weixinQr: {
      start: () => Promise<WeixinQrStartView>;
      poll: () => Promise<WeixinQrPollView>;
      cancel: () => Promise<{ ok: boolean }>;
    };
  };
  /** 技能（8.7）：目录扫描 / 启用开关 / 重扫 / 打开目录全在主进程。与 preload 的 skills 桥逐字同形 */
  skills: {
    list: () => Promise<SkillSummary[]>;
    setEnabled: (id: string, enabled: boolean) => Promise<SkillSummary[]>;
    refresh: () => Promise<SkillSummary[]>;
    openDir: () => Promise<{ ok: boolean; error?: string }>;
  };
  /** 工具箱 · 工具独立窗口（8.7.7）：点工具卡片 → 主进程弹/聚焦该工具的独立子窗口 */
  toolbox: {
    open: (payload: ToolboxOpenPayload) => void;
  };
  /** 音乐 · 网易云（9.x）：与 preload/index.ts 的 music 段逐字同形 */
  music: {
    getStatus: () => Promise<MusicIpcEnvelope<MusicStatusSnapshot>>;
    beginLogin: () => Promise<MusicIpcEnvelope<{ qrContent: string } | { status: string }>>;
    cancelLogin: () => Promise<MusicIpcEnvelope<unknown>>;
    logout: () => Promise<MusicIpcEnvelope<unknown>>;
    getDaily: () => Promise<MusicIpcEnvelope<MusicCardData | null>>;
    search: (keyword: string, limit?: number) => Promise<MusicIpcEnvelope<MusicCardData | null>>;
    presentTracks: (args: {
      setId: string; conversationId: string; trackIds: string[]; reasons?: string[];
    }) => Promise<MusicIpcEnvelope<unknown>>;
    playTrack: (trackId: string) => Promise<MusicIpcEnvelope<MusicPlaybackView>>;
    playPlaylist: (playlistId: string) => Promise<MusicIpcEnvelope<MusicPlaybackView>>;
    detectPlayer: () => Promise<MusicIpcEnvelope<"unknown" | "available" | "unavailable">>;
    onStateChanged: (callback: (snapshot: MusicStatusSnapshot) => void) => () => void;
    onCard: (callback: (card: MusicCardData) => void) => () => void;
  };
}

declare global {
  interface Window {
    nahida: NahidaApi;
  }
}

export {};
