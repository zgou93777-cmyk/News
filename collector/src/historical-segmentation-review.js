'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { insertPdfCandidates } = require('./historical-pdf');
const { artifactFilename } = require('./historical-review-export');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requiredText(value, name, maximum = 2000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > maximum) throw new Error(`${name} exceeds ${maximum} characters`);
  return value.trim();
}

function isoDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
  return value;
}

function verifiedArtifact(cacheDir, artifact, name) {
  if (!artifact) throw new Error(`${name} artifact was not found`);
  const filename = artifactFilename(cacheDir, artifact.storage_path);
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) throw new Error(`${name} artifact file is missing`);
  const bytes = fs.readFileSync(filename);
  if (bytes.length !== Number(artifact.byte_size) || sha256(bytes) !== artifact.checksum) {
    throw new Error(`${name} artifact checksum or size mismatch`);
  }
  return artifact;
}

function currentIssueArtifacts(db, issue, input, cacheDir) {
  const sourcePdf = verifiedArtifact(cacheDir, db.prepare(`
    SELECT * FROM historical_artifacts
    WHERE item_id = ? AND artifact_type = 'source_pdf' AND checksum = ?
    ORDER BY id DESC LIMIT 1
  `).get(issue.id, input.sourcePdfChecksum), 'source PDF');
  const extraction = verifiedArtifact(cacheDir, db.prepare(`
    SELECT * FROM historical_artifacts
    WHERE item_id = ? AND artifact_type IN ('ocr_text', 'embedded_text') AND checksum = ?
    ORDER BY id DESC LIMIT 1
  `).get(issue.id, input.extractionChecksum), 'complete text extraction');
  if (Number(extraction.page_start) !== 1 || Number(extraction.page_end) < 1) {
    throw new Error('complete text extraction has no valid page range');
  }
  return { sourcePdf, extraction, pageCount: Number(extraction.page_end) };
}

function validateSegments(value, pageCount) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error('segments must contain from 1 to 100 policies');
  }
  const normalized = value.map((segment, index) => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
      throw new Error(`segments[${index}] must be an object`);
    }
    const title = requiredText(segment.title, `segments[${index}].title`, 500);
    const pageStart = Number(segment.pageStart);
    const pageEnd = Number(segment.pageEnd);
    if (!Number.isSafeInteger(pageStart) || !Number.isSafeInteger(pageEnd)
        || pageStart < 1 || pageEnd < pageStart || pageEnd > pageCount) {
      throw new Error(`segments[${index}] page range must be within 1-${pageCount}`);
    }
    const contentText = requiredText(segment.contentText, `segments[${index}].contentText`, 2_000_000);
    if (contentText.length < 80) throw new Error(`segments[${index}].contentText is too short`);
    const normalizedTitle = title.replace(/\s+/g, '');
    const headingRegion = contentText.slice(0, 2000).replace(/\s+/g, '');
    if (!headingRegion.includes(normalizedTitle)) {
      throw new Error(`segments[${index}].title must occur near the start of contentText`);
    }
    return { title, pageStart, pageEnd, contentText, contentChecksum: sha256(contentText) };
  });
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (current.pageStart < previous.pageEnd) {
      throw new Error(`segments[${index}] overlaps more than a shared boundary page`);
    }
  }
  if (new Set(normalized.map((segment) => segment.contentChecksum)).size !== normalized.length) {
    throw new Error('segments contain duplicate policy text');
  }
  return normalized;
}

function normalizeSegmentationSubmission(issue, input, artifacts) {
  const reviewedBy = requiredText(input.reviewedBy, 'reviewedBy', 200);
  const reviewedAt = isoDate(input.reviewedAt, 'reviewedAt');
  const reviewNotes = requiredText(input.reviewNotes, 'reviewNotes', 5000);
  const segments = validateSegments(input.segments, artifacts.pageCount);
  return {
    issueId: Number(issue.id),
    sourcePdfChecksum: artifacts.sourcePdf.checksum,
    extractionChecksum: artifacts.extraction.checksum,
    pageCount: artifacts.pageCount,
    segments,
    reviewedBy,
    reviewedAt,
    reviewNotes
  };
}

function submissionChecksum(submission) {
  return sha256(JSON.stringify(submission));
}

