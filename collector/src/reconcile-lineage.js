'use strict';

const { withTransaction } = require('../../server/src/db');
const { classifyCategory } = require('./analysis');
const {
  CATEGORY_FAMILY_SLUGS,
  classifyImplementationEvent,
  familyForCategory,
  issuerLooksLikeDate
} = require('./lineage');
const { loadSources } = require('./sources');
const {
  ensureDocumentLineage,
  resolveFamily,
  upsertAssessmentSnapshot
} = require('./store');

const METADATA_AUDIT_TITLE = '数据质量回填：发布机构或主题分类修正';
const EVENT_AUDIT_TITLE = '数据质量回填：证据阶段修正';
const AUTO_FAMILY_SLUGS = new Set(Object.values(CATEGORY_FAMILY_SLUGS));

function candidateDocuments(db) {
  return db.prepare(`
    SELECT
      d.id, d.family_id, d.title, d.issuer, d.category, d.status,
      d.original_url, d.published_at, d.content_text, d.original_excerpt,
      s.name AS source_name,
      s.official_url AS source_official_url,
      pf.slug AS family_slug, pf.title AS family_title,
      (SELECT av.id FROM analysis_versions av WHERE av.document_id = d.id
       ORDER BY av.version DESC, av.id DESC LIMIT 1) AS latest_analysis_id,
      (SELECT ie.id FROM implementation_events ie WHERE ie.document_id = d.id ORDER BY ie.id LIMIT 1) AS event_id,
      (SELECT ie.event_type FROM implementation_events ie WHERE ie.document_id = d.id ORDER BY ie.id LIMIT 1) AS event_type,
      (SELECT ie.status FROM implementation_events ie WHERE ie.document_id = d.id ORDER BY ie.id LIMIT 1) AS event_status,
      (SELECT ie.occurred_at FROM implementation_events ie WHERE ie.document_id = d.id ORDER BY ie.id LIMIT 1) AS event_occurred_at
    FROM documents d
    JOIN sources s ON s.id = d.source_id
    LEFT JOIN policy_families pf ON pf.id = d.family_id
    WHERE d.status IN ('published', 'effective')
    ORDER BY d.published_at, d.id
  `).all();
}

function fallbackIssuer(row, institutionsByUrl) {
  const configured = institutionsByUrl.get(row.source_official_url);
  if (configured) return configured;
  return String(row.source_name || '').split(/[-—]/, 1)[0].trim() || row.source_name;
}

function correctionFor(row, institutionsByUrl = new Map()) {
  const category = classifyCategory({ title: row.title, contentText: row.content_text });
  const issuer = issuerLooksLikeDate(row.issuer) ? fallbackIssuer(row, institutionsByUrl) : row.issuer;
  return {
    category,
    issuer,
    categoryChanged: category !== row.category,
    issuerChanged: issuer !== row.issuer
  };
}

function insertMetadataAudit(db, row, correction, now) {
  if (!correction.categoryChanged && !correction.issuerChanged) return false;
  const auditTitle = `${METADATA_AUDIT_TITLE}：${[
    correction.issuerChanged ? `${row.issuer}->${correction.issuer}` : '',
    correction.categoryChanged ? `${row.category}->${correction.category}` : ''
  ].filter(Boolean).join('；')}`;
  const exists = db.prepare(`
    SELECT 1 FROM ambiguities WHERE document_id = ? AND title = ? LIMIT 1
  `).get(row.id, auditTitle);
  if (exists) return false;
  const changes = [
    correction.issuerChanged ? `发布机构由“${row.issuer}”回退为来源“${correction.issuer}”` : '',
    correction.categoryChanged ? `主题分类由“${row.category}”重算为“${correction.category}”` : ''
  ].filter(Boolean).join('；');
  db.prepare(`
    INSERT INTO ambiguities (
      document_id, analysis_version_id, title, description, severity,
      status, resolution_note, detected_at, resolved_at
    ) VALUES (?, ?, ?, ?, 'low', 'clarified', ?, ?, ?)
  `).run(
    row.id,
    row.latest_analysis_id || null,
    auditTitle,
    `${changes}。该修正只更新文档元数据，不覆盖或删除既有分析版本。`,
    '使用当前标题加权主题规则重算；日期样式发布机构回退为已登记来源。',
    now,
    now
  );
  return true;
}

function insertEventAudit(db, row, event, now) {
  if (!row.event_id || (row.event_type === event.eventType && row.event_status === event.status)) return false;
  const auditTitle = `${EVENT_AUDIT_TITLE}：${row.event_type}/${row.event_status}->${event.eventType}/${event.status}`;
  const exists = db.prepare(`
    SELECT 1 FROM ambiguities WHERE document_id = ? AND title = ? LIMIT 1
  `).get(row.id, auditTitle);
  if (exists) return false;
  db.prepare(`
    INSERT INTO ambiguities (
      document_id, analysis_version_id, title, description, severity,
      status, resolution_note, detected_at, resolved_at
    ) VALUES (?, ?, ?, ?, 'low', 'clarified', ?, ?, ?)
  `).run(
    row.id,
    row.latest_analysis_id || null,
    auditTitle,
    `证据节点由“${row.event_type}/${row.event_status}”重算为“${event.eventType}/${event.status}”。原文和历史分析版本保持不变。`,
    '使用当前保守证据阶段规则重算；会议和正式发文不计为执行兑现。',
    now,
    now
  );
  return true;
}

