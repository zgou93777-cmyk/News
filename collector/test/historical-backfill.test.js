'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { openDatabase } = require('../../server/src/db');
const {
  adaptiveBatchSize,
  discoverHistoricalLinks,
  enqueueHistoricalItem,
  historicalQueueAudit,
  historicalQueueStats,
  runHistoricalDiscovery,
  runHistoricalQueue
} = require('../src/historical-backfill');
const { validateHistoricalReview } = require('../src/historical-review');
const { verifySourceMetadata } = require('../src/historical-verification');

test('historical discovery keeps official links and preserves honest years', () => {
  const raw = JSON.stringify({
    issues: [
      { year: 1954, title: '1954年第1号', url: '/gongbao/shuju/1954/gwyb195401.pdf' },
      { year: 2000, title: '2000年第1号', url: '/gongbao/2000/issue_1000/' },
      { year: 1948, title: 'outside range', url: '/gongbao/1948/a.htm' },
      { year: 2001, title: 'external', url: 'https://example.com/a.htm' }
    ],
    values: {
      '1955年': {
        '第1号': { issue: '第1号', gname: 'https://www.gov.cn/gongbao/1955/issue_2000/' }
      }
    }
  });
  const links = discoverHistoricalLinks(raw, 'https://www.gov.cn/gongbao/gbgl.json', {
    allowedHosts: ['www.gov.cn'],
    fromYear: 1949,
    toYear: 2000
  });
  assert.equal(links.length, 3);
  assert.deepEqual(links.map((item) => item.sourceYear), [1954, 1955, 2000]);
  assert.equal(links[0].sourceType, 'pdf');
  assert.equal(links[0].itemKind, 'issue');
  assert.equal(links[1].itemKind, 'issue');
  assert.equal(links[2].itemKind, 'issue');
});

test('legacy official script rows become deterministic PDF issue URLs without execution', () => {
  const script = `var dat = [
    ["1955", "--", "1", "2", "23"],
    ["1954", "--", "1", "2", "3"],
  ];`;
  const links = discoverHistoricalLinks(script, 'https://www.gov.cn/images/gbIssue.js', {
    allowedHosts: ['www.gov.cn'],
    fromYear: 1954,
    toYear: 1955
  });
  assert.equal(links.length, 6);
  assert.equal(links[0].url, 'https://www.gov.cn/gongbao/shuju/1954/gwyb195401.pdf');
  assert.equal(links[5].url, 'https://www.gov.cn/gongbao/shuju/1955/gwyb195523.pdf');
  assert.ok(links.every((item) => item.itemKind === 'issue' && item.sourceType === 'pdf'));
});

test('historical discovery resumes after URLs already queued', async () => {
  const db = openDatabase(':memory:');
  try {
    const navigation = JSON.stringify({ values: {
      '1954年': { '第1号': { issue: '第1号', gname: 'https://www.gov.cn/gongbao/1954/issue_1/' } },
      '1955年': { '第1号': { issue: '第1号', gname: 'https://www.gov.cn/gongbao/1955/issue_2/' } }
    } });
    const dependencies = { fetchText: async () => ({ body: navigation, contentType: 'application/json', finalUrl: 'https://www.gov.cn/gongbao/gbgl.json' }) };
    const first = await runHistoricalDiscovery(db, { fromYear: 1949, toYear: 1955, maxItems: 1 }, dependencies);
    const second = await runHistoricalDiscovery(db, { fromYear: 1949, toYear: 1955, maxItems: 1 }, dependencies);
    assert.equal(first.queued, 1);
    assert.equal(first.sources[0].remainingAfterBatch, 1);
    assert.equal(second.queued, 1);
    assert.equal(second.sources[0].remainingAfterBatch, 0);
    assert.deepEqual(
      db.prepare('SELECT source_year FROM historical_backfill_items ORDER BY source_year').all().map((row) => row.source_year),
      [1954, 1955]
    );
    const scan = db.prepare('SELECT * FROM historical_source_scans').get();
    assert.equal(scan.complete, 1);
    assert.equal(scan.remaining_items, 0);
  } finally {
    db.close();
  }
});

