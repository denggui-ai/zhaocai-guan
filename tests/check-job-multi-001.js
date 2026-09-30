'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-job-multi-001-'));
const DB_PATH = path.join(ROOT, 'synthetic.db');
const INTERVIEW_ROOT = path.join(ROOT, 'interviews');
const PORT = 18900 + (process.pid % 500);
const TOKEN = 'job-multi-001-local-api-token-synthetic-0001';

fs.mkdirSync(INTERVIEW_ROOT, { recursive: true, mode: 0o700 });
process.env.BOSS_DB_PATH = DB_PATH;
process.env.BOSS_ACTION_PORT = String(PORT);
process.env.HRBOSS_LOCAL_API_TOKEN = TOKEN;
process.env.HRBOSS_LOCAL_API_INSTANCE_ID = 'job-multi-001';
process.env.HRBOSS_DATA_DIR = ROOT;
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = INTERVIEW_ROOT;
process.env.HRBOSS_EXTERNAL_AI_ENABLED = '0';
process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED = '0';
process.env.HRBOSS_F018_ENABLED = '0';

const db = require("../src/db");
const { startHttpServer, shutdown } = require("../src/action-server");

function post(pathname, body = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: 'POST',
      headers: {
        'x-hrboss-token': TOKEN,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end(payload);
  });
}

async function createJob(input) {
  const response = await post('/api/jobs', input);
  assert.equal(response.status, 201, response.body && response.body.error);
  assert.equal(response.body.ok, true);
  return response.body.job;
}

