// 8.7 新增：技能扫描器 —— userData/skills/ 下每个目录一份 SKILL.md，解析 frontmatter。
// 依据：内部规格 §1.1 / §1.4；内部规格 §1.1 / §1.3 / §1.4
// 规矩（对齐 fs-tools / vision-tools）：**顶层不 import electron** —— vitest 可直接 import；
// 畸形 SKILL.md **跳过并记账**（进 errors，不抛、不崩）；不引入第三方 frontmatter 库（自研极简解析）。
import * as fs from "fs";
import * as path from "path";
import { SKILL_FILE } from "../../shared/skill";

/** 技能声明的脚本（8.7.3）。`risk` 恒为 "shell" —— 脚本 = 执行代码，统一走 8.3 审批，
 *  **不放开更低档**（指令 §1.5）；frontmatter 里写别的值只记一条 warn，仍按 shell 处理。 */
export interface SkillScript {
  /** 技能内唯一 id（重复声明丢弃后一条） */
  id: string;
  /** 相对技能目录的脚本路径（统一 `/` 分隔，给人看 / 日志用） */
  file: string;
  /** 解析后的绝对路径（仅供自检 / 日志用）。给模型的执行指引用 cwd=技能目录 + file 相对路径（§1.3） */
  absPath: string;
  description: string;
  risk: "shell";
}

/** 扫描出的技能全文记录（正文只在本进程内流转，绝不整段进 system prompt） */
export interface SkillRecord {
  /** 技能 id = 目录名（唯一、稳定） */
  id: string;
  /** 技能目录绝对路径 */
  dir: string;
  name: string;
  description: string;
  version: string;
  author: string;
  /** frontmatter 声明的默认启用状态（用户在设置页的选择会覆盖它，见 skill-registry） */
  enabled: boolean;
  /** 依赖探针结果：frontmatter requires 声明的路径全部存在 = true */
  available: boolean;
  /** 技能捆绑的脚本（已过逃逸校验；逃逸的声明在扫描时就被丢弃） */
  scripts: SkillScript[];
  /** SKILL.md 正文 = agent 视角的提示词 / 步骤（按需经 skill(id) 交给模型） */
  body: string;
  /** 解析错误；"" = 正常（有错误的记录不会进扫描结果，只在 ScanResult.errors 里留一条） */
  error: string;
}

export interface ScanResult {
  skills: SkillRecord[];
  /** 被跳过的畸形条目（"目录名: 原因"），只用于日志 / 排查 */
  errors: string[];
}

