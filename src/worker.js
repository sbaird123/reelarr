import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { googleAuth } from '@hono/oauth-providers/google';

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

// ── Email (Cloudflare Email Sending) ────────────────────────────────────────
// Transactional only (friend requests, share notices). Best-effort: a send
// failure must never break the request that triggered it, so callers don't await
// a throw — sendEmail swallows errors and returns a boolean. The from-domain
// (reelarr.app) is onboarded for sending; the EMAIL binding is set in wrangler.
const MAIL_FROM = { email: 'notifications@reelarr.app', name: 'Reelarr' };

// Branded HTML for the "join Reelarr" invite sent when you friend an email that
// has no account yet.
function inviteEmailHtml(fromName, origin) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1a1a1a">
  <div style="font-size:28px;font-weight:800;color:#e50914;margin-bottom:16px">Reelarr</div>
  <p style="font-size:16px;line-height:1.5;margin:0 0 12px"><strong>${esc(fromName)}</strong> wants to share movie &amp; TV watchlists with you on <strong>Reelarr</strong> — a fun, TikTok-style way to discover trailers.</p>
  <p style="font-size:15px;line-height:1.5;color:#444;margin:0 0 24px">Sign up free with Google and ${esc(fromName)}'s friend request will be waiting for you.</p>
  <p style="margin:0 0 24px"><a href="${origin}" style="background:#e50914;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:700;display:inline-block">Join Reelarr</a></p>
  <p style="font-size:12px;color:#999;margin:0">If you weren't expecting this, you can safely ignore this email.</p>
</div>`;
}

// On signup/login, turn any pending email invites into incoming friend requests
// for the new user (they still confirm). Best-effort — never blocks login.
async function convertInvites(env, userId, email) {
  const { results } = await env.DB.prepare(
    `SELECT inviter_id FROM friend_invites WHERE email = ? COLLATE NOCASE`
  ).bind(email).all();
  const inviters = (results || []).map((r) => r.inviter_id).filter((id) => id !== userId);
  if (inviters.length) {
    const stmt = env.DB.prepare(
      `INSERT INTO friendships (requester_id, addressee_id, status) VALUES (?, ?, 'pending')
       ON CONFLICT(requester_id, addressee_id) DO NOTHING`
    );
    await env.DB.batch(inviters.map((id) => stmt.bind(id, userId)));
  }
  await env.DB.prepare(`DELETE FROM friend_invites WHERE email = ? COLLATE NOCASE`).bind(email).run();
}

async function sendEmail(env, { to, subject, html, text }) {
  if (!env.EMAIL || !to) return false; // binding absent or no address → skip
  try {
    await env.EMAIL.send({ to, from: MAIL_FROM, subject, html, text });
    return true;
  } catch (e) {
    console.warn(`[email] send to ${to} failed: ${e.code || ''} ${e.message || e}`);
    return false;
  }
}

// ── Auth (D1 sessions) ────────────────────────────────────────────────────────
const SESSION_COOKIE = 'reelarr_session';
const SESSION_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

function newToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function cookieOpts(c, expires) {
  // Secure only over https so cookies still set on http://localhost during dev.
  const https = new URL(c.req.url).protocol === 'https:';
  return { httpOnly: true, secure: https, sameSite: 'Lax', path: '/', expires };
}

async function upsertUser(env, { provider, providerId, email, name, avatar }) {
  await env.DB.prepare(
    `INSERT INTO users (provider, provider_id, email, name, avatar)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider, provider_id) DO UPDATE SET
       email = excluded.email, name = excluded.name, avatar = excluded.avatar`
  ).bind(provider, String(providerId), email || null, name || null, avatar || null).run();
  const row = await env.DB.prepare(
    `SELECT id FROM users WHERE provider = ? AND provider_id = ?`
  ).bind(provider, String(providerId)).first();
  return row.id;
}

async function createSession(env, userId) {
  const id = newToken();
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`
  ).bind(id, userId, expires.toISOString()).run();
  return { id, expires };
}

async function sessionUser(env, token) {
  if (!token) return null;
  return env.DB.prepare(
    `SELECT u.id, u.provider, u.email, u.name, u.avatar
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND s.expires_at > datetime('now')`
  ).bind(token).first();
}

// Per-route middleware: resolve the session user into the context. Scoped to
// auth-relevant routes only, so the high-traffic feed/search endpoints never
// pay for a D1 session lookup.
async function withUser(c, next) {
  let user = null;
  try { user = await sessionUser(c.env, getCookie(c, SESSION_COOKIE)); } catch {}
  c.set('user', user);
  await next();
}

function requireUser(c) {
  const u = c.get('user');
  return u || null;
}

// Finish an OAuth login: upsert the user, mint a session, set the cookie, and
// bounce back to the app.
async function completeLogin(c, profile) {
  if (!profile) return c.redirect('/?login=failed');
  const userId = await upsertUser(c.env, profile);
  // Pending email invites → incoming friend requests for this account.
  if (profile.email) {
    try { await convertInvites(c.env, userId, profile.email); } catch {}
  }
  const { id, expires } = await createSession(c.env, userId);
  setCookie(c, SESSION_COOKIE, id, cookieOpts(c, expires));
  return c.redirect('/');
}

// ── App ─────────────────────────────────────────────────────────────────────
const app = new Hono();

function safeJson(obj) {
  // Prevent `</script>` injection when inlining JSON into HTML.
  return JSON.stringify(obj ?? null).replace(/</g, '\\u003c');
}

// Escape user-supplied text (names) before interpolating into email HTML.
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

// ── OAuth login ───────────────────────────────────────────────────────────────
// The middleware's mount path doubles as the OAuth redirect URI — so Google must
// have http://localhost:8787/auth/google (dev) and
// https://<deployed-host>/auth/google (prod) registered as redirect URIs.
// client id/secret are read from env (GOOGLE_ID / GOOGLE_SECRET).
// (The users.provider column is generic, so another provider can be added later
// without a migration.)
// `email` scope added for the friends feature (request-a-friend-by-email). Adding
// it doesn't trigger Google reverification — email is a basic, non-sensitive
// scope. Existing users' emails backfill automatically: completeLogin passes the
// email and upsertUser's ON CONFLICT updates it on the next sign-in.
app.use('/auth/google', (c, next) =>
  googleAuth({ scope: ['openid', 'profile', 'email'] })(c, next));
app.get('/auth/google', (c) => {
  const u = c.get('user-google');
  return completeLogin(c, u && {
    provider: 'google', providerId: u.id, email: u.email, name: u.name, avatar: u.picture,
  });
});

// ── Account ───────────────────────────────────────────────────────────────────
app.get('/api/me', withUser, (c) => {
  const u = c.get('user');
  return c.json({ user: u ? { name: u.name, email: u.email, avatar: u.avatar, provider: u.provider } : null });
});

app.post('/api/logout', async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    try { await c.env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(token).run(); } catch {}
  }
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});

