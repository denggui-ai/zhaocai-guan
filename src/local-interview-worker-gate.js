'use strict';
const { PROJECT_ROOT } = require("./paths");


const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { GUARDIAN_IPC_SCHEMA, secureTokenEqual } = require('./local-interview-guardian-protocol');

const actionInstanceId = String(process.env.HRBOSS_LOCAL_INTERVIEW_ACTION_INSTANCE_ID || '');
const guardianInstanceId = String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_INSTANCE_ID || '');
const jobId = String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_JOB_ID || '');
const startToken = String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_START_TOKEN || '');
const captureToken = String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_CAPTURE_TOKEN || '');
const workerCwd = String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_WORKER_CWD || PROJECT_ROOT);
const forceAfterMs = Math.max(
  100,
  Math.min(10_000, Number(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_FORCE_MS) || 4000),
);
let workerArgs;
try {
  workerArgs = JSON.parse(String(process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_WORKER_ARGS || ''));
} catch {
  workerArgs = null;
}
if (!process.connected
    || !Array.isArray(workerArgs)
    || workerArgs.length < 1
    || workerArgs.length > 64
    || workerArgs.some((value) => typeof value !== 'string' || value.length > 8192)
    || !actionInstanceId
    || !guardianInstanceId
    || !jobId
    || !/^[a-f0-9]{64}$/.test(startToken)
    || !/^[a-f0-9]{64}$/.test(captureToken)) {
  process.stderr.write('local interview worker gate configuration is invalid\n');
  process.exit(64);
}

let worker = null;
let workerStarted = false;
let workerReady = false;
let captureAuthorized = false;
let captureStarted = false;
let transcriptionStarted = false;
let workerExited = false;
let workerClosed = false;
let stopping = false;
let forceTimer = null;
let groupPollTimer = null;
let quiescentFrames = 0;
let groupQuiescent = false;

function currentProcessGroupId() {
  if (process.platform === 'win32') return process.pid;
  const result = spawnSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 64 * 1024,
  });
  const value = Number(String(result.stdout || '').trim());
  return result.status === 0 && Number.isSafeInteger(value) ? value : null;
}

if (currentProcessGroupId() !== process.pid) {
  process.stderr.write('local interview worker gate is not a dedicated process-group leader\n');
  process.exit(65);
}

function sendToGuardian(message) {
  if (!process.connected || typeof process.send !== 'function') return false;
  try {
    process.send({
      schema_version: GUARDIAN_IPC_SCHEMA,
      action_instance_id: actionInstanceId,
      guardian_instance_id: guardianInstanceId,
      job_id: jobId,
      ...message,
    });
    return true;
  } catch {
    return false;
  }
}

function guardianEnvelope(message) {
  return {
    schema_version: GUARDIAN_IPC_SCHEMA,
    action_instance_id: actionInstanceId,
    guardian_instance_id: guardianInstanceId,
    job_id: jobId,
    ...message,
  };
}