async function main() {
  await startHttpServer();

  const jobA = await createJob({
    createRequestId: 'job-multi-001-create-a',
    name: '合成岗位 A',
    hr_owner: '合成 HR 甲',
    planned_hires: 3,
    status: 'open',
    department: '合成研发部',
    location: '合成杭州',
  });
  const jobB = await createJob({
    createRequestId: 'job-multi-001-create-b',
    name: '合成岗位 B',
    hr_owner: '合成 HR 乙',
    planned_hires: 2,
    status: 'paused',
  });
  const jobC = await createJob({
    createRequestId: 'job-multi-001-create-c',
    name: '合成岗位 C',
    hr_owner: '合成 HR 丙',
    planned_hires: 1,
    status: 'draft',
  });

  assert.equal(jobA.source_type, 'local_db');
  assert.equal(jobB.status, 'paused');
  assert.equal(jobC.status, 'draft');
  assert.equal(jobA.last_change_action, 'created');
  assert.equal(jobA.last_change_who, 'local-primary-operator');
  assert.equal(Number.isNaN(Date.parse(jobA.last_change_at)), false);
  assert.equal(JSON.parse(jobA.last_change_detail_json).name, '合成岗位 A');

  const jdA = db.createJobJdVersion({ jobId: jobA.id, jdText: '合成岗位 A 独立 JD', actor: 'job-multi-test' });
  db.activateJobJdVersion({ jdVersionId: jdA.id, actor: 'job-multi-test' });
  const profileA = db.createJobProfileVersion({
    jobId: jobA.id,
    jdVersionId: jdA.id,
    config: { responsibilities: ['A 岗职责'], must_haves: ['A 岗条件'] },
    actor: 'job-multi-test',
  });
  db.confirmJobProfileVersion({ profileVersionId: profileA.id, actor: 'job-multi-test' });

  const jdC = db.createJobJdVersion({ jobId: jobC.id, jdText: '合成岗位 C 独立 JD', actor: 'job-multi-test' });
  assert.notEqual(jdA.id, jdC.id);

  for (const suffix of ['1', '2']) {
    const candidate = db.upsertCandidate({
      job_id: jobC.id,
      geek_id: `synthetic-over-hire-${suffix}`,
      name: `合成超编候选人-${suffix}`,
      source: 'synthetic',
    });
    db.changeStatus(candidate.internal_id, 'disposition', 'hired', 'manual_hr_action', 'job-multi-test', '合成超编录用事实');
  }
  const overHiredLedger = db.listJobs().find((job) => job.id === jobC.id);
  assert.equal(overHiredLedger.planned_hires, 1);
  assert.equal(overHiredLedger.hired_count, 2);
  assert.equal(overHiredLedger.remaining_hires, 0);
  assert.equal(overHiredLedger.over_hires, 1);

  const samePersonA = db.upsertCandidate({
    job_id: jobA.id,
    geek_id: 'synthetic-same-person',
    name: '合成同一候选人-A 关系',
    source: 'synthetic',
  });
  const anotherA = db.upsertCandidate({
    job_id: jobA.id,
    geek_id: 'synthetic-a-second',
    name: '合成候选人-A2',
    source: 'synthetic',
  });
  const samePersonB = db.upsertCandidate({
    job_id: jobB.id,
    geek_id: 'synthetic-same-person',
    name: '合成同一候选人-B 关系',
    source: 'synthetic',
  });
  assert.notEqual(samePersonA.internal_id, samePersonB.internal_id, '同一候选人跨岗位必须保留独立招聘关系');

  db.changeStatus(samePersonA.internal_id, 'disposition', 'hired', 'manual_hr_action', 'job-multi-test', '合成录用事实');
  const ledgerA = db.listJobs().find((job) => job.id === jobA.id);
  assert.equal(ledgerA.planned_hires, 3);
  assert.equal(ledgerA.hired_count, 1);
  assert.equal(ledgerA.remaining_hires, 2);
  assert.equal(ledgerA.candidate_count, 2);
  const ledgerB = db.listJobs().find((job) => job.id === jobB.id);
  assert.equal(ledgerB.candidate_count, 1);
  assert.equal(anotherA.inserted, true);

  const editResponse = await post(`/api/jobs/${jobA.id}/details`, {
    name: '合成岗位 A（已编辑）',
    hr_owner: '合成 HR 丁',
    planned_hires: 4,
    department: '合成产品研发部',
    location: '合成上海',
  });
  assert.equal(editResponse.status, 200, editResponse.body && editResponse.body.error);
  assert.equal(editResponse.body.no_op, false);
  assert.equal(editResponse.body.job.name, '合成岗位 A（已编辑）');
  assert.equal(editResponse.body.job.hr_owner, '合成 HR 丁');
  assert.equal(editResponse.body.job.planned_hires, 4);
  assert.equal(editResponse.body.job.department, '合成产品研发部');
  assert.equal(editResponse.body.job.location, '合成上海');
  assert.equal(editResponse.body.job.hired_count, 1);
  assert.equal(editResponse.body.job.remaining_hires, 3);
  assert.equal(editResponse.body.job.candidate_count, 2);
  assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM job_jd_version WHERE job_id = ?').get(jobA.id).n, 1);
  assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM job_profile_version WHERE job_id = ?').get(jobA.id).n, 1);

  const copyRequestId = 'job-multi-001-copy-a';
  const copyResponse = await post(`/api/jobs/${jobA.id}/copy`, { requestId: copyRequestId });
  assert.equal(copyResponse.status, 201, copyResponse.body && copyResponse.body.error);
  const copied = copyResponse.body.job;
  assert.equal(copied.status, 'draft');
  assert.equal(copied.planned_hires, 4);
  assert.equal(copied.candidate_count, 0);
  assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM candidate WHERE job_id = ?').get(copied.id).n, 0);
  assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM interview_session WHERE job_id = ?').get(copied.id).n, 0);
  assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM status_history WHERE candidate_id IN (SELECT internal_id FROM candidate WHERE job_id = ?)').get(copied.id).n, 0);

  const copiedJd = db.conn().prepare('SELECT status, jd_text FROM job_jd_version WHERE job_id = ?').get(copied.id);
  const copiedProfile = db.conn().prepare('SELECT status, config_json FROM job_profile_version WHERE job_id = ?').get(copied.id);
  assert.deepEqual(copiedJd, { status: 'draft', jd_text: '合成岗位 A 独立 JD' });
  assert.equal(copiedProfile.status, 'draft');
  assert.deepEqual(JSON.parse(copiedProfile.config_json).responsibilities, ['A 岗职责']);
  assert.equal(db.conn().prepare('SELECT jd_text FROM job_jd_version WHERE job_id = ?').get(jobC.id).jd_text, '合成岗位 C 独立 JD');

  const jobCountAfterCopy = db.conn().prepare('SELECT COUNT(*) AS n FROM job').get().n;
  const copyReplay = await post(`/api/jobs/${jobA.id}/copy`, { requestId: copyRequestId });
  assert.equal(copyReplay.status, 201, copyReplay.body && copyReplay.body.error);
  assert.equal(copyReplay.body.job.id, copied.id, '相同复制请求必须返回原岗位副本');
  assert.equal(
    db.conn().prepare('SELECT COUNT(*) AS n FROM job').get().n,
    jobCountAfterCopy,
    '复制岗位响应丢失后的重试不能创建第二份副本',
  );
  assert.equal(
    db.conn().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = '复制岗位' AND target = ?").get(String(copied.id)).n,
    1,
    '复制岗位幂等重放不能追加第二条提交审计',
  );
  const copyNameConflict = await post(`/api/jobs/${jobA.id}/copy`, {
    requestId: copyRequestId,
    name: '同一请求号的不同岗位名称',
  });
  assert.equal(copyNameConflict.status, 409);
  assert.equal(copyNameConflict.body.code, 'JOB_CREATE_IDEMPOTENCY_CONFLICT');
  const copySourceConflict = await post(`/api/jobs/${jobB.id}/copy`, { requestId: copyRequestId });
  assert.equal(copySourceConflict.status, 409);
  assert.equal(copySourceConflict.body.code, 'JOB_CREATE_IDEMPOTENCY_CONFLICT');

  const fixtureJob = db.upsertJob({
    encrypt_job_id: 'synthetic-fixture-job-ledger-guard',
    name: '合成测试岗位（只读）',
    hr_owner: 'Fixture HR',
    is_fixture: 1,
    source_type: 'fixture',
  });
  const jobCountBeforeFixtureWrites = db.conn().prepare('SELECT COUNT(*) AS n FROM job').get().n;
  const fixtureCopy = await post(`/api/jobs/${fixtureJob.id}/copy`, {
    requestId: 'job-multi-001-fixture-copy',
  });
  assert.equal(fixtureCopy.status, 403);
  assert.equal(fixtureCopy.body.code, 'JOB_FIXTURE_READ_ONLY');
  assert.equal(
    db.conn().prepare('SELECT COUNT(*) AS n FROM job').get().n,
    jobCountBeforeFixtureWrites,
    '测试岗位复制必须在后端拒绝，不能生成正式岗位副本',
  );
  const fixtureStatus = await post(`/api/jobs/${fixtureJob.id}/status`, { status: 'closed' });
  assert.equal(fixtureStatus.status, 403);
  assert.equal(fixtureStatus.body.code, 'JOB_FIXTURE_READ_ONLY');
  assert.equal(db.getJobLedger(fixtureJob.id).status, 'open', '测试岗位状态必须保持只读');
  const fixtureEdit = await post(`/api/jobs/${fixtureJob.id}/details`, { name: '不能修改测试岗位' });
  assert.equal(fixtureEdit.status, 403);
  assert.equal(fixtureEdit.body.code, 'JOB_FIXTURE_READ_ONLY');
  assert.equal(db.getJobLedger(fixtureJob.id).name, '合成测试岗位（只读）');

  const beforeClose = {
    candidates: db.conn().prepare('SELECT COUNT(*) AS n FROM candidate WHERE job_id = ?').get(jobA.id).n,
    jd: db.conn().prepare('SELECT COUNT(*) AS n FROM job_jd_version WHERE job_id = ?').get(jobA.id).n,
    profile: db.conn().prepare('SELECT COUNT(*) AS n FROM job_profile_version WHERE job_id = ?').get(jobA.id).n,
    history: db.conn().prepare('SELECT COUNT(*) AS n FROM status_history WHERE candidate_id IN (SELECT internal_id FROM candidate WHERE job_id = ?)').get(jobA.id).n,
  };
  for (const status of ['paused', 'closed']) {
    const response = await post(`/api/jobs/${jobA.id}/status`, {
      status,
      ...(status === 'closed' ? { close_reason_code: 'other', close_note: '合成多岗位回归' } : {}),
    });
    assert.equal(response.status, 200, response.body && response.body.error);
    assert.equal(response.body.job.status, status);
  }
  assert.equal(db.getJobLedger(jobA.id).close_reason_code, 'other');
  const closedJdWrite = await post('/api/job-jd-version', {
    jobId: jobA.id,
    jdText: '关闭后不应写入的 JD',
  });
  assert.equal(closedJdWrite.status, 409);
  assert.equal(closedJdWrite.body.code, 'JOB_CLOSED');
  const closedCandidateWrite = await post('/api/candidate-status', {
    candidateId: samePersonA.internal_id,
    layer: 'comm',
    code: 'contacted',
  });
  assert.equal(closedCandidateWrite.status, 409);
  assert.equal(closedCandidateWrite.body.code, 'JOB_CLOSED');
  const closedInterviewWrite = await post('/api/interview-session', {
    candidateId: samePersonA.internal_id,
    jobId: jobA.id,
    mode: 'offline',
  });
  assert.equal(closedInterviewWrite.status, 409);
  assert.equal(closedInterviewWrite.body.code, 'JOB_CLOSED');
  assert.throws(() => db.upsertCandidate({
    job_id: jobA.id,
    geek_id: 'synthetic-closed-ingest',
    name: '关闭后不应导入的候选人',
    source: 'synthetic',
  }), (error) => error && error.code === 'JOB_CLOSED');
  await assert.rejects(db.rateJob(jobA.id), (error) => error && error.code === 'JOB_CLOSED');
  await assert.rejects(
    db.generateDeepProfileForJob(jobA.id, { generator: async () => ({}) }),
    (error) => error && error.code === 'JOB_CLOSED',
  );
  const reopenResponse = await post(`/api/jobs/${jobA.id}/status`, { status: 'open' });
  assert.equal(reopenResponse.status, 200, reopenResponse.body && reopenResponse.body.error);
  assert.equal(reopenResponse.body.job.status, 'open');
  const afterReopen = {
    candidates: db.conn().prepare('SELECT COUNT(*) AS n FROM candidate WHERE job_id = ?').get(jobA.id).n,
    jd: db.conn().prepare('SELECT COUNT(*) AS n FROM job_jd_version WHERE job_id = ?').get(jobA.id).n,
    profile: db.conn().prepare('SELECT COUNT(*) AS n FROM job_profile_version WHERE job_id = ?').get(jobA.id).n,
    history: db.conn().prepare('SELECT COUNT(*) AS n FROM status_history WHERE candidate_id IN (SELECT internal_id FROM candidate WHERE job_id = ?)').get(jobA.id).n,
  };
  assert.deepEqual(afterReopen, beforeClose, '岗位暂停/关闭/重开不得删除招聘历史');
  assert.equal(db.conn().prepare('SELECT disposition_code FROM candidate WHERE internal_id = ?').get(samePersonA.internal_id).disposition_code, 'hired');

  const invalidTransition = await post(`/api/jobs/${jobA.id}/status`, { status: 'draft' });
  assert.equal(invalidTransition.status, 409);
  assert.equal(invalidTransition.body.code, 'JOB_STATUS_TRANSITION_INVALID');

  const bossJob = db.upsertJob({
    encrypt_job_id: 'synthetic-boss-job',
    numeric_job_id: '123456789',
    name: '合成 Boss 同步岗位',
    hr_owner: 'Boss 原负责人',
    department: '合成原部门',
    location: '合成原地点',
    source_type: 'boss_sync',
  });
  const sources = new Set(db.listJobs().map((job) => job.source_type));
  assert.ok(sources.has('local_db'));
  assert.ok(sources.has('boss_sync'));

  const bossIdentity = () => db.conn().prepare(
    'SELECT id, encrypt_job_id, numeric_job_id, source_type, is_fixture FROM job WHERE id = ?',
  ).get(bossJob.id);
  const originalBossIdentity = bossIdentity();
  const bossEditInput = {
    name: '合成历史岗位（本地维护）',
    hr_owner: '合成本地负责人',
    planned_hires: 2,
    department: '合成本地部门',
    location: '合成本地地点',
  };
  // Legacy provenance must not require an unavailable platform sync or an active JD.
  const bossLocalEdit = await post(`/api/jobs/${bossJob.id}/details`, bossEditInput);
  assert.equal(bossLocalEdit.status, 200, bossLocalEdit.body && bossLocalEdit.body.error);
  assert.equal(bossLocalEdit.body.job.name, '合成历史岗位（本地维护）');
  assert.equal(bossLocalEdit.body.job.hr_owner, '合成本地负责人');
  assert.equal(bossLocalEdit.body.job.planned_hires, 2);
  assert.equal(bossLocalEdit.body.job.department, '合成本地部门');
  assert.equal(bossLocalEdit.body.job.location, '合成本地地点');
  assert.equal(bossLocalEdit.body.job.status, 'open');
  assert.deepEqual(bossIdentity(), originalBossIdentity, '本地编辑必须保留历史来源与内部岗位标识');
  const bossEditAudits = () => db.conn().prepare(
    "SELECT who, detail_json FROM audit_log WHERE action = '编辑岗位基础信息' AND target = ? ORDER BY id",
  ).all(String(bossJob.id));
  assert.equal(bossEditAudits().length, 1);
  assert.equal(bossEditAudits()[0].who, 'local-primary-operator');
  const bossEditAudit = JSON.parse(bossEditAudits()[0].detail_json);
  assert.equal(bossEditAudit.source_type, 'boss_sync');
  assert.deepEqual(bossEditAudit.changed_fields.sort(), ['department', 'hr_owner', 'location', 'name', 'planned_hires']);
  assert.deepEqual(bossEditAudit.before, {
    name: '合成 Boss 同步岗位', hr_owner: 'Boss 原负责人', department: '合成原部门', location: '合成原地点', planned_hires: 1,
  });
  assert.deepEqual(bossEditAudit.after, bossEditInput);
  assert.equal(bossEditAudit.child_records_changed, 0);
  const bossEditReplay = await post(`/api/jobs/${bossJob.id}/details`, bossEditInput);
  assert.equal(bossEditReplay.status, 200);
  assert.equal(bossEditReplay.body.no_op, true);
  assert.equal(bossEditAudits().length, 1, '重复保存相同岗位资料不应追加编辑审计');

  const bossJd = db.createJobJdVersion({ jobId: bossJob.id, jdText: '合成历史岗位 JD', actor: 'job-multi-test' });
  db.activateJobJdVersion({ jdVersionId: bossJd.id, actor: 'job-multi-test' });
  db.createJobProfileVersion({
    jobId: bossJob.id, jdVersionId: bossJd.id, config: { responsibilities: ['历史职责'] }, actor: 'job-multi-test',
  });
  const bossCandidate = db.upsertCandidate({
    job_id: bossJob.id, geek_id: 'synthetic-legacy-candidate', name: '合成历史候选人', source: 'synthetic',
  });
  db.changeStatus(bossCandidate.internal_id, 'comm', 'greeted', 'manual_hr_action', 'job-multi-test', '合成沟通记录');
  const bossRelatedData = () => ({
    candidate: db.conn().prepare('SELECT * FROM candidate WHERE job_id = ? ORDER BY internal_id').all(bossJob.id),
    jd: db.conn().prepare('SELECT * FROM job_jd_version WHERE job_id = ? ORDER BY id').all(bossJob.id),
    profile: db.conn().prepare('SELECT * FROM job_profile_version WHERE job_id = ? ORDER BY id').all(bossJob.id),
    history: db.conn().prepare('SELECT * FROM status_history WHERE candidate_id = ? ORDER BY id').all(bossCandidate.internal_id),
  });
  const originalBossRelatedData = bossRelatedData();
  for (const status of ['paused', 'closed']) {
    const changedStatus = await post(`/api/jobs/${bossJob.id}/status`, {
      status,
      ...(status === 'closed' ? { close_reason_code: 'other', close_note: '合成历史岗位回归' } : {}),
    });
    assert.equal(changedStatus.status, 200, changedStatus.body && changedStatus.body.error);
    const edited = await post(`/api/jobs/${bossJob.id}/details`, {
      name: `合成历史岗位（${status}）`, department: `合成部门-${status}`, location: `合成地点-${status}`,
    });
    assert.equal(edited.status, 200, edited.body && edited.body.error);
    assert.equal(edited.body.job.name, `合成历史岗位（${status}）`);
    assert.equal(edited.body.job.department, `合成部门-${status}`);
    assert.equal(edited.body.job.location, `合成地点-${status}`);
    for (const field of ['status', 'close_reason_code', 'close_note', 'closed_at', 'closed_by']) {
      assert.equal(edited.body.job[field], changedStatus.body.job[field], `编辑资料不能改变岗位的 ${field}`);
    }
    assert.deepEqual(bossIdentity(), originalBossIdentity);
    assert.deepEqual(bossRelatedData(), originalBossRelatedData, '编辑历史来源岗位不得改写关联招聘材料');
  }
  const bossClosedWrite = await post('/api/candidate-status', {
    candidateId: bossCandidate.internal_id, layer: 'comm', code: 'replied',
  });
  assert.equal(bossClosedWrite.status, 409);
  assert.equal(bossClosedWrite.body.code, 'JOB_CLOSED');
  const bossReopened = await post(`/api/jobs/${bossJob.id}/status`, { status: 'open' });
  assert.equal(bossReopened.status, 200);
  assert.equal(bossReopened.body.job.status, 'open');
  assert.deepEqual(bossRelatedData(), originalBossRelatedData, '历史岗位重开必须保留关联招聘材料');
  assert.equal(bossEditAudits().length, 3);
  assert.equal(db.conn().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('本地新建岗位', '编辑岗位基础信息', '复制岗位', '切换岗位状态')").get().n, 14);
  const editAudit = JSON.parse(db.conn().prepare("SELECT detail_json FROM audit_log WHERE action = '编辑岗位基础信息' AND target = ? ORDER BY id DESC LIMIT 1").get(String(jobA.id)).detail_json);
  assert.deepEqual(editAudit.changed_fields.sort(), ['department', 'hr_owner', 'location', 'name', 'planned_hires']);
  assert.equal(editAudit.child_records_changed, 0);

  console.log(JSON.stringify({
    ok: true,
    contract: 'JOB-MULTI-001',
    synthetic_jobs: 3,
    copied_job_id: copied.id,
    editable_fields: ['name', 'hr_owner', 'planned_hires', 'department', 'location'],
    legacy_source_job_locally_editable: true,
    legacy_job_identity_and_history_preserved: true,
    fixture_job_ledger_writes_blocked: true,
    closed_job_write_guard: true,
    over_hire_projection: true,
    recent_change_projection: true,
    hired_truth: 'candidate.disposition_code',
    preserved_history: true,
    external_services_called: false,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await shutdown().catch(() => {});
  try { db.conn().close(); } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
});