// ── Watched (per-user, D1) ─────────────────────────────────────────────────────
app.get('/api/watched/ids', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT tmdb_id, media_type FROM watched WHERE user_id = ?`
  ).bind(u.id).all();
  return c.json(results || []);
});

app.post('/api/watched', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const { tmdbId, mediaType = 'movie', title } = await c.req.json().catch(() => ({}));
  const id = parseInt(tmdbId, 10);
  if (!Number.isInteger(id)) return c.json({ error: 'tmdbId required' }, 400);
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO watched (user_id, tmdb_id, media_type, title) VALUES (?, ?, ?, ?)`
  ).bind(u.id, id, mediaType, title || null).run();
  return c.json({ ok: true });
});

app.delete('/api/watched/:tmdbId', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const id = parseInt(c.req.param('tmdbId'), 10);
  if (!Number.isInteger(id)) return c.json({ error: 'invalid tmdbId' }, 400);
  const mediaType = c.req.query('mediaType') || 'movie';
  await c.env.DB.prepare(
    `DELETE FROM watched WHERE user_id = ? AND tmdb_id = ? AND media_type = ?`
  ).bind(u.id, id, mediaType).run();
  return c.json({ ok: true });
});

// Bulk-merge localStorage watched into the account on first sign-in.
app.post('/api/watched/merge', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const items = Array.isArray(body.items) ? body.items : [];
  const stmt = c.env.DB.prepare(
    `INSERT OR IGNORE INTO watched (user_id, tmdb_id, media_type, title) VALUES (?, ?, ?, ?)`
  );
  const batch = items
    .filter((it) => Number.isInteger(parseInt(it.tmdbId, 10)))
    .map((it) => stmt.bind(u.id, parseInt(it.tmdbId, 10), it.mediaType || 'movie', it.title || null));
  if (batch.length) await c.env.DB.batch(batch);
  return c.json({ ok: true, merged: batch.length });
});

// ── Lists (named watchlists, per-user, D1) ──────────────────────────────────────
// The feature that replaces "+ Add to Radarr/Sonarr". Tables (lists/list_items)
// shipped in 0001_init; these are the endpoints + UI on top of them.
const MAX_LIST_NAME = 100;
const LIST_KINDS = ['movie', 'tv', 'both'];
const normKind = (k) => (LIST_KINDS.includes(k) ? k : 'both');

// Resolve a list the caller owns, or null. Every item mutation goes through this
// so a user can't read/write another account's list by guessing an id.
async function ownedList(env, userId, listId) {
  if (!Number.isInteger(listId)) return null;
  return env.DB.prepare(
    `SELECT id, name, share_token FROM lists WHERE id = ? AND user_id = ?`
  ).bind(listId, userId).first();
}

// Resolve the caller's role on a list: 'owner' | 'editor' | 'viewer', or null if
// no access. Owner = lists.user_id; collaborators come from list_collaborators
// (Phase 4). Used for read + item-edit; owner-only ops still use ownedList().
async function listAccess(env, userId, listId) {
  if (!Number.isInteger(listId)) return null;
  const row = await env.DB.prepare(
    `SELECT l.id, l.name, l.kind, l.hide_watched, l.share_token, l.user_id AS owner_id, c.role AS collab_role
     FROM lists l
     LEFT JOIN list_collaborators c ON c.list_id = l.id AND c.user_id = ?2
     WHERE l.id = ?1`
  ).bind(listId, userId).first();
  if (!row) return null;
  const role = row.owner_id === userId ? 'owner' : row.collab_role;
  if (!role) return null;
  return { id: row.id, name: row.name, kind: row.kind, hide_watched: row.hide_watched, share_token: row.share_token, owner_id: row.owner_id, role };
}

async function areFriends(env, a, b) {
  const row = await env.DB.prepare(
    `SELECT 1 FROM friendships WHERE status = 'accepted' AND
       ((requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1))`
  ).bind(a, b).first();
  return !!row;
}

// ── *arr sync (Phase 2) ─────────────────────────────────────────────────────
// Radarr/Sonarr import lists pull a tokenised JSON URL on their own schedule.
// Both match on *external* ids, not TMDB's: Radarr's StevenLu importer keys on
// imdb_id; Sonarr's Custom List keys on tvdbId (with tmdbId/imdbId as extras).
// So every export maps TMDB ids → external ids via TMDB's /external_ids, cached
// hard in KV (these mappings are effectively immutable).
function shareToken() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function externalIds(env, kind, tmdbId) {
  const key = `extid:${kind}:${tmdbId}`;
  try { const hit = await env.CACHE.get(key, { type: 'json' }); if (hit) return hit; }
  catch {}
  let ids = { imdb_id: null, tvdb_id: null };
  try {
    const d = await tmdbRaw(env, `/${kind}/${tmdbId}/external_ids`);
    ids = { imdb_id: d.imdb_id || null, tvdb_id: d.tvdb_id || null };
  } catch { /* leave nulls; the item is just skipped in the export */ }
  // 30-day TTL — external ids don't change. (Negative results re-checked monthly.)
  try { await env.CACHE.put(key, JSON.stringify(ids), { expirationTtl: 60 * 60 * 24 * 30 }); }
  catch {}
  return ids;
}

function listByToken(env, token) {
  if (!token) return Promise.resolve(null);
  return env.DB.prepare(`SELECT id, name FROM lists WHERE share_token = ?`).bind(token).first();
}

// Build the full import URLs from the request origin so they're copy-pasteable.
function shareInfo(c, token) {
  const origin = new URL(c.req.url).origin;
  return {
    token,
    radarr: `${origin}/list/${token}/radarr.json`,
    sonarr: `${origin}/list/${token}/sonarr.json`,
  };
}

app.get('/api/lists', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  // Lists the user owns, plus lists shared with them (collaborator rows). Owned
  // first; shared entries carry the owner's name and the caller's role.
  const owned = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.kind, l.hide_watched, l.created_at, COUNT(li.tmdb_id) AS count,
            'owner' AS role, NULL AS owner_name,
            CASE WHEN l.share_token IS NOT NULL THEN 1 ELSE 0 END AS shared
     FROM lists l LEFT JOIN list_items li ON li.list_id = l.id
     WHERE l.user_id = ?
     GROUP BY l.id
     ORDER BY l.created_at DESC`
  ).bind(u.id).all();
  const shared = await c.env.DB.prepare(
    `SELECT l.id, l.name, l.kind, l.hide_watched, l.created_at, COUNT(li.tmdb_id) AS count,
            c.role AS role, ownr.name AS owner_name, 0 AS shared
     FROM list_collaborators c
     JOIN lists l ON l.id = c.list_id
     JOIN users ownr ON ownr.id = l.user_id
     LEFT JOIN list_items li ON li.list_id = l.id
     WHERE c.user_id = ?
     GROUP BY l.id
     ORDER BY c.created_at DESC`
  ).bind(u.id).all();
  return c.json([...(owned.results || []), ...(shared.results || [])]);
});

app.post('/api/lists', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const { name, kind } = await c.req.json().catch(() => ({}));
  const trimmed = (name || '').trim().slice(0, MAX_LIST_NAME);
  if (!trimmed) return c.json({ error: 'name required' }, 400);
  const k = normKind(kind);
  const res = await c.env.DB.prepare(
    `INSERT INTO lists (user_id, name, kind) VALUES (?, ?, ?)`
  ).bind(u.id, trimmed, k).run();
  return c.json({ id: res.meta.last_row_id, name: trimmed, kind: k, count: 0, role: 'owner', shared: 0 });
});

app.get('/api/lists/:id', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const list = await listAccess(c.env, u.id, parseInt(c.req.param('id'), 10));
  if (!list) return c.json({ error: 'not found' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT tmdb_id, media_type, title, added_at FROM list_items
     WHERE list_id = ? ORDER BY added_at DESC`
  ).bind(list.id).all();
  // Trakt link state (owner-only, like *arr sharing).
  let trakt = null;
  if (list.role === 'owner') {
    const link = await c.env.DB.prepare(
      `SELECT trakt_list_id, trakt_slug, last_synced_at FROM trakt_list_links WHERE list_id = ?`
    ).bind(list.id).first();
    if (link) trakt = { target: link.trakt_list_id ? 'list' : 'watchlist', slug: link.trakt_slug, last_synced_at: link.last_synced_at };
  }
  return c.json({
    id: list.id,
    name: list.name,
    kind: list.kind,
    hide_watched: list.hide_watched,
    role: list.role,
    items: results || [],
    // *arr import URLs are owner-only — collaborators don't manage sharing.
    share: list.role === 'owner' && list.share_token ? shareInfo(c, list.share_token) : null,
    trakt,
  });
});

