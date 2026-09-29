// 8.12.1②：net-tools 纯函数单测 —— SSRF 防护 / HTML 提取 / Bing 解析 / 错误话术。
// net-tools 不 import electron（同 fs-tools 范式），vitest 直测；联网正路径不进单测（真机 verify 覆盖）。
import { describe, it, expect } from "vitest";
import { fetchUrlTool, htmlToText, isPublicHttpUrl, parseBingResults } from "../src/main/tools/net-tools";

describe("net-tools isPublicHttpUrl（SSRF 防护）", () => {
  it("公网 http/https 放行", () => {
    expect(isPublicHttpUrl("https://example.com/page?a=1")).toBe("https://example.com/page?a=1");
    expect(isPublicHttpUrl("http://example.com")).toBe("http://example.com");
    expect(isPublicHttpUrl("http://172.32.0.1/")).toBe("http://172.32.0.1/"); // 172 段出私网区间的边界
  });

  it("非 http(s) scheme / 脏输入拒绝", () => {
    expect(isPublicHttpUrl("ftp://example.com")).toBeNull();
    expect(isPublicHttpUrl("file:///C:/Windows")).toBeNull();
    expect(isPublicHttpUrl("不是网址")).toBeNull();
    expect(isPublicHttpUrl("")).toBeNull();
    expect(isPublicHttpUrl(null)).toBeNull();
    expect(isPublicHttpUrl(42)).toBeNull();
  });

  it("本机 / 私网 / 链路本地 / IPv6 内网拒绝", () => {
    expect(isPublicHttpUrl("http://localhost:3000/")).toBeNull();
    expect(isPublicHttpUrl("http://foo.localhost/")).toBeNull();
    expect(isPublicHttpUrl("http://box.local/")).toBeNull();
    expect(isPublicHttpUrl("http://127.0.0.1:9/x")).toBeNull();
    expect(isPublicHttpUrl("http://10.1.2.3/")).toBeNull();
    expect(isPublicHttpUrl("http://192.168.1.1/")).toBeNull();
    expect(isPublicHttpUrl("http://172.16.0.1/")).toBeNull();
    expect(isPublicHttpUrl("http://172.31.255.255/")).toBeNull();
    expect(isPublicHttpUrl("http://169.254.169.254/latest")).toBeNull(); // 云元数据端点
    expect(isPublicHttpUrl("http://0.0.0.0/")).toBeNull();
    expect(isPublicHttpUrl("http://[::1]/")).toBeNull();
    expect(isPublicHttpUrl("http://[fc00::1]/")).toBeNull();
    expect(isPublicHttpUrl("http://[fe80::1]/")).toBeNull();
  });
});

describe("net-tools htmlToText", () => {
  it("剥脚本样式标签、块级换行、解码实体、压空白", () => {
    const html = `<!doctype html><html><head><style>.a{color:red}</style><script>var x=1;</script></head>
      <body><!-- 注释 --><h1>标题一</h1><p>第一段 &amp; 符号 &lt;转义&gt;</p>
      <div>第二段<br>续行&nbsp;合并  空格</div><script>bad("never")</script></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("标题一");
    expect(text).toContain("第一段 & 符号 <转义>");
    expect(text).toContain("第二段\n续行 合并 空格");
    expect(text).not.toContain("color:red");
    expect(text).not.toContain("never");
    expect(text).not.toMatch(/<\/?(p|div|h1|body|html|br|script|style)[\s>]/i); // 不残留标签（&lt; 解码成字面 < 是预期行为）
  });
});

describe("net-tools parseBingResults", () => {
  const fixture = `<ol id="b_results"><li class="b_algo"><h2><a href="https://a.example/one&amp;x=1">结果 <em>一</em></a></h2>
    <p>摘要&nbsp;甲</p></li><li class="b_algo"><h2><a href="https://a.example/one&amp;x=1">重复链接</a></h2><p>重复</p></li>
    <li class="b_algo"><h2><a href="javascript:void(0)">坏链接</a></h2><p>不该出现</p></li>
    <li class="b_algo"><h2><a href="https://b.example/two">结果二</a></h2><p>摘要乙</p></li></ol>`;

  it("提标题 / 链接 / 摘要，去重并丢弃非 http 链接", () => {
    const hits = parseBingResults(fixture);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ title: "结果 一", url: "https://a.example/one&x=1", snippet: "摘要 甲" });
    expect(hits[1].url).toBe("https://b.example/two");
  });

  it("空页 / 结构变化 → 空数组（上层给可读提示，不崩）", () => {
    expect(parseBingResults("<html><body>验证页</body></html>")).toEqual([]);
  });
});

describe("net-tools fetchUrlTool 错误话术（不 throw）", () => {
  it("私网 / 本机 → 拒绝话术", async () => {
    const out = await fetchUrlTool("http://127.0.0.1:9/x");
    expect(out.startsWith("[错误] 拒绝访问")).toBe(true);
  });

  it("坏网址 → 拒绝话术", async () => {
    const out = await fetchUrlTool("notaurl");
    expect(out.startsWith("[错误] 拒绝访问")).toBe(true);
  });

  it("不可达公网地址 → 抓取失败话术（不 throw）", async () => {
    const out = await fetchUrlTool("https://no-such-host-8121.example.invalid/");
    expect(out.startsWith("[错误] 抓取失败")).toBe(true);
  });
});
