#!/usr/bin/env node
'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

const visualRuntime = read("tests/check-ui-visual-runtime-main.js");
const candidateRuntime = read("tests/check-candidate-disposition-tabs-runtime-main.js");
const jobRuntime = read("tests/check-job-priority-button-runtime-main.js");
const app = read('frontend/src/App.jsx');
const forge = read('forge.config.js');
const windowsAcceptancePath = path.join(PROJECT_ROOT, 'release', 'windows-release-self-test.ps1');
const windowsAcceptanceBytes = fs.readFileSync(windowsAcceptancePath);
const windowsAcceptance = windowsAcceptanceBytes.toString('utf8');
const { getGroup } = require("./support/registry");

for (const contract of [
  ["zoomFactor: 1.25", "'1360x768@125%'"],
  ["zoomFactor: 1.5", "'1360x768@150%'"],
  ["zoomFactor: 2", "'1440x900@200%'"],
]) {
  assert.ok(contract.every((token) => visualRuntime.includes(token)),
    `six-module runtime must retain the ${contract[1]} equivalent viewport`);
}
assert.match(visualRuntime, /verifyRendererRestartState\(win\)/,
  'the isolated renderer restart must remain part of the visual runtime');
for (const storageKey of [
  'hrboss.ui.brandName.v1',
  'hrboss.ui.currentJobId.v1',
  'hrboss.ui.candidateListCollapsed.v1',
]) {
  assert.ok(visualRuntime.includes(storageKey) && app.includes(storageKey),
    `restart coverage and production UI must share ${storageKey}`);
}
assert.match(visualRuntime,
  /windows150-restart-state-recovery[\s\S]*?restarted renderer must not emit console errors/,
  'Windows 150% restart evidence must remain fail-closed on renderer errors');

assert.match(candidateRuntime, /Windows 125% candidate domain/);
assert.match(candidateRuntime, /Windows 150% candidate domain/);
assert.match(candidateRuntime, /candidate-disposition-menu-1360x768-windows150/);
assert.match(candidateRuntime,
  /closeDispositionMenuWithEscape\(win, 'Windows 150% candidate disposition menu'\)/,
  'Windows 150% candidate actions must retain the keyboard Escape/focus-restoration check');
assert.match(jobRuntime, /job-workspace-readonly-1360x768-windows125/);
assert.match(jobRuntime, /job-workspace-readonly-1360x768-windows150/);
assert.match(jobRuntime,
  /keyboard return focus to the same visible job action/,
  'Windows-equivalent job-editor coverage must retain semantic return-focus restoration');

assert.match(forge, /postPackage: installTargetNativeBinary/,
  'Windows packaging must replace cross-platform native modules');
assert.match(forge, /signature !== 'MZ'/,
  'Windows packaging must reject a non-PE better-sqlite3 binary');
assert.deepEqual([...windowsAcceptanceBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf],
  'Windows PowerShell acceptance must retain its UTF-8 BOM');
assert.match(windowsAcceptance, /Invoke-DatabaseProbe -Mode write/);
assert.match(windowsAcceptance, /Invoke-DatabaseProbe -Mode read/);
assert.match(windowsAcceptance, /Start-IsolatedApplication -Cycle 2/);
assert.match(windowsAcceptance, /RUN-LOOPBACK-2/);
assert.match(windowsAcceptance, /HRBOSS_EXTERNAL_AI_ENABLED' -Value '0'/);
assert.match(windowsAcceptance, /BOSS_ACTION_AUTOMATION_ENABLED' -Value '0'/);
assert.ok(getGroup('check').includes('tests/check-windows-asr-degradation.js'),
  'the release suite must retain the Windows microphone/ASR degradation contract');

console.log(JSON.stringify({
  ok: true,
  contract: 'WINDOWS-EQUIVALENT-UI-001',
  equivalent_scales: ['125%', '150%', '200%'],
  restart_preferences: [
    'brand-name-long-chinese',
    'current-job',
    'candidate-list-collapse',
  ],
  package_contracts: [
    'windows-path-and-bom',
    'better-sqlite3-pe-x64',
    'database-restart-probe',
    'local-service-restart-probe',
    'asr-degraded-fail-closed',
  ],
}));
