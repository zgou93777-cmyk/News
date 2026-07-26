'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LIFECYCLE_STATUSES = new Set(['verified', 'not_applicable']);
const EVIDENCE_STATUSES = new Set(['verified', 'not_found', 'not_applicable']);

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

function officialEvidenceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid evidence URL: ${value}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error(`evidence URL must use standard HTTPS: ${value}`);
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== 'gov.cn' && !hostname.endsWith('.gov.cn')) {
    throw new Error(`evidence URL must be an official .gov.cn source: ${value}`);
  }
  url.hash = '';
  return url.href;
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

function validateHistoricalReview(item, input) {
  if (!item || item.item_kind !== 'document') throw new Error('historical review item must be an extracted document');
  if (!['needs_review', 'source_verified', 'lifecycle_verified', 'ready'].includes(item.stage)) {
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
  const input = JSON.parse(fs.readFileSync(path.resolve(options.reviewFile), 'utf8'));
  const review = validateHistoricalReview(item, input);

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
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
      itemId: item.id,
      sourceChecksum: item.checksum,
      review
    }), 'utf8').digest('hex');
    db.exec('BEGIN IMMEDIATE');
    try {
      const version = Number(db.prepare(`
        SELECT coalesce(max(version), 0) + 1 AS version
        FROM historical_analysis_versions WHERE item_id = ?
      `).get(id).version);
      const assessmentId = Number(db.prepare(`
        INSERT INTO historical_analysis_versions (
          item_id, version, input_checksum, review_status, confidence,
          release_eligible, gates_json, analysis_json, methodology
        ) VALUES (?, ?, ?, ?, 0.95, 1, ?, ?, 'human-review-v1')
      `).run(
        id, version, fingerprint, reviewStatus, JSON.stringify(gates), JSON.stringify(assessment)
      ).lastInsertRowid);
      const persistedAnalysis = { ...assessment, assessmentVersionId: assessmentId, assessmentVersion: version };
      db.prepare(`
        UPDATE historical_backfill_items SET
          title = ?, issuer = ?, document_number = ?, published_at = ?, effective_at = ?, repealed_at = ?,
          stage = 'ready', source_status = 'verified', metadata_status = 'verified',
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
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return { status: 'succeeded', dryRun: Boolean(options.dryRun), id, stage: 'ready', reviewedBy: review.reviewedBy };
}

module.exports = { officialEvidenceUrl, runHistoricalReview, validateHistoricalReview };
