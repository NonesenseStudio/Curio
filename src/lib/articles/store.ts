import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ArchiveAvailability,
  ArticleRecord,
  ContentCompleteness,
  FeedItem,
  Topic,
} from "@/lib/types";
import { sources } from "@/lib/sources";
import { isBodyMethodAllowed } from "./body-policy";
import {
  LEGACY_SANITIZE_VERSIONS,
  SANITIZE_VERSION,
  digest12,
} from "./body-version";
import { articleIdentity } from "./identity";

const MAX_RECORDS = 5000;
/** Persistence limit for feed body candidates, in characters (not bytes). */
const MAX_CANDIDATE_CHARS = 262_144;
/** Aggregate cap for temporary raw candidates; sanitized bodies are separate. */
const MAX_CANDIDATE_TOTAL_BYTES = 32 * 1024 * 1024;
const CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;
const dataDirectory =
  process.env.CURIO_DATA_DIR || path.join(process.cwd(), ".curio-data");
const storePath = path.join(dataDirectory, "articles-v1.json");
const routeStatePath = path.join(dataDirectory, "feed-routes-v1.json");

let writeQueue: Promise<void> = Promise.resolve();
let memoryRecords: ArticleRecord[] = [];
let memoryRouteStates: Record<string, FeedRouteState> = {};
/**
 * State of the last write attempt against the archive. It starts as
 * "unknown": before any write has run, neither success nor failure of the
 * storage path can be claimed.
 */
let archiveState: ArchiveAvailability = "unknown";
let routeArchiveState: ArchiveAvailability = "unknown";

export type FeedRouteState = {
  routeId: string;
  itemIds: string[];
  status?: "ok" | "empty" | "filtered_empty" | "failed" | "configuration";
  lastAttemptAt?: string;
  /** Last valid route response, including an empty or filtered result. */
  lastSuccessAt?: string;
  /** Last response that provided at least one accepted article. */
  lastContentAt?: string;
  failureCategory?: string;
  failureCount: number;
  nextAttemptAt?: string;
  lastManualRetryAt?: string;
};

async function writeArchive(values: ArticleRecord[]) {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(values), "utf8");
  await rename(temporaryPath, storePath);
  archiveState = "available";
}

async function writeRouteArchive(values: Record<string, FeedRouteState>) {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryPath = `${routeStatePath}.${randomUUID()}.tmp`;
  await writeFile(
    temporaryPath,
    JSON.stringify({ version: 1, routes: values }),
    "utf8",
  );
  await rename(temporaryPath, routeStatePath);
  routeArchiveState = "available";
}

async function readRouteStates(): Promise<Record<string, FeedRouteState>> {
  let diskRoutes: Record<string, FeedRouteState> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(routeStatePath, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      "routes" in parsed &&
      (parsed as { routes?: unknown }).routes &&
      typeof (parsed as { routes: unknown }).routes === "object"
    ) {
      diskRoutes = (parsed as { routes: Record<string, FeedRouteState> }).routes;
      routeArchiveState = "available";
    } else throw new Error("invalid_route_archive");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") routeArchiveState = "unavailable";
    diskRoutes = {};
  }
  return { ...diskRoutes, ...memoryRouteStates };
}

function enforceCandidateBudget(records: ArticleRecord[]) {
  let usedBytes = 0;
  let droppedCount = 0;
  const keep = new Set<number>();
  const candidates = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => Boolean(record.bodyCandidate))
    .sort((left, right) => {
      const leftAt = Date.parse(left.record.candidateStoredAt || "") || 0;
      const rightAt = Date.parse(right.record.candidateStoredAt || "") || 0;
      return rightAt - leftAt;
    });

  for (const { record, index } of candidates) {
    const bytes = Buffer.byteLength(record.bodyCandidate || "", "utf8");
    if (usedBytes + bytes <= MAX_CANDIDATE_TOTAL_BYTES) {
      usedBytes += bytes;
      keep.add(index);
    } else {
      droppedCount += 1;
    }
  }

  return {
    records: records.map((record, index) => {
      if (!record.bodyCandidate || keep.has(index)) return record;
      const {
        bodyCandidate: _droppedCandidate,
        candidateStoredAt: _droppedAt,
        candidateTruncated: _droppedTruncation,
        ...metadata
      } = record;
      return { ...metadata, candidateError: "storage_limit" as const };
    }),
    droppedCount,
  };
}

