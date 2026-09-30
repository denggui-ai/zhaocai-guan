#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = __dirname;
const tempRoot = fs.mkdtempSync('/tmp/hrboss-job-priority-runtime-');
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
run(npm, ['--prefix', 'frontend', 'run', 'build', '--', '--outDir', distRoot, '--emptyOutDir'], {
  env: { ...process.env, VITE_READONLY_UI: '1' },
});

const electronPath = require('electron');
assert.equal(typeof electronPath, 'string');
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
Object.assign(childEnv, {
  HRBOSS_JOB_PRIORITY_DIST: distRoot,
  HRBOSS_JOB_PRIORITY_USER_DATA: userData,
  HRBOSS_JOB_PRIORITY_EVIDENCE: evidenceDir,
  HRBOSS_JOB_PRIORITY_RESULT: resultPath,
  HRBOSS_EXTERNAL_AI_ENABLED: '0',
  BOSS_ACTION_AUTOMATION_ENABLED: '0',
});
const runtime = run(electronPath, [path.join(ROOT, 'check-job-priority-button-runtime-main.js')], {
  env: childEnv,
  timeout: 60000,
});
const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
assert.equal(result.ok, true);
console.log(runtime.stdout.trim() || JSON.stringify(result));
console.log(`[JOB-PRIORITY-BUTTON-RUNTIME] artifacts retained at ${tempRoot}`);
