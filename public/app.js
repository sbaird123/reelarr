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
  // Lists & friends are account features — only surface them when signed in.
  const listsBtn = document.getElementById('lists-btn');
  if (listsBtn) listsBtn.hidden = !user;
  const friendsBtn = document.getElementById('friends-btn');
  if (friendsBtn) friendsBtn.hidden = !user;
  updateNotifBell(); // signed-in only, and on mobile only when the inbox isn't empty
  // Slim sign-in strip: only for signed-out users who haven't dismissed it.
  const banner = document.getElementById('signin-banner');
  if (banner) {
    let dismissed = false;
    try { dismissed = localStorage.getItem('reelarr_hide_signin_banner') === '1'; } catch {}
    banner.classList.toggle('hidden', !!user || dismissed);
  }
  if (user) {
    const initial = (user.name || user.email || '?').trim().charAt(0).toUpperCase();
    slot.innerHTML = `
      <div id="account">
        ${user.avatar
          ? `<img id="avatar" src="${escapeHtml(user.avatar)}" alt="Sign out" title="Sign out" referrerpolicy="no-referrer" />`
          : `<div id="avatar" class="avatar-fallback" title="Sign out">${escapeHtml(initial)}</div>`}
      </div>`;
    // Tap the avatar to sign out (confirm guards against a mis-tap).
    const avatarEl = document.getElementById('avatar');
    if (avatarEl) avatarEl.addEventListener('click', () => { if (confirm('Sign out?')) logout(); });
  } else {
    slot.innerHTML = `<button id="login-btn">Sign in</button>`;
    document.getElementById('login-btn').addEventListener('click', () => {
      location.href = '/auth/google';
    });
  }
}

// ── Lists (named watchlists) ──────────────────────────────────────────────────
// Server-backed; signed-in only. myLists caches [{id,name,count}]; null = stale.
let myLists = null;
let pickerItem = null;

async function loadLists(force = false) {
  if (myLists && !force) return myLists;
  try {
    const res = await fetch('/api/lists');
    myLists = res.ok ? await res.json() : [];
  } catch { myLists = []; }
  return myLists;
}

// Bottom-sheet picker: drop the given item into a list, or spin up a new one.
async function openPicker(item) {
  if (!user) { requireSignIn('Sign in to save titles to your lists.'); return; }
  pickerItem = item;
  document.getElementById('picker-title').textContent = `Add "${item.title}" to…`;
  document.getElementById('picker-overlay').classList.remove('hidden');
  await renderPickerLists();
}

function closePicker() {
  document.getElementById('picker-overlay').classList.add('hidden');
  document.getElementById('picker-new-name').value = '';
  pickerItem = null;
}

async function renderPickerLists() {
  const box = document.getElementById('picker-lists');
  box.innerHTML = '<div class="picker-empty">Loading…</div>';
  // Only lists you can add to — your own or shared lists where you're an editor —
  // and only ones whose kind matches the item: a TV title can't go in a movies-
  // only list (or vice versa); 'both' lists always qualify.
  const mt = pickerItem && pickerItem.media_type === 'tv' ? 'tv' : 'movie';
  const lists = (await loadLists(true)).filter((l) =>
    (l.role === 'owner' || l.role === 'editor') && (l.kind === 'both' || l.kind === mt));
  if (!lists.length) {
    box.innerHTML = `<div class="picker-empty">No ${mt === 'tv' ? 'TV' : 'movie'} lists yet — create one below.</div>`;
    return;
  }
  box.innerHTML = '';
  lists.forEach((l) => {
    const row = document.createElement('button');
    row.className = 'picker-row';
    row.innerHTML = `<span class="picker-row-name">${escapeHtml(l.name)}</span><span class="picker-row-count">${l.count}</span>`;
    row.addEventListener('click', () => addItemToList(l.id, pickerItem));
    box.appendChild(row);
  });
}

