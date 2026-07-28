'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { openDatabase } = require('../../server/src/db');
const {
  normalizeHistoricalFramework,
  runHistoricalFrameworkQueue
} = require('../src/historical-framework');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createAwaitingFramework(db, suffix) {
  const title = `历史政策结构化解读测试 ${suffix}`;
  const sourceUrl = `https://www.gov.cn/gongbao/2000/framework-${suffix}.htm`;
  const quote = `${title}明确政策任务、适用对象和执行责任。`;
  const content = `${quote}\n国务院\n2000年1月2日\n${'各有关部门按照职责组织实施。'.repeat(20)}`;
  const itemId = Number(db.prepare(`
    INSERT INTO historical_backfill_items (
      source_url, source_name, source_type, item_kind, source_year, title, issuer,
      published_at, content_text, checksum, stage, source_status, metadata_status,
      lifecycle_status, implementation_status, outcome_status, analysis_status,
      evidence_urls_json, review_notes, reviewed_by, reviewed_at
    ) VALUES (?, '国务院公报', 'html', 'document', 2000, ?, '国务院',
      '2000-01-02T00:00:00+08:00', ?, ?, 'lifecycle_verified', 'verified', 'verified',
      'verified', 'not_found', 'not_found', 'verified', ?,
      'four-status assessment complete', 'historical-evidence-gates-v2',
      '2026-07-26T12:00:00+08:00')
  `).run(sourceUrl, title, content, sha256(content), JSON.stringify([sourceUrl])).lastInsertRowid);
  const gates = [{ name: 'fixture', passed: true, reason: 'verified fixture' }];
  const analysis = {
    reviewStatus: 'watching',
    confidence: 0.99,
    summary: '政策原文已确认，实施和结果仍按证据分别核验。',
    cycleAssessment: '生命周期已核验。',
    implementationAssessment: '完整范围内未找到实施证据。',
    outcomeAssessment: '完整范围内未找到结果证据。',
    ambiguities: [],
    citations: [{ kind: 'source', sourceUrl, quote, confidence: 1 }],
    evidenceQuotes: [quote],
    gates,
    methodology: 'historical-evidence-gates-v2'
  };
  const inputChecksum = sha256(`${itemId}:${content}:assessment`);
  const assessmentId = Number(db.prepare(`
    INSERT INTO historical_analysis_versions (
      item_id, version, input_checksum, review_status, confidence,
      release_eligible, gates_json, analysis_json, methodology
    ) VALUES (?, 1, ?, 'watching', 0.99, 1, ?, ?, 'historical-evidence-gates-v2')
  `).run(itemId, inputChecksum, JSON.stringify(gates), JSON.stringify(analysis)).lastInsertRowid);
  db.prepare(`
    UPDATE historical_backfill_items SET analysis_json = ? WHERE id = ?
  `).run(JSON.stringify({
    ...analysis,
    assessmentVersionId: assessmentId,
    assessmentVersion: 1
  }), itemId);
  return { itemId, assessmentId, title, quote };
}

function completePayload(item) {
  const evidence = () => [{ source_id: `item:${item.itemId}`, quote: item.quote }];
  return {
    bottom_line: '政策明确了任务和责任，但发文不等于已经形成实施结果。',
    final_conclusion: {
      text: '政策方向已经明确，但当前只能确认发文，尚不能确认实施和结果。',
      evidence_refs: evidence()
    },
    policy_problem: { text: '明确政策任务、对象和责任。', evidence_refs: evidence() },
    policy_tools: [{ label: '任务部署', detail: '用正式政策文本部署任务。', evidence_refs: evidence() }],
    affected_groups: [{ label: '执行部门', detail: '有关部门按职责组织实施。', evidence_refs: evidence() }],
    execution_path: [{ label: '部门实施', detail: '从正式发文进入部门执行。', evidence_refs: evidence() }],
    historical_comparison: [],
    history_boundary: '没有已核验前序政策关系，不作历史对比。',
    forward_signals: [{
      signal: '下一步应出现部门实施安排。',
      basis: '政策原文已经把组织实施责任交给有关部门。',
      time_window: '发布后180天',
      expected_by: '2000-06-30',
      confidence: 0.66,
      prerequisites: '有关部门形成正式执行文件。',
      disconfirming_evidence: '发布后未形成执行文件，或正式文件撤回任务。',
      evidence_refs: evidence()
    }]
  };
}

