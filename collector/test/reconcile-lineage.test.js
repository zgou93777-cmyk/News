'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { openDatabase } = require('../../server/src/db');
const { runReconcileLineage } = require('../src/reconcile-lineage');

function insertLegacyDocument(db) {
  const sourceId = Number(db.prepare(`
    INSERT INTO sources (name, official_url) VALUES (?, ?)
  `).run('测试部门-政策公开', 'https://example.gov.cn/').lastInsertRowid);
  const documentId = Number(db.prepare(`
    INSERT INTO documents (
      source_id, title, summary, issuer, category, status, importance,
      original_url, published_at, content_text, original_excerpt, checksum
    ) VALUES (?, ?, ?, ?, ?, 'published', 3, ?, ?, ?, ?, ?)
  `).run(
    sourceId,
    '关于扩大消费工作的通知',
    '扩大消费政策摘要。',
    '2026-07-20',
    '综合政策',
    'https://example.gov.cn/policy/legacy.htm',
    '2026-07-20T08:00:00+08:00',
    '测试部门发布关于扩大消费工作的通知，后续将制定配套安排。',
    '关于扩大消费工作的通知。',
    'legacy-checksum'
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO analysis_versions (
      document_id, version, headline, interpretation, impact, recommendations,
      methodology, evidence_summary, model_name, prompt_version
    ) VALUES (?, 1, '旧分析', '旧解释', '旧影响', '旧建议', '人工', '旧证据', 'editorial', 'v1')
  `).run(documentId);
  return documentId;
}

test('lineage reconcile previews safely, applies once and remains idempotent', () => {
  const db = openDatabase(':memory:');
  try {
    const documentId = insertLegacyDocument(db);
    const preview = runReconcileLineage(db, { apply: false });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.items[0].familyAction, 'would_attach');
    assert.equal(preview.items[0].metadataAction, 'would_correct');
    assert.equal(db.prepare('SELECT family_id FROM documents WHERE id = ?').get(documentId).family_id, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM implementation_events').get().count, 0);

    const applied = runReconcileLineage(db, { apply: true });
    assert.equal(applied.familiesAttached, 1);
    assert.equal(applied.eventsAdded, 1);
    assert.equal(applied.metadataCorrected, 1);
    const corrected = db.prepare(`
      SELECT d.issuer, d.category, pf.slug, pf.title
      FROM documents d JOIN policy_families pf ON pf.id = d.family_id
      WHERE d.id = ?
    `).get(documentId);
    assert.deepEqual({ ...corrected }, {
      issuer: '测试部门',
      category: '消费与内需',
      slug: 'consumption-domestic-demand-policy',
      title: '消费与内需政策脉络'
    });
    assert.deepEqual(
      { ...db.prepare('SELECT event_type, status FROM implementation_events').get() },
      { event_type: 'policy_release', status: 'announced' }
    );
    assert.equal(db.prepare('SELECT score FROM assessment_snapshots').get().score, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analysis_versions').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ambiguities').get().count, 1);

    const repeated = runReconcileLineage(db, { apply: true });
    assert.equal(repeated.familiesAttached, 0);
    assert.equal(repeated.eventsAdded, 0);
    assert.equal(repeated.metadataCorrected, 0);
    assert.equal(repeated.auditsAdded, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM implementation_events').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assessment_snapshots').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analysis_versions').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ambiguities').get().count, 1);
  } finally {
    db.close();
  }
});

test('lineage reconcile moves only automatic families and reclassifies derived evidence', () => {
  const db = openDatabase(':memory:');
  try {
    const sourceId = Number(db.prepare(`
      INSERT INTO sources (name, official_url) VALUES ('国家统计局-最新发布', 'https://www.stats.gov.cn/sj/zxfb/')
    `).run().lastInsertRowid);
    const oldFamilyId = Number(db.prepare(`
      INSERT INTO policy_families (slug, title, category)
      VALUES ('technology-industry-policy', '科技与产业政策脉络', '科技与产业')
    `).run().lastInsertRowid);
    const documentId = Number(db.prepare(`
      INSERT INTO documents (
        source_id, family_id, title, issuer, category, original_url,
        published_at, content_text, checksum
      ) VALUES (?, ?, ?, '国家统计局', '科技与产业', ?, ?, ?, 'stats-checksum')
    `).run(
      sourceId,
      oldFamilyId,
      '2026年1-6月份全国固定资产投资基本情况',
      'https://www.stats.gov.cn/sj/zxfb/example.html',
      '2026-07-15T00:00:00+08:00',
      '全国固定资产投资同比增长。'
    ).lastInsertRowid);
    db.prepare(`
      INSERT INTO analysis_versions (
        document_id, version, headline, interpretation, impact, recommendations
      ) VALUES (?, 1, '旧分析', '旧解释', '旧影响', '旧建议')
    `).run(documentId);
    db.prepare(`
      INSERT INTO implementation_events (
        family_id, document_id, title, event_type, description,
        source_url, occurred_at, status
      ) VALUES (?, ?, '统计材料发布', 'policy_release', '旧分类', ?, ?, 'announced')
    `).run(
      oldFamilyId,
      documentId,
      'https://www.stats.gov.cn/sj/zxfb/example.html',
      '2026-07-15T00:00:00+08:00'
    );

    const preview = runReconcileLineage(db, { apply: false });
    assert.equal(preview.items[0].familyAction, 'would_move');
    assert.equal(preview.items[0].eventAction, 'would_reclassify');

    const applied = runReconcileLineage(db, { apply: true });
    assert.equal(applied.familiesMoved, 1);
    assert.equal(applied.eventsReclassified, 1);
    assert.equal(applied.auditsAdded, 2);
    const result = db.prepare(`
      SELECT d.category, pf.slug, ie.event_type, ie.status,
             ie.family_id = d.family_id AS family_matches
      FROM documents d
      JOIN policy_families pf ON pf.id = d.family_id
      JOIN implementation_events ie ON ie.document_id = d.id
      WHERE d.id = ?
    `).get(documentId);
    assert.deepEqual({ ...result }, {
      category: '宏观数据',
      slug: 'macro-data-policy',
      event_type: 'result_data',
      status: 'observed',
      family_matches: 1
    });
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analysis_versions').get().count, 1);

    const repeated = runReconcileLineage(db, { apply: true });
    assert.equal(repeated.familiesMoved, 0);
    assert.equal(repeated.eventsReclassified, 0);
    assert.equal(repeated.auditsAdded, 0);
  } finally {
    db.close();
  }
});