test('issue expansion rejects navigation and archive footer links outside the issue', () => {
  const html = `
    <a href="./202607/content_7075912.html">国务院令</a>
    <a href="./material/gwygb202620.pdf">本期公报 PDF</a>
    <a href="../../../zhengce/gongbao/guowuyuan1954_1999/">历史导航</a>
    <a href="/zhengce/2011-11/09/content_2619419.htm">页脚旧公报</a>`;
  const links = discoverHistoricalLinks(html, 'https://www.gov.cn/gongbao/2026/issue_12866/', {
    allowedHosts: ['www.gov.cn'],
    parentKind: 'issue',
    parentYear: 2026,
    fromYear: 1949,
    toYear: 2026
  });
  assert.deepEqual(links.map((item) => item.itemKind).sort(), ['document', 'issue']);
  assert.ok(links.every((item) => item.url.includes('/gongbao/2026/issue_12866/')));
});

test('legacy issue pages may link to their same-year official PDF outside the page directory', () => {
  const html = `
    <a href="https://www.gov.cn/gongbao/shuju/1954/gwyb195401.pdf">1954年第1号 PDF</a>
    <a href="/zhengce/2011-11/09/content_2619420.htm">相邻期号</a>`;
  const links = discoverHistoricalLinks(html, 'https://www.gov.cn/zhengce/2011-11/09/content_2619419.htm', {
    allowedHosts: ['www.gov.cn'],
    parentKind: 'issue',
    parentYear: 1954,
    fromYear: 1949,
    toYear: 2026
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].url, 'https://www.gov.cn/gongbao/shuju/1954/gwyb195401.pdf');
  assert.equal(links[0].itemKind, 'issue');
});

test('HTML documents stop at needs_review and never become public articles', async () => {
  const db = openDatabase(':memory:');
  try {
    enqueueHistoricalItem(db, {
      url: 'https://www.gov.cn/zhengce/2000-01/02/content_123.htm',
      sourceName: '中华人民共和国国务院公报',
      sourceType: 'html',
      itemKind: 'document',
      sourceYear: 2000,
      title: '测试政策'
    });
    const itemId = db.prepare('SELECT id FROM historical_backfill_items').get().id;
    db.prepare(`
      INSERT INTO historical_verification_evidence (
        item_id, source_item_id, claim_type, status, value_text, evidence_quote,
        source_url, extractor, confidence
      ) VALUES (?, ?, 'title', 'verified', ?, ?, ?, 'historical-metadata-v2', 0.95)
    `).run(
      itemId, itemId, '国务院关于测试政策的通知', 'h1: 国务院关于测试政策的通知',
      'https://www.gov.cn/zhengce/2000-01/02/content_123.htm'
    );
    const html = `<!doctype html><html><head>
      <meta name="firstpublishedtime" content="2000-01-02-10:00:00">
      <meta name="author" content="网站编辑">
      <title>国务院关于测试政策的通知__2000年第1号国务院公报_中国政府网</title>
      </head><body><h1>国务院关于测试政策的通知</h1>
      <div id="UCAP-CONTENT"><p>为验证历史政策核验队列，本文件正文包含足够长度的政策内容，但不会自动公开。</p>
      <p>各地区、各部门应结合实际认真贯彻执行，并持续公开实施情况和结果证据。</p>
      </div></body></html>`;
    const result = await runHistoricalQueue(db, { maxItems: 1, delayMs: 0 }, {
      fetchText: async () => ({ body: html, contentType: 'text/html; charset=utf-8', finalUrl: 'https://www.gov.cn/zhengce/2000-01/02/content_123.htm' })
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.items[0].action, 'extracted_for_review');
    const queued = db.prepare('SELECT * FROM historical_backfill_items').get();
    assert.equal(queued.stage, 'needs_review');
    assert.equal(queued.source_status, 'pending');
    assert.equal(queued.lifecycle_status, 'pending');
    assert.equal(queued.analysis_status, 'pending');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 0);
    const evidence = db.prepare(`
      SELECT claim_type, value_text, evidence_quote, extractor
      FROM historical_verification_evidence WHERE item_id = ? ORDER BY claim_type
    `).all(queued.id);
    assert.deepEqual(evidence.map((entry) => entry.claim_type), ['issuer', 'published_at', 'title']);
    assert.ok(evidence.every((entry) => entry.evidence_quote && entry.extractor.startsWith('official-')));
    assert.equal(evidence.find((entry) => entry.claim_type === 'title').extractor, 'official-html-heading-v1');

    const verification = verifySourceMetadata(db, queued);
    assert.equal(verification.complete, true);
    const verified = db.prepare('SELECT stage, metadata_status FROM historical_backfill_items WHERE id = ?').get(queued.id);
    assert.equal(verified.stage, 'source_verified');
    assert.equal(verified.metadata_status, 'verified');
  } finally {
    db.close();
  }
});

