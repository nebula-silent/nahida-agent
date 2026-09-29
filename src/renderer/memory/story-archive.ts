// 5.7.4：回忆视图「剧情存档」框（P20）。与 memory.ts 的「对话存档」逻辑独立 ——
// 读 story store（listSaves / listChapters / deleteSave），不共用对话索引。
// 「回到节点重走」= chats.setActive(sessionId, nodeId) + openSession(sessionId)（session-bridge）
//   → main.ts 的 loadSession 重新 chats.get 并按 activeLeafId 渲染可见路径。
// ⚠️ 渲染层只碰**桥** `chats.setActive`（global.d.ts）；主进程那个函数叫 `setActiveNode`（chats-store.ts）。
//   别 import 主进程、别把两个名字搞混。
// 安全铁律：章节标题 / nodeId 不可信，动态文案一律 textContent（DOM API 构造，不拼 HTML 字符串）。

import type { StorySave } from "../../shared/story";
import { openSession } from "../chat/session-bridge";
import { FEATURE_FLAGS } from "../state/feature-flags";
import { onViewChange, switchView } from "../sidebar/sidebar";

// ============================================================
// 文案层（本文件唯一允许出现文案字面量的地方）
// ============================================================
const T = {
  countLabel: (n: number): string => `${n} 份`,
  metaLine: (time: string, nodeId: string): string => `${time} · 节点 ${nodeId}`,
  unknownChapter: "未知章节", // 章节被删 / 未导入，但存档保留（5.7.2 §3.1 第 7 条）
  stale: "存档已失效", // 会话已删
  deleteTitle: "删除",
  confirmDelete: "删除",
  cancelDelete: "取消",
} as const;

/** 内联 SVG（Lucide 路径，stroke-width 1.6，禁 emoji / 禁 CDN）—— 与 memory.ts 各留一份小副本（文案层每文件一份） */
const ICON = {
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>',
} as const;

// ============================================================
// 渲染层
// ============================================================

const listEl = document.getElementById("story-list");
const emptyEl = document.getElementById("story-empty");
const countEl = document.getElementById("story-count");

/** 最近一次列表数据（点行重走要完整 save，不只 id）—— 只缓存本框自己的读数，不是会话状态 */
let savesCache: StorySave[] = [];

const pad = (n: number): string => String(n).padStart(2, "0");

/** 本地时间 MM-DD HH:mm（实时格式化，不写死日期字符串） */
function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 一行的 DOM（章节标题 / nodeId 不可信 → 全程 DOM API + textContent） */
function buildItem(save: StorySave, titleOf: Map<string, string>): HTMLElement {
  const item = document.createElement("article");
  item.className = "recall-item";
  item.dataset.id = save.id;
  item.dataset.stale = "false";

  const main = document.createElement("div");
  main.className = "recall-item__main";
  const title = document.createElement("p");
  title.className = "recall-item__title";
  title.title = save.nodeId;
  title.textContent = titleOf.get(save.chapterId) ?? T.unknownChapter;
  const meta = document.createElement("p");
  meta.className = "recall-item__meta";
  meta.textContent = T.metaLine(formatTime(save.at), save.nodeId);
  main.append(title, meta);

  const ops = document.createElement("div");
  ops.className = "recall-item__ops";
  const del = document.createElement("button");
  del.type = "button";
  del.className = "recall-item__op";
  del.dataset.op = "delete";
  del.title = T.deleteTitle;
  del.innerHTML = ICON.trash; // 静态 SVG 常量、无插值（本文件唯一一处）
  ops.append(del);

  item.append(main, ops);
  return item;
}

function renderList(saves: StorySave[], titleOf: Map<string, string>): void {
  savesCache = saves;
  if (listEl) listEl.replaceChildren(...saves.map((s) => buildItem(s, titleOf)));
  if (emptyEl) emptyEl.hidden = saves.length > 0;
}

function renderHead(saves: StorySave[]): void {
  if (countEl) countEl.textContent = T.countLabel(saves.length);
}

// ============================================================
// 数据与刷新：refreshStorySaves() 是唯一取数入口
// ============================================================

