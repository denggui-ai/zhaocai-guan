'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  cleanupOwnedLocalInterviewArtifacts,
  cleanupOwnedLocalInterviewDerivedArtifacts,
} = require('./local-interview-artifact-cleanup');
const {
  GUARDIAN_CONTROL_MAX_BYTES,
  GUARDIAN_CONTROL_SCHEMA,
  GUARDIAN_IPC_SCHEMA,
  GUARDIAN_REGISTRY_SCHEMA,
  removeGuardianRegistry,
  secureTokenEqual,
  writeAtomicPrivateJson,
} = require('./local-interview-guardian-protocol');

const rawRegistryPath = String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_REGISTRY || '');
const rawOutDir = String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_OUT_DIR || '');
const rawOutputRoot = String(process.env.HRBOSS_INTERVIEW_OUTPUT_DIR || '');
const config = {
  actionInstanceId: String(process.env.HRBOSS_LOCAL_INTERVIEW_ACTION_INSTANCE_ID || ''),
  controlToken: String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_CONTROL_TOKEN || ''),
  guardianInstanceId: String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_INSTANCE_ID || ''),
  jobId: String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_JOB_ID || ''),
  outDir: rawOutDir ? path.resolve(rawOutDir) : '',
  outputRoot: rawOutputRoot ? path.resolve(rawOutputRoot) : '',
  ownerToken: String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_OWNER_TOKEN || ''),
  registryPath: rawRegistryPath ? path.resolve(rawRegistryPath) : '',
  startToken: String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_START_TOKEN || ''),
  captureToken: String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_CAPTURE_TOKEN || ''),
  preserveRecordingOnEmergency:
    process.env.HRBOSS_LOCAL_INTERVIEW_PRESERVE_RECORDING_ON_EMERGENCY === '1',
  forceAfterMs: Math.max(
    100,
    Math.min(10_000, Number(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_FORCE_MS) || 4000),
  ),
  startTimeoutMs: Math.max(
    250,
    Math.min(30_000, Number(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_START_TIMEOUT_MS) || 10_000),
  ),
};

if (!process.connected
    || !config.actionInstanceId
    || !config.guardianInstanceId
    || !config.jobId
    || !config.outDir
    || !config.outputRoot
    || !config.registryPath
    || !/^[a-f0-9]{64}$/.test(config.controlToken)
    || !/^[a-f0-9]{64}$/.test(config.ownerToken)
    || !/^[a-f0-9]{64}$/.test(config.startToken)
    || !/^[a-f0-9]{64}$/.test(config.captureToken)) {
  process.stderr.write('local interview guardian configuration is invalid\n');
  process.exit(64);
}

let gate = null;
let gateReady = false;
let gateClosed = false;
let gateGroupId = null;
let groupQuiescent = false;
let startAuthorized = false;
let workerStarted = false;
let workerReady = false;
let captureAuthorized = false;
let captureStarted = false;
let workerExited = false;
let workerClosed = false;
let workerCode = null;
let workerSignal = null;
let stopping = false;
let stopReason = '';
let cleanupRequired = false;
let cleanupResult = null;
let forceRequested = false;
let forceAcknowledged = false;
let forceTimer = null;
let startTimer = null;
let controlServer = null;
let registryWritten = false;
let finished = false;
let parentDisconnected = !process.connected;
let postGatePollTimer = null;
let postGateGoneFrames = 0;

function persistedCleanupDisposition() {
  const statePath = path.join(config.outDir, '.hrboss-local-interview-state.json');
  try {
    const stat = fs.lstatSync(statePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > 16 * 1024) {
      return 'full';
    }
    const descriptor = fs.openSync(
      statePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    let state;
    try {
      state = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    } finally {
      fs.closeSync(descriptor);
    }
    if (state.schema_version !== 'hrboss_local_interview_state_v1'
        || state.job_id !== config.jobId) return 'full';
    if (['abort_pending', 'cleanup_in_progress', 'cleanup_failed'].includes(state.state)) {
      return 'full';
    }
    if ([
      'transcription_in_progress',
      'transcription_retry_starting',
      'transcription_retry_running',
      'transcription_failed',
    ].includes(state.state)) return 'derived-only';
  } catch {}
  return config.preserveRecordingOnEmergency ? 'derived-only' : 'full';
}

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', () => {
    beginEmergencyStop('guardian_output_failure', { cleanup: true });
  });
}

