"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { RefreshCw, Search, X } from "lucide-react";
import type { FeedItem, ReadingPosition, SavedItem, Topic } from "@/lib/types";
import { sources, topics } from "@/lib/sources";
import { isSafeHttpsImage, safeYouTubeUrl } from "@/lib/safe-url";
import { formatDate, formatDateTime } from "@/lib/format-date";
import ArticleRow from "./article-row";
import KnowledgeNoteModal, {
  type KnowledgeNoteDraft,
} from "./knowledge-note-modal";

type Props = {
  items: FeedItem[];
  loading: boolean;
  activeTopic: Topic | "全部";
  mutedTopics: string[];
  mutedSourceIds: string[];
  query: string;
  updatedAt: string;
  saved: SavedItem[];
  requestError: boolean;
  allSourcesFailed: boolean;
  failedSources: number;
  archiveAvailable: boolean;
  readingPositions: ReadingPosition[];
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

function chooseMagazine(items: FeedItem[], existingIds: string[] = []) {
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
    (isSafeHttpsImage(item.image) ? 2 : 0) +
    ((item.description || item.contentSnippet || "").trim().length >= 80
      ? 1
      : 0);
  const ranked = [...candidates].sort(
    (a, b) =>
      quality(b) - quality(a) ||
      new Date(b.pubDate || 0).getTime() - new Date(a.pubDate || 0).getTime(),
  );
  while (ranked.length && picked.length < 3) {
    const diverse = ranked.findIndex((candidate) =>
      picked.every(
        (entry) =>
          entry.topic !== candidate.topic &&
          entry.sourceId !== candidate.sourceId,
      ),
    );
    const differentSource = ranked.findIndex((candidate) =>
      picked.every((entry) => entry.sourceId !== candidate.sourceId),
    );
    picked.push(
      ranked.splice(
        diverse >= 0 ? diverse : differentSource >= 0 ? differentSource : 0,
        1,
      )[0],
    );
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

export default function Dashboard({
  items,
  loading,
  activeTopic,
  mutedTopics,
  mutedSourceIds,
  query,
  updatedAt,
  saved,
  requestError,
  allSourcesFailed,
  failedSources,
  archiveAvailable,
  readingPositions,
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
  const [archivedContinueItem, setArchivedContinueItem] =
    useState<FeedItem | null>(null);
  const [viewRestored, setViewRestored] = useState(false);
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
  const latestPosition = useMemo(
    () =>
      [...readingPositions].sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      )[0],
    [readingPositions],
  );
  const continueItem = latestPosition
    ? [...items, ...saved].find(
        (item) =>
          item.id === latestPosition.articleId ||
          item.legacyIds?.includes(latestPosition.articleId),
      ) ||
      (archivedContinueItem?.id === latestPosition.articleId ||
      archivedContinueItem?.legacyIds?.includes(latestPosition.articleId)
        ? archivedContinueItem
        : null)
    : null;
  const allTopicsHidden = topics.every((topic) =>
    mutedTopics.includes(topic.name),
  );
  const matchingSources = sources.filter(
    (source) => activeTopic === "全部" || source.topic === activeTopic,
  );
  const topicConfigured = matchingSources.length > 0;
  const hasAvailableSource = matchingSources.some(
    (source) => !mutedSourceIds.includes(source.id),
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
    const next = chooseMagazine(magazineCandidates, existing);
    if (
      magazineKey !== magazineViewKey ||
      next.join("\u0000") !== magazineIds.join("\u0000")
    ) {
      setMagazineKey(magazineViewKey);
      setMagazineIds(next);
    }
  }, [
    viewRestored,
    loading,
    magazineCandidates,
    magazineIds,
    magazineKey,
    magazineViewKey,
  ]);

  useEffect(() => {
    if (!latestPosition) {
      setArchivedContinueItem(null);
      return;
    }
    if (
      [...items, ...saved].some(
        (item) =>
          item.id === latestPosition.articleId ||
          item.legacyIds?.includes(latestPosition.articleId),
      )
    )
      return;
    const controller = new AbortController();
    void fetch(
      `/api/articles/${encodeURIComponent(latestPosition.articleId)}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) =>
        response.ok ? ((await response.json()) as { item?: FeedItem }) : null,
      )
      .then((data) => {
        if (data?.item) setArchivedContinueItem(data.item);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [latestPosition?.articleId, items, saved]);

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
      <section className="magazine-masthead" aria-label="Curio">
        <h1>curio</h1>
      </section>

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
          disabled={loading}
          aria-label={loading ? "正在刷新内容" : "刷新内容"}
        >
          <RefreshCw
            size={16}
            className={loading ? "refresh-icon-spin" : undefined}
            aria-hidden="true"
          />
          {loading ? "正在刷新…" : "刷新"}
        </button>
        {updatedAt && (
          <span className="feed-updated">
            更新于 {formatDateTime(updatedAt)}
          </span>
        )}
      </div>

      {requestError && (
        <div className="feed-status feed-status-error" role="alert">
          内容加载失败
          <button className="text-action" type="button" onClick={onRefresh}>
            重新加载
          </button>
        </div>
      )}
      {!requestError && allSourcesFailed && (
        <div className="feed-status feed-status-error" role="alert">
          {items.length
            ? "暂时无法更新内容，当前显示上次成功获取的文章。"
            : "暂时无法更新内容。"}
          <button className="text-action" type="button" onClick={onRefresh}>
            重试
          </button>
        </div>
      )}
      {!allSourcesFailed && failedSources > 0 && (
        <div className="feed-status" role="status">
          {failedSources} 个来源暂时无法更新
          <button className="text-action" type="button" onClick={onRefresh}>
            重试
          </button>
        </div>
      )}
      {!archiveAvailable && (
        <div className="feed-status feed-status-error" role="status">
          文章记录无法写入服务端存储；服务重启后，部分阅读链接可能无法恢复。
        </div>
      )}

      {loading && items.length === 0 ? (
        <p className="loading-label">正在加载内容…</p>
      ) : null}

      {latestPosition && (
        <section
          className="continue-reading"
          aria-labelledby="continue-reading-title"
        >
          <div>
            <h2 id="continue-reading-title">继续阅读</h2>
            <p>上次打开于 {formatDateTime(latestPosition.updatedAt)}</p>
          </div>
          <Link href={`/read/${encodeURIComponent(latestPosition.articleId)}`}>
            {continueItem?.title || "打开上次阅读的文章"}
          </Link>
          <button
            type="button"
            className="text-action"
            onClick={() => onClearReadingPosition(latestPosition.articleId)}
          >
            从继续阅读中移除
          </button>
        </section>
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
                  {isSafeHttpsImage(item.image) && (
                    <figure className="story-figure">
                      <Link
                        href={`/read/${encodeURIComponent(item.id)}`}
                        className="roam-image"
                        aria-label={`阅读文章：${item.title}`}
                      >
                        <img src={item.image} alt="" loading="lazy" />
                      </Link>
                      {item.imageCredit && (
                        <figcaption>{item.imageCredit}</figcaption>
                      )}
                    </figure>
                  )}
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
              <h2>{loading ? "正在获取内容" : "暂时没有文章"}</h2>
              {!loading && (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={onRefresh}
                >
                  刷新
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
                {isSafeHttpsImage(lead.image) && (
                  <figure className="story-figure lead-figure">
                    <Link
                      href={`/read/${encodeURIComponent(lead.id)}`}
                      className="lead-image"
                      aria-label={`阅读文章：${lead.title}`}
                    >
                      <img src={lead.image} alt="" fetchPriority="high" />
                    </Link>
                    {lead.imageCredit && (
                      <figcaption>{lead.imageCredit}</figcaption>
                    )}
                  </figure>
                )}
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
                  <Link
                    className="text-action"
                    href={`/read/${encodeURIComponent(lead.id)}`}
                  >
                    {lead.contentType === "video"
                      ? lead.description
                        ? "查看视频简介"
                        : "查看视频信息"
                      : "阅读文章"}
                  </Link>
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
                {companions.map((item) => (
                  <article className="companion-story" key={item.id}>
                    {isSafeHttpsImage(item.image) && (
                      <figure className="story-figure">
                        <Link
                          className="companion-image"
                          href={`/read/${encodeURIComponent(item.id)}`}
                          aria-label={`阅读文章：${item.title}`}
                        >
                          <img src={item.image} alt="" loading="lazy" />
                        </Link>
                        {item.imageCredit && (
                          <figcaption>{item.imageCredit}</figcaption>
                        )}
                      </figure>
                    )}
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
              <h2>{loading ? "正在获取内容" : "暂时没有文章"}</h2>
              {!loading && (
                <button
                  type="button"
                  className="button-secondary"
                  onClick={onRefresh}
                >
                  刷新
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
    </div>
  );
}
