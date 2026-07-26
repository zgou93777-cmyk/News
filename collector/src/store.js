'use strict';

const { withTransaction } = require('../../server/src/db');
const { buildAssessment, classifyImplementationEvent } = require('./lineage');

function canonicalizeUrl(value) {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_|spm$|from$|source$)/i.test(key)) url.searchParams.delete(key);
  }
  return url.href;
}

function duplicateDecision(db, originalUrl, checksum) {
  const existingUrl = db.prepare(`
    SELECT id, checksum FROM documents WHERE original_url = ?
  `).get(originalUrl);
  if (existingUrl) {
    if (String(existingUrl.checksum || '').startsWith('seed-')) {
      return { action: 'hydrate', documentId: existingUrl.id, reason: 'seed_placeholder_checksum' };
    }
    return existingUrl.checksum === checksum
      ? { action: 'duplicate', documentId: existingUrl.id, reason: 'same_url_and_checksum' }
      : { action: 'update', documentId: existingUrl.id, reason: 'same_url_changed_content' };
  }
  const existingContent = db.prepare(`
    SELECT id, original_url FROM documents WHERE checksum = ? AND checksum <> '' LIMIT 1
  `).get(checksum);
  if (existingContent) {
    return {
      action: 'duplicate',
      documentId: existingContent.id,
      reason: 'same_checksum',
      duplicateOf: existingContent.original_url
    };
  }
  return { action: 'insert', documentId: null, reason: 'new_document' };
}

function getOrInsertSource(db, source) {
  const existing = db.prepare('SELECT id FROM sources WHERE official_url = ?').get(source.url);
  if (existing) return existing.id;
  return Number(db.prepare(`
    INSERT INTO sources (name, kind, authority_level, official_url)
    VALUES (?, ?, ?, ?)
  `).run(source.name, source.kind || 'official', source.authorityLevel || 'central', source.url).lastInsertRowid);
}

function persistMissingCover(db, documentId, coverImage) {
  if (!coverImage) return false;
  return db.prepare(`
    UPDATE documents SET cover_image = ?
    WHERE id = ? AND status <> 'draft' AND trim(coalesce(cover_image, '')) = ''
  `).run(coverImage, documentId).changes > 0;
}

function resolveFamily(db, family) {
  if (!family?.slug) return null;
  const existing = db.prepare('SELECT id FROM policy_families WHERE slug = ?').get(family.slug);
  if (existing) {
    if (family.explicit === false) {
      db.prepare(`
        UPDATE policy_families SET title = ?, category = ?, description = ? WHERE id = ?
      `).run(
        family.title,
        family.category || '综合政策',
        family.description || '',
        existing.id
      );
    }
    return existing.id;
  }
  if (!family.title) throw new Error('family title is required when creating a family');
  return Number(db.prepare(`
    INSERT INTO policy_families (slug, title, category, description)
    VALUES (?, ?, ?, ?)
  `).run(family.slug, family.title, family.category || '综合政策', family.description || '').lastInsertRowid);
}

function resolveDocumentFamily(db, documentId, family) {
  const current = documentId
    ? db.prepare('SELECT family_id FROM documents WHERE id = ?').get(documentId)?.family_id || null
    : null;
  if (current && !family?.explicit) return current;
  const resolved = resolveFamily(db, family);
  if (documentId && resolved && resolved !== current) {
    db.prepare('UPDATE documents SET family_id = ? WHERE id = ?').run(resolved, documentId);
  }
  return resolved || current;
}

function upsertAssessmentSnapshot(db, familyId, asOfDate) {
  const events = db.prepare(`
    SELECT id, event_type, status, source_url
    FROM implementation_events
    WHERE family_id = ? AND substr(occurred_at, 1, 10) <= ?
    ORDER BY occurred_at, id
  `).all(familyId, asOfDate);
  const assessment = buildAssessment(events, asOfDate);
  const result = db.prepare(`
    INSERT INTO assessment_snapshots (
      family_id, as_of_date, summary, score, conclusion, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(family_id, as_of_date) DO UPDATE SET
      summary = excluded.summary,
      score = excluded.score,
      conclusion = excluded.conclusion,
      evidence_json = excluded.evidence_json
  `).run(
    familyId,
    asOfDate,
    assessment.summary,
    assessment.score,
    assessment.conclusion,
    JSON.stringify(assessment.evidence)
  );
  return { ...assessment, asOfDate, changed: result.changes > 0 };
}

