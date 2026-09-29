// 3.2 新增：应用配置契约（config-store 的落盘 / IPC 传输形状）。
// 本步只定义结构与默认值语义；接入聊天链路是 3.6 / 3.7，接设置页是 5.1。
import type { ToolAccessLevel } from "./tools";
import type { McpServerConfig } from "./mcp";
import type { VoiceConfig } from "./voice/types";

/** 应用配置。**不认识任何厂商名** —— provider 只是个 id 字符串，由 3.4 的预设表解释 */
export interface AppConfig {
  /** schema 版本；将来结构变了靠它做迁移（本步只写 1，不做迁移逻辑） */
  version: number;
  /** 模型连接 */
  model: {
    provider: string; // "" = 未选择
    baseUrl: string;  // "" = 用 provider 预设里的默认值
    model: string;    // "" = 用 provider 预设里的默认模型
    apiKey: string;   // **敏感**：落盘 enc:，出主进程即掩码
  };
  /** 视觉模型（8.1）：可独立于聊天模型配置，供截图/读图/VLM 定位工具调用。
   *  纯旁路 —— 只被 provider/vision.ts 消费，绝不进聊天链路。
   *  C 重做：读图默认「主模型优先」（主模型能看图就不走视觉旁路），这里留强制兜底开关 */
  vision: {
    provider: string; // "" = 未选择
    baseUrl: string;  // "" = 用 provider 预设里的默认值
    model: string;    // "" = 用 provider 预设里的默认模型
    apiKey: string;   // **敏感**：落盘 enc:，出主进程即掩码（同 model.apiKey）
    /** C 重做：true = 恒走视觉模型旁路（即使主模型支持多模态）。缺省/脏值 = 自动判定（主模型优先） */
    forceVision?: boolean;
  };
  /** 工具权限（第四阶段 4.1）：用户当前允许 agent 做到哪一步 */
  permissions: {
    /** 四档之一；脏值一律回落 "read-only"（在 config-store 的 normalize 里挡） */
    level: ToolAccessLevel;
    /** 8.6.1：键鼠控制总开关，**默认关**。false/脏值（normalize 严格 === true）= input-control
     *  六工具（click_at / type_text / press_key / scroll / screen_find / screen_status）模型看不见、
     *  裁决层直接 deny；true = 交给权限档位管（逐动作审批仍由档位决定）。设置页「隐私 → 键鼠控制」卡消费 */
    inputControl: boolean;
    /** 8.12：授权面板停用的工具 id 清单，默认空数组 = 全启用；8.12 授权面板写入。
     *  只挡类型不挡未知 id（config-store 不 import toolRegistry，分层倒挂）——
     *  失效 id 在应用层 setEnabled 返回 false 自然消化，下次写盘自动清掉 */
    disabledTools: string[];
  };
  /** MCP 服务器（第四阶段 4.2）：**数组顺序 = 界面顺序**；空数组 = 一个都没配 */
  mcp: {
    /** 脏数据在 config-store 的 normalize 里过 sanitizeMcpServers 消毒 */
    servers: McpServerConfig[];
  };
  /** 文件访问白名单（8.2）：允许 agent 读写的目录。**空数组 = 没有任何文件访问权限**。
   *  只存绝对路径；脏数据在 config-store 的 normalize 里过 sanitizeAllowedDirs 消毒（过滤空串 / 去重 / 转绝对路径） */
  allowedDirs: string[];
  /** 影像线（2.7b/c/d）：截图 / 录屏 / 直播。**四个字段都允许空串**，空 = 用默认语义 */
  media: {
    /** 截图归档目录；"" = userData/media/captures */
    captureDir: string;
    /** 录屏归档目录；"" = userData/media/recordings */
    recordDir: string;
    /** ffmpeg 可执行文件绝对路径；"" = 自动探测（五级顺序）—— **绝不许写死默认值** */
    ffmpegPath: string;
    /** 直播推流地址；"" = 未配置（直播面板里填） */
    liveRtmpUrl: string;
  };
  /** 语音引擎（第四阶段 4.6）：键 = engine.id，值 = configSchema 的 key → 用户填的值。
   *  敏感字段（4.5 的 API Key）落盘走 `enc:`，出主进程即掩码 —— 见 config-store 的 SENSITIVE_PATHS */
  voice: VoiceConfig;
  /** 外部消息通道（8.8）：通道状态持久化。**数组顺序 = 界面顺序**；空数组 = 一个都没接 */
  im: {
    /** 脏数据在 config-store 的 normalize 里过 sanitizeImChannels 消毒 */
    channels: ImChannelConfig[];
  };
  /** 界面偏好：键由设置页（5.1）定义，存储层只保证值是 string | number | boolean */
  ui: Record<string, string | number | boolean>;
}

