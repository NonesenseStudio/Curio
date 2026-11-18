import type { Topic } from "./types";

export type FeedSource = {
  id: string;
  name: string;
  homeUrl: string;
  topic: Topic;
  kind: "publisher" | "youtube";
  /** Exact publisher hosts allowed for links returned by this source. */
  articleHosts: string[];
  /**
   * Verified body-handling rule for this source. RSSHub availability does not
   * change this policy; a real article sample and source rules are still
   * required before Curio displays a prepared body.
   */
  bodyPolicy: "unknown" | "feed" | "web" | "feed-web";
  bodyVerifiedAt?: string;
  bodyHosts?: string[];
  bodyFeedPathPrefixes?: string[];
  bodyWebPathPrefixes?: string[];
  bodyMediaSelector?: string;
  bodyEndHeadingPatterns?: string[];
  bodyPolicyNote?: string;
  bodyPolicyEvidenceUrl?: string;
  bodyPolicyReviewedAt?: string;
  itemKind?: "article" | "video" | "interactive";
};

export type FeedRoute = {
  id: string;
  sourceId: string;
  /** Path on the configured private RSSHub instance. */
  path: string;
  topic: Topic;
  /** A route-specific topic wins when one article appears on multiple routes. */
  priority?: number;
  /** Keep mixed feeds such as National Geographic travel scoped to confirmed paths. */
  articlePathPrefixes?: string[];
  itemKind?: "article" | "video" | "interactive";
  limit?: number;
};

export const topics: {
  name: Topic;
  description: string;
  icon: string;
}[] = [
  {
    name: "科技与未来",
    description: "人工智能、工程、太空与未来趋势",
    icon: "✳",
  },
  {
    name: "历史与文明",
    description: "考古、文明史与人类故事",
    icon: "⌂",
  },
  {
    name: "摄影与艺术",
    description: "视觉文化、设计、建筑与创作",
    icon: "◉",
  },
  {
    name: "心理学与哲学",
    description: "认知、行为、思想与生活",
    icon: "◌",
  },
  {
    name: "商业与经济",
    description: "商业模式、经济机制与数据",
    icon: "↗",
  },
  {
    name: "旅行与地理",
    description: "地理、城市、地方文化与探索",
    icon: "⌖",
  },
  {
    name: "自然与科学",
    description: "生命、地球、物理与科学发现",
    icon: "❋",
  },
  {
    name: "冷知识与奇闻",
    description: "奇妙地点、冷门知识与意外发现",
    icon: "✧",
  },
  {
    name: "电影与音乐",
    description: "电影语言、音乐文化与作品",
    icon: "♫",
  },
  {
    name: "美食与生活方式",
    description: "饮食、日常、设计与生活灵感",
    icon: "◒",
  },
  {
    name: "社会观察与人文",
    description: "社会研究、文化与人类经验",
    icon: "◎",
  },
];

