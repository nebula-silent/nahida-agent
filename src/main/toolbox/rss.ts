// 8.7.19：RSS 阅读器（工具箱 · 自研工具）—— 主进程侧
// 订阅列表真相持久化到 userData/rss-subscriptions.json；抓取用已装 rss-parser（自带 HTTP 请求）。
import * as fs from "fs";
import * as path from "path";
import { app, ipcMain } from "electron";
import Parser from "rss-parser";
import { IPC } from "../../shared/ipc-channels";
import type { RssAddResult, RssFeed, RssFeedResult, RssItem } from "../../shared/rss";

const parser = new Parser();
function storePath(): string { return path.join(app.getPath("userData"), "rss-subscriptions.json"); }
function newId(): string { return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }

function readFeeds(): RssFeed[] {
  try {
    const raw = fs.readFileSync(storePath(), "utf-8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.map((f) => ({ id: String(f?.id ?? ""), url: String(f?.url ?? ""), title: String(f?.title ?? "") })).filter((f) => f.url)
      : [];
  } catch { return []; }
}
function writeFeeds(list: RssFeed[]): void {
  try { fs.writeFileSync(storePath(), JSON.stringify(list, null, 2)); } catch { /* 落盘失败不崩，下次再写 */ }
}

function doList(): RssFeed[] { return readFeeds(); }

async function doAdd(urlRaw: string): Promise<RssAddResult> {
  const url = String(urlRaw ?? "").trim();
  if (!/^https?:\/\/.+/i.test(url)) return { ok: false, feeds: doList(), error: "链接必须以 http(s):// 开头" };
  const feeds = readFeeds();
  if (feeds.some((f) => f.url === url)) return { ok: true, feeds }; // 已订阅，幂等
  try {
    const fd = await parser.parseURL(url);
    const feed: RssFeed = { id: newId(), url, title: fd.title || url };
    feeds.push(feed);
    writeFeeds(feeds);
    return { ok: true, feeds };
  } catch (e) { return { ok: false, feeds, error: e instanceof Error ? e.message : "抓取该订阅源失败" }; }
}

function doRemove(id: string): RssFeed[] {
  const feeds = readFeeds().filter((f) => f.id !== id);
  writeFeeds(feeds);
  return feeds;
}

async function doFetch(id: string): Promise<RssFeedResult> {
  const feed = readFeeds().find((f) => f.id === id);
  if (!feed) return { ok: false, items: [], error: "找不到该订阅（可能已被删除）" };
  try {
    const fd = await parser.parseURL(feed.url);
    const items: RssItem[] = (fd.items ?? []).map((it) => ({
      title: String(it.title ?? "无标题"),
      link: String(it.link ?? ""),
      pubDate: String(it.pubDate ?? it.isoDate ?? ""),
      sourceTitle: feed.title,
      summary: String(it.contentSnippet ?? it.content?.slice(0, 150) ?? ""),
    }));
    return { ok: true, items };
  } catch (e) { return { ok: false, items: [], error: e instanceof Error ? e.message : "抓取失败" }; }
}

export function registerRssHandlers(): void {
  ipcMain.handle(IPC.RSS_LIST, () => doList());
  ipcMain.handle(IPC.RSS_ADD, (_e, url: string) => doAdd(url));
  ipcMain.handle(IPC.RSS_REMOVE, (_e, id: string) => doRemove(id));
  ipcMain.handle(IPC.RSS_FETCH, (_e, id: string) => doFetch(id));
}
