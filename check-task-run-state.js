const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTaskRunState, STATE_BASENAME } = require('./task-run-state');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-task-run-state-'));
const statePath = path.join(root, STATE_BASENAME);
let tick = 0;
const clock = () => new Date(Date.UTC(2026, 6, 12, 1, 0, tick++));

function startInput(overrides = {}) {
  return {
    requestId: 'request-001',
    taskType: 'boss_read',
    runId: 'run-001',
    traceId: 'trace-001',
    attempt: 1,
    operationClass: 'read',
    ...overrides,
  };
}

function rejects(fn, pattern) {
  assert.throws(fn, pattern);
}

try {
  rejects(() => createTaskRunState({ statePath: 'relative.json' }), /absolute/);
  rejects(() => createTaskRunState({ statePath: path.join(root, 'other.json') }), /filename/);

  const store = createTaskRunState({ statePath, clock });
  const first = store.startRun(startInput());
  assert.equal(first.status, 'running');
  assert.equal(first.error_code, null);
  assert.equal(fs.statSync(statePath).mode & 0o777, process.platform === 'win32' ? fs.statSync(statePath).mode & 0o777 : 0o600);
  if (process.platform !== 'win32') assert.equal(fs.statSync(root).mode & 0o777, 0o700);

  // A crash-left invalid temp file is never treated as the registry and cannot
  // replace an already valid official file.
  const officialBeforeStaleTemp = fs.readFileSync(statePath, 'utf8');
  const staleTemp = path.join(root, `.${STATE_BASENAME}.stale.tmp`);
  fs.writeFileSync(staleTemp, '{invalid partial json', { mode: 0o600 });
  assert.equal(createTaskRunState({ statePath, clock }).read().runs[0].run_id, 'run-001');
  assert.equal(fs.readFileSync(statePath, 'utf8'), officialBeforeStaleTemp);
  fs.unlinkSync(staleTemp);

  // Identical request/run creation is idempotent; either identity changing is a conflict.
  assert.deepEqual(store.startRun(startInput()), first);
  assert.deepEqual(fs.readdirSync(root), [STATE_BASENAME]);
  rejects(() => store.startRun(startInput({ runId: 'run-conflict' })), /conflict/);
  rejects(() => store.startRun(startInput({ requestId: 'request-conflict' })), /conflict/);
  rejects(() => store.startRun({ ...startInput(), payload: { candidateName: 'synthetic' } }), /unsupported field/);
  rejects(() => store.startRun({ ...startInput({ requestId: 'request-002', runId: 'run-002' }), token: 'secret' }), /unsupported field/);
  rejects(() => store.startRun(startInput({
    requestId: 'request-002', runId: 'run-002', taskType: 'boss_write', operationClass: 'read',
  })), /does not match/);

  // A failed atomic replacement preserves the old registry and cleans its temp.
  const officialBeforeFailedRename = fs.readFileSync(statePath, 'utf8');
  const originalRenameSync = fs.renameSync;
  fs.renameSync = () => { throw new Error('synthetic rename failure'); };
  try {
    rejects(() => store.startRun(startInput({
      requestId: 'request-rename-failure',
      runId: 'run-rename-failure',
      traceId: 'trace-rename-failure',
    })), /synthetic rename failure/);
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(fs.readFileSync(statePath, 'utf8'), officialBeforeFailedRename);
  assert.deepEqual(fs.readdirSync(root), [STATE_BASENAME]);

  // Optimistic compare-and-swap prevents a concurrent process from being
  // silently overwritten. The losing writer fails closed and never retries.
  const originalFsyncSync = fs.fsyncSync;
  let injectedConcurrentWrite = false;
  fs.fsyncSync = (descriptor) => {
    originalFsyncSync(descriptor);
    if (injectedConcurrentWrite) return;
    injectedConcurrentWrite = true;
    createTaskRunState({ statePath, clock }).startRun(startInput({
      requestId: 'request-concurrent-winner',
      runId: 'run-concurrent-winner',
      traceId: 'trace-concurrent-winner',
    }));
  };
  try {
    rejects(() => store.startRun(startInput({
      requestId: 'request-concurrent-loser',
      runId: 'run-concurrent-loser',
      traceId: 'trace-concurrent-loser',
    })), /concurrent state modification/);
  } finally {
    fs.fsyncSync = originalFsyncSync;
  }
  const afterConcurrentConflict = createTaskRunState({ statePath, clock }).read().runs;
  assert.ok(afterConcurrentConflict.some((run) => run.run_id === 'run-concurrent-winner'));
  assert.ok(!afterConcurrentConflict.some((run) => run.run_id === 'run-concurrent-loser'));
  assert.deepEqual(fs.readdirSync(root), [STATE_BASENAME]);

  // Reload alone preserves running. Recovery must be explicit and never retries a read or a write.
  const reloaded = createTaskRunState({ statePath, clock });
  assert.equal(reloaded.read().runs[0].status, 'running');
  reloaded.startRun(startInput({
    requestId: 'request-write',
    runId: 'run-write',
    traceId: 'trace-write',
    taskType: 'boss_write',
    operationClass: 'write',
  }));
  const recovery = reloaded.recoverInterrupted();
  assert.deepEqual(recovery, { recovered: 3, auto_retried: 0, write_auto_retried: 0 });
  const recovered = reloaded.read().runs;
  assert.equal(recovered.length, 3);
  assert.ok(recovered.every((run) => run.status === 'interrupted'));
  assert.ok(recovered.every((run) => run.error_code === 'PROCESS_INTERRUPTED'));
  assert.equal(reloaded.recoverInterrupted().recovered, 0);
  rejects(() => reloaded.transitionRun({
    requestId: 'request-write', runId: 'run-write', status: 'succeeded', errorCode: null,
  }), /illegal terminal/);

  // Legal terminal transition is idempotent; a different terminal result is rejected.
  const terminal = reloaded.startRun(startInput({
    requestId: 'request-terminal', runId: 'run-terminal', traceId: 'trace-terminal', taskType: 'local_read',
  }));
  assert.equal(terminal.status, 'running');
  const succeeded = reloaded.transitionRun({
    requestId: 'request-terminal', runId: 'run-terminal', status: 'succeeded', errorCode: null,
  });
  assert.equal(succeeded.status, 'succeeded');
  assert.deepEqual(reloaded.transitionRun({
    requestId: 'request-terminal', runId: 'run-terminal', status: 'succeeded', errorCode: null,
  }), succeeded);
  rejects(() => reloaded.transitionRun({
    requestId: 'request-terminal', runId: 'run-terminal', status: 'failed', errorCode: 'TASK_FAILED',
  }), /illegal terminal/);
  rejects(() => reloaded.transitionRun({
    requestId: 'request-missing', runId: 'run-missing', status: 'failed', errorCode: 'TASK_FAILED',
  }), /not found/);
  rejects(() => reloaded.transitionRun({
    requestId: 'request-terminal', runId: 'run-terminal', status: 'failed', errorCode: 'HARD_STOP',
  }), /does not match/);

  const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const persistedText = JSON.stringify(persisted);
  for (const forbidden of ['payload', 'candidate_id', 'candidate_name', 'transcript', 'token', 'url', 'state_path']) {
    assert.equal(persistedText.includes(forbidden), false, `persisted state contains ${forbidden}`);
  }

  // A symlink state target is rejected before secure-fs can follow it.
  if (process.platform !== 'win32') {
    const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-task-run-symlink-'));
    const actual = path.join(symlinkRoot, 'actual.json');
    fs.writeFileSync(actual, '{"schema_version":1,"runs":[]}');
    const link = path.join(symlinkRoot, STATE_BASENAME);
    fs.symlinkSync(actual, link);
    rejects(() => createTaskRunState({ statePath: link }), /symlink/);
    fs.rmSync(symlinkRoot, { recursive: true, force: true });
  }

  // Unknown persisted fields fail closed rather than being loaded or rewritten.
  persisted.runs[0].candidate_name = 'synthetic-only';
  fs.writeFileSync(statePath, JSON.stringify(persisted), { mode: 0o600 });
  rejects(() => reloaded.read(), /unsupported field/);

  console.log(JSON.stringify({
    check: 'task_run_state',
    status: 'passed',
    explicit_recovery: 'ok',
    write_auto_retry: 'forbidden',
  }));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
