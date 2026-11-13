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
} from "lucide-react";
import type {
  ArticleRecord,
  FeedItem,
  KnowledgeNote,
  SavedItem,
} from "@/lib/types";
import { formatDate } from "@/lib/format-date";
import { isSafeHttpsImage, safeYouTubeUrl } from "@/lib/safe-url";
import {
  getNotes,
  getMuted,
  getMutedSources,
  getReadingFontSize,
  getSaved,
  setNotes,
  setReadingFontSize,
  setSaved,
} from "@/lib/storage";
import type { KnowledgeNoteDraft } from "./knowledge-note-modal";
import KnowledgeNoteModal from "./knowledge-note-modal";

type ReaderPayload = ArticleRecord & { related?: FeedItem[] };
type Props = { articleId: string };

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
  const [saved, setSavedState] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState<
    Partial<KnowledgeNoteDraft> | undefined
  >();
  const [selectedText, setSelectedText] = useState("");
  const [fontSize, setFontSize] = useState(18);
  const [storageError, setStorageError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const readerBody = useRef<HTMLElement | null>(null);
  const canReturnInApp = useRef(false);
  const item = payload?.item;
  const original = item ? validOriginal(item.link) : "";
  const videoOriginal =
    item?.contentType === "video" ? safeYouTubeUrl(item.link) : "";
  const outboundUrl = item?.contentType === "video" ? "" : original;
  const featureImage =
    item && isSafeHttpsImage(item.image) ? item.image : undefined;

  const loadLocalItem = useCallback(() => {
    const local = getSaved().find(
      (entry) => entry.id === articleId || entry.legacyIds?.includes(articleId),
    );
    if (local) {
      setPayload({ item: local, related: [] });
      setSavedState(true);
      return true;
    }
    return false;
  }, [articleId]);

  useEffect(() => {
    try {
      canReturnInApp.current = Boolean(
        document.referrer &&
        new URL(document.referrer).origin === window.location.origin,
      );
    } catch {
      canReturnInApp.current = false;
    }
    const controller = new AbortController();
    const relatedFilters = new URLSearchParams();
    getMutedSources().forEach((sourceId) =>
      relatedFilters.append("mutedSource", sourceId),
    );
    getMuted().forEach((topic) => relatedFilters.append("mutedTopic", topic));
    const filterQuery = relatedFilters.toString();
    setLoading(true);
    setFailed(false);
    void fetch(
      `/api/articles/${encodeURIComponent(articleId)}${filterQuery ? `?${filterQuery}` : ""}`,
      {
        cache: "no-store",
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("article_unavailable");
        return (await response.json()) as ReaderPayload;
      })
      .then((data) => {
        setPayload(data);
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
      .catch(() => {
        if (!controller.signal.aborted && !loadLocalItem()) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [articleId, loadLocalItem]);

  useEffect(() => setFontSize(getReadingFontSize()), []);

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

  const statusCopy = useMemo(() => {
    if (!item) return "";
    if (item.contentStatus === "video") return "此内容为视频。";
    if (item.contentStatus === "restricted") return "此来源暂不支持站内阅读。";
    if (item.contentStatus === "failed") return "暂时无法加载正文。";
    if (item.contentCompleteness === "partial")
      return "当前仅获取到部分内容，可查看原文。";
    if (
      item.contentCompleteness === "summary" ||
      item.contentStatus === "summary"
    )
      return "此文章暂时只能显示摘要。";
    return "";
  }, [item]);

  if (loading && !item)
    return (
      <main className="reader-loading" aria-live="polite">
        正在准备阅读内容…
      </main>
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
        <h1>找不到这篇文章</h1>
        <p>文章可能已从来源移除，或链接不再有效。</p>
      </main>
    );
  if (!item) return null;

  return (
    <div className="reader-page">
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
            className="text-action"
            onClick={toggleSave}
            aria-label={
              saved ? `取消收藏：${item.title}` : `收藏：${item.title}`
            }
          >
            {saved ? <BookmarkCheck size={17} /> : <Bookmark size={17} />}
            {saved ? "已收藏" : "收藏"}
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
                  {item.contentType === "video"
                    ? "前往 YouTube 观看"
                    : "查看原文"}{" "}
                  <ArrowUpRight size={14} aria-hidden="true" />
                </a>
              )}
            </div>
            {statusCopy && (
              <p className="content-status" role="status">
                {statusCopy}
                {original && item.contentCompleteness !== "summary" && (
                  <a href={original} target="_blank" rel="noreferrer">
                    查看原文
                  </a>
                )}
                {item.contentType === "video" && !videoOriginal && (
                  <span>视频链接暂不可用。</span>
                )}
                {item.contentType !== "video" && !original && (
                  <span>原文链接暂不可用。</span>
                )}
              </p>
            )}
            {featureImage && (
              <figure className="reader-feature-image">
                <img src={featureImage} alt={item.imageAlt || item.title} />
                {item.imageCredit && (
                  <figcaption>{item.imageCredit}</figcaption>
                )}
              </figure>
            )}
          </header>

          <section
            className="reader-summary"
            ref={(node) => {
              readerBody.current = node;
            }}
            style={{ fontSize: `${fontSize}px` }}
          >
            <h2>摘要</h2>
            <p>{item.description || "此来源未提供摘要。"}</p>
          </section>

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
