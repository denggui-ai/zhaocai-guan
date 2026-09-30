'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-assessment-workbench-'));
process.env.BOSS_DB_PATH = path.join(root, 'assessment-workbench.db');
process.env.HRBOSS_DATA_DIR = path.join(root, 'data');
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = path.join(root, 'interviews');
process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED = '1';
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const db = require('./db');

const database = db.openDb(process.env.BOSS_DB_PATH);
const job = db.upsertJob({
  encrypt_job_id: 'synthetic-assessment-workbench-job',
  numeric_job_id: '991000000001',
  name: '合成测评策略岗位',
  hr_owner: 'HR',
});
const jd = db.createJobJdVersion({
  jobId: job.id,
  jdText: '合成 JD，仅用于测评工作台回归。',
  actor: 'HR-ASSESSMENT-TEST',
});
db.activateJobJdVersion({
  jdVersionId: jd.id,
  expectedVersion: jd.version,
  actor: 'HR-ASSESSMENT-TEST',
});
const requiredProfile = db.createJobProfileVersion({
  jobId: job.id,
  jdVersionId: jd.id,
  config: {
    schema_version: 'manual_job_profile_v1',
    must_haves: ['合成要求'],
    assessment_policy: 'required',
  },
  actor: 'HR-ASSESSMENT-TEST',
});
db.confirmJobProfileVersion({
  profileVersionId: requiredProfile.id,
  expectedVersion: requiredProfile.version,
  actor: 'HR-ASSESSMENT-TEST',
});

const candidate = db.upsertCandidate({
  job_id: job.id,
  geek_id: 'synthetic-assessment-workbench-candidate',
  source: 'synthetic_assessment_workbench',
  name: '合成测评候选人',
});
let workbench = db.getJobWorkbench(job.id);
let assessmentTodo = workbench.todos.find((item) => item.candidate_id === candidate.internal_id
  && item.code.startsWith('assessment_'));
assert.equal(assessmentTodo.code, 'assessment_report_required');
assert.equal(assessmentTodo.blocking, true);
assert.deepEqual(assessmentTodo.action, {
  type: 'open_candidate_assessment',
  target_id: candidate.internal_id,
});
assert.equal(workbench.assessment.policy, 'required');

const timestamp = '2026-07-27T12:00:00.000Z';
const documentId = 'DOC-ASSESSMENT-WORKBENCH-1';
const contentHash = 'a'.repeat(64);
database.prepare(`
  INSERT INTO assessment_document (
    id, content_sha256, storage_relpath, byte_size, page_count, mime_detected,
    security_state, report_type, assessment_date,
    analysis_status, analysis_schema_version, analysis_json, analysis_error_code,
    review_state, dispute_state, lifecycle_state,
    retention_policy_version, delete_after, legal_hold_state,
    supersedes_document_id, created_by, version, created_at, updated_at, deleted_at
  ) VALUES (
    ?, ?, ?, 1024, 2, 'application/pdf',
    'accepted', 'unknown', NULL,
    'ready', 'synthetic-v1', '{}', NULL,
    'pending', 'none', 'active',
    'synthetic-retention-v1', '2027-07-27T12:00:00.000Z', 'none',
    NULL, 'local-primary-operator', 1, ?, ?, NULL
  )
`).run(documentId, contentHash, `sha256/${contentHash}.pdf`, timestamp, timestamp);
database.prepare(`
  INSERT INTO assessment_binding (
    id, document_id, candidate_id, job_id, scope, state, conflict_state,
    identity_basis, actor_id, reason_code, request_id, version,
    created_at, updated_at, revoked_at
  ) VALUES (
    'BIND-ASSESSMENT-WORKBENCH-1', ?, ?, ?,
    'candidate_job_archive', 'pending', 'none',
    'current_candidate_context', 'local-primary-operator',
    'synthetic_pending', 'REQ-ASSESSMENT-WORKBENCH-1',
    1, ?, ?, NULL
  )
`).run(documentId, candidate.internal_id, job.id, timestamp, timestamp);

workbench = db.getJobWorkbench(job.id);
assessmentTodo = workbench.todos.find((item) => item.candidate_id === candidate.internal_id
  && item.code.startsWith('assessment_'));
assert.equal(assessmentTodo.code, 'assessment_review_required');

database.prepare(`
  UPDATE assessment_document
  SET report_type = 'career_potential', review_state = 'ready',
      version = version + 1, updated_at = ?
  WHERE id = ?
`).run('2026-07-27T12:01:00.000Z', documentId);
workbench = db.getJobWorkbench(job.id);
assessmentTodo = workbench.todos.find((item) => item.candidate_id === candidate.internal_id
  && item.code.startsWith('assessment_'));
assert.equal(assessmentTodo.code, 'assessment_binding_confirmation_required');

database.prepare(`
  UPDATE assessment_binding
  SET state = 'active', version = version + 1, updated_at = ?
  WHERE id = 'BIND-ASSESSMENT-WORKBENCH-1'
`).run('2026-07-27T12:02:00.000Z');
workbench = db.getJobWorkbench(job.id);
assert.equal(workbench.todos.some((item) => item.candidate_id === candidate.internal_id
  && item.code.startsWith('assessment_')), false);
assert.equal(workbench.assessment.candidates_ready, 1);
assert.equal(workbench.metrics.assessment_ready_count, 1);

const recommendedProfile = db.createJobProfileVersion({
  jobId: job.id,
  jdVersionId: jd.id,
  config: {
    schema_version: 'manual_job_profile_v1',
    must_haves: ['合成要求'],
    assessment_policy: 'recommended',
  },
  actor: 'HR-ASSESSMENT-TEST',
});
db.confirmJobProfileVersion({
  profileVersionId: recommendedProfile.id,
  expectedVersion: recommendedProfile.version,
  actor: 'HR-ASSESSMENT-TEST',
});
const recommendedCandidate = db.upsertCandidate({
  job_id: job.id,
  geek_id: 'synthetic-assessment-workbench-recommended',
  source: 'synthetic_assessment_workbench',
  name: '合成建议测评候选人',
});
workbench = db.getJobWorkbench(job.id);
assessmentTodo = workbench.todos.find((item) => item.candidate_id === recommendedCandidate.internal_id
  && item.code === 'assessment_report_required');
assert.ok(assessmentTodo);
assert.equal(assessmentTodo.blocking, false);
assert.equal(assessmentTodo.priority, 'normal');

const optionalProfile = db.createJobProfileVersion({
  jobId: job.id,
  jdVersionId: jd.id,
  config: {
    schema_version: 'manual_job_profile_v1',
    must_haves: ['合成要求'],
    assessment_policy: 'not_required',
  },
  actor: 'HR-ASSESSMENT-TEST',
});
db.confirmJobProfileVersion({
  profileVersionId: optionalProfile.id,
  expectedVersion: optionalProfile.version,
  actor: 'HR-ASSESSMENT-TEST',
});
workbench = db.getJobWorkbench(job.id);
assert.equal(workbench.todos.some((item) => item.code.startsWith('assessment_')), false);

database.close();
console.log('check-assessment-workbench-integration-001: ok');
