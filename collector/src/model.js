'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  completionsUrl,
  hasModelConfig,
  loadModelConfig
} = require('../../server/src/model-config');

const DEFAULT_PROMPT_PATH = path.resolve(__dirname, '..', '..', 'prompts', 'analyze-policy.md');

function parseJsonContent(value) {
  const trimmed = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('model response must be a JSON object');
  }
  return parsed;
}

function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    return Object.entries(value).map(([key, item]) => `${key}：${asText(item)}`).join('\n');
  }
  return value == null ? '' : String(value);
}

function boundedConfidence(value, fallback = 0.5) {
  let number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (number > 1 && number <= 100) number /= 100;
  return Math.max(0, Math.min(1, number));
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function quoteExistsInDocument(quote, contentText) {
  const normalizedQuote = String(quote || '').replace(/\s+/g, '');
  const normalizedContent = String(contentText || '').replace(/\s+/g, '');
  return normalizedQuote.length >= 4 && normalizedContent.includes(normalizedQuote);
}

function structuredItems(value, maximum = 8) {
  return arrayValue(value).slice(0, maximum).map((item, index) => {
    if (typeof item === 'string') return { label: `要点 ${index + 1}`, detail: item.trim().slice(0, 1000) };
    const label = asText(item?.label || item?.name || item?.group || item?.step || item?.tool || item?.title);
    const detail = asText(item?.detail || item?.effect || item?.mechanism || item?.action
      || item?.condition || item?.description || item?.responsibility);
    return { label: label.slice(0, 120), detail: detail.slice(0, 1000) };
  }).filter((item) => item.label && item.detail);
}

function historicalChanges(value) {
  return arrayValue(value).slice(0, 8).map((item) => {
    if (!item || typeof item !== 'object') return null;
    const dimension = asText(item.dimension || item.aspect || item.change);
    const previous = asText(item.previous || item.before || item.historical);
    const current = asText(item.current || item.now || item.latest);
    const implication = asText(item.implication || item.impact || item.meaning);
    if (![dimension, previous, current, implication].every(Boolean)) return null;
    return {
      dimension: dimension.slice(0, 120),
      previous: previous.slice(0, 1000),
      current: current.slice(0, 1000),
      implication: implication.slice(0, 1000)
    };
  }).filter(Boolean);
}

function sectionText(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return asText(value.text || value.conclusion || value.narrative || value.detail);
  }
  return asText(value);
}

