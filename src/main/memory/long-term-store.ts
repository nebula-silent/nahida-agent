// 5.1.2：长期记忆 + 人设的独立文件 store（P22 注 2：绝不进 config.json）
// 结构参考自 config-store.ts：readRawConfig 的 .corrupt 备份先例 + saveConfig 的 mkdirSync + atomicWriteJson 先例
// 硬规则（指令 §2 / §4.1）：
//   · 读写纯函数只吃显式目录参数，**运行时不 import electron** —— 函数体内 require，
//     保证本模块被 vitest（node 环境）import 时不会拉起 electron（4.9 系列被测模块同款惯例）
//   · 目录一律由调用方显式传入或 app.getPath 给出，绝不许回落到 cwd / 模块目录这类隐式基准（4.9.8 S2）
//   · 两个文件的路径拼装只在 store 内部这一处，不许散在 IPC 层或工具里
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { IPC } from "../../shared/ipc-channels";
import {
  LONG_TERM_LIMITS,
  type EntrySource,
  type EntryStatus,
  type LongTermEntry,
  type LongTermMemory,
  type UserProfileView,
} from "../../shared/memory";
import { atomicWriteJson } from "../storage/json-file";

// ==================== 落盘路径（唯一拼装处） ====================

function longTermFile(dir: string): string {
  return path.join(dir, "memory", "long-term.json");
}

// ==================== 消毒（写盘与读盘共用一个入口，照 config-store 的 normalize） ====================

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const SOURCE_VALUES: readonly EntrySource[] = ["user_edited", "user_said", "agent_inferred"];
const STATUS_VALUES: readonly EntryStatus[] = ["active", "invalidated", "conflict"];

/** 有限数字 → 数字，否则 null（validUntil / lastUsedAt / 时间戳共用） */
function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function pickTime(v: unknown, now: number): number {
  return finiteOrNull(v) ?? now; // 非有限数字 → 盖当前时间
}

/** importance：非有限数字 → 默认；先取整、再夹界（99 → 10、3.7 → 4） */
function clampImportance(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return LONG_TERM_LIMITS.defaultImportance;
  const n = Math.round(v);
  return Math.min(LONG_TERM_LIMITS.importanceMax, Math.max(LONG_TERM_LIMITS.importanceMin, n));
}

/** id：非字符串 / 空 / 超 64 字 / 与已收的重复 → 重新生成（不许丢条、不许留重） */
function pickId(v: unknown, used: Set<string>): string {
  if (typeof v === "string" && v !== "" && v.length <= 64 && !used.has(v)) {
    used.add(v);
    return v;
  }
  const fresh = randomUUID();
  used.add(fresh);
  return fresh;
}

/** tags / keys 逐条同规：非数组 → []；丢非字符串 / 空（trim 后）/ 超长；去重（保首现顺序）；超量截断 */
function sanitizeStringList(v: unknown, maxCount: number, maxLength: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (t === "" || t.length > maxLength) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= maxCount) break;
  }
  return out;
}

/** 任何输入（IPC 入参 / 磁盘脏数据）都必须过它。
 *  排序只在这里做一次：置顶在前、其余 updatedAt 倒序；超 maxEntries 保留前 N（渲染侧不再排序）。 */
