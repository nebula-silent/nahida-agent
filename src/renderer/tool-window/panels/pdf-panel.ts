// 8.7.18：PDF 合并/拆分（工具箱 · 自研工具）渲染面板
// 隔离规则：DOM 全部 innerHTML 自建到 #panel-pdf-tool（不改 index.html / tool-window.ts / tool-window.css）；
// 数据全走 window.nahida.pdfTool.*（merge/split），文件选择/保存由主进程 dialog 处理，渲染层不传路径；
// 样式只写 ./pdf-panel.css（新增类名限 .pdf_ 前缀，复用 .tool-tool / .btn-soft / .lbl-inline 全局类）。
export function initPdfPanel(): void {
  const box = document.getElementById("panel-pdf-tool");
  if (!box) return;
  box.innerHTML = `
    <div class="tool-tool__vbox">
      <div class="pdf_tabs">
        <button type="button" class="pdf_tab is-active" data-mode="merge">合并多个 PDF</button>
        <button type="button" class="pdf_tab" data-mode="split">按页面拆分</button>
      </div>
      <div class="pdf_merge">
        <p class="pdf_desc">点击按钮后按顺序选择多个 PDF，会合成为一个文件。</p>
        <button type="button" class="btn-soft" id="pdf-merge-btn">选择并合并…</button>
      </div>
      <div class="pdf_split" hidden>
        <p class="pdf_desc">选择 1 个 PDF，在下方填要保留的页，会把这几页导出为一个新文件。</p>
        <label class="lbl-inline">保留页
          <input id="pdf-spec" class="tool-tool__input" placeholder="如 1-3,5" spellcheck="false" />
        </label>
        <button type="button" class="btn-soft" id="pdf-split-btn">按范围拆分…</button>
      </div>
      <p id="pdf-status" class="tool-tool__status">合并或拆分都在本机完成，文件不会上传</p>
    </div>`;

  const tabs = box.querySelectorAll<HTMLButtonElement>(".pdf_tab");
  const mergeBox = box.querySelector<HTMLElement>(".pdf_merge");
  const splitBox = box.querySelector<HTMLElement>(".pdf_split");
  const spec = document.getElementById("pdf-spec") as HTMLInputElement | null;
  const status = document.getElementById("pdf-status");
  const mergeBtn = document.getElementById("pdf-merge-btn") as HTMLButtonElement | null;
  const splitBtn = document.getElementById("pdf-split-btn") as HTMLButtonElement | null;
  if (!mergeBox || !splitBox || !status || !mergeBtn || !splitBtn) return;
  const setStatus = (s: string): void => { status.textContent = s; };

  tabs.forEach((tb) => tb.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.toggle("is-active", t === tb));
    const isSplit = tb.dataset.mode === "split";
    mergeBox.hidden = isSplit;
    splitBox.hidden = !isSplit;
  }));

  mergeBtn.addEventListener("click", () => {
    setStatus("正在选择文件…");
    mergeBtn.disabled = true;
    void window.nahida.pdfTool.merge().then((r) => {
      mergeBtn.disabled = false;
      if (r.canceled) setStatus("已取消");
      else if (r.ok) setStatus(`已合并，共 ${r.pageCount} 页 → ${r.outPath}`);
      else setStatus(`合并失败：${r.error}`);
    });
  });
  splitBtn.addEventListener("click", () => {
    const s = spec?.value.trim() ?? "";
    if (!s) { setStatus("请先填写要保留的页范围"); return; }
    setStatus("正在处理…");
    splitBtn.disabled = true;
    void window.nahida.pdfTool.split({ spec: s }).then((r) => {
      splitBtn.disabled = false;
      if (r.canceled) setStatus("已取消");
      else if (r.ok) setStatus(`已导出 ${r.pageCount} 页 → ${r.outPath}`);
      else setStatus(`拆分失败：${r.error}`);
    });
  });
}