/** Retired publishers stay registered so existing articles and body rules work. */
export const sources: FeedSource[] = [
  {
    id: "quanta",
    name: "Quanta Magazine",
    homeUrl: "https://www.quantamagazine.org/",
    articleHosts: ["www.quantamagazine.org", "quantamagazine.org"],
    topic: "自然与科学",
    kind: "publisher",
    bodyPolicy: "unknown",
    bodyPolicyNote: "路由响应不等于正文已验收；需逐篇核对原文与使用规则。",
    itemKind: "article",
  },
  {
    id: "aeon",
    name: "Aeon",
    homeUrl: "https://aeon.co/",
    articleHosts: ["aeon.co", "www.aeon.co"],
    topic: "心理学与哲学",
    kind: "publisher",
    bodyPolicy: "unknown",
    bodyPolicyNote: "使用条款限制抓取和复制；本次 RSSHub 接入不放开正文展示。",
    bodyPolicyEvidenceUrl: "https://aeon.co/terms-of-use",
    bodyPolicyReviewedAt: "2026-11-17",
    itemKind: "article",
  },
  {
    id: "our-world-in-data",
    name: "Our World in Data",
    homeUrl: "https://ourworldindata.org/",
    articleHosts: ["ourworldindata.org", "www.ourworldindata.org"],
    topic: "商业与经济",
    kind: "publisher",
    bodyPolicy: "unknown",
    bodyPolicyNote: "FAQ 允许按署名和链接条件转载；样本与呈现要求尚未核验。",
    bodyPolicyEvidenceUrl: "https://ourworldindata.org/faqs",
    bodyPolicyReviewedAt: "2026-11-17",
    itemKind: "article",
  },
  {
    id: "smithsonian",
    name: "Smithsonian Magazine",
    homeUrl: "https://www.smithsonianmag.com/",
    articleHosts: ["www.smithsonianmag.com", "smithsonianmag.com"],
    topic: "历史与文明",
    kind: "publisher",
    bodyPolicy: "unknown",
    bodyPolicyNote: "仅保留历史条目；正文抓取与再展示规则尚未核验。",
  },
  {
    id: "atlas-obscura",
    name: "Atlas Obscura",
    homeUrl: "https://www.atlasobscura.com/",
    articleHosts: ["www.atlasobscura.com", "atlasobscura.com"],
    topic: "旅行与地理",
    kind: "publisher",
    bodyPolicy: "unknown",
    bodyPolicyNote: "仅保留历史条目；正文抓取与再展示规则尚未核验。",
  },
  {
    id: "nowness",
    name: "NOWNESS",
    homeUrl: "https://www.nowness.com/",
    articleHosts: ["www.nowness.com", "nowness.com"],
    topic: "摄影与艺术",
    kind: "publisher",
    bodyPolicy: "unknown",
    bodyPolicyNote: "仅保留历史条目；正文抓取与再展示规则尚未核验。",
  },
  {
    id: "the-pudding",
    name: "The Pudding",
    homeUrl: "https://pudding.cool/",
    articleHosts: ["pudding.cool", "www.pudding.cool"],
    topic: "社会观察与人文",
    kind: "publisher",
    bodyPolicy: "unknown",
    bodyPolicyNote: "交互作品保留历史简介和原文入口，不复制站内交互体验。",
    itemKind: "interactive",
  },
  {
    id: "nasa",
    name: "NASA",
    homeUrl: "https://science.nasa.gov/",
    articleHosts: ["science.nasa.gov", "www.nasa.gov", "nasa.gov"],
    topic: "科技与未来",
    kind: "publisher",
    bodyPolicy: "feed-web",
    bodyVerifiedAt: "2026-11-17",
    bodyHosts: ["science.nasa.gov"],
    bodyFeedPathPrefixes: ["/earth/earth-observatory/"],
    bodyWebPathPrefixes: ["/earth/earth-observatory/"],
    bodyMediaSelector:
      ".wp-block-nasa-blocks-image-before-after, .hds-media.wp-block-image",
    bodyEndHeadingPatterns: [
      "you may also be interested in",
      "discover more from nasa",
    ],
    bodyPolicyNote:
      "仅验证 Earth Observatory 路径；须保留 NASA 署名并避开标注版权的素材。",
    bodyPolicyEvidenceUrl: "https://science.nasa.gov/earth/faq/",
    bodyPolicyReviewedAt: "2026-11-17",
    itemKind: "article",
  },
  {
    id: "national-geographic",
    name: "National Geographic",
    homeUrl: "https://www.nationalgeographic.com/",
    articleHosts: ["www.nationalgeographic.com", "nationalgeographic.com"],
    topic: "自然与科学",
    kind: "publisher",
    bodyPolicy: "unknown",
    bodyPolicyNote: "混合路由只接收旅行路径；其余内容不进入该主题。",
  },
  {
    id: "veritasium",
    name: "Veritasium",
    homeUrl: "https://www.youtube.com/@veritasium",
    articleHosts: ["www.youtube.com", "youtube.com", "youtu.be"],
    topic: "自然与科学",
    kind: "youtube",
    bodyPolicy: "unknown",
    bodyPolicyNote: "视频保留标题、封面和 YouTube 观看入口。",
    itemKind: "video",
  },
  {
    id: "kurzgesagt",
    name: "Kurzgesagt",
    homeUrl: "https://www.youtube.com/@kurzgesagt",
    articleHosts: ["www.youtube.com", "youtube.com", "youtu.be"],
    topic: "科技与未来",
    kind: "youtube",
    bodyPolicy: "unknown",
    bodyPolicyNote: "视频保留标题、封面和 YouTube 观看入口。",
    itemKind: "video",
  },
  {
    id: "nautilus",
    name: "Nautilus",
    homeUrl: "https://nautil.us/",
    articleHosts: ["nautil.us", "www.nautil.us"],
    topic: "商业与经济",
    kind: "publisher",
    bodyPolicy: "unknown",
    bodyPolicyNote: "RSSHub 栏目已登记；正文展示待原文样本与使用规则核验。",
    itemKind: "article",
  },
  {
    id: "rare-historical-photos",
    name: "Rare Historical Photos",
    homeUrl: "https://rarehistoricalphotos.com/",
    articleHosts: ["rarehistoricalphotos.com", "www.rarehistoricalphotos.com"],
    topic: "历史与文明",
    kind: "publisher",
    bodyPolicy: "unknown",
    bodyPolicyNote: "RSSHub 栏目已登记；正文展示待原文样本与使用规则核验。",
    itemKind: "article",
  },
  {
    id: "archdaily",
    name: "ArchDaily",
    homeUrl: "https://www.archdaily.com/",
    articleHosts: ["www.archdaily.com", "archdaily.com"],
    topic: "摄影与艺术",
    kind: "publisher",
    bodyPolicy: "unknown",
    bodyPolicyNote: "RSSHub 栏目已登记；正文展示待原文样本与使用规则核验。",
    itemKind: "article",
  },
  {
    id: "guokr",
    name: "果壳",
    homeUrl: "https://www.guokr.com/",
    articleHosts: ["www.guokr.com", "guokr.com"],
    topic: "自然与科学",
    kind: "publisher",
    bodyPolicy: "unknown",
    bodyPolicyNote: "RSSHub 栏目已登记；正文展示待原文样本与使用规则核验。",
    itemKind: "article",
  },
];

