#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const forge = require('./forge.config');

const ROOT = __dirname;
const ignoreRules = forge.packagerConfig && forge.packagerConfig.ignore;
assert.ok(Array.isArray(ignoreRules), 'Forge must expose compile-time ignore rules');

function isIgnored(relativePath) {
  const normalized = `/${String(relativePath).split(path.sep).join('/')}`;
  return ignoreRules.some((rule) => rule instanceof RegExp && rule.test(normalized));
}

const testOnlyPaths = [
  'checks/test-talent-final-offer/bootstrap.js',
  'checks/test-talent-final-offer/runtime-controller.js',
  'checks/test-talent-final-offer/runtime-db.js',
  'check-talent-final-offer-runtime-001.js',
  'check-talent-final-offer-test-gate-001.js',
  'fix-evidence/20260729/B-12/B-12-runtime-evidence.json',
];
for (const relativePath of testOnlyPaths) {
  assert.equal(isIgnored(relativePath), true, `${relativePath} must be compile-time excluded`);
}

const productionPaths = [
  'action-server.js',
  'candidate-main.js',
  'preload.js',
  'db.js',
  'frontend/src/api.js',
  'frontend/src/components/TalentPoolDemo.jsx',
  'frontend/src/components/ApplicationFinalReviewPanel.jsx',
  'frontend/src/components/CandidateJourneyOperationsPanel.jsx',
];
const forbiddenMarkers = [
  'HRBOSS_B12_SYNTHETIC_ROOT',
  'test-talent-final-offer',
  'hrboss-b12-talent-final-offer',
  'B-12 合成终评候选人',
];
for (const relativePath of productionPaths) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  for (const marker of forbiddenMarkers) {
    assert.equal(source.includes(marker), false, `${relativePath} must not expose B-12 test marker ${marker}`);
  }
}

const controllerSource = fs.readFileSync(
  path.join(ROOT, 'checks/test-talent-final-offer/runtime-controller.js'),
  'utf8',
);
assert.doesNotMatch(controllerSource, /window\.localApi\s*=/, 'the journey must not replace the trusted local API bridge');
assert.doesNotMatch(controllerSource, /navigator\.clipboard\.writeText/, 'clipboard writes must come from the production TalentPool UI');
assert.match(controllerSource, /window\.localApi\.request/);
assert.match(controllerSource, /OFFER_FINAL_REVIEW_REQUIRED/);
assert.match(controllerSource, /OFFER_INITIAL_STATUS_INVALID/);
assert.match(controllerSource, /授权状态未确认，禁止再触达/);
assert.match(controllerSource, /终评确认尚未改变处置，必须再次显式确认/);

function packagedTextFiles(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return /\.(?:js|mjs|cjs|json|html|css)$/i.test(target) ? [target] : [];
  if (!stat.isDirectory()) return [];
  return fs.readdirSync(target).flatMap((name) => packagedTextFiles(path.join(target, name)));
}

function assertPackagedAppAbsence(packageRoot) {
  if (!packageRoot) return false;
  const resolved = fs.realpathSync(path.resolve(packageRoot));
  for (const relativePath of testOnlyPaths) {
    assert.equal(fs.existsSync(path.join(resolved, relativePath)), false, `${relativePath} leaked into packaged app`);
  }
  const files = [
    ...packagedTextFiles(path.join(resolved, 'action-server.js')),
    ...packagedTextFiles(path.join(resolved, 'candidate-main.js')),
    ...packagedTextFiles(path.join(resolved, 'preload.js')),
    ...packagedTextFiles(path.join(resolved, 'db.js')),
    ...packagedTextFiles(path.join(resolved, 'frontend', 'dist')),
  ];
  assert.ok(files.length > 4, 'packaged app scan must include action, main, preload, DB, and renderer payloads');
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const marker of forbiddenMarkers) {
      assert.equal(source.includes(marker), false, `${path.relative(resolved, filePath)} contains B-12 marker ${marker}`);
    }
  }
  return true;
}

const packageArgument = process.argv.find((value) => value.startsWith('--packaged-app='));
const packagedChecked = assertPackagedAppAbsence(packageArgument ? packageArgument.slice('--packaged-app='.length) : '');
console.log(`check-talent-final-offer-test-gate-001: PASS (trusted bridges + formal package compile-time absence${packagedChecked ? ' + actual packaged payload scan' : ''})`);