function ensureDocumentLineage(db, documentId, familyId) {
  if (!familyId) return { event: null, assessment: null };
  const document = db.prepare(`
    SELECT id, title, original_url AS originalUrl, published_at AS publishedAt,
           content_text AS contentText, original_excerpt AS originalExcerpt
    FROM documents WHERE id = ?
  `).get(documentId);
  if (!document) throw new Error(`document ${documentId} was not found for lineage enrichment`);

  let event = db.prepare(`
    SELECT id, family_id, event_type, status, occurred_at
    FROM implementation_events WHERE document_id = ? ORDER BY id LIMIT 1
  `).get(documentId);
  let inserted = false;
  if (!event) {
    const derived = classifyImplementationEvent(document);
    const eventId = Number(db.prepare(`
      INSERT INTO implementation_events (
        family_id, document_id, title, event_type, description,
        evidence_quote, source_url, occurred_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      familyId,
      documentId,
      document.title,
      derived.eventType,
      derived.description,
      derived.evidenceQuote,
      document.originalUrl,
      document.publishedAt,
      derived.status
    ).lastInsertRowid);
    event = {
      id: eventId,
      family_id: familyId,
      event_type: derived.eventType,
      status: derived.status,
      occurred_at: document.publishedAt
    };
    inserted = true;
  } else if (!event.family_id) {
    db.prepare('UPDATE implementation_events SET family_id = ? WHERE id = ?').run(familyId, event.id);
    event.family_id = familyId;
  }

  const asOfDate = String(event.occurred_at || document.publishedAt).slice(0, 10);
  const assessment = upsertAssessmentSnapshot(db, familyId, asOfDate);
  return {
    event: {
      id: event.id,
      eventType: event.event_type,
      status: event.status,
      inserted
    },
    assessment
  };
}

function insertAnalysis(db, documentId, analysis) {
  const previous = db.prepare(`
    SELECT id, version FROM analysis_versions
    WHERE document_id = ? ORDER BY version DESC, id DESC LIMIT 1
  `).get(documentId);
  const version = (previous?.version || 0) + 1;
  const analysisId = Number(db.prepare(`
    INSERT INTO analysis_versions (
      document_id, version, previous_version_id, headline, interpretation,
      impact, recommendations, methodology, evidence_summary,
      model_name, prompt_version, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'published')
  `).run(
    documentId,
    version,
    previous?.id || null,
    analysis.headline,
    analysis.interpretation,
    analysis.impact,
    analysis.recommendations,
    analysis.methodology,
    analysis.evidenceSummary,
    analysis.modelName,
    analysis.promptVersion
  ).lastInsertRowid);

  const insertSignal = db.prepare(`
    INSERT INTO policy_signals (
      document_id, kind, label, value_text, unit, period, evidence_quote,
      source_url, observed_at, confidence
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const signal of analysis.signals || []) {
    insertSignal.run(
      documentId, signal.kind, signal.label, signal.valueText, signal.unit || '', signal.period || '',
      signal.evidenceQuote, signal.sourceUrl, signal.observedAt, signal.confidence
    );
  }

  const insertForecast = db.prepare(`
    INSERT INTO forecasts (
      analysis_version_id, statement, basis, expected_by, confidence,
      status, verification_note
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const forecast of analysis.forecasts || []) {
    insertForecast.run(
      analysisId,
      forecast.statement,
      forecast.basis || '待后续官方证据核验。',
      forecast.expectedBy || null,
      forecast.confidence,
      forecast.status || 'pending',
      forecast.verificationNote || ''
    );
  }

  const insertAmbiguity = db.prepare(`
    INSERT INTO ambiguities (
      document_id, analysis_version_id, title, description, severity,
      status, detected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const ambiguity of analysis.ambiguities || []) {
    insertAmbiguity.run(
      documentId,
      analysisId,
      ambiguity.title,
      ambiguity.description,
      ambiguity.severity || 'medium',
      ambiguity.status || 'open',
      new Date().toISOString()
    );
  }
  return { analysisId, version };
}

function persistDocument(db, item) {
  const originalUrl = canonicalizeUrl(item.document.originalUrl);
  const decision = duplicateDecision(db, originalUrl, item.checksum);

  return withTransaction(db, () => {
    if (decision.action === 'duplicate') {
      const coverImageUpdated = persistMissingCover(db, decision.documentId, item.coverImage);
      const familyId = resolveDocumentFamily(db, decision.documentId, item.family);
      const lineage = ensureDocumentLineage(db, decision.documentId, familyId);
      return { ...decision, familyId, coverImageUpdated, ...lineage };
    }
    const sourceId = getOrInsertSource(db, item.source);
    let documentId = decision.documentId;
    let familyId;
    if (decision.action === 'insert') {
      familyId = resolveFamily(db, item.family);
      documentId = Number(db.prepare(`
        INSERT INTO documents (
          source_id, family_id, title, subtitle, summary, issuer, category,
          status, importance, original_url, cover_image, published_at, effective_at,
          content_text, original_excerpt, checksum
        ) VALUES (?, ?, ?, '', ?, ?, ?, 'published', ?, ?, ?, ?, NULL, ?, ?, ?)
      `).run(
        sourceId,
        familyId,
        item.document.title,
        item.analysis.summary || item.document.summary,
        item.document.issuer,
        item.category,
        item.importance,
        originalUrl,
        item.coverImage || '',
        item.document.publishedAt,
        item.document.contentText,
        item.document.originalExcerpt,
        item.checksum
      ).lastInsertRowid);
    } else if (decision.action === 'hydrate') {
      familyId = resolveDocumentFamily(db, documentId, item.family);
      db.prepare(`
        UPDATE documents SET
          source_id = ?, content_text = ?, original_excerpt = ?, checksum = ?,
          cover_image = CASE WHEN trim(coalesce(cover_image, '')) = '' THEN ? ELSE cover_image END,
          fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(
        sourceId,
        item.document.contentText,
        item.document.originalExcerpt,
        item.checksum,
        item.coverImage || '',
        documentId
      );
      const currentAnalysis = db.prepare(`
        SELECT id, version FROM analysis_versions
        WHERE document_id = ? ORDER BY version DESC, id DESC LIMIT 1
      `).get(documentId);
      const lineage = ensureDocumentLineage(db, documentId, familyId);
      return {
        action: decision.action,
        reason: decision.reason,
        documentId,
        familyId,
        analysisId: currentAnalysis?.id || null,
        version: currentAnalysis?.version || null,
        ...lineage
      };
    } else {
      familyId = resolveDocumentFamily(db, documentId, item.family);
      db.prepare(`
        UPDATE documents SET
          source_id = ?, family_id = ?, title = ?, summary = ?,
          issuer = ?, category = ?, importance = ?,
          cover_image = CASE WHEN trim(coalesce(cover_image, '')) = '' THEN ? ELSE cover_image END,
          published_at = ?, content_text = ?,
          original_excerpt = ?, checksum = ?, fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(
        sourceId,
        familyId,
        item.document.title,
        item.analysis.summary || item.document.summary,
        item.document.issuer,
        item.category,
        item.importance,
        item.coverImage || '',
        item.document.publishedAt,
        item.document.contentText,
        item.document.originalExcerpt,
        item.checksum,
        documentId
      );
    }
    const analysis = insertAnalysis(db, documentId, item.analysis);
    const lineage = ensureDocumentLineage(db, documentId, familyId);
    return { action: decision.action, reason: decision.reason, documentId, familyId, ...analysis, ...lineage };
  });
}

function beginSyncRun(db) {
  const startedAt = new Date().toISOString();
  const id = Number(db.prepare(`
    INSERT INTO sync_runs (status, started_at, message)
    VALUES ('running', ?, '政策采集任务正在运行。')
  `).run(startedAt).lastInsertRowid);
  return { id, startedAt };
}

function finishSyncRun(db, run, result) {
  const status = result.status || (result.errors?.length ? 'partial' : 'succeeded');
  db.prepare(`
    UPDATE sync_runs SET
      status = ?, completed_at = ?, sources_checked = ?, documents_found = ?,
      documents_added = ?, message = ?, error_code = ?
    WHERE id = ?
  `).run(
    status,
    new Date().toISOString(),
    result.sourcesChecked || 0,
    result.documentsFound || 0,
    result.documentsAdded || 0,
    result.message || '',
    result.errorCode || '',
    run.id
  );
}

module.exports = {
  beginSyncRun,
  canonicalizeUrl,
  duplicateDecision,
  ensureDocumentLineage,
  finishSyncRun,
  persistDocument,
  persistMissingCover,
  resolveDocumentFamily,
  resolveFamily,
  upsertAssessmentSnapshot
};
