// 5.7.3.1 新增：结构化输出三档 runner（主进程）。
// 依据：内部规格 §3.5（契约逐字照抄）
// ⚠️ 顶层 import 传输层与配置层（有 I/O：读配置 + 发请求），**绝不许被 tests/ import**。
// 与 runChat 的关系：这是另一条入口，runChat 一个字不改（结构化输出不进工具循环、不注入好感度前缀）。
import type { ChatMessage } from "../../shared/chat";
import type { StructuredOutputTier } from "../../shared/provider/types";
import {
  buildSchemaHint, extractJsonCandidates, pickValidCandidate, tierChain,
  type StructuredRequest,
} from "../../shared/provider/structured";
import { getCapabilityOrOpenAI } from "../../shared/provider/capabilities";
import { resolveRequestContext } from "../../shared/provider/request-context";
import { loadConfig } from "../config/config-store";
import { getTransport } from "./transport";
import type { TransportResponseFormat } from "./transport/types";

export interface RunStructuredOptions {
  request: StructuredRequest;
  /** 已有对话上下文（可为空数组）；**本模块不许原地改它** */
  messages: ChatMessage[];
  modelOverride?: string;
  signal?: AbortSignal;
  /** 单档重试上限（**含首次**），默认 2 */
  maxAttempts?: number;
  /** 单次请求超时（毫秒），默认 30_000 */
  timeoutMs?: number;
}

export interface RunStructuredResult {
  ok: boolean;
  /** 校验通过的 JSON 值；ok=false 时为 null */
  value: unknown;
  /** 实际用到的档（全失败 → null） */
  tier: StructuredOutputTier | null;
  /** 人话原因（供日志 / 5.7.3.2 的兜底文案） */
  reason: string;
}

const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
const CANCEL_REASON = "已取消";

/** 档 → wire 层 responseFormat（档 3 不带 —— 它靠 system 提示约束）。
 *  name/schema 来自调用方 request（tierChain 只给档序，不持 request） */
function responseFormatOf(tier: StructuredOutputTier, request: StructuredRequest): TransportResponseFormat | undefined {
  if (tier === "json_schema") return { kind: "json_schema", name: request.name, schema: request.schema };
  if (tier === "json_object") return { kind: "json_object" };
  return undefined;
}

/** **永不抛错**：三档全失败返回 ok:false（调用方据此退回纯文本，5.7.3.2） */
export async function runStructured(opts: RunStructuredOptions): Promise<RunStructuredResult> {
  try {
    // 调用方已取消 → 立刻返回：不读配置、不重试、不降档（§3.5 要求 6）
    if (opts.signal?.aborted) return { ok: false, value: null, tier: null, reason: CANCEL_REASON };

    const cfg = loadConfig();
    // 不注入好感度前缀 —— 结构化输出不是对话，不归 5.6.2 管（§3.5 要求 1）
    const ctx = resolveRequestContext({ model: cfg.model, modelOverride: opts.modelOverride });

    const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // 能力表的 structuredOutput 是「声明档」：从这一档起往下降（不先试更高档）
    const chain = tierChain(getCapabilityOrOpenAI(ctx.providerId).structuredOutput);
    const systemHint = buildSchemaHint(opts.request); // 档 3 的唯一约束，三档共用

    let lastReason = "";

    for (const plan of chain) {
      let attempts = 0;

      while (attempts < maxAttempts) {
        attempts++;
        if (opts.signal?.aborted) return { ok: false, value: null, tier: null, reason: CANCEL_REASON };

        // 新建数组，绝不 unshift opts.messages（原地改会污染调用方上下文，§5 坑 8）
        const messages: ChatMessage[] = [{ role: "system", content: systemHint }, ...opts.messages];
        const responseFormat = responseFormatOf(plan.tier, opts.request);
        // 超时用 AbortSignal.timeout + any 组合（不手写 setTimeout：漏 clearTimeout 会留悬挂定时器，§5 坑 7）
        const signal = opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs);

        let text = "";
        try {
          await getTransport(ctx.transport).chat({
            baseUrl: ctx.baseUrl, apiKey: ctx.apiKey, model: ctx.model,
            messages,
            stream: false, // 结构化输出不流式：流式会拿到半截 JSON（§5 坑 4）
            ...(responseFormat ? { responseFormat } : {}),
            onDelta: (t) => { text += t; }, // 非流式时 3.5 也会回调一次完整文本，所以只写这一套累积
            signal,
          });
        } catch (err) {
          // 超时 / 网络 / HTTP 报错 —— 算该次失败，重试同一档（不抛给调用方）
          lastReason = err instanceof Error ? err.message : String(err);
          if (opts.signal?.aborted) return { ok: false, value: null, tier: null, reason: CANCEL_REASON };
          continue;
        }

        const value = pickValidCandidate(extractJsonCandidates(text), opts.request.schema);
        if (value !== null) {
          console.log(`[nahida] structured tier=${plan.tier} attempts=${attempts} ok=true`);
          return { ok: true, value, tier: plan.tier, reason: "" };
        }
        lastReason = "未解析出符合 schema 的 JSON"; // 空文本 / 无合法候选
      }

      console.log(`[nahida] structured tier=${plan.tier} attempts=${attempts} ok=false`); // 该档用尽 → 降一档
    }

    console.log(`[nahida] structured 全部档位失败：${lastReason}`);
    return { ok: false, value: null, tier: null, reason: lastReason || "结构化输出失败" };
  } catch (err) {
    // 兜底：装配阶段的意外错误（配置未就绪 / 未知传输）也不许抛出去
    const reason = err instanceof Error ? err.message : "结构化输出失败";
    console.log(`[nahida] structured 未预期错误：${reason}`);
    return { ok: false, value: null, tier: null, reason };
  }
}