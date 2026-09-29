import QRCode from "qrcode/lib/browser"; // 8.7.11：二维码渲染（类型声明见 qrcode-browser.d.ts）
// 8.7.17-20：跨进程工具的独立面板模块 —— 各自用 innerHTML 自建 DOM，互不碰共享文件
import { initClipboardPanel } from "./panels/clipboard";
import { initPdfPanel } from "./panels/pdf-panel";
import { initRssPanel } from "./panels/rss-panel";
import { initTranscodePanel } from "./panels/transcode-panel";

// 8.7.7：工具箱 · 工具独立子窗口（渲染端）
// 从 ur 参数读出主进程注入的工具信息，画标题栏 + 各工具的占位面板；
// 窗口控制（最小化 / 关闭）走主窗口同款 IPC（window.nahida，preload 已暴露）。
// 各工具真实功能在后续版本接入开源实现后，把占位面板逐个换成真实面板。

interface ToolWindowView {
  id: string;
  title: string;
  sub: string;
  kind: "launcher" | "self";
  hint: string;
}

function readView(): ToolWindowView {
  const p = new URLSearchParams(window.location.search);
  return {
    id: p.get("t") ?? "",
    title: p.get("title") ?? "工具",
    sub: p.get("sub") ?? "",
    kind: p.get("kind") === "launcher" ? "launcher" : "self",
    hint: p.get("hint") ?? "",
  };
}

const VIEW = readView();

// 标题栏
const titleEl = document.getElementById("tool-title");
if (titleEl) titleEl.textContent = VIEW.title;
document.title = `工具箱 · ${VIEW.title}`;

// hero
const heroTitle = document.getElementById("tool-hero-title");
if (heroTitle) heroTitle.textContent = VIEW.title;
const heroSub = document.getElementById("tool-hero-sub");
if (heroSub) {
  heroSub.textContent = VIEW.sub;
  heroSub.hidden = !VIEW.sub; // 副标题为空不留空行（self 插件已不再传「本应用自研」）
}

// 已选目录（MCP / launcher 打开前先选目录）：有值就展示成提示条
const toolHintEl = document.getElementById("tool-hint");
if (toolHintEl) {
  if (VIEW.hint) {
    toolHintEl.hidden = false;
    toolHintEl.textContent = `已选择目录：${VIEW.hint}`;
  }
}

// 窗口控制：最小化 / 关闭（复用主窗口 IPC，按 sender 定位本窗）
document.getElementById("tool-min")?.addEventListener("click", () => window.nahida.minimize());
document.getElementById("tool-close")?.addEventListener("click", () => window.nahida.close());

