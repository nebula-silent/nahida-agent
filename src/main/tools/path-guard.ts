// 8.4 新增：敏感区路径守卫（本步只做敏感区；`allowedDirs` 白名单的挂载归 8.2）。
// 范式参考自 Cyrene-Agent src/main/document-tools.ts 的 resolveOutputPath：**绝对路径 + 规范化**
// （先 resolve 掉 `..`，再看符号链接的真实落点），绝不拿原始串做前缀比较。
// 8.2/8.3 调它：fs 工具 cwd、read_file 目标、shell cwd 都先过这里；本步只交函数 + 单测。
// 规矩同其它 main/tools 模块：**不 import electron**（只用 node 内置 fs/path），vitest 可直接 import。
import * as fs from "fs";
import * as path from "path";

export interface SensitiveVerdict {
  blocked: boolean;
  /** 给人看的人话（审批卡 / 审计 / 工具报错用）；不拦时不带 */
  reason?: string;
}

/** 8.2：白名单判定结果（fs 工具的唯一放行凭据） */
export interface AllowedVerdict {
  allowed: boolean;
  /** 给人看的人话（工具报错用）；放行时不带 */
  reason?: string;
}

/** 盘根一级就属于系统区的目录名（判定只看盘根下一级，别误伤 D:\projects\windows） */
const SENSITIVE_TOP_DIRS = ["windows", "program files", "program files (x86)"];

/** 密钥类文件后缀 */
const KEY_FILE_RE = /\.(pem|key)$/;

function isWin(): boolean {
  return process.platform === "win32";
}

/** Windows 上路径大小写不敏感；比较前统一小写 */
function norm(p: string): string {
  return isWin() ? p.toLowerCase() : p;
}

function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter(Boolean);
}

/** 盘根：`C:` / `C:\` / `/` / `\` —— 根是整个盘，绝不允许工具直接落在这里 */
function isDriveRoot(p: string): boolean {
  return p === "/" || p === "\\" || /^[a-zA-Z]:[\\/]*$/.test(p);
}

/** 敏感文件名（小写比对）：命中返回文件名，否则 null */
function sensitiveName(name: string): string | null {
  const n = name.toLowerCase();
  if (n === ".env" || n.startsWith(".env.")) return n;      // .env / .env.local / .env.production
  if (KEY_FILE_RE.test(n)) return n;                        // *.pem / *.key
  if (n === "id_rsa") return n;                             // 私钥
  if (n === "token" || n.startsWith("token.") || n.endsWith(".token")) return n;
  if (n.startsWith("credential")) return n;                 // credential* / credentials.json
  if (n.startsWith("secret")) return n;                     // secret* / secrets.yaml
  return null;
}

/** target 是不是在 dir 之内（含相等）；两边都规范化后按分隔符比对 */
function isUnder(target: string, dir: string): boolean {
  const t = norm(path.resolve(target));
  const d = norm(path.resolve(dir));
  if (t === d) return true;
  return t.startsWith(d.endsWith(path.sep) ? d : d + path.sep);
}

/** 真实落点（存在时解析符号链接；不存在 / 解析失败 → 原样返回） */
function realPathOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

/** 单条路径的判定：命中返回 blocked，未命中返回 null（再由调用方决定是否继续判真实落点） */
function verdictFor(p: string, allowedDirs: string[]): SensitiveVerdict | null {
  if (isDriveRoot(p)) {
    return { blocked: true, reason: `盘根目录属于敏感区，不允许直接访问：${p}` };
  }
  const segs = segments(norm(p));
  if (segs.length === 0) {
    return { blocked: true, reason: `盘根目录属于敏感区，不允许直接访问：${p}` };
  }
  // 系统目录只看盘根下一级（C:\Windows\… / C:\Program Files\…）
  if (segs.length >= 2 && SENSITIVE_TOP_DIRS.includes(segs[1])) {
    return { blocked: true, reason: `系统目录属于敏感区，不允许访问：${p}` };
  }
  if (segs.includes("appdata") && !allowedDirs.some((d) => isUnder(p, d))) {
    return { blocked: true, reason: `AppData 属于敏感区（不在允许目录内），不允许访问：${p}` };
  }
  const base = segs[segs.length - 1];
  const hit = sensitiveName(base);
  if (hit !== null) {
    return { blocked: true, reason: `疑似凭据文件「${base}」属于敏感区，不允许访问：${p}` };
  }
  return null;
}

/**
 * 敏感区守卫（唯一入口）。
 * @param absPath 目标绝对路径（相对路径一律拒 —— 基准不明时不许猜）
 * @param allowedDirs 允许目录白名单（8.2 的 allowedDirs 从这里进；本步默认空 = AppData 全拒）
 */
export function isSensitivePath(absPath: string, allowedDirs: string[] = []): SensitiveVerdict {
  if (typeof absPath !== "string" || absPath.trim() === "") {
    return { blocked: true, reason: "路径为空，拒绝访问。" };
  }
  const raw = absPath.trim();
  // 盘根连 `C:`（无斜杠）这种「驱动器相对」写法都算 —— 但 path.isAbsolute("C:") 是 false，
  // 所以必须在绝对路径检查**之前**拦掉，否则 reason 会误导成「只接受绝对路径」
  if (isDriveRoot(raw)) {
    return { blocked: true, reason: `盘根目录属于敏感区，不允许直接访问：${raw}` };
  }
  if (!path.isAbsolute(raw)) {
    return { blocked: true, reason: `只接受绝对路径：${raw}` };
  }
  // 双判：先判规范化结果（挡 `..` 穿越），再判真实落点（挡符号链接逃逸）
  const resolved = path.resolve(raw);
  const hit = verdictFor(resolved, allowedDirs);
  if (hit) return hit;
  const real = realPathOr(resolved);
  if (norm(real) !== norm(resolved)) {
    const realHit = verdictFor(real, allowedDirs);
    if (realHit) return realHit;
  }
  return { blocked: false };
}

/**
 * 8.2：允许目录白名单（fs 工具的唯一放行凭据）。
 * 顺序：① 先过敏感区 —— 敏感区永远拒绝，白名单也救不回来（8.4 的语义不许被本步放宽）；
 *       ② allowedDirs 为空 → 全拒；③ 目标必须落在任一允许目录内（目录本身也算，目录下递归都算）。
 * @param absPath 目标绝对路径（相对路径由 isSensitivePath 拦掉）
 * @param allowedDirs 允许目录白名单（config.json 的 allowedDirs，已 normalize 成绝对路径）
 */
export function isAllowedPath(absPath: string, allowedDirs: string[] = []): AllowedVerdict {
  const sensitive = isSensitivePath(absPath, allowedDirs);
  if (sensitive.blocked) return { allowed: false, reason: sensitive.reason };

  const dirs = (Array.isArray(allowedDirs) ? allowedDirs : [])
    .filter((d): d is string => typeof d === "string" && d.trim() !== "")
    .map((d) => path.resolve(d.trim()));
  if (dirs.length === 0) {
    return { allowed: false, reason: "还没有配置允许访问的目录，她目前没有任何文件访问权限。" };
  }

  // 双判（同 isSensitivePath 的口径）：规范化结果 + 符号链接真实落点，任一落在白名单内才放行
  const target = path.resolve(absPath.trim());
  const real = realPathOr(target);
  const ok = dirs.some((d) => isUnder(target, d) || isUnder(real, d) || isUnder(real, realPathOr(d)));
  // 报错不回原文路径（指令 §1.3）
  if (!ok) return { allowed: false, reason: "这个路径不在允许访问的目录内，已拒绝。" };
  return { allowed: true };
}