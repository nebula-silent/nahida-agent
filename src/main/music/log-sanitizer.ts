// 9.x：日志脱敏 —— 单行文本里抹掉 MUSIC_U / __csrf / csrf_token / cookies 对象 /
// Bearer Token / 各类 apiKey，防止凭据进日志。

const PATTERNS: Array<{ pattern: RegExp; replace: string }> = [
  // MUSIC_U=值（分隔符为 ; , ) } 空白）
  { pattern: /\bMUSIC_U=[^;\s,)}]+/g, replace: "MUSIC_U=<redacted>" },
  // JSON 字典或引号内的 MUSIC_U："MUSIC_U":"值" 或 'MUSIC_U':'值'
  { pattern: /(["'])MUSIC_U(["'])\s*:\s*["'][^"']*["']/g, replace: "$1MUSIC_U$2:\"<redacted>\"" },
  // __csrf=值；csrf_token=值（分隔符为 ; & 空白）
  { pattern: /\b__csrf=[^;\s&]+/g, replace: "__csrf=<redacted>" },
  { pattern: /\bcsrf_token=[^&\s;]+/g, replace: "csrf_token=<redacted>" },
  // 内联 cookies 字典（整个对象打码）
  { pattern: /(["']?cookies?["']?\s*[:=]\s*)(\{[^}]+\})/g, replace: "$1<redacted>" },
  // Authorization: Bearer <token>（大小写不敏感；到 ; , 空白 ) } 为止）
  { pattern: /(\bAuthorization\s*:\s*Bearer\s+)[^\s;,)}]+/gi, replace: "$1<redacted>" },
  // 日志中通用 API Key 字段（apiKey=、api_key:、x-api-key:）
  { pattern: /(["'])(api[_-]?key|x-api-key)\1\s*:\s*["'][^"']*["']/gi, replace: "$1$2$1:\"<redacted>\"" },
  { pattern: /(\b(?:api[_-]?key|x-api-key)\b\s*[:=]\s*)["']?[^"'\s,;)}]+["']?/gi, replace: "$1<redacted>" },
];

export function sanitizeLogLine(line: string): string {
  let out = line;
  for (const { pattern, replace } of PATTERNS) out = out.replace(pattern, replace);
  return out;
}
