'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../../server/src/db');
const { runCollection } = require('../src/pipeline');

const source = {
  id: 'test-source', name: '测试官方来源', institution: '测试部门', tier: 'P0',
  url: 'https://example.gov.cn/policies/', enabled: true
};
const rawContent = `测试部门政策通知
发布日期：2026年7月13日
为扩大消费，测试部门推进相关工作。到2030年，测试指标达到60万亿元左右。`;

function options(overrides = {}) {
  return {
    rawContent,
    contentType: 'text/plain',
    url: 'https://example.gov.cn/policies/content_1.htm',
    source,
    title: '测试部门政策通知',
    issuer: '测试部门',
    analysisMode: 'rules',
    notificationConfig: {},
    ...overrides
  };
}

test('dry-run analyzes without writing sync, document or analysis rows', async () => {
  const db = openDatabase(':memory:');
  try {
    const result = await runCollection(db, options({ dryRun: true }));
    assert.equal(result.status, 'succeeded');
    assert.equal(result.items[0].action, 'would_insert');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_runs').get().count, 0);
  } finally {
    db.close();
  }
});

test('stores once, appends on changed content, and notifies only for changes', async () => {
  const db = openDatabase(':memory:');
  const calls = [];
  const sendNotification = async (_db, _config, notification) => {
    calls.push(notification);
    return { dingtalk: { enabled: false }, webPush: { enabled: false } };
  };
  try {
    const first = await runCollection(db, options(), { sendNotification });
    const duplicate = await runCollection(db, options(), { sendNotification });
    const changed = await runCollection(db, options({ rawContent: `${rawContent}\n新增公开内容。` }), { sendNotification });
    assert.equal(first.items[0].action, 'insert');
    assert.equal(duplicate.items[0].action, 'duplicate');
    assert.equal(changed.items[0].action, 'update');
    assert.equal(calls.length, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM documents').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analysis_versions').get().count, 2);
    assert.equal(db.prepare('SELECT MAX(version) AS version FROM analysis_versions').get().version, 2);
    const family = db.prepare(`
      SELECT pf.slug, pf.title FROM documents d
      JOIN policy_families pf ON pf.id = d.family_id
    `).get();
    assert.equal(family.slug, 'consumption-domestic-demand-policy');
    assert.equal(family.title, '消费与内需政策脉络');
    const event = db.prepare('SELECT event_type, status FROM implementation_events').get();
    assert.deepEqual({ ...event }, { event_type: 'policy_release', status: 'announced' });
    const snapshot = db.prepare('SELECT score, conclusion FROM assessment_snapshots').get();
    assert.equal(snapshot.score, null);
    assert.match(snapshot.conclusion, /发文不等于落地/);
  } finally {
    db.close();
  }
});

test('duplicate rescans idempotently repair missing family, event and assessment', async () => {
  const db = openDatabase(':memory:');
  try {
    const first = await runCollection(db, options({ notify: false }));
    const documentId = first.items[0].documentId;
    db.prepare('DELETE FROM assessment_snapshots').run();
    db.prepare('DELETE FROM implementation_events').run();
    db.prepare('UPDATE documents SET family_id = NULL WHERE id = ?').run(documentId);

    const repaired = await runCollection(db, options({ notify: false }));
    assert.equal(repaired.items[0].action, 'duplicate');
    assert.equal(repaired.items[0].event.inserted, true);
    assert.ok(db.prepare('SELECT family_id FROM documents WHERE id = ?').get(documentId).family_id);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM implementation_events').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assessment_snapshots').get().count, 1);

    const repeated = await runCollection(db, options({ notify: false }));
    assert.equal(repeated.items[0].event.inserted, false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM implementation_events').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assessment_snapshots').get().count, 1);
  } finally {
    db.close();
  }
});

