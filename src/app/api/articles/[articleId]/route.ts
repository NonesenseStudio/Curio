import { NextResponse } from "next/server";
import { getAggregatedFeed } from "@/lib/articles/feed-service";
import {
  getArticleRecord,
  getRelatedArticles,
  publicArticleRecord,
} from "@/lib/articles/store";
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
  if (!record && !id.startsWith("saved-")) {
    await getAggregatedFeed();
    record = await getArticleRecord(id);
  }
  if (!record)
    return NextResponse.json({ error: "article_not_found" }, { status: 404 });

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

  return NextResponse.json({
    ...publicArticleRecord(record),
    related: await getRelatedArticles(record.item, 3, {
      mutedSourceIds,
      mutedTopics,
    }),
  });
}
