'use strict';

const { adaptiveBatchSize, currentLoadSnapshot } = require('./historical-backfill');
const { officialEvidenceUrl } = require('./historical-review');
const {
  archiveCoverageComplete,
  documentNumberKey,
  extractDocumentNumbers
} = require('./historical-verification');

const MEETING_TITLE = /会议|座谈会|发布会|吹风会|例会|全会|讲话|记者会/u;
const IMPLEMENTATION_TITLE = /实施细则|实施办法|操作细则|申报指南|任务清单|资金管理办法|配套办法/u;
const IMPLEMENTATION_ACTION = /(?:已经|已|正式)(?:启动|实施|执行|办理|开工|建成|投入使用|上线|开展)|(?:完成|落实)(?:了|率|情况|任务)/u;
const FUNDING_ACTION = /(?:已经|已|实际)(?:下达|拨付|发放|支付).{0,100}(?:资金|预算|补助|补贴)|(?:资金|预算|补助|补贴).{0,100}(?:已经|已|实际)(?:下达|拨付|发放|支付)/u;
const OUTCOME_TITLE = /统计公报|执行情况|完成情况|进展情况|评估报告|绩效报告|实施效果|监测报告/u;
const OUTCOME_ACTION = /(?:截至|同比|实际|累计).{0,120}(?:完成|达到|增长|下降|覆盖|减少|增加)|(?:完成|达到|覆盖).{0,80}\d+(?:\.\d+)?(?:%|个百分点|亿元|万元|万人|万户|个|项)/u;
const PLANNING_LANGUAGE = /将|拟|计划|研究|力争|预计|要求|部署|推动|加快|安排/u;

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sentences(text) {
  return String(text || '').split(/(?<=[。！？])|\n/u).map(compact).filter(Boolean);
}

function sentenceReferencesTarget(sentence, target) {
  const number = documentNumberKey(target.document_number);
  if (number && extractDocumentNumbers(sentence)
    .some((entry) => documentNumberKey(entry.value) === number)) return true;
  const title = String(target.title || '').replace(/\s+/g, '');
  return Boolean(title && String(sentence || '').replace(/\s+/g, '').includes(title));
}

function referenceSentence(candidate, target) {
  return sentences(candidate.content_text).find((sentence) => sentenceReferencesTarget(sentence, target)) || '';
}

function linkedActionQuote(text, actionPattern, target) {
  const rows = sentences(text);
  for (let index = 0; index < rows.length; index += 1) {
    if (!actionPattern.test(rows[index])) continue;
    if (sentenceReferencesTarget(rows[index], target)) return rows[index];
    if (index > 0 && sentenceReferencesTarget(rows[index - 1], target)) {
      return `${rows[index - 1]} ${rows[index]}`.slice(0, 1000);
    }
  }
  return '';
}

function plannedOnly(sentence) {
  return Boolean(sentence && PLANNING_LANGUAGE.test(sentence) && !/(?:已经|已|实际|截至|累计|完成|达到)/u.test(sentence));
}

