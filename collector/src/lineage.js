'use strict';

const crypto = require('node:crypto');

const CATEGORY_FAMILY_SLUGS = Object.freeze({
  '农业与粮食': 'agriculture-food-policy',
  '宏观数据': 'macro-data-policy',
  '消费与内需': 'consumption-domestic-demand-policy',
  '住房与房地产': 'housing-real-estate-policy',
  '财政与税收': 'fiscal-tax-policy',
  '金融与货币': 'finance-monetary-policy',
  '就业与收入': 'employment-income-policy',
  '社会保障': 'social-security-policy',
  '绿色发展与环境': 'green-development-environment-policy',
  '科技与产业': 'technology-industry-policy',
  '区域发展': 'regional-development-policy',
  '综合政策': 'general-policy'
});

const EVENT_POINTS = Object.freeze({
  implementation: 35,
  funding: 30,
  result_data: 35
});

function familyForCategory(category) {
  const normalized = String(category || '综合政策').trim() || '综合政策';
  const fallbackHash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 12);
  return {
    slug: CATEGORY_FAMILY_SLUGS[normalized] || `category-${fallbackHash}`,
    title: normalized === '综合政策' ? '综合政策脉络' : `${normalized}政策脉络`,
    category: normalized,
    description: `按公开政策文本的“${normalized}”主题自动归档；主题归属不代表政策已经执行。`,
    explicit: false
  };
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function evidenceSentence(text, pattern) {
  return compact(text).split(/(?<=[。！？!?；;])/)
    .map((item) => item.trim())
    .find((item) => pattern.test(item)) || '';
}

function firstEvidence(document, pattern) {
  return evidenceSentence(document.contentText, pattern)
    || compact(document.originalExcerpt).slice(0, 500)
    || compact(document.contentText).slice(0, 500)
    || compact(document.title).slice(0, 500);
}

function classifyImplementationEvent(document) {
  const title = compact(document.title);
  const content = compact(document.contentText);
  const fullText = `${title}\n${content}`;
  const meetingPattern = /会议|会谈|会晤|座谈会|发布会|吹风会|记者会|例会|全会/;
  const resultPattern = /(?:统计公报|运行情况|数据报告|统计数据|产量数据|初步核算结果|基本情况|执行情况|完成情况|进展情况|(?:增长|下降)\s*\d+(?:\.\d+)?%)|(?:截至|同比|实际).{0,80}(?:完成|达到|增长|下降)/;
  const fundingPattern = /(?:已|正式)?(?:下达|拨付|发放).{0,80}(?:资金|预算|补助|补贴)|(?:资金|预算|补助|补贴).{0,80}(?:已下达|已拨付|已发放)/;
  const implementationPattern = /实施细则|操作细则|申报指南|任务清单|实施办法|(?:已|正式)(?:启动|实施|执行|开工|发放|办理|建成|投入使用)/;

  if (meetingPattern.test(title)) {
    return {
      eventType: 'meeting_signal',
      status: 'announced',
      description: '会议、发布会或会谈材料仅记录政策信号；其中的部署、要求和表态不等于已经执行落地。',
      evidenceQuote: firstEvidence(document, /部署|要求|指出|强调|研究|提出/)
    };
  }
  // Historical figures quoted inside a policy document do not turn that document into result evidence.
  if (resultPattern.test(title)) {
    return {
      eventType: 'result_data',
      status: 'observed',
      description: '公开材料包含明确的结果或进展数据；该数据只能证明所述结果被观察到，不自动证明由某项政策造成。',
      evidenceQuote: firstEvidence(document, resultPattern)
    };
  }
  if (evidenceSentence(fullText, fundingPattern)) {
    return {
      eventType: 'funding',
      status: 'observed',
      description: '公开材料包含已下达、拨付或发放的资金证据；计划、拟安排和会议部署不按资金落地计算。',
      evidenceQuote: firstEvidence(document, fundingPattern)
    };
  }
  if (implementationPattern.test(title) || evidenceSentence(content, implementationPattern)) {
    return {
      eventType: 'implementation',
      status: 'observed',
      description: '公开材料包含实施细则或明确执行动作；这证明执行环节已被观察到，不等于最终政策效果已经验证。',
      evidenceQuote: firstEvidence(document, implementationPattern)
    };
  }
  return {
    eventType: 'policy_release',
    status: 'announced',
    description: '正式政策文件或政策相关材料已经发布；发文事实不等于资金、执行动作或结果数据已经落地。',
    evidenceQuote: firstEvidence(document, /印发|发布|公布|批复|通知|意见|决定|规划|方案/)
  };
}

function buildAssessment(events, asOfDate) {
  const counts = {
    meeting_signal: 0,
    policy_release: 0,
    implementation: 0,
    funding: 0,
    result_data: 0
  };
  const includedTypes = new Set();
  const evidence = events.map((event) => {
    if (Object.hasOwn(counts, event.event_type)) counts[event.event_type] += 1;
    const eligible = ['observed', 'confirmed'].includes(event.status)
      && Object.hasOwn(EVENT_POINTS, event.event_type);
    const points = eligible && !includedTypes.has(event.event_type) ? EVENT_POINTS[event.event_type] : 0;
    if (points > 0) includedTypes.add(event.event_type);
    return {
      eventId: event.id,
      type: event.event_type,
      status: event.status,
      points,
      included: points > 0,
      reason: points > 0
        ? `首次计入${event.event_type}阶段证据`
        : ['meeting_signal', 'policy_release'].includes(event.event_type)
          ? '表态或发文不计入执行兑现分'
          : '同类阶段只计一次或证据仍处于 announced 状态',
      sourceUrl: event.source_url
    };
  });
  const score = [...includedTypes].reduce((total, type) => total + EVENT_POINTS[type], 0);
  let conclusion;
  if (score === 0 && counts.meeting_signal > 0 && counts.policy_release === 0) {
    conclusion = '当前仅见会议或发布会表态。表态不等于落地，尚未观察到明确实施、资金或结果数据。';
  } else if (score === 0) {
    conclusion = '政策材料或正式文件已经发布，但发文不等于落地，尚未观察到明确实施、资金或结果数据。';
  } else {
    const observed = [
      includedTypes.has('implementation') ? '明确实施' : '',
      includedTypes.has('funding') ? '资金兑现' : '',
      includedTypes.has('result_data') ? '结果数据' : ''
    ].filter(Boolean).join('、');
    const missing = [
      !includedTypes.has('implementation') ? '明确实施' : '',
      !includedTypes.has('funding') ? '资金兑现' : '',
      !includedTypes.has('result_data') ? '结果数据' : ''
    ].filter(Boolean).join('、');
    conclusion = `已观察到${observed}证据${missing ? `；仍缺少${missing}证据` : ''}。阶段证据只说明公开链路进展，不自动证明政策产生了预期效果。`;
  }
  return {
    summary: `截至 ${asOfDate}：会议信号 ${counts.meeting_signal} 条、正式发文 ${counts.policy_release} 条、明确实施 ${counts.implementation} 条、资金证据 ${counts.funding} 条、结果数据 ${counts.result_data} 条。`,
    score: score === 0 ? null : score,
    conclusion,
    evidence
  };
}

function issuerLooksLikeDate(value) {
  const issuer = compact(value);
  return /^(?:20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?|20\d{2}-\d{2}-\d{2}T)/.test(issuer);
}

module.exports = {
  CATEGORY_FAMILY_SLUGS,
  EVENT_POINTS,
  buildAssessment,
  classifyImplementationEvent,
  familyForCategory,
  issuerLooksLikeDate
};
