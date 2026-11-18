import type { FeedSource } from "@/lib/sources";
import type { FeedItem } from "@/lib/types";

export type BodyMethod = "feed" | "web";

function matchesPathPrefix(pathname: string, prefix: string) {
  const normalized = prefix.startsWith("/") ? prefix : `/${prefix}`;
  const boundaryPrefix = normalized.endsWith("/")
    ? normalized
    : `${normalized}/`;
  return pathname === normalized || pathname.startsWith(boundaryPrefix);
}

/** Whether a source has verified this body method for this exact item. */
export function isBodyMethodAllowed(
  source: FeedSource,
  item: FeedItem,
  method: BodyMethod,
) {
  const policyAllowsMethod =
    source.bodyPolicy === method || source.bodyPolicy === "feed-web";
  if (!policyAllowsMethod) return false;

  let url: URL;
  try {
    url = new URL(item.link);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;

  const allowedHosts = source.bodyHosts?.length
    ? source.bodyHosts
    : source.articleHosts;
  if (!allowedHosts.some((host) => host.toLowerCase() === url.hostname.toLowerCase()))
    return false;

  const pathPrefixes =
    method === "feed"
      ? source.bodyFeedPathPrefixes
      : source.bodyWebPathPrefixes;
  return (
    !pathPrefixes?.length ||
    pathPrefixes.some((prefix) => matchesPathPrefix(url.pathname, prefix))
  );
}

/** Feed candidates are preferred when both registered paths are verified. */
export function bodyMethodsFor(source: FeedSource, item: FeedItem) {
  const candidates: BodyMethod[] =
    source.bodyPolicy === "feed-web"
      ? ["feed", "web"]
      : source.bodyPolicy === "feed" || source.bodyPolicy === "web"
        ? [source.bodyPolicy]
        : [];
  return candidates.filter((method) =>
    isBodyMethodAllowed(source, item, method),
  );
}
