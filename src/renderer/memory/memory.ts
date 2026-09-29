// 回忆视图（5.5.2 重写，原 2.10 记忆视图整体作废，P21）：「对话存档 / 剧情存档」两框的存档中心。
// 结构：文案层 / 渲染层 / 交互层。
// · 列表只吃 chats.list() 轻索引（不读会话全文，3.3 的轻索引设计）；读档那一刻才 chats.get(id)，
//   且那一步在 main.ts 的 loadSession 里 —— 本文件经 chat/session-bridge 调它，两模块互不 import。
// · 删当前会话后由本文件判断回落 openSession(null)；流式中切换由 main.ts 的 settleStream 收尾。

import type { ChatSessionMeta } from "../../shared/chat";
import { openSession, getCurrentSessionId } from "../chat/session-bridge";
import { onViewChange, switchView } from "../sidebar/sidebar";
import { patch } from "../state/app-state";

// ============================================================
// 文案层（本文件唯一允许出现文案字面量的地方）
// ============================================================
const T = {
  /** 视图头副标题：#rec-total / #rec-latest 由 renderHead 分别填数，这里只提供空列表的「最近保存」占位 */
  noLatest: "—",
  countLabel: (n: number): string => `${n} 份`,
  metaLine: (time: string, n: number): string => `${time} · ${n} 条消息`,
  renameTitle: "重命名",
  deleteTitle: "删除",
  confirmDelete: "删除",
  cancelDelete: "取消",
  /** 空 / 纯空白标题被拒（renameSession 返回 null）时的错误态提示，不弹窗 */
  emptyTitle: "标题不能为空",
} as const;

/** 内联 SVG（Lucide 路径，stroke-width 1.6，禁 emoji / 禁 CDN） */
const ICON = {
  rename:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>',
} as const;

// ============================================================
// 渲染层
// ============================================================

const listEl = document.getElementById("rec-list");
const emptyEl = document.getElementById("rec-empty");

const pad = (n: number): string => String(n).padStart(2, "0");

/** 本地时间 MM-DD HH:mm（实时格式化，不写死日期字符串） */
function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function itemHTML(meta: ChatSessionMeta): string {
  const current = meta.id === getCurrentSessionId(); // 高亮「当前正在读的那份」
  return `
    <article class="recall-item" data-id="${meta.id}" data-current="${current}">
      <div class="recall-item__main">
        <p class="recall-item__title">${meta.title}</p>
        <p class="recall-item__meta">${T.metaLine(formatTime(meta.updatedAt), meta.messageCount)}</p>
      </div>
      <div class="recall-item__ops">
        <button type="button" class="recall-item__op" data-op="rename" title="${T.renameTitle}">${ICON.rename}</button>
        <button type="button" class="recall-item__op" data-op="delete" title="${T.deleteTitle}">${ICON.trash}</button>
      </div>
    </article>`;
}

function renderList(metas: ChatSessionMeta[]): void {
  if (!listEl) return;
  listEl.innerHTML = metas.map(itemHTML).join("");
  if (emptyEl) emptyEl.hidden = metas.length > 0;
}

function renderHead(metas: ChatSessionMeta[]): void {
  const set = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set("rec-total", String(metas.length));
  set("rec-latest", metas[0] ? formatTime(metas[0].updatedAt) : T.noLatest);
  set("rec-count", T.countLabel(metas.length));
}

// ============================================================
// 数据与刷新：refreshArchives() 是唯一取数入口
// ============================================================

/** 读盘即真相（索引不缓存）：列表 + 视图头 + 右栏「存档概览」三数一起刷 */
async function refreshArchives(): Promise<void> {
  const metas = await window.nahida.chats.list(); // 已按 updatedAt desc
  renderList(metas);
  renderHead(metas);
  const weekFloor = Date.now() - 7 * 864e5; // 滚动 7×24h，不搞自然周（3.6 口径）
  patch(
    {
      memory: {
        archives: metas.length,
        messages: metas.reduce((sum, m) => sum + m.messageCount, 0),
        weekNew: metas.filter((m) => m.createdAt >= weekFloor).length,
      },
    },
    "system",
  );
}

