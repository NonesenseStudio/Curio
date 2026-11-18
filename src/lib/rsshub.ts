import type { FeedRoute } from "./sources";

export class RSSHubConfigurationError extends Error {
  readonly category = "configuration" as const;

  constructor(message: string) {
    super(message);
    this.name = "RSSHubConfigurationError";
  }
}

export function getRSSHubBaseUrl() {
  const configured = process.env.RSSHUB_BASE_URL?.trim();
  if (!configured)
    throw new RSSHubConfigurationError("RSSHUB_BASE_URL is not configured");

  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new RSSHubConfigurationError("RSSHUB_BASE_URL is invalid");
  }

  if (
    url.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  )
    throw new RSSHubConfigurationError(
      "RSSHUB_BASE_URL must be an HTTPS origin",
    );

  return url.origin;
}

export function rssHubRouteUrl(route: FeedRoute) {
  if (!route.path.startsWith("/") || route.path.startsWith("//"))
    throw new RSSHubConfigurationError(
      "Registered RSSHub route path is invalid",
    );
  const url = new URL(`${getRSSHubBaseUrl()}${route.path}`);
  url.searchParams.set("limit", String(route.limit || 10));
  return url;
}
