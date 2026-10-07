-- Reviews: one row per Google review. Reviewer names are never stored.
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,               -- Google review resource name
  location_name TEXT,
  rooftop_key TEXT NOT NULL,
  location_title TEXT,
  stars INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL DEFAULT '',
  create_time TEXT NOT NULL,
  update_time TEXT NOT NULL,
  status TEXT NOT NULL,
  department TEXT,
  sentiment TEXT,
  risk_level TEXT,
  risk_flags TEXT,
  route_reason TEXT,
  draft TEXT,
  reply_text TEXT,
  reply_time TEXT,
  reply_source TEXT,                 -- agent | manager | google
  decided_by TEXT,
  decided_at TEXT,
  is_sample INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT
);
CREATE INDEX idx_reviews_status ON reviews(status);
CREATE INDEX idx_reviews_rooftop_time ON reviews(rooftop_key, create_time);

-- Sync bookkeeping per Google location
CREATE TABLE locations (
  name TEXT PRIMARY KEY,
  account_name TEXT NOT NULL,
  title TEXT,
  rooftop_key TEXT,
  newest_seen TEXT,
  backfill_token TEXT,
  backfill_done INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

-- Dashboard access. rooftops is '*' or a comma list of rooftop keys.
CREATE TABLE users (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'viewer')),
  rooftops TEXT NOT NULL DEFAULT '*',
  added_by TEXT,
  added_at TEXT
);

-- Audit trail of every action on a review
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT,
  actor TEXT,
  action TEXT,
  detail TEXT,
  at TEXT
);
CREATE INDEX idx_events_review ON events(review_id);

-- One row per agent run
CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT,
  finished_at TEXT,
  mode TEXT,
  trigger TEXT,
  synced INTEGER DEFAULT 0,
  drafted INTEGER DEFAULT 0,
  posted INTEGER DEFAULT 0,
  flagged INTEGER DEFAULT 0,
  errors INTEGER DEFAULT 0,
  notes TEXT
);
