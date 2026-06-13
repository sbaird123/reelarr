-- Phase 2: *arr sync. A list can expose a tokenised, read-only import URL that
-- Radarr (StevenLu format, keyed on imdb_id) and Sonarr (Custom List format,
-- keyed on tvdbId) pull on their own schedule. The token IS the capability —
-- anyone with the URL can read the list, so it's high-entropy and revocable
-- (set back to NULL). NULL = sharing off; SQLite allows many NULLs under a
-- UNIQUE index, so only real tokens are constrained unique.
ALTER TABLE lists ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX idx_lists_share_token ON lists(share_token);
