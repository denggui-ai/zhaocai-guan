const crypto = require('crypto');

const APPROVAL_TTL_MS = 10 * 60 * 1000;
const ALLOWED_PURPOSES = new Set([
  'candidate-assessment',
  'deep-profile',
  'assessment-ai-analysis',
  'job-jd-optimization',
  'screenshot-import',
  'screenshot-field-fill',
]);

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
  const purpose = String(input.purpose || '').trim();
  const targetId = String(input.targetId || input.target_id || '').trim();
  const requestId = String(input.requestId || input.request_id || '').trim();
  const actor = String(input.actor || '').trim();
  const materialSha256 = String(input.materialSha256 || input.material_sha256 || '').trim().toLowerCase();
  const provider = String(input.provider || '').trim();
  const baseUrlText = String(input.baseUrl || input.base_url || '').trim();
  const model = String(input.model || '').trim();
  let baseUrl;
  try { baseUrl = new URL(baseUrlText); } catch {}
  if (!ALLOWED_PURPOSES.has(purpose)) throw new Error('外部 AI 用户确认用途无效。');
  if (!targetId || targetId.length > 160 || /[\r\n\0]/.test(targetId)) throw new Error('外部 AI 用户确认目标无效。');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) throw new Error('外部 AI 用户确认 requestId 无效。');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(actor)) throw new Error('外部 AI 用户确认操作者无效。');
  if (!/^[0-9a-f]{64}$/.test(materialSha256)) throw new Error('外部 AI 用户确认材料哈希无效。');
  if (!provider || provider.length > 80 || /[\r\n\0]/.test(provider)) {
    throw new Error('外部 AI 用户确认 Provider 无效。');
  }
  if (!baseUrl || baseUrl.protocol !== 'https:' || !baseUrl.hostname
      || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('外部 AI 用户确认服务地址无效。');
  }
  if (!model || model.length > 160 || /[\r\n\0]/.test(model)) {
    throw new Error('外部 AI 用户确认模型无效。');
  }
  return {
    purpose,
    target_id: targetId,
    request_id: requestId,
    actor,
    material_sha256: materialSha256,
    provider,
    base_url: baseUrlText,
    model,
  };
}

function hmac(secret, encodedPayload) {
  return crypto.createHmac('sha256', String(secret)).update(encodedPayload, 'utf8').digest('base64url');
}

function timingSafeTextEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function issueExternalAiUserApproval(secret, input, options = {}) {
  if (!validSecret(secret)) throw new Error('外部 AI 用户确认签名密钥未就绪。');
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const binding = approvalBinding(input);
  const payload = {
    binding,
    nonce: crypto.randomUUID(),
    issued_at_ms: nowMs,
    expires_at_ms: nowMs + APPROVAL_TTL_MS,
  };
  const encoded = Buffer.from(stableJson(payload), 'utf8').toString('base64url');
  return `${encoded}.${hmac(secret, encoded)}`;
}

function consumeExternalAiUserApproval(secret, token, expectedInput, consumedNonces, options = {}) {
  if (!validSecret(secret)) throw new Error('外部 AI 用户确认签名密钥未就绪。');
  const [encoded, signature, extra] = String(token || '').split('.');
  if (!encoded || !signature || extra || !timingSafeTextEqual(signature, hmac(secret, encoded))) {
    throw new Error('缺少本次外部 AI 原生用户确认。');
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch {}
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  if (!payload || !payload.nonce
    || !Number.isFinite(payload.issued_at_ms) || !Number.isFinite(payload.expires_at_ms)
    || payload.expires_at_ms - payload.issued_at_ms !== APPROVAL_TTL_MS
    || nowMs < payload.issued_at_ms || nowMs > payload.expires_at_ms) {
    throw new Error('本次外部 AI 原生用户确认无效或已过期。');
  }
  const expected = approvalBinding(expectedInput);
  if (stableJson(payload.binding) !== stableJson(expected)) {
    throw new Error('本次外部 AI 原生用户确认与用途、目标、请求或当前材料不一致。');
  }
  if (!(consumedNonces instanceof Set)) throw new Error('外部 AI 用户确认消费状态未就绪。');
  if (consumedNonces.has(payload.nonce)) throw new Error('本次外部 AI 原生用户确认已使用。');
  consumedNonces.add(payload.nonce);
  return { ...payload, consumed_at_ms: nowMs };
}

module.exports = {
  APPROVAL_TTL_MS,
  ALLOWED_PURPOSES,
  approvalBinding,
  issueExternalAiUserApproval,
  consumeExternalAiUserApproval,
};
