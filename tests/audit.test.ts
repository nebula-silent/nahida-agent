// 8.4 §1.1：审计 —— 打码 / 摘要（纯函数）与落盘 / 回读（临时目录往返）。
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  AUDIT_ARGS_MAX, AUDIT_OUTPUT_MAX, maskSensitive, summarizeArgs, summarizeOutput,
  type AuditEntry,
} from "../src/shared/audit";
import { auditDir, auditFileName, appendAudit, readRecentAudit } from "../src/main/tools/audit";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nahida-audit-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: Date.now(), callId: "c1", toolId: "read_file", risk: "fs-read",
    decision: "allow", reason: "", argsSummary: "{}", resultStatus: "succeeded", outputSummary: "ok",
    ...over,
  };
}

describe("审计摘要（打码 / 截断）", () => {
  it("敏感 key 一律打码，嵌套与数组也穿透；普通字段原样", () => {
    const out = summarizeArgs({
      apiKey: "sk-明文",
      API_KEY: "也打",
      token: "t",
      password: "p",
      secret: "s",
      Authorization: "Bearer xyz",
      path: "C:\\proj\\a.txt",
      nested: { credentials: "c", name: "nahida" },
      list: [{ secretKey: "s2", ok: 1 }],
    });
    expect(out).toContain('"apiKey":"***"');
    expect(out).toContain('"API_KEY":"***"');
    expect(out).toContain('"password":"***"');
    expect(out).toContain('"token":"***"');
    expect(out).toContain('"secret":"***"');
    expect(out).toContain('"Authorization":"***"');
    expect(out).toContain('"credentials":"***"');
    expect(out).toContain('"secretKey":"***"');
    expect(out).not.toContain("明文");
    expect(out).not.toContain("Bearer xyz");
    expect(out).toContain('"name":"nahida"'); // 普通字段不许被牵连
    expect(out).toContain('"ok":1');
  });

  it("maskSensitive 对非对象 / null 原样返回（不炸）", () => {
    expect(maskSensitive(null)).toBeNull();
    expect(maskSensitive("x")).toBe("x");
    expect(maskSensitive(3)).toBe(3);
  });

  it("超长参数截断在 AUDIT_ARGS_MAX 内；结果摘要截到 AUDIT_OUTPUT_MAX", () => {
    const long = summarizeArgs({ blob: "x".repeat(AUDIT_ARGS_MAX * 2) });
    expect(long.length).toBe(AUDIT_ARGS_MAX + 1); // 截断后补一个省略号
    expect(long.endsWith("…")).toBe(true);
    const out = summarizeOutput("y".repeat(AUDIT_OUTPUT_MAX + 50));
    expect(out.length).toBe(AUDIT_OUTPUT_MAX + 1);
    expect(out.endsWith("…")).toBe(true);
    expect(summarizeOutput("短结果")).toBe("短结果");
  });

  it("循环引用不抛（序列化失败给占位）", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(summarizeArgs(cyc)).toBe("[无法序列化]");
  });
});

describe("审计落盘 / 回读", () => {
  it("按月分文件名：audit-YYYYMM.jsonl", () => {
    expect(auditFileName(new Date(2026, 0, 5).getTime())).toBe("audit-202601.jsonl");
    expect(auditFileName(new Date(2026, 11, 31).getTime())).toBe("audit-202612.jsonl");
  });

  it("append 到 <userData>/audit/ 并按序回读（目录自动创建）", () => {
    const root = makeTmp();
    const now = Date.now();
    appendAudit(root, entry({ ts: now, callId: "c1" }));
    appendAudit(root, entry({ ts: now, callId: "c2", decision: "deny", resultStatus: "denied" }));
    const file = path.join(auditDir(root), auditFileName(now));
    expect(fs.existsSync(file)).toBe(true);
    const view = readRecentAudit(root);
    expect(view.dir).toBe(auditDir(root));
    expect(view.total).toBe(2);
    expect(view.entries.map((e) => e.callId)).toEqual(["c1", "c2"]);
    expect(view.entries[1].decision).toBe("deny");
  });

  it("只给最近 limit 条；文件不存在 = 空视图不抛", () => {
    const root = makeTmp();
    expect(readRecentAudit(root).entries).toEqual([]);
    for (let i = 0; i < 5; i++) appendAudit(root, entry({ callId: `c${i}` }));
    const view = readRecentAudit(root, 2);
    expect(view.total).toBe(5);
    expect(view.entries.map((e) => e.callId)).toEqual(["c3", "c4"]);
  });

  it("脏行 / 半行跳过（一条坏记录不毁掉整个查看页）", () => {
    const root = makeTmp();
    const now = Date.now();
    appendAudit(root, entry({ callId: "good" }));
    fs.appendFileSync(path.join(auditDir(root), auditFileName(now)), "{半行\n", "utf8");
    const view = readRecentAudit(root);
    expect(view.entries.map((e) => e.callId)).toEqual(["good"]);
    expect(view.total).toBe(2); // 总数照行数算（界面会提示「仅显示…」）
  });
});