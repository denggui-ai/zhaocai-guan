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
  'checks/test-interview-asr-runtime/bootstrap.js',
  'checks/test-interview-asr-runtime/runtime-controller.js',
  'checks/test-interview-asr-runtime/runtime-db.js',
  'check-interview-asr-runtime-001.js',
  'check-interview-asr-test-gate-001.js',
  'fix-evidence/20260729/B-6/B-6-runtime-evidence.json',
];
for (const relativePath of testOnlyPaths) {
  assert.equal(isIgnored(relativePath), true, `${relativePath} must be compile-time excluded`);
}

const productionPaths = [
  'candidate-main.js',
  'preload.js',
  'frontend/src/api.js',
  'frontend/src/App.jsx',
  'frontend/src/components/InterviewReviewPanel.jsx',
];
const forbiddenMarkers = [
  'HRBOSS_B6_SYNTHETIC_ROOT',
  'test-interview-asr-runtime',
  'Synthetic interview ASR runtime',
  'hrboss-b6-interview-asr',
];
for (const relativePath of productionPaths) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  for (const marker of forbiddenMarkers) {
    assert.equal(source.includes(marker), false, `${relativePath} must not expose B-6 test marker ${marker}`);
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
    ...packagedTextFiles(path.join(resolved, 'candidate-main.js')),
    ...packagedTextFiles(path.join(resolved, 'preload.js')),
    ...packagedTextFiles(path.join(resolved, 'frontend', 'dist')),
  ];
  assert.ok(files.length > 2, 'packaged app scan must include main, preload, and renderer payloads');
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const marker of forbiddenMarkers) {
      assert.equal(source.includes(marker), false, `${path.relative(resolved, filePath)} contains B-6 marker ${marker}`);
    }
  }
  return true;
}

const packageArgument = process.argv.find((value) => value.startsWith('--packaged-app='));
const packagedChecked = assertPackagedAppAbsence(packageArgument ? packageArgument.slice('--packaged-app='.length) : '');
console.log(`check-interview-asr-test-gate-001: PASS (formal package compile-time absence${packagedChecked ? ' + actual packaged payload scan' : ''})`);
