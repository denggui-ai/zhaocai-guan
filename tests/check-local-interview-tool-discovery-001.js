'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { doctor, resolveLocalInterviewTool } = require("../src/local-interview-p0");

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-local-interview-tools-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

function fakeTool(directory, name) {
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, name);
  fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.chmodSync(target, 0o700);
  return target;
}

const explicitDir = path.join(root, 'explicit');
const pathDir = path.join(root, 'path');
const fallbackDir = path.join(root, 'fallback');
const explicitRec = fakeTool(explicitDir, 'rec');
const pathSox = fakeTool(pathDir, 'sox');
const fallbackWhisper = fakeTool(fallbackDir, 'whisper-cli');
const executableDirectory = path.join(root, 'not-a-tool');
fs.mkdirSync(executableDirectory, { mode: 0o700 });

assert.equal(resolveLocalInterviewTool('rec', {
  platform: 'darwin',
  env: { PATH: '', HRBOSS_INTERVIEW_REC_PATH: explicitRec },
  fallbackDirectories: [],
}), explicitRec, 'explicit tool path must work without a shell PATH');
assert.equal(resolveLocalInterviewTool('rec', {
  platform: 'darwin',
  env: { PATH: pathDir, HRBOSS_INTERVIEW_REC_PATH: path.join(root, 'missing-rec') },
  fallbackDirectories: [fallbackDir],
}), '', 'an invalid explicit path must fail closed instead of silently selecting another binary');
assert.equal(resolveLocalInterviewTool('sox', {
  platform: 'darwin',
  env: { PATH: pathDir },
  fallbackDirectories: [],
}), pathSox, 'PATH discovery must remain supported');
assert.equal(resolveLocalInterviewTool('whisper-cli', {
  platform: 'darwin',
  env: { PATH: '' },
  fallbackDirectories: [fallbackDir],
}), fallbackWhisper, 'Finder-style fallback directories must be supported');
assert.equal(resolveLocalInterviewTool('rec', {
  platform: 'darwin',
  env: { PATH: '', HRBOSS_INTERVIEW_REC_PATH: executableDirectory },
  fallbackDirectories: [],
}), '', 'an executable directory must never be accepted as a tool binary');

const doctorDir = path.join(root, 'doctor');
const model = path.join(root, 'ggml-base.bin');
fs.writeFileSync(model, 'synthetic model fixture');
for (const name of ['rec', 'sox', 'afconvert', 'ffmpeg', 'whisper-cli']) fakeTool(doctorDir, name);
const originalLog = console.log;
const originalError = console.error;
const originalExitCode = process.exitCode;
let output = '';
try {
  process.exitCode = undefined;
  console.log = (value) => { output += String(value); };
  console.error = () => {};
  const result = doctor('darwin', {
    env: { PATH: doctorDir, WHISPER_CPP_MODEL: model },
    fallbackDirectories: [],
  });
  assert.equal(result.schemaVersion, 'local_interview_doctor_v2');
  assert.equal(result.ready, true);
  assert.equal(result.toolchainReady, true);
  assert.equal(result.readyScope, 'software_only');
  assert.equal(result.capabilities.micCheck.ready, true);
  assert.equal(result.capabilities.import.ready, true);
  assert.equal(result.tools.rec.probe, 'toolchain_only');
  assert.equal(result.tools.rec.microphone_tested, false);
  assert.equal(result.readiness.microphone.ready, false);
  assert.equal(result.readiness.microphone.tested, false);
  assert.equal(result.readiness.microphone.status, 'untested');
  assert.equal(result.microphone.tested, false);
  assert.equal(process.exitCode, undefined);
} finally {
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = originalExitCode;
}
assert.equal(JSON.parse(output).microphone.tested, false);

const timeoutDir = path.join(root, 'timeout');
const timeoutModel = path.join(root, 'timeout-model.bin');
fs.writeFileSync(timeoutModel, 'synthetic model fixture');
for (const name of ['rec', 'afconvert', 'ffmpeg', 'whisper-cli']) fakeTool(timeoutDir, name);
const hangingSox = path.join(timeoutDir, 'sox');
fs.writeFileSync(hangingSox, '#!/bin/sh\nwhile :; do :; done\n', { mode: 0o700 });
fs.chmodSync(hangingSox, 0o700);
try {
  process.exitCode = undefined;
  console.log = () => {};
  console.error = () => {};
  const timedOutDoctor = doctor('darwin', {
    env: { PATH: timeoutDir, WHISPER_CPP_MODEL: timeoutModel },
    fallbackDirectories: [],
    probeTimeoutMs: 200,
  });
  assert.equal(timedOutDoctor.ready, false);
  assert.equal(timedOutDoctor.tools.sox.runnable, false);
  assert.equal(timedOutDoctor.tools.sox.timed_out, true, 'a hanging external tool must be bounded and diagnosed');
} finally {
  console.log = originalLog;
  console.error = originalError;
  process.exitCode = originalExitCode;
}

const source = fs.readFileSync(path.join(PROJECT_ROOT, "src/local-interview-p0.js"), 'utf8');
assert.doesNotMatch(source, /tool\('rec',\s*\['--version'\]\)/, 'Doctor must not open the input device while checking rec');
assert.doesNotMatch(source, /spawn\('rec'/, 'recording must use the resolved absolute rec path');
assert.doesNotMatch(source, /run\('whisper-cli'/, 'transcription must use the resolved absolute whisper path');
assert.match(source, /'\/opt\/homebrew\/bin'/, 'Apple Silicon Finder fallback must remain explicit');
assert.match(source, /HRBOSS_INTERVIEW_WHISPER_CLI_PATH/, 'explicit deployment override must remain available');
assert.match(source, /timeout: probeTimeoutMs/, 'individual Doctor probes must have a finite timeout');
assert.match(source, /maxBuffer: LOCAL_INTERVIEW_PROBE_MAX_BUFFER/, 'Doctor probe output must be bounded');

const actionServer = fs.readFileSync(path.join(PROJECT_ROOT, "src/action-server.js"), 'utf8');
const doctorRoute = actionServer.slice(
  actionServer.indexOf("url.pathname === '/api/local-interview/doctor'"),
  actionServer.indexOf("url.pathname === '/api/interview-consent'"),
);
assert.match(doctorRoute, /timeout: 12_000/);
assert.match(doctorRoute, /maxBuffer: 1024 \* 1024/);
assert.match(doctorRoute, /diagnosticCompleted \? 200 : 500/,
  'a completed not-ready diagnosis must remain an HTTP success');

const settings = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/SettingsPanel.jsx'), 'utf8');
assert.match(settings, /capability\('录音工具'/);
assert.match(settings, /不代表麦克风权限或实际收音已经可用/);
assert.match(settings, /micCheckRunIdRef/);
assert.match(settings, /!doctorMicCheckReady/);

const review = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/InterviewReviewPanel.jsx'), 'utf8');
assert.match(review, /工具：\{doctorStatusText\}/);
assert.match(review, /麦克风：\{microphoneStatusText\}/);
assert.match(review, /真实麦克风状态以主动预检为准/);

console.log(JSON.stringify({
  ok: true,
  contract: 'LOCAL-INTERVIEW-TOOL-DISCOVERY-001',
  finder_path_fallback: true,
  explicit_tool_paths: true,
  executable_directory_rejected: true,
  hanging_probe_bounded: true,
  doctor_does_not_probe_microphone: true,
  toolchain_and_microphone_status_separated: true,
}));
