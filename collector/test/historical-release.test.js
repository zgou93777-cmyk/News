'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { openDatabase } = require('../../server/src/db');
const { getArticleDetail, listArticles } = require('../../server/src/repository');
const { inputChecksum, loadAnalysisInputs } = require('../src/historical-analysis');
const { runHistoricalReleaseQueue } = require('../src/historical-release');

function checksum(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function createReadyItem(db, suffix = '21') {
  const title = `国务院历史政策发布测试 ${suffix}`;
  const sourceUrl = `https://www.gov.cn/gongbao/2000/release-${suffix}.htm`;
  const content = `${title}\n国发〔2000〕${suffix}号\n国务院\n2000年1月2日\n${'正式政策原文。'.repeat(40)}`;
  const cycle = {
    announcedAt: '2000-01-02T00:00:00+08:00',
    effectiveAt: '2000-02-01T00:00:00+08:00',
    effectiveStatus: 'verified',
    endedAt: null,
    endedStatus: 'not_found',
    archiveCoverageComplete: true,
    searchScope: 'complete official archive scan'
  };
  const itemId = Number(db.prepare(`
    INSERT INTO historical_backfill_items (
      source_url, source_name, source_type, item_kind, source_year, title, issuer,
      document_number, published_at, effective_at, content_text, checksum, stage,
      source_status, metadata_status, lifecycle_status, implementation_status,
      outcome_status, evidence_urls_json, policy_cycle_json
    ) VALUES (?, '国务院公报', 'html', 'document', 2000, ?, '国务院', ?, ?, ?, ?, ?,
      'lifecycle_verified', 'verified', 'verified', 'verified', 'verified', 'verified', ?, ?)
  `).run(
    sourceUrl, title, `国发〔2000〕${suffix}号`, '2000-01-02T00:00:00+08:00',
    '2000-02-01T00:00:00+08:00', content, checksum(content), JSON.stringify([sourceUrl]), JSON.stringify(cycle)
  ).lastInsertRowid);

  const verification = db.prepare(`
    INSERT INTO historical_verification_evidence (
      item_id, source_item_id, claim_type, status, value_text, evidence_quote,
      source_url, search_scope, extractor, confidence, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'release-test', 1, ?)
  `);
  for (const [claim, value, quote, observedAt] of [
    ['source', sourceUrl, title, null],
    ['title', title, title, null],
    ['issuer', '国务院', '国务院', null],
    ['document_number', `国发〔2000〕${suffix}号`, `国发〔2000〕${suffix}号`, null],
    ['published_at', '2000-01-02T00:00:00+08:00', '2000年1月2日', '2000-01-02T00:00:00+08:00'],
    ['effective_at', '2000-02-01T00:00:00+08:00', '自2000年2月1日起施行', '2000-02-01T00:00:00+08:00']
  ]) verification.run(itemId, itemId, claim, 'verified', value, quote, sourceUrl, '', observedAt);
  verification.run(itemId, null, 'repealed_at', 'not_found', '', '', '', 'complete official archive scan', null);

  const evidenceSources = [
    ['implementation', '历史政策实施办法', '2001-03-01T00:00:00+08:00'],
    ['outcome', '历史政策执行情况报告', '2002-06-01T00:00:00+08:00']
  ];
  for (const [type, evidenceTitle, observedAt] of evidenceSources) {
    const evidenceContent = `${evidenceTitle} 已完成并形成正式记录。`;
    const sourceId = Number(db.prepare(`
      INSERT INTO historical_backfill_items (
        source_url, source_name, source_type, item_kind, source_year, title,
        issuer, published_at, content_text, checksum, stage
      ) VALUES (?, '国务院公报', 'html', 'document', 2001, ?, '国务院', ?, ?, ?, 'needs_review')
    `).run(
      `https://www.gov.cn/gongbao/2001/${type}-${suffix}.htm`, evidenceTitle,
      observedAt, evidenceContent, checksum(evidenceContent)
    ).lastInsertRowid);
    const source = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(sourceId);
    db.prepare(`
      INSERT INTO historical_policy_evidence (
        item_id, source_item_id, evidence_type, classification, title, source_url,
        evidence_quote, observed_at, details_json, extractor, confidence
      ) VALUES (?, ?, ?, 'accepted', ?, ?, ?, ?, ?, 'release-test', 0.99)
    `).run(
      itemId, sourceId, type, evidenceTitle, source.source_url, evidenceContent,
      observedAt, JSON.stringify({ reason: `${type} official evidence` })
    );
  }
  const watermark = Number(db.prepare('SELECT max(id) AS id FROM historical_backfill_items').get().id);
  const search = db.prepare(`
    INSERT INTO historical_evidence_searches (
      item_id, evidence_scope, status, corpus_watermark, candidates_checked,
      accepted_matches, search_scope
    ) VALUES (?, ?, 'complete', ?, 10, 1, 'complete official archive scan')
  `);
  search.run(itemId, 'implementation', watermark);
  search.run(itemId, 'outcome', watermark);

  const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(itemId);
  const inputs = loadAnalysisInputs(db, item);
  const fingerprint = inputChecksum(item, inputs);
  const gates = [{ name: 'release_test', passed: true, reason: 'complete verified fixture' }];
  const analysis = {
    reviewStatus: 'verified',
    confidence: 0.99,
    summary: '已找到明确实施证据和官方结果证据；结果不自动证明政策因果。',
    cycleAssessment: '政策周期已完成官方核验。',
    implementationAssessment: '已找到正式实施办法。',
    outcomeAssessment: '已找到结果导向官方报告。',
    ambiguities: [],
    evidenceQuotes: ['正式政策原文。', '已完成并形成正式记录。'],
    gates,
    methodology: 'historical-evidence-gates-v1'
  };
  const assessmentId = Number(db.prepare(`
    INSERT INTO historical_analysis_versions (
      item_id, version, input_checksum, review_status, confidence,
      release_eligible, gates_json, analysis_json, methodology
    ) VALUES (?, 1, ?, 'verified', 0.99, 1, ?, ?, 'historical-evidence-gates-v1')
  `).run(itemId, fingerprint, JSON.stringify(gates), JSON.stringify(analysis)).lastInsertRowid);
  db.prepare(`
    UPDATE historical_backfill_items SET
      stage = 'ready', analysis_status = 'verified',
      analysis_json = ?, review_notes = 'release test verified review',
      reviewed_by = 'historical-evidence-gates-v1',
      reviewed_at = '2026-07-26T12:00:00+08:00'
    WHERE id = ?
  `).run(JSON.stringify({ ...analysis, assessmentVersionId: assessmentId, assessmentVersion: 1 }), itemId);
  return itemId;
}

test('release worker publishes one traceable article and exposes its four-status classification', async () => {
  const db = openDatabase(':memory:');
  try {
    const itemId = createReadyItem(db);
    const result = await runHistoricalReleaseQueue(db, { maxItems: 1 }, {
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });
    assert.equal(result.published, 1);
    assert.equal(result.items[0].reviewStatus, 'verified');
    const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(itemId);
    assert.equal(item.stage, 'published');
    assert.ok(item.document_id);
    const document = db.prepare('SELECT * FROM documents WHERE id = ?').get(item.document_id);
    assert.equal(document.document_number, '国发〔2000〕21号');
    assert.equal(document.document_date, '2000-01-02');
    assert.equal(document.effective_at, '2000-02-01T00:00:00+08:00');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM historical_public_releases').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM policy_signals').get().count, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM implementation_events').get().count, 3);
    const listed = listArticles(db, { page: 1, pageSize: 10, reviewStatus: 'verified' });
    assert.equal(listed.total, 1);
    assert.equal(listed.articles[0].review.status, 'verified');
    assert.equal(listed.articles[0].review.confidence, '99%');
    const detail = getArticleDetail(db, item.document_id);
    assert.equal(detail.article.review.status, 'verified');
    assert.match(detail.article.review.conclusion, /结果不自动证明政策因果/);

    const second = await runHistoricalReleaseQueue(db, { maxItems: 1 }, {
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });
    assert.equal(second.selected, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 1);
    assert.throws(
      () => db.prepare('DELETE FROM historical_public_releases').run(),
      /cannot be deleted/
    );
  } finally {
    db.close();
  }
});

