// 8.7.19：RSS 阅读器（工具箱 · 自研工具）渲染面板。
// DOM 全部 innerHTML 自建（并行隔离，不改 index.html / tool-window.ts）；数据全走 window.nahida.rss.*。
import type { RssFeed, RssItem } from "../../../shared/rss";

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]!);

export function initRssPanel(): void {
  const box = document.getElementById("panel-rss");
  if (!box) return;
  box.innerHTML = `
    <div class="tool-tool__vbox">
      <div class="tool-tool__bar">
        <input id="rss-url" class="tool-tool__input" placeholder="粘贴订阅源网址（http/https）" spellcheck="false" />
        <button type="button" class="btn-soft" id="rss-add">订阅</button>
      </div>
      <p id="rss-status" class="tool-tool__status">加载订阅…</p>
      <div class="rss_body">
        <div id="rss-feeds" class="rss_feeds"></div>
        <div id="rss-items" class="rss_items"><p class="tool-tool__status">点左侧订阅源查看最新文章</p></div>
      </div>
    </div>`;

  const urlEl = document.getElementById("rss-url") as HTMLInputElement | null;
  const status = document.getElementById("rss-status");
  const feedsBox = document.getElementById("rss-feeds");
  const itemsBox = document.getElementById("rss-items");
  const addBtn = document.getElementById("rss-add");
  if (!status || !feedsBox || !itemsBox || !addBtn) return;
  let feeds: RssFeed[] = [];
  let activeId = "";

  // 箭头常量（非提升函数声明）：让上方 null 守卫的收窄对 feedsBox/status/itemsBox 生效
  const renderFeeds = (): void => {
    feedsBox.innerHTML = feeds.length ? feeds.map((f) => `
      <div class="rss_feed${f.id === activeId ? " is-active" : ""}" data-id="${f.id}">
        <span class="rss_feed__title" title="点击查看">${esc(f.title)}</span>
        <button type="button" class="rss_feed__del" data-del="${f.id}" title="取消订阅">✕</button>
      </div>`).join("")
      : `<p class="tool-tool__status">还没有订阅，先在上方添加一个网址</p>`;
    feedsBox.querySelectorAll<HTMLElement>(".rss_feed__title").forEach((el) => {
      el.addEventListener("click", () => { activeId = el.closest<HTMLElement>(".rss_feed")?.dataset.id ?? ""; renderFeeds(); void loadItems(); });
    });
    feedsBox.querySelectorAll<HTMLButtonElement>(".rss_feed__del").forEach((btn) => {
      btn.addEventListener("click", () => {
        void window.nahida.rss.remove(btn.dataset.del ?? "").then((list) => { feeds = list; if (activeId === btn.dataset.del) { activeId = ""; itemsBox.innerHTML = ""; } renderFeeds(); });
      });
    });
  }

  const loadItems = async (): Promise<void> => {
    const feed = feeds.find((f) => f.id === activeId);
    if (!feed) { itemsBox.innerHTML = `<p class="tool-tool__status">未选中订阅源</p>`; return; }
    status.textContent = `正在拉取 ${feed.title}…`;
    const r = await window.nahida.rss.fetch(activeId);
    if (!r.ok) { status.textContent = `拉取失败：${r.error}`; itemsBox.innerHTML = ""; return; }
    status.textContent = `${feed.title} · ${r.items.length} 篇`;
    itemsBox.innerHTML = r.items.length ? r.items.map((it: RssItem) => `
      <a class="rss_article" href="${esc(it.link)}" target="_blank" rel="noopener">
        <span class="rss_article__title">${esc(it.title)}</span>
        <span class="rss_article__meta">${it.pubDate ? new Date(it.pubDate).toLocaleString("zh-CN", { hour12: false }) : ""}</span>
        ${it.summary ? `<span class="rss_article__sum">${esc(it.summary)}</span>` : ""}
      </a>`).join("") : `<p class="tool-tool__status">该订阅当前没有文章</p>`;
  }

  addBtn.addEventListener("click", () => {
    const u = urlEl?.value.trim() ?? "";
    if (!u) { status.textContent = "请先粘贴订阅源网址"; return; }
    void window.nahida.rss.add(u).then((r) => {
      feeds = r.feeds; urlEl!.value = ""; renderFeeds();
      status.textContent = r.ok ? `订阅成功，共 ${r.feeds.length} 个` : `订阅失败：${r.error}`;
    });
  });

  void window.nahida.rss.list().then((list) => { feeds = list; renderFeeds(); });
}
