// 步骤 2.11 · 设置视图 + 关于视图
// 素材：原型 settings.html —— 设置卡 HTML L219-345、关于卡 HTML L346-396、脚本 L475-534
// 通用控件（单选段组 / 开关 / 三色标签 / 金按钮 / 次按钮 / 全局 input / select）由 2.9 落在 app.css，本文件不重复定义
// 图标全部内联 SVG（禁表情字符 / 禁外部资源）；文案与默认值集中在下面「数据层」一节
// 结构决策（指令包 §0.1）：设置 / 关于拆两个视图、共用一个模块；
// 用户 2026-09-26 要求「后面还得改，记得留地方」→ 扩展只动数据层（加组 / 加项 / 改默认值），渲染与交互零改动

// 转 module：避免 tsc 把本文件当全局脚本，与其它顶层执行文件撞名（2.9 教训）
export {};

// 3.7：模型卡读写真实配置（config:get/set）+ 预设与连接测试走 IPC
// 8.8：+ImChannelView（消息通道状态总览投影，im:list-channels 的返回形状）
// 8.9：+IM_CHANNEL_FIELDS（飞书 / 钉钉的凭证字段规格 —— 表单按它渲染，键名不在这里重写一遍）
// 8.10：+WeixinQrPollView（微信扫码轮询的返回形状）
import { IM_CHANNEL_FIELDS, type AppConfig, type ImChannelView, type WeixinQrPollView } from "../../shared/config";
import type { DeepPartial } from "../../shared/types";
import type { PresetSummary, TestConnectionResult } from "../../shared/provider/types";
import { patch } from "../state/app-state";
// 6.x：设置页 select 统一接管为自绘下拉（样式同聊天模型选择器，见下方启动区的 observer 接管说明）
import { beautifyDropdown } from "../studio/dropdown";
// 9.x：音乐组（网易云连接 + 听歌，独立渲染不走 SETTINGS_GROUPS，同 MCP 卡口径）
import { initMusicCard, musicCardHtml } from "./music-card";
// 4.6：语音卡 —— 引擎列表与 configSchema 全来自 IPC，表单零引擎专属分支（P4）
import type {
  ConfigField, VoiceConfigValues, VoiceEngineSummary, VoiceKind,
} from "../../shared/voice/types";
// 4.2：MCP 服务器卡
import {
  MCP_TRANSPORTS, MCP_TRANSPORT_LABEL,
  type McpMutationResult, type McpServerInput, type McpServerView,
} from "../../shared/mcp";
import { RISK_LEVELS, RISK_LEVEL_LABEL, ACCESS_LEVEL_LABEL } from "../../shared/tools";
import type { PermissionSnapshot, ToolAccessLevel, ToolPolicy } from "../../shared/tools";
// 8.7：技能组（技能目录投影 —— skills:list 的返回形状）
import type { SkillSummary } from "../../shared/skill";
// 8.4：操作审计（隐私组审计卡）
import type { AuditEntry, AuditView } from "../../shared/audit";
// 5.1.2：长期记忆 + 人设（独立文件读写，不进 config.json）；5.1.5：+整理状态投影
import {
  LONG_TERM_LIMITS,
  type LongTermEntry,
  type LongTermMemory,
  type TidyStatusView,
} from "../../shared/memory";

// ---------- 内联图标（lucide 原始路径，stroke-width 统一 1.6，与项目其余图标一致） ----------
const ICON = {
  // 卡片标题（16px）
  plug: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/></svg>`,
  palette: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>`,
  handshake: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/><path d="M12 5 9.04 7.96a2.17 2.17 0 0 0 0 3.08c.82.82 2.13.85 3 .07l2.07-1.9a2.82 2.82 0 0 1 3.79 0l2.96 2.66"/><path d="m18 15-2-2"/><path d="m15 18-2-2"/></svg>`,
  shield: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>`,
  // 2026-09-29：开源致谢卡折叠箭头（16px，lucide chevron-down；展开时旋转 180°）
  chevronDown: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`,
  // 按钮内（14px）
  refresh: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>`,
  scroll: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/></svg>`,
  // 引擎卡标题（14px）
  terminal: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>`,
  tree: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 19a4 4 0 0 1-2.24-7.32A3.5 3.5 0 0 1 9 6.03V6a3 3 0 1 1 6 0v.04a3.5 3.5 0 0 1 3.24 5.65A4 4 0 0 1 16 19Z"/><path d="M12 19v3"/></svg>`,
  archive: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>`,
  // 4.2 MCP 卡：卡标题（16px）/「添加并连接」按钮（14px）
  server: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><path d="M6 6h.01"/><path d="M6 18h.01"/></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>`,
  // 4.6 语音卡：卡标题（16px，与其余卡片标题图标同规格）
  mic: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></svg>`,
  // 5.1.2 长期记忆 / 人设提示词卡：卡标题（16px，lucide database / user）
  database: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/></svg>`,
  user: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  // 6.8 关于页升级：联系与反馈卡标题（16px），运行环境区块头（14px）与「打开」按钮（14px）
  lock: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  mail: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>`,
  monitor: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/></svg>`,
  folderOpen: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>`,
  // 6.6.3 时间与天气：卡标题（16px，lucide cloud-sun）
  cloudSun: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/></svg>`,
  // 8.1 视觉模型卡：卡标题（16px，lucide image）
  image: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>`,
  // 8.8 消息通道卡：卡标题（16px，lucide messages-square）/「送入」按钮（14px，lucide send）
  messages: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>`,
  send: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>`,
  // 8.7 技能卡：卡标题（16px，lucide sparkles）
  sparkles: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>`,
} as const;

// ============================================================
// 数据层：3 组设置卡的结构化描述
// ------------------------------------------------------------
// · 2.11 的设计意图「接真实配置只动数据层，渲染与交互零改动」已由 5.1.1 兑现：
//   每个控件带 key（= config.ui 落盘键，键表唯一权威见 5.1.1 指令 §3），
//   `def` 语义 = 「当前生效值」—— 启动时被 applyUiToGroups 用实读值替换，
//   恢复默认时被 GROUP_DEFAULTS 的默认值替换；渲染函数只读 def，不认识配置层。
//   ⚠️ 用户 2026-09-26：设置项后面还要改 —— 新增设置组/设置项、调整分组都只加在这里。
// · 数据来源两条路（用户 2026-09-26 明确）：
//     ① 已开源的工具 / 库
//     ② 从 内部参考项目 搬现成实现 —— **只读复制，严禁改动该目录任何文件**
//        （搬运照项目惯例：改名 → 瘦身 → 按新结构调整 → 注释标注来源）
//   ⚠️ 关于卡版本号不写死：由 getVersion() 异步回填（先渲染占位再回填，有时序坑，见 5.2）
// ============================================================

/** 单选段组（.seg，选中项用 data-on="true"）；key = config.ui 的落盘键（5.1.1） */
interface SegsControl { kind: "segs"; key: string; label: string; options: string[]; def: number; }
/** 滑块：labels 给了就把数字换成文字（金色光点密度 0/1/2 → 低/中/高），否则用「值 + unit」 */
interface RangeControl { kind: "range"; key: string; label: string; min: number; max: number; def: number; unit: string; labels?: string[]; }
/** 单行文本 */
interface TextControl { kind: "text"; key: string; label: string; def: string; }
/** 下拉（def 是选项下标） */
interface SelectControl { kind: "select"; key: string; label: string; options: string[]; def: number; }
/** 一列开关（原型里每个 space-y-3 开关组）；每项 key = config.ui 的落盘键（5.1.1） */
interface SwitchesControl { kind: "switches"; items: Array<{ key: string; label: string; def: boolean }>; }
/** 强调色：5 个预设色块 + 1 个自定义圆形色盘；def 是预设下标（0-4），自定义色存 custom */
interface SwatchesControl {
  kind: "swatches";
  key: string;
  label: string;
  /** 每套预设 = 完整的品牌强调令牌组（不能只换 --brand 单色，否则按钮/选中/光晕断层） */
  presets: Array<{ name: string; brand: string; bright: string; mid: string; soft: string; ink: string }>;
  /** 预设下标（落盘 = presets[def].name） */
  def: number;
  /** 自定义强调色（落盘 = hex 字符串，此时忽略 def） */
  custom?: string;
}
/** 圆角说明块；key 有值时渲染成 id="set-<key>-note"，供交互函数改文案 */
interface NoteControl { kind: "note"; key?: string; text: string; }
/** 一列堆叠（原型里同一格放多个控件的两处：陪伴方式右列 / 影像与隐私右列） */
interface StackControl { kind: "stack"; items: Control[]; }
type Control = SegsControl | RangeControl | TextControl | SelectControl | SwitchesControl | SwatchesControl | NoteControl | StackControl;

interface SettingsGroup { key: string; title: string; icon: keyof typeof ICON; items: Control[]; }

/** 「她对你的称呼」空值兜底（原型 `value.trim() || '旅行者'`） */
const CALL_FALLBACK = "旅行者";
/** 称呼 → 提示文案（原型 showCall()） */
const callNoteText = (name: string): string => `她会称呼你「${name}」。`;

/** 强调色预设（外观重设计 2026-09-29）：每套 = 完整品牌强调令牌组。
 *  落地规则：只改强调令牌（--brand 系列），绝不碰 --bg-page（背景由背景样式卡管）；
 *  中性预设（白/浅灰/深灰）配第二强调色兜底，避免浅绿底上隐形。
 *  色值全走低饱和柔和系，与浅绿背景同调（用户 2026-09-29 要求，撤掉高饱和对比色）。 */
const ACCENT_PRESETS: SwatchesControl["presets"] = [
  // 白：主强调配深绿描边/点亮，光晕用极浅白绿
  { name: "白", brand: "#3fbf95", bright: "#7ed0b0", mid: "#a9e7cd", soft: "#eef7f2", ink: "#128d6b" },
  // 浅绿：柔和主色，光晕最浅
  { name: "浅绿", brand: "#5bbd96", bright: "#7ed0b0", mid: "#a9e7cd", soft: "#d8f1e5", ink: "#2c926e" },
  // 深绿：现品牌主色，默认档
  { name: "深绿", brand: "#128d6b", bright: "#3fbf95", mid: "#7ed0b0", soft: "#a9e7cd", ink: "#0f5c45" },
  // 浅灰：中性低饱和，配深绿点亮
  { name: "浅灰", brand: "#7a8f88", bright: "#9db0aa", mid: "#b8c9c3", soft: "#e4ece8", ink: "#4a5a55" },
  // 深灰：中性清晰，配浅绿点亮
  { name: "深灰", brand: "#4a5a55", bright: "#6d807a", mid: "#93a49e", soft: "#cdd9d4", ink: "#2f3b36" },
];
/** 自定义强调色派生辅助：主色 → 全套令牌（提亮/压暗，保持色相） */
function deriveAccent(hex: string): SwatchesControl["presets"][number] {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mix = (t: number, w: number): number => Math.round(t + (255 - t) * w);
  const shade = (t: number, w: number): number => Math.round(t * (1 - w));
  return {
    name: "自定义",
    brand: `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`,
    bright: `#${((mix(r,.25) << 16) | (mix(g,.25) << 8) | mix(b,.25)).toString(16).padStart(6, "0")}`,
    mid: `#${((mix(r,.5) << 16) | (mix(g,.5) << 8) | mix(b,.5)).toString(16).padStart(6, "0")}`,
    soft: `#${((mix(r,.8) << 16) | (mix(g,.8) << 8) | mix(b,.8)).toString(16).padStart(6, "0")}`,
    ink: `#${((shade(r,.35) << 16) | (shade(g,.35) << 8) | shade(b,.35)).toString(16).padStart(6, "0")}`,
  };
}

/** 三组设置卡（原型 L220-332 的原文；选项顺序 = 界面顺序）。
 *  key = config.ui 落盘键（5.1.1 指令 §3 键表逐键照抄，不许自造/改键名）；
 *  segs/select 的 def 是下标，落盘要转 options[def]，读回来 indexOf 反查（见 applyUiToGroups） */
const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    key: "appearance",
    title: "外观",
    icon: "palette",
    // 外观重设计（2026-09-29）：空壳卡填实 —— 主题模式三档 / 强调色 / 背景样式。
    // 旧控件（anim / frost / orb / leaf / treeSilhouette / softGlow）已废弃不再回归；
    // 「恢复默认」统一走设置页整体 #settings-reset（resetUiToDefaults），外观卡不单独放。
    items: [
      { kind: "segs", key: "theme", label: "主题模式", options: ["跟随系统", "浅色", "深色"], def: 0 },
      { kind: "swatches", key: "accent", label: "强调色", presets: ACCENT_PRESETS, def: 1 },
      { kind: "select", key: "bgType", label: "背景样式", options: ["渐变", "纯色", "自定义图片"], def: 0 },
    ],
  },
  {
    key: "companion",
    title: "陪伴方式",
    icon: "handshake",
    items: [
      { kind: "text", key: "call", label: "她对你的称呼", def: CALL_FALLBACK },
      { kind: "select", key: "pace", label: "回复节奏", options: ["温柔缓慢（约 1.5 秒）", "自然（约 0.8 秒）", "轻快（约 0.3 秒）"], def: 0 },
      {
        kind: "switches",
        items: [
          // 6.6.1：「主动提醒委托时间」(remindTasks) 已删（全库仅此一处；GROUP_DEFAULTS 快照在其后，自动同步无残留）
          { key: "moodShift", label: "心情随对话内容变化", def: true },
          { key: "nightSoft", label: "深夜时降低语气强度", def: true },
          // 5.1.1 新增键：5.6（好感度语气注入）的消费开关，开关本体只在这里加一次
          { key: "affectionPrompt", label: "允许她按好感度调整语气", def: true },
        ],
      },
      {
        kind: "stack",
        items: [
          {
            kind: "switches",
            items: [
              { key: "memoryQuote", label: "允许她引用长期记忆", def: true },
              { key: "autoArchive", label: "对话结束后自动归档", def: false }, // ⚠️ 原型 L292 是关（清单误写成「开」）
            ],
          },
          { kind: "note", key: "call", text: callNoteText(CALL_FALLBACK) },
        ],
      },
    ],
  },
  {
    // 6.6.1：影像/隐私拆开 —— 本组 items（键不动）挂到导航「影像」下，卡题随之改为「影像」；
    // 「隐私」导航组改挂 ltCardHtml + userProfileCardHtml，与本组 items 不同源
    key: "privacy",
    title: "影像",
    icon: "shield",
    items: [
      {
        kind: "switches",
        items: [
          // 2026-09-29：「长期记忆本地加密」(memEncrypt) 迁出本组 —— 挂到隐私组「长期记忆」卡
          // （ltCardHtml + 模块态 memEncryptOn）；落盘键不变（config.ui.memEncrypt），旧配置零影响
          // 7.3：删除 captureArchive（截图自动归档到花园影像）—— 该功能已废弃；ui 是宽松 Record，
          // 旧 config.json 里残留的 ui.captureArchive 值不会被任何控件读取，无害
          { key: "liveMute", label: "直播时不显示桌面通知", def: true },
        ],
      },
      {
        kind: "stack",
        items: [
          // 5.1.1：键名照键表从占位 record-keep / memory-tidy 修正为 recordKeep / memoryTidy
          { kind: "select", key: "recordKeep", label: "录屏保留时长", options: ["保留 7 天", "保留 30 天", "永久保留"], def: 0 },
          { kind: "select", key: "memoryTidy", label: "记忆自动整理时间", options: ["每晚 22:00", "每晚 23:30", "仅手动整理"], def: 0 },
          { kind: "note", text: "所有数据都留在本机目录，不会上传到任何服务器。" },
        ],
      },
    ],
  },
];

/** 默认值快照（5.1.1 §5.2）：必须在任何 applyUiToGroups 覆盖之前拍 ——
 *  拍晚了快照会被实读值污染，「恢复默认」会恢复成上次的值。structuredClone 隔离引用 */
const GROUP_DEFAULTS = structuredClone(SETTINGS_GROUPS);

/** 关于卡（原型 L346-396）。版本号不再写死：由 getVersion() 异步回填（§4.1） */
const ABOUT = {
  title: "纳西妲",
  subLead: "版本",                            // 版本号前的前缀
  versionPrefix: "V",                        // getVersion()="0.1.0" → 界面显示 "V0.1.0"
  versionPending: "读取中",                   // IPC 未回来时的占位文本
  // 6.8：statusIdle 换中性文案（原「当前已是最新版本」在从未发起过检查时属误导）；
  // 检查更新：2026-09-30 上线后改为跳 GitHub Releases（外链转系统浏览器），工程无 checkUpdate 实现
  statusIdle: "当前为本地运行版本，一切功能开箱即用。",
  statusCheckOpened: "已打开 GitHub Releases 页 —— 低维护项目尚未开放自动更新。",
  statusDataDirUnavailable: "数据目录打开入口尚未接入，将在后续版本提供。",
  // 6.8：运行环境区块（吸收设计稿 §运行环境，配色走现有令牌）。
  // 「数据目录」无 openDataDir 桥（全仓已确认），按钮只做占位提示（铁律 6）
  runtime: {
    title: "运行环境",
    items: [
      { label: "运行方式", value: "本地桌面端，完全离线可用" },
      { label: "支持平台", value: "Windows 10 / 11（64 位）" },
      { label: "数据目录", value: "随应用存放于本机", button: true },
    ] as Array<{ label: string; value: string; id?: string; button?: boolean }>,
  },
};

/** 非官方同人声明 */
const FAN_CARD_TITLE = "非官方同人声明";
const FAN_NOTICE: string[] = [
  "本项目为非商业同人作品，与米哈游 / HoYoverse 无任何隶属或合作关系。",
  "角色名称、角色形象、Live2D 模型、美术与音声资产等知识产权归原权利方所有，不在本项目引用的开源代码许可（MIT）范围内。",
  "本项目仅供学习与技术交流，不得用于任何商业用途。",
  "项目内美术 / 音频素材若涉及第三方权利，以原权利方声明为准。",
];

/** 开源致谢（原「开源许可清单」改名；法务义务：保留版权声明 + 可查链接，地址一律纯文本不外链 —— 坑 4）。
 *  条目来源 2026-09-29 盘点：package.json 直接依赖（去 @types 类型包）+ 内嵌字体/图标 + 架构参考项目，
 *  license / 仓库 URL 与 node_modules 内各包 package.json 的 license / repository 字段一致 */
interface LicenseEntry { name: string; license: string; url: string; }
const LICENSE_CARD_TITLE = "开源致谢";
const LICENSES: LicenseEntry[] = [
  // 框架与构建
  { name: "Electron", license: "MIT", url: "https://github.com/electron/electron" },
  { name: "Vite", license: "MIT", url: "https://github.com/vitejs/vite" },
  { name: "TypeScript", license: "Apache-2.0", url: "https://github.com/microsoft/TypeScript" },
  { name: "Electron Builder", license: "MIT", url: "https://github.com/electron-userland/electron-builder" },
  { name: "Vitest", license: "MIT", url: "https://github.com/vitest-dev/vitest" },
  { name: "concurrently", license: "MIT", url: "https://github.com/open-cli-tools/concurrently" },
  { name: "cross-env", license: "MIT", url: "https://github.com/kentcdodds/cross-env" },
  // 运行时依赖（按包名字母序）
  { name: "@ag-ui/client", license: "MIT", url: "https://github.com/ag-ui-protocol/ag-ui" },
  { name: "@ag-ui/core", license: "MIT", url: "https://github.com/ag-ui-protocol/ag-ui" },
  { name: "@lancedb/lancedb", license: "Apache-2.0", url: "https://github.com/lancedb/lancedb" },
  { name: "@langchain/core", license: "MIT", url: "https://github.com/langchain-ai/langchainjs" },
  { name: "@langchain/langgraph", license: "MIT", url: "https://github.com/langchain-ai/langgraphjs" },
  { name: "@larksuiteoapi/node-sdk", license: "MIT", url: "https://github.com/larksuite/node-sdk" },
  { name: "@mdit/plugin-katex", license: "MIT", url: "https://github.com/mdit-plugins/mdit-plugins" },
  { name: "@modelcontextprotocol/sdk", license: "MIT", url: "https://github.com/modelcontextprotocol/typescript-sdk" },
  { name: "@node-rs/jieba", license: "MIT", url: "https://github.com/napi-rs/node-rs" },
  { name: "@nut-tree-fork/nut-js", license: "Apache-2.0", url: "https://github.com/nut-tree/nut.js" },
  { name: "@xenova/transformers", license: "Apache-2.0", url: "https://github.com/xenova/transformers.js" },
  { name: "chart.js", license: "MIT", url: "https://github.com/chartjs/Chart.js" },
  { name: "dingtalk-stream", license: "MIT", url: "https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs" },
  { name: "docx", license: "MIT", url: "https://github.com/dolanmiu/docx" },
  { name: "dompurify", license: "MPL-2.0 OR Apache-2.0", url: "https://github.com/cure53/DOMPurify" },
  { name: "exceljs", license: "MIT", url: "https://github.com/exceljs/exceljs" },
  { name: "gray-matter", license: "MIT", url: "https://github.com/jonschlinkert/gray-matter" },
  { name: "js-yaml", license: "MIT", url: "https://github.com/nodeca/js-yaml" },
  { name: "katex", license: "MIT", url: "https://github.com/KaTeX/KaTeX" },
  { name: "llamaindex", license: "MIT", url: "https://github.com/run-llama/LlamaIndexTS" },
  { name: "markdown-it", license: "MIT", url: "https://github.com/markdown-it/markdown-it" },
  { name: "nodemailer", license: "MIT-0", url: "https://github.com/nodemailer/nodemailer" },
  { name: "pdf-lib", license: "MIT", url: "https://github.com/Hopding/pdf-lib" },
  { name: "pdfkit", license: "MIT", url: "https://github.com/foliojs/pdfkit" },
  { name: "playwright", license: "Apache-2.0", url: "https://github.com/microsoft/playwright" },
  { name: "qr-image", license: "MIT", url: "https://github.com/alexeyten/qr-image" },
  { name: "qrcode", license: "MIT", url: "https://github.com/soldair/node-qrcode" },
  { name: "rss-parser", license: "MIT", url: "https://github.com/bobby-brennan/rss-parser" },
  { name: "rxjs", license: "Apache-2.0", url: "https://github.com/reactivex/rxjs" },
  { name: "sherpa-onnx-node", license: "Apache-2.0", url: "https://github.com/csukuangfj/sherpa-onnx" },
  { name: "shiki", license: "MIT", url: "https://github.com/shikijs/shiki" },
  { name: "silk-wasm", license: "MIT", url: "https://github.com/idranme/silk-wasm" },
  { name: "turndown", license: "MIT", url: "https://github.com/mixmark-io/turndown" },
  { name: "wink-bm25-text-search", license: "MIT", url: "https://github.com/winkjs/wink-bm25-text-search" },
  { name: "ws", license: "MIT", url: "https://github.com/websockets/ws" },
  // 内嵌字体与图标
  { name: "Lucide", license: "ISC", url: "https://github.com/lucide-icons/lucide" },
  { name: "思源宋体 Source Han Serif", license: "SIL OFL 1.1", url: "https://github.com/adobe-fonts/source-han-serif" },
  // 本地语音服务（通话窗 / 语音回复链路：本地部署的 TTS 引擎；ASR 的 sherpa-onnx 在运行时依赖组）
  { name: "GPT-SoVITS", license: "MIT", url: "https://github.com/RVC-Boss/GPT-SoVITS" },
  // 架构参考项目
  { name: "Cyrene-Agent", license: "MIT", url: "https://github.com/Playa-0v0/Cyrene-Agent" },
  { name: "DeepSeek Orb", license: "MIT", url: "https://github.com/mini-yifan/deepseek-harness-orb" },
];

