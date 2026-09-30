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

const shared = read('frontend/src/components/job-management-workspace.jsx');
const formal = read('frontend/src/components/JobManagementPanel.jsx');
const fixture = read('frontend/src/components/JobManagementDemo.jsx');
const app = read('frontend/src/App.jsx');
const fixtureRuntime = fixture.slice(fixture.indexOf('export default function JobManagementDemo'));
assert.match(fixture, /import \{ Alert,[\s\S]*?\} from 'antd';/,
  'fixture readonly branch must import the Alert component it renders');
const fixtureRender = fixtureRuntime.slice(fixtureRuntime.indexOf('return (\n    <JobManagementWorkspace'));

const actionIds = [
  'navigate-section',
  'edit-draft',
  'reset-draft',
  'optimize-jd',
  'copy-jd',
  'save-jd-draft',
  'activate-jd-version',
  'save-profile-draft',
  'confirm-profile-version',
  'refresh-data',
];

for (const actionId of actionIds) {
  assert.match(shared, new RegExp(`id: '${actionId}'`), `shared action schema missing ${actionId}`);
}
assert.equal((shared.match(/value: 'jd'/g) || []).length, 1, 'shared navigation must expose one JD section');
assert.equal((shared.match(/value: 'profile'/g) || []).length, 1, 'shared navigation must expose one profile section');
assert.doesNotMatch(shared, /value: '(?:overview|funnel|logs)'/, 'shared navigation must not retain fixture-only sections');

for (const [name, source] of [['formal', formal], ['fixture', fixture]]) {
  assert.match(source, /createJobManagementActionAdapter/,
    `${name} job management must construct the shared action adapter`);
  assert.match(source, /JOB_MANAGEMENT_ACTION_SCHEMA/,
    `${name} job management must consume the shared action schema`);
  assert.match(source, /<JobManagementWorkspace/,
    `${name} job management must render the shared workspace skeleton`);
}

const bodyJobTitlePattern = /<Title\b(?=[^>]*\blevel=\{3\})[^>]*>/g;
assert.equal((shared.match(bodyJobTitlePattern) || []).length, 1,
  'the shared workspace must own the single body job title');
assert.doesNotMatch(formal, /<Title\b(?=[^>]*\blevel=\{3\})[^>]*>/,
  'formal adapter must not add a second body job title');
assert.doesNotMatch(fixture, /<Title\b(?=[^>]*\blevel=\{3\})[^>]*>/,
  'fixture adapter must not add a second body job title');
assert.match(shared, /typeof onReturnLedger === 'function'[\s\S]*?>返回岗位台账<\/Button>/,
  'shared workspace must expose one optional return-to-ledger capability');
assert.equal((app.match(/onReturnLedger=\{handleReturnJobLedger\}/g) || []).length, 2,
  'App must wire the one shared return-to-ledger capability into both adapters');
assert.doesNotMatch(app, /className="job-editor-toolbar"/,
  'App must not retain the former duplicate title/return toolbar');

assert.match(fixtureRuntime, /const \[activeSection, setActiveSection\] = useState\('jd'\)/);
assert.match(fixtureRender, /activeSection === 'jd'/);
assert.match(fixtureRender, /activeSection === 'profile'/);
assert.doesNotMatch(fixtureRender, /activeSection === '(?:overview|funnel|logs)'/,
  'fixture runtime must not retain its former second navigation structure');
assert.doesNotMatch(fixtureRender, /<JobList|<PrimaryJobActions|<PriorityStrip|<SectionTabs|<JobOperationPanel/,
  'fixture runtime must not render a second job selector or local publish/refresh surface');

assert.match(fixtureRuntime, /const fixtureLocked = readOnly \|\| selectedJob\?\.status === 'closed' \|\| status === 'closed';/);
assert.doesNotMatch(fixture, /window\.localStorage|\.setItem\(|\.getItem\(/,
  'fixture state must remain ephemeral and must not write or read business-looking localStorage state');
assert.match(fixtureRuntime, /const \[localStates, setLocalStates\] = useState\(\{\}\);/);
assert.match(fixtureRuntime, /function pushLocalState[\s\S]*?if \(!selectedJob \|\| fixtureLocked\) return false;/);
assert.match(fixtureRuntime, /function updateLocalEditDraft[\s\S]*?if \(!selectedJob \|\| fixtureLocked\) return false;/);
assert.match(fixtureRuntime, /function resetLocalEditDraft[\s\S]*?if \(fixtureLocked\) return false;/);
assert.match(fixtureRuntime, /async function handleJdAssistantAction[\s\S]*?if \(!selectedJob \|\| fixtureLocked\) return false;/);

const editCard = functionSlice(fixture, 'function LocalJobEditCard', 'function checkTone');
assert.equal((editCard.match(/disabled=\{locked\}/g) || []).length, 9,
  'all seven fixture inputs plus reset/save controls must be disabled when locked');
const assistantCard = functionSlice(fixture, 'function JdAssistantCard', 'const DIAGNOSTIC_RISK_META');
assert.equal((assistantCard.match(/<Button disabled=\{locked\}/g) || []).length, 5,
  'every visible fixture JD simulation control must be disabled when locked');
assert.match(fixtureRender, /description="所有输入与模拟状态动作均已禁用；不会修改 localStorage、调用生产 IPC 或访问外部服务。"/);
assert.match(fixtureRender, /disabled=\{fixtureLocked\}[\s\S]*?模拟保存岗位画像草稿/);
assert.match(fixtureRender, /disabled=\{fixtureLocked\}[\s\S]*?模拟确认岗位画像版本/);

assert.doesNotMatch(fixture, /\bapi\.[A-Za-z_$][\w$]*\s*\(/,
  'fixture adapter must not call production API/IPC methods');
assert.doesNotMatch(fixture, /window\.(?:electron|hrboss)|ipcRenderer|\bfetch\s*\(/,
  'fixture adapter must not call production IPC or external HTTP');
for (const misleadingLabel of ['发布职位', '曝光刷新', '标记发布', '标记暂停', '关闭职位']) {
  assert.doesNotMatch(fixture, new RegExp(`>\\s*${misleadingLabel}\\s*<`),
    `fixture action “${misleadingLabel}” must be explicitly labelled as simulation`);
}
assert.match(fixture, /Fixture · 隔离模拟|Fixture 隔离|模拟保存 JD 草稿/);

console.log(JSON.stringify({
  ok: true,
  contract: 'UX-W1-A-JOB-PARITY',
  shared_workspace: true,
  shared_navigation: ['jd', 'profile'],
  shared_action_schema: actionIds,
  fixture_production_ipc_calls: 0,
  readonly_fixture_storage_writes: 0,
  app_return_wiring_pending: false,
}));
