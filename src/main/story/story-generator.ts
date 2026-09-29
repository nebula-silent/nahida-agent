// 5.7.3.2：剧情生成编排（主进程）。⚠️ 顶层 import story-store / trigger-engine（它们顶层 import electron），
// **不许被 tests/ import**
// 依据：内部规格 §3.4
// 链路：readStoryDoc 找章节 → 装配上下文 → runStructured（三档）→ sanitizeGeneratedScene → upsertChapter 落分支。
// 注意：生成**不走对话链路**（那会注入好感度语气前缀 + 工具循环；这里是数据生成，好感度只当上下文数据）。
import { randomUUID } from "crypto";
import { IPC } from "../../shared/ipc-channels";
import {
  STORY_SCENE_SCHEMA,
  buildStoryInstruction,
  entryNodeId,
  sanitizeGeneratedScene,
  type Branch,
  type StoryGenerateRequest,
  type StoryGenerateResult,
} from "../../shared/story";
import { runStructured } from "../provider/structured";
import { readStoryDoc, upsertChapter } from "./story-store";
import { buildStoryContext, recentVisibleMessages } from "./trigger-engine";

/** 失败结果统一形状（**永不抛错**：所有异常都收成 ok:false + 人话 reason） */
function fail(chapterId: string, reason: string): StoryGenerateResult {
  return { ok: false, chapterId, branch: null, scene: null, reason };
}

/** 本地 "HH:MM"。只有主进程能读时钟 —— shared/story.ts 的 buildStoryInstruction 吃入参 */
function formatClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 生成一章的场景与选项。**永不抛错**：任何失败 → ok:false（跑在 IPC handler 里，抛错会变 rejected promise） */
export async function generateScene(req: StoryGenerateRequest, signal?: AbortSignal): Promise<StoryGenerateResult> {
  const chapterId = typeof req?.chapterId === "string" ? req.chapterId : "";
  try {
    // dir 走 app.getPath("userData")：函数体内 require（照 relationship-store :100 范本）
    const { app } = require("electron") as typeof import("electron");
    const dir = app.getPath("userData"); // 子目录由 story-store 内部拼，这里不许出现路径字面量

    const doc = readStoryDoc(dir);
    const chapter = doc.chapters.find((c) => c.id === chapterId);
    if (!chapter) return fail(chapterId, "章节不存在"); // 章节是用户/导入资产，不许凭空建

    const ctx = buildStoryContext(req.extras);
    const nodeId = req.nodeId?.trim() || entryNodeId(chapter, doc.branches);
    const clock = formatClock(new Date());
    const messages = recentVisibleMessages(10); // 读不出来 → []，生成照跑

    const r = await runStructured({
      request: {
        schema: STORY_SCENE_SCHEMA,
        name: "story_scene", // OpenAI 要求 ^[a-zA-Z0-9_-]+$，不许中文
        instruction: buildStoryInstruction(chapter, ctx, clock),
      },
      messages,
      signal,
    });
    if (!r.ok) return fail(chapter.id, r.reason); // 失败不写盘（sanitize 通过前绝不 upsertChapter）

    const scene = sanitizeGeneratedScene(r.value);
    if (scene === null) return fail(chapter.id, "模型未给出合法的场景与选项");

    // 每次生成必新建分支（不去重 —— 同一章节重复触发会有多条分支，有意：用户可以重来）
    const branchId = randomUUID();
    const incoming: Branch = { id: branchId, chapterId: chapter.id, fromNodeId: nodeId, options: scene.options };
    upsertChapter(dir, {
      // 必须把新分支 id 补进 branchIds，否则消毒的孤儿处理会把它从章节里剔掉（坑 5）
      chapter: { ...chapter, branchIds: [...chapter.branchIds, branchId] },
      branches: [incoming],
    });
    // 返回落库后的那条（消毒可能与入参有差异，如空 reward 被丢）
    const branch = readStoryDoc(dir).branches.find((b) => b.id === branchId) ?? null;

    console.log(
      `[nahida] story generate chapter=${chapter.id} node=${nodeId} options=${scene.options.length} tier=${r.tier}`,
    );
    return { ok: true, chapterId: chapter.id, branch, scene, reason: "" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "剧情生成失败";
    console.warn(`[nahida] story generate 未预期错误：${reason}`);
    return fail(chapterId, reason);
  }
}

/** 挂 IPC.STORY_GENERATE（在 main\index.ts 里单独调，别塞进 registerStoryHandlers —— 会形成 import 环） */
export function registerStoryGenerateHandler(): void {
  // 函数体内 require（TS 编译目标 CJS）；vitest 不会进这里，因此不会拉起 electron
  const { ipcMain } = require("electron") as typeof import("electron");
  ipcMain.handle(IPC.STORY_GENERATE, (_event, req: unknown) => generateScene(req as StoryGenerateRequest));
}