'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { DYNAMIC_RUNTIME_TESTS } = require('./check-suite-runner');
const {
  buildElectronNodePath,
  resolveElectronRuntime,
} = require('./start-candidate-ui');

const ROOT = __dirname;
const { getGroup, validateRepository } = require('./checks/registry');
const UI_CHECK_STEPS = Object.freeze(getGroup('ui'));

function createManagedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-ui-check-'));
  fs.chmodSync(root, 0o700);
  return fs.realpathSync(root);
}

function assertManagedRoot(root) {
  const name = path.basename(root);
  if (!name.startsWith('hrboss-ui-check-')) {
    throw new Error(`Refusing to clean an unmanaged UI check directory: ${root}`);
  }
  const parent = fs.realpathSync(path.dirname(root));
  const tempParent = fs.realpathSync(os.tmpdir());
  if (parent !== tempParent) {
    throw new Error(`Refusing to clean UI check directory outside the system temp root: ${root}`);
  }
}

function runUiChecks() {
  validateRepository();
  const workRoot = createManagedRoot();
  const tempParent = fs.realpathSync(os.tmpdir());
  const keepArtifacts = process.env.HRBOSS_KEEP_UI_CHECK_ARTIFACTS === '1';
  let passed = false;
  try {
    const resolvedElectron = resolveElectronRuntime();
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HRBOSS_TEST_RUNTIME: 'electron-node',
      HRBOSS_EXTERNAL_AI_ENABLED: '0',
      BOSS_ACTION_AUTOMATION_ENABLED: '0',
      HRBOSS_UI_FIXTURE_GATE: '1',
      HRBOSS_UI_FIXTURE_ROOT: workRoot,
      HRBOSS_UI_FIXTURE_TEMP_PARENT: tempParent,
      BOSS_DB_PATH: path.join(workRoot, 'ui-fixture.recruiting.db'),
      HRBOSS_DATA_DIR: path.join(workRoot, 'data'),
      HRBOSS_INTERVIEW_OUTPUT_DIR: path.join(workRoot, 'interviews'),
      BOSS_PROFILE_DATA_DIR: path.join(workRoot, 'boss-profile'),
      TMPDIR: workRoot,
      TMP: workRoot,
      TEMP: workRoot,
    };
    env.NODE_PATH = buildElectronNodePath(resolvedElectron.dependencyRoot, env.NODE_PATH);

    for (const step of UI_CHECK_STEPS) {
      console.log(`[check:ui] ${step} (isolated temp fixture)`);
      const stepArgs = [path.join(ROOT, step)];
      if (DYNAMIC_RUNTIME_TESTS.has(step)) stepArgs.push('--runtime');
      const result = spawnSync(resolvedElectron.electron, stepArgs, {
        cwd: ROOT,
        env,
        stdio: 'inherit',
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        const detail = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
        throw new Error(`${step} failed (${detail})`);
      }
    }
    passed = true;
    console.log(`[check:ui] PASS (${UI_CHECK_STEPS.length} checks; fixture isolated from repository data)`);
  } finally {
    if (keepArtifacts) {
      console.log(`[check:ui] ${passed ? 'evidence' : 'failure evidence'} retained at ${workRoot}`);
    } else {
      assertManagedRoot(workRoot);
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  try {
    runUiChecks();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

module.exports = {
  UI_CHECK_STEPS,
  assertManagedRoot,
  runUiChecks,
};
