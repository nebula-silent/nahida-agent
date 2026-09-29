// 3.4 新增：厂商预设表 —— 「有哪些厂商可选」的唯一来源（渲染进程直接 import，不过 IPC）。
// 依据：内部规格 §3.2（十条照抄）
//
// baseUrl 约定：云端全部填「OpenAI 兼容根」= 请求路径直接接 /chat/completions 的那一层
// （3.5 负责拼完整 endpoint）；ollama 例外，它是主机根（/api/chat）。
// defaultModel 一律空串（指令 D6）：模型名迭代快，写死必过时 —— 正路是 3.7 用 API Key
// 拉 GET /v1/models，Ollama 走 listModels() 动态列；字段留着，以后要填不用改类型。
// hint 是给用户看的文案：集中在这张表里，不要在渲染代码里另写一份。
import type { ProviderPreset } from "./types";

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "ollama",
    displayName: "本地 Ollama",
    transport: "ollama",
    baseUrl: "http://localhost:11434",
    defaultModel: "",
    apiKeyRequired: false,
    baseUrlRequired: false,
    hint: "本机运行的模型，不需要 API Key，也不需要联网",
  },
  {
    id: "custom",
    displayName: "自定义 / 中转",
    transport: "openai",
    baseUrl: "",
    defaultModel: "",
    apiKeyRequired: true,
    baseUrlRequired: true,
    hint: "自建服务或中转站，填 OpenAI 兼容地址；填了 /anthropic 后缀会自动走 Anthropic 协议（3.5 起生效）",
  },
  {
    id: "openai",
    displayName: "OpenAI",
    transport: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "",
    apiKeyRequired: true,
    baseUrlRequired: false,
    hint: "官方 API",
  },
  {
    id: "anthropic",
    displayName: "Anthropic（Claude）",
    transport: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "",
    apiKeyRequired: true,
    baseUrlRequired: false,
    hint: "官方 API，走 Anthropic 原生协议",
  },
  {
    id: "gemini",
    displayName: "Google Gemini",
    transport: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "",
    apiKeyRequired: true,
    baseUrlRequired: false,
    hint: "走 Google 的 OpenAI 兼容入口",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek（深度求索）",
    transport: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "",
    apiKeyRequired: true,
    baseUrlRequired: false,
    hint: "官方 API",
  },
  {
    id: "glm",
    displayName: "智谱 GLM",
    transport: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "",
    apiKeyRequired: true,
    baseUrlRequired: false,
    hint: "官方 API",
  },
  {
    id: "qwen",
    displayName: "通义千问（百炼）",
    transport: "openai",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "",
    apiKeyRequired: true,
    baseUrlRequired: false,
    hint: "阿里云百炼的 OpenAI 兼容模式",
  },
  {
    id: "kimi",
    displayName: "Kimi（月之暗面）",
    transport: "openai",
    baseUrl: "https://api.moonshot.cn/v1",
    defaultModel: "",
    apiKeyRequired: true,
    baseUrlRequired: false,
    hint: "官方 API",
  },
  {
    id: "doubao",
    displayName: "豆包（火山方舟）",
    transport: "openai",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    defaultModel: "",
    apiKeyRequired: true,
    baseUrlRequired: false,
    hint: "火山方舟的 OpenAI 兼容入口",
  },
] satisfies readonly ProviderPreset[];
