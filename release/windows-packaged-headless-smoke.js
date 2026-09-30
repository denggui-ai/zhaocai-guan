'use strict';

// Exercises the packaged Windows executable without claiming desktop UI acceptance.
// The same packaged Electron binary opens SQLite in two separate processes.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { inspectWindowsPackage } = require('./build-windows-candidate');

function probe(mode, moduleDirectory, databasePath, marker) {
  const Database = require(moduleDirectory);
  const db = new Database(databasePath);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS smoke_marker (value TEXT PRIMARY KEY)');
    if (mode === 'write') {
      db.prepare('INSERT INTO smoke_marker (value) VALUES (?)').run(marker);
    } else if (mode === 'read') {
      const row = db.prepare('SELECT value FROM smoke_marker WHERE value = ?').get(marker);
      if (!row) throw new Error('the marker written by the first packaged process is missing');
    } else {
      throw new Error(`unknown probe mode: ${mode}`);
    }
    process.stdout.write(`${JSON.stringify({ mode, marker, ok: true, electron: process.versions.electron || null })}\n`);
  } finally {
    db.close();
  }
}

function runPackagedProbe(executable, mode, moduleDirectory, databasePath, marker) {
  const result = spawnSync(executable, [__filename, '--probe', mode, moduleDirectory, databasePath, marker], {
    encoding: 'utf8',
    timeout: 45000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HRBOSS_EXTERNAL_AI_ENABLED: '0',
      BOSS_ACTION_AUTOMATION_ENABLED: '0',
    },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`packaged ${mode} probe failed (${result.status}): ${String(result.stderr || result.stdout).trim()}`);
  }
  const output = JSON.parse(String(result.stdout).trim());
  if (output.mode !== mode || output.marker !== marker || output.ok !== true || !output.electron) {
    throw new Error(`packaged ${mode} probe returned an unexpected result`);
  }
  return output;
}

function runSmoke(packageDirectory, evidencePath) {
  const report = {
    schema_version: 'zhaocai_windows_packaged_headless_smoke_v1',
    scope: 'packaged Electron Node runtime and SQLite persistence; no desktop UI, installation, or signing claim',
    platform: process.platform,
    architecture: process.arch,
    status: 'FAIL',
    checks: [],
  };
  let isolatedRoot;
  try {
    if (process.platform !== 'win32' || process.arch !== 'x64') {
      throw new Error('this packaged smoke check requires a Windows x64 runner');
    }
    const packageInfo = inspectWindowsPackage(packageDirectory);
    report.checks.push('PE x64 executable and native module; package exclusions');
    report.package_file_count = packageInfo.package_file_count;
    report.package_tree_sha256 = packageInfo.package_tree_sha256;
    report.executable_sha256 = packageInfo.executable_sha256;
    report.native_module_sha256 = packageInfo.native_module_sha256;

    const executable = path.join(packageDirectory, 'ZhaocaiGuan.exe');
    const moduleDirectory = path.join(packageDirectory, 'resources', 'app', 'node_modules', 'better-sqlite3');
    isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhaocai-win-packaged-smoke-'));
    const databasePath = path.join(isolatedRoot, 'smoke.db');
    const marker = crypto.randomUUID();
    const writeResult = runPackagedProbe(executable, 'write', moduleDirectory, databasePath, marker);
    report.checks.push('packaged Electron process loaded better-sqlite3 and wrote isolated SQLite');
    const readResult = runPackagedProbe(executable, 'read', moduleDirectory, databasePath, marker);
    if (writeResult.electron !== readResult.electron) throw new Error('packaged Electron version changed between processes');
    report.electron_version = writeResult.electron;
    report.checks.push('second packaged Electron process read the persisted SQLite marker');
    report.status = 'PASS';
  } catch (error) {
    report.error = error.message;
  } finally {
    if (isolatedRoot) {
      try {
        fs.rmSync(isolatedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch (error) {
        report.status = 'FAIL';
        report.error = `isolated test data cleanup failed: ${error.message}`;
      }
    }
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
    fs.writeFileSync(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }
  if (report.status !== 'PASS') process.exitCode = 1;
}

if (process.argv[2] === '--probe') {
  try {
    probe(process.argv[3], process.argv[4], process.argv[5], process.argv[6]);
  } catch (error) {
    console.error(error.stack || error);
    process.exitCode = 1;
  }
} else if (require.main === module) {
  const packageDirectory = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist', '招才官-win32-x64'));
  const evidencePath = path.resolve(process.argv[3] || path.join(__dirname, '..', 'dist', 'windows-packaged-headless-smoke.json'));
  runSmoke(packageDirectory, evidencePath);
}

module.exports = { probe, runPackagedProbe, runSmoke };
