// 8.12：工具授权面板 —— 聊天头部「工具授权」按钮弹出的模态（归位总表 L72：不进设置页）。
// 8.12.1 改版（用户拍板）：开关语义统一 —— 开 = 允许使用，关 = 已停用（模型看不到），
//   锁定灰开关 = 档位（或键鼠总闸）拒绝、点不动（title 说明怎么解）。行按此分四组：
//   允许在上 → 每次确认 → 档位拒绝 → 已停用垫底；组内按名称 zh-CN 稳定排，空组不渲染。
//   渲染层不实现 policyFor：分组依据 permission:get 快照的 policyByRisk + config:get 的键鼠总闸，只读快照。
// 手法照 expression-panel.ts：面板动态挂 body、Esc / 点遮罩关闭；开关点击后用回传列表整体重绘（真值回读）。
import type { AppConfig } from "../../shared/config";
import type { PermissionSnapshot, ToolSummary } from "../../shared/tools";

const OVERLAY_ID = "tool-panel";

/** 行的「能不能用」四态 → 固定组序（用户拍板：默认允许的在最上、不允许的在下面） */
type RowState = "allow" | "ask" | "deny" | "off";

const GROUP_ORDER: Array<{ key: RowState; label: string; note?: string }> = [
  { key: "allow", label: "允许" },
  { key: "ask", label: "每次确认" },
  {
    key: "deny",
    label: "档位拒绝",
    note: "当前档位下被拒；到 设置 → 隐私 → 工具权限 调档位后可用（开关锁定）",
  },
  { key: "off", label: "已停用" },
];

export interface ToolPanel {
  /** 主动收起（切视图等场景用） */
  close(): void;
}

