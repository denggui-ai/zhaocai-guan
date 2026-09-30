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
process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED = '1';
process.env.HRBOSS_F018_ENABLED = '1';
process.env.HRBOSS_EXTERNAL_AI_ENABLED = '0';

const db = require("../../../src/db");

fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(dataRoot, 0o700);
db.openDb(process.env.BOSS_DB_PATH);

const EXPECTED = Object.freeze({
  job_name: '截图导入 · 合成OCR测试岗位',
  candidate_name: '合成简历候选人',
  retention_policy_version: 'synthetic-b10-retention-v1',
  assessment_date: '2026-07-29',
});

function sha256File(target) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(target, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function assertPrivateRegularFile(target, label) {
  const stat = fs.lstatSync(target);
  assert.equal(stat.isSymbolicLink(), false, `${label} must not be a symlink`);
  assert.equal(stat.isFile(), true, `${label} must be a regular file`);
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o077, 0, `${label} must remain private`);
  return stat;
}

function candidateProjection(candidate) {
  return {
    internal_id: candidate.internal_id,
    job_id: candidate.job_id,
    sabc: candidate.sabc,
    sabc_source: candidate.sabc_source,
    sabc_reason: candidate.sabc_reason,
    communication_code: candidate.communication_code,
    comm_status: candidate.comm_status,
    disposition_code: candidate.disposition_code,
    disposition_status: candidate.disposition_status,
    workflow_version: candidate.workflow_version,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
  };
}

