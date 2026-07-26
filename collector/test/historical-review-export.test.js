'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openDatabase } = require('../../server/src/db');
const { runHistoricalReviewExport } = require('../src/historical-review-export');

function checksum(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function addArtifact(db, cacheDir, itemId, type, storagePath, bytes, pageStart = 0, pageEnd = pageStart) {
  const filename = path.join(cacheDir, storagePath);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, bytes);
  db.prepare(`
    INSERT INTO historical_artifacts (
      item_id, artifact_type, storage_path, checksum, byte_size,
      page_start, page_end, engine, engine_version, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test-1', ?)
  `).run(
    itemId,
    type,
    storagePath.split(path.sep).join('/'),
    checksum(bytes),
    bytes.length,
    pageStart,
    pageEnd,
    type === 'ocr_page' ? 'tesseract' : 'test',
    JSON.stringify({ profile: 'review-export-test' })
  );
}

test('review export copies only checksum-verified evidence needed by selected pages', () => {
  const db = openDatabase(':memory:');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-review-export-'));
  const cacheDir = path.join(root, 'cache');
  const outputDir = path.join(root, 'bundle');
  try {
    const parentId = Number(db.prepare(`
      INSERT INTO historical_backfill_items (
        source_url, source_name, source_type, item_kind, source_year, title, stage
      ) VALUES ('https://www.gov.cn/gongbao/shuju/1954/review.pdf', 'Official Gazette',
        'pdf', 'issue', 1954, '1954 issue', 'indexed')
    `).run().lastInsertRowid);
    const content = 'Reviewed policy title\nOfficial OCR source text for pages two and three.';
    const candidateId = Number(db.prepare(`
      INSERT INTO historical_backfill_items (
        parent_id, source_url, source_name, source_type, item_kind, source_year,
        issue_label, title, content_text, checksum, stage, last_error
      ) VALUES (?, 'https://www.gov.cn/gongbao/shuju/1954/review.pdf#candidate=abc&pages=2-3',
        'Official Gazette', 'pdf', 'document', 1954, '1954 issue', 'Reviewed policy title',
        ?, ?, 'manual_review', 'OCR transcription requires official page comparison')
    `).run(parentId, content, checksum(content)).lastInsertRowid);

    addArtifact(db, cacheDir, parentId, 'source_pdf', path.join('pdf', 'source.pdf'), Buffer.from('%PDF-review'));
    addArtifact(db, cacheDir, parentId, 'ocr_page', path.join('pages', 'page-0002.txt'), Buffer.from('page two'), 2, 2);
    addArtifact(db, cacheDir, parentId, 'ocr_page', path.join('pages', 'page-0003.txt'), Buffer.from('page three'), 3, 3);
    addArtifact(db, cacheDir, parentId, 'ocr_page', path.join('pages', 'page-0004.txt'), Buffer.from('page four'), 4, 4);
    addArtifact(db, cacheDir, parentId, 'ocr_text', path.join('text', 'issue.txt'), Buffer.from('full issue'));

    const unsegmentedId = Number(db.prepare(`
      INSERT INTO historical_backfill_items (
        source_url, source_name, source_type, item_kind, source_year, title, stage
      ) VALUES ('https://www.gov.cn/gongbao/shuju/1955/unsegmented.pdf', 'Official Gazette',
        'pdf', 'issue', 1955, '1955 complete issue', 'manual_review')
    `).run().lastInsertRowid);
    addArtifact(db, cacheDir, unsegmentedId, 'source_pdf',
      path.join('pdf', 'unsegmented.pdf'), Buffer.from('%PDF-unsegmented'));
    addArtifact(db, cacheDir, unsegmentedId, 'ocr_page',
      path.join('pages', 'unsegmented-page-0001.txt'), Buffer.from('complete page one'), 1, 1);
    addArtifact(db, cacheDir, unsegmentedId, 'ocr_page',
      path.join('pages', 'unsegmented-page-0002.txt'), Buffer.from('complete page two'), 2, 2);
    addArtifact(db, cacheDir, unsegmentedId, 'ocr_text',
      path.join('text', 'unsegmented.txt'), Buffer.from('complete extracted issue text'), 1, 2);

    const before = db.prepare('SELECT count(*) AS count FROM historical_backfill_items').get().count;
    const result = runHistoricalReviewExport(db, {
      historicalReviewExport: outputDir,
      cacheDir,
      maxItems: 10
    });
    assert.equal(result.itemCount, 1);
    assert.equal(result.segmentationIssueCount, 1);
    assert.match(result.manifestChecksum, /^[a-f0-9]{64}$/);
    assert.equal(db.prepare('SELECT count(*) AS count FROM historical_backfill_items').get().count, before);

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'manifest.json'), 'utf8'));
    assert.equal(manifest.entries[0].id, candidateId);
    assert.equal(manifest.version, 2);
    assert.equal(manifest.segmentationIssueCount, 1);
    assert.equal(manifest.segmentationIssues[0].id, unsegmentedId);
    assert.deepEqual(manifest.entries[0].pageRange, { start: 2, end: 3 });
    const review = JSON.parse(fs.readFileSync(path.join(outputDir, 'items', String(candidateId), 'review.json'), 'utf8'));
    assert.equal(review._reviewContext.queueItemId, candidateId);
    assert.equal(review._reviewContext.parentIssue.id, parentId);
    assert.deepEqual(review._reviewContext.parentIssue.pageRange, { start: 2, end: 3 });
    assert.deepEqual(
      review._reviewContext.parentIssue.artifacts.filter((artifact) => artifact.type === 'ocr_page')
        .map((artifact) => artifact.pageStart),
      [2, 3]
    );
    assert.ok(review._reviewContext.parentIssue.artifacts.some((artifact) => artifact.type === 'source_pdf'));
    assert.equal(review.evidenceUrls[0], 'https://www.gov.cn/gongbao/shuju/1954/review.pdf');
    assert.equal(
      fs.readFileSync(path.join(outputDir, review._reviewContext.sourceTextFile), 'utf8'),
      content
    );
    const segments = JSON.parse(fs.readFileSync(
      path.join(outputDir, 'issues', String(unsegmentedId), 'segments.json'),
      'utf8'
    ));
    assert.equal(segments._reviewContext.issueId, unsegmentedId);
    assert.equal(segments._reviewContext.pageCount, 2);
    assert.match(segments.sourcePdfChecksum, /^[a-f0-9]{64}$/);
    assert.match(segments.extractionChecksum, /^[a-f0-9]{64}$/);
    assert.deepEqual(segments.segments[0], {
      title: '', pageStart: 1, pageEnd: 2, contentText: ''
    });
    assert.throws(
      () => runHistoricalReviewExport(db, { historicalReviewExport: outputDir, cacheDir, maxItems: 10 }),
      /must be empty/
    );

    fs.writeFileSync(path.join(cacheDir, 'pdf', 'source.pdf'), 'corrupted');
    assert.throws(
      () => runHistoricalReviewExport(db, {
        historicalReviewExport: path.join(root, 'corrupted-bundle'), cacheDir, maxItems: 10
      }),
      /checksum or size mismatch/
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
