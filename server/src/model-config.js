'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const MODEL_CONFIG_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 20_000;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function modelConfigPath(env = process.env) {
  if (cleanString(env.MODEL_CONFIG_PATH)) return path.resolve(env.MODEL_CONFIG_PATH);
  const dbPath = cleanString(env.DB_PATH);
  if (dbPath) return path.join(path.dirname(path.resolve(dbPath)), 'model-config.json');
  return path.resolve(__dirname, '..', 'data', 'model-config.json');
}

function normalizeModelConfig(value = {}) {
  return {
    baseUrl: cleanString(value.baseUrl ?? value.MODEL_BASE_URL),
    apiKey: cleanString(value.apiKey ?? value.MODEL_API_KEY),
    modelName: cleanString(value.modelName ?? value.MODEL_NAME)
  };
}

function hasModelConfig(config) {
  return Boolean(config?.baseUrl && config?.apiKey && config?.modelName);
}

function privateIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value))) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
    || octets[0] === 0;
}

function privateIpv6(address) {
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::'
    || normalized.startsWith('fc') || normalized.startsWith('fd')
    || normalized.startsWith('fe8') || normalized.startsWith('fe9')
    || normalized.startsWith('fea') || normalized.startsWith('feb')
    || normalized.startsWith('::ffff:127.')
    || normalized.startsWith('::ffff:10.')
    || normalized.startsWith('::ffff:192.168.');
}

function unsafeHostname(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return true;
  const family = net.isIP(normalized);
  if (family === 4) return privateIpv4(normalized);
  if (family === 6) return privateIpv6(normalized);
  return false;
}

function validateModelConfig(value, options = {}) {
  const config = normalizeModelConfig(value);
  if (!config.baseUrl || config.baseUrl.length > 2048) {
    throw new TypeError('MODEL_BASE_URL is required and must not exceed 2048 characters');
  }
  let endpoint;
  try {
    endpoint = new URL(config.baseUrl);
  } catch {
    throw new TypeError('MODEL_BASE_URL must be a valid HTTPS URL');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash || unsafeHostname(endpoint.hostname)) {
    throw new TypeError('MODEL_BASE_URL must be a public HTTPS URL without credentials, query or fragment');
  }
  if (!config.modelName || config.modelName.length > 160 || /[\u0000-\u001f\u007f]/.test(config.modelName)) {
    throw new TypeError('MODEL_NAME is required and must not exceed 160 characters');
  }
  const requireApiKey = options.requireApiKey !== false;
  if (requireApiKey && (!config.apiKey || config.apiKey.length < 8 || config.apiKey.length > 4096)) {
    throw new TypeError('MODEL_API_KEY is required and must contain 8 to 4096 characters');
  }
  if (config.apiKey && (config.apiKey.length > 4096 || /[\u0000-\u0020\u007f]/.test(config.apiKey))) {
    throw new TypeError('MODEL_API_KEY contains unsupported whitespace or control characters');
  }
  return config;
}

function completionsUrl(baseUrl) {
  const value = cleanString(baseUrl).replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(value) ? value : `${value}/chat/completions`;
}

function loadModelConfigState(env = process.env, options = {}) {
  const filePath = path.resolve(options.filePath || modelConfigPath(env));
  const environmentConfig = normalizeModelConfig(env);
  if (!fs.existsSync(filePath)) {
    return {
      config: environmentConfig,
      source: hasModelConfig(environmentConfig) ? 'environment' : 'none',
      filePath,
      updatedAt: null
    };
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`managed model configuration could not be read: ${error.message}`);
  }
  if (!value || value.version !== MODEL_CONFIG_VERSION) {
    throw new Error('managed model configuration has an unsupported version');
  }
  return {
    config: validateModelConfig(value, { requireApiKey: true }),
    source: 'managed',
    filePath,
    updatedAt: cleanString(value.updatedAt) || null
  };
}

