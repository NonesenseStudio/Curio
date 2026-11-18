import { createHash } from "node:crypto";
import type { FeedItem } from "@/lib/types";
import { canonicalArticleUrl } from "@/lib/article-link";

export function articleIdentity(item: Pick<FeedItem, "sourceId" | "link">) {
  let identity = canonicalArticleUrl(item.link);
  try {
    const url = new URL(item.link);
    if (/youtube\.com$|youtu\.be$/i.test(url.hostname)) {
      const videoId =
        url.searchParams.get("v") ||
        url.pathname.match(/\/(?:shorts|embed)\/([^/]+)/i)?.[1] ||
        (url.hostname === "youtu.be"
          ? url.pathname.split("/").filter(Boolean)[0]
          : "");
      if (videoId) identity = `youtube:${videoId}`;
    }
  } catch {
    /* The canonical URL validation below rejects invalid links. */
  }
  return identity ? `${item.sourceId}:${identity}` : "";
}

export function stableArticleId(sourceId: string, identity: string) {
  const digest = createHash("sha256")
    .update(`${sourceId}:${identity}`)
    .digest("hex")
    .slice(0, 24);
  return `${sourceId}-${digest}`;
}

export function articleIdentityFromLink(sourceId: string, link: string) {
  return articleIdentity({ sourceId, link });
}
