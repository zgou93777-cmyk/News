'use strict';

const { withTransaction } = require('./db');

function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&');
}

function reviewStatus(row) {
  if ((row.open_ambiguities || 0) > 0) return 'ambiguous';
  if (['verified', 'partial', 'ambiguous', 'watching'].includes(row.historical_review_status)) {
    return row.historical_review_status;
  }
  if ((row.verified_forecasts || 0) > 0) return 'verified';
  if ((row.partial_forecasts || 0) > 0) return 'partial';
  return 'watching';
}

const EVENT_TYPE_LABELS = Object.freeze({
  meeting_signal: '会议表态',
  policy_release: '正式发文',
  implementation: '明确实施',
  funding: '资金证据',
  result_data: '结果数据'
});

const ARTICLE_ORDER_SQL = 'd.published_at DESC, d.importance DESC, d.id DESC';
const SHANGHAI_DATE_SQL = "date('now', '+8 hours')";
const HISTORICAL_REVIEW_STATUS_SQL = `(SELECT hav.review_status
  FROM historical_public_releases hpr
  JOIN historical_analysis_versions hav ON hav.id = hpr.assessment_version_id
  WHERE hpr.document_id = d.id
  ORDER BY hpr.id DESC LIMIT 1)`;
const REVIEW_STATUS_SQL = `CASE
  WHEN EXISTS (
    SELECT 1 FROM ambiguities am
    WHERE am.document_id = d.id AND am.status IN ('open', 'watching', 'disputed')
  ) THEN 'ambiguous'
  WHEN (${HISTORICAL_REVIEW_STATUS_SQL}) IS NOT NULL THEN (${HISTORICAL_REVIEW_STATUS_SQL})
  WHEN EXISTS (
    SELECT 1 FROM forecasts f
    WHERE f.analysis_version_id = av.id AND f.status = 'verified'
  ) THEN 'verified'
  WHEN EXISTS (
    SELECT 1 FROM forecasts f
    WHERE f.analysis_version_id = av.id AND f.status = 'partially_verified'
  ) THEN 'partial'
  ELSE 'watching'
END`;

const LATEST_ANALYSIS_JOIN_SQL = `
  LEFT JOIN analysis_versions av ON av.id = (
    SELECT av2.id
    FROM analysis_versions av2
    WHERE av2.document_id = d.id AND av2.status = 'published'
    ORDER BY av2.version DESC, av2.id DESC
    LIMIT 1
  )
`;

function mapArticle(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    subtitle: row.subtitle,
    summary: row.summary,
    issuer: row.issuer,
    documentNumber: row.document_number,
    documentDate: row.document_date,
    category: row.category,
    status: row.status,
    importance: row.importance,
    importanceScore: row.importance,
    isFeatured: row.importance >= 5,
    originalUrl: row.original_url,
    sourceUrl: row.original_url,
    coverImage: row.cover_image,
    heroImage: row.cover_image,
    publishedAt: row.published_at,
    effectiveAt: row.effective_at,
    createdAt: row.created_at,
    familyId: row.family_id,
    familyTitle: row.family_title,
    familySlug: row.family_slug,
    source: row.source_name || row.issuer,
    sourceInfo: row.source_name ? {
      id: row.source_id,
      name: row.source_name,
      kind: row.source_kind,
      authorityLevel: row.authority_level,
      officialUrl: row.source_official_url
    } : undefined,
    analysisHeadline: row.analysis_headline || '',
    interpretation: row.interpretation || '',
    analysisVersion: row.analysis_version || null,
    analysisUpdatedAt: row.analysis_created_at || null,
    openAmbiguities: row.open_ambiguities ?? 0,
    forecastCount: row.forecast_count ?? 0,
    views: {
      total: Number(row.view_total || 0),
      today: Number(row.view_today || 0)
    },
    review: {
      status: reviewStatus(row),
      conclusion: row.review_conclusion || row.analysis_evidence_summary || '尚待更多公开证据验证。',
      verifiedAt: row.reviewed_at || row.analysis_created_at || row.published_at,
      confidence: row.historical_review_confidence != null
        ? `${Math.round(Number(row.historical_review_confidence) * 100)}%`
        : row.review_confidence || '中等'
    }
  };
}

function mapAnalysis(row) {
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.document_id,
    version: row.version,
    previousVersionId: row.previous_version_id,
    headline: row.headline,
    interpretation: row.interpretation,
    impact: row.impact,
    recommendations: row.recommendations,
    methodology: row.methodology,
    evidenceSummary: row.evidence_summary,
    modelName: row.model_name,
    promptVersion: row.prompt_version,
    status: row.status,
    createdAt: row.created_at
  };
}