async function addItemToList(listId, item) {
  if (!item) return;
  try {
    const res = await fetch(`/api/lists/${listId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tmdbId: item.id, mediaType: item.media_type || 'movie', title: item.title }),
    });
    if (!res.ok) throw new Error();
    myLists = null; // counts changed
    closePicker();
    toast(`Added "${item.title}" to list`);
  } catch { toast('Could not add to list'); }
}

// "My Lists" manager overlay — list of lists, drilling into one shows its items.
async function openListsView() {
  if (!user) { requireSignIn('Sign in to create and manage lists.'); return; }
  document.getElementById('lists-overlay').classList.remove('hidden');
  await renderListsView();
}

function closeListsView() {
  document.getElementById('lists-overlay').classList.add('hidden');
}

async function renderListsView() {
  const body = document.getElementById('lists-body');
  document.getElementById('lists-heading').textContent = 'My Lists';
  body.innerHTML = '<div class="picker-empty">Loading…</div>';
  const lists = await loadLists(true);
  renderTabs(); // list set may have changed (created/deleted/kind) — refresh feed tabs
  body.innerHTML = '';

  const intro = document.createElement('p');
  intro.className = 'overlay-intro';
  intro.textContent = 'Save movies & TV to a list, play it as its own feed, sync it to Radarr/Sonarr, or share it with friends.';
  body.appendChild(intro);

  const form = document.createElement('form');
  form.className = 'lists-create';
  form.innerHTML = `
    <input type="text" placeholder="New list name…" maxlength="100" autocomplete="off" />
    <select class="lists-create-kind" title="List type">
      <option value="both">Movies &amp; TV</option>
      <option value="movie">Movies</option>
      <option value="tv">TV</option>
    </select>
    <button type="submit">Create</button>`;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('input');
    const name = input.value.trim();
    if (!name) return;
    await createList(name, form.querySelector('.lists-create-kind').value);
    input.value = '';
    renderListsView();
  });
  body.appendChild(form);

  const owned = lists.filter((l) => l.role === 'owner');
  const shared = lists.filter((l) => l.role !== 'owner');

  if (!owned.length) {
    const empty = document.createElement('div');
    empty.className = 'picker-empty';
    empty.textContent = 'No lists yet.';
    body.appendChild(empty);
  } else {
    owned.forEach((l) => body.appendChild(ownedListCard(l)));
  }

  if (shared.length) {
    body.appendChild(friendSection('Shared with me'));
    shared.forEach((l) => body.appendChild(sharedListCard(l)));
  }
}

function ownedListCard(l) {
  const card = document.createElement('div');
  card.className = 'list-card';
  card.innerHTML = `
    <div class="list-card-head">
      <span class="list-card-name">${escapeHtml(l.name)}</span>
      <span class="list-card-count">${l.shared ? '<span class="sync-badge">SYNCED</span> ' : ''}${l.count} item${l.count === 1 ? '' : 's'}</span>
    </div>
    <div class="list-card-actions">
      <button class="list-open">Manage</button>
      <button class="list-rename">Rename</button>
      <button class="list-delete">Delete</button>
    </div>`;
  card.querySelector('.list-open').addEventListener('click', () => openListDetail(l));
  card.querySelector('.list-rename').addEventListener('click', async () => {
    const name = prompt('Rename list', l.name);
    if (name && name.trim()) { await renameList(l.id, name.trim()); renderListsView(); }
  });
  card.querySelector('.list-delete').addEventListener('click', async () => {
    if (confirm(`Delete "${l.name}"? This can't be undone.`)) { await deleteList(l.id); renderListsView(); }
  });
  return card;
}

function sharedListCard(l) {
  const card = document.createElement('div');
  card.className = 'list-card';
  const roleLabel = l.role === 'editor' ? 'can edit' : 'view only';
  const openLabel = l.role === 'editor' ? 'Manage' : 'View';
  card.innerHTML = `
    <div class="list-card-head">
      <span class="list-card-name">${escapeHtml(l.name)}</span>
      <span class="list-card-count">${l.count} item${l.count === 1 ? '' : 's'}</span>
    </div>
    <div class="list-card-sub">by ${escapeHtml(l.owner_name || 'a friend')} · ${roleLabel}</div>
    <div class="list-card-actions">
      <button class="list-open">${openLabel}</button>
      <button class="list-leave">Leave</button>
    </div>`;
  card.querySelector('.list-open').addEventListener('click', () => openListDetail(l));
  card.querySelector('.list-leave').addEventListener('click', async () => {
    if (confirm(`Leave "${l.name}"?`)) { await leaveList(l.id); renderListsView(); }
  });
  return card;
}

async function openListDetail(list) {
  const body = document.getElementById('lists-body');
  document.getElementById('lists-heading').textContent = list.name;
  body.innerHTML = '<div class="picker-empty">Loading…</div>';
  let data;
  try { data = await (await fetch(`/api/lists/${list.id}`)).json(); }
  catch { body.innerHTML = '<div class="picker-empty">Could not load list.</div>'; return; }

  const role = data.role || 'owner';
  const canEdit = role === 'owner' || role === 'editor';

  body.innerHTML = '';
  const back = document.createElement('button');
  back.className = 'list-back';
  back.textContent = '‹ All lists';
  back.addEventListener('click', renderListsView);
  body.appendChild(back);

  // Sharing + collaborator management are owner-only.
  if (role === 'owner') {
    body.appendChild(buildKindControl(list, data.kind));
    body.appendChild(buildWatchedToggle(list, data.hide_watched));
    body.appendChild(buildSharePanel(list, data.share, data.kind));
    body.appendChild(buildTraktPanel(list, data.trakt));
    body.appendChild(buildCollabPanel(list));
  } else {
    const banner = document.createElement('div');
    banner.className = 'list-role-banner';
    banner.textContent = role === 'editor' ? 'Shared with you · you can add and remove titles' : 'Shared with you · view only';
    body.appendChild(banner);
  }

  const items = data.items || [];
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'picker-empty';
    empty.textContent = canEdit
      ? 'This list is empty. Add titles from the feed with “+ List”.'
      : 'This list is empty.';
    body.appendChild(empty);
    return;
  }
  items.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'list-item-row';
    const badge = it.media_type === 'tv' ? '<span class="media-badge">TV</span>' : '';
    const remove = canEdit ? '<button class="list-item-remove" title="Remove">&#10005;</button>' : '';
    row.innerHTML = `<span class="list-item-title">${escapeHtml(it.title || `#${it.tmdb_id}`)}</span>${badge}${remove}`;
    const rm = row.querySelector('.list-item-remove');
    if (rm) rm.addEventListener('click', async () => {
      await removeListItem(list.id, it.tmdb_id, it.media_type);
      row.remove();
      myLists = null;
    });
    body.appendChild(row);
  });
}

// Owner-only: set whether the list is for movies, TV, or both. Drives which
// screen(s) it appears on as a feed and which *arr URLs show.
function buildKindControl(list, kind) {
  const wrap = document.createElement('div');
  wrap.className = 'kind-control';
  wrap.innerHTML = `
    <label>List type</label>
    <select class="kind-sel">
      <option value="both">Movies &amp; TV</option>
      <option value="movie">Movies</option>
      <option value="tv">TV</option>
    </select>`;
  const sel = wrap.querySelector('.kind-sel');
  sel.value = kind || 'both';
  sel.addEventListener('change', async () => {
    await updateListKind(list.id, sel.value);
    await loadLists(true); renderTabs();
    openListDetail(list); // re-render so the *arr URLs match the new kind
  });
  return wrap;
}

