// 8.3 §2 验收：run_shell 单测 —— 全程用**假 spawn**（不起真进程 / 不真删文件 / 不真格式化）。
// 覆盖：argv 数组 + shell:false、注入面、普通危险命令转审批、高危直接 deny、敏感 cwd deny、
//        cwd 窄例外（8.7.3 方案 B：技能目录放行 / 例外外仍拒）、超时 kill、
//        退出码 / spawn error / 二进制 / 截断的输出形状、无审批通道不放行、注册形态。
import { describe, it, expect } from "vitest";
import * as path from "path";
import { runShell, registerShellTool, setShellCwdAllowance, SHELL_TOOL_ID, type SpawnFn } from "../src/main/tools/shell-tool";
import { toolRegistry, type ToolExecContext } from "../src/main/tools/tool-registry";
import type { ApprovalRequest } from "../src/shared/tool-call";

type Listener = (...a: unknown[]) => void;

interface FakeChild {
  pid: number;
  stdout: { on: (ev: string, cb: Listener) => void };
  stderr: { on: (ev: string, cb: Listener) => void };
  on: (ev: string, cb: Listener) => void;
  kill: (signal?: string) => boolean;
}

interface FakePlan {
  stdout?: string;
  /** 原样回放的二进制块（测 NUL 嗅探） */
  stdoutRaw?: Buffer;
  stderr?: string;
  /** close 的退出码，缺省 0 */
  code?: number | null;
  /** 给了就发 error 事件（命令不存在等），不再发 close */
  error?: Error;
  /** false = 永不 close（测超时） */
  autoClose?: boolean;
}

/** 假 spawn：记录调用入参，按剧本在微任务里回放输出与 close */
function makeFakeSpawn(plan: FakePlan = {}) {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  let killed = false;
  const spawn = (command: string, args: string[], options: Record<string, unknown>): FakeChild => {
    calls.push({ command, args: [...args], options });
    const listeners = new Map<string, Listener[]>();
    const add = (ev: string, cb: Listener): void => {
      listeners.set(ev, [...(listeners.get(ev) ?? []), cb]);
    };
    const emit = (ev: string, ...a: unknown[]): void => {
      for (const cb of listeners.get(ev) ?? []) cb(...a);
    };
    const child: FakeChild = {
      pid: 4242,
      stdout: { on: (ev, cb) => add(ev, cb) }, // runShell 用同一个 "data" 事件收 stdout+stderr
      stderr: { on: (ev, cb) => add(ev, cb) },
      on: (ev, cb) => add(ev, cb),
      kill: () => { killed = true; return true; },
    };
    queueMicrotask(() => {
      if (plan.error) { emit("error", plan.error); return; }
      if (plan.stdoutRaw) emit("data", plan.stdoutRaw);
      if (plan.stdout !== undefined) emit("data", Buffer.from(plan.stdout, "utf8"));
      if (plan.stderr !== undefined) emit("data", Buffer.from(plan.stderr, "utf8"));
      if (plan.autoClose !== false) emit("close", plan.code ?? 0, null);
    });
    return child;
  };
  return { spawn, calls, killed: () => killed };
}

const cast = (fn: unknown): SpawnFn => fn as SpawnFn;

/** 假执行期上下文：收集审批请求，默认放行 */
function makeCtx(approvedByLoop = false) {
  const requests: ApprovalRequest[] = [];
  let allowed = true;
  const ctx: ToolExecContext = {
    callId: "c7",
    toolName: "执行命令",
    description: "测试用",
    approvedByLoop,
    approve: async (req) => { requests.push(req); return allowed; },
  };
  return { ctx, requests, reject: () => { allowed = false; } };
}

