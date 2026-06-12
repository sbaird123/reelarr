# Reelarr

TikTok-style trailer discovery for movies and TV. Swipe through upcoming movies and trending shows, autoplay their trailers, and keep track of what you've seen.

Reelarr is the hosted, multi-user fork of [Peekarr](https://github.com/sbaird123/peekarr). Peekarr remains the fully self-hosted Docker option with Radarr/Sonarr/Jellyfin integration; Reelarr drops the LAN integrations in favour of accounts and named lists, and targets Cloudflare Workers + D1 + KV.

> **Status: pre-port.** The current code is the stripped-down Node/Express core inherited from Peekarr — TMDB feeds, SSR, watched list, skip history. The Cloudflare port, OAuth accounts, and lists come next. The full design lives in [docs/cloudflare-app-plan.md](docs/cloudflare-app-plan.md).

![Reelarr](docs/screenshot.png)

## Features

- Vertical swipe feed of YouTube trailers (TMDB source)
- **Movies** tab (Upcoming / Now Playing / Popular) and **TV** tab (Trending / Popular / New & Upcoming / On Air / Top Rated)
- Search bar for anything in TMDB
- "Watched" list so you don't see the same trailers again
- Soft deprioritisation of trailers you keep skipping

## Roadmap

1. Port to Cloudflare Workers + D1 + KV (shared TMDB cache — traffic scales with the catalog, not with users)
2. OAuth accounts (Google/GitHub) with synced watched/skip history across devices
3. Named watchlists — what "+ Add to Radarr" used to be becomes "Add to list"

## Develop locally

```sh
npm install
cp .env.example .env    # optional — settings UI works without this
npm run dev
```

Runs on <http://localhost:3000>. Node 20+ required. Open <http://localhost:3000/settings> and add a **TMDB API key** (free from <https://www.themoviedb.org/settings/api>), then visit `/` and start swiping.

## Gestures

- **Swipe up/down** — next / previous trailer
- **Single tap** — play / pause (and unmute)
- **"Watched"** / **"Skip"** buttons on each slide

## License

MIT
