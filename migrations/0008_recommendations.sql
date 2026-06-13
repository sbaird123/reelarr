-- Friend-to-friend recommendations: "Alice recommended The Matrix to you."
-- Surfaced via a notifications bell (badge = unseen count). Friends-gated.
CREATE TABLE recommendations (
  id           INTEGER PRIMARY KEY,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tmdb_id      INTEGER NOT NULL,
  media_type   TEXT NOT NULL DEFAULT 'movie',
  title        TEXT,
  note         TEXT,
  seen         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_recs_to ON recommendations(to_user_id, seen);
