'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-withdrawal-semantics-'));
const dbPath = path.join(root, 'synthetic.db');
process.env.BOSS_DB_PATH = dbPath;
process.env.HRBOSS_DATA_DIR = path.join(root, 'data');

const db = require('./db');
const database = db.openDb(dbPath, { f018Enabled: false, assessmentEnabled: false });

try {
  const job1 = db.upsertJob({ encrypt_job_id: 'withdraw-job-1', name: '合成岗位一', created_at: '2026-01-01T00:00:00.000Z' });
  const job2 = db.upsertJob({ encrypt_job_id: 'withdraw-job-2', name: '合成岗位二', created_at: '2026-02-01T00:00:00.000Z' });

  const fallback = db.upsertCandidate({
    job_id: job1.id,
    geek_id: 'withdraw-fallback',
    source: 'synthetic_withdrawal',
    name: '兼容入口主动放弃',
    disposition_status: '待处理',
    disposition_code: 'under_review',
    created_at: '2026-01-02T00:00:00.000Z',
  });
  db.changeStatus(fallback.internal_id, 'disposition', 'candidate_withdrew', 'manual_hr_action', 'synthetic-hr', '主动放弃');
  let row = database.prepare('SELECT disposition_code, disposition_status FROM candidate WHERE internal_id = ?').get(fallback.internal_id);
  assert.deepEqual(row, { disposition_code: 'candidate_withdrew', disposition_status: '主动放弃' });

  const genuineDnc = db.upsertCandidate({
    job_id: job1.id,
    geek_id: 'genuine-dnc',
    source: 'synthetic_withdrawal',
    name: '真实不再联系',
    disposition_status: '待处理',
    disposition_code: 'under_review',
    created_at: '2026-01-03T00:00:00.000Z',
  });
  db.changeStatus(genuineDnc.internal_id, 'disposition', 'do_not_contact', 'manual_hr_action', 'synthetic-hr', '不再联系');
  row = database.prepare('SELECT disposition_code, disposition_status FROM candidate WHERE internal_id = ?').get(genuineDnc.internal_id);
  assert.deepEqual(row, { disposition_code: 'do_not_contact', disposition_status: '不再联系' });

  const legacyWithdraw = db.upsertCandidate({
    job_id: job1.id,
    geek_id: 'same-person-reentered',
    source: 'synthetic_withdrawal',
    name: '跨岗位重新进入',
    disposition_status: '主动放弃',
    disposition_code: 'do_not_contact',
    created_at: '2026-01-04T00:00:00.000Z',
  }, '2026-01-04T00:00:00.000Z');
  const reentered = db.upsertCandidate({
    job_id: job2.id,
    geek_id: 'same-person-reentered',
    source: 'synthetic_withdrawal',
    name: '跨岗位重新进入',
    disposition_status: '待处理',
    disposition_code: 'under_review',
    created_at: '2026-02-04T00:00:00.000Z',
  }, '2026-02-04T00:00:00.000Z');
  assert.ok(legacyWithdraw.internal_id && reentered.internal_id);

  const pool = db.listTalentPool({ jobId: job2.id });
  const fallbackTalent = pool.talents.find((item) => item.name === '兼容入口主动放弃');
  assert.equal(fallbackTalent.pool_status, 'cooling', '最近主动放弃应要求 HR 确认意愿，而不是立即推荐或永久禁触达');
  const reenteredTalent = pool.talents.find((item) => item.name === '跨岗位重新进入');
  assert.notEqual(reenteredTalent.pool_status, 'do_not_contact', '旧版主动放弃不得把新岗位重新进入全局标成不再联系');
  const dncTalent = pool.talents.find((item) => item.name === '真实不再联系');
  assert.equal(dncTalent.pool_status, 'do_not_contact', '真实不再联系仍必须保持全局不建议触达');

  console.log(JSON.stringify({
    ok: true,
    contract: 'withdrawal-semantics-v1',
    fallback_status: fallbackTalent.pool_status,
    reentered_status: reenteredTalent.pool_status,
    do_not_contact_status: dncTalent.pool_status,
  }));
} finally {
  database.close();
  fs.rmSync(root, { recursive: true, force: true });
}
