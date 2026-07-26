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
const TITLE_ENDINGS = /(?:决定|决议|命令|通知|通告|公告|条例|规定|办法|意见|批复|报告|方案|细则|规则|函)(?:[（(][^）)]{1,40}[）)])?$/u;
const NOMINAL_TITLE_ENDINGS = /(?:条例|规定|办法|细则|规则|章程|纲要|规划)(?:[（(][^）)]{1,40}[）)])?$/u;
const ACTION_TITLE_ENDINGS = /(?:决定|决议|通知|通告|公告|意见|批复|报告|方案|函)(?:[（(][^）)]{1,40}[）)])?$/u;
const DOCUMENT_ANCHOR = /(?:(?:19|20)\d{2}\s*年|[〇零○一二三四五六七八九十]{4}\s*年|〔\s*(?:19|20)\d{2}\s*〕|(?:会议|大会).{0,20}(?:通过|批准)|(?:国务院|政务院|人民代表大会|[\p{Script=Han}]{2,16}(?:部|委员会)).{0,20}(?:制定|批准|通过|公布|发布))/u;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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
  const pageDir = path.join(cacheDir, 'pages', sourceChecksum);
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
          '-f', String(page), '-l', String(page), '-r', String(options.dpi || 180),
          '-png', '-singlefile', pdfFilename, prefix
        ], options);
        const result = await runCommand(options.tesseractCommand || 'tesseract', [
          imageFilename, 'stdout', '-l', options.ocrLanguages || 'chi_sim+eng', '--psm', '6'
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
    text: pages.length === pageCount ? normalizePdfText(pages.map((entry) => entry.text).join('\f')) : ''
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

function insertPdfCandidates(db, item, candidates) {
  const insert = db.prepare(`
    INSERT INTO historical_backfill_items (
      parent_id, source_url, source_name, source_type, item_kind,
      source_year, issue_label, title, content_text, checksum, stage, fetched_at
    ) VALUES (?, ?, ?, 'pdf', 'document', ?, ?, ?, ?, ?, 'needs_review', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(source_url) DO NOTHING
  `);
  let created = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
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
        candidate.checksum
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
    return created;
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

  if (!isUsableExtractedText(embeddedText)) {
    extractionType = 'ocr_text';
    extractionEngine = 'tesseract';
    const ocr = await (dependencies.ocrPdf || ocrPdfPages)(source.filename, source.checksum, {
      cacheDir,
      pageBudget: options.ocrPageBudget || 20,
      ocrLanguages: options.ocrLanguages || process.env.HISTORICAL_OCR_LANGUAGES || 'chi_sim+eng',
      timeoutMs: options.toolTimeoutMs
    });
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
        metadata: { languages: options.ocrLanguages || process.env.HISTORICAL_OCR_LANGUAGES || 'chi_sim+eng' }
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
  const textFilename = path.join(cacheDir, 'text', `${source.checksum}.${extractionType === 'ocr_text' ? 'ocr' : 'embedded'}.txt`);
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
    metadata: { sourceChecksum: source.checksum }
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
      textChecksum
    }
  });
  if (segmentationResult.reviewReasons.length) {
    updatePdfCheckpoint(db, item, `automatic segmentation review: ${segmentationResult.reviewReasons.join(', ')}`, 24);
    return {
      id: item.id,
      action: 'segmentation_review',
      candidates: candidates.length,
      rejectedHeadings: segmentationResult.rejectedHeadings.length,
      remoteFetched: source.remoteFetched
    };
  }
  const created = insertPdfCandidates(db, item, candidates);
  return {
    id: item.id,
    action: 'pdf_segmented',
    candidates: candidates.length,
    created,
    extraction: extractionEngine,
    pageCount,
    remoteFetched: source.remoteFetched
  };
}

function pdfQueueItems(db, maximum) {
  return db.prepare(`
    SELECT * FROM historical_backfill_items
    WHERE stage = 'manual_review' AND source_type = 'pdf'
      AND (next_attempt_at IS NULL OR next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ORDER BY coalesce(source_year, 9999), id
    LIMIT ?
  `).all(maximum);
}

async function runHistoricalPdfQueue(db, options = {}, dependencies = {}) {
  if (!options.cacheDir) throw new Error('historical PDF cache directory is required');
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
  runHistoricalPdfQueue,
  segmentPdfIssueText,
  splitPdfIssueText
};
