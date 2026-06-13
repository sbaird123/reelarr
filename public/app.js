// ── Utilities ─────────────────────────────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Titles/overviews come from TMDB, which is user-editable — escape anything
// that lands in innerHTML.
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Swipe history (localStorage) ─────────────────────────────────────────────
const HISTORY_KEY = 'reelarr_skips';
const MAX_HISTORY = 500;

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}'); } catch { return {}; }
}
function saveHistory(h) { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); }
// Keys are namespaced by media type — movie and TV ids live in separate TMDB
// namespaces, so a bare numeric id can collide across them.
function recordSkip(tmdbId, mediaType) {
  const h = loadHistory();
  const key = watchedKey(tmdbId, mediaType);
  h[key] = (h[key] || 0) + 1;
  const keys = Object.keys(h);
  if (keys.length > MAX_HISTORY) {
    keys.sort((a, b) => h[a] - h[b]).slice(0, keys.length - MAX_HISTORY).forEach((k) => delete h[k]);
  }
  saveHistory(h);
}
function skipProbability(tmdbId, mediaType) {
  const count = loadHistory()[watchedKey(tmdbId, mediaType)] || 0;
  if (count === 0) return 0;
  return Math.min(0.8, 1 - Math.pow(0.7, count));
}

// ── Watched ────────────────────────────────────────────────────────────────
// Signed in → the watched list lives in D1 and syncs across devices. Signed
// out → it lives in the browser (localStorage), and is merged into the account
// on the next sign-in. Skip history (above) stays local for now — it's a
// high-write stream that wants batching before it goes server-side.
const WATCHED_KEY = 'reelarr_watched';
function watchedKey(tmdbId, mediaType) { return `${tmdbId}:${mediaType || 'movie'}`; }

function loadWatchedStore() {
  try { return JSON.parse(localStorage.getItem(WATCHED_KEY) || '{}'); } catch { return {}; }
}

// Instant, synchronous — used for first paint before the auth check resolves.
function loadWatchedLocal() {
  watchedSet = new Set(Object.keys(loadWatchedStore()));
}

async function loadWatchedServer() {
  try {
    const res = await fetch('/api/watched/ids');
    if (!res.ok) return;
    const rows = await res.json();
    watchedSet = new Set(rows.map((r) => watchedKey(r.tmdb_id, r.media_type)));
  } catch {}
}

function markWatched(item) {
  const key = watchedKey(item.id, item.media_type);
  watchedSet.add(key);
  if (user) {
    fetch('/api/watched', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmdbId: item.id, mediaType: item.media_type || 'movie', title: item.title }),
    }).catch(() => {});
  } else {
    const store = loadWatchedStore();
    store[key] = item.title || 1;
    try { localStorage.setItem(WATCHED_KEY, JSON.stringify(store)); } catch {}
  }
}

// ── Account / auth ──────────────────────────────────────────────────────────
async function loadMe() {
  try {
    const res = await fetch('/api/me');
    user = res.ok ? (await res.json()).user : null;
  } catch { user = null; }
}

// On first sign-in, push any locally-stored watched entries into the account,
// then clear them so the server is the single source of truth.
async function syncLocalToServer() {
  const store = loadWatchedStore();
  const items = Object.entries(store).map(([k, title]) => {
    const [tmdbId, mediaType] = k.split(':');
    return { tmdbId, mediaType, title: typeof title === 'string' ? title : null };
  });
  if (!items.length) return;
  try {
    const res = await fetch('/api/watched/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    if (res.ok) localStorage.removeItem(WATCHED_KEY);
  } catch {}
}

async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  location.reload();
}

