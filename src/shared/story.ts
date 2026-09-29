// 剧情系统契约（5.7）。零依赖：不 import electron，主 / 渲染两侧共用（照 shared/memory.ts）。
// 依据：内部规格 §8.3。5.7.1 只落类型与常量；
// 5.7.2 追加：StoryDoc / StoryContext / STORY_LIMITS + 触发判定与文档消毒纯函数（仍然零依赖）。

/** 触发条件七类（开发规格原文）。weather / pomodoro 本阶段只留接口，不实现（数据源不存在） */
export type TriggerKind = "time" | "weather" | "affection" | "chat" | "task" | "pomodoro" | "mood";

/** 触发条件：kind 是封闭联合；params 是开放键值（具体键由 5.7.2 的触发引擎解释） */
export interface Trigger {
  kind: TriggerKind;
  params: Record<string, string | number | boolean>;
}

export interface Chapter {
  id: string;
  title: string;
  /** 章节顺序（升序推进） */
  order: number;
  entryConditions: Trigger[];
  branchIds: string[];
}

/** 剧情选项：结构化输出的落点（5.7.3）。label 是显示文案，reward 是右侧奖励文案（可空） */
export interface StoryOption {
  id: string;
  label: string;
  /** 选它去哪个节点；AI 生成时可能为空，由 Branch.toNodeId 补 */
  toNodeId?: string;
  reward?: string;
}

export interface Branch {
  id: string;
  chapterId: string;
  /** 从哪个剧情节点分叉（剧情节点，不是消息树节点） */
  fromNodeId: string;
  options: StoryOption[];
  /** 选项未各自指定 toNodeId 时的默认去向 */
  toNodeId?: string;
}

/** 剧情存档：5.7.4 落到「回忆」视图的「剧情存档」框 */
export interface StorySave {
  id: string;
  chapterId: string;
  /** 剧情分支体系里的节点 id（Branch.fromNodeId / toNodeId 那一套） */
  nodeId: string;
  /** 消息树定位：回到这条会话的这个消息节点重走 */
  messageTreeRef: { sessionId: string; nodeId: string };
  at: number;
  schemaVersion: number;
}

export const STORY_SCHEMA_VERSION = 1;

// ==================== 5.7.2 追加：文档形状 + 触发上下文 + 纯逻辑 ====================

/** 落盘整体形状，存主进程 userData 的 story 子目录（路径拼装唯一在 story-store）。三张表一个文件：一次原子写 = 三表永不互踩 */
export interface StoryDoc {
  version: number;
  chapters: Chapter[];
  branches: Branch[];
  saves: StorySave[];
}

/** 触发引擎的输入快照。**全部由调用方填**：纯函数不读时钟、不读盘 */
export interface StoryContext {
  now: number;
  /** 0–100 好感度真值（主进程 relationship store） */
  affection: number;
  /** 当前可见对话路径长度（chats-store，按 activeLeafId 解析后） */
  messageCount: number;
  /** 可见路径上最后一条 user 消息正文；无则 "" */
  lastUserText: string;
  /** 可见路径末节点的时刻；无则 null（idleMinutes 用） */
  lastChatAt: number | null;
  /** 今日已完成任务数（渲染层 app-state 供给） */
  tasksDoneToday: number;
  /** 当前心情 id（app-state 的 character.mood）；无数据源时 "" */
  mood: string;
}

/** 渲染层补给的字段（主进程读不到的那部分）；其余字段由 trigger-engine 装配 */
export interface StoryContextExtras {
  tasksDoneToday?: number;
  mood?: string;
}

export const STORY_LIMITS = {
  maxChapters: 100,
  maxBranchesPerChapter: 50,
  maxSaves: 200,
  maxIdLength: 64,
  maxTitleLength: 60,
  maxLabelLength: 40,
} as const;

