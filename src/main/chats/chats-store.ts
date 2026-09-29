// ============================================================
// nahida 对话存储（第三阶段 3.3）—— userData/chats/
//   index.json          — ChatSessionMeta[]，按 updatedAt desc 排序
//   sessions/<id>.json  — 完整 ChatSession（含 messages）
// 依据：内部文档
// 参考自 Cyrene-Agent src/main/chats/chats-store.ts（布局 / 原子写 / 派生标题 / delete 容错）
//
// 设计（对应指令决策 D1-D5）：
// - 列表读轻索引 index.json（轻），进会话才读 sessions/<id>.json（重）；
// - 索引不缓存（与 3.2 config-store 一致）：每次读盘即真相，没有「缓存与磁盘不一致」这类 bug
//   （主进程同步读写天然不会穿插，所以读盘不贵）；
// - 索引损坏自愈（D4）：index.json 只是派生数据，sessions/ 才是真相 —— 解析失败就扫目录重建；
// - 懒创建（D5）：启动只 list()，第一条消息才 create()，不留空壳会话；
// - 落盘时机由渲染层控制（D6）：用户消息发出时 append、助手消息流结束时 append，
//   禁止在每个 delta 上落盘（流式期间几百个 delta，每个都写盘是磁盘灾难）。
// 定位：本步不做任何会话列表 UI（查过原型，没有）；多会话结构为 4.9 / 5.7 预留。
// 5.7（消息树）：messages 从线性数组改成「扁平节点表 + 父子指针」（MessageNode），
//   可见历史 = resolvePath(messages, activeLeafId)；解析唯一入口 = shared/chat 的
//   normalizeSession（v1 → v2 内存升级；旧文件照常读出来，下一次写操作落成 v2）。
// ============================================================
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { app, ipcMain } from "electron";
import {
  CHAT_SCHEMA_VERSION,
  DEFAULT_SESSION_TITLE,
  normalizeSession,
  resolvePath,
  type ChatMessage,
  type ChatSearchHit,
  type ChatSearchResult,
  type ChatSession,
  type ChatSessionMeta,
  type MessageNode,
} from "../../shared/chat";
import { IPC } from "../../shared/ipc-channels";
import { atomicWriteJson } from "../storage/json-file";
import { setChatWorkDir } from "../tools/fs-tools"; // 9.1：对话目录同步进 fs 工具白名单（fs-tools 零 electron 依赖，无循环）

// ==================== 路径（懒计算不写死，与 3.2 同款；不搞 initialize()） ====================

function rootDir(): string {
  return path.join(app.getPath("userData"), "chats");
}

function sessionsDir(): string {
  return path.join(rootDir(), "sessions");
}

function indexPath(): string {
  return path.join(rootDir(), "index.json");
}

function sessionPath(id: string): string {
  return path.join(sessionsDir(), `${id}.json`);
}

function ensureDirs(): void {
  fs.mkdirSync(sessionsDir(), { recursive: true }); // recursive 一次把 chats/ 和 sessions/ 都建好
}

// ==================== 索引（派生数据，坏了自己重建） ====================

function isValidMeta(item: unknown): item is ChatSessionMeta {
  if (!item || typeof item !== "object") return false;
  const meta = item as Partial<ChatSessionMeta>;
  return (
    typeof meta.id === "string" &&
    typeof meta.title === "string" &&
    typeof meta.createdAt === "number" &&
    typeof meta.updatedAt === "number" &&
    typeof meta.messageCount === "number"
  );
}

function readIndexFromDisk(): ChatSessionMeta[] {
  const file = indexPath();
  if (!fs.existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidMeta);
  } catch (err) {
    // 自愈（D4）：index 只是派生数据，sessions/ 才是真相 —— 扫目录重建，而不是把列表清空
    console.warn("[chats-store] index.json 解析失败，尝试从 sessions/ 重建:", err);
    return rebuildIndexFromSessions();
  }
}

function persistIndex(metas: ChatSessionMeta[]): void {
  ensureDirs();
  atomicWriteJson(indexPath(), metas);
}

