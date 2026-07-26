'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { openDatabase } = require('../src/db');
const { seedDatabase } = require('../src/seed');

const REQUIRED_TABLES = [
  'sources',
  'documents',
  'policy_families',
  'policy_signals',
  'analysis_versions',
  'forecasts',
  'implementation_events',
  'ambiguities',
  'assessment_snapshots',
  'push_subscriptions',
  'sync_runs',
  'historical_backfill_items'
];

test('historical backfill records are private and verification-gated', () => {
  const db = openDatabase(':memory:');
  try {
    db.prepare(`
      INSERT INTO historical_backfill_items (
        source_url, source_name, source_year, item_kind, stage
      ) VALUES (?, ?, ?, 'document', 'needs_review')
    `).run('https://www.gov.cn/gongbao/example.htm', '国务院公报', 1954);
    const row = db.prepare('SELECT * FROM historical_backfill_items').get();
    assert.equal(row.source_status, 'pending');
    assert.equal(row.analysis_status, 'pending');
    assert.equal(row.document_id, null);
    assert.throws(
      () => db.prepare("UPDATE historical_backfill_items SET stage = 'public' WHERE id = ?").run(row.id),
      /CHECK constraint failed/
    );
    assert.throws(
      () => db.prepare("UPDATE historical_backfill_items SET stage = 'ready' WHERE id = ?").run(row.id),
      /not fully verified/
    );
  } finally {
    db.close();
  }
});

test('schema contains all traceability tables', () => {
  const db = openDatabase(':memory:');
  try {
    const names = new Set(db.prepare(`
      SELECT name FROM sqlite_schema WHERE type = 'table'
    `).all().map((row) => row.name));
    for (const table of REQUIRED_TABLES) assert.ok(names.has(table), `missing ${table}`);
  } finally {
    db.close();
  }
});

test('seed is idempotent and contains the verified 15th five-year example', () => {
  const db = openDatabase(':memory:');
  try {
    seedDatabase(db);
    seedDatabase(db);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analysis_versions').get().count, 4);

    const document = db.prepare(`
      SELECT * FROM documents WHERE original_url = ?
    `).get('https://www.gov.cn/zhengce/content/202607/content_7075216.htm');
    assert.match(document.title, /扩大消费/);
    assert.equal(document.issuer, '国务院');
    assert.equal(document.document_number, '国函〔2026〕66号');
    assert.equal(document.document_date, '2026-07-02');
    assert.equal(document.published_at, '2026-07-13T00:00:00+08:00');
    assert.equal(document.effective_at, null);
    assert.match(document.content_text, /60万亿元/);
    assert.match(document.content_text, /本文有删减/);

    const latest = db.prepare(`
      SELECT * FROM analysis_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1
    `).get(document.id);
    assert.equal(latest.version, 2);
    assert.match(latest.interpretation, /不代表住房在法律或统计上被重新分类/);
    assert.match(latest.recommendations, /不把“住房消费”表述误读/);
    assert.ok(db.prepare('SELECT COUNT(*) AS count FROM forecasts WHERE analysis_version_id = ?').get(latest.id).count >= 3);
    assert.ok(db.prepare('SELECT COUNT(*) AS count FROM ambiguities WHERE document_id = ?').get(document.id).count >= 3);
  } finally {
    db.close();
  }
});

test('published analysis history cannot be overwritten or deleted', () => {
  const db = openDatabase(':memory:');
  try {
    seedDatabase(db);
    const analysis = db.prepare('SELECT id FROM analysis_versions ORDER BY id LIMIT 1').get();
    assert.throws(
      () => db.prepare('UPDATE analysis_versions SET headline = ? WHERE id = ?').run('changed', analysis.id),
      /immutable/
    );
    assert.throws(
      () => db.prepare('DELETE FROM analysis_versions WHERE id = ?').run(analysis.id),
      /immutable/
    );
  } finally {
    db.close();
  }
});
