'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { cleanupOwnedLocalInterviewArtifacts } = require("../src/local-interview-artifact-cleanup");
const { GUARDIAN_IPC_SCHEMA } = require("../src/local-interview-guardian-protocol");

const ROOT = fs.realpathSync(fs.mkdtempSync(
  path.join(os.tmpdir(), 'hrboss-local-interview-guardian-fault-'),
));
const MATERIAL_ROOT = path.join(ROOT, 'interviews');
fs.mkdirSync(MATERIAL_ROOT, { recursive: true, mode: 0o700 });

const ACTION_INSTANCE_ID = 'check-local-interview-guardian-fault-injection';
process.env.BOSS_DB_PATH = path.join(ROOT, 'recruiting.db');
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = MATERIAL_ROOT;
process.env.HRBOSS_LOCAL_API_TOKEN = 'synthetic-local-api-token-guardian-fault-injection';
process.env.HRBOSS_LOCAL_API_INSTANCE_ID = ACTION_INSTANCE_ID;

const actionProcessTools = process.versions.electron
  ? (() => {
    const {
      signalLocalInterviewProcessTree,
      settleLocalInterviewProcessTree,
    } = require("../src/action-server");
    return {
      signalLocalInterviewProcessTree,
      settleLocalInterviewProcessTree,
    };
  })()
  : null;

const liveGuardians = new Set();
const liveGroups = new Set();

function opaqueToken() {
  return crypto.randomBytes(32).toString('hex');
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== 'ESRCH';
  }
}

function groupMembers(processGroupId) {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,pgid='], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return null;
  const members = [];
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match && Number(match[2]) === Number(processGroupId)) {
      members.push(Number(match[1]));
    }
  }
  return members;
}

function waitFor(check, timeoutMs = 5000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value;
      try {
        value = check();
      } catch {}
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(poll, 15);
    };
    poll();
  });
}

async function waitForTwoEmptyGroupFrames(processGroupId, timeoutMs = 6000) {
  let emptyFrames = 0;
  await waitFor(() => {
    const members = groupMembers(processGroupId);
    if (Array.isArray(members) && members.length === 0) emptyFrames += 1;
    else emptyFrames = 0;
    return emptyFrames >= 2;
  }, timeoutMs, `two empty frames for process group ${processGroupId}`);
  return true;
}

function createOwnedDirectory(label) {
  const jobId = `synthetic-${label}-${crypto.randomUUID()}`;
  const ownerToken = opaqueToken();
  const outDir = path.join(MATERIAL_ROOT, crypto.randomBytes(16).toString('hex'));
  fs.mkdirSync(outDir, { mode: 0o700 });
  fs.writeFileSync(
    path.join(outDir, '.hrboss-local-interview-owner.json'),
    `${JSON.stringify({
      schema_version: 'hrboss_local_interview_owner_v1',
      job_id: jobId,
      owner_token: ownerToken,
      created_at: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(outDir, '.hrboss-local-interview-state.json'),
    `${JSON.stringify({
      schema_version: 'hrboss_local_interview_state_v1',
      job_id: jobId,
      state: 'starting',
      mode: 'record',
      topic: 'synthetic-guardian-fault',
      cleanup_pending: false,
      termination_unconfirmed: false,
      updated_at: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  return { jobId, ownerToken, outDir };
}

function guardianEnvelope(runtime, message) {
  return {
    schema_version: GUARDIAN_IPC_SCHEMA,
    action_instance_id: runtime.actionInstanceId,
    guardian_instance_id: runtime.guardianInstanceId,
    job_id: runtime.jobId,
    ...message,
  };
}

function sendGuardian(runtime, message) {
  assert.equal(runtime.child.connected, true, 'guardian IPC must be connected');
  runtime.child.send(guardianEnvelope(runtime, message));
}

function startGuardian({
  label,
  workerArgs,
  extraEnv = {},
  forceAfterMs = 650,
  actionInstanceId = `synthetic-action-${label}`,
}) {
  const owned = createOwnedDirectory(label);
  const resolvedWorkerArgs = typeof workerArgs === 'function'
    ? workerArgs(owned)
    : workerArgs;
  assert.ok(Array.isArray(resolvedWorkerArgs) && resolvedWorkerArgs.length > 0);
  const guardianInstanceId = crypto.randomUUID();
  const controlToken = opaqueToken();
  const startToken = opaqueToken();
  const captureToken = opaqueToken();
  const registryPath = path.join(ROOT, `${label}-guardian-registry.json`);
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, "src/local-interview-guardian.js")], {
    cwd: PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '1',
      HRBOSS_INTERVIEW_OUTPUT_DIR: MATERIAL_ROOT,
      HRBOSS_LOCAL_INTERVIEW_ACTION_INSTANCE_ID: actionInstanceId,
      HRBOSS_LOCAL_INTERVIEW_GUARDIAN_CONTROL_TOKEN: controlToken,
      HRBOSS_LOCAL_INTERVIEW_GUARDIAN_INSTANCE_ID: guardianInstanceId,
      HRBOSS_LOCAL_INTERVIEW_GUARDIAN_JOB_ID: owned.jobId,
      HRBOSS_LOCAL_INTERVIEW_GUARDIAN_OUT_DIR: owned.outDir,
      HRBOSS_LOCAL_INTERVIEW_GUARDIAN_OWNER_TOKEN: owned.ownerToken,
      HRBOSS_LOCAL_INTERVIEW_GUARDIAN_REGISTRY: registryPath,
      HRBOSS_LOCAL_INTERVIEW_GUARDIAN_START_TOKEN: startToken,
      HRBOSS_LOCAL_INTERVIEW_GUARDIAN_CAPTURE_TOKEN: captureToken,
      HRBOSS_LOCAL_INTERVIEW_GUARDIAN_WORKER_ARGS: JSON.stringify(resolvedWorkerArgs),
      HRBOSS_LOCAL_INTERVIEW_GUARDIAN_WORKER_CWD: PROJECT_ROOT,
      HRBOSS_LOCAL_INTERVIEW_GUARDIAN_FORCE_MS: String(forceAfterMs),
      HRBOSS_LOCAL_INTERVIEW_GUARDIAN_START_TIMEOUT_MS: '4000',
      ...extraEnv,
    },
  });
  const runtime = {
    ...owned,
    actionInstanceId,
    guardianInstanceId,
    controlToken,
    startToken,
    captureToken,
    registryPath,
    child,
    messages: [],
    stdout: '',
    stderr: '',
    close: null,
    closed: null,
    processGroupId: null,
  };
  child.stdout.on('data', (chunk) => { runtime.stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { runtime.stderr += chunk.toString(); });
  child.on('message', (message) => {
    runtime.messages.push(message);
    if (message && message.type === 'guardian_ready') {
      runtime.processGroupId = Number(message.process_group_id);
      if (Number.isSafeInteger(runtime.processGroupId) && runtime.processGroupId > 0) {
        liveGroups.add(runtime.processGroupId);
      }
    }
  });
  runtime.close = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      runtime.closed = { code, signal: signal || null };
      resolve(runtime.closed);
    });
  });
  liveGuardians.add(runtime);
  runtime.close.finally(() => liveGuardians.delete(runtime));
  return runtime;
}