test('PDF issues are isolated for manual OCR and article segmentation', async () => {
  const db = openDatabase(':memory:');
  try {
    enqueueHistoricalItem(db, {
      url: 'https://www.gov.cn/gongbao/shuju/1954/gwyb195401.pdf',
      sourceName: '中华人民共和国国务院公报',
      sourceType: 'pdf',
      itemKind: 'issue',
      sourceYear: 1954
    });
    await runHistoricalQueue(db, { maxItems: 1, delayMs: 0 }, {
      fetchText: async () => ({ body: '%PDF test', contentType: 'application/pdf', finalUrl: 'https://www.gov.cn/gongbao/shuju/1954/gwyb195401.pdf' })
    });
    assert.deepEqual(historicalQueueStats(db), { manual_review: 1 });
    assert.equal(db.prepare('SELECT document_id FROM historical_backfill_items').get().document_id, null);
  } finally {
    db.close();
  }
});

test('human review requires official evidence and a complete cycle/implementation analysis', () => {
  const item = {
    id: 1,
    item_kind: 'document',
    stage: 'manual_review',
    source_url: 'https://www.gov.cn/zhengce/2000-01/02/content_123.htm',
    title: '测试政策',
    issuer: '国务院',
    published_at: '2000-01-02',
    document_number: ''
  };
  const valid = {
    evidenceUrls: [item.source_url, 'https://www.stats.gov.cn/sj/example.html'],
    lifecycleStatus: 'verified',
    implementationStatus: 'verified',
    outcomeStatus: 'not_found',
    policyCycle: { announcedAt: '2000-01-02', effectiveAt: '2000-02-01', endedAt: null, assessment: '文件明确实施日期，未见废止公告。' },
    implementationEvidence: [{
      title: '实施细则',
      sourceUrl: 'https://www.gov.cn/zhengce/2000-02/01/content_456.htm',
      evidenceQuote: '自2000年2月1日起施行。',
      observedAt: '2000-02-01'
    }],
    outcomeEvidence: [],
    analysis: {
      summary: '政策建立了测试制度。',
      cycleAssessment: '已核对发文和实施日期，尚未发现废止文件。',
      implementationAssessment: '实施细则构成落地证据，会议表态未计入。',
      outcomeAssessment: '未找到足以证明政策结果的连续官方数据。',
      ambiguities: ['结果数据缺失'],
      evidenceQuotes: ['自2000年2月1日起施行。']
    },
    framework: {
      bottom_line: '政策已经建立测试制度，但结果证据仍不完整。',
      final_conclusion: {
        text: '测试制度已经进入实施，但结果证据仍不足，暂不能判断完整成效。',
        evidence_refs: [{ source_id: 'review:implementation:0', quote: '自2000年2月1日起施行。' }]
      },
      policy_problem: {
        text: '建立测试制度并明确实施边界。',
        evidence_refs: [{ source_id: 'review:implementation:0', quote: '自2000年2月1日起施行。' }]
      },
      policy_tools: [{
        label: '实施细则', detail: '以实施细则确定生效安排。',
        evidence_refs: [{ source_id: 'review:implementation:0', quote: '自2000年2月1日起施行。' }]
      }],
      affected_groups: [{
        label: '执行主体', detail: '执行主体按实施日期落实制度。',
        evidence_refs: [{ source_id: 'review:implementation:0', quote: '自2000年2月1日起施行。' }]
      }],
      execution_path: [{
        label: '正式施行', detail: '从正式文件进入实施阶段。',
        evidence_refs: [{ source_id: 'review:implementation:0', quote: '自2000年2月1日起施行。' }]
      }],
      historical_comparison: [],
      history_boundary: '没有提供已核验前序政策，不作历史对比。',
      forward_signals: [{
        signal: '下一步需要出现连续官方结果数据。',
        basis: '制度已经正式施行，但结果证据仍未闭合。',
        time_window: '下一年度结果发布周期',
        expected_by: null,
        confidence: 0.6,
        prerequisites: '主管部门持续发布实施结果。',
        disconfirming_evidence: '正式文件终止制度或结果数据证明制度未继续执行。',
        evidence_refs: [{ source_id: 'review:implementation:0', quote: '自2000年2月1日起施行。' }]
      }]
    },
    reviewNotes: '逐项核对原文、实施细则和统计口径；结果仍待后续证据。',
    reviewedBy: 'editor-1',
    reviewedAt: '2026-07-26T12:00:00+08:00'
  };
  const reviewed = validateHistoricalReview(item, valid);
  assert.equal(reviewed.lifecycleStatus, 'verified');
  assert.equal(reviewed.implementationEvidence.length, 1);
  assert.equal(reviewed.analysis.citations.length, 1);
  assert.throws(
    () => validateHistoricalReview(item, { ...valid, evidenceUrls: ['https://example.com/a'] }),
    /official \.gov\.cn/
  );
  assert.throws(
    () => validateHistoricalReview(item, { ...valid, implementationEvidence: [] }),
    /requires evidence/
  );
  assert.throws(
    () => validateHistoricalReview(item, {
      ...valid,
      analysis: { ...valid.analysis, evidenceQuotes: ['原文和结构化证据中都不存在的句子。'] }
    }),
    /must match the source text or a structured evidence entry/
  );
});

