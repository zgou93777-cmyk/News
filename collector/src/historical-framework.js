'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { adaptiveBatchSize, currentLoadSnapshot } = require('./historical-backfill');
const { checksumMatches } = require('./historical-verification');
const {
  completionsUrl,
  hasModelConfig,
  loadModelConfig
} = require('./model');

const DEFAULT_PROMPT_PATH = path.resolve(__dirname, '..', '..', 'prompts', 'analyze-historical-policy.md');
const METHOD = 'historical-policy-judgment-v2';
const PROMPT_VERSION = 'analyze-historical-policy-v2';
const MAX_EVIDENCE_SOURCES = 12;
const MAX_CURRENT_SOURCE_TEXT = 80_000;
const MAX_RELATED_SOURCE_TEXT = 30_000;
const DEFAULT_MODEL_TIMEOUT_MS = 240_000;
const DEFAULT_MODEL_CONCURRENCY = 2;
const MAX_MODEL_CONCURRENCY = 4;

function safeJson(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function asText(value, maximum = 1000) {
  if (typeof value === 'string') return value.trim().slice(0, maximum);
  if (value == null) return '';
  return String(value).trim().slice(0, maximum);
}

function officialUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.port
        || (hostname !== 'gov.cn' && !hostname.endsWith('.gov.cn'))) return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function normalizedIncludes(text, quote) {
  const value = String(quote || '');
  return value.replace(/\s+/g, '').length >= 4 && String(text || '').includes(value);
}

function sourceRecord(row, roles) {
  return {
    id: `item:${row.id}`,
    itemId: Number(row.id),
    roles: [...new Set(roles)].sort(),
    title: row.title,
    issuer: row.issuer,
    publishedAt: row.published_at,
    sourceUrl: officialUrl(row.source_url),
    checksum: row.checksum,
    text: row.content_text
  };
}

function loadFrameworkEvidence(db, item, assessment) {
  const candidates = new Map();
  const add = (row, role) => {
    if (!row || !checksumMatches(row) || row.source_status !== 'verified'
        || row.metadata_status !== 'verified' || !officialUrl(row.source_url)) return;
    const key = Number(row.id);
    const existing = candidates.get(key);
    if (existing) existing.roles.add(role);
    else candidates.set(key, { row, roles: new Set([role]) });
  };
  add(item, 'current_policy');

  const relations = db.prepare(`
    SELECT relation.relation_type, relation.predecessor_item_id, relation.successor_item_id,
      predecessor.*, successor.id AS successor_id, successor.source_url AS successor_source_url,
      successor.title AS successor_title, successor.issuer AS successor_issuer,
      successor.published_at AS successor_published_at, successor.content_text AS successor_content_text,
      successor.checksum AS successor_checksum, successor.source_status AS successor_source_status,
      successor.metadata_status AS successor_metadata_status
    FROM historical_policy_relations relation
    JOIN historical_backfill_items predecessor ON predecessor.id = relation.predecessor_item_id
    JOIN historical_backfill_items successor ON successor.id = relation.successor_item_id
    WHERE relation.status = 'verified'
      AND (relation.predecessor_item_id = ? OR relation.successor_item_id = ?)
    ORDER BY coalesce(predecessor.published_at, ''), relation.id
  `).all(item.id, item.id);
  for (const relation of relations) {
    const predecessor = relation;
    const successor = {
      id: relation.successor_id,
      source_url: relation.successor_source_url,
      title: relation.successor_title,
      issuer: relation.successor_issuer,
      published_at: relation.successor_published_at,
      content_text: relation.successor_content_text,
      checksum: relation.successor_checksum,
      source_status: relation.successor_source_status,
      metadata_status: relation.successor_metadata_status
    };
    if (Number(predecessor.id) !== Number(item.id)) add(predecessor, 'verified_predecessor');
    if (Number(successor.id) !== Number(item.id)) add(successor, 'verified_successor');
  }

  const evidenceRows = db.prepare(`
    SELECT source.*, evidence.evidence_type
    FROM historical_policy_evidence evidence
    JOIN historical_backfill_items source ON source.id = evidence.source_item_id
    WHERE evidence.item_id = ? AND evidence.classification = 'accepted'
    ORDER BY evidence.observed_at, evidence.id
  `).all(item.id);
  for (const row of evidenceRows) add(row, `verified_${row.evidence_type}`);

  const ordered = [...candidates.values()]
    .sort((left, right) => {
      const leftCurrent = left.roles.has('current_policy') ? 0 : 1;
      const rightCurrent = right.roles.has('current_policy') ? 0 : 1;
      return leftCurrent - rightCurrent
        || String(left.row.published_at || '').localeCompare(String(right.row.published_at || ''))
        || Number(left.row.id) - Number(right.row.id);
    })
    .slice(0, MAX_EVIDENCE_SOURCES)
    .map(({ row, roles }) => sourceRecord(row, roles));
  if (assessment.methodology === 'human-review-v1') {
    for (const [kind, json] of [
      ['implementation', item.implementation_json],
      ['outcome', item.outcome_json]
    ]) {
      const rows = safeJson(json, []);
      for (let index = 0; index < rows.length && ordered.length < MAX_EVIDENCE_SOURCES; index += 1) {
        const row = rows[index];
        const sourceUrl = officialUrl(row.sourceUrl);
        const quote = asText(row.evidenceQuote, 4000);
        if (!sourceUrl || !quote) continue;
        ordered.push({
          id: `review:${kind}:${index}`,
          itemId: null,
          roles: [`human_verified_${kind}`],
          title: asText(row.title, 300),
          issuer: '',
          publishedAt: row.observedAt || null,
          sourceUrl,
          checksum: sha256(quote),
          text: quote
        });
      }
    }
  }
  const input = {
    assessmentInputChecksum: assessment.input_checksum,
    promptVersion: PROMPT_VERSION,
    sources: ordered.map((source) => ({
      id: source.id,
      roles: source.roles,
      checksum: source.checksum,
      sourceUrl: source.sourceUrl
    }))
  };
  return { sources: ordered, inputChecksum: sha256(JSON.stringify(canonicalJson(input))) };
}

