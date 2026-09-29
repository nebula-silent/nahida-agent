// 5.7.2：剧情存档 store（三张表一个文件；真相在主进程，渲染层只拿投影）
// 依据：内部规格 §3.2
// 结构照 long-term-store.ts（5.1.2）：
//   · 读写纯函数只吃显式 dir 参数，**运行时不 import electron** —— registerStoryHandlers 函数体内
//     require，保证本模块被 vitest / 其他模块 import 时不会拉起 electron
//   · "story" / "story.json" 两个路径字面量只在本文件内部出现（IPC 层与渲染层零出现，指令 §2.4）
//   · 损坏备份名用 .corrupt，**别用 .tmp**（会与 atomicWriteJson 的 .tmp 撞名互踩，long-term-store 同款教训）
// 注：STORY_EVALUATE 的 handler 也在这里注册，delegate 给 trigger-engine（函数体内延迟 require ——
//     trigger-engine 顶层 import 本文件，静态互引会绕成模块初始化环）。
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { IPC } from "../../shared/ipc-channels";
import {
  STORY_SCHEMA_VERSION,
  sanitizeStoryDoc,
  type Chapter,
  type StoryContextExtras,
  type StoryDoc,
  type StorySave,
} from "../../shared/story";
import { atomicWriteJson } from "../storage/json-file";

// ==================== 落盘路径（唯一拼装处） ====================

function storyFile(dir: string): string {
  return path.join(dir, "story", "story.json");
}

// ==================== 小工具 ====================

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 非空 string 才收（空串当没给，与 shared/story.ts 同名规则一致） */
function pickNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function emptyDoc(): StoryDoc {
  return { version: STORY_SCHEMA_VERSION, chapters: [], branches: [], saves: [] };
}

// ==================== 读 / 写（消毒唯一入口在 shared/story.ts） ====================

/** 读 story.json：不存在 = 空档（**不预创建空文件**）；解析失败 = 备份 .corrupt 后回落空档（绝不静默删用户数据） */
export function readStoryDoc(dir: string): StoryDoc {
  const file = storyFile(dir);
  let raw: unknown;
  try {
    if (!fs.existsSync(file)) return emptyDoc();
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.warn("[story] story.json 解析失败，原文件已备份为 story.json.corrupt:", err);
    try {
      fs.renameSync(file, file + ".corrupt"); // 备份名别用 .tmp 中转（见文件头注释）
    } catch (renameErr) {
      console.warn("[story] story.json.corrupt 备份失败（文件可能已被移走）:", renameErr);
    }
    return emptyDoc();
  }
  return sanitizeStoryDoc(raw, Date.now());
}

/** 写 story.json：整体原子写（三张表一起写，不做增量合并）；返回消毒后的真相 */
export function writeStoryDoc(dir: string, input: unknown): StoryDoc {
  const cleaned = sanitizeStoryDoc(input, Date.now());
  const file = storyFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true }); // atomicWriteJson 不做 mkdir，漏了首次写盘 ENOENT
  atomicWriteJson(file, cleaned);
  return cleaned;
}

// ==================== 查询 ====================

/** 按 order 升序（order 相同保持表内先后 —— sort 稳定） */
export function listChapters(dir: string): Chapter[] {
  return readStoryDoc(dir).chapters
    .slice()
    .sort((a, b) => a.order - b.order);
}

/** 按 at 降序 */
export function listSaves(dir: string): StorySave[] {
  return readStoryDoc(dir).saves
    .slice()
    .sort((a, b) => b.at - a.at);
}

// ==================== 写入 ====================

/** upsert 一章 + 它的分支（同 id 覆盖，新 id 追加）；返回消毒后的**全部**章节（按 order 升序）。
 *  chapter.id 缺失 → 现生成；branches[].chapterId **一律覆盖**成该章节 id（不信任入参，防串章 —— 坑 5）。
 *  形状不合（如缺 title）→ 整条被消毒丢掉 → 不落盘，返回现有章节。 */
