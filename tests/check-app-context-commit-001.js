
const { PROJECT_ROOT } = require("../src/paths");
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/App.jsx'), 'utf8');

function functionSource(name, nextName) {
  const start = app.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = nextName ? app.indexOf(`async function ${nextName}(`, start + 1) : -1;
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
  return app.slice(start, end);
}

const resumeCommit = functionSource('handleCommitCandidateFromResume', 'handleAssess');
const assessmentCommit = functionSource('handleAssess', 'handleRunRate');
const screenshotPoll = app.slice(
  app.indexOf('async function pollScreenshotImportProgress'),
  app.indexOf('function handleBrandNameChange', app.indexOf('async function pollScreenshotImportProgress')),
);

const resumeCommittedAt = resumeCommit.indexOf('committed = true');
const resumeDraftClosedAt = resumeCommit.indexOf('setResumeCandidateDraft(null)', resumeCommittedAt);
const resumeRefreshAt = resumeCommit.indexOf('await loadCandidates(context.jobId)', resumeDraftClosedAt);
assert.ok(resumeCommittedAt > -1, 'resume intake must mark the backend write committed');
assert.ok(resumeDraftClosedAt > resumeCommittedAt, 'the single-use resume draft must close immediately after commit');
assert.ok(resumeRefreshAt > resumeDraftClosedAt, 'refresh must happen only after the committed boundary');
assert.match(resumeCommit, /if \(committed\)[\s\S]*简历建档已完成，但数据暂未刷新/);
assert.match(resumeCommit, /勿重复提交/);

assert.equal((assessmentCommit.match(/committed = true/g) || []).length, 2, 'both local-demo and external assessment writes must cross the committed boundary');
assert.match(assessmentCommit, /refreshCandidateDetail\(context, \{ notifyError: false \}\)/);
assert.match(assessmentCommit, /if \(!refreshed\)[\s\S]*已生成，但数据暂未刷新/);
assert.match(assessmentCommit, /if \(committed\)[\s\S]*匹配报告已生成，但数据暂未刷新/);
assert.match(assessmentCommit, /else \{\s*message\.error\(`评估失败/);

assert.match(screenshotPoll, /const targetJobId = result\.job_id/);
assert.match(screenshotPoll, /!targetJobId \|\| !sameJobId\(targetJobId, context\.jobId\)/);
assert.match(screenshotPoll, /当前岗位未切换；需要时请切换岗位后手动打开校对/);
assert.match(screenshotPoll, /loadCandidates\(context\.jobId\)/);
assert.match(screenshotPoll, /isCurrentJobContext\(currentJobContextRef, context\)/);
assert.doesNotMatch(screenshotPoll, /refreshJobs\(/, 'screenshot completion must not switch jobs');
assert.doesNotMatch(screenshotPoll, /setSelectedId\(null\)|setDetail\(null\)/, 'screenshot completion must not clear the current candidate');
assert.ok(
  screenshotPoll.indexOf('!targetJobId || !sameJobId(targetJobId, context.jobId)')
    < screenshotPoll.indexOf('setScreenshotImportProgress(progress)'),
  'a completed import for another job must be rejected before progress reaches the current TopBar',
);

assert.match(app, /<TopBar\s+[\s\S]*?readOnly=\{jobReadOnly\}/);

console.log(JSON.stringify({
  ok: true,
  contract: 'app-context-commit-001',
  screenshot_job_context_bound: true,
  committed_write_refresh_split: true,
  closed_job_topbar_readonly: true,
}));
