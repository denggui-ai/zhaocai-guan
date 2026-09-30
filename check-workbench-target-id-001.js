'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
const dashboard = read('frontend/src/components/DashboardPanel.jsx');
const app = read('frontend/src/App.jsx');
const schedule = read('frontend/src/components/InterviewScheduleCanonical.jsx');

assert.match(dashboard, /onOpenTodo\(item, navForTodo\(item\.code\)\)/, 'dashboard must preserve the complete todo instead of flattening it to a nav name');
assert.match(dashboard, /onOpenTodo[\s\S]*onOpenNav\(navForTodo\(item\.code\)\)/, 'older callers without a todo handler must keep module navigation');
assert.match(app, /const action = item\?\.action \|\| \{\}/);
assert.match(app, /const targetId = action\.target_id/);

for (const [type, domain, interviewTab] of [
  ['open_candidate', 'profile', 'review'],
  ['open_candidate_interview', 'interview', 'prepare'],
  ['open_candidate_final_review', 'final-review', 'review'],
]) {
  assert.match(app, new RegExp(`${type}: \\{ domain: '${domain}', interviewTab: '${interviewTab}' \\}`), `${type} must open the existing candidate destination`);
}
assert.match(app, /handleSelectCandidate\(targetId, context, \{[\s\S]*?notifyError: false,[\s\S]*?initialDomain: candidateTarget\.domain,[\s\S]*?initialInterviewTab: candidateTarget\.interviewTab/,
  'candidate targets must be consumed by the existing selection path with their exact workspace target');
assert.match(app, /itemJobId != null && !sameJobId\(itemJobId, context\.jobId\)/, 'stale job todos must not navigate back to an old job');
assert.match(app, /setWorkbenchNavigationTarget\(null\)/, 'job and manual module changes must clear old interview targets');

assert.match(app, /actionType === 'open_session' \|\| actionType === 'open_report'/);
assert.match(app, /type: actionType === 'open_report' \? 'report' : 'session'/);
assert.match(app, /navigationTarget=\{workbenchNavigationTarget\}/);
assert.match(schedule, /navigationTarget\.type === 'report'[\s\S]*session\.report_id/);
assert.match(schedule, /String\(session\.id\) === String\(navigationTarget\.targetId\)/);
assert.match(schedule, /sameJobId\(session\.job_id, navigationTarget\.jobId\)/, 'session/report lookup must stay inside the current job');
assert.match(schedule, /sessionCardRefs\.current\.get\(String\(matchedSession\.id\)\)/);
assert.match(schedule, /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/);
assert.match(schedule, /data-workbench-focus=/);

assert.match(app, /open_interview_assignment[\s\S]*没有稳定的对象锚点，已打开面试安排模块/);
assert.match(app, /retry_task[\s\S]*没有独立详情锚点，已打开对应模块/);
assert.match(app, /未能刷新该候选人；已保留最近一次成功详情或当前错误恢复入口/);
assert.match(schedule, /未找到该报告所属的面试轮次，已打开当前岗位的面试安排/);
assert.match(schedule, /未找到该面试轮次，已打开当前岗位的面试安排/);

assert.doesNotMatch(app, /react-router|createBrowserRouter|history\.pushState/);
assert.doesNotMatch(schedule, /通用深链|导航历史|deep.?link/i);

console.log(JSON.stringify({
  ok: true,
  contract: 'WORKBENCH-TARGET-ID-001',
  precise_targets: ['candidate', 'session', 'report', 'job'],
  module_fallbacks: ['material', 'retry', 'missing-target'],
  stale_job_target_rejected: true,
  router_or_schema_added: false,
}));
