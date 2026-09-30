'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const syntheticRoot = fs.realpathSync(path.resolve(process.argv[2] || ''));
const mode = process.argv[3] || 'seed';
const dataRoot = path.join(syntheticRoot, 'data');
process.env.BOSS_DB_PATH = path.join(dataRoot, 'recruiting.db');
process.env.HRBOSS_DATA_DIR = dataRoot;
process.env.HRBOSS_EXTERNAL_AI_ENABLED = '0';
process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED = '0';
process.env.HRBOSS_F018_ENABLED = '0';

const db = require('../../db');
const adapters = require('../../interview-source-adapters');

fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(dataRoot, 0o700);
db.openDb(process.env.BOSS_DB_PATH);

const EXPECTED = Object.freeze({
  job_name: 'B-9 合成正式归档岗位',
  candidate_name: 'B-9 合成候选人',
  summary: 'B-9 合成人工报告：只用于正式确认、权威投影与处置分离验证。',
  corrected_value: '三周（B-9 HR 已电话核对）',
});

function tableCount(database, tableName, where, params) {
  const exists = database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(tableName);
  assert.ok(exists, `${tableName} schema must exist for separation verification`);
  return database.prepare(`SELECT COUNT(*) AS n FROM ${tableName} ${where || ''}`).get(...(params || [])).n;
}

