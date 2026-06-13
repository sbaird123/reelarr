-- Phase 4: shared lists. An owner shares a list with a confirmed friend, who
-- becomes a collaborator with a role: 'viewer' (read-only) or 'editor' (can add/
-- remove items). The owner (lists.user_id) always has full control; only the
-- owner can rename/delete the list, manage *arr sharing, and manage collaborators.
CREATE TABLE list_collaborators (
  list_id    INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'viewer',  -- viewer | editor
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (list_id, user_id)
);
-- "lists shared with me" lookups from the collaborator side.
CREATE INDEX idx_list_collaborators_user ON list_collaborators(user_id);