function normalizeModelAnalysis(payload, document, modelName, fallbackAnalysis) {
  const summary = asText(payload.summary).slice(0, 500) || fallbackAnalysis.summary;
  const facts = arrayValue(payload.facts).slice(0, 12);
  const factSignals = facts.map((fact, index) => {
    const quote = typeof fact === 'object' ? asText(fact.quote || fact.evidence || fact.text) : asText(fact);
    const label = typeof fact === 'object' ? asText(fact.label || fact.fact) : `模型提取事实 ${index + 1}`;
    if (!quote || !quoteExistsInDocument(quote, document.contentText)) return null;
    return {
      kind: 'model_extracted_fact',
      label: (label || `模型提取事实 ${index + 1}`).slice(0, 120),
      valueText: (label || quote).slice(0, 200),
      unit: '',
      period: '',
      evidenceQuote: quote.slice(0, 500),
      sourceUrl: document.originalUrl,
      observedAt: document.publishedAt,
      confidence: boundedConfidence(typeof fact === 'object' ? fact.confidence : null, 0.7)
    };
  }).filter(Boolean);

  const forecasts = arrayValue(payload.forecasts).slice(0, 8).map((forecast) => {
    if (typeof forecast === 'string') {
      return {
        statement: forecast.slice(0, 500), basis: '模型依据输入原文生成，需后续官方证据复核。',
        timeWindow: '后续观察', expectedBy: null, confidence: 0.5,
        prerequisites: '政策责任部门继续推进后续执行。',
        disconfirmingEvidence: '后续正式文件、执行数据或结果与该判断相反。',
        status: 'pending', verificationNote: '模型辅助预测，未验证。'
      };
    }
    const timeWindow = asText(forecast?.time_window || forecast?.timeWindow || forecast?.window);
    const expected = asText(forecast?.expected_by || forecast?.expectedBy);
    const prerequisites = asText(forecast?.prerequisites || forecast?.preconditions || forecast?.condition);
    const disconfirmingEvidence = asText(
      forecast?.disproof_condition || forecast?.disconfirming_evidence || forecast?.counterevidence
    ) || '后续正式文件、执行数据或结果与该判断相反。';
    return {
      statement: asText(forecast?.statement || forecast?.event).slice(0, 500),
      basis: asText(forecast?.basis || forecast?.reason).slice(0, 1000),
      timeWindow: timeWindow.slice(0, 160) || (expected ? `截至 ${expected}` : '后续观察'),
      expectedBy: /^20\d{2}-\d{2}-\d{2}$/.test(expected) ? expected : null,
      confidence: boundedConfidence(forecast?.confidence, 0.5),
      prerequisites: prerequisites.slice(0, 1000) || '政策责任部门按原文继续推进后续执行。',
      disconfirmingEvidence: disconfirmingEvidence.slice(0, 1000),
      status: 'pending',
      verificationNote: `反证条件：${disconfirmingEvidence}`.slice(0, 1000)
    };
  }).filter((item) => item.statement);

  const ambiguities = arrayValue(payload.ambiguities).slice(0, 8).map((item, index) => {
    const description = typeof item === 'string' ? item : asText(item?.description || item?.gap || item?.evidence);
    return {
      title: (typeof item === 'object' ? asText(item?.title) : '') || `待核验问题 ${index + 1}`,
      description: description.slice(0, 1000),
      severity: ['low', 'medium', 'high'].includes(item?.severity) ? item.severity : 'medium',
      status: 'open'
    };
  }).filter((item) => item.description);
  const frameworkInput = payload.policy_analysis && typeof payload.policy_analysis === 'object'
    ? payload.policy_analysis
    : payload;
  const problem = asText(frameworkInput.policy_problem || frameworkInput.problem).slice(0, 1500);
  const tools = structuredItems(frameworkInput.policy_tools || frameworkInput.tools);
  const affectedGroups = structuredItems(frameworkInput.affected_groups || frameworkInput.affectedGroups);
  const executionPath = structuredItems(frameworkInput.execution_path || frameworkInput.executionPath);
  const comparison = historicalChanges(frameworkInput.historical_comparison || frameworkInput.historicalChanges);
  const finalConclusion = sectionText(frameworkInput.final_conclusion || frameworkInput.finalConclusion)
    .slice(0, 1500)
    || asText(frameworkInput.bottom_line || frameworkInput.bottomLine || payload.summary).slice(0, 1000)
    || summary;
  const evolutionNarrative = sectionText(
    frameworkInput.evolution_narrative || frameworkInput.evolutionNarrative
  ).slice(0, 2000);
  const implementationInput = frameworkInput.implementation_assessment
    || frameworkInput.implementationAssessment || {};
  const frameworkReady = Boolean(
    problem && tools.length && affectedGroups.length && executionPath.length
      && finalConclusion && forecasts.length
  );
  const confirmed = factSignals.map((fact) => fact.evidenceQuote).slice(0, 8);
  const unconfirmed = ambiguities.map((item) => item.description).slice(0, 8);

  return {
    summary,
    category: fallbackAnalysis.category,
    headline: `模型辅助：${summary.slice(0, 80)}`,
    interpretation: asText(payload.interpretations) || fallbackAnalysis.interpretation,
    impact: asText(payload.implementation_path) || fallbackAnalysis.impact,
    recommendations: [asText(payload.advice), asText(payload.follow_up)].filter(Boolean).join('\n\n') || fallbackAnalysis.recommendations,
    methodology: `openai-compatible:${modelName}；仅依据传入原文与提示约束生成，输出仍需人工及后续官方证据复核。`,
    evidenceSummary: factSignals.length
      ? `模型从输入中提取 ${factSignals.length} 条带原文引用的事实；不得视为独立外部验证。`
      : '模型未返回可挂接的原文事实，保留规则分析证据。',
    framework: {
      ready: frameworkReady,
      perspective: '政策演进、实际落地与下一步方向',
      perspectiveNote: '从政策含义出发，比较历史变化，核对实施、资金和结果，再基于公开依据判断下一步；不把政策表态、市场反应或行业愿望当成兑现事实。',
      bottomLine: asText(frameworkInput.bottom_line || frameworkInput.bottomLine || payload.summary).slice(0, 1000) || summary,
      finalConclusion,
      problem,
      tools,
      affectedGroups,
      executionPath,
      historicalChanges: comparison,
      evolutionNarrative,
      implementationAssessment: {
        policyRelease: { status: 'confirmed', conclusion: '正式政策文本已经收录。', evidence: confirmed },
        implementation: { status: 'unknown', conclusion: '当前输入不含独立的后续实施证据。', evidence: [] },
        funding: { status: 'unknown', conclusion: '当前输入不含独立的实际资金或项目证据。', evidence: [] },
        outcomes: { status: 'unknown', conclusion: '当前输入不含独立的结果证据。', evidence: [] },
        realizationStatus: 'watching',
        conclusion: sectionText(implementationInput.conclusion || implementationInput)
          .slice(0, 1500) || '政策已经发布，实施、资金和结果仍需后续官方材料确认。'
      },
      forwardSignals: forecasts.map((forecast) => ({
        signal: forecast.statement,
        basis: forecast.basis,
        timeWindow: forecast.timeWindow,
        expectedBy: forecast.expectedBy,
        confidence: forecast.confidence,
        prerequisites: forecast.prerequisites,
        disconfirmingEvidence: forecast.disconfirmingEvidence,
        evidence: []
      })),
      confirmed,
      unconfirmed
    },
    modelName: `openai-compatible:${modelName}`,
    promptVersion: 'analyze-policy-v3',
    signals: factSignals.length ? factSignals : fallbackAnalysis.signals,
    forecasts,
    ambiguities: [...fallbackAnalysis.ambiguities, ...ambiguities]
  };
}

