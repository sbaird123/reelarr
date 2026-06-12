# Peekarr Cloud — Cloudflare standalone app plan

Status: idea / pre-fork design notes (June 2026). The plan is to fork Peekarr into a
hosted multi-user app on Cloudflare. This doc captures the architecture discussion so
work can start fresh in the fork.

## Vision

A hosted version of Peekarr: TikTok-style trailer discovery with **user accounts**, so
watched lists, skip history, and named watchlists follow you across devices. Free to
use, donation-supported. The existing Docker image remains the fully self-hosted option.

## What ports cleanly

| Current (self-hosted) | Cloud version |
|---|---|
| Express | Hono on Workers (routes port almost mechanically) |
| better-sqlite3 | D1 (same SQLite dialect; schema/queries survive, driver API changes) |
| In-process SWR caches (`tmdbCache`, `statusCache`, `inFlight`) | KV + Cache API — isolates are evicted, so module-level Maps don't work. **This is the one real redesign.** |
| `setInterval` prewarm | Cron Triggers (keeps the shared cache warm for everyone) |
| Per-user TMDB API key | One app-owned TMDB key, server-side only |
| SSR for `/` | Same pattern on Workers; static assets via Workers Assets |
| node-fetch | Native fetch |

Shared caching is the structural win: thousands of users browsing "Popular" hit the
same cached TMDB entries, so TMDB traffic scales with the catalog, not with users.

## Accounts

- **Auth: OAuth (Google/GitHub) + signed session cookie, sessions in D1.** Least code,
  no password storage, right fit for the homelab audience. (Magic links = second choice,
  needs an email sender. Passwords = skip.)
- Schema: `users`, `sessions`; existing `watched` gains `user_id`; new `lists` /
  `list_items` for named watchlists.
- **Move skip history from localStorage into D1** — the hidden win of accounts: skip
  deprioritization follows you across phone/TV/laptop.
- **Batch skip writes** (flush every ~10 swipes or on tab-hide). Per-swipe writes are
  the fastest-growing cost line; batching cuts D1 writes ~10x.

## The catch: Radarr/Sonarr/Jellyfin live on the user's LAN

A Worker cannot reach `http://radarr:7878`. Three options considered:

- **A. Drop them** — cloud version is discovery + watchlists only. Cleanest, but loses
  what makes Peekarr Peekarr.
- **B. Cloudflare Tunnel per user** — works, but the cloud then stores everyone's *arr
  API keys (the key-leak class we just fixed, at scale) and setup friction excludes
  most users.
- **C. Connector agent (CHOSEN).** Tiny Docker container on the user's LAN, paired to
  the cloud account via one-time code. Inverts the flow: "+ Add to Radarr" writes a row
  to a `pending_adds` queue in D1; the agent polls (or WebSockets via a Durable Object),
  executes against Radarr/Sonarr locally, reports library status back. Jellyfin Play On
  relays the same way. **Keys never leave the user's house** — cloud only sees
  "user X wants movie Y". Degrades gracefully: no agent paired → button is
  "Add to watchlist".

## Phasing

1. **Phase 1:** Workers + D1 + KV port, OAuth accounts, synced watched/skips/watchlists.
   No *arr integration. Moderate, mostly-mechanical port; the cache layer is the redesign,
   auth is the new subsystem.
2. **Phase 2:** Connector agent + pairing + pending-action queue. Smaller in code than it
   sounds; the effort concentrates in pairing security, agent update story, status sync
   cadence. Polling every 30–60s is nearly free; DO WebSocket hibernation also cheap.
3. Existing Docker Peekarr stays maintained. Frontend + TMDB/feed logic are shareable;
   versions differ in storage driver and the *arr path — structure the port with a shared
   core in mind.

## Scaling & cost math (June 2026 pricing)

Model: 2,000 DAU, one ~10-min session/day, ~50 swipes.

- **D1 reads:** ~500 rows/session start → ~30M/month vs **25 billion included**. Unmeterable.
- **D1 writes:** unbatched skips = ~3M/month vs **50M included**; batching gives 10x headroom.
- **Worker requests:** ~30 API calls/session → ~1.8M/month vs 10M included (static assets free).
- **KV:** prewarmed hot lists + free Cache API → a dollar or two of overage at most.

| DAU | Monthly cost |
|---|---|
| 2,000 | $5 (base Workers paid plan) |
| 10,000 | $5–10 |
| 50,000 | $15–40 |

Plus ~$10/yr domain. **Donations cover this easily** — one $5/month sponsor covers the
bill past 10k users.

## Risks / open questions

- **TMDB terms:** free API is non-commercial + attribution. Donation-supported free app
  generally fits, but re-read their terms once there are real users — irreplaceable upstream.
- **D1 write ceiling:** single SQLite instance, serialized writes. Far away with batching;
  would force per-user sharding only at tens-of-thousands of DAU.
- **D1 size cap:** 10GB/database. ~1–2k small rows per user → hundreds of thousands of
  accounts fit, with skip-history pruning (already done client-side today) keeping it bounded.
- **Operational cost is human, not infra:** abuse handling, account support. The real
  question is wanting to run a service for strangers, not affording it.
- Open: name/domain for the hosted version; whether Phase 1 keeps a "bring your own
  Radarr URL" escape hatch for tunnel power-users (leaning no — agent only).
