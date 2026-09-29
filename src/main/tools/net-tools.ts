// 8.12.1②：三个联网工具的执行核心 —— **纯模块：不 import electron**，vitest 可直测（同 fs-tools 范式）。
//   ① fetch_url   抓一个公网网页 → 提取正文文本（超时 / 大小上限 / 私网地址防护三重保险）
//   ② web_search  Bing 中国站免 key 搜索（HTML 解析；端点是「可用但非官方」，失败回可读提示，绝不 throw）
//   ③ deep_search 搜索 + 抓取前 N 条页面正文，拼成分段摘要
// 红线：不碰裁决 —— risk=network 走 shared/tools 现有 policyFor 档位表；本文件只管「怎么做、做不成怎么说话」。
// 惯例：绝不 throw —— 失败一律回 `[错误]…` 字符串（模型可读、可据此换路）。

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) nahida-agent/0.1";
const FETCH_TIMEOUT_MS = 15_000; // 单页超时
const MAX_BYTES = 512 * 1024; // 单页原始字节上限（超了就截断停止接收）
const MAX_TEXT_CHARS = 6_000; // fetch_url 返回正文上限
const DEEP_PAGE_CHARS = 2_500; // deep_search 每页正文截断
const DEEP_MAX_PAGES = 5; // deep_search 最多抓几页

// ─── 防护：私网地址 / 非法 scheme（SSRF 最低防护面） ─────────────────────────────

/** 解析出合法的公网 http/https 网址；不合法 / 指向私网 / 回环则回 null（调用方给可读错误）。
 *  说明：只挡「URL 字面」的私网与回环（localhost / 127.x / 10.x / 192.168.x / 172.16-31.x /
 *  169.254.x / 0.x / IPv6 回环与 fc00-fe80 段 / *.local）；不做 DNS rebinding 防护（超出本步范围）。 */
export function isPublicHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, ""); // 去结尾点（FQDN 写法）
  if (!host) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
  if (host.includes(":")) {
    // IPv6 字面量（WHATWG URL 的 hostname 保留方括号，先去掉再判）：回环 / 未指定 / ULA fc00::/7 / 链路本地 fe80::/10 一律拒绝
    const bare = host.replace(/^\[/, "").replace(/\]$/, "");
    if (/^(::1$|::$|::|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(bare)) return null;
    return s;
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const o = m.slice(1).map(Number);
    if (o.some((x) => x > 255)) return null; // 非法 IPv4
    const [a, b] = o;
    if (a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return null;
  }
  return s;
}

// ─── 取网页 + 提取正文 ──────────────────────────────────────────────────────────

/** 常见命名实体表（decodeEntities 用；显式 Record 以过 noImplicitAny） */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", mdash: "—", ndash: "–", middot: "·",
  hellip: "…", laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  ensp: " ", emsp: " ", thinsp: " ",
};

/** 常见命名实体 + 数字实体；其余原样保留（正文可读性足够） */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&(amp|lt|gt|quot|apos|mdash|ndash|middot|hellip|laquo|raquo|ldquo|rdquo|lsquo|rsquo|ensp|emsp|thinsp);/gi,
      (_, n) => NAMED_ENTITIES[String(n).toLowerCase()] ?? `&${n};`);
}

/** HTML → 纯文本：去 script/style/注释、块级标签换行、剥标签、解码实体、压空白 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote)>/gi, "\n")
    .replace(/<br[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .trim()
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => decodeEntities(line).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

interface FetchOk { ok: true; text: string; finalUrl: string }
interface FetchFail { ok: false; error: string }

/** 抓 URL：超时 / 大小上限 / 字符集嗅探（content-type 的 charset，GBK 页面也尽力）。
 *  用流式读取到 MAX_BYTES 就 cancel —— 不让大文件把内存吃满。 */
