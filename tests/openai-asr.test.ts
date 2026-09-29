// 4.8 验收主依据（4.8 指令 §11.A）：OpenAI 兼容云端 ASR 引擎 27 条表驱动用例。
// 核心：一个假 HTTP 服务端（理由同 4.4/4.5：① 要能在**没有 Key** 的机器上跑；
//   ② 500 / 超时 / 非 JSON / 缺 text 这些异常分支真服务造不出来）。
// ⚠️ 一律 new VoiceRegistry()，**不许用单例 voiceRegistry** —— 单例全局共享，
//    两个用例 register 同样的 id，第二个就抛「语音引擎 id 重复」，且随执行顺序时红时绿（4.5 用例注释）。
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { OpenAiAsrEngine } from "../src/main/voice/engines/openai-asr";
import { VoiceRegistry } from "../src/main/voice/registry";
import type { VoiceConfigValues } from "../src/main/voice/config-resolver";
import { VoiceError, type VoiceEngine } from "../src/shared/voice/types";

// ⚠️ undici（Node 24）已知尾巴：**预中止 signal + FormData（流式）body** 时，fetch 正确抛 AbortError
//    （这正是用例 24 要验的产品行为），但其内部请求体流随后会往已关闭的 ReadableStream enqueue 一次
//    → unhandled rejection（ERR_INVALID_STATE「Invalid state: ReadableStream is already closed」）。
//    最小复现：.tmp-48-probe/probe-abort2.js —— 字符串 body 不触发（所以 4.5 的 postJson 用例没事）。
//    这里只吞这一条 undici 内部噪音，其余 unhandled 照常暴露给 vitest（重新抛成 uncaughtException）。
const UNDICI_TAIL_NOISE = "Invalid state: ReadableStream is already closed";
process.removeAllListeners("unhandledRejection");
process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error && reason.message === UNDICI_TAIL_NOISE) return;
  setTimeout(() => {
    throw reason;
  });
});

/** 假 wav：12 字节，够用来验「字节原样进 body」 */
const FAKE_WAV = Buffer.from("52494646e803000057415645", "hex");
const FAKE_TEXT = "你好，我是纳西妲。";

interface Recorded {
  url?: string;
  auth?: string;
  contentType?: string;
  body: Buffer;
}

function startFakeTranscribe(
  opts: { status?: number; delayMs?: number; shape?: "json" | "text" | "verbose_json" | "garbage" | "noText" } = {},
) {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/audio/transcriptions") {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      return req.on("end", () => {
        requests.push({
          url: req.url,
          auth: req.headers.authorization,
          contentType: req.headers["content-type"],
          body: Buffer.concat(chunks),
        });
        const send = () => {
          if (res.destroyed || res.writableEnded) return; // 客户端可能已超时/打断
          const shape = opts.shape ?? "json";
          if (shape === "text") {
            res.writeHead(opts.status ?? 200, { "Content-Type": "text/plain; charset=utf-8" });
            return res.end(FAKE_TEXT);
          }
          if (shape === "garbage") {
            res.writeHead(opts.status ?? 200, { "Content-Type": "application/json" });
            return res.end("not-json{");
          }
          res.writeHead(opts.status ?? 200, { "Content-Type": "application/json" });
          if (shape === "noText") return res.end(JSON.stringify({ ok: true }));
          res.end(
            JSON.stringify(
              shape === "verbose_json" ? { text: FAKE_TEXT, language: "zh", duration: 1.5 } : { text: FAKE_TEXT },
            ),
          );
        };
        if (opts.delayMs) setTimeout(send, opts.delayMs);
        else send();
      });
    }
    res.writeHead(404);
    res.end();
  });
  server.on("clientError", () => undefined); // 被打断时假服务可能写已销毁 socket，吞掉
  return {
    requests,
    listen: () =>
      new Promise<string>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
      }),
    close: () =>
      new Promise<void>((resolve) => {
        // 先给 undici 一个 tick 把响应体收尾、连接归还连接池，再断 keep-alive ——
        // 否则销毁 socket 会撞上还在收尾的 ReadableStream（unhandled rejection，实测踩过）
        setTimeout(() => {
          server.closeAllConnections(); // 断 keep-alive，否则要等 undici 保活超时（拖慢用例）
          server.close(() => resolve());
        }, 20);
      }),
  };
}