export function sanitizeLongTerm(input: unknown): LongTermMemory {
  const raw = isRecord(input) ? input : {}; // 非对象 → 空对象（entries 取不到 → 空数组）
  const list = Array.isArray(raw.entries) ? raw.entries : [];
  const now = Date.now();
  const usedIds = new Set<string>();
  const entries: LongTermEntry[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue; // 非对象 → 丢
    const text = typeof item.text === "string" ? item.text : "";
    if (text.trim() === "") continue; // text 非字符串或 trim 后为空 → 丢整条
    // source / status 走白名单回落（枚举不许原样落盘）
    const source = SOURCE_VALUES.includes(item.source as EntrySource) ? (item.source as EntrySource) : "user_edited";
    const status = STATUS_VALUES.includes(item.status as EntryStatus) ? (item.status as EntryStatus) : "active";
    const entry: LongTermEntry = {
      id: pickId(item.id, usedIds),
      text: text.slice(0, LONG_TERM_LIMITS.maxTextLength), // 超长截断
      tags: sanitizeStringList(item.tags, LONG_TERM_LIMITS.maxTags, LONG_TERM_LIMITS.maxTagLength),
      keys: sanitizeStringList(item.keys, LONG_TERM_LIMITS.maxKeys, LONG_TERM_LIMITS.maxKeyLength),
      importance: clampImportance(item.importance),
      source,
      status,
      createdAt: pickTime(item.createdAt, now),
      updatedAt: pickTime(item.updatedAt, now),
    };
    if (entry.createdAt > entry.updatedAt) entry.createdAt = entry.updatedAt; // 取齐（updatedAt 是排序锚点）
    if (status !== "active") {
      // 非 active 而缺（或非有限）validUntil → 盖当前时间；active 时不写 validUntil（软失效语义：失效不删条目）
      entry.validUntil = finiteOrNull(item.validUntil) ?? now;
    }
    const lastUsed = finiteOrNull(item.lastUsedAt);
    if (lastUsed !== null) entry.lastUsedAt = lastUsed; // 非有限数字 → 不写该字段
    if (item.pinned === true) entry.pinned = true; // 未置顶不写该字段（不许 pinned:false 噪声）
    entries.push(entry);
  }
  entries.sort(
    (a, b) => Number(b.pinned === true) - Number(a.pinned === true) || b.updatedAt - a.updatedAt,
  );
  return { version: 1, entries: entries.slice(0, LONG_TERM_LIMITS.maxEntries) };
}

// ==================== 长期记忆：read / write ====================

/** 读 long-term.json：不存在 = 空记忆（不预创建空文件）；解析失败 = 备份 .corrupt 后回落空记忆（绝不静默删用户数据） */
export function readLongTerm(dir: string): LongTermMemory {
  const file = longTermFile(dir);
  let raw: unknown;
  try {
    if (!fs.existsSync(file)) return { version: 1, entries: [] };
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.warn("[memory] long-term.json 解析失败，原文件已备份为 long-term.json.corrupt:", err);
    try {
      fs.renameSync(file, file + ".corrupt"); // 备份名别用 .tmp 中转（atomicWriteJson 的 .tmp 会撞名互踩）
    } catch (renameErr) {
      console.warn("[memory] long-term.json.corrupt 备份失败（文件可能已被移走）:", renameErr);
    }
    return { version: 1, entries: [] };
  }
  if (isRecord(raw) && typeof raw.version === "number" && raw.version > 1) {
    // 读到更高版本：按当前结构读入并 warn，本步不做迁移（指令 §5.10）
    console.warn(`[memory] long-term.json 版本 ${raw.version} 高于当前支持的 1，按当前结构读入（未做迁移）`);
  }
  return sanitizeLongTerm(raw);
}

/** 写 long-term.json：整体读写不做增量合并；返回消毒 + 排序后的真相（渲染层回填用） */
export function writeLongTerm(dir: string, input: unknown): LongTermMemory {
  const cleaned = sanitizeLongTerm(input);
  const file = longTermFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true }); // atomicWriteJson 不做 mkdir，漏了首次写盘 ENOENT
  atomicWriteJson(file, cleaned);
  return cleaned;
}

// ==================== 人设分层（9.x persona v2）：read / write / composite ====================
// 分层结构参考自 Cyrene-Agent prompts/ 的「规则→身份→灵魂→台词锚」拆层设计：
//   main  = persona.md  身份+规则（5.1.2 起的原文件，旧内容原地有效，零迁移）
//   soul  = soul.md     人格灵魂（Cyrene soul.md 写法：她是什么样的人/她不是什么/绝对不会/情绪连续性）
//   canon = canon.md    台词锚（3~5 句代表性语气示例，可选，默认空）
// 注入 = main → soul → canon 非空层按序拼接；全空 = 不注入（空 persona 合法红线不变，不许填默认文案）。
// 文件名字面量只许出现在本文件（「文件名归 store 管」惯例不变）。

