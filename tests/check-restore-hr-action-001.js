'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const db = require("../src/db");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-restore-hr-action-001-'));
const DB_PATH = path.join(ROOT, 'synthetic.db');
const DATA_ROOT = path.join(ROOT, 'data');
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

function requestJson(port, token, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        'x-hrboss-token': token,
        ...(bytes ? { 'content-type': 'application/json', 'content-length': bytes.length } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    request.once('error', reject);
    if (bytes) request.write(bytes);
    request.end();
  });
}

async function startActionServer() {
  const port = await freePort();
  const token = 'synthetic-restore-hr-action-token-0001';
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, "src/action-server.js")], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '1',
      BOSS_DB_PATH: DB_PATH,
      BOSS_ACTION_PORT: String(port),
      HRBOSS_DATA_DIR: DATA_ROOT,
      HRBOSS_RECOVERY_ROOT: path.join(ROOT, 'recovery'),
      HRBOSS_F018_ENABLED: '0',
      HRBOSS_ASSESSMENT_PHASE_A_ENABLED: '0',
      HRBOSS_LOCAL_API_TOKEN: token,
      HRBOSS_LOCAL_API_INSTANCE_ID: 'synthetic-restore-hr-action',
      HRBOSS_SENSITIVE_READ_AUDIT_FILE: path.join(ROOT, 'sensitive-read-audit.jsonl'),
    },
  });
  children.add(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`action server exited early: ${stderr}`);
    try {
      const health = await requestJson(port, token, 'GET', '/api/health');
      if (health.status === 200) return { child, port, token, stderr: () => stderr };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`action server did not become healthy: ${stderr}`);
}

async function stopActionServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const exited = new Promise((resolve) => server.child.once('exit', resolve));
  server.child.kill('SIGTERM');
  await exited;
  children.delete(server.child);
}

function seed() {
  const database = db.openDb(DB_PATH, { f018Enabled: false, assessmentEnabled: false });
  const job = db.upsertJob({
    encrypt_job_id: 'restore-hr-action-job',
    name: 'RESTORE-HR-ACTION 纯合成岗位',
  });
  const hold = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'restore-hr-action-hold',
    source: 'synthetic_restore_hr_action',
    name: '暂缓合成候选人',
  });
  const journey = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'restore-hr-action-journey',
    source: 'synthetic_restore_hr_action',
    name: '全动作合成候选人',
  });
  database.prepare(`
    UPDATE candidate
    SET sabc = 'A', disposition_status = '待处理', disposition_code = 'under_review'
    WHERE internal_id IN (?, ?)
  `).run(hold.internal_id, journey.internal_id);
  database.close();
  return { jobId: job.id, holdId: hold.internal_id, journeyId: journey.internal_id };
}

async function fallbackActionResult(server, candidateId, jobId, action, code) {
  const primary = await requestJson(server.port, server.token, 'POST', '/api/candidate-status', {
    candidateId,
    jobId,
    layer: 'disposition',
    action,
    requestId: `REQ-RESTORE-${candidateId}-${action}`,
    reason: `synthetic_${action}`,
    source: 'manual_hr_action',
  });
  assert.equal(primary.status, 409, JSON.stringify(primary.body));
  assert.equal(primary.body.code, 'APPLICATION_EPISODE_UNAVAILABLE');

  const fallback = await requestJson(server.port, server.token, 'POST', '/api/candidate-status', {
    candidateId,
    layer: 'disposition',
    code,
    reason: `synthetic_${action}_fallback`,
    source: 'manual_hr_action',
  });
  assert.equal(fallback.status, 200, JSON.stringify(fallback.body));
  return fallback.body;
}

async function fallbackAction(server, candidateId, jobId, action, code) {
  return (await fallbackActionResult(server, candidateId, jobId, action, code)).candidate;
}

