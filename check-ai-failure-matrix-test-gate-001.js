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
  'checks/test-ai-failure-matrix/bootstrap.js',
  'checks/test-ai-failure-matrix/runtime-controller.js',
  'checks/test-ai-failure-matrix/runtime-db.js',
  'checks/test-ai-failure-matrix/signed-plan.js',
  'check-ai-failure-matrix-runtime-001.js',
  'check-ai-failure-matrix-test-gate-001.js',
  'fix-evidence/20260729/B-11/B-11-runtime-evidence.json',
];
for (const relativePath of testOnlyPaths) {
  assert.equal(isIgnored(relativePath), true, `${relativePath} must be compile-time excluded`);
}

const productionPaths = [
  'action-server.js',
  'candidate-main.js',
  'preload.js',
  'f009-interview-llm.js',
  'frontend/src/api.js',
  'frontend/src/components/InterviewReviewPanel.jsx',
];
const forbiddenMarkers = [
  'HRBOSS_B11_PROVIDER_BASE_URL',
  'test-ai-failure-matrix',
  'hrboss-b11-ai-failure-matrix',
  'B-11 synthetic provider failure',
];
for (const relativePath of productionPaths) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  for (const marker of forbiddenMarkers) {
    assert.equal(source.includes(marker), false, `${relativePath} must not expose B-11 test marker ${marker}`);
  }
}

const controllerSource = fs.readFileSync(
  path.join(ROOT, 'checks/test-ai-failure-matrix/runtime-controller.js'),
  'utf8',
);
const bootstrapSource = fs.readFileSync(path.join(ROOT, 'checks/test-ai-failure-matrix/bootstrap.js'), 'utf8');
assert.doesNotMatch(bootstrapSource, /NODE_OPTIONS|https\.request\s*=/,
  'the synthetic journey must use the configured endpoint without transport redirection');
assert.match(controllerSource, /provider: 'synthetic',[\s\S]*?baseUrl: providerBaseUrl/);
assert.match(controllerSource, /window\.llmCredential\.testModel[\s\S]*?window\.llmCredential\.configure[\s\S]*?enabled: true/,
  'the journey must test its model before separately enabling external AI');
assert.doesNotMatch(controllerSource, /window\.localApi\s*=/, 'the journey must not replace the trusted local API bridge');
assert.doesNotMatch(controllerSource, /window\.llmApproval\s*=/, 'the journey must not replace the trusted native approval bridge');
assert.match(controllerSource, /window\.llmApproval\.confirm/);
assert.match(controllerSource, /PREVIEW_HASH_MISMATCH/);
assert.match(controllerSource, /PROVIDER_HTTP_ERROR/);
assert.match(controllerSource, /PROVIDER_INVALID_JSON/);
assert.match(controllerSource, /EVIDENCE_UNIT_NOT_ALLOWED/);
assert.match(controllerSource, /REQUEST_TIMEOUT/);

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
    ...packagedTextFiles(path.join(resolved, 'f009-interview-llm.js')),
    ...packagedTextFiles(path.join(resolved, 'frontend', 'dist')),
  ];
  assert.ok(files.length > 4, 'packaged app scan must include action, main, preload, F-009, and renderer payloads');
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const marker of forbiddenMarkers) {
      assert.equal(source.includes(marker), false, `${path.relative(resolved, filePath)} contains B-11 marker ${marker}`);
    }
  }
  return true;
}

const packageArgument = process.argv.find((value) => value.startsWith('--packaged-app='));
const packagedChecked = assertPackagedAppAbsence(packageArgument ? packageArgument.slice('--packaged-app='.length) : '');
console.log(`check-ai-failure-matrix-test-gate-001: PASS (real trusted bridges + formal package compile-time absence${packagedChecked ? ' + actual packaged payload scan' : ''})`);