test('database rejects a forged public mapping before the item can be marked published', () => {
  const db = openDatabase(':memory:');
  try {
    const itemId = createReadyItem(db, '22');
    const sourceId = Number(db.prepare(`
      INSERT INTO sources (name, official_url) VALUES ('forged', 'https://example.gov.cn/')
    `).run().lastInsertRowid);
    const documentId = Number(db.prepare(`
      INSERT INTO documents (
        source_id, title, issuer, category, original_url, published_at, content_text, checksum
      ) VALUES (?, 'forged', 'forged', 'forged', 'https://example.gov.cn/forged',
        '2000-01-01', 'forged', ?)
    `).run(sourceId, checksum('forged')).lastInsertRowid);
    const analysisId = Number(db.prepare(`
      INSERT INTO analysis_versions (
        document_id, version, headline, interpretation, impact, recommendations,
        model_name, status
      ) VALUES (?, 1, 'forged', 'forged', 'forged', 'forged',
        'historical-evidence-gates-v1', 'published')
    `).run(documentId).lastInsertRowid);
    const assessmentId = db.prepare(`
      SELECT id FROM historical_analysis_versions WHERE item_id = ?
    `).get(itemId).id;
    assert.throws(
      () => db.prepare(`
        INSERT INTO historical_public_releases (
          item_id, assessment_version_id, document_id, analysis_version_id, action
        ) VALUES (?, ?, ?, ?, 'linked_existing')
      `).run(itemId, assessmentId, documentId, analysisId),
      /release guard rejected/
    );
    assert.equal(db.prepare('SELECT stage FROM historical_backfill_items WHERE id = ?').get(itemId).stage, 'ready');
  } finally {
    db.close();
  }
});

test('a corpus change after analysis requeues the item instead of publishing stale conclusions', async () => {
  const db = openDatabase(':memory:');
  try {
    const itemId = createReadyItem(db, '23');
    db.prepare(`
      INSERT INTO historical_backfill_items (
        source_url, source_name, item_kind, source_year, stage
      ) VALUES ('https://www.gov.cn/gongbao/2003/new-corpus-item.htm', '国务院公报', 'document', 2003, 'discovered')
    `).run();
    const result = await runHistoricalReleaseQueue(db, { maxItems: 1 }, {
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });
    assert.equal(result.published, 0);
    assert.equal(result.requeued, 1);
    const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(itemId);
    assert.equal(item.stage, 'lifecycle_verified');
    assert.equal(item.analysis_status, 'pending');
    assert.match(item.last_error, /stale/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 0);
  } finally {
    db.close();
  }
});
