// 3.5 新增：网络 / HTTP 错误 → 人话。
// 依据：内部规格 §5.2
// findErrorCode 照抄 src/main/ollama-client.ts L22-31（3.5 起全项目唯一一份，ollama-client 已改为转发）。
// 边界（指令 §9.7）：错误一律抛 Error 不抛字符串；AbortError 原样透出不包装（调用方要判 aborted）。

const NETWORK_CODES = ["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"];

/** 网络类错误的错误码可能藏在 cause 链里，逐层找一遍（最多 5 层） */
export function findErrorCode(err: unknown): string | undefined {
  let current: unknown = err;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const code = (current as { code?: string }).code;
    if (code && NETWORK_CODES.includes(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** 底层异常 → 人话。AbortError 原样返回（调用方要判 aborted），其余包装成 Error */
export function toFriendlyError(err: unknown, ctx: { baseUrl: string; providerName: string }): Error {
  if (err instanceof Error && err.name === "AbortError") return err;

  if (findErrorCode(err)) {
    return new Error(`连不上 ${ctx.providerName}（${ctx.baseUrl}）。请确认服务已启动、地址填写正确`);
  }
  if (err instanceof TypeError) {
    // fetch 在网络层失败时抛 TypeError，具体原因在 cause 里
    const detail = (err.cause as { message?: string } | undefined)?.message ?? err.message;
    return new Error(`访问 ${ctx.providerName} 失败（${ctx.baseUrl}）：${detail}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** HTTP 非 2xx → 人话。body 截断 300 字符附在后面。状态码文案 3.7 的连接测试会复用 */
export function toFriendlyHttpError(status: number, body: string, ctx: { baseUrl: string; providerName: string }): Error {
  const detail = body.trim().slice(0, 300);
  const suffix = detail ? `：${detail}` : "";
  let head: string;
  if (status === 401 || status === 403) {
    head = `${ctx.providerName}：API Key 可能无效或没有权限（HTTP ${status}）`;
  } else if (status === 404) {
    head = `${ctx.providerName}：找不到接口（HTTP 404）—— 检查 baseUrl，多数厂商需要以 /v1 结尾`;
  } else if (status === 429) {
    head = `${ctx.providerName}：请求过于频繁或额度用尽（HTTP 429）`;
  } else if (status === 400) {
    head = `${ctx.providerName}：请求不合法（HTTP 400）`;
  } else if (status >= 500) {
    head = `${ctx.providerName}：对方服务端出错（HTTP ${status}）`;
  } else {
    head = `${ctx.providerName} 返回 HTTP ${status}`;
  }
  return new Error(`${head}（${ctx.baseUrl}）${suffix}`);
}
