# Curio

Curio is a personal content magazine built with Next.js App Router and TypeScript. It brings together registered RSS and Atom feeds, keeps saved items and notes in the browser, and provides stable in-site article pages.

## Run locally

- Node.js 18.17 or later
- pnpm

```sh
pnpm install
cp .env.example .env.local
pnpm dev
```

Set `RSSHUB_BASE_URL` in `.env.local` to the HTTPS origin of the private RSSHub instance before opening Curio. Curio reports a configuration error when it is missing or invalid; it does not fall back to a public RSSHub instance or fetch a publisher feed directly.

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

Publisher identities and RSSHub route paths are registered in `src/lib/sources.ts`. Every enabled feed request goes to the configured RSSHub origin. Curio resolves and pins its public DNS addresses, checks every redirect, limits response size and request time, and does not accept arbitrary fetch URLs. Returned article links are checked against the registered publisher hosts and route path rules.

An RSSHub response, a long candidate, and a complete article are separate checks. New and replacement publishers remain on the summary state until their source rules and real article samples have been reviewed. Curio does not expose raw feed candidates. Registered article pages are fetched only for sources with a verified body policy and matching host and path rules. YouTube items remain videos and link to YouTube; Curio does not embed a player.

Raw feed candidates are kept in the private server archive for up to 24 hours, capped at 262,144 characters per article and 32 MiB across the archive. A candidate over the limit is recorded as unavailable instead of being treated as a complete body. Sanitized bodies have a separate 200,000-character limit, and known cuts are marked partial. Raw candidates and unverified HTML are never returned by `/api/feed` or `/api/articles/[articleId]`.

## Data and deployment

Saved items, notes, explicit interests, hidden topics and sources, and reading positions are stored in browser `localStorage`; they are not uploaded or synced. The migration reads `curio:saved:v1`, `curio:notes:v1`, and `curio:muted:v1`, writes version 2 copies, verifies the migrated results, and leaves the original keys intact.

Article metadata is stored in `.curio-data/articles-v1.json`; per-route last-success snapshots and retry state are stored in `.curio-data/feed-routes-v1.json`. Set `CURIO_DATA_DIR` to a private persistent directory to change the location. The current store is intended for a single Node.js instance with persistent disk. Multi-instance or ephemeral hosting needs a shared database before deployment.

## Sources

Edit `src/lib/sources.ts` to add or change registered feed routes. Keep the publisher identity and original article hosts separate from the RSSHub route. Retired publishers remain registered for saved articles and source-specific body rules but are omitted from refreshes. Do not enable body display based only on RSSHub returning a long description; check the publisher's rules and compare the candidate with the original article first.
