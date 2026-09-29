// 4.5 验收主依据（任务清单 §11.A）：两个云端 TTS 引擎 18 条表驱动用例。
// 核心：「两个假 HTTP 服务」（OpenAI 兼容 / MiniMax）—— 理由同 4.4：
//   ① 要能在**没有 Key** 的机器上跑；② 500 / 超时 / base_resp 业务错误 / 非 hex 这些异常分支真服务造不出来。
// ⚠️ 第 5 / 6 条一律 new VoiceRegistry()，**不许用单例 voiceRegistry** —— 单例全局共享，
//    两个用例 register 同样的 id，第二个就抛「语音引擎 id 重复」，且随执行顺序时红时绿。
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MiniMaxEngine } from "../src/main/voice/engines/minimax";
import { OpenAiTtsEngine } from "../src/main/voice/engines/openai-tts";
import { createGptSovitsEngine } from "../src/main/voice/engines/gpt-sovits";
import { VoiceRegistry } from "../src/main/voice/registry";
import type { VoiceConfigValues } from "../src/main/voice/config-resolver";
import { VoiceError, type VoiceEngine } from "../src/shared/voice/types";

/** health() / synthesize() 的 stored 层只能经 D7 接缝喂 —— 大部分用例靠它 */
function openaiWith(stored: VoiceConfigValues): OpenAiTtsEngine {
  return new OpenAiTtsEngine({ readStoredConfig: () => stored });
}
function minimaxWith(stored: VoiceConfigValues): MiniMaxEngine {
  return new MiniMaxEngine({ readStoredConfig: () => stored });
}

/** 假 mp3 字节（0xFFFB 是 MPEG-1 Layer III 的帧同步字，探针里按 magic 打印） */
const FAKE_MP3 = Buffer.from("fffbb064000000001122334455667788", "hex");
/** 假 MiniMax 音频：一段已知 hex（第 17 条要逐字节比对） */
const HEX_AUDIO = "00112233445566778899aabbccddeeff";
const EXPECTED_AUDIO = Buffer.from(HEX_AUDIO, "hex");

interface Recorded {
  url?: string;
  auth?: string;
  contentType?: string;
  body?: any;
}

/** 假 OpenAI 兼容服务：POST /v1/audio/speech → 记录 headers/body，回二进制 FAKE_MP3 */
function startFakeOpenAi(opts: { status?: number; delayMs?: number } = {}) {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/audio/speech") {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => {
        requests.push({
          url: req.url,
          auth: req.headers.authorization,
          contentType: req.headers["content-type"],
          body: JSON.parse(body),
        });
        const send = () => {
          if (res.destroyed || res.writableEnded) return; // 客户端可能已超时/打断
          res.writeHead(opts.status ?? 200, { "Content-Type": "audio/mpeg" });
          res.end(FAKE_MP3);
        };
        if (opts.delayMs) setTimeout(send, opts.delayMs);
        else send();
      });
    }
    res.writeHead(404);
    res.end();
  });
  res_guard(server);
  return {
    requests,
    listen: () =>
      new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () =>
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
        );
      }),
    close: () => closeServer(server),
  };
}

/** 假 MiniMax：POST /v1/t2a_v2 → 记录 query/body，回 { data: { audio: hex }, base_resp } */
function startFakeMiniMax(opts: { status?: number; delayMs?: number; bizCode?: number; bizMsg?: string } = {}) {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && (req.url ?? "").startsWith("/v1/t2a_v2")) {
      let body = "";
      req.on("data", (c) => (body += c));
      return req.on("end", () => {
        requests.push({
          url: req.url,
          auth: req.headers.authorization,
          contentType: req.headers["content-type"],
          body: JSON.parse(body),
        });
        const send = () => {
          if (res.destroyed || res.writableEnded) return;
          const payload = JSON.stringify({
            data: { audio: opts.bizCode ? "" : HEX_AUDIO },
            base_resp: { status_code: opts.bizCode ?? 0, status_msg: opts.bizMsg ?? "success" },
          });
          res.writeHead(opts.status ?? 200, { "Content-Type": "application/json" });
          res.end(payload);
        };
        if (opts.delayMs) setTimeout(send, opts.delayMs);
        else send();
      });
    }
    res.writeHead(404);
    res.end();
  });
  res_guard(server);
  return {
    requests,
    listen: () =>
      new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () =>
          resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
        );
      }),
    close: () => closeServer(server),
  };
}

/** 请求被中途打断时，假服务可能往已销毁的 socket 写 → 吞掉，别让用例被无关报错污染 */
function res_guard(server: http.Server): void {
  server.on("clientError", () => undefined);
}
/** 关服务：先断掉 keep-alive 连接，否则 server.close() 要等 undici 的保活超时（拖慢用例） */
function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(() => Promise.all(servers.splice(0).map((s) => s.close())));

/** 从实例上取同一份只读引用（schema 不从引擎模块导出，不为测试改产品代码） */
const OPENAI_SCHEMA = new OpenAiTtsEngine().configSchema;
const MINIMAX_SCHEMA = new MiniMaxEngine().configSchema;