function classifyEvidenceCandidate(target, candidate) {
  const title = compact(candidate.title);
  const content = String(candidate.content_text || '');
  const reference = referenceSentence(candidate, target);
  if (!reference) return [];
  if (MEETING_TITLE.test(title)) {
    return [{
      evidenceType: 'meeting_signal',
      classification: 'excluded',
      quote: reference,
      confidence: 1,
      details: { reason: 'meetings and statements do not prove implementation' }
    }];
  }

  const results = [];
  const fundingQuote = linkedActionQuote(content, FUNDING_ACTION, target);
  if (fundingQuote && !plannedOnly(fundingQuote)) {
    results.push({
      evidenceType: 'funding', classification: 'accepted', quote: fundingQuote, confidence: 0.99,
      details: { reason: 'official text records funds already disbursed or paid' }
    });
    results.push({
      evidenceType: 'implementation', classification: 'accepted', quote: fundingQuote, confidence: 0.98,
      details: { subtype: 'funding', reason: 'paid funding is an observed implementation action' }
    });
  }

  const implementationQuote = IMPLEMENTATION_TITLE.test(title)
    ? title
    : linkedActionQuote(content, IMPLEMENTATION_ACTION, target);
  if (implementationQuote && !plannedOnly(implementationQuote)
      && !results.some((entry) => entry.evidenceType === 'implementation' && entry.quote === implementationQuote)) {
    results.push({
      evidenceType: 'implementation', classification: 'accepted', quote: implementationQuote, confidence: 0.96,
      details: {
        subtype: IMPLEMENTATION_TITLE.test(title) ? 'formal_implementing_instrument' : 'completed_action',
        reason: IMPLEMENTATION_TITLE.test(title)
          ? 'formal implementing instrument explicitly references the target policy'
          : 'official text records a completed or active implementation action'
      }
    });
  }

  const outcomeQuote = OUTCOME_TITLE.test(title) ? linkedActionQuote(content, OUTCOME_ACTION, target) : '';
  if (outcomeQuote && !plannedOnly(outcomeQuote)) {
    results.push({
      evidenceType: 'outcome', classification: 'accepted', quote: outcomeQuote, confidence: 0.95,
      details: { reason: 'official result-oriented document reports observed progress or quantified results' }
    });
  }

  if (!results.length) {
    results.push({
      evidenceType: 'policy_release', classification: 'excluded', quote: reference, confidence: 1,
      details: { reason: 'policy citation or planned action alone does not prove implementation or outcome' }
    });
  }
  return results;
}

function evidenceCandidateSearch(db, item, maximum = 500) {
  const number = String(item.document_number || '').trim();
  const title = String(item.title || '').trim();
  if (!number && !title) return { candidates: [], metadataIncomplete: false, truncated: false, matched: 0 };
  const limit = Math.max(1, Number(maximum) || 500);
  const canonicalNumber = documentNumberKey(number);
  const compactTitle = title.replace(/\s+/g, '');
  const normalizedText = `replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
    content_text, ' ', ''), char(9), ''), char(10), ''), char(13), ''),
    '[', '〔'), '(', '〔'), '（', '〔'), ']', '〕'), ')', '〕'), '）', '〕')`;
  const rawRows = db.prepare(`
    SELECT * FROM historical_backfill_items
    WHERE id <> ? AND item_kind = 'document' AND trim(content_text) <> ''
      AND source_status <> 'rejected'
      AND metadata_status <> 'rejected'
      AND coalesce(source_year, 0) >= coalesce(?, 0)
      AND ((? <> '' AND instr(${normalizedText}, ?) > 0)
        OR (? <> '' AND instr(${normalizedText}, ?) > 0))
    ORDER BY coalesce(published_at, '9999'), id
    LIMIT ?
  `).all(
    item.id,
    item.source_year,
    canonicalNumber,
    canonicalNumber,
    compactTitle,
    compactTitle,
    limit + 1
  );
  const truncated = rawRows.length > limit;
  const rows = rawRows.slice(0, limit)
    .filter((candidate) => referenceSentence(candidate, item));
  const metadataIncomplete = rows.some((candidate) => candidate.source_status !== 'verified'
    || candidate.metadata_status !== 'verified'
    || !candidate.published_at
    || !Number.isFinite(Date.parse(candidate.published_at)));
  return {
    candidates: rows.filter((candidate) => candidate.source_status === 'verified'
      && candidate.metadata_status === 'verified'
      && candidate.published_at
      && Number.isFinite(Date.parse(candidate.published_at))),
    metadataIncomplete,
    truncated,
    matched: rows.length
  };
}

function evidenceCandidates(db, item, maximum = 500) {
  return evidenceCandidateSearch(db, item, maximum).candidates;
}

