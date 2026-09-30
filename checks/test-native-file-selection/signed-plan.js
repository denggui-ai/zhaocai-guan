'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PLAN_VERSION = 'hrboss-test-native-file-selection-plan-v1';
const PLAN_MARKER = 'hrboss-synthetic-native-file-selection-e2e-v1';
const PLAN_TTL_MS = 5 * 60 * 1000;
const MAX_PLAN_BYTES = 256 * 1024;
const ENV_KEYS = Object.freeze({
  marker: 'HRBOSS_TEST_NATIVE_FILE_SELECTION_MARKER',
  plan: 'HRBOSS_TEST_NATIVE_FILE_SELECTION_PLAN',
  secret: 'HRBOSS_TEST_NATIVE_FILE_SELECTION_SECRET',
});

const DIALOG_CONTRACTS = Object.freeze(new Map([
  ['选择 Boss App 截图文件夹', Object.freeze({
    properties: Object.freeze(['openDirectory']),
    kind: 'directory',
    extensions: null,
    multi: false,
  })],
  ['上传简历并创建候选人', Object.freeze({
    properties: Object.freeze(['openFile']),
    kind: 'file',
    extensions: Object.freeze(['.pdf', '.doc', '.docx', '.rtf', '.txt']),
    multi: false,
  })],
  ['手动上传候选人简历', Object.freeze({
    properties: Object.freeze(['openFile']),
    kind: 'file',
    extensions: Object.freeze(['.pdf', '.doc', '.docx', '.rtf', '.txt']),
    multi: false,
  })],
  ['选择一份或多份 PDF 测评报告', Object.freeze({
    properties: Object.freeze(['multiSelections', 'openFile']),
    kind: 'file',
    extensions: Object.freeze(['.pdf']),
    multi: true,
  })],
  ['重新选择一份失败的 PDF 测评报告', Object.freeze({
    properties: Object.freeze(['openFile']),
    kind: 'file',
    extensions: Object.freeze(['.pdf']),
    multi: false,
  })],
]));

class TestNativeFileSelectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TestNativeFileSelectionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new TestNativeFileSelectionError(code, message);
}

function requiredSecret(value) {
  const secret = String(value || '');
  if (secret.length < 32 || secret.length > 512) {
    fail('TEST_SELECTION_SECRET_INVALID', 'Synthetic native selection secret is unavailable.');
  }
  return secret;
}

function timingSafeSignature(secret, encoded) {
  return crypto.createHmac('sha256', secret).update(encoded, 'utf8').digest('base64url');
}

function assertPrivateMode(stat, label) {
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    fail('TEST_SELECTION_PERMISSIONS_UNSAFE', `${label} must not be accessible by group or other users.`);
  }
}

function resolvePrivateRoot(rootInput) {
  const root = path.resolve(String(rootInput || ''));
  let stat;
  try {
    stat = fs.lstatSync(root);
  } catch {
    fail('TEST_SELECTION_ROOT_INVALID', 'Synthetic native selection root is unavailable.');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail('TEST_SELECTION_ROOT_INVALID', 'Synthetic native selection root must be a real directory.');
  }
  assertPrivateMode(stat, 'Synthetic native selection root');
  const real = fs.realpathSync(root);
  if (real !== root) fail('TEST_SELECTION_ROOT_INVALID', 'Synthetic native selection root must be canonical.');
  return real;
}

function assertInsideRoot(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('TEST_SELECTION_PATH_OUTSIDE_ROOT', 'Synthetic native selection path must stay inside its private root.');
  }
}

function fingerprint(stat) {
  return Object.freeze({
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    mode: Number(stat.mode),
    size: Number(stat.size),
    mtime_ms: Math.trunc(Number(stat.mtimeMs)),
  });
}

function sameFingerprint(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtime_ms === right.mtime_ms;
}

