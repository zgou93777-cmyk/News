'use strict';

const HARD_ACCEPT_RULES = [
  ['central_politburo_meeting', /中共中央政治局(?:常务委员会)?(?:召开)?会议|中央政治局(?:常务委员会)?会议/, 12],
  ['central_economic_work_conference', /中央经济工作会议/, 12],
  ['major_central_conference', /中央(?:金融|农村|城市|外事|财经|全面深化改革)工作?会议|中央财经委员会.*会议/, 10],
  ['state_council_meeting', /国务院(?:常务|全体)会议/, 12],
  ['party_plenum', /中国共产党第.+中央委员会.+全体会议|二十届.+全会/, 11],
  ['npc_major_meeting', /全国人民代表大会|全国人大常委会.*会议|政府工作报告/, 10],
  ['monetary_policy_committee', /货币政策委员会.*(?:例会|会议)/, 11],
  ['state_council_policy', /(?:中共中央(?:办公厅)?、?国务院(?:办公厅)?|国务院)(?:关于|印发|办公厅).*(?:意见|决定|通知|批复|条例|办法|规划|纲要|方案|规定)/, 11],
  ['national_ministry_conference', /全国(?:发展和改革|财政|商务|住房城乡建设|金融|税务|统计|工业和信息化)工作会议/, 8]
];

const POSITIVE_RULES = [
  ['formal_policy_document', /(?:关于.{2,80}(?:意见|通知|决定|批复)|印发.{2,80}(?:办法|方案|规划|纲要|规定|细则|条例)|(?:指导意见|实施意见|管理办法|行动方案|发展规划|征求意见稿|条例|规定|公告))/, 6],
  ['formal_document_number', /[〔\[]20\d{2}[〕\]]\s*\d+号|(?:国发|国办发|发改|财税|银发|建发|商发)〔20\d{2}〕\d+号/, 2],
  ['policy_press_conference', /政策例行吹风会|政策新闻发布会|国新办.*(?:发布会|吹风会)|国务院新闻办公室.*发布会|就.+政策.*答记者问|政策解读/, 7],
  ['macro_policy_topic', /扩大内需|提振消费|财政政策|货币政策|金融监管|房地产政策|住房政策|就业政策|收入分配|社会保障|产业政策|科技创新|税收政策|专项债|统一大市场/, 3],
  ['macro_statistics', /国民经济运行情况|国民经济和社会发展统计公报|国内生产总值|GDP|居民消费价格|工业生产者价格|社会消费品零售总额|固定资产投资|规模以上工业|采购经理指数|就业形势|金融统计数据报告|社会融资规模|货物贸易|进出口/, 7],
  ['implementation_action', /部署实施|贯彻落实|试点方案|配套政策|实施细则|专项行动/, 2]
];

const HARD_REJECT_RULES = [
  ['commendation_or_award', /表彰|先进个人|先进集体|荣誉称号|获奖|评优|评选结果|表扬名单|名单公示/],
  ['party_building_activity', /党建|党支部|主题党日|党纪学习|党史学习教育|机关党委|工会活动|团委|精神文明|志愿服务|读书班/],
  ['personnel_or_recruitment', /人事任免|任免名单|招聘|考试录用|公开遴选|公务员招录/],
  ['internal_office_activity', /内部控制|内控工作|机关事务|政务服务培训|专题培训班|业务培训班|走访慰问|定点帮扶/],
  ['emergency_relief_allocation', /紧急预拨.*救灾资金|自然灾害救灾资金|防汛抗旱救灾资金|应急抢险救灾资金/],
  ['administrative_designation', /同意将.{1,100}(?:列为|列入)(?:国家)?(?:历史文化名城|历史文化名镇|历史文化名村|自然遗产|文化遗产|风景名胜区)/],
  ['routine_diplomacy', /中(?:泰|吉).*?(?:会议|会谈|会晤)|(?:泰国|吉尔吉斯斯坦).*?(?:会议|会谈|会晤)|同.+?(?:总统|总理|外长|大使).*(?:会见|会谈|会晤)|建交.*周年|致贺电/],
  ['routine_local_office_news', /(?:监管局|分行|机关).*(?:内控|培训|党建|表彰|慰问|工会|主题活动)/]
];

const SOFT_REJECT_RULES = [
  ['routine_work_update', /工作动态|工作简报|调研组|赴.+调研|召开.+座谈会|交流活动|机关工作/ , -4],
  ['generic_meeting', /(?:举行|召开).{0,30}(?:会议|座谈会|推进会|交流会)/, -2]
];

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function ruleMatches(text, rules) {
  return rules.filter(([, pattern]) => pattern.test(text));
}

function assessRelevance(document, source = {}, options = {}) {
  const title = compact(document.title);
  const body = compact(document.contentText).slice(0, options.bodyLimit || 12_000);
  const titleAndBody = `${title}\n${body}`;
  const hardAccept = ruleMatches(title, HARD_ACCEPT_RULES);
  const positive = ruleMatches(titleAndBody, POSITIVE_RULES);
  const hardReject = ruleMatches(title, HARD_REJECT_RULES);
  const softReject = ruleMatches(title, SOFT_REJECT_RULES);
  let score = hardAccept.reduce((total, rule) => total + rule[2], 0)
    + positive.reduce((total, rule) => total + rule[2], 0)
    + softReject.reduce((total, rule) => total + rule[2], 0);

  if (positive.length > 0 && ['P0', 'P1'].includes(source.tier)) score += 1;
  if (title.length < 8 || title.length > 180) score -= 3;

  const hardAccepted = hardAccept.length > 0;
  const hardRejected = hardReject.length > 0;
  const accepted = !hardRejected && (hardAccepted || (positive.length > 0 && score >= 6));
  const reasons = [
    ...hardAccept.map(([id]) => `accept:${id}`),
    ...positive.map(([id]) => `positive:${id}`),
    ...hardReject.map(([id]) => `reject:${id}`),
    ...softReject.map(([id]) => `negative:${id}`)
  ];
  if (reasons.length === 0) reasons.push('reject:no_policy_signal');
  if (!accepted && !hardRejected && score < 6) reasons.push('reject:below_threshold');

  return {
    accepted,
    score,
    classification: hardRejected ? 'excluded_noise'
      : hardAccepted ? 'major_or_formal'
        : accepted ? 'policy_relevant' : 'insufficient_policy_relevance',
    reasons,
    hardAccepted,
    hardRejected
  };
}

module.exports = {
  HARD_ACCEPT_RULES,
  HARD_REJECT_RULES,
  POSITIVE_RULES,
  assessRelevance
};
