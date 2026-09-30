'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const ELECTRON = require('electron');
const TOKEN = 'synthetic-local-api-token-000000000001';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === 'EPERM');
  }
}

function processTable() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `ps failed: ${result.stderr}`);
  return result.stdout
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map((match) => ({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      command: match[3],
    }));
}

function servicePids(parentPid) {
  const children = processTable().filter((entry) => entry.ppid === parentPid);
  const byScript = {};
  for (const script of ['db-server.js', 'action-server.js']) {
    const child = children.find((entry) => entry.command.includes(path.join(ROOT, script)));
    if (child) byScript[script] = child.pid;
  }
  return byScript;
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

function createRendererServer() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><main>synthetic HRBOSS lifecycle check</main></body></html>');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function launchDesktop(label, rendererUrl) {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), `hrboss-orphan-${label}-`));
  fs.chmodSync(runRoot, 0o700);
  const dataDir = path.join(runRoot, 'data');
  const userDataDir = path.join(runRoot, 'userdata');
  const homeDir = path.join(runRoot, 'home');
  const tempDir = path.join(runRoot, 'tmp');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(homeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    HOME: homeDir,
    TMPDIR: tempDir,
    HRBOSS_DATA_DIR: dataDir,
    BOSS_DB_PATH: path.join(dataDir, 'recruiting.db'),
    HRBOSS_INTERVIEW_OUTPUT_DIR: path.join(dataDir, 'interviews'),
    HRBOSS_RENDERER_URL: rendererUrl,
    HRBOSS_EXTERNAL_AI_ENABLED: '0',
    BOSS_ACTION_AUTOMATION_ENABLED: '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(ELECTRON, [
    ROOT,
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
  ], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let spawnError = null;
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  child.once('error', (error) => { spawnError = error; });
  const closed = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  let ownedServices = {};
  try {
    ownedServices = await waitFor(() => {
      if (spawnError) throw spawnError;
      if (child.exitCode != null) {
        throw new Error(`${label} desktop exited before service readiness (exit ${child.exitCode})\n${output}`);
      }
      const pids = servicePids(child.pid);
      ownedServices = { ...ownedServices, ...pids };
      return pids['db-server.js'] && pids['action-server.js'] ? pids : null;
    }, 45_000, `${label} child service readiness`);
    return {
      label,
      runRoot,
      child,
      closed,
      output: () => output,
      ownedServices,
    };
  } catch (error) {
    if (processExists(child.pid)) {
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
    }
    for (const pid of Object.values(ownedServices)) {
      if (!processExists(pid)) continue;
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    await sleep(250);
    fs.rmSync(runRoot, { recursive: true, force: true });
    throw error;
  }
}

async function stopExactProcesses(runtime) {
  if (!runtime) return;
  if (processExists(runtime.child.pid)) {
    try { process.kill(runtime.child.pid, 'SIGKILL'); } catch {}
  }
  for (const pid of Object.values(runtime.ownedServices || {})) {
    if (!processExists(pid)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  await sleep(250);
  fs.rmSync(runtime.runRoot, { recursive: true, force: true });
}

async function verifyForcedQuit(rendererUrl) {
  const runtime = await launchDesktop('force', rendererUrl);
  try {
    process.kill(runtime.child.pid, 'SIGKILL');
    const mainExit = await runtime.closed;
    assert.equal(mainExit.signal, 'SIGKILL', `unexpected main exit: ${JSON.stringify(mainExit)}`);
    await waitFor(
      () => Object.values(runtime.ownedServices).every((pid) => !processExists(pid)),
      5000,
      `forced quit service cleanup ${JSON.stringify(runtime.ownedServices)}`,
    );
    return {
      main_pid: runtime.child.pid,
      service_pids: runtime.ownedServices,
      main_exit: mainExit,
    };
  } finally {
    await stopExactProcesses(runtime);
  }
}

async function verifyGracefulQuit(rendererUrl) {
  const runtime = await launchDesktop('graceful', rendererUrl);
  try {
    process.kill(runtime.child.pid, 'SIGTERM');
    const mainExit = await Promise.race([
      runtime.closed,
      sleep(15_000).then(() => { throw new Error(`graceful main exit timed out\n${runtime.output()}`); }),
    ]);
    await waitFor(
      () => Object.values(runtime.ownedServices).every((pid) => !processExists(pid)),
      5000,
      `graceful quit service cleanup ${JSON.stringify(runtime.ownedServices)}`,
    );
    return {
      main_pid: runtime.child.pid,
      service_pids: runtime.ownedServices,
      main_exit: mainExit,
    };
  } finally {
    await stopExactProcesses(runtime);
  }
}

async function verifyStandaloneReadonly() {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-orphan-standalone-'));
  fs.chmodSync(runRoot, 0o700);
  const dataDir = path.join(runRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const databasePath = path.join(dataDir, 'recruiting.db');
  const baseEnv = {
    ...process.env,
    HOME: runRoot,
    TMPDIR: runRoot,
    HRBOSS_DATA_DIR: dataDir,
    BOSS_DB_PATH: databasePath,
    HRBOSS_INTERVIEW_OUTPUT_DIR: path.join(dataDir, 'interviews'),
    HRBOSS_EXTERNAL_AI_ENABLED: '0',
    BOSS_ACTION_AUTOMATION_ENABLED: '0',
    ELECTRON_RUN_AS_NODE: '1',
  };
  const initialize = spawnSync(ELECTRON, [
    '-e',
    `require(${JSON.stringify(path.join(ROOT, 'db.js'))}).conn().close()`,
  ], {
    cwd: ROOT,
    env: baseEnv,
    encoding: 'utf8',
  });
  assert.equal(
    initialize.status,
    0,
    `standalone readonly fixture initialization failed\n${initialize.stdout}\n${initialize.stderr}`,
  );
  const child = spawn(ELECTRON, [path.join(ROOT, 'db-server.js')], {
    cwd: ROOT,
    env: {
      ...baseEnv,
      BOSS_READONLY_PORT: '0',
      HRBOSS_LOCAL_API_TOKEN: TOKEN,
      HRBOSS_LOCAL_API_INSTANCE_ID: 'synthetic-standalone-readonly',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const closed = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  try {
    await waitFor(
      () => {
        if (child.exitCode != null) {
          throw new Error(`standalone readonly exited before readiness (exit ${child.exitCode})\n${output}`);
        }
        return output.includes('readonly db server');
      },
      10_000,
      'standalone readonly readiness',
    );
    await sleep(500);
    assert.equal(processExists(child.pid), true,
      'disconnect listener must not exit db-server when no IPC channel exists');
    process.kill(child.pid, 'SIGTERM');
    const exit = await Promise.race([
      closed,
      sleep(5000).then(() => { throw new Error(`standalone readonly SIGTERM timed out\n${output}`); }),
    ]);
    assert.equal(processExists(child.pid), false);
    return { pid: child.pid, exit };
  } finally {
    if (processExists(child.pid)) {
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
    }
    await sleep(100);
    fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform === 'win32') {
    console.log(JSON.stringify({
      ok: true,
      contract: 'ORPHAN-SERVICE-ON-FORCE-QUIT-001',
      skipped: true,
      reason: 'POSIX SIGKILL lifecycle check',
    }));
    return;
  }
  const rendererServer = await createRendererServer();
  const address = rendererServer.address();
  const rendererUrl = `http://127.0.0.1:${address.port}/index.html`;
  try {
    const forced = await verifyForcedQuit(rendererUrl);
    const graceful = await verifyGracefulQuit(rendererUrl);
    const standalone = await verifyStandaloneReadonly();
    console.log(JSON.stringify({
      ok: true,
      contract: 'ORPHAN-SERVICE-ON-FORCE-QUIT-001',
      forced,
      graceful,
      standalone,
      cleanup_scope: 'exact recorded PID set',
    }));
  } finally {
    await new Promise((resolve) => rendererServer.close(resolve));
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
