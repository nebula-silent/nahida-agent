// 模型下拉组件（数据驱动）：参考自 Cyrene-Agent src/renderer/chat/main.ts 的 dropdown IIFE，
// 按本项目规范重写——浅色玻璃令牌 + body 级 fixed 菜单（避开采裁剪）。
// 设计约束（2026-09-26 用户要求）：后续要接入各大厂商 API，组件只吃 string[]（id 即值，
// 可带厂商前缀如 "openai/gpt-4o"），不感知模型来源；列表/选中逻辑由 main.ts 注入。
export interface ModelDropdown {
  /** 当前选中的模型 id（未选中时为空串） */
  getSelected(): string;
  /** 注入模型列表；preferred 存在于列表中时选中它，否则保留当前选中（不在列表则清空） */
  setModels(models: string[], preferred?: string): void;
  /** 可用性开关（对应原生 select 的 disabled 语义） */
  setEnabled(on: boolean): void;
  /** 选中项真正变化时回调（含 setModels 的自动选中、以及列表变化导致的清空） */
  onChange(callback: (id: string) => void): void;
}

const MENU_ID = "model-menu";
const ICON_CHECK =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const ICON_CHEVRON =
  '<svg class="model-trigger__chevron" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

export function initModelDropdown(trigger: HTMLElement): ModelDropdown {
  const valueEl = document.createElement("span");
  valueEl.className = "model-trigger__value";
  const chevron = document.createElement("span");
  chevron.className = "model-trigger__chevron-wrap";
  chevron.innerHTML = ICON_CHEVRON;
  trigger.replaceChildren(valueEl, chevron);

  let models: string[] = [];
  let selected = "";
  let changeCallback: ((id: string) => void) | null = null;
  let enabled = false;
  let open = false;
  /** 菜单容器：body 级（挂 body 下，避免视图区 overflow 裁剪），open 时现算 fixed 坐标 */
  let menu: HTMLDivElement | null = null;

  function ensureMenu(): HTMLDivElement {
    if (menu) return menu;
    menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.className = "model-menu no-sb";
    menu.setAttribute("role", "listbox");
    menu.addEventListener("click", (e) => e.stopPropagation());
    document.body.append(menu);
    return menu;
  }

  function renderMenuItems(): void {
    const box = ensureMenu();
    box.replaceChildren();
    if (models.length === 0) {
      const empty = document.createElement("div");
      empty.className = "model-menu__opt model-menu__opt--empty";
      empty.textContent = "暂无可用模型";
      box.append(empty);
      return;
    }
    for (const id of models) {
      const opt = document.createElement("div");
      opt.className = `model-menu__opt${id === selected ? " is-active" : ""}`;
      opt.dataset.value = id;
      opt.setAttribute("role", "option");
      const label = document.createElement("span");
      label.className = "model-menu__label";
      label.textContent = id;
      const mark = document.createElement("span");
      mark.className = "model-menu__check";
      mark.innerHTML = id === selected ? ICON_CHECK : "";
      opt.append(label, mark);
      opt.addEventListener("click", () => {
        select(id);
        close();
      });
      box.append(opt);
    }
  }

  /** 打开时按 trigger 现算 fixed 坐标（右对齐，菜单顶在触发器下 4px） */
  function place(): void {
    if (!menu) return;
    const rect = trigger.getBoundingClientRect();
    menu.style.visibility = "hidden";
    menu.style.display = "block";
    const width = menu.offsetWidth;
    const left = Math.max(8, rect.right - width);
    menu.style.left = `${Math.min(left, window.innerWidth - width - 8)}px`;
    menu.style.top = `${rect.bottom + 4}px`;
    menu.style.visibility = "";
  }

  function openMenu(): void {
    if (open || !enabled) return;
    open = true;
    trigger.setAttribute("aria-expanded", "true");
    trigger.classList.add("is-open");
    renderMenuItems();
    place();
  }

  function close(): void {
    if (!open) return;
    open = false;
    trigger.setAttribute("aria-expanded", "false");
    trigger.classList.remove("is-open");
    if (menu) menu.style.display = "none";
  }

  function select(id: string): void {
    const changed = id !== selected; // 同一个值反复 select 不触发回调
    selected = id;
    valueEl.textContent = id;
    renderMenuItems();
    if (changed) changeCallback?.(id);
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    open ? close() : openMenu();
  });
  trigger.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open ? close() : openMenu();
    }
  });
  // 点其它处 / Esc / 窗口变化（fixed 坐标失效）→ 关闭
  document.addEventListener("click", close);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  window.addEventListener("resize", close);
  window.addEventListener("scroll", close, true);

  return {
    getSelected: () => selected,
    onChange(callback) {
      changeCallback = callback;
    },
    setModels(list, preferred) {
      models = [...list];
      if (preferred && models.includes(preferred)) {
        select(preferred);
      } else if (!models.includes(selected)) {
        const changed = selected !== "";
        selected = "";
        valueEl.textContent = "选择模型";
        renderMenuItems();
        if (changed) changeCallback?.("");
      } else {
        renderMenuItems();
      }
    },
    setEnabled(on) {
      enabled = on;
      trigger.classList.toggle("chat__select--disabled", !on);
      if (!on) close();
    },
  };
}
