'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const syntheticRoot = fs.realpathSync(path.resolve(process.argv[2] || ''));
const mode = process.argv[3] || 'seed';
const dataRoot = path.join(syntheticRoot, 'data');
process.env.BOSS_DB_PATH = path.join(dataRoot, 'recruiting.db');
process.env.HRBOSS_DATA_DIR = dataRoot;
process.env.HRBOSS_F018_ENABLED = '1';
process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED = '1';
process.env.HRBOSS_ASSESSMENT_RETENTION_POLICY_VERSION = 'synthetic-b12-retention-v1';
process.env.HRBOSS_ASSESSMENT_RETENTION_DAYS = '30';
process.env.HRBOSS_ASSESSMENT_BACKUP_POLICY_VERSION = 'synthetic-b12-backup-v1';
process.env.HRBOSS_ASSESSMENT_BACKUP_RETENTION_DAYS = '30';
process.env.HRBOSS_EXTERNAL_AI_ENABLED = '0';

const db = require('../../db');

fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(dataRoot, 0o700);
db.openDb(process.env.BOSS_DB_PATH);

const EXPECTED = Object.freeze({
  candidate_name: 'B-12 合成终评候选人',
  formal_job_name: 'B-12 合成正式招聘岗位',
  fixture_job_name: 'B-12 合成人才草稿样例岗位',
  assessment_document_id: 'DOC-B12-CONFIRMED-ASSESSMENT',
  assessment_content_hash: '53d236dbb4ca735b360d9a723feacd0e6c2db4ad46d8563512488d8e8404345f',
  report_content_hash: '34'.repeat(32),
  profile_content_hash: '56'.repeat(32),
  final_summary: 'B-12 合成人工终评：岗位画像、面试报告与测评材料相互印证，继续由 HR 人工推进。',
});

function candidateProjection(candidate) {
  return {
    sabc: candidate.sabc,
    sabc_source: candidate.sabc_source,
    sabc_reason: candidate.sabc_reason,
    communication_code: candidate.communication_code,
    comm_status: candidate.comm_status,
    disposition_code: candidate.disposition_code,
    disposition_status: candidate.disposition_status,
    workflow_version: candidate.workflow_version,
  };
}

function writePrivate(target, bytes) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
}

function insertAssessmentEvent(database, values) {
  database.prepare(`
    INSERT INTO assessment_event (
      id, object_type, object_id, event_type,
      actor_id, actor_type, actor_source, actor_session_id, actor_assurance,
      request_id, reason_code, before_version, after_version, policy_version, created_at
    ) VALUES (
      @id, @object_type, @object_id, @event_type,
      'local-primary-operator', 'local_os_subject', 'server_local_instance',
      'synthetic-b12-seed', 'local_instance_only',
      @request_id, @reason_code, @before_version, @after_version,
      'synthetic-b12-retention-v1', @created_at
    )
  `).run(values);
}

