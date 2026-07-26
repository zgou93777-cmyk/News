'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { openDatabase } = require('../../server/src/db');
const { classifyEvidenceCandidate, runHistoricalEvidenceQueue } = require('../src/historical-evidence');

function insertItem(db, values) {
  return Number(db.prepare(`
    INSERT INTO historical_backfill_items (
      source_url, source_name, source_type, item_kind, source_year, title, issuer,
      document_number, published_at, content_text, stage, source_status,
      metadata_status, lifecycle_status, implementation_status, outcome_status
    ) VALUES (?, 'Official Gazette', 'html', 'document', ?, ?, '国务院', ?, ?, ?, ?, 'verified', 'verified', ?, ?, ?)
  `).run(
    values.url,
    values.year,
    values.title,
    values.documentNumber || '',
    values.publishedAt,
    values.text,
    values.stage || 'needs_review',
    values.lifecycleStatus || 'pending',
    values.implementationStatus || 'pending',
    values.outcomeStatus || 'pending'
  ).lastInsertRowid);
}

function targetPolicy(db, suffix = 'one') {
  const documentNumber = '国发〔2020〕1号';
  const id = insertItem(db, {
    url: `https://www.gov.cn/gongbao/2020/target-${suffix}.htm`,
    year: 2020,
    title: `国务院关于历史证据测试政策的通知${suffix}`,
    documentNumber,
    publishedAt: '2020-01-10T00:00:00+08:00',
    text: `国务院关于历史证据测试政策的通知${suffix}\n${documentNumber}`,
    stage: 'lifecycle_verified',
    lifecycleStatus: 'verified'
  });
  return db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(id);
}

test('meetings and planned actions are excluded from implementation evidence', () => {
  const target = { title: '测试政策', document_number: '国发〔2020〕1号' };
  const meeting = {
    title: '召开政策落实工作会议',
    content_text: '会议研究了国发〔2020〕1号，并要求下一步加快推动落实。'
  };
  const planning = {
    title: '关于贯彻测试政策的通知',
    content_text: '根据国发〔2020〕1号，下一步将安排专项资金并推动项目实施。'
  };
  assert.deepEqual(classifyEvidenceCandidate(target, meeting).map((item) => [item.evidenceType, item.classification]), [
    ['meeting_signal', 'excluded']
  ]);
  assert.deepEqual(classifyEvidenceCandidate(target, planning).map((item) => [item.evidenceType, item.classification]), [
    ['policy_release', 'excluded']
  ]);
});

test('paid funding and result reports become separate verified evidence while meetings remain excluded', async () => {
  const db = openDatabase(':memory:');
  try {
    const target = targetPolicy(db);
    insertItem(db, {
      url: 'https://www.gov.cn/gongbao/2021/meeting.htm',
      year: 2021,
      title: '召开历史证据测试政策落实会议',
      publishedAt: '2021-01-01T00:00:00+08:00',
      text: `会议研究${target.document_number}并部署下一步推动落实。`
    });
    insertItem(db, {
      url: 'https://www.gov.cn/gongbao/2021/funding.htm',
      year: 2021,
      title: '关于历史证据测试政策资金执行情况的通知',
      publishedAt: '2021-03-01T00:00:00+08:00',
      text: `根据${target.document_number}，中央财政已下达专项资金100亿元，相关资金已经拨付到项目单位。`
    });
    insertItem(db, {
      url: 'https://www.gov.cn/gongbao/2022/outcome.htm',
      year: 2022,
      title: '历史证据测试政策执行情况报告',
      publishedAt: '2022-06-01T00:00:00+08:00',
      text: `本报告评估${target.document_number}。截至2022年5月，累计完成项目120个，覆盖10万户。`
    });
    const result = await runHistoricalEvidenceQueue(db, { maxItems: 1 }, {
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });
    assert.equal(result.completed, 1);
    assert.equal(result.implementationVerified, 1);
    assert.equal(result.outcomeVerified, 1);
    const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(target.id);
    assert.equal(item.implementation_status, 'verified');
    assert.equal(item.outcome_status, 'verified');
    const implementation = JSON.parse(item.implementation_json);
    assert.ok(implementation.some((entry) => entry.type === 'funding'));
    assert.ok(implementation.some((entry) => entry.type === 'implementation'));
    assert.equal(JSON.parse(item.outcome_json).length, 1);
    const evidence = db.prepare(`
      SELECT evidence_type, classification FROM historical_policy_evidence
      WHERE item_id = ? ORDER BY evidence_type, classification
    `).all(target.id);
    assert.ok(evidence.some((entry) => entry.evidence_type === 'meeting_signal' && entry.classification === 'excluded'));
    assert.ok(evidence.some((entry) => entry.evidence_type === 'funding' && entry.classification === 'accepted'));
    assert.ok(evidence.some((entry) => entry.evidence_type === 'outcome' && entry.classification === 'accepted'));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 0);
  } finally {
    db.close();
  }
});

test('a complete official corpus records not-found instead of treating plans as delivery', async () => {
  const db = openDatabase(':memory:');
  try {
    const target = targetPolicy(db, 'two');
    insertItem(db, {
      url: 'https://www.gov.cn/gongbao/2021/plan.htm',
      year: 2021,
      title: '关于贯彻历史证据测试政策的通知',
      publishedAt: '2021-01-01T00:00:00+08:00',
      text: `根据${target.document_number}，有关部门将安排资金并推动项目实施。`
    });
    db.prepare(`
      INSERT INTO historical_source_scans (
        source_id, from_year, to_year, available_items, remaining_items, complete
      ) VALUES ('state-council-gazette-modern', 2000, ?, 2, 0, 1)
    `).run(new Date().getFullYear());
    const result = await runHistoricalEvidenceQueue(db, { maxItems: 1 }, {
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });
    assert.equal(result.completed, 1);
    const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(target.id);
    assert.equal(item.implementation_status, 'not_found');
    assert.equal(item.outcome_status, 'not_found');
    assert.deepEqual(JSON.parse(item.implementation_json), []);
    assert.deepEqual(JSON.parse(item.outcome_json), []);
    const searches = db.prepare(`
      SELECT evidence_scope, status, search_scope FROM historical_evidence_searches
      WHERE item_id = ? ORDER BY evidence_scope
    `).all(target.id);
    assert.ok(searches.every((search) => search.status === 'complete' && search.search_scope));
    assert.equal(db.prepare(`
      SELECT classification FROM historical_policy_evidence WHERE item_id = ?
    `).get(target.id).classification, 'excluded');
  } finally {
    db.close();
  }
});

test('an incomplete corpus leaves missing evidence pending', async () => {
  const db = openDatabase(':memory:');
  try {
    const target = targetPolicy(db, 'three');
    const result = await runHistoricalEvidenceQueue(db, { maxItems: 1 }, {
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });
    assert.equal(result.completed, 0);
    const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(target.id);
    assert.equal(item.implementation_status, 'pending');
    assert.equal(item.outcome_status, 'pending');
    assert.match(item.last_error, /scan incomplete/);
  } finally {
    db.close();
  }
});
