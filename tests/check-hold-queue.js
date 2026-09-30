'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-hold-queue-'));
process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const db = require("../src/db");
const { createHrManualDispositionService } = require("../src/hr-manual-disposition-service");

let database;
try {
  const enabledPath = path.join(ROOT, 'enabled.db');
  database = db.openDb(enabledPath, { f018Enabled: true, assessmentEnabled: false });
  const job = db.upsertJob({
    encrypt_job_id: 'hold-queue-job',
    numeric_job_id: '202607140003',
    name: 'HOLD-QUEUE 纯合成岗位',
  });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'hold-queue-candidate',
    source: 'synthetic_hold_queue',
    name: 'HOLD-QUEUE 纯合成候选人',
  });
  database.prepare(`
    UPDATE candidate
    SET sabc = 'A', communication_code = 'not_contacted', comm_status = '未打招呼',
        disposition_code = 'under_review', disposition_status = '待处理'
    WHERE internal_id = ?
  `).run(candidate.internal_id);

  const service = createHrManualDispositionService({
    database,
    actorContext: { actor_id: 'synthetic-hr' },
    now: (() => {
      let second = 0;
      return () => `2026-07-14T08:00:${String(++second).padStart(2, '0')}.000Z`;
    })(),
  });

  service.apply({
    candidate_id: candidate.internal_id,
    job_id: job.id,
    action: 'hold',
    reason: 'synthetic_hold',
    request_id: 'REQ-HOLD-QUEUE-HOLD',
  });

  let listed = db.listCandidates(job.id);
  let row = listed.find((item) => item.internal_id === candidate.internal_id);
  assert.equal(row.application_status, 'active');
  assert.equal(row.application_disposition_action, 'hold');
  assert.equal(row.application_episode_no, 1);
  assert.equal(row.workflow_status, 'contact_pending');
  assert.equal(row.disposition_status, '暂缓');

  let workbench = db.getJobWorkbench(job.id);
  assert.equal(
    workbench.todos.some((todo) => todo.candidate_id === candidate.internal_id && todo.code === 'contact_required'),
    false,
    'a held candidate must not remain in candidate progression todos',
  );

  service.apply({
    candidate_id: candidate.internal_id,
    job_id: job.id,
    action: 'continue_process',
    reason: 'synthetic_continue',
    request_id: 'REQ-HOLD-QUEUE-CONTINUE',
  });
  listed = db.listCandidates(job.id);
  row = listed.find((item) => item.internal_id === candidate.internal_id);
  assert.equal(row.application_disposition_action, 'continue_process');
  assert.equal(row.disposition_status, '待处理');
  workbench = db.getJobWorkbench(job.id);
  assert.equal(
    workbench.todos.some((todo) => todo.candidate_id === candidate.internal_id && todo.code === 'contact_required'),
    true,
    'continuing a held candidate must restore the deterministic progression todo',
  );

  service.apply({
    candidate_id: candidate.internal_id,
    job_id: job.id,
    action: 'hired',
    reason: 'synthetic_hired',
    request_id: 'REQ-HOLD-QUEUE-HIRED',
  });
  assert.deepEqual(
    database.prepare('SELECT disposition_code, disposition_status FROM candidate WHERE internal_id = ?').get(candidate.internal_id),
    { disposition_code: 'hired', disposition_status: '录用' },
  );

  const candidateListSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/CandidateList.jsx'), 'utf8');
  assert.match(candidateListSource, /\{ key: 'hold', label: '暂缓' \}/);
  assert.match(candidateListSource, /application_disposition_action === 'hold'/);
  assert.match(candidateListSource, /!\['archived', 'hold'\]\.includes\(workQueueKey\(c\)\)/);
  assert.match(candidateListSource, /等待 HR 重新推进或转入明确终态/);

  database.close();
  database = null;

  const disabledPath = path.join(ROOT, 'disabled.db');
  database = db.openDb(disabledPath, { f018Enabled: false, assessmentEnabled: false });
  const disabledJob = db.upsertJob({ encrypt_job_id: 'hold-queue-disabled-job', name: 'F018 关闭合成岗位' });
  const disabledCandidate = db.upsertCandidate({
    job_id: disabledJob.id,
    geek_id: 'hold-queue-disabled-candidate',
    source: 'synthetic_hold_queue',
    name: 'F018 关闭合成候选人',
  });
  const disabledRow = db.listCandidates(disabledJob.id)
    .find((item) => item.internal_id === disabledCandidate.internal_id);
  assert.equal(disabledRow.application_status, null);
  assert.equal(disabledRow.application_disposition_action, null);
  assert.equal(disabledRow.application_episode_no, null);

  console.log(JSON.stringify({
    ok: true,
    contract: 'hold-queue-v1',
    hold_excluded_from_progression: true,
    continue_restores_progression: true,
    f018_disabled_safe: true,
  }));
} finally {
  try { database && database.close(); } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
}
