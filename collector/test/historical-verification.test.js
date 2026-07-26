'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { openDatabase } = require('../../server/src/db');
const {
  parseChineseDate,
  runHistoricalVerificationQueue,
  verifyLifecycle
} = require('../src/historical-verification');

function checksum(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function insertDocument(db, values) {
  return Number(db.prepare(`
    INSERT INTO historical_backfill_items (
      source_url, source_name, source_type, item_kind, source_year, title,
      issuer, document_number, published_at, effective_at, content_text, checksum, stage,
      source_status, metadata_status
    ) VALUES (?, 'Official Gazette', 'pdf', 'document', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.url,
    values.year,
    values.title,
    values.issuer || '',
    values.documentNumber || '',
    values.publishedAt || null,
    values.effectiveAt || null,
    values.text,
    checksum(values.text),
    values.stage || 'needs_review',
    values.sourceStatus || 'pending',
    values.metadataStatus || 'pending'
  ).lastInsertRowid);
}

function completeArchiveScans(db) {
  const currentYear = new Date().getFullYear();
  db.prepare(`
    INSERT INTO historical_source_scans (
      source_id, from_year, to_year, available_items, remaining_items, complete
    ) VALUES (?, ?, ?, 1, 0, 1)
  `).run('state-council-gazette-legacy', 1954, 1999);
  db.prepare(`
    INSERT INTO historical_source_scans (
      source_id, from_year, to_year, available_items, remaining_items, complete
    ) VALUES (?, ?, ?, 1, 0, 1)
  `).run('state-council-gazette-modern', 2000, currentYear);
}

test('Chinese policy dates are parsed without inventing invalid dates', () => {
  assert.equal(parseChineseDate('一九八〇年二月一日'), '1980-02-01T00:00:00+08:00');
  assert.equal(parseChineseDate('二○○○年十二月廿一日'), '2000-12-21T00:00:00+08:00');
  assert.equal(parseChineseDate('1980年12月31日'), '1980-12-31T00:00:00+08:00');
  assert.equal(parseChineseDate('1980年2月31日'), null);
});

test('metadata and lifecycle verification store verbatim evidence but no public document', async () => {
  const db = openDatabase(':memory:');
  try {
    completeArchiveScans(db);
    const title = '国务院关于开展历史政策测试工作的通知';
    const text = `${title}\n国发〔1980〕1号\n自一九八〇年二月一日起施行。\n${'各地区各部门应当依照本通知执行并保存正式记录。'.repeat(8)}\n国务院\n一九八〇年一月十日`;
    const id = insertDocument(db, {
      url: 'https://www.gov.cn/gongbao/shuju/1980/test.pdf#candidate=one',
      year: 1980,
      title,
      text
    });
    const result = await runHistoricalVerificationQueue(db, { maxItems: 1 }, {
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });
    assert.equal(result.metadataVerified, 1);
    assert.equal(result.lifecycleVerified, 1);
    const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(id);
    assert.equal(item.stage, 'lifecycle_verified');
    assert.equal(item.source_status, 'verified');
    assert.equal(item.metadata_status, 'verified');
    assert.equal(item.lifecycle_status, 'verified');
    assert.equal(item.issuer, '国务院');
    assert.equal(item.document_number, '国发〔1980〕1号');
    assert.equal(item.published_at, '1980-01-10T00:00:00+08:00');
    assert.equal(item.effective_at, '1980-02-01T00:00:00+08:00');
    const cycle = JSON.parse(item.policy_cycle_json);
    assert.equal(cycle.endedStatus, 'not_found');
    const evidence = db.prepare(`
      SELECT claim_type, status, evidence_quote, search_scope
      FROM historical_verification_evidence WHERE item_id = ? ORDER BY claim_type, status
    `).all(id);
    assert.ok(evidence.some((entry) => entry.claim_type === 'issuer' && entry.evidence_quote.includes('国务院')));
    assert.ok(evidence.some((entry) => entry.claim_type === 'repealed_at' && entry.status === 'not_found' && entry.search_scope));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 0);
  } finally {
    db.close();
  }
});

test('a later official repeal creates a verified relation and closes the predecessor lifecycle', () => {
  const db = openDatabase(':memory:');
  try {
    const oldNumber = '国发〔1980〕1号';
    const oldId = insertDocument(db, {
      url: 'https://www.gov.cn/gongbao/1980/old.htm',
      year: 1980,
      title: '国务院关于旧政策的通知',
      issuer: '国务院',
      documentNumber: oldNumber,
      publishedAt: '1980-01-10T00:00:00+08:00',
      effectiveAt: '1980-02-01T00:00:00+08:00',
      text: `国务院关于旧政策的通知\n${oldNumber}\n自一九八〇年二月一日起施行。`,
      stage: 'source_verified',
      sourceStatus: 'verified',
      metadataStatus: 'verified'
    });
    const newTitle = '国务院关于废止旧政策的通知';
    const newText = `${newTitle}\n国发〔1990〕2号\n自本通知发布之日起，${oldNumber}停止执行。\n国务院\n一九九〇年三月二日`;
    const newId = insertDocument(db, {
      url: 'https://www.gov.cn/gongbao/1990/new.htm',
      year: 1990,
      title: newTitle,
      issuer: '国务院',
      documentNumber: '国发〔1990〕2号',
      publishedAt: '1990-03-02T00:00:00+08:00',
      text: newText,
      stage: 'source_verified',
      sourceStatus: 'verified',
      metadataStatus: 'verified'
    });
    const oldItem = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(oldId);
    const lifecycle = verifyLifecycle(db, oldItem);
    assert.equal(lifecycle.complete, true);
    assert.equal(db.prepare('SELECT repealed_at FROM historical_backfill_items WHERE id = ?').get(oldId).repealed_at, '1990-03-02T00:00:00+08:00');
    const relation = db.prepare('SELECT * FROM historical_policy_relations').get();
    assert.equal(relation.predecessor_item_id, oldId);
    assert.equal(relation.successor_item_id, newId);
    assert.equal(relation.relation_type, 'repeals');
  } finally {
    db.close();
  }
});

test('missing core metadata remains private and records the missing fields', async () => {
  const db = openDatabase(':memory:');
  try {
    const text = '历史政策测试材料。'.repeat(30);
    const id = insertDocument(db, {
      url: 'https://www.gov.cn/gongbao/1981/incomplete.htm',
      year: 1981,
      title: '历史政策测试材料',
      text
    });
    const result = await runHistoricalVerificationQueue(db, { maxItems: 1 }, {
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });
    assert.equal(result.metadataVerified, 0);
    const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(id);
    assert.equal(item.stage, 'needs_review');
    assert.match(item.last_error, /issuer/);
    assert.match(item.last_error, /published_at/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 0);
  } finally {
    db.close();
  }
});
