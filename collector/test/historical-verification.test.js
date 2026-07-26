'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { openDatabase } = require('../../server/src/db');
const {
  extractDocumentNumbers,
  extractExplicitEndEvidence,
  extractIssuerEvidence,
  metadataEvidence,
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

test('historical issuer and document-number forms are extracted without modernizing them', () => {
  assert.deepEqual(
    extractDocumentNumbers('中央人民政府政务院（54）政财字第12号').map((entry) => entry.value),
    ['（54）政财字第12号']
  );
  const title = '中央人民政府政务院关于历史政策测试工作的决定';
  const text = `${title}\n一九五四年十月十六日政务院会议通过\n${'各地依照决定执行。'.repeat(20)}`;
  const evidence = metadataEvidence({
    source_url: 'https://www.gov.cn/gongbao/shuju/1954/test.pdf#candidate=one',
    source_year: 1955,
    title,
    issuer: '',
    content_text: text,
    checksum: checksum(text)
  });
  assert.equal(evidence.issuer.value, '中央人民政府政务院');
  assert.equal(evidence.published.value, '1954-10-16T00:00:00+08:00');
  assert.ok(evidence.title.quote.includes(title));
  assert.deepEqual(
    extractDocumentNumbers('国务院国发〔1980〕1号').map((entry) => entry.value),
    ['国发〔1980〕1号']
  );
});

test('issuer and expiry extraction reject sentence fragments that only look like metadata', () => {
  assert.equal(extractIssuerEvidence({
    title: '历史政策测试材料',
    content_text: `历史政策测试材料\n${'政策正文。'.repeat(20)}\n具体工作由财政部`
  }), null);
  assert.equal(extractExplicitEndEvidence({
    content_text: '本项目申报材料有效期至一九八〇年十二月三十一日。'
  }), null);
  assert.equal(extractExplicitEndEvidence({
    content_text: '本办法有效期至一九八〇年十二月三十一日。'
  }).value, '1980-12-31T00:00:00+08:00');
});

test('metadata title evidence must contain the queued title in the quoted source span', () => {
  const text = `无关首页文字\n国务院 关于跨行历史政策\n工作的通知\n国务院\n一九八〇年一月十日`;
  const item = {
    source_url: 'https://www.gov.cn/gongbao/1980/cross-line.htm',
    source_year: 1980,
    title: '国务院关于跨行历史政策工作的通知',
    content_text: text,
    checksum: checksum(text)
  };
  const evidence = metadataEvidence(item);
  assert.match(evidence.title.quote, /跨行历史政策/);
  assert.doesNotMatch(evidence.title.quote, /^无关首页文字$/);

  const missing = metadataEvidence({ ...item, title: '国务院关于并不存在的政策通知' });
  assert.equal(missing.title, null);
});

test('publication extraction ignores an incidental same-year date in body text', () => {
  const title = '国务院关于日期核验测试工作的通知';
  const bodyOnly = `${title}\n第一条 本通知总结一九八〇年一月十日召开的行业座谈会情况。\n${'各部门按职责开展工作。'.repeat(20)}`;
  const withoutPublication = metadataEvidence({
    source_url: 'https://www.gov.cn/gongbao/1980/body-date.htm',
    source_year: 1980,
    title,
    content_text: bodyOnly,
    checksum: checksum(bodyOnly)
  });
  assert.equal(withoutPublication.published, null);

  const signed = `${bodyOnly}\n国务院\n一九八〇年二月三日`;
  const withPublication = metadataEvidence({
    source_url: 'https://www.gov.cn/gongbao/1980/signed.htm',
    source_year: 1980,
    title,
    content_text: signed,
    checksum: checksum(signed)
  });
  assert.equal(withPublication.published.value, '1980-02-03T00:00:00+08:00');
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

test('lifecycle matching normalizes document-number spacing and records superseding relations', () => {
  const db = openDatabase(':memory:');
  try {
    const oldNumber = '国发〔1980〕12号';
    const oldId = insertDocument(db, {
      url: 'https://www.gov.cn/gongbao/1980/old-spaced.htm',
      year: 1980,
      title: '国务院关于旧办法的通知',
      issuer: '国务院',
      documentNumber: oldNumber,
      publishedAt: '1980-01-10T00:00:00+08:00',
      text: `国务院关于旧办法的通知\n${oldNumber}`,
      stage: 'source_verified', sourceStatus: 'verified', metadataStatus: 'verified'
    });
    insertDocument(db, {
      url: 'https://www.gov.cn/gongbao/1990/new-spaced.htm',
      year: 1990,
      title: '国务院关于执行新办法的通知',
      issuer: '国务院',
      documentNumber: '国发〔1990〕2号',
      publishedAt: '1990-03-02T00:00:00+08:00',
      text: '原国发 〔 1980 〕 12 号文件与本通知不一致的，以本通知为准。',
      stage: 'source_verified', sourceStatus: 'verified', metadataStatus: 'verified'
    });

    const result = verifyLifecycle(db, db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(oldId));
    assert.equal(result.complete, true);
    const relation = db.prepare('SELECT relation_type FROM historical_policy_relations').get();
    assert.equal(relation.relation_type, 'supersedes');
    assert.equal(db.prepare('SELECT repealed_at FROM historical_backfill_items WHERE id = ?').get(oldId).repealed_at, '1990-03-02T00:00:00+08:00');
  } finally {
    db.close();
  }
});

test('unverified later text cannot close a lifecycle and known archive gaps prevent not-found', () => {
  const db = openDatabase(':memory:');
  try {
    completeArchiveScans(db);
    const oldNumber = '国发〔1960〕1号';
    const oldId = insertDocument(db, {
      url: 'https://www.gov.cn/gongbao/1960/old.htm', year: 1960,
      title: '国务院关于历史旧政策的通知', issuer: '国务院', documentNumber: oldNumber,
      publishedAt: '1960-01-10T00:00:00+08:00', text: `国务院关于历史旧政策的通知\n${oldNumber}`,
      stage: 'source_verified', sourceStatus: 'verified', metadataStatus: 'verified'
    });
    insertDocument(db, {
      url: 'https://www.gov.cn/gongbao/1980/unverified.htm', year: 1980,
      title: '未经核验的废止材料', publishedAt: '1980-01-01T00:00:00+08:00',
      text: `${oldNumber}停止执行。`, stage: 'needs_review'
    });

    const result = verifyLifecycle(db, db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(oldId));
    assert.equal(result.complete, false);
    assert.equal(result.cycle.endedStatus, 'pending');
    assert.match(result.cycle.searchScope, /official archive gap 1967-1979/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM historical_policy_relations').get().count, 0);
  } finally {
    db.close();
  }
});

test('a newly verified successor replaces stale not-found evidence and synchronizes the predecessor cycle', () => {
  const db = openDatabase(':memory:');
  try {
    completeArchiveScans(db);
    const oldNumber = '国发〔1980〕8号';
    const oldId = insertDocument(db, {
      url: 'https://www.gov.cn/gongbao/1980/stale-old.htm', year: 1980,
      title: '国务院关于旧政策的通知', issuer: '国务院', documentNumber: oldNumber,
      publishedAt: '1980-01-10T00:00:00+08:00', text: `国务院关于旧政策的通知\n${oldNumber}`,
      stage: 'source_verified', sourceStatus: 'verified', metadataStatus: 'verified'
    });
    const initial = verifyLifecycle(db, db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(oldId));
    assert.equal(initial.cycle.endedStatus, 'not_found');
    assert.equal(db.prepare(`
      SELECT count(*) AS count FROM historical_verification_evidence
      WHERE item_id = ? AND claim_type = 'repealed_at' AND status = 'not_found'
    `).get(oldId).count, 1);

    const successorId = insertDocument(db, {
      url: 'https://www.gov.cn/gongbao/1990/stale-new.htm', year: 1990,
      title: '国务院关于执行新政策的通知', issuer: '国务院', documentNumber: '国发〔1990〕9号',
      publishedAt: '1990-03-02T00:00:00+08:00',
      text: `${oldNumber}与本通知不一致的，以本通知为准。`,
      stage: 'source_verified', sourceStatus: 'verified', metadataStatus: 'verified'
    });
    verifyLifecycle(db, db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(successorId));

    const updated = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(oldId);
    assert.equal(updated.repealed_at, '1990-03-02T00:00:00+08:00');
    assert.equal(JSON.parse(updated.policy_cycle_json).endedStatus, 'verified');
    assert.equal(db.prepare(`
      SELECT count(*) AS count FROM historical_verification_evidence
      WHERE item_id = ? AND claim_type = 'repealed_at' AND status = 'not_found'
    `).get(oldId).count, 0);
    assert.equal(db.prepare(`
      SELECT count(*) AS count FROM historical_verification_evidence
      WHERE item_id = ? AND claim_type = 'repealed_at' AND status = 'verified'
    `).get(oldId).count, 1);
  } finally {
    db.close();
  }
});

test('rejected PDF children do not prevent a complete lifecycle corpus decision', () => {
  const db = openDatabase(':memory:');
  try {
    completeArchiveScans(db);
    const id = insertDocument(db, {
      url: 'https://www.gov.cn/gongbao/1980/coverage.htm', year: 1980,
      title: '国务院关于档案覆盖测试的通知', issuer: '国务院',
      publishedAt: '1980-01-10T00:00:00+08:00', text: '国务院关于档案覆盖测试的通知',
      stage: 'source_verified', sourceStatus: 'verified', metadataStatus: 'verified'
    });
    const rejectedId = insertDocument(db, {
      url: 'https://www.gov.cn/gongbao/1990/rejected.htm', year: 1990,
      title: 'Rejected OCR child', text: 'Rejected OCR child', stage: 'manual_review',
      sourceStatus: 'rejected', metadataStatus: 'rejected'
    });
    assert.ok(rejectedId > id);

    const result = verifyLifecycle(db, db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(id));
    assert.equal(result.complete, true);
    assert.equal(result.cycle.endedStatus, 'not_found');
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