// ==================== 外部消息通道（8.8）====================
// 通道抽象的函数部分（ChannelAdapter）在主进程 im/types.ts —— 函数不出主进程、也不落盘；
// 这里只放**落盘形状**与消毒函数（config-store 的唯一入口，同 sanitizeMcpServers 的地位）。

/** 通道运行态（落盘只为重启后展示；进程内真相在 registry） */
export type ImChannelState = "stopped" | "running" | "error";

/** 一个已登记通道的持久化条目（config.json → im.channels[i]） */
export interface ImChannelConfig {
  /** "feishu" | "dingtalk" | "weixin" | "echo" */
  id: string;
  /** 用户是否开启该通道（开启 = 进程启动时 start()） */
  enabled: boolean;
  /** 绑定的**独立会话** id（防串味：外部消息绝不进主会话）；"" = 还没收过消息（懒创建） */
  sessionId: string;
  state: ImChannelState;
  /** 通道自己的凭证 / 配置（8.9 / 8.10 填；本步恒为空对象） */
  config: Record<string, string>;
}

/** 通道状态投影（IPC 出参；渲染层 + preload + global.d.ts 共用同一形状）。
 *  **不含函数**（适配器方法不出主进程），也**不含凭证明文**（真要给界面看的一律是掩码） */
export interface ImChannelView {
  id: string;
  displayName: string;
  enabled: boolean;
  state: ImChannelState;
  /** 绑定的独立会话 id；"" = 还没收过消息 */
  sessionId: string;
  /** 绑定会话的标题（让用户认得出这条通道在跟谁说话）；"" = 还没绑定 */
  sessionTitle: string;
  /** 8.9：凭证字段的**掩码**投影（key → 掩码；未配置 = 空串）。明文绝不出主进程。
   *  界面把掩码原样回传 = 「用户没改这一键」，由 registry 侧丢弃（同 model.apiKey 的规矩） */
  configMasked: Record<string, string>;
  /** 8.9：该通道是否支持「连接测试」（适配器实现了 testConnection 才为 true，界面据此显隐按钮） */
  canTest: boolean;
}

/** 通道数上限（防手改 config 塞爆界面） */
export const IM_MAX_CHANNELS = 32;

/** 8.10：微信扫码登录 —— 取码结果（IPC 出参，挂在设置页微信卡上）。
 *  `qrImage` 是**主进程渲染好的 dataURL**（`qrcode_img_content` 是网页地址不是图片）；
 *  渲染失败时为空，此时用 `qrUrl` 兜底（系统浏览器打开后手机扫） */
export interface WeixinQrStartView {
  ok: boolean;
  qrImage?: string;
  qrUrl?: string;
  baseUrl?: string;
  /** ok=false 时的人话（直接显示） */
  error?: string;
}

/** 8.10：扫码轮询结果。`state` 与协议状态机对齐，多两个本地态：
 *  `idle` = 没有进行中的扫码；`error` = 本次查询失败（**会话保留**，可继续轮询） */
export interface WeixinQrPollView {
  state: "idle" | "wait" | "scanned" | "expired" | "confirmed" | "invalid" | "error";
  /** 一句人话，直接显示（不抛错：IPC 不许因扫码网络抖动而炸） */
  message: string;
}

/** 数组消毒：整条重建 + id 必填去重 + 上限，坏条目静默丢弃（同 sanitizeMcpServers 口径） */
export function sanitizeImChannels(value: unknown): ImChannelConfig[] {
  if (!Array.isArray(value)) return [];
  const out: ImChannelConfig[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const extra: Record<string, string> = {};
    if (raw.config && typeof raw.config === "object" && !Array.isArray(raw.config)) {
      for (const [key, val] of Object.entries(raw.config as Record<string, unknown>)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        if (typeof val === "string") extra[key] = val;
      }
    }
    out.push({
      id,
      enabled: raw.enabled === true,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
      state: raw.state === "running" ? "running" : raw.state === "error" ? "error" : "stopped",
      config: extra,
    });
    if (out.length >= IM_MAX_CHANNELS) break;
  }
  return out;
}