function guardianEnvelope(message) {
  return {
    schema_version: GUARDIAN_IPC_SCHEMA,
    action_instance_id: config.actionInstanceId,
    guardian_instance_id: config.guardianInstanceId,
    job_id: config.jobId,
    ...message,
  };
}

function sendToAction(message) {
  if (!process.connected || typeof process.send !== 'function') return false;
  try {
    process.send(guardianEnvelope(message));
    return true;
  } catch {
    return false;
  }
}

function sendToGate(message) {
  if (!gate || gateClosed || gate.connected !== true || typeof gate.send !== 'function') return false;
  try {
    gate.send(guardianEnvelope(message));
    return true;
  } catch {
    return false;
  }
}

function removeOwnRegistry() {
  if (!registryWritten) return true;
  const removed = removeGuardianRegistry(config.registryPath, config.guardianInstanceId);
  if (removed) registryWritten = false;
  return removed;
}

function cleanupOwnedArtifactsIfRequired() {
  if (!cleanupRequired || cleanupResult) return cleanupResult;
  const cleanup = persistedCleanupDisposition() === 'derived-only'
    ? cleanupOwnedLocalInterviewDerivedArtifacts
    : cleanupOwnedLocalInterviewArtifacts;
  cleanupResult = cleanup({
    outDir: config.outDir,
    root: config.outputRoot,
    jobId: config.jobId,
    ownerToken: config.ownerToken,
  });
  return cleanupResult;
}

function finish(code = 0) {
  if (finished) return;
  finished = true;
  if (forceTimer) clearTimeout(forceTimer);
  if (startTimer) clearTimeout(startTimer);
  if (postGatePollTimer) clearInterval(postGatePollTimer);
  forceTimer = null;
  startTimer = null;
  postGatePollTimer = null;
  sendToAction({
    type: 'guardian_exit',
    code,
    stopping,
    reason: stopReason || null,
    cleanup: cleanupResult,
  });
  removeOwnRegistry();
  const exitNow = () => process.exit(Number.isInteger(code) ? code : (stopping ? 130 : 1));
  if (!controlServer) {
    setImmediate(exitNow);
    return;
  }
  const active = controlServer;
  controlServer = null;
  const timeout = setTimeout(exitNow, 100);
  active.close(() => {
    clearTimeout(timeout);
    exitNow();
  });
}

function persistedGroupMembers() {
  if (process.platform === 'win32' || !Number.isSafeInteger(gateGroupId)) return null;
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,pgid='], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return null;
  const members = [];
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    if (Number(match[2]) === gateGroupId) members.push(Number(match[1]));
  }
  return members;
}

function signalVerifiedGroup(signal) {
  if (process.platform === 'win32'
      || !gateReady
      || !Number.isSafeInteger(gateGroupId)
      || gateGroupId <= 0) return false;
  try {
    process.kill(-gateGroupId, signal);
    return true;
  } catch (error) {
    return !!(error && error.code === 'ESRCH');
  }
}

function waitForGroupAfterUnexpectedGateClose(exitCode) {
  if (postGatePollTimer || finished) return;
  const poll = () => {
    const members = persistedGroupMembers();
    if (Array.isArray(members) && members.length === 0) postGateGoneFrames += 1;
    else postGateGoneFrames = 0;
    if (postGateGoneFrames < 2) return;
    clearInterval(postGatePollTimer);
    postGatePollTimer = null;
    groupQuiescent = true;
    if (forceTimer) clearTimeout(forceTimer);
    forceTimer = null;
    sendToAction({
      type: 'group_quiescent',
      proof: 'gate_closed_verified_pgid_empty',
    });
    cleanupOwnedArtifactsIfRequired();
    finish(exitCode);
  };
  postGatePollTimer = setInterval(poll, 25);
  poll();
}

function releaseQuiescentGate() {
  if (!groupQuiescent || gateClosed) return;
  cleanupOwnedArtifactsIfRequired();
  sendToGate({
    type: 'release',
    code: stopping ? 130 : (Number.isInteger(workerCode) ? workerCode : 0),
  });
}

