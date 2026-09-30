'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f010-db-retention-'));
const DB_PATH = path.join(ROOT, 'synthetic.db');
const MATERIAL_ROOT = path.join(ROOT, 'interviews');
fs.mkdirSync(MATERIAL_ROOT, { recursive: true, mode: 0o700 });
process.env.BOSS_DB_PATH = DB_PATH;
process.env.HRBOSS_DATA_DIR = ROOT;
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = MATERIAL_ROOT;

const db = require("../src/db");

function errorCode(work, expected) {
  assert.throws(work, (error) => error && error.code === expected, `expected ${expected}`);
}

function seedOnlineMaterial(database, sessionId, jobId, suffix, createdAt) {
  const info = database.prepare(`
    INSERT INTO job_interview (job_id, source_url, transcript, note, source_type, created_at)
    VALUES (?, ?, ?, ?, 'manual_transcript', ?)
  `).run(jobId, `https://synthetic.invalid/${suffix}`, `synthetic transcript ${suffix}`,
    `synthetic note ${suffix}`, createdAt);
  const interviewId = Number(info.lastInsertRowid);
  const linked = database.prepare(`
    INSERT INTO interview_session_material (
      session_id, material_kind, job_interview_id, interview_recording_id, linked_by, linked_at
    ) VALUES (?, 'online_minutes', ?, NULL, 'synthetic-test', ?)
  `).run(sessionId, interviewId, createdAt);
  return { interviewId, materialId: Number(linked.lastInsertRowid) };
}

function seedReport(database, sessionId, status, createdAt) {
  const confirmed = status === 'confirmed';
  const info = database.prepare(`
    INSERT INTO interview_report_v1 (
      session_id, schema_version, status, report_json, content_hash, version,
      created_by, updated_by, confirmed_by, confirmed_at,
      rejected_by, rejected_at, created_at, updated_at
    ) VALUES (?, 'interview_report_v1', ?, ?, ?, 1,
      'synthetic-test', 'synthetic-test', ?, ?, NULL, NULL, ?, ?)
  `).run(
    sessionId,
    status,
    JSON.stringify({ synthetic_sensitive_report: `report-${sessionId}` }),
    'synthetic-content-hash',
    confirmed ? 'synthetic-test' : null,
    confirmed ? createdAt : null,
    createdAt,
    createdAt,
  );
  const reportId = Number(info.lastInsertRowid);
  database.prepare(`
    INSERT INTO interview_report_fact_review (
      report_id, field_key, fact_hash, status, corrected_value,
      reviewed_by, reviewed_at, version, created_at, updated_at
    ) VALUES (?, 'synthetic_fact', 'synthetic-fact-hash', 'corrected',
      'synthetic corrected sensitive value', 'synthetic-test', ?, 1, ?, ?)
  `).run(reportId, createdAt, createdAt, createdAt);
  database.prepare(`
    INSERT INTO interview_report_action_request (
      request_id, report_id, session_id, action, payload_hash,
      response_version, response_status, actor, created_at
    ) VALUES (?, ?, ?, 'save', 'synthetic-payload-hash', 1, ?, 'synthetic-test', ?)
  `).run(`synthetic-request-${reportId}`, reportId, sessionId, status, createdAt);
  return reportId;
}

