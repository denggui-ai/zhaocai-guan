'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-talent-pool-reentry-001-'));
const DB_PATH = path.join(ROOT, 'synthetic.db');
const PORT = 19400 + (process.pid % 400);
const TOKEN = 'talent-pool-reentry-001-local-api-token';

process.env.BOSS_DB_PATH = DB_PATH;
process.env.BOSS_ACTION_PORT = String(PORT);
process.env.HRBOSS_LOCAL_API_TOKEN = TOKEN;
process.env.HRBOSS_LOCAL_API_INSTANCE_ID = 'talent-pool-reentry-001';
process.env.HRBOSS_DATA_DIR = ROOT;
process.env.HRBOSS_EXTERNAL_AI_ENABLED = '0';
process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED = '0';
process.env.HRBOSS_F018_ENABLED = '1';

const db = require('./db');
const { startHttpServer, shutdown } = require('./action-server');

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

async function createJob(name, createRequestId, status = 'open') {
  const response = await post('/api/jobs', {
    createRequestId,
    name,
    hr_owner: '合成 HR',
    planned_hires: 2,
    status,
  });
  assert.equal(response.status, 201, response.body && response.body.error);
  return response.body.job;
}

function countByCandidate(table, candidateId) {
  return Number(db.conn().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE candidate_id = ?`).get(candidateId).n);
}

async function main() {
  await startHttpServer();
  const sourceJob = await createJob('合成历史岗位', 'talent-pool-reentry-001-source');
  const targetJob = await createJob('合成当前岗位', 'talent-pool-reentry-001-target');
  const closedJob = await createJob('合成已关闭岗位', 'talent-pool-reentry-001-closed');
  const close = await post(`/api/jobs/${closedJob.id}/status`, { status: 'closed', close_reason_code: 'other' });
  assert.equal(close.status, 200);

  const source = db.upsertCandidate({
    job_id: sourceJob.id,
    geek_id: 'synthetic-talent-reentry-person',
    numeric_uid: 'synthetic-numeric-uid',
    boss_id: 'synthetic-boss-id',
    security_id: 'synthetic-security-id',
    encrypt_job_id: 'synthetic-source-job-key',
    expect_id: 'synthetic-expect-id',
    lid: 'synthetic-lid',
    source: 'synthetic_history',
    rec_position: '旧岗位名称',
    name: '合成人才甲',
    age: '29',
    degree: '本科',
    school: '合成大学',
    work_years: '5年',
    salary: '合成薪资',
    geek_desc: '合成候选人基础简介',
    sabc: 'S',
    sabc_reason: '旧岗位评级原因',
    match_point: '旧岗位匹配结论',
    risk_point: '旧岗位风险结论',
    raw_json: JSON.stringify({ synthetic: true, source_keys: true }),
  }).internal_id;

  db.changeStatus(source, 'comm', 'replied', 'synthetic', 'synthetic-hr', '合成历史沟通');
  db.changeStatus(source, 'disposition', 'talent_pool', 'synthetic', 'synthetic-hr', '合成历史处置');
  const resumeSections = JSON.stringify({
    basic: [{ description: '合成在线简历快照' }],
    work: [{ company: '合成公司', title: '合成职位' }],
  });
  db.insertResumeOnline({
    candidate_id: source,
    sections_json: resumeSections,
    is_paywalled: 0,
    raw_json: JSON.stringify({ synthetic_raw_resume: true }),
    fetched_at: '2026-07-15T01:00:00.000Z',
  });
  db.conn().prepare(`
    INSERT INTO contact (candidate_id, type, value_encrypted, value_hash, source, confidence, created_at)
    VALUES (?, 'mobile', 'synthetic-encrypted', 'synthetic-hash', 'synthetic', 'high', ?)
  `).run(source, '2026-07-15T01:01:00.000Z');
  db.conn().prepare(`
    INSERT INTO comment (candidate_id, body, purpose_tag, author, created_at)
    VALUES (?, '合成历史备注', '合成用途', '合成 HR', ?)
  `).run(source, '2026-07-15T01:02:00.000Z');
  db.conn().prepare(`
    INSERT INTO field_annotation (candidate_id, target_ref, kind, value, author, created_at)
    VALUES (?, 'synthetic', 'synthetic', '合成标注', '合成 HR', ?)
  `).run(source, '2026-07-15T01:03:00.000Z');
  db.insertAiReview({
    candidate_id: source,
    job_id: sourceJob.id,
    profile_confirmed: 1,
    report_json: JSON.stringify({ schema_version: 'candidate_evaluation_report_v1', synthetic: true }),
  });
  db.createInterviewSession({ candidateId: source, jobId: sourceJob.id, round: 1, mode: 'offline' });
  db.conn().prepare(`
    INSERT INTO resume_attachment (candidate_id, resume_id, file_name, download_status, created_at)
    VALUES (?, 'synthetic-resume-id', 'synthetic.pdf', '已下载', ?)
  `).run(source, '2026-07-15T01:04:00.000Z');

  const added = await post('/api/talent-pool/add-to-job', {
    source_candidate_id: source,
    job_id: targetJob.id,
    actor: 'forged-renderer-actor',
  });
  assert.equal(added.status, 201, added.body && added.body.error);
  assert.equal(added.body.ok, true);
  assert.equal(added.body.relation.inserted, true);
  assert.equal(added.body.relation.resume_snapshot_copied, true);
  const targetCandidateId = added.body.relation.candidate.internal_id;
  assert.notEqual(targetCandidateId, source, '跨岗位必须建立独立候选人关系');

  const target = db.conn().prepare('SELECT * FROM candidate WHERE internal_id = ?').get(targetCandidateId);
  assert.equal(target.job_id, targetJob.id);
  assert.equal(target.geek_id, 'synthetic-talent-reentry-person');
  assert.equal(target.source, '人才库再加入');
  assert.equal(target.relation_type, 'talent_pool_reentry');
  assert.equal(target.rec_position, targetJob.name);
  assert.equal(target.name, '合成人才甲');
  assert.equal(target.comm_status, '未打招呼');
  assert.equal(target.communication_code, 'not_contacted');
  assert.equal(target.disposition_status, '新入库');
  assert.equal(target.disposition_code, 'new');
  for (const field of [
    'numeric_uid', 'boss_id', 'security_id', 'encrypt_job_id', 'expect_id', 'lid',
    'sabc', 'sabc_reason', 'match_point', 'risk_point', 'raw_json',
  ]) assert.equal(target[field], null, `新岗位关系不应复制 ${field}`);

  const copiedResume = db.conn().prepare('SELECT * FROM resume_online WHERE candidate_id = ?').get(targetCandidateId);
  assert.equal(copiedResume.sections_json, resumeSections);
  assert.equal(copiedResume.raw_json, null, '在线简历原始响应不得跨岗位复制');
  for (const table of ['contact', 'comment', 'field_annotation', 'status_history', 'ai_review', 'interview_session', 'resume_attachment']) {
    assert.equal(countByCandidate(table, targetCandidateId), 0, `${table} 历史不得复制到新岗位`);
  }
  assert.equal(countByCandidate('application_episode', targetCandidateId), 1, '新关系只创建自己的 active application');
  assert.equal(db.conn().prepare(`
    SELECT COUNT(*) AS n
    FROM application_event event
    JOIN application_episode application ON application.id = event.application_id
    WHERE application.candidate_id = ?
  `).get(targetCandidateId).n, 1, '新关系只记录自己的 opened 事件');

  const audit = db.conn().prepare(`
    SELECT who, detail_json FROM audit_log
    WHERE action = '人才库加入岗位' AND target = ?
    ORDER BY id DESC LIMIT 1
  `).get(targetCandidateId);
  assert.equal(audit.who, 'local-primary-operator', '审计操作者必须来自服务端本地主体');
  assert.equal(JSON.parse(audit.detail_json).copied_history, false);

  const repeated = await post('/api/talent-pool/add-to-job', {
    source_candidate_id: source,
    job_id: targetJob.id,
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.relation.inserted, false);
  assert.equal(repeated.body.relation.already_exists, true);
  assert.equal(repeated.body.relation.candidate.internal_id, targetCandidateId);
  assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM candidate WHERE geek_id = ? AND job_id = ?')
    .get('synthetic-talent-reentry-person', targetJob.id).n, 1, '重复点击不得创建重复关系');
  assert.equal(countByCandidate('application_episode', targetCandidateId), 1);

  const targetPool = db.listTalentPool({ jobId: targetJob.id });
  const targetTalent = targetPool.talents.find((item) => item.history.some((history) => history.candidate_id === targetCandidateId));
  assert.ok(targetTalent, '加入后人才库历史应显示当前岗位关系');
  assert.equal(targetPool.job_recommendations.some((item) => item.pool_id === targetTalent.pool_id), false, '已加入者不应继续出现在当前岗位推荐中');

  const closedAttempt = await post('/api/talent-pool/add-to-job', {
    source_candidate_id: source,
    job_id: closedJob.id,
  });
  assert.equal(closedAttempt.status, 409);
  assert.equal(closedAttempt.body.code, 'JOB_CLOSED');
  assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM candidate WHERE geek_id = ? AND job_id = ?')
    .get('synthetic-talent-reentry-person', closedJob.id).n, 0);

  const doNotContact = db.upsertCandidate({
    job_id: sourceJob.id,
    geek_id: 'synthetic-do-not-contact-person',
    source: 'synthetic_history',
    name: '合成人才乙',
  }).internal_id;
  db.changeStatus(doNotContact, 'disposition', 'do_not_contact', 'synthetic', 'synthetic-hr', '合成禁止触达');
  const preserved = await post('/api/talent-pool/add-to-job', {
    source_candidate_id: doNotContact,
    job_id: targetJob.id,
  });
  assert.equal(preserved.status, 201, preserved.body && preserved.body.error);
  assert.equal(preserved.body.relation.inserted, true);
  assert.equal(preserved.body.relation.do_not_contact_preserved, true);
  const preservedId = preserved.body.relation.candidate.internal_id;
  assert.notEqual(preservedId, doNotContact, 'DNC 人才也必须建立独立岗位关系');
  const preservedCandidate = db.conn().prepare('SELECT * FROM candidate WHERE internal_id = ?').get(preservedId);
  assert.equal(preservedCandidate.job_id, targetJob.id);
  assert.equal(preservedCandidate.comm_status, '未打招呼');
  assert.equal(preservedCandidate.communication_code, 'not_contacted');
  assert.equal(preservedCandidate.disposition_status, '不再联系');
  assert.equal(preservedCandidate.disposition_code, 'do_not_contact');
  for (const table of ['contact', 'comment', 'field_annotation', 'status_history', 'ai_review', 'interview_session', 'resume_attachment']) {
    assert.equal(countByCandidate(table, preservedId), 0, `DNC 新关系不得复制 ${table} 历史`);
  }
  const preservedApplication = db.conn().prepare(`
    SELECT status, version FROM application_episode WHERE candidate_id = ?
  `).get(preservedId);
  assert.equal(preservedApplication.status, 'closed', 'DNC 新关系不能形成待处置中的 active application');
  assert.equal(preservedApplication.version, 2);

  const preservedAgain = await post('/api/talent-pool/add-to-job', {
    source_candidate_id: doNotContact,
    job_id: targetJob.id,
  });
  assert.equal(preservedAgain.status, 200);
  assert.equal(preservedAgain.body.relation.inserted, false);
  assert.equal(preservedAgain.body.relation.do_not_contact_preserved, true);
  assert.equal(preservedAgain.body.relation.candidate.internal_id, preservedId);

  const ui = fs.readFileSync(path.join(__dirname, 'frontend/src/components/TalentPoolDemo.jsx'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, 'frontend/src/api.js'), 'utf8');
  assert.match(ui, /加入当前岗位/);
  assert.match(ui, /只复用基础资料和最近一份可读在线简历快照/);
  assert.match(ui, /不复制旧岗位的评级、AI 结论、联系方式、面试、测评、处置或状态历史/);
  assert.match(ui, /也不会自动发送消息/);
  assert.match(ui, /继续保持“未打招呼 \/ 不再联系”/);
  assert.doesNotMatch(ui, /该人才存在不再联系记录，不能加入新岗位/);
  assert.match(ui, /OUTREACH_BLOCKED_STATUSES = new Set\(\['cooling', 'do_not_contact'\]\)/);
  assert.match(api, /addTalentToJob: .*actionPost\('\/talent-pool\/add-to-job'/);

  console.log(JSON.stringify({
    ok: true,
    contract: 'TALENT-POOL-REENTRY-001',
    independent_job_relation: true,
    idempotent: true,
    copied_resume_snapshot: true,
    copied_history: false,
    closed_job_guard: true,
    do_not_contact_relation_preserved: true,
    do_not_contact_outreach_guard: true,
    server_actor_audited: true,
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  try { await shutdown(); } catch {}
  try { db.conn().close(); } catch {}
  fs.rmSync(ROOT, { recursive: true, force: true });
});
