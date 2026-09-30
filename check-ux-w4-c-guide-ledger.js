#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
}

const app = read('frontend/src/App.jsx');
const dashboard = read('frontend/src/components/DashboardPanel.jsx');
const guide = read('frontend/src/components/WorkflowGuidePanel.jsx');
const ledger = read('frontend/src/components/JobLedgerPanel.jsx');
const workbenchStyles = read('frontend/src/workbench-v2.css');

const populatedDashboardStart = dashboard.indexOf('\n  return (', dashboard.indexOf('\n  if (!workbench)'));
const populatedDashboard = dashboard.slice(populatedDashboardStart, dashboard.lastIndexOf('\n}'));
assert.ok(populatedDashboardStart >= 0, 'populated dashboard branch must remain statically inspectable');
assert.equal(
  (populatedDashboard.match(/onOpenNav\('候选人'\)/g) || []).length,
  1,
  'populated dashboard must keep one generic candidate entry in the page header',
);
assert.match(populatedDashboard, />候选人队列<\/Button>/);
assert.doesNotMatch(populatedDashboard, />检查候选人<|>筛选与回填沟通</);
assert.match(populatedDashboard, /onOpenTodo[\s\S]*?onOpenNav\(navForTodo\(item\.code\)\)/,
  'targeted todo navigation must remain available');
assert.match(dashboard, /const secondaryGuideProps = \{ \.\.\.guideProps, showAction: false \}/);
assert.match(populatedDashboard, /<WorkflowGuideSummary \{\.\.\.secondaryGuideProps\} \/>/);
assert.match(populatedDashboard, /<AiValueSummary \{\.\.\.secondaryGuideProps\} \/>/);

assert.match(guide, /jobsLoadState === 'error' && job \? 'stale' : jobsLoadState/);
assert.match(guide, /loadState === 'error' && workbench \? 'stale' : loadState/);
assert.match(guide, /states\.includes\('error'\)[\s\S]*?states\.includes\('loading'\)[\s\S]*?states\.includes\('stale'\)/);
const aiSummary = guide.slice(
  guide.indexOf('export function AiValueSummary'),
  guide.indexOf('function AiCapabilityGuide'),
);
assert.match(aiSummary, /const current = suggestionUnavailable \? null : deriveAiValueSuggestion\(props\)/);
assert.match(aiSummary, /读取失败，暂不推荐 AI 能力[\s\S]*?不会把未知状态推断成确定步骤/);

const guideSummary = guide.slice(
  guide.indexOf('export function WorkflowGuideSummary'),
  guide.indexOf('export default function WorkflowGuidePanel'),
);
assert.ok(
  guideSummary.indexOf("authorityState === 'loading' || authorityState === 'error'")
    < guideSummary.indexOf('const guide = deriveWorkflowGuide(props)'),
  'summary must fail closed before deriving a current step',
);
assert.match(guideSummary, /当前状态尚未确认，因此暂不推断下一步/);
assert.match(guideSummary, /stale \? '上次成功数据建议' : '当前建议'/);

const fullGuide = guide.slice(guide.indexOf('export default function WorkflowGuidePanel'));
assert.ok(
  fullGuide.indexOf("authorityState === 'loading' || authorityState === 'error'")
    < fullGuide.indexOf('const guide = deriveWorkflowGuide(props)'),
  'full guide must fail closed before deriving a current step',
);
assert.match(fullGuide, /使用指南所需状态读取失败[\s\S]*?不会据此推断下一步/);
assert.match(fullGuide, /当前显示上次成功读取的指南内容[\s\S]*?action=\{retryAction\}/);
assert.doesNotMatch(guide, /from ['"]\.\.\/api\.js['"]|\bapi\.|\bfetch\(/,
  'guide authority state must reuse App reads instead of creating another data source');

const guideWiring = app.slice(
  app.indexOf('<WorkflowGuidePanel'),
  app.indexOf('/>', app.indexOf('<WorkflowGuidePanel')) + 2,
);
for (const prop of [
  'jobsLoadState={jobsState}',
  'jobsLoadError={jobsError}',
  'loadState={workbenchState}',
  'loadError={workbenchError}',
  'onRetry={() => boot()}',
]) {
  assert.ok(guideWiring.includes(prop), `App must pass existing guide authority prop ${prop}`);
}

assert.match(ledger, /<ul className="job-ledger-compact-list" aria-label="岗位台账卡片列表">[\s\S]*?filteredJobs\.map/);
assert.match(ledger, /className="job-ledger-compact-facts"[\s\S]*?<dt>剩余 HC<\/dt>[\s\S]*?<dt>HR 负责人<\/dt>/);
assert.match(ledger, /className="job-ledger-compact-actions"[\s\S]*?renderJobActions\(ledgerJob\)/);
assert.match(ledger, /<Table[\s\S]*?dataSource=\{filteredJobs\}/,
  'wide table and compact cards must share the existing filteredJobs truth');
assert.match(workbenchStyles, /\.job-ledger-compact-list\s*\{[\s\S]*?display:\s*none;/);
const compactLedgerStyles = workbenchStyles.slice(workbenchStyles.indexOf('@media (max-width: 1679px)'));
assert.match(compactLedgerStyles, /\.job-ledger-table-card\s*\{[\s\S]*?display:\s*none;/);
assert.match(compactLedgerStyles, /\.job-ledger-compact-list\s*\{[\s\S]*?display:\s*grid;/);
assert.match(compactLedgerStyles, /\.job-ledger-compact-facts\s*\{[\s\S]*?grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\);/);
assert.doesNotMatch(compactLedgerStyles, /\.job-ledger-page\s*\{[\s\S]*?overflow-x:\s*(?:hidden|clip)/,
  'compact ledger must fit its content rather than hiding page-level overflow');

for (const source of [dashboard, guide, ledger]) {
  assert.doesNotMatch(source, /dashboard builder|治理中心|遥测平台|tenant|multi-tenant/i);
}

console.log(JSON.stringify({
  ok: true,
  contract: 'UX-W4-C-GUIDE-LEDGER',
  dashboard_generic_candidate_entries: 1,
  guide_loading_error_fail_closed: true,
  guide_stale_retry: true,
  ledger_compact_breakpoint: 1679,
  ledger_uses_existing_filtered_truth: true,
  new_state_service: false,
  new_dependency: false,
}));
