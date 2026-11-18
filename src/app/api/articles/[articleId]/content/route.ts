import { NextResponse } from "next/server";
import { prepareArticleBody } from "@/lib/articles/body-pipeline";
import type { BodyMethod } from "@/lib/articles/body-policy";
import {
  getArticleRecord,
  getRelatedArticles,
  isBodyUsable,
  publicArticleRecord,
} from "@/lib/articles/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Prepares the body for one internal article id. Arbitrary URLs are not
 * accepted; extraction targets must come from a registered source feed.
 */
export async function POST(
  request: Request,
  { params }: { params: { articleId: string } },
) {
  const record = await getArticleRecord(params.articleId);
  if (!record)
    return NextResponse.json({ error: "article_not_found" }, { status: 404 });

  const methodParam = new URL(request.url).searchParams.get("method");
  const requestedMethod: BodyMethod | undefined =
    methodParam === "feed" || methodParam === "web" ? methodParam : undefined;
  if (methodParam && !requestedMethod)
    return NextResponse.json({ error: "invalid_body_method" }, { status: 400 });
  const outcome = await prepareArticleBody(
    params.articleId,
    requestedMethod,
  );

  if (outcome.status === "ok") {
    // Return the freshly prepared public payload so the client can render
    // without an extra round trip; a re-GET stays equally valid.
    const fresh = await getArticleRecord(params.articleId);
    if (fresh && isBodyUsable(fresh)) {
      return NextResponse.json({
        status: "ok",
        completeness: outcome.completeness,
        bodyVersion: outcome.bodyVersion,
        article: publicArticleRecord(fresh),
        related: await getRelatedArticles(fresh.item, 3),
      });
    }
    return NextResponse.json(
      { status: "summary", reason: "prepare_did_not_persist" },
      { status: 409 },
    );
  }

  if (outcome.status === "failed")
    return NextResponse.json(
      {
        status: "failed",
        reason: outcome.reason,
        retryAfterSeconds: outcome.retryAfterSeconds,
      },
      { status: 503 },
    );

  if (outcome.status === "restricted")
    return NextResponse.json({
      status: "restricted",
      reason: outcome.reason,
      completeness: "summary",
    });

  if (outcome.status === "summary")
    return NextResponse.json(
      {
        status: "summary",
        reason: outcome.reason,
        completeness: "summary",
      },
      { status: 409 },
    );

  return NextResponse.json({
    status: outcome.status,
    reason: outcome.reason,
    completeness: "summary",
  });
}
