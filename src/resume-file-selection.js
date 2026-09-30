'use strict';

const crypto = require('crypto');
const path = require('path');

const TOKEN_VERSION = 'resume-file-selection-v1';
const TOKEN_TTL_MS = 5 * 60 * 1000;

class ResumeFileSelectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ResumeFileSelectionError';
    this.code = code;
    this.statusCode = 400;
  }
}

function fail(code, message) {
  throw new ResumeFileSelectionError(code, message);
}

function requiredText(value, code, maxLength = 160) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text || text.length > maxLength || /[\0\r\n]/.test(text)) fail(code, '本地简历文件选择绑定无效。');
  return text;
}

function requiredSecret(value) {
  const secret = String(value || '');
  if (secret.length < 32 || secret.length > 512) fail('RESUME_SELECTION_SECRET_INVALID', '本地简历文件选择服务不可用。');
  return secret;
}

function normalizedBinding(input = {}) {
  const sourcePath = requiredText(input.source_path, 'RESUME_SELECTION_PATH_INVALID', 4096);
  if (!path.isAbsolute(sourcePath)) fail('RESUME_SELECTION_PATH_INVALID', '本地简历文件路径无效。');
  const jobId = Number(input.job_id);
  if (!Number.isInteger(jobId) || jobId <= 0) fail('RESUME_SELECTION_BINDING_INVALID', '本地简历岗位绑定无效。');
  return Object.freeze({
    source_path: path.resolve(sourcePath),
    candidate_id: requiredText(input.candidate_id, 'RESUME_SELECTION_BINDING_INVALID'),
    job_id: jobId,
    request_id: requiredText(input.request_id, 'RESUME_SELECTION_BINDING_INVALID', 128),
  });
}

function signature(secret, encoded) {
  return crypto.createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
}

function issueResumeFileSelection(secretInput, input, options = {}) {
  const secret = requiredSecret(secretInput);
  const binding = normalizedBinding(input);
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const payload = {
    version: TOKEN_VERSION,
    ...binding,
    issued_at: now,
    expires_at: now + TOKEN_TTL_MS,
    nonce: crypto.randomBytes(18).toString('base64url'),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signature(secret, encoded)}`;
}

function consumeResumeFileSelection(secretInput, tokenInput, expectedInput, consumedNonces, options = {}) {
  const secret = requiredSecret(secretInput);
  const token = String(tokenInput || '');
  if (!token || token.length > 8192 || !token.includes('.')) fail('RESUME_SELECTION_REQUIRED', '请先通过桌面文件选择器选择简历。');
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (!encoded || !suppliedSignature || extra !== undefined) fail('RESUME_SELECTION_INVALID', '本地简历文件选择凭据无效。');
  const expectedSignature = signature(secret, encoded);
  const left = Buffer.from(suppliedSignature, 'utf8');
  const right = Buffer.from(expectedSignature, 'utf8');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) fail('RESUME_SELECTION_INVALID', '本地简历文件选择凭据无效。');

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    fail('RESUME_SELECTION_INVALID', '本地简历文件选择凭据无效。');
  }
  const expected = normalizedBinding({ ...expectedInput, source_path: payload && payload.source_path });
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  if (!payload || payload.version !== TOKEN_VERSION
    || !Number.isFinite(payload.issued_at) || !Number.isFinite(payload.expires_at)
    || payload.expires_at <= now || payload.expires_at - payload.issued_at !== TOKEN_TTL_MS
    || payload.issued_at > now + 30_000
    || typeof payload.nonce !== 'string' || payload.nonce.length < 20
    || payload.candidate_id !== expected.candidate_id
    || Number(payload.job_id) !== expected.job_id
    || payload.request_id !== expected.request_id) {
    fail('RESUME_SELECTION_INVALID', '本地简历文件选择凭据已失效或与当前候选人不一致。');
  }
  if (!(consumedNonces instanceof Set)) fail('RESUME_SELECTION_STORE_REQUIRED', '本地简历文件选择状态不可用。');
  if (consumedNonces.has(payload.nonce)) fail('RESUME_SELECTION_REPLAYED', '这次本地简历文件选择已经使用。');
  consumedNonces.add(payload.nonce);
  return Object.freeze({ ...expected, source_path: path.resolve(payload.source_path), nonce: payload.nonce });
}

module.exports = {
  ResumeFileSelectionError,
  TOKEN_TTL_MS,
  consumeResumeFileSelection,
  issueResumeFileSelection,
};
