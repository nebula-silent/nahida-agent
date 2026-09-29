// 2.9 任务视图：数据层 + 渲染 + 交互（标签页切换 / 勾选完成 / 隐藏已完成 / 新增委托）
// 素材源：原型 tasks.html（结构、文案照抄；原型 class 已在 tasks.css 翻译为原生 CSS）
// 约定：视图内所有业务数值集中在下面「数据层」一节，渲染函数与 tasks.css 不含业务数值
//
// 5.11 v1 占位收口：HEAD_TITLE / TABS / TASKS / EXTRA_TASKS 硬编码数据已整块删除 ——
//      界面只渲染占位「后续版本将逐步开放」（静态写入 index.html），渲染与交互骨架全保留
//      （原引用以「空表查找 / 遍历既有面板 DOM」修正，恒空跑），开闸后恢复数据表即可，零结构改动。

// 本文件顶层执行且无对外接口，export 空对象仅为使其成为 ES module
// （独立作用域，避免与 studio.ts 等全局脚本的顶层变量撞名）
export {};

import { patch } from "../state/app-state";

// ============================================================
// 数据层：5.11 起为空 —— 类型保留（开闸后 TaskItem 等直接复用），
// 硬编码值（HEAD_TITLE / TABS / TASKS / EXTRA_TASKS）已删，恢复时按 git 历史取回。
// ============================================================

type TaskTab = "daily" | "world" | "garden";
type TagTone = "green" | "gold" | "ink";

interface TaskTag {
  text: string;
  tone: TagTone;
}

interface TaskMeta {
  /** ICON 表的键 */
  icon: "clock" | "signal" | "pin";
  text: string;
}

interface TaskProgress {
  label: string;
  pct: number;
  tone: "green" | "gold";
}

interface TaskItem {
  id: string;
  tab: TaskTab;
  title: string;
  tags: TaskTag[];
  desc: string;
  meta?: TaskMeta[];
  progress?: TaskProgress;
  /** 花园培育卡专有：栽培天数 · 位置 */
  sub?: string;
  /** 花园培育卡专有：底部浅色提示 */
  note?: string;
  done: boolean;
}

/** 内联 SVG（Lucide 路径，禁用 emoji / 禁用外部图标服务） */
const ICON: Record<string, string> = {
  check:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  clock:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>',
  signal:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/><path d="M17 20V8"/><path d="M22 4v16"/></svg>',
  pin:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>',
};

// ============================================================
// 渲染层：只读数据层，不含任何业务数值（v1 起无数据，仅骨架保留）
// ============================================================

const tagHTML = (tag: TaskTag): string => `<span class="tag tag-${tag.tone}">${tag.text}</span>`;

const metaHTML = (task: TaskItem): string =>
  task.meta?.length
    ? `<div class="task-card__meta">${task.meta
        .map((m) => `<span>${ICON[m.icon]}${m.text}</span>`)
        .join("")}</div>`
    : "";

const progressHTML = (task: TaskItem): string => {
  if (!task.progress) return "";
  const { label, pct, tone } = task.progress;
  return `<div class="task-card__progress">
      <div class="task-card__progress-head"><span>${label}</span><span class="task-card__progress-pct${tone === "gold" ? " task-card__progress-pct--gold" : ""}">${pct}%</span></div>
      <div class="task-progress"><div class="task-progress__fill${tone === "gold" ? " task-progress__fill--gold" : ""}" style="width:${pct}%"></div></div>
    </div>`;
};

/** 普通任务卡（每日 / 世界） */
const cardHTML = (task: TaskItem): string => `
  <article class="task-card" data-id="${task.id}" data-done="${task.done}">
    <button type="button" class="task-check" title="${task.done ? "取消完成" : "标记完成"}" aria-pressed="${task.done}">${ICON.check}</button>
    <div class="task-card__body">
      <div class="task-card__head">
        <p class="task-card__title">${task.title}</p>
        ${task.tags.map(tagHTML).join("")}
      </div>
      <p class="task-card__desc">${task.desc}</p>
      ${metaHTML(task)}
      ${progressHTML(task)}
    </div>
  </article>`;

/** 花园培育卡（结构不同：标题 + 副标题在左，勾选框在右，底部浅色提示） */
const gardenCardHTML = (task: TaskItem): string => `
  <article class="task-card task-card--garden" data-id="${task.id}" data-done="${task.done}">
    <div class="task-card__garden-head">
      <div>
        <p class="task-card__title">${task.title}</p>
        <p class="task-card__sub">${task.sub ?? ""}</p>
      </div>
      <button type="button" class="task-check" title="${task.done ? "取消完成" : "标记完成"}" aria-pressed="${task.done}">${ICON.check}</button>
    </div>
    ${progressHTML(task)}
    <p class="task-card__note">${task.note ?? ""}</p>
  </article>`;

// v1 占位（5.11）：TASKS 已删，gardenCardHTML 暂无调用点（开闸后由 renderAll 的花园分支恢复使用）
void gardenCardHTML;

// ============================================================
// 交互层
// ============================================================

const body = document.querySelector<HTMLElement>(".tasks__body");
const hideSwitch = document.getElementById("tasks-hide");
const addBtn = document.getElementById("tasks-add");
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".tasks__tabs .tab-btn"));
const panelOf = (tab: TaskTab): HTMLElement | null =>
  document.querySelector<HTMLElement>(`.tasks__panel[data-panel="${tab}"]`);