/** index.json 只是派生数据，sessions/ 才是真相：坏了就扫目录重建，而不是把列表清空 */
function rebuildIndexFromSessions(): ChatSessionMeta[] {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  const metas: ChatSessionMeta[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue; // 跳过 .tmp 等残留
    const session = readSessionFile(name.slice(0, -".json".length));
    if (session) metas.push(metaFromSession(session));
  }
  console.warn(`[chats-store] index.json 不可用，已从 sessions/ 重建 ${metas.length} 条索引`);
  if (metas.length > 0) persistIndex(metas);
  return metas;
}

function metaFromSession(session: ChatSession): ChatSessionMeta {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    // 5.7：消息数 = **可见路径长度**（分叉出去的废枝不计数 —— 列表展示的是「这份存档有几条」）
    messageCount: resolvePath(session.messages, session.activeLeafId).length,
  };
}

// 无缓存版的索引更新：对调用方手里的 metas 数组原地改，改完由调用方 persistIndex 落盘
function upsertMeta(metas: ChatSessionMeta[], meta: ChatSessionMeta): void {
  const idx = metas.findIndex((m) => m.id === meta.id);
  if (idx === -1) metas.push(meta);
  else metas[idx] = meta;
}

function removeMetaById(metas: ChatSessionMeta[], id: string): void {
  const idx = metas.findIndex((m) => m.id === id);
  if (idx !== -1) metas.splice(idx, 1);
}

// ==================== 会话文件 ====================

