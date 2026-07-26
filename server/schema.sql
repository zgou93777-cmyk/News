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

CREATE TABLE IF NOT EXISTS historical_backfill_items (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES historical_backfill_items(id),
  source_url TEXT NOT NULL UNIQUE,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'html' CHECK (source_type IN ('html', 'pdf', 'json', 'unknown')),
  item_kind TEXT NOT NULL DEFAULT 'document' CHECK (item_kind IN ('index', 'issue', 'document')),
  source_year INTEGER CHECK (source_year IS NULL OR source_year BETWEEN 1949 AND 3000),
  issue_label TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  issuer TEXT NOT NULL DEFAULT '',
  document_number TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  effective_at TEXT,
  repealed_at TEXT,
  content_text TEXT NOT NULL DEFAULT '',
  checksum TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT 'discovered' CHECK (stage IN (
    'discovered', 'indexed', 'needs_review', 'source_verified',
    'lifecycle_verified', 'ready', 'published', 'manual_review', 'failed'
  )),
  source_status TEXT NOT NULL DEFAULT 'pending' CHECK (source_status IN ('pending', 'verified', 'rejected')),
  metadata_status TEXT NOT NULL DEFAULT 'pending' CHECK (metadata_status IN ('pending', 'verified', 'rejected')),
  lifecycle_status TEXT NOT NULL DEFAULT 'pending' CHECK (lifecycle_status IN ('pending', 'verified', 'not_applicable', 'rejected')),
  implementation_status TEXT NOT NULL DEFAULT 'pending' CHECK (implementation_status IN ('pending', 'verified', 'not_found', 'not_applicable', 'rejected')),
  outcome_status TEXT NOT NULL DEFAULT 'pending' CHECK (outcome_status IN ('pending', 'verified', 'not_found', 'not_applicable', 'rejected')),
  analysis_status TEXT NOT NULL DEFAULT 'pending' CHECK (analysis_status IN ('pending', 'verified', 'rejected')),
  evidence_urls_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_urls_json)),
  policy_cycle_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(policy_cycle_json)),
  implementation_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(implementation_json)),
  outcome_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(outcome_json)),
  analysis_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(analysis_json)),
  review_notes TEXT NOT NULL DEFAULT '',
  reviewed_by TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  document_id INTEGER UNIQUE REFERENCES documents(id),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT NOT NULL DEFAULT '',
  next_attempt_at TEXT,
  fetched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX IF NOT EXISTS idx_historical_backfill_queue
ON historical_backfill_items(stage, next_attempt_at, source_year, id);

CREATE INDEX IF NOT EXISTS idx_historical_backfill_parent
ON historical_backfill_items(parent_id, item_kind, id);

CREATE TABLE IF NOT EXISTS historical_source_scans (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  from_year INTEGER NOT NULL CHECK (from_year BETWEEN 1949 AND 3000),
  to_year INTEGER NOT NULL CHECK (to_year BETWEEN from_year AND 3000),
  available_items INTEGER NOT NULL DEFAULT 0 CHECK (available_items >= 0),
  remaining_items INTEGER NOT NULL DEFAULT 0 CHECK (remaining_items >= 0),
  complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
  scanned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(source_id, from_year, to_year)
) STRICT;

