'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { officialEvidenceUrl } = require('./historical-source');

const {
  finalizeFramework,
  loadFrameworkEvidence,
  normalizeHistoricalFramework,
  storeFrameworkVersion
} = require('./historical-framework');

const LIFECYCLE_STATUSES = new Set(['verified', 'not_applicable']);
const EVIDENCE_STATUSES = new Set(['verified', 'not_found', 'not_applicable']);

function sourceChecksumMatches(item) {
  const text = String(item.content_text || '');
  if (!item.checksum || !text) return false;
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  return item.checksum === digest(text) || item.checksum === digest(text.replace(/\s+/g, ''));
}

function nonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optionalDate(value, name) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO date or null`);
  }
  return value;
}

function evidenceArray(value, name, status) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const normalized = value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${name}[${index}] must be an object`);
    return {
      ...entry,
      title: nonEmptyString(entry.title, `${name}[${index}].title`),
      sourceUrl: officialEvidenceUrl(nonEmptyString(entry.sourceUrl, `${name}[${index}].sourceUrl`)),
      evidenceQuote: nonEmptyString(entry.evidenceQuote, `${name}[${index}].evidenceQuote`),
      observedAt: optionalDate(entry.observedAt, `${name}[${index}].observedAt`)
    };
  });
  if (status === 'verified' && normalized.length === 0) throw new Error(`${name} requires evidence when status is verified`);
  return normalized;
}

function validateReviewFramework(item, value, analysis, implementationEvidence, outcomeEvidence) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('framework must be an object');
  }
  const sourceUrl = officialEvidenceUrl(item.source_url);
  const sources = [{
    id: `item:${item.id}`,
    itemId: Number(item.id),
    roles: ['current_policy'],
    title: item.title,
    issuer: item.issuer,
    publishedAt: item.published_at,
    sourceUrl,
    checksum: item.checksum,
    text: item.content_text || ''
  }];
  for (const [kind, rows] of [
    ['implementation', implementationEvidence],
    ['outcome', outcomeEvidence]
  ]) rows.forEach((entry, index) => sources.push({
    id: `review:${kind}:${index}`,
    itemId: null,
    roles: [`human_verified_${kind}`],
    title: entry.title,
    issuer: '',
    publishedAt: entry.observedAt,
    sourceUrl: entry.sourceUrl,
    checksum: crypto.createHash('sha256').update(entry.evidenceQuote).digest('hex'),
    text: entry.evidenceQuote
  }));
  const evidenceBundle = {
    sources,
    inputChecksum: item.checksum
  };
  const normalized = normalizeHistoricalFramework(value, evidenceBundle, analysis);
  if (!normalized.framework.ready) {
    throw new Error(`framework is incomplete or has unmatched source quotes: ${normalized.missing.join(', ')}`);
  }
  return value;
}