function renderAuthUI() {
  const slot = document.getElementById('auth-slot');
  if (!slot) return;
  if (user) {
    const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase();
    slot.innerHTML = `
      <div id="account">
        ${user.avatar
          ? `<img id="avatar" src="${escapeHtml(user.avatar)}" alt="" referrerpolicy="no-referrer" />`
          : `<div id="avatar" class="avatar-fallback">${escapeHtml(initial)}</div>`}
        <button id="logout-btn" title="Sign out">Sign out</button>
      </div>`;
    document.getElementById('logout-btn').addEventListener('click', logout);
  } else {
    slot.innerHTML = `<button id="login-btn">Sign in</button>`;
    document.getElementById('login-btn').addEventListener('click', () => {
      location.href = '/auth/google';
    });
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let currentMode = 'movies';
let currentList = window.__INITIAL_LIST__ || 'upcoming';
let currentPage = 1;
let totalPages = 1;
let loading = false;
let feedAbortController = null;
let swiper = null;
let watchedSet = new Set();
let user = null;
let players = {};
let playerReady = {};
let ytApiReady = false;
let ytApiCallbacks = [];
let ytApiLoaded = false;
let itemCache = [];
// Once the user has interacted with the page at all, browsers allow unmuted
// playback without the muted-first-then-unmute dance. Flip this on any gesture
// so subsequent swipes unmute cleanly and eagerly.
let audioEnabled = false;
['pointerdown', 'touchstart', 'keydown'].forEach((evt) => {
  window.addEventListener(evt, () => {
    audioEnabled = true;
    const hint = document.getElementById('mute-hint');
    if (hint) hint.classList.remove('show');
  }, { once: true, capture: true, passive: true });
});

// Keep the active slide's YT player plus the next one forward (users swipe
// forward ~95% of the time). Going wider than +1 causes the active video to
// stall — more than two iframes compete for the 6-connection limit to
// googlevideo.com and for main-thread cycles. Everything else is a thumbnail
// facade; preconnect hints in <head> keep the TCP/QUIC handshake warm.
const PLAYER_WINDOW = 1;

// Delay neighbour creation so the active video has a clean shot at its first
// few segments before the +1 iframe starts competing. Short enough that the
// warm-up is done before a typical next-swipe.
const WARM_AHEAD_DELAY_MS = 1500;
let warmTimer = null;

// Brief muted play-kick for neighbour players to pull the first video segment
// down. Without this YT only loads the player UI; bytes don't arrive until
// playVideo() fires. 300ms is long enough to cache the opening seconds but
// short enough not to meaningfully compete with the active player.
const NEIGHBOUR_KICK_MS = 300;

// If the active player sits in BUFFERING longer than this, kick it with
// playVideo(). YT occasionally fails to recover on its own after a stall.
const STALL_RECOVERY_MS = 4000;
let stallTimers = {};

const TABS = {
  movies: [
    { list: 'upcoming',    label: 'Upcoming' },
    { list: 'now_playing', label: 'Now Playing' },
    { list: 'popular',     label: 'Popular' },
  ],
  tv: [
    { list: 'trending',      label: 'Trending' },
    { list: 'popular',       label: 'Popular' },
    { list: 'new_upcoming',  label: 'New & Upcoming' },
    { list: 'on_the_air',    label: 'On Air' },
    { list: 'top_rated',     label: 'Top Rated' },
  ],
};

// ── YouTube IFrame API (lazy) ─────────────────────────────────────────────────
// Load the YT script only when we actually need a player, so first paint
// doesn't pay the cost.
window.onYouTubeIframeAPIReady = function () {
  ytApiReady = true;
  ytApiCallbacks.forEach((cb) => cb());
  ytApiCallbacks = [];
};

function loadYtApi() {
  if (ytApiLoaded) return;
  ytApiLoaded = true;
  const s = document.createElement('script');
  s.src = 'https://www.youtube.com/iframe_api';
  s.async = true;
  document.head.appendChild(s);
}

function whenYtReady(cb) {
  if (ytApiReady) return cb();
  ytApiCallbacks.push(cb);
  loadYtApi();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function toast(msg, duration = 2800) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

function setLoading(on) {
  document.getElementById('loading-overlay').classList.toggle('hidden', !on);
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function renderTabs() {
  const container = document.getElementById('nav-tabs');
  container.innerHTML = '';
  TABS[currentMode].forEach((t) => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (t.list === currentList ? ' active' : '');
    btn.dataset.list = t.list;
    btn.textContent = t.label;
    btn.addEventListener('click', () => {
      if (t.list === currentList) return;
      currentList = t.list;
      renderTabs();
      loadFeed(true);
    });
    container.appendChild(btn);
  });

  // Mirror into mobile dropdown.
  const listSel = document.getElementById('list-select');
  listSel.innerHTML = '';
  TABS[currentMode].forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t.list;
    opt.textContent = t.label;
    if (t.list === currentList) opt.selected = true;
    listSel.appendChild(opt);
  });

  document.getElementById('mode-select').value = currentMode;
  document.getElementById('search-input').placeholder =
    currentMode === 'movies' ? 'Search movies...' : 'Search TV shows...';
}

// ── Slide builder (with YouTube facade) ──────────────────────────────────────
function ytThumb(key) {
  // hqdefault (480x360) is guaranteed to exist for every video. maxresdefault
  // is nicer when present but 404s on older/less-popular trailers, noisily —
  // and this thumbnail is only visible for the split second before the real
  // iframe loads over it, so the quality delta isn't worth the console spam.
  return { primary: `https://i.ytimg.com/vi/${key}/hqdefault.jpg` };
}

function buildSlide(item, index) {
  const isTv = item.media_type === 'tv';
  const slide = document.createElement('div');
  slide.className = 'swiper-slide';
  slide.dataset.index = index;
  slide.dataset.tmdbId = item.id;
  slide.dataset.mediaType = item.media_type || 'movie';

  const safeTitle = escapeHtml(item.title);
  const year = item.release_date ? item.release_date.slice(0, 4) : '';
  const thumb = ytThumb(item.youtube_key);

  slide.innerHTML = `
    <div class="slide-bg" style="background-image:url('${item.backdrop_path || item.poster_path || ''}')"></div>
    <div class="video-wrap" id="vwrap-${index}">
      <div class="yt-facade" id="yt-facade-${index}">
        <img class="yt-facade-img" src="${thumb.primary}" alt="" loading="lazy" />
      </div>
      <div class="yt-mount" id="yt-${index}" hidden></div>
    </div>
    <div class="touch-shield" id="shield-${index}">
      <div class="play-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="#fff">
          <polygon points="5,3 19,12 5,21"/>
        </svg>
      </div>
    </div>
    <div class="slide-info">
      <div class="slide-title">${safeTitle}</div>
      <div class="slide-meta">
        <span class="rating">&#9733; ${item.vote_average ? item.vote_average.toFixed(1) : 'N/A'}</span>
        <span>${year}</span>
        ${isTv ? '<span class="media-badge">TV</span>' : ''}
      </div>
      <div class="slide-overview">${escapeHtml(item.overview)}</div>
      <div class="slide-actions">
        <button class="btn-watched">Watched</button>
        <button class="btn-skip">Skip</button>
      </div>
    </div>
  `;

  slide.querySelector(`#shield-${index}`).addEventListener('click', () => {
    // First tap on a slide whose player hasn't materialized yet → create + play.
    const idx = parseInt(slide.dataset.index, 10);
    if (!players[idx]) ensurePlayer(item, idx);
    togglePlay(idx);
  });

  slide.querySelector('.btn-watched').addEventListener('click', async () => {
    await markWatched(item);
    toast(`"${item.title}" marked as watched`);
    advanceOrLoad();
  });

  slide.querySelector('.btn-skip').addEventListener('click', () => {
    recordSkip(item.id, item.media_type);
    advanceOrLoad();
  });

  return slide;
}

// ── YouTube player management ────────────────────────────────────────────────
function createPlayer(item, index) {
  if (players[index]) return;
  const mount = document.getElementById(`yt-${index}`);
  const facade = document.getElementById(`yt-facade-${index}`);
  if (!mount) return;
  mount.hidden = false;
  if (facade) facade.hidden = true;

  whenYtReady(() => {
    if (!document.getElementById(`yt-${index}`)) return; // slide removed before API loaded
    players[index] = new YT.Player(`yt-${index}`, {
      videoId: item.youtube_key,
      playerVars: {
        autoplay: 0,
        controls: 0,
        rel: 0,
        modestbranding: 1,
        playsinline: 1,
        enablejsapi: 1,
        // Declaring origin up front lets YT's widget target postMessage correctly
        // from the first handshake, instead of logging "target origin mismatch"
        // warnings until the iframe has fully loaded.
        origin: window.location.origin,
      },
      events: {
        onReady: (e) => {
          playerReady[index] = true;
          e.target.mute();
          // Cap quality at 720p. Auto-quality sometimes picks 1080p which has
          // larger segments and recovers slower after a stall.
          try { e.target.setPlaybackQuality('hd720'); } catch {}
          const active = swiper ? swiper.activeIndex : 0;
          if (active === index) {
            autoPlaySlide(index);
          } else {
            // Neighbour: short muted play-kick to cache the first segment, then
            // pause. Bail if the user swiped onto this slide mid-kick (pausing
            // a now-active player would kill playback).
            try { e.target.playVideo(); } catch {}
            setTimeout(() => {
              if (players[index] !== e.target) return;
              if (swiper && swiper.activeIndex === index) return;
              try { e.target.pauseVideo(); } catch {}
            }, NEIGHBOUR_KICK_MS);
          }
        },
        onStateChange: (e) => {
          const shield = document.getElementById(`shield-${index}`);
          // Treat BUFFERING as "still playing" so the overlay play-icon doesn't
          // flash every time the stream stalls for a moment.
          const busy = e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.BUFFERING;
          if (shield) shield.classList.toggle('playing', busy);

          // Stall watchdog: if we enter BUFFERING and don't leave it within
          // STALL_RECOVERY_MS, kick with playVideo() — YT sometimes fails to
          // resume on its own after a segment fetch times out.
          clearTimeout(stallTimers[index]);
          if (e.data === YT.PlayerState.BUFFERING) {
            stallTimers[index] = setTimeout(() => {
              const p = players[index];
              if (!p) return;
              try {
                if (p.getPlayerState() === YT.PlayerState.BUFFERING) p.playVideo();
              } catch {}
            }, STALL_RECOVERY_MS);
          }
        },
      },
    });
  });
}

function destroyPlayer(index) {
  const p = players[index];
  if (!p) return;
  try { p.destroy(); } catch {}
  delete players[index];
  delete playerReady[index];
  clearTimeout(stallTimers[index]);
  delete stallTimers[index];
  // Restore facade so there's still something to look at.
  const mount  = document.getElementById(`yt-${index}`);
  const facade = document.getElementById(`yt-facade-${index}`);
  const shield = document.getElementById(`shield-${index}`);
  if (mount)  { mount.hidden = true; mount.innerHTML = ''; }
  if (facade) facade.hidden = false;
  if (shield) shield.classList.remove('playing');
}

function togglePlay(index) {
  const p = players[index];
  if (!p || !playerReady[index]) return;
  const state = p.getPlayerState();
  let muted = false;
  try { muted = p.isMuted(); } catch {}

  // Muted-but-playing (autoplay default, or warm-up) → tap should unmute,
  // not pause. Only a tap on an actually-audible playing video pauses.
  if (state === YT.PlayerState.PLAYING && !muted) {
    p.pauseVideo();
  } else {
    try {
      if (state !== YT.PlayerState.PLAYING) p.playVideo();
      p.unMute();
      p.setVolume(80);
    } catch {}
    audioEnabled = true;
  }
}

function autoPlaySlide(index) {
  Object.keys(players).forEach((i) => {
    const idx = parseInt(i, 10);
    if (idx === index || !players[i] || !playerReady[i]) return;
    try {
      players[i].mute();
      players[i].pauseVideo();
    } catch {}
  });
  const p = players[index];
  if (!p || !playerReady[index]) return;

  // Optimistically hide the play-icon overlay so it doesn't flash while we
  // wait for YT's onStateChange to catch up.
  const shield = document.getElementById(`shield-${index}`);
  if (shield) shield.classList.add('playing');

  let state;
  try { state = p.getPlayerState(); } catch {}

  if (audioEnabled) {
    // User has interacted — we're in a live gesture frame, so unmute eagerly
    // and synchronously. Browsers honour unMute() only while the gesture is
    // still in scope, so no setTimeout here.
    try {
      p.unMute();
      p.setVolume(70);
      if (state !== YT.PlayerState.PLAYING) p.playVideo();
    } catch {}
  } else {
    // First slide, no gesture yet — muted autoplay is all the browser allows.
    // User will tap to unmute (togglePlay flips audioEnabled from then on).
    try { p.mute(); p.playVideo(); } catch {}
    const hint = document.getElementById('mute-hint');
    if (hint) hint.classList.add('show');
  }
}

function ensurePlayer(item, index) {
  if (players[index]) return;
  createPlayer(item, index);
}

// Skip/Watched helper: advance to next slide, but if we're already on the
// last one, kick loadFeed() and advance when the new slides arrive. Guards
// against the "skip does nothing" dead-end when the feed pipeline runs dry.
function advanceOrLoad() {
  if (!swiper) return;
  const atEnd = swiper.activeIndex >= itemCache.length - 1;
  if (!atEnd) {
    swiper.slideNext();
    return;
  }
  // Already on the last slide — need more content before we can advance.
  if (currentPage > totalPages) {
    toast('No more trailers in this list — try another tab');
    return;
  }
  const targetLen = itemCache.length;
  loadFeed().then(() => {
    if (itemCache.length > targetLen && swiper) swiper.slideNext();
    else toast('No more trailers in this list — try another tab');
  });
}

// Keep only the active player and the forward window; destroy the rest.
function gcPlayers(activeIdx) {
  const keep = new Set([activeIdx]);
  for (let d = 1; d <= PLAYER_WINDOW; d++) keep.add(activeIdx + d);
  Object.keys(players).forEach((k) => {
    const i = parseInt(k, 10);
    if (!keep.has(i)) destroyPlayer(i);
  });
}

// Create neighbour players on a delay so the active slide gets its first
// segments in cleanly before anything else competes for bandwidth.
function warmNeighbours(activeIdx) {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    if (!swiper || swiper.activeIndex !== activeIdx) return;
    for (let d = 1; d <= PLAYER_WINDOW; d++) {
      const ni = activeIdx + d;
      if (ni < 0 || ni >= itemCache.length) continue;
      if (players[ni]) continue;
      createPlayer(itemCache[ni], ni);
    }
  }, WARM_AHEAD_DELAY_MS);
}

