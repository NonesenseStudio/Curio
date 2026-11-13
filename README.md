# Curio

Curio is a personal content magazine built with Next.js App Router and TypeScript. It brings together registered RSS and Atom feeds, keeps saved items and notes in the browser, and provides stable in-site article pages.

## Run locally

- Node.js 18.17 or later
- pnpm

```sh
pnpm install
pnpm dev
```

Open http://localhost:3000.

## Pages

- `/` — magazine layout, topic filters, search, latest list, and session-based “随便看看” selection
- `/interests` — explicit topic choices, source availability, and a map derived from saved items and linked notes
- `/collections` — saved articles and videos
- `/notes` — inspiration notes and user-started random recall
- `/settings` — hidden topics, source filters, source status, and local storage information
- `/read/[articleId]` — addressable in-site article view, source link, saving, notes, and related items

The `/review` route redirects to `/notes` for old bookmarks.

## Feed and article handling

Feed URLs are registered in `src/lib/sources.ts`. The server accepts HTTPS feeds from those registered hosts, resolves and pins public DNS addresses, limits redirects, response size, concurrency, and request time, and does not accept arbitrary fetch URLs. Feed metadata is returned separately from the source body candidate.

Every current publisher has `bodyPolicy: "unknown"`. Until a source's treatment and caching rules are checked, Curio does not expose feed body candidates or fetch publisher pages. The in-site article page therefore shows the actual feed summary with an explicit status and a “查看原文” link. YouTube items remain videos and link to YouTube; Curio does not embed a player. Do not change a source policy to allow body display or web extraction without checking the source rules and a real feed sample first.

Private feed body candidates are kept only in the server data file for up to 24 hours and capped per item. They are never returned by `/api/feed` or `/api/articles/[articleId]`. The web extraction and HTML sanitation path remains disabled until source rules, allowed hosts, and a supported server DOM dependency have been verified.

## Data and deployment

Saved items, notes, explicit interests, hidden topics and sources, and reading positions are stored in browser `localStorage`; they are not uploaded or synced. The migration reads `curio:saved:v1`, `curio:notes:v1`, and `curio:muted:v1`, writes version 2 copies, verifies the migrated results, and leaves the original keys intact.

Article metadata is stored in `.curio-data/articles-v1.json` by default. Set `CURIO_DATA_DIR` to a private persistent directory to change the location. The current store is intended for a single Node.js instance with persistent disk. Multi-instance or ephemeral hosting needs a shared database before deployment.

## Sources

Edit `src/lib/sources.ts` to add or change registered feed sources. YouTube channel feeds use the public RSS format:

`https://www.youtube.com/feeds/videos.xml?channel_id=CHANNEL_ID`

Use a channel ID rather than a display name. A public feed or publicly reachable page does not by itself establish permission to cache or display full article text.