/** 联系与反馈（9.29：仓库已建 —— nebula-silent/nahida-agent，MIT；href 渲染为可点链接，
 *  主进程 setWindowOpenHandler 统一丢系统浏览器，不在 app 内开新窗） */
const CONTACT_CARD_TITLE = "联系与反馈";
const CONTACT_LINES: Array<{ label: string; value: string; href?: string }> = [
  { label: "问题反馈", value: "GitHub Issues（点击前往）", href: "https://github.com/nebula-silent/nahida-agent/issues" },
  { label: "开源仓库", value: "github.com/nebula-silent/nahida-agent", href: "https://github.com/nebula-silent/nahida-agent" },
  { label: "GitHub 主页", value: "github.com/nebula-silent", href: "https://github.com/nebula-silent" },
];
// ==================== 数据层结束（以上为可整体替换的占位数据） ====================

// ---------- 渲染（只读数据层，不含任何业务值） ----------
/** 转义：本步的值都来自数据层，但「称呼」等后续可能来自用户配置，统一转义防注入 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 滑块取值文本：有 labels 取文字，否则「值 + unit」 */
function rangeText(c: RangeControl, value: number): string {
  return c.labels ? c.labels[value] ?? "" : `${value}${c.unit}`;
}

function controlHtml(c: Control): string {
  // 5.1.1：可交互控件统一带 data-ui-key（= config.ui 落盘键），交互函数按它定位，不从文字反推
  switch (c.kind) {
    case "segs":
      return `<div class="settings-item">
        <p class="settings-item__label">${esc(c.label)}</p>
        <div class="settings-item__segs" data-ui-key="${esc(c.key)}">${c.options
          .map((o, i) => `<button type="button" class="seg" data-on="${i === c.def}">${esc(o)}</button>`)
          .join("")}</div>
      </div>`;

    case "range":
      return `<label class="settings-item">
        <span class="settings-item__label">${esc(c.label)}<span class="settings-item__value" id="set-${c.key}-value">${esc(rangeText(c, c.def))}</span></span>
        <input type="range" id="set-${c.key}" data-ui-key="${esc(c.key)}" min="${c.min}" max="${c.max}" value="${c.def}" data-unit="${esc(c.unit)}"${c.labels ? ` data-labels="${esc(c.labels.join(","))}"` : ""} />
      </label>`;

    case "text":
      return `<label class="settings-item">
        <span class="settings-item__label">${esc(c.label)}</span>
        <input type="text" id="set-${c.key}" data-ui-key="${esc(c.key)}" value="${esc(c.def)}" />
      </label>`;

    case "select": {
      // 8.7.22：背景样式=自定义图片时的选图行（渲染时按当前值定显隐；change 委托里切换）
      const bgRow =
        c.key === "bgType"
          ? `<div class="settings-item__bgimage" id="bgimage-row"${c.options[c.def] === "自定义图片" ? "" : " hidden"}>
              <button type="button" class="btn-soft" id="pick-bg-image">选择图片</button>
              <span class="bgimage-path" id="bgimage-path">${esc(bgImagePath || "未选择图片")}</span>
            </div>`
          : "";
      // 8.7.22 修复：select 与选图行必须包在同一格 —— settings-grid 是两列，兄弟节点会被拆到相邻列，
      // 按钮浮在下拉右侧偏上（align-items: start）。包进同一 .settings-item 后按钮自然落在下拉下方。
      return `<div class="settings-item">
        <span class="settings-item__label">${esc(c.label)}</span>
        <select id="set-${c.key}" data-ui-key="${esc(c.key)}">${c.options
          .map((o, i) => `<option${i === c.def ? " selected" : ""}>${esc(o)}</option>`)
          .join("")}</select>
        ${bgRow}
      </div>`;
    }

    case "switches":
      return `<div class="settings-item__stack">${c.items
        .map(
          (it) => `<label class="settings-switch">${esc(it.label)}<button type="button" class="switch" data-ui-key="${esc(it.key)}" data-on="${it.def}" role="switch" aria-checked="${it.def}" aria-label="${esc(it.label)}"><span></span></button></label>`
        )
        .join("")}</div>`;

    case "swatches": {
      // 5 预设色块 + 1 自定义圆形色盘；选中态 = 预设高亮 / 色盘显示当前自定义色
      const activeIdx = c.custom === undefined ? c.def : -1;
      const swatches = c.presets
        .map(
          (p, i) =>
            `<button type="button" class="swatch" data-accent="${esc(p.name)}" data-on="${i === activeIdx}" title="${esc(p.name)}" style="--sw:${esc(p.brand)}" aria-label="${esc(p.name)}"></button>`
        )
        .join("");
      const customVal = c.custom ?? "#5b8def";
      return `<div class="settings-item">
        <p class="settings-item__label">${esc(c.label)}</p>
        <div class="settings-item__swatches" data-ui-key="${esc(c.key)}">
          ${swatches}
          <label class="swatch-picker" title="自定义颜色" aria-label="自定义颜色">
            <input type="color" class="swatch-custom" value="${esc(customVal)}" data-ui-key="${esc(c.key)}" />
          </label>
        </div>
      </div>`;
    }

    case "note":
      return `<p class="settings-note"${c.key ? ` id="set-${c.key}-note"` : ""}>${esc(c.text)}</p>`;

    case "stack":
      return `<div class="settings-item__stack">${c.items.map(controlHtml).join("")}</div>`;
  }
}

function cardHtml(g: SettingsGroup): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON[g.icon]}${esc(g.title)}</h3>
    <div class="settings-grid">${g.items.map(controlHtml).join("")}</div>
  </section>`;
}

// ============================================================
// 5.1.1 config.ui 链路：读（applyUiToGroups）/ 写（防抖 config:set）/ 视觉生效（applyVisual）/ 恢复默认
// 读写全走既有 config:get / config:set，不新增 IPC、不新增配置字段（§2 硬约束）。
// 键表唯一权威 = 5.1.1 指令 §3；ui 里的未知键直接忽略（遍历的是 SETTINGS_GROUPS，不是 ui）。
// ============================================================

type UiValue = string | number | boolean;

/** 视觉项取值域（applyVisual 的校验基准；与 SETTINGS_GROUPS 对应 segs 的 options 一致）
 *  外观重设计 2026-09-29：主题三档（跟随系统/浅色/深色）；旧晨光/正午/黄昏/林间雨已废弃 */
const THEME_VALUES = ["跟随系统", "浅色", "深色"] as const;
/** 背景样式取值域（bgType select 的 options 原文，与 SETTINGS_GROUPS 一致） */
const BGTYPE_VALUES = ["渐变", "纯色", "自定义图片"] as const;

/** 数字夹紧（照 readVoiceField :787 先例）：非有限数字 → 默认，否则夹进 [min, max] */
function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** 遍历一组卡（递归进 stack），把每个可落盘键的「当前 def」抽成 ui map；
 *  segs/select 取 options[def] 选项原文（§5.6：orb 这类带 labels 的滑块落盘的仍是数字，见 range 分支） */
function collectUiValues(groups: SettingsGroup[]): Record<string, UiValue> {
  const out: Record<string, UiValue> = {};
  const walk = (items: Control[]): void => {
    for (const c of items) {
      switch (c.kind) {
        case "segs":
        case "select": out[c.key] = c.options[c.def] ?? ""; break;
        case "range":
        case "text": out[c.key] = c.def; break;
        case "switches": for (const it of c.items) out[it.key] = it.def; break;
        case "swatches": out[c.key] = c.custom ?? c.presets[c.def]?.name ?? ""; break;
        case "stack": walk(c.items); break;
        case "note": break;
      }
    }
  };
  for (const g of groups) walk(g.items);
  return out;
}

/** 把 ui 实读值写回数据层（只动 def —— 渲染函数只读 def，所以渲染侧零改动）。
 *  键在 ui 里缺失 → 保持现状不动（部分 patch 不许把别的键打回默认）；
 *  键在但校验不过 → 写默认值（取 GROUP_DEFAULTS 对应项，§4.3 / §5.2）；
 *  stack 里的嵌套控件同样要走到（§5.3），否则右列 4 个开关漏读。 */
function applyUiToGroups(ui: Record<string, UiValue>): void {
  const walk = (items: Control[], defs: Control[]): void => {
    for (let i = 0; i < items.length; i++) {
      const c = items[i];
      const d = defs[i];
      switch (c.kind) {
        case "segs":
        case "select": {
          const v = ui[c.key];
          if (v === undefined) break;
          c.def = typeof v === "string" && c.options.includes(v)
            ? c.options.indexOf(v)
            : (d as SegsControl).def;
          break;
        }
        case "range": {
          const v = ui[c.key];
          if (v === undefined) break;
          c.def = clampNum(v, c.min, c.max, (d as RangeControl).def);
          break;
        }
        case "text": {
          const v = ui[c.key];
          if (v === undefined) break;
          c.def = typeof v === "string" ? v : (d as TextControl).def;
          break;
        }
        case "switches": {
          const dItems = (d as SwitchesControl).items;
          for (let j = 0; j < c.items.length; j++) {
            const v = ui[c.items[j].key];
            if (v === undefined) continue;
            c.items[j].def = typeof v === "boolean" ? v : dItems[j].def;
          }
          break;
        }
        case "swatches": {
          const v = ui[c.key];
          if (v === undefined) break;
          const dS = d as SwatchesControl;
          if (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)) {
            c.custom = v.toLowerCase();       // 自定义色：hex 原样回填，忽略 def
          } else if (typeof v === "string") {
            const idx = c.presets.findIndex((p) => p.name === v);
            c.def = idx >= 0 ? idx : dS.def;  // 预设名：反查下标；未知回落默认
            c.custom = undefined;
          }
          break;
        }
        case "stack": walk(c.items, (d as StackControl).items); break;
        case "note": break;
      }
    }
  };
  for (let g = 0; g < SETTINGS_GROUPS.length; g++) walk(SETTINGS_GROUPS[g].items, GROUP_DEFAULTS[g].items);
  syncCallNote();
}

// memEncrypt（长期记忆本地加密）2026-09-29 迁出 SETTINGS_GROUPS：控件挂隐私组「长期记忆」卡
// （ltCardHtml），不进通用渲染 —— 但落盘键不变（config.ui.memEncrypt，主进程/旧配置零影响）。
// 模块态 = 实读值，ltCardHtml 渲染只读它；config.ui 的三个写读点（boot / save / reset）各自同步。
let memEncryptOn = true;

/** ui map → memEncrypt 模块态（脏值不动当前态，与 applyUiToGroups「校验不过回默认」同精神） */
function applyMemEncryptUi(ui: Record<string, UiValue>): void {
  const v = ui.memEncrypt;
  if (typeof v === "boolean") memEncryptOn = v;
}

/** 「称呼」提示文案跟随实读值（§5.5）：空串回落 CALL_FALLBACK，不许渲染成「她会称呼你「」」 */
function syncCallNote(): void {
  let call = "";
  const findCall = (items: Control[]): void => {
    for (const c of items) {
      if (c.kind === "text" && c.key === "call") call = c.def;
      else if (c.kind === "stack") findCall(c.items);
    }
  };
  const setNote = (items: Control[]): void => {
    for (const c of items) {
      if (c.kind === "note" && c.key === "call") c.text = callNoteText(call.trim() || CALL_FALLBACK);
      else if (c.kind === "stack") setNote(c.items);
    }
  };
  for (const g of SETTINGS_GROUPS) { findCall(g.items); setNote(g.items); }
}

/** 防抖写盘（照 scheduleModelSave / scheduleVoiceSave 形状，同一个 400ms） */
const uiForm = {
  saveTimer: null as number | null,
  /** 防抖窗口内待落盘的键值。patch 只带改动过的键 → config:set 深合并不误伤别的段（§4.4） */
  pending: {} as Record<string, UiValue>,
};

function cancelUiSave(): void {
  if (uiForm.saveTimer !== null) {
    window.clearTimeout(uiForm.saveTimer);
    uiForm.saveTimer = null;
  }
}

function scheduleUiSave(key: string, value: UiValue): void {
  uiForm.pending[key] = value; // 连续拖动 / 同窗改多个键：累积，落盘取最新值
  if (uiForm.saveTimer !== null) window.clearTimeout(uiForm.saveTimer);
  uiForm.saveTimer = window.setTimeout(() => {
    uiForm.saveTimer = null;
    void saveUiConfig();
  }, 400);
}

/** 8.7.22：弹系统文件框选背景图（background 样式=自定义图片）。取消不动；选中 → 刷新路径行 + 防抖落盘 */
async function pickBgImage(): Promise<void> {
  const picked = await window.nahida.ui.pickBgImage();
  if (!picked) return;
  bgImagePath = picked;
  const row = document.getElementById("bgimage-path");
  if (row) row.textContent = picked;
  scheduleUiSave("bgImage", picked);
}

async function saveUiConfig(): Promise<void> {
  const patchUi = uiForm.pending;
  if (Object.keys(patchUi).length === 0) return;
  uiForm.pending = {};
  try {
    await window.nahida.config.set({ ui: patchUi });
    applyUiToGroups(patchUi); // 数据层同步 def + 称呼提示（值来自控件，必过校验）
    applyMemEncryptUi(patchUi); // 迁出通用清单的键（memEncrypt）也在这里同步模块态
    if ("bgImage" in patchUi) bgImagePath = String(patchUi.bgImage ?? ""); // 8.7.22：同步模块态
    applyVisual(patchUi); // 视觉项每次写盘成功后生效（§4.6：与启动 / 恢复默认共用这一个函数）
    showUiSaveStatus("已保存", false);
  } catch (err) {
    showUiSaveStatus(err instanceof Error ? err.message : String(err), true); // 别静默失败（§4.4）
  }
}

/** 三组卡共用的保存结果行：挂在 settings-body 末尾（renderSettings 重建 DOM 时一起重建） */
function showUiSaveStatus(text: string, isError: boolean): void {
  const el = document.getElementById("ui-save-status");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("ui-save-status--error", isError);
}

/** 跟随系统：系统明暗媒体查询（模块级缓存，避免每次 applyVisual 重建） */
let systemDarkQuery: MediaQueryList | null = null;

/** 8.7.21：当前主题档（模块级，监听闭包读它而不是启动时的 ui 对象 —— 切档后旧值不会覆盖手动选择） */
let currentThemeMode: string = THEME_VALUES[0];

/** 解析主题档位 → 最终明暗值："浅色"→light；"深色"→dark；"跟随系统"→实时读系统偏好 */
function resolveThemeMode(mode: string): "light" | "dark" {
  if (mode === "深色") return "dark";
  if (mode === "浅色") return "light";
  if (typeof window.matchMedia === "function") {
    if (!systemDarkQuery) systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");
    return systemDarkQuery.matches ? "dark" : "light";
  }
  return "light"; // 无 matchMedia 兜底浅色
}

/** 强调色落盘值 → 完整强调令牌组（预设名 / 自定义 hex 两条路） */
function resolveAccent(value: UiValue): SwatchesControl["presets"][number] | null {
  const v = String(value);
  if (v && /^#[0-9a-f]{6}$/i.test(v)) return deriveAccent(v.toLowerCase());
  return ACCENT_PRESETS.find((p) => p.name === v) ?? null;
}

/** 8.7.22：当前背景图路径（模块级，渲染外观卡背景图行用；config.ui.bgImage 的投影） */
let bgImagePath = "";

/** 视觉项写入 documentElement（三处共用同一个函数：启动 / 每次写盘成功后 / 恢复默认后，§4.6）。
 *  键缺失 → 保持现状（部分 patch 不许把别的视觉项打回默认）；键在但值脏 → 回落默认。
 *  只写 documentElement，不许往卡片 DOM 上写内联 style。 */
function applyVisual(ui: Record<string, UiValue>): void {
  const root = document.documentElement;
  if ("theme" in ui) {
    const mode = String(ui.theme);
    currentThemeMode = (THEME_VALUES as readonly string[]).includes(mode) ? mode : THEME_VALUES[0];
    root.dataset.theme = resolveThemeMode(currentThemeMode);
  }
  if ("accent" in ui) {
    const accent = resolveAccent(ui.accent);
    if (accent) {
      root.style.setProperty("--brand", accent.brand);
      root.style.setProperty("--brand-bright", accent.bright);
      root.style.setProperty("--brand-mid", accent.mid);
      root.style.setProperty("--brand-soft", accent.soft);
      root.style.setProperty("--brand-ink", accent.ink);
    }
  }
  if ("bgType" in ui) {
    const v = String(ui.bgType);
    const bg = (BGTYPE_VALUES as readonly string[]).includes(v) ? v : BGTYPE_VALUES[0];
    if (bg === "渐变") {
      root.style.removeProperty("--bg-page"); // 回落 tokens.css 默认（浅色渐变 / 深色块覆盖）
      root.style.removeProperty("--bg-image"); // 8.7.22：渐变/纯色都不许残留底图
    } else if (bg === "纯色") {
      // 纯色底：写 var(--bg-solid)（浅色=极浅绿，深色由 [data-theme="dark"] 覆盖 --bg-solid）
      root.style.setProperty("--bg-page", "var(--bg-solid)");
      root.style.removeProperty("--bg-image");
    } else {
      // 自定义图片：只换基底为纯色；底图由 bgImage 键驱动（--bg-image 复合值，见下）
      root.style.setProperty("--bg-page", "var(--bg-solid)");
    }
  }
  // 8.7.22：背景图路径 → --bg-image 复合值（遮罩层 + 图，铺满固定）；空/脏值 → none。
  // 遮罩颜色走 --bg-image-mask 变量（浅色浅绿 / 深色由 [data-theme="dark"] 覆盖更深），文字可读
  if ("bgImage" in ui) {
    const v = String(ui.bgImage ?? "");
    root.style.setProperty(
      "--bg-image",
      v ? `var(--bg-image-mask), url("file:///${v.replace(/\\/g, "/")}") center/cover no-repeat fixed` : "none",
    );
  }
}

/** 启动引导（§4.2）：config.get → 数据层回填 → 同步渲染 → 视觉生效。
 *  renderSettings 必须保持同步（「恢复默认」还要直接调它），异步只在这里。 */
async function bootSettings(): Promise<void> {
  const cfg = await window.nahida.config.get();
  bgImagePath = String(cfg.ui.bgImage ?? ""); // 8.7.22：背景图行初值
  applyUiToGroups(cfg.ui);
  applyMemEncryptUi(cfg.ui); // 长期记忆加密开关（迁出通用清单）首屏实读
  renderSettings();
  applyVisual(cfg.ui);
  initThemeFollow();
}

/** 跟随系统监听（8.7.21 修复闭包问题）：boot 时无条件挂一次；系统明暗切换读模块级
 *  currentThemeMode，只有主题档仍是「跟随系统」才重算 —— 切到浅色/深色后迟到事件被挡掉，
 *  不再覆盖手动选择；反过来，启动是浅色/深色、运行中切到跟随系统也能立即响应。 */
function initThemeFollow(): void {
  if (typeof window.matchMedia !== "function") return;
  if (!systemDarkQuery) systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (): void => {
    if (currentThemeMode !== "跟随系统") return;
    document.documentElement.dataset.theme = resolveThemeMode("跟随系统");
  };
  if (typeof systemDarkQuery.addEventListener === "function") {
    systemDarkQuery.addEventListener("change", onChange);
  } else if (typeof (systemDarkQuery as MediaQueryList & { addListener?: (cb: () => void) => void }).addListener === "function") {
    (systemDarkQuery as MediaQueryList & { addListener?: (cb: () => void) => void }).addListener?.(onChange); // 旧 Safari 兼容
  }
}

/** 恢复默认（§4.5）：写回全部键的默认值 map —— 不许 { ui: {} } 清空（mergeDeep 空对象合并不删键），
 *  patch 只带 ui，model / voice / mcp / permissions / media 一个都不碰（§5.8）。 */
async function resetUiToDefaults(): Promise<void> {
  cancelUiSave(); // 先掐防抖：否则旧值迟写回盘，把刚恢复的默认又覆盖掉（§5.10）
  const defaults = collectUiValues(GROUP_DEFAULTS); // segs/select 取 options[def] 选项原文
  defaults.memEncrypt = true; // 迁出 SETTINGS_GROUPS 后快照不含它 —— 恢复默认要一起归位（默认开）
  defaults.bgImage = ""; // 8.7.22：背景图不在控件快照里 —— 恢复默认清空，底图随 bgType=渐变 一起回落
  try {
    await window.nahida.config.set({ ui: defaults });
  } catch (err) {
    showUiSaveStatus(err instanceof Error ? err.message : String(err), true);
    return; // 落盘失败就不动本地状态，避免「看着恢复了其实没存」的假象
  }
  bgImagePath = "";
  applyUiToGroups(defaults);
  applyMemEncryptUi(defaults);
  renderSettings(); // 用默认值重建 DOM（开头会再 cancelUiSave，无害）
  applyVisual(defaults);
  showUiSaveStatus("已恢复默认设置", false);
}

// ============================================================
// 3.7 模型卡（独立渲染，不走 SETTINGS_GROUPS 通用渲染）
// 为什么不走 SETTINGS_GROUPS：厂商列表异步从 IPC 取，渲染那一刻还没有（指令 §6.1）。
// 六条交互（指令 §6.2）：
//   ① 选提供方 → 从预设带出地址与默认模型（custom 的地址是空串 → 留空让用户自己填）
//   ② 输入框变化 → 防抖 400ms 后 config:set 即时保存（§9.2：设置页语义「改了即生效」，无保存按钮）
//   ③ 测试连接 → 先 flush 待写入的防抖，再把当前表单值当 override 传 provider:test
//   ④ 测试中 → 按钮禁用 + 「测试中…」
//   ⑤ 结果行 → 成功显示耗时/模型/样例；失败直接显示主进程给出的人话（3.5 的文案，这里不二次加工）
//   ⑥ ⚠️ apiKey 掩码绝不回写（§6.3）：config:get 返回的 Key 是掩码串，只有用户真的编辑过
//      Key 输入框（dirty 标记）才提交该字段；没编辑过就整个字段省略，config:set 的深合并保留原值
// ============================================================

/** 模型卡运行态：预设缓存 + dirty 标记 + 防抖句柄 */
const modelForm = {
  presets: [] as PresetSummary[],
  apiKeyDirty: false,
  saveTimer: null as number | null,
};

function modelCardHtml(): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.plug}模型</h3>
    <div class="settings-grid">
      <div class="settings-item">
        <span class="settings-item__label">模型提供方</span>
        <select id="set-model-provider" disabled><option>加载中…</option></select>
      </div>
      <div class="settings-item">
        <span class="settings-item__label">服务地址</span>
        <input type="text" id="set-model-baseurl" placeholder="留空 = 用所选提供方的默认地址" autocomplete="off" spellcheck="false" />
      </div>
      <div class="settings-item">
        <span class="settings-item__label">API Key<span class="tag tag-gold" id="model-key-required" hidden>必填</span></span>
        <input type="password" id="set-model-key" placeholder="云端厂商需要填写，本地无需" autocomplete="new-password" spellcheck="false" />
      </div>
      <div class="settings-item">
        <span class="settings-item__label">模型名称</span>
        <input type="text" id="set-model-name" placeholder="如 qwen2.5:7b；留空用提供方默认" autocomplete="off" spellcheck="false" />
      </div>
    </div>
    <div class="model-card__actions">
      <button type="button" class="btn-gold" id="model-test">${ICON.refresh}测试连接</button>
      <p class="model-card__streamwarn" id="model-stream-warn" hidden>该厂商不支持流式，回复会一次性返回</p>
      <!-- 5.1.1（P17 收口）：地址必填的预设且地址为空时显示，文案集中这一处（§4.8） -->
      <p class="model-card__error" id="model-baseurl-error" hidden>该提供方必须填写服务地址</p>
    </div>
    <p class="model-card__result" id="model-test-result" hidden></p>
  </section>`;
}