/** Only routes in this list are fetched. Each request uses RSSHUB_BASE_URL. */
export const feedRoutes: FeedRoute[] = [
  {
    id: "quanta-archive",
    sourceId: "quanta",
    path: "/quantamagazine/archive",
    topic: "自然与科学",
  },
  {
    id: "aeon-essays",
    sourceId: "aeon",
    path: "/aeon/essays",
    topic: "心理学与哲学",
    priority: 1,
  },
  {
    id: "aeon-society",
    sourceId: "aeon",
    path: "/aeon/category/society",
    topic: "社会观察与人文",
    priority: 2,
  },
  {
    id: "nautilus-economics",
    sourceId: "nautilus",
    path: "/nautil/topic/economics",
    topic: "商业与经济",
  },
  {
    id: "nautilus-technology",
    sourceId: "nautilus",
    path: "/nautil/topic/technology",
    topic: "科技与未来",
  },
  {
    id: "rare-historical-photos",
    sourceId: "rare-historical-photos",
    path: "/rarehistoricalphotos",
    topic: "历史与文明",
  },
  {
    id: "national-geographic-travel",
    sourceId: "national-geographic",
    path: "/nationalgeographic/latest-stories",
    topic: "旅行与地理",
    articlePathPrefixes: ["/travel/"],
  },
  {
    id: "archdaily",
    sourceId: "archdaily",
    path: "/archdaily",
    topic: "摄影与艺术",
  },
  {
    id: "guokr-scientific",
    sourceId: "guokr",
    path: "/guokr/scientific",
    topic: "自然与科学",
  },
  {
    id: "veritasium-youtube",
    sourceId: "veritasium",
    path: "/youtube/channel/UCHnyfMqiRRG1u-2MsSQLbXA/embed=0&filterShorts=false",
    topic: "自然与科学",
    itemKind: "video",
  },
  {
    id: "kurzgesagt-youtube",
    sourceId: "kurzgesagt",
    path: "/youtube/channel/UCsXVk37bltHxD1rDPwtNM8Q/embed=0&filterShorts=false",
    topic: "科技与未来",
    itemKind: "video",
  },
];
