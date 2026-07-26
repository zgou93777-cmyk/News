'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { adaptiveBatchSize, currentLoadSnapshot } = require('./historical-backfill');
const {
  abortResponse,
  assertSafeRemoteUrl,
  atomicCacheWrite,
  httpsRequestPinned,
  readLimitedBody,
  resolvePublicAddresses,
  USER_AGENT
} = require('./source-images');

const execFileAsync = promisify(execFile);
const MAX_PDF_BYTES = 80 * 1024 * 1024;
const MAX_PDF_PAGES = 300;
const OCR_PROFILE_VERSION = 'gazette-ocr-v2';
const DEFAULT_OCR_LANGUAGES = 'chi_sim+chi_tra+eng';
const DEFAULT_OCR_DPI = 300;
const DEFAULT_OCR_PSM = 3;
const DEFAULT_OCR_OEM = 1;
const TITLE_ENDINGS = /(?:决定|决议|命令|通知|通告|公告|条例|规定|办法|意见|批复|报告|方案|细则|规则|函)(?:[（(][^）)]{1,40}[）)])?$/u;
const NOMINAL_TITLE_ENDINGS = /(?:条例|规定|办法|细则|规则|章程|纲要|规划)(?:[（(][^）)]{1,40}[）)])?$/u;
const ACTION_TITLE_ENDINGS = /(?:决定|决议|通知|通告|公告|意见|批复|报告|方案|函)(?:[（(][^）)]{1,40}[）)])?$/u;
const DOCUMENT_ANCHOR = /(?:(?:19|20)\d{2}\s*年|[〇零○一二三四五六七八九十]{4}\s*年|〔\s*(?:19|20)\d{2}\s*〕|(?:会议|大会).{0,20}(?:通过|批准)|(?:国务院|政务院|人民代表大会|[\p{Script=Han}]{2,16}(?:部|委员会)).{0,20}(?:制定|批准|通过|公布|发布))/u;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function historicalOcrProfile(options = {}) {
  const languages = String(
    options.ocrLanguages || process.env.HISTORICAL_OCR_LANGUAGES || DEFAULT_OCR_LANGUAGES
  ).trim();
  if (!/^[a-z0-9_]+(?:\+[a-z0-9_]+)*$/i.test(languages)) {
    throw new Error('historical OCR languages must be plus-separated Tesseract identifiers');
  }
  const dpi = Number(options.dpi ?? options.ocrDpi ?? DEFAULT_OCR_DPI);
  const psm = Number(options.psm ?? options.ocrPsm ?? DEFAULT_OCR_PSM);
  const oem = Number(options.oem ?? options.ocrOem ?? DEFAULT_OCR_OEM);
  if (!Number.isSafeInteger(dpi) || dpi < 150 || dpi > 600) throw new Error('historical OCR DPI must be 150 to 600');
  if (!Number.isSafeInteger(psm) || psm < 0 || psm > 13) throw new Error('historical OCR PSM must be 0 to 13');
  if (!Number.isSafeInteger(oem) || oem < 0 || oem > 3) throw new Error('historical OCR OEM must be 0 to 3');
  const settings = { version: OCR_PROFILE_VERSION, languages, dpi, psm, oem };
  return { ...settings, id: sha256(JSON.stringify(settings)).slice(0, 16) };
}

function isOfficialGovernmentUrl(value) {
  const url = assertSafeRemoteUrl(value);
  const hostname = url.hostname.toLowerCase();
  if (hostname !== 'gov.cn' && !hostname.endsWith('.gov.cn')) {
    throw new Error('historical PDF host must be an official .gov.cn domain');
  }
  return url;
}

