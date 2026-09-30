'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const db = require("../src/db");
const { createHrManualDispositionService } = require("../src/hr-manual-disposition-service");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-readonly-f018-projection-'));
process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
const children = new Set();
process.on('exit', () => {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch {}
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

function getJson(port, token, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: pathname,
      headers: { 'x-hrboss-token': token },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    request.once('error', reject);
  });
}

async function startReadonlyServer({ databasePath, f018Enabled, label }) {
  const port = await freePort();
  const token = `synthetic-readonly-${label}-token-0001`;
  const auditFile = path.join(ROOT, label, 'sensitive-read-audit.jsonl');
  fs.mkdirSync(path.dirname(auditFile), { recursive: true });
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, "src/db-server.js")], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '1',
      BOSS_DB_PATH: databasePath,
      BOSS_READONLY_PORT: String(port),
      HRBOSS_F018_ENABLED: f018Enabled ? '1' : '0',
      HRBOSS_LOCAL_API_TOKEN: token,
      HRBOSS_LOCAL_API_INSTANCE_ID: `synthetic-readonly-${label}`,
      HRBOSS_SENSITIVE_READ_AUDIT_FILE: auditFile,
    },
  });
  children.add(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`readonly server ${label} exited early: ${stderr}`);
    try {
      const health = await getJson(port, token, '/api/health');
      if (health.status === 200) return { child, port, token, stderr: () => stderr };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`readonly server ${label} did not become healthy: ${stderr}`);
}

async function stopReadonlyServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const exited = new Promise((resolve) => server.child.once('exit', resolve));
  server.child.kill('SIGTERM');
  await exited;
  children.delete(server.child);
}

function seedCandidate(databasePath, { f018Enabled, suffix }) {
  const database = db.openDb(databasePath, { f018Enabled, assessmentEnabled: false });
  const job = db.upsertJob({
    encrypt_job_id: `readonly-f018-job-${suffix}`,
    name: `只读投影合成岗位 ${suffix}`,
  });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: `readonly-f018-candidate-${suffix}`,
    source: 'synthetic_readonly_projection',
    name: `只读投影合成候选人 ${suffix}`,
  });
  database.prepare(`
    UPDATE candidate
    SET sabc = 'A', communication_code = 'not_contacted', comm_status = '未打招呼',
        disposition_code = 'under_review', disposition_status = '待处理'
    WHERE internal_id = ?
  `).run(candidate.internal_id);
  if (f018Enabled) {
    createHrManualDispositionService({
      database,
      actorContext: { actor_id: 'synthetic-readonly-hr' },
      now: () => '2026-07-14T12:00:00.000Z',
    }).apply({
      candidate_id: candidate.internal_id,
      job_id: job.id,
      action: 'hold',
      reason: 'synthetic_readonly_hold',
      request_id: `REQ-READONLY-F018-HOLD-${suffix}`,
    });
  }
  database.close();
  return { jobId: job.id, candidateId: candidate.internal_id };
}

function candidateFrom(response, candidateId) {
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.candidates.find((row) => row.internal_id === candidateId);
}

async function run() {
  const enabledPath = path.join(ROOT, 'enabled.db');
  const enabled = seedCandidate(enabledPath, { f018Enabled: true, suffix: 'ENABLED' });
  const enabledStatBefore = fs.statSync(enabledPath);
  let server = await startReadonlyServer({ databasePath: enabledPath, f018Enabled: true, label: 'enabled' });
  try {
    const row = candidateFrom(
      await getJson(server.port, server.token, `/api/candidates?jobId=${enabled.jobId}`),
      enabled.candidateId,
    );
    assert.ok(row, 'enabled readonly projection must return the synthetic candidate');
    assert.equal(row.application_status, 'active');
    assert.equal(row.application_disposition_action, 'hold');
    assert.equal(row.application_episode_no, 1);

    const workbenchResponse = await getJson(server.port, server.token, `/api/workbench?jobId=${enabled.jobId}`);
    assert.equal(workbenchResponse.status, 200, JSON.stringify(workbenchResponse.body));
    assert.equal(
      workbenchResponse.body.workbench.todos.some(
        (todo) => todo.candidate_id === enabled.candidateId && todo.code === 'contact_required',
      ),
      false,
      'held candidate must be excluded from the readonly default progression queue',
    );
  } finally {
    await stopReadonlyServer(server);
  }
  const enabledStatAfter = fs.statSync(enabledPath);
  assert.equal(enabledStatAfter.size, enabledStatBefore.size, 'readonly projection must not change database size');
  assert.equal(enabledStatAfter.mtimeMs, enabledStatBefore.mtimeMs, 'readonly projection must not write the database');

  server = await startReadonlyServer({ databasePath: enabledPath, f018Enabled: false, label: 'disabled' });
  try {
    const row = candidateFrom(
      await getJson(server.port, server.token, `/api/candidates?jobId=${enabled.jobId}`),
      enabled.candidateId,
    );
    assert.ok(row, 'disabled readonly projection must still return the candidate');
    assert.equal(row.application_status, 'active');
    assert.equal(row.application_disposition_action, 'hold');
    assert.equal(row.application_episode_no, 1);
    const workbench = await getJson(server.port, server.token, `/api/workbench?jobId=${enabled.jobId}`);
    assert.equal(workbench.status, 200, JSON.stringify(workbench.body));
    assert.equal(
      workbench.body.workbench.todos.some(
        (todo) => todo.candidate_id === enabled.candidateId && todo.code === 'contact_required',
      ),
      false,
      'optional final-review flag must not put a held candidate back into the progression queue',
    );
  } finally {
    await stopReadonlyServer(server);
  }

  const missingPath = path.join(ROOT, 'missing-f018.db');
  const missing = seedCandidate(missingPath, { f018Enabled: false, suffix: 'MISSING' });
  server = await startReadonlyServer({ databasePath: missingPath, f018Enabled: true, label: 'missing' });
  try {
    const row = candidateFrom(
      await getJson(server.port, server.token, `/api/candidates?jobId=${missing.jobId}`),
      missing.candidateId,
    );
    assert.ok(row, 'missing-schema readonly projection must still return the candidate');
    assert.equal(row.application_status, null);
    assert.equal(row.application_disposition_action, null);
    const workbench = await getJson(server.port, server.token, `/api/workbench?jobId=${missing.jobId}`);
    assert.equal(workbench.status, 200, JSON.stringify(workbench.body));
  } finally {
    await stopReadonlyServer(server);
  }
  const missingDatabase = new Database(missingPath, { readonly: true, fileMustExist: true });
  try {
    assert.equal(missingDatabase.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN ('application_episode', 'application_event', 'final_review', 'final_disposition')
    `).get().count, 0, 'readonly projection must not migrate a database with missing F018 tables');
  } finally {
    missingDatabase.close();
  }

  const candidateListSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'frontend/src/components/CandidateList.jsx'),
    'utf8',
  );
  assert.match(candidateListSource, /if \(isHoldCandidate\(c\)\) return 'hold'/);
  assert.match(candidateListSource, /if \(queue === DEFAULT_QUEUE\) return !\['archived', 'hold'\]\.includes\(workQueueKey\(c\)\)/);

  console.log(JSON.stringify({
    ok: true,
    contract: 'readonly-f018-projection-v1',
    enabled_hold_projected: true,
    held_candidate_excluded_from_progression: true,
    final_review_disabled_application_projection_safe: true,
    missing_schema_safe_without_migration: true,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