function requestForceStop() {
  if (finished || forceRequested) return;
  forceRequested = true;
  const delivered = sendToGate({
    type: 'signal',
    signal: 'SIGKILL',
    reason: 'guardian_bounded_force_stop',
  });
  // IPC delivery does not prove that a wedged gate handled the request. This
  // guardian owns a PGID verified against gate.pid in gate_ready, so enforce
  // the bounded deadline directly as well.
  const directlySignalled = signalVerifiedGroup('SIGKILL');
  if (!delivered && !directlySignalled) {
    sendToAction({ type: 'guardian_force_failed', error: 'worker gate IPC is unavailable' });
  }
}

function beginEmergencyStop(reason = 'action_server_ipc_disconnected', options = {}) {
  const firstTransition = !stopping;
  if (firstTransition) {
    stopping = true;
    stopReason = String(reason || 'guardian_emergency_stop').slice(0, 200);
  }
  // While the action-server IPC is healthy it is the sole cleanup owner. This
  // avoids a guardian/action double-delete race. The guardian takes ownership
  // only after parent death or an out-of-band emergency command/signal.
  if (options.cleanup === true
      && (parentDisconnected || options.cleanupWithoutAction === true)) {
    cleanupRequired = true;
  }
  if (gateClosed) {
    if (!startAuthorized || groupQuiescent) {
      cleanupOwnedArtifactsIfRequired();
      finish(130);
    } else {
      signalVerifiedGroup('SIGTERM');
      if (!forceTimer) {
        forceTimer = setTimeout(requestForceStop, config.forceAfterMs);
      }
      waitForGroupAfterUnexpectedGateClose(130);
    }
    return;
  }
  if (firstTransition) {
    const delivered = sendToGate({
      type: 'signal',
      signal: 'SIGTERM',
      reason: stopReason,
    });
    const directlySignalled = signalVerifiedGroup('SIGTERM');
    if (!delivered && !directlySignalled) {
      sendToAction({ type: 'guardian_signal_failed', error: 'worker gate termination channel is unavailable' });
    }
  }
  if (!forceTimer) {
    forceTimer = setTimeout(requestForceStop, config.forceAfterMs);
  }
}

function trustedMessage(message) {
  return !!message
    && message.schema_version === GUARDIAN_IPC_SCHEMA
    && message.action_instance_id === config.actionInstanceId
    && message.guardian_instance_id === config.guardianInstanceId
    && message.job_id === config.jobId;
}

function handleGateMessage(message) {
  if (!trustedMessage(message)) return;
  if (message.type === 'gate_ready') {
    if (Number(message.process_group_id) !== Number(gate.pid)) {
      beginEmergencyStop('worker_gate_identity_mismatch', { cleanup: true });
      return;
    }
    gateReady = true;
    gateGroupId = Number(message.process_group_id);
    maybeReportGuardianReady();
    return;
  }
  if (message.type === 'worker_spawned') {
    workerStarted = true;
    return;
  }
  if (message.type === 'worker_ready') {
    if (!workerStarted || workerReady || stopping) {
      beginEmergencyStop('worker_readiness_invalid', { cleanup: true });
      return;
    }
    workerReady = true;
    sendToAction({ type: 'worker_ready' });
    return;
  }
  if (message.type === 'capture_started' || message.type === 'processing_started') {
    if (!workerReady || !captureAuthorized || captureStarted || stopping) {
      beginEmergencyStop('capture_start_invalid', { cleanup: true });
      return;
    }
    captureStarted = true;
    if (startTimer) clearTimeout(startTimer);
    startTimer = null;
    sendToAction({ type: message.type });
    return;
  }
  if (message.type === 'worker_error') {
    sendToAction({ type: 'worker_error', error: message.error || 'worker failed' });
    beginEmergencyStop('worker_error');
    return;
  }
  if (message.type === 'worker_exited') {
    workerExited = true;
    workerCode = Number.isInteger(message.code) ? message.code : null;
    workerSignal = message.signal || null;
    sendToAction({
      type: 'worker_exited',
      code: workerCode,
      signal: workerSignal,
      stopping,
    });
    return;
  }
  if (message.type === 'worker_closed') {
    workerExited = true;
    workerClosed = true;
    workerCode = Number.isInteger(message.code) ? message.code : null;
    workerSignal = message.signal || null;
    sendToAction({
      type: 'worker_closed',
      code: workerCode,
      signal: workerSignal,
      stopping,
    });
    return;
  }
  if (message.type === 'force_ack') {
    forceAcknowledged = true;
    return;
  }
  if (message.type === 'group_quiescent') {
    groupQuiescent = true;
    if (forceTimer) clearTimeout(forceTimer);
    forceTimer = null;
    sendToAction({
      type: 'group_quiescent',
      proof: 'gate_worker_closed_pgid_empty',
    });
    releaseQuiescentGate();
  }
}

