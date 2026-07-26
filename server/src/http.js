'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { getSchemaVersion } = require('./db');
const {
  getArchiveOverview,
  getArticleDetail,
  listArticles,
  listCategories,
  recordView
} = require('./repository');

const DOCUMENT_STATUSES = new Set(['draft', 'published', 'effective', 'superseded', 'expired']);
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2']
]);

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function applySecurityHeaders(res, requestId) {
  res.setHeader('X-Request-Id', requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self' https://unpkg.com; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'"
  );
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function sendError(res, error, requestId) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof HttpError ? error.message : '服务器处理请求时发生错误';
  const payload = { error: { code, message, requestId } };
  if (error instanceof HttpError && error.details !== undefined) {
    payload.error.details = error.details;
  }
  sendJson(res, status, payload);
}

function singleQueryValue(searchParams, name) {
  const values = searchParams.getAll(name);
  if (values.length > 1) {
    throw new HttpError(400, 'INVALID_QUERY', `${name} 只能提供一次`);
  }
  return values[0] ?? '';
}

function parsePositiveInteger(value, name, fallback, maximum) {
  if (value === '') return fallback;
  if (!/^\d+$/.test(value)) {
    throw new HttpError(400, 'INVALID_QUERY', `${name} 必须是正整数`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new HttpError(400, 'INVALID_QUERY', `${name} 必须在 1 到 ${maximum} 之间`);
  }
  return parsed;
}

function parseArchiveYear(value, name, fallback = null) {
  if (value === '') return fallback;
  if (!/^\d{4}$/.test(value)) {
    throw new HttpError(400, 'INVALID_QUERY', `${name} 必须是四位年份`);
  }
  const parsed = Number(value);
  const maximum = new Date().getFullYear() + 1;
  if (!Number.isSafeInteger(parsed) || parsed < 1949 || parsed > maximum) {
    throw new HttpError(400, 'INVALID_QUERY', `${name} 必须在 1949 到 ${maximum} 之间`);
  }
  return parsed;
}

function parseArticleFilters(searchParams) {
  const q = singleQueryValue(searchParams, 'q').trim();
  const category = singleQueryValue(searchParams, 'category').trim();
  const status = singleQueryValue(searchParams, 'status').trim();
  const reviewStatus = singleQueryValue(searchParams, 'reviewStatus').trim();
  const hasForecastValue = singleQueryValue(searchParams, 'hasForecast').trim();
  const fromYear = parseArchiveYear(singleQueryValue(searchParams, 'fromYear'), 'fromYear');
  const toYear = parseArchiveYear(singleQueryValue(searchParams, 'toYear'), 'toYear');
  const page = parsePositiveInteger(singleQueryValue(searchParams, 'page'), 'page', 1, 1_000_000);
  const requestedPageSize = singleQueryValue(searchParams, 'pageSize') || singleQueryValue(searchParams, 'limit');
  const pageSize = parsePositiveInteger(requestedPageSize, 'pageSize', 12, 50);

  if (q.length > 100 || /[\u0000-\u001f]/.test(q)) {
    throw new HttpError(400, 'INVALID_QUERY', 'q 最长为100个字符且不能包含控制字符');
  }
  if (category.length > 80 || /[\u0000-\u001f]/.test(category)) {
    throw new HttpError(400, 'INVALID_QUERY', 'category 格式无效');
  }
  if (status && !DOCUMENT_STATUSES.has(status)) {
    throw new HttpError(400, 'INVALID_QUERY', 'status 不是受支持的文档状态');
  }
  if (reviewStatus && !new Set(['verified', 'partial', 'ambiguous', 'watching']).has(reviewStatus)) {
    throw new HttpError(400, 'INVALID_QUERY', 'reviewStatus 不是受支持的复盘状态');
  }
  if (hasForecastValue && !['1', 'true'].includes(hasForecastValue)) {
    throw new HttpError(400, 'INVALID_QUERY', 'hasForecast 只支持 1 或 true');
  }
  if (fromYear && toYear && fromYear > toYear) {
    throw new HttpError(400, 'INVALID_QUERY', 'fromYear 不能晚于 toYear');
  }
  return {
    q,
    category,
    status,
    reviewStatus,
    fromYear,
    toYear,
    hasForecast: Boolean(hasForecastValue),
    page,
    pageSize
  };
}

function readJsonBody(req, maxBodyBytes) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请求体必须使用 application/json');
  }
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new HttpError(413, 'BODY_TOO_LARGE', `请求体不能超过 ${maxBodyBytes} 字节`);
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        settled = true;
        reject(new HttpError(413, 'BODY_TOO_LARGE', `请求体不能超过 ${maxBodyBytes} 字节`));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (bytes === 0) {
        reject(new HttpError(400, 'EMPTY_BODY', '请求体不能为空'));
        return;
      }
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('body must be an object');
        }
        resolve(value);
      } catch {
        reject(new HttpError(400, 'INVALID_JSON', '请求体不是有效的 JSON 对象'));
      }
    });
    req.on('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

function validatePushSubscription(value) {
  if (value.subscription && typeof value.subscription === 'object' && !Array.isArray(value.subscription)) {
    value = value.subscription;
  }
  const endpoint = typeof value.endpoint === 'string' ? value.endpoint.trim() : '';
  if (!endpoint || endpoint.length > 4096) {
    throw new HttpError(400, 'INVALID_SUBSCRIPTION', 'endpoint 缺失或过长');
  }
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new HttpError(400, 'INVALID_SUBSCRIPTION', 'endpoint 必须是有效 URL');
  }
  if (endpointUrl.protocol !== 'https:') {
    throw new HttpError(400, 'INVALID_SUBSCRIPTION', 'endpoint 必须使用 HTTPS');
  }

  const keys = value.keys;
  const p256dh = keys && typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = keys && typeof keys.auth === 'string' ? keys.auth.trim() : '';
  const base64UrlPattern = /^[A-Za-z0-9_-]+={0,2}$/;
  if (p256dh.length < 20 || p256dh.length > 512 || !base64UrlPattern.test(p256dh)) {
    throw new HttpError(400, 'INVALID_SUBSCRIPTION', 'p256dh 格式无效');
  }
  if (auth.length < 8 || auth.length > 256 || !base64UrlPattern.test(auth)) {
    throw new HttpError(400, 'INVALID_SUBSCRIPTION', 'auth 格式无效');
  }

  let expirationTime = null;
  if (value.expirationTime !== null && value.expirationTime !== undefined) {
    expirationTime = Number(value.expirationTime);
    if (!Number.isSafeInteger(expirationTime) || expirationTime < 0) {
      throw new HttpError(400, 'INVALID_SUBSCRIPTION', 'expirationTime 格式无效');
    }
  }
  return { endpoint, p256dh, auth, expirationTime };
}

