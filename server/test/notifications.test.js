'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { openDatabase } = require('../src/db');
const { buildDingTalkUrl, sendDingTalk, sendWebPush } = require('../src/notifications');
const { buildAlert } = require('../scripts/send-alert');

test('systemd alert text includes a sanitized unit name', () => {
  const alert = buildAlert('policy-monitor.service\nsecret=value');
  assert.equal(alert.title, '政知镜服务异常');
  assert.match(alert.body, /policy-monitor\.service\?secret\?value/);
  assert.doesNotMatch(alert.body, /\n/);
});

test('DingTalk signing uses timestamp and secret without exposing either in source config', async () => {
  const timestamp = 1_700_000_000_000;
  const secret = 'SEC-test-only';
  const url = buildDingTalkUrl('https://oapi.dingtalk.com/robot/send?access_token=test', secret, timestamp);
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
  assert.equal(url.searchParams.get('timestamp'), String(timestamp));
  assert.equal(url.searchParams.get('sign'), expected);

  let request;
  const result = await sendDingTalk(
    { dingtalkWebhook: 'https://oapi.dingtalk.com/robot/send?access_token=test', dingtalkSecret: secret },
    { title: '新政策', body: '摘要', url: 'https://example.test/policy/1' },
    async (target, options) => {
      request = { target, options };
      return { ok: true, json: async () => ({ errcode: 0, errmsg: 'ok' }) };
    }
  );
  assert.deepEqual(result, { enabled: true, sent: true });
  assert.match(JSON.parse(request.options.body).markdown.text, /查看完整分析/);
});

test('web push removes expired subscriptions and continues delivery', async () => {
  const db = openDatabase(':memory:');
  try {
    const insert = db.prepare('INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)');
    insert.run('https://push.example.test/gone', 'p256dh-one-value-long', 'auth-one-value');
    insert.run('https://push.example.test/live', 'p256dh-two-value-long', 'auth-two-value');
    const mockWebPush = {
      setVapidDetails() {},
      async sendNotification(subscription) {
        if (subscription.endpoint.endsWith('/gone')) {
          const error = new Error('gone');
          error.statusCode = 410;
          throw error;
        }
      }
    };
    const result = await sendWebPush(db, {
      vapidSubject: 'mailto:test@example.com',
      vapidPublicKey: 'public',
      vapidPrivateKey: 'private'
    }, { title: 'title', body: 'body' }, mockWebPush);
    assert.deepEqual(result, { enabled: true, sent: 1, failed: 0, removed: 1 });
    assert.equal(db.prepare('SELECT endpoint FROM push_subscriptions').get().endpoint, 'https://push.example.test/live');
  } finally {
    db.close();
  }
});
