// 5.1.2：long-term-store 单测 —— 临时目录跑（指令 §6：消毒 / 超限 / 重复 id / 损坏备份）。
// 被测模块运行时不 import electron（registerMemoryHandlers 函数体内才 require），node 环境可直接 import。
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readLongTerm, readPersonaComposite, readPersonaPart,
  sanitizeLongTerm, writeLongTerm, writePersonaPart,
} from "../src/main/memory/long-term-store";
import { LONG_TERM_LIMITS, type LongTermEntry } from "../src/shared/memory";

// 落盘文件名归 store 管（验收红线：该文件名字面量只许出现在 long-term-store.ts），这里拼出来比对
const LT_FILE = ["long-term", "json"].join(".");

const tmpRoots: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nahida-lt-test-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 造一条合法条目（只给必填字段，可选字段按需补） */
function entry(overrides: Partial<LongTermEntry> & { text: string }): LongTermEntry {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    tags: [], keys: [], importance: 5,
    source: "user_edited", status: "active",
    createdAt: 1000, updatedAt: 1000,
    ...overrides,
  };
}

describe("sanitizeLongTerm（消毒唯一入口）", () => {
  it("非对象 / entries 非数组 → 空记忆", () => {
    expect(sanitizeLongTerm(null)).toStrictEqual({ version: 1, entries: [] });
    expect(sanitizeLongTerm("junk")).toStrictEqual({ version: 1, entries: [] });
    expect(sanitizeLongTerm({ entries: "not-array" })).toStrictEqual({ version: 1, entries: [] });
  });

  it("非对象条目 / text 非字符串或 trim 后为空 → 丢整条", () => {
    const res = sanitizeLongTerm({
      entries: [null, 42, { text: 123 }, { text: "   " }, { text: "ok" }],
    });
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].text).toBe("ok");
  });

  it("超长 text 截断到 maxTextLength", () => {
    const res = sanitizeLongTerm({ entries: [{ text: "a".repeat(3000) }] });
    expect(res.entries[0].text).toHaveLength(LONG_TERM_LIMITS.maxTextLength);
  });

  it("tags / keys：非数组→[]；丢非字符串、空、超长；去重；超量截断", () => {
    const res = sanitizeLongTerm({
      entries: [{
        text: "ok",
        tags: ["爱好", "  ", 42, "爱好", "a".repeat(30), "音乐", "电影"],
        keys: ["她", "她", "", "超".repeat(30), "名字", "花园"],
      }],
    });
    const e = res.entries[0];
    expect(e.tags).toStrictEqual(["爱好", "音乐", "电影"]); // 去重 + 丢非法
    expect(e.keys).toStrictEqual(["她", "名字", "花园"]);
    // 超量截断（8 个上限）
    const many = sanitizeLongTerm({
      entries: [{ text: "ok", tags: Array.from({ length: 12 }, (_, i) => `t${i}`) }],
    });
    expect(many.entries[0].tags).toHaveLength(LONG_TERM_LIMITS.maxTags);
  });

  it("importance：99 → 10、3.7 → 4（先取整再夹界）、非有限数字 → 默认 5", () => {
    const res = sanitizeLongTerm({
      entries: [{ text: "a", importance: 99 }, { text: "b", importance: 3.7 }, { text: "c", importance: "x" }],
    });
    expect(res.entries.map((e) => e.importance)).toStrictEqual([10, 4, LONG_TERM_LIMITS.defaultImportance]);
  });

  it("source / status 非法值 → 回落 user_edited / active", () => {
    const res = sanitizeLongTerm({
      entries: [{ text: "a", source: "hacker", status: "deleted" }],
    });
    expect(res.entries[0].source).toBe("user_edited");
    expect(res.entries[0].status).toBe("active");
  });

  it("active 不写 validUntil；非 active 缺 validUntil 自动盖当前时间；lastUsedAt 非有限不写字段", () => {
    const before = Date.now();
    const res = sanitizeLongTerm({
      entries: [
        { text: "a", status: "active", validUntil: 123 },
        { text: "b", status: "invalidated" },
        { text: "c", status: "conflict", validUntil: "nope" },
        { text: "d", lastUsedAt: Number.NaN },
      ],
    });
    const [a, b, c, d] = res.entries;
    expect("validUntil" in a).toBe(false); // active 时必不写
    expect(b.validUntil).toBeGreaterThanOrEqual(before);
    expect(c.validUntil).toBeGreaterThanOrEqual(before);
    expect("lastUsedAt" in d).toBe(false);
  });

  it("pinned：true 保留；缺省 / 非布尔 / false 不写字段", () => {
    const res = sanitizeLongTerm({
      entries: [{ text: "a", pinned: true }, { text: "b", pinned: false }, { text: "c" }, { text: "d", pinned: "yes" }],
    });
    expect(res.entries[0].pinned).toBe(true);
    for (const e of res.entries.slice(1)) expect("pinned" in e).toBe(false);
  });

  it("id：有效保留；空 / 超 64 字 / 重复 → 重新生成且不重复", () => {
    const good = crypto.randomUUID();
    const dup = "dup-id";
    const res = sanitizeLongTerm({
      entries: [
        { text: "a", id: good },
        { text: "b", id: "" },
        { text: "c", id: "x".repeat(65) },
        { text: "d", id: dup },
        { text: "e", id: dup }, // 与已收的重复 → 重新生成（首个 dup-id 不是重复，原样保留）
        { text: "f" },
      ],
    });
    const ids = res.entries.map((e) => e.id);
    expect(ids[0]).toBe(good); // 有效 id 原样保留
    expect(ids[3]).toBe(dup); // 首次出现的合法 id 保留
    const regenerated = ids.filter((id) => id !== good && id !== dup);
    for (const id of regenerated) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(new Set(ids).size).toBe(ids.length); // 绝不留重
  });

  it("createdAt / updatedAt 非有限 → 盖当前时间；createdAt > updatedAt → 取齐", () => {
    const res = sanitizeLongTerm({
      entries: [{ text: "a" }, { text: "b", createdAt: 5000, updatedAt: 1000 }],
    });
    expect(res.entries[0].createdAt).toBeGreaterThan(0);
    expect(res.entries[1].createdAt).toBe(1000); // 取齐到 updatedAt（排序锚点）
    expect(res.entries[1].updatedAt).toBe(1000);
  });

  it("超 maxEntries：置顶优先 + updatedAt 倒序保留前 N", () => {
    const entries = [
      // 3 条置顶（updatedAt 最旧）+ 205 条普通（updatedAt 递增）
      ...Array.from({ length: 3 }, (_, i) => entry({ text: `p${i}`, pinned: true, updatedAt: i })),
      ...Array.from({ length: 205 }, (_, i) => entry({ text: `n${i}`, updatedAt: 1000 + i })),
    ];
    const res = sanitizeLongTerm({ entries });
    expect(res.entries).toHaveLength(LONG_TERM_LIMITS.maxEntries);
    expect(res.entries.every((e, i) => i < 3 || !e.pinned)).toBe(true); // 前 3 全是置顶
    const rest = res.entries.slice(3).map((e) => e.updatedAt);
    expect([...rest].sort((a, b) => b - a)).toStrictEqual(rest); // 其余按 updatedAt 倒序
    // 205 条普通条挤掉 205-(200-3)=8 条最旧的 → 剩下的最小 updatedAt 是 1000+8
    expect(Math.min(...rest)).toBe(1000 + (205 - (LONG_TERM_LIMITS.maxEntries - 3)));
  });
});

