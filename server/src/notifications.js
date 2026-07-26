'use strict';

const crypto = require('node:crypto');

function buildDingTalkUrl(webhook, secret, timestamp = Date.now()) {
  const url = new URL(webhook);
  if (secret) {
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}\n${secret}`)
      .digest('base64');
    url.searchParams.set('timestamp', String(timestamp));
    url.searchParams.set('sign', signature);
  }
  return url;
}

async function sendDingTalk(config, notification, fetchImpl = fetch) {
  if (!config.dingtalkWebhook) return { enabled: false, sent: false };
  const target = buildDingTalkUrl(config.dingtalkWebhook, config.dingtalkSecret);
  const link = notification.url ? `\n\n[查看完整分析](${notification.url})` : '';
  const response = await fetchImpl(target, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      msgtype: 'markdown',
      markdown: {
        title: notification.title,
        text: `### ${notification.title}\n\n${notification.body}${link}`
      }
    }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`DingTalk HTTP ${response.status}`);
  const result = await response.json();
  if (result.errcode !== 0) {
    throw new Error(`DingTalk rejected message: ${result.errcode} ${result.errmsg || ''}`.trim());
  }
  return { enabled: true, sent: true };
}

async function sendWebPush(db, config, notification, webPushOverride) {
  const enabled = Boolean(config.vapidSubject && config.vapidPublicKey && config.vapidPrivateKey);
  if (!enabled) return { enabled: false, sent: 0, failed: 0, removed: 0 };

  const webPush = webPushOverride || require('web-push');
  webPush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  const subscriptions = db.prepare(`
    SELECT id, endpoint, p256dh, auth
    FROM push_subscriptions ORDER BY id
  `).all();
  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: notification.url || '/',
    tag: notification.tag || 'policy-update',
    articleId: notification.articleId || null
  });
  const summary = { enabled: true, sent: 0, failed: 0, removed: 0 };

  for (const subscription of subscriptions) {
    try {
      await webPush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth }
      }, payload, { TTL: 24 * 60 * 60, urgency: 'high' });
      summary.sent += 1;
    } catch (error) {
      if (error.statusCode === 404 || error.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(subscription.id);
        summary.removed += 1;
      } else {
        summary.failed += 1;
      }
    }
  }
  return summary;
}

async function sendNotification(db, config, notification, overrides = {}) {
  if (!notification || typeof notification.title !== 'string' || typeof notification.body !== 'string') {
    throw new TypeError('notification title and body are required');
  }
  const normalized = {
    title: notification.title.trim().slice(0, 120),
    body: notification.body.trim().slice(0, 500),
    url: typeof notification.url === 'string' ? notification.url.trim().slice(0, 2048) : '',
    tag: typeof notification.tag === 'string' ? notification.tag.trim().slice(0, 64) : 'policy-update',
    articleId: Number.isSafeInteger(notification.articleId) ? notification.articleId : null
  };
  if (!normalized.title || !normalized.body) throw new TypeError('notification title and body cannot be empty');

  const [dingtalk, webPush] = await Promise.all([
    sendDingTalk(config, normalized, overrides.fetchImpl),
    sendWebPush(db, config, normalized, overrides.webPush)
  ]);
  return { dingtalk, webPush };
}

module.exports = { buildDingTalkUrl, sendDingTalk, sendNotification, sendWebPush };
