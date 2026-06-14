-- Inviting an email that has no Reelarr account yet: remember the pending invite
-- so it converts into a friend request the moment that person signs up (matched
-- by email). NOCASE so Bob@x and bob@x are the same invite target.
CREATE TABLE friend_invites (
  email      TEXT NOT NULL COLLATE NOCASE,
  inviter_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (email, inviter_id)
);