// ── Feed loading ──────────────────────────────────────────────────────────────
async function loadFeed(reset = false) {
  if (loading && !reset) return;
  if (!reset && currentPage > totalPages) return;

  if (reset && feedAbortController) feedAbortController.abort();
  feedAbortController = new AbortController();
  const signal = feedAbortController.signal;

  loading = true;

  // Only show the full-screen spinner on cold load (nothing visible yet).
  // For tab switches we keep the old slides on-screen during the fetch so the
  // UI doesn't feel like it's reloading — the swap happens atomically once
  // the new data arrives.
  const coldLoad = reset && !itemCache.length;
  if (coldLoad) setLoading(true);

  // Compute the fetch target page without mutating shared state yet, so an
  // aborted fetch doesn't leave things half-reset.
  let fetchPage = currentPage;
  if (reset) {
    const maxStartPage = currentMode === 'tv' ? 3 : 6;
    fetchPage = Math.floor(Math.random() * maxStartPage) + 1;
  }

  try {
    let results, newTotalPages, nextPage;

    const base = currentMode === 'tv'
      ? `/api/shows/feed?list=${currentList}`
      : `/api/feed?list=${currentList}`;

    if (reset) {
      let [r1, r2] = await Promise.all([
        fetch(`${base}&page=${fetchPage}`, { signal }).then((r) => r.json()),
        fetch(`${base}&page=${fetchPage + 1}`, { signal }).then((r) => r.json()),
      ]);
      if (r1.error) throw new Error(r1.error);
      // Random start can overshoot a short list (or land on pages the server
      // filtered to nothing, e.g. already-released "upcoming" movies). Don't
      // strand the user on a blank feed — fall back to the front.
      if (fetchPage > 1 && !(r1.results || []).length && !(r2.results || []).length) {
        fetchPage = 1;
        [r1, r2] = await Promise.all([
          fetch(`${base}&page=1`, { signal }).then((r) => r.json()),
          fetch(`${base}&page=2`, { signal }).then((r) => r.json()),
        ]);
        if (r1.error) throw new Error(r1.error);
      }
      newTotalPages = r1.total_pages;
      nextPage = fetchPage + 2;
      results = shuffle([...(r1.results || []), ...(r2.results || [])]);
    } else {
      const r = await fetch(`${base}&page=${currentPage}`, { signal }).then((r) => r.json());
      if (r.error) throw new Error(r.error);
      newTotalPages = r.total_pages;
      nextPage = currentPage + 1;
      results = shuffle(r.results || []);
    }

    // Data arrived — commit the reset now (tear down old players, clear cache,
    // blank the wrapper). This all happens synchronously with the rebuild so
    // the user sees one atomic swap rather than a blank screen.
    if (reset) {
      Object.keys(players).forEach((i) => destroyPlayer(parseInt(i, 10)));
      players = {};
      playerReady = {};
      itemCache = [];
    }

    totalPages = newTotalPages;
    currentPage = nextPage;

    const filtered = results.filter((item) =>
      !watchedSet.has(watchedKey(item.id, item.media_type)) &&
      Math.random() >= skipProbability(item.id, item.media_type)
    );
    const startIndex = itemCache.length;
    itemCache.push(...filtered);

    const wrapper = document.getElementById('swiper-wrapper');
    if (reset) wrapper.innerHTML = '';

    filtered.forEach((item, i) => {
      wrapper.appendChild(buildSlide(item, startIndex + i));
    });

    if (!swiper) {
      initSwiper();
    } else {
      swiper.update();
      if (reset) {
        swiper.slideTo(0, 0, false);
        const first = itemCache[0];
        if (first) {
          ensurePlayer(first, 0);
          warmNeighbours(0);
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error('[loadFeed] error:', err);
      toast('Error: ' + err.message);
    }
  } finally {
    if (!signal.aborted) {
      loading = false;
      if (coldLoad) setLoading(false);
    }
  }
}

// ── Swiper init ───────────────────────────────────────────────────────────────
function initSwiper() {
  swiper = new Swiper('#main-swiper', {
    direction: 'vertical',
    slidesPerView: 1,
    speed: 380,
    resistanceRatio: 0.7,
    on: {
      // Kick off neighbour warm-ups the instant the swipe begins so the 380ms
      // of transition animation is spent pre-buffering, not waiting.
      slideChangeTransitionStart(s) {
        if (itemCache[s.activeIndex]) warmNeighbours(s.activeIndex);
      },
      slideChangeTransitionEnd(s) {
        const idx = s.activeIndex;
        const item = itemCache[idx];
        if (!item) return;

        // Only a forward swipe counts as skipping the slide we left — swiping
        // back to rewatch something shouldn't penalize the slide before it.
        if (s.previousIndex < idx) {
          const prev = itemCache[s.previousIndex];
          if (prev) recordSkip(prev.id, prev.media_type);
        }

        ensurePlayer(item, idx);
        autoPlaySlide(idx);
        gcPlayers(idx);

        if (idx >= itemCache.length - 4) loadFeed();
      },
    },
  });

  // Warm the initial window on cold boot — the first swipe shouldn't be the
  // one that triggers everything from scratch.
  const first = itemCache[0];
  if (first) {
    ensurePlayer(first, 0);
    warmNeighbours(0);
  }
}

// ── Mode toggle ───────────────────────────────────────────────────────────────
function switchMode(mode) {
  if (mode === currentMode) return;
  currentMode = mode;
  currentList = TABS[currentMode][0].list;
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
  renderTabs();
  loadFeed(true);
}

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchMode(btn.dataset.mode));
});

