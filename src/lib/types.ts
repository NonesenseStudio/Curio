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
/**
 * How the server stores feed-fetch results. "unknown" means no write has been
 * attempted yet (so failures cannot be claimed); only "unavailable" allows the
 * UI to say the server could not persist records.
 */
export type ArchiveAvailability = "unknown" | "available" | "unavailable";

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
  /** Declared width from the source feed markup, when the source states one. */
  imageWidth?: number;
  /**
   * "declared" = source stated width >= 600 (safe for a large lead visual),
   * "medium" = declared width >= 300, "unknown" = no usable size information.
   * Unknown-size images must not be stretched into the main visual slot.
   */
  imageQuality?: "declared" | "medium" | "unknown";
  contentType: ArticleKind;
  contentStatus: ArticleStatus;
  contentCompleteness: ContentCompleteness;
};

export type ArticleRecord = {
  item: FeedItem;
  /** Last successful feed fetch that included this article. */
  feedFetchedAt?: string;
  bodyCandidate?: string;
  candidateStoredAt?: string;
  /** True when the stored candidate was cut at the persistence size limit. */
  candidateTruncated?: boolean;
  candidateError?: "too_large" | "storage_limit";
  /** Digest of the newest feed candidate, retained after candidate expiry. */
  candidateDigest?: string;
  bodyHtml?: string;
  bodyFetchedAt?: string;
  /** SANITIZE_VERSION plus a digest of the stored body; output is gated on it. */
  bodyVersion?: string;
  bodyCompleteness?: ContentCompleteness;
  /** Where the stored body came from: feed payload or registered web page. */
  bodySource?: "feed" | "web";
  /** Private digest of the source value used to prepare this body. */
  bodySourceDigest?: string;
  bodyError?: string;
  bodyAttempts?: number;
  bodyNextAttemptAt?: string;
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
  /**
   * Sanitized-body block fingerprint (the data-qf attribute), optionally
   * followed by the previous block's fingerprint after a ":" — used when the
   * target paragraph no longer exists in a newer content version.
   */
  anchor: string;
  /** Per-mille (0–1000) progress inside the anchored block. */
  offset: number;
  /** Body version the position was taken against (pipeline bodyVersion). */
  contentVersion: string;
  updatedAt: string;
};