describe("4.5 云端 TTS 引擎（openai-tts / minimax）", () => {
  // 1~2 元数据
  it("1 openai-tts 元数据：id/kind/locality/streaming", () => {
    const e = new OpenAiTtsEngine();
    expect(e.id).toBe("openai-tts");
    expect(e.kind).toBe("tts");
    expect(e.locality).toBe("cloud");
    expect(e.streaming).toBe(false);
  });

  it("2 minimax 元数据：id/kind/locality/streaming", () => {
    const e = new MiniMaxEngine();
    expect(e.id).toBe("minimax");
    expect(e.kind).toBe("tts");
    expect(e.locality).toBe("cloud");
    expect(e.streaming).toBe(false);
  });

  // 3~4 configSchema 形状
  it("3 select 字段都有 options；required 恰好 2 个（baseUrl / apiKey）", () => {
    for (const schema of [OPENAI_SCHEMA, MINIMAX_SCHEMA]) {
      for (const f of schema) {
        if (f.type === "select") expect(f.options?.length ?? 0).toBeGreaterThan(0);
      }
      expect(schema.filter((f) => f.required).map((f) => f.key)).toEqual(["baseUrl", "apiKey"]);
    }
  });

  it("4 apiKey 字段是 password + secret", () => {
    for (const schema of [OPENAI_SCHEMA, MINIMAX_SCHEMA]) {
      const key = schema.find((f) => f.key === "apiKey");
      expect(key?.type).toBe("password");
      expect(key?.secret).toBe(true);
    }
  });

  // 5~6 注册进真注册表 + 降级链顺序
  it("5 两个引擎注册进真 VoiceRegistry 不抛，resolveChain(tts) 含两个 id", () => {
    const r = new VoiceRegistry();
    expect(() => {
      r.register(new OpenAiTtsEngine());
      r.register(new MiniMaxEngine());
    }).not.toThrow();
    const chain = r.resolveChain("tts");
    expect(chain).toContain("openai-tts");
    expect(chain).toContain("minimax");
  });

  it("6 降级链顺序：本地在云端前、云端按注册顺序", () => {
    const r = new VoiceRegistry();
    r.register(createGptSovitsEngine());
    r.register(new OpenAiTtsEngine());
    r.register(new MiniMaxEngine());
    expect(r.resolveChain("tts").slice(0, 3)).toEqual(["gpt-sovits", "openai-tts", "minimax"]);
  });

  // 7~8 health()：只查配置，不发请求
  it("7 没填 Key → unavailable 且 detail 含「API Key」", async () => {
    const s = startFakeOpenAi();
    servers.push(s);
    const base = await s.listen();

    const h1 = await openaiWith({ baseUrl: `${base}/v1` }).health();
    expect(h1.availability).toBe("unavailable");
    expect(h1.detail).toContain("API Key");

    const h2 = await minimaxWith({ baseUrl: `${base}/v1` }).health();
    expect(h2.availability).toBe("unavailable");
    expect(h2.detail).toContain("API Key");

    expect(s.requests).toHaveLength(0); // D6：health() 绝不许发真请求
  });

  it("8 填了地址 + Key → ready", async () => {
    const s = startFakeOpenAi();
    servers.push(s);
    const base = await s.listen();

    expect((await openaiWith({ baseUrl: `${base}/v1`, apiKey: "k" }).health()).availability).toBe("ready");
    expect((await minimaxWith({ baseUrl: `${base}/v1`, apiKey: "k" }).health()).availability).toBe("ready");
  });

  // 9~15 OpenAI 合成
  it("9 假服务收到 Authorization 与 Content-Type", async () => {
    const s = startFakeOpenAi();
    servers.push(s);
    const base = await s.listen();
    await openaiWith({ baseUrl: `${base}/v1`, apiKey: "sk-test" }).synthesize({ text: "你好" });

    const req = s.requests[0];
    expect(req.auth).toBe("Bearer sk-test");
    expect(req.contentType).toBe("application/json");
  });

  it("10 请求体字段正确（model / input / voice / response_format / speed）", async () => {
    const s = startFakeOpenAi();
    servers.push(s);
    const base = await s.listen();
    await openaiWith({ baseUrl: `${base}/v1`, apiKey: "k" }).synthesize({ text: "你好，我是纳西妲。" });

    const body = s.requests[0].body;
    expect(body.model).toBe("tts-1");
    expect(body.input).toBe("你好，我是纳西妲。");
    expect(body.voice).toBe("nova");
    expect(body.response_format).toBe("mp3");
    expect(body.speed).toBe(1);
    expect(body.text).toBeUndefined(); // 不许用 Cyrene 的自造字段名
  });

  it("11 overrides.speed 真的进了 body.speed", async () => {
    const s = startFakeOpenAi();
    servers.push(s);
    const base = await s.listen();
    await openaiWith({ baseUrl: `${base}/v1`, apiKey: "k" }).synthesize({
      text: "你好",
      overrides: { speed: 1.7 },
    });
    expect(s.requests[0].body.speed).toBe(1.7);
  });

  it("12 返回值：format=mp3 / Uint8Array / 字节与 FAKE_MP3 逐字节相等", async () => {
    const s = startFakeOpenAi();
    servers.push(s);
    const base = await s.listen();
    const out = await openaiWith({ baseUrl: `${base}/v1`, apiKey: "k" }).synthesize({ text: "你好" });

    expect(out.format).toBe("mp3");
    expect(out.audio instanceof Uint8Array).toBe(true);
    expect(Buffer.from(out.audio).equals(FAKE_MP3)).toBe(true);
  });

  it("13 非 2xx（500）→ VoiceError 含 500", async () => {
    const s = startFakeOpenAi({ status: 500 });
    servers.push(s);
    const base = await s.listen();
    const engine = openaiWith({ baseUrl: `${base}/v1`, apiKey: "k" });

    await expect(engine.synthesize({ text: "你好" })).rejects.toThrow(VoiceError);
    await expect(engine.synthesize({ text: "你好" })).rejects.toThrow(/500/);
  });

  it("14 超时 → VoiceError 含「超时」", async () => {
    const s = startFakeOpenAi({ delayMs: 200 });
    servers.push(s);
    const base = await s.listen();
    const engine = openaiWith({ baseUrl: `${base}/v1`, apiKey: "k" });

    await expect(engine.synthesize({ text: "你好", overrides: { timeoutMs: 50 } })).rejects.toThrow(VoiceError);
    await expect(engine.synthesize({ text: "你好", overrides: { timeoutMs: 50 } })).rejects.toThrow(/超时/);
  });

  it("15 req.signal 已 abort → 原样抛 AbortError（不是 VoiceError）", async () => {
    const s = startFakeOpenAi();
    servers.push(s);
    const base = await s.listen();
    const engine = openaiWith({ baseUrl: `${base}/v1`, apiKey: "k" });

    const ac = new AbortController();
    ac.abort(); // 先中止再调用（barge-in 场景）
    const err = await engine.synthesize({ text: "你好", signal: ac.signal }).catch((e: unknown) => e);

    expect(err).toBeDefined();
    expect((err as Error).name).toBe("AbortError");
    expect(err instanceof VoiceError).toBe(false);
  });

  // 16~18 MiniMax 合成
  it("16 请求体：text / stream=false / output_format=hex / voice_setting / audio_setting", async () => {
    const s = startFakeMiniMax();
    servers.push(s);
    const base = await s.listen();
    await minimaxWith({ baseUrl: `${base}/v1`, apiKey: "k" }).synthesize({ text: "你好，我是纳西妲。" });

    const req = s.requests[0];
    expect(req.url).toBe("/v1/t2a_v2"); // groupId 留空 → 不拼 query
    expect(req.auth).toBe("Bearer k");
    const body = req.body;
    expect(body.text).toBe("你好，我是纳西妲。");
    expect(body.stream).toBe(false);
    expect(body.output_format).toBe("hex");
    expect(body.voice_setting.voice_id).toBe("female-shaonv");
    expect(body.voice_setting.speed).toBe(1);
    expect(body.audio_setting.format).toBe("mp3");
    expect(body.audio_setting.sample_rate).toBe(32000);
  });

  it("16b groupId 填了才拼 query", async () => {
    const s = startFakeMiniMax();
    servers.push(s);
    const base = await s.listen();
    await minimaxWith({ baseUrl: `${base}/v1`, apiKey: "k", groupId: "g1" }).synthesize({ text: "你好" });
    expect(s.requests[0].url).toContain("GroupId=g1");
  });

  it("17 hex 解码：返回字节与期望逐字节相等", async () => {
    const s = startFakeMiniMax();
    servers.push(s);
    const base = await s.listen();
    const out = await minimaxWith({ baseUrl: `${base}/v1`, apiKey: "k" }).synthesize({ text: "你好" });

    expect(out.format).toBe("mp3");
    expect(Buffer.from(out.audio).equals(EXPECTED_AUDIO)).toBe(true);
    expect(out.audio.length).toBe(EXPECTED_AUDIO.length);
  });

  it("18 业务错误（HTTP 200 + base_resp 1004）→ VoiceError 含 status_msg 与 code", async () => {
    const s = startFakeMiniMax({ bizCode: 1004, bizMsg: "余额不足" });
    servers.push(s);
    const base = await s.listen();
    const engine = minimaxWith({ baseUrl: `${base}/v1`, apiKey: "k" });

    await expect(engine.synthesize({ text: "你好" })).rejects.toThrow(VoiceError);
    await expect(engine.synthesize({ text: "你好" })).rejects.toThrow(/余额不足/);
    await expect(engine.synthesize({ text: "你好" })).rejects.toThrow(/1004/);
  });
});

// 形状校验的兜底：确认这两个引擎真的能被注册表认下来（§7 的注册链首用）
describe("4.5 注册链形状", () => {
  it("两个引擎都通过 assertEngineShape（注册不抛）", () => {
    const r = new VoiceRegistry();
    for (const e of [new OpenAiTtsEngine(), new MiniMaxEngine()] as VoiceEngine[]) {
      expect(() => r.register(e)).not.toThrow();
    }
    expect(r.listByKind("tts").map((e) => e.id)).toEqual(["openai-tts", "minimax"]);
  });
});