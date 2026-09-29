// ============================================================
// nahida 右栏状态面板（2.8）
// 卡片组随视图变化；文案照抄 5 个原型 HTML 的右栏原文
// 来源：原型 {home,tasks,studio,memory,settings}.html
// 结构参考《界面还原清单》§1.5
// 图标全部内联 SVG（禁 emoji / 禁 CDN）；静态文案仍集中在数据层；时钟 / 好感度 / 心情来自 app-state（5.3.1）
// ============================================================

import { onViewChange } from "../sidebar/sidebar";
import { getState, patch, subscribe, type AppState } from "../state/app-state";
import type { RelationshipView } from "../../shared/relationship";

// ---------- 内联图标（lucide 原始路径，stroke-width 统一 1.6，与项目其余图标一致） ----------
const ICON = {
  cloudSun: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v2m-7.07.93l1.41 1.41M20 12h2m-2.93-7.07l-1.41 1.41m-1.713 6.31a4 4 0 0 0-5.925-4.128M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6"/></svg>`,
  thermometer: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2v2m0 4a4 4 0 0 0-1.645 7.647M2 12h2m16 2.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0zM4.93 4.93l1.41 1.41m0 11.32l-1.41 1.41"/></svg>`,
  wind: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.8 19.6A2 2 0 1 0 14 16H2m15.5-8a2.5 2.5 0 1 1 2 4H2m7.8-7.6A2 2 0 1 1 11 8H2"/></svg>`,
  cloud: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9"/></svg>`,
  moon: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>`,
  sunset: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 10V2m-7.07 8.93l1.41 1.41M2 18h2m16 0h2m-2.93-7.07l-1.41 1.41M22 22H2M16 6l-4 4l-4-4m8 12a4 4 0 0 0-8 0"/></svg>`,
  sparkle: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"/></svg>`,
} as const;

// 注：静态卡片文案集中在「数据层」一节（渲染函数之后、交互接线之前）；时钟 / 好感度 / 心情值渲染时取自 app-state。

// ---------- 类型 ----------
type Tone = "green" | "gold" | "deep";
type Metric = { label: string; value: string; pct: number; tone: Tone };
type WeatherRow = { icon: keyof typeof ICON; tone: "gold" | "green"; text: string };

type Card =
  | { kind: "role"; badge: string; metrics: Metric[]; note: string }
  | { kind: "bond"; percent: number; lines: string[]; footer?: { kind: "bar"; label: string; right: string; pct: number } | { kind: "note"; text: string } }
  | { kind: "affection"; affection: RelationshipView }
  | { kind: "mood"; current: string; chips: { label: string; tip: string }[]; active: number; interactive: boolean; note: string }
  | { kind: "weather"; rows: WeatherRow[]; note?: string }
  | { kind: "overview"; badge: string; cells: { value: string; unit?: string; label: string; tone: "green" | "gold" }[]; note: string };

// ---------- 渲染 ----------
const head = (title: string, right = ""): string =>
  `<div class="panel-card__head"><p class="panel-card__title">${title}</p>${right}</div>`;

function renderRole(c: Extract<Card, { kind: "role" }>): string {
  const metrics = c.metrics
    .map(
      (m) => `<div class="panel-metric">
        <div class="panel-metric__row"><span>${m.label}</span><span class="panel-metric__value${m.tone === "gold" ? " panel-metric__value--gold" : ""}">${m.value}</span></div>
        <div class="panel-metric__track"><div class="panel-metric__fill panel-metric__fill--${m.tone}" style="width:${m.pct}%"></div></div>
      </div>`,
    )
    .join("");
  return `<section class="panel-card glass">${head("角色状态", `<span class="panel-card__badge">${c.badge}</span>`)}
      <div class="panel-metrics">${metrics}</div>
      <p class="panel-note">${c.note}</p>
    </section>`;
}

// 圆环几何：r=48 → 周长 2πr ≈ 301.6；dashoffset = 周长 ×(1 - 百分比)
const RING_R = 48;
const RING_LEN = 2 * Math.PI * RING_R;

