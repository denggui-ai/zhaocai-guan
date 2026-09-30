'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const packageJson = require('./package.json');
const { manifest, renderCommand, validateRepository } = require('./checks/registry');
validateRepository();
for (const name of Object.keys(manifest.commands)) {
  assert.equal(packageJson.scripts[name], `node checks/run-npm-check.js ${name}`,
    `${name} must execute its registered command`);
}
const effectiveScripts = { ...packageJson.scripts,
  ...Object.fromEntries(Object.keys(manifest.commands).map(name => [name, renderCommand(name)])),
};
const {
  SUITES,
  SUITE_ENV_OVERRIDES,
  SYSTEM_NODE_TESTS,
  DYNAMIC_RUNTIME_TESTS,
  runtimeFor,
} = require('./check-suite-runner');
const { UI_CHECK_STEPS, assertManagedRoot } = require('./check-ui-suite');
const checkSuiteRunnerSource = fs.readFileSync(path.join(__dirname, 'check-suite-runner.js'), 'utf8');
const checkUiSuiteSource = fs.readFileSync(path.join(__dirname, 'check-ui-suite.js'), 'utf8');
const assessmentMigrationRecoverySource = fs.readFileSync(
  path.join(__dirname, 'check-assessment-migration-recovery.js'),
  'utf8',
);
const databaseIsolationCheckFiles = [
  'check-interview-demo-fixture.js',
];
const releaseSecuritySource = fs.readFileSync(
  path.join(__dirname, 'check-release-security.js'),
  'utf8',
);
const windowsWorkflowSource = fs.readFileSync(
  path.join(__dirname, '.github', 'workflows', 'windows-check.yml'),
  'utf8',
);
const windowsPrivateDirProbeSource = fs.readFileSync(
  path.join(__dirname, 'check-windows-private-dir-sqlite-probe-001.js'),
  'utf8',
);

