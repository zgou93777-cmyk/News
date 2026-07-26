'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { assessRelevance } = require('../src/relevance');

const p1 = { name: '中央部委', tier: 'P1' };

function assess(title, contentText = '') {
  return assessRelevance({ title, contentText }, p1);
}

test('keeps major central meetings, formal policies, monetary committee and macro data', () => {
  const titles = [
    '中共中央政治局召开会议 分析研究当前经济形势',
    '中央经济工作会议在北京举行',
    '国务院常务会议研究部署扩大内需工作',
    '中国人民银行货币政策委员会2026年第二季度例会召开',
    '关于印发《消费领域管理办法》的通知',
    '2026年上半年国民经济运行情况',
    '国务院新闻办公室举行扩大内需政策例行吹风会'
  ];
  for (const title of titles) {
    assert.equal(assess(title).accepted, true, title);
  }
});

test('rejects commendations, internal office work, routine party activity and generic diplomacy', () => {
  const titles = [
    '中国人民银行关于表彰2025年度先进集体和先进个人的通知',
    '广西监管局召开2026年内部控制工作会议',
    '机关党委开展主题党日活动',
    '中泰、中吉举行第十次例行交流会议',
    '财政部、应急管理部紧急预拨2亿元中央自然灾害救灾资金',
    '国务院关于同意将山东省潍坊市列为国家历史文化名城的批复',
    '国务院关于表彰全国先进集体和先进个人的决定',
    '某司召开年度工作推进会'
  ];
  for (const title of titles) {
    const result = assess(title);
    assert.equal(result.accepted, false, title);
  }
});
