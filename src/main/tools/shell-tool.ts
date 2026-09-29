// 8.3 新增：run_shell 工具（在本机执行命令）。
// 骨架 + 常见坑（§1.1–§1.4）：
//   ① **argv 数组 + shell:false** —— command 与 args 分开传，绝不把模型给的字符串拼给 OS 解释（防命令注入）。
//   ② 执行前双重校验：cwd 过 8.4 的 isSensitivePath（敏感区硬拒）；argv 过 8.4 的 isDangerousShell：
//        · severity "high"（盘级毁灭 / 盘根被删 / fork 炸弹）→ **直接 deny**，连审批通道都不给
//        · 其余命中 → **强制逐条审批**：循环层问过（per-action 档，approvedByLoop=true）就不再问；
//          full 档（policy=allow）由本工具补问一次 —— 复用同一个 callId，渲染层把已有卡升级成带按钮
//   ③ 超时 / 被杀：尽力杀进程树（Windows taskkill /T /F，其它平台 SIGKILL）
//   ④ encoding utf8；二进制输出只转述「输出含二进制，已省略」；输出按 TOOL_OUTPUT_MAX 截断
// 依赖倒置：spawn 由调用方传（真机 = child_process.spawn，单测 = 假 spawn）—— 本文件**不 import electron**，
//   vitest 可直接 import，且测试里绝不起真进程 / 真删文件 / 真格式化。
import * as child_process from "child_process";
import { toolRegistry, type ToolExecContext } from "./tool-registry";
import { isDangerousShell } from "./danger-cmds";
import { isSensitivePath } from "./path-guard";
import { RISK_LEVEL_LABEL } from "../../shared/tools";
import { TOOL_OUTPUT_MAX, type ApprovalRequest } from "../../shared/tool-call";

/** 执行命令的工具 id（审批请求 / 工具事件里复用） */
export const SHELL_TOOL_ID = "run_shell";

/**
 * 8.7.3：cwd 的**窄例外目录**（用户拍板 B）。由 main 注入（真机 = userData/skills）——
 * 技能目录在 AppData 下，不放这一条，技能里写的 `node scripts/x.mjs`（cwd = 技能目录）必被 8.4 敏感区拒。
 * 默认空数组：单测 / 未组装时与 8.4 原行为逐字一致（AppData 全拒）。
 * 只放宽「AppData 不在允许目录内」这一条 —— 盘根 / 系统目录 / 凭据文件名的判定不受影响（path-guard.verdictFor）。
 */
let shellCwdAllowance: () => string[] = () => [];

/** 注入窄例外（只允许在 main 组装时调用一次；测试里可临时替换再还原） */
export function setShellCwdAllowance(provider: () => string[]): void {
  shellCwdAllowance = provider;
}

const SHELL_TIMEOUT_DEFAULT = 30_000;
/** 超时上限：模型给个 10^9 也不许把一条命令挂成一天 */
const SHELL_TIMEOUT_MAX = 600_000;
/** 原始输出收集上限（1MiB）：防 `dir /s C:\` 这类命令把内存撑爆；超了只停收集，不杀进程 */
const SHELL_RAW_MAX = 1_048_576;
/** 截断时留的地点（TOOL_OUTPUT_MAX 内） */
const SHELL_TRUNCATE_TAIL = "\n…（已截断）";

export type SpawnFn = typeof child_process.spawn;

/** 传给 spawn 的选项（**shell 恒为 false**，类型上就堵死 shell:true） */
interface ShellSpawnOptions {
  cwd?: string;
  shell: false;
  windowsHide: boolean;
}

interface ExecOutcome {
  code: number | null;
  signal: string | null;
  /** spawn 本身失败（如 ENOENT：命令不存在）时的错误信息 */
  error?: string;
  timedOut: boolean;
}

interface RawResult extends ExecOutcome {
  buf: Buffer;
  truncated: boolean;
}

/** 参数归一化：command 必填且去空白；args 只收标量（对象 / null 一律丢掉，别把 "[object Object]" 当参数） */
function normalizeArgs(args: Record<string, unknown>): { command: string; rest: string[] } {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  const rest = Array.isArray(args.args)
    ? args.args
        .filter((a) => typeof a === "string" || typeof a === "number" || typeof a === "boolean")
        .map((a) => String(a))
    : [];
  return { command, rest };
}

