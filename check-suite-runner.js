'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  buildElectronNodePath,
  resolveElectronRuntime,
} = require('./start-candidate-ui');

const ROOT = __dirname;

const HR_ACCEPTANCE_TESTS = Object.freeze([
  // HR core flow: intake through disposition, Offer, recovery, and committed refresh.
  'check-candidate-seven-stage-e2e-001.js',
  'check-hr-journey-operations-001.js',
  'check-hr-journey-operations-ui-001.js',
  'check-hr-journey-operations-frontend-state-001.js',
  'check-committed-write-refresh-ui-001.js',
  'check-job-multi-001.js',
  // Assessment report: intake, parsing, review, archive, preview, OCR, and read-only history.
  'check-assessment-file-intake.js',
  'check-assessment-report-analysis.js',
  'check-assessment-product-service.js',
  'check-assessment-workbench-integration-001.js',
  'check-assessment-archive-service.js',
  'check-assessment-closed-job-gate-001.js',
  'check-assessment-pdf-probe.js',
  'check-assessment-raster-preview.js',
  'check-assessment-scanned-pdf-ocr-001.js',
  // AI is decision support only: approval, evidence gates, fallback, and zero-call default-off.
  'check-external-ai-user-approval.js',
  'check-assessment-ai-analysis.js',
  'check-ai-commit-context-gate-001.js',
  'check-ai-value-001.js',
  'check-f009-interview-llm.js',
  // Release readiness without pretending to run a real signed cross-platform package.
  'check-schema-migration.js',
  'check-assessment-migration-recovery.js',
  'check-assessment-backup-retention.js',
  'check-f011-backup-recovery.js',
  'check-windows-release-readiness-contract.js',
  'check-macos-official-release-gate.js',
  'check-ui-fixture-safety-gate-001.js',
]);

const SUITE_ENV_OVERRIDES = Object.freeze({
  'hr-acceptance': Object.freeze({
    HRBOSS_UI_FIXTURE_GATE: '1',
    HRBOSS_EXTERNAL_AI_ENABLED: '0',
    BOSS_ACTION_AUTOMATION_ENABLED: '0',
  }),
});