function mapArticleNeighbor(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    publishedAt: row.published_at,
    heroImage: row.cover_image,
    source: row.source_name || row.issuer,
    sourceUrl: row.original_url
  };
}

function listCategories(db) {
  return db.prepare(`
    SELECT
      category,
      COUNT(*) AS article_count,
      MAX(published_at) AS latest_published_at
    FROM documents
    WHERE status <> 'draft'
    GROUP BY category
    ORDER BY article_count DESC, category COLLATE NOCASE
  `).all().map((row) => ({
    name: row.category,
    count: row.article_count,
    latestPublishedAt: row.latest_published_at
  }));
}

function archiveConditions(filters = {}) {
  const conditions = ["d.status <> 'draft'"];
  const params = [];
  if (filters.q) {
    const query = `%${escapeLike(filters.q)}%`;
    conditions.push(`(
      d.title LIKE ? ESCAPE '\\' OR
      d.subtitle LIKE ? ESCAPE '\\' OR
      d.summary LIKE ? ESCAPE '\\' OR
      d.issuer LIKE ? ESCAPE '\\' OR
      d.content_text LIKE ? ESCAPE '\\' OR
      av.headline LIKE ? ESCAPE '\\' OR
      av.interpretation LIKE ? ESCAPE '\\'
    )`);
    params.push(query, query, query, query, query, query, query);
  }
  if (filters.category) {
    conditions.push('d.category = ?');
    params.push(filters.category);
  }
  if (filters.fromYear) {
    conditions.push('CAST(substr(d.published_at, 1, 4) AS INTEGER) >= ?');
    params.push(filters.fromYear);
  }
  if (filters.toYear) {
    conditions.push('CAST(substr(d.published_at, 1, 4) AS INTEGER) <= ?');
    params.push(filters.toYear);
  }
  if (filters.reviewStatus) {
    conditions.push(`(${REVIEW_STATUS_SQL}) = ?`);
    params.push(filters.reviewStatus);
  }
  if (filters.hasForecast) {
    conditions.push(`EXISTS (
      SELECT 1 FROM forecasts f WHERE f.analysis_version_id = av.id
    )`);
  }
  return { conditions, params };
}

function getArchiveOverview(db, filters = {}) {
  const { conditions, params } = archiveConditions(filters);
  const rows = db.prepare(`
    SELECT
      CAST(substr(d.published_at, 1, 4) AS INTEGER) AS published_year,
      ${REVIEW_STATUS_SQL} AS review_status,
      COUNT(*) AS article_count
    FROM documents d
    ${LATEST_ANALYSIS_JOIN_SQL}
    WHERE ${conditions.join(' AND ')}
    GROUP BY published_year, review_status
    ORDER BY published_year, review_status
  `).all(...params);

  const byStatus = { verified: 0, partial: 0, ambiguous: 0, watching: 0 };
  const byDecade = new Map();
  let total = 0;
  let earliestYear = null;
  let latestYear = null;
  for (const row of rows) {
    const count = Number(row.article_count || 0);
    const year = Number(row.published_year);
    total += count;
    if (Object.hasOwn(byStatus, row.review_status)) byStatus[row.review_status] += count;
    if (Number.isInteger(year)) {
      earliestYear = earliestYear == null ? year : Math.min(earliestYear, year);
      latestYear = latestYear == null ? year : Math.max(latestYear, year);
      const decade = Math.floor(year / 10) * 10;
      byDecade.set(decade, (byDecade.get(decade) || 0) + count);
    }
  }

  return {
    total,
    byStatus,
    earliestYear,
    latestYear,
    requestedStartYear: filters.fromYear || 1949,
    requestedEndYear: filters.toYear || new Date().getFullYear(),
    byDecade: [...byDecade.entries()].map(([decade, count]) => ({ decade, count }))
  };
}

