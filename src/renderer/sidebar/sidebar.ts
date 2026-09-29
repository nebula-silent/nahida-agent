// nahida 侧边栏导航：单页视图切换（v2 玻璃拟态，激活类名按规范 §5.2 用 .active）
// 参考自 Cyrene-Agent src/renderer/sidebar/sidebar.ts
// 差异：Cyrene 是 iframe/多窗口跳转，nahida 为单页多 div 切换；导航按钮与 .view section 用 data-view 关联
// 3.8：底部卡从「按视图写死的映射表」改为运行状态卡（模型名 + 共鸣状态），品牌卡状态胶囊同步接状态层；
//      文案全部来自 state/labels.ts（唯一文案出处），本文件零文案字面量

import { getState, subscribe } from "../state/app-state";
import { brandStatusText, modelNameText, resonanceText } from "../state/labels";

const NAV_SELECTOR = ".sidebar__nav .menu-item[data-view]";

export function initSidebar(): void {
  const navItems = Array.from(document.querySelectorAll<HTMLButtonElement>(NAV_SELECTOR));
  const footerEl = document.querySelector<HTMLElement>(".sidebar__footer");
  const footerText = document.querySelector<HTMLElement>(".sidebar__footer-text");
  const footerSub = document.querySelector<HTMLElement>(".sidebar__footer-sub");
  const brandStatusEl = document.querySelector<HTMLElement>(".brand__status");
  const brandStatusTextEl = document.querySelector<HTMLElement>(".brand__status-text");
  const brandDotEl = document.querySelector<HTMLElement>(".brand__dot");
  const activeNav = (name: string) => {
    navItems.forEach((item) => {
      item.classList.toggle("active", item.dataset.view === name);
      item.setAttribute("aria-current", item === navItems.find((n) => n.dataset.view === name) ? "page" : "false");
    });
  };

  // ---- 状态层渲染（3.8）：幂等，可被任意次调用 ----
  const renderState = (): void => {
    const { model, character } = getState();
    // 品牌卡
    if (brandStatusEl) brandStatusEl.dataset.state = model.status;
    if (brandStatusTextEl) brandStatusTextEl.textContent = brandStatusText(model, character);
    if (brandDotEl) brandDotEl.dataset.state = model.status;
    // 底部运行状态卡
    if (footerEl) footerEl.dataset.state = model.status;
    if (footerText) footerText.textContent = modelNameText(model.name);
    if (footerSub) footerSub.textContent = resonanceText(model.status);
  };

  renderState();            // 首屏（此刻 status=unknown → 待机）
  subscribe(renderState);   // 之后每次 patch 都回调；返回值不用存，侧边栏与窗口同生命周期

  switchView = (name) => {
    document.querySelectorAll<HTMLElement>("#container .view").forEach((sec) => {
      const isTarget = sec.dataset.view === name;
      sec.classList.toggle("view--hidden", !isTarget);
    });
    activeNav(name);
    // 统一在此通知所有订阅者（顶部栏 / 右栏面板 / 后续模块），避免每个调用点各写一遍
    for (const fn of viewListeners) fn(name);
  };

  navItems.forEach((item) => {
    item.addEventListener("click", () => {
      const name = item.dataset.view;
      if (!name) return;
      switchView(name); // 通知由 switchView 统一发出
    });
  });

  // 默认激活第一个导航对应的视图
  const first = navItems[0];
  if (first?.dataset.view) switchView(first.dataset.view);
}

/** 全局切换函数（由 initSidebar 赋值），供其它模块调用 */
export let switchView: (name: string) => void = () => {};

// 视图切换监听（多订阅者）：2.5c 顶部栏 / 2.8 右栏面板共用；后续视图驱动逻辑也走这里
const viewListeners: Array<(name: string) => void> = [];

/** 注册视图切换监听（每次 switchView 都会回调一次，含初始化那次） */
export function onViewChange(callback: (name: string) => void): void {
  viewListeners.push(callback);
}