// Owner-only: whether this list's feed hides titles you've marked watched.
function buildWatchedToggle(list, hideWatched) {
  const wrap = document.createElement('label');
  wrap.className = 'list-toggle';
  wrap.innerHTML = `<input type="checkbox" ${hideWatched ? 'checked' : ''} />
    <span>Hide titles I've watched from this list's feed</span>`;
  const cb = wrap.querySelector('input');
  cb.addEventListener('change', async () => {
    await updateListWatched(list.id, cb.checked);
    await loadLists(true);
    // If this list is the feed currently on screen, refresh it to reflect the change.
    if (currentList === `list:${list.id}`) loadFeed(true);
  });
  return wrap;
}

async function updateListWatched(id, hide) {
  try { await fetch(`/api/lists/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hide_watched: hide }) }); myLists = null; }
  catch {}
}

// Owner-only "Shared with" panel: current collaborators + add-a-friend control.
function buildCollabPanel(list) {
  const panel = document.createElement('div');
  panel.className = 'collab-panel';
  panel.innerHTML = `<div class="share-head">Shared with</div><div class="collab-list">Loading…</div>`;
  renderCollab(list, panel);
  return panel;
}

async function renderCollab(list, panel) {
  const box = panel.querySelector('.collab-list');
  box.innerHTML = 'Loading…';
  let collabs = [];
  let friends = [];
  try {
    const [cRes, fData] = await Promise.all([
      fetch(`/api/lists/${list.id}/collaborators`).then((r) => r.ok ? r.json() : []),
      loadFriends(),
    ]);
    collabs = cRes || [];
    friends = (fData && fData.friends) || [];
  } catch {}

  box.innerHTML = '';
  collabs.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'collab-row';
    row.innerHTML = `<span class="collab-name">${escapeHtml(c.name || c.email)}</span>
      <span class="collab-role">${c.role === 'editor' ? 'editor' : 'viewer'}</span>
      <button class="collab-remove" title="Remove">&#10005;</button>`;
    row.querySelector('.collab-remove').addEventListener('click', async () => {
      await removeCollaborator(list.id, c.id);
      renderCollab(list, panel);
    });
    box.appendChild(row);
  });
  if (!collabs.length) {
    const e = document.createElement('div');
    e.className = 'collab-empty';
    e.textContent = 'Not shared with anyone yet.';
    box.appendChild(e);
  }

  // Add control — only friends who aren't already collaborators.
  const collabIds = new Set(collabs.map((c) => c.id));
  const available = friends.filter((f) => !collabIds.has(f.id));
  const add = document.createElement('div');
  add.className = 'collab-add';
  if (!friends.length) {
    add.innerHTML = `<span class="collab-empty">Add friends first to share lists.</span>`;
  } else if (!available.length) {
    add.innerHTML = `<span class="collab-empty">All your friends are already on this list.</span>`;
  } else {
    const opts = available.map((f) => `<option value="${f.id}">${escapeHtml(f.name || f.email)}</option>`).join('');
    add.innerHTML = `
      <select class="collab-friend">${opts}</select>
      <select class="collab-role-sel"><option value="viewer">viewer</option><option value="editor">editor</option></select>
      <button class="collab-add-btn">Share</button>`;
    add.querySelector('.collab-add-btn').addEventListener('click', async () => {
      const userId = parseInt(add.querySelector('.collab-friend').value, 10);
      const r = add.querySelector('.collab-role-sel').value;
      const ok = await addCollaborator(list.id, userId, r);
      toast(ok ? 'List shared' : 'Could not share');
      renderCollab(list, panel);
      myLists = null;
    });
  }
  box.appendChild(add);
}

async function addCollaborator(listId, userId, role) {
  try { const r = await fetch(`/api/lists/${listId}/collaborators`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId, role }) }); return r.ok; }
  catch { return false; }
}
async function removeCollaborator(listId, userId) {
  try { await fetch(`/api/lists/${listId}/collaborators/${userId}`, { method: 'DELETE' }); } catch {}
}
async function leaveList(listId) {
  // The client doesn't know its own user id, so use the dedicated endpoint that
  // resolves "me" from the session.
  try { await fetch(`/api/lists/${listId}/leave`, { method: 'POST' }); } catch {}
}