function seedDatabase() {
  const job = db.upsertJob({
    encrypt_job_id: 'b10-synthetic-assessment-lifecycle-job',
    numeric_job_id: '9910260729001',
    name: EXPECTED.job_name,
    hr_owner: 'B-10 合成 HR',
    source_type: 'local_manual',
  });
  db.upsertCandidate({
    job_id: job.id,
    geek_id: 'b10-synthetic-s-tier-candidate',
    source: 'synthetic_b10',
    name: 'B-10 合成 S 候选人',
    degree: '硕士',
    school: 'B-10 合成大学',
    work_years: '8',
    sabc: 'S',
    sabc_source: '人工',
    sabc_reason: 'B-10 合成默认排序基准',
  });
  const selected = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'b10-synthetic-assessment-candidate',
    source: 'synthetic_b10',
    name: EXPECTED.candidate_name,
    degree: '本科',
    school: '合成测试大学',
    work_years: '5',
    sabc: 'B',
    sabc_source: '人工',
    sabc_reason: 'B-10 合成人工评级，不允许测评链路改写',
    geek_desc: '纯合成人选，仅用于测评导入、解析、绑定、撤销和面试交叉验证。',
  });
  db.upsertCandidate({
    job_id: job.id,
    geek_id: 'b10-synthetic-unrated-candidate',
    source: 'synthetic_b10',
    name: 'B-10 合成未评估候选人',
    degree: '本科',
    school: 'B-10 合成大学',
    work_years: '3',
  });
  const selectedBefore = db.getCandidate(selected.internal_id);
  const defaultOrderBefore = db.listCandidates(job.id).map((row) => row.internal_id);
  const seed = {
    job_id: job.id,
    candidate_id: selected.internal_id,
    job_name: EXPECTED.job_name,
    candidate_name: EXPECTED.candidate_name,
    candidate_projection_before: candidateProjection(selectedBefore),
    default_order_before: defaultOrderBefore,
  };
  fs.writeFileSync(path.join(syntheticRoot, 'seed.json'), `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(path.join(syntheticRoot, 'seed.json'), 0o600);
  return { ok: true, ...seed };
}

function verifyDatabase() {
  const seed = JSON.parse(fs.readFileSync(path.join(syntheticRoot, 'seed.json'), 'utf8'));
  const database = db.conn();
  const row = database.prepare(`
    SELECT
      binding.id AS binding_id,
      binding.state AS binding_state,
      binding.version AS binding_version,
      binding.reason_code AS binding_reason_code,
      binding.revoked_at,
      binding.candidate_id,
      binding.job_id,
      document.id AS document_id,
      document.content_sha256,
      document.storage_relpath,
      document.byte_size,
      document.page_count,
      document.mime_detected,
      document.security_state,
      document.report_type,
      document.assessment_date,
      document.analysis_status,
      document.analysis_schema_version,
      document.analysis_json,
      document.analysis_error_code,
      document.review_state,
      document.lifecycle_state,
      document.dispute_state,
      document.legal_hold_state,
      document.retention_policy_version,
      document.delete_after,
      document.version AS document_version,
      document.deleted_at
    FROM assessment_binding binding
    JOIN assessment_document document ON document.id = binding.document_id
    WHERE binding.candidate_id = ? AND binding.job_id = ?
  `).get(seed.candidate_id, seed.job_id);
  assert.ok(row, 'the synthetic assessment archive must persist');
  assert.deepEqual({
    binding_state: row.binding_state,
    binding_version: row.binding_version,
    binding_reason_code: row.binding_reason_code,
    candidate_id: row.candidate_id,
    job_id: row.job_id,
    security_state: row.security_state,
    report_type: row.report_type,
    assessment_date: row.assessment_date,
    analysis_status: row.analysis_status,
    analysis_schema_version: row.analysis_schema_version,
    analysis_error_code: row.analysis_error_code,
    review_state: row.review_state,
    lifecycle_state: row.lifecycle_state,
    dispute_state: row.dispute_state,
    legal_hold_state: row.legal_hold_state,
    retention_policy_version: row.retention_policy_version,
    deleted_at: row.deleted_at,
  }, {
    binding_state: 'revoked',
    binding_version: 3,
    binding_reason_code: 'manual_archive_revoked',
    candidate_id: seed.candidate_id,
    job_id: seed.job_id,
    security_state: 'accepted',
    report_type: 'career_potential',
    assessment_date: EXPECTED.assessment_date,
    analysis_status: 'ready',
    analysis_schema_version: 'assessment_report_analysis_v2',
    analysis_error_code: null,
    review_state: 'ready',
    lifecycle_state: 'active',
    dispute_state: 'none',
    legal_hold_state: 'none',
    retention_policy_version: EXPECTED.retention_policy_version,
    deleted_at: null,
  });
  assert.ok(row.revoked_at);
  assert.ok(row.delete_after);
  assert.ok(Number(row.document_version) >= 3);

  const analysis = JSON.parse(row.analysis_json);
  assert.equal(analysis.schema_version, 'assessment_report_analysis_v2');
  assert.equal(analysis.report_type, 'career_potential');
  assert.equal(analysis.subject_name, EXPECTED.candidate_name);
  assert.equal(analysis.assessed_job, EXPECTED.job_name);
  assert.equal(analysis.assessment_date, EXPECTED.assessment_date);
  assert.equal(analysis.validity, '合成样本');
  assert.deepEqual(analysis.strengths, [
    { name: '学习能力', level: 4 },
    { name: '协作能力', level: 3 },
    { name: '执行能力', level: 3 },
  ]);
  assert.equal(analysis.interview_questions.length, 3);
  assert.ok(analysis.interview_questions.some((item) => item.includes('学习能力')));

  const assessmentRoot = fs.realpathSync(path.join(dataRoot, 'assessment'));
  const pdfPath = path.resolve(assessmentRoot, row.storage_relpath);
  assert.equal(path.relative(assessmentRoot, pdfPath).startsWith('..'), false);
  const pdfStat = assertPrivateRegularFile(pdfPath, 'controlled assessment PDF');
  assert.equal(pdfStat.size, row.byte_size);
  assert.equal(sha256File(pdfPath), row.content_sha256);
  const pngPath = path.join(
    assessmentRoot,
    'previews',
    'sha256',
    row.content_sha256.slice(0, 2),
    row.content_sha256,
    'page-1.png',
  );
  const pngStat = assertPrivateRegularFile(pngPath, 'controlled assessment PNG');
  assert.ok(pngStat.size > 8);
  assert.equal(
    fs.readFileSync(pngPath).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    true,
  );
  assert.equal(row.page_count, 1);
  assert.equal(row.mime_detected, 'application/pdf');

  const events = database.prepare(`
    SELECT rowid AS insertion_order, id, object_type, object_id, event_type, request_id, reason_code,
           before_version, after_version, actor_id, actor_type, actor_source, actor_assurance
    FROM assessment_event
    WHERE object_id IN (?, ?)
    ORDER BY rowid
  `).all(row.document_id, row.binding_id);
  assert.deepEqual(events.map((event) => event.event_type), [
    'uploaded',
    'metadata_confirmed',
    'binding_confirmed',
    'viewed',
    'binding_revoked',
  ]);
  assert.equal(new Set(events.map((event) => event.request_id)).size, events.length);
  assert.ok(events.every((event) => event.actor_id === 'local-primary-operator'));
  assert.ok(events.every((event) => event.actor_type === 'local_os_subject'));
  assert.ok(events.every((event) => event.actor_source === 'server_local_instance'));
  assert.ok(events.every((event) => event.actor_assurance === 'local_instance_only'));
  const confirmEvent = events.find((event) => event.event_type === 'binding_confirmed');
  const viewEvent = events.find((event) => event.event_type === 'viewed');
  const revokeEvent = events.find((event) => event.event_type === 'binding_revoked');
  assert.deepEqual(
    { before: confirmEvent.before_version, after: confirmEvent.after_version },
    { before: 1, after: 2 },
  );
  assert.deepEqual(
    { before: viewEvent.before_version, after: viewEvent.after_version },
    { before: 2, after: 2 },
  );
  assert.deepEqual(
    { before: revokeEvent.before_version, after: revokeEvent.after_version },
    { before: 2, after: 3 },
  );
  const eventCount = events.length;
  assert.throws(
    () => database.prepare('UPDATE assessment_event SET reason_code = ? WHERE id = ?').run('tamper', events[0].id),
    /append-only/i,
  );
  assert.throws(
    () => database.prepare('DELETE FROM assessment_event WHERE id = ?').run(events[0].id),
    /append-only/i,
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM assessment_event WHERE object_id IN (?, ?)').get(row.document_id, row.binding_id).count,
    eventCount,
  );

  const activeCount = database.prepare(`
    SELECT COUNT(*) AS count
    FROM assessment_binding
    WHERE candidate_id = ? AND job_id = ? AND state = 'active'
  `).get(seed.candidate_id, seed.job_id).count;
  assert.equal(activeCount, 0);
  const aiCount = database.prepare(`
    SELECT COUNT(*) AS count FROM ai_review WHERE candidate_id = ? AND job_id = ?
  `).get(seed.candidate_id, seed.job_id).count;
  assert.equal(aiCount, 0, 'the local parser journey must not invoke or persist external AI analysis');

  const candidateAfter = candidateProjection(db.getCandidate(seed.candidate_id));
  const defaultOrderAfter = db.listCandidates(seed.job_id).map((candidate) => candidate.internal_id);
  assert.deepEqual(candidateAfter, seed.candidate_projection_before);
  assert.deepEqual(defaultOrderAfter, seed.default_order_before);

  return {
    ok: true,
    archive: {
      binding: {
        id: row.binding_id,
        state: row.binding_state,
        version: row.binding_version,
        revoked_at: row.revoked_at,
        active_binding_count: activeCount,
      },
      document: {
        id: row.document_id,
        version: row.document_version,
        lifecycle_state: row.lifecycle_state,
        review_state: row.review_state,
        retention_policy_version: row.retention_policy_version,
        delete_after: row.delete_after,
      },
      analysis: {
        schema_version: analysis.schema_version,
        report_type: analysis.report_type,
        subject_name: analysis.subject_name,
        assessed_job: analysis.assessed_job,
        assessment_date: analysis.assessment_date,
        strength_count: analysis.strengths.length,
        interview_question_count: analysis.interview_questions.length,
      },
      controlled_pdf: {
        exists: true,
        relative_path: row.storage_relpath,
        byte_size: pdfStat.size,
        sha256_matches: true,
      },
      controlled_png: {
        exists: true,
        page_count: row.page_count,
        byte_size: pngStat.size,
        png_signature: true,
      },
      events: events.map((event) => ({
        type: event.event_type,
        before_version: event.before_version,
        after_version: event.after_version,
        reason_code: event.reason_code,
      })),
      append_only_guards_verified: true,
    },
    candidate_projection_before: seed.candidate_projection_before,
    candidate_projection_after: candidateAfter,
    candidate_projection_unchanged: true,
    default_order_before: seed.default_order_before,
    default_order_after: defaultOrderAfter,
    default_order_unchanged: true,
    external_ai_records: aiCount,
  };
}

let result;
if (mode === 'seed') result = seedDatabase();
else if (mode === 'verify') result = verifyDatabase();
else throw new Error('runtime-db mode must be seed or verify');
db.conn().close();
process.stdout.write(`${JSON.stringify(result)}\n`);