async function readRecords(pruneExpired = false): Promise<ArticleRecord[]> {
  let diskRecords: ArticleRecord[] = [];
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("invalid_article_archive");
    if (Array.isArray(parsed))
      diskRecords = parsed.filter(
        (entry): entry is ArticleRecord =>
          Boolean(entry) &&
          typeof entry === "object" &&
          "item" in entry &&
          Boolean((entry as ArticleRecord).item?.id),
      );
    archiveState = "available";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") archiveState = "unavailable";
    diskRecords = [];
  }
  const byId = new Map(diskRecords.map((record) => [record.item.id, record]));
  for (const record of memoryRecords) byId.set(record.item.id, record);
  const records = [...byId.values()];
  if (!pruneExpired) return records;
  let changed = false;
  const fresh = records.map((record) => {
    if (!record.bodyCandidate) return record;
    const storedAt = new Date(record.candidateStoredAt || "").getTime();
    if (Number.isFinite(storedAt) && Date.now() - storedAt < CANDIDATE_TTL_MS)
      return record;
    changed = true;
    const {
      bodyCandidate: _expiredCandidate,
      candidateStoredAt: _expiredAt,
      candidateTruncated: _expiredTruncation,
      candidateError: _expiredError,
      ...metadata
    } = record;
    return metadata;
  });
  const bounded = enforceCandidateBudget(fresh);
  if (bounded.droppedCount) changed = true;
  if (changed) {
    memoryRecords = bounded.records;
    const prune = () =>
      writeArchive(bounded.records).catch(() => {
        archiveState = "unavailable";
      });
    writeQueue = writeQueue.then(prune, prune);
    await writeQueue;
  }
  return bounded.records;
}

function matches(record: ArticleRecord, id: string) {
  return (
    record.item.id === id ||
    record.item.legacyIds?.includes(id) ||
    record.item.link === id
  );
}

