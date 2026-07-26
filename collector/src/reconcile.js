'use strict';

const { withTransaction } = require('../../server/src/db');
const { assessRelevance } = require('./relevance');

const RELEVANCE_AMBIGUITY_TITLE = '采集相关性复核：低相关降级';

function collectorDocuments(db) {
  return db.prepare(`
    SELECT
      d.id, d.title, d.issuer, d.category, d.status, d.importance,
      d.original_url, d.content_text, d.published_at,
      s.name AS source_name, s.authority_level, s.official_url AS source_official_url,
      av.id AS latest_analysis_id, av.model_name AS latest_model_name,
      (SELECT COUNT(*) FROM analysis_versions history WHERE history.document_id = d.id) AS analysis_version_count
    FROM documents d
    JOIN sources s ON s.id = d.source_id
    LEFT JOIN analysis_versions av ON av.id = (
      SELECT latest.id FROM analysis_versions latest
      WHERE latest.document_id = d.id
      ORDER BY latest.version DESC, latest.id DESC LIMIT 1
    )
    WHERE EXISTS (
      SELECT 1 FROM analysis_versions collector_analysis
      WHERE collector_analysis.document_id = d.id
        AND (
          collector_analysis.model_name LIKE 'rules-based%'
          OR collector_analysis.model_name LIKE 'openai-compatible:%'
        )
    )
    ORDER BY d.published_at DESC, d.id DESC
  `).all();
}

function sourceForRow(row) {
  return {
    name: row.source_name,
    institution: row.issuer,
    url: row.source_official_url,
    tier: row.authority_level === 'central' ? 'P1' : 'P4'
  };
}

function insertAuditAmbiguity(db, row, assessment) {
  const exists = db.prepare(`
    SELECT 1 FROM ambiguities WHERE document_id = ? AND title = ? LIMIT 1
  `).get(row.id, RELEVANCE_AMBIGUITY_TITLE);
  if (exists) return false;
  db.prepare(`
    INSERT INTO ambiguities (
      document_id, analysis_version_id, title, description, severity,
      status, resolution_note, detected_at
    ) VALUES (?, ?, ?, ?, 'medium', 'disputed', ?, ?)
  `).run(
    row.id,
    row.latest_analysis_id || null,
    RELEVANCE_AMBIGUITY_TITLE,
    `该记录未通过当前政策相关性门槛，评分 ${assessment.score}；原因：${assessment.reasons.join(', ')}。历史原文和分析版本保留，仅降低文档发布状态与重要性。`,
    '如后续人工确认属于正式政策、重大会议或重要宏观数据，可在人工复核后恢复文档状态；不得删除既有分析版本。',
    new Date().toISOString()
  );
  return true;
}

function runReconcileRelevance(db, options = {}) {
  const apply = Boolean(options.apply);
  const rows = collectorDocuments(db);
  const reviewed = rows.map((row) => {
    const assessment = assessRelevance({
      title: row.title,
      issuer: row.issuer,
      originalUrl: row.original_url,
      contentText: row.content_text
    }, sourceForRow(row));
    const alreadyDowngraded = row.status === 'draft' && row.importance === 1;
    return {
      id: row.id,
      title: row.title,
      url: row.original_url,
      currentStatus: row.status,
      currentImportance: row.importance,
      analysisVersionCount: row.analysis_version_count,
      latestModelName: row.latest_model_name,
      relevance: assessment,
      action: assessment.accepted ? 'keep'
        : alreadyDowngraded ? 'already_downgraded'
          : apply ? 'downgraded' : 'would_downgrade',
      changed: false
    };
  });

  if (apply) {
    withTransaction(db, () => {
      for (const item of reviewed) {
        if (item.relevance.accepted) continue;
        const row = rows.find((candidate) => candidate.id === item.id);
        const update = db.prepare(`
          UPDATE documents SET status = 'draft', importance = 1
          WHERE id = ? AND (status <> 'draft' OR importance <> 1)
        `).run(item.id);
        const ambiguityInserted = insertAuditAmbiguity(db, row, item.relevance);
        item.changed = update.changes > 0 || ambiguityInserted;
      }
    });
  }

  return {
    dryRun: !apply,
    applied: apply,
    status: 'succeeded',
    documentsReviewed: reviewed.length,
    lowRelevance: reviewed.filter((item) => !item.relevance.accepted).length,
    documentsChanged: reviewed.filter((item) => item.changed).length,
    analysisVersionsDeleted: 0,
    policy: '低相关记录仅降为 draft 且 importance=1，并追加审计歧义；原文、URL、分析版本和预测均不删除。',
    items: reviewed
  };
}

module.exports = {
  RELEVANCE_AMBIGUITY_TITLE,
  collectorDocuments,
  runReconcileRelevance
};