test('same-day family documents aggregate implementation and funding in one snapshot', async () => {
  const db = openDatabase(':memory:');
  try {
    await runCollection(db, options({
      notify: false,
      category: '消费与内需',
      title: '消费补贴申报实施细则',
      url: 'https://example.gov.cn/policies/implementation.htm',
      rawContent: '测试部门\n发布日期：2026年7月13日\n消费补贴申报实施细则自发布之日起正式实施。'
    }));
    await runCollection(db, options({
      notify: false,
      category: '消费与内需',
      title: '消费补贴资金公告',
      url: 'https://example.gov.cn/policies/funding.htm',
      rawContent: '测试部门\n发布日期：2026年7月13日\n中央财政已下达消费补贴资金100亿元。'
    }));
    const events = db.prepare('SELECT event_type, status FROM implementation_events ORDER BY id')
      .all().map((row) => ({ ...row }));
    assert.deepEqual(events, [
      { event_type: 'implementation', status: 'observed' },
      { event_type: 'funding', status: 'observed' }
    ]);
    const snapshots = db.prepare('SELECT score, evidence_json FROM assessment_snapshots').all();
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].score, 65);
    assert.equal(JSON.parse(snapshots[0].evidence_json).filter((item) => item.included).length, 2);
  } finally {
    db.close();
  }
});

test('an explicit policy family takes priority over automatic category lineage', async () => {
  const db = openDatabase(':memory:');
  try {
    await runCollection(db, options({
      notify: false,
      familySlug: 'manual-family',
      familyTitle: '人工指定脉络'
    }));
    const family = db.prepare(`
      SELECT pf.slug, pf.title FROM documents d
      JOIN policy_families pf ON pf.id = d.family_id
    `).get();
    assert.deepEqual({ ...family }, { slug: 'manual-family', title: '人工指定脉络' });
  } finally {
    db.close();
  }
});

