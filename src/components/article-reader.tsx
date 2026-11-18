"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  Bookmark,
  BookmarkCheck,
  Minus,
  Plus,
  Type,
} from "lucide-react";
import type {
  ArticleRecord,
  FeedItem,
  KnowledgeNote,
  ReadingPosition,
  SavedItem,
} from "@/lib/types";
import { formatDate } from "@/lib/format-date";
import { isSafeHttpsImage, safeYouTubeUrl } from "@/lib/safe-url";
import {
  getNotes,
  getMuted,
  getMutedSources,
  getReadingFontSize,
  getReadingPositions,
  getSaved,
  setNotes,
  setReadingFontSize,
  setReadingPositions,
  setSaved,
} from "@/lib/storage";
import type { KnowledgeNoteDraft } from "./knowledge-note-modal";
import KnowledgeNoteModal from "./knowledge-note-modal";

type BodyState = {
  hasBody: boolean;
  completeness: "unknown" | "complete" | "partial" | "summary";
  bodyVersion?: string;
  preparable?: boolean;
};

type ReaderPayload = ArticleRecord & {
  related?: FeedItem[];
  bodyState?: BodyState;
};

type PrepareState =
  | "not-needed"
  | "preparing"
  | "failed"
  | "restricted"
  | "summary"
  | "video"
  | "interactive";

type Props = { articleId: string };

const MAX_TRACKED_POSITIONS = 20;
const SAVE_DEBOUNCE_MS = 800;
/** Per-mille (0–1000) progress inside the anchored block. */
const READING_LINE_RATIO = 0.35;

function validOriginal(link: string) {
  try {
    const url = new URL(link);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : "";
  } catch {
    return "";
  }
}

