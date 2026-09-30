#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
}

const api = read('frontend/src/api.js');
const app = read('frontend/src/App.jsx');
const dashboard = read('frontend/src/components/DashboardPanel.jsx');
const candidates = read('frontend/src/components/CandidateList.jsx');
const detail = read('frontend/src/components/CandidateDetail.jsx');
const interview = read('frontend/src/components/InterviewReviewPanel.jsx');
const jobs = read('frontend/src/components/JobManagementPanel.jsx');
const schedule = read('frontend/src/components/InterviewScheduleCanonical.jsx');
const talent = read('frontend/src/components/TalentPoolDemo.jsx');
const topbar = read('frontend/src/components/TopBar.jsx');
const styles = read('frontend/src/styles.css');

assert.match(app, /const \[jobsState, setJobsState\] = useState\('loading'\)/);
assert.match(app, /setJobsState\('error'\)/);
assert.match(dashboard, /jobsLoadState === 'error'[\s\S]*当前无法确认是否已有岗位/);
assert.match(dashboard, /jobsLoadState === 'loading'[\s\S]*正在读取岗位/);

assert.match(app, /Promise\.allSettled\(\[[\s\S]*api\.listCandidates\(id\)[\s\S]*api\.getWorkbench/);
assert.match(app, /setCandidateListState\(candidatesRef\.current\.length \? 'stale' : 'error'\)/);
assert.match(api, /LOCAL_DATA_SERVICE_UNAVAILABLE_PATTERN[\s\S]*ECONNREFUSED[\s\S]*Error invoking remote method/);
assert.match(api, /本地数据服务已停止，界面显示的是上次成功读取的数据。请退出并重新打开招才官/);
assert.match(api, /mapped\.technicalDetails = technicalDetails/);
assert.match(app, /const \[candidateListErrorDetails, setCandidateListErrorDetails\] = useState\(''\)/);
assert.match(app, /setCandidateListErrorDetails\(typeof error\.technicalDetails === 'string' \? error\.technicalDetails : ''\)/);
assert.match(app, /loadErrorDetails=\{candidateListErrorDetails\}/);
assert.match(candidates, /loadState === 'error'[\s\S]*错误不会被当作空数据/);
assert.match(candidates, /loadState === 'stale'[\s\S]*当前展示上次成功数据/);
assert.match(candidates, /detailsExpanded \? '收起详情' : '查看详情'/);
assert.match(candidates, /detailsExpanded && \([\s\S]*candidate-load-error-technical/);
assert.doesNotMatch(candidates, /description=\{loadError\}/);

assert.match(interview, /const \[confirmationLoadErrors, setConfirmationLoadErrors\] = useState\(\{\}\)/);
assert.match(interview, /nextConfirmationLoadErrors\[String\(id\)\]/);
assert.match(interview, /confirmationLoadError[\s\S]*当前记录已锁定/);
assert.match(interview, /readOnly=\{readOnly \|\| reportLocked \|\| !!reportLoadError \|\| !!confirmationLoadError\}/);
assert.match(interview, /if \(confirmationLoadErrors\[String\(id\)\]\)[\s\S]*当前默认项不可保存/);
assert.match(interview, /disabled=\{readOnly \|\| !!busyKey \|\| reportLocked \|\| !!reportLoadError \|\| !!confirmationLoadError/);

assert.match(jobs, /await fn\(\)[\s\S]*setNotice\(`\$\{successText\} 正在刷新最新数据…`\)[\s\S]*catch \(refreshError\)[\s\S]*勿重复提交/);
assert.doesNotMatch(app, /api\.latestRun|recommendRunMatchesJob/, 'removed platform recommendations must not return to the local loading flow');
assert.match(app, /function isCurrentJobContext[\s\S]*?current\.token === context\.token[\s\S]*?sameJobId\(current\.jobId, context\.jobId\)/);
assert.match(app, /const \[candidateResult, workbenchResult\] = await Promise\.allSettled[\s\S]*?if \(!isCurrentJobContext\(currentJobContextRef, context\)[\s\S]*?!jobRequestRef\.current\.isCurrent\(requestId\)\) return false;/);

assert.match(candidates, /report_confirmed: '报告已确认'/);
assert.doesNotMatch(candidates, /joinParts\(\[queueLabel, c\.workflow_status/);
assert.match(detail, /SectionHeader title="招聘进展时间线"/);
assert.match(detail, /title=\{flowTodoLabel\(item\.code\)\}/);
assert.match(interview, /pending_schedule: '待确认面试时间'/);
assert.match(interview, /interviewSourceLabel\(pick\(record, \['source', 'origin'\]\)\)/);
assert.doesNotMatch(interview, /<Tag>\{session\.status\}<\/Tag>/);
assert.match(styles, /\.flow-section:last-child \.flow-event-head[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);

assert.match(talent, /function talentDraftKey\(jobId, poolId\)/);
assert.match(talent, /drafts\[selectedDraftKey\]/);
assert.match(talent, /delete next\[selectedDraftKey\]/);

assert.match(app, /aria-current=\{activeNav === item \? 'page' : undefined\}/);
assert.match(topbar, /role="status"[\s\S]*aria-live="polite"/);
assert.match(topbar, /readOnlyReason === 'closed-job' \? '岗位已关闭' : '操作只读'/);
assert.match(candidates, /role="group" aria-label="候选人队列筛选；全部待处理为聚合视图，其余为阶段筛选"/);
assert.match(candidates, /aria-label="搜索候选人"/);
assert.doesNotMatch(`${jobs}\n${schedule}`, /addonAfter=/);

console.log(JSON.stringify({
  ok: true,
  contract: 'UI-UX-FAILURE-STATES-001',
  false_empty_states_blocked: true,
  confirmation_fallback_write_blocked: true,
  committed_refresh_semantics: true,
  same_name_context_guard: true,
  chinese_workflow_labels: true,
  talent_draft_job_scope: true,
  low_risk_a11y_labels: true,
}));
