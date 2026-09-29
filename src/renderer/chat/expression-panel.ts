// 7.7：表情面板（微信式）—— 点输入区「表情」按钮弹出 10 格，点一格直接把 [词] 交回调用方直发。
// 手法照 model-dropdown.ts：面板动态挂 body（避开采裁剪）、open 时现算 fixed 坐标、点外 / Esc / 窗口变化关闭。
// 标签清单读 shared/expression.ts（唯一真相，与主进程 system 声明同一份）。
import { EXPRESSIONS, expressionText } from "../../shared/expression";

const PANEL_ID = "expression-panel";

/**
 * 10 张表情图地址：Vite 在 dev/build 两态都把 `new URL(字面量, import.meta.url)` 静态替换成资源地址。
 * 键必须与 shared/expression.ts 的 EXPRESSIONS.key 一一对应（下方 initExpressionPanel 会校验缺失并跳过）。
 * 导出：气泡渲染（chat/message-tree.ts）把正文里的 [词] 换成同一批 PNG，地址只有这一份。
 */
export const EXPRESSION_IMAGE_URLS: Record<string, string> = {
  sleepy: new URL("../assets/expressions/sleepy.png", import.meta.url).href,
  hug: new URL("../assets/expressions/hug.png", import.meta.url).href,
  serious: new URL("../assets/expressions/serious.png", import.meta.url).href,
  love: new URL("../assets/expressions/love.png", import.meta.url).href,
  cute: new URL("../assets/expressions/cute.png", import.meta.url).href,
  confused: new URL("../assets/expressions/confused.png", import.meta.url).href,
  grin: new URL("../assets/expressions/grin.png", import.meta.url).href,
  cozy: new URL("../assets/expressions/cozy.png", import.meta.url).href,
  wow: new URL("../assets/expressions/wow.png", import.meta.url).href,
  please: new URL("../assets/expressions/please.png", import.meta.url).href,
};

export interface ExpressionPanel {
  /** 主动收起（切换会话等场景用） */
  close(): void;
}

export function initExpressionPanel(trigger: HTMLElement, onPick: (text: string) => void): ExpressionPanel {
  let panel: HTMLDivElement | null = null;
  let open = false;

  function ensurePanel(): HTMLDivElement {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "expression-panel";
    panel.setAttribute("role", "menu");
    panel.setAttribute("aria-label", "表情");
    panel.addEventListener("click", (e) => e.stopPropagation()); // 点面板内部不冒泡到 document 的关闭逻辑
    for (const item of EXPRESSIONS) {
      const url = EXPRESSION_IMAGE_URLS[item.key];
      if (!url) continue; // 清单加了新表情但没配图 → 跳过（不画空格）
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "expression-panel__item";
      cell.setAttribute("role", "menuitem");
      cell.title = `${item.label} · ${item.meaning}`;
      cell.setAttribute("aria-label", cell.title);
      const img = document.createElement("img");
      img.className = "expression-panel__img";
      img.src = url;
      img.alt = item.label;
      img.draggable = false;
      cell.append(img);
      cell.addEventListener("click", () => onPick(expressionText(item)));
      panel.append(cell);
    }
    document.body.append(panel);
    return panel;
  }

  /** 面板开在按钮**上方**、右缘对齐按钮右缘（输入区在窗口底部，往下开会被裁掉） */
  function place(): void {
    if (!panel) return;
    const rect = trigger.getBoundingClientRect();
    panel.style.visibility = "hidden";
    panel.style.display = "grid";
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    // 上方空间不够就翻到按钮下方（极窄窗口）
    const top = rect.top - height - 8 >= 8 ? rect.top - height - 8 : rect.bottom + 8;
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.visibility = "";
  }

  function openPanel(): void {
    if (open) return;
    open = true;
    trigger.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    ensurePanel(); // 懒建：首次打开时才把面板挂到 body（与 model-dropdown 的 ensureMenu 同款）
    place();
  }

  function close(): void {
    if (!open) return;
    open = false;
    trigger.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    if (panel) panel.style.display = "none";
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation(); // 不冒泡到 document，否则「打开」立刻被同一次点击关掉
    open ? close() : openPanel();
  });
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open ? close() : openPanel();
    }
  });
  document.addEventListener("click", () => close());
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  window.addEventListener("resize", () => close()); // fixed 坐标失效
  window.addEventListener("scroll", () => close(), true);

  return { close };
}