export async function saveArticleRecords(
  items: FeedItem[],
  candidates: Map<string, string>,
): Promise<{
  archiveAvailable: ArchiveAvailability;
  items: FeedItem[];
  candidateCapacityDrops: number;
  candidateTooLargeCount: number;
}> {
  let savedItems: FeedItem[] = [];
  let candidateCapacityDrops = 0;
  let candidateTooLargeCount = 0;
  const update = async () => {
    const records = await readRecords();
    const byId = new Map(records.map((record) => [record.item.id, record]));
    const recordsByIdentity = new Map<string, ArticleRecord[]>();
    for (const record of records) {
      const identity = articleIdentity(record.item);
      if (!identity) continue;
      const matches = recordsByIdentity.get(identity) || [];
      matches.push(record);
      recordsByIdentity.set(identity, matches);
    }
    const now = Date.now();
    const persisted: FeedItem[] = [];
    for (const item of items) {
      const identity = articleIdentity(item);
      const identityMatches = identity ? recordsByIdentity.get(identity) || [] : [];
      const old =
        byId.get(item.id) || identityMatches[0];
      const duplicateRecords = identityMatches.filter(
        (record) => record.item.id !== old?.item.id,
      );
      let mergedOld = old;
      for (const duplicate of duplicateRecords) {
        if (!mergedOld) break;
        mergedOld = {
          ...mergedOld,
          item: {
            ...mergedOld.item,
            legacyIds: [
              ...new Set([
                ...(mergedOld.item.legacyIds || []),
                duplicate.item.id,
                ...(duplicate.item.legacyIds || []),
              ]),
            ],
          },
          bodyCandidate: mergedOld.bodyCandidate || duplicate.bodyCandidate,
          candidateStoredAt:
            mergedOld.candidateStoredAt || duplicate.candidateStoredAt,
          candidateTruncated:
            mergedOld.candidateTruncated ?? duplicate.candidateTruncated,
          candidateError: mergedOld.candidateError || duplicate.candidateError,
          candidateDigest: mergedOld.candidateDigest || duplicate.candidateDigest,
          bodyHtml: mergedOld.bodyHtml || duplicate.bodyHtml,
          bodyFetchedAt: mergedOld.bodyFetchedAt || duplicate.bodyFetchedAt,
          bodyVersion: mergedOld.bodyVersion || duplicate.bodyVersion,
          bodyCompleteness:
            mergedOld.bodyCompleteness || duplicate.bodyCompleteness,
          bodySource: mergedOld.bodySource || duplicate.bodySource,
          bodySourceDigest:
            mergedOld.bodySourceDigest || duplicate.bodySourceDigest,
          bodyError: mergedOld.bodyError || duplicate.bodyError,
          bodyAttempts: mergedOld.bodyAttempts ?? duplicate.bodyAttempts,
          bodyNextAttemptAt:
            mergedOld.bodyNextAttemptAt || duplicate.bodyNextAttemptAt,
        };
        byId.delete(duplicate.item.id);
      }
      const itemId = old?.item.id || item.id;
      const legacyIds = [
        ...new Set([
          ...(mergedOld?.item.legacyIds || []),
          ...duplicateRecords.map((record) => record.item.id),
          ...duplicateRecords.flatMap((record) => record.item.legacyIds || []),
          ...(item.legacyIds || []),
          ...(itemId === item.id ? [] : [item.id]),
        ]),
      ];
      const persistedItem = { ...item, id: itemId, legacyIds };
      const existingCandidateIsFresh = Boolean(
        mergedOld?.candidateStoredAt &&
          now - new Date(mergedOld.candidateStoredAt).getTime() < CANDIDATE_TTL_MS,
      );
      const candidate = candidates.get(item.id);
      const candidateTooLarge = Boolean(
        candidate && candidate.length > MAX_CANDIDATE_CHARS,
      );
      if (candidateTooLarge) candidateTooLargeCount += 1;
      const nextCandidate = candidateTooLarge
        ? undefined
        : candidate
          ? candidate
        : existingCandidateIsFresh
          ? mergedOld?.bodyCandidate
          : undefined;
      const truncated = candidateTooLarge
        ? true
        : candidate
          ? false
          : existingCandidateIsFresh
            ? mergedOld?.candidateTruncated
            : undefined;
      if (mergedOld) byId.delete(mergedOld.item.id);
      byId.set(itemId, {
        ...mergedOld,
        item: persistedItem,
        feedFetchedAt: new Date(now).toISOString(),
        bodyCandidate: nextCandidate,
        candidateStoredAt: nextCandidate
          ? candidate
            ? new Date(now).toISOString()
            : mergedOld?.candidateStoredAt
          : undefined,
        candidateTruncated: candidateTooLarge
          ? true
          : nextCandidate
            ? truncated
            : undefined,
        candidateError: candidateTooLarge
          ? "too_large"
          : candidate
            ? undefined
            : existingCandidateIsFresh
              ? mergedOld?.candidateError
              : undefined,
        candidateDigest: candidate
          ? digest12(candidate)
          : mergedOld?.candidateDigest,
      });
      if (identity) recordsByIdentity.set(identity, [byId.get(itemId)!]);
      persisted.push(persistedItem);
    }
    const nowRecords: ArticleRecord[] = [...byId.values()]
      .map((record) => {
        const storedAt = new Date(record.candidateStoredAt || "").getTime();
        if (
          !record.bodyCandidate ||
          (Number.isFinite(storedAt) && now - storedAt < CANDIDATE_TTL_MS)
        )
          return record;
        const {
          bodyCandidate: _expiredCandidate,
          candidateStoredAt: _expiredAt,
          candidateTruncated: _expiredTruncation,
          candidateError: _expiredError,
          ...metadata
        } = record;
        return metadata;
      })
      .slice(-MAX_RECORDS);
    const bounded = enforceCandidateBudget(nowRecords);
    const values = bounded.records;
    candidateCapacityDrops = bounded.droppedCount;
    memoryRecords = values;
    savedItems = persisted;
    try {
      await writeArchive(values);
    } catch {
      archiveState = "unavailable";
    }
  };

  writeQueue = writeQueue.then(update, update);
  await writeQueue;
  return {
    archiveAvailable: archiveState,
    items: savedItems,
    candidateCapacityDrops,
    candidateTooLargeCount,
  };
}

