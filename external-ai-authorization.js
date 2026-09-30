const crypto = require('crypto');

const grants = new WeakMap();

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function bindingHash(binding) {
  if (binding === undefined || binding === null) return null;
  return crypto.createHash('sha256').update(stableJson(binding), 'utf8').digest('hex');
}

function issueExternalAiAuthorization({ purpose, confirmed, requestedBy = 'HR', binding = null, expiresInMs = 10 * 60 * 1000 }) {
  const normalizedPurpose = String(purpose || '').trim();
  if (confirmed !== true || !normalizedPurpose) {
    throw new Error('外部 AI 调用必须取得本次、明确、限定用途的用户确认。');
  }
  const ttlMs = Number(expiresInMs);
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30 * 60 * 1000) {
    throw new Error('外部 AI 一次性授权有效期无效。');
  }
  const issuedAtMs = Date.now();
  const grant = Object.freeze({});
  grants.set(grant, {
    id: crypto.randomUUID(),
    purpose: normalizedPurpose,
    requested_by: String(requestedBy || 'HR'),
    binding_hash: bindingHash(binding),
    issued_at: new Date(issuedAtMs).toISOString(),
    expires_at: new Date(issuedAtMs + ttlMs).toISOString(),
  });
  return grant;
}

function describeExternalAiAuthorization(grant) {
  const metadata = grant && grants.get(grant);
  return metadata ? { ...metadata } : null;
}

function consumeExternalAiAuthorization(grant, purpose, binding = null) {
  const metadata = grant && grants.get(grant);
  const normalizedPurpose = String(purpose || '').trim();
  if (!metadata || metadata.purpose !== normalizedPurpose) {
    throw new Error(`缺少本次 ${normalizedPurpose || '外部 AI'} 调用的一次性授权。`);
  }
  if (Date.now() > Date.parse(metadata.expires_at)) {
    grants.delete(grant);
    throw new Error(`本次 ${normalizedPurpose} 调用的一次性授权已过期。`);
  }
  if (metadata.binding_hash !== bindingHash(binding)) {
    throw new Error(`本次 ${normalizedPurpose} 调用内容与发送预览授权不一致。`);
  }
  grants.delete(grant);
  return { ...metadata, consumed_at: new Date().toISOString() };
}

module.exports = {
  issueExternalAiAuthorization,
  describeExternalAiAuthorization,
  consumeExternalAiAuthorization,
  bindingHash,
};
