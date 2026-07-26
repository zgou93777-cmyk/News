'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { openDatabase } = require('../../server/src/db');
const { approveHistoricalCohort, auditHistoricalCohort } = require('../src/historical-cohort');
const { runHistoricalReleaseQueue } = require('../src/historical-release');

function checksum(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createHumanReadyItem(db, suffix) {
  const title = `首批回归政策 ${suffix}`;
  const sourceUrl = `https://www.gov.cn/gongbao/2000/cohort-${suffix}.htm`;
  const quote = `${title}正式原文。`;
  const content = `${quote}\n国务院\n2000年1月2日\n${'政策内容。'.repeat(30)}`;
  const itemId = Number(db.prepare(`
    INSERT INTO historical_backfill_items (
      source_url, source_name, source_type, item_kind, source_year, title, issuer,
      published_at, content_text, checksum, stage, source_status, metadata_status,
      lifecycle_status, implementation_status, outcome_status, evidence_urls_json
    ) VALUES (?, '国务院公报', 'html', 'document', 2000, ?, '国务院',
      '2000-01-02T00:00:00+08:00', ?, ?, 'lifecycle_verified', 'verified', 'verified',
      'not_applicable', 'not_applicable', 'not_applicable', ?)
  `).run(sourceUrl, title, content, checksum(content), JSON.stringify([sourceUrl])).lastInsertRowid);
  const gates = [{ name: 'human_review_validation', passed: true, reason: 'test review' }];
  const analysis = {
    reviewStatus: 'watching',
    confidence: 0.95,
    summary: '人工核验样本，仅用于首批发布门禁回归。',
    cycleAssessment: '人工确认本样本不适用自动生命周期判断。',
    implementationAssessment: '人工确认本样本不适用自动实施判断。',
    outcomeAssessment: '人工确认本样本不适用自动结果判断。',
    ambiguities: [],
    citations: [{
      kind: 'source', title, sourceUrl, quote, observedAt: '2000-01-02T00:00:00+08:00'
    }],
    evidenceQuotes: [quote],
    gates,
    methodology: 'human-review-v1'
  };
  const inputChecksum = checksum(`${itemId}:${content}:human-review-v1`);
  const assessmentId = Number(db.prepare(`
    INSERT INTO historical_analysis_versions (
      item_id, version, input_checksum, review_status, confidence,
      release_eligible, gates_json, analysis_json, methodology
    ) VALUES (?, 1, ?, 'watching', 0.95, 1, ?, ?, 'human-review-v1')
  `).run(itemId, inputChecksum, JSON.stringify(gates), JSON.stringify(analysis)).lastInsertRowid);
  db.prepare(`
    UPDATE historical_backfill_items SET
      stage = 'ready', analysis_status = 'verified', analysis_json = ?,
      review_notes = 'cohort regression fixture', reviewed_by = 'reviewer-1',
      reviewed_at = '2026-07-26T12:00:00+08:00'
    WHERE id = ?
  `).run(JSON.stringify({
    ...analysis,
    assessmentVersionId: assessmentId,
    assessmentVersion: 1
  }), itemId);
  return itemId;
}

const idleLoad = () => ({
  cpuCount: 2,
  load1: 0.1,
  normalizedLoad: 0.05,
  freeMemoryRatio: 0.6
});

test('cohort audit waits for the full target and release stays disabled', async () => {
  const db = openDatabase(':memory:');
  try {
    createHumanReadyItem(db, 'waiting');
    const audit = auditHistoricalCohort(db, { targetSize: 2 }, { loadSnapshot: idleLoad });
    assert.equal(audit.action, 'waiting_for_eligible_items');
    assert.equal(audit.eligible, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM historical_release_cohorts').get().count, 0);
    const release = await runHistoricalReleaseQueue(db, { maxItems: 10 }, { loadSnapshot: idleLoad });
    assert.equal(release.selected, 0);
    assert.equal(release.heldReady, 1);
    assert.equal(release.rollout.mode, 'disabled');
  } finally {
    db.close();
  }
});

test('only an explicitly approved cohort is released and then enters observation', async () => {
  const db = openDatabase(':memory:');
  try {
    const first = createHumanReadyItem(db, 'one');
    const second = createHumanReadyItem(db, 'two');
    const held = createHumanReadyItem(db, 'three');
    const audit = auditHistoricalCohort(db, { targetSize: 2 }, { loadSnapshot: idleLoad });
    assert.equal(audit.action, 'cohort_validated');
    assert.equal(audit.regression.passed, true);
    assert.equal(audit.regression.failedItems.length, 0);
    assert.equal(db.prepare('SELECT mode FROM historical_release_control WHERE id = 1').get().mode, 'disabled');

    const approval = approveHistoricalCohort(db, {
      cohortId: audit.cohortId,
      approvedBy: 'release-reviewer',
      approvalNote: 'two-row regression inspected and approved'
    });
    assert.equal(approval.control.mode, 'cohort');
    const release = await runHistoricalReleaseQueue(db, { maxItems: 10 }, { loadSnapshot: idleLoad });
    assert.equal(release.published, 2);
    assert.deepEqual(
      db.prepare("SELECT id FROM historical_backfill_items WHERE stage = 'published' ORDER BY id").all().map((row) => row.id),
      [first, second]
    );
    assert.equal(db.prepare('SELECT stage FROM historical_backfill_items WHERE id = ?').get(held).stage, 'ready');
    const control = db.prepare('SELECT * FROM historical_release_control WHERE id = 1').get();
    assert.equal(control.mode, 'disabled');
    assert.equal(db.prepare('SELECT status FROM historical_release_cohorts WHERE id = ?').get(audit.cohortId).status, 'observing');
  } finally {
    db.close();
  }
});

test('cohort approval revalidates immutable assessments and source checksums', () => {
  const db = openDatabase(':memory:');
  try {
    const itemId = createHumanReadyItem(db, 'stale');
    const audit = auditHistoricalCohort(db, { targetSize: 1 }, { loadSnapshot: idleLoad });
    db.prepare("UPDATE historical_backfill_items SET content_text = content_text || 'changed' WHERE id = ?")
      .run(itemId);
    assert.throws(
      () => approveHistoricalCohort(db, {
        cohortId: audit.cohortId,
        approvedBy: 'release-reviewer',
        approvalNote: 'must fail after source change'
      }),
      /checksum/
    );
    assert.equal(db.prepare('SELECT status FROM historical_release_cohorts WHERE id = ?').get(audit.cohortId).status, 'validated');
    assert.equal(db.prepare('SELECT mode FROM historical_release_control WHERE id = 1').get().mode, 'disabled');
  } finally {
    db.close();
  }
});

test('cohort validation is blocked when the load acceptance envelope fails', () => {
  const db = openDatabase(':memory:');
  try {
    createHumanReadyItem(db, 'load');
    let reads = 0;
    const audit = auditHistoricalCohort(db, { targetSize: 1 }, {
      loadSnapshot: () => (++reads === 1 ? idleLoad() : {
        cpuCount: 2, load1: 2.4, normalizedLoad: 1.2, freeMemoryRatio: 0.6
      })
    });
    assert.equal(audit.action, 'regression_blocked');
    assert.equal(audit.regression.loadChecks.normalizedLoad, false);
    assert.equal(db.prepare('SELECT count(*) AS count FROM historical_release_cohorts').get().count, 0);
  } finally {
    db.close();
  }
});

test('one hundred ready assessments stay inside the cohort load envelope', () => {
  const db = openDatabase(':memory:');
  try {
    for (let index = 1; index <= 100; index += 1) {
      createHumanReadyItem(db, `load-${String(index).padStart(3, '0')}`);
    }
    const audit = auditHistoricalCohort(db, { targetSize: 100 }, { loadSnapshot: idleLoad });
    assert.equal(audit.action, 'cohort_validated');
    assert.equal(audit.regression.targetSize, 100);
    assert.equal(audit.regression.passed, true);
    assert.ok(audit.regression.durationMs <= 30_000);
    assert.ok(audit.regression.rssDeltaBytes <= 128 * 1024 * 1024);
    assert.equal(db.prepare(`
      SELECT count(*) AS count FROM historical_release_cohort_items WHERE cohort_id = ?
    `).get(audit.cohortId).count, 100);
    assert.equal(db.prepare('SELECT mode FROM historical_release_control WHERE id = 1').get().mode, 'disabled');
  } finally {
    db.close();
  }
});