function evidenceReference(value, sourceMap) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let sourceId = asText(value.source_id || value.sourceId || value.id, 80);
  const quote = asText(value.quote || value.evidence_quote || value.evidenceQuote, 800);
  let source = sourceMap.get(sourceId);
  if (!source && sourceId === 'current_policy') {
    source = [...sourceMap.values()].find((entry) => entry.roles.includes('current_policy'));
    sourceId = source?.id || sourceId;
  }
  if (!source || !quote || !normalizedIncludes(source.text, quote)) return null;
  return {
    sourceId,
    sourceItemId: source.itemId,
    sourceUrl: source.sourceUrl,
    title: source.title,
    roles: source.roles,
    quote
  };
}

function evidenceReferences(value, sourceMap) {
  const rows = Array.isArray(value) ? value : [];
  const unique = new Map();
  for (const row of rows) {
    const normalized = evidenceReference(row, sourceMap);
    if (normalized) unique.set(`${normalized.sourceId}\n${normalized.quote}`, normalized);
  }
  return [...unique.values()];
}

function structuredItems(value, sourceMap) {
  return (Array.isArray(value) ? value : []).slice(0, 8).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const label = asText(entry.label || entry.name || entry.step || entry.group || entry.title, 120);
    const detail = asText(entry.detail || entry.description || entry.mechanism || entry.effect
      || entry.action || entry.responsibility, 1200);
    const evidence = evidenceReferences(entry.evidence_refs || entry.evidenceRefs || entry.evidence, sourceMap);
    return label && detail ? { label, detail, evidence } : null;
  }).filter(Boolean);
}

function historicalChanges(value, sourceMap) {
  return (Array.isArray(value) ? value : []).slice(0, 8).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const dimension = asText(entry.dimension || entry.aspect, 120);
    const previous = asText(entry.previous || entry.before || entry.historical, 1200);
    const current = asText(entry.current || entry.now || entry.latest, 1200);
    const implication = asText(entry.implication || entry.impact || entry.meaning, 1200);
    const evidence = evidenceReferences(entry.evidence_refs || entry.evidenceRefs || entry.evidence, sourceMap);
    const hasCurrent = evidence.some((row) => row.roles.includes('current_policy'));
    const hasHistorical = evidence.some((row) => row.roles.includes('verified_predecessor')
      || row.roles.includes('verified_successor'));
    if (![dimension, previous, current, implication].every(Boolean) || !hasCurrent || !hasHistorical) return null;
    return { dimension, previous, current, implication, evidence };
  }).filter(Boolean);
}

