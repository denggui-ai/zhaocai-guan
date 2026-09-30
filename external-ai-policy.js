'use strict';

const DEFAULT_PROVIDER = 'openai-compatible';
const DEFAULT_BASE_URL = '';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_MODEL_ID_LENGTH = 160;
const VERIFIED_MODEL_PROTOCOL = 'chat-completions-strict-json-v1';
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

function normalizeProviderId(value) {
  const provider = String(value || '').trim().toLowerCase();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(provider) ? provider : '';
}

function canonicalBaseUrl(value) {
  const input = String(value || '').trim();
  if (input.length > 2048) return '';
  let parsed;
  try { parsed = new URL(input); } catch { return ''; }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) return '';
  // A bare host uses the conventional OpenAI root; an explicit path is already
  // the API root (including compatibility roots such as /v1beta/openai).
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/v1';
  const normalized = parsed.toString().replace(/\/$/, '');
  return normalized.length <= 2048 ? normalized : '';
}

function isValidExternalAiConnection(provider, baseUrl) {
  return !!normalizeProviderId(provider) && !!canonicalBaseUrl(baseUrl);
}

function sameExternalAiConnection(left = {}, right = {}) {
  return normalizeProviderId(left.provider) === normalizeProviderId(right.provider)
    && canonicalBaseUrl(left.baseUrl) === canonicalBaseUrl(right.baseUrl);
}

function normalizeModelId(id) {
  const value = String(id || '').trim();
  return value.length <= MAX_MODEL_ID_LENGTH && SAFE_MODEL_ID_PATTERN.test(value) ? value : '';
}

function describeModel(id, { source = 'provider', verified = false } = {}) {
  const normalizedId = normalizeModelId(id);
  if (!normalizedId) return null;
  return {
    id: normalizedId,
    family: 'other',
    label: normalizedId,
    tier: '可选模型',
    recommendation: '',
    reason: '模型 ID 由服务返回或手动输入，须通过兼容性测试后使用',
    modalities: ['text'],
    source: source === 'manual' ? 'manual' : 'provider',
    verified: verified === true,
    ...(verified === true ? { verification: VERIFIED_MODEL_PROTOCOL } : {}),
  };
}

function curateAvailableModels(payload) {
  const rows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.data) ? payload.data : []);
  const seen = new Set();
  return rows.flatMap((row) => {
    const id = normalizeModelId((row && (row.id || row.model || row.value)) || row);
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [describeModel(id)];
  });
}

function normalizeVerifiedModels(payload) {
  const seen = new Set();
  return (Array.isArray(payload) ? payload : []).flatMap((row) => {
    const id = normalizeModelId((row && (row.id || row.model || row.value)) || row);
    if (!id || seen.has(id) || row?.verified !== true || row?.verification !== VERIFIED_MODEL_PROTOCOL) return [];
    seen.add(id);
    return [describeModel(id, { source: row?.source, verified: true })];
  });
}

function publicConfigFields(config = {}) {
  return {
    provider: normalizeProviderId(config.provider) || DEFAULT_PROVIDER,
    baseUrl: canonicalBaseUrl(config.baseUrl),
    enabled: config.enabled === true,
    model: normalizeModelId(config.model),
    timeoutMs: Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS,
  };
}

function sanitizeStoredExternalAiState(state) {
  if (!state) return { state: null, gatewayReset: false };
  const config = state.config || {};
  const emptyConnection = !String(config.baseUrl || '').trim() && !String(state.apiKey || '').trim();
  if (!emptyConnection && !isValidExternalAiConnection(config.provider, config.baseUrl)) {
    return {
      state: { config: publicConfigFields({ timeoutMs: config.timeoutMs }), apiKey: '', models: [] },
      gatewayReset: true,
    };
  }
  const apiKey = String(state.apiKey || '').trim();
  const models = apiKey && !emptyConnection ? normalizeVerifiedModels(state.models) : [];
  const model = normalizeModelId(config.model);
  const modelVerified = models.some((item) => item.id === model);
  return {
    state: {
      config: publicConfigFields({ ...config, enabled: modelVerified && config.enabled === true, model: modelVerified ? model : '' }),
      apiKey,
      models,
    },
    gatewayReset: false,
  };
}

module.exports = {
  DEFAULT_PROVIDER,
  DEFAULT_BASE_URL,
  VERIFIED_MODEL_PROTOCOL,
  canonicalBaseUrl,
  normalizeProviderId,
  isValidExternalAiConnection,
  sameExternalAiConnection,
  normalizeModelId,
  describeModel,
  curateAvailableModels,
  curateRecommendedModels: curateAvailableModels,
  normalizeVerifiedModels,
  publicConfigFields,
  sanitizeStoredExternalAiState,
};
