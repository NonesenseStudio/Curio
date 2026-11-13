import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8000;

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

function pinnedHttpsRequest(
  url: URL,
  address: string,
  family: number,
  remainingMs: number,
) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteCount = 0;
    const request = https.request(
      {
        protocol: "https:",
        hostname: url.hostname,
        port: 443,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        agent: false,
        headers: {
          "User-Agent": "CurioReader/0.2",
          Accept:
            "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.5",
          "Accept-Encoding": "identity",
        },
        lookup: (_hostname, _options, callback) =>
          callback(null, address, family),
      },
      (response) => {
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
          reject(new Error(`HTTP ${status}`));
          return;
        }
        const length = Number(response.headers["content-length"] || 0);
        if (length > MAX_RESPONSE_BYTES) {
          response.destroy(new Error("Response too large"));
          return;
        }
        response.on("data", (chunk: Buffer) => {
          byteCount += chunk.length;
          if (byteCount > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("Response too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks)));
        response.on("error", reject);
      },
    );
    request.setTimeout(remainingMs, () =>
      request.destroy(new Error("Request timed out")),
    );
    request.on("error", reject);
    request.end();
  });
}

export async function fetchRegisteredFeed(
  urlText: string,
  allowedHosts: string[],
) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  const approved = new Set(allowedHosts.map((host) => host.toLowerCase()));
  let url = new URL(urlText);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443") ||
      !approved.has(url.hostname.toLowerCase())
    ) {
      throw new Error("Feed URL is outside the registered source hosts");
    }
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (
      !addresses.length ||
      addresses.some(({ address }) => isPrivateAddress(address))
    ) {
      throw new Error("Feed host resolved to a non-public address");
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Feed request timed out");
    try {
      return new TextDecoder("utf-8").decode(
        await pinnedHttpsRequest(
          url,
          addresses[0].address,
          addresses[0].family,
          remaining,
        ),
      );
    } catch (error) {
      const redirect = (error as { redirect?: string }).redirect;
      if (!redirect) throw error;
      if (redirects === MAX_REDIRECTS)
        throw new Error("Too many feed redirects");
      url = new URL(redirect, url);
    }
  }
  throw new Error("Unable to fetch feed");
}
