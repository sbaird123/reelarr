import { Hono } from 'hono';

// ── TMDB ──────────────────────────────────────────────────────────────────────
const TMDB = 'https://api.themoviedb.org/3';

// Policies: list endpoints refresh often; search is short-lived. (Per-id
// metadata used to have its own long policy, but we now cache whole built
// feeds rather than individual TMDB sub-responses — see cachedFeed.)
const POLICY_LIST   = { freshTtl: 10 * 60_000, staleTtl: 60 * 60_000 }; // 10m fresh / 1h stale
const POLICY_SEARCH = { freshTtl:  5 * 60_000, staleTtl: 30 * 60_000 };

// Per-isolate dedup of concurrent identical builds. Module-level state persists
// for an isolate's lifetime — it can't dedup across isolates (that's what the
// cron-warmed KV cache is for), but it stops a burst of same-key requests in
// one isolate from each firing their own TMDB fan-out.
const inFlight = new Map();

function fetchTimeout(url, opts = {}, ms = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(timer));
}

async function tmdbRaw(env, endpoint, params = {}) {
  const key = env.TMDB_API_KEY;
  if (!key) throw new Error('TMDB API key not configured — set the TMDB_API_KEY secret');
  const url = new URL(`${TMDB}${endpoint}`);
  url.searchParams.set('api_key', key);
  url.searchParams.set('language', 'en-US');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchTimeout(url.toString());
  if (!res.ok) throw new Error(`TMDB ${res.status}: ${res.statusText}`);
  return res.json();
}

// ── KV-backed SWR cache ───────────────────────────────────────────────────────
// Store { v, soft, hard }. Serve fresh instantly; serve stale instantly while
// rebuilding in the background (via ctx.waitUntil); rebuild synchronously on a
// hard miss. KV's own TTL is set to the hard expiry so stale entries self-evict.
async function cacheGet(env, key) {
  try { return await env.CACHE.get(key, { type: 'json' }); }
  catch { return null; }
}

async function cachePut(env, key, value, policy) {
  const now = Date.now();
  const entry = { v: value, soft: now + policy.freshTtl, hard: now + policy.freshTtl + policy.staleTtl };
  // KV expirationTtl floor is 60s; our policies are all well above that.
  const ttlSec = Math.max(60, Math.ceil((policy.freshTtl + policy.staleTtl) / 1000));
  try { await env.CACHE.put(key, JSON.stringify(entry), { expirationTtl: ttlSec }); }
  catch { /* cache write is best-effort */ }
}

