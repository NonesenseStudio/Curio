const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid"]);

/** Removes known tracking values while preserving article-specific URL parts. */
export function canonicalArticleUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    const kept = Array.from(url.searchParams.entries()).filter(
      ([key]) =>
        !/^utm_[a-z0-9_]+$/i.test(key) &&
        !TRACKING_PARAMETERS.has(key.toLowerCase()),
    );
    url.search = "";
    for (const [key, entry] of kept) url.searchParams.append(key, entry);
    return url.href;
  } catch {
    return "";
  }
}

export function sameArticleUrl(left: string, right: string) {
  const canonicalLeft = canonicalArticleUrl(left);
  return Boolean(canonicalLeft && canonicalLeft === canonicalArticleUrl(right));
}
