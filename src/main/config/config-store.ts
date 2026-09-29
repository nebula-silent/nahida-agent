// ============================================================
// nahida 配置存储（第三阶段 3.2）—— userData/config.json
// 依据：内部规格
// 参考自 Cyrene-Agent src/main/channels/settings-store.ts（前缀式加密 / normalize 防御）
//       与 src/main/chats/chats-store.ts（atomicWriteJson）
//
// 职责：只做「存」和「取」。不接聊天链路（3.6/3.7 接）、不接设置页（5.1 接）。
// 铁律：
//   ① 明文只活在主进程内存 —— 出主进程（config:get / config:set 的返回值）一律掩码；
//   ② 落盘敏感字段带 enc: 前缀（safeStorage），渲染进程永远拿不到明文；
//   ③ 不做内存缓存（有意选择）：配置低频读取，不缓存就没有「缓存与磁盘不一致」这类 bug。
// ============================================================
import * as fs from "fs";
import * as path from "path";
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from "electron";
import type { AppConfig, ImChannelConfig } from "../../shared/config";
import type { DeepPartial } from "../../shared/types";
import { IPC } from "../../shared/ipc-channels";
import { atomicWriteJson } from "../storage/json-file";
import { isValidAccessLevel } from "../../shared/tools";
import { sanitizeMcpServers } from "../../shared/mcp";
import { sanitizeImChannels, imSecretKeys, maskSecretValue } from "../../shared/config"; // 8.8：IM 数组消毒 / 8.9：凭证规格与掩码
import { sanitizeVoiceConfig } from "../../shared/voice/types";

// ==================== 数据层（本文件唯一允许出现默认值的地方） ====================

const DEFAULT_CONFIG: AppConfig = {
  version: 1,
  model: { provider: "", baseUrl: "", model: "", apiKey: "" },
  vision: { provider: "", baseUrl: "", model: "", apiKey: "" }, // 8.1 新增（视觉旁路，独立于聊天模型）
  permissions: { level: "read-only", inputControl: false, disabledTools: [] }, // 8.6.1：键鼠总开关，默认关；8.12：停用清单默认空 = 全启用
  mcp: { servers: [] },
  allowedDirs: [], // 8.2 新增：文件访问白名单（空 = 没有任何文件访问权限）
  media: { captureDir: "", recordDir: "", ffmpegPath: "", liveRtmpUrl: "" },
  voice: { preferredId: "", engines: {} }, // 4.6 新增
  im: { channels: [] }, // 8.8 新增：外部消息通道（空 = 一个都没接）
  ui: {},
};

/**
 * 落盘加密、出主进程掩码的字段（点路径）。以后加 voice.xxx.apiKey 只需在这里加一行，
 * 加解密 / 掩码 / 合并三个环节全部由这张表驱动，不要在业务代码里单独写 cfg.model.apiKey。
 * ⚠️ 点路径按 `.` 切分 —— **engine id 不许带点**（openai-tts / minimax / gpt-sovits / edge-tts
 * 都只有中划线，`voice.engines.openai-tts.apiKey` 正好切 4 段；将来新增引擎 id 同样不许带点）。
 */
const SENSITIVE_PATHS = [
  "model.apiKey",
  "vision.apiKey", // 8.1 新增（视觉模型，同 model.apiKey 规则）
  "voice.engines.openai-tts.apiKey", // 4.6 新增（4.5 的 OpenAI 兼容 TTS）
  "voice.engines.minimax.apiKey", // 4.6 新增（4.5 的 MiniMax）
];

// ==================== 加密 / 解密（照抄指令 §4.1） ====================
// 与 Cyrene 的有意偏离 —— 不做 obf: 机器指纹 XOR 混淆兜底：
// Electron 官方文档：Windows 上 isEncryptionAvailable() 一旦 ready 恒为 true，
// obf: 分支在本项目唯一目标平台（Windows）上永不执行，等于在安全关键路径里塞死代码；
// 真实失败场景（配置拷到别的机器 / 换 Windows 用户）走的是下面「解密失败回落空串」分支，
// 已经覆盖。将来要支持 Linux（无 keyring 返回 false）再加前缀 + 分支即可，向前兼容。

