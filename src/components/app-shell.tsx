"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Bookmark,
  Compass,
  Lightbulb,
  Menu,
  Search,
  Settings,
  X,
} from "lucide-react";
import type {
  ArchiveAvailability,
  FeedItem,
  KnowledgeNote,
  ReadingPosition,
  SavedItem,
  Topic,
} from "@/lib/types";
import { feedRoutes, sources, topics } from "@/lib/sources";
import { canonicalArticleUrl } from "@/lib/article-link";
import {
  getInterests,
  getMuted,
  getMutedSources,
  getNotes,
  getReadingPositions,
  getSaved,
  isMigrationComplete,
  setInterests,
  setMuted,
  setMutedSources,
  setNotes,
  setReadingPositions,
  setSaved,
} from "@/lib/storage";
import type { KnowledgeNoteDraft } from "./knowledge-note-modal";
import Dashboard from "./dashboard";
import KnowledgePanel from "./knowledge-panel";
import InterestsPage from "./interests-page";

type View = "discover" | "interests" | "collections" | "notes" | "settings";
const SHELL_STATE_KEY = "curio:session-state:v1";
const routeByView: Record<View, string> = {
  discover: "/",
  interests: "/interests",
  collections: "/collections",
  notes: "/notes",
  settings: "/settings",
};

function getView(pathname: string): View {
  if (pathname === "/interests") return "interests";
  if (pathname === "/collections") return "collections";
  if (pathname === "/notes") return "notes";
  if (pathname === "/settings") return "settings";
  return "discover";
}

function articleLinkKey(sourceId: string, link: string) {
  const canonical = canonicalArticleUrl(link);
  return canonical ? `${sourceId}:${canonical}` : "";
}

function reconcileSaved(saved: SavedItem[], feed: FeedItem[]) {
  const byLegacyId = new Map<string, FeedItem>();
  const byLink = new Map<string, FeedItem>();
  for (const item of feed) {
    for (const legacyId of item.legacyIds || []) byLegacyId.set(legacyId, item);
    if (item.link) byLink.set(articleLinkKey(item.sourceId, item.link), item);
  }
  return saved.map((entry) => {
    const match =
      byLegacyId.get(entry.id) ||
      entry.legacyIds?.map((id) => byLegacyId.get(id)).find(Boolean) ||
      byLink.get(articleLinkKey(entry.sourceId, entry.link));
    return match
      ? {
          ...match,
          savedAt: entry.savedAt,
          legacyIds: [
            ...new Set([
              ...(match.legacyIds || []),
              entry.id,
              ...(entry.legacyIds || []),
            ]),
          ],
        }
      : entry;
  });
}

function reconcileReadingPositions(
  positions: ReadingPosition[],
  saved: SavedItem[],
  feed: FeedItem[],
) {
  const byId = new Map<string, FeedItem>();
  const byLink = new Map<string, FeedItem>();
  for (const item of feed) {
    byId.set(item.id, item);
    for (const legacyId of item.legacyIds || []) byId.set(legacyId, item);
    if (item.link) byLink.set(articleLinkKey(item.sourceId, item.link), item);
  }
  const savedById = new Map<string, SavedItem>();
  for (const item of saved) {
    savedById.set(item.id, item);
    for (const legacyId of item.legacyIds || []) savedById.set(legacyId, item);
  }
  return positions.map((position) => {
    const direct = byId.get(position.articleId);
    const savedItem = savedById.get(position.articleId);
    const match =
      direct ||
      (savedItem
        ? byLink.get(articleLinkKey(savedItem.sourceId, savedItem.link))
        : undefined);
    return match && match.id !== position.articleId
      ? { ...position, articleId: match.id }
      : position;
  });
}