export async function saveFeedRouteStates(states: FeedRouteState[]) {
  const update = async () => {
    const routes = await readRouteStates();
    for (const state of states) routes[state.routeId] = state;
    memoryRouteStates = routes;
    try {
      await writeRouteArchive(routes);
    } catch {
      routeArchiveState = "unavailable";
    }
  };
  writeQueue = writeQueue.then(update, update);
  await writeQueue;
  return routeArchiveState;
}

export async function getFeedRouteStates() {
  return readRouteStates();
}

export async function getFeedRouteItems(
  routeIds: string[],
  states?: Record<string, FeedRouteState>,
) {
  const routeStates = states || (await readRouteStates());
  const records = await readRecords(false);
  const byId = new Map<string, ArticleRecord>();
  for (const record of records) {
    byId.set(record.item.id, record);
    for (const legacyId of record.item.legacyIds || [])
      if (!byId.has(legacyId)) byId.set(legacyId, record);
  }
  return Object.fromEntries(
    routeIds.map((routeId) => [
      routeId,
      (routeStates[routeId]?.itemIds || [])
        .map((id) => byId.get(id)?.item)
        .filter((item): item is FeedItem => Boolean(item)),
    ]),
  );
}

export function isArticleArchiveAvailable(): ArchiveAvailability {
  return archiveState;
}

export function isRouteCacheAvailable(): ArchiveAvailability {
  return routeArchiveState;
}

export async function getArchivedFeedItems(limit = 72) {
  const records = await readRecords(true);
  const items = records
    .map((record) => record.item)
    .filter((item) => Boolean(item.title.trim() && item.link))
    .sort(
      (a, b) =>
        new Date(b.pubDate || 0).getTime() -
        new Date(a.pubDate || 0).getTime(),
    )
    .slice(0, limit);
  const updatedAt = records
    .map((record) => record.feedFetchedAt || "")
    .filter(Boolean)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || "";
  return { items, updatedAt };
}

export async function getArticleRecord(
  id: string,
): Promise<ArticleRecord | undefined> {
  const records = await readRecords(true);
  return records.find((record) => matches(record, id));
}

export type BodyPatch = {
  bodyHtml?: string | null;
  bodyFetchedAt?: string | null;
  bodyVersion?: string | null;
  bodyCompleteness?: ContentCompleteness | null;
  bodySource?: "feed" | "web" | null;
  bodySourceDigest?: string | null;
  bodyError?: string | null;
  bodyAttempts?: number;
  bodyNextAttemptAt?: string | null;
};

/**
 * Merges one article's body-processing result into the archive. `null` clears
 * a field; `undefined` leaves it unchanged. Feed refreshes never call this,
 * so candidate updates cannot overwrite body results.
 */
export async function saveBodyResult(id: string, patch: BodyPatch) {
  const update = async () => {
    const records = await readRecords(true);
    const index = records.findIndex((record) => matches(record, id));
    if (index < 0) return;
    const next: ArticleRecord = { ...records[index] };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      (next as unknown as Record<string, unknown>)[key] =
        value === null ? undefined : value;
    }
    records[index] = next;
    const bounded = enforceCandidateBudget(records);
    memoryRecords = bounded.records;
    try {
      await writeArchive(bounded.records);
    } catch {
      archiveState = "unavailable";
    }
  };
  writeQueue = writeQueue.then(update, update);
  await writeQueue;
}

