-- A list is for movies, TV, or both. Controls which screen(s) it appears on as a
-- browsable feed, and which import URLs (Radarr/Sonarr) the Manage view shows.
ALTER TABLE lists ADD COLUMN kind TEXT NOT NULL DEFAULT 'both'; -- movie | tv | both
