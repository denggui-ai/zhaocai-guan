#!/usr/bin/env node
'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) => fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
const app = read('frontend/src/App.jsx');
const detail = read('frontend/src/components/CandidateDetail.jsx');
const finalReview = read('frontend/src/components/ApplicationFinalReviewPanel.jsx');
const css = read('frontend/src/candidate-v2.css');

const loadStart = app.indexOf('async function loadCandidateDetail');
const selectStart = app.indexOf('async function handleSelectCandidate', loadStart);
assert.ok(loadStart >= 0 && selectStart > loadStart, 'candidate detail loader must remain discoverable');
const loadContract = app.slice(loadStart, selectStart);

assert.match(loadContract, /Promise\.allSettled\(\[/);
assert.doesNotMatch(loadContract, /setDetail\(null\)/,
  'refreshing a candidate must not clear the last-known-good detail');
for (const state of ['refreshing', 'partial', 'stale']) {
  assert.ok(app.includes(`'${state}'`), `missing candidate detail recovery state: ${state}`);
}
assert.match(app, /candidate-detail-recovery-alert/);
assert.match(app, /请只重试读取，不要重复提交刚才的操作/);
assert.match(app, /resourceErrors/);

assert.match(detail, /taskCode:\s*firstTodo\?\.code \|\| ''/);
assert.match(detail, /taskTodo:\s*firstTodo \|\| null/);
for (const code of ['contact_required', 'communication_followup_required', 'resume_followup_required']) {
  assert.match(detail, new RegExp(`${code}: \\{ kind: 'communication', label: '记录沟通事实' \\}`));
}
for (const [code, label] of [
  ['schedule_confirmation_required', '确认面试时间'],
  ['interview_preparation_required', '准备面试脚本'],
  ['report_draft_required', '填写面试报告'],
  ['report_fact_review_required', '复核报告事实'],
  ['report_confirmation_required', '确认面试报告'],
]) {
  assert.match(detail, new RegExp(`${code}: \\{ kind: 'todo', label: '${label}' \\}`));
}
for (const code of ['final_review_required', 'final_disposition_confirmation_required']) {
  assert.match(detail, new RegExp(`${code}: \\{ kind: 'domain', domain: 'final-review', label: '打开结构化终评' \\}`));
}
assert.match(detail, /candidate-task-primary-action/);
assert.match(detail, /contextualTaskAction \? renderContextualTaskAction\(\) : renderVisibleAction\(primaryAction, true\)/);
assert.match(detail, /contextualTaskAction && renderVisibleAction\(primaryAction\)/,
  'continue process must remain available as a downgraded action');
assert.match(detail, /opensTodoTarget[\s\S]*?onOpenTaskTodo\(taskTodo\)/,
  'session/report task CTAs must follow the deterministic todo target');
assert.match(app, /open_candidate_interview:\s*\{ domain: 'interview', interviewTab: 'prepare' \}/);
assert.match(app, /initialInterviewTab:\s*candidateTarget\.interviewTab/);
assert.match(app, /interviewNavigationRequestKey=\{detailInterviewNavigation\.requestKey\}/);
assert.match(app, /interviewNavigationTarget=\{detailInterviewNavigation\.target\}/);
assert.match(detail, /initialTab=\{initialInterviewTab\}/);
assert.match(detail, /navigationRequestKey=\{interviewNavigationRequestKey\}/);
assert.match(detail, /navigationTarget=\{interviewNavigationTarget\}/);
assert.match(detail, /\[candidate && candidate\.internal_id, initialDomain, interviewNavigationRequestKey\]/,
  'same-candidate task routes must re-apply their target domain');
assert.match(app, /async function handleOpenCandidateTaskTodo\(item\)[\s\S]*?report_draft_required[\s\S]*?initialInterviewTarget:[\s\S]*?type: actionType === 'open_report' \? 'report' : 'session'/);
assert.match(detail, /onOpenTaskTodo=\{onOpenTaskTodo\}/);

assert.match(detail, /import ApplicationFinalReviewPanel/);
assert.match(detail, /initialDomain === 'final-review'/);
assert.match(detail, /activeDomain === 'final-review'/);
assert.match(detail, /<ApplicationFinalReviewPanel/);
assert.match(detail, /onDirtyChange=\{handleInterviewDirtyChange\}/);
assert.match(detail, /onDirtyChange=\{handleFinalReviewDirtyChange\}/);
assert.match(detail, /const communicationDirty = communicationCode !== communicationBaseline\.code/);
assert.match(detail, /interviewDirty \|\| finalReviewDirty \|\| communicationDirty/);
assert.match(detail, /const committedCode = response\?\.candidate[\s\S]*?setCommunicationBaseline\(\{ code: committedCode, reason: '' \}\)/);
assert.match(detail, /currentCode=\{communicationBaseline\.code\}/);
assert.match(detail, /const currentCode = communicationBaseline\.code;[\s\S]*?const isRollback/);
assert.match(detail, /onBusyChange\?\.\(true\)[\s\S]*?onBusyChange\?\.\(false\)/);
assert.match(app, /candidateWorkspaceBusyRef\.current[\s\S]*?候选人工作区正在保存，请等待完成后再切换候选人、模块或岗位/);
assert.match(app, /onBusyChange=\{handleCandidateWorkspaceBusyChange\}/);
assert.match(detail, /const requestDomainChange = useCallback/);
assert.match(detail, /当前分区还有未保存草稿/);

assert.match(finalReview, /function draftFingerprint/);
assert.match(finalReview, /function dispositionFingerprint/);
assert.match(finalReview, /const workspaceDirty = draftDirty \|\| dispositionDirty/);
assert.match(finalReview, /onDirtyChange\?\.\(workspaceDirty\)/);
assert.match(finalReview, /savedDraftFingerprintRef/);
assert.match(finalReview, /savedDispositionFingerprintRef/);
assert.match(finalReview, /stateContextRef\.current = expectedContext/);
assert.match(finalReview, /committedForm: 'draft', committedValue: input\.review_json/);
assert.match(finalReview, /committedForm: 'disposition', committedValue: submittedDisposition/);
assert.match(finalReview, /const writesBlocked = readOnly \|\| busy \|\| loading \|\| Boolean\(loadError\)/);
assert.match(finalReview, /结构化终评刷新失败，正在显示最近一次成功内容/);
assert.match(finalReview, /disabled=\{writesBlocked\}/);

assert.match(app, /const confirmDiscardUnsavedChanges = useCallback/);
assert.match(app, /取消会保留当前候选人、分区和草稿/);
assert.match(app, /window\.addEventListener\('beforeunload', warnBeforeUnload\)/);
assert.match(app, /onDirtyChange=\{handleCandidateWorkspaceDirtyChange\}/);
assert.match(app, /candidateWorkspaceRevision/);
assert.match(app, /const resetSameCandidateWorkspace = !changesCandidate && candidateWorkspaceDirtyRef\.current/);
assert.match(app, /if \(resetSameCandidateWorkspace\) setCandidateWorkspaceRevision/);
assert.match(app, /const results = await Promise\.all\(refreshes\);[\s\S]*?results\.some\(\(result\) => result === false\)/);
assert.match(app, /className=\{`candidate-focus-bar candidate-identity-anchor/);
assert.match(app, /aria-label="当前候选人身份锚点"/);
assert.match(app, /candidate-focus-job/);
assert.match(app, /candidate-focus-reference/);

assert.match(css, /\.candidate-row-disambiguator\s*\{[\s\S]*?font-size:\s*12px;/);
assert.match(css, /\.candidate-identity-anchor \.candidate-focus-identity strong\s*\{[\s\S]*?white-space:\s*normal;/);
assert.match(css, /\.candidate-disposition-visible-actions\.has-contextual-primary/);

console.log(JSON.stringify({
  ok: true,
  contract: 'CANDIDATE-UX-R1-C',
  task_driven_cta: true,
  final_review_reachable: true,
  dirty_guard: true,
  last_known_good: true,
  persistent_identity: true,
}));