function upsertPolicyEvidence(db, item, source, evidence, observedAt) {
  const sourceUrl = officialEvidenceUrl(source.source_url);
  db.prepare(`
    INSERT INTO historical_policy_evidence (
      item_id, source_item_id, evidence_type, classification, title, source_url,
      evidence_quote, observed_at, details_json, extractor, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'historical-evidence-v2', ?)
    ON CONFLICT(item_id, source_item_id, evidence_type, evidence_quote) DO UPDATE SET
      classification = excluded.classification,
      title = excluded.title,
      source_url = excluded.source_url,
      observed_at = excluded.observed_at,
      details_json = excluded.details_json,
      extractor = excluded.extractor,
      confidence = excluded.confidence
  `).run(
    item.id,
    source.id,
    evidence.evidenceType,
    evidence.classification,
    source.title,
    sourceUrl,
    evidence.quote,
    observedAt,
    JSON.stringify(evidence.details || {}),
    evidence.confidence
  );
}

function upsertSearch(db, itemId, scope, status, watermark, candidatesChecked, acceptedMatches, searchScope) {
  db.prepare(`
    INSERT INTO historical_evidence_searches (
      item_id, evidence_scope, status, corpus_watermark, candidates_checked,
      accepted_matches, search_scope, searched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(item_id, evidence_scope) DO UPDATE SET
      status = excluded.status,
      corpus_watermark = excluded.corpus_watermark,
      candidates_checked = excluded.candidates_checked,
      accepted_matches = excluded.accepted_matches,
      search_scope = excluded.search_scope,
      searched_at = excluded.searched_at
  `).run(itemId, scope, status, watermark, candidatesChecked, acceptedMatches, searchScope);
}

function publicEvidenceRows(db, itemId, types) {
  const placeholders = types.map(() => '?').join(', ');
  return db.prepare(`
    SELECT evidence_type, title, source_url, evidence_quote, observed_at, details_json, confidence
    FROM historical_policy_evidence
    WHERE item_id = ? AND classification = 'accepted' AND evidence_type IN (${placeholders})
    ORDER BY observed_at, id
  `).all(itemId, ...types).map((row) => ({
    type: row.evidence_type,
    title: row.title,
    sourceUrl: row.source_url,
    evidenceQuote: row.evidence_quote,
    observedAt: row.observed_at,
    details: JSON.parse(row.details_json),
    confidence: Number(row.confidence)
  }));
}

