#!/usr/bin/env node
'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ENV_KEYS, PLAN_MARKER } = require("./support/test-ai-native-approval/signed-plan");

const ROOT = PROJECT_ROOT;
const productionFiles = [
  "src/candidate-main.js",
  "src/preload.js",
  "src/action-server.js",
  "src/f009-user-approval.js",
  'frontend/src/api.js',
  'frontend/src/components/InterviewReviewPanel.jsx',
];

const forgeSource = fs.readFileSync(path.join(ROOT, 'forge.config.js'), 'utf8');
assert.ok(forgeSource.includes('/^\\/checks(?:\\/|$)/'), 'Forge must compile-time exclude the complete checks tree');
assert.ok(forgeSource.includes('/^\\/check-[^/]+\\.js$/'), 'Forge must compile-time exclude root check scripts');
assert.ok(forgeSource.includes('/^\\/fix-evidence(?:\\/|$)/'), 'Forge must compile-time exclude runtime evidence');

for (const relativePath of productionFiles) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
  assert.equal(source.includes(PLAN_MARKER), false, `${relativePath} must not contain the B-2 test marker`);
  for (const key of Object.values(ENV_KEYS)) {
    assert.equal(source.includes(key), false, `${relativePath} must not contain the B-2 test environment key`);
  }
}

const candidateMain = fs.readFileSync(path.join(ROOT, "src/candidate-main.js"), 'utf8');
const handler = candidateMain.slice(
  candidateMain.indexOf("ipcMain.handle('llm-approval:confirm'"),
  candidateMain.indexOf("ipcMain.handle('external-ai-approval:confirm'"),
);
assert.match(handler, /approvalBinding[\s\S]*dialog\.showMessageBox[\s\S]*defaultId: 0[\s\S]*cancelId: 0[\s\S]*result\.response !== 1[\s\S]*issueF009UserApproval/);
assert.doesNotMatch(handler, /process\.env|HRBOSS_B2|TEST|testOnly/);

const bootstrapSource = fs.readFileSync(path.join(ROOT, "tests/support/test-ai-native-approval/bootstrap.js"), 'utf8');
const controllerSource = fs.readFileSync(path.join(ROOT, "tests/support/test-ai-native-approval/runtime-controller.js"), 'utf8');
assert.doesNotMatch(bootstrapSource, /NODE_OPTIONS|https\.request\s*=/,
  'the synthetic journey must use the configured endpoint without transport redirection');
assert.match(controllerSource, /provider: 'synthetic',[\s\S]*?baseUrl: providerBaseUrl/);
assert.match(controllerSource, /window\.llmCredential\.testModel[\s\S]*?window\.llmCredential\.configure[\s\S]*?enabled: true/,
  'the journey must test its model before separately enabling external AI');

console.log('check-ai-native-approval-test-gate-001: PASS (native confirmation contract + compile-time test boundary)');
