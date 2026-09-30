'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const component = fs.readFileSync(
  path.join(PROJECT_ROOT, 'frontend/src/components/DeepProfileModal.jsx'),
  'utf8',
);

function between(startToken, endToken) {
  const start = component.indexOf(startToken);
  const end = component.indexOf(endToken, start + startToken.length);
  assert.ok(start >= 0, `missing source anchor: ${startToken}`);
  assert.ok(end > start, `missing end anchor after: ${startToken}`);
  return component.slice(start, end);
}

const monitor = between(
  '  async function monitorGeneration',
  '  async function bootstrapGenerationRecovery',
);
const bootstrap = between(
  '  async function bootstrapGenerationRecovery',
  '  useEffect(() => {',
);
const retryProgress = between(
  '  async function retryGenerationProgress',
  '  async function handleSaveInterview',
);
const generate = between(
  '  async function handleGenerate',
  '  const deep = config && config.deep_profile;',
);

// Opening recovery stays local to the existing per-job progress route. Global
// operational readonly skips that action-side GET but still reloads history.
const readonlyBranch = bootstrap.slice(
  bootstrap.indexOf('if (READONLY_UI)'),
  bootstrap.indexOf('\n    let progress;'),
);
assert.match(readonlyBranch, /setGenerationStatus\('readonly'\)/);
assert.match(readonlyBranch, /await reload\(context\)/);
assert.doesNotMatch(readonlyBranch, /deepProfileProgress|confirmExternalAiApproval|generateDeepProfile/);
assert.match(bootstrap, /progress = await api\.deepProfileProgress\(context\.jobId\)/);
assert.ok(
  bootstrap.indexOf('progress = await api.deepProfileProgress(context.jobId)')
    < bootstrap.lastIndexOf('await reload(context)'),
  'non-readonly open must inspect progress before its history reload completes',
);
assert.doesNotMatch(bootstrap, /\breadOnly\b/,
  'closed-job readonly must still inspect existing progress');
assert.match(bootstrap, /progress\.status === 'running'[\s\S]*setGenerationStatus\('running'\)/);
assert.match(bootstrap, /progress\.status === 'done'[\s\S]*setGenerationStatus\('done'\)/);
assert.match(bootstrap, /progress\.status === 'error'[\s\S]*setGenerationStatus\('error'\)/);
assert.match(bootstrap, /progress\.status === 'idle'[\s\S]*setGenerationStatus\('idle'\)/);
assert.match(bootstrap, /monitorGeneration\(context, progress, epoch\)/);
assert.doesNotMatch(bootstrap, /confirmExternalAiApproval|generateDeepProfile/,
  'opening recovery must never request approval or create another generation');

// Polling and GET-only retry are both bound to context + local epoch. Neither
// path can replay approval, generation, interview writes, or external transport.
assert.match(component, /const generationPollEpochRef = useRef\(0\)/);
assert.match(component, /function isCurrentGeneration\(context, epoch\)[\s\S]*epoch === generationPollEpochRef\.current/);
assert.match(component, /componentMountedRef\.current[\s\S]*context\.token === profileContextRef\.current\.token[\s\S]*context\.key === profileContextRef\.current\.key/);
assert.match(monitor, /while \(Date\.now\(\) < deadline\)/);
assert.match(monitor, /if \(!isCurrentGeneration\(context, epoch\)\) return \{ status: 'stale' \}/);
assert.match(monitor, /api\.deepProfileProgress\(context\.jobId\)/);
assert.match(monitor, /progress\.status === 'running'[\s\S]*await sleep\(2000\)/);
assert.match(monitor, /setGenerationStatus\('unknown'\)/);
assert.match(monitor, /setGenerationStatus\('error'\)/);
assert.match(monitor, /setGenerationStatus\('done'\)/);
assert.doesNotMatch(monitor, /confirmExternalAiApproval|generateDeepProfile|postInterviewAction|actionRequest/);
assert.match(retryProgress, /if \(READONLY_UI\) return/);
assert.match(retryProgress, /api\.deepProfileProgress\(context\.jobId\)/);
assert.match(retryProgress, /monitorGeneration\(context, progress, epoch\)/);
assert.doesNotMatch(retryProgress, /confirmExternalAiApproval|generateDeepProfile|postInterviewAction|actionRequest/);

