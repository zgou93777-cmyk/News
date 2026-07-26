'use strict';

const { loadSources, sourceForUrl } = require('./sources');
const {
  assertSafeRemoteUrl,
  extractSourceImageCandidates,
  fetchSourcePage,
  findAndCacheSourceImage
} = require('./source-images');

function coverlessDocuments(db, maximum = 100) {
  return db.prepare(`
    SELECT id, title, original_url AS originalUrl, published_at AS publishedAt
    FROM documents
    WHERE status <> 'draft' AND trim(coalesce(cover_image, '')) = ''
    ORDER BY published_at DESC, importance DESC, id DESC
    LIMIT ?
  `).all(maximum);
}

async function runCoverBackfill(db, options = {}, dependencies = {}) {
  const maximum = options.maxItems || 100;
  const rows = coverlessDocuments(db, maximum);
  const result = {
    dryRun: !options.apply,
    status: 'succeeded',
    documentsChecked: rows.length,
    coversAdded: 0,
    coversAvailable: 0,
    items: [],
    warnings: []
  };
  const fetchPage = dependencies.fetchText;
  const cacheImage = dependencies.findAndCacheSourceImage || findAndCacheSourceImage;
  const sources = dependencies.sources || loadSources(options.sourcesFile);

  for (const row of rows) {
    try {
      assertSafeRemoteUrl(row.originalUrl);
      const fetched = fetchPage
        ? await fetchPage(row.originalUrl, dependencies.fetchImpl, options.fetchTimeoutMs)
        : await fetchSourcePage(row.originalUrl, {
          fetchImpl: dependencies.fetchImpl,
          lookupImpl: dependencies.lookupImpl,
          timeoutMs: options.fetchTimeoutMs
        });
      const pageUrl = fetched.finalUrl || row.originalUrl;
      const imageHosts = sourceForUrl(sources, pageUrl)?.imageHosts || [];
      const candidates = extractSourceImageCandidates(fetched.body, pageUrl, { imageHosts });
      if (candidates.length === 0) {
        result.items.push({ id: row.id, title: row.title, action: 'no_candidate' });
        continue;
      }
      result.coversAvailable += 1;
      if (!options.apply) {
        result.items.push({
          id: row.id,
          title: row.title,
          action: 'would_cache',
          candidateUrl: candidates[0].url,
          candidateSource: candidates[0].source
        });
        continue;
      }

      const cached = await cacheImage(fetched.body, pageUrl, {
        frontendDir: options.frontendDir,
        fetchImpl: dependencies.fetchImpl,
        lookupImpl: dependencies.lookupImpl,
        imageHosts,
        timeoutMs: options.fetchTimeoutMs
      });
      if (!cached.coverImage) {
        result.items.push({ id: row.id, title: row.title, action: 'download_failed' });
        for (const error of cached.errors || []) {
          result.warnings.push({ id: row.id, url: error.url, stage: 'cover_download', message: error.message });
        }
        continue;
      }
      const update = db.prepare(`
        UPDATE documents SET cover_image = ?
        WHERE id = ? AND status <> 'draft' AND trim(coalesce(cover_image, '')) = ''
      `).run(cached.coverImage, row.id);
      const action = update.changes > 0 ? 'cached' : 'skipped_existing';
      if (action === 'cached') result.coversAdded += 1;
      result.items.push({
        id: row.id,
        title: row.title,
        action,
        coverImage: cached.coverImage,
        sourceUrl: cached.sourceUrl
      });
    } catch (error) {
      result.items.push({ id: row.id, title: row.title, action: 'failed' });
      result.warnings.push({ id: row.id, url: row.originalUrl, stage: 'cover_backfill', message: error.message });
    }
  }
  return result;
}

module.exports = { coverlessDocuments, runCoverBackfill };
