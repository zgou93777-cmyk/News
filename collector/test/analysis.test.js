'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRulesAnalysis, checksumFor, classifyCategory } = require('../src/analysis');

const document = {
  title: '国务院关于《扩大消费测试规划》的批复',
  issuer: '国务院',
  originalUrl: 'https://www.gov.cn/example.htm',
  publishedAt: '2026-07-13T00:00:00+08:00',
  summary: '国务院原则同意规划。',
  contentText: '国务院原则同意规划。到2030年，社会消费品零售总额达到60万亿元左右。支持有条件的地方推进试点。本文有删减。'
};

test('rules analysis explicitly labels its method and preserves evidence boundaries', () => {
  const analysis = buildRulesAnalysis(document, {
    name: '中国政府网-最新政策', institution: '国务院', tier: 'P0'
  });
  assert.equal(analysis.modelName, 'rules-based-v1');
  assert.match(analysis.methodology, /未调用生成式模型/);
  assert.match(analysis.evidenceSummary, /rules-based/);
  assert.equal(analysis.signals[0].confidence, 1);
  assert.match(analysis.signals[0].evidenceQuote, /60万亿元/);
  assert.equal(analysis.ambiguities[0].severity, 'high');
  assert.ok(analysis.forecasts.every((forecast) => forecast.status === 'pending'));
  assert.equal(analysis.framework.ready, false);
  assert.match(analysis.framework.bottomLine, /尚未完成/);
});

test('checksum is stable across whitespace-only changes', () => {
  const left = checksumFor(document);
  const right = checksumFor({ ...document, contentText: document.contentText.replace(/。/g, '。   ') });
  assert.equal(left, right);
});

test('title-weighted category ignores an unrelated housing navigation word', () => {
  const category = classifyCategory({
    title: '2026年全国夏粮产量公告',
    contentText: '首页 住房 政策 服务。全国夏粮产量保持稳定，粮食播种面积和单位面积产量已经公布。'
  });
  assert.equal(category, '农业与粮食');
});

test('explicit macro-statistics titles outrank repeated industry words in the body', () => {
  assert.equal(classifyCategory({
    title: '2026年二季度和上半年国内生产总值初步核算结果',
    contentText: '制造业产业增加值。'.repeat(30)
  }), '宏观数据');
});
