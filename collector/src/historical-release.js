'use strict';

const crypto = require('node:crypto');

const { classifyCategory, importanceFor } = require('./analysis');
const { adaptiveBatchSize, currentLoadSnapshot } = require('./historical-backfill');
const {
  inputChecksum,
  loadAnalysisInputs,
  MINIMUM_CONFIDENCE
} = require('./historical-analysis');
const { officialEvidenceUrl } = require('./historical-review');
const { checksumMatches } = require('./historical-verification');
const { buildAssessment } = require('./lineage');

const RELEASE_METHODS = new Set(['historical-evidence-gates-v2', 'human-review-v1']);
const EVENT_LABELS = Object.freeze({
  implementation: '实施证据',
  funding: '资金拨付证据',
  outcome: '结果证据',
  meeting_signal: '会议或表态信号',
  policy_release: '政策发布'
});

function safeJson(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
}

function publicDocumentStatus(item) {
  if (item.repealed_at) return 'expired';
  if (item.effective_at && Date.parse(item.effective_at) <= Date.now()) return 'effective';
  return 'published';
}

function historicalFamily(item, category) {
  const hash = crypto.createHash('sha256').update(item.source_url, 'utf8').digest('hex').slice(0, 16);
  return {
    slug: `historical-policy-${hash}`,
    title: item.title,
    category,
    description: '按单项历史政策建立的证据脉络；实施、资金和结果只记录可回链的官方材料。'
  };
}

function sourceRoot(sourceUrl) {
  const url = new URL(sourceUrl);
  return `${url.protocol}//${url.host}/`;
}

function resolveSource(db, item) {
  const officialUrl = sourceRoot(item.source_url);
  const existing = db.prepare('SELECT id FROM sources WHERE official_url = ?').get(officialUrl);
  if (existing) return Number(existing.id);
  return Number(db.prepare(`
    INSERT INTO sources (name, kind, authority_level, official_url)
    VALUES (?, 'official', 'central', ?)
  `).run(item.source_name, officialUrl).lastInsertRowid);
}

function resolveFamily(db, family) {
  const existing = db.prepare('SELECT id FROM policy_families WHERE slug = ?').get(family.slug);
  if (existing) return Number(existing.id);
  return Number(db.prepare(`
    INSERT INTO policy_families (slug, title, category, description)
    VALUES (?, ?, ?, ?)
  `).run(family.slug, family.title, family.category, family.description).lastInsertRowid);
}

function ensureDocument(db, item, analysis, sourceId, familyId, category) {
  const existing = db.prepare('SELECT * FROM documents WHERE original_url = ?').get(item.source_url);
  const status = publicDocumentStatus(item);
  const documentDate = String(item.published_at).slice(0, 10);
  if (!existing) {
    const id = Number(db.prepare(`
      INSERT INTO documents (
        source_id, family_id, title, subtitle, summary, issuer, document_number,
        document_date, category, status, importance, original_url, cover_image,
        published_at, effective_at, content_text, original_excerpt, checksum, fetched_at
      ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, coalesce(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))
    `).run(
      sourceId, familyId, item.title, analysis.summary, item.issuer, item.document_number || '',
      documentDate, category, status, importanceFor({ tier: 'P2' }, {
        title: item.title, issuer: item.issuer
      }), item.source_url, item.published_at, item.effective_at, item.content_text,
      item.content_text.slice(0, 1000), item.checksum, item.fetched_at
    ).lastInsertRowid);
    return { documentId: id, action: 'inserted' };
  }
  if (existing.checksum !== item.checksum || existing.title !== item.title
      || existing.issuer !== item.issuer || existing.published_at !== item.published_at) {
    throw new Error('existing public document conflicts with the verified historical source');
  }
  db.prepare(`
    UPDATE documents SET
      source_id = ?, family_id = coalesce(family_id, ?),
      summary = CASE WHEN trim(summary) = '' THEN ? ELSE summary END,
      document_number = CASE WHEN trim(document_number) = '' THEN ? ELSE document_number END,
      document_date = coalesce(document_date, ?), effective_at = coalesce(effective_at, ?),
      status = ?, fetched_at = coalesce(?, fetched_at)
    WHERE id = ?
  `).run(
    sourceId, familyId, analysis.summary, item.document_number || '', documentDate,
    item.effective_at, status, item.fetched_at, existing.id
  );
  const updated = db.prepare('SELECT * FROM documents WHERE id = ?').get(existing.id);
  if (updated.document_number !== (item.document_number || '') || updated.document_date !== documentDate
      || (item.effective_at && updated.effective_at !== item.effective_at)) {
    throw new Error('existing public metadata conflicts with verified historical metadata');
  }
  return { documentId: Number(existing.id), action: 'linked_existing' };
}

