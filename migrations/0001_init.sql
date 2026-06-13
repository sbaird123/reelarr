-- Reelarr accounts schema.
-- A user is one (provider, provider_id) pair — signing in with Google and
-- GitHub creates two separate accounts for now (link-by-email can come later).

CREATE TABLE users (
  id          INTEGER PRIMARY KEY,
  provider    TEXT NOT NULL,            -- 'google' | 'github'
  provider_id TEXT NOT NULL,            -- the provider's stable user id
  email       TEXT,
  name        TEXT,
  avatar      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_id)
);

-- Opaque session tokens, validated against this table on each authed request.
-- The token (id) lives in an HttpOnly cookie; it's high-entropy random, so the
-- D1 lookup is the source of truth — no separate cookie signing needed.
CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Per-user watched list (was a single global table in self-hosted Peekarr).
CREATE TABLE watched (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tmdb_id    INTEGER NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'movie',
  title      TEXT,
  watched_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, tmdb_id, media_type)
);

-- Named watchlists — the feature that replaces "+ Add to Radarr/Sonarr".
-- Tables exist now; the endpoints + UI land in the next step.
CREATE TABLE lists (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE list_items (
  list_id    INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  tmdb_id    INTEGER NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'movie',
  title      TEXT,
  added_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (list_id, tmdb_id, media_type)
);
