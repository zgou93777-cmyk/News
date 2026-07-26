'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { openDatabase } = require('../../server/src/db');
const { enqueueHistoricalItem } = require('../src/historical-backfill');
const { fetchPdfBuffer, runHistoricalPdfQueue, splitPdfIssueText } = require('../src/historical-pdf');

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
    assert.ok(children.every((item) => item.stage === 'needs_review' && item.document_id === null));
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
