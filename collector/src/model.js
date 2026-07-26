'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PROMPT_PATH = path.resolve(__dirname, '..', '..', 'prompts', 'analyze-policy.md');

function loadModelConfig(env = process.env) {
  return {
    baseUrl: String(env.MODEL_BASE_URL || '').trim(),
    apiKey: String(env.MODEL_API_KEY || '').trim(),
    modelName: String(env.MODEL_NAME || '').trim()
  };
}

function hasModelConfig(config) {
  return Boolean(config.baseUrl && config.apiKey && config.modelName);
}

function completionsUrl(baseUrl) {
  const value = baseUrl.replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(value) ? value : `${value}/chat/completions`;
}

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
        expectedBy: null, confidence: 0.5, status: 'pending', verificationNote: '模型辅助预测，未验证。'
      };
    }
    const expected = asText(forecast?.expected_by || forecast?.expectedBy || forecast?.time_window);
    return {
      statement: asText(forecast?.statement || forecast?.event).slice(0, 500),
      basis: asText(forecast?.basis || forecast?.condition || forecast?.precondition).slice(0, 1000),
      expectedBy: /^20\d{2}-\d{2}-\d{2}$/.test(expected) ? expected : null,
      confidence: boundedConfidence(forecast?.confidence, 0.5),
      status: 'pending',
      verificationNote: `反证条件：${asText(forecast?.disproof_condition || forecast?.counterevidence || '需用后续正式文件和执行数据复核。')}`.slice(0, 1000)
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
    modelName: `openai-compatible:${modelName}`,
    promptVersion: 'analyze-policy-v1',
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
