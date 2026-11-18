import { NextResponse } from "next/server";
import { getAggregatedFeed } from "@/lib/articles/feed-service";
import {
  getArticleRecord,
  isArticleArchiveAvailable,
  getRelatedArticles,
  publicArticleRecord,
} from "@/lib/articles/store";
import { effectiveBodyState } from "@/lib/articles/body-pipeline";
import { bodyMethodsFor } from "@/lib/articles/body-policy";
import { sources, topics } from "@/lib/sources";
import type { Topic } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  { params }: { params: { articleId: string } },
) {
  const id = params.articleId;
  let record = await getArticleRecord(id);
  if (!record && isArticleArchiveAvailable() === "unavailable")
    return NextResponse.json({ error: "archive_unavailable" }, { status: 503 });
  if (
    !record &&
    !id.startsWith("saved-") &&
    new URL(request.url).searchParams.get("recover") === "1"
  ) {
    const result = await getAggregatedFeed();
    record = await getArticleRecord(id);
    if (
      !record &&
      (result.failedRouteCount > 0 || result.archiveAvailable === "unavailable" || result.routeCacheAvailable === "unavailable")
    )
      return NextResponse.json(
        { error: "recovery_unavailable" },
        { status: 503 },
      );
  }
  if (!record)
    return NextResponse.json(
      { error: "article_not_found", recoverable: !id.startsWith("saved-") },
      { status: 404 },
    );

  const search = new URL(request.url).searchParams;
  const allowedSourceIds = new Set(sources.map((source) => source.id));
  const allowedTopics = new Set(topics.map((topic) => topic.name));
  const mutedSourceIds = new Set(
    search.getAll("mutedSource").filter((id) => allowedSourceIds.has(id)),
  );
  const mutedTopics = new Set(
    search
      .getAll("mutedTopic")
      .filter((topic): topic is Topic => allowedTopics.has(topic as Topic)),
  );

  const bodyState = effectiveBodyState(record);
  const publicRecord = publicArticleRecord(record);
  // A body can only be prepared for articles whose source has a verified
  // feed or web policy; everything else stays on the honest fallback.
  const source = sources.find((entry) => entry.id === record.item.sourceId);
  const preparable =
    !bodyState.hasBody &&
    record.item.contentType === "article" &&
    Boolean(source && bodyMethodsFor(source, record.item).length);
  // The status must reflect what is actually readable now: a prepared body
  // upgrades the feed-level "summary" marker to "readable".
  const item = publicRecord.item;
  const effectiveItem =
    item.contentStatus === "summary" && bodyState.hasBody
      ? {
          ...item,
          contentStatus: "readable" as const,
          contentCompleteness: bodyState.completeness,
        }
      : item;

  return NextResponse.json({
    ...publicRecord,
    item: effectiveItem,
    bodyState: {
      hasBody: bodyState.hasBody,
      completeness: bodyState.completeness,
      bodyVersion: bodyState.bodyVersion,
      preparable,
    },
    related: await getRelatedArticles(record.item, 3, {
      mutedSourceIds,
      mutedTopics,
    }),
  });
}
