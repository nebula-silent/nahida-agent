// 8.2 新增：三个 fs 工具的执行核心（read_file / write_file / list_dir）
// 8.2.1 新增：edit_file / glob / grep（补齐 8.2 清单 D 声明的三个工具，同在本文件）
// 依据：内部规格 §1.3；内部规格
// 规矩（对齐 path-guard / audit / long-term-tools）：
//   ① **顶层不 import electron** —— allowedDirs 由调用方（builtin-tools，读 config）注入，vitest 能直接 import；
//   ② 只返回文本、**绝不 throw**（出错也返回 `[错误]…`，与 write_note / remember_long_term 同形）；
//   ③ 每条路径先过 isAllowedPath（白名单 + 敏感区），不过绝不读写 —— 本模块没有任意路径口子；
//   ④ 本模块**不删文件、不执行命令、不联网**（glob/grep 走 node 原生递归，**不经 shell**，防命令注入）；
//   ⑤ 拒绝理由不回显原文路径（指令 §1.3）。
import * as fs from "fs";
import * as path from "path";
import { isAllowedPath } from "./path-guard";

/** 单次读取上限：超过就让模型改用搜索 / 分段，别把大文件灌进上下文 */
export const FS_READ_MAX_BYTES = 200 * 1024;
/** list_dir 单次最多列多少条（防超长目录刷屏） */
export const FS_LIST_MAX_ENTRIES = 200;

// ============================================================
// 9.1 新增：当前对话绑定的目录（聊天视图头选择；新对话 / 未选择 = 空串）。
//   - 状态放本模块（不 import electron，vitest 直接 import 同 shell-tool 的 setShellCwdAllowance 范式）；
//   - 由 chats-store 的 set-work-dir handler 同步（空对话暂存 / 读档回填 / 新对话清空都走它）；
//   - builtin-tools 拼 allowedDirs 时并入（mergeChatWorkDir），**不动 config.allowedDirs 全局白名单** ——
//     所以新对话清空后权限自动回落，天然满足「新建对话恢复未选择状态」。
// ============================================================

let chatWorkDir = "";

/** 同步当前对话目录（空串 = 清除 / 未选择）。只存内存，落盘归 chats-store */
export function setChatWorkDir(dir: string): void {
  chatWorkDir = typeof dir === "string" ? dir.trim() : "";
}

/** 读当前对话目录（测试用） */
export function getChatWorkDir(): string {
  return chatWorkDir;
}

/** 白名单并集（纯函数）：config.allowedDirs ∪ 当前对话目录（已在不缺省、按 Windows 口径判重）。 */
export function mergeChatWorkDir(dirs: string[], chatDir: string): string[] {
  const base = Array.isArray(dirs) ? dirs : [];
  const cur = typeof chatDir === "string" ? chatDir.trim() : "";
  if (cur === "" || base.some((d) => d.toLowerCase() === cur.toLowerCase())) return base;
  return [...base, cur];
}

/** 可写扩展名**正向白名单**：不在表内一律拒 —— .exe/.dll/.sh/.bat/.ps1 这类可执行文件天然写不进去 */
export const FS_WRITABLE_EXTS = [
  ".md", ".txt", ".json", ".js", ".ts", ".tsx", ".jsx", ".css", ".html",
  ".py", ".csv", ".log", ".yml", ".yaml", ".xml", ".ini", ".toml",
];
const WRITABLE_EXT_SET = new Set(FS_WRITABLE_EXTS);

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (x: number): string => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 拒绝理由去路径（§1.3「不回原文路径」）：删掉理由里回显的目标路径，只留原因本身 */
function denyText(reason: string | undefined, rawPath: string): string {
  let text = reason && reason.trim() !== "" ? reason : "该路径不允许访问。";
  const raw = rawPath.trim();
  for (const p of [raw, raw ? path.resolve(raw) : ""]) {
    if (p) text = text.split(p).join("");
  }
  return `[错误] ${text.replace(/[：:]\s*$/, "").trim()}`;
}