const lifecycleCleanup = component.match(/return \(\) => \{\s*componentMountedRef\.current = false;[\s\S]*?\n    \};/)?.[0] || '';
assert.match(lifecycleCleanup, /generationPollEpochRef\.current \+= 1/);
assert.match(lifecycleCleanup, /reloadRequestRef\.current \+= 1/);
assert.doesNotMatch(lifecycleCleanup, /\bset[A-Z]\w*\(/,
  'unmount cleanup must invalidate refs without setting React state');
const contextCleanup = component.match(/return \(\) => \{\s*generationPollEpochRef\.current \+= 1;\s*generationAttemptRef\.current = null;\s*\};/)?.[0] || '';
assert.ok(contextCleanup, 'close/job-switch cleanup must invalidate the local polling epoch');
assert.doesNotMatch(contextCleanup, /\bset[A-Z]\w*\(/);
assert.doesNotMatch(component, /startedAt|started_at/,
  'server timestamps must not be treated as client task identity');

// A generation click must preflight progress before native approval. Existing
// running work is adopted and returns before approval/POST. Only explicit
// idle/done/error retries may proceed, with the server 409 retained as a guard.
const preflightIndex = generate.indexOf('p = await api.deepProfileProgress(context.jobId)');
const approvalIndex = generate.indexOf("api.confirmExternalAiApproval('deep-profile'");
const postIndex = generate.indexOf('api.generateDeepProfile(context.jobId');
assert.ok(preflightIndex >= 0 && preflightIndex < approvalIndex && approvalIndex < postIndex,
  'progress preflight must precede native approval and generate POST');
assert.match(generate, /if \(p\.status === 'running'\) \{[\s\S]*monitorGeneration\(context, p, progressEpoch\)[\s\S]*return;/);
assert.match(generate, /!\['idle', 'done', 'error'\]\.includes\(p\.status\)/);
assert.match(generate, /err\?\.status !== 409 \|\| !\/生成中\/\.test\(err\.message\)/);
assert.match(generate, /generationAttemptRef\.current\?\.contextKey === context\.key/);
assert.match(generate, /external_ai_confirmation_required[\s\S]*当前材料未自动重放，请重新确认并生成/);
assert.match(component, /generationStatus === 'error'[\s\S]*'重新确认并生成'/);

// Unknown is fail-closed with a visibly GET-only recovery action. Running is
// visible and generation remains disabled; readOnly continues to lock writes.
assert.match(component, /const generationProgressLocked = \['checking', 'running', 'unknown'\]\.includes\(generationStatus\)/);
assert.match(component, /const generationLocked = writeLocked \|\| generationReadiness\?\.ready !== true[\s\S]*\|\| generationProgressLocked/);
assert.match(component, /message="已恢复当前岗位正在生成的画像"/);
assert.match(component, /message="生成任务状态暂时无法确认"[\s\S]*onClick=\{retryGenerationProgress\}>重试读取任务状态/);
assert.match(component, /message="上次深度画像生成未完成"[\s\S]*description=\{\(readOnly \|\| READONLY_UI\)/);
assert.match(component, /READONLY_UI \? '退出操作只读模式后再处理。' : '请在可写的正式开放岗位中处理。'/);
assert.match(component, /: `\$\{generationError \|\| '任务已失败。'\}[^`]*不会自动重放材料或外部调用[^`]*重新确认并生成/,
  'only a writable job may invite an explicit re-confirmed generation');
assert.match(component, /const writeLocked = readOnly \|\| READONLY_UI/);
assert.match(component, /既有负责人访谈和深度画像仍会从本地主库读取/);
assert.match(component, /打开外部 AI 设置/);

// Synthetic decision-table evidence. This test does not call Electron, a real
// database, native approval, or any external AI transport.
function openProjection({ globalReadonly = false, readOnly = false, status = 'idle' }) {
  const calls = { historyRead: 1, progressRead: 0, approval: 0, generate: 0, externalTransport: 0 };
  if (!globalReadonly) calls.progressRead += 1;
  return {
    calls,
    writesLocked: globalReadonly || readOnly,
    adopted: !globalReadonly && status === 'running',
    recovery: status === 'error' ? 'reconfirm' : status === 'done' ? 'reload-latest' : status,
  };
}

function explicitGenerateProjection({ preflight = 'idle', post = 'started' }) {
  const calls = { progressRead: 1, approval: 0, generate: 0, externalTransport: 0 };
  if (preflight === 'running' || preflight === 'unknown') return { calls, adopted: preflight === 'running' };
  assert.ok(['idle', 'done', 'error'].includes(preflight));
  calls.approval += 1;
  calls.generate += 1;
  return { calls, adopted: post === 'conflict-running' };
}

assert.deepEqual(openProjection({ globalReadonly: true, status: 'running' }), {
  calls: { historyRead: 1, progressRead: 0, approval: 0, generate: 0, externalTransport: 0 },
  writesLocked: true,
  adopted: false,
  recovery: 'running',
});
assert.deepEqual(openProjection({ readOnly: true, status: 'running' }), {
  calls: { historyRead: 1, progressRead: 1, approval: 0, generate: 0, externalTransport: 0 },
  writesLocked: true,
  adopted: true,
  recovery: 'running',
});
assert.equal(openProjection({ status: 'done' }).recovery, 'reload-latest');
assert.equal(openProjection({ status: 'error' }).recovery, 'reconfirm');
assert.deepEqual(explicitGenerateProjection({ preflight: 'running' }).calls, {
  progressRead: 1, approval: 0, generate: 0, externalTransport: 0,
});
assert.deepEqual(explicitGenerateProjection({ preflight: 'unknown' }).calls, {
  progressRead: 1, approval: 0, generate: 0, externalTransport: 0,
});
assert.deepEqual(explicitGenerateProjection({ preflight: 'idle' }).calls, {
  progressRead: 1, approval: 1, generate: 1, externalTransport: 0,
});
assert.deepEqual(explicitGenerateProjection({ preflight: 'error', post: 'conflict-running' }), {
  calls: { progressRead: 1, approval: 1, generate: 1, externalTransport: 0 },
  adopted: true,
});

console.log(JSON.stringify({
  ok: true,
  contract: 'UX-W4-B-DEEP-PROFILE-RECOVERY',
  synthetic_only: true,
  real_data_read: false,
  external_ai_calls: 0,
  task_platform_added: false,
}));