function seedDatabase() {
  const formalJob = db.upsertJob({
    encrypt_job_id: 'b12-synthetic-formal-job',
    numeric_job_id: '9910260729012',
    name: EXPECTED.formal_job_name,
    hr_owner: 'B-12 合成 HR',
    source_type: 'local_manual',
  });
  const fixtureJob = db.upsertJob({
    encrypt_job_id: 'b12-synthetic-fixture-job',
    numeric_job_id: '9910260729112',
    name: EXPECTED.fixture_job_name,
    hr_owner: 'B-12 合成 HR',
    is_fixture: true,
    source_type: 'fixture',
  });
  const selected = db.upsertCandidate({
    job_id: formalJob.id,
    geek_id: 'b12-synthetic-final-review-candidate',
    source: 'synthetic_b12',
    name: EXPECTED.candidate_name,
    degree: '本科',
    school: 'B-12 合成大学',
    work_years: '6',
    sabc: 'A',
    sabc_source: '人工',
    sabc_reason: 'B-12 合成人工评级，不允许终评或 Offer 自动改写',
    geek_desc: '纯合成人选，仅用于人才再触达门禁、结构化终评和 Offer 前置条件验证。',
  });
  const candidateId = selected.internal_id;
  const database = db.conn();
  const at = '2026-07-29T08:12:00.000Z';

  database.prepare(`
    INSERT INTO resume_online (candidate_id, sections_json, is_paywalled, raw_json, fetched_at)
    VALUES (?, ?, 0, NULL, ?)
  `).run(candidateId, JSON.stringify({
    basic: [{ description: 'B-12 合成在线简历事实' }],
    work: [{ company: 'B-12 合成公司', title: '合成岗位经历' }],
  }), at);
  database.prepare(`
    INSERT INTO contact (
      candidate_id, type, value_encrypted, value_hash, source, confidence, created_at
    ) VALUES (?, 'mobile', 'synthetic-encrypted-contact', ?, 'synthetic_b12', 'high', ?)
  `).run(candidateId, crypto.createHash('sha256').update('b12-synthetic-contact').digest('hex'), at);

  const jdInfo = database.prepare(`
    INSERT INTO job_jd_version (
      job_id, version, status, source, jd_text, content_hash,
      created_by, created_at, activated_by, activated_at, superseded_at
    ) VALUES (?, 1, 'active', 'manual', ?, ?, 'local-primary-operator', ?,
              'local-primary-operator', ?, NULL)
  `).run(
    formalJob.id,
    'B-12 合成 JD：验证终评材料来源与 Offer 前置门禁。',
    '78'.repeat(32),
    at,
    at,
  );
  const profileInfo = database.prepare(`
    INSERT INTO job_profile_version (
      job_id, jd_version_id, version, status, config_json, content_hash,
      source_kind, source_ref_json, created_by, created_at,
      confirmed_by, confirmed_at, superseded_at
    ) VALUES (?, ?, 1, 'confirmed', ?, ?, 'manual', '{}',
              'local-primary-operator', ?, 'local-primary-operator', ?, NULL)
  `).run(
    formalJob.id,
    Number(jdInfo.lastInsertRowid),
    JSON.stringify({
      assessment_policy: 'required',
      must_haves: ['合成人工核验能力'],
      nice_to_haves: ['合成跨材料复核能力'],
    }),
    EXPECTED.profile_content_hash,
    at,
    at,
  );

  const session = db.createInterviewSession({
    candidate_id: candidateId,
    job_id: formalJob.id,
    round: 1,
    mode: 'offline',
    status: 'pending_review',
    created_at: at,
  });
  const reportJson = JSON.stringify({
    schema_version: 'interview_report_v1',
    summary: 'B-12 合成人工确认面试报告',
    key_facts: [{
      id: 'b12-fact-1',
      category: 'experience',
      claim: '候选人提供了合成项目复盘。',
      evidence_refs: [],
    }],
  });
  const reportInfo = database.prepare(`
    INSERT INTO interview_report_v1 (
      session_id, schema_version, status, report_json, content_hash, version,
      created_by, updated_by, confirmed_by, confirmed_at,
      rejected_by, rejected_at, created_at, updated_at
    ) VALUES (
      ?, 'interview_report_v1', 'confirmed', ?, ?, 3,
      'local-primary-operator', 'local-primary-operator',
      'local-primary-operator', ?, NULL, NULL, ?, ?
    )
  `).run(session.id, reportJson, EXPECTED.report_content_hash, at, at, at);

  const assessmentRelpath = `accepted/${EXPECTED.assessment_content_hash}.pdf`;
  const assessmentPath = path.join(dataRoot, 'assessment', assessmentRelpath);
  const assessmentBytes = Buffer.from('%PDF-1.4\n%B-12 synthetic controlled assessment fixture\n%%EOF\n', 'utf8');
  writePrivate(assessmentPath, assessmentBytes);
  const previewPath = path.join(
    dataRoot,
    'assessment',
    'previews',
    'sha256',
    EXPECTED.assessment_content_hash.slice(0, 2),
    EXPECTED.assessment_content_hash,
    'page-1.png',
  );
  writePrivate(
    previewPath,
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'),
  );
  database.prepare(`
    INSERT INTO assessment_document (
      id, content_sha256, storage_relpath, byte_size, page_count, mime_detected,
      security_state, report_type, assessment_date,
      analysis_status, analysis_schema_version, analysis_json, analysis_error_code,
      review_state, dispute_state, lifecycle_state,
      retention_policy_version, delete_after, legal_hold_state,
      supersedes_document_id, created_by, version, created_at, updated_at, deleted_at
    ) VALUES (
      ?, ?, ?, ?, 1, 'application/pdf',
      'accepted', 'career_potential', '2026-07-29',
      'ready', 'synthetic-b12-v1', '{}', NULL,
      'ready', 'none', 'active',
      'synthetic-b12-retention-v1', '2026-08-28T08:12:00.000Z', 'none',
      NULL, 'local-primary-operator', 2, ?, ?, NULL
    )
  `).run(
    EXPECTED.assessment_document_id,
    EXPECTED.assessment_content_hash,
    assessmentRelpath,
    assessmentBytes.length,
    at,
    at,
  );
  database.prepare(`
    INSERT INTO assessment_binding (
      id, document_id, candidate_id, job_id, scope, state, conflict_state,
      identity_basis, actor_id, reason_code, request_id, version,
      created_at, updated_at, revoked_at
    ) VALUES (
      'BIND-B12-CONFIRMED-ASSESSMENT', ?, ?, ?, 'candidate_job_archive',
      'active', 'none', 'current_candidate_context', 'local-primary-operator',
      'synthetic_confirmed', 'REQ-B12-BIND-CONFIRMED', 2, ?, ?, NULL
    )
  `).run(EXPECTED.assessment_document_id, candidateId, formalJob.id, at, at);
  insertAssessmentEvent(database, {
    id: 'EVT-B12-ASSESSMENT-UPLOADED',
    object_type: 'document',
    object_id: EXPECTED.assessment_document_id,
    event_type: 'uploaded',
    request_id: 'REQ-B12-ASSESSMENT-UPLOADED',
    reason_code: 'synthetic_uploaded',
    before_version: null,
    after_version: 1,
    created_at: at,
  });
  insertAssessmentEvent(database, {
    id: 'EVT-B12-ASSESSMENT-METADATA',
    object_type: 'document',
    object_id: EXPECTED.assessment_document_id,
    event_type: 'metadata_confirmed',
    request_id: 'REQ-B12-ASSESSMENT-METADATA',
    reason_code: 'synthetic_metadata_confirmed',
    before_version: 1,
    after_version: 2,
    created_at: at,
  });
  insertAssessmentEvent(database, {
    id: 'EVT-B12-ASSESSMENT-BINDING',
    object_type: 'binding',
    object_id: 'BIND-B12-CONFIRMED-ASSESSMENT',
    event_type: 'binding_confirmed',
    request_id: 'REQ-B12-ASSESSMENT-BINDING',
    reason_code: 'synthetic_binding_confirmed',
    before_version: 1,
    after_version: 2,
    created_at: at,
  });

  const application = database.prepare(`
    SELECT * FROM application_episode
    WHERE candidate_id = ? AND job_id = ? AND status = 'active'
  `).get(candidateId, formalJob.id);
  assert.ok(application, 'candidate ingest must create an active Application Episode');
  const before = candidateProjection(db.getCandidate(candidateId));
  const seed = {
    formal_job_id: formalJob.id,
    fixture_job_id: fixtureJob.id,
    candidate_id: candidateId,
    application_id: application.id,
    job_profile_version_id: Number(profileInfo.lastInsertRowid),
    interview_report_id: Number(reportInfo.lastInsertRowid),
    assessment_document_id: EXPECTED.assessment_document_id,
    assessment_storage_path: assessmentPath,
    candidate_projection_before: before,
    initial_counts: {
      final_review: database.prepare('SELECT COUNT(*) AS count FROM final_review').get().count,
      final_disposition: database.prepare('SELECT COUNT(*) AS count FROM final_disposition').get().count,
      offer: database.prepare('SELECT COUNT(*) AS count FROM candidate_offer_status').get().count,
      offer_event: database.prepare('SELECT COUNT(*) AS count FROM candidate_offer_event').get().count,
      journey_request: database.prepare('SELECT COUNT(*) AS count FROM hr_journey_request').get().count,
    },
  };
  writePrivate(path.join(syntheticRoot, 'seed.json'), `${JSON.stringify(seed, null, 2)}\n`);
  return { ok: true, ...seed };
}

