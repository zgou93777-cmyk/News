'use strict';

const PROGRESS_GROUPS = Object.freeze({
  discovered: "item.item_kind = 'document'",
  fetched: "item.item_kind = 'document' AND trim(item.content_text) <> ''",
  analyzed: `item.item_kind = 'document' AND EXISTS (
    SELECT 1 FROM historical_analysis_versions assessment WHERE assessment.item_id = item.id
  )`,
  verified: `item.item_kind = 'document'
    AND item.source_status = 'verified'
    AND item.metadata_status = 'verified'
    AND item.lifecycle_status IN ('verified', 'not_applicable')`,
  ready: "item.item_kind = 'document' AND item.stage = 'ready'",
  published: "item.item_kind = 'document' AND item.stage = 'published'"
});

function number(value) {
  return Number(value || 0);
}

function historicalProgress(db, options = {}) {
  const group = String(options.group || 'fetched');
  const where = PROGRESS_GROUPS[group];
  if (!where) throw new RangeError(`unsupported historical progress group: ${group}`);
  const page = Number(options.page || 1);
  const pageSize = Number(options.pageSize || 20);
  const query = String(options.query || '').trim();
  const queryWhere = query
    ? " AND (item.title LIKE ? ESCAPE '\\' OR item.source_name LIKE ? ESCAPE '\\' OR item.source_url LIKE ? ESCAPE '\\')"
    : '';
  const escapedQuery = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
  const queryParams = query ? [escapedQuery, escapedQuery, escapedQuery] : [];

  const summary = db.prepare(`
    SELECT
      count(*) AS queue_total,
      count(*) FILTER (WHERE item_kind = 'document') AS policy_items,
      count(*) FILTER (WHERE item_kind = 'document') AS discovered,
      count(*) FILTER (WHERE item_kind = 'document' AND trim(content_text) <> '') AS fetched,
      count(*) FILTER (
        WHERE item_kind = 'document' AND EXISTS (
          SELECT 1 FROM historical_analysis_versions assessment WHERE assessment.item_id = historical_backfill_items.id
        )
      ) AS analyzed,
      count(*) FILTER (
        WHERE item_kind = 'document' AND source_status = 'verified'
          AND metadata_status = 'verified'
          AND lifecycle_status IN ('verified', 'not_applicable')
      ) AS verified,
      count(*) FILTER (WHERE item_kind = 'document' AND stage = 'ready') AS ready,
      count(*) FILTER (WHERE item_kind = 'document' AND stage = 'published') AS published,
      count(*) FILTER (WHERE stage = 'failed') AS failed,
      count(*) FILTER (WHERE stage = 'manual_review') AS manual_review,
      count(*) FILTER (
        WHERE next_attempt_at IS NOT NULL
          AND next_attempt_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      ) AS scheduled_retry,
      count(*) FILTER (
        WHERE updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
      ) AS updated_last_24h,
      min(source_year) FILTER (WHERE source_year IS NOT NULL) AS earliest_year,
      max(source_year) FILTER (WHERE source_year IS NOT NULL) AS latest_year,
      max(updated_at) AS latest_update_at
    FROM historical_backfill_items
  `).get();
  const byStage = db.prepare(`
    SELECT stage, count(*) AS count
    FROM historical_backfill_items
    GROUP BY stage ORDER BY stage
  `).all();
  const rollout = db.prepare(`
    SELECT control.mode, control.active_cohort_id, control.change_note, control.changed_at,
      cohort.status AS cohort_status, cohort.target_size,
      (SELECT count(*) FROM historical_release_cohort_items cohort_item
        WHERE cohort_item.cohort_id = cohort.id) AS cohort_items,
      (SELECT count(*) FROM historical_release_cohort_items cohort_item
        JOIN historical_public_releases release
          ON release.item_id = cohort_item.item_id
          AND release.assessment_version_id = cohort_item.assessment_version_id
        WHERE cohort_item.cohort_id = cohort.id) AS cohort_released
    FROM historical_release_control control
    LEFT JOIN historical_release_cohorts cohort ON cohort.id = control.active_cohort_id
    WHERE control.id = 1
  `).get();

  const total = number(db.prepare(`
    SELECT count(*) AS count FROM historical_backfill_items item
    WHERE ${where}${queryWhere}
  `).get(...queryParams).count);
  const items = db.prepare(`
    SELECT
      item.id, item.title, item.source_year, item.source_name, item.source_url,
      item.source_type, item.item_kind, item.stage, item.source_status,
      item.metadata_status, item.lifecycle_status, item.implementation_status,
      item.outcome_status, item.analysis_status, item.last_error,
      item.attempts, item.next_attempt_at, item.fetched_at, item.reviewed_at,
      item.updated_at, item.document_id,
      (SELECT assessment.review_status
        FROM historical_analysis_versions assessment
        WHERE assessment.item_id = item.id
        ORDER BY assessment.version DESC LIMIT 1) AS review_status,
      (SELECT assessment.confidence
        FROM historical_analysis_versions assessment
        WHERE assessment.item_id = item.id
        ORDER BY assessment.version DESC LIMIT 1) AS confidence,
      (SELECT assessment.version
        FROM historical_analysis_versions assessment
        WHERE assessment.item_id = item.id
        ORDER BY assessment.version DESC LIMIT 1) AS assessment_version,
      (SELECT assessment.release_eligible
        FROM historical_analysis_versions assessment
        WHERE assessment.item_id = item.id
        ORDER BY assessment.version DESC LIMIT 1) AS release_eligible,
      EXISTS (
        SELECT 1 FROM historical_analysis_frameworks framework
        JOIN historical_analysis_versions assessment
          ON assessment.id = framework.assessment_version_id
        WHERE assessment.id = (
          SELECT latest.id FROM historical_analysis_versions latest
          WHERE latest.item_id = item.id ORDER BY latest.version DESC LIMIT 1
        )
          AND json_extract(framework.framework_json, '$.ready') IS 1
      ) AS framework_ready,
      EXISTS (
        SELECT 1 FROM historical_release_control control
        JOIN historical_release_cohort_items cohort_item
          ON cohort_item.cohort_id = control.active_cohort_id
        WHERE control.id = 1 AND cohort_item.item_id = item.id
      ) AS in_release_cohort
    FROM historical_backfill_items item
    WHERE ${where}${queryWhere}
    ORDER BY item.updated_at DESC, item.id DESC
    LIMIT ? OFFSET ?
  `).all(...queryParams, pageSize, (page - 1) * pageSize);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      queueTotal: number(summary.queue_total),
      policyItems: number(summary.policy_items),
      discovered: number(summary.discovered),
      fetched: number(summary.fetched),
      analyzed: number(summary.analyzed),
      verified: number(summary.verified),
      ready: number(summary.ready),
      published: number(summary.published),
      failed: number(summary.failed),
      manualReview: number(summary.manual_review),
      scheduledRetry: number(summary.scheduled_retry),
      updatedLast24h: number(summary.updated_last_24h),
      earliestYear: summary.earliest_year == null ? null : number(summary.earliest_year),
      latestYear: summary.latest_year == null ? null : number(summary.latest_year),
      latestUpdateAt: summary.latest_update_at || null
    },
    byStage: Object.fromEntries(byStage.map((row) => [row.stage, number(row.count)])),
    rollout: {
      mode: rollout?.mode || 'disabled',
      activeCohortId: rollout?.active_cohort_id == null ? null : number(rollout.active_cohort_id),
      cohortStatus: rollout?.cohort_status || null,
      targetSize: rollout?.target_size == null ? null : number(rollout.target_size),
      cohortItems: number(rollout?.cohort_items),
      cohortReleased: number(rollout?.cohort_released),
      changeNote: rollout?.change_note || '',
      changedAt: rollout?.changed_at || null
    },
    selection: {
      group,
      query,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      items: items.map((item) => ({
        id: number(item.id),
        title: item.title || '待提取标题',
        sourceYear: item.source_year == null ? null : number(item.source_year),
        sourceName: item.source_name,
        sourceUrl: item.source_url,
        sourceType: item.source_type,
        itemKind: item.item_kind,
        stage: item.stage,
        sourceStatus: item.source_status,
        metadataStatus: item.metadata_status,
        lifecycleStatus: item.lifecycle_status,
        implementationStatus: item.implementation_status,
        outcomeStatus: item.outcome_status,
        analysisStatus: item.analysis_status,
        reviewStatus: item.review_status || null,
        confidence: item.confidence == null ? null : Number(item.confidence),
        assessmentVersion: item.assessment_version == null ? null : number(item.assessment_version),
        releaseEligible: Boolean(item.release_eligible),
        frameworkReady: Boolean(item.framework_ready),
        inReleaseCohort: Boolean(item.in_release_cohort),
        attempts: number(item.attempts),
        lastError: item.last_error || '',
        nextAttemptAt: item.next_attempt_at || null,
        fetchedAt: item.fetched_at || null,
        reviewedAt: item.reviewed_at || null,
        updatedAt: item.updated_at,
        documentId: item.document_id == null ? null : number(item.document_id)
      }))
    }
  };
}

module.exports = { PROGRESS_GROUPS, historicalProgress };