async function requestModel(document, modelConfig, options = {}) {
  if (!hasModelConfig(modelConfig)) throw new Error('MODEL_BASE_URL, MODEL_API_KEY and MODEL_NAME are all required');
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
          title: document.title,
          issuer: document.issuer,
          published_at: document.publishedAt,
          official_url: document.originalUrl,
          official_text: document.contentText.slice(0, 80_000)
        })
      }
    ]
  };
  const response = await (options.fetchImpl || fetch)(completionsUrl(modelConfig.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${modelConfig.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs || 60_000)
  });
  if (!response.ok) throw new Error(`model API returned HTTP ${response.status}`);
  const result = await response.json();
  const content = result?.choices?.[0]?.message?.content;
  if (!content) throw new Error('model API response did not contain choices[0].message.content');
  return parseJsonContent(content);
}

async function analyzeWithOptionalModel(document, fallbackAnalysis, mode, options = {}) {
  const modelConfig = options.modelConfig || loadModelConfig();
  if (mode === 'rules' || (mode === 'auto' && !hasModelConfig(modelConfig))) {
    return { analysis: fallbackAnalysis, warning: null };
  }
  if (mode === 'model' && !hasModelConfig(modelConfig)) {
    throw new Error('--analysis model requires MODEL_BASE_URL, MODEL_API_KEY and MODEL_NAME');
  }
  try {
    const payload = await requestModel(document, modelConfig, options);
    return { analysis: normalizeModelAnalysis(payload, document, modelConfig.modelName, fallbackAnalysis), warning: null };
  } catch (error) {
    if (mode === 'model') throw error;
    return { analysis: fallbackAnalysis, warning: `model analysis failed; rules-based fallback used: ${error.message}` };
  }
}

module.exports = {
  DEFAULT_PROMPT_PATH,
  analyzeWithOptionalModel,
  completionsUrl,
  hasModelConfig,
  loadModelConfig,
  normalizeModelAnalysis,
  quoteExistsInDocument,
  requestModel
};
