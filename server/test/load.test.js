'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { openDatabase } = require('../src/db');
const { getArchiveOverview, listArticles } = require('../src/repository');

test('archive and four-status queries stay bounded across 2500 public policies', () => {
  const db = openDatabase(':memory:');
  try {
    const sourceId = Number(db.prepare(`
      INSERT INTO sources (name, official_url) VALUES ('Load test', 'https://load-test.gov.cn/')
    `).run().lastInsertRowid);
    const insert = db.prepare(`
      INSERT INTO documents (
        source_id, title, issuer, category, status, original_url,
        published_at, content_text, checksum
      ) VALUES (?, ?, '国务院', ?, 'published', ?, ?, ?, ?)
    `);
    db.exec('BEGIN IMMEDIATE');
    for (let index = 0; index < 2500; index += 1) {
      const year = 1949 + (index % 78);
      insert.run(
        sourceId,
        `历史政策负载测试 ${index}`,
        index % 2 ? '消费与内需' : '财政与税收',
        `https://load-test.gov.cn/policy/${index}.htm`,
        `${year}-01-01T00:00:00+08:00`,
        `历史政策公开原文 ${index}`,
        `load-${index}`
      );
    }
    db.exec('COMMIT');
    const started = performance.now();
    const page = listArticles(db, {
      page: 1,
      pageSize: 50,
      reviewStatus: 'watching',
      fromYear: 1949,
      toYear: 2026
    });
    const overview = getArchiveOverview(db, { fromYear: 1949, toYear: 2026 });
    const elapsed = performance.now() - started;
    assert.equal(page.total, 2500);
    assert.equal(page.articles.length, 50);
    assert.equal(overview.total, 2500);
    assert.equal(overview.byStatus.watching, 2500);
    assert.equal(overview.earliestYear, 1949);
    assert.equal(overview.latestYear, 2026);
    assert.ok(elapsed < 5000, `archive queries took ${elapsed.toFixed(1)}ms`);
  } finally {
    db.close();
  }
});