function validateSelectionPath(root, inputPath, contract, expectedFingerprint = null) {
  const selected = path.resolve(String(inputPath || ''));
  assertInsideRoot(root, selected);
  let stat;
  try {
    stat = fs.lstatSync(selected);
  } catch {
    fail('TEST_SELECTION_PATH_INVALID', 'Synthetic native selection path is unavailable.');
  }
  if (stat.isSymbolicLink()) fail('TEST_SELECTION_PATH_INVALID', 'Synthetic native selection path must not be a symlink.');
  if (contract.kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
    fail('TEST_SELECTION_PATH_TYPE_INVALID', 'Synthetic native selection path has the wrong file type.');
  }
  assertPrivateMode(stat, 'Synthetic native selection path');
  const real = fs.realpathSync(selected);
  if (real !== selected) fail('TEST_SELECTION_PATH_INVALID', 'Synthetic native selection path must be canonical.');
  assertInsideRoot(root, real);
  if (contract.extensions && !contract.extensions.includes(path.extname(real).toLowerCase())) {
    fail('TEST_SELECTION_EXTENSION_INVALID', 'Synthetic native selection file type is not allowed for this dialog.');
  }
  const currentFingerprint = fingerprint(stat);
  if (expectedFingerprint && !sameFingerprint(currentFingerprint, expectedFingerprint)) {
    fail('TEST_SELECTION_PATH_CHANGED', 'Synthetic native selection path changed after the plan was signed.');
  }
  return Object.freeze({ path: real, fingerprint: currentFingerprint });
}

function normalizedProperties(properties) {
  if (!Array.isArray(properties)) return [];
  return [...new Set(properties.map((value) => String(value)))].sort();
}

function normalizeEntry(root, input) {
  const title = String(input && input.title || '');
  const contract = DIALOG_CONTRACTS.get(title);
  if (!contract) fail('TEST_SELECTION_DIALOG_INVALID', 'Synthetic native selection dialog is not allowlisted.');
  const requestedProperties = normalizedProperties(input.properties);
  if (JSON.stringify(requestedProperties) !== JSON.stringify(contract.properties)) {
    fail('TEST_SELECTION_DIALOG_INVALID', 'Synthetic native selection dialog properties do not match the allowlist.');
  }
  const paths = Array.isArray(input.paths) ? input.paths : [];
  if (!paths.length || (!contract.multi && paths.length !== 1) || paths.length > 8) {
    fail('TEST_SELECTION_COUNT_INVALID', 'Synthetic native selection path count is invalid.');
  }
  return Object.freeze({
    title,
    properties: contract.properties,
    paths: Object.freeze(paths.map((selectedPath) => validateSelectionPath(root, selectedPath, contract))),
  });
}

