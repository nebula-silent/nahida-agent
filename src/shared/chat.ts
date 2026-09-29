// 聊天链路的共享类型与常量（主进程 / preload / 渲染进程共用）
// 3.6 起：默认模型常量仍在此处（request-context.ts 消费）；地址常量已删 ——
// 厂商地址唯一真相在 src/shared/provider/presets.ts 的 ollama 条目，留两份会漂移
import type { ToolCall } from "./tool-call";

export const DEFAULT_MODEL = "qwen2.5:7b";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** 4.1.1：assistant 上的工具调用（三协议各自翻译成自己的 wire） */
  toolCalls?: ToolCall[];
  /** 4.1.1：role:"tool" 的回填锚点。OpenAI 用 tool_call_id / Anthropic 用 tool_use_id */
  toolCallId?: string;
  /** 4.1.1：role:"tool" 的工具名。**Ollama 只认这个字段**（它没有 tool_call_id） */
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** 6.3：发起这轮对话时的角色心情快照（app-state character.mood）。可选：不传/脏值 = 本轮不注入心情 */
  mood?: string;
  /** 7.4：渲染层当前模式。只有 "work" 才给全量工具 + 审批通道；"lite"（9.x 悬浮球轻量档）
   *  给审批通道但只放行联网三件套；聊天态（不传/脏值）= 不启用工具（approve 不给 → tools=[]） */
  mode?: "chat" | "work" | "lite";
}

// ==================== 对话存储（3.3）====================
// 传输形状（上面）与落盘形状（下面）刻意分开：id / at 不发进模型请求，
// 消息树父子指针（5.7）也不污染传输层。

/** 消息树节点（5.7）。落盘形状 + 父子指针：线性对话 = 每个节点只有一个子节点 */
export interface MessageNode {
  id: string;
  /** null = 该会话的根；**这是唯一真相** */
  parentId: string | null;
  /** **派生索引**：落盘写、读盘按 parentId 重建覆盖（防漂移） */
  childrenIds: string[];
  role: ChatRole;
  content: string;
  /** 毫秒时间戳 */
  at: number;
  /** 所属剧情分支（5.7.3 写）；线性对话不写 */
  branchId?: string;
}

/** 完整体，存 sessions/<id>.json。messages 是**扁平节点表**（按 at 排），不再是线性历史 */
export interface ChatSession {
  id: string;
  title: string;
  /** 用户改过名 → deriveTitle 不再覆盖（5.5.1）。缺省 / false = 标题仍跟首条用户消息走 */
  titleLocked?: boolean;
  /** 9.1：本对话绑定的目录（聊天视图头选择，fs 工具白名单并集用）。
   *  缺省 = 未选择（新对话的初始状态）；空串不落盘（清除 = 删字段） */
  workDir?: string;
  messages: MessageNode[];
  /** 当前分支的末节点；null = 空会话。续写挂它，切分支改它。可见历史 = resolvePath(messages, activeLeafId) */
  activeLeafId: string | null;
  createdAt: number;
  updatedAt: number;
  schemaVersion: number;
}

/** 索引项（不含 messages），存 index.json —— 列表渲染只读它 */
export interface ChatSessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export const CHAT_SCHEMA_VERSION = 2;

// ==================== 历史对话搜索（跨会话全文匹配）====================

/** 单条搜索命中：定位到「哪个会话的哪个节点」，snippet 是渲染层直接展示的片段 */
export interface ChatSearchHit {
  sessionId: string;
  sessionTitle: string;
  nodeId: string;
  role: "user" | "assistant";
  /** 毫秒时间戳（排序 / 展示用） */
  at: number;
  /** 命中点前后各留白的高亮片段（已转义交给渲染层包 <mark>？不 —— 这里给原文，转义在渲染层） */
  snippet: string;
  /** 命中词在 snippet 里的偏移（渲染层高亮用） */
  matchStart: number;
  matchLength: number;
}

export interface ChatSearchResult {
  hits: ChatSearchHit[];
  /** 命中的会话数（去重） */
  sessionCount: number;
  /** true = 结果超出上限被截断（提示用户加关键词收窄） */
  truncated: boolean;
}

/** 会话默认标题。文案集中在这里，将来接文案层时统一搬走，不要散落在渲染代码里 */
export const DEFAULT_SESSION_TITLE = "新对话";

// ==================== 消息树纯函数（5.7）====================
// 零依赖、不读时钟（读时钟会让单测造不出确定时间）：主进程读盘 / 渲染层重建 / 单测共用。

