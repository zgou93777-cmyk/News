'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { openDatabase } = require('../src/db');
const { getArticleDetail, listArticles } = require('../src/repository');
const { seedDatabase } = require('../src/seed');

function filters(overrides = {}) {
  return { q: '', category: '', status: '', page: 1, pageSize: 50, ...overrides };
}

test('repository excludes drafts unless draft status is explicitly requested', () => {
  const db = openDatabase(':memory:');
  try {
    seedDatabase(db);
    const source = db.prepare('SELECT id FROM sources ORDER BY id LIMIT 1').get();
    const draftId = Number(db.prepare(`
      INSERT INTO documents (
        source_id, title, summary, issuer, category, status, importance,
        original_url, published_at, content_text
      ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
    `).run(
      source.id,
      '仓储层低相关草稿',
      '只供 reconcile 使用。',
      '测试发布机构',
      '消费与内需',
      1,
      'https://example.test/policies/draft-repository-regression',
      '2026-07-20T09:10:00+08:00',
      '草稿原文'
    ).lastInsertRowid);

    const defaultResult = listArticles(db, filters());
    assert.equal(defaultResult.total, 3);
    assert.ok(defaultResult.articles.every((article) => article.id !== draftId));

    const draftResult = listArticles(db, filters({ status: 'draft' }));
    assert.equal(draftResult.total, 1);
    assert.equal(draftResult.articles[0].id, draftId);
    assert.equal(draftResult.articles[0].status, 'draft');
  } finally {
    db.close();
  }
});

test('historical comparison only includes documents published before the current document', () => {
  const db = openDatabase(':memory:');
  try {
    seedDatabase(db);
    const earliest = db.prepare('SELECT id FROM documents ORDER BY published_at, id LIMIT 1').get();
    const detail = getArticleDetail(db, earliest.id);
    assert.equal(detail.historicalComparison.length, 0);

    const latest = db.prepare('SELECT id FROM documents ORDER BY published_at DESC, id DESC LIMIT 1').get();
    const latestDetail = getArticleDetail(db, latest.id);
    assert.equal(latestDetail.historicalComparison.length, 2);
    assert.ok(latestDetail.historicalComparison.every(
      (item) => item.publishedAt < latestDetail.article.publishedAt
    ));
    assert.ok(latestDetail.article.comparisons.every(
      (item) => item.implication.includes('不据此作因果比较')
    ));
  } finally {
    db.close();
  }
});

test('repository labels source and confirmed policy releases as confirmed evidence, not verified effects', () => {
  const db = openDatabase(':memory:');
  try {
    seedDatabase(db);
    const latest = db.prepare('SELECT id FROM documents ORDER BY published_at DESC, id DESC LIMIT 1').get();
    const detail = getArticleDetail(db, latest.id);
    assert.equal(detail.article.evidence[0].eventType, 'source_record');
    assert.equal(detail.article.evidence[0].status, 'confirmed');
    const releases = detail.article.evidence.filter((item) => item.eventType === 'policy_release');
    assert.ok(releases.length > 0);
    assert.ok(releases.every((item) => item.status === 'confirmed'));
    assert.ok(detail.article.evidence.every((item) => item.status !== 'verified'));
  } finally {
    db.close();
  }
});