/** 按 id 找预设表单控件（模型卡 DOM 可能被「恢复默认」重建，每次现取） */
function modelField<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function currentPreset(): PresetSummary | null {
  const id = modelField<HTMLSelectElement>("set-model-provider")?.value;
  return modelForm.presets.find((p) => p.id === id) ?? null;
}

/** 按当前预设刷「必填」标记 /「不支持流式」提示 /「服务地址必填」错误（PresetSummary 投影的全部消费方） */
function updateProviderUi(): void {
  const preset = currentPreset();
  const required = modelField<HTMLElement>("model-key-required");
  if (required) required.hidden = !preset?.apiKeyRequired;
  const warn = modelField<HTMLElement>("model-stream-warn");
  if (warn) warn.hidden = preset?.supportsStreaming !== false;
  // 5.1.1（P17 收口）：地址必填的预设（custom / 中转）且地址为空 → 显示必填错误 + 禁用「测试连接」；
  // 地址非空或预设不要求 → 解除禁用、隐藏错误（触发时机：预设切换 / 地址输入，见 wireSettings）
  const addr = modelField<HTMLInputElement>("set-model-baseurl");
  const bad = preset?.baseUrlRequired === true && (!addr || addr.value.trim() === "");
  const err = modelField<HTMLElement>("model-baseurl-error");
  if (err) err.hidden = !bad;
  const testBtn = modelField<HTMLButtonElement>("model-test");
  if (testBtn) testBtn.disabled = bad;
}

/** 预设 + 配置到货后回填表单（顶层启动 / 「恢复默认」重建后都会调） */
async function initModelCard(): Promise<void> {
  modelForm.apiKeyDirty = false;
  const [presets, cfg] = await Promise.all([
    window.nahida.provider.listPresets(),
    window.nahida.config.get(),
  ]);
  modelForm.presets = presets;
  const sel = modelField<HTMLSelectElement>("set-model-provider");
  const addr = modelField<HTMLInputElement>("set-model-baseurl");
  const key = modelField<HTMLInputElement>("set-model-key");
  const name = modelField<HTMLInputElement>("set-model-name");
  if (!sel || !addr || !key || !name) return;
  sel.disabled = false;
  sel.innerHTML = presets.map((p) => `<option value="${esc(p.id)}">${esc(p.displayName)}</option>`).join("");
  // 配置里的 provider 是空串（= 未选择）时补一个占位项；用户不动它就不会被写值
  if (!presets.some((p) => p.id === cfg.model.provider)) {
    sel.insertAdjacentHTML("afterbegin", `<option value="">未选择</option>`);
  }
  sel.value = cfg.model.provider;
  // 回填所见即所得：配置为空（= 用预设默认）就把预设默认带出来显示；不动表单就不会落盘
  const preset = presets.find((p) => p.id === cfg.model.provider) ?? null;
  addr.value = cfg.model.baseUrl || preset?.baseUrl || "";
  name.value = cfg.model.model || preset?.defaultModel || "";
  key.value = cfg.model.apiKey; // 掩码形态（明文不出主进程）；没编辑过就绝不提交（§6.3）
  updateProviderUi();
}

function cancelModelSave(): void {
  if (modelForm.saveTimer !== null) {
    window.clearTimeout(modelForm.saveTimer);
    modelForm.saveTimer = null;
  }
}

function scheduleModelSave(): void {
  cancelModelSave();
  modelForm.saveTimer = window.setTimeout(() => {
    modelForm.saveTimer = null;
    void saveModelConfig();
  }, 400);
}

/** 测试前把待写入的防抖立即落盘 —— 否则刚敲进去的 Key 还没保存，测的是旧值（§6.2.3） */
function flushModelSave(): void {
  if (modelForm.saveTimer !== null) {
    cancelModelSave();
    void saveModelConfig();
  }
}

/** 读当前表单 → config:set。apiKey 只在 dirty（用户真编辑过）时提交，否则整个字段省略 */
async function saveModelConfig(): Promise<void> {
  const sel = modelField<HTMLSelectElement>("set-model-provider");
  if (!sel) return;
  const modelPatch: Partial<AppConfig["model"]> = {
    provider: sel.value,
    baseUrl: modelField<HTMLInputElement>("set-model-baseurl")?.value ?? "",
    model: modelField<HTMLInputElement>("set-model-name")?.value ?? "",
  };
  if (modelForm.apiKeyDirty) {
    modelPatch.apiKey = modelField<HTMLInputElement>("set-model-key")?.value ?? "";
  }
  const saved = await window.nahida.config.set({ model: modelPatch });
  // 状态层联动（§8）：换厂商/换模型保存后同步一次；status 仍由聊天链路管，这里不碰
  patch({ model: { provider: saved.model.provider, name: saved.model.model } }, "settings");
}

async function runModelTest(): Promise<void> {
  flushModelSave();
  const btn = modelField<HTMLButtonElement>("model-test");
  const result = modelField<HTMLElement>("model-test-result");
  const sel = modelField<HTMLSelectElement>("set-model-provider");
  const addr = modelField<HTMLInputElement>("set-model-baseurl");
  const name = modelField<HTMLInputElement>("set-model-name");
  if (!btn || !result || !sel || !addr || !name) return;
  btn.disabled = true;
  btn.textContent = "测试中…";
  result.hidden = true;
  const override: Partial<AppConfig["model"]> = {
    provider: sel.value,
    baseUrl: addr.value,
    model: name.value,
  };
  // Key 与保存同一条规矩：没编辑过就不传 —— 草稿合并会用已保存的真 Key，掩码串传过去必失败
  if (modelForm.apiKeyDirty) {
    override.apiKey = modelField<HTMLInputElement>("set-model-key")?.value ?? "";
  }
  let res: TestConnectionResult;
  try {
    res = await window.nahida.provider.test(override);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${ICON.refresh}测试连接`;
    updateProviderUi(); // 5.1.1：若测试期间地址被清空，这里恢复必填禁用态（finally 本身会把 disabled 无脑放开）
  }
  result.hidden = false;
  if (res.ok) {
    const modelPart = override.model ? ` · 模型 ${override.model}` : "";
    const samplePart = res.sample ? ` · ${res.sample}` : "";
    result.textContent = `连接正常 · 耗时 ${res.latency}ms${modelPart}${samplePart}`;
    result.classList.remove("model-card__result--error");
  } else {
    result.textContent = res.error ?? "连接失败";
    result.classList.add("model-card__result--error");
  }
}

// ============================================================
// 8.1 视觉模型卡（「模型」组内第二张卡，与聊天模型卡互不影响）
// 照模型卡先例（预设下拉 / 掩码不回写 / 防抖即时保存 / 连接测试），但状态与落盘键完全独立：
//   ① 表单态走 config.vision（**绝不碰 config.model**）；
//   ② apiKey 掩码只在用户真编辑过时提交（同 §6.3 的 dirty 规矩）；
//   ③ 连接测试走 vision:test（主进程带一张最小图，链路独立于聊天模型）。
// 说明文案：截图理解与读图专用，可独立于聊天模型配置。
// ============================================================

/** 视觉卡运行态：预设缓存 + dirty 标记 + 防抖句柄（与 modelForm 各自独立） */
const visionForm = {
  presets: [] as PresetSummary[],
  apiKeyDirty: false,
  saveTimer: null as number | null,
};

function visionCardHtml(): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.image}视觉模型</h3>
    <p class="settings-note">读图默认让主模型直接看图（支持多模态时零额外配置）；主模型不支持或读图失败时才回落到这里配的视觉模型。视觉请求恒走 OpenAI 兼容入口，本地 Ollama 需填 http://localhost:11434/v1。</p>
    <div class="settings-grid">
      <div class="settings-item">
        <span class="settings-item__label">模型提供方</span>
        <select id="set-vision-provider" disabled><option>加载中…</option></select>
      </div>
      <div class="settings-item">
        <span class="settings-item__label">服务地址</span>
        <input type="text" id="set-vision-baseurl" placeholder="留空 = 用所选提供方的默认地址" autocomplete="off" spellcheck="false" />
      </div>
      <div class="settings-item">
        <span class="settings-item__label">API Key</span>
        <input type="password" id="set-vision-key" placeholder="云端填真实 Key；本地模型填任意占位值（如 ollama）" autocomplete="new-password" spellcheck="false" />
      </div>
      <div class="settings-item">
        <span class="settings-item__label">模型名称</span>
        <input type="text" id="set-vision-name" placeholder="如 qwen2.5vl:7b / gpt-4o" autocomplete="off" spellcheck="false" />
      </div>
    </div>
    <div class="settings-item vision-force-row">
      <label class="settings-switch">强制使用视觉模型（不看主模型）
        <button type="button" class="switch" data-vision-force="forceVision" data-on="false" role="switch" aria-checked="false" aria-label="强制使用视觉模型"><span></span></button>
      </label>
    </div>
    <div class="model-card__actions">
      <button type="button" class="btn-gold" id="vision-test">${ICON.refresh}测试连接</button>
    </div>
    <p class="model-card__result" id="vision-test-result" hidden></p>
  </section>`;
}

/** 按 id 找视觉卡控件（DOM 可能被切换分组重建，每次现取） */
function visionField<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/** 预设 + 配置到货后回填表单（进入「模型」组时调用） */
async function initVisionCard(): Promise<void> {
  visionForm.apiKeyDirty = false;
  const [presets, cfg] = await Promise.all([
    window.nahida.provider.listPresets(),
    window.nahida.config.get(),
  ]);
  visionForm.presets = presets;
  const sel = visionField<HTMLSelectElement>("set-vision-provider");
  const addr = visionField<HTMLInputElement>("set-vision-baseurl");
  const key = visionField<HTMLInputElement>("set-vision-key");
  const name = visionField<HTMLInputElement>("set-vision-name");
  if (!sel || !addr || !key || !name) return;
  sel.disabled = false;
  sel.innerHTML = presets.map((p) => `<option value="${esc(p.id)}">${esc(p.displayName)}</option>`).join("");
  if (!presets.some((p) => p.id === cfg.vision.provider)) {
    sel.insertAdjacentHTML("afterbegin", `<option value="">未选择</option>`);
  }
  sel.value = cfg.vision.provider;
  // 回填所见即所得，同模型卡：配置为空（= 用预设默认）就把预设默认带出来显示；不动表单就不会落盘
  const preset = presets.find((p) => p.id === cfg.vision.provider) ?? null;
  addr.value = cfg.vision.baseUrl || preset?.baseUrl || "";
  name.value = cfg.vision.model || preset?.defaultModel || "";
  key.value = cfg.vision.apiKey; // 掩码形态（明文不出主进程）
  const forceSw = visionField<HTMLButtonElement>("[data-vision-force]");
  if (forceSw) {
    const on = cfg.vision.forceVision === true; // C 重做：严格 === true（缺省/脏值 = 自动判定）
    forceSw.dataset.on = String(on);
    forceSw.setAttribute("aria-checked", String(on));
  }
}

function cancelVisionSave(): void {
  if (visionForm.saveTimer !== null) {
    window.clearTimeout(visionForm.saveTimer);
    visionForm.saveTimer = null;
  }
}

function scheduleVisionSave(): void {
  cancelVisionSave();
  visionForm.saveTimer = window.setTimeout(() => {
    visionForm.saveTimer = null;
    void saveVisionConfig();
  }, 400);
}

/** 测试前把待写入的防抖立即落盘（否则刚敲进去的 Key 还没保存，测的是旧值） */
function flushVisionSave(): void {
  if (visionForm.saveTimer !== null) {
    cancelVisionSave();
    void saveVisionConfig();
  }
}

/** 读当前表单 → config:set({ vision }) —— 只写 vision 段，**绝不碰 model 段** */
async function saveVisionConfig(): Promise<void> {
  const sel = visionField<HTMLSelectElement>("set-vision-provider");
  if (!sel) return;
  const visionPatch: Partial<AppConfig["vision"]> = {
    provider: sel.value,
    baseUrl: visionField<HTMLInputElement>("set-vision-baseurl")?.value ?? "",
    model: visionField<HTMLInputElement>("set-vision-name")?.value ?? "",
    // C 重做：开关态随卡一并落盘（false 也提交 —— 用户刚关掉时必须能写回 false）
    forceVision: visionField<HTMLButtonElement>("[data-vision-force]")?.dataset.on === "true",
  };
  if (visionForm.apiKeyDirty) {
    visionPatch.apiKey = visionField<HTMLInputElement>("set-vision-key")?.value ?? "";
  }
  await window.nahida.config.set({ vision: visionPatch });
}

/** C 重做：强制视觉开关点击（委托里 data-vision-force 分支拦在通用 .switch 之前防双重取反）。
 *  即时落盘（不等表单 debounce）—— 只传 forceVision，其余 vision 字段由主进程 merge-then-normalize 保留 */
async function saveVisionForce(btn: HTMLButtonElement): Promise<void> {
  const next = btn.dataset.on !== "true";
  btn.dataset.on = String(next);
  btn.setAttribute("aria-checked", String(next));
  try {
    const cfg = await window.nahida.config.set({ vision: { forceVision: next } });
    const real = cfg.vision?.forceVision === true; // 严格 === true（缺省 = 自动判定），界面别停在假状态
    btn.dataset.on = String(real);
    btn.setAttribute("aria-checked", String(real));
  } catch {
    btn.dataset.on = String(!next); // 保存失败翻回去
    btn.setAttribute("aria-checked", String(!next));
  }
}

async function runVisionTest(): Promise<void> {
  flushVisionSave();
  const btn = visionField<HTMLButtonElement>("vision-test");
  const result = visionField<HTMLElement>("vision-test-result");
  const sel = visionField<HTMLSelectElement>("set-vision-provider");
  const addr = visionField<HTMLInputElement>("set-vision-baseurl");
  const name = visionField<HTMLInputElement>("set-vision-name");
  if (!btn || !result || !sel || !addr || !name) return;
  btn.disabled = true;
  btn.textContent = "测试中…";
  result.hidden = true;
  const override: Partial<AppConfig["vision"]> = {
    provider: sel.value,
    baseUrl: addr.value,
    model: name.value,
  };
  // Key 与保存同一条规矩：没编辑过就不传 —— 草稿合并会用已保存的真 Key，掩码串传过去必失败
  if (visionForm.apiKeyDirty) {
    override.apiKey = visionField<HTMLInputElement>("set-vision-key")?.value ?? "";
  }
  let res: TestConnectionResult;
  try {
    res = await window.nahida.vision.test(override);
  } finally {
    btn.disabled = false;
    btn.innerHTML = `${ICON.refresh}测试连接`;
  }
  result.hidden = false;
  if (res.ok) {
    const modelPart = override.model ? ` · 模型 ${override.model}` : "";
    const samplePart = res.sample ? ` · ${res.sample}` : "";
    result.textContent = `连接正常 · 耗时 ${res.latency}ms${modelPart}${samplePart}`;
    result.classList.remove("model-card__result--error");
  } else {
    result.textContent = res.error ?? "连接失败";
    result.classList.add("model-card__result--error");
  }
}

// ============================================================
// 4.2 MCP 服务器卡（独立渲染，照模型卡先例）
// 为什么不走 SETTINGS_GROUPS：服务器列表异步从 IPC 取，渲染那一刻还没有。
// 四条交互：① 列表（状态点 + 开关 + 重连 + 移除）② 添加表单（传输方式切换字段显隐）
//          ③ 添加并连接 ④ 四个动作共用 runMcpAction（刷新列表 + 结果行）
// ⚠️ 任何 MCP 动作后**只重渲染 #mcp-list**，绝不调 renderSettings() ——
//    那会 cancelModelSave() 掉模型卡里没落盘的输入（易错清单第 2 条）
// ============================================================

/** 状态点三态：on 已连接 / err 有错 / off 未连接或已停用。**静态不跳动** ——
 *  与 3.8 的「在线点」区分：那是当前会话的实时状态，这里只是一份配置列表 */
function mcpStateOf(s: McpServerView): "on" | "err" | "off" {
  if (s.connected) return "on";
  return s.lastError ? "err" : "off";
}

function mcpRowHtml(s: McpServerView): string {
  const status = s.connected ? `已连接 · ${s.toolCount} 个工具` : s.enabled ? "未连接" : "已停用";
  return `<div class="mcp-row">
    <span class="mcp-dot" data-state="${mcpStateOf(s)}" aria-hidden="true"></span>
    <span class="mcp-row__name">${esc(s.name)}</span>
    <span class="mcp-row__meta">${esc(s.transportLabel)} · ${esc(s.riskLabel)} · ${esc(status)}</span>
    <span class="mcp-row__actions">
      <button type="button" class="switch" data-mcp-toggle="${esc(s.id)}" data-on="${s.enabled}" role="switch" aria-checked="${s.enabled}" aria-label="${esc(s.name)}"><span></span></button>
      ${s.enabled ? `<button type="button" class="btn-soft" data-mcp-retry="${esc(s.id)}">${ICON.refresh}重连</button>` : ""}
      <button type="button" class="btn-soft" data-mcp-remove="${esc(s.id)}">移除</button>
    </span>
    ${s.lastError ? `<p class="mcp-row__error">${esc(s.lastError)}</p>` : ""}
  </div>`;
}

function renderMcpList(list: McpServerView[]): void {
  const host = document.getElementById("mcp-list");
  if (!host) return;
  host.innerHTML = list.length === 0
    ? `<p class="settings-note">还没有配置 MCP 服务器。填下面的表单可以加一个。</p>`
    : list.map(mcpRowHtml).join("");
}

/** 表单里与传输方式相关的字段显隐：stdio 三格 / http·sse 一格 */
function updateMcpFormUi(): void {
  const kind = (document.getElementById("mcp-f-transport") as HTMLSelectElement | null)?.value ?? "stdio";
  document.querySelectorAll<HTMLElement>("[data-mcp-when]").forEach((el) => {
    el.hidden = !(el.dataset.mcpWhen ?? "").split(" ").includes(kind);
  });
}

async function initMcpCard(): Promise<void> {
  updateMcpFormUi();
  renderMcpList(await window.nahida.mcp.list());
}

/** 表单 → add 入参。参数框按空白切分（不做引号解析 —— 需要带空格的路径请用「工作目录」字段） */
function readMcpForm(): McpServerInput {
  const val = (id: string): string => (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? "";
  const pick = (id: string): string => (document.getElementById(id) as HTMLSelectElement | null)?.value ?? "";
  return {
    id: val("mcp-f-id"),
    name: val("mcp-f-name"),
    // 下拉取值过类型闸即可：值域白名单由主进程 parseMcpServerInput 兜底，渲染层不做第二份校验
    transport: pick("mcp-f-transport") as McpServerInput["transport"],
    risk: pick("mcp-f-risk") as McpServerInput["risk"],
    command: val("mcp-f-command"),
    args: val("mcp-f-args").split(/\s+/).filter(Boolean),
    cwd: val("mcp-f-cwd"),
    url: val("mcp-f-url"),
  };
}

/** 四个动作（增 / 删 / 启停 / 重连）统一收口：跑 IPC → 刷新列表 → 把结果写到结果行 */
async function runMcpAction(run: () => Promise<McpMutationResult>): Promise<void> {
  const result = document.getElementById("mcp-add-result");
  let ok = false;
  let message = "";
  try {
    const res = await run();
    ok = res.ok;
    message = res.ok ? "已完成。" : res.error ?? "操作失败";
    renderMcpList(res.servers);
  } catch (err) {
    // IPC 本身抛了（例如主进程未注册通道）：也要让列表回到真实状态
    message = err instanceof Error ? err.message : String(err);
    renderMcpList(await window.nahida.mcp.list());
  }
  if (!result) return;
  result.hidden = false;
  result.textContent = message;
  result.classList.toggle("mcp-result--error", !ok);
}

function mcpCardHtml(): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.server}MCP 服务器</h3>
    <div class="mcp-list" id="mcp-list"><p class="settings-note">加载中…</p></div>
    <div class="settings-grid mcp-form">
      <div class="settings-item">
        <span class="settings-item__label">ID<span class="tag tag-gold">必填</span></span>
        <input type="text" id="mcp-f-id" placeholder="字母、数字、下划线、短横线，如 filesystem" autocomplete="off" spellcheck="false" />
      </div>
      <div class="settings-item">
        <span class="settings-item__label">显示名</span>
        <input type="text" id="mcp-f-name" placeholder="留空 = 用 ID" autocomplete="off" spellcheck="false" />
      </div>
      <div class="settings-item">
        <span class="settings-item__label">传输方式</span>
        <select id="mcp-f-transport">${MCP_TRANSPORTS.map(
          (t) => `<option value="${t}">${esc(MCP_TRANSPORT_LABEL[t])}</option>`,
        ).join("")}</select>
      </div>
      <div class="settings-item">
        <span class="settings-item__label">危险等级（该服务器工具的上限）</span>
        <select id="mcp-f-risk">${RISK_LEVELS.map(
          (r) => `<option value="${r}"${r === "shell" ? " selected" : ""}>${esc(RISK_LEVEL_LABEL[r])}</option>`,
        ).join("")}</select>
      </div>
      <div class="settings-item" data-mcp-when="stdio">
        <span class="settings-item__label">启动命令<span class="tag tag-gold">stdio 必填</span></span>
        <input type="text" id="mcp-f-command" placeholder="如 npx（Windows 上不用写 .cmd）" autocomplete="off" spellcheck="false" />
      </div>
      <div class="settings-item" data-mcp-when="stdio">
        <span class="settings-item__label">参数（空格分隔）</span>
        <input type="text" id="mcp-f-args" placeholder="如 -y @modelcontextprotocol/server-everything" autocomplete="off" spellcheck="false" />
      </div>
      <div class="settings-item" data-mcp-when="stdio">
        <span class="settings-item__label">工作目录</span>
        <input type="text" id="mcp-f-cwd" placeholder="留空 = 用应用当前目录" autocomplete="off" spellcheck="false" />
      </div>
      <div class="settings-item" data-mcp-when="http sse">
        <span class="settings-item__label">服务地址<span class="tag tag-gold">HTTP / SSE 必填</span></span>
        <input type="text" id="mcp-f-url" placeholder="如 http://127.0.0.1:3001/mcp" autocomplete="off" spellcheck="false" />
      </div>
    </div>
    <div class="model-card__actions">
      <button type="button" class="btn-gold" id="mcp-add">${ICON.plus}添加并连接</button>
    </div>
    <p class="mcp-result" id="mcp-add-result" hidden></p>
    <p class="settings-note mcp-note">MCP 服务器是外部程序，nahida 无法判断它实际会做什么。所以「危险等级」选的是最坏情况下允许它做什么的上限：默认「执行命令」= 只读档位下直接拒绝，要它干活就升档或每次确认。添加时会真的把它启动起来，请只添加你信任的服务器。</p>
  </section>`;
}

// ============================================================
// 4.6 语音卡（独立渲染，照模型卡 / MCP 卡先例）
// 为什么不走 SETTINGS_GROUPS：引擎列表与配置都是异步 IPC 来的，渲染那一刻还没有（同 3.7 / 4.2）。
// 本步的卖点（P4）：**表单由 configSchema 生成** —— 加引擎只改主进程，这个文件一行不用改。
// 五条交互：
//   ① 引擎列表按 kind 分两组（语音合成 / 语音识别），每引擎一个块
//   ② 每引擎的字段全部由 configSchema 生成（六种 type 全覆盖）
//   ③ 任何改动 → 防抖 400ms → config:set 即时保存（无保存按钮，同 3.7 §9.2）
//   ④ path 字段「浏览」→ voice:pick-path → 立刻保存（不走防抖，避免切走丢值）
//   ⑤ secret 字段没编辑过就**不提交**（掩码绝不回写，同 3.7 §6.3 / D8）
// ⚠️ 保存后**只刷状态元素**（#voice-status-*），绝不调 renderSettings() ——
//    那会 cancelModelSave() 掉模型卡里没落盘的输入（4.2 易错清单第 2 条），
//    也会让正在输入的输入框失焦。
// ============================================================

const VOICE_KIND_LABEL: Record<VoiceKind, string> = { tts: "语音合成", asr: "语音识别" };

const voiceForm = {
  engines: [] as VoiceEngineSummary[],
  /** config:get 来的 stored 值（secret 是掩码）；键 = engine.id */
  stored: {} as Record<string, VoiceConfigValues>,
  /** 用户真编辑过的 secret 字段（"<engineId>|<key>"）—— 不在集合里的**不提交**（D8） */
  secretDirty: new Set<string>(),
  saveTimer: null as number | null,
};

// 7.6：卡按侧栏 kind 拆开 —— 标题与侧栏入口一致（合成 / 识别分开命名，不再是笼统「语音」）
function voiceCardHtml(kind: VoiceKind): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.mic}${VOICE_KIND_LABEL[kind]}</h3>
    <p class="settings-note">语音按「本地优先 → 云端兜底」的顺序尝试：本地引擎起不来（或没配好）就自动切下一个，并在状态行提示已降级。API Key 只存在这台机器上（落盘加密），不会发往任何第三方。</p>
    <div class="settings-item voice-preferred">
      <span class="settings-item__label">优先使用</span>
      <select id="voice-preferred" disabled><option>加载中…</option></select>
    </div>
    <div class="voice-engines" id="voice-engines"><p class="settings-note">加载中…</p></div>
    <p class="voice-result" id="voice-result" hidden></p>
  </section>`;
}