/** 三道校验的唯一入口：白名单 + 敏感区（isAllowedPath 内部先过敏感区） */
function guard(
  rawPath: unknown,
  allowedDirs: string[],
): { ok: true; abs: string } | { ok: false; text: string } {
  const raw = typeof rawPath === "string" ? rawPath.trim() : "";
  const verdict = isAllowedPath(raw, allowedDirs);
  if (!verdict.allowed) return { ok: false, text: denyText(verdict.reason, raw) };
  return { ok: true, abs: path.resolve(raw) };
}

/** read_file：读允许目录内的文本文件。二进制 / 超大 / 目录都给人话兜底，不抛 */
export function readFileTool(rawPath: unknown, allowedDirs: string[]): string {
  const g = guard(rawPath, allowedDirs);
  if (!g.ok) return g.text;

  let st: fs.Stats;
  try {
    st = fs.statSync(g.abs);
  } catch {
    return "[错误] 读不到这个文件（不存在或没有权限）。";
  }
  if (st.isDirectory()) return "[错误] 这是一个目录，看目录内容请用 list_dir。";
  if (st.size > FS_READ_MAX_BYTES) {
    return `[错误] 文件太大（${Math.ceil(st.size / 1024)} KB，单次上限 ${FS_READ_MAX_BYTES / 1024} KB），请改用搜索或分段读取。`;
  }
  try {
    const buf = fs.readFileSync(g.abs);
    if (buf.includes(0)) return "[错误] 这看起来是二进制文件，读不出文本内容。";
    return buf.toString("utf8");
  } catch {
    return "[错误] 读取失败（文件被占用或没有权限）。";
  }
}

/** write_file：覆盖写允许目录内的文本文件。写前自动备份 .bak + .tmp 原子替换 */
export function writeFileTool(rawPath: unknown, rawContent: unknown, allowedDirs: string[]): string {
  const g = guard(rawPath, allowedDirs);
  if (!g.ok) return g.text;

  const content = typeof rawContent === "string" ? rawContent : "";
  if (content === "") return "[错误] 内容为空，没有写入。";

  let existed = false;
  try {
    if (fs.existsSync(g.abs)) {
      if (fs.statSync(g.abs).isDirectory()) return "[错误] 目标是一个目录，不能当文件写。";
      existed = true;
    }
  } catch {
    return "[错误] 无法确认目标文件状态（没有权限）。";
  }

  // 正向白名单：不在表内一律拒（.exe/.sh/.bat/.ps1 等可执行文件天然写不进去）
  const ext = path.extname(g.abs).toLowerCase();
  if (!WRITABLE_EXT_SET.has(ext)) {
    return `[错误] 不允许写「${ext || "无扩展名"}」这类文件。可写类型：${FS_WRITABLE_EXTS.join(" ")}；要写可执行文件请改用命令工具并单独审批。`;
  }

  try {
    fs.mkdirSync(path.dirname(g.abs), { recursive: true });
    // 覆盖写前自动备份原文件（用户偏好：改前先备份）；本工具不自动删除任何文件
    if (existed) fs.copyFileSync(g.abs, `${g.abs}.bak`);
    // 原子写：同目录 .tmp + rename（同 storage/json-file.ts 的范式，写一半崩了也不会留半个文件）
    const tmp = `${g.abs}.tmp`;
    fs.writeFileSync(tmp, content, "utf8");
    fs.renameSync(tmp, g.abs);
  } catch (err) {
    return `[错误] 写入失败：${err instanceof Error ? err.message : String(err)}`;
  }
  const name = path.basename(g.abs);
  return existed
    ? `已覆盖写入 ${name}（${content.length} 字），原内容已备份为 ${name}.bak。`
    : `已写入 ${name}（${content.length} 字）。`;
}

