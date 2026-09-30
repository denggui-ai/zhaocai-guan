'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `hrboss-interview-schedule-${process.pid}-`));
const DB_PATH = path.join(ROOT, 'schedule.db');
const PORT = 19600 + (process.pid % 700);
const TOKEN = 'interview-schedule-local-api-token-0000000000000001';
const SCHEDULE_YEAR = new Date().getUTCFullYear() + 1;

process.env.BOSS_DB_PATH = DB_PATH;
process.env.BOSS_ACTION_PORT = String(PORT);
process.env.HRBOSS_LOCAL_API_TOKEN = TOKEN;
process.env.HRBOSS_LOCAL_API_INSTANCE_ID = 'interview-schedule-check';
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

(async () => {
  db.openDb(DB_PATH);
  const job = db.upsertJob({ encrypt_job_id: 'schedule-synthetic-job', name: '合成排期岗位' });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'schedule-synthetic-candidate',
    name: '合成排期候选人',
  });

  await actionServer.startHttpServer();
  await waitForHealth();

  let response = await post('/api/interview-session', {
    candidateId: candidate.internal_id,
    jobId: job.id,
    round: 1,
    mode: 'online',
    status: 'confirmed',
    scheduledAt: `${SCHEDULE_YEAR}-08-01T02:00:00.000Z`,
  });
  assert.equal(response.status, 200);
  const firstSessionId = response.body.session.id;
  assert.equal(response.body.session.status, 'draft', 'create route must force draft');
  assert.equal(response.body.session.scheduled_at, null, 'create route must ignore renderer schedule input');

  response = await post('/api/interview-session/schedule', {
    sessionId: firstSessionId,
    scheduledAt: '2020-01-01T10:00:00+08:00',
    confirmed: true,
    requestId: 'schedule-check-past-time',
  });
  assert.equal(response.status, 400, 'past interview time must be rejected');
  assert.equal(response.body.code, 'INTERVIEW_SCHEDULE_IN_PAST');
  assert.equal(db.getInterviewSession(firstSessionId).scheduled_at, null);

  response = await post('/api/interview-session/schedule', {
    sessionId: firstSessionId,
    scheduledAt: `${SCHEDULE_YEAR}-08-01T10:00:00+08:00`,
    confirmed: true,
    requestId: 'schedule-check-first',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.session.status, 'scheduled');
  assert.equal(response.body.session.scheduled_at, `${SCHEDULE_YEAR}-08-01T02:00:00.000Z`);

  response = await post('/api/interview-session/schedule', {
    sessionId: firstSessionId,
    scheduledAt: `${SCHEDULE_YEAR}-08-02T15:30:00+08:00`,
    confirmed: true,
    requestId: 'schedule-check-reschedule',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.session.scheduled_at, `${SCHEDULE_YEAR}-08-02T07:30:00.000Z`);
  assert.equal(
    db.conn().prepare('SELECT COUNT(*) AS n FROM interview_session_schedule_confirmation WHERE session_id = ?').get(firstSessionId).n,
    2,
    'reschedule must append a second manual confirmation',
  );

  response = await post('/api/interview-lifecycle/withdraw', {
    sessionId: firstSessionId,
    reasonCode: 'candidate_no_show',
    confirmed: true,
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.lifecycle.state, 'withdrawn');
  assert.equal(db.getInterviewSession(firstSessionId).status, 'cancelled');
  assert.equal(
    db.conn().prepare("SELECT reason_code FROM interview_lifecycle_event WHERE session_id = ? AND event_type = 'session_withdrawn'").get(String(firstSessionId)).reason_code,
    'candidate_no_show',
  );

  response = await post('/api/interview-session/schedule', {
    sessionId: firstSessionId,
    scheduledAt: `${SCHEDULE_YEAR}-08-03T10:00:00+08:00`,
    confirmed: true,
    requestId: 'schedule-check-after-cancel',
  });
  assert.equal(response.status, 400, 'cancelled session must not be scheduled again');

  const workbench = db.getJobWorkbench(job.id);
  const cancelled = workbench.interview_sessions.find((session) => Number(session.id) === Number(firstSessionId));
  assert.equal(cancelled.lifecycle_state, 'withdrawn');
  assert.equal(cancelled.cancel_reason, 'candidate_no_show');

  response = await post('/api/interview-session', {
    candidateId: candidate.internal_id,
    jobId: job.id,
    round: 2,
    mode: 'offline',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.session.round, 2);
  assert.equal(response.body.session.status, 'draft');
  assert.equal(db.getInterviewLifecycleStatus({ sessionId: response.body.session.id }).state, 'active');

  db.setInterviewSessionStatus({ sessionId: response.body.session.id, status: 'confirmed' });
  const confirmedSessionId = response.body.session.id;
  response = await post('/api/interview-lifecycle/withdraw', {
    sessionId: confirmedSessionId,
    reasonCode: 'candidate_cancelled',
    confirmed: true,
  });
  assert.equal(response.status, 200);
  assert.equal(db.getInterviewSession(confirmedSessionId).status, 'confirmed', 'withdraw must not rewrite a confirmed session');

  console.log(JSON.stringify({ ok: true, contract: 'interview-schedule-001' }));
  await actionServer.shutdown();
})().catch(async (error) => {
  try { await actionServer.shutdown(); } catch {}
  console.error(error);
  process.exitCode = 1;
});
