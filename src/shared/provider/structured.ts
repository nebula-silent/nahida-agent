// 5.7.3.1 新增：结构化输出纯逻辑（三档链 + system 提示 + JSON 候选抽取 + 最小校验）。
// 依据：内部规格 §3.4（契约逐字照抄）
// 零依赖：不 import 任何主进程 / 界面侧模块 / 不发请求 / 不读盘 / 不读时钟 ——
// 放 src/shared/provider/ 供主进程 runner（main/provider/structured.ts）与单测直接 import。
import type { StructuredOutputTier } from "./types";

/** 一次结构化请求的意图（调用方给形状与要求，本模块负责「怎么问」与「怎么认」） */
export interface StructuredRequest {
  /** 期望的 JSON 形状（JSON Schema 子集：object / array / string / number / boolean） */
  schema: Record<string, unknown>;
  /** `json_schema` 档的 schema 名（OpenAI 要求非空、只含 [A-Za-z0-9_-]，**不许中文**） */
  name: string;
  /** 业务指令（**不含** schema —— schema 段由 buildSchemaHint 统一生成） */
  instruction: string;
}

/** 某一档「怎么问」的纯数据描述，给 runner 用 */
export type TierPlan =
  | { tier: "json_schema"; responseFormat: { kind: "json_schema"; name: string; schema: unknown } }
  | { tier: "json_object"; responseFormat: { kind: "json_object" } }
  | { tier: "prompt_json" };

/** 档序固定（路线图 §一）：**只降不升，不许跳档** */
const TIER_ORDER: readonly StructuredOutputTier[] = ["json_schema", "json_object", "prompt_json"];

/** 降级链：从声明档一路降到 prompt_json。json_schema → 3 条；json_object → 2 条；prompt_json → 1 条。
 *  注意「声明档」语义：json_object 声明 = 从 json_object 起降，**不会**先试 json_schema（§5 坑 10）。
 *  json_schema 档的 name/schema 是占位 —— tierChain 不持 request，具体值由 runner 从 request 填入 */
export function tierChain(declared: StructuredOutputTier): TierPlan[] {
  const plans: TierPlan[] = [
    { tier: "json_schema", responseFormat: { kind: "json_schema", name: "", schema: null } },
    { tier: "json_object", responseFormat: { kind: "json_object" } },
    { tier: "prompt_json" },
  ];
  const start = TIER_ORDER.indexOf(declared);
  // 脏值（运行期传入未知档）也按最保守的全链走：-1 → 从 json_schema 起
  return start <= 0 ? plans : plans.slice(start);
}

/** 把 schema 与要求压成一段 system 提示。**三档都要加**：档 1/2 加它是为了减少语义漂移，档 3 是唯一约束。
 *  产出必须含：① 「只输出 JSON」约束语 ② schema 的 JSON 文本 ③ instruction 原文（丢了它 = 丢了业务要求） */
export function buildSchemaHint(req: StructuredRequest): string {
  return [
    "只输出 JSON。不要解释，不要 Markdown 围栏，不要任何多余文字。",
    "输出必须符合以下 JSON Schema：",
    JSON.stringify(req.schema, null, 2),
    req.instruction,
  ].join("\n");
}

/** 从某个起点括号找匹配闭合位置（字符串感知：串内的 { } [ ] 与转义引号不算结构）。
 *  找到 → 闭合下标；到表尾没闭合 → -1（调用方丢弃该片段） */
function findBalancedEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** 从模型原始文本里抽 JSON 候选（纯函数，顺序 = 可信度）：
 *  ① 整段 JSON.parse ② ```json / ``` 围栏 ③ 平衡 {...} / [...] 片段（字符串感知）。
 *  **三个来源依次尝试、全部收集**（不是命中即停 —— 坏候选在前时由 pickValidCandidate 继续往后挑）。
 *  抽不到 → [] */
export function extractJsonCandidates(text: string): unknown[] {
  const out: unknown[] = [];

  // ① 整段就是 JSON（最常见的「模型听话」情况）
  const trimmed = text.trim();
  if (trimmed) {
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // 不是整段 JSON，继续走围栏与片段
    }
  }

  // ② 围栏：```json 与无语言标记的 ``` 两种（i 模式顺带容忍 ```JSON）
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const m of text.matchAll(fence)) {
    const inner = (m[1] ?? "").trim();
    if (!inner) continue;
    try {
      out.push(JSON.parse(inner));
    } catch {
      // 围栏内容不是纯 JSON（如带解释）—— 下面的片段扫描还会兜住里面的 JSON
    }
  }

  // ③ 平衡片段扫描：逐个收集 top-level {...} / [...]（未闭合的丢弃；拖动 i 跳过已收片段，避免重复收嵌套内层）
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") {
      i++;
      continue;
    }
    const end = findBalancedEnd(text, i);
    if (end === -1) {
      i++; // 到表尾没闭合 → 丢弃该起点，继续找下一个
      continue;
    }
    try {
      out.push(JSON.parse(text.slice(i, end + 1)));
    } catch {
      // 片段不是合法 JSON（如 {a:1} 缺引号），跳过
    }
    i = end + 1;
  }

  return out;
}

/** 单值 vs schema 的**最小校验**：未声明 / 未知类型 → 放行（别自己发明规则） */
function matchesType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && !Number.isNaN(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

/** 递归校验：type / required / properties 声明项 / 数组 items */
function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): boolean {
  const type = schema.type;
  if (type === undefined) return true; // 未声明类型 → 放行
  if (!matchesType(value, type)) return false;

  if (type === "object") {
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !(key in obj)) return false; // required 各键必须存在
    }
    const props = schema.properties;
    if (props && typeof props === "object" && !Array.isArray(props)) {
      for (const [key, sub] of Object.entries(props as Record<string, unknown>)) {
        if (!(key in obj)) continue; // 只校验「实际出现且声明过」的键
        if (sub && typeof sub === "object" && !Array.isArray(sub)) {
          if (!validateAgainstSchema(obj[key], sub as Record<string, unknown>)) return false;
        }
      }
    }
  }

  if (type === "array") {
    const items = schema.items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      return (value as unknown[]).every((el) => validateAgainstSchema(el, items as Record<string, unknown>));
    }
  }

  return true;
}

/** 按 schema 校验候选，返回**第一个**合法值；都不合法 → null。
 *  只做最小校验：type / required / 数组元素（strict 模式的 additionalProperties 约束由调用方写 schema 时负责） */
export function pickValidCandidate(candidates: unknown[], schema: Record<string, unknown>): unknown | null {
  for (const candidate of candidates) {
    if (validateAgainstSchema(candidate, schema)) return candidate;
  }
  return null;
}