export type PersonaPart = "main" | "soul" | "canon";

const PERSONA_PARTS: readonly PersonaPart[] = ["main", "soul", "canon"];

/** IPC 入参白名单校验（main/soul/canon 之外一律回落 main，不开任意文件名口子） */
export function isPersonaPart(v: unknown): v is PersonaPart {
  return typeof v === "string" && (PERSONA_PARTS as readonly string[]).includes(v);
}

function personaPartFile(dir: string, part: PersonaPart): string {
  const name = part === "main" ? "persona.md" : part === "soul" ? "soul.md" : "canon.md";
  return path.join(dir, "prompts", name);
}

/** 读单层：不存在 / 读不了 → 空串（= 该层不注入），不报错（读盘兜底不抛） */
export function readPersonaPart(dir: string, part: PersonaPart): string {
  try {
    const file = personaPartFile(dir, part);
    if (!fs.existsSync(file)) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** 写单层：只由设置页经 IPC 写（沿用「不许有别的代码路径写它」红线）。
 *  非字符串 → 空串（空层合法，不许填默认文案）；超上限截断（截断上限与 5.1.2 maxPersonaLength 同一值）。 */
export function writePersonaPart(dir: string, part: PersonaPart, text: unknown): string {
  const saved = typeof text === "string" ? text.slice(0, LONG_TERM_LIMITS.maxPersonaLength) : "";
  const file = personaPartFile(dir, part);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, saved, "utf8");
  return saved; // 返回真正落盘的正文
}

/** 6.6.2 口径：确保人设文件真实存在（openPath / showItemInFolder 都要求真文件）；不存在则建空文件（9.x 起按 part） */
export function ensurePersonaPartFile(dir: string, part: PersonaPart): string {
  const file = personaPartFile(dir, part);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, "", "utf8");
  return file;
}

/** 分层拼接（chat.ts personaReader 消费）：main → soul → canon，各层 trim 后非空才参与，层间空行分隔。 */
export function readPersonaComposite(dir: string): string {
  return PERSONA_PARTS
    .map((part) => readPersonaPart(dir, part).trim())
    .filter((text) => text !== "")
    .join("\n\n");
}

// ==================== 用户档案（5.1.6）：<dir>/prompts/user.md 常驻块 ====================

/** user.md 自动段标记（**只在本文件出现**，5.1.6 坑 3）：重写器与渲染层都只经 split / compose 读写 */
export const AUTO_START = "<!-- nahida:auto:start -->";
export const AUTO_END = "<!-- nahida:auto:end -->";

function userProfileFile(dir: string): string {
  return path.join(dir, "prompts", "user.md");
}

/** 拆 user.md：两标记齐全且 start 在前 → auto = 两标记之间（trim）、manual = 去掉整块后的剩余（去首尾空行、内部逐字不动）；
 *  其余任何情况（只有一个标记 / end 在前 / 都没有）→ { auto: "", manual: 原文 }。逐字稳定，不含时间戳 / 随机量。 */
export function splitUserFile(text: string): { auto: string; manual: string } {
  const start = text.indexOf(AUTO_START);
  const end = text.indexOf(AUTO_END);
  if (start === -1 || end === -1 || end < start) return { auto: "", manual: text };
  return {
    auto: text.slice(start + AUTO_START.length, end).trim(),
    manual: (text.slice(0, start) + text.slice(end + AUTO_END.length)).trim(),
  };
}

/** 拼 user.md：auto 空 → 原样返回 manual（不留空标记块）；否则「标记块 +（manual 非空时空行分隔）manual」。
 *  与 splitUserFile 往返成立：split(compose(a, m)) → auto === a.trim()、manual === m.trim()（m 非空时）。 */