// ===== 8.7.9：单位换算（长度/重量/面积/数据/速度用因子表，温度单独公式）=====
// 换算因子为国际标准常量，前端自算；结果浮点尾差统一就近取整 12 位有效数字。
function initConvert(): void {
  const catSel = document.getElementById("convert-cat") as HTMLSelectElement | null;
  const fromValue = document.getElementById("convert-from-value") as HTMLInputElement | null;
  const fromUnit = document.getElementById("convert-from-unit") as HTMLSelectElement | null;
  const toValue = document.getElementById("convert-to-value") as HTMLInputElement | null;
  const toUnit = document.getElementById("convert-to-unit") as HTMLSelectElement | null;
  const status = document.getElementById("convert-status") as HTMLElement | null;
  if (!catSel || !fromValue || !fromUnit || !toValue || !toUnit) return;

  const UNIT_GROUPS: Record<string, Array<{ u: string; f: number }>> = {
    length: [ // 基准：米 m
      { u: "毫米 mm", f: 0.001 }, { u: "厘米 cm", f: 0.01 }, { u: "米 m", f: 1 },
      { u: "千米 km", f: 1000 }, { u: "英寸 in", f: 0.0254 }, { u: "英尺 ft", f: 0.3048 },
      { u: "码 yd", f: 0.9144 }, { u: "英里 mi", f: 1609.344 }, { u: "海里 nmi", f: 1852 },
    ],
    weight: [ // 基准：千克 kg
      { u: "毫克 mg", f: 1e-6 }, { u: "克 g", f: 0.001 }, { u: "千克 kg", f: 1 },
      { u: "吨 t", f: 1000 }, { u: "斤", f: 0.5 }, { u: "磅 lb", f: 0.45359237 }, { u: "盎司 oz", f: 0.028349523125 },
    ],
    area: [ // 基准：平方米 m²
      { u: "平方毫米 mm²", f: 1e-6 }, { u: "平方厘米 cm²", f: 1e-4 }, { u: "平方米 m²", f: 1 },
      { u: "平方千米 km²", f: 1e6 }, { u: "公顷 ha", f: 10000 }, { u: "亩", f: 666.6666666666666 }, { u: "英亩 acre", f: 4046.8564224 },
    ],
    data: [ // 基准：B（按 1024）
      { u: "B", f: 1 }, { u: "KB", f: 1024 }, { u: "MB", f: 1024 ** 2 },
      { u: "GB", f: 1024 ** 3 }, { u: "TB", f: 1024 ** 4 }, { u: "PB", f: 1024 ** 5 },
    ],
    speed: [ // 基准：m/s
      { u: "米/秒 m/s", f: 1 }, { u: "千米/时 km/h", f: 1 / 3.6 },
      { u: "英里/时 mph", f: 0.44704 }, { u: "节 knot", f: 0.5144444444444445 },
    ],
  };
  const TEMP_LABELS = [
    { u: "摄氏度 ℃", k: "C" }, { u: "华氏度 ℉", k: "F" }, { u: "开尔文 K", k: "K" },
  ];
  const toC = { C: (v: number) => v, F: (v: number) => ((v - 32) * 5) / 9, K: (v: number) => v - 273.15 };
  const fromC = { C: (c: number) => c, F: (c: number) => (c * 9) / 5 + 32, K: (c: number) => c + 273.15 };

  const clean = (n: number): number => Number(n.toPrecision(12)); // 掐掉二进制浮点尾差

  const fillUnits = (): void => { // 每次切类别重建两个单位下拉
    const cat = catSel.value;
    const units = cat === "temperature" ? TEMP_LABELS : UNIT_GROUPS[cat] ?? [];
    const pairs = units.map((u, i) => ({
      label: "u" in u ? (u as { u: string }).u : (u as { u: string; k: string }).u,
      value: "k" in u ? (u as { k: string }).k : String(i),
    }));
    [fromUnit, toUnit].forEach((sel) => {
      sel.innerHTML = "";
      pairs.forEach((p, i) => {
        const opt = document.createElement("option");
        opt.value = p.value; opt.textContent = p.label;
        sel.appendChild(opt);
        if (i === Math.floor(pairs.length / 2)) sel.selectedIndex = i; // 默认选中中位单位
      });
    });
  };

  const convert = (): void => {
    const value = Number(fromValue.value);
    if (!Number.isFinite(value)) { toValue.value = ""; if (status) status.textContent = "请输入有效数字"; return; }
    let result: number;
    if (catSel.value === "temperature") {
      const c = toC[fromUnit.value as "C" | "F" | "K"](value);
      result = fromC[toUnit.value as "C" | "F" | "K"](c);
    } else {
      const list = UNIT_GROUPS[catSel.value];
      const from = list[Number(fromUnit.value)];
      const to = list[Number(toUnit.value)];
      result = (value * from.f) / to.f;
    }
    toValue.value = String(clean(result));
    if (status) status.textContent = `${clean(value)} ${fromUnit.options[fromUnit.selectedIndex].text} = ${clean(result)} ${toUnit.options[toUnit.selectedIndex].text}`;
  };

  if (catSel) catSel.addEventListener("change", () => { fillUnits(); convert(); });
  [fromUnit, toUnit].forEach((sel) => sel.addEventListener("change", convert));
  if (fromValue) fromValue.addEventListener("input", convert);
  fillUnits();
}