function validateHistoricalReview(item, input) {
  if (!item || item.item_kind !== 'document') throw new Error('historical review item must be an extracted document');
  if (!['manual_review', 'needs_review', 'source_verified', 'lifecycle_verified', 'ready'].includes(item.stage)) {
    throw new Error(`historical item stage ${item.stage} cannot be reviewed`);
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('review file must contain an object');

  const evidenceUrls = [...new Set((input.evidenceUrls || []).map(officialEvidenceUrl))];
  const sourceUrl = officialEvidenceUrl(item.source_url);
  if (!evidenceUrls.includes(sourceUrl)) throw new Error('evidenceUrls must include the queued official source URL');
  const lifecycleStatus = input.lifecycleStatus;
  const implementationStatus = input.implementationStatus;
  const outcomeStatus = input.outcomeStatus;
  if (!LIFECYCLE_STATUSES.has(lifecycleStatus)) throw new Error('lifecycleStatus must be verified or not_applicable');
  if (!EVIDENCE_STATUSES.has(implementationStatus)) throw new Error('implementationStatus is invalid');
  if (!EVIDENCE_STATUSES.has(outcomeStatus)) throw new Error('outcomeStatus is invalid');

  const policyCycle = input.policyCycle;
  if (!policyCycle || typeof policyCycle !== 'object' || Array.isArray(policyCycle)) throw new Error('policyCycle must be an object');
  policyCycle.assessment = nonEmptyString(policyCycle.assessment, 'policyCycle.assessment');
  for (const name of ['announcedAt', 'effectiveAt', 'endedAt']) policyCycle[name] = optionalDate(policyCycle[name], `policyCycle.${name}`);

  const implementationEvidence = evidenceArray(input.implementationEvidence || [], 'implementationEvidence', implementationStatus);
  const outcomeEvidence = evidenceArray(input.outcomeEvidence || [], 'outcomeEvidence', outcomeStatus);
  const analysis = input.analysis;
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) throw new Error('analysis must be an object');
  for (const name of ['summary', 'cycleAssessment', 'implementationAssessment', 'outcomeAssessment']) {
    analysis[name] = nonEmptyString(analysis[name], `analysis.${name}`);
  }
  if (!Array.isArray(analysis.ambiguities)) throw new Error('analysis.ambiguities must be an array');
  if (!Array.isArray(analysis.evidenceQuotes) || analysis.evidenceQuotes.length === 0) {
    throw new Error('analysis.evidenceQuotes must contain verbatim source evidence');
  }
  analysis.evidenceQuotes = analysis.evidenceQuotes.map((quote, index) => nonEmptyString(quote, `analysis.evidenceQuotes[${index}]`));
  const citations = [
    ...implementationEvidence.map((entry) => ({ kind: 'implementation', ...entry })),
    ...outcomeEvidence.map((entry) => ({ kind: 'outcome', ...entry }))
  ];
  for (const quote of analysis.evidenceQuotes) {
    if (citations.some((entry) => entry.evidenceQuote.includes(quote))) continue;
    if (!String(item.content_text || '').includes(quote)) {
      throw new Error('every analysis evidence quote must match the source text or a structured evidence entry');
    }
    citations.push({
      kind: 'source',
      title: input.title || item.title,
      sourceUrl,
      evidenceQuote: quote,
      observedAt: optionalDate(input.publishedAt || item.published_at, 'publishedAt')
    });
  }
  analysis.citations = citations.map((entry) => ({
    kind: entry.kind,
    title: entry.title,
    sourceUrl: entry.sourceUrl,
    quote: entry.evidenceQuote,
    observedAt: entry.observedAt
  }));
  const framework = validateReviewFramework(
    item, input.framework || analysis.framework, analysis,
    implementationEvidence, outcomeEvidence
  );

  const publishedAt = optionalDate(input.publishedAt || item.published_at, 'publishedAt');
  if (!publishedAt) throw new Error('publishedAt is required');
  return {
    title: nonEmptyString(input.title || item.title, 'title'),
    issuer: nonEmptyString(input.issuer || item.issuer, 'issuer'),
    documentNumber: typeof input.documentNumber === 'string' ? input.documentNumber.trim() : item.document_number,
    publishedAt,
    effectiveAt: optionalDate(input.effectiveAt, 'effectiveAt'),
    repealedAt: optionalDate(input.repealedAt, 'repealedAt'),
    evidenceUrls,
    lifecycleStatus,
    implementationStatus,
    outcomeStatus,
    policyCycle,
    implementationEvidence,
    outcomeEvidence,
    analysis,
    framework,
    reviewNotes: nonEmptyString(input.reviewNotes, 'reviewNotes'),
    reviewedBy: nonEmptyString(input.reviewedBy, 'reviewedBy'),
    reviewedAt: optionalDate(input.reviewedAt || new Date().toISOString(), 'reviewedAt')
  };
}