function listArticles(db, filters) {
  const conditions = [];
  const params = [];
  if (filters.q) {
    const query = `%${escapeLike(filters.q)}%`;
    conditions.push(`(
      d.title LIKE ? ESCAPE '\\' OR
      d.subtitle LIKE ? ESCAPE '\\' OR
      d.summary LIKE ? ESCAPE '\\' OR
      d.issuer LIKE ? ESCAPE '\\' OR
      d.content_text LIKE ? ESCAPE '\\' OR
      av.headline LIKE ? ESCAPE '\\' OR
      av.interpretation LIKE ? ESCAPE '\\'
    )`);
    params.push(query, query, query, query, query, query, query);
  }
  if (filters.category) {
    conditions.push('d.category = ?');
    params.push(filters.category);
  }
  if (filters.status) {
    conditions.push('d.status = ?');
    params.push(filters.status);
  } else {
    conditions.push("d.status <> 'draft'");
  }
  if (filters.fromYear) {
    conditions.push('CAST(substr(d.published_at, 1, 4) AS INTEGER) >= ?');
    params.push(filters.fromYear);
  }
  if (filters.toYear) {
    conditions.push('CAST(substr(d.published_at, 1, 4) AS INTEGER) <= ?');
    params.push(filters.toYear);
  }
  if (filters.reviewStatus) {
    conditions.push(`(${REVIEW_STATUS_SQL}) = ?`);
    params.push(filters.reviewStatus);
  }
  if (filters.hasForecast) {
    conditions.push(`EXISTS (
      SELECT 1 FROM forecasts f WHERE f.analysis_version_id = av.id
    )`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const joins = `
    LEFT JOIN policy_families pf ON pf.id = d.family_id
    JOIN sources s ON s.id = d.source_id
    ${LATEST_ANALYSIS_JOIN_SQL}
  `;

  const total = db.prepare(`
    SELECT COUNT(*) AS count
    FROM documents d
    ${joins}
    ${where}
  `).get(...params).count;

  const offset = (filters.page - 1) * filters.pageSize;
  const rows = db.prepare(`
    SELECT
      d.*,
      pf.title AS family_title,
      pf.slug AS family_slug,
      s.name AS source_name,
      s.kind AS source_kind,
      s.authority_level,
      s.official_url AS source_official_url,
      av.headline AS analysis_headline,
      av.interpretation,
      av.evidence_summary AS analysis_evidence_summary,
      av.version AS analysis_version,
      av.created_at AS analysis_created_at,
      (${HISTORICAL_REVIEW_STATUS_SQL}) AS historical_review_status,
      (SELECT hav.confidence
        FROM historical_public_releases hpr
        JOIN historical_analysis_versions hav ON hav.id = hpr.assessment_version_id
        WHERE hpr.document_id = d.id ORDER BY hpr.id DESC LIMIT 1) AS historical_review_confidence,
      (SELECT COUNT(*) FROM ambiguities am WHERE am.document_id = d.id AND am.status IN ('open', 'watching', 'disputed')) AS open_ambiguities,
      (SELECT COUNT(*) FROM forecasts f WHERE f.analysis_version_id = av.id) AS forecast_count,
      (SELECT COUNT(*) FROM forecasts f WHERE f.analysis_version_id = av.id AND f.status = 'verified') AS verified_forecasts,
      (SELECT COUNT(*) FROM forecasts f WHERE f.analysis_version_id = av.id AND f.status = 'partially_verified') AS partial_forecasts,
      (SELECT conclusion FROM assessment_snapshots ass WHERE ass.family_id = d.family_id ORDER BY ass.as_of_date DESC, ass.id DESC LIMIT 1) AS review_conclusion,
      (SELECT as_of_date FROM assessment_snapshots ass WHERE ass.family_id = d.family_id ORDER BY ass.as_of_date DESC, ass.id DESC LIMIT 1) AS reviewed_at,
      (SELECT COUNT(DISTINCT adv.visitor_hash) FROM article_daily_visitors adv WHERE adv.document_id = d.id) AS view_total,
      (SELECT COUNT(*) FROM article_daily_visitors adv WHERE adv.document_id = d.id AND adv.view_date = ${SHANGHAI_DATE_SQL}) AS view_today
    FROM documents d
    ${joins}
    ${where}
    ORDER BY ${ARTICLE_ORDER_SQL}
    LIMIT ? OFFSET ?
  `).all(...params, filters.pageSize, offset);

  return {
    articles: rows.map(mapArticle),
    total,
    page: filters.page,
    pageSize: filters.pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / filters.pageSize)
  };
}

function getArticleDetail(db, id) {
  const row = db.prepare(`
    SELECT
      d.*,
      pf.title AS family_title,
      pf.slug AS family_slug,
      s.name AS source_name,
      s.kind AS source_kind,
      s.authority_level,
      s.official_url AS source_official_url,
      (${HISTORICAL_REVIEW_STATUS_SQL}) AS historical_review_status,
      (SELECT hav.confidence
        FROM historical_public_releases hpr
        JOIN historical_analysis_versions hav ON hav.id = hpr.assessment_version_id
        WHERE hpr.document_id = d.id ORDER BY hpr.id DESC LIMIT 1) AS historical_review_confidence,
      (SELECT COUNT(DISTINCT adv.visitor_hash) FROM article_daily_visitors adv WHERE adv.document_id = d.id) AS view_total,
      (SELECT COUNT(*) FROM article_daily_visitors adv WHERE adv.document_id = d.id AND adv.view_date = ${SHANGHAI_DATE_SQL}) AS view_today
    FROM documents d
    LEFT JOIN policy_families pf ON pf.id = d.family_id
    JOIN sources s ON s.id = d.source_id
    WHERE d.id = ?
  `).get(id);
  if (!row) return null;

  const article = mapArticle(row);
  article.contentText = row.content_text;
  article.originalExcerpt = row.original_excerpt;
  article.checksum = row.checksum;
  article.fetchedAt = row.fetched_at;

  let neighbors = { previous: null, next: null };
  if (row.status !== 'draft') {
    const neighborIds = db.prepare(`
      WITH ordered_public AS (
        SELECT
          d.id,
          LAG(d.id) OVER (ORDER BY ${ARTICLE_ORDER_SQL}) AS previous_id,
          LEAD(d.id) OVER (ORDER BY ${ARTICLE_ORDER_SQL}) AS next_id
        FROM documents d
        WHERE d.status <> 'draft'
      )
      SELECT previous_id, next_id
      FROM ordered_public
      WHERE id = ?
    `).get(id);
    const neighborStatement = db.prepare(`
      SELECT
        d.id, d.title, d.published_at, d.cover_image, d.original_url,
        d.issuer, s.name AS source_name
      FROM documents d
      JOIN sources s ON s.id = d.source_id
      WHERE d.id = ? AND d.status <> 'draft'
    `);
    neighbors = {
      previous: neighborIds?.previous_id == null
        ? null
        : mapArticleNeighbor(neighborStatement.get(neighborIds.previous_id)),
      next: neighborIds?.next_id == null
        ? null
        : mapArticleNeighbor(neighborStatement.get(neighborIds.next_id))
    };
  }

  const analysisHistory = db.prepare(`
    SELECT * FROM analysis_versions
    WHERE document_id = ?
    ORDER BY version DESC, id DESC
  `).all(id).map(mapAnalysis);
  const currentAnalysis = analysisHistory.find((item) => item.status === 'published') || analysisHistory[0] || null;

  const signals = db.prepare(`
    SELECT * FROM policy_signals
    WHERE document_id = ?
    ORDER BY observed_at DESC, id DESC
  `).all(id).map((item) => ({
    id: item.id,
    kind: item.kind,
    label: item.label,
    value: item.value_text,
    unit: item.unit,
    period: item.period,
    evidenceQuote: item.evidence_quote,
    sourceUrl: item.source_url,
    observedAt: item.observed_at,
    confidence: item.confidence
  }));

  const forecasts = db.prepare(`
    SELECT f.*, av.version AS analysis_version
    FROM forecasts f
    JOIN analysis_versions av ON av.id = f.analysis_version_id
    WHERE av.document_id = ?
    ORDER BY av.version DESC, f.id
  `).all(id).map((item) => ({
    id: item.id,
    analysisVersionId: item.analysis_version_id,
    analysisVersion: item.analysis_version,
    statement: item.statement,
    basis: item.basis,
    expectedBy: item.expected_by,
    confidence: item.confidence,
    status: item.status,
    verificationNote: item.verification_note,
    resolvedAt: item.resolved_at,
    createdAt: item.created_at
  }));

  const ambiguities = db.prepare(`
    SELECT * FROM ambiguities
    WHERE document_id = ?
    ORDER BY CASE severity WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, detected_at DESC
  `).all(id).map((item) => ({
    id: item.id,
    analysisVersionId: item.analysis_version_id,
    title: item.title,
    description: item.description,
    severity: item.severity,
    status: item.status,
    resolutionNote: item.resolution_note,
    detectedAt: item.detected_at,
    resolvedAt: item.resolved_at
  }));

  const implementationEvents = row.family_id ? db.prepare(`
    SELECT * FROM implementation_events
    WHERE family_id = ? OR document_id = ?
    ORDER BY occurred_at DESC, id DESC
  `).all(row.family_id, id) : db.prepare(`
    SELECT * FROM implementation_events
    WHERE document_id = ?
    ORDER BY occurred_at DESC, id DESC
  `).all(id);

  const mappedEvents = implementationEvents.map((item) => ({
    id: item.id,
    familyId: item.family_id,
    documentId: item.document_id,
    title: item.title,
    eventType: item.event_type,
    eventTypeLabel: EVENT_TYPE_LABELS[item.event_type] || '公开证据',
    description: item.description,
    evidenceQuote: item.evidence_quote,
    sourceUrl: item.source_url,
    occurredAt: item.occurred_at,
    status: item.status
  }));

  const assessmentSnapshots = row.family_id ? db.prepare(`
    SELECT * FROM assessment_snapshots
    WHERE family_id = ?
    ORDER BY as_of_date DESC, id DESC
  `).all(row.family_id).map((item) => ({
    id: item.id,
    familyId: item.family_id,
    asOfDate: item.as_of_date,
    summary: item.summary,
    score: item.score,
    conclusion: item.conclusion,
    evidence: JSON.parse(item.evidence_json),
    createdAt: item.created_at
  })) : [];

  const historicalComparison = row.family_id ? db.prepare(`
    SELECT
      d.id, d.title, d.summary, d.issuer, d.category, d.status,
      d.importance, d.original_url, d.cover_image, d.published_at,
      d.effective_at, d.created_at, d.family_id,
      pf.title AS family_title, pf.slug AS family_slug,
      av.headline AS analysis_headline, av.interpretation,
      av.version AS analysis_version, av.created_at AS analysis_created_at
    FROM documents d
    JOIN policy_families pf ON pf.id = d.family_id
    LEFT JOIN analysis_versions av ON av.id = (
      SELECT av2.id FROM analysis_versions av2
      WHERE av2.document_id = d.id AND av2.status = 'published'
      ORDER BY av2.version DESC, av2.id DESC LIMIT 1
    )
    WHERE d.family_id = ? AND d.id <> ? AND d.published_at < ?
    ORDER BY d.published_at DESC, d.id DESC
    LIMIT 20
  `).all(row.family_id, id, row.published_at).map(mapArticle) : [];

  const latestSync = db.prepare(`
    SELECT status, started_at, completed_at, sources_checked,
           documents_found, documents_added, message
    FROM sync_runs ORDER BY id DESC LIMIT 1
  `).get() || null;

  const latestAssessment = assessmentSnapshots[0] || null;
  const currentForecasts = currentAnalysis
    ? forecasts.filter((item) => item.analysisVersionId === currentAnalysis.id)
    : [];
  const hasOpenAmbiguity = ambiguities.some((item) => ['open', 'watching', 'disputed'].includes(item.status));
  const hasVerifiedForecast = currentForecasts.some((item) => item.status === 'verified');
  const hasPartialForecast = currentForecasts.some((item) => item.status === 'partially_verified');
  article.review = {
    status: hasOpenAmbiguity
      ? 'ambiguous'
      : row.historical_review_status || (hasVerifiedForecast ? 'verified' : hasPartialForecast ? 'partial' : 'watching'),
    conclusion: latestAssessment?.conclusion || currentAnalysis?.evidenceSummary || '尚待更多公开证据验证。',
    verifiedAt: latestAssessment?.asOfDate || currentAnalysis?.createdAt || article.publishedAt,
    confidence: row.historical_review_confidence != null
      ? `${Math.round(Number(row.historical_review_confidence) * 100)}%`
      : latestAssessment?.score == null ? '待评估' : `${latestAssessment.score}/100`
  };
  article.analysisLead = currentAnalysis?.headline || article.summary;
  article.content = [
    { heading: '政策原文', paragraphs: [article.contentText] },
    ...(currentAnalysis ? [
      { heading: '解释', paragraphs: [currentAnalysis.interpretation, currentAnalysis.impact] },
      { heading: '建议', paragraphs: [currentAnalysis.recommendations] }
    ] : [])
  ];
  article.tags = [article.category, article.issuer, article.familyTitle].filter(Boolean);
  article.readTime = Math.max(3, Math.ceil((article.contentText.length + (currentAnalysis?.interpretation.length || 0)) / 450));
  article.comparisons = historicalComparison.slice(0, 4).map((previous) => ({
    dimension: '同脉络往期文件',
    previous: `${previous.title}：${previous.analysisHeadline || previous.summary}`,
    current: `${article.title}：${currentAnalysis?.headline || article.summary}`,
    implication: '自动主题归档只确认两份文件属于同一政策脉络，不据此作因果比较；具体变化需核对两份原文及后续执行证据。'
  }));
  article.evidence = [
    {
      date: article.publishedAt,
      title: '官方原文收录',
      description: article.originalExcerpt,
      status: 'confirmed',
      eventType: 'source_record',
      eventTypeLabel: '官方原文',
      source: article.source,
      sourceUrl: article.originalUrl
    },
    ...mappedEvents.map((event) => ({
      date: event.occurredAt,
      title: event.title,
      description: event.description,
      status: event.status,
      eventType: event.eventType,
      eventTypeLabel: event.eventTypeLabel,
      source: event.sourceUrl.includes('gov.cn') ? '中国政府网' : '公开信源',
      sourceUrl: event.sourceUrl
    }))
  ];
  article.ambiguities = ambiguities.map((item) => ({
    issue: item.title,
    why: item.description,
    nextEvidence: item.resolutionNote,
    severity: item.severity,
    status: item.status
  }));
  article.predictions = currentForecasts.map((item) => ({
    timeframe: item.expectedBy ? `截至 ${item.expectedBy}` : '后续观察',
    signal: item.statement,
    trigger: `${item.basis}${item.verificationNote ? ` 验证状态：${item.verificationNote}` : ''}`,
    confidence: `${Math.round(item.confidence * 100)}%`,
    status: item.status
  }));

  return {
    article,
    neighbors,
    currentAnalysis,
    analysisHistory,
    historicalComparison,
    signals,
    implementationEvents: mappedEvents,
    forecasts,
    ambiguities,
    assessmentSnapshots,
    evidence: {
      original: {
        excerpt: article.originalExcerpt,
        url: article.originalUrl,
        source: article.source
      },
      signals,
      implementationEvents: mappedEvents
    },
    latestSync: latestSync ? {
      status: latestSync.status,
      startedAt: latestSync.started_at,
      completedAt: latestSync.completed_at,
      sourcesChecked: latestSync.sources_checked,
      documentsFound: latestSync.documents_found,
      documentsAdded: latestSync.documents_added,
      message: latestSync.message
    } : null
  };
}

function getSiteViewStats(db) {
  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT visitor_hash) AS total,
      COUNT(DISTINCT CASE WHEN view_date = ${SHANGHAI_DATE_SQL} THEN visitor_hash END) AS today
    FROM site_daily_visitors
  `).get();
  return { total: Number(row.total), today: Number(row.today) };
}

function getArticleViewStats(db, articleId) {
  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT visitor_hash) AS total,
      COUNT(DISTINCT CASE WHEN view_date = ${SHANGHAI_DATE_SQL} THEN visitor_hash END) AS today
    FROM article_daily_visitors
    WHERE document_id = ?
  `).get(articleId);
  return { id: articleId, total: Number(row.total), today: Number(row.today) };
}

