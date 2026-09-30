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

fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(dataRoot, 0o700);
db.openDb(process.env.BOSS_DB_PATH);

const EXPECTED = Object.freeze({
  original_name: 'B-4 合成岗位生命周期',
  edited_name: 'B-4 合成岗位生命周期（已编辑）',
  hr_owner: 'B-4 合成 HR（已编辑）',
  planned_hires: 3,
  department: 'B-4 合成产品研发部',
  location: 'B-4 合成上海',
  jd_text: '岗位职责：维护本地招聘台账并核验版本历史。\n任职要求：能够识别事实、未知项与人工确认边界。',
  responsibilities: ['维护本地招聘台账', '核验岗位版本历史'],
  must_haves: ['能够区分事实与未知项', '所有招聘结论由 HR 人工确认'],
});

function seedDatabase() {
  const job = db.upsertJob({
    encrypt_job_id: 'b4-synthetic-job-lifecycle',
    numeric_job_id: '940260729001',
    name: EXPECTED.original_name,
    hr_owner: 'B-4 合成 HR',
    department: 'B-4 合成研发部',
    location: 'B-4 合成杭州',
    source_type: 'local_db',
    created_at: '2026-07-29T09:00:00.000Z',
  });
  db.conn().prepare(`
    UPDATE job
    SET planned_hires = 2, status = 'open', updated_at = ?
    WHERE id = ?
  `).run('2026-07-29T09:00:00.000Z', job.id);
  const seed = {
    job_id: job.id,
    expected: EXPECTED,
  };
  const target = path.join(syntheticRoot, 'seed.json');
  fs.writeFileSync(target, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  return { ok: true, ...seed };
}

function rowsForJob(table, jobId) {
  return db.conn().prepare(`SELECT * FROM ${table} WHERE job_id = ? ORDER BY id`).all(jobId);
}

function verifyDatabase() {
  const seed = JSON.parse(fs.readFileSync(path.join(syntheticRoot, 'seed.json'), 'utf8'));
  const original = db.getJobLedger(seed.job_id);
  assert.ok(original, 'original synthetic job must exist');
  assert.equal(original.name, EXPECTED.edited_name);
  assert.equal(original.hr_owner, EXPECTED.hr_owner);
  assert.equal(original.planned_hires, EXPECTED.planned_hires);
  assert.equal(original.department, EXPECTED.department);
  assert.equal(original.location, EXPECTED.location);
  assert.equal(original.status, 'open');
  assert.equal(original.close_reason_code, null);
  assert.equal(original.close_note, null);
  assert.equal(original.closed_at, null);
  assert.equal(original.closed_by, null);

  const originalJd = rowsForJob('job_jd_version', seed.job_id);
  assert.equal(originalJd.length, 1);
  assert.equal(originalJd[0].status, 'active');
  assert.equal(originalJd[0].version, 1);
  assert.equal(originalJd[0].jd_text, EXPECTED.jd_text);
  assert.equal(originalJd[0].activated_by, 'local-primary-operator');

  const originalProfile = rowsForJob('job_profile_version', seed.job_id);
  assert.equal(originalProfile.length, 1);
  assert.equal(originalProfile[0].status, 'confirmed');
  assert.equal(originalProfile[0].version, 1);
  assert.equal(originalProfile[0].jd_version_id, originalJd[0].id);
  assert.equal(originalProfile[0].confirmed_by, 'local-primary-operator');
  const originalConfig = JSON.parse(originalProfile[0].config_json);
  assert.deepEqual(originalConfig.responsibilities, EXPECTED.responsibilities);
  assert.deepEqual(originalConfig.must_haves, EXPECTED.must_haves);

  const copied = db.conn().prepare(`
    SELECT * FROM job
    WHERE id <> ? AND name = ?
  `).get(seed.job_id, `${EXPECTED.edited_name} - 副本`);
  assert.ok(copied, 'copied synthetic job must exist');
  assert.equal(copied.status, 'draft');
  assert.equal(copied.hr_owner, EXPECTED.hr_owner);
  assert.equal(copied.planned_hires, EXPECTED.planned_hires);
  assert.equal(copied.department, EXPECTED.department);
  assert.equal(copied.location, EXPECTED.location);

  const copiedJd = rowsForJob('job_jd_version', copied.id);
  assert.equal(copiedJd.length, 1);
  assert.equal(copiedJd[0].status, 'draft');
  assert.equal(copiedJd[0].version, 1);
  assert.equal(copiedJd[0].jd_text, EXPECTED.jd_text);

  const copiedProfile = rowsForJob('job_profile_version', copied.id);
  assert.equal(copiedProfile.length, 1);
  assert.equal(copiedProfile[0].status, 'draft');
  assert.equal(copiedProfile[0].version, 1);
  assert.equal(copiedProfile[0].jd_version_id, copiedJd[0].id);
  const copiedConfig = JSON.parse(copiedProfile[0].config_json);
  assert.deepEqual(copiedConfig.responsibilities, EXPECTED.responsibilities);
  assert.deepEqual(copiedConfig.must_haves, EXPECTED.must_haves);

  for (const jobId of [seed.job_id, copied.id]) {
    assert.equal(db.conn().prepare('SELECT COUNT(*) AS count FROM candidate WHERE job_id = ?').get(jobId).count, 0);
    assert.equal(db.conn().prepare('SELECT COUNT(*) AS count FROM interview_session WHERE job_id = ?').get(jobId).count, 0);
  }
  const auditRows = db.conn().prepare(`
    SELECT action, target, who, detail_json
    FROM audit_log
    WHERE (target = ? OR target = ?)
      AND action IN ('编辑岗位基础信息', '复制岗位', '切换岗位状态')
    ORDER BY id
  `).all(String(seed.job_id), String(copied.id));
  assert.deepEqual(auditRows.map((row) => row.action), [
    '编辑岗位基础信息',
    '复制岗位',
    '切换岗位状态',
    '切换岗位状态',
  ]);
  assert.ok(auditRows.every((row) => row.who === 'local-primary-operator'));
  const transitions = auditRows
    .filter((row) => row.action === '切换岗位状态')
    .map((row) => JSON.parse(row.detail_json));
  assert.deepEqual(transitions.map((row) => [row.from_status, row.to_status]), [
    ['open', 'closed'],
    ['closed', 'open'],
  ]);
  assert.equal(transitions[0].close_reason_code, 'changed');
  assert.equal(transitions[0].close_note_present, true);
  assert.equal(transitions[1].close_reason_code, null);

  return {
    ok: true,
    synthetic_data_only: true,
    original: {
      id: original.id,
      name: original.name,
      status: original.status,
      jd: {
        id: originalJd[0].id,
        version: originalJd[0].version,
        status: originalJd[0].status,
      },
      profile: {
        id: originalProfile[0].id,
        version: originalProfile[0].version,
        status: originalProfile[0].status,
      },
    },
    copied: {
      id: copied.id,
      name: copied.name,
      status: copied.status,
      candidate_count: 0,
      interview_count: 0,
      jd_status: copiedJd[0].status,
      profile_status: copiedProfile[0].status,
    },
    audit_actions: auditRows.map((row) => row.action),
    status_transitions: transitions,
  };
}

try {
  const result = mode === 'verify' ? verifyDatabase() : seedDatabase();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  db.conn().close();
}
