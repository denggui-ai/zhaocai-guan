#!/usr/bin/env node
'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) => fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
const list = read('frontend/src/components/CandidateList.jsx');
const detail = read('frontend/src/components/CandidateDetail.jsx');
const app = read('frontend/src/App.jsx');

// Filtering may hide the selected row, but it must not silently replace or clear
// the detail context. Actual source deletion still invalidates the selection.
assert.match(list, /const selectionFilteredOut = Boolean\(selectedId && !selectedVisible && selectedExists\);/);
assert.match(list, /if \(selectedId && !selectedExists\) onSelectionInvalidated\?\.\(\);/);
assert.doesNotMatch(list, /if \(selectedId && !selectedVisible\) onSelectionInvalidated\?\.\(\);/);
assert.match(list, /message=\{`仍在查看：\$\{selectedCandidate\.name \|\| '当前候选人'\}`\}/);
assert.match(list, /详情已保留，不会静默切换到其他人/);
assert.match(list, /在列表中显示/);
assert.match(list, /selectionRestorePendingRef[\s\S]*setPage\(Math\.floor\(selectedIndex \/ PAGE_SIZE\) \+ 1\)/);

for (const queue of ['全部待处理', '暂缓', '新推荐', '待沟通', '面试中', '待复盘/决策', '已归档']) {
  assert.ok(list.includes(`label: '${queue}'`), `missing candidate queue: ${queue}`);
}
assert.match(list, /if \(queue === DEFAULT_QUEUE\) return !\['archived', 'hold'\]\.includes\(workQueueKey\(c\)\);/);
assert.match(list, /function countPopulatedQueueCategories\(options\)[\s\S]*?item\.count > 0/);
assert.match(list, /`其他阶段，\$\{overflowQueueCategoryCount\} 个阶段有候选人`/);
assert.match(list, /`\$\{overflowQueueCategoryCount\} 类`/);
assert.match(list, /className="candidate-row-disambiguator" title=\{stableReference\.full\}/);
assert.match(list, /className="candidate-name" title=\{`完整姓名：\$\{fullName\}`\}/);
for (const filter of ['搜索候选人', '按沟通状态筛选', '按处置状态筛选', '按学历筛选', '按标签筛选']) {
  assert.ok(list.includes(`aria-label="${filter}"`), `missing candidate filter: ${filter}`);
}
assert.match(list, /const matchSabc/);
assert.match(list, /compareCandidateDefaultPriority/);
assert.match(list, /<Pagination[\s\S]*pageSize=\{PAGE_SIZE\}/);
assert.match(list, /\['ArrowDown', 'ArrowUp', 'Home', 'End'\]\.includes\(event\.key\)/);
assert.match(list, /event\.key === 'Enter' \|\| event\.key === ' '/);

// One main workspace: no permanent right-side command rail. The existing
// disposition panel becomes a compact taskbar; communication uses a Drawer.
assert.doesNotMatch(detail, /candidate-v2-decision-rail/);
assert.doesNotMatch(detail, /<aside\b/);
assert.match(detail, /className=\{`candidate-v2-body candidate-v2-single-workspace\$\{readOnly \? ' is-read-only' : ''\}`\}/);
const workspaceStart = detail.indexOf('<section className="candidate-v2-workspace"');
const headingIndex = detail.indexOf('<div className="candidate-workspace-head">', workspaceStart);
const taskbarIndex = detail.indexOf('<ManualDispositionPanel', workspaceStart);
const domainNavigationIndex = detail.indexOf('<div className="candidate-domain-navigation"', workspaceStart);
const domainPanelIndex = detail.indexOf('<div className="candidate-domain-panel"', workspaceStart);
const workspaceEnd = detail.indexOf('</section>', taskbarIndex);
assert.ok(workspaceStart >= 0 && taskbarIndex > workspaceStart && workspaceEnd > taskbarIndex,
  'manual disposition taskbar must live inside the single candidate workspace');
assert.ok(headingIndex < taskbarIndex && taskbarIndex < domainNavigationIndex && domainNavigationIndex < domainPanelIndex,
  'candidate workspace must order current task, manual disposition, domain navigation, then selected content');