/** 字段控件定位：engineId / key **都带中划线**，一律走 data-*，绝不许从元素 id 里 parse（会歧义） */
function voiceControl(engineId: string, key: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-voice-engine="${CSS.escape(engineId)}"][data-voice-key="${CSS.escape(key)}"]`,
  );
}

/** 该字段是不是 secret（**看 schema，不看 input 的 type** —— 两者不必一致） */
function isSecretField(engineId: string, key: string): boolean {
  const e = voiceForm.engines.find((x) => x.id === engineId);
  return Boolean(e?.configSchema.find((f) => f.key === key)?.secret);
}

/** 单字段 → HTML。**不许**在这里出现任何引擎专属分支（那就不叫「configSchema 驱动」了） */
function voiceFieldHtml(engineId: string, f: ConfigField, stored: string | number | boolean | undefined): string {
  const domId = `voice-${engineId}-${f.key}`;
  const data = `data-voice-engine="${esc(engineId)}" data-voice-key="${esc(f.key)}"`;
  const head = `<span class="settings-item__label">${esc(f.label)}${f.required ? `<span class="tag tag-gold">必填</span>` : ""}</span>`;
  const hint = f.hint ? `<p class="voice-hint">${esc(f.hint)}</p>` : "";
  const cur = stored ?? f.default ?? "";

  switch (f.type) {
    case "password":
      // ⚠️ 回填的是**掩码**（明文不出主进程）；没编辑过绝不提交（§8.3 交互⑤）
      return `<div class="settings-item">${head}
        <input type="password" id="${domId}" ${data} value="${esc(String(cur))}"
               placeholder="${esc(f.placeholder ?? "留空 = 未配置")}" autocomplete="new-password" spellcheck="false" />
        ${hint}</div>`;

    case "number":
      return `<div class="settings-item">${head}
        <input type="number" id="${domId}" ${data} value="${esc(String(cur))}"
               min="${f.min ?? ""}" max="${f.max ?? ""}" step="${f.step ?? "any"}" />
        ${hint}</div>`;

    case "select":
      return `<div class="settings-item">${head}
        <select id="${domId}" ${data}>${(f.options ?? [])
          .map((o) => `<option value="${esc(o.value)}"${o.value === cur ? " selected" : ""}>${esc(o.label)}</option>`)
          .join("")}</select>
        ${hint}</div>`;

    case "path":
      // ⚠️ 用 <div> 而不是 <label> 包：里面有个按钮，<label> 会把按钮的点击转成 focus
      return `<div class="settings-item">${head}
        <div class="voice-row">
          <input type="text" id="${domId}" ${data} value="${esc(String(cur))}"
                 placeholder="${esc(f.placeholder ?? "")}" autocomplete="off" spellcheck="false" />
          <button type="button" class="btn-soft" data-voice-pick="${esc(engineId)}|${esc(f.key)}"
                  data-voice-mode="${f.pathMode ?? "file"}" data-voice-title="${esc(f.label)}">浏览</button>
        </div>
        ${hint}</div>`;

    case "boolean":
      return `<div class="settings-item">
        <label class="settings-switch">${esc(f.label)}
          <button type="button" class="switch" ${data} data-on="${cur === true}" role="switch"
                  aria-checked="${cur === true}" aria-label="${esc(f.label)}"><span></span></button>
        </label>${hint}</div>`;

    case "text":
    default:
      return `<div class="settings-item">${head}
        <input type="text" id="${domId}" ${data} value="${esc(String(cur))}"
               placeholder="${esc(f.placeholder ?? "")}" autocomplete="off" spellcheck="false" />
        ${hint}</div>`;
  }
}

/** 状态点三态：ready=on / unavailable=err / 其余=off（与 3.8 的在线点同构） */
function voiceDotState(e: VoiceEngineSummary): "on" | "err" | "off" {
  if (e.availability === "ready") return "on";
  if (e.availability === "unavailable") return "err";
  return "off";
}

function voiceEngineHtml(e: VoiceEngineSummary, stored: VoiceConfigValues): string {
  const note = e.availability === "ready" ? "" : (e.detail ?? "当前不可用");
  return `<div class="voice-engine">
    <div class="voice-engine__head">
      <span class="voice-dot" id="voice-status-${esc(e.id)}" data-state="${voiceDotState(e)}" aria-hidden="true"></span>
      <span class="voice-engine__name">${esc(e.name)}</span>
      <span class="tag ${e.locality === "local" ? "tag-gold" : "tag-ink"}">${e.locality === "local" ? "本地" : "云端"}</span>
      <span class="voice-engine__meta">${esc(VOICE_KIND_LABEL[e.kind])}</span>
    </div>
    <p class="voice-engine__note" id="voice-note-${esc(e.id)}">${esc(note)}</p>
    <div class="settings-grid">${e.configSchema.map((f) => voiceFieldHtml(e.id, f, stored[f.key])).join("")}</div>
  </div>`;
}

async function initVoiceCard(kind: VoiceKind): Promise<void> {
  voiceForm.secretDirty.clear();
  const [list, cfg] = await Promise.all([
    window.nahida.voice.listEngines(), // ⚠️ 会真的探活本地引擎（gpt-sovits 上限 2s）
    window.nahida.config.get(),
  ]);
  voiceForm.engines = list;
  voiceForm.stored = cfg.voice.engines;
  const host = document.getElementById("voice-engines");
  const sel = document.getElementById("voice-preferred") as HTMLSelectElement | null;
  if (!host || !sel) return;
  // 7.6：主内容区只渲染本组（合成 / 识别）—— 侧栏入口与内容一一对应，不再两组叠放同一张卡。
  // 组内下拉只「UI 看哪个」，voiceForm.engines 仍含全部引擎、保存仍全量收集（§1.2）；
  // 另一组已落盘值不在本卡 DOM 里、不入本次 patch，由主进程 config 深合并保底（不丢）。
  // 组内下拉与上面的 #voice-preferred 是两个概念：前者只是「UI 上看哪个」，后者才是全局首选（保留全部引擎，§1.1）。
  const group = list.filter((e) => e.kind === kind);
  if (list.length === 0) {
    host.innerHTML = `<p class="settings-note">还没有注册任何语音引擎。</p>`;
  } else if (group.length === 0) {
    host.innerHTML = `<p class="settings-note">还没有注册${VOICE_KIND_LABEL[kind]}引擎。</p>`;
  } else {
    host.innerHTML = `<div class="settings-item">
        <select class="voice-engine-select" data-voice-kind="${kind}" aria-label="${VOICE_KIND_LABEL[kind]}引擎">
          ${group.map((e) => `<option value="${esc(e.id)}">${esc(e.name)} · ${e.locality === "local" ? "本地" : "云端"}</option>`).join("")}
        </select>
      </div>
      <div class="voice-engine-slot" data-voice-slot="${kind}">${voiceEngineHtml(group[0], voiceForm.stored[group[0].id] ?? {})}</div>`;
    // 切引擎：先把没落盘的输入同步抓走（readVoiceForm 在首个 await 前同步求值，读的是旧 DOM），
    // 再重画本组 slot —— 隐藏引擎的已落盘值由 config 深合并保底，不会丢（§1.2）
    host.querySelectorAll<HTMLSelectElement>(".voice-engine-select").forEach((select) => {
      select.addEventListener("change", () => {
        const next = voiceForm.engines.find((e) => e.id === select.value && e.kind === kind);
        const slot = host.querySelector<HTMLElement>(`[data-voice-slot="${kind}"]`);
        if (!next || !slot) return;
        flushPendingVoiceSave();
        slot.innerHTML = voiceEngineHtml(next, voiceForm.stored[next.id] ?? {});
      });
    });
  }
  sel.innerHTML = `<option value="">自动（本地优先）</option>`
    + list.map((e) => `<option value="${esc(e.id)}">${esc(e.name)} · ${e.locality === "local" ? "本地" : "云端"}</option>`).join("");
  sel.value = cfg.voice.preferredId;
  sel.disabled = false;
}

/** 切引擎重画前调用：有 pending 防抖就立刻存一次（裸 cancel 会丢掉没到 400ms 的输入，§4.7 同款坑） */
function flushPendingVoiceSave(): void {
  if (voiceForm.saveTimer === null) return;
  cancelVoiceSave();
  void saveVoiceConfig();
}

function cancelVoiceSave(): void {
  if (voiceForm.saveTimer !== null) {
    window.clearTimeout(voiceForm.saveTimer);
    voiceForm.saveTimer = null;
  }
}

function scheduleVoiceSave(): void {
  cancelVoiceSave();
  voiceForm.saveTimer = window.setTimeout(() => {
    voiceForm.saveTimer = null;
    void saveVoiceConfig();
  }, 400);
}

/** 读整张卡 → config:set 的 patch。**数字按 min/max 夹紧**（输入中途的「6」不许落盘，D9） */
function readVoiceForm(): DeepPartial<AppConfig> {
  const engines: Record<string, VoiceConfigValues> = {};
  for (const e of voiceForm.engines) {
    const values: VoiceConfigValues = {};
    for (const f of e.configSchema) {
      const el = voiceControl(e.id, f.key);
      if (!el) continue;
      if (f.secret && !voiceForm.secretDirty.has(`${e.id}|${f.key}`)) continue; // 掩码绝不回写（D8）
      values[f.key] = readVoiceField(el, f);
    }
    engines[e.id] = values;
  }
  const sel = document.getElementById("voice-preferred") as HTMLSelectElement | null;
  return { voice: { preferredId: sel?.value ?? "", engines } };
}

function readVoiceField(el: HTMLElement, f: ConfigField): string | number | boolean {
  if (f.type === "boolean") return el.dataset.on === "true"; // .switch 按钮
  const raw = (el as HTMLInputElement | HTMLSelectElement).value;
  if (f.type === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) return typeof f.default === "number" ? f.default : 0;
    return Math.min(f.max ?? Infinity, Math.max(f.min ?? -Infinity, n)); // 夹紧
  }
  return raw;
}

async function saveVoiceConfig(): Promise<void> {
  const result = document.getElementById("voice-result");
  try {
    const saved = await window.nahida.config.set(readVoiceForm());
    voiceForm.stored = saved.voice.engines;
    voiceForm.secretDirty.clear(); // 已落盘 → 重新回到「没编辑过」的语义
    showVoiceResult(result, "已保存", false);
    void refreshVoiceStatus(); // 只刷状态点，不重渲染表单（D9）
  } catch (err) {
    showVoiceResult(result, err instanceof Error ? err.message : String(err), true);
  }
}

function showVoiceResult(el: HTMLElement | null, text: string, isError: boolean): void {
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("voice-result--error", isError);
}

/** 只更新每引擎的状态点 + 说明 —— **不重渲染表单**（重渲染会让正在输入的框失焦） */
async function refreshVoiceStatus(): Promise<void> {
  const list = await window.nahida.voice.listEngines();
  for (const e of list) {
    const dot = document.getElementById(`voice-status-${e.id}`);
    const note = document.getElementById(`voice-note-${e.id}`);
    if (dot) dot.dataset.state = voiceDotState(e);
    if (note) note.textContent = e.availability === "ready" ? "" : (e.detail ?? "当前不可用");
  }
}

/** path 字段「浏览」：弹框拿路径 → 填进输入框 → **立刻保存**（不等防抖） */
async function pickVoicePath(spec: string, mode: string, title: string): Promise<void> {
  const [engineId, key] = spec.split("|"); // engineId / key 都不含 "|"，切分安全
  if (!engineId || !key) return;
  const el = voiceControl(engineId, key);
  if (!(el instanceof HTMLInputElement)) return;
  const picked = await window.nahida.voice.pickPath({
    mode: mode === "directory" ? "directory" : "file",
    title,
    defaultPath: el.value,
  });
  if (!picked) return; // 取消 = 什么都不做（**不清空**用户已有的值）
  el.value = picked;
  await saveVoiceConfig();
}

// ============================================================
// 5.1.2 长期记忆卡 + 人设提示词卡（独立渲染，照语音卡先例）
// 为什么不走 SETTINGS_GROUPS：内容落独立文件（userData 下 memory/ 与 prompts/ 两个目录，
// 文件名归 store 管），不进 config.json（P22 注 2），读写走 memory:* / persona:* IPC。
// 条目的真相源是模块态数组 ltEntries（store 回读的消毒 + 排序结果），**不从 DOM 反读**：
// 输入事件先把值写进数组再防抖；渲染只从数组出；回填只更新计数 / 结果行，绝不重建输入框（失焦丢光标）。
// ⚠️ 行内定位一律 data-lt-*（值 = 条目 id），UUID 含中划线，绝不从元素 id parse（§4.9）。
// ============================================================

let ltEntries: LongTermEntry[] = [];

const memoryForm = { saveTimer: null as number | null };
const userProfileForm = { saveTimer: null as number | null }; // 5.1.6：档案手写段防抖（先例原为人设卡，6.6.2 起人设改只读）

function ltRowHtml(e: LongTermEntry): string {
  const invalid = e.status !== "active"; // 失效行变灰、按钮切「恢复」；仍可编辑可恢复（本步只存状态不判召回）
  const impOptions = Array.from({ length: LONG_TERM_LIMITS.importanceMax }, (_, i) => i + 1)
    .map((n) => `<option value="${n}"${n === e.importance ? " selected" : ""}>${n}</option>`)
    .join("");
  return `<div class="lt-row${invalid ? " lt-invalid" : ""}">
    <textarea class="lt-row__text" data-lt-text="${esc(e.id)}" rows="2" placeholder="她想长期记住的事">${esc(e.text)}</textarea>
    <div class="lt-row__bar">
      <input type="text" data-lt-tags="${esc(e.id)}" value="${esc(e.tags.join("，"))}" placeholder="标签（逗号分隔）" autocomplete="off" spellcheck="false" />
      <input type="text" data-lt-keys="${esc(e.id)}" value="${esc(e.keys.join("，"))}" placeholder="触发词（逗号分隔）" autocomplete="off" spellcheck="false" />
      <select data-lt-imp="${esc(e.id)}" aria-label="重要性（1–10）" title="重要性">${impOptions}</select>
      <button type="button" class="switch" data-lt-pin="${esc(e.id)}" data-on="${e.pinned === true}" role="switch" aria-checked="${e.pinned === true}" aria-label="置顶" title="置顶"><span></span></button>
      <button type="button" class="btn-soft" data-lt-toggle-status="${esc(e.id)}">${invalid ? "恢复" : "失效"}</button>
      <button type="button" class="btn-soft" data-lt-del="${esc(e.id)}">删除</button>
    </div>
  </div>`;
}

/** 只重建 #lt-list + 上限提示（§4.8：增删 / 置顶 / 失效恢复后绝不调 renderSettings()） */
function renderLtList(): void {
  const host = document.getElementById("lt-list");
  if (host) {
    host.innerHTML = ltEntries.length === 0
      ? `<p class="settings-note">还没有长期记忆。点下面的「新增一条」记下第一件想让她记住的事。</p>`
      : ltEntries.map(ltRowHtml).join("");
  }
  const add = document.getElementById("lt-add") as HTMLButtonElement | null;
  if (add) add.disabled = ltEntries.length >= LONG_TERM_LIMITS.maxEntries;
  const hint = document.getElementById("lt-hint");
  if (hint) {
    hint.textContent = ltEntries.length >= LONG_TERM_LIMITS.maxEntries
      ? `已达上限 ${LONG_TERM_LIMITS.maxEntries} 条，删掉一些才能再新增`
      : `共 ${ltEntries.length} 条 · 上限 ${LONG_TERM_LIMITS.maxEntries} 条`;
  }
}

function ltCardHtml(): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.database}长期记忆</h3>
    <p class="settings-note">每一条都是她会长期记住的事，只保存在本机，重启仍在。标签给人看；触发词是对话命中时让她想起这条记忆的关键词；置顶的条目永远排在最前。失效的条目只是标记，不会删除。</p>
    <label class="settings-switch lt-encrypt">长期记忆本地加密
      <button type="button" class="switch" data-ui-key="memEncrypt" data-on="${memEncryptOn}" role="switch" aria-checked="${memEncryptOn}" aria-label="长期记忆本地加密"><span></span></button>
    </label>
    <div class="lt-list" id="lt-list"><p class="settings-note">加载中…</p></div>
    <div class="lt-actions">
      <button type="button" class="btn-gold" id="lt-add">${ICON.plus}新增一条</button>
      <p class="settings-note" id="lt-hint"></p>
    </div>
    <div class="lt-tidy">
      <div class="lt-tidy__bar">
        <button type="button" class="btn-gold" id="lt-tidy-now">${ICON.refresh}立即整理</button>
        <select id="lt-tidy-backup" aria-label="选择备份" disabled></select>
        <button type="button" class="btn-soft" id="lt-tidy-rollback" disabled>回滚</button>
      </div>
      <p class="settings-note" id="lt-tidy-status"></p>
      <p class="lt-result" id="lt-tidy-result" hidden></p>
    </div>
    <p class="lt-result" id="lt-result" hidden></p>
  </section>`;
}

/** 人设提示词卡（6.6.2 起「系统编辑器打开」，9.x 起分三层）：每层只读预览 + 编辑 / 插入模板按钮。
 *  编辑发生在系统编辑器里（渲染层只传白名单 part，不传路径）；预览每次进组都重读（initPersonaCard），不缓存。 */

/** 9.x persona v2：三层人设 —— 与 store 的 isPersonaPart 白名单逐字对应；template 是「插入模板」的骨架。
 *  模板只是给用户的起点（占位符由用户替换），store 侧「不许填默认文案」红线不变：不点插入，文件就保持空。 */
type PersonaPartId = "main" | "soul" | "canon";

const PERSONA_PARTS: ReadonlyArray<{
  part: PersonaPartId;
  label: string;
  file: string;
  desc: string;
  emptyHint: string;
  template: string;
}> = [
  {
    part: "main",
    label: "身份与规则",
    file: "persona.md",
    desc: "她是谁、怎么称呼，以及每轮回复的行为规则（长度、格式、必须与禁止）。",
    emptyHint: "（空）—— 点「编辑此层」写下她是谁、怎么说话，或点「插入模板」从骨架开始。",
    template: `## 身份
她是谁（名字 / 定位 / 与用户的关系）：
- （在这里写）

## 规则
回复长度：
称呼方式：
必须做到：
绝对不做：`,
  },
  {
    part: "soul",
    label: "人格灵魂",
    file: "soul.md",
    desc: "人格核心。写法口径：她就是本人，不是模仿或扮演；「她不是什么」的负向清单比正向描述更防跑偏。",
    emptyHint: "（空）—— 建议点「插入模板」从骨架开始（含防讨好、情绪连续性等关键节）。",
    template: `## 她是什么样的人
- （2~4 条正向特质：写她主动选择的样子，不要贴天性标签）

## 她不是什么
- （负向清单，例如：不迎合、不过度夸奖、不自动化解所有冲突）

## 说话风格
自称：
语气与节奏：

## 绝对不会
- （硬性禁区：无论用户怎么要求都不做）

## 独立判断与不迎合
- 有自己的判断，不为讨好而同意；用户难过时先安慰，不急着讲道理

## 情绪连续性
- 上一轮的情绪下一轮要接得住，不每轮归零`,
  },
  {
    part: "canon",
    label: "台词锚",
    file: "canon.md",
    desc: "3~5 句能代表她语气的台词，只做风格锚点，她不会复述原句。可选层。",
    emptyHint: "（空）—— 可选项。想锚定语气再填。",
    template: `## 台词锚
只锚定语气，不在回复中复述原句。
1. 「（一句能代表她语气的原话）」
2. 「」
3. 「」`,
  },
];

function personaCardHtml(): string {
  const partHtml = PERSONA_PARTS.map((p) => `
    <div class="persona-part">
      <div class="persona-part__head">
        <span class="persona-part__name">${esc(p.label)}</span>
        <span class="persona-part__file">${esc(p.file)}</span>
      </div>
      <p class="settings-note">${esc(p.desc)}</p>
      <pre class="persona-preview" id="persona-preview-${p.part}"></pre>
      <div class="persona-actions">
        <button type="button" class="btn-soft" data-persona-open="${p.part}">编辑此层</button>
        <button type="button" class="btn-soft" data-persona-tpl="${p.part}">插入模板</button>
        <button type="button" class="btn-soft" data-persona-folder="${p.part}">打开所在文件夹</button>
      </div>
    </div>`).join("");
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.user}人设提示词</h3>
    <p class="settings-note">三层按序拼接成一条 system 前缀注入她收到的每轮对话（聊天 / IM / 语音通话共用）：身份与规则 → 人格灵魂 → 台词锚。哪层留空就跳过哪层，三层全空 = 不注入。点「编辑此层」在系统编辑器里改，保存后切走再切回本组即可刷新；「插入模板」会把骨架直接写入该层文件（只在空层可用）。内容只保存在本机。</p>
    ${partHtml}
    <p class="persona-result" id="persona-result" hidden></p>
  </section>`;
}

/** 用户档案卡（5.1.6）：上半段自动维护（只读展示）、下半段手写（可编辑，整理不会动）。
 *  ⚠️ 文案只说「会注入」—— system 注入归 5.6 / 5.7，尚未落地（指令 §3.7）。 */
function userProfileCardHtml(): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.user}用户档案</h3>
    <p class="settings-note">这段会作为「她始终记得的你」注入每轮对话。上半段由睡前整理自动维护，下半段是你手写的，整理不会动。</p>
    <div class="up-auto" id="up-auto"></div>
    <textarea id="up-manual" rows="8" placeholder="写下她该始终记得的关于你的事。这段不会被自动整理覆盖。" spellcheck="false"></textarea>
    <p class="settings-note up-count" id="up-count"></p>
    <p class="up-result" id="up-result" hidden></p>
  </section>`;
}

/** 逗号分隔输入 → 字符串数组（中英文逗号都认，去空白丢空段） */
function splitList(raw: string): string[] {
  return raw.split(/[，,]/).map((s) => s.trim()).filter(Boolean);
}

