'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openDatabase } = require('../../server/src/db');
const { enqueueHistoricalItem } = require('../src/historical-backfill');
const {
  fetchPdfBuffer,
  historicalOcrProfile,
  ocrPdfPages,
  queueStaleOcrProfiles,
  runHistoricalPdfQueue,
  segmentPdfIssueText,
  splitPdfIssueText
} = require('../src/historical-pdf');

function issueText() {
  const first = `国务院关于开展第一项历史政策工作的通知\n国发〔1954〕1号\n${'各地区各部门应当根据本通知落实具体工作并保存执行记录。'.repeat(12)}`;
  const second = `国务院关于实施第二项历史政策的决定\n国发〔1954〕2号\n${'本决定明确政策范围实施时间责任机关以及后续检查要求。'.repeat(12)}`;
  return `${first}\f${second}`;
}

test('PDF issue segmentation preserves page ranges and deterministic checksums', () => {
  const candidates = splitPdfIssueText(issueText());
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((item) => [item.pageStart, item.pageEnd]), [[1, 1], [2, 2]]);
  assert.match(candidates[0].title, /通知$/u);
  assert.match(candidates[1].title, /决定$/u);
  assert.ok(candidates.every((item) => /^[a-f0-9]{64}$/.test(item.checksum)));
});

test('PDF segmentation accepts complete historical headings and rejects observed OCR title corruption', () => {
  const body = '本决定明确主管机关办理程序施行日期并保存正式记录。'.repeat(12);
  const valid = [
    `全国人民代表大会常务委员会关于同外国缔结条约的批准手续的决定\n一九五四年十月十六日全国人民代表大会常务委员会第一次会议通过\n${body}`,
    `国务院关于出版《中华人民共和国国务院公报》的决定\n一九五五年二月十日国务院常务会议通过\n${body}`
  ].join('\f');
  const accepted = segmentPdfIssueText(valid);
  assert.equal(accepted.reviewReasons.length, 0);
  assert.deepEqual(accepted.candidates.map((item) => item.title), [
    '全国人民代表大会常务委员会关于同外国缔结条约的批准手续的决定',
    '国务院关于出版《中华人民共和国国务院公报》的决定'
  ]);

  const corrupted = [
    `全国人民代表大会常务委员会\n关木同外国粲粟条粗的批准手精的决定\n一九五四年十月十六日全国人民代表大会常务委员会第一次会议通过\n${body}`,
    `国务院关方出版\n『中华人民共和国国务院公报的决定\n一九五五年二月十日国务院常务会议通过\n${body}`
  ].join('\f');
  const rejected = segmentPdfIssueText(corrupted);
  assert.equal(rejected.candidates.length, 0);
  assert.deepEqual(rejected.rejectedHeadings.map((item) => item.reason), [
    'missing-policy-title-structure',
    'unexpected-leading-character'
  ]);
  assert.ok(rejected.reviewReasons.includes('untrusted-headings:2'));
});

test('PDF segmentation rejects a late first boundary that leaves most of an issue unsegmented', () => {
  const frontMatter = Array.from({ length: 32 }, (_, index) => `第${index + 1}页未识别正文${'历史公报扫描内容'.repeat(20)}`);
  const policy = `国务院关于出版《中华人民共和国国务院公报》的决定\n一九五五年二月十日国务院常务会议通过\n${'本决定明确公报出版范围和主管机关。'.repeat(20)}`;
  const result = segmentPdfIssueText([...frontMatter, policy, ...Array(15).fill('后续正文')].join('\f'));

  assert.equal(result.candidates.length, 1);
  assert.ok(result.reviewReasons.includes('unsegmented-leading-pages:32'));
});

