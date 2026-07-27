'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { initialize } = require('../scripts/init-admin-token');
const {
  loadModelConfig,
  loadModelConfigState,
  testModelConnection,
  validateModelConfig,
  writeModelConfig
} = require('../src/model-config');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-model-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('managed configuration overrides environment values without exposing them through metadata', (t) => {
  const directory = temporaryDirectory(t);
  const filename = path.join(directory, 'model-config.json');
  const environment = {
    MODEL_BASE_URL: 'https://environment.example/v1',
    MODEL_API_KEY: 'environment-secret',
    MODEL_NAME: 'environment-model',
    MODEL_CONFIG_PATH: filename
  };
  assert.equal(loadModelConfigState(environment).source, 'environment');
  writeModelConfig(filename, {
    baseUrl: 'https://managed.example/v1', apiKey: 'managed-secret', modelName: 'managed-model'
  });
  const state = loadModelConfigState(environment);
  assert.equal(state.source, 'managed');
  assert.equal(state.config.modelName, 'managed-model');
  assert.equal(loadModelConfig(environment).apiKey, 'managed-secret');
  assert.ok(state.updatedAt);
});

test('configuration validation rejects insecure and private endpoints', () => {
  const valid = { baseUrl: 'https://relay.example/v1', apiKey: 'valid-secret', modelName: 'relay-model' };
  assert.equal(validateModelConfig(valid).baseUrl, valid.baseUrl);
  for (const baseUrl of [
    'http://relay.example/v1',
    'https://127.0.0.1/v1',
    'https://192.168.1.9/v1',
    'https://localhost/v1',
    'https://relay.example/v1?key=secret'
  ]) {
    assert.throws(() => validateModelConfig({ ...valid, baseUrl }), /public HTTPS URL/);
  }
});

test('connection test sends the key only in authorization and validates JSON mode', async () => {
  let authorization = '';
  let requestBody;
  const result = await testModelConnection({
    baseUrl: 'https://relay.example/v1', apiKey: 'connection-secret', modelName: 'relay-model'
  }, {
    fetchImpl: async (url, request) => {
      assert.equal(url, 'https://relay.example/v1/chat/completions');
      assert.equal(request.redirect, 'error');
      authorization = request.headers.Authorization;
      requestBody = JSON.parse(request.body);
      return new Response(JSON.stringify({
        model: 'relay-model-2026',
        choices: [{ message: { content: '{"ok":true}' } }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  assert.equal(authorization, 'Bearer connection-secret');
  assert.equal(requestBody.response_format.type, 'json_object');
  assert.equal(result.ok, true);
  assert.equal(result.model, 'relay-model-2026');
  assert.doesNotMatch(JSON.stringify(result), /connection-secret/);
});

test('connection test maps provider errors without returning response bodies', async () => {
  const result = await testModelConnection({
    baseUrl: 'https://relay.example/v1', apiKey: 'connection-secret', modelName: 'missing-model'
  }, {
    fetchImpl: async () => new Response('account user-123 cannot use secret-key', { status: 403 })
  });
  assert.equal(result.ok, false);
  assert.equal(result.category, 'permission_denied');
  assert.doesNotMatch(JSON.stringify(result), /user-123|secret-key/);
});

test('admin token initialization is stable and creates a protected secret', (t) => {
  const directory = temporaryDirectory(t);
  const filename = path.join(directory, 'admin-token');
  assert.equal(initialize(filename), true);
  const first = fs.readFileSync(filename, 'utf8').trim();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(initialize(filename), false);
  assert.equal(fs.readFileSync(filename, 'utf8').trim(), first);
});
