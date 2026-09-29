// 4.4 验收主依据（任务清单 §11.A）：GPT-SoVITS 引擎 18 条表驱动用例。
// 核心：「假 GPT-SoVITS 服务」—— 单测不能依赖真服务（CI / 换机没装；500 / 超时 / 404
// 这些异常分支真服务造不出来），起一个最小真 HTTP 服务才能验到真网络路径。
// 临时文件照 4.1.1 先例：os.tmpdir() 造空文件，afterEach 删掉，不读 E:\ 真文件。
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createGptSovitsEngine, GptSovitsEngine } from "../src/main/voice/engines/gpt-sovits";
import { resolveVoiceConfig, assertRequiredConfig, type VoiceConfigValues } from "../src/main/voice/config-resolver";
import { voiceRegistry } from "../src/main/voice/registry";
import { VoiceError } from "../src/shared/voice/types";

/** schema 不从引擎模块导出（不为测试改产品代码）：从实例上取同一份只读引用 */
const CONFIG_SCHEMA = createGptSovitsEngine().configSchema;

/** health() / start() **没有入参**，只能经 D3 接缝喂 stored 层 —— 第 12~16 条全靠它 */
function engineWith(stored: VoiceConfigValues): GptSovitsEngine {
  return new GptSovitsEngine({ readStoredConfig: () => stored });
}

/** 打包净化（2026-09-29）后 default 全空串：走 synthesize 的用例须自带 promptText 过必填校验 */
const PROMPT_TEXT = "感觉到好炙热，刚好是你经过";

/** 44 字节合法 RIFF 头 + 0 字节数据（16kHz / 单声道 / 16bit） */
const FAKE_WAV = Buffer.from(
  "524946462400000057415645666d74201000000001000100803e0000007d0000020010006461746100000000",
  "hex",
);

// ===== 假服务与临时文件的基础设施 =====

interface FakeRequest {
  kind: "weights" | "tts";
  route?: string;
  weightsPath?: string;
  body?: string;
}