// ===== 8.7.10：批量重命名（选目录 → 规则 → 预览 → 执行）=====
// 预览在渲染层即时算，改名实际交给 rename:run（主进程做路径安全校验、单条失败不中断）。
function initRename(): void {
  const pickBtn = document.getElementById("rename-pick") as HTMLButtonElement | null;
  const dirEl = document.getElementById("rename-dir") as HTMLElement | null;
  const findEl = document.getElementById("rename-find") as HTMLInputElement | null;
  const replEl = document.getElementById("rename-repl") as HTMLInputElement | null;
  const prefixEl = document.getElementById("rename-prefix") as HTMLInputElement | null;
  const suffixEl = document.getElementById("rename-suffix") as HTMLInputElement | null;
  const runBtn = document.getElementById("rename-run") as HTMLButtonElement | null;
  const tbody = document.getElementById("rename-tbody") as HTMLElement | null;
  const statusEl = document.getElementById("rename-status") as HTMLElement | null;
  if (!pickBtn || !tbody || !runBtn) return;
  const tb = tbody!; // 面板存在才进本函数；闭包内不保留外层收窄，故取非空别名
  const rb = runBtn!;

  let dir = "";
  let allNames: string[] = []; // 目录内所有条目名（文件+子目录），用于「与现有项重名」检测

  const esc = (s: string): string =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  const invalidName = (s: string): boolean =>
    s.length === 0 || /[\/\\]/.test(s) || /[<>:"|?*]/.test(s) || /[. ]$/.test(s);

  const applyRules = (name: string): string => {
    let n = name;
    const find = findEl?.value ?? "";
    if (find) n = n.split(find).join(replEl?.value ?? "");
    n = `${prefixEl?.value ?? ""}${n}${suffixEl?.value ?? ""}`;
    return n;
  };

  interface Row { name: string; target: string; state: "ok" | "skip" | "err" | "dup" | "occ"; note: string; }

  const buildRows = (): Row[] => {
    const freq = new Map<string, number>();
    files.forEach((f) => freq.set(applyRules(f), (freq.get(applyRules(f)) ?? 0) + 1));
    return files.map<Row>((name) => {
      const target = applyRules(name);
      if (target === name) return { name, target, state: "skip", note: "不变" };
      if (invalidName(target)) return { name, target, state: "err", note: "非法文件名" };
      if (allNames.includes(target)) return { name, target, state: "occ", note: "已被占用" };
      if ((freq.get(target) ?? 0) > 1) return { name, target, state: "dup", note: "重名冲突" };
      return { name, target, state: "ok", note: "将重命名" };
    });
  };

  function render(rows: Row[]): void {
    const badge: Record<Row["state"], string> = {
      ok: "ok", skip: "skip", err: "err", dup: "warn", occ: "warn",
    };
    tb.innerHTML = rows
      .map((r) => `<tr>
            <td>${esc(r.name)}</td>
            <td class="arrow">→</td>
            <td><span class="${r.state === "ok" ? "" : "rename__cancelled"}">${esc(r.target)}</span></td>
            <td><span class="rename__badge rename__badge--${badge[r.state]}">${r.note}</span></td>
          </tr>`)
      .join("");

    const okCount = rows.filter((r) => r.state === "ok").length;
    rb.disabled = okCount === 0 || !dir;
    const warn = rows.filter((r) => r.state === "dup" || r.state === "occ").length;
    if (!dir) { if (statusEl) statusEl.textContent = "先选择一个目录"; }
    else if (rows.length === 0) { if (statusEl) statusEl.textContent = "该目录下没有可重命名的文件"; }
    else if (okCount === 0) { if (statusEl) statusEl.textContent = "当前规则没有产生任何改动（灰行=不变，橙行=冲突/占用）"; }
    else { if (statusEl) statusEl.textContent = `${okCount} 个文件将重命名${warn ? `，${warn} 个存在冲突` : ""}；橙/红行不会执行`; }
  }

  let files: string[] = [];
  const load = async (path: string): Promise<void> => {
    dir = path;
    if (dirEl) { dirEl.textContent = path; dirEl.title = path; }
    try {
      const entries = await window.nahida.rename.listDir(path);
      allNames = entries.map((e) => e.name);
      files = entries.filter((e) => e.isFile).map((e) => e.name);
    } catch {
      allNames = []; files = [];
      if (statusEl) statusEl.textContent = "读取目录失败";
    }
    render(buildRows());
  };

  pickBtn.addEventListener("click", () => {
    void window.nahida.fs.pickDir().then((p) => { if (p) void load(p); });
  });
  [findEl, replEl, prefixEl, suffixEl].forEach((el) =>
    el?.addEventListener("input", () => render(buildRows())));
  runBtn.addEventListener("click", () => {
    const ops = buildRows()
      .filter((r) => r.state === "ok")
      .map((r) => ({ from: r.name, to: r.target }));
    if (ops.length === 0) return;
    void window.nahida.rename.run({ dir, ops }).then((res) => {
      const ok = res.filter((r) => r.ok).length;
      const fails = res.filter((r) => !r.ok);
      const note = fails.length
        ? `${fails[0]!.from} → ${fails[0]!.error}`
        : "全部完成";
      if (statusEl) statusEl.textContent = `已执行 ${ok}/${ops.length} 项；${note}`;
      void load(dir); // 结果回读，表格与目录保持同步
    });
  });
  render(buildRows()); // 目录未选，先画空状态
}

// ===== 8.7.11：二维码生成（qrcode 库，纯前端）=====
function initQrcode(): void {
  const text = document.getElementById("qr-text") as HTMLTextAreaElement | null;
  const img = document.getElementById("qr-img") as HTMLImageElement | null;
  const gen = document.getElementById("qr-gen") as HTMLButtonElement | null;
  const dld = document.getElementById("qr-download") as HTMLButtonElement | null;
  const status = document.getElementById("qr-status") as HTMLElement | null;
  if (!text || !img || !gen || !dld) return;
  let current = "";

  const setStatus = (s: string): void => { if (status) status.textContent = s; };

  gen.addEventListener("click", () => {
    const content = text.value.trim();
    if (!content) { setStatus("请输入要编码的文本或链接"); img.hidden = true; dld.hidden = true; return; }
    void QRCode.toDataURL(content, { width: 400, margin: 2 }).then((url) => {
      current = url;
      img.src = url; img.hidden = false;
      dld.hidden = false;
      setStatus("已生成（约 512×512，PNG）。点击「下载 PNG」保存到本地。");
    }).catch(() => setStatus("生成失败，请重试"));
  });
  dld.addEventListener("click", () => {
    if (!current) return;
    const a = document.createElement("a");
    a.href = current; a.download = `qrcode_${Date.now()}.png`;
    a.click();
  });
}

// ===== 8.7.12：便签（localStorage 本地持久化）=====
function initNote(): void {
  const input = document.getElementById("note-input") as HTMLTextAreaElement | null;
  const add = document.getElementById("note-add") as HTMLButtonElement | null;
  const list = document.getElementById("note-list") as HTMLElement | null;
  if (!input || !add || !list) return;
  const lb = list!; // 面板存在才进本函数；闭包内不保留外层收窄，故取非空别名

  const KEY = "tool-notes";
  interface Note { id: string; text: string; ts: number; }
  let notes = (function load(): Note[] { try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; } })();
  const save = (): void => localStorage.setItem(KEY, JSON.stringify(notes));
  const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

  function render(): void {
    const newest = [...notes].sort((a, b) => b.ts - a.ts);
    lb.innerHTML = newest.length
      ? newest.map((n) => `<div class="note__card">
          <span class="note__card-text">${esc(n.text)}</span>
          <button type="button" class="note-del" data-id="${n.id}" title="删除" aria-label="删除">✕</button>
          <span class="note__card-meta">${new Date(n.ts).toLocaleString("zh-CN", { hour12: false })}</span>
        </div>`).join("")
      : `<p class="tool-tool__status">还没有便签，写一条吧。</p>`;
    lb.querySelectorAll<HTMLButtonElement>(".note-del").forEach((btn) => {
      btn.addEventListener("click", () => {
        notes = notes.filter((n) => n.id !== btn.dataset.id);
        save(); render();
      });
    });
  }

  const addNote = (): void => {
    const t = input.value.trim();
    if (!t) return;
    notes.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text: t, ts: Date.now() });
    save(); input.value = ""; render();
  };
  add.addEventListener("click", addNote);
  input.addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "Enter") { e.preventDefault(); addNote(); } });
  render();
}

