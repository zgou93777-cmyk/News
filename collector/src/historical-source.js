'use strict';

function officialEvidenceUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid evidence URL: ${value}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error(`evidence URL must use standard HTTPS: ${value}`);
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname !== 'gov.cn' && !hostname.endsWith('.gov.cn')) {
    throw new Error(`evidence URL must be an official .gov.cn source: ${value}`);
  }
  url.hash = '';
  return url.href;
}

module.exports = { officialEvidenceUrl };