// Radarr/Sonarr sync panel for a single list. share = {token, radarr, sonarr}
// when enabled, else null.
function buildSharePanel(list, share, kind) {
  const panel = document.createElement('div');
  panel.className = 'share-panel';
  // Which *arr apps are relevant depends on the list's kind.
  const showRadarr = kind !== 'tv';
  const showSonarr = kind !== 'movie';
  const appsLabel = showRadarr && showSonarr ? 'Radarr / Sonarr' : showRadarr ? 'Radarr' : 'Sonarr';

  if (!share) {
    panel.innerHTML = `
      <div class="share-head">Sync with ${appsLabel}</div>
      <p class="share-help">Generate a private import URL that ${appsLabel} can subscribe to.</p>
      <button class="share-enable">Enable sync</button>`;
    panel.querySelector('.share-enable').addEventListener('click', async () => {
      const res = await enableShare(list.id);
      if (res) { myLists = null; openListDetail(list); }
      else toast('Could not enable sync');
    });
    return panel;
  }

  const radarrRow = showRadarr ? `
    <div class="share-url">
      <label>Radarr (movies) — Settings → Lists → + → StevenLu Custom</label>
      <div class="share-url-row"><input readonly value="${escapeHtml(share.radarr)}" /><button data-copy="${escapeHtml(share.radarr)}">Copy</button></div>
    </div>` : '';
  const sonarrRow = showSonarr ? `
    <div class="share-url">
      <label>Sonarr (TV) — Settings → Import Lists → + → Custom List</label>
      <div class="share-url-row"><input readonly value="${escapeHtml(share.sonarr)}" /><button data-copy="${escapeHtml(share.sonarr)}">Copy</button></div>
    </div>` : '';

  panel.innerHTML = `
    <div class="share-head">Sync with ${appsLabel}</div>
    <p class="share-help">Add the URL${showRadarr && showSonarr ? 's' : ''} below as a custom import list.</p>
    ${radarrRow}${sonarrRow}
    <button class="share-disable">Stop syncing</button>`;

  panel.querySelectorAll('button[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(btn.dataset.copy); toast('URL copied'); }
      catch {
        // Clipboard API needs HTTPS/permission — fall back to selecting the input.
        const input = btn.previousElementSibling;
        input.select(); document.execCommand('copy'); toast('URL copied');
      }
    });
  });
  panel.querySelector('.share-disable').addEventListener('click', async () => {
    if (!confirm('Stop syncing? The import URLs will stop working immediately.')) return;
    await disableShare(list.id);
    myLists = null;
    openListDetail(list);
  });
  return panel;
}

async function enableShare(listId) {
  try { const r = await fetch(`/api/lists/${listId}/share`, { method: 'POST' }); return r.ok ? await r.json() : null; }
  catch { return null; }
}
async function disableShare(listId) {
  try { await fetch(`/api/lists/${listId}/share`, { method: 'DELETE' }); }
  catch {}
}

// ── Trakt sync panel (owner-only) ─────────────────────────────────────────────
// Two-way sync a list with a Trakt list or the Trakt watchlist. The panel stays
// hidden until Trakt is configured server-side (TRAKT_ID secret set).
function buildTraktPanel(list, trakt) {
  const panel = document.createElement('div');
  panel.className = 'share-panel trakt-panel';
  panel.innerHTML = `<div class="share-head">Trakt sync</div><div class="trakt-body">Loading…</div>`;
  renderTrakt(list, trakt, panel);
  return panel;
}

async function renderTrakt(list, trakt, panel) {
  const box = panel.querySelector('.trakt-body');
  let status;
  try { status = await (await fetch('/api/trakt')).json(); } catch { status = null; }

  // Hide the whole panel until Trakt is wired up server-side.
  if (!status || !status.configured) { panel.classList.add('hidden'); return; }

  if (!status.connected) {
    box.innerHTML = `
      <p class="share-help">Two-way sync this list with a Trakt list or your Trakt watchlist — so Plex, Kometa, SIMKL and others can read it too. Syncs automatically in the background.</p>
      <button class="trakt-connect">Connect Trakt account</button>`;
    box.querySelector('.trakt-connect').addEventListener('click', () => { location.href = `/api/trakt/connect?list=${list.id}`; });
    return;
  }

  if (trakt) {
    const target = trakt.target === 'watchlist'
      ? 'your Trakt watchlist'
      : `a Trakt list${trakt.slug ? ` (“${escapeHtml(trakt.slug)}”)` : ''}`;
    const last = trakt.last_synced_at ? `Last synced ${timeAgo(trakt.last_synced_at)}` : 'Not synced yet';
    box.innerHTML = `
      <p class="share-help">Syncing with ${target} as <strong>${escapeHtml(status.username || 'your account')}</strong>. Your edits push to Trakt instantly; changes made on Trakt appear here within ~30 min — or hit <em>Sync now</em>.</p>
      <div class="trakt-meta">${escapeHtml(last)}</div>
      <div class="trakt-actions">
        <button class="trakt-sync">Sync now</button>
        <button class="trakt-unlink">Unlink</button>
      </div>`;
    box.querySelector('.trakt-sync').addEventListener('click', async () => {
      const btn = box.querySelector('.trakt-sync'); btn.disabled = true; btn.textContent = 'Syncing…';
      const ok = await syncTrakt(list.id);
      toast(ok ? 'Synced with Trakt' : 'Trakt sync failed');
      myLists = null;
      openListDetail(list);
    });
    box.querySelector('.trakt-unlink').addEventListener('click', async () => {
      if (!confirm('Stop syncing this list with Trakt? Both lists are kept — they just stop syncing.')) return;
      await unlinkTrakt(list.id);
      openListDetail(list);
    });
    return;
  }

  // Connected, but this list isn't linked yet — pick a target.
  // Disconnect is only offered when nothing is synced; otherwise the user is
  // told to unlink first (the backend enforces this too).
  const disconnectCtl = status.links > 0
    ? `<div class="trakt-note">To disconnect Trakt, first unlink your ${status.links} synced list${status.links === 1 ? '' : 's'}.</div>`
    : `<button class="trakt-disconnect">Disconnect Trakt</button>`;
  box.innerHTML = `
    <div class="trakt-status">Connected as <strong>${escapeHtml(status.username || 'your account')}</strong> · this list isn’t synced yet.</div>
    <label class="trakt-label">Choose what to sync this list with, then tap Link &amp; sync:</label>
    <select class="trakt-target">
      <option value="new">Create a new Trakt list</option>
      <option value="watchlist">My Trakt watchlist</option>
    </select>
    <div class="trakt-actions">
      <button class="trakt-link">Link &amp; sync</button>
    </div>
    <div class="trakt-disconnect-row">${disconnectCtl}</div>`;

  const sel = box.querySelector('.trakt-target');
  // Offer the user's existing Trakt lists as link targets too.
  let existing = [];
  try { existing = await (await fetch('/api/trakt/lists')).json(); } catch {}
  if (Array.isArray(existing) && existing.length) {
    const og = document.createElement('optgroup');
    og.label = 'Existing Trakt lists';
    existing.forEach((l) => {
      const o = document.createElement('option');
      o.value = `existing:${l.id}`;
      o.dataset.slug = l.slug || '';
      o.textContent = `${l.name} (${l.count})`;
      og.appendChild(o);
    });
    sel.appendChild(og);
  }

  box.querySelector('.trakt-link').addEventListener('click', async () => {
    const v = sel.value;
    let payload;
    if (v === 'new') payload = { target: 'new' };
    else if (v === 'watchlist') payload = { target: 'watchlist' };
    else if (v.startsWith('existing:')) {
      const opt = sel.options[sel.selectedIndex];
      payload = { trakt_list_id: v.slice('existing:'.length), trakt_slug: opt.dataset.slug || null };
    }
    const btn = box.querySelector('.trakt-link'); btn.disabled = true; btn.textContent = 'Linking…';
    const ok = await linkTrakt(list.id, payload);
    toast(ok ? 'Linked & synced with Trakt' : 'Could not link to Trakt');
    myLists = null;
    openListDetail(list);
  });
  const disc = box.querySelector('.trakt-disconnect');
  if (disc) disc.addEventListener('click', async () => {
    if (!confirm('Disconnect your Trakt account?')) return;
    const ok = await disconnectTrakt();
    if (!ok) toast('Unlink your synced lists first');
    openListDetail(list);
  });
}

