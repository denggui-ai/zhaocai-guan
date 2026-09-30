#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
const styles = read('frontend/src/styles.css');
const decisionUi = read('frontend/src/decision-ui.css');
const workbenchV2 = read('frontend/src/workbench-v2.css');
const candidateV2 = read('frontend/src/candidate-v2.css');
const app = read('frontend/src/App.jsx');
const candidateList = read('frontend/src/components/CandidateList.jsx');
const candidateDetail = read('frontend/src/components/CandidateDetail.jsx');
const deepProfile = read('frontend/src/components/DeepProfileModal.jsx');
const ocrReview = read('frontend/src/components/ScreenshotOcrReviewModal.jsx');
const jobLedger = read('frontend/src/components/JobLedgerPanel.jsx');
const talentPool = read('frontend/src/components/TalentPoolDemo.jsx');
const interviewSchedule = read('frontend/src/components/InterviewScheduleCanonical.jsx');

const compactCandidateStart = candidateV2.indexOf('@container candidate-detail (max-width: 620px)');
assert.ok(compactCandidateStart >= 0, 'candidate detail must respond to its own compact content width');
const compactCandidate = candidateV2.slice(compactCandidateStart);

assert.match(candidateDetail, /className="candidate-domain-tabs"/);
assert.match(candidateDetail, /className="detail-tabs candidate-profile-tools"/);
assert.match(candidateDetail, /<Segmented\s+block\s+name="candidate-workspace-domain"/);
assert.match(candidateDetail, /candidate-final-review-domain-option[\s\S]*?value: 'final-review'/);
assert.doesNotMatch(candidateDetail, /name="candidate-profile-panel"/);
assert.match(candidateDetail, /'aria-label': '切换简历材料'/);
assert.match(candidateV2, /\.candidate-domain-tabs\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*100%;[\s\S]*?min-width:\s*0;/);
assert.match(candidateV2, /\.detail-tabs\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*100%;[\s\S]*?min-width:\s*0;/);
assert.match(compactCandidate, /\.candidate-domain-tabs \.candidate-domain-tab-option\s*\{[\s\S]*?flex:\s*1 1 0;[\s\S]*?margin-inline-end:\s*0;/);
assert.match(compactCandidate, /\.candidate-domain-option\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?white-space:\s*normal;[\s\S]*?overflow-wrap:\s*anywhere;/);
assert.match(styles, /\.candidate-focus-bar\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0;/);
assert.match(candidateV2, /\.candidate-identity-anchor\s*\{[\s\S]*?z-index:\s*9;[\s\S]*?min-height:\s*46px;/);
assert.match(candidateV2, /\.candidate-identity-anchor \.candidate-focus-identity\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?grid-template-columns:\s*minmax\(150px, 1\.2fr\) minmax\(120px, 0\.9fr\) max-content;/);
assert.match(candidateV2, /\.candidate-identity-anchor \.candidate-focus-(?:job|reference)[\s\S]*?overflow:\s*hidden;[\s\S]*?text-overflow:\s*ellipsis;/);
assert.match(app, /const CANDIDATE_LIST_SELECTED_WIDTH = 'clamp\(400px, 46%, 620px\)'/);
assert.match(app, /const CANDIDATE_LIST_EMPTY_WIDTH = 'clamp\(520px, 68%, 820px\)'/);
assert.match(app, /width=\{selectedId \? CANDIDATE_LIST_SELECTED_WIDTH : CANDIDATE_LIST_EMPTY_WIDTH\}/);
assert.doesNotMatch(app, /<Sider[\s\S]*?id=\{CANDIDATE_LIST_PANEL_ID\}[\s\S]*?width=\{300\}/);
assert.match(candidateDetail, /className="candidate-detail-unselected" role="status" aria-label="尚未选择候选人"/);
assert.match(styles, /\.candidate-detail-unselected\s*\{[\s\S]*?min-height:\s*72px;[\s\S]*?padding:\s*14px 16px;/);
assert.match(candidateList, /className="candidate-job-summary" title=\{summaryText\}/);
assert.match(candidateList, /className="candidate-next-action candidate-row-next" title=\{`下一步：\$\{work\.nextAction\}`\}/);
assert.match(candidateV2, /\.candidate-v2-list \.candidate-row-next > span:last-child\s*\{[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?text-overflow:\s*clip;[\s\S]*?white-space:\s*normal;/);
assert.match(styles, /@media \(min-width: 901px\) and \(max-width: 1180px\) \{[\s\S]*?\.topbar\s*\{[\s\S]*?grid-template-columns:\s*minmax\(280px, 410px\) minmax\(90px, 1fr\) max-content;[\s\S]*?\.topbar-actions\s*\{[\s\S]*?grid-column:\s*3;[\s\S]*?grid-row:\s*1;/);

function clampedCandidateWidth(workspaceWidth, minimum, ratio, maximum) {
  return Math.min(maximum, Math.max(minimum, workspaceWidth * ratio));
}

const candidateLayoutMeasurements = [1280, 1024].map((viewportWidth) => {
  const workspaceWidth = viewportWidth - 196;
  const selectedWidth = clampedCandidateWidth(workspaceWidth, 400, 0.46, 620);
  const emptyWidth = clampedCandidateWidth(workspaceWidth, 520, 0.68, 820);
  return {
    viewportWidth,
    workspaceWidth,
    selectedWidth,
    selectedRatio: selectedWidth / workspaceWidth,
    emptyWidth,
    emptyRatio: emptyWidth / workspaceWidth,
  };
});
for (const measurement of candidateLayoutMeasurements) {
  assert.ok(measurement.selectedRatio >= 0.45, `${measurement.viewportWidth}px selected list ratio must be at least 45%`);
  assert.ok(measurement.emptyRatio >= 0.45, `${measurement.viewportWidth}px unselected list ratio must be at least 45%`);
}

// At a 960px window the fixed desktop navigation and open candidate list leave
// roughly 446px inside the candidate card. The container rule, rather than a
// viewport-only media rule, must therefore own the primary domain collapse.
const syntheticCandidateCardWidth = 960 - 148 - 310 - (14 * 2) - (14 * 2);
assert.equal(syntheticCandidateCardWidth, 446);
assert.ok(syntheticCandidateCardWidth < 620, 'the 960px nested candidate surface must enter compact mode');

assert.match(deepProfile, /styles=\{\{ body: \{ maxHeight: '78vh', overflow: 'auto', overscrollBehavior: 'contain', scrollbarGutter: 'stable' \} \}\}/);
assert.match(ocrReview, /styles=\{\{ body: \{ maxHeight: 'calc\(100vh - 220px\)', overflowY: 'auto', overscrollBehavior: 'contain', scrollbarGutter: 'stable' \} \}\}/);
assert.match(jobLedger, /styles=\{\{ body: \{ maxHeight: '70vh', overflowY: 'auto', overscrollBehavior: 'contain', scrollbarGutter: 'stable' \} \}\}/);

const columnsStart = jobLedger.indexOf('const columns = useMemo(() => [');
const columnsEnd = jobLedger.indexOf('], [authorityWriteLocked, busy, committedPending', columnsStart);
assert.ok(columnsStart >= 0 && columnsEnd > columnsStart, 'job ledger columns must remain statically inspectable');
const jobColumns = jobLedger.slice(columnsStart, columnsEnd);
const expectedJobColumnOrder = ['岗位', '状态', '剩余 HC', '最近变更', 'HR 负责人', '计划 HC', '已录用', '候选人数', '操作'];
let previousColumnIndex = -1;
for (const title of expectedJobColumnOrder) {
  const columnIndex = jobColumns.indexOf(`title: '${title}'`);
  assert.ok(columnIndex > previousColumnIndex, `job ledger column ${title} must follow the agreed evidence-first order`);
  previousColumnIndex = columnIndex;
}
assert.match(jobColumns, /title: '岗位'[\s\S]*?fixed: 'left'/);
assert.match(jobColumns, /title: '操作'[\s\S]*?width: readOnly \? 164 : 216,[\s\S]*?fixed: 'right'/);
assert.match(jobLedger, /className="job-ledger-compact-list"[\s\S]*?filteredJobs\.map/,
  'job ledger must render the existing filtered truth as compact cards');
assert.match(workbenchV2, /@media \(max-width: 1679px\) \{[\s\S]*?\.job-ledger-table-card\s*\{[\s\S]*?display:\s*none;[\s\S]*?\.job-ledger-compact-list\s*\{[\s\S]*?display:\s*grid;/,
  'every width where the fixed action column would swallow data columns (table needs scroll.x 1680+) must use readable cards instead of a forced table canvas');
assert.match(jobLedger, /classNames=\{\{ body: 'job-ledger-summary-card-body' \}\}/,
  'job ledger summary cards must style their body through the AntD 5 public semantic slot');
assert.doesNotMatch(styles, /\.job-ledger-summary\s+\.ant-card-body/,
  'job ledger summary cards must not target AntD internal card body DOM');
for (const ownedTypographyClass of [
  'job-ledger-hero-title',
  'job-ledger-hero-copy',
  'job-ledger-name-meta',
  'job-ledger-recent-change-line',
]) {
  assert.match(jobLedger, new RegExp(`className="${ownedTypographyClass}"`),
    `job ledger must expose owned typography class ${ownedTypographyClass}`);
}
assert.doesNotMatch(styles, /\.job-ledger-(?:hero|name|recent-change)\s+\.ant-typography/,
  'job ledger typography must not target AntD internal typography DOM');

assert.match(talentPool, /const showUnifiedEmptyState = isEmptyLocalPool[\s\S]*?\(pool\?\.talents \|\| \[\]\)\.length === 0[\s\S]*?recommendations\.length === 0;/);
assert.match(talentPool, /\) : initialLoadError \? null : showUnifiedEmptyState \? \([\s\S]*?className="talent-pool-empty-state"[\s\S]*?<Empty/);
assert.ok(talentPool.indexOf('className="talent-pool-empty-state"') < talentPool.lastIndexOf('className="talent-pool-workspace"'), 'unified local empty state must short-circuit the talent workspace');
assert.match(decisionUi, /\.vl-empty-state-hint\s*\{[\s\S]*?font-size:\s*13px;/);
assert.match(styles, /\.talent-pool-fact-chain p\s*\{[\s\S]*?font-size:\s*13px;/);
assert.match(styles, /\.talent-pool-row-meta,[\s\S]*?font-size:\s*12px;/);
assert.match(talentPool, /<Progress[\s\S]*?className="talent-pool-evidence-progress"/,
  'talent evidence progress must expose an owned root class');
assert.doesNotMatch(styles, /\.talent-pool-row-side\s+\.ant-progress/,
  'talent evidence progress must not target AntD internal progress DOM');

assert.match(interviewSchedule, /return <section[\s\S]*?className="interview-schedule-panel interview-schedule-canonical"[\s\S]*?data-interview-workspace="canonical"[\s\S]*?<div className="interview-schedule-head">[\s\S]*?<Title level=\{2\}>/);
assert.match(decisionUi, /\.job-ledger-hero h2,[\s\S]*?\.talent-pool-hero h2,[\s\S]*?\.interview-schedule-head h2,[\s\S]*?\.settings-head h2\s*\{[\s\S]*?font-size:\s*var\(--hb-type-title\);[\s\S]*?font-weight:\s*600;/);
assert.match(interviewSchedule, /function InterviewScheduleLoadingState\([\s\S]*?<Skeleton active[\s\S]*?paragraph=\{\{ rows: 6/);
assert.match(interviewSchedule, /if \(!job\) \{[\s\S]*?<InterviewScheduleEmptyState/);
assert.match(interviewSchedule, /if \(loadState === 'error'\) \{[\s\S]*?error=\{loadError \|\| '当前无法确认面试安排；不会把读取失败当作空数据。'\}/);
assert.match(interviewSchedule, /if \(loadState === 'loading'\) \{[\s\S]*?<InterviewScheduleLoadingState/);
assert.match(styles, /\.interview-schedule-empty-state\s*\{[\s\S]*?min-height:\s*min\(52vh, 420px\);[\s\S]*?place-items:\s*center;/);

console.log(JSON.stringify({
  ok: true,
  contract: 'UI-RESPONSIVE-SURFACES-001',
  synthetic_candidate_card_width: syntheticCandidateCardWidth,
  candidate_layout_measurements: candidateLayoutMeasurements,
  candidate_tabs_use_container_query: true,
  long_preview_names_wrap: true,
  long_modals_contain_overscroll: true,
  job_ledger_column_order: expectedJobColumnOrder,
  job_ledger_write_action_width: 216,
  talent_pool_has_unified_local_empty_state: true,
  page_titles_use_shared_title_token: true,
}));