// Keep the release suites in one manifest. Most checks exercise SQLite-backed
// production modules, so they run with the repository Electron runtime whose
// native ABI matches better-sqlite3. Tests in SYSTEM_NODE_TESTS document the
// small set that intentionally need the host Node executable.
const SUITES = Object.freeze({
  'hr-acceptance': HR_ACCEPTANCE_TESTS,
  precheck: Object.freeze([
    'check-test-pipeline.js',
    'check-macos-single-instance-001.js',
    'check-local-principal.js',
    'check-external-ai-user-approval.js',
    'check-external-ai-gateway-001.js',
    'check-desktop-user-data-001.js',
    'check-ai-first-use-return-001.js',
    'check-external-ai-material-preview-001.js',
    'check-f010-product-wiring.js',
    'check-f010-ui-contract.js',
    'check-assessment-file-selection.js',
    'check-assessment-batch-import.js',
    'check-f017-assessment-lifecycle.js',
    'check-assessment-parser-runner.js',
    'check-assessment-report-analysis.js',
    'check-assessment-fit-ranking.js',
    'check-assessment-ai-analysis.js',
    'check-assessment-workbench-integration-001.js',
    'check-hr-journey-operations-001.js',
    'check-hr-journey-operations-ui-001.js',
    'check-hr-journey-operations-frontend-state-001.js',
    'check-assessment-raster-preview.js',
    'check-assessment-controlled-store.js',
    'check-assessment-physical-delete.js',
    'check-assessment-product-service.js',
    'check-f019-gate-a-product-wiring.js',
    'check-f017-assessment-migration-gate.js',
    'check-assessment-store-backup.js',
    'check-assessment-backup-retention.js',
    'check-f017-assessment-joint-backup-gate.js',
    'check-f017-product-wiring.js',
    'check-f017-assessment-ui-contract.js',
    'check-f017-pilot-launch.js',
    'check-f018-application.js',
    'check-f018-final-review.js',
    'check-f018-migration-gate.js',
    'check-f018-product-wiring.js',
    'check-f018-workbench.js',
    'check-f018-ui-contract.js',
    'check-windows-candidate-contract.js',
    'check-windows-release-readiness-contract.js',
  ]),
  check: Object.freeze([
    'check-security-p0.js',
    'check-sensitive-read-audit-permissions-001.js',
    'check-release-security.js',
    'check-macos-official-release-gate.js',
    'check-schema-migration.js',
    'check-assessment-schema.js',
    'check-assessment-actor-context.js',
    'check-assessment-file-intake.js',
    'check-assessment-archive-service.js',
    'check-assessment-workbench-integration-001.js',
    'check-hr-journey-operations-001.js',
    'check-hr-journey-operations-ui-001.js',
    'check-hr-journey-operations-frontend-state-001.js',
    'check-assessment-migration-recovery.js',
    'check-assessment-pdf-probe.js',
    'check-windows-assessment-guard.js',
    'check-f010-lifecycle.js',
    'check-f010-db-retention.js',
    'check-f011-backup-recovery.js',
    'check-f010-f011-integration.js',
    'check-data-lifecycle-fault-matrix-001.js',
    'check-task-run-state.js',
    'check-task-error-policy.js',
    'check-task-diagnostics.js',
    'check-f014-screenshot-observability.js',
    'check-windows-asr-degradation.js',
    'check-db.js',
    'check-ai-commit-context-gate-001.js',
    'check-closed-job-activity-gate-001.js',
    'check-screenshot-normalization.js',
    'check-resume-structure-001.js',
    'check-screenshot-import.js',
    'check-screenshot-evidence-store.js',
    'check-screenshot-ingest.js',
    'check-screenshot-ai-fill.js',
    'check-screenshot-ai-fill-approval-001.js',
    'check-screenshot-stitch-fallback-001.js',
    'check-ai-authored-draft-gate-001.js',
    'check-screenshot-ai-reader-001.js',
    'check-screenshot-ai-import-state-001.js',
    'check-screenshot-import-task-ui-001.js',
    'check-screenshot-task-projection-001.js',
    'check-screenshot-ai-approval-001.js',
    'check-screenshot-ai-reads-handoff-001.js',
    'check-action-server-guard.js',
    'check-lark-import-guard.js',
    'check-interview-material-paths.js',
    'check-interview-logistics-data-001.js',
    'check-interview-phone-truth-001.js',
    'check-f006-interview-session.js',
    'check-f007-interview-adapters.js',
    'check-f008-interview-report.js',
    'check-interview-manual-action-routes-001.js',
    'check-f009-interview-llm.js',
    'check-interview-transcript-cues-001.js',
    'check-f012-workbench.js',
    'check-f012-ui-contract.js',
    'check-interview-demo-fixture.js',
    'check-ui-fixture-safety-gate-001.js',
    'check-interview-recording.js',
    'check-macos-asr-failure-recovery-001.js',
    'check-candidate-seven-stage-e2e-001.js',
    'check-interview-recording-consent-withdrawal-001.js',
    'check-interview-consent-revocation-latch-001.js',
    'check-local-interview-guardian-fault-injection-001.js',
    'check-live-audio-telemetry-001.js',
    'check-quality-score-isolation.js',
    'check-rule-rating.js',
    'check-talent-pool.js',
    'check-ai-value-001.js',
    'check-closed-job-todo-001.js',
    'check-committed-write-refresh-ui-001.js',
    'check-job-multi-001.js',
    'check-ui-job-context-isolation.js',
    'check-ux-g0-a-timeline-visibility.js',
    'check-ux-g0-b-shell-safety-001.js',
    'check-ux-g0-b2-lazy-failure-matrix-001.js',
    'check-ux-g0-c-destructive-action-safety.js',
    'check-ux-g0-d-readonly-history-optional.js',
    'check-ux-g0-d2-operational-readonly.js',
    'check-ux-w1-a-job-parity.js',
    'check-ux-w1-a-topbar-ownership.js',
    'check-ux-w1-a-shell-integration.js',
    'check-ux-w2-a-candidate-workspace.js',
    'check-ux-w2-b-talent-resume.js',
    'check-ux-w3-a-interview-workspace.js',
    'check-ux-w4-a-settings-assessment.js',
    'check-ux-w4-b-deep-profile-recovery.js',
    'check-ux-w4-c-guide-ledger.js',
  ]),
});

