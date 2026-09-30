'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { STATE_BASENAME } = require('./task-run-state');
const {
  createScreenshotImportObserver,
  screenshotImportFailurePolicy,
} = require('./start-screenshot-import');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f014-screenshot-observability-'));
const statePath = path.join(root, STATE_BASENAME);
let tick = 0;
let id = 0;
const clock = () => new Date(Date.UTC(2026, 6, 12, 4, 0, tick++));
const idFactory = (prefix) => `${prefix}-synthetic-${String(++id).padStart(3, '0')}`;

function assertWriteHardStop(observer, origin) {
  const run = observer.startRun();
  const result = observer.finishFailed(run, screenshotImportFailurePolicy(origin));
  assert.equal(result.state.status, 'hard_stopped');
  assert.equal(result.state.error_code, 'HARD_STOP');
  assert.equal(result.policy.error_code, 'TASK_WRITE_FAILED');
  assert.equal(result.policy.retry_disposition, 'no_retry');
  assert.equal(result.policy.hard_stop, true);
  assert.equal(result.auto_retried, 0);
}

try {
  let observer = createScreenshotImportObserver({ statePath, clock, idFactory });
  const crashed = observer.startRun();
  assert.equal(crashed.task_type, 'local_write');
  assert.equal(crashed.operation_class, 'write');
  assert.equal(crashed.status, 'running');

  observer = createScreenshotImportObserver({ statePath, clock, idFactory });
  assert.deepEqual(observer.recoverInterrupted(), {
    recovered: 1,
    auto_retried: 0,
    write_auto_retried: 0,
  });
  assert.equal(observer.read().runs[0].status, 'interrupted');

  for (const origin of [
    'input_path',
    'evidence_batch_begin',
    'ocr',
    'stitch',
    'evidence_batch_commit',
    'ingest',
  ]) {
    assertWriteHardStop(observer, origin);
  }

  const successful = observer.startRun();
  assert.equal(observer.finishSucceeded(successful).status, 'succeeded');

  const state = observer.read();
  assert.equal(state.runs.filter((run) => run.status === 'running').length, 0);
  assert.equal(state.runs.filter((run) => run.status === 'hard_stopped').length, 6);
  assert.equal(state.runs.filter((run) => run.status === 'succeeded').length, 1);

  const serialized = fs.readFileSync(statePath, 'utf8').toLowerCase();
  for (const forbidden of [
    'img_5005.png',
    'private-source-dir',
    'candidate',
    'ocr extracted content',
    '/users/',
    'path',
    'message',
    'payload',
  ]) {
    assert.equal(serialized.includes(forbidden), false, `state leaked ${forbidden}`);
  }
  if (process.platform !== 'win32') assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);

  const productionEntry = fs.readFileSync(path.join(__dirname, 'start-screenshot-import.js'), 'utf8');
  assert.match(productionEntry, /createTaskObserver/);
  assert.match(productionEntry, /taskType:\s*'local_write'/);
  assert.match(productionEntry, /operationClass:\s*'write'/);
  assert.match(productionEntry, /taskObserver\.recoverInterrupted\(\)/);
  assert.match(productionEntry, /finishTaskObservationSucceeded\(\)/);
  assert.match(productionEntry, /finishTaskObservationFailed\(\)/);

  console.log(JSON.stringify({
    check: 'f014_screenshot_observability',
    status: 'passed',
    restart_recovery: 'interrupted_no_auto_retry',
    write_failures: 'hard_stop_no_retry',
  }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
