// 4.9 新增：按句早播切分（D3）。
// 参考自 Cyrene-Agent src/shared/tts-early-playback.ts（清单 §8 对照表第 7 行：直接搬，不重写）。
// 搬运改动：① 删 canUseMinimaxStreamingEarly / EarlyTtsSettingsLike —— 那是「仅 MiniMax 流式才早播」
//   的开关与设置形状，本项目早播**对所有引擎生效**（切句与引擎无关，D3）；
//   ② **D4 修正**：句末符处的片段短于 minChars 时 continue 往后找，不许 return null
//   （原件在「好。后面还有内容。」上永远返回 null → 整条消息都不早播，必修 bug）；
//   ③ 新增 splitSentences（整段回复全量切分用）。
// ⚠️ 本文件零依赖（只 import 共享常量），可被 vitest 裸跑；顶层无 I/O。
import { EARLY_MIN_CHARS } from "../../shared/voice/call";

const SENTENCE_END = /[。！？!?；;\n]/; // ⚠️ 不带 g 标志（test() 无副作用；带 g 会被 lastIndex 坑）

export interface EarlyTtsSegment {
  /** 可播的一段（含句末符） */
  segment: string;
  /** 剩余待播文本（已 trimStart） */
  remainder: string;
}

/**
 * 从流式文本里抠出**第一段够长**的句子。
 * 返回 null 的**唯一**语义 = 「还没有够长的一句，继续等 delta」。
 * - 空串 / 纯空白 → null；无句末符 → null；`\n` 也是句末符（流式回复里 markdown 段落也是该断句的地方）。
 * - 字数按**码点**计（代理对如「𠮷」算 1 个，不是 2 个）—— 与原件一致。
 * - D4：句末符处的片段短于 minChars 时**继续往后找**，不是 return null。
 */
export function extractEarlyTtsSegment(text: string, minChars?: number): EarlyTtsSegment | null {
  const min = minChars ?? EARLY_MIN_CHARS;
  const trimmed = text.trimStart();
  if (!trimmed) return null;

  for (let i = 0; i < trimmed.length; i += 1) {
    if (!SENTENCE_END.test(trimmed[i])) continue;
    const segment = trimmed.slice(0, i + 1).trim();
    if (Array.from(segment).length < min) continue; // D4 修正：原件这里是 return null
    const remainder = trimmed.slice(i + 1).trim();
    return { segment, remainder };
  }

  return null;
}

/**
 * 整段回复全量切分：循环调 extractEarlyTtsSegment 直到 null。
 * 最后剩下的尾巴落在 rest（可能短于 minChars，由调用方兜底播）。
 */
export function splitSentences(text: string, minChars?: number): { segments: string[]; rest: string } {
  const segments: string[] = [];
  let rest = text;
  for (;;) {
    const seg = extractEarlyTtsSegment(rest, minChars);
    if (!seg) break;
    segments.push(seg.segment);
    rest = seg.remainder;
  }
  return { segments, rest: rest.trimStart() };
}
