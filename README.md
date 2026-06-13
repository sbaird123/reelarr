# Reelarr

TikTok-style trailer discovery for movies and TV. Swipe through upcoming movies and trending shows, autoplay their trailers, and keep track of what you've seen.

Reelarr is the hosted, multi-user fork of [Peekarr](https://github.com/sbaird123/peekarr). Peekarr remains the fully self-hosted Docker option with Radarr/Sonarr/Jellyfin integration; Reelarr drops the LAN integrations in favour of accounts and named lists, and targets Cloudflare Workers + D1 + KV.

> **Status: Cloudflare Workers port done; accounts next.** Runs on Workers (Hono) with a KV-backed shared TMDB cache and a cron prewarm. Stateless for now — the watched list and skip history live in the browser (localStorage); the TMDB key is an app-owned secret, so there's no settings page. OAuth accounts + D1-synced watched/lists are the next phase. Full design: [docs/cloudflare-app-plan.md](docs/cloudflare-app-plan.md).

![Reelarr](docs/screenshot.png)

## Features

- Vertical swipe feed of YouTube trailers (TMDB source)
- **Movies** tab (Upcoming / Now Playing / Popular) and **TV** tab (Trending / Popular / New & Upcoming / On Air / Top Rated)
- Search bar for anything in TMDB
- "Watched" list so you don't see the same trailers again
- Soft deprioritisation of trailers you keep skipping

## Roadmap

1. ~~Port to Cloudflare Workers + KV (shared TMDB cache — traffic scales with the catalog, not with users)~~ ✅
2. OAuth accounts (Google/GitHub) with D1-synced watched/skip history across devices
3. Named watchlists — what "+ Add to Radarr" used to be becomes "Add to list"

## Architecture

- **Worker** (`src/worker.js`) — Hono app. TMDB feed/search endpoints + SSR for `/`.
- **KV** (`CACHE` binding) — shared SWR cache, keyed per built feed. A cron trigger (every 8 min) prewarms the hot lists so user requests are warm reads.
- **Assets** (`public/`) — static frontend, served by Workers Assets. The Worker runs first only for `/` to inject the initial feed.
- **Secret** — `TMDB_API_KEY`, app-owned and server-side only.

## Develop locally

```sh
npm install
cp .dev.vars.example .dev.vars   # then paste your TMDB v3 API key
npm run dev                      # wrangler dev
```

Get a free TMDB key from <https://www.themoviedb.org/settings/api>. The dev server runs on the port wrangler prints (default <http://localhost:8787>).

## Deploy

One-time setup:

```sh
npx wrangler login
npx wrangler kv namespace create CACHE      # paste the returned id into wrangler.jsonc
npx wrangler secret put TMDB_API_KEY        # paste your TMDB key (it's never committed)
npm run deploy
```

Workers Paid plan recommended (the cron trigger and request volume fit comfortably in its included usage).

## Gestures

- **Swipe up/down** — next / previous trailer
- **Single tap** — play / pause (and unmute)
- **"Watched"** / **"Skip"** buttons on each slide

## License

MIT
