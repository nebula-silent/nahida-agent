// 8.7.19：RSS 阅读器（工具箱 · 自研工具）共享类型
// 订阅列表由主进程持久化到 userData/rss-subscriptions.json；抓取用已装的 rss-parser（自带 HTTP 请求）。
export interface RssFeed {
  id: string;
  url: string;
  title: string;
}

export interface RssItem {
  title: string;
  link: string;
  /** ISO 时间串（feed 给什么就透传什么，渲染层再格式化） */
  pubDate: string;
  /** 来源 feed 标题，便于列表混排时区分 */
  sourceTitle: string;
  /** 摘要（正文截断，无正文则为空串） */
  summary: string;
}

export interface RssAddResult {
  ok: boolean;
  feeds: RssFeed[];
  /** !ok 时的人话原因（URL 非法 / 抓不到 / 已存在） */
  error?: string;
}

export interface RssFeedResult {
  ok: boolean;
  items: RssItem[];
  error?: string;
}