// ---------- 触发判定（永不抛错：kind 不认识 / 缺键 / 类型不对 → false） ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** params 里的有限数字；类型不对 / NaN / Infinity → null（= 当缺键） */
function paramNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** "HH:MM" → 当天分钟数；格式不对 / 越界 → null（= 当缺键） */
function parseHhmm(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** time：本地时刻落在窗口内；from > to = 跨零点；只给一个 = 单边；都缺 / 格式不对 → false */
function judgeTime(params: Record<string, unknown>, ctx: StoryContext): boolean {
  const from = parseHhmm(params.from);
  const to = parseHhmm(params.to);
  if (from === null && to === null) return false;
  const d = new Date(ctx.now); // 只吃入参时间戳，不读时钟（shared 层禁止空参读时钟）
  const cur = d.getHours() * 60 + d.getMinutes();
  if (from !== null && to !== null) {
    return from <= to ? cur >= from && cur <= to : cur >= from || cur <= to; // from > to = 跨零点
  }
  if (from !== null) return cur >= from; // 单边：from 之后到当天结束
  return to !== null && cur <= to; // 单边：当天开始到 to 之前
}

/** affection：闭区间 [min, max]；只给一个 = 单边；都缺 → false */
function judgeAffection(params: Record<string, unknown>, ctx: StoryContext): boolean {
  const min = paramNumber(params.min);
  const max = paramNumber(params.max);
  if (min === null && max === null) return false;
  if (min !== null && ctx.affection < min) return false;
  if (max !== null && ctx.affection > max) return false;
  return true;
}

/** chat：三键 AND（contains 小写子串 / minMessages / idleMinutes）；全缺 → false */
function judgeChat(params: Record<string, unknown>, ctx: StoryContext): boolean {
  const contains =
    typeof params.contains === "string" && params.contains !== "" ? params.contains.toLowerCase() : null;
  const minMessages = paramNumber(params.minMessages);
  const idleMinutes = paramNumber(params.idleMinutes);
  if (contains === null && minMessages === null && idleMinutes === null) return false;
  if (contains !== null && !ctx.lastUserText.toLowerCase().includes(contains)) return false;
  if (minMessages !== null && ctx.messageCount < minMessages) return false;
  if (idleMinutes !== null) {
    if (ctx.lastChatAt === null) return false; // 没有聊天记录 → 谈不上「多久没聊」
    if (ctx.now - ctx.lastChatAt < idleMinutes * 60000) return false;
  }
  return true;
}

/** task：minDoneToday ≤ tasksDoneToday；缺 → false */
function judgeTask(params: Record<string, unknown>, ctx: StoryContext): boolean {
  const minDoneToday = paramNumber(params.minDoneToday);
  if (minDoneToday === null) return false;
  return ctx.tasksDoneToday >= minDoneToday;
}

/** mood：与 ctx.mood 全等；缺 / ctx.mood 为空 → false */
function judgeMood(params: Record<string, unknown>, ctx: StoryContext): boolean {
  const is = typeof params.is === "string" ? params.is : null;
  if (is === null || ctx.mood === "") return false;
  return ctx.mood === is;
}

/** 分派；取值全部用 typeof 收口，真判定在各 judge* 里 */
function judge(trigger: Trigger, ctx: StoryContext): boolean {
  const kind: unknown = trigger.kind;
  const params: Record<string, unknown> = isRecord(trigger.params) ? trigger.params : {};
  switch (kind) {
    case "time":
      return judgeTime(params, ctx);
    case "affection":
      return judgeAffection(params, ctx);
    case "chat":
      return judgeChat(params, ctx);
    case "task":
      return judgeTask(params, ctx);
    case "mood":
      return judgeMood(params, ctx);
    case "weather":
    case "pomodoro":
      return false; // 本阶段无数据源：恒假是约定（清单要求 2），别为它俩造假数据源
    default:
      return false; // kind 不认识（脏数据）
  }
}

/** 单条条件判定。**永不抛错**：kind 不认识 / 缺键 / 类型不对 → false */
export function evaluateTrigger(trigger: Trigger, ctx: StoryContext): boolean {
  try {
    return judge(trigger, ctx);
  } catch {
    return false; // 兜底：它跑在事件回调里，抛错会打断聊天 onDone（5.7.2 坑 3）
  }
}

/** entryConditions 的语义 = **全部满足**（AND）。**空数组 = 恒真**（无条件章节） */
export function evaluateTriggers(triggers: Trigger[], ctx: StoryContext): boolean {
  if (!Array.isArray(triggers)) return false; // 脏数据防御（IPC 形状不可信）
  return triggers.every((t) => evaluateTrigger(t, ctx));
}

/** 命中的章节，按 order 升序（order 相同按 title 升序，保证结果稳定） */
export function matchedChapters(chapters: Chapter[], ctx: StoryContext): Chapter[] {
  if (!Array.isArray(chapters)) return [];
  return chapters
    .filter((c) => evaluateTriggers(c.entryConditions, ctx))
    .sort((a, b) => a.order - b.order || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}

// ---------- 文档消毒（IPC 入参 / 磁盘脏数据共用唯一入口；坏条目丢条不整份判死） ----------

const TRIGGER_KINDS: readonly TriggerKind[] = ["time", "weather", "affection", "chat", "task", "pomodoro", "mood"];

/** 非空 string 才收（可选字段：给了空串当没给） */
function pickNonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Trigger 消毒：kind 不在七类白名单 → null（丢该条）；params 非对象 → {}；值只留 string / number / boolean */
function sanitizeTrigger(v: unknown): Trigger | null {
  if (!isRecord(v)) return null;
  const kind = pickNonEmptyString(v.kind);
  if (kind === null || !TRIGGER_KINDS.includes(kind as TriggerKind)) return null;
  const params: Record<string, string | number | boolean> = {};
  if (isRecord(v.params)) {
    for (const [key, val] of Object.entries(v.params)) {
      if (typeof val === "string" || typeof val === "boolean") params[key] = val;
      else if (typeof val === "number" && Number.isFinite(val)) params[key] = val; // NaN / Infinity 丢（落盘会变 null）
    }
  }
  return { kind: kind as TriggerKind, params };
}

/** 选项逐条消毒：id / label 必填（label 截 maxLabelLength）；toNodeId / reward 可选 string（空串当没给） */
function sanitizeOptions(v: unknown): StoryOption[] {
  if (!Array.isArray(v)) return [];
  const out: StoryOption[] = [];
  for (const item of v) {
    if (!isRecord(item)) continue;
    const id = pickNonEmptyString(item.id);
    const label = pickNonEmptyString(item.label);
    if (id === null || label === null) continue;
    const option: StoryOption = { id, label: label.slice(0, STORY_LIMITS.maxLabelLength) };
    const toNodeId = pickNonEmptyString(item.toNodeId);
    if (toNodeId !== null) option.toNodeId = toNodeId;
    const reward = pickNonEmptyString(item.reward);
    if (reward !== null) option.reward = reward;
    out.push(option);
  }
  return out;
}

/** 消毒整份文档（IPC 入参 / 磁盘脏数据共用唯一入口）。坏条目**丢条不整份判死** */
export function sanitizeStoryDoc(raw: unknown, now: number): StoryDoc {
  const rawDoc = isRecord(raw) ? raw : {};
  const version = paramNumber(rawDoc.version) ?? STORY_SCHEMA_VERSION;

  // ---- 章节：id / title 非空 string 才收（title 截断）；order 非有限数 → 数组下标；去重保首现；截 maxChapters ----
  const rawChapters = Array.isArray(rawDoc.chapters) ? rawDoc.chapters : [];
  const usedChapterIds = new Set<string>();
  const chapters: Chapter[] = [];
  for (let i = 0; i < rawChapters.length && chapters.length < STORY_LIMITS.maxChapters; i++) {
    const item = rawChapters[i];
    if (!isRecord(item)) continue;
    const id = pickNonEmptyString(item.id);
    const title = pickNonEmptyString(item.title);
    if (id === null || title === null) continue;
    if (usedChapterIds.has(id)) continue; // 按 id 去重（保首现）
    usedChapterIds.add(id);
    const entryConditions: Trigger[] = [];
    if (Array.isArray(item.entryConditions)) {
      for (const t of item.entryConditions) {
        const cleaned = sanitizeTrigger(t);
        if (cleaned !== null) entryConditions.push(cleaned);
      }
    }
    const declared: string[] = [];
    if (Array.isArray(item.branchIds)) {
      for (const b of item.branchIds) {
        const bid = pickNonEmptyString(b);
        if (bid !== null && !declared.includes(bid)) declared.push(bid);
      }
    }
    chapters.push({
      id,
      title: title.slice(0, STORY_LIMITS.maxTitleLength),
      order: paramNumber(item.order) ?? i, // 缺失 / 非有限数 → 数组下标
      entryConditions,
      branchIds: declared, // 真实存在性过滤等分支表消毒完后统一做（见下）
    });
  }

  // ---- 分支：三字段非空 string 才收；chapterId 指向不存在的章节 → 丢该分支（分支是章节的从属内容）；
  //      去重保首现；每章截 maxBranchesPerChapter ----
  const rawBranches = Array.isArray(rawDoc.branches) ? rawDoc.branches : [];
  const usedBranchIds = new Set<string>();
  const perChapterCount = new Map<string, number>();
  const branches: Branch[] = [];
  for (const item of rawBranches) {
    if (!isRecord(item)) continue;
    const id = pickNonEmptyString(item.id);
    const chapterId = pickNonEmptyString(item.chapterId);
    const fromNodeId = pickNonEmptyString(item.fromNodeId);
    if (id === null || chapterId === null || fromNodeId === null) continue;
    if (!usedChapterIds.has(chapterId)) continue; // 孤儿分支丢
    if (usedBranchIds.has(id)) continue;
    const count = perChapterCount.get(chapterId) ?? 0;
    if (count >= STORY_LIMITS.maxBranchesPerChapter) continue;
    usedBranchIds.add(id);
    perChapterCount.set(chapterId, count + 1);
    const branch: Branch = { id, chapterId, fromNodeId, options: sanitizeOptions(item.options) };
    const toNodeId = pickNonEmptyString(item.toNodeId);
    if (toNodeId !== null) branch.toNodeId = toNodeId;
    branches.push(branch);
  }

  // Chapter.branchIds 只保留**真实存在**的分支 id（不许留指向幽灵分支的悬空 id）
  const branchIdSet = new Set(branches.map((b) => b.id));
  for (const ch of chapters) {
    ch.branchIds = ch.branchIds
      .filter((bid) => branchIdSet.has(bid))
      .slice(0, STORY_LIMITS.maxBranchesPerChapter);
  }

  // ---- 存档：四字段形状校验；**chapterId 指向不存在的章节也保留**（章节可能被重新导入，存档是用户资产）；
  //      at 非有限数 → now；schemaVersion 一律写 1；去重保首现；按 at 降序截 maxSaves（保最新） ----
  const rawSaves = Array.isArray(rawDoc.saves) ? rawDoc.saves : [];
  const usedSaveIds = new Set<string>();
  const saves: StorySave[] = [];
  for (const item of rawSaves) {
    if (!isRecord(item)) continue;
    const id = pickNonEmptyString(item.id);
    const chapterId = pickNonEmptyString(item.chapterId);
    const nodeId = pickNonEmptyString(item.nodeId);
    if (id === null || chapterId === null || nodeId === null) continue;
    const ref = isRecord(item.messageTreeRef) ? item.messageTreeRef : null;
    const sessionId = ref === null ? null : pickNonEmptyString(ref.sessionId);
    const refNodeId = ref === null ? null : pickNonEmptyString(ref.nodeId);
    if (sessionId === null || refNodeId === null) continue;
    if (usedSaveIds.has(id)) continue;
    usedSaveIds.add(id);
    saves.push({
      id,
      chapterId,
      nodeId,
      messageTreeRef: { sessionId, nodeId: refNodeId },
      at: paramNumber(item.at) ?? now,
      schemaVersion: STORY_SCHEMA_VERSION,
    });
  }
  saves.sort((a, b) => b.at - a.at);
  saves.splice(STORY_LIMITS.maxSaves); // 保最新（超出部分丢最旧）

  return { version, chapters, branches, saves };
}

// ==================== 5.7.3.2 追加：生成契约 + 纯逻辑 ====================
// 依据：内部规格 §3.1（契约逐字照抄）。
// 仍然零依赖：不 import electron / 不读盘 / 不读时钟（clock 由主进程格式化后当入参传）。

/** 一次生成的结构化产出（schema 的落点，也是列表卡的数据源） */
export interface GeneratedScene {
  /** 场景文案（AI 生成；由渲染层追加成一条 assistant 消息） */
  scene: string;
  options: StoryOption[];
}

/** 生成请求（渲染层 → 主进程，走 IPC STORY_GENERATE） */
export interface StoryGenerateRequest {
  chapterId: string;
  /** 当前剧情节点 id；缺省 = 该章节入口节点（见 entryNodeId） */
  nodeId?: string;
  extras?: StoryContextExtras;
}

/** 生成结果（主进程 → 渲染层）。ok=false 时渲染层**退回纯文本、不许画卡** */
export interface StoryGenerateResult {
  ok: boolean;
  chapterId: string;
  /** 落库后的分支（ok=true 时非空） */
  branch: Branch | null;
  /** 场景 + 选项（ok=true 时非空） */
  scene: GeneratedScene | null;
  /** ok=false 时的人话原因（供日志 / 提示） */
  reason: string;
}

/** 生成用的 JSON Schema（三档共用）。**strict 模式要求 required 列全**，故 reward 必填、无奖励给空串；
 *  每个 object 都带 additionalProperties: false（漏了 json_schema 档会被厂商 400）。 */
export const STORY_SCENE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["scene", "options"],
  properties: {
    scene: { type: "string", description: "2–4 句中文场景描述（她此刻正在说的话与情境）" },
    options: {
      type: "array",
      minItems: 1,
      maxItems: 4,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "reward"],
        properties: {
          id: { type: "string", description: "稳定短 id，如 o1 / o2" },
          label: { type: "string", description: "选项文案（≤40 字，用户口吻）" },
          reward: { type: "string", description: "右侧奖励文案；没有就填空串" },
        },
      },
    },
  },
};

