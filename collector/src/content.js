'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { assessRelevance } = require('./relevance');

const ENTITY_MAP = new Map([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
  ['nbsp', ' '], ['ensp', ' '], ['emsp', ' '], ['hellip', '...'],
  ['mdash', '-'], ['ndash', '-'], ['middot', '·'], ['ldquo', '“'],
  ['rdquo', '”'], ['lsquo', '‘'], ['rsquo', '’']
]);

function decodeEntities(value) {
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, token) => {
    if (token[0] === '#') {
      const radix = token[1]?.toLowerCase() === 'x' ? 16 : 10;
      const digits = radix === 16 ? token.slice(2) : token.slice(1);
      const codePoint = Number.parseInt(digits, radix);
      if (Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        return String.fromCodePoint(codePoint);
      }
      return match;
    }
    return ENTITY_MAP.get(token.toLowerCase()) ?? match;
  });
}

function stripTags(value) {
  return decodeEntities(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/[\t\r ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

function htmlToText(html) {
  const withoutNoise = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|main|li|h[1-6]|tr)>/gi, '\n');
  return decodeEntities(withoutNoise.replace(/<[^>]*>/g, ' '))
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseAttributes(tag) {
  const attributes = {};
  const pattern = /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = pattern.exec(tag))) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function extractMeta(html) {
  const values = new Map();
  for (const match of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    const key = String(attributes.name || attributes.property || attributes.itemprop || '').toLowerCase();
    if (key && attributes.content && !values.has(key)) values.set(key, attributes.content.trim());
  }
  return values;
}

function extractElementInnerHtmlById(html, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const opening = new RegExp(`<([a-z][\\w:-]*)\\b[^>]*\\bid\\s*=\\s*["']${escapedId}["'][^>]*>`, 'i').exec(html);
  if (!opening) return '';
  const tagName = opening[1];
  const tagPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tagPattern.lastIndex = opening.index + opening[0].length;
  let depth = 1;
  let match;
  while ((match = tagPattern.exec(html))) {
    if (/^<\//.test(match[0])) depth -= 1;
    else if (!/\/>$/.test(match[0])) depth += 1;
    if (depth === 0) return html.slice(opening.index + opening[0].length, match.index);
  }
  return '';
}

function preferredBodyHtml(html) {
  for (const id of ['UCAP-CONTENT', 'article-content', 'content']) {
    const content = extractElementInnerHtmlById(html, id);
    const minimum = id === 'UCAP-CONTENT' ? 20 : 100;
    if (content && stripTags(content).length >= minimum) return content;
  }
  return html;
}

function firstMatch(value, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(value);
    if (match?.[1]) return stripTags(match[1]);
  }
  return '';
}

function normalizePublishedAt(value) {
  if (!value) return '';
  const match = String(value).match(/(20\d{2})\s*(?:年|[-/.])\s*(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})\s*日?/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return '';
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00:00+08:00`;
}

function extractPublishedAt(meta, text, override) {
  if (override) {
    const normalized = normalizePublishedAt(override);
    if (!normalized) throw new Error(`invalid --published-at date: ${override}`);
    return normalized;
  }
  for (const label of ['发布日期', '发布时间', '发布于', '发文日期']) {
    const labelled = text.match(new RegExp(`${label}\\s*[：:]?\\s*((?:20\\d{2})\\s*(?:年|[-/.])\\s*\\d{1,2}\\s*(?:月|[-/.])\\s*\\d{1,2}\\s*日?)`));
    if (labelled) return normalizePublishedAt(labelled[1]);
  }
  for (const key of ['pubdate', 'publishdate', 'article:published_time', 'date', 'created']) {
    const normalized = normalizePublishedAt(meta.get(key));
    if (normalized) return normalized;
  }
  const generic = text.match(/((?:20\d{2})\s*(?:年|[-/.])\s*\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}\s*日?)/);
  return normalizePublishedAt(generic?.[1]);
}

function cleanSiteTitle(value, sourceUrl) {
  let title = String(value || '').trim();
  try {
    if (new URL(sourceUrl).hostname === 'www.gov.cn') {
      title = title.replace(/(?:_[^_]{1,16})?_中国政府网$/, '');
    }
  } catch {
    // A URL validity error is reported later with the original URL field.
  }
  return title.trim();
}

function summarize(text, maximum = 180) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const sentences = compact.split(/(?<=[。！？!?；;])/).filter(Boolean);
  let result = '';
  for (const sentence of sentences) {
    if (result && result.length + sentence.length > maximum) break;
    result += sentence;
    if (result.length >= 80) break;
  }
  if (!result) result = compact.slice(0, maximum);
  return result.length > maximum ? `${result.slice(0, maximum - 3)}...` : result;
}

function extractIssuer(pageText) {
  for (const label of ['发文机关', '发布机构', '来源']) {
    const match = pageText.match(new RegExp(`${label}\\s*[：:]\\s*([^\\n]{2,120})`));
    if (match?.[1] && isPlausibleIssuer(match[1])) return match[1].trim();
  }
  return '';
}

function isPlausibleIssuer(value) {
  const issuer = String(value || '').replace(/\s+/g, ' ').trim();
  if (issuer.length < 2 || issuer.length > 100) return false;
  if (/^(?:20\d{2}[年\-/.]|\d{1,2}:\d{2})/.test(issuer)) return false;
  if (/^(?:发布日期|发布时间|成文日期|日期|字号|打印|收藏|返回)/.test(issuer)) return false;
  return /[\p{Script=Han}A-Za-z]/u.test(issuer);
}

function extractDocument(raw, options = {}) {
  const isHtml = options.contentType?.includes('html') || /<(?:html|head|body|article|h1)\b/i.test(raw);
  const meta = isHtml ? extractMeta(raw) : new Map();
  const pageText = (isHtml ? htmlToText(raw) : String(raw || '').replace(/\r\n?/g, '\n')).trim();
  const text = (isHtml ? htmlToText(preferredBodyHtml(raw)) : pageText).trim();
  if (text.length < 20) throw new Error('document text is too short to analyze');

  const htmlTitle = isHtml ? firstMatch(raw, [/<h1\b[^>]*>([\s\S]*?)<\/h1>/i, /<title\b[^>]*>([\s\S]*?)<\/title>/i]) : '';
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length >= 4 && line.length <= 160) || '';
  const title = cleanSiteTitle(
    options.title || meta.get('articletitle') || meta.get('og:title') || htmlTitle || options.fallbackTitle || firstLine,
    options.originalUrl || options.url || ''
  );
  if (!title) throw new Error('could not determine title; provide --title');

  const publishedAt = extractPublishedAt(meta, pageText, options.publishedAt);
  if (!publishedAt) throw new Error('could not determine publication date; provide --published-at');
  const issuerCandidates = [
    options.issuer,
    extractIssuer(pageText),
    meta.get('source'),
    meta.get('author'),
    options.source?.institution
  ];
  const issuer = String(issuerCandidates.find(isPlausibleIssuer) || '').trim();
  if (!issuer) throw new Error('could not determine issuer; provide --issuer or --source');

  const sourceUrl = options.originalUrl || options.url || (options.filename ? pathToFileURL(path.resolve(options.filename)).href : '');
  if (!sourceUrl) throw new Error('could not determine original URL');

  return {
    title: title.slice(0, 300),
    issuer: issuer.slice(0, 160),
    publishedAt,
    originalUrl: sourceUrl,
    contentText: text.slice(0, 500_000),
    summary: summarize(text),
    originalExcerpt: summarize(text, 320)
  };
}

function normalizeCharset(value) {
  const charset = String(value || '').trim().toLowerCase();
  if (['gbk', 'gb2312', 'gb18030'].includes(charset)) return 'gb18030';
  if (charset === 'utf8') return 'utf-8';
  return charset || 'utf-8';
}

function decodeResponseBody(buffer, contentType = '') {
  const headerMatch = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  const asciiHead = Buffer.from(buffer).subarray(0, 4096).toString('latin1');
  const metaMatch = asciiHead.match(/charset\s*=\s*["']?([^;"'\s/>]+)/i);
  const charset = normalizeCharset(headerMatch?.[1] || metaMatch?.[1]);
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

async function fetchText(url, fetchImpl = fetch, timeoutMs = 20_000) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'text/html, text/plain, application/json;q=0.8, */*;q=0.1',
      'User-Agent': 'PolicyMonitor/1.0 (+official-policy-archive)'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} while fetching ${url}`);
  const contentType = response.headers.get('content-type') || '';
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > 5 * 1024 * 1024) {
    throw new Error('document exceeds 5 MiB fetch limit');
  }
  if (/application\/(?:pdf|zip|octet-stream)/i.test(contentType)) {
    throw new Error(`unsupported non-text content type: ${contentType}`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > 5 * 1024 * 1024) throw new Error('document exceeds 5 MiB fetch limit');
  return {
    body: decodeResponseBody(buffer, contentType),
    contentType,
    finalUrl: response.url || url
  };
}

