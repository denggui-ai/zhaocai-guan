'use strict';

const crypto = require('crypto');
const path = require('path');

const TOKEN_VERSION = 'assessment-file-selection-v1';
const TOKEN_TTL_MS = 5 * 60 * 1000;
const REPORT_TYPES = new Set(['career_potential', 'workplace_style', 'team_role', 'unknown']);

class AssessmentFileSelectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AssessmentFileSelectionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AssessmentFileSelectionError(code, message);
}

function requiredSecret(secret) {
  const value = String(secret || '');
  if (value.length < 32 || value.length > 512) fail('ASSESSMENT_SELECTION_SECRET_INVALID', 'Assessment file selection secret is unavailable.');
  return value;
}

function requiredText(value, code, maxLength = 160) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text || text.length > maxLength || /[\0\r\n]/.test(text)) fail(code, 'Assessment file selection binding is invalid.');
  return text;
}

function normalizedBinding(input = {}) {
  const sourcePath = requiredText(input.source_path, 'ASSESSMENT_SELECTION_PATH_INVALID', 4096);
  if (!path.isAbsolute(sourcePath)) fail('ASSESSMENT_SELECTION_PATH_INVALID', 'Assessment file selection path is invalid.');
  const jobId = Number(input.job_id);
  if (!Number.isInteger(jobId) || jobId <= 0) fail('ASSESSMENT_SELECTION_BINDING_INVALID', 'Assessment file selection binding is invalid.');
  const assessmentDate = input.assessment_date == null || input.assessment_date === ''
    ? null
    : requiredText(input.assessment_date, 'ASSESSMENT_SELECTION_BINDING_INVALID', 10);
  if (assessmentDate) {
    const parsed = new Date(`${assessmentDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(assessmentDate)
      || !Number.isFinite(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== assessmentDate) {
      fail('ASSESSMENT_SELECTION_BINDING_INVALID', 'Assessment file selection date is invalid.');
    }
  }
  const reportType = requiredText(input.report_type, 'ASSESSMENT_SELECTION_BINDING_INVALID', 40);
  if (!REPORT_TYPES.has(reportType)) fail('ASSESSMENT_SELECTION_BINDING_INVALID', 'Assessment report type is invalid.');
  return Object.freeze({
    source_path: path.resolve(sourcePath),
    candidate_id: requiredText(input.candidate_id, 'ASSESSMENT_SELECTION_BINDING_INVALID'),
    job_id: jobId,
    report_type: reportType,
    assessment_date: assessmentDate,
    request_id: requiredText(input.request_id, 'ASSESSMENT_SELECTION_BINDING_INVALID', 128),
  });
}

function signature(secret, encodedPayload) {
  return crypto.createHmac('sha256', secret).update(encodedPayload, 'utf8').digest('base64url');
}

function issueAssessmentFileSelection(secretInput, input, options = {}) {
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

function sameBinding(payload, expected) {
  return payload.candidate_id === expected.candidate_id
    && Number(payload.job_id) === expected.job_id
    && payload.report_type === expected.report_type
    && (payload.assessment_date || null) === expected.assessment_date
    && payload.request_id === expected.request_id;
}

function consumeAssessmentFileSelection(secretInput, tokenInput, expectedInput, consumedNonces, options = {}) {
  const secret = requiredSecret(secretInput);
  const token = String(tokenInput || '');
  if (!token || token.length > 8192 || !token.includes('.')) fail('ASSESSMENT_SELECTION_REQUIRED', 'A native Assessment file selection is required.');
  const [encoded, suppliedSignature, extra] = token.split('.');
  if (!encoded || !suppliedSignature || extra !== undefined) fail('ASSESSMENT_SELECTION_INVALID', 'Assessment file selection is invalid.');
  const expectedSignature = signature(secret, encoded);
  const left = Buffer.from(suppliedSignature, 'utf8');
  const right = Buffer.from(expectedSignature, 'utf8');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) fail('ASSESSMENT_SELECTION_INVALID', 'Assessment file selection is invalid.');

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    fail('ASSESSMENT_SELECTION_INVALID', 'Assessment file selection is invalid.');
  }
  const expected = normalizedBinding({ ...expectedInput, source_path: payload && payload.source_path });
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  if (!payload || payload.version !== TOKEN_VERSION
    || !Number.isFinite(payload.issued_at) || !Number.isFinite(payload.expires_at)
    || payload.expires_at <= now || payload.expires_at - payload.issued_at !== TOKEN_TTL_MS
    || payload.issued_at > now + 30_000
    || typeof payload.nonce !== 'string' || payload.nonce.length < 20
    || !sameBinding(payload, expected)) {
    fail('ASSESSMENT_SELECTION_INVALID', 'Assessment file selection is invalid or expired.');
  }
  if (!(consumedNonces instanceof Set)) fail('ASSESSMENT_SELECTION_STORE_REQUIRED', 'Assessment file selection replay store is unavailable.');
  if (consumedNonces.has(payload.nonce)) fail('ASSESSMENT_SELECTION_REPLAYED', 'Assessment file selection was already consumed.');
  consumedNonces.add(payload.nonce);
  return Object.freeze({ ...expected, source_path: path.resolve(payload.source_path), nonce: payload.nonce });
}

module.exports = {
  AssessmentFileSelectionError,
  TOKEN_TTL_MS,
  consumeAssessmentFileSelection,
  issueAssessmentFileSelection,
};
