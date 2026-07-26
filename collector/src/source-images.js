'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns');
const fs = require('node:fs');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MIN_IMAGE_BYTES = 15 * 1024;
const MIN_IMAGE_WIDTH = 480;
const MIN_IMAGE_HEIGHT = 240;
const MAX_IMAGE_DIMENSION = 12_000;
const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'PolicyMonitor/1.0 (+official-policy-archive)';
const META_IMAGE_KEYS = new Map([
  ['og:image', 'og'],
  ['og:image:url', 'og'],
  ['og:image:secure_url', 'og'],
  ['twitter:image', 'twitter'],
  ['twitter:image:src', 'twitter']
]);
const ALLOWED_CONTENT_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp']
]);

const blockedAddresses = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
]) {
  blockedAddresses.addSubnet(address, prefix, 'ipv4');
}
blockedAddresses.addAddress('::', 'ipv6');
blockedAddresses.addAddress('::1', 'ipv6');
blockedAddresses.addSubnet('::', 96, 'ipv6');
blockedAddresses.addSubnet('64:ff9b::', 96, 'ipv6');
blockedAddresses.addSubnet('64:ff9b:1::', 48, 'ipv6');
blockedAddresses.addSubnet('100::', 64, 'ipv6');
blockedAddresses.addSubnet('2001:10::', 28, 'ipv6');
blockedAddresses.addSubnet('2001:20::', 28, 'ipv6');
blockedAddresses.addSubnet('2001:db8::', 32, 'ipv6');
blockedAddresses.addSubnet('2002::', 16, 'ipv6');
blockedAddresses.addSubnet('3fff::', 20, 'ipv6');
blockedAddresses.addSubnet('5f00::', 16, 'ipv6');
blockedAddresses.addSubnet('fc00::', 7, 'ipv6');
blockedAddresses.addSubnet('fe80::', 10, 'ipv6');
blockedAddresses.addSubnet('fec0::', 10, 'ipv6');
blockedAddresses.addSubnet('ff00::', 8, 'ipv6');

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (match, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#(\d+);/g, (match, digits) => String.fromCodePoint(Number.parseInt(digits, 10)));
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

function hostWithoutBrackets(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isSameSiteOrSubdomain(candidateUrl, pageUrl) {
  const candidateHost = hostWithoutBrackets(new URL(candidateUrl).hostname);
  const pageHost = hostWithoutBrackets(new URL(pageUrl).hostname);
  return candidateHost === pageHost || candidateHost.endsWith(`.${pageHost}`);
}

function isAllowedImageHost(candidateUrl, imageHosts = []) {
  const candidateHost = hostWithoutBrackets(new URL(candidateUrl).hostname);
  return imageHosts.some((entry) => {
    const allowed = hostWithoutBrackets(entry);
    return allowed && (candidateHost === allowed || candidateHost.endsWith(`.${allowed}`));
  });
}

function isOfficialPageUrl(pageUrl) {
  try {
    const hostname = hostWithoutBrackets(new URL(pageUrl).hostname);
    return hostname === 'gov.cn' || hostname.endsWith('.gov.cn');
  } catch {
    return false;
  }
}

function assertSafeRemoteUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('image URL is invalid');
  }
  if (url.protocol !== 'https:') throw new Error('image URL must use HTTPS');
  if (url.port && url.port !== '443') throw new Error('image URL must use port 443');
  if (url.username || url.password) throw new Error('image URL credentials are not allowed');
  const hostname = hostWithoutBrackets(url.hostname);
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('local image hosts are not allowed');
  }
  const family = net.isIP(hostname);
  if (family && blockedAddresses.check(hostname, family === 4 ? 'ipv4' : 'ipv6')) {
    throw new Error('private, local, or reserved image IP addresses are not allowed');
  }
  return url;
}

function assertPublicIpAddress(address, family = net.isIP(address)) {
  const normalizedFamily = family === 4 || family === 'IPv4' || family === 'ipv4' ? 'ipv4'
    : family === 6 || family === 'IPv6' || family === 'ipv6' ? 'ipv6' : '';
  if (!normalizedFamily || (normalizedFamily === 'ipv6' && String(address).toLowerCase().startsWith('::ffff:'))
      || blockedAddresses.check(address, normalizedFamily)) {
    throw new Error('image host resolved to a private, local, or reserved IP address');
  }
}

