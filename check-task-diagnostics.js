const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  DIAGNOSTIC_SCHEMA_VERSION,
  TaskDiagnosticsError,
  writeTaskDiagnostics,
} = require('./task-diagnostics');
const { createTaskObserver } = require('./task-observer');

const TEMP_BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-task-diagnostics-')));
process.on('exit', () => fs.rmSync(TEMP_BASE, { recursive: true, force: true }));

function fixture(overrides = {}) {
  return {
    app_version: '2.4.0',
    app_schema_version: '12',
    task_id: 'F014_IMPL_001',
    run_id: 'run_0123456789abcdef',
    trace_id: 'trace_0123456789abcdef',
    status: 'failed',
    error_code: 'TASK_LOCAL_READ_TIMEOUT',
    started_at: '2026-07-12T08:00:00.000Z',
    finished_at: '2026-07-12T08:00:01.000Z',
    platform_category: 'darwin',
    counts: {
      attempt_count: 1,
      warning_count: 0,
      error_count: 1,
      operation_count: 2,
    },
    ...overrides,
  };
}

function diagnosticRoot(name) {
  return path.join(TEMP_BASE, name, 'task-diagnostics');
}

function expectSafeError(fn, code, secrets = []) {
  let caught;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof TaskDiagnosticsError, `expected safe diagnostics error, got ${caught}`);
  assert.equal(caught.code, code);
  const exposed = JSON.stringify({ message: caught.message, code: caught.code });
  assert.ok(!exposed.includes(TEMP_BASE), 'error must not expose an absolute output path');
  for (const secret of secrets) assert.ok(!exposed.includes(secret), `error exposed injected secret: ${secret}`);
}

function onlyJsonFile(root) {
  const names = fs.readdirSync(root);
  assert.equal(names.length, 1);
  assert.match(names[0], /^task-diagnostics-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/);
  return path.join(root, names[0]);
}

