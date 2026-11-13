"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bookmark, Compass, Lightbulb, Menu, Settings, X } from "lucide-react";
import type {
  FeedItem,
  KnowledgeNote,
  ReadingPosition,
  SavedItem,
  Topic,
} from "@/lib/types";
import { sources, topics } from "@/lib/sources";
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

function reconcileSaved(saved: SavedItem[], feed: FeedItem[]) {
  const byLegacyId = new Map<string, FeedItem>();
  const byLink = new Map<string, FeedItem>();
  for (const item of feed) {
    for (const legacyId of item.legacyIds || []) byLegacyId.set(legacyId, item);
    if (item.link) byLink.set(item.link, item);
  }
  return saved.map((entry) => {
    const match =
      byLegacyId.get(entry.id) ||
      entry.legacyIds?.map((id) => byLegacyId.get(id)).find(Boolean) ||
      byLink.get(entry.link);
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
  const [requestError, setRequestError] = useState(false);
  const [allSourcesFailed, setAllSourcesFailed] = useState(false);
  const [archiveAvailable, setArchiveAvailable] = useState(true);
  const [failedSources, setFailedSources] = useState(0);
  const [failedSourceIds, setFailedSourceIds] = useState<string[]>([]);
  const [updatedAt, setUpdatedAt] = useState("");
  const [query, setQuery] = useState("");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [migrationError, setMigrationError] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [sessionRestored, setSessionRestored] = useState(false);
  const [scrollRestoreY, setScrollRestoreY] = useState<number | null>(null);

  const loadFeed = useCallback(async (refresh = false) => {
    setLoading(true);
    setRequestError(false);
    try {
      const response = await fetch(`/api/feed${refresh ? "?refresh=1" : ""}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("feed_request_failed");
      const data = (await response.json()) as {
        items?: unknown;
        failedSourceCount?: number;
        failedSourceIds?: unknown;
        allSourcesFailed?: boolean;
        updatedAt?: string;
        archiveAvailable?: boolean;
      };
      if (!Array.isArray(data.items)) throw new Error("invalid_feed_response");
      const nextItems = data.items as FeedItem[];
      setItems((current) =>
        data.allSourcesFailed && nextItems.length === 0 && current.length
          ? current
          : nextItems,
      );
      const reconciled = reconcileSaved(getSaved(), nextItems);
      if (JSON.stringify(reconciled) !== JSON.stringify(getSaved()))
        setSaved(reconciled);
      setSavedState(reconciled);
      setFailedSources(
        typeof data.failedSourceCount === "number" ? data.failedSourceCount : 0,
      );
      setFailedSourceIds(
        Array.isArray(data.failedSourceIds)
          ? data.failedSourceIds.filter(
              (id): id is string => typeof id === "string",
            )
          : [],
      );
      setAllSourcesFailed(Boolean(data.allSourcesFailed));
      setArchiveAvailable(data.archiveAvailable !== false);
      if (typeof data.updatedAt === "string" && data.updatedAt)
        setUpdatedAt(data.updatedAt);
    } catch {
      setRequestError(true);
    } finally {
      setLoading(false);
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

  function navigate(path: string) {
    setMobileMenuOpen(false);
    router.push(path, { scroll: false });
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
    <div className="app-layout">
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
          onClick={() => setMobileMenuOpen((open) => !open)}
          aria-label={mobileMenuOpen ? "关闭菜单" : "打开菜单"}
          aria-expanded={mobileMenuOpen}
        >
          {mobileMenuOpen ? <X size={21} /> : <Menu size={21} />}
        </button>
      </header>

      {mobileMenuOpen && (
        <div
          className="mobile-menu-backdrop"
          onMouseDown={(event) =>
            event.target === event.currentTarget && setMobileMenuOpen(false)
          }
        >
          <nav className="mobile-menu" aria-label="页面菜单">
            {navigation.map((entry) => (
              <Link
                key={entry.view}
                href={entry.path}
                scroll={false}
                aria-current={view === entry.view ? "page" : undefined}
                onClick={() => setMobileMenuOpen(false)}
              >
                {entry.icon}
                {entry.label}
              </Link>
            ))}
            <Link
              href="/settings"
              scroll={false}
              onClick={() => setMobileMenuOpen(false)}
            >
              <Settings size={17} aria-hidden="true" />
              设置
            </Link>
          </nav>
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
            activeTopic={activeTopic}
            mutedTopics={muted}
            mutedSourceIds={mutedSources}
            query={query}
            updatedAt={updatedAt}
            saved={saved}
            requestError={requestError}
            allSourcesFailed={allSourcesFailed}
            failedSources={failedSources}
            archiveAvailable={archiveAvailable}
            readingPositions={readingPositions}
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
                const count = sources.filter(
                  (source) => source.topic === topic.name,
                ).length;
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
                发布者网页正文的处理规则尚未逐源核实，目前站内提供订阅摘要；选择“查看原文”可访问发布者页面。
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
                return (
                  <div className="source-status-row" key={source.id}>
                    <strong>{source.name}</strong>
                    <span>
                      {failedSourceIds.includes(source.id)
                        ? "暂时无法更新"
                        : source.kind === "youtube"
                          ? "视频订阅"
                          : "发布者订阅"}
                    </span>
                    <span>
                      {source.kind === "youtube"
                        ? "视频条目与观看入口"
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
