#!/usr/bin/env node
'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = PROJECT_ROOT;

function runSyncChecked(command, args, options = {}) {
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

function processTable() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('cannot snapshot the process table');
  return result.stdout.trim().split('\n').map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}

function descendantPids(rootPid, rows) {
  const owned = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.ppid) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
    }
  }
  owned.delete(rootPid);
  return owned;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopExactPids(pids) {
  const targets = [...pids]
    .filter((pid) => Number.isInteger(pid) && pid > 1 && isAlive(pid))
    .sort((left, right) => right - left);
  for (const pid of targets) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && targets.some(isAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  for (const pid of targets.filter(isAlive)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

async function runElectron(electronPath, args, env, timeoutMs, baselinePids) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, args, {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ownedPids = new Set([child.pid]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const monitor = setInterval(() => {
      for (const pid of descendantPids(child.pid, processTable())) {
        if (!baselinePids.has(pid)) ownedPids.add(pid);
      }
    }, 250);
    const timeout = setTimeout(async () => {
      clearInterval(monitor);
      await stopExactPids(ownedPids);
      reject(new Error(`job lifecycle Electron journey timed out\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.once('error', async (error) => {
      clearTimeout(timeout);
      clearInterval(monitor);
      await stopExactPids(ownedPids);
      reject(error);
    });
    child.once('exit', async (code, signal) => {
      clearTimeout(timeout);
      clearInterval(monitor);
      await new Promise((done) => setTimeout(done, 600));
      const survivors = [...ownedPids].filter((pid) => !baselinePids.has(pid) && isAlive(pid));
      await stopExactPids(survivors);
      resolve({ code, signal, stdout, stderr, survivors });
    });
  });
}

function copyEvidence(sourceRoot, targetRoot) {
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  const copied = [];
  for (const name of fs.readdirSync(sourceRoot).sort()) {
    if (!name.endsWith('.png')) continue;
    fs.copyFileSync(path.join(sourceRoot, name), path.join(targetRoot, name));
    if (process.platform !== 'win32') fs.chmodSync(path.join(targetRoot, name), 0o600);
    copied.push(name);
  }
  return copied;
}

async function run() {
  const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-b4-job-lifecycle-'));
  const syntheticRoot = fs.realpathSync(createdRoot);
  if (process.platform !== 'win32') fs.chmodSync(syntheticRoot, 0o700);
  const keepArtifacts = process.env.HRBOSS_KEEP_B4_ARTIFACTS === '1';
  try {
    for (const dir of ['data', 'profile', 'user-data', 'evidence']) {
      fs.mkdirSync(path.join(syntheticRoot, dir), { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') fs.chmodSync(path.join(syntheticRoot, dir), 0o700);
    }
    const electronPath = require('electron');
    const electronNodeEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HRBOSS_TEST_RUNTIME: 'electron-node',
    };
    runSyncChecked(electronPath, [
      path.join(ROOT, "tests/support/test-job-lifecycle/runtime-db.js"),
      syntheticRoot,
      'seed',
    ], { env: electronNodeEnv, timeout: 60_000 });
    runSyncChecked(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', 'frontend', 'run', 'build'], {
      timeout: 120_000,
    });

    const baselinePids = new Set(processTable().map((row) => row.pid));
    const runtimeEnv = {
      ...process.env,
      HRBOSS_B4_SYNTHETIC_ROOT: syntheticRoot,
      HRBOSS_DATA_DIR: path.join(syntheticRoot, 'data'),
      BOSS_DB_PATH: path.join(syntheticRoot, 'data', 'recruiting.db'),
      BOSS_PROFILE_DATA_DIR: path.join(syntheticRoot, 'profile'),
      HRBOSS_EXTERNAL_AI_ENABLED: '0',
      HRBOSS_ASSESSMENT_PHASE_A_ENABLED: '0',
      HRBOSS_F018_ENABLED: '0',
      BOSS_ACTION_AUTOMATION_ENABLED: '0',
    };
    delete runtimeEnv.ELECTRON_RUN_AS_NODE;
    const runtime = await runElectron(
      electronPath,
      [path.join(ROOT, "tests/support/test-job-lifecycle/bootstrap.js")],
      runtimeEnv,
      5 * 60 * 1000,
      baselinePids,
    );
    const resultPath = path.join(syntheticRoot, 'runtime-result.json');
    assert.equal(fs.existsSync(resultPath), true, `runtime must write a result\n${runtime.stdout}\n${runtime.stderr}`);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(result.ok, true, result.error || runtime.stderr);
    assert.equal(runtime.code, 0, `Electron exited with ${runtime.signal || runtime.code}\n${runtime.stderr}`);
    assert.equal(runtime.survivors.length, 0, `spawned PID survivors: ${runtime.survivors.join(', ')}`);

    const verification = runSyncChecked(electronPath, [
      path.join(ROOT, "tests/support/test-job-lifecycle/runtime-db.js"),
      syntheticRoot,
      'verify',
    ], { env: electronNodeEnv, timeout: 60_000 });
    const database = JSON.parse(verification.stdout);
    assert.equal(database.ok, true);

    const evidenceRoot = process.env.HRBOSS_B4_EVIDENCE_DIR
      ? path.resolve(process.env.HRBOSS_B4_EVIDENCE_DIR)
      : null;
    const screenshots = evidenceRoot
      ? copyEvidence(path.join(syntheticRoot, 'evidence'), evidenceRoot)
      : fs.readdirSync(path.join(syntheticRoot, 'evidence')).filter((name) => name.endsWith('.png')).sort();
    const manifest = {
      ...result,
      database,
      screenshots,
      spawned_pid_survivors: runtime.survivors,
    };
    if (evidenceRoot) {
      const manifestPath = path.join(evidenceRoot, 'B-4-runtime-evidence.json');
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(manifestPath, 0o600);
    }
    console.log(JSON.stringify({
      ok: true,
      evidence_level: 'E4',
      runtime_boundary: result.runtime_boundary,
      job_count_before_after: [result.before.job_count, result.after.job_count],
      original_final_status: database.original.status,
      copied_status: database.copied.status,
      jd_status: database.original.jd.status,
      profile_status: database.original.profile.status,
      expected_versions: result.version_contract,
      audit_actions: database.audit_actions,
      screenshots,
      spawned_pid_survivors: runtime.survivors,
    }, null, 2));
  } finally {
    if (keepArtifacts) console.log(`[B-4] synthetic evidence retained at ${syntheticRoot}`);
    else fs.rmSync(syntheticRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