async function linkTrakt(listId, payload) {
  try { const r = await fetch(`/api/lists/${listId}/trakt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return r.ok; }
  catch { return false; }
}
async function syncTrakt(listId) {
  try { const r = await fetch(`/api/lists/${listId}/trakt/sync`, { method: 'POST' }); return r.ok; }
  catch { return false; }
}
async function unlinkTrakt(listId) {
  try { await fetch(`/api/lists/${listId}/trakt`, { method: 'DELETE' }); } catch {}
}
async function disconnectTrakt() {
  try { const r = await fetch('/api/trakt', { method: 'DELETE' }); return r.ok; }
  catch { return false; }
}

async function createList(name, kind) {
  try { const r = await fetch('/api/lists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, kind }) }); if (r.ok) myLists = null; }
  catch {}
}
async function updateListKind(id, kind) {
  try { await fetch(`/api/lists/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) }); myLists = null; }
  catch {}
}
async function renameList(id, name) {
  try { await fetch(`/api/lists/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); myLists = null; }
  catch {}
}
async function deleteList(id) {
  try { await fetch(`/api/lists/${id}`, { method: 'DELETE' }); myLists = null; }
  catch {}
}
async function removeListItem(listId, tmdbId, mediaType) {
  try { await fetch(`/api/lists/${listId}/items/${tmdbId}?mediaType=${mediaType || 'movie'}`, { method: 'DELETE' }); }
  catch {}
}

// ── Friends ───────────────────────────────────────────────────────────────────
async function loadFriends() {
  try { const r = await fetch('/api/friends'); return r.ok ? await r.json() : null; }
  catch { return null; }
}

// Badge on the header button reflects incoming (pending) requests.
async function refreshFriendBadge() {
  if (!user) return;
  const data = await loadFriends();
  const badge = document.getElementById('friends-badge');
  if (!badge) return;
  const n = data && data.incoming ? data.incoming.length : 0;
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
}

function openFriendsView() {
  if (!user) { requireSignIn('Sign in to add friends.'); return; }
  document.getElementById('friends-overlay').classList.remove('hidden');
  renderFriendsView();
}
function closeFriendsView() {
  document.getElementById('friends-overlay').classList.add('hidden');
}

async function renderFriendsView() {
  const body = document.getElementById('friends-body');
  body.innerHTML = '<div class="picker-empty">Loading…</div>';
  const data = await loadFriends();
  if (!data) { body.innerHTML = '<div class="picker-empty">Could not load friends.</div>'; return; }
  body.innerHTML = '';

  const intro = document.createElement('p');
  intro.className = 'overlay-intro';
  intro.textContent = "Add friends by email to share lists. They confirm before you're connected — and if they're not on Reelarr yet, we'll email them an invite.";
  body.appendChild(intro);

  const form = document.createElement('form');
  form.className = 'friend-add';
  form.innerHTML = `<input type="email" placeholder="Friend's email…" autocomplete="off" /><button type="submit">Add</button>`;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('input');
    const email = input.value.trim();
    if (!email) return;
    const res = await addFriend(email);
    input.value = '';
    toast(friendMsg(res));
    renderFriendsView();
    refreshFriendBadge();
  });
  body.appendChild(form);

  if (data.incoming.length) {
    body.appendChild(friendSection(`Requests (${data.incoming.length})`));
    data.incoming.forEach((f) => body.appendChild(friendRow(f, 'incoming')));
  }

  body.appendChild(friendSection(`Friends (${data.friends.length})`));
  if (!data.friends.length) {
    const e = document.createElement('div');
    e.className = 'picker-empty';
    e.textContent = 'No friends yet — add one by email above.';
    body.appendChild(e);
  } else {
    data.friends.forEach((f) => body.appendChild(friendRow(f, 'friend')));
  }

  const invited = data.invited || [];
  if (data.outgoing.length || invited.length) {
    body.appendChild(friendSection('Pending'));
    data.outgoing.forEach((f) => body.appendChild(friendRow(f, 'outgoing')));
    invited.forEach((inv) => body.appendChild(inviteRow(inv)));
  }
}

// A pending email invite to someone who hasn't signed up yet.
function inviteRow(inv) {
  const row = document.createElement('div');
  row.className = 'friend-row';
  row.innerHTML = `<div class="friend-avatar friend-avatar-fallback">@</div>
    <div class="friend-meta">
      <span class="friend-name">${escapeHtml(inv.email)}</span>
      <span class="friend-email">Invited — not on Reelarr yet</span>
    </div>
    <div class="friend-actions"><button class="friend-cancel">Cancel</button></div>`;
  row.querySelector('.friend-cancel').addEventListener('click', async () => {
    await cancelInvite(inv.email);
    renderFriendsView();
  });
  return row;
}

async function cancelInvite(email) {
  try { await fetch(`/api/friends/invite?email=${encodeURIComponent(email)}`, { method: 'DELETE' }); } catch {}
}

// ── Recommend to a friend ─────────────────────────────────────────────────────
let recItem = null;

async function openRecommend(item) {
  if (!user) { requireSignIn('Sign in to recommend titles to friends.'); return; }
  recItem = item;
  document.getElementById('rec-title').textContent = `Recommend "${item.title}"`;
  document.getElementById('rec-note').value = '';
  document.getElementById('rec-overlay').classList.remove('hidden');
  const box = document.getElementById('rec-friends');
  box.innerHTML = '<div class="picker-empty">Loading…</div>';
  const data = await loadFriends();
  const friends = (data && data.friends) || [];
  if (!friends.length) {
    box.innerHTML = '<div class="picker-empty">Add friends first to recommend titles.</div>';
    return;
  }
  box.innerHTML = '';
  friends.forEach((f) => {
    const row = document.createElement('button');
    row.className = 'picker-row';
    row.innerHTML = `<span class="picker-row-name">${escapeHtml(f.name || f.email)}</span><span class="picker-row-count">Send</span>`;
    row.addEventListener('click', () => sendRecommend(f.id, f.name || f.email));
    box.appendChild(row);
  });
}

function closeRecommend() {
  document.getElementById('rec-overlay').classList.add('hidden');
  recItem = null;
}

async function sendRecommend(toUserId, name) {
  if (!recItem) return;
  const note = document.getElementById('rec-note').value.trim();
  try {
    const r = await fetch('/api/recommend', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toUserId, tmdbId: recItem.id, mediaType: recItem.media_type || 'movie', title: recItem.title, note }),
    });
    if (!r.ok) throw new Error();
    toast(`Recommended to ${name}`);
    closeRecommend();
  } catch { toast('Could not send recommendation'); }
}

// ── Notifications (recommendations inbox) ──────────────────────────────────────
async function loadRecommendations() {
  try { const r = await fetch('/api/recommendations'); return r.ok ? await r.json() : null; }
  catch { return null; }
}

// Tracks inbox size so the bell can be hidden on mobile when there's nothing.
let notifTotal = 0;

async function refreshNotifBadge() {
  if (!user) return;
  const data = await loadRecommendations();
  const badge = document.getElementById('notif-badge');
  if (!badge) return;
  const n = data ? data.unseen : 0;
  badge.textContent = n;
  badge.classList.toggle('hidden', !n);
  const recCount = data && data.recommendations ? data.recommendations.length : 0;
  const shareCount = data && data.shares ? data.shares.length : 0;
  notifTotal = recCount + shareCount;
  updateNotifBell();
}

// Bell visibility: hidden when signed out; on narrow screens also hidden when
// the inbox is empty, to free up header space on small phones. Wider screens
// always show it when signed in.
function updateNotifBell() {
  const btn = document.getElementById('notif-btn');
  if (!btn) return;
  const mobile = window.matchMedia('(max-width: 640px)').matches;
  btn.hidden = !user || (mobile && notifTotal === 0);
}
// Re-evaluate on rotate/resize so the bell appears/disappears as the layout flips.
window.addEventListener('resize', updateNotifBell);

async function openNotifications() {
  if (!user) { requireSignIn('Sign in to see recommendations from friends.'); return; }
  document.getElementById('notif-overlay').classList.remove('hidden');
  await renderNotifications();
  // Opening counts as reading them — clear the badge.
  try { await fetch('/api/recommendations/seen', { method: 'POST' }); } catch {}
  const badge = document.getElementById('notif-badge');
  if (badge) badge.classList.add('hidden');
}

function closeNotifications() {
  document.getElementById('notif-overlay').classList.add('hidden');
}

async function renderNotifications() {
  const body = document.getElementById('notif-body');
  body.innerHTML = '<div class="picker-empty">Loading…</div>';
  const data = await loadRecommendations();
  const recs = (data && data.recommendations) || [];
  const shares = (data && data.shares) || [];
  body.innerHTML = '';
  if (!recs.length && !shares.length) {
    body.innerHTML = '<div class="picker-empty">No notifications yet. Recommendations and lists friends share with you show up here.</div>';
    return;
  }
  // Shared-with-you lists (unseen alerts) sit at the top.
  shares.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'notif-row unseen';
    row.innerHTML = `
      <div class="notif-meta">
        <span class="notif-text"><strong>${escapeHtml(s.from_name || 'A friend')}</strong> shared the list <strong>${escapeHtml(s.list_name || 'a list')}</strong> with you</span>
      </div>
      <div class="notif-actions">
        <button class="notif-open">Open</button>
      </div>`;
    row.querySelector('.notif-open').addEventListener('click', () => {
      closeNotifications();
      document.getElementById('lists-overlay').classList.remove('hidden');
      openListDetail({ id: s.list_id, name: s.list_name });
    });
    body.appendChild(row);
  });
  recs.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'notif-row' + (r.seen ? '' : ' unseen');
    const badge = r.media_type === 'tv' ? '<span class="media-badge">TV</span>' : '';
    const note = r.note ? `<span class="notif-note">"${escapeHtml(r.note)}"</span>` : '';
    row.innerHTML = `
      <div class="notif-meta">
        <span class="notif-text"><strong>${escapeHtml(r.from_name || 'A friend')}</strong> recommended <strong>${escapeHtml(r.title || `#${r.tmdb_id}`)}</strong> ${badge}</span>
        ${note}
      </div>
      <div class="notif-actions">
        <button class="notif-add">+ List</button>
        <button class="notif-dismiss" title="Dismiss">&#10005;</button>
      </div>`;
    row.querySelector('.notif-add').addEventListener('click', () =>
      openPicker({ id: r.tmdb_id, media_type: r.media_type, title: r.title }));
    row.querySelector('.notif-dismiss').addEventListener('click', async () => {
      await dismissRecommendation(r.id);
      row.remove();
      // Keep the inbox count current so the bell hides on mobile once empty.
      notifTotal = Math.max(0, notifTotal - 1);
      updateNotifBell();
      if (!notifTotal) body.innerHTML = '<div class="picker-empty">No recommendations yet. When a friend recommends a movie or show, it shows up here.</div>';
    });
    body.appendChild(row);
  });
}

async function dismissRecommendation(id) {
  try { await fetch(`/api/recommendations/${id}`, { method: 'DELETE' }); } catch {}
}

function friendSection(text) {
  const h = document.createElement('div');
  h.className = 'friend-section';
  h.textContent = text;
  return h;
}

function friendRow(f, kind) {
  const row = document.createElement('div');
  row.className = 'friend-row';
  const initial = (f.name || f.email || '?').trim().charAt(0).toUpperCase();
  const avatar = f.avatar
    ? `<img class="friend-avatar" src="${escapeHtml(f.avatar)}" referrerpolicy="no-referrer" alt="" />`
    : `<div class="friend-avatar friend-avatar-fallback">${escapeHtml(initial)}</div>`;
  let actions = '';
  if (kind === 'incoming') actions = `<button class="friend-accept">Accept</button><button class="friend-decline">Decline</button>`;
  else if (kind === 'friend') actions = `<button class="friend-remove">Remove</button>`;
  else actions = `<button class="friend-cancel">Cancel</button>`;
  row.innerHTML = `${avatar}
    <div class="friend-meta">
      <span class="friend-name">${escapeHtml(f.name || f.email || 'Unknown')}</span>
      <span class="friend-email">${escapeHtml(f.email || '')}</span>
    </div>
    <div class="friend-actions">${actions}</div>`;

  const reload = async () => { await renderFriendsView(); refreshFriendBadge(); };
  const acc = row.querySelector('.friend-accept');
  if (acc) acc.addEventListener('click', async () => { await acceptFriend(f.id); reload(); });
  const dec = row.querySelector('.friend-decline');
  if (dec) dec.addEventListener('click', async () => { await removeFriend(f.id); reload(); });
  const rem = row.querySelector('.friend-remove');
  if (rem) rem.addEventListener('click', async () => { if (confirm(`Remove ${f.name || f.email}?`)) { await removeFriend(f.id); reload(); } });
  const can = row.querySelector('.friend-cancel');
  if (can) can.addEventListener('click', async () => { await removeFriend(f.id); reload(); });
  return row;
}

function friendMsg(res) {
  if (!res) return 'Could not send request';
  switch (res.status) {
    case 'requested':         return 'Friend request sent';
    case 'invited':           return "They're not on Reelarr yet — we've emailed them an invite";
    case 'accepted':          return 'You are now friends';
    case 'already_friends':   return 'You are already friends';
    case 'already_requested': return 'Request already sent';
    default:                  return res.error || 'Could not send request';
  }
}

async function addFriend(email) {
  try {
    const r = await fetch('/api/friends', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    return await r.json();
  } catch { return null; }
}
async function acceptFriend(userId) {
  try { await fetch(`/api/friends/${userId}/accept`, { method: 'POST' }); } catch {}
}
async function removeFriend(userId) {
  try { await fetch(`/api/friends/${userId}`, { method: 'DELETE' }); } catch {}
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

// SQLite's datetime('now') is UTC with no offset — parse as UTC, render relative.
function timeAgo(sqlTs) {
  const t = Date.parse(String(sqlTs).replace(' ', 'T') + 'Z');
  if (isNaN(t)) return sqlTs;
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Signed-out users can still tap slide actions like "+ List" / "Recommend".
// Rather than dead-ending on a toast — the header Sign in button can be hard to
// spot or cut off on small phones — offer to start the sign-in flow right here.
function requireSignIn(reason) {
  if (confirm(`${reason}\n\nSign in now?`)) location.href = '/auth/google';
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
// Built-in feed tabs for the mode, plus the user's lists whose kind matches it
// (a 'both' list shows on both screens). List tabs are keyed `list:<id>`.
function tabsForMode() {
  const wantMovie = currentMode === 'movies';
  const lists = (myLists || []).filter((l) =>
    wantMovie ? (l.kind === 'movie' || l.kind === 'both') : (l.kind === 'tv' || l.kind === 'both'));
  return TABS[currentMode].concat(lists.map((l) => ({ list: `list:${l.id}`, label: l.name })));
}

function renderTabs() {
  const tabs = tabsForMode();
  const container = document.getElementById('nav-tabs');
  container.innerHTML = '';
  tabs.forEach((t) => {
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
  tabs.forEach((t) => {
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
        <button class="btn-list">+ List</button>
        <button class="btn-rec">Recommend</button>
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

  slide.querySelector('.btn-list').addEventListener('click', () => openPicker(item));
  slide.querySelector('.btn-rec').addEventListener('click', () => openRecommend(item));

  slide.querySelector('.btn-skip').addEventListener('click', () => {
    // Don't recordSkip() here — advanceOrLoad() slides to the next item, and the
    // resulting slideChangeTransitionEnd records the skip for the slide we left.
    // Calling it here too would double-count this item in skipProbability.
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

  // List feeds are curated, so they skip discovery's skip-deprioritization and
  // hide watched titles only when the list's "hide watched" option is on.
  const isListFeed = String(currentList).startsWith('list:');
  let listHideWatched = true;
  if (isListFeed) {
    const l = (myLists || []).find((x) => `list:${x.id}` === currentList);
    listHideWatched = l ? !!l.hide_watched : true;
  }

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

    // A user list played as a feed — single page, fetched from the list endpoint.
    if (String(currentList).startsWith('list:')) {
      const listId = currentList.slice(5);
      const type = currentMode === 'tv' ? 'tv' : 'movie';
      const r = await fetch(`/api/lists/${listId}/feed?type=${type}`, { signal }).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      results = shuffle(r.results || []);
      newTotalPages = 1;
      nextPage = 2;
      if (!results.length) toast('No trailers in this list yet');
    } else {
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

    const filtered = results.filter((item) => {
      if (isListFeed) {
        // Curated list: no skip-deprioritization; hide watched only if opted in.
        return !(listHideWatched && watchedSet.has(watchedKey(item.id, item.media_type)));
      }
      return !watchedSet.has(watchedKey(item.id, item.media_type)) &&
        Math.random() >= skipProbability(item.id, item.media_type);
    });
    if (isListFeed && reset && !filtered.length && results.length) {
      toast('Everything in this list is marked watched — turn off “Hide watched” in the list options to show them');
    }
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

// ── Sign-in strip wiring ──────────────────────────────────────────────────────
document.getElementById('signin-banner-btn').addEventListener('click', () => {
  location.href = '/auth/google';
});
document.getElementById('signin-banner-close').addEventListener('click', () => {
  try { localStorage.setItem('reelarr_hide_signin_banner', '1'); } catch {}
  document.getElementById('signin-banner').classList.add('hidden');
});

// ── Lists UI wiring ───────────────────────────────────────────────────────────
document.getElementById('lists-btn').addEventListener('click', openListsView);
document.getElementById('lists-close').addEventListener('click', closeListsView);
document.getElementById('friends-btn').addEventListener('click', openFriendsView);
document.getElementById('friends-close').addEventListener('click', closeFriendsView);
document.getElementById('notif-btn').addEventListener('click', openNotifications);
document.getElementById('notif-close').addEventListener('click', closeNotifications);
document.getElementById('rec-close').addEventListener('click', closeRecommend);
document.getElementById('rec-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'rec-overlay') closeRecommend();
});
document.getElementById('picker-close').addEventListener('click', closePicker);
document.getElementById('picker-overlay').addEventListener('click', (e) => {
  // Tap the dimmed backdrop (not the sheet) to dismiss.
  if (e.target.id === 'picker-overlay') closePicker();
});
document.getElementById('picker-new').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('picker-new-name');
  const name = input.value.trim();
  if (!name || !pickerItem) return;
  // Create the list, then immediately drop the pending item into it.
  try {
    const res = await fetch('/api/lists', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error();
    const list = await res.json();
    myLists = null;
    await addItemToList(list.id, pickerItem);
    await loadLists(true); renderTabs(); // new list may be a feed tab
  } catch { toast('Could not create list'); }
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

  // Surface the Trakt OAuth result (set by the /auth/trakt redirect), then strip
  // the params so a refresh doesn't re-toast. If a list id came back, reopen its
  // Manage view once lists load (below) so the user can finish linking.
  const traktParams = new URLSearchParams(location.search);
  const tp = traktParams.get('trakt');
  const traktReturnList = traktParams.get('list');
  if (tp) {
    toast(tp === 'connected' ? (traktReturnList ? 'Trakt connected — now choose what to sync' : 'Trakt connected')
      : tp === 'signin' ? 'Sign in first, then connect Trakt'
      : 'Trakt connection failed');
    history.replaceState(null, '', location.pathname);
  }

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
      refreshFriendBadge();      // surface any pending friend requests
      refreshNotifBadge();       // surface unseen recommendations
      // Light poll so notifications appear while the tab stays open.
      setInterval(() => { if (user) { refreshNotifBadge(); refreshFriendBadge(); } }, 60000);
      await loadLists(true);     // so the user's lists appear as feed tabs
      renderTabs();
      // Returning from a Trakt connect — drop the user back on that list's
      // Manage view so they can pick a target and finish linking.
      if (tp === 'connected' && traktReturnList) {
        const l = (myLists || []).find((x) => String(x.id) === String(traktReturnList));
        if (l) { document.getElementById('lists-overlay').classList.remove('hidden'); openListDetail(l); }
      }
    }
  });
})();
