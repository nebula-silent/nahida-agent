// 2.7：工作台标签页切换 + 副标题联动
// 2026-09-26 用户决定：游戏自侧边栏并入工作台，「游戏」标签恢复（排第一，照 studio.html 原型顺序）；
// 2026-09-27 用户决定：该标签与面板文案去掉「花园」
// 2026-09-29（8.7.4）：侧边栏项更名「工作台」；「工具箱」标签改为 MCP/插件 目录骨架
// 2026-09-29 用户决定：游戏标签暂缓（暂不做），移出工作台（index.html 已注释，恢复时解开并还原 hints）
// 副标题文案照抄 studio.html 的 hints 对象
const HINT_BY_TAB: Record<string, string> = {
  // games: "把玩一会儿，或者记录此刻的画面。", // 随游戏标签一并暂缓
  tools: "MCP 扩展与常用插件，全部在本地运行。",
  capture: "截图会按日期归档到影像库。",
  record: "录屏支持硬件加速，随时可以停下来。",
  live: "开播前先测试推流，避免中途断开。",
};

const tabs = document.querySelectorAll<HTMLButtonElement>(".studio__tabs .tab-btn");
const panels = document.querySelectorAll<HTMLElement>(".studio__panel");
const hintEl = document.getElementById("studio-hint");

for (const tab of tabs) {
  tab.addEventListener("click", () => {
    for (const t of tabs) {
      const active = t === tab;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", String(active));
    }
    for (const panel of panels) {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    }
    if (hintEl) {
      hintEl.textContent = HINT_BY_TAB[tab.dataset.tab ?? ""] ?? HINT_BY_TAB.tools;
    }
  });
}

// 8.7.4：工具箱面板内部 MCP/插件 子切换（独立类，与外层 .studio__tabs 互不干扰）
const subtabs = document.querySelectorAll<HTMLButtonElement>(".tools-subtabs .tools-subtab");
const subsections = document.querySelectorAll<HTMLElement>(".tools-section");
for (const sub of subtabs) {
  sub.addEventListener("click", () => {
    for (const s of subtabs) {
      const active = s === sub;
      s.classList.toggle("active", active);
      s.setAttribute("aria-selected", String(active));
    }
    for (const sec of subsections) {
      sec.hidden = sec.dataset.subsection !== sub.dataset.subtab;
    }
  });
}