// ===== 8.7.13：番茄钟（纯前端计时）=====
function initPomodoro(): void {
  const timeEl = document.getElementById("pomo-time") as HTMLElement | null;
  const labelEl = document.getElementById("pomo-label") as HTMLElement | null;
  const start = document.getElementById("pomo-start") as HTMLButtonElement | null;
  const reset = document.getElementById("pomo-reset") as HTMLButtonElement | null;
  const dur = document.getElementById("pomo-dur") as HTMLSelectElement | null;
  const status = document.getElementById("pomo-status") as HTMLElement | null;
  if (!timeEl || !start || !reset || !dur) return;

  let remaining = Number(dur.value) * 60;
  let timer: number | null = null;
  let running = false;

  const fmt = (s: number): string => {
    const mm = Math.floor(s / 60).toString().padStart(2, "0");
    const ss = Math.floor(s % 60).toString().padStart(2, "0");
    return `${mm}:${ss}`;
  };
  const renderTime = (): void => { timeEl.textContent = fmt(remaining); };

  const stop = (): void => { if (timer !== null) { clearInterval(timer); timer = null; } running = false; start.textContent = "开始"; timeEl.classList.remove("running"); };
  const beep = (): void => {
    try {
      const ctx = new AudioContext();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination); o.frequency.value = 880; g.gain.value = 0.15;
      o.start(); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4); o.stop(ctx.currentTime + 0.45);
    } catch { /* 音频不可用就静音 */ }
  };

  const begin = (): void => {
    running = true; start.textContent = "暂停"; timeEl.classList.add("running");
    if (labelEl) labelEl.textContent = "专注中";
    timer = window.setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        remaining = 0; renderTime(); stop();
        if (labelEl) labelEl.textContent = "专注完成";
        if (status) status.textContent = "本轮完成，休息一下吧";
        beep();
        return;
      }
      renderTime();
    }, 1000);
  };
  start.addEventListener("click", () => { if (running) stop(); else begin(); });
  reset.addEventListener("click", () => {
    stop();
    remaining = Number(dur.value) * 60;
    renderTime();
    if (status) status.textContent = "已重置";
  });
  dur.addEventListener("change", () => { reset.click(); });
  renderTime();
}

