import Parser from "rss-parser";
import { JSDOM } from "jsdom";
import type { ArchiveAvailability, FeedItem } from "@/lib/types";
import {
  feedRoutes,
  sources,
  type FeedRoute,
  type FeedSource,
} from "@/lib/sources";
import { isSafeHttpsImage } from "@/lib/safe-url";
import {
  getRSSHubBaseUrl,
  RSSHubConfigurationError,
  rssHubRouteUrl,
} from "@/lib/rsshub";
import {
  fetchRegisteredFeed,
  fetchFailureCategory,
  type FetchFailure,
  type FetchFailureCategory,
} from "./safe-fetch";
import {
  getFeedRouteItems,
  getFeedRouteStates,
  isArticleArchiveAvailable,
  isRouteCacheAvailable,
  saveArticleRecords,
  saveFeedRouteStates,
  type FeedRouteState,
} from "./store";
import { articleIdentity, stableArticleId } from "./identity";

const MAX_ITEMS_PER_ROUTE = 10;
const ROUTE_REFRESH_MS = 10 * 60 * 1000;
const ROUTE_TIMEOUT_MS = 20_000;
const AGGREGATE_BUDGET_MS = 30_000;
const MANUAL_RETRY_COOLDOWN_MS = 60_000;
const FAILURE_BACKOFF_MINUTES = [1, 5, 15, 30];

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

type RouteFailureCategory = FetchFailureCategory | "parse" | "configuration";
type RouteStatus =
  "ok" | "empty" | "filtered_empty" | "failed" | "configuration";
type RouteStatusPayload = {
  routeId: string;
  sourceId: string;
  status: RouteStatus | "idle";
  itemCount: number;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  failureCategory?: string;
};

export type FeedResult = {
  items: FeedItem[];
  updatedAt: string;
  failedSourceCount: number;
  failedSourceIds: string[];
  partialSourceIds: string[];
  failedRouteCount: number;
  failedRouteIds: string[];
  failedRoutesWithCachedItems: number;
  failedRouteCategories: Record<string, RouteFailureCategory>;
  routeStatuses: RouteStatusPayload[];
  sourceCount: number;
  routeCount: number;
  allSourcesFailed: boolean;
  cached: boolean;
  /** Tri-state: "unknown" before any archive write has been attempted. */
  archiveAvailable: ArchiveAvailability;
  routeCacheAvailable: ArchiveAvailability;
  candidateCapacityDrops: number;
  candidateTooLargeCount: number;
  snapshotVersion: number;
};

type ParsedEntry = { item: FeedItem; bodyCandidate: string };
type RouteFetchResult =
  | ({ attemptedAt: string; completedAt: string } & {
      status: "ok";
      entries: ParsedEntry[];
      filteredCount: number;
    })
  | ({ attemptedAt: string; completedAt: string } & {
      status: "empty" | "filtered_empty";
      entries: [];
      filteredCount: number;
    })
  | ({ attemptedAt: string; completedAt: string } & {
      status: "failed" | "configuration";
      category: RouteFailureCategory;
    });

let aggregateFlight: Promise<FeedResult> | null = null;
const routeFlights = new Map<
  string,
  {
    promise: Promise<RouteFetchResult>;
    signal: AbortSignal;
    attemptedAt: string;
  }
>();

