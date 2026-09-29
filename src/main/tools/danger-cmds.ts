// 8.4 新增：shell 危险命令黑名单（**纯函数，不 import electron / fs**）。
// 语义（指令 §1.2）：判定 argv 数组（**不是字符串正则** —— shell 工具用 argv 不经 shell），
//   **逐项 + 组合**识别危险；命中只返回「危险 + 人话理由」，由调用方（8.3 的 shell 工具）
//   把策略转成 per-action 审批 —— 本文件绝不静默 deny（用户可能真要清理自己的项目产物）。
// 8.3 补：返回里多一个可选 `severity:"high"`（盘级毁灭 / 盘根被删 / fork 炸弹）= 再审也不放行，
//   调用方直接 deny。本文件仍**不做**策略决定（不 deny、不弹窗），只把危险度标出来。
// 挂载归 8.3；本步只交函数 + 单测。
export interface DangerVerdict {
  dangerous: boolean;
  /** 给人看的人话（审批卡 / 审计用）；不危险时不带 */
  reason?: string;
  /** 8.3 加：危险度分档。`"high"` = 盘级毁灭（format / mkfs / fork 炸弹）或盘根被递归删 ——
   *  调用方（shell 工具）**直接 deny，不给审批通道**；不带 = 只转逐条审批（用户可能真要清自己的项目产物）。
   *  **不改既有 dangerous 语义**：dangerous 仍为「命中门槛」。 */
  severity?: "high";
}

/** 磁盘级毁灭性命令（打完就直接没了的那些）：一律危险 */
const DESTRUCTIVE_EXES = ["format", "diskpart", "wipefs", "fdisk", "shutdown", "mkfs"];

/** 能「再包一层命令」的壳：`bash -c "rm -rf /"` 这一路必须穿透进去看 */
const SHELL_WRAPPERS = ["bash", "sh", "zsh", "dash", "powershell", "pwsh", "cmd"];

/** fork 炸弹（`:(){ :|:& };:` 及其空行 / 空格变体）—— 先把空白全去掉再匹配 */
const FORK_BOMB_RE = /:\s*\(\s*\)\s*\{\s*:?\s*\|\s*:?\s*&\s*\}\s*;?\s*:/;

