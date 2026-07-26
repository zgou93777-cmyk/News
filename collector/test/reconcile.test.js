'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../../server/src/db');
const { runReconcileRelevance, RELEVANCE_AMBIGUITY_TITLE } = require('../src/reconcile');

function insertDocument(db, sourceId, title, modelName = 'rules-based-v1') {
  const documentId = Number(db.prepare(`
    INSERT INTO documents (
      source_id, title, summary, issuer, category, importance, original_url,
      published_at, content_text, checksum
    ) VALUES (?, ?, '', '测试机构', '综合政策', 4, ?, '2026-07-20T00:00:00+08:00', ?, ?)
  `).run(
    sourceId,
    title,
    `https://example.gov.cn/${Buffer.from(title).toString('hex').slice(0, 24)}.htm`,
    title,
    `checksum-${Buffer.from(title).toString('hex').slice(0, 16)}`
  ).lastInsertRowid);
  db.prepare(`
    INSERT INTO analysis_versions (
      document_id, version, headline, interpretation, impact, recommendations,
      methodology, evidence_summary, model_name, prompt_version
    ) VALUES (?, 1, ?, '解释', '影响', '建议', '方法', '证据', ?, 'test-v1')
  `).run(documentId, title, modelName);
  return documentId;
}

test('relevance reconciliation previews then downgrades without deleting history', () => {
  const db = openDatabase(':memory:');
  try {
    const sourceId = Number(db.prepare(`
      INSERT INTO sources (name, authority_level, official_url)
      VALUES ('测试中央来源', 'central', 'https://example.gov.cn/')
    `).run().lastInsertRowid);
    const lowIds = [
      insertDocument(db, sourceId, '中国人民银行关于表彰先进集体和先进个人的通知'),
      insertDocument(db, sourceId, '广西监管局召开内部控制工作会议'),
      insertDocument(db, sourceId, '中泰、中吉举行例行交流会议')
    ];
    const validId = insertDocument(db, sourceId, '中共中央政治局召开会议 分析研究当前经济形势');
    insertDocument(db, sourceId, '机关党委开展主题党日活动', 'editorial-reviewed');
    const versionsBefore = db.prepare('SELECT COUNT(*) AS count FROM analysis_versions').get().count;

    const preview = runReconcileRelevance(db, { apply: false });
    assert.equal(preview.documentsReviewed, 4);
    assert.equal(preview.lowRelevance, 3);
    assert.equal(preview.documentsChanged, 0);
    assert.ok(preview.items.filter((item) => lowIds.includes(item.id)).every((item) => item.action === 'would_downgrade'));
    assert.equal(db.prepare('SELECT status FROM documents WHERE id = ?').get(lowIds[0]).status, 'published');

    const applied = runReconcileRelevance(db, { apply: true });
    assert.equal(applied.documentsChanged, 3);
    assert.equal(applied.analysisVersionsDeleted, 0);
    for (const id of lowIds) {
      const row = db.prepare('SELECT status, importance FROM documents WHERE id = ?').get(id);
      assert.equal(row.status, 'draft');
      assert.equal(row.importance, 1);
    }
    assert.equal(db.prepare('SELECT status FROM documents WHERE id = ?').get(validId).status, 'published');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM analysis_versions').get().count, versionsBefore);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ambiguities WHERE title = ?').get(RELEVANCE_AMBIGUITY_TITLE).count, 3);

    const repeated = runReconcileRelevance(db, { apply: true });
    assert.equal(repeated.documentsChanged, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM ambiguities WHERE title = ?').get(RELEVANCE_AMBIGUITY_TITLE).count, 3);
  } finally {
    db.close();
  }
});