test('adaptive history batches use capacity when idle and stop early under pressure', async () => {
  assert.equal(adaptiveBatchSize(12, 2, { normalizedLoad: 0.2, freeMemoryRatio: 0.4 }), 12);
  assert.equal(adaptiveBatchSize(12, 2, { normalizedLoad: 0.5, freeMemoryRatio: 0.4 }), 6);
  assert.equal(adaptiveBatchSize(12, 2, { normalizedLoad: 0.8, freeMemoryRatio: 0.4 }), 3);
  assert.equal(adaptiveBatchSize(12, 2, { normalizedLoad: 1.2, freeMemoryRatio: 0.4 }), 2);

  const db = openDatabase(':memory:');
  try {
    for (let issue = 1; issue <= 5; issue += 1) {
      enqueueHistoricalItem(db, {
        url: `https://www.gov.cn/gongbao/shuju/1954/gwyb1954${String(issue).padStart(2, '0')}.pdf`,
        sourceName: '中华人民共和国国务院公报',
        sourceType: 'pdf',
        itemKind: 'issue',
        sourceYear: 1954
      });
    }
    let reads = 0;
    const result = await runHistoricalQueue(db, {
      adaptiveLoad: true,
      minItems: 2,
      maxItems: 5,
      delayMs: 0
    }, {
      fetchText: async (url) => ({ body: '%PDF', contentType: 'application/pdf', finalUrl: url }),
      loadSnapshot: () => (++reads === 1
        ? { normalizedLoad: 0.1, freeMemoryRatio: 0.5 }
        : { normalizedLoad: 1.2, freeMemoryRatio: 0.5 })
    });
    assert.equal(result.processed, 2);
    assert.equal(result.stoppedDueToLoad, true);
    assert.deepEqual(historicalQueueStats(db), { discovered: 3, manual_review: 2 });
  } finally {
    db.close();
  }
});

