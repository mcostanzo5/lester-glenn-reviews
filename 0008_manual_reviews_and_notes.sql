ALTER TABLE reviews ADD COLUMN source TEXT;
ALTER TABLE reviews ADD COLUMN source_url TEXT;
CREATE TABLE IF NOT EXISTS review_notes (id INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL, author TEXT NOT NULL, author_name TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_notes_review ON review_notes(review_id);
