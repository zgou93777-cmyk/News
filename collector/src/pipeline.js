'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { buildRulesAnalysis, checksumFor, classifyCategory, importanceFor } = require('./analysis');
const {
  discoverDocumentLinks,
  discoverJsonFeedUrls,
  discoverStructuredDocumentLinks,
  extractDocument,
  fetchText
} = require('./content');
const { analyzeWithOptionalModel } = require('./model');
const { familyForCategory } = require('./lineage');
const { assessRelevance } = require('./relevance');
const { findAndCacheSourceImage } = require('./source-images');
const { findSource, loadSources, sourceForUrl } = require('./sources');
const { beginSyncRun, canonicalizeUrl, duplicateDecision, finishSyncRun, persistDocument } = require('./store');
const { sendNotification } = require('../../server/src/notifications');
const { seedDatabase } = require('../../server/src/seed');

function localSource(filename, issuer) {
  const url = pathToFileURL(path.resolve(filename)).href;
  return {
    id: 'local-input',
    name: '本地人工导入',
    institution: issuer || '',
    tier: 'P4',
    url,
    kind: 'local',
    authorityLevel: 'manual',
    enabled: true
  };
}

function fallbackHttpSource(url, issuer) {
  const parsed = new URL(url);
  return {
    id: `host-${parsed.hostname}`,
    name: parsed.hostname,
    institution: issuer || '',
    tier: 'P4',
    url: parsed.origin,
    kind: 'web',
    authorityLevel: 'unknown',
    enabled: true
  };
}

function chosenSource(sources, options, targetUrl) {
  if (options.sourceId) return findSource(sources, options.sourceId);
  if (targetUrl) return sourceForUrl(sources, targetUrl) || fallbackHttpSource(targetUrl, options.issuer);
  return localSource(options.file, options.issuer);
}

async function directInput(sources, options, dependencies) {
  if (options.rawContent !== undefined) {
    const source = options.source || chosenSource(sources, options, options.url);
    return [{
      raw: options.rawContent,
      contentType: options.contentType || 'text/plain',
      url: options.url,
      filename: options.file,
      source
    }];
  }
  if (options.file) {
    const filename = path.resolve(options.file);
    return [{
      raw: fs.readFileSync(filename, 'utf8'),
      contentType: options.contentType || (/\.html?$/i.test(filename) ? 'text/html' : 'text/plain'),
      filename,
      url: options.originalUrl || pathToFileURL(filename).href,
      source: chosenSource(sources, options, null)
    }];
  }
  const fetched = await (dependencies.fetchText || fetchText)(options.url, dependencies.fetchImpl, options.fetchTimeoutMs);
  return [{
    raw: fetched.body,
    contentType: fetched.contentType,
    url: fetched.finalUrl || options.url,
    source: chosenSource(sources, options, fetched.finalUrl || options.url)
  }];
}

async function scanInputs(sources, options, dependencies, result) {
  const targets = options.allSources
    ? sources.filter((source) => source.enabled)
    : [findSource(sources, options.sourceId)];
  const output = [];
  const sourceCandidates = [];
  const maximum = options.maxItems || 10;
  const currentYear = options.currentYear || new Date().getFullYear();
  for (const source of targets) {
    result.sourcesChecked += 1;
    try {
      const index = await (dependencies.fetchText || fetchText)(source.url, dependencies.fetchImpl, options.fetchTimeoutMs);
      const rejected = [];
      const discoveryOptions = {
        source,
        currentYear,
        onReject: (item) => rejected.push(item)
      };
      const indexUrl = index.finalUrl || source.url;
      let candidates = discoverDocumentLinks(index.body, indexUrl, maximum, discoveryOptions);
      for (const feedUrl of discoverJsonFeedUrls(index.body, indexUrl)) {
        try {
          const feed = await (dependencies.fetchText || fetchText)(feedUrl, dependencies.fetchImpl, options.fetchTimeoutMs);
          const structured = discoverStructuredDocumentLinks(feed.body, indexUrl, maximum, discoveryOptions);
          candidates.push(...structured);
        } catch (error) {
          result.warnings.push({
            source: source.id,
            url: feedUrl,
            message: `structured index skipped: ${error.message}`
          });
        }
      }
      candidates = [...new Map(candidates.map((candidate) => [candidate.url, candidate])).values()]
        .sort((left, right) => {
          if ((right.year || 0) !== (left.year || 0)) return (right.year || 0) - (left.year || 0);
          return right.score - left.score;
        })
        .slice(0, maximum);
      result.candidateLinksRejected += rejected.length;
      if (rejected.length > 0) {
        const counts = rejected.reduce((summary, item) => {
          summary[item.reason] = (summary[item.reason] || 0) + 1;
          return summary;
        }, {});
        result.warnings.push({
          source: source.id,
          url: source.url,
          message: `rejected ${rejected.length} candidate links before fetch`,
          reasons: counts
        });
      }
      if (candidates.length === 0) {
        result.warnings.push({ source: source.id, url: source.url, message: 'no candidate document links discovered' });
      }
      sourceCandidates.push({ source, candidates });
    } catch (error) {
      result.errors.push({ source: source.id, url: source.url, message: error.message });
    }
  }

  let candidateIndex = 0;
  while (output.length < maximum && sourceCandidates.some((entry) => candidateIndex < entry.candidates.length)) {
    for (const { source, candidates } of sourceCandidates) {
      if (output.length >= maximum) break;
      const candidate = candidates[candidateIndex];
      if (!candidate) continue;
      result.documentsFound += 1;
      try {
        const fetched = await (dependencies.fetchText || fetchText)(candidate.url, dependencies.fetchImpl, options.fetchTimeoutMs);
        output.push({
          raw: fetched.body,
          contentType: fetched.contentType,
          url: fetched.finalUrl || candidate.url,
          source,
          discoveredTitle: candidate.title
        });
      } catch (error) {
        result.errors.push({ source: source.id, url: candidate.url, message: error.message });
      }
    }
    candidateIndex += 1;
  }
  return output;
}

