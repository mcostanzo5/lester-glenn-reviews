ALTER TABLE review_notes ADD COLUMN provided_by TEXT;
CREATE TABLE IF NOT EXISTS draft_feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL, rooftop_key TEXT, stars INTEGER, rating TEXT NOT NULL CHECK (rating IN ('up', 'down')), draft TEXT, note TEXT, lesson TEXT, created_by TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_feedback_rating ON draft_feedback(rating, stars);
