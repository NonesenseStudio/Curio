import { NextResponse } from "next/server";
import {
  filterFeedItems,
  getAggregatedFeed,
  getFeedSnapshot,
} from "@/lib/articles/feed-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const result =
    searchParams.get("mode") === "snapshot"
      ? await getFeedSnapshot()
      : await getAggregatedFeed(searchParams.get("refresh") === "1");
  return NextResponse.json({
    ...result,
    items: filterFeedItems(
      result.items,
      searchParams.get("topic"),
      searchParams.get("q") || "",
    ),
  });
}
