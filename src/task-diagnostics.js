const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { hardenPrivateDir, writePrivateFile } = require('./secure-fs');

const DIAGNOSTIC_SCHEMA_VERSION = '1';
const MAX_COUNT = 1_000_000_000;
const INPUT_FIELDS = new Set([
  'app_version',
  'app_schema_version',
  'task_id',
  'run_id',
  'trace_id',
  'status',
  'error_code',
  'started_at',
  'finished_at',
  'platform_category',
  'counts',
]);
const COUNT_FIELDS = new Set([
  'attempt_count',
  'warning_count',
  'error_count',
  'operation_count',
]);
const STATUSES = new Set(['running', 'succeeded', 'failed', 'hard_stopped', 'interrupted']);
const PLATFORM_CATEGORIES = new Set(['darwin', 'windows', 'linux', 'other']);
const ERROR_CODES = new Set([
  'TASK_BOSS_RISK_36',
  'TASK_BOSS_RISK_121',
  'TASK_BOSS_RISK_122',
  'TASK_SECURITY_CHECK',
  'TASK_ACCESS_RESTRICTED',
  'TASK_WRITE_FAILED',
  'TASK_LOCAL_READ_TIMEOUT',
  'TASK_LOCAL_READ_TEMPORARY_IO',
  'TASK_UNKNOWN_FAILURE',
  'TASK_FAILED',
  'HARD_STOP',
  'PROCESS_INTERRUPTED',
]);
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

class TaskDiagnosticsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TaskDiagnosticsError';
    this.code = code;
  }
}

function diagnosticError(code, message) {
  return new TaskDiagnosticsError(code, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactFields(value, allowed, code) {
  if (!isPlainObject(value)) {
    throw diagnosticError(code, '诊断数据结构无效。');
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw diagnosticError(code, '诊断数据包含未允许字段。');
  }
}

function requirePattern(value, pattern, code) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw diagnosticError(code, '诊断数据字段无效。');
  }
  return value;
}

function requireTimestamp(value, nullable, code) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) {
    throw diagnosticError(code, '诊断时间字段无效。');
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw diagnosticError(code, '诊断时间字段无效。');
  }
  return value;
}

function normalizeCounts(value) {
  assertExactFields(value, COUNT_FIELDS, 'TASK_DIAGNOSTICS_COUNTS_INVALID');
  const normalized = {};
  for (const field of COUNT_FIELDS) {
    if (!Object.hasOwn(value, field)
      || !Number.isSafeInteger(value[field])
      || value[field] < 0
      || value[field] > MAX_COUNT) {
      throw diagnosticError('TASK_DIAGNOSTICS_COUNTS_INVALID', '诊断计数字段无效。');
    }
    normalized[field] = value[field];
  }
  return normalized;
}

function normalizeInput(input) {
  assertExactFields(input, INPUT_FIELDS, 'TASK_DIAGNOSTICS_INPUT_INVALID');

  const status = requirePattern(input.status, IDENTIFIER_PATTERN, 'TASK_DIAGNOSTICS_STATUS_INVALID');
  if (!STATUSES.has(status)) {
    throw diagnosticError('TASK_DIAGNOSTICS_STATUS_INVALID', '诊断状态字段无效。');
  }
  if (!PLATFORM_CATEGORIES.has(input.platform_category)) {
    throw diagnosticError('TASK_DIAGNOSTICS_PLATFORM_INVALID', '诊断平台类别无效。');
  }

  let errorCode = null;
  if (input.error_code !== null) {
    if (typeof input.error_code !== 'string' || !ERROR_CODES.has(input.error_code)) {
      throw diagnosticError('TASK_DIAGNOSTICS_ERROR_CODE_INVALID', '诊断错误代码无效。');
    }
    errorCode = input.error_code;
  }

  return {
    diagnostic_schema_version: DIAGNOSTIC_SCHEMA_VERSION,
    app_version: requirePattern(input.app_version, VERSION_PATTERN, 'TASK_DIAGNOSTICS_VERSION_INVALID'),
    app_schema_version: requirePattern(
      input.app_schema_version,
      VERSION_PATTERN,
      'TASK_DIAGNOSTICS_VERSION_INVALID',
    ),
    task_id: requirePattern(input.task_id, IDENTIFIER_PATTERN, 'TASK_DIAGNOSTICS_ID_INVALID'),
    run_id: requirePattern(input.run_id, IDENTIFIER_PATTERN, 'TASK_DIAGNOSTICS_ID_INVALID'),
    trace_id: requirePattern(input.trace_id, IDENTIFIER_PATTERN, 'TASK_DIAGNOSTICS_ID_INVALID'),
    status,
    error_code: errorCode,
    started_at: requireTimestamp(input.started_at, false, 'TASK_DIAGNOSTICS_TIME_INVALID'),
    finished_at: requireTimestamp(input.finished_at, true, 'TASK_DIAGNOSTICS_TIME_INVALID'),
    platform_category: input.platform_category,
    counts: normalizeCounts(input.counts),
  };
}