function reachesBetterSqlite(testFile, memo = new Map(), stack = new Set()) {
  const absolute = path.resolve(__dirname, testFile);
  if (memo.has(absolute)) return memo.get(absolute);
  if (stack.has(absolute) || !fs.existsSync(absolute)) return false;
  const source = fs.readFileSync(absolute, 'utf8');
  if (/require\(['"]better-sqlite3['"]\)/.test(source)) {
    memo.set(absolute, true);
    return true;
  }
  const nextStack = new Set(stack);
  nextStack.add(absolute);
  for (const match of source.matchAll(/require\(['"](\.\.?\/[^'"]+)['"]\)/g)) {
    const unresolved = path.resolve(path.dirname(absolute), match[1]);
    for (const candidate of [unresolved, `${unresolved}.js`, path.join(unresolved, 'index.js')]) {
      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
      if (reachesBetterSqlite(candidate, memo, nextStack)) {
        memo.set(absolute, true);
        return true;
      }
    }
  }
  memo.set(absolute, false);
  return false;
}

function systemNodeCheckFiles(command) {
  const files = [];
  const pattern = /(?:^|&&)\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S+)\s+)*node\s+(check-[a-z0-9-]+\.js)/gi;
  for (const match of command.matchAll(pattern)) files.push(match[1]);
  return files;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertSyntheticDatabaseIsolation(testFile) {
  const source = fs.readFileSync(path.join(__dirname, testFile), 'utf8');
  assert.match(source, /fs\.mkdtempSync\(path\.join\(os\.tmpdir\(\),/, `${testFile} must create its database root under os.tmpdir()`);
  assert.match(
    source,
    /(?:process\.env\.)?BOSS_DB_PATH\s*(?:=|:)\s*[A-Za-z_$][\w$]*/,
    `${testFile} must pass an explicit BOSS_DB_PATH`,
  );
  assert.doesNotMatch(
    source,
    /__dirname[\s\S]{0,120}['"]data['"][\s\S]{0,120}['"]recruiting\.db['"]|data[\\/]recruiting\.db/i,
    `${testFile} must never reference the repository recruiting database`,
  );
  assert.doesNotMatch(
    source,
    /\b(?:l?stat)(?:Sync)?\s*\(|\bcreateHash\s*\(|\b(?:hash|fingerprint|sha(?:1|256|512))(?:File|Db|Database)?\s*\(/i,
    `${testFile} must not stat, hash, or fingerprint a default database`,
  );

  const unchangedSentinel = source.match(
    /assert\.equal\(\s*fs\.readFileSync\(\s*([A-Za-z_$][\w$]*)\s*,\s*['"]utf8['"]\s*\)\s*,\s*([A-Za-z_$][\w$]*)\s*,/,
  );
  assert.ok(unchangedSentinel, `${testFile} must assert that its default-DB sentinel text is unchanged`);
  const [, sentinelPath, sentinelContent] = unchangedSentinel;
  assert.match(
    source,
    new RegExp(`(?:const|let)\\s+${escapeRegExp(sentinelContent)}\\s*=\\s*[^;\\n]*sentinel`, 'i'),
    `${testFile} must initialize the asserted sentinel with synthetic text`,
  );
  assert.match(
    source,
    new RegExp(`fs\\.writeFileSync\\(\\s*${escapeRegExp(sentinelPath)}\\s*,\\s*${escapeRegExp(sentinelContent)}\\s*,\\s*['"]utf8['"]\\s*\\)`),
    `${testFile} must compare the sentinel with the exact text written before the check`,
  );
}

function assertReleaseSecurityDatabaseIsolation(source) {
  const tempRoot = source.match(
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.join\(\s*os\.tmpdir\(\)\s*,/,
  );
  assert.ok(tempRoot, 'release-security must create its isolated root under os.tmpdir()');
  const tempRootName = tempRoot[1];

  const dataDirAssignment = source.match(
    new RegExp(`process\\.env\\.HRBOSS_DATA_DIR\\s*=\\s*path\\.join\\(\\s*${escapeRegExp(tempRootName)}\\s*,`),
  );
  assert.ok(dataDirAssignment, 'release-security must explicitly redirect HRBOSS_DATA_DIR into its temp root');

  const dbPathAssignment = source.match(
    /process\.env\.BOSS_DB_PATH\s*=\s*([A-Za-z_$][\w$]*)\s*;/,
  );
  assert.ok(dbPathAssignment, 'release-security must explicitly redirect BOSS_DB_PATH before loading db.js');
  const sentinelPath = dbPathAssignment[1];
  assert.match(
    source,
    new RegExp(`(?:const|let)\\s+${escapeRegExp(sentinelPath)}\\s*=\\s*path\\.join\\(\\s*${escapeRegExp(tempRootName)}\\s*,`),
    'release-security BOSS_DB_PATH must point inside the isolated temp root',
  );

  const sentinelContentDeclaration = source.match(
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*sentinel[^;\n]*)\s*;/i,
  );
  assert.ok(sentinelContentDeclaration, 'release-security must initialize a synthetic non-SQLite sentinel');
  const sentinelContent = sentinelContentDeclaration[1];
  assert.doesNotMatch(sentinelContentDeclaration[2], /SQLite format 3/i, 'release-security sentinel must not be a valid SQLite header');

  const sentinelWrite = source.match(
    new RegExp(`fs\\.writeFileSync\\(\\s*${escapeRegExp(sentinelPath)}\\s*,\\s*${escapeRegExp(sentinelContent)}\\s*,\\s*['"]utf8['"]\\s*\\)`),
  );
  assert.ok(sentinelWrite, 'release-security must create the non-SQLite sentinel before loading db.js');

  const dbRequire = source.match(/require\(['"]\.\/db['"]\)/);
  assert.ok(dbRequire, 'release-security must exercise the real db module');
  for (const [setupName, setupMatch] of [
    ['temporary HRBOSS_DATA_DIR', dataDirAssignment],
    ['temporary BOSS_DB_PATH', dbPathAssignment],
    ['non-SQLite sentinel write', sentinelWrite],
  ]) {
    assert.ok(setupMatch.index < dbRequire.index, `${setupName} must be established before require('./db')`);
  }

  const unauthorizedDeepProfile = source.match(
    /await\s+assert\.rejects\([\s\S]{0,180}db\.generateDeepProfileForJob\([\s\S]{0,180}\/一次性\.\*授权\//,
  );
  const unauthorizedSecondOpinion = source.match(
    /await\s+assert\.rejects\([\s\S]{0,180}db\.runSecondOpinion\([\s\S]{0,180}\/一次性\.\*授权\//,
  );
  assert.ok(unauthorizedDeepProfile, 'release-security must reject unauthorized deep-profile before database access');
  assert.ok(unauthorizedSecondOpinion, 'release-security must reject unauthorized second-opinion before database access');

  const unchangedSentinel = source.match(
    new RegExp(`assert\\.equal\\(\\s*fs\\.readFileSync\\(\\s*${escapeRegExp(sentinelPath)}\\s*,\\s*['"]utf8['"]\\s*\\)\\s*,\\s*${escapeRegExp(sentinelContent)}\\s*,`),
  );
  assert.ok(unchangedSentinel, 'release-security must compare the sentinel with its original text');
  assert.ok(dbRequire.index < unauthorizedDeepProfile.index, 'unauthorized APIs must be exercised through the loaded db module');
  assert.ok(dbRequire.index < unauthorizedSecondOpinion.index, 'unauthorized APIs must be exercised through the loaded db module');
  assert.ok(unauthorizedDeepProfile.index < unchangedSentinel.index, 'deep-profile rejection must occur before the sentinel integrity assertion');
  assert.ok(unauthorizedSecondOpinion.index < unchangedSentinel.index, 'second-opinion rejection must occur before the sentinel integrity assertion');
}

assert.equal(packageJson.scripts.precheck, 'node check-suite-runner.js precheck');
assert.equal(packageJson.scripts.check, 'node check-suite-runner.js check');
assert.equal(
  effectiveScripts['check:settings-ux'],
  'node check-suite-runner.js files check-settings-state-001.js check-secure-llm-config-store-001.js check-secure-llm-startup-fail-closed-001.js check-settings-ux-001.js check-settings-native-close-001.js check-windows-asr-degradation.js check-local-interview-tool-discovery-001.js',
);
assert.equal(
  effectiveScripts['check:hr-acceptance'],
  'node check-suite-runner.js hr-acceptance && npm run check:ui:fixture',
);
assert.equal(effectiveScripts['check:ui'], 'node check-ui-suite.js');
assert.ok(packageJson.scripts.verify.includes('npm run check'));
assert.ok(packageJson.scripts.verify.includes('npm run check:ui'));

const windowsCoreStart = windowsWorkflowSource.indexOf('\n  windows-core:');
const windowsSurveyStart = windowsWorkflowSource.indexOf('\n  windows-survey:');
assert.ok(
  windowsCoreStart >= 0 && windowsSurveyStart > windowsCoreStart,
  'Windows workflow must keep distinct core and survey jobs',
);
const windowsCoreSection = windowsWorkflowSource.slice(windowsCoreStart, windowsSurveyStart);
const windowsSurveySection = windowsWorkflowSource.slice(windowsSurveyStart);
const windowsProbeCommand = 'node check-suite-runner.js ci-windows-probe';
assert.deepEqual(SUITES['ci-windows-probe'], ['check-windows-private-dir-sqlite-probe-001.js']);
assert.equal(
  windowsWorkflowSource.split(windowsProbeCommand).length - 1,
  1,
  'Windows private-directory probe must be wired exactly once',
);
assert.ok(windowsCoreSection.includes(windowsProbeCommand), 'Windows private-directory probe must block in windows-core');
assert.ok(!windowsSurveySection.includes(windowsProbeCommand), 'Windows private-directory probe must not run in continue-on-error survey');
assert.ok(!windowsCoreSection.includes('continue-on-error: true'), 'windows-core must not weaken failures with continue-on-error');
const windowsProbeLine = windowsCoreSection.split('\n').find((line) => line.includes(windowsProbeCommand)) || '';
assert.ok(!windowsProbeLine.includes('|| true'), 'Windows private-directory probe must preserve a non-zero exit');
assert.ok(
  windowsCoreSection.indexOf(windowsProbeCommand) < windowsCoreSection.indexOf('- name: 截图导入相关门禁'),
  'Windows private-directory probe must run before the known screenshot gate failure',
);
assert.match(
  windowsWorkflowSource,
  /defaults:\s*\n\s*run:\s*\n\s*shell: bash/,
  'Windows workflow must use bash pipefail semantics so tee does not hide probe failure',
);
const probeClassificationIndex = windowsPrivateDirProbeSource.indexOf(
  'const classification = classifyResults(results);',
);
const probeClassificationGuardIndex = windowsPrivateDirProbeSource.indexOf(
  'if (classification !== SUCCESS_CLASSIFICATION)',
);
assert.match(
  windowsPrivateDirProbeSource,
  /const SUCCESS_CLASSIFICATION = 'HARDEN_PRIVATE_DIR_SQLITE_FIRST_REOPEN_AND_LIVE_OK';/,
  'Windows private-directory probe must keep one explicit success classification',
);
assert.ok(
  probeClassificationIndex >= 0 && probeClassificationGuardIndex > probeClassificationIndex,
  'Windows private-directory probe must turn every non-success classification into a gate failure',
);

for (const [suiteName, tests] of Object.entries(SUITES)) {
  assert.ok(tests.length > 0, `${suiteName} must contain checks`);
  assert.equal(new Set(tests).size, tests.length, `${suiteName} must not contain duplicate checks`);
  for (const testFile of tests) {
    assert.ok(fs.existsSync(path.join(__dirname, testFile)), `${suiteName} check is missing: ${testFile}`);
  }
}

assert.ok(SUITES.check.includes('check-ai-value-001.js'), 'standard check must cover AI value copy');
[
  'check-ai-first-use-return-001.js',
  'check-external-ai-material-preview-001.js',
].forEach((testFile) => {
  assert.ok(SUITES.precheck.includes(testFile), `precheck must cover the AI first-use safety regression: ${testFile}`);
});
assert.deepEqual(SUITE_ENV_OVERRIDES['hr-acceptance'], {
  HRBOSS_UI_FIXTURE_GATE: '1',
  HRBOSS_EXTERNAL_AI_ENABLED: '0',
  BOSS_ACTION_AUTOMATION_ENABLED: '0',
});
[
  'check-candidate-seven-stage-e2e-001.js',
  'check-hr-journey-operations-001.js',
  'check-assessment-workbench-integration-001.js',
  'check-assessment-closed-job-gate-001.js',
  'check-assessment-ai-analysis.js',
  'check-f009-interview-llm.js',
  'check-assessment-migration-recovery.js',
  'check-f011-backup-recovery.js',
  'check-windows-release-readiness-contract.js',
  'check-macos-official-release-gate.js',
  'check-ui-fixture-safety-gate-001.js',
].forEach((testFile) => {
  assert.ok(SUITES['hr-acceptance'].includes(testFile), `HR acceptance must cover ${testFile}`);
});
assert.ok(SUITES.check.includes('check-closed-job-todo-001.js'), 'standard check must cover closed-job todo rendering');
assert.ok(SUITES.check.includes('check-ui-fixture-safety-gate-001.js'), 'standard check must cover the UI fixture fail-closed gate');
assert.ok(SUITES.check.includes('check-ui-job-context-isolation.js'), 'standard check must cover cross-job and cross-candidate stale-response isolation');
assert.ok(SUITES.check.includes('check-ux-g0-a-timeline-visibility.js'), 'standard check must cover canonical timeline visibility');
assert.ok(SUITES.check.includes('check-ux-g0-b-shell-safety-001.js'), 'standard check must cover shell safety');
assert.ok(SUITES.check.includes('check-ux-g0-b2-lazy-failure-matrix-001.js'), 'standard check must cover lazy failure recovery');
assert.ok(DYNAMIC_RUNTIME_TESTS.has('check-ux-g0-b-shell-safety-001.js'), 'standard check must run shell safety dynamically');
assert.ok(DYNAMIC_RUNTIME_TESTS.has('check-ux-g0-b2-lazy-failure-matrix-001.js'), 'standard check must run lazy recovery dynamically');
assert.match(checkSuiteRunnerSource,
  /DYNAMIC_RUNTIME_TESTS\.has\(testFile\) \? \[absoluteTest, '--runtime'\] : \[absoluteTest\]/,
  'standard check runner must pass --runtime to dynamic lazy checks');
assert.ok(SUITES.check.includes('check-ux-g0-c-destructive-action-safety.js'), 'standard check must cover destructive action safety');
assert.ok(SUITES.check.includes('check-ux-g0-d-readonly-history-optional.js'), 'standard check must cover closed-job readonly history');
assert.ok(SUITES.check.includes('check-ux-g0-d2-operational-readonly.js'), 'standard check must cover operational readonly side effects');
assert.ok(SUITES.check.includes('check-ux-w1-a-job-parity.js'), 'standard check must cover formal/fixture job parity');
assert.ok(SUITES.check.includes('check-ux-w1-a-topbar-ownership.js'), 'standard check must cover TopBar action ownership');
assert.ok(SUITES.check.includes('check-ux-w1-a-shell-integration.js'), 'standard check must cover Wave 1 shell integration');
assert.ok(SUITES.check.includes('check-ux-w2-a-candidate-workspace.js'), 'standard check must cover the Wave 2 candidate workspace');
assert.ok(SUITES.check.includes('check-ux-w2-b-talent-resume.js'), 'standard check must cover Wave 2 talent and resume flows');
assert.ok(SUITES.check.includes('check-ux-w3-a-interview-workspace.js'), 'standard check must cover the Wave 3 interview workspace');
assert.ok(SUITES.check.includes('check-ux-w4-a-settings-assessment.js'), 'standard check must cover Wave 4 settings and assessment');
assert.ok(SUITES.check.includes('check-ux-w4-b-deep-profile-recovery.js'), 'standard check must cover Wave 4 deep-profile recovery');
assert.ok(SUITES.check.includes('check-ux-w4-c-guide-ledger.js'), 'standard check must cover Wave 4 guide and ledger surfaces');
assert.ok(
  SUITES.check.includes('check-macos-official-release-gate.js'),
  'standard check must retain the offline official macOS release gate',
);
assert.ok(UI_CHECK_STEPS.includes('check-ux-g0-d-readonly-history-optional.js'), 'UI check must preserve closed-job readonly history');
assert.ok(UI_CHECK_STEPS.includes('check-ux-g0-b-shell-safety-001.js'), 'UI check must run shell safety dynamically');
assert.ok(UI_CHECK_STEPS.includes('check-ux-g0-b2-lazy-failure-matrix-001.js'), 'UI check must run lazy recovery dynamically');
assert.match(checkUiSuiteSource,
  /DYNAMIC_RUNTIME_TESTS\.has\(step\)[\s\S]{0,80}stepArgs\.push\('--runtime'\)/,
  'UI check runner must pass --runtime to dynamic lazy checks');
assert.ok(UI_CHECK_STEPS.includes('check-ux-w1-a-shell-integration.js'), 'UI check must preserve Wave 1 shell integration');
assert.ok(UI_CHECK_STEPS.includes('check-ux-w2-a-candidate-workspace.js'), 'UI check must preserve the Wave 2 candidate workspace');
assert.ok(UI_CHECK_STEPS.includes('check-candidate-communication-drawer-state-001.js'), 'UI check must preserve candidate communication drawer state');
assert.ok(UI_CHECK_STEPS.includes('check-ux-w2-b-talent-resume.js'), 'UI check must preserve Wave 2 talent and resume flows');
assert.ok(UI_CHECK_STEPS.includes('check-ux-w3-a-interview-workspace.js'), 'UI check must preserve the Wave 3 interview workspace');
assert.ok(UI_CHECK_STEPS.includes('check-interview-workflow-ui-state-001.js'), 'UI check must preserve candidate interview workflow state');
assert.ok(UI_CHECK_STEPS.includes('check-ux-w4-a-settings-assessment.js'), 'UI check must preserve Wave 4 settings and assessment');
assert.ok(UI_CHECK_STEPS.includes('check-ux-w4-b-deep-profile-recovery.js'), 'UI check must preserve Wave 4 deep-profile recovery');
assert.ok(UI_CHECK_STEPS.includes('check-ux-w4-c-guide-ledger.js'), 'UI check must preserve Wave 4 guide and ledger surfaces');
assert.ok(SYSTEM_NODE_TESTS.has('check-assessment-controlled-store.js'));
assert.equal(runtimeFor('check-assessment-controlled-store.js'), 'system-node');
assert.ok(SYSTEM_NODE_TESTS.has('check-macos-official-release-gate.js'));
assert.equal(runtimeFor('check-macos-official-release-gate.js'), 'system-node');
assert.equal(runtimeFor('check-schema-migration.js'), 'electron-node');
assert.equal(runtimeFor('check-closed-job-todo-001.js'), 'electron-node');

for (const [scriptName, command] of Object.entries(effectiveScripts)) {
  if (!scriptName.startsWith('check:')) continue;
  for (const testFile of systemNodeCheckFiles(command)) {
    assert.equal(
      reachesBetterSqlite(testFile),
      false,
      `${scriptName} must route ABI-sensitive ${testFile} through check-suite-runner`,
    );
  }
}
assert.match(effectiveScripts['check:workbench'], /check-suite-runner\.js files check-f012-workbench\.js/);
assert.match(effectiveScripts['check:schema-migration'], /check-suite-runner\.js files check-schema-migration\.js/);

assert.doesNotMatch(
  assessmentMigrationRecoverySource,
  /__dirname[\s\S]{0,120}['"]data['"][\s\S]{0,120}['"]recruiting\.db['"]|data[\\/]recruiting\.db|REAL_DB_PATH|real_db_sha256/i,
  'assessment migration recovery check must never reference or hash the repository recruiting database',
);
assert.match(assessmentMigrationRecoverySource, /real_database_accessed: false/);
assert.match(assessmentMigrationRecoverySource, /function hashSyntheticFile\(file\)/);

for (const testFile of databaseIsolationCheckFiles) {
  assertSyntheticDatabaseIsolation(testFile);
}
assertReleaseSecurityDatabaseIsolation(releaseSecuritySource);

assert.deepEqual(UI_CHECK_STEPS, [
  'create-ui-fixture-db.js',
  'check-ui-readonly.js',
  'check-ui-filters.js',
  'check-interview-logistics-ui-001.js',
  'check-interview-preview-responsive-ui-001.js',
  'check-ocr-review-load-state-001.js',
  'check-ocr-unsaved-guard-ui-001.js',
  'check-deep-profile-ui-truth-001.js',
  'check-deep-profile-generation-readiness-001.js',
  'check-assessment-status-truth-ui-001.js',
  'check-ux-g0-b-shell-safety-001.js',
  'check-ux-g0-b2-lazy-failure-matrix-001.js',
  'check-ux-g0-d-readonly-history-optional.js',
  'check-ux-w1-a-shell-integration.js',
  'check-ux-w2-a-candidate-workspace.js',
  'check-candidate-communication-drawer-state-001.js',
  'check-ux-w2-b-talent-resume.js',
  'check-ux-w3-a-interview-workspace.js',
  'check-interview-workflow-ui-state-001.js',
  'check-ux-w4-a-settings-assessment.js',
  'check-ux-w4-b-deep-profile-recovery.js',
  'check-ux-w4-c-guide-ledger.js',
  'check-ui-a11y-copy-001.js',
  'check-ui-remaining-ux-fixes-001.js',
  'check-ui-responsive-surfaces-001.js',
  'check-windows-equivalent-ui-001.js',
  'check-ui-visual-polish-001.js',
  'check-job-context-race-runtime.js',
  'check-ui-visual-runtime-001.js',
]);
assert.throws(
  () => assertManagedRoot(path.resolve(__dirname, 'data')),
  /Refusing to clean an unmanaged UI check directory/,
  'UI fixture cleanup must reject repository data paths',
);

console.log('check-test-pipeline: PASS');
