import { sources } from "@/lib/sources";
import type { FeedItem, KnowledgeNote, Topic } from "@/lib/types";

export function noteTopic(
  note: KnowledgeNote,
  articles: FeedItem[],
): Topic | undefined {
  if (note.topic) return note.topic;
  const linkedArticle = articles.find(
    (item) =>
      item.id === note.articleId ||
      (note.sourceUrl && item.link === note.sourceUrl),
  );
  if (linkedArticle) return linkedArticle.topic;

  const sourceFromId = note.articleId
    ? sources.find((source) => note.articleId?.startsWith(`${source.id}-`))
    : undefined;
  if (sourceFromId) return sourceFromId.topic;

  if (!note.sourceUrl) return undefined;
  try {
    const noteHost = new URL(note.sourceUrl).hostname.toLowerCase();
    return sources.find(
      (source) => source.articleHosts.includes(noteHost),
    )?.topic;
  } catch {
    return undefined;
  }
}
