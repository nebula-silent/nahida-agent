# nahida

纳西妲主题的本地优先桌面 AI 助手 —— Electron + TypeScript，界面为原生 HTML/CSS，未使用前端框架。

> **非官方同人项目**：与米哈游 / HoYoverse 无任何隶属或合作关系，详见文末[免责声明](#免责声明)。

## 项目状态

个人业余项目，作者是在校学生（仅寒暑假有时间维护）。**低维护状态**：功能与修复节奏慢，已知问题可能长时间不处理，Issue / PR 会看但响应延迟；高考后或有余力继续更新。请以现状为准使用。

## 功能特性

- **本地优先的对话**：默认连接本地 Ollama，也可切换到 OpenAI 兼容云端厂商（DeepSeek / GLM / Qwen / Kimi / 豆包 / Gemini / 自定义中转）
- **角色扮演人设**：三层提示词（身份 / 人格 / 台词锚）每轮动态注入，语气与记忆随对话延续
- **语音对话**：悬浮球 + 通话窗，sherpa-onnx 本地语音识别，TTS 支持 GPT-SoVITS（本地）/ Edge TTS / OpenAI TTS / MiniMax
- **记忆系统**：长期记忆存储 + 每日自动整理（睡前 tidy）
- **外部消息通道**：微信（iLink）/ 飞书 / 钉钉 —— 全部走**出站长连接**，免公网服务器、免内网穿透
- **工具与技能**：文件读写、Shell 执行、截图读图、键鼠控制（VLM 定位）、`SKILL.md` 技能系统，全部经权限网关审批与审计
- **音乐**：网易云播放（Python MCP 后端）
- **媒体**：屏幕录制 / 截图（FFmpeg）
- **玻璃拟态 UI**：浅色 / 深色 / 跟随系统三档主题、强调色自定义、自定义图片背景

## 环境要求

- Node.js 24（`package.json` `engines` 锁定 `>=24 <25`）、npm 10+
- 本地 Ollama（可选，若使用云端厂商则不需要）
- Windows 10 / 11（64 位）

## 安装与启动

```bash
npm install
npm run dev        # 开发模式（Vite 热更新 + Electron）
npm run build      # 构建 main / preload / renderer
npm start          # 运行已构建产物
```

也可以双击 `start.bat`，按菜单选择：`1` 开发模式、`2` 构建后运行、`3` 只构建。

依赖走 npmmirror 镜像（见 `.npmrc`），无需另配代理；首次安装会自动补齐 Electron 二进制。

## 换机运行指南（可选大件）

以下三样体积大 / 有独立上游，**不进仓库**；不装也不影响主界面与对话，只影响对应功能。

### 1. `models/` —— 本地语音识别（sherpa-onnx，约 80MB）

悬浮球 / 通话窗的本地识别（ASR + VAD）需要两个模型文件，放进项目根的 `models/`（目录不存在就建一个）：

| 文件 | 放置位置 | 来源 |
| --- | --- | --- |
| paraformer 中文小模型 | 解压到 `models/sherpa-onnx-paraformer-zh-small-2024-03-09/`，得到 `model.int8.onnx` 与 `tokens.txt` | [sherpa-onnx asr-models release](https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models) 下载 `sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2` |
| silero-vad | `models/silero_vad.onnx` | 同一 release 页直接下载 `silero_vad.onnx` |

不用本地识别可跳过 —— TTS 有 Edge TTS 零配置兜底，ASR 可在设置里换云端引擎。

### 2. `ffmpeg/` —— 录屏 / 截图转码

应用按「设置页手动指定 → `NAHIDA_FFMPEG` 环境变量 → 项目根 `ffmpeg\bin\ffmpeg.exe` → WinGet / `C:\ffmpeg\bin` / PATH」顺序自动查找，任选其一：

- `winget install Gyan.FFmpeg`（装完即被识别）
- 或从 [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) 下载 essentials 解压，把 `bin\` 放到项目根 `ffmpeg\bin\`（便携方式，随项目文件夹整体搬）

### 3. `vendor/cloud-music-mcp` —— 网易云音乐 MCP 后端（Python）

需先装 [uv](https://docs.astral.sh/uv/)（Python 本身由 uv 自动准备）：

```powershell
winget install astral-sh.uv
git clone https://github.com/Code-MonkeyZhang/cloud-music-mcp vendor/cloud-music-mcp
```

首次播放时应用以 `uv run --project vendor/cloud-music-mcp --frozen --no-dev` 拉起后端，自动按 `uv.lock` 同步环境，无需手动 `uv sync`。

> 上游代码不含本仓库的补丁（非阻塞扫码登录等）。若登录不可用，按 `vendor/cloud-music-mcp/UPSTREAM.md` 的补丁表自行套用。

## 使用

- 主窗口左侧「设置」可配置：模型与厂商、外观（主题 / 强调色 / 背景）、语音引擎、IM 通道、工具权限、记忆整理
- 数据（配置、会话、记忆、技能）全部保存在 Electron userData 目录（Windows：`%APPDATA%\nahida`），**不随仓库分发**
- API Key 经 `safeStorage`（Windows DPAPI）加密存储，换机器后需重新填写，代码不会报错

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `src/main/` | 主进程：窗口与 IPC、配置存储、对话存储、厂商传输层、语音引擎、IM 通道、记忆 / 技能 / 工具、音乐、媒体 |
| `src/preload/` | 预加载：contextBridge 暴露给渲染进程的安全 API |
| `src/renderer/` | 渲染进程：聊天主界面、设置、工具箱、悬浮球、通话窗、状态层、样式 |
| `src/shared/` | 三端共用类型与常量：厂商预设 / 能力表 / 协议路由、IPC 通道、共享契约（记忆 / 工具） |
| `tests/` | Vitest 单测 |

## 技术栈

Electron 43 · TypeScript 5.9 · Vite 5 · Vitest · 原生 HTML/CSS（无前端框架）

第三方组件与许可清单见 [THIRD-PARTY-LICENSES.md](./THIRD-PARTY-LICENSES.md)，应用内「关于 → 开源致谢」同步展示。

## 免责声明

- 本项目为个人业余同人项目，仅供学习与技术交流，**禁止任何商业用途**
- 与米哈游 / HoYoverse 无任何隶属或合作关系；角色形象、美术与音声资产等知识产权归原权利方所有，不在 MIT 许可范围内
- 仓库内角色素材（头像、表情）为同人 / AI 生成，仅供学习展示；其余第三方素材以原权利方声明为准

## 开源许可

MIT License —— 详见 [LICENSE](./LICENSE)。