export default function ArticleReader({ articleId }: Props) {
  const router = useRouter();
  const [payload, setPayload] = useState<ReaderPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [retryArticle, setRetryArticle] = useState(0);
  const [bodyRetryAt, setBodyRetryAt] = useState(0);
  const [bodyRetryReady, setBodyRetryReady] = useState(true);
  const [saved, setSavedState] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState<
    Partial<KnowledgeNoteDraft> | undefined
  >();
  const [selectedText, setSelectedText] = useState("");
  const [fontSize, setFontSize] = useState(18);
  const [storageError, setStorageError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [bodyHtml, setBodyHtml] = useState<string | null>(null);
  const [bodyVersion, setBodyVersion] = useState("");
  const [prepareState, setPrepareState] = useState<PrepareState>("not-needed");
  const [bodyNotice, setBodyNotice] = useState("");
  const [positionNotice, setPositionNotice] = useState("");
  const [positionSaveFailed, setPositionSaveFailed] = useState(false);
  const [fontPanelOpen, setFontPanelOpen] = useState(false);
  const [failedFeatureImage, setFailedFeatureImage] = useState("");

  const readerBody = useRef<HTMLElement | null>(null);
  const canReturnInApp = useRef(false);
  const requestToken = useRef(0);
  const restoreToken = useRef(0);
  const restoreDone = useRef(false);
  const userScrolledFar = useRef(false);
  const restoreAssetCleanup = useRef<(() => void) | null>(null);
  const pendingSave = useRef<number | null>(null);
  const pendingPosition = useRef<ReadingPosition | null>(null);
  const endRemoved = useRef(false);
  const fontTrigger = useRef<HTMLButtonElement | null>(null);

  const item =
    payload?.item &&
    (payload.item.id === articleId ||
      payload.item.legacyIds?.includes(articleId))
      ? payload.item
      : undefined;
  const original = item ? validOriginal(item.link) : "";
  const videoOriginal =
    item?.contentType === "video" ? safeYouTubeUrl(item.link) : "";
  const outboundUrl =
    item?.contentType === "video" && videoOriginal ? "" : original;
  const featureImage =
    item && isSafeHttpsImage(item.image) && item.image !== failedFeatureImage
      ? item.image
      : undefined;

  const loadLocalItem = useCallback(() => {
    const local = getSaved().find(
      (entry) => entry.id === articleId || entry.legacyIds?.includes(articleId),
    );
    if (local) {
      setPayload({ item: local, related: [] });
      setSavedState(true);
      setPrepareState(
        local.contentType === "video"
          ? "video"
          : local.contentType === "interactive"
            ? "interactive"
            : "summary",
      );
      return true;
    }
    try {
      const candidate = JSON.parse(
        sessionStorage.getItem(`curio:reader:${articleId}`) || "null",
      ) as FeedItem | null;
      if (
        candidate &&
        candidate.id === articleId &&
        typeof candidate.title === "string"
      ) {
        setPayload({ item: candidate, related: [] });
        return true;
      }
    } catch {
      /* The article can still be loaded from the server. */
    }
    return false;
  }, [articleId]);

  const applyPreparedArticle = useCallback((article: ReaderPayload) => {
    const nextBody = article.bodyHtml || null;
    const version = article.bodyVersion || "";
    setPayload(article);
    setBodyHtml(nextBody);
    setBodyVersion(version);
    if (nextBody) {
      setPrepareState("not-needed");
      setBodyNotice(
        article.bodyCompleteness === "partial"
          ? "当前仅获取到部分内容，缺失段落未作补写；可查看原文对照。"
          : article.bodyCompleteness === "unknown"
            ? "内容完整性未知；可查看原文对照阅读。"
            : "",
      );
    } else {
      setPrepareState("summary");
    }
  }, []);

  const prepareBody = useCallback(
    async (token: number) => {
      setPrepareState("preparing");
      try {
        const response = await fetch(
          `/api/articles/${encodeURIComponent(articleId)}/content`,
          { method: "POST", cache: "no-store" },
        );
        const data = (await response.json().catch(() => null)) as {
          status?: string;
          article?: ReaderPayload;
          reason?: string;
          retryAfterSeconds?: number;
        } | null;
        if (token !== requestToken.current) return;
        if (response.ok && data?.status === "ok" && data.article) {
          applyPreparedArticle({
            ...data.article,
            item: {
              ...data.article.item,
              contentStatus: "readable",
              contentCompleteness: data.article.bodyCompleteness || "unknown",
            },
          });
          return;
        }
        if (data?.status === "restricted") setPrepareState("restricted");
        else if (data?.status === "video") setPrepareState("video");
        else if (data?.status === "interactive") setPrepareState("interactive");
        else if (data?.status === "summary" || response.status === 409)
          setPrepareState("summary");
        else {
          setBodyRetryAt(
            Date.now() + Math.max(0, data?.retryAfterSeconds || 0) * 1000,
          );
          setBodyRetryReady(!data?.retryAfterSeconds);
          setPrepareState("failed");
        }
      } catch {
        if (token === requestToken.current) setPrepareState("failed");
      }
    },
    [articleId, applyPreparedArticle],
  );

  useEffect(() => {
    try {
      canReturnInApp.current = Boolean(
        document.referrer &&
        new URL(document.referrer).origin === window.location.origin,
      );
    } catch {
      canReturnInApp.current = false;
    }
    const token = ++requestToken.current;
    restoreToken.current += 1;
    restoreAssetCleanup.current?.();
    restoreAssetCleanup.current = null;
    const controller = new AbortController();
    const relatedFilters = new URLSearchParams();
    getMutedSources().forEach((sourceId) =>
      relatedFilters.append("mutedSource", sourceId),
    );
    getMuted().forEach((topic) => relatedFilters.append("mutedTopic", topic));
    const filterQuery = relatedFilters.toString();
    setFailed(false);
    setNotFound(false);
    setPayload(null);
    setBodyHtml(null);
    setBodyVersion("");
    setPrepareState("not-needed");
    setBodyNotice("");
    setPositionNotice("");
    restoreDone.current = false;
    userScrolledFar.current = false;
    endRemoved.current = false;
    pendingPosition.current = null;
    const hasLocalCopy = loadLocalItem();
    setLoading(!hasLocalCopy);
    const articleUrl = `/api/articles/${encodeURIComponent(articleId)}`;
    const params = new URLSearchParams(filterQuery);
    const fetchArticle = (recover: boolean) => {
      const query = new URLSearchParams(params);
      if (recover) query.set("recover", "1");
      return fetch(`${articleUrl}?${query}`, {
        cache: "no-store",
        signal: controller.signal,
      });
    };
    void fetchArticle(false)
      .then(async (response) => {
        if (response.status === 404 && !articleId.startsWith("saved-"))
          response = await fetchArticle(true);
        if (response.status === 404) throw new Error("article_not_found");
        if (!response.ok) throw new Error("article_unavailable");
        return (await response.json()) as ReaderPayload;
      })
      .then((data) => {
        if (token !== requestToken.current) return;
        setPayload(data);
        const version = data.bodyState?.bodyVersion || data.bodyVersion || "";
        setBodyVersion(version);
        if (data.bodyHtml) {
          setBodyHtml(data.bodyHtml);
          setBodyNotice(
            data.bodyCompleteness === "partial"
              ? "当前仅获取到部分内容，缺失段落未作补写；可查看原文对照。"
              : data.bodyCompleteness === "unknown"
                ? "内容完整性未知；可查看原文对照阅读。"
                : "",
          );
        } else if (data.bodyState?.preparable) {
          void prepareBody(token);
        } else if (data.item.contentType === "video") {
          setPrepareState("video");
        } else if (data.item.contentType === "interactive") {
          setPrepareState("interactive");
        } else {
          setPrepareState("summary");
        }
        const current = getSaved();
        setSavedState(
          current.some(
            (entry) =>
              entry.id === data.item.id ||
              Boolean(data.item.link && entry.link === data.item.link) ||
              entry.legacyIds?.includes(articleId),
          ),
        );
      })
      .catch((error: Error) => {
        if (token === requestToken.current && !loadLocalItem()) {
          setNotFound(error.message === "article_not_found");
          setFailed(true);
        } else if (token === requestToken.current) setFailed(true);
      })
      .finally(() => {
        if (token === requestToken.current) setLoading(false);
      });
    return () => {
      requestToken.current += 1;
      controller.abort();
      restoreAssetCleanup.current?.();
      restoreAssetCleanup.current = null;
    };
  }, [articleId, loadLocalItem, prepareBody, retryArticle]);

  useEffect(() => setFontSize(getReadingFontSize()), []);

  useEffect(() => {
    if (bodyRetryReady) return;
    const timer = window.setTimeout(
      () => setBodyRetryReady(true),
      Math.max(0, bodyRetryAt - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [bodyRetryAt, bodyRetryReady]);

  useEffect(() => {
    if (!fontPanelOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setFontPanelOpen(false);
        fontTrigger.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [fontPanelOpen]);

  useEffect(() => {
    function updateSelection() {
      const selection = window.getSelection()?.toString().trim() || "";
      setSelectedText(
        selection &&
          readerBody.current?.contains(
            window.getSelection()?.anchorNode || null,
          )
          ? selection
          : "",
      );
    }
    document.addEventListener("selectionchange", updateSelection);
    return () =>
      document.removeEventListener("selectionchange", updateSelection);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Reading position tracking (R2)                                    */
  /* ---------------------------------------------------------------- */

  const bodyBlocks = useCallback(() => {
    const container = readerBody.current;
    if (!container) return [] as HTMLElement[];
    return Array.from(container.querySelectorAll<HTMLElement>("[data-qf]"));
  }, []);

  const computePosition = useCallback((): ReadingPosition | null => {
    if (!bodyHtml || !bodyVersion || !item) return null;
    const blocks = bodyBlocks();
    if (!blocks.length) return null;
    const line = window.innerHeight * READING_LINE_RATIO;
    let target = blocks[blocks.length - 1];
    for (const block of blocks) {
      if (block.getBoundingClientRect().bottom >= line) {
        target = block;
        break;
      }
    }
    const rect = target.getBoundingClientRect();
    const ratio = rect.height
      ? Math.max(0, Math.min(1, (line - rect.top) / rect.height))
      : 0;
    const fingerprint = target.dataset.qf || "";
    if (!fingerprint) return null;
    const index = blocks.indexOf(target);
    const previous = index > 0 ? blocks[index - 1].dataset.qf : undefined;
    return {
      articleId: item.id,
      anchor: previous ? `${fingerprint}:${previous}` : fingerprint,
      offset: Math.round(ratio * 1000),
      contentVersion: bodyVersion,
      updatedAt: new Date().toISOString(),
    };
  }, [bodyBlocks, bodyHtml, bodyVersion, item]);

  const writePosition = useCallback((position: ReadingPosition | null) => {
    if (!position) return false;
    const others = getReadingPositions().filter(
      (entry) => entry.articleId !== position.articleId,
    );
    const next = [position, ...others].slice(0, MAX_TRACKED_POSITIONS);
    if (!setReadingPositions(next)) return false;
    setPositionSaveFailed(false);
    return true;
  }, []);

  const scheduleSave = useCallback(() => {
    if (pendingSave.current) window.clearTimeout(pendingSave.current);
    pendingSave.current = window.setTimeout(() => {
      pendingSave.current = null;
      const position = computePosition();
      if (!position) return;
      pendingPosition.current = position;
      if (!writePosition(position) && !positionSaveFailed)
        setPositionSaveFailed(true);
    }, SAVE_DEBOUNCE_MS);
  }, [computePosition, positionSaveFailed, writePosition]);

  const locateAnchor = useCallback(
    (anchor: string, offset: number) => {
      const blocks = bodyBlocks();
      if (!blocks.length) return null;
      const [target, previous] = anchor.split(":");
      const matches = blocks.filter((block) => block.dataset.qf === target);
      let element: HTMLElement | undefined = previous
        ? matches.find((block) => {
            const index = blocks.indexOf(block);
            return blocks[index - 1]?.dataset.qf === previous;
          }) || matches[0]
        : matches[0];
      let usedFallback = false;
      if (!element && previous) {
        element = blocks.find((block) => block.dataset.qf === previous);
        usedFallback = Boolean(element);
      }
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const within = (Math.max(0, Math.min(1000, offset)) / 1000) * rect.height;
      return {
        element,
        top: rect.top + window.scrollY + within,
        usedFallback,
      };
    },
    [bodyBlocks],
  );

  /** Loads only images above the saved block before restoring its position. */
  const waitForBodyAssets = useCallback(
    async (position?: ReadingPosition) => {
      const container = readerBody.current;
      if (!container || !position) return [] as HTMLImageElement[];
      const target = locateAnchor(position.anchor, position.offset);
      if (!target) return [] as HTMLImageElement[];
      const blocks = bodyBlocks();
      const targetIndex = blocks.indexOf(target.element);
      const contentImages = Array.from(
        container.querySelectorAll<HTMLImageElement>("img"),
      ).filter((image) => {
        const block = image.closest<HTMLElement>("[data-qf]");
        const index = block ? blocks.indexOf(block) : -1;
        return index >= 0 && index <= targetIndex;
      });
      const featureImage = document.querySelector<HTMLImageElement>(
        ".reader-feature-image img",
      );
      const images = featureImage
        ? [featureImage, ...contentImages]
        : contentImages;
      for (const image of images) {
        if (!image.complete) image.loading = "eager";
      }
      const pending = images.filter((image) => !image.complete);
      if (!pending.length) return pending;
      await new Promise<void>((resolve) => {
        let remaining = pending.length;
        let timer = 0;
        const finish = () => {
          window.clearTimeout(timer);
          for (const image of pending) {
            image.removeEventListener("load", settle);
            image.removeEventListener("error", settle);
          }
          resolve();
        };
        const settle = () => {
          remaining -= 1;
          if (remaining <= 0) finish();
        };
        timer = window.setTimeout(finish, 2500);
        for (const image of pending) {
          image.addEventListener("load", settle, { once: true });
          image.addEventListener("error", settle, { once: true });
          if (image.complete) settle();
        }
      });
      return pending.filter((image) => !image.complete);
    },
    [bodyBlocks, locateAnchor],
  );

  const restorePosition = useCallback(async () => {
    const token = restoreToken.current;
    const stored = getReadingPositions().find(
      (entry) => entry.articleId === articleId,
    );
    const pendingImages = await waitForBodyAssets(stored);
    if (token !== restoreToken.current) return;
    if (userScrolledFar.current || window.scrollY > 80) {
      // The reader already moved; never fight a deliberate scroll.
      restoreDone.current = true;
      return;
    }
    const toolbar = document.querySelector(".reader-toolbar");
    const reserve = (toolbar?.getBoundingClientRect().height || 60) + 14;
    if (stored) {
      const target = locateAnchor(stored.anchor, stored.offset);
      if (target) {
        window.scrollTo({
          top: Math.max(0, target.top - reserve),
          behavior: "auto",
        });
        if (target.usedFallback)
          setPositionNotice("上次阅读位置已变化，已定位到相邻段落。");
        else if (stored.contentVersion !== bodyVersion)
          setPositionNotice("正文内容已更新，已恢复到仍匹配的段落。");
        restoreDone.current = true;
        if (pendingImages.length) {
          const lateImages = pendingImages.filter((image) => !image.complete);
          if (lateImages.length) {
            let remaining = lateImages.length;
            let cleaned = false;
            const cleanup = () => {
              if (cleaned) return;
              cleaned = true;
              for (const image of lateImages) {
                image.removeEventListener("load", settle);
                image.removeEventListener("error", settle);
              }
              if (restoreAssetCleanup.current === cleanup)
                restoreAssetCleanup.current = null;
            };
            const correctOnce = () => {
              cleanup();
              if (token !== restoreToken.current || userScrolledFar.current)
                return;
              const current = locateAnchor(stored.anchor, stored.offset);
              if (current)
                window.scrollTo({
                  top: Math.max(0, current.top - reserve),
                  behavior: "auto",
                });
            };
            const settle = () => {
              remaining -= 1;
              if (remaining <= 0) correctOnce();
            };
            for (const image of lateImages) {
              image.addEventListener("load", settle, { once: true });
              image.addEventListener("error", settle, { once: true });
              if (image.complete) settle();
            }
            restoreAssetCleanup.current = cleanup;
          }
        }
        return;
      }
      setPositionNotice("上次阅读位置已变化，从正文开头继续。");
    }
    restoreDone.current = true;
  }, [articleId, bodyVersion, locateAnchor, waitForBodyAssets]);

  useEffect(() => {
    if (!bodyHtml || restoreDone.current) return;
    // Wait for the font size state to paint before measuring.
    const frame = window.requestAnimationFrame(() => {
      void restorePosition();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [bodyHtml, fontSize, restorePosition]);

  useEffect(() => {
    const container = readerBody.current;
    if (!container || !bodyHtml) return;
    function onImageError(event: Event) {
      const image = event.target;
      if (!(image instanceof HTMLImageElement)) return;
      image.hidden = true;
      const figure = image.closest("figure");
      if (
        figure &&
        !figure.querySelector("figcaption") &&
        !figure.textContent?.trim()
      )
        figure.remove();
      const paragraph = image.closest("p");
      if (
        paragraph &&
        !paragraph.textContent?.trim() &&
        !paragraph.querySelector("img:not([hidden])")
      )
        paragraph.remove();
    }
    container.addEventListener("error", onImageError, true);
    return () => container.removeEventListener("error", onImageError, true);
  }, [bodyHtml]);

  useEffect(() => {
    function onScroll() {
      if (!bodyHtml || !restoreDone.current) return;
      // Reaching the end removes the continue-reading entry; no fanfare and
      // saved-state is untouched.
      const container = readerBody.current;
      if (
        container &&
        !endRemoved.current &&
        container.getBoundingClientRect().bottom < window.innerHeight * 0.5
      ) {
        endRemoved.current = true;
        const next = getReadingPositions().filter(
          (entry) => entry.articleId !== articleId,
        );
        if (setReadingPositions(next)) setPositionSaveFailed(false);
        pendingPosition.current = null;
        if (pendingSave.current) {
          window.clearTimeout(pendingSave.current);
          pendingSave.current = null;
        }
        return;
      }
      scheduleSave();
    }
    function onUserScrollIntent(event: Event) {
      if (event.type === "keydown") {
        const key = (event as KeyboardEvent).key;
        if (
          ![
            "ArrowDown",
            "ArrowUp",
            "PageDown",
            "PageUp",
            "Home",
            "End",
            " ",
          ].includes(key)
        )
          return;
        const target = event.target;
        if (
          target instanceof HTMLElement &&
          (target.isContentEditable ||
            target.closest("input, textarea, select, button, a"))
        )
          return;
      }
      if (event.type === "pointerdown") {
        const pointer = event as PointerEvent;
        if (
          pointer.pointerType !== "mouse" ||
          pointer.clientX < window.innerWidth - 20
        )
          return;
      }
      userScrolledFar.current = true;
      restoreAssetCleanup.current?.();
      restoreAssetCleanup.current = null;
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", onUserScrollIntent, { passive: true });
    window.addEventListener("touchmove", onUserScrollIntent, { passive: true });
    window.addEventListener("pointerdown", onUserScrollIntent, {
      passive: true,
    });
    window.addEventListener("keydown", onUserScrollIntent);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onUserScrollIntent);
      window.removeEventListener("touchmove", onUserScrollIntent);
      window.removeEventListener("pointerdown", onUserScrollIntent);
      window.removeEventListener("keydown", onUserScrollIntent);
    };
  }, [articleId, bodyHtml, scheduleSave]);

  useEffect(() => {
    function flush() {
      if (pendingSave.current) {
        window.clearTimeout(pendingSave.current);
        pendingSave.current = null;
      }
      const position = computePosition() || pendingPosition.current;
      if (position) {
        pendingPosition.current = position;
        if (!writePosition(position) && !positionSaveFailed)
          setPositionSaveFailed(true);
      }
    }
    function onVisibility() {
      if (document.visibilityState === "hidden") flush();
    }
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [computePosition, positionSaveFailed, writePosition]);

  /* ---------------------------------------------------------------- */

  const toggleSave = useCallback(() => {
    if (!item) return;
    const current = getSaved();
    const exists = current.some(
      (entry) =>
        entry.id === item.id ||
        Boolean(item.link && entry.link === item.link) ||
        entry.legacyIds?.includes(articleId),
    );
    const next: SavedItem[] = exists
      ? current.filter(
          (entry) =>
            !(
              entry.id === item.id ||
              Boolean(item.link && entry.link === item.link) ||
              entry.legacyIds?.includes(articleId)
            ),
        )
      : [{ ...item, savedAt: new Date().toISOString() }, ...current];
    if (setSaved(next)) {
      setSavedState(!exists);
      setStorageError("");
      setActionMessage(exists ? "已取消收藏" : "已收藏");
    } else {
      setStorageError("未能保存收藏，请检查浏览器存储空间后重试。");
    }
  }, [item, articleId]);

  const openNote = useCallback(
    (excerpt = "") => {
      if (!item) return;
      setNoteDraft({
        title: item.title,
        sourceUrl: item.link,
        articleId: item.id,
        topic: item.topic,
        excerpt: excerpt || undefined,
      });
      setNoteOpen(true);
    },
    [item],
  );

  function addNote(draft: KnowledgeNoteDraft) {
    if (!draft.body?.trim() && !draft.excerpt?.trim()) return false;
    const now = new Date().toISOString();
    const note: KnowledgeNote = {
      ...draft,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    const next = [note, ...getNotes()];
    if (!setNotes(next)) return false;
    return true;
  }

  function goBack() {
    if (pendingSave.current) {
      window.clearTimeout(pendingSave.current);
      pendingSave.current = null;
    }
    const position = pendingPosition.current || computePosition();
    if (position) writePosition(position);
    if (canReturnInApp.current) router.back();
    else router.push("/", { scroll: false });
  }

  function changeFontSize(next: number) {
    const bounded = Math.max(16, Math.min(24, next));
    if (setReadingFontSize(bounded)) {
      setFontSize(bounded);
      setStorageError("");
    } else {
      setStorageError("未能保存正文大小设置。");
    }
  }

  function closeFontPanel() {
    setFontPanelOpen(false);
    fontTrigger.current?.focus();
  }

  const statusCopy = useMemo(() => {
    if (!item) return "";
    if (failed) return "暂时无法加载文章，请稍后重试。";
    if (item.contentStatus === "video") return "此内容为视频。";
    if (item.contentStatus === "interactive")
      return "此作品为交互式内容，站内提供说明与原文体验入口。";
    if (prepareState === "restricted") return "此来源暂时无法提供站内正文。";
    if (prepareState === "failed" || item.contentStatus === "failed")
      return "暂时无法加载正文。";
    if (prepareState === "preparing") return "正在加载正文…";
    if (
      !bodyHtml &&
      (item.contentCompleteness === "summary" ||
        item.contentStatus === "summary" ||
        prepareState === "summary")
    )
      return "此文章暂时只能显示摘要。";
    return "";
  }, [item, bodyHtml, prepareState, failed]);

  if (loading && !item)
    return (
      <div className="reader-page">
        <header className="reader-toolbar">
          <button type="button" className="text-action" onClick={goBack}>
            <ArrowLeft size={17} aria-hidden="true" /> 返回
          </button>
          <Link className="reader-brand" href="/" scroll={false}>
            curio
          </Link>
        </header>
        <main className="reader-main reader-skeleton">
          <span className="sr-only" role="status">
            正在加载文章…
          </span>
          <div aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
        </main>
      </div>
    );
  if (failed && !item)
    return (
      <main className="reader-error">
        <button
          type="button"
          className="text-action"
          onClick={() => router.push("/", { scroll: false })}
        >
          <ArrowLeft size={17} />
          返回发现
        </button>
        <h1>{notFound ? "找不到这篇文章" : "暂时无法加载文章"}</h1>
        <p>{notFound ? "请检查文章链接。" : "请稍后重试。"}</p>
        <button
          type="button"
          className="button-secondary"
          onClick={() => {
            setLoading(true);
            setRetryArticle((n) => n + 1);
          }}
        >
          重试加载
        </button>
      </main>
    );
  if (!item) return null;

  const hasBody = Boolean(bodyHtml);

  return (
    <div
      className="reader-page"
      onClickCapture={(event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const link = target.closest<HTMLAnchorElement>('a[href^="/"]');
        if (!link) return;
        const position = computePosition();
        if (position) writePosition(position);
      }}
    >
      <header className="reader-toolbar">
        <button type="button" className="text-action" onClick={goBack}>
          <ArrowLeft size={17} aria-hidden="true" />
          返回
        </button>
        <Link className="reader-brand" href="/" scroll={false}>
          curio
        </Link>
        <div className="reader-toolbar-actions">
          <button
            type="button"
            className="text-action save-action"
            onClick={toggleSave}
            aria-label={
              saved ? `取消收藏：${item.title}` : `收藏：${item.title}`
            }
          >
            {saved ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}
            <span className="save-label">{saved ? "已收藏" : "收藏"}</span>
          </button>
          <div className="font-controls" aria-label="正文大小">
            <button
              type="button"
              onClick={() => changeFontSize(fontSize - 1)}
              aria-label="缩小字号"
            >
              <Minus size={15} />
            </button>
            <span className="font-size-label" aria-live="polite">
              字号 {fontSize}
            </span>
            <button
              type="button"
              onClick={() => changeFontSize(fontSize + 1)}
              aria-label="放大字号"
            >
              <Plus size={15} />
            </button>
            <button
              type="button"
              className="font-panel-toggle"
              aria-label="字号设置"
              aria-expanded={fontPanelOpen}
              aria-controls="reader-font-panel"
              ref={fontTrigger}
              onClick={() => setFontPanelOpen((open) => !open)}
            >
              <Type size={17} aria-hidden="true" />
            </button>
            {fontPanelOpen && (
              <div
                className="font-panel"
                id="reader-font-panel"
                role="dialog"
                aria-label="调整字号"
              >
                <p>字号</p>
                <div className="font-panel-controls">
                  <button
                    type="button"
                    onClick={() => changeFontSize(fontSize - 1)}
                    aria-label="缩小字号"
                  >
                    <Minus size={16} aria-hidden="true" />
                  </button>
                  <span aria-live="polite">{fontSize}</span>
                  <button
                    type="button"
                    onClick={() => changeFontSize(fontSize + 1)}
                    aria-label="放大字号"
                  >
                    <Plus size={16} aria-hidden="true" />
                  </button>
                </div>
                <button
                  type="button"
                  className="text-action"
                  onClick={closeFontPanel}
                >
                  关闭
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="reader-main">
        <article className="reader-article">
          <header className="reader-heading">
            <p className="article-meta">
              <span>{item.topic}</span>
              <span aria-hidden="true">·</span>
              <span>{item.source}</span>
            </p>
            <h1>{item.title}</h1>
            <div className="reader-byline">
              {item.creator && (
                <>
                  <span>{item.creator}</span>
                  <span aria-hidden="true">·</span>
                </>
              )}
              <time dateTime={item.pubDate}>{formatDate(item.pubDate)}</time>
              {outboundUrl && (
                <a href={outboundUrl} target="_blank" rel="noopener noreferrer">
                  {videoOriginal ? "前往 YouTube 观看" : "查看原文"}{" "}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              )}
            </div>
            {statusCopy && (
              <p className="content-status" role="status">
                {statusCopy}
                {failed && (
                  <button type="button" className="text-action" onClick={() => setRetryArticle((n) => n + 1)}>重试加载</button>
                )}
                {prepareState === "failed" && (
                  <button
                    type="button"
                    className="text-action"
                    disabled={!bodyRetryReady}
                    onClick={() => void prepareBody(++requestToken.current)}
                  >
                    重试加载
                  </button>
                )}
                {item.contentType === "video" &&
                  !videoOriginal &&
                  !original && <span>视频链接暂不可用。</span>}
                {item.contentType !== "video" && !original && (
                  <span>原文链接暂不可用。</span>
                )}
              </p>
            )}
            {positionNotice && (
              <p className="content-status" role="status">
                {positionNotice}
              </p>
            )}
            {featureImage && (
              <figure className="reader-feature-image">
                <img
                  src={featureImage}
                  alt={item.imageAlt || item.title}
                  onError={() => setFailedFeatureImage(featureImage)}
                />
                {item.imageCredit && (
                  <figcaption>{item.imageCredit}</figcaption>
                )}
              </figure>
            )}
          </header>

          {hasBody ? (
            <>
              {bodyNotice && (
                <p className="content-status body-notice" role="status">
                  {bodyNotice}
                </p>
              )}
              {positionSaveFailed && (
                <p className="reader-note-error" role="alert">
                  未能保存阅读位置，本次浏览进度暂不会出现在继续阅读中。
                </p>
              )}
              <section
                className="reader-body"
                ref={(node) => {
                  readerBody.current = node;
                }}
                style={{ fontSize: `${fontSize}px` }}
                dangerouslySetInnerHTML={{ __html: bodyHtml || "" }}
              />
            </>
          ) : item.contentType !== "video" || item.description ? (
            <section
              className="reader-summary"
              ref={(node) => {
                readerBody.current = node;
              }}
              style={{ fontSize: `${fontSize}px` }}
            >
              <h2>{item.contentType === "video" ? "视频简介" : "摘要"}</h2>
              <p>{item.description || "此来源未提供摘要。"}</p>
            </section>
          ) : null}

          <footer className="reader-end-actions">
            {selectedText && (
              <button
                type="button"
                className="button-secondary"
                onClick={() => openNote(selectedText)}
              >
                摘录
              </button>
            )}
            <button
              type="button"
              className="button-primary"
              onClick={() => openNote()}
            >
              写笔记
            </button>
            {item.contentType === "video" && videoOriginal && (
              <a
                className="button-primary"
                href={videoOriginal}
                target="_blank"
                rel="noopener noreferrer"
              >
                前往 YouTube 观看 <ArrowUpRight size={15} />
              </a>
            )}
            {item.contentType === "interactive" && original && (
              <a
                className="button-primary"
                href={original}
                target="_blank"
                rel="noopener noreferrer"
              >
                到原站体验交互内容 <ArrowUpRight size={15} />
              </a>
            )}
          </footer>
        </article>

        {payload?.related?.length ? (
          <section className="related-section" aria-labelledby="related-title">
            <div className="section-heading">
              <h2 id="related-title">继续探索</h2>
            </div>
            <div className="related-grid">
              {payload.related.slice(0, 3).map((related) => (
                <article key={related.id}>
                  <p className="article-meta">
                    {related.topic} · {related.source}
                  </p>
                  <h3>
                    <Link href={`/read/${encodeURIComponent(related.id)}`}>
                      {related.title}
                    </Link>
                  </h3>
                  <p>{related.description}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </main>

      <span className="sr-only" role="status" aria-live="polite">
        {actionMessage}
      </span>
      {storageError && (
        <p className="reader-note-error" role="alert">
          {storageError}
        </p>
      )}
      <KnowledgeNoteModal
        open={noteOpen}
        initial={noteDraft}
        onCancel={() => {
          setNoteOpen(false);
          setNoteDraft(undefined);
        }}
        onSave={addNote}
      />
    </div>
  );
}
