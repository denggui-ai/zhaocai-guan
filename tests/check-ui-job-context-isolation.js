
const { PROJECT_ROOT } = require("../src/paths");
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = PROJECT_ROOT;
const app = fs.readFileSync(path.join(root, 'frontend/src/App.jsx'), 'utf8');
const schedule = fs.readFileSync(path.join(root, 'frontend/src/components/InterviewScheduleCanonical.jsx'), 'utf8');
const deepProfile = fs.readFileSync(path.join(root, 'frontend/src/components/DeepProfileModal.jsx'), 'utf8');

function nextContext(current, jobId) {
  return { jobId, token: current.token + 1 };
}

function isCurrent(current, captured) {
  return current.token === captured.token && String(current.jobId) === String(captured.jobId);
}

function nextCandidateContext(current, jobId, candidateId) {
  return { jobId, candidateId, token: current.token + 1 };
}

function isCurrentCandidate(current, captured) {
  return current.token === captured.token
    && String(current.jobId) === String(captured.jobId)
    && String(current.candidateId) === String(captured.candidateId);
}

const jobA = nextContext({ jobId: null, token: 0 }, 1);
const oldJobARequest = { ...jobA };
const jobB = nextContext(jobA, 2);
assert.equal(isCurrent(jobB, oldJobARequest), false, 'a late job A response must be stale after switching to job B');
const jobAAgain = nextContext(jobB, 1);
assert.equal(isCurrent(jobAAgain, oldJobARequest), false, 'a job token must also reject A -> B -> A late responses');

const candidateA = nextCandidateContext({ jobId: 1, candidateId: null, token: 0 }, 1, 'candidate-A');
const oldCandidateARequest = { ...candidateA };
const candidateB = nextCandidateContext(candidateA, 1, 'candidate-B');
assert.equal(
  isCurrentCandidate(candidateB, oldCandidateARequest),
  false,
  'a late candidate A callback must not replace candidate B in the same job',
);
const candidateAAgain = nextCandidateContext(candidateB, 1, 'candidate-A');
assert.equal(
  isCurrentCandidate(candidateAAgain, oldCandidateARequest),
  false,
  'a candidate token must reject A -> B -> A late callbacks',
);

assert.match(app, /currentJobContextRef = useRef\(\{ jobId: null, token: 0 \}\)/);
assert.match(app, /CURRENT_JOB_ID_STORAGE_KEY = 'hrboss\.ui\.currentJobId\.v1'/);
assert.match(app, /function readStoredJobId\(\)[\s\S]*localStorage\.getItem\(CURRENT_JOB_ID_STORAGE_KEY\)/);
const persistUiPreferenceSource = app.match(/function persistUiPreference\(key, value\) \{[\s\S]*?^\}/m)?.[0] || '';
assert.match(
  persistUiPreferenceSource,
  /if \(READONLY_UI \|\| typeof window === 'undefined'\) return false;[\s\S]*window\.localStorage\.setItem\(key, String\(value\)\)/,
  'operational readonly must return false before persistUiPreference can call localStorage.setItem',
);
assert.match(
  app,
  /function writeStoredJobId\(value\) \{[\s\S]*?if \(READONLY_UI \|\| typeof window === 'undefined'\) return false;[\s\S]*?if \(value == null\)[\s\S]*?localStorage\.removeItem\(CURRENT_JOB_ID_STORAGE_KEY\)[\s\S]*?return persistUiPreference\(CURRENT_JOB_ID_STORAGE_KEY, value\);[\s\S]*?\}/,
  'selected-job persistence must preserve the readonly guard and delete stale authority when the job list becomes empty',
);
assert.match(app, /function beginJobContext\(id\)[\s\S]*writeStoredJobId\(id\)/);
assert.match(app, /function clearJobContext\(\)[\s\S]*writeStoredJobId\(null\)[\s\S]*setJobId\(null\)[\s\S]*setCandidates\(\[\]\)[\s\S]*setDetail\(null\)/);
assert.match(app, /const jobsRef = useRef\(jobs\)[\s\S]*const jobsStateRef = useRef\(jobsState\)[\s\S]*jobsRef\.current = jobs[\s\S]*jobsStateRef\.current = jobsState/);
assert.match(
  app,
  /function authoritativeJobForContext[\s\S]*jobsStateRef\.current !== 'ready'[\s\S]*jobsRef\.current\.find/,
  'async authority rechecks must read the latest rendered job list and load state instead of a stale event-handler closure',
);
assert.match(app, /const next = pickPreferredJob\(js, readStoredJobId\(\)\)/);
assert.match(app, /currentCandidateContextRef = useRef\(\{ jobId: null, candidateId: null, token: 0 \}\)/);
assert.match(app, /token: currentJobContextRef\.current\.token \+ 1/);
assert.match(app, /token: currentCandidateContextRef\.current\.token \+ 1/);
assert.match(app, /detailRequestRef\.current\.invalidate\(\)/);
assert.match(app, /if \(!sameJobId\(id, context\.jobId\)\) return false/);
assert.match(app, /!isCurrentJobContext\(currentJobContextRef, context\)[\s\S]*!jobRequestRef\.current\.isCurrent\(requestId\)/);
assert.match(app, /candidate\.job_id != null && !sameJobId\(candidate\.job_id, candidateContext\.jobId\)/);
assert.match(app, /async function handleCandidateWorkflowChanged[\s\S]*sameCandidateId\(candidateId, candidateContext\.candidateId\)[\s\S]*refreshCandidateDetail\(candidateContext\)/);
const workflowChangedSource = app.match(/async function handleCandidateWorkflowChanged[\s\S]*?\n  \}/)?.[0] || '';
assert.doesNotMatch(
  workflowChangedSource,
  /handleSelectCandidate/,
  'a workflow completion may refresh the current detail but must never select its original candidate',
);
assert.match(app, /async function handleAssess[\s\S]*isCurrentCandidateContext\(currentCandidateContextRef, context\)[\s\S]*refreshCandidateDetail\(context\)/);
assert.match(app, /async function pollScreenshotImportProgress[\s\S]*const targetJobId = result\.job_id[\s\S]*!sameJobId\(targetJobId, context\.jobId\)[\s\S]*当前岗位未切换[\s\S]*loadCandidates\(context\.jobId\)/);
assert.doesNotMatch(app, /refreshJobs\(targetJobId \|\| context\.jobId\)/, 'a completed screenshot import must never select its result job');
assert.match(app, /<TopBar[\s\S]*?readOnly=\{jobReadOnly\}/, 'closed jobs must hide TopBar write actions while keeping its read-only local refresh');
assert.match(app, /key=\{`\$\{jobId\}:\$\{detail\.candidate\.internal_id\}:\$\{candidateWorkspaceRevision\}`\}/);
assert.doesNotMatch(app, /recommendProgressMatchesJob|recommendRunMatchesJob|visibleRun|RECOMMEND_RUN_TYPE/,
  'the removed recommend-fetch job-isolation logic must not resurface');