document.getElementById('mode-select').addEventListener('change', (e) => {
  switchMode(e.target.value);
});

document.getElementById('list-select').addEventListener('change', (e) => {
  if (e.target.value === currentList) return;
  currentList = e.target.value;
  renderTabs();
  loadFeed(true);
});

// ── Search ────────────────────────────────────────────────────────────────────
let searchTimer = null;

document.getElementById('search-btn').addEventListener('click', () => {
  document.getElementById('search-overlay').classList.remove('hidden');
  document.getElementById('search-input').focus();
});

document.getElementById('search-close').addEventListener('click', closeSearch);

function closeSearch() {
  document.getElementById('search-overlay').classList.add('hidden');
  document.getElementById('search-input').value = '';
  document.getElementById('search-results').innerHTML = '';
}

document.getElementById('search-input').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { document.getElementById('search-results').innerHTML = ''; return; }
  searchTimer = setTimeout(() => doSearch(q), 420);
});

async function doSearch(q) {
  try {
    const endpoint = currentMode === 'tv'
      ? `/api/shows/search?q=${encodeURIComponent(q)}`
      : `/api/search?q=${encodeURIComponent(q)}`;
    const res = await fetch(endpoint);
    const data = await res.json();
    renderSearchResults(data.results || []);
  } catch {}
}

