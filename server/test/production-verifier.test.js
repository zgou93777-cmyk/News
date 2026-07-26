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
