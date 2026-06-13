-- Trakt integration: per-user OAuth tokens + per-list two-way sync links.
-- Trakt is the ecosystem hub (Kometa/Plex/SIMKL read Trakt), so linking a
-- Reelarr list to a Trakt list/watchlist gives it reach far beyond Radarr/Sonarr.

-- One Trakt account per Reelarr user. Tokens refresh in the background (cron),
-- so both the access and refresh tokens plus the absolute expiry are stored.
CREATE TABLE trakt_accounts (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TEXT NOT NULL,           -- ISO; created_at + expires_in
  username      TEXT,                     -- Trakt username/slug, for display
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A Reelarr list linked to a Trakt target for two-way sync. trakt_list_id NULL
-- = the user's Trakt watchlist. `snapshot` is a JSON array of "tmdb:type" keys
-- present at the last successful sync — the engine diffs it against the current
-- Reelarr and Trakt item sets to tell additions from removals on each side.
CREATE TABLE trakt_list_links (
  list_id        INTEGER PRIMARY KEY REFERENCES lists(id) ON DELETE CASCADE,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trakt_list_id  TEXT,                    -- NULL = Trakt watchlist
  trakt_slug     TEXT,
  snapshot       TEXT NOT NULL DEFAULT '[]',
  last_synced_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Cron walks links by staleness; this also covers cleanup on account disconnect.
CREATE INDEX idx_trakt_links_user ON trakt_list_links(user_id);