function renderSearchResults(items) {
  const container = document.getElementById('search-results');
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<p style="color:#888;text-align:center;padding:20px">No results</p>';
    return;
  }
  items.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'search-card';
    card.innerHTML = `
      <img class="search-poster" src="${escapeHtml(item.poster_path)}" alt="" loading="lazy" onerror="this.onerror=null;this.style.background='#222';this.removeAttribute('src')" />
      <div class="search-info">
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.overview)}</p>
      </div>
    `;

    card.querySelector('.search-info').addEventListener('click', () => {
      if (!item.youtube_key) { toast('No trailer available'); return; }
      closeSearch();
      injectItem(item);
    });

    container.appendChild(card);
  });
}

// ── Inject item at top of feed ────────────────────────────────────────────────
function injectItem(item) {
  itemCache.unshift(item);

  const wrapper = document.getElementById('swiper-wrapper');
  Array.from(wrapper.querySelectorAll('.swiper-slide')).forEach((slide, i) => {
    const newIdx = i + 1;
    slide.dataset.index = newIdx;
    const vwrap  = slide.querySelector('[id^="vwrap-"]');
    const ytDiv  = slide.querySelector('[id^="yt-"]:not(.yt-facade)');
    const facade = slide.querySelector('[id^="yt-facade-"]');
    const shield = slide.querySelector('[id^="shield-"]');
    if (vwrap)  vwrap.id  = `vwrap-${newIdx}`;
    if (ytDiv)  ytDiv.id  = `yt-${newIdx}`;
    if (facade) facade.id = `yt-facade-${newIdx}`;
    if (shield) shield.id = `shield-${newIdx}`;
  });

  const newPlayers = {};
  const newReady = {};
  Object.keys(players).forEach((k) => {
    newPlayers[parseInt(k) + 1] = players[k];
    newReady[parseInt(k) + 1] = playerReady[k];
  });
  players = newPlayers;
  playerReady = newReady;

  // Shift pending stall watchdogs too, or one could kick the wrong player.
  const newStall = {};
  Object.keys(stallTimers).forEach((k) => {
    newStall[parseInt(k) + 1] = stallTimers[k];
  });
  stallTimers = newStall;

  const newSlide = buildSlide(item, 0);
  wrapper.prepend(newSlide);

  swiper.update();
  swiper.slideTo(0, 0);
  ensurePlayer(item, 0);
  setTimeout(() => autoPlaySlide(0), 600);
}

