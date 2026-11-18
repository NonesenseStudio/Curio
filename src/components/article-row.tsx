"use client";

import Link from "next/link";
import { useState } from "react";
import { Bookmark, BookmarkCheck, FileText, Play } from "lucide-react";
import type { FeedItem } from "@/lib/types";
import { isSafeHttpsImage, safeYouTubeUrl } from "@/lib/safe-url";
import { formatDate } from "@/lib/format-date";

type Props = {
  item: FeedItem;
  saved: boolean;
  showTopic?: boolean;
  onSave: (item: FeedItem) => void;
  onCreateNote: (item: FeedItem) => void;
};

export default function ArticleRow({
  item,
  saved,
  showTopic = true,
  onSave,
  onCreateNote,
}: Props) {
  const title = item.title?.trim() || "未提供标题";
  const [failedImage, setFailedImage] = useState("");
  const sourceImage = isSafeHttpsImage(item.image) ? item.image : undefined;
  const image = sourceImage && sourceImage !== failedImage ? sourceImage : undefined;
  const videoUrl =
    item.contentType === "video" ? safeYouTubeUrl(item.link) : "";
  return (
    <article className={`article-row${image ? " has-image" : ""}`}>
      {image && (
        <Link
          className="row-image"
          href={`/read/${encodeURIComponent(item.id)}`}
          tabIndex={-1}
          aria-hidden="true"
        >
          {/* Feed images are external publisher artwork; alt text is supplied on the reading page. */}
          <img
            src={image}
            alt=""
            loading="lazy"
            onError={() => setFailedImage(image)}
          />
        </Link>
      )}
      <div className="article-row-main">
        <div className="article-meta">
          <span>{item.source}</span>
          <span aria-hidden="true">·</span>
          <span>{formatDate(item.pubDate)}</span>
          {showTopic && (
            <>
              <span aria-hidden="true">·</span>
              <span>{item.topic}</span>
            </>
          )}
        </div>
        <h2 className="article-title">
          <Link href={`/read/${encodeURIComponent(item.id)}`}>{title}</Link>
        </h2>
        {!item.link && (
          <p className="article-unavailable">原文链接暂不可用。</p>
        )}
        {item.description && (
          <p className="article-description">{item.description}</p>
        )}
        <div className="article-actions">
          <Link
            className="text-action"
            href={`/read/${encodeURIComponent(item.id)}`}
          >
            {item.contentType === "video" ? (
              <Play size={16} aria-hidden="true" />
            ) : (
              <FileText size={16} aria-hidden="true" />
            )}
            {item.contentType === "video"
              ? item.description
                ? "查看视频简介"
                : "查看视频信息"
              : "阅读文章"}
          </Link>
          {videoUrl && (
            <a
              className="text-action"
              href={videoUrl}
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
            aria-label={saved ? `取消收藏：${title}` : `收藏：${title}`}
          >
            {saved ? (
              <BookmarkCheck size={16} aria-hidden="true" />
            ) : (
              <Bookmark size={16} aria-hidden="true" />
            )}
            {saved ? "已收藏" : "收藏"}
          </button>
          <button
            type="button"
            className="text-action"
            onClick={() => onCreateNote(item)}
          >
            <span aria-hidden="true">＋</span>写笔记
          </button>
        </div>
      </div>
    </article>
  );
}
