// 5.7.2：触发引擎（主进程侧上下文装配）
// ⚠️ 本文件顶层 import chats-store（它顶层 import electron），**不许被 tests/ import**（指令 §2.3）
// 依据：内部规格 §3.3
import { readCurrentRelationship } from "../relationship/relationship-store";
import { getSession, listSessions } from "../chats/chats-store";
import { resolvePath, type ChatMessage } from "../../shared/chat";
import { matchedChapters, type Chapter, type StoryContext, type StoryContextExtras } from "../../shared/story";
import { readStoryDoc } from "./story-store";

/** 装配上下文：好感度走 relationship 真值；聊天走最近会话的可见路径；now 走 Date.now() */
export function buildStoryContext(extras?: StoryContextExtras, now: number = Date.now()): StoryContext {
  // 聊天来源：listSessions 按 updatedAt desc，[0] 就是最近一份；没有会话 / 读不出来 → 全空上下文（不许抛错）
  let messageCount = 0;
  let lastUserText = "";
  let lastChatAt: number | null = null;
  const recent = listSessions()[0];
  const session = recent ? getSession(recent.id) : null;
  if (session) {
    const path = resolvePath(session.messages, session.activeLeafId); // 可见路径（不是扁平节点表）
    messageCount = path.length;
    for (let i = path.length - 1; i >= 0; i--) {
      if (path[i].role === "user") {
        lastUserText = path[i].content; // 最后一条 user 消息正文
        break;
      }
    }
    lastChatAt = path.length > 0 ? path[path.length - 1].at : null; // 末节点时刻（idleMinutes 用）
  }
  return {
    now,
    affection: readCurrentRelationship().value, // 0–100 真值（主进程 relationship store 是唯一入口）
    messageCount,
    lastUserText,
    lastChatAt,
    // extras 是渲染层补给的过渡态（5.7.2 还没接，恒 0 / ""）；形状不可信 → typeof 收口
    tasksDoneToday:
      typeof extras?.tasksDoneToday === "number" && Number.isFinite(extras.tasksDoneToday)
        ? extras.tasksDoneToday
        : 0,
    mood: typeof extras?.mood === "string" ? extras.mood : "",
  };
}

/** 读盘章节 + 装配上下文 → 命中的章节（按 order 升序）。5.7.3 的事件钩子调它 */
export function evaluateChapters(extras?: StoryContextExtras): Chapter[] {
  const { app } = require("electron") as typeof import("electron"); // 函数体内 require（照 relationship-store:56 范本）
  const doc = readStoryDoc(app.getPath("userData"));
  return matchedChapters(doc.chapters, buildStoryContext(extras));
}

/** 5.7.3.2 追加：最近一份会话的**可见路径**末 N 条，映射成对话消息（生成时的上下文）。
 *  没有会话 / 读不出来 → []。**不许抛错**（生成照跑，只是上下文少）。 */
export function recentVisibleMessages(limit: number = 10): ChatMessage[] {
  try {
    // 聊天来源与 buildStoryContext 同一条路：listSessions 按 updatedAt desc，[0] 就是最近一份
    const recent = listSessions()[0];
    const session = recent ? getSession(recent.id) : null;
    if (!session) return [];
    const path = resolvePath(session.messages, session.activeLeafId);
    const n = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 10;
    // 取**末** N 条（不是头）：离当前时刻越近越相关
    return path.slice(Math.max(0, path.length - n)).map((m) => ({
      // 角色归一化：存储里的 system / tool 一律当 assistant（与 5.7.1 渲染归一化同规矩）
      role: m.role === "user" ? "user" : "assistant",
      content: m.content,
    }));
  } catch {
    return [];
  }
}