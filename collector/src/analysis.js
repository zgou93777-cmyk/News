'use strict';

const crypto = require('node:crypto');

const THEMES = [
  ['农业与粮食', /农业|粮食|夏粮|秋粮|农产品|耕地|种业|乡村振兴/],
  ['宏观数据', /国民经济运行|国内生产总值|居民消费价格|工业生产者价格|社会消费品零售总额|固定资产投资|规模以上工业|采购经理指数|产量/],
  ['消费与内需', /消费|内需|以旧换新|零售/],
  ['住房与房地产', /住房|房地产|公积金|城中村/],
  ['财政与税收', /财政|税收|专项债|预算|补贴/],
  ['金融与货币', /金融|货币|利率|信贷|资本市场/],
  ['就业与收入', /就业|工资|收入|劳动|失业/],
  ['社会保障', /养老|医疗|中医药|国民健康|社保|托育|公共服务/],
  ['绿色发展与环境', /碳达峰|碳中和|绿色低碳|节能降碳|生态环境|自然资源|水体保护|污染治理/],
  ['科技与产业', /科技|产业|数字|人工智能|制造业/],
  ['区域发展', /区域|县域|城市群|城市更新/]
];

function sentences(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[。！？!?；;])/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 6 && item.length <= 500);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function matchCount(value, pattern) {
  return [...String(value || '').matchAll(new RegExp(pattern.source, 'g'))].length;
}

function detectThemes(value) {
  const title = typeof value === 'object' ? value.title || '' : '';
  const content = typeof value === 'object' ? value.contentText || '' : String(value || '');
  return THEMES.map(([name, pattern], index) => ({
    name,
    index,
    score: matchCount(title, pattern) * 25 + Math.min(matchCount(content.slice(0, 20_000), pattern), 10)
  }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((item) => item.name);
}

function classifyCategory(value, override) {
  if (override) return override;
  return detectThemes(value)[0] || '综合政策';
}

function importanceFor(source, document) {
  const tierScore = { P0: 5, P1: 4, P2: 3, P3: 2, P4: 2 }[source?.tier] || 2;
  const titleBoost = /中共中央|国务院|全国人民代表大会|五年规划|纲要|决定|批复/.test(
    `${document.title} ${document.issuer}`
  ) ? 1 : 0;
  return Math.min(5, tierScore + titleBoost);
}

function extractSignals(document) {
  const matches = [];
  const numberPattern = /\d+(?:\.\d+)?\s*(?:万亿元|千亿元|百亿元|亿元|万元|万套|万户|万人|万家|万|%|％|个百分点|个月|天|项|家|套|人)/g;
  for (const sentence of sentences(document.contentText)) {
    const values = [...sentence.matchAll(numberPattern)].map((match) => match[0]);
    if (!values.length) continue;
    matches.push({
      kind: 'policy_text',
      label: '原文量化表述',
      valueText: unique(values).join('、').slice(0, 160),
      unit: '',
      period: '',
      evidenceQuote: sentence.slice(0, 500),
      sourceUrl: document.originalUrl,
      observedAt: document.publishedAt,
      confidence: 1
    });
    if (matches.length >= 8) break;
  }
  return matches;
}

function findEvidenceSentence(document, pattern) {
  return sentences(document.contentText).find((sentence) => pattern.test(sentence)) || '';
}

function addDays(isoDate, days) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.valueOf())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function buildRulesAnalysis(document, source) {
  const themes = detectThemes(document);
  const themeLabel = themes.slice(0, 3).join('、') || '综合政策事项';
  const actionEvidence = findEvidenceSentence(document, /制定|出台|完善|建立|推进|实施|支持|加快|深化|优化/);
  const conditionalEvidence = findEvidenceSentence(document, /有条件|适时|研究|探索|因地制宜|因城施策|有关部门|本文有删减/);
  const signals = extractSignals(document);
  const forecasts = [];
  if (actionEvidence) {
    forecasts.push({
      statement: '后续90天可能出现与原文任务对应的部门或地方配套文件。',
      basis: `规则命中行动性表述：“${actionEvidence.slice(0, 220)}”`,
      expectedBy: addDays(document.publishedAt, 90),
      confidence: 0.55,
      status: 'pending',
      verificationNote: '仅属规则型条件预测；须以正式文件、预算、项目或执行数据验证，会议表态不算落地。'
    });
  }

  const ambiguities = [];
  const deletionEvidence = findEvidenceSentence(document, /本文有删减|有删减/);
  if (deletionEvidence) {
    ambiguities.push({
      title: '公开文本可能不完整',
      description: `原文出现：“${deletionEvidence.slice(0, 260)}” 未公开部分不能据此推断。`,
      severity: 'high',
      status: 'open'
    });
  }
  if (conditionalEvidence && !deletionEvidence) {
    ambiguities.push({
      title: '执行条件尚需后续证据',
      description: `原文含条件性或方向性表述：“${conditionalEvidence.slice(0, 260)}” 适用范围、责任主体或资金安排需以后续正式材料核验。`,
      severity: 'medium',
      status: 'watching'
    });
  }

  const sourceStatement = source
    ? `采集来源为“${source.name}”，发布机构按来源配置或页面元数据记录为“${document.issuer}”。`
    : `发布机构记录为“${document.issuer}”。`;
  return {
    summary: document.summary,
    category: classifyCategory(document),
    headline: `规则扫描：原文聚焦${themeLabel}`,
    interpretation: `${sourceStatement}规则只确认关键词、行动动词和原文量化表述，不据此判断资产价格、财政规模或执行成效。`,
    impact: themes.length
      ? `文本涉及${themeLabel}。是否形成实际影响，仍需依次核验实施细则、资金或项目、执行数据和结果数据。`
      : '文本主题未被现有规则稳定分类，暂不作具体影响推断。',
    recommendations: '将原文中的责任部门、资金来源、适用范围和时间要求逐项挂接后续公开证据；在正式配套与结果数据出现前，不把政策方向写成已经落地。',
    methodology: 'rules-based-v1：基于固定关键词、量化表达和条件性语句进行可复现扫描；未调用生成式模型。',
    evidenceSummary: `分析方式：rules-based。提取到 ${signals.length} 条原文量化信号、${ambiguities.length} 项待核验边界；所有推断均需人工或后续官方证据复核。`,
    modelName: 'rules-based-v1',
    promptVersion: 'rules-v1',
    signals,
    forecasts,
    ambiguities
  };
}

function checksumFor(document) {
  // Official pages often change indentation without changing the published text.
  const normalized = document.contentText.replace(/\s+/g, '');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

module.exports = {
  buildRulesAnalysis,
  checksumFor,
  classifyCategory,
  detectThemes,
  importanceFor,
  sentences
};