function readSessionFile(id: string): ChatSession | null {
  const file = sessionPath(id);
  if (!fs.existsSync(file)) return null;
  try {
    // 5.7：唯一解析入口 —— normalizeSession 负责字段校验 / v1 → v2 升级 / 树结构自愈
    // （坏节点丢条不整份判死、childrenIds 按 parentId 重建）；返回 null 就当会话不存在
    return normalizeSession(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    // 解析失败不删文件（用户可能想手动救），只当它不存在
    console.warn("[chats-store] session 文件解析失败:", id, err);
    return null;
  }
}

function writeSessionFile(session: ChatSession): void {
  atomicWriteJson(sessionPath(session.id), session);
}

// ==================== 标题派生 ====================
// 标题默认跟着首条用户消息走：5.7 起只吃**可见路径**（不许再吃扁平节点表 —— 分叉后标题会乱跳），
// 永远取路径上第一条 role==="user" 且内容非空的消息，所以派生结果稳定；路径为空回落默认标题。
// 用户改过名（titleLocked，5.5.1）→ 调用方跳过派生，保护用户命名。

function deriveTitle(visiblePath: MessageNode[]): string {
  const firstUser = visiblePath.find((m) => m.role === "user" && m.content.trim());
  if (!firstUser) return DEFAULT_SESSION_TITLE;
  const cleaned = firstUser.content.replace(/\s+/g, " ").trim();
  return cleaned.length > 30 ? cleaned.slice(0, 30) + "…" : cleaned;
}

// ==================== 消息校验（IPC 输入不可信，边界 2） ====================

/** 落盘前校验：role ∈ user/assistant/system 且 content 是 string；不是就返回 null（别写进历史） */
function sanitizeMessage(message: unknown): ChatMessage | null {
  if (!message || typeof message !== "object") return null;
  const m = message as Partial<ChatMessage>;
  if (typeof m.content !== "string") return null;
  if (m.role !== "user" && m.role !== "assistant" && m.role !== "system") return null;
  return { role: m.role, content: m.content };
}

// ==================== public API ====================

/** 按 updatedAt desc 返回索引（深拷贝，防外部改动） */
export function listSessions(): ChatSessionMeta[] {
  const metas = readIndexFromDisk();
  metas.sort((a, b) => b.updatedAt - a.updatedAt);
  return metas.map((m) => ({ ...m }));
}

export function getSession(id: string): ChatSession | null {
  if (typeof id !== "string" || !id) return null;
  return readSessionFile(id);
}

/** initialMessages 可选；懒创建路径会一次带上首条消息，避免写两次盘。
 *  5.7：落成节点时按顺序线性链接（第 i 个 parentId = 第 i-1 个 id），activeLeafId = 末节点 */
export function createSession(initialMessages?: ChatMessage[]): ChatSession {
  const now = Date.now();
  const cleaned = (initialMessages ?? []).map(sanitizeMessage).filter((m): m is ChatMessage => m !== null);
  const nodes: MessageNode[] = cleaned.map((m, i) => ({
    id: randomUUID(),
    parentId: null,
    childrenIds: [],
    role: m.role,
    content: m.content,
    at: now + i, // +i：at 顺序与线性顺序一致（v1 升级 / activeLeafId 回落都吃 at）
  }));
  for (let i = 1; i < nodes.length; i++) {
    nodes[i].parentId = nodes[i - 1].id;
    nodes[i - 1].childrenIds.push(nodes[i].id);
  }
  const activeLeafId = nodes.length > 0 ? nodes[nodes.length - 1].id : null;
  const session: ChatSession = {
    id: randomUUID(),
    title: deriveTitle(resolvePath(nodes, activeLeafId)), // 新会话无分叉：可见路径 = 全部节点
    messages: nodes,
    activeLeafId,
    createdAt: now,
    updatedAt: now,
    schemaVersion: CHAT_SCHEMA_VERSION,
  };
  ensureDirs();
  writeSessionFile(session);
  // 任何写操作都同步更新索引（边界 5：index.json 与 sessions/ 必须一致）
  const metas = readIndexFromDisk();
  upsertMeta(metas, metaFromSession(session));
  persistIndex(metas);
  return session;
}

/** 内部生成 id / at，追加一条；会话不存在或消息非法返回 null。
 *  parentId 省略 → 挂当前 activeLeafId（线性续写）；显式给了 → 从该节点分叉（原兄弟分支保留）；
 *  给了但表里找不到 → console.warn + 返回 null（不许静默挂到末尾）。
 *  branchId（5.7.3.2）：剧情分支标记，**仅非空 string** 才写进节点（线性对话不写 —— 5.7.1 约定）。
 *  新节点 id 靠返回值的 activeLeafId 拿（渲染层不另设「返回新节点」通道）。 */
export function appendMessage(id: string, message: ChatMessage, parentId?: string, branchId?: string): ChatSession | null {
  const clean = sanitizeMessage(message);
  if (!clean) {
    console.warn("[chats-store] append 拒绝非法消息:", JSON.stringify(message));
    return null;
  }
  const session = typeof id === "string" ? readSessionFile(id) : null;
  if (!session) return null;

  // 挂点裁决：只有真实存在的节点 id 才允许分叉；省略 / 非 string → 线性续写挂当前叶
  const attachTo = typeof parentId === "string" ? parentId : session.activeLeafId;
  const parent = attachTo === null ? null : (session.messages.find((n) => n.id === attachTo) ?? null);
  if (attachTo !== null && !parent) {
    console.warn("[chats-store] append 的 parentId 不在本会话节点表里:", id, parentId);
    return null;
  }

  const now = Date.now();
  const node: MessageNode = {
    id: randomUUID(),
    parentId: attachTo,
    childrenIds: [],
    role: clean.role,
    content: clean.content,
    at: now,
  };
  // 5.7.3.2：仅当 branchId 是非空 string 才写该字段（空串 / undefined → 字段不出现，同 5.7.1「线性对话不写」）
  if (typeof branchId === "string" && branchId !== "") node.branchId = branchId;
  session.messages.push(node);
  if (parent) parent.childrenIds.push(node.id); // 父节点原有子节点保留 → 形成兄弟分支
  session.activeLeafId = node.id;
  session.updatedAt = now;
  // 用户改过名（titleLocked）→ 不再派生标题，否则改名会在下一次发消息时被静默覆盖（5.5.1）
  if (!session.titleLocked) session.title = deriveTitle(resolvePath(session.messages, session.activeLeafId));
  writeSessionFile(session);
  const metas = readIndexFromDisk();
  upsertMeta(metas, metaFromSession(session));
  persistIndex(metas);
  return session;
}

/** 切分支（5.7）：nodeId 必须在本会话节点表里，否则返回 null。
 *  成功时改 activeLeafId + 重派生 title + 写盘 / 更新索引；**不刷新 updatedAt**
 *  （切分支不是新内容，动了会让读档列表顺序随点击乱跳）。 */
export function setActiveNode(id: string, nodeId: string): ChatSession | null {
  const session = typeof id === "string" ? readSessionFile(id) : null;
  if (!session) return null;
  if (typeof nodeId !== "string" || !session.messages.some((n) => n.id === nodeId)) return null;
  session.activeLeafId = nodeId;
  // titleLocked 同样受保护（切分支也必须尊重用户改过的名）
  if (!session.titleLocked) session.title = deriveTitle(resolvePath(session.messages, session.activeLeafId));
  writeSessionFile(session);
  const metas = readIndexFromDisk();
  upsertMeta(metas, metaFromSession(session));
  persistIndex(metas);
  return session;
}

/** 改名（5.5.1）：写 title + 置 titleLocked，此后 appendMessage 不再覆盖标题。
 *  不改 updatedAt —— 它的语义是「最后一条消息的时间」，改名不是新内容，改它会让列表顺序错。
 *  空 / 纯空白标题返回 null（不落盘）；上限 30 字，与 deriveTitle 一致。 */
export function renameSession(id: string, title: string): ChatSession | null {
  const clean = typeof title === "string" ? title.replace(/\s+/g, " ").trim() : "";
  if (!clean) return null;
  const session = typeof id === "string" ? readSessionFile(id) : null;
  if (!session) return null;
  session.title = clean.length > 30 ? clean.slice(0, 30) + "…" : clean;
  session.titleLocked = true;
  writeSessionFile(session);
  const metas = readIndexFromDisk();
  upsertMeta(metas, metaFromSession(session));
  persistIndex(metas);
  return session;
}

export function deleteSession(id: string): boolean {
  let fileExisted = false;
  if (typeof id === "string" && id) {
    const file = sessionPath(id);
    if (fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
        fileExisted = true;
      } catch (err) {
        // 只 warn 不抛（照 Cyrene）：文件删不掉但索引还能删，会话至少从列表消失
        console.warn("[chats-store] 删除 session 文件失败:", id, err);
      }
    }
  }
  const metas = readIndexFromDisk();
  const inIndex = metas.some((m) => m.id === id);
  if (inIndex) {
    removeMetaById(metas, id);
    persistIndex(metas);
  }
  // 返回值 = 「文件删掉了 || 索引里有它」：文件本来就不存在但索引清干净了，也算删成功
  return fileExisted || inIndex;
}