test('hydrates seed placeholder content without superseding editorial analysis', async () => {
  const db = openDatabase(':memory:');
  const notifications = [];
  try {
    db.prepare(`INSERT INTO sources (name, official_url) VALUES (?, ?)`).run(source.name, source.url);
    const sourceId = db.prepare('SELECT id FROM sources').get().id;
    const documentId = Number(db.prepare(`
      INSERT INTO documents (
        source_id, title, summary, issuer, category, importance, original_url,
        published_at, content_text, checksum
      ) VALUES (?, ?, '', ?, '综合政策', 5, ?, ?, '种子摘要', 'seed-placeholder')
    `).run(sourceId, '测试部门政策通知', '测试部门', 'https://example.gov.cn/policies/content_1.htm', '2026-07-13T00:00:00+08:00').lastInsertRowid);
    db.prepare(`
      INSERT INTO analysis_versions (
        document_id, version, headline, interpretation, impact, recommendations,
        methodology, evidence_summary, model_name, prompt_version
      ) VALUES (?, 1, '审校标题', '审校解释', '审校影响', '审校建议', '人工复核', '已核验', 'editorial-reviewed', 'seed-v1')
    `).run(documentId);

    const result = await runCollection(db, options(), {
      sendNotification: async (...args) => notifications.push(args)
    });
    assert.equal(result.items[0].action, 'hydrate');
    assert.equal(result.documentsHydrated, 1);
    assert.equal(notifications.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analysis_versions').get().count, 1);
    assert.equal(db.prepare('SELECT model_name FROM analysis_versions').get().model_name, 'editorial-reviewed');
    assert.match(db.prepare('SELECT content_text FROM documents').get().content_text, /60万亿元/);
  } finally {
    db.close();
  }
});

test('all-source scanning checks every configured index before filling the global item limit', async () => {
  const db = openDatabase(':memory:');
  const indexUrls = new Set();
  const fetchText = async (url) => {
    if (/content_test_/.test(url)) {
      return {
        body: '政策通知\n发布日期：2026年7月13日\n有关部门推进政策实施并公开后续数据。',
        contentType: 'text/plain',
        finalUrl: url
      };
    }
    indexUrls.add(url);
    const marker = Buffer.from(new URL(url).pathname).toString('hex').slice(0, 16) || 'root';
    return {
      body: `<a href="content_test_${marker}.htm">关于推进测试政策工作的通知</a>`,
      contentType: 'text/html',
      finalUrl: url
    };
  };
  try {
    const result = await runCollection(db, {
      allSources: true,
      maxItems: 3,
      dryRun: true,
      notify: false,
      analysisMode: 'rules'
    }, { fetchText });
    assert.equal(result.sourcesChecked, 9);
    assert.equal(indexUrls.size, 9);
    assert.equal(result.items.length, 3);
  } finally {
    db.close();
  }
});

test('a duplicate can fill an empty source cover without overwriting editorial covers or drafts', async () => {
  const db = openDatabase(':memory:');
  const policyTitle = '\u56fd\u52a1\u9662\u5173\u4e8e\u6269\u5927\u5185\u9700\u4fc3\u8fdb\u6d88\u8d39\u7684\u901a\u77e5';
  const policyText = `${policyTitle}\n\u672c\u653f\u7b56\u90e8\u7f72\u5b9e\u65bd\u7ec6\u5219\uff0c\u8d22\u653f\u653f\u7b56\u652f\u6301\u793e\u4f1a\u6d88\u8d39\u54c1\u96f6\u552e\u3002`;
  const html = `<html><body><div id="UCAP-CONTENT">${policyText}<img src="/cover.png"></div></body></html>`;
  const coverOptions = {
    rawContent: html,
    contentType: 'text/html',
    title: policyTitle,
    issuer: '\u56fd\u52a1\u9662',
    publishedAt: '2026-07-20',
    notify: false
  };
  try {
    const first = await runCollection(db, options(coverOptions), {
      findAndCacheSourceImage: async () => ({ coverImage: '', candidatesFound: 1, errors: [] })
    });
    assert.equal(first.items[0].action, 'insert');
    const documentId = first.items[0].documentId;
    assert.equal(db.prepare('SELECT cover_image FROM documents WHERE id = ?').get(documentId).cover_image, '');

    let duplicateCacheCalls = 0;
    let duplicateNotifications = 0;
    const duplicate = await runCollection(db, options({ ...coverOptions, notify: true }), {
      findAndCacheSourceImage: async () => {
        duplicateCacheCalls += 1;
        return { coverImage: 'assets/covers/source-duplicate.png' };
      },
      sendNotification: async () => {
        duplicateNotifications += 1;
        return {};
      }
    });
    assert.equal(duplicate.items[0].action, 'duplicate');
    assert.equal(duplicateCacheCalls, 1);
    assert.equal(duplicateNotifications, 0);
    assert.equal(duplicate.items[0].coverImageUpdated, true);
    assert.equal(db.prepare('SELECT cover_image FROM documents WHERE id = ?').get(documentId).cover_image,
      'assets/covers/source-duplicate.png');

    db.prepare('UPDATE documents SET cover_image = ? WHERE id = ?').run('assets/covers/editorial.png', documentId);
    let overwriteCalls = 0;
    await runCollection(db, options(coverOptions), {
      findAndCacheSourceImage: async () => {
        overwriteCalls += 1;
        return { coverImage: 'assets/covers/should-not-overwrite.png' };
      }
    });
    assert.equal(overwriteCalls, 0);
    assert.equal(db.prepare('SELECT cover_image FROM documents WHERE id = ?').get(documentId).cover_image,
      'assets/covers/editorial.png');

    db.prepare("UPDATE documents SET status = 'draft', cover_image = '' WHERE id = ?").run(documentId);
    let draftCalls = 0;
    const draftScan = await runCollection(db, options(coverOptions), {
      findAndCacheSourceImage: async () => {
        draftCalls += 1;
        return { coverImage: 'assets/covers/should-not-fill-draft.png' };
      }
    });
    assert.equal(draftScan.items[0].action, 'duplicate');
    assert.equal(draftCalls, 0);
    assert.equal(db.prepare('SELECT cover_image FROM documents WHERE id = ?').get(documentId).cover_image, '');
  } finally {
    db.close();
  }
});
