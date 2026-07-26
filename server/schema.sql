PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'official',
  authority_level TEXT NOT NULL DEFAULT 'central',
  official_url TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS policy_families (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  family_id INTEGER REFERENCES policy_families(id),
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  issuer TEXT NOT NULL,
  document_number TEXT NOT NULL DEFAULT '',
  document_date TEXT,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'effective', 'superseded', 'expired')),
  importance INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  original_url TEXT NOT NULL UNIQUE,
  cover_image TEXT NOT NULL DEFAULT '',
  published_at TEXT NOT NULL,
  effective_at TEXT,
  content_text TEXT NOT NULL,
  original_excerpt TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_documents_published ON documents(published_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_documents_category_status ON documents(category, status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_family ON documents(family_id, published_at DESC);

CREATE TABLE IF NOT EXISTS site_daily_visitors (
  visitor_hash TEXT NOT NULL CHECK (length(visitor_hash) = 64),
  view_date TEXT NOT NULL CHECK (length(view_date) = 10),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (visitor_hash, view_date)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_site_daily_visitors_date
ON site_daily_visitors(view_date);

CREATE TABLE IF NOT EXISTS article_daily_visitors (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  visitor_hash TEXT NOT NULL CHECK (length(visitor_hash) = 64),
  view_date TEXT NOT NULL CHECK (length(view_date) = 10),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (document_id, visitor_hash, view_date)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_article_daily_visitors_document_date
ON article_daily_visitors(document_id, view_date);

CREATE TABLE IF NOT EXISTS policy_signals (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  value_text TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL DEFAULT '',
  evidence_quote TEXT NOT NULL,
  source_url TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_signals_document ON policy_signals(document_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS analysis_versions (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  previous_version_id INTEGER REFERENCES analysis_versions(id),
  headline TEXT NOT NULL,
  interpretation TEXT NOT NULL,
  impact TEXT NOT NULL,
  recommendations TEXT NOT NULL,
  methodology TEXT NOT NULL DEFAULT '',
  evidence_summary TEXT NOT NULL DEFAULT '',
  model_name TEXT NOT NULL DEFAULT '',
  prompt_version TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'superseded')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(document_id, version)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_analysis_document ON analysis_versions(document_id, version DESC);

CREATE TRIGGER IF NOT EXISTS analysis_versions_immutable_update
BEFORE UPDATE ON analysis_versions
BEGIN
  SELECT RAISE(ABORT, 'analysis versions are immutable; insert a new version');
END;

CREATE TRIGGER IF NOT EXISTS analysis_versions_immutable_delete
BEFORE DELETE ON analysis_versions
BEGIN
  SELECT RAISE(ABORT, 'analysis versions are immutable; deletion is not allowed');
END;

CREATE TABLE IF NOT EXISTS forecasts (
  id INTEGER PRIMARY KEY,
  analysis_version_id INTEGER NOT NULL REFERENCES analysis_versions(id),
  statement TEXT NOT NULL,
  basis TEXT NOT NULL,
  expected_by TEXT,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'monitoring', 'partially_verified', 'verified', 'disproved', 'expired')),
  verification_note TEXT NOT NULL DEFAULT '',
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_forecasts_analysis ON forecasts(analysis_version_id, id);
CREATE INDEX IF NOT EXISTS idx_forecasts_status ON forecasts(status, expected_by);

CREATE TABLE IF NOT EXISTS implementation_events (
  id INTEGER PRIMARY KEY,
  family_id INTEGER REFERENCES policy_families(id),
  document_id INTEGER REFERENCES documents(id),
  title TEXT NOT NULL,
  event_type TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_quote TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'observed' CHECK (status IN ('announced', 'observed', 'confirmed', 'reversed')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (family_id IS NOT NULL OR document_id IS NOT NULL)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_events_family_date ON implementation_events(family_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_document_date ON implementation_events(document_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS ambiguities (
  id INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  analysis_version_id INTEGER REFERENCES analysis_versions(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'watching', 'clarified', 'disputed')),
  resolution_note TEXT NOT NULL DEFAULT '',
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ambiguities_document ON ambiguities(document_id, status, detected_at DESC);

CREATE TABLE IF NOT EXISTS assessment_snapshots (
  id INTEGER PRIMARY KEY,
  family_id INTEGER NOT NULL REFERENCES policy_families(id),
  as_of_date TEXT NOT NULL,
  summary TEXT NOT NULL,
  score REAL CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
  conclusion TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(family_id, as_of_date)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_assessments_family ON assessment_snapshots(family_id, as_of_date DESC);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  expiration_time INTEGER,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  sources_checked INTEGER NOT NULL DEFAULT 0 CHECK (sources_checked >= 0),
  documents_found INTEGER NOT NULL DEFAULT 0 CHECK (documents_found >= 0),
  documents_added INTEGER NOT NULL DEFAULT 0 CHECK (documents_added >= 0),
  message TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

INSERT INTO schema_meta(key, value) VALUES ('schema_version', '2')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
