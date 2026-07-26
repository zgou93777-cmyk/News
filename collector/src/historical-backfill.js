'use strict';

const fs = require('node:fs');
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
      result.sources.push({
        id: source.id,
        available: allCandidates.length,
        candidates: candidates.length,
        remainingAfterBatch: Math.max(0, unseenCandidates.length - candidates.length)
      });
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

function updateQueueFailure(db, item, error) {
  const attempts = item.attempts + 1;
  const retryHours = Math.min(168, 2 ** Math.min(attempts, 7));
  db.prepare(`
    UPDATE historical_backfill_items SET
      stage = 'failed', attempts = ?, last_error = ?,
      next_attempt_at = datetime('now', ?),
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
  const fetched = await (dependencies.fetchText || fetchText)(item.source_url, dependencies.fetchImpl, options.fetchTimeoutMs);
  const contentType = String(fetched.contentType || '').toLowerCase();
  if (item.source_type === 'pdf' || contentType.includes('pdf')) {
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
  const maximum = options.maxItems || 2;
  const delayMs = options.delayMs ?? 1500;
  const items = queueItems(db, maximum);
  const result = { status: 'succeeded', selected: items.length, processed: 0, items: [], errors: [] };
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    try {
      result.items.push(await processQueueItem(db, item, options, dependencies));
      result.processed += 1;
    } catch (error) {
      if (!options.dryRun) updateQueueFailure(db, item, error);
      result.errors.push({ id: item.id, url: item.source_url, message: error.message });
    }
    if (delayMs > 0 && index < items.length - 1) {
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

module.exports = {
  DEFAULT_CONFIG_PATH,
  canonicalOfficialUrl,
  discoverHistoricalLinks,
  enqueueHistoricalItem,
  historicalQueueStats,
  loadHistoricalSources,
  runHistoricalDiscovery,
  runHistoricalQueue
};
