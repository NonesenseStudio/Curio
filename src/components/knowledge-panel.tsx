"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight, Shuffle } from "lucide-react";
import type { FeedItem, KnowledgeNote, SavedItem } from "@/lib/types";
import { formatDate, formatSavedDate } from "@/lib/format-date";
import ArticleRow from "./article-row";
import KnowledgeNoteModal, {
  type KnowledgeNoteDraft,
} from "./knowledge-note-modal";

type Props = {
  mode: "saved" | "knowledge";
  saved: SavedItem[];
  notes: KnowledgeNote[];
  onSave: (item: FeedItem) => void;
  onAddNote: (note: KnowledgeNoteDraft) => boolean;
  onNavigate: (path: string) => void;
};

function noteHeading(note: KnowledgeNote) {
  return (
    note.title?.trim() ||
    note.body?.split("\n")[0].trim() ||
    note.excerpt?.split("\n")[0].trim() ||
    note.legacyFields?.insight?.split("\n")[0].trim() ||
    note.legacyFields?.connection?.split("\n")[0].trim() ||
    "笔记"
  );
}

export default function KnowledgePanel({
  mode,
  saved,
  notes,
  onSave,
  onAddNote,
  onNavigate,
}: Props) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteItem, setNoteItem] = useState<FeedItem | null>(null);
  const [filter, setFilter] = useState<"all" | "article" | "video">("all");
  const [randomNoteId, setRandomNoteId] = useState("");
  const savedItems = useMemo(
    () =>
      [...saved]
        .filter(
          (item) =>
            filter === "all" ||
            (filter === "video"
              ? item.contentType === "video"
              : item.contentType !== "video"),
        )
        .sort(
          (a, b) =>
            new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime(),
        ),
    [saved, filter],
  );
  const orderedNotes = useMemo(
    () =>
      [...notes].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [notes],
  );
  const randomNote = orderedNotes.find((note) => note.id === randomNoteId);

  function createFromArticle(item: FeedItem) {
    setNoteItem(item);
    setNoteOpen(true);
  }

  function newNote() {
    setNoteItem(null);
    setNoteOpen(true);
  }

  function chooseRandomNote() {
    if (orderedNotes.length === 0) return;
    const choices = orderedNotes.filter((note) => note.id !== randomNoteId);
    const next =
      choices[Math.floor(Math.random() * choices.length)] || orderedNotes[0];
    setRandomNoteId(next.id);
  }

  return (
    <section
      className="panel-page"
      aria-labelledby={mode === "saved" ? "collections-title" : "notes-title"}
    >
      <header className="panel-heading-row">
        <div>
          <h1 id={mode === "saved" ? "collections-title" : "notes-title"}>
            {mode === "saved" ? "收藏" : "灵感笔记"}
          </h1>
          <span className="panel-count">
            {mode === "saved" ? `${saved.length} 项` : `${notes.length} 则`}
          </span>
        </div>
        {mode === "knowledge" ? (
          <button type="button" className="button-primary" onClick={newNote}>
            新建笔记
          </button>
        ) : null}
      </header>

      {mode === "saved" && (
        <div className="filter-tabs" aria-label="收藏类型">
          {(
            [
              ["all", "全部"],
              ["article", "文章"],
              ["video", "视频"],
            ] as const
          ).map(([value, label]) => (
            <button
              type="button"
              key={value}
              className={filter === value ? "selected" : ""}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {mode === "saved" &&
        (savedItems.length === 0 ? (
          <div className="feed-empty">
            <h2>{saved.length ? "没有符合条件的收藏" : "还没有收藏内容"}</h2>
            <button
              type="button"
              className="button-primary"
              onClick={() => onNavigate("/")}
            >
              前往发现
            </button>
          </div>
        ) : (
          <div className="feed-list saved-list">
            {savedItems.map((item) => (
              <div className="saved-article" key={item.id}>
                <p className="saved-at">{formatSavedDate(item.savedAt)}</p>
                <ArticleRow
                  item={item}
                  saved
                  showTopic
                  onSave={onSave}
                  onCreateNote={createFromArticle}
                />
              </div>
            ))}
          </div>
        ))}

      {mode === "knowledge" && (
        <div className="notes-tools">
          <button
            type="button"
            className="button-secondary"
            onClick={chooseRandomNote}
            disabled={!notes.length}
          >
            <Shuffle size={16} aria-hidden="true" />
            随机回看
          </button>
        </div>
      )}

      {mode === "knowledge" && randomNote && (
        <article className="random-note-callout" aria-live="polite">
          <p className="article-meta">
            {formatDate(randomNote.createdAt, "创建时间未知")}
          </p>
          <h2>{noteHeading(randomNote)}</h2>
          {randomNote.excerpt && <blockquote>{randomNote.excerpt}</blockquote>}
          {randomNote.body && <p>{randomNote.body}</p>}
          {randomNote.legacyFields?.insight && (
            <p>
              <strong>我的理解</strong>
              <br />
              {randomNote.legacyFields.insight}
            </p>
          )}
          {randomNote.legacyFields?.connection && (
            <p>
              <strong>关联知识</strong>
              <br />
              {randomNote.legacyFields.connection}
            </p>
          )}
          {randomNote.sourceUrl &&
            /^https?:\/\//i.test(randomNote.sourceUrl) && (
              <a
                className="text-action"
                href={randomNote.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                查看原文 <ArrowUpRight size={15} aria-hidden="true" />
              </a>
            )}
        </article>
      )}

      {mode === "knowledge" &&
        (orderedNotes.length === 0 ? (
          <div className="feed-empty">
            <h2>还没有笔记</h2>
            <p>可以从文章中摘录，也可以直接记下自己的想法。</p>
            <button type="button" className="button-primary" onClick={newNote}>
              新建笔记
            </button>
          </div>
        ) : (
          <div className="knowledge-list">
            {orderedNotes.map((note) => (
              <article className="knowledge-item" key={note.id}>
                <p className="article-meta">
                  {note.topic && (
                    <>
                      <span>{note.topic}</span>
                      <span aria-hidden="true">·</span>
                    </>
                  )}
                  {formatDate(note.createdAt, "创建时间未知")}
                </p>
                <h2>{noteHeading(note)}</h2>
                {note.excerpt && <blockquote>{note.excerpt}</blockquote>}
                {note.body && <p className="knowledge-body">{note.body}</p>}
                {note.legacyFields?.insight && (
                  <div className="knowledge-legacy-field">
                    <h3>我的理解</h3>
                    <p>{note.legacyFields.insight}</p>
                  </div>
                )}
                {note.legacyFields?.connection && (
                  <div className="knowledge-legacy-field">
                    <h3>关联知识</h3>
                    <p>{note.legacyFields.connection}</p>
                  </div>
                )}
                {note.sourceUrl && /^https?:\/\//i.test(note.sourceUrl) && (
                  <a
                    className="text-action note-source"
                    href={note.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看原文 <ArrowUpRight size={15} aria-hidden="true" />
                  </a>
                )}
              </article>
            ))}
          </div>
        ))}

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
    </section>
  );
}
