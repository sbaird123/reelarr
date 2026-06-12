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
  'radarr_url',
  'radarr_api_key',
  'sonarr_url',
  'sonarr_api_key',
  'jellyfin_url',
  'jellyfin_api_key',
  'jellyfin_session_id',  // target "Play On" client (persisted)
  'jellyfin_session_name', // cached display label
];

const envDefaults = {
  tmdb_api_key:       process.env.TMDB_API_KEY       || '',
  radarr_url:         process.env.RADARR_URL         || 'http://localhost:7878',
  radarr_api_key:     process.env.RADARR_API_KEY     || '',
  sonarr_url:         process.env.SONARR_URL         || 'http://localhost:8989',
  sonarr_api_key:     process.env.SONARR_API_KEY     || '',
  jellyfin_url:       process.env.JELLYFIN_URL       || '',
  jellyfin_api_key:   process.env.JELLYFIN_API_KEY   || '',
  jellyfin_session_id: '',
  jellyfin_session_name: '',
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
const statusCache = new SWRCache(2000);
const inFlight = new Map();

// ── TMDB ──────────────────────────────────────────────────────────────────────
const TMDB = 'https://api.themoviedb.org/3';

// Policies: list endpoints refresh often; per-id metadata is essentially static.
const POLICY_LIST   = { freshTtl: 10 * 60_000,   staleTtl: 60 * 60_000   }; // 10m fresh / 1h stale
const POLICY_STATIC = { freshTtl:  6 * 60 * 60_000, staleTtl: 48 * 60 * 60_000 }; // 6h / 48h
const POLICY_SEARCH = { freshTtl:  5 * 60_000,   staleTtl: 30 * 60_000   };
const POLICY_STATUS = { freshTtl: 30_000,        staleTtl: 5 * 60_000    };

function fetchTimeout(url, opts = {}, ms = 8000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, { ...opts, signal: ac.signal }).finally(() => clearTimeout(timer));
}

