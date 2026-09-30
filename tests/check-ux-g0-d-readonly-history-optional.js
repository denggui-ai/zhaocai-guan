'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = PROJECT_ROOT;
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const schedule = read('frontend/src/components/InterviewSchedulePanel.jsx');
const canonicalSchedule = read('frontend/src/components/InterviewScheduleCanonical.jsx');
const localInterview = read('frontend/src/components/LocalInterviewPanel.jsx');
const review = read('frontend/src/components/InterviewReviewPanel.jsx');
const settings = read('frontend/src/components/SettingsPanel.jsx');
const deepProfile = read('frontend/src/components/DeepProfileModal.jsx');
const assessment = read('frontend/src/components/AssessmentArchivePanel.jsx');
const candidate = read('frontend/src/components/CandidateDetail.jsx');
const app = read('frontend/src/App.jsx');

assert.doesNotMatch(schedule, /if \(!jobId \|\| readOnly\)/, 'readonly schedule must not skip history GETs');
assert.doesNotMatch(schedule, /\bapi\.|fetch\(/, 'fixture schedule must not touch production reads or writes');
assert.match(schedule, /<InterviewScheduleCanonical[\s\S]*?dataAdapter=\{fixtureAdapter\}[\s\S]*?fixtureMode/,
  'fixture history must use the canonical skeleton through its isolated adapter');
const canonicalLoadStart = canonicalSchedule.indexOf('async function loadCanonicalSessions(context)');
const canonicalLoadEnd = canonicalSchedule.indexOf('\n  async function ', canonicalLoadStart + 1);
const canonicalLoadHandler = canonicalSchedule.slice(canonicalLoadStart, canonicalLoadEnd);
assert.ok(canonicalLoadStart >= 0 && canonicalLoadEnd > canonicalLoadStart);
assert.match(canonicalLoadHandler, /scheduleAdapter\.listSessions\(null, context\.jobId\)/,
  'closed-job history must continue through the canonical read adapter');
assert.doesNotMatch(canonicalLoadHandler, /if \(readOnly\)/,
  'closed-job readonly must not skip canonical history reads');
assert.match(canonicalSchedule, /onClick=\{retryCanonicalSessions\}>重新读取正式面试<\/Button>/,
  'readonly canonical refresh must remain available');

assert.match(localInterview, /useEffect\(\(\) => \{[\s\S]*?if \(fixtureMode\)[\s\S]*?if \(READONLY_UI\)/,
  'global operational readonly must stop doctor/progress work without conflating closed-job readonly');
assert.match(localInterview, /refreshDoctor\(\);\s*refreshProgress\(\);/);
assert.match(localInterview, /progressKnown \? statusText\(job\.status, job\.mode\) : \(progressError \? '状态未知'/);
assert.match(localInterview, /function runDoctorCheck\(\) \{\s*if \(!fixtureMode\) return refreshDoctor\(\);/,
  'the shared doctor action must retain the production dependency check');
assert.match(localInterview, /const showDoctorRecovery = !taskBusy\s+&& !READONLY_UI/,
  'operational readonly and the secure-start phase must hide the conditional recording-environment recovery action');
assert.match(localInterview, /\{showDoctorRecovery && \([\s\S]*?loading=\{busy\}[\s\S]*?onClick=\{\(\) => runAction\(runDoctorCheck\)\}[\s\S]*?disabled=\{busy\}/,
  'the doctor action must use the fixture-safe adapter and remain locked in operational readonly');
assert.match(localInterview, /岗位已关闭；不能开始录音或导入。当前岗位的运行任务仍可停止并清理/);
assert.match(localInterview, /disabled=\{readOnly \|\| busy \|\| taskBusy \|\| degraded/,
  'recording/import writes must remain locked while readonly or a task is active/cleaning');
assert.match(localInterview, /async function chooseFile\(\) \{\s*if \(readOnly\)/,
  'native media picker needs a handler-level readonly gate');

assert.match(review, /if \(READONLY_UI\) return undefined;/);
assert.doesNotMatch(review, /if \(readOnly \|\| !candidateId \|\| !jobId\)/);
assert.match(review, /api\.getInterviewConsent\(candidateId, jobId\)/);
assert.match(review, /localJobKnown \? localJob : \{ status: 'unknown' \}/);
assert.match(review, /disabled=\{\s*READONLY_UI[\s\S]*?\|\| consentBusy[\s\S]*?\|\| consentRevocationPending[\s\S]*?\|\| terminationPending[\s\S]*?\|\| !consentKnown/,
  'consent input must remain locked while local recording termination or cleanup is unresolved');
assert.match(review, /查看 AI 设置/);

assert.match(settings, /api\.getLlmConfig\(\)/);
assert.match(settings, /只读模式仍读取已保存的外部 AI 状态/);
assert.match(settings, /disabled=\{READONLY_UI \|\| doctorLoading\} onClick=\{runDoctor\}/);
assert.doesNotMatch(settings, /返回工作台连接 Boss/,
  'settings must not route users back to a removed global operation menu');

assert.match(deepProfile, /DeepProfileModal\(\{[\s\S]*?open,[\s\S]*?jobId,[\s\S]*?jobName,[\s\S]*?readOnly = false,/);
assert.match(deepProfile, /const writeLocked = readOnly \|\| READONLY_UI/);
assert.match(deepProfile, /既有负责人访谈和深度画像仍会从本地主库读取/);
assert.doesNotMatch(app, /\{!jobReadOnly && deepOpen && \(/, 'closed/global readonly must still mount deep-profile history');
assert.match(app, /<DeepProfileModal[\s\S]*?readOnly=\{jobReadOnly \|\| currentJobIsFixture\}/,
  'closed/global readonly and fixture jobs must retain history while keeping deep-profile writes locked');
const deepProfileGuideHandlerStart = app.indexOf('function handleOpenDeepProfileFromGuide()');
const deepProfileGuideHandlerEnd = app.indexOf('\n  function ', deepProfileGuideHandlerStart + 1);
const deepProfileGuideHandler = app.slice(deepProfileGuideHandlerStart, deepProfileGuideHandlerEnd);
assert.ok(deepProfileGuideHandlerStart >= 0 && deepProfileGuideHandlerEnd > deepProfileGuideHandlerStart);
assert.doesNotMatch(deepProfileGuideHandler, /if \(jobClosed\)|if \(READONLY_UI\)/);
assert.match(app, /onOpenSettings=\{\(\) => handleOpenSettings\('settings-interview-tools', '面试安排'\)\}/);
assert.match(app, /async function handleImportScreenshots\(\) \{\s*if \(READONLY_UI\)/);

assert.doesNotMatch(assessment, /readOnly\s*\? Promise\.resolve\(\{ config: null \}\)/);
assert.match(assessment, /查看 AI 配置状态/);
assert.match(assessment, /disabled=\{READONLY_UI \|\| busy\}/,
  'global operational readonly must disable dynamic preview without blocking closed-job preview');
assert.doesNotMatch(candidate, /if \(readOnly && !assessmentMaintenanceAllowed\)/);
assert.doesNotMatch(candidate, /!candidate \|\| !candidate\.internal_id \|\| readOnly/);
assert.doesNotMatch(candidate, /!readOnly && <AssessPrerequisites/, 'readonly candidate history must retain assessment prerequisite recovery entries');
assert.match(candidate, /查看简历材料/);
assert.match(candidate, /onOpenSettings=\{onOpenAiSettings\}/);

const writeLockContracts = [
  /disabled=\{readOnly \|\| taskBusy\}/,
  /disabled=\{readOnly \|\| busy \|\| taskBusy \|\| degraded \|\| !ready \|\| !micCheckConsent\}/,
  /const showStopAction = currentRecordingRunning/,
  /const administrativeReadOnly = readOnly && !assessmentMaintenanceAllowed/,
];
for (const contract of writeLockContracts) {
  assert.match(`${localInterview}\n${review}\n${assessment}`, contract, `missing readonly write lock: ${contract}`);
}

console.log(JSON.stringify({
  ok: true,
  contract: 'UX-G0-D-READONLY-HISTORY-OPTIONAL',
  readonly_gets_preserved: true,
  readonly_writes_locked: true,
  stale_history_preserved: true,
  recovery_entries_present: true,
  closed_job_history_preserved: true,
  operational_readonly_side_effects_stopped: true,
  app_deep_profile_mount_integration_required: false,
  global_readonly_projection_required: false,
}, null, 2));
