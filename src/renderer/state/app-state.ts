// ============================================================
// nahida 状态层 —— 全项目唯一状态源（第三阶段 3.1）
// 依据：内部规格 §2、§7「架构建议」
//       内部规格 3.1
// 规矩：① 一切写入走 patch(partial, source)，带来源便于追溯
//          （好感度以后会被 剧情 / 聊天时长 / 设置 三处同时改，出问题要知道是谁改的；
//          好感度的真相在主进程独立文件，本文件只持有投影 —— 5.6.1）；
//       ② 业务数值与文案只许出现在本文件「数据层」一节，渲染函数与 CSS 里不许出现；
//       ③ 本步唯一真实数据是 model（聊天链路写入）与 env.clock（真实系统时间），其余为占位值。
// ============================================================

import type { DeepPartial } from "../../shared/types";
import {
  initialRelationshipState,
  viewOf,
  type AffectionSource,
  type RelationshipView,
} from "../../shared/relationship";

/** 模型连接状态：unknown 未探测 / connecting 探测中 / connected 可用 / error 不可用 */
export type ModelStatus = "unknown" | "connecting" | "connected" | "error";

/** 写入来源：用于追溯「这个值是谁改的」。与好感度来源同一份定义（提到 shared 避免两套白名单，5.6.1 坑 1） */
export type Source = AffectionSource;

export interface AppState {
  /** 模型连接 —— 3.1 唯一真实数据源（来自聊天链路） */
  model: {
    status: ModelStatus;
    /** 当前模型 id，如 "qwen2.5:7b"；未选中为空串 */
    name: string;
    /** 厂商 id：3.4 建 provider 预设表后由 provider 层填。本步不猜、不写死厂商名 */
    provider: string;
    /** 错误信息；空串 = 无错误（用空串而不是 undefined，patch 才能把它清回去） */
    error: string;
  };
  /** 角色状态（好感度系统 5.6 接管；affection 是主进程真值的投影，形状来自 shared 契约） */
  character: {
    mood: string;
    affection: RelationshipView;
  };
  /** 环境：时钟真实（见文件末尾 startClock）；天气 6.6.4 起可切在线真值 —— source 标记数据来源，拉取成功才置 "online" */
  env: {
    clock: { time: string; date: string };
    weather: { text: string; temp: string; source: "system" | "online" };
  };
  /**
   * 各视图统计。tasks.pending / tasks.completionPct 是真值 —— 由 tasks.ts 的 refreshCounts()
   * 在末尾发布（source "tool"，5.3.2）；memory 三数是真值 —— 由 memory.ts 的 refreshArchives()
   * 发布（source "system"，5.5.2）；其余占位（无数据源，见 INITIAL_STATE 上方注释）
   */
  tasks: { todayFocusMin: number; focusGoalMin: number; completionPct: number; pending: number };
  /** 回忆视图的存档统计（5.5.2）：真值由 memory.ts 读 chats.list() 后发布，source "system"。
   *  口径：archives = 列表长度；messages = Σ meta.messageCount；weekNew = createdAt 落在最近
   *  7×24h（Date.now() - 7 * 864e5）内的条数 —— 滚动 7 天，不搞自然周（避免「周一清零」歧义） */
  memory: { archives: number; messages: number; weekNew: number };
  studio: { shots: number; clips: number; live: boolean; tools: number };
  /** 7.4：顶栏「聊天/工作」模式（单一状态，按钮式两态翻转）。聊天态 = 本轮不调工具 ——
   *  经 ChatRequest.mode 过桥到主进程门控审批通道；初始恒为聊天态（会话行为向后兼容由显式传值保证） */
  uiMode: "chat" | "work";
}

export interface StateMeta {
  /** 点路径 → 最后改它的来源，如 "model.status": "chat" */
  sources: Record<string, Source>;
  /** 最近一次写入来源 */
  lastSource: Source;
  /** 最近一次写入时间（毫秒时间戳） */
  updatedAt: number;
}

