'use strict';

const { withTransaction } = require('./db');

function getOrInsert(db, selectSql, selectArgs, insertSql, insertArgs) {
  const existing = db.prepare(selectSql).get(...selectArgs);
  if (existing) return existing.id;
  return Number(db.prepare(insertSql).run(...insertArgs).lastInsertRowid);
}

function insertAnalysisIfMissing(db, documentId, analysis) {
  const existing = db.prepare(
    'SELECT id FROM analysis_versions WHERE document_id = ? AND version = ?'
  ).get(documentId, analysis.version);
  if (existing) return existing.id;

  return Number(db.prepare(`
    INSERT INTO analysis_versions (
      document_id, version, previous_version_id, headline, interpretation,
      impact, recommendations, methodology, evidence_summary,
      model_name, prompt_version, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    documentId,
    analysis.version,
    analysis.previousVersionId || null,
    analysis.headline,
    analysis.interpretation,
    analysis.impact,
    analysis.recommendations,
    analysis.methodology,
    analysis.evidenceSummary,
    analysis.modelName || 'editorial-reviewed',
    analysis.promptVersion || 'seed-v1',
    analysis.status || 'published',
    analysis.createdAt
  ).lastInsertRowid);
}

function seedDatabase(db) {
  return withTransaction(db, () => {
    const govSourceId = getOrInsert(
      db,
      'SELECT id FROM sources WHERE official_url = ?',
      ['https://www.gov.cn/zhengce/zhengcewenjianku/'],
      'INSERT INTO sources (name, kind, authority_level, official_url) VALUES (?, ?, ?, ?)',
      ['中国政府网政策文件库', 'official', 'central', 'https://www.gov.cn/zhengce/zhengcewenjianku/']
    );
    const ndrcSourceId = getOrInsert(
      db,
      'SELECT id FROM sources WHERE official_url = ?',
      ['https://www.ndrc.gov.cn/'],
      'INSERT INTO sources (name, kind, authority_level, official_url) VALUES (?, ?, ?, ?)',
      ['国家发展改革委', 'official', 'central', 'https://www.ndrc.gov.cn/']
    );
    const statsSourceId = getOrInsert(
      db,
      'SELECT id FROM sources WHERE official_url = ?',
      ['https://www.stats.gov.cn/'],
      'INSERT INTO sources (name, kind, authority_level, official_url) VALUES (?, ?, ?, ?)',
      ['国家统计局', 'official', 'central', 'https://www.stats.gov.cn/']
    );

    const familyId = getOrInsert(
      db,
      'SELECT id FROM policy_families WHERE slug = ?',
      ['expanding-consumption-15th-five-year'],
      'INSERT INTO policy_families (slug, title, category, description) VALUES (?, ?, ?, ?)',
      [
        'expanding-consumption-15th-five-year',
        '扩大消费与内需政策脉络',
        '消费与内需',
        '从扩大内需长期纲要、提振消费专项行动到“十五五”扩大消费部署，持续跟踪政策工具、地方执行和可验证结果。'
      ]
    );

    const historicalId = getOrInsert(
      db,
      'SELECT id FROM documents WHERE original_url = ?',
      ['https://www.gov.cn/zhengce/2022-12/14/content_5732067.htm'],
      `INSERT INTO documents (
        source_id, family_id, title, subtitle, summary, issuer, document_number, document_date, category, status,
        importance, original_url, published_at, effective_at, content_text,
        original_excerpt, checksum
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        govSourceId,
        familyId,
        '扩大内需战略规划纲要（2022-2035年）',
        '消费政策的长期总框架',
        '从提高供给质量、完善分配格局和畅通国内大循环等方面建立扩大内需的长期框架。',
        '中共中央、国务院',
        '',
        '2022-12-14',
        '消费与内需',
        'effective',
        4,
        'https://www.gov.cn/zhengce/2022-12/14/content_5732067.htm',
        '2022-12-14T00:00:00+08:00',
        '2022-12-14T00:00:00+08:00',
        '纲要提出坚定实施扩大内需战略、培育完整内需体系，把实施扩大内需战略同深化供给侧结构性改革有机结合起来，并部署全面促进消费、加快消费提质升级等重点任务。',
        '“坚定实施扩大内需战略、培育完整内需体系”构成后续消费专项政策的长期目标边界。',
        'seed-nd-2022'
      ]
    );

    const actionId = getOrInsert(
      db,
      'SELECT id FROM documents WHERE original_url = ?',
      ['https://www.gov.cn/zhengce/202503/content_7013809.htm'],
      `INSERT INTO documents (
        source_id, family_id, title, subtitle, summary, issuer, document_number, document_date, category, status,
        importance, original_url, published_at, effective_at, content_text,
        original_excerpt, checksum
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        govSourceId,
        familyId,
        '提振消费专项行动方案',
        '从方向性部署转向可执行任务清单',
        '围绕城乡居民增收、消费能力保障、服务消费、商品消费和消费环境安排专项行动。',
        '中共中央办公厅、国务院办公厅',
        '',
        '2025-03-16',
        '消费与内需',
        'effective',
        5,
        'https://www.gov.cn/zhengce/202503/content_7013809.htm',
        '2025-03-16T00:00:00+08:00',
        '2025-03-16T00:00:00+08:00',
        '方案把促进工资性收入合理增长、拓宽财产性收入渠道、提高养老保障水平，同服务消费提质惠民、消费品以旧换新和优化消费环境放在同一行动框架中。',
        '政策不只刺激单次购买，还把“能消费、敢消费、愿消费”对应到收入、保障、供给和环境四组工具。',
        'seed-consumption-2025'
      ]
    );

    const currentId = getOrInsert(
      db,
      'SELECT id FROM documents WHERE original_url = ?',
      ['https://www.gov.cn/zhengce/content/202607/content_7075216.htm'],
      `INSERT INTO documents (
        source_id, family_id, title, subtitle, summary, issuer, document_number, document_date, category, status,
        importance, original_url, published_at, effective_at, content_text,
        original_excerpt, checksum
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        govSourceId,
        familyId,
        '国务院关于《扩大消费“十五五”规划》的批复',
        '国函〔2026〕66号：到2030年社零总额达到60万亿元左右',
        '国务院批复原则同意规划；公开文本将商品消费、服务消费、消费能力和消费环境纳入中期部署，网页明确标注“本文有删减”。',
        '国务院',
        '国函〔2026〕66号',
        '2026-07-02',
        '消费与内需',
        'published',
        5,
        'https://www.gov.cn/zhengce/content/202607/content_7075216.htm',
        '2026-07-13T00:00:00+08:00',
        null,
        '国务院批复原则同意《扩大消费“十五五”规划》，文号为国函〔2026〕66号，成文日期为2026年7月2日，公开发布日期为2026年7月13日。公开文本提出到2030年社会消费品零售总额达到60万亿元左右。第三部分“推动商品消费扩容升级”第（八）项提出促进大宗耐用商品消费并更好满足住房消费需求；第（二十六）项支持各地因城施策调整优化房地产政策、深化住房公积金制度改革、扩大使用范围；第（二十八）项提出推动修订《职工带薪年休假条例》，支持有条件地方推广中小学春秋假。政府网页同时注明“本文有删减”。',
        '“到2030年，社会消费品零售总额达到60万亿元左右”；“促进大宗耐用商品消费。更好满足住房消费需求”；“支持有条件的地方推广中小学春秋假”。网页注明“本文有删减”。',
        'seed-15th-five-year-consumption'
      ]
    );

    const historicalAnalysisId = insertAnalysisIfMissing(db, historicalId, {
      version: 1,
      headline: '长期纲要确定方向，但落地强度取决于年度工具',
      interpretation: '纲要提供到2035年的目标和政策边界，本身不是年度预算或补贴清单。判断成效不能只看文件发布，要继续观察就业收入、社会保障、服务供给和消费环境是否形成组合政策。',
      impact: '它提高了消费在宏观政策中的长期权重，并为后续以旧换新、服务消费和县域商业体系建设提供上位依据。',
      recommendations: '追踪时把纲要目标拆成居民收入、服务消费占比、耐用品更新、县域供给四类指标，避免用社会消费品零售总额单一指标替代全部消费。',
      methodology: '政策原文分层阅读；区分目标、工具与结果；以公开统计和后续文件交叉验证。',
      evidenceSummary: '原文属于中长期纲领，未给出单年度强制性量化结果。',
      createdAt: '2022-12-15T08:00:00+08:00'
    });

    const actionAnalysisId = insertAnalysisIfMissing(db, actionId, {
      version: 1,
      headline: '政策工具由商品补贴扩展至收入和服务消费',
      interpretation: '专项行动把需求侧能力与供给侧改善并列，说明政策判断已从“促销费”转向“稳定可持续消费能力”。但收入政策见效较慢，短期数据仍可能主要由以旧换新拉动。',
      impact: '家电、汽车和数码产品先受益，文旅、养老、托育等服务领域的效果则取决于地方供给、价格和监管配套。',
      recommendations: '企业可围绕更新换新和服务标准化准备产品；地方执行评估应公开补贴核销、撬动消费、重复申领控制和服务可及性，而不只披露活动场次。',
      methodology: '将专项行动逐项映射到执行部门、财政工具和统计结果；对时间滞后作单独标注。',
      evidenceSummary: '行动方案覆盖增收、保障、商品、服务和环境，工具完整度高于单一促消费活动。',
      createdAt: '2025-03-17T09:30:00+08:00'
    });

    const currentAnalysisV1 = insertAnalysisIfMissing(db, currentId, {
      version: 1,
      headline: '60万亿元目标给出结果锚点，删减文本仍需等待执行细则',
      interpretation: '首轮解读确认文件是国务院正式批复的国家级中期规划，且给出2030年社会消费品零售总额约60万亿元的目标。公开页标明“本文有删减”，因此不能凭公开版本推断被删减内容、资金规模或全部责任分工。',
      impact: '商品更新、服务消费、休假制度和住房相关消费政策获得中期连续性，但对居民消费能力的真实影响仍取决于收入、公共服务和地方执行。',
      recommendations: '把60万亿元目标换算成年均路径并结合价格因素观察；后续核对部门分工、预算和统计口径；未写入公开原文的补贴规模不得当成确定事实。',
      methodology: '与2022年纲要和2025年专项行动逐条对比；事实、解释、预测三层分栏；对删减信息保持不可推断边界。',
      evidenceSummary: '正式文号、日期和2030年目标已确认；完整未删减文本、预算与地方任务仍待后续公开文件验证。',
      createdAt: '2026-07-13T12:00:00+08:00'
    });

    const currentAnalysisV2 = insertAnalysisIfMissing(db, currentId, {
      version: 2,
      previousVersionId: currentAnalysisV1,
      headline: '住房被纳入消费政策工具箱，但不能据此改写其法律和资产属性',
      interpretation: '复核后的判断是：规划承接2022年长期纲要和2025年专项行动，并把2030年社零总额约60万亿元设为结果锚点。住房相关表述的直接含义是政策希望通过因城施策、公积金改革等更好满足住房消费需求；它不代表住房在法律或统计上被重新分类，也不代表取消住房的资产属性。',
      impact: '耐用品更新链条得到政策连续性，养老、托育、文旅、数字和绿色消费获得更长政策窗口。住房领域可能先体现为地方政策和公积金使用范围调整，而非全国统一的资产定性变化。',
      recommendations: '对政府执行端，建议建立资金投入、消费增量和居民净福利三本账；对企业端，按“无补贴仍成立”的条件评估扩产；对个人端，不把“住房消费”表述误读为房产保值承诺，等待本地房地产和公积金细则。',
      methodology: '以官方原文为事实锚点；用同一政策家族的历史版本作纵向比较；将实施事件和统计信号与预测逐项挂接；保留首轮版本供复盘。',
      evidenceSummary: '国函〔2026〕66号、60万亿元目标和住房、休假相关原文已确认；网页明确“本文有删减”，具体财政规模仍不能外推。',
      createdAt: '2026-07-20T08:30:00+08:00'
    });

    const signalInsert = db.prepare(`
      INSERT INTO policy_signals (
        document_id, kind, label, value_text, unit, period, evidence_quote,
        source_url, observed_at, confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    if (!db.prepare('SELECT 1 FROM policy_signals WHERE document_id = ? LIMIT 1').get(currentId)) {
      signalInsert.run(currentId, 'policy_design', '2030年社零目标', '60万亿元左右', '人民币', '2030年', '原文明确：“到2030年，社会消费品零售总额达到60万亿元左右。”', 'https://www.gov.cn/zhengce/content/202607/content_7075216.htm', '2026-07-13T00:00:00+08:00', 1);
      signalInsert.run(currentId, 'implementation', '地方配套细则', '等待集中发布', '', '发布后90日', '需继续监测省级发展改革、财政、商务、住建和公积金管理部门公开文件。', 'https://www.gov.cn/zhengce/content/202607/content_7075216.htm', '2026-07-20T08:00:00+08:00', 0.8);
      signalInsert.run(currentId, 'outcome', '居民消费能力改善', '观察中', '', '2026-2027', '收入和公共服务工具的传导慢于商品补贴，不宜用单月零售数据下结论。', 'https://www.stats.gov.cn/', '2026-07-20T08:00:00+08:00', 0.75);
    }

    const forecastInsert = db.prepare(`
      INSERT INTO forecasts (
        analysis_version_id, statement, basis, expected_by, confidence,
        status, verification_note, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    if (!db.prepare('SELECT 1 FROM forecasts WHERE analysis_version_id = ? LIMIT 1').get(currentAnalysisV2)) {
      forecastInsert.run(currentAnalysisV2, '未来90天内将出现至少一批部门或地方配套任务清单。', '中期规划需要转化为年度执行，住房、公积金、休假等条款涉及多部门配套。', '2026-10-13', 0.72, 'monitoring', '截至2026-07-20尚处监测窗口，命中标准为可核验的正式文件，不以会议表态代替。', null);
      forecastInsert.run(currentAnalysisV2, '以旧换新类政策将延续，但政策评价会更强调撬动效率和居民净福利。', '短期工具见效快，但规划目标要求从一次性交易额转向可持续消费能力。', '2027-03-31', 0.64, 'pending', '尚未到验证期；需记录财政投入、核销量和价格变化，防止只看名义销售额。', null);
      forecastInsert.run(currentAnalysisV2, '服务消费将获得专项供给或标准化配套。', '养老、托育、文旅等服务供给是补齐消费结构短板的共同方向。', '2027-06-30', 0.68, 'pending', '尚未到验证期；正式专项文件或预算安排出现后再调整结论。', null);
    }

    if (!db.prepare('SELECT 1 FROM forecasts WHERE analysis_version_id = ? LIMIT 1').get(actionAnalysisId)) {
      forecastInsert.run(actionAnalysisId, '消费品以旧换新会成为2025年短期政策效果的主要来源之一。', '补贴规则明确、执行链条成熟，传导速度快于收入与公共服务改革。', '2025-12-31', 0.82, 'partially_verified', '后续公开信息显示多地持续执行更新换新；但跨品类净增消费和透支效应仍需完整年度数据复核。', '2026-01-31T00:00:00+08:00');
    }

    const ambiguityInsert = db.prepare(`
      INSERT INTO ambiguities (
        document_id, analysis_version_id, title, description, severity,
        status, resolution_note, detected_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    if (!db.prepare('SELECT 1 FROM ambiguities WHERE document_id = ? LIMIT 1').get(currentId)) {
      ambiguityInsert.run(currentId, currentAnalysisV2, '住房消费表述的边界', '住房纳入消费政策框架，是政策工具和需求满足角度的表述；不代表住房在法律或统计分类上被重新定义，也不代表取消其资产属性。', 'high', 'watching', '后续解读必须同时保留消费使用价值与资产属性，不把政策支持外推为价格或保值承诺。', '2026-07-13T10:30:00+08:00', null);
      ambiguityInsert.run(currentId, currentAnalysisV2, '公开文本存在删减', '中国政府网页明确注明“本文有删减”，公开内容不能支持对删减部分的确定性判断。', 'high', 'open', '只用已公开原文作事实依据；出现正式附件或配套文件时新增分析版本，不回写旧版本。', '2026-07-13T10:30:00+08:00', null);
      ambiguityInsert.run(currentId, currentAnalysisV2, '60万亿元指标的覆盖范围', '社会消费品零售总额不是全部消费和居民福利的完整度量，不能据此替代服务消费、价格变化、居民负担和消费率等指标。', 'medium', 'watching', '结合统计口径、价格因素、服务消费和居民消费率交叉验证，不把单一名义总量作为唯一成效依据。', '2026-07-13T10:30:00+08:00', null);
      ambiguityInsert.run(currentId, currentAnalysisV1, '是否代表新增补贴规模', '正式规划给出目标和任务，但不自动等于已确定新增财政补贴规模。', 'medium', 'clarified', '第二版分析明确：未写入正式文件的补贴规模不作为事实。', '2026-07-13T12:00:00+08:00', '2026-07-20T08:30:00+08:00');
    }

    const eventInsert = db.prepare(`
      INSERT INTO implementation_events (
        family_id, document_id, title, event_type, description,
        evidence_quote, source_url, occurred_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    if (!db.prepare('SELECT 1 FROM implementation_events WHERE family_id = ? LIMIT 1').get(familyId)) {
      eventInsert.run(familyId, historicalId, '长期扩大内需框架发布', 'policy_release', '确立消费提质升级、供给改善和内需体系建设的长期方向。', '中长期目标需要通过年度专项政策和地方执行逐步兑现。', 'https://www.gov.cn/zhengce/2022-12/14/content_5732067.htm', '2022-12-14T00:00:00+08:00', 'confirmed');
      eventInsert.run(familyId, actionId, '提振消费专项行动进入执行阶段', 'policy_release', '政策工具扩展到居民增收、保障、商品和服务消费。', '专项行动形成跨部门任务框架。', 'https://www.gov.cn/zhengce/202503/content_7013809.htm', '2025-03-16T00:00:00+08:00', 'confirmed');
      eventInsert.run(familyId, currentId, '国务院批复扩大消费“十五五”规划', 'policy_release', '国函〔2026〕66号公开，给出2030年社零总额约60万亿元等目标和任务。', '政府网页注明“本文有删减”，执行效果需继续跟踪配套政策和统计结果。', 'https://www.gov.cn/zhengce/content/202607/content_7075216.htm', '2026-07-13T00:00:00+08:00', 'confirmed');
    }

    const snapshotInsert = db.prepare(`
      INSERT INTO assessment_snapshots (
        family_id, as_of_date, summary, score, conclusion, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    if (!db.prepare('SELECT 1 FROM assessment_snapshots WHERE family_id = ? LIMIT 1').get(familyId)) {
      snapshotInsert.run(
        familyId,
        '2025-12-31',
        '商品更新工具落地快，收入和服务供给的结构性效果仍需跨年度观察。',
        66,
        '部分落地：执行动作明确，但不能把短期交易额直接等同于居民消费能力永久提高。',
        JSON.stringify([
          { type: 'policy', documentId: actionId, note: '专项行动已发布并进入地方执行' },
          { type: 'forecast', analysisVersionId: actionAnalysisId, note: '以旧换新判断部分验证' }
        ])
      );
      snapshotInsert.run(
        familyId,
        '2026-07-20',
        '正式规划及60万亿元目标已确认，当前重点转为核验部门和地方配套、住房与休假条款落实以及结果指标。',
        62,
        '规划发布已落地，执行证据尚在形成；不能从住房消费表述推导法律、统计分类或资产属性变化。',
        JSON.stringify([
          { type: 'document', documentId: currentId, note: '政策文本进入核验与配套跟踪阶段' },
          { type: 'analysis', analysisVersionId: currentAnalysisV2, note: '第二版保留事实与预测边界' }
        ])
      );
    }

    if (!db.prepare('SELECT 1 FROM sync_runs LIMIT 1').get()) {
      db.prepare(`
        INSERT INTO sync_runs (
          status, started_at, completed_at, sources_checked,
          documents_found, documents_added, message
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        'succeeded',
        '2026-07-20T08:00:00+08:00',
        '2026-07-20T08:02:10+08:00',
        3,
        3,
        3,
        '初始化政策脉络、分析版本和验证状态。示例中的待核验项不得视为官方已确认事实。'
      );
    }

    return {
      sources: 3,
      familyId,
      documents: [historicalId, actionId, currentId],
      latestAnalysisId: currentAnalysisV2,
      statsSourceId
    };
  });
}

module.exports = { seedDatabase };
