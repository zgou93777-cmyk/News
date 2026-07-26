'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildAssessment,
  classifyImplementationEvent,
  familyForCategory
} = require('../src/lineage');

function document(title, contentText) {
  return {
    title,
    contentText,
    originalExcerpt: contentText,
    originalUrl: 'https://example.gov.cn/policy/1',
    publishedAt: '2026-07-20T08:00:00+08:00'
  };
}

test('category families use stable ASCII slugs and transparent titles', () => {
  assert.deepEqual(familyForCategory('消费与内需'), {
    slug: 'consumption-domestic-demand-policy',
    title: '消费与内需政策脉络',
    category: '消费与内需',
    description: '按公开政策文本的“消费与内需”主题自动归档；主题归属不代表政策已经执行。',
    explicit: false
  });
  assert.match(familyForCategory('自定义主题').slug, /^category-[a-f0-9]{12}$/);
  assert.equal(familyForCategory('综合政策').title, '综合政策脉络');
});

test('meeting language is always a signal even when it says deployment and implementation', () => {
  const event = classifyImplementationEvent(document(
    '国务院常务会议部署消费政策',
    '会议要求立即部署落实，推动政策正式实施。'
  ));
  assert.equal(event.eventType, 'meeting_signal');
  assert.equal(event.status, 'announced');
});

test('a planning document quoting historical results is not result evidence', () => {
  const event = classifyImplementationEvent(document(
    '关于印发扩大消费五年规划的通知',
    '截至2025年，相关项目实际完成100项。现印发新的五年规划。'
  ));
  assert.equal(event.eventType, 'policy_release');
  assert.equal(event.status, 'announced');
});

test('result, paid funding and implementation documents are observed but planned funding is not', () => {
  assert.equal(classifyImplementationEvent(document(
    '2026年国民经济运行情况',
    '截至六月，社会消费品零售总额同比增长5%。'
  )).eventType, 'result_data');
  assert.equal(classifyImplementationEvent(document(
    '国家统计局关于2026年夏粮产量数据的公告',
    '2026年全国夏粮总产量如下。'
  )).eventType, 'result_data');
  assert.equal(classifyImplementationEvent(document(
    '2026年1-6月份全国固定资产投资基本情况',
    '全国固定资产投资同比增长。'
  )).eventType, 'result_data');
  assert.equal(classifyImplementationEvent(document(
    '2026年上半年社会消费品零售总额增长1.3%',
    '社会消费品零售总额已发布。'
  )).eventType, 'result_data');
  assert.equal(classifyImplementationEvent(document(
    '关于财政支持工作的公告',
    '中央财政已下达补助资金100亿元。'
  )).eventType, 'funding');
  assert.equal(classifyImplementationEvent(document(
    '关于财政支持工作的通知',
    '下一年度拟安排补助资金100亿元。'
  )).eventType, 'policy_release');
  const implementation = classifyImplementationEvent(document(
    '消费补贴申报实施细则',
    '本细则自发布之日起实施。'
  ));
  assert.equal(implementation.eventType, 'implementation');
  assert.equal(implementation.status, 'observed');
});

test('assessment excludes statements and releases and counts each observed stage once', () => {
  const base = [
    { id: 1, event_type: 'meeting_signal', status: 'announced', source_url: 'https://a.test' },
    { id: 2, event_type: 'policy_release', status: 'confirmed', source_url: 'https://b.test' }
  ];
  const signalOnly = buildAssessment(base, '2026-07-20');
  assert.equal(signalOnly.score, null);
  assert.match(signalOnly.conclusion, /发文不等于落地/);

  const assessed = buildAssessment([
    ...base,
    { id: 3, event_type: 'implementation', status: 'observed', source_url: 'https://c.test' },
    { id: 4, event_type: 'implementation', status: 'confirmed', source_url: 'https://d.test' },
    { id: 5, event_type: 'funding', status: 'observed', source_url: 'https://e.test' }
  ], '2026-07-20');
  assert.equal(assessed.score, 65);
  assert.equal(assessed.evidence.filter((item) => item.points === 35).length, 1);
});
