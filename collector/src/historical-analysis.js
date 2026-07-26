'use strict';

const crypto = require('node:crypto');

const { adaptiveBatchSize, currentLoadSnapshot } = require('./historical-backfill');
const { officialEvidenceUrl } = require('./historical-source');
const { checksumMatches } = require('./historical-verification');

const REVIEW_STATUSES = new Set(['verified', 'partial', 'ambiguous', 'watching']);
const FINAL_EVIDENCE_STATUSES = new Set(['verified', 'not_found', 'not_applicable']);
const CORE_CLAIMS = ['source', 'title', 'issuer', 'published_at'];
const CONFLICT_CLAIMS = ['title', 'issuer', 'document_number', 'published_at', 'effective_at', 'repealed_at'];
const METHODOLOGY = 'historical-evidence-gates-v2';
const MINIMUM_CONFIDENCE = 0.95;

function safeJson(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function officialUrl(value) {
  try {
    return officialEvidenceUrl(value);
  } catch {
    return null;
  }
}

function loadAnalysisInputs(db, item) {
  const verification = db.prepare(`
    SELECT claim_type, status, value_text, evidence_quote, source_url, search_scope,
      extractor, confidence, observed_at, id
    FROM historical_verification_evidence
    WHERE item_id = ?
    ORDER BY claim_type, status, value_text, source_url, evidence_quote, id
  `).all(item.id);
  const evidence = db.prepare(`
    SELECT evidence.evidence_type, evidence.classification, evidence.title,
      evidence.source_url, evidence.evidence_quote, evidence.observed_at,
      evidence.details_json, evidence.extractor, evidence.confidence,
      evidence.source_item_id, evidence.id,
      source.source_status AS evidence_source_status,
      source.metadata_status AS evidence_metadata_status,
      source.source_url AS current_source_url,
      source.published_at AS current_published_at,
      source.checksum AS current_source_checksum,
      CASE WHEN evidence.classification = 'accepted' THEN source.content_text ELSE '' END AS current_source_text
    FROM historical_policy_evidence evidence
    LEFT JOIN historical_backfill_items source ON source.id = evidence.source_item_id
    WHERE evidence.item_id = ?
    ORDER BY evidence.evidence_type, evidence.classification,
      evidence.observed_at, evidence.source_item_id, evidence.id
  `).all(item.id).map((row) => {
    const currentSourceText = String(row.current_source_text || '');
    const enriched = {
      ...row,
      source_checksum_valid: row.classification === 'accepted'
        ? checksumMatches({ content_text: currentSourceText, checksum: row.current_source_checksum })
        : null,
      quote_matches_source: row.classification === 'accepted'
        ? currentSourceText.includes(row.evidence_quote)
        : null
    };
    delete enriched.current_source_text;
    return enriched;
  });
  const searches = db.prepare(`
    SELECT evidence_scope, status, corpus_watermark, candidates_checked,
      accepted_matches, search_scope, searched_at
    FROM historical_evidence_searches
    WHERE item_id = ?
    ORDER BY evidence_scope
  `).all(item.id);
  const relations = db.prepare(`
    SELECT relation.predecessor_item_id, relation.successor_item_id, relation.relation_type,
      relation.status, evidence.evidence_quote, evidence.source_url, evidence.confidence,
      predecessor.checksum AS predecessor_checksum, successor.checksum AS successor_checksum
    FROM historical_policy_relations relation
    JOIN historical_verification_evidence evidence ON evidence.id = relation.evidence_id
    JOIN historical_backfill_items predecessor ON predecessor.id = relation.predecessor_item_id
    JOIN historical_backfill_items successor ON successor.id = relation.successor_item_id
    WHERE relation.predecessor_item_id = ? OR relation.successor_item_id = ?
    ORDER BY relation.predecessor_item_id, relation.successor_item_id, relation.relation_type
  `).all(item.id, item.id);
  const corpusWatermark = Number(db.prepare(`
    SELECT coalesce(max(id), 0) AS id FROM historical_backfill_items
  `).get().id);
  return { verification, evidence, searches, relations, corpusWatermark };
}

function inputChecksum(item, inputs) {
  const snapshot = {
    item: {
      checksum: item.checksum,
      checksumValid: checksumMatches(item),
      sourceUrl: item.source_url,
      title: item.title,
      issuer: item.issuer,
      documentNumber: item.document_number,
      publishedAt: item.published_at,
      effectiveAt: item.effective_at,
      repealedAt: item.repealed_at,
      lifecycleStatus: item.lifecycle_status,
      implementationStatus: item.implementation_status,
      outcomeStatus: item.outcome_status,
      policyCycle: safeJson(item.policy_cycle_json, {})
    },
    verification: inputs.verification,
    evidence: inputs.evidence,
    searches: inputs.searches,
    relations: inputs.relations,
    corpusWatermark: inputs.corpusWatermark
  };
  return crypto.createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex');
}

function verifiedRows(rows, claimType) {
  return rows.filter((row) => row.claim_type === claimType && row.status === 'verified');
}

function notFoundRows(rows, claimType) {
  return rows.filter((row) => row.claim_type === claimType && row.status === 'not_found');
}

function claimConflicts(item, verification, cycle) {
  const ambiguities = [];
  for (const claimType of CONFLICT_CLAIMS) {
    const values = [...new Set(verifiedRows(verification, claimType).map((row) => row.value_text).filter(Boolean))];
    if (values.length > 1) {
      ambiguities.push({
        type: 'conflicting_official_values',
        claimType,
        severity: 'high',
        blocking: true,
        values,
        description: `同一政策的 ${claimType} 存在多个经过摘录的官方值，必须人工复核后才能发布。`
      });
    }
  }
  const published = item.published_at ? Date.parse(item.published_at) : NaN;
  const effective = item.effective_at ? Date.parse(item.effective_at) : NaN;
  const ended = item.repealed_at ? Date.parse(item.repealed_at) : NaN;
  if (Number.isFinite(published) && Number.isFinite(effective) && effective < published) {
    ambiguities.push({
      type: 'invalid_cycle_order', claimType: 'effective_at', severity: 'high', blocking: true,
      values: [item.published_at, item.effective_at],
      description: '核验出的施行日期早于发布日期，需要人工核对日期语境。'
    });
  }
  if (Number.isFinite(ended) && Number.isFinite(effective || published) && ended < (effective || published)) {
    ambiguities.push({
      type: 'invalid_cycle_order', claimType: 'repealed_at', severity: 'high', blocking: true,
      values: [item.effective_at || item.published_at, item.repealed_at],
      description: '核验出的废止日期早于政策生效或发布日期，需要人工复核。'
    });
  }
  if (!cycle || typeof cycle !== 'object' || Array.isArray(cycle)) {
    ambiguities.push({
      type: 'invalid_cycle_record', claimType: 'policy_cycle', severity: 'high', blocking: true,
      values: [], description: '政策周期记录无法解析。'
    });
  }
  return ambiguities;
}

function gate(name, passed, reason) {
  return { name, passed: Boolean(passed), reason };
}

function metadataGate(item, verification, minimumConfidence) {
  const required = [...CORE_CLAIMS, ...(item.document_number ? ['document_number'] : [])];
  const itemValues = {
    title: item.title,
    issuer: item.issuer,
    document_number: item.document_number,
    published_at: item.published_at
  };
  for (const claimType of required) {
    const rows = verifiedRows(verification, claimType);
    if (!rows.length) return gate('metadata_evidence', false, `${claimType} 缺少已核验官方摘录`);
    if (rows.some((row) => !row.evidence_quote.trim() || !officialUrl(row.source_url))) {
      return gate('metadata_evidence', false, `${claimType} 的证据摘录或官方链接无效`);
    }
    if (Math.max(...rows.map((row) => Number(row.confidence))) < minimumConfidence) {
      return gate('metadata_evidence', false, `${claimType} 的证据置信度低于门槛`);
    }
    if (itemValues[claimType] && !rows.some((row) => row.value_text === itemValues[claimType])) {
      return gate('metadata_evidence', false, `${claimType} 当前值与证据值不一致`);
    }
  }
  return gate('metadata_evidence', true, '来源、标题、机构、发布日期及适用文号均有官方逐字证据');
}

function lifecycleGate(item, verification, cycle, minimumConfidence) {
  if (!['verified', 'not_applicable'].includes(item.lifecycle_status)) {
    return gate('lifecycle_evidence', false, '政策周期尚未核验完成');
  }
  if (item.lifecycle_status === 'not_applicable') {
    return gate('lifecycle_evidence', false, '生命周期不适用只能由 human-review-v1 人工核验流程确认');
  }
  if (!cycle.archiveCoverageComplete || !FINAL_EVIDENCE_STATUSES.has(cycle.effectiveStatus)
      || !FINAL_EVIDENCE_STATUSES.has(cycle.endedStatus)) {
    return gate('lifecycle_evidence', false, '官方档案覆盖或生效、废止检索尚未闭合');
  }
  for (const [claimType, status] of [['effective_at', cycle.effectiveStatus], ['repealed_at', cycle.endedStatus]]) {
    if (status === 'verified') {
      const rows = verifiedRows(verification, claimType);
      if (!rows.some((row) => row.evidence_quote.trim() && officialUrl(row.source_url)
          && Number(row.confidence) >= minimumConfidence)) {
        return gate('lifecycle_evidence', false, `${claimType} 缺少达到门槛的官方证据`);
      }
    } else if (status === 'not_found' && !notFoundRows(verification, claimType).some((row) => row.search_scope.trim())) {
      return gate('lifecycle_evidence', false, `${claimType} 的未找到结论缺少完整检索范围`);
    }
  }
  return gate('lifecycle_evidence', true, '生效与废止周期均有官方证据或完整检索边界');
}

function evidenceGate(scope, status, inputs, minimumConfidence) {
  if (!FINAL_EVIDENCE_STATUSES.has(status)) {
    return gate(`${scope}_evidence`, false, `${scope} 仍在等待证据`);
  }
  if (status === 'not_applicable') {
    return gate(`${scope}_evidence`, false, `${scope} 不适用只能由 human-review-v1 人工核验流程确认`);
  }
  const search = inputs.searches.find((row) => row.evidence_scope === scope);
  if (!search || search.status !== 'complete' || !search.search_scope.trim()) {
    return gate(`${scope}_evidence`, false, `${scope} 的官方语料检索尚未完整`);
  }
  if (Number(search.corpus_watermark) !== inputs.corpusWatermark) {
    return gate(`${scope}_evidence`, false, `${scope} 的检索水位已落后于当前私有语料库`);
  }
  const acceptedTypes = scope === 'implementation' ? new Set(['implementation', 'funding']) : new Set(['outcome']);
  const accepted = inputs.evidence.filter((row) => row.classification === 'accepted' && acceptedTypes.has(row.evidence_type));
  if (status === 'not_found') {
    return gate(`${scope}_evidence`, accepted.length === 0 && Number(search.accepted_matches) === 0,
      accepted.length ? `${scope} 标记为未找到但仍存在采纳证据` : `${scope} 在完整官方检索范围内未找到`);
  }
  if (Number(search.accepted_matches) !== accepted.length) {
    return gate(`${scope}_evidence`, false, `${scope} 的检索计数与已采纳证据数量不一致`);
  }
  const valid = accepted.length > 0 && accepted.every((row) => row.evidence_quote.trim()
    && officialUrl(row.source_url)
    && officialUrl(row.current_source_url) === officialUrl(row.source_url)
    && row.evidence_source_status === 'verified'
    && row.evidence_metadata_status === 'verified'
    && row.source_checksum_valid === true
    && row.quote_matches_source === true
    && row.observed_at
    && row.current_published_at === row.observed_at
    && Number(row.confidence) >= minimumConfidence);
  return gate(`${scope}_evidence`, valid,
    valid ? `${scope} 的全部采纳证据均达到来源、引用和置信门槛` : `${scope} 存在来源失效、引用缺失或置信度不足的采纳证据`);
}

function reviewStatusFor(item, ambiguities) {
  if (ambiguities.length) return 'ambiguous';
  const implementation = item.implementation_status === 'verified';
  const outcome = item.outcome_status === 'verified';
  if (implementation && outcome) return 'verified';
  if (implementation || outcome) return 'partial';
  return 'watching';
}

function confidenceFor(item, inputs, minimumConfidence) {
  const values = inputs.verification
    .filter((row) => row.status === 'verified')
    .map((row) => Number(row.confidence))
    .filter(Number.isFinite);
  values.push(...inputs.evidence
    .filter((row) => row.classification === 'accepted')
    .map((row) => Number(row.confidence))
    .filter(Number.isFinite));
  const observed = Math.min(...(values.length ? values : [minimumConfidence]));
  return Number(Math.min(observed, item.implementation_status === 'not_found' && item.outcome_status === 'not_found'
    ? minimumConfidence : 1).toFixed(4));
}

function analysisCitations(inputs) {
  const citations = inputs.verification
    .filter((row) => row.status === 'verified')
    .map((row) => ({
      kind: 'verification',
      claimType: row.claim_type,
      value: row.value_text,
      quote: row.evidence_quote,
      sourceUrl: row.source_url,
      observedAt: row.observed_at,
      confidence: Number(row.confidence)
    }));
  citations.push(...inputs.evidence
    .filter((row) => row.classification === 'accepted')
    .map((row) => ({
      kind: 'policy_evidence',
      evidenceType: row.evidence_type,
      title: row.title,
      quote: row.evidence_quote,
      sourceUrl: row.source_url,
      observedAt: row.observed_at,
      confidence: Number(row.confidence),
      sourceStatus: row.evidence_source_status,
      metadataStatus: row.evidence_metadata_status,
      sourceChecksum: row.current_source_checksum
    })));
  return citations;
}

function buildAnalysis(item, reviewStatus, confidence, ambiguities, gates, inputs) {
  const implementationObserved = item.implementation_status === 'verified';
  const outcomeObserved = item.outcome_status === 'verified';
  const summaries = {
    verified: '已找到明确实施证据和官方结果证据；结果被观察到不等于已经证明由该政策单独造成。',
    partial: `已核验${implementationObserved ? '实施' : '结果'}证据；另一环节在完整官方检索范围内未找到合格证据，未找到不等于未发生。`,
    ambiguous: '关键官方证据之间存在冲突，当前只记录歧义，不选择性采信。',
    watching: '在已完成的官方检索范围内尚未找到明确实施或结果证据；未找到不等于实际未发生。'
  };
  const citations = analysisCitations(inputs);
  const evidenceQuotes = [...new Set(citations.map((entry) => entry.quote).filter(Boolean))];
  return {
    reviewStatus,
    confidence,
    summary: summaries[reviewStatus],
    cycleAssessment: `发布日期 ${item.published_at || '未知'}；施行日期 ${item.effective_at || '未单列'}；废止日期 ${item.repealed_at || '完整检索范围内未找到'}。`,
    implementationAssessment: implementationObserved
      ? '后续官方材料包含已实施、已执行或已拨付的逐字证据。'
      : '完整检索范围内未找到符合门槛的实施或实际拨付证据。',
    outcomeAssessment: outcomeObserved
      ? '结果导向官方材料包含已观察进展或量化结果；本结论不外推政策因果。'
      : '完整检索范围内未找到符合门槛的结果导向官方证据。',
    ambiguities,
    citations,
    evidenceQuotes,
    searchScopes: inputs.searches.map((search) => ({
      scope: search.evidence_scope,
      status: search.status,
      corpusWatermark: Number(search.corpus_watermark),
      candidatesChecked: Number(search.candidates_checked),
      acceptedMatches: Number(search.accepted_matches),
      searchScope: search.search_scope,
      searchedAt: search.searched_at
    })),
    gates,
    methodology: METHODOLOGY
  };
}

function assessHistoricalPolicy(db, item, options = {}) {
  const requestedConfidence = Number(options.minimumConfidence);
  const minimumConfidence = Number.isFinite(requestedConfidence)
    ? Math.min(1, Math.max(MINIMUM_CONFIDENCE, requestedConfidence))
    : MINIMUM_CONFIDENCE;
  const inputs = loadAnalysisInputs(db, item);
  const cycle = safeJson(item.policy_cycle_json, null);
  const ambiguities = claimConflicts(item, inputs.verification, cycle);
  const confidence = confidenceFor(item, inputs, minimumConfidence);
  const gates = [
    gate('private_stage', item.stage === 'lifecycle_verified', '只分析完成生命周期核验的私有条目'),
    gate('source_integrity', checksumMatches(item) && Boolean(officialUrl(item.source_url)), '原文校验和与官方来源链接有效'),
    gate('verification_state', item.source_status === 'verified' && item.metadata_status === 'verified', '来源与核心元数据状态已核验'),
    metadataGate(item, inputs.verification, minimumConfidence),
    lifecycleGate(item, inputs.verification, cycle || {}, minimumConfidence),
    evidenceGate('implementation', item.implementation_status, inputs, minimumConfidence),
    evidenceGate('outcome', item.outcome_status, inputs, minimumConfidence),
    gate('critical_conflicts', ambiguities.length === 0, ambiguities.length ? '存在关键证据冲突，转人工复核' : '未发现关键证据冲突'),
    gate('minimum_confidence', confidence >= minimumConfidence, `最低证据置信度 ${confidence}，门槛 ${minimumConfidence}`)
  ];
  const reviewStatus = reviewStatusFor(item, ambiguities);
  if (!REVIEW_STATUSES.has(reviewStatus)) throw new Error(`unsupported review status: ${reviewStatus}`);
  const releaseEligible = gates.every((entry) => entry.passed);
  const analysis = buildAnalysis(item, reviewStatus, confidence, ambiguities, gates, inputs);
  const fingerprint = inputChecksum(item, inputs);
  const evidenceUrls = [...new Set([
    ...safeJson(item.evidence_urls_json, []),
    item.source_url,
    ...inputs.verification.filter((row) => row.status === 'verified').map((row) => row.source_url),
    ...inputs.evidence.filter((row) => row.classification === 'accepted').map((row) => row.source_url),
    ...inputs.relations.filter((row) => row.status === 'verified').map((row) => row.source_url)
  ].filter((url) => officialUrl(url)).map(officialUrl))];

  db.exec('BEGIN IMMEDIATE');
  try {
    let version = db.prepare(`
      SELECT * FROM historical_analysis_versions WHERE item_id = ? AND input_checksum = ?
    `).get(item.id, fingerprint);
    if (!version) {
      const nextVersion = Number(db.prepare(`
        SELECT coalesce(max(version), 0) + 1 AS version
        FROM historical_analysis_versions WHERE item_id = ?
      `).get(item.id).version);
      const id = Number(db.prepare(`
        INSERT INTO historical_analysis_versions (
          item_id, version, input_checksum, review_status, confidence,
          release_eligible, gates_json, analysis_json, methodology
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.id, nextVersion, fingerprint, reviewStatus, confidence, releaseEligible ? 1 : 0,
        JSON.stringify(gates), JSON.stringify(analysis), METHODOLOGY
      ).lastInsertRowid);
      version = db.prepare('SELECT * FROM historical_analysis_versions WHERE id = ?').get(id);
    }
    const persistedAnalysis = { ...analysis, assessmentVersionId: version.id, assessmentVersion: version.version };
    const failed = gates.filter((entry) => !entry.passed).map((entry) => entry.name);
    db.prepare(`
      UPDATE historical_backfill_items SET
        stage = ?, analysis_status = ?, analysis_json = ?, evidence_urls_json = ?,
        review_notes = ?, reviewed_by = ?, reviewed_at = ?, last_error = ?,
        next_attempt_at = ${releaseEligible ? 'NULL' : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+24 hours')"},
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(
      item.stage,
      releaseEligible ? 'verified' : 'pending',
      JSON.stringify(persistedAnalysis),
      JSON.stringify(evidenceUrls),
      `自动证据核验分类为 ${reviewStatus}；仅描述公开证据链，不推断未公开事实或政策因果。`,
      METHODOLOGY,
      new Date().toISOString(),
      releaseEligible ? 'structured framework pending' : `analysis gates blocked: ${failed.join(', ')}`,
      item.id
    );
    db.exec('COMMIT');
    return { itemId: item.id, reviewStatus, confidence, releaseEligible, version: version.version, failedGates: failed };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function analysisQueueItems(db, maximum) {
  return db.prepare(`
    SELECT * FROM historical_backfill_items
    WHERE item_kind = 'document' AND stage = 'lifecycle_verified' AND analysis_status = 'pending'
      AND implementation_status IN ('verified', 'not_found', 'not_applicable')
      AND outcome_status IN ('verified', 'not_found', 'not_applicable')
      AND (next_attempt_at IS NULL OR next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ORDER BY coalesce(source_year, 9999), id
    LIMIT ?
  `).all(maximum);
}

function updateAnalysisFailure(db, item, error) {
  const retryHours = Math.min(168, 2 ** Math.min(item.attempts + 1, 7));
  db.prepare(`
    UPDATE historical_backfill_items SET attempts = attempts + 1, last_error = ?,
      next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(String(error.message || error).slice(0, 1000), `+${retryHours} hours`, item.id);
}

async function runHistoricalAnalysisQueue(db, options = {}, dependencies = {}) {
  const maximum = options.maxItems || 100;
  const minimum = Math.min(maximum, options.minItems || 5);
  const readLoad = dependencies.loadSnapshot || currentLoadSnapshot;
  const initialLoad = readLoad();
  const capacity = options.adaptiveLoad ? adaptiveBatchSize(maximum, minimum, initialLoad) : maximum;
  const items = analysisQueueItems(db, maximum);
  const result = {
    status: 'succeeded', selected: items.length, planned: Math.min(items.length, capacity),
    processed: 0, ready: 0, awaitingFramework: 0, blocked: 0,
    byStatus: { verified: 0, partial: 0, ambiguous: 0, watching: 0 },
    adaptiveLoad: Boolean(options.adaptiveLoad), load: initialLoad, stoppedDueToLoad: false,
    items: [], errors: []
  };
  for (let index = 0; index < items.length; index += 1) {
    if (options.adaptiveLoad && index >= minimum) {
      if (index >= adaptiveBatchSize(maximum, minimum, readLoad())) {
        result.stoppedDueToLoad = true;
        break;
      }
    } else if (index >= capacity) break;
    const item = items[index];
    try {
      const assessed = assessHistoricalPolicy(db, item, options);
      result.processed += 1;
      result.byStatus[assessed.reviewStatus] += 1;
      if (assessed.releaseEligible) result.awaitingFramework += 1;
      else result.blocked += 1;
      result.items.push(assessed);
    } catch (error) {
      updateAnalysisFailure(db, item, error);
      result.errors.push({ id: item.id, url: item.source_url, message: error.message });
    }
  }
  if (result.errors.length) result.status = result.processed ? 'partial' : 'failed';
  return result;
}

module.exports = {
  METHODOLOGY,
  MINIMUM_CONFIDENCE,
  assessHistoricalPolicy,
  inputChecksum,
  loadAnalysisInputs,
  reviewStatusFor,
  runHistoricalAnalysisQueue
};
