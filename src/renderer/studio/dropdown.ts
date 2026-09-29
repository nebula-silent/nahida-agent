// 2.7b：自绘下拉。原生 select 的展开菜单在 Windows 上 hover 高亮是系统蓝，CSS 无法覆盖
// （option:checked 能配色、option:hover 不行 —— 用户验收截图确认），彻底解决只能自绘浮层。
// 方案：隐藏原生 select 但保留它承载 value，旁边渲染自绘按钮 + 浮层列表；
// 选中后同步 select.value 并派发 change 事件 —— 调用方读值代码零改动。
export function beautifyDropdown(sel: HTMLSelectElement): void {
  if (sel.dataset.ddBound === "1") return; // 防重复绑定
  sel.dataset.ddBound = "1";
  sel.style.display = "none";

  const wrap = document.createElement("div");
  wrap.className = "dd";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "dd__btn";
  const label = document.createElement("span");
  label.className = "dd__label";
  const arrow = document.createElement("span");
  arrow.className = "dd__arrow";
  btn.append(label, arrow);
  const list = document.createElement("div");
  list.className = "dd__list";
  list.hidden = true;
  wrap.append(btn, list);
  sel.after(wrap);

  let open = false;
  const close = (): void => {
    open = false;
    list.hidden = true;
    wrap.classList.remove("dd--open");
  };
  const toggle = (): void => {
    if (sel.disabled || sel.options.length === 0) return;
    open = !open;
    list.hidden = !open;
    wrap.classList.toggle("dd--open", open);
  };

  /** 选中项右侧的对勾（照聊天模型选择器的样式） */
  const CHECK_SVG =
    `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.5 5 9.5 10 3"/></svg>`;

  /** 原生 option 列表 → 自绘列表；select.value → 按钮文本；disabled 同步 */
  function syncFromSelect(): void {
    list.replaceChildren();
    for (const opt of Array.from(sel.options)) {
      const on = opt.value === sel.value;
      const item = document.createElement("button");
      item.type = "button";
      item.className = on ? "dd__opt dd__opt--on" : "dd__opt";
      const lbl = document.createElement("span");
      lbl.className = "dd__label";
      lbl.textContent = opt.textContent ?? "";
      item.append(lbl);
      if (on) {
        const check = document.createElement("span");
        check.className = "dd__check";
        check.innerHTML = CHECK_SVG; // 静态常量，无用户输入
        item.append(check);
      }
      item.addEventListener("click", () => {
        sel.value = opt.value;
        syncFromSelect();
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        close();
      });
      list.append(item);
    }
    label.textContent = sel.selectedOptions[0]?.textContent ?? "";
    btn.disabled = sel.disabled;
  }

  btn.addEventListener("click", toggle);
  // 点组件外 / Esc 关闭
  document.addEventListener("mousedown", (e) => {
    if (open && !wrap.contains(e.target as Node)) close();
  });
  wrap.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  // fillSources() 会 replaceChildren 重建 options、切 disabled —— observer 自动跟着重建
  new MutationObserver(syncFromSelect).observe(sel, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["disabled"],
  });
  // 「sel.value = xxx」的程序赋值不产生 DOM 变化，上面的 observer 感知不到
  // （value 属性不反射成 attribute；6.x 设置页大量这种回填，如模型提供方 / 语音优先使用）。
  // 给实例包一层 value setter：任何赋值都同步按钮文案与列表选中态，调用方零改动。
  const valueDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sel), "value");
  if (valueDesc?.get && valueDesc?.set) {
    Object.defineProperty(sel, "value", {
      get: () => valueDesc.get!.call(sel) as string,
      set: (v: string) => {
        valueDesc.set!.call(sel, v);
        syncFromSelect();
      },
      configurable: true,
    });
  }
  syncFromSelect();
}