export function composeUserFile(auto: string, manual: string): string {
  if (auto.trim() === "") return manual;
  return AUTO_START + "\n" + auto + "\n" + AUTO_END + (manual === "" ? "" : "\n\n" + manual);
}

/** 读 user.md：不存在 / 读不了 → 空视图（不报错）；否则拆标记 + updatedAt = 文件 mtime */
export function readUserProfile(dir: string): UserProfileView {
  const file = userProfileFile(dir);
  try {
    if (!fs.existsSync(file)) return { auto: "", manual: "" };
    const text = fs.readFileSync(file, "utf8");
    return { ...splitUserFile(text), updatedAt: fs.statSync(file).mtimeMs };
  } catch {
    return { auto: "", manual: "" };
  }
}

/** 写 user.md：非串回落空串；manual / auto 各自截断到上限；返回 readUserProfile(dir) = 真正落盘的真相。
 *  ⚠️ manual 必须由调用方**写盘前现场重读**（5.1.6 坑 2：先写 auto 再读 manual = 丢用户手写）。 */
export function writeUserProfile(dir: string, auto: string, manual: string): UserProfileView {
  const a = typeof auto === "string" ? auto.slice(0, LONG_TERM_LIMITS.maxUserProfileAutoLength) : "";
  const m = typeof manual === "string" ? manual.slice(0, LONG_TERM_LIMITS.maxUserProfileLength) : "";
  const file = userProfileFile(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, composeUserFile(a, m), "utf8");
  return readUserProfile(dir);
}

// ==================== IPC 注册（唯一碰 electron 的地方） ====================

export function registerMemoryHandlers(): void {
  // 函数体内 require（TS 编译目标 CJS）：dist 里运行时取到真 electron；
  // vitest 只调上面的纯函数，永远不进这里，因此不会拉起 electron
  const { app, ipcMain } = require("electron") as typeof import("electron");
  const dir = app.getPath("userData"); // 路径写死 <userData>/memory 与 <userData>/prompts（指令 §2.3）
  ipcMain.handle(IPC.LONG_TERM_GET, () => readLongTerm(dir));
  ipcMain.handle(IPC.LONG_TERM_SET, (_event, input: unknown) => writeLongTerm(dir, input));
  ipcMain.handle(IPC.PERSONA_GET, (_event, part: unknown) =>
    readPersonaPart(dir, isPersonaPart(part) ? part : "main"));
  ipcMain.handle(IPC.PERSONA_SET, (_event, text: unknown, part: unknown) =>
    writePersonaPart(dir, isPersonaPart(part) ? part : "main", text));
  // 6.6.2 + 9.x 分层：人设文件「系统编辑器打开 / 资源管理器定位」。渲染层只传白名单 part（9.x），
  // 路径由这里自解析，不接收渲染层传来的任意路径；文件不存在先建空文件（openPath/showItemInFolder 都要真文件）
  ipcMain.handle(IPC.PERSONA_OPEN, (_event, part: unknown) => {
    const { shell } = require("electron") as typeof import("electron");
    const file = ensurePersonaPartFile(dir, isPersonaPart(part) ? part : "main");
    return shell.openPath(file).then((err) => (err ? { ok: false, error: err } : { ok: true }));
  });
  ipcMain.handle(IPC.PERSONA_REVEAL, (_event, part: unknown) => {
    const { shell } = require("electron") as typeof import("electron");
    shell.showItemInFolder(ensurePersonaPartFile(dir, isPersonaPart(part) ? part : "main"));
    return { ok: true };
  });
  // 5.1.6：自动段由重写器写，IPC 只改手写段（manual 现场读到什么就带什么，别动 auto）
  ipcMain.handle(IPC.USER_PROFILE_GET, () => readUserProfile(dir));
  ipcMain.handle(IPC.USER_PROFILE_SET, (_event, manual: unknown) =>
    writeUserProfile(dir, readUserProfile(dir).auto, typeof manual === "string" ? manual : ""));
}