try {
  let database = db.openDb(DB_PATH);
  const job = db.upsertJob({ encrypt_job_id: 'synthetic-f010-retention-job', name: '合成保留策略岗位' });
  const candidateId = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'synthetic-f010-retention-candidate',
    name: '合成候选人',
  }).internal_id;
  const oldAt = '2000-01-01T00:00:00.000Z';

  const activeSession = db.createInterviewSession({ candidateId, jobId: job.id, round: 1, mode: 'online' });
  const activeMaterial = seedOnlineMaterial(database, activeSession.id, job.id, 'active', oldAt);
  const draftReportId = seedReport(database, activeSession.id, 'draft', oldAt);
  database.prepare(`
    INSERT INTO interview_llm_request_audit (
      request_id, session_id, material_ids_json, request_hash, response_hash,
      provider, base_url, model, returned_model, prompt_version, prompt_hash, schema_version,
      model_catalog_hash, source_version_hash, status, duration_ms, input_tokens,
      output_tokens, error_code, report_id, actor, created_at, updated_at
    ) VALUES (
      'synthetic-f009-retention', ?, ?, 'synthetic-request-hash', 'synthetic-response-hash',
      'synthetic', 'https://ai.example.test/v1', 'synthetic-model', 'synthetic-model', 'synthetic-prompt-v1',
      'synthetic-prompt-hash', 'interview_report_v1', 'synthetic-catalog-hash',
      'synthetic-source-hash', 'draft_saved', 1, 1, 1, NULL, ?,
      'synthetic-test', ?, ?
    )
  `).run(activeSession.id, JSON.stringify([activeMaterial.materialId]), draftReportId, oldAt, oldAt);

  const closedSession = db.createInterviewSession({ candidateId, jobId: job.id, round: 2, mode: 'online' });
  seedOnlineMaterial(database, closedSession.id, job.id, 'closed', new Date().toISOString());
  const confirmedReportId = seedReport(database, closedSession.id, 'confirmed', new Date().toISOString());

  database.close();
  database = db.openDb(DB_PATH);

  const transcriptLifecycle = database.prepare(`
    SELECT * FROM interview_lifecycle_material WHERE id = ?
  `).get(`db-job-interview-${activeMaterial.interviewId}`);
  assert.equal(transcriptLifecycle.storage_kind, 'sqlite');
  assert.equal(transcriptLifecycle.artifact_class, 'transcript');
  assert.equal(transcriptLifecycle.db_entity_type, 'job_interview');
  assert.equal(transcriptLifecycle.db_entity_id, String(activeMaterial.interviewId));
  assert.equal(transcriptLifecycle.delete_after, '2000-03-31T00:00:00.000Z');

  const draftLifecycle = database.prepare('SELECT * FROM interview_lifecycle_material WHERE id = ?')
    .get(`db-report-v1-${draftReportId}`);
  assert.equal(draftLifecycle.artifact_class, 'draft');
  assert.equal(draftLifecycle.delete_after, '2000-03-31T00:00:00.000Z');

  const hold = db.applyInterviewLegalHold({
    sessionId: activeSession.id,
    reasonCode: 'synthetic_legal_review',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  const lifecycleStatus = db.getInterviewLifecycleStatus({ sessionId: activeSession.id });
  assert.deepEqual(Object.keys(lifecycleStatus).sort(), [
    'active_holds', 'created_at', 'recruitment_closed_at', 'session_id', 'state', 'version', 'withdrawn_at',
  ]);
  assert.deepEqual(Object.keys(lifecycleStatus.active_holds[0]).sort(), [
    'applied_at', 'expires_at', 'hold_id', 'reason_code',
  ]);
  assert.equal(lifecycleStatus.active_holds[0].hold_id, hold.hold_id);
  errorCode(() => db.createInterviewDeletionDryRun({ sessionId: activeSession.id }), 'LEGAL_HOLD_ACTIVE');
  db.releaseInterviewLegalHold({ holdId: hold.hold_id, reasonCode: 'synthetic_review_complete' });
  assert.deepEqual(db.getInterviewLifecycleStatus({ sessionId: activeSession.id }).active_holds, []);

  const activeManifest = db.createInterviewDeletionDryRun({ sessionId: activeSession.id });
  const activeDeleted = db.confirmInterviewDeletion({
    manifestId: activeManifest.manifest_id,
    confirmationToken: activeManifest.confirmation_token,
    reasonCode: 'retention_due',
  });
  assert.equal(activeDeleted.deleted_count, 2);
  const erasedTranscript = database.prepare('SELECT transcript, source_url, note FROM job_interview WHERE id = ?')
    .get(activeMaterial.interviewId);
  assert.deepEqual(erasedTranscript, { transcript: '', source_url: null, note: '[material deleted]' });
  assert.equal(database.prepare('SELECT 1 FROM interview_report_v1 WHERE id = ?').get(draftReportId), undefined);
  assert.equal(database.prepare('SELECT 1 FROM interview_report_fact_review WHERE report_id = ?').get(draftReportId), undefined);
  assert.equal(database.prepare('SELECT 1 FROM interview_report_action_request WHERE report_id = ?').get(draftReportId), undefined);
  const retainedLlmAudit = database.prepare(`
    SELECT report_id, request_hash, response_hash, prompt_hash
    FROM interview_llm_request_audit WHERE request_id = 'synthetic-f009-retention'
  `).get();
  assert.deepEqual(retainedLlmAudit, {
    report_id: null,
    request_hash: 'synthetic-request-hash',
    response_hash: 'synthetic-response-hash',
    prompt_hash: 'synthetic-prompt-hash',
  });
  errorCode(() => db.getF009InterviewMaterials({ sessionId: activeSession.id, materialIds: [activeMaterial.materialId] }), 'MATERIAL_DELETED');
  errorCode(() => db.getInterviewReportV1({ sessionId: activeSession.id }), 'MATERIAL_DELETED');
  errorCode(() => db.saveInterviewReportV1({
    sessionId: activeSession.id,
    actor: 'synthetic-test',
    requestId: 'must-not-resurrect',
    expectedVersion: 0,
    report: {},
  }), 'MATERIAL_DELETED');

  const tombstones = database.prepare(`
    SELECT * FROM interview_lifecycle_tombstone WHERE session_id = ? ORDER BY material_id
  `).all(String(activeSession.id));
  assert.equal(tombstones.length, 2);
  assert.ok(tombstones.every((row) => row.storage_kind === 'sqlite'));
  assert.ok(tombstones.every((row) => /^[1-9][0-9]*$/.test(row.db_entity_id)));
  const serializedTombstones = JSON.stringify(tombstones);
  assert.equal(serializedTombstones.includes('synthetic transcript'), false);
  assert.equal(serializedTombstones.includes('synthetic corrected sensitive value'), false);
  assert.equal(serializedTombstones.includes(MATERIAL_ROOT), false);
  assert.equal(serializedTombstones.includes(candidateId), false);

  const confirmedLifecycle = database.prepare('SELECT * FROM interview_lifecycle_material WHERE id = ?')
    .get(`db-report-v1-${confirmedReportId}`);
  assert.equal(confirmedLifecycle.artifact_class, 'confirmed_report');
  assert.equal(confirmedLifecycle.delete_after, null);
  const closed = db.closeInterviewLifecycle({ sessionId: closedSession.id, reasonCode: 'recruitment_closed' });
  assert.equal(database.prepare('SELECT delete_after FROM interview_lifecycle_material WHERE id = ?')
    .get(`db-report-v1-${confirmedReportId}`).delete_after, closed.confirmed_report_delete_after);
  database.prepare('UPDATE interview_lifecycle_material SET delete_after = ? WHERE id = ?')
    .run(oldAt, `db-report-v1-${confirmedReportId}`);
  const closedManifest = db.createInterviewDeletionDryRun({ sessionId: closedSession.id });
  const closedDeleted = db.confirmInterviewDeletion({
    manifestId: closedManifest.manifest_id,
    confirmationToken: closedManifest.confirmation_token,
    reasonCode: 'retention_due',
  });
  assert.equal(closedDeleted.deleted_count, 1);
  assert.equal(database.prepare('SELECT 1 FROM interview_report_v1 WHERE id = ?').get(confirmedReportId), undefined);
  errorCode(() => db.getInterviewReportV1({ sessionId: closedSession.id }), 'MATERIAL_DELETED');

  database.close();
  console.log(JSON.stringify({
    check: 'f010_db_retention',
    historical_backfill: true,
    sqlite_sensitive_deletion: true,
    legal_hold: true,
    anti_resurrection: true,
  }, null, 2));
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}
