'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const {
  DEFAULT_PROVIDER,
  canonicalBaseUrl,
  normalizeProviderId,
  isValidExternalAiConnection,
  sameExternalAiConnection,
  publicConfigFields,
  normalizeVerifiedModels,
  sanitizeStoredExternalAiState,
} = require('./external-ai-policy');

const STORE_VERSION = 2;

function normalizedModels(models) {
  return normalizeVerifiedModels(models);
}

function resolveLlmStartupBinding({ storedState, env = {} } = {}) {
  const stored = sanitizeStoredExternalAiState(storedState).state
    || { config: publicConfigFields(), apiKey: '', models: [] };
  const config = { ...stored.config };
  if (String(env.HRBOSS_EXTERNAL_AI_PROVIDER || '').trim()) config.provider = normalizeProviderId(env.HRBOSS_EXTERNAL_AI_PROVIDER);
  if (String(env.HRBOSS_EXTERNAL_AI_BASE_URL || '').trim()) config.baseUrl = canonicalBaseUrl(env.HRBOSS_EXTERNAL_AI_BASE_URL);
  const connectionChanged = !sameExternalAiConnection(config, stored.config);
  const environmentKey = String(env.HRBOSS_EXTERNAL_AI_API_KEY || '').trim();
  const invalid = !isValidExternalAiConnection(config.provider, config.baseUrl);
  const reset = connectionChanged || !!environmentKey || invalid;
  const models = reset ? [] : stored.models;
  const apiKey = invalid ? '' : (environmentKey || (connectionChanged ? '' : stored.apiKey));
  const selectedModel = String(env.HRBOSS_EXTERNAL_AI_MODEL || config.model || '').trim();
  config.model = models.some((item) => item.id === selectedModel) ? selectedModel : '';
  config.enabled = !reset && !!config.model && (Object.hasOwn(env, 'HRBOSS_EXTERNAL_AI_ENABLED')
    ? env.HRBOSS_EXTERNAL_AI_ENABLED === '1' : config.enabled === true);
  return { config: publicConfigFields(config), apiKey, models };
}

function loadSecureLlmState(filePath, safeStorage) {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!payload || ![1, STORE_VERSION].includes(payload.version)) return null;
    let apiKey = '';
    let models = [];
    if (payload.encryptedApiKey) {
      if (!safeStorage || !safeStorage.isEncryptionAvailable()) return null;
      const decrypted = safeStorage.decryptString(Buffer.from(payload.encryptedApiKey, 'base64'));
      if (payload.version === STORE_VERSION) {
        const bound = JSON.parse(decrypted);
        if (!sameExternalAiConnection(bound, payload.config)) return null;
        apiKey = bound.apiKey;
        models = bound.models;
      } else {
        // Version 1 never bound the key to its plaintext connection. Discard
        // the decrypted value and require reentry, including a v2 ciphertext
        // relabeled as v1. Decryption errors still fail closed above.
      }
    }
    const sanitized = sanitizeStoredExternalAiState({
      config: payload.config,
      apiKey: String(apiKey || '').trim(),
      models,
    });
    return {
      ...sanitized.state,
      ...(sanitized.gatewayReset ? { gatewayReset: true } : {}),
    };
  } catch {
    return null;
  }
}

function saveSecureLlmState(filePath, safeStorage, { config, apiKey = '', models = [] }) {
  const secret = String(apiKey || '').trim();
  if ((secret || String(config?.baseUrl || '').trim()) && !isValidExternalAiConnection(config?.provider, config?.baseUrl)) {
    throw new Error('外部 AI 服务配置无效，未保存访问密钥。');
  }
  if (secret && (!safeStorage || !safeStorage.isEncryptionAvailable())) {
    throw new Error('当前系统安全存储不可用，API Key 仅在本次运行中有效。');
  }
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const verifiedModels = secret ? normalizedModels(models) : [];
  const selectedModel = String(config && config.model || '').trim();
  const payload = {
    version: STORE_VERSION,
    config: publicConfigFields({
      ...config,
      model: verifiedModels.some((item) => item.id === selectedModel) ? selectedModel : '',
      enabled: !!secret && verifiedModels.some((item) => item.id === selectedModel) && config?.enabled === true,
    }),
    models: verifiedModels,
    encryptedApiKey: secret ? safeStorage.encryptString(JSON.stringify({
      provider: normalizeProviderId(config.provider),
      baseUrl: canonicalBaseUrl(config.baseUrl),
      apiKey: secret,
      models: verifiedModels,
    })).toString('base64') : '',
  };
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(16).toString('hex')}.tmp`;
  let committed = false;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: 'w' });
    try { fs.chmodSync(temporary, 0o600); } catch {}
    fs.renameSync(temporary, filePath);
    committed = true;
  } finally {
    if (!committed) {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
  try { fs.chmodSync(filePath, 0o600); } catch {}
  return payload;
}

function loadLegacyRatingState({ dataDir, appDir = __dirname, explicitPath = '', env = process.env } = {}) {
  const candidates = explicitPath
    ? [path.resolve(explicitPath)]
    : [...new Set([
      dataDir ? path.join(path.resolve(dataDir), 'rating-config.json') : '',
      path.join(path.resolve(appDir), 'rating-config.json'),
    ].filter(Boolean))];
  const filePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!filePath) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const baseUrl = canonicalBaseUrl(raw.baseUrl || raw.base_url);
    const provider = normalizeProviderId(raw.provider || DEFAULT_PROVIDER);
    if (!isValidExternalAiConnection(provider, baseUrl)) return null;
    const apiKey = String(raw.apiKey || raw.api_key || '').trim();
    if (!apiKey) return null;
    // Legacy model lists have no protocol proof. Import the credential at its
    // original endpoint, but require a fresh test and explicit enable action.
    const models = [];
    const selectedModel = '';

    return {
      config: {
        provider,
        baseUrl,
        enabled: false,
        model: selectedModel,
        timeoutMs: Number(raw.timeoutMs || raw.timeout_ms) || 120000,
      },
      apiKey,
      models,
      source: filePath,
    };
  } catch {
    return null;
  }
}

module.exports = {
  loadLegacyRatingState,
  loadSecureLlmState,
  saveSecureLlmState,
  resolveLlmStartupBinding,
};
