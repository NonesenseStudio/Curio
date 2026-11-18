"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import Link from "next/link";
import { ChevronDown, RefreshCw, Search, X } from "lucide-react";
import type {
  ArchiveAvailability,
  FeedItem,
  ReadingPosition,
  SavedItem,
  Topic,
} from "@/lib/types";
import { feedRoutes, topics } from "@/lib/sources";
import { isSafeHttpsImage, safeYouTubeUrl } from "@/lib/safe-url";
import { formatDate, formatDateTime } from "@/lib/format-date";
import ArticleRow from "./article-row";
import KnowledgeNoteModal, {
  type KnowledgeNoteDraft,
} from "./knowledge-note-modal";

type Props = {
  items: FeedItem[];
  loading: boolean;
  updating: boolean;
  activeTopic: Topic | "全部";
  mutedTopics: string[];
  mutedSourceIds: string[];
  query: string;
  updatedAt: string;
  saved: SavedItem[];
  requestError: boolean;
  allSourcesFailed: boolean;
  failedRoutes: number;
  failedRoutesWithCachedItems: number;
  archiveAvailable: ArchiveAvailability;
  routeCacheAvailable: ArchiveAvailability;
  readingPositions: ReadingPosition[];
  interests: Topic[];
  onTopic: (topic: Topic | "全部") => void;
  onQuery: (query: string) => void;
  onRefresh: () => void;
  onSave: (item: FeedItem) => void;
  onAddNote: (note: KnowledgeNoteDraft) => boolean;
  onNavigate: (path: string) => void;
  onClearReadingPosition: (articleId: string) => void;
};

type RoamState = { seed: number; seenIds: string[]; ids: string[] };
const ROAM_KEY = "curio:roam:v1";
const DASHBOARD_KEY = "curio:discovery-view:v1";

function uniqueItems(items: FeedItem[]) {
  const seenIds = new Set<string>();
  const seenLinks = new Set<string>();
  return items.filter((item) => {
    if (
      !item.id ||
      seenIds.has(item.id) ||
      (item.link && seenLinks.has(item.link))
    )
      return false;
    seenIds.add(item.id);
    if (item.link) seenLinks.add(item.link);
    return true;
  });
}

function hasUsefulContent(item: FeedItem) {
  const title = item.title.trim();
  return Boolean(
    item.id &&
    title &&
    title !== "未提供标题" &&
    (item.description.trim() ||
      item.contentSnippet?.trim() ||
      item.contentType === "video"),
  );
}

function chooseMagazine(
  items: FeedItem[],
  existingIds: string[] = [],
  interests: Topic[] = [],
) {
  const candidates = uniqueItems(items).filter(hasUsefulContent);
  const byId = new Map(candidates.map((item) => [item.id, item]));
  const picked = [...new Set(existingIds)]
    .map((id) => byId.get(id))
    .filter((item): item is FeedItem => Boolean(item))
    .slice(0, 3);
  const quality = (item: FeedItem) =>
    (item.contentCompleteness === "complete"
      ? 4
      : item.contentCompleteness === "partial"
        ? 2
        : 0) +
    (item.imageQuality === "declared"
      ? 2
      : item.imageQuality === "medium"
        ? 1
        : 0) +
    ((item.description || item.contentSnippet || "").trim().length >= 80
      ? 1
      : 0);
  const ranked = [...candidates].sort(
    (a, b) =>
      quality(b) - quality(a) ||
      new Date(b.pubDate || 0).getTime() - new Date(a.pubDate || 0).getTime(),
  );
  const pickBest = (pool: FeedItem[]) => {
    const diverse = pool.findIndex((candidate) =>
      picked.every(
        (entry) =>
          entry.topic !== candidate.topic &&
          entry.sourceId !== candidate.sourceId,
      ),
    );
    const differentSource = pool.findIndex((candidate) =>
      picked.every((entry) => entry.sourceId !== candidate.sourceId),
    );
    return pool.splice(
      diverse >= 0 ? diverse : differentSource >= 0 ? differentSource : 0,
      1,
    )[0];
  };
  // Explicit, explainable preference: at most two followed-topic picks and
  // at least one other-topic pick when candidates allow; hidden rules and
  // quality thresholds are already applied upstream.
  const alreadyPicked = new Set(picked.map((item) => item.id));
  const followedPool = ranked.filter(
    (item) => interests.includes(item.topic) && !alreadyPicked.has(item.id),
  );
  const otherPool = ranked.filter(
    (item) => !interests.includes(item.topic) && !alreadyPicked.has(item.id),
  );
  while (picked.length < 3) {
    const followedCount = picked.filter((entry) =>
      interests.includes(entry.topic),
    ).length;
    const otherCount = picked.length - followedCount;
    if (otherCount === 0 && otherPool.length) {
      picked.push(pickBest(otherPool));
    } else if (followedCount < 2 && followedPool.length) {
      picked.push(pickBest(followedPool));
    } else {
      const pool = otherPool.length ? otherPool : followedPool;
      if (!pool.length) break;
      picked.push(pickBest(pool));
    }
  }
  return picked.map((item) => item.id);
}

