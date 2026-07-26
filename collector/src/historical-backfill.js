'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checksumFor } = require('./analysis');
const { decodeEntities, extractDocument, fetchText } = require('./content');

const DEFAULT_CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config', 'historical-sources.json');
const PROCESSABLE_STAGES = Object.freeze(['discovered', 'failed']);

function loadHistoricalSources(filename = DEFAULT_CONFIG_PATH) {
  const sources = JSON.parse(fs.readFileSync(path.resolve(filename), 'utf8'));
  if (!Array.isArray(sources) || sources.length === 0) throw new Error('historical sources must be a non-empty array');
  return sources;
}

function canonicalOfficialUrl(value, baseUrl, allowedHosts) {
  let url;
  try {
    url = new URL(decodeEntities(String(value || '').replace(/\\\//g, '/')), baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname)) return null;
  url.hash = '';
  return url.href;
}

function historicalYear(...values) {
  for (const value of values) {
    const match = String(value || '').match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function sourceTypeFor(url) {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith('.pdf')) return 'pdf';
  if (pathname.endsWith('.json')) return 'json';
  if (/\.(?:s?html?)$/.test(pathname) || !path.extname(pathname)) return 'html';
  return 'unknown';
}

function itemKindFor(url, title, parentKind = 'index') {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith('.pdf') || /\/issue_\d+\/?$/.test(pathname) || /第\s*\d+\s*号/.test(title)) return 'issue';
  if (parentKind === 'issue') return 'document';
  if (/\/zhengce\/(?:content\/|\d{4}-\d{2}\/\d{2}\/content_)|\/content_\d+\.html?$/.test(pathname)) return 'document';
  return 'index';
}

function discoverHistoricalLinks(raw, baseUrl, options = {}) {
  const allowedHosts = options.allowedHosts || [new URL(baseUrl).hostname];
  const fromYear = options.fromYear || 1949;
  const toYear = options.toYear || new Date().getFullYear();
  const parentYear = options.parentYear || null;
  const parentKind = options.parentKind || 'index';
  const maximum = options.maximum || 100;
  const found = new Map();

  const add = (href, label = '', explicitYear = null) => {
    const url = canonicalOfficialUrl(href, baseUrl, allowedHosts);
    if (!url || url === canonicalOfficialUrl(baseUrl, baseUrl, allowedHosts)) return;
    const year = historicalYear(explicitYear, label, url) || parentYear;
    if (year && (year < fromYear || year > toYear)) return;
    const title = String(label || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const itemKind = itemKindFor(url, title, parentKind);
    if (parentKind === 'issue') {
      const basePath = new URL(baseUrl).pathname;
      const issuePath = basePath.endsWith('/') ? basePath : '';
      const candidatePath = new URL(url).pathname;
      const isIssueArticle = itemKind === 'document' && /\/content_\d+\.html?$/.test(candidatePath);
      const isIssuePdf = itemKind === 'issue' && candidatePath.toLowerCase().endsWith('.pdf');
      const isArchivedIssuePdf = isIssuePdf && year
        && candidatePath.includes(`/gongbao/shuju/${year}/`);
      const belongsToIssueDirectory = issuePath && candidatePath.startsWith(issuePath);
      if ((!belongsToIssueDirectory && !isArchivedIssuePdf) || (!isIssueArticle && !isIssuePdf)) return;
    }
    const candidate = {
      url,
      title,
      sourceYear: year,
      sourceType: sourceTypeFor(url),
      itemKind
    };
    const previous = found.get(url);
    if (!previous || (!previous.title && candidate.title)) found.set(url, candidate);
  };

  for (const match of String(raw || '').matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    add(match[1], decodeEntities(match[2]));
  }

  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw.replace(/^\uFEFF/, '')) : raw;
    const visit = (value, context = '') => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item, context);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const label = value.title || value.TITLE || value.name || value.NAME || value.label || value.issue || context;
      const year = value.year || value.YEAR || historicalYear(label);
      for (const key of ['url', 'URL', 'href', 'link', 'path', 'issueUrl', 'issue_url', 'gname']) {
        if (typeof value[key] === 'string') add(value[key], label, year);
      }
      for (const [key, child] of Object.entries(value)) {
        if (child && typeof child === 'object') visit(child, `${context} ${label} ${key}`.trim());
      }
    };
    visit(parsed);
  } catch {
    // HTML and older navigation scripts are handled by anchor extraction.
  }

  // The official legacy script stores 1954-1999 issue numbers as JSON-compatible rows,
  // then constructs PDF URLs in JavaScript. Parse only those quoted rows; never execute it.
  for (const row of String(raw || '').matchAll(/\[\s*"((?:19)\d{2})"\s*,\s*"--"((?:\s*,\s*"\d+")+?)\s*\]/g)) {
    const year = Number(row[1]);
    for (const issueMatch of row[2].matchAll(/"(\d+)"/g)) {
      const issue = Number(issueMatch[1]);
      add(
        `/gongbao/shuju/${year}/gwyb${year}${String(issue).padStart(2, '0')}.pdf`,
        `${year}年第${issue}号`,
        year
      );
    }
  }

  return [...found.values()]
    .sort((left, right) => (left.sourceYear || 9999) - (right.sourceYear || 9999) || left.url.localeCompare(right.url))
    .slice(0, maximum);
}

function enqueueHistoricalItem(db, item) {
  const result = db.prepare(`
    INSERT INTO historical_backfill_items (
      parent_id, source_url, source_name, source_type, item_kind,
      source_year, issue_label, title
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_url) DO UPDATE SET
      parent_id = coalesce(historical_backfill_items.parent_id, excluded.parent_id),
      source_year = coalesce(historical_backfill_items.source_year, excluded.source_year),
      issue_label = CASE WHEN historical_backfill_items.issue_label = '' THEN excluded.issue_label ELSE historical_backfill_items.issue_label END,
      title = CASE WHEN historical_backfill_items.title = '' THEN excluded.title ELSE historical_backfill_items.title END,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(
    item.parentId || null,
    item.url,
    item.sourceName,
    item.sourceType || sourceTypeFor(item.url),
    item.itemKind || 'document',
    item.sourceYear || null,
    item.issueLabel || '',
    item.title || ''
  );
  return result.changes > 0;
}

async function runHistoricalDiscovery(db, options = {}, dependencies = {}) {
  const allSources = loadHistoricalSources(options.historicalSourcesFile);
  const sources = options.historicalSource
    ? allSources.filter((source) => source.id === options.historicalSource)
    : allSources;
  if (!sources.length) throw new Error(`unknown historical source: ${options.historicalSource}`);
  const fromYear = options.fromYear || 1949;
  const toYear = options.toYear || new Date().getFullYear();
  const maximum = options.maxItems || 100;
  const result = { status: 'succeeded', discovered: 0, queued: 0, sources: [], coverageGaps: [], errors: [] };
  let remaining = maximum;

  for (const source of sources) {
    if (remaining <= 0) break;
    if (toYear < source.coverageStartYear || fromYear > (source.coverageEndYear || toYear)) continue;
    result.coverageGaps.push(...source.knownCoverageGaps.filter((gap) => gap.toYear >= fromYear && gap.fromYear <= toYear));
    try {
      const fetched = await (dependencies.fetchText || fetchText)(
        source.navigationUrl,
        dependencies.fetchImpl,
        options.fetchTimeoutMs
      );
      const allCandidates = discoverHistoricalLinks(fetched.body, fetched.finalUrl || source.navigationUrl, {
        allowedHosts: source.allowedHosts,
        fromYear: Math.max(fromYear, source.coverageStartYear),
        toYear: Math.min(toYear, source.coverageEndYear || toYear),
        maximum: 10_000
      });
      const hasQueuedUrl = options.dryRun
        ? null
        : db.prepare('SELECT 1 FROM historical_backfill_items WHERE source_url = ?');
      const unseenCandidates = allCandidates
        .filter((candidate) => !hasQueuedUrl || !hasQueuedUrl.get(candidate.url));
      const candidates = unseenCandidates.slice(0, remaining);
      for (const candidate of candidates) {
        result.discovered += 1;
        if (!options.dryRun && enqueueHistoricalItem(db, {
          ...candidate,
          sourceName: source.name,
          issueLabel: candidate.itemKind === 'issue' ? candidate.title : ''
        })) result.queued += 1;
      }
      const remainingAfterBatch = Math.max(0, unseenCandidates.length - candidates.length);
      result.sources.push({
        id: source.id,
        available: allCandidates.length,
        candidates: candidates.length,
        remainingAfterBatch
      });
      if (!options.dryRun) {
        db.prepare(`
          INSERT INTO historical_source_scans (
            source_id, from_year, to_year, available_items, remaining_items, complete, scanned_at
          ) VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
          ON CONFLICT(source_id, from_year, to_year) DO UPDATE SET
            available_items = excluded.available_items,
            remaining_items = excluded.remaining_items,
            complete = excluded.complete,
            scanned_at = excluded.scanned_at
        `).run(
          source.id,
          Math.max(fromYear, source.coverageStartYear),
          Math.min(toYear, source.coverageEndYear || toYear),
          allCandidates.length,
          remainingAfterBatch,
          remainingAfterBatch === 0 ? 1 : 0
        );
      }
      remaining -= candidates.length;
    } catch (error) {
      result.errors.push({ source: source.id, url: source.navigationUrl, message: error.message });
    }
  }
  if (result.errors.length) result.status = result.discovered ? 'partial' : 'failed';
  return result;
}

function queueItems(db, maximum) {
  const placeholders = PROCESSABLE_STAGES.map(() => '?').join(', ');
  return db.prepare(`
    SELECT * FROM historical_backfill_items
    WHERE stage IN (${placeholders})
      AND (next_attempt_at IS NULL OR next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ORDER BY coalesce(source_year, 9999), id
    LIMIT ?
  `).all(...PROCESSABLE_STAGES, maximum);
}

function currentLoadSnapshot() {
  const cpuCount = Math.max(1, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);
  const totalMemory = Math.max(1, os.totalmem());
  return {
    cpuCount,
    load1: os.loadavg()[0],
    normalizedLoad: os.loadavg()[0] / cpuCount,
    freeMemoryRatio: os.freemem() / totalMemory
  };
}

function adaptiveBatchSize(maximum, minimum, snapshot) {
  const floor = Math.min(maximum, Math.max(1, minimum));
  if (snapshot.normalizedLoad >= 1 || snapshot.freeMemoryRatio < 0.08) return floor;
  if (snapshot.normalizedLoad >= 0.75 || snapshot.freeMemoryRatio < 0.12) {
    return Math.max(floor, Math.ceil(maximum * 0.25));
  }
  if (snapshot.normalizedLoad >= 0.45 || snapshot.freeMemoryRatio < 0.2) {
    return Math.max(floor, Math.ceil(maximum * 0.5));
  }
  return maximum;
}

function updateQueueFailure(db, item, error) {
  const attempts = item.attempts + 1;
  const retryHours = Math.min(168, 2 ** Math.min(attempts, 7));
  db.prepare(`
    UPDATE historical_backfill_items SET
      stage = 'failed', attempts = ?, last_error = ?,
      next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(attempts, String(error.message || error).slice(0, 1000), `+${retryHours} hours`, item.id);
}

function markManualPdf(db, item, contentType) {
  db.prepare(`
    UPDATE historical_backfill_items SET
      stage = 'manual_review', attempts = attempts + 1, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      last_error = ?, next_attempt_at = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(`公报 PDF（${contentType || 'application/pdf'}）需先做版面保真的文本提取或 OCR，再按单篇政策拆分并人工校对。`, item.id);
}

async function processQueueItem(db, item, options, dependencies) {
  if (item.source_type === 'pdf') {
    if (!options.dryRun) markManualPdf(db, item, 'application/pdf');
    return { id: item.id, action: 'manual_pdf_review', url: item.source_url };
  }
  const fetched = await (dependencies.fetchText || fetchText)(item.source_url, dependencies.fetchImpl, options.fetchTimeoutMs);
  const contentType = String(fetched.contentType || '').toLowerCase();
  if (contentType.includes('pdf')) {
    if (!options.dryRun) markManualPdf(db, item, contentType);
    return { id: item.id, action: 'manual_pdf_review', url: item.source_url };
  }

  if (item.item_kind !== 'document') {
    const source = loadHistoricalSources(options.historicalSourcesFile)
      .find((entry) => entry.name === item.source_name);
    const children = discoverHistoricalLinks(fetched.body, fetched.finalUrl || item.source_url, {
      allowedHosts: source?.allowedHosts || [new URL(item.source_url).hostname],
      fromYear: options.fromYear || 1949,
      toYear: options.toYear || new Date().getFullYear(),
      parentYear: item.source_year,
      parentKind: item.item_kind,
      maximum: options.discoveryLimit || 200
    });
    if (!options.dryRun) {
      for (const child of children) enqueueHistoricalItem(db, {
        ...child,
        parentId: item.id,
        sourceName: item.source_name,
        issueLabel: item.item_kind === 'issue' ? item.title || item.issue_label : ''
      });
      db.prepare(`
        UPDATE historical_backfill_items SET
          stage = 'indexed', attempts = attempts + 1, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          last_error = '', next_attempt_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(item.id);
    }
    return { id: item.id, action: 'indexed', children: children.length, url: item.source_url };
  }

  const document = extractDocument(fetched.body, {
    contentType: fetched.contentType,
    url: fetched.finalUrl || item.source_url,
    fallbackTitle: item.title,
    source: {
      name: item.source_name,
      institution: '国务院',
      url: item.source_url
    }
  });
  const checksum = checksumFor(document);
  if (!options.dryRun) {
    db.prepare(`
      UPDATE historical_backfill_items SET
        title = ?, issuer = ?, published_at = ?, content_text = ?, checksum = ?,
        stage = 'needs_review', attempts = attempts + 1,
        fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), last_error = '', next_attempt_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(document.title, document.issuer, document.publishedAt, document.contentText, checksum, item.id);
  }
  return { id: item.id, action: 'extracted_for_review', title: document.title, url: item.source_url };
}

async function runHistoricalQueue(db, options = {}, dependencies = {}) {
  const maximum = options.maxItems || 100;
  const minimum = Math.min(maximum, options.minItems || 5);
  const delayMs = options.delayMs ?? 1500;
  const items = queueItems(db, maximum);
  const readLoad = dependencies.loadSnapshot || currentLoadSnapshot;
  const initialLoad = readLoad();
  const initialCapacity = options.adaptiveLoad
    ? adaptiveBatchSize(maximum, minimum, initialLoad)
    : maximum;
  const result = {
    status: 'succeeded',
    selected: items.length,
    planned: Math.min(items.length, initialCapacity),
    processed: 0,
    adaptiveLoad: Boolean(options.adaptiveLoad),
    load: initialLoad,
    stoppedDueToLoad: false,
    items: [],
    errors: []
  };
  for (let index = 0; index < items.length; index += 1) {
    if (options.adaptiveLoad && index >= minimum) {
      const currentCapacity = adaptiveBatchSize(maximum, minimum, readLoad());
      if (index >= currentCapacity) {
        result.stoppedDueToLoad = true;
        break;
      }
    } else if (index >= initialCapacity) {
      break;
    }
    const item = items[index];
    try {
      result.items.push(await processQueueItem(db, item, options, dependencies));
      result.processed += 1;
    } catch (error) {
      if (!options.dryRun) updateQueueFailure(db, item, error);
      result.errors.push({ id: item.id, url: item.source_url, message: error.message });
    }
    // PDF entries are only moved into the private OCR queue and make no remote request.
    if (delayMs > 0 && item.source_type !== 'pdf' && index < items.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  if (result.errors.length) result.status = result.processed ? 'partial' : 'failed';
  return result;
}

function historicalQueueStats(db) {
  const rows = db.prepare(`
    SELECT stage, COUNT(*) AS count FROM historical_backfill_items GROUP BY stage ORDER BY stage
  `).all();
  return Object.fromEntries(rows.map((row) => [row.stage, Number(row.count)]));
}

function historicalQueueAudit(db, options = {}, dependencies = {}) {
  const maximum = options.maxItems || 100;
  const minimum = Math.min(maximum, options.minItems || 5);
  const snapshot = (dependencies.loadSnapshot || currentLoadSnapshot)();
  const byStage = historicalQueueStats(db);
  const total = Object.values(byStage).reduce((sum, count) => sum + count, 0);
  const recovery = db.prepare(`
    SELECT
      count(*) FILTER (
        WHERE stage = 'discovered'
          OR (stage = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
      ) AS processable_now,
      count(*) FILTER (
        WHERE stage = 'failed' AND next_attempt_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ) AS scheduled_retry,
      count(*) FILTER (
        WHERE stage = 'manual_review' AND source_type = 'pdf'
          AND source_status <> 'rejected' AND (parent_id IS NULL OR item_kind = 'issue')
      ) AS awaiting_pdf_ocr,
      count(*) FILTER (WHERE stage IN ('needs_review', 'source_verified', 'lifecycle_verified')) AS awaiting_verification,
      count(*) FILTER (WHERE stage = 'indexed') AS indexed_containers,
      count(*) FILTER (WHERE stage = 'ready') AS ready_for_release,
      count(*) FILTER (WHERE stage = 'published') AS published
    FROM historical_backfill_items
  `).get();
  const retry = db.prepare(`
    SELECT
      count(*) AS failed,
      coalesce(max(attempts), 0) AS max_attempts,
      min(next_attempt_at) FILTER (WHERE next_attempt_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS next_attempt_at
    FROM historical_backfill_items
    WHERE stage = 'failed'
  `).get();
  const topErrors = db.prepare(`
    SELECT last_error AS message, count(*) AS count
    FROM historical_backfill_items
    WHERE stage = 'failed' AND trim(last_error) <> ''
    GROUP BY last_error
    ORDER BY count(*) DESC, last_error
    LIMIT 5
  `).all();
  const coverage = db.prepare(`
    SELECT min(source_year) AS earliest_year, max(source_year) AS latest_year,
      count(DISTINCT source_year) AS years_represented
    FROM historical_backfill_items
    WHERE source_year IS NOT NULL
  `).get();
  const integrity = db.prepare(`
    SELECT
      count(*) FILTER (WHERE source_year IS NULL) AS missing_source_year,
      count(*) FILTER (
        WHERE item_kind = 'document'
          AND stage NOT IN ('discovered', 'failed')
          AND source_status <> 'rejected' AND metadata_status <> 'rejected'
          AND (trim(title) = '' OR trim(issuer) = '' OR published_at IS NULL)
      ) AS documents_missing_metadata,
      count(*) FILTER (
        WHERE stage IN ('ready', 'published') AND (
          item_kind <> 'document'
          OR source_status <> 'verified'
          OR metadata_status <> 'verified'
          OR lifecycle_status NOT IN ('verified', 'not_applicable')
          OR implementation_status NOT IN ('verified', 'not_found', 'not_applicable')
          OR outcome_status NOT IN ('verified', 'not_found', 'not_applicable')
          OR analysis_status <> 'verified'
          OR trim(title) = '' OR trim(issuer) = '' OR published_at IS NULL
          OR trim(content_text) = '' OR trim(checksum) = ''
          OR json_array_length(evidence_urls_json) = 0
          OR trim(review_notes) = '' OR trim(reviewed_by) = '' OR reviewed_at IS NULL
          OR (source_type = 'pdf' AND NOT EXISTS (
            SELECT 1
            FROM historical_segmentation_submission_items segment_item
            JOIN historical_segmentation_submissions segmentation
              ON segmentation.id = segment_item.submission_id
            WHERE segment_item.item_id = historical_backfill_items.id
              AND segment_item.content_checksum = historical_backfill_items.checksum
              AND segmentation.item_id = historical_backfill_items.parent_id
          ))
          OR (stage = 'published' AND document_id IS NULL)
        )
      ) AS release_guard_violations,
      count(*) FILTER (
        WHERE stage IN ('ready', 'published') AND source_type = 'pdf'
          AND NOT EXISTS (
            SELECT 1
            FROM historical_segmentation_submission_items segment_item
            JOIN historical_segmentation_submissions segmentation
              ON segmentation.id = segment_item.submission_id
            WHERE segment_item.item_id = historical_backfill_items.id
              AND segment_item.content_checksum = historical_backfill_items.checksum
              AND segmentation.item_id = historical_backfill_items.parent_id
          )
      ) AS pdf_segmentation_violations,
      count(*) FILTER (
        WHERE (stage = 'published' AND document_id IS NULL)
          OR (stage <> 'published' AND document_id IS NOT NULL)
      ) AS document_link_violations
    FROM historical_backfill_items
  `).get();
  const orphanedParents = db.prepare(`
    SELECT count(*) AS count
    FROM historical_backfill_items child
    LEFT JOIN historical_backfill_items parent ON parent.id = child.parent_id
    WHERE child.parent_id IS NOT NULL AND parent.id IS NULL
  `).get().count;
  const releaseIntegrity = db.prepare(`
    SELECT
      count(*) FILTER (
        WHERE item.stage = 'ready' AND (
          EXISTS (
            SELECT 1 FROM historical_evidence_searches search
            WHERE search.item_id = item.id
              AND search.corpus_watermark < (SELECT coalesce(max(id), 0) FROM historical_backfill_items)
          )
          OR EXISTS (
            SELECT 1
            FROM historical_policy_evidence evidence
            LEFT JOIN historical_backfill_items source ON source.id = evidence.source_item_id
            WHERE evidence.item_id = item.id AND evidence.classification = 'accepted'
              AND (
                source.id IS NULL OR source.source_status <> 'verified'
                OR source.metadata_status <> 'verified'
                OR source.source_url <> evidence.source_url
                OR source.published_at <> evidence.observed_at
                OR trim(source.checksum) = ''
                OR instr(source.content_text, evidence.evidence_quote) = 0
              )
          )
        )
      ) AS stale_ready_assessments,
      count(*) FILTER (
        WHERE item.stage IN ('ready', 'published') AND EXISTS (
          SELECT 1
          FROM historical_policy_evidence evidence
          LEFT JOIN historical_backfill_items source ON source.id = evidence.source_item_id
          WHERE evidence.item_id = item.id AND evidence.classification = 'accepted'
            AND (
              source.id IS NULL OR source.source_status <> 'verified'
              OR source.metadata_status <> 'verified'
              OR source.source_url <> evidence.source_url
              OR source.published_at <> evidence.observed_at
              OR trim(source.checksum) = ''
              OR instr(source.content_text, evidence.evidence_quote) = 0
            )
        )
      ) AS evidence_source_violations,
      count(*) FILTER (
        WHERE item.stage IN ('ready', 'published') AND NOT EXISTS (
          SELECT 1 FROM historical_analysis_versions assessment
          WHERE assessment.id = CAST(json_extract(item.analysis_json, '$.assessmentVersionId') AS INTEGER)
            AND assessment.item_id = item.id AND assessment.release_eligible = 1
            AND assessment.confidence >= 0.95
            AND assessment.methodology IN ('historical-evidence-gates-v2', 'human-review-v1')
            AND (
              assessment.methodology <> 'human-review-v1'
              OR EXISTS (
                SELECT 1 FROM historical_review_submissions submission
                WHERE submission.item_id = item.id
                  AND submission.assessment_version_id = assessment.id
                  AND submission.source_checksum = item.checksum
                  AND submission.review_checksum = assessment.input_checksum
                  AND submission.reviewed_by = item.reviewed_by
                  AND submission.reviewed_at = item.reviewed_at
              )
            )
            AND assessment.version = CAST(json_extract(item.analysis_json, '$.assessmentVersion') AS INTEGER)
            AND assessment.review_status = json_extract(item.analysis_json, '$.reviewStatus')
            AND assessment.confidence = CAST(json_extract(item.analysis_json, '$.confidence') AS REAL)
            AND assessment.methodology = json_extract(item.analysis_json, '$.methodology')
            AND json_extract(item.analysis_json, '$.gates') = assessment.gates_json
            AND json_array_length(assessment.gates_json) > 0
            AND NOT EXISTS (
              SELECT 1 FROM json_each(assessment.gates_json) gate
              WHERE json_extract(gate.value, '$.passed') IS NOT 1
            )
        )
      ) AS assessment_link_violations,
      count(*) FILTER (
        WHERE item.stage = 'published' AND NOT EXISTS (
          SELECT 1 FROM historical_public_releases release
          WHERE release.item_id = item.id AND release.document_id = item.document_id
            AND release.assessment_version_id = CAST(json_extract(item.analysis_json, '$.assessmentVersionId') AS INTEGER)
        )
      ) AS public_release_violations
    FROM historical_backfill_items item
  `).get();
  const publicDocumentMismatches = db.prepare(`
    SELECT count(*) AS count
    FROM historical_public_releases release
    JOIN historical_backfill_items item ON item.id = release.item_id
    JOIN documents document ON document.id = release.document_id
    WHERE document.original_url <> item.source_url OR document.title <> item.title
      OR document.issuer <> item.issuer OR document.document_number <> item.document_number
      OR document.published_at <> item.published_at OR document.content_text <> item.content_text
      OR document.checksum <> item.checksum
  `).get().count;

  const criticalIntegrityFailures = Number(integrity.release_guard_violations)
    + Number(integrity.document_link_violations)
    + Number(orphanedParents)
    + Number(releaseIntegrity.evidence_source_violations)
    + Number(releaseIntegrity.assessment_link_violations)
    + Number(releaseIntegrity.public_release_violations)
    + Number(publicDocumentMismatches);
  const rollout = db.prepare(`
    SELECT control.mode, control.active_cohort_id, control.changed_by,
      control.change_note, control.changed_at, cohort.status AS cohort_status,
      cohort.target_size, cohort.manifest_checksum,
      (SELECT count(*) FROM historical_release_cohort_items item
        WHERE item.cohort_id = cohort.id) AS cohort_items,
      (SELECT count(*) FROM historical_release_cohort_items item
        JOIN historical_public_releases release
          ON release.item_id = item.item_id AND release.assessment_version_id = item.assessment_version_id
        WHERE item.cohort_id = cohort.id) AS cohort_released
    FROM historical_release_control control
    LEFT JOIN historical_release_cohorts cohort ON cohort.id = control.active_cohort_id
    WHERE control.id = 1
  `).get();

  return {
    status: criticalIntegrityFailures ? 'failed' : 'succeeded',
    generatedAt: new Date().toISOString(),
    total,
    byStage,
    recovery: {
      processableNow: Number(recovery.processable_now),
      scheduledRetry: Number(recovery.scheduled_retry),
      awaitingPdfOcr: Number(recovery.awaiting_pdf_ocr),
      awaitingVerification: Number(recovery.awaiting_verification),
      indexedContainers: Number(recovery.indexed_containers),
      readyForRelease: Number(recovery.ready_for_release),
      published: Number(recovery.published)
    },
    retry: {
      failed: Number(retry.failed),
      maxAttempts: Number(retry.max_attempts),
      nextAttemptAt: retry.next_attempt_at || null,
      topErrors: topErrors.map((row) => ({ message: row.message, count: Number(row.count) }))
    },
    coverage: {
      earliestYear: coverage.earliest_year === null ? null : Number(coverage.earliest_year),
      latestYear: coverage.latest_year === null ? null : Number(coverage.latest_year),
      yearsRepresented: Number(coverage.years_represented)
    },
    rollout: {
      mode: rollout.mode,
      activeCohortId: rollout.active_cohort_id == null ? null : Number(rollout.active_cohort_id),
      cohortStatus: rollout.cohort_status || null,
      targetSize: rollout.target_size == null ? null : Number(rollout.target_size),
      cohortItems: Number(rollout.cohort_items || 0),
      cohortReleased: Number(rollout.cohort_released || 0),
      manifestChecksum: rollout.manifest_checksum || '',
      changedBy: rollout.changed_by,
      changeNote: rollout.change_note,
      changedAt: rollout.changed_at
    },
    integrity: {
      missingSourceYear: Number(integrity.missing_source_year),
      documentsMissingMetadata: Number(integrity.documents_missing_metadata),
      releaseGuardViolations: Number(integrity.release_guard_violations),
      pdfSegmentationViolations: Number(integrity.pdf_segmentation_violations),
      documentLinkViolations: Number(integrity.document_link_violations),
      orphanedParents: Number(orphanedParents),
      staleReadyAssessments: Number(releaseIntegrity.stale_ready_assessments),
      evidenceSourceViolations: Number(releaseIntegrity.evidence_source_violations),
      assessmentLinkViolations: Number(releaseIntegrity.assessment_link_violations),
      publicReleaseViolations: Number(releaseIntegrity.public_release_violations),
      publicDocumentMismatches: Number(publicDocumentMismatches),
      criticalFailures: criticalIntegrityFailures
    },
    capacity: {
      minimum,
      maximum,
      recommended: adaptiveBatchSize(maximum, minimum, snapshot),
      load: snapshot
    }
  };
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  canonicalOfficialUrl,
  discoverHistoricalLinks,
  enqueueHistoricalItem,
  historicalQueueAudit,
  historicalQueueStats,
  adaptiveBatchSize,
  currentLoadSnapshot,
  loadHistoricalSources,
  runHistoricalDiscovery,
  runHistoricalQueue
};