/** 超时归一化：非数 / ≤0 → 缺省；超上限 → 夹到上限 */
function normalizeTimeout(value: unknown): number {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return SHELL_TIMEOUT_DEFAULT;
  return Math.min(Math.floor(n), SHELL_TIMEOUT_MAX);
}

/** 超时 / 被杀：尽力杀进程树。Windows 用 taskkill /T /F；其它平台 SIGKILL；
 *  最后无论平台都兜一次 child.kill（taskkill 起不来时也有个收场）。
 *  taskkill 走**注入的 spawn** —— 单测里替换成假 spawn 后不会真起系统进程。 */
function killTree(child: child_process.ChildProcess, spawnFn: SpawnFn): void {
  if (process.platform === "win32" && typeof child.pid === "number") {
    try {
      spawnFn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true });
    } catch {
      // taskkill 起不来：下面的 child.kill 兜底
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // 已经退出
  }
}

/** 二进制嗅探：输出含 NUL 字节即当二进制（图片 / 压缩包 / UTF-16 都命中），只转述不塞回上下文 */
function looksBinary(buf: Buffer): boolean {
  return buf.includes(0);
}

/** 截断到 TOOL_OUTPUT_MAX 之内（自带末尾标记的长度也算在内，免得回灌层再截一次） */
function truncate(text: string): string {
  if (text.length <= TOOL_OUTPUT_MAX) return text;
  return text.slice(0, TOOL_OUTPUT_MAX - SHELL_TRUNCATE_TAIL.length) + SHELL_TRUNCATE_TAIL;
}

/** 起一条命令、收 stdout+stderr、等 close；超时 / error 都走同一个幂等 settle */
function execOnce(
  command: string,
  rest: string[],
  options: ShellSpawnOptions,
  timeoutMs: number,
  spawnFn: SpawnFn,
): Promise<RawResult> {
  return new Promise<RawResult>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // stdout 与 stderr 合并收（按到达顺序），与回灌口径一致
    const collect = (d: unknown): void => {
      if (size >= SHELL_RAW_MAX) { truncated = true; return; }
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(String(d), "utf8");
      size += buf.length;
      if (size > SHELL_RAW_MAX) truncated = true;
      chunks.push(buf);
    };

    const settle = (r: ExecOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ...r, buf: Buffer.concat(chunks), truncated });
    };

    let child: child_process.ChildProcess;
    try {
      child = spawnFn(command, rest, options);
    } catch (err) {
      settle({ code: null, signal: null, error: err instanceof Error ? err.message : String(err), timedOut: false });
      return;
    }

    timer = setTimeout(() => {
      settle({ code: null, signal: "TIMEOUT", timedOut: true });
      killTree(child, spawnFn);
    }, timeoutMs);

    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (err) => {
      settle({ code: null, signal: null, error: err instanceof Error ? err.message : String(err), timedOut: false });
    });
    child.on("close", (code, signal) => {
      settle({ code, signal, timedOut: false });
    });
  });
}

/** 危险命令强制转审批：循环层没问过时补问一次。
 *  没有审批通道（ctx 缺 approve）= 一律不放行 —— 绝不静默跑高危命令（§1.4）。 */
async function askForDangerous(ctx: ToolExecContext | undefined, argv: string[], reason: string): Promise<boolean> {
  if (!ctx?.approve) return false;
  const req: ApprovalRequest = {
    callId: ctx.callId, // 复用循环层的 callId：渲染层升级同一张卡，不建第二张
    toolId: SHELL_TOOL_ID,
    toolName: ctx.toolName,
    description: ctx.description,
    risk: "shell",
    riskLabel: RISK_LEVEL_LABEL.shell,
    args: { command: argv[0], args: argv.slice(1) },
    reason, // 用危险判定的理由（比「需要你确认」具体：告诉用户到底哪里危险）
  };
  return ctx.approve(req);
}

/**
 * run_shell 的实现主体（spawn 可注入 = 单测用假 spawn）。
 * 返回**人话字符串**（软失败：失败 / 超时都返回 `[错误]…`，不抛异常 —— 同 write_note 的形状）。
 */