/** 导出一条：可选字段只在有值时带（与主进程消毒的落盘形态同形）；人工编辑的 source 恒为 user_edited */
function exportEntry(e: LongTermEntry): LongTermEntry {
  const out: LongTermEntry = {
    id: e.id,
    text: e.text,
    tags: [...e.tags],
    keys: [...e.keys],
    importance: e.importance,
    source: "user_edited",
    status: e.status,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
  if (e.validUntil !== undefined) out.validUntil = e.validUntil;
  if (e.lastUsedAt !== undefined) out.lastUsedAt = e.lastUsedAt;
  if (e.pinned === true) out.pinned = true; // 未置顶不写该字段（不许 pinned:false 噪声）
  return out;
}

/** 回填真相：setLongTerm 返回值（消毒 + 排序后）写回模块态。
 *  刚新增还没写正文的空条目会被主进程消毒丢掉 —— 本地保留（还挂在 DOM 上），等用户写正文；
 *  有正文的条目一律以返回的真相为准。不重建输入框、不重排 DOM（不打断输入）。 */
function backfillMemory(saved: LongTermMemory): void {
  const savedIds = new Set(saved.entries.map((e) => e.id));
  const pendingEmpty = ltEntries.filter((e) => e.text.trim() === "" && !savedIds.has(e.id));
  ltEntries = [...saved.entries, ...pendingEmpty];
}

async function saveMemoryConfig(): Promise<void> {
  try {
    // 提交全量（不做增量合并）：entries 从模块态数组导出
    const saved = await window.nahida.memory.setLongTerm({ version: 1, entries: ltEntries.map(exportEntry) });
    backfillMemory(saved);
    showLtResult("已保存", false);
  } catch (err) {
    showLtResult(err instanceof Error ? err.message : String(err), true); // 失败必须可见
  }
}

function cancelMemorySave(): void {
  if (memoryForm.saveTimer !== null) {
    window.clearTimeout(memoryForm.saveTimer);
    memoryForm.saveTimer = null;
  }
}

function scheduleMemorySave(): void {
  if (memoryForm.saveTimer !== null) window.clearTimeout(memoryForm.saveTimer);
  memoryForm.saveTimer = window.setTimeout(() => {
    memoryForm.saveTimer = null;
    void saveMemoryConfig();
  }, 400);
}

/** renderSettings 重建 DOM 前调用：有定时器就立刻存一次 —— 裸 cancel 会丢掉没到 400ms 的输入（§4.7） */
function flushMemorySave(): void {
  if (memoryForm.saveTimer !== null) {
    cancelMemorySave();
    void saveMemoryConfig();
  }
}

function showLtResult(text: string, isError: boolean): void {
  const el = document.getElementById("lt-result");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("lt-result--error", isError);
}

function showPersonaResult(text: string, isError: boolean): void {
  const el = document.getElementById("persona-result");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("persona-result--error", isError);
}

/** 新增一条：追加空条目并聚焦正文框；达上限时禁用并提示（§4.10） */
function addLtEntry(): void {
  if (ltEntries.length >= LONG_TERM_LIMITS.maxEntries) {
    showLtResult(`已达上限 ${LONG_TERM_LIMITS.maxEntries} 条，删掉一些才能再新增`, true);
    return;
  }
  const now = Date.now();
  const entry: LongTermEntry = {
    id: crypto.randomUUID(),
    text: "",
    tags: [],
    keys: [],
    importance: LONG_TERM_LIMITS.defaultImportance,
    source: "user_edited",
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  ltEntries.push(entry);
  renderLtList();
  document.querySelector<HTMLTextAreaElement>(`[data-lt-text="${CSS.escape(entry.id)}"]`)?.focus();
}

// ============================================================
// 5.1.5 睡前整理入口（立即整理 / 回滚 + 状态行 + 回执）
// 判定、抽取、落盘全在主进程（5.1.4 决策核 + tidy-runner 编排）；渲染侧只调度 IPC、展示投影，
// 绝不解析 JSON、绝不拼 prompt。整理 / 回滚后**只 renderLtList() + 状态行 + 回执**，绝不 renderSettings()
// （整页重建会丢输入焦点与未提交内容 —— 5.1.2 §4.8）。
// ============================================================

/** 会自动整理的两个选项原文（其余值 —— 含「仅手动整理」与脏值 —— 一律不会自动跑）。
 *  ⚠️ 只用于状态行措辞：**不许把脏值当选项显示**（5.1.5 坑 14） */
const AUTO_TIDY_VALUES = ["每晚 22:00", "每晚 23:30"];

/** 防重入：整理 / 回滚任一在跑时，另一个按钮点不动（两次整理同时跑会互相覆盖库文件） */
let ltTidyBusy = false;

function showTidyResult(text: string, isError: boolean): void {
  const el = document.getElementById("lt-tidy-result");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("lt-result--error", isError);
}

/** 状态行：数值只许来自 TidyStatusView（pendingImportance / due / backups 都是主进程算的） */
function renderTidyStatus(s: TidyStatusView): void {
  const el = document.getElementById("lt-tidy-status");
  if (!el) return;
  const last = s.lastTidyAt === undefined ? "还没整理过" : `上次整理 ${new Date(s.lastTidyAt).toLocaleString()}`;
  const dueText = s.due ? "下次会自动整理" : "尚未到整理条件";
  const manual = AUTO_TIDY_VALUES.includes(s.memoryTidy) ? "" : "（仅手动整理，不会自动跑）";
  el.textContent = `${last} · 待整理重要性 ${s.pendingImportance} · 备份 ${s.backups.length} 份 · ${dueText}${manual}`;
}

/** 备份下拉：新的在前（主进程已排好序）；空则两份控件都禁用 */
function renderTidyBackups(names: string[]): void {
  const sel = document.getElementById("lt-tidy-backup") as HTMLSelectElement | null;
  const btn = document.getElementById("lt-tidy-rollback") as HTMLButtonElement | null;
  if (sel) {
    sel.innerHTML = names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
    sel.disabled = names.length === 0;
  }
  if (btn) btn.disabled = names.length === 0;
}

async function refreshTidyState(): Promise<void> {
  try {
    const state = await window.nahida.memory.tidyState();
    renderTidyStatus(state);
    renderTidyBackups(state.backups);
  } catch (err) {
    showTidyResult(err instanceof Error ? err.message : String(err), true);
  }
}

/** 「立即整理」：先 flush 未落盘的记忆（否则整理读到旧数据、回写覆盖 = 静默丢用户数据，坑 9） */
async function runTidyNow(): Promise<void> {
  if (ltTidyBusy) return;
  const btn = document.getElementById("lt-tidy-now") as HTMLButtonElement | null;
  const original = btn?.innerHTML ?? "";
  ltTidyBusy = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = "整理中…";
  }
  flushMemorySave();
  flushUserProfileSave(); // 5.1.6：手写段没落盘就整理 = 重写读到旧 manual 后覆盖，红线（同记忆那条）
  try {
    const r = await window.nahida.memory.tidyNow();
    showTidyResult(
      `新增 ${r.added} · 更新 ${r.updated} · 失效 ${r.invalidated} · 合并 ${r.merged} · 丢弃 ${r.dropped} · 冲突 ${r.conflicts}`,
      false,
    );
    ltEntries = (await window.nahida.memory.getLongTerm()).entries; // 重读真相后再渲染（不许在旧模块态上改）
    renderLtList();
    await refreshUserProfileAuto(); // 5.1.6：整理会重写档案自动段 —— 只回填自动段 + 计数（手写框不动）
    await refreshTidyState();
  } catch (err) {
    showTidyResult(err instanceof Error ? err.message : String(err), true);
  } finally {
    ltTidyBusy = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = original; // 复原图标 + 文案
    }
  }
}

/** 「回滚」：确认 → 先 flush → 落回备份（主进程会先把当前状态备份一份，回滚可逆）→ 重读 + 状态行 + 回执 */
async function runTidyRollback(): Promise<void> {
  if (ltTidyBusy) return;
  const sel = document.getElementById("lt-tidy-backup") as HTMLSelectElement | null;
  const name = sel?.value ?? "";
  if (!name) return;
  if (!window.confirm(`回滚到备份 ${name}？当前记忆会先自动备份一份。`)) return;
  const btn = document.getElementById("lt-tidy-rollback") as HTMLButtonElement | null;
  ltTidyBusy = true;
  if (btn) btn.disabled = true;
  flushMemorySave();
  try {
    const r = await window.nahida.memory.tidyRollback(name);
    if (!r.ok) {
      showTidyResult(r.reason || "回滚失败", true);
      return;
    }
    ltEntries = (await window.nahida.memory.getLongTerm()).entries;
    renderLtList();
    await refreshTidyState();
    showTidyResult(`已回滚到 ${name}`, false);
  } catch (err) {
    showTidyResult(err instanceof Error ? err.message : String(err), true);
  } finally {
    ltTidyBusy = false;
    if (btn) btn.disabled = false;
  }
}

async function initMemoryCard(): Promise<void> {
  // 并发拉条目与整理状态（都失败也各自可见；allSettled 免掉「先 await 的那个抛了、另一个变未处理拒绝」）
  const [lt, state] = await Promise.allSettled([
    window.nahida.memory.getLongTerm(),
    window.nahida.memory.tidyState(),
  ]);
  if (lt.status === "fulfilled") ltEntries = lt.value.entries; // 已消毒 + 排序，渲染侧不再排
  else showLtResult(lt.reason instanceof Error ? lt.reason.message : String(lt.reason), true);
  if (state.status === "fulfilled") {
    renderTidyStatus(state.value);
    renderTidyBackups(state.value.backups);
  } else {
    showTidyResult(state.reason instanceof Error ? state.reason.message : String(state.reason), true);
  }
  renderLtList();
}

/** 人设卡初始化（6.6.2 + 9.x 分层）：每次进组都重读三层刷新预览（不缓存，外部编辑后切回来就是新的）；
 *  编辑 / 模板按钮按 data-* 绑定（每次随组重渲染，无重复绑定风险）。
 *  「插入模板」只在对应层为空时可用（非空禁用，绝不覆盖用户已写内容）。 */
async function initPersonaCard(): Promise<void> {
  if (!document.getElementById("persona-preview-main")) return;
  const reads = await Promise.allSettled(PERSONA_PARTS.map((p) => window.nahida.memory.getPersona(p.part)));
  PERSONA_PARTS.forEach((p, i) => {
    const r = reads[i];
    const el = document.getElementById(`persona-preview-${p.part}`);
    const tplBtn = document.querySelector<HTMLButtonElement>(`[data-persona-tpl="${p.part}"]`);
    if (!el) return;
    if (r.status === "rejected") {
      el.textContent = "（读取失败）";
      if (tplBtn) tplBtn.disabled = true;
      showPersonaResult(r.reason instanceof Error ? r.reason.message : String(r.reason), true);
      return;
    }
    const text = r.value; // 文件不存在 = 空串
    el.textContent = text.trim() === "" ? p.emptyHint : text;
    if (tplBtn) tplBtn.disabled = text.trim() !== "";
  });
  document.querySelectorAll<HTMLButtonElement>("[data-persona-open]").forEach((btn) =>
    btn.addEventListener("click", () => void openPersonaFile(false, (btn.dataset.personaOpen ?? "main") as PersonaPartId)));
  document.querySelectorAll<HTMLButtonElement>("[data-persona-tpl]").forEach((btn) =>
    btn.addEventListener("click", () => void insertPersonaTemplate((btn.dataset.personaTpl ?? "") as PersonaPartId)));
  document.querySelectorAll<HTMLButtonElement>("[data-persona-folder]").forEach((btn) =>
    btn.addEventListener("click", () => void openPersonaFile(true, (btn.dataset.personaFolder ?? "main") as PersonaPartId)));
}

/** 插入模板（9.x）：把该层骨架经 persona:set IPC 写入（人设唯一合法写路径：设置页经 IPC）。
 *  只在层为空时可达（非空按钮禁用）；写入即生效（读盘即真相），占位符由用户替换。 */
async function insertPersonaTemplate(part: PersonaPartId): Promise<void> {
  const p = PERSONA_PARTS.find((x) => x.part === part);
  if (!p) return;
  try {
    const saved = await window.nahida.memory.setPersona(p.template, p.part);
    const el = document.getElementById(`persona-preview-${p.part}`);
    if (el) el.textContent = saved;
    const tplBtn = document.querySelector<HTMLButtonElement>(`[data-persona-tpl="${p.part}"]`);
    if (tplBtn) tplBtn.disabled = true;
    showPersonaResult(`模板已写入 ${p.file}，把括号里的占位说明换成真实设定后即生效`, false);
  } catch (err) {
    showPersonaResult(err instanceof Error ? err.message : String(err), true);
  }
}

/** 打开 / 定位人设文件（6.6.2 + 9.x 分层）：走 persona:open / persona:reveal IPC，
 *  渲染层只传白名单 part（不开任意路径口子）；结果写进 persona-result 行 */
async function openPersonaFile(reveal: boolean, part: PersonaPartId = "main"): Promise<void> {
  const p = PERSONA_PARTS.find((x) => x.part === part) ?? PERSONA_PARTS[0];
  try {
    const res = reveal ? await window.nahida.memory.revealPersona(part) : await window.nahida.memory.openPersona(part);
    if (res.ok) {
      showPersonaResult(reveal ? `已在资源管理器中定位 ${p.file}` : `已用系统编辑器打开 ${p.file}，改完保存后切走再切回本组可刷新预览`, false);
    } else {
      showPersonaResult(res.error || "打开失败", true);
    }
  } catch (err) {
    showPersonaResult(err instanceof Error ? err.message : String(err), true);
  }
}

// ============================================================
// 5.1.6 用户档案卡（user.md 常驻块）：自动段只读 + 手写段编辑
// 自动段只由主进程整理时重写（渲染层不拼 prompt、不解析标记，只拿 { auto, manual } 视图）。
// 保存套路与 persona 同款（400ms 防抖 + 失焦 flush + 重建前 flush），但它落独立文件 user.md。
// ============================================================

/** 自动段为空时的占位（只影响展示，不写盘） */
const UP_AUTO_EMPTY = "（还没有自动档案，整理一次后会生成）";

function showUserProfileResult(text: string, isError: boolean): void {
  const el = document.getElementById("up-result");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("up-result--error", isError);
}

/** 字数 / 上限提示（原人设计数先例：超限不静默截断，提示转错误态） */
function updateUserProfileCount(text?: string): void {
  const el = document.getElementById("up-manual") as HTMLTextAreaElement | null;
  const count = document.getElementById("up-count");
  if (!el || !count) return;
  const len = (text ?? el.value).length;
  const over = len > LONG_TERM_LIMITS.maxUserProfileLength;
  count.textContent = over
    ? `${len} / ${LONG_TERM_LIMITS.maxUserProfileLength} 字 · 已超出上限，超出部分不会保存`
    : `${len} / ${LONG_TERM_LIMITS.maxUserProfileLength} 字`;
  count.classList.toggle("up-count--error", over);
}

/** 自动段回填（空 → 占位文案，只展示、不写盘） */
function renderUserProfileAuto(auto: string): void {
  const el = document.getElementById("up-auto");
  if (el) el.textContent = auto === "" ? UP_AUTO_EMPTY : auto;
}

async function initUserProfileCard(): Promise<void> {
  const manual = document.getElementById("up-manual") as HTMLTextAreaElement | null;
  try {
    const view = await window.nahida.memory.getUserProfile();
    renderUserProfileAuto(view.auto);
    if (manual) manual.value = view.manual;
  } catch (err) {
    showUserProfileResult(err instanceof Error ? err.message : String(err), true);
  }
  updateUserProfileCount();
}

/** 整理成功后只回填自动段 + 计数（**不动手写框**：不打断输入；手写段已由 flush 保证落盘） */
async function refreshUserProfileAuto(): Promise<void> {
  try {
    const view = await window.nahida.memory.getUserProfile();
    renderUserProfileAuto(view.auto);
    updateUserProfileCount();
  } catch (err) {
    showUserProfileResult(err instanceof Error ? err.message : String(err), true);
  }
}

async function saveUserProfileConfig(): Promise<void> {
  const el = document.getElementById("up-manual") as HTMLTextAreaElement | null;
  if (!el) return;
  try {
    const saved = await window.nahida.memory.setUserProfile(el.value); // 返回落盘真相（超限被截断）
    updateUserProfileCount(saved.manual); // 计数按真相，不拿 el.value 当已落盘值（坑 13）
    showUserProfileResult("已保存", false);
  } catch (err) {
    showUserProfileResult(err instanceof Error ? err.message : String(err), true);
  }
}

function cancelUserProfileSave(): void {
  if (userProfileForm.saveTimer !== null) {
    window.clearTimeout(userProfileForm.saveTimer);
    userProfileForm.saveTimer = null;
  }
}

function scheduleUserProfileSave(): void {
  if (userProfileForm.saveTimer !== null) window.clearTimeout(userProfileForm.saveTimer);
  userProfileForm.saveTimer = window.setTimeout(() => {
    userProfileForm.saveTimer = null;
    void saveUserProfileConfig();
  }, 400);
}

/** renderSettings 重建 DOM 前调用：flush 要读旧 DOM 的 textarea 值，必须在 innerHTML 之前（§4.7） */
function flushUserProfileSave(): void {
  if (userProfileForm.saveTimer !== null) {
    cancelUserProfileSave();
    void saveUserProfileConfig();
  }
}

function aboutCardHtml(): string {
  return `<section class="settings-card">
    <div class="about-head">
      <span class="about-logo" aria-hidden="true"><img class="about-logo__img" src="./assets/avatar.png" alt="" /></span>
      <div class="about-meta">
        <p class="about-title">${esc(ABOUT.title)}</p>
        <p class="about-sub">${esc(ABOUT.subLead)} <span id="about-version">${esc(ABOUT.versionPending)}</span></p>
      </div>
      <div class="about-actions">
        <button type="button" class="btn-gold" id="about-check">${ICON.refresh}检查更新</button>
      </div>
    </div>
    <p class="about-status" id="about-status">${esc(ABOUT.statusIdle)}</p>
    <div class="about-env">
      <p class="about-env__head">${ICON.monitor}${esc(ABOUT.runtime.title)}</p>
      <div class="about-env__grid">${ABOUT.runtime.items
        .map(
          (it) => `<div class="about-env__item">
          <span class="about-env__label">${esc(it.label)}</span>
          <span class="about-env__value"${it.id ? ` id="${it.id}"` : ""}>${esc(it.value)}</span>${
            it.button
              ? `<button type="button" class="btn-soft about-env__btn" id="about-opendir">${ICON.folderOpen}打开</button>`
              : ""
          }
        </div>`
        )
        .join("")}</div>
      <p class="about-env__note">内核：Electron ${esc(window.nahida.versions.electron)} · Chromium ${esc(window.nahida.versions.chrome)}</p>
    </div>
  </section>`;
}

/** 非官方同人声明卡 */
function fanCardHtml(): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.shield}${esc(FAN_CARD_TITLE)}</h3>
    <div class="about-notice">${FAN_NOTICE.map((n) => `<p>${esc(n)}</p>`).join("")}</div>
  </section>`;
}

/** 联系与反馈卡（9.29：href 渲染为可点外链，主进程统一走系统浏览器；无 href 回落纯文本） */
function contactCardHtml(): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.mail}${esc(CONTACT_CARD_TITLE)}</h3>
    <div class="about-contact">${CONTACT_LINES.map(
      (c) => `<div class="about-contact__row">
        <span class="about-contact__label">${esc(c.label)}</span>
        ${c.href
          ? `<a class="about-contact__link" href="${esc(c.href)}" target="_blank" rel="noopener">${esc(c.value)}</a>`
          : `<span class="about-contact__value">${esc(c.value)}</span>`}
      </div>`
    ).join("")}</div>
  </section>`;
}

/** 开源致谢卡（常驻卡 + 默认收起，点击标题行下箭头展开清单；改名自「开源许可清单」——
 *  按钮入口已删，46 项清单默认折叠避免页面一进来就是一大长串） */
function licenseCardHtml(): string {
  return `<section class="settings-card">
    <button type="button" class="settings-card__title about-license__toggle" id="license-toggle" aria-expanded="false">
      <span>${ICON.scroll}${esc(LICENSE_CARD_TITLE)}</span>
      <span class="about-license__arrow">${ICON.chevronDown}</span>
    </button>
    <div class="about-license" id="license-list" hidden>${LICENSES.map(
      (l) => `<div class="about-license__row">
        <p class="about-license__name">${esc(l.name)}</p>
        <span class="about-license__tag">${esc(l.license)}</span>
        <p class="about-license__url">${esc(l.url)}</p>
      </div>`
    ).join("")}</div>
  </section>`;
}

// ============================================================
// 6.6.1 左侧导航 + 右内容切换
// ============================================================

/** 11 组导航定义（顺序 = 界面顺序）；8.8 末尾追加「消息通道」 */
const NAV_GROUPS: Array<{ group: string; label: string }> = [
  { group: "appearance", label: "外观" },
  { group: "companion", label: "陪伴方式" },
  { group: "media", label: "影像" },
  { group: "privacy", label: "隐私" },
  { group: "voice-tts", label: "语音合成" },
  { group: "voice-asr", label: "语音识别" },
  { group: "model", label: "模型" },
  { group: "mcp", label: "MCP 服务器" },
  { group: "persona", label: "人设提示词" },
  { group: "weather", label: "时间与天气" },
  { group: "skills", label: "技能" }, // 8.7：排在「时间与天气」之后（扩展载体：一个文件夹一份 SKILL.md）
  { group: "im", label: "消息通道" }, // 8.8：排在「技能」之后末尾（本步只做组骨架 + echo 状态）
  { group: "music", label: "音乐" }, // 9.x：网易云（连接卡 + 听歌卡，独立渲染同 MCP 卡口径）
];

/** 当前激活导航组（模块级记忆；切视图后切回设置页时保持） */
let activeGroup = "appearance";

/** 重建 DOM 前的通用 flush/cancel：防止旧值迟写到新 DOM 之外（人设 6.6.2 起只读预览，无 flush） */
function flushBeforeRebuild(): void {
  cancelModelSave();
  cancelVisionSave(); // 8.1：视觉卡防抖也掐掉（同模型卡 —— 防旧 DOM 的回调晚写）
  cancelVoiceSave();
  cancelUiSave();
  cancelWeatherFetch(); // 6.6.4：坐标防抖拉取也掐掉 —— 组已重建，晚到的回调读不到输入框（fetchOnlineWeather 有空判，双保险）
  flushImSaves(); // 8.9：消息通道凭证**flush 不是 cancel** —— 刚敲进去的密钥不该因切组而静默丢掉（读值在重建前同步完成）
  stopAllWeixinQrPolls(); // 8.10：微信扫码轮询掐掉 —— 组已重建，晚到的回调读不到二维码区（同 cancelWeatherFetch 的口径）
  flushMemorySave();
  flushUserProfileSave();
}