// Wrap a builder in SWR semantics against KV.
async function swr(env, ctx, key, policy, builder) {
  const now = Date.now();
  const entry = await cacheGet(env, key);
  if (entry && entry.hard > now) {
    if (entry.soft <= now && !inFlight.has(key)) {
      const p = builder()
        .then((v) => cachePut(env, key, v, policy))
        .finally(() => inFlight.delete(key));
      inFlight.set(key, p);
      ctx.waitUntil(p);
    }
    return entry.v;
  }
  // Hard miss — dedup concurrent builds within this isolate.
  if (inFlight.has(key)) return inFlight.get(key);
  const p = builder().finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  const v = await p;
  ctx.waitUntil(cachePut(env, key, v, policy));
  return v;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function poster(p)   { return p ? `https://image.tmdb.org/t/p/w500${p}` : null; }
function backdrop(p) { return p ? `https://image.tmdb.org/t/p/w780${p}` : null; }

function pickTrailer(videos) {
  if (!videos || !Array.isArray(videos.results)) return null;
  // Prefer Trailer > Teaser; official flagged first.
  const youtubes = videos.results.filter((v) => v.site === 'YouTube');
  const trailer = youtubes.find((v) => v.type === 'Trailer' && v.official)
               || youtubes.find((v) => v.type === 'Trailer')
               || youtubes.find((v) => v.type === 'Teaser');
  return trailer || null;
}

// ── Feed builders ─────────────────────────────────────────────────────────────
async function buildMovieFeed(env, { list, page }) {
  const data = await tmdbRaw(env, `/movie/${list}`, { page });
  let movies = data.results || [];
  // TMDB's /movie/upcoming happily returns old re-releases and indie second
  // runs — drop anything that's already out so "Upcoming" actually means it.
  if (list === 'upcoming') {
    const today = new Date().toISOString().slice(0, 10);
    movies = movies.filter((m) => m.release_date && m.release_date >= today);
  }
  const enriched = await Promise.all(movies.map(async (movie) => {
    try {
      const videos = await tmdbRaw(env, `/movie/${movie.id}/videos`);
      const trailer = pickTrailer(videos);
      if (!trailer) return null;
      return {
        id: movie.id,
        title: movie.title,
        overview: movie.overview,
        release_date: movie.release_date,
        poster_path: poster(movie.poster_path),
        backdrop_path: backdrop(movie.backdrop_path),
        vote_average: movie.vote_average,
        youtube_key: trailer.key,
        media_type: 'movie',
      };
    } catch { return null; }
  }));
  return {
    results: enriched.filter(Boolean),
    total_pages: data.total_pages,
    page: data.page,
  };
}

async function buildTvFeed(env, { list, page }) {
  // TMDB has no /tv/upcoming — synthesize "New & Upcoming" via /discover/tv
  // filtered to shows first-airing from 45 days ago onward, sorted by
  // popularity (covers both just-premiered and not-yet-aired).
  let data;
  if (list === 'trending') {
    data = await tmdbRaw(env, '/trending/tv/week', { page });
  } else if (list === 'new_upcoming') {
    const start = new Date();
    start.setDate(start.getDate() - 45);
    data = await tmdbRaw(env, '/discover/tv', {
      page,
      'first_air_date.gte': start.toISOString().slice(0, 10),
      sort_by: 'popularity.desc',
    });
  } else {
    data = await tmdbRaw(env, `/tv/${list}`, { page });
  }
  const shows = data.results || [];
  const enriched = await Promise.all(shows.map(async (show) => {
    try {
      const videos = await tmdbRaw(env, `/tv/${show.id}/videos`);
      const trailer = pickTrailer(videos);
      if (!trailer) return null;
      return {
        id: show.id,
        title: show.name,
        overview: show.overview,
        release_date: show.first_air_date,
        poster_path: poster(show.poster_path),
        backdrop_path: backdrop(show.backdrop_path),
        vote_average: show.vote_average,
        youtube_key: trailer.key,
        media_type: 'tv',
      };
    } catch { return null; }
  }));
  return {
    results: enriched.filter(Boolean),
    total_pages: data.total_pages,
    page: data.page,
  };
}

async function buildSearch(env, kind, q) {
  const data = await tmdbRaw(env, `/search/${kind}`, { query: q });
  const items = (data.results || []).slice(0, 20);
  const enriched = await Promise.all(items.map(async (it) => {
    try {
      const videos = await tmdbRaw(env, `/${kind}/${it.id}/videos`);
      const trailer = pickTrailer(videos);
      return {
        id: it.id,
        title: kind === 'tv' ? it.name : it.title,
        overview: it.overview,
        release_date: kind === 'tv' ? it.first_air_date : it.release_date,
        poster_path: poster(it.poster_path),
        backdrop_path: backdrop(it.backdrop_path),
        vote_average: it.vote_average,
        youtube_key: trailer ? trailer.key : null,
        media_type: kind === 'tv' ? 'tv' : 'movie',
      };
    } catch { return null; }
  }));
  return { results: enriched.filter(Boolean) };
}

// ── Cache key + feed wrappers ─────────────────────────────────────────────────
function feedKey(kind, list, page) { return `feed:${kind}:${list}:${page}`; }

function cachedMovieFeed(env, ctx, list, page) {
  return swr(env, ctx, feedKey('movie', list, page), POLICY_LIST,
    () => buildMovieFeed(env, { list, page }));
}
function cachedTvFeed(env, ctx, list, page) {
  return swr(env, ctx, feedKey('tv', list, page), POLICY_LIST,
    () => buildTvFeed(env, { list, page }));
}
function cachedSearch(env, ctx, kind, q) {
  return swr(env, ctx, `search:${kind}:${encodeURIComponent(q)}`, POLICY_SEARCH,
    () => buildSearch(env, kind, q));
}

// ── Prewarm (cron) ──────────────────────────────────────────────────────────
const WARM_LISTS = [
  { kind: 'movie', list: 'upcoming'    },
  { kind: 'movie', list: 'now_playing' },
  { kind: 'movie', list: 'popular'     },
  { kind: 'tv',    list: 'trending'     },
  { kind: 'tv',    list: 'popular'      },
  { kind: 'tv',    list: 'new_upcoming' },
  { kind: 'tv',    list: 'on_the_air'   },
  { kind: 'tv',    list: 'top_rated'    },
];

async function prewarm(env) {
  if (!env.TMDB_API_KEY) return;
  const start = Date.now();
  let ok = 0, fail = 0;
  // Serial across lists to avoid bursting TMDB's rate limit. Each list's TMDB
  // fan-out is still parallel inside the builder.
  for (const { kind, list } of WARM_LISTS) {
    try {
      const payload = kind === 'movie'
        ? await buildMovieFeed(env, { list, page: 1 })
        : await buildTvFeed(env, { list, page: 1 });
      await cachePut(env, feedKey(kind, list, 1), payload, POLICY_LIST);
      ok++;
    } catch (e) {
      fail++;
      console.warn(`[prewarm] ${kind}/${list}: ${e.message}`);
    }
  }
  console.log(`[prewarm] ${ok}/${ok + fail} lists warmed in ${Date.now() - start}ms`);
}

// ── App ─────────────────────────────────────────────────────────────────────
const app = new Hono();

function safeJson(obj) {
  // Prevent `</script>` injection when inlining JSON into HTML.
  return JSON.stringify(obj ?? null).replace(/</g, '\\u003c');
}

// SSR for / — inject an initial feed so the first paint isn't a blank swiper.
// The cron keeps feed:movie:upcoming:1 warm, so this is usually one KV read.
app.get('/', async (c) => {
  const ctx = c.executionCtx;
  let initialFeed = null;
  try {
    // Short budget — if TMDB is cold and slow, don't hold up first paint; the
    // client falls back to a normal fetch when __INITIAL_FEED__ is null.
    initialFeed = await Promise.race([
      cachedMovieFeed(c.env, ctx, 'upcoming', 1),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
  } catch {}

  const assetRes = await c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url)));
  let html = await assetRes.text();
  const boot = `<script>
window.__INITIAL_FEED__ = ${safeJson(initialFeed)};
window.__INITIAL_LIST__ = "upcoming";
</script>`;
  html = html.replace('</body>', `${boot}\n</body>`);
  return c.html(html);
});

