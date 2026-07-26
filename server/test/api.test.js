'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { openDatabase } = require('../src/db');
const { createHttpServer } = require('../src/http');
const { seedDatabase } = require('../src/seed');

let db;
let server;
let origin;

before(async () => {
  db = openDatabase(':memory:');
  seedDatabase(db);
  server = createHttpServer({
    db,
    config: {
      frontendDir: path.resolve(__dirname, '..', '..', 'frontend'),
      maxBodyBytes: 32 * 1024,
      vapidSubject: 'mailto:test@example.com',
      vapidPublicKey: 'test-public-key',
      vapidPrivateKey: 'test-private-key'
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

test('health and categories expose database state', async () => {
  const healthResponse = await fetch(`${origin}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.headers.get('x-content-type-options'), 'nosniff');
  const health = await healthResponse.json();
  assert.equal(health.status, 'ok');
  assert.equal(health.schemaVersion, '3');
  assert.equal(health.pushEnabled, true);

  const categories = await (await fetch(`${origin}/api/categories`)).json();
  assert.deepEqual(categories.data.map((item) => item.name), ['消费与内需']);
  assert.equal(categories.data[0].count, 3);
});

test('health selects the newest sync run by insertion order across timestamp formats', async () => {
  const insert = db.prepare(`
    INSERT INTO sync_runs (status, started_at) VALUES (?, ?)
  `);
  const olderId = Number(insert.run('succeeded', '2099-01-01T00:00:00+08:00').lastInsertRowid);
  const latestId = Number(insert.run('partial', '2026-07-20T08:00:00.000Z').lastInsertRowid);
  try {
    const health = await (await fetch(`${origin}/api/health`)).json();
    assert.equal(health.latestSync.status, 'partial');
    assert.equal(health.latestSync.startedAt, '2026-07-20T08:00:00.000Z');
  } finally {
    db.prepare('DELETE FROM sync_runs WHERE id IN (?, ?)').run(olderId, latestId);
  }
});

test('article list supports search, filters and pagination', async () => {
  const response = await fetch(`${origin}/api/articles?q=${encodeURIComponent('住房')}&category=${encodeURIComponent('消费与内需')}&status=published&page=1&pageSize=1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.match(body.data[0].title, /扩大消费/);
  assert.match(body.data[0].analysisHeadline, /住房/);
  assert.deepEqual(body.pagination, { page: 1, pageSize: 1, total: 1, totalPages: 1 });

  const invalid = await fetch(`${origin}/api/articles?status=nope`);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_QUERY');
});

test('archive overview and article list support review status and year ranges', async () => {
  const overviewResponse = await fetch(`${origin}/api/archive-overview?fromYear=1949`);
  assert.equal(overviewResponse.status, 200);
  const overview = (await overviewResponse.json()).data;
  assert.equal(overview.total, 3);
  assert.equal(overview.requestedStartYear, 1949);
  assert.equal(overview.earliestYear, 2022);
  assert.equal(Object.values(overview.byStatus).reduce((sum, count) => sum + count, 0), 3);

  const ambiguous = await (await fetch(`${origin}/api/articles?reviewStatus=ambiguous&fromYear=1949&pageSize=50`)).json();
  assert.ok(ambiguous.data.length > 0);
  assert.ok(ambiguous.data.every((article) => article.review.status === 'ambiguous'));

  const historical = await (await fetch(`${origin}/api/articles?fromYear=1949&toYear=2024&pageSize=50`)).json();
  assert.equal(historical.pagination.total, 1);
  assert.equal(historical.data[0].publishedAt.slice(0, 4), '2022');

  for (const query of ['fromYear=1948', 'toYear=20x6', 'fromYear=2026&toYear=2025', 'reviewStatus=nope']) {
    const invalid = await fetch(`${origin}/api/articles?${query}`);
    assert.equal(invalid.status, 400);
  }
});

test('article list hides drafts by default but supports an explicit draft filter', async () => {
  const source = db.prepare('SELECT id FROM sources ORDER BY id LIMIT 1').get();
  const draftId = Number(db.prepare(`
    INSERT INTO documents (
      source_id, title, summary, issuer, category, status, importance,
      original_url, published_at, content_text
    ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)
  `).run(
    source.id,
    '低相关候选政策草稿',
    '等待 reconcile 复核，不应进入默认新闻列表。',
    '测试发布机构',
    '消费与内需',
    1,
    'https://example.test/policies/draft-api-regression',
    '2026-07-20T09:00:00+08:00',
    '草稿原文'
  ).lastInsertRowid);

  try {
    const defaultPayload = await (await fetch(`${origin}/api/articles?pageSize=50`)).json();
    assert.equal(defaultPayload.pagination.total, 3);
    assert.ok(defaultPayload.data.every((article) => article.id !== draftId));

    const draftResponse = await fetch(`${origin}/api/articles?status=draft`);
    assert.equal(draftResponse.status, 200);
    const draftPayload = await draftResponse.json();
    assert.equal(draftPayload.pagination.total, 1);
    assert.equal(draftPayload.data[0].id, draftId);
    assert.equal(draftPayload.data[0].status, 'draft');
  } finally {
    db.prepare('DELETE FROM documents WHERE id = ?').run(draftId);
  }
});

test('article detail includes original evidence, version history, forecasts and review', async () => {
  const list = await (await fetch(`${origin}/api/articles?q=${encodeURIComponent('60万亿元')}`)).json();
  const id = list.data[0].id;
  const response = await fetch(`${origin}/api/articles/${id}`);
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.currentAnalysis.version, 2);
  assert.equal(data.analysisHistory.length, 2);
  assert.equal(data.historicalComparison.length, 2);
  assert.ok(data.signals.some((item) => item.value === '60万亿元左右'));
  assert.ok(data.forecasts.some((item) => item.status === 'monitoring'));
  assert.ok(data.ambiguities.some((item) => /法律或统计分类/.test(item.description)));
  assert.ok(data.assessmentSnapshots.length >= 2);
  assert.match(data.evidence.original.excerpt, /本文有删减/);
  assert.equal(data.article.evidence[0].eventType, 'source_record');
  assert.equal(data.article.evidence[0].status, 'confirmed');
  assert.ok(data.article.evidence
    .filter((item) => item.eventType === 'policy_release')
    .every((item) => item.status === 'confirmed'));
  assert.ok(data.article.evidence.every((item) => item.status !== 'verified'));
});

test('push subscription validates, upserts and deletes an endpoint', async () => {
  const subscription = {
    endpoint: 'https://push.example.test/subscription/abc',
    expirationTime: null,
    keys: {
      p256dh: 'BCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-0123456789',
      auth: 'abcdefghijklmno_1234'
    }
  };
  const first = await fetch(`${origin}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, platform: 'desktop', timezone: 'Asia/Shanghai' })
  });
  assert.equal(first.status, 201);
  const second = await fetch(`${origin}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription)
  });
  assert.equal(second.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions').get().count, 1);

  const removal = await fetch(`${origin}/api/push/subscribe`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: subscription.endpoint })
  });
  assert.equal(removal.status, 200);
  assert.equal((await removal.json()).data.deleted, true);
});

test('request body limits and static SPA fallback are enforced', async () => {
  const tooLarge = await fetch(`${origin}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: 'x'.repeat(33 * 1024) })
  });
  assert.equal(tooLarge.status, 413);

  const page = await fetch(`${origin}/archive/deep-link`, { headers: { Accept: 'text/html' } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /^text\/html/);
});
