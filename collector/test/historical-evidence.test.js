'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { openDatabase } = require('../../server/src/db');
const {
  classifyEvidenceCandidate,
  collectPolicyEvidence,
  evidenceCandidateSearch,
  runHistoricalEvidenceQueue
} = require('../src/historical-evidence');

function insertItem(db, values) {
  return Number(db.prepare(`
    INSERT INTO historical_backfill_items (
      source_url, source_name, source_type, item_kind, source_year, title, issuer,
      document_number, published_at, content_text, stage, source_status,
      metadata_status, lifecycle_status, implementation_status, outcome_status
    ) VALUES (?, 'Official Gazette', 'html', 'document', ?, ?, '国务院', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.url,
    values.year,
    values.title,
    values.documentNumber || '',
    values.publishedAt,
    values.text,
    values.stage || 'needs_review',
    values.sourceStatus || 'verified',
    values.metadataStatus || 'verified',
    values.lifecycleStatus || 'pending',
    values.implementationStatus || 'pending',
    values.outcomeStatus || 'pending'
  ).lastInsertRowid);
}

function markCorpusComplete(db, availableItems = 1) {
  db.prepare(`
    INSERT INTO historical_source_scans (
      source_id, from_year, to_year, available_items, remaining_items, complete
    ) VALUES ('state-council-gazette-modern', 2000, ?, ?, 0, 1)
  `).run(new Date().getFullYear(), availableItems);
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
    markCorpusComplete(db, 4);
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
    markCorpusComplete(db, 2);
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

test('spaced bracket variants retain a strong document-number link', () => {
  const db = openDatabase(':memory:');
  try {
    const target = targetPolicy(db, 'brackets');
    insertItem(db, {
      url: 'https://www.gov.cn/gongbao/2021/bracket-link.htm',
      year: 2021,
      title: '配套实施情况',
      publishedAt: '2021-01-01T00:00:00+08:00',
      text: '依据 国发（ 2020 ） 1 号。有关事项已经启动实施。'
    });
    const search = evidenceCandidateSearch(db, target);
    assert.equal(search.candidates.length, 1);
    assert.ok(classifyEvidenceCandidate(target, search.candidates[0])
      .some((entry) => entry.evidenceType === 'implementation' && entry.classification === 'accepted'));
  } finally {
    db.close();
  }
});

test('unrelated funding elsewhere in a linked document is not attributed to the target', () => {
  const target = { title: '测试政策', document_number: '国发〔2020〕1号' };
  const candidate = {
    title: '综合工作情况',
    content_text: '本文引用国发〔2020〕1号说明制度背景。其他事项另见附件。另一个项目已经下达专项资金100亿元。'
  };
  assert.ok(!classifyEvidenceCandidate(target, candidate)
    .some((entry) => ['funding', 'implementation'].includes(entry.evidenceType)
      && entry.classification === 'accepted'));
});

test('an adjacent target reference and result sentence remain accepted', () => {
  const target = { title: '测试政策', document_number: '国发〔2020〕1号' };
  const candidate = {
    title: '测试政策执行情况报告',
    content_text: '本报告评估国发〔2020〕1号。截至2022年5月，累计完成项目120个，覆盖10万户。'
  };
  assert.ok(classifyEvidenceCandidate(target, candidate)
    .some((entry) => entry.evidenceType === 'outcome' && entry.classification === 'accepted'));
});

test('an unverified matching source keeps evidence search pending', () => {
  const db = openDatabase(':memory:');
  try {
    const target = targetPolicy(db, 'unverified');
    insertItem(db, {
      url: 'https://www.gov.cn/gongbao/2021/unverified.htm',
      year: 2021,
      title: '政策执行情况',
      publishedAt: '2021-01-01T00:00:00+08:00',
      text: `根据${target.document_number}，有关事项已经启动实施。`,
      sourceStatus: 'pending'
    });
    markCorpusComplete(db, 2);
    const result = collectPolicyEvidence(db, target);
    assert.equal(result.complete, false);
    assert.equal(result.implementationStatus, 'pending');
    assert.match(result.searchScope, /source, metadata, and publication date/);
  } finally {
    db.close();
  }
});

test('candidate truncation cannot produce not-found', () => {
  const db = openDatabase(':memory:');
  try {
    const target = targetPolicy(db, 'truncated');
    for (let index = 1; index <= 2; index += 1) {
      insertItem(db, {
        url: `https://www.gov.cn/gongbao/2021/truncated-${index}.htm`,
        year: 2021,
        title: `政策引用${index}`,
        publishedAt: `2021-01-0${index}T00:00:00+08:00`,
        text: `根据${target.document_number}，下一步将研究相关工作。`
      });
    }
    markCorpusComplete(db, 3);
    const result = collectPolicyEvidence(db, target, { candidateLimit: 1 });
    assert.equal(result.complete, false);
    assert.equal(result.implementationStatus, 'pending');
    assert.equal(result.outcomeStatus, 'pending');
    assert.match(result.searchScope, /candidate limit reached/);
  } finally {
    db.close();
  }
});

test('verified evidence remains retryable while archive coverage is incomplete', () => {
  const db = openDatabase(':memory:');
  try {
    const target = targetPolicy(db, 'retryable');
    insertItem(db, {
      url: 'https://www.gov.cn/gongbao/2022/retryable.htm',
      year: 2022,
      title: '历史证据测试政策执行情况报告',
      publishedAt: '2022-06-01T00:00:00+08:00',
      text: `根据${target.document_number}，中央财政已下达专项资金100亿元。截至2022年5月，累计完成项目120个。`
    });
    const result = collectPolicyEvidence(db, target);
    assert.equal(result.implementationStatus, 'verified');
    assert.equal(result.outcomeStatus, 'verified');
    assert.equal(result.complete, false);
    const item = db.prepare('SELECT next_attempt_at FROM historical_backfill_items WHERE id = ?').get(target.id);
    assert.ok(item.next_attempt_at);
    assert.ok(db.prepare(`
      SELECT count(*) AS count FROM historical_evidence_searches
      WHERE item_id = ? AND status = 'incomplete'
    `).get(target.id).count === 2);
  } finally {
    db.close();
  }
});

test('accepted evidence is automatically requeued and withdrawn when its source is later rejected', async () => {
  const db = openDatabase(':memory:');
  try {
    const target = targetPolicy(db, 'withdrawn');
    const sourceId = insertItem(db, {
      url: 'https://www.gov.cn/gongbao/2021/withdrawn.htm',
      year: 2021,
      title: '政策实施情况',
      publishedAt: '2021-01-01T00:00:00+08:00',
      text: `根据${target.document_number}，有关事项已经启动实施。`
    });
    markCorpusComplete(db, 2);
    assert.equal(collectPolicyEvidence(db, target).implementationStatus, 'verified');
    db.prepare("UPDATE historical_backfill_items SET source_status = 'rejected' WHERE id = ?").run(sourceId);
    const rescanned = await runHistoricalEvidenceQueue(db, { maxItems: 1 }, {
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });
    assert.equal(rescanned.selected, 1);
    assert.equal(rescanned.items[0].implementationStatus, 'not_found');
    assert.equal(db.prepare(`
      SELECT classification FROM historical_policy_evidence
      WHERE item_id = ? AND source_item_id = ? AND evidence_type = 'implementation'
    `).get(target.id, sourceId).classification, 'excluded');
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
