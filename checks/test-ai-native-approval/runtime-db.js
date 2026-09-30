'use strict';

const fs = require('node:fs');
const path = require('node:path');

const syntheticRoot = fs.realpathSync(path.resolve(process.argv[2] || ''));
const dataRoot = path.join(syntheticRoot, 'data');
process.env.BOSS_DB_PATH = path.join(dataRoot, 'recruiting.db');
process.env.HRBOSS_DATA_DIR = dataRoot;
process.env.HRBOSS_F018_ENABLED = '1';

const db = require('../../db');
const adapters = require('../../interview-source-adapters');

fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(dataRoot, 0o700);
db.openDb(process.env.BOSS_DB_PATH);

const job = db.upsertJob({
  encrypt_job_id: 'b2-synthetic-job',
  numeric_job_id: '920260729001',
  name: 'B-2 合成面试岗位',
  hr_owner: '合成 HR',
  source_type: 'local_manual',
});
const candidate = db.upsertCandidate({
  job_id: job.id,
  geek_id: 'b2-synthetic-candidate',
  source: 'synthetic_b2',
  name: 'B-2 合成候选人',
});
const ingested = adapters.ingestOnlineMinutes({
  jobId: job.id,
  sourceUrl: 'https://example.test/minutes/B2Synthetic',
  transcript: [
    '候选人说明完成过一次合成项目交付，并复盘了测试流程。',
    '仅供隐私掩码验证：电话 13812345678，邮箱 synthetic@example.test。',
    '以上全部为自动化测试生成的虚构材料。',
  ].join('\n'),
  candidateId: candidate.internal_id,
  round: 1,
  actor: 'local-primary-operator',
  reason: 'explicit_candidate_context',
  requestId: 'b2-synthetic-material-assignment',
});
const session = db.getInterviewSession(ingested.session.id);
const seed = {
  session_id: session.id,
  material_ids: session.materials.map((item) => item.id),
  candidate_id: candidate.internal_id,
  job_id: job.id,
};
fs.writeFileSync(path.join(syntheticRoot, 'seed.json'), `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
if (process.platform !== 'win32') fs.chmodSync(path.join(syntheticRoot, 'seed.json'), 0o600);
db.conn().close();
process.stdout.write(`${JSON.stringify({ ok: true, ...seed })}\n`);
