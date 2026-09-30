'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `hrboss-function-close-001-${process.pid}-`));
const DB_PATH = path.join(ROOT, 'function-close-001.db');
const PORT = 20300 + (process.pid % 500);
const TOKEN = 'function-close-001-local-api-token-00000001';
const SCHEDULE_YEAR = new Date().getUTCFullYear() + 1;

process.env.BOSS_DB_PATH = DB_PATH;
process.env.BOSS_ACTION_PORT = String(PORT);
process.env.HRBOSS_LOCAL_API_TOKEN = TOKEN;
process.env.HRBOSS_LOCAL_API_INSTANCE_ID = 'function-close-001-check';
process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
process.env.HRBOSS_RECOVERY_ROOT = path.join(ROOT, 'recovery');
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = path.join(ROOT, 'interviews');

const db = require('./db');
const actionServer = require('./action-server');

process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

function post(pathname, body) {
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: 'POST',
      headers: {
        'x-hrboss-token': TOKEN,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        body: responseBody ? JSON.parse(responseBody) : null,
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await new Promise((resolve, reject) => {
        const request = http.get({
          host: '127.0.0.1',
          port: PORT,
          path: '/api/health',
          headers: { 'x-hrboss-token': TOKEN },
        }, resolve);
        request.on('error', reject);
      });
      response.resume();
      if (response.statusCode === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('action server did not become ready');
}

function seedCandidate(job, suffix) {
  return db.upsertCandidate({
    job_id: job.id,
    geek_id: `function-close-001-${suffix}`,
    name: `合成候选人 ${suffix}`,
  });
}

async function create(candidate, job, round = 999, mode = 'online') {
  return post('/api/interview-session', {
    candidateId: candidate.internal_id,
    jobId: job.id,
    round,
    mode,
  });
}

(async () => {
  db.openDb(DB_PATH);
  const database = db.conn();
  const job = db.upsertJob({ encrypt_job_id: 'function-close-001-job', name: '合成多轮面试岗位' });
  const candidate = seedCandidate(job, '主路径');

  await actionServer.startHttpServer();
  await waitForHealth();

  let response = await create(candidate, job, 99);
  assert.equal(response.status, 200);
  assert.equal(response.body.session.round, 1, 'renderer-provided round must not skip the first round');
  assert.equal(response.body.session.status, 'draft');
  const round1 = response.body.session;

  response = await create(candidate, job, 88);
  assert.equal(response.status, 400, 'draft latest session must block another round');
  assert.match(response.body.error, /第 1 轮.*待排期/);
  assert.equal(db.listInterviewSessions({ candidateId: candidate.internal_id }).length, 1);

  response = await post('/api/interview-session/schedule', {
    sessionId: round1.id,
    scheduledAt: `${SCHEDULE_YEAR}-08-20T10:00:00+08:00`,
    confirmed: true,
    requestId: 'function-close-001-scheduled',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.session.status, 'scheduled');
  response = await create(candidate, job, 77);
  assert.equal(response.status, 400, 'scheduled latest session must block another round');
  assert.match(response.body.error, /第 1 轮.*已排期/);

  db.setInterviewSessionStatus({ sessionId: round1.id, status: 'in_progress' });
  response = await create(candidate, job, 66);
  assert.equal(response.status, 400, 'in_progress latest session must block another round');
  assert.match(response.body.error, /第 1 轮.*面试中/);

  db.setInterviewSessionStatus({ sessionId: round1.id, status: 'pending_review' });
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session_report WHERE session_id = ?').get(round1.id).n, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session_material WHERE session_id = ?').get(round1.id).n, 0);
  response = await create(candidate, job, 55, 'offline');
  assert.equal(response.status, 200, 'pending_review must allow the next round without a report');
  assert.equal(response.body.session.round, 2, 'server must choose max round + 1');
  assert.equal(response.body.session.mode, 'offline');
  const round2 = response.body.session;
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session_report WHERE session_id = ?').get(round2.id).n, 0, 'reports must not be copied');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session_material WHERE session_id = ?').get(round2.id).n, 0, 'materials must not be copied');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session_schedule_confirmation WHERE session_id = ?').get(round2.id).n, 0, 'schedule confirmations must not be copied');
  assert.equal(round2.scheduled_at, null, 'scheduled time must not be copied');

  db.setInterviewSessionStatus({ sessionId: round2.id, status: 'confirmed' });
  response = await create(candidate, job, 44);
  assert.equal(response.status, 200, 'confirmed latest session must allow the next round');
  assert.equal(response.body.session.round, 3);
  const round3 = response.body.session;

  response = await post('/api/interview-lifecycle/withdraw', {
    sessionId: round3.id,
    reasonCode: 'candidate_cancelled',
    confirmed: true,
  });
  assert.equal(response.status, 200);
  assert.equal(db.getInterviewSession(round3.id).status, 'cancelled');
  response = await create(candidate, job, 33);
  assert.equal(response.status, 200, 'cancelled latest session must allow the next round');
  assert.equal(response.body.session.round, 4);
  const round4 = response.body.session;
  assert.equal(round4.scheduled_at, null, 'cancelled round schedule must not carry forward');
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM interview_lifecycle_event WHERE session_id = ? AND event_type = 'session_withdrawn'").get(String(round4.id)).n, 0, 'cancel reason must not be copied');
  assert.equal(db.getInterviewLifecycleStatus({ sessionId: round4.id }).state, 'active');

  console.log(JSON.stringify({ ok: true, contract: 'function-close-001' }));
  await actionServer.shutdown();
})().catch(async (error) => {
  try { await actionServer.shutdown(); } catch {}
  console.error(error);
  process.exitCode = 1;
});
