// nahida 内置工具（第四阶段 4.1；4.1.1 加第三个；5.1.3 加第四、五个；8.2 加文件工具三个；8.3 加执行命令；8.5 加视觉两个；8.6 加键鼠四个 + VLM 定位两个）
// 20 个：3 个 safe + 17 个会动本机 / 会联网 / 会控键鼠的（write_note、remember_long_term、write_file、run_shell、read_image、take_screenshot、click_at、type_text、press_key、scroll、screen_find、screen_status —— 让权限网关的 deny / ask 分支在真机上可达）：
//   ① get_current_time     读系统时间（真实）
//   ② list_chat_sessions   读 3.3 的会话索引（真实，只读）
//   ③ write_note           写笔记进 userData/notes/（fs-write；只写 notes 目录，不接受任意路径 —— 没有路径穿越面）
//   ④ recall_long_term     读长期记忆（5.1.3，safe；纯读一个字不写，含 lastUsedAt）
//   ⑤ remember_long_term   记一条长期记忆（5.1.3，fs-write；落盘一律经 5.1.2 的 store，路径只在 store 内拼）
//   ⑥ read_file / ⑦ write_file / ⑧ list_dir（8.2，fs-read / fs-write；**只在配置的 allowedDirs 白名单内**）
//   ⑨ run_shell           执行命令（8.3，shell；argv 数组执行，执行前过危险命令 / 敏感 cwd 双重校验）
//   ⑩ read_image / ⑪ take_screenshot（8.5，network；读图 / 截屏 → 视觉模型描述。**取图只走内存，不落盘进影像库**）
//   ⑫ click_at / ⑬ type_text / ⑭ press_key / ⑮ scroll（8.6，input-control；真机控制鼠标键盘。**
//      六级最高档**，默认档位下必被 deny / ask —— 语义在 keys/input-tools.ts，native 实现在 keys/nut-driver.ts）
//   ⑯ screen_find / ⑰ screen_status（8.6，input-control；截当前屏 → VLM 定位 / 判断。**
//      **screen_find 只报坐标、绝不自动点** —— 语义在 keys/screen-tools.ts，VLM 调用在 keys/vlm-locator.ts）
//   ⑱ fetch_url / ⑲ web_search / ⑳ deep_search（8.12.1②，network；抓网页 / Bing 免 key 搜索 / 深度搜索。
//      SSRF 防护 + 超时 + 大小上限 + 优雅降级全在 net-tools.ts；搜索为非官方接口，结构变了会回可读提示）
// 将来加工具：在这里 register 一条，risk 按 shared/tools.ts 的六级选；
//   凡是会写盘 / 执行命令 / 联网 / 控制键鼠的，一个都不许填 safe。

import { app, dialog, ipcMain, nativeImage, screen } from "electron";
import * as fs from "fs";
import * as path from "path";
import { toolRegistry } from "./tool-registry";
import { IPC } from "../../shared/ipc-channels"; // 8.2：FS_PICK_DIR
import { listSessions } from "../chats/chats-store";
import { registerLongTermTools } from "../memory/long-term-tools"; // 5.1.3
import { registerShellTool } from "./shell-tool"; // 8.3：run_shell（执行命令）
import { loadConfig } from "../config/config-store"; // 8.2：fs 工具读 allowedDirs
import { editFileTool, getChatWorkDir, globTool, grepTool, listDirTool, mergeChatWorkDir, readFileTool, writeFileTool } from "./fs-tools"; // 8.2：fs 工具执行核心；8.2.1：+edit_file/glob/grep；9.1：+对话绑定目录并集
import { captureDir, grab } from "../media/capture"; // 8.5：复用现有截图（内存取图 + 归档目录）
import { captionImageAuto, resolveVisionConfig } from "../provider/vision"; // 8.1：视觉旁路服务；C 重做：captionImageAuto = 主模型优先调度
import { readImageTool, takeScreenshotTool, type VisionToolDeps } from "./vision-tools"; // 8.5：两个视觉工具的执行核心
import { clickAtTool, pressKeyTool, scrollTool, typeTextTool, type InputDriver } from "../keys/input-tools"; // 8.6：四个键鼠工具的执行核心
import { createNutDriver } from "../keys/nut-driver"; // 8.6：唯一的 nut-js 实现（模块级惰性单例，见下）
import { physicalScreenSize, screenFindTool, screenStatusTool, type ScreenToolDeps } from "../keys/screen-tools"; // 8.6：两个 VLM 定位工具的执行核心
import { deepSearchTool, fetchUrlTool, webSearchTool } from "./net-tools"; // 8.12.1②：三个联网工具的执行核心（纯模块）