/** list_dir：列允许目录下的一级条目（名 / 类型 / 大小 / 修改时间），不递归 */
export function listDirTool(rawPath: unknown, allowedDirs: string[]): string {
  const g = guard(rawPath, allowedDirs);
  if (!g.ok) return g.text;

  let st: fs.Stats;
  try {
    st = fs.statSync(g.abs);
  } catch {
    return "[错误] 读不到这个目录（不存在或没有权限）。";
  }
  if (!st.isDirectory()) return "[错误] 这不是一个目录，读文件请用 read_file。";

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(g.abs, { withFileTypes: true });
  } catch {
    return "[错误] 目录读取失败（没有权限）。";
  }
  if (entries.length === 0) return "这是一个空目录。";

  const rows = entries.slice(0, FS_LIST_MAX_ENTRIES).map((e) => {
    const isDir = e.isDirectory();
    let size = 0;
    let mtime = 0;
    try {
      const s = fs.statSync(path.join(g.abs, e.name));
      size = s.size;
      mtime = s.mtimeMs;
    } catch {
      /* 单项读不到就留 0（不因为一个坏条目丢掉整个列表） */
    }
    return { isDir, name: e.name, size, mtime };
  });
  rows.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, "zh-CN") : a.isDir ? -1 : 1));

  const head = `${g.abs} 下共 ${entries.length} 项${entries.length > rows.length ? `（只列前 ${rows.length} 项）` : ""}：`;
  const lines = rows.map((r) =>
    r.isDir ? `- [目录] ${r.name}` : `- [文件] ${r.name} · ${formatBytes(r.size)} · ${formatTime(r.mtime)}`,
  );
  return [head, ...lines].join("\n");
}

// ============================================================
// 8.2.1 新增：edit_file / glob / grep（补齐 8.2 清单 D 声明的三个工具）
//   - edit_file：先读后写门禁（old 找不到绝不写）+ .bak 备份 + .tmp 原子替换，全同 write_file 范式；
//   - glob / grep：node 原生递归实现 —— **不经 shell、不拼命令串**（红线 §1.4，防命令注入），不引第三方依赖。
// ============================================================

/** glob/grep 递归遍历时的忽略目录名（依赖树与版本库体积巨大且与用户文件无关） */
const WALK_SKIP_DIRS = new Set(["node_modules", ".git"]);
/** 单轮遍历的文件数上限（防超大目录树拖垮一轮对话；宁少勿爆） */
const WALK_MAX_FILES = 2000;
/** glob 单次最多返回的条数 */
export const FS_GLOB_MAX_RESULTS = 100;
/** grep 单次最多返回的命中行数 */
export const FS_GREP_MAX_MATCHES = 50;
/** grep 单行展示上限（超长行截断，防刷屏） */
const GREP_LINE_MAX_CHARS = 200;

/** 递归收集 abs 下的普通文件（跳过符号链接防逃逸、跳过 node_modules/.git；超上限即停） */
function walkFiles(abs: string, out: string[] = []): string[] {
  if (out.length >= WALK_MAX_FILES) return out;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out; // 读不到的目录静默跳过（大方向安全已由守卫层保证）
  }
  for (const e of entries) {
    if (out.length >= WALK_MAX_FILES) return out;
    const full = path.join(abs, e.name);
    if (e.isSymbolicLink()) continue; // 符号链接不跟进（逃逸面），glob 结果层还会逐条复验
    if (e.isDirectory()) {
      if (!WALK_SKIP_DIRS.has(e.name)) walkFiles(full, out);
      continue;
    }
    if (e.isFile()) out.push(full);
  }
  return out;
}

/** mini-glob → RegExp：支持 **（跨目录）/ *（段内任意）/ ?（单字符），其余字符按字面。
 *  双星号加反斜杠分隔符（即 `**` 紧跟 `/`）→ 可省略的任意层级目录（照 glob 惯例，`**` 加 `/*.md` 也匹配根级 .md）；
 *  带 i 标志（Windows 文件系统大小写不敏感）。 */