function renderBond(c: Extract<Card, { kind: "bond" }>): string {
  const offset = RING_LEN * (1 - c.percent / 100);
  const ring = `<svg class="panel-bond__ring" viewBox="0 0 120 120" role="img" aria-label="羁绊值 ${c.percent}%">
        <circle cx="60" cy="60" r="${RING_R}" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="10"></circle>
        <circle cx="60" cy="60" r="${RING_R}" fill="none" stroke="#d8b45f" stroke-width="10" stroke-linecap="round" stroke-dasharray="${RING_LEN.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>
      </svg>`;
  const lines = `<div class="panel-bond__lines">${c.lines.map((l) => `<p>${l}</p>`).join("")}</div>`;
  let footer = "";
  if (c.footer?.kind === "bar") {
    footer = `<div class="panel-bar">
        <div class="panel-bar__row"><span>${c.footer.label}</span><span>${c.footer.right}</span></div>
        <div class="panel-bar__track"><div class="panel-bar__fill" style="width:${c.footer.pct}%"></div></div>
      </div>`;
  } else if (c.footer?.kind === "note") {
    footer = `<p class="panel-note panel-note--gold">${c.footer.text}</p>`;
  }
  return `<section class="panel-card glass">${head("羁绊值")}
      <div class="panel-bond">${ring}<div><p class="panel-bond__value">${c.percent}<span>%</span></p>${lines}</div></div>
      ${footer}
    </section>`;
}

// 5.3.1 好感度卡（规格冻结于 5.6.2 §4）：环几何与渲染结构沿用 bond 卡，数据整份来自 app-state 的 RelationshipView。
// 铁律：环 / 大数字 / 底部条 pct 三者都等于 value（总好感度 0–100）；gap 是绝对差距，只出现在「还差 N%」一句里，与环故意不相等。
function renderAffection(c: Extract<Card, { kind: "affection" }>): string {
  const v = c.affection;
  const top = v.gap === null; // 顶级（依赖）：文案换「已达最高阶段」、right 留空；环和条仍如实画 value，不顶成 100
  const offset = RING_LEN * (1 - v.value / 100);
  const ring = `<svg class="panel-bond__ring" viewBox="0 0 120 120" role="img" aria-label="好感度 ${v.value}%">
        <circle cx="60" cy="60" r="${RING_R}" fill="none" stroke="rgba(255,255,255,.9)" stroke-width="10"></circle>
        <circle cx="60" cy="60" r="${RING_R}" fill="none" stroke="#d8b45f" stroke-width="10" stroke-linecap="round" stroke-dasharray="${RING_LEN.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>
      </svg>`;
  const lines = `<div class="panel-bond__lines"><p>相识 ${v.days} 天</p><p>本周共同完成 ${v.weekQuests} 次委托</p></div>`;
  const footer = `<div class="panel-bar">
        <div class="panel-bar__row"><span>${top ? "已达最高阶段" : `距离下一阶段「${v.nextLevelName}」`}</span><span>${top ? "" : `还差 ${v.gap}%`}</span></div>
        <div class="panel-bar__track"><div class="panel-bar__fill" style="width:${v.value}%"></div></div>
      </div>`;
  return `<section class="panel-card glass">${head("好感度")}
      <div class="panel-bond">${ring}<div><p class="panel-bond__value">${v.value}<span>%</span></p>${lines}</div></div>
      ${footer}
    </section>`;
}

function renderMood(c: Extract<Card, { kind: "mood" }>): string {
  const chips = c.chips
    .map((chip, i) =>
      c.interactive
        ? `<button type="button" class="mood-chip" data-active="${i === c.active}" data-tip="${chip.tip}">${chip.label}</button>`
        : `<span class="mood-chip" data-active="${i === c.active}">${chip.label}</span>`,
    )
    .join("");
  return `<section class="panel-card glass">${head("心情", `<span class="panel-mood__current" id="panel-mood-current">当前 · ${c.current}</span>`)}
      <div class="panel-mood__chips">${chips}</div>
      <p class="panel-note" id="panel-mood-tip">${c.note}</p>
    </section>`;
}

function renderWeather(_c: Extract<Card, { kind: "weather" }>): string {
  // 6.6.4：数据源是「在线 API」且拉到了真值（env.weather.source === "online"）→ 天气行读状态层真值
  // 7.2-1.2 天气空值文案：非在线（未设经纬度 / 没拉到）→ 不再渲染原型占位硬数据行（_c.rows 保留在
  //   数据层不动），改渲染金色提示块；时间 / 日期两行原样保留。绝不拿占位冒充在线数据
  const w = getState().env.weather;
  const online = w.source === "online";
  const rows: WeatherRow[] = online
    ? [{ icon: "thermometer", tone: "gold", text: `${w.text} · ${w.temp}` }]
    : [];
  const note = online
    ? `<p class="panel-note panel-note--gold">在线数据 · Open-Meteo</p>`
    : `<p class="panel-note panel-note--gold">天气数据未设置，可在设置中填写经纬度</p>`;
  const clock = getState().env.clock; // 真实系统时间，由 startClock() 每 30 秒刷新；渲染时取，状态变就跟变
  return `<section class="panel-card glass">${head("时间与天气", `<span class="panel-weather__head-icon">${ICON.cloudSun}</span>`)}
      <p class="panel-weather__time">${clock.time}</p>
      <p class="panel-weather__date">${clock.date}</p>
      ${rows.length ? `<div class="panel-weather__rows">${rows.map(
        (r) => `<p class="panel-weather__row"><span class="panel-weather__icon panel-weather__icon--${r.tone}">${ICON[r.icon]}</span>${r.text}</p>`,
      ).join("")}</div>` : ""}
      ${note}
    </section>`;
}

