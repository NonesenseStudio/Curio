import type { Topic } from "./types";

export type FeedSource = {
  id: string;
  name: string;
  url: string;
  topic: Topic;
  kind: "publisher" | "youtube";
  bodyPolicy: "unknown" | "feed" | "web";
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

export const sources: FeedSource[] = [
  {
    id: "quanta",
    name: "Quanta Magazine",
    url: "https://www.quantamagazine.org/feed/",
    topic: "自然与科学",
    kind: "publisher",
    bodyPolicy: "unknown",
  },
  {
    id: "aeon",
    name: "Aeon",
    url: "https://aeon.co/feed.rss",
    topic: "心理学与哲学",
    kind: "publisher",
    bodyPolicy: "unknown",
  },
  {
    id: "our-world-in-data",
    name: "Our World in Data",
    url: "https://ourworldindata.org/atom.xml",
    topic: "商业与经济",
    kind: "publisher",
    bodyPolicy: "unknown",
  },
  {
    id: "smithsonian",
    name: "Smithsonian Magazine",
    url: "https://www.smithsonianmag.com/rss/latest_articles/",
    topic: "历史与文明",
    kind: "publisher",
    bodyPolicy: "unknown",
  },
  {
    id: "atlas-obscura",
    name: "Atlas Obscura",
    url: "https://www.atlasobscura.com/feeds/latest",
    topic: "旅行与地理",
    kind: "publisher",
    bodyPolicy: "unknown",
  },
  {
    id: "nowness",
    name: "NOWNESS",
    url: "https://www.nowness.com/rss",
    topic: "摄影与艺术",
    kind: "publisher",
    bodyPolicy: "unknown",
  },
  {
    id: "the-pudding",
    name: "The Pudding",
    url: "https://pudding.cool/feed.xml",
    topic: "社会观察与人文",
    kind: "publisher",
    bodyPolicy: "unknown",
  },
  {
    id: "nasa",
    name: "NASA",
    url: "https://www.nasa.gov/feed/",
    topic: "科技与未来",
    kind: "publisher",
    bodyPolicy: "unknown",
  },
  {
    id: "national-geographic",
    name: "National Geographic",
    url: "https://www.nationalgeographic.com/pages/topic/latest-stories",
    topic: "自然与科学",
    kind: "publisher",
    bodyPolicy: "unknown",
  },
  // Replace/add channel IDs with the channels you follow. These are public YouTube RSS endpoints.
  {
    id: "veritasium",
    name: "Veritasium",
    url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCHnyfMqiRRG1u-2MsTIPaHg",
    topic: "自然与科学",
    kind: "youtube",
    bodyPolicy: "unknown",
  },
  {
    id: "kurzgesagt",
    name: "Kurzgesagt",
    url: "https://www.youtube.com/feeds/videos.xml?channel_id=UCsXVk37bltHxD1rDPwtNM8Q",
    topic: "科技与未来",
    kind: "youtube",
    bodyPolicy: "unknown",
  },
];