// ===== 8.7.14：日历（纯前端月视图）=====
function initCalendar(): void {
  const title = document.getElementById("cal-title") as HTMLElement | null;
  const grid = document.getElementById("cal-grid") as HTMLElement | null;
  const prev = document.getElementById("cal-prev") as HTMLButtonElement | null;
  const next = document.getElementById("cal-next") as HTMLButtonElement | null;
  const today = document.getElementById("cal-today") as HTMLButtonElement | null;
  if (!grid) return;
  const g = grid!; // 面板存在才进本函数；闭包内不保留外层收窄，故取非空别名

  const now = new Date();
  let y = now.getFullYear();
  let m = now.getMonth();

  function render(): void {
    if (title) title.textContent = `${y} 年 ${m + 1} 月`;
    const todayD = new Date().getDate();
    const firstIdx = new Date(y, m, 1).getDay();
    const days = new Date(y, m + 1, 0).getDate();
    const prevDays = new Date(y, m, 0).getDate();
    const cells: Array<{ d: number; cls: string }> = [];
    for (let i = 0; i < 42; i++) {
      if (i < firstIdx) { cells.push({ d: prevDays - firstIdx + 1 + i, cls: "ghost" }); }
      else if (i < firstIdx + days) {
        const d = i - firstIdx + 1;
        const dow = (firstIdx + i) % 7;
        const cls = [dow === 0 ? "sun" : "", dow === 6 ? "sat" : "", y === now.getFullYear() && m === now.getMonth() && d === todayD ? "today" : ""].join(" ").trim();
        cells.push({ d, cls });
      } else { cells.push({ d: i - firstIdx - days + 1, cls: "other" }); }
    }
    g.innerHTML = cells.map((c) => `<div class="cal__cell${c.cls ? ` cal__cell--${c.cls.split(" ").join(" cal__cell--")}` : ""}">${c.d}</div>`).join("");
  }
  prev?.addEventListener("click", () => { if (--m < 0) { m = 11; y--; } render(); });
  next?.addEventListener("click", () => { if (++m > 11) { m = 0; y++; } render(); });
  today?.addEventListener("click", () => { y = now.getFullYear(); m = now.getMonth(); render(); });
  render();
}