function plainText(value = "") {
  return value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => {
      const point = Number(code);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
        ? String.fromCodePoint(point)
        : " ";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(value = "") {
  const text = plainText(value);
  return text.length > 420 ? `${text.slice(0, 419).trimEnd()}…` : text;
}

function candidateFromEntry(entry: any) {
  const candidates = [
    entry.contentEncoded,
    entry.content,
    entry.contentField,
    entry.description,
    entry.summary,
  ]
    .filter(
      (value): value is string =>
        typeof value === "string" && Boolean(value.trim()),
    )
    .map((value, index) => ({
      value,
      index,
      textLength: plainText(value).length,
    }));
  candidates.sort((a, b) => b.textLength - a.textLength || a.index - b.index);
  return candidates[0]?.value || "";
}

function entryDescription(sourceId: string, entry: any, candidate: string) {
  if (sourceId === "nasa" && candidate.length > 1000) {
    try {
      const url =
        typeof entry.link === "string" && /^https:\/\//i.test(entry.link)
          ? entry.link
          : "https://invalid.feed.local/";
      const document = new JSDOM(candidate, { url }).window.document;
      const firstArticleParagraph = Array.from(document.querySelectorAll("p"))
        .map(
          (paragraph) =>
            paragraph.textContent?.replace(/\s+/g, " ").trim() || "",
        )
        .find(
          (text) =>
            text.length >= 60 &&
            !/^(?:news\s*&\s*events|search|rss\s+education|about\s+nasa|apod\s+science)/i.test(
              text,
            ),
        );
      if (firstArticleParagraph) return stripHtml(firstArticleParagraph);
    } catch {
      /* Fall back to the publisher-provided summary when parsing fails. */
    }
  }
  return stripHtml(
    String(
      entry.contentSnippet ||
        entry.summary ||
        entry.description ||
        candidate ||
        "",
    ),
  );
}

function imageQualityFor(width: number) {
  if (!width) return "unknown" as const;
  if (width >= 600) return "declared" as const;
  return width >= 300 ? ("medium" as const) : ("unknown" as const);
}

function effectiveImageWidth(url: string, declaredWidth: number) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "img.atlasobscura.com") {
      const resizedWidth = Number(
        parsed.pathname.match(/\/rs:(?:fill|fit|resize):(\d+):\d+/i)?.[1],
      );
      if (resizedWidth > 0)
        return declaredWidth > 0
          ? Math.min(declaredWidth, resizedWidth)
          : resizedWidth;
    }
  } catch {
    /* Keep source metadata when the candidate URL cannot be parsed. */
  }
  return declaredWidth;
}

