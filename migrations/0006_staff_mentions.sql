CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY AUTOINCREMENT, rooftop_key TEXT NOT NULL, full_name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('sales', 'service', 'other')), aliases TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1, created_at TEXT);
CREATE TABLE IF NOT EXISTS mentions (id INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL, rooftop_key TEXT NOT NULL, review_time TEXT NOT NULL, stars INTEGER, name_raw TEXT NOT NULL, role_hint TEXT, sentiment TEXT, staff_id INTEGER, match TEXT NOT NULL CHECK (match IN ('auto', 'manual', 'ambiguous', 'unmatched', 'ignored')), tagged_by TEXT, tagged_at TEXT);
CREATE INDEX IF NOT EXISTS idx_mentions_time ON mentions(review_time);
CREATE INDEX IF NOT EXISTS idx_mentions_staff ON mentions(staff_id);
CREATE INDEX IF NOT EXISTS idx_mentions_review ON mentions(review_id);
CREATE INDEX IF NOT EXISTS idx_staff_rooftop ON staff(rooftop_key);
ALTER TABLE reviews ADD COLUMN mentions_scanned_at TEXT;