// ===== 8.7.15：图片格式转换（canvas 重编码，纯前端）=====
function initImgConvert(): void {
  const pick = document.getElementById("imgc-pick") as HTMLButtonElement | null;
  const file = document.getElementById("imgc-file") as HTMLInputElement | null;
  const fmt = document.getElementById("imgc-format") as HTMLSelectElement | null;
  const save = document.getElementById("imgc-save") as HTMLButtonElement | null;
  const prev = document.getElementById("imgc-preview") as HTMLImageElement | null;
  const status = document.getElementById("imgc-status") as HTMLElement | null;
  if (!pick || !file || !fmt || !save || !prev) return;

  const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
  const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
  const setStatus = (s: string): void => { if (status) status.textContent = s; };
  let dataUrl = "";

  pick.addEventListener("click", () => file.click());
  file.addEventListener("change", () => {
    const f = file.files?.[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => { prev.src = rd.result as string; prev.hidden = false; setStatus(`已载入 ${f.name}（${kb(f.size)}）。选择格式后自动转换。`); };
    rd.onerror = () => setStatus("读取图片失败");
    rd.readAsDataURL(f);
  });

  const convert = (): void => {
    if (prev.hidden || !prev.src) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const type = fmt.value;
      if (type === "image/jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); } // jpeg 不支持透明，垫白
      ctx.drawImage(img, 0, 0);
      c.toBlob((b) => {
        if (!b) return;
        const rd = new FileReader();
        rd.onload = () => { dataUrl = rd.result as string; save.hidden = false; setStatus(`已转换（${kb(b.size)}）→ ${EXT[type]}`); };
        rd.readAsDataURL(b);
      }, type, 0.92);
    };
    img.onerror = () => setStatus("图片解码失败");
    img.src = prev.src;
  };
  fmt.addEventListener("change", convert);
  save.addEventListener("click", () => {
    if (!dataUrl) return;
    const a = document.createElement("a");
    a.href = dataUrl; a.download = `converted_${Date.now()}.${EXT[fmt.value] ?? "png"}`;
    a.click();
  });
}

// 分发：已接入真实功能的工具在此登记；其余仍显示占位
if (VIEW.id === "convert") {

  document.getElementById("panel-convert")?.removeAttribute("hidden");
  initConvert();
} else if (VIEW.id === "rename") {

  document.getElementById("panel-rename")?.removeAttribute("hidden");
  initRename();
} else if (VIEW.id === "qrcode") {

  document.getElementById("panel-qrcode")?.removeAttribute("hidden");
  initQrcode();
} else if (VIEW.id === "note") {

  document.getElementById("panel-note")?.removeAttribute("hidden");
  initNote();
} else if (VIEW.id === "pomodoro") {

  document.getElementById("panel-pomodoro")?.removeAttribute("hidden");
  initPomodoro();
} else if (VIEW.id === "calendar") {

  document.getElementById("panel-calendar")?.removeAttribute("hidden");
  initCalendar();
} else if (VIEW.id === "img-convert") {

  document.getElementById("panel-img-convert")?.removeAttribute("hidden");
  initImgConvert();
} else if (VIEW.id === "clipboard") {

  document.getElementById("panel-clipboard")?.removeAttribute("hidden");
  initClipboardPanel();
} else if (VIEW.id === "pdf-tool") {

  document.getElementById("panel-pdf-tool")?.removeAttribute("hidden");
  initPdfPanel();
} else if (VIEW.id === "rss") {

  document.getElementById("panel-rss")?.removeAttribute("hidden");
  initRssPanel();
} else if (VIEW.id === "music-convert" || VIEW.id === "video-convert") {
  // 音视频转换：两张卡共用一面板，按卡片类别预选「音频 / 视频」

  document.getElementById("panel-transcode")?.removeAttribute("hidden");
  initTranscodePanel(VIEW.id === "music-convert" ? "audio" : "video");
}

// ===== 8.7.21：外观同步（2026-09-29 深色主题）
// 独立子窗不共享主窗 DOM：启动读配置应用主题/强调色/背景，并订阅主进程广播实时跟随；
// 「跟随系统」档在本地挂 matchMedia 监听（同主窗 settings.ts 口径，系统明暗切换两窗各自生效）。
interface AccentSet { name: string; brand: string; bright: string; mid: string; soft: string; ink: string; }
type UiVisualPatch = { theme?: string; accent?: string; bgType?: string; bgImage?: string };

const THEME_VALUES = ["跟随系统", "浅色", "深色"] as const;
const BGTYPE_VALUES = ["渐变", "纯色", "自定义图片"] as const;
const ACCENT_PRESETS: AccentSet[] = [
  { name: "白", brand: "#3fbf95", bright: "#7ed0b0", mid: "#a9e7cd", soft: "#eef7f2", ink: "#128d6b" },
  { name: "浅绿", brand: "#5bbd96", bright: "#7ed0b0", mid: "#a9e7cd", soft: "#d8f1e5", ink: "#2c926e" },
  { name: "深绿", brand: "#128d6b", bright: "#3fbf95", mid: "#7ed0b0", soft: "#a9e7cd", ink: "#0f5c45" },
  { name: "浅灰", brand: "#7a8f88", bright: "#9db0aa", mid: "#b8c9c3", soft: "#e4ece8", ink: "#4a5a55" },
  { name: "深灰", brand: "#4a5a55", bright: "#6d807a", mid: "#93a49e", soft: "#cdd9d4", ink: "#2f3b36" },
];

/** 自定义强调色派生：主色 → 全套令牌（与 settings.ts deriveAccent 同算法，提亮/压暗保持色相） */
function deriveAccent(hex: string): AccentSet {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mix = (t: number, w: number): number => Math.round(t + (255 - t) * w);
  const shade = (t: number, w: number): number => Math.round(t * (1 - w));
  const fmt = (v: number): string => v.toString(16).padStart(2, "0");
  return {
    name: "自定义",
    brand: `#${fmt(r)}${fmt(g)}${fmt(b)}`,
    bright: `#${fmt(mix(r, .25))}${fmt(mix(g, .25))}${fmt(mix(b, .25))}`,
    mid: `#${fmt(mix(r, .5))}${fmt(mix(g, .5))}${fmt(mix(b, .5))}`,
    soft: `#${fmt(mix(r, .8))}${fmt(mix(g, .8))}${fmt(mix(b, .8))}`,
    ink: `#${fmt(shade(r, .35))}${fmt(shade(g, .35))}${fmt(shade(b, .35))}`,
  };
}

let systemDarkQuery: MediaQueryList | null = null;
let currentThemeMode: string = THEME_VALUES[0];
let themeFollowActive = false;

/** 解析主题档 → 最终明暗："浅色"→light；"深色"→dark；"跟随系统"→实时读系统偏好 */
function resolveThemeMode(mode: string): "light" | "dark" {
  if (mode === "深色") return "dark";
  if (mode === "浅色") return "light";
  if (typeof window.matchMedia === "function") {
    if (!systemDarkQuery) systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");
    return systemDarkQuery.matches ? "dark" : "light";
  }
  return "light";
}

/** 只写 documentElement：主题档 / 强调令牌 / 背景样式；键在才动（广播只带变化的键） */
function applyVisual(patch: UiVisualPatch): void {
  const root = document.documentElement;
  if ("theme" in patch) {
    const mode = String(patch.theme ?? "");
    currentThemeMode = (THEME_VALUES as readonly string[]).includes(mode) ? mode : THEME_VALUES[0];
    root.dataset.theme = resolveThemeMode(currentThemeMode);
  }
  if ("accent" in patch) {
    const v = String(patch.accent ?? "");
    const accent = v && /^#[0-9a-f]{6}$/i.test(v)
      ? deriveAccent(v.toLowerCase())
      : ACCENT_PRESETS.find((p) => p.name === v) ?? null;
    if (accent) {
      root.style.setProperty("--brand", accent.brand);
      root.style.setProperty("--brand-bright", accent.bright);
      root.style.setProperty("--brand-mid", accent.mid);
      root.style.setProperty("--brand-soft", accent.soft);
      root.style.setProperty("--brand-ink", accent.ink);
    }
  }
  if ("bgType" in patch) {
    const v = String(patch.bgType ?? "");
    const bg = (BGTYPE_VALUES as readonly string[]).includes(v) ? v : BGTYPE_VALUES[0];
    if (bg === "渐变") root.style.removeProperty("--bg-page"); // 回落 tokens.css 默认（浅色渐变 / 深色块覆盖）
    else root.style.setProperty("--bg-page", "var(--bg-solid)");
  }
  // 8.7.22：背景图路径 → --bg-image 复合值（遮罩层 + 图，铺满固定）；空/脏值 → none
  if ("bgImage" in patch) {
    const v = String(patch.bgImage ?? "");
    root.style.setProperty(
      "--bg-image",
      v ? `var(--bg-image-mask), url("file:///${v.replace(/\\/g, "/")}") center/cover no-repeat fixed` : "none",
    );
  }
}

/** 跟随系统监听：当前档是跟随系统才挂；切档后模块级 currentThemeMode 挡掉迟到事件 */
function initThemeFollow(): void {
  const want = currentThemeMode === "跟随系统" && typeof window.matchMedia === "function";
  if (want === themeFollowActive) return;
  themeFollowActive = want;
  if (!want) return;
  if (!systemDarkQuery) systemDarkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = (): void => {
    if (currentThemeMode !== "跟随系统") return;
    document.documentElement.dataset.theme = resolveThemeMode("跟随系统");
  };
  if (typeof systemDarkQuery.addEventListener === "function") {
    systemDarkQuery.addEventListener("change", onChange);
  } else if (typeof (systemDarkQuery as MediaQueryList & { addListener?: (cb: () => void) => void }).addListener === "function") {
    (systemDarkQuery as MediaQueryList & { addListener?: (cb: () => void) => void }).addListener?.(onChange);
  }
}

/** 启动：读配置应用全部外观键；此后主窗设置改动经广播实时同步 */
function initThemeSync(): void {
  void window.nahida.config.get().then((cfg) => {
    const ui = cfg.ui ?? {};
    applyVisual({
      theme: String(ui.theme ?? THEME_VALUES[0]),
      accent: String(ui.accent ?? ACCENT_PRESETS[1].name),
      bgType: String(ui.bgType ?? BGTYPE_VALUES[0]),
      bgImage: String(ui.bgImage ?? ""), // 8.7.22：弹窗首屏也带底图
    });
    initThemeFollow();
  });
  window.nahida.ui.onThemeChanged((patch) => {
    applyVisual(patch);
    initThemeFollow();
  });
}

initThemeSync();