import { createHash } from "node:crypto";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { ArticleRecord, ContentCompleteness } from "@/lib/types";
import { sources, type FeedSource } from "@/lib/sources";
import { isSafeHttpsImage } from "@/lib/safe-url";
import { SANITIZE_VERSION } from "./body-version";
import {
  bodyMethodsFor,
  isBodyMethodAllowed,
  type BodyMethod,
} from "./body-policy";
import {
  fetchRegisteredPage,
  fetchFailureCategory,
  looksLikeHtml,
} from "./safe-fetch";
import { getArticleRecord, isBodyUsable, saveBodyResult } from "./store";

/** Persistence limit for a sanitized body, in characters (not bytes). */
const MAX_BODY_CHARS = 200_000;
/** A feed candidate shorter than this is a teaser, not a readable body. */
const MIN_FEED_BODY_CHARS = 600;
/** Below this the extracted content is not usable as a body at all. */
const MIN_USABLE_BODY_CHARS = 200;

const MAX_BACKOFF_MS = 30 * 60 * 1000;

export type BodyOutcomeStatus =
  | "ok"
  | "summary"
  | "restricted"
  | "video"
  | "interactive"
  | "failed";

export type BodyOutcome = {
  status: BodyOutcomeStatus;
  completeness?: ContentCompleteness;
  bodyVersion?: string;
  /** Machine-readable cause for diagnostics; never shown raw to readers. */
  reason?: string;
  retryAfterSeconds?: number;
};

/* ------------------------------------------------------------------ */
/* DOM singletons                                                      */
/* ------------------------------------------------------------------ */

const purifyWindow = new JSDOM("").window;
const DOMPurify = createDOMPurify(
  purifyWindow as unknown as Parameters<typeof createDOMPurify>[0],
);

const ALLOWED_TAGS = [
  "p", "br", "hr", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "blockquote", "figure", "figcaption",
  "img", "a", "strong", "em", "b", "i", "u", "s", "sup", "sub",
  "pre", "code", "table", "thead", "tbody", "tfoot", "tr", "td", "th",
  "caption", "span", "small", "mark", "abbr", "cite", "q", "dl", "dt", "dd",
];
const ALLOWED_ATTR = [
  "href", "src", "alt", "title", "colspan", "rowspan", "datetime", "width", "height", "id",
];
const ANCHOR_BLOCK_TAGS = [
  "p", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre",
  "figure", "table", "ul", "ol",
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** Stable paragraph fingerprint: normalized text, whitespace-collapsed. */
function paragraphFingerprint(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return "";
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1)
    hash = Math.imul(hash ^ normalized.charCodeAt(index), 16777619) >>> 0;
  return hash.toString(36);
}

function sourceFor(record: ArticleRecord): FeedSource | undefined {
  return sources.find((entry) => entry.id === record.item.sourceId);
}

/** Effective public state for an article, derived from stored fields. */
export function effectiveBodyState(record: ArticleRecord): {
  hasBody: boolean;
  completeness: ContentCompleteness;
  bodyVersion?: string;
} {
  if (isBodyUsable(record))
    return {
      hasBody: true,
      completeness: record.bodyCompleteness || "unknown",
      bodyVersion: record.bodyVersion,
    };
  return { hasBody: false, completeness: "summary" };
}

/* ------------------------------------------------------------------ */
/* Sanitization                                                        */
/* ------------------------------------------------------------------ */

function absolutizeAndPreprocess(rawHtml: string, baseUrl: string) {
  const dom = new JSDOM(
    `<!doctype html><html><body>${rawHtml}</body></html>`,
    { url: baseUrl },
  );
  const document = dom.window.document;
  const idMap = new Map<string, string>();
  const usedIds = new Set<string>();
  for (const element of Array.from(document.body.querySelectorAll("[id]"))) {
    const original = element.getAttribute("id") || "";
    if (!original) continue;
    const base = `body-${original.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 72)}`;
    let safeId = base;
    let suffix = 2;
    while (usedIds.has(safeId)) safeId = `${base}-${suffix++}`;
    usedIds.add(safeId);
    idMap.set(original, safeId);
    element.setAttribute("id", safeId);
  }
  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    try {
      const original = anchor.getAttribute("href") || "";
      if (original.startsWith("#")) {
        const target = idMap.get(decodeURIComponent(original.slice(1)));
        if (target) anchor.setAttribute("href", `#${target}`);
        else anchor.removeAttribute("href");
      } else {
        anchor.setAttribute("href", new URL(original, baseUrl).href);
      }
    } catch {
      anchor.removeAttribute("href");
    }
  }
  for (const image of Array.from(document.querySelectorAll("img"))) {
    try {
      const url = new URL(image.getAttribute("src") || "", baseUrl);
      if (isSafeHttpsImage(url.href)) image.setAttribute("src", url.href);
      else image.remove();
    } catch {
      image.remove();
    }
  }
  for (const removed of Array.from(
    document.querySelectorAll(
      "iframe, embed, object, video, audio, form, input, button, style, script, noscript, template, link, meta, base",
    ),
  ))
    removed.remove();
  return document.body.innerHTML;
}

function postprocessAndAnchor(cleanHtml: string) {
  const dom = new JSDOM(
    `<!doctype html><html><body>${cleanHtml}</body></html>`,
  );
  const document = dom.window.document;

  for (const anchor of Array.from(document.querySelectorAll("a"))) {
    const href = anchor.getAttribute("href") || "";
    if (/^#[a-zA-Z0-9_-]+$/.test(href)) continue;
    if (!/^https?:\/\//i.test(href)) {
      anchor.removeAttribute("href");
      continue;
    }
    anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer nofollow");
  }

  const seenImages = new Set<string>();
  for (const image of Array.from(document.querySelectorAll("img"))) {
    const src = image.getAttribute("src") || "";
    if (seenImages.has(src)) {
      image.remove();
      continue;
    }
    seenImages.add(src);
    if (!isSafeHttpsImage(image.getAttribute("src") || "")) {
      image.remove();
      continue;
    }
    image.setAttribute("loading", "lazy");
    image.setAttribute("decoding", "async");
  }

  // Drop paragraphs that carry no text and no image (extraction leftovers).
  for (const paragraph of Array.from(document.querySelectorAll("p"))) {
    if (!paragraph.textContent?.trim() && !paragraph.querySelector("img"))
      paragraph.remove();
  }
  for (const figure of Array.from(document.querySelectorAll("figure"))) {
    if (!figure.querySelector("img") && !figure.textContent?.trim())
      figure.remove();
  }

  // Assign stable anchors: per-block fingerprint plus block index. Anchors
  // derive from text, so a content version change can still locate a paragraph.
  let blockIndex = 0;
  const blocks = Array.from(
    document.body.querySelectorAll(ANCHOR_BLOCK_TAGS.join(",")),
  );
  for (const block of blocks) {
    const fingerprint = paragraphFingerprint(block.textContent || "");
    if (!fingerprint) continue;
    block.setAttribute("data-qf", fingerprint);
    block.setAttribute("data-qi", String(blockIndex));
    blockIndex += 1;
  }

  return { html: document.body.innerHTML, blockCount: blockIndex };
}

/** Keeps whole top-level blocks when the sanitized body exceeds its storage limit. */
function truncateHtmlAtBoundary(html: string) {
  if (html.length <= MAX_BODY_CHARS) return { html, truncated: false };
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  let bounded = "";
  for (const block of Array.from(dom.window.document.body.children)) {
    const serialized = block.outerHTML;
    if (bounded.length + serialized.length > MAX_BODY_CHARS) break;
    bounded += serialized;
  }
  return { html: bounded, truncated: true };
}

function textLengthOf(html: string) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim().length;
}

function sanitizeAndVersion(rawHtml: string, baseUrl: string) {
  const preprocessed = absolutizeAndPreprocess(rawHtml, baseUrl);
  const clean = DOMPurify.sanitize(preprocessed, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^https?:/i,
    KEEP_CONTENT: true,
  });
  const { html, blockCount } = postprocessAndAnchor(clean);
  if (!blockCount) return undefined;
  const bounded = truncateHtmlAtBoundary(html);
  return {
    html: bounded.html,
    truncated: bounded.truncated,
    textLength: textLengthOf(bounded.html),
    version: `${SANITIZE_VERSION}:${digest(bounded.html)}`,
  };
}

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

type Extraction = {
  html?: string;
  version?: string;
  completeness: ContentCompleteness;
  usable: boolean;
  reason?: string;
};

function classifyExtraction(
  sanitized: { html: string; truncated: boolean; textLength: number; version: string },
  transportTruncated = false,
): Extraction {
  if (sanitized.textLength < MIN_USABLE_BODY_CHARS)
    return { completeness: "summary", usable: false, reason: "body_too_short" };
  const partial = sanitized.truncated || transportTruncated;
  return {
    html: sanitized.html,
    version: sanitized.version,
    // A long extraction is not proof that the source article ended here.
    // Only a known transport or persistence cut can be labeled partial.
    completeness: partial ? "partial" : "unknown",
    usable: true,
    reason: partial ? "body_truncated_at_limit" : undefined,
  };
}

/** Keep source media that Readability may omit or misclassify as related content. */
function primaryMediaMarkup(source: FeedSource, html: string, baseUrl: string) {
  if (!source.bodyMediaSelector) return "";
  try {
    const dom = new JSDOM(html, { url: baseUrl });
    return (
      dom.window.document.querySelector(source.bodyMediaSelector)?.outerHTML ||
      ""
    );
  } catch {
    return "";
  }
}

function removeSupplementalSections(source: FeedSource, content: string) {
  if (!source.bodyEndHeadingPatterns?.length) return content;
  const dom = new JSDOM(`<!doctype html><html><body>${content}</body></html>`);
  const document = dom.window.document;
  const heading = Array.from(
    document.querySelectorAll("h2, h3, h4, h5, h6"),
  ).find((candidate) => {
    const text = (candidate.textContent || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    return source.bodyEndHeadingPatterns?.some((pattern) =>
      text.includes(pattern.toLowerCase()),
    );
  });
  if (!heading) return content;

  let current: Node | null = heading;
  let removeCurrent = true;
  while (current?.parentNode) {
    const parent: Node = current.parentNode;
    let sibling: Node | null = removeCurrent
      ? current
      : current.nextSibling;
    while (sibling) {
      const next = sibling.nextSibling;
      parent.removeChild(sibling);
      sibling = next;
    }
    if (parent === document.body) break;
    current = parent;
    removeCurrent = false;
  }
  return document.body.innerHTML;
}

function withPrimaryMedia(
  source: FeedSource,
  content: string,
  mediaMarkup: string,
) {
  const trimmedContent = removeSupplementalSections(source, content);
  if (!mediaMarkup) return trimmedContent;
  const dom = new JSDOM(
    `<!doctype html><html><body>${trimmedContent}</body></html>`,
  );
  const document = dom.window.document;
  for (const image of Array.from(document.querySelectorAll("img")))
    image.remove();
  for (const figure of Array.from(document.querySelectorAll("figure"))) {
    if (!figure.querySelector("img") && !figure.textContent?.trim())
      figure.remove();
  }
  return `${mediaMarkup}${document.body.innerHTML}`;
}

async function extractFromPage(
  record: ArticleRecord,
  source: FeedSource,
): Promise<Extraction> {
  const link = record.item.link;
  if (!/^https:\/\//i.test(link))
    return { completeness: "summary", usable: false, reason: "original_link_unavailable" };
  try {
    const pageHost = new URL(link).hostname;
    const allowedHosts = source.bodyHosts?.length
      ? source.bodyHosts.map((host) => host.toLowerCase())
      : source.articleHosts.map((host) => host.toLowerCase());
    if (!allowedHosts.includes(pageHost.toLowerCase()))
      return {
        completeness: "summary",
        usable: false,
        reason: "source_page_host_unregistered",
      };
    const response = await fetchRegisteredPage(link, allowedHosts);
    if (!looksLikeHtml(response.body, response.contentType))
      return { completeness: "summary", usable: false, reason: "response_not_html" };
    const dom = new JSDOM(response.body, { url: link });
    const mediaMarkup = primaryMediaMarkup(source, response.body, link);
    const article = new Readability(dom.window.document).parse();
    if (!article?.content)
      return { completeness: "summary", usable: false, reason: "extraction_failed" };
    const sanitized = sanitizeAndVersion(
      withPrimaryMedia(source, article.content, mediaMarkup),
      link,
    );
    if (!sanitized)
      return { completeness: "summary", usable: false, reason: "sanitize_dropped_content" };
    return classifyExtraction(sanitized, response.truncated);
  } catch (error) {
    const category = fetchFailureCategory(error);
    if (category === "http_status")
      return { completeness: "summary", usable: false, reason: "source_page_unavailable" };
    return { completeness: "summary", usable: false, reason: `fetch_${category}` };
  }
}

function extractFromFeed(
  record: ArticleRecord,
  source: FeedSource,
): Extraction {
  const candidate = record.bodyCandidate;
  if (record.candidateError === "too_large")
    return {
      completeness: "summary",
      usable: false,
      reason: "candidate_too_large",
    };
  if (record.candidateError === "storage_limit")
    return {
      completeness: "summary",
      usable: false,
      reason: "candidate_storage_limit",
    };
  if (!candidate)
    return { completeness: "summary", usable: false, reason: "candidate_missing" };
  if (record.candidateTruncated)
    return { completeness: "summary", usable: false, reason: "candidate_truncated" };
  const feedDom = new JSDOM(candidate, { url: record.item.link });
  const mediaMarkup = primaryMediaMarkup(source, candidate, record.item.link);
  const parsed = new Readability(feedDom.window.document).parse();
  const mainContent =
    parsed?.content && textLengthOf(parsed.content) >= MIN_FEED_BODY_CHARS
      ? parsed.content
      : candidate;
  const extractedContent = withPrimaryMedia(source, mainContent, mediaMarkup);
  const sanitized = sanitizeAndVersion(
    extractedContent,
    record.item.link || "https://invalid.extract.local/",
  );
  if (!sanitized)
    return { completeness: "summary", usable: false, reason: "sanitize_dropped_content" };
  if (sanitized.textLength < MIN_FEED_BODY_CHARS)
    return { completeness: "summary", usable: false, reason: "candidate_is_teaser" };
  return classifyExtraction(sanitized);
}

async function runPreparation(
  record: ArticleRecord,
  source: FeedSource,
  method: BodyMethod,
): Promise<{ outcome: BodyOutcome; extraction?: Extraction; bodySource?: "feed" | "web" }> {
  // Interactive works keep a readable description and the original-site
  // entry; their in-page experience is not reproduced as an article body.
  if (record.item.contentType === "video")
    return { outcome: { status: "video", completeness: "summary" } };
  if (
    record.item.contentType === "interactive" ||
    source.itemKind === "interactive"
  )
    return { outcome: { status: "interactive", completeness: "summary" } };
  if (!isBodyMethodAllowed(source, record.item, method))
    return {
      outcome: { status: "summary", reason: "source_policy_unverified" },
    };

  if (method === "feed") {
    const feedExtraction = extractFromFeed(record, source);
    if (feedExtraction.usable && feedExtraction.html)
      return {
        outcome: {
          status: "ok",
          completeness: feedExtraction.completeness,
          bodyVersion: feedExtraction.version,
        },
        extraction: feedExtraction,
        bodySource: "feed",
      };
    return {
      outcome: {
        status: fallbackReasonStatus(feedExtraction.reason),
        completeness: feedExtraction.completeness,
        reason: feedExtraction.reason,
      },
    };
  }
  // Policy "web": a feed payload has not been verified to carry the full
  // body, so extraction always runs against the registered page.
  const webExtraction = await extractFromPage(record, source);
  if (webExtraction.usable && webExtraction.html)
    return {
      outcome: {
        status: "ok",
        completeness: webExtraction.completeness,
        bodyVersion: webExtraction.version,
      },
      extraction: webExtraction,
      bodySource: "web",
    };
  return {
    outcome: {
      status: fallbackReasonStatus(webExtraction.reason),
      completeness: webExtraction.completeness,
      reason: webExtraction.reason,
    },
  };
}

/**
 * Distinguishes permanent blocks (restricted, no automatic retries) from
 * summary fallbacks (nothing broke, the source just offers no verified body).
 */
function fallbackReasonStatus(reason?: string): BodyOutcomeStatus {
  if (
    reason === "source_page_unavailable" ||
    reason === "response_not_html" ||
    reason === "extraction_failed" ||
    reason === "sanitize_dropped_content"
  )
    return "restricted";
  if (
    reason === "fetch_address_rejected" ||
    reason === "fetch_redirected_out"
  )
    return "restricted";
  if (reason?.startsWith("fetch_")) return "failed";
  return "summary";
}

/* ------------------------------------------------------------------ */
/* Single-flight and backoff                                           */
/* ------------------------------------------------------------------ */

const inFlight = new Map<string, Promise<BodyOutcome>>();

function backoffSeconds(record: ArticleRecord) {
  const next = new Date(record.bodyNextAttemptAt || "").getTime();
  if (!Number.isFinite(next)) return 0;
  return Math.max(0, Math.ceil((next - Date.now()) / 1000));
}

export async function prepareArticleBody(
  articleId: string,
  requestedMethod?: BodyMethod,
): Promise<BodyOutcome> {
  const existing = inFlight.get(articleId);
  if (existing) return existing;

  const task = (async (): Promise<BodyOutcome> => {
    const record = await getArticleRecord(articleId);
    if (!record) return { status: "failed", reason: "article_not_found" };
    const source = sourceFor(record);
    if (!source)
      return { status: "summary", reason: "source_policy_unverified" };
    const methods = requestedMethod
      ? isBodyMethodAllowed(source, record.item, requestedMethod)
        ? [requestedMethod]
        : []
      : bodyMethodsFor(source, record.item);
    if (!methods.length)
      return { status: "summary", reason: "source_policy_unverified" };
    if (
      isBodyUsable(record) &&
      (!requestedMethod || record.bodySource === requestedMethod)
    )
      return {
        status: "ok",
        completeness: record.bodyCompleteness,
        bodyVersion: record.bodyVersion,
      };
    if (record.bodyError && !record.bodyNextAttemptAt)
      return {
        status: "restricted",
        reason: record.bodyError,
        completeness: "summary",
      };
    const remainingBackoff = backoffSeconds(record);
    if (remainingBackoff > 0)
      return {
        status: "failed",
        reason: record.bodyError || "preparation_backing_off",
        retryAfterSeconds: remainingBackoff,
      };

    let prepared: Awaited<ReturnType<typeof runPreparation>> | undefined;
    for (const method of methods) {
      prepared = await runPreparation(record, source, method);
      if (
        prepared.outcome.status === "ok" ||
        prepared.outcome.status === "video" ||
        prepared.outcome.status === "interactive"
      )
        break;
    }
    const { outcome, extraction, bodySource } = prepared!;

    if (outcome.status === "ok" && extraction?.html && extraction.version) {
      await saveBodyResult(articleId, {
        bodyHtml: extraction.html,
        bodyFetchedAt: new Date().toISOString(),
        bodyVersion: extraction.version,
        bodyCompleteness: extraction.completeness,
        bodySource,
        bodySourceDigest:
          bodySource === "feed"
            ? digest(record.bodyCandidate || "")
            : digest(record.item.link),
        bodyError: null,
        bodyAttempts: 0,
        bodyNextAttemptAt: null,
      });
      return outcome;
    }

    if (outcome.status === "failed") {
      const attempts = (record.bodyAttempts || 0) + 1;
      const retryDelay = Math.min(
        60_000 * 2 ** (attempts - 1),
        MAX_BACKOFF_MS,
      );
      await saveBodyResult(articleId, {
        bodyHtml: null,
        bodyVersion: null,
        bodyCompleteness: null,
        bodySource: null,
        bodySourceDigest: null,
        bodyError: outcome.reason || "preparation_failed",
        bodyAttempts: attempts,
        bodyNextAttemptAt: new Date(Date.now() + retryDelay).toISOString(),
      });
      return {
        ...outcome,
        retryAfterSeconds: Math.ceil(retryDelay / 1000),
      };
    }

    // restricted / summary / video / interactive: record the accurate state
    // without scheduling automatic retries.
    await saveBodyResult(articleId, {
      bodyHtml: null,
      bodyVersion: null,
      bodyCompleteness: outcome.completeness || "summary",
      bodySource: null,
      bodySourceDigest: null,
      bodyError:
        outcome.status === "restricted" ? outcome.reason : null,
      bodyAttempts: 0,
      bodyNextAttemptAt: null,
    });
    return outcome;
  })().finally(() => {
    inFlight.delete(articleId);
  });

  inFlight.set(articleId, task);
  return task;
}
