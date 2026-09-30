'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-interview-manual-action-'));
const DB_PATH = path.join(ROOT, 'recruiting.db');
const TOKEN = 'synthetic-interview-manual-action-token-0001';

const databases = new Set();
const trackDatabase = (database) => (databases.add(database), database);

function closeTrackedDatabases() {
  const errors = [];
  for (const database of [...databases].reverse()) {
    try {
      if (database && database.open) database.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'failed to close tracked fixture databases');
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function request(port, method, pathname, body = null) {
  const payload = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        'x-hrboss-token': TOKEN,
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        } : {}),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          body: text ? JSON.parse(text) : null,
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, 'GET', '/api/health');
      if (response.status === 200 && response.body?.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('synthetic action server did not become ready');
}

async function run() {
  const port = await freePort();
  process.env.BOSS_ACTION_PORT = String(port);
  process.env.BOSS_DB_PATH = DB_PATH;
  process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
  process.env.HRBOSS_RECOVERY_ROOT = path.join(ROOT, 'recovery');
  process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = path.join(ROOT, 'interviews');
  process.env.HRBOSS_LOCAL_API_TOKEN = TOKEN;
  process.env.HRBOSS_LOCAL_API_INSTANCE_ID = 'check-interview-manual-action-routes';
  process.env.HRBOSS_UI_FIXTURE_GATE = '1';
  process.env.HRBOSS_EXTERNAL_AI_ENABLED = '0';
  process.env.BOSS_ACTION_AUTOMATION_ENABLED = '0';

  const db = require("../src/db");
  const actionServer = require("../src/action-server");

  let primaryError = null;
  try {
    trackDatabase(db.openDb(DB_PATH));
    const job = db.upsertJob({
      encrypt_job_id: 'synthetic-manual-action-job',
      numeric_job_id: '991000000000992',
      name: '合成人工面试材料岗位',
      hr_owner: 'HR-SYNTHETIC',
    });
    const candidate = db.upsertCandidate({
      job_id: job.id,
      geek_id: 'synthetic-manual-action-candidate',
      source: 'fixture',
      name: '合成人工面试候选人',
    });

    await actionServer.startHttpServer();
    trackDatabase(db.conn());
    await waitForHealth(port);

    let response = await request(port, 'POST', '/api/interview-session', {
      candidateId: candidate.internal_id,
      jobId: job.id,
      interviewFormat: 'offline',
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    const session = response.body.session;

    response = await request(port, 'POST', '/api/interview-session/manual-note', {
      sessionId: session.id,
      body: '候选人说明三周内可以到岗，并完整复盘了一个合成项目；薪资仍待下一轮核实。',
      expectedVersion: 0,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.note.source_type, 'manual_note');
    assert.equal(response.body.note.updated_by, 'local-primary-operator');
    const note = response.body.note;

    response = await request(port, 'GET', `/api/interview-session/manual-note?sessionId=${session.id}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.note.version, 1);
    assert.equal(response.body.revisions.length, 1);

    response = await request(port, 'POST', '/api/interview-report/manual', {
      sessionId: session.id,
      materialIds: [note.material_id],
      expectedVersion: 0,
      requestId: 'synthetic-manual-action-report-1',
      form: {
        summary: '候选人提供了可核验的到岗与项目复盘信息。',
        hardRequirements: [{ label: '到岗周期', status: 'met', text: '三周内可以到岗' }],
        competencies: ['能够独立完成项目复盘'],
        motivation: '希望继续负责完整项目',
        risks: ['薪资尚未核实'],
        contradictions: ['薪资口径缺少证据'],
        unknowns: ['最终薪资期望'],
        followupQuestions: ['请确认最终薪资期望'],
        keyFacts: [{ label: '到岗周期', value: '三周内' }],
      },
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.report.status, 'draft');
    assert.equal(response.body.report.source_snapshot.tracked, true);

    response = await request(port, 'POST', '/api/interview-session/manual-note/revoke', {
      sessionId: session.id,
      expectedVersion: note.version,
      confirmed: true,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.note.status, 'revoked');

    response = await request(port, 'POST', '/api/local-interview/transcription/retry', {});
    assert.notEqual(response.status, 404, 'transcription retry must reach its action handler instead of the capability 404');
    assert.notEqual(response.body?.code, 'NOT_FOUND');
    assert.ok([400, 501].includes(response.status), JSON.stringify(response.body));

  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  if (databases.size) {
    try { trackDatabase(db.conn()); } catch (error) { cleanupErrors.push(error); }
  }
  try { await actionServer.shutdown(); } catch (error) { cleanupErrors.push(error); }
  try { closeTrackedDatabases(); } catch (error) { cleanupErrors.push(error); }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (primaryError) {
    if (cleanupErrors.length) {
      primaryError.cleanupError = new AggregateError(cleanupErrors, 'check-interview-manual-action-routes-001 cleanup failed');
    }
    throw primaryError;
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'check-interview-manual-action-routes-001 cleanup failed');
  console.log('manual note, structured report and transcription retry action HTTP routes passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