// A list played as a trailer feed in the swiper. Enriches the list's items of
// the requested type (movie|tv) with TMDB details + a trailer, dropping any
// without one. Per-title enrichment is cached hard in KV (details/trailers are
// near-immutable), so adds/removes reflect immediately without refetching the rest.
async function enrichTitle(env, kind, tmdbId) {
  const key = `title:${kind}:${tmdbId}`;
  try { const hit = await env.CACHE.get(key, { type: 'json' }); if (hit) return hit; }
  catch {}
  let out = null;
  try {
    const d = await tmdbRaw(env, `/${kind}/${tmdbId}`, { append_to_response: 'videos' });
    const trailer = pickTrailer(d.videos);
    out = {
      id: tmdbId,
      title: kind === 'tv' ? d.name : d.title,
      overview: d.overview,
      release_date: kind === 'tv' ? d.first_air_date : d.release_date,
      poster_path: poster(d.poster_path),
      backdrop_path: backdrop(d.backdrop_path),
      vote_average: d.vote_average,
      youtube_key: trailer ? trailer.key : null,
      media_type: kind,
    };
  } catch { /* unreachable title → dropped from the feed */ }
  if (out) { try { await env.CACHE.put(key, JSON.stringify(out), { expirationTtl: 60 * 60 * 24 }); } catch {} }
  return out;
}

app.get('/api/lists/:id/feed', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const list = await listAccess(c.env, u.id, parseInt(c.req.param('id'), 10));
  if (!list) return c.json({ error: 'not found' }, 404);
  const type = c.req.query('type') === 'tv' ? 'tv' : 'movie';
  const { results } = await c.env.DB.prepare(
    `SELECT tmdb_id FROM list_items WHERE list_id = ? AND media_type = ? ORDER BY added_at DESC`
  ).bind(list.id, type).all();
  const enriched = await Promise.all((results || []).map((it) => enrichTitle(c.env, type, it.tmdb_id)));
  return c.json({ results: enriched.filter((x) => x && x.youtube_key), total_pages: 1, page: 1 });
});

// Enable *arr sync for a list — mint a share token if it doesn't have one, then
// return the import URLs. Idempotent: re-enabling returns the existing token.
app.post('/api/lists/:id/share', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const id = parseInt(c.req.param('id'), 10);
  const list = await ownedList(c.env, u.id, id);
  if (!list) return c.json({ error: 'not found' }, 404);
  let token = list.share_token;
  if (!token) {
    token = shareToken();
    await c.env.DB.prepare(`UPDATE lists SET share_token = ? WHERE id = ?`).bind(token, id).run();
  }
  return c.json(shareInfo(c, token));
});

// Revoke sharing — old import URLs immediately 404.
app.delete('/api/lists/:id/share', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const id = parseInt(c.req.param('id'), 10);
  const list = await ownedList(c.env, u.id, id);
  if (!list) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare(`UPDATE lists SET share_token = NULL WHERE id = ?`).bind(id).run();
  return c.json({ ok: true });
});

// Public import endpoints (token is the auth — no session). Radarr StevenLu
// format: [{ title, imdb_id }]. Only movies; items without an imdb_id are skipped.
app.get('/list/:token/radarr.json', async (c) => {
  const list = await listByToken(c.env, c.req.param('token'));
  if (!list) return c.json({ error: 'not found' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT tmdb_id, title FROM list_items WHERE list_id = ? AND media_type = 'movie'`
  ).bind(list.id).all();
  const mapped = await Promise.all((results || []).map(async (it) => {
    const ids = await externalIds(c.env, 'movie', it.tmdb_id);
    return ids.imdb_id ? { title: it.title || `tmdb:${it.tmdb_id}`, imdb_id: ids.imdb_id } : null;
  }));
  c.header('Cache-Control', 'public, max-age=600');
  return c.json(mapped.filter(Boolean));
});

// Sonarr Custom List format: [{ title, tvdbId, tmdbId, imdbId }]. Only TV; items
// with neither a tvdbId nor an imdbId are skipped (Sonarr can't match them).
app.get('/list/:token/sonarr.json', async (c) => {
  const list = await listByToken(c.env, c.req.param('token'));
  if (!list) return c.json({ error: 'not found' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT tmdb_id, title FROM list_items WHERE list_id = ? AND media_type = 'tv'`
  ).bind(list.id).all();
  const mapped = await Promise.all((results || []).map(async (it) => {
    const ids = await externalIds(c.env, 'tv', it.tmdb_id);
    if (!ids.tvdb_id && !ids.imdb_id) return null;
    return {
      title: it.title || `tmdb:${it.tmdb_id}`,
      tvdbId: ids.tvdb_id || 0,
      tmdbId: it.tmdb_id,
      imdbId: ids.imdb_id || '',
    };
  }));
  c.header('Cache-Control', 'public, max-age=600');
  return c.json(mapped.filter(Boolean));
});

app.patch('/api/lists/:id', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json().catch(() => ({}));
  const { name, kind } = body;
  const sets = [], binds = [];
  if (typeof name === 'string' && name.trim()) { sets.push('name = ?'); binds.push(name.trim().slice(0, MAX_LIST_NAME)); }
  if (LIST_KINDS.includes(kind)) { sets.push('kind = ?'); binds.push(kind); }
  if (typeof body.hide_watched === 'boolean') { sets.push('hide_watched = ?'); binds.push(body.hide_watched ? 1 : 0); }
  if (!sets.length) return c.json({ error: 'nothing to update' }, 400);
  binds.push(id, u.id);
  const res = await c.env.DB.prepare(
    `UPDATE lists SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`
  ).bind(...binds).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

app.delete('/api/lists/:id', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const id = parseInt(c.req.param('id'), 10);
  // list_items rows cascade via the FK in 0001_init.
  const res = await c.env.DB.prepare(
    `DELETE FROM lists WHERE id = ? AND user_id = ?`
  ).bind(id, u.id).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true });
});