async function waitForGuardianMessage(runtime, type, timeoutMs = 5000) {
  const result = await waitFor(
    () => runtime.messages.find((message) => message && message.type === type)
      || (runtime.closed ? { guardian_closed: true } : null),
    timeoutMs,
    `guardian message ${type}`,
  );
  if (result.guardian_closed) {
    throw new Error(
      `guardian closed before ${type}: ${JSON.stringify(runtime.closed)}; stderr=${runtime.stderr}; stdout=${runtime.stdout}`,
    );
  }
  return result;
}

async function stopGuardian(runtime) {
  if (!runtime) return;
  if (Number.isSafeInteger(runtime.processGroupId) && runtime.processGroupId > 0) {
    try { process.kill(-runtime.processGroupId, 'SIGKILL'); } catch {}
  }
  if (runtime.child && runtime.child.exitCode == null && !runtime.child.signalCode) {
    try { runtime.child.kill('SIGKILL'); } catch {}
  }
  try {
    await Promise.race([
      runtime.close,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  } catch {}
}

function writeExecutable(target, source) {
  fs.writeFileSync(target, source, { mode: 0o700 });
  fs.chmodSync(target, 0o700);
}

async function checkCaptureGateWithdrawal() {
  const recorderHook = path.join(ROOT, 'recorder-hook.log');
  const fakeRecorder = path.join(ROOT, 'synthetic-recorder');
  writeExecutable(fakeRecorder, [
    '#!/bin/sh',
    'printf "recorder-invoked\\n" >> "$HRBOSS_TEST_RECORDER_HOOK"',
    'while :; do sleep 1; done',
    '',
  ].join('\n'));

  const runtime = startGuardian({
    label: 'capture-withdrawal',
    workerArgs: ({ outDir }) => [
      path.join(PROJECT_ROOT, "src/local-interview-p0.js"),
      '--record',
      '--duration',
      '10',
      '--topic',
      'synthetic-capture-gate',
      '--out-dir',
      outDir,
    ],
    extraEnv: {
      HRBOSS_INTERVIEW_REC_PATH: fakeRecorder,
      HRBOSS_TEST_RECORDER_HOOK: recorderHook,
    },
  });
  try {
    const guardianReady = await waitForGuardianMessage(runtime, 'guardian_ready');
    assert.ok(Number.isSafeInteger(Number(guardianReady.process_group_id)));
    sendGuardian(runtime, {
      type: 'start',
      start_token: runtime.startToken,
    });
    await waitForGuardianMessage(runtime, 'worker_ready');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(recorderHook), false,
      'worker readiness must not invoke the recorder before capture authorization');
    assert.equal(runtime.messages.some((message) => message.type === 'capture_started'), false);

    // This is the delayed-handshake withdrawal window: the worker is alive and
    // ready, but the action side deliberately never sends the raw capture token.
    sendGuardian(runtime, {
      type: 'cancel_before_start',
      reason: 'synthetic_consent_withdrawn_before_capture',
    });
    await waitFor(() => runtime.closed, 7000, `capture-withdrawal guardian exit; stderr=${runtime.stderr}`);
    await runtime.close;
    assert.equal(fs.existsSync(recorderHook), false,
      'withdrawing before capture authorization must keep recorder invocation at zero');
    assert.equal(runtime.messages.some((message) => message.type === 'capture_started'), false,
      'a cancelled capture gate must never acknowledge microphone capture');
    await waitForTwoEmptyGroupFrames(runtime.processGroupId);
    liveGroups.delete(runtime.processGroupId);
    const guardianExit = runtime.messages.find((message) => message && message.type === 'guardian_exit');
    assert.ok(guardianExit, 'healthy action IPC must receive the guardian exit event');
    assert.equal(guardianExit.cleanup, null,
      'while action IPC is healthy the guardian must not race the action-side cleanup owner');
    assert.equal(fs.existsSync(runtime.outDir), true,
      'the owned directory must remain for the action-side cleanup transaction');

    let actionCleanupCalls = 0;
    const actionCleanup = () => {
      actionCleanupCalls += 1;
      return cleanupOwnedLocalInterviewArtifacts({
        outDir: runtime.outDir,
        root: MATERIAL_ROOT,
        jobId: runtime.jobId,
        ownerToken: runtime.ownerToken,
      });
    };
    const cleanup = actionCleanup();
    assert.equal(cleanup.ok, true,
      `action-side synthetic withdrawal cleanup failed: ${JSON.stringify(cleanup.failures)}`);
    assert.equal(actionCleanupCalls, 1,
      'healthy pre-capture cancellation must have exactly one cleanup owner');
    assert.equal(fs.existsSync(runtime.outDir), false);
  } finally {
    await stopGuardian(runtime);
  }
}

async function checkGuardianManagedNormalCompletion() {
  const fakeDoctorTool = path.join(ROOT, 'normal-completion-doctor-tool');
  const fakeDoctorModel = path.join(ROOT, 'normal-completion-doctor-model.bin');
  writeExecutable(fakeDoctorTool, '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(fakeDoctorModel, 'synthetic model fixture\n', { mode: 0o600 });
  const runtime = startGuardian({
    label: 'guardian-managed-normal-completion',
    workerArgs: [
      path.join(PROJECT_ROOT, "src/local-interview-p0.js"),
      '--doctor',
    ],
    extraEnv: {
      HRBOSS_INTERVIEW_REC_PATH: fakeDoctorTool,
      HRBOSS_INTERVIEW_SOX_PATH: fakeDoctorTool,
      HRBOSS_INTERVIEW_AFCONVERT_PATH: fakeDoctorTool,
      HRBOSS_INTERVIEW_FFMPEG_PATH: fakeDoctorTool,
      HRBOSS_INTERVIEW_WHISPER_CLI_PATH: fakeDoctorTool,
      WHISPER_CPP_MODEL: fakeDoctorModel,
    },
  });
  try {
    await waitForGuardianMessage(runtime, 'guardian_ready');
    sendGuardian(runtime, {
      type: 'start',
      start_token: runtime.startToken,
    });
    await waitForGuardianMessage(runtime, 'worker_ready');
    sendGuardian(runtime, {
      type: 'capture_authorize',
      capture_token: runtime.captureToken,
    });

    await waitFor(
      () => runtime.closed,
      7000,
      `guardian-managed normal completion; stderr=${runtime.stderr}; stdout=${runtime.stdout}`,
    );
    await runtime.close;

    const workerExitIndex = runtime.messages.findIndex(
      (message) => message && message.type === 'worker_exited',
    );
    const workerCloseIndex = runtime.messages.findIndex(
      (message) => message && message.type === 'worker_closed',
    );
    const quiescentIndex = runtime.messages.findIndex(
      (message) => message && message.type === 'group_quiescent',
    );
    const gateCloseIndex = runtime.messages.findIndex(
      (message) => message && message.type === 'gate_closed',
    );
    const guardianExitIndex = runtime.messages.findIndex(
      (message) => message && message.type === 'guardian_exit',
    );
    const messageSequence = runtime.messages.map((message) => message && message.type);
    assert.ok(workerExitIndex >= 0,
      'guardian must observe the normally completed worker exit');
    assert.ok(workerCloseIndex > workerExitIndex,
      'worker close must follow its normal exit');
    assert.ok(quiescentIndex > workerCloseIndex,
      'the gate must prove two empty process-group frames after worker close');
    assert.ok(gateCloseIndex > workerCloseIndex,
      `the gate must close after the normally completed worker: ${messageSequence.join(',')}`);
    assert.ok(guardianExitIndex > Math.max(gateCloseIndex, quiescentIndex),
      'the guardian must report normal exit after observing both gate closure and quiescence');

    const workerExit = runtime.messages[workerExitIndex];
    assert.equal(workerExit.code, 0);
    assert.equal(workerExit.signal, null);
    assert.equal(workerExit.stopping, false);
    const quiescent = runtime.messages[quiescentIndex];
    assert.equal(
      quiescent.proof,
      'gate_worker_closed_pgid_empty',
      `the healthy gate must prove its own empty process group: ${quiescent.proof || 'missing'}`,
    );
    const gateClose = runtime.messages[gateCloseIndex];
    assert.equal(gateClose.code, 0);
    assert.equal(
      gateClose.signal,
      null,
      `the gate must close without a termination signal: messages=${JSON.stringify(runtime.messages)}; `
        + `stderr=${runtime.stderr}; stdout=${runtime.stdout}`,
    );
    assert.equal(
      gateClose.group_quiescent,
      true,
      'the gate must close only after completing its empty-PGID proof',
    );
    const guardianExit = runtime.messages[guardianExitIndex];
    assert.equal(guardianExit.code, 0);
    assert.equal(guardianExit.stopping, false);
    assert.equal(guardianExit.reason, null);
    assert.equal(guardianExit.cleanup, null,
      'healthy action IPC must remain the sole cleanup owner after normal completion');
    assert.deepEqual(runtime.closed, { code: 0, signal: null });
    assert.match(runtime.stdout, /"schemaVersion":\s*"local_interview_doctor_v2"/,
      'the lightweight worker must complete its doctor output before exiting');
    assert.equal(runtime.messages.some((message) => (
      message && (message.type === 'capture_started' || message.type === 'processing_started')
    )), false, 'the no-microphone doctor task must not report capture or media processing');

    await waitForTwoEmptyGroupFrames(runtime.processGroupId);
    liveGroups.delete(runtime.processGroupId);
    const cleanup = cleanupOwnedLocalInterviewArtifacts({
      outDir: runtime.outDir,
      root: MATERIAL_ROOT,
      jobId: runtime.jobId,
      ownerToken: runtime.ownerToken,
    });
    assert.equal(cleanup.ok, true,
      `action cleanup after normal completion failed: ${JSON.stringify(cleanup.failures)}`);
    assert.equal(fs.existsSync(runtime.outDir), false);
  } finally {
    await stopGuardian(runtime);
  }
}

function writeSyntheticCrashWorkers(label = 'worker-crash') {
  const bytePath = path.join(ROOT, `${label}-term-resistant-descendant.bytes`);
  const descendantReadyPath = path.join(ROOT, `${label}-term-resistant-descendant.ready`);
  const descendantPidPath = path.join(ROOT, `${label}-term-resistant-descendant.pid`);
  const workerPidPath = path.join(ROOT, `${label}-capture-worker.pid`);
  const leakedTokenPath = path.join(ROOT, `${label}-raw-capture-token-leaked-to-worker`);
  const descendantScript = path.join(ROOT, `${label}-term-resistant-descendant.js`);
  const workerScript = path.join(ROOT, `${label}-capture-worker-crash.js`);

  fs.writeFileSync(descendantScript, [
    "'use strict';",
    "const fs = require('node:fs');",
    `const bytePath = ${JSON.stringify(bytePath)};`,
    `const readyPath = ${JSON.stringify(descendantReadyPath)};`,
    "process.on('SIGTERM', () => {});",
    "process.on('SIGINT', () => {});",
    "const writeFrame = () => {",
    "  fs.appendFileSync(bytePath, Buffer.alloc(64, 0x61));",
    "  process.stdout.write('synthetic-descendant-frame\\n');",
    "};",
    "writeFrame();",
    "fs.writeFileSync(readyPath, 'ready\\n', { mode: 0o600 });",
    "setInterval(writeFrame, 20);",
    '',
  ].join('\n'), { mode: 0o600 });

  fs.writeFileSync(workerScript, [
    "'use strict';",
    "const crypto = require('node:crypto');",
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `const descendantScript = ${JSON.stringify(descendantScript)};`,
    `const descendantReadyPath = ${JSON.stringify(descendantReadyPath)};`,
    `const descendantPidPath = ${JSON.stringify(descendantPidPath)};`,
    `const workerPidPath = ${JSON.stringify(workerPidPath)};`,
    `const leakedTokenPath = ${JSON.stringify(leakedTokenPath)};`,
    "const schema = 'hrboss_local_interview_guardian_ipc_v1';",
    "const actionId = String(process.env.HRBOSS_LOCAL_INTERVIEW_ACTION_INSTANCE_ID || '');",
    "const guardianId = String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_INSTANCE_ID || '');",
    "const jobId = String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_JOB_ID || '');",
    "const captureHash = String(process.env.HRBOSS_LOCAL_INTERVIEW_CAPTURE_TOKEN_SHA256 || '');",
    "if (process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_CAPTURE_TOKEN) {",
    "  fs.writeFileSync(leakedTokenPath, 'raw token leaked\\n', { mode: 0o600 });",
    "  process.exit(70);",
    "}",
    "const envelope = (message) => ({",
    "  schema_version: schema,",
    "  action_instance_id: actionId,",
    "  guardian_instance_id: guardianId,",
    "  job_id: jobId,",
    "  ...message,",
    "});",
    "const send = (message) => process.send(envelope(message));",
    "fs.writeFileSync(workerPidPath, String(process.pid), { mode: 0o600 });",
    "process.on('message', (message) => {",
    "  if (!message || message.schema_version !== schema",
    "      || message.action_instance_id !== actionId",
    "      || message.guardian_instance_id !== guardianId",
    "      || message.job_id !== jobId",
    "      || message.type !== 'capture_authorized') return;",
    "  const actualHash = crypto.createHash('sha256').update(String(message.capture_token || ''), 'utf8').digest('hex');",
    "  const expected = Buffer.from(captureHash, 'hex');",
    "  const actual = Buffer.from(actualHash, 'hex');",
    "  if (expected.length !== 32 || actual.length !== expected.length",
    "      || !crypto.timingSafeEqual(expected, actual)) process.exit(71);",
    "  send({ type: 'capture_started' });",
    "  const descendant = spawn(process.execPath, [descendantScript], {",
    "    detached: false,",
    "    stdio: ['ignore', 'inherit', 'inherit'],",
    "    env: process.env,",
    "  });",
    "  fs.writeFileSync(descendantPidPath, String(descendant.pid), { mode: 0o600 });",
    "  const crashWhenReady = setInterval(() => {",
    "    if (!fs.existsSync(descendantReadyPath)) return;",
    "    clearInterval(crashWhenReady);",
    "    setTimeout(() => process.kill(process.pid, 'SIGKILL'), 25);",
    "  }, 10);",
    "});",
    "send({ type: 'worker_ready' });",
    '',
  ].join('\n'), { mode: 0o600 });

  return {
    bytePath,
    descendantReadyPath,
    descendantPidPath,
    workerPidPath,
    leakedTokenPath,
    workerScript,
  };
}

async function checkWorkerCrashWithTermResistantDescendant() {
  const fixture = writeSyntheticCrashWorkers('worker-crash');
  const runtime = startGuardian({
    label: 'worker-crash-descendant',
    workerArgs: [fixture.workerScript],
    forceAfterMs: 650,
  });
  let descendantPid = null;
  try {
    await waitForGuardianMessage(runtime, 'guardian_ready');
    assert.notEqual(runtime.child.pid, runtime.processGroupId,
      'guardian must remain outside the worker process group it supervises');
    sendGuardian(runtime, {
      type: 'start',
      start_token: runtime.startToken,
    });
    await waitForGuardianMessage(runtime, 'worker_ready');
    assert.equal(fs.existsSync(fixture.leakedTokenPath), false,
      'the raw capture token must not be inherited by the worker environment');
    sendGuardian(runtime, {
      type: 'capture_authorize',
      capture_token: runtime.captureToken,
    });
    await waitForGuardianMessage(runtime, 'capture_started');
    await waitFor(
      () => fs.existsSync(fixture.descendantReadyPath)
        && fs.existsSync(fixture.descendantPidPath)
        && fs.existsSync(fixture.workerPidPath),
      3000,
      'synthetic recorder descendant readiness',
    );
    descendantPid = Number(fs.readFileSync(fixture.descendantPidPath, 'utf8'));
    const workerPid = Number(fs.readFileSync(fixture.workerPidPath, 'utf8'));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0);
    await waitFor(() => !processExists(workerPid), 3000, 'capture worker SIGKILL exit');
    await waitForGuardianMessage(runtime, 'worker_exited');
    assert.equal(processExists(descendantPid), true,
      'the TERM-resistant descendant must reproduce the post-worker crash window');
    assert.ok((groupMembers(runtime.processGroupId) || []).includes(descendantPid),
      'the inherited-stdio descendant must remain in the exact supervised PGID');
    assert.equal(runtime.messages.some((message) => message.type === 'worker_closed'), false,
      'the descendant-held stdio must delay close, proving exit—not close—owns crash detection');

    const bytesBefore = fs.statSync(fixture.bytePath).size;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const bytesDuringTermination = fs.statSync(fixture.bytePath).size;
    assert.ok(bytesDuringTermination > bytesBefore,
      'synthetic recorder bytes must still grow while the TERM-resistant descendant is alive');

    await waitFor(() => runtime.closed, 8000, `worker-crash guardian exit; stderr=${runtime.stderr}`);
    await runtime.close;
    const quiescentMessageIndex = runtime.messages.findIndex(
      (message) => message && message.type === 'group_quiescent',
    );
    assert.ok(quiescentMessageIndex >= 0,
      'guardian must report the proof used to declare the original PGID quiescent');
    const quiescentMessage = runtime.messages[quiescentMessageIndex];
    assert.ok([
      'gate_worker_closed_pgid_empty',
      'gate_closed_verified_pgid_empty',
    ].includes(quiescentMessage.proof),
    `unexpected guardian quiescence proof: ${quiescentMessage.proof || 'missing'}`);
    if (quiescentMessage.proof === 'gate_worker_closed_pgid_empty') {
      const workerCloseIndex = runtime.messages.findIndex(
        (message) => message && message.type === 'worker_closed',
      );
      assert.ok(workerCloseIndex >= 0 && workerCloseIndex < quiescentMessageIndex,
        'a gate-reported quiescent state requires worker close before two empty member frames');
    } else {
      assert.equal(runtime.closed.signal, null,
        'guardian fallback must survive the killed gate group and exit normally after its own double-empty proof');
    }
    await waitForTwoEmptyGroupFrames(runtime.processGroupId);
    liveGroups.delete(runtime.processGroupId);
    assert.equal(processExists(descendantPid), false,
      'guardian escalation must leave no recorder descendant in the exact PGID');
    const bytesAfterQuiescence = fs.statSync(fixture.bytePath).size;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fs.statSync(fixture.bytePath).size, bytesAfterQuiescence,
      'recorder bytes must stop changing after two empty PGID frames');
  } finally {
    if (descendantPid && processExists(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    }
    await stopGuardian(runtime);
  }
}

async function checkActionRuntimePgidKillFallback() {
  if (!actionProcessTools) {
    console.log('action-side PGID fallback check requires Electron Node runtime; skipped under system Node');
    return;
  }
  const fixture = writeSyntheticCrashWorkers('action-pgid-fallback');
  const runtime = startGuardian({
    label: 'action-pgid-fallback',
    workerArgs: [fixture.workerScript],
    forceAfterMs: 1500,
    actionInstanceId: ACTION_INSTANCE_ID,
  });
  let descendantPid = null;
  const actionJob = {
    id: runtime.jobId,
    child: runtime.child,
    guardianManaged: true,
    guardianInstanceId: runtime.guardianInstanceId,
    processGroup: true,
    processGroupId: null,
    groupQuiescent: false,
    groupQuiescenceProof: null,
    childStreamsClosed: false,
    logClosed: false,
  };
  runtime.child.on('message', (message) => {
    if (message && message.type === 'group_quiescent') {
      actionJob.groupQuiescent = true;
      actionJob.groupQuiescenceProof = message.proof || null;
    }
  });
  runtime.child.once('close', (code, signal) => {
    actionJob.childStreamsClosed = true;
    actionJob.logClosed = true;
  });
  const killCalls = [];
  const runtimeKill = (pid, signal) => {
    killCalls.push({ pid, signal });
    return process.kill(pid, signal);
  };
  try {
    await waitForGuardianMessage(runtime, 'guardian_ready');
    actionJob.processGroupId = runtime.processGroupId;
    assert.notEqual(runtime.child.pid, runtime.processGroupId,
      'action-side fallback must target the verified gate PGID, not the guardian PID');
    sendGuardian(runtime, {
      type: 'start',
      start_token: runtime.startToken,
    });
    await waitForGuardianMessage(runtime, 'worker_ready');
    sendGuardian(runtime, {
      type: 'capture_authorize',
      capture_token: runtime.captureToken,
    });
    await waitForGuardianMessage(runtime, 'capture_started');
    await waitFor(
      () => fs.existsSync(fixture.descendantReadyPath)
        && fs.existsSync(fixture.descendantPidPath)
        && fs.existsSync(fixture.workerPidPath),
      3000,
      'action-side synthetic recorder descendant readiness',
    );
    descendantPid = Number(fs.readFileSync(fixture.descendantPidPath, 'utf8'));
    const workerPid = Number(fs.readFileSync(fixture.workerPidPath, 'utf8'));
    await waitFor(() => !processExists(workerPid), 3000, 'action-side capture worker SIGKILL exit');
    assert.equal(processExists(descendantPid), true,
      'the action-side fallback scenario requires a live TERM-resistant recorder descendant');
    assert.ok((groupMembers(runtime.processGroupId) || []).includes(descendantPid),
      'the recorder descendant must belong to the runtime-verified gate PGID');
    const bytesBeforeFallback = fs.statSync(fixture.bytePath).size;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(fs.statSync(fixture.bytePath).size > bytesBeforeFallback,
      'recorder bytes must still grow before the action-side force-stop fallback');

    // Fail this one authenticated IPC send while leaving the real parent
    // channel connected. The exported helper must then use the exact PGID
    // learned from this guardian runtime, while action remains cleanup owner.
    const originalSend = runtime.child.send;
    runtime.child.send = () => { throw new Error('synthetic guardian IPC send failure'); };
    let killSent;
    try {
      killSent = actionProcessTools.signalLocalInterviewProcessTree(
        actionJob,
        'SIGKILL',
        {
          platform: process.platform,
          kill: runtimeKill,
          reason: 'synthetic_action_runtime_pgid_fallback',
        },
      );
    } finally {
      runtime.child.send = originalSend;
    }
    assert.equal(killSent, true,
      'action-side SIGKILL must be delivered through the trusted runtime PGID fallback');
    assert.ok(killCalls.some(({ pid, signal }) => (
      pid === -runtime.processGroupId && signal === 'SIGKILL'
    )), 'the fallback must issue SIGKILL only to the exact verified negative PGID');
    assert.equal(killCalls.some(({ pid, signal }) => pid > 0 && signal === 'SIGKILL'), false,
      'the guardian fallback must never degrade to a parent-only positive PID SIGKILL');

    const settlement = await actionProcessTools.settleLocalInterviewProcessTree(actionJob, {
      platform: process.platform,
      kill: runtimeKill,
      graceMs: 250,
      killGraceMs: 8000,
      pollMs: 15,
    });
    assert.equal(settlement.confirmed, true,
      `action-side settlement must confirm group and stream closure: ${JSON.stringify({
        settlement,
        guardian_closed: runtime.closed,
        guardian_connected: runtime.child.connected,
        guardian_exit_code: runtime.child.exitCode,
        guardian_signal_code: runtime.child.signalCode,
        guardian_stderr: runtime.stderr,
      })}`);
    assert.equal(settlement.group_state, 'gone');
    assert.equal(settlement.streams_closed, true);
    await waitForTwoEmptyGroupFrames(runtime.processGroupId);
    liveGroups.delete(runtime.processGroupId);
    assert.equal(processExists(descendantPid), false,
      'action-side runtime PGID fallback must leave no recorder descendant');
    const bytesAfterQuiescence = fs.statSync(fixture.bytePath).size;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fs.statSync(fixture.bytePath).size, bytesAfterQuiescence,
      'recorder bytes must stop after action settlement and two empty PGID frames');
    await runtime.close;
    const guardianExit = runtime.messages.find((message) => message && message.type === 'guardian_exit');
    assert.ok(guardianExit, 'the connected action must receive guardian exit');
    assert.equal(guardianExit.cleanup, null,
      'a connected action remains the sole cleanup owner after its PGID fallback');
    assert.equal(fs.existsSync(runtime.outDir), true,
      'the connected guardian must leave the owned directory for action cleanup');
    let actionCleanupCalls = 0;
    actionCleanupCalls += 1;
    const cleanup = cleanupOwnedLocalInterviewArtifacts({
      outDir: runtime.outDir,
      root: MATERIAL_ROOT,
      jobId: runtime.jobId,
      ownerToken: runtime.ownerToken,
    });
    assert.equal(cleanup.ok, true,
      `action cleanup after runtime PGID fallback failed: ${JSON.stringify(cleanup.failures)}`);
    assert.equal(actionCleanupCalls, 1);
    assert.equal(fs.existsSync(runtime.outDir), false);
  } finally {
    if (descendantPid && processExists(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    }
    await stopGuardian(runtime);
  }
}

async function checkGuardianParentDisconnectCleanup() {
  const recorderHook = path.join(ROOT, 'disconnect-recorder-hook.log');
  const fakeRecorder = path.join(ROOT, 'disconnect-synthetic-recorder');
  writeExecutable(fakeRecorder, [
    '#!/bin/sh',
    'printf "recorder-invoked\\n" >> "$HRBOSS_TEST_RECORDER_HOOK"',
    'while :; do sleep 1; done',
    '',
  ].join('\n'));
  const runtime = startGuardian({
    label: 'guardian-parent-disconnect',
    workerArgs: ({ outDir }) => [
      path.join(PROJECT_ROOT, "src/local-interview-p0.js"),
      '--record',
      '--duration',
      '10',
      '--topic',
      'synthetic-parent-disconnect',
      '--out-dir',
      outDir,
    ],
    extraEnv: {
      HRBOSS_INTERVIEW_REC_PATH: fakeRecorder,
      HRBOSS_TEST_RECORDER_HOOK: recorderHook,
    },
  });
  try {
    await waitForGuardianMessage(runtime, 'guardian_ready');
    sendGuardian(runtime, {
      type: 'start',
      start_token: runtime.startToken,
    });
    await waitForGuardianMessage(runtime, 'worker_ready');
    assert.equal(fs.existsSync(recorderHook), false);

    runtime.child.disconnect();
    await waitFor(() => runtime.child.connected === false, 1000, 'real guardian parent disconnect');
    await waitFor(
      () => !fs.existsSync(runtime.outDir),
      8000,
      `guardian-owned disconnect cleanup; stderr=${runtime.stderr}`,
    );
    await waitForTwoEmptyGroupFrames(runtime.processGroupId);
    liveGroups.delete(runtime.processGroupId);
    assert.equal(fs.existsSync(recorderHook), false,
      'parent disconnect before capture authorization must never invoke the recorder');
    assert.equal(fs.existsSync(runtime.registryPath), false,
      'guardian must remove its registry after parent-disconnect cleanup');
    await waitFor(
      () => runtime.child.exitCode != null || !processExists(runtime.child.pid),
      3000,
      'guardian exit after parent-disconnect cleanup',
    );
  } finally {
    await stopGuardian(runtime);
  }
}

async function checkActionSettlementAfterGuardianSigkill() {
  if (!actionProcessTools) {
    console.log('guardian-SIGKILL action settlement check requires Electron Node runtime; skipped under system Node');
    return;
  }
  const fixture = writeSyntheticCrashWorkers('guardian-sigkill-action-settlement');
  const runtime = startGuardian({
    label: 'guardian-sigkill-action-settlement',
    workerArgs: [fixture.workerScript],
    forceAfterMs: 1500,
    actionInstanceId: ACTION_INSTANCE_ID,
  });
  let descendantPid = null;
  const actionJob = {
    id: runtime.jobId,
    child: runtime.child,
    guardianManaged: true,
    guardianInstanceId: runtime.guardianInstanceId,
    processGroup: true,
    processGroupId: null,
    groupQuiescent: false,
    groupQuiescenceProof: null,
    childStreamsClosed: false,
    logClosed: false,
  };
  runtime.child.once('close', () => {
    actionJob.childStreamsClosed = true;
    actionJob.logClosed = true;
  });
  const killCalls = [];
  const runtimeKill = (pid, signal) => {
    killCalls.push({ pid, signal });
    return process.kill(pid, signal);
  };
  try {
    await waitForGuardianMessage(runtime, 'guardian_ready');
    actionJob.processGroupId = runtime.processGroupId;
    sendGuardian(runtime, {
      type: 'start',
      start_token: runtime.startToken,
    });
    await waitForGuardianMessage(runtime, 'worker_ready');
    sendGuardian(runtime, {
      type: 'capture_authorize',
      capture_token: runtime.captureToken,
    });
    await waitForGuardianMessage(runtime, 'capture_started');
    await waitFor(
      () => fs.existsSync(fixture.descendantReadyPath)
        && fs.existsSync(fixture.descendantPidPath)
        && fs.existsSync(fixture.workerPidPath),
      3000,
      'guardian-SIGKILL synthetic recorder descendant readiness',
    );
    descendantPid = Number(fs.readFileSync(fixture.descendantPidPath, 'utf8'));
    const workerPid = Number(fs.readFileSync(fixture.workerPidPath, 'utf8'));
    await waitFor(() => !processExists(workerPid), 3000, 'guardian-SIGKILL capture worker exit');
    assert.ok((groupMembers(runtime.processGroupId) || []).includes(descendantPid),
      'the TERM-resistant recorder descendant must remain in the verified runtime PGID');

    runtime.child.kill('SIGKILL');
    await runtime.close;
    assert.equal(runtime.closed.signal, 'SIGKILL',
      'the test must kill the guardian itself, outside the recorder PGID');
    assert.equal(actionJob.childStreamsClosed, true);
    assert.equal(actionJob.logClosed, true);
    assert.equal(processExists(descendantPid), true,
      'guardian death must not be mistaken for recorder process-group death');

    const termSent = actionProcessTools.signalLocalInterviewProcessTree(
      actionJob,
      'SIGTERM',
      {
        platform: process.platform,
        kill: runtimeKill,
        reason: 'synthetic_guardian_sigkill',
      },
    );
    assert.equal(termSent, true,
      'action must fall back to the same-runtime verified PGID after guardian death');
    assert.ok(killCalls.some(({ pid, signal }) => (
      pid === -runtime.processGroupId && signal === 'SIGTERM'
    )), 'action must first send TERM to the exact negative runtime PGID');
    const bytesAfterTerm = fs.statSync(fixture.bytePath).size;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(fs.statSync(fixture.bytePath).size > bytesAfterTerm,
      'the synthetic descendant must prove TERM resistance before bounded escalation');

    const settlement = await actionProcessTools.settleLocalInterviewProcessTree(actionJob, {
      platform: process.platform,
      kill: runtimeKill,
      graceMs: 250,
      killGraceMs: 5000,
      pollMs: 15,
    });
    assert.equal(settlement.confirmed, true,
      `action must settle the orphaned guardian runtime: ${JSON.stringify(settlement)}`);
    assert.equal(settlement.escalated, true);
    assert.equal(settlement.kill_sent, true);
    assert.equal(settlement.group_state, 'gone');
    assert.equal(settlement.streams_closed, true);
    assert.ok(killCalls.some(({ pid, signal }) => (
      pid === -runtime.processGroupId && signal === 'SIGKILL'
    )), 'bounded settlement must escalate to SIGKILL on the exact negative runtime PGID');
    assert.equal(killCalls.some(({ pid, signal }) => pid > 0 && signal === 'SIGKILL'), false,
      'guardian death fallback must never issue a parent-only positive PID SIGKILL');
    await waitForTwoEmptyGroupFrames(runtime.processGroupId);
    liveGroups.delete(runtime.processGroupId);
    assert.equal(processExists(descendantPid), false);
    const bytesAfterQuiescence = fs.statSync(fixture.bytePath).size;
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(fs.statSync(fixture.bytePath).size, bytesAfterQuiescence,
      'recorder bytes must stop after bounded SIGKILL and two empty PGID frames');

    let actionCleanupCalls = 0;
    actionCleanupCalls += 1;
    const cleanup = cleanupOwnedLocalInterviewArtifacts({
      outDir: runtime.outDir,
      root: MATERIAL_ROOT,
      jobId: runtime.jobId,
      ownerToken: runtime.ownerToken,
    });
    assert.equal(cleanup.ok, true,
      `action cleanup after guardian SIGKILL failed: ${JSON.stringify(cleanup.failures)}`);
    assert.equal(actionCleanupCalls, 1);
    assert.equal(fs.existsSync(runtime.outDir), false);
  } finally {
    if (descendantPid && processExists(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    }
    await stopGuardian(runtime);
  }
}

async function main() {
  if (process.platform === 'win32') {
    console.log('check-local-interview-guardian-fault-injection-001 skipped on Windows');
    return;
  }
  await checkGuardianManagedNormalCompletion();
  await checkCaptureGateWithdrawal();
  await checkWorkerCrashWithTermResistantDescendant();
  await checkActionRuntimePgidKillFallback();
  await checkGuardianParentDisconnectCleanup();
  await checkActionSettlementAfterGuardianSigkill();
  console.log('check-local-interview-guardian-fault-injection-001 ok');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}).finally(async () => {
  for (const runtime of [...liveGuardians]) await stopGuardian(runtime);
  for (const processGroupId of [...liveGroups]) {
    try { process.kill(-processGroupId, 'SIGKILL'); } catch {}
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});