const ENC_PREFIX = "enc:";
const PLAIN_PREFIX = "plain:";

function encryptSecret(plain: string): string {
  if (!plain) return "";
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString("base64");
    }
  } catch (err) {
    console.warn("[config] safeStorage 加密失败，本次按明文落盘:", err);
  }
  console.warn("[config] safeStorage 不可用 —— 凭据以明文（plain: 前缀）落盘，这台机器上请勿存放重要 Key");
  return PLAIN_PREFIX + plain;
}

function decryptSecret(stored: string): string {
  if (!stored) return "";
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
  if (!stored.startsWith(ENC_PREFIX)) return stored; // 手改过 / 旧数据，当明文
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn("[config] 本机 safeStorage 不可用，enc: 字段解不开，请在设置里重填");
      return "";
    }
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), "base64"));
  } catch (err) {
    // 配置被拷到别的机器 / 换 Windows 用户时走这里：DPAPI 解不开，回落空串让用户重填
    console.warn("[config] safeStorage 解密失败:", err);
    return "";
  }
}

// ==================== 掩码（照抄指令 §4.2） ====================
// 掩码规则（三条，写方必须遵守，见 stripMaskedSecrets）：
//   1. patch 里敏感字段的值 === 当前掩码 → 视为未改动，从 patch 里删掉（别把 ••••1234 当 Key 存进去）；
//   2. === 空串 → 真的清空；
//   3. 其它值 → 当明文，encryptSecret() 后落盘。

/** 掩码规则本体在 shared/config.ts（registry 的「掩码视为未改动」判断要与这里逐字同规则） */
const maskSecret = maskSecretValue;

// ==================== IM 通道凭证（8.9 飞书 / 钉钉）====================
// im.channels 是**数组**（条数、id 都是用户数据），没法走上面那张固定点路径表，
// 于是按 shared/config.ts 的 IM_CHANNEL_FIELDS 规格单独处理；口径与 model.apiKey 逐条对齐：
//   落盘 enc: → 出主进程掩码 → 回来的值等于掩码则视为未改动（见 stripMaskedImSecrets）。

/** 遍历所有「需加密」的 IM 凭证字段（未登记通道 = 不遍历，所以不加密也不解密） */
function forEachImSecret(cfg: AppConfig, fn: (channel: ImChannelConfig, key: string) => void): void {
  for (const channel of cfg.im.channels) {
    for (const key of imSecretKeys(channel.id)) fn(channel, key);
  }
}

// ==================== 点路径工具 ====================

type Dict = Record<string, unknown>;