/** A stored body is served only when this pipeline produced the current one. */
export function isBodyUsable(record: ArticleRecord) {
  if (!record.bodyHtml || !record.bodyVersion) return false;
  const bodyDigest = digest12(record.bodyHtml);
  const supportedVersions = [SANITIZE_VERSION, ...LEGACY_SANITIZE_VERSIONS];
  if (
    !supportedVersions.some(
      (version) => record.bodyVersion === `${version}:${bodyDigest}`,
    )
  )
    return false;
  if (record.bodySource !== "feed" && record.bodySource !== "web")
    return false;
  const source = sources.find((entry) => entry.id === record.item.sourceId);
  if (
    !source ||
    !isBodyMethodAllowed(source, record.item, record.bodySource)
  )
    return false;
  // Feed candidates expire independently from the sanitized body cache. Their
  // absence after the TTL must not make a previously prepared body unreadable.
  // Web bodies remain tied to the registered article URL.
  if (record.bodySource === "feed")
    return (
      !record.candidateDigest ||
      record.bodySourceDigest === record.candidateDigest
    );
  return record.bodySourceDigest === digest12(record.item.link);
}

export async function getRelatedArticles(
  item: FeedItem,
  limit = 3,
  filters: { mutedSourceIds?: Set<string>; mutedTopics?: Set<Topic> } = {},
): Promise<FeedItem[]> {
  const records = await readRecords(true);
  const seenLinks = new Set<string>();
  const candidates = records
    .map((record) => record.item)
    .filter((candidate) => {
      const hasUsableContent = Boolean(
        candidate.title.trim() &&
          candidate.title !== "未提供标题" &&
          (candidate.description.trim() ||
            candidate.contentSnippet?.trim() ||
            candidate.contentType === "video"),
      );
      if (
        !hasUsableContent ||
        !candidate.link ||
        candidate.id === item.id ||
        candidate.topic !== item.topic ||
        filters.mutedSourceIds?.has(candidate.sourceId) ||
        filters.mutedTopics?.has(candidate.topic) ||
        seenLinks.has(candidate.link)
      )
        return false;
      seenLinks.add(candidate.link);
      return true;
    })
    .sort((a, b) => Date.parse(b.pubDate || "") - Date.parse(a.pubDate || ""));
  const uniqueSources: FeedItem[] = [];
  const repeatedSources: FeedItem[] = [];
  const usedSources = new Set<string>();
  for (const candidate of candidates) {
    if (
      candidate.sourceId !== item.sourceId &&
      !usedSources.has(candidate.sourceId)
    ) {
      uniqueSources.push(candidate);
      usedSources.add(candidate.sourceId);
    } else {
      repeatedSources.push(candidate);
    }
  }
  return [...uniqueSources, ...repeatedSources].slice(0, Math.min(limit, 3));
}

/**
 * Builds the public payload. The raw candidate and any HTML that the current
 * pipeline version did not produce stay private; only verified sanitized
 * bodies are exposed.
 */
export function publicArticleRecord(record: ArticleRecord) {
  const {
    bodyCandidate: _privateCandidate,
    candidateStoredAt: _candidateStoredAt,
    candidateTruncated: _candidateTruncated,
    candidateError: _candidateError,
    candidateDigest: _candidateDigest,
    bodySourceDigest: _sourceDigest,
    bodyAttempts: _attempts,
    ...publicRecord
  } = record;
  if (!isBodyUsable(record)) {
    const {
      bodyHtml: _unverifiedHtml,
      bodyVersion: _unverifiedVersion,
      bodyFetchedAt: _unverifiedFetchedAt,
      bodyCompleteness: _unverifiedCompleteness,
      bodySource: _unverifiedSource,
      ...metadataOnly
    } = publicRecord;
    return {
      ...metadataOnly,
      bodyError: record.bodyError,
      bodyNextAttemptAt: record.bodyNextAttemptAt,
    };
  }
  return {
    ...publicRecord,
    bodyError: undefined,
    bodyNextAttemptAt: undefined,
  };
}
