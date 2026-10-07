ALTER TABLE reviews ADD COLUMN escalation_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN escalation_open INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reviews ADD COLUMN escalation_first_at TEXT;
ALTER TABLE reviews ADD COLUMN escalation_last_at TEXT;
ALTER TABLE reviews ADD COLUMN escalation_resolved_at TEXT;
CREATE TABLE IF NOT EXISTS team_lists (rooftop_key TEXT NOT NULL, team TEXT NOT NULL CHECK (team IN ('sales', 'service', 'store')), emails TEXT NOT NULL DEFAULT '', updated_by TEXT, updated_at TEXT, PRIMARY KEY (rooftop_key, team));
CREATE TABLE IF NOT EXISTS escalations (id INTEGER PRIMARY KEY AUTOINCREMENT, review_id TEXT NOT NULL, concern TEXT NOT NULL, recipients TEXT NOT NULL, included_customer INTEGER NOT NULL DEFAULT 0, followup_number INTEGER NOT NULL DEFAULT 0, sent_by TEXT NOT NULL, sent_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_escalations_review ON escalations(review_id);