function isPlainObject(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getByPath(root: unknown, dotPath: string): unknown {
  let node: unknown = root;
  for (const key of dotPath.split(".")) {
    if (!isPlainObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

function setByPath(root: Dict, dotPath: string, value: unknown): void {
  const keys = dotPath.split(".");
  const last = keys.pop();
  if (!last) return;
  let node: Dict = root;
  for (const key of keys) {
    let next = node[key];
    if (!isPlainObject(next)) {
      next = {} as Dict; // 中间层不是对象（脏数据）→ 重建
      node[key] = next;
    }
    node = next as Dict;
  }
  node[last] = value;
}

function deleteByPath(root: Dict, dotPath: string): void {
  const keys = dotPath.split(".");
  const last = keys.pop();
  if (!last) return;
  let node: unknown = root;
  for (const key of keys) {
    if (!isPlainObject(node)) return;
    node = node[key];
  }
  if (isPlainObject(node)) delete node[last];
}

/** 深合并：产出新对象，不改旧引用；undefined = 本次不改这个字段 */
function mergeDeep(base: Dict, incoming: Dict): Dict {
  const out: Dict = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    const prev = out[key];
    out[key] = isPlainObject(value) && isPlainObject(prev) ? mergeDeep(prev, value) : value;
  }
  return out;
}

// ==================== normalize（默认值合并 / 脏数据防御的唯一入口） ====================
// 照 Cyrene settings-store.ts normalize() 的思路：逐字段校验类型，未知键直接丢弃
// （对象是逐字段重建的，多余键进不来）。IPC 输入不可信，任何 patch 都必须过这里再落盘。

/** ui 段白名单：只收 string | number | boolean，并过滤原型污染键 */
function sanitizeUi(value: unknown): AppConfig["ui"] {
  const out: AppConfig["ui"] = {};
  if (!isPlainObject(value)) return out;
  for (const [key, val] of Object.entries(value)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      out[key] = val;
    }
  }
  return out;
}

/** 8.2：允许目录数组消毒 —— 过滤空串 / 去重（Windows 大小写不敏感）/ 转绝对路径 */
function sanitizeAllowedDirs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const t = item.trim();
    if (t === "") continue;
    const abs = path.resolve(t);
    const key = process.platform === "win32" ? abs.toLowerCase() : abs;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

/** 导出仅供单测（vitest 侧 mock electron 后直调）；生产一律走 loadConfig */
export function normalize(input: unknown): AppConfig {
  const raw = isPlainObject(input) ? input : {};
  const rawVersion = raw.version;
  const version =
    typeof rawVersion === "number" && Number.isFinite(rawVersion) && rawVersion >= 1
      ? Math.floor(rawVersion)
      : 1;
  if (version > DEFAULT_CONFIG.version) {
    // 本步不做 schema 迁移，只提示；迁移逻辑等真出现 v2 再补
    console.warn(`[config] 配置版本 ${version} 高于当前支持的 ${DEFAULT_CONFIG.version}，按当前结构读入（迁移逻辑未实现）`);
  }
  const m = isPlainObject(raw.model) ? raw.model : {};
  const vis = isPlainObject(raw.vision) ? raw.vision : {}; // 8.1
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const rawPermissions = isPlainObject(raw.permissions) ? raw.permissions : {};
  return {
    version,
    model: {
      provider: str(m.provider),
      baseUrl: str(m.baseUrl),
      model: str(m.model),
      apiKey: str(m.apiKey),
    },
    // 8.1：视觉模型段（逐字段重建，脏数据/未知键进不来）
    // C 重做：forceVision 可选布尔 —— 严格 === true 才落（缺省 = 自动判定，同 inputControl 口径）
    vision: {
      provider: str(vis.provider),
      baseUrl: str(vis.baseUrl),
      model: str(vis.model),
      apiKey: str(vis.apiKey),
      ...(vis.forceVision === true ? { forceVision: true } : {}),
    },
    permissions: {
      // 白名单：只认四档，其余（undefined / 脏字符串 / 数字）一律回落 "read-only"
      level: isValidAccessLevel(rawPermissions.level) ? rawPermissions.level : "read-only",
      // 8.6.1：键鼠总开关 —— 严格 === true 才算开，脏值 / 缺省一律 false（默认关）
      inputControl: rawPermissions.inputControl === true,
      // 8.12：授权面板停用清单 —— 只挡类型不挡未知 id（config-store 不 import toolRegistry，
      // 分层倒挂）；失效 id 在应用层 setEnabled 返回 false 自然消化，下次写盘自动清掉
      disabledTools: Array.isArray(rawPermissions.disabledTools)
        ? rawPermissions.disabledTools.filter((x): x is string => typeof x === "string")
        : [],
    },
    mcp: {
      // 数组消毒：整条重建 + 白名单 + 去重 + 上限，坏条目静默丢弃（见 shared/mcp.ts）
      servers: sanitizeMcpServers(raw.mcp && isPlainObject(raw.mcp) ? (raw.mcp as Dict).servers : []),
    },
    // 8.2：文件访问白名单（过滤空串 / 去重 / 转绝对路径；脏值一律丢）
    allowedDirs: sanitizeAllowedDirs(raw.allowedDirs),
    media: (() => {
      const md = isPlainObject(raw.media) ? raw.media : {};
      return {
        captureDir: str(md.captureDir),
        recordDir: str(md.recordDir),
        ffmpegPath: str(md.ffmpegPath),
        liveRtmpUrl: str(md.liveRtmpUrl),
      };
    })(),
    ui: sanitizeUi(raw.ui),
    // 4.6：voice 段消毒（同 mcp.servers 的地位；未知 engine id 保留，见 shared/voice/types.ts）
    voice: sanitizeVoiceConfig(raw.voice),
    // 8.8：im.channels 数组消毒（同 mcp.servers 的地位，坏条目静默丢弃，见 shared/config.ts）
    im: {
      channels: sanitizeImChannels(raw.im && isPlainObject(raw.im) ? (raw.im as Dict).channels : []),
    },
  };
}

/** 规则 1 的执行点：把「值 === 当前掩码」的敏感字段从 patch 里删掉（掩码绝不能当 Key 落盘） */
function stripMaskedSecrets(patch: Dict, currentPlain: AppConfig): Dict {
  const out: Dict = structuredClone(patch);
  for (const p of SENSITIVE_PATHS) {
    const value = getByPath(out, p);
    if (typeof value !== "string" || value === "") continue; // 空串 = 规则 2，真的清空，不能删
    const mask = maskSecret(String(getByPath(currentPlain, p) ?? ""));
    if (mask && value === mask) deleteByPath(out, p);
  }
  stripMaskedImSecrets(out, currentPlain); // 8.9：IM 通道凭证同理（数组，单独处理）
  return out;
}

/** IM 通道凭证的掩码剥离：值 === 当前明文的掩码 → 视为「未改动」，从 patch 里删掉 */
function stripMaskedImSecrets(patch: Dict, currentPlain: AppConfig): void {
  const im = patch.im;
  if (!isPlainObject(im)) return;
  const channels = im.channels;
  if (!Array.isArray(channels)) return;
  for (const item of channels) {
    if (!isPlainObject(item) || !isPlainObject(item.config)) continue;
    const id = typeof item.id === "string" ? item.id : "";
    const current = currentPlain.im.channels.find((c) => c.id === id);
    for (const key of imSecretKeys(id)) {
      const value = item.config[key];
      if (typeof value !== "string" || value === "") continue; // 空串 = 真的清空
      const mask = maskSecret(current?.config[key] ?? "");
      if (mask && value === mask) delete item.config[key];
    }
  }
}

// ==================== 落盘路径 ====================
// 原子写 atomicWriteJson 已提取到 src/main/storage/json-file.ts 全项目共用（3.3 起）

function filePath(): string {
  return path.join(app.getPath("userData"), "config.json");
}

// ==================== load / save ====================
// 读盘分两步：readRawConfig() 拿「磁盘形态」（敏感字段还是 enc: 密文，save 合并用），
// loadConfig() 在其上解密敏感字段，得到内存明文形态（仅主进程内部可见）。

function readRawConfig(): AppConfig {
  const file = filePath();
  let raw: unknown;
  try {
    if (!fs.existsSync(file)) return structuredClone(DEFAULT_CONFIG); // 深拷贝：别让调用方改到默认值
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    // 文件不存在不算错；解析失败 = 内容损坏：备份原文件再回落默认值，绝不静默删除用户数据
    console.warn("[config] 配置文件解析失败，原文件已备份为 config.json.corrupt:", err);
    try {
      fs.renameSync(file, file + ".corrupt");
    } catch (renameErr) {
      console.warn("[config] config.json.corrupt 备份失败（文件可能已被移走）:", renameErr);
    }
    return structuredClone(DEFAULT_CONFIG);
  }
  return normalize(raw);
}

/** 读配置（明文，**仅主进程内部用**，别经 IPC 递给渲染进程） */
export function loadConfig(): AppConfig {
  const cfg = readRawConfig();
  // 敏感字段解密边界：磁盘上是 enc: 前缀密文，内存里还原明文（仅主进程内部可见）
  for (const p of SENSITIVE_PATHS) {
    const stored = getByPath(cfg, p);
    if (typeof stored === "string") setByPath(cfg as unknown as Dict, p, decryptSecret(stored));
  }
  // 8.9：IM 通道凭证同理（只解已有的键，不去凭空造空键）
  forEachImSecret(cfg, (channel, key) => {
    const stored = channel.config[key];
    if (typeof stored === "string") channel.config[key] = decryptSecret(stored);
  });
  return cfg;
}

/** 写配置（明文语义，返回明文全量） */
export function saveConfig(patch: DeepPartial<AppConfig>): AppConfig {
  const currentPlain = loadConfig(); // 明文形态：掩码比对（规则 1）用
  const cleaned = stripMaskedSecrets(patch as unknown as Dict, currentPlain);
  // 合并基底用「磁盘形态」：没被 patch 触碰的敏感字段保持原 enc: 密文不动
  // —— 否则每次保存都会对未改动的 Key 重新 DPAPI 加密，密文无意义地变来变去
  const merged = normalize(mergeDeep(readRawConfig() as unknown as Dict, cleaned));
  // 敏感字段加密边界：只有「新明文」（规则 3，无前缀的非空值）才加密；已有 enc:/plain: 与空串原样保留
  for (const p of SENSITIVE_PATHS) {
    const value = getByPath(merged, p);
    if (
      typeof value === "string" &&
      value &&
      !value.startsWith(ENC_PREFIX) &&
      !value.startsWith(PLAIN_PREFIX)
    ) {
      setByPath(merged as unknown as Dict, p, encryptSecret(value));
    }
  }
  // 8.9：IM 通道凭证同上（已有 enc:/plain: 与空串原样保留，只有新明文才加密）
  forEachImSecret(merged, (channel, key) => {
    const value = channel.config[key];
    if (
      typeof value === "string" &&
      value &&
      !value.startsWith(ENC_PREFIX) &&
      !value.startsWith(PLAIN_PREFIX)
    ) {
      channel.config[key] = encryptSecret(value);
    }
  });
  fs.mkdirSync(path.dirname(filePath()), { recursive: true });
  atomicWriteJson(filePath(), merged);
  // 返回明文全量：重读一次走统一解密边界（D4 不缓存，读盘即真相，也省得再写一遍解密）
  return loadConfig();
}

// ==================== 掩码出口（给渲染进程的唯一形态） ====================

/** 深拷贝后把敏感字段换成掩码 —— 产物只用于「给渲染进程的返回值」，绝不能回写磁盘 */
function maskConfig(cfg: AppConfig): AppConfig {
  const clone = structuredClone(cfg); // 深拷贝：绝不能原地改到主进程手里的明文形态
  for (const p of SENSITIVE_PATHS) {
    const value = getByPath(clone, p);
    if (typeof value === "string") setByPath(clone as unknown as Dict, p, maskSecret(value));
  }
  // 8.9：IM 通道凭证同理（渲染层只拿得到掩码）
  forEachImSecret(clone, (channel, key) => {
    if (typeof channel.config[key] === "string") channel.config[key] = maskSecret(channel.config[key]);
  });
  return clone;
}

// ==================== IPC（本步的读写测试入口） ====================

/** 8.7.21：外观视觉键 —— config:set 命中任一键时广播给所有窗口（工具箱等独立子窗实时跟随） */
const UI_VISUAL_KEYS = ["theme", "accent", "bgType", "bgImage"] as const;

/** 注册 config:get / config:set 两条 IPC（在 main/index.ts 里调用） */
export function registerConfigHandlers(): void {
  ipcMain.handle(IPC.CONFIG_GET, () => maskConfig(loadConfig()));

  // 8.7.22：背景图文件选择 —— 只弹框返回路径，不写配置；
  // 落盘由渲染端走 config:set({ ui: { bgImage } })，广播与校验走既有链路
  ipcMain.handle(IPC.UI_PICK_BG_IMAGE, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const res = await dialog.showOpenDialog(win!, {
      title: "选择背景图片",
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      properties: ["openFile"],
    });
    return res.canceled || res.filePaths.length === 0 ? "" : res.filePaths[0];
  });

  ipcMain.handle(IPC.CONFIG_SET, (_event, patch: DeepPartial<AppConfig>) => {
    const next = saveConfig(patch);
    const ui = patch.ui as Record<string, unknown> | undefined;
    if (ui) {
      const changed = UI_VISUAL_KEYS.filter((k) => k in ui);
      if (changed.length > 0) {
        const payload: Record<string, string> = {};
        for (const k of changed) {
          const v = next.ui?.[k];
          if (typeof v === "string") payload[k] = v;
        }
        if (Object.keys(payload).length > 0) {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send(IPC.UI_THEME_CHANGED, payload);
          }
        }
      }
    }
    return maskConfig(next);
  });
}