async function resolvePublicAddresses(hostname, lookupImpl = dns.promises.lookup) {
  const host = hostWithoutBrackets(hostname);
  const literalFamily = net.isIP(host);
  if (literalFamily) {
    assertPublicIpAddress(host, literalFamily);
    return [{ address: host, family: literalFamily }];
  }
  const resolved = await lookupImpl(host, { all: true, verbatim: true });
  const addresses = Array.isArray(resolved) ? resolved : [resolved];
  if (addresses.length === 0) throw new Error('image host did not resolve to an address');
  for (const entry of addresses) assertPublicIpAddress(entry.address, entry.family);
  return addresses.map((entry) => ({ address: entry.address, family: Number(entry.family) }));
}

function imageLooksDecorative(rawUrl, attributes = {}) {
  const description = [
    rawUrl,
    attributes.alt,
    attributes.title,
    attributes.class,
    attributes.id,
    attributes.role
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\/images\/150\.jpg(?:$|[?#])/i.test(rawUrl)) return true;
  if (/(?:^|[\W_])(logo|icon|avatar|qrcode|qr-code|qr_code|weixin|wechat|favicon|sprite|spacer|pixel|tracking|beacon|loading|placeholder|blank|share|social|footer|beian|record)(?:[\W_]|$)/i.test(description)) {
    return true;
  }
  if (/\u4e8c\u7ef4\u7801|\u5fae\u4fe1|\u5206\u4eab|\u5907\u6848/.test(description)) return true;
  const width = Number.parseInt(attributes.width, 10);
  const height = Number.parseInt(attributes.height, 10);
  if (Number.isFinite(width) && Number.isFinite(height) && (width <= 32 || height <= 32)) return true;
  return false;
}

function srcFromAttributes(attributes) {
  for (const key of ['src', 'data-src', 'data-original', 'data-url']) {
    if (attributes[key]) return attributes[key];
  }
  const srcset = attributes.srcset || attributes['data-srcset'];
  if (!srcset) return '';
  return srcset.split(',')[0].trim().split(/\s+/)[0] || '';
}

function normalizeCandidate(rawUrl, source, pageUrl, attributes, options) {
  const value = decodeEntities(rawUrl).trim();
  if (!value || /^(?:data|javascript|blob|file):/i.test(value)) return null;
  if (imageLooksDecorative(value, attributes)) return null;
  let url;
  try {
    url = assertSafeRemoteUrl(new URL(value, pageUrl).href);
  } catch {
    return null;
  }
  if (/\.(?:svg|svgz|ico)(?:$|[?#])/i.test(url.pathname)) return null;
  const sameSite = isSameSiteOrSubdomain(url, pageUrl);
  const fromMeta = source === 'og' || source === 'twitter';
  const officialPage = options.officialPage ?? isOfficialPageUrl(pageUrl);
  const allowedImageHost = isAllowedImageHost(url, options.imageHosts || []);
  if (!sameSite && !(fromMeta && officialPage && allowedImageHost)) return null;
  url.hash = '';
  return {
    url: url.href,
    source,
    sameSite,
    allowedImageHost,
    fromMeta,
    officialPage,
    priority: source === 'og' ? 10 : source === 'jsonld' ? 20 : source === 'twitter' ? 30 : 40
  };
}

function collectJsonImageValues(value, output, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonImageValues(item, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const key of ['url', 'contentUrl']) {
    if (typeof value[key] === 'string') output.push(value[key]);
  }
  if (value.image !== undefined) collectJsonImageValues(value.image, output, depth + 1);
}

function findJsonLdImages(value, output, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) findJsonLdImages(item, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  if (value.image !== undefined) collectJsonImageValues(value.image, output, depth + 1);
  if (value.thumbnailUrl !== undefined) collectJsonImageValues(value.thumbnailUrl, output, depth + 1);
  for (const [key, child] of Object.entries(value)) {
    if (!['image', 'thumbnailUrl'].includes(key) && child && typeof child === 'object') {
      findJsonLdImages(child, output, depth + 1);
    }
  }
}

function elementInnerHtmlById(html, id) {
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

function articleBodyHtml(html) {
  for (const id of ['UCAP-CONTENT', 'zoom', 'zoom1', 'article-content', 'articleContent', 'content']) {
    const body = elementInnerHtmlById(html, id);
    if (body) return body;
  }
  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(html);
  return article?.[1] || '';
}

function extractSourceImageCandidates(html, pageUrl, options = {}) {
  try {
    assertSafeRemoteUrl(pageUrl);
  } catch {
    return [];
  }
  const rawCandidates = [];
  const metaBySource = { og: [], twitter: [] };
  for (const match of String(html || '').matchAll(/<meta\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    const key = String(attributes.property || attributes.name || '').toLowerCase();
    const source = META_IMAGE_KEYS.get(key);
    if (source && attributes.content) metaBySource[source].push(attributes.content);
  }
  for (const source of ['og', 'twitter']) {
    for (const url of metaBySource[source]) rawCandidates.push({ url, source, attributes: {} });
  }

  for (const match of String(html || '').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = parseAttributes(`<script ${match[1]}>`);
    if (!/^application\/ld\+json(?:\s*;|$)/i.test(attributes.type || '')) continue;
    try {
      const images = [];
      findJsonLdImages(JSON.parse(match[2]), images);
      for (const url of images) rawCandidates.push({ url, source: 'jsonld', attributes: {} });
    } catch {
      // Invalid JSON-LD should not invalidate the source article.
    }
  }

  for (const match of articleBodyHtml(String(html || '')).matchAll(/<img\b[^>]*>/gi)) {
    const attributes = parseAttributes(match[0]);
    const url = srcFromAttributes(attributes);
    if (url) rawCandidates.push({ url, source: 'body', attributes });
  }

  const candidates = [];
  const seen = new Set();
  for (const raw of rawCandidates) {
    const candidate = normalizeCandidate(raw.url, raw.source, pageUrl, raw.attributes, options);
    if (!candidate || seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    candidates.push(candidate);
  }
  return candidates.sort((left, right) => {
    if (left.priority !== right.priority) return left.priority - right.priority;
    if (left.sameSite !== right.sameSite) return left.sameSite ? -1 : 1;
    return 0;
  });
}

function sniffImageExtension(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
      && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return '';
}

function imageDimensions(buffer, extension) {
  if (extension === 'png' && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (extension === 'jpg') {
    let offset = 2;
    const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    while (offset + 8 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (buffer[offset] === 0xff) offset += 1;
      const marker = buffer[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if (sofMarkers.has(marker) && length >= 7) {
        return { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
      }
      offset += length;
    }
  }
  if (extension === 'webp' && buffer.length >= 30) {
    const kind = buffer.subarray(12, 16).toString('ascii');
    if (kind === 'VP8X') {
      const width = 1 + buffer[24] + (buffer[25] << 8) + (buffer[26] << 16);
      const height = 1 + buffer[27] + (buffer[28] << 8) + (buffer[29] << 16);
      return { width, height };
    }
    if (kind === 'VP8 ' && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (kind === 'VP8L' && buffer[20] === 0x2f && buffer.length >= 25) {
      const width = 1 + buffer[21] + ((buffer[22] & 0x3f) << 8);
      const height = 1 + (buffer[22] >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10);
      return { width, height };
    }
  }
  return null;
}

async function readLimitedBody(response, maximumBytes, controller) {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maximumBytes) throw new Error(`image exceeds ${maximumBytes} byte limit`);
    return buffer;
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maximumBytes) {
      controller.abort();
      throw new Error(`image exceeds ${maximumBytes} byte limit`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

function responseHeaders(headers) {
  return {
    get(name) {
      const value = headers[String(name).toLowerCase()];
      return Array.isArray(value) ? value[0] : value === undefined ? null : String(value);
    }
  };
}

function httpsRequestPinned(url, addresses, options = {}) {
  const selected = addresses[0];
  const hostname = hostWithoutBrackets(url.hostname);
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = https.request({
      protocol: 'https:',
      hostname,
      port: 443,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      servername: net.isIP(hostname) ? undefined : hostname,
      agent: false,
      headers: { ...options.headers, Host: url.host },
      lookup(_hostname, lookupOptions, callback) {
        if (lookupOptions?.all) callback(null, [selected]);
        else callback(null, selected.address, selected.family);
      }
    }, (response) => {
      settled = true;
      const clearAbsoluteTimeout = () => clearTimeout(absoluteTimeout);
      response.once('end', clearAbsoluteTimeout);
      response.once('close', clearAbsoluteTimeout);
      resolve({
        status: response.statusCode || 0,
        ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
        headers: responseHeaders(response.headers),
        body: response,
        abort() {
          clearAbsoluteTimeout();
          response.destroy();
          request.destroy();
        }
      });
    });
    const absoluteTimeout = setTimeout(
      () => request.destroy(new Error('image request timed out')),
      options.timeoutMs || 20_000
    );
    request.on('error', (error) => {
      clearTimeout(absoluteTimeout);
      if (!settled) reject(error);
    });
    request.end();
  });
}

async function abortResponse(response) {
  if (!response) return;
  if (typeof response.abort === 'function') {
    response.abort();
    return;
  }
  if (response.body && typeof response.body.cancel === 'function' && !response.body.locked) {
    await response.body.cancel().catch(() => {});
  }
}

async function fetchImageBuffer(initialUrl, options = {}) {
  const fetchImpl = options.fetchImpl;
  const pageUrl = assertSafeRemoteUrl(options.pageUrl || initialUrl).href;
  const maximumBytes = options.maxBytes || MAX_IMAGE_BYTES;
  const maximumRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs || 20_000;
  let currentUrl = assertSafeRemoteUrl(initialUrl);

  for (let redirects = 0; ; redirects += 1) {
    if (!isSameSiteOrSubdomain(currentUrl, pageUrl)
        && !(options.allowCrossSite && isAllowedImageHost(currentUrl, options.imageHosts || []))) {
      throw new Error('cross-site image redirect is not allowed');
    }
    const addresses = await resolvePublicAddresses(currentUrl.hostname, options.lookupImpl);
    let controller;
    let timeout;
    let response;
    let consumed = false;
    try {
      const headers = {
        Accept: 'image/jpeg, image/png, image/webp;q=0.9',
        Referer: pageUrl,
        'User-Agent': USER_AGENT
      };
      if (fetchImpl) {
        controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), timeoutMs);
        response = await fetchImpl(currentUrl.href, {
          headers,
          redirect: 'manual',
          signal: controller.signal
        });
      } else {
        response = await httpsRequestPinned(currentUrl, addresses, { headers, timeoutMs });
        controller = { abort: () => response.abort() };
      }
      if (response.status >= 300 && response.status < 400) {
        if (redirects >= maximumRedirects) throw new Error('image redirect limit exceeded');
        const location = response.headers.get('location');
        if (!location) throw new Error(`image redirect HTTP ${response.status} has no location`);
        currentUrl = assertSafeRemoteUrl(new URL(location, currentUrl).href);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} while fetching image`);
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        throw new Error(`image exceeds ${maximumBytes} byte limit`);
      }
      const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        throw new Error(`unsupported image content type: ${contentType}`);
      }
      const buffer = await readLimitedBody(response, maximumBytes, controller);
      consumed = true;
      if (buffer.length < (options.minBytes || MIN_IMAGE_BYTES)) {
        throw new Error('image file is too small to be an article cover');
      }
      const extension = sniffImageExtension(buffer);
      if (!extension) throw new Error('downloaded content is not a supported image');
      const declaredExtension = ALLOWED_CONTENT_TYPES.get(contentType);
      if (declaredExtension && declaredExtension !== extension) {
        throw new Error('image content type does not match its bytes');
      }
      const dimensions = imageDimensions(buffer, extension);
      if (!dimensions) throw new Error('image dimensions could not be read from its header');
      if (dimensions.width < (options.minWidth || MIN_IMAGE_WIDTH)
          || dimensions.height < (options.minHeight || MIN_IMAGE_HEIGHT)) {
        throw new Error(`image dimensions ${dimensions.width}x${dimensions.height} are too small`);
      }
      if (dimensions.width > (options.maxDimension || MAX_IMAGE_DIMENSION)
          || dimensions.height > (options.maxDimension || MAX_IMAGE_DIMENSION)
          || dimensions.width * dimensions.height > (options.maxPixels || MAX_IMAGE_PIXELS)) {
        throw new Error(`image dimensions ${dimensions.width}x${dimensions.height} exceed safe decoding limits`);
      }
      return { buffer, extension, contentType, dimensions, finalUrl: currentUrl.href };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (response && !consumed) await abortResponse(response);
    }
  }
}

function decodeTextBuffer(buffer, contentType) {
  const charset = String(contentType || '').match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]?.toLowerCase() || 'utf-8';
  const normalized = ['gbk', 'gb2312', 'gb18030'].includes(charset) ? 'gb18030' : charset === 'utf8' ? 'utf-8' : charset;
  try {
    return new TextDecoder(normalized).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

async function fetchSourcePage(initialUrl, options = {}) {
  const fetchImpl = options.fetchImpl;
  const firstUrl = assertSafeRemoteUrl(initialUrl);
  let currentUrl = firstUrl;
  const maximumBytes = options.maxBytes || 5 * 1024 * 1024;
  const maximumRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs || 20_000;

  for (let redirects = 0; ; redirects += 1) {
    if (!isSameSiteOrSubdomain(currentUrl, firstUrl)) {
      throw new Error('cross-site source page redirect is not allowed');
    }
    const addresses = await resolvePublicAddresses(currentUrl.hostname, options.lookupImpl);
    let controller;
    let timeout;
    let response;
    let consumed = false;
    try {
      const headers = {
        Accept: 'text/html, application/xhtml+xml;q=0.9, text/plain;q=0.5',
        'User-Agent': USER_AGENT
      };
      if (fetchImpl) {
        controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), timeoutMs);
        response = await fetchImpl(currentUrl.href, { headers, redirect: 'manual', signal: controller.signal });
      } else {
        response = await httpsRequestPinned(currentUrl, addresses, { headers, timeoutMs });
        controller = { abort: () => response.abort() };
      }
      if (response.status >= 300 && response.status < 400) {
        if (redirects >= maximumRedirects) throw new Error('source page redirect limit exceeded');
        const location = response.headers.get('location');
        if (!location) throw new Error(`source page redirect HTTP ${response.status} has no location`);
        currentUrl = assertSafeRemoteUrl(new URL(location, currentUrl).href);
        continue;
      }
      if (!response.ok) throw new Error(`HTTP ${response.status} while fetching source page`);
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        throw new Error(`source page exceeds ${maximumBytes} byte limit`);
      }
      const contentType = String(response.headers.get('content-type') || '').toLowerCase();
      if (!/^(?:text\/html|application\/xhtml\+xml|text\/plain)(?:;|$)/i.test(contentType)) {
        throw new Error(`unsupported source page content type: ${contentType}`);
      }
      const buffer = await readLimitedBody(response, maximumBytes, controller);
      consumed = true;
      return { body: decodeTextBuffer(buffer, contentType), contentType, finalUrl: currentUrl.href };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (response && !consumed) await abortResponse(response);
    }
  }
}

async function fileExists(filename) {
  try {
    await fs.promises.access(filename, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function atomicCacheWrite(filename, buffer) {
  if (await fileExists(filename)) return false;
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o644);
    await handle.writeFile(buffer);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.promises.rename(temporary, filename);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code) || !(await fileExists(filename))) throw error;
      await fs.promises.unlink(temporary).catch(() => {});
      return false;
    }
    return true;
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

async function cacheSourceImage(candidate, options = {}) {
  if (!candidate?.url) throw new Error('image candidate URL is required');
  const frontendDir = path.resolve(options.frontendDir || path.resolve(__dirname, '..', '..', 'frontend'));
  const cached = await fetchImageBuffer(candidate.url, {
    fetchImpl: options.fetchImpl,
    pageUrl: options.pageUrl,
    timeoutMs: options.timeoutMs,
    maxBytes: options.maxBytes,
    maxRedirects: options.maxRedirects,
    lookupImpl: options.lookupImpl,
    imageHosts: options.imageHosts,
    allowCrossSite: Boolean(candidate.fromMeta && candidate.officialPage)
  });
  const checksum = crypto.createHash('sha256').update(cached.buffer).digest('hex');
  const relativePath = `assets/covers/source-${checksum}.${cached.extension}`;
  const destination = path.join(frontendDir, ...relativePath.split('/'));
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  const created = await atomicCacheWrite(destination, cached.buffer);
  return {
    coverImage: relativePath,
    checksum,
    created,
    finalUrl: cached.finalUrl,
    sourceUrl: candidate.url
  };
}

async function findAndCacheSourceImage(html, pageUrl, options = {}) {
  const candidates = extractSourceImageCandidates(html, pageUrl, options);
  const errors = [];
  for (const candidate of candidates) {
    try {
      const cached = await cacheSourceImage(candidate, { ...options, pageUrl });
      return { ...cached, candidate, candidatesFound: candidates.length, errors };
    } catch (error) {
      errors.push({ url: candidate.url, message: error.message });
    }
  }
  return { coverImage: '', candidatesFound: candidates.length, errors };
}

module.exports = {
  ALLOWED_CONTENT_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  MAX_REDIRECTS,
  MIN_IMAGE_BYTES,
  MIN_IMAGE_HEIGHT,
  MIN_IMAGE_WIDTH,
  USER_AGENT,
  assertSafeRemoteUrl,
  cacheSourceImage,
  extractSourceImageCandidates,
  fetchImageBuffer,
  fetchSourcePage,
  findAndCacheSourceImage,
  isOfficialPageUrl,
  isAllowedImageHost,
  isSameSiteOrSubdomain,
  imageDimensions,
  resolvePublicAddresses,
  sniffImageExtension
};
