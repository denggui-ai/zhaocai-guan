const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writePrivateFile } = require('./secure-fs');

const SCHEMA_VERSION = 1;
const STATE_BASENAME = 'task-run-state.json';
const TASK_TYPES = Object.freeze([
  'boss_read',
  'boss_write',
  'local_read',
  'local_write',
]);
const OPERATION_CLASSES = Object.freeze(['read', 'write']);
const STATUSES = Object.freeze([
  'running',
  'succeeded',
  'failed',
  'hard_stopped',
  'interrupted',
]);
const ERROR_CODES = Object.freeze([
  'TASK_FAILED',
  'HARD_STOP',
  'PROCESS_INTERRUPTED',
]);

const TOP_LEVEL_FIELDS = new Set(['schema_version', 'runs']);
const RUN_FIELDS = new Set([
  'request_id',
  'task_type',
  'run_id',
  'trace_id',
  'attempt',
  'status',
  'error_code',
  'created_at',
  'updated_at',
  'started_at',
  'finished_at',
  'operation_class',
]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function fail(message) {
  throw new Error(message);
}

function assertExactFields(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) fail(`${label} contains unsupported field`);
  }
}

function assertToken(value, label) {
  if (typeof value !== 'string' || !TOKEN.test(value)) fail(`${label} is invalid`);
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value) {
    fail(`${label} is invalid`);
  }
}

function assertOperationMatchesTask(taskType, operationClass) {
  const expected = taskType.endsWith('_write') ? 'write' : 'read';
  if (operationClass !== expected) fail('operation_class does not match task_type');
}

function assertStatePath(statePath) {
  if (typeof statePath !== 'string' || !path.isAbsolute(statePath)) fail('statePath must be absolute');
  if (path.basename(statePath) !== STATE_BASENAME) fail('statePath filename is not allowed');
  const parent = path.dirname(statePath);
  if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) fail('statePath parent must not be a symlink');
  if (fs.existsSync(statePath) && fs.lstatSync(statePath).isSymbolicLink()) fail('statePath must not be a symlink');
  return path.resolve(statePath);
}

function validateRun(run) {
  assertExactFields(run, RUN_FIELDS, 'run');
  for (const field of ['request_id', 'run_id', 'trace_id']) assertToken(run[field], field);
  if (!TASK_TYPES.includes(run.task_type)) fail('task_type is invalid');
  if (!OPERATION_CLASSES.includes(run.operation_class)) fail('operation_class is invalid');
  assertOperationMatchesTask(run.task_type, run.operation_class);
  if (!STATUSES.includes(run.status)) fail('status is invalid');
  if (!Number.isSafeInteger(run.attempt) || run.attempt < 1) fail('attempt is invalid');
  for (const field of ['created_at', 'updated_at', 'started_at']) assertIsoTimestamp(run[field], field);
  if (run.finished_at !== null) assertIsoTimestamp(run.finished_at, 'finished_at');
  if (run.status === 'running') {
    if (run.error_code !== null || run.finished_at !== null) fail('running state is inconsistent');
  } else {
    if (run.finished_at === null) fail('terminal state requires finished_at');
    if (run.status === 'succeeded' && run.error_code !== null) fail('succeeded state must not have error_code');
    if (run.status !== 'succeeded' && !ERROR_CODES.includes(run.error_code)) fail('terminal error_code is invalid');
  }
  return run;
}

function validateState(state) {
  assertExactFields(state, TOP_LEVEL_FIELDS, 'state');
  if (state.schema_version !== SCHEMA_VERSION || !Array.isArray(state.runs)) fail('state schema is invalid');
  const requestIds = new Set();
  const runIds = new Set();
  for (const run of state.runs) {
    validateRun(run);
    if (requestIds.has(run.request_id) || runIds.has(run.run_id)) fail('state contains duplicate identity');
    requestIds.add(run.request_id);
    runIds.add(run.run_id);
  }
  return state;
}

