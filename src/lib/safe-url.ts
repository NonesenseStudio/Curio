function isPrivateV4(value: string) {
  const parts = value.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const [a, b, c] = parts;
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

function isLocalHost(host: string) {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  );
}

export function isSafeHttpsImage(value?: string) {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      isLocalHost(url.hostname)
    )
      return false;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) && isPrivateV4(host))
      return false;
    if (host.includes(":")) {
      if (host.startsWith("::ffff:")) {
        const mapped = host.slice(7);
        if (mapped.includes(".")) return !isPrivateV4(mapped);
        const words = mapped.split(":");
        if (
          words.length === 2 &&
          words.every((word) => /^[0-9a-f]{1,4}$/.test(word))
        ) {
          const first = Number.parseInt(words[0], 16);
          const second = Number.parseInt(words[1], 16);
          return !isPrivateV4(
            `${first >>> 8}.${first & 255}.${second >>> 8}.${second & 255}`,
          );
        }
        return false;
      }
      if (
        host === "::" ||
        host === "::1" ||
        host.startsWith("::") ||
        /^(fc|fd|fe[89a-f]|ff)/.test(host) ||
        host.startsWith("2001:db8:") ||
        host.startsWith("64:ff9b:")
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function safeYouTubeUrl(value?: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(
        host,
      )
      ? url.href
      : "";
  } catch {
    return "";
  }
}
