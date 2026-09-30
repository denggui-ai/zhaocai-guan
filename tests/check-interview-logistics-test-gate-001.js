#!/usr/bin/env node
'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const forge = require("../forge.config");

const ROOT = PROJECT_ROOT;
const ignoreRules = forge.packagerConfig && forge.packagerConfig.ignore;
assert.ok(Array.isArray(ignoreRules), 'Forge must expose compile-time ignore rules');

function isIgnored(relativePath) {
  const normalized = `/${String(relativePath).split(path.sep).join('/')}`;
  return ignoreRules.some((rule) => rule instanceof RegExp && rule.test(normalized));
}

const testOnlyPaths = [
  "tests/support/test-interview-logistics-runtime/bootstrap.js",
  "tests/support/test-interview-logistics-runtime/runtime-controller.js",
  "tests/support/test-interview-logistics-runtime/runtime-db.js",
  "tests/check-interview-logistics-runtime-001.js",
  "tests/check-interview-logistics-test-gate-001.js",
  'fix-evidence/20260729/B-5/B-5-runtime-evidence.json',
];
for (const relativePath of testOnlyPaths) {
  assert.equal(isIgnored(relativePath), true, `${relativePath} must be compile-time excluded`);
}

const productionPaths = [
  "src/candidate-main.js",
  "src/preload.js",
  'frontend/src/api.js',
  'frontend/src/App.jsx',
  'frontend/src/components/InterviewScheduleCanonical.jsx',
];
const forbiddenMarkers = [
  'HRBOSS_B5_SYNTHETIC_ROOT',
  'test-interview-logistics-runtime',
  'Synthetic interview logistics runtime',
  'setBackgroundThrottling(false)',
];
for (const relativePath of productionPaths) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  for (const marker of forbiddenMarkers) {
    assert.equal(source.includes(marker), false, `${relativePath} must not expose B-5 test marker ${marker}`);
  }
}

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
  assert.equal(fs.statSync(resolved).isDirectory(), true, 'packaged app payload must be a directory');
  for (const relativePath of testOnlyPaths) {
    assert.equal(fs.existsSync(path.join(resolved, relativePath)), false, `${relativePath} leaked into packaged app`);
  }
  const files = [
    ...packagedTextFiles(path.join(resolved, "src/candidate-main.js")),
    ...packagedTextFiles(path.join(resolved, "src/preload.js")),
    ...packagedTextFiles(path.join(resolved, 'frontend', 'dist')),
  ];
  assert.ok(files.length > 2, 'packaged app scan must include main, preload, and renderer payloads');
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const marker of forbiddenMarkers) {
      assert.equal(source.includes(marker), false, `${path.relative(resolved, filePath)} contains B-5 marker ${marker}`);
    }
  }
  return true;
}

const packageArgument = process.argv.find((value) => value.startsWith('--packaged-app='));
const packagedChecked = assertPackagedAppAbsence(packageArgument ? packageArgument.slice('--packaged-app='.length) : '');
console.log(`check-interview-logistics-test-gate-001: PASS (formal package compile-time absence${packagedChecked ? ' + actual packaged payload scan' : ''})`);
