'use strict';

const path = require('node:path');

const SERVER_ROOT = path.resolve(__dirname, '..');

function integerFromEnv(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function resolveFromServerRoot(value, fallback) {
  return path.resolve(SERVER_ROOT, value || fallback);
}

function loadConfig() {
  return Object.freeze({
    host: process.env.HOST || '127.0.0.1',
    port: integerFromEnv('PORT', 5191, 1, 65535),
    dbPath: resolveFromServerRoot(process.env.DB_PATH, 'data/policy-monitor.db'),
    historicalCacheDir: resolveFromServerRoot(process.env.HISTORICAL_CACHE_DIR, 'data/historical-cache'),
    frontendDir: resolveFromServerRoot(process.env.FRONTEND_DIR, '../frontend'),
    maxBodyBytes: integerFromEnv('MAX_BODY_BYTES', 32 * 1024, 1024, 1024 * 1024),
    vapidSubject: process.env.VAPID_SUBJECT || '',
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || '',
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || '',
    dingtalkWebhook: process.env.DINGTALK_WEBHOOK || '',
    dingtalkSecret: process.env.DINGTALK_SECRET || ''
  });
}

module.exports = { SERVER_ROOT, loadConfig };