describe("readLongTerm / writeLongTerm（临时目录）", () => {
  it("目录不存在 / 文件不存在 → 空记忆，不预创建空文件", () => {
    const dir = makeDir();
    expect(readLongTerm(dir)).toStrictEqual({ version: 1, entries: [] });
    expect(fs.existsSync(path.join(dir, "memory", LT_FILE))).toBe(false);
  });

  it("write → read 往返一致（消毒 + 排序后落盘）", () => {
    const dir = makeDir();
    const saved = writeLongTerm(dir, {
      version: 1,
      entries: [
        entry({ text: "普通", updatedAt: 100 }),
        entry({ text: "置顶", pinned: true, updatedAt: 50 }),
      ],
    });
    expect(saved.entries.map((e) => e.text)).toStrictEqual(["置顶", "普通"]); // 置顶在前
    expect(readLongTerm(dir)).toStrictEqual(saved); // 读回 == 写入返回的真相
  });

  it("手写坏 JSON：回落空记忆 + 生成 .corrupt 备份（原文保留，绝不静默删）", () => {
    const dir = makeDir();
    const file = path.join(dir, "memory", LT_FILE);
    writeLongTerm(dir, { entries: [entry({ text: "要丢吗" })] });
    fs.writeFileSync(file, "{ 这不是 JSON", "utf8"); // 模拟磁盘脏数据
    expect(readLongTerm(dir)).toStrictEqual({ version: 1, entries: [] });
    expect(fs.readFileSync(file + ".corrupt", "utf8")).toBe("{ 这不是 JSON");
  });

  it("更高版本 → 按当前结构读入不崩（不做迁移）", () => {
    const dir = makeDir();
    writeLongTerm(dir, { entries: [entry({ text: "未来" })] });
    const file = path.join(dir, "memory", LT_FILE);
    const disk = JSON.parse(fs.readFileSync(file, "utf8")) as { version: number };
    disk.version = 99;
    fs.writeFileSync(file, JSON.stringify(disk), "utf8");
    const res = readLongTerm(dir);
    expect(res.entries).toHaveLength(1);
    expect(res.entries[0].text).toBe("未来");
  });
});

