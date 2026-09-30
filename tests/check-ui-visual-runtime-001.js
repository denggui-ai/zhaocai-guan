#!/usr/bin/env node
'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = PROJECT_ROOT;
const requestedTempParent = String(process.env.HRBOSS_VISUAL_RUNTIME_TEMP_PARENT || '').trim();
const tempParent = requestedTempParent ? fs.realpathSync(requestedTempParent) : os.tmpdir();
const tempRoot = fs.mkdtempSync(path.join(tempParent, 'hrboss-ui-visual-runtime-'));
fs.chmodSync(tempRoot, 0o700);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with ${result.error?.message || result.signal || result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}

try {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const distRoot = path.join(tempRoot, 'dist');
  const resultPath = path.join(tempRoot, 'result.json');
  const userData = path.join(tempRoot, 'electron-user-data');
  const evidenceDir = process.env.HRBOSS_VISUAL_RUNTIME_EVIDENCE_DIR
    ? path.resolve(process.env.HRBOSS_VISUAL_RUNTIME_EVIDENCE_DIR)
    : path.join(tempRoot, 'evidence');
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
  run(npm, ['--prefix', 'frontend', 'run', 'build', '--', '--outDir', distRoot, '--emptyOutDir']);
  if (process.platform === 'darwin') {
    run('/usr/bin/xattr', ['-cr', distRoot]);
  }

  const electronPath = require('electron');
  assert.equal(typeof electronPath, 'string', 'Electron executable path must resolve in Node mode');
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  Object.assign(childEnv, {
    HRBOSS_VISUAL_RUNTIME_DIST: distRoot,
    HRBOSS_VISUAL_RUNTIME_RESULT: resultPath,
    HRBOSS_VISUAL_RUNTIME_USER_DATA: userData,
    HRBOSS_VISUAL_RUNTIME_EVIDENCE_DIR: evidenceDir,
    HRBOSS_EXTERNAL_AI_ENABLED: '0',
    BOSS_ACTION_AUTOMATION_ENABLED: '0',
  });
  const runtime = run(electronPath, [path.join(ROOT, "tests/check-ui-visual-runtime-main.js")], {
    env: childEnv,
    timeout: 240000,
  });
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert.equal(result.ok, true, result.error || 'visual runtime returned ok=false without an error');
  console.log(runtime.stdout.trim() || JSON.stringify(result));
} finally {
  const keep = process.env.HRBOSS_KEEP_UI_CHECK_ARTIFACTS === '1';
  if (keep) console.log(`[UI-VISUAL-RUNTIME-001] evidence retained at ${tempRoot}`);
  else fs.rmSync(tempRoot, { recursive: true, force: true });
}