function renderOverview(c: Extract<Card, { kind: "overview" }>): string {
  const cells = c.cells
    .map(
      (cell) => `<div class="panel-overview__cell">
        <p class="panel-overview__value${cell.tone === "gold" ? " panel-overview__value--gold" : ""}">${cell.value}${cell.unit ? `<small>${cell.unit}</small>` : ""}</p>
        <p class="panel-overview__label">${cell.label}</p>
      </div>`,
    )
    .join("");
  return `<section class="panel-card glass">${head("存档概览", `<span class="panel-card__badge">${c.badge}</span>`)}
      <div class="panel-overview">${cells}</div>
      <p class="panel-note">${c.note}</p>
    </section>`;
}

function renderCard(card: Card): string {
  switch (card.kind) {
    case "role": return renderRole(card);
    case "bond": return renderBond(card);
    case "affection": return renderAffection(card);
    case "mood": return renderMood(card);
    case "weather": return renderWeather(card);
    case "overview": return renderOverview(card);
  }
}

// ============================================================
// 数据层：静态文案仍是占位值；时钟 / 好感度 / 心情值来自 app-state（5.3.1 起由工厂函数在渲染时注入）
// ------------------------------------------------------------
// · 所有静态卡片文案集中在这里；上面的渲染函数与 panel.css 不含任何业务数值
// · 后续接真实数据时：Card 类型不变，把下面各表的值换成从数据源取来的即可，渲染层零改动
// · 数据来源两条路（用户 2026-09-26 明确）：
//     ① 已开源的工具 / 库
//     ② 从 内部参考项目 搬现成实现 —— **只读复制，严禁改动该目录任何文件**
//        （搬运照项目惯例：改名 → 瘦身 → 按新结构调整 → 注释标注来源）
// · 禁止：本地取系统时间（一律走 env.clock）、setInterval；
//   天气在线数据只经主进程 IPC 取（6.6.4），渲染层自己不 fetch
// ============================================================

// 同批预留（仍按原型文案静态放在下面各视图的映射表里，后续一起提进数据源）：
//   `日落 18:34`、`距露台浇灌还有 2 小时 33 分`、`黄金拍摄窗口 17:50`

// ---------- 视图 → 卡片工厂（文案逐字照抄原型右栏；chat 的心情 / 时间接真值，其余仍占位） ----------
// 6.3：聊天视图收敛为两卡 —— 「角色状态」「好感度」「快捷入口」三卡删（好感度只删工厂调用，
// renderAffection / affection 分支 / AppState.character.affection 全保留，剧情更新后加回一行即恢复）
const chatCards = (s: Readonly<AppState>): Card[] => {
  // 心情 chips 表是静态的；current / active / note 三项是从 app-state 派生的活值（5.3.1 §3.6）
  const chips = [
    { label: "平和", tip: "她的语气会像午后的林间风，缓慢而清晰。" },
    { label: "好奇", tip: "回复里会多一些追问，适合一起探索新的线索。" },
    { label: "温柔", tip: "她会先照顾你的情绪，再谈具体的安排。" },
    { label: "灵感迸发", tip: "偶尔会冒出跳跃的想法，记得顺手存进长期记忆。" },
  ];
  // mood 被写成这张表没有的词时 findIndex = -1 → 回落 0，否则整排 chip 都不高亮（5.3.1 坑 12）
  const idx = chips.findIndex((c) => c.label === s.character.mood);
  const active = idx === -1 ? 0 : idx;
  return [
    {
      kind: "mood", current: s.character.mood, active, interactive: true,
      chips,
      note: chips[active]?.tip ?? "",
    },
    {
      kind: "weather",
      rows: [
        { icon: "thermometer", tone: "gold", text: "林间晴光 · 21°C · 湿度 62%" },
        { icon: "wind", tone: "green", text: "净善宫 · 微风 2 级" },
        { icon: "sparkle", tone: "gold", text: "世界树光点活跃度 · 高" },
      ],
      note: "午后森林光线柔和，适合在露台继续校对草木志。",
    },
  ];
};

