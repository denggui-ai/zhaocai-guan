#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = __dirname;
const {
  ENV_KEYS,
  PLAN_MARKER,
  PLAN_TTL_MS,
  createSelectionQueue,
  encodePlan,
  loadSignedPlan,
} = require('./checks/test-native-file-selection/signed-plan');

function writePrivate(target, content) {
  fs.writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
}

function isIgnored(ignoreRules, relativePath) {
  const forgePath = `/${relativePath.split(path.sep).join('/')}`;
  return ignoreRules.some((rule) => {
    if (!(rule instanceof RegExp)) return false;
    rule.lastIndex = 0;
    return rule.test(forgePath);
  });
}

function filesUnder(root, relative = '', excludedNames = new Set()) {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (excludedNames.has(entry.name)) continue;
    if (entry.isDirectory()) result.push(...filesUnder(root, next, excludedNames));
    else if (entry.isFile()) result.push(next);
  }
  return result;
}

function assertCompileTimeAbsence() {
  const forgeConfig = require('./forge.config');
  const ignoreRules = forgeConfig.packagerConfig.ignore;
  const testFiles = [
    'checks/test-native-file-selection/signed-plan.js',
    'checks/test-native-file-selection/bootstrap.js',
    'checks/test-native-file-selection/create-synthetic-assets-main.js',
    'checks/test-native-file-selection/runtime-controller.js',
    'checks/test-native-file-selection/runtime-db.js',
    'check-native-file-selection-test-gate-001.js',
    'check-native-file-selection-runtime-001.js',
  ];
  for (const file of testFiles) {
    assert.equal(isIgnored(ignoreRules, file), true, `${file} must be compile-time excluded by Forge`);
  }

  const markerNeedles = [PLAN_MARKER, ...Object.values(ENV_KEYS)];
  const markerFiles = filesUnder(ROOT, '', new Set(['.git', 'node_modules', 'out', 'outputs', 'handoff'])).filter((relativePath) => {
    const source = fs.readFileSync(path.join(ROOT, relativePath));
    return markerNeedles.some((needle) => source.includes(Buffer.from(needle)));
  });
  assert.ok(markerFiles.length >= 1, 'the test channel marker must be present in test-only sources');
  assert.deepEqual(
    markerFiles.filter((relativePath) => !isIgnored(ignoreRules, relativePath)),
    [],
    'every source containing the test channel marker must be excluded from the formal package',
  );

  for (const productionSource of ['candidate-main.js', 'preload.js', 'frontend/src/api.js']) {
    const source = fs.readFileSync(path.join(ROOT, productionSource), 'utf8');
    for (const needle of markerNeedles) {
      assert.equal(source.includes(needle), false, `${productionSource} must not contain the test channel`);
    }
  }
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  assert.doesNotMatch(preload, /test-native-file-selection|testNativeFileSelection/i);
  assert.equal(isIgnored(ignoreRules, 'fix-evidence/20260729/B-1/B-1-runtime-evidence.json'), true,
    'audit screenshots and runtime evidence must also stay outside the formal application payload');
}

function assertPackagedAppAbsence(packagedAppInput) {
  if (!packagedAppInput) return false;
  const packagedApp = fs.realpathSync(path.resolve(packagedAppInput));
  assert.equal(fs.statSync(packagedApp).isDirectory(), true, 'packaged app payload must be a directory');
  const packagedFiles = filesUnder(packagedApp);
  assert.equal(
    packagedFiles.some((relativePath) => relativePath === 'checks'
      || relativePath.startsWith(`checks${path.sep}`)
      || /^check-[^/]+\.js$/.test(relativePath.split(path.sep).join('/'))
      || relativePath === 'fix-evidence'
      || relativePath.startsWith(`fix-evidence${path.sep}`)),
    false,
    'formal packaged payload must not contain checks, root check scripts, or evidence',
  );
  const markerNeedles = [PLAN_MARKER, ...Object.values(ENV_KEYS), 'test-native-file-selection'];
  const markerMatches = packagedFiles.filter((relativePath) => {
    const target = path.join(packagedApp, relativePath);
    const stat = fs.statSync(target);
    if (stat.size > 8 * 1024 * 1024) return false;
    const bytes = fs.readFileSync(target);
    return markerNeedles.some((needle) => bytes.includes(Buffer.from(needle)));
  });
  assert.deepEqual(markerMatches, [], 'formal packaged payload must not contain the synthetic native selection channel');
  return true;
}

