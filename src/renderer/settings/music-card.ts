// 9.x：设置页「音乐」组 —— 网易云连接卡 + 听歌卡（每日推荐 / 搜索 / 播放）。
// 独立渲染、不走 SETTINGS_GROUPS 通用渲染：登录流程与卡片列表都是异步 IPC（同 3.7 / 4.2 的口径）。
// 真相全在主进程 MusicService：本文件只做 快照 → 视图态（deriveNeteaseViewState）→ DOM 投影，
// 卡片数据一律过 normalizeMusicCardData 再上屏。不写 localStorage，不自己轮询 —— 登录进度靠主进程广播。

import { deriveNeteaseViewState, type MusicStatusSnapshot, type NeteaseViewState } from "../../shared/music-view-state";
import { normalizeMusicCardData, type MusicCardTrack } from "../../shared/music-card";

// ---------- 小工具 ----------

/** HTML 转义（设置页数据全是远端歌名/昵称，必须过这层再进 innerHTML） */
function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/** 远端封面/头像 URL 兜底：空值 / 非 http(s) 直接不给 src，防 javascript: 注入 */
function safeUrl(u: unknown): string {
  const s = String(u ?? "");
  return /^https?:\/\//.test(s) ? s : "";
}

// ---------- 视图态 → 文案（连接卡唯一事实，DOM 与逻辑分离） ----------

const VIEW_STATE_TEXT: Record<NeteaseViewState, { dot: string; title: string; desc: string; action: string | null }> = {
  backend_starting:          { dot: "warn",  title: "音乐后端启动中",   desc: "正在拉起本地云音乐服务，几秒后自动就绪。", action: null },
  backend_error:             { dot: "err",   title: "音乐后端不可用",   desc: "本地云音乐服务启动失败，请查看应用日志后重启应用。", action: "重试" },
  signed_out:                { dot: "off",   title: "尚未连接",         desc: "连接后可获取每日推荐、搜索并播放歌曲。", action: "连接网易云" },
  creating_qr:               { dot: "warn",  title: "正在生成二维码",   desc: "请稍候……", action: "取消" },
  waiting_scan:              { dot: "warn",  title: "等待扫码",         desc: "用网易云音乐 App 扫描二维码完成登录。", action: "取消" },
  waiting_confirm:           { dot: "warn",  title: "等待确认",         desc: "已在 App 中检测到扫码，请在手机上确认登录。", action: "取消" },
  login_expired:             { dot: "err",   title: "二维码已过期",     desc: "二维码超过有效期，请重新生成。", action: "重新生成" },
  login_failed:              { dot: "err",   title: "登录失败",         desc: "登录流程出错，可重试。", action: "重新连接" },
  connected:                 { dot: "ok",    title: "已连接",           desc: "搜索和播放都会通过网易云音乐桌面客户端完成。", action: "断开" },
  connected_without_client:  { dot: "warn",  title: "已连接（未检测到客户端）", desc: "播放时会退回浏览器打开，建议安装网易云音乐客户端获得完整体验。", action: "断开" },
};

// ---------- HTML ----------

const MUSIC_NOTE_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;

export function musicCardHtml(): string {
  return `
  <section class="settings-card" id="music-connect-card">
    <h3 class="settings-card__title">${MUSIC_NOTE_SVG}网易云音乐</h3>
    <div class="music-status">
      <span class="music-status__dot" id="music-dot"></span>
      <div class="music-status__meta">
        <strong id="music-state-title">读取中…</strong>
        <p id="music-state-desc"></p>
        <p class="music-status__nick" id="music-nick" hidden></p>
      </div>
      <button type="button" class="btn-soft" id="music-action" hidden></button>
    </div>
    <div class="music-qr" id="music-qr" hidden>
      <img class="music-qr__img" id="music-qr-img" alt="网易云音乐登录二维码" />
      <div class="music-qr__meta">
        <strong>网易云音乐 App 扫码</strong>
        <p>二维码仅在本机生成，不会上传。</p>
      </div>
    </div>
  </section>
  <section class="settings-card" id="music-library-card">
    <h3 class="settings-card__title">${MUSIC_NOTE_SVG}每日推荐</h3>
    <div class="music-list" id="music-daily"><p class="settings-note">连接后显示今日推荐。</p></div>
    <h3 class="settings-card__title music-search-title">${MUSIC_NOTE_SVG}搜索</h3>
    <div class="music-search">
      <input type="text" id="music-search-input" placeholder="歌名 / 歌手，回车搜索" autocomplete="off" spellcheck="false" />
      <button type="button" class="btn-soft" id="music-search-btn">搜索</button>
    </div>
    <div class="music-list" id="music-results"></div>
    <p class="music-feedback" id="music-feedback"></p>
  </section>`;
}