test('PDF issue stays private when segmentation quality gates reject OCR headings', async () => {
  const db = openDatabase(':memory:');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-pdf-quality-'));
  const body = '本决定明确主管机关办理程序施行日期并保存正式记录。'.repeat(12);
  const corrupted = `关木同外国粲粟条粗的批准手精的决定\n一九五四年十月十六日全国人民代表大会常务委员会第一次会议通过\n${body}`;
  try {
    enqueueHistoricalItem(db, {
      url: 'https://www.gov.cn/gongbao/shuju/1954/gwyb195401.pdf',
      sourceName: 'State Council Gazette',
      sourceType: 'pdf',
      itemKind: 'issue',
      sourceYear: 1954
    });
    db.prepare("UPDATE historical_backfill_items SET stage = 'manual_review'").run();
    const result = await runHistoricalPdfQueue(db, { cacheDir, maxItems: 1, delayMs: 0 }, {
      fetchPdf: async (url) => ({ buffer: Buffer.from('%PDF-1.4 scan'), finalUrl: url }),
      extractEmbeddedText: async () => corrupted,
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });

    assert.equal(result.items[0].action, 'segmentation_review');
    assert.equal(result.items[0].rejectedHeadings, 1);
    const parent = db.prepare('SELECT * FROM historical_backfill_items').get();
    assert.equal(parent.stage, 'manual_review');
    assert.match(parent.last_error, /untrusted-headings:1/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM historical_backfill_items WHERE parent_id IS NOT NULL').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 0);
    const artifact = db.prepare("SELECT * FROM historical_artifacts WHERE artifact_type = 'segmentation'").get();
    assert.equal(JSON.parse(artifact.metadata_json).status, 'review_required');
  } finally {
    db.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('legacy v1 PDF candidates are requeued, rechecked and quarantined when v2 rejects them', async () => {
  const db = openDatabase(':memory:');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-pdf-legacy-'));
  const body = '本决定明确主管机关办理程序施行日期并保存正式记录。'.repeat(12);
  const corruptedTitle = '关木同外国粲粟条粗的批准手精的决定';
  const corrupted = `${corruptedTitle}\n一九五四年十月十六日全国人民代表大会常务委员会第一次会议通过\n${body}`;
  try {
    enqueueHistoricalItem(db, {
      url: 'https://www.gov.cn/gongbao/shuju/1954/gwyb195400.pdf',
      sourceName: 'Earlier queued issue', sourceType: 'pdf', itemKind: 'issue', sourceYear: 1954
    });
    const earlierId = Number(db.prepare('SELECT id FROM historical_backfill_items').get().id);
    db.prepare("UPDATE historical_backfill_items SET stage = 'manual_review' WHERE id = ?").run(earlierId);
    enqueueHistoricalItem(db, {
      url: 'https://www.gov.cn/gongbao/shuju/1954/gwyb195401.pdf',
      sourceName: 'State Council Gazette', sourceType: 'pdf', itemKind: 'issue', sourceYear: 1954
    });
    const parentId = Number(db.prepare('SELECT max(id) AS id FROM historical_backfill_items').get().id);
    db.prepare("UPDATE historical_backfill_items SET stage = 'indexed' WHERE id = ?").run(parentId);
    db.prepare(`
      INSERT INTO historical_backfill_items (
        parent_id, source_url, source_name, source_type, item_kind, source_year,
        title, content_text, checksum, stage
      ) VALUES (?, ?, 'State Council Gazette', 'pdf', 'document', 1954, ?, ?, ?, 'needs_review')
    `).run(
      parentId,
      'https://www.gov.cn/gongbao/shuju/1954/gwyb195401.pdf#candidate=legacy',
      corruptedTitle,
      corrupted,
      crypto.createHash('sha256').update(corrupted).digest('hex')
    );
    db.prepare(`
      INSERT INTO historical_artifacts (
        item_id, artifact_type, storage_path, checksum, byte_size, page_start, page_end, engine
      ) VALUES (?, 'segmentation', 'segments/legacy.json', ?, 2, 1, 1, 'policy-heading-v1')
    `).run(parentId, 'b'.repeat(64));

    const result = await runHistoricalPdfQueue(db, { cacheDir, maxItems: 1, delayMs: 0 }, {
      fetchPdf: async (url) => ({ buffer: Buffer.from('%PDF-1.4 scan'), finalUrl: url }),
      extractEmbeddedText: async () => corrupted,
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });

    assert.equal(result.legacyQueued, 1);
    assert.equal(result.items[0].id, parentId);
    assert.equal(result.items[0].action, 'segmentation_review');
    assert.equal(result.items[0].quarantined, 1);
    const parent = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(parentId);
    assert.equal(parent.stage, 'manual_review');
    const child = db.prepare('SELECT * FROM historical_backfill_items WHERE parent_id = ?').get(parentId);
    assert.equal(child.stage, 'manual_review');
    assert.equal(child.source_status, 'rejected');
    assert.equal(child.metadata_status, 'rejected');
    assert.match(child.last_error, /segmentation rejected/);
    db.prepare(`
      UPDATE historical_backfill_items
      SET next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day')
      WHERE id = ?
    `).run(earlierId);
    const repeated = await runHistoricalPdfQueue(db, { cacheDir, maxItems: 1, delayMs: 0 }, {
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });
    assert.equal(repeated.legacyQueued, 0);
    assert.equal(repeated.selected, 0);
  } finally {
    db.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('PDF fetch accepts only bounded official PDF bytes', async () => {
  const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
  const valid = await fetchPdfBuffer('https://www.gov.cn/gongbao/test.pdf', {
    lookupImpl,
    fetchImpl: async () => new Response(Buffer.from('%PDF-1.4 source'), {
      status: 200,
      headers: { 'content-type': 'application/pdf' }
    })
  });
  assert.equal(valid.buffer.subarray(0, 5).toString('ascii'), '%PDF-');
  await assert.rejects(
    fetchPdfBuffer('https://example.com/test.pdf', { lookupImpl, fetchImpl: async () => null }),
    /official \.gov\.cn/
  );
  await assert.rejects(
    fetchPdfBuffer('https://www.gov.cn/gongbao/test.pdf', {
      lookupImpl,
      fetchImpl: async () => new Response('not a PDF', {
        status: 200,
        headers: { 'content-type': 'application/pdf' }
      })
    }),
    /not a PDF/
  );
  await assert.rejects(
    fetchPdfBuffer('https://www.gov.cn/gongbao/test.pdf', {
      lookupImpl,
      maxBytes: 8,
      fetchImpl: async () => new Response(Buffer.from('%PDF-1.4 source'), {
        status: 200,
        headers: { 'content-type': 'application/pdf', 'content-length': '15' }
      })
    }),
    /exceeds 8 byte/
  );
});

test('PDF queue caches source bytes, records artifacts and creates private candidates only', async () => {
  const db = openDatabase(':memory:');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-pdf-'));
  try {
    enqueueHistoricalItem(db, {
      url: 'https://www.gov.cn/gongbao/shuju/1954/gwyb195401.pdf',
      sourceName: 'State Council Gazette',
      sourceType: 'pdf',
      itemKind: 'issue',
      sourceYear: 1954,
      title: '1954 issue 1'
    });
    db.prepare("UPDATE historical_backfill_items SET stage = 'manual_review'").run();
    const result = await runHistoricalPdfQueue(db, {
      cacheDir,
      maxItems: 1,
      delayMs: 0
    }, {
      fetchPdf: async (url) => ({
        buffer: Buffer.from('%PDF-1.4 test source'),
        contentType: 'application/pdf',
        finalUrl: url
      }),
      extractEmbeddedText: async () => issueText(),
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.items[0].action, 'pdf_segmented');
    assert.equal(result.items[0].created, 2);
    assert.equal(db.prepare('SELECT stage FROM historical_backfill_items WHERE parent_id IS NULL').get().stage, 'indexed');
    const children = db.prepare('SELECT * FROM historical_backfill_items WHERE parent_id IS NOT NULL ORDER BY id').all();
    assert.equal(children.length, 2);
    assert.ok(children.every((item) => item.stage === 'manual_review' && item.document_id === null));
    assert.ok(children.every((item) => /comparison with official PDF pages/.test(item.last_error)));
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 0);
    assert.deepEqual(
      db.prepare('SELECT artifact_type FROM historical_artifacts ORDER BY artifact_type').all().map((row) => row.artifact_type),
      ['embedded_text', 'segmentation', 'source_pdf']
    );
    const repeated = await runHistoricalPdfQueue(db, { cacheDir, maxItems: 1, delayMs: 0 }, {});
    assert.equal(repeated.selected, 0);
  } finally {
    db.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('incomplete OCR writes a resumable checkpoint without creating candidates', async () => {
  const db = openDatabase(':memory:');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-pdf-'));
  try {
    enqueueHistoricalItem(db, {
      url: 'https://www.gov.cn/gongbao/shuju/1955/gwyb195501.pdf',
      sourceName: 'State Council Gazette',
      sourceType: 'pdf',
      itemKind: 'issue',
      sourceYear: 1955
    });
    db.prepare("UPDATE historical_backfill_items SET stage = 'manual_review'").run();
    const result = await runHistoricalPdfQueue(db, { cacheDir, maxItems: 1, delayMs: 0 }, {
      fetchPdf: async (url) => ({ buffer: Buffer.from('%PDF-1.4 scan'), finalUrl: url }),
      extractEmbeddedText: async () => '',
      ocrPdf: async () => ({ complete: false, pageCount: 40, pagesProcessed: 20, pages: [], text: '' }),
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    });
    assert.equal(result.items[0].action, 'ocr_checkpoint');
    const item = db.prepare('SELECT * FROM historical_backfill_items').get();
    assert.equal(item.stage, 'manual_review');
    assert.match(item.last_error, /OCR checkpoint/);
    assert.ok(item.next_attempt_at);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 0);
  } finally {
    db.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('OCR resumes cached pages and spends its next budget only on missing pages', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-ocr-resume-'));
  const sourceChecksum = 'a'.repeat(64);
  const profile = historicalOcrProfile();
  const pageDir = path.join(cacheDir, 'pages', sourceChecksum, profile.id);
  try {
    fs.mkdirSync(pageDir, { recursive: true });
    fs.writeFileSync(path.join(pageDir, 'page-0001.txt'), 'cached page one');
    const calls = [];
    const commandImpl = async (name, args) => {
      calls.push({ name, args });
      return name === 'tesseract'
        ? { stdout: `new text for ${args[0]}` }
        : { stdout: '' };
    };
    const options = {
      cacheDir,
      pageBudget: 1,
      pageCount: async () => 3,
      commandImpl
    };

    const first = await ocrPdfPages('source.pdf', sourceChecksum, options);
    assert.equal(first.complete, false);
    assert.equal(first.pagesProcessed, 1);
    assert.deepEqual(first.pages.map((page) => page.page), [1, 2]);
    assert.equal(calls.filter((call) => call.name === 'tesseract').length, 1);
    const render = calls.find((call) => call.name === 'pdftoppm');
    assert.equal(render.args[render.args.indexOf('-r') + 1], '300');
    const recognition = calls.find((call) => call.name === 'tesseract');
    assert.equal(recognition.args[recognition.args.indexOf('-l') + 1], 'chi_sim+chi_tra+eng');
    assert.equal(recognition.args[recognition.args.indexOf('--psm') + 1], '3');
    assert.equal(recognition.args[recognition.args.indexOf('--oem') + 1], '1');

    calls.length = 0;
    const resumed = await ocrPdfPages('source.pdf', sourceChecksum, options);
    assert.equal(resumed.complete, true);
    assert.equal(resumed.pagesProcessed, 1);
    assert.deepEqual(resumed.pages.map((page) => page.page), [1, 2, 3]);
    assert.match(resumed.text, /cached page one/);
    assert.equal(calls.filter((call) => call.name === 'tesseract').length, 1);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('OCR profile upgrades do not reuse unversioned page text', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-ocr-profile-'));
  const sourceChecksum = 'c'.repeat(64);
  const legacyDir = path.join(cacheDir, 'pages', sourceChecksum);
  try {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'page-0001.txt'), 'legacy simplified-only OCR');
    const calls = [];
    const result = await ocrPdfPages('source.pdf', sourceChecksum, {
      cacheDir,
      pageBudget: 1,
      pageCount: async () => 1,
      commandImpl: async (name, args) => {
        calls.push({ name, args });
        return name === 'tesseract' ? { stdout: 'new traditional-aware OCR' } : { stdout: '' };
      }
    });

    assert.equal(result.complete, true);
    assert.equal(result.pagesProcessed, 1);
    assert.equal(result.pages[0].text, 'new traditional-aware OCR');
    assert.equal(result.profile.languages, 'chi_sim+chi_tra+eng');
    assert.match(result.profile.id, /^[a-f0-9]{16}$/);
    assert.equal(calls.filter((call) => call.name === 'tesseract').length, 1);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('OCR page concurrency is bounded and preserves page order', async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-ocr-concurrency-'));
  let active = 0;
  let maximumActive = 0;
  try {
    const result = await ocrPdfPages('source.pdf', 'f'.repeat(64), {
      cacheDir,
      pageBudget: 3,
      pageConcurrency: 2,
      pageCount: async () => 3,
      commandImpl: async (name, args) => {
        if (name !== 'tesseract') return { stdout: '' };
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { stdout: `text ${path.basename(args[0])}` };
      }
    });

    assert.equal(result.complete, true);
    assert.equal(result.pagesProcessed, 3);
    assert.equal(maximumActive, 2);
    assert.deepEqual(result.pages.map((page) => page.page), [1, 2, 3]);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('stale OCR artifacts are requeued once until the current profile starts', () => {
  const db = openDatabase(':memory:');
  try {
    enqueueHistoricalItem(db, {
      url: 'https://www.gov.cn/gongbao/shuju/1955/gwyb195502.pdf',
      sourceName: 'State Council Gazette', sourceType: 'pdf', itemKind: 'issue', sourceYear: 1955
    });
    const itemId = Number(db.prepare('SELECT id FROM historical_backfill_items').get().id);
    db.prepare(`
      UPDATE historical_backfill_items SET stage = 'manual_review',
        next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day')
      WHERE id = ?
    `).run(itemId);
    db.prepare(`
      INSERT INTO historical_artifacts (
        item_id, artifact_type, storage_path, checksum, byte_size,
        page_start, page_end, engine, metadata_json
      ) VALUES (?, 'ocr_page', 'pages/legacy/page-0001.txt', ?, 10, 1, 1, 'tesseract', ?)
    `).run(itemId, 'd'.repeat(64), JSON.stringify({ languages: 'chi_sim+eng' }));
    const profile = historicalOcrProfile();

    assert.equal(queueStaleOcrProfiles(db, profile.id), 1);
    const requeued = db.prepare('SELECT next_attempt_at,last_error FROM historical_backfill_items WHERE id = ?').get(itemId);
    assert.equal(requeued.next_attempt_at, null);
    assert.match(requeued.last_error, /profile upgrade/);

    db.prepare(`
      INSERT INTO historical_artifacts (
        item_id, artifact_type, storage_path, checksum, byte_size,
        page_start, page_end, engine, metadata_json
      ) VALUES (?, 'ocr_page', 'pages/current/page-0001.txt', ?, 10, 1, 1, 'tesseract', ?)
    `).run(itemId, 'e'.repeat(64), JSON.stringify({ ocrProfile: profile }));
    db.prepare(`
      UPDATE historical_backfill_items
      SET next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 day')
      WHERE id = ?
    `).run(itemId);
    assert.equal(queueStaleOcrProfiles(db, profile.id), 0);
  } finally {
    db.close();
  }
});

test('PDF failures remain private and use increasing retry delays', async () => {
  const db = openDatabase(':memory:');
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-pdf-retry-'));
  try {
    enqueueHistoricalItem(db, {
      url: 'https://www.gov.cn/gongbao/shuju/1956/gwyb195601.pdf',
      sourceName: 'State Council Gazette',
      sourceType: 'pdf',
      itemKind: 'issue',
      sourceYear: 1956
    });
    db.prepare("UPDATE historical_backfill_items SET stage = 'manual_review'").run();
    let fetchAttempts = 0;
    const dependencies = {
      fetchPdf: async () => {
        fetchAttempts += 1;
        throw new Error('temporary network failure');
      },
      loadSnapshot: () => ({ normalizedLoad: 0, freeMemoryRatio: 0.5 })
    };

    const first = await runHistoricalPdfQueue(db, { cacheDir, maxItems: 1, delayMs: 0 }, dependencies);
    assert.equal(first.status, 'failed');
    const firstRetry = db.prepare('SELECT * FROM historical_backfill_items').get();
    assert.equal(firstRetry.attempts, 1);
    assert.match(firstRetry.last_error, /temporary network failure/);
    assert.match(firstRetry.next_attempt_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(db.prepare(`
      SELECT next_attempt_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS is_future
      FROM historical_backfill_items
    `).get().is_future, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 0);

    const deferred = await runHistoricalPdfQueue(db, { cacheDir, maxItems: 1, delayMs: 0 }, dependencies);
    assert.equal(deferred.status, 'succeeded');
    assert.equal(deferred.selected, 0);
    assert.equal(deferred.processed, 0);
    assert.equal(fetchAttempts, 1);

    db.prepare('UPDATE historical_backfill_items SET next_attempt_at = NULL').run();
    const second = await runHistoricalPdfQueue(db, { cacheDir, maxItems: 1, delayMs: 0 }, dependencies);
    assert.equal(second.status, 'failed');
    const secondRetry = db.prepare('SELECT * FROM historical_backfill_items').get();
    assert.equal(secondRetry.attempts, 2);
    assert.ok(secondRetry.next_attempt_at > firstRetry.next_attempt_at);
    assert.equal(fetchAttempts, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 0);
  } finally {
    db.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});
