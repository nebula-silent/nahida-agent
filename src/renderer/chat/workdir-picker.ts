// 9.1：工作目录选择器（聊天视图头，模型下拉右侧同款视觉）。
// 交互：点 trigger → fs:pick-dir 系统目录弹框（复用 8.2，不造自绘菜单）→ 选中即绑定；
// 已选时 trigger 右侧出现 × 清除钮（点击恢复「未选择」）。取消弹框不触发 onChange。
// 状态真相在会话（session.workDir）+ 主进程内存（fs-tools setChatWorkDir），本组件只管 UI 与回调。
export interface WorkdirPicker {
  /** 当前绑定的目录（未选择 = 空串） */
  get(): string;
  /** 纯 UI 回显（loadSession 换会话时用），不触发 onChange */
  set(dir: string): void;
  /** 用户选择 / 清除时回调（dir = "" 表示清除） */
  onChange(callback: (dir: string) => void): void;
}

const ICON_FOLDER =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
const ICON_CLOSE =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

export function initWorkdirPicker(trigger: HTMLElement): WorkdirPicker {
  let current = "";
  let changeCallback: ((dir: string) => void) | null = null;
  let busy = false; // 弹框打开期间防重复点击

  const valueEl = document.createElement("span");
  valueEl.className = "dir-trigger__value";
  const clearBtn = document.createElement("span");
  clearBtn.className = "dir-trigger__clear";
  clearBtn.innerHTML = ICON_CLOSE;
  clearBtn.setAttribute("role", "button");
  clearBtn.setAttribute("aria-label", "清除工作目录");
  clearBtn.hidden = true;
  trigger.replaceChildren(clearBtn, valueEl);

  function render(): void {
    if (current === "") {
      valueEl.textContent = "工作目录";
      trigger.title = "选择本对话允许她读写的目录（新对话不继承）";
      trigger.classList.remove("is-active");
      clearBtn.hidden = true;
    } else {
      // 只显示目录名，完整路径放 title（悬停可看）；拿不到 basename（异常路径）就退回全路径
      const parts = current.split(/[\\/]/).filter(Boolean);
      valueEl.textContent = parts[parts.length - 1] ?? current;
      trigger.title = `本对话的工作目录：${current}`;
      trigger.classList.add("is-active");
      clearBtn.hidden = false;
    }
  }

  trigger.addEventListener("click", (e) => {
    // 点在 × 上 → 只清除；点其余区域 → 弹目录框
    if (clearBtn.contains(e.target as Node)) {
      e.stopPropagation();
      if (current === "") return;
      current = "";
      render();
      changeCallback?.("");
      return;
    }
    if (busy) return;
    busy = true;
    void window.nahida.fs
      .pickDir()
      .then((picked) => {
        if (picked && picked !== current) {
          current = picked;
          render();
          changeCallback?.(picked);
        }
      })
      .catch((err) => console.error("[nahida] 选择目录失败:", err))
      .finally(() => { busy = false; });
  });

  render();
  return {
    get: () => current,
    set(dir) {
      const next = typeof dir === "string" ? dir : "";
      if (next === current) return; // 同值跳过（避免 loadSession 重渲染闪烁）
      current = next;
      render();
    },
    onChange(callback) {
      changeCallback = callback;
    },
  };
}
