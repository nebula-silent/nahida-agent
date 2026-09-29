// 3.7 新增：连接测试 —— 设置页「测试连接」按钮的后端。
// 参考：Cyrene-Agent orchestrator/vendors/test-connection.ts（**只读**）
// 四条设计点（指令 §5）：
//   ① 不新增 transport 方法 —— 就发一句真请求，走 3.5 已有的 chat（非流式时 onDelta 带回完整文本）
//   ② 15s 超时是必须的：没有它「连不上」时按钮会永远转圈（这不是 3.6 §9.4 禁的聊天超时，两回事）
//   ③ 不传 temperature：某些模型只允许特定值，传 0 会报错（照 Cyrene 的注释）
//   ④ prompt 照抄 Cyrene：「ping，请只回复两个字符：ok」—— 已验证不会触发某些厂商的奇怪校验
import { loadConfig } from "../config/config-store";
import { resolveRequestContext } from "../../shared/provider/request-context";
import { getTransport } from "./transport";
import type { AppConfig } from "../../shared/config";
import type { TestConnectionResult } from "../../shared/provider/types";

/** 照 Cyrene 的 15s；这不是预埋 —— 没有它「连不上」会永远转圈 */
const TEST_TIMEOUT_MS = 15_000;

export async function testConnection(
  override?: Partial<AppConfig["model"]>,
): Promise<TestConnectionResult> {
  const start = Date.now();
  let sample = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    // 草稿合并就在这里做 —— 设置页要能「先填地址和 Key → 点测试 → 再保存」，
    // 所以把未保存的表单值盖在已保存配置上。这样 resolveRequestContext 的签名不用动。
    const ctx = resolveRequestContext({ model: { ...loadConfig().model, ...override } });
    await getTransport(ctx.transport).chat({
      baseUrl: ctx.baseUrl,
      apiKey: ctx.apiKey,
      model: ctx.model,
      messages: [{ role: "user", content: "ping，请只回复两个字符：ok" }],
      stream: false,
      onDelta: (t) => { sample += t; },
      signal: controller.signal,
    });
    return { ok: true, latency: Date.now() - start, sample: sample.trim().slice(0, 80) || "(空回复)" };
  } catch (err) {
    // 3.5 的 toFriendlyHttpError / toFriendlyError 已经把错误翻成人话了，
    // 这一层别再包 —— Cyrene 那边是 `HTTP 401 {...}` 这种原始文案，我们比它好，别退化
    return { ok: false, latency: Date.now() - start, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
