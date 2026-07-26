'use strict';

const crypto = require('node:crypto');

const { adaptiveBatchSize, currentLoadSnapshot, loadHistoricalSources } = require('./historical-backfill');
const { officialEvidenceUrl } = require('./historical-review');

const DOCUMENT_NUMBER_PATTERNS = [
  /(?:国发|国办发|国函|国办函|国令|中发|中办发|发改|财税|银发|建发|商发|人社部发|卫政法发)\s*[〔\[(（]\s*(?:19|20)\d{2}\s*[〕\])）]\s*\d+\s*号/gu,
  /(?:中华人民共和国)?(?:国务院|主席)令\s*第?\s*\d+\s*号/gu,
  /[\p{Script=Han}]{1,12}\s*[〔\[(（]\s*(?:19|20)\d{2}\s*[〕\])）]\s*\d+\s*号/gu,
  /[（(]\s*(?:19|20)\d{2}\s*[）)]\s*[\p{Script=Han}]{1,16}第?\s*\d+\s*号/gu,
  /[（(]\s*(?:19)?\d{2}\s*[）)]\s*[\p{Script=Han}]{1,16}(?:字)?第?\s*\d+\s*号/gu,
  /(?:中央人民政府|政务院|国务院)[\p{Script=Han}]{0,12}(?:字)?第?\s*\d+\s*号/gu
];
const DATE_PATTERN = /((?:19|20)\d{2}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|[一二三四五六七八九〇○零]{4}\s*年\s*[一二三四五六七八九十廿]{1,3}\s*月\s*[一二三四五六七八九十廿]{1,3}\s*日)/gu;
const REPEAL_PATTERN = /废止|停止执行|停止施行|不再执行|宣布失效|予以失效/u;
const SUPERSEDE_PATTERN = /替代|取代|代替|以本(?:办法|规定|通知|决定|条例)为准/u;
const KNOWN_ISSUERS = [
  '全国人民代表大会常务委员会', '中央人民政府政务院', '中央人民政府委员会', '中央人民政府',
  '中国人民政治协商会议全国委员会',
  '国务院办公厅', '国务院', '国家发展和改革委员会', '财政部', '商务部', '住房和城乡建设部',
  '人力资源和社会保障部', '农业农村部', '工业和信息化部', '自然资源部', '生态环境部',
  '教育部', '民政部', '司法部', '公安部', '交通运输部', '水利部', '文化和旅游部',
  '国家卫生健康委员会', '中国人民银行', '国家统计局', '国家市场监督管理总局',
  '外交部', '内务部', '劳动部', '贸易部', '重工业部', '第一机械工业部'
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function checksumMatches(item) {
  const text = String(item.content_text || '');
  if (!item.checksum || !text) return false;
  return item.checksum === sha256(text) || item.checksum === sha256(text.replace(/\s+/g, ''));
}

function evidenceLine(text, index) {
  const start = Math.max(0, String(text).lastIndexOf('\n', index) + 1);
  const next = String(text).indexOf('\n', index);
  const end = next < 0 ? String(text).length : next;
  return String(text).slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function normalizedEvidenceSpan(text, expected, maximumLines = 3) {
  const target = String(expected || '').replace(/\s+/g, '');
  if (!target) return null;
  const lines = String(text || '').split('\n');
  for (let start = 0; start < lines.length; start += 1) {
    for (let count = 1; count <= maximumLines && start + count <= lines.length; count += 1) {
      const quote = lines.slice(start, start + count).join(' ').replace(/\s+/g, ' ').trim();
      if (quote.replace(/\s+/g, '').includes(target)) return quote.slice(0, 500);
    }
  }
  return null;
}

function chineseNumber(value) {
  const token = String(value || '').replace(/\s+/g, '');
  if (/^\d+$/.test(token)) return Number(token);
  const digits = { 零: 0, 〇: 0, '○': 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (token.startsWith('廿')) {
    const ones = token.length === 1 ? 0 : digits[token.slice(1)];
    return ones === undefined ? NaN : 20 + ones;
  }
  if (!token.includes('十')) {
    const converted = [...token].map((character) => digits[character]);
    return converted.every((digit) => digit !== undefined) ? Number(converted.join('')) : NaN;
  }
  const [before, after] = token.split('十');
  const tens = before ? digits[before] : 1;
  const ones = after ? digits[after] : 0;
  return tens === undefined || ones === undefined ? NaN : tens * 10 + ones;
}

function parseChineseDate(value) {
  const match = String(value || '').match(/^(.+?)\s*年\s*(.+?)\s*月\s*(.+?)\s*日$/u);
  if (!match) return null;
  const year = chineseNumber(match[1]);
  const month = chineseNumber(match[2]);
  const day = chineseNumber(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isSafeInteger(year) || year < 1949 || year > new Date().getFullYear() + 1
      || probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00+08:00`;
}

function dateMentions(text) {
  const mentions = [];
  for (const match of String(text || '').matchAll(DATE_PATTERN)) {
    const value = parseChineseDate(match[1]);
    if (value) mentions.push({ value, raw: match[1].replace(/\s+/g, ''), index: match.index, quote: evidenceLine(text, match.index) });
  }
  return mentions;
}

function extractDocumentNumbers(text) {
  const found = [];
  for (const pattern of DOCUMENT_NUMBER_PATTERNS) {
    for (const match of String(text || '').matchAll(pattern)) {
      const value = match[0].replace(/\s+/g, '');
      if (found.some((entry) => value.endsWith(entry.value) && match.index <= entry.index)) continue;
      if (!found.some((entry) => entry.value === value)) {
        found.push({ value, quote: evidenceLine(text, match.index), index: match.index });
      }
    }
  }
  return found.sort((left, right) => left.index - right.index);
}

function documentNumberKey(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/[\[(（]/gu, '〔')
    .replace(/[\])）]/gu, '〕');
}

function extractIssuerEvidence(item) {
  const text = String(item.content_text || '');
  const title = String(item.title || '').replace(/\s+/g, '');
  const existing = String(item.issuer || '').trim();
  if (existing) {
    const quote = normalizedEvidenceSpan(text, existing, 1);
    if ((title.startsWith(existing.replace(/\s+/g, '')) || text.split('\n').slice(-16).some((line) => line.replace(/\s+/g, '') === existing.replace(/\s+/g, ''))) && quote) {
      return { value: existing, quote, confidence: 1 };
    }
  }
  for (const issuer of KNOWN_ISSUERS) {
    const titleIndex = title.indexOf(issuer);
    if (titleIndex >= 0 && titleIndex <= 2) {
      const textIndex = text.indexOf(issuer);
      if (textIndex >= 0) return { value: issuer, quote: evidenceLine(text, textIndex), confidence: 0.99 };
    }
  }
  const lines = text.split('\n').map((line) => line.replace(/\s+/g, '').trim()).filter(Boolean);
  const edgeLines = [...lines.slice(0, 8), ...lines.slice(-16)];
  for (const line of edgeLines.reverse()) {
    const match = line.match(/^(?:中华人民共和国)?[\p{Script=Han}·]{2,50}(?:国务院|政务院|办公厅|人民政府|人民银行|委员会|总局|部|署)$/u);
    if (match && !/(?:本|由|负责|执行|依照|通知|规定|办法|决定)/u.test(line)) {
      return { value: match[0].replace(/^中华人民共和国(?=国务院)/u, ''), quote: line, confidence: 0.97 };
    }
  }
  const number = extractDocumentNumbers(text)[0]?.value || '';
  if (/^国办/u.test(number)) return { value: '国务院办公厅', quote: extractDocumentNumbers(text)[0].quote, confidence: 0.95 };
  if (/^(?:国发|国函|国令)/u.test(number)) return { value: '国务院', quote: extractDocumentNumbers(text)[0].quote, confidence: 0.95 };
  return null;
}

function extractPublishedEvidence(item, documentNumber) {
  const text = String(item.content_text || '');
  const sourceYear = Number(item.source_year);
  const numberYear = Number(String(documentNumber || '').match(/(?:19|20)\d{2}/)?.[0]);
  const ranked = dateMentions(text).map((mention) => {
    const year = Number(mention.value.slice(0, 4));
    const context = evidenceLine(text, mention.index);
    const lineNumber = text.slice(0, mention.index).split('\n').length;
    const nearEnd = mention.index >= text.length * 0.65;
    const standalone = mention.quote.replace(/\s+/g, '') === mention.raw;
    const explicitPublication = /成文|签发|发布|印发|公布|制定|(?:会议|大会).{0,24}(?:通过|批准)|(?:通过|批准).{0,24}(?:会议|大会)/u.test(context);
    let score = 0;
    if (year === sourceYear) score += 4;
    if (year === numberYear) score += 2;
    if (nearEnd) score += 2;
    if (standalone) score += 3;
    if (/成文|签发|发布|印发|公布|制定/u.test(context)) score += 3;
    if (/(?:会议|大会).{0,24}(?:通过|批准)|(?:通过|批准).{0,24}(?:会议|大会)/u.test(context)) score += 4;
    if (/施行|实施|执行|生效|废止|失效|有效期/u.test(context)) score -= 7;
    return { ...mention, score, publicationSignal: explicitPublication || (standalone && (nearEnd || lineNumber <= 6)) };
  }).sort((left, right) => right.score - left.score || right.index - left.index);
  const selected = ranked.find((mention) => mention.score >= 4 && mention.publicationSignal);
  return selected ? { ...selected, confidence: Math.min(0.99, 0.75 + selected.score * 0.025) } : null;
}

function sentenceAt(text, index) {
  const value = String(text || '');
  const left = Math.max(value.lastIndexOf('。', index - 1), value.lastIndexOf('\n', index - 1));
  const rightPeriod = value.indexOf('。', index);
  const rightNewline = value.indexOf('\n', index);
  const candidates = [rightPeriod, rightNewline].filter((position) => position >= 0);
  const right = candidates.length ? Math.min(...candidates) + 1 : value.length;
  return value.slice(left + 1, right).replace(/\s+/g, ' ').trim().slice(0, 500);
}

function extractEffectiveEvidence(item, publishedAt) {
  const text = String(item.content_text || '');
  for (const mention of dateMentions(text)) {
    const context = text.slice(Math.max(0, mention.index - 24), mention.index + mention.raw.length + 36);
    if (/(?:自|于)[^。\n]{0,32}(?:起|开始)(?:施行|实施|执行|生效)|(?:施行|实施|执行|生效)日期/u.test(context)) {
      return { value: mention.value, quote: sentenceAt(text, mention.index), confidence: 0.99 };
    }
  }
  const publicationMatch = /(?:本(?:条例|规定|办法|通知|决定|细则|规则|意见|方案))?自(?:公布|发布|印发)之日起(?:施行|实施|执行|生效)/u.exec(text);
  if (publicationMatch && publishedAt) {
    return { value: publishedAt, quote: sentenceAt(text, publicationMatch.index), confidence: 0.98 };
  }
  return null;
}

function extractExplicitEndEvidence(item) {
  const text = String(item.content_text || '');
  for (const mention of dateMentions(text)) {
    const quote = sentenceAt(text, mention.index);
    const selfReference = /本(?:条例|规定|办法|通知|决定|细则|规则|意见|方案|文件|政策)/u.test(quote);
    if (selfReference && (/有效期(?:至|截止到?)/u.test(quote)
      || /自.{0,20}起(?:废止|停止执行|停止施行|失效)/u.test(quote))) {
      return { value: mention.value, quote, confidence: 0.99 };
    }
  }
  return null;
}

function upsertEvidence(db, evidence) {
  if (evidence.status === 'verified') {
    db.prepare(`
      DELETE FROM historical_verification_evidence
      WHERE item_id = ? AND claim_type = ? AND status = 'not_found'
    `).run(evidence.itemId, evidence.claimType);
  }
  return Number(db.prepare(`
    INSERT INTO historical_verification_evidence (
      item_id, source_item_id, claim_type, status, value_text, evidence_quote,
      source_url, search_scope, extractor, confidence, observed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(item_id, claim_type, status, value_text, source_url, evidence_quote) DO UPDATE SET
      source_item_id = excluded.source_item_id,
      search_scope = excluded.search_scope,
      extractor = excluded.extractor,
      confidence = excluded.confidence,
      observed_at = excluded.observed_at
    RETURNING id
  `).get(
    evidence.itemId,
    evidence.sourceItemId || null,
    evidence.claimType,
    evidence.status,
    evidence.value || '',
    evidence.quote || '',
    evidence.sourceUrl || '',
    evidence.searchScope || '',
    evidence.extractor || 'historical-metadata-v2',
    evidence.confidence ?? 1,
    evidence.observedAt || null
  ).id);
}

function metadataEvidence(item) {
  if (!checksumMatches(item)) throw new Error('queued source text checksum does not match');
  const sourceUrl = officialEvidenceUrl(item.source_url);
  const text = String(item.content_text || '');
  const titleQuote = normalizedEvidenceSpan(text, item.title, 3);
  const title = titleQuote && item.title
    ? { value: item.title.trim(), quote: titleQuote, confidence: 1 }
    : null;
  const documentNumber = extractDocumentNumbers(text)[0] || null;
  const issuer = extractIssuerEvidence(item);
  const published = extractPublishedEvidence(item, documentNumber?.value);
  const effective = extractEffectiveEvidence(item, published?.value || item.published_at);
  return { sourceUrl, title, documentNumber, issuer, published, effective };
}

function verifySourceMetadata(db, item) {
  const extracted = metadataEvidence(item);
  const missing = [];
  if (!extracted.title) missing.push('title');
  if (!extracted.issuer) missing.push('issuer');
  if (!extracted.published) missing.push('published_at');
  db.exec('BEGIN IMMEDIATE');
  try {
    upsertEvidence(db, {
      itemId: item.id,
      sourceItemId: item.id,
      claimType: 'source',
      status: 'verified',
      value: extracted.sourceUrl,
      quote: extracted.title?.quote || String(item.content_text).slice(0, 300),
      sourceUrl: extracted.sourceUrl,
      extractor: 'official-url-checksum-v1',
      confidence: 1
    });
    for (const claimType of ['title', 'issuer']) {
      const evidence = extracted[claimType];
      if (evidence) upsertEvidence(db, {
        itemId: item.id,
        sourceItemId: item.id,
        claimType,
        status: 'verified',
        value: evidence.value,
        quote: evidence.quote,
        sourceUrl: extracted.sourceUrl,
        confidence: evidence.confidence
      });
    }
    if (extracted.documentNumber) {
      upsertEvidence(db, {
        itemId: item.id,
        sourceItemId: item.id,
        claimType: 'document_number',
        status: 'verified',
        value: extracted.documentNumber.value,
        quote: extracted.documentNumber.quote,
        sourceUrl: extracted.sourceUrl,
        confidence: 1
      });
    } else {
      upsertEvidence(db, {
        itemId: item.id,
        sourceItemId: item.id,
        claimType: 'document_number',
        status: 'not_found',
        searchScope: 'complete queued official source text',
        confidence: 1
      });
    }
    if (extracted.published) upsertEvidence(db, {
      itemId: item.id,
      sourceItemId: item.id,
      claimType: 'published_at',
      status: 'verified',
      value: extracted.published.value,
      quote: extracted.published.quote,
      sourceUrl: extracted.sourceUrl,
      confidence: extracted.published.confidence,
      observedAt: extracted.published.value
    });
    if (extracted.effective) upsertEvidence(db, {
      itemId: item.id,
      sourceItemId: item.id,
      claimType: 'effective_at',
      status: 'verified',
      value: extracted.effective.value,
      quote: extracted.effective.quote,
      sourceUrl: extracted.sourceUrl,
      confidence: extracted.effective.confidence,
      observedAt: extracted.effective.value
    });

    if (missing.length) {
      db.prepare(`
        UPDATE historical_backfill_items SET
          source_status = 'verified', last_error = ?,
          next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+24 hours'),
          attempts = attempts + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(`metadata evidence missing: ${missing.join(', ')}`, item.id);
      db.exec('COMMIT');
      return { complete: false, missing, stage: item.stage };
    }

    let previousEvidenceUrls = [];
    try {
      previousEvidenceUrls = JSON.parse(item.evidence_urls_json || '[]');
    } catch {
      previousEvidenceUrls = [];
    }
    const evidenceUrls = [...new Set([...previousEvidenceUrls, extracted.sourceUrl])];
    db.prepare(`
      UPDATE historical_backfill_items SET
        title = ?, issuer = ?, document_number = ?, published_at = ?, effective_at = ?,
        stage = 'source_verified', source_status = 'verified', metadata_status = 'verified',
        evidence_urls_json = ?, last_error = '', next_attempt_at = NULL, attempts = attempts + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(
      extracted.title.value,
      extracted.issuer.value,
      extracted.documentNumber?.value || '',
      extracted.published.value,
      extracted.effective?.value || null,
      JSON.stringify(evidenceUrls),
      item.id
    );
    db.exec('COMMIT');
    return { complete: true, missing: [], stage: 'source_verified' };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function archiveCoverageComplete(db, sourceYear, options = {}) {
  const currentYear = options.toYear || new Date().getFullYear();
  const sources = loadHistoricalSources(options.historicalSourcesFile);
  for (const source of sources) {
    const sourceEnd = source.coverageEndYear || currentYear;
    if (sourceEnd < sourceYear || source.coverageStartYear > currentYear) continue;
    const neededStart = Math.max(sourceYear, source.coverageStartYear);
    const neededEnd = Math.min(currentYear, sourceEnd);
    const gap = source.knownCoverageGaps.find((entry) => entry.toYear >= neededStart && entry.fromYear <= neededEnd);
    if (gap) return { complete: false, reason: `official archive gap ${gap.fromYear}-${gap.toYear}` };
    const scan = db.prepare(`
      SELECT * FROM historical_source_scans
      WHERE source_id = ? AND from_year <= ? AND to_year >= ? AND complete = 1
      ORDER BY scanned_at DESC LIMIT 1
    `).get(source.id, neededStart, neededEnd);
    if (!scan) return { complete: false, reason: `official archive scan incomplete: ${source.id}` };
  }
  const unresolved = Number(db.prepare(`
    SELECT count(*) AS count FROM historical_backfill_items
    WHERE coalesce(source_year, 9999) >= ?
      AND source_status <> 'rejected'
      AND (
        (item_kind IN ('index', 'issue') AND stage NOT IN ('indexed', 'published'))
        OR (item_kind = 'document' AND stage IN ('discovered', 'failed', 'manual_review'))
      )
  `).get(sourceYear).count);
  if (unresolved > 0) return { complete: false, reason: `${unresolved} later official archive rows are not extracted` };
  return { complete: true, reason: 'configured official archive fully extracted for the lifecycle window' };
}

function relationSentences(text, documentNumber) {
  if (!documentNumber) return [];
  const expected = documentNumberKey(documentNumber);
  return String(text || '').split(/(?<=[。！？])|\n/u)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => extractDocumentNumbers(sentence).some((number) => documentNumberKey(number.value) === expected)
      && (REPEAL_PATTERN.test(sentence) || SUPERSEDE_PATTERN.test(sentence)));
}

function upsertRelation(db, predecessor, successor, relationType, quote, observedAt) {
  const sourceUrl = officialEvidenceUrl(successor.source_url);
  const evidenceId = upsertEvidence(db, {
    itemId: predecessor.id,
    sourceItemId: successor.id,
    claimType: relationType,
    status: 'verified',
    value: successor.document_number || successor.title,
    quote,
    sourceUrl,
    extractor: 'official-lifecycle-link-v2',
    confidence: 1,
    observedAt
  });
  db.prepare(`
    INSERT INTO historical_policy_relations (
      predecessor_item_id, successor_item_id, relation_type, evidence_id, status
    ) VALUES (?, ?, ?, ?, 'verified')
    ON CONFLICT(predecessor_item_id, successor_item_id, relation_type) DO UPDATE SET
      evidence_id = excluded.evidence_id, status = 'verified'
  `).run(predecessor.id, successor.id, relationType, evidenceId);
  return evidenceId;
}

function findLifecycleRelation(db, item) {
  if (!item.document_number) return null;
  const candidates = db.prepare(`
    SELECT * FROM historical_backfill_items
    WHERE id <> ? AND item_kind = 'document'
      AND source_status = 'verified' AND metadata_status = 'verified'
      AND published_at IS NOT NULL AND coalesce(source_year, 0) >= coalesce(?, 0)
    ORDER BY coalesce(published_at, '9999'), id
  `).all(item.id, item.source_year);
  for (const candidate of candidates) {
    const quote = relationSentences(candidate.content_text, item.document_number)[0];
    if (!quote) continue;
    const published = candidate.published_at;
    if (item.published_at && Date.parse(published) < Date.parse(item.published_at)) continue;
    const relationType = REPEAL_PATTERN.test(quote) ? 'repeals' : 'supersedes';
    return { successor: candidate, quote, relationType, endedAt: published };
  }
  return null;
}

function linkPredecessorsMentionedByItem(db, item) {
  if (!item.published_at) return 0;
  let linked = 0;
  const ownNumber = item.document_number;
  const sentences = String(item.content_text || '').split(/(?<=[。！？])|\n/u)
    .map((sentence) => sentence.replace(/\s+/g, ' ').trim())
    .filter((sentence) => REPEAL_PATTERN.test(sentence) || SUPERSEDE_PATTERN.test(sentence));
  for (const sentence of sentences) {
    for (const number of extractDocumentNumbers(sentence)) {
      if (documentNumberKey(number.value) === documentNumberKey(ownNumber)) continue;
      const matches = db.prepare(`
        SELECT * FROM historical_backfill_items
        WHERE trim(document_number) <> '' AND id <> ?
          AND source_status = 'verified' AND metadata_status = 'verified'
      `).all(item.id).filter((candidate) => documentNumberKey(candidate.document_number) === documentNumberKey(number.value));
      if (matches.length !== 1) continue;
      const predecessor = matches[0];
      if (predecessor.published_at && Date.parse(predecessor.published_at) > Date.parse(item.published_at)) continue;
      const relationType = REPEAL_PATTERN.test(sentence) ? 'repeals' : 'supersedes';
      upsertRelation(db, predecessor, item, relationType, sentence, item.published_at);
      upsertEvidence(db, {
        itemId: predecessor.id,
        sourceItemId: item.id,
        claimType: 'repealed_at',
        status: 'verified',
        value: item.published_at,
        quote: sentence,
        sourceUrl: officialEvidenceUrl(item.source_url),
        extractor: 'official-lifecycle-link-v2',
        confidence: 1,
        observedAt: item.published_at
      });
      let cycle = {};
      try {
        cycle = JSON.parse(predecessor.policy_cycle_json || '{}');
      } catch {
        cycle = {};
      }
      cycle.endedAt = item.published_at;
      cycle.endedStatus = 'verified';
      cycle.archiveCoverageComplete = true;
      cycle.searchScope = 'explicit official lifecycle evidence found';
      cycle.checkedAt = new Date().toISOString();
      db.prepare(`
        UPDATE historical_backfill_items SET
          repealed_at = ?, lifecycle_status = 'verified', policy_cycle_json = ?,
          stage = CASE WHEN stage IN ('source_verified', 'ready') THEN 'lifecycle_verified' ELSE stage END,
          analysis_status = CASE WHEN stage = 'ready' THEN 'pending' ELSE analysis_status END,
          last_error = '', next_attempt_at = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(item.published_at, JSON.stringify(cycle), predecessor.id);
      linked += 1;
    }
  }
  return linked;
}

function verifyLifecycle(db, item, options = {}) {
  const sourceUrl = officialEvidenceUrl(item.source_url);
  const effective = extractEffectiveEvidence(item, item.published_at);
  const explicitEnd = extractExplicitEndEvidence(item);
  const relation = explicitEnd ? null : findLifecycleRelation(db, item);
  const coverage = relation || explicitEnd
    ? { complete: true, reason: 'explicit official lifecycle evidence found' }
    : archiveCoverageComplete(db, item.source_year, options);
  db.exec('BEGIN IMMEDIATE');
  try {
    let effectiveStatus = 'not_found';
    if (effective) {
      effectiveStatus = 'verified';
      upsertEvidence(db, {
        itemId: item.id,
        sourceItemId: item.id,
        claimType: 'effective_at',
        status: 'verified',
        value: effective.value,
        quote: effective.quote,
        sourceUrl,
        confidence: effective.confidence,
        observedAt: effective.value
      });
    } else {
      upsertEvidence(db, {
        itemId: item.id,
        sourceItemId: item.id,
        claimType: 'effective_at',
        status: 'not_found',
        searchScope: 'complete queued official source text',
        confidence: 1
      });
    }

    let endedAt = explicitEnd?.value || relation?.endedAt || null;
    let endedStatus = 'pending';
    if (explicitEnd) {
      endedStatus = 'verified';
      upsertEvidence(db, {
        itemId: item.id,
        sourceItemId: item.id,
        claimType: 'repealed_at',
        status: 'verified',
        value: explicitEnd.value,
        quote: explicitEnd.quote,
        sourceUrl,
        confidence: explicitEnd.confidence,
        observedAt: explicitEnd.value
      });
    } else if (relation) {
      endedStatus = 'verified';
      upsertRelation(db, item, relation.successor, relation.relationType, relation.quote, relation.endedAt);
      upsertEvidence(db, {
        itemId: item.id,
        sourceItemId: relation.successor.id,
        claimType: 'repealed_at',
        status: 'verified',
        value: relation.endedAt,
        quote: relation.quote,
        sourceUrl: officialEvidenceUrl(relation.successor.source_url),
        extractor: 'official-lifecycle-link-v2',
        confidence: 1,
        observedAt: relation.endedAt
      });
    } else if (coverage.complete) {
      endedStatus = 'not_found';
      upsertEvidence(db, {
        itemId: item.id,
        claimType: 'repealed_at',
        status: 'not_found',
        searchScope: coverage.reason,
        extractor: 'official-archive-corpus-v2',
        confidence: 1
      });
    }

    const complete = ['verified', 'not_found'].includes(effectiveStatus)
      && ['verified', 'not_found'].includes(endedStatus);
    const cycle = {
      announcedAt: item.published_at,
      effectiveAt: effective?.value || item.effective_at || null,
      effectiveStatus,
      endedAt,
      endedStatus,
      archiveCoverageComplete: coverage.complete,
      searchScope: coverage.reason,
      checkedAt: new Date().toISOString()
    };
    linkPredecessorsMentionedByItem(db, item);
    db.prepare(`
      UPDATE historical_backfill_items SET
        effective_at = coalesce(?, effective_at), repealed_at = coalesce(?, repealed_at),
        lifecycle_status = ?, stage = ?, policy_cycle_json = ?, last_error = ?,
        next_attempt_at = ${complete ? 'NULL' : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+12 hours')"},
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(
      effective?.value || null,
      endedAt,
      complete ? 'verified' : 'pending',
      complete ? 'lifecycle_verified' : 'source_verified',
      JSON.stringify(cycle),
      complete ? '' : coverage.reason,
      item.id
    );
    db.exec('COMMIT');
    return { complete, stage: complete ? 'lifecycle_verified' : 'source_verified', cycle };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function verificationQueueItems(db, maximum) {
  return db.prepare(`
    SELECT * FROM historical_backfill_items
    WHERE item_kind = 'document' AND stage IN ('needs_review', 'source_verified')
      AND (next_attempt_at IS NULL OR next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ORDER BY CASE stage WHEN 'needs_review' THEN 0 ELSE 1 END, coalesce(source_year, 9999), id
    LIMIT ?
  `).all(maximum);
}

function updateVerificationFailure(db, item, error) {
  const attempts = item.attempts + 1;
  const retryHours = Math.min(168, 2 ** Math.min(attempts, 7));
  db.prepare(`
    UPDATE historical_backfill_items SET
      attempts = attempts + 1, last_error = ?,
      next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
  `).run(String(error.message || error).slice(0, 1000), `+${retryHours} hours`, item.id);
}

async function runHistoricalVerificationQueue(db, options = {}, dependencies = {}) {
  const maximum = options.maxItems || 100;
  const minimum = Math.min(maximum, options.minItems || 5);
  const readLoad = dependencies.loadSnapshot || currentLoadSnapshot;
  const initialLoad = readLoad();
  const initialCapacity = options.adaptiveLoad ? adaptiveBatchSize(maximum, minimum, initialLoad) : maximum;
  const items = verificationQueueItems(db, maximum);
  const result = {
    status: 'succeeded', selected: items.length, planned: Math.min(items.length, initialCapacity),
    processed: 0, metadataVerified: 0, lifecycleVerified: 0,
    adaptiveLoad: Boolean(options.adaptiveLoad), load: initialLoad, stoppedDueToLoad: false,
    items: [], errors: []
  };
  for (let index = 0; index < items.length; index += 1) {
    if (options.adaptiveLoad && index >= minimum) {
      if (index >= adaptiveBatchSize(maximum, minimum, readLoad())) {
        result.stoppedDueToLoad = true;
        break;
      }
    } else if (index >= initialCapacity) break;
    const selected = items[index];
    try {
      let item = selected;
      if (item.stage === 'needs_review') {
        const metadata = verifySourceMetadata(db, item);
        result.items.push({ id: item.id, action: metadata.complete ? 'metadata_verified' : 'metadata_pending', missing: metadata.missing });
        result.processed += 1;
        if (!metadata.complete) continue;
        result.metadataVerified += 1;
        item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(item.id);
      }
      const lifecycle = verifyLifecycle(db, item, options);
      if (lifecycle.complete) result.lifecycleVerified += 1;
      result.items.push({ id: item.id, action: lifecycle.complete ? 'lifecycle_verified' : 'lifecycle_pending' });
      if (selected.stage === 'source_verified') result.processed += 1;
    } catch (error) {
      updateVerificationFailure(db, selected, error);
      result.errors.push({ id: selected.id, url: selected.source_url, message: error.message });
    }
  }
  if (result.errors.length) result.status = result.processed ? 'partial' : 'failed';
  return result;
}

module.exports = {
  archiveCoverageComplete,
  checksumMatches,
  dateMentions,
  documentNumberKey,
  extractDocumentNumbers,
  extractEffectiveEvidence,
  extractExplicitEndEvidence,
  extractIssuerEvidence,
  extractPublishedEvidence,
  metadataEvidence,
  parseChineseDate,
  runHistoricalVerificationQueue,
  verifyLifecycle,
  verifySourceMetadata
};
