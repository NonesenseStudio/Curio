import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ArticleRecord, FeedItem, Topic } from "@/lib/types";

const MAX_RECORDS = 5000;
const MAX_CANDIDATE_CHARS = 64 * 1024;
const CANDIDATE_TTL_MS = 24 * 60 * 60 * 1000;
const dataDirectory =
  process.env.CURIO_DATA_DIR || path.join(process.cwd(), ".curio-data");
const storePath = path.join(dataDirectory, "articles-v1.json");

let writeQueue: Promise<void> = Promise.resolve();
let memoryRecords: ArticleRecord[] = [];
let archiveAvailable = true;

async function writeArchive(values: ArticleRecord[]) {
  await mkdir(dataDirectory, { recursive: true });
  const temporaryPath = `${storePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(values), "utf8");
  await rename(temporaryPath, storePath);
  archiveAvailable = true;
}

async function readRecords(pruneExpired = false): Promise<ArticleRecord[]> {
  let diskRecords: ArticleRecord[] = [];
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed))
      diskRecords = parsed.filter(
        (entry): entry is ArticleRecord =>
          Boolean(entry) &&
          typeof entry === "object" &&
          "item" in entry &&
          Boolean((entry as ArticleRecord).item?.id),
      );
  } catch {
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
      ...metadata
    } = record;
    return metadata;
  });
  if (changed) {
    memoryRecords = fresh;
    const prune = () =>
      writeArchive(fresh).catch(() => {
        archiveAvailable = false;
      });
    writeQueue = writeQueue.then(prune, prune);
    await writeQueue;
  }
  return fresh;
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
) {
  const update = async () => {
    const records = await readRecords();
    const byId = new Map(records.map((record) => [record.item.id, record]));
    const now = Date.now();
    for (const item of items) {
      const old = byId.get(item.id);
      const existingCandidateIsFresh = Boolean(
        old?.candidateStoredAt &&
        now - new Date(old.candidateStoredAt).getTime() < CANDIDATE_TTL_MS,
      );
      const candidate = candidates.get(item.id);
      const nextCandidate = candidate
        ? candidate.slice(0, MAX_CANDIDATE_CHARS)
        : existingCandidateIsFresh
          ? old?.bodyCandidate
          : undefined;
      byId.delete(item.id);
      byId.set(item.id, {
        ...old,
        item,
        bodyCandidate: nextCandidate,
        candidateStoredAt: nextCandidate
          ? candidate
            ? new Date(now).toISOString()
            : old?.candidateStoredAt
          : undefined,
      });
    }
    const values = [...byId.values()]
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
          ...metadata
        } = record;
        return metadata;
      })
      .slice(-MAX_RECORDS);
    memoryRecords = values;
    try {
      await writeArchive(values);
    } catch {
      archiveAvailable = false;
    }
  };

  writeQueue = writeQueue.then(update, update);
  await writeQueue;
  return archiveAvailable;
}

export function isArticleArchiveAvailable() {
  return archiveAvailable;
}

export async function getArticleRecord(
  id: string,
): Promise<ArticleRecord | undefined> {
  const records = await readRecords(true);
  return records.find((record) => matches(record, id));
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

export function publicArticleRecord(record: ArticleRecord) {
  const {
    bodyCandidate: _privateCandidate,
    candidateStoredAt: _candidateStoredAt,
    bodyHtml: _unverifiedHtml,
    ...publicRecord
  } = record;
  return publicRecord;
}