app.post('/api/lists/:id/items', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const list = await listAccess(c.env, u.id, parseInt(c.req.param('id'), 10));
  if (!list) return c.json({ error: 'not found' }, 404);
  if (list.role === 'viewer') return c.json({ error: 'read-only' }, 403);
  const { tmdbId, mediaType = 'movie', title } = await c.req.json().catch(() => ({}));
  const id = parseInt(tmdbId, 10);
  if (!Number.isInteger(id)) return c.json({ error: 'tmdbId required' }, 400);
  const mt = mediaType === 'tv' ? 'tv' : 'movie';
  const res = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO list_items (list_id, tmdb_id, media_type, title) VALUES (?, ?, ?, ?)`
  ).bind(list.id, id, mt, title || null).run();
  // Push-on-change: mirror a genuine add to the linked Trakt target instantly.
  if (res.meta.changes) c.executionCtx.waitUntil(traktPushItem(c.env, list.id, { tmdb_id: id, media_type: mt }, false));
  return c.json({ ok: true });
});

app.delete('/api/lists/:id/items/:tmdbId', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const list = await listAccess(c.env, u.id, parseInt(c.req.param('id'), 10));
  if (!list) return c.json({ error: 'not found' }, 404);
  if (list.role === 'viewer') return c.json({ error: 'read-only' }, 403);
  const id = parseInt(c.req.param('tmdbId'), 10);
  if (!Number.isInteger(id)) return c.json({ error: 'invalid tmdbId' }, 400);
  const mediaType = c.req.query('mediaType') === 'tv' ? 'tv' : 'movie';
  const res = await c.env.DB.prepare(
    `DELETE FROM list_items WHERE list_id = ? AND tmdb_id = ? AND media_type = ?`
  ).bind(list.id, id, mediaType).run();
  // Push-on-change: mirror a genuine removal to the linked Trakt target instantly.
  if (res.meta.changes) c.executionCtx.waitUntil(traktPushItem(c.env, list.id, { tmdb_id: id, media_type: mediaType }, true));
  return c.json({ ok: true });
});

// ── List collaborators (Phase 4: shared lists) ──────────────────────────────
// Owner-managed; you can only share with a confirmed friend.
app.get('/api/lists/:id/collaborators', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const list = await ownedList(c.env, u.id, parseInt(c.req.param('id'), 10));
  if (!list) return c.json({ error: 'not found' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.avatar, c.role
     FROM list_collaborators c JOIN users u ON u.id = c.user_id
     WHERE c.list_id = ? ORDER BY u.name`
  ).bind(list.id).all();
  return c.json(results || []);
});

app.post('/api/lists/:id/collaborators', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const list = await ownedList(c.env, u.id, parseInt(c.req.param('id'), 10));
  if (!list) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const friendId = parseInt(body.userId, 10);
  const role = body.role === 'editor' ? 'editor' : 'viewer';
  if (!Number.isInteger(friendId)) return c.json({ error: 'userId required' }, 400);
  if (friendId === u.id) return c.json({ error: "can't share with yourself" }, 400);
  if (!(await areFriends(c.env, u.id, friendId)))
    return c.json({ error: 'you can only share with confirmed friends' }, 403);
  await c.env.DB.prepare(
    `INSERT INTO list_collaborators (list_id, user_id, role) VALUES (?, ?, ?)
     ON CONFLICT(list_id, user_id) DO UPDATE SET role = excluded.role`
  ).bind(list.id, friendId, role).run();

  const friend = await c.env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(friendId).first();
  if (friend && friend.email) {
    const origin = new URL(c.req.url).origin;
    const me = u.name || u.email || 'Someone';
    c.executionCtx.waitUntil(sendEmail(c.env, {
      to: friend.email,
      subject: `${me} shared a list with you on Reelarr`,
      text: `${me} shared the list "${list.name}" with you on Reelarr.\n\nOpen ${origin} → My Lists.`,
      html: `<p><strong>${esc(me)}</strong> shared the list <strong>${esc(list.name)}</strong> with you on Reelarr.</p>
             <p><a href="${origin}">Open Reelarr</a> → My Lists.</p>`,
    }));
  }
  return c.json({ ok: true, role });
});

// A collaborator leaves a list shared with them (removes their own row). The
// server resolves "me" from the session, so the client needn't know its user id.
app.post('/api/lists/:id/leave', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const listId = parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(listId)) return c.json({ error: 'invalid list' }, 400);
  await c.env.DB.prepare(
    `DELETE FROM list_collaborators WHERE list_id = ? AND user_id = ?`
  ).bind(listId, u.id).run();
  return c.json({ ok: true });
});

// Owner removes a collaborator; a collaborator removes themselves (leave list).
app.delete('/api/lists/:id/collaborators/:userId', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const listId = parseInt(c.req.param('id'), 10);
  const target = parseInt(c.req.param('userId'), 10);
  if (!Number.isInteger(target)) return c.json({ error: 'invalid user' }, 400);
  const owned = await ownedList(c.env, u.id, listId);
  if (!owned) {
    // Not the owner — only allowed to remove yourself, and only if you're on it.
    if (target !== u.id) return c.json({ error: 'not found' }, 404);
    const acc = await listAccess(c.env, u.id, listId);
    if (!acc || acc.role === 'owner') return c.json({ error: 'not found' }, 404);
  }
  await c.env.DB.prepare(
    `DELETE FROM list_collaborators WHERE list_id = ? AND user_id = ?`
  ).bind(listId, target).run();
  return c.json({ ok: true });
});

