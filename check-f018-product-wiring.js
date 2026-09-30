'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { openDb } = require('./db');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f018-product-wiring-'));
const dbPath = path.join(root, 'synthetic.db');
let child = null;
process.on('exit', () => {
  try { child?.kill('SIGKILL'); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
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

function request(port, token, method, requestPath, body = null) {
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: requestPath, method,
      headers: {
        'x-hrboss-token': token,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth(port, token) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, token, 'GET', '/api/health');
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('synthetic F018 action server did not become healthy');
}

function seedFoundation() {
  const database = openDb(dbPath, { f018Enabled: false, assessmentEnabled: false });
  const at = '2026-07-12T10:00:00.000Z';
  database.prepare(`INSERT INTO job (id, encrypt_job_id, name, created_at) VALUES (1, 'F018-WIRING-JOB', '合成岗位', ?)`)
    .run(at);
  database.prepare(`
    INSERT INTO candidate (
      internal_id, job_id, geek_id, source, name, sabc, quality_score,
      disposition_status, disposition_code, workflow_version, created_at, updated_at
    ) VALUES ('C-F018-WIRING', 1, 'G-F018-WIRING', 'fixture', '合成候选人', 'A', 88,
      '待处理', 'under_review', 1, ?, ?)
  `).run(at, at);
  database.prepare(`
    INSERT INTO candidate (
      internal_id, job_id, geek_id, source, name, sabc, quality_score,
      disposition_status, disposition_code, workflow_version, created_at, updated_at
    ) VALUES ('C-F018-WIRING-HIRED', 1, 'G-F018-WIRING-HIRED', 'fixture', '已入职合成候选人', 'S', 95,
      '已入职', 'hired', 1, ?, ?)
  `).run(at, at);
  database.prepare(`
    INSERT INTO job_jd_version (
      id, job_id, version, status, source, jd_text, content_hash,
      created_by, created_at, activated_by, activated_at
    ) VALUES (101, 1, 1, 'active', 'manual', '合成 JD', ?, 'fixture', ?, 'fixture', ?)
  `).run('a'.repeat(64), at, at);
  database.prepare(`
    INSERT INTO job_profile_version (
      id, job_id, jd_version_id, version, status, config_json, content_hash,
      source_kind, source_ref_json, created_by, created_at, confirmed_by, confirmed_at
    ) VALUES (201, 1, 101, 1, 'confirmed', '{}', ?, 'manual', '{}', 'fixture', ?, 'fixture', ?)
  `).run('b'.repeat(64), at, at);
  database.prepare(`
    INSERT INTO interview_session (
      id, candidate_id, job_id, round, mode, interview_format, status, created_at, updated_at
    ) VALUES (301, 'C-F018-WIRING', 1, 1, 'online', 'online', 'confirmed', ?, ?)
  `).run(at, at);
  database.prepare(`
    INSERT INTO interview_report_v1 (
      id, session_id, schema_version, status, report_json, content_hash, version,
      created_by, updated_by, confirmed_by, confirmed_at, created_at, updated_at
    ) VALUES (401, 301, 'interview_report_v1', 'confirmed', '{}', ?, 2,
      'fixture', 'fixture', 'fixture', ?, ?, ?)
  `).run('c'.repeat(64), at, at, at);
  database.close();
}

async function run() {
  const disabledPort = await freePort();
  const disabledToken = 'synthetic-f018-disabled-token-'.repeat(2);
  const disabledDbPath = path.join(root, 'synthetic-disabled.db');
  child = spawn(process.execPath, [path.join(__dirname, 'action-server.js')], {
    cwd: __dirname,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      BOSS_ACTION_PORT: String(disabledPort),
      BOSS_DB_PATH: disabledDbPath,
      HRBOSS_DATA_DIR: root,
      HRBOSS_LOCAL_API_TOKEN: disabledToken,
      HRBOSS_LOCAL_API_INSTANCE_ID: 'synthetic-f018-disabled-instance',
      HRBOSS_F009_APPROVAL_SECRET: 'synthetic-f009-secret-for-disabled-f018-check',
      HRBOSS_F018_ENABLED: '0',
      HRBOSS_ASSESSMENT_PHASE_A_ENABLED: '0',
    },
  });
  await waitForHealth(disabledPort, disabledToken);
  let disabled = await request(disabledPort, disabledToken, 'GET', '/api/f018/status');
  assert.equal(disabled.status, 404);
  assert.equal(disabled.body.code, 'F018_DISABLED');
  disabled = await request(disabledPort, disabledToken, 'POST', '/api/f018/application/close', {
    candidate_id: 'C-NOT-AVAILABLE', job_id: 1, application_id: 1, expected_version: 1,
    request_id: 'REQ-F018-DISABLED-WRITE', reason_code: 'must_fail_closed',
  });
  assert.equal(disabled.status, 404);
  assert.equal(disabled.body.code, 'F018_DISABLED');
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  child = null;
  const disabledDatabase = new Database(disabledDbPath, { readonly: true, fileMustExist: true });
  assert.equal(disabledDatabase.prepare(`
    SELECT COUNT(*) AS n FROM sqlite_master
    WHERE type = 'table' AND name IN ('application_episode', 'application_event', 'final_review', 'final_disposition')
  `).get().n, 0);
  disabledDatabase.close();

  seedFoundation();
  const port = await freePort();
  const token = 'synthetic-f018-local-api-token-'.repeat(2);
  child = spawn(process.execPath, [path.join(__dirname, 'action-server.js')], {
    cwd: __dirname,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      BOSS_ACTION_PORT: String(port),
      BOSS_DB_PATH: dbPath,
      HRBOSS_DATA_DIR: root,
      HRBOSS_LOCAL_API_TOKEN: token,
      HRBOSS_LOCAL_API_INSTANCE_ID: 'synthetic-f018-instance',
      HRBOSS_F009_APPROVAL_SECRET: 'synthetic-f009-secret-for-f018-check',
      HRBOSS_F018_ENABLED: '1',
      HRBOSS_ASSESSMENT_PHASE_A_ENABLED: '0',
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  await waitForHealth(port, token);

  const status = await request(port, token, 'GET', '/api/f018/status');
  assert.equal(status.status, 200);
  assert.deepEqual({
    enabled: status.body.enabled,
    release_allowed: status.body.release_allowed,
    decision_use_allowed: status.body.decision_use_allowed,
    assessment_evidence_allowed: status.body.assessment_evidence_allowed,
    assessment_influence_enabled: status.body.assessment_influence_enabled,
    hired_enabled: status.body.hired_enabled,
    automatic_disposition_enabled: status.body.automatic_disposition_enabled,
  }, {
    enabled: true,
    release_allowed: false,
    decision_use_allowed: false,
    assessment_evidence_allowed: true,
    assessment_influence_enabled: false,
    hired_enabled: false,
    automatic_disposition_enabled: false,
  });

  let response = await request(port, token, 'GET', '/api/f018/final-review?candidateId=C-F018-WIRING&jobId=1');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const application = response.body.state.active_application;
  assert.ok(application && application.episode_no === 1);
  assert.deepEqual(response.body.state.prerequisites, {
    confirmed_job_profile_id: 201,
    confirmed_interview_report_id: 401,
    assessment_policy: 'not_required',
    confirmed_assessments: [],
    assessment_requirement_met: true,
    current_assessment_ai_analysis: null,
  });

  const commonContext = { candidate_id: 'C-F018-WIRING', job_id: 1 };
  response = await request(port, token, 'POST', '/api/f018/final-review/draft', {
    ...commonContext,
    application_id: application.id,
    job_profile_version_id: 201,
    interview_report_id: 401,
    review_json: {
      decision_summary: '合成人工终评摘要',
      evidence_refs: [
        { source_type: 'job_profile', source_id: 201 },
        { source_type: 'interview_report', source_id: 401 },
      ],
    },
    expected_version: 0,
    request_id: 'REQ-F018-WIRING-DRAFT',
    actor: 'forged-admin',
    actorRole: 'super_admin',
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const draft = response.body.review;
  assert.equal(draft.status, 'draft');
  assert.equal(JSON.stringify(response.body).includes('forged-admin'), false);

  let concurrent = new Database(dbPath);
  concurrent.prepare("UPDATE job SET status = 'closed' WHERE id = 1").run();
  concurrent.close();

  response = await request(port, token, 'POST', '/api/f018/final-review/confirm', {
    ...commonContext,
    application_id: application.id,
    final_review_id: draft.id,
    expected_version: draft.version,
    request_id: 'REQ-F018-WIRING-CLOSED-CONFIRM',
    confirmed: true,
  });
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.code, 'JOB_CLOSED');

  response = await request(port, token, 'GET', '/api/f018/final-review?candidateId=C-F018-WIRING&jobId=1');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.state.current_review.status, 'draft', 'closed job history must remain readable');

  concurrent = new Database(dbPath);
  concurrent.prepare("UPDATE job SET status = 'open' WHERE id = 1").run();
  concurrent.close();

  response = await request(port, token, 'POST', '/api/f018/final-review/confirm', {
    ...commonContext,
    application_id: application.id,
    final_review_id: draft.id,
    expected_version: draft.version,
    request_id: 'REQ-F018-WIRING-CONFIRM',
    confirmed: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const confirmed = response.body.review;
  assert.equal(confirmed.status, 'confirmed');

  concurrent = new Database(dbPath, { readonly: true, fileMustExist: true });
  assert.deepEqual(concurrent.prepare(`
    SELECT sabc, quality_score, disposition_code, workflow_version
    FROM candidate WHERE internal_id = 'C-F018-WIRING'
  `).get(), { sabc: 'A', quality_score: 88, disposition_code: 'under_review', workflow_version: 1 });
  concurrent.close();

  const hired = await request(port, token, 'POST', '/api/f018/disposition', {
    ...commonContext,
    application_id: application.id,
    final_review_id: confirmed.id,
    action: 'hired',
    reason_code: 'forbidden_hired',
    expected_version: application.version,
    request_id: 'REQ-F018-WIRING-HIRED',
    confirmed: true,
  });
  assert.equal(hired.status, 400);
  assert.equal(hired.body.code, 'HIRED_FORBIDDEN');

  concurrent = new Database(dbPath);
  concurrent.prepare("UPDATE job SET status = 'closed' WHERE id = 1").run();
  concurrent.close();

  response = await request(port, token, 'POST', '/api/f018/final-review/confirm', {
    ...commonContext,
    application_id: application.id,
    final_review_id: confirmed.id,
    expected_version: draft.version,
    request_id: 'REQ-F018-WIRING-CONFIRM',
    confirmed: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.review.idempotent_replay, true,
    'a committed idempotent replay remains readable and zero-write after job close');

  response = await request(port, token, 'POST', '/api/f018/disposition', {
    ...commonContext,
    application_id: application.id,
    final_review_id: confirmed.id,
    action: 'reject',
    reason_code: 'manual_final_reject',
    expected_version: application.version,
    request_id: 'REQ-F018-WIRING-DISPOSITION',
    confirmed: true,
  });
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.code, 'JOB_CLOSED');

  response = await request(port, token, 'GET', '/api/f018/final-review?candidateId=C-F018-WIRING&jobId=1');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.state.active_application.id, application.id);
  assert.equal(response.body.state.review_history.length, 1);
  assert.equal(response.body.state.disposition_history.length, 0);

  for (const transition of ['close', 'withdraw']) {
    response = await request(port, token, 'POST', `/api/f018/application/${transition}`, {
      ...commonContext,
      application_id: application.id,
      expected_version: application.version,
      request_id: `REQ-F018-WIRING-CLOSED-${transition.toUpperCase()}`,
      reason_code: `closed_job_must_not_${transition}`,
    });
    assert.equal(response.status, 409, JSON.stringify(response.body));
    assert.equal(response.body.code, 'JOB_CLOSED');
  }

  response = await request(port, token, 'POST', '/api/f018/application/reenter', {
    ...commonContext,
    application_id: application.id,
    expected_version: application.version,
    request_id: 'REQ-F018-WIRING-CLOSED-REENTER',
    reason_code: 'candidate_reapplied',
  });
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.code, 'JOB_CLOSED');

  concurrent = new Database(dbPath);
  concurrent.prepare("UPDATE job SET status = 'open' WHERE id = 1").run();
  concurrent.close();

  response = await request(port, token, 'POST', '/api/f018/disposition', {
    ...commonContext,
    application_id: application.id,
    final_review_id: confirmed.id,
    action: 'reject',
    reason_code: 'manual_final_reject_after_job_reopen',
    expected_version: application.version,
    request_id: 'REQ-F018-WIRING-REOPENED-DISPOSITION',
    confirmed: true,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.disposition.action, 'reject');
  response = await request(port, token, 'GET', '/api/f018/final-review?candidateId=C-F018-WIRING&jobId=1');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.state.active_application, null);
  assert.equal(response.body.state.disposition_history.length, 1);
  assert.equal(response.body.state.disposition_history[0].action, 'reject');

  response = await request(port, token, 'GET', '/api/f018/final-review?candidateId=C-F018-WIRING-HIRED&jobId=1');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const hiredApplication = response.body.state.applications[0];
  assert.ok(hiredApplication && hiredApplication.status === 'closed');
  response = await request(port, token, 'POST', '/api/f018/application/reenter', {
    candidate_id: 'C-F018-WIRING-HIRED',
    job_id: 1,
    application_id: hiredApplication.id,
    expected_version: hiredApplication.version,
    request_id: 'REQ-F018-WIRING-HIRED-REENTER',
    reason_code: 'candidate_reapplied',
  });
  assert.equal(response.status, 400, JSON.stringify(response.body));
  assert.equal(response.body.code, 'HIRED_FORBIDDEN');

  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  child = null;
  assert.equal(stderr.includes('forged-admin'), false);

  const database = new Database(dbPath, { readonly: true, fileMustExist: true });
  assert.deepEqual(database.prepare(`
    SELECT sabc, quality_score, disposition_code, workflow_version
    FROM candidate WHERE internal_id = 'C-F018-WIRING'
  `).get(), { sabc: 'A', quality_score: 88, disposition_code: 'rejected', workflow_version: 2 });
  assert.deepEqual(database.prepare(`
    SELECT disposition_status, disposition_code, workflow_version
    FROM candidate WHERE internal_id = 'C-F018-WIRING-HIRED'
  `).get(), { disposition_status: '已入职', disposition_code: 'hired', workflow_version: 1 });
  assert.deepEqual(database.prepare(`
    SELECT status, disposition_action, version FROM application_episode WHERE id = ?
  `).get(application.id), { status: 'closed', disposition_action: 'reject', version: 2 });
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM final_disposition').get().n, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM status_history WHERE source = 'f018_final_disposition'").get().n, 1);
  database.close();
  console.log('check-f018-product-wiring ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