// ── SSR hydration ─────────────────────────────────────────────────────────────
function hydrateInitial(payload) {
  totalPages = payload.total_pages || 1;
  // Server gave us page 1; next fetch should continue from page 2 (but we also
  // randomize start later on true resets).
  currentPage = 2;

  const filtered = (payload.results || []).filter((item) =>
    !watchedSet.has(watchedKey(item.id, item.media_type)) &&
    Math.random() >= skipProbability(item.id, item.media_type)
  );
  const list = shuffle([...filtered]);
  itemCache.push(...list);

  const wrapper = document.getElementById('swiper-wrapper');
  list.forEach((item, i) => wrapper.appendChild(buildSlide(item, i)));

  if (!swiper) initSwiper();
}

// ── Boot ──────────────────────────────────────────────────────────────────────
(function boot() {
  renderTabs();
  loadWatchedLocal(); // instant, so first paint can filter without waiting on auth

  const initialFeed = window.__INITIAL_FEED__;
  if (initialFeed && Array.isArray(initialFeed.results) && initialFeed.results.length) {
    hydrateInitial(initialFeed);
  } else {
    // No SSR data (TMDB cold, or SSR raced past its deadline) — client fetch.
    loadFeed(true);
  }

  // Resolve auth in the background; upgrade the watched source if signed in.
  loadMe().then(async () => {
    renderAuthUI();
    if (user) {
      await syncLocalToServer();
      await loadWatchedServer(); // future feed pages filter against the account
    }
  });
})();
