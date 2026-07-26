'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SOURCES_PATH = path.resolve(__dirname, '..', '..', 'config', 'sources.json');

function validateSource(source, index) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`sources[${index}] must be an object`);
  }
  for (const field of ['id', 'name', 'institution', 'tier', 'url']) {
    if (typeof source[field] !== 'string' || !source[field].trim()) {
      throw new Error(`sources[${index}].${field} must be a non-empty string`);
    }
  }
  let url;
  try {
    url = new URL(source.url);
  } catch {
    throw new Error(`sources[${index}].url must be an absolute URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`sources[${index}].url must use HTTP or HTTPS`);
  }
  if (!/^P[0-9]$/.test(source.tier)) {
    throw new Error(`sources[${index}].tier must look like P0, P1, ...`);
  }
  const imageHosts = source.imageHosts === undefined ? [] : source.imageHosts;
  if (!Array.isArray(imageHosts) || imageHosts.some((host) => typeof host !== 'string' || !host.trim())) {
    throw new Error(`sources[${index}].imageHosts must be an array of host names`);
  }
  const normalizedImageHosts = imageHosts.map((host) => {
    const value = host.trim().toLowerCase().replace(/\.$/, '');
    if (value.includes('*') || value.includes('/') || value.includes(':')) {
      throw new Error(`sources[${index}].imageHosts entries must be plain host names without wildcards`);
    }
    return value;
  });
  return Object.freeze({
    id: source.id.trim(),
    name: source.name.trim(),
    institution: source.institution.trim(),
    tier: source.tier,
    url: url.href,
    imageHosts: Object.freeze(normalizedImageHosts),
    enabled: source.enabled !== false
  });
}

function loadSources(filename = DEFAULT_SOURCES_PATH) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(filename), 'utf8'));
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('sources.json must contain a non-empty array');
  }
  const sources = parsed.map(validateSource);
  const ids = new Set();
  for (const source of sources) {
    if (ids.has(source.id)) throw new Error(`duplicate source id: ${source.id}`);
    ids.add(source.id);
  }
  return Object.freeze(sources);
}

function findSource(sources, id) {
  const source = sources.find((item) => item.id === id);
  if (!source) throw new Error(`unknown source id: ${id}`);
  return source;
}

function sourceForUrl(sources, targetUrl) {
  const target = new URL(targetUrl);
  const candidates = sources
    .filter((source) => new URL(source.url).hostname === target.hostname)
    .map((source) => {
      const sourceUrl = new URL(source.url);
      const commonSegments = sourceUrl.pathname.split('/').filter(Boolean)
        .filter((segment) => target.pathname.includes(`/${segment}`)).length;
      return { source, score: commonSegments };
    })
    .sort((left, right) => right.score - left.score);
  return candidates[0]?.source || null;
}

module.exports = { DEFAULT_SOURCES_PATH, findSource, loadSources, sourceForUrl };
