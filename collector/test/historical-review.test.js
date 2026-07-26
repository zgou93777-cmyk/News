'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openDatabase } = require('../../server/src/db');
const { runHistoricalReview } = require('../src/historical-review');

function checksum(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function insertReviewItem(db, suffix) {
  const title = `Official historical policy review source ${suffix}`;
  const quote = `${title} quote.`;
  const content = `${quote}\nState Council\n1954-01-01\n${'Official policy text. '.repeat(30)}`;
  const sourceUrl = `https://www.gov.cn/gongbao/review-${suffix}.htm`;
  const id = Number(db.prepare(`
    INSERT INTO historical_backfill_items (
      source_url, source_name, source_type, item_kind, source_year,
      title, issuer, published_at, content_text, checksum, stage
    ) VALUES (?, 'Official Gazette', 'html', 'document', 1954,
      ?, 'State Council', '1954-01-01T00:00:00Z', ?, ?, 'manual_review')
  `).run(sourceUrl, title, content, checksum(content)).lastInsertRowid);
  return { id, title, quote, content, sourceUrl };
}

function reviewInput(item) {
  return {
    title: item.title,
    issuer: 'State Council',
    documentNumber: '',
    publishedAt: '1954-01-01T00:00:00Z',
    effectiveAt: null,
    repealedAt: null,
    evidenceUrls: [item.sourceUrl],
    lifecycleStatus: 'not_applicable',
    implementationStatus: 'not_applicable',
    outcomeStatus: 'not_applicable',
    policyCycle: {
      announcedAt: '1954-01-01T00:00:00Z',
      effectiveAt: null,
      endedAt: null,
      assessment: 'The official source was compared with the reviewed transcription.'
    },
    implementationEvidence: [],
    outcomeEvidence: [],
    analysis: {
      summary: 'Human review retained only claims supported by the official source.',
      cycleAssessment: 'Lifecycle applicability was checked against the official source.',
      implementationAssessment: 'Implementation evidence is not applicable to this item.',
      outcomeAssessment: 'Outcome evidence is not applicable to this item.',
      ambiguities: [],
      evidenceQuotes: [item.quote]
    },
    reviewNotes: 'Compared the queued transcription with the official source.',
    reviewedBy: 'reviewer-1',
    reviewedAt: '2026-07-26T12:00:00Z'
  };
}

test('human review stores one immutable submission and is idempotent', () => {
  const db = openDatabase(':memory:');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-review-'));
  try {
    const item = insertReviewItem(db, 'stored');
    const reviewFile = path.join(directory, 'review.json');
    fs.writeFileSync(reviewFile, JSON.stringify(reviewInput(item), null, 2));

    const first = runHistoricalReview(db, { historicalReview: item.id, reviewFile });
    assert.equal(first.stage, 'ready');
    assert.ok(first.submissionId);
    assert.ok(first.assessmentId);
    assert.equal(first.assessmentVersion, 1);
    assert.match(first.reviewChecksum, /^[a-f0-9]{64}$/);

    const storedItem = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(item.id);
    assert.equal(storedItem.stage, 'ready');
    assert.equal(storedItem.reviewed_by, 'reviewer-1');
    const submission = db.prepare(`
      SELECT * FROM historical_review_submissions WHERE item_id = ?
    `).get(item.id);
    assert.equal(submission.assessment_version_id, first.assessmentId);
    assert.equal(submission.source_checksum, checksum(item.content));
    assert.equal(submission.review_checksum, first.reviewChecksum);
    assert.equal(JSON.parse(submission.review_json).reviewedBy, 'reviewer-1');
    assert.throws(
      () => db.prepare('UPDATE historical_review_submissions SET reviewed_by = ? WHERE id = ?')
        .run('changed', submission.id),
      /immutable/
    );
    assert.throws(
      () => db.prepare('DELETE FROM historical_review_submissions WHERE id = ?').run(submission.id),
      /immutable/
    );

    const repeated = runHistoricalReview(db, { historicalReview: item.id, reviewFile });
    assert.equal(repeated.submissionId, first.submissionId);
    assert.equal(repeated.assessmentId, first.assessmentId);
    assert.equal(db.prepare('SELECT count(*) AS count FROM historical_review_submissions').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM historical_analysis_versions').get().count, 1);
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('ready guard rejects a human assessment without a matching review submission', () => {
  const db = openDatabase(':memory:');
  try {
    const item = insertReviewItem(db, 'forged');
    const gates = [{ name: 'human_review_validation', passed: true, reason: 'forged fixture' }];
    const analysis = {
      reviewStatus: 'watching',
      confidence: 0.95,
      summary: 'Forged summary.',
      cycleAssessment: 'Forged cycle.',
      implementationAssessment: 'Forged implementation.',
      outcomeAssessment: 'Forged outcome.',
      ambiguities: [],
      citations: [{
        kind: 'source', title: item.title, sourceUrl: item.sourceUrl,
        quote: item.quote, observedAt: '1954-01-01T00:00:00Z'
      }],
      evidenceQuotes: [item.quote],
      gates,
      methodology: 'human-review-v1'
    };
    const inputChecksum = checksum(`forged:${item.id}`);
    const assessmentId = Number(db.prepare(`
      INSERT INTO historical_analysis_versions (
        item_id, version, input_checksum, review_status, confidence,
        release_eligible, gates_json, analysis_json, methodology
      ) VALUES (?, 1, ?, 'watching', 0.95, 1, ?, ?, 'human-review-v1')
    `).run(item.id, inputChecksum, JSON.stringify(gates), JSON.stringify(analysis)).lastInsertRowid);
    const persistedAnalysis = JSON.stringify({
      ...analysis,
      assessmentVersionId: assessmentId,
      assessmentVersion: 1
    });

    assert.throws(
      () => db.prepare(`
        UPDATE historical_backfill_items SET
          stage = 'ready', source_status = 'verified', metadata_status = 'verified',
          lifecycle_status = 'not_applicable', implementation_status = 'not_applicable',
          outcome_status = 'not_applicable', analysis_status = 'verified',
          evidence_urls_json = ?, analysis_json = ?, review_notes = 'forged review',
          reviewed_by = 'reviewer-1', reviewed_at = '2026-07-26T12:00:00Z'
        WHERE id = ?
      `).run(JSON.stringify([item.sourceUrl]), persistedAnalysis, item.id),
      /not fully verified/
    );
    assert.equal(db.prepare('SELECT stage FROM historical_backfill_items WHERE id = ?').get(item.id).stage, 'manual_review');
  } finally {
    db.close();
  }
});
