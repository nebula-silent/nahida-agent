// 9.x：MCP 子进程环境变量白名单 —— 用 uv 拉起 cloud-music-mcp 时只透传安全变量，
// 防止把主进程里的 API Key / 密码等敏感 env 泄漏给子进程。

const ALLOW = new Set([
  "PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR",
  "USERPROFILE", "HOME",
  "LANG", "LC_ALL", "LC_CTYPE",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "no_proxy",
  "PYTHONIOENCODING", "PYTHONUTF8", "PYTHONDONTWRITEBYTECODE",
  "UV_PROJECT_ENVIRONMENT", "UV_PYTHON",
]);

export function buildChildEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ALLOW) {
    const v = process.env[key];
    if (typeof v === "string") env[key] = v;
  }
  for (const [k, v] of Object.entries(extra)) env[k] = v;
  return env;
}
