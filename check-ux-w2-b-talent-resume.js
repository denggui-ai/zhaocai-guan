#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
}

function functionSlice(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source slice: ${start}`);
  return source.slice(from, to);
}

const talent = read('frontend/src/components/TalentPoolDemo.jsx');
const resumeModal = read('frontend/src/components/ResumeCandidateImportModal.jsx');
const app = read('frontend/src/App.jsx');
const styles = read('frontend/src/styles.css');

// Recommendation grouping is now a filter on the one selectable talent list.
assert.doesNotMatch(talent, /function RecommendationBoard|talent-pool-rec-card/);
assert.match(talent, /<Title level=\{4\}>人才记录<\/Title>[\s\S]*?推荐分组只用于筛选/);
assert.match(talent, /className="talent-pool-group-filter"[\s\S]*?aria-label="推荐分组筛选"/);
assert.match(talent, /role="listbox" aria-label="人才列表"/);
assert.match(talent, /role="option"[\s\S]*?aria-selected=\{selected\}[\s\S]*?tabIndex=\{tabIndex\}/);

// Filtering never derives detail from the filtered rows or mutates selection on clear.
assert.match(talent, /const selected = \(pool\?\.talents \|\| \[\]\)\.find\(\(item\) => item\.pool_id === selectedId\)/);
assert.match(talent, /const selectedHidden = !!selected && !talents\.some/);
assert.match(talent, /当前筛选未包含已选人才/);
assert.match(talent, /右侧详情继续保留，不会静默切换到其他人才/);
const clearFilters = functionSlice(talent, 'function clearFilters()', 'function confirmAddToCurrentJob');
assert.match(clearFilters, /setSearchText\(''\)[\s\S]*?setQuery\(''\)[\s\S]*?setStatus\(''\)[\s\S]*?setGroup\('all'\)/);
assert.doesNotMatch(clearFilters, /setSelectedId/);

// The visible search button commits a query; keyboard selection is explicit.
assert.match(talent, /enterButton="搜索"[\s\S]*?onSearch=\{onSearch\}[\s\S]*?onClear=\{\(\) => onSearch\(''\)\}/);
assert.match(talent, /function submitSearch\(value\)[\s\S]*?setQuery\(next\)/);
for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter']) {
  assert.ok(talent.includes(`event.key === '${key}'`), `missing keyboard key: ${key}`);
}
assert.match(talent, /event\.key === 'Enter' \|\| event\.key === ' '/);
assert.match(talent, /rowRefs\.current\.get\(target\.pool_id\)\?\.focus\(\)/);
assert.match(talent, /const panelRef = useRef\(null\)[\s\S]*?panelRef\.current\.scrollLeft = 0[\s\S]*?\[group, searchText, selectedId, status, talents\.length\]/,
  'talent filters and selection changes must restore the list panel to its left edge');
assert.match(styles, /\.talent-pool-list-panel \{[\s\S]*?container-type: inline-size;[\s\S]*?overflow-x: hidden;/,
  'the talent list may scroll vertically but must not expose a horizontal scroll surface');
assert.match(styles, /@container \(max-width: 480px\) \{[\s\S]*?\.talent-pool-group-segmented \{\s*display: none;[\s\S]*?\.talent-pool-group-select \{\s*display: block;[\s\S]*?\.talent-pool-list-tools \{\s*grid-template-columns: minmax\(0, 1fr\);/,
  'talent filters must respond to the master-pane width rather than only the window width');

// Only the list retains an internal desktop scroll surface; detail follows page scroll.
assert.ok((talent.match(/style=\{\{ maxHeight: 'none', overflow: 'visible' \}\}/g) || []).length >= 2);
assert.match(talent, /const TALENT_HISTORY_PREVIEW_COUNT = 3/);
assert.match(talent, /const visibleHistory = historyExpanded \? history : history\.slice\(0, TALENT_HISTORY_PREVIEW_COUNT\)/);
assert.match(talent, /id=\{historyRegionId\}[\s\S]*?visibleHistory\.map/);
assert.match(talent, /className="talent-pool-history-toggle"[\s\S]*?aria-expanded=\{historyExpanded\}[\s\S]*?aria-controls=\{historyRegionId\}[\s\S]*?查看其余 \$\{hiddenHistoryCount\} 条/);
assert.match(talent, /historyExpanded \? '收起记录'/);
assert.doesNotMatch(talent, /DetailBlock title="(?:推荐依据|待确认|风险|不确定项|证据完整度)"[\s\S]{0,160}?aria-expanded=/,
  'decision evidence and risk blocks must remain directly visible');

// Contact eligibility and risk copy fail closed: a reviewable historical
// record is not presented as directly contactable.
const outreachGate = functionSlice(talent, 'function outreachGate', 'function talentTime');
for (const prerequisite of [
  'has_valid_contact_method',
  'consent_confirmed',
  'opt_out_status_confirmed',
  'needs_consent_check',
  'contact_ready',
]) assert.ok(outreachGate.includes(prerequisite), `missing contact prerequisite: ${prerequisite}`);
assert.match(outreachGate, /talent\.pool_status === 'data_stale'[\s\S]*?blocked: true/,
  'stale talent must be blocked instead of receiving a warning-only outreach gate');
const evaluateOutreachGate = new Function(
  `const OUTREACH_BLOCKED_STATUSES = new Set(['cooling', 'do_not_contact']); ${outreachGate}; return outreachGate;`,
)();
const verifiedContactState = {
  has_record: true,
  has_valid_contact_method: true,
  consent_confirmed: true,
  opt_out_status_confirmed: true,
  needs_consent_check: false,
  contact_ready: true,
};
assert.equal(evaluateOutreachGate({ pool_status: 'reactivable', contact_state: verifiedContactState }).blocked, false);
assert.equal(evaluateOutreachGate({
  pool_status: 'reactivable',
  contact_state: { ...verifiedContactState, consent_confirmed: false, contact_ready: false },
}).blocked, true, 'consent-pending talent must fail closed');
assert.equal(evaluateOutreachGate({
  pool_status: 'data_stale',
  contact_state: verifiedContactState,
}).blocked, true, 'stale talent must remain blocked even with otherwise verified contact state');
assert.match(talent, /function pendingTalentRiskCount[\s\S]*?recommendation\?\.unknowns[\s\S]*?recommendation\?\.uncertainties/);
assert.match(talent, /pendingRiskCount > 0[\s\S]*?未发现已知风险（仍有 \$\{pendingRiskCount\} 项待确认）/);
assert.doesNotMatch(talent, /miniList\(recommendation\.risks, '暂无风险'\)/,
  'an empty known-risk list must preserve pending unknown/uncertainty context');
const complianceHelperSource = functionSlice(talent, 'function hrFacingTalentText', 'function miniList');
const complianceHelpers = new Function(
  `${complianceHelperSource}; return { hrFacingTalentText, pendingTalentRiskCount };`,
)();
assert.equal(complianceHelpers.hrFacingTalentText('状态 Unknown'), '状态 待确认');
assert.equal(complianceHelpers.pendingTalentRiskCount({
  risks: [],
  unknowns: ['授权 Unknown'],
  uncertainties: ['当前意愿待确认'],
}, { contact_ready: false }), 2, 'empty risks must retain the combined pending-item count');

// All user-facing Unknown copy in this component is localized while the
// backend schema can continue to use its established internal vocabulary.
assert.match(talent, /\.replace\(\/Unknown\/g, '待确认'\)/);
for (const visibleUnknown of [
  "label: key || 'Unknown'",
  "return has(value) ? value : 'Unknown'",
  '联系方式状态 Unknown',
  '匹配报告 Unknown',
  '面试 Unknown',
  'title="Unknown"',
  '暂无 Unknown',
]) assert.equal(talent.includes(visibleUnknown), false, `visible Unknown copy remains: ${visibleUnknown}`);
assert.ok(talent.includes('退出测试样例，返回本机数据'));
assert.equal(talent.includes('返回本地空态'), false);
assert.match(talent, /<Button[\s\S]*?aria-label="刷新人才库"[\s\S]*?title="刷新人才库"[\s\S]*?>\s*刷新人才库\s*<\/Button>/,
  'page-level talent refresh must expose one unambiguous visible and accessible name');

// Existing recruitment and safety gates remain in the component.
for (const required of [
  '加入当前岗位',
  '岗位已关闭，请重新开启后再加入',
  '该人才已在当前岗位',
  "OUTREACH_BLOCKED_STATUSES = new Set(['cooling', 'do_not_contact'])",
  '只复用基础资料和最近一份可读在线简历快照',
]) assert.ok(talent.includes(required), `missing retained talent contract: ${required}`);

// Every authority read is fail-closed, including refreshes over an existing
// pool and the complete pool/workspace refresh after a committed add.
assert.match(talent, /const authorityReadPending = loading \|\| !!addingId/);
assert.match(talent, /const authorityMismatch = !pool \|\| String\(pool\.active_job\?\.id \?\? ''\) !== String\(jobId \?\? ''\)/);
assert.match(talent, /const writesLocked = readOnly \|\| authorityReadPending \|\| !!error \|\| authorityMismatch/);
assert.match(talent, /setLoading\(true\)[\s\S]*?setError\(''\)[\s\S]*?api\.listTalentPool/);
assert.match(talent, /<TalentDetail[\s\S]*?readOnly=\{writesLocked\}/);
assert.match(talent, /if \(!selected \|\| writesLocked\) return/);
assert.match(talent, /if \(writesLocked \|\| !talent\?\.primary_candidate_id/);
assert.match(talent, /const pendingWorkspaceRefreshRef = useRef\(null\)/);
const authorityRefresh = functionSlice(talent, 'async function refreshTalentAuthorities', 'function confirmAddToCurrentJob');
assert.match(authorityRefresh, /setAddingId\(pendingWorkspaceRefresh\.poolId \|\| 'authority-refresh'\)[\s\S]*?await loadTalentPool\(false\)[\s\S]*?const workspaceRefreshResult = await onCandidateAdded\?\./);
assert.match(authorityRefresh, /workspaceRefreshed = workspaceRefreshResult !== false/,
  'a resolved false workspace refresh must remain pending and write-locked; undefined means no callback and succeeds');
assert.match(authorityRefresh, /pendingWorkspaceRefreshRef\.current = workspaceRefreshed \? null : pendingWorkspaceRefresh/);
assert.match(authorityRefresh, /if \(!workspaceRefreshed\)[\s\S]*?setError\('岗位关系已保存，但候选人工作区刷新未完成。请重新刷新后再继续操作。'\)/);
assert.match(authorityRefresh, /setAddingId\(''\)[\s\S]*?return poolRefreshed && workspaceRefreshed/);
assert.ok((talent.match(/onClick=\{\(\) => refreshTalentAuthorities\(\)\}/g) || []).length >= 2,
  'header refresh and stale recovery must refresh every pending authority');

// Once async confirmation starts, Ant Design 5.29.3's confirm instance is
// updated to block Cancel, Escape, close, mask dismissal, and duplicate OK.
const addConfirm = functionSlice(talent, 'function confirmAddToCurrentJob', 'const isEmptyLocalPool');
assert.match(addConfirm, /let confirmBusy = false[\s\S]*?let confirmInstance = null/);
assert.match(addConfirm, /confirmInstance\?\.update\(\{[\s\S]*?keyboard: !busy[\s\S]*?closable: false[\s\S]*?maskClosable: false/);
assert.match(addConfirm, /okButtonProps: \{ disabled: busy, loading: busy \}[\s\S]*?cancelButtonProps: \{ disabled: busy \}/);
assert.match(addConfirm, /onOk: async \(\) => \{[\s\S]*?if \(confirmBusy\) return;[\s\S]*?updateConfirmBusy\(true\)[\s\S]*?setAddingId\(talent\.pool_id\)[\s\S]*?api\.addTalentToJob/);
assert.match(addConfirm, /pendingWorkspaceRefreshRef\.current = \{[\s\S]*?candidateId: relation\.candidate\?\.internal_id[\s\S]*?const refreshed = await refreshTalentAuthorities\(false\)/);
assert.match(addConfirm, /catch \(err\) \{[\s\S]*?updateConfirmBusy\(false\)[\s\S]*?throw err/);

// Pre-commit rejection stays in the modal, focuses a persistent summary, and
// keeps the existing field state available for correction and retry.
assert.match(resumeModal, /const submitErrorRef = useRef\(null\)/);
assert.match(resumeModal, /const submittingRef = useRef\(false\)/);
assert.match(resumeModal, /async function confirm\(\)[\s\S]*?await onConfirm\?\./);
assert.match(resumeModal, /catch \(submitFailure\)[\s\S]*?setSubmitError\([\s\S]*?focusSubmitError\(\)/);
assert.match(resumeModal, /ref=\{submitErrorRef\} role="alert" tabIndex=\{-1\} aria-live="assertive"/);
assert.match(resumeModal, /简历建档失败，草稿仍保留/);
assert.match(resumeModal, /if \(busy \|\| submittingRef\.current\) return/);
assert.match(resumeModal, /keyboard=\{!busy\}[\s\S]*?closable=\{!busy\}[\s\S]*?maskClosable=\{!busy\}/);
assert.match(resumeModal, /okButtonProps=\{\{ disabled: busy \}\}[\s\S]*?cancelButtonProps=\{\{ disabled: busy \}\}/);
assert.ok((resumeModal.match(/disabled=\{busy\}/g) || []).length >= 5,
  'busy must lock all five editable fields');

// Existing App behavior closes the single-use draft immediately after a
// successful backend write, before any refresh that can fail.
const commitFlow = functionSlice(app, 'async function handleCommitCandidateFromResume', 'async function handleOpenSettings');
const committedAt = commitFlow.indexOf('committed = true');
const closeDraftAt = commitFlow.indexOf('setResumeCandidateDraft(null)', committedAt);
const refreshAt = commitFlow.indexOf('loadCandidates(context.jobId)');
assert.ok(committedAt >= 0 && closeDraftAt > committedAt && refreshAt > closeDraftAt,
  'committed draft must close before refresh so the write cannot be repeated');

console.log(JSON.stringify({
  ok: true,
  contract: 'UX-W2-B-TALENT-RESUME',
  talent_selection_truths: 1,
  filter_exclusion_policy: 'preserve-detail-with-clear-filter-notice',
  search_submit_wired: true,
  keyboard_model: ['roving-tabindex', 'arrows', 'home-end', 'enter-space'],
  detail_internal_scroll_surfaces: 0,
  modal_rejection_summary: 'persistent-and-focused',
  busy_write_guard: true,
  talent_authority_fail_closed: ['loading', 'refresh', 'error-stale', 'job-mismatch', 'committed-dual-refresh'],
  add_confirm_async_lock: ['cancel', 'escape', 'close', 'mask', 'duplicate-ok'],
  committed_refresh_duplicate_guard: 'single-use-draft-closed-before-refresh',
  app_integration_required: 'pre-commit catch must rethrow to modal onConfirm',
}));
