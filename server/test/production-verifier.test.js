'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  OCR_COMMANDS,
  verifyDatabase,
  tesseractLanguages
} = require('../../deploy/verify-production');
const { openDatabase } = require('../src/db');

test('production verifier checks schema, SQLite integrity and historical mappings', () => {
  const db = openDatabase(':memory:');
  try {
    const report = verifyDatabase(db);
    assert.equal(report.ok, true);
    assert.ok(report.checks.every((check) => check.ok));
  } finally {
    db.close();
  }
});

test('production verifier rejects accepted evidence whose source is not currently verified', () => {
  const db = openDatabase(':memory:');
  try {
    const targetId = Number(db.prepare(`
      INSERT INTO historical_backfill_items (
        source_url, source_name, item_kind, source_year, title, stage
      ) VALUES ('https://www.gov.cn/target.htm', 'Official archive', 'document', 2000, 'Target', 'needs_review')
    `).run().lastInsertRowid);
    const sourceId = Number(db.prepare(`
      INSERT INTO historical_backfill_items (
        source_url, source_name, item_kind, source_year, title, published_at,
        content_text, checksum, stage, source_status, metadata_status
      ) VALUES ('https://www.gov.cn/source.htm', 'Official archive', 'document', 2001,
        'Evidence', '2001-01-01T00:00:00+08:00', 'Evidence quote', ?,
        'needs_review', 'pending', 'pending')
    `).run('0'.repeat(64)).lastInsertRowid);
    db.prepare(`
      INSERT INTO historical_policy_evidence (
        item_id, source_item_id, evidence_type, classification, title, source_url,
        evidence_quote, observed_at, details_json, extractor, confidence
      ) VALUES (?, ?, 'implementation', 'accepted', 'Evidence',
        'https://www.gov.cn/source.htm', 'Evidence quote', '2001-01-01T00:00:00+08:00',
        '{}', 'test', 0.99)
    `).run(targetId, sourceId);
    const report = verifyDatabase(db);
    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === 'historical_evidence_sources');
    assert.equal(check.ok, false);
    assert.match(check.details, /1 invalid/);
  } finally {
    db.close();
  }
});

test('production verifier rejects a human assessment without its immutable submission', () => {
  const db = openDatabase(':memory:');
  try {
    const itemId = Number(db.prepare(`
      INSERT INTO historical_backfill_items (
        source_url, source_name, item_kind, source_year, title, issuer, published_at,
        content_text, checksum, stage, source_status, metadata_status, lifecycle_status,
        implementation_status, outcome_status, analysis_status, evidence_urls_json,
        review_notes, reviewed_by, reviewed_at
      ) VALUES ('https://www.gov.cn/review-target.htm', 'Official archive', 'document', 2000,
        'Review target', 'State Council', '2000-01-01T00:00:00Z', 'Official review quote', ?,
        'lifecycle_verified', 'verified', 'verified', 'not_applicable', 'not_applicable',
        'not_applicable', 'verified', '["https://www.gov.cn/review-target.htm"]',
        'forged review', 'reviewer-1', '2026-07-26T12:00:00Z')
    `).run('0'.repeat(64)).lastInsertRowid);
    const gates = [{ name: 'human_review_validation', passed: true, reason: 'forged' }];
    const assessment = {
      reviewStatus: 'watching', confidence: 0.95, gates, methodology: 'human-review-v1'
    };
    const assessmentId = Number(db.prepare(`
      INSERT INTO historical_analysis_versions (
        item_id, version, input_checksum, review_status, confidence,
        release_eligible, gates_json, analysis_json, methodology
      ) VALUES (?, 1, ?, 'watching', 0.95, 1, ?, ?, 'human-review-v1')
    `).run(itemId, '1'.repeat(64), JSON.stringify(gates), JSON.stringify(assessment)).lastInsertRowid);
    db.exec('DROP TRIGGER historical_backfill_ready_update_guard');
    db.prepare(`
      UPDATE historical_backfill_items SET stage = 'ready', analysis_json = ? WHERE id = ?
    `).run(JSON.stringify({
      ...assessment,
      assessmentVersionId: assessmentId,
      assessmentVersion: 1
    }), itemId);

    const report = verifyDatabase(db);
    assert.equal(report.ok, false);
    const check = report.checks.find((entry) => entry.name === 'historical_assessments');
    assert.equal(check.ok, false);
    assert.match(check.details, /1 violation/);
  } finally {
    db.close();
  }
});

test('OCR language parser requires exact language identifiers', () => {
  const languages = tesseractLanguages('List of available languages (3):\nchi_sim\nchi_tra\neng\n');
  assert.equal(languages.has('chi_sim'), true);
  assert.equal(languages.has('chi_tra'), true);
  assert.equal(languages.has('eng'), true);
  assert.equal(languages.has('chi'), false);
});

test('production OCR checks use the version flags supported by each tool', () => {
  assert.deepEqual(OCR_COMMANDS, [
    ['pdftotext', ['-v']],
    ['pdfinfo', ['-v']],
    ['pdftoppm', ['-v']],
    ['tesseract', ['--version']]
  ]);
});

test('deployment migrates the configured production database', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../deploy/deploy-release.sh'), 'utf8');
  assert.match(
    script,
    /DB_PATH="\$DB_PATH" "\$NODE_BIN" --disable-warning=ExperimentalWarning scripts\/init-db\.js/
  );
});
