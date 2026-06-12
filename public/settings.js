// ── Settings page ────────────────────────────────────────────────────────────
const FIELDS = [
  'tmdb_api_key',
];
let initial = {};

// ── Load + dirty tracking ─────────────────────────────────────────────────────
async function load() {
  const res = await fetch('/api/settings');
  const data = await res.json();
  initial = { ...data };
  for (const k of FIELDS) {
    const el = document.getElementById(k);
    if (el) el.value = data[k] || '';
  }
  updateDirty();
}

function current() {
  const out = {};
  for (const k of FIELDS) out[k] = document.getElementById(k).value.trim();
  return out;
}

function isDirty() {
  const c = current();
  return FIELDS.some((k) => (c[k] || '') !== (initial[k] || ''));
}

function updateDirty() {
  const dirty = isDirty();
  document.getElementById('btn-save').disabled = !dirty;
  document.getElementById('btn-revert').disabled = !dirty;
  document.body.classList.toggle('has-unsaved', dirty);
}

FIELDS.forEach((k) => {
  document.getElementById(k).addEventListener('input', updateDirty);
});

// ── Save / Revert ─────────────────────────────────────────────────────────────
document.getElementById('btn-save').addEventListener('click', async () => {
  const body = current();
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Save failed');
    const data = await res.json();
    initial = { ...data.settings };
    for (const k of FIELDS) {
      const el = document.getElementById(k);
      if (el) el.value = initial[k] || '';
    }
    updateDirty();
    toast('Settings saved', 'ok');
  } catch (err) {
    toast('Failed to save: ' + err.message, 'err');
  }
});

document.getElementById('btn-revert').addEventListener('click', () => {
  for (const k of FIELDS) document.getElementById(k).value = initial[k] || '';
  updateDirty();
});

// ── Show/hide password ────────────────────────────────────────────────────────
document.querySelectorAll('.show-pw').forEach((btn) => {
  btn.addEventListener('click', () => {
    const el = document.getElementById(btn.dataset.target);
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
  });
});

// ── Test connection ───────────────────────────────────────────────────────────
function setTestResult(id, ok, msg) {
  const el = document.getElementById(id);
  el.className = 'test-result ' + (ok ? 'ok' : 'err');
  el.textContent = msg;
}

document.getElementById('test-tmdb').addEventListener('click', async () => {
  const el = document.getElementById('test-tmdb-result');
  el.className = 'test-result';
  el.textContent = 'Testing…';
  try {
    const res = await fetch('/api/settings/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'tmdb', apiKey: document.getElementById('tmdb_api_key').value.trim() }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      setTestResult('test-tmdb-result', false, 'Failed: ' + (data.error || 'unknown'));
      return;
    }
    setTestResult('test-tmdb-result', true, 'Connected');
  } catch (err) {
    setTestResult('test-tmdb-result', false, 'Error: ' + err.message);
  }
});

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, kind = 'ok') {
  const el = document.getElementById('arr-toast');
  el.textContent = msg;
  el.className = 'show ' + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = ''), 2800);
}

// ── Warn on unsaved navigation ────────────────────────────────────────────────
window.addEventListener('beforeunload', (e) => {
  if (isDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ── Keyboard save (Cmd/Ctrl + S) ──────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    if (!document.getElementById('btn-save').disabled) document.getElementById('btn-save').click();
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────
load();
