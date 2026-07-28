'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { openDatabase } = require('../../server/src/db');
const {
  assessHistoricalPolicy,
  reviewStatusFor,
  runHistoricalAnalysisQueue
} = require('../src/historical-analysis');

function checksum(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function insertTarget(db, suffix, statuses = {}) {
  const text = `国务院历史政策自动分析测试 ${suffix}\n国务院\n2000年1月2日\n${'正式政策原文内容。'.repeat(30)}`;
  const sourceUrl = `https://www.gov.cn/gongbao/2000/target-${suffix}.htm`;
  const policyCycle = {
    announcedAt: '2000-01-02T00:00:00+08:00',
    effectiveAt: '2000-02-01T00:00:00+08:00',
    effectiveStatus: 'verified',
    endedAt: null,
    endedStatus: 'not_found',
    archiveCoverageComplete: true,
    searchScope: 'complete official archive scan'
  };
  const id = Number(db.prepare(`
    INSERT INTO historical_backfill_items (
      source_url, source_name, source_type, item_kind, source_year, title, issuer,
      document_number, published_at, effective_at, content_text, checksum, stage,
      source_status, metadata_status, lifecycle_status, implementation_status,
      outcome_status, evidence_urls_json, policy_cycle_json
    ) VALUES (?, 'Official Gazette', 'html', 'document', 2000, ?, '国务院', ?, ?, ?, ?, ?,
      'lifecycle_verified', 'verified', 'verified', 'verified', ?, ?, ?, ?)
  `).run(
    sourceUrl,
    `国务院历史政策自动分析测试 ${suffix}`,
    `国发〔2000〕${suffix}号`,
    '2000-01-02T00:00:00+08:00',
    '2000-02-01T00:00:00+08:00',
    text,
    checksum(text),
    statuses.implementation || 'verified',
    statuses.outcome || 'verified',
    JSON.stringify([sourceUrl]),
    JSON.stringify(policyCycle)
  ).lastInsertRowid);
  const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(id);
  const insert = db.prepare(`
    INSERT INTO historical_verification_evidence (
      item_id, source_item_id, claim_type, status, value_text, evidence_quote,
      source_url, search_scope, extractor, confidence, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test-verifier', 1, ?)
  `);
  for (const [claimType, value, quote, observedAt] of [
    ['source', sourceUrl, item.title, null],
    ['title', item.title, item.title, null],
    ['issuer', item.issuer, '国务院', null],
    ['document_number', item.document_number, item.document_number, null],
    ['published_at', item.published_at, '2000年1月2日', item.published_at],
    ['effective_at', item.effective_at, '自2000年2月1日起施行', item.effective_at]
  ]) insert.run(id, id, claimType, 'verified', value, quote, sourceUrl, '', observedAt);
  insert.run(id, null, 'repealed_at', 'not_found', '', '', '', 'complete official archive scan', null);
  return id;
}

function insertSourceItem(db, suffix, title, publishedAt) {
  const content = `${title} 已完成 正文`;
  return Number(db.prepare(`
    INSERT INTO historical_backfill_items (
      source_url, source_name, source_type, item_kind, source_year, title, issuer,
      published_at, content_text, checksum, stage, source_status, metadata_status
    ) VALUES (?, 'Official Gazette', 'html', 'document', 2001, ?, '国务院', ?, ?, ?,
      'needs_review', 'verified', 'verified')
  `).run(
    `https://www.gov.cn/gongbao/2001/evidence-${suffix}.htm`, title, publishedAt,
    content, checksum(content)
  ).lastInsertRowid);
}

function insertPolicyEvidence(db, targetId, sourceId, type, confidence = 0.99) {
  const source = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(sourceId);
  db.prepare(`
    INSERT INTO historical_policy_evidence (
      item_id, source_item_id, evidence_type, classification, title, source_url,
      evidence_quote, observed_at, details_json, extractor, confidence
    ) VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?, '{}', 'test-evidence', ?)
  `).run(targetId, sourceId, type, source.title, source.source_url, `${source.title} 已完成`, source.published_at, confidence);
}

function insertSearches(db, targetId, watermark, statuses = {}) {
  const insert = db.prepare(`
    INSERT INTO historical_evidence_searches (
      item_id, evidence_scope, status, corpus_watermark, candidates_checked,
      accepted_matches, search_scope
    ) VALUES (?, ?, 'complete', ?, 10, ?, 'complete official archive scan')
  `);
  insert.run(targetId, 'implementation', watermark, statuses.implementation === 'verified' ? 1 : 0);
  insert.run(targetId, 'outcome', watermark, statuses.outcome === 'verified' ? 1 : 0);
}

test('four-status rules distinguish verified, partial, ambiguous and watching', () => {
  assert.equal(reviewStatusFor({ implementation_status: 'verified', outcome_status: 'verified' }, []), 'verified');
  assert.equal(reviewStatusFor({ implementation_status: 'verified', outcome_status: 'not_found' }, []), 'partial');
  assert.equal(reviewStatusFor({ implementation_status: 'not_found', outcome_status: 'not_found' }, []), 'watching');
  assert.equal(reviewStatusFor(
    { implementation_status: 'verified', outcome_status: 'verified' },
    [{ type: 'conflict' }]
  ), 'ambiguous');
});

test('complete high-confidence evidence creates an immutable assessment awaiting a cited framework', async () => {
  const db = openDatabase(':memory:');
  try {
    const targetId = insertTarget(db, '11');
    const implementationId = insertSourceItem(db, 'implementation', '历史政策实施细则', '2001-03-01T00:00:00+08:00');
    const outcomeId = insertSourceItem(db, 'outcome', '历史政策执行情况报告', '2002-06-01T00:00:00+08:00');
    insertPolicyEvidence(db, targetId, implementationId, 'implementation');
    insertPolicyEvidence(db, targetId, outcomeId, 'outcome');
    const watermark = Number(db.prepare('SELECT max(id) AS id FROM historical_backfill_items').get().id);
    insertSearches(db, targetId, watermark, { implementation: 'verified', outcome: 'verified' });

    const result = await runHistoricalAnalysisQueue(db, { maxItems: 1 }, {
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });
    assert.equal(result.ready, 0);
    assert.equal(result.awaitingFramework, 1);
    assert.equal(result.byStatus.verified, 1);
    const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(targetId);
    assert.equal(item.stage, 'lifecycle_verified');
    assert.equal(item.analysis_status, 'verified');
    const analysis = JSON.parse(item.analysis_json);
    assert.equal(analysis.reviewStatus, 'verified');
    assert.ok(analysis.gates.every((entry) => entry.passed));
    assert.equal(analysis.citations.length, 8);
    assert.equal(analysis.searchScopes.length, 2);
    assert.ok(analysis.citations.every((entry) => entry.quote && entry.sourceUrl));
    assert.match(analysis.summary, /不等于已经证明/);
    const version = db.prepare('SELECT * FROM historical_analysis_versions WHERE item_id = ?').get(targetId);
    assert.equal(version.version, 1);
    assert.equal(version.release_eligible, 1);
    assert.throws(
      () => db.prepare('UPDATE historical_analysis_versions SET confidence = 0.5 WHERE id = ?').run(version.id),
      /immutable/
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 0);
  } finally {
    db.close();
  }
});

test('runtime options cannot lower the confidence floor below 0.95', () => {
  const db = openDatabase(':memory:');
  try {
    const targetId = insertTarget(db, '14');
    const implementationId = insertSourceItem(db, 'low-confidence', '历史政策实施细则', '2001-03-01T00:00:00+08:00');
    const outcomeId = insertSourceItem(db, 'high-confidence', '历史政策执行情况报告', '2002-06-01T00:00:00+08:00');
    insertPolicyEvidence(db, targetId, implementationId, 'implementation', 0.94);
    insertPolicyEvidence(db, targetId, outcomeId, 'outcome', 0.99);
    const watermark = Number(db.prepare('SELECT max(id) AS id FROM historical_backfill_items').get().id);
    insertSearches(db, targetId, watermark, { implementation: 'verified', outcome: 'verified' });
    const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(targetId);
    const assessment = assessHistoricalPolicy(db, item, { minimumConfidence: 0.1 });
    assert.equal(assessment.confidence, 0.94);
    assert.equal(assessment.releaseEligible, false);
    assert.ok(assessment.failedGates.includes('implementation_evidence'));
    assert.ok(assessment.failedGates.includes('minimum_confidence'));
    assert.equal(db.prepare('SELECT stage FROM historical_backfill_items WHERE id = ?').get(targetId).stage, 'lifecycle_verified');
  } finally {
    db.close();
  }
});

test('web publication timestamps do not conflict with policy dates but real policy-date conflicts do', () => {
  const db = openDatabase(':memory:');
  try {
    const targetId = insertTarget(db, 'date-semantics', {
      implementation: 'not_found',
      outcome: 'not_found'
    });
    const watermark = Number(db.prepare('SELECT max(id) AS id FROM historical_backfill_items').get().id);
    insertSearches(db, targetId, watermark);
    const sourceUrl = db.prepare('SELECT source_url FROM historical_backfill_items WHERE id = ?').get(targetId).source_url;
    const insertDate = db.prepare(`
      INSERT INTO historical_verification_evidence (
        item_id, source_item_id, claim_type, status, value_text, evidence_quote,
        source_url, extractor, confidence, observed_at
      ) VALUES (?, ?, 'published_at', 'verified', ?, ?, ?, ?, 1, ?)
    `);
    insertDate.run(
      targetId, targetId, '2000-01-10T00:00:00+08:00',
      'firstpublishedtime: 2000-01-10-10:00:00', sourceUrl,
      'official-html-meta-v1', '2000-01-10T00:00:00+08:00'
    );

    let item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(targetId);
    const accepted = assessHistoricalPolicy(db, item);
    assert.equal(accepted.releaseEligible, true);
    assert.equal(accepted.reviewStatus, 'watching');
    const acceptedAnalysis = JSON.parse(db.prepare(
      'SELECT analysis_json FROM historical_backfill_items WHERE id = ?'
    ).get(targetId).analysis_json);
    assert.ok(acceptedAnalysis.citations.some((entry) => entry.claimType === 'web_published_at'));

    insertDate.run(
      targetId, targetId, '2000-01-03T00:00:00+08:00',
      '国务院 2000年1月3日', sourceUrl,
      'historical-metadata-v2', '2000-01-03T00:00:00+08:00'
    );
    item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(targetId);
    const blocked = assessHistoricalPolicy(db, item);
    assert.equal(blocked.releaseEligible, false);
    assert.ok(blocked.failedGates.includes('critical_conflicts'));
  } finally {
    db.close();
  }
});
test('accepted evidence counts must match the completed search record', () => {
  const db = openDatabase(':memory:');
  try {
    const targetId = insertTarget(db, '15');
    const implementationId = insertSourceItem(db, 'count-implementation', '历史政策实施细则', '2001-03-01T00:00:00+08:00');
    const outcomeId = insertSourceItem(db, 'count-outcome', '历史政策执行情况报告', '2002-06-01T00:00:00+08:00');
    insertPolicyEvidence(db, targetId, implementationId, 'implementation');
    insertPolicyEvidence(db, targetId, outcomeId, 'outcome');
    const watermark = Number(db.prepare('SELECT max(id) AS id FROM historical_backfill_items').get().id);
    insertSearches(db, targetId, watermark, { implementation: 'verified', outcome: 'verified' });
    db.prepare(`
      UPDATE historical_evidence_searches SET accepted_matches = 2
      WHERE item_id = ? AND evidence_scope = 'implementation'
    `).run(targetId);
    const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(targetId);
    const assessment = assessHistoricalPolicy(db, item);
    assert.equal(assessment.releaseEligible, false);
    assert.ok(assessment.failedGates.includes('implementation_evidence'));
  } finally {
    db.close();
  }
});

test('accepted evidence is blocked when its verified source checksum no longer matches', () => {
  const db = openDatabase(':memory:');
  try {
    const targetId = insertTarget(db, '17');
    const implementationId = insertSourceItem(db, 'checksum-implementation', '历史政策实施细则', '2001-03-01T00:00:00+08:00');
    const outcomeId = insertSourceItem(db, 'checksum-outcome', '历史政策执行情况报告', '2002-06-01T00:00:00+08:00');
    insertPolicyEvidence(db, targetId, implementationId, 'implementation');
    insertPolicyEvidence(db, targetId, outcomeId, 'outcome');
    const watermark = Number(db.prepare('SELECT max(id) AS id FROM historical_backfill_items').get().id);
    insertSearches(db, targetId, watermark, { implementation: 'verified', outcome: 'verified' });
    db.prepare("UPDATE historical_backfill_items SET content_text = content_text || '异常改动' WHERE id = ?")
      .run(implementationId);
    const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(targetId);
    const assessment = assessHistoricalPolicy(db, item);
    assert.equal(assessment.releaseEligible, false);
    assert.ok(assessment.failedGates.includes('implementation_evidence'));
  } finally {
    db.close();
  }
});

test('automatic analysis cannot approve not-applicable evidence statuses', () => {
  const db = openDatabase(':memory:');
  try {
    const targetId = insertTarget(db, '16', { implementation: 'not_applicable', outcome: 'not_found' });
    const watermark = Number(db.prepare('SELECT max(id) AS id FROM historical_backfill_items').get().id);
    insertSearches(db, targetId, watermark, { implementation: 'not_applicable', outcome: 'not_found' });
    const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(targetId);
    const assessment = assessHistoricalPolicy(db, item);
    assert.equal(assessment.releaseEligible, false);
    assert.ok(assessment.failedGates.includes('implementation_evidence'));
  } finally {
    db.close();
  }
});

test('partial evidence is classified without overstating an absent outcome', () => {
  const db = openDatabase(':memory:');
  try {
    const targetId = insertTarget(db, '12', { implementation: 'verified', outcome: 'not_found' });
    const implementationId = insertSourceItem(db, 'partial', '历史政策实施办法', '2001-03-01T00:00:00+08:00');
    insertPolicyEvidence(db, targetId, implementationId, 'implementation');
    const watermark = Number(db.prepare('SELECT max(id) AS id FROM historical_backfill_items').get().id);
    insertSearches(db, targetId, watermark, { implementation: 'verified', outcome: 'not_found' });
    const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(targetId);
    const assessment = assessHistoricalPolicy(db, item);
    assert.equal(assessment.reviewStatus, 'partial');
    assert.equal(assessment.releaseEligible, true);
    const stored = db.prepare('SELECT analysis_json FROM historical_analysis_versions WHERE item_id = ?').get(targetId);
    assert.match(JSON.parse(stored.analysis_json).outcomeAssessment, /未找到/);
  } finally {
    db.close();
  }
});

test('stale corpus watermarks and conflicting official values remain private and auditable', () => {
  const db = openDatabase(':memory:');
  try {
    const targetId = insertTarget(db, '13', { implementation: 'not_found', outcome: 'not_found' });
    insertSourceItem(db, 'watermark', '后续官方材料', '2003-01-01T00:00:00+08:00');
    insertSearches(db, targetId, targetId, { implementation: 'not_found', outcome: 'not_found' });
    const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(targetId);
    const stale = assessHistoricalPolicy(db, item);
    assert.equal(stale.reviewStatus, 'watching');
    assert.equal(stale.releaseEligible, false);
    assert.ok(stale.failedGates.includes('implementation_evidence'));
    assert.equal(db.prepare('SELECT stage FROM historical_backfill_items WHERE id = ?').get(targetId).stage, 'lifecycle_verified');

    db.prepare(`
      INSERT INTO historical_verification_evidence (
        item_id, source_item_id, claim_type, status, value_text, evidence_quote,
        source_url, extractor, confidence
      ) VALUES (?, ?, 'issuer', 'verified', '国务院办公厅', '国务院办公厅', ?, 'test-conflict', 1)
    `).run(targetId, targetId, item.source_url);
    const refreshed = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(targetId);
    const conflict = assessHistoricalPolicy(db, refreshed);
    assert.equal(conflict.reviewStatus, 'ambiguous');
    assert.equal(conflict.releaseEligible, false);
    assert.ok(conflict.failedGates.includes('critical_conflicts'));
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM historical_analysis_versions WHERE item_id = ?
    `).get(targetId).count, 2);
  } finally {
    db.close();
  }
});