// 8.6：键鼠驱动**惰性单例** —— 只有第一次真正调用键鼠工具时才建驱动（建驱动才会拉起 native）。
let driver: InputDriver | null = null;
const getDriver = (): InputDriver => (driver ??= createNutDriver());

/** 与 state/app-state.ts 的 WEEKDAYS 同源 —— 主进程不能 import 渲染进程模块，允许这一份重复 */
const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const pad = (n: number): string => String(n).padStart(2, "0");

/** 笔记目录：与 chats-store 同源（userData 下），**不接受任意路径** —— 没有路径穿越面 */
function notesDir(): string {
  return path.join(app.getPath("userData"), "notes");
}

/** 标题 → 安全文件名：去掉 Windows 非法字符与路径分隔符，压掉 .. ，限长，空则兜底 */
function safeFileName(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\.{2,}/g, ".")
    .trim()
    .slice(0, 60);
  return `${cleaned || "未命名"}.md`;
}

export function registerBuiltinTools(): void {
  toolRegistry.register({
    id: "get_current_time",
    name: "当前时间",
    description:
      "读取这台电脑此刻的本地日期与时间。\n\n何时用：用户问「现在几点」「今天几号」，或需要按当前时间推算。\n不要用于：算时间差（模型自己算）。",
    category: "内置",
    enabled: true,
    risk: "safe",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      const d = new Date();
      return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${WEEKDAYS[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },
  });

  toolRegistry.register({
    id: "list_chat_sessions",
    name: "历史对话列表",
    description:
      "列出本机保存的历史对话（标题 / 消息条数 / 最后更新时间）。\n\n何时用：用户问「我们聊过哪些」「上次那个对话」。\n不要用于：查对话里的具体内容（本步没有检索工具）。",
    category: "内置",
    enabled: true,
    risk: "safe",
    inputSchema: { type: "object", properties: {} },
    execute: async () => {
      const sessions = listSessions();
      if (sessions.length === 0) return "本机还没有保存过对话。";
      return sessions
        .map((s) => `- ${s.title}（${s.messageCount} 条，最后更新 ${new Date(s.updatedAt).toLocaleString("zh-CN")}）`)
        .join("\n");
    },
  });

  // 4.1.1 D7：fs-write 工具 —— 默认 read-only 档位下它会被 deny，不升档绝不写盘
  toolRegistry.register({
    id: "write_note",
    name: "写笔记",
    description:
      "把一段文字存成本机笔记文件（存在应用数据目录的 notes 文件夹里）。\n\n何时用：用户说「记一下」「帮我记下来」「存个笔记」。\n不要用于：读回笔记（本步没有读笔记的工具）。",
    category: "内置",
    enabled: true,
    risk: "fs-write", // ← 关键：默认 read-only 档位下它会被 deny，不升档绝不写盘
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "笔记标题，会当文件名用" },
        content: { type: "string", description: "笔记正文" },
      },
      required: ["title", "content"],
    },
    execute: async (args) => {
      const title = typeof args.title === "string" ? args.title : "";
      const content = typeof args.content === "string" ? args.content : "";
      if (!content.trim()) return "[错误] 笔记正文是空的，没有写入。";
      fs.mkdirSync(notesDir(), { recursive: true });
      const file = path.join(notesDir(), safeFileName(title));
      fs.writeFileSync(file, content, "utf8");
      return `已写入笔记「${path.basename(file, ".md")}」（${content.length} 字）。`;
    },
  });

  // 5.1.3：长期记忆两个真工具（recall_long_term / remember_long_term）
  // baseDir 延迟到 execute 才求值（§4.2）；注册零改动 —— getSummaries() 自动让两条出现在授权面板
  registerLongTermTools(() => app.getPath("userData"));

  // 8.2：文件工具三个 —— 每条路径在执行时才读 allowedDirs（配置改了立刻生效，不缓存）
  // 白名单 + 敏感区校验全在 fs-tools → path-guard 里做；本处只做注册（薄壳）
  // 9.1：白名单 = config.allowedDirs ∪ 当前对话绑定目录（聊天视图头选择；执行时才求值，
  //      新对话清空立刻生效；选了目录也不改权限档位 —— 写 / 执行照旧走档位与审批）
  const allowedDirs = (): string[] => mergeChatWorkDir(loadConfig().allowedDirs, getChatWorkDir());

  toolRegistry.register({
    id: "read_file",
    name: "读取文件",
    description:
      "读取允许目录里的一个文本文件内容。\n\n何时用：用户让你看某个文件、或你要先读原文再改。\n不要用于：看目录里有什么（用 list_dir）、写文件（用 write_file）。只在她被允许的目录内有效。",
    category: "内置",
    enabled: true,
    risk: "fs-read",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "要读的文件的绝对路径（必须在设置里允许的目录内）" },
      },
      required: ["path"],
    },
    execute: async (args) => readFileTool(args.path, allowedDirs()),
  });

  toolRegistry.register({
    id: "write_file",
    name: "写入文件",
    description:
      "在允许目录里写一个文本文件（不存在就新建，已存在会先备份成 .bak 再覆盖）。\n\n何时用：用户让你把内容存成某个文件、或改已有文件。\n不要用于：记笔记（用 write_note）、写可执行文件（.exe/.sh/.bat 等写不进去）。只写文本类扩展名。",
    category: "内置",
    enabled: true,
    risk: "fs-write", // ← 关键：写盘一律按 fs-write 算，默认 read-only 档位下会被 deny
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件的绝对路径（必须在设置里允许的目录内）" },
        content: { type: "string", description: "要写入的完整文本内容（覆盖写，不追加）" },
      },
      required: ["path", "content"],
    },
    execute: async (args) => writeFileTool(args.path, args.content, allowedDirs()),
  });

  toolRegistry.register({
    id: "list_dir",
    name: "列出目录",
    description:
      "列出允许目录里的一级条目（名称 / 类型 / 大小 / 修改时间），不递归。\n\n何时用：用户问某个目录里有什么、或你要先看看有什么文件再读。\n不要用于：读文件内容（用 read_file）。只在她被允许的目录内有效。",
    category: "内置",
    enabled: true,
    risk: "fs-read",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "要列出的目录绝对路径（必须在设置里允许的目录内）" },
      },
      required: ["path"],
    },
    execute: async (args) => listDirTool(args.path, allowedDirs()),
  });

  // 8.2.1：补齐清单 D 声明的三工具 —— edit_file（fs-write，先读后写门禁）/ glob / grep（fs-read，
  // node 原生递归**不经 shell**）。权限策略自动继承 policyFor，无需改 tools.ts；校验全在 fs-tools 内（薄壳）
  toolRegistry.register({
    id: "edit_file",
    name: "编辑文件",
    description:
      "在允许目录里对文件做局部替换：old 是原文里要替换的片段，new 是替换成的内容（new 可为空 = 删除片段）。\n\n何时用：只想改文件里的一小段（比如第 N 行附近改个词），不想整文重写。\n不要用于：新建/整文覆盖（用 write_file）。片段找不到时不改动文件；只改文本类扩展名。",
    category: "内置",
    enabled: true,
    risk: "fs-write", // 要改盘，与 write_file 同级：read-only 档 deny
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件的绝对路径（必须在设置里允许的目录内）" },
        old: { type: "string", description: "要替换的原文片段（按字面匹配，不是正则；必须与原文完全一致）" },
        new: { type: "string", description: "替换成的内容；传空字符串 = 删除该片段" },
      },
      required: ["path", "old", "new"],
    },
    execute: async (args) => editFileTool(args.path, args.old, args.new, allowedDirs()),
  });

  toolRegistry.register({
    id: "glob",
    name: "按模式找文件",
    description:
      "在允许目录里按通配模式找文件（支持 ** 跨目录、* 段内任意、? 单字符），如 **/*.md、sub/*.png。\n\n何时用：不知道文件确切名字/位置时先找文件，再用 read_file 读。\n不要用于：搜文件内容（用 grep）、列一级目录（用 list_dir）。",
    category: "内置",
    enabled: true,
    risk: "fs-read", // 只读，与 read_file 同级
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "通配模式，如 **/*.md（相对目录的路径写法，用 / 分隔）" },
        baseDir: { type: "string", description: "可选：只在这个目录（及其子目录）里找（须在允许目录内）；不传就搜全部允许目录" },
      },
      required: ["pattern"],
    },
    execute: async (args) => globTool(args.pattern, args.baseDir, allowedDirs()),
  });

  toolRegistry.register({
    id: "grep",
    name: "搜索文件内容",
    description:
      "在允许目录里按关键词或正则搜文件内容，返回命中行（文件路径:行号: 内容）。\n\n何时用：找「哪份文件里写过 XX」、或定位某段代码/文字在哪个文件。\n不要用于：找文件名（用 glob）。二进制和大文件会自动跳过。",
    category: "内置",
    enabled: true,
    risk: "fs-read", // 只读，与 read_file 同级
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "关键词或正则表达式（写非法正则会按普通文字处理）" },
        path: { type: "string", description: "可选：只搜这个目录或文件（须在允许目录内）；不传就搜全部允许目录" },
      },
      required: ["pattern"],
    },
    execute: async (args) => grepTool(args.pattern, args.path, allowedDirs()),
  });

  // 8.3：执行命令（run_shell）—— risk "shell"；read-only / scoped 档 deny，per-action 档逐条审批，full 档放行。
  // 危险命令 / 敏感 cwd 的双重校验在 shell-tool.ts 内（执行前判，不在这层）
  registerShellTool();

  // 8.5：视觉工具两个 —— 取图能力全部在此绑定（真机实现），vision-tools.ts 里只有语义与校验。
  //   ① 取图口径：read_image 用 nativeImage 解码（jpg 等也统一转 PNG）；
  //      take_screenshot 走 capture.grab("", false) —— 主屏、内存取图、**不落盘、不进影像库**（红线 §1.3）。
  //   ② allowedDirs / captureDir 都是**执行时才求值**（配置改了立刻生效，不缓存）。
  //   ③ 读图模型执行时判定 —— C 重做：captionImageAuto 先试主模型多模态（判定见 capabilities.ts），
  //      主模型不支持 / 主模型读图失败 / forceVision=true 才回落视觉旁路；未配置时返回 `[错误·配置]…`，这里不预判、不崩。
  // 8.5 / 8.6 共用：截主屏（空串 = 主屏）、内存取图、长边缩到 1920（送模型的图不必原尺寸）→ PNG base64；取不到回 ""
  const grabPrimaryPngBase64 = async (): Promise<string> => {
    const img = await grab("", false);
    return img.isEmpty() ? "" : img.toPNG().toString("base64");
  };
  const visionDeps: VisionToolDeps = {
    allowedDirs: () => loadConfig().allowedDirs,
    captureDir: () => captureDir(),
    readPngBase64: (p) => {
      const img = nativeImage.createFromPath(p);
      return img.isEmpty() ? "" : img.toPNG().toString("base64");
    },
    grabPngBase64: grabPrimaryPngBase64,
    caption: (image, query) => captionImageAuto(image, query, loadConfig()), // C 重做：主模型优先，兜底视觉旁路
  };

  toolRegistry.register({
    id: "read_image",
    name: "看图",
    description:
      "读一张本机图片（截图归档目录或她被你允许访问的目录里的图片文件），描述它、或按你的意思解读。\n\n何时用：用户让你看一张图、问图里有什么、认图里的文字。\n不要用于：看当前屏幕（用 take_screenshot）、读文本文件（用 read_file）。读图默认用主模型，主模型不支持时才用视觉模型。",
    category: "内置",
    enabled: true,
    // fs-read + network 两个面；risk 只能填一个，取更重的 network（读图必联网调视觉模型，画面即数据出网）。
    // 与 fs-read 在现有四档表里策略相同（read-only / scoped 放行、per-action 需审批），行为无差异。
    risk: "network",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "图片文件的绝对路径（必须在允许访问的目录或截图归档目录内）" },
      },
      required: ["path"],
    },
    execute: async (args) => readImageTool(args, visionDeps),
  });

  toolRegistry.register({
    id: "take_screenshot",
    name: "看当前屏幕",
    description:
      "截一下当前主屏幕，描述它、或按你的意思解读（图只在内存里过一遍，不会存进影像库）。\n\n何时用：用户问「屏幕上是什么」「帮我看看现在显示什么」。\n不要用于：截图存档（那是影像线的事）、读本机图片文件（用 read_image）。读图默认用主模型，主模型不支持时才用视觉模型。",
    category: "内置",
    enabled: true,
    risk: "network", // ← 画面出网 → 联网风险；绝不 safe（builtin-tools 头注释的硬规矩）
    inputSchema: {
      type: "object",
      properties: {
        userQuery: { type: "string", description: "想问这张屏幕截图的什么；省略 = 让视觉模型做通用描述" },
      },
    },
    execute: async (args) => takeScreenshotTool(args, visionDeps),
  });

  // 8.6：键鼠工具四个 —— 真机控制鼠标键盘（**六级最高档 input-control**）。
  //   语义与校验全在 keys/input-tools.ts（纯模块，绝不 throw，失败回 `[错误]…`）；
  //   真机实现只走 keys/nut-driver.ts 的惰性单例 —— 单测 / 其它路径不 import 就不会拉 native。
  toolRegistry.register({
    id: "click_at",
    name: "点击屏幕",
    description:
      "把鼠标移到屏幕上的指定像素坐标并点一下左键。\n\n何时用：你已经知道目标在屏幕上的确切像素坐标（例如 screen_find 给你的坐标）。\n不要用于：不知道坐标时盲点（先用 screen_find 定位）、键入文字（用 type_text）。坐标以屏幕物理像素为准。",
    category: "内置",
    enabled: true,
    risk: "input-control", // ← 真机控制鼠标 → 六级最高档，绝不 safe
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "目标横向像素坐标（屏幕左上角为原点）" },
        y: { type: "number", description: "目标纵向像素坐标（屏幕左上角为原点）" },
      },
      required: ["x", "y"],
    },
    execute: async (args) => clickAtTool(args, getDriver()),
  });

  toolRegistry.register({
    id: "type_text",
    name: "键入文字",
    description:
      "把一段文字像敲键盘一样键入到当前焦点处（当前仅支持英文 / 数字等 ASCII 字符，中文打不出来）。\n\n何时用：需要往输入框里填内容（已用 click_at 点中该输入框）。\n不要用于：按快捷键（用 press_key）、输入中文（本机键鼠库暂不支持）。键入前请先确认焦点在正确的输入位置。",
    category: "内置",
    enabled: true,
    risk: "input-control",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要键入的文字内容" },
      },
      required: ["text"],
    },
    execute: async (args) => typeTextTool(args, getDriver()),
  });

  toolRegistry.register({
    id: "press_key",
    name: "按键",
    description:
      "按一次按键或组合键（如 Backspace、Enter、Ctrl+S、Alt+F4）。\n\n何时用：要提交 / 删除 / 切换窗口 / 触发快捷键。\n不要用于：输入普通文字（用 type_text）。",
    category: "内置",
    enabled: true,
    risk: "input-control",
    inputSchema: {
      type: "object",
      properties: {
        combo: { type: "string", description: "按键或组合键，用 + 连接，如 \"Enter\"、\"Ctrl+S\"、\"Alt+F4\"" },
      },
      required: ["combo"],
    },
    execute: async (args) => pressKeyTool(args, getDriver()),
  });

  toolRegistry.register({
    id: "scroll",
    name: "滚动页面",
    description:
      "把鼠标移到指定坐标后滚动滚轮（向下或向上若干格）。\n\n何时用：要翻看网页 / 列表 / 文档的更多内容。\n不要用于：移动鼠标点击（用 click_at）。正数向下、负数向上。",
    category: "内置",
    enabled: true,
    risk: "input-control",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number", description: "滚动位置横向像素坐标" },
        y: { type: "number", description: "滚动位置纵向像素坐标" },
        amount: { type: "number", description: "滚动格数：正数向下、负数向上（不能为 0）" },
      },
      required: ["x", "y", "amount"],
    },
    execute: async (args) => scrollTool(args, getDriver()),
  });

  // 8.6：VLM 定位两个 —— 截当前屏 → VLM 定位 / 判断。
  //   ① 取图：主屏、内存、**不落盘**；**图尺寸随图一起交出去** —— VLM 返回的是「相对这张图」的绝对像素
  //      （2026-09-29 真机实测定案，见 keys/vlm-locator.ts 的坐标约定注：qwen2.5vl:3b 无视归一化要求）。
  //   ② screenPhysicalSize：screen.getPrimaryDisplay() 的 size 过 physicalScreenSize(…, scaleFactor) ——
  //      **物理像素**，与 capture.grab 的 thumbSize 同源（capture.ts L57-62）；
  //      screen-tools 用它把「图坐标」换算回屏幕物理像素（图被缩过时按比例放大，原尺寸时比例 = 1）。
  //   ③ vlmConfig 执行时读；chat **不传** → 走 vlm-locator 内部默认实现（自己 fetch，真机走这条）。
  const screenDeps: ScreenToolDeps = {
    grab: async () => {
      const img = await grab("", false); // 空串 = 主屏；false = 长边缩到 1920（送模型的图不必原尺寸）
      if (img.isEmpty()) return null;
      const { width, height } = img.getSize();
      return { base64: img.toPNG().toString("base64"), width, height };
    },
    screenPhysicalSize: () => {
      const d = screen.getPrimaryDisplay();
      return physicalScreenSize(d.size, d.scaleFactor);
    },
    vlmConfig: () => resolveVisionConfig(loadConfig().vision),
    // chat 不传：用 vlm-locator 内部默认实现（它自己 fetch，无需在这里绑定）
  };

  toolRegistry.register({
    id: "screen_find",
    name: "屏幕找目标",
    description:
      "在当前屏幕上按描述找一个目标（图标 / 按钮 / 文字），返回它的像素坐标。\n\n何时用：要点击一个你只知道长相、不知道坐标的东西 —— 先 screen_find 拿坐标，再用 click_at 点它。\n不要用于：只看屏幕内容（用 take_screenshot）。本工具只报坐标、不会替你点。",
    category: "内置",
    enabled: true,
    risk: "input-control", // ← 与键鼠工具同档（六级最高档），默认档位下必被 deny / ask
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "要找的目标长什么样（如「登录按钮」「左上角红色关闭图标」）" },
      },
      required: ["target"],
    },
    execute: async (args) => screenFindTool(args, screenDeps),
  });

  toolRegistry.register({
    id: "screen_status",
    name: "屏幕状态判断",
    description:
      "看一眼当前屏幕，回答一个是非问题（比如「有没有弹出登录框」）。\n\n何时用：需要判断界面处于什么状态。\n不要用于：找东西的坐标（用 screen_find）。",
    category: "内置",
    enabled: true,
    risk: "input-control", // ← 与键鼠工具同档（六级最高档）
    inputSchema: {
      type: "object",
      properties: {
        ask: { type: "string", description: "关于当前屏幕的是非问题（如「是否已登录」）" },
      },
      required: ["ask"],
    },
    execute: async (args) => screenStatusTool(args, screenDeps),
  });

  // 8.12.1②：联网工具三个 —— risk "network"，走 policyFor 现有档位表（read-only 档即放行，per-action 需审批）。
  //   实现核心全在 net-tools.ts（纯模块、可单测）：私网地址防护（SSRF）/ 15s 超时 / 512KB 上限 /
  //   Bing 免 key 搜索优雅降级 —— 本处只做注册薄壳，语义与校验不在这里。
  toolRegistry.register({
    id: "fetch_url",
    name: "打开网页",
    description:
      "抓取一个公网网址的页面，返回提取后的正文文本。\n\n何时用：用户给了一个具体网址让你看内容，或你要核实某个页面说了什么。\n不要用于：搜索关键词（用 web_search）、内网或本机地址（会被拒绝）、需要登录才能看的页面（只能读到未登录可见部分）。",
    category: "内置",
    enabled: true,
    risk: "network", // ← 联网，绝不 safe（builtin-tools 头注释的硬规矩）
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "完整的 http/https 网址（必须指向公网）" },
      },
      required: ["url"],
    },
    execute: async (args) => fetchUrlTool(args.url),
  });

  toolRegistry.register({
    id: "web_search",
    name: "联网搜索",
    description:
      "按关键词联网搜索，返回前几条结果的标题 / 链接 / 摘要（快）。\n\n何时用：需要时效信息（新闻、价格、版本号）或你不知道去哪个网站查。\n不要用于：已有明确网址（直接用 fetch_url 打开）、要大量正文素材（用 deep_search）。",
    category: "内置",
    enabled: true,
    risk: "network",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        count: { type: "number", description: "要几条结果（1-10，默认 5）" },
      },
      required: ["query"],
    },
    execute: async (args) => webSearchTool(args.query, args.count),
  });

  toolRegistry.register({
    id: "deep_search",
    name: "深度搜索",
    description:
      "联网搜索并直接读取前几条结果的页面正文，拼成分段摘要（比 web_search 慢，但素材完整）。\n\n何时用：要做对比 / 汇总 / 需要读完整内容再回答的问题。\n不要用于：只想拿几个链接（用 web_search）、已有明确网址（用 fetch_url）。",
    category: "内置",
    enabled: true,
    risk: "network",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        pages: { type: "number", description: "要读几条结果的正文（1-5，默认 3）" },
      },
      required: ["query"],
    },
    execute: async (args) => deepSearchTool(args.query, args.pages),
  });
}

/** 8.2：「设置 - 隐私」的「添加目录」—— 只弹目录框、只返回路径，**绝不写配置**（写不写由渲染层决定） */
export function registerFsHandlers(): void {
  ipcMain.handle(IPC.FS_PICK_DIR, async () => {
    const r = await dialog.showOpenDialog({
      title: "选择允许她读写的目录",
      properties: ["openDirectory", "createDirectory"],
    });
    return r.canceled ? "" : (r.filePaths[0] ?? "");
  });
}