// ---------- 初始化与接线 ----------

let wired = false;          // 全局订阅只挂一次；组未挂载时回调自行跳过
let busy = false;           // 搜索/推荐请求进行中标记（防抖，同组内互斥）

/** 歌曲行（卡片数据已 normalize，直接投影） */
function trackRowHtml(t: MusicCardTrack): string {
  const cover = safeUrl(t.coverUrl);
  const coverHtml = cover
    ? `<img class="music-track__cover" src="${esc(cover)}" alt="" loading="lazy" />`
    : `<span class="music-track__cover music-track__cover--ph"></span>`;
  return `
  <div class="music-track" data-track-id="${esc(t.id)}">
    ${coverHtml}
    <div class="music-track__meta">
      <strong title="${esc(t.name)}">${esc(t.name)}</strong>
      <span>${esc(t.artists.join("、"))}${t.album ? ` · ${esc(t.album)}` : ""}</span>
    </div>
    <button type="button" class="btn-soft" data-music-play="${esc(t.id)}">播放</button>
  </div>`;
}

/** 反馈行：一次性消息（播放结果 / 错误码），3 秒后自动清空 */
function feedback(msg: string): void {
  const el = document.getElementById("music-feedback");
  if (!el) return;
  el.textContent = msg;
  window.setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 3000);
}

/** 连接卡投影：快照 → 视图态 → 文案 / 点色 / 按钮 */
function renderConnectCard(snapshot: MusicStatusSnapshot): void {
  const view = deriveNeteaseViewState(snapshot);
  const text = VIEW_STATE_TEXT[view];
  const dot = document.getElementById("music-dot");
  const title = document.getElementById("music-state-title");
  const desc = document.getElementById("music-state-desc");
  const nick = document.getElementById("music-nick");
  const action = document.getElementById("music-action");
  const qr = document.getElementById("music-qr");
  if (!dot || !title || !desc || !action || !qr) return; // 组没挂载

  dot.dataset.state = text.dot;
  title.textContent = text.title;
  desc.textContent = text.desc;
  if (nick) {
    const name = snapshot.profile?.nickname ?? "";
    nick.textContent = name ? `已登录：${name}` : "";
    nick.hidden = !name;
  }
  action.textContent = text.action ?? "";
  action.hidden = !text.action;
  action.dataset.view = view; // 点击处理按视图态分派
  const inQrFlow = view === "creating_qr" || view === "waiting_scan" || view === "waiting_confirm";
  qr.hidden = !inQrFlow;
  // 二维码内容随快照走：登录中每次投影都重画（重挂载/切组回来/恢复默认后都能恢复显示）
  if (inQrFlow && snapshot.qrContent) void renderQr(snapshot.qrContent);
}

/** 二维码投影：qrContent 文本 → 本地 canvas 生成（无网络请求）。qrcode 包的浏览器入口 */
async function renderQr(qrContent: string): Promise<void> {
  const img = document.getElementById("music-qr-img") as HTMLImageElement | null;
  if (!img) return;
  try {
    const mod = await import("qrcode/lib/browser") as { default: { toDataURL(text: string): Promise<string> } };
    img.src = await mod.default.toDataURL(qrContent);
  } catch {
    img.removeAttribute("src"); // 生成失败留空 alt 展示，不阻塞登录流程（扫码也可走手机 App 的历史会话）
  }
}

