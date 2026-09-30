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
  job_name: 'B-8 合成版本冲突岗位',
  candidate_name: 'B-8 合成候选人',
  initial_summary: 'B-8 初始人工报告 v1，用于制造真实 expectedVersion 冲突。',
  competing_summary: 'B-8 第二位合成 HR 已提交服务端报告 v2。',
  correction: '三周（B-8 本地草稿）',
});

function seedDatabase() {
  const job = db.upsertJob({
    encrypt_job_id: 'b8-synthetic-version-conflict-job',
    numeric_job_id: '980260729001',
    name: EXPECTED.job_name,
    hr_owner: 'B-8 合成 HR',
    source_type: 'local_manual',
  });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'b8-synthetic-version-conflict-candidate',
    source: 'synthetic_b8',
    name: EXPECTED.candidate_name,
    degree: '本科',
    school: 'B-8 合成大学',
    work_years: '5',
    geek_desc: '纯合成人选，仅用于 expectedVersion 冲突与恢复验证。',
  });
  const ingested = adapters.ingestOnlineMinutes({
    jobId: job.id,
    sourceUrl: 'https://example.test/minutes/B8Synthetic',
    transcript: [
      'B-8 合成面试材料：候选人表示三周后可以到岗。',
      '候选人说明拥有五年合成工作经验。',
      '以上全部为自动化测试生成的虚构材料。',
    ].join('\n'),
    candidateId: candidate.internal_id,
    round: 1,
    actor: 'local-primary-operator',
    reason: 'explicit_candidate_context',
    requestId: 'b8-synthetic-material-assignment',
  });
  const session = db.getInterviewSession(ingested.session.id);
  const materialIds = session.materials.map((item) => item.id);
  const report = db.saveStructuredManualInterviewReport({
    sessionId: session.id,
    materialIds,
    summary: EXPECTED.initial_summary,
    hardRequirements: [{ status: 'unknown', label: '到岗时间', text: '待人工复核' }],
    competencies: ['具备合成交付经验'],
    motivation: ['希望承担完整项目'],
    risks: ['到岗时间仍需确认'],
    contradictions: [],
    unknowns: ['实际到岗日期'],
    followupQuestions: ['请再次确认到岗时间'],
    keyFacts: [
      { label: '到岗时间', value: '两周' },
      { label: '工作年限', value: '五年' },
    ],
    expectedVersion: 0,
    requestId: 'b8-seed-report-v1',
    actor: 'b8-synthetic-seed-operator',
  });
  assert.equal(report.version, 1);
  const facts = db.listInterviewReportFactReviews({ sessionId: session.id });
  assert.deepEqual(facts.map((item) => item.field_key), ['fact.01', 'fact.02']);
  const seed = {
    job_id: job.id,
    candidate_id: candidate.internal_id,
    session_id: session.id,
    material_ids: materialIds,
    job_name: EXPECTED.job_name,
    candidate_name: EXPECTED.candidate_name,
    fact_keys: facts.map((item) => item.field_key),
    expected: EXPECTED,
  };
  fs.writeFileSync(path.join(syntheticRoot, 'seed.json'), `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(path.join(syntheticRoot, 'seed.json'), 0o600);
  return { ok: true, ...seed };
}

function verifyDatabase() {
  const seed = JSON.parse(fs.readFileSync(path.join(syntheticRoot, 'seed.json'), 'utf8'));
  const report = db.getInterviewReportV1({ sessionId: seed.session_id });
  assert.ok(report?.report);
  assert.equal(report.status, 'draft', 'formal confirmation belongs to B-9 and must remain separate');
  assert.equal(report.version, 3);
  assert.equal(report.report.schema_version, 'interview_report_v1');
  assert.equal(report.report.summary.text, EXPECTED.competing_summary);
  assert.equal(report.report.key_facts.length, 2);
  assert.deepEqual(report.source_snapshot.material_ids, seed.material_ids);

  const facts = db.listInterviewReportFactReviews({ sessionId: seed.session_id });
  assert.equal(facts.length, 2);
  assert.deepEqual(facts.map((item) => item.field_key), ['fact.01', 'fact.02']);
  assert.deepEqual(facts.map((item) => item.status), ['corrected', 'pending_review']);
  assert.equal(facts[0].corrected_value, EXPECTED.correction);
  assert.equal(facts[0].reviewed_by, 'local-primary-operator');
  assert.equal(facts[1].corrected_value, null);
  assert.equal(facts[1].reviewed_by, null);

  const requests = db.conn().prepare(`
    SELECT request_id, action, response_version, response_status, actor
    FROM interview_report_action_request
    WHERE session_id = ?
    ORDER BY response_version
  `).all(seed.session_id);
  assert.deepEqual(requests.map((item) => item.action), ['save', 'save', 'fact_review']);
  assert.deepEqual(requests.map((item) => item.response_version), [1, 2, 3]);
  assert.deepEqual(requests.map((item) => item.actor), [
    'b8-synthetic-seed-operator',
    'b8-synthetic-competing-operator',
    'local-primary-operator',
  ]);
  assert.ok(requests.every((item) => item.response_status === 'draft'));
  assert.equal(requests.some((item) => item.request_id === 'b8-stale-write-must-not-persist'), false);
  const formalTransitions = requests.filter((item) => ['confirm', 'reject'].includes(item.action)).length;
  assert.equal(formalTransitions, 0);

  return {
    ok: true,
    synthetic_data_only: true,
    report: {
      id: report.id,
      status: report.status,
      version: report.version,
      summary: report.report.summary.text,
      source_material_ids: report.source_snapshot.material_ids,
    },
    facts: {
      count: facts.length,
      statuses: facts.map((item) => item.status),
      corrected_value: facts[0].corrected_value,
      actors: facts.map((item) => item.reviewed_by),
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