function assertSignedPlanSecurity() {
  const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-native-selection-gate-'));
  const tempRoot = fs.realpathSync(createdRoot);
  if (process.platform !== 'win32') fs.chmodSync(tempRoot, 0o700);
  try {
    const screenshotDir = path.join(tempRoot, 'screenshots');
    fs.mkdirSync(screenshotDir, { mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(screenshotDir, 0o700);
    const resumePath = path.join(tempRoot, 'synthetic-resume.txt');
    const assessmentPath = path.join(tempRoot, 'synthetic-assessment.pdf');
    writePrivate(resumePath, '姓名：合成测试候选人\n5年工作经验\n');
    writePrivate(assessmentPath, '%PDF-1.4\n% synthetic assessment\n%%EOF\n');
    const now = 1_800_000_000_000;
    const secret = 'b1-independent-test-secret-'.padEnd(64, 'x');
    const signed = encodePlan(secret, {
      synthetic_root: tempRoot,
      entries: [
        {
          title: '上传简历并创建候选人',
          properties: ['openFile'],
          paths: [resumePath],
        },
        {
          title: '选择 Boss App 截图文件夹',
          properties: ['openDirectory'],
          paths: [screenshotDir],
        },
        {
          title: '选择一份或多份 PDF 测评报告',
          properties: ['openFile', 'multiSelections'],
          paths: [assessmentPath],
        },
      ],
    }, { now });
    const planPath = path.join(tempRoot, 'selection-plan.json');
    writePrivate(planPath, JSON.stringify(signed));
    const plan = loadSignedPlan({ marker: PLAN_MARKER, planPath, secret, now: now + 1 });
    const queue = createSelectionQueue(plan);
    assert.deepEqual(queue.next({
      title: '上传简历并创建候选人',
      properties: ['openFile'],
    }).filePaths, [resumePath]);
    assert.throws(
      () => queue.next({ title: '选择一份或多份 PDF 测评报告', properties: ['openFile', 'multiSelections'] }),
      { code: 'TEST_SELECTION_DIALOG_MISMATCH' },
      'signed dialog entries cannot be reordered',
    );

    assert.throws(
      () => loadSignedPlan({ marker: PLAN_MARKER, planPath, secret: 'wrong'.padEnd(64, 'x'), now: now + 1 }),
      { code: 'TEST_SELECTION_PLAN_INVALID' },
      'the production selection secrets cannot substitute for the independent test secret',
    );
    assert.throws(
      () => loadSignedPlan({ marker: 'wrong-marker', planPath, secret, now: now + 1 }),
      { code: 'TEST_SELECTION_MARKER_INVALID' },
    );
    assert.throws(
      () => loadSignedPlan({ marker: PLAN_MARKER, planPath, secret, now: now + PLAN_TTL_MS + 1 }),
      { code: 'TEST_SELECTION_PLAN_EXPIRED' },
    );

    const tampered = { ...signed, encoded: `${signed.encoded.slice(0, -1)}A` };
    const tamperedPath = path.join(tempRoot, 'tampered-plan.json');
    writePrivate(tamperedPath, JSON.stringify(tampered));
    assert.throws(
      () => loadSignedPlan({ marker: PLAN_MARKER, planPath: tamperedPath, secret, now: now + 1 }),
      { code: 'TEST_SELECTION_PLAN_INVALID' },
    );

    const outside = path.join(os.tmpdir(), `hrboss-outside-${process.pid}.txt`);
    writePrivate(outside, 'synthetic outside root');
    try {
      assert.throws(
        () => encodePlan(secret, {
          synthetic_root: tempRoot,
          entries: [{
            title: '上传简历并创建候选人',
            properties: ['openFile'],
            paths: [outside],
          }],
        }, { now }),
        { code: 'TEST_SELECTION_PATH_OUTSIDE_ROOT' },
      );
    } finally {
      fs.rmSync(outside, { force: true });
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function run() {
  assertSignedPlanSecurity();
  assertCompileTimeAbsence();
  const packageArgument = process.argv.find((value) => value.startsWith('--packaged-app='));
  const packagedChecked = assertPackagedAppAbsence(packageArgument ? packageArgument.slice('--packaged-app='.length) : '');
  console.log(`check-native-file-selection-test-gate-001: PASS (signed synthetic gate + formal package compile-time absence${packagedChecked ? ' + actual packaged payload scan' : ''})`);
}

try {
  run();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