export async function runShell(
  args: Record<string, unknown>,
  ctx?: ToolExecContext,
  spawnFn: SpawnFn = child_process.spawn,
): Promise<string> {
  const { command, rest } = normalizeArgs(args);
  if (command === "") return "[错误] 缺少要执行的命令（command）。";
  const argv = [command, ...rest];
  const timeoutMs = normalizeTimeout(args.timeoutMs);

  // ① cwd 硬校验（8.4 path-guard）。先判它：cwd 不合法就没必要再弹一次无意义的审批卡。
  //    窄例外（8.7.3 方案 B）= shellCwdAllowance()，真机注入 [userData/skills]：技能目录在 AppData 下，
  //    技能写的 `node scripts/x.mjs`（cwd = 技能目录）要靠它才不被敏感区拒；只放宽 AppData 这一条，
  //    盘根 / 系统目录 / 凭据文件名照旧硬拒（path-guard.verdictFor）。
  //    缺省 cwd：指令写的是「userData 或 allowedDirs[0]」——allowedDirs 归 8.2（未落地），
  //    userData 本身在 AppData 下、会被 path-guard 当敏感区拒掉，故缺省**不设 cwd**（继承进程 cwd）。
  let cwd: string | undefined;
  if (typeof args.cwd === "string" && args.cwd.trim() !== "") {
    const raw = args.cwd.trim();
    const guard = isSensitivePath(raw, shellCwdAllowance());
    if (guard.blocked) return `[已拒绝] ${guard.reason}`;
    cwd = raw;
  }

  // ② 危险命令（8.4 danger-cmds）：高危直接 deny；其余命中强制逐条审批
  const verdict = isDangerousShell(argv, cwd);
  if (verdict.dangerous) {
    if (verdict.severity === "high") {
      return `[已拒绝] ${verdict.reason}该命令属于盘级 / 盘根级高危操作，本工具不会执行。`;
    }
    if (!ctx?.approvedByLoop) {
      const allowed = await askForDangerous(ctx, argv, verdict.reason ?? "检测到危险命令，须逐次确认。");
      if (!allowed) return `[已拒绝] ${verdict.reason ?? "危险命令"}未经批准，未执行。`;
    }
  }

  // ③ 执行：argv 数组 + shell:false（注入面在类型上就堵死）
  const options: ShellSpawnOptions = { shell: false, windowsHide: true };
  if (cwd !== undefined) options.cwd = cwd;
  const outcome = await execOnce(command, rest, options, timeoutMs, spawnFn);

  if (outcome.timedOut) return `[错误] 命令执行超时（${timeoutMs}ms），已终止进程树。`;
  if (outcome.error !== undefined) return `[错误] 无法执行「${command}」：${outcome.error}`;

  const body =
    outcome.buf.length === 0
      ? "(无输出)"
      : looksBinary(outcome.buf)
        ? "输出含二进制，已省略"
        : truncate(outcome.buf.toString("utf8").replace(/\s+$/, ""));
  const cut = outcome.truncated ? "\n（原始输出过大，已截断收集）" : "";

  if (outcome.code === 0) return `${body}${cut}\n\n[退出码 0]`;
  const signalPart = outcome.signal === null ? "" : `（信号 ${outcome.signal}）`;
  return `[错误] 命令以退出码 ${outcome.code ?? "未知"} 结束${signalPart}。\n${body}${cut}`;
}

/** 注册 run_shell（风险 = shell；read-only / scoped 档 deny，per-action 档逐条审批，full 档放行） */
export function registerShellTool(): void {
  toolRegistry.register({
    id: SHELL_TOOL_ID,
    name: "执行命令",
    description:
      "在这台电脑上执行一条命令（node / git / npm 等可执行程序）。命令与参数分开传，不经 shell 拼接。\n\n何时用：用户明确要求跑命令、查看某程序的版本或输出、跑构建 / 测试。\n不要用于：读写文件（有专门的工具）、毁灭性操作（格式化磁盘、递归删盘根会被直接拒绝）。",
    category: "内置",
    enabled: true, // 能不能真跑由档位决定，不由 enabled 决定（§5.8）
    risk: "shell", // ← 执行命令的工具绝不填 safe（builtin-tools 头注释的硬规矩）
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令（可执行名或路径，如 node、git）" },
        args: { type: "array", items: { type: "string" }, description: "命令参数列表（逐个传，不拼字符串，防注入）" },
        cwd: { type: "string", description: "工作目录（可选，须绝对路径；系统盘根 / Windows / Program Files 等敏感区会被拒绝）" },
        timeoutMs: { type: "number", description: `超时毫秒数（可选，缺省 ${SHELL_TIMEOUT_DEFAULT}，上限 ${SHELL_TIMEOUT_MAX}）` },
      },
      required: ["command"],
    },
    execute: (args, ctx) => runShell(args, ctx, child_process.spawn),
  });
}