describe("run_shell（假 spawn）", () => {
  it("正常命令：argv 数组 + shell:false 交给 spawn，返回含输出与退出码", async () => {
    const fake = makeFakeSpawn({ stdout: "v24.18.0\n" });
    const out = await runShell({ command: "node", args: ["--version"] }, undefined, cast(fake.spawn));
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0].command).toBe("node");
    expect(fake.calls[0].args).toEqual(["--version"]);
    expect(fake.calls[0].options.shell).toBe(false);
    expect(out).toContain("v24.18.0");
    expect(out).toContain("[退出码 0]");
  });

  it("注入面：参数里的 ; | & 只是普通参数，不被 shell 解释（argv 底线）", async () => {
    const fake = makeFakeSpawn();
    await runShell({ command: "echo", args: ["a; rm -rf /"] }, undefined, cast(fake.spawn));
    expect(fake.calls[0].args).toEqual(["a; rm -rf /"]); // 没被拆成多条命令
    expect(fake.calls[0].options.shell).toBe(false);
  });

  it("cwd 合法：原样交给 spawn", async () => {
    const dir = path.join(process.cwd(), "src");
    const fake = makeFakeSpawn();
    await runShell({ command: "node", args: ["--version"], cwd: dir }, undefined, cast(fake.spawn));
    expect(fake.calls[0].options.cwd).toBe(dir);
  });

  it("普通危险命令（rm -rf build）：full 档补问一次审批，允许才执行", async () => {
    const h = makeCtx(false);
    const fake = makeFakeSpawn();
    const out = await runShell({ command: "rm", args: ["-rf", "build"] }, h.ctx, cast(fake.spawn));
    expect(h.requests.length).toBe(1);
    expect(h.requests[0].callId).toBe("c7"); // 复用循环层 callId（渲染层升级同一张卡）
    expect(h.requests[0].risk).toBe("shell");
    expect(h.requests[0].reason).toContain("递归删除");
    expect(fake.calls.length).toBe(1);
    expect(out).toContain("[退出码 0]");
  });

  it("普通危险命令被拒：不执行，返回 [已拒绝]", async () => {
    const h = makeCtx(false);
    h.reject();
    const fake = makeFakeSpawn();
    const out = await runShell({ command: "rm", args: ["-rf", "build"] }, h.ctx, cast(fake.spawn));
    expect(h.requests.length).toBe(1);
    expect(fake.calls.length).toBe(0);
    expect(out).toContain("[已拒绝]");
  });

  it("per-action 档（approvedByLoop=true）：循环层已问过，不再补问第二次", async () => {
    const h = makeCtx(true);
    const fake = makeFakeSpawn();
    await runShell({ command: "rm", args: ["-rf", "build"] }, h.ctx, cast(fake.spawn));
    expect(h.requests.length).toBe(0);
    expect(fake.calls.length).toBe(1);
  });

  it("无审批通道 + 危险命令 → 不放行（绝不静默跑高危命令）", async () => {
    const fake = makeFakeSpawn();
    const out = await runShell({ command: "rm", args: ["-rf", "build"] }, undefined, cast(fake.spawn));
    expect(fake.calls.length).toBe(0);
    expect(out).toContain("[已拒绝]");
  });

  it("高危（盘级 / 盘根 / fork 炸弹）→ 直接 deny：不审批、不执行", async () => {
    const cases: Array<[string, string[]]> = [
      ["format", ["D:"]],
      ["rm", ["-rf", "/"]],
      ["rd", ["/s", "/q", "C:\\"]],
      ["Remove-Item", ["-Recurse", "C:\\"]],
      [":(){ :|:& };:", []],
    ];
    for (const [command, args] of cases) {
      const h = makeCtx(false);
      const fake = makeFakeSpawn();
      const out = await runShell({ command, args }, h.ctx, cast(fake.spawn));
      expect(out, `${command} ${args.join(" ")}`).toContain("[已拒绝]");
      expect(h.requests.length, `${command} 不该弹审批`).toBe(0);
      expect(fake.calls.length, `${command} 不该执行`).toBe(0);
    }
  });

  it("cwd 敏感区 / 相对路径 → 直接 deny：不审批、不执行", async () => {
    for (const cwd of ["C:\\Windows\\System32", "proj\\sub"]) {
      const h = makeCtx(false);
      const fake = makeFakeSpawn();
      const out = await runShell({ command: "node", args: ["--version"], cwd }, h.ctx, cast(fake.spawn));
      expect(out, cwd).toContain("[已拒绝]");
      expect(h.requests.length, cwd).toBe(0);
      expect(fake.calls.length, cwd).toBe(0);
    }
  });

  it("cwd 窄例外（8.7.3 方案 B）：注入技能目录后例外内放行，例外外（系统盘 / 同级目录）仍拒", async () => {
    // 用真实形状的 AppData 路径（含 appdata 段）—— 否则测不出「例外」这件事
    const appData = path.join("C:\\", "Users", "u", "AppData", "Roaming", "nahida");
    const skillsDir = path.join(appData, "skills");
    const cases: Array<[string, string, boolean]> = [
      [skillsDir, "技能目录本身（含递归子目录）", true],
      [path.join(skillsDir, "tidy-shots"), "技能子目录", true],
      [path.join(appData, "logs"), "同 AppData 下的兄弟目录", false],
      [appData, "AppData 父层本身", false],
      ["C:\\Windows\\System32", "系统目录（列入例外也不放）", false],
    ];
    for (const [cwd, label, shouldAllow] of cases) {
      const fake = makeFakeSpawn();
      setShellCwdAllowance(() => [skillsDir]);
      try {
        const out = await runShell({ command: "node", args: ["--version"], cwd }, undefined, cast(fake.spawn));
        if (shouldAllow) {
          expect(out, label).not.toContain("[已拒绝]");
          expect(fake.calls.length, label).toBe(1);
          expect(fake.calls[0].options.cwd, label).toBe(cwd);
        } else {
          expect(out, label).toContain("[已拒绝]");
          expect(fake.calls.length, label).toBe(0);
        }
      } finally {
        setShellCwdAllowance(() => []); // 还原：不许把例外泄漏给其它用例（默认 = 8.4 原行为）
      }
    }
    // 还原后同一个 cwd 重新被拒（证明「没注入就没例外」）
    const fake = makeFakeSpawn();
    const out = await runShell({ command: "node", args: ["--version"], cwd: skillsDir }, undefined, cast(fake.spawn));
    expect(out).toContain("[已拒绝]");
    expect(fake.calls.length).toBe(0);
  });

  it("超时：杀进程树 + 返回超时提示（不再等 close）", async () => {
    const fake = makeFakeSpawn({ autoClose: false });
    const out = await runShell({ command: "node", args: ["-e", "run()"], timeoutMs: 20 }, undefined, cast(fake.spawn));
    expect(out).toContain("[错误]");
    expect(out).toContain("超时");
    expect(fake.killed()).toBe(true);
  });

  it("非零退出码：返回 [错误] 且仍回灌输出", async () => {
    const fake = makeFakeSpawn({ stderr: "boom\n", code: 2 });
    const out = await runShell({ command: "git", args: ["status"] }, undefined, cast(fake.spawn));
    expect(out).toContain("[错误] 命令以退出码 2 结束");
    expect(out).toContain("boom");
  });

  it("命令不存在（spawn error）→ [错误] 无法执行", async () => {
    const fake = makeFakeSpawn({ error: new Error("spawn nope ENOENT") });
    const out = await runShell({ command: "nope", args: [] }, undefined, cast(fake.spawn));
    expect(out).toContain("[错误] 无法执行");
    expect(out).toContain("ENOENT");
  });

  it("二进制输出：只转述「输出含二进制，已省略」", async () => {
    const fake = makeFakeSpawn({ stdoutRaw: Buffer.from([0x89, 0x50, 0x00, 0x4e, 0x47]) });
    const out = await runShell({ command: "type", args: ["a.png"] }, undefined, cast(fake.spawn));
    expect(out).toContain("输出含二进制，已省略");
  });

  it("超长输出：截断到 TOOL_OUTPUT_MAX 之内", async () => {
    const fake = makeFakeSpawn({ stdout: "x".repeat(5000) });
    const out = await runShell({ command: "dir", args: [] }, undefined, cast(fake.spawn));
    expect(out).toContain("已截断");
    expect(out.length).toBeLessThan(4100);
  });

  it("缺少 command：软失败，不碰 spawn", async () => {
    const fake = makeFakeSpawn();
    const out = await runShell({}, undefined, cast(fake.spawn));
    expect(out).toContain("[错误]");
    expect(fake.calls.length).toBe(0);
  });

  it("注册形态：run_shell 进注册表，risk=shell / category 内置 / required=command", () => {
    registerShellTool();
    const def = toolRegistry.getById(SHELL_TOOL_ID);
    expect(def?.risk).toBe("shell");
    expect(def?.category).toBe("内置");
    expect(def?.enabled).toBe(true);
    expect(def?.inputSchema.required).toEqual(["command"]);
  });
});