async function run() {
  const seeded = seed();
  const server = await startActionServer();
  try {
    let result = await fallbackActionResult(server, seeded.holdId, seeded.jobId, 'hold', 'hold');
    let candidate = result.candidate;
    assert.equal(result.status_change.changed, true);
    assert.equal(result.status_change.idempotent_replay, false);
    assert.equal(candidate.disposition_code, 'under_review');
    assert.equal(candidate.disposition_status, '暂缓');
    const holdVersion = candidate.workflow_version;

    result = await fallbackActionResult(server, seeded.holdId, seeded.jobId, 'hold', 'hold');
    candidate = result.candidate;
    assert.equal(result.status_change.changed, false);
    assert.equal(result.status_change.idempotent_replay, true);
    assert.equal(candidate.workflow_version, holdVersion, 'identical fallback hold must not increment the workflow version');

    result = await fallbackActionResult(server, seeded.holdId, seeded.jobId, 'continue_process', 'under_review');
    candidate = result.candidate;
    assert.equal(result.status_change.changed, true);
    assert.equal(candidate.disposition_status, '待处理');

    result = await fallbackActionResult(server, seeded.holdId, seeded.jobId, 'hold', 'hold');
    candidate = result.candidate;
    assert.equal(result.status_change.changed, true);
    assert.equal(candidate.disposition_status, '暂缓');

    candidate = await fallbackAction(server, seeded.journeyId, seeded.jobId, 'continue_process', 'under_review');
    assert.equal(candidate.disposition_status, '待处理');
    candidate = await fallbackAction(server, seeded.journeyId, seeded.jobId, 'reject', 'rejected');
    assert.equal(candidate.disposition_code, 'rejected');
    candidate = await fallbackAction(server, seeded.journeyId, seeded.jobId, 'reenter', 'under_review');
    assert.equal(candidate.disposition_code, 'under_review');
    candidate = await fallbackAction(server, seeded.journeyId, seeded.jobId, 'talent_pool', 'talent_pool');
    assert.equal(candidate.disposition_code, 'talent_pool');
    candidate = await fallbackAction(server, seeded.journeyId, seeded.jobId, 'reenter', 'under_review');
    assert.equal(candidate.disposition_code, 'under_review');
    candidate = await fallbackAction(server, seeded.journeyId, seeded.jobId, 'withdraw', 'candidate_withdrew');
    assert.equal(candidate.disposition_code, 'candidate_withdrew');
    assert.equal(candidate.disposition_status, '主动放弃');
    candidate = await fallbackAction(server, seeded.journeyId, seeded.jobId, 'reenter', 'under_review');
    assert.equal(candidate.disposition_code, 'under_review');
    candidate = await fallbackAction(server, seeded.journeyId, seeded.jobId, 'hired', 'hired');
    assert.equal(candidate.disposition_code, 'hired');
    assert.equal(candidate.disposition_status, '录用');
    candidate = await fallbackAction(server, seeded.journeyId, seeded.jobId, 'reenter', 'under_review');
    assert.equal(candidate.disposition_code, 'under_review');
  } finally {
    await stopActionServer(server);
  }

  const database = db.openDb(DB_PATH, { f018Enabled: false, assessmentEnabled: false });
  try {
    assert.equal(database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN ('application_episode', 'application_event', 'final_review', 'final_disposition')
    `).get().count, 0, 'compatibility path must not enable or migrate optional F018 tables');
    const holdRow = db.listCandidates(seeded.jobId).find((row) => row.internal_id === seeded.holdId);
    assert.equal(holdRow.application_status, 'active');
    assert.equal(holdRow.application_disposition_action, 'hold');
    const workbench = db.getJobWorkbench(seeded.jobId);
    assert.equal(
      workbench.todos.some((todo) => todo.candidate_id === seeded.holdId && todo.code === 'contact_required'),
      false,
      'fallback hold must remain outside the default progression queue',
    );
    assert.equal(
      workbench.todos.some((todo) => todo.candidate_id === seeded.journeyId && todo.code === 'contact_required'),
      true,
      'fallback continue_process must restore the deterministic progression queue',
    );
    assert.deepEqual(
      database.prepare(`
        SELECT from_status, to_status, from_code, to_code
        FROM status_history
        WHERE candidate_id = ? AND source = 'manual_hr_action'
        ORDER BY id
      `).all(seeded.holdId),
      [
        { from_status: '待处理', to_status: '暂缓', from_code: 'under_review', to_code: 'under_review' },
        { from_status: '暂缓', to_status: '待处理', from_code: 'under_review', to_code: 'under_review' },
        { from_status: '待处理', to_status: '暂缓', from_code: 'under_review', to_code: 'under_review' },
      ],
      'same-code manual projection changes must be audited while exact repeats remain idempotent',
    );
    const journey = database.prepare(`
      SELECT disposition_code, disposition_status FROM candidate WHERE internal_id = ?
    `).get(seeded.journeyId);
    assert.deepEqual(journey, { disposition_code: 'under_review', disposition_status: '待处理' });
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM status_history WHERE candidate_id = ? AND source = 'manual_hr_action'").get(seeded.journeyId).count,
      8,
      'every changed fallback action and recovery must leave an explicit history row; exact repeats remain idempotent',
    );
  } finally {
    database.close();
  }

  const detailSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/CandidateDetail.jsx'), 'utf8');
  const apiSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/api.js'), 'utf8');
  const actionSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/action-server.js"), 'utf8');
  for (const mapping of [
    "continue_process: 'under_review'",
    "hold: 'hold'",
    "reject: 'rejected'",
    "talent_pool: 'talent_pool'",
    "withdraw: 'candidate_withdrew'",
    "hired: 'hired'",
    "reenter: 'under_review'",
  ]) assert.ok(detailSource.includes(mapping), `missing fallback mapping: ${mapping}`);
  assert.ok(detailSource.includes("'manual_hr_action'"));
  assert.doesNotMatch(detailSource, /const blocked = readOnly \|\| loading \|\| busy \|\| !!readError \|\| !state/);
  assert.ok(apiSource.includes('error.code = data && data.code ? data.code'));
  assert.ok(actionSource.includes("body.layer === 'disposition' && body.action"));

  console.log(JSON.stringify({
    ok: true,
    contract: 'restore-hr-action-001',
    actions_verified: ['continue_process', 'hold', 'reject', 'talent_pool', 'withdraw', 'hired', 'reenter'],
    f018_optional: true,
    hold_queue_preserved: true,
    terminal_recovery_verified: true,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