/** 章节入口节点 id：chapter.branchIds 里**首个能找到的分支**的 fromNodeId；都找不到 → `${chapterId}#entry`。纯函数 */
export function entryNodeId(chapter: Chapter, branches: Branch[]): string {
  const declared = Array.isArray(chapter?.branchIds) ? chapter.branchIds : [];
  const list = Array.isArray(branches) ? branches : [];
  for (const bid of declared) {
    const found = list.find((b) => b.id === bid); // 首个「真实存在」的分支（悬空 id 跳过）
    if (found) return found.fromNodeId;
  }
  return `${chapter.id}#entry`; // 章节刚建 / 无分支 → 入口占位 id
}

/** 拼生成指令（纯函数）。clock 是**本地 "HH:MM"**，由主进程格式化后传入（shared 层不许读时钟）。
 *  **不许写死任何剧情内容**（清单要求 4「不写死」）：只给章节标题 + 上下文数值 + 硬要求。 */
export function buildStoryInstruction(chapter: Chapter, ctx: StoryContext, clock: string): string {
  const lines: string[] = [
    "你是这部互动剧情的编剧。请为当前章节写一小段场景（她此刻正在说的话与情境），并给出用户可选的下一步选项。",
    `章节标题：${chapter.title}`,
    `当前好感度：${ctx.affection}`,
  ];
  if (ctx.mood !== "") lines.push(`当前心情：${ctx.mood}`); // 空则不写
  lines.push(`可见消息数：${ctx.messageCount}`, `今日完成任务数：${ctx.tasksDoneToday}`, `当前本地时刻：${clock}`);
  if (ctx.lastUserText !== "") lines.push(`最后一条用户消息：${ctx.lastUserText}`); // 空则不写
  lines.push(
    "硬性要求：",
    "1. 全部使用中文。",
    "2. scene 写 2–4 句场景描述。",
    "3. options 给 2–3 条，用用户口吻，label 不超过 40 字。",
    "4. id 依次用 o1 / o2 / o3。",
    "5. reward 是右侧奖励文案，没有就给空串。",
    "只输出 JSON。",
  );
  return lines.join("\n");
}