const STUDIO_CARDS: Card[] = [
  {
    kind: "role", badge: "陪伴中",
    metrics: [
      { label: "元素能量", value: "92%", pct: 92, tone: "green" },
      { label: "画面算力", value: "78%", pct: 78, tone: "gold" },
      { label: "存储占用", value: "47%", pct: 47, tone: "deep" },
    ],
    note: "录屏与直播都会占用算力，长时间开播时她会主动提醒你让树冠透口气。",
  },
  {
    kind: "bond", percent: 82,
    lines: ["一起看过的画面：468 分钟", "共同完成的小游戏：41 局"],
  },
  {
    kind: "mood", current: "好奇", active: 0, interactive: false,
    chips: [
      { label: "好奇", tip: "" },
      { label: "平和", tip: "" },
      { label: "雀跃", tip: "" },
    ],
    note: "看你在符文推演里连赢三局，她比你还高兴一点点。",
  },
  {
    kind: "weather",
    rows: [
      { icon: "thermometer", tone: "gold", text: "林间晴光 · 21°C · 湿度 62%" },
      { icon: "cloud", tone: "green", text: "傍晚可能有薄云，适合拍摄延时" },
      { icon: "sunset", tone: "gold", text: "日落 18:34 · 黄金拍摄窗口 17:50" },
    ],
  },
];

// 5.5.2：memory 视图旧卡的「记忆概览 / 最近整理」数据源没了 —— 接新源（存档真值），不许留着展示死数据。
// 三格全从 s.memory 读（memory.ts 的 refreshArchives() 发布的真值），0 只能是「还没读到」
const memoryCards = (s: Readonly<AppState>): Card[] => [
  {
    kind: "overview", badge: "本周",
    cells: [
      { value: String(s.memory.archives), label: "存档总数", tone: "green" },
      { value: String(s.memory.messages), label: "消息总数", tone: "gold" },
      { value: String(s.memory.weekNew), label: "本周新建", tone: "green" },
    ],
    note: "点一份存档，即可回到那次对话。",
  },
];

const SETTINGS_CARDS: Card[] = [
  {
    kind: "role", badge: "安静",
    metrics: [
      { label: "元素能量", value: "92%", pct: 92, tone: "green" },
      { label: "本地存储占用", value: "2.6 GB", pct: 34, tone: "gold" },
      { label: "运行时长", value: "6 小时 12 分", pct: 62, tone: "deep" },
    ],
    note: "她在设置页会格外安静，只在你改动“陪伴方式”时轻轻点头。",
  },
  {
    kind: "bond", percent: 82,
    lines: ["相识 216 天", "共同完成委托 128 次"],
  },
  {
    kind: "mood", current: "平和", active: 0, interactive: false,
    chips: [
      { label: "平和", tip: "" },
      { label: "温柔", tip: "" },
    ],
    note: "语气设定为「温柔缓慢」时，她的回复会多一句停顿，像林间的风。",
  },
  {
    kind: "weather",
    rows: [
      { icon: "thermometer", tone: "gold", text: "林间晴光 · 21°C · 湿度 62%" },
      { icon: "wind", tone: "green", text: "净善宫 · 微风 2 级" },
    ],
  },
];

// 关于页原型没有 → 复用设置页那一套（原型里「关于」就挂在 settings.html#about 上）
// 5.3.1：每项改成工厂 —— affection / mood / 时钟是活值，静态 const 装不下；
// studio / memory / settings / about 四项机械包壳，卡片内容与 5.3.1 交付时逐字一致（5.3.2 起任务视图也接 s）。
type CardFactory = (s: Readonly<AppState>) => Card[];
const PANEL_BY_VIEW: Record<string, CardFactory> = {
  chat: chatCards,
  // 5.3.2：任务视图只留 role + affection 两张卡；原 bond / mood / weather 三张删
  //（affection 与聊天视图完全同规格：同一个 renderAffection、同一份 s.character.affection，5.3.2 坑 12）
  // 6.3：affection 卡删（只删工厂调用，renderAffection 保留 —— 恢复时加回一行即可）
  tasks: (s) => [
    {
      kind: "role", badge: "专注",
      metrics: [
        {
          label: "今日专注",
          value: `${s.tasks.todayFocusMin} 分钟`,
          // focusGoalMin 恒 > 0（数据层注释）；超出目标时夹满 100，防进度条溢出容器（5.3.2 坑 14）
          pct: Math.min(100, Math.round((s.tasks.todayFocusMin / s.tasks.focusGoalMin) * 100)),
          tone: "green",
        },
        { label: "委托完成率", value: `${s.tasks.completionPct}%`, pct: s.tasks.completionPct, tone: "gold" },
      ],
      note: "先把需要专注的校订做完，剩下的都可以在花园里慢慢来。",
    },
  ],
  studio: () => STUDIO_CARDS,
  memory: memoryCards,
  settings: () => SETTINGS_CARDS,
  about: () => SETTINGS_CARDS,
};