// ── Feed routes ──────────────────────────────────────────────────────────────
app.get('/api/feed', async (c) => {
  try {
    const list = c.req.query('list') || 'upcoming';
    const page = c.req.query('page') || 1;
    const payload = await cachedMovieFeed(c.env, c.executionCtx, list, page);
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(payload);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/api/shows/feed', async (c) => {
  try {
    const list = c.req.query('list') || 'trending';
    const page = c.req.query('page') || 1;
    const payload = await cachedTvFeed(c.env, c.executionCtx, list, page);
    c.header('Cache-Control', 'public, max-age=60');
    return c.json(payload);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/api/search', async (c) => {
  try {
    const q = c.req.query('q');
    if (!q) return c.json({ results: [] });
    const payload = await cachedSearch(c.env, c.executionCtx, 'movie', q);
    c.header('Cache-Control', 'public, max-age=120');
    return c.json(payload);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/api/shows/search', async (c) => {
  try {
    const q = c.req.query('q');
    if (!q) return c.json({ results: [] });
    const payload = await cachedSearch(c.env, c.executionCtx, 'tv', q);
    c.header('Cache-Control', 'public, max-age=120');
    return c.json(payload);
  } catch (err) {
    return c.json({ error: err.message }, 500);
  }
});

app.get('/api/health', (c) => c.json({ tmdb: !!c.env.TMDB_API_KEY }));

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(prewarm(env));
  },
};