/** 一行 `key: value` 拆成两段（键名小写、值剥引号）；不是键值行 → null */
function splitKv(line: string): [string, string] | null {
  const at = line.indexOf(":");
  if (at <= 0) return null;
  const key = line.slice(0, at).trim().toLowerCase();
  const value = line.slice(at + 1).trim().replace(/^["']|["']$/g, "");
  return key ? [key, value] : null;
}

/**
 * 极简 frontmatter 解析：文件必须以 `---` 独占一行开头，直到下一个 `---` 为头部。
 * 头部内 `key: value` 一行一条（`#` 开头与无冒号的行忽略）；键名统一小写（8.7.1 起）。
 * 8.7.3 加 `scripts:` 块（YAML 式列表）：
 * ```
 * scripts:
 *   - id: rename            ← `-` 起一条新项
 *     file: scripts/x.mjs   ← 有缩进的行归当前项
 * 顶层键（无缩进、非 `-`）= 脚本块结束
 * ```
 * 返回 null = 畸形（没有头部 / 头部没闭合）→ 调用方跳过并记账。
 */
export function parseSkillFile(text: string): { fields: Record<string, string>; scripts: Array<Record<string, string>>; body: string } | null {
  const clean = text.replace(/^\uFEFF/, "");
  const lines = clean.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;

  const fields: Record<string, string> = {};
  const scripts: Array<Record<string, string>> = [];
  let inScripts = false;
  let current: Record<string, string> | null = null;

  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indented = /^[ \t]/.test(raw);

    if (trimmed.startsWith("-")) {
      if (!inScripts) continue; // 不在 scripts 块里的散列表项忽略
      current = {};
      scripts.push(current);
      const kv = splitKv(trimmed.replace(/^-\s*/, ""));
      if (kv) current[kv[0]] = kv[1];
      continue;
    }

    const kv = splitKv(trimmed);
    if (!kv) continue;
    const [key, value] = kv;

    if (!inScripts && key === "scripts" && value === "") {
      inScripts = true;
      current = null;
      continue;
    }
    if (inScripts) {
      if (current && indented) {
        current[key] = value;
        continue;
      }
      inScripts = false; // 缩进归零 = 脚本块结束，这一行按顶层字段处理
      current = null;
    }
    fields[key] = value;
  }

  return { fields, scripts, body: lines.slice(end + 1).join("\n").trim() };
}

/** target 是否在 dir 之内（含相等）—— 本地实现，不动 8.4 path-guard（它没导出 isUnder） */
function isUnderDir(target: string, dir: string): boolean {
  const isWin = process.platform === "win32";
  const norm = (p: string): string => (isWin ? path.resolve(p).toLowerCase() : path.resolve(p));
  const t = norm(target);
  const d = norm(dir);
  if (t === d) return true;
  return t.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

/**
 * 校验 frontmatter 里的 scripts 声明（指令 §1.3）：缺 id/file、id 重复、**逃出技能目录**的一律丢弃并日志。
 * 逃逸判定用 path.resolve 后的前缀比较（先吃掉 `..`），不许拿原始串比。
 */
function buildScripts(skillId: string, dir: string, rawList: Array<Record<string, string>>): SkillScript[] {
  const out: SkillScript[] = [];
  const seen = new Set<string>();
  for (const raw of rawList) {
    const id = (raw.id ?? "").trim();
    const file = (raw.file ?? "").trim();
    if (!id || !file) {
      console.warn(`[skills] 技能「${skillId}」的脚本声明缺少 id 或 file，已丢弃`);
      continue;
    }
    if (seen.has(id)) {
      console.warn(`[skills] 技能「${skillId}」的脚本 id「${id}」重复，已丢弃后一条`);
      continue;
    }
    const absPath = path.resolve(dir, file);
    if (!isUnderDir(absPath, dir)) {
      console.warn(`[skills] 技能「${skillId}」的脚本「${id}」路径逃出技能目录（${file}），已丢弃`);
      continue;
    }
    if (raw.risk !== undefined && raw.risk !== "" && raw.risk !== "shell") {
      console.warn(`[skills] 技能「${skillId}」的脚本「${id}」声明 risk=${raw.risk}，脚本一律按 shell 审批`);
    }
    seen.add(id);
    out.push({
      id,
      file: path.relative(dir, absPath).split(path.sep).join("/"),
      absPath,
      description: (raw.description ?? "").trim(),
      risk: "shell",
    });
  }
  return out;
}

/** 依赖探针：`requires` 用逗号分隔的绝对路径，逐个 existsSync；没声明 = 恒可用 */
function probeRequires(declared: string): boolean {
  const items = declared.split(",").map((s) => s.trim()).filter(Boolean);
  return items.every((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

/**
 * 扫描技能根目录。目录不存在 = 空结果（不是错误）；
 * 每个子目录必须是「目录 + 含 SKILL.md」，否则记一条 errors 并跳过。
 * 顺序按目录名排序 —— 同输入 → 同输出（注入 system 的目录要稳定，本地小模型才稳）。
 */
export function scanSkills(rootDir: string): ScanResult {
  const errors: string[] = [];
  const skills: SkillRecord[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return { skills, errors }; // 目录不存在 / 读不到 = 还没有技能
  }
  entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))
    .forEach((id) => {
      const dir = path.join(rootDir, id);
      const file = path.join(dir, SKILL_FILE);
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        errors.push(`${id}: 缺少 ${SKILL_FILE}`);
        return;
      }
      const parsed = parseSkillFile(text);
      if (!parsed) {
        errors.push(`${id}: ${SKILL_FILE} 头部（frontmatter）格式不对，已跳过`);
        return;
      }
      const description = parsed.fields.description ?? "";
      if (!description) {
        errors.push(`${id}: ${SKILL_FILE} 缺少 description，已跳过`);
        return;
      }
      skills.push({
        id,
        dir,
        name: parsed.fields.name || id,
        description,
        version: parsed.fields.version ?? "",
        author: parsed.fields.author ?? "",
        enabled: parsed.fields.enabled !== "false",
        available: probeRequires(parsed.fields.requires ?? ""),
        scripts: buildScripts(id, dir, parsed.scripts),
        body: parsed.body,
        error: "",
      });
    });
  return { skills, errors };
}

// ==================== 内置示例技能（首次运行播种，验收用）====================

/** 「整理截图」示例脚本：把源目录下散落的 PNG 按修改月份移进「源目录/归档/YYYY-MM」（只移动，不删除） */
const ARCHIVE_SCRIPT = `#!/usr/bin/env node
// nahida 内置示例技能「整理截图」的脚本（8.7.3）。
// 用法：node archive.mjs <源目录绝对路径> [--dry-run]
// 只做移动：不改名、不删除、不覆盖（目标已存在就跳过）。
import * as fs from "node:fs";
import * as path from "node:path";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const source = args.find((a) => !a.startsWith("--"));
if (!source) {
  console.error("用法：node archive.mjs <源目录绝对路径> [--dry-run]");
  process.exit(2);
}
const src = path.resolve(source);
let stat;
try {
  stat = fs.statSync(src);
} catch {
  console.error(\`[错误] 目录不存在：\${src}\`);
  process.exit(2);
}
if (!stat.isDirectory()) {
  console.error(\`[错误] 不是目录：\${src}\`);
  process.exit(2);
}

const archiveRoot = path.join(src, "归档");
let moved = 0;
let skipped = 0;
for (const name of fs.readdirSync(src)) {
  if (!/\\.png$/i.test(name)) continue;
  const full = path.join(src, name);
  if (!fs.statSync(full).isFile()) continue;
  const when = fs.statSync(full).mtime;
  const month = \`\${when.getFullYear()}-\${String(when.getMonth() + 1).padStart(2, "0")}\`;
  const destDir = path.join(archiveRoot, month);
  const dest = path.join(destDir, name);
  if (fs.existsSync(dest)) {
    console.log(\`跳过（目标已存在）：\${name}\`);
    skipped++;
    continue;
  }
  if (dryRun) {
    console.log(\`[试运行] \${name} → 归档/\${month}/\`);
    continue;
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.renameSync(full, dest);
  console.log(\`已归档：\${name} → 归档/\${month}/\`);
  moved++;
}
console.log(\`\\n完成：移动 \${moved} 个，跳过 \${skipped} 个\${dryRun ? "（试运行，未真正移动）" : ""}\`);
`;

const BATCH_RENAME_TEXT = `---
name: 批量重命名
description: 把某个目录里的文件按统一规则批量改名（加前缀 / 编号 / 换扩展名前缀）。用户说「批量改名」「按顺序编号」时使用。
version: 1.0.0
author: nahida 内置示例
enabled: true
---

# 批量重命名

## 何时用
用户要一次性改掉一个目录里多个文件的名字：加统一前缀、加序号、去空格、统一大小写。

## 步骤
1. 先确认**目标目录**（绝对路径）。用户没给就问他，不要猜；目录必须在「设置 - 隐私 - 允许访问的目录」白名单里。
2. 用 \`list_dir\` 列出目录内容，把文件名照抄给用户看，让他确认要改哪些。
3. 列出「旧名 → 新名」的完整对照表，**先把表发给用户确认**，他点头再动手。
4. 确认后逐个用 \`run_shell\` 执行改名（一次一条，命令里用完整绝对路径）。属于会动本机文件的动作，会走审批，被拒就停手并说明。
5. 改完用 \`list_dir\` 复查一遍，把结果告诉用户。

## 规矩
- 绝不覆盖已有文件：新名字和现有文件重名时跳过该条并报告。
- 不做「删了重建」这类捷径（比如先删再写）；改名只做改名。
- 一次只处理用户确认过的文件，不要顺手多改。
`;

const TIDY_SHOTS_TEXT = `---
name: 整理截图
description: 把某个目录里散落的 PNG 截图按月份归档到「归档/YYYY-MM」子文件夹。用户说「整理截图」「归档图片」「桌面太乱」时使用。
version: 1.0.0
author: nahida 内置示例
enabled: true
scripts:
  - id: archive
    file: scripts/archive.mjs
    description: 把源目录下的 PNG 按修改月份移进「源目录/归档/YYYY-MM」（只移动、不改名、不删除）
    risk: shell
---

# 整理截图

## 何时用
用户想收拾一个存满截图 / 图片的目录：按月份归类，而不是一张张手动拖。

## 步骤
1. 先问清**源目录**（绝对路径，通常是桌面或下载目录）。不要猜；目录要在「设置 - 隐私 - 允许访问的目录」白名单里。
2. 先用脚本的 \`--dry-run\` 跑一遍，把「会移动哪些文件」的清单整理成人话给用户看。
3. 用户确认后再真正执行一次，最后把结果（移动几个、跳过几个）报给他。

## 规矩
- 只处理 PNG；其它格式一律不动。
- 不删除、不改名、不覆盖：目标已存在就跳过（脚本已经这么写了，不要绕过它另写命令）。
- 动手前必须让用户看过清单并点头。
`;

const SAMPLE_SKILLS: Array<{ dir: string; text: string; files?: Array<{ rel: string; content: string }> }> = [
  { dir: "batch-rename", text: BATCH_RENAME_TEXT },
  { dir: "tidy-shots", text: TIDY_SHOTS_TEXT, files: [{ rel: "scripts/archive.mjs", content: ARCHIVE_SCRIPT }] },
];

/**
 * 确保技能根目录存在；**首次**（目录不存在时）播种内置示例技能（8.7.1 的「批量重命名」
 * + 8.7.3 的「整理截图」，后者带一个可执行脚本演示）。
 * 只在目录整体不存在时播种 —— 用户删掉示例技能后不会被反复塞回来。
 */
export function ensureSkillsDir(rootDir: string): void {
  if (fs.existsSync(rootDir)) return;
  for (const sample of SAMPLE_SKILLS) {
    const sampleDir = path.join(rootDir, sample.dir);
    fs.mkdirSync(sampleDir, { recursive: true });
    fs.writeFileSync(path.join(sampleDir, SKILL_FILE), sample.text, "utf8");
    for (const file of sample.files ?? []) {
      const target = path.join(sampleDir, file.rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.content, "utf8");
    }
    console.log(`[skills] 已播种内置示例技能：${path.join(sampleDir, SKILL_FILE)}`);
  }
}
