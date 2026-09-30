'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relative) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relative), 'utf8');
}

const app = read('frontend/src/App.jsx');
const ledger = read('frontend/src/components/JobLedgerPanel.jsx');
const jobWorkspace = read('frontend/src/components/job-management-workspace.jsx');
const topBar = read('frontend/src/components/TopBar.jsx');
const api = read('frontend/src/api.js');
const actionServer = read("src/action-server.js");
const principal = read("src/local-principal.js");

assert.match(app, /useState\('ledger'\)/, '职位管理默认必须打开岗位台账');
assert.match(app, /jobManagementView === 'ledger'[\s\S]*<JobLedgerPanel/, '职位管理必须先渲染正式台账');
assert.match(app, /async function handleOpenManagedJob\(id\)[\s\S]*await handleJobChange\(id\)[\s\S]*setJobManagementView\('editor'\)/, '打开岗位必须先同步全局岗位上下文');
assert.match(app, /function isUnchangedJobContext[\s\S]*context\.jobId == null \? current\.jobId == null/, '空库首次创建也必须允许同步岗位上下文');
assert.match(app, /key=\{`job-editor-\$\{jobId\}`\}/, '岗位编辑器必须按 jobId 隔离重挂载');
assert.match(app, /返回岗位台账/);
assert.match(app, /const jobClosed = job\?\.status === 'closed'/, '关闭岗位必须进入岗位级只读模式');
assert.match(jobWorkspace, /closed: \{ label: '已关闭'/);
assert.match(jobWorkspace, /\{readOnly && <Tag color="green">只读<\/Tag>\}/);
assert.match(app, /readOnly=\{jobReadOnly\}/);

['岗位名称', 'HR 负责人', '计划 HC', '岗位状态', '部门（可选）', '工作地点（可选）'].forEach((label) => {
  assert.ok(ledger.includes(label), `新建表单缺少 ${label}`);
});
['草稿', '招聘中', '暂缓', '已关闭', '已录用', '剩余 HC', '候选人数'].forEach((label) => {
  assert.ok(ledger.includes(label), `岗位台账缺少 ${label}`);
});
['搜索岗位名称、负责人、部门或地点', '全部状态', '隐藏已关闭', '最近变更', '超编'].forEach((label) => {
  assert.ok(ledger.includes(label), `岗位台账缺少 ${label}`);
});
assert.match(ledger, /dataSource=\{filteredJobs\}/);
assert.match(ledger, /last_change_detail_json/);
assert.match(ledger, /last_change_action === 'created'[\s\S]{0,80}return '创建'/);
assert.match(ledger, /useState\(true\)/, '已关闭岗位默认必须隐藏');
assert.match(ledger, /api\.createLocalJob/);
assert.match(ledger, /api\.updateJobDetails/);
assert.match(ledger, /api\.copyJob/);
assert.match(ledger, /api\.updateJobStatus/);
assert.match(ledger, /api\.updateJobDetails\(targetJob\.id, values\)/,
  '历史来源岗位必须提交完整的本地编辑字段');
assert.doesNotMatch(ledger, /disabled=\{editJob\?\.source_type === 'boss_sync'\}/,
  '历史来源不得锁定岗位名称、部门或工作地点输入');
assert.match(ledger, /候选人、面试、处置和历史事件不会复制/);
assert.match(ledger, /关闭岗位不会删除候选人、JD、画像、测评、面试、Offer 或招聘历史/);
assert.doesNotMatch(ledger, /changeCandidateStatus|applyManualCandidateAction|recordF018Disposition/);

assert.match(topBar, /value=\{jobId \?\? undefined\}/);
assert.match(topBar, /onChange=\{onJobChange\}/);
assert.match(topBar, /jobs\.map\(\(job\) => \(\{ value: job\.id/);

assert.match(api, /createLocalJob: \(input\) => actionPost\('\/jobs'/);
assert.match(api, /updateJobDetails: \(jobId, input\) => actionPost\(`\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/details`/);
assert.match(api, /copyJob: \(jobId, input = \{\}\) => actionPost\(/);
assert.match(api, /updateJobStatus: \(jobId, status, options = \{\}\) => actionPost\(`\/jobs\/\$\{encodeURIComponent\(jobId\)\}\/status`/);
assert.match(actionServer, /db\.createLocalJob/);
assert.match(actionServer, /db\.updateJobDetails/);
assert.match(actionServer, /db\.copyJob/);
assert.match(actionServer, /db\.updateJobStatus/);
assert.match(actionServer, /db\.assertCandidateJobRecruitingWritable/);
assert.match(actionServer, /JOB_CLOSED/);
assert.match(principal, /\/api\/jobs/);
assert.match(principal, /jobs\\\/\\d\+\\\/\(copy\|details\|status\)/);

console.log(JSON.stringify({
  ok: true,
  contract: 'JOB-MULTI-001-ui',
  ledger_first: true,
  selector_sync: true,
  job_editor_isolation: true,
  editable_job_details: true,
  legacy_source_job_locally_editable: true,
  closed_job_read_only: true,
  ledger_search_and_filter: true,
  over_hire_visible: true,
  recent_change_visible: true,
}));