async function tmdbRaw(endpoint, params = {}) {
  const key = getSetting('tmdb_api_key');
  if (!key) throw new Error('TMDB API key not configured — open Settings → General');
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

// Same SWR pattern as tmdb(), for the small Radarr/Sonarr status entries:
// serve cached until hardExpire, refresh in the background once past softExpire.
async function swrStatus(ckey, fetcher) {
  const cached = statusCache.get(ckey); // get() already drops hard-expired entries
  if (cached) {
    if (cached.softExpire <= Date.now() && !inFlight.has(ckey)) {
      const p = fetcher()
        .then((v) => { statusCache.set(ckey, v, POLICY_STATUS); inFlight.delete(ckey); })
        .catch(() => { inFlight.delete(ckey); });
      inFlight.set(ckey, p);
    }
    return cached.value;
  }
  if (inFlight.has(ckey)) return inFlight.get(ckey);
  const promise = fetcher()
    .then((v) => { statusCache.set(ckey, v, POLICY_STATUS); inFlight.delete(ckey); return v; })
    .catch((err) => { inFlight.delete(ckey); throw err; });
  inFlight.set(ckey, promise);
  return promise;
}

// ── URL helpers ───────────────────────────────────────────────────────────────
function normalizeUrl(u) { return (u || '').trim().replace(/\/+$/, ''); }
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
      const [videos, extIds] = await Promise.all([
        tmdb(`/tv/${show.id}/videos`, {}, POLICY_STATIC),
        tmdb(`/tv/${show.id}/external_ids`, {}, POLICY_STATIC),
      ]);
      const trailer = pickTrailer(videos);
      if (!trailer) return null;
      return {
        id: show.id,
        tvdb_id: extIds.tvdb_id || null,
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
      const [videos, extIds] = await Promise.all([
        tmdb(`/tv/${show.id}/videos`, {}, POLICY_STATIC),
        tmdb(`/tv/${show.id}/external_ids`, {}, POLICY_STATIC),
      ]);
      const trailer = pickTrailer(videos);
      return {
        id: show.id,
        tvdb_id: extIds.tvdb_id || null,
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

// ── Radarr routes ─────────────────────────────────────────────────────────────
async function radarr(method, endpoint, body) {
  const base = normalizeUrl(getSetting('radarr_url'));
  const key  = getSetting('radarr_api_key');
  if (!base || !key) throw new Error('Radarr not configured — open Settings → Applications');
  const url = `${base}/api/v3${endpoint}`;
  const opts = {
    method,
    headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetchTimeout(url, opts, 6000);
  const text = await r.text();
  if (!r.ok) throw new Error(`Radarr ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function radarrStatusById(tmdbId) {
  return swrStatus(`radarr:${tmdbId}`, async () => {
    // /movie?tmdbId=X filters the library directly — the external /movie/lookup/tmdb
    // endpoint doesn't always populate the library id, so it mis-reports "not added".
    const results = await radarr('GET', `/movie?tmdbId=${tmdbId}`);
    const movie = Array.isArray(results) && results.length ? results[0] : null;
    return {
      exists: !!movie,
      monitored: movie ? movie.monitored : false,
      hasFile: movie ? !!movie.hasFile : false,
    };
  });
}

app.get('/api/radarr/lookup/:tmdbId', async (req, res) => {
  try {
    const status = await radarrStatusById(req.params.tmdbId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/radarr/lookup', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.tmdbIds) ? req.body.tmdbIds : [];
    const out = {};
    await Promise.all(ids.map(async (id) => {
      try { out[id] = await radarrStatusById(id); }
      catch { out[id] = { exists: false, error: true }; }
    }));
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/radarr/config', async (req, res) => {
  try {
    const [rootFolders, qualityProfiles] = await Promise.all([
      radarr('GET', '/rootfolder'),
      radarr('GET', '/qualityprofile'),
    ]);
    res.json({ rootFolders, qualityProfiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/radarr/add', async (req, res) => {
  try {
    const { tmdbId, qualityProfileId, rootFolderPath } = req.body;
    if (!tmdbId || !qualityProfileId || !rootFolderPath) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const lookupResults = await radarr('GET', `/movie/lookup/tmdb?tmdbId=${tmdbId}`);
    const lookupMovie = Array.isArray(lookupResults) ? lookupResults[0] : lookupResults;
    if (!lookupMovie) return res.status(404).json({ error: 'Movie not found in TMDB via Radarr' });

    const payload = {
      ...lookupMovie,
      qualityProfileId: parseInt(qualityProfileId),
      rootFolderPath,
      monitored: true,
      addOptions: { searchForMovie: true },
    };
    const result = await radarr('POST', '/movie', payload);
    statusCache.set(`radarr:${tmdbId}`, { exists: true, monitored: true, hasFile: false }, POLICY_STATUS);
    res.json({ success: true, movie: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Sonarr routes ─────────────────────────────────────────────────────────────
async function sonarr(method, endpoint, body) {
  const base = normalizeUrl(getSetting('sonarr_url'));
  const key  = getSetting('sonarr_api_key');
  if (!base || !key) throw new Error('Sonarr not configured — open Settings → Applications');
  const url = `${base}/api/v3${endpoint}`;
  const opts = {
    method,
    headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetchTimeout(url, opts, 6000);
  const text = await r.text();
  if (!r.ok) throw new Error(`Sonarr ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

async function sonarrStatusByTvdb(tvdbId) {
  return swrStatus(`sonarr:${tvdbId}`, async () => {
    const results = await sonarr('GET', `/series/lookup?term=tvdb:${tvdbId}`);
    const show = Array.isArray(results) ? results[0] : results;
    return {
      exists: !!(show && show.id),
      monitored: show ? show.monitored : false,
      hasFile: show ? (show.statistics ? show.statistics.episodeFileCount > 0 : false) : false,
    };
  });
}

app.get('/api/sonarr/lookup/:tvdbId', async (req, res) => {
  try {
    const status = await sonarrStatusByTvdb(req.params.tvdbId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sonarr/lookup', async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.tvdbIds) ? req.body.tvdbIds : [];
    const out = {};
    await Promise.all(ids.map(async (id) => {
      try { out[id] = await sonarrStatusByTvdb(id); }
      catch { out[id] = { exists: false, error: true }; }
    }));
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/sonarr/config', async (req, res) => {
  try {
    const [rootFolders, qualityProfiles] = await Promise.all([
      sonarr('GET', '/rootfolder'),
      sonarr('GET', '/qualityprofile'),
    ]);
    res.json({ rootFolders, qualityProfiles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Jellyfin routes ───────────────────────────────────────────────────────────
async function jellyfin(method, endpoint, { body, query, overrideUrl, overrideKey } = {}) {
  // Overrides are all-or-nothing: never pair a caller-supplied URL with the
  // saved API key, or the saved key would be sent to an arbitrary host.
  const useOverride = overrideUrl !== undefined || overrideKey !== undefined;
  const base = normalizeUrl(useOverride ? overrideUrl : getSetting('jellyfin_url'));
  const key  = useOverride ? (overrideKey || '') : getSetting('jellyfin_api_key');
  if (!base || !key) throw new Error('Jellyfin not configured — open Settings → Applications');
  const qs = new URLSearchParams(query || {});
  const url = `${base}${endpoint}${qs.size ? `?${qs.toString()}` : ''}`;
  const opts = {
    method,
    // Token goes in a header rather than the query string so it stays out of
    // proxy/server access logs.
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'X-Emby-Token': key },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetchTimeout(url, opts, 6000);
  const text = await r.text();
  if (!r.ok) throw new Error(`Jellyfin ${r.status}: ${text || r.statusText}`);
  return text ? JSON.parse(text) : {};
}

// Look up a Jellyfin library item by TMDB (or TVDB, for shows Jellyfin only
// stored the TVDB id for) id. Jellyfin 10.8+ honours the anyProviderIdEquals
// filter, but older/misconfigured servers silently ignore it and return the
// whole catalog — so we always post-filter by ProviderIds and never trust the
// first row blindly. That bug shipped a "wrong thing played" report during
// the first Play On test.
async function jellyfinLookup({ tmdbId, tvdbId, mediaType }) {
  const itemType = mediaType === 'tv' ? 'Series' : 'Movie';
  const wantTmdb = tmdbId ? String(tmdbId) : null;
  const wantTvdb = tvdbId ? String(tvdbId) : null;

  const matches = (item) => {
    const ids = item && item.ProviderIds ? item.ProviderIds : {};
    for (const [k, v] of Object.entries(ids)) {
      const lk = k.toLowerCase();
      if (wantTmdb && lk === 'tmdb' && String(v) === wantTmdb) return true;
      if (wantTvdb && lk === 'tvdb' && String(v) === wantTvdb) return true;
    }
    return false;
  };

  const queries = [];
  if (wantTmdb) queries.push(`tmdb.${wantTmdb}`);
  if (wantTvdb) queries.push(`tvdb.${wantTvdb}`);

  // 1) Preferred path: server-side filter — try each provider in turn.
  for (const q of queries) {
    const filtered = await jellyfin('GET', '/Items', {
      query: {
        recursive: 'true',
        includeItemTypes: itemType,
        anyProviderIdEquals: q,
        limit: '5',
        fields: 'ProviderIds',
      },
    });
    const hit = (filtered.Items || []).find(matches);
    if (hit) return hit;
  }

  // 2) Fallback: broader listing, client-side filter. Cap at 500 rows — if
  // it's not in there, we give up rather than page the whole library.
  const broad = await jellyfin('GET', '/Items', {
    query: {
      recursive: 'true',
      includeItemTypes: itemType,
      limit: '500',
      fields: 'ProviderIds',
    },
  });
  const hit = (broad.Items || []).find(matches);
  return hit || null;
}

app.get('/api/jellyfin/sessions', async (req, res) => {
  try {
    // Accept url/apiKey overrides so the Settings page can refresh the device
    // list using the current (unsaved) form values — otherwise the user has to
    // Save before the dropdown works, which isn't obvious.
    const sessions = await jellyfin('GET', '/Sessions', {
      overrideUrl: req.query.url || undefined,
      overrideKey: req.query.apiKey || undefined,
    });
    // Filter to sessions that can actually play video — drop dead/idle entries.
    const playable = (sessions || [])
      .filter((s) => s.DeviceId && s.SupportsRemoteControl !== false)
      .map((s) => ({
        id: s.Id,
        device: s.DeviceName || 'Unknown device',
        client: s.Client || '',
        user: s.UserName || '',
        active: !!s.LastActivityDate,
      }));
    res.json(playable);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jellyfin/play', async (req, res) => {
  try {
    const { tmdbId, tvdbId, mediaType } = req.body || {};
    if (!tmdbId && !tvdbId) return res.status(400).json({ error: 'tmdbId or tvdbId required' });
    const sessionId = getSetting('jellyfin_session_id');
    if (!sessionId) return res.status(400).json({ error: 'No Jellyfin target device set — open Settings → Applications' });

    const item = await jellyfinLookup({ tmdbId, tvdbId, mediaType });
    if (!item) {
      const label = mediaType === 'tv' ? 'show' : 'movie';
      return res.status(404).json({ error: `Jellyfin doesn't have this ${label} (or its metadata is missing a TMDB/TVDB id)` });
    }
    await jellyfin('POST', `/Sessions/${encodeURIComponent(sessionId)}/Playing`, {
      query: { itemIds: item.Id, playCommand: 'PlayNow' },
    });
    res.json({ ok: true, item: { id: item.Id, name: item.Name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Library feed (Radarr + Sonarr merged, trailers from TMDB) ────────────────
let libraryCache = { items: null, builtAt: 0, building: null };
const LIBRARY_TTL_MS = 60 * 60 * 1000; // 1 hour

async function buildLibrary() {
  const out = [];

  // Radarr movies
  try {
    const movies = await radarr('GET', '/movie');
    for (const m of movies || []) {
      if (!m.tmdbId) continue;
      out.push({
        id: m.tmdbId,
        title: m.title,
        overview: m.overview || '',
        release_date: m.inCinemas || (m.year ? `${m.year}-01-01` : ''),
        poster_path: null,
        backdrop_path: null,
        vote_average: m.ratings?.tmdb?.value || m.ratings?.imdb?.value || 0,
        media_type: 'movie',
        _radarrHasFile: !!m.hasFile,
      });
    }
  } catch (err) { console.warn('[library] radarr:', err.message); }

  // Sonarr series
  try {
    const series = await sonarr('GET', '/series');
    for (const s of series || []) {
      if (!s.tmdbId) continue;
      out.push({
        id: s.tmdbId,
        tvdb_id: s.tvdbId || null,
        title: s.title,
        overview: s.overview || '',
        release_date: s.firstAired || (s.year ? `${s.year}-01-01` : ''),
        poster_path: null,
        backdrop_path: null,
        vote_average: s.ratings?.value || 0,
        media_type: 'tv',
        _sonarrHasFile: (s.statistics?.episodeFileCount || 0) > 0,
      });
    }
  } catch (err) { console.warn('[library] sonarr:', err.message); }

  // Enrich with TMDB trailers + artwork. One call per item via
  // append_to_response=videos (halves the request count vs. fetching details
  // and videos separately). Chunk width keeps TMDB's 40 req/s ceiling in
  // sight; every response is SWR-cached so warm rebuilds are nearly instant.
  const enriched = [];
  const CHUNK = 16;
  for (let i = 0; i < out.length; i += CHUNK) {
    const batch = out.slice(i, i + CHUNK);
    const results = await Promise.all(batch.map(async (it) => {
      try {
        const endpoint = it.media_type === 'tv' ? 'tv' : 'movie';
        const details = await tmdb(`/${endpoint}/${it.id}`, { append_to_response: 'videos' }, POLICY_STATIC);
        const trailer = pickTrailer(details.videos || {});
        if (!trailer) return null;
        return {
          ...it,
          title: it.title || details.title || details.name,
          overview: it.overview || details.overview || '',
          poster_path:   poster(details.poster_path),
          backdrop_path: backdrop(details.backdrop_path),
          vote_average: details.vote_average || it.vote_average,
          youtube_key: trailer.key,
        };
      } catch { return null; }
    }));
    enriched.push(...results.filter(Boolean));
  }
  return enriched;
}

async function getLibrary() {
  const now = Date.now();
  const fresh = libraryCache.items && now - libraryCache.builtAt < LIBRARY_TTL_MS;
  if (fresh) return libraryCache.items;

  if (!libraryCache.building) {
    libraryCache.building = buildLibrary()
      .then((items) => {
        libraryCache = { items, builtAt: Date.now(), building: null };
        return items;
      })
      .catch((err) => {
        libraryCache.building = null;
        // Stale items on hand → log and keep serving them; cold build → let
        // the awaiting request see the failure.
        if (libraryCache.items) {
          console.warn('[library] refresh:', err.message);
          return libraryCache.items;
        }
        throw err;
      });
  }
  // Stale items beat waiting on a rebuild — serve them immediately whether or
  // not we kicked off the refresh ourselves.
  return libraryCache.items || libraryCache.building;
}

// Cheap status probe so the UI can gray out modes/buttons for unconfigured
// services without having to run a full config fetch.
app.get('/api/services/status', (req, res) => {
  res.json({
    radarr:   !!(getSetting('radarr_url')   && getSetting('radarr_api_key')),
    sonarr:   !!(getSetting('sonarr_url')   && getSetting('sonarr_api_key')),
    jellyfin: !!(getSetting('jellyfin_url') && getSetting('jellyfin_api_key') && getSetting('jellyfin_session_id')),
  });
});

app.get('/api/library/feed', async (req, res) => {
  try {
    const items = await getLibrary();
    // Client shuffles and paginates client-side; serve everything so
    // swipes never run dry.
    publicCache(res, 60);
    res.json({ results: items, total_pages: 1, page: 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/sonarr/add', async (req, res) => {
  try {
    const { tvdbId, qualityProfileId, rootFolderPath } = req.body;
    if (!tvdbId || !qualityProfileId || !rootFolderPath) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const lookupResults = await sonarr('GET', `/series/lookup?term=tvdb:${tvdbId}`);
    const lookupShow = Array.isArray(lookupResults) ? lookupResults[0] : lookupResults;
    if (!lookupShow) return res.status(404).json({ error: 'Show not found via Sonarr' });

    const payload = {
      ...lookupShow,
      qualityProfileId: parseInt(qualityProfileId),
      rootFolderPath,
      monitored: true,
      seasonFolder: true,
      addOptions: { searchForMissingEpisodes: true },
    };
    const result = await sonarr('POST', '/series', payload);
    statusCache.set(`sonarr:${tvdbId}`, { exists: true, monitored: true, hasFile: false }, POLICY_STATUS);
    res.json({ success: true, show: result });
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
    let val = body[key] == null ? '' : String(body[key]).trim();
    if (key === 'radarr_url' || key === 'sonarr_url' || key === 'jellyfin_url') val = normalizeUrl(val);
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
  const { service, url, apiKey } = req.body || {};
  try {
    if (service === 'tmdb') {
      const key = apiKey || getSetting('tmdb_api_key');
      if (!key) throw new Error('TMDB API key is empty');
      const r = await fetchTimeout(`${TMDB}/configuration?api_key=${encodeURIComponent(key)}`, {}, 6000);
      if (!r.ok) throw new Error(`TMDB ${r.status}`);
    } else if (service === 'radarr' || service === 'sonarr') {
      // Fall back to saved settings only when the caller supplied neither value
      // — mixing a caller URL with the saved key would leak the key off-box.
      const useSaved = !url && !apiKey;
      const base = normalizeUrl(useSaved ? getSetting(`${service}_url`) : url);
      const key  = useSaved ? getSetting(`${service}_api_key`) : (apiKey || '');
      if (!base) throw new Error('URL is empty');
      if (!key)  throw new Error('API key is empty');
      const r = await fetchTimeout(`${base}/api/v3/system/status`, {
        headers: { 'X-Api-Key': key },
      }, 6000);
      if (!r.ok) throw new Error(`${service} ${r.status}`);
      const info = await r.json();
      return res.json({ ok: true, version: info.version, name: info.instanceName || info.appName });
    } else if (service === 'jellyfin') {
      const useSaved = !url && !apiKey;
      const base = normalizeUrl(useSaved ? getSetting('jellyfin_url') : url);
      const key  = useSaved ? getSetting('jellyfin_api_key') : (apiKey || '');
      if (!base) throw new Error('URL is empty');
      if (!key)  throw new Error('API key is empty');
      // /System/Info (not /System/Info/Public) requires auth, so a wrong key
      // actually fails the test instead of silently passing.
      const r = await fetchTimeout(`${base}/System/Info`, {
        headers: { 'X-Emby-Token': key },
      }, 6000);
      if (!r.ok) throw new Error(`Jellyfin ${r.status}${r.status === 401 ? ' — bad API key' : ''}`);
      const info = await r.json();
      return res.json({ ok: true, version: info.Version, name: info.ServerName });
    } else {
      return res.status(400).json({ ok: false, error: 'Unknown service' });
    }
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
    radarr_url: getSetting('radarr_url'),
    radarr_key: !!getSetting('radarr_api_key'),
    sonarr_url: getSetting('sonarr_url'),
    sonarr_key: !!getSetting('sonarr_api_key'),
    cache: { tmdb: tmdbCache.stats(), status: statusCache.stats() },
  });
});

// ── Go ────────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Peekarr running at http://localhost:${PORT}`);
  console.log(`Config directory: ${CONFIG_DIR}`);
  if (!getSetting('tmdb_api_key')) {
    console.warn('  Note: TMDB not configured yet — visit /settings');
  } else {
    setImmediate(() => prewarm({ label: 'startup prewarm' }));
    schedulePrewarm();
    // Warm the library cache too if Radarr/Sonarr are configured. Delayed so
    // it doesn't fight the startup prewarm for TMDB bandwidth.
    if (getSetting('radarr_api_key') || getSetting('sonarr_api_key')) {
      setTimeout(() => {
        getLibrary().catch((err) => console.warn('[library] prewarm:', err.message));
      }, 5000);
    }
  }
});