async function fetchPdfBuffer(initialUrl, options = {}) {
  const firstUrl = isOfficialGovernmentUrl(initialUrl);
  let currentUrl = firstUrl;
  const maximumBytes = options.maxBytes || MAX_PDF_BYTES;
  const maximumRedirects = options.maxRedirects ?? 3;
  const timeoutMs = options.timeoutMs || 60_000;

  for (let redirects = 0; ; redirects += 1) {
    currentUrl = isOfficialGovernmentUrl(currentUrl);
    const addresses = await resolvePublicAddresses(currentUrl.hostname, options.lookupImpl);
    let controller;
    let timeout;
    let response;
    let consumed = false;
    try {
      const headers = {
        Accept: 'application/pdf, application/octet-stream;q=0.5',
        Referer: firstUrl.href,
        'User-Agent': USER_AGENT
      };
      if (options.fetchImpl) {
        controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), timeoutMs);
        response = await options.fetchImpl(currentUrl.href, {
          headers,
          redirect: 'manual',
          signal: controller.signal
        });
      } else {
        response = await httpsRequestPinned(currentUrl, addresses, {
          headers,
          timeoutMs,
          resourceLabel: 'PDF'
        });
        controller = { abort: () => response.abort() };
      }
      if (response.status >= 300 && response.status < 400) {
        if (redirects >= maximumRedirects) throw new Error('PDF redirect limit exceeded');
        const location = response.headers.get('location');
        if (!location) throw new Error(`PDF redirect HTTP ${response.status} has no location`);
        currentUrl = isOfficialGovernmentUrl(new URL(location, currentUrl).href);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} while fetching PDF`);
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        throw new Error(`PDF exceeds ${maximumBytes} byte limit`);
      }
      const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!['application/pdf', 'application/octet-stream', 'binary/octet-stream'].includes(contentType)) {
        throw new Error(`unsupported PDF content type: ${contentType || 'missing'}`);
      }
      const buffer = await readLimitedBody(response, maximumBytes, controller, 'PDF');
      consumed = true;
      if (buffer.length < 8 || buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
        throw new Error('downloaded content is not a PDF');
      }
      return { buffer, contentType, finalUrl: currentUrl.href };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (response && !consumed) await abortResponse(response);
    }
  }
}

async function command(commandName, args, options = {}) {
  try {
    return await execFileAsync(commandName, args, {
      encoding: 'utf8',
      maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
      timeout: options.timeoutMs || 180_000,
      windowsHide: true
    });
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`required PDF tool is not installed: ${commandName}`);
    throw new Error(`${commandName} failed: ${String(error.stderr || error.message).trim().slice(0, 1000)}`);
  }
}

function normalizePdfText(value) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function isUsableExtractedText(value) {
  const compact = normalizePdfText(value).replace(/\s+/g, '');
  const hanCount = (compact.match(/\p{Script=Han}/gu) || []).length;
  return compact.length >= 120 && hanCount >= 20;
}

async function fileExists(filename) {
  try {
    await fs.promises.access(filename, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function storagePath(cacheDir, filename) {
  const relative = path.relative(path.resolve(cacheDir), path.resolve(filename));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('historical artifact path is outside the cache directory');
  }
  return relative.split(path.sep).join('/');
}

function artifactFilename(cacheDir, relative) {
  const root = path.resolve(cacheDir);
  const filename = path.resolve(root, ...String(relative || '').split('/'));
  if (!filename.startsWith(`${root}${path.sep}`)) throw new Error('invalid historical artifact storage path');
  return filename;
}

function recordArtifact(db, itemId, artifact) {
  db.prepare(`
    INSERT INTO historical_artifacts (
      item_id, artifact_type, storage_path, checksum, byte_size,
      page_start, page_end, engine, engine_version, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id, artifact_type, page_start, checksum) DO UPDATE SET
      storage_path = excluded.storage_path,
      byte_size = excluded.byte_size,
      page_end = excluded.page_end,
      engine = excluded.engine,
      engine_version = excluded.engine_version,
      metadata_json = excluded.metadata_json
  `).run(
    itemId,
    artifact.type,
    artifact.storagePath,
    artifact.checksum,
    artifact.byteSize,
    artifact.pageStart || 0,
    artifact.pageEnd || artifact.pageStart || 0,
    artifact.engine || '',
    artifact.engineVersion || '',
    JSON.stringify(artifact.metadata || {})
  );
}

async function loadCachedPdf(db, item, cacheDir) {
  const artifact = db.prepare(`
    SELECT * FROM historical_artifacts
    WHERE item_id = ? AND artifact_type = 'source_pdf'
    ORDER BY id DESC LIMIT 1
  `).get(item.id);
  if (!artifact) return null;
  const filename = artifactFilename(cacheDir, artifact.storage_path);
  if (!(await fileExists(filename))) return null;
  const buffer = await fs.promises.readFile(filename);
  if (sha256(buffer) !== artifact.checksum) throw new Error('cached PDF checksum mismatch');
  return { filename, checksum: artifact.checksum, byteSize: buffer.length, remoteFetched: false };
}

async function loadOrFetchPdf(db, item, options, dependencies) {
  const cacheDir = path.resolve(options.cacheDir);
  const cached = await loadCachedPdf(db, item, cacheDir);
  if (cached) return cached;
  const fetched = await (dependencies.fetchPdf || fetchPdfBuffer)(item.source_url, {
    fetchImpl: dependencies.fetchImpl,
    lookupImpl: dependencies.lookupImpl,
    timeoutMs: options.fetchTimeoutMs,
    maxBytes: options.maxPdfBytes
  });
  const buffer = Buffer.from(fetched.buffer);
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('downloaded content is not a PDF');
  const checksum = sha256(buffer);
  const filename = path.join(cacheDir, 'pdf', `${checksum}.pdf`);
  await fs.promises.mkdir(path.dirname(filename), { recursive: true });
  await atomicCacheWrite(filename, buffer);
  recordArtifact(db, item.id, {
    type: 'source_pdf',
    storagePath: storagePath(cacheDir, filename),
    checksum,
    byteSize: buffer.length,
    engine: 'download',
    metadata: { sourceUrl: item.source_url, finalUrl: fetched.finalUrl || item.source_url }
  });
  return { filename, checksum, byteSize: buffer.length, remoteFetched: true };
}

async function extractEmbeddedText(pdfFilename, options = {}) {
  const temporary = path.join(options.temporaryDir, `pdftotext-${crypto.randomUUID()}.txt`);
  try {
    await command(options.pdftotextCommand || 'pdftotext', ['-layout', '-enc', 'UTF-8', pdfFilename, temporary], options);
    return normalizePdfText(await fs.promises.readFile(temporary, 'utf8'));
  } finally {
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

async function pdfPageCount(pdfFilename, options = {}) {
  const result = await command(options.pdfinfoCommand || 'pdfinfo', [pdfFilename], options);
  const pages = Number(String(result.stdout || '').match(/^Pages:\s+(\d+)\s*$/mi)?.[1]);
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > (options.maxPages || MAX_PDF_PAGES)) {
    throw new Error(`PDF page count is invalid or exceeds ${options.maxPages || MAX_PDF_PAGES}`);
  }
  return pages;
}

async function ocrPdfPages(pdfFilename, sourceChecksum, options = {}) {
  const cacheDir = path.resolve(options.cacheDir);
  const runCommand = options.commandImpl || command;
  const profile = historicalOcrProfile(options);
  const pageDir = path.join(cacheDir, 'pages', sourceChecksum, profile.id);
  const temporaryDir = path.join(cacheDir, 'tmp');
  await fs.promises.mkdir(pageDir, { recursive: true });
  await fs.promises.mkdir(temporaryDir, { recursive: true });
  const pageCount = await (options.pageCount || pdfPageCount)(pdfFilename, options);
  const pageBudget = Math.max(1, options.pageBudget || 20);
  const pages = [];
  let processed = 0;

  for (let page = 1; page <= pageCount; page += 1) {
    const filename = path.join(pageDir, `page-${String(page).padStart(4, '0')}.txt`);
    if (!(await fileExists(filename))) {
      if (processed >= pageBudget) continue;
      const prefix = path.join(temporaryDir, `ocr-${sourceChecksum.slice(0, 12)}-${page}-${crypto.randomUUID()}`);
      const imageFilename = `${prefix}.png`;
      try {
        await runCommand(options.pdftoppmCommand || 'pdftoppm', [
          '-f', String(page), '-l', String(page), '-r', String(profile.dpi),
          '-png', '-singlefile', pdfFilename, prefix
        ], options);
        const result = await runCommand(options.tesseractCommand || 'tesseract', [
          imageFilename, 'stdout', '-l', profile.languages,
          '--oem', String(profile.oem), '--psm', String(profile.psm)
        ], options);
        await atomicCacheWrite(filename, Buffer.from(normalizePdfText(result.stdout), 'utf8'));
        processed += 1;
      } finally {
        await fs.promises.unlink(imageFilename).catch(() => {});
      }
    }
    if (await fileExists(filename)) {
      const text = await fs.promises.readFile(filename, 'utf8');
      pages.push({ page, text, filename, checksum: sha256(text), byteSize: Buffer.byteLength(text) });
    }
  }

  return {
    complete: pages.length === pageCount,
    pageCount,
    pagesProcessed: processed,
    pages,
    text: pages.length === pageCount ? normalizePdfText(pages.map((entry) => entry.text).join('\f')) : '',
    profile
  };
}

function cleanCandidateTitle(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, '')
    .trim();
}

function isCandidateTitle(value) {
  const title = cleanCandidateTitle(value);
  if (title.length < 6 || title.length > 120) return false;
  if (/[。；：，!?！？]/u.test(title) || /^\d+[、.．]/u.test(title)) return false;
  if (/^(?:目录|国务院公报|中华人民共和国国务院公报|第\s*\d+\s*号)$/u.test(title)) return false;
  return TITLE_ENDINGS.test(title) || /^中华人民共和国(?:国务院|主席)令/u.test(title);
}

function candidateTitleReviewReason(value) {
  const title = cleanCandidateTitle(value);
  if (!isCandidateTitle(title)) return 'not-a-policy-heading';
  if (/^[^\p{Script=Han}A-Za-z0-9]/u.test(title)) return 'unexpected-leading-character';
  const meaningful = title.replace(/[\p{Script=Han}A-Za-z0-9]/gu, '');
  if (meaningful.length > Math.max(4, Math.floor(title.length * 0.2))) return 'excessive-non-title-characters';
  if (NOMINAL_TITLE_ENDINGS.test(title)) return '';
  if (/^中华人民共和国(?:国务院|主席)令/u.test(title)) return '';
  if (/(?:工作报告|政府公告)$/u.test(title)) return '';
  if (ACTION_TITLE_ENDINGS.test(title)
    && (/(?:关于).{2,}/u.test(title) || /(?:印发|转发|发布|公布|颁布|修订|废止).{2,}/u.test(title))) {
    return '';
  }
  return 'missing-policy-title-structure';
}

function hasDocumentAnchor(lines, index) {
  const page = lines[index].page;
  return lines.slice(index + 1, index + 7)
    .filter((line) => line.page <= page + 1)
    .some((line) => DOCUMENT_ANCHOR.test(line.text));
}

function segmentPdfIssueText(rawText, options = {}) {
  const pages = normalizePdfText(rawText).split('\f');
  const lines = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    for (const rawLine of pages[pageIndex].split('\n')) {
      const line = cleanCandidateTitle(rawLine);
      if (line) lines.push({ text: line, page: pageIndex + 1 });
    }
  }
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (isCandidateTitle(lines[index].text) && hasDocumentAnchor(lines, index)) starts.push(index);
  }
  if (!starts.length && options.itemKind === 'document' && lines.length) starts.push(0);

  const candidates = [];
  const rejectedHeadings = [];
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1] : lines.length;
    const title = isCandidateTitle(lines[start].text)
      ? cleanCandidateTitle(lines[start].text)
      : cleanCandidateTitle(options.fallbackTitle || lines[start].text);
    const reviewReason = candidateTitleReviewReason(title);
    if (reviewReason) {
      rejectedHeadings.push({ title, page: lines[start].page, reason: reviewReason });
      continue;
    }
    const contentText = normalizePdfText(lines.slice(start, end).map((line) => line.text).join('\n'));
    if (!title || contentText.replace(/\s+/g, '').length < (options.minimumLength || 120)) continue;
    candidates.push({
      title,
      contentText,
      pageStart: lines[start].page,
      pageEnd: lines[Math.max(start, end - 1)].page,
      checksum: sha256(contentText)
    });
  }

  const byTitle = new Map();
  for (const candidate of candidates) {
    const key = candidate.title.replace(/\s+/g, '');
    const previous = byTitle.get(key);
    if (!previous || candidate.contentText.length > previous.contentText.length) byTitle.set(key, candidate);
  }
  const uniqueCandidates = [...byTitle.values()]
    .sort((left, right) => left.pageStart - right.pageStart || left.title.localeCompare(right.title));
  const reviewReasons = [];
  if (rejectedHeadings.length) reviewReasons.push(`untrusted-headings:${rejectedHeadings.length}`);
  if (!uniqueCandidates.length) reviewReasons.push('no-trusted-policy-candidates');
  if (options.itemKind !== 'document' && uniqueCandidates.length) {
    const maximumLeadPages = Math.max(4, Math.ceil(pages.length * 0.25));
    if (uniqueCandidates[0].pageStart > maximumLeadPages) {
      reviewReasons.push(`unsegmented-leading-pages:${uniqueCandidates[0].pageStart - 1}`);
    }
    const minimumCandidates = Math.max(1, Math.ceil(pages.length / 30));
    if (uniqueCandidates.length < minimumCandidates) {
      reviewReasons.push(`insufficient-heading-density:${uniqueCandidates.length}/${minimumCandidates}`);
    }
  }
  return { candidates: uniqueCandidates, rejectedHeadings, reviewReasons, pageCount: pages.length };
}

function splitPdfIssueText(rawText, options = {}) {
  return segmentPdfIssueText(rawText, options).candidates;
}

function quarantinePdfChildren(db, itemId, reason) {
  return Number(db.prepare(`
    UPDATE historical_backfill_items SET
      stage = 'manual_review', source_status = 'rejected', metadata_status = 'rejected',
      lifecycle_status = 'rejected', implementation_status = 'rejected',
      outcome_status = 'rejected', analysis_status = 'rejected',
      last_error = ?, next_attempt_at = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE parent_id = ? AND document_id IS NULL AND stage <> 'published'
  `).run(String(reason || 'parent PDF segmentation rejected').slice(0, 1000), itemId).changes);
}

function queueLegacyPdfSegmentations(db) {
  const publicChildren = Number(db.prepare(`
    SELECT count(*) AS count
    FROM historical_backfill_items child
    JOIN historical_backfill_items parent ON parent.id = child.parent_id
    WHERE parent.source_type = 'pdf' AND parent.item_kind = 'issue'
      AND child.document_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM historical_artifacts artifact
        WHERE artifact.item_id = parent.id AND artifact.artifact_type = 'segmentation'
          AND artifact.engine = 'policy-heading-v1'
      )
      AND NOT EXISTS (
        SELECT 1 FROM historical_artifacts artifact
        WHERE artifact.item_id = parent.id AND artifact.artifact_type = 'segmentation'
          AND artifact.engine = 'policy-heading-v2'
      )
  `).get().count);
  if (publicChildren > 0) throw new Error(`legacy PDF segmentation has ${publicChildren} public child rows`);
  return Number(db.prepare(`
    UPDATE historical_backfill_items SET
      stage = 'manual_review', last_error = 'legacy PDF segmentation requires v2 quality review',
      next_attempt_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE source_type = 'pdf' AND item_kind = 'issue' AND stage = 'indexed'
      AND EXISTS (
        SELECT 1 FROM historical_artifacts artifact
        WHERE artifact.item_id = historical_backfill_items.id
          AND artifact.artifact_type = 'segmentation' AND artifact.engine = 'policy-heading-v1'
      )
      AND NOT EXISTS (
        SELECT 1 FROM historical_artifacts artifact
        WHERE artifact.item_id = historical_backfill_items.id
          AND artifact.artifact_type = 'segmentation' AND artifact.engine = 'policy-heading-v2'
      )
  `).run().changes);
}

function queueStaleOcrProfiles(db, profileId) {
  return Number(db.prepare(`
    UPDATE historical_backfill_items SET
      stage = 'manual_review', last_error = 'historical OCR profile upgrade requires reprocessing',
      next_attempt_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE source_type = 'pdf' AND item_kind = 'issue' AND stage = 'manual_review'
      AND EXISTS (
        SELECT 1 FROM historical_artifacts artifact
        WHERE artifact.item_id = historical_backfill_items.id AND artifact.artifact_type = 'ocr_page'
          AND coalesce(json_extract(artifact.metadata_json, '$.ocrProfile.id'), '') <> ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM historical_artifacts artifact
        WHERE artifact.item_id = historical_backfill_items.id AND artifact.artifact_type = 'ocr_page'
          AND json_extract(artifact.metadata_json, '$.ocrProfile.id') = ?
      )
  `).run(profileId, profileId).changes);
}

function insertPdfCandidates(db, item, candidates) {
  const insert = db.prepare(`
    INSERT INTO historical_backfill_items (
      parent_id, source_url, source_name, source_type, item_kind,
      source_year, issue_label, title, content_text, checksum, stage, last_error, fetched_at
    ) VALUES (?, ?, ?, 'pdf', 'document', ?, ?, ?, ?, ?, 'manual_review', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(source_url) DO UPDATE SET
      parent_id = excluded.parent_id,
      source_name = excluded.source_name,
      source_type = excluded.source_type,
      item_kind = excluded.item_kind,
      source_year = excluded.source_year,
      issue_label = excluded.issue_label,
      title = excluded.title,
      content_text = excluded.content_text,
      checksum = excluded.checksum,
      stage = 'manual_review',
      source_status = 'pending',
      metadata_status = 'pending',
      lifecycle_status = 'pending',
      implementation_status = 'pending',
      outcome_status = 'pending',
      analysis_status = 'pending',
      last_error = excluded.last_error,
      next_attempt_at = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE historical_backfill_items.document_id IS NULL
  `);
  let created = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const quarantined = quarantinePdfChildren(db, item.id, 'superseded by parent PDF re-segmentation');
    for (const candidate of candidates) {
      const baseUrl = String(item.source_url).split('#')[0];
      const sourceUrl = `${baseUrl}#candidate=${candidate.checksum.slice(0, 16)}&pages=${candidate.pageStart}-${candidate.pageEnd}`;
      const result = insert.run(
        item.id,
        sourceUrl,
        item.source_name,
        item.source_year,
        item.title || item.issue_label,
        candidate.title,
        candidate.contentText,
        candidate.checksum,
        `OCR transcription requires comparison with official PDF pages ${candidate.pageStart}-${candidate.pageEnd}`
      );
      created += result.changes;
    }
    db.prepare(`
      UPDATE historical_backfill_items SET
        stage = 'indexed', attempts = attempts + 1, last_error = '', next_attempt_at = NULL,
        fetched_at = coalesce(fetched_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(item.id);
    db.exec('COMMIT');
    return { created, quarantined };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function updatePdfCheckpoint(db, item, message, retryHours = 1) {
  db.prepare(`
    UPDATE historical_backfill_items SET
      stage = 'manual_review', attempts = attempts + 1, last_error = ?,
      next_attempt_at = datetime('now', ?),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(message.slice(0, 1000), `+${retryHours} hours`, item.id);
}