// ==================== 数据层（本文件唯一允许出现业务数值 / 文案的地方） ====================
// 真值来源：model（main.ts 写入）、env.clock（refreshClock 写入）、
// env.weather（数据源 = config.ui.weatherSource 的在线拉取真值，拉取成功才回填 + 置 source:"online"，6.6.4；
// "system" 模式不拉取、维持占位）、character.affection（bootstrap
// 回填主进程 store 读数，5.6.1）、tasks.pending / tasks.completionPct（tasks.ts refreshCounts 发布，5.3.2）、
// memory 三数（memory.ts refreshArchives 发布，5.5.2）。
// 占位值（无数据源，宁占位也不做假真值 / 不读 DOM 数数，5.3.2 硬约束 3）：
//   · tasks.todayFocusMin / tasks.focusGoalMin —— 无番茄钟数据源；focusGoalMin 是每日专注目标分钟数，
//     恒 > 0（渲染层拿它做除法算百分比，5.3.2 坑 3）
//   · studio.tools —— 工具清单只存在于 index.html 的静态标记里，状态层不读 DOM
// 后续替换来源：character.mood（单独一步）
//              ／ studio ← 接入真实数据源后（照 5.3.2 §3.2 的形状发布）
const INITIAL_STATE: AppState = {
  model: { status: "unknown", name: "", provider: "", error: "" },
  character: {
    mood: "平和",
    // 首屏前的真值投影初值（0 / Lv.1）；bootstrap 起来后立刻被主进程 store 读数覆盖，别在这里写死数值
    affection: viewOf(initialRelationshipState(Date.now())),
  },
  env: {
    clock: { time: "", date: "" }, // 出生即被 refreshClock() 填成真实时间，这里留空
    weather: { text: "林间晴光", temp: "21°C", source: "system" }, // 在线拉取成功前保持占位（6.6.4 绝不冒充在线数据）
  },
  // 今日专注无番茄钟功能入口 / 无数据源 → 自然 0（功能启用后才会有值，6.5），不是写死、也不是被清空
  tasks: { todayFocusMin: 0, focusGoalMin: 130, completionPct: 36, pending: 7 },
  // 0 = 还没读，不是假数据；memory.ts 模块顶层那次 refreshArchives() 会立刻填真值
  memory: { archives: 0, messages: 0, weekNew: 0 },
  studio: { shots: 42, clips: 6, live: false, tools: 6 },
  uiMode: "chat", // 7.4：启动恒为聊天态（点顶栏按钮才翻转）
};

/** 星期名（与 panel.ts 的日期格式配套） */
const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
// ==================== 数据层结束 ====================

/** 开发期把每次写入打到控制台，便于确认「这个值是谁改的」；打包后 location 是 file://，自动静默 */
const DEV_LOG = location.protocol.startsWith("http");

type Dict = Record<string, unknown>;

function isPlainObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 深合并：产出新对象，不改旧引用 —— 订阅者手里的旧快照不会被后续 patch 影响 */
function mergeDeep(base: Dict, incoming: Dict): Dict {
  const out: Dict = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue; // undefined = 本次不改这个字段
    const prev = out[key];
    out[key] = isPlainObject(value) && isPlainObject(prev) ? mergeDeep(prev, value) : value;
  }
  return out;
}

/** 把 patch 摊平成点路径，用于记「哪个字段被谁改了」 */
function collectPaths(incoming: Dict, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value)) paths.push(...collectPaths(value, path));
    else paths.push(path);
  }
  return paths;
}

let state: AppState = INITIAL_STATE;
let meta: StateMeta = { sources: {}, lastSource: "system", updatedAt: Date.now() };

type Listener = (state: Readonly<AppState>, meta: Readonly<StateMeta>) => void;
const listeners: Listener[] = [];

/** 读当前状态（只读；要改走 patch，不要直接改它） */
export function getState(): Readonly<AppState> {
  return state;
}

/** 读来源信息（排查「这个值是谁改的」用） */
export function getMeta(): Readonly<StateMeta> {
  return meta;
}

/** 订阅状态变化，返回取消订阅函数（3.8 / 3.9 起 UI 从这里拿数据） */
export function subscribe(listener: Listener): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
}

/**
 * 唯一的写入入口
 * @param partial 只写要改的字段（嵌套也只需写要改的那一层）
 * @param source  谁改的，会记进 meta.sources
 */
export function patch(partial: DeepPartial<AppState>, source: Source): void {
  const paths = collectPaths(partial as unknown as Dict);
  state = mergeDeep(state as unknown as Dict, partial as unknown as Dict) as unknown as AppState;

  const sources = { ...meta.sources };
  for (const path of paths) sources[path] = source;
  meta = { sources, lastSource: source, updatedAt: Date.now() };

  if (DEV_LOG) console.debug(`[nahida:state] ${source} → ${paths.join(", ")}`);
  // 复制一份再遍历：订阅者在回调里取消订阅也不会打断本轮派发
  for (const listener of [...listeners]) listener(state, meta);
}

// ---------- 时钟（清单 D2：接真实系统时间，替换写死的 15:57） ----------

/** 取当前时间；格式与 panel.ts 的 getWeatherClock() 一致，5.3 接右栏时可直接替换 */
function nowClock(): { time: string; date: string } {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    date: `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${WEEKDAYS[d.getDay()]}`,
  };
}

/** 立刻把 env.clock 刷成真实系统时间 */
export function refreshClock(): void {
  patch({ env: { clock: nowClock() } }, "system");
}

let clockTimer: number | null = null;

/** 起心跳让 env.clock 保持真实（默认 30 秒一次），返回停止函数 */
export function startClock(intervalMs = 30_000): () => void {
  refreshClock();
  if (clockTimer !== null) window.clearInterval(clockTimer);
  clockTimer = window.setInterval(refreshClock, intervalMs);
  return () => {
    if (clockTimer !== null) window.clearInterval(clockTimer);
    clockTimer = null;
  };
}