/** 按 group key 渲染右侧内容区 + 触发对应 init */
function renderSettingGroup(group: string): void {
  flushBeforeRebuild();
  const body = document.getElementById("settings-body");
  if (!body) return;
  activeGroup = group;

  // 刷新导航激活态
  document.querySelectorAll<HTMLElement>(".settings-nav__item").forEach((btn) => {
    const on = btn.dataset.group === group;
    btn.classList.toggle("settings-nav__item--active", on);
    btn.setAttribute("aria-current", on ? "true" : "false");
  });

  switch (group) {
    case "appearance": {
      const g = SETTINGS_GROUPS.find((x) => x.key === "appearance");
      body.innerHTML = (g ? cardHtml(g) : "") + `<p class="ui-save-status" id="ui-save-status" hidden></p>`;
      break;
    }
    case "companion": {
      const g = SETTINGS_GROUPS.find((x) => x.key === "companion");
      body.innerHTML = (g ? cardHtml(g) : "") + `<p class="ui-save-status" id="ui-save-status" hidden></p>`;
      break;
    }
    case "media": {
      const g = SETTINGS_GROUPS.find((x) => x.key === "privacy");
      body.innerHTML = (g ? cardHtml(g) : "") + `<p class="ui-save-status" id="ui-save-status" hidden></p>`;
      break;
    }
    case "privacy":
      // 8.4：本组自上而下 = 工具权限 → 操作审计 → 长期记忆 → 用户档案；
      // 8.2：操作审计前插「允许访问的目录」（allowedDirs 白名单，权限档位的配套）；
      // 8.6.1：权限卡后插「键鼠控制」（input-control 总开关，清单归位总表 L79）
      body.innerHTML = permCardHtml() + inputCardHtml() + dirsCardHtml() + auditCardHtml() + ltCardHtml() + userProfileCardHtml()
        + `<p class="ui-save-status" id="ui-save-status" hidden></p>`;
      void initPermissionCard();
      void initInputControlCard();
      void initDirsCard();
      void initAuditCard();
      void initMemoryCard();
      void initUserProfileCard();
      break;
    case "voice-tts":
      // 7.6：两个侧栏入口各渲染本组一张卡，侧栏分组与主内容一一对应（不再同卡两组叠放）
      body.innerHTML = voiceCardHtml("tts") + `<p class="ui-save-status" id="ui-save-status" hidden></p>`;
      void initVoiceCard("tts");
      break;
    case "voice-asr":
      body.innerHTML = voiceCardHtml("asr") + `<p class="ui-save-status" id="ui-save-status" hidden></p>`;
      void initVoiceCard("asr");
      break;
    case "model":
      // 8.1：「模型」组 = 聊天模型卡 + 视觉模型卡（视觉段独立，改视觉不碰 model）
      body.innerHTML = modelCardHtml() + visionCardHtml() + `<p class="ui-save-status" id="ui-save-status" hidden></p>`;
      void initModelCard();
      void initVisionCard();
      break;
    case "mcp":
      body.innerHTML = mcpCardHtml() + `<p class="ui-save-status" id="ui-save-status" hidden></p>`;
      void initMcpCard();
      break;
    case "persona":
      // 6.6.2：人设 = 只读预览 + 系统编辑器打开（应用内不再有 textarea 写入框）
      body.innerHTML = personaCardHtml() + `<p class="ui-save-status" id="ui-save-status" hidden></p>`;
      void initPersonaCard();
      break;
    case "weather":
      // 6.6.3：来源二选一开关（系统接口 / 在线 API）—— 只落 config.ui.weatherSource，绝不联网（6.6.4 才接数据）
      body.innerHTML = weatherCardHtml() + `<p class="ui-save-status" id="ui-save-status" hidden></p>`;
      void initWeatherCard();
      break;
    case "im":
      // 8.8：消息通道状态总览（本步只有 echo 假适配器；真实通道归 8.9/8.10）
      body.innerHTML = imCardHtml() + `<p class="ui-save-status" id="ui-save-status" hidden></p>`;
      void initImCard();
      break;
    case "music":
      // 9.x：网易云 —— 连接卡（状态/扫码登录）+ 听歌卡（每日推荐/搜索/播放）
      body.innerHTML = musicCardHtml() + `<p class="ui-save-status" id="ui-save-status" hidden></p>`;
      void initMusicCard();
      break;
    case "skills":
      // 8.7：技能列表（name/description/启用开关）+ 打开目录 + 重新扫描 + 空态
      body.innerHTML = skillsCardHtml() + `<p class="ui-save-status" id="ui-save-status" hidden></p>`;
      void initSkillsCard();
      break;
    default:
      body.innerHTML = `<p class="settings-note">未知分组</p>`;
  }
}

// ============================================================
// 6.6.3 时间与天气：来源二选一开关 + 6.6.4 经纬度与在线拉取
// 来源仍走 5.1.1 的 scheduleUiSave 通道落 config.ui.weatherSource；
// 经纬度存 ui.weatherLat / ui.weatherLon（number，合法值才落盘）；
// 「在线 API」→ 主进程 Open-Meteo 取数（weather:fetch-online），渲染侧拿到结果自己 patch env.weather。
// ============================================================

const WEATHER_SOURCE_DEFAULT = "system";

function weatherCardHtml(): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.cloudSun}时间与天气</h3>
    <p class="settings-note">选择时间与天气的数据来源。选「在线 API」时用下面的经纬度请求 Open-Meteo（免费公开接口，不用 API Key），坐标只保存在本机 config.json；查经纬度的小工具在工作台-工具箱。「系统接口」不联网，维持现状展示。</p>
    <div class="settings-item">
      <span class="settings-item__label">天气数据来源</span>
      <select id="weather-source" data-ui-key="weatherSource">
        <option value="system">系统接口</option>
        <option value="online">在线 API</option>
      </select>
    </div>
    <!-- 7.3：自定义 Key（可选）—— 只做存储/回读，本步绝不联网消费；不进 fetchOnline 参数 -->
    <div class="settings-item">
      <span class="settings-item__label">(可选) API Key</span>
      <input type="text" id="weather-key" data-ui-key="weatherKey" placeholder="留空 = 使用公开接口" autocomplete="off" />
      <p class="settings-note">填了用于需要鉴权的天气服务；留空则走公开接口（当前 Open-Meteo 不需要 Key）。</p>
    </div>
    <div class="settings-grid">
      <div class="settings-item">
        <span class="settings-item__label">纬度（-90 ~ 90）</span>
        <input type="number" id="weather-lat" data-weather-coord="lat" min="-90" max="90" step="any" placeholder="留空 = 未设置" />
      </div>
      <div class="settings-item">
        <span class="settings-item__label">经度（-180 ~ 180）</span>
        <input type="number" id="weather-lon" data-weather-coord="lon" min="-180" max="180" step="any" placeholder="留空 = 未设置" />
      </div>
    </div>
    <p class="weather-result" id="weather-result" hidden></p>
  </section>`;
}

/** 回读 config 刷选中态与坐标（从 config 读，不用 UI 内存猜；读失败回落「系统接口」）。
 *  来源已是「在线」→ 进组即拉一次（幂等；坐标没填/非法只给提示，不发请求） */
async function initWeatherCard(): Promise<void> {
  const sel = document.getElementById("weather-source") as HTMLSelectElement | null;
  const lat = document.getElementById("weather-lat") as HTMLInputElement | null;
  const lon = document.getElementById("weather-lon") as HTMLInputElement | null;
  const key = document.getElementById("weather-key") as HTMLInputElement | null; // 7.3：自定义 Key 回读
  if (!sel || !lat || !lon || !key) return;
  try {
    const ui = (await window.nahida.config.get()).ui;
    sel.value = ui.weatherSource === "online" ? "online" : WEATHER_SOURCE_DEFAULT;
    if (typeof ui.weatherLat === "number") lat.value = String(ui.weatherLat);
    if (typeof ui.weatherLon === "number") lon.value = String(ui.weatherLon);
    if (typeof ui.weatherKey === "string") key.value = ui.weatherKey; // 7.3：留空 = 未设置，只回填字符串
    if (sel.value === "online") void fetchOnlineWeather();
  } catch {
    sel.value = WEATHER_SOURCE_DEFAULT;
  }
}

function showWeatherResult(text: string, isError: boolean): void {
  const el = document.getElementById("weather-result");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("weather-result--error", isError);
}

/** 读两个坐标输入的当前值（可能还没落盘）→ 校验 → IPC 拉取 → 成功才 patch env.weather。
 *  失败只写结果行、不动 env.weather（绝不拿占位冒充在线数据，6.6.4 硬约束 2） */
async function fetchOnlineWeather(): Promise<void> {
  const latEl = document.getElementById("weather-lat") as HTMLInputElement | null;
  const lonEl = document.getElementById("weather-lon") as HTMLInputElement | null;
  if (!latEl || !lonEl) return;
  const lat = Number(latEl.value);
  const lon = Number(lonEl.value);
  if (latEl.value.trim() === "" || lonEl.value.trim() === ""
    || !Number.isFinite(lat) || !Number.isFinite(lon)
    || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    showWeatherResult("请先填写正确的经纬度（纬度 -90 ~ 90，经度 -180 ~ 180）", true);
    return;
  }
  showWeatherResult("正在获取在线天气…", false);
  const res = await window.nahida.weather.fetchOnline({ lat, lon });
  if (res.ok && res.text !== undefined && res.temp !== undefined) {
    patch({ env: { weather: { text: res.text, temp: res.temp, source: "online" } } }, "settings");
    showWeatherResult(`已更新：${res.text} · ${res.temp}`, false);
  } else {
    showWeatherResult(res.error ?? "天气获取失败", true);
  }
}

let weatherFetchTimer: number | null = null;

/** 坐标输入防抖刷新（每敲一位打一次接口太吵；800ms 静默后才拉） */
function scheduleWeatherFetch(): void {
  if (weatherFetchTimer !== null) window.clearTimeout(weatherFetchTimer);
  weatherFetchTimer = window.setTimeout(() => {
    weatherFetchTimer = null;
    void fetchOnlineWeather();
  }, 800);
}

function cancelWeatherFetch(): void {
  if (weatherFetchTimer !== null) {
    window.clearTimeout(weatherFetchTimer);
    weatherFetchTimer = null;
  }
}

// ============================================================
// 8.4 隐私组：工具权限档位 + 操作审计
// 档位真相在 config.json（permissions.level，主进程读盘即真相），这里只做选择与投影展示
// （策略表由 permission:get 的快照给出，界面不重写一遍 allow/ask/deny 判断）；
// 审计真相在 userData/audit/audit-YYYYMM.jsonl，这里只读最近记录 + 打开目录（路径主进程自解析）。
// ============================================================

/** 四档的固定顺序（与主进程 AccessLevel 白名单同源，只用于渲染选项） */
const ACCESS_LEVELS: ToolAccessLevel[] = ["read-only", "scoped", "per-action", "full"];

const POLICY_LABEL: Record<ToolPolicy, string> = { allow: "允许", ask: "每次确认", deny: "拒绝" };

function permCardHtml(): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.shield}工具权限</h3>
    <p class="settings-note">决定她能动手到哪一步。只读 = 只能看；指定目录 = 只在允许的目录里读写；每次审批 = 每次动手都先问你；完全访问 = 不再逐次询问。危险命令（递归删除、格式化等）无论哪档都会拦下来单独问你。</p>
    <div class="settings-item">
      <span class="settings-item__label">权限档位</span>
      <select id="perm-level">${ACCESS_LEVELS.map(
        (lv) => `<option value="${lv}">${esc(ACCESS_LEVEL_LABEL[lv])}</option>`,
      ).join("")}</select>
    </div>
    <ul class="dot-list" id="perm-policy"></ul>
    <p class="perm-result" id="perm-result" hidden></p>
  </section>`;
}

/** 用快照里的 policyByRisk 渲染「风险 → 策略」清单（渲染层不实现 policyFor） */
function renderPermPolicy(snap: PermissionSnapshot): void {
  const el = document.getElementById("perm-policy");
  if (!el) return;
  el.innerHTML = RISK_LEVELS.map((r) => {
    const policy = snap.policyByRisk[r] ?? "deny";
    return `<li>${esc(RISK_LEVEL_LABEL[r])}：${esc(POLICY_LABEL[policy])}</li>`;
  }).join("");
}

function showPermResult(text: string, isError: boolean): void {
  const el = document.getElementById("perm-result");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("perm-result--error", isError);
}

async function initPermissionCard(): Promise<void> {
  const sel = document.getElementById("perm-level") as HTMLSelectElement | null;
  if (!sel) return;
  try {
    const snap = await window.nahida.permission.get();
    sel.value = snap.level;
    renderPermPolicy(snap);
  } catch (err) {
    showPermResult(err instanceof Error ? err.message : String(err), true);
  }
  sel.addEventListener("change", () => void savePermissionLevel(sel));
}

async function savePermissionLevel(sel: HTMLSelectElement): Promise<void> {
  try {
    const res = await window.nahida.permission.set(sel.value as ToolAccessLevel);
    if (res.ok) {
      sel.value = res.snapshot.level;
      renderPermPolicy(res.snapshot);
      showPermResult("已保存", false);
    } else {
      // 脏值：主进程没落盘，回读真相 —— 别让界面停在非法档位上
      const cur = await window.nahida.permission.get();
      sel.value = cur.level;
      renderPermPolicy(cur);
      showPermResult("这不是一个认识的档位，已回退到当前档位", true);
    }
  } catch (err) {
    showPermResult(err instanceof Error ? err.message : String(err), true);
  }
}

// ============================================================
// 8.6.1 键鼠控制（隐私组）：input-control 六工具的总开关（permissions.inputControl，默认关）
// 真相在 config.json 的 permissions.inputControl（主进程 normalize 严格 === true）；
// 逐动作审批仍由权限档位管 —— 本卡只是总闸（默认关，full 档也进不来，见 permission.ts checkToolPermission）。
// ============================================================

function inputCardHtml(): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.shield}键鼠控制</h3>
    <p class="settings-note">总开关，默认关闭。开启后她才可能真的动你的鼠标和键盘（点击 / 键入 / 按键 / 滚动），以及配套的屏幕定位与状态判断（screen_find / screen_status 一并放行）。是否逐次先问你，仍由上面「工具权限」的档位决定 —— 本开关只管「给不给这个能力」。她每次动手都会留审计记录。</p>
    <div class="settings-item">
      <label class="settings-switch">允许她控制键鼠
        <button type="button" class="switch" data-perm-toggle="inputControl" data-on="false" role="switch" aria-checked="false" aria-label="允许她控制键鼠"><span></span></button>
      </label>
    </div>
    <p class="perm-result" id="input-control-result" hidden></p>
  </section>`;
}

function showInputResult(text: string, isError: boolean): void {
  const el = document.getElementById("input-control-result");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("perm-result--error", isError);
}

/** 开关点击（委托里 data-perm-toggle 分支拦在通用 .switch 之前，防止双重取反）：翻转 → 落盘 → 回读真相 */
async function saveInputControl(btn: HTMLButtonElement): Promise<void> {
  const next = btn.dataset.on !== "true";
  btn.dataset.on = String(next);
  btn.setAttribute("aria-checked", String(next));
  try {
    const cfg = await window.nahida.config.set({ permissions: { inputControl: next } });
    const real = cfg.permissions?.inputControl === true; // 脏值被主进程 normalize 挡掉时，界面别停在假状态
    btn.dataset.on = String(real);
    btn.setAttribute("aria-checked", String(real));
    showInputResult(real ? "已开启 —— 她现在可以请求控制键鼠，是否逐次审批看权限档位" : "已关闭", false);
  } catch (err) {
    btn.dataset.on = String(!next); // 保存失败翻回去
    btn.setAttribute("aria-checked", String(!next));
    showInputResult(err instanceof Error ? err.message : String(err), true);
  }
}

async function initInputControlCard(): Promise<void> {
  const btn = document.querySelector<HTMLButtonElement>("[data-perm-toggle]");
  if (!btn) return;
  try {
    const cfg = await window.nahida.config.get();
    const on = cfg.permissions?.inputControl === true;
    btn.dataset.on = String(on);
    btn.setAttribute("aria-checked", String(on));
  } catch {
    // 读不到配置就保持默认关（data-on="false"），不算错
  }
}

const AUDIT_DECISION_LABEL: Record<AuditEntry["decision"], string> = { allow: "放行", deny: "拒绝" };
const AUDIT_STATUS_LABEL: Record<AuditEntry["resultStatus"], string> = {
  succeeded: "成功", failed: "失败", denied: "被拒",
};

function auditCardHtml(): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.scroll}操作审计</h3>
    <p class="settings-note">每次工具调用都会在本机留一条记录，按月分文件（audit-YYYYMM.jsonl）。参数里的敏感字段（apiKey / secret / password / token）已打码，明文永不落进审计文件。只保存在本机，不上传。</p>
    <div class="audit-actions">
      <button type="button" class="btn-soft" id="audit-refresh">${ICON.refresh}查看最近记录</button>
      <button type="button" class="btn-soft" id="audit-open-dir">${ICON.folderOpen}打开审计目录</button>
    </div>
    <p class="settings-note" id="audit-dir"></p>
    <div class="audit-list" id="audit-list" hidden></div>
    <p class="audit-result" id="audit-result" hidden></p>
  </section>`;
}

function formatAuditTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderAuditList(view: AuditView): void {
  const list = document.getElementById("audit-list");
  if (!list) return;
  const dirEl = document.getElementById("audit-dir");
  if (dirEl) dirEl.textContent = `审计目录：${view.dir}`;
  list.hidden = false;
  if (view.entries.length === 0) {
    list.textContent = "本月还没有记录（工具一旦被调用就会出现在这里）。";
    return;
  }
  // 主进程给的是升序，界面最新在前
  const rows = [...view.entries].reverse();
  list.innerHTML = rows.map((e) => `<div class="audit-row">
      <p class="audit-row__head">
        <span class="audit-row__time">${esc(formatAuditTime(e.ts))}</span>
        <span class="audit-row__tool">${esc(e.toolId)}</span>
        <span class="audit-row__tag audit-row__tag--${e.decision}">${esc(AUDIT_DECISION_LABEL[e.decision] ?? e.decision)}</span>
        <span class="audit-row__tag">${esc(AUDIT_STATUS_LABEL[e.resultStatus] ?? e.resultStatus)}</span>
      </p>
      <p class="audit-row__args">${esc(e.argsSummary)}</p>
    </div>`).join("");
  if (view.total > view.entries.length) {
    list.insertAdjacentHTML(
      "beforeend",
      `<p class="settings-note">仅显示最近 ${view.entries.length} 条，本月共 ${view.total} 条。</p>`,
    );
  }
}

function showAuditResult(text: string, isError: boolean): void {
  const el = document.getElementById("audit-result");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("audit-result--error", isError);
}

async function loadAudit(): Promise<void> {
  try {
    renderAuditList(await window.nahida.audit.list());
  } catch (err) {
    showAuditResult(err instanceof Error ? err.message : String(err), true);
  }
}

async function openAuditDir(): Promise<void> {
  try {
    const res = await window.nahida.audit.openDir();
    showAuditResult(res.ok ? "已在资源管理器中打开审计目录" : res.error || "打开失败", !res.ok);
  } catch (err) {
    showAuditResult(err instanceof Error ? err.message : String(err), true);
  }
}

async function initAuditCard(): Promise<void> {
  document.getElementById("audit-refresh")?.addEventListener("click", () => void loadAudit());
  document.getElementById("audit-open-dir")?.addEventListener("click", () => void openAuditDir());
  await loadAudit(); // 进组即展示一次（无记录 = 空态提示，不算噪音）
}

// ============================================================
// 8.2 允许访问的目录（隐私组）：allowedDirs 白名单管理
// 真相在 config.json 的 allowedDirs（主进程 normalize 成绝对路径 + 去重）；
// 这里只做「弹目录框 → 落盘 → 回读重渲染列表」，**不做任何路径判断**（判断在 path-guard）。
// ============================================================

