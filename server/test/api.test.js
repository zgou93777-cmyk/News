'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { openDatabase } = require('../src/db');
const { createHttpServer } = require('../src/http');
const { seedDatabase } = require('../src/seed');

let db;
let server;
let origin;
let adminDirectory;
let lastModelAuthorization = '';

const ADMIN_TOKEN = 'test-admin-token-1234567890-1234567890';

before(async () => {
  db = openDatabase(':memory:');
  seedDatabase(db);
  adminDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-admin-api-'));
  server = createHttpServer({
    db,
    config: {
      frontendDir: path.resolve(__dirname, '..', '..', 'frontend'),
      modelConfigPath: path.join(adminDirectory, 'model-config.json'),
      adminToken: ADMIN_TOKEN,
      maxBodyBytes: 32 * 1024,
      vapidSubject: 'mailto:test@example.com',
      vapidPublicKey: 'test-public-key',
      vapidPrivateKey: 'test-private-key'
    },
    modelEnv: {},
    modelFetchImpl: async (_url, request) => {
      lastModelAuthorization = request.headers.Authorization;
      const body = JSON.parse(request.body);
      if (body.model === 'missing-model') return new Response('', { status: 404 });
      return new Response(JSON.stringify({
        model: body.model,
        choices: [{ message: { content: '{"ok":true}' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(adminDirectory, { recursive: true, force: true });
});

test('health and categories expose database state', async () => {
  const healthResponse = await fetch(`${origin}/api/health`);
  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.headers.get('x-content-type-options'), 'nosniff');
  const health = await healthResponse.json();
  assert.equal(health.status, 'ok');
  assert.equal(health.schemaVersion, '17');
  assert.equal(health.pushEnabled, true);
  assert.deepEqual(health.historical.byStage, {});
  assert.equal(health.historical.frameworkPending, 0);
  assert.equal(health.historical.integrityOk, true);
  assert.equal(health.historical.rollout.mode, 'disabled');

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

test('admin model configuration requires a token and never returns the API key', async () => {
  const unauthorized = await fetch(`${origin}/api/admin/model-config`);
  assert.equal(unauthorized.status, 401);

  const headers = { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' };
  const initial = await fetch(`${origin}/api/admin/model-config`, { headers });
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).data.configured, false);

  const candidate = {
    baseUrl: 'https://relay.example/v1', apiKey: 'relay-secret-key', modelName: 'relay-model'
  };
  const testResponse = await fetch(`${origin}/api/admin/model-config`, {
    method: 'POST', headers, body: JSON.stringify(candidate)
  });
  assert.equal(testResponse.status, 200);
  assert.equal((await testResponse.json()).data.connection.ok, true);
  assert.equal(fs.existsSync(path.join(adminDirectory, 'model-config.json')), false);

  const saveResponse = await fetch(`${origin}/api/admin/model-config`, {
    method: 'PUT', headers, body: JSON.stringify(candidate)
  });
  assert.equal(saveResponse.status, 200);
  const savedText = await saveResponse.text();
  assert.doesNotMatch(savedText, /relay-secret-key/);
  const saved = JSON.parse(savedText).data;
  assert.equal(saved.config.source, 'managed');
  assert.equal(saved.config.hasApiKey, true);
  assert.equal(lastModelAuthorization, 'Bearer relay-secret-key');

  const failedSave = await fetch(`${origin}/api/admin/model-config`, {
    method: 'PUT', headers,
    body: JSON.stringify({ baseUrl: candidate.baseUrl, modelName: 'missing-model', apiKey: '' })
  });
  assert.equal(failedSave.status, 422);
  assert.equal((await failedSave.json()).error.details.connection.category, 'endpoint_or_model_not_found');

  const current = await (await fetch(`${origin}/api/admin/model-config`, { headers })).json();
  assert.equal(current.data.modelName, 'relay-model');
  assert.doesNotMatch(JSON.stringify(current), /relay-secret-key/);
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
  assert.equal(data.currentAnalysis.framework.ready, true);
  assert.match(data.currentAnalysis.framework.perspective, /政策演进/);
  assert.match(data.article.analysisFramework.bottomLine, /不是新增补贴清单/);
  assert.equal(data.analysisHistory.length, 2);
  assert.equal(data.historicalComparison.length, 2);
  assert.equal(data.article.comparisons.length, 3);
  assert.ok(data.signals.some((item) => item.value === '60万亿元左右'));
  assert.ok(data.forecasts.some((item) => item.status === 'monitoring'));
  assert.ok(data.article.predictions.every((item) => item.basis && item.prerequisites));
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
