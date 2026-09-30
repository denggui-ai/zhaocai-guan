#!/usr/bin/env node
'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertOrdered(source, tokens, label) {
  let cursor = -1;
  for (const token of tokens) {
    const next = source.indexOf(token, cursor + 1);
    assert.notEqual(next, -1, `${label}: missing ${token}`);
    assert.ok(next > cursor, `${label}: ${token} is out of order`);
    cursor = next;
  }
}

const ledger = read('frontend/src/components/JobLedgerPanel.jsx');
const schedule = read('frontend/src/components/InterviewScheduleCanonical.jsx');
const detail = read('frontend/src/components/CandidateDetail.jsx');

for (const [adapterMethod, apiMethod] of [
  ['createSession', 'createInterviewSession'],
  ['confirmSchedule', 'confirmInterviewSchedule'],
  ['cancelSession', 'withdrawInterviewLifecycle'],
  ['markInvitationSent', 'markInterviewInvitationSent'],
  ['recordCandidateConfirmation', 'recordInterviewCandidateConfirmation'],
]) {
  assert.match(
    schedule,
    new RegExp(`${adapterMethod}: \\(.*?\\) => api\\.${apiMethod}\\(`),
    `the default schedule adapter must preserve the ${apiMethod} production mapping`,
  );
}