function textSection(value, evidenceValue, sourceMap, maximum = 1500) {
  const input = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : { text: value, evidence_refs: evidenceValue };
  return {
    text: asText(input.text || input.detail || input.conclusion || input.narrative, maximum),
    evidence: evidenceReferences(
      input.evidence_refs || input.evidenceRefs || input.evidence || evidenceValue,
      sourceMap
    )
  };
}

function boundedSignalConfidence(value) {
  const named = {
    '高': 0.8,
    '较高': 0.7,
    '中等': 0.5,
    '中': 0.5,
    '较低': 0.35,
    '低': 0.2
  };
  const numeric = Number(Object.hasOwn(named, value) ? named[value] : value);
  return Number.isFinite(numeric) ? Number(Math.min(1, Math.max(0, numeric)).toFixed(2)) : null;
}

function normalizeForwardSignals(value, sourceMap) {
  return (Array.isArray(value) ? value : []).slice(0, 6).map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const signal = asText(entry.signal || entry.statement || entry.title, 1000);
    const basis = asText(entry.basis || entry.reason || entry.rationale, 1500);
    const timeWindow = asText(entry.time_window || entry.timeWindow || entry.window || entry.timeframe, 160);
    const expectedByValue = asText(entry.expected_by || entry.expectedBy, 20);
    const expectedBy = /^\d{4}-\d{2}-\d{2}$/.test(expectedByValue) ? expectedByValue : null;
    const confidence = boundedSignalConfidence(entry.confidence);
    const prerequisites = asText(entry.prerequisites || entry.preconditions || entry.conditions, 1000);
    const disconfirmingEvidence = asText(
      entry.disconfirming_evidence || entry.disconfirmingEvidence
        || entry.disproof_condition || entry.counterevidence,
      1000
    );
    const evidence = evidenceReferences(
      entry.evidence_refs || entry.evidenceRefs || entry.evidence,
      sourceMap
    );
    if (!signal || !basis || !timeWindow || confidence == null || !prerequisites
        || !disconfirmingEvidence || !evidence.length) return null;
    return {
      signal,
      basis,
      timeWindow,
      expectedBy,
      confidence,
      prerequisites,
      disconfirmingEvidence,
      evidence
    };
  }).filter(Boolean);
}

function assessmentReferences(assessmentAnalysis, sourceMap, evidenceType) {
  const references = [];
  for (const citation of assessmentAnalysis.citations || []) {
    if (citation.kind !== 'policy_evidence' || citation.evidenceType !== evidenceType) continue;
    const source = [...sourceMap.values()].find((entry) => (
      entry.sourceUrl === officialUrl(citation.sourceUrl) && normalizedIncludes(entry.text, citation.quote)
    ));
    if (!source) continue;
    const reference = evidenceReference({ source_id: source.id, quote: citation.quote }, sourceMap);
    if (reference) references.push(reference);
  }
  for (const source of sourceMap.values()) {
    if (!source.roles.includes(`verified_${evidenceType}`)
        && !source.roles.includes(`human_verified_${evidenceType}`)) continue;
    const reference = evidenceReference({ source_id: source.id, quote: source.text.slice(0, 800) }, sourceMap);
    if (reference) references.push(reference);
  }
  return [...new Map(references.map((entry) => [`${entry.sourceId}\n${entry.quote}`, entry])).values()];
}