function startWorkerAfterDurableAck(message) {
  if (!gateReady || stopping || workerStarted || finished) return false;
  if (!secureTokenEqual(config.startToken, message.start_token)) {
    beginEmergencyStop('invalid_start_ack', { cleanup: true });
    return false;
  }
  startAuthorized = true;
  if (startTimer) clearTimeout(startTimer);
  startTimer = setTimeout(
    () => beginEmergencyStop('worker_start_ack_timeout', { cleanup: true }),
    config.startTimeoutMs,
  );
  return sendToGate({
    type: 'start',
    start_token: config.startToken,
  });
}

function authorizeCapture(message) {
  if (!workerReady
      || captureAuthorized
      || stopping
      || finished
      || !secureTokenEqual(config.captureToken, message.capture_token)) {
    beginEmergencyStop('invalid_capture_authorization', { cleanup: true });
    return false;
  }
  captureAuthorized = true;
  if (!sendToGate({
    type: 'capture_authorize',
    capture_token: config.captureToken,
  })) {
    beginEmergencyStop('capture_authorization_delivery_failed', { cleanup: true });
    return false;
  }
  return true;
}

process.on('message', (message) => {
  if (!trustedMessage(message)) return;
  if (message.type === 'start') {
    if (!startWorkerAfterDurableAck(message)) {
      beginEmergencyStop('worker_start_command_failed', { cleanup: true });
    }
    return;
  }
  if (message.type === 'cancel_before_start') {
    beginEmergencyStop('running_state_not_persisted', { cleanup: true });
    return;
  }
  if (message.type === 'capture_authorize') {
    authorizeCapture(message);
    return;
  }
  if (message.type === 'transcription_started') {
    if (!captureStarted || stopping || finished) {
      beginEmergencyStop('transcription_start_invalid', { cleanup: true });
      return;
    }
    config.preserveRecordingOnEmergency = true;
    sendToAction({ type: 'transcription_started' });
    return;
  }
  if (message.type !== 'signal') return;
  if (message.signal === 'SIGINT') {
    sendToGate({ type: 'signal', signal: 'SIGINT', reason: message.reason || '' });
  } else if (message.signal === 'SIGTERM') {
    beginEmergencyStop(message.reason || 'action_server_abort');
  } else if (message.signal === 'SIGKILL') {
    stopping = true;
    stopReason = String(message.reason || 'action_server_force_stop').slice(0, 200);
    requestForceStop();
  }
});

process.on('disconnect', () => {
  parentDisconnected = true;
  beginEmergencyStop('action_server_ipc_disconnected', { cleanup: true });
});
process.on('SIGINT', () => {});
process.on('SIGTERM', () => beginEmergencyStop('guardian_received_sigterm', { cleanup: true }));
process.on('SIGHUP', () => beginEmergencyStop('guardian_received_sighup', { cleanup: true }));
process.on('uncaughtException', () => beginEmergencyStop('guardian_uncaught_exception', { cleanup: true }));
process.on('unhandledRejection', () => beginEmergencyStop('guardian_unhandled_rejection', { cleanup: true }));

