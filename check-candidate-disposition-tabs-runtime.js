#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = __dirname;
const tempRoot = fs.mkdtempSync('/tmp/hrboss-candidate-disposition-tabs-runtime-');
fs.chmodSync(tempRoot, 0o700);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with ${result.signal || result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}

const distRoot = path.join(tempRoot, 'dist');
const userData = path.join(tempRoot, 'electron-user-data');
const evidenceDir = path.join(tempRoot, 'evidence');
const resultPath = path.join(tempRoot, 'result.json');
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
run(npm, ['--prefix', 'frontend', 'run', 'build', '--', '--outDir', distRoot, '--emptyOutDir']);

const electronPath = require('electron');
assert.equal(typeof electronPath, 'string');
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
Object.assign(childEnv, {
  HRBOSS_CANDIDATE_DISPOSITION_TABS_DIST: distRoot,
  HRBOSS_CANDIDATE_DISPOSITION_TABS_USER_DATA: userData,
  HRBOSS_CANDIDATE_DISPOSITION_TABS_EVIDENCE: evidenceDir,
  HRBOSS_CANDIDATE_DISPOSITION_TABS_RESULT: resultPath,
  HRBOSS_EXTERNAL_AI_ENABLED: '0',
  BOSS_ACTION_AUTOMATION_ENABLED: '0',
});
const runtime = run(electronPath, [path.join(ROOT, 'check-candidate-disposition-tabs-runtime-main.js')], {
  env: childEnv,
  timeout: 90000,
});
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
if (result.ok !== true) throw new Error(result.error || 'scoped Electron runtime failed');
console.log(runtime.stdout.trim() || JSON.stringify(result));
console.log(`[CANDIDATE-DISPOSITION-TABS-RUNTIME] artifacts retained at ${tempRoot}`);
