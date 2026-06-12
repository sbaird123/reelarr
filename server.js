require('dotenv').config();
const express = require('express');
const compression = require('compression');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ── Paths & Database ──────────────────────────────────────────────────────────
const CONFIG_DIR = process.env.CONFIG_DIR || __dirname;
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

const db = new Database(path.join(CONFIG_DIR, 'data.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS watched (
    tmdb_id    INTEGER NOT NULL,
    media_type TEXT    NOT NULL DEFAULT 'movie',
    title      TEXT,
    watched_at TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (tmdb_id, media_type)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

const stmtInsertWatched = db.prepare(
  `INSERT OR IGNORE INTO watched (tmdb_id, media_type, title) VALUES (?, ?, ?)`
);
const stmtDeleteWatched = db.prepare(
  `DELETE FROM watched WHERE tmdb_id = ? AND media_type = ?`
);
const stmtGetWatchedIds = db.prepare(
  `SELECT tmdb_id, media_type FROM watched`
);
const stmtGetSetting = db.prepare(`SELECT value FROM settings WHERE key = ?`);
const stmtSetSetting = db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`
);

// ── Settings ──────────────────────────────────────────────────────────────────
const SETTING_KEYS = [
  'tmdb_api_key',
];

const envDefaults = {
  tmdb_api_key: process.env.TMDB_API_KEY || '',
};

function getSetting(key) {
  const row = stmtGetSetting.get(key);
  if (row && row.value) return row.value;
  return envDefaults[key] || '';
}

function setSetting(key, value) {
  stmtSetSetting.run(key, value == null ? '' : String(value));
}

function allSettings() {
  const out = {};
  for (const key of SETTING_KEYS) out[key] = getSetting(key);
  return out;
}

// ── SWR LRU cache ─────────────────────────────────────────────────────────────
// Serve fresh values instantly; serve stale values instantly while refreshing
// in the background. Dedupe in-flight requests per key.
class SWRCache {
  constructor(max = 5000) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return null;
    if (Date.now() > e.hardExpire) { this.map.delete(key); return null; }
    this.map.delete(key);
    this.map.set(key, e);
    return e;
  }
  set(key, value, { freshTtl, staleTtl }) {
    if (this.map.size >= this.max && !this.map.has(key)) {
      this.map.delete(this.map.keys().next().value);
    }
    const now = Date.now();
    this.map.set(key, {
      value,
      softExpire: now + freshTtl,
      hardExpire: now + freshTtl + staleTtl,
    });
  }
  stats() {
    return { size: this.map.size };
  }
}

const tmdbCache = new SWRCache(5000);
const inFlight = new Map();

// ── TMDB ──────────────────────────────────────────────────────────────────────
const TMDB = 'https://api.themoviedb.org/3';

// Policies: list endpoints refresh often; per-id metadata is essentially static.
const POLICY_LIST   = { freshTtl: 10 * 60_000,   staleTtl: 60 * 60_000   }; // 10m fresh / 1h stale
const POLICY_STATIC = { freshTtl:  6 * 60 * 60_000, staleTtl: 48 * 60 * 60_000 }; // 6h / 48h
const POLICY_SEARCH = { freshTtl:  5 * 60_000,   staleTtl: 30 * 60_000   };

function fetchTimeout(url, opts = {}, ms = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(timer));
}

async function tmdbRaw(endpoint, params = {}) {
  const key = getSetting('tmdb_api_key');
  if (!key) throw new Error('TMDB API key not configured — open Settings');
  const url = new URL(`${TMDB}${endpoint}`);
  url.searchParams.set('api_key', key);
  url.searchParams.set('language', 'en-US');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchTimeout(url.toString());
  if (!res.ok) throw new Error(`TMDB ${res.status}: ${res.statusText}`);
  return res.json();
}

async function tmdb(endpoint, params = {}, policy = POLICY_STATIC) {
  const cacheKey = endpoint + (Object.keys(params).length
    ? '?' + new URLSearchParams(params).toString() : '');
  const now = Date.now();
  const entry = tmdbCache.get(cacheKey);

  if (entry && entry.hardExpire > now) {
    // Stale-while-revalidate: kick off a refresh if past freshness.
    if (entry.softExpire <= now && !inFlight.has(cacheKey)) {
      const p = tmdbRaw(endpoint, params)
        .then((v) => { tmdbCache.set(cacheKey, v, policy); inFlight.delete(cacheKey); })
        .catch(() => { inFlight.delete(cacheKey); });
      inFlight.set(cacheKey, p);
    }
    return entry.value;
  }

  // Miss — dedupe concurrent requests for the same key.
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);
  const promise = tmdbRaw(endpoint, params)
    .then((v) => { tmdbCache.set(cacheKey, v, policy); inFlight.delete(cacheKey); return v; })
    .catch((err) => { inFlight.delete(cacheKey); throw err; });
  inFlight.set(cacheKey, promise);
  return promise;
}

// ── URL helpers ───────────────────────────────────────────────────────────────
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

// ── Feed builders (reusable by routes + SSR + prewarm) ───────────────────────
async function buildMovieFeed({ list, page }) {
  const data = await tmdb(`/movie/${list}`, { page }, POLICY_LIST);
  let movies = data.results || [];
  // TMDB's /movie/upcoming happily returns old re-releases and indie second
  // runs — drop anything that's already out so "Upcoming" actually means it.
  if (list === 'upcoming') {
    const today = new Date().toISOString().slice(0, 10);
    movies = movies.filter((m) => m.release_date && m.release_date >= today);
  }
  const enriched = await Promise.all(movies.map(async (movie) => {
    try {
      const videos = await tmdb(`/movie/${movie.id}/videos`, {}, POLICY_STATIC);
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

async function buildTvFeed({ list, page }) {
  // TMDB has no /tv/upcoming — synthesize "New & Upcoming" via /discover/tv
  // filtered to shows first-airing from 45 days ago onward, sorted by
  // popularity (covers both just-premiered and not-yet-aired).
  let data;
  if (list === 'trending') {
    data = await tmdb('/trending/tv/week', { page }, POLICY_LIST);
  } else if (list === 'new_upcoming') {
    const start = new Date();
    start.setDate(start.getDate() - 45);
    data = await tmdb('/discover/tv', {
      page,
      'first_air_date.gte': start.toISOString().slice(0, 10),
      sort_by: 'popularity.desc',
    }, POLICY_LIST);
  } else {
    data = await tmdb(`/tv/${list}`, { page }, POLICY_LIST);
  }
  const shows = data.results || [];
  const enriched = await Promise.all(shows.map(async (show) => {
    try {
      const videos = await tmdb(`/tv/${show.id}/videos`, {}, POLICY_STATIC);
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

async function buildMovieSearch(q) {
  const data = await tmdb('/search/movie', { query: q }, POLICY_SEARCH);
  const movies = (data.results || []).slice(0, 20);
  const enriched = await Promise.all(movies.map(async (movie) => {
    try {
      const videos = await tmdb(`/movie/${movie.id}/videos`, {}, POLICY_STATIC);
      const trailer = pickTrailer(videos);
      return {
        id: movie.id,
        title: movie.title,
        overview: movie.overview,
        release_date: movie.release_date,
        poster_path: poster(movie.poster_path),
        backdrop_path: backdrop(movie.backdrop_path),
        vote_average: movie.vote_average,
        youtube_key: trailer ? trailer.key : null,
        media_type: 'movie',
      };
    } catch { return null; }
  }));
  return { results: enriched.filter(Boolean) };
}

async function buildTvSearch(q) {
  const data = await tmdb('/search/tv', { query: q }, POLICY_SEARCH);
  const shows = (data.results || []).slice(0, 20);
  const enriched = await Promise.all(shows.map(async (show) => {
    try {
      const videos = await tmdb(`/tv/${show.id}/videos`, {}, POLICY_STATIC);
      const trailer = pickTrailer(videos);
      return {
        id: show.id,
        title: show.name,
        overview: show.overview,
        release_date: show.first_air_date,
        poster_path: poster(show.poster_path),
        backdrop_path: backdrop(show.backdrop_path),
        vote_average: show.vote_average,
        youtube_key: trailer ? trailer.key : null,
        media_type: 'tv',
      };
    } catch { return null; }
  }));
  return { results: enriched.filter(Boolean) };
}

// ── Prewarm + background refresh ─────────────────────────────────────────────
const WARM_LISTS = [
  { mode: 'movies', list: 'upcoming'   },
  { mode: 'movies', list: 'now_playing'},
  { mode: 'movies', list: 'popular'    },
  { mode: 'tv',     list: 'trending'     },
  { mode: 'tv',     list: 'popular'      },
  { mode: 'tv',     list: 'new_upcoming' },
  { mode: 'tv',     list: 'on_the_air'   },
  { mode: 'tv',     list: 'top_rated'    },
];

let prewarmRunning = false;
let prewarmTimer = null;

async function prewarm({ label = 'prewarm' } = {}) {
  if (prewarmRunning) return;
  if (!getSetting('tmdb_api_key')) return;
  prewarmRunning = true;
  const start = Date.now();
  let ok = 0, fail = 0;
  // Serial across lists to avoid TMDB rate-limit bursts.
  for (const { mode, list } of WARM_LISTS) {
    try {
      if (mode === 'movies') await buildMovieFeed({ list, page: 1 });
      else await buildTvFeed({ list, page: 1 });
      ok++;
    } catch (e) {
      fail++;
      console.warn(`[${label}] ${mode}/${list}: ${e.message}`);
    }
  }
  prewarmRunning = false;
  console.log(`[${label}] ${ok}/${ok + fail} lists warmed in ${Date.now() - start}ms (cache size: ${tmdbCache.stats().size})`);
}

function schedulePrewarm() {
  if (prewarmTimer) clearInterval(prewarmTimer);
  prewarmTimer = setInterval(() => prewarm({ label: 'refresh' }), 8 * 60_000);
  prewarmTimer.unref?.();
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.use(compression());
app.use(express.json());

// Disable ETags — ZFS doesn't reliably update mtime on writes,
// causing stale browser caches even after file edits.
const STATIC_OPTS = {
  etag: false,
  lastModified: false,
  setHeaders: (res, filePath) => {
    if (/\.(png|jpe?g|webp|svg|ico|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800'); // 1 week for static binaries
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
};

// ── SSR for / ────────────────────────────────────────────────────────────────
const indexTemplate = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

function safeJson(obj) {
  // Prevent `</script>` injection when inlining JSON into HTML.
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

app.get('/', async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');

  let initialFeed = null;
  let initialWatched = [];
  try {
    initialWatched = stmtGetWatchedIds.all();
  } catch {}
  try {
    // Short total budget — if TMDB is slow, don't hold up first paint.
    initialFeed = await Promise.race([
      buildMovieFeed({ list: 'upcoming', page: 1 }),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
  } catch {}

  const boot = `<script>
window.__INITIAL_FEED__ = ${safeJson(initialFeed)};
window.__INITIAL_WATCHED__ = ${safeJson(initialWatched)};
window.__INITIAL_LIST__ = "upcoming";
</script>`;

  res.send(indexTemplate.replace('</body>', `${boot}\n</body>`));
});

app.get('/settings', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

app.use(express.static(path.join(__dirname, 'public'), STATIC_OPTS));

// ── Cache-control helpers ─────────────────────────────────────────────────────
function publicCache(res, seconds) {
  res.setHeader('Cache-Control', `public, max-age=${seconds}, s-maxage=${seconds}`);
}

// ── Feed routes ──────────────────────────────────────────────────────────────
app.get('/api/feed', async (req, res) => {
  try {
    const payload = await buildMovieFeed({
      list: req.query.list || 'upcoming',
      page: req.query.page || 1,
    });
    publicCache(res, 60);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shows/feed', async (req, res) => {
  try {
    const payload = await buildTvFeed({
      list: req.query.list || 'trending',
      page: req.query.page || 1,
    });
    publicCache(res, 60);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    const payload = await buildMovieSearch(q);
    publicCache(res, 120);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/shows/search', async (req, res) => {
  try {
    const q = req.query.q;
    if (!q) return res.json({ results: [] });
    const payload = await buildTvSearch(q);
    publicCache(res, 120);
    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Watched routes ────────────────────────────────────────────────────────────
app.get('/api/watched/ids', (req, res) => {
  res.json(stmtGetWatchedIds.all());
});

app.post('/api/watched', (req, res) => {
  const { tmdbId, mediaType = 'movie', title } = req.body;
  const id = parseInt(tmdbId, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'tmdbId required' });
  stmtInsertWatched.run(id, mediaType, title || null);
  res.json({ ok: true });
});

app.delete('/api/watched/:tmdbId', (req, res) => {
  const id = parseInt(req.params.tmdbId, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid tmdbId' });
  const { mediaType = 'movie' } = req.query;
  stmtDeleteWatched.run(id, mediaType);
  res.json({ ok: true });
});

// ── Settings routes ───────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => res.json(allSettings()));

app.post('/api/settings', (req, res) => {
  const body = req.body || {};
  const prevTmdb = getSetting('tmdb_api_key');
  for (const key of SETTING_KEYS) {
    if (!(key in body)) continue;
    const val = body[key] == null ? '' : String(body[key]).trim();
    setSetting(key, val);
  }
  res.json({ ok: true, settings: allSettings() });

  // Kick off a prewarm if TMDB key was just added or changed.
  const newTmdb = getSetting('tmdb_api_key');
  if (newTmdb && newTmdb !== prevTmdb) {
    setImmediate(() => prewarm({ label: 'post-save prewarm' }));
  }
});

app.post('/api/settings/test', async (req, res) => {
  const { service, apiKey } = req.body || {};
  try {
    if (service !== 'tmdb') {
      return res.status(400).json({ ok: false, error: 'Unknown service' });
    }
    const key = apiKey || getSetting('tmdb_api_key');
    if (!key) throw new Error('TMDB API key is empty');
    const r = await fetchTimeout(`${TMDB}/configuration?api_key=${encodeURIComponent(key)}`, {}, 6000);
    if (!r.ok) throw new Error(`TMDB ${r.status}`);
    res.json({ ok: true });
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Connection timed out' : err.message;
    res.status(400).json({ ok: false, error: msg });
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    tmdb: !!getSetting('tmdb_api_key'),
    cache: { tmdb: tmdbCache.stats() },
  });
});

// ── Go ────────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Reelarr running at http://localhost:${PORT}`);
  console.log(`Config directory: ${CONFIG_DIR}`);
  if (!getSetting('tmdb_api_key')) {
    console.warn('  Note: TMDB not configured yet — visit /settings');
  } else {
    setImmediate(() => prewarm({ label: 'startup prewarm' }));
    schedulePrewarm();
  }
});
