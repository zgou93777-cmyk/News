'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../../server/src/db');
const { runCoverBackfill } = require('../src/cover-backfill');

const source = {
  id: 'test-source',
  name: 'Test source',
  institution: 'Test issuer',
  tier: 'P0',
  url: 'https://example.gov.cn/policies/',
  imageHosts: []
};
const pageHtml = `
  <html><head><meta property="og:image" content="/media/cover.png"></head>
  <body><div id="content">Official policy text</div></body></html>`;

function insertDocument(db, sourceId, values = {}) {
  return Number(db.prepare(`
    INSERT INTO documents (
      source_id, title, summary, issuer, category, status, importance,
      original_url, cover_image, published_at, content_text, checksum
    ) VALUES (?, ?, '', 'Test issuer', 'Policy', ?, 3, ?, ?, ?, 'Official policy text', ?)
  `).run(
    sourceId,
    values.title || 'Policy article',
    values.status || 'published',
    values.url || 'https://example.gov.cn/policies/a.html',
    values.coverImage || '',
    values.publishedAt || '2026-07-20T00:00:00+08:00',
    values.checksum || 'cover-backfill-a'
  ).lastInsertRowid);
}

function fixture() {
  const db = openDatabase(':memory:');
  const sourceId = Number(db.prepare('INSERT INTO sources (name, official_url) VALUES (?, ?)')
    .run(source.name, source.url).lastInsertRowid);
  return { db, sourceId };
}

test('cover backfill defaults to dry-run and performs no image or database writes', async () => {
  const { db, sourceId } = fixture();
  const documentId = insertDocument(db, sourceId);
  let cacheCalls = 0;
  try {
    const result = await runCoverBackfill(db, {}, {
      sources: [source],
      fetchText: async (url) => ({ body: pageHtml, contentType: 'text/html', finalUrl: url }),
      findAndCacheSourceImage: async () => {
        cacheCalls += 1;
        return { coverImage: 'assets/covers/should-not-exist.png' };
      }
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.items[0].action, 'would_cache');
    assert.equal(cacheCalls, 0);
    assert.equal(db.prepare('SELECT cover_image FROM documents WHERE id = ?').get(documentId).cover_image, '');
  } finally {
    db.close();
  }
});

test('cover backfill apply updates only public empty covers and never sends notifications', async () => {
  const { db, sourceId } = fixture();
  const emptyId = insertDocument(db, sourceId);
  const existingId = insertDocument(db, sourceId, {
    title: 'Existing cover',
    url: 'https://example.gov.cn/policies/existing.html',
    coverImage: 'assets/covers/editorial.png',
    checksum: 'cover-backfill-existing'
  });
  const draftId = insertDocument(db, sourceId, {
    title: 'Draft',
    url: 'https://example.gov.cn/policies/draft.html',
    status: 'draft',
    checksum: 'cover-backfill-draft'
  });
  let cacheCalls = 0;
  try {
    const result = await runCoverBackfill(db, { apply: true }, {
      sources: [source],
      fetchText: async (url) => ({ body: pageHtml, contentType: 'text/html', finalUrl: url }),
      findAndCacheSourceImage: async () => {
        cacheCalls += 1;
        return {
          coverImage: 'assets/covers/source-test.png',
          sourceUrl: 'https://example.gov.cn/media/cover.png'
        };
      }
    });
    assert.equal(result.dryRun, false);
    assert.equal(result.documentsChecked, 1);
    assert.equal(result.coversAdded, 1);
    assert.equal(cacheCalls, 1);
    assert.equal(db.prepare('SELECT cover_image FROM documents WHERE id = ?').get(emptyId).cover_image,
      'assets/covers/source-test.png');
    assert.equal(db.prepare('SELECT cover_image FROM documents WHERE id = ?').get(existingId).cover_image,
      'assets/covers/editorial.png');
    assert.equal(db.prepare('SELECT cover_image FROM documents WHERE id = ?').get(draftId).cover_image, '');
  } finally {
    db.close();
  }
});

test('one failed source page does not block later cover backfill rows', async () => {
  const { db, sourceId } = fixture();
  insertDocument(db, sourceId, { url: 'https://example.gov.cn/policies/fail.html' });
  const goodId = insertDocument(db, sourceId, {
    title: 'Good policy',
    url: 'https://example.gov.cn/policies/good.html',
    publishedAt: '2026-07-19T00:00:00+08:00',
    checksum: 'cover-backfill-good'
  });
  try {
    const result = await runCoverBackfill(db, { apply: true }, {
      sources: [source],
      fetchText: async (url) => {
        if (url.includes('/fail.html')) throw new Error('page unavailable');
        return { body: pageHtml, contentType: 'text/html', finalUrl: url };
      },
      findAndCacheSourceImage: async () => ({
        coverImage: 'assets/covers/source-good.png',
        sourceUrl: 'https://example.gov.cn/media/cover.png'
      })
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.coversAdded, 1);
    assert.equal(result.warnings.length, 1);
    assert.equal(db.prepare('SELECT cover_image FROM documents WHERE id = ?').get(goodId).cover_image,
      'assets/covers/source-good.png');
  } finally {
    db.close();
  }
});