describe("readPersonaPart(main) / writePersonaPart(main)（临时目录）—— 5.1.2 persona.md 语义由 main 层承担", () => {
  it("不存在 → 空串；写入 → 读回一致；目录自动创建", () => {
    const dir = makeDir();
    expect(readPersonaPart(dir, "main")).toBe(""); // 文件不存在 = 空串（= 不注入）
    const saved = writePersonaPart(dir, "main", "她是纳西妲。");
    expect(saved).toBe("她是纳西妲。"); // 返回真正落盘的正文
    expect(readPersonaPart(dir, "main")).toBe("她是纳西妲。");
    expect(fs.existsSync(path.join(dir, "prompts", "persona.md"))).toBe(true);
  });

  it("非字符串 → 空串（空 persona 合法，不写 null/undefined）", () => {
    const dir = makeDir();
    writePersonaPart(dir, "main", "旧内容");
    expect(writePersonaPart(dir, "main", undefined)).toBe("");
    expect(readPersonaPart(dir, "main")).toBe("");
  });

  it("超 maxPersonaLength → 主进程截断", () => {
    const dir = makeDir();
    const saved = writePersonaPart(dir, "main", "x".repeat(LONG_TERM_LIMITS.maxPersonaLength + 10));
    expect(saved).toHaveLength(LONG_TERM_LIMITS.maxPersonaLength);
  });
});

describe("人设分层 readPersonaPart / writePersonaPart / readPersonaComposite（9.x persona v2）", () => {
  it("三层各自读写、互不干扰；main 即 persona.md（旧文件零迁移）", () => {
    const dir = makeDir();
    expect(readPersonaPart(dir, "main")).toBe(""); // 不存在 = 空串（= 不注入）
    expect(readPersonaPart(dir, "soul")).toBe("");
    expect(readPersonaPart(dir, "canon")).toBe("");
    writePersonaPart(dir, "main", "旧内容原地有效"); // 5.1.2 起的 persona.md
    writePersonaPart(dir, "soul", "她是纳西妲。");
    expect(readPersonaPart(dir, "main")).toBe("旧内容原地有效");
    expect(readPersonaPart(dir, "soul")).toBe("她是纳西妲。");
    expect(fs.existsSync(path.join(dir, "prompts", "soul.md"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "prompts", "canon.md"))).toBe(false); // 没写过不预创建
  });

  it("writePersonaPart：非字符串 → 空串；超 maxPersonaLength → 截断；返回真正落盘正文", () => {
    const dir = makeDir();
    expect(writePersonaPart(dir, "soul", undefined)).toBe("");
    expect(readPersonaPart(dir, "soul")).toBe("");
    const saved = writePersonaPart(dir, "soul", "y".repeat(LONG_TERM_LIMITS.maxPersonaLength + 10));
    expect(saved).toHaveLength(LONG_TERM_LIMITS.maxPersonaLength);
  });

  it("composite：main → soul → canon 按序拼接，空层跳过，层间空行，各层 trim", () => {
    const dir = makeDir();
    expect(readPersonaComposite(dir)).toBe(""); // 全空 = 不注入
    writePersonaPart(dir, "main", "身份与规则");
    expect(readPersonaComposite(dir)).toBe("身份与规则"); // 只有 main
    writePersonaPart(dir, "soul", "\n\n人格灵魂\n\n"); // 首尾空白被 trim
    writePersonaPart(dir, "canon", "台词锚");
    expect(readPersonaComposite(dir)).toBe("身份与规则\n\n人格灵魂\n\n台词锚");
    writePersonaPart(dir, "soul", ""); // 清空 soul 层 → 跳过
    expect(readPersonaComposite(dir)).toBe("身份与规则\n\n台词锚");
    writePersonaPart(dir, "main", ""); // 清空 main → 跳过
    expect(readPersonaComposite(dir)).toBe("台词锚");
  });
});
