'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  buildElectronNodePath,
  resolveElectronRuntime,
} = require("../src/start-candidate-ui");

const ROOT = PROJECT_ROOT;

const { manifest, validateRepository } = require("./support/registry");
const SUITES = Object.freeze(Object.fromEntries(
  Object.entries(manifest.groups).filter(([name]) => name !== 'ui')
    .map(([name, files]) => [name, Object.freeze([...files])]),
));
const SUITE_ENV_OVERRIDES = Object.freeze({
  'hr-acceptance': Object.freeze({
    HRBOSS_UI_FIXTURE_GATE: '1',
    HRBOSS_EXTERNAL_AI_ENABLED: '0',
    BOSS_ACTION_AUTOMATION_ENABLED: '0',
  }),
});
const SYSTEM_NODE_TESTS = Object.freeze(new Set(
  manifest.entries.filter(entry => entry.runtime === 'system-node').map(entry => entry.path),
));
const DYNAMIC_RUNTIME_TESTS = Object.freeze(new Set(
  manifest.entries.filter(entry => entry.args?.includes('--runtime')).map(entry => entry.path),
));

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
  for (const requested of testFiles) {
    const testFile = requested.startsWith('tests/') ? requested : `tests/${requested}`;
    const entry = manifest.entries.find(item => item.path === testFile);
    if (!entry || entry.kind !== 'check') throw new Error(`Invalid check file argument: ${requested}`);
    runTest(testFile);
  }
  console.log(`[check-suite] files: PASS (${testFiles.length} checks)`);
}

if (require.main === module) {
  try {
    validateRepository();
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
