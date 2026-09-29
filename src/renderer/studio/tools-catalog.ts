// 8.7.5：工具箱 · MCP 目录 —— 不内置任何硬编码示例，只动态展示用户在「设置 → MCP」里配置的服务
// 配置存 config.json 的 mcp.servers，主进程 mcp:list 返回脱敏的 McpServerView；空配置显示引导空态
import type { ToolboxOpenPayload } from "../../shared/toolbox";
import type { McpServerView } from "../../shared/mcp";
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const mcpGrid = document.getElementById("tools-mcp-grid");

function mcpServerCard(s: McpServerView): string {
  const conn = s.connected ? "已连接" : "未连接";
  return `<article class="tool-card" data-mcp="${esc(s.id)}">
    <div class="tool-card__head">
      <span class="tool-card__icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="14" x="2" y="6" rx="2"/><path d="M9 22h6"/><path d="M12 20v-6"/><path d="M8 11h.01"/><path d="M16 11h.01"/><path d="M12 11h.01"/></svg>
      </span>
      <h3 class="tool-card__title">${esc(s.name)}</h3>
    </div>
    <p class="tool-card__desc">${esc(s.transportLabel)} · ${esc(s.riskLabel)} · ${s.toolCount} 个工具${s.lastError ? `；${esc(s.lastError)}` : ""}</p>
    <button type="button" class="btn-soft" disabled>${conn}</button>
  </article>`;
}

async function loadMcpCards(): Promise<void> {
  if (!mcpGrid) return;
  let servers: McpServerView[] = [];
  try { servers = await window.nahida.mcp.list(); } catch { servers = []; }
  mcpGrid.innerHTML = servers.length
    ? servers.map(mcpServerCard).join("")
    : `<p class="tools-none">尚未配置 MCP 服务：到「设置 → MCP」添加后，这里会显示它的状态。</p>`;
}
void loadMcpCards();

// ===== 8.7.6：插件目录数据 + 卡片渲染（渲染进 #tools-plugin-grid） =====
// kind：launcher = 官方/外部现成程序，选目录后拉起；self = 本应用自研 UI 窗口承载
interface PluginEntry {
  id: string;
  name: string;
  source: string; // 出处 / 创作者
  desc: string;
  kind: "launcher" | "self";
  icon: string;
}

const PLUGIN_TOOLS: PluginEntry[] = [
  { id: "calendar", name: "日历", source: "本应用自研", kind: "self",
    desc: "日程安排与纪念日提醒，和她的日常联动。",
    icon: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>' },
  { id: "clipboard", name: "剪切板", source: "本应用自研", kind: "self",
    desc: "剪贴板历史 / 置顶 / 检索，写长文不丢内容。",
    icon: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>' },
  { id: "note", name: "便签", source: "本应用自研", kind: "self",
    desc: "随手记事的可视化便签板，灵感不丢失。",
    icon: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5z"/><path d="M15 3v6h6"/>' },
  { id: "pomodoro", name: "番茄钟", source: "本应用自研", kind: "self",
    desc: "专注计时，配合她一起安排休息节奏。",
    icon: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>' },
  { id: "img-convert", name: "图片格式转换", source: "本应用自研", kind: "self",
    desc: "jpg / png / webp / gif 互转，不改原图直接导出。",
    icon: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>' },
  { id: "music-convert", name: "音乐格式转换", source: "本应用自研", kind: "self",
    desc: "mp3 / flac / aac 互转，压缩体积也能保音质。",
    icon: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>' },
  { id: "video-convert", name: "视频格式转换", source: "本应用自研", kind: "self",
    desc: "mp4 / webm / mkv 互转，批量处理。",
    icon: '<path d="M20.2 6 3 11l-.9-2.4c-.3-1.1.3-2.2 1.3-2.5l13.5-4c1.1-.3 2.2.3 2.5 1.3Z"/><path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/><path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>' },
  { id: "pdf-tool", name: "PDF 合并 / 拆分", source: "本应用自研", kind: "self",
    desc: "把多份 PDF 合成一份，或抽出需要的页面。",
    icon: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>' },
  { id: "rename", name: "批量重命名", source: "本应用自研", kind: "self",
    desc: "按规则批量改文件名，一次整理一整批。",
    icon: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>' },
  { id: "convert", name: "单位 / 汇率 / 时区换算", source: "本应用自研", kind: "self",
    desc: "长度、重量、汇率、时区，常用换算一把抓。",
    icon: '<line x1="19" x2="5" y1="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>' },
  { id: "qrcode", name: "二维码生成", source: "本应用自研", kind: "self",
    desc: "文本 / 链接生成二维码，手机一扫直达。",
    icon: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3"/><path d="M21 21v.01"/><path d="M12 7v3a2 2 0 0 1-2 2H7"/><path d="M3 12h.01"/><path d="M12 3h.01"/><path d="M12 16v.01"/><path d="M16 12h1"/><path d="M21 12v.01"/><path d="M12 21v-1"/>' },
  { id: "rss", name: "RSS 阅读器", source: "本应用自研", kind: "self",
    desc: "订阅网站更新，她帮你汇总最新内容。",
    icon: '<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>' },
];

function pluginCard(p: PluginEntry): string {
  const action = p.kind === "launcher" ? "选择目录并打开" : "打开";
  return `<article class="tool-card" data-plugin="${p.id}">
    <div class="tool-card__head">
      <span class="tool-card__icon" aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${p.icon}</svg>
      </span>
      <h3 class="tool-card__title">${p.name}</h3>
    </div>
    <p class="tool-card__desc">${p.desc}</p>
    <button type="button" class="btn-soft" data-plugin-open="${p.id}">${action}</button>
  </article>`;
}

const pluginGrid = document.getElementById("tools-plugin-grid");
if (pluginGrid) {
  pluginGrid.innerHTML = PLUGIN_TOOLS.map(pluginCard).join("");
}

// ===== 8.7.7：卡片「打开」接线 → 主进程弹/聚焦工具独立子窗 =====
// launcher 打开前先选目录（复用 fs:pick-dir，只弹框返回路径）；self 直接打开。
// MCP 卡车仅作状态展示（无打开动作），因此这里只接线插件目录。
function openTool(payload: ToolboxOpenPayload): void {
  window.nahida.toolbox.open(payload);
}

pluginGrid?.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-plugin-open]");
  if (!btn) return;
  const id = btn.dataset.pluginOpen ?? "";
  const entry = PLUGIN_TOOLS.find((p) => p.id === id);
  if (!entry) return;
  const open = (hint?: string): void =>
    openTool({ id: entry.id, title: entry.name, sub: "", kind: entry.kind, hint }); // sub 不再传来源标（「本应用自研」已删）
  if (entry.kind === "launcher") {
    void window.nahida.fs.pickDir().then((dir) => { if (dir) open(dir); });
  } else {
    open();
  }
});