/** 最小假 GPT-SoVITS：/docs 回 200；/set_*_weights 记录 query；/tts 记录 body 并回 FAKE_WAV */
function startFakeServer(opts: { ttsDelayMs?: number; ttsStatus?: number; weightsStatus?: number } = {}) {
  const requests: FakeRequest[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/docs") {
      res.writeHead(200);
      return res.end("ok");
    }
    if (url.pathname.startsWith("/set_")) {
      // searchParams.get 已做 URL 解码，Windows 路径里的 \ 会还原
      requests.push({ kind: "weights", route: url.pathname, weightsPath: url.searchParams.get("weights_path") ?? "" });
      res.writeHead(opts.weightsStatus ?? 200);
      return res.end("{}");
    }
    if (req.method === "POST" && url.pathname === "/tts") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => {
        requests.push({ kind: "tts", body });
        const send = () => {
          res.writeHead(opts.ttsStatus ?? 200, { "Content-Type": "audio/wav" });
          res.end(FAKE_WAV);
        };
        if (opts.ttsDelayMs) setTimeout(send, opts.ttsDelayMs);
        else send();
      });
    }
    res.writeHead(404);
    res.end();
  });
  return {
    requests,
    listen: () =>
      new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () =>
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
        );
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const tmpFiles: string[] = [];
/** 造一个「真实存在」的临时文件（参考音频 / 权重路径用），afterEach 统一删 */
function makeTmp(name: string): string {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, "x");
  tmpFiles.push(p);
  return p;
}
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(() => {
  for (const p of tmpFiles.splice(0)) fs.rmSync(p, { force: true });
  return Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("4.4 GPT-SoVITS 引擎", () => {
  // 1 元数据
  it("1 引擎元数据：id/kind/locality/streaming", () => {
    const e = createGptSovitsEngine();
    expect(e.id).toBe("gpt-sovits");
    expect(e.kind).toBe("tts");
    expect(e.locality).toBe("local");
    expect(e.streaming).toBe(false);
  });

  // 2 configSchema 形状
  it("2 select 字段都有 options；required 恰好 3 个", () => {
    for (const f of CONFIG_SCHEMA) {
      if (f.type === "select") expect(f.options?.length ?? 0).toBeGreaterThan(0);
    }
    expect(CONFIG_SCHEMA.filter((f) => f.required).map((f) => f.key)).toEqual([
      "baseUrl",
      "refAudioPath",
      "promptText",
    ]);
  });

  // 3 注册进真注册表
  it("3 注册不抛，resolveChain(tts) 含 gpt-sovits", () => {
    expect(() => voiceRegistry.register(createGptSovitsEngine())).not.toThrow();
    expect(voiceRegistry.resolveChain("tts")).toContain("gpt-sovits");
  });

  // 4~6 配置解析三层
  it("4 overrides 覆盖 default", () => {
    const v = resolveVoiceConfig(CONFIG_SCHEMA, { overrides: { speed: 1.5 } });
    expect(v.speed).toBe(1.5);
  });

  it("5 无 overrides 用 default", () => {
    const v = resolveVoiceConfig(CONFIG_SCHEMA, {});
    expect(v.speed).toBe(1);
  });

  it("6 三层优先级 overrides > stored > default", () => {
    const v = resolveVoiceConfig(CONFIG_SCHEMA, {
      overrides: { speed: 1.7 },
      stored: { speed: 0.8 },
    });
    expect(v.speed).toBe(1.7);
    const v2 = resolveVoiceConfig(CONFIG_SCHEMA, { stored: { speed: 0.8 } });
    expect(v2.speed).toBe(0.8);
  });

  // 7 必填校验
  it("7 缺 baseUrl 抛 VoiceError 且含「服务地址」", () => {
    expect(() => assertRequiredConfig(CONFIG_SCHEMA, {})).toThrow(VoiceError);
    expect(() => assertRequiredConfig(CONFIG_SCHEMA, {})).toThrow(/服务地址/);
  });

  // 8 请求体字段
  it("8 假服务收到正确的请求体", async () => {
    const s = startFakeServer();
    servers.push(s);
    const base = await s.listen();
    const ref = makeTmp("nx-ref-8.mp3");
    const engine = engineWith({ baseUrl: base, refAudioPath: ref, promptText: PROMPT_TEXT });
    await engine.synthesize({ text: "你好" });

    const tts = s.requests.find((r) => r.kind === "tts");
    expect(tts).toBeDefined();
    const body = JSON.parse(tts!.body!);
    expect(body.text).toBe("你好");
    expect(body.text_lang).toBe("zh");
    expect(body.prompt_lang).toBe("zh");
    expect(body.ref_audio_path).toBe(ref);
    expect(body.prompt_text).toBe(PROMPT_TEXT);
    expect(body.streaming_mode).toBe(false);
    expect(body.media_type).toBe("wav");
  });

  // 9 overrides.speed 进 speed_factor（§11.E 的靶子）
  it("9 overrides.speed 真的进了 speed_factor", async () => {
    const s = startFakeServer();
    servers.push(s);
    const base = await s.listen();
    const ref = makeTmp("nx-ref-9.mp3");
    const engine = engineWith({ baseUrl: base, refAudioPath: ref, promptText: PROMPT_TEXT });
    await engine.synthesize({ text: "你好", overrides: { speed: 1.7 } });

    const body = JSON.parse(s.requests.find((r) => r.kind === "tts")!.body!);
    expect(body.speed_factor).toBe(1.7);
  });

  // 10 返回值形状与逐字节相等
  it("10 返回 wav / Uint8Array / 字节与 FAKE_WAV 相等", async () => {
    const s = startFakeServer();
    servers.push(s);
    const base = await s.listen();
    const ref = makeTmp("nx-ref-10.mp3");
    const engine = engineWith({ baseUrl: base, refAudioPath: ref, promptText: PROMPT_TEXT });
    const out = await engine.synthesize({ text: "你好" });

    expect(out.format).toBe("wav");
    expect(out.audio instanceof Uint8Array).toBe(true);
    expect(Buffer.from(out.audio).equals(FAKE_WAV)).toBe(true);
  });

  // 11 非 2xx
  it("11 ttsStatus 500 → VoiceError 含 500", async () => {
    const s = startFakeServer({ ttsStatus: 500 });
    servers.push(s);
    const base = await s.listen();
    const ref = makeTmp("nx-ref-11.mp3");
    const engine = engineWith({ baseUrl: base, refAudioPath: ref, promptText: PROMPT_TEXT });

    await expect(engine.synthesize({ text: "你好" })).rejects.toThrow(VoiceError);
    await expect(engine.synthesize({ text: "你好" })).rejects.toThrow(/500/);
  });

  // 12 服务未启动
  it("12 服务没在跑：health unavailable + synthesize 抛 VoiceError", async () => {
    const s = startFakeServer();
    const base = await s.listen();
    await s.close(); // 先拿到端口再关掉 → 该端口此刻无人监听
    const ref = makeTmp("nx-ref-12.mp3");
    const engine = engineWith({ baseUrl: base, refAudioPath: ref, promptText: PROMPT_TEXT });

    const h = await engine.health();
    expect(h.availability).toBe("unavailable");
    expect(h.detail).toContain("服务没在跑");

    await expect(engine.synthesize({ text: "你好" })).rejects.toThrow(VoiceError);
  });

  // 13 参考音频不存在
  it("13 参考音频不存在 → health unavailable 含「参考音频文件不存在」", async () => {
    const s = startFakeServer();
    servers.push(s);
    const base = await s.listen();
    const engine = engineWith({ baseUrl: base, refAudioPath: "Z:\\nahida-test\\不存在.mp3" });

    const h = await engine.health();
    expect(h.availability).toBe("unavailable");
    expect(h.detail).toContain("参考音频文件不存在");
  });

  // 14 权重文件不存在
  it("14 权重文件不存在 → health unavailable 含「权重文件不存在」", async () => {
    const s = startFakeServer();
    servers.push(s);
    const base = await s.listen();
    const ref = makeTmp("nx-ref-14.mp3");
    const engine = engineWith({ baseUrl: base, refAudioPath: ref, gptWeightsPath: "Z:\\nahida-test\\不存在.ckpt" });

    const h = await engine.health();
    expect(h.availability).toBe("unavailable");
    expect(h.detail).toContain("权重文件不存在");
  });

  // 15 start() 调两个权重端点
  it("15 start() 切了两个权重，weights_path 分别正确", async () => {
    const s = startFakeServer();
    servers.push(s);
    const base = await s.listen();
    const ref = makeTmp("nx-ref-15.mp3");
    const gpt = makeTmp("nx-gpt-15.ckpt");
    const sovits = makeTmp("nx-sovits-15.pth");
    const engine = engineWith({ baseUrl: base, refAudioPath: ref, gptWeightsPath: gpt, sovitsWeightsPath: sovits });

    await engine.start();

    const w = s.requests.filter((r) => r.kind === "weights");
    expect(w).toHaveLength(2);
    expect(w[0].route).toBe("/set_gpt_weights");
    expect(w[0].weightsPath).toBe(gpt);
    expect(w[1].route).toBe("/set_sovits_weights");
    expect(w[1].weightsPath).toBe(sovits);
  });

  // 16 权重端点 404 → best-effort 不抛
  it("16 权重端点 404 → start() 不抛（容忍老版本）", async () => {
    const s = startFakeServer({ weightsStatus: 404 });
    servers.push(s);
    const base = await s.listen();
    const ref = makeTmp("nx-ref-16.mp3");
    const gpt = makeTmp("nx-gpt-16.ckpt");
    const sovits = makeTmp("nx-sovits-16.pth");
    const engine = engineWith({ baseUrl: base, refAudioPath: ref, gptWeightsPath: gpt, sovitsWeightsPath: sovits });

    await expect(engine.start()).resolves.toBeUndefined();
  });

  // 17 合成超时
  it("17 超时 → VoiceError 含「超时」", async () => {
    const s = startFakeServer({ ttsDelayMs: 200 });
    servers.push(s);
    const base = await s.listen();
    const ref = makeTmp("nx-ref-17.mp3");
    const engine = engineWith({ baseUrl: base, refAudioPath: ref, promptText: PROMPT_TEXT });

    await expect(engine.synthesize({ text: "你好", overrides: { timeoutMs: 50 } })).rejects.toThrow(VoiceError);
    await expect(engine.synthesize({ text: "你好", overrides: { timeoutMs: 50 } })).rejects.toThrow(/超时/);
  });

  // 18 用户打断原样透出 AbortError（不是 VoiceError）
  it("18 req.signal 已 abort → 原样抛 AbortError", async () => {
    const s = startFakeServer();
    servers.push(s);
    const base = await s.listen();
    const ref = makeTmp("nx-ref-18.mp3");
    const engine = engineWith({ baseUrl: base, refAudioPath: ref, promptText: PROMPT_TEXT });

    const ac = new AbortController();
    ac.abort(); // 先中止再调用（barge-in 场景）
    const err = await engine.synthesize({ text: "你好", signal: ac.signal }).catch((e: unknown) => e);

    expect(err).toBeDefined();
    expect((err as Error).name).toBe("AbortError");
    expect(err instanceof VoiceError).toBe(false);
  });
});
