'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeAtomic(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, value, { flag: 'wx' });
  fs.renameSync(temporary, filename);
}

function relativeBundlePath(root, filename) {
  return path.relative(root, filename).split(path.sep).join('/');
}

function verifiedSourceText(item) {
  const content = String(item.content_text || '');
  const exact = sha256(content);
  if (exact === item.checksum) return { content, checksumMode: 'exact' };
  if (sha256(content.replace(/\s+/g, '')) === item.checksum) {
    return { content, checksumMode: 'normalized-whitespace' };
  }
  throw new Error(`historical review item ${item.id} source checksum mismatch`);
}

function pageRange(sourceUrl) {
  const url = new URL(sourceUrl);
  const parameters = new URLSearchParams(url.hash.slice(1));
  const match = /^(\d+)-(\d+)$/.exec(parameters.get('pages') || '');
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return start > 0 && end >= start ? { start, end } : null;
}

function officialSourceUrl(sourceUrl) {
  const url = new URL(sourceUrl);
  url.hash = '';
  return url.href;
}

function reviewTemplate(item, context) {
  return {
    _reviewContext: context,
    title: item.title || '',
    issuer: item.issuer || '',
    documentNumber: item.document_number || '',
    publishedAt: item.published_at || null,
    effectiveAt: item.effective_at || null,
    repealedAt: item.repealed_at || null,
    evidenceUrls: [officialSourceUrl(item.source_url)],
    lifecycleStatus: '',
    implementationStatus: '',
    outcomeStatus: '',
    policyCycle: {
      announcedAt: item.published_at || null,
      effectiveAt: item.effective_at || null,
      endedAt: item.repealed_at || null,
      assessment: ''
    },
    implementationEvidence: [],
    outcomeEvidence: [],
    analysis: {
      summary: '',
      cycleAssessment: '',
      implementationAssessment: '',
      outcomeAssessment: '',
      ambiguities: [],
      evidenceQuotes: []
    },
    reviewNotes: '',
    reviewedBy: '',
    reviewedAt: ''
  };
}

function reviewCandidates(db, maximum) {
  return db.prepare(`
    SELECT item.*, parent.source_url AS parent_source_url,
      parent.title AS parent_title, parent.checksum AS parent_checksum,
      parent.stage AS parent_stage
    FROM historical_backfill_items item
    LEFT JOIN historical_backfill_items parent ON parent.id = item.parent_id
    WHERE item.item_kind = 'document'
      AND item.stage IN ('manual_review', 'needs_review', 'source_verified', 'lifecycle_verified')
      AND item.document_id IS NULL
      AND trim(item.content_text) <> '' AND length(item.checksum) = 64
    ORDER BY CASE item.stage
      WHEN 'manual_review' THEN 0
      WHEN 'needs_review' THEN 1
      WHEN 'source_verified' THEN 2
      ELSE 3
    END, coalesce(item.source_year, 9999), item.id
    LIMIT ?
  `).all(maximum);
}

function segmentationIssueCandidates(db, maximum) {
  return db.prepare(`
    SELECT item.*
    FROM historical_backfill_items item
    WHERE item.item_kind = 'issue' AND item.source_type = 'pdf'
      AND item.stage IN ('manual_review', 'indexed')
      AND item.document_id IS NULL
      AND EXISTS (
        SELECT 1 FROM historical_artifacts artifact
        WHERE artifact.item_id = item.id AND artifact.artifact_type = 'source_pdf'
      )
      AND EXISTS (
        SELECT 1 FROM historical_artifacts artifact
        WHERE artifact.item_id = item.id
          AND artifact.artifact_type IN ('ocr_text', 'embedded_text')
          AND artifact.page_start = 1 AND artifact.page_end >= 1
      )
      AND NOT EXISTS (
        SELECT 1 FROM historical_segmentation_submissions submission
        WHERE submission.item_id = item.id
          AND json_extract(submission.segments_json, '$.reviewKind') = 'human_verified'
      )
    ORDER BY coalesce(item.source_year, 9999), item.id
    LIMIT ?
  `).all(maximum);
}

function completeIssueArtifacts(db, issueId) {
  const sourcePdf = db.prepare(`
    SELECT * FROM historical_artifacts
    WHERE item_id = ? AND artifact_type = 'source_pdf'
    ORDER BY id DESC LIMIT 1
  `).get(issueId);
  const extraction = db.prepare(`
    SELECT * FROM historical_artifacts
    WHERE item_id = ? AND artifact_type IN ('ocr_text', 'embedded_text')
      AND page_start = 1 AND page_end >= 1
    ORDER BY id DESC LIMIT 1
  `).get(issueId);
  if (!sourcePdf || !extraction) {
    throw new Error(`PDF review issue ${issueId} has no complete source and extraction artifacts`);
  }
  return { sourcePdf, extraction, pageCount: Number(extraction.page_end) };
}

