'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openDatabase } = require('../../server/src/db');
const { runHistoricalReview } = require('../src/historical-review');
const { segmentationIssueCandidates } = require('../src/historical-review-export');
const { runHistoricalSegmentationReview } = require('../src/historical-segmentation-review');

function checksum(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function addArtifact(db, cacheDir, itemId, type, storagePath, bytes, pageStart, pageEnd) {
  const filename = path.join(cacheDir, storagePath);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
  db.prepare(`
    INSERT INTO historical_artifacts (
      item_id, artifact_type, storage_path, checksum, byte_size,
      page_start, page_end, engine, engine_version, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'test', '1', '{}')
  `).run(
    itemId, type, storagePath.split(path.sep).join('/'), checksum(bytes), bytes.length,
    pageStart, pageEnd
  );
  return checksum(bytes);
}

function createIssue(db, cacheDir, suffix = 'reviewed') {
  const id = Number(db.prepare(`
    INSERT INTO historical_backfill_items (
      source_url, source_name, source_type, item_kind, source_year, title, stage
    ) VALUES (?, 'Official Gazette', 'pdf', 'issue', 1954, ?, 'manual_review')
  `).run(
    `https://www.gov.cn/gongbao/shuju/1954/${suffix}.pdf`,
    `Official Gazette issue ${suffix}`
  ).lastInsertRowid);
  const pdf = Buffer.from(`%PDF-1.4 ${suffix}`);
  const extraction = Buffer.from(`Complete extraction ${suffix} pages 1 through 4.`);
  return {
    id,
    sourcePdfChecksum: addArtifact(
      db, cacheDir, id, 'source_pdf', path.join(suffix, 'source.pdf'), pdf, 0, 0
    ),
    extractionChecksum: addArtifact(
      db, cacheDir, id, 'ocr_text', path.join(suffix, 'issue.txt'), extraction, 1, 4
    ),
    pdfFilename: path.join(cacheDir, suffix, 'source.pdf')
  };
}

function segment(title, pageStart, pageEnd) {
  return {
    title,
    pageStart,
    pageEnd,
    contentText: `${title}\n${'Verified transcription compared with the official PDF page. '.repeat(8)}`
  };
}

function submission(issue, segments, reviewKind = 'human_verified') {
  return {
    sourcePdfChecksum: issue.sourcePdfChecksum,
    extractionChecksum: issue.extractionChecksum,
    reviewKind,
    reviewedBy: 'reviewer-1',
    reviewedAt: '2026-07-26T12:00:00Z',
    reviewNotes: 'Compared all page boundaries and text against the official PDF.',
    segments
  };
}

function writeJson(directory, name, value) {
  const filename = path.join(directory, name);
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
  return filename;
}

test('PDF segmentation validates artifacts and page ranges before any write', () => {
  const db = openDatabase(':memory:');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-segmentation-validation-'));
  const cacheDir = path.join(root, 'cache');
  try {
    const issue = createIssue(db, cacheDir);
    const valid = submission(issue, [
      segment('First official policy', 1, 2),
      segment('Second official policy', 2, 4)
    ]);
    const validFile = writeJson(root, 'valid.json', valid);
    const dryRun = runHistoricalSegmentationReview(db, {
      historicalPdfSegment: issue.id, segmentsFile: validFile, cacheDir, dryRun: true
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.segmentCount, 2);
    assert.equal(dryRun.reviewKind, 'human_verified');
    assert.equal(db.prepare('SELECT count(*) AS count FROM historical_segmentation_submissions').get().count, 0);

    const wrongChecksum = writeJson(root, 'wrong-checksum.json', {
      ...valid, sourcePdfChecksum: '0'.repeat(64)
    });
    assert.throws(
      () => runHistoricalSegmentationReview(db, {
        historicalPdfSegment: issue.id, segmentsFile: wrongChecksum, cacheDir, dryRun: true
      }),
      /source PDF artifact was not found/
    );
    const wrongExtraction = writeJson(root, 'wrong-extraction.json', {
      ...valid, extractionChecksum: '1'.repeat(64)
    });
    assert.throws(
      () => runHistoricalSegmentationReview(db, {
        historicalPdfSegment: issue.id, segmentsFile: wrongExtraction, cacheDir, dryRun: true
      }),
      /complete text extraction artifact was not found/
    );

    const originalPdf = fs.readFileSync(issue.pdfFilename);
    fs.writeFileSync(issue.pdfFilename, 'corrupted');
    assert.throws(
      () => runHistoricalSegmentationReview(db, {
        historicalPdfSegment: issue.id, segmentsFile: validFile, cacheDir, dryRun: true
      }),
      /checksum or size mismatch/
    );
    fs.writeFileSync(issue.pdfFilename, originalPdf);

    const overlapFile = writeJson(root, 'overlap.json', submission(issue, [
      segment('First official policy', 1, 3),
      segment('Second official policy', 2, 4)
    ]));
    assert.throws(
      () => runHistoricalSegmentationReview(db, {
        historicalPdfSegment: issue.id, segmentsFile: overlapFile, cacheDir, dryRun: true
      }),
      /overlaps/
    );
    const boundsFile = writeJson(root, 'bounds.json', submission(issue, [
      segment('Outside official policy', 1, 5)
    ]));
    assert.throws(
      () => runHistoricalSegmentationReview(db, {
        historicalPdfSegment: issue.id, segmentsFile: boundsFile, cacheDir, dryRun: true
      }),
      /within 1-4/
    );
    const invalidKind = writeJson(root, 'invalid-kind.json', {
      ...valid, reviewKind: 'automated'
    });
    assert.throws(
      () => runHistoricalSegmentationReview(db, {
        historicalPdfSegment: issue.id, segmentsFile: invalidKind, cacheDir, dryRun: true
      }),
      /reviewKind must be ai_assisted or human_verified/
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('PDF segmentation submissions and mappings are immutable and idempotent', () => {
  const db = openDatabase(':memory:');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-segmentation-stored-'));
  const cacheDir = path.join(root, 'cache');
  try {
    const issue = createIssue(db, cacheDir);
    const input = submission(issue, [
      segment('First official policy', 1, 2),
      segment('Second official policy', 2, 4)
    ]);
    const segmentsFile = writeJson(root, 'segments.json', input);
    const first = runHistoricalSegmentationReview(db, {
      historicalPdfSegment: issue.id, segmentsFile, cacheDir
    });
    assert.equal(first.action, 'segmented');
    assert.equal(first.candidates.length, 2);
    assert.equal(db.prepare('SELECT stage FROM historical_backfill_items WHERE id = ?').get(issue.id).stage, 'indexed');
    assert.equal(db.prepare('SELECT count(*) AS count FROM historical_segmentation_submissions').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM historical_segmentation_submission_items').get().count, 2);
    assert.ok(first.candidates.every((candidate) => candidate.title.includes('official policy')));

    const repeated = runHistoricalSegmentationReview(db, {
      historicalPdfSegment: issue.id, segmentsFile, cacheDir
    });
    assert.equal(repeated.action, 'existing_submission');
    assert.equal(repeated.submissionId, first.submissionId);
    assert.deepEqual(repeated.candidates, first.candidates);
    assert.equal(db.prepare('SELECT count(*) AS count FROM historical_segmentation_submissions').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM historical_backfill_items WHERE parent_id = ?').get(issue.id).count, 2);

    const correctedFile = writeJson(root, 'segments-corrected.json', {
      ...input,
      reviewedAt: '2026-07-26T12:05:00Z',
      reviewNotes: 'Second full comparison supersedes the earlier segmentation submission.'
    });
    const corrected = runHistoricalSegmentationReview(db, {
      historicalPdfSegment: issue.id, segmentsFile: correctedFile, cacheDir
    });
    assert.equal(corrected.action, 'segmented');
    assert.notEqual(corrected.submissionId, first.submissionId);
    assert.ok(corrected.candidates.every((candidate, index) => candidate.id !== first.candidates[index].id));
    assert.equal(db.prepare('SELECT count(*) AS count FROM historical_segmentation_submissions').get().count, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM historical_segmentation_submission_items').get().count, 4);
    assert.equal(db.prepare(`
      SELECT count(*) AS count FROM historical_backfill_items
      WHERE parent_id = ? AND source_status = 'rejected'
    `).get(issue.id).count, 2);

    assert.throws(
      () => db.prepare('UPDATE historical_segmentation_submissions SET reviewed_by = ? WHERE id = ?')
        .run('changed', first.submissionId),
      /immutable/
    );
    assert.throws(
      () => db.prepare('DELETE FROM historical_segmentation_submission_items WHERE submission_id = ?')
        .run(first.submissionId),
      /immutable/
    );
    assert.throws(
      () => db.prepare(`
        DELETE FROM historical_artifacts
        WHERE item_id = ? AND artifact_type = 'source_pdf'
      `).run(issue.id),
      /artifacts used.*immutable/
    );
    assert.throws(
      () => db.prepare(`
        UPDATE historical_artifacts SET storage_path = 'changed'
        WHERE item_id = ? AND artifact_type = 'ocr_text'
      `).run(issue.id),
      /artifacts used.*immutable/
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an AI-assisted PDF segmentation remains private until human verification', () => {
  const db = openDatabase(':memory:');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-segmentation-guard-'));
  const cacheDir = path.join(root, 'cache');
  try {
    const issue = createIssue(db, cacheDir, 'automatic');
    const title = 'Automatic OCR policy candidate';
    const segmentsFile = writeJson(root, 'ai-segments.json', submission(issue, [
      segment(title, 1, 2)
    ], 'ai_assisted'));
    const segmented = runHistoricalSegmentationReview(db, {
      historicalPdfSegment: issue.id, segmentsFile, cacheDir
    });
    assert.equal(segmented.reviewKind, 'ai_assisted');
    const candidate = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?')
      .get(segmented.candidates[0].id);
    assert.equal(candidate.stage, 'manual_review');
    assert.match(candidate.last_error, /responsible human verification required/);
    assert.ok(segmentationIssueCandidates(db, 10).some((entry) => entry.id === issue.id));
    const reviewFile = writeJson(root, 'review.json', {
      title,
      issuer: 'State Council',
      documentNumber: '',
      publishedAt: '1954-01-01T00:00:00Z',
      effectiveAt: null,
      repealedAt: null,
      evidenceUrls: [issue.sourceUrl || 'https://www.gov.cn/gongbao/shuju/1954/automatic.pdf'],
      lifecycleStatus: 'not_applicable',
      implementationStatus: 'not_applicable',
      outcomeStatus: 'not_applicable',
      policyCycle: {
        announcedAt: '1954-01-01T00:00:00Z', effectiveAt: null, endedAt: null,
        assessment: 'Compared the transcription against the official source.'
      },
      implementationEvidence: [],
      outcomeEvidence: [],
      analysis: {
        summary: 'Claims are limited to the reviewed official source.',
        cycleAssessment: 'No separate lifecycle claim is applicable.',
        implementationAssessment: 'No implementation claim is applicable.',
        outcomeAssessment: 'No outcome claim is applicable.',
        ambiguities: [],
        evidenceQuotes: [title]
      },
      reviewNotes: 'Reviewed candidate whose segmentation remains AI-assisted.',
      reviewedBy: 'reviewer-1',
      reviewedAt: '2026-07-26T12:00:00Z'
    });
    assert.throws(
      () => runHistoricalReview(db, { historicalReview: candidate.id, reviewFile }),
      /not fully verified/
    );
    assert.equal(db.prepare('SELECT stage FROM historical_backfill_items WHERE id = ?').get(candidate.id).stage, 'manual_review');
    assert.equal(db.prepare('SELECT count(*) AS count FROM historical_review_submissions').get().count, 0);

    const humanFile = writeJson(root, 'human-segments.json', {
      ...JSON.parse(fs.readFileSync(segmentsFile, 'utf8')),
      reviewKind: 'human_verified',
      reviewedBy: 'responsible-reviewer',
      reviewedAt: '2026-07-26T13:00:00Z',
      reviewNotes: 'Responsible reviewer compared every boundary and transcription with the official PDF.'
    });
    const human = runHistoricalSegmentationReview(db, {
      historicalPdfSegment: issue.id, segmentsFile: humanFile, cacheDir
    });
    assert.equal(human.reviewKind, 'human_verified');
    assert.ok(!segmentationIssueCandidates(db, 10).some((entry) => entry.id === issue.id));
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