function realizationAssessment(assessmentAnalysis, sourceMap, policyEvidence) {
  const implementationEvidence = assessmentReferences(assessmentAnalysis, sourceMap, 'implementation');
  const fundingEvidence = assessmentReferences(assessmentAnalysis, sourceMap, 'funding');
  const outcomeEvidence = assessmentReferences(assessmentAnalysis, sourceMap, 'outcome');
  const reviewStatus = ['verified', 'partial', 'ambiguous', 'watching'].includes(assessmentAnalysis.reviewStatus)
    ? assessmentAnalysis.reviewStatus
    : 'watching';
  const stage = (evidence, found, missing) => ({
    status: evidence.length ? 'verified' : 'not_found',
    conclusion: evidence.length ? found : missing,
    evidence
  });
  return {
    policyRelease: {
      status: 'confirmed',
      conclusion: '正式政策文本及核心元数据已经核验。',
      evidence: policyEvidence.slice(0, 2)
    },
    implementation: stage(
      implementationEvidence,
      '已找到达到门槛的正式实施或执行证据。',
      '在已完成的官方检索范围内未找到达到门槛的实施证据。'
    ),
    funding: stage(
      fundingEvidence,
      '已找到达到门槛的实际资金安排或拨付证据。',
      '在已完成的官方检索范围内未找到达到门槛的实际资金证据。'
    ),
    outcomes: stage(
      outcomeEvidence,
      '已找到达到门槛的官方结果证据；观察到结果不等于已证明单一政策因果。',
      '在已完成的官方检索范围内未找到达到门槛的结果证据。'
    ),
    realizationStatus: reviewStatus,
    conclusion: asText(assessmentAnalysis.summary, 1500)
      || '兑现判断尚缺少完整的官方证据检索结果。'
  };
}

function normalizeHistoricalFramework(payload, evidenceBundle, assessmentAnalysis = {}) {
  const sourceMap = new Map(evidenceBundle.sources.map((source) => [source.id, source]));
  const input = payload?.policy_analysis && typeof payload.policy_analysis === 'object'
    ? payload.policy_analysis
    : payload || {};
  const problemInput = input.policy_problem && typeof input.policy_problem === 'object'
    ? input.policy_problem
    : {
        text: input.policy_problem || input.problem,
        evidence_refs: input.policy_problem_evidence_refs || input.problemEvidence
      };
  const problem = asText(problemInput.text || problemInput.detail || problemInput.problem, 1500);
  const problemEvidence = evidenceReferences(
    problemInput.evidence_refs || problemInput.evidenceRefs || problemInput.evidence,
    sourceMap
  );
  const tools = structuredItems(input.policy_tools || input.tools, sourceMap);
  const affectedGroups = structuredItems(input.affected_groups || input.affectedGroups, sourceMap);
  const executionPath = structuredItems(input.execution_path || input.executionPath, sourceMap);
  const changes = historicalChanges(input.historical_comparison || input.historicalChanges, sourceMap);
  const finalSection = textSection(
    input.final_conclusion || input.finalConclusion,
    input.final_conclusion_evidence_refs || input.finalConclusionEvidence,
    sourceMap,
    1500
  );
  const evolutionSection = textSection(
    input.evolution_narrative || input.evolutionNarrative,
    input.evolution_evidence_refs || input.evolutionEvidence,
    sourceMap,
    2000
  );
  const signals = normalizeForwardSignals(input.forward_signals || input.forwardSignals, sourceMap);
  const missing = [];
  if (!problem || !problemEvidence.length) missing.push('policy_problem');
  if (!tools.length || tools.some((entry) => !entry.evidence.length)) missing.push('policy_tools');
  if (!affectedGroups.length || affectedGroups.some((entry) => !entry.evidence.length)) missing.push('affected_groups');
  if (!executionPath.length || executionPath.some((entry) => !entry.evidence.length)) missing.push('execution_path');
  const rawBottomLine = asText(input.bottom_line || input.bottomLine || payload?.summary, 1000);
  if (!rawBottomLine) missing.push('bottom_line');
  if (!finalSection.text || !finalSection.evidence.length) missing.push('final_conclusion');
  if (changes.length && (!evolutionSection.text || !evolutionSection.evidence.length)) {
    missing.push('evolution_narrative');
  }
  if (!signals.length) missing.push('forward_signals');
  const bottomLine = rawBottomLine
    || '结构化政策解读尚未完成，当前条目继续保持私有。';
  const confirmed = (assessmentAnalysis.citations || []).map((entry) => asText(entry.quote, 800)).filter(Boolean).slice(0, 8);
  const unconfirmed = (assessmentAnalysis.ambiguities || []).map((entry) => (
    typeof entry === 'string' ? entry : asText(entry.description || entry.title, 800)
  )).filter(Boolean).slice(0, 8);
  if (missing.length) unconfirmed.push(`结构化解读缺少可回链证据：${[...new Set(missing)].join('、')}`);
  const framework = {
    ready: missing.length === 0,
    perspective: '政策演进、实际落地与下一步方向',
    perspectiveNote: '从政策要解决的问题出发，比较历史变化，核对实施、资金和结果，再基于公开证据判断下一步；不把政策表态、市场反应或行业愿望当成兑现事实。',
    bottomLine,
    finalConclusion: finalSection.text || bottomLine,
    finalConclusionEvidence: finalSection.evidence,
    problem,
    problemEvidence,
    tools,
    affectedGroups,
    executionPath,
    historicalChanges: changes,
    historyBoundary: asText(input.history_boundary || input.historyBoundary, 1000)
      || (changes.length ? '' : '现有已核验关系不足以支持实质历史对比，暂不外推政策演变。'),
    evolutionNarrative: evolutionSection.text
      || (changes.length ? '' : asText(input.history_boundary || input.historyBoundary, 1000)),
    evolutionEvidence: evolutionSection.evidence,
    implementationAssessment: realizationAssessment(assessmentAnalysis, sourceMap, problemEvidence),
    forwardSignals: signals,
    confirmed,
    unconfirmed: [...new Set(unconfirmed)]
  };
  const citations = [
    ...problemEvidence,
    ...tools.flatMap((entry) => entry.evidence),
    ...affectedGroups.flatMap((entry) => entry.evidence),
    ...executionPath.flatMap((entry) => entry.evidence),
    ...changes.flatMap((entry) => entry.evidence),
    ...finalSection.evidence,
    ...evolutionSection.evidence,
    ...signals.flatMap((entry) => entry.evidence)
  ];
  const evidence = [...new Map(citations.map((entry) => [`${entry.sourceId}\n${entry.quote}`, entry])).values()];
  return { framework, evidence, missing: [...new Set(missing)] };
}