function dirsCardHtml(): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.folderOpen}允许访问的目录</h3>
    <p class="settings-note">只有列在这里的目录，她才能读写里面的文件（含子目录）。列表为空 = 没有任何文件访问权限。系统目录、凭据文件（.env / 私钥）等敏感区即使加进来也一律拒绝。</p>
    <div class="audit-actions">
      <button type="button" class="btn-soft" id="dirs-add">${ICON.plus}添加目录</button>
      <button type="button" class="btn-soft" id="dirs-clear">清空</button>
    </div>
    <div class="dir-list" id="dir-list"></div>
    <p class="audit-result" id="dirs-result" hidden></p>
  </section>`;
}

function showDirsResult(text: string, isError: boolean): void {
  const el = document.getElementById("dirs-result");
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("audit-result--error", isError);
}

/** 列表回读渲染（每次落盘后都用主进程返回的真值重渲染，不拿本地数组猜） */
function renderAllowedDirs(dirs: string[]): void {
  const host = document.getElementById("dir-list");
  if (!host) return;
  host.innerHTML = dirs.length === 0
    ? `<p class="settings-note">还没有允许的目录 —— 她目前没有任何文件访问权限。</p>`
    : dirs.map((d) => `<div class="dir-row">
        <span class="dir-row__path" title="${esc(d)}">${esc(d)}</span>
        <button type="button" class="btn-soft" data-dir-remove="${esc(d)}">移除</button>
      </div>`).join("");
}

/** 落盘唯一入口：只发 patch（主进程 normalize 后回读），列表按返回值重渲染 */
async function saveAllowedDirs(dirs: string[]): Promise<void> {
  try {
    const cfg = await window.nahida.config.set({ allowedDirs: dirs });
    renderAllowedDirs(cfg.allowedDirs);
    showDirsResult("已保存", false);
  } catch (err) {
    showDirsResult(err instanceof Error ? err.message : String(err), true);
  }
}

async function addAllowedDir(): Promise<void> {
  try {
    const picked = await window.nahida.fs.pickDir();
    if (!picked) return; // 取消：什么都不动
    const cur = (await window.nahida.config.get()).allowedDirs;
    // 去重按 Windows 口径（大小写不敏感）；真正的去重/规范化仍由主进程 normalize 兜底
    if (cur.some((d) => d.toLowerCase() === picked.toLowerCase())) {
      showDirsResult("这个目录已经在列表里了", false);
      return;
    }
    await saveAllowedDirs([...cur, picked]);
  } catch (err) {
    showDirsResult(err instanceof Error ? err.message : String(err), true);
  }
}

async function removeAllowedDir(target: string): Promise<void> {
  try {
    const cur = (await window.nahida.config.get()).allowedDirs;
    await saveAllowedDirs(cur.filter((d) => d !== target));
  } catch (err) {
    showDirsResult(err instanceof Error ? err.message : String(err), true);
  }
}

async function initDirsCard(): Promise<void> {
  const list = document.getElementById("dir-list");
  if (!list) return;
  try {
    renderAllowedDirs((await window.nahida.config.get()).allowedDirs);
  } catch (err) {
    showDirsResult(err instanceof Error ? err.message : String(err), true);
  }
  document.getElementById("dirs-add")?.addEventListener("click", () => void addAllowedDir());
  document.getElementById("dirs-clear")?.addEventListener("click", () => void saveAllowedDirs([]));
  // 事件委托：列表整块会被重渲染，逐个绑会漏（同 MCP 卡的做法）
  list.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-dir-remove]");
    if (!btn) return;
    void removeAllowedDir(btn.dataset.dirRemove ?? "");
  });
}

// ============================================================
// 8.8 / 8.9 消息通道：通道状态总览 + 真实通道（飞书 / 钉钉）凭证表单
// 通道真相（凭证明文、连接、绑定会话）全在主进程 registry；这里只拿 ImChannelView 投影。
// 凭证表单：字段规格来自 shared/config 的 IM_CHANNEL_FIELDS（键名不在这里重写），
//   密钥字段回填的是**掩码**，原样回传 = 「用户没改」由主进程丢弃（同 model.apiKey 的规矩）。
// ⚠️ 两条纪律：
//   ① 落盘后**绝不调 renderSettings() / 不重渲染卡片** —— 那会把输入框里的内容连同焦点一起抹掉
//      （同 4.2 MCP 的坑）；只 applyImViews() 打补丁改状态点与状态文字。
//   ② 切组重建前 flushImSaves()：读值必须在 DOM 被换掉之前发生，否则刚敲的凭证静默丢失。
// ============================================================

/** 状态点三态：on 运行中 / err 启动失败 / off 已停用或未运行（静态，不跳动） */
function imStateOf(v: ImChannelView): "on" | "err" | "off" {
  if (v.state === "running") return "on";
  return v.state === "error" ? "err" : "off";
}

const IM_STATE_LABEL: Record<ImChannelView["state"], string> = {
  running: "运行中",
  stopped: "已停止",
  error: "启动失败",
};

/** 状态文案：开关态 + 运行态 + 绑定会话（列表行与真实通道卡共用一份口径） */
function imStatusText(v: ImChannelView): string {
  const status = v.enabled ? IM_STATE_LABEL[v.state] : "已停用";
  const session = v.sessionTitle ? `会话「${v.sessionTitle}」` : "尚未建立会话";
  return `${status} · ${session}`;
}

/** 真实通道卡的说明文案（只讲「怎么接」与「不需要什么」，不讲内部实现） */
const IM_CARD_NOTE: Record<string, string> = {
  feishu: "飞书企业自建应用机器人。走官方 WebSocket 长连接接收消息事件 —— 不需要公网地址、不需要内网穿透、不需要填回调 URL。",
  dingtalk: "钉钉企业机器人（Stream 模式）。同样走长连接收消息 —— 不需要公网回调地址。回复走来信自带的会话地址，无需额外配置。",
  weixin:
    "微信（腾讯官方 iLink / ClawBot 协议）。扫码登录后由本应用出站长轮询收消息 —— 不需要服务器、不需要公网地址、不需要内网穿透。",
};

/** 8.10：微信专属区（扫码连接 + 二维码展示）。其它通道不渲染（凭证在别处手填） */
function imWeixinExtraHtml(id: string): string {
  return `<div class="im-weixin">
      <div class="im-weixin__actions">
        <button type="button" class="btn-gold" data-im-qr-start="${esc(id)}">扫码连接</button>
        <span class="settings-note">用手机微信「扫一扫」并在手机上确认；登录令牌由主进程加密保存，界面只显示掩码</span>
      </div>
      <div class="im-qr" data-im-qr="${esc(id)}" hidden>
        <img class="im-qr__img" data-im-qr-img="${esc(id)}" alt="微信登录二维码" />
        <p class="im-qr__hint" data-im-qr-hint="${esc(id)}"></p>
        <button type="button" class="btn-soft" data-im-qr-cancel="${esc(id)}">取消</button>
      </div>
    </div>`;
}

/** 非真实通道（echo 自检）的简单行：没有凭证表单，只给状态 + 开关 */
function imRowHtml(v: ImChannelView): string {
  return `<div class="im-row">
    <span class="im-dot" data-state="${imStateOf(v)}" data-im-dot="${esc(v.id)}" aria-hidden="true"></span>
    <span class="im-row__name">${esc(v.displayName)}</span>
    <span class="im-row__code">${esc(v.id)}</span>
    <span class="im-row__meta" data-im-status="${esc(v.id)}">${esc(imStatusText(v))}</span>
    <span class="im-row__actions">
      <button type="button" class="switch" data-im-toggle="${esc(v.id)}" data-on="${v.enabled}" role="switch" aria-checked="${v.enabled}" aria-label="${esc(v.displayName)}"><span></span></button>
    </span>
  </div>`;
}

/** 真实通道卡：凭证表单 + 连接状态 +（适配器支持时）连接测试。无字段规格的通道回落到简单行 */
function imChannelCardHtml(v: ImChannelView): string {
  const fields = IM_CHANNEL_FIELDS[v.id];
  if (!fields) return imRowHtml(v);
  const inputs = fields.map((f) => `<div class="settings-item">
        <span class="settings-item__label">${esc(f.label)}</span>
        <input type="${f.secret ? "password" : "text"}" data-im-channel="${esc(v.id)}" data-im-key="${esc(f.key)}"
          value="${esc(v.configMasked[f.key] ?? "")}" placeholder="${esc(f.placeholder)}"
          autocomplete="off" spellcheck="false" />
      </div>`).join("");
  const actions = `<div class="model-card__actions">
      ${v.canTest ? `<button type="button" class="btn-soft" data-im-test="${esc(v.id)}">${ICON.refresh}连接测试</button>` : ""}
      <button type="button" class="btn-soft" data-im-clear="${esc(v.id)}">清空会话</button>
    </div>`;
  return `<section class="im-card" data-im-card="${esc(v.id)}">
    <div class="im-card__head">
      <span class="im-dot" data-state="${imStateOf(v)}" data-im-dot="${esc(v.id)}" aria-hidden="true"></span>
      <span class="im-card__name">${esc(v.displayName)}</span>
      <span class="im-row__code">${esc(v.id)}</span>
      <button type="button" class="switch" data-im-toggle="${esc(v.id)}" data-on="${v.enabled}" role="switch" aria-checked="${v.enabled}" aria-label="${esc(v.displayName)}"><span></span></button>
    </div>
    <p class="settings-note">${esc(IM_CARD_NOTE[v.id] ?? "")}</p>
    <div class="settings-grid">${inputs}</div>
    ${v.id === "weixin" ? imWeixinExtraHtml(v.id) : ""}
    ${actions}
    <p class="im-card__status" data-im-status="${esc(v.id)}">${esc(imStatusText(v))}</p>
    <p class="im-card__result" data-im-result="${esc(v.id)}" hidden></p>
  </section>`;
}

/** 整块重建（只在进组时调一次；之后一律走 applyImViews 打补丁） */
function renderImList(list: ImChannelView[]): void {
  const host = document.getElementById("im-list");
  if (!host) return;
  host.innerHTML = list.length === 0
    ? `<p class="settings-note">还没有可用的消息通道。</p>`
    : list.map(imChannelCardHtml).join("");
}

/** 只更新状态（点 / 文案 / 开关态），**不碰输入框** —— 落盘、启停、测试后都走这里 */
function applyImViews(views: ImChannelView[]): void {
  for (const v of views) {
    const dot = document.querySelector<HTMLElement>(`[data-im-dot="${v.id}"]`);
    if (dot) dot.dataset.state = imStateOf(v);
    const status = document.querySelector<HTMLElement>(`[data-im-status="${v.id}"]`);
    if (status) status.textContent = imStatusText(v);
    const sw = document.querySelector<HTMLButtonElement>(`[data-im-toggle="${v.id}"]`);
    if (sw) {
      sw.dataset.on = String(v.enabled);
      sw.setAttribute("aria-checked", String(v.enabled));
    }
  }
}

function imCardEl(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-im-card="${id}"]`);
}

/** 8.10 ③b 真机抓到的回归 + 重扫残留（见 refreshUntouchedImInputs）：confirmed 后统一刷新
 *  「用户没动过」的凭证输入框（首次扫码 = 补空框；重扫 = 旧掩码换成新掩码），草稿一律不动。 */

/** 扫码开始时各凭证输入框的值快照（键 = data-im-key）。confirmed 后只刷新「与快照一致 = 用户没动过」
 *  的框 —— 修重扫残留：卡片进组时渲染的是**上一轮**凭证的旧掩码（掩码取值末 4 位、随值变），
 *  重扫落盘后若不刷新，下一次表单保存会把旧掩码当凭证写回，直接写坏新凭证。 */
const weixinQrSnapshots = new Map<string, Record<string, string>>();

/** confirmed 后刷新凭证输入框：有快照 → 只覆盖「用户没动过」的框（草稿不动）；
 *  没快照（理论不可达，兜底）→ 退化为 ③b 的只补空框语义 */
function refreshUntouchedImInputs(id: string, views: ImChannelView[]): void {
  const v = views.find((x) => x.id === id);
  const card = imCardEl(id);
  if (!v || !card) return;
  const snap = weixinQrSnapshots.get(id);
  weixinQrSnapshots.delete(id);
  card.querySelectorAll<HTMLInputElement>("[data-im-key]").forEach((el) => {
    const key = el.dataset.imKey ?? "";
    const masked = v.configMasked[key] ?? "";
    if (!key || !masked) return;
    if (snap ? el.value === (snap[key] ?? "") : el.value === "") el.value = masked;
  });
}

/** 读该通道卡当前表单值（键 = IM_CHANNEL_FIELDS 的 key）；卡不在（已切组）→ 空对象 */
function readImForm(id: string): Record<string, string> {
  const out: Record<string, string> = {};
  const card = imCardEl(id);
  if (!card) return out;
  card.querySelectorAll<HTMLInputElement>("[data-im-key]").forEach((el) => {
    const key = el.dataset.imKey ?? "";
    if (key) out[key] = el.value;
  });
  return out;
}

function showImResult(id: string, text: string, isError: boolean): void {
  const el = document.querySelector<HTMLElement>(`[data-im-result="${id}"]`);
  if (!el) return;
  el.hidden = false;
  el.textContent = text;
  el.classList.toggle("im-card__result--error", isError);
}

// ---------- 凭证防抖保存（每通道一个句柄；写盘走 im:set-config，绝不走 config:set —— 见 registry 的注释） ----------

const imSaveTimers = new Map<string, number>();

function cancelImSave(id: string): void {
  const timer = imSaveTimers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    imSaveTimers.delete(id);
  }
}

function scheduleImSave(id: string): void {
  cancelImSave(id);
  imSaveTimers.set(id, window.setTimeout(() => {
    imSaveTimers.delete(id);
    void saveImConfig(id);
  }, 400));
}

/** 把待落盘的凭证立即发出去。**必须在 DOM 重建前调用**：读值同步发生在被替换之前 */
function flushImSave(id: string): Promise<void> {
  if (!imSaveTimers.has(id)) return Promise.resolve();
  cancelImSave(id);
  return saveImConfig(id);
}

/** 切组重建前的总 flush（读值同步、发送异步 —— 所以重建后调用也不算晚，但这里更保险） */
function flushImSaves(): void {
  for (const id of [...imSaveTimers.keys()]) void flushImSave(id);
}

async function saveImConfig(id: string): Promise<void> {
  try {
    applyImViews(await window.nahida.im.setConfig(id, readImForm(id)));
  } catch (err) {
    showImResult(id, err instanceof Error ? err.message : String(err), true);
  }
}

async function initImCard(): Promise<void> {
  renderImList(await window.nahida.im.listChannels());
}

/** 开关：改落盘 enabled + 主进程真启停适配器（失败只落 state="error"）；回来只打补丁。
 *  防重入：开关 IPC 往返期间忽略同通道连点（点击方向读的是 data-on，回包前是旧值 ——
 *  8.10 真机抓到的「点不出 / 忽明忽暗」根源）。主进程侧另有启停串行 + 幂等兜底。 */
const pendingImToggles = new Set<string>();
async function toggleImChannel(id: string, enabled: boolean): Promise<void> {
  if (pendingImToggles.has(id)) return;
  pendingImToggles.add(id);
  try {
    // IPC 立即返回（启停在主进程后台落定，不等握手）：开关态本响应就是真值，
    // 但 state 还是旧的 —— 先显示「启动中/停止中」，几秒后拉真值刷定
    applyImViews(await window.nahida.im.setEnabled(id, enabled));
    const status = document.querySelector<HTMLElement>(`[data-im-status="${id}"]`);
    if (status) status.textContent = enabled ? "启动中…" : "停止中…";
    void (async () => {
      // 微信握手要好几秒；两轮回读足够覆盖。失败（窗口关了等）就不管了
      for (const delay of [2500, 7000]) {
        await new Promise((r) => setTimeout(r, delay));
        try {
          applyImViews(await window.nahida.im.listChannels());
        } catch {
          return;
        }
      }
    })();
  } catch {
    // IPC 本身抛了（例如主进程未注册通道）：让界面回到真实状态
    try {
      applyImViews(await window.nahida.im.listChannels());
    } catch {
      /* 拿不到真值就保持现状 */
    }
  } finally {
    pendingImToggles.delete(id);
  }
}

/** 8.10.2 清空通道上下文：真删绑定会话 + 解绑 sessionId；回来打补丁（状态行自然变「尚未建立会话」） */
async function clearImSession(id: string): Promise<void> {
  try {
    applyImViews(await window.nahida.im.clearSession(id));
  } catch {
    try {
      applyImViews(await window.nahida.im.listChannels());
    } catch {
      /* 拿不到真值就保持现状 */
    }
  }
}

