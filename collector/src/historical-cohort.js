'use strict';

const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const { currentLoadSnapshot } = require('./historical-backfill');
const { MINIMUM_CONFIDENCE } = require('./historical-analysis');
const { currentAssessment } = require('./historical-release');
const { officialEvidenceUrl } = require('./historical-source');

const REVIEW_STATUSES = new Set(['verified', 'partial', 'ambiguous', 'watching']);

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function rolloutControl(db) {
  return db.prepare(`
    SELECT control.*, cohort.status AS cohort_status, cohort.target_size,
      cohort.manifest_checksum
    FROM historical_release_control control
    LEFT JOIN historical_release_cohorts cohort ON cohort.id = control.active_cohort_id
    WHERE control.id = 1
  `).get();
}

function cohortManifest(entries) {
  return sha256(JSON.stringify(entries.map((entry) => ({
    ordinal: entry.ordinal,
    itemId: entry.itemId,
    assessmentVersionId: entry.assessmentVersionId,
    inputChecksum: entry.inputChecksum
  }))));
}

function officialCitation(citation) {
  try {
    officialEvidenceUrl(citation.sourceUrl);
    return Boolean(citation.quote && String(citation.quote).trim());
  } catch {
    return false;
  }
}

function regressionEntry(db, item, ordinal) {
  const { assessment, analysis, framework } = currentAssessment(db, item);
  const gates = JSON.parse(assessment.gates_json);
  const citations = Array.isArray(analysis.citations) ? analysis.citations : [];
  const searchScopes = Array.isArray(analysis.searchScopes) ? analysis.searchScopes : [];
  const automaticScopesPass = assessment.methodology !== 'historical-evidence-gates-v2'
    || (searchScopes.length === 2 && searchScopes.every((scope) => scope.status === 'complete'
      && scope.searchScope && Number(scope.corpusWatermark) >= 0));
  const humanReviewPass = assessment.methodology !== 'human-review-v1' || Boolean(db.prepare(`
    SELECT 1 FROM historical_review_submissions submission
    WHERE submission.item_id = ? AND submission.assessment_version_id = ?
      AND submission.source_checksum = ? AND submission.review_checksum = ?
      AND submission.reviewed_by = ? AND submission.reviewed_at = ?
  `).get(
    item.id,
    assessment.id,
    item.checksum,
    assessment.input_checksum,
    item.reviewed_by,
    item.reviewed_at
  ));
  const segmentationPass = item.source_type !== 'pdf' || Boolean(db.prepare(`
    SELECT 1
    FROM historical_segmentation_submission_items segment_item
    JOIN historical_segmentation_submissions segmentation
      ON segmentation.id = segment_item.submission_id
    WHERE segment_item.item_id = ? AND segment_item.content_checksum = ?
      AND segmentation.item_id = ?
      AND json_extract(segmentation.segments_json, '$.reviewKind') = 'human_verified'
  `).get(item.id, item.checksum, item.parent_id));
  const frameworkJson = JSON.parse(framework.framework_json);
  const frameworkEvidence = JSON.parse(framework.evidence_json);
  const checks = {
    reviewStatus: REVIEW_STATUSES.has(assessment.review_status),
    confidence: Number(assessment.confidence) >= MINIMUM_CONFIDENCE,
    gates: gates.length > 0 && gates.every((gate) => gate.passed === true),
    citations: citations.length > 0 && citations.every(officialCitation),
    evidenceQuotes: Array.isArray(analysis.evidenceQuotes) && analysis.evidenceQuotes.length > 0,
    searchScopes: automaticScopesPass,
    reviewSubmission: humanReviewPass,
    segmentationSubmission: segmentationPass,
    structuredFramework: frameworkJson.ready === true
      && frameworkEvidence.length > 0
      && Boolean(frameworkJson.problem)
      && Array.isArray(frameworkJson.tools) && frameworkJson.tools.length > 0
      && Array.isArray(frameworkJson.affectedGroups) && frameworkJson.affectedGroups.length > 0
      && Array.isArray(frameworkJson.executionPath) && frameworkJson.executionPath.length > 0,
    privateDocument: item.document_id === null && item.stage === 'ready'
  };
  return {
    ordinal,
    itemId: Number(item.id),
    assessmentVersionId: Number(assessment.id),
    inputChecksum: assessment.input_checksum,
    methodology: assessment.methodology,
    reviewStatus: assessment.review_status,
    confidence: Number(assessment.confidence),
    citationCount: citations.length,
    checks,
    passed: Object.values(checks).every(Boolean)
  };
}

function eligibleReadyItems(db, maximum) {
  return db.prepare(`
    SELECT item.*
    FROM historical_backfill_items item
    WHERE item.item_kind = 'document' AND item.stage = 'ready'
      AND item.analysis_status = 'verified' AND item.document_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM historical_release_cohort_items cohort_item
        WHERE cohort_item.item_id = item.id
      )
    ORDER BY coalesce(item.source_year, 9999), item.id
    LIMIT ?
  `).all(maximum);
}