const SYSTEM_NODE_TESTS = Object.freeze(new Set([
  // This check orchestrates the real Electron desktop process and inspects
  // exact child PIDs; it must not itself run inside Electron's Node mode.
  'check-orphan-service-on-force-quit-001.js',
  // This check writes synthetic executable shebangs from process.execPath.
  // Electron.app contains spaces, so it deliberately needs the host Node path.
  'check-assessment-controlled-store.js',
  // This check spawns isolated shell and mock tool processes from a system
  // temporary directory and never loads native application modules.
  'check-macos-official-release-gate.js',
]));

const DYNAMIC_RUNTIME_TESTS = Object.freeze(new Set([
  'check-ux-g0-b-shell-safety-001.js',
  'check-ux-g0-b2-lazy-failure-matrix-001.js',
]));

function runtimeFor(testFile) {
  return SYSTEM_NODE_TESTS.has(testFile) ? 'system-node' : 'electron-node';
}

let cachedElectronRuntime;

function electronRuntime() {
  if (!cachedElectronRuntime) cachedElectronRuntime = resolveElectronRuntime();
  return cachedElectronRuntime;
}

function runTest(testFile, envOverrides = {}) {
  const absoluteTest = path.join(ROOT, testFile);
  if (!fs.existsSync(absoluteTest)) throw new Error(`Check file not found: ${testFile}`);

  const runtime = runtimeFor(testFile);
  const env = { ...process.env, ...envOverrides, HRBOSS_TEST_RUNTIME: runtime };
  let executable = process.execPath;
  if (runtime === 'electron-node') {
    const resolvedElectron = electronRuntime();
    executable = resolvedElectron.electron;
    env.ELECTRON_RUN_AS_NODE = '1';
    env.NODE_PATH = buildElectronNodePath(resolvedElectron.dependencyRoot, env.NODE_PATH);
  } else {
    delete env.ELECTRON_RUN_AS_NODE;
  }

  console.log(`[check-suite] ${testFile} (${runtime})`);
  const testArgs = DYNAMIC_RUNTIME_TESTS.has(testFile) ? [absoluteTest, '--runtime'] : [absoluteTest];
  const result = spawnSync(executable, testArgs, {
    cwd: ROOT,
    env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    throw new Error(`${testFile} failed (${detail})`);
  }
}

// The Windows survey needs to see every failing check, not just the first one.
// Stopping at the first failure meant one check that could not delete its own
// temp directory hid the ~97 checks queued behind it, which is the opposite of
// what a survey is for. Opt-in, so every other caller still fails fast.
const SURVEY_MODE = process.env.HRBOSS_CHECK_SURVEY === '1';

function runSuite(suiteName) {
  const tests = SUITES[suiteName];
  if (!tests) throw new Error(`Unknown check suite: ${suiteName}`);
  const envOverrides = SUITE_ENV_OVERRIDES[suiteName] || {};
  if (!SURVEY_MODE) {
    for (const testFile of tests) runTest(testFile, envOverrides);
    console.log(`[check-suite] ${suiteName}: PASS (${tests.length} checks)`);
    return;
  }
  const failures = [];
  for (const testFile of tests) {
    try {
      runTest(testFile, envOverrides);
    } catch (error) {
      failures.push(testFile);
      console.error(`[check-suite] survey failure: ${testFile}: ${(error && error.message) || error}`);
    }
  }
  if (failures.length === 0) {
    console.log(`[check-suite] ${suiteName}: PASS (${tests.length} checks)`);
    return;
  }
  console.log(`[check-suite] ${suiteName}: FAIL (${failures.length}/${tests.length} checks failed)`);
  for (const testFile of failures) console.log(`[check-suite] survey failed: ${testFile}`);
  throw new Error(`${suiteName}: ${failures.length} of ${tests.length} checks failed`);
}

function runFiles(testFiles) {
  if (!Array.isArray(testFiles) || testFiles.length === 0) {
    throw new Error('At least one check file is required.');
  }
  for (const testFile of testFiles) {
    if (!/^check-[a-z0-9-]+\.js$/i.test(testFile)) {
      throw new Error(`Invalid check file argument: ${testFile}`);
    }
    runTest(testFile);
  }
  console.log(`[check-suite] files: PASS (${testFiles.length} checks)`);
}

if (require.main === module) {
  try {
    if (process.argv[2] === 'files') runFiles(process.argv.slice(3));
    else runSuite(process.argv[2]);
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

module.exports = {
  SUITES,
  SUITE_ENV_OVERRIDES,
  SYSTEM_NODE_TESTS,
  DYNAMIC_RUNTIME_TESTS,
  runtimeFor,
  runFiles,
  runSuite,
};