// ── Friends (Phase 3) ───────────────────────────────────────────────────────
// A friendship is one directional row; "friends" = an accepted row either way.
// Add by email (must be an existing Reelarr account); the addressee confirms.
app.get('/api/friends', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const friends = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.avatar
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.requester_id = ?1 THEN f.addressee_id ELSE f.requester_id END
     WHERE (f.requester_id = ?1 OR f.addressee_id = ?1) AND f.status = 'accepted'
     ORDER BY u.name`
  ).bind(u.id).all();
  const incoming = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.avatar
     FROM friendships f JOIN users u ON u.id = f.requester_id
     WHERE f.addressee_id = ?1 AND f.status = 'pending' ORDER BY f.created_at DESC`
  ).bind(u.id).all();
  const outgoing = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.avatar
     FROM friendships f JOIN users u ON u.id = f.addressee_id
     WHERE f.requester_id = ?1 AND f.status = 'pending' ORDER BY f.created_at DESC`
  ).bind(u.id).all();
  // Email invites to people who haven't signed up yet.
  const invited = await c.env.DB.prepare(
    `SELECT email FROM friend_invites WHERE inviter_id = ? ORDER BY created_at DESC`
  ).bind(u.id).all();
  return c.json({
    friends: friends.results || [],
    incoming: incoming.results || [],
    outgoing: outgoing.results || [],
    invited: invited.results || [],
  });
});

// Send a friend request by email. If the target already requested us, this
// accepts that pending request (mutual → friends immediately).
app.post('/api/friends', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const { email } = await c.req.json().catch(() => ({}));
  const addr = (email || '').trim();
  if (!addr) return c.json({ error: 'email required' }, 400);
  const target = await c.env.DB.prepare(
    `SELECT id, name, email FROM users WHERE email = ? COLLATE NOCASE LIMIT 1`
  ).bind(addr).first();

  // No account yet → record a pending invite and email them to join. It becomes
  // an incoming friend request automatically when they sign up (convertInvites).
  if (!target) {
    if (u.email && addr.toLowerCase() === u.email.toLowerCase())
      return c.json({ error: "That's your own email" }, 400);
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO friend_invites (email, inviter_id) VALUES (?, ?)`
    ).bind(addr, u.id).run();
    const origin = new URL(c.req.url).origin;
    const fromName = u.name || 'A friend';
    c.executionCtx.waitUntil(sendEmail(c.env, {
      to: addr,
      subject: `${fromName} invited you to Reelarr`,
      text: `${fromName} wants to share movie & TV watchlists with you on Reelarr — a TikTok-style way to discover trailers.\n\nSign up free with Google at ${origin} and ${fromName}'s friend request will be waiting.`,
      html: inviteEmailHtml(fromName, origin),
    }));
    return c.json({ status: 'invited' });
  }

  if (target.id === u.id) return c.json({ error: "That's your own email" }, 400);

  const existing = await c.env.DB.prepare(
    `SELECT requester_id, addressee_id, status FROM friendships
     WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)`
  ).bind(u.id, target.id).first();

  if (existing) {
    if (existing.status === 'accepted') return c.json({ status: 'already_friends' });
    if (existing.requester_id === u.id) return c.json({ status: 'already_requested' });
    // They already requested us → accept it.
    await c.env.DB.prepare(
      `UPDATE friendships SET status = 'accepted' WHERE requester_id = ? AND addressee_id = ?`
    ).bind(target.id, u.id).run();
    return c.json({ status: 'accepted' });
  }

  await c.env.DB.prepare(
    `INSERT INTO friendships (requester_id, addressee_id) VALUES (?, ?)`
  ).bind(u.id, target.id).run();

  // Notify the addressee — best-effort, in the background so the response is fast.
  const origin = new URL(c.req.url).origin;
  const fromName = u.name || u.email || 'Someone';
  c.executionCtx.waitUntil(sendEmail(c.env, {
    to: target.email,
    subject: `${fromName} wants to be friends on Reelarr`,
    text: `${fromName} sent you a friend request on Reelarr.\n\nOpen ${origin} and go to Friends to accept.`,
    html: `<p><strong>${esc(fromName)}</strong> sent you a friend request on Reelarr.</p>
           <p><a href="${origin}">Open Reelarr</a> and go to Friends to accept.</p>`,
  }));
  return c.json({ status: 'requested' });
});

// Cancel a pending email invite (registered before /:userId so "invite" isn't
// matched as a user id).
app.delete('/api/friends/invite', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const email = (c.req.query('email') || '').trim();
  if (!email) return c.json({ error: 'email required' }, 400);
  await c.env.DB.prepare(
    `DELETE FROM friend_invites WHERE inviter_id = ? AND email = ? COLLATE NOCASE`
  ).bind(u.id, email).run();
  return c.json({ ok: true });
});

// Accept an incoming request from :userId.
app.post('/api/friends/:userId/accept', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const other = parseInt(c.req.param('userId'), 10);
  if (!Number.isInteger(other)) return c.json({ error: 'invalid user' }, 400);
  const res = await c.env.DB.prepare(
    `UPDATE friendships SET status = 'accepted'
     WHERE requester_id = ? AND addressee_id = ? AND status = 'pending'`
  ).bind(other, u.id).run();
  if (!res.meta.changes) return c.json({ error: 'no pending request' }, 404);

  // Tell the original requester their request was accepted.
  const requester = await c.env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(other).first();
  if (requester && requester.email) {
    const origin = new URL(c.req.url).origin;
    const me = u.name || u.email || 'Someone';
    c.executionCtx.waitUntil(sendEmail(c.env, {
      to: requester.email,
      subject: `${me} accepted your friend request on Reelarr`,
      text: `${me} accepted your friend request. You can now share lists.\n\n${origin}`,
      html: `<p><strong>${esc(me)}</strong> accepted your friend request on Reelarr. You can now share lists.</p><p><a href="${origin}">Open Reelarr</a></p>`,
    }));
  }
  return c.json({ ok: true });
});

// Remove a friend, decline an incoming request, or cancel an outgoing one —
// all of which just delete the row between the two users.
app.delete('/api/friends/:userId', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const other = parseInt(c.req.param('userId'), 10);
  if (!Number.isInteger(other)) return c.json({ error: 'invalid user' }, 400);
  await c.env.DB.prepare(
    `DELETE FROM friendships
     WHERE (requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1)`
  ).bind(u.id, other).run();
  return c.json({ ok: true });
});

// ── Recommendations (friend → friend) ───────────────────────────────────────
app.post('/api/recommend', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const to = parseInt(body.toUserId, 10);
  const tmdbId = parseInt(body.tmdbId, 10);
  if (!Number.isInteger(to) || !Number.isInteger(tmdbId)) return c.json({ error: 'toUserId and tmdbId required' }, 400);
  if (to === u.id) return c.json({ error: "can't recommend to yourself" }, 400);
  if (!(await areFriends(c.env, u.id, to))) return c.json({ error: 'you can only recommend to friends' }, 403);
  const mediaType = body.mediaType === 'tv' ? 'tv' : 'movie';
  const title = body.title || null;
  const note = (body.note || '').trim().slice(0, 300) || null;
  await c.env.DB.prepare(
    `INSERT INTO recommendations (from_user_id, to_user_id, tmdb_id, media_type, title, note) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(u.id, to, tmdbId, mediaType, title, note).run();

  const friend = await c.env.DB.prepare(`SELECT email FROM users WHERE id = ?`).bind(to).first();
  if (friend && friend.email) {
    const origin = new URL(c.req.url).origin;
    const me = u.name || u.email || 'A friend';
    const what = title || 'something';
    c.executionCtx.waitUntil(sendEmail(c.env, {
      to: friend.email,
      subject: `${me} recommended ${what} on Reelarr`,
      text: `${me} recommended ${what} to you on Reelarr.${note ? `\n\n"${note}"` : ''}\n\nOpen ${origin} to see it.`,
      html: `<p><strong>${esc(me)}</strong> recommended <strong>${esc(what)}</strong> to you on Reelarr.</p>${note ? `<p style="color:#555">"${esc(note)}"</p>` : ''}<p><a href="${origin}">Open Reelarr</a></p>`,
    }));
  }
  return c.json({ ok: true });
});

app.get('/api/recommendations', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.tmdb_id, r.media_type, r.title, r.note, r.seen, r.created_at,
            usr.name AS from_name, usr.avatar AS from_avatar
     FROM recommendations r JOIN users usr ON usr.id = r.from_user_id
     WHERE r.to_user_id = ? ORDER BY r.created_at DESC LIMIT 100`
  ).bind(u.id).all();
  const recs = results || [];
  return c.json({ recommendations: recs, unseen: recs.filter((r) => !r.seen).length });
});

app.post('/api/recommendations/seen', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  await c.env.DB.prepare(
    `UPDATE recommendations SET seen = 1 WHERE to_user_id = ? AND seen = 0`
  ).bind(u.id).run();
  return c.json({ ok: true });
});

app.delete('/api/recommendations/:id', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isInteger(id)) return c.json({ error: 'invalid id' }, 400);
  await c.env.DB.prepare(
    `DELETE FROM recommendations WHERE id = ? AND to_user_id = ?`
  ).bind(id, u.id).run();
  return c.json({ ok: true });
});