/** 从 multipart body 里抠一个普通字段的值（文本字段才适用；file 是二进制，走 body.includes） */
function fieldValue(body: Buffer, name: string): string | undefined {
  const re = new RegExp(`name="${name}"\\r\\n(?:[^\\r\\n]*\\r\\n)?\\r\\n([\\s\\S]*?)\\r\\n--`);
  return re.exec(body.toString("utf8"))?.[1];
}

const servers: Array<{ close: () => Promise<void> }> = [];
afterEach(() => Promise.all(servers.splice(0).map((s) => s.close())));

function asrWith(stored: VoiceConfigValues): OpenAiAsrEngine {
  return new OpenAiAsrEngine({ readStoredConfig: () => stored });
}
/** 从实例上取同一份只读引用（schema 不从引擎模块导出，不为测试改产品代码 —— 同 4.5） */
const ASR_SCHEMA = new OpenAiAsrEngine().configSchema;

describe("4.8 云端 ASR 引擎（openai-asr）", () => {
  // 1~4 元数据与形状
  it("1 元数据：id=openai-asr / kind=asr / locality=cloud / streaming=false", () => {
    const e = new OpenAiAsrEngine();
    expect(e.id).toBe("openai-asr");
    expect(e.kind).toBe("asr");
    expect(e.locality).toBe("cloud");
    expect(e.streaming).toBe(false);
  });

  it("2 configSchema：select 都有 options；required 恰好 [baseUrl, apiKey]", () => {
    for (const f of ASR_SCHEMA) {
      if (f.type === "select") expect(f.options?.length ?? 0).toBeGreaterThan(0);
    }
    expect(ASR_SCHEMA.filter((f) => f.required).map((f) => f.key)).toEqual(["baseUrl", "apiKey"]);
  });

  it("3 apiKey 字段是 password + secret", () => {
    const key = ASR_SCHEMA.find((f) => f.key === "apiKey");
    expect(key?.type).toBe("password");
    expect(key?.secret).toBe(true);
  });

  it("4 形状：有 transcribe、没有 synthesize", () => {
    const e = new OpenAiAsrEngine() as unknown as Record<string, unknown>;
    expect(typeof e.transcribe).toBe("function");
    expect(e.synthesize).toBeUndefined();
  });

  // 5~6 注册 + 降级链
  it("5 注册进真 VoiceRegistry 不抛；listByKind(asr) = [openai-asr]", () => {
    const r = new VoiceRegistry();
    expect(() => r.register(new OpenAiAsrEngine())).not.toThrow();
    expect(r.listByKind("asr").map((e) => e.id)).toEqual(["openai-asr"]);
  });

  it("6 降级链：假本地 ASR 在前、openai-asr 在后", () => {
    const fakeLocal: VoiceEngine = {
      id: "sherpa-onnx",
      name: "本地 sherpa-onnx",
      kind: "asr",
      locality: "local",
      streaming: false,
      configSchema: [],
      transcribe: () => Promise.resolve({ text: "", isFinal: true }),
    };
    const r = new VoiceRegistry();
    r.register(fakeLocal);
    r.register(new OpenAiAsrEngine());
    expect(r.resolveChain("asr")).toEqual(["sherpa-onnx", "openai-asr"]);
  });

  // 7~8 health()：只查配置，不发请求（D6）
  it("7 health()：没填 Key → unavailable 且 detail 含「API Key」，假服务 0 请求", async () => {
    const s = startFakeTranscribe();
    servers.push(s);
    const base = await s.listen();

    const h = await asrWith({ baseUrl: `${base}/v1` }).health();
    expect(h.availability).toBe("unavailable");
    expect(h.detail).toContain("API Key");
    expect(s.requests).toHaveLength(0);
  });

  it("8 health()：地址 + Key 齐 → ready，假服务 0 请求", async () => {
    const s = startFakeTranscribe();
    servers.push(s);
    const base = await s.listen();

    expect((await asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test" }).health()).availability).toBe("ready");
    expect(s.requests).toHaveLength(0);
  });

  // 9~12 请求形状
  it("9 请求 URL = /v1/audio/transcriptions；Authorization = Bearer sk-test", async () => {
    const s = startFakeTranscribe();
    servers.push(s);
    const base = await s.listen();
    await asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test" }).transcribe({
      audio: new Uint8Array(FAKE_WAV),
      format: "wav",
    });
    expect(s.requests[0].url).toBe("/v1/audio/transcriptions");
    expect(s.requests[0].auth).toBe("Bearer sk-test");
  });

  it("10 Content-Type 以 multipart/form-data; boundary= 开头（D4 的直接证据）", async () => {
    const s = startFakeTranscribe();
    servers.push(s);
    const base = await s.listen();
    await asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test" }).transcribe({
      audio: new Uint8Array(FAKE_WAV),
      format: "wav",
    });
    expect(s.requests[0].contentType?.startsWith("multipart/form-data; boundary=")).toBe(true);
  });

  it("11 multipart 里 filename=audio.wav，且字节原样进 body", async () => {
    const s = startFakeTranscribe();
    servers.push(s);
    const base = await s.listen();
    await asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test" }).transcribe({
      audio: new Uint8Array(FAKE_WAV),
      format: "wav",
    });
    const body = s.requests[0].body;
    expect(body.toString("utf8").includes('filename="audio.wav"')).toBe(true);
    expect(body.includes(FAKE_WAV)).toBe(true);
  });

  it("12 model 字段 = whisper-1", async () => {
    const s = startFakeTranscribe();
    servers.push(s);
    const base = await s.listen();
    await asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test" }).transcribe({
      audio: new Uint8Array(FAKE_WAV),
      format: "wav",
    });
    expect(fieldValue(s.requests[0].body, "model")).toBe("whisper-1");
  });

  // 13~15 language 三级优先（D8）
  it("13 cfg.language=zh → 请求里 language=zh", async () => {
    const s = startFakeTranscribe();
    servers.push(s);
    const base = await s.listen();
    await asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test", language: "zh" }).transcribe({
      audio: new Uint8Array(FAKE_WAV),
      format: "wav",
    });
    expect(fieldValue(s.requests[0].body, "language")).toBe("zh");
  });

  it("14 req.language=ja 覆盖 cfg.language=zh（D8 优先级）", async () => {
    const s = startFakeTranscribe();
    servers.push(s);
    const base = await s.listen();
    await asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test", language: "zh" }).transcribe({
      audio: new Uint8Array(FAKE_WAV),
      format: "wav",
      language: "ja",
    });
    expect(fieldValue(s.requests[0].body, "language")).toBe("ja");
  });

  it("15 两边都空 → 没有 language 字段（空串不许 append，D8 关键一条）", async () => {
    const s = startFakeTranscribe();
    servers.push(s);
    const base = await s.listen();
    await asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test" }).transcribe({
      audio: new Uint8Array(FAKE_WAV),
      format: "wav",
    });
    expect(fieldValue(s.requests[0].body, "language")).toBeUndefined();
  });

  // 16 prompt（D9）
  it("16 prompt 空 → 不发字段；非空 → 有且值正确", async () => {
    const s1 = startFakeTranscribe();
    servers.push(s1);
    const base1 = await s1.listen();
    await asrWith({ baseUrl: `${base1}/v1`, apiKey: "sk-test" }).transcribe({
      audio: new Uint8Array(FAKE_WAV),
      format: "wav",
    });
    expect(fieldValue(s1.requests[0].body, "prompt")).toBeUndefined();

    const s2 = startFakeTranscribe();
    servers.push(s2);
    const base2 = await s2.listen();
    await asrWith({ baseUrl: `${base2}/v1`, apiKey: "sk-test", prompt: "纳西妲" }).transcribe({
      audio: new Uint8Array(FAKE_WAV),
      format: "wav",
    });
    expect(fieldValue(s2.requests[0].body, "prompt")).toBe("纳西妲");
  });

  // 17~19 response_format 三分支（D7）
  it("17 默认 json → 返回 { text, isFinal:true }；请求里 response_format=json", async () => {
    const s = startFakeTranscribe();
    servers.push(s);
    const base = await s.listen();
    const out = await asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test" }).transcribe({
      audio: new Uint8Array(FAKE_WAV),
      format: "wav",
    });
    expect(out).toEqual({ text: FAKE_TEXT, isFinal: true });
    expect(fieldValue(s.requests[0].body, "response_format")).toBe("json");
  });

  it("18 responseFormat=text（假服务回纯文本）→ 文本来自纯文本 body", async () => {
    const s = startFakeTranscribe({ shape: "text" });
    servers.push(s);
    const base = await s.listen();
    const out = await asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test", responseFormat: "text" }).transcribe({
      audio: new Uint8Array(FAKE_WAV),
      format: "wav",
    });
    expect(out).toEqual({ text: FAKE_TEXT, isFinal: true });
    expect(fieldValue(s.requests[0].body, "response_format")).toBe("text");
  });

  it("19 responseFormat=verbose_json → 仍取 .text", async () => {
    const s = startFakeTranscribe({ shape: "verbose_json" });
    servers.push(s);
    const base = await s.listen();
    const out = await asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test", responseFormat: "verbose_json" }).transcribe({
      audio: new Uint8Array(FAKE_WAV),
      format: "wav",
    });
    expect(out).toEqual({ text: FAKE_TEXT, isFinal: true });
  });

  // 20~22 错误分支
  it("20 假服务回 not-json{ → VoiceError 含「JSON」", async () => {
    const s = startFakeTranscribe({ shape: "garbage" });
    servers.push(s);
    const base = await s.listen();
    await expect(
      asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test" }).transcribe({
        audio: new Uint8Array(FAKE_WAV),
        format: "wav",
      }),
    ).rejects.toThrow(/JSON/);
  });

  it("21 假服务回 {ok:true}（缺 text）→ VoiceError 含「text」", async () => {
    const s = startFakeTranscribe({ shape: "noText" });
    servers.push(s);
    const base = await s.listen();
    await expect(
      asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test" }).transcribe({
        audio: new Uint8Array(FAKE_WAV),
        format: "wav",
      }),
    ).rejects.toThrow(/text/);
  });

  it("22 非 2xx（500）→ VoiceError 含 500 与「OpenAI 兼容识别」（action 为空串的文案）", async () => {
    const s = startFakeTranscribe({ status: 500 });
    servers.push(s);
    const base = await s.listen();
    const engine = asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test" });
    await expect(
      engine.transcribe({ audio: new Uint8Array(FAKE_WAV), format: "wav" }),
    ).rejects.toThrow(/500/);
    await expect(
      engine.transcribe({ audio: new Uint8Array(FAKE_WAV), format: "wav" }),
    ).rejects.toThrow(/OpenAI 兼容识别/);
  });

  // 23~24 超时与打断（判序护栏）
  it("23 超时 → VoiceError 含「超时」", async () => {
    const s = startFakeTranscribe({ delayMs: 200 });
    servers.push(s);
    const base = await s.listen();
    // TranscribeRequest 契约没有 overrides 字段（4.3 冻结）——超时改走 stored 层，语义等价
    const engine = asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test", timeoutMs: 50 });
    await expect(
      engine.transcribe({ audio: new Uint8Array(FAKE_WAV), format: "wav" }),
    ).rejects.toThrow(/超时/);
  });

  it("24 signal 已 abort → 原样抛 AbortError（不是 VoiceError）", async () => {
    const s = startFakeTranscribe();
    servers.push(s);
    const base = await s.listen();
    const engine = asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test" });

    const ac = new AbortController();
    ac.abort(); // 先中止再调用（barge-in 场景）
    const err = await engine
      .transcribe({ audio: new Uint8Array(FAKE_WAV), format: "wav", signal: ac.signal })
      .catch((e: unknown) => e);

    expect(err).toBeDefined();
    expect((err as Error).name).toBe("AbortError");
    expect(err instanceof VoiceError).toBe(false);
  });

  // 25~26 守卫
  it("25 空音频 → { text:\"\", isFinal:true } 且假服务 0 请求", async () => {
    const s = startFakeTranscribe();
    servers.push(s);
    const base = await s.listen();
    const out = await asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test" }).transcribe({
      audio: new Uint8Array(0),
      format: "wav",
    });
    expect(out).toEqual({ text: "", isFinal: true });
    expect(s.requests).toHaveLength(0);
  });

  it("26 format=pcm → VoiceError 含「PCM」，且假服务 0 请求（D5）", async () => {
    const s = startFakeTranscribe();
    servers.push(s);
    const base = await s.listen();
    await expect(
      asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test" }).transcribe({
        audio: new Uint8Array([1, 2, 3, 4]),
        format: "pcm",
      }),
    ).rejects.toThrow(/PCM/);
    expect(s.requests).toHaveLength(0);
  });

  // 27 mp3
  it("27 format=mp3 → filename=audio.mp3，Content-Type 仍是 multipart", async () => {
    const s = startFakeTranscribe();
    servers.push(s);
    const base = await s.listen();
    await asrWith({ baseUrl: `${base}/v1`, apiKey: "sk-test" }).transcribe({
      audio: new Uint8Array(FAKE_WAV),
      format: "mp3",
    });
    expect(s.requests[0].body.toString("utf8").includes('filename="audio.mp3"')).toBe(true);
    expect(s.requests[0].contentType?.startsWith("multipart/form-data; boundary=")).toBe(true);
  });
});
