// 参考自 Cyrene-Agent src/shared/ipc-channels.ts
// 已精简：只保留骨架窗口（主进程 ↔ preload ↔ renderer）所需通道，业务通道后续按模块补回
export const IPC = {
  // 主窗口控制
  WINDOW_MINIMIZE: "window:minimize",
  WINDOW_MAXIMIZE: "window:maximize", // 切换最大化：isMaximized ? unmaximize : maximize
  WINDOW_IS_MAXIMIZED: "window:is-maximized", // invoke: () => boolean，初始状态查询
  WINDOW_MAXIMIZE_CHANGED: "window:maximize-changed", // main -> renderer: 最大化状态回推（boolean）
  WINDOW_CLOSE: "window:close",

  // 应用级
  APP_GET_VERSION: "app:get-version",
  APP_QUIT: "app:quit",

  // 骨架自检：验证 preload 桥接是否联通
  APP_PING: "app:ping",

  // 本地 Ollama 对话
  CHAT_LIST_MODELS: "chat:list-models", // invoke: () => string[]
  CHAT_START: "chat:start", // invoke: (ChatRequest) => void
  CHAT_ABORT: "chat:abort", // send: () => void
  CHAT_DELTA: "chat:delta", // main -> renderer: 增量文本
  CHAT_DONE: "chat:done", // main -> renderer: 本轮结束（含手动停止）
  CHAT_ERROR: "chat:error", // main -> renderer: 错误信息

  // 配置存储（3.2）：主进程持有明文，渲染进程只拿掩码
  CONFIG_GET: "config:get", // invoke: () => AppConfig（敏感字段已掩码）
  CONFIG_SET: "config:set", // invoke: (patch: DeepPartial<AppConfig>) => AppConfig（返回掩码后的全量）
  // 8.7.21：外观视觉项变更广播（main -> 所有窗口）：设置页改 theme/accent/bgType/bgImage 时，
  // 工具箱等独立子窗实时跟随；payload 只带变化的键 { theme?, accent?, bgType?, bgImage? }
  UI_THEME_CHANGED: "ui:theme-changed",
  // 8.7.22：背景图文件选择（背景样式=自定义图片）。invoke: () => string（弹系统文件框选图；
  // 只返回路径，落盘由渲染端走 config:set({ ui: { bgImage } })，取消返回 ""）
  UI_PICK_BG_IMAGE: "ui:pick-bg-image",

  // 对话存储（3.3）
  CHATS_LIST: "chats:list", // invoke: () => ChatSessionMeta[]
  CHATS_CREATE: "chats:create", // invoke: (initialMessages?: ChatMessage[]) => ChatSession
  CHATS_GET: "chats:get", // invoke: (id: string) => ChatSession | null
  CHATS_APPEND: "chats:append", // invoke: (id: string, message: ChatMessage, parentId?: string, branchId?: string) => ChatSession | null（parentId 省略 = 挂当前叶续写；给了 = 从该节点分叉；branchId 非空才写进节点）
  CHATS_SET_ACTIVE: "chats:set-active", // invoke: (id, nodeId) => ChatSession | null（切分支）
  CHATS_DELETE: "chats:delete", // invoke: (id: string) => boolean
  CHATS_RENAME: "chats:rename", // invoke: (id: string, title: string) => ChatSession | null
  CHATS_SEARCH: "chats:search", // invoke: (query: string, limit?: number) => ChatSearchResult（跨会话全文搜 content，含 [表情] 直发文本）
  CHATS_SET_WORK_DIR: "chats:set-work-dir", // invoke: (id: string | null, dir: string) => ChatSession | null（9.1：设/清对话绑定目录；id=null = 会话还没建，只更新主进程内存；dir="" = 清除）

  // 模型配置与连接测试（3.7）
  PROVIDER_LIST_PRESETS: "provider:list-presets", // invoke: () => PresetSummary[]
  PROVIDER_TEST: "provider:test", // invoke: (override?: Partial<AppConfig["model"]>) => TestConnectionResult

  // 视觉旁路（8.1）：视觉模型连接测试（带最小图，独立于 provider:test）
  VISION_TEST: "vision:test", // invoke: (override?: Partial<AppConfig["vision"]>) => TestConnectionResult

  // 工具注册表与权限网关（4.1）
  TOOLS_LIST: "tools:list", // invoke: () => ToolSummary[]（含未启用的，带 enabled 标志）
  TOOLS_SET_ENABLED: "tools:set-enabled", // invoke: (id: string, enabled: boolean) => ToolSummary[]
  PERMISSION_GET: "permission:get", // invoke: () => PermissionSnapshot
  PERMISSION_SET: "permission:set", // invoke: (level) => { ok: boolean; snapshot: PermissionSnapshot }

  // 操作审计（8.4）：真相在 userData/audit/audit-YYYYMM.jsonl（按月分文件），渲染层只读最近 N 条
  AUDIT_LIST: "audit:list",         // invoke: () => AuditView（最近记录 + 目录 + 当前月总行数）
  AUDIT_OPEN_DIR: "audit:open-dir", // invoke: () => { ok: boolean; error?: string }（shell.openPath，路径主进程自解析）

  // 文件工具（8.2）：allowedDirs 白名单的「添加目录」。**只弹框、只返回路径，绝不写配置**
  // （写不写由渲染层决定 —— 同 4.6 的 voice:pick-path 口径）
  FS_PICK_DIR: "fs:pick-dir",       // invoke: () => string（取消返回 ""）
  // 8.7.10：批量重命名（工具箱 · 自研工具）
  RENAME_LIST: "rename:list",       // invoke: (dir: string) => DirEntry[]
  RENAME_RUN: "rename:run",         // invoke: (payload: RenameRunPayload) => RenameOutcome[]
  // 8.7.17：剪贴板历史
  CLIP_LIST: "clip:list",             // invoke: () => ClipRecord[]
  CLIP_CLEAR: "clip:clear",           // invoke: () => ClipMutationResult
  CLIP_PIN: "clip:pin",               // invoke: (payload: ClipPinPayload) => ClipMutationResult
  CLIP_COPY: "clip:copy",             // invoke: (text: string) => void（写回系统剪贴板并置顶）
  // 8.7.18：PDF 合并 / 拆分
  PDF_MERGE: "pdf:merge",             // invoke: () => PdfJobResult（多选源 PDF → 合成一个）
  PDF_SPLIT: "pdf:split",             // invoke: (payload: PdfSplitPayload) => PdfJobResult
  // 8.7.19：RSS 阅读器
  RSS_LIST: "rss:list",               // invoke: () => RssFeed[]
  RSS_ADD: "rss:add",                 // invoke: (url: string) => RssAddResult
  RSS_REMOVE: "rss:remove",           // invoke: (id: string) => RssFeed[]
  RSS_FETCH: "rss:fetch",             // invoke: (id: string) => RssFeedResult
  // 8.7.20：音视频格式转换
  TRANSCODE_FFMPEG: "transcode:ffmpeg", // invoke: () => FfmpegStatus
  TRANSCODE_START: "transcode:start",   // invoke: (payload: TranscodeStartPayload) => TranscodeResult

  // 工具调用链路（4.1.1）
  TOOL_CALL: "tool:call",                       // main -> renderer: ToolCallEvent（phase: start | done）
  TOOL_APPROVAL_REQUEST: "tool:approval-request", // main -> renderer: ApprovalRequest
  TOOL_APPROVAL_RESPOND: "tool:approval-respond", // invoke: (callId: string, allowed: boolean) => { ok: boolean }

  // 语音引擎注册表（4.3）：只读投影，函数一律不出主进程
  VOICE_LIST_ENGINES: "voice:list-engines", // invoke: () => VoiceEngineSummary[]
  // 4.6：path 字段的「浏览」按钮。**只弹框、只返回路径，绝不写配置**（写不写由渲染层决定）
  VOICE_PICK_PATH: "voice:pick-path", // invoke: (VoicePathPickRequest) => string（取消返回 ""）

  // 天气（6.6.4）：在线数据源（Open-Meteo，免费无 key）。主进程只做取数不含状态，
  // 渲染侧拿到结果自己 patch env.weather（数据源判断留在渲染层，贴近 getState/patch 体系）
  WEATHER_FETCH_ONLINE: "weather:fetch-online", // invoke: ({lat,lon}) => {ok:true;text;temp} | {ok:false;error}

  // MCP 服务器生命周期（4.2）
  MCP_LIST: "mcp:list", // invoke: () => McpServerView[]
  MCP_ADD: "mcp:add", // invoke: (input: McpServerInput) => McpMutationResult
  MCP_REMOVE: "mcp:remove", // invoke: (id: string) => McpMutationResult
  MCP_SET_ENABLED: "mcp:set-enabled", // invoke: (id: string, enabled: boolean) => McpMutationResult
  MCP_RECONNECT: "mcp:reconnect", // invoke: (id: string) => McpMutationResult

  // 长期记忆 + 人设（5.1.2）：独立文件存储，不进 config.json（P22 注 2）
  LONG_TERM_GET: "memory:long-term-get", // invoke: () => LongTermMemory
  LONG_TERM_SET: "memory:long-term-set", // invoke: (input: LongTermMemory) => LongTermMemory（消毒后回读）
  // 9.x persona v2：分层人设 —— part ∈ "main" | "soul" | "canon"（缺省 = main，主进程 isPersonaPart 白名单二次校验）
  PERSONA_GET: "persona:get",            // invoke: (part?) => string
  PERSONA_SET: "persona:set",            // invoke: (text: string, part?) => string（返回真正落盘的正文）
  // 6.6.2：人设文件「系统编辑器打开」—— 路径主进程自解析，渲染层只传白名单 part（9.x），不传路径，不开任意路径口子
  PERSONA_OPEN: "persona:open",          // invoke: (part?) => { ok: boolean; error?: string }（shell.openPath）
  PERSONA_REVEAL: "persona:reveal",      // invoke: (part?) => { ok: boolean }（shell.showItemInFolder）

  // 用户档案（5.1.6）：user.md 常驻块 —— 自动段只读（重写器写），渲染侧只许改手写段
  USER_PROFILE_GET: "user-profile:get",  // invoke: () => UserProfileView
  USER_PROFILE_SET: "user-profile:set",  // invoke: (manual: string) => UserProfileView（写后回读）

  // 睡前整理（5.1.5）：判定与落盘都在主进程（5.1.4），渲染侧只调度 + 展示投影
  MEMORY_TIDY_NOW: "memory:tidy-now",           // invoke: () => TidyReportView（手动；**绕过 shouldTidy**）
  MEMORY_TIDY_STATE: "memory:tidy-state",       // invoke: () => TidyStatusView
  MEMORY_TIDY_ROLLBACK: "memory:tidy-rollback", // invoke: (backupName: string) => { ok: boolean; reason: string }

  // 好感度（5.6.1）：真相在主进程 userData/relationship/，渲染层只拿投影
  RELATIONSHIP_GET: "relationship:get",     // invoke: () => RelationshipView
  RELATIONSHIP_PATCH: "relationship:patch", // invoke: (RelationshipPatch) => RelationshipView（写后回读）

  // 剧情系统（5.7.2）：章节 / 分支 / 存档三张表 + 触发判定。真相在主进程，渲染层只拿投影
  STORY_LIST_CHAPTERS: "story:list-chapters",   // invoke: () => Chapter[]（按 order 升序）
  STORY_UPSERT_CHAPTER: "story:upsert-chapter", // invoke: ({ chapter, branches? }) => Chapter[]
  STORY_EVALUATE: "story:evaluate",             // invoke: (extras?: StoryContextExtras) => Chapter[]（命中的章节）
  STORY_LIST_SAVES: "story:list-saves",         // invoke: () => StorySave[]（按 at 降序）
  STORY_CREATE_SAVE: "story:create-save",       // invoke: ({ chapterId, nodeId, messageTreeRef }) => StorySave | null
  STORY_DELETE_SAVE: "story:delete-save",       // invoke: (id: string) => boolean
  STORY_GENERATE: "story:generate",             // invoke: (req: StoryGenerateRequest) => StoryGenerateResult（永不抛错）

  // 影像线：截图 / 录屏 / 直播（2.7b/c/d）
  MEDIA_LIST_SOURCES: "media:list-sources",         // invoke: () => CaptureSourceView[]
  MEDIA_FFMPEG_STATUS: "media:ffmpeg-status",       // invoke: () => FfmpegStatus
  MEDIA_SET_FFMPEG_PATH: "media:set-ffmpeg-path",   // invoke: () => FfmpegStatus（弹文件选择框，选中即存进 config）
  MEDIA_LIST_AUDIO_DEVICES: "media:list-audio-devices", // invoke: () => AudioDeviceView[]

  CAPTURE_TAKE: "capture:take",                     // invoke: (CaptureRequest) => CaptureShot
  CAPTURE_LIBRARY: "capture:library",               // invoke: () => CaptureLibrary
  CAPTURE_REVEAL: "capture:reveal",                 // invoke: (path: string) => void（资源管理器里定位）
  CAPTURE_AREA_SUBMIT: "capture:area-submit",       // invoke: (AreaSelection) => void（遮罩窗用）
  CAPTURE_AREA_CANCEL: "capture:area-cancel",       // invoke: () => void（遮罩窗用）
  CAPTURE_OVERLAY_IMAGE: "capture:overlay-image",   // main -> 遮罩窗: dataURL
  CAPTURE_READ_IMAGE: "capture:read-image",         // invoke: (path) => dataURL（file:// 被拦，主进程代读 —— 指令 §3.4 注备选）
  CAPTURE_DELETE: "capture:delete",                 // invoke: (path) => void（应用内删除；路径须在归档目录内）
  CAPTURE_PICK_DIR: "capture:pick-dir",             // invoke: () => CaptureLibrary（弹目录框，选中即存 config.media.captureDir）

  RECORD_SELECT_SOURCE: "record:select-source",     // invoke: (sourceId: string) => void（先选源，再 getDisplayMedia）
  RECORD_SAVE: "record:save",                       // invoke: (RecordSaveRequest) => RecordClip
  RECORD_LIST: "record:list",                       // invoke: () => RecordClip[]
  RECORD_REVEAL: "record:reveal",                   // invoke: (path: string) => void
  RECORD_PICK_DIR: "record:pick-dir",               // invoke: () => string（弹目录框，选中即存 config.media.recordDir；取消返回 ""）

  LIVE_TEST: "live:test",                           // invoke: (LiveStartRequest) => LiveResult
  LIVE_START: "live:start",                         // invoke: (LiveStartRequest) => LiveResult
  LIVE_STOP: "live:stop",                           // invoke: () => LiveResult
  LIVE_CLEAR_LOGS: "live:clear-logs",               // invoke: () => number（删除 ffmpeg/logs 下已关闭的 .log，返回删除数）
  LIVE_EVENT: "live:event",                         // main -> renderer: LiveEvent

  // 通话（4.9）：状态机在主进程，渲染进程只做采集 / 播放 / 显示
  // ⚠️ 设计约束（防后人加通道）：
  // ① **不加 call:turn-end**：轮次判定在主进程（VAD 在主进程喂），渲染端只负责"把帧送过来"。
  //    多一条反向通道 = 多一个"两个真值源打架"的坑。
  // ② **播放完成必须回推**（CALL_PLAYBACK_DONE）：播放队列在渲染端，主进程不知道队列何时排空
  //    —— 只能由渲染端回报。
  CALL_START: "call:start",                 // invoke: (CallStartRequest) => CallStartResult（挑 ASR 引擎 + 建会话）
  CALL_FRAME: "call:frame",                 // send: (ArrayBuffer) => void（渲染 → 主：100ms 16k s16le PCM）
  CALL_PLAYBACK_DONE: "call:playback-done", // send: () => void（渲染播放队列排空 → 主进程 SPEAKING → LISTENING）
  CALL_HANGUP: "call:hangup",               // send: () => void
  CALL_STATE: "call:state",                 // main -> renderer: CallStateEvent
  CALL_ASR: "call:asr",                     // main -> renderer: CallAsrEvent
  CALL_TTS: "call:tts",                     // main -> renderer: CallTtsEvent
  CALL_ERROR: "call:error",                 // main -> renderer: string（人话，直接显示）
  CALL_TRANSCRIBE: "call:transcribe",       // invoke: (ArrayBuffer) => CallTranscribeResult（6.2 语音转文字：整段 16k s16le PCM → 文本，不走通话状态机）

  // 悬浮球（5.9.1）：球窗口独立，渲染端只做「显示 / 拖拽 / 穿透」，窗口几何全在主进程
  ORB_STATE_GET: "orb:state-get",                 // invoke: () => OrbView（{ avatar, x, y, expand }）
  ORB_AVATAR: "orb:avatar",                       // main -> orb: string（dataURL；"" = 默认图）
  ORB_DRAG: "orb:drag",                           // send: (p: { phase: "move" | "end"; x: number; y: number }) => void
  ORB_SET_PASSTHROUGH: "orb:set-passthrough",     // send: (on: boolean) => void

  // 悬浮球（A 重做）：面板开合归渲染端自持（CSS scale），主进程只保留几何投影 + 细条滑回
  ORB_UNSNAP: "orb:unsnap",                       // send: () => void（细条悬停 → 滑回球）
  ORB_STATE: "orb:state",                         // main -> orb: OrbExpandState（每次几何变化后推）
  ORB_POINTER_LEFT: "orb:pointer-left",           // main -> orb: undefined（光标轮询判定离开窗口；透明窗的 leave 事件不可靠）

  // 外部消息通道（8.8）：通道抽象 + 独立会话绑定。真相全在主进程，渲染层只拿状态投影
  IM_LIST_CHANNELS: "im:list-channels",           // invoke: () => ImChannelView[]（已注册通道 + 状态 + 绑定会话）
  IM_SET_ENABLED: "im:set-enabled",               // invoke: (id: string, enabled: boolean) => ImChannelView[]（改了真启停 + 落盘）
  IM_SET_CONFIG: "im:set-config",                 // invoke: (id: string, config: Record<string,string>) => ImChannelView[]（8.9 凭证写入；白名单消毒在主进程，运行中的通道会重启）
  IM_TEST_CONNECTION: "im:test-connection",       // invoke: ({channelId,config}) => {ok,message}（8.9 连接测试：草稿 + 已落盘值合并后试连，绝不抛）
  IM_INJECT: "im:inject",                         // invoke: ({channelId,target,text}) => {ok,reason?}（假适配器自检注入；真实通道不支持）
  IM_CLEAR_SESSION: "im:clear-session",           // invoke: (id: string) => ImChannelView[]（8.10.2 清空通道上下文：删会话文件 + 解绑 sessionId）
  // 8.10 微信（iLink）扫码登录：只有微信走扫码，故三条专用通道挂在 im 下（其余复用上面 5 条通用 IM IPC）
  IM_WEIXIN_QR_START: "im:weixin-qr-start",       // invoke: () => WeixinQrStartView（取二维码；主进程渲染成 dataURL）
  IM_WEIXIN_QR_POLL: "im:weixin-qr-poll",         // invoke: () => WeixinQrPollView（约 2s 轮询一次；成功后凭证已写入 config）
  IM_WEIXIN_QR_CANCEL: "im:weixin-qr-cancel",     // invoke: () => {ok:boolean}（放弃本次扫码；幂等）

  // 技能系统（8.7）：技能目录 userData/skills/<目录>/SKILL.md，扫描结果缓存在主进程
  SKILLS_LIST: "skills:list",                     // invoke: () => SkillSummary[]（含未启用；打开技能组只读缓存）
  SKILLS_SET_ENABLED: "skills:set-enabled",       // invoke: (id, enabled) => SkillSummary[]（写 config.ui 的 skill.<id>.enabled）
  SKILLS_REFRESH: "skills:refresh",               // invoke: () => SkillSummary[]（重扫目录，首次会播种内置示例技能）
  SKILLS_OPEN_DIR: "skills:open-dir",             // invoke: () => {ok,error?}（shell.openPath，路径主进程自解析）

  // 工具箱 · 工具独立窗口（8.7.7）：主窗口渲染层点卡片 → 弹/聚焦该工具的独立子窗口
  TOOLBOX_OPEN: "toolbox:open",                   // send: (payload: ToolboxOpenPayload) => void（主进程按 id 创建/聚焦 tool 子窗）

  // 音乐 · 网易云（9.x）：主进程 MusicService 是唯一真相（MCP 后端 + 账号态 + 播放分发），
  // 渲染层只拿快照和结果投影；登录用扫码三段式（begin → 渲染层轮询 status → cancel/logout）
  MUSIC_GET_STATUS: "music:get-status",           // invoke: () => 音乐状态快照（backend/account/player/flow/profile）
  MUSIC_BEGIN_LOGIN: "music:begin-login",         // invoke: () => { sessionId, qr }（生成扫码登录会话；qr 供渲染层画码）
  MUSIC_CANCEL_LOGIN: "music:cancel-login",       // invoke: (sessionId) => void（放弃进行中的扫码会话，幂等）
  MUSIC_LOGOUT: "music:logout",                   // invoke: () => void（清登录态 + 本地 cookie）
  MUSIC_GET_DAILY: "music:get-daily",             // invoke: () => 每日推荐卡片（normalize 后，最多 5 首）
  MUSIC_SEARCH: "music:search",                   // invoke: (keyword) => 搜索结果卡片（normalize 后，最多 5 首）
  MUSIC_PRESENT_TRACKS: "music:present-tracks",   // invoke: (tracks) => 展示音乐卡片并广播 MUSIC_CARD
  MUSIC_PLAY_TRACK: "music:play-track",           // invoke: (trackId) => 播放分发结果（唤起网易云客户端 / 网页兜底）
  MUSIC_PLAY_PLAYLIST: "music:play-playlist",     // invoke: (playlistId) => 播放分发结果（同上，整张歌单）
  MUSIC_DETECT_PLAYER: "music:detect-player",     // invoke: () => 客户端探测结果（orpheus:// 是否可用）
  MUSIC_STATE_CHANGED: "music:state-changed",     // main -> renderer: 状态快照（登录进度 / 后端生命周期变化时推）
  MUSIC_CARD: "music:card",                       // main -> renderer: MusicCardData（点歌卡片推送到聊天流）
};