function seedDatabase() {
  const job = db.upsertJob({
    encrypt_job_id: 'b9-synthetic-report-confirmation-job',
    numeric_job_id: '990260729001',
    name: EXPECTED.job_name,
    hr_owner: 'B-9 合成 HR',
    source_type: 'local_manual',
  });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'b9-synthetic-report-confirmation-candidate',
    source: 'synthetic_b9',
    name: EXPECTED.candidate_name,
    degree: '本科',
    school: 'B-9 合成大学',
    work_years: '6',
    geek_desc: '纯合成人选，仅用于面试报告正式归档与处置分离验证。',
  });
  const ingested = adapters.ingestOnlineMinutes({
    jobId: job.id,
    sourceUrl: 'https://example.test/minutes/B9Synthetic',
    transcript: [
      'B-9 合成面试材料：候选人表示三周后可以到岗。',
      '候选人暂未确认薪资期望，并说明曾独立负责一个合成项目。',
      '以上全部为自动化测试生成的虚构材料。',
    ].join('\n'),
    candidateId: candidate.internal_id,
    round: 1,
    actor: 'local-primary-operator',
    reason: 'explicit_candidate_context',
    requestId: 'b9-synthetic-material-assignment',
  });
  const session = db.getInterviewSession(ingested.session.id);
  const materialIds = session.materials.map((item) => item.id);
  const draft = db.saveStructuredManualInterviewReport({
    sessionId: session.id,
    materialIds,
    summary: EXPECTED.summary,
    hardRequirements: [{ status: 'unknown', label: '到岗周期', text: '待人工复核' }],
    competencies: ['能独立负责合成项目'],
    motivation: ['希望承担完整项目责任'],
    risks: ['薪资期望仍未知'],
    contradictions: [],
    unknowns: ['最终薪资期望'],
    followupQuestions: ['请确认最终薪资期望'],
    keyFacts: [
      { label: '到岗周期', value: '三周' },
      { label: '薪资期望', value: '待补充' },
      { label: '项目角色', value: '独立负责' },
    ],
    expectedVersion: 0,
    requestId: 'b9-seed-report-v1',
    actor: 'b9-synthetic-seed-operator',
  });
  assert.equal(draft.version, 1);
  const reviewed = db.reviewInterviewReportFacts({
    sessionId: session.id,
    items: [
      { field_key: 'fact.01', status: 'corrected', corrected_value: EXPECTED.corrected_value },
      { field_key: 'fact.02', status: 'unknown' },
      { field_key: 'fact.03', status: 'rejected' },
    ],
    expectedVersion: 1,
    requestId: 'b9-seed-fact-review-v2',
    actor: 'b9-synthetic-review-operator',
  });
  assert.equal(reviewed.report.version, 2);
  const before = db.getCandidate(candidate.internal_id);
  assert.equal(before.disposition_code, 'new');
  assert.equal(before.disposition_status, '新入库');
  const seed = {
    job_id: job.id,
    candidate_id: candidate.internal_id,
    session_id: session.id,
    material_ids: materialIds,
    job_name: EXPECTED.job_name,
    candidate_name: EXPECTED.candidate_name,
    expected: EXPECTED,
    candidate_before: {
      disposition_code: before.disposition_code,
      disposition_status: before.disposition_status,
      workflow_version: before.workflow_version,
    },
  };
  fs.writeFileSync(path.join(syntheticRoot, 'seed.json'), `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(path.join(syntheticRoot, 'seed.json'), 0o600);
  return { ok: true, ...seed };
}

function verifyDatabase() {
  const seed = JSON.parse(fs.readFileSync(path.join(syntheticRoot, 'seed.json'), 'utf8'));
  const separationBefore = JSON.parse(fs.readFileSync(path.join(syntheticRoot, 'separation-before.json'), 'utf8'));
  const database = db.conn();
  const report = db.getInterviewReportV1({ sessionId: seed.session_id });
  assert.ok(report?.report);
  assert.equal(report.status, 'confirmed');
  assert.equal(report.version, 3);
  assert.equal(report.read_only, true);
  assert.equal(report.report.key_facts.length, 1);
  assert.equal(report.report.key_facts[0].field_key, 'fact.01');
  assert.equal(report.report.key_facts[0].value, EXPECTED.corrected_value);
  assert.equal(report.source_report.key_facts.length, 3);
  assert.deepEqual(
    report.confirmed_projection.fact_reviews.map((item) => item.status),
    ['corrected', 'unknown', 'rejected'],
  );
  assert.equal(report.confirmed_projection.source_report_version, 2);
  assert.equal(report.confirmed_projection.created_by, 'local-primary-operator');
  assert.equal(report.confirmed_projection.legacy_computed, false);

  const storedProjection = database.prepare(`
    SELECT source_report_version, content_hash, created_by
    FROM interview_report_confirmed_projection
    WHERE report_id = ?
  `).get(report.id);
  assert.deepEqual(storedProjection, {
    source_report_version: 2,
    content_hash: report.confirmed_projection.content_hash,
    created_by: 'local-primary-operator',
  });

  const official = db.listOfficialInterviewReports({ sessionId: seed.session_id });
  assert.equal(official.length, 1);
  assert.equal(official[0].status, 'confirmed');
  assert.equal(official[0].read_only, true);
  assert.equal(official[0].report.key_facts.length, 1);
  assert.equal(official[0].report.key_facts[0].value, EXPECTED.corrected_value);

  const facts = db.listInterviewReportFactReviews({ sessionId: seed.session_id });
  assert.deepEqual(facts.map((item) => item.status), ['corrected', 'unknown', 'rejected']);
  assert.equal(facts[0].corrected_value, EXPECTED.corrected_value);

  const requests = database.prepare(`
    SELECT request_id, action, response_version, response_status, actor
    FROM interview_report_action_request
    WHERE session_id = ?
    ORDER BY response_version
  `).all(seed.session_id);
  assert.deepEqual(requests.map((item) => item.action), ['save', 'fact_review', 'confirm']);
  assert.deepEqual(requests.map((item) => item.response_version), [1, 2, 3]);
  assert.deepEqual(requests.map((item) => item.response_status), ['draft', 'draft', 'confirmed']);
  assert.equal(requests[2].actor, 'local-primary-operator');
  assert.equal(
    requests.some((item) => item.request_id === 'b9-readonly-bypass-must-not-persist'),
    false,
    'rejected post-confirm write must not create an action row',
  );

  const session = db.getInterviewSession(seed.session_id);
  assert.equal(session.status, 'confirmed');
  const candidate = db.getCandidate(seed.candidate_id);
  assert.deepEqual({
    disposition_code: candidate.disposition_code,
    disposition_status: candidate.disposition_status,
    workflow_version: candidate.workflow_version,
  }, separationBefore.candidate);

  const applicationCount = tableCount(
    database,
    'application_episode',
    'WHERE candidate_id = ? AND job_id = ?',
    [seed.candidate_id, seed.job_id],
  );
  const finalReviewCount = tableCount(
    database,
    'final_review',
    `WHERE application_id IN (
      SELECT id FROM application_episode WHERE candidate_id = ? AND job_id = ?
    )`,
    [seed.candidate_id, seed.job_id],
  );
  const finalDispositionCount = tableCount(
    database,
    'final_disposition',
    `WHERE application_id IN (
      SELECT id FROM application_episode WHERE candidate_id = ? AND job_id = ?
    )`,
    [seed.candidate_id, seed.job_id],
  );
  assert.deepEqual({
    application_episode_count: applicationCount,
    final_review_count: finalReviewCount,
    final_disposition_count: finalDispositionCount,
  }, separationBefore.counts);

  return {
    ok: true,
    synthetic_data_only: true,
    report: {
      id: report.id,
      status: report.status,
      version: report.version,
      read_only: report.read_only,
      source_report_fact_count: report.source_report.key_facts.length,
      authoritative_fact_count: report.report.key_facts.length,
      authoritative_corrected_value: report.report.key_facts[0].value,
      projection_source_version: report.confirmed_projection.source_report_version,
      projection_hash: report.confirmed_projection.content_hash,
      projection_review_statuses: report.confirmed_projection.fact_reviews.map((item) => item.status),
    },
    official_report_count: official.length,
    session_status: session.status,
    candidate_before: separationBefore.candidate,
    candidate_after: {
      disposition_code: candidate.disposition_code,
      disposition_status: candidate.disposition_status,
      workflow_version: candidate.workflow_version,
    },
    final_disposition_separation: {
      before: separationBefore.counts,
      after: {
        application_episode_count: applicationCount,
        final_review_count: finalReviewCount,
        final_disposition_count: finalDispositionCount,
      },
    },
    requests,
  };
}

try {
  const result = mode === 'verify' ? verifyDatabase() : seedDatabase();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  db.conn().close();
}