function loadModelConfig(env = process.env, options = {}) {
  return loadModelConfigState(env, options).config;
}

function writeModelConfig(filePath, value, metadata = {}) {
  const config = validateModelConfig(value, { requireApiKey: true });
  const destination = path.resolve(filePath);
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true, mode: 0o750 });
  const payload = `${JSON.stringify({
    version: MODEL_CONFIG_VERSION,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    modelName: config.modelName,
    updatedAt: metadata.updatedAt || new Date().toISOString(),
    updatedBy: cleanString(metadata.updatedBy) || 'admin'
  }, null, 2)}\n`;
  const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, payload, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return loadModelConfigState({}, { filePath: destination });
}

function parseJsonObjectContent(value) {
  const text = cleanString(value).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('response content was not a JSON object');
  }
  return parsed;
}

function failureForStatus(status) {
  if (status === 400) return ['request_rejected', '中转站不兼容当前 chat/completions 请求格式'];
  if (status === 401) return ['authentication_failed', 'API Key 鉴权失败'];
  if (status === 403) return ['permission_denied', 'API Key 没有调用该模型的权限'];
  if (status === 404) return ['endpoint_or_model_not_found', '接口地址或模型名称不存在'];
  if (status === 408 || status === 504) return ['upstream_timeout', '中转站请求超时'];
  if (status === 409) return ['provider_conflict', '中转站拒绝了当前请求'];
  if (status === 429) return ['rate_or_quota_limited', '请求频率、余额或额度受限'];
  if (status >= 500) return ['provider_unavailable', '中转站或上游模型暂时不可用'];
  return ['provider_error', `中转站返回 HTTP ${status}`];
}

async function testModelConnection(value, options = {}) {
  const config = validateModelConfig(value, { requireApiKey: true });
  const endpoint = completionsUrl(config.baseUrl);
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const body = {
    model: config.modelName,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'Return one JSON object only.' },
      { role: 'user', content: 'Connection check. Return {"ok":true}.' }
    ]
  };
  let response;
  try {
    response = await (options.fetchImpl || fetch)(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      redirect: 'error',
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timeout = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      ok: false,
      category: timeout ? 'network_timeout' : 'network_error',
      message: timeout ? '连接中转站超时' : '无法连接中转站，请检查域名、证书或网络',
      latencyMs: Date.now() - startedAt,
      testedAt: new Date().toISOString()
    };
  }
  const latencyMs = Date.now() - startedAt;
  if (!response.ok) {
    const [category, message] = failureForStatus(response.status);
    return { ok: false, category, message, status: response.status, latencyMs, testedAt: new Date().toISOString() };
  }
  let result;
  try {
    result = await response.json();
  } catch {
    return {
      ok: false, category: 'invalid_json', message: '中转站返回的不是 JSON',
      status: response.status, latencyMs, testedAt: new Date().toISOString()
    };
  }
  const content = result?.choices?.[0]?.message?.content;
  if (!content) {
    return {
      ok: false, category: 'invalid_response', message: '响应缺少 choices[0].message.content',
      status: response.status, latencyMs, testedAt: new Date().toISOString()
    };
  }
  try {
    parseJsonObjectContent(content);
  } catch {
    return {
      ok: false, category: 'json_mode_incompatible', message: '模型未按要求返回 JSON 对象',
      status: response.status, latencyMs, testedAt: new Date().toISOString()
    };
  }
  return {
    ok: true,
    category: 'connected',
    message: '连接成功，模型返回了兼容的 JSON 响应',
    status: response.status,
    latencyMs,
    model: cleanString(result.model) || config.modelName,
    testedAt: new Date().toISOString()
  };
}

module.exports = {
  MODEL_CONFIG_VERSION,
  completionsUrl,
  hasModelConfig,
  loadModelConfig,
  loadModelConfigState,
  modelConfigPath,
  normalizeModelConfig,
  testModelConnection,
  validateModelConfig,
  writeModelConfig
};