function insertPublicAnalysis(db, documentId, item, analysis, assessment) {
  const previous = db.prepare(`
    SELECT id, version FROM analysis_versions
    WHERE document_id = ? ORDER BY version DESC, id DESC LIMIT 1
  `).get(documentId);
  const version = Number(previous?.version || 0) + 1;
  const interpretation = [analysis.summary, analysis.cycleAssessment].filter(Boolean).join('\n\n');
  const impact = [analysis.implementationAssessment, analysis.outcomeAssessment].filter(Boolean).join('\n\n');
  const recommendations = analysis.reviewStatus === 'watching'
    ? '继续检索后续官方实施、实际拨付和结果材料；没有新证据时不提高结论等级。'
    : analysis.reviewStatus === 'partial'
      ? '继续补齐尚未出现的实施或结果环节，并保持结果观察与政策因果判断分离。'
      : analysis.reviewStatus === 'ambiguous'
        ? '保留冲突口径，等待权威说明或人工复核，不选择性采信其中一项。'
        : '继续跟踪后续修订、废止和结果数据，不把已观察结果外推为单一政策因果。';
  const analysisId = Number(db.prepare(`
    INSERT INTO analysis_versions (
      document_id, version, previous_version_id, headline, interpretation,
      impact, recommendations, methodology, evidence_summary, model_name,
      prompt_version, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'historical-release-v1', 'published')
  `).run(
    documentId,
    version,
    previous?.id || null,
    `${item.title}：${analysis.summary}`,
    interpretation,
    impact,
    recommendations,
    analysis.methodology || assessment.methodology,
    analysis.summary,
    assessment.methodology
  ).lastInsertRowid);
  return { analysisId, version };
}

function insertSignals(db, documentId, itemId) {
  const rows = db.prepare(`
    SELECT evidence_type, title, source_url, evidence_quote, observed_at, confidence
    FROM historical_policy_evidence
    WHERE item_id = ? AND classification = 'accepted'
    ORDER BY observed_at, id
  `).all(itemId);
  const insert = db.prepare(`
    INSERT INTO policy_signals (
      document_id, kind, label, value_text, unit, period, evidence_quote,
      source_url, observed_at, confidence
    ) VALUES (?, ?, ?, ?, '', '', ?, ?, ?, ?)
  `);
  for (const row of rows) insert.run(
    documentId,
    row.evidence_type,
    EVENT_LABELS[row.evidence_type] || '官方证据',
    row.title,
    row.evidence_quote,
    row.source_url,
    row.observed_at,
    row.confidence
  );
  return rows.length;
}

function insertAmbiguities(db, documentId, analysisId, analysis, reviewedAt) {
  const insert = db.prepare(`
    INSERT INTO ambiguities (
      document_id, analysis_version_id, title, description, severity, status, detected_at
    ) VALUES (?, ?, ?, ?, ?, 'open', ?)
  `);
  let count = 0;
  for (const entry of analysis.ambiguities || []) {
    const ambiguity = typeof entry === 'string'
      ? { title: '人工复核保留歧义', description: entry, severity: 'medium' }
      : entry;
    insert.run(
      documentId,
      analysisId,
      ambiguity.title || ambiguity.type || '证据歧义',
      ambiguity.description || JSON.stringify(ambiguity.values || []),
      ['low', 'medium', 'high'].includes(ambiguity.severity) ? ambiguity.severity : 'medium',
      reviewedAt
    );
    count += 1;
  }
  return count;
}

