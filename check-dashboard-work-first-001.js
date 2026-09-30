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

const populatedReturnStart = dashboard.indexOf('\n  return (', dashboard.indexOf('\n  if (!workbench)'));
const populatedReturn = dashboard.slice(populatedReturnStart, dashboard.lastIndexOf('\n}'));
const workbenchIndex = populatedReturn.indexOf('className="dashboard-head"');
const metricsIndex = populatedReturn.indexOf('className="dashboard-metrics"');
const todoIndex = populatedReturn.indexOf('className="dashboard-main-grid"');
const guidanceIndex = populatedReturn.indexOf('className="dashboard-secondary-guidance"');

assert.ok(workbenchIndex >= 0, 'populated dashboard must render the HR workbench heading');
assert.ok(metricsIndex > workbenchIndex, 'metrics must follow the workbench heading');
assert.ok(todoIndex > metricsIndex, 'todos must follow metrics in the primary work area');
assert.ok(guidanceIndex > todoIndex, 'workflow and AI guidance must be secondary to work and todos');
assert.match(populatedReturn, /<Collapse[\s\S]*label: '使用流程与当前建议'[\s\S]*label: 'AI 招聘助手说明'/);
assert.doesNotMatch(populatedReturn.slice(0, workbenchIndex), /WorkflowGuideSummary|AiValueSummary/);

const firstUseBranch = dashboard.match(/if \(!jobId \|\| loadState === 'idle'\) \{[\s\S]*?\n  \}/)?.[0] || '';
assert.match(firstUseBranch, /WorkflowGuideSummary/);
assert.match(firstUseBranch, /AiValueSummary/);
assert.match(firstUseBranch, /去新建岗位/);

const beginJobContext = app.match(/function beginJobContext\(id\) \{[\s\S]*?\n  \}/)?.[0] || '';
for (const reset of ["setQuery('')", "setComm('')", "setDisp('')", "setSabc('')", "setEducation('')"]) {
  assert.ok(beginJobContext.includes(reset), `job switch must reset ${reset}`);
}
assert.match(app, /<CandidateList[\s\S]*key=\{`candidate-list-\$\{jobId \?\? 'none'\}`\}/);

console.log(JSON.stringify({
  ok: true,
  contract: 'DASHBOARD-WORK-FIRST-001',
  populated_dashboard_order: ['workbench', 'metrics', 'todos', 'collapsed-guidance'],
  first_use_guidance_preserved: true,
  job_switch_filters_reset: true,
}));