function runHistoricalReview(db, options = {}) {
  const id = Number(options.historicalReview);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('--historical-review requires a positive queue item ID');
  if (!options.reviewFile) throw new Error('--review-file is required with --historical-review');
  const item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(id);
  if (!item) throw new Error(`historical queue item ${id} was not found`);
  if (!sourceChecksumMatches(item)) throw new Error('historical review source checksum does not match its content');
  const input = JSON.parse(fs.readFileSync(path.resolve(options.reviewFile), 'utf8'));
  const review = validateHistoricalReview(item, input);
  const reviewJson = JSON.stringify(review);
  const reviewChecksum = crypto.createHash('sha256').update(JSON.stringify({
    itemId: item.id,
    sourceChecksum: item.checksum,
    review
  }), 'utf8').digest('hex');
  let assessmentId = null;
  let assessmentVersion = null;
  let submissionId = null;

  if (!options.dryRun) {
    const reviewStatus = review.analysis.ambiguities.length
      ? 'ambiguous'
      : review.implementationStatus === 'verified' && review.outcomeStatus === 'verified'
        ? 'verified'
        : review.implementationStatus === 'verified' || review.outcomeStatus === 'verified'
          ? 'partial'
          : 'watching';
    const gates = [{
      name: 'human_review_validation',
      passed: true,
      reason: `结构化审核文件已由 ${review.reviewedBy} 逐项确认并承担审核责任`
    }];
    const assessment = {
      ...review.analysis,
      reviewStatus,
      confidence: 0.95,
      gates,
      methodology: 'human-review-v1'
    };
    db.exec('BEGIN IMMEDIATE');
    try {
      let storedAssessment = db.prepare(`
        SELECT * FROM historical_analysis_versions WHERE item_id = ? AND input_checksum = ?
      `).get(id, reviewChecksum);
      if (!storedAssessment) {
        const version = Number(db.prepare(`
          SELECT coalesce(max(version), 0) + 1 AS version
          FROM historical_analysis_versions WHERE item_id = ?
        `).get(id).version);
        assessmentId = Number(db.prepare(`
          INSERT INTO historical_analysis_versions (
            item_id, version, input_checksum, review_status, confidence,
            release_eligible, gates_json, analysis_json, methodology
          ) VALUES (?, ?, ?, ?, 0.95, 1, ?, ?, 'human-review-v1')
        `).run(
          id, version, reviewChecksum, reviewStatus, JSON.stringify(gates), JSON.stringify(assessment)
        ).lastInsertRowid);
        storedAssessment = db.prepare('SELECT * FROM historical_analysis_versions WHERE id = ?').get(assessmentId);
      }
      if (storedAssessment.methodology !== 'human-review-v1'
          || storedAssessment.review_status !== reviewStatus
          || Number(storedAssessment.confidence) !== 0.95
          || Number(storedAssessment.release_eligible) !== 1
          || storedAssessment.gates_json !== JSON.stringify(gates)
          || storedAssessment.analysis_json !== JSON.stringify(assessment)) {
        throw new Error('existing historical review assessment does not match the normalized review');
      }
      assessmentId = Number(storedAssessment.id);
      assessmentVersion = Number(storedAssessment.version);
      db.prepare(`
        INSERT INTO historical_review_submissions (
          item_id, assessment_version_id, source_checksum, review_checksum,
          review_json, reviewed_by, reviewed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(item_id, review_checksum) DO NOTHING
      `).run(
        id, assessmentId, item.checksum, reviewChecksum, reviewJson,
        review.reviewedBy, review.reviewedAt
      );
      const submission = db.prepare(`
        SELECT * FROM historical_review_submissions WHERE item_id = ? AND review_checksum = ?
      `).get(id, reviewChecksum);
      if (!submission || Number(submission.assessment_version_id) !== assessmentId
          || submission.source_checksum !== item.checksum
          || submission.review_json !== reviewJson
          || submission.reviewed_by !== review.reviewedBy
          || submission.reviewed_at !== review.reviewedAt) {
        throw new Error('historical review submission does not match the normalized review');
      }
      submissionId = Number(submission.id);
      const persistedAnalysis = {
        ...assessment,
        assessmentVersionId: assessmentId,
        assessmentVersion
      };
      db.prepare(`
        UPDATE historical_backfill_items SET
          title = ?, issuer = ?, document_number = ?, published_at = ?, effective_at = ?, repealed_at = ?,
          stage = 'lifecycle_verified', source_status = 'verified', metadata_status = 'verified',
          lifecycle_status = ?, implementation_status = ?, outcome_status = ?, analysis_status = 'verified',
          evidence_urls_json = ?, policy_cycle_json = ?, implementation_json = ?, outcome_json = ?, analysis_json = ?,
          review_notes = ?, reviewed_by = ?, reviewed_at = ?, last_error = '', next_attempt_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(
        review.title, review.issuer, review.documentNumber, review.publishedAt, review.effectiveAt, review.repealedAt,
        review.lifecycleStatus, review.implementationStatus, review.outcomeStatus,
        JSON.stringify(review.evidenceUrls), JSON.stringify(review.policyCycle), JSON.stringify(review.implementationEvidence),
        JSON.stringify(review.outcomeEvidence), JSON.stringify(persistedAnalysis), review.reviewNotes,
        review.reviewedBy, review.reviewedAt, id
      );
      const updatedItem = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(id);
      const evidenceBundle = loadFrameworkEvidence(db, updatedItem, storedAssessment);
      const normalizedFramework = normalizeHistoricalFramework(
        review.framework, evidenceBundle, JSON.parse(storedAssessment.analysis_json)
      );
      if (!normalizedFramework.framework.ready) {
        throw new Error(`framework became invalid after normalization: ${normalizedFramework.missing.join(', ')}`);
      }
      const storedFramework = storeFrameworkVersion(
        db, updatedItem, storedAssessment, evidenceBundle, normalizedFramework,
        review.framework, `human-review:${review.reviewedBy}`
      );
      finalizeFramework(db, updatedItem, storedAssessment, storedFramework);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return {
    status: 'succeeded',
    dryRun: Boolean(options.dryRun),
    id,
    stage: 'ready',
    reviewedBy: review.reviewedBy,
    reviewChecksum,
    submissionId,
    assessmentId,
    assessmentVersion
  };
}

module.exports = { officialEvidenceUrl, runHistoricalReview, validateHistoricalReview };