function runHistoricalSegmentationReview(db, options = {}) {
  const issueId = Number(options.historicalPdfSegment);
  if (!Number.isSafeInteger(issueId) || issueId < 1) {
    throw new Error('--historical-pdf-segment requires a positive issue ID');
  }
  if (!options.segmentsFile) throw new Error('--segments-file is required with --historical-pdf-segment');
  if (!options.cacheDir) throw new Error('historical PDF segmentation review requires the cache directory');
  const issue = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(issueId);
  if (!issue || issue.item_kind !== 'issue' || issue.source_type !== 'pdf'
      || !['manual_review', 'indexed'].includes(issue.stage)) {
    throw new Error('historical PDF segmentation review requires a private PDF issue');
  }
  const input = JSON.parse(fs.readFileSync(path.resolve(options.segmentsFile), 'utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('segments file must contain an object');
  }
  if (!/^[a-f0-9]{64}$/.test(String(input.sourcePdfChecksum || ''))) {
    throw new Error('sourcePdfChecksum must be a SHA-256 checksum');
  }
  if (!/^[a-f0-9]{64}$/.test(String(input.extractionChecksum || ''))) {
    throw new Error('extractionChecksum must be a SHA-256 checksum');
  }
  const artifacts = currentIssueArtifacts(db, issue, input, options.cacheDir);
  const submission = normalizeSegmentationSubmission(issue, input, artifacts);
  const checksum = submissionChecksum(submission);
  if (options.dryRun) {
    return {
      status: 'succeeded',
      dryRun: true,
      issueId,
      pageCount: submission.pageCount,
      segmentCount: submission.segments.length,
      submissionChecksum: checksum
    };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    let stored = db.prepare(`
      SELECT * FROM historical_segmentation_submissions
      WHERE item_id = ? AND submission_checksum = ?
    `).get(issueId, checksum);
    let action = 'existing_submission';
    if (!stored) {
      const submissionJson = JSON.stringify(submission);
      const submissionId = Number(db.prepare(`
        INSERT INTO historical_segmentation_submissions (
          item_id, source_pdf_checksum, extraction_checksum, submission_checksum,
          segments_json, reviewed_by, reviewed_at, review_notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        issueId,
        submission.sourcePdfChecksum,
        submission.extractionChecksum,
        checksum,
        submissionJson,
        submission.reviewedBy,
        submission.reviewedAt,
        submission.reviewNotes
      ).lastInsertRowid);
      stored = db.prepare('SELECT * FROM historical_segmentation_submissions WHERE id = ?').get(submissionId);
      const inserted = insertPdfCandidates(db, issue, submission.segments.map((segment) => ({
        ...segment,
        checksum: segment.contentChecksum
      })), {
        manageTransaction: false,
        candidateTag: submissionId,
        quarantineReason: `superseded by human segmentation submission ${submissionId}`,
        candidateReason: `Human page segmentation verified by ${submission.reviewedBy}; structured policy review required`
      });
      if (inserted.items.length !== submission.segments.length
          || inserted.items.some((item) => item.document_id !== null || item.stage !== 'manual_review')) {
        throw new Error('human segmentation did not create the expected private candidate rows');
      }
      const mapItem = db.prepare(`
        INSERT INTO historical_segmentation_submission_items (
          submission_id, ordinal, item_id, page_start, page_end, content_checksum
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      submission.segments.forEach((segment, index) => mapItem.run(
        submissionId,
        index + 1,
        inserted.items[index].id,
        segment.pageStart,
        segment.pageEnd,
        segment.contentChecksum
      ));
      action = 'segmented';
    }
    const mapped = db.prepare(`
      SELECT item.id, item.title, map.page_start, map.page_end, map.content_checksum
      FROM historical_segmentation_submission_items map
      JOIN historical_backfill_items item ON item.id = map.item_id
      WHERE map.submission_id = ? ORDER BY map.ordinal
    `).all(stored.id);
    if (mapped.length !== submission.segments.length
        || mapped.some((item, index) => (
          item.title !== submission.segments[index].title
          || Number(item.page_start) !== submission.segments[index].pageStart
          || Number(item.page_end) !== submission.segments[index].pageEnd
          || item.content_checksum !== submission.segments[index].contentChecksum
        ))) {
      throw new Error('stored historical segmentation mapping is incomplete');
    }
    db.exec('COMMIT');
    return {
      status: 'succeeded',
      dryRun: false,
      action,
      issueId,
      submissionId: Number(stored.id),
      submissionChecksum: checksum,
      candidates: mapped.map((item) => ({
        id: Number(item.id),
        title: item.title,
        pageStart: Number(item.page_start),
        pageEnd: Number(item.page_end),
        contentChecksum: item.content_checksum
      }))
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = {
  currentIssueArtifacts,
  normalizeSegmentationSubmission,
  runHistoricalSegmentationReview,
  submissionChecksum,
  validateSegments
};
