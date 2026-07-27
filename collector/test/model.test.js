'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { analyzeWithOptionalModel, completionsUrl } = require('../src/model');

const document = {
  title: '测试政策', issuer: '测试部门', publishedAt: '2026-07-13T00:00:00+08:00',
  originalUrl: 'https://example.gov.cn/policy/1', contentText: '测试部门发布政策，后续应核验正式执行数据。'
};
const fallback = {
  summary: '规则摘要', category: '综合政策', headline: '规则标题', interpretation: '规则解释',
  impact: '规则影响', recommendations: '规则建议', methodology: 'rules-based-v1',
  evidenceSummary: 'rules-based', modelName: 'rules-based-v1', promptVersion: 'rules-v1',
  signals: [], forecasts: [], ambiguities: []
};

test('completionsUrl accepts either a v1 base or full endpoint', () => {
  assert.equal(completionsUrl('https://model.example/v1/'), 'https://model.example/v1/chat/completions');
  assert.equal(completionsUrl('https://model.example/v1/chat/completions'), 'https://model.example/v1/chat/completions');
});

test('auto mode uses normalized OpenAI-compatible JSON when configured', async () => {
  let authorization = '';
  const fetchImpl = async (_url, request) => {
    authorization = request.headers.Authorization;
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        summary: '模型摘要',
        bottom_line: '这是一项执行测试，不代表结果已经出现。',
        policy_problem: '测试执行链路是否完整。',
        policy_tools: [{ label: '发布要求', detail: '由测试部门发布并继续核验。' }],
        affected_groups: [{ label: '执行部门', detail: '需要提供正式执行数据。' }],
        execution_path: [{ label: '原文发布', detail: '先发布政策，再核验执行数据。' }],
        facts: [{ label: '已发布', quote: '测试部门发布政策，后续应核验正式执行数据。', confidence: 0.9 }],
        forecasts: [{ statement: '可能出现细则', basis: '政策要求', expected_by: '2026-10-01', confidence: 60 }],
        ambiguities: ['资金规模未公开']
      }) } }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const output = await analyzeWithOptionalModel(document, fallback, 'auto', {
    modelConfig: { baseUrl: 'https://model.example/v1', apiKey: 'test-secret', modelName: 'test-model' },
    fetchImpl
  });
  assert.equal(authorization, 'Bearer test-secret');
  assert.equal(output.analysis.modelName, 'openai-compatible:test-model');
  assert.equal(output.analysis.forecasts[0].confidence, 0.6);
  assert.equal(output.analysis.signals[0].evidenceQuote, '测试部门发布政策，后续应核验正式执行数据。');
  assert.equal(output.analysis.framework.ready, true);
  assert.equal(output.analysis.promptVersion, 'analyze-policy-v3');
  assert.match(output.analysis.framework.finalConclusion, /不代表结果已经出现/);
  assert.equal(output.analysis.framework.forwardSignals[0].expectedBy, '2026-10-01');
});

test('auto mode falls back to rules while explicit model mode fails', async () => {
  const fetchImpl = async () => { throw new Error('offline'); };
  const config = { baseUrl: 'https://model.example/v1', apiKey: 'secret', modelName: 'test-model' };
  const auto = await analyzeWithOptionalModel(document, fallback, 'auto', { modelConfig: config, fetchImpl });
  assert.equal(auto.analysis.modelName, 'rules-based-v1');
  assert.match(auto.warning, /rules-based fallback/);
  await assert.rejects(
    analyzeWithOptionalModel(document, fallback, 'model', { modelConfig: config, fetchImpl }),
    /offline/
  );
});

test('model facts without a verbatim source quote are not persisted as evidence', async () => {
  const { normalizeModelAnalysis } = require('../src/model');
  const normalized = normalizeModelAnalysis({
    summary: '摘要',
    facts: [
      { label: '可核对', quote: '测试部门发布政策，后续应核验正式执行数据。' },
      { label: '疑似臆造', quote: '原文从未出现的补贴金额为100亿元。' }
    ]
  }, document, 'test-model', fallback);
  assert.equal(normalized.signals.length, 1);
  assert.equal(normalized.signals[0].label, '可核对');
});