function sameStartIdentity(existing, input) {
  return existing.request_id === input.requestId
    && existing.run_id === input.runId
    && existing.trace_id === input.traceId
    && existing.task_type === input.taskType
    && existing.attempt === input.attempt
    && existing.operation_class === input.operationClass;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createTaskRunState({ statePath, clock = () => new Date() }) {
  const file = assertStatePath(statePath);
  if (typeof clock !== 'function') fail('clock must be a function');

  function now() {
    const value = clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) fail('clock returned an invalid timestamp');
    return date.toISOString();
  }

  function loadSnapshot() {
    assertStatePath(file);
    if (!fs.existsSync(file)) {
      return { state: { schema_version: SCHEMA_VERSION, runs: [] }, fingerprint: null };
    }
    let raw;
    let parsed;
    try {
      raw = fs.readFileSync(file, 'utf8');
      parsed = JSON.parse(raw);
    } catch (_) {
      fail('state file is invalid');
    }
    return { state: validateState(parsed), fingerprint: fingerprint(raw) };
  }

  function save(state, expectedFingerprint) {
    validateState(state);
    assertStatePath(file);
    const temp = path.join(
      path.dirname(file),
      `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    try {
      // Exclusive creation plus an unpredictable service-owned name prevents a
      // pre-created symlink from being followed by secure-fs.
      writePrivateFile(temp, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      // Opened for write, not read: Windows FlushFileBuffers needs write access
      // on the handle and fails the whole save with EPERM without it, while
      // POSIX would happily fsync a read-only descriptor. O_NOFOLLOW still keeps
      // the symlink guarantee the exclusive create above establishes.
      const descriptor = fs.openSync(
        temp,
        fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0),
      );
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      assertStatePath(file);
      const currentFingerprint = fs.existsSync(file)
        ? fingerprint(fs.readFileSync(file, 'utf8'))
        : null;
      if (currentFingerprint !== expectedFingerprint) fail('concurrent state modification');
      fs.renameSync(temp, file);
      if (process.platform !== 'win32') {
        const parentDescriptor = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
        try {
          fs.fsyncSync(parentDescriptor);
        } finally {
          fs.closeSync(parentDescriptor);
        }
      }
    } finally {
      // On a normal error path, never leave the service-owned partial file.
      // A process crash may leave a temp file, which load() deliberately ignores.
      if (fs.existsSync(temp) && !fs.lstatSync(temp).isSymbolicLink()) fs.unlinkSync(temp);
    }
  }

  function read() {
    return clone(loadSnapshot().state);
  }

  function startRun(input) {
    const allowed = new Set(['requestId', 'taskType', 'runId', 'traceId', 'attempt', 'operationClass']);
    assertExactFields(input, allowed, 'start input');
    assertToken(input.requestId, 'requestId');
    assertToken(input.runId, 'runId');
    assertToken(input.traceId, 'traceId');
    if (!TASK_TYPES.includes(input.taskType)) fail('taskType is invalid');
    if (!OPERATION_CLASSES.includes(input.operationClass)) fail('operationClass is invalid');
    assertOperationMatchesTask(input.taskType, input.operationClass);
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1) fail('attempt is invalid');

    const snapshot = loadSnapshot();
    const state = snapshot.state;
    const existing = state.runs.find((run) => run.request_id === input.requestId || run.run_id === input.runId);
    if (existing) {
      if (!sameStartIdentity(existing, input)) fail('request/run identity conflict');
      return clone(existing);
    }
    const timestamp = now();
    const run = {
      request_id: input.requestId,
      task_type: input.taskType,
      run_id: input.runId,
      trace_id: input.traceId,
      attempt: input.attempt,
      status: 'running',
      error_code: null,
      created_at: timestamp,
      updated_at: timestamp,
      started_at: timestamp,
      finished_at: null,
      operation_class: input.operationClass,
    };
    state.runs.push(run);
    save(state, snapshot.fingerprint);
    return clone(run);
  }

  function transitionRun(input) {
    const allowed = new Set(['requestId', 'runId', 'status', 'errorCode']);
    assertExactFields(input, allowed, 'transition input');
    assertToken(input.requestId, 'requestId');
    assertToken(input.runId, 'runId');
    if (!STATUSES.includes(input.status) || input.status === 'running') fail('target status is invalid');
    const expectedError = input.status === 'succeeded'
      ? null
      : ({ failed: 'TASK_FAILED', hard_stopped: 'HARD_STOP', interrupted: 'PROCESS_INTERRUPTED' })[input.status];
    if ((input.errorCode ?? null) !== expectedError) fail('errorCode does not match target status');

    const snapshot = loadSnapshot();
    const state = snapshot.state;
    const run = state.runs.find((item) => item.request_id === input.requestId && item.run_id === input.runId);
    if (!run) fail('run was not found');
    if (run.status !== 'running') {
      if (run.status === input.status && run.error_code === expectedError) return clone(run);
      fail('illegal terminal state transition');
    }
    const timestamp = now();
    run.status = input.status;
    run.error_code = expectedError;
    run.updated_at = timestamp;
    run.finished_at = timestamp;
    save(state, snapshot.fingerprint);
    return clone(run);
  }

  function recoverInterrupted() {
    const snapshot = loadSnapshot();
    const state = snapshot.state;
    const timestamp = now();
    let recovered = 0;
    for (const run of state.runs) {
      if (run.status !== 'running') continue;
      run.status = 'interrupted';
      run.error_code = 'PROCESS_INTERRUPTED';
      run.updated_at = timestamp;
      run.finished_at = timestamp;
      recovered += 1;
    }
    if (recovered > 0) save(state, snapshot.fingerprint);
    return { recovered, auto_retried: 0, write_auto_retried: 0 };
  }

  return { read, startRun, transitionRun, recoverInterrupted };
}

module.exports = {
  SCHEMA_VERSION,
  STATE_BASENAME,
  TASK_TYPES,
  OPERATION_CLASSES,
  STATUSES,
  ERROR_CODES,
  createTaskRunState,
};