/** 查不到的视图回落聊天那一套（与顶部栏 / 底部卡的兜底一致） */
function cardsFor(view: string, s: Readonly<AppState>): Card[] {
  return (PANEL_BY_VIEW[view] ?? PANEL_BY_VIEW.chat)(s);
}
// ==================== 数据层结束（以上为可整体替换的占位数据） ====================

// ---------- 交互接线（只作用于刚渲染出来的节点） ----------
function wire(host: HTMLElement): void {
  // 心情 chip：只有聊天视图是可点的。选中态不再手改 DOM —— 走 patch 写进 app-state（来源 settings），
  // subscribe 触发重渲染后选中态自然正确；切视图再切回来也不丢（旧 data-active 写法是 DOM 局部态，重渲染即丢）。
  const chips = host.querySelectorAll<HTMLButtonElement>("button.mood-chip[data-tip]");
  chips.forEach((chip) => {
    chip.addEventListener("click", () => {
      patch({ character: { mood: chip.textContent ?? "" } }, "settings");
    });
  });
}

// ---------- 渲染主循环（5.3.1）：跟订阅走 + key 比对，内容没变一个 DOM 都不碰 ----------
let host: HTMLElement;
let currentView = "chat";
let lastKey = "";

function render(view: string, resetScroll = false): void {
  currentView = view;
  // 7.2-1.1 右栏统一策略：只有 chat / memory 两视图显示右栏。tasks（用户裁定「遮挡」：主区向右占满，
  // 同 settings 原方式）与 studio / settings / about 的「删除」在不占位上是同一语义，统一走
  // #panel[hidden]{display:none}（app.css:106），隐藏后 .view-area（flex:1 1 auto）自动铺满，不新增蒙板
  host.hidden = view !== "chat" && view !== "memory";
  const html = cardsFor(view, getState()).map(renderCard).join("");
  const key = `${view}\u0000${html}`; // 视图名必须进 key：settings/about 共用一表，只比 HTML 会漏渲染
  if (key === lastKey) return; // 内容没变 → 直接 return（subscribe 触发很频繁，回调必须廉价）
  lastKey = key;
  host.innerHTML = html;
  wire(host); // 只在真的重写过 innerHTML 之后调：旧节点已丢弃，同一节点 wire 两次会双触发
  if (resetScroll) host.scrollTop = 0; // 只有切视图才回顶；状态变化引起的重渲染不许动滚动位置
}

export function initPanel(): void {
  const el = document.getElementById("panel");
  if (!el) {
    console.error("[nahida] 缺少 #panel，右栏面板未渲染");
    return;
  }
  host = el;
  onViewChange((name) => render(name, true)); // 切视图 → 回顶
  subscribe(() => render(currentView)); // 状态变 → 重渲染（不回顶）
  // 初始渲染：initSidebar() 已经切过一次视图，这次回调收不到，所以自己读当前激活项
  const initial = document.querySelector<HTMLElement>(".sidebar__nav .menu-item.active")?.dataset.view;
  render(initial ?? "chat", true);

  // 6.6.4：启动时数据源是「在线 API」且有合法经纬度 → 静默拉一次回填 env.weather（幂等；
  // 失败保持占位不提示，设置页里切来源 / 改坐标会再拉）。只有 ok 才 patch —— 绝不冒充在线数据
  void (async () => {
    try {
      const ui = (await window.nahida.config.get()).ui;
      const lat = ui.weatherLat;
      const lon = ui.weatherLon;
      if (ui.weatherSource !== "online" || typeof lat !== "number" || typeof lon !== "number") return;
      const r = await window.nahida.weather.fetchOnline({ lat, lon });
      if (r.ok && r.text !== undefined && r.temp !== undefined) {
        patch({ env: { weather: { text: r.text, temp: r.temp, source: "online" } } }, "system");
      }
    } catch {
      /* 启动拉取失败静默 —— env.weather 保持占位 */
    }
  })();
}

initPanel();