function rank(seed: number, value: string) {
  let hash = seed >>> 0;
  for (let i = 0; i < value.length; i += 1)
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619) >>> 0;
  return hash;
}

function chooseRoam(items: FeedItem[], seenIds: string[], seed: number) {
  const candidates = uniqueItems(items).filter(
    (item) => hasUsefulContent(item) && !seenIds.includes(item.id),
  );
  const ranked = [...candidates].sort(
    (a, b) => rank(seed, a.id) - rank(seed, b.id),
  );
  const picked: FeedItem[] = [];
  while (ranked.length && picked.length < 3) {
    const index = ranked.findIndex((candidate) =>
      picked.every(
        (entry) =>
          entry.topic !== candidate.topic &&
          entry.sourceId !== candidate.sourceId,
      ),
    );
    picked.push(ranked.splice(index < 0 ? 0 : index, 1)[0]);
  }
  return picked.map((item) => item.id);
}

function readRoam(): RoamState | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(ROAM_KEY) || "null");
    if (
      parsed &&
      Array.isArray(parsed.seenIds) &&
      Array.isArray(parsed.ids) &&
      typeof parsed.seed === "number"
    )
      return parsed as RoamState;
  } catch {
    /* Private browsing may block session storage. */
  }
  return null;
}

function saveRoam(state: RoamState) {
  try {
    sessionStorage.setItem(ROAM_KEY, JSON.stringify(state));
  } catch {
    /* The current view still works without persistence. */
  }
}

/**
 * Feed images render inside fixed aspect-ratio placeholders so a failed or
 * slow image never shifts the layout. Slot size follows the declared image
 * quality: unknown or low-resolution images never occupy the full hero slot.
 */
function ImageFigure({
  item,
  variant,
}: {
  item: FeedItem;
  variant: "lead" | "companion" | "roam-primary" | "roam";
}) {
  const [failedImage, setFailedImage] = useState("");
  const image = isSafeHttpsImage(item.image) ? item.image : undefined;
  if (!image || failedImage === image) return null;
  const quality = item.imageQuality || "unknown";
  const heroEligible = quality === "declared";
  if (variant === "lead" && !heroEligible) return null;
  const figureClass =
    variant === "lead" && !heroEligible
      ? "story-figure lead-figure lead-figure-small"
      : variant === "roam-primary" && !heroEligible
        ? "story-figure roam-figure-small"
        : "story-figure";
  const linkClass =
    variant === "lead"
      ? heroEligible
        ? "lead-image"
        : "lead-image lead-image-small"
      : variant === "roam-primary"
        ? heroEligible
          ? "roam-image"
          : "roam-image roam-image-small"
        : variant === "companion"
          ? "companion-image"
          : "roam-image";
  return (
    <figure className={figureClass}>
      <Link
        href={`/read/${encodeURIComponent(item.id)}`}
        className={linkClass}
        aria-label={`阅读文章：${item.title}`}
      >
        <img
          src={image}
          alt=""
          onError={() => setFailedImage(image)}
          loading={variant === "lead" ? undefined : "lazy"}
          fetchPriority={variant === "lead" ? "high" : undefined}
        />
      </Link>
      {item.imageCredit && <figcaption>{item.imageCredit}</figcaption>}
    </figure>
  );
}

/**
 * Mobile bottom sheet with focus handling: focus moves into the panel on
 * open, Escape closes it, and focus returns to the trigger on close.
 */