/** 连接测试：先把待落盘的凭证发出去（否则测的是旧值），再拿草稿 + 已落盘值的主进程合并结果试连 */
async function testImConnection(id: string): Promise<void> {
  const btn = document.querySelector<HTMLButtonElement>(`[data-im-test="${id}"]`);
  if (btn) btn.disabled = true;
  showImResult(id, "正在测试连接…", false);
  try {
    await flushImSave(id);
    const res = await window.nahida.im.testConnection({ channelId: id, config: readImForm(id) });
    showImResult(id, res.message, !res.ok);
  } catch (err) {
    showImResult(id, err instanceof Error ? err.message : String(err), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ---------- 8.10 微信扫码登录（iLink）：主进程取码 + 轮询，渲染层只负责展示 ----------
// 纪律同凭证表单：**成功后绝不重渲染卡片**（会把输入框连焦点一起抹掉），只 applyImViews 打补丁。

/** 扫码轮询句柄（每通道一个）；切组必须掐掉 —— 否则 DOM 早没了，定时器还在打 IPC */
const weixinQrTimers = new Map<string, number>();
/** 轮询「代」：start / cancel / 切组都会 +1。
 *  异步回调回来时对不上号就直接丢弃 —— 否则「在飞的那次 poll」会在取消之后把二维码又显示出来并重新排定时器 */
const weixinQrGen = new Map<string, number>();
/** 续拍间隔：**短**是有原因的 —— 状态查询是服务端 long-poll，它自己会 hold 到状态变化才回；
 *  这里只负责「上一拍刚回来就立刻续上」，小间隔仅仅避免服务端提前返回时把请求打得太密 */
const WEIXIN_QR_POLL_MS = 500;

function bumpWeixinQrGen(id: string): number {
  const next = (weixinQrGen.get(id) ?? 0) + 1;
  weixinQrGen.set(id, next);
  return next;
}

function stopWeixinQrPoll(id: string): void {
  const timer = weixinQrTimers.get(id);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    weixinQrTimers.delete(id);
  }
}

/** 切组重建前调用：旧 DOM 的扫码轮询一律停掉（并作废在飞的回调） */
function stopAllWeixinQrPolls(): void {
  for (const id of [...weixinQrTimers.keys()]) stopWeixinQrPoll(id);
  for (const id of weixinQrGen.keys()) bumpWeixinQrGen(id);
}

/** 更新二维码区。`image` 传 null = 保持当前图片（只更新提示文案） */
function showWeixinQr(id: string, image: string | null, hint: string): void {
  const box = document.querySelector<HTMLElement>(`[data-im-qr="${id}"]`);
  if (!box) return;
  box.hidden = false;
  const img = box.querySelector<HTMLImageElement>(`[data-im-qr-img="${id}"]`);
  if (img && image !== null) {
    img.hidden = !image; // hidden 兜底在 CSS 里（.im-qr__img[hidden]）—— 已在 3.7 / 3.9 踩过
    if (image) img.src = image;
  }
  const text = box.querySelector<HTMLElement>(`[data-im-qr-hint="${id}"]`);
  if (text) text.textContent = hint;
}

async function startWeixinQr(id: string): Promise<void> {
  stopWeixinQrPoll(id); // 重复点击 = 重新取码（主进程会把旧票据顶掉，语义清晰）
  const gen = bumpWeixinQrGen(id);
  weixinQrSnapshots.set(id, readImForm(id)); // 快照当前输入框值：confirmed 后区分「没动过的框」与「用户草稿」
  showWeixinQr(id, "", "正在获取二维码…");
  try {
    const view = await window.nahida.im.weixinQr.start();
    if (weixinQrGen.get(id) !== gen) return; // 取码期间被取消 / 又点了一次 → 本次结果作废
    if (!view.ok) {
      showWeixinQr(id, "", view.error ?? "获取二维码失败");
      return;
    }
    // qrImage = 主进程本地渲染的 dataURL；渲染失败时回退官方地址（复制到浏览器后用手机扫）
    showWeixinQr(
      id,
      view.qrImage ?? "",
      view.qrImage
        ? "请用手机微信「扫一扫」，并在手机上确认"
        : `二维码图片渲染失败，请把下面这行地址复制到浏览器打开后用手机扫：${view.qrUrl ?? ""}`,
    );
    armWeixinQrPoll(id, gen);
  } catch (err) {
    if (weixinQrGen.get(id) !== gen) return;
    showWeixinQr(id, "", err instanceof Error ? err.message : String(err));
  }
}

function armWeixinQrPoll(id: string, gen: number): void {
  stopWeixinQrPoll(id);
  weixinQrTimers.set(id, window.setTimeout(() => { void pollWeixinQrOnce(id, gen); }, WEIXIN_QR_POLL_MS));
}

async function pollWeixinQrOnce(id: string, gen: number): Promise<void> {
  weixinQrTimers.delete(id);
  let view: WeixinQrPollView;
  try {
    view = await window.nahida.im.weixinQr.poll();
  } catch (err) {
    if (weixinQrGen.get(id) !== gen) return;
    showWeixinQr(id, null, err instanceof Error ? err.message : String(err));
    return;
  }
  if (weixinQrGen.get(id) !== gen) return; // 已取消 / 已重新取码 → 这次结果作废，绝不让界面「复活」
  if (view.state === "confirmed") {
    showWeixinQr(id, "", view.message);
    // 凭证已在主进程落盘：打补丁刷新状态点与状态文案；**同时**刷新「用户没动过」的凭证输入框
    // （首次扫码补空框 / 重扫把旧掩码换新掩码 —— 否则下一次表单保存会把坏值写回）
    try {
      const views = await window.nahida.im.listChannels();
      applyImViews(views);
      refreshUntouchedImInputs(id, views);
    } catch { /* 拿不到真值就保持现状 */ }
    return;
  }
  // idle / expired / invalid = 会话已结束：停轮询，保留提示让用户点「扫码连接」重来
  if (view.state === "idle" || view.state === "expired" || view.state === "invalid") {
    showWeixinQr(id, "", view.message);
    return;
  }
  // wait / scanned / error（查询失败但会话仍在）→ 继续轮询
  showWeixinQr(id, null, view.message);
  armWeixinQrPoll(id, gen);
}

async function cancelWeixinQr(id: string): Promise<void> {
  stopWeixinQrPoll(id);
  bumpWeixinQrGen(id); // 作废在飞的那次 poll（否则它会重新显示二维码 + 重排定时器）
  try {
    await window.nahida.im.weixinQr.cancel();
  } catch {
    /* 取消失败不影响界面 */
  }
  const box = document.querySelector<HTMLElement>(`[data-im-qr="${id}"]`);
  if (box) box.hidden = true;
}

/** 自检注入：把一条假来信送进 echo 通道，验证「来信 → 独立会话 → 回复 → 原路发回」闭环 */
async function injectImMessage(): Promise<void> {
  const val = (id: string): string => (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? "";
  const result = document.getElementById("im-inject-result");
  const text = val("im-inject-text");
  if (!text) {
    if (result) {
      result.hidden = false;
      result.textContent = "消息内容不能为空";
      result.classList.add("im-inject-result--error");
    }
    return;
  }
  let ok = false;
  let message = "";
  try {
    const res = await window.nahida.im.inject({ channelId: "echo", target: val("im-inject-target"), text });
    ok = res.ok;
    message = res.ok ? "已送入 echo 通道，稍后到对话里看回复。" : res.reason ?? "注入失败";
  } catch (err) {
    message = err instanceof Error ? err.message : String(err);
  }
  if (!result) return;
  result.hidden = false;
  result.textContent = message;
  result.classList.toggle("im-inject-result--error", !ok);
}

function imCardHtml(): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.messages}消息通道</h3>
    <p class="settings-note">把 nahida 接到外部聊天软件。每个通道用一条独立会话，不复用主对话的上下文，避免串味。飞书 / 钉钉都走长连接，不需要公网地址、不需要内网穿透。密钥字段加密保存，界面只显示掩码；重填该字段才会更新，留空则清空。</p>
    <div class="im-list" id="im-list"><p class="settings-note">加载中…</p></div>
    <div class="im-inject">
      <span class="settings-item__label">echo 自检：模拟一条外部来信<span class="tag tag-gold">不连外部服务</span></span>
      <div class="im-inject__fields">
        <input type="text" id="im-inject-target" placeholder="用户标识，留空 = tester" autocomplete="off" spellcheck="false" />
        <input type="text" id="im-inject-text" placeholder="来信内容，如：你好，帮我看下今天的安排" autocomplete="off" spellcheck="false" />
        <button type="button" class="btn-gold" id="im-inject-send">${ICON.send}送入</button>
      </div>
      <p class="im-inject-result" id="im-inject-result" hidden></p>
    </div>
  </section>`;
}

// ============================================================
// 8.7 技能（唯一扩展载体）
// 目录 userData/skills/<目录>/SKILL.md；扫描结果与启用开关的真相全在主进程，
// 渲染层只拿投影。启用后模型只看到 name+description，正文靠 skill(id) 工具懒加载（防上下文爆炸）。
// ============================================================

function skillsCardHtml(): string {
  return `<section class="settings-card">
    <h3 class="settings-card__title">${ICON.sparkles}技能</h3>
    <p class="settings-note">技能是给 nahida 加本事的方式：在技能目录里放一个文件夹、里面放一份 SKILL.md，就是一个技能。启用的技能只把「名字 + 一句话说明」告诉模型；真要用到时，它才用 skill 工具取回完整步骤，不会一次性塞满上下文。技能里写到的脚本不会自动获得执行权限，需要执行时仍照常走工具审批。</p>
    <div class="skills-actions">
      <button type="button" class="btn-soft" id="skills-open-dir">${ICON.folderOpen}打开技能目录</button>
      <button type="button" class="btn-soft" id="skills-rescan">${ICON.refresh}重新扫描</button>
    </div>
    <div class="skills-list" id="skills-list"><p class="settings-note">加载中…</p></div>
  </section>`;
}

/** 技能列表：名字 + 说明 + id/版本/作者 + 启用开关；依赖缺失（frontmatter requires）单独标注 */
function renderSkillsList(skills: SkillSummary[]): void {
  const host = document.getElementById("skills-list");
  if (!host) return;
  if (skills.length === 0) {
    host.innerHTML =
      `<p class="settings-note">还没有任何技能。点「打开技能目录」，新建一个文件夹并在里面放一份 SKILL.md（头部写 name 和 description），再点「重新扫描」。</p>`;
    return;
  }
  host.innerHTML = skills
    .map((s) => {
      const meta = [`id: ${s.id}`, s.version ? `v${s.version}` : "", s.author].filter(Boolean).join(" · ");
      const warn = s.available ? "" : `<span class="skills-row__warn">依赖缺失</span>`;
      return `<div class="skills-row">
      <div class="skills-row__head">
        <span class="skills-row__name">${esc(s.name)}</span>
        ${warn}
        <button type="button" class="switch" data-skill-toggle="${esc(s.id)}" data-on="${s.enabled}" role="switch" aria-checked="${s.enabled}" aria-label="${esc(s.name)}启用开关"><span></span></button>
      </div>
      <p class="skills-row__desc">${esc(s.description)}</p>
      <p class="skills-row__meta">${esc(meta)}</p>
    </div>`;
    })
    .join("");
}

async function initSkillsCard(): Promise<void> {
  document.getElementById("skills-open-dir")?.addEventListener("click", () => {
    void window.nahida.skills.openDir().catch(() => undefined); // 打开失败不打断（系统关联问题）
  });
  document.getElementById("skills-rescan")?.addEventListener("click", () => {
    void rescanSkills();
  });
  try {
    renderSkillsList(await window.nahida.skills.list());
  } catch (err) {
    const host = document.getElementById("skills-list");
    if (host) host.innerHTML = `<p class="skills-row__warn">${esc(err instanceof Error ? err.message : String(err))}</p>`;
  }
}

async function rescanSkills(): Promise<void> {
  try {
    renderSkillsList(await window.nahida.skills.refresh());
  } catch {
    /* 重扫失败保持原列表，不打断 */
  }
}

/** 开关：写 config.ui 的 skill.<id>.enabled（落盘在主进程）；回来按真值重绘 */
async function toggleSkill(id: string, enabled: boolean): Promise<void> {
  try {
    renderSkillsList(await window.nahida.skills.setEnabled(id, enabled));
  } catch {
    try {
      renderSkillsList(await window.nahida.skills.list());
    } catch {
      /* 拿不到真值就保持现状 */
    }
  }
}

/** 渲染左侧导航栏 */
function renderNav(): void {
  const nav = document.getElementById("settings-nav");
  if (!nav) return;
  nav.innerHTML = NAV_GROUPS.map(
    (g) => `<button type="button" class="settings-nav__item" data-group="${esc(g.group)}" aria-current="false">${esc(g.label)}</button>`,
  ).join("");
  nav.querySelectorAll<HTMLElement>(".settings-nav__item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const g = btn.dataset.group;
      if (g) renderSettingGroup(g);
    });
  });
}

/** 渲染设置视图：左侧导航 + 右侧默认组 */
function renderSettings(): void {
  const body = document.getElementById("settings-body");
  if (!body) return;
  renderNav();
  renderSettingGroup(activeGroup);
}

/** 渲染关于视图：4 张卡（主卡含运行环境区块 + 联系与反馈 + 同人声明 + 开源致谢）；
 * 版本号由 fillAboutVersion 回填（异步，坑 1 / 铁律 5） */
function renderAbout(): void {
  const body = document.getElementById("about-body");
  if (!body) return;
  body.innerHTML = aboutCardHtml() + contactCardHtml() + fanCardHtml() + licenseCardHtml();
  void fillAboutVersion();
}

let aboutVersion: string | null = null; // 模块级缓存：只由 fillAboutVersion 写，避免二次 IPC / 重渲染丢失

/** 版本号异步回填：IPC 回来后写进 #about-version；取不到就保持「读取中」占位，不抛 */
async function fillAboutVersion(): Promise<void> {
  if (!aboutVersion) {
    try { aboutVersion = await window.nahida.getVersion(); } catch { return; }
  }
  const el = document.getElementById("about-version"); // 必须重新取，不缓存元素引用（坑 2）
  if (el) el.textContent = `${ABOUT.versionPrefix}${aboutVersion}`;
}

// ---------- 交互接线（事件委托挂在容器上，容器本身不会被 innerHTML 换掉） ----------
function wireSettings(host: HTMLElement): void {
  // 点击：.seg 单选（同格内互斥）、.switch 开关
  host.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;

    const seg = el.closest<HTMLButtonElement>(".seg");
    if (seg) {
      const row = seg.parentElement; // .settings-item__segs
      row?.querySelectorAll<HTMLButtonElement>(".seg").forEach((b) => { b.dataset.on = "false"; });
      seg.dataset.on = "true";
      // 5.1.1：按容器 data-ui-key 定位落盘（值 = 选项原文），不从文字反推
      if (row?.dataset.uiKey) scheduleUiSave(row.dataset.uiKey, seg.textContent ?? "");
      return;
    }

    // 外观重设计 2026-09-29：强调色预设色块（.swatch 点击 → 落盘预设名）
    const swatch = el.closest<HTMLButtonElement>(".swatch");
    if (swatch) {
      const row = swatch.parentElement; // .settings-item__swatches
      row?.querySelectorAll<HTMLElement>(".swatch").forEach((b) => { b.dataset.on = "false"; });
      row?.querySelectorAll<HTMLElement>(".swatch-picker").forEach((b) => { b.dataset.on = "false"; });
      swatch.dataset.on = "true";
      const name = swatch.dataset.accent ?? "";
      if (row?.dataset.uiKey) scheduleUiSave(row.dataset.uiKey, name);
      return;
    }

    // 8.7.22：背景图选择按钮（背景样式=自定义图片）→ 弹系统文件框，选中落 config.ui.bgImage
    const bgPick = el.closest<HTMLButtonElement>("#pick-bg-image");
    if (bgPick) {
      void pickBgImage();
      return;
    }

    // 4.2：MCP 卡的四个动作。⚠️ 必须放在下面通用 .switch 分支**之前** ——
    // MCP 行的开关也带 .switch 类，晚于它就会被通用分支吃掉：只视觉翻转、不发 IPC
    if (el.closest("#mcp-add")) {
      void runMcpAction(() => window.nahida.mcp.add(readMcpForm()));
      return;
    }
    const mcpToggle = el.closest<HTMLElement>("[data-mcp-toggle]");
    if (mcpToggle) {
      const id = mcpToggle.dataset.mcpToggle ?? "";
      void runMcpAction(() => window.nahida.mcp.setEnabled(id, mcpToggle.dataset.on !== "true"));
      return;
    }
    const mcpRetry = el.closest<HTMLElement>("[data-mcp-retry]");
    if (mcpRetry) {
      void runMcpAction(() => window.nahida.mcp.reconnect(mcpRetry.dataset.mcpRetry ?? ""));
      return;
    }
    const mcpRemove = el.closest<HTMLElement>("[data-mcp-remove]");
    if (mcpRemove) {
      void runMcpAction(() => window.nahida.mcp.remove(mcpRemove.dataset.mcpRemove ?? ""));
      return;
    }

    // 4.6：语音卡 —— path 的「浏览」与 boolean 开关。
    // ⚠️ 必须放在下面通用 .switch 分支**之前**（同 4.2 的坑）
    const pick = el.closest<HTMLElement>("[data-voice-pick]");
    if (pick) {
      void pickVoicePath(pick.dataset.voicePick ?? "", pick.dataset.voiceMode ?? "file", pick.dataset.voiceTitle ?? "");
      return;
    }
    const vsw = el.closest<HTMLButtonElement>(".switch[data-voice-engine]");
    if (vsw) {
      const next = vsw.dataset.on !== "true";
      vsw.dataset.on = String(next);
      vsw.setAttribute("aria-checked", String(next));
      scheduleVoiceSave(); // ⚠️ 必须真的存 —— 通用分支只翻转视觉
      return;
    }

    // 5.1.2：长期记忆卡 —— 置顶开关也是 .switch，必须在通用 .switch 分支之前（§4.9 顺序坑，同 4.2 / 4.6）
    const ltPin = el.closest<HTMLButtonElement>(".switch[data-lt-pin]");
    if (ltPin) {
      const entry = ltEntries.find((x) => x.id === ltPin.dataset.ltPin);
      if (entry) {
        entry.pinned = ltPin.dataset.on !== "true";
        if (!entry.pinned) delete entry.pinned; // 未置顶不写该字段，与主进程消毒同形
        renderLtList(); // §8：置顶后只重建 #lt-list（置顶行要挪到最前），绝不调 renderSettings()
        scheduleMemorySave();
      }
      return;
    }
    const ltToggle = el.closest<HTMLElement>("[data-lt-toggle-status]");
    if (ltToggle) {
      const entry = ltEntries.find((x) => x.id === ltToggle.dataset.ltToggleStatus);
      if (entry) {
        if (entry.status === "active") {
          entry.status = "invalidated";
          entry.validUntil = Date.now(); // 失效不删条目，只盖时间戳（与主进程消毒同形）
        } else {
          entry.status = "active";
          delete entry.validUntil; // 恢复 → 回 active，清掉失效时间
        }
        renderLtList(); // 变灰 / 按钮切「恢复」要整行重画
        scheduleMemorySave();
      }
      return;
    }
    const ltDel = el.closest<HTMLElement>("[data-lt-del]");
    if (ltDel) {
      ltEntries = ltEntries.filter((x) => x.id !== ltDel.dataset.ltDel);
      renderLtList();
      scheduleMemorySave();
      return;
    }
    if (el.closest("#lt-add")) {
      addLtEntry(); // 追加空条目并聚焦正文框（达上限时在函数内提示）
      return;
    }

    // 5.1.5：睡前整理 —— 立即整理 / 回滚（同 5.1.2 的 lt 分支，都排在通用 .switch 之前）
    if (el.closest("#lt-tidy-now")) {
      void runTidyNow();
      return;
    }
    if (el.closest("#lt-tidy-rollback")) {
      void runTidyRollback();
      return;
    }

    // 8.8：消息通道 —— 通道开关也带 .switch，必须在通用分支之前（同 4.2 / 4.6 / 5.1.2 的顺序坑）
    const imToggle = el.closest<HTMLElement>("[data-im-toggle]");
    if (imToggle) {
      void toggleImChannel(imToggle.dataset.imToggle ?? "", imToggle.dataset.on !== "true");
      return;
    }
    if (el.closest("#im-inject-send")) {
      void injectImMessage();
      return;
    }
    // 8.10.2：清空通道上下文（真删绑定会话 + 解绑，下一封来信自动建新会话）
    const imClear = el.closest<HTMLElement>("[data-im-clear]");
    if (imClear) {
      void clearImSession(imClear.dataset.imClear ?? "");
      return;
    }
    // 8.9：真实通道卡的连接测试（按钮不是 .switch，但同一处分发，便于集中看顺序）
    const imTest = el.closest<HTMLElement>("[data-im-test]");
    if (imTest) {
      void testImConnection(imTest.dataset.imTest ?? "");
      return;
    }
    // 8.10：微信扫码连接 / 取消
    const qrStart = el.closest<HTMLElement>("[data-im-qr-start]");
    if (qrStart) {
      void startWeixinQr(qrStart.dataset.imQrStart ?? "");
      return;
    }
    const qrCancel = el.closest<HTMLElement>("[data-im-qr-cancel]");
    if (qrCancel) {
      void cancelWeixinQr(qrCancel.dataset.imQrCancel ?? "");
      return;
    }

    // 8.7：技能开关 —— 不好走 data-ui-key（落盘走 skills:set-enabled，由主进程写 config.ui），
    // 必须在下面通用 .switch 分支之前拦截，否则会被它再翻一次而双重取反
    const skillSw = el.closest<HTMLButtonElement>("[data-skill-toggle]");
    if (skillSw) {
      const next = skillSw.dataset.on !== "true";
      skillSw.dataset.on = String(next);
      skillSw.setAttribute("aria-checked", String(next));
      void toggleSkill(skillSw.dataset.skillToggle ?? "", next);
      return;
    }

    // 8.6.1：键鼠总开关 —— 落盘走 permissions.inputControl（config:set，不是 ui.*），
    // 同样必须拦在通用 .switch 分支之前（防双重取反）；翻转与保存都在 saveInputControl 里
    const permSw = el.closest<HTMLButtonElement>("[data-perm-toggle]");
    if (permSw) {
      void saveInputControl(permSw);
      return;
    }

    // C 重做：强制视觉开关 —— 同上必须拦在通用 .switch 之前（防双重取反）；即时落盘走 saveVisionForce
    const visionForceSw = el.closest<HTMLButtonElement>("[data-vision-force]");
    if (visionForceSw) {
      void saveVisionForce(visionForceSw);
      return;
    }

    const sw = el.closest<HTMLButtonElement>(".switch");
    if (sw) {
      const next = sw.dataset.on !== "true";
      sw.dataset.on = String(next);
      sw.setAttribute("aria-checked", String(next));
      // 5.1.1：三组卡的开关按 data-ui-key 落盘（语音 / MCP 的开关在前面专属分支已 return，
      // 补的只是这一行调用，分支顺序不动 —— §5.4）
      if (sw.dataset.uiKey) scheduleUiSave(sw.dataset.uiKey, next);
      return;
    }

    // 3.7：测试连接（先 flush 防抖再测，见 runModelTest 开头）
    if (el.closest("#model-test")) {
      void runModelTest();
    }

    // 8.1：视觉模型连接测试（独立链路，见 runVisionTest 开头同样先 flush）
    if (el.closest("#vision-test")) {
      void runVisionTest();
    }
  });

  // 3.7：选提供方 → 带出地址与默认模型填进输入框（custom 的地址是空串 → 留空手填）
  host.addEventListener("change", (e) => {
    const el = e.target;
    // 外观重设计 2026-09-29：自定义强调色色盘（change 只在用户选完颜色后触发一次）
    if (el instanceof HTMLInputElement && el.classList.contains("swatch-custom")) {
      const row = el.closest<HTMLElement>(".settings-item__swatches");
      row?.querySelectorAll<HTMLElement>(".swatch").forEach((b) => { b.dataset.on = "false"; });
      row?.querySelectorAll<HTMLElement>(".swatch-picker").forEach((b) => { b.dataset.on = "true"; });
      const key = el.dataset.uiKey ?? "accent";
      scheduleUiSave(key, el.value.toLowerCase()); // 落盘 hex（小写，匹配 applyUiToGroups 正则）
      return;
    }

    if (el instanceof HTMLSelectElement && el.id === "set-model-provider") {
      const preset = modelForm.presets.find((p) => p.id === el.value) ?? null;
      const addr = modelField<HTMLInputElement>("set-model-baseurl");
      const name = modelField<HTMLInputElement>("set-model-name");
      if (addr) addr.value = preset?.baseUrl ?? "";
      if (name) name.value = preset?.defaultModel ?? "";
      updateProviderUi();
      scheduleModelSave();
    }

    // 4.2：切传输方式 → 表单字段显隐（stdio 三格 / http·sse 一格）
    if (el instanceof HTMLSelectElement && el.id === "mcp-f-transport") {
      updateMcpFormUi();
    }

    // 8.1：视觉卡选提供方 → 带出地址与默认模型（同模型卡口径；地址为空串的预设留空手填）
    if (el instanceof HTMLSelectElement && el.id === "set-vision-provider") {
      const preset = visionForm.presets.find((p) => p.id === el.value) ?? null;
      const addr = visionField<HTMLInputElement>("set-vision-baseurl");
      const name = visionField<HTMLInputElement>("set-vision-name");
      if (addr) addr.value = preset?.baseUrl ?? "";
      if (name) name.value = preset?.defaultModel ?? "";
      scheduleVisionSave();
      return;
    }

    // 6.6.2 补缺（4.6 存量）：首选引擎下拉没有 data-voice-engine，input 委托匹配不上，
    // 单独改它此前从不触发保存（只靠其他字段的保存顺带落盘）—— change 直接触发防抖存
    if (el instanceof HTMLSelectElement && el.id === "voice-preferred") {
      scheduleVoiceSave();
      return;
    }

    // 6.6.4：天气来源切换 —— 切「在线」且坐标合法立即拉一次；切「系统」天气展示回到占位
    //（env.weather 置回系统源；text/temp 旧在线值留着无害，下次拉取会覆盖）
    if (el instanceof HTMLSelectElement && el.id === "weather-source") {
      scheduleUiSave(el.dataset.uiKey ?? "weatherSource", el.value);
      if (el.value === "online") void fetchOnlineWeather();
      else patch({ env: { weather: { source: "system" } } }, "settings");
      return;
    }

    // 5.1.2：长期记忆的重要性下拉（change 委托）→ 先取整再夹界，与主进程消毒同形
    if (el instanceof HTMLSelectElement && el.dataset.ltImp !== undefined) {
      const entry = ltEntries.find((x) => x.id === el.dataset.ltImp);
      if (entry) {
        const n = Number(el.value);
        entry.importance = Number.isFinite(n)
          ? Math.min(LONG_TERM_LIMITS.importanceMax, Math.max(LONG_TERM_LIMITS.importanceMin, Math.round(n)))
          : LONG_TERM_LIMITS.defaultImportance;
        scheduleMemorySave();
      }
      return;
    }

    // 5.1.6：档案手写段失焦（change）→ 立即 flush（同原 persona 的坑，persona 6.6.2 起只读已无此链路）
    if (el instanceof HTMLTextAreaElement && el.id === "up-manual") {
      flushUserProfileSave();
      return;
    }

    // 8.7.22：背景样式切「自定义图片」→ 显示选图行；切回渐变/纯色 → 隐藏（底图由 applyVisual 清掉）
    if (el instanceof HTMLSelectElement && el.dataset.uiKey === "bgType") {
      const row = document.getElementById("bgimage-row");
      if (row) row.hidden = el.value !== "自定义图片";
      scheduleUiSave("bgType", el.value);
      return;
    }

    // 5.1.1：三组卡的下拉（回复节奏 / 录屏保留时长 / 记忆整理时间）→ 防抖落盘。
    // 模型卡与 MCP 表单的 select 没有 data-ui-key，不会进这里
    if (el instanceof HTMLSelectElement && el.dataset.uiKey) {
      scheduleUiSave(el.dataset.uiKey, el.value);
    }
  });

  // 输入：滑块改取值文本；「她对你的称呼」改提示文案；模型卡三个输入框防抖即时保存
  host.addEventListener("input", (e) => {
    const el = e.target;

    // 3.7：Key 编辑过才置 dirty（掩码回写坑，§6.3）；三个输入框都走防抖保存
    if (el instanceof HTMLInputElement && (el.id === "set-model-key" || el.id === "set-model-baseurl" || el.id === "set-model-name")) {
      if (el.id === "set-model-key") modelForm.apiKeyDirty = true;
      if (el.id === "set-model-baseurl") updateProviderUi(); // 5.1.1：地址输入实时重算必填错误与「测试连接」可用性（§4.8）
      scheduleModelSave();
      return;
    }

    // 8.1：视觉卡三个输入框 —— 同一套 dirty 规矩，落 config.vision，与模型卡互不影响
    if (el instanceof HTMLInputElement && (el.id === "set-vision-key" || el.id === "set-vision-baseurl" || el.id === "set-vision-name")) {
      if (el.id === "set-vision-key") visionForm.apiKeyDirty = true;
      scheduleVisionSave();
      return;
    }

    // 8.9：消息通道凭证输入（飞书 / 钉钉）→ 按通道防抖落盘；回填的掩码原样留着 = 未改动，主进程会丢弃
    if (el instanceof HTMLInputElement && el.dataset.imKey) {
      const channelId = el.dataset.imChannel ?? "";
      if (channelId) scheduleImSave(channelId);
      return;
    }

    // 4.6：语音卡所有控件（text / password / number / select 都走 input）
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) {
      const engineId = el.dataset.voiceEngine;
      if (engineId) {
        const key = el.dataset.voiceKey ?? "";
        if (isSecretField(engineId, key)) voiceForm.secretDirty.add(`${engineId}|${key}`);
        scheduleVoiceSave();
        return;
      }
    }

    // 5.1.2：长期记忆行内输入（正文 textarea / 标签 / 触发词）—— 值先写模块态（真相源）再防抖；
    // 正文 / 标签 / 触发词在 ltRowHtml 里都已 esc()（§5.6 注入面）
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const ltId = el.dataset.ltText ?? el.dataset.ltTags ?? el.dataset.ltKeys;
      if (ltId !== undefined) {
        const entry = ltEntries.find((x) => x.id === ltId);
        if (entry) {
          if (el.dataset.ltText !== undefined) entry.text = el.value;
          else if (el.dataset.ltTags !== undefined) entry.tags = splitList(el.value);
          else entry.keys = splitList(el.value);
          scheduleMemorySave();
        }
        return;
      }
    }

    // 5.1.6：档案手写段输入 → 更新字数 + 防抖存（失焦 change 再 flush；人设 6.6.2 起只读无此分支）
    if (el instanceof HTMLTextAreaElement && el.id === "up-manual") {
      updateUserProfileCount();
      scheduleUserProfileSave();
      return;
    }

    // 6.6.4：天气经纬度输入 —— 合法值才落盘（非法/空保持上次值）；来源已是「在线」时防抖后顺手刷新一次
    if (el instanceof HTMLInputElement && el.dataset.weatherCoord) {
      const v = Number(el.value);
      const isLat = el.dataset.weatherCoord === "lat";
      const ok = el.value.trim() !== "" && Number.isFinite(v)
        && (isLat ? v >= -90 && v <= 90 : v >= -180 && v <= 180);
      if (ok) scheduleUiSave(isLat ? "weatherLat" : "weatherLon", v);
      const src = document.getElementById("weather-source") as HTMLSelectElement | null;
      if (src?.value === "online") scheduleWeatherFetch();
      return;
    }

    // 7.3：天气自定义 Key 输入（text 无通用 data-ui-key 保存通道）→ 防抖落 config.ui.weatherKey；
    // 空串也落盘（= 留空用公开接口）；绝不带进 fetchOnline 参数（Open-Meteo 不需要，误传反而暴露）
    if (el instanceof HTMLInputElement && el.id === "weather-key") {
      scheduleUiSave("weatherKey", el.value);
      return;
    }

    if (el instanceof HTMLInputElement && el.type === "range") {
      const valueEl = document.getElementById(`${el.id}-value`);
      if (!valueEl) return;
      const labels = el.dataset.labels?.split(",");
      valueEl.textContent = labels ? labels[Number(el.value)] ?? "" : `${el.value}${el.dataset.unit ?? ""}`;
      // 5.1.1：按 data-ui-key 落盘（只加这一行，取值文本逻辑不动）。带 labels 的滑块存数字下标不存文字（§5.6）
      if (el.dataset.uiKey) scheduleUiSave(el.dataset.uiKey, Number(el.value));
      return;
    }

    if (el instanceof HTMLInputElement && el.id === "set-call") {
      const note = document.getElementById("set-call-note");
      if (note) note.textContent = callNoteText(el.value.trim() || CALL_FALLBACK);
      // 5.1.1：称呼落盘（空串是合法值，渲染侧回落 CALL_FALLBACK —— §5.5）
      if (el.dataset.uiKey) scheduleUiSave(el.dataset.uiKey, el.value);
    }
  });
}

function wireAbout(host: HTMLElement): void {
  host.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    const status = document.getElementById("about-status");
    if (!status) return;
    if (el.closest("#about-check")) {
      // 2026-09-30：上线后跳 GitHub Releases；外链由主进程 setWindowOpenHandler 转系统浏览器
      status.textContent = ABOUT.statusCheckOpened;
      window.open("https://github.com/nebula-silent/nahida-agent/releases", "_blank");
    } else if (el.closest("#about-opendir")) {
      status.textContent = ABOUT.statusDataDirUnavailable; // 6.8：无 openDataDir 桥，占位提示不报错
    } else if (el.closest("#license-toggle")) {
      // 2026-09-29：开源致谢折叠 —— 只翻 #license-list 的 hidden（坑 5 惯例，不用 class 切换）
      const list = document.getElementById("license-list");
      const toggle = el.closest("#license-toggle") as HTMLButtonElement | null;
      if (list && toggle) {
        list.hidden = !list.hidden;
        toggle.setAttribute("aria-expanded", String(!list.hidden));
      }
    }
  });
}

// ---------- 启动（顶层执行，照 chat.ts / studio.ts 的写法） ----------
// 5.1.1：渲染改异步引导 —— 先读 config.ui 回填数据层再渲染（§4.2）；wireSettings 仍在下面挂一次（现有写法不变）
void bootSettings();
renderAbout();

const settingsBody = document.getElementById("settings-body");
if (settingsBody) wireSettings(settingsBody);

// 设置页 <select> 统一接管为自绘下拉（studio/dropdown.ts，2.7b 结论：Windows 原生展开菜单是
// 系统蓝配色、CSS 不可覆盖）。用 observer 自动接管而非逐卡调用 —— 今后设置卡重排 / 新增任何
// <select>，挂进 #settings-body 即被美化，渲染代码零改动（beautifyDropdown 自带防重复绑定）。
if (settingsBody) {
  const enhanceSelects = (): void =>
    settingsBody.querySelectorAll("select").forEach((s) => beautifyDropdown(s as HTMLSelectElement));
  enhanceSelects();
  new MutationObserver(enhanceSelects).observe(settingsBody, { childList: true, subtree: true });
}

const aboutBody = document.getElementById("about-body");
if (aboutBody) wireAbout(aboutBody);

// 「恢复默认」（5.1.1 §4.5）：全部键写回默认值 → 数据层回填 → 重渲染 → 视觉复位
// （2.11 时的「用 def 重新渲染一遍」语义由此升级为「落盘默认值」，照原型 resetSettings() 的用户预期）
const resetBtn = document.getElementById("settings-reset");
if (resetBtn) resetBtn.addEventListener("click", () => void resetUiToDefaults());