async function fetchText(url: string): Promise<FetchOk | FetchFail> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const m = (res.headers.get("content-type") ?? "").match(/charset=([\w-]+)/i);
    const decoder = (() => {
      try {
        return new TextDecoder(m?.[1] ?? "utf-8");
      } catch {
        return new TextDecoder("utf-8"); // 非法 charset 名兜底
      }
    })();
    const reader = res.body?.getReader();
    if (!reader) return { ok: false, error: "响应没有内容" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= MAX_BYTES) { void reader.cancel().catch(() => undefined); break; }
      }
    }
    // TextDecoder 以 stream 模式逐块喂 —— 跨块的 UTF-8/GBK 多字节序列由它内部缓冲，无需手工拼尾巴
    let text = "";
    for (const c of chunks) text += decoder.decode(c, { stream: true });
    text += decoder.decode(); // 冲掉尾部残留
    return { ok: true, text, finalUrl: res.url || url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Bing 免 key 搜索（HTML 解析；「可用但非官方」—— 结构变了就优雅降级） ───────────

export interface SearchHit { title: string; url: string; snippet: string }

/** 解析 Bing 结果页里的 b_algo 块 → 标题 / 链接 / 摘要（纯函数，喂样本 HTML 可单测） */
export function parseBingResults(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/g) ?? [];
  for (const block of blocks) {
    const a = block.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const url = decodeEntities(a[1]);
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    const p = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    seen.add(url);
    hits.push({
      title: htmlToText(a[2]).slice(0, 120),
      url,
      snippet: p ? htmlToText(p[1]).slice(0, 220) : "",
    });
  }
  return hits;
}

// ─── 三个工具入口（对应 builtin-tools 注册的 execute；args 由调用方传） ─────────────

/** fetch_url：抓公网网页 → 正文文本 */
export async function fetchUrlTool(rawUrl: unknown): Promise<string> {
  const url = isPublicHttpUrl(rawUrl);
  if (!url) return "[错误] 拒绝访问：只允许公网 http/https 网址（本机、内网与其它协议一律不抓）。";
  const r = await fetchText(url);
  if (!r.ok) return `[错误] 抓取失败：${r.error}`;
  const body = htmlToText(r.text);
  if (!body) return "[错误] 页面没有可提取的文本（可能是纯脚本渲染或二进制内容）。";
  const head = `[来源] ${r.finalUrl}\n\n`;
  return body.length > MAX_TEXT_CHARS ? head + body.slice(0, MAX_TEXT_CHARS) + `\n\n（正文过长，已截断到前 ${MAX_TEXT_CHARS} 字）` : head + body;
}

/** web_search：Bing 免 key 搜索，返回「标题 / 链接 / 摘要」列表 */
export async function webSearchTool(rawQuery: unknown, rawCount: unknown): Promise<string> {
  const q = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (!q) return "[错误] 搜索词是空的。";
  const count = Math.min(Math.max(Number(rawCount) || 5, 1), 10);
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`;
  const r = await fetchText(url);
  if (!r.ok) return `[错误] 搜索失败：${r.error}`;
  const hits = parseBingResults(r.text).slice(0, count);
  if (hits.length === 0) {
    return "[错误] 搜索没有返回结果（搜索站页面结构可能变了，属非官方接口）；可稍后重试，或用 fetch_url 直接打开已知网址。";
  }
  return `搜索「${q}」共 ${hits.length} 条：\n\n` + hits
    .map((h, i) => `${i + 1}. ${h.title}\n   链接：${h.url}\n   摘要：${h.snippet || "（无摘要）"}`)
    .join("\n\n");
}

/** deep_search：搜索 + 抓前 N 条页面正文，拼分段摘要（比 web_search 慢，但给模型更多可用素材） */
export async function deepSearchTool(rawQuery: unknown, rawPages: unknown): Promise<string> {
  const q = typeof rawQuery === "string" ? rawQuery.trim() : "";
  if (!q) return "[错误] 搜索词是空的。";
  const pages = Math.min(Math.max(Number(rawPages) || 3, 1), DEEP_MAX_PAGES);
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`;
  const r = await fetchText(url);
  if (!r.ok) return `[错误] 搜索失败：${r.error}`;
  const hits = parseBingResults(r.text).slice(0, pages);
  if (hits.length === 0) {
    return "[错误] 搜索没有返回结果（搜索站页面结构可能变了，属非官方接口）；可稍后重试，或用 fetch_url 直接打开已知网址。";
  }
  const sections = await Promise.all(hits.map(async (h, i) => {
    const page = await fetchText(h.url);
    if (!page.ok) return `【${i + 1}】${h.title}\n来源：${h.url}\n（正文抓取失败：${page.error}；摘要：${h.snippet || "无"}）`;
    const body = htmlToText(page.text).slice(0, DEEP_PAGE_CHARS);
    const text = body || h.snippet || "（页面没有可提取的文本）";
    return `【${i + 1}】${h.title}\n来源：${h.url}\n${text}${body.length >= DEEP_PAGE_CHARS ? `\n（正文过长，已截断到前 ${DEEP_PAGE_CHARS} 字）` : ""}`;
  }));
  return `深度搜索「${q}」—— 已读取前 ${hits.length} 条结果的页面正文：\n\n${sections.join("\n\n———\n\n")}`;
}
