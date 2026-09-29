// 历史对话搜索面板 —— 聊天输入区「搜索」按钮弹出的模态（归位总表：聊天视图内工具）。
// 手法照 tool-panel.ts：面板动态挂 body、Esc / 点遮罩关闭、display 开合不销毁节点。
// 搜索走主进程 chats:search（跨会话全文匹配 content，含 [表情] 直发文本）；点结果 openSession 跳会话。
// 图片/文件等非文本附件当前不在消息树里（消息只有 content 字符串），将来入库后主进程扩展匹配即可，本面板 UI 不用动。
import type { ChatSearchHit, ChatSearchResult } from "../../shared/chat";
import { openSession } from "./session-bridge";

const OVERLAY_ID = "search-panel";
const DEBOUNCE_MS = 300;

export interface SearchPanel {
  /** 主动收起（切视图等场景用） */
  close(): void;
}

/** 时间戳 → 「MM-DD HH:mm」（今年之外的补年份），无外部依赖 */
function fmtTime(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/** 同 settings.ts / tool-panel.ts 的 esc 口径 */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch));
}

/** snippet 高亮：先按偏移拆原文三段再各自转义（转义会改变偏移，顺序不能反） */
function highlight(hit: ChatSearchHit): string {
  const { snippet, matchStart, matchLength } = hit;
  const head = esc(snippet.slice(0, matchStart));
  const core = esc(snippet.slice(matchStart, matchStart + matchLength));
  const tail = esc(snippet.slice(matchStart + matchLength));
  return `${head}<mark>${core}</mark>${tail}`;
}

function hitHtml(hit: ChatSearchHit, q: string): string {
  const who = hit.role === "user" ? "你" : "她";
  return `
    <button type="button" class="search-panel__hit" data-session-id="${esc(hit.sessionId)}" data-q="${esc(q)}">
      <span class="search-panel__hit-head">
        <span class="search-panel__hit-title">${esc(hit.sessionTitle)}</span>
        <span class="search-panel__hit-role" data-role="${esc(hit.role)}">${who}</span>
        <span class="search-panel__hit-time">${esc(fmtTime(hit.at))}</span>
      </span>
      <span class="search-panel__hit-snippet">${highlight(hit)}</span>
    </button>`;
}

export function initSearchPanel(trigger: HTMLElement): SearchPanel {
  let overlay: HTMLDivElement | null = null;
  let inputEl: HTMLInputElement | null = null;
  let bodyEl: HTMLElement | null = null;
  let open = false;
  let lastQuery = ""; // 同词重复触发（防抖尾随 vs Enter）不打重复 IPC
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function renderResult(r: ChatSearchResult, q: string): void {
    if (!bodyEl) return;
    if (r.hits.length === 0) {
      bodyEl.innerHTML = `<p class="search-panel__empty">没有找到含「${esc(q)}」的对话</p>`;
      return;
    }
    const note = r.truncated ? `<p class="search-panel__note">结果较多，已显示前 ${r.hits.length} 条 · 换个更具体的关键词可收窄</p>` : "";
    bodyEl.innerHTML = `${note}${r.hits.map((h) => hitHtml(h, q)).join("")}`;
  }

  function renderError(message: string): void {
    if (!bodyEl) return;
    bodyEl.innerHTML = `<p class="search-panel__empty">搜索失败：${esc(message)}</p>`;
  }

  function runSearch(q: string): void {
    const query = q.trim();
    if (!bodyEl) return;
    if (!query) {
      bodyEl.innerHTML = `<p class="search-panel__empty">输入关键词，搜所有对话里的文字和表情</p>`;
      return;
    }
    lastQuery = query;
    void (async () => {
      try {
        const r = await window.nahida.chats.search(query);
        if (lastQuery === query) renderResult(r, query); // 乱序回包守卫：只认最新一次
      } catch (err) {
        if (lastQuery === query) renderError(err instanceof Error ? err.message : String(err));
      }
    })();
  }

  function ensureOverlay(): void {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "tool-panel__overlay"; // 复用工具授权面板的遮罩定位（z-index 1000）
    const card = document.createElement("div");
    card.className = "search-panel glass";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "搜索历史对话");
    card.innerHTML = `
      <header class="tool-panel__head">
        <span class="tool-panel__title">搜索历史对话</span>
        <button type="button" class="icon-btn icon-btn--round search-panel__close" title="关闭" aria-label="关闭">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </header>
      <div class="search-panel__inputrow">
        <input type="text" class="search-panel__input" placeholder="搜文字、[表情]…" autocomplete="off" />
      </div>
      <div class="search-panel__body"><p class="search-panel__empty">输入关键词，搜所有对话里的文字和表情</p></div>`;
    overlay.append(card);
    document.body.append(overlay);

    inputEl = card.querySelector<HTMLInputElement>(".search-panel__input");
    bodyEl = card.querySelector<HTMLElement>(".search-panel__body");

    inputEl?.addEventListener("input", () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => runSearch(inputEl?.value ?? ""), DEBOUNCE_MS);
    });
    inputEl?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (debounceTimer) clearTimeout(debounceTimer);
        runSearch(inputEl?.value ?? "");
      }
    });

    card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".search-panel__close")) { close(); return; }
      const hit = target.closest<HTMLElement>("[data-session-id]");
      if (!hit) return;
      close();
      openSession(hit.dataset.sessionId ?? ""); // 读档跳转（session-bridge 与回忆视图同一条路）
    });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  }

  function openPanel(): void {
    if (open) return;
    open = true;
    trigger.setAttribute("aria-expanded", "true");
    ensureOverlay();
    overlay!.style.display = "flex";
    inputEl?.focus();
  }

  function close(): void {
    if (!open) return;
    open = false;
    if (debounceTimer) clearTimeout(debounceTimer);
    trigger.setAttribute("aria-expanded", "false");
    if (overlay) overlay.style.display = "none";
  }

  trigger.addEventListener("click", () => { open ? close() : openPanel(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  return { close };
}