async function requestHistoricalFramework(item, assessment, evidenceBundle, modelConfig, options = {}) {
  const prompt = fs.readFileSync(options.promptPath || DEFAULT_PROMPT_PATH, 'utf8');
  const body = {
    model: modelConfig.modelName,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: prompt },
      {
        role: 'user',
        content: JSON.stringify({
          policy: {
            item_id: item.id,
            title: item.title,
            issuer: item.issuer,
            document_number: item.document_number,
            published_at: item.published_at,
            effective_at: item.effective_at,
            repealed_at: item.repealed_at,
            official_url: item.source_url
          },
          verified_assessment: safeJson(assessment.analysis_json, {}),
          evidence_sources: evidenceBundle.sources.map((source) => ({
            source_id: source.id,
            roles: source.roles,
            title: source.title,
            issuer: source.issuer,
            published_at: source.publishedAt,
            official_url: source.sourceUrl,
            official_text: source.text.slice(
              0,
              source.roles.includes('current_policy') ? MAX_CURRENT_SOURCE_TEXT : MAX_RELATED_SOURCE_TEXT
            )
          }))
        })
      }
    ]
  };
  const response = await (options.fetchImpl || fetch)(completionsUrl(modelConfig.baseUrl), {
    method: 'POST',
    headers: { Authorization: `Bearer ${modelConfig.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.modelTimeoutMs || options.timeoutMs || DEFAULT_MODEL_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`historical framework model API returned HTTP ${response.status}`);
  const result = await response.json();
  const content = String(result?.choices?.[0]?.message?.content || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!content) throw new Error('historical framework model response did not contain content');
  const payload = JSON.parse(content);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('historical framework model response must be a JSON object');
  }
  return payload;
}

function storeFrameworkVersion(db, item, assessment, evidenceBundle, normalized, rawPayload, modelName) {
  const frameworkJson = JSON.stringify(normalized.framework);
  const evidenceJson = JSON.stringify(normalized.evidence);
  const responseChecksum = sha256(JSON.stringify(canonicalJson(rawPayload)));
  let stored = db.prepare(`
    SELECT * FROM historical_analysis_frameworks
    WHERE assessment_version_id = ? AND response_checksum = ?
  `).get(assessment.id, responseChecksum);
  if (!stored) {
    const version = Number(db.prepare(`
      SELECT coalesce(max(version), 0) + 1 AS version
      FROM historical_analysis_frameworks WHERE assessment_version_id = ?
    `).get(assessment.id).version);
    const id = Number(db.prepare(`
      INSERT INTO historical_analysis_frameworks (
        assessment_version_id, version, source_checksum, input_checksum,
        response_checksum, framework_json, evidence_json, method, model_name, prompt_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assessment.id, version, item.checksum, evidenceBundle.inputChecksum,
      responseChecksum, frameworkJson, evidenceJson, METHOD, modelName, PROMPT_VERSION
    ).lastInsertRowid);
    stored = db.prepare('SELECT * FROM historical_analysis_frameworks WHERE id = ?').get(id);
  }
  return stored;
}

