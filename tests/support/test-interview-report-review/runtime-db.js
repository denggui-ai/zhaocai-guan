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

const db = require("../../../src/db");
const adapters = require("../../../src/interview-source-adapters");

fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(dataRoot, 0o700);
db.openDb(process.env.BOSS_DB_PATH);

const EXPECTED = Object.freeze({
  job_name: 'B-7 合成报告复核岗位',
  candidate_name: 'B-7 合成候选人',
});

function seedDatabase() {
  const job = db.upsertJob({
    encrypt_job_id: 'b7-synthetic-report-review-job',
    numeric_job_id: '970260729001',
    name: EXPECTED.job_name,
    hr_owner: 'B-7 合成 HR',
    source_type: 'local_manual',
  });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'b7-synthetic-report-review-candidate',
    source: 'synthetic_b7',
    name: EXPECTED.candidate_name,
    degree: '本科',
    school: 'B-7 合成大学',
    work_years: '5',
    geek_desc: '纯合成人选，仅用于人工结构化复盘和四类事实状态验证。',
  });
  const ingested = adapters.ingestOnlineMinutes({
    jobId: job.id,
    sourceUrl: 'https://example.test/minutes/B7Synthetic',
    transcript: [
      'B-7 合成面试材料：候选人说明目前在上海。',
      '候选人说明期望薪资为 25k，可在两周后到岗，项目团队为 8 人。',
      '以上全部为自动化测试生成的虚构材料。',
    ].join('\n'),
    candidateId: candidate.internal_id,
    round: 1,
    actor: 'local-primary-operator',
    reason: 'explicit_candidate_context',
    requestId: 'b7-synthetic-material-assignment',
  });
  const session = db.getInterviewSession(ingested.session.id);
  const seed = {
    job_id: job.id,
    candidate_id: candidate.internal_id,
    session_id: session.id,
    material_ids: session.materials.map((item) => item.id),
    job_name: EXPECTED.job_name,
    candidate_name: EXPECTED.candidate_name,
  };
  fs.writeFileSync(path.join(syntheticRoot, 'seed.json'), `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(path.join(syntheticRoot, 'seed.json'), 0o600);
  return { ok: true, ...seed };
}

function verifyDatabase() {
  const seed = JSON.parse(fs.readFileSync(path.join(syntheticRoot, 'seed.json'), 'utf8'));
  const reportResponse = db.getInterviewReportV1({ sessionId: seed.session_id });
  assert.ok(reportResponse?.report);
  const report = reportResponse;
  assert.equal(report.status, 'draft', 'formal confirmation belongs to B-9 and must remain separate');
  assert.equal(report.version, 2);
  assert.equal(report.report.schema_version, 'interview_report_v1');
  assert.match(report.report.summary.text, /B-7 合成人工复盘/);
  assert.equal(report.report.key_facts.length, 4);
  assert.deepEqual(report.source_snapshot.material_ids, seed.material_ids);

  const facts = db.listInterviewReportFactReviews({ sessionId: seed.session_id });
  assert.equal(facts.length, 4);
  assert.deepEqual(facts.map((item) => item.field_key), ['fact.01', 'fact.02', 'fact.03', 'fact.04']);
  assert.deepEqual(facts.map((item) => item.status), ['confirmed', 'corrected', 'unknown', 'rejected']);
  assert.equal(facts[0].corrected_value, null);
  assert.equal(facts[1].corrected_value, '26k（B-7 人工修正）');
  assert.equal(facts[2].corrected_value, null);
  assert.equal(facts[3].corrected_value, null);
  assert.ok(facts.every((item) => item.reviewed_by === 'local-primary-operator'));

  const requests = db.conn().prepare(`
    SELECT action, response_version, response_status, actor
    FROM interview_report_action_request
    WHERE session_id = ?
    ORDER BY response_version
  `).all(seed.session_id);
  assert.deepEqual(requests.map((item) => item.action), ['save', 'fact_review']);
  assert.deepEqual(requests.map((item) => item.response_version), [1, 2]);
  assert.ok(requests.every((item) => item.response_status === 'draft'));
  assert.ok(requests.every((item) => item.actor === 'local-primary-operator'));
  const formalTransitions = db.conn().prepare(`
    SELECT COUNT(*) AS n
    FROM interview_report_action_request
    WHERE session_id = ? AND action IN ('confirm', 'reject')
  `).get(seed.session_id).n;
  assert.equal(formalTransitions, 0);

  return {
    ok: true,
    synthetic_data_only: true,
    report: {
      id: report.id,
      status: report.status,
      version: report.version,
      source_material_ids: report.source_snapshot.material_ids,
      key_fact_count: report.report.key_facts.length,
    },
    facts: {
      count: facts.length,
      statuses: facts.map((item) => item.status),
      corrected_value: facts[1].corrected_value,
      actors: [...new Set(facts.map((item) => item.reviewed_by))],
    },
    requests,
    formal_transition_count: formalTransitions,
  };
}

try {
  const result = mode === 'verify' ? verifyDatabase() : seedDatabase();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  db.conn().close();
}
