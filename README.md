# Reelarr

TikTok-style trailer discovery for movies and TV. Swipe through upcoming movies and trending shows, autoplay their trailers, and keep track of what you've seen.

Reelarr is the hosted, multi-user fork of [Peekarr](https://github.com/sbaird123/peekarr). Peekarr remains the fully self-hosted Docker option with Radarr/Sonarr/Jellyfin integration; Reelarr drops the LAN integrations in favour of accounts and named lists, and targets Cloudflare Workers + D1 + KV.

> **Status: Workers + accounts.** Runs on Workers (Hono) with a KV-backed shared TMDB cache and a cron prewarm. OAuth sign-in (Google + GitHub) with sessions and a per-user watched list in D1; signed out, the watched list falls back to localStorage and merges into your account on first sign-in. Skip history is still local (it wants write-batching before it goes server-side). Named watchlists are next. Full design: [docs/cloudflare-app-plan.md](docs/cloudflare-app-plan.md).

![Reelarr](docs/screenshot.png)

## Features

- Vertical swipe feed of YouTube trailers (TMDB source)
- **Movies** tab (Upcoming / Now Playing / Popular) and **TV** tab (Trending / Popular / New & Upcoming / On Air / Top Rated)
- Search bar for anything in TMDB
- "Watched" list so you don't see the same trailers again
- Soft deprioritisation of trailers you keep skipping

## Roadmap

1. ~~Port to Cloudflare Workers + KV (shared TMDB cache — traffic scales with the catalog, not with users)~~ ✅
2. ~~OAuth accounts (Google/GitHub) with D1-synced watched across devices~~ ✅
3. Named watchlists — what "+ Add to Radarr" used to be becomes "Add to list" (D1 tables exist; endpoints + UI next)
4. Move skip history server-side with write-batching

## Architecture

- **Worker** (`src/worker.js`) — Hono app. TMDB feed/search + SSR for `/`, OAuth login, sessions, per-user watched.
- **KV** (`CACHE` binding) — shared SWR cache, keyed per built feed. A cron trigger (every 8 min) prewarms the hot lists so user requests are warm reads.
- **D1** (`DB` binding) — `users`, `sessions`, `watched`, `lists`, `list_items`. Schema in `migrations/`.
- **Assets** (`public/`) — static frontend, served by Workers Assets. The Worker runs first only for `/` to inject the initial feed.
- **Secrets** — `TMDB_API_KEY` (server-side), `GOOGLE_ID`/`GOOGLE_SECRET`, `GITHUB_ID`/`GITHUB_SECRET`.

## Develop locally

```sh
npm install
cp .dev.vars.example .dev.vars                  # paste your TMDB key (+ OAuth creds to test login)
npx wrangler d1 migrations apply reelarr-db --local
npm run dev                                      # wrangler dev
```

Get a free TMDB key from <https://www.themoviedb.org/settings/api>. The dev server runs on the port wrangler prints (default <http://localhost:8787>). Sign-in needs Google/GitHub OAuth apps with `http://localhost:8787/auth/google` and `/auth/github` registered as redirect URIs.

## Deploy

One-time setup:

```sh
npx wrangler login
npx wrangler kv namespace create CACHE            # paste the returned id into wrangler.jsonc
npx wrangler d1 create reelarr-db                 # paste the returned database_id into wrangler.jsonc
npx wrangler d1 migrations apply reelarr-db --remote
npx wrangler secret put TMDB_API_KEY              # then GOOGLE_ID, GOOGLE_SECRET, GITHUB_ID, GITHUB_SECRET
npm run deploy
```

Register both providers' OAuth apps with `https://<deployed-host>/auth/google` and `/auth/github` as redirect URIs. Workers Paid plan recommended (the cron trigger and request volume fit comfortably in its included usage).

## Gestures

- **Swipe up/down** — next / previous trailer
- **Single tap** — play / pause (and unmute)
- **"Watched"** / **"Skip"** buttons on each slide

## License

MIT