function ownedGroupMembers() {
  if (process.platform === 'win32') {
    return worker && worker.exitCode == null && !worker.signalCode ? [worker.pid] : [];
  }
  const psPath = process.platform === 'darwin' ? '/bin/ps' : '/bin/ps';
  const result = spawnSync(psPath, ['-axo', 'pid=,pgid='], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) return null;
  const members = [];
  for (const line of String(result.stdout || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const pgid = Number(match[2]);
    if (pgid === process.pid && pid !== process.pid && pid !== result.pid) members.push(pid);
  }
  return members;
}

function pollGroupQuiescence() {
  if (groupQuiescent) return;
  const members = ownedGroupMembers();
  if (Array.isArray(members) && members.length === 0 && workerClosed) {
    quiescentFrames += 1;
  } else {
    quiescentFrames = 0;
    if (workerExited && Array.isArray(members) && members.length > 0 && !stopping) {
      beginEmergencyStop('worker_exited_with_live_group_members');
    }
  }
  if (quiescentFrames >= 2) {
    groupQuiescent = true;
    if (groupPollTimer) clearInterval(groupPollTimer);
    groupPollTimer = null;
    sendToGuardian({ type: 'group_quiescent' });
  }
}

function startGroupPoll() {
  if (groupPollTimer || groupQuiescent) return;
  groupPollTimer = setInterval(pollGroupQuiescence, 25);
  pollGroupQuiescence();
}

function signalOwnGroup(signal) {
  if (!workerStarted || !worker) return true;
  if (process.platform === 'win32') {
    try { return worker.kill(signal); } catch { return false; }
  }
  try {
    process.kill(-process.pid, signal);
    return true;
  } catch (error) {
    return !!(error && error.code === 'ESRCH');
  }
}

function forceOwnGroup() {
  if (process.platform !== 'win32') {
    try { process.kill(-process.pid, 'SIGKILL'); } catch {}
    return;
  }
  try { if (worker && worker.exitCode == null) worker.kill('SIGKILL'); } catch {}
}

function beginEmergencyStop(reason = 'guardian_disconnected') {
  if (!stopping) {
    stopping = true;
    signalOwnGroup('SIGTERM');
  }
  if (!forceTimer) {
    forceTimer = setTimeout(forceOwnGroup, forceAfterMs);
  }
  sendToGuardian({ type: 'gate_stopping', reason: String(reason).slice(0, 200) });
  if (!workerStarted) process.exit(130);
}

function startWorker() {
  if (workerStarted || stopping) return;
  workerStarted = true;
  const workerEnv = { ...process.env };
  for (const name of [
    'HRBOSS_LOCAL_INTERVIEW_GUARDIAN_CONTROL_TOKEN',
    'HRBOSS_LOCAL_INTERVIEW_GUARDIAN_OWNER_TOKEN',
    'HRBOSS_LOCAL_INTERVIEW_GUARDIAN_START_TOKEN',
    'HRBOSS_LOCAL_INTERVIEW_GUARDIAN_CAPTURE_TOKEN',
    'HRBOSS_LOCAL_INTERVIEW_GUARDIAN_WORKER_ARGS',
  ]) delete workerEnv[name];
  workerEnv.HRBOSS_LOCAL_INTERVIEW_WORKER_GROUP_ID = String(process.pid);
  workerEnv.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_MANAGED_WORKER = '1';
  workerEnv.HRBOSS_LOCAL_INTERVIEW_CAPTURE_TOKEN_SHA256 = crypto
    .createHash('sha256')
    .update(captureToken, 'utf8')
    .digest('hex');
  worker = spawn(process.execPath, workerArgs, {
    cwd: workerCwd,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
    env: workerEnv,
  });
  worker.stdout.pipe(process.stdout, { end: false });
  worker.stderr.pipe(process.stderr, { end: false });
  worker.once('spawn', () => sendToGuardian({ type: 'worker_spawned', worker_pid: worker.pid }));
  worker.on('message', (message) => {
    if (!trustedMessage(message)) return;
    if (message.type === 'worker_ready') {
      if (workerReady || captureAuthorized || stopping) return;
      workerReady = true;
      sendToGuardian({ type: 'worker_ready', worker_pid: worker.pid });
      return;
    }
    if (message.type === 'capture_started' || message.type === 'processing_started') {
      if (!workerReady || !captureAuthorized || captureStarted || stopping) {
        beginEmergencyStop('capture_started_without_authorization');
        return;
      }
      captureStarted = true;
      sendToGuardian({ type: message.type, worker_pid: worker.pid });
      return;
    }
    if (message.type === 'transcription_started') {
      if (!captureStarted || transcriptionStarted || stopping) {
        beginEmergencyStop('transcription_started_without_capture');
        return;
      }
      transcriptionStarted = true;
      sendToGuardian({ type: 'transcription_started', worker_pid: worker.pid });
    }
  });
  worker.once('error', (error) => {
    sendToGuardian({ type: 'worker_error', error: error.message });
    beginEmergencyStop('worker_spawn_error');
  });
  worker.once('exit', (code, signal) => {
    workerExited = true;
    sendToGuardian({ type: 'worker_exited', code, signal: signal || null, stopping });
    // `close` can be delayed indefinitely by a descendant holding inherited
    // stdio. Start exact-PGID inspection as soon as the wrapper exits.
    startGroupPoll();
  });
  worker.once('close', (code, signal) => {
    workerExited = true;
    workerClosed = true;
    sendToGuardian({ type: 'worker_closed', code, signal: signal || null, stopping });
    startGroupPoll();
  });
}

function trustedMessage(message) {
  return !!message
    && message.schema_version === GUARDIAN_IPC_SCHEMA
    && message.action_instance_id === actionInstanceId
    && message.guardian_instance_id === guardianInstanceId
    && message.job_id === jobId;
}

process.on('message', (message) => {
  if (!trustedMessage(message)) return;
  if (message.type === 'start') {
    if (!secureTokenEqual(startToken, message.start_token)) {
      beginEmergencyStop('invalid_start_ack');
      return;
    }
    startWorker();
    return;
  }
  if (message.type === 'capture_authorize') {
    if (!worker
        || worker.exitCode != null
        || worker.signalCode
        || !workerReady
        || captureAuthorized
        || stopping
        || !secureTokenEqual(captureToken, message.capture_token)) {
      beginEmergencyStop('invalid_capture_authorization');
      return;
    }
    captureAuthorized = true;
    try {
      worker.send(guardianEnvelope({
        type: 'capture_authorized',
        capture_token: captureToken,
      }));
    } catch {
      beginEmergencyStop('capture_authorization_delivery_failed');
    }
    return;
  }
  if (message.type === 'signal') {
    if (message.signal === 'SIGINT') signalOwnGroup('SIGINT');
    else if (message.signal === 'SIGTERM') beginEmergencyStop(message.reason || 'guardian_abort');
    else if (message.signal === 'SIGKILL') {
      sendToGuardian({ type: 'force_ack' });
      setImmediate(forceOwnGroup);
    }
    return;
  }
  if (message.type === 'release' && groupQuiescent) {
    if (forceTimer) clearTimeout(forceTimer);
    if (groupPollTimer) clearInterval(groupPollTimer);
    process.exit(Number.isInteger(message.code) ? message.code : (stopping ? 130 : 0));
  }
});

process.on('disconnect', () => beginEmergencyStop('guardian_ipc_disconnected'));
// Group signals are issued only by this gate after an authenticated guardian
// command. Never reflect a signal received by the group back into the group.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => {});
process.on('SIGHUP', () => beginEmergencyStop('gate_received_sighup'));
process.on('uncaughtException', () => beginEmergencyStop('gate_uncaught_exception'));
process.on('unhandledRejection', () => beginEmergencyStop('gate_unhandled_rejection'));

sendToGuardian({ type: 'gate_ready', process_group_id: process.pid });
