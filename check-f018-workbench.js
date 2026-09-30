'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  getJobWorkbench,
  openDb,
  upsertCandidate,
} = require('./db');
const {
  confirmFinalReview,
  createFinalReview,
  recordFinalDisposition,
} = require('./f018-final-review-service');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f018-workbench-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const actor = Object.freeze({
  actor_id: 'local-primary-operator',
  actor_type: 'local_os_subject',
  actor_source: 'server_local_instance',
  actor_session_id: 'synthetic-f018-workbench',
  assurance: 'local_instance_only',
});
const workflowSource = fs.readFileSync(path.join(__dirname, 'workflow-projection.js'), 'utf8');
assert.match(workflowSource, /final_review_required:\s*\d+/);
assert.match(workflowSource, /final_disposition_confirmation_required:\s*\d+/);

function todoCodes() {
  return getJobWorkbench(1).todos.map((todo) => todo.code);
}

function run() {
  const database = openDb(path.join(root, 'synthetic.db'), {
    f018Enabled: true,
    assessmentEnabled: false,
  });
  const at = '2026-07-12T12:00:00.000Z';
  database.prepare(`
    INSERT INTO job (id, encrypt_job_id, name, is_fixture, source_type, created_at)
    VALUES (1, 'F018-WORKBENCH-JOB', '合成正式岗位', 0, 'local_db', ?)
  `).run(at);
  const candidate = upsertCandidate({
    job_id: 1,
    geek_id: 'G-F018-WORKBENCH',
    source: 'synthetic',
    name: '合成候选人',
    sabc: 'A',
    sabc_source: '人工',
  }, at);
  database.prepare(`
    INSERT INTO job_jd_version (
      id, job_id, version, status, source, jd_text, content_hash,
      created_by, created_at, activated_by, activated_at
    ) VALUES (101, 1, 1, 'active', 'manual', '合成 JD', ?, 'fixture', ?, 'fixture', ?)
  `).run('d'.repeat(64), at, at);
  database.prepare(`
    INSERT INTO job_profile_version (
      id, job_id, jd_version_id, version, status, config_json, content_hash,
      source_kind, source_ref_json, created_by, created_at, confirmed_by, confirmed_at
    ) VALUES (201, 1, 101, 1, 'confirmed', '{}', ?, 'manual', '{}', 'fixture', ?, 'fixture', ?)
  `).run('e'.repeat(64), at, at);
  database.prepare(`
    INSERT INTO interview_session (
      id, candidate_id, job_id, round, mode, interview_format, status, created_at, updated_at
    ) VALUES (301, ?, 1, 1, 'online', 'online', 'confirmed', ?, ?)
  `).run(candidate.internal_id, at, at);
  database.prepare(`
    INSERT INTO interview_report_v1 (
      id, session_id, schema_version, status, report_json, content_hash, version,
      created_by, updated_by, confirmed_by, confirmed_at, created_at, updated_at
    ) VALUES (401, 301, 'interview_report_v1', 'confirmed', '{}', ?, 2,
      'fixture', 'fixture', 'fixture', ?, ?, ?)
  `).run('f'.repeat(64), at, at, at);
  const application = database.prepare(`
    SELECT * FROM application_episode WHERE candidate_id = ? AND status = 'active'
  `).get(candidate.internal_id);
  assert.ok(todoCodes().includes('final_review_required'));

  const draft = createFinalReview({
    database,
    auditContext: actor,
    command: {
      application_id: application.id,
      job_profile_version_id: 201,
      interview_report_id: 401,
      review_json: {
        decision_summary: '合成人工终评',
        evidence_refs: [
          { source_type: 'job_profile', source_id: 201 },
          { source_type: 'interview_report', source_id: 401 },
        ],
      },
      expected_version: 0,
      request_id: 'REQ-F018-WORKBENCH-DRAFT',
    },
  });
  assert.ok(todoCodes().includes('final_review_required'));
  const confirmed = confirmFinalReview({
    database,
    auditContext: actor,
    command: {
      application_id: application.id,
      final_review_id: draft.id,
      expected_version: draft.version,
      request_id: 'REQ-F018-WORKBENCH-CONFIRM',
      confirmed: true,
    },
  });
  assert.equal(todoCodes().includes('final_review_required'), false);
  assert.ok(todoCodes().includes('final_disposition_confirmation_required'));

  recordFinalDisposition({
    database,
    auditContext: actor,
    command: {
      application_id: application.id,
      final_review_id: confirmed.id,
      action: 'hold',
      reason_code: 'manual_hold',
      expected_version: application.version,
      request_id: 'REQ-F018-WORKBENCH-DISPOSITION',
      confirmed: true,
    },
  });
  const after = todoCodes();
  assert.equal(after.includes('final_review_required'), false);
  assert.equal(after.includes('final_disposition_confirmation_required'), false);
  database.close();
  console.log('check-f018-workbench ok');
}

try { run(); } catch (error) {
  console.error(error);
  process.exit(1);
}