function reconcileNoteArticleIds(
  notes: KnowledgeNote[],
  saved: SavedItem[],
  feed: FeedItem[],
) {
  const byId = new Map<string, FeedItem>();
  const byLink = new Map<string, FeedItem>();
  for (const item of feed) {
    byId.set(item.id, item);
    for (const legacyId of item.legacyIds || []) byId.set(legacyId, item);
    if (item.link) byLink.set(articleLinkKey(item.sourceId, item.link), item);
  }
  const savedById = new Map<string, SavedItem>();
  for (const item of saved) {
    savedById.set(item.id, item);
    for (const legacyId of item.legacyIds || []) savedById.set(legacyId, item);
  }
  return notes.map((note) => {
    const savedItem = note.articleId
      ? savedById.get(note.articleId)
      : undefined;
    let noteSourceId = note.articleId
      ? sources.find((source) => note.articleId?.startsWith(`${source.id}-`))
          ?.id
      : undefined;
    if (!noteSourceId && note.sourceUrl) {
      try {
        const host = new URL(note.sourceUrl).hostname.toLowerCase();
        noteSourceId = sources.find((source) =>
          source.articleHosts.includes(host),
        )?.id;
      } catch {
        /* Leave notes with unregistered source links unchanged. */
      }
    }
    const match =
      (note.articleId ? byId.get(note.articleId) : undefined) ||
      (note.sourceUrl && noteSourceId
        ? byLink.get(articleLinkKey(noteSourceId, note.sourceUrl))
        : undefined) ||
      (savedItem
        ? byLink.get(articleLinkKey(savedItem.sourceId, savedItem.link))
        : undefined);
    return match && note.articleId !== match.id
      ? { ...note, articleId: match.id }
      : note;
  });
}

