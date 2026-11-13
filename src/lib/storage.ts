import type { KnowledgeNote, ReadingPosition, SavedItem, Topic } from "./types";

const SAVED_V1 = "curio:saved:v1";
const SAVED_V2 = "curio:saved:v2";
const NOTES_V1 = "curio:notes:v1";
const NOTES_V2 = "curio:notes:v2";
const MUTED_KEY = "curio:muted:v1";
const MUTED_SOURCES_KEY = "curio:muted-sources:v1";
const INTERESTS_KEY = "curio:interests:v1";
const POSITIONS_KEY = "curio:reading-positions:v1";
const FONT_SIZE_KEY = "curio:reading-font-size:v1";
const MIGRATION_KEY = "curio:migration:v2";

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    return JSON.parse(localStorage.getItem(key) || "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function write<T>(key: string, value: T) {
  if (typeof window === "undefined") return false;
  try {
    const serialized = JSON.stringify(value);
    localStorage.setItem(key, serialized);
    return localStorage.getItem(key) === serialized;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function safeLegacyArticleId(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1)
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0;
  return `saved-${hash.toString(36)}`;
}

function normalizeSaved(raw: Record<string, unknown>): SavedItem | null {
  const legacyId = typeof raw.id === "string" ? raw.id : "";
  if (!legacyId) return null;
  const id = /^[a-z0-9-]{1,64}$/.test(legacyId)
    ? legacyId
    : safeLegacyArticleId(legacyId);
  const source = typeof raw.source === "string" ? raw.source : "未知来源";
  const link = typeof raw.link === "string" ? raw.link : "";
  const contentType =
    raw.contentType === "video" || /youtube\.com|youtu\.be/i.test(link)
      ? "video"
      : "unknown";
  const topic =
    typeof raw.topic === "string" ? (raw.topic as Topic) : "冷知识与奇闻";
  return {
    ...raw,
    id,
    sourceId:
      typeof raw.sourceId === "string"
        ? raw.sourceId
        : source.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    legacyIds: [
      ...new Set([
        ...(Array.isArray(raw.legacyIds)
          ? raw.legacyIds.filter((v): v is string => typeof v === "string")
          : []),
        legacyId,
      ]),
    ],
    title:
      typeof raw.title === "string" && raw.title.trim()
        ? raw.title
        : "未提供标题",
    link,
    description: typeof raw.description === "string" ? raw.description : "",
    source,
    topic,
    contentType,
    contentStatus: contentType === "video" ? "video" : "summary",
    contentCompleteness: "summary",
    savedAt:
      typeof raw.savedAt === "string" ? raw.savedAt : new Date(0).toISOString(),
  } as SavedItem;
}

function oldNoteToNote(
  raw: Record<string, unknown>,
  index: number,
): KnowledgeNote {
  const originalId = typeof raw.id === "string" ? raw.id : "";
  const identity = JSON.stringify([raw, index]);
  let hash = 2166136261;
  for (let offset = 0; offset < identity.length; offset += 1) {
    hash = Math.imul(hash ^ identity.charCodeAt(offset), 16777619) >>> 0;
  }
  const id = originalId || `legacy-note-${hash.toString(36)}`;
  const takeaway = typeof raw.takeaway === "string" ? raw.takeaway : "";
  const insight = typeof raw.insight === "string" ? raw.insight : "";
  const connection = typeof raw.connection === "string" ? raw.connection : "";
  const dueAt = typeof raw.dueAt === "string" ? raw.dueAt : undefined;
  const interval = typeof raw.interval === "number" ? raw.interval : undefined;
  const reviewedAt =
    typeof raw.reviewedAt === "string" ? raw.reviewedAt : undefined;
  return {
    id,
    legacyId: originalId || undefined,
    title: typeof raw.title === "string" ? raw.title : undefined,
    body: takeaway || (typeof raw.body === "string" ? raw.body : undefined),
    excerpt: typeof raw.excerpt === "string" ? raw.excerpt : undefined,
    sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : undefined,
    createdAt:
      typeof raw.createdAt === "string"
        ? raw.createdAt
        : new Date(0).toISOString(),
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    legacyFields: insight || connection ? { insight, connection } : undefined,
    legacyReview:
      dueAt || interval !== undefined || reviewedAt
        ? { dueAt, interval, reviewedAt }
        : undefined,
  };
}

function noteContent(note: KnowledgeNote) {
  return JSON.stringify([
    note.title || "",
    note.body || "",
    note.excerpt || "",
    note.sourceUrl || "",
  ]);
}

function migratedNotes() {
  const current = asList(read<unknown>(NOTES_V2, [])).map(
    (raw) => raw as unknown as KnowledgeNote,
  );
  const byId = new Map(current.map((note) => [note.id, note]));
  const byLegacyId = new Set(
    current
      .map((note) => note.legacyId)
      .filter((id): id is string => Boolean(id)),
  );
  for (const [index, raw] of asList(read<unknown>(NOTES_V1, [])).entries()) {
    const note = oldNoteToNote(raw, index);
    if (note.legacyId && byLegacyId.has(note.legacyId)) continue;
    const existing = byId.get(note.id);
    if (!existing) {
      byId.set(note.id, note);
      continue;
    }
    if (noteContent(existing) === noteContent(note)) continue;
    const signature = noteContent(note)
      .split("")
      .reduce((hash, char) => (hash * 33 + char.charCodeAt(0)) >>> 0, 5381)
      .toString(36);
    const duplicateId = `${note.id}-legacy-${signature}`;
    if (!byId.has(duplicateId))
      byId.set(duplicateId, { ...note, id: duplicateId, legacyId: note.id });
  }
  return [...byId.values()];
}

function migratedSaved() {
  const current = asList(read<unknown>(SAVED_V2, []))
    .map(normalizeSaved)
    .filter((item): item is SavedItem => Boolean(item));
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const raw of asList(read<unknown>(SAVED_V1, []))) {
    const item = normalizeSaved(raw);
    if (item && !byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

function ensureMigration() {
  if (typeof window === "undefined") return;
  try {
    const marker = JSON.parse(
      localStorage.getItem(MIGRATION_KEY) || "null",
    ) as { version?: number } | null;
    if (marker?.version === 2) return;
  } catch {
    // A corrupt marker is treated as an incomplete migration and safely retried.
  }
  try {
    const saved = migratedSaved();
    const notes = migratedNotes();
    const savedWritten = write(SAVED_V2, saved);
    const savedReadBack = asList(read<unknown>(SAVED_V2, []));
    const savedOk =
      savedWritten &&
      savedReadBack.length === saved.length &&
      savedReadBack.every(
        (entry, index) =>
          JSON.stringify(entry) === JSON.stringify(saved[index]),
      );
    const notesWritten = write(NOTES_V2, notes);
    const notesReadBack = asList(read<unknown>(NOTES_V2, []));
    const notesOk =
      notesWritten &&
      notesReadBack.length === notes.length &&
      notesReadBack.every(
        (entry, index) =>
          JSON.stringify(entry) === JSON.stringify(notes[index]),
      );
    if (savedOk && notesOk)
      write(MIGRATION_KEY, {
        version: 2,
        migratedAt: new Date().toISOString(),
      });
  } catch {
    // Keep reading the untouched v1 keys and retry the idempotent migration later.
  }
}

export const getSaved = () => {
  ensureMigration();
  if (
    typeof window !== "undefined" &&
    isMigrationComplete() &&
    localStorage.getItem(SAVED_V2) !== null
  ) {
    return asList(read<unknown>(SAVED_V2, []))
      .map(normalizeSaved)
      .filter((item): item is SavedItem => Boolean(item));
  }
  return migratedSaved();
};
export const setSaved = (items: SavedItem[]) => write(SAVED_V2, items);

export const getNotes = () => {
  ensureMigration();
  if (
    typeof window !== "undefined" &&
    isMigrationComplete() &&
    localStorage.getItem(NOTES_V2) !== null
  ) {
    return asList(read<unknown>(NOTES_V2, [])) as unknown as KnowledgeNote[];
  }
  return migratedNotes();
};
export const setNotes = (items: KnowledgeNote[]) => write(NOTES_V2, items);

export const getMuted = () => {
  const value = read<unknown>(MUTED_KEY, []);
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};
export const setMuted = (items: string[]) => write(MUTED_KEY, items);
export const getMutedSources = () => {
  const value = read<unknown>(MUTED_SOURCES_KEY, []);
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};
export const setMutedSources = (items: string[]) =>
  write(MUTED_SOURCES_KEY, items);
export const getInterests = () => {
  const value = read<unknown>(INTERESTS_KEY, []);
  return Array.isArray(value)
    ? value.filter((entry): entry is Topic => typeof entry === "string")
    : [];
};
export const setInterests = (items: Topic[]) => write(INTERESTS_KEY, items);
export const getReadingPositions = () => {
  const value = read<unknown>(POSITIONS_KEY, []);
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is ReadingPosition =>
          isRecord(entry) &&
          typeof entry.articleId === "string" &&
          typeof entry.anchor === "string" &&
          typeof entry.offset === "number" &&
          typeof entry.contentVersion === "string" &&
          typeof entry.updatedAt === "string",
      )
    : [];
};
export const setReadingPositions = (items: ReadingPosition[]) =>
  write(POSITIONS_KEY, items);
export const getReadingFontSize = () => {
  const value = read<number>(FONT_SIZE_KEY, 18);
  return Number.isFinite(value) ? Math.max(16, Math.min(24, value)) : 18;
};
export const setReadingFontSize = (value: number) =>
  write(FONT_SIZE_KEY, Math.max(16, Math.min(24, value)));

export const isMigrationComplete = () => {
  if (typeof window === "undefined") return true;
  try {
    return (
      JSON.parse(localStorage.getItem(MIGRATION_KEY) || "null")?.version === 2
    );
  } catch {
    return false;
  }
};