function safeDecodedHref(href) {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function isSafeDocumentHref(href) {
  const value = safeDecodedHref(String(href || '').trim());
  if (!value || /[\u0000-\u0020]/.test(value)) return false;
  if (/['"`{}\[\]\\]/.test(value) || value.includes('+')) return false;
  if (/\$\{|(?:listArr|href|url)\s*[[(.]|(?:javascript|mailto|tel):/i.test(value)) return false;
  return true;
}

function comparableUrl(value) {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  return url.href.replace(/\/+$/, '');
}

function candidateYear(url, title) {
  const pathYears = [];
  for (const segment of url.pathname.split('/').filter(Boolean)) {
    const direct = segment.match(/^(20\d{2})(?:[-_]?\d{2}(?:[-_]?\d{2})?)?$/);
    const datedFilename = segment.match(/^t(20\d{2})\d{4}[_-]/i);
    if (direct) pathYears.push(Number(direct[1]));
    else if (datedFilename) pathYears.push(Number(datedFilename[1]));
  }
  if (pathYears.length) return Math.max(...pathYears);
  const titleYears = [...String(title || '').matchAll(/20\d{2}/g)].map((match) => Number(match[0]));
  return titleYears.length ? Math.max(...titleYears) : null;
}

function assessCandidatePath(url, baseUrl, source = {}, currentYear = new Date().getFullYear()) {
  const base = new URL(baseUrl);
  if (comparableUrl(url) === comparableUrl(base)) return { accepted: false, reason: 'source_listing' };
  const pathname = url.pathname.toLowerCase();
  const basePath = base.pathname.toLowerCase();
  if (/\/(?:home|search|english)(?:\/|$)/.test(pathname)) return { accepted: false, reason: 'template_or_home_path' };
  if (/\.(?:jpg|jpeg|png|gif|svg|css|js|zip|rar|docx?|xlsx?|pptx?)$/i.test(pathname)) {
    return { accepted: false, reason: 'non_html_asset' };
  }
  if (pathname.endsWith('/')) return { accepted: false, reason: 'directory_or_list_path' };

  const indexParent = pathname.replace(/\/(?:index|list|liebiao|zuixin)(?:_\d+)?\.(?:s?html?)$/, '/');
  if (indexParent !== pathname && indexParent.replace(/\/+$/, '') === basePath.replace(/\/+$/, '')) {
    return { accepted: false, reason: 'source_listing' };
  }

  const baseFirst = basePath.split('/').filter(Boolean)[0];
  const candidateFirst = pathname.split('/').filter(Boolean)[0];
  if (baseFirst && candidateFirst !== baseFirst) return { accepted: false, reason: 'outside_source_path' };
  if (source.id === 'gov-policy' && !/^\/zhengce\/(?:content\/|20\d{2}|zhengcewenjianku\/)/.test(pathname)) {
    return { accepted: false, reason: 'outside_policy_path' };
  }
  if (source.id === 'gov-news' && !/^\/yaowen\//.test(pathname)) {
    return { accepted: false, reason: 'outside_news_path' };
  }
  if (source.id === 'gov-explain' && !/^\/zhengce\//.test(pathname)) {
    return { accepted: false, reason: 'outside_explain_path' };
  }

  const year = candidateYear(url, '');
  if (year && year < currentYear - 2) return { accepted: false, reason: 'stale_year', year };
  if (year && year > currentYear + 1) return { accepted: false, reason: 'future_year', year };
  return { accepted: true, reason: 'valid_document_path', year };
}

function sortCandidates(candidates) {
  return candidates.sort((left, right) => {
    if ((right.year || 0) !== (left.year || 0)) return (right.year || 0) - (left.year || 0);
    return right.score - left.score;
  });
}

function normalizeDiscoveredCandidate(href, title, baseUrl, options, seen) {
  const currentYear = options.currentYear || new Date().getFullYear();
  const reject = (reason, details = {}) => {
    if (typeof options.onReject === 'function') options.onReject({ reason, ...details });
    return null;
  };
  href = decodeEntities(href).trim();
  title = stripTags(title);
  if (!href || href.startsWith('#')) return null;
  if (!isSafeDocumentHref(href)) return reject('unsafe_href', { href: href.slice(0, 200), title });

  let url;
  try {
    url = new URL(href, baseUrl);
  } catch {
    return reject('invalid_url', { href: href.slice(0, 200), title });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return reject('invalid_protocol', { href: href.slice(0, 200), title });
  }
  const baseHost = new URL(baseUrl).hostname.toLowerCase();
  const candidateHost = url.hostname.toLowerCase();
  const officialNeighbor = baseHost === candidateHost
    || (baseHost.endsWith('.gov.cn') && candidateHost.endsWith('.gov.cn'));
  if (!officialNeighbor) return reject('external_host', { url: url.href, title });
  url.hash = '';
  const key = url.href;
  if (seen.has(key)) return null;

  const pathAssessment = assessCandidatePath(url, baseUrl, options.source, currentYear);
  if (!pathAssessment.accepted) return reject(pathAssessment.reason, { url: key, title });
  const year = candidateYear(url, title);
  if (year && year < currentYear - 2) return reject('stale_year', { url: key, title, year });
  if (year && year > currentYear + 1) return reject('future_year', { url: key, title, year });
  const relevance = assessRelevance({ title, contentText: '', originalUrl: key }, options.source);
  if (!relevance.accepted) return reject('low_relevance', { url: key, title, relevance });

  const pathScore = /content[_/-]?\d+|\/20\d{2}[-/]|\/zhengce\/|\/xwfb\/|\/gzdt\//i.test(url.pathname) ? 3 : 0;
  const titleScore = title.length >= 8 && title.length <= 180 ? 2 : 0;
  const sameHostScore = new URL(baseUrl).hostname === url.hostname ? 2 : 0;
  const recencyScore = year === currentYear ? 4 : year === currentYear - 1 ? 3 : year ? 1 : 0;
  seen.add(key);
  return {
    url: key,
    title,
    score: pathScore + titleScore + sameHostScore + relevance.score + recencyScore,
    year,
    relevance
  };
}

function discoverDocumentLinks(html, baseUrl, maximum = 20, options = {}) {
  const candidates = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi)) {
    const candidate = normalizeDiscoveredCandidate(
      match[1] || match[2] || match[3] || '',
      match[4],
      baseUrl,
      options,
      seen
    );
    if (candidate) candidates.push(candidate);
  }
  return sortCandidates(candidates).slice(0, maximum);
}

function structuredRecords(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['data', 'list', 'rows', 'items', 'results']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function discoverStructuredDocumentLinks(value, baseUrl, maximum = 20, options = {}) {
  if (typeof value === 'string') value = JSON.parse(value);
  const candidates = [];
  const seen = new Set();
  for (const record of structuredRecords(value).slice(0, 2_000)) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    const href = record.URL || record.url || record.link || record.href || record.DOCPUBURL || '';
    const title = record.TITLE || record.title || record.name || record.DOCTITLE || '';
    const candidate = normalizeDiscoveredCandidate(String(href), String(title), baseUrl, options, seen);
    if (candidate) candidates.push(candidate);
  }
  return sortCandidates(candidates).slice(0, maximum);
}

function discoverJsonFeedUrls(html, baseUrl, maximum = 5) {
  const urls = [];
  const seen = new Set();
  for (const match of String(html || '').matchAll(/["']([^"'\s]+\.json(?:\?[^"']*)?)["']/gi)) {
    const href = decodeEntities(match[1]).trim();
    if (!isSafeDocumentHref(href)) continue;
    let url;
    try {
      url = new URL(href, baseUrl);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== new URL(baseUrl).hostname) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    urls.push(url.href);
    if (urls.length >= maximum) break;
  }
  return urls;
}

module.exports = {
  cleanSiteTitle,
  decodeEntities,
  decodeResponseBody,
  discoverDocumentLinks,
  discoverJsonFeedUrls,
  discoverStructuredDocumentLinks,
  assessCandidatePath,
  candidateYear,
  extractElementInnerHtmlById,
  extractDocument,
  extractIssuer,
  fetchText,
  htmlToText,
  isSafeDocumentHref,
  isPlausibleIssuer,
  normalizePublishedAt,
  summarize
};