export function initToolPanel(trigger: HTMLElement): ToolPanel {
  let overlay: HTMLDivElement | null = null;
  let card: HTMLDivElement | null = null;
  let open = false;
  let busy = false; // 开关 await 期间挡重复点击（整体重绘会换掉子树，旧点击目标可能已失效）
  let snap: PermissionSnapshot | null = null;
  let inputControlOn = false; // 8.6.1 键鼠总闸（config:get 投影；决定 input-control 行归哪组）

  /** 同 settings.ts 的 esc 口径（那边是私有函数，这里自带一份） */
  function esc(s: string): string {
    return s.replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch));
  }

  /** 单行归组：停用 > 键鼠总闸 > 档位裁决（快照只读，不在渲染层重写矩阵） */
  function stateOf(t: ToolSummary): RowState {
    if (!t.enabled) return "off";
    if (t.risk === "input-control" && !inputControlOn) return "deny"; // 8.6.1：总闸关 = 裁决层直接 deny
    const policy = snap?.policyByRisk[t.risk] ?? "deny";
    return policy === "allow" ? "allow" : policy === "ask" ? "ask" : "deny";
  }

  function switchHtml(t: ToolSummary, state: RowState): string {
    if (state === "deny") {
      // 锁定开关：disabled 点不动，title 说明去哪解（档位 or 键鼠总闸）
      const why = t.risk === "input-control" && !inputControlOn
        ? "键鼠控制总开关未开启（设置 → 隐私 → 键鼠控制）"
        : "当前档位下该工具被拒；到 设置 → 隐私 → 工具权限 调档位后可用";
      return `<button type="button" class="switch" data-tool-id="${esc(t.id)}" data-on="false" disabled
                role="switch" aria-checked="false" aria-label="${esc(t.name)}" title="${esc(why)}"><span></span></button>`;
    }
    const on = state !== "off";
    return `<button type="button" class="switch" data-tool-id="${esc(t.id)}" data-on="${on}"
              role="switch" aria-checked="${on}" aria-label="${esc(t.name)}"><span></span></button>`;
  }

  function rowHtml(t: ToolSummary, state: RowState): string {
    return `
      <div class="tool-panel__row">
        <span class="tool-panel__name">${esc(t.name)}</span>
        <span class="tool-panel__cat">${esc(t.category)}</span>
        <span class="tool-panel__risk" data-risk="${esc(t.risk)}">${esc(t.riskLabel)}</span>
        ${switchHtml(t, state)}
      </div>
      ${t.risk === "input-control" ? `<p class="tool-panel__sub">另受 设置 → 隐私 → 键鼠控制 总开关约束</p>` : ""}`;
  }

  /** 按四组渲染（整体重绘也走这里）：行数恒等于 list 条数 —— 每个工具必有一行、只归一组 */
  function render(list: ToolSummary[], snapshot: PermissionSnapshot, icOn: boolean): void {
    if (!card) return;
    snap = snapshot;
    inputControlOn = icOn;
    const buckets = new Map<RowState, ToolSummary[]>([["allow", []], ["ask", []], ["deny", []], ["off", []]]);
    for (const t of list) buckets.get(stateOf(t))!.push(t);
    for (const arr of buckets.values()) arr.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    const body = GROUP_ORDER
      .filter((g) => buckets.get(g.key)!.length > 0)
      .map((g) => `
        <section class="tool-panel__group">
          <h4 class="tool-panel__group-head">${esc(g.label)} · ${buckets.get(g.key)!.length} 个</h4>
          ${g.note ? `<p class="tool-panel__group-note">${esc(g.note)}</p>` : ""}
          ${buckets.get(g.key)!.map((t) => rowHtml(t, g.key)).join("")}
        </section>`)
      .join("");
    card.innerHTML = `
      <header class="tool-panel__head">
        <span class="tool-panel__title">工具授权</span>
        <span class="tool-panel__level">当前档位：${esc(snapshot.levelLabel)}</span>
        <button type="button" class="icon-btn icon-btn--round tool-panel__close" title="关闭" aria-label="关闭">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </header>
      <p class="tool-panel__note">开关开 = 允许模型使用（按当前档位裁决）；关 = 模型看不到这个工具。档位在 设置 → 隐私 → 工具权限 调整</p>
      <div class="tool-panel__body">${body || `<p class="tool-panel__empty">没有已注册的工具</p>`}</div>`;
  }

  /** list() 抛错 → 面板内一行错误文案，不崩（关按钮照常可用） */
  function renderError(message: string): void {
    if (!card) return;
    card.innerHTML = `
      <header class="tool-panel__head">
        <span class="tool-panel__title">工具授权</span>
        <button type="button" class="icon-btn icon-btn--round tool-panel__close" title="关闭" aria-label="关闭">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </header>
      <p class="tool-panel__error">工具列表读取失败：${esc(message)}</p>`;
  }

  function ensureOverlay(): void {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "tool-panel__overlay";
    card = document.createElement("div");
    card.className = "tool-panel glass";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "工具授权");
    overlay.append(card);
    document.body.append(overlay);

    // 面板根节点自绑监听（不上 document 级委托）：关按钮分支拦在 data-tool-id 分支之前
    card.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      if (target.closest(".tool-panel__close")) { close(); return; }
      const btn = target.closest<HTMLElement>("[data-tool-id]");
      if (!btn || btn.hasAttribute("disabled") || busy) return; // 锁定开关点不动
      const id = btn.dataset.toolId ?? "";
      const next = btn.dataset.on !== "true";
      busy = true;
      void (async () => {
        try {
          const list = await window.nahida.tools.setEnabled(id, next);
          if (snap) render(list, snap, inputControlOn); // 真值回读整体重绘（开关焦点丢失可接受）
        } catch (err) {
          renderError(err instanceof Error ? err.message : String(err)); // 开关失败同样面板内报错，不崩
        } finally {
          busy = false;
        }
      })();
    });
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  }

  async function openPanel(): Promise<void> {
    if (open) return;
    open = true;
    trigger.setAttribute("aria-expanded", "true");
    ensureOverlay();
    overlay!.style.display = "flex";
    try {
      const [list, snapshot, cfg] = await Promise.all([
        window.nahida.tools.list(),
        window.nahida.permission.get(),
        window.nahida.config.get(), // 只取 permissions.inputControl 判断键鼠总闸（掩码投影，无敏感值）
      ]);
      render(list, snapshot, cfg.permissions.inputControl === true);
    } catch (err) {
      renderError(err instanceof Error ? err.message : String(err));
    }
  }

  function close(): void {
    if (!open) return;
    open = false;
    trigger.setAttribute("aria-expanded", "false");
    if (overlay) overlay.style.display = "none";
  }

  trigger.addEventListener("click", () => { open ? close() : void openPanel(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  return { close };
}