/** 首次渲染：遍历既有面板 DOM 填充。
 *  v1 占位（5.11）：TASKS 数据已删、三个面板已从 index.html 移除 —— 循环空跑；开闸后恢复按 TABS×TASKS 填充。 */
function renderAll(): void {
  for (const panel of document.querySelectorAll<HTMLElement>(".tasks__panel")) {
    panel.replaceChildren(); // v1：无数据可填，仅保证面板为空
  }
  refreshCounts();
}

/** 统计：总完成数 / 完成率 / 每页角标；数据全部来自 TASKS。
 *  v1 占位（5.11）：TASKS 已删 → 恒 0，仍照常发布给右栏（pending 0 / 完成率 0% 是预期，勿改 panel.ts）。 */
function refreshCounts(): void {
  const total = 0; // v1 空表（原 TASKS.length）
  const done = 0; // v1 空表（原 TASKS.filter(t => t.done).length）
  const pct = total ? Math.round((done / total) * 100) : 0;

  const set = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set("tasks-done", String(done));
  set("tasks-total", String(total));
  set("tasks-pct", `${pct}%`);

  const bar = document.getElementById("tasks-bar");
  if (bar) bar.style.width = `${pct}%`;

  // 角标：原按 TABS 遍历，v1 改为遍历既有面板 DOM（面板已移除 → 空跑）
  for (const panel of document.querySelectorAll<HTMLElement>(".tasks__panel")) {
    const tabId = panel.dataset.panel;
    if (tabId) set(`tasks-badge-${tabId}`, "0/0");
  }

  // 5.3.2：把统计发布给状态层（右栏 role 卡与 quick 卡从这里读）
  patch({ tasks: { pending: total - done, completionPct: pct } }, "tool");
}

/** 勾选完成 / 取消完成：只改这一张卡，不整块重渲染（保留过渡动画）。
 *  v1 占位（5.11）：TASKS 已删 —— 查空表恒 undefined，命中 `!task` 早退；骨架保留，开闸后恢复 TASKS 即可。 */
body?.addEventListener("click", (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLElement>(".task-check");
  if (!btn) return;
  const card = btn.closest<HTMLElement>(".task-card");
  const task = ([] as TaskItem[]).find((t) => t.id === card?.dataset.id); // v1 空表（原 TASKS.find）
  if (!card || !task) return;

  // 5.6.2 §3.4：任务完成来源（只正向）。先记旧值 —— true→false（取消勾选）不动好感度、
  // 也不回滚 weekQuests（日志记的是「发生过的事件」，不做事后对账，坑 11）。
  const wasDone = task.done;
  task.done = !task.done;
  card.dataset.done = String(task.done);
  btn.title = task.done ? "取消完成" : "标记完成";
  btn.setAttribute("aria-pressed", String(task.done));
  refreshCounts();

  // delta = 2 固定值；source "tool" 会让主进程顺手 weekQuests += 1。fire-and-forget + catch。
  // 注意（坑 13）：这是两个不同的 patch —— 状态层的 patch 与 window.nahida.relationship.patch（主进程）。
  if (!wasDone && task.done) {
    void window.nahida.relationship
      .patch({ delta: 2, source: "tool", reason: `完成委托：${task.title}` })
      .then((view) => patch({ character: { affection: view } }, "tool"))
      .catch((err) => console.error("[nahida] 好感度写入失败:", err));
  }
});

/** 标签页切换（v1：.tasks__tabs 已从 index.html 移除 → tabs 为空数组，循环不执行；骨架保留） */
for (const tab of tabs) {
  tab.addEventListener("click", () => {
    for (const t of tabs) {
      const active = t === tab;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", String(active));
    }
    for (const panel of document.querySelectorAll<HTMLElement>(".tasks__panel")) {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    }
  });
}

/** 隐藏已完成（v1：开关已从 index.html 移除 → hideSwitch 为 null，?. 短路；骨架保留） */
hideSwitch?.addEventListener("click", () => {
  const on = hideSwitch.dataset.on !== "true";
  hideSwitch.dataset.on = String(on);
  hideSwitch.setAttribute("aria-checked", String(on));
  body?.classList.toggle("tasks--hide-done", on);
});

/** 新增委托：往「每日委托」追加一条备用委托，并同步统计。
 *  v1 占位（5.11）：新增按钮已从 index.html 移除、EXTRA_TASKS 数据已删 —— 空表查找恒 undefined 早退，
 *  监听器骨架保留；开闸后恢复 EXTRA_TASKS 与 TASKS.push 即可。 */
let extraIndex = 0;
addBtn?.addEventListener("click", () => {
  const daily = panelOf("daily");
  if (!daily) return;
  const extra = ([] as Array<{ title: string; desc: string; meta: TaskMeta[] }>)[extraIndex % 1]; // v1 空表（原 EXTRA_TASKS）
  if (!extra) return;
  extraIndex += 1;

  const task: TaskItem = {
    id: `t-extra-${extraIndex}`,
    tab: "daily",
    title: extra.title,
    tags: [{ text: "新委托", tone: "ink" }],
    desc: extra.desc,
    meta: extra.meta,
    done: false,
  };
  // v1（5.11）：TASKS.push(task) 随数据表删除 —— 追加只落 DOM（面板已移除，实际不可达）
  daily.insertAdjacentHTML("beforeend", cardHTML(task));
  refreshCounts();
});

// 视图头标题 + 首次渲染
// v1 占位（5.11）：标题文案已直接写入 index.html#tasks-title（HEAD_TITLE 数据已删，开闸后在此恢复赋值）
const titleEl = document.getElementById("tasks-title");
void titleEl;
renderAll();
