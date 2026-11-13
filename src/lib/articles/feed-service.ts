import { createHash } from "node:crypto";
import Parser from "rss-parser";
import type { FeedItem } from "@/lib/types";
import { sources } from "@/lib/sources";
import { isSafeHttpsImage } from "@/lib/safe-url";
import { fetchRegisteredFeed } from "./safe-fetch";
import { isArticleArchiveAvailable, saveArticleRecords } from "./store";

const parser = new Parser({
  customFields: {
    item: [
      ["content:encoded", "contentEncoded"],
      ["content", "contentField"],
      ["media:content", "mediaContent", { keepArray: false }],
      ["media:thumbnail", "mediaThumbnail", { keepArray: false }],
      ["media:title", "mediaTitle"],
      ["media:credit", "mediaCredit"],
    ],
  },
});

type FeedResult = {
  items: FeedItem[];
  updatedAt: string;
  failedSourceCount: number;
  failedSourceIds: string[];
  sourceCount: number;
  allSourcesFailed: boolean;
  cached: boolean;
  archiveAvailable: boolean;
};

let cache: (FeedResult & { at: number }) | null = null;

function stripHtml(value = "") {
  const text = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : " ";
    })
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 420 ? `${text.slice(0, 419).trimEnd()}…` : text;
}

function legacyId(sourceName: string, item: any, index: number) {
  return `${sourceName}:${item.guid || item.link || item.title || `item-${index}`}`;
}

function articleId(sourceId: string, item: any, index: number) {
  const identity = String(
    item.guid || item.link || `${item.title || "item"}-${index}`,
  );
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 24);
  return `${sourceId}-${digest}`;
}

function imageDetails(item: any) {
  const enclosure = item.enclosure?.url;
  const media = item.mediaContent?.$?.url || item.mediaThumbnail?.$?.url;
  const html =
    item.contentEncoded ||
    item.content ||
    item.contentField ||
    item.description ||
    "";
  const match = String(html).match(/<img\b([^>]*?)>/i);
  const source = match?.[1].match(/\bsrc=["']([^"']+)["']/i)?.[1];
  const candidate = enclosure || media || source;
  let image: string | undefined;
  try {
    const url = new URL(String(candidate || ""), item.link);
    const width = Number(match?.[1].match(/\bwidth=["']?(\d+)/i)?.[1] || 0);
    const height = Number(match?.[1].match(/\bheight=["']?(\d+)/i)?.[1] || 0);
    if (
      isSafeHttpsImage(url.href) &&
      !(width > 0 && width <= 24) &&
      !(height > 0 && height <= 24)
    )
      image = url.href;
  } catch {
    /* Ignore missing or malformed image URLs. */
  }
  const alt = match?.[1].match(/\balt=["']([^"']*)["']/i)?.[1];
  const imageAlt = alt
    ? stripHtml(alt).slice(0, 240)
    : typeof item.mediaTitle === "string"
      ? stripHtml(item.mediaTitle).slice(0, 240)
      : undefined;
  const imageCredit =
    typeof item.mediaCredit === "string"
      ? stripHtml(item.mediaCredit).slice(0, 160)
      : undefined;
  return { image, imageAlt, imageCredit };
}

function publishedAt(value?: string) {
  const timestamp = new Date(value || "").getTime();
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

async function mapConcurrent<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await mapper(values[index]);
      }
    }),
  );
  return results;
}

export async function getAggregatedFeed(force = false): Promise<FeedResult> {
  if (!force && cache && Date.now() - cache.at < 10 * 60 * 1000) {
    return {
      ...cache,
      cached: true,
      archiveAvailable: isArticleArchiveAvailable(),
    };
  }

  const results = await mapConcurrent(sources, 4, async (source) => {
    try {
      const host = new URL(source.url).hostname;
      const xml = await fetchRegisteredFeed(source.url, [host]);
      const feed = await parser.parseString(xml);
      const records = (feed.items || [])
        .slice(0, 18)
        .map((entry: any, index) => {
          const candidate = String(
            entry.contentEncoded ||
              entry.content ||
              entry.contentField ||
              entry.description ||
              "",
          );
          const text =
            entry.contentSnippet || entry.summary || entry.description || "";
          const id = articleId(source.id, entry, index);
          const legacy = legacyId(source.name, entry, index);
          const isVideo = source.kind === "youtube";
          const image = imageDetails(entry);
          return {
            item: {
              id,
              sourceId: source.id,
              legacyIds: [legacy],
              title: entry.title?.trim() || "未提供标题",
              link:
                typeof entry.link === "string" &&
                /^https:\/\//i.test(entry.link)
                  ? entry.link
                  : "",
              description: stripHtml(String(text || "")),
              contentSnippet: stripHtml(String(entry.contentSnippet || "")),
              pubDate: entry.isoDate || entry.pubDate,
              creator: entry.creator || entry.author || "",
              source: source.name,
              topic: source.topic,
              ...image,
              contentType: isVideo ? ("video" as const) : ("unknown" as const),
              contentStatus: isVideo
                ? ("video" as const)
                : ("summary" as const),
              contentCompleteness: "summary" as const,
            } satisfies FeedItem,
            bodyCandidate: candidate.slice(0, 3 * 1024 * 1024),
          };
        });
      return { status: "fulfilled" as const, value: records };
    } catch (reason) {
      return { status: "rejected" as const, reason };
    }
  });

  const successful = results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
  const records = successful.flat();
  const items = records.map((record) => record.item);
  items.sort((a, b) => publishedAt(b.pubDate) - publishedAt(a.pubDate));
  const failedSourceCount = results.filter(
    (result) => result.status === "rejected",
  ).length;
  const failedSourceIds = results.flatMap((result, index) =>
    result.status === "rejected" ? [sources[index].id] : [],
  );
  const sourceCount = sources.length;
  const allSourcesFailed = sourceCount > 0 && failedSourceCount === sourceCount;

  if (!allSourcesFailed) {
    const candidates = new Map(
      records.map((record) => [record.item.id, record.bodyCandidate]),
    );
    const archiveAvailable = await saveArticleRecords(items, candidates);
    cache = {
      at: Date.now(),
      items,
      updatedAt: new Date().toISOString(),
      failedSourceCount,
      failedSourceIds,
      sourceCount,
      allSourcesFailed: false,
      cached: false,
      archiveAvailable,
    };
  }

  if (allSourcesFailed && cache) {
    return {
      ...cache,
      cached: true,
      failedSourceCount,
      failedSourceIds,
      allSourcesFailed: true,
      archiveAvailable: isArticleArchiveAvailable(),
    };
  }

  return cache
    ? {
        ...cache,
        failedSourceCount,
        failedSourceIds,
        allSourcesFailed,
        cached: false,
        archiveAvailable: isArticleArchiveAvailable(),
      }
    : {
        items: [],
        updatedAt: "",
        failedSourceCount,
        failedSourceIds,
        sourceCount,
        allSourcesFailed,
        cached: false,
        archiveAvailable: false,
      };
}

export function filterFeedItems(
  items: FeedItem[],
  topic: string | null,
  query: string,
) {
  const normalized = query.trim().toLocaleLowerCase();
  return items.filter(
    (item) =>
      (!topic || item.topic === topic) &&
      (!normalized ||
        `${item.title} ${item.description} ${item.source}`
          .toLocaleLowerCase()
          .includes(normalized)),
  );
}
