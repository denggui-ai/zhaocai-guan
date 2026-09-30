#!/usr/bin/env node
'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = PROJECT_ROOT;
const COUNTS = Object.freeze([100, 500, 1000]);
const BUDGETS_MS = Object.freeze({
  database_list_candidates: 5_000,
  database_workbench: 10_000,
  renderer_initial_interactive: 20_000,
  renderer_search_filter: 2_000,
  renderer_pagination: 2_000,
});

function privateDirectory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o700);
  return target;
}

function runSyncChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
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
      reject(new Error(`B-14 Electron journey timed out\n${stdout}\n${stderr}`));
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
      await new Promise((done) => setTimeout(done, 800));
      const survivors = [...ownedPids].filter((pid) => !baselinePids.has(pid) && isAlive(pid));
      await stopExactPids(survivors);
      resolve({ code, signal, stdout, stderr, survivors });
    });
  });
}

function assertWithin(actual, budget, label) {
  assert.ok(actual <= budget, `${label}: ${actual}ms exceeds ${budget}ms`);
}

async function run() {
  const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-b14-scale-race-'));
  const syntheticRoot = fs.realpathSync(createdRoot);
  if (process.platform !== 'win32') fs.chmodSync(syntheticRoot, 0o700);
  const keepArtifacts = process.env.HRBOSS_KEEP_B14_ARTIFACTS === '1';
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    runSyncChecked(npm, ['--prefix', 'frontend', 'run', 'build'], {
      env: {
        ...process.env,
        VITE_READONLY_UI: '0',
        HRBOSS_EXTERNAL_AI_ENABLED: '0',
        BOSS_ACTION_AUTOMATION_ENABLED: '0',
      },
      timeout: 120_000,
    });
    const electronPath = require('electron');
    assert.equal(typeof electronPath, 'string');
    const baselinePids = new Set(processTable().map((row) => row.pid));
    const database = [];
    const renderer = [];

    for (const candidateCount of COUNTS) {
      const scaleRoot = privateDirectory(path.join(syntheticRoot, `scale-${candidateCount}`));
      for (const name of ['data', 'profile', 'user-data', 'evidence']) {
        privateDirectory(path.join(scaleRoot, name));
      }
      const nodeEnv = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        HRBOSS_EXTERNAL_AI_ENABLED: '0',
        BOSS_ACTION_AUTOMATION_ENABLED: '0',
      };
      runSyncChecked(electronPath, [
        path.join(ROOT, "tests/support/test-candidate-scale/runtime-db.js"),
        scaleRoot,
        String(candidateCount),
      ], { env: nodeEnv, timeout: 120_000 });
      const databaseResult = JSON.parse(fs.readFileSync(path.join(scaleRoot, 'database-result.json'), 'utf8'));
      assert.equal(databaseResult.ok, true);
      assertWithin(
        Math.max(databaseResult.list_candidates.cold_ms, databaseResult.list_candidates.warm_ms),
        BUDGETS_MS.database_list_candidates,
        `${candidateCount} listCandidates`,
      );
      assertWithin(
        databaseResult.workbench.duration_ms,
        BUDGETS_MS.database_workbench,
        `${candidateCount} getJobWorkbench`,
      );
      database.push(databaseResult);

      const runtimeEnv = {
        ...process.env,
        HRBOSS_B14_SYNTHETIC_ROOT: scaleRoot,
        HRBOSS_B14_CANDIDATE_COUNT: String(candidateCount),
        HRBOSS_DATA_DIR: path.join(scaleRoot, 'data'),
        BOSS_DB_PATH: path.join(scaleRoot, 'data', 'recruiting.db'),
        BOSS_PROFILE_DATA_DIR: path.join(scaleRoot, 'profile'),
        HRBOSS_F018_ENABLED: '1',
        HRBOSS_EXTERNAL_AI_ENABLED: '0',
        BOSS_ACTION_AUTOMATION_ENABLED: '0',
      };
      delete runtimeEnv.ELECTRON_RUN_AS_NODE;
      const runtime = await runElectron(
        electronPath,
        [path.join(ROOT, "tests/support/test-candidate-scale/bootstrap.js")],
        runtimeEnv,
        120_000,
        baselinePids,
      );
      const rendererResultPath = path.join(scaleRoot, 'renderer-result.json');
      assert.equal(fs.existsSync(rendererResultPath), true, `missing ${candidateCount} renderer result\n${runtime.stderr}`);
      const rendererResult = JSON.parse(fs.readFileSync(rendererResultPath, 'utf8'));
      assert.equal(rendererResult.ok, true, rendererResult.error || runtime.stderr);
      assert.equal(runtime.code, 0, `${candidateCount} Electron exited with ${runtime.signal || runtime.code}\n${runtime.stderr}`);
      assert.deepEqual(runtime.survivors, [], `${candidateCount} spawned PID survivors: ${runtime.survivors.join(', ')}`);
      assertWithin(
        rendererResult.initial_interactive_ms,
        BUDGETS_MS.renderer_initial_interactive,
        `${candidateCount} renderer initial interactive`,
      );
      assertWithin(
        rendererResult.search_filter_ms,
        BUDGETS_MS.renderer_search_filter,
        `${candidateCount} renderer search filter`,
      );
      assertWithin(
        rendererResult.pagination_ms,
        BUDGETS_MS.renderer_pagination,
        `${candidateCount} renderer pagination`,
      );
      renderer.push(rendererResult);
    }

    const raceRoot = privateDirectory(path.join(syntheticRoot, 'job-context-race'));
    const raceUserData = privateDirectory(path.join(raceRoot, 'user-data'));
    const raceResultPath = path.join(raceRoot, 'result.json');
    const raceEnv = {
      ...process.env,
      HRBOSS_JOB_CONTEXT_RACE_DIST: path.join(ROOT, 'frontend', 'dist'),
      HRBOSS_JOB_CONTEXT_RACE_USER_DATA: raceUserData,
      HRBOSS_JOB_CONTEXT_RACE_RESULT: raceResultPath,
      HRBOSS_UI_FIXTURE_GATE: '1',
      HRBOSS_UI_FIXTURE_ROOT: raceRoot,
      HRBOSS_UI_FIXTURE_TEMP_PARENT: syntheticRoot,
      HRBOSS_EXTERNAL_AI_ENABLED: '0',
      BOSS_ACTION_AUTOMATION_ENABLED: '0',
    };
    delete raceEnv.ELECTRON_RUN_AS_NODE;
    const raceRuntime = await runElectron(
      electronPath,
      [path.join(ROOT, "tests/check-job-context-race-runtime-main.js")],
      raceEnv,
      60_000,
      baselinePids,
    );
    assert.equal(fs.existsSync(raceResultPath), true, `missing race result\n${raceRuntime.stderr}`);
    const race = JSON.parse(fs.readFileSync(raceResultPath, 'utf8'));
    assert.equal(race.ok, true, race.error || raceRuntime.stderr);
    assert.equal(raceRuntime.code, 0, `race Electron exited with ${raceRuntime.signal || raceRuntime.code}\n${raceRuntime.stderr}`);
    assert.deepEqual(raceRuntime.survivors, [], `race spawned PID survivors: ${raceRuntime.survivors.join(', ')}`);
    assert.deepEqual(race.responseOrder, ['9911', '9912']);
    assert.equal(race.settled.persistedJobId, '9911');

    const evidenceDirectory = privateDirectory(path.resolve(
      process.env.HRBOSS_B14_EVIDENCE_DIR || path.join(ROOT, 'fix-evidence', '20260729', 'B-14'),
    ));
    const screenshotNames = [];
    const screenshotResult = renderer.find((item) => item.candidate_count === 1000);
    if (screenshotResult && screenshotResult.screenshot) {
      const source = path.join(syntheticRoot, 'scale-1000', 'evidence', screenshotResult.screenshot);
      const target = path.join(evidenceDirectory, screenshotResult.screenshot);
      fs.copyFileSync(source, target);
      if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
      screenshotNames.push(screenshotResult.screenshot);
    }
    const evidence = {
      ok: true,
      evidence_level: {
        scale_database: 'E4',
        scale_renderer: 'E4',
        cross_job_race: 'E3',
      },
      synthetic_data_only: true,
      real_candidate_data_read: false,
      external_services_accessed: false,
      security_boundary: {
        scale: 'real HRBOSS Electron + trusted preload + authenticated local API + temporary SQLite/WAL',
        race: 'real Electron/React renderer with isolated in-memory synthetic preload and inverse response order',
      },
      budgets_ms: BUDGETS_MS,
      database,
      renderer,
      cross_job_race: race,
      screenshots: screenshotNames,
      process_cleanup: {
        strategy: 'baseline PID snapshot plus exact descendant PID ownership',
        survivors: [],
      },
    };
    const evidencePath = path.join(evidenceDirectory, 'B-14-scale-race-runtime-evidence.json');
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(evidencePath, 0o600);
    console.log(JSON.stringify({
      ok: true,
      evidence_level: evidence.evidence_level,
      database: database.map((item) => ({
        candidate_count: item.candidate_count,
        list_candidates_ms: item.list_candidates.warm_ms,
        workbench_ms: item.workbench.duration_ms,
      })),
      renderer: renderer.map((item) => ({
        candidate_count: item.candidate_count,
        initial_interactive_ms: item.initial_interactive_ms,
        search_filter_ms: item.search_filter_ms,
        pagination_ms: item.pagination_ms,
      })),
      cross_job_response_order: race.responseOrder,
      evidence_path: evidencePath,
    }, null, 2));
  } finally {
    if (keepArtifacts) {
      console.log(`[B-14] artifacts retained at ${syntheticRoot}`);
    } else {
      fs.rmSync(syntheticRoot, { recursive: true, force: true });
    }
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