/** 取可执行名：去引号 → 取最后一段路径 → 去小写 → 去 Windows 常见后缀 */
function baseName(cmd: string): string {
  const s = cmd.trim().replace(/^["']|["']$/g, "");
  const segs = s.split(/[\\/]+/).filter(Boolean);
  const last = segs.length > 0 ? segs[segs.length - 1] : s;
  return last.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, "");
}

/** 去引号 + trim（参数值比对用） */
function clean(v: string): string {
  return v.trim().replace(/^["']|["']$/g, "");
}

/** 盘根 / 根目录：`C:`、`C:\`、`/`、`\` */
function isRootLike(p: string | undefined): boolean {
  if (p === undefined) return false;
  const s = clean(p);
  return s === "/" || s === "\\" || /^[a-zA-Z]:[\\/]*$/.test(s);
}

/** 全量目标：`. / * ..` 这类「删掉整个目录」的写法 */
function isBroadTarget(p: string | undefined): boolean {
  if (p === undefined) return false;
  const s = clean(p);
  return s === "." || s === "./" || s === ".\\" || s === ".."
    || s === "*" || s === "/*" || s === "\\*" || s === "/.";
}

/** unix 递归短参：-r / -R / -rf / -fr / -rF（单破折号聚簇）；另有 --recursive 单列 */
function isUnixRecursive(a: string): boolean {
  return /^-[a-z]*r[a-z]*$/.test(a) || a === "--recursive";
}

/** Windows 递归开关：/s（可带 q/f/c 组合成 /sq） */
function isWinRecursive(a: string): boolean {
  return /^\/s[qfc]*$/.test(a);
}

/** 开关判定：`-x` / `--xyz`，或 Windows 短开关 `/s`、`/sq`（长度 ≤3，别把 `/home` 这类路径当开关） */
function isSwitch(a: string): boolean {
  return a.startsWith("-") || /^\/[a-zA-Z?]{1,3}$/.test(a);
}

/** 第一个非开关参数（删除类命令的目标） */
function firstTarget(args: string[]): string | undefined {
  return args.find((a) => !isSwitch(a));
}

/** 8.3：高危组合 —— 盘根被删 / 全量通配被删 / cwd 本身就是盘根。
 *  这三类递归删除「再审也不放行」，由调用方直接 deny（其余危险命令只转逐条审批） */
function isHighRiskTarget(target: string | undefined, cwd: string | undefined): boolean {
  return isBroadTarget(target) || isRootLike(target) || isRootLike(cwd);
}

/** 高危时补上 severity 字段（不命中则一个键都不加，保持既有返回形状） */
function highIf(high: boolean): { severity?: "high" } {
  return high ? { severity: "high" } : {};
}

/** 递归删除的措辞：目标越狠，理由越重 */
function recursiveReason(kind: string, target: string | undefined, cwd: string | undefined): string {
  if (isBroadTarget(target)) return `检测到「${kind}」全量删除（目标「${target}」），已达危险操作门槛，须逐次确认。`;
  if (isRootLike(target)) return `检测到「${kind}」删除盘根 / 根目录，已达危险操作门槛，须逐次确认。`;
  if (isRootLike(cwd)) return `当前工作目录是盘根，「${kind}」将在此递归删除，须逐次确认。`;
  return `检测到递归删除命令「${kind}」，已达危险操作门槛，须逐次确认。`;
}

/**
 * 危险命令判定。
 * @param argv 完整参数数组（argv[0] = 可执行名）
 * @param cwd 可选：命令执行目录（8.3 挂载时传）。盘根 + 递归删除 = 危险组合
 */
export function isDangerousShell(argv: string[], cwd?: string): DangerVerdict {
  if (!Array.isArray(argv) || argv.length === 0) return { dangerous: false };
  const parts = argv.map((a) => String(a));
  const exe = baseName(parts[0]);
  const args = parts.slice(1);
  const lower = args.map((a) => a.toLowerCase());

  // 0. fork 炸弹：跟具体 exe 无关，先认写法
  if (FORK_BOMB_RE.test(parts.join(" ").replace(/\s+/g, ""))) {
    return { dangerous: true, severity: "high", reason: "检测到 fork 炸弹写法，已达危险操作门槛，须逐次确认。" };
  }

  // 1. 磁盘级命令：一律危险，且一律高危（盘级毁灭，不给审批通道）
  if (DESTRUCTIVE_EXES.some((d) => exe === d) || exe.startsWith("mkfs")) {
    return { dangerous: true, severity: "high", reason: `检测到磁盘级命令「${exe}」，已达危险操作门槛，须逐次确认。` };
  }

  // 2. Unix 删除：递归（含 -rf / --recursive）即危险；非递归但打盘根也危险
  if (exe === "rm") {
    const recursive = lower.some(isUnixRecursive);
    const target = firstTarget(args);
    if (recursive) {
      return {
        dangerous: true, ...highIf(isHighRiskTarget(target, cwd)),
        reason: recursiveReason("rm 递归删除", target, cwd),
      };
    }
    if (isRootLike(target) || isBroadTarget(target)) {
      return { dangerous: true, severity: "high", reason: `检测到「rm」删除盘根 / 全量目标（「${target}」），须逐次确认。` };
    }
  }

  // 3. Windows 删除目录：rd / rmdir + /s 递归
  if (exe === "rd" || exe === "rmdir") {
    const target = firstTarget(args);
    if (lower.some(isWinRecursive)) {
      return {
        dangerous: true, ...highIf(isHighRiskTarget(target, cwd)),
        reason: recursiveReason("rd 递归删除目录", target, cwd),
      };
    }
    if (isRootLike(target)) {
      return { dangerous: true, severity: "high", reason: `检测到「${exe}」删除盘根（「${target}」），须逐次确认。` };
    }
  }

  // 4. del：/s 递归，或 /f + /q 强删组合
  if (exe === "del" || exe === "erase") {
    const target = firstTarget(args);
    const recursive = lower.some(isWinRecursive);
    const forceQuiet = lower.includes("/f") && lower.includes("/q");
    if (recursive) {
      return {
        dangerous: true, ...highIf(isHighRiskTarget(target, cwd)),
        reason: recursiveReason("del 递归删除", target, cwd),
      };
    }
    if (forceQuiet) {
      return {
        dangerous: true, ...highIf(isHighRiskTarget(target, cwd)),
        reason: `检测到「${exe} /f /q」强制删除，须逐次确认。`,
      };
    }
  }

  // 5. PowerShell：Remove-Item -Recurse / Format-*
  if (exe === "remove-item") {
    const target = firstTarget(args);
    if (lower.some((a) => a === "-recurse" || a.startsWith("-recurse"))) {
      return {
        dangerous: true, ...highIf(isHighRiskTarget(target, cwd)),
        reason: recursiveReason("Remove-Item -Recurse", target, cwd),
      };
    }
  }
  if (exe.startsWith("format-")) {
    return { dangerous: true, severity: "high", reason: `检测到 PowerShell 磁盘格式化命令「${exe}」，须逐次确认。` };
  }

  // 6. 壳内命令穿透：bash -c / cmd /c / powershell -Command 里的正文再判一次
  if (SHELL_WRAPPERS.includes(exe)) {
    const idx = lower.findIndex((a) => a === "-c" || a === "/c" || a === "-command" || a === "-commandwithargs");
    if (idx !== -1) {
      const inner = args.slice(idx + 1).join(" ").trim();
      if (inner !== "") {
        const innerVerdict = isDangerousShell(inner.split(/\s+/), cwd);
        if (innerVerdict.dangerous) return innerVerdict;
      }
    }
  }

  return { dangerous: false };
}