test('historical audit exposes recoverable work, blocked stages and integrity risks', () => {
  const db = openDatabase(':memory:');
  try {
    const ids = [];
    for (const [index, sourceType, itemKind, sourceYear] of [
      [1, 'html', 'document', 1954],
      [2, 'html', 'document', 1955],
      [3, 'html', 'document', 1956],
      [4, 'pdf', 'issue', 1957],
      [5, 'html', 'document', 2000]
    ]) {
      enqueueHistoricalItem(db, {
        url: `https://www.gov.cn/history/audit-${index}.${sourceType === 'pdf' ? 'pdf' : 'htm'}`,
        sourceName: 'Official archive',
        sourceType,
        itemKind,
        sourceYear,
        title: index === 5 ? '' : `Policy ${index}`
      });
      ids.push(db.prepare('SELECT last_insert_rowid() AS id').get().id);
    }
    db.prepare(`UPDATE historical_backfill_items SET stage = 'failed', attempts = 2, last_error = 'timeout' WHERE id = ?`).run(ids[1]);
    db.prepare(`
      UPDATE historical_backfill_items
      SET stage = 'failed', attempts = 4, last_error = 'timeout',
        next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day')
      WHERE id = ?
    `).run(ids[2]);
    db.prepare(`UPDATE historical_backfill_items SET stage = 'manual_review' WHERE id = ?`).run(ids[3]);
    db.prepare(`UPDATE historical_backfill_items SET stage = 'needs_review' WHERE id = ?`).run(ids[4]);

    const audit = historicalQueueAudit(db, { minItems: 5, maxItems: 100 }, {
      loadSnapshot: () => ({ cpuCount: 2, load1: 1, normalizedLoad: 0.5, freeMemoryRatio: 0.4 })
    });
    assert.equal(audit.status, 'succeeded');
    assert.equal(audit.total, 5);
    assert.deepEqual(audit.byStage, { discovered: 1, failed: 2, manual_review: 1, needs_review: 1 });
    assert.deepEqual(audit.recovery, {
      processableNow: 2,
      scheduledRetry: 1,
      awaitingPdfOcr: 1,
      awaitingVerification: 1,
      awaitingFramework: 0,
      indexedContainers: 0,
      readyForRelease: 0,
      published: 0
    });
    assert.equal(audit.retry.failed, 2);
    assert.equal(audit.retry.maxAttempts, 4);
    assert.deepEqual(audit.retry.topErrors, [{ message: 'timeout', count: 2 }]);
    assert.deepEqual(audit.coverage, { earliestYear: 1954, latestYear: 2000, yearsRepresented: 5 });
    assert.equal(audit.rollout.mode, 'disabled');
    assert.equal(audit.rollout.activeCohortId, null);
    assert.equal(audit.rollout.cohortItems, 0);
    assert.deepEqual(audit.integrity, {
      missingSourceYear: 0,
      documentsMissingMetadata: 1,
      releaseGuardViolations: 0,
      pdfSegmentationViolations: 0,
      documentLinkViolations: 0,
      orphanedParents: 0,
      staleReadyAssessments: 0,
      evidenceSourceViolations: 0,
      assessmentLinkViolations: 0,
      frameworkLinkViolations: 0,
      publicReleaseViolations: 0,
      publicDocumentMismatches: 0,
      criticalFailures: 0
    });
    assert.equal(audit.capacity.recommended, 50);
  } finally {
    db.close();
  }
});

test('historical audit excludes rejected PDF children from actionable backlog and metadata gaps', () => {
  const db = openDatabase(':memory:');
  try {
    enqueueHistoricalItem(db, {
      url: 'https://www.gov.cn/gongbao/shuju/1954/parent.pdf',
      sourceName: 'Official archive', sourceType: 'pdf', itemKind: 'issue', sourceYear: 1954
    });
    const parentId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    db.prepare("UPDATE historical_backfill_items SET stage = 'manual_review' WHERE id = ?").run(parentId);
    enqueueHistoricalItem(db, {
      url: 'https://www.gov.cn/gongbao/shuju/1954/parent.pdf#candidate=rejected',
      sourceName: 'Official archive', sourceType: 'pdf', itemKind: 'document', sourceYear: 1954,
      title: 'Rejected OCR candidate'
    });
    const childId = db.prepare('SELECT last_insert_rowid() AS id').get().id;
    db.prepare(`
      UPDATE historical_backfill_items SET
        parent_id = ?, stage = 'manual_review', source_status = 'rejected', metadata_status = 'rejected'
      WHERE id = ?
    `).run(parentId, childId);

    const audit = historicalQueueAudit(db, {}, {
      loadSnapshot: () => ({ cpuCount: 2, load1: 0, normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });
    assert.equal(audit.total, 2);
    assert.equal(audit.recovery.awaitingPdfOcr, 1);
    assert.equal(audit.integrity.documentsMissingMetadata, 0);
  } finally {
    db.close();
  }
});
