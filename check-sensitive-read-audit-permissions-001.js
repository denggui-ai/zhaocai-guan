'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-sensitive-audit-permissions-'));
fs.chmodSync(ROOT, 0o700);
const dataDir = path.join(ROOT, 'data');
const auditDir = path.join(ROOT, 'audit');
const databasePath = path.join(dataDir, 'recruiting.db');
const auditFile = path.join(auditDir, 'sensitive-read-audit.jsonl');
const token = 'synthetic-sensitive-audit-token-00000001';
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
process.env.BOSS_DB_PATH = databasePath;
process.env.HRBOSS_DATA_DIR = dataDir;

let readonlyChild = null;
process.on('exit', () => {
  if (readonlyChild && readonlyChild.exitCode === null) {
    try { readonlyChild.kill('SIGKILL'); } catch {}
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function getJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: requestPath,
      headers: { 'x-hrboss-token': token },
      timeout: 3000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: response.statusCode,
          body: text ? JSON.parse(text) : null,
        });
      });
    });
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('request timeout')));
  });
}

async function waitForHealth(port, stderr) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (readonlyChild.exitCode !== null) {
      throw new Error(`readonly server exited before health: ${stderr()}`);
    }
    try {
      const health = await getJson(port, '/api/health');
      if (health.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`readonly server health timed out: ${stderr()}`);
}

async function stopReadonlyServer() {
  if (!readonlyChild || readonlyChild.exitCode !== null) return;
  const exited = new Promise((resolve) => readonlyChild.once('exit', resolve));
  readonlyChild.kill('SIGTERM');
  await exited;
}

async function main() {
  const db = require('./db');
  const database = db.openDb(databasePath);
  const job = db.upsertJob({
    encrypt_job_id: 'synthetic-sensitive-audit-job',
    name: '敏感审计权限合成岗位',
  });
  db.upsertCandidate({
    job_id: job.id,
    geek_id: 'synthetic-sensitive-audit-candidate',
    source: 'synthetic_sensitive_audit_permissions',
    name: '敏感审计权限合成候选人',
  });
  database.close();

  const port = await freePort();
  let stderr = '';
  readonlyChild = spawn(process.execPath, [path.join(__dirname, 'db-server.js')], {
    cwd: __dirname,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '1',
      BOSS_DB_PATH: databasePath,
      BOSS_READONLY_PORT: String(port),
      HRBOSS_LOCAL_API_TOKEN: token,
      HRBOSS_LOCAL_API_INSTANCE_ID: 'synthetic-sensitive-audit-permissions',
      HRBOSS_SENSITIVE_READ_AUDIT_FILE: auditFile,
      HRBOSS_EXTERNAL_AI_ENABLED: '0',
      HRBOSS_EXTERNAL_AI_API_KEY: '',
    },
  });
  readonlyChild.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  await waitForHealth(port, () => stderr);

  const requestPath = `/api/candidates?jobId=${job.id}`;
  const initial = await getJson(port, requestPath);
  assert.equal(initial.status, 200, JSON.stringify(initial.body));
  assert.equal(initial.body.ok, true);
  if (process.platform === 'win32') {
    console.log('SKIP POSIX audit mode-bit assertion on Windows (private ACLs are validated separately)');
  } else {
    assert.equal(fs.statSync(auditFile).mode & 0o777, 0o600);
  }

  let downgradedStatus = 'not_applicable';
  let recoveryStatus = 'not_applicable';
  if (process.platform !== 'win32') {
    fs.chmodSync(auditFile, 0o666);
    const rejected = await getJson(port, requestPath);
    downgradedStatus = rejected.status;
    assert.equal(rejected.status, 500,
      `runtime audit permission downgrade must fail closed: ${JSON.stringify(rejected.body)}`);
    assert.equal(rejected.body.ok, false);
    assert.equal(rejected.body.code, 'READONLY_PROJECTION_ERROR');
    assert.match(rejected.body.error, /已拒绝返回数据/);
    assert.match(rejected.body.error, /仅当前用户可读写/);
    assert.equal(fs.statSync(auditFile).mode & 0o777, 0o666,
      'readonly service must not silently repair unsafe audit permissions');

    fs.chmodSync(auditFile, 0o600);
    const recovered = await getJson(port, requestPath);
    recoveryStatus = recovered.status;
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.ok, true);
  }

  await stopReadonlyServer();
  console.log(JSON.stringify({
    ok: true,
    contract: 'SENSITIVE-READ-AUDIT-PERMISSIONS-001',
    initial_status: initial.status,
    downgraded_status: downgradedStatus,
    recovery_status: recoveryStatus,
  }));
}

main().catch(async (error) => {
  try { await stopReadonlyServer(); } catch {}
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
