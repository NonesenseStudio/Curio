export type Topic =
  | "科技与未来"
  | "历史与文明"
  | "摄影与艺术"
  | "心理学与哲学"
  | "商业与经济"
  | "旅行与地理"
  | "自然与科学"
  | "冷知识与奇闻"
  | "电影与音乐"
  | "美食与生活方式"
  | "社会观察与人文";

export type ArticleKind = "article" | "video" | "interactive" | "unknown";
export type ArticleStatus =
  | "unseen"
  | "processing"
  | "readable"
  | "summary"
  | "restricted"
  | "failed"
  | "video"
  | "interactive"
  | "unsupported";
export type ContentCompleteness =
  "unknown" | "complete" | "partial" | "summary";

export type FeedItem = {
  id: string;
  sourceId: string;
  legacyIds?: string[];
  title: string;
  link: string;
  description: string;
  contentSnippet?: string;
  pubDate?: string;
  creator?: string;
  source: string;
  topic: Topic;
  image?: string;
  imageAlt?: string;
  imageCredit?: string;
  contentType: ArticleKind;
  contentStatus: ArticleStatus;
  contentCompleteness: ContentCompleteness;
};

export type ArticleRecord = {
  item: FeedItem;
  bodyCandidate?: string;
  candidateStoredAt?: string;
  bodyHtml?: string;
  bodyFetchedAt?: string;
  bodyVersion?: string;
  processingMode?: "feed" | "readability" | "adapter";
};

export type LegacyNoteFields = {
  insight?: string;
  connection?: string;
};

export type LegacyReviewData = {
  dueAt?: string;
  interval?: number;
  reviewedAt?: string;
};

export type KnowledgeNote = {
  id: string;
  legacyId?: string;
  title?: string;
  body?: string;
  excerpt?: string;
  sourceUrl?: string;
  articleId?: string;
  topic?: Topic;
  createdAt: string;
  updatedAt?: string;
  legacyFields?: LegacyNoteFields;
  legacyReview?: LegacyReviewData;
};

export type SavedItem = FeedItem & {
  savedAt: string;
};

export type ReadingPosition = {
  articleId: string;
  anchor: string;
  offset: number;
  contentVersion: string;
  updatedAt: string;
};
