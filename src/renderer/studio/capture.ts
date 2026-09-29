// 2.7b：截图面板交互。数据全在主进程，这里只管表单状态 + 渲染。
import type { CaptureMode, CaptureSourceView } from "../../shared/media";
import { beautifyDropdown } from "./dropdown";

const modeBox = document.getElementById("capture-mode") as HTMLDivElement;
const sourceSel = document.getElementById("capture-source") as HTMLSelectElement;
const delaySel = document.getElementById("capture-delay") as HTMLSelectElement;
const takeBtn = document.getElementById("capture-take") as HTMLButtonElement;
const dirEl = document.getElementById("capture-dir") as HTMLSpanElement;
const gridEl = document.getElementById("capture-grid") as HTMLDivElement;
const statusEl = document.getElementById("capture-status") as HTMLParagraphElement;

/** 三个开关的当前值（面板重进不丢） */
const flags: Record<string, boolean> = { copyToClipboard: true, showCursor: false, rawSize: true };
let sources: CaptureSourceView[] = [];

function mode(): CaptureMode {
  return (modeBox.querySelector<HTMLElement>(".seg[data-on='true']")?.dataset.mode ?? "full") as CaptureMode;
}

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("media-status--error", isError);
}

/** 未配置保存路径：状态行红字提示（「选择目录」按钮固定在上方卡片里，不随状态行消失） */
function renderNoDirStatus(): void {
  statusEl.textContent = "没有保存路径 —— 点上方「选择目录」指定截图存哪里";
  statusEl.classList.add("media-status--error");
}

/** 选择保存目录：全程回显，任何一步失败都会在状态行给出反馈（不再有无反应死角） */
function pickDir(): void {
  void (async () => {
    setStatus("请在弹出的窗口里选择保存目录…");
    try {
      const lib = await window.nahida.media.pickCaptureDir();
      if (!lib.dir) {
        setStatus("没有选择目录（已取消）—— 需要配置保存路径后才能截图", true);
        return;
      }
      setStatus(`保存路径已设置：${lib.dir}`);
      await refreshLibrary();
    } catch (err) {
      setStatus(`选择目录失败：${err instanceof Error ? err.message : String(err)}`, true);
    }
  })();
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

const MODE_TAG: Record<CaptureMode, string> = { full: "全屏", window: "窗口", area: "区域" };

async function refreshLibrary(): Promise<void> {
  const lib = await window.nahida.media.library();
  gridEl.replaceChildren();
  statusEl.classList.remove("media-status--error");

  // 未配置保存路径：空态 + 报错 + 选择目录入口
  if (!lib.dir) {
    dirEl.textContent = "（未配置）";
    gridEl.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "media-empty";
    empty.textContent = "还没有截图。";
    gridEl.append(empty);
    renderNoDirStatus();
    return;
  }

  dirEl.textContent = lib.dir;

  // file:// 直读被安全策略拦（会显示碎图小图标），改经 CAPTURE_READ_IMAGE 让主进程代读转 dataURL
  const loaded = await Promise.all(
    lib.shots.map(async (shot) => ({ shot, url: await window.nahida.media.readImage(shot.path).catch(() => "") })),
  );
  for (const { shot, url } of loaded) {
    const fig = document.createElement("figure");
    fig.className = "shot-card";
    const img = document.createElement("img");
    img.alt = `${MODE_TAG[shot.mode]} ${fmtTime(shot.takenAt)}`;
    if (url) img.src = url; // 读不到就不设 src，避免碎图图标
    const cap = document.createElement("figcaption");
    cap.className = "shot-card__cap";
    const tag = document.createElement("span");
    tag.className = shot.mode === "area" ? "tag tag-gold" : "tag tag-green";
    tag.textContent = MODE_TAG[shot.mode];
    const name = document.createElement("span");
    name.textContent = `${fmtTime(shot.takenAt)} · ${shot.width}×${shot.height}`;
    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.className = "shot-card__act";
    reveal.textContent = "定位";
    reveal.addEventListener("click", () => window.nahida.media.reveal(shot.path));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "shot-card__act";
    del.textContent = "删除";
    del.addEventListener("click", () => {
      void (async () => {
        try {
          await window.nahida.media.deleteShot(shot.path);
          await refreshLibrary();
        } catch (err) {
          setStatus(err instanceof Error ? err.message : String(err), true);
        }
      })();
    });
    cap.append(tag, name, reveal, del);
    fig.append(img, cap);
    gridEl.append(fig);
  }
  setStatus(`共 ${lib.total} 张截图 · 本月新增 ${lib.thisMonth} 张`);
}

function fillSources(): void {
  const m = mode();
  const list = sources.filter((s) => (m === "window" ? s.kind === "window" : s.kind === "screen"));
  sourceSel.replaceChildren();
  for (const s of list) {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = s.name;
    sourceSel.append(opt);
  }
  sourceSel.disabled = list.length === 0;
}

// 方式切换
modeBox.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".seg");
  if (!btn) return;
  for (const b of modeBox.querySelectorAll<HTMLButtonElement>(".seg")) {
    b.dataset.on = String(b === btn);
  }
  fillSources();
});

// 开关：只绑本面板的键（record/live 面板有自己的开关，不加过滤会双重翻转）
for (const sw of document.querySelectorAll<HTMLButtonElement>(".media-switch .switch")) {
  const key = sw.dataset.key ?? "";
  if (!(key in flags)) continue;
  sw.addEventListener("click", () => {
    flags[key] = !flags[key];
    sw.dataset.on = String(flags[key]);
  });
}

takeBtn.addEventListener("click", () => {
  void (async () => {
    takeBtn.disabled = true;
    const delay = Number(delaySel.value) || 0;
    setStatus(delay > 0 ? `${delay / 1000} 秒后截图…` : "正在截图…");
    try {
      const shot = await window.nahida.media.takeShot({
        mode: mode(),
        sourceId: sourceSel.value,
        delayMs: delay,
        copyToClipboard: flags.copyToClipboard,
        showCursor: flags.showCursor,
        rawSize: flags.rawSize,
      });
      setStatus(`已保存 ${shot.fileName} · ${shot.width}×${shot.height} · ${Math.round(shot.bytes / 1024)} KB`);
      await refreshLibrary();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("没有保存路径")) renderNoDirStatus();
      else setStatus(msg, true);
    } finally {
      takeBtn.disabled = false;
    }
  })();
});

document.getElementById("capture-pick-dir")?.addEventListener("click", pickDir);

// 自绘下拉（原生展开菜单 hover 是系统蓝，CSS 不可覆盖）：延时 + 采集源
beautifyDropdown(delaySel);
beautifyDropdown(sourceSel);

void (async () => {
  try {
    sources = await window.nahida.media.listSources();
    fillSources();
    await refreshLibrary();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
})();
