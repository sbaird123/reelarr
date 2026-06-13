-- Phase 3: friends. A friendship is a single directional row (requester →
-- addressee) with a status; "are A and B friends?" = an accepted row in either
-- direction. Friends-gating for shared lists (Phase 4) builds on this.
CREATE TABLE friendships (
  requester_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (requester_id, addressee_id)
);
-- Fast "incoming requests / who are my friends" lookups from the addressee side
-- (the requester side is covered by the primary key's leading column).
CREATE INDEX idx_friendships_addressee ON friendships(addressee_id, status);
