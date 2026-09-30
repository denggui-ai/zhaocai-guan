const crypto = require('crypto');

const TOKEN_HEADER = 'x-hrboss-token';
const MIN_TOKEN_LENGTH = 32;

function requireLocalApiToken(env = process.env) {
  const token = String(env.HRBOSS_LOCAL_API_TOKEN || '').trim();
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(`HRBOSS_LOCAL_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  }
  return token;
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function localHostname(value) {
  try {
    const url = new URL(`http://${String(value || '')}`);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function localOrigin(value) {
  // 无 Origin 只用于 Electron 主进程/本地服务之间的受控请求；浏览器的 opaque Origin 一律拒绝。
  if (!value) return true;
  if (value === 'null') return false;
  try {
    const url = new URL(String(value));
    return ['http:', 'https:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function sendSecurityError(res, status, code, message) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify({ ok: false, code, error: message }));
}

function setCorsForLocalOrigin(req, res) {
  const origin = String(req.headers.origin || '');
  if (!origin) return;
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('vary', 'origin');
}

function handleLocalPreflight(req, res) {
  if (req.method !== 'OPTIONS') return false;
  if (!localHostname(req.headers.host) || !localOrigin(req.headers.origin)) {
    sendSecurityError(res, 403, 'invalid_preflight', 'Local API preflight rejected.');
    return true;
  }
  const requested = String(req.headers['access-control-request-headers'] || '')
    .toLowerCase()
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const allowed = new Set(['content-type', TOKEN_HEADER]);
  if (requested.some((header) => !allowed.has(header))) {
    sendSecurityError(res, 403, 'invalid_preflight_headers', 'Local API preflight headers rejected.');
    return true;
  }
  setCorsForLocalOrigin(req, res);
  res.writeHead(204, {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': `content-type, ${TOKEN_HEADER}`,
    'access-control-max-age': '0',
    'cache-control': 'no-store',
  });
  res.end();
  return true;
}

function authorizeLocalRequest(req, res, token) {
  if (!localHostname(req.headers.host)) {
    sendSecurityError(res, 403, 'invalid_host', 'Local API Host rejected.');
    return false;
  }
  if (!localOrigin(req.headers.origin)) {
    sendSecurityError(res, 403, 'invalid_origin', 'Local API Origin rejected.');
    return false;
  }
  setCorsForLocalOrigin(req, res);
  if (!timingSafeEqual(req.headers[TOKEN_HEADER], token)) {
    sendSecurityError(res, 401, 'invalid_local_token', 'Local API authentication failed.');
    return false;
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      sendSecurityError(res, 415, 'json_required', 'Local API mutations require application/json.');
      return false;
    }
  }
  return true;
}

function healthPayload(service, instanceId) {
  return {
    ok: true,
    service,
    instance_id: String(instanceId || ''),
    authenticated: true,
  };
}

module.exports = {
  TOKEN_HEADER,
  requireLocalApiToken,
  handleLocalPreflight,
  authorizeLocalRequest,
  healthPayload,
};
