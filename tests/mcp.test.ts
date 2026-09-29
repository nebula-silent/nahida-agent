// 4.2 MCP 契约层纯逻辑验证（指令 §9.2；vitest 基建已在位，按指令走 tests/ 路线）
// ★ 两条 D2 断言是本步最核心的验收：缺 risk / 脏 risk 一律回落 "shell"，绝不是 "safe"
import { describe, expect, it } from "vitest";
import {
  MCP_TRANSPORTS, MAX_MCP_SERVERS,
  isValidTransportKind, parseMcpServerInput, sanitizeMcpServers,
} from "../src/shared/mcp";
import { isValidRiskLevel, policyFor } from "../src/shared/tools";

describe("4.2 mcp 契约层", () => {
  // ① 传输白名单
  it("三传输且顺序为 stdio,http,sse", () => {
    expect(MCP_TRANSPORTS.length).toBe(3);
    expect(MCP_TRANSPORTS.join(",")).toBe("stdio,http,sse");
  });
  it("传输白名单挡脏值", () => {
    expect(isValidTransportKind("http")).toBe(true);
    expect(isValidTransportKind("ws")).toBe(false);
    expect(isValidTransportKind(3)).toBe(false);
  });

  // ② risk 白名单（新增的 isValidRiskLevel）
  it("风险白名单挡脏值", () => {
    expect(isValidRiskLevel("shell")).toBe(true);
    expect(isValidRiskLevel("safe")).toBe(true);
    expect(isValidRiskLevel("root")).toBe(false);
    expect(isValidRiskLevel(undefined)).toBe(false);
  });

  // ③ parseMcpServerInput：合法 / 各种不合法
  const good = parseMcpServerInput({ id: "fs", transport: "stdio", command: "npx", args: ["-y", "x"], risk: "fs-read" });
  it("合法入参 → 补齐 name/enabled", () => {
    expect(good.ok).toBe(true);
    if (good.ok) {
      expect(good.config.risk).toBe("fs-read");
      expect(good.config.enabled).toBe(true);
      expect(good.config.name).toBe("fs");
    }
  });
  it("args 原样带过", () => {
    expect(good.ok && good.config.args?.join(",")).toBe("-y,x");
  });

  // ★ D2 的核心断言：不传 risk 必须回落 "shell"，**绝不是 "safe"**
  const noRisk = parseMcpServerInput({ id: "a", transport: "stdio", command: "npx" });
  it("★ 缺 risk → 回落 shell（不是 safe）", () => {
    expect(noRisk.ok && noRisk.config.risk).toBe("shell");
  });
  it("★ 于是 read-only 档位下是 deny", () => {
    expect(noRisk.ok && policyFor("read-only", noRisk.config.risk)).toBe("deny");
  });

  it("脏 risk → 回落 shell", () => {
    const badRisk = parseMcpServerInput({ id: "b", transport: "stdio", command: "npx", risk: "safe2" });
    expect(badRisk.ok && badRisk.config.risk).toBe("shell");
  });

  it("ID 含中文 → 拒绝", () => {
    expect(parseMcpServerInput({ id: "有中文", transport: "stdio", command: "npx" }).ok).toBe(false);
  });
  it("空 ID → 拒绝", () => {
    expect(parseMcpServerInput({ id: "", transport: "stdio", command: "npx" }).ok).toBe(false);
  });
  it("stdio 缺 command → 拒绝", () => {
    expect(parseMcpServerInput({ id: "a", transport: "stdio" }).ok).toBe(false);
  });
  it("http 缺 url → 拒绝", () => {
    expect(parseMcpServerInput({ id: "a", transport: "http" }).ok).toBe(false);
  });
  it("未知传输 → 拒绝", () => {
    expect(parseMcpServerInput({ id: "a", transport: "ws", url: "http://x" }).ok).toBe(false);
  });
  it("非对象 → 拒绝", () => {
    expect(parseMcpServerInput(null).ok).toBe(false);
    expect(parseMcpServerInput([]).ok).toBe(false);
  });
  it("http 有 url → 通过", () => {
    expect(parseMcpServerInput({ id: "a", transport: "http", url: "http://x" }).ok).toBe(true);
  });

  // ④ sanitizeMcpServers：脏条目静默丢弃
  const dirty = sanitizeMcpServers([
    { id: "ok1", transport: "stdio", command: "npx" },
    { id: "ok1", transport: "stdio", command: "npx" }, // 重复 id → 丢
    { id: "坏 id", transport: "stdio", command: "npx" }, // 非法字符 → 丢
    { id: "noCmd", transport: "stdio" }, // 缺 command → 丢
    { id: "noUrl", transport: "http" }, // 缺 url → 丢
    { id: "badT", transport: "ws", url: "http://x" }, // 未知传输 → 丢
    null, 42, "x", // 非对象 → 丢
    { id: "ok2", transport: "http", url: "http://x", risk: "nope", enabled: false },
  ]);
  it("脏数据只留 2 条", () => {
    expect(dirty.length).toBe(2);
  });
  it("ok2：脏 risk → shell，enabled 显式 false 被尊重", () => {
    expect(dirty[1].risk).toBe("shell");
    expect(dirty[1].enabled).toBe(false);
  });
  it("非数组 → 空数组", () => {
    expect(sanitizeMcpServers("not-array").length).toBe(0);
    expect(sanitizeMcpServers(undefined).length).toBe(0);
  });
  it(`上限 ${MAX_MCP_SERVERS} 生效`, () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: "s" + i, transport: "stdio", command: "x" }));
    expect(sanitizeMcpServers(many).length).toBe(MAX_MCP_SERVERS);
  });

  // ⑤ §9.5 反例中可纯逻辑验证的两条（其余四条要真机，见批6）
  it("反例：把 risk 设成 fs-write，read-only 档位下必须 deny（D2 反向验证的纯逻辑层）", () => {
    expect(policyFor("read-only", "fs-write")).toBe("deny");
  });
  it("反例：添加时 args 传成字符串 → 字段被整个省略，不许把字符串塞进去", () => {
    const strArgs = parseMcpServerInput({ id: "c", transport: "stdio", command: "npx", args: "-y x" });
    expect(strArgs.ok).toBe(true);
    if (strArgs.ok) {
      // 实现比「空数组」更干净：非数组 → [] → length 0 → config 里根本不写 args 键
      expect(strArgs.config.args).toBeUndefined();
    }
  });
});