/** 独立于左框的取数：读剧情三表里的存档表 + 章节表（标题映射），失败保持空列表、不崩 */
async function refreshStorySaves(): Promise<void> {
  if (!FEATURE_FLAGS.story) {
    // v1 占位（5.11）：剧情关闭，不拉真实数据 —— 空列表 + 占位空态（文案已静态写入 index.html#story-empty）。
    // renderList([], …) 会摘掉 #story-empty 的 hidden，开闸后此分支自然失效、恢复真实取数。
    renderList([], new Map());
    renderHead([]);
    return;
  }
  try {
    const [saves, chapters] = await Promise.all([
      window.nahida.story.listSaves(), // 已按 at 降序
      window.nahida.story.listChapters(), // 按 order 升序
    ]);
    const titleOf = new Map(chapters.map((c) => [c.id, c.title]));
    renderList(saves, titleOf);
    renderHead(saves);
  } catch (err) {
    console.warn("[nahida] 读剧情存档失败:", err instanceof Error ? err.message : String(err));
  }
}

// ============================================================
// 交互层（事件委托，绑 #story-list 一次）
// ============================================================

/** 失效标记：会话已删 → 仍显示（仍可删），但不可重走 */
function markStale(item: HTMLElement): void {
  item.dataset.stale = "true";
  const titleEl = item.querySelector<HTMLElement>(".recall-item__title");
  if (titleEl) titleEl.textContent = T.stale;
}

/** 回到节点重走：先 setActive 落盘、再 openSession 重读（顺序不能反），最后切聊天视图 */
async function replay(item: HTMLElement, save: StorySave): Promise<void> {
  try {
    const ref = save.messageTreeRef;
    const updated = await window.nahida.chats.setActive(ref.sessionId, ref.nodeId);
    if (!updated) {
      // setActive 返回 null = 会话没了 或 节点不在表里（两者不区分）：再查一次会话
      const session = await window.nahida.chats.get(ref.sessionId);
      if (!session) {
        markStale(item); // 会话已删 → 标失效 + 不跳转
        return;
      }
      // 会话在、节点没了 → 不额外处理：openSession 会按该会话当前 activeLeafId 渲染（容错回落）
    }
    openSession(ref.sessionId); // main.ts 的 loadSession 重新 chats.get + renderHistory
    switchView("chat");
  } catch (err) {
    console.warn("[nahida] 剧情存档重走失败:", err instanceof Error ? err.message : String(err));
  }
}

/** 就地二次确认：ops 区换成「删除 / 取消」，不弹原生 confirm（同 memory.ts:166 手法，全程 DOM API、不用定时器） */
function startDeleteConfirm(item: HTMLElement): void {
  const ops = item.querySelector<HTMLElement>(".recall-item__ops");
  if (!ops || ops.querySelector("[data-op='confirm-delete']")) return; // 已在确认态
  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "recall-item__op recall-item__op--danger";
  confirmBtn.dataset.op = "confirm-delete";
  confirmBtn.textContent = T.confirmDelete;
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "recall-item__op";
  cancelBtn.dataset.op = "cancel-delete";
  cancelBtn.textContent = T.cancelDelete;
  ops.replaceChildren(confirmBtn, cancelBtn);
}

/** 删存档 = 只删存档（不连带删会话 / 消息节点 / 分支） */
async function confirmDelete(id: string): Promise<void> {
  try {
    await window.nahida.story.deleteSave(id);
  } catch (err) {
    console.warn("[nahida] 删剧情存档失败:", err instanceof Error ? err.message : String(err));
  }
  await refreshStorySaves();
}

listEl?.addEventListener("click", (ev) => {
  const target = ev.target as HTMLElement;
  const item = target.closest<HTMLElement>(".recall-item");
  if (!item) return;
  const id = item.dataset.id;
  if (!id) return;

  const opBtn = target.closest<HTMLElement>("[data-op]");
  if (opBtn) {
    const op = opBtn.dataset.op;
    if (op === "delete") startDeleteConfirm(item);
    else if (op === "confirm-delete") void confirmDelete(id);
    else if (op === "cancel-delete") void refreshStorySaves(); // 取消 = 重渲染还原 ops 区
    return;
  }
  if (target.closest(".recall-item__ops")) return; // ops 区空白处不重走
  if (item.dataset.stale === "true") return; // 失效档不跳转
  const save = savesCache.find((s) => s.id === id);
  if (!save) return;
  void replay(item, save); // 点行本身 → 回到节点重走 + 跳聊天视图
});

// ---------- 刷新链路：三处调用 ----------
// ① 模块顶层一次：首屏就把右框喂上真值
void refreshStorySaves();
// ② 每次进视图都刷新（别信缓存）
onViewChange((name) => {
  if (name === "memory") void refreshStorySaves();
});
// ③ 删之后：confirmDelete 末尾自己调一次