function validateViewRequest(value) {
  const visitorId = typeof value.visitorId === 'string' ? value.visitorId : '';
  if (visitorId.length < 16 || visitorId.length > 128 || !/^[\x21-\x7e]+$/.test(visitorId)) {
    throw new HttpError(400, 'INVALID_VISITOR_ID', 'visitorId 必须是 16 至 128 个可打印 ASCII 字符');
  }

  let articleId = null;
  if (Object.prototype.hasOwnProperty.call(value, 'articleId')) {
    articleId = value.articleId;
    if (!Number.isSafeInteger(articleId) || articleId < 1) {
      throw new HttpError(400, 'INVALID_ARTICLE_ID', '文章 ID 格式无效');
    }
  }

  return { visitorId, articleId };
}

function upsertSubscription(db, subscription, userAgent) {
  const existed = Boolean(db.prepare('SELECT 1 FROM push_subscriptions WHERE endpoint = ?').get(subscription.endpoint));
  db.prepare(`
    INSERT INTO push_subscriptions (
      endpoint, p256dh, auth, expiration_time, user_agent
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      expiration_time = excluded.expiration_time,
      user_agent = excluded.user_agent,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).run(
    subscription.endpoint,
    subscription.p256dh,
    subscription.auth,
    subscription.expirationTime,
    String(userAgent || '').slice(0, 512)
  );
  return !existed;
}

async function routeApi(req, res, url, context) {
  const { db, config } = context;
  if (req.method === 'GET' && url.pathname === '/api/health') {
    db.prepare('SELECT 1 AS healthy').get();
    const latestSync = db.prepare(`
      SELECT status, started_at, completed_at FROM sync_runs
      ORDER BY id DESC LIMIT 1
    `).get() || null;
    const historicalRows = db.prepare(`
      SELECT stage, count(*) AS count
      FROM historical_backfill_items GROUP BY stage ORDER BY stage
    `).all();
    const historicalIntegrity = db.prepare(`
      SELECT
        count(*) FILTER (WHERE item.stage = 'ready') AS ready,
        count(*) FILTER (WHERE item.stage = 'published') AS published,
        count(*) FILTER (
          WHERE item.stage IN ('ready', 'published') AND NOT EXISTS (
            SELECT 1 FROM historical_analysis_versions assessment
            WHERE assessment.id = CAST(json_extract(item.analysis_json, '$.assessmentVersionId') AS INTEGER)
              AND assessment.item_id = item.id AND assessment.release_eligible = 1
              AND assessment.confidence >= 0.95
              AND assessment.methodology IN ('historical-evidence-gates-v2', 'human-review-v1')
              AND assessment.version = CAST(json_extract(item.analysis_json, '$.assessmentVersion') AS INTEGER)
              AND assessment.review_status = json_extract(item.analysis_json, '$.reviewStatus')
              AND assessment.confidence = CAST(json_extract(item.analysis_json, '$.confidence') AS REAL)
              AND assessment.methodology = json_extract(item.analysis_json, '$.methodology')
              AND json_extract(item.analysis_json, '$.gates') = assessment.gates_json
              AND json_array_length(assessment.gates_json) > 0
              AND NOT EXISTS (
                SELECT 1 FROM json_each(assessment.gates_json) gate
                WHERE json_extract(gate.value, '$.passed') IS NOT 1
              )
          )
        ) AS assessment_violations,
        count(*) FILTER (
          WHERE item.stage IN ('ready', 'published') AND EXISTS (
            SELECT 1
            FROM historical_policy_evidence evidence
            LEFT JOIN historical_backfill_items source ON source.id = evidence.source_item_id
            WHERE evidence.item_id = item.id AND evidence.classification = 'accepted'
              AND (
                source.id IS NULL OR source.source_status <> 'verified'
                OR source.metadata_status <> 'verified'
                OR source.source_url <> evidence.source_url
                OR source.published_at <> evidence.observed_at
                OR trim(source.checksum) = ''
                OR instr(source.content_text, evidence.evidence_quote) = 0
              )
          )
        ) AS evidence_source_violations,
        count(*) FILTER (
          WHERE item.stage = 'published' AND NOT EXISTS (
            SELECT 1 FROM historical_public_releases release
            WHERE release.item_id = item.id AND release.document_id = item.document_id
          )
        ) AS release_violations
      FROM historical_backfill_items item
    `).get();
    const historicalRollout = db.prepare(`
      SELECT control.mode, control.active_cohort_id, cohort.status AS cohort_status,
        cohort.target_size,
        (SELECT count(*) FROM historical_release_cohort_items item
          WHERE item.cohort_id = cohort.id) AS cohort_items
      FROM historical_release_control control
      LEFT JOIN historical_release_cohorts cohort ON cohort.id = control.active_cohort_id
      WHERE control.id = 1
    `).get();
    sendJson(res, 200, {
      status: 'ok',
      database: 'ok',
      schemaVersion: getSchemaVersion(db),
      pushEnabled: Boolean(config.vapidPublicKey && config.vapidPrivateKey && config.vapidSubject),
      latestSync: latestSync ? {
        status: latestSync.status,
        startedAt: latestSync.started_at,
        completedAt: latestSync.completed_at
      } : null,
      historical: {
        byStage: Object.fromEntries(historicalRows.map((row) => [row.stage, Number(row.count)])),
        ready: Number(historicalIntegrity.ready),
        published: Number(historicalIntegrity.published),
        rollout: {
          mode: historicalRollout.mode,
          activeCohortId: historicalRollout.active_cohort_id == null
            ? null : Number(historicalRollout.active_cohort_id),
          cohortStatus: historicalRollout.cohort_status || null,
          targetSize: historicalRollout.target_size == null ? null : Number(historicalRollout.target_size),
          cohortItems: Number(historicalRollout.cohort_items || 0)
        },
        integrityOk: Number(historicalIntegrity.assessment_violations) === 0
          && Number(historicalIntegrity.evidence_source_violations) === 0
          && Number(historicalIntegrity.release_violations) === 0
      },
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/categories') {
    sendJson(res, 200, { data: listCategories(db) });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/archive-overview') {
    const filters = parseArticleFilters(url.searchParams);
    sendJson(res, 200, { data: getArchiveOverview(db, filters) });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/articles') {
    const result = listArticles(db, parseArticleFilters(url.searchParams));
    sendJson(res, 200, {
      data: result.articles,
      pagination: {
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
        totalPages: result.totalPages
      }
    });
    return true;
  }

  const articleMatch = url.pathname.match(/^\/api\/articles\/(\d+)$/);
  if (req.method === 'GET' && articleMatch) {
    const id = Number(articleMatch[1]);
    if (!Number.isSafeInteger(id) || id < 1) {
      throw new HttpError(400, 'INVALID_ARTICLE_ID', '文章 ID 格式无效');
    }
    const detail = getArticleDetail(db, id);
    if (!detail) throw new HttpError(404, 'ARTICLE_NOT_FOUND', '未找到该政策文章');
    sendJson(res, 200, { data: detail });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/views') {
    const body = await readJsonBody(req, config.maxBodyBytes);
    const { visitorId, articleId } = validateViewRequest(body);
    const visitorHash = crypto.createHash('sha256').update(visitorId, 'utf8').digest('hex');
    const views = recordView(db, visitorHash, articleId);
    if (!views) throw new HttpError(404, 'ARTICLE_NOT_FOUND', '未找到该政策文章');
    sendJson(res, 200, views);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/push/public-key') {
    sendJson(res, 200, {
      data: {
        enabled: Boolean(config.vapidPublicKey && config.vapidPrivateKey && config.vapidSubject),
        publicKey: config.vapidPublicKey || null
      }
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/push/subscribe') {
    if (!config.vapidPublicKey || !config.vapidPrivateKey || !config.vapidSubject) {
      throw new HttpError(503, 'PUSH_NOT_CONFIGURED', '服务器尚未配置网页推送');
    }
    const body = await readJsonBody(req, config.maxBodyBytes);
    const created = upsertSubscription(db, validatePushSubscription(body), req.headers['user-agent']);
    sendJson(res, created ? 201 : 200, { data: { subscribed: true, created } });
    return true;
  }

  if (req.method === 'DELETE' && url.pathname === '/api/push/subscribe') {
    let endpoint = singleQueryValue(url.searchParams, 'endpoint').trim();
    if (!endpoint) {
      const body = await readJsonBody(req, config.maxBodyBytes);
      endpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    }
    if (!endpoint || endpoint.length > 4096) {
      throw new HttpError(400, 'INVALID_SUBSCRIPTION', 'endpoint 缺失或过长');
    }
    const result = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
    sendJson(res, 200, { data: { subscribed: false, deleted: result.changes > 0 } });
    return true;
  }

  if (url.pathname.startsWith('/api/')) {
    if (['GET', 'POST', 'DELETE'].includes(req.method)) {
      throw new HttpError(404, 'API_NOT_FOUND', '接口不存在');
    }
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '请求方法不受支持');
  }
  return false;
}

function etagFor(stat) {
  return `W/\"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}\"`;
}

async function serveStatic(req, res, url, frontendDir) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', '静态资源只支持 GET 和 HEAD');
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'INVALID_PATH', 'URL 路径编码无效');
  }
  if (decodedPath.includes('\0')) throw new HttpError(400, 'INVALID_PATH', 'URL 路径无效');

  const root = path.resolve(frontendDir);
  const relativePath = decodedPath.replace(/^\/+/, '') || 'index.html';
  let filePath = path.resolve(root, relativePath);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    throw new HttpError(403, 'PATH_FORBIDDEN', '禁止访问该路径');
  }

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = await fs.promises.stat(filePath);
    }
  } catch (error) {
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    const hasExtension = path.extname(relativePath) !== '';
    if ((error.code === 'ENOENT' || error.code === 'ENOTDIR') && wantsHtml && !hasExtension) {
      filePath = path.join(root, 'index.html');
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        throw new HttpError(404, 'STATIC_NOT_FOUND', '前端页面尚未构建');
      }
    } else if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new HttpError(404, 'STATIC_NOT_FOUND', '静态资源不存在');
    } else {
      throw error;
    }
  }
  if (!stat.isFile()) throw new HttpError(404, 'STATIC_NOT_FOUND', '静态资源不存在');

  const etag = etagFor(stat);
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }
  const extension = path.extname(filePath).toLowerCase();
  const isHtml = extension === '.html';
  const isServiceWorker = path.basename(filePath) === 'sw.js';
  const headers = {
    'Content-Type': MIME_TYPES.get(extension) || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': isHtml || isServiceWorker ? 'no-cache' : 'public, max-age=86400'
  };
  if (isServiceWorker) headers['Service-Worker-Allowed'] = '/';
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
}

function createHttpServer({ db, config }) {
  if (!db || !config) throw new TypeError('db and config are required');
  const server = http.createServer(async (req, res) => {
    const requestId = crypto.randomUUID();
    applySecurityHeaders(res, requestId);
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const handled = await routeApi(req, res, url, { db, config });
      if (!handled) await serveStatic(req, res, url, config.frontendDir);
    } catch (error) {
      if (!res.headersSent) sendError(res, error, requestId);
      else res.destroy(error);
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;
  server.on('clientError', (error, socket) => {
    if (error.code === 'ECONNRESET' || !socket.writable) return;
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  return server;
}

module.exports = { HttpError, createHttpServer, readJsonBody };