function sameCanonicalPath(left, right) {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  if (process.platform === 'win32') {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }
  return normalizedLeft === normalizedRight;
}

function prepareOutputRoot(rootInput) {
  if (typeof rootInput !== 'string'
    || !rootInput
    || rootInput.includes('\0')
    || !path.isAbsolute(rootInput)
    || path.normalize(rootInput) !== rootInput
    || path.basename(rootInput) !== 'task-diagnostics') {
    throw diagnosticError('TASK_DIAGNOSTICS_ROOT_INVALID', '诊断输出目录无效。');
  }

  try {
    let nearestExisting = rootInput;
    while (!fs.existsSync(nearestExisting)) {
      const parent = path.dirname(nearestExisting);
      if (parent === nearestExisting) break;
      nearestExisting = parent;
    }
    const ancestorStat = fs.lstatSync(nearestExisting);
    if (ancestorStat.isSymbolicLink()
      || !ancestorStat.isDirectory()
      || !sameCanonicalPath(fs.realpathSync(nearestExisting), nearestExisting)) {
      throw diagnosticError('TASK_DIAGNOSTICS_ROOT_INVALID', '诊断输出目录无效。');
    }

    hardenPrivateDir(rootInput);
    const stat = fs.lstatSync(rootInput);
    if (stat.isSymbolicLink()
      || !stat.isDirectory()
      || !sameCanonicalPath(fs.realpathSync(rootInput), rootInput)) {
      throw diagnosticError('TASK_DIAGNOSTICS_ROOT_INVALID', '诊断输出目录无效。');
    }
    return { path: rootInput, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error instanceof TaskDiagnosticsError) throw error;
    throw diagnosticError('TASK_DIAGNOSTICS_ROOT_INVALID', '诊断输出目录无效。');
  }
}

function assertRootUnchanged(root) {
  const stat = fs.lstatSync(root.path);
  if (stat.isSymbolicLink()
    || !stat.isDirectory()
    || stat.dev !== root.dev
    || stat.ino !== root.ino
    || !sameCanonicalPath(fs.realpathSync(root.path), root.path)) {
    throw diagnosticError('TASK_DIAGNOSTICS_ROOT_CHANGED', '诊断输出目录已发生变化。');
  }
}

function writeTaskDiagnostics(input, options = {}) {
  const document = normalizeInput(input);
  const root = prepareOutputRoot(options.outputRoot);
  const diagnosticId = crypto.randomUUID();
  const filename = `task-diagnostics-${diagnosticId}.json`;
  const target = path.join(root.path, filename);
  let completed = false;

  try {
    assertRootUnchanged(root);
    writePrivateFile(target, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' });
    assertRootUnchanged(root);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw diagnosticError('TASK_DIAGNOSTICS_WRITE_FAILED', '诊断包写入失败。');
    }
    completed = true;
    return { diagnostic_id: diagnosticId, state: 'written' };
  } catch (error) {
    if (error instanceof TaskDiagnosticsError) throw error;
    throw diagnosticError('TASK_DIAGNOSTICS_WRITE_FAILED', '诊断包写入失败。');
  } finally {
    if (!completed) {
      try { fs.rmSync(target, { force: true }); } catch {}
    }
  }
}

module.exports = {
  DIAGNOSTIC_SCHEMA_VERSION,
  TaskDiagnosticsError,
  writeTaskDiagnostics,
};