assert.match(app, /async function pollRate\(context\)[\s\S]*if \(!isCurrentJobContext\(currentJobContextRef, context\)\) return false/);
assert.match(app, /function isUnchangedJobContext[\s\S]*context\.jobId == null \? current\.jobId == null/);
assert.match(app, /async function refreshJobs[\s\S]*!isUnchangedJobContext\(currentJobContextRef, context\)[\s\S]*!jobsRequestRef\.current\.isCurrent\(jobsRequestId\)[\s\S]*clearJobContext\(\)/);

for (const reset of [
  "setCandidateId('')",
  'setTimes({})',
  'setCancelReasons({})',
  "setMode('online')",
  "setError('')",
  "setBusy('')",
]) {
  assert.ok(schedule.includes(reset), `schedule job switch must reset ${reset}`);
}
assert.match(schedule, /const jobContextRef = useRef\(\{ jobId: null, token: 0 \}\)/);
assert.match(schedule, /createSession: \(input\) => api\.createInterviewSession\(input\)/);
assert.match(schedule, /confirmSchedule: \(sessionId, scheduledAt, requestId, logistics\) => api\.confirmInterviewSchedule\(sessionId, scheduledAt, requestId, logistics\)/);
assert.match(schedule, /cancelSession: \(sessionId, reasonCode\) => api\.withdrawInterviewLifecycle\(sessionId, reasonCode\)/);
assert.match(schedule, /await scheduleAdapter\.createSession[\s\S]*if \(!isCurrentContext\(context\)\) return;[\s\S]*await onRefresh\(\)/);
assert.match(schedule, /await scheduleAdapter\.confirmSchedule[\s\S]*if \(!isCurrentContext\(context\)\) return;[\s\S]*await onRefresh\(\)/);
assert.match(schedule, /await scheduleAdapter\.cancelSession[\s\S]*if \(!isCurrentContext\(context\)\) return;[\s\S]*await onRefresh\(\)/);

assert.match(deepProfile, /const contextKey = `\$\{open \? 'open' : 'closed'\}:\$\{jobId \?\? ''\}`/);
assert.match(deepProfile, /const requestId = \+\+reloadRequestRef\.current/);
const reloadSource = deepProfile.slice(
  deepProfile.indexOf('const reload = useCallback'),
  deepProfile.indexOf('}, []);', deepProfile.indexOf('const reload = useCallback')),
);
assert.match(deepProfile, /function isCurrentContext\(context\)[\s\S]*context\.token === profileContextRef\.current\.token[\s\S]*context\.key === profileContextRef\.current\.key/,
  'deep-profile context identity must include both the context token and key');
assert.ok(
  (reloadSource.match(/!isCurrentContext\(context\) \|\| requestId !== reloadRequestRef\.current/g) || []).length >= 2,
  'both successful and failed reloads must reject stale context tokens or stale request ids',
);
assert.match(reloadSource, /stale:\s*true/,
  'a rejected stale reload must return an explicit stale result regardless of its other return fields');
assert.match(deepProfile, /while \(Date\.now\(\) < deadline\) \{\s*if \(!isCurrentContext\(context\)\) return/);
assert.match(deepProfile, /api\.deepProfileProgress\(context\.jobId\)/);
assert.match(deepProfile, /<DeepDoc[\s\S]*?key=\{`\$\{jobId\}:\$\{deep\.version\}`\}/,
  'deep-profile document identity must remain scoped to the selected job and profile version');

console.log(JSON.stringify({
  ok: true,
  contract: 'ui-job-context-isolation',
  app_context_guard: true,
  candidate_context_guard: true,
  interview_form_reset: true,
  deep_profile_poll_guard: true,
  selected_job_reload_persistence: true,
  async_job_authority_recheck_uses_latest_state: true,
}));