// ============================================================
// 交互层（事件委托，绑 #rec-list 一次）
// ============================================================

/** 新建对话：清空聊天区（懒创建，不建空壳，第一条消息才落盘），跳回聊天视图 */
document.getElementById("rec-new")?.addEventListener("click", () => {
  openSession(null);
  switchView("chat");
});

/** 就地编辑：标题换成 input；Enter / 失焦提交，Esc 取消（cancelled 标志防 Esc+blur 双触发） */
function startRename(item: HTMLElement, id: string): void {
  const titleEl = item.querySelector<HTMLElement>(".recall-item__title");
  if (!titleEl || item.querySelector(".recall-item__input")) return; // 已在编辑态
  const old = titleEl.textContent ?? "";
  const input = document.createElement("input");
  input.className = "recall-item__input";
  input.maxLength = 30; // 与主进程 renameSession 的 30 字上限一致
  input.value = old;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  let cancelled = false;
  const finish = (commit: boolean): void => {
    input.removeEventListener("keydown", onKey);
    input.removeEventListener("blur", onBlur);
    const value = input.value;
    input.replaceWith(titleEl); // 无论成败先还原 DOM；失败再加错误态
    if (!commit || cancelled) return;
    void submitRename(id, value, titleEl);
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      finish(true);
    } else if (ev.key === "Escape") {
      cancelled = true; // Esc 后随即而来的 blur 不得再提交
      finish(false);
    }
  };
  const onBlur = (): void => finish(true);
  input.addEventListener("keydown", onKey);
  input.addEventListener("blur", onBlur);
}

/** 提交改名：走 chats.rename（只改 DOM 不落盘，重启就没）；null = 空标题 → 还原 + 错误态，不弹窗 */
async function submitRename(id: string, value: string, titleEl: HTMLElement): Promise<void> {
  const session = await window.nahida.chats.rename(id, value);
  if (!session) {
    titleEl.classList.add("recall-item__title--error");
    titleEl.title = T.emptyTitle;
    setTimeout(() => {
      titleEl.classList.remove("recall-item__title--error");
      titleEl.title = "";
    }, 1600);
    return;
  }
  await refreshArchives();
}

/** 就地二次确认：ops 区换成「删除 / 取消」，不弹原生 confirm */
function startDeleteConfirm(item: HTMLElement): void {
  const ops = item.querySelector<HTMLElement>(".recall-item__ops");
  if (!ops || ops.querySelector("[data-op='confirm-delete']")) return; // 已在确认态
  ops.innerHTML = `
    <button type="button" class="recall-item__op recall-item__op--danger" data-op="confirm-delete">${T.confirmDelete}</button>
    <button type="button" class="recall-item__op" data-op="cancel-delete">${T.cancelDelete}</button>`;
}

async function confirmDelete(id: string): Promise<void> {
  await window.nahida.chats.delete(id);
  // 删的是当前会话 → 聊天区回落空状态（磁盘删完聊天区还留着旧气泡会串）
  if (id === getCurrentSessionId()) openSession(null);
  await refreshArchives();
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
    if (op === "rename") startRename(item, id);
    else if (op === "delete") startDeleteConfirm(item);
    else if (op === "confirm-delete") void confirmDelete(id);
    else if (op === "cancel-delete") void refreshArchives(); // 取消 = 重渲染还原 ops 区
    return;
  }
  if (target.closest(".recall-item__ops")) return; // ops 区空白处不读档
  // 点行本身 → 读档 + 跳聊天视图
  openSession(id);
  switchView("chat");
});

// ---------- 刷新链路：三处调用 ----------
// ① 模块顶层一次：首屏就把右栏「存档概览」喂上真值（聊天视图快捷入口不长期显示 0）
void refreshArchives();
// ② 每次进视图都刷新（别信缓存）
onViewChange((name) => {
  if (name === "memory") void refreshArchives();
});
// ③ 增 / 删 / 改名之后：上面各动作末尾各自调一次
