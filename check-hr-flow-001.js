'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb } = require('./db');
const { backfillLegacyCandidates } = require('./f018-application-service');
const { createHrManualDispositionService } = require('./hr-manual-disposition-service');
const workflow = require('./workflow-projection');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-hr-flow-001-'));
const dbPath = path.join(root, 'synthetic.db');
let database;

try {
  database = openDb(dbPath, { f018Enabled: true, assessmentEnabled: false });
  const at = '2026-07-14T06:00:00.000Z';
  database.prepare("INSERT INTO job (id, encrypt_job_id, name, created_at) VALUES (1, 'HR-FLOW-JOB', '合成岗位', ?)").run(at);
  database.prepare(`
    INSERT INTO candidate (
      internal_id, job_id, geek_id, source, name, sabc,
      disposition_status, disposition_code, workflow_version, created_at, updated_at
    ) VALUES (?, 1, ?, 'fixture', ?, 'A', '待处理', 'under_review', 1, ?, ?)
  `).run('C-HR-FLOW-1', 'G-HR-FLOW-1', '合成候选人一', at, at);
  database.prepare(`
    INSERT INTO candidate (
      internal_id, job_id, geek_id, source, name, sabc,
      disposition_status, disposition_code, workflow_version, created_at, updated_at
    ) VALUES (?, 1, ?, 'fixture', ?, 'B', '待处理', 'under_review', 1, ?, ?)
  `).run('C-HR-FLOW-2', 'G-HR-FLOW-2', '合成候选人二', at, at);
  database.prepare(`
    INSERT INTO candidate (
      internal_id, job_id, geek_id, source, name, sabc,
      disposition_status, disposition_code, workflow_version, created_at, updated_at
    ) VALUES (?, 1, ?, 'fixture', ?, 'C', '不再联系', 'do_not_contact', 1, ?, ?)
  `).run('C-HR-FLOW-DNC', 'G-HR-FLOW-DNC', '历史不再联系候选人', at, at);
  backfillLegacyCandidates({ database, actorContext: { actor_id: 'synthetic-migration' }, now: () => at });

  let tick = 0;
  const service = createHrManualDispositionService({
    database,
    actorContext: { actor_id: 'synthetic-hr' },
    now: () => `2026-07-14T06:00:${String(++tick).padStart(2, '0')}.000Z`,
  });
  const apply = (candidateId, action, requestId) => service.apply({
    candidate_id: candidateId,
    job_id: 1,
    action,
    reason: `synthetic_${action}`,
    request_id: requestId,
  });
  const current = (candidateId) => database.prepare(`
    SELECT disposition_status, disposition_code, workflow_version
    FROM candidate WHERE internal_id = ?
  `).get(candidateId);
  const latest = (candidateId) => database.prepare(`
    SELECT episode_no, status, disposition_action, version
    FROM application_episode WHERE candidate_id = ?
    ORDER BY episode_no DESC LIMIT 1
  `).get(candidateId);
  const historyCount = (candidateId) => database.prepare('SELECT COUNT(*) AS n FROM status_history WHERE candidate_id = ?').get(candidateId).n;
  const latestHistory = (candidateId) => database.prepare(`
    SELECT to_status, to_code
    FROM status_history WHERE candidate_id = ?
    ORDER BY id DESC LIMIT 1
  `).get(candidateId);

  let result = apply('C-HR-FLOW-1', 'hold', 'REQ-HR-FLOW-HOLD-1');
  assert.equal(result.no_op, false);
  assert.deepEqual(latest('C-HR-FLOW-1'), { episode_no: 1, status: 'active', disposition_action: 'hold', version: 2 });
  assert.equal(current('C-HR-FLOW-1').disposition_code, 'under_review');
  assert.equal(current('C-HR-FLOW-1').disposition_status, '暂缓', 'episode-aware 暂缓必须向 HR 显示为暂缓');
  assert.equal(historyCount('C-HR-FLOW-1'), 1);

  result = apply('C-HR-FLOW-1', 'hold', 'REQ-HR-FLOW-HOLD-2');
  assert.equal(result.no_op, true);
  assert.equal(historyCount('C-HR-FLOW-1'), 1, '重复暂缓不得重复写历史');
  assert.equal(latest('C-HR-FLOW-1').version, 2, '重复暂缓不得增加 episode version');

  apply('C-HR-FLOW-1', 'continue_process', 'REQ-HR-FLOW-CONTINUE');
  assert.deepEqual(latest('C-HR-FLOW-1'), { episode_no: 1, status: 'active', disposition_action: 'continue_process', version: 3 });
  assert.equal(historyCount('C-HR-FLOW-1'), 2);

  apply('C-HR-FLOW-1', 'talent_pool', 'REQ-HR-FLOW-TALENT');
  assert.deepEqual(latest('C-HR-FLOW-1'), { episode_no: 1, status: 'closed', disposition_action: 'talent_pool', version: 4 });
  assert.equal(current('C-HR-FLOW-1').disposition_code, 'talent_pool');
  const talentHistory = historyCount('C-HR-FLOW-1');
  assert.equal(apply('C-HR-FLOW-1', 'talent_pool', 'REQ-HR-FLOW-TALENT-NOOP').no_op, true);
  assert.equal(historyCount('C-HR-FLOW-1'), talentHistory);

  apply('C-HR-FLOW-1', 'reenter', 'REQ-HR-FLOW-REENTER-1');
  assert.deepEqual(latest('C-HR-FLOW-1'), { episode_no: 2, status: 'active', disposition_action: 'continue_process', version: 1 });
  assert.equal(current('C-HR-FLOW-1').disposition_code, 'under_review', '重入必须清除旧终态投影');

  apply('C-HR-FLOW-1', 'withdraw', 'REQ-HR-FLOW-WITHDRAW');
  assert.deepEqual(latest('C-HR-FLOW-1'), { episode_no: 2, status: 'withdrawn', disposition_action: null, version: 2 });
  assert.equal(current('C-HR-FLOW-1').disposition_code, 'candidate_withdrew', '主动放弃不得再复用全局不再联系 code');
  assert.equal(current('C-HR-FLOW-1').disposition_status, '主动放弃');
  assert.deepEqual(latestHistory('C-HR-FLOW-1'), { to_status: '主动放弃', to_code: 'candidate_withdrew' });

  apply('C-HR-FLOW-1', 'reenter', 'REQ-HR-FLOW-REENTER-2');
  assert.equal(current('C-HR-FLOW-1').disposition_code, 'under_review', '主动放弃后必须可人工重新进入');
  apply('C-HR-FLOW-1', 'hired', 'REQ-HR-FLOW-HIRED');
  assert.deepEqual(latest('C-HR-FLOW-1'), { episode_no: 3, status: 'closed', disposition_action: null, version: 2 });
  assert.equal(current('C-HR-FLOW-1').disposition_code, 'hired');
  const hiredHistory = historyCount('C-HR-FLOW-1');
  assert.throws(
    () => apply('C-HR-FLOW-1', 'reenter', 'REQ-HR-FLOW-HIRED-REENTER'),
    (error) => error.code === 'HIRED_FORBIDDEN',
    '录用终态不得被普通重新进入清除',
  );
  assert.equal(current('C-HR-FLOW-1').disposition_code, 'hired');
  assert.deepEqual(latest('C-HR-FLOW-1'), { episode_no: 3, status: 'closed', disposition_action: null, version: 2 });
  assert.equal(historyCount('C-HR-FLOW-1'), hiredHistory);

  apply('C-HR-FLOW-2', 'reject', 'REQ-HR-FLOW-REJECT');
  assert.deepEqual(latest('C-HR-FLOW-2'), { episode_no: 1, status: 'closed', disposition_action: 'reject', version: 2 });
  assert.equal(current('C-HR-FLOW-2').disposition_code, 'rejected');
  const rejectHistory = historyCount('C-HR-FLOW-2');
  assert.equal(apply('C-HR-FLOW-2', 'reject', 'REQ-HR-FLOW-REJECT-NOOP').no_op, true);
  assert.equal(historyCount('C-HR-FLOW-2'), rejectHistory);

  apply('C-HR-FLOW-2', 'reenter', 'REQ-HR-FLOW-LEGACY-REENTER');
  assert.throws(
    () => apply('C-HR-FLOW-2', '不再联系', 'REQ-HR-FLOW-DNC-NOT-WITHDRAW'),
    (error) => error.code === 'MANUAL_ACTION_INVALID',
    '全局不再联系不得被人工岗位动作偷换为主动放弃',
  );

  const historicalDnc = current('C-HR-FLOW-DNC');
  assert.equal(historicalDnc.disposition_code, 'do_not_contact');
  assert.equal(historicalDnc.disposition_status, '不再联系');
  assert.equal(workflow.DISPOSITION_CODE_TO_LABEL.do_not_contact, '不再联系');
  assert.equal(workflow.deriveWorkflowStatus({
    candidate: { internal_id: 'C-HR-FLOW-DNC', ...historicalDnc },
  }).status, 'do_not_contact');
  assert.equal(workflow.dispositionCode('do_not_contact', '主动放弃'), 'candidate_withdrew', '兼容上一版已写入的主动放弃组合');
  assert.equal(workflow.deriveWorkflowStatus({
    candidate: { internal_id: 'C-HR-FLOW-OLD-WITHDREW', disposition_code: 'do_not_contact', disposition_status: '主动放弃' },
  }).status, 'candidate_withdrew');

  const detailSource = fs.readFileSync(path.join(__dirname, 'frontend/src/components/CandidateDetail.jsx'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, 'frontend/src/App.jsx'), 'utf8');
  const actionSource = fs.readFileSync(path.join(__dirname, 'action-server.js'), 'utf8');
  for (const label of ['继续推进', '暂缓', '淘汰', '进入人才库', '主动放弃', '标记录用', '重新进入']) assert.ok(detailSource.includes(label), `详情页缺少动作：${label}`);
  assert.ok(!detailSource.includes("{ action: 'hired', label: '录用结果' }"), '录用入口不得使用像是打开结果表单的模糊文案');
  assert.ok(detailSource.includes('目标状态：'), '终态确认必须明确展示目标状态');
  assert.ok(detailSource.includes('candidateLabel'), '终态确认必须展示候选人身份');
  assert.ok(detailSource.includes('jobLabel'), '终态确认必须展示岗位上下文');
  assert.ok(detailSource.includes('录用终态不能通过普通“重新进入”撤销'), '录用确认必须说明普通重新进入不能撤销');
  assert.ok(detailSource.includes('当前页面没有撤销入口'), '录用终态不得声称存在仓库中没有的撤销能力');
  assert.ok(!detailSource.includes('请使用单独的录用撤销流程'), '不得把不存在的录用撤销入口显示为可用流程');
  assert.ok(detailSource.includes("application.disposition_action === 'hold'"), '详情页必须区分暂缓与继续');
  assert.ok(detailSource.includes("candidate_withdrew: '主动放弃'"), '详情页必须显示独立的主动放弃语义');
  assert.ok(detailSource.includes("do_not_contact: '不再联系'"), '历史不再联系必须保留原显示');
  assert.ok(detailSource.includes("const globalDoNotContact = candidateCode === 'do_not_contact'"), '全局不再联系不得被岗位重新进入清除');
  assert.ok(detailSource.includes("const hired = candidateCode === 'hired'"), '录用终态不得显示普通重新进入入口');
  assert.ok(appSource.includes('onWorkflowChanged={handleCandidateWorkflowChanged}'));
  assert.ok(appSource.includes('loadCandidates(candidateJobId)'));
  assert.ok(actionSource.includes("body.layer === 'disposition'"));
  assert.ok(actionSource.includes('createHrManualDispositionService'));

  console.log('HR-FLOW-001 synthetic service and UI contract checks passed');
} finally {
  try { database && database.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}