function insertEventsAndAssessment(db, familyId, documentId, item, analysis) {
  const insert = db.prepare(`
    INSERT INTO implementation_events (
      family_id, document_id, title, event_type, description,
      evidence_quote, source_url, occurred_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const eventIds = [];
  eventIds.push(Number(insert.run(
    familyId, documentId, item.title, 'policy_release',
    '正式政策原文已经完成来源、元数据和生命周期核验；发文事实本身不等于实施或结果。',
    item.content_text.slice(0, 500), item.source_url, item.published_at, 'confirmed'
  ).lastInsertRowid));
  const evidence = db.prepare(`
    SELECT * FROM historical_policy_evidence WHERE item_id = ? ORDER BY observed_at, id
  `).all(item.id);
  for (const row of evidence) {
    const details = safeJson(row.details_json, {});
    const eventType = row.evidence_type === 'outcome' ? 'result_data' : row.evidence_type;
    const status = row.classification === 'accepted' ? 'observed' : 'announced';
    eventIds.push(Number(insert.run(
      familyId,
      documentId,
      row.title,
      eventType,
      details.reason || (row.classification === 'accepted' ? '官方材料记录的后续证据。' : '该材料不计入政策兑现证据。'),
      row.evidence_quote,
      row.source_url,
      row.observed_at || item.published_at,
      status
    ).lastInsertRowid));
  }
  const asOfDate = String(item.reviewed_at || new Date().toISOString()).slice(0, 10);
  const events = db.prepare(`
    SELECT id, event_type, status, source_url FROM implementation_events
    WHERE family_id = ? AND substr(occurred_at, 1, 10) <= ? ORDER BY occurred_at, id
  `).all(familyId, asOfDate);
  const snapshot = buildAssessment(events, asOfDate);
  db.prepare(`
    INSERT INTO assessment_snapshots (
      family_id, as_of_date, summary, score, conclusion, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(family_id, as_of_date) DO UPDATE SET
      summary = excluded.summary, score = excluded.score,
      conclusion = excluded.conclusion, evidence_json = excluded.evidence_json
  `).run(familyId, asOfDate, snapshot.summary, snapshot.score, analysis.summary, JSON.stringify(snapshot.evidence));
  return { events: eventIds.length, asOfDate };
}

function currentAssessment(db, item) {
  try {
    officialEvidenceUrl(item.source_url);
  } catch {
    const error = new Error('ready item no longer has a valid official source URL');
    error.code = 'STALE_ASSESSMENT';
    throw error;
  }
  if (!checksumMatches(item)) {
    const error = new Error('ready item source checksum no longer matches its content');
    error.code = 'STALE_ASSESSMENT';
    throw error;
  }
  const itemAnalysis = safeJson(item.analysis_json, {});
  const assessmentId = Number(itemAnalysis.assessmentVersionId);
  if (!Number.isSafeInteger(assessmentId) || assessmentId < 1) {
    throw new Error('ready item has no approved historical assessment version');
  }
  const assessment = db.prepare(`
    SELECT * FROM historical_analysis_versions WHERE id = ? AND item_id = ?
  `).get(assessmentId, item.id);
  if (!assessment || !assessment.release_eligible || Number(assessment.confidence) < MINIMUM_CONFIDENCE
      || !RELEASE_METHODS.has(assessment.methodology)) {
    throw new Error('historical assessment is not eligible for automatic release');
  }
  const gates = safeJson(assessment.gates_json, []);
  if (!gates.length || gates.some((entry) => entry.passed !== true)) {
    throw new Error('historical assessment contains an unpassed release gate');
  }
  const analysis = safeJson(assessment.analysis_json, null);
  const itemAnalysisPayload = { ...itemAnalysis };
  delete itemAnalysisPayload.assessmentVersionId;
  delete itemAnalysisPayload.assessmentVersion;
  if (!analysis || Number(itemAnalysis.assessmentVersion) !== Number(assessment.version)
      || JSON.stringify(canonicalJson(itemAnalysisPayload)) !== JSON.stringify(canonicalJson(analysis))) {
    const error = new Error('ready item analysis does not match its immutable assessment version');
    error.code = 'STALE_ASSESSMENT';
    throw error;
  }
  const currentFingerprint = inputChecksum(item, loadAnalysisInputs(db, item));
  if (assessment.methodology === 'historical-evidence-gates-v2' && currentFingerprint !== assessment.input_checksum) {
    const error = new Error('historical assessment is stale relative to the private corpus');
    error.code = 'STALE_ASSESSMENT';
    throw error;
  }
  return { assessment, analysis };
}

function requeueStaleAssessment(db, item, message) {
  db.prepare(`
    UPDATE historical_backfill_items SET
      stage = 'lifecycle_verified', analysis_status = 'pending', last_error = ?, next_attempt_at = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(message, item.id);
}

function releaseControl(db) {
  return db.prepare(`
    SELECT control.*, cohort.status AS cohort_status, cohort.target_size
    FROM historical_release_control control
    LEFT JOIN historical_release_cohorts cohort ON cohort.id = control.active_cohort_id
    WHERE control.id = 1
  `).get();
}

function advanceCohortObservation(db) {
  const control = releaseControl(db);
  if (control.mode !== 'cohort' || !control.active_cohort_id) return control.cohort_status || null;
  const remaining = Number(db.prepare(`
    SELECT count(*) AS count
    FROM historical_release_cohort_items cohort_item
    WHERE cohort_item.cohort_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM historical_public_releases release
        WHERE release.item_id = cohort_item.item_id
          AND release.assessment_version_id = cohort_item.assessment_version_id
      )
  `).get(control.active_cohort_id).count);
  if (remaining > 0) return 'approved';
  db.prepare(`
    UPDATE historical_release_cohorts SET status = 'observing'
    WHERE id = ? AND status = 'approved'
  `).run(control.active_cohort_id);
  db.prepare(`
    UPDATE historical_release_control SET
      mode = 'disabled', changed_by = 'historical-release-v1',
      change_note = 'first cohort released; full rollout remains disabled during observation',
      changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 1
  `).run();
  return 'observing';
}

function releaseHistoricalItem(db, item) {
  db.exec('BEGIN IMMEDIATE');
  try {
    item = db.prepare('SELECT * FROM historical_backfill_items WHERE id = ?').get(item.id);
    if (!item || item.stage !== 'ready' || item.analysis_status !== 'verified') {
      throw new Error('historical item is no longer ready for release');
    }
    const { assessment, analysis } = currentAssessment(db, item);
    const alreadyReleased = db.prepare(`
      SELECT * FROM historical_public_releases
      WHERE item_id = ? AND assessment_version_id = ?
    `).get(item.id, assessment.id);
    if (alreadyReleased) {
      db.exec('COMMIT');
      return { itemId: item.id, action: 'already_released', documentId: alreadyReleased.document_id };
    }
    const category = classifyCategory({ title: item.title, contentText: item.content_text });
    const sourceId = resolveSource(db, item);
    const familyId = resolveFamily(db, historicalFamily(item, category));
    const document = ensureDocument(db, item, analysis, sourceId, familyId, category);
    const publicAnalysis = insertPublicAnalysis(db, document.documentId, item, analysis, assessment);
    const signals = insertSignals(db, document.documentId, item.id);
    const ambiguities = insertAmbiguities(db, document.documentId, publicAnalysis.analysisId, analysis, item.reviewed_at);
    const lineage = insertEventsAndAssessment(db, familyId, document.documentId, item, analysis);
    const releaseId = Number(db.prepare(`
      INSERT INTO historical_public_releases (
        item_id, assessment_version_id, document_id, analysis_version_id, action
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      item.id, assessment.id, document.documentId, publicAnalysis.analysisId, document.action
    ).lastInsertRowid);
    db.prepare(`
      UPDATE historical_backfill_items SET
        stage = 'published', document_id = ?, last_error = '', next_attempt_at = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(document.documentId, item.id);
    const cohortStatus = advanceCohortObservation(db);
    db.exec('COMMIT');
    return {
      itemId: item.id,
      action: document.action,
      releaseId,
      documentId: document.documentId,
      analysisVersion: publicAnalysis.version,
      reviewStatus: analysis.reviewStatus,
      signals,
      ambiguities,
      events: lineage.events,
      cohortStatus
    };
  } catch (error) {
    db.exec('ROLLBACK');
    if (error.code === 'STALE_ASSESSMENT') requeueStaleAssessment(db, item, error.message);
    throw error;
  }
}

function releaseQueueItems(db, maximum) {
  return db.prepare(`
    SELECT item.*
    FROM historical_backfill_items item
    JOIN historical_release_control control ON control.id = 1
    WHERE item.item_kind = 'document' AND item.stage = 'ready' AND item.analysis_status = 'verified'
      AND item.document_id IS NULL
      AND (item.next_attempt_at IS NULL OR item.next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      AND (
        control.mode = 'full'
        OR (control.mode = 'cohort' AND EXISTS (
          SELECT 1
          FROM historical_release_cohorts cohort
          JOIN historical_release_cohort_items cohort_item ON cohort_item.cohort_id = cohort.id
          WHERE cohort.id = control.active_cohort_id AND cohort.status = 'approved'
            AND cohort_item.item_id = item.id
            AND cohort_item.assessment_version_id = CAST(json_extract(item.analysis_json, '$.assessmentVersionId') AS INTEGER)
        ))
      )
    ORDER BY coalesce(item.source_year, 9999), item.id
    LIMIT ?
  `).all(maximum);
}

function updateReleaseFailure(db, item, error) {
  const current = db.prepare('SELECT stage FROM historical_backfill_items WHERE id = ?').get(item.id);
  if (current?.stage !== 'ready') return;
  const retryHours = Math.min(168, 2 ** Math.min(item.attempts + 1, 7));
  db.prepare(`
    UPDATE historical_backfill_items SET attempts = attempts + 1, last_error = ?,
      next_attempt_at = datetime('now', ?), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(String(error.message || error).slice(0, 1000), `+${retryHours} hours`, item.id);
}

async function runHistoricalReleaseQueue(db, options = {}, dependencies = {}) {
  const maximum = options.maxItems || 100;
  const minimum = Math.min(maximum, options.minItems || 5);
  const readLoad = dependencies.loadSnapshot || currentLoadSnapshot;
  const initialLoad = readLoad();
  const capacity = options.adaptiveLoad ? adaptiveBatchSize(maximum, minimum, initialLoad) : maximum;
  const items = releaseQueueItems(db, maximum);
  const control = releaseControl(db);
  const heldReady = Number(db.prepare(`
    SELECT count(*) AS count FROM historical_backfill_items
    WHERE item_kind = 'document' AND stage = 'ready' AND analysis_status = 'verified'
      AND document_id IS NULL
  `).get().count) - items.length;
  const result = {
    status: 'succeeded', selected: items.length, planned: Math.min(items.length, capacity),
    processed: 0, published: 0, requeued: 0,
    adaptiveLoad: Boolean(options.adaptiveLoad), load: initialLoad, stoppedDueToLoad: false,
    rollout: control, heldReady: Math.max(0, heldReady),
    items: [], errors: []
  };
  for (let index = 0; index < items.length; index += 1) {
    if (options.adaptiveLoad && index >= minimum) {
      if (index >= adaptiveBatchSize(maximum, minimum, readLoad())) {
        result.stoppedDueToLoad = true;
        break;
      }
    } else if (index >= capacity) break;
    const item = items[index];
    try {
      const released = releaseHistoricalItem(db, item);
      result.processed += 1;
      if (released.action === 'already_released') result.items.push(released);
      else {
        result.published += 1;
        result.items.push(released);
      }
    } catch (error) {
      const current = db.prepare('SELECT stage FROM historical_backfill_items WHERE id = ?').get(item.id);
      if (current?.stage === 'lifecycle_verified') {
        result.requeued += 1;
        result.items.push({
          itemId: item.id,
          action: 'assessment_requeued',
          message: String(error.message || error)
        });
        continue;
      }
      updateReleaseFailure(db, item, error);
      result.errors.push({ id: item.id, url: item.source_url, message: error.message });
    }
  }
  if (result.errors.length) result.status = result.published ? 'partial' : 'failed';
  return result;
}

module.exports = {
  currentAssessment,
  publicDocumentStatus,
  releaseControl,
  releaseHistoricalItem,
  runHistoricalReleaseQueue
};