function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2; // 吃掉 `*/`（连同分隔符），`**/` 已整体消费
        } else {
          re += ".*";
          i++; // 裸 `**` → 任意
        }
      } else {
        re += "[^\\\\/]*";
      }
    } else if (c === "?") {
      re += "[^\\\\/]";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`, "i");
}

/** glob/grep 的搜索范围解析：给了 baseDir 就只搜它（须过守卫且是目录），否则搜 allowedDirs 并集 */
function collectSearchRoots(
  rawBase: unknown,
  allowedDirs: string[],
): { ok: true; roots: string[] } | { ok: false; text: string } {
  if (typeof rawBase === "string" && rawBase.trim() !== "") {
    const g = guard(rawBase, allowedDirs);
    if (!g.ok) return { ok: false, text: g.text };
    let st: fs.Stats;
    try {
      st = fs.statSync(g.abs);
    } catch {
      return { ok: false, text: "[错误] 读不到这个目录（不存在或没有权限）。" };
    }
    if (!st.isDirectory()) {
      return { ok: false, text: "[错误] 搜索范围是一个文件——找文件里的内容请用 grep，读它请用 read_file。" };
    }
    return { ok: true, roots: [g.abs] };
  }
  if (allowedDirs.length === 0) {
    return { ok: false, text: "[错误] 还没有配置允许访问的目录，她目前没有任何文件访问权限。" };
  }
  return { ok: true, roots: allowedDirs.map((d) => path.resolve(d.trim())) };
}

/** edit_file：允许目录内**原地局部替换**（先读后写门禁：old 找不到绝不写；不留 old="" 全量替换旁路）。
 *  备份 .bak + .tmp 原子替换，全同 write_file 范式；全部出现处都替换，返回替换次数。 */
export function editFileTool(rawPath: unknown, oldText: unknown, newText: unknown, allowedDirs: string[]): string {
  const g = guard(rawPath, allowedDirs);
  if (!g.ok) return g.text;

  const oldStr = typeof oldText === "string" ? oldText : "";
  const newStr = typeof newText === "string" ? newText : "";
  if (oldStr === "") return "[错误] 要替换的片段（old）是空的，没有改动文件。整文覆盖请用 write_file。";
  if (oldStr === newStr) return "[错误] 替换前后的内容相同，没有改动文件。";

  let st: fs.Stats;
  try {
    st = fs.statSync(g.abs);
  } catch {
    return "[错误] 读不到这个文件（不存在或没有权限）。";
  }
  if (st.isDirectory()) return "[错误] 这是一个目录，不能当文件编辑。";
  if (st.size > FS_READ_MAX_BYTES) {
    return `[错误] 文件太大（${Math.ceil(st.size / 1024)} KB，单次上限 ${FS_READ_MAX_BYTES / 1024} KB），请改用分段处理。`;
  }
  // 可写扩展名白名单（同 write_file）：.exe/.sh/.bat 等可执行文件天然改不进去
  const ext = path.extname(g.abs).toLowerCase();
  if (!WRITABLE_EXT_SET.has(ext)) {
    return `[错误] 不允许改「${ext || "无扩展名"}」这类文件。可编辑类型：${FS_WRITABLE_EXTS.join(" ")}。`;
  }

  let original: string;
  try {
    const buf = fs.readFileSync(g.abs);
    if (buf.includes(0)) return "[错误] 这看起来是二进制文件，不能做文本替换。";
    original = buf.toString("utf8");
  } catch {
    return "[错误] 读取失败（文件被占用或没有权限）。";
  }

  // 先读后写门禁核心：按字面统计出现次数（split/join，不走正则——old 里的正则元字符也当普通字符）
  const count = original.split(oldStr).length - 1;
  if (count === 0) return "[错误] 未找到要替换的片段（原文里没有这一段），没有改动文件。";

  try {
    fs.copyFileSync(g.abs, `${g.abs}.bak`); // 写前自动备份（用户偏好：改前先备份）；本工具不自动删除任何文件
    const tmp = `${g.abs}.tmp`;
    fs.writeFileSync(tmp, original.split(oldStr).join(newStr), "utf8");
    fs.renameSync(tmp, g.abs);
  } catch (err) {
    return `[错误] 替换失败：${err instanceof Error ? err.message : String(err)}`;
  }
  return `[OK] 已替换 ${count} 处 → 文件已更新（原内容已备份为 ${path.basename(g.abs)}.bak）。`;
}

/** glob：允许目录内按通配模式找文件（node 原生递归，不经 shell）。支持 ** / * / ?。
 *  结果逐条复验 isAllowedPath，任何越界 / 符号链接逃逸的结果一律忽略（指令 §1.2）。 */
export function globTool(rawPattern: unknown, rawBaseDir: unknown, allowedDirs: string[]): string {
  const pattern = typeof rawPattern === "string" ? rawPattern.trim() : "";
  if (pattern === "") return "[错误] 匹配模式（pattern）是空的。例：**/*.md";

  const t = collectSearchRoots(rawBaseDir, allowedDirs);
  if (!t.ok) return t.text;

  let re: RegExp;
  try {
    re = globToRegExp(pattern);
  } catch (err) {
    return `[错误] 匹配模式解析失败（${err instanceof Error ? err.message : String(err)}），换个简单点的模式试试。`;
  }

  const seen = new Set<string>();
  const hits: string[] = [];
  for (const root of t.roots) {
    for (const file of walkFiles(root)) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (!re.test(rel)) continue;
      if (!isAllowedPath(file, allowedDirs).allowed) continue; // 逃逸 / 越界结果一律忽略
      const key = process.platform === "win32" ? file.toLowerCase() : file;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(file);
    }
  }
  if (hits.length === 0) return "未匹配到任何文件。";
  const shown = hits.slice(0, FS_GLOB_MAX_RESULTS);
  const head = `匹配到 ${hits.length} 个文件${hits.length > shown.length ? `（只列前 ${shown.length} 个）` : ""}：`;
  return [head, ...shown.map((f) => `- ${f}`)].join("\n");
}

/** grep：允许目录内按正则/纯文本搜文件内容，命中行 = `文件:行号: 文本`（node 原生，不经 shell）。
 *  非法正则自动退化为字面量匹配 —— `;rm` 之类只当普通字符，天然没有命令注入面（验收 §2）。
 *  范围：可传目录或单个文件（path），缺省搜 allowedDirs 并集；二进制 / 超 200KB 的文件跳过。 */
export function grepTool(rawPattern: unknown, rawSearchPath: unknown, allowedDirs: string[]): string {
  const pattern = typeof rawPattern === "string" ? rawPattern : "";
  if (pattern.trim() === "") return "[错误] 搜索关键词（pattern）是空的。";

  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }

  let files: string[];
  const raw = typeof rawSearchPath === "string" ? rawSearchPath.trim() : "";
  if (raw !== "") {
    const g = guard(raw, allowedDirs);
    if (!g.ok) return g.text;
    let st: fs.Stats;
    try {
      st = fs.statSync(g.abs);
    } catch {
      return "[错误] 读不到这个路径（不存在或没有权限）。";
    }
    if (st.isFile()) files = [g.abs];
    else if (st.isDirectory()) files = walkFiles(g.abs);
    else return "[错误] 这个路径既不是文件也不是目录。";
  } else {
    const t = collectSearchRoots("", allowedDirs);
    if (!t.ok) return t.text;
    files = t.roots.flatMap((r) => walkFiles(r));
  }

  const matches: string[] = [];
  for (const file of files) {
    if (matches.length >= FS_GREP_MAX_MATCHES) break;
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      continue;
    }
    if (size > FS_READ_MAX_BYTES) continue; // 大文件跳过（防灌爆）
    let content: string;
    try {
      const buf = fs.readFileSync(file);
      if (buf.includes(0)) continue; // 二进制跳过
      content = buf.toString("utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i]!)) continue;
      const line = lines[i]!.trim();
      matches.push(`${file}:${i + 1}: ${line.length > GREP_LINE_MAX_CHARS ? line.slice(0, GREP_LINE_MAX_CHARS) + "…" : line}`);
      if (matches.length >= FS_GREP_MAX_MATCHES) break;
    }
  }
  if (matches.length === 0) return "未找到匹配的内容。";
  return [
    `命中 ${matches.length} 行${matches.length >= FS_GREP_MAX_MATCHES ? "（已到单次上限，可能还有更多）" : ""}：`,
    ...matches,
  ].join("\n");
}