function frameworkIsCurrent(db, item, assessment, row) {
  if (!row || row.source_checksum !== item.checksum || row.prompt_version !== PROMPT_VERSION) return false;
  const framework = safeJson(row.framework_json, null);
  if (!framework?.ready || !Array.isArray(safeJson(row.evidence_json, null))) return false;
  const evidenceBundle = loadFrameworkEvidence(db, item, assessment);
  if (evidenceBundle.inputChecksum !== row.input_checksum) return false;
  const normalized = normalizeHistoricalFramework(framework, evidenceBundle, safeJson(assessment.analysis_json, {}));
  return normalized.framework.ready && normalized.evidence.length > 0;
}

function latestReadyFramework(db, item, assessment) {
  const rows = db.prepare(`
    SELECT * FROM historical_analysis_frameworks
    WHERE assessment_version_id = ?
      AND json_extract(framework_json, '$.ready') IS 1
    ORDER BY version DESC, id DESC
  `).all(assessment.id);
  return rows.find((row) => frameworkIsCurrent(db, item, assessment, row)) || null;
}

function finalizeFramework(db, item, assessment, framework) {
  const analysis = safeJson(item.analysis_json, {});
  if (Number(analysis.assessmentVersionId) !== Number(assessment.id)) {
    throw new Error('historical item assessment mapping changed before framework finalization');
  }
  const persisted = {
    ...analysis,
    frameworkVersionId: Number(framework.id),
    frameworkVersion: Number(framework.version)
  };
  db.prepare(`
    UPDATE historical_backfill_items SET
      stage = 'ready', analysis_status = 'verified', analysis_json = ?,
      last_error = '', next_attempt_at = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(JSON.stringify(persisted), item.id);
  return persisted;
}

function frameworkQueueItems(db, maximum) {
  return db.prepare(`
    SELECT item.*, assessment.id AS framework_assessment_id
    FROM historical_backfill_items item
    JOIN historical_analysis_versions assessment
      ON assessment.id = CAST(json_extract(item.analysis_json, '$.assessmentVersionId') AS INTEGER)
      AND assessment.item_id = item.id
    WHERE item.item_kind = 'document' AND item.stage = 'lifecycle_verified'
      AND item.analysis_status = 'verified' AND assessment.release_eligible = 1
      AND (item.next_attempt_at IS NULL OR item.next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ORDER BY coalesce(item.source_year, 0) DESC, item.id DESC
    LIMIT ?
  `).all(maximum);
}

function updateFrameworkFailure(db, item, message) {
  const detail = String(message).slice(0, 1000);
  const transient = /timeout|timed out|HTTP (?:408|429|5\d\d)|network|fetch failed/i.test(detail);
  const retryDelay = transient ? '+30 minutes' : '+6 hours';
  db.prepare(`
    UPDATE historical_backfill_items SET attempts = attempts + 1, last_error = ?,
      next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(detail, retryDelay, item.id);
}

async function runHistoricalFrameworkQueue(db, options = {}, dependencies = {}) {
  const maximum = options.maxItems || 100;
  const minimum = Math.min(maximum, options.minItems || 5);
  const readLoad = dependencies.loadSnapshot || currentLoadSnapshot;
  const initialLoad = readLoad();
  const capacity = options.adaptiveLoad ? adaptiveBatchSize(maximum, minimum, initialLoad) : maximum;
  const modelTimeoutMs = options.modelTimeoutMs || DEFAULT_MODEL_TIMEOUT_MS;
  const modelConcurrency = Math.max(1, Math.min(
    Number(options.modelConcurrency || DEFAULT_MODEL_CONCURRENCY),
    MAX_MODEL_CONCURRENCY,
    capacity
  ));
  const modelConfig = options.modelConfig || loadModelConfig();
  const mode = options.analysisMode || 'auto';
  const items = frameworkQueueItems(db, maximum);
  if (mode === 'rules' || (mode === 'auto' && !hasModelConfig(modelConfig))) {
    return {
      status: 'succeeded', selected: items.length, planned: 0, processed: 0, ready: 0,
      incomplete: 0, skipped: true,
      reason: mode === 'rules'
        ? 'rules mode cannot satisfy the cited structured-framework gate'
        : 'model configuration is absent; structured historical items remain private',
      adaptiveLoad: Boolean(options.adaptiveLoad), load: initialLoad, stoppedDueToLoad: false,
      modelTimeoutMs, modelConcurrency,
      items: [], errors: []
    };
  }
  if (!hasModelConfig(modelConfig)) {
    throw new Error('historical framework analysis requires MODEL_BASE_URL, MODEL_API_KEY and MODEL_NAME');
  }
  const result = {
    status: 'succeeded', selected: items.length, planned: Math.min(items.length, capacity),
    processed: 0, ready: 0, incomplete: 0, skipped: false,
    adaptiveLoad: Boolean(options.adaptiveLoad), load: initialLoad, stoppedDueToLoad: false,
    modelTimeoutMs, modelConcurrency,
    items: [], errors: []
  };
  const processItem = async (item) => {
    const assessment = db.prepare('SELECT * FROM historical_analysis_versions WHERE id = ?')
      .get(item.framework_assessment_id);
    try {
      let framework = latestReadyFramework(db, item, assessment);
      if (!framework) {
        const evidenceBundle = loadFrameworkEvidence(db, item, assessment);
        const request = dependencies.requestFramework || requestHistoricalFramework;
        const payload = await request(item, assessment, evidenceBundle, modelConfig, options);
        const normalized = normalizeHistoricalFramework(payload, evidenceBundle, safeJson(assessment.analysis_json, {}));
        framework = storeFrameworkVersion(
          db, item, assessment, evidenceBundle, normalized, payload,
          `openai-compatible:${modelConfig.modelName}`
        );
        if (!normalized.framework.ready) {
          result.processed += 1;
          result.incomplete += 1;
          updateFrameworkFailure(db, item, `structured framework incomplete: ${normalized.missing.join(', ')}`);
          result.items.push({
            itemId: item.id, action: 'kept_private', frameworkVersion: framework.version,
            missing: normalized.missing
          });
          return;
        }
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        finalizeFramework(db, item, assessment, framework);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      result.processed += 1;
      result.ready += 1;
      result.items.push({ itemId: item.id, action: 'ready', frameworkVersion: framework.version });
    } catch (error) {
      updateFrameworkFailure(db, item, error.message || error);
      result.errors.push({ id: item.id, url: item.source_url, message: error.message });
    }
  };
  for (let index = 0; index < items.length && index < capacity;) {
    let allowed = capacity;
    if (options.adaptiveLoad && index >= minimum) {
      allowed = Math.min(capacity, adaptiveBatchSize(maximum, minimum, readLoad()));
      if (index >= allowed) {
        result.stoppedDueToLoad = true;
        break;
      }
    }
    const batchSize = Math.min(modelConcurrency, allowed - index, items.length - index);
    await Promise.all(items.slice(index, index + batchSize).map(processItem));
    index += batchSize;
  }
  if (result.errors.length) result.status = result.processed ? 'partial' : 'failed';
  return result;
}

module.exports = {
  DEFAULT_PROMPT_PATH,
  METHOD,
  PROMPT_VERSION,
  finalizeFramework,
  frameworkIsCurrent,
  latestReadyFramework,
  loadFrameworkEvidence,
  normalizeHistoricalFramework,
  requestHistoricalFramework,
  runHistoricalFrameworkQueue,
  storeFrameworkVersion
};
