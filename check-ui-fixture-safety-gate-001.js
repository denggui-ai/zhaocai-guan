'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const TARGETS = Object.freeze([
  'create-ui-fixture-db.js',
  'check-ui-readonly.js',
]);
const GATE_ENV = 'HRBOSS_UI_FIXTURE_GATE';
const ROOT_ENV = 'HRBOSS_UI_FIXTURE_ROOT';
const TEMP_PARENT_ENV = 'HRBOSS_UI_FIXTURE_TEMP_PARENT';

function childEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete env[key];
  }
  return env;
}

function runTarget(target, env) {
  return spawnSync(process.execPath, [path.join(ROOT, target)], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
  });
}

function assertRejected(target, scenario, env, messagePattern) {
  const result = runTarget(target, env);
  assert.notEqual(result.status, 0, `${target} must reject ${scenario}`);
  assert.match(
    `${result.stderr || ''}\n${result.stdout || ''}`,
    messagePattern,
    `${target} must fail at the fixture safety gate for ${scenario}`,
  );
}

for (const target of TARGETS) {
  const source = fs.readFileSync(path.join(ROOT, target), 'utf8');
  const gateCall = source.indexOf('assertUiFixtureEnvironment()');
  assert.ok(gateCall >= 0, `${target} must invoke the fixture safety gate`);
  for (const databaseImport of ["require('./db')", "require('better-sqlite3')"]) {
    const importPosition = source.indexOf(databaseImport);
    if (importPosition >= 0) {
      assert.ok(gateCall < importPosition, `${target} must gate before ${databaseImport}`);
    }
  }
}

const managedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-ui-fixture-gate-')));
const runtimeTemp = fs.realpathSync(os.tmpdir());
const fixtureDb = path.join(managedRoot, 'data', 'ui-fixture.db');
const adjacentDb = path.join(`${managedRoot}-adjacent`, 'ui-fixture.db');
const repositoryDbPath = path.join(ROOT, 'data', 'recruiting.db');
const controlledEnv = {
  [GATE_ENV]: '1',
  [ROOT_ENV]: managedRoot,
  [TEMP_PARENT_ENV]: runtimeTemp,
  BOSS_DB_PATH: fixtureDb,
  HRBOSS_DATA_DIR: path.join(managedRoot, 'data'),
  HRBOSS_INTERVIEW_OUTPUT_DIR: path.join(managedRoot, 'interviews'),
  BOSS_PROFILE_DATA_DIR: path.join(managedRoot, 'boss-profile'),
  HRBOSS_EXTERNAL_AI_ENABLED: '0',
  BOSS_ACTION_AUTOMATION_ENABLED: '0',
  TMPDIR: managedRoot,
  TMP: managedRoot,
  TEMP: managedRoot,
};

try {
  for (const target of TARGETS) {
    assertRejected(
      target,
      'a missing runner marker',
      childEnv({ ...controlledEnv, [GATE_ENV]: null }),
      /UI fixture safety gate rejected: missing HRBOSS_UI_FIXTURE_GATE=1/,
    );
    assertRejected(
      target,
      'a missing database path',
      childEnv({ ...controlledEnv, BOSS_DB_PATH: null }),
      /UI fixture safety gate rejected: missing BOSS_DB_PATH/,
    );
    assertRejected(
      target,
      'the repository database path',
      childEnv({ ...controlledEnv, BOSS_DB_PATH: repositoryDbPath }),
      /UI fixture safety gate rejected: BOSS_DB_PATH must resolve inside HRBOSS_UI_FIXTURE_ROOT/,
    );
    assertRejected(
      target,
      'an adjacent-prefix temp path',
      childEnv({ ...controlledEnv, BOSS_DB_PATH: adjacentDb }),
      /UI fixture safety gate rejected: BOSS_DB_PATH must resolve inside HRBOSS_UI_FIXTURE_ROOT/,
    );
    assertRejected(
      target,
      'the whole active temp directory as its managed root',
      childEnv({
        ...controlledEnv,
        [ROOT_ENV]: runtimeTemp,
        BOSS_DB_PATH: path.join(runtimeTemp, 'ui-fixture-broad-root.db'),
      }),
      /UI fixture safety gate rejected: HRBOSS_UI_FIXTURE_ROOT must be a newly created direct child of HRBOSS_UI_FIXTURE_TEMP_PARENT/,
    );
  }

  const createResult = runTarget('create-ui-fixture-db.js', childEnv(controlledEnv));
  assert.equal(
    createResult.status,
    0,
    `controlled fixture creation must pass: ${createResult.stderr || createResult.stdout}`,
  );
  const readonlyResult = runTarget('check-ui-readonly.js', childEnv(controlledEnv));
  assert.equal(
    readonlyResult.status,
    0,
    `controlled readonly fixture check must pass: ${readonlyResult.stderr || readonlyResult.stdout}`,
  );
} finally {
  fs.rmSync(managedRoot, { recursive: true, force: true });
}

console.log('check-ui-fixture-safety-gate-001: PASS');
