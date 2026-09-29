// 6.6.4：open-meteo 纯函数单测（主进程模块按 long-term-store 惯例不顶层 import electron，vitest 可直接 import）
import { describe, expect, it } from "vitest";
import { forecastUrl, parseLatLon, weatherCodeText } from "../src/main/weather/open-meteo";

describe("weatherCodeText", () => {
  it("标准段映射中文文案", () => {
    expect(weatherCodeText(0)).toBe("晴");
    expect(weatherCodeText(2)).toBe("局部多云");
    expect(weatherCodeText(45)).toBe("雾");
    expect(weatherCodeText(61)).toBe("小雨");
    expect(weatherCodeText(95)).toBe("雷暴");
  });

  it("未知码如实显示代码，不编文案；非有限数 → 未知天气", () => {
    expect(weatherCodeText(42)).toBe("天气代码 42");
    expect(weatherCodeText(NaN)).toBe("未知天气");
  });
});

describe("parseLatLon", () => {
  it("合法坐标原样通过", () => {
    expect(parseLatLon(39.9, 116.4)).toEqual({ lat: 39.9, lon: 116.4 });
    expect(parseLatLon(-90, 180)).toEqual({ lat: -90, lon: 180 });
  });

  it("非数字 / 越界 / 非有限 → 中文拒绝原因（入参不可信，非法即拒）", () => {
    expect(parseLatLon("39.9", 116.4)).toBe("纬度必须是 -90 ~ 90 的数字");
    expect(parseLatLon(91, 116.4)).toBe("纬度必须是 -90 ~ 90 的数字");
    expect(parseLatLon(39.9, 181)).toBe("经度必须是 -180 ~ 180 的数字");
    expect(parseLatLon(Number.NaN, 116.4)).toBe("纬度必须是 -90 ~ 90 的数字");
    expect(parseLatLon(undefined, undefined)).toBe("纬度必须是 -90 ~ 90 的数字");
  });
});

describe("forecastUrl", () => {
  it("只带最小参数（number 构造，无注入面）", () => {
    expect(forecastUrl(39.9, 116.4)).toBe(
      "https://api.open-meteo.com/v1/forecast?latitude=39.9&longitude=116.4&current_weather=true",
    );
  });
});
