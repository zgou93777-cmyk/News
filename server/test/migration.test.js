'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const { getSchemaVersion, openDatabase } = require('../src/db');

test('schema 3 databases gain new tables and replace legacy release guards', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-monitor-migration-'));
  const filename = path.join(directory, 'migration.db');
  try {
    openDatabase(filename).close();
    const legacy = new DatabaseSync(filename, { enableForeignKeyConstraints: false });
    try {
      legacy.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TRIGGER IF EXISTS historical_backfill_ready_insert_guard;
        DROP TRIGGER IF EXISTS historical_backfill_ready_update_guard;
        DROP TRIGGER IF EXISTS historical_public_release_insert_guard;
        DROP TRIGGER IF EXISTS historical_public_releases_immutable_update;
        DROP TRIGGER IF EXISTS historical_public_releases_immutable_delete;
        DROP TRIGGER IF EXISTS historical_analysis_versions_immutable_update;
        DROP TRIGGER IF EXISTS historical_analysis_versions_immutable_delete;
        DROP TRIGGER IF EXISTS historical_review_submissions_insert_guard;
        DROP TRIGGER IF EXISTS historical_review_submissions_immutable_update;
        DROP TRIGGER IF EXISTS historical_review_submissions_immutable_delete;
        DROP TRIGGER IF EXISTS historical_segmentation_submissions_insert_guard;
        DROP TRIGGER IF EXISTS historical_segmentation_submissions_immutable_update;
        DROP TRIGGER IF EXISTS historical_segmentation_submissions_immutable_delete;
        DROP TRIGGER IF EXISTS historical_segmentation_submission_items_insert_guard;
        DROP TRIGGER IF EXISTS historical_segmentation_submission_items_immutable_update;
        DROP TRIGGER IF EXISTS historical_segmentation_submission_items_immutable_delete;
        DROP TRIGGER IF EXISTS historical_segmentation_artifacts_immutable_update;
        DROP TRIGGER IF EXISTS historical_segmentation_artifacts_immutable_delete;
        DROP TRIGGER IF EXISTS historical_release_control_delete_guard;
        DROP TRIGGER IF EXISTS historical_release_control_update_guard;
        DROP TRIGGER IF EXISTS historical_release_cohorts_delete_guard;
        DROP TRIGGER IF EXISTS historical_release_cohorts_update_guard;
        DROP TRIGGER IF EXISTS historical_release_cohorts_insert_guard;
        DROP TRIGGER IF EXISTS historical_release_cohort_items_immutable_delete;
        DROP TRIGGER IF EXISTS historical_release_cohort_items_immutable_update;
        DROP TABLE historical_public_releases;
        DROP TABLE historical_release_control;
        DROP TABLE historical_release_cohort_items;
        DROP TABLE historical_release_cohorts;
        DROP TABLE historical_review_submissions;
        DROP TABLE historical_segmentation_submission_items;
        DROP TABLE historical_segmentation_submissions;
        DROP TABLE historical_analysis_versions;
        DROP TABLE historical_evidence_searches;
        DROP TABLE historical_policy_evidence;
        DROP TABLE historical_policy_relations;
        DROP TABLE historical_verification_evidence;
        DROP TABLE historical_artifacts;
        DROP TABLE historical_source_scans;
        UPDATE schema_meta SET value = '3' WHERE key = 'schema_version';
        INSERT INTO historical_backfill_items (
          source_url, source_name, item_kind, source_year, title, stage, next_attempt_at
        ) VALUES ('https://www.gov.cn/gongbao/retry-format.htm', 'Official Gazette',
          'document', 1954, 'legacy retry', 'failed', '2026-07-26 11:00:00');
        CREATE TRIGGER historical_backfill_ready_update_guard
        BEFORE UPDATE ON historical_backfill_items
        WHEN NEW.stage IN ('ready', 'published')
        BEGIN
          SELECT CASE WHEN trim(NEW.title) = ''
            THEN RAISE(ABORT, 'legacy guard') END;
        END;
      `);
    } finally {
      legacy.close();
    }

    const upgraded = openDatabase(filename);
    try {
      assert.equal(getSchemaVersion(upgraded), '13');
      const retry = upgraded.prepare(`
        SELECT next_attempt_at,
          next_attempt_at > '2026-07-26T10:00:00.000Z' AS remains_deferred
        FROM historical_backfill_items
        WHERE source_url = 'https://www.gov.cn/gongbao/retry-format.htm'
      `).get();
      assert.equal(retry.next_attempt_at, '2026-07-26T11:00:00.000Z');
      assert.equal(retry.remains_deferred, 1);
      const tables = new Set(upgraded.prepare(`
        SELECT name FROM sqlite_schema WHERE type = 'table'
      `).all().map((row) => row.name));
      for (const name of [
        'historical_artifacts',
        'historical_segmentation_submissions',
        'historical_segmentation_submission_items',
        'historical_verification_evidence',
        'historical_policy_evidence',
        'historical_analysis_versions',
        'historical_review_submissions',
        'historical_release_cohorts',
        'historical_release_cohort_items',
        'historical_release_control',
        'historical_public_releases'
      ]) assert.ok(tables.has(name), `missing upgraded table ${name}`);
      const guard = upgraded.prepare(`
        SELECT sql FROM sqlite_schema
        WHERE type = 'trigger' AND name = 'historical_backfill_ready_update_guard'
      `).get().sql;
      assert.match(guard, /assessmentVersionId/);
      assert.doesNotMatch(guard, /legacy guard/);
      const releaseGuard = upgraded.prepare(`
        SELECT sql FROM sqlite_schema
        WHERE type = 'trigger' AND name = 'historical_public_release_insert_guard'
      `).get().sql;
      assert.match(releaseGuard, /historical-evidence-gates-v2/);
      assert.match(releaseGuard, /policy_signals/);
      assert.match(releaseGuard, /historical_release_control/);
      assert.doesNotMatch(releaseGuard, /historical-evidence-gates-v1/);
      const itemId = Number(upgraded.prepare(`
        INSERT INTO historical_backfill_items (
          source_url, source_name, item_kind, source_year, title, stage
        ) VALUES ('https://www.gov.cn/gongbao/migration.htm', 'Official Gazette',
          'document', 1954, 'legacy title', 'needs_review')
      `).run().lastInsertRowid);
      assert.throws(
        () => upgraded.prepare(`
          UPDATE historical_backfill_items SET stage = 'ready' WHERE id = ?
        `).run(itemId),
        /not fully verified/
      );
    } finally {
      upgraded.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