export function upsertChapter(dir: string, input: unknown): Chapter[] {
  const raw = isRecord(input) ? input : {};
  const rawChapter = isRecord(raw.chapter) ? raw.chapter : {};
  const id = pickNonEmptyString(rawChapter.id) ?? randomUUID(); // id 缺失 → 现生成
  const rawBranches = Array.isArray(raw.branches) ? raw.branches : [];
  const incoming: Record<string, unknown>[] = [];
  for (const b of rawBranches) {
    if (isRecord(b)) incoming.push({ ...b, chapterId: id }); // chapterId 一律覆盖成该章节 id
  }
  const incomingIds = new Set<string>();
  for (const b of incoming) {
    const bid = b.id;
    if (typeof bid === "string" && bid !== "") incomingIds.add(bid);
  }

  const doc = readStoryDoc(dir);
  const cleanedChapter: Record<string, unknown> = { ...rawChapter, id };
  // merged 不标 StoryDoc：chapters / branches 里带着未消毒的原始项，交给 sanitizeStoryDoc 当 unknown 收
  const merged = {
    version: doc.version,
    chapters: [...doc.chapters.filter((c) => c.id !== id), cleanedChapter], // 同 id 覆盖
    branches: [...doc.branches.filter((b) => !incomingIds.has(b.id)), ...incoming], // 同 id 覆盖，新 id 追加
    saves: doc.saves, // 三张表一个文件：存档原样带着，绝不因 upsert 章节被清掉
  };
  const cleaned = sanitizeStoryDoc(merged, Date.now());
  if (!cleaned.chapters.some((c) => c.id === id)) return listChapters(dir); // 形状不合 → 不落盘，返回现状
  const saved = writeStoryDoc(dir, cleaned); // 二次消毒无妨（幂等），写盘 + mkdir 都走这一条路
  return saved.chapters.slice().sort((a, b) => a.order - b.order);
}

/** 落一条存档：入参只吃 { chapterId, nodeId, messageTreeRef }；id / at / schemaVersion 由 store 生成覆盖
 *  （IPC 入参不可信）。形状不合 → null（不落盘）；chapterId **不校验章节是否存在**（存档是用户资产）。
 *  messageTreeRef 只做**形状**校验，不 import chats-store 查节点 —— 两个 store 不许焊死（坑 4）。 */
export function createSave(dir: string, input: unknown): StorySave | null {
  if (!isRecord(input)) return null;
  const chapterId = pickNonEmptyString(input.chapterId);
  const nodeId = pickNonEmptyString(input.nodeId);
  const ref = isRecord(input.messageTreeRef) ? input.messageTreeRef : null;
  const sessionId = ref === null ? null : pickNonEmptyString(ref.sessionId);
  const refNodeId = ref === null ? null : pickNonEmptyString(ref.nodeId);
  if (chapterId === null || nodeId === null || sessionId === null || refNodeId === null) return null;

  const save: StorySave = {
    id: randomUUID(), // 入参的 id 一律不认
    chapterId,
    nodeId,
    messageTreeRef: { sessionId, nodeId: refNodeId },
    at: Date.now(),
    schemaVersion: STORY_SCHEMA_VERSION,
  };
  const doc = readStoryDoc(dir);
  const cleaned = writeStoryDoc(dir, { ...doc, saves: [...doc.saves, save] });
  return cleaned.saves.find((s) => s.id === save.id) ?? null; // 被 maxSaves 截掉时如实返回 null
}

/** 真删掉了返回 true；id 不存在 / 非法 → false（不落盘） */
export function deleteSave(dir: string, id: string): boolean {
  if (typeof id !== "string" || id === "") return false;
  const doc = readStoryDoc(dir);
  const next = doc.saves.filter((s) => s.id !== id);
  if (next.length === doc.saves.length) return false; // id 不存在 → 不写盘
  writeStoryDoc(dir, { ...doc, saves: next });
  return true;
}

// ==================== IPC 注册（唯一碰 electron 的地方） ====================

export function registerStoryHandlers(): void {
  // 函数体内 require（TS 编译目标 CJS）：dist 里运行时取到真 electron；
  // vitest / 其他模块 import 本文件时永远不进这里，因此不会拉起 electron
  const { app, ipcMain } = require("electron") as typeof import("electron");
  const dir = app.getPath("userData"); // dir 语义 = userData 本身（照 long-term-store 范本），
  // "story" 子目录由 storyFile 内部拼 —— 这里若再 join 一层会出双层嵌套目录

  // 六个 handler 返回的必须是**消毒后的新对象**（store 内部数组引用不直接吐给 IPC）
  ipcMain.handle(IPC.STORY_LIST_CHAPTERS, () => listChapters(dir));
  ipcMain.handle(IPC.STORY_UPSERT_CHAPTER, (_event, input: unknown) => upsertChapter(dir, input));
  ipcMain.handle(IPC.STORY_EVALUATE, (_event, extras: unknown) => {
    // 延迟 require：trigger-engine 顶层 import 本文件（readStoryDoc），静态互引会绕成模块初始化环
    const engine = require("./trigger-engine") as typeof import("./trigger-engine");
    return engine.evaluateChapters(isRecord(extras) ? (extras as StoryContextExtras) : undefined);
  });
  ipcMain.handle(IPC.STORY_LIST_SAVES, () => listSaves(dir));
  ipcMain.handle(IPC.STORY_CREATE_SAVE, (_event, input: unknown) => createSave(dir, input));
  ipcMain.handle(IPC.STORY_DELETE_SAVE, (_event, id: unknown) =>
    deleteSave(dir, typeof id === "string" ? id : ""),
  );
}