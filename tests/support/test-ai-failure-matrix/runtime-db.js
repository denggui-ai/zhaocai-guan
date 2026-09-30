'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const syntheticRoot = fs.realpathSync(path.resolve(process.argv[2] || ''));
const mode = String(process.argv[3] || 'seed');
const dataRoot = path.join(syntheticRoot, 'data');
process.env.BOSS_DB_PATH = path.join(dataRoot, 'recruiting.db');
process.env.HRBOSS_DATA_DIR = dataRoot;
process.env.HRBOSS_F018_ENABLED = '1';

const db = require("../../../src/db");
const adapters = require("../../../src/interview-source-adapters");

fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(dataRoot, 0o700);
db.openDb(process.env.BOSS_DB_PATH);

function seed() {
  const job = db.upsertJob({
    encrypt_job_id: 'b11-synthetic-job',
    numeric_job_id: '1120260729001',
    name: 'B-11 合成外部 AI 故障岗位',
    hr_owner: 'B-11 合成 HR',
    source_type: 'local_manual',
  });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'b11-synthetic-candidate',
    source: 'synthetic_b11',
    name: 'B-11 合成候选人',
  });
  const transcript = [
    '候选人说明完成过一次合成项目交付，并复盘了测试流程。',
    '仅供四类隐私掩码验证：电话 13812345678，邮箱 synthetic-b11@example.test。',
    '身份证 110101199001011234，微信: wx_b11privacy。',
    '以上全部为自动化测试生成的虚构材料。',
  ].join('\n');
  const ingested = adapters.ingestOnlineMinutes({
    jobId: job.id,
    sourceUrl: 'https://example.test/minutes/B11Synthetic',
    transcript,
    candidateId: candidate.internal_id,
    round: 1,
    actor: 'local-primary-operator',
    reason: 'explicit_candidate_context',
    requestId: 'b11-synthetic-material-assignment',
  });
  const session = db.getInterviewSession(ingested.session.id);
  const seedData = {
    session_id: session.id,
    material_ids: session.materials.map((item) => item.id),
    candidate_id: candidate.internal_id,
    job_id: job.id,
    source_text_length: transcript.length,
  };
  const seedPath = path.join(syntheticRoot, 'seed.json');
  fs.writeFileSync(seedPath, `${JSON.stringify(seedData, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(seedPath, 0o600);
  return { ok: true, mode, ...seedData };
}

function verify() {
  const seedData = JSON.parse(fs.readFileSync(path.join(syntheticRoot, 'seed.json'), 'utf8'));
  const audits = db.conn().prepare(`
    SELECT request_id, status, error_code, response_hash, returned_model, duration_ms
    FROM interview_llm_request_audit
    WHERE request_id LIKE 'b11-%'
    ORDER BY id
  `).all().map((row) => ({
    request_id: row.request_id,
    status: row.status,
    error_code: row.error_code,
    response_hash: row.response_hash,
    returned_model: row.returned_model,
    duration_ms: row.duration_ms,
  }));
  assert.deepEqual(audits.map((row) => row.request_id), [
    'b11-provider-500',
    'b11-provider-non-json',
    'b11-forged-evidence',
    'b11-timeout',
  ]);
  assert.deepEqual(audits.map((row) => [row.status, row.error_code]), [
    ['failed', 'PROVIDER_HTTP_ERROR'],
    ['failed', 'PROVIDER_INVALID_JSON'],
    ['invalid_response', 'EVIDENCE_UNIT_NOT_ALLOWED'],
    ['timeout', 'REQUEST_TIMEOUT'],
  ]);
  assert.equal(audits[0].response_hash, null);
  assert.equal(audits[1].response_hash, null);
  assert.match(audits[2].response_hash, /^[a-f0-9]{64}$/);
  assert.equal(audits[2].returned_model, 'gpt-b11-synthetic');
  assert.equal(audits[3].response_hash, null);
  assert.ok(audits[3].duration_ms >= 4_800);
  const report = db.getInterviewReportV1({ sessionId: seedData.session_id });
  assert.equal(report, null, 'failed or late Provider responses must never create a report draft');
  const auditColumns = db.conn().prepare('PRAGMA table_info(interview_llm_request_audit)').all().map((row) => row.name);
  assert.equal(auditColumns.some((name) => /api_key|material_text|body|content_json/.test(name)), false);
  return {
    ok: true,
    mode,
    audits,
    report_exists: report !== null,
    raw_material_or_key_columns_present: false,
  };
}

let output;
try {
  output = mode === 'verify' ? verify() : seed();
} finally {
  db.conn().close();
}
process.stdout.write(`${JSON.stringify(output)}\n`);
