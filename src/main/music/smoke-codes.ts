// 9.x：冒烟链路退出码 —— 音乐全链路冒烟入口按阶段失败类型返回不同退出码，供 runner 判定。

export const SMOKE_OK = 0;
export const SMOKE_ELECTRON_INIT_FAILED = 10;
export const SMOKE_MCP_START_FAILED = 20;
export const SMOKE_MCP_INCOMPATIBLE = 21;
export const SMOKE_SEARCH_FAILED = 30;
export const SMOKE_PLAYBACK_FAILED = 40;
export const SMOKE_SHUTDOWN_FAILED = 50;
