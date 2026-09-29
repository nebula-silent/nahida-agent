// 8.7.17：剪切板历史渲染面板。DOM 全部 innerHTML 自建（并行隔离，别改 index.html / tool-window.ts）
import type { ClipRecord } from "../../../shared/clip";

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" })[c]!);

export function initClipboardPanel(): void {
  const box = document.getElementById("panel-clipboard");
  if (!box) return;
  box.innerHTML = `
    <div class="tool-tool__vbox">
      <div class="tool-tool__bar">
        <input id="clip-search" class="tool-tool__input" placeholder="搜索剪贴板历史…" spellcheck="false" />
        <span class="tool-tool__spacer"></span>
        <button type="button" class="btn-soft" id="clip-clear">清空历史</button>
      </div>
      <p id="clip-status" class="tool-tool__status">加载中…</p>
      <div id="clip-list" class="clip_list no-sb"></div>
    </div>`;

  const search = document.getElementById("clip-search") as HTMLInputElement | null;
  const listBox = document.getElementById("clip-list");
  const status = document.getElementById("clip-status");
  const clearBtn = document.getElementById("clip-clear");
  if (!listBox || !status || !clearBtn || !search) return;
  let records: ClipRecord[] = [];
  let kw = "";

  const render = (): void => {
    const shown = kw ? records.filter((r) => r.text.toLowerCase().includes(kw.toLowerCase())) : records;
    if (!shown.length) { listBox.innerHTML = `<p class="tool-tool__status">${kw ? "没有匹配" : "暂无历史，复制任意文字试试"}</p>`; return; }
    listBox.innerHTML = shown.map((r) => `
      <div class="clip_item${r.pinned ? " clip_item--pin" : ""}" data-id="${r.id}">
        <span class="clip_item__text" title="点击复制">${esc(r.text)}</span>
        <span class="clip_item__meta">${r.pinned ? "已置顶" : new Date(r.at).toLocaleTimeString("zh-CN", { hour12: false })}</span>
        <button type="button" class="btn-soft clip_item__pin" data-pin="${r.pinned ? 0 : 1}">${r.pinned ? "取消置顶" : "置顶"}</button>
      </div>`).join("");

    listBox.querySelectorAll<HTMLButtonElement>(".clip_item__pin").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = btn.closest<HTMLElement>(".clip_item");
        const id = item?.dataset.id ?? "";
        void window.nahida.clip.pin({ id, pinned: btn.dataset.pin === "1" }).then((res) => { records = res.records; render(); });
      });
    });
    listBox.querySelectorAll<HTMLElement>(".clip_item__text").forEach((el) => {
      el.addEventListener("click", () => { if (el.textContent) window.nahida.clip.copy(el.textContent); });
    });
  };

  void window.nahida.clip.list().then((list) => { records = list; status.textContent = `共 ${list.length} 条（点文字复制，置顶项永不被清空）`; render(); });
  search.addEventListener("input", () => { kw = search.value.trim(); render(); });
  clearBtn.addEventListener("click", () => {
    void window.nahida.clip.clear().then((res) => { records = res.records; status.textContent = "已清空非置顶历史"; render(); });
  });
}
