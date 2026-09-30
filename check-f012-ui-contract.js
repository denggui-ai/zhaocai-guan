const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(file) { return fs.readFileSync(path.join(__dirname, file), 'utf8'); }
const app = read('frontend/src/App.jsx');
const dashboard = read('frontend/src/components/DashboardPanel.jsx');
const styles = read('frontend/src/styles.css');
const candidates = read('frontend/src/components/CandidateList.jsx');
const talent = read('frontend/src/components/TalentPoolDemo.jsx');
const interview = read('frontend/src/components/InterviewReviewPanel.jsx');

assert.match(app, /jobRequestRef/);
assert.match(app, /detailRequestRef/);
assert.match(app, /detailState/);
assert.match(app, /候选人详情读取失败/);
assert.match(app, /setCandidates\(\[\]\)/);
assert.match(app, /setWorkbench\(null\)/);
assert.match(app, /jobRequestRef\.current\.isCurrent/);
assert.match(app, /job\?\.is_fixture \? <JobManagementDemo/);
assert.match(app, /InterviewScheduleCanonical/);
assert.match(dashboard, /workbench\.todos/);
assert.doesNotMatch(dashboard, /verdict_label|geek_desc|待约\|约面|正文|备注/);
assert.doesNotMatch(dashboard, /canonical workflow v1|候选人 canonical 队列|Fixture/);
assert.match(dashboard, />候选人队列<\/Button>/);
assert.doesNotMatch(dashboard, /item\.source\.entity_type|item\.source\.entity_id|item\.source\.status/);
assert.match(dashboard, /TODO_DESCRIPTIONS\[item\.code\]/);
assert.match(styles, /\.dashboard-main-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr;/);
assert.match(styles, /\.dashboard-todo-row\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) max-content;/);
assert.match(candidates, /workflow_status/);
assert.doesNotMatch(candidates, /ARCHIVED_RE|REVIEW_RE|INTERVIEW_RE|CONTACT_RE|NEW_RE/);
assert.match(talent, /requestRef/);
assert.match(talent, /nextDemoMode && !fixtureJob/);
assert.match(interview, /loadRequestRef/);
assert.match(interview, /setSessions\(\[\]\)/);
assert.match(interview, /setAssignments\(\[\]\)/);

import('./frontend/src/request-epoch.js').then(({ createRequestEpoch }) => {
  const guard = createRequestEpoch();
  const first = guard.begin();
  const second = guard.begin();
  assert.equal(guard.isCurrent(first), false, 'late first request must be rejected');
  assert.equal(guard.isCurrent(second), true, 'latest request must be accepted');
  guard.invalidate();
  assert.equal(guard.isCurrent(second), false, 'job/candidate switch must invalidate in-flight request');
  console.log(JSON.stringify({ ok: true, contract: 'f012-ui-race-fixture-state-v1' }));
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