assert.match(detail, /className="detail-card candidate-command-card candidate-disposition-card candidate-taskbar"/);
assert.match(detail, /communicationTriggerRef=\{communicationTriggerRef\}/);
assert.match(detail, /onOpenCommunication=\{\(\) => \{[\s\S]*setCommunicationOpen\(true\)/);
assert.match(detail, /<Drawer[\s\S]*open=\{communicationOpen\}[\s\S]*closable=\{!communicationBusy\}[\s\S]*keyboard=\{false\}[\s\S]*maskClosable=\{!communicationBusy\}/);
assert.match(detail, /document\.addEventListener\('keydown', handleCommunicationDrawerEscape, true\)/);
assert.match(detail, /afterOpenChange=\{handleCommunicationDrawerOpenChange\}/);
assert.match(detail, /<Drawer[\s\S]*<CommunicationBackfillPanel/);

// The four base domains stay present; structured final review becomes the fifth
// domain only when the route or deterministic todo requires it.
for (const domain of ['资料', '面试', '测评', '流程']) {
  assert.match(detail, new RegExp(`<strong>${domain}<\\/strong>`), `missing primary candidate domain: ${domain}`);
}
assert.match(detail, /const finalReviewVisible = activeDomain === 'final-review'[\s\S]*?initialDomain === 'final-review'[\s\S]*?final_review_required[\s\S]*?final_disposition_confirmation_required/);
assert.match(detail, /className: 'candidate-domain-tab-option candidate-final-review-domain-option'[\s\S]*?<strong>终评<\/strong>[\s\S]*?value: 'final-review'/);
assert.match(detail, /activeDomain === 'final-review'[\s\S]*?<ApplicationFinalReviewPanel[\s\S]*?onDirtyChange=\{handleFinalReviewDirtyChange\}/);
assert.doesNotMatch(detail, /name="candidate-profile-panel"/);
assert.match(detail, /className="detail-tabs candidate-profile-tools"/);
assert.match(detail, /'aria-label': '切换简历材料'/);
assert.match(detail, /AI 初评 · 未运行/);

// Continue/hold/re-entry state and impact are shown before their writes. Final
// states retain their existing explicit confirmations and recovery semantics.
assert.match(detail, /continue_process:\s*\{[\s\S]*target: '当前岗位：继续推进[\s\S]*不会自动发消息、请求简历、安排面试或调用 AI/);
assert.match(detail, /hold:\s*\{[\s\S]*target: '当前岗位暂缓[\s\S]*不会影响其他岗位关系/);
assert.match(detail, /onClick=\{\(\) => onAction\(item\.action, item\.label, \['continue_process', 'hold'\]\.includes\(item\.action\)\)\}/);
assert.match(detail, /onClick=\{\(\) => onAction\('reenter', '重新进入', true\)\}/);
assert.match(detail, /目标状态：<strong>\{confirmation\.target\}<\/strong>/);
for (const action of ['继续推进', '暂缓', '淘汰', '进入人才库', '主动放弃', '标记录用', '重新进入']) {
  assert.ok(detail.includes(action), `missing HR disposition action: ${action}`);
}
assert.match(detail, /const TASK_PRIMARY_ACTIONS = Object\.freeze\(\{[\s\S]*?contact_required: \{ kind: 'communication', label: '记录沟通事实' \}[\s\S]*?schedule_confirmation_required: \{ kind: 'todo', label: '确认面试时间' \}[\s\S]*?report_confirmation_required: \{ kind: 'todo', label: '确认面试报告' \}[\s\S]*?final_review_required: \{ kind: 'domain', domain: 'final-review', label: '打开结构化终评' \}/);
assert.match(detail, /taskCode=\{decisionSummary\.taskCode\}[\s\S]*?taskTodo=\{decisionSummary\.taskTodo\}[\s\S]*?onOpenTaskDomain=\{requestDomainChange\}[\s\S]*?onOpenTaskTodo=\{onOpenTaskTodo\}/);
assert.match(detail, /candidate-task-primary-action[\s\S]*?contextualTaskAction\.label/);

// Candidate/domain/refresh navigation must protect unsaved interview or final-review drafts.
assert.match(detail, /const requestDomainChange = useCallback\(\(nextDomain\) => \{[\s\S]*?当前分区还有未保存草稿[\s\S]*?放弃草稿并切换/);
assert.match(app, /const confirmDiscardUnsavedChanges = useCallback\([\s\S]*?候选人工作区[\s\S]*?取消会保留当前候选人、分区和草稿/);
assert.match(app, /if \(changesCandidate \|\| candidateWorkspaceDirtyRef\.current\)[\s\S]*?confirmDiscardUnsavedChanges\(\{ includeJobEditor: false \}\)/);
assert.match(app, /onDirtyChange=\{handleCandidateWorkspaceDirtyChange\}/);

// Detail refresh is last-known-good and auxiliary reads degrade independently.
assert.match(app, /const \[candidateResult, childrenResult, actionsResult, timelineResult\] = await Promise\.allSettled/);
assert.match(app, /setDetailState\(previousDetail \? 'stale' : 'error'\)/);
assert.match(app, /const resourceErrors = \{\};[\s\S]*?resourceErrors\.children[\s\S]*?resourceErrors\.actions[\s\S]*?resourceErrors\.timeline/);
assert.match(app, /setDetailState\(partial \? 'partial' : 'ready'\)/);
assert.match(app, /className="candidate-detail-recovery-alert"/);

// Materials, recovery and lock contracts stay present.
assert.match(detail, /上传附件简历/);
assert.match(detail, /截图读取失败[\s\S]*重试/);
assert.match(detail, /生成真实 AI 报告/);
assert.match(detail, /生成本地样本报告/);
assert.match(detail, /历史评估/);
assert.match(detail, /查看 AI 设置/);
assert.match(detail, /readOnly=\{readOnly \|\| assessmentStatus\.phase !== 'ready'\}/);
assert.match(detail, /const blocked = readOnly \|\| loading \|\| busy/);

console.log(JSON.stringify({
  ok: true,
  contract: 'UX-W2-A-CANDIDATE-WORKSPACE',
  selected_context_preserved: true,
  single_workspace: true,
  permanent_right_form: false,
  progressive_materials: true,
  disposition_preview: true,
  readonly_and_busy_locks_preserved: true,
}));