function MobileSheet({
  label,
  onClose,
  returnFocusRef,
  children,
}: {
  label: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const focusable =
      panelRef.current?.querySelector<HTMLElement>(".sheet-option-list button") ||
      panelRef.current?.querySelector<HTMLElement>("button, a, [tabindex]");
    focusable?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      const nodes = panel
        ? Array.from(
            panel.querySelectorAll<HTMLElement>(
              'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
            ),
          )
        : [];
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      returnFocusRef.current?.focus();
    };
  }, [onClose, returnFocusRef]);
  return (
    <div
      className="sheet-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="sheet-panel"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        ref={panelRef}
      >
        <div className="sheet-head">
          <strong>{label}</strong>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export default function Dashboard({
  items,
  loading,
  updating,
  activeTopic,
  mutedTopics,
  mutedSourceIds,
  query,
  updatedAt,
  saved,
  requestError,
  allSourcesFailed,
  failedRoutes,
  failedRoutesWithCachedItems,
  archiveAvailable,
  routeCacheAvailable,
  readingPositions,
  interests,
  onTopic,
  onQuery,
  onRefresh,
  onSave,
  onAddNote,
  onNavigate,
  onClearReadingPosition,
}: Props) {
  const [visibleCount, setVisibleCount] = useState(15);
  const [listMode, setListMode] = useState(false);
  const [roamMode, setRoamMode] = useState(false);
  const [roamState, setRoamState] = useState<RoamState | null>(null);
  const [noteItem, setNoteItem] = useState<FeedItem | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [archivedContinueItems, setArchivedContinueItems] = useState<
    Record<string, FeedItem>
  >({});
  const [viewRestored, setViewRestored] = useState(false);
  const [topicSheetOpen, setTopicSheetOpen] = useState(false);
  const [moreSheetOpen, setMoreSheetOpen] = useState(false);
  const topicTriggerRef = useRef<HTMLButtonElement>(null);
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const closeTopicSheet = useCallback(() => {
    setTopicSheetOpen(false);
    window.requestAnimationFrame(() => topicTriggerRef.current?.focus());
  }, []);
  const closeMoreSheet = useCallback(() => {
    setMoreSheetOpen(false);
    window.requestAnimationFrame(() => moreTriggerRef.current?.focus());
  }, []);
  const [magazineIds, setMagazineIds] = useState<string[]>([]);
  const [magazineKey, setMagazineKey] = useState("");
  const savedIds = useMemo(
    () => new Set(saved.map((item) => item.id)),
    [saved],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleItems = useMemo(
    () =>
      uniqueItems(items).filter(
        (item) =>
          !mutedTopics.includes(item.topic) &&
          !mutedSourceIds.includes(item.sourceId) &&
          (activeTopic === "全部" || item.topic === activeTopic) &&
          (!normalizedQuery ||
            `${item.title} ${item.description} ${item.source}`
              .toLocaleLowerCase()
              .includes(normalizedQuery)),
      ),
    [items, mutedTopics, mutedSourceIds, activeTopic, normalizedQuery],
  );
  const magazineViewKey = JSON.stringify({
    topic: activeTopic,
    query: normalizedQuery,
    mutedTopics: [...mutedTopics].sort(),
    mutedSourceIds: [...mutedSourceIds].sort(),
    interests: [...interests].sort(),
  });
  const magazineCandidates = useMemo(
    () => visibleItems.filter(hasUsefulContent),
    [visibleItems],
  );
  const shownItems = visibleItems.slice(0, visibleCount);
  const magazineItems = (
    magazineKey === magazineViewKey
      ? magazineIds
      : chooseMagazine(magazineCandidates)
  )
    .map((id) => magazineCandidates.find((item) => item.id === id))
    .filter((item): item is FeedItem => Boolean(item));
  const magazineIdSet = new Set(magazineItems.map((item) => item.id));
  const latestPreviewItems = visibleItems
    .filter((item) => !magazineIdSet.has(item.id))
    .slice(0, 3);
  const roamCandidates = magazineCandidates;
  const roamItems = useMemo(() => {
    if (!roamState) return [];
    return roamState.ids
      .map((id) => magazineCandidates.find((item) => item.id === id))
      .filter((item): item is FeedItem => Boolean(item));
  }, [roamState, magazineCandidates]);
  const continueEntries = useMemo(
    () =>
      [...readingPositions]
        .sort(
          (a, b) =>
            new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        )
        .slice(0, 2),
    [readingPositions],
  );
  const findContinueMeta = (id: string) =>
    [...items, ...saved, ...Object.values(archivedContinueItems)].find(
      (entry) => entry.id === id || entry.legacyIds?.includes(id),
    );
  const allTopicsHidden = topics.every((topic) =>
    mutedTopics.includes(topic.name),
  );
  const matchingSourceIds = new Set(
    feedRoutes
      .filter((route) => activeTopic === "全部" || route.topic === activeTopic)
      .map((route) => route.sourceId),
  );
  const topicConfigured = matchingSourceIds.size > 0;
  const hasAvailableSource = [...matchingSourceIds].some(
    (sourceId) => !mutedSourceIds.includes(sourceId),
  );
  const canBrowse =
    !allTopicsHidden &&
    !mutedTopics.includes(activeTopic) &&
    topicConfigured &&
    hasAvailableSource;

  useEffect(() => {
    try {
      const stored = JSON.parse(
        sessionStorage.getItem(DASHBOARD_KEY) || "null",
      ) as {
        listMode?: boolean;
        roamMode?: boolean;
        visibleCount?: number;
        magazineIds?: string[];
        magazineKey?: string;
      } | null;
      if (typeof stored?.listMode === "boolean") setListMode(stored.listMode);
      if (typeof stored?.roamMode === "boolean") setRoamMode(stored.roamMode);
      if (typeof stored?.visibleCount === "number")
        setVisibleCount(Math.max(15, Math.min(300, stored.visibleCount)));
      if (Array.isArray(stored?.magazineIds))
        setMagazineIds(
          stored.magazineIds.filter(
            (id): id is string => typeof id === "string",
          ),
        );
      if (typeof stored?.magazineKey === "string")
        setMagazineKey(stored.magazineKey);
    } catch {
      /* The current page works without session storage. */
    }
    setViewRestored(true);
  }, []);

  useEffect(() => {
    if (!viewRestored) return;
    try {
      sessionStorage.setItem(
        DASHBOARD_KEY,
        JSON.stringify({
          listMode,
          roamMode,
          visibleCount,
          magazineIds,
          magazineKey,
        }),
      );
    } catch {
      /* The current page works without session storage. */
    }
  }, [
    listMode,
    roamMode,
    visibleCount,
    magazineIds,
    magazineKey,
    viewRestored,
  ]);

  useEffect(() => {
    if (!viewRestored || loading) return;
    const existing = magazineKey === magazineViewKey ? magazineIds : [];
    const next = chooseMagazine(magazineCandidates, existing, interests);
    if (
      magazineKey !== magazineViewKey ||
      next.join("\u0000") !== magazineIds.join("\u0000")
    ) {
      setMagazineKey(magazineViewKey);
      setMagazineIds(next);
    }
  }, [
    interests,
    viewRestored,
    loading,
    magazineCandidates,
    magazineIds,
    magazineKey,
    magazineViewKey,
  ]);

  useEffect(() => {
    const missing = continueEntries
      .map((entry) => entry.articleId)
      .filter(
        (id) =>
          ![...items, ...saved].some(
            (item) => item.id === id || item.legacyIds?.includes(id),
          ) && !archivedContinueItems[id],
      );
    if (!missing.length) return;
    const controller = new AbortController();
    void Promise.all(
      missing.map((id) =>
        fetch(`/api/articles/${encodeURIComponent(id)}`, {
          cache: "no-store",
          signal: controller.signal,
        })
          .then(async (response) =>
            response.ok
              ? ((await response.json()) as { item?: FeedItem })
              : null,
          )
          .then((data): [string, FeedItem] | null =>
            data?.item ? [id, data.item] : null,
          )
          .catch(() => null),
      ),
    ).then((pairs) => {
      const found = Object.fromEntries(
        pairs.filter((pair): pair is [string, FeedItem] => pair !== null),
      );
      if (Object.keys(found).length)
        setArchivedContinueItems((current) => ({ ...current, ...found }));
    });
    return () => controller.abort();
  }, [archivedContinueItems, continueEntries, items, saved]);

  useEffect(() => {
    if (loading || magazineCandidates.length === 0) return;
    const stored = readRoam();
    if (!roamState && stored) {
      const restored = {
        ...stored,
        ids: stored.ids.filter((id) =>
          magazineCandidates.some((item) => item.id === id),
        ),
      };
      setRoamState(restored);
      if (restored.ids.length !== stored.ids.length) saveRoam(restored);
      return;
    }
    const current = roamState || stored;
    if (current) {
      const availableIds = current.ids.filter((id) =>
        magazineCandidates.some((item) => item.id === id),
      );
      if (
        availableIds.length === current.ids.length &&
        current.ids.every((id, index) => id === availableIds[index])
      )
        return;
      const next = { ...current, ids: availableIds };
      saveRoam(next);
      setRoamState(next);
      return;
    }
    const next = {
      seed: Math.floor(Math.random() * 0xffffffff),
      seenIds: [],
      ids: [],
    };
    saveRoam(next);
    setRoamState(next);
  }, [loading, magazineCandidates, roamState]);

  function startRoaming(reset = false) {
    const previous = roamState || readRoam();
    const seed =
      reset || !previous
        ? Math.floor(Math.random() * 0xffffffff)
        : previous.seed;
    const seenIds = reset ? [] : previous?.seenIds || [];
    const ids = chooseRoam(roamCandidates, seenIds, seed);
    const next = { seed, seenIds: [...new Set([...seenIds, ...ids])], ids };
    setRoamState(next);
    saveRoam(next);
    setRoamMode(true);
  }

  function createNote(item: FeedItem) {
    setNoteItem(item);
    setNoteOpen(true);
  }

  const lead = magazineItems[0];
  const companions = magazineItems.slice(1);

  return (
    <div className="discovery-page">
      <div className="discovery-toolbar">
        <div className="topic-tabs" aria-label="按主题浏览">
          <button
            type="button"
            className={activeTopic === "全部" ? "selected" : ""}
            aria-pressed={activeTopic === "全部"}
            onClick={() => onTopic("全部")}
          >
            全部
          </button>
          {topics.map((topic) => (
            <button
              type="button"
              key={topic.name}
              className={activeTopic === topic.name ? "selected" : ""}
              aria-pressed={activeTopic === topic.name}
              onClick={() => onTopic(topic.name)}
            >
              {topic.name}
              {mutedTopics.includes(topic.name) ? " · 已隐藏" : ""}
            </button>
          ))}
        </div>
        <form
          className="discovery-search"
          onSubmit={(event) => event.preventDefault()}
          role="search"
        >
          <Search size={17} aria-hidden="true" />
          <input
            aria-label="搜索标题、摘要或来源"
            placeholder="搜索标题、摘要或来源"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
          {query && (
            <button
              type="button"
              aria-label="清除搜索"
              onClick={() => onQuery("")}
            >
              <X size={16} />
            </button>
          )}
        </form>
      </div>

      <div className="discovery-actions">
        <button
          type="button"
          className="button-primary"
          onClick={() => startRoaming()}
          disabled={loading || magazineCandidates.length === 0}
        >
          随便看看
        </button>
        <button
          type="button"
          className={
            !listMode ? "button-secondary active-choice" : "button-secondary"
          }
          aria-pressed={!listMode}
          onClick={() => {
            setListMode(false);
            setRoamMode(false);
          }}
        >
          发现内容
        </button>
        <button
          type="button"
          className={
            listMode ? "button-secondary active-choice" : "button-secondary"
          }
          aria-pressed={listMode}
          onClick={() => {
            setListMode(true);
            setRoamMode(false);
          }}
        >
          最新内容
        </button>
        <button
          type="button"
          className="button-quiet refresh-action"
          onClick={onRefresh}
          disabled={loading || updating}
          aria-label={loading || updating ? "正在更新内容" : "刷新内容"}
        >
          <RefreshCw
            size={16}
            className={loading || updating ? "refresh-icon-spin" : undefined}
            aria-hidden="true"
          />
          {loading || updating ? "正在更新内容…" : "刷新"}
        </button>
        {updatedAt && (
          <span className="feed-updated">
            最近成功更新 {formatDateTime(updatedAt)}
          </span>
        )}
      </div>

      <div className="discovery-mobile-row">
        <button
          type="button"
          className="mobile-control"
          onClick={() => setTopicSheetOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={topicSheetOpen}
          ref={topicTriggerRef}
        >
          {activeTopic === "全部" ? "全部主题" : activeTopic}
          <ChevronDown size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="button-primary mobile-control"
          onClick={() => startRoaming()}
          disabled={loading || magazineCandidates.length === 0}
        >
          随便看看
        </button>
        <button
          type="button"
          className="mobile-control"
          onClick={() => setMoreSheetOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={moreSheetOpen}
          ref={moreTriggerRef}
        >
          更多
        </button>
      </div>
      {requestError && (
        <div className="feed-status feed-status-error" role="alert">
          {items.length
            ? "暂时无法更新内容，正在显示上次保存的文章"
            : "暂时无法加载内容"}
          <button className="text-action" type="button" onClick={onRefresh}>
            重试更新
          </button>
        </div>
      )}
      {!requestError && allSourcesFailed && (
        <div className="feed-status feed-status-error" role="alert">
          {items.length
            ? "暂时无法更新内容，正在显示上次保存的文章"
            : "暂时没有可显示的内容"}
          <button className="text-action" type="button" onClick={onRefresh}>
            重试更新
          </button>
        </div>
      )}
      {!allSourcesFailed && failedRoutes > 0 && (
        <div className="feed-status" role="status">
          {failedRoutesWithCachedItems > 0
            ? "部分来源暂时无法更新，已保留上次内容"
            : `${failedRoutes} 个订阅栏目暂时无法更新`}
          <button className="text-action" type="button" onClick={onRefresh}>
            重试更新
          </button>
        </div>
      )}
      {archiveAvailable === "unavailable" && (
        <div className="feed-status feed-status-error" role="status">
          内容已获取，但暂时无法保存到服务器。刷新或重启后可能无法恢复。
        </div>
      )}
      {archiveAvailable === "available" &&
        routeCacheAvailable === "unavailable" && (
          <div className="feed-status feed-status-error" role="status">
            文章已保存，但更新记录无法保存；服务重启后可能重新获取。
          </div>
        )}

      {!canBrowse && !loading ? (
        <div className="feed-empty">
          <h2>
            {allTopicsHidden
              ? "所有主题均已隐藏"
              : activeTopic !== "全部" && mutedTopics.includes(activeTopic)
                ? "此主题已隐藏"
                : !topicConfigured
                  ? "此主题尚未配置内容来源"
                  : activeTopic === "全部"
                    ? "所有内容来源均已隐藏"
                    : "此主题的来源均已隐藏"}
          </h2>
          <button
            type="button"
            className="button-secondary"
            onClick={() => onNavigate("/settings")}
          >
            管理内容设置
          </button>
        </div>
      ) : normalizedQuery ? (
        <section
          className="result-section"
          aria-labelledby="search-results-title"
        >
          <header className="section-heading">
            <h2 id="search-results-title">搜索结果</h2>
            <span>{visibleItems.length} 篇</span>
          </header>
          {visibleItems.length ? (
            <div className="feed-list">
              {shownItems.map((item) => (
                <ArticleRow
                  key={item.id}
                  item={item}
                  saved={savedIds.has(item.id)}
                  showTopic={activeTopic === "全部"}
                  onSave={onSave}
                  onCreateNote={createNote}
                />
              ))}
            </div>
          ) : (
            <div className="feed-empty">
              <h2>没有找到匹配的文章</h2>
              <p>试试其他标题、摘要或来源。</p>
            </div>
          )}
          {visibleCount < visibleItems.length && (
            <button
              type="button"
              className="button-secondary load-more"
              onClick={() =>
                setVisibleCount((count) =>
                  Math.min(count + 15, visibleItems.length),
                )
              }
            >
              加载更多（还剩 {visibleItems.length - visibleCount} 篇）
            </button>
          )}
        </section>
      ) : roamMode ? (
        <section className="roam-section" aria-labelledby="roam-title">
          <header className="section-heading">
            <h2 id="roam-title">随便看看</h2>
            <button
              type="button"
              className="button-secondary"
              onClick={() => startRoaming()}
            >
              换一组
            </button>
          </header>
          {roamItems.length ? (
            <div className="roam-grid">
              {roamItems.map((item, index) => (
                <article
                  className={
                    index === 0 ? "roam-card roam-primary" : "roam-card"
                  }
                  key={item.id}
                >
                  <ImageFigure
                    item={item}
                    variant={index === 0 ? "roam-primary" : "roam"}
                  />
                  <div className="article-meta">
                    <span>{item.topic}</span>
                    <span aria-hidden="true">·</span>
                    <span>{item.source}</span>
                  </div>
                  <h3>
                    <Link href={`/read/${encodeURIComponent(item.id)}`}>
                      {item.title}
                    </Link>
                  </h3>
                  {item.description && <p>{item.description}</p>}
                  <div className="article-actions">
                    <Link
                      className="text-action"
                      href={`/read/${encodeURIComponent(item.id)}`}
                    >
                      {item.contentType === "video"
                        ? item.description
                          ? "查看视频简介"
                          : "查看视频信息"
                        : "阅读文章"}
                    </Link>
                    {item.contentType === "video" &&
                      safeYouTubeUrl(item.link) && (
                        <a
                          className="text-action"
                          href={safeYouTubeUrl(item.link)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          前往 YouTube 观看
                        </a>
                      )}
                    <button
                      type="button"
                      className="text-action"
                      onClick={() => onSave(item)}
                      aria-label={
                        savedIds.has(item.id)
                          ? `取消收藏：${item.title}`
                          : `收藏：${item.title}`
                      }
                    >
                      {savedIds.has(item.id) ? "已收藏" : "收藏"}
                    </button>
                    <button
                      type="button"
                      className="text-action"
                      onClick={() => createNote(item)}
                    >
                      写笔记
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="feed-empty">
              <h2>
                {roamCandidates.length === 0
                  ? "暂时没有可供漫游的内容"
                  : roamCandidates.some(
                        (item) => !roamState?.seenIds.includes(item.id),
                      )
                    ? "换一组内容继续浏览"
                    : "这批内容已看过"}
              </h2>
              {roamCandidates.length > 0 && (
                <button
                  type="button"
                  className="button-primary"
                  onClick={() => startRoaming(true)}
                >
                  重新选择
                </button>
              )}
            </div>
          )}
          <button
            type="button"
            className="text-action return-action"
            onClick={() => setRoamMode(false)}
          >
            返回发现
          </button>
        </section>
      ) : listMode ? (
        <section className="result-section" aria-labelledby="latest-title">
          <header className="section-heading">
            <h2 id="latest-title">最新内容</h2>
            <span>{visibleItems.length} 篇</span>
          </header>
          {visibleItems.length ? (
            <div className="feed-list">
              {shownItems.map((item) => (
                <ArticleRow
                  key={item.id}
                  item={item}
                  saved={savedIds.has(item.id)}
                  showTopic={activeTopic === "全部"}
                  onSave={onSave}
                  onCreateNote={createNote}
                />
              ))}
            </div>
          ) : (
            <div className="feed-empty">
              <h2>{loading ? "正在获取内容" : "暂时没有可显示的内容"}</h2>
              {!loading && (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={onRefresh}
                >
                  重试更新
                </button>
              )}
            </div>
          )}
          {visibleCount < visibleItems.length && (
            <button
              type="button"
              className="button-secondary load-more"
              onClick={() =>
                setVisibleCount((count) =>
                  Math.min(count + 15, visibleItems.length),
                )
              }
            >
              加载更多（还剩 {visibleItems.length - visibleCount} 篇）
            </button>
          )}
        </section>
      ) : (
        <>
          {lead ? (
            <section className="magazine-grid" aria-label="最新文章">
              <article className="lead-story">
                <ImageFigure item={lead} variant="lead" />
                <div className="article-meta">
                  <span>{lead.topic}</span>
                  <span aria-hidden="true">·</span>
                  <span>{lead.source}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatDate(lead.pubDate)}</span>
                </div>
                <h2>
                  <Link href={`/read/${encodeURIComponent(lead.id)}`}>
                    {lead.title}
                  </Link>
                </h2>
                {lead.description && (
                  <p className="lead-description">{lead.description}</p>
                )}
                <div className="article-actions">
                  {lead.contentType === "video" &&
                    safeYouTubeUrl(lead.link) && (
                      <a
                        className="text-action"
                        href={safeYouTubeUrl(lead.link)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        前往 YouTube 观看
                      </a>
                    )}
                  <button
                    type="button"
                    className="text-action"
                    onClick={() => onSave(lead)}
                    aria-label={
                      savedIds.has(lead.id)
                        ? `取消收藏：${lead.title}`
                        : `收藏：${lead.title}`
                    }
                  >
                    {savedIds.has(lead.id) ? "已收藏" : "收藏"}
                  </button>
                  <button
                    type="button"
                    className="text-action"
                    onClick={() => createNote(lead)}
                  >
                    写笔记
                  </button>
                </div>
              </article>
              <div className="companion-stories">
                {companions.map((item, companionIndex) => (
                  <article
                    className={`companion-story${companionIndex === 1 ? " companion-story-compact" : ""}`}
                    key={item.id}
                  >
                    <div className="article-meta">
                      <span>{item.topic}</span>
                      <span aria-hidden="true">·</span>
                      <span>{item.source}</span>
                    </div>
                    <h3>
                      <Link href={`/read/${encodeURIComponent(item.id)}`}>
                        {item.title}
                      </Link>
                    </h3>
                    {item.description && <p>{item.description}</p>}
                  </article>
                ))}
              </div>
            </section>
          ) : (
            <div className="feed-empty">
              <h2>{loading ? "正在获取内容" : "暂时没有可显示的内容"}</h2>
              {!loading && (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={onRefresh}
                >
                  重试更新
                </button>
              )}
            </div>
          )}
          {latestPreviewItems.length > 0 && (
            <section className="result-section latest-preview">
              <header className="section-heading">
                <h2>最新内容</h2>
                <button
                  type="button"
                  className="text-action"
                  onClick={() => setListMode(true)}
                >
                  查看全部
                </button>
              </header>
              <div className="feed-list">
                {latestPreviewItems.map((item) => (
                  <ArticleRow
                    key={item.id}
                    item={item}
                    saved={savedIds.has(item.id)}
                    showTopic={activeTopic === "全部"}
                    onSave={onSave}
                    onCreateNote={createNote}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {updatedAt && (
        <p className="feed-updated-line">
          最近成功更新 {formatDateTime(updatedAt)}
        </p>
      )}
      {interests.length > 0 && (
        <p className="interest-help">关注的主题会优先出现在发现页中。</p>
      )}
      {continueEntries.length > 0 && (
        <section
          className="continue-reading"
          aria-labelledby="continue-reading-title"
        >
          <h2 id="continue-reading-title">继续阅读</h2>
          <div className="continue-reading-list">
            {continueEntries.map((position) => {
              const meta = findContinueMeta(position.articleId);
              return (
                <div
                  className="continue-reading-item"
                  key={position.articleId}
                >
                  <Link
                    href={`/read/${encodeURIComponent(position.articleId)}`}
                  >
                    {meta?.title || "打开上次阅读的文章"}
                  </Link>
                  <p>上次打开于 {formatDateTime(position.updatedAt)}</p>
                  <button
                    type="button"
                    className="text-action"
                    onClick={() => onClearReadingPosition(position.articleId)}
                  >
                    从继续阅读中移除
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <KnowledgeNoteModal
        open={noteOpen}
        initial={
          noteItem
            ? {
                title: noteItem.title,
                sourceUrl: noteItem.link,
                articleId: noteItem.id,
                topic: noteItem.topic,
              }
            : undefined
        }
        onCancel={() => setNoteOpen(false)}
        onSave={onAddNote}
      />
      {topicSheetOpen && (
        <MobileSheet
          label="选择主题"
          onClose={closeTopicSheet}
          returnFocusRef={topicTriggerRef}
        >
          <div className="sheet-option-list">
            <button
              type="button"
              className={activeTopic === "全部" ? "selected" : ""}
              aria-pressed={activeTopic === "全部"}
              onClick={() => {
                onTopic("全部");
                closeTopicSheet();
              }}
            >
              全部主题
            </button>
            {topics.map((topic) => (
              <button
                type="button"
                key={topic.name}
                className={activeTopic === topic.name ? "selected" : ""}
                aria-pressed={activeTopic === topic.name}
                onClick={() => {
                  onTopic(topic.name);
                closeTopicSheet();
                }}
              >
                {topic.name}
                {mutedTopics.includes(topic.name) ? " · 已隐藏" : ""}
              </button>
            ))}
          </div>
        </MobileSheet>
      )}
      {moreSheetOpen && (
        <MobileSheet
          label="更多选项"
          onClose={closeMoreSheet}
          returnFocusRef={moreTriggerRef}
        >
          <div className="sheet-option-list">
            <button
              type="button"
              aria-pressed={listMode}
              onClick={() => {
                setListMode(true);
                setRoamMode(false);
                closeMoreSheet();
              }}
            >
              {listMode ? "按最新排序 · 当前" : "按最新排序"}
            </button>
            {listMode && (
              <button
                type="button"
                onClick={() => {
                  setListMode(false);
                  setRoamMode(false);
                  closeMoreSheet();
                }}
              >
                返回发现编排
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onRefresh();
                closeMoreSheet();
              }}
            >
              刷新内容
            </button>
          </div>
        </MobileSheet>
      )}
    </div>
  );
}