const createJob = section(ledger, 'async function createJob()', 'function openEditModal');
assertOrdered(createJob, [
  'await api.createLocalJob(values)',
  'setCreateOpen(false)',
  'message.success',
  'await onJobsChanged(response.job.id)',
  'setRefreshWarning',
  "if (refreshed) offerJobSetupNextStep(response.job, 'blank')",
], 'job create commit boundary');
assert.doesNotMatch(createJob.slice(createJob.indexOf('await onJobsChanged')), /setError\(/, 'a post-create refresh failure must not be reported as create failure');
assert.match(createJob, /let refreshed = false[\s\S]*await onJobsChanged\(response\.job\.id\)[\s\S]*refreshed = true/);

const createTemplateJob = section(ledger, 'async function createTemplateJob()', 'async function createJob()');
assertOrdered(createTemplateJob, [
  'await api.createJobFromTemplate',
  'setTemplateOpen(false)',
  'message.success',
  'await onJobsChanged(response.job.id)',
  'setRefreshWarning',
  "if (refreshed) offerJobSetupNextStep(response.job, 'template')",
], 'template job create commit boundary');
assert.doesNotMatch(createTemplateJob.slice(createTemplateJob.indexOf('await onJobsChanged')), /setTemplateError\(/, 'a post-template-create refresh failure must not be reported as create failure');

const editJob = section(ledger, 'async function saveJobDetails()', 'function setCommittedPendingKey');
assertOrdered(editJob, [
  'await api.updateJobDetails',
  'setEditJob(null)',
  'message.success',
  'await onJobsChanged',
  'setRefreshWarning',
], 'job edit commit boundary');
assert.doesNotMatch(editJob.slice(editJob.indexOf('await onJobsChanged')), /setError\(/, 'a post-edit refresh failure must not be reported as edit failure');

const copyJob = section(ledger, 'function confirmCopy(job)', 'function confirmStatus');
// The success notice fires from afterClose (transactional-confirm timing
// decision, cfbd4b4): the refresh kick stays at the commit point inside
// onOk, and the notice waits for the dialog to finish closing.
assertOrdered(copyJob, [
  'copyRequestIdByJobRef.current.get(sourceJobId)',
  'copyRequestIdByJobRef.current.set(sourceJobId, requestId)',
  'await api.copyJob(job.id, { requestId })',
  'copyRequestIdByJobRef.current.delete(sourceJobId)',
  'markCommittedPending(key, response.job.id)',
  'void onJobsChanged(response.job.id)',
  'setRefreshWarning',
  'afterClose',
  'message.success',
], 'job copy commit boundary');
assert.match(
  copyJob,
  /catch \(err\)[\s\S]*setError\([\s\S]*throw err;[\s\S]*copyRequestIdByJobRef\.current\.delete\(sourceJobId\)/,
  'a failed or uncertain copy response must retain the same request id until a committed response is received',
);

const statusJob = section(ledger, 'function confirmStatus(job, action)', 'async function openJob');
assertOrdered(statusJob, [
  'await api.updateJobStatus(job.id, action.status, {',
  'markCommittedPending(key, jobId || job.id)',
  'void onJobsChanged(jobId || job.id)',
  'setRefreshWarning',
  'afterClose',
  'message.success',
], 'job status commit boundary');

assert.match(ledger, /type="warning"[\s\S]*message="操作已完成，但台账暂未刷新"/);
assert.match(ledger, /disabled: authorityWriteLocked \|\| committedRefreshLocked \|\| committedPending\.includes\(`edit-/);
assert.match(ledger, /disabled: authorityWriteLocked \|\| committedRefreshLocked \|\| committedPending\.includes\(`copy-/);
assert.match(ledger, /disabled: authorityWriteLocked \|\| !!busy \|\| committedRefreshLocked \|\| committedPending\.includes\(`status-/);
assert.match(ledger, /disabled=\{authorityWriteLocked \|\| committedRefreshLocked\}[\s\S]*?空白新建/);
assert.match(ledger, /disabled=\{authorityWriteLocked \|\| committedRefreshLocked\}[\s\S]*?从预置岗位开始/);
assert.match(ledger, /closable=\{!committedRefreshLocked\}/);
assert.match(ledger, /onClick=\{retryCommittedRefresh\}[\s\S]*?重试刷新/);

const retryLedgerRefresh = section(ledger, 'async function retryCommittedRefresh()', 'function confirmCopy');
assertOrdered(retryLedgerRefresh, [
  'await onJobsChanged',
  'setCommittedPending([])',
  "setRefreshWarning('')",
], 'job committed refresh retry');
assert.doesNotMatch(
  retryLedgerRefresh,
  /api\.(?:createLocalJob|createJobFromTemplate|updateJobDetails|copyJob|updateJobStatus)/,
  'refresh retry must not replay a committed write',
);
assert.match(createJob, /markCommittedPending\(committedKey, response\.job\.id\)/);
assert.match(createTemplateJob, /markCommittedPending\(committedKey, response\.job\.id\)/);
assert.match(editJob, /markCommittedPending\(committedKey, jobId \|\| response\.job\.id\)/);

const upload = section(detail, 'async function uploadResumeAttachment()', '  if (!candidate) {');
assertOrdered(upload, [
  'await api.importResumeAttachment',
  'if (response.canceled)',
  '简历已上传并提取正文',
  'setActivePanel',
  'await onWorkflowChanged',
  '简历已保存，但最新数据刷新失败',
], 'manual resume commit boundary');
assert.equal((upload.match(/手动上传简历失败/g) || []).length, 1, 'only the import API failure may be called an upload failure');

const interviewActions = [
  ['createSession', 'schedule', 'scheduleAdapter.createSession', '第 ${round} 轮面试已创建'],
  ['schedule', 'cancelSession', 'scheduleAdapter.confirmSchedule', '面试排期'],
  ['cancelSession', 'saveInterviewer', 'scheduleAdapter.cancelSession', '本轮面试已取消'],
  ['markInvitationSent', 'recordCandidateConfirmation', 'scheduleAdapter.markInvitationSent', '邀请发送事实已记录'],
  ['recordCandidateConfirmation', 'return <section', 'scheduleAdapter.recordCandidateConfirmation', '候选人反馈已记录'],
];
for (const [start, end, apiCall, successText] of interviewActions) {
  const handler = section(schedule, `async function ${start}`, end === 'return <section' ? end : `async function ${end}`);
  assertOrdered(handler, [
    `await ${apiCall}`,
    'return;',
    'setCommittedAction(key, true)',
    'await loadCanonicalSessions(context)',
    'await onRefresh()',
    'catch (refreshError)',
  ], `${start} commit boundary`);
  assert.ok(handler.includes(successText), `${start} must distinguish its committed result from refresh failure`);
}

assert.match(schedule, /setCommittedActions\(\[\]\)/, 'job switches must clear local committed markers');
for (const key of ['create:', 'schedule:', 'cancel:', 'invitation:', 'candidate-confirmation:']) {
  assert.ok(schedule.includes(`isCommittedAction(\`${key}`), `${key} write control must be disabled while committed data is stale`);
}
assert.doesNotMatch(schedule, /localStorage|sessionStorage|indexedDB/, 'committed markers must remain minimal component-local state');
assert.match(schedule, /operationNotice && <Alert[\s\S]*type=\{operationNotice\.type\}/);

console.log(JSON.stringify({
  ok: true,
  contract: 'COMMITTED-WRITE-REFRESH-001',
  job_modal_closes_after_write: true,
  blank_and_template_next_steps_after_refresh: true,
  refresh_failure_is_warning: true,
  interview_duplicate_guard_is_local: true,
  resume_saved_is_not_upload_failure: true,
}));