function verifyDatabase() {
  const seed = JSON.parse(fs.readFileSync(path.join(syntheticRoot, 'seed.json'), 'utf8'));
  const database = db.conn();
  const candidate = db.getCandidate(seed.candidate_id);
  const afterProjection = candidateProjection(candidate);
  assert.deepEqual({
    sabc: afterProjection.sabc,
    sabc_source: afterProjection.sabc_source,
    sabc_reason: afterProjection.sabc_reason,
    communication_code: afterProjection.communication_code,
    comm_status: afterProjection.comm_status,
  }, {
    sabc: seed.candidate_projection_before.sabc,
    sabc_source: seed.candidate_projection_before.sabc_source,
    sabc_reason: seed.candidate_projection_before.sabc_reason,
    communication_code: seed.candidate_projection_before.communication_code,
    comm_status: seed.candidate_projection_before.comm_status,
  }, 'terminal review and Offer must not rewrite candidate rating or communication state');
  assert.equal(seed.candidate_projection_before.disposition_code, 'new');
  assert.equal(afterProjection.disposition_code, 'under_review');
  assert.equal(afterProjection.disposition_status, '待处理');
  assert.equal(afterProjection.workflow_version, seed.candidate_projection_before.workflow_version + 1);
  assert.notEqual(afterProjection.disposition_code, 'hired');

  const application = database.prepare('SELECT * FROM application_episode WHERE id = ?').get(seed.application_id);
  assert.equal(application.status, 'active');
  assert.equal(application.disposition_action, 'continue_process');
  assert.equal(application.version, 2);
  assert.equal(application.ended_at, null);

  const review = database.prepare('SELECT * FROM final_review WHERE application_id = ?').get(seed.application_id);
  assert.ok(review);
  assert.equal(review.status, 'confirmed');
  assert.equal(review.version, 2);
  assert.equal(review.job_profile_version_id, seed.job_profile_version_id);
  assert.equal(review.interview_report_id, seed.interview_report_id);
  assert.equal(review.interview_report_ref_id, seed.interview_report_id);
  assert.equal(review.interview_report_content_hash, EXPECTED.report_content_hash);
  assert.equal(review.interview_report_version, 3);
  assert.ok(review.confirmed_at);
  const reviewJson = JSON.parse(review.review_json);
  assert.equal(reviewJson.decision_summary, EXPECTED.final_summary);
  assert.deepEqual(reviewJson.evidence_refs, [
    { source_type: 'job_profile', source_id: seed.job_profile_version_id },
    { source_type: 'interview_report', source_id: seed.interview_report_id },
    { source_type: 'assessment_document', source_id: seed.assessment_document_id },
  ]);

  const disposition = database.prepare('SELECT * FROM final_disposition WHERE application_id = ?').get(seed.application_id);
  assert.ok(disposition);
  assert.equal(disposition.final_review_id, review.id);
  assert.equal(disposition.action, 'continue_process');
  assert.equal(disposition.actor_id, 'local-primary-operator');

  const applicationEvents = database.prepare(`
    SELECT event_type, object_type, before_version, after_version, actor_id
    FROM application_event WHERE application_id = ? ORDER BY id
  `).all(seed.application_id);
  assert.deepEqual(applicationEvents.map((event) => event.event_type), [
    'opened',
    'review_drafted',
    'review_confirmed',
    'disposition_recorded',
  ]);
  assert.equal(applicationEvents[0].actor_id, 'f018-candidate-ingest');
  assert.ok(applicationEvents.slice(1).every((event) => event.actor_id === 'local-primary-operator'));
  const dispositionHistory = database.prepare(`
    SELECT layer, source, who, from_code, to_code
    FROM status_history
    WHERE candidate_id = ? AND source = 'f018_final_disposition'
    ORDER BY id
  `).all(seed.candidate_id);
  assert.deepEqual(dispositionHistory, [{
    layer: 'disposition',
    source: 'f018_final_disposition',
    who: 'local-primary-operator',
    from_code: 'new',
    to_code: 'under_review',
  }]);

  const offer = database.prepare('SELECT * FROM candidate_offer_status WHERE application_id = ?').get(seed.application_id);
  assert.ok(offer);
  assert.equal(offer.candidate_id, seed.candidate_id);
  assert.equal(offer.job_id, seed.formal_job_id);
  assert.equal(offer.status, 'ready_to_offer');
  assert.equal(offer.version, 1);
  assert.equal(offer.actor_id, 'local-primary-operator');
  assert.equal(offer.expected_start_date, null);
  const offerEvents = database.prepare('SELECT * FROM candidate_offer_event WHERE application_id = ? ORDER BY id').all(seed.application_id);
  assert.equal(offerEvents.length, 1);
  assert.equal(offerEvents[0].from_status, null);
  assert.equal(offerEvents[0].to_status, 'ready_to_offer');
  assert.equal(offerEvents[0].offer_version, 1);
  assert.equal(offerEvents[0].request_id, offer.request_id);
  const offerRequests = database.prepare(`
    SELECT * FROM hr_journey_request
    WHERE candidate_id = ? AND job_id = ? AND operation_type = 'set_candidate_offer_status'
  `).all(seed.candidate_id, seed.formal_job_id);
  assert.equal(offerRequests.length, 1, 'rejected Offer bypasses must leave no idempotency success record');
  assert.equal(offerRequests[0].application_id, seed.application_id);

  const assessment = database.prepare(`
    SELECT document.*, binding.state AS binding_state, binding.version AS binding_version
    FROM assessment_document document
    JOIN assessment_binding binding ON binding.document_id = document.id
    WHERE document.id = ?
  `).get(seed.assessment_document_id);
  assert.equal(assessment.lifecycle_state, 'active');
  assert.equal(assessment.review_state, 'ready');
  assert.equal(assessment.binding_state, 'active');
  assert.equal(assessment.binding_version, 2);
  assert.equal(fs.existsSync(seed.assessment_storage_path), true);

  const talentPool = db.listTalentPool({ jobId: seed.formal_job_id });
  const formalTalent = talentPool.talents.find((item) => item.primary_candidate_id === seed.candidate_id);
  assert.ok(formalTalent);
  assert.equal(formalTalent.contact_state.has_valid_contact_method, true);
  assert.equal(formalTalent.contact_state.consent_confirmed, false);
  assert.equal(formalTalent.contact_state.opt_out_status_confirmed, false);
  assert.equal(formalTalent.contact_state.needs_consent_check, true);
  assert.equal(formalTalent.contact_state.contact_ready, false);

  const unexpectedAiRows = [
    'ai_review',
    'assessment_ai_analysis',
    'interview_llm_request_audit',
  ].map((table) => {
    const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    return exists
      ? Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count)
      : 0;
  });
  assert.deepEqual(unexpectedAiRows, [0, 0, 0]);

  const result = {
    ok: true,
    candidate_rating_and_communication_unchanged: true,
    candidate_disposition_projection: {
      from: seed.candidate_projection_before.disposition_code,
      to: afterProjection.disposition_code,
      workflow_version_before: seed.candidate_projection_before.workflow_version,
      workflow_version_after: afterProjection.workflow_version,
      hired_written: false,
    },
    final_review: {
      id: review.id,
      version: review.version,
      status: review.status,
      evidence_refs: reviewJson.evidence_refs,
      interview_report_snapshot: {
        id: review.interview_report_ref_id,
        hash: review.interview_report_content_hash,
        version: review.interview_report_version,
      },
      disposition: disposition.action,
      application_version: application.version,
      events: applicationEvents.map((event) => event.event_type),
    },
    offer: {
      id: offer.id,
      status: offer.status,
      version: offer.version,
      event_count: offerEvents.length,
      successful_request_count: offerRequests.length,
    },
    formal_talent_contact_state: formalTalent.contact_state,
    assessment_preserved: true,
    external_ai_rows: 0,
  };
  console.log(JSON.stringify(result));
  return result;
}

try {
  if (mode === 'seed') console.log(JSON.stringify(seedDatabase()));
  else if (mode === 'verify') verifyDatabase();
  else throw new Error(`unsupported mode: ${mode}`);
} finally {
  try { db.conn().close(); } catch {}
}