function auditHistoricalCohort(db, options = {}, dependencies = {}) {
  const targetSize = Number(options.targetSize || options.maxItems || 100);
  if (!Number.isSafeInteger(targetSize) || targetSize < 1 || targetSize > 100) {
    throw new Error('historical cohort target size must be an integer from 1 to 100');
  }
  const existing = db.prepare(`
    SELECT * FROM historical_release_cohorts
    WHERE status IN ('validated', 'approved', 'observing')
    ORDER BY id DESC LIMIT 1
  `).get();
  if (existing) {
    return {
      status: 'succeeded',
      action: 'existing_cohort',
      cohortId: Number(existing.id),
      cohortStatus: existing.status,
      targetSize: Number(existing.target_size),
      control: rolloutControl(db)
    };
  }
  const items = eligibleReadyItems(db, targetSize);
  if (items.length < targetSize) {
    return {
      status: 'succeeded',
      action: 'waiting_for_eligible_items',
      eligible: items.length,
      required: targetSize,
      control: rolloutControl(db)
    };
  }

  const readLoad = dependencies.loadSnapshot || currentLoadSnapshot;
  const loadBefore = readLoad();
  const rssBefore = process.memoryUsage().rss;
  const startedAt = performance.now();
  const entries = items.map((item, index) => regressionEntry(db, item, index + 1));
  const durationMs = Number((performance.now() - startedAt).toFixed(3));
  const rssDeltaBytes = Math.max(0, process.memoryUsage().rss - rssBefore);
  const loadAfter = readLoad();
  const loadChecks = {
    duration: durationMs <= 30_000,
    memory: rssDeltaBytes <= 128 * 1024 * 1024,
    normalizedLoad: Number(loadAfter.normalizedLoad) <= 1,
    freeMemory: Number(loadAfter.freeMemoryRatio) >= 0.15
  };
  const passed = entries.every((entry) => entry.passed) && Object.values(loadChecks).every(Boolean);
  const regression = {
    targetSize,
    passed,
    durationMs,
    rssDeltaBytes,
    loadBefore,
    loadAfter,
    loadChecks,
    byStatus: Object.fromEntries([...REVIEW_STATUSES].map((status) => [
      status,
      entries.filter((entry) => entry.reviewStatus === status).length
    ])),
    failedItems: entries.filter((entry) => !entry.passed).map((entry) => entry.itemId)
  };
  if (!passed) {
    return {
      status: 'succeeded',
      action: 'regression_blocked',
      regression,
      control: rolloutControl(db)
    };
  }

  const manifestChecksum = cohortManifest(entries);
  db.exec('BEGIN IMMEDIATE');
  try {
    const cohortId = Number(db.prepare(`
      INSERT INTO historical_release_cohorts (
        target_size, status, manifest_checksum, regression_json
      ) VALUES (?, 'validated', ?, ?)
    `).run(targetSize, manifestChecksum, JSON.stringify(regression)).lastInsertRowid);
    const insert = db.prepare(`
      INSERT INTO historical_release_cohort_items (
        cohort_id, ordinal, item_id, assessment_version_id, input_checksum, regression_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const entry of entries) insert.run(
      cohortId,
      entry.ordinal,
      entry.itemId,
      entry.assessmentVersionId,
      entry.inputChecksum,
      JSON.stringify(entry)
    );
    db.exec('COMMIT');
    return {
      status: 'succeeded',
      action: 'cohort_validated',
      cohortId,
      manifestChecksum,
      regression,
      control: rolloutControl(db)
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function approveHistoricalCohort(db, options = {}) {
  const cohortId = Number(options.cohortId || options.historicalCohortApprove);
  if (!Number.isSafeInteger(cohortId) || cohortId < 1) throw new Error('cohort approval requires a positive cohort ID');
  const approvedBy = String(options.approvedBy || '').trim();
  const approvalNote = String(options.approvalNote || '').trim();
  if (!approvedBy || !approvalNote) throw new Error('cohort approval requires --approved-by and --approval-note');
  const cohort = db.prepare(`
    SELECT * FROM historical_release_cohorts WHERE id = ? AND status = 'validated'
  `).get(cohortId);
  if (!cohort) throw new Error('validated historical release cohort was not found');
  const rows = db.prepare(`
    SELECT cohort_item.*, item.*
    FROM historical_release_cohort_items cohort_item
    JOIN historical_backfill_items item ON item.id = cohort_item.item_id
    WHERE cohort_item.cohort_id = ? ORDER BY cohort_item.ordinal
  `).all(cohortId);
  if (rows.length !== Number(cohort.target_size)) throw new Error('historical cohort is incomplete');
  const entries = rows.map((row) => {
    const { assessment } = currentAssessment(db, row);
    if (Number(assessment.id) !== Number(row.assessment_version_id)
        || assessment.input_checksum !== row.input_checksum) {
      throw new Error(`historical cohort item ${row.item_id} assessment changed after validation`);
    }
    return {
      ordinal: Number(row.ordinal),
      itemId: Number(row.item_id),
      assessmentVersionId: Number(row.assessment_version_id),
      inputChecksum: row.input_checksum
    };
  });
  if (cohortManifest(entries) !== cohort.manifest_checksum) throw new Error('historical cohort manifest checksum changed');

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE historical_release_cohorts SET
        status = 'approved', approved_by = ?, approval_note = ?,
        approved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(approvedBy, approvalNote, cohortId);
    db.prepare(`
      UPDATE historical_release_control SET
        mode = 'cohort', active_cohort_id = ?, changed_by = ?, change_note = ?,
        changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = 1
    `).run(cohortId, approvedBy, approvalNote);
    db.exec('COMMIT');
    return {
      status: 'succeeded',
      action: 'cohort_approved',
      cohortId,
      targetSize: Number(cohort.target_size),
      manifestChecksum: cohort.manifest_checksum,
      control: rolloutControl(db)
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  approveHistoricalCohort,
  auditHistoricalCohort,
  cohortManifest,
  rolloutControl
};