function collectPolicyEvidence(db, item, options = {}) {
  const search = evidenceCandidateSearch(db, item, options.candidateLimit || 500);
  const candidates = search.candidates;
  const targetDate = item.published_at ? Date.parse(item.published_at) : null;
  let checked = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      UPDATE historical_policy_evidence SET
        classification = 'excluded',
        details_json = '{"reason":"not confirmed by latest verified-corpus scan"}',
        extractor = 'historical-evidence-v2'
      WHERE item_id = ? AND classification = 'accepted'
    `).run(item.id);
    for (const candidate of candidates) {
      const observedAt = candidate.published_at;
      if (targetDate !== null && Date.parse(observedAt) < targetDate) continue;
      checked += 1;
      for (const evidence of classifyEvidenceCandidate(item, candidate)) {
        upsertPolicyEvidence(db, item, candidate, evidence, observedAt);
      }
    }

    const implementation = publicEvidenceRows(db, item.id, ['implementation', 'funding']);
    const outcome = publicEvidenceRows(db, item.id, ['outcome']);
    const coverage = archiveCoverageComplete(db, item.source_year, options);
    const corpusComplete = coverage.complete && !search.metadataIncomplete && !search.truncated;
    const implementationStatus = implementation.length ? 'verified' : corpusComplete ? 'not_found' : 'pending';
    const outcomeStatus = outcome.length ? 'verified' : corpusComplete ? 'not_found' : 'pending';
    const watermark = Number(db.prepare('SELECT coalesce(max(id), 0) AS id FROM historical_backfill_items').get().id);
    const searchScope = search.truncated
      ? `candidate limit reached before all strong links were validated: first ${options.candidateLimit || 500} text matches scanned`
      : search.metadataIncomplete
      ? 'strong-link candidates remain excluded until source, metadata, and publication date are verified'
      : coverage.reason;
    upsertSearch(
      db, item.id, 'implementation', corpusComplete ? 'complete' : 'incomplete',
      watermark, checked, implementation.length, searchScope
    );
    upsertSearch(
      db, item.id, 'outcome', corpusComplete ? 'complete' : 'incomplete',
      watermark, checked, outcome.length, searchScope
    );
    const complete = corpusComplete && implementationStatus !== 'pending' && outcomeStatus !== 'pending';
    db.prepare(`
      UPDATE historical_backfill_items SET
        implementation_status = ?, outcome_status = ?, implementation_json = ?, outcome_json = ?,
        last_error = ?, next_attempt_at = ${complete ? 'NULL' : "datetime('now', '+12 hours')"},
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(
      implementationStatus,
      outcomeStatus,
      JSON.stringify(implementation),
      JSON.stringify(outcome),
      complete ? '' : searchScope,
      item.id
    );
    db.exec('COMMIT');
    return {
      complete,
      implementationStatus,
      outcomeStatus,
      implementationEvidence: implementation.length,
      outcomeEvidence: outcome.length,
      candidatesChecked: checked,
      corpusComplete,
      searchScope
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function evidenceQueueItems(db, maximum) {
  return db.prepare(`
    SELECT * FROM historical_backfill_items
    WHERE item_kind = 'document' AND stage = 'lifecycle_verified'
      AND (
        implementation_status = 'pending' OR outcome_status = 'pending'
        OR EXISTS (
          SELECT 1 FROM historical_evidence_searches search
          WHERE search.item_id = historical_backfill_items.id
            AND (
              search.status = 'incomplete'
              OR search.corpus_watermark < (SELECT coalesce(max(id), 0) FROM historical_backfill_items)
            )
        )
        OR EXISTS (
          SELECT 1
          FROM historical_policy_evidence evidence
          LEFT JOIN historical_backfill_items source ON source.id = evidence.source_item_id
          WHERE evidence.item_id = historical_backfill_items.id
            AND evidence.classification = 'accepted'
            AND (
              source.id IS NULL
              OR source.source_status <> 'verified'
              OR source.metadata_status <> 'verified'
              OR source.published_at IS NULL
              OR julianday(source.published_at) IS NULL
            )
        )
      )
      AND (next_attempt_at IS NULL OR next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ORDER BY coalesce(source_year, 9999), id
    LIMIT ?
  `).all(maximum);
}

function updateEvidenceFailure(db, item, error) {
  const attempts = item.attempts + 1;
  const retryHours = Math.min(168, 2 ** Math.min(attempts, 7));
  db.prepare(`
    UPDATE historical_backfill_items SET attempts = attempts + 1, last_error = ?,
      next_attempt_at = datetime('now', ?), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(String(error.message || error).slice(0, 1000), `+${retryHours} hours`, item.id);
}

async function runHistoricalEvidenceQueue(db, options = {}, dependencies = {}) {
  const maximum = options.maxItems || 100;
  const minimum = Math.min(maximum, options.minItems || 5);
  const readLoad = dependencies.loadSnapshot || currentLoadSnapshot;
  const initialLoad = readLoad();
  const initialCapacity = options.adaptiveLoad ? adaptiveBatchSize(maximum, minimum, initialLoad) : maximum;
  const items = evidenceQueueItems(db, maximum);
  const result = {
    status: 'succeeded', selected: items.length, planned: Math.min(items.length, initialCapacity),
    processed: 0, completed: 0, implementationVerified: 0, outcomeVerified: 0,
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
    const item = items[index];
    try {
      const collected = collectPolicyEvidence(db, item, options);
      result.processed += 1;
      if (collected.complete) result.completed += 1;
      if (collected.implementationStatus === 'verified') result.implementationVerified += 1;
      if (collected.outcomeStatus === 'verified') result.outcomeVerified += 1;
      result.items.push({ id: item.id, action: collected.complete ? 'evidence_complete' : 'evidence_pending', ...collected });
    } catch (error) {
      updateEvidenceFailure(db, item, error);
      result.errors.push({ id: item.id, url: item.source_url, message: error.message });
    }
  }
  if (result.errors.length) result.status = result.processed ? 'partial' : 'failed';
  return result;
}

module.exports = {
  classifyEvidenceCandidate,
  collectPolicyEvidence,
  evidenceCandidateSearch,
  evidenceCandidates,
  runHistoricalEvidenceQueue
};
