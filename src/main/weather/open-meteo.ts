// 6.6.4：在线天气（Open-Meteo）—— 主进程只做取数，不含状态；渲染侧拿到结果自己 patch env.weather
// 惯例照 long-term-store.ts：**运行时不 import electron**（函数体内 require），保证被 vitest import 时不拉起 electron
// 网络惯例照 gpt-sovits / edge-tts：全局 fetch + AbortSignal.timeout；失败返回可读中文错误，绝不编占位假数据
import { IPC } from "../../shared/ipc-channels";

/** Open-Meteo 免费公开接口（无 key）；只要 current_weather 的最小字段 */
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const TIMEOUT_MS = 8_000;

export type WeatherOnlineResult = { ok: true; text: string; temp: string } | { ok: false; error: string };

/** WMO weathercode → 中文文案（Open-Meteo 文档标准段）。未知码如实显示代码，不编文案 */
export function weatherCodeText(code: number): string {
  const table: Record<number, string> = {
    0: "晴", 1: "基本晴", 2: "局部多云", 3: "阴",
    45: "雾", 48: "雾凇",
    51: "毛毛雨·轻", 53: "毛毛雨·中", 55: "毛毛雨·浓", 56: "冻毛毛雨·轻", 57: "冻毛毛雨·浓",
    61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨·轻", 67: "冻雨·浓",
    71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒",
    80: "阵雨·弱", 81: "阵雨·中", 82: "阵雨·强", 85: "阵雪·弱", 86: "阵雪·浓",
    95: "雷暴", 96: "雷暴·轻冰雹", 99: "雷暴·强冰雹",
  };
  return table[code] ?? (Number.isFinite(code) ? `天气代码 ${code}` : "未知天气");
}

/** 入参校验（IPC 入参不可信，非法即拒）：经纬度必须是有限数字且落在范围内。合法 → 坐标，非法 → 中文原因 */
export function parseLatLon(lat: unknown, lon: unknown): { lat: number; lon: number } | string {
  if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    return "纬度必须是 -90 ~ 90 的数字";
  }
  if (typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    return "经度必须是 -180 ~ 180 的数字";
  }
  return { lat, lon };
}

/** 请求 URL：lat/lon 已过 parseLatLon（number 构造），无注入面 */
export function forecastUrl(lat: number, lon: number): string {
  return `${FORECAST_URL}?latitude=${lat}&longitude=${lon}&current_weather=true`;
}

/** 注册 weather:fetch-online。只取最小字段：current_weather.temperature / weathercode */
export function registerWeatherHandlers(): void {
  const { ipcMain } = require("electron") as typeof import("electron");
  ipcMain.handle(IPC.WEATHER_FETCH_ONLINE, async (_event: unknown, input: unknown): Promise<WeatherOnlineResult> => {
    const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
    const pos = parseLatLon(raw.lat, raw.lon);
    if (typeof pos === "string") return { ok: false, error: pos };
    try {
      const resp = await fetch(forecastUrl(pos.lat, pos.lon), { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!resp.ok) return { ok: false, error: `天气接口返回 ${resp.status}` };
      const data = (await resp.json()) as { current_weather?: { temperature?: unknown; weathercode?: unknown } };
      const cw = data.current_weather;
      const temp = typeof cw?.temperature === "number" && Number.isFinite(cw.temperature) ? cw.temperature : null;
      if (!cw || temp === null) return { ok: false, error: "天气接口响应里没有当前天气数据" };
      const code = typeof cw.weathercode === "number" && Number.isFinite(cw.weathercode) ? cw.weathercode : NaN;
      return { ok: true, text: weatherCodeText(code), temp: `${Math.round(temp * 10) / 10}°C` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: /timeout|abort/i.test(msg) ? "天气请求超时，请稍后再试" : `天气获取失败：${msg}` };
    }
  });
}