const idleLoad = () => ({ normalizedLoad: 0, freeMemoryRatio: 0.6 });
const modelConfig = { baseUrl: 'https://model.example/v1', apiKey: 'test-key', modelName: 'test-model' };

test('citation-checked framework moves an assessed historical item to private ready', async () => {
  const db = openDatabase(':memory:');
  try {
    const item = createAwaitingFramework(db, 'ready');
    const result = await runHistoricalFrameworkQueue(db, {
      maxItems: 1,
      modelConfig
    }, {
      loadSnapshot: idleLoad,
      requestFramework: async () => completePayload(item)
    });
    assert.equal(result.ready, 1);
    assert.equal(result.incomplete, 0);
    const storedItem = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(item.itemId);
    assert.equal(storedItem.stage, 'ready');
    const analysis = JSON.parse(storedItem.analysis_json);
    assert.ok(analysis.frameworkVersionId);
    const framework = db.prepare(`
      SELECT * FROM historical_analysis_frameworks WHERE id = ?
    `).get(analysis.frameworkVersionId);
    const payload = JSON.parse(framework.framework_json);
    assert.equal(payload.ready, true);
    assert.equal(payload.tools[0].evidence[0].quote, item.quote);
    assert.equal(payload.implementationAssessment.realizationStatus, 'watching');
    assert.equal(payload.forwardSignals[0].timeWindow, '发布后180天');
    assert.throws(
      () => db.prepare('UPDATE historical_analysis_frameworks SET model_name = ? WHERE id = ?')
        .run('changed', framework.id),
      /immutable/
    );
  } finally {
    db.close();
  }
});

test('fabricated or missing field citations keep the historical item private', async () => {
  const db = openDatabase(':memory:');
  try {
    const item = createAwaitingFramework(db, 'blocked');
    const payload = completePayload(item);
    payload.policy_tools[0].evidence_refs[0].quote = '原文中不存在的模型引用。';
    const result = await runHistoricalFrameworkQueue(db, {
      maxItems: 1,
      modelConfig
    }, {
      loadSnapshot: idleLoad,
      requestFramework: async () => payload
    });
    assert.equal(result.ready, 0);
    assert.equal(result.incomplete, 1);
    assert.deepEqual(result.items[0].missing, ['policy_tools']);
    const storedItem = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(item.itemId);
    assert.equal(storedItem.stage, 'lifecycle_verified');
    assert.match(storedItem.last_error, /policy_tools/);
    assert.ok(storedItem.next_attempt_at);
    const framework = db.prepare('SELECT framework_json FROM historical_analysis_frameworks').get();
    assert.equal(JSON.parse(framework.framework_json).ready, false);
  } finally {
    db.close();
  }
});

test('normalization drops historical comparisons without current and verified historical quotes', () => {
  const evidenceBundle = {
    inputChecksum: sha256('fixture'),
    sources: [{
      id: 'item:1', itemId: 1, roles: ['current_policy'], title: '当前政策', issuer: '国务院',
      publishedAt: '2000-01-01', sourceUrl: 'https://www.gov.cn/current', checksum: sha256('当前政策原文'),
      text: '当前政策原文'
    }]
  };
  const payload = {
    ...completePayload({ itemId: 1, quote: '当前政策原文' }),
    historical_comparison: [{
      dimension: '工具', previous: '过去做法', current: '当前做法', implication: '发生变化',
      evidence_refs: [{ source_id: 'item:1', quote: '当前政策原文' }]
    }]
  };
  const normalized = normalizeHistoricalFramework(payload, evidenceBundle, {});
  assert.equal(normalized.framework.ready, true);
  assert.deepEqual(normalized.framework.historicalChanges, []);
  assert.match(normalized.framework.historyBoundary, /不作历史对比/);
});