function publicArticleUrl(baseUrl, documentId) {
  if (!baseUrl) return '';
  return `${baseUrl.replace(/\/+$/, '')}/#/articles/${documentId}`;
}

async function acquireSourceCover(db, input, document, relevance, checksum, options, dependencies, result) {
  if (options.dryRun || !relevance.accepted || !String(input.contentType || '').includes('html')) return '';
  const decision = duplicateDecision(db, canonicalizeUrl(document.originalUrl), checksum);
  if (decision.documentId) {
    const existing = db.prepare('SELECT status, cover_image AS coverImage FROM documents WHERE id = ?')
      .get(decision.documentId);
    if (!existing || existing.status === 'draft' || String(existing.coverImage || '').trim()) return '';
  }
  try {
    const cache = dependencies.findAndCacheSourceImage || findAndCacheSourceImage;
    const cached = await cache(input.raw, document.originalUrl, {
      frontendDir: options.frontendDir,
      fetchImpl: dependencies.imageFetchImpl || dependencies.fetchImpl,
      lookupImpl: dependencies.lookupImpl,
      imageHosts: input.source.imageHosts || [],
      timeoutMs: options.fetchTimeoutMs
    });
    if (cached.coverImage) return cached.coverImage;
    if (cached.candidatesFound > 0 && cached.errors?.length) {
      result.warnings.push({
        source: input.source.id,
        url: document.originalUrl,
        stage: 'cover_download',
        message: `source cover skipped after ${cached.errors.length} failed candidate(s)`,
        errors: cached.errors
      });
    }
  } catch (error) {
    result.warnings.push({
      source: input.source.id,
      url: document.originalUrl,
      stage: 'cover_download',
      message: error.message
    });
  }
  return '';
}

async function processInput(db, input, options, dependencies, result) {
  const document = extractDocument(input.raw, {
    contentType: input.contentType,
    url: input.url,
    filename: input.filename,
    source: input.source,
    title: options.title,
    fallbackTitle: input.discoveredTitle,
    issuer: options.issuer,
    publishedAt: options.publishedAt,
    originalUrl: options.originalUrl
  });
  const relevance = assessRelevance(document, input.source);
  if (input.discoveredTitle && !relevance.accepted) {
    result.documentsSkipped += 1;
    result.items.push({
      title: document.title,
      url: document.originalUrl,
      publishedAt: document.publishedAt,
      action: 'skipped_irrelevant',
      relevance
    });
    result.warnings.push({
      source: input.source.id,
      url: document.originalUrl,
      message: 'fetched document failed policy relevance gate',
      relevance
    });
    return;
  }
  const fallbackAnalysis = buildRulesAnalysis(document, input.source);
  fallbackAnalysis.category = classifyCategory(document, options.category);
  const analyzed = await analyzeWithOptionalModel(document, fallbackAnalysis, options.analysisMode || 'auto', {
    modelConfig: options.modelConfig,
    fetchImpl: dependencies.modelFetchImpl || dependencies.fetchImpl,
    promptPath: options.promptPath,
    timeoutMs: options.modelTimeoutMs
  });
  if (analyzed.warning) result.warnings.push({ url: document.originalUrl, message: analyzed.warning });
  const checksum = checksumFor(document);
  const category = analyzed.analysis.category || fallbackAnalysis.category;
  const coverImage = await acquireSourceCover(
    db, input, document, relevance, checksum, options, dependencies, result
  );
  const item = {
    source: input.source,
    document,
    analysis: analyzed.analysis,
    category,
    importance: importanceFor(input.source, document),
    coverImage,
    checksum,
    family: options.familySlug ? {
      slug: options.familySlug,
      title: options.familyTitle,
      category,
      explicit: true
    } : familyForCategory(category)
  };

  let persistence;
  if (options.dryRun) {
    persistence = duplicateDecision(db, canonicalizeUrl(document.originalUrl), checksum);
    persistence = {
      ...persistence,
      action: persistence.action === 'insert' ? 'would_insert'
        : persistence.action === 'update' ? 'would_update'
          : persistence.action === 'hydrate' ? 'would_hydrate' : 'duplicate'
    };
  } else {
    persistence = persistDocument(db, item);
  }
  result.items.push({
    title: document.title,
    url: document.originalUrl,
    publishedAt: document.publishedAt,
    analysisMethod: analyzed.analysis.modelName,
    family: { slug: item.family.slug, title: item.family.title, explicit: item.family.explicit },
    relevance,
    ...persistence
  });

  if (['insert', 'update'].includes(persistence.action)) {
    result.documentsAdded += persistence.action === 'insert' ? 1 : 0;
    result.documentsUpdated += persistence.action === 'update' ? 1 : 0;
    if (options.notify !== false) {
      try {
        const notifier = dependencies.sendNotification || sendNotification;
        const notification = await notifier(db, options.notificationConfig, {
          title: persistence.action === 'insert' ? `新政策：${document.title}` : `政策更新：${document.title}`,
          body: analyzed.analysis.headline,
          url: publicArticleUrl(options.publicBaseUrl, persistence.documentId),
          articleId: persistence.documentId,
          tag: `policy-${persistence.documentId}`
        });
        result.notifications.push({ documentId: persistence.documentId, ...notification });
      } catch (error) {
        result.errors.push({ url: document.originalUrl, stage: 'notification', message: error.message });
      }
    }
  } else if (persistence.action === 'hydrate') {
    result.documentsHydrated += 1;
  }
}