function handleControlSocket(socket) {
  socket.setEncoding('utf8');
  socket.setTimeout(1500);
  let pending = '';
  socket.on('data', (chunk) => {
    pending += chunk;
    if (pending.length > GUARDIAN_CONTROL_MAX_BYTES) {
      socket.destroy();
      return;
    }
    const newline = pending.indexOf('\n');
    if (newline < 0) return;
    let request;
    try {
      request = JSON.parse(pending.slice(0, newline));
    } catch {
      socket.destroy();
      return;
    }
    const trusted = request.schema_version === GUARDIAN_CONTROL_SCHEMA
      && request.command === 'emergency_stop'
      && request.action_instance_id === config.actionInstanceId
      && request.guardian_instance_id === config.guardianInstanceId
      && request.job_id === config.jobId
      && secureTokenEqual(config.controlToken, request.control_token);
    if (!trusted) {
      socket.destroy();
      return;
    }
    beginEmergencyStop(
      request.reason || 'candidate_main_watchdog',
      { cleanup: true, cleanupWithoutAction: true },
    );
    socket.end(`${JSON.stringify({
      schema_version: GUARDIAN_CONTROL_SCHEMA,
      accepted: true,
      guardian_instance_id: config.guardianInstanceId,
    })}\n`);
  });
  socket.once('timeout', () => socket.destroy());
  socket.once('error', () => {});
}

controlServer = net.createServer(handleControlSocket);
controlServer.maxConnections = 4;
controlServer.once('error', () => beginEmergencyStop('guardian_control_server_failed', { cleanup: true }));
controlServer.listen(0, '127.0.0.1', () => {
  const address = controlServer.address();
  const controlPort = address && typeof address === 'object' ? address.port : 0;
  try {
    writeAtomicPrivateJson(config.registryPath, {
      schema_version: GUARDIAN_REGISTRY_SCHEMA,
      action_instance_id: config.actionInstanceId,
      guardian_instance_id: config.guardianInstanceId,
      job_id: config.jobId,
      guardian_pid: process.pid,
      control_port: controlPort,
      control_token: config.controlToken,
      created_at: new Date().toISOString(),
    });
    registryWritten = true;
    maybeReportGuardianReady();
  } catch {
    beginEmergencyStop('guardian_registry_write_failed', { cleanup: true });
  }
});

function maybeReportGuardianReady() {
  if (!registryWritten || !gateReady || stopping || finished) return false;
  return sendToAction({ type: 'guardian_ready', process_group_id: gateGroupId });
}

gate = spawn(process.execPath, ['local-interview-worker-gate.js'], {
  cwd: __dirname,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  windowsHide: true,
  env: process.env,
});
gate.stdout.pipe(process.stdout, { end: false });
gate.stderr.pipe(process.stderr, { end: false });
gate.on('message', handleGateMessage);
gate.once('error', (error) => {
  sendToAction({ type: 'guardian_error', error: error.message });
  beginEmergencyStop('worker_gate_spawn_error', { cleanup: true });
});
gate.once('close', (code, signal) => {
  gateClosed = true;
  sendToAction({
    type: 'gate_closed',
    code,
    signal: signal || null,
    force_acknowledged: forceAcknowledged,
    group_quiescent: groupQuiescent,
    cleanup: cleanupResult,
  });
  const finalCode = stopping ? 130 : (Number.isInteger(workerCode) ? workerCode : (Number.isInteger(code) ? code : 1));
  if (!startAuthorized || groupQuiescent) {
    cleanupOwnedArtifactsIfRequired();
    finish(finalCode);
    return;
  }
  // A gate killed on its own is not proof that its detached descendants are
  // gone. Terminate the PGID verified for this runtime, then require two empty
  // membership frames before cleanup or exit.
  stopping = true;
  stopReason = stopReason || 'worker_gate_closed_unexpectedly';
  cleanupRequired = cleanupRequired || parentDisconnected;
  signalVerifiedGroup('SIGTERM');
  if (!forceTimer) forceTimer = setTimeout(requestForceStop, config.forceAfterMs);
  waitForGroupAfterUnexpectedGateClose(finalCode);
});

startTimer = setTimeout(
  () => beginEmergencyStop('durable_running_ack_timeout', { cleanup: true }),
  config.startTimeoutMs,
);
if (parentDisconnected) beginEmergencyStop('action_server_ipc_disconnected', { cleanup: true });