function segmentationTemplate(issue, artifacts, copiedArtifacts) {
  return {
    _reviewContext: {
      issueId: Number(issue.id),
      title: issue.title || issue.issue_label || '',
      sourceUrl: officialSourceUrl(issue.source_url),
      sourceYear: issue.source_year === null ? null : Number(issue.source_year),
      pageCount: artifacts.pageCount,
      artifacts: copiedArtifacts
    },
    sourcePdfChecksum: artifacts.sourcePdf.checksum,
    extractionChecksum: artifacts.extraction.checksum,
    reviewKind: 'human_verified',
    reviewedBy: '',
    reviewedAt: '',
    reviewNotes: '',
    segments: [{
      title: '',
      pageStart: 1,
      pageEnd: artifacts.pageCount,
      contentText: ''
    }]
  };
}

function artifactFilename(cacheDir, storagePath) {
  const root = path.resolve(cacheDir);
  const filename = path.resolve(root, String(storagePath || ''));
  if (filename === root || !filename.startsWith(`${root}${path.sep}`)) {
    throw new Error(`invalid historical artifact storage path: ${storagePath}`);
  }
  return filename;
}

function selectedArtifacts(db, ownerId, ranges) {
  const artifacts = db.prepare(`
    SELECT * FROM historical_artifacts WHERE item_id = ?
    ORDER BY CASE artifact_type
      WHEN 'source_pdf' THEN 0
      WHEN 'ocr_page' THEN 1
      WHEN 'embedded_text' THEN 2
      WHEN 'ocr_text' THEN 3
      ELSE 4
    END, page_start, id
  `).all(ownerId);
  return artifacts.filter((artifact) => artifact.artifact_type !== 'ocr_page'
    || ranges.some((range) => artifact.page_start >= range.start && artifact.page_start <= range.end));
}

function copyVerifiedArtifact(artifact, cacheDir, outputDir, ownerId) {
  const source = artifactFilename(cacheDir, artifact.storage_path);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`historical artifact ${artifact.id} is missing: ${artifact.storage_path}`);
  }
  const bytes = fs.readFileSync(source);
  if (sha256(bytes) !== artifact.checksum || bytes.length !== Number(artifact.byte_size)) {
    throw new Error(`historical artifact ${artifact.id} checksum or size mismatch`);
  }
  const extension = path.extname(source).replace(/[^.a-z0-9]/gi, '').toLowerCase();
  const page = Number(artifact.page_start) > 0 ? `-page-${String(artifact.page_start).padStart(4, '0')}` : '';
  const destination = path.join(
    outputDir,
    'issues',
    String(ownerId),
    'artifacts',
    `${String(artifact.id).padStart(8, '0')}-${artifact.artifact_type}${page}${extension}`
  );
  writeAtomic(destination, bytes);
  return {
    id: Number(artifact.id),
    type: artifact.artifact_type,
    bundlePath: relativeBundlePath(outputDir, destination),
    checksum: artifact.checksum,
    byteSize: Number(artifact.byte_size),
    pageStart: Number(artifact.page_start),
    pageEnd: Number(artifact.page_end),
    engine: artifact.engine,
    engineVersion: artifact.engine_version,
    metadata: JSON.parse(artifact.metadata_json)
  };
}

function ensureOutputDirectory(outputDir) {
  if (fs.existsSync(outputDir)) {
    if (!fs.statSync(outputDir).isDirectory()) throw new Error('review export path must be a directory');
    if (fs.readdirSync(outputDir).length) throw new Error('review export directory must be empty');
  } else {
    fs.mkdirSync(outputDir, { recursive: true });
  }
}

