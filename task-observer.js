'use strict';

const crypto = require('crypto');
const path = require('path');

const { createTaskRunState } = require('./task-run-state');
const { resolveTaskErrorPolicy } = require('./task-error-policy');
const { writeTaskDiagnostics } = require('./task-diagnostics');
const { version: appVersion } = require('./package.json');

function newToken(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function runIdentity(run) {
  if (!run || typeof run !== 'object') throw new Error('task run is required');
  return { requestId: run.request_id, runId: run.run_id };
}

function platformCategory(platform = process.platform) {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'win32') return 'windows';
  if (platform === 'linux') return 'linux';
  return 'other';
}

function createTaskObserver(options = {}) {
  const store = createTaskRunState({
    statePath: options.statePath,
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const idFactory = typeof options.idFactory === 'function' ? options.idFactory : newToken;
  const taskType = options.taskType;
  const operationClass = options.operationClass;
  const diagnosticsRoot = options.diagnosticsRoot || process.env.HRBOSS_TASK_DIAGNOSTICS_ROOT || '';

  function writeFailureDiagnostic(state) {
    if (!diagnosticsRoot) return null;
    try {
      return writeTaskDiagnostics({
        app_version: appVersion,
        app_schema_version: '1',
        task_id: taskType,
        run_id: state.run_id,
        trace_id: state.trace_id,
        status: state.status,
        error_code: state.error_code,
        started_at: state.started_at,
        finished_at: state.finished_at,
        platform_category: platformCategory(),
        counts: {
          attempt_count: state.attempt,
          warning_count: 0,
          error_count: 1,
          operation_count: 1,
        },
      }, { outputRoot: path.resolve(diagnosticsRoot) });
    } catch {
      console.error('任务诊断包写入失败。');
      return null;
    }
  }

  function recoverInterrupted() {
    return store.recoverInterrupted();
  }

  function startRun(input = {}) {
    return store.startRun({
      requestId: input.requestId || idFactory('request'),
      taskType,
      runId: input.runId || idFactory('run'),
      traceId: input.traceId || idFactory('trace'),
      attempt: input.attempt === undefined ? 1 : input.attempt,
      operationClass,
    });
  }

  function finishSucceeded(run) {
    return store.transitionRun({ ...runIdentity(run), status: 'succeeded', errorCode: null });
  }

  function finishFailed(run, policyInput) {
    const policy = resolveTaskErrorPolicy(policyInput);
    const status = policy.hard_stop ? 'hard_stopped' : 'failed';
    const state = store.transitionRun({
      ...runIdentity(run),
      status,
      errorCode: status === 'hard_stopped' ? 'HARD_STOP' : 'TASK_FAILED',
    });
    const diagnostic = writeFailureDiagnostic(state);
    return Object.freeze({ state, policy, diagnostic, auto_retried: 0 });
  }

  return Object.freeze({ recoverInterrupted, startRun, finishSucceeded, finishFailed, read: store.read });
}

module.exports = { createTaskObserver };
