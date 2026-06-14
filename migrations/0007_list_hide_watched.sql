-- Per-list toggle: when on (default, matching prior behavior), titles you've
-- marked Watched are hidden from this list's feed — suits a "to-watch" list.
-- Off shows everything, e.g. a "favourites" list you rewatch.
ALTER TABLE lists ADD COLUMN hide_watched INTEGER NOT NULL DEFAULT 1;