export default function AppShell() {
  const router = useRouter();
  const pathname = usePathname();
  const view = getView(pathname);
  const [activeTopic, setActiveTopic] = useState<Topic | "全部">("全部");
  const [items, setItems] = useState<FeedItem[]>([]);
  const [saved, setSavedState] = useState<SavedItem[]>([]);
  const [notes, setNotesState] = useState<KnowledgeNote[]>([]);
  const [readingPositions, setReadingPositionsState] = useState<
    ReadingPosition[]
  >([]);
  const [muted, setMutedState] = useState<string[]>([]);
  const [mutedSources, setMutedSourcesState] = useState<string[]>([]);
  const [interests, setInterestsState] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [requestError, setRequestError] = useState(false);
  const [allSourcesFailed, setAllSourcesFailed] = useState(false);
  const [archiveAvailable, setArchiveAvailable] =
    useState<ArchiveAvailability>("unknown");
  const [routeCacheAvailable, setRouteCacheAvailable] =
    useState<ArchiveAvailability>("unknown");
  const [failedRoutes, setFailedRoutes] = useState(0);
  const [failedRoutesWithCachedItems, setFailedRoutesWithCachedItems] =
    useState(0);
  const [failedSourceIds, setFailedSourceIds] = useState<string[]>([]);
  const [partialSourceIds, setPartialSourceIds] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState("");
  const [query, setQuery] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const mobileMenuToggleRef = useRef<HTMLButtonElement>(null);
  const mobileSearchToggleRef = useRef<HTMLButtonElement>(null);
  const mobileSearchInputRef = useRef<HTMLInputElement>(null);
  const [topicFilter, setTopicFilter] = useState<Topic | null>(null);
  const [migrationError, setMigrationError] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [sessionRestored, setSessionRestored] = useState(false);
  const [scrollRestoreY, setScrollRestoreY] = useState<number | null>(null);

  const closeMobileMenu = useCallback(() => {
    setMobileMenuOpen(false);
    window.requestAnimationFrame(() => mobileMenuToggleRef.current?.focus());
  }, []);

  const closeMobileSearch = useCallback(() => {
    setMobileSearchOpen(false);
    window.requestAnimationFrame(() => mobileSearchToggleRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const menu = mobileMenuRef.current;
    const focusable = menu?.querySelector<HTMLElement>("a[href]");
    focusable?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeMobileMenu();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = menu
        ? Array.from(
            menu.querySelectorAll<HTMLElement>(
              "a[href], button:not([disabled])",
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
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileMenuOpen, closeMobileMenu]);

  useEffect(() => {
    if (view !== "discover") {
      setMobileSearchOpen(false);
      return;
    }
    if (!mobileSearchOpen) return;
    mobileSearchInputRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeMobileSearch();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [view, mobileSearchOpen, closeMobileSearch]);

  const feedRequest = useRef(0);
  const feedVersion = useRef(0);
  const feedItems = useRef(items);
  feedItems.current = items;
  const loadFeed = useCallback(async (refresh = false) => {
    const request = ++feedRequest.current;
    setLoading(!feedItems.current.length);
    setUpdating(refresh);
    setRequestError(false);
    try {
      const response = await fetch(
        `/api/feed${refresh ? "?refresh=1" : "?mode=snapshot"}`,
        {
          cache: "no-store",
        },
      );
      if (!response.ok) throw new Error("feed_request_failed");
      const data = (await response.json()) as {
        items?: unknown;
        failedSourceIds?: unknown;
        partialSourceIds?: unknown;
        failedRouteCount?: number;
        failedRoutesWithCachedItems?: number;
        allSourcesFailed?: boolean;
        updatedAt?: string;
        archiveAvailable?: ArchiveAvailability;
        routeCacheAvailable?: ArchiveAvailability;
        updateAvailable?: boolean;
        snapshotVersion?: number;
      };
      if (request !== feedRequest.current) return;
      if (!Array.isArray(data.items)) throw new Error("invalid_feed_response");
      type FeedResponse = typeof data;
      const applyFeed = (data: FeedResponse, showItems: boolean) => {
        if (!Array.isArray(data.items))
          throw new Error("invalid_feed_response");
        if ((data.snapshotVersion || 0) < feedVersion.current) return;
        feedVersion.current = data.snapshotVersion || 0;
        const nextItems = data.items as FeedItem[];
        if (showItems)
          setItems((current) =>
            data.allSourcesFailed && nextItems.length === 0 && current.length
              ? current
              : nextItems,
          );
        const currentSaved = getSaved();
        const reconciled = reconcileSaved(currentSaved, nextItems);
        const savedUnchanged =
          JSON.stringify(reconciled) === JSON.stringify(currentSaved);
        const savedPersisted = savedUnchanged || setSaved(reconciled);
        const savedForMigration = savedPersisted ? reconciled : currentSaved;
        setSavedState(savedForMigration);
        const currentPositions = getReadingPositions();
        const nextPositions = reconcileReadingPositions(
          currentPositions,
          savedForMigration,
          nextItems,
        );
        if (
          JSON.stringify(nextPositions) !== JSON.stringify(currentPositions) &&
          setReadingPositions(nextPositions)
        ) {
          setReadingPositionsState(nextPositions);
        }
        const currentNotes = getNotes();
        const nextNotes = reconcileNoteArticleIds(
          currentNotes,
          savedForMigration,
          nextItems,
        );
        if (
          JSON.stringify(nextNotes) !== JSON.stringify(currentNotes) &&
          setNotes(nextNotes)
        )
          setNotesState(nextNotes);
        setFailedRoutes(
          typeof data.failedRouteCount === "number" ? data.failedRouteCount : 0,
        );
        setFailedRoutesWithCachedItems(
          typeof data.failedRoutesWithCachedItems === "number"
            ? data.failedRoutesWithCachedItems
            : 0,
        );
        setFailedSourceIds(
          Array.isArray(data.failedSourceIds)
            ? data.failedSourceIds.filter(
                (id): id is string => typeof id === "string",
              )
            : [],
        );
        setPartialSourceIds(
          Array.isArray(data.partialSourceIds)
            ? data.partialSourceIds.filter(
                (id): id is string => typeof id === "string",
              )
            : [],
        );
        setAllSourcesFailed(Boolean(data.allSourcesFailed));
        setArchiveAvailable(
          data.archiveAvailable === "available" ||
            data.archiveAvailable === "unavailable"
            ? data.archiveAvailable
            : "unknown",
        );
        setRouteCacheAvailable(
          data.routeCacheAvailable === "available" ||
            data.routeCacheAvailable === "unavailable"
            ? data.routeCacheAvailable
            : "unknown",
        );
        if (typeof data.updatedAt === "string" && data.updatedAt)
          setUpdatedAt(data.updatedAt);
      };
      const nextItems = data.items as FeedItem[];
      applyFeed(data, true);
      if (!refresh && data.updateAvailable) {
        setUpdating(true);
        if (nextItems.length) setLoading(false);
        const update = await fetch("/api/feed", { cache: "no-store" });
        if (!update.ok) throw new Error("feed_update_failed");
        const next = (await update.json()) as FeedResponse;
        if (request !== feedRequest.current) return;
        applyFeed(next, nextItems.length === 0);
      }
    } catch {
      if (request !== feedRequest.current) return;
      setArchiveAvailable("unknown");
      setRequestError(true);
    } finally {
      if (request === feedRequest.current) {
        setLoading(false);
        setUpdating(false);
      }
    }
  }, []);

  useEffect(() => {
    const restoredSaved = getSaved();
    const restoredNotes = getNotes();
    setSavedState(restoredSaved);
    setNotesState(restoredNotes);
    setReadingPositionsState(getReadingPositions());
    setMutedState(getMuted());
    setMutedSourcesState(getMutedSources());
    setInterestsState(getInterests());
    setMigrationError(!isMigrationComplete());
    try {
      const session = JSON.parse(
        sessionStorage.getItem(SHELL_STATE_KEY) || "null",
      ) as {
        activeTopic?: Topic | "全部";
        query?: string;
        scrollY?: number;
        savedAt?: number;
      } | null;
      if (
        session &&
        (session.activeTopic === "全部" ||
          topics.some((topic) => topic.name === session.activeTopic))
      )
        setActiveTopic(session.activeTopic as Topic | "全部");
      if (typeof session?.query === "string") setQuery(session.query);
      if (
        typeof session?.scrollY === "number" &&
        Date.now() - (session.savedAt || 0) < 5 * 60 * 1000
      ) {
        setScrollRestoreY(session.scrollY);
        sessionStorage.setItem(
          SHELL_STATE_KEY,
          JSON.stringify({
            activeTopic: session.activeTopic,
            query: session.query,
          }),
        );
      }
    } catch {
      /* The current view works without session storage. */
    }
    setSessionRestored(true);
    void loadFeed();
  }, [loadFeed]);

  useEffect(() => {
    if (scrollRestoreY === null || loading) return;
    const frame = window.requestAnimationFrame(() => {
      window.scrollTo({ top: scrollRestoreY, behavior: "auto" });
      setScrollRestoreY(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [scrollRestoreY, loading]);

  useEffect(() => {
    if (!sessionRestored) return;
    try {
      const current = JSON.parse(
        sessionStorage.getItem(SHELL_STATE_KEY) || "null",
      ) as { scrollY?: number; savedAt?: number } | null;
      sessionStorage.setItem(
        SHELL_STATE_KEY,
        JSON.stringify({
          activeTopic,
          query,
          scrollY: current?.scrollY,
          savedAt: current?.savedAt,
        }),
      );
    } catch {
      /* The current view works without session storage. */
    }
  }, [activeTopic, query, sessionRestored]);

  useEffect(() => {
    function rememberDiscoveryPosition(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest("a[href^='/read/']");
      if (!link) return;
      try {
        sessionStorage.setItem(
          SHELL_STATE_KEY,
          JSON.stringify({
            activeTopic,
            query,
            scrollY: window.scrollY,
            savedAt: Date.now(),
          }),
        );
      } catch {
        /* Browser session storage is optional. */
      }
    }
    document.addEventListener("click", rememberDiscoveryPosition, true);
    return () =>
      document.removeEventListener("click", rememberDiscoveryPosition, true);
  }, [activeTopic, query]);

  useEffect(() => {
    if (pathname !== "/") return;
    const topic = new URLSearchParams(window.location.search).get("topic");
    if (topic === "全部" || topics.some((entry) => entry.name === topic))
      setActiveTopic(topic as Topic | "全部");
  }, [pathname]);

  useEffect(() => {
    setReadingPositionsState(getReadingPositions());
  }, [pathname]);

  useEffect(() => {
    function syncOnVisible() {
      if (document.visibilityState === "visible")
        setReadingPositionsState(getReadingPositions());
    }
    document.addEventListener("visibilitychange", syncOnVisible);
    return () =>
      document.removeEventListener("visibilitychange", syncOnVisible);
  }, []);

  useEffect(() => {
    function syncFromUrl() {
      if (pathname !== "/collections" && pathname !== "/notes") return;
      const raw = new URLSearchParams(window.location.search).get("topic");
      setTopicFilter(
        topics.some((entry) => entry.name === raw) ? (raw as Topic) : null,
      );
    }
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, [pathname]);

  function navigate(path: string) {
    setMobileMenuOpen(false);
    router.push(path, { scroll: false });
  }

  function clearTopicFilter() {
    setTopicFilter(null);
    router.push(pathname === "/notes" ? "/notes" : "/collections", {
      scroll: false,
    });
  }

  function toggleSave(item: FeedItem) {
    const exists = saved.some(
      (entry) =>
        entry.id === item.id ||
        Boolean(item.link && entry.link === item.link) ||
        item.legacyIds?.some((id) => entry.id === id),
    );
    const next = exists
      ? saved.filter(
          (entry) =>
            !(
              entry.id === item.id ||
              Boolean(item.link && entry.link === item.link) ||
              item.legacyIds?.some((id) => entry.id === id)
            ),
        )
      : [{ ...item, savedAt: new Date().toISOString() }, ...saved];
    if (!setSaved(next)) {
      setStorageError("未能保存收藏，请检查浏览器存储空间后重试。");
      return;
    }
    setStorageError("");
    setActionMessage(exists ? "已取消收藏" : "已收藏");
    setSavedState(next);
  }

  function addNote(draft: KnowledgeNoteDraft) {
    if (!draft.body?.trim() && !draft.excerpt?.trim()) return false;
    const now = new Date().toISOString();
    const next: KnowledgeNote = {
      ...draft,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    const all = [next, ...notes];
    if (!setNotes(all)) return false;
    setNotesState(all);
    return true;
  }

  function toggleMuted(topic: Topic) {
    const next = muted.includes(topic)
      ? muted.filter((name) => name !== topic)
      : [...muted, topic];
    if (!setMuted(next)) {
      setStorageError("未能保存主题设置，请检查浏览器存储空间后重试。");
      return;
    }
    setStorageError("");
    setMutedState(next);
  }

  function toggleMutedSource(sourceId: string) {
    const next = mutedSources.includes(sourceId)
      ? mutedSources.filter((id) => id !== sourceId)
      : [...mutedSources, sourceId];
    if (!setMutedSources(next)) {
      setStorageError("未能保存来源设置，请检查浏览器存储空间后重试。");
      return;
    }
    setStorageError("");
    setMutedSourcesState(next);
  }

  function toggleInterest(topic: Topic) {
    const next = interests.includes(topic)
      ? interests.filter((entry) => entry !== topic)
      : [...interests, topic];
    if (!setInterests(next)) {
      setStorageError("未能保存关注主题，请检查浏览器存储空间后重试。");
      return;
    }
    setStorageError("");
    setInterestsState(next);
  }

  function clearReadingPosition(articleId: string) {
    const next = readingPositions.filter(
      (position) => position.articleId !== articleId,
    );
    if (!setReadingPositions(next)) {
      setStorageError("未能清除阅读位置，请稍后重试。");
      return;
    }
    setStorageError("");
    setReadingPositionsState(next);
  }

  const navigation = useMemo(
    () => [
      {
        view: "discover" as const,
        label: "发现",
        path: routeByView.discover,
        icon: <Compass size={17} aria-hidden="true" />,
      },
      {
        view: "interests" as const,
        label: "兴趣",
        path: routeByView.interests,
        icon: <Lightbulb size={17} aria-hidden="true" />,
      },
      {
        view: "collections" as const,
        label: "收藏",
        path: routeByView.collections,
        icon: <Bookmark size={17} aria-hidden="true" />,
      },
      {
        view: "notes" as const,
        label: "我的知识",
        path: routeByView.notes,
        icon: (
          <span className="nav-knowledge-icon" aria-hidden="true">
            记
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div
      className="app-layout"
      onClickCapture={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const href = target
          .closest<HTMLAnchorElement>('a[href^="/read/"]')
          ?.getAttribute("href");
        if (!href) return;
        const id = decodeURIComponent(href.slice(6).split(/[?#]/)[0]);
        const item = [...items, ...saved].find(
          (entry) => entry.id === id || entry.legacyIds?.includes(id),
        );
        if (item)
          try {
            sessionStorage.setItem(`curio:reader:${id}`, JSON.stringify(item));
          } catch {
            /* Reading still works without session storage. */
          }
      }}
    >
      <header
        className={`topbar${view === "discover" ? " topbar-discovery" : ""}`}
      >
        <Link
          className="brand-name"
          href="/"
          scroll={false}
          aria-label="Curio，发现内容"
        >
          curio
        </Link>
        <nav className="desktop-nav" aria-label="主导航">
          {navigation.map((entry) => (
            <Link
              key={entry.view}
              className={`nav-item${view === entry.view ? " active" : ""}`}
              href={entry.path}
              scroll={false}
              aria-current={view === entry.view ? "page" : undefined}
            >
              {entry.label}
            </Link>
          ))}
        </nav>
        <Link
          className={`settings-link${view === "settings" ? " active" : ""}`}
          href="/settings"
          scroll={false}
          aria-current={view === "settings" ? "page" : undefined}
        >
          <Settings size={17} aria-hidden="true" />
          <span>设置</span>
        </Link>
        <button
          type="button"
          className="mobile-menu-toggle"
          onClick={() =>
            mobileMenuOpen ? closeMobileMenu() : setMobileMenuOpen(true)
          }
          aria-label={mobileMenuOpen ? "关闭菜单" : "打开菜单"}
          aria-expanded={mobileMenuOpen}
          aria-controls={mobileMenuOpen ? "mobile-menu-panel" : undefined}
          ref={mobileMenuToggleRef}
        >
          {mobileMenuOpen ? <X size={21} /> : <Menu size={21} />}
        </button>
        {view === "discover" && (
          <button
            type="button"
            className="mobile-search-toggle"
            onClick={() =>
              mobileSearchOpen ? closeMobileSearch() : setMobileSearchOpen(true)
            }
            aria-label={mobileSearchOpen ? "关闭搜索" : "打开搜索"}
            aria-expanded={mobileSearchOpen}
            aria-controls={mobileSearchOpen ? "mobile-search-panel" : undefined}
            ref={mobileSearchToggleRef}
          >
            {mobileSearchOpen ? (
              <X size={20} aria-hidden="true" />
            ) : (
              <Search size={20} aria-hidden="true" />
            )}
          </button>
        )}
      </header>

      {mobileSearchOpen && view === "discover" && (
        <div className="mobile-search-row" id="mobile-search-panel">
          <form
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              closeMobileSearch();
            }}
          >
            <input
              type="search"
              aria-label="搜索标题、摘要或来源"
              placeholder="搜索标题、摘要或来源"
              value={query}
              ref={mobileSearchInputRef}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                type="button"
                className="icon-button"
                aria-label="清空搜索"
                onClick={() => {
                  setQuery("");
                  mobileSearchInputRef.current?.focus();
                }}
              >
                <X size={17} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="text-action"
              onClick={closeMobileSearch}
            >
              取消
            </button>
          </form>
        </div>
      )}

      {mobileMenuOpen && (
        <div
          className="mobile-menu-backdrop"
          onMouseDown={(event) =>
            event.target === event.currentTarget && closeMobileMenu()
          }
        >
          <div
            className="mobile-menu"
            id="mobile-menu-panel"
            role="dialog"
            aria-modal="true"
            aria-label="页面菜单"
            ref={mobileMenuRef}
          >
            <button
              type="button"
              className="mobile-menu-close"
              aria-label="关闭菜单"
              onClick={closeMobileMenu}
            >
              <X size={20} aria-hidden="true" />
            </button>
            <nav className="mobile-menu-nav" aria-label="常用页面">
              {navigation.map((entry) => (
                <Link
                  key={entry.view}
                  href={entry.path}
                  scroll={false}
                  aria-current={view === entry.view ? "page" : undefined}
                  onClick={closeMobileMenu}
                >
                  {entry.icon}
                  {entry.label}
                </Link>
              ))}
              <Link href="/settings" scroll={false} onClick={closeMobileMenu}>
                <Settings size={17} aria-hidden="true" />
                设置
              </Link>
            </nav>
          </div>
        </div>
      )}

      <main className="page-content">
        {migrationError && (
          <div className="feed-status feed-status-error" role="status">
            旧数据迁移尚未完成；原有收藏和笔记仍保留在浏览器中，请检查存储空间后重试。
          </div>
        )}
        {storageError && (
          <div className="feed-status feed-status-error" role="alert">
            {storageError}
          </div>
        )}
        <span className="sr-only" role="status" aria-live="polite">
          {actionMessage}
        </span>
        <section className="app-view" hidden={view !== "discover"}>
          <Dashboard
            items={items}
            loading={loading}
            updating={updating}
            activeTopic={activeTopic}
            mutedTopics={muted}
            mutedSourceIds={mutedSources}
            query={query}
            updatedAt={updatedAt}
            saved={saved}
            requestError={requestError}
            allSourcesFailed={allSourcesFailed}
            failedRoutes={failedRoutes}
            failedRoutesWithCachedItems={failedRoutesWithCachedItems}
            archiveAvailable={archiveAvailable}
            routeCacheAvailable={routeCacheAvailable}
            readingPositions={readingPositions}
            interests={interests}
            onTopic={setActiveTopic}
            onQuery={setQuery}
            onRefresh={() => void loadFeed(true)}
            onSave={toggleSave}
            onAddNote={addNote}
            onNavigate={navigate}
            onClearReadingPosition={clearReadingPosition}
          />
        </section>
        <section className="app-view" hidden={view !== "interests"}>
          <InterestsPage
            interests={interests}
            mutedTopics={muted}
            saved={saved}
            notes={notes}
            feedItems={items}
            onToggleInterest={toggleInterest}
          />
        </section>
        <section className="app-view" hidden={view !== "collections"}>
          <KnowledgePanel
            mode="saved"
            saved={saved}
            notes={notes}
            feedItems={items}
            topicFilter={topicFilter}
            onClearTopicFilter={clearTopicFilter}
            onSave={toggleSave}
            onAddNote={addNote}
            onNavigate={navigate}
          />
        </section>
        <section className="app-view" hidden={view !== "notes"}>
          <KnowledgePanel
            mode="knowledge"
            saved={saved}
            notes={notes}
            feedItems={items}
            topicFilter={topicFilter}
            onClearTopicFilter={clearTopicFilter}
            onSave={toggleSave}
            onAddNote={addNote}
            onNavigate={navigate}
          />
        </section>
        <section className="app-view" hidden={view !== "settings"}>
          <section className="settings-page" aria-labelledby="settings-title">
            <h1 id="settings-title">设置</h1>
            <p className="settings-help">
              隐藏主题会从发现页和随便看看中移除。
            </p>
            <div className="settings-topic-list">
              {topics.map((topic) => {
                const hidden = muted.includes(topic.name);
                const count = new Set(
                  feedRoutes
                    .filter((route) => route.topic === topic.name)
                    .map((route) => route.sourceId),
                ).size;
                return (
                  <div className="settings-topic" key={topic.name}>
                    <div className="settings-topic-copy">
                      <strong>{topic.name}</strong>
                      <p>{topic.description}</p>
                      <span className="topic-source-status">
                        {count ? `${count} 个订阅源` : "暂未配置订阅源"}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="button-secondary"
                      role="switch"
                      aria-checked={!hidden}
                      aria-label={`${hidden ? "显示" : "隐藏"}${topic.name}`}
                      onClick={() => toggleMuted(topic.name)}
                    >
                      {hidden ? "已隐藏" : "显示中"}
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="settings-information">
              <p>
                普通文章仅在来源规则与原文样本核验后展示正文；视频和交互作品保留原类型与原站入口。
              </p>
              <p>
                收藏、笔记、主题与来源设置、阅读位置保存在当前浏览器，不会跨设备同步。
              </p>
              <p>
                文章记录保存在 Curio
                服务端的数据目录；部署时需要持久化磁盘和单实例 Node 服务。
              </p>
            </div>
            <section
              className="source-status-list"
              aria-labelledby="source-status-title"
            >
              <h2 id="source-status-title">内容来源</h2>
              <p>隐藏的来源会从发现和随便看看中移除。</p>
              {sources.map((source) => {
                const hidden = mutedSources.includes(source.id);
                const sourceRoutes = feedRoutes.filter(
                  (route) => route.sourceId === source.id,
                );
                return (
                  <div className="source-status-row" key={source.id}>
                    <strong>{source.name}</strong>
                    <span>
                      {!sourceRoutes.length
                        ? "已停止更新"
                        : failedSourceIds.includes(source.id)
                          ? "暂时无法更新"
                          : partialSourceIds.includes(source.id)
                            ? "有栏目暂时无法更新"
                            : source.kind === "youtube"
                              ? "视频订阅"
                              : "发布者订阅"}
                    </span>
                    <span>
                      {!sourceRoutes.length
                        ? "已保存的文章仍可访问"
                        : source.kind === "youtube"
                          ? "视频条目与观看入口"
                          : source.bodyPolicy === "feed"
                            ? "订阅正文已核验，站内展示正文"
                            : source.bodyPolicy === "web"
                              ? "网页正文提取已核验，站内展示正文"
                              : "站内仅显示摘要"}
                    </span>
                    <button
                      type="button"
                      className="button-secondary"
                      aria-pressed={!hidden}
                      aria-label={`${hidden ? "显示" : "隐藏"}${source.name}来源`}
                      onClick={() => toggleMutedSource(source.id)}
                    >
                      {hidden ? "已隐藏" : "显示中"}
                    </button>
                  </div>
                );
              })}
            </section>
          </section>
        </section>
      </main>

      <nav className="mobile-bottom-nav" aria-label="常用页面">
        {navigation.map((entry) => (
          <Link
            key={entry.view}
            className={`mobile-nav-item${view === entry.view ? " active" : ""}`}
            href={entry.path}
            scroll={false}
            aria-current={view === entry.view ? "page" : undefined}
          >
            {entry.icon}
            <span>{entry.label}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