function recordView(db, visitorHash, articleId = null) {
  if (!/^[0-9a-f]{64}$/.test(visitorHash)) {
    throw new TypeError('visitorHash must be a lowercase SHA-256 digest');
  }
  if (articleId !== null && (!Number.isSafeInteger(articleId) || articleId < 1)) {
    throw new TypeError('articleId must be a positive integer or null');
  }

  return withTransaction(db, () => {
    if (articleId !== null) {
      const article = db.prepare(`
        SELECT id FROM documents WHERE id = ? AND status <> 'draft'
      `).get(articleId);
      if (!article) return null;
    }

    db.prepare(`
      INSERT OR IGNORE INTO site_daily_visitors (visitor_hash, view_date)
      VALUES (?, ${SHANGHAI_DATE_SQL})
    `).run(visitorHash);

    if (articleId !== null) {
      db.prepare(`
        INSERT OR IGNORE INTO article_daily_visitors (document_id, visitor_hash, view_date)
        VALUES (?, ?, ${SHANGHAI_DATE_SQL})
      `).run(articleId, visitorHash);
    }

    return {
      site: getSiteViewStats(db),
      ...(articleId === null ? {} : { article: getArticleViewStats(db, articleId) })
    };
  });
}

module.exports = {
  getArchiveOverview,
  getArticleDetail,
  getArticleViewStats,
  getSiteViewStats,
  listArticles,
  listCategories,
  recordView
};