test('database rejects a ready framework whose cited quote is absent from the official source', () => {
  const db = openDatabase(':memory:');
  try {
    const item = createAwaitingFramework(db, 'forged-framework');
    const citation = {
      sourceId: `item:${item.itemId}`,
      sourceItemId: item.itemId,
      sourceUrl: `https://www.gov.cn/gongbao/2000/framework-forged-framework.htm`,
      title: item.title,
      roles: ['current_policy'],
      quote: '官方原文中不存在的伪造引用。'
    };
    const structured = { label: '伪造项', detail: '伪造细节', evidence: [citation] };
    const framework = {
      ready: true,
      perspective: '政策演进、实际落地与下一步方向',
      bottomLine: '伪造结论',
      finalConclusion: '伪造最终结论',
      finalConclusionEvidence: [citation],
      problem: '伪造问题',
      problemEvidence: [citation],
      tools: [structured],
      affectedGroups: [structured],
      executionPath: [structured],
      historicalChanges: [],
      implementationAssessment: {
        realizationStatus: 'watching',
        conclusion: '伪造兑现判断'
      },
      forwardSignals: [{
        signal: '伪造信号', basis: '伪造依据', timeWindow: '未来一年',
        confidence: 0.5, prerequisites: '伪造前提', disconfirmingEvidence: '伪造反证',
        evidence: [citation]
      }]
    };
    assert.throws(
      () => db.prepare(`
        INSERT INTO historical_analysis_frameworks (
          assessment_version_id, version, source_checksum, input_checksum,
          response_checksum, framework_json, evidence_json, method, model_name, prompt_version
        ) SELECT ?, 1, item.checksum, ?, ?, ?, ?, 'forged', 'forged', 'analyze-historical-policy-v2'
          FROM historical_backfill_items item WHERE item.id = ?
      `).run(
        item.assessmentId,
        sha256('input'),
        sha256('response'),
        JSON.stringify(framework),
        JSON.stringify([citation]),
        item.itemId
      ),
      /incomplete or unlinked/
    );
  } finally {
    db.close();
  }
});

test('auto mode reports the private backlog without a configured model', async () => {
  const db = openDatabase(':memory:');
  try {
    const item = createAwaitingFramework(db, 'no-model');
    const result = await runHistoricalFrameworkQueue(db, {
      maxItems: 10,
      modelConfig: { baseUrl: '', apiKey: '', modelName: '' }
    }, { loadSnapshot: idleLoad });
    assert.equal(result.skipped, true);
    assert.equal(result.selected, 1);
    assert.equal(result.processed, 0);
    assert.match(result.reason, /remain private/);
    assert.equal(db.prepare('SELECT stage FROM historical_backfill_items WHERE id = ?').get(item.itemId).stage,
      'lifecycle_verified');
  } finally {
    db.close();
  }
});

test('framework queue uses bounded model concurrency', async () => {
  const db = openDatabase(':memory:');
  try {
    const fixtures = [
      createAwaitingFramework(db, 'parallel-a'),
      createAwaitingFramework(db, 'parallel-b'),
      createAwaitingFramework(db, 'parallel-c')
    ];
    const byId = new Map(fixtures.map((item) => [item.itemId, item]));
    let active = 0;
    let maximumActive = 0;
    const result = await runHistoricalFrameworkQueue(db, {
      maxItems: 3,
      modelConfig,
      modelConcurrency: 2,
      modelTimeoutMs: 240_000
    }, {
      loadSnapshot: idleLoad,
      requestFramework: async (item) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return completePayload(byId.get(Number(item.id)));
      }
    });
    assert.equal(result.ready, 3);
    assert.equal(result.processed, 3);
    assert.equal(result.modelConcurrency, 2);
    assert.equal(result.modelTimeoutMs, 240_000);
    assert.equal(maximumActive, 2);
  } finally {
    db.close();
  }
});

test('framework timeouts retry promptly even after earlier pipeline attempts', async () => {
  const db = openDatabase(':memory:');
  try {
    const item = createAwaitingFramework(db, 'timeout-retry');
    db.prepare('UPDATE historical_backfill_items SET attempts = 5 WHERE id = ?').run(item.itemId);
    const startedAt = Date.now();
    const result = await runHistoricalFrameworkQueue(db, {
      maxItems: 1,
      modelConfig
    }, {
      loadSnapshot: idleLoad,
      requestFramework: async () => {
        throw new Error('The operation was aborted due to timeout');
      }
    });
    assert.equal(result.status, 'failed');
    const stored = db.prepare('SELECT attempts,last_error,next_attempt_at FROM historical_backfill_items WHERE id = ?')
      .get(item.itemId);
    assert.equal(stored.attempts, 6);
    assert.match(stored.last_error, /timeout/);
    const retryDelayMinutes = (Date.parse(stored.next_attempt_at) - startedAt) / 60_000;
    assert.ok(retryDelayMinutes >= 29 && retryDelayMinutes <= 31);
  } finally {
    db.close();
  }
});
