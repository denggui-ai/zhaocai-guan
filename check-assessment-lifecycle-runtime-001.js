#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  ENV_KEYS,
  PLAN_MARKER,
  encodePlan,
} = require('./checks/test-native-file-selection/signed-plan');

const ROOT = __dirname;

function writePrivate(target, bytes) {
  fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
}

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
      reject(new Error(`assessment lifecycle Electron journey timed out\n${stdout}\n${stderr}`));
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
  const screenshots = [];
  for (const name of fs.readdirSync(sourceRoot).sort()) {
    if (!name.endsWith('.png')) continue;
    const target = path.join(targetRoot, name);
    fs.copyFileSync(path.join(sourceRoot, name), target);
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
    screenshots.push(name);
  }
  return screenshots;
}

async function run() {
  const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-b10-assessment-lifecycle-'));
  const syntheticRoot = fs.realpathSync(createdRoot);
  if (process.platform !== 'win32') fs.chmodSync(syntheticRoot, 0o700);
  const keepArtifacts = process.env.HRBOSS_KEEP_B10_ARTIFACTS === '1';
  try {
    for (const dir of ['data', 'profile', 'user-data', 'evidence']) {
      fs.mkdirSync(path.join(syntheticRoot, dir), { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') fs.chmodSync(path.join(syntheticRoot, dir), 0o700);
    }

    const electronPath = require('electron');
    const assetEnv = { ...process.env, HRBOSS_B1_SYNTHETIC_ROOT: syntheticRoot };
    delete assetEnv.ELECTRON_RUN_AS_NODE;
    runSyncChecked(electronPath, [
      path.join(ROOT, 'checks/test-native-file-selection/create-synthetic-assets-main.js'),
    ], { env: assetEnv, timeout: 60_000 });

    const electronNodeEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HRBOSS_TEST_RUNTIME: 'electron-node',
    };
    runSyncChecked(electronPath, [
      path.join(ROOT, 'checks/test-assessment-lifecycle-journey/runtime-db.js'),
      syntheticRoot,
      'seed',
    ], { env: electronNodeEnv, timeout: 60_000 });
    runSyncChecked(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', 'frontend', 'run', 'build'], {
      timeout: 120_000,
    });

    const secret = crypto.randomBytes(48).toString('base64url');
    const signedPlan = encodePlan(secret, {
      synthetic_root: syntheticRoot,
      entries: [{
        title: '选择一份或多份 PDF 测评报告',
        properties: ['openFile', 'multiSelections'],
        paths: [path.join(syntheticRoot, 'synthetic-assessment.pdf')],
      }],
    });
    const planPath = path.join(syntheticRoot, 'selection-plan.json');
    writePrivate(planPath, JSON.stringify(signedPlan));

    const baselinePids = new Set(processTable().map((row) => row.pid));
    const runtimeEnv = {
      ...process.env,
      [ENV_KEYS.marker]: PLAN_MARKER,
      [ENV_KEYS.plan]: planPath,
      [ENV_KEYS.secret]: secret,
      HRBOSS_B10_SYNTHETIC_ROOT: syntheticRoot,
      HRBOSS_DATA_DIR: path.join(syntheticRoot, 'data'),
      BOSS_DB_PATH: path.join(syntheticRoot, 'data', 'recruiting.db'),
      BOSS_PROFILE_DATA_DIR: path.join(syntheticRoot, 'profile'),
      HRBOSS_ASSESSMENT_PHASE_A_ENABLED: '1',
      HRBOSS_ASSESSMENT_RETENTION_POLICY_VERSION: 'synthetic-b10-retention-v1',
      HRBOSS_ASSESSMENT_RETENTION_DAYS: '30',
      HRBOSS_F018_ENABLED: '1',
      HRBOSS_EXTERNAL_AI_ENABLED: '0',
      BOSS_ACTION_AUTOMATION_ENABLED: '0',
    };
    delete runtimeEnv.ELECTRON_RUN_AS_NODE;
    const runtime = await runElectron(
      electronPath,
      [path.join(ROOT, 'checks/test-assessment-lifecycle-journey/bootstrap.js')],
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
      path.join(ROOT, 'checks/test-assessment-lifecycle-journey/runtime-db.js'),
      syntheticRoot,
      'verify',
    ], { env: electronNodeEnv, timeout: 60_000 });
    const database = JSON.parse(verification.stdout.trim().split('\n').pop());
    assert.equal(database.ok, true);

    const evidenceRoot = process.env.HRBOSS_B10_EVIDENCE_DIR
      ? path.resolve(process.env.HRBOSS_B10_EVIDENCE_DIR)
      : null;
    const screenshots = evidenceRoot
      ? copyEvidence(path.join(syntheticRoot, 'evidence'), evidenceRoot)
      : fs.readdirSync(path.join(syntheticRoot, 'evidence')).filter((name) => name.endsWith('.png')).sort();
    const manifest = {
      evidence_level: 'E4',
      synthetic_data_only: true,
      external_services_accessed: false,
      viewport: '1280x800',
      ...result,
      database,
      screenshots,
      spawned_pid_survivors: runtime.survivors,
    };
    if (evidenceRoot) {
      const manifestPath = path.join(evidenceRoot, 'B-10-runtime-evidence.json');
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(manifestPath, 0o600);
    }
    console.log(JSON.stringify({
      ok: true,
      evidence_level: 'E4',
      automatic_parse: database.archive.analysis,
      binding_transition: database.archive.binding,
      controlled_pdf_preserved: database.archive.controlled_pdf.exists,
      controlled_png_preserved: database.archive.controlled_png.exists,
      assessment_questions_before_revoke: result.cross_validation.before_revoke.questions,
      assessment_evidence_after_revoke: result.cross_validation.after_revoke.visible,
      stale_preview_status_after_revoke: result.preview.after_revoke_status,
      candidate_projection_unchanged: database.candidate_projection_unchanged,
      default_order_unchanged: database.default_order_unchanged,
      screenshots,
      spawned_pid_survivors: runtime.survivors,
    }, null, 2));
  } finally {
    if (keepArtifacts) console.log(`[B-10] synthetic evidence retained at ${syntheticRoot}`);
    else fs.rmSync(syntheticRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