function resultStatus(result) {
  if (result.errors.length === 0) return 'succeeded';
  if (result.items.length > 0) return 'partial';
  return 'failed';
}

async function runCollection(db, options = {}, dependencies = {}) {
  const sources = loadSources(options.sourcesFile);
  const result = {
    dryRun: Boolean(options.dryRun),
    status: 'running',
    sourcesChecked: 0,
    documentsFound: 0,
    documentsAdded: 0,
    documentsUpdated: 0,
    documentsHydrated: 0,
    documentsSkipped: 0,
    candidateLinksRejected: 0,
    items: [],
    notifications: [],
    warnings: [],
    errors: []
  };
  const syncRun = options.dryRun ? null : beginSyncRun(db);
  try {
    let inputs;
    if (options.url || options.file || options.rawContent !== undefined) {
      result.sourcesChecked = 1;
      result.documentsFound = 1;
      inputs = await directInput(sources, options, dependencies);
    } else {
      inputs = await scanInputs(sources, options, dependencies, result);
    }
    for (const input of inputs) {
      try {
        await processInput(db, input, options, dependencies, result);
      } catch (error) {
        result.errors.push({ url: input.url || input.filename || '', stage: 'analysis', message: error.message });
      }
    }
    result.status = resultStatus(result);
  } catch (error) {
    result.errors.push({ stage: 'pipeline', message: error.message });
    result.status = 'failed';
  } finally {
    if (syncRun) {
      finishSyncRun(db, syncRun, {
        ...result,
        message: `采集完成：新增 ${result.documentsAdded}，更新 ${result.documentsUpdated}，种子正文补全 ${result.documentsHydrated}，低相关跳过 ${result.documentsSkipped}，候选链接拒绝 ${result.candidateLinksRejected}，重复 ${result.items.filter((item) => item.action === 'duplicate').length}，错误 ${result.errors.length}。`,
        errorCode: result.errors.length ? 'COLLECTOR_PARTIAL' : ''
      });
    }
  }
  return result;
}

async function runSeedBackfill(db, options = {}, dependencies = {}) {
  const before = db.prepare('SELECT COUNT(*) AS count FROM documents').get().count;
  const seeded = seedDatabase(db);
  const after = db.prepare('SELECT COUNT(*) AS count FROM documents').get().count;
  const added = after - before;
  const result = {
    dryRun: Boolean(options.dryRun),
    status: 'succeeded',
    documentsAdded: added,
    documents: seeded.documents,
    message: `已复用审校种子框架；新增 ${added} 篇，现有 ${after} 篇。`
  };
  if (added > 0 && options.notify !== false && !options.dryRun) {
    const notifier = dependencies.sendNotification || sendNotification;
    result.notification = await notifier(db, options.notificationConfig, {
      title: '历史政策脉络已初始化',
      body: '已收录扩大内需长期纲要、提振消费专项行动和扩大消费“十五五”规划批复，并保留分析版本。',
      url: options.publicBaseUrl ? `${options.publicBaseUrl.replace(/\/+$/, '')}/` : '',
      tag: 'policy-backfill'
    });
  }
  return result;
}

module.exports = { acquireSourceCover, publicArticleUrl, runCollection, runSeedBackfill };
