const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
}

const api = read('frontend/src/api.js');
const panel = read('frontend/src/components/InterviewReviewPanel.jsx');

for (const endpoint of [
  '/interview-lifecycle/status?sessionId=',
  '/interview-lifecycle/withdraw',
  '/interview-lifecycle/close',
  '/interview-lifecycle/legal-hold/apply',
  '/interview-lifecycle/legal-hold/release',
  '/interview-lifecycle/deletion/dry-run',
  '/interview-lifecycle/deletion/confirm',
]) {
  assert.ok(api.includes(endpoint), `frontend API must expose ${endpoint}`);
}

const lifecycleApiSection = api.slice(
  api.indexOf('withdrawInterviewLifecycle:'),
  api.indexOf('listCandidateInterviewRecordings:'),
);
assert.doesNotMatch(lifecycleApiSection, /actorRole|actor_role/, 'renderer must not choose lifecycle actor role');
assert.match(lifecycleApiSection, /confirmed:\s*true/, 'dangerous lifecycle requests must carry explicit confirmation');

assert.match(panel, /function LifecycleManagementCard/);
assert.match(panel, /api\.getInterviewLifecycleStatus\(session\.id\)/);
assert.match(panel, /lifecycle\.active_holds/);
assert.match(panel, /\['active', 'closed', 'withdrawn'\]\.includes\(lifecycleState\)/);
assert.match(panel, /blocked \|\| terminal/);
assert.match(panel, /生命周期状态不可读，所有管理动作已禁用/);
assert.match(panel, /lifecycleBusyRef/);
assert.match(panel, /readOnly \|\| !!busyKey/);
assert.match(panel, /modal\.confirm\(\{/);
assert.match(panel, /WITHDRAW_REASON_OPTIONS/);
assert.match(panel, /CLOSE_REASON_OPTIONS/);
assert.match(panel, /HOLD_REASON_OPTIONS/);
assert.match(panel, /previewInterviewDeletion\(session\.id\)/);
assert.match(panel, /manifest\.item_count/);
assert.match(panel, /manifest\.confirmation_token/);
assert.match(panel, /confirmInterviewDeletion\(/);
assert.match(panel, /服务端 dry-run 已锁定/);
assert.match(panel, /确认凭据仅在本次操作中传回服务端/);
assert.doesNotMatch(panel, /actionPost\(/, 'component must use the shared API adapter');

console.log(JSON.stringify({ ok: true, contract: 'f010-lifecycle-ui-v1' }));
