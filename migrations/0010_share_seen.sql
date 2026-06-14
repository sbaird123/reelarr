-- Surface "X shared a list with you" in the notifications bell. A collaborator
-- row is "unseen" until the recipient opens the notifications panel. New shares
-- default to unseen (0); mark all existing shares seen so they don't retroactively
-- alert people about lists they already know about.
ALTER TABLE list_collaborators ADD COLUMN seen INTEGER NOT NULL DEFAULT 0;
UPDATE list_collaborators SET seen = 1;
