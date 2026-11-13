import { NextResponse } from "next/server";
import { getArticleRecord } from "@/lib/articles/store";
import { sources } from "@/lib/sources";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: { articleId: string } },
) {
  const record = await getArticleRecord(params.articleId);
  if (!record)
    return NextResponse.json({ error: "article_not_found" }, { status: 404 });

  if (record.item.contentType === "video") {
    return NextResponse.json({ status: "video", completeness: "summary" });
  }

  const source = sources.find((entry) => entry.id === record?.item.sourceId);
  if (!source || source.bodyPolicy === "unknown") {
    return NextResponse.json(
      {
        status: "summary",
        completeness: "summary",
        reason: "source_policy_unverified",
      },
      { status: 409 },
    );
  }

  // The approved extraction and sanitation pipeline is not enabled yet.
  return NextResponse.json(
    {
      status: "summary",
      completeness: "summary",
      reason: "body_pipeline_unavailable",
    },
    { status: 409 },
  );
}