function runHistoricalReviewExport(db, options = {}) {
  const outputDir = path.resolve(String(options.historicalReviewExport || ''));
  if (!options.historicalReviewExport) throw new Error('--historical-review-export requires an output directory');
  if (!options.cacheDir) throw new Error('historical review export requires the historical cache directory');
  const maximum = Number(options.maxItems || 100);
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100) {
    throw new Error('historical review export max items must be an integer from 1 to 100');
  }
  ensureOutputDirectory(outputDir);
  const items = reviewCandidates(db, maximum);
  const issues = segmentationIssueCandidates(db, maximum);
  const artifactBundles = new Map();
  const rangesByOwner = new Map();
  const issueArtifacts = new Map();
  for (const item of items) {
    if (item.source_type !== 'pdf') continue;
    if (!item.parent_id) throw new Error(`PDF review item ${item.id} has no parent issue`);
    const range = pageRange(item.source_url);
    if (!range) throw new Error(`PDF review item ${item.id} has no valid page range`);
    const ranges = rangesByOwner.get(Number(item.parent_id)) || [];
    ranges.push(range);
    rangesByOwner.set(Number(item.parent_id), ranges);
  }
  for (const issue of issues) {
    const artifacts = completeIssueArtifacts(db, issue.id);
    issueArtifacts.set(Number(issue.id), artifacts);
    rangesByOwner.set(Number(issue.id), [{ start: 1, end: artifacts.pageCount }]);
  }
  for (const [ownerId, ranges] of rangesByOwner) {
    const artifacts = selectedArtifacts(db, ownerId, ranges);
    if (!artifacts.some((artifact) => artifact.artifact_type === 'source_pdf')) {
      throw new Error(`PDF review issue ${ownerId} has no cached source PDF artifact`);
    }
    artifactBundles.set(ownerId, artifacts.map((artifact) => (
      copyVerifiedArtifact(artifact, options.cacheDir, outputDir, ownerId)
    )));
  }

  const entries = items.map((item) => {
    const source = verifiedSourceText(item);
    const itemDirectory = path.join(outputDir, 'items', String(item.id));
    const sourceFilename = path.join(itemDirectory, 'source.txt');
    writeAtomic(sourceFilename, source.content);
    const range = item.source_type === 'pdf' ? pageRange(item.source_url) : null;
    const ownerId = item.source_type === 'pdf' ? Number(item.parent_id) : null;
    const context = {
      queueItemId: Number(item.id),
      sourceType: item.source_type,
      sourceUrl: officialSourceUrl(item.source_url),
      queuedSourceUrl: item.source_url,
      sourceYear: item.source_year === null ? null : Number(item.source_year),
      issueLabel: item.issue_label,
      stage: item.stage,
      sourceStatus: item.source_status,
      metadataStatus: item.metadata_status,
      lastError: item.last_error,
      sourceChecksum: item.checksum,
      checksumMode: source.checksumMode,
      sourceTextFile: relativeBundlePath(outputDir, sourceFilename),
      parentIssue: ownerId ? {
        id: ownerId,
        title: item.parent_title,
        sourceUrl: item.parent_source_url,
        checksum: item.parent_checksum,
        stage: item.parent_stage,
        pageRange: range,
        artifacts: artifactBundles.get(ownerId) || []
      } : null
    };
    const reviewFilename = path.join(itemDirectory, 'review.json');
    writeAtomic(reviewFilename, `${JSON.stringify(reviewTemplate(item, context), null, 2)}\n`);
    return {
      id: Number(item.id),
      title: item.title,
      sourceYear: item.source_year === null ? null : Number(item.source_year),
      stage: item.stage,
      sourceStatus: item.source_status,
      pageRange: range,
      sourceChecksum: item.checksum,
      sourceTextFile: relativeBundlePath(outputDir, sourceFilename),
      reviewFile: relativeBundlePath(outputDir, reviewFilename),
      parentIssueId: ownerId
    };
  });
  const segmentationIssues = issues.map((issue) => {
    const artifacts = issueArtifacts.get(Number(issue.id));
    const templateFilename = path.join(outputDir, 'issues', String(issue.id), 'segments.json');
    writeAtomic(templateFilename, `${JSON.stringify(segmentationTemplate(
      issue,
      artifacts,
      artifactBundles.get(Number(issue.id)) || []
    ), null, 2)}\n`);
    return {
      id: Number(issue.id),
      title: issue.title || issue.issue_label || '',
      sourceYear: issue.source_year === null ? null : Number(issue.source_year),
      stage: issue.stage,
      sourceUrl: officialSourceUrl(issue.source_url),
      pageCount: artifacts.pageCount,
      sourcePdfChecksum: artifacts.sourcePdf.checksum,
      extractionChecksum: artifacts.extraction.checksum,
      segmentsFile: relativeBundlePath(outputDir, templateFilename),
      artifacts: artifactBundles.get(Number(issue.id)) || []
    };
  });
  const snapshot = {
    items: entries.map((entry) => ({
      id: entry.id,
      sourceChecksum: entry.sourceChecksum,
      reviewFile: entry.reviewFile
    })),
    segmentationIssues: segmentationIssues.map((issue) => ({
      id: issue.id,
      sourcePdfChecksum: issue.sourcePdfChecksum,
      extractionChecksum: issue.extractionChecksum,
      segmentsFile: issue.segmentsFile
    }))
  };
  const manifest = {
    version: 2,
    generatedAt: new Date().toISOString(),
    itemCount: entries.length,
    segmentationIssueCount: segmentationIssues.length,
    manifestChecksum: sha256(JSON.stringify(snapshot)),
    entries,
    segmentationIssues
  };
  const manifestFilename = path.join(outputDir, 'manifest.json');
  writeAtomic(manifestFilename, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    status: 'succeeded',
    outputDir,
    itemCount: entries.length,
    segmentationIssueCount: segmentationIssues.length,
    manifestChecksum: manifest.manifestChecksum,
    manifestFile: manifestFilename
  };
}

module.exports = {
  artifactFilename,
  pageRange,
  reviewCandidates,
  reviewTemplate,
  segmentationIssueCandidates,
  segmentationTemplate,
  runHistoricalReviewExport,
  verifiedSourceText
};
