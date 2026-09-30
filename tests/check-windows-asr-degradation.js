'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  WINDOWS_LOCAL_ASR_MESSAGE,
  WINDOWS_LOCAL_ASR_REASON,
  assertLocalInterviewActionSupported,
  doctor,
  localInterviewCapability,
} = require("../src/local-interview-p0");

const ROOT = PROJECT_ROOT;

const capability = localInterviewCapability('win32');
assert.deepEqual(capability, {
  capability: 'local_recording_asr',
  platform: 'win32',
  status: 'degraded',
  degraded: true,
  ready: false,
  reason: WINDOWS_LOCAL_ASR_REASON,
  message: WINDOWS_LOCAL_ASR_MESSAGE,
  tools: {},
  whisperModel: null,
});
assert.equal(localInterviewCapability('darwin'), null);
assert.equal(JSON.stringify(capability).includes('brew'), false);
assert.equal(JSON.stringify(capability).includes('afconvert'), false);

assert.throws(
  () => assertLocalInterviewActionSupported('win32'),
  (error) => error.code === WINDOWS_LOCAL_ASR_REASON && error.message === WINDOWS_LOCAL_ASR_MESSAGE,
);
assert.doesNotThrow(() => assertLocalInterviewActionSupported('darwin'));

const originalLog = console.log;
const originalExitCode = process.exitCode;
let stdout = '';
try {
  process.exitCode = undefined;
  console.log = (value) => { stdout += String(value); };
  const result = doctor('win32');
  assert.deepEqual(result, capability);
  assert.equal(process.exitCode, undefined, 'Windows degraded doctor must exit successfully');
} finally {
  console.log = originalLog;
  process.exitCode = originalExitCode;
}
assert.deepEqual(JSON.parse(stdout), capability);

const backend = fs.readFileSync(path.join(ROOT, "src/local-interview-p0.js"), 'utf8');
const mainGate = backend.indexOf('assertLocalInterviewActionSupported();', backend.indexOf('async function main()'));
const firstOutputMutation = backend.indexOf("const topic = args.topic || 'HRBOSS-P0-local';", backend.indexOf('async function main()'));
assert(mainGate > 0 && mainGate < firstOutputMutation, 'main action gate must precede output preparation');
for (const signature of ['function record(', 'function extractWav(', 'function transcribeWav(']) {
  const start = backend.indexOf(signature);
  const body = backend.slice(start, start + 260);
  assert(body.includes('assertLocalInterviewActionSupported();'), `${signature} must fail closed before file work`);
}

const actionServer = fs.readFileSync(path.join(ROOT, "src/action-server.js"), 'utf8');
const jobStart = actionServer.indexOf('function runLocalInterviewJob(');
const jobOutDir = actionServer.indexOf('localInterviewOutDir(topic, { jobId: localJobId, ownerToken });', jobStart);
const jobGate = actionServer.indexOf('localInterviewCapability(process.platform)', jobStart);
assert(jobGate > jobStart && jobGate < jobOutDir, 'action server must reject Windows before creating an output directory');
for (const route of [
  "/api/local-interview/record/start",
  "/api/local-interview/mic-check",
  "/api/local-interview/from-file",
]) {
  const routeStart = actionServer.indexOf(`url.pathname === '${route}'`);
  const routeBody = actionServer.indexOf('const body = await readBody(req);', routeStart);
  const routeGate = actionServer.indexOf('localInterviewCapability(process.platform)', routeStart);
  assert(routeStart > 0 && routeGate > routeStart && routeGate < routeBody, `${route} must reject Windows before reading or validating inputs`);
}

assert.match(WINDOWS_LOCAL_ASR_MESSAGE, /当前 Windows 候选包未打包本地录音与 ASR 能力/);
assert.match(WINDOWS_LOCAL_ASR_MESSAGE, /麦克风预检、录音、导入转写和本地转写均已禁用/);
assert.doesNotMatch(WINDOWS_LOCAL_ASR_MESSAGE, /brew|afconvert|macOS/i);

const settings = fs.readFileSync(path.join(ROOT, 'frontend/src/components/SettingsPanel.jsx'), 'utf8');
assert.match(settings, /const doctorDegraded = doctor\?\.status === 'degraded' \|\| doctor\?\.degraded === true/);
assert.match(
  settings,
  /\{doctorDegraded && <Alert type="warning" showIcon message="本机录音与 ASR 当前不可用" description=\{doctor\.message\} \/>\}/,
  'settings must render the platform-specific doctor reason without duplicating a stale Windows literal',
);
assert.match(
  settings,
  /disabled=\{readOnly \|\| doctorDegraded \|\| !doctorMicCheckReady \|\| micCheckLoading \|\| micCheckInProgress \|\| !micCheckConsent\}/,
  'settings mic test must stay disabled for a degraded Windows capability',
);
assert.match(
  settings,
  /<Button icon=\{<ReloadOutlined \/>\} loading=\{doctorLoading\} disabled=\{READONLY_UI \|\| doctorLoading\} onClick=\{runDoctor\}>/,
  'settings must allow a normal-mode deployment recheck while keeping operational readonly subprocess-free',
);
assert(settings.includes('只使用当前平台已打包并通过验收的本地能力'));
assert.doesNotMatch(settings, /迁移[^\n]*(?:brew|afconvert)/i);