/** 听歌区：登录后才拉数据；未登录/后端不可用直接占位 */
async function renderLibrary(snapshot: MusicStatusSnapshot): Promise<void> {
  const view = deriveNeteaseViewState(snapshot);
  const daily = document.getElementById("music-daily");
  if (!daily) return;
  if (view !== "connected" && view !== "connected_without_client") {
    daily.innerHTML = `<p class="settings-note">连接后显示今日推荐。</p>`;
    return;
  }
  if (busy) return;
  busy = true;
  daily.innerHTML = `<p class="settings-note">加载中…</p>`;
  const res = await window.nahida.music.getDaily();
  busy = false;
  if (!res.ok || !res.data) {
    daily.innerHTML = `<p class="settings-note">${res.ok ? "今日暂无推荐。" : `推荐获取失败（${esc(res.errorCode)}）`}</p>`;
    return;
  }
  const card = normalizeMusicCardData(res.data);
  if (!card || card.tracks.length === 0) {
    daily.innerHTML = `<p class="settings-note">今日暂无推荐。</p>`;
    return;
  }
  daily.innerHTML = card.tracks.map(trackRowHtml).join("");
}

export function initMusicCard(): void {
  // 全局状态推送：只订阅一次；回调时组可能已被切走（DOM 不存在则跳过）
  if (!wired) {
    wired = true;
    window.nahida.music.onStateChanged((snapshot) => {
      renderConnectCard(snapshot);
      void renderLibrary(snapshot);
    });
  }

  // 首屏：拉一次快照驱动全部渲染
  void window.nahida.music.getStatus().then((res) => {
    if (!res.ok) return;
    renderConnectCard(res.data);
    void renderLibrary(res.data);
  });

  // 连接卡按钮：按当前视图态分派动作
  document.getElementById("music-action")?.addEventListener("click", async () => {
    const btn = document.getElementById("music-action");
    const view = btn?.dataset.view;
    if (view === "signed_out" || view === "login_expired" || view === "login_failed" || view === "backend_error") {
      const res = await window.nahida.music.beginLogin();
      if (!res.ok) { feedback(`发起登录失败（${res.errorCode}）`); return; }
      // 成功后不再在这里画码：主进程 beginLogin 会立即广播带 qrContent 的快照，renderConnectCard 统一投影
      return;
    }
    if (view === "creating_qr" || view === "waiting_scan" || view === "waiting_confirm") {
      await window.nahida.music.cancelLogin();
      return;
    }
    if (view === "connected" || view === "connected_without_client") {
      const res = await window.nahida.music.logout();
      if (!res.ok) feedback(`断开失败（${res.errorCode}）`);
      return;
    }
  });
}

// ---------- 搜索与播放（事件委托挂 document 一次性接好，随 DOM 重建自动生效） ----------

if (typeof document !== "undefined" && !("musicSearchWired" in window)) {
  (window as unknown as Record<string, unknown>).musicSearchWired = true;

  // 搜索：按钮 / 回车
  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    const searchBtn = target.closest("#music-search-btn");
    if (searchBtn) { void runSearch(); return; }

    // 播放按钮（推荐列表与搜索结果共用）
    const playBtn = target.closest<HTMLElement>("[data-music-play]");
    if (playBtn) { void playTrack(playBtn.dataset.musicPlay ?? ""); return; }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const input = e.target as HTMLElement;
    if (input.id === "music-search-input") { void runSearch(); }
  });
}

async function runSearch(): Promise<void> {
  const input = document.getElementById("music-search-input") as HTMLInputElement | null;
  const results = document.getElementById("music-results");
  if (!input || !results || busy) return;
  const keyword = input.value.trim();
  if (!keyword) return;
  busy = true;
  results.innerHTML = `<p class="settings-note">搜索中…</p>`;
  const res = await window.nahida.music.search(keyword);
  busy = false;
  if (!res.ok) {
    results.innerHTML = `<p class="settings-note">搜索失败（${esc(res.errorCode)}）</p>`;
    return;
  }
  const card = normalizeMusicCardData(res.data);
  if (!card || card.tracks.length === 0) {
    results.innerHTML = `<p class="settings-note">没有找到相关歌曲。</p>`;
    return;
  }
  results.innerHTML = card.tracks.map(trackRowHtml).join("");
}

async function playTrack(trackId: string): Promise<void> {
  if (!trackId) return;
  const res = await window.nahida.music.playTrack(trackId);
  if (!res.ok) { feedback(`播放失败（${res.errorCode}）`); return; }
  switch (res.data.state) {
    case "dispatched": feedback("已唤起网易云音乐客户端播放"); break;
    case "web_fallback": feedback("未检测到客户端，已在浏览器打开"); break;
    case "client_unavailable": feedback("未安装网易云音乐客户端，可在官网下载后重试"); break;
    default: feedback(`播放失败（${res.data.errorCode ?? "unknown"}）`);
  }
}