function encodePlan(secretInput, input, options = {}) {
  const secret = requiredSecret(secretInput);
  const root = resolvePrivateRoot(input && input.synthetic_root);
  const entries = Array.isArray(input && input.entries)
    ? input.entries.map((entry) => normalizeEntry(root, entry))
    : [];
  if (!entries.length || entries.length > 16) {
    fail('TEST_SELECTION_ENTRIES_INVALID', 'Synthetic native selection plan must contain a bounded non-empty queue.');
  }
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  const payload = {
    version: PLAN_VERSION,
    marker: PLAN_MARKER,
    synthetic_root: root,
    issued_at: now,
    expires_at: now + PLAN_TTL_MS,
    nonce: crypto.randomBytes(18).toString('base64url'),
    entries,
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return Object.freeze({ encoded, signature: timingSafeSignature(secret, encoded) });
}

function parseSignedPlan(secretInput, signedPlan, options = {}) {
  const secret = requiredSecret(secretInput);
  const encoded = String(signedPlan && signedPlan.encoded || '');
  const supplied = String(signedPlan && signedPlan.signature || '');
  if (!encoded || !supplied || encoded.length > MAX_PLAN_BYTES * 2) {
    fail('TEST_SELECTION_PLAN_INVALID', 'Synthetic native selection plan is invalid.');
  }
  const expected = timingSafeSignature(secret, encoded);
  const left = Buffer.from(supplied, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    fail('TEST_SELECTION_PLAN_INVALID', 'Synthetic native selection plan signature is invalid.');
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    fail('TEST_SELECTION_PLAN_INVALID', 'Synthetic native selection plan payload is invalid.');
  }
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now();
  if (!payload
    || payload.version !== PLAN_VERSION
    || payload.marker !== PLAN_MARKER
    || !Number.isFinite(payload.issued_at)
    || !Number.isFinite(payload.expires_at)
    || payload.expires_at - payload.issued_at !== PLAN_TTL_MS
    || payload.expires_at <= now
    || payload.issued_at > now + 30_000
    || typeof payload.nonce !== 'string'
    || payload.nonce.length < 20) {
    fail('TEST_SELECTION_PLAN_EXPIRED', 'Synthetic native selection plan is invalid or expired.');
  }
  const root = resolvePrivateRoot(payload.synthetic_root);
  const normalizedEntries = Array.isArray(payload.entries)
    ? payload.entries.map((entry) => normalizeEntry(root, {
      title: entry.title,
      properties: entry.properties,
      paths: Array.isArray(entry.paths) ? entry.paths.map((item) => item.path) : [],
    }))
    : [];
  if (!normalizedEntries.length || normalizedEntries.length > 16) {
    fail('TEST_SELECTION_ENTRIES_INVALID', 'Synthetic native selection plan queue is invalid.');
  }
  const verifiedEntries = payload.entries.map((entry, index) => {
    const contract = DIALOG_CONTRACTS.get(entry.title);
    const normalized = normalizedEntries[index];
    const verifiedPaths = normalized.paths.map((item, pathIndex) => {
      const expectedFingerprint = entry.paths[pathIndex] && entry.paths[pathIndex].fingerprint;
      return validateSelectionPath(root, item.path, contract, expectedFingerprint);
    });
    return Object.freeze({ ...normalized, paths: Object.freeze(verifiedPaths) });
  });
  return Object.freeze({ root, nonce: payload.nonce, entries: Object.freeze(verifiedEntries) });
}

function readPlanFile(planPathInput) {
  const planPath = path.resolve(String(planPathInput || ''));
  let stat;
  try {
    stat = fs.lstatSync(planPath);
  } catch {
    fail('TEST_SELECTION_PLAN_FILE_INVALID', 'Synthetic native selection plan file is unavailable.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_PLAN_BYTES) {
    fail('TEST_SELECTION_PLAN_FILE_INVALID', 'Synthetic native selection plan file is invalid.');
  }
  assertPrivateMode(stat, 'Synthetic native selection plan file');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  } catch {
    fail('TEST_SELECTION_PLAN_FILE_INVALID', 'Synthetic native selection plan file cannot be parsed.');
  }
  return Object.freeze({ planPath, parsed });
}

function loadSignedPlan({ marker, planPath, secret, now } = {}) {
  if (marker !== PLAN_MARKER) fail('TEST_SELECTION_MARKER_INVALID', 'Synthetic native selection marker is missing.');
  const file = readPlanFile(planPath);
  const verified = parseSignedPlan(secret, file.parsed, { now });
  assertInsideRoot(verified.root, file.planPath);
  return Object.freeze({ ...verified, planPath: file.planPath });
}

function createSelectionQueue(plan) {
  const queue = [...plan.entries];
  let consumed = 0;
  return Object.freeze({
    next(options = {}) {
      const entry = queue.shift();
      if (!entry) fail('TEST_SELECTION_QUEUE_EXHAUSTED', 'Synthetic native selection queue is exhausted.');
      const title = String(options.title || '');
      const properties = normalizedProperties(options.properties);
      if (title !== entry.title || JSON.stringify(properties) !== JSON.stringify(entry.properties)) {
        fail('TEST_SELECTION_DIALOG_MISMATCH', 'Synthetic native selection dialog did not match the signed queue.');
      }
      const contract = DIALOG_CONTRACTS.get(entry.title);
      const paths = entry.paths.map((item) => validateSelectionPath(plan.root, item.path, contract, item.fingerprint).path);
      consumed += 1;
      return Object.freeze({ canceled: false, filePaths: Object.freeze(paths) });
    },
    remaining() {
      return queue.length;
    },
    consumed() {
      return consumed;
    },
  });
}

module.exports = {
  DIALOG_CONTRACTS,
  ENV_KEYS,
  PLAN_MARKER,
  PLAN_TTL_MS,
  TestNativeFileSelectionError,
  createSelectionQueue,
  encodePlan,
  loadSignedPlan,
  parseSignedPlan,
};