function updatePdfFailure(db, item, error) {
  const attempts = item.attempts + 1;
  const retryHours = Math.min(168, 2 ** Math.min(attempts, 7));
  updatePdfCheckpoint(db, item, String(error.message || error), retryHours);
}

async function processPdfItem(db, item, options = {}, dependencies = {}) {
  const cacheDir = path.resolve(options.cacheDir);
  await fs.promises.mkdir(path.join(cacheDir, 'tmp'), { recursive: true });
  const source = await loadOrFetchPdf(db, item, options, dependencies);
  const embeddedText = normalizePdfText(await (dependencies.extractEmbeddedText || extractEmbeddedText)(source.filename, {
    temporaryDir: path.join(cacheDir, 'tmp'),
    timeoutMs: options.toolTimeoutMs
  }));
  let extractionType = 'embedded_text';
  let extractionEngine = 'pdftotext';
  let pageCount = Math.max(1, embeddedText.split('\f').length);
  let text = embeddedText;
  let ocrProfile = null;

  if (!isUsableExtractedText(embeddedText)) {
    extractionType = 'ocr_text';
    extractionEngine = 'tesseract';
    const ocr = await (dependencies.ocrPdf || ocrPdfPages)(source.filename, source.checksum, {
      cacheDir,
      pageBudget: options.ocrPageBudget || 20,
      ocrLanguages: options.ocrLanguages,
      ocrDpi: options.ocrDpi,
      ocrPsm: options.ocrPsm,
      ocrOem: options.ocrOem,
      timeoutMs: options.toolTimeoutMs
    });
    ocrProfile = ocr.profile || historicalOcrProfile(options);
    pageCount = ocr.pageCount;
    for (const page of ocr.pages || []) {
      recordArtifact(db, item.id, {
        type: 'ocr_page',
        storagePath: storagePath(cacheDir, page.filename),
        checksum: page.checksum,
        byteSize: page.byteSize,
        pageStart: page.page,
        pageEnd: page.page,
        engine: 'tesseract',
        engineVersion: ocrProfile.version,
        metadata: { ocrProfile }
      });
    }
    if (!ocr.complete) {
      updatePdfCheckpoint(db, item, `OCR checkpoint: ${ocr.pages.length}/${ocr.pageCount} pages`, 1);
      return {
        id: item.id,
        action: 'ocr_checkpoint',
        completedPages: ocr.pages.length,
        pageCount: ocr.pageCount,
        remoteFetched: source.remoteFetched
      };
    }
    text = normalizePdfText(ocr.text);
  }

  if (!isUsableExtractedText(text)) throw new Error('PDF text extraction produced insufficient Chinese text');
  const textChecksum = sha256(text);
  const textSuffix = extractionType === 'ocr_text' ? `${ocrProfile.id}.ocr` : 'embedded';
  const textFilename = path.join(cacheDir, 'text', `${source.checksum}.${textSuffix}.txt`);
  await fs.promises.mkdir(path.dirname(textFilename), { recursive: true });
  await atomicCacheWrite(textFilename, Buffer.from(text, 'utf8'));
  recordArtifact(db, item.id, {
    type: extractionType,
    storagePath: storagePath(cacheDir, textFilename),
    checksum: textChecksum,
    byteSize: Buffer.byteLength(text),
    pageStart: 1,
    pageEnd: pageCount,
    engine: extractionEngine,
    engineVersion: ocrProfile?.version || '',
    metadata: { sourceChecksum: source.checksum, ...(ocrProfile ? { ocrProfile } : {}) }
  });

  const segmentationResult = segmentPdfIssueText(text, {
    itemKind: item.item_kind,
    fallbackTitle: item.title,
    minimumLength: options.minimumCandidateLength
  });
  const candidates = segmentationResult.candidates;
  const segmentation = Buffer.from(JSON.stringify({
    status: segmentationResult.reviewReasons.length ? 'review_required' : 'accepted',
    candidates: candidates.map((candidate) => ({
      title: candidate.title,
      pageStart: candidate.pageStart,
      pageEnd: candidate.pageEnd,
      checksum: candidate.checksum
    })),
    rejectedHeadings: segmentationResult.rejectedHeadings,
    reviewReasons: segmentationResult.reviewReasons
  }, null, 2));
  const segmentationChecksum = sha256(segmentation);
  const segmentationFilename = path.join(cacheDir, 'segments', `${source.checksum}.${segmentationChecksum.slice(0, 16)}.json`);
  await fs.promises.mkdir(path.dirname(segmentationFilename), { recursive: true });
  await atomicCacheWrite(segmentationFilename, segmentation);
  recordArtifact(db, item.id, {
    type: 'segmentation',
    storagePath: storagePath(cacheDir, segmentationFilename),
    checksum: segmentationChecksum,
    byteSize: segmentation.length,
    pageStart: 1,
    pageEnd: pageCount,
    engine: 'policy-heading-v2',
    metadata: {
      status: segmentationResult.reviewReasons.length ? 'review_required' : 'accepted',
      candidates: candidates.length,
      rejectedHeadings: segmentationResult.rejectedHeadings.length,
      reviewReasons: segmentationResult.reviewReasons,
      textChecksum,
      ...(ocrProfile ? { ocrProfile } : {})
    }
  });
  if (segmentationResult.reviewReasons.length) {
    const quarantined = quarantinePdfChildren(
      db,
      item.id,
      `parent PDF segmentation rejected: ${segmentationResult.reviewReasons.join(', ')}`
    );
    updatePdfCheckpoint(db, item, `automatic segmentation review: ${segmentationResult.reviewReasons.join(', ')}`, 24);
    return {
      id: item.id,
      action: 'segmentation_review',
      candidates: candidates.length,
      rejectedHeadings: segmentationResult.rejectedHeadings.length,
      quarantined,
      remoteFetched: source.remoteFetched
    };
  }
  const inserted = insertPdfCandidates(db, item, candidates);
  return {
    id: item.id,
    action: 'pdf_segmented',
    candidates: candidates.length,
    created: inserted.created,
    quarantined: inserted.quarantined,
    extraction: extractionEngine,
    pageCount,
    remoteFetched: source.remoteFetched
  };
}