function imageDetails(item: any, candidate: string) {
  const match = candidate.match(/<img\b([^>]*?)>/i);
  const attributes = match?.[1] || "";
  const htmlWidth = Number(attributes.match(/\bwidth=["']?(\d+)/i)?.[1] || 0);
  const htmlHeight = Number(attributes.match(/\bheight=["']?(\d+)/i)?.[1] || 0);
  const imageCandidates: { url: string; width: number }[] = [];
  const addCandidate = (value: unknown, width = 0, imageLike = true) => {
    if (typeof value !== "string" || !value || !imageLike) return;
    try {
      const url = new URL(value, item.link);
      if (
        isSafeHttpsImage(url.href) &&
        !(htmlWidth > 0 && htmlWidth <= 24) &&
        !(htmlHeight > 0 && htmlHeight <= 24)
      )
        imageCandidates.push({ url: url.href, width });
    } catch {
      /* Ignore missing or malformed image URLs. */
    }
  };
  const enclosure = item.enclosure;
  const enclosureUrl = enclosure?.url;
  const enclosureType = String(enclosure?.type || "").toLowerCase();
  const enclosurePath = (() => {
    try {
      return new URL(String(enclosureUrl || ""), item.link).pathname;
    } catch {
      return "";
    }
  })();
  const isImageEnclosure =
    enclosureType.startsWith("image/") ||
    /\.(?:apng|avif|gif|jpe?g|png|svg|webp)$/i.test(enclosurePath);
  addCandidate(enclosureUrl, Number(enclosure?.width || 0), isImageEnclosure);

  const entries = (value: unknown) =>
    Array.isArray(value) ? value : value ? [value] : [];
  for (const media of entries(item.mediaContent)) {
    const type = String(media?.$?.type || "").toLowerCase();
    addCandidate(
      media?.$?.url,
      Number(media?.$?.width || 0),
      !type || type.startsWith("image/"),
    );
  }
  for (const media of entries(item.mediaThumbnail))
    addCandidate(media?.$?.url, Number(media?.$?.width || 0));

  const srcset = attributes.match(/\bsrcset=["']([^"']+)["']/i)?.[1] || "";
  for (const candidateValue of srcset.split(",")) {
    const [url, descriptor] = candidateValue.trim().split(/\s+/, 2);
    const width = descriptor?.endsWith("w")
      ? Number.parseInt(descriptor, 10)
      : 0;
    addCandidate(url, Number.isFinite(width) ? width : 0);
  }
  addCandidate(attributes.match(/\bsrc=["']([^"']+)["']/i)?.[1], htmlWidth);

  const sizedCandidates = imageCandidates
    .map((candidateValue) => ({
      ...candidateValue,
      width: effectiveImageWidth(candidateValue.url, candidateValue.width),
    }))
    .filter((candidateValue) => candidateValue.width > 0)
    .sort((a, b) => a.width - b.width);
  const imageCandidate =
    sizedCandidates.find((candidateValue) => candidateValue.width >= 740) ||
    sizedCandidates[sizedCandidates.length - 1] ||
    imageCandidates[0];
  const image = imageCandidate?.url;
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
  return {
    image,
    imageAlt,
    imageCredit,
    imageWidth: imageCandidate?.width || undefined,
    imageQuality: image
      ? imageQualityFor(imageCandidate?.width || 0)
      : ("unknown" as const),
  };
}

function itemKindFor(
  source: FeedSource,
  route: FeedRoute,
  entry: any,
  candidate: string,
) {
  if (source.kind === "youtube" || route.itemKind === "video")
    return "video" as const;
  if (route.itemKind === "interactive" || source.itemKind === "interactive")
    return "interactive" as const;
  let pathname = "";
  try {
    pathname = new URL(entry.link).pathname;
  } catch {
    return "unknown" as const;
  }
  if (/\/(?:video|videos)(?:\/|$)/i.test(pathname)) return "video" as const;
  if (
    source.id === "the-pudding" &&
    /\/(?:interactive|projects)(?:\/|$)/i.test(pathname)
  )
    return "interactive" as const;
  if (
    /<(?:iframe|embed|object)\b/i.test(candidate) &&
    plainText(candidate).length < 200
  )
    return "unknown" as const;
  return "article" as const;
}

function matchesPathPrefix(pathname: string, prefix: string) {
  const normalized = prefix.startsWith("/") ? prefix : `/${prefix}`;
  const boundary = normalized.endsWith("/") ? normalized : `${normalized}/`;
  return pathname === normalized || pathname.startsWith(boundary);
}

function legacyId(sourceName: string, entry: any) {
  const identity = entry.guid || entry.id || entry.link || entry.title;
  return identity ? `${sourceName}:${identity}` : "";
}

function publishedAt(value?: string) {
  const timestamp = new Date(value || "").getTime();
  return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
}

async function mapConcurrent<T, R>(
  values: T[],
  limit: number,
  signal: AbortSignal,
  mapper: (value: T) => Promise<R>,
) {
  const results = new Array<R | undefined>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length && !signal.aborted) {
        const index = next++;
        results[index] = await mapper(values[index]);
      }
    }),
  );
  return results;
}

function routeFailureCategory(reason: unknown): RouteFailureCategory {
  if (reason instanceof RSSHubConfigurationError) return "configuration";
  const category = (reason as { category?: RouteFailureCategory } | undefined)
    ?.category;
  if (category === "parse") return "parse";
  if (category === "configuration") return "configuration";
  return fetchFailureCategory(reason);
}

function isXmlPayload(contentType: string, body: string) {
  if (/text\/html|application\/xhtml\+xml/i.test(contentType)) return false;
  const declaresXml =
    /(?:application|text)\/(?:[\w.+-]*\+)?xml|application\/(?:rss|atom)\+xml/i.test(
      contentType,
    );
  const hasFeedRoot = /<(?:rss|feed|rdf:rdf)\b/i.test(body);
  return hasFeedRoot && declaresXml;
}

async function fetchRoute(
  route: FeedRoute,
  signal: AbortSignal,
): Promise<RouteFetchResult> {
  const attemptedAt = new Date().toISOString();
  try {
    const source = sources.find((entry) => entry.id === route.sourceId);
    if (!source)
      throw new RSSHubConfigurationError("Registered route has no source");
    const url = rssHubRouteUrl(route);
    const response = await fetchRegisteredFeed(url.href, [url.hostname], {
      timeoutMs: ROUTE_TIMEOUT_MS,
      signal,
    });
    if (response.truncated)
      throw Object.assign(new Error("feed_response_too_large"), {
        category: "too_large",
      });
    if (!isXmlPayload(response.contentType, response.body))
      throw Object.assign(new Error("feed_response_was_not_xml"), {
        category: "parse",
      });

    let feed: any;
    try {
      feed = await parser.parseString(response.body);
    } catch (error) {
      throw Object.assign(
        error instanceof Error ? error : new Error("feed_parse_failed"),
        {
          category: "parse",
        },
      );
    }
    const entries: any[] = Array.isArray(feed.items) ? feed.items : [];
    if (!entries.length)
      return {
        status: "empty",
        entries: [],
        filteredCount: 0,
        attemptedAt,
        completedAt: new Date().toISOString(),
      };

    let filteredCount = 0;
    const parsedEntries: ParsedEntry[] = [];
    for (const entry of entries.slice(
      0,
      Math.min(route.limit || MAX_ITEMS_PER_ROUTE, MAX_ITEMS_PER_ROUTE),
    )) {
      const title = typeof entry.title === "string" ? entry.title.trim() : "";
      let linkUrl: URL;
      try {
        linkUrl = new URL(typeof entry.link === "string" ? entry.link : "");
      } catch {
        filteredCount += 1;
        continue;
      }
      if (
        linkUrl.protocol !== "https:" ||
        !source.articleHosts.includes(linkUrl.hostname.toLowerCase()) ||
        (route.articlePathPrefixes?.length &&
          !route.articlePathPrefixes.some((prefix) =>
            matchesPathPrefix(linkUrl.pathname, prefix),
          )) ||
        !title
      ) {
        filteredCount += 1;
        continue;
      }

      const candidate = candidateFromEntry(entry);
      const kind = itemKindFor(source, route, entry, candidate);
      const item: FeedItem = {
        id: "",
        sourceId: source.id,
        legacyIds: legacyId(source.name, entry)
          ? [legacyId(source.name, entry)]
          : [],
        title,
        link: linkUrl.href,
        description: entryDescription(source.id, entry, candidate),
        contentSnippet: stripHtml(String(entry.contentSnippet || "")),
        pubDate: entry.isoDate || entry.pubDate,
        creator: entry.creator || entry.author || "",
        source: source.name,
        topic: route.topic,
        ...imageDetails(entry, candidate),
        contentType: kind,
        contentStatus:
          kind === "article"
            ? "summary"
            : kind === "video"
              ? "video"
              : kind === "interactive"
                ? "interactive"
                : "unsupported",
        contentCompleteness: "summary",
      };
      const identity = articleIdentity(item);
      if (!identity) {
        filteredCount += 1;
        continue;
      }
      item.id = stableArticleId(source.id, identity);
      parsedEntries.push({ item, bodyCandidate: candidate });
    }

    if (parsedEntries.length)
      return {
        status: "ok",
        entries: parsedEntries,
        filteredCount,
        attemptedAt,
        completedAt: new Date().toISOString(),
      };
    return {
      status: filteredCount ? "filtered_empty" : "empty",
      entries: [],
      filteredCount,
      attemptedAt,
      completedAt: new Date().toISOString(),
    };
  } catch (reason) {
    const category = routeFailureCategory(reason);
    return {
      status: category === "configuration" ? "configuration" : "failed",
      category,
      attemptedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

function fetchRouteSingleFlight(route: FeedRoute, signal: AbortSignal) {
  let flight = routeFlights.get(route.id);
  if (!flight || flight.signal.aborted) {
    const attemptedAt = new Date().toISOString();
    const task = fetchRoute(route, signal).finally(() => {
      if (routeFlights.get(route.id)?.promise === task)
        routeFlights.delete(route.id);
    });
    flight = { promise: task, signal, attemptedAt };
    routeFlights.set(route.id, flight);
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<RouteFetchResult>((resolve) => {
    onAbort = () =>
      resolve({
        status: "failed",
        category: "timeout",
        attemptedAt: flight!.attemptedAt,
        completedAt: new Date().toISOString(),
      });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([flight.promise, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

function shouldFetchRoute(
  state: FeedRouteState | undefined,
  force: boolean,
  now: number,
  rssHubConfigured: boolean,
) {
  if (!state) return true;
  const failed = state.status === "failed" || state.status === "configuration";
  if (state.status === "configuration" && rssHubConfigured) return true;
  if (force) {
    const lastManual = new Date(state.lastManualRetryAt || "").getTime();
    return (
      !failed ||
      !Number.isFinite(lastManual) ||
      now - lastManual >= MANUAL_RETRY_COOLDOWN_MS
    );
  }
  const nextAttempt = new Date(state.nextAttemptAt || "").getTime();
  if (Number.isFinite(nextAttempt) && nextAttempt > now) return false;
  if (failed) return true;
  const lastAttempt = new Date(state.lastAttemptAt || "").getTime();
  return !Number.isFinite(lastAttempt) || now - lastAttempt >= ROUTE_REFRESH_MS;
}

function buildRouteState(
  route: FeedRoute,
  result: RouteFetchResult,
  previous: FeedRouteState | undefined,
  routeItemIds: string[],
  manual: boolean,
): FeedRouteState {
  const base = previous || { routeId: route.id, itemIds: [], failureCount: 0 };
  const { attemptedAt, completedAt } = result;
  if (result.status === "failed" || result.status === "configuration") {
    const failureCount = base.failureCount + 1;
    const delayMinutes =
      result.status === "configuration"
        ? 24 * 60
        : FAILURE_BACKOFF_MINUTES[
            Math.min(failureCount - 1, FAILURE_BACKOFF_MINUTES.length - 1)
          ];
    return {
      ...base,
      routeId: route.id,
      status: result.status,
      lastAttemptAt: attemptedAt,
      failureCategory: result.category,
      failureCount,
      nextAttemptAt: new Date(
        Date.parse(completedAt) + delayMinutes * 60 * 1000,
      ).toISOString(),
      lastManualRetryAt: manual ? attemptedAt : base.lastManualRetryAt,
    };
  }

  const hasItems = result.status === "ok" && routeItemIds.length > 0;
  return {
    ...base,
    routeId: route.id,
    itemIds: hasItems ? routeItemIds : base.itemIds,
    status: result.status,
    lastAttemptAt: attemptedAt,
    lastSuccessAt: completedAt,
    lastContentAt: hasItems ? completedAt : base.lastContentAt,
    failureCategory: undefined,
    failureCount: 0,
    nextAttemptAt: undefined,
    lastManualRetryAt: manual ? attemptedAt : base.lastManualRetryAt,
  };
}

function mergeRouteEntries(
  results: Map<string, RouteFetchResult>,
  routeById: Map<string, FeedRoute>,
) {
  const entries = new Map<string, ParsedEntry & { priority: number }>();
  for (const [routeId, result] of results) {
    if (result.status !== "ok") continue;
    const route = routeById.get(routeId)!;
    for (const parsed of result.entries) {
      const identity = articleIdentity(parsed.item);
      const existing = entries.get(identity);
      const priority = route.priority || 0;
      if (!existing || priority > existing.priority) {
        entries.set(identity, { ...parsed, priority });
      } else if (existing) {
        existing.item.legacyIds = [
          ...new Set([
            ...(existing.item.legacyIds || []),
            ...(parsed.item.legacyIds || []),
          ]),
        ];
      }
    }
  }
  return [...entries.values()];
}

function failureState(state?: FeedRouteState) {
  return state?.status === "failed" || state?.status === "configuration";
}

function resultFromSnapshots(
  states: Record<string, FeedRouteState>,
  routeItems: Record<string, FeedItem[]>,
  cached: boolean,
  archiveAvailable: ArchiveAvailability,
  routeCacheAvailable: ArchiveAvailability,
  candidateCapacityDrops = 0,
  candidateTooLargeCount = 0,
): FeedResult {
  const sourceRoutes = new Map<string, FeedRoute[]>();
  for (const route of feedRoutes) {
    const list = sourceRoutes.get(route.sourceId) || [];
    list.push(route);
    sourceRoutes.set(route.sourceId, list);
  }

  const failedRouteIds = feedRoutes
    .filter((route) => failureState(states[route.id]))
    .map((route) => route.id);
  const failedRouteCategories = Object.fromEntries(
    feedRoutes.flatMap((route) => {
      const state = states[route.id];
      return failureState(state) && state?.failureCategory
        ? [[route.id, state.failureCategory as RouteFailureCategory]]
        : [];
    }),
  );
  const failedSourceIds: string[] = [];
  const partialSourceIds: string[] = [];
  for (const [sourceId, routes] of sourceRoutes) {
    const failures = routes.filter((route) =>
      failureState(states[route.id]),
    ).length;
    if (failures === routes.length) failedSourceIds.push(sourceId);
    else if (failures > 0) partialSourceIds.push(sourceId);
  }

  const byIdentity = new Map<string, { item: FeedItem; priority: number }>();
  for (const route of feedRoutes) {
    for (const item of routeItems[route.id] || []) {
      const identity = articleIdentity(item) || item.id;
      const priority = route.priority || 0;
      const current = byIdentity.get(identity);
      const routeItem =
        item.topic === route.topic ? item : { ...item, topic: route.topic };
      if (!current || priority > current.priority)
        byIdentity.set(identity, { item: routeItem, priority });
    }
  }
  const items = [...byIdentity.values()].map(({ item }) => item);
  items.sort((a, b) => publishedAt(b.pubDate) - publishedAt(a.pubDate));
  const successfulAt =
    feedRoutes
      .map((route) => states[route.id]?.lastSuccessAt || "")
      .filter(Boolean)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || "";

  return {
    items,
    updatedAt: successfulAt,
    failedSourceCount: failedSourceIds.length,
    failedSourceIds,
    partialSourceIds,
    failedRouteCount: failedRouteIds.length,
    failedRouteIds,
    failedRoutesWithCachedItems: failedRouteIds.filter(
      (routeId) => (routeItems[routeId]?.length || 0) > 0,
    ).length,
    failedRouteCategories,
    routeStatuses: feedRoutes.map((route) => {
      const state = states[route.id];
      return {
        routeId: route.id,
        sourceId: route.sourceId,
        status: state?.status || "idle",
        itemCount: routeItems[route.id]?.length || 0,
        lastAttemptAt: state?.lastAttemptAt,
        lastSuccessAt: state?.lastSuccessAt,
        failureCategory: state?.failureCategory,
      };
    }),
    sourceCount: sourceRoutes.size,
    routeCount: feedRoutes.length,
    allSourcesFailed:
      feedRoutes.length > 0 &&
      feedRoutes.every((route) => failureState(states[route.id])),
    cached,
    archiveAvailable,
    routeCacheAvailable,
    candidateCapacityDrops,
    candidateTooLargeCount,
    snapshotVersion: Math.max(
      0,
      ...feedRoutes.map(
        (route) => Date.parse(states[route.id]?.lastAttemptAt || "") || 0,
      ),
    ),
  };
}

async function refreshAggregatedFeed(force: boolean): Promise<FeedResult> {
  const now = Date.now();
  let states = await getFeedRouteStates();
  let rssHubConfigured = false;
  try {
    getRSSHubBaseUrl();
    rssHubConfigured = true;
  } catch {
    /* Keep cached configuration failures until the required origin is set. */
  }
  const dueRoutes = feedRoutes.filter((route) =>
    shouldFetchRoute(states[route.id], force, now, rssHubConfigured),
  );
  let candidateCapacityDrops = 0;
  let candidateTooLargeCount = 0;
  let attemptedCount = 0;
  let articleArchiveUnavailable = false;
  let transientItemsByRoute = new Map<string, FeedItem[]>();

  if (dueRoutes.length) {
    const controller = new AbortController();
    const budgetTimer = setTimeout(
      () => controller.abort(),
      AGGREGATE_BUDGET_MS,
    );
    const outcomes = await mapConcurrent(
      dueRoutes,
      3,
      controller.signal,
      async (route) => {
        attemptedCount += 1;
        return fetchRouteSingleFlight(route, controller.signal);
      },
    );
    clearTimeout(budgetTimer);

    const routeResults = new Map<string, RouteFetchResult>();
    outcomes.forEach((outcome, index) => {
      if (outcome) routeResults.set(dueRoutes[index].id, outcome);
    });
    const mergedEntries = mergeRouteEntries(
      routeResults,
      new Map(feedRoutes.map((route) => [route.id, route])),
    );
    let savedByIdentity = new Map<string, FeedItem>();
    if (mergedEntries.length) {
      const saved = await saveArticleRecords(
        mergedEntries.map((entry) => entry.item),
        new Map(
          mergedEntries.map((entry) => [entry.item.id, entry.bodyCandidate]),
        ),
      );
      candidateCapacityDrops = saved.candidateCapacityDrops;
      candidateTooLargeCount = saved.candidateTooLargeCount;
      articleArchiveUnavailable = saved.archiveAvailable === "unavailable";
      savedByIdentity = new Map(
        saved.items.map((item) => [articleIdentity(item), item]),
      );
    }

    const nextStates: FeedRouteState[] = [];
    for (const [routeId, result] of routeResults) {
      const route = feedRoutes.find((entry) => entry.id === routeId)!;
      const routeItemIds =
        result.status === "ok" && !articleArchiveUnavailable
          ? result.entries
              .map(
                (entry) => savedByIdentity.get(articleIdentity(entry.item))?.id,
              )
              .filter((id): id is string => Boolean(id))
          : [];
      nextStates.push(
        buildRouteState(
          route,
          result,
          states[routeId],
          [...new Set(routeItemIds)],
          force,
        ),
      );
    }
    if (nextStates.length) {
      await saveFeedRouteStates(nextStates);
      states = {
        ...states,
        ...Object.fromEntries(
          nextStates.map((state) => [state.routeId, state]),
        ),
      };
    }
    if (
      isArticleArchiveAvailable() === "unavailable" ||
      isRouteCacheAvailable() === "unavailable"
    ) {
      transientItemsByRoute = new Map(
        [...routeResults].flatMap(([routeId, result]) =>
          result.status === "ok"
            ? [
                [
                  routeId,
                  result.entries.map(
                    (entry) =>
                      savedByIdentity.get(articleIdentity(entry.item)) ||
                      entry.item,
                  ),
                ] as const,
              ]
            : [],
        ),
      );
    }
  }

  const routeItems = await getFeedRouteItems(
    feedRoutes.map((route) => route.id),
    states,
  );
  for (const [routeId, items] of transientItemsByRoute)
    routeItems[routeId] = items;
  return resultFromSnapshots(
    states,
    routeItems,
    attemptedCount === 0,
    isArticleArchiveAvailable(),
    isRouteCacheAvailable(),
    candidateCapacityDrops,
    candidateTooLargeCount,
  );
}

export async function getAggregatedFeed(force = false): Promise<FeedResult> {
  if (aggregateFlight) return aggregateFlight;

  aggregateFlight = refreshAggregatedFeed(force)
    .finally(() => {
      aggregateFlight = null;
    });
  return aggregateFlight;
}

/** Read persisted route snapshots without waiting for an upstream refresh. */
export async function getFeedSnapshot() {
  const states = await getFeedRouteStates();
  const routeItems = await getFeedRouteItems(
    feedRoutes.map((route) => route.id),
    states,
  );
  let configured = false;
  try {
    getRSSHubBaseUrl();
    configured = true;
  } catch {
    /* Configuration is reported by refresh. */
  }
  return {
    ...resultFromSnapshots(
      states,
      routeItems,
      true,
      isArticleArchiveAvailable(),
      isRouteCacheAvailable(),
    ),
    initialized: feedRoutes.some((route) =>
      Boolean(states[route.id]?.lastSuccessAt),
    ),
    updateAvailable: feedRoutes.some((route) =>
      shouldFetchRoute(states[route.id], false, Date.now(), configured),
    ),
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