function runReconcileLineage(db, options = {}) {
  const apply = Boolean(options.apply);
  const rows = candidateDocuments(db);
  const institutionsByUrl = new Map(loadSources(options.sourcesFile)
    .filter((source) => source.institution)
    .map((source) => [source.url, source.institution]));
  const items = rows.map((row) => {
    const correction = correctionFor(row, institutionsByUrl);
    const family = familyForCategory(correction.category);
    const event = classifyImplementationEvent({
      title: row.title,
      contentText: row.content_text,
      originalExcerpt: row.original_excerpt,
      originalUrl: row.original_url,
      publishedAt: row.published_at
    });
    const familyNeedsMove = Boolean(
      row.family_id
      && AUTO_FAMILY_SLUGS.has(row.family_slug)
      && row.family_slug !== family.slug
    );
    const eventNeedsReclassification = Boolean(
      row.event_id
      && (row.event_type !== event.eventType || row.event_status !== event.status)
    );
    return {
      id: row.id,
      title: row.title,
      familyAction: !row.family_id ? apply ? 'attached' : 'would_attach'
        : familyNeedsMove ? apply ? 'moved' : 'would_move'
          : 'keep',
      family: row.family_id && !familyNeedsMove
        ? { id: row.family_id, slug: row.family_slug, title: row.family_title }
        : { slug: family.slug, title: family.title },
      currentIssuer: row.issuer,
      nextIssuer: correction.issuer,
      currentCategory: row.category,
      nextCategory: correction.category,
      metadataAction: correction.categoryChanged || correction.issuerChanged
        ? apply ? 'corrected' : 'would_correct'
        : 'keep',
      eventAction: !row.event_id ? apply ? 'inserted' : 'would_insert'
        : eventNeedsReclassification ? apply ? 'reclassified' : 'would_reclassify'
          : 'keep',
      eventType: event.eventType,
      eventStatus: event.status,
      familyAttached: false,
      familyMoved: false,
      eventInserted: false,
      eventReclassified: false,
      auditInserted: false,
      eventAuditInserted: false,
      snapshotRefreshed: false,
      correction,
      autoFamily: family,
      familyNeedsMove,
      eventNeedsReclassification,
      row
    };
  });

  if (apply) {
    withTransaction(db, () => {
      const now = new Date().toISOString();
      for (const item of items) {
        const { row, correction, autoFamily } = item;
        const oldFamilyId = row.family_id;
        let familyId = row.family_id;
        if (familyId && AUTO_FAMILY_SLUGS.has(row.family_slug) && !item.familyNeedsMove) {
          resolveFamily(db, autoFamily);
        }
        if (!familyId || item.familyNeedsMove) {
          familyId = resolveFamily(db, autoFamily);
          db.prepare('UPDATE documents SET family_id = ? WHERE id = ?').run(familyId, row.id);
          item.familyAttached = !oldFamilyId;
          item.familyMoved = Boolean(oldFamilyId);
          item.family = { id: familyId, slug: autoFamily.slug, title: autoFamily.title };
        }
        if (correction.categoryChanged || correction.issuerChanged) {
          db.prepare('UPDATE documents SET issuer = ?, category = ? WHERE id = ?')
            .run(correction.issuer, correction.category, row.id);
          item.auditInserted = insertMetadataAudit(db, row, correction, now);
        }
        if (row.event_id && (item.eventNeedsReclassification || item.familyMoved)) {
          db.prepare(`
            UPDATE implementation_events SET
              family_id = ?, event_type = ?, status = ?, description = ?, evidence_quote = ?
            WHERE id = ?
          `).run(
            familyId,
            item.eventType,
            item.eventStatus,
            classifyImplementationEvent({
              title: row.title,
              contentText: row.content_text,
              originalExcerpt: row.original_excerpt,
              originalUrl: row.original_url,
              publishedAt: row.published_at
            }).description,
            classifyImplementationEvent({
              title: row.title,
              contentText: row.content_text,
              originalExcerpt: row.original_excerpt,
              originalUrl: row.original_url,
              publishedAt: row.published_at
            }).evidenceQuote,
            row.event_id
          );
          item.eventReclassified = item.eventNeedsReclassification;
          item.eventAuditInserted = insertEventAudit(db, row, {
            eventType: item.eventType,
            status: item.eventStatus
          }, now);
        }
        const lineage = ensureDocumentLineage(db, row.id, familyId);
        item.eventInserted = Boolean(lineage.event?.inserted);
        item.snapshotRefreshed = Boolean(lineage.assessment);
        if (item.familyMoved && oldFamilyId && oldFamilyId !== familyId) {
          upsertAssessmentSnapshot(db, oldFamilyId, String(row.event_occurred_at || row.published_at).slice(0, 10));
        }
      }
    });
  }

  return {
    dryRun: !apply,
    applied: apply,
    status: 'succeeded',
    documentsReviewed: items.length,
    familiesAttached: items.filter((item) => item.familyAttached).length,
    familiesMoved: items.filter((item) => item.familyMoved).length,
    eventsAdded: items.filter((item) => item.eventInserted).length,
    eventsReclassified: items.filter((item) => item.eventReclassified).length,
    metadataCorrected: items.filter((item) => item.metadataAction === 'corrected').length,
    auditsAdded: items.reduce((total, item) => (
      total + Number(item.auditInserted) + Number(item.eventAuditInserted)
    ), 0),
    snapshotsRefreshed: items.filter((item) => item.snapshotRefreshed).length,
    policy: '显式或既有脉络优先；缺失脉络按当前主题分类补齐。会议和正式发文只记 announced，自动流程不写 confirmed。旧分析版本不更新、不删除。',
    items: items.map(({
      correction,
      autoFamily,
      familyNeedsMove,
      eventNeedsReclassification,
      row,
      ...item
    }) => item)
  };
}

module.exports = {
  METADATA_AUDIT_TITLE,
  EVENT_AUDIT_TITLE,
  candidateDocuments,
  correctionFor,
  fallbackIssuer,
  runReconcileLineage
};