/** 可见路径：从 leafId 沿 parentId 上溯到根，返回**根→叶**顺序。纯函数 */
export function resolvePath(nodes: MessageNode[], leafId: string | null): MessageNode[] {
  if (typeof leafId !== "string" || !leafId) return [];
  const byId = new Map<string, MessageNode>();
  for (const n of nodes) byId.set(n.id, n);
  const path: MessageNode[] = [];
  let cursor: MessageNode | undefined = byId.get(leafId);
  let steps = 0;
  // 上溯防环：步数上限 = 表长（用户能手改 json 造出环），超了就截断返回，不许抛错
  while (cursor !== undefined && steps < nodes.length) {
    path.push(cursor);
    steps += 1;
    const parentId: string | null = cursor.parentId;
    cursor = parentId === null ? undefined : byId.get(parentId);
  }
  path.reverse();
  return path;
}

/** 把 JSON.parse 出来的任意值规范成 ChatSession（含 v1 → v2 升级）。不可救返回 null。纯函数 */
export function normalizeSession(raw: unknown): ChatSession | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const id = s.id;
  const title = s.title;
  const createdAt = s.createdAt;
  const updatedAt = s.updatedAt;
  const rawMessages = s.messages;
  if (typeof id !== "string" || !id) return null;
  if (typeof title !== "string" || !title) return null;
  if (typeof createdAt !== "number") return null;
  if (typeof updatedAt !== "number") return null;
  if (!Array.isArray(rawMessages)) return null;

  // 逐节点校验：坏节点直接丢（不整份判死）；parentId 先原样收着，下面统一裁决
  const nodes: MessageNode[] = [];
  for (const item of rawMessages) {
    if (!item || typeof item !== "object") continue;
    const n = item as Record<string, unknown>;
    const nodeId = n.id;
    const role = n.role;
    const content = n.content;
    const at = n.at;
    if (typeof nodeId !== "string" || !nodeId) continue;
    if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") continue;
    if (typeof content !== "string") continue;
    if (typeof at !== "number") continue;
    const parent = n.parentId;
    const node: MessageNode = {
      id: nodeId,
      parentId: typeof parent === "string" ? parent : null,
      childrenIds: [],
      role,
      content,
      at,
    };
    if (typeof n.branchId === "string") node.branchId = n.branchId; // 5.7.3 的分支标记，读盘必须保住
    nodes.push(node);
  }

  const byId = new Map<string, MessageNode>();
  for (const n of nodes) byId.set(n.id, n);
  const version = typeof s.schemaVersion === "number" ? s.schemaVersion : 0;
  if (version < 2) {
    // v1 升级：旧文件没有 parentId / activeLeafId，按数组顺序线性链接（第 i 个挂第 i-1 个）
    for (let i = 0; i < nodes.length; i++) nodes[i].parentId = i === 0 ? null : nodes[i - 1].id;
  } else {
    // parentId 是唯一真相：能在本表里找到才保留；断链 / 指向自己 → 置 null（自愈，不丢节点）
    for (const n of nodes) {
      if (n.parentId !== null && (n.parentId === n.id || !byId.has(n.parentId))) n.parentId = null;
    }
  }

  // childrenIds 一律按 parentId 重建（忽略文件里的值，防漂移）
  for (const n of nodes) {
    if (n.parentId === null) continue;
    byId.get(n.parentId)?.childrenIds.push(n.id);
  }

  // activeLeafId：缺失 / 不是 string / 表里找不到 → 回落 at 最大的节点（并列取靠后的 = v1 的「最后一条」）；表空 → null
  let activeLeafId: string | null = null;
  if (typeof s.activeLeafId === "string" && byId.has(s.activeLeafId)) {
    activeLeafId = s.activeLeafId;
  } else {
    let maxAt = -Infinity;
    for (const n of nodes) {
      if (n.at >= maxAt) {
        maxAt = n.at;
        activeLeafId = n.id;
      }
    }
  }

  const session: ChatSession = {
    id,
    title,
    messages: nodes,
    activeLeafId,
    createdAt,
    updatedAt,
    schemaVersion: CHAT_SCHEMA_VERSION, // 内存里一律升级成 2；写盘由下一次写操作完成
  };
  if (s.titleLocked === true) session.titleLocked = true; // 5.5.1 的改名保护必须随读随留
  if (typeof s.workDir === "string" && s.workDir !== "") session.workDir = s.workDir; // 9.1：对话目录随读随留（空/脏值当未选择）
  return session;
}