const crypto = require('crypto');

const APPROVAL_TTL_MS = 10 * 60 * 1000;

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validSecret(secret) {
  return Buffer.byteLength(String(secret || ''), 'utf8') >= 32;
}

function approvalBinding(input = {}) {
  const materialIds = Array.isArray(input.materialIds || input.material_ids)
    ? (input.materialIds || input.material_ids).map(Number).sort((a, b) => a - b)
    : [];
  const binding = {
    actor: String(input.actor || '').trim(),
    provider: String(input.provider || '').trim(),
    base_url: String(input.baseUrl || input.base_url || '').trim(),
    model: String(input.model || '').trim(),
    prompt_version: String(input.promptVersion || input.prompt_version || '').trim(),
    prompt_hash: String(input.promptHash || input.prompt_hash || '').trim(),
    schema_version: String(input.schemaVersion || input.schema_version || '').trim(),
    model_catalog_hash: String(input.modelCatalogHash || input.model_catalog_hash || '').trim(),
    source_version_hash: String(input.sourceVersionHash || input.source_version_hash || '').trim(),
    session_id: Number(input.sessionId || input.session_id),
    material_ids: materialIds,
    request_hash: String(input.requestHash || input.request_hash || '').trim(),
    request_id: String(input.requestId || input.request_id || '').trim(),
  };
  let baseUrl;
  try { baseUrl = new URL(binding.base_url); } catch {}
  if (!binding.actor || !binding.provider || !baseUrl || baseUrl.protocol !== 'https:' || !baseUrl.hostname
    || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash
    || !binding.model || !binding.prompt_version || !binding.schema_version
    || ![binding.prompt_hash, binding.model_catalog_hash, binding.source_version_hash].every((value) => /^[a-f0-9]{64}$/.test(value))
    || !Number.isInteger(binding.session_id) || binding.session_id <= 0 || !binding.material_ids.length
    || binding.material_ids.some((id) => !Number.isInteger(id) || id <= 0)
    || !/^[a-f0-9]{64}$/.test(binding.request_hash)
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(binding.request_id)) {
    throw new Error('F-009 用户确认绑定无效。');
  }
  return binding;
}

function hmac(secret, encodedPayload) {
  return crypto.createHmac('sha256', String(secret)).update(encodedPayload, 'utf8').digest('base64url');
}

function issueF009UserApproval(secret, input, options = {}) {
  if (!validSecret(secret)) throw new Error('F-009 用户确认签名密钥未就绪。');
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const binding = approvalBinding(input);
  const payload = {
    purpose: 'interview-report',
    binding,
    nonce: crypto.randomUUID(),
    issued_at_ms: nowMs,
    expires_at_ms: nowMs + APPROVAL_TTL_MS,
  };
  const encoded = Buffer.from(stableJson(payload), 'utf8').toString('base64url');
  return `${encoded}.${hmac(secret, encoded)}`;
}

function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function consumeF009UserApproval(secret, token, expectedInput, consumedNonces, options = {}) {
  if (!validSecret(secret)) throw new Error('F-009 用户确认签名密钥未就绪。');
  const [encoded, signature, extra] = String(token || '').split('.');
  if (!encoded || !signature || extra || !timingSafeTextEqual(signature, hmac(secret, encoded))) {
    throw new Error('缺少本次 F-009 原生用户确认。');
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch {}
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  if (!payload || payload.purpose !== 'interview-report' || !payload.nonce
    || !Number.isFinite(payload.issued_at_ms) || !Number.isFinite(payload.expires_at_ms)
    || payload.expires_at_ms - payload.issued_at_ms !== APPROVAL_TTL_MS
    || nowMs < payload.issued_at_ms || nowMs > payload.expires_at_ms) {
    throw new Error('本次 F-009 原生用户确认无效或已过期。');
  }
  const expected = approvalBinding(expectedInput);
  if (stableJson(payload.binding) !== stableJson(expected)) {
    throw new Error('本次 F-009 原生用户确认与发送预览不一致。');
  }
  if (!(consumedNonces instanceof Set)) throw new Error('F-009 用户确认消费状态未就绪。');
  if (consumedNonces.has(payload.nonce)) throw new Error('本次 F-009 原生用户确认已使用。');
  consumedNonces.add(payload.nonce);
  return { ...payload, consumed_at_ms: nowMs };
}

module.exports = {
  APPROVAL_TTL_MS,
  approvalBinding,
  issueF009UserApproval,
  consumeF009UserApproval,
};