function run() {
  const validRoot = diagnosticRoot('valid');
  const result = writeTaskDiagnostics(fixture(), { outputRoot: validRoot });
  assert.deepEqual(Object.keys(result).sort(), ['diagnostic_id', 'state']);
  assert.equal(result.state, 'written');
  assert.match(result.diagnostic_id, /^[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify(result).includes(validRoot), 'return value must not expose the output path');

  const outputFile = onlyJsonFile(validRoot);
  const raw = fs.readFileSync(outputFile, 'utf8');
  const document = JSON.parse(raw);
  assert.deepEqual(Object.keys(document), [
    'diagnostic_schema_version',
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
  assert.deepEqual(Object.keys(document.counts), [
    'attempt_count',
    'warning_count',
    'error_count',
    'operation_count',
  ]);
  assert.equal(document.diagnostic_schema_version, DIAGNOSTIC_SCHEMA_VERSION);
  assert.ok(!raw.includes(TEMP_BASE), 'diagnostic JSON must not contain an absolute local path');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(validRoot).mode & 0o777, 0o700);
    assert.equal(fs.statSync(outputFile).mode & 0o777, 0o600);
  }

  const callerFilenameRoot = diagnosticRoot('caller-filename');
  writeTaskDiagnostics(fixture(), {
    outputRoot: callerFilenameRoot,
    filename: '../../caller-controlled.json',
  });
  onlyJsonFile(callerFilenameRoot);
  assert.ok(!fs.existsSync(path.join(TEMP_BASE, 'caller-controlled.json')));

  const stableRoot = diagnosticRoot('stable');
  writeTaskDiagnostics(fixture(), { outputRoot: stableRoot });
  writeTaskDiagnostics(fixture(), { outputRoot: stableRoot });
  const stableFiles = fs.readdirSync(stableRoot).sort();
  assert.equal(stableFiles.length, 2);
  assert.equal(
    fs.readFileSync(path.join(stableRoot, stableFiles[0]), 'utf8'),
    fs.readFileSync(path.join(stableRoot, stableFiles[1]), 'utf8'),
    'the same allowlisted input must produce a stable JSON schema and body',
  );

  const forbiddenFields = {
    candidate_name: 'synthetic_candidate_secret',
    candidate_id: 'synthetic_candidate_id',
    text: 'synthetic_body_secret',
    transcript: 'synthetic_transcript_secret',
    audio: 'synthetic_audio_secret',
    attachment: 'synthetic_attachment_secret',
    url: 'https://synthetic.invalid/secret',
    token: 'synthetic_token_secret',
    cookie: 'synthetic_cookie_secret',
    header: 'synthetic_header_secret',
    env: 'synthetic_env_secret',
    absolute_path: '/synthetic/private/path',
    stack: 'synthetic_stack_secret',
    error_message: 'synthetic_free_text_error',
  };
  for (const [field, secret] of Object.entries(forbiddenFields)) {
    const root = diagnosticRoot(`forbidden-${field}`);
    expectSafeError(
      () => writeTaskDiagnostics({ ...fixture(), [field]: secret }, { outputRoot: root }),
      'TASK_DIAGNOSTICS_INPUT_INVALID',
      [secret],
    );
    assert.ok(!fs.existsSync(root), 'invalid input must not create an output root');
  }

  const nestedSecret = 'synthetic_nested_secret';
  const nestedRoot = diagnosticRoot('nested');
  expectSafeError(
    () => writeTaskDiagnostics(fixture({
      counts: { ...fixture().counts, details: { text: nestedSecret } },
    }), { outputRoot: nestedRoot }),
    'TASK_DIAGNOSTICS_COUNTS_INVALID',
    [nestedSecret],
  );
  assert.ok(!fs.existsSync(nestedRoot));

  expectSafeError(
    () => writeTaskDiagnostics(fixture({ error_code: 'FREE TEXT /tmp/secret' }), {
      outputRoot: diagnosticRoot('free-text'),
    }),
    'TASK_DIAGNOSTICS_ERROR_CODE_INVALID',
    ['FREE TEXT /tmp/secret'],
  );

  const encodedSecretRoot = diagnosticRoot('encoded-secret');
  expectSafeError(
    () => writeTaskDiagnostics(fixture({ error_code: 'CANDIDATE_SECRET_SENTINEL' }), {
      outputRoot: encodedSecretRoot,
    }),
    'TASK_DIAGNOSTICS_ERROR_CODE_INVALID',
    ['CANDIDATE_SECRET_SENTINEL'],
  );
  assert.ok(!fs.existsSync(encodedSecretRoot), 'non-allowlisted error code must not be written');

  const traversalRoot = `${TEMP_BASE}/safe/../task-diagnostics`;
  expectSafeError(
    () => writeTaskDiagnostics(fixture(), { outputRoot: traversalRoot }),
    'TASK_DIAGNOSTICS_ROOT_INVALID',
    [traversalRoot],
  );
  expectSafeError(
    () => writeTaskDiagnostics(fixture(), { outputRoot: 'relative/task-diagnostics' }),
    'TASK_DIAGNOSTICS_ROOT_INVALID',
  );

  const arbitraryExistingRoot = path.join(TEMP_BASE, 'arbitrary-existing-root');
  fs.mkdirSync(arbitraryExistingRoot);
  const arbitraryMode = fs.statSync(arbitraryExistingRoot).mode;
  expectSafeError(
    () => writeTaskDiagnostics(fixture(), { outputRoot: arbitraryExistingRoot }),
    'TASK_DIAGNOSTICS_ROOT_INVALID',
    [arbitraryExistingRoot],
  );
  assert.equal(
    fs.statSync(arbitraryExistingRoot).mode,
    arbitraryMode,
    'an arbitrary existing directory must not have its permissions rewritten',
  );

  const symlinkTarget = path.join(TEMP_BASE, 'symlink-target');
  fs.mkdirSync(symlinkTarget);
  const symlinkContainer = path.join(TEMP_BASE, 'symlink-root');
  fs.mkdirSync(symlinkContainer);
  const symlinkRoot = path.join(symlinkContainer, 'task-diagnostics');
  let symlinkCovered = false;
  try {
    fs.symlinkSync(symlinkTarget, symlinkRoot, 'dir');
    symlinkCovered = true;
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    console.log('check-task-diagnostics: SKIP root symlink (Windows permission unavailable)');
  }
  if (symlinkCovered) {
    expectSafeError(
      () => writeTaskDiagnostics(fixture(), { outputRoot: symlinkRoot }),
      'TASK_DIAGNOSTICS_ROOT_INVALID',
      [symlinkRoot],
    );
    assert.deepEqual(fs.readdirSync(symlinkTarget), []);

    const symlinkParentTarget = path.join(TEMP_BASE, 'symlink-parent-target');
    fs.mkdirSync(symlinkParentTarget);
    const symlinkParent = path.join(TEMP_BASE, 'symlink-parent');
    fs.symlinkSync(symlinkParentTarget, symlinkParent, 'dir');
    const nestedSymlinkRoot = path.join(symlinkParent, 'task-diagnostics');
    expectSafeError(
      () => writeTaskDiagnostics(fixture(), { outputRoot: nestedSymlinkRoot }),
      'TASK_DIAGNOSTICS_ROOT_INVALID',
      [nestedSymlinkRoot],
    );
    assert.ok(!fs.existsSync(path.join(symlinkParentTarget, 'task-diagnostics')));
  }

  const nullRoot = diagnosticRoot('null-values');
  writeTaskDiagnostics(fixture({
    status: 'running',
    error_code: null,
    finished_at: null,
    platform_category: 'other',
  }), { outputRoot: nullRoot });
  const nullDocument = JSON.parse(fs.readFileSync(onlyJsonFile(nullRoot), 'utf8'));
  assert.equal(nullDocument.error_code, null);
  assert.equal(nullDocument.finished_at, null);

  const invalidCases = [
    [fixture({ status: 'unknown' }), 'TASK_DIAGNOSTICS_STATUS_INVALID'],
    [fixture({ platform_category: 'darwin-arm64' }), 'TASK_DIAGNOSTICS_PLATFORM_INVALID'],
    [fixture({ started_at: 'not-a-timestamp' }), 'TASK_DIAGNOSTICS_TIME_INVALID'],
    [fixture({ run_id: '../escape' }), 'TASK_DIAGNOSTICS_ID_INVALID'],
    [fixture({ counts: { ...fixture().counts, operation_count: -1 } }), 'TASK_DIAGNOSTICS_COUNTS_INVALID'],
    [fixture({ counts: { ...fixture().counts, warning_count: 1.5 } }), 'TASK_DIAGNOSTICS_COUNTS_INVALID'],
  ];
  invalidCases.forEach(([input, code], index) => {
    expectSafeError(
      () => writeTaskDiagnostics(input, { outputRoot: diagnosticRoot(`invalid-${index}`) }),
      code,
    );
  });

  const observerRoot = diagnosticRoot('observer-integration');
  const observer = createTaskObserver({
    statePath: path.join(TEMP_BASE, 'observer-state', 'task-run-state.json'),
    diagnosticsRoot: observerRoot,
    taskType: 'local_write',
    operationClass: 'write',
    clock: (() => {
      let tick = 0;
      return () => new Date(Date.parse('2026-07-12T08:00:00.000Z') + tick++ * 1000);
    })(),
    idFactory: (prefix) => `${prefix}_observer`,
  });
  const observedRun = observer.startRun();
  const observedFailure = observer.finishFailed(observedRun, {
    operation_class: 'local_write',
    platform: 'local',
    error_kind: 'unknown',
  });
  assert.equal(observedFailure.state.status, 'hard_stopped');
  assert.equal(observedFailure.diagnostic.state, 'written');
  const observedDocument = JSON.parse(fs.readFileSync(onlyJsonFile(observerRoot), 'utf8'));
  assert.equal(observedDocument.task_id, 'local_write');
  assert.equal(observedDocument.error_code, 'HARD_STOP');
  assert.equal(observedDocument.counts.attempt_count, 1);

  fs.rmSync(TEMP_BASE, { recursive: true, force: true });
  assert.ok(!fs.existsSync(TEMP_BASE), 'synthetic temporary data must be cleaned');
  console.log('check-task-diagnostics: PASS');
}

try {
  run();
} finally {
  fs.rmSync(TEMP_BASE, { recursive: true, force: true });
}