/** 校验并归一结构化产出 → GeneratedScene | null。**永不抛错**（坏数据一律 null —— 它跑在 IPC handler 里） */
export function sanitizeGeneratedScene(raw: unknown): GeneratedScene | null {
  try {
    if (!isRecord(raw)) return null;

    // scene 是卡片主体，不能缺：非 string / trim 后为空 → 整份判死
    const scene = typeof raw.scene === "string" ? raw.scene.trim() : "";
    if (scene === "") return null;

    if (!Array.isArray(raw.options)) return null;

    const options: StoryOption[] = [];
    const usedIds = new Set<string>();
    for (const item of raw.options) {
      if (!isRecord(item)) continue;
      const id = pickNonEmptyString(item.id);
      const label = pickNonEmptyString(item.label);
      if (id === null || label === null) continue; // id / label 都非空 string 才收
      const cleanId = id.slice(0, STORY_LIMITS.maxIdLength);
      if (usedIds.has(cleanId)) continue; // 按 id 去重（保首现）
      usedIds.add(cleanId);
      const option: StoryOption = { id: cleanId, label: label.slice(0, STORY_LIMITS.maxLabelLength) };
      const reward = pickNonEmptyString(item.reward); // 空串 / 非 string → 该字段不出现
      if (reward !== null) option.reward = reward;
      const toNodeId = pickNonEmptyString(item.toNodeId); // 本阶段生成不会给，允许缺
      if (toNodeId !== null) option.toNodeId = toNodeId;
      options.push(option);
    }

    if (options.length === 0) return null; // 没有选项的剧情没意义
    return { scene, options: options.slice(0, 4) }; // > 4 截前 4（schema 上限同值）
  } catch {
    return null;
  }
}