// ==================== 通道凭证字段规格（8.9 飞书 / 钉钉）====================
// 一份定义三处消费：① 渲染层按它渲染表单；② registry 按它做 IPC 写入白名单；
// ③ config-store 按它决定哪些字段 enc: 落盘 + 出主进程掩码。**不要在别处再写一遍键名**。

/** 一个通道凭证字段的规格 */
export interface ImFieldSpec {
  /** config 里的键名（飞书 appId/appSecret；钉钉 clientId/clientSecret） */
  key: string;
  /** 界面上的标签 */
  label: string;
  /** true = 落盘走 enc: 前缀（同 model.apiKey）+ 出主进程即掩码 */
  secret: boolean;
  /** 输入框占位文案 */
  placeholder: string;
}

/** 通道 id → 字段规格。**未登记的 id 不在表里 = 不接受任何凭证写入** */
export const IM_CHANNEL_FIELDS: Record<string, ImFieldSpec[]> = {
  feishu: [
    { key: "appId", label: "App ID", secret: false, placeholder: "cli_xxxxxxxxxxxxxxxx" },
    { key: "appSecret", label: "App Secret", secret: true, placeholder: "应用凭证（加密保存，不明文落盘）" },
  ],
  dingtalk: [
    { key: "clientId", label: "Client ID", secret: false, placeholder: "企业机器人 ClientId（即 AppKey）" },
    { key: "clientSecret", label: "Client Secret", secret: true, placeholder: "企业机器人密钥（加密保存，不明文落盘）" },
  ],
  // 8.10：微信（腾讯官方 iLink 协议）。前 4 个键由扫码流程自动写入，只有 sourceAllow 需要用户填
  weixin: [
    { key: "botToken", label: "登录令牌", secret: true, placeholder: "扫码后自动写入（加密保存，不明文落盘）" },
    { key: "accountId", label: "Bot 账号", secret: false, placeholder: "扫码后自动写入（形如 xxxx@im.bot）" },
    { key: "userId", label: "绑定微信", secret: false, placeholder: "扫码者标识（形如 xxx@im.wechat）" },
    { key: "baseUrl", label: "服务地址", secret: false, placeholder: "https://ilinkai.weixin.qq.com" },
    { key: "sourceAllow", label: "来源白名单", secret: false, placeholder: "逗号分隔的 from_user_id；空 = 全部拒绝" },
  ],
};

/** 某通道的全部凭证字段名（未登记 = 空数组） */
export function imChannelKeys(id: string): string[] {
  return (IM_CHANNEL_FIELDS[id] ?? []).map((f) => f.key);
}

/** 某通道需 enc: 落盘 + 掩码的字段名（config-store 用） */
export function imSecretKeys(id: string): string[] {
  return (IM_CHANNEL_FIELDS[id] ?? []).filter((f) => f.secret).map((f) => f.key);
}

/** IPC 写入消毒：**逐键白名单**（未登记的 id / 未登记的键一律丢弃）+ 只收字符串 + 长度上限。
 *  空串**保留**（语义 = 用户要清空该字段）；非敏感字段顺手 trim（粘贴常带空格），密钥原样保留 */
export function sanitizeImChannelConfig(id: string, value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  const raw = value as Record<string, unknown>;
  for (const spec of IM_CHANNEL_FIELDS[id] ?? []) {
    const v = raw[spec.key];
    if (typeof v !== "string") continue;
    const s = spec.secret ? v : v.trim();
    out[spec.key] = s.slice(0, IM_CONFIG_VALUE_MAX);
  }
  return out;
}

/** 单个凭证字段的长度上限（防手改 config / IPC 塞超长串） */
export const IM_CONFIG_VALUE_MAX = 512;

// ==================== 密钥掩码（config-store 与 registry 共用）====================
// 渲染层拿到的密钥永远是掩码，它把表单原样回传时**必须在主进程侧被识别成「未改动」**，
// 否则掩码会被当成新密钥存下去（config-store 的「规则 1」）。两处判断必须同规则 → 提到这里共用。

export const SECRET_MASK_PREFIX = "••••";

/** 同 config-store 的掩码规则：空串 → 空串；≤4 字符 → 全掩码；否则 掩码 + 末 4 位 */
export function maskSecretValue(value: string): string {
  if (!value) return "";
  return value.length <= 4 ? SECRET_MASK_PREFIX : SECRET_MASK_PREFIX + value.slice(-4);
}