// ==================== 跨会话全文搜索 ====================

/** 每个会话最多贡献的命中数（防单会话长对话刷屏），总上限由 limit 控制 */
const SEARCH_PER_SESSION = 3;
/** 单节点 content 参与匹配的长度上限：视觉等场景可能出现超长内容（如整段 dataURL），截断防拖慢 */
const SEARCH_NODE_CAP = 20_000;

/**
 * 跨会话搜历史消息（对 content 全文匹配，大小写不敏感）。
 * 表情直发是 [词] 文本、图片转写若有也是 content 的一部分 —— 都天然覆盖。
 * 搜全部节点（含非当前分支）：用户要找的是「说过的每句话」，不只当前可见路径。
 * 会话顺序沿 index.json 的 updatedAt desc 读，命中按节点时间倒序返回。
 */
export function searchMessages(query: string, limit = 50): ChatSearchResult {
  const q = query.trim().toLowerCase();
  const empty: ChatSearchResult = { hits: [], sessionCount: 0, truncated: false };
  if (!q) return empty;

  const hits: ChatSearchHit[] = [];
  const sessionIds = new Set<string>();
  let truncated = false;

  for (const meta of listSessions()) {
    if (truncated) break;
    const session = getSession(meta.id);
    if (!session) continue;

    let perSession = 0;
    for (const node of session.messages) {
      if (perSession >= SEARCH_PER_SESSION) break;
      if (node.role !== "user" && node.role !== "assistant") continue; // 只搜对话可见内容
      const content = node.content.length > SEARCH_NODE_CAP ? node.content.slice(0, SEARCH_NODE_CAP) : node.content;
      const idx = content.toLowerCase().indexOf(q);
      if (idx < 0) continue;

      // 片段窗口：命中点前留 40、后留 80 字符，贴边裁齐
      const start = Math.max(0, idx - 40);
      const end = Math.min(content.length, idx + q.length + 80);
      const snippet = (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
      const matchStart = (start > 0 ? 1 : 0) + idx - start; // 前导省略号占 1 位
      hits.push({
        sessionId: session.id,
        sessionTitle: session.title,
        nodeId: node.id,
        role: node.role,
        at: node.at,
        snippet,
        matchStart,
        matchLength: q.length,
      });
      sessionIds.add(session.id);
      perSession += 1;
      if (hits.length >= limit) {
        truncated = true; // 已满：后面还有内容没扫，标记截断
        break;
      }
    }
  }

  hits.sort((a, b) => b.at - a.at); // 最新优先
  return { hits, sessionCount: sessionIds.size, truncated };
}

// ==================== 对话绑定目录（9.1）====================

/**
 * 设 / 清当前对话绑定的目录（聊天视图头选择）。
 *  - dir = "" → 清除（删掉 session.workDir 字段，恢复「未选择」）；
 *  - id 为空 / 找不到会话 → 只同步主进程内存（fs 工具白名单并集用），不落盘 ——
 *    覆盖「空对话先选目录、第一条消息才懒创建」的时序：此刻渲染层暂存，create 后再带 id 调一次；
 *  - 值没变化 → 原样返回不写盘（loadSession 回填重复调用的幂等保护）；
 *  - 不动 updatedAt（选目录不是新内容，改了会让读档列表顺序乱跳，同 renameSession 的取舍）。
 */
export function setWorkDir(id: string | null, dir: string): ChatSession | null {
  const clean = typeof dir === "string" ? dir.trim() : "";
  // 只收绝对路径（相对路径没法当白名单用）；脏入参静默拒绝，不抛
  if (clean !== "" && !path.isAbsolute(clean)) return null;
  setChatWorkDir(clean); // 内存先同步：空对话选完目录还没发消息，fs 工具也要立刻够得着
  if (typeof id !== "string" || id === "") return null;
  const session = readSessionFile(id);
  if (!session) return null;
  if ((session.workDir ?? "") === clean) return session; // 幂等：已是这个值就不写盘
  if (clean === "") delete session.workDir;
  else session.workDir = clean;
  writeSessionFile(session); // workDir 不进 index.json 的 ChatSessionMeta，无需动索引
  return session;
}

// ==================== IPC ====================

/** 注册 chats:list / create / get / append / set-active / delete / rename / search / set-work-dir 九条 IPC（在 main/index.ts 里调用） */
export function registerChatsHandlers(): void {
  ipcMain.handle(IPC.CHATS_LIST, () => listSessions());
  ipcMain.handle(IPC.CHATS_CREATE, (_event, initialMessages: unknown) =>
    createSession(Array.isArray(initialMessages) ? (initialMessages as ChatMessage[]) : undefined),
  );
  ipcMain.handle(IPC.CHATS_GET, (_event, id: string) => getSession(id));
  // 第 3 参 parentId（5.7）：省略 = 线性续写；给了 = 从该节点分叉（非 string 的脏入参当省略处理）
  // 第 4 参 branchId（5.7.3.2）：剧情分支标记（同样非 string 当省略）
  ipcMain.handle(IPC.CHATS_APPEND, (_event, id: string, message: unknown, parentId?: unknown, branchId?: unknown) =>
    appendMessage(
      id,
      message as ChatMessage,
      typeof parentId === "string" ? parentId : undefined,
      typeof branchId === "string" ? branchId : undefined,
    ),
  );
  ipcMain.handle(IPC.CHATS_SET_ACTIVE, (_event, id: string, nodeId: string) => setActiveNode(id, nodeId));
  ipcMain.handle(IPC.CHATS_DELETE, (_event, id: string) => deleteSession(id));
  ipcMain.handle(IPC.CHATS_RENAME, (_event, id: string, title: string) => renameSession(id, title));
  // 脏入参（非 string / 非数字）一律回落安全值，不让渲染层传坏参数打崩 handler
  ipcMain.handle(IPC.CHATS_SEARCH, (_event, query: unknown, limit?: unknown) =>
    searchMessages(typeof query === "string" ? query : "", typeof limit === "number" && limit > 0 ? limit : 50),
  );
  // 9.1：设/清对话绑定目录（id 非 string / null 都当「会话还没建」处理，只同步内存）
  ipcMain.handle(IPC.CHATS_SET_WORK_DIR, (_event, id: unknown, dir: unknown) =>
    setWorkDir(typeof id === "string" ? id : null, typeof dir === "string" ? dir : ""),
  );
}