// ── Trakt (OAuth + two-way list sync) ────────────────────────────────────────
// Reelarr links a list to a Trakt list (or the watchlist) and keeps them in
// sync both ways. Trakt matches on tmdb ids, which is exactly what Reelarr
// stores, so no external-id mapping is needed (unlike the Radarr/Sonarr exports).
const TRAKT_API = 'https://api.trakt.tv';
const TRAKT_AUTHORIZE = 'https://trakt.tv/oauth/authorize';
// Trakt sits behind Cloudflare and 403s requests with no User-Agent (Workers'
// fetch sends none by default) — so every Trakt call must set one.
const TRAKT_UA = 'Reelarr/1.0 (+https://reelarr.app)';

// The redirect URI must match what's registered on the Trakt app exactly, and
// must be stable for background token refresh (which has no request context).
function traktRedirectUri(env) {
  return `${env.APP_ORIGIN || 'https://reelarr.app'}/auth/trakt`;
}

function traktHeaders(env, accessToken) {
  const h = { 'Content-Type': 'application/json', 'User-Agent': TRAKT_UA, 'trakt-api-version': '2', 'trakt-api-key': env.TRAKT_ID };
  if (accessToken) h['Authorization'] = `Bearer ${accessToken}`;
  return h;
}

// Exchange an auth code or refresh token for a fresh token set.
async function traktTokenExchange(env, params) {
  const res = await fetch(`${TRAKT_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': TRAKT_UA },
    body: JSON.stringify({
      ...params,
      client_id: env.TRAKT_ID,
      client_secret: env.TRAKT_SECRET,
      redirect_uri: traktRedirectUri(env),
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 300); } catch {}
    throw new Error(`trakt token ${res.status} redirect=${traktRedirectUri(env)} body=${detail}`);
  }
  return res.json(); // { access_token, refresh_token, expires_in, created_at, ... }
}

async function storeTraktTokens(env, userId, tok) {
  const base = tok.created_at ? tok.created_at * 1000 : Date.now();
  const expiresAt = new Date(base + (tok.expires_in || 7776000) * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO trakt_accounts (user_id, access_token, refresh_token, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at`
  ).bind(userId, tok.access_token, tok.refresh_token, expiresAt).run();
}

// A valid access token for the user, refreshing if it expires within 5 min.
// null if the user hasn't connected Trakt.
async function traktAccessToken(env, userId) {
  const row = await env.DB.prepare(
    `SELECT access_token, refresh_token, expires_at FROM trakt_accounts WHERE user_id = ?`
  ).bind(userId).first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() - Date.now() > 5 * 60_000) return row.access_token;
  try {
    const tok = await traktTokenExchange(env, { grant_type: 'refresh_token', refresh_token: row.refresh_token });
    await storeTraktTokens(env, userId, tok);
    return tok.access_token;
  } catch {
    return row.access_token; // best-effort; the stale token may still work briefly
  }
}

async function traktApi(env, token, method, path, body) {
  const res = await fetch(`${TRAKT_API}${path}`, {
    method,
    headers: traktHeaders(env, token),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`trakt ${method} ${path} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}

const traktKey = (i) => `${i.tmdb_id}:${i.media_type}`;

function traktItemBody(items) {
  return {
    movies: items.filter((i) => i.media_type === 'movie').map((i) => ({ ids: { tmdb: i.tmdb_id } })),
    shows:  items.filter((i) => i.media_type === 'tv').map((i) => ({ ids: { tmdb: i.tmdb_id } })),
  };
}

// Read a Trakt target's items as {tmdb_id, media_type, title}. traktListId null
// → the watchlist. Entries without a tmdb id are skipped (Reelarr is tmdb-keyed).
async function traktReadItems(env, token, traktListId) {
  const out = [];
  for (const t of ['movies', 'shows']) {
    const path = traktListId
      ? `/users/me/lists/${traktListId}/items/${t}`
      : `/sync/watchlist/${t}`;
    let data;
    try { data = await traktApi(env, token, 'GET', path); } catch { data = []; }
    for (const entry of data || []) {
      const obj = entry.movie || entry.show;
      const tmdb = obj && obj.ids && obj.ids.tmdb;
      if (tmdb) out.push({ tmdb_id: tmdb, media_type: t === 'movies' ? 'movie' : 'tv', title: obj.title });
    }
  }
  return out;
}

function traktWritePath(traktListId, remove) {
  if (traktListId) return `/users/me/lists/${traktListId}/items${remove ? '/remove' : ''}`;
  return `/sync/watchlist${remove ? '/remove' : ''}`;
}

// Two-way reconcile one linked list. Snapshot diff: an item "added" iff not in
// the snapshot, "removed" iff in the snapshot but now absent — mutually
// exclusive, so additions and removals never conflict on the same item.
async function syncTraktLink(env, link) {
  const token = await traktAccessToken(env, link.user_id);
  if (!token) return { ok: false, reason: 'not connected' };

  const listRow = await env.DB.prepare(`SELECT kind FROM lists WHERE id = ?`).bind(link.list_id).first();
  const kind = listRow ? listRow.kind : 'both';
  const typeOk = (mt) => kind === 'both' || (kind === 'movie' && mt === 'movie') || (kind === 'tv' && mt === 'tv');

  const rRows = (await env.DB.prepare(
    `SELECT tmdb_id, media_type, title FROM list_items WHERE list_id = ?`
  ).bind(link.list_id).all()).results || [];
  const R = new Map(rRows.filter((r) => typeOk(r.media_type)).map((r) => [traktKey(r), r]));

  const T = new Map(
    (await traktReadItems(env, token, link.trakt_list_id))
      .filter((i) => typeOk(i.media_type))
      .map((i) => [traktKey(i), i])
  );

  let S;
  try { S = new Set(JSON.parse(link.snapshot || '[]')); } catch { S = new Set(); }

  const removed = new Set([...S].filter((k) => !R.has(k) || !T.has(k)));
  const finalKeys = new Set([...R.keys(), ...T.keys()].filter((k) => !removed.has(k)));
  const itemFor = (k) => R.get(k) || T.get(k);

  const toAddTrakt    = [...finalKeys].filter((k) => !T.has(k)).map(itemFor);
  const toRemoveTrakt = [...T.keys()].filter((k) => !finalKeys.has(k)).map((k) => T.get(k));
  const toAddReelarr    = [...finalKeys].filter((k) => !R.has(k)).map(itemFor);
  const toRemoveReelarr = [...R.keys()].filter((k) => !finalKeys.has(k)).map((k) => R.get(k));

  if (toAddTrakt.length)    await traktApi(env, token, 'POST', traktWritePath(link.trakt_list_id, false), traktItemBody(toAddTrakt));
  if (toRemoveTrakt.length) await traktApi(env, token, 'POST', traktWritePath(link.trakt_list_id, true), traktItemBody(toRemoveTrakt));

  if (toAddReelarr.length) {
    const stmt = env.DB.prepare(`INSERT OR IGNORE INTO list_items (list_id, tmdb_id, media_type, title) VALUES (?, ?, ?, ?)`);
    await env.DB.batch(toAddReelarr.map((i) => stmt.bind(link.list_id, i.tmdb_id, i.media_type, i.title || null)));
  }
  if (toRemoveReelarr.length) {
    const stmt = env.DB.prepare(`DELETE FROM list_items WHERE list_id = ? AND tmdb_id = ? AND media_type = ?`);
    await env.DB.batch(toRemoveReelarr.map((i) => stmt.bind(link.list_id, i.tmdb_id, i.media_type)));
  }

  await env.DB.prepare(
    `UPDATE trakt_list_links SET snapshot = ?, last_synced_at = datetime('now') WHERE list_id = ?`
  ).bind(JSON.stringify([...finalKeys]), link.list_id).run();

  return {
    ok: true,
    addedTrakt: toAddTrakt.length, removedTrakt: toRemoveTrakt.length,
    addedReelarr: toAddReelarr.length, removedReelarr: toRemoveReelarr.length,
  };
}

// Push a single Reelarr-side add/remove straight to the linked Trakt target so
// outbound sync is instant (the 30-min poll then mainly handles inbound Trakt
// changes). The snapshot is intentionally NOT updated here: syncTraktLink's diff
// is self-correcting, so whether this push lands or not, the next full sync
// reconciles — a failed push simply retries then. Never throws (fire-and-forget
// via waitUntil).
async function traktPushItem(env, listId, item, remove) {
  try {
    if (!env.TRAKT_ID) return;
    const link = await env.DB.prepare(
      `SELECT user_id, trakt_list_id FROM trakt_list_links WHERE list_id = ?`
    ).bind(listId).first();
    if (!link) return; // list isn't synced — nothing to do
    const listRow = await env.DB.prepare(`SELECT kind FROM lists WHERE id = ?`).bind(listId).first();
    const kind = listRow ? listRow.kind : 'both';
    if (!(kind === 'both' || (kind === 'movie' && item.media_type === 'movie') || (kind === 'tv' && item.media_type === 'tv'))) return;
    const token = await traktAccessToken(env, link.user_id);
    if (!token) return;
    await traktApi(env, token, 'POST', traktWritePath(link.trakt_list_id, remove), traktItemBody([item]));
  } catch (e) {
    console.warn(`[trakt] push ${remove ? 'remove' : 'add'} list ${listId} failed (reconciles on next sync): ${e.message}`);
  }
}

// Cron entry: background-sync links that have gone stale. Each link is 2-4
// sequential Trakt round-trips, so the per-run LIMIT + staleness window are what
// keep a single scheduled invocation inside its CPU/wall-clock budget — NOT
// Trakt's rate limits (those are per-user and trivially met here). The manual
// "Sync now" button covers anyone who wants an instant update, so the background
// cadence can be relaxed. At larger scale the next steps are: push-on-change
// (sync immediately when a synced list is edited) + a slower pull-only poll, and
// eventually moving the fan-out to Cloudflare Queues instead of one cron loop.
const TRAKT_SYNC_INTERVAL_MIN = 30;
const TRAKT_SYNC_PER_RUN = 50;
async function traktSyncAll(env) {
  if (!env.TRAKT_ID) return;
  const { results } = await env.DB.prepare(
    `SELECT list_id, user_id, trakt_list_id, snapshot FROM trakt_list_links
     WHERE last_synced_at IS NULL OR last_synced_at <= datetime('now', ?)
     ORDER BY last_synced_at ASC NULLS FIRST
     LIMIT ?`
  ).bind(`-${TRAKT_SYNC_INTERVAL_MIN} minutes`, TRAKT_SYNC_PER_RUN).all();
  for (const link of results || []) {
    try { await syncTraktLink(env, link); }
    catch (e) { console.warn(`[trakt] sync list ${link.list_id} failed: ${e.message}`); }
  }
}

// Load a link fresh by id (so the snapshot is current, not whatever was enqueued)
// and reconcile it. Used by the queue consumer.
async function syncTraktLinkById(env, listId) {
  const link = await env.DB.prepare(
    `SELECT list_id, user_id, trakt_list_id, snapshot FROM trakt_list_links WHERE list_id = ?`
  ).bind(listId).first();
  return link ? syncTraktLink(env, link) : null; // null = unlinked since enqueue → skip
}

// Producer: fan stale links onto the queue. Just a D1 read + enqueue, so the
// cron stays within budget regardless of link count — the consumer paces the
// real work. Re-enqueuing an already-queued link is harmless: syncTraktLink is
// idempotent, so a duplicate just finds nothing to do.
const TRAKT_ENQUEUE_LIMIT = 1000;
async function traktEnqueueStale(env) {
  if (!env.TRAKT_ID || !env.TRAKT_QUEUE) return;
  const { results } = await env.DB.prepare(
    `SELECT list_id FROM trakt_list_links
     WHERE last_synced_at IS NULL OR last_synced_at <= datetime('now', ?)
     ORDER BY last_synced_at ASC NULLS FIRST
     LIMIT ?`
  ).bind(`-${TRAKT_SYNC_INTERVAL_MIN} minutes`, TRAKT_ENQUEUE_LIMIT).all();
  const links = results || [];
  // sendBatch accepts up to 100 messages per call.
  for (let i = 0; i < links.length; i += 100) {
    await env.TRAKT_QUEUE.sendBatch(links.slice(i, i + 100).map((l) => ({ body: { list_id: l.list_id } })));
  }
  if (links.length) console.log(`[trakt] enqueued ${links.length} link(s) for background sync`);
}

// Start the OAuth flow — redirect the signed-in user to Trakt's consent screen.
app.get('/api/trakt/connect', withUser, (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  if (!c.env.TRAKT_ID) return c.json({ error: 'Trakt not configured' }, 503);
  const state = newToken().slice(0, 24);
  const https = new URL(c.req.url).protocol === 'https:';
  setCookie(c, 'trakt_state', state, { httpOnly: true, secure: https, sameSite: 'Lax', path: '/', maxAge: 600 });
  // Remember which list the user was setting up, so the callback can drop them
  // back on its Manage view to finish linking.
  const ret = c.req.query('list');
  if (ret) setCookie(c, 'trakt_list', ret, { httpOnly: true, secure: https, sameSite: 'Lax', path: '/', maxAge: 600 });
  const url = new URL(TRAKT_AUTHORIZE);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', c.env.TRAKT_ID);
  url.searchParams.set('redirect_uri', traktRedirectUri(c.env));
  url.searchParams.set('state', state);
  return c.redirect(url.toString());
});

// OAuth callback — verify state, exchange the code, store tokens.
app.get('/auth/trakt', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) { console.warn('[trakt] callback: no session user'); return c.redirect('/?trakt=signin'); }
  const code = c.req.query('code');
  const state = c.req.query('state');
  const expected = getCookie(c, 'trakt_state');
  const ret = getCookie(c, 'trakt_list');
  deleteCookie(c, 'trakt_state', { path: '/' });
  deleteCookie(c, 'trakt_list', { path: '/' });
  const back = (status) => c.redirect(`/?trakt=${status}${ret ? `&list=${encodeURIComponent(ret)}` : ''}`);
  if (!code || !state || state !== expected) {
    console.warn(`[trakt] callback bad state: hasCode=${!!code} state=${state} expected=${expected}`);
    return back('failed');
  }
  try {
    const tok = await traktTokenExchange(c.env, { grant_type: 'authorization_code', code });
    await storeTraktTokens(c.env, u.id, tok);
    try {
      const me = await traktApi(c.env, tok.access_token, 'GET', '/users/me');
      if (me && me.username) await c.env.DB.prepare(`UPDATE trakt_accounts SET username = ? WHERE user_id = ?`).bind(me.username, u.id).run();
    } catch (e) { console.warn(`[trakt] /users/me failed: ${e.message}`); }
    console.log(`[trakt] connected user ${u.id}`);
    return back('connected');
  } catch (e) {
    console.warn(`[trakt] token exchange failed: ${e.message}`);
    return back('failed');
  }
});

// Connection status (drives the UI).
app.get('/api/trakt', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const row = await c.env.DB.prepare(`SELECT username FROM trakt_accounts WHERE user_id = ?`).bind(u.id).first();
  let links = 0;
  if (row) {
    const cnt = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM trakt_list_links WHERE user_id = ?`).bind(u.id).first();
    links = cnt ? cnt.n : 0;
  }
  return c.json({ configured: !!c.env.TRAKT_ID, connected: !!row, username: row ? row.username : null, links });
});

// Disconnect — revoke the token and drop the account. Refused while any lists
// are still synced, so a disconnect can't silently orphan/clear links: the user
// unlinks each synced list first (an explicit, reversible step).
app.delete('/api/trakt', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const cnt = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM trakt_list_links WHERE user_id = ?`).bind(u.id).first();
  if (cnt && cnt.n > 0) return c.json({ error: 'unlink your synced lists first', links: cnt.n }, 409);
  const row = await c.env.DB.prepare(`SELECT access_token FROM trakt_accounts WHERE user_id = ?`).bind(u.id).first();
  if (row) {
    try {
      await fetch(`${TRAKT_API}/oauth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': TRAKT_UA },
        body: JSON.stringify({ token: row.access_token, client_id: c.env.TRAKT_ID, client_secret: c.env.TRAKT_SECRET }),
      });
    } catch {}
  }
  await c.env.DB.prepare(`DELETE FROM trakt_accounts WHERE user_id = ?`).bind(u.id).run();
  return c.json({ ok: true });
});

// The user's existing Trakt lists, for the "link to an existing list" picker.
app.get('/api/trakt/lists', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const token = await traktAccessToken(c.env, u.id);
  if (!token) return c.json({ error: 'not connected' }, 400);
  let lists = [];
  try { lists = await traktApi(c.env, token, 'GET', '/users/me/lists') || []; } catch {}
  return c.json(lists.map((l) => ({ id: String(l.ids.trakt), slug: l.ids.slug, name: l.name, count: l.item_count })));
});

// Link a Reelarr list to a Trakt target and run an initial sync. Body:
// { target: 'watchlist' | 'new' } or { trakt_list_id, trakt_slug }.
app.post('/api/lists/:id/trakt', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const list = await ownedList(c.env, u.id, parseInt(c.req.param('id'), 10));
  if (!list) return c.json({ error: 'not found' }, 404);
  const token = await traktAccessToken(c.env, u.id);
  if (!token) return c.json({ error: 'connect Trakt first' }, 400);
  const body = await c.req.json().catch(() => ({}));

  let traktListId = null, traktSlug = null;
  if (body.target === 'watchlist') {
    traktListId = null;
  } else if (body.target === 'new') {
    try {
      const created = await traktApi(c.env, token, 'POST', '/users/me/lists', {
        name: list.name, description: 'Synced from Reelarr', privacy: 'private',
      });
      traktListId = String(created.ids.trakt);
      traktSlug = created.ids.slug;
    } catch { return c.json({ error: 'could not create Trakt list' }, 502); }
  } else if (body.trakt_list_id) {
    traktListId = String(body.trakt_list_id);
    traktSlug = body.trakt_slug || null;
  } else {
    return c.json({ error: 'target required' }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO trakt_list_links (list_id, user_id, trakt_list_id, trakt_slug, snapshot)
     VALUES (?, ?, ?, ?, '[]')
     ON CONFLICT(list_id) DO UPDATE SET
       trakt_list_id = excluded.trakt_list_id, trakt_slug = excluded.trakt_slug, snapshot = '[]'`
  ).bind(list.id, u.id, traktListId, traktSlug).run();

  const link = await c.env.DB.prepare(
    `SELECT list_id, user_id, trakt_list_id, snapshot FROM trakt_list_links WHERE list_id = ?`
  ).bind(list.id).first();
  let sync = null;
  try { sync = await syncTraktLink(c.env, link); } catch { sync = { ok: false }; }
  return c.json({ ok: true, sync });
});

// Manual "sync now".
app.post('/api/lists/:id/trakt/sync', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const list = await ownedList(c.env, u.id, parseInt(c.req.param('id'), 10));
  if (!list) return c.json({ error: 'not found' }, 404);
  const link = await c.env.DB.prepare(
    `SELECT list_id, user_id, trakt_list_id, snapshot FROM trakt_list_links WHERE list_id = ? AND user_id = ?`
  ).bind(list.id, u.id).first();
  if (!link) return c.json({ error: 'not linked' }, 400);
  try { return c.json({ ok: true, sync: await syncTraktLink(c.env, link) }); }
  catch { return c.json({ error: 'sync failed' }, 502); }
});

// Unlink (leaves both the Reelarr list and the Trakt list intact, just stops syncing).
app.delete('/api/lists/:id/trakt', withUser, async (c) => {
  const u = requireUser(c);
  if (!u) return c.json({ error: 'not signed in' }, 401);
  const id = parseInt(c.req.param('id'), 10);
  const list = await ownedList(c.env, u.id, id);
  if (!list) return c.json({ error: 'not found' }, 404);
  await c.env.DB.prepare(`DELETE FROM trakt_list_links WHERE list_id = ? AND user_id = ?`).bind(id, u.id).run();
  return c.json({ ok: true });
});

app.get('/api/health', (c) => c.json({ tmdb: !!c.env.TMDB_API_KEY }));

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(prewarm(env));
    // Fan stale Trakt links onto the queue (decoupled/retried/batched). Falls
    // back to inline sync where the queue binding is absent (e.g. local dev).
    ctx.waitUntil(env.TRAKT_QUEUE ? traktEnqueueStale(env) : traktSyncAll(env));
  },
  // Queue consumer: each message is one list to reconcile. ack on success;
  // retry on failure (Queues redelivers up to max_retries). syncTraktLink is
  // idempotent, so retries and duplicate deliveries are safe; a message dropped
  // after max_retries just gets re-enqueued by the next cron (last_synced_at
  // only advances on success).
  async queue(batch, env, ctx) {
    for (const msg of batch.messages) {
      try {
        const r = await syncTraktLinkById(env, msg.body.list_id);
        if (r && r.ok) console.log(`[trakt] queue synced list ${msg.body.list_id}: trakt +${r.addedTrakt}/-${r.removedTrakt}, reelarr +${r.addedReelarr}/-${r.removedReelarr}`);
        msg.ack();
      } catch (e) {
        console.warn(`[trakt] queue sync list ${msg.body && msg.body.list_id} failed: ${e.message}`);
        msg.retry();
      }
    }
  },
};
