#!/usr/bin/env node
'use strict';
const { PROJECT_ROOT } = require("../src/paths");


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
} = require("./support/test-native-file-selection/signed-plan");

const ROOT = PROJECT_ROOT;

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
  const targets = [...pids].filter((pid) => Number.isInteger(pid) && pid > 1 && isAlive(pid)).sort((a, b) => b - a);
  for (const pid of targets) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  const deadline = Date.now() + 3000;
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
      reject(new Error(`real Electron native-selection journey timed out\n${stdout}\n${stderr}`));
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
      resolve({ code, signal, stdout, stderr, ownedPids: [...ownedPids], survivors });
    });
  });
}

function copyEvidence(sourceRoot, targetRoot, result, persistence) {
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o700 });
  for (const name of result.evidence) {
    fs.copyFileSync(path.join(sourceRoot, 'evidence', name), path.join(targetRoot, name));
  }
  const manifest = {
    evidence_level: 'E4',
    synthetic_data_only: true,
    external_services_accessed: false,
    viewport: '1280x800',
    journey: result,
    persistence,
  };
  fs.writeFileSync(path.join(targetRoot, 'B-1-runtime-evidence.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function run() {
  const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-b1-native-selection-'));
  const syntheticRoot = fs.realpathSync(createdRoot);
  if (process.platform !== 'win32') fs.chmodSync(syntheticRoot, 0o700);
  const keepArtifacts = process.env.HRBOSS_KEEP_B1_ARTIFACTS === '1';
  try {
    for (const dir of ['data', 'profile', 'user-data']) {
      fs.mkdirSync(path.join(syntheticRoot, dir), { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') fs.chmodSync(path.join(syntheticRoot, dir), 0o700);
    }
    const resumePath = path.join(syntheticRoot, 'synthetic-resume.txt');
    writePrivate(resumePath, [
      '姓名：合成简历候选人',
      '学历：本科',
      '毕业院校：合成测试大学',
      '5年工作经验',
      '期望薪资：20-25K',
      '工作经历：只用于 HRBOSS 本地端到端测试的合成材料。',
    ].join('\n'));

    const electronPath = require('electron');
    const assetEnv = { ...process.env, HRBOSS_B1_SYNTHETIC_ROOT: syntheticRoot };
    delete assetEnv.ELECTRON_RUN_AS_NODE;
    runSyncChecked(electronPath, [
      path.join(ROOT, "tests/support/test-native-file-selection/create-synthetic-assets-main.js"),
    ], { env: assetEnv, timeout: 60_000 });

    const nodeElectronEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HRBOSS_TEST_RUNTIME: 'electron-node',
    };
    runSyncChecked(electronPath, [
      path.join(ROOT, "tests/support/test-native-file-selection/runtime-db.js"),
      'seed',
      syntheticRoot,
    ], { env: nodeElectronEnv, timeout: 60_000 });

    runSyncChecked(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', 'frontend', 'run', 'build'], {
      timeout: 120_000,
    });

    const secret = crypto.randomBytes(48).toString('base64url');
    const signedPlan = encodePlan(secret, {
      synthetic_root: syntheticRoot,
      entries: [
        {
          title: '上传简历并创建候选人',
          properties: ['openFile'],
          paths: [resumePath],
        },
        {
          title: '选择 Boss App 截图文件夹',
          properties: ['openDirectory'],
          paths: [path.join(syntheticRoot, 'screenshots')],
        },
        {
          title: '选择一份或多份 PDF 测评报告',
          properties: ['openFile', 'multiSelections'],
          paths: [path.join(syntheticRoot, 'synthetic-assessment.pdf')],
        },
      ],
    });
    const planPath = path.join(syntheticRoot, 'selection-plan.json');
    writePrivate(planPath, JSON.stringify(signedPlan));
    const baselinePids = new Set(processTable().map((row) => row.pid));
    const runtimeEnv = {
      ...process.env,
      [ENV_KEYS.marker]: PLAN_MARKER,
      [ENV_KEYS.plan]: planPath,
      [ENV_KEYS.secret]: secret,
      HRBOSS_DATA_DIR: path.join(syntheticRoot, 'data'),
      BOSS_DB_PATH: path.join(syntheticRoot, 'data', 'recruiting.db'),
      BOSS_PROFILE_DATA_DIR: path.join(syntheticRoot, 'profile'),
      HRBOSS_ASSESSMENT_PHASE_A_ENABLED: '1',
      HRBOSS_ASSESSMENT_RETENTION_POLICY_VERSION: 'synthetic-b1-retention-v1',
      HRBOSS_ASSESSMENT_RETENTION_DAYS: '30',
      HRBOSS_F018_ENABLED: '1',
      HRBOSS_EXTERNAL_AI_ENABLED: '0',
      BOSS_ACTION_AUTOMATION_ENABLED: '0',
    };
    delete runtimeEnv.ELECTRON_RUN_AS_NODE;
    const runtime = await runElectron(
      electronPath,
      [path.join(ROOT, "tests/support/test-native-file-selection/bootstrap.js")],
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

    const verified = runSyncChecked(electronPath, [
      path.join(ROOT, "tests/support/test-native-file-selection/runtime-db.js"),
      'verify',
      syntheticRoot,
    ], { env: nodeElectronEnv, timeout: 60_000 });
    const persistence = JSON.parse(verified.stdout.trim().split('\n').pop());
    assert.equal(persistence.ok, true);
    if (process.env.HRBOSS_B1_EVIDENCE_DIR) {
      copyEvidence(syntheticRoot, path.resolve(process.env.HRBOSS_B1_EVIDENCE_DIR), result, persistence);
    }
    console.log(JSON.stringify({
      ok: true,
      evidence_level: 'E4',
      signed_dialog_entries_remaining: result.signed_dialog_entries_remaining,
      candidates: persistence.candidates,
      assessment_state: persistence.assessment.state,
      spawned_pid_survivors: runtime.survivors,
    }, null, 2));
  } finally {
    if (keepArtifacts) console.log(`[B-1] synthetic evidence retained at ${syntheticRoot}`);
    else fs.rmSync(syntheticRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