const standalone = fs.readFileSync(path.join(ROOT, 'frontend/src/components/LocalInterviewPanel.jsx'), 'utf8');
assert.match(standalone, /const degraded = doctor\?\.status === 'degraded' \|\| doctor\?\.degraded === true/);
assert.match(standalone, /\{degraded && <Alert[^\n]*message="这台电脑暂不能录音或转写" description=\{doctor\.message\}/);
assert.match(
  standalone,
  /const showDoctorRecovery = !taskBusy\s+&& !READONLY_UI\s+&& \(Boolean\(doctorError\) \|\| Boolean\(doctor && \(!ready \|\| !importReady\)\)\)/,
  'standalone recording recovery must appear only when the environment needs attention',
);
assert.match(standalone, /\{showDoctorRecovery && \([\s\S]*?重新检查录音环境[\s\S]*?\)\}/);
assert.doesNotMatch(standalone, /请到候选人页开始录音|(?:重新)?检查依赖/);
for (const disabledContract of [
  /disabled=\{readOnly \|\| busy \|\| taskBusy \|\| degraded \|\| !ready\}/,
  /disabled=\{readOnly \|\| busy \|\| taskBusy \|\| degraded \|\| !importReady\}/,
  /disabled=\{readOnly \|\| busy \|\| taskBusy \|\| degraded \|\| !importReady \|\| !filePath\.trim\(\) \|\| !materialConsent\}/,
]) {
  assert.match(standalone, disabledContract, 'standalone local interview actions must fail closed when degraded');
}
assert.doesNotMatch(standalone, /brew|afconvert|macOS/i);

const review = fs.readFileSync(path.join(ROOT, 'frontend/src/components/InterviewReviewPanel.jsx'), 'utf8');
assert.match(review, /const degraded = doctor\?\.status === 'degraded' \|\| doctor\?\.degraded === true/);
assert.match(
  review,
  /const environmentNeedsAttention = !!doctorError \|\| degraded \|\| \(!!doctor && !ready\)/,
  'candidate recording must treat a degraded capability as an environment failure',
);
assert.match(
  review,
  /const showIdleActions = progressKnown\s+&& !progressError\s+&& !taskBusy\s+&& ready\s+&& !environmentNeedsAttention/,
  'candidate recording must fail closed instead of rendering start actions while degraded',
);
assert.match(review, /const showStopAction = currentRecordingRunning/);
assert.match(review, /const showEnvironmentAction = !taskBusy && environmentNeedsAttention/);
assert.match(review, /\{showEnvironmentAction && \([\s\S]*?\{doctor \? '重新检查录音环境' : '检查录音环境'\}[\s\S]*?\)\}/);
const reviewControlsStart = review.indexOf('<div className="candidate-interview-controls">');
const reviewControlsEnd = review.indexOf('{currentRecordingRunning && (', reviewControlsStart);
assert(reviewControlsStart > 0 && reviewControlsEnd > reviewControlsStart, 'candidate recording controls source must be discoverable');
const reviewControls = review.slice(reviewControlsStart, reviewControlsEnd);
assert.equal((reviewControls.match(/\{showIdleActions && \(/g) || []).length, 2,
  'healthy idle candidate recording must expose exactly two state-gated actions');
assert(reviewControls.includes('测试麦克风') && reviewControls.includes('开始录音'));
assert(reviewControls.includes('recordingFinalizationUiState.buttonLabel') && reviewControls.includes('检查录音环境'));
assert(
  fs.readFileSync(path.join(ROOT, 'frontend/src/interview-review-navigation.mjs'), 'utf8').includes('停止并转写'),
  'the shared recording finalization state must retain the normal stop-and-transcribe action',
);
assert.doesNotMatch(reviewControls, /(?:重新)?检查依赖/);
assert.doesNotMatch(review, /brew|afconvert|macOS/i);

const styles = fs.readFileSync(path.join(ROOT, 'frontend/src/styles.css'), 'utf8');
assert.match(
  styles,
  /\.candidate-interview-actions\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*width:\s*100%;[^}]*\}/,
  'candidate recording actions must span both control columns instead of auto-placing in the narrow first column',
);

console.log(JSON.stringify({
  check: 'windows_asr_degradation',
  status: 'passed',
  reason: WINDOWS_LOCAL_ASR_REASON,
  settings_copy_contract: 'doctor_message',
  windows_actions_disabled: true,
  recording_actions_state_driven: true,
  macos_install_advice_absent: true,
}));