function pdfQueueItems(db, maximum) {
  return db.prepare(`
    SELECT * FROM historical_backfill_items
    WHERE stage = 'manual_review' AND source_type = 'pdf'
      AND (parent_id IS NULL OR item_kind = 'issue')
      AND (next_attempt_at IS NULL OR next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ORDER BY CASE last_error
      WHEN 'legacy PDF segmentation requires v2 quality review' THEN 0
      ELSE 1
    END, coalesce(source_year, 9999), id
    LIMIT ?
  `).all(maximum);
}

async function runHistoricalPdfQueue(db, options = {}, dependencies = {}) {
  if (!options.cacheDir) throw new Error('historical PDF cache directory is required');
  const legacyQueued = queueLegacyPdfSegmentations(db);
  const ocrProfile = historicalOcrProfile(options);
  const staleOcrQueued = queueStaleOcrProfiles(db, ocrProfile.id);
  const maximum = options.maxItems || 5;
  const minimum = Math.min(maximum, options.minItems || 1);
  const delayMs = options.delayMs ?? 5000;
  const readLoad = dependencies.loadSnapshot || currentLoadSnapshot;
  const initialLoad = readLoad();
  const initialCapacity = options.adaptiveLoad
    ? adaptiveBatchSize(maximum, minimum, initialLoad)
    : maximum;
  const items = pdfQueueItems(db, maximum);
  const result = {
    status: 'succeeded',
    legacyQueued,
    staleOcrQueued,
    ocrProfile,
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
      const processed = await processPdfItem(db, item, options, dependencies);
      result.items.push(processed);
      result.processed += 1;
      if (processed.remoteFetched && delayMs > 0 && index < items.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      updatePdfFailure(db, item, error);
      result.errors.push({ id: item.id, url: item.source_url, message: error.message });
    }
  }
  if (result.errors.length) result.status = result.processed ? 'partial' : 'failed';
  return result;
}

module.exports = {
  MAX_PDF_BYTES,
  MAX_PDF_PAGES,
  fetchPdfBuffer,
  isCandidateTitle,
  isUsableExtractedText,
  normalizePdfText,
  ocrPdfPages,
  processPdfItem,
  queueLegacyPdfSegmentations,
  queueStaleOcrProfiles,
  historicalOcrProfile,
  runHistoricalPdfQueue,
  segmentPdfIssueText,
  splitPdfIssueText
};
