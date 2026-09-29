// 3.5 新增：两种流式解析（SSE + NDJSON）。
// 依据：内部规格 §5.3
// 循环骨架照抄 src/main/ollama-client.ts L88-118（3.5 搬入）：
//   TextDecoder 带 { stream: true }（多字节 UTF-8 跨 chunk 不撕字）/
//   buffer 用 indexOf("\n") 循环切（半行留着等下一块）/ finally 里 reader.cancel() 释放连接。

/** SSE：逐行读，把每个 `data:` 后的载荷回调出去。
 *  - 空行 / 非 data: 行（如 anthropic 的 `event:` 行）跳过
 *  - 载荷为 `[DONE]` 时直接结束（不回调）
 *  - onPayload 返回 true 表示提前结束 */
export async function readSse(res: Response, onPayload: (payload: string) => boolean | void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("响应没有可读流");
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim(); // trim 顺带吃掉 \r（CRLF 行尾）
        buffer = buffer.slice(newlineIndex + 1);
        if (!line || !line.startsWith("data:")) continue; // 空行 / event: 等非数据行跳过
        const payload = line.slice("data:".length).trim(); // "data:" 后随空格可有可无
        if (payload === "[DONE]") return;
        if (onPayload(payload) === true) return;
      }
    }
  } finally {
    // 提前 return / 抛错 / abort 都要释放底层连接
    void reader.cancel().catch(() => undefined);
  }
}

/** NDJSON：逐行读，把每行 JSON.parse 后的对象回调出去。
 *  Ollama 用；同样处理半行与释放连接。onLine 返回 true 表示提前结束 */
export async function readNdjson<T>(res: Response, onLine: (obj: T) => boolean | void): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("响应没有可读流");
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;

        const obj = JSON.parse(line) as T;
        if (onLine(obj) === true) return;
      }
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}
