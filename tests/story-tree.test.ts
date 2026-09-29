// 5.7.1：消息树纯函数单测（指令 §4 第 10 条清单：resolvePath 线性链 / 分叉取指定支 /
// leafId 为 null → [] / leafId 不存在 → [] / 手造环不卡死；normalizeSession v1 线性升级 /
// childrenIds 被重建 / parentId 断链置 null / parentId 指向自己置 null / activeLeafId 缺失回落 at 最大 /
// 坏节点被丢而其余保留 / {} 与 "x" → null / 返回值 schemaVersion === 2）。被测模块零依赖，node 环境直接 import。
import { describe, expect, it } from "vitest";
import { CHAT_SCHEMA_VERSION, normalizeSession, resolvePath, type MessageNode } from "../src/shared/chat";

/** 造一个节点（childrenIds 手填只为让输入「更像文件」，resolvePath 不看它） */
function node(id: string, parentId: string | null, at: number): MessageNode {
  return { id, parentId, childrenIds: [], role: "user", content: `消息 ${id}`, at };
}

describe("resolvePath：可见路径 = 根→叶", () => {
  it("线性链返回全链，顺序是根→叶", () => {
    const nodes = [node("a", null, 1), node("b", "a", 2), node("c", "b", 3)];
    expect(resolvePath(nodes, "c").map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("分叉：各自取指定支，互不串线", () => {
    const nodes = [node("a", null, 1), node("b", "a", 2), node("c", "b", 3), node("d", "b", 4)];
    expect(resolvePath(nodes, "c").map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(resolvePath(nodes, "d").map((n) => n.id)).toEqual(["a", "b", "d"]);
  });

  it("leafId 为 null → 空数组（空会话）", () => {
    expect(resolvePath([node("a", null, 1)], null)).toEqual([]);
  });

  it("leafId 不在表里 → 空数组（调用方负责先经 normalizeSession 兜底）", () => {
    expect(resolvePath([node("a", null, 1)], "nope")).toEqual([]);
  });

  it("手造环不卡死：截断返回，长度不超过表长", () => {
    const nodes = [node("a", "b", 1), node("b", "a", 2)];
    const path = resolvePath(nodes, "a");
    expect(path.length).toBeLessThanOrEqual(nodes.length);
  });
});

describe("normalizeSession：v1 升级与自愈", () => {
  it("v1（无 parentId / activeLeafId）按数组顺序线性升级，返回 schemaVersion === 2", () => {
    const raw = {
      id: "s1",
      title: "旧档",
      messages: [
        { id: "m1", role: "user", content: "一", at: 1 },
        { id: "m2", role: "assistant", content: "二", at: 2 },
      ],
      createdAt: 1000,
      updatedAt: 2000,
      schemaVersion: 1,
    };
    const s = normalizeSession(raw);
    expect(s).not.toBeNull();
    expect(s?.schemaVersion).toBe(CHAT_SCHEMA_VERSION);
    expect(s?.messages.map((n) => n.parentId)).toEqual([null, "m1"]);
    expect(s?.activeLeafId).toBe("m2");
    expect(resolvePath(s!.messages, s!.activeLeafId).map((n) => n.id)).toEqual(["m1", "m2"]);
  });

  it("9.1：workDir 随读随留；缺失 / 空串 / 脏值 = 未选择（字段不出现）", () => {
    const base = {
      id: "s1", title: "档",
      messages: [node("a", null, 1)],
      activeLeafId: "a", createdAt: 1000, updatedAt: 2000, schemaVersion: 2,
    };
    expect(normalizeSession({ ...base, workDir: "D:\\项目" })?.workDir).toBe("D:\\项目");
    expect(normalizeSession(base)?.workDir).toBeUndefined(); // 旧档没有 = 未选择
    expect(normalizeSession({ ...base, workDir: "" })?.workDir).toBeUndefined(); // 空串当未选择
    expect(normalizeSession({ ...base, workDir: 42 })?.workDir).toBeUndefined(); // 脏值忽略
  });

  it("childrenIds 被重建：文件里的旧值（漂移 / 幽灵 id）一律作废", () => {
    const raw = {
      id: "s1",
      title: "档",
      messages: [
        node("a", null, 1),
        { ...node("b", "a", 2), childrenIds: ["ghost", "b"] },
      ],
      activeLeafId: "b",
      createdAt: 1000,
      updatedAt: 2000,
      schemaVersion: 2,
    };
    const s = normalizeSession(raw);
    expect(s?.messages[0].childrenIds).toEqual(["b"]);
    expect(s?.messages[1].childrenIds).toEqual([]);
  });

  it("parentId 断链（指向表外）→ 置 null，节点保留", () => {
    const raw = {
      id: "s1",
      title: "档",
      messages: [node("a", null, 1), node("b", "ghost", 2)],
      activeLeafId: "b",
      createdAt: 1000,
      updatedAt: 2000,
      schemaVersion: 2,
    };
    const s = normalizeSession(raw);
    expect(s?.messages).toHaveLength(2);
    expect(s?.messages[1].parentId).toBeNull();
  });

  it("parentId 指向自己 → 置 null（自愈，不丢节点）", () => {
    const raw = {
      id: "s1",
      title: "档",
      messages: [node("a", "a", 1)],
      activeLeafId: "a",
      createdAt: 1000,
      updatedAt: 2000,
      schemaVersion: 2,
    };
    const s = normalizeSession(raw);
    expect(s?.messages[0].parentId).toBeNull();
    expect(s?.messages[0].childrenIds).toEqual([]);
  });

  it("activeLeafId 缺失 → 回落 at 最大的节点；并列取靠后的（= v1 的最后一条）", () => {
    const raw = {
      id: "s1",
      title: "档",
      messages: [node("a", null, 1), node("b", "a", 5), node("c", "a", 3)],
      createdAt: 1000,
      updatedAt: 2000,
      schemaVersion: 2,
    };
    expect(normalizeSession(raw)?.activeLeafId).toBe("b");
    const tie = {
      ...raw,
      messages: [node("a", null, 1), node("b", "a", 5), node("c", "a", 5)],
    };
    expect(normalizeSession(tie)?.activeLeafId).toBe("c");
  });

  it("坏节点被丢而其余保留（缺 content / role 非法），剩下按数组顺序仍然成链", () => {
    const raw = {
      id: "s1",
      title: "档",
      messages: [
        { id: "m1", role: "user", content: "一", at: 1 },
        { id: "bad1", role: "user", at: 2 }, // 缺 content
        { id: "bad2", role: "robot", content: "？", at: 3 }, // role 非法
        { id: "m2", role: "assistant", content: "二", at: 4 },
      ],
      createdAt: 1000,
      updatedAt: 2000,
      schemaVersion: 1,
    };
    const s = normalizeSession(raw);
    expect(s?.messages.map((n) => n.id)).toEqual(["m1", "m2"]);
    expect(s?.messages[1].parentId).toBe("m1");
    expect(s?.activeLeafId).toBe("m2");
  });

  it("{} 与 \"x\" → null（不可救的输入）", () => {
    expect(normalizeSession({})).toBeNull();
    expect(normalizeSession("x")).toBeNull();
  });

  it("titleLocked 随读随留（5.5.1 的改名保护）；branchId 是 string 则保留", () => {
    const raw = {
      id: "s1",
      title: "改过名",
      titleLocked: true,
      messages: [{ id: "a", role: "user", content: "一", at: 1, branchId: "br1" }],
      activeLeafId: "a",
      createdAt: 1000,
      updatedAt: 2000,
      schemaVersion: 2,
    };
    const s = normalizeSession(raw);
    expect(s?.titleLocked).toBe(true);
    expect(s?.messages[0].branchId).toBe("br1");
  });
});