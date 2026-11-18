import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";

const MAX_REDIRECTS = 3;
/** Transport-level response cap in bytes (distinct from persistence limits). */
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const FEED_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 12000;

/**
 * Classification of why a registered fetch failed. The UI shows short copy;
 * diagnostics may surface the category per source without dumping raw errors.
 */
export type FetchFailureCategory =
  | "address_rejected"
  | "timeout"
  | "http_status"
  | "too_large"
  | "redirected_out"
  | "fetch_failed";

export type FetchFailure = Error & {
  category?: FetchFailureCategory;
  detail?: string;
};

export function fetchFailureCategory(error: unknown): FetchFailureCategory {
  const category = (error as FetchFailure | undefined)?.category;
  return category || "fetch_failed";
}

export type FetchedResponse = {
  status: number;
  contentType: string;
  body: string;
  /** True when the transport cap cut the body before the end of the stream. */
  truncated: boolean;
};

function isPrivateAddress(address: string) {
  const value = address.toLowerCase().split("%")[0];
  const version = isIP(value);
  if (version === 4) {
    const octets = value.split(".").map(Number);
    const [a, b, c] = octets;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (version !== 6) return true;
  if (value.startsWith("::ffff:")) {
    const mapped = value.slice(7);
    if (isIP(mapped) === 4) return isPrivateAddress(mapped);
    const words = mapped.split(":");
    if (
      words.length === 2 &&
      words.every((word) => /^[0-9a-f]{1,4}$/.test(word))
    ) {
      const first = Number.parseInt(words[0], 16);
      const second = Number.parseInt(words[1], 16);
      return isPrivateAddress(
        `${first >>> 8}.${first & 255}.${second >>> 8}.${second & 255}`,
      );
    }
    return true;
  }
  if (
    value === "::" ||
    value === "::1" ||
    value.startsWith("::") ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    value.startsWith("fe8") ||
    value.startsWith("fe9") ||
    value.startsWith("fea") ||
    value.startsWith("feb") ||
    value.startsWith("fec") ||
    value.startsWith("fed") ||
    value.startsWith("fee") ||
    value.startsWith("fef") ||
    value.startsWith("ff")
  )
    return true;
  if (value.startsWith("64:ff9b:") || value.startsWith("2001:db8:"))
    return true;
  return false;
}

function failure(
  message: string,
  category: FetchFailureCategory,
  detail?: string,
) {
  return Object.assign(new Error(message), { category, detail });
}

/**
 * Resolves a hostname to public addresses without weakening validation.
 * The system resolver is tried first. When it only returns addresses inside
 * reserved or carrier-grade NAT ranges (for example 198.18.0.0/16 used by
 * VPN "fake-IP" DNS mappings), the name is re-resolved over DNS-over-HTTPS
 * through a fixed public resolver, and the resulting addresses go through
 * the same reserved-range rejection as before. Reserved addresses are never
 * allowed through.
 */
async function resolvePublicAddresses(hostname: string) {
  try {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    const publicAddresses = addresses.filter(
      ({ address }) => !isPrivateAddress(address),
    );
    if (publicAddresses.length) return publicAddresses;
  } catch {
    /* Fall through to DNS-over-HTTPS resolution. */
  }
  const resolved = await resolveOverHttps(hostname);
  const publicAddresses = resolved.filter(
    ({ address }) => !isPrivateAddress(address),
  );
  if (!publicAddresses.length)
    throw failure(
      "Host resolved to a non-public address",
      "address_rejected",
      hostname,
    );
  return publicAddresses;
}

type DohAnswer = { data?: string; type?: number };
type DohResult = { Answer?: DohAnswer[] };

/** Fixed public resolvers; the first connects to a literal public IP. */
const DOH_RESOLVERS = [
  { host: "1.1.1.1", pinnedAddress: "1.1.1.1", servername: "cloudflare-dns.com" },
  { host: "cloudflare-dns.com", pinnedAddress: undefined, servername: undefined },
];

function lookupFor(address: string, family: number) {
  return (
    _hostname: string,
    options: { all?: boolean } | number,
    callback: (
      error: NodeJS.ErrnoException | null,
      result: string | { address: string; family: number }[],
      family?: number,
    ) => void,
  ) => {
    if (typeof options === "object" && options.all)
      callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

async function dohQuery(resolver: (typeof DOH_RESOLVERS)[number], name: string, type: "A" | "AAAA") {
  const path = `/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
  return new Promise<DohResult>((resolve, reject) => {
    const request = https.request(
      {
        protocol: "https:",
        hostname: resolver.host,
        port: 443,
        path,
        method: "GET",
        agent: false,
        servername: resolver.servername,
        headers: {
          accept: "application/dns-json",
          "User-Agent": "CurioReader/0.3",
        },
        // The first resolver connects to a known literal public address.
        ...(resolver.pinnedAddress
          ? { lookup: lookupFor(resolver.pinnedAddress, 4) }
          : {}),
      },
      (response) => {
        if ((response.statusCode || 0) !== 200) {
          response.resume();
          reject(new Error(`DoH HTTP ${response.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new Error("DoH response was not valid JSON"));
          }
        });
        response.on("error", reject);
      },
    );
    request.setTimeout(5000, () =>
      request.destroy(new Error("DoH request timed out")),
    );
    request.on("error", reject);
    request.end();
  });
}

async function resolveOverHttps(name: string) {
  for (const resolver of DOH_RESOLVERS) {
    try {
      for (const type of ["A", "AAAA"] as const) {
        const answer = (await dohQuery(resolver, name, type))?.Answer || [];
        const addresses = answer
          .filter((entry) => typeof entry.data === "string")
          .map((entry) => ({
            address: entry.data as string,
            family: type === "A" ? 4 : 6,
          }));
        if (addresses.length) return addresses;
      }
    } catch {
      /* Try the next resolver. */
    }
  }
  throw failure(
    "Host could not be resolved to a public address",
    "address_rejected",
    name,
  );
}

function pinnedHttpsRequest(
  url: URL,
  address: string,
  family: number,
  remainingMs: number,
  acceptHeader: string,
  signal?: AbortSignal,
): Promise<{ body: Buffer; truncated: boolean; contentType: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    let truncated = false;
    const request = https.request(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: 443,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        agent: false,
        headers: {
          "User-Agent": "CurioReader/0.3",
          Accept: acceptHeader,
          "Accept-Encoding": "identity",
        },
        // A custom lookup must honour the `all` option: newer Node versions
        // enable autoSelectFamily and expect an address list in that case.
        lookup: lookupFor(address, family),
      },
      (response) => {
        const contentType = String(response.headers["content-type"] || "");
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          reject(
            Object.assign(new Error("redirect"), {
              redirect: response.headers.location,
            }),
          );
          return;
        }
        if (status < 200 || status >= 300) {
          response.resume();
          reject(failure(`HTTP ${status}`, "http_status", String(status)));
          return;
        }
        const length = Number(response.headers["content-length"] || 0);
        if (length > MAX_RESPONSE_BYTES) {
          response.resume();
          reject(failure("Response too large", "too_large"));
          return;
        }
        response.on("data", (chunk: Buffer) => {
          byteCount += chunk.length;
          if (byteCount > MAX_RESPONSE_BYTES) {
            // Keep what arrived and report truncation instead of discarding;
            // callers decide whether a truncated payload is usable.
            truncated = true;
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({ body: Buffer.concat(chunks), truncated, contentType }),
        );
        response.on("close", () => {
          if (truncated)
            resolve({ body: Buffer.concat(chunks), truncated: true, contentType });
        });
        response.on("error", (error) => {
          if (truncated)
            resolve({ body: Buffer.concat(chunks), truncated: true, contentType });
          else reject(error);
        });
      },
    );
    const abort = () =>
      request.destroy(failure("Request timed out", "timeout"));
    const cleanup = () => signal?.removeEventListener("abort", abort);
    request.on("error", (error) => {
      reject(
        failure(
          (error as Error).message || "Request failed",
          (error as FetchFailure).category || "fetch_failed",
        ),
      );
    });
    request.once("close", cleanup);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    request.setTimeout(remainingMs, () =>
      request.destroy(failure("Request timed out", "timeout")),
    );
    request.end();
  });
}

type RegisteredFetchOptions = {
  timeoutMs: number;
  acceptHeader: string;
  signal?: AbortSignal;
};

async function fetchRegistered(
  urlText: string,
  allowedHosts: string[],
  options: RegisteredFetchOptions,
): Promise<FetchedResponse> {
  const deadline = Date.now() + options.timeoutMs;
  const approved = new Set(allowedHosts.map((host) => host.toLowerCase()));
  let url = new URL(urlText);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (options.signal?.aborted)
      throw failure("Request timed out", "timeout");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !approved.has(url.hostname.toLowerCase())
    ) {
      throw failure(
        "URL is outside the registered source hosts",
        "redirected_out",
        url.hostname,
      );
    }
    const addresses = await resolvePublicAddresses(url.hostname);
    if (options.signal?.aborted)
      throw failure("Request timed out", "timeout");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw failure("Request timed out", "timeout");
    try {
      const { body, truncated, contentType } = await pinnedHttpsRequest(
        url,
        addresses[0].address,
        addresses[0].family,
        remaining,
        options.acceptHeader,
        options.signal,
      );
      return {
        status: 200,
        contentType,
        body: new TextDecoder("utf-8").decode(body),
        truncated,
      };
    } catch (error) {
      const redirect = (error as { redirect?: string }).redirect;
      if (!redirect) throw error;
      if (redirects === MAX_REDIRECTS)
        throw failure("Too many redirects", "redirected_out");
      url = new URL(redirect, url);
    }
  }
  throw failure("Unable to fetch resource", "fetch_failed");
}

/** Fetches an RSS/Atom document from a registered source host. */
export async function fetchRegisteredFeed(
  urlText: string,
  allowedHosts: string[],
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  return fetchRegistered(urlText, allowedHosts, {
    timeoutMs: options.timeoutMs || FEED_TIMEOUT_MS,
    signal: options.signal,
    acceptHeader:
      "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5",
  });
}

const HTML_TYPES = /text\/html|application\/xhtml\+xml/i;

/**
 * Fetches an article page from a host registered for that source. The initial
 * host must be approved; each redirect hop is validated against the same set.
 * Callers must confirm the payload is HTML (see looksLikeHtml) before
 * treating it as a document.
 */
export async function fetchRegisteredPage(
  urlText: string,
  allowedHosts: string[],
): Promise<FetchedResponse> {
  return fetchRegistered(urlText, allowedHosts, {
    timeoutMs: PAGE_TIMEOUT_MS,
    acceptHeader: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
  });
}

export function looksLikeHtml(body: string, contentType = "") {
  return (
    HTML_TYPES.test(contentType) ||
    /<!doctype html|<html[\s>]|<body[\s>]/i.test(body.slice(0, 2000))
  );
}