CREATE TABLE IF NOT EXISTS historical_artifacts (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES historical_backfill_items(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN (
    'source_pdf', 'embedded_text', 'ocr_page', 'ocr_text', 'segmentation'
  )),
  storage_path TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK (length(checksum) = 64),
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  page_start INTEGER NOT NULL DEFAULT 0 CHECK (page_start >= 0),
  page_end INTEGER NOT NULL DEFAULT 0 CHECK (page_end >= page_start),
  engine TEXT NOT NULL DEFAULT '',
  engine_version TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(item_id, artifact_type, page_start, checksum)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_historical_artifacts_item
ON historical_artifacts(item_id, artifact_type, page_start);

CREATE TABLE IF NOT EXISTS historical_segmentation_submissions (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES historical_backfill_items(id) ON DELETE RESTRICT,
  source_pdf_checksum TEXT NOT NULL CHECK (length(source_pdf_checksum) = 64),
  extraction_checksum TEXT NOT NULL CHECK (length(extraction_checksum) = 64),
  submission_checksum TEXT NOT NULL CHECK (length(submission_checksum) = 64),
  segments_json TEXT NOT NULL CHECK (
    json_valid(segments_json) AND json_type(segments_json) = 'object'
    AND json_array_length(segments_json, '$.segments') > 0
  ),
  reviewed_by TEXT NOT NULL CHECK (trim(reviewed_by) <> ''),
  reviewed_at TEXT NOT NULL CHECK (trim(reviewed_at) <> ''),
  review_notes TEXT NOT NULL CHECK (trim(review_notes) <> ''),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(item_id, submission_checksum)
) STRICT;

CREATE TABLE IF NOT EXISTS historical_segmentation_submission_items (
  submission_id INTEGER NOT NULL REFERENCES historical_segmentation_submissions(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  item_id INTEGER NOT NULL UNIQUE REFERENCES historical_backfill_items(id) ON DELETE RESTRICT,
  page_start INTEGER NOT NULL CHECK (page_start > 0),
  page_end INTEGER NOT NULL CHECK (page_end >= page_start),
  content_checksum TEXT NOT NULL CHECK (length(content_checksum) = 64),
  PRIMARY KEY(submission_id, ordinal)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_historical_segmentation_submission_items_parent
ON historical_segmentation_submission_items(submission_id, item_id);

-- Recreate the submission guard so schema upgrades enforce explicit reviewer kind.
DROP TRIGGER IF EXISTS historical_segmentation_submissions_insert_guard;

CREATE TRIGGER IF NOT EXISTS historical_segmentation_submissions_insert_guard
BEFORE INSERT ON historical_segmentation_submissions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM historical_backfill_items item
    JOIN historical_artifacts artifact ON artifact.item_id = item.id
      AND artifact.artifact_type = 'source_pdf'
      AND artifact.checksum = NEW.source_pdf_checksum
    WHERE item.id = NEW.item_id AND item.item_kind = 'issue' AND item.source_type = 'pdf'
  ) OR NOT EXISTS (
    SELECT 1 FROM historical_artifacts artifact
    WHERE artifact.item_id = NEW.item_id
      AND artifact.artifact_type IN ('ocr_text', 'embedded_text')
      AND artifact.checksum = NEW.extraction_checksum
      AND artifact.page_start = 1 AND artifact.page_end >= 1
      AND artifact.page_end = CAST(json_extract(NEW.segments_json, '$.pageCount') AS INTEGER)
  ) OR coalesce(CAST(json_extract(NEW.segments_json, '$.issueId') AS INTEGER), 0) <> NEW.item_id
    OR coalesce(json_extract(NEW.segments_json, '$.sourcePdfChecksum'), '') <> NEW.source_pdf_checksum
    OR coalesce(json_extract(NEW.segments_json, '$.extractionChecksum'), '') <> NEW.extraction_checksum
    OR coalesce(json_extract(NEW.segments_json, '$.reviewedBy'), '') <> NEW.reviewed_by
    OR coalesce(json_extract(NEW.segments_json, '$.reviewedAt'), '') <> NEW.reviewed_at
    OR coalesce(json_extract(NEW.segments_json, '$.reviewNotes'), '') <> NEW.review_notes
    OR coalesce(json_extract(NEW.segments_json, '$.reviewKind'), '') NOT IN ('ai_assisted', 'human_verified')
  THEN RAISE(ABORT, 'historical segmentation submission does not match its source issue') END;
END;

CREATE TRIGGER IF NOT EXISTS historical_segmentation_submissions_immutable_update
BEFORE UPDATE ON historical_segmentation_submissions
BEGIN
  SELECT RAISE(ABORT, 'historical segmentation submissions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS historical_segmentation_submissions_immutable_delete
BEFORE DELETE ON historical_segmentation_submissions
BEGIN
  SELECT RAISE(ABORT, 'historical segmentation submissions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS historical_segmentation_submission_items_insert_guard
BEFORE INSERT ON historical_segmentation_submission_items
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM historical_segmentation_submissions submission
    JOIN historical_backfill_items child ON child.id = NEW.item_id
    WHERE submission.id = NEW.submission_id
      AND child.parent_id = submission.item_id
      AND child.item_kind = 'document' AND child.source_type = 'pdf'
      AND child.checksum = NEW.content_checksum
      AND child.title = json_extract(
        submission.segments_json, '$.segments[' || (NEW.ordinal - 1) || '].title'
      )
      AND CAST(json_extract(
        submission.segments_json, '$.segments[' || (NEW.ordinal - 1) || '].pageStart'
      ) AS INTEGER) = NEW.page_start
      AND CAST(json_extract(
        submission.segments_json, '$.segments[' || (NEW.ordinal - 1) || '].pageEnd'
      ) AS INTEGER) = NEW.page_end
      AND json_extract(
        submission.segments_json, '$.segments[' || (NEW.ordinal - 1) || '].contentChecksum'
      ) = NEW.content_checksum
  ) THEN RAISE(ABORT, 'historical segmentation item does not match its submission') END;
END;

CREATE TRIGGER IF NOT EXISTS historical_segmentation_submission_items_immutable_update
BEFORE UPDATE ON historical_segmentation_submission_items
BEGIN
  SELECT RAISE(ABORT, 'historical segmentation submission items are immutable');
END;

CREATE TRIGGER IF NOT EXISTS historical_segmentation_submission_items_immutable_delete
BEFORE DELETE ON historical_segmentation_submission_items
BEGIN
  SELECT RAISE(ABORT, 'historical segmentation submission items are immutable');
END;

CREATE TRIGGER IF NOT EXISTS historical_segmentation_artifacts_immutable_update
BEFORE UPDATE ON historical_artifacts
WHEN EXISTS (
  SELECT 1 FROM historical_segmentation_submissions submission
  WHERE submission.item_id = OLD.item_id
    AND OLD.checksum IN (submission.source_pdf_checksum, submission.extraction_checksum)
)
BEGIN
  SELECT RAISE(ABORT, 'artifacts used by historical segmentation submissions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS historical_segmentation_artifacts_immutable_delete
BEFORE DELETE ON historical_artifacts
WHEN EXISTS (
  SELECT 1 FROM historical_segmentation_submissions submission
  WHERE submission.item_id = OLD.item_id
    AND OLD.checksum IN (submission.source_pdf_checksum, submission.extraction_checksum)
)
BEGIN
  SELECT RAISE(ABORT, 'artifacts used by historical segmentation submissions are immutable');
END;

CREATE TABLE IF NOT EXISTS historical_verification_evidence (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES historical_backfill_items(id) ON DELETE CASCADE,
  source_item_id INTEGER REFERENCES historical_backfill_items(id) ON DELETE SET NULL,
  claim_type TEXT NOT NULL CHECK (claim_type IN (
    'source', 'title', 'issuer', 'document_number', 'published_at',
    'effective_at', 'repealed_at', 'supersedes', 'repeals'
  )),
  status TEXT NOT NULL CHECK (status IN ('verified', 'not_found', 'pending', 'rejected')),
  value_text TEXT NOT NULL DEFAULT '',
  evidence_quote TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL DEFAULT '',
  search_scope TEXT NOT NULL DEFAULT '',
  extractor TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  observed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (status = 'verified' AND trim(value_text) <> '' AND trim(evidence_quote) <> '' AND trim(source_url) <> '')
    OR (status = 'not_found' AND trim(search_scope) <> '')
    OR status IN ('pending', 'rejected')
  ),
  UNIQUE(item_id, claim_type, status, value_text, source_url, evidence_quote)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_historical_verification_item
ON historical_verification_evidence(item_id, claim_type, status);

CREATE TABLE IF NOT EXISTS historical_policy_relations (
  id INTEGER PRIMARY KEY,
  predecessor_item_id INTEGER NOT NULL REFERENCES historical_backfill_items(id) ON DELETE CASCADE,
  successor_item_id INTEGER NOT NULL REFERENCES historical_backfill_items(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('repeals', 'supersedes', 'amends')),
  evidence_id INTEGER NOT NULL REFERENCES historical_verification_evidence(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'verified' CHECK (status IN ('candidate', 'verified', 'rejected')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (predecessor_item_id <> successor_item_id),
  UNIQUE(predecessor_item_id, successor_item_id, relation_type)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_historical_relations_predecessor
ON historical_policy_relations(predecessor_item_id, relation_type, status);

CREATE TABLE IF NOT EXISTS historical_policy_evidence (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES historical_backfill_items(id) ON DELETE CASCADE,
  source_item_id INTEGER NOT NULL REFERENCES historical_backfill_items(id) ON DELETE CASCADE,
  evidence_type TEXT NOT NULL CHECK (evidence_type IN (
    'implementation', 'funding', 'outcome', 'meeting_signal', 'policy_release'
  )),
  classification TEXT NOT NULL CHECK (classification IN ('accepted', 'excluded')),
  title TEXT NOT NULL,
  source_url TEXT NOT NULL,
  evidence_quote TEXT NOT NULL,
  observed_at TEXT,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(details_json)),
  extractor TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (trim(title) <> '' AND trim(source_url) <> '' AND trim(evidence_quote) <> '' AND trim(extractor) <> ''),
  CHECK (item_id <> source_item_id),
  UNIQUE(item_id, source_item_id, evidence_type, evidence_quote)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_historical_policy_evidence_item
ON historical_policy_evidence(item_id, classification, evidence_type, observed_at);

CREATE TABLE IF NOT EXISTS historical_evidence_searches (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES historical_backfill_items(id) ON DELETE CASCADE,
  evidence_scope TEXT NOT NULL CHECK (evidence_scope IN ('implementation', 'outcome')),
  status TEXT NOT NULL CHECK (status IN ('incomplete', 'complete')),
  corpus_watermark INTEGER NOT NULL DEFAULT 0 CHECK (corpus_watermark >= 0),
  candidates_checked INTEGER NOT NULL DEFAULT 0 CHECK (candidates_checked >= 0),
  accepted_matches INTEGER NOT NULL DEFAULT 0 CHECK (accepted_matches >= 0),
  search_scope TEXT NOT NULL,
  searched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(item_id, evidence_scope)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_historical_evidence_search_status
ON historical_evidence_searches(status, evidence_scope, searched_at);

CREATE TABLE IF NOT EXISTS historical_analysis_versions (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES historical_backfill_items(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  input_checksum TEXT NOT NULL CHECK (length(input_checksum) = 64),
  review_status TEXT NOT NULL CHECK (review_status IN ('verified', 'partial', 'ambiguous', 'watching')),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  release_eligible INTEGER NOT NULL DEFAULT 0 CHECK (release_eligible IN (0, 1)),
  gates_json TEXT NOT NULL CHECK (json_valid(gates_json) AND json_type(gates_json) = 'array'),
  analysis_json TEXT NOT NULL CHECK (json_valid(analysis_json) AND json_type(analysis_json) = 'object'),
  methodology TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (trim(methodology) <> ''),
  UNIQUE(item_id, version),
  UNIQUE(item_id, input_checksum)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_historical_analysis_release
ON historical_analysis_versions(release_eligible, review_status, item_id, version DESC);

CREATE TRIGGER IF NOT EXISTS historical_analysis_versions_immutable_update
BEFORE UPDATE ON historical_analysis_versions
BEGIN
  SELECT RAISE(ABORT, 'historical analysis versions are immutable; insert a new version');
END;

CREATE TRIGGER IF NOT EXISTS historical_analysis_versions_immutable_delete
BEFORE DELETE ON historical_analysis_versions
BEGIN
  SELECT RAISE(ABORT, 'historical analysis versions are immutable; deletion is not allowed');
END;

CREATE TABLE IF NOT EXISTS historical_review_submissions (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES historical_backfill_items(id) ON DELETE RESTRICT,
  assessment_version_id INTEGER NOT NULL UNIQUE REFERENCES historical_analysis_versions(id) ON DELETE RESTRICT,
  source_checksum TEXT NOT NULL CHECK (length(source_checksum) = 64),
  review_checksum TEXT NOT NULL CHECK (length(review_checksum) = 64),
  review_json TEXT NOT NULL CHECK (json_valid(review_json) AND json_type(review_json) = 'object'),
  reviewed_by TEXT NOT NULL CHECK (trim(reviewed_by) <> ''),
  reviewed_at TEXT NOT NULL CHECK (trim(reviewed_at) <> ''),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(item_id, review_checksum)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_historical_review_submissions_item
ON historical_review_submissions(item_id, assessment_version_id);

CREATE TRIGGER IF NOT EXISTS historical_review_submissions_insert_guard
BEFORE INSERT ON historical_review_submissions
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM historical_analysis_versions assessment
    WHERE assessment.id = NEW.assessment_version_id
      AND assessment.item_id = NEW.item_id
      AND assessment.methodology = 'human-review-v1'
      AND assessment.input_checksum = NEW.review_checksum
  ) OR coalesce(json_extract(NEW.review_json, '$.reviewedBy'), '') <> NEW.reviewed_by
    OR coalesce(json_extract(NEW.review_json, '$.reviewedAt'), '') <> NEW.reviewed_at
  THEN RAISE(ABORT, 'historical review submission does not match its assessment') END;
END;

CREATE TRIGGER IF NOT EXISTS historical_review_submissions_immutable_update
BEFORE UPDATE ON historical_review_submissions
BEGIN
  SELECT RAISE(ABORT, 'historical review submissions are immutable');
END;

CREATE TRIGGER IF NOT EXISTS historical_review_submissions_immutable_delete
BEFORE DELETE ON historical_review_submissions
BEGIN
  SELECT RAISE(ABORT, 'historical review submissions are immutable');
END;

CREATE TABLE IF NOT EXISTS historical_release_cohorts (
  id INTEGER PRIMARY KEY,
  target_size INTEGER NOT NULL DEFAULT 100 CHECK (target_size BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'validated' CHECK (status IN ('validated', 'approved', 'observing', 'rejected')),
  manifest_checksum TEXT NOT NULL CHECK (length(manifest_checksum) = 64),
  regression_json TEXT NOT NULL CHECK (json_valid(regression_json) AND json_type(regression_json) = 'object'),
  approved_by TEXT NOT NULL DEFAULT '',
  approval_note TEXT NOT NULL DEFAULT '',
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE IF NOT EXISTS historical_release_cohort_items (
  cohort_id INTEGER NOT NULL REFERENCES historical_release_cohorts(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  item_id INTEGER NOT NULL REFERENCES historical_backfill_items(id) ON DELETE RESTRICT,
  assessment_version_id INTEGER NOT NULL REFERENCES historical_analysis_versions(id) ON DELETE RESTRICT,
  input_checksum TEXT NOT NULL CHECK (length(input_checksum) = 64),
  regression_json TEXT NOT NULL CHECK (json_valid(regression_json) AND json_type(regression_json) = 'object'),
  PRIMARY KEY (cohort_id, ordinal),
  UNIQUE (cohort_id, item_id),
  UNIQUE (item_id, assessment_version_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_historical_cohort_items_item
ON historical_release_cohort_items(item_id, cohort_id);

CREATE TABLE IF NOT EXISTS historical_release_control (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'disabled' CHECK (mode IN ('disabled', 'cohort', 'full')),
  active_cohort_id INTEGER REFERENCES historical_release_cohorts(id) ON DELETE RESTRICT,
  changed_by TEXT NOT NULL DEFAULT 'schema-default',
  change_note TEXT NOT NULL DEFAULT 'historical release remains disabled until cohort approval',
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO historical_release_control(id, mode) VALUES (1, 'disabled')
ON CONFLICT(id) DO NOTHING;

CREATE TRIGGER IF NOT EXISTS historical_release_cohorts_insert_guard
BEFORE INSERT ON historical_release_cohorts
WHEN NEW.status <> 'validated' OR trim(NEW.approved_by) <> ''
  OR trim(NEW.approval_note) <> '' OR NEW.approved_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'historical release cohorts must start validated and unapproved');
END;

CREATE TRIGGER IF NOT EXISTS historical_release_cohort_items_immutable_update
BEFORE UPDATE ON historical_release_cohort_items
BEGIN
  SELECT RAISE(ABORT, 'historical release cohort items are immutable');
END;

CREATE TRIGGER IF NOT EXISTS historical_release_cohort_items_immutable_delete
BEFORE DELETE ON historical_release_cohort_items
BEGIN
  SELECT RAISE(ABORT, 'historical release cohort items cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS historical_release_cohorts_update_guard
BEFORE UPDATE ON historical_release_cohorts
WHEN NEW.target_size <> OLD.target_size
  OR NEW.manifest_checksum <> OLD.manifest_checksum
  OR NEW.regression_json <> OLD.regression_json
  OR NEW.created_at <> OLD.created_at
  OR NOT (
    (OLD.status = 'validated' AND NEW.status IN ('approved', 'rejected'))
    OR (OLD.status = 'approved' AND NEW.status = 'observing')
  )
  OR (NEW.status = 'approved' AND (
    json_extract(NEW.regression_json, '$.passed') IS NOT 1
    OR (SELECT count(*) FROM historical_release_cohort_items item WHERE item.cohort_id = NEW.id) <> NEW.target_size
    OR EXISTS (
      SELECT 1 FROM historical_release_cohort_items item
      WHERE item.cohort_id = NEW.id
        AND json_extract(item.regression_json, '$.passed') IS NOT 1
    )
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid historical release cohort transition');
END;

CREATE TRIGGER IF NOT EXISTS historical_release_cohorts_delete_guard
BEFORE DELETE ON historical_release_cohorts
BEGIN
  SELECT RAISE(ABORT, 'historical release cohorts cannot be deleted');
END;

CREATE TRIGGER IF NOT EXISTS historical_release_control_update_guard
BEFORE UPDATE ON historical_release_control
BEGIN
  SELECT CASE WHEN
    NEW.id <> 1
    OR (NEW.mode = 'cohort' AND NOT EXISTS (
      SELECT 1 FROM historical_release_cohorts cohort
      WHERE cohort.id = NEW.active_cohort_id AND cohort.status = 'approved'
        AND trim(cohort.approved_by) <> '' AND trim(cohort.approval_note) <> ''
        AND cohort.approved_at IS NOT NULL
        AND (SELECT count(*) FROM historical_release_cohort_items item WHERE item.cohort_id = cohort.id) = cohort.target_size
    ))
    OR (NEW.mode = 'full' AND NOT EXISTS (
      SELECT 1 FROM historical_release_cohorts cohort
      WHERE cohort.id = NEW.active_cohort_id AND cohort.status = 'observing'
        AND (SELECT count(*) FROM historical_release_cohort_items item WHERE item.cohort_id = cohort.id) = cohort.target_size
        AND (SELECT count(*) FROM historical_release_cohort_items item
          JOIN historical_public_releases release
            ON release.item_id = item.item_id AND release.assessment_version_id = item.assessment_version_id
          WHERE item.cohort_id = cohort.id) = cohort.target_size
    ))
    OR (OLD.mode = 'full' AND NEW.mode <> 'full')
  THEN RAISE(ABORT, 'invalid historical release control transition') END;
END;

CREATE TRIGGER IF NOT EXISTS historical_release_control_delete_guard
BEFORE DELETE ON historical_release_control
BEGIN
  SELECT RAISE(ABORT, 'historical release control cannot be deleted');
END;

CREATE TABLE IF NOT EXISTS historical_public_releases (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES historical_backfill_items(id) ON DELETE RESTRICT,
  assessment_version_id INTEGER NOT NULL REFERENCES historical_analysis_versions(id) ON DELETE RESTRICT,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  analysis_version_id INTEGER NOT NULL REFERENCES analysis_versions(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('inserted', 'linked_existing')),
  released_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(item_id, assessment_version_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_historical_public_releases_document
ON historical_public_releases(document_id, id DESC);

-- Recreate the release guard on every migration so existing databases receive
-- the current confidence, citation, and immutable-assessment checks.
DROP TRIGGER IF EXISTS historical_public_release_insert_guard;

CREATE TRIGGER IF NOT EXISTS historical_public_release_insert_guard
BEFORE INSERT ON historical_public_releases
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM historical_backfill_items item
    JOIN historical_analysis_versions assessment
      ON assessment.id = NEW.assessment_version_id AND assessment.item_id = item.id
    JOIN documents document ON document.id = NEW.document_id
    JOIN analysis_versions analysis ON analysis.id = NEW.analysis_version_id
      AND analysis.document_id = document.id AND analysis.status = 'published'
    JOIN historical_release_control control ON control.id = 1
    WHERE item.id = NEW.item_id
      AND item.stage = 'ready' AND item.analysis_status = 'verified'
      AND (item.source_url LIKE 'https://gov.cn/%' OR item.source_url GLOB 'https://*.gov.cn/*')
      AND assessment.release_eligible = 1 AND assessment.confidence >= 0.95
      AND assessment.methodology IN ('historical-evidence-gates-v2', 'human-review-v1')
      AND (
        item.source_type <> 'pdf'
        OR EXISTS (
          SELECT 1
          FROM historical_segmentation_submission_items segment_item
          JOIN historical_segmentation_submissions segmentation
            ON segmentation.id = segment_item.submission_id
          WHERE segment_item.item_id = item.id
            AND segment_item.content_checksum = item.checksum
            AND segmentation.item_id = item.parent_id
            AND json_extract(segmentation.segments_json, '$.reviewKind') = 'human_verified'
        )
      )
      AND (
        assessment.methodology <> 'human-review-v1'
        OR EXISTS (
          SELECT 1 FROM historical_review_submissions submission
          WHERE submission.item_id = item.id
            AND submission.assessment_version_id = assessment.id
            AND submission.source_checksum = item.checksum
            AND submission.review_checksum = assessment.input_checksum
            AND submission.reviewed_by = item.reviewed_by
            AND submission.reviewed_at = item.reviewed_at
        )
      )
      AND json_array_length(assessment.gates_json) > 0
      AND NOT EXISTS (
        SELECT 1 FROM json_each(assessment.gates_json) gate
        WHERE json_extract(gate.value, '$.passed') IS NOT 1
      )
      AND CAST(json_extract(item.analysis_json, '$.assessmentVersionId') AS INTEGER) = assessment.id
      AND CAST(json_extract(item.analysis_json, '$.assessmentVersion') AS INTEGER) = assessment.version
      AND json_extract(item.analysis_json, '$.reviewStatus') = assessment.review_status
      AND CAST(json_extract(item.analysis_json, '$.confidence') AS REAL) = assessment.confidence
      AND json_extract(item.analysis_json, '$.methodology') = assessment.methodology
      AND json_extract(item.analysis_json, '$.summary') = json_extract(assessment.analysis_json, '$.summary')
      AND json_extract(item.analysis_json, '$.cycleAssessment') = json_extract(assessment.analysis_json, '$.cycleAssessment')
      AND json_extract(item.analysis_json, '$.implementationAssessment') = json_extract(assessment.analysis_json, '$.implementationAssessment')
      AND json_extract(item.analysis_json, '$.outcomeAssessment') = json_extract(assessment.analysis_json, '$.outcomeAssessment')
      AND coalesce(json_extract(item.analysis_json, '$.ambiguities'), '[]')
        = coalesce(json_extract(assessment.analysis_json, '$.ambiguities'), '[]')
      AND coalesce(json_extract(item.analysis_json, '$.citations'), '[]')
        = coalesce(json_extract(assessment.analysis_json, '$.citations'), '[]')
      AND coalesce(json_extract(item.analysis_json, '$.evidenceQuotes'), '[]')
        = coalesce(json_extract(assessment.analysis_json, '$.evidenceQuotes'), '[]')
      AND json_extract(item.analysis_json, '$.gates') = assessment.gates_json
      AND json_extract(assessment.analysis_json, '$.gates') = assessment.gates_json
      AND document.status <> 'draft'
      AND document.original_url = item.source_url
      AND document.title = item.title
      AND document.issuer = item.issuer
      AND document.document_number = item.document_number
      AND document.document_date = substr(item.published_at, 1, 10)
      AND document.published_at = item.published_at
      AND coalesce(document.effective_at, '') = coalesce(item.effective_at, '')
      AND document.content_text = item.content_text
      AND document.checksum = item.checksum
      AND analysis.headline = item.title || '：' || json_extract(assessment.analysis_json, '$.summary')
      AND analysis.interpretation = json_extract(assessment.analysis_json, '$.summary')
        || CASE WHEN coalesce(json_extract(assessment.analysis_json, '$.cycleAssessment'), '') <> ''
          THEN char(10) || char(10) || json_extract(assessment.analysis_json, '$.cycleAssessment') ELSE '' END
      AND analysis.impact = coalesce(json_extract(assessment.analysis_json, '$.implementationAssessment'), '')
        || CASE WHEN coalesce(json_extract(assessment.analysis_json, '$.outcomeAssessment'), '') <> ''
          THEN char(10) || char(10) || json_extract(assessment.analysis_json, '$.outcomeAssessment') ELSE '' END
      AND analysis.recommendations = CASE assessment.review_status
        WHEN 'watching' THEN '继续检索后续官方实施、实际拨付和结果材料；没有新证据时不提高结论等级。'
        WHEN 'partial' THEN '继续补齐尚未出现的实施或结果环节，并保持结果观察与政策因果判断分离。'
        WHEN 'ambiguous' THEN '保留冲突口径，等待权威说明或人工复核，不选择性采信其中一项。'
        ELSE '继续跟踪后续修订、废止和结果数据，不把已观察结果外推为单一政策因果。'
      END
      AND analysis.methodology = assessment.methodology
      AND analysis.evidence_summary = json_extract(assessment.analysis_json, '$.summary')
      AND analysis.model_name = assessment.methodology
      AND analysis.prompt_version = 'historical-release-v1'
      AND (
        control.mode = 'full'
        OR (control.mode = 'cohort' AND EXISTS (
          SELECT 1
          FROM historical_release_cohorts cohort
          JOIN historical_release_cohort_items cohort_item ON cohort_item.cohort_id = cohort.id
          WHERE cohort.id = control.active_cohort_id AND cohort.status = 'approved'
            AND cohort_item.item_id = item.id
            AND cohort_item.assessment_version_id = assessment.id
            AND cohort_item.input_checksum = assessment.input_checksum
        ))
      )
      AND NOT EXISTS (
        SELECT 1
        FROM historical_policy_evidence evidence
        LEFT JOIN historical_backfill_items source ON source.id = evidence.source_item_id
        WHERE evidence.item_id = item.id AND evidence.classification = 'accepted'
          AND (
            source.id IS NULL OR source.source_status <> 'verified'
            OR source.metadata_status <> 'verified'
            OR source.source_url <> evidence.source_url
            OR source.published_at <> evidence.observed_at
            OR trim(source.checksum) = ''
            OR instr(source.content_text, evidence.evidence_quote) = 0
            OR trim(evidence.evidence_quote) = ''
            OR evidence.confidence < 0.95
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM historical_policy_evidence evidence
        WHERE evidence.item_id = item.id AND evidence.classification = 'accepted'
          AND NOT EXISTS (
            SELECT 1 FROM policy_signals signal
            WHERE signal.document_id = document.id
              AND signal.kind = evidence.evidence_type
              AND signal.value_text = evidence.title
              AND signal.evidence_quote = evidence.evidence_quote
              AND signal.source_url = evidence.source_url
              AND signal.observed_at = evidence.observed_at
              AND signal.confidence = evidence.confidence
          )
      )
  ) THEN RAISE(ABORT, 'historical public release guard rejected the mapping') END;
END;

CREATE TRIGGER IF NOT EXISTS historical_public_releases_immutable_update
BEFORE UPDATE ON historical_public_releases
BEGIN
  SELECT RAISE(ABORT, 'historical public releases are immutable');
END;

CREATE TRIGGER IF NOT EXISTS historical_public_releases_immutable_delete
BEFORE DELETE ON historical_public_releases
BEGIN
  SELECT RAISE(ABORT, 'historical public releases cannot be deleted');
END;

-- These guards predate schema version 8. Recreate them so upgrades replace the
-- weaker definitions already stored in production SQLite databases.
DROP TRIGGER IF EXISTS historical_backfill_ready_insert_guard;
DROP TRIGGER IF EXISTS historical_backfill_ready_update_guard;

CREATE TRIGGER IF NOT EXISTS historical_backfill_ready_insert_guard
BEFORE INSERT ON historical_backfill_items
WHEN NEW.stage IN ('ready', 'published')
BEGIN
  SELECT CASE WHEN
    NEW.item_kind <> 'document' OR
    NEW.source_status <> 'verified' OR
    NEW.metadata_status <> 'verified' OR
    NEW.lifecycle_status NOT IN ('verified', 'not_applicable') OR
    NEW.implementation_status NOT IN ('verified', 'not_found', 'not_applicable') OR
    NEW.outcome_status NOT IN ('verified', 'not_found', 'not_applicable') OR
    NEW.analysis_status <> 'verified' OR
    NOT (NEW.source_url LIKE 'https://gov.cn/%' OR NEW.source_url GLOB 'https://*.gov.cn/*') OR
    trim(NEW.title) = '' OR trim(NEW.issuer) = '' OR NEW.published_at IS NULL OR
    trim(NEW.content_text) = '' OR trim(NEW.checksum) = '' OR
    json_array_length(NEW.evidence_urls_json) = 0 OR
    trim(NEW.review_notes) = '' OR trim(NEW.reviewed_by) = '' OR NEW.reviewed_at IS NULL OR
    (NEW.source_type = 'pdf' AND NOT EXISTS (
      SELECT 1
      FROM historical_segmentation_submission_items segment_item
      JOIN historical_segmentation_submissions segmentation ON segmentation.id = segment_item.submission_id
      WHERE segment_item.item_id = NEW.id
        AND segment_item.content_checksum = NEW.checksum
        AND segmentation.item_id = NEW.parent_id
        AND json_extract(segmentation.segments_json, '$.reviewKind') = 'human_verified'
    )) OR
    NOT EXISTS (
      SELECT 1 FROM historical_analysis_versions assessment
      WHERE assessment.id = CAST(json_extract(NEW.analysis_json, '$.assessmentVersionId') AS INTEGER)
        AND assessment.item_id = NEW.id AND assessment.release_eligible = 1
        AND assessment.confidence >= 0.95
        AND assessment.methodology IN ('historical-evidence-gates-v2', 'human-review-v1')
        AND (
          assessment.methodology <> 'human-review-v1'
          OR EXISTS (
            SELECT 1 FROM historical_review_submissions submission
            WHERE submission.item_id = NEW.id
              AND submission.assessment_version_id = assessment.id
              AND submission.source_checksum = NEW.checksum
              AND submission.review_checksum = assessment.input_checksum
              AND submission.reviewed_by = NEW.reviewed_by
              AND submission.reviewed_at = NEW.reviewed_at
          )
        )
        AND assessment.version = CAST(json_extract(NEW.analysis_json, '$.assessmentVersion') AS INTEGER)
        AND assessment.review_status = json_extract(NEW.analysis_json, '$.reviewStatus')
        AND assessment.confidence = CAST(json_extract(NEW.analysis_json, '$.confidence') AS REAL)
        AND assessment.methodology = json_extract(NEW.analysis_json, '$.methodology')
        AND json_extract(NEW.analysis_json, '$.summary') = json_extract(assessment.analysis_json, '$.summary')
        AND json_extract(NEW.analysis_json, '$.cycleAssessment') = json_extract(assessment.analysis_json, '$.cycleAssessment')
        AND json_extract(NEW.analysis_json, '$.implementationAssessment') = json_extract(assessment.analysis_json, '$.implementationAssessment')
        AND json_extract(NEW.analysis_json, '$.outcomeAssessment') = json_extract(assessment.analysis_json, '$.outcomeAssessment')
        AND coalesce(json_extract(NEW.analysis_json, '$.ambiguities'), '[]')
          = coalesce(json_extract(assessment.analysis_json, '$.ambiguities'), '[]')
        AND coalesce(json_extract(NEW.analysis_json, '$.citations'), '[]')
          = coalesce(json_extract(assessment.analysis_json, '$.citations'), '[]')
        AND coalesce(json_extract(NEW.analysis_json, '$.evidenceQuotes'), '[]')
          = coalesce(json_extract(assessment.analysis_json, '$.evidenceQuotes'), '[]')
        AND json_extract(NEW.analysis_json, '$.gates') = assessment.gates_json
        AND json_extract(assessment.analysis_json, '$.gates') = assessment.gates_json
        AND json_array_length(assessment.gates_json) > 0
        AND NOT EXISTS (
          SELECT 1 FROM json_each(assessment.gates_json) gate
          WHERE json_extract(gate.value, '$.passed') IS NOT 1
        )
    ) OR
    (NEW.stage = 'published' AND NOT EXISTS (
      SELECT 1 FROM historical_public_releases release
      WHERE release.item_id = NEW.id
        AND release.assessment_version_id = CAST(json_extract(NEW.analysis_json, '$.assessmentVersionId') AS INTEGER)
        AND release.document_id = NEW.document_id
    )) OR
    (NEW.stage = 'published' AND NEW.document_id IS NULL)
  THEN RAISE(ABORT, 'historical item is not fully verified for release') END;
END;

CREATE TRIGGER IF NOT EXISTS historical_backfill_ready_update_guard
BEFORE UPDATE ON historical_backfill_items
WHEN NEW.stage IN ('ready', 'published')
BEGIN
  SELECT CASE WHEN
    NEW.item_kind <> 'document' OR
    NEW.source_status <> 'verified' OR
    NEW.metadata_status <> 'verified' OR
    NEW.lifecycle_status NOT IN ('verified', 'not_applicable') OR
    NEW.implementation_status NOT IN ('verified', 'not_found', 'not_applicable') OR
    NEW.outcome_status NOT IN ('verified', 'not_found', 'not_applicable') OR
    NEW.analysis_status <> 'verified' OR
    NOT (NEW.source_url LIKE 'https://gov.cn/%' OR NEW.source_url GLOB 'https://*.gov.cn/*') OR
    trim(NEW.title) = '' OR trim(NEW.issuer) = '' OR NEW.published_at IS NULL OR
    trim(NEW.content_text) = '' OR trim(NEW.checksum) = '' OR
    json_array_length(NEW.evidence_urls_json) = 0 OR
    trim(NEW.review_notes) = '' OR trim(NEW.reviewed_by) = '' OR NEW.reviewed_at IS NULL OR
    (NEW.source_type = 'pdf' AND NOT EXISTS (
      SELECT 1
      FROM historical_segmentation_submission_items segment_item
      JOIN historical_segmentation_submissions segmentation ON segmentation.id = segment_item.submission_id
      WHERE segment_item.item_id = NEW.id
        AND segment_item.content_checksum = NEW.checksum
        AND segmentation.item_id = NEW.parent_id
        AND json_extract(segmentation.segments_json, '$.reviewKind') = 'human_verified'
    )) OR
    NOT EXISTS (
      SELECT 1 FROM historical_analysis_versions assessment
      WHERE assessment.id = CAST(json_extract(NEW.analysis_json, '$.assessmentVersionId') AS INTEGER)
        AND assessment.item_id = NEW.id AND assessment.release_eligible = 1
        AND assessment.confidence >= 0.95
        AND assessment.methodology IN ('historical-evidence-gates-v2', 'human-review-v1')
        AND (
          assessment.methodology <> 'human-review-v1'
          OR EXISTS (
            SELECT 1 FROM historical_review_submissions submission
            WHERE submission.item_id = NEW.id
              AND submission.assessment_version_id = assessment.id
              AND submission.source_checksum = NEW.checksum
              AND submission.review_checksum = assessment.input_checksum
              AND submission.reviewed_by = NEW.reviewed_by
              AND submission.reviewed_at = NEW.reviewed_at
          )
        )
        AND assessment.version = CAST(json_extract(NEW.analysis_json, '$.assessmentVersion') AS INTEGER)
        AND assessment.review_status = json_extract(NEW.analysis_json, '$.reviewStatus')
        AND assessment.confidence = CAST(json_extract(NEW.analysis_json, '$.confidence') AS REAL)
        AND assessment.methodology = json_extract(NEW.analysis_json, '$.methodology')
        AND json_extract(NEW.analysis_json, '$.summary') = json_extract(assessment.analysis_json, '$.summary')
        AND json_extract(NEW.analysis_json, '$.cycleAssessment') = json_extract(assessment.analysis_json, '$.cycleAssessment')
        AND json_extract(NEW.analysis_json, '$.implementationAssessment') = json_extract(assessment.analysis_json, '$.implementationAssessment')
        AND json_extract(NEW.analysis_json, '$.outcomeAssessment') = json_extract(assessment.analysis_json, '$.outcomeAssessment')
        AND coalesce(json_extract(NEW.analysis_json, '$.ambiguities'), '[]')
          = coalesce(json_extract(assessment.analysis_json, '$.ambiguities'), '[]')
        AND coalesce(json_extract(NEW.analysis_json, '$.citations'), '[]')
          = coalesce(json_extract(assessment.analysis_json, '$.citations'), '[]')
        AND coalesce(json_extract(NEW.analysis_json, '$.evidenceQuotes'), '[]')
          = coalesce(json_extract(assessment.analysis_json, '$.evidenceQuotes'), '[]')
        AND json_extract(NEW.analysis_json, '$.gates') = assessment.gates_json
        AND json_extract(assessment.analysis_json, '$.gates') = assessment.gates_json
        AND json_array_length(assessment.gates_json) > 0
        AND NOT EXISTS (
          SELECT 1 FROM json_each(assessment.gates_json) gate
          WHERE json_extract(gate.value, '$.passed') IS NOT 1
        )
    ) OR
    (NEW.stage = 'published' AND NOT EXISTS (
      SELECT 1 FROM historical_public_releases release
      WHERE release.item_id = NEW.id
        AND release.assessment_version_id = CAST(json_extract(NEW.analysis_json, '$.assessmentVersionId') AS INTEGER)
        AND release.document_id = NEW.document_id
    )) OR
    (NEW.stage = 'published' AND NEW.document_id IS NULL)
  THEN RAISE(ABORT, 'historical item is not fully verified for release') END;
END;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

-- SQLite datetime() uses a space separator, which sorts before the ISO UTC
-- timestamps used by queue readers. Normalize legacy retry values idempotently.
UPDATE historical_backfill_items
SET next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at)
WHERE next_attempt_at GLOB '????-??-?? ??:??:??*'
  AND strftime('%Y-%m-%dT%H:%M:%fZ', next_attempt_at) IS NOT NULL;

INSERT INTO schema_meta(key, value) VALUES ('schema_version', '14')
ON CONFLICT(key) DO UPDATE SET value = excluded.value;
