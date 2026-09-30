'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const syntheticRoot = fs.realpathSync(path.resolve(process.argv[2] || ''));
const mode = process.argv[3] || 'seed';
const dataRoot = path.join(syntheticRoot, 'data');
process.env.BOSS_DB_PATH = path.join(dataRoot, 'recruiting.db');
process.env.HRBOSS_DATA_DIR = dataRoot;
process.env.HRBOSS_F018_ENABLED = '1';

const db = require("../../../src/db");

fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(dataRoot, 0o700);
db.openDb(process.env.BOSS_DB_PATH);

function seedDatabase() {
  const job = db.upsertJob({
    encrypt_job_id: 'b3-synthetic-job',
    numeric_job_id: '930260729001',
    name: 'B-3 合成候选人旅程岗位',
    hr_owner: '合成 HR',
    source_type: 'local_manual',
  });
  const candidates = {};
  for (let index = 1; index <= 15; index += 1) {
    const suffix = String(index).padStart(2, '0');
    const at = new Date(Date.UTC(2026, 6, 29, 8, index, 0)).toISOString();
    const candidate = db.upsertCandidate({
      job_id: job.id,
      geek_id: `b3-synthetic-candidate-${suffix}`,
      source: 'synthetic_b3',
      name: `B-3 合成候选人 ${suffix}`,
      age: String(24 + index),
      degree: '本科',
      school: `合成大学 ${suffix}`,
      work_years: String(index),
      geek_desc: `纯合成候选人 ${suffix}，仅用于候选人分页与人工处置旅程。`,
      sabc: 'C',
      sabc_source: 'manual_fixture',
      communication_code: 'not_contacted',
      disposition_code: 'new',
    }, at);
    candidates[suffix] = candidate.internal_id;
  }
  const seed = {
    job_id: job.id,
    candidates,
    actions: {
      continue_process: candidates['01'],
      hold: candidates['02'],
      talent_pool: candidates['03'],
      reject: candidates['04'],
      withdraw: candidates['05'],
      do_not_contact_probe: candidates['06'],
    },
  };
  const seedPath = path.join(syntheticRoot, 'seed.json');
  fs.writeFileSync(seedPath, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(seedPath, 0o600);
  return { ok: true, ...seed };
}

function latestApplication(candidateId, jobId) {
  return db.conn().prepare(`
    SELECT id, status, disposition_action, version
    FROM application_episode
    WHERE candidate_id = ? AND job_id = ?
    ORDER BY episode_no DESC, id DESC LIMIT 1
  `).get(candidateId, jobId);
}

function verifyDatabase() {
  const seed = JSON.parse(fs.readFileSync(path.join(syntheticRoot, 'seed.json'), 'utf8'));
  const expected = {
    continue_process: {
      candidate: { disposition_code: 'under_review', disposition_status: '待处理' },
      application: { status: 'active', disposition_action: 'continue_process' },
    },
    hold: {
      candidate: { disposition_code: 'under_review', disposition_status: '暂缓' },
      application: { status: 'active', disposition_action: 'hold' },
    },
    talent_pool: {
      candidate: { disposition_code: 'talent_pool', disposition_status: '暂存人才库' },
      application: { status: 'closed', disposition_action: 'talent_pool' },
    },
    reject: {
      candidate: { disposition_code: 'rejected', disposition_status: '淘汰' },
      application: { status: 'closed', disposition_action: 'reject' },
    },
    withdraw: {
      candidate: { disposition_code: 'candidate_withdrew', disposition_status: '主动放弃' },
      application: { status: 'withdrawn', disposition_action: null },
    },
  };
  const records = {};
  for (const [action, expectedState] of Object.entries(expected)) {
    const candidateId = seed.actions[action];
    const candidate = db.getCandidate(candidateId);
    const application = latestApplication(candidateId, seed.job_id);
    assert.equal(candidate.disposition_code, expectedState.candidate.disposition_code, action);
    assert.equal(candidate.disposition_status, expectedState.candidate.disposition_status, action);
    assert.equal(application.status, expectedState.application.status, action);
    assert.equal(application.disposition_action, expectedState.application.disposition_action, action);
    const historyCount = db.conn().prepare(`
      SELECT COUNT(*) AS count FROM status_history
      WHERE candidate_id = ? AND layer = 'disposition' AND source = 'manual_hr_action'
    `).get(candidateId).count;
    assert.equal(historyCount, 1, `${action} must append one status history row`);
    records[action] = {
      candidate_id: candidateId,
      candidate: {
        disposition_code: candidate.disposition_code,
        disposition_status: candidate.disposition_status,
        workflow_version: candidate.workflow_version,
      },
      application,
      status_history_rows: historyCount,
    };
  }

  const dncCandidate = db.getCandidate(seed.actions.do_not_contact_probe);
  const dncApplication = latestApplication(seed.actions.do_not_contact_probe, seed.job_id);
  const dncHistoryCount = db.conn().prepare(`
    SELECT COUNT(*) AS count FROM status_history
    WHERE candidate_id = ? AND layer = 'disposition'
  `).get(seed.actions.do_not_contact_probe).count;
  assert.equal(dncCandidate.disposition_code, 'new');
  assert.equal(dncCandidate.disposition_status, '新入库');
  assert.equal(dncApplication.status, 'active');
  assert.equal(dncApplication.disposition_action, null);
  assert.equal(dncHistoryCount, 0);

  return {
    ok: true,
    synthetic_data_only: true,
    candidate_count: db.listCandidates(seed.job_id).length,
    committed_actions: Object.keys(expected),
    records,
    rejected_do_not_contact_probe: {
      candidate_id: dncCandidate.internal_id,
      disposition_code: dncCandidate.disposition_code,
      disposition_status: dncCandidate.disposition_status,
      application_status: dncApplication.status,
      application_disposition_action: dncApplication.disposition_action,
      status_history_rows: dncHistoryCount,
    },
  };
}

try {
  const result = mode === 'verify' ? verifyDatabase() : seedDatabase();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  db.conn().close();
}
