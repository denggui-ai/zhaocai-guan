'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const Database = require('better-sqlite3');
const {
  validateGuardianRegistry,
  writeAtomicPrivateJson,
} = require("../src/local-interview-guardian-protocol");
const {
  cleanupOwnedLocalInterviewDerivedArtifacts,
} = require("../src/local-interview-artifact-cleanup");

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-recording-consent-withdrawal-'));
const DB_PATH = path.join(ROOT, 'recruiting.db');
const MATERIAL_ROOT = path.join(ROOT, 'interviews');

process.env.BOSS_DB_PATH = DB_PATH;
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = MATERIAL_ROOT;
process.env.HRBOSS_LOCAL_API_TOKEN = 'synthetic-local-api-token-recording-withdrawal-001';
process.env.HRBOSS_LOCAL_API_INSTANCE_ID = 'check-interview-recording-consent-withdrawal';

const db = require("../src/db");
const {
  autoBindLocalInterviewResult,
  abortLocalInterviewJob,
  cleanupAbortedLocalInterviewArtifacts,
  cleanupFailedLocalInterviewResult,
  finalizeLocalInterviewMicCheck,
  interviewConsentStopHttpResult,
  localInterviewJobBlocksStart,
  localInterviewGuardianExitRequiresAbort,
  localInterviewManualStopHttpResult,
  localInterviewOutDir,
  localInterviewShutdownSafety,
  localInterviewStopMatches,
  persistAndBindLocalInterviewResult,
  recoveredLocalInterviewProcessGroupState,
  recoverPersistedLocalInterviewBlocker,
  refreshPersistedLocalInterviewBlocker,
  requestOwnedLocalInterviewManualStop,
  retryRecoveredLocalInterviewBinding,
  runLocalInterviewJob,
  sanitizeLocalInterviewMicCheckResult,
  signalLocalInterviewProcessTree,
  settleLocalInterviewProcessTree,
  writeLocalInterviewPersistentState,
} = require("../src/action-server");

process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

function seedJobAndCandidate() {
  const job = db.upsertJob({
    encrypt_job_id: 'recording-consent-withdrawal-job-001',
    numeric_job_id: '991000000000001',
    name: '录音授权回归岗位',
    hr_owner: 'HR-SYNTHETIC',
  });
  const jd = db.createJobJdVersion({
    jobId: job.id,
    jdText: '纯合成录音授权回归 JD',
    actor: 'HR-SYNTHETIC',
  });
  db.activateJobJdVersion({ jdVersionId: jd.id, expectedVersion: jd.version, actor: 'HR-SYNTHETIC' });
  const profile = db.createJobProfileVersion({
    jobId: job.id,
    jdVersionId: jd.id,
    config: { rubric: '纯合成录音授权画像' },
    actor: 'HR-SYNTHETIC',
  });
  db.confirmJobProfileVersion({ profileVersionId: profile.id, expectedVersion: profile.version, actor: 'HR-SYNTHETIC' });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'recording-consent-withdrawal-candidate-001',
    source: 'fixture',
    name: '合成候选人',
  });
  return { job, candidate };
}

function writeCompletedSummaryAt(dir, name) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const wavPath = path.join(dir, 'recording.wav');
  const transcriptTxt = path.join(dir, 'transcript.txt');
  const transcriptSrt = path.join(dir, 'transcript.srt');
  const transcriptJson = path.join(dir, 'transcript.json');
  const codexInput = path.join(dir, 'codex-input.md');
  const summaryPath = path.join(dir, 'summary.json');
  fs.writeFileSync(wavPath, 'RIFF synthetic recording only\n', { mode: 0o600 });
  fs.writeFileSync(transcriptTxt, '纯合成候选人录音转写。\n', { mode: 0o600 });
  fs.writeFileSync(transcriptSrt, '1\n00:00:00,000 --> 00:00:02,000\n纯合成转写。\n', { mode: 0o600 });
  fs.writeFileSync(transcriptJson, `${JSON.stringify({ text: '纯合成转写。' })}\n`, { mode: 0o600 });
  fs.writeFileSync(codexInput, '# synthetic local interview packet\n', { mode: 0o600 });
  const summary = {
    createdAt: '2026-07-23T00:00:00.000Z',
    mode: 'record',
    topic: name,
    sourcePath: '',
    wavPath,
    transcriptTxt,
    transcriptSrt,
    transcriptJson,
    summaryPath,
    codexInput,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  return { dir, summaryPath };
}

function writeCompletedSummary(name) {
  return writeCompletedSummaryAt(path.join(MATERIAL_ROOT, name), name);
}

function writeAbortArtifacts(dir, names) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of names) fs.writeFileSync(path.join(dir, name), `synthetic ${name}\n`, { mode: 0o600 });
}

let ownedFixtureSequence = 0;
function createOwnedFixture(topic = 'synthetic-abort') {
  ownedFixtureSequence += 1;
  const jobId = `synthetic-job-${ownedFixtureSequence}`;
  const ownerToken = `${String(ownedFixtureSequence).padStart(16, '0')}abcdefabcdefabcdefabcdefabcdefab`;
  const dir = localInterviewOutDir(topic, { jobId, ownerToken, root: MATERIAL_ROOT });
  return { dir, jobId, ownerToken };
}

function assertRemoved(dir, names) {
  for (const name of names) {
    assert.equal(fs.existsSync(path.join(dir, name)), false, `${name} must be deleted after consent withdrawal`);
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function findSystemNodeExecutable() {
  const executableName = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, executableName));
  if (path.basename(process.execPath).toLowerCase() === executableName) candidates.unshift(process.execPath);
  for (const candidate of candidates) {
    try {
      const resolved = fs.realpathSync(candidate);
      if (!fs.statSync(resolved).isFile()) continue;
      fs.accessSync(resolved, fs.constants.X_OK);
      if (process.platform !== 'win32' && /\s/.test(resolved)) continue;
      return resolved;
    } catch {}
  }
  throw new Error(`system ${executableName} executable not found for recording worker check`);
}

function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('synthetic recording worker check timed out'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function nowIsoForTest() {
  return new Date().toISOString();
}

async function checkOwnedProcessGroupTermination() {
  if (process.platform === 'win32') return;
  const nodeExecutable = findSystemNodeExecutable();
  const pidFile = path.join(ROOT, 'transcribing-worker.pid');
  const readyFile = path.join(ROOT, 'transcribing-worker.ready');
  const wrapperScript = path.join(ROOT, 'synthetic-transcribing-wrapper.js');
  const owned = createOwnedFixture('wrapper-exits-descendant-holds-stdio');
  const artifactPath = path.join(owned.dir, 'recording.wav');
  const logPath = path.join(owned.dir, 'run.log');
  fs.writeFileSync(wrapperScript, `'use strict';\n`
    + `const fs = require('fs');\n`
    + `const { spawn } = require('child_process');\n`
    + `const workerSource = ${JSON.stringify(`const fs = require('fs'); process.on('SIGTERM', () => {}); fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready'); fs.writeFileSync(${JSON.stringify(artifactPath)}, 'synthetic recording\\n'); process.stdout.write('worker-ready\\n'); setInterval(() => { fs.appendFileSync(${JSON.stringify(artifactPath)}, 'frame\\n'); process.stdout.write('frame\\n'); }, 25);`)};\n`
    + `const worker = spawn(process.execPath, ['-e', workerSource], { stdio: ['ignore', 'inherit', 'inherit'] });\n`
    + `fs.writeFileSync(${JSON.stringify(pidFile)}, String(worker.pid));\n`
    + `setInterval(() => {}, 1000);\n`, { mode: 0o600 });
  const wrapper = spawn(nodeExecutable, [wrapperScript], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const job = {
    child: wrapper,
    processGroup: true,
    processGroupId: wrapper.pid,
    childStreamsClosed: false,
    logClosed: false,
  };
  const log = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
  let wrapperLog = '';
  wrapper.stdout.on('data', (chunk) => {
    wrapperLog += chunk.toString();
    log.write(chunk);
  });
  wrapper.stderr.on('data', (chunk) => {
    wrapperLog += chunk.toString();
    log.write(chunk);
  });
  wrapper.once('close', () => {
    job.childStreamsClosed = true;
    log.end();
  });
  log.once('close', () => { job.logClosed = true; });
  let workerPid = null;
  try {
    await waitFor(() => (fs.existsSync(pidFile) && fs.existsSync(readyFile)) || wrapper.exitCode != null)
      .catch((error) => { throw new Error(`${error.message}; wrapper=${wrapper.exitCode}; log=${wrapperLog}`); });
    assert.equal(wrapper.exitCode, null, 'synthetic transcribing wrapper must still be running');
    workerPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0);
    assert.equal(processExists(workerPid), true);
    const sentSignals = [];
    const exactGroupKill = (pid, signal) => {
      sentSignals.push({ pid, signal });
      return process.kill(pid, signal);
    };
    assert.equal(signalLocalInterviewProcessTree(job, 'SIGTERM', {
      platform: process.platform,
      kill: exactGroupKill,
    }), true);
    const settlementPromise = settleLocalInterviewProcessTree(job, {
      platform: process.platform,
      kill: exactGroupKill,
      graceMs: 120,
      killGraceMs: 3000,
      pollMs: 10,
    });
    await waitFor(() => wrapper.exitCode != null || wrapper.signalCode)
      .catch((error) => { throw new Error(`${error.message}; wrapper=${wrapper.exitCode || wrapper.signalCode}; log=${wrapperLog}`); });
    assert.equal(processExists(workerPid), true, 'descendant must still be alive after wrapper exits and ignores SIGTERM');
    assert.equal(job.childStreamsClosed, false,
      'ChildProcess close must wait while the descendant holds inherited stdout/stderr');
    assert.equal(fs.existsSync(artifactPath), true,
      'recording artifact must remain until the process group and streams are confirmed closed');

    const settlement = await settlementPromise;
    assert.equal(settlement.confirmed, true, `owned process group did not become quiescent: ${JSON.stringify(settlement)}`);
    assert.equal(settlement.escalated, true, 'SIGTERM-resistant descendant must require bounded PGID escalation');
    assert.equal(settlement.kill_sent, true);
    assert.equal(job.childStreamsClosed, true);
    assert.equal(job.logClosed, true);
    assert.ok(sentSignals.some(({ pid, signal }) => pid === -wrapper.pid && signal === 'SIGKILL'),
      'escalation must target the exact owned negative PGID');
    assert.equal(sentSignals.some(({ pid, signal }) => pid > 0 && signal === 'SIGKILL'), false,
      'termination must never fall back to a positive parent-only SIGKILL');
    await waitFor(() => !processExists(workerPid));
    assert.equal(processExists(workerPid), false, 'descendant must not remain after exact PGID escalation');

    const cleanup = cleanupAbortedLocalInterviewArtifacts(owned.dir, owned);
    assert.equal(cleanup.ok, true);
    assert.equal(fs.existsSync(artifactPath), false,
      'owned artifacts may be deleted only after the termination barrier is confirmed');
    assert.equal(fs.existsSync(owned.dir), false,
      'successful withdrawal cleanup must remove the owner marker and empty task directory');
    workerPid = null;
  } finally {
    try {
      process.kill(-wrapper.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    if (workerPid) {
      await waitFor(() => !processExists(workerPid), 3000);
    }
  }
}

async function main() {
  db.openDb(DB_PATH);
  const database = db.conn();
  const {
    localInterviewRecordingFinalizationUiState,
    localInterviewTerminationUiState,
  } = await import(
    pathToFileURL(path.join(PROJECT_ROOT, 'frontend/src/interview-review-navigation.mjs')).href
  );
  const actionSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/action-server.js"), 'utf8');
  const guardianSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/local-interview-guardian.js"), 'utf8');
  const workerGateSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/local-interview-worker-gate.js"), 'utf8');
  const localInterviewWorkerSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/local-interview-p0.js"), 'utf8');
  const localTerminationSource = actionSource.slice(
    actionSource.indexOf('function signalLocalInterviewProcessTree'),
    actionSource.indexOf('function freshActiveProgress'),
  );
  assert.match(localTerminationSource, /kill\(-job\.processGroupId, 'SIGKILL'\)/,
    'bounded escalation must use the exact owned negative PGID');
  assert.doesNotMatch(localTerminationSource, /\b(?:pkill|killall)\s|child\.kill\('SIGKILL'\).*processGroup === true/s,
    'owned recording termination must not use global/process-name or positive-PID fallback');
  assert.match(actionSource, /const stopResponse = interviewConsentStopHttpResult\(/,
    'consent endpoint must expose process-group stop failure instead of returning a silent 200');
  assert.match(actionSource, /cleanupPending: cleanupFailed/,
    'cleanup failure must keep the next recording blocked');
  assert.equal(localInterviewJobBlocksStart({
    status: 'error',
    cleanupPending: true,
    terminationUnconfirmed: false,
  }), true, 'cleanup failure must keep the start route on its 409 conflict path');
  assert.equal(localInterviewJobBlocksStart({
    status: 'error',
    cleanupPending: false,
    terminationUnconfirmed: false,
  }), false);
  assert.equal(localInterviewJobBlocksStart({
    status: 'error',
    transcriptionRetryable: true,
    cleanupPending: false,
    terminationUnconfirmed: false,
  }), true, 'a preserved ASR failure must block a second recording until HR retries or discards it');
  const shutdownSource = actionSource.slice(
    actionSource.indexOf('async function shutdown()'),
    actionSource.indexOf('if (require.main === module)'),
  );
  assert.match(shutdownSource, /abortLocalInterviewJob\(/,
    'shutdown must reuse the owned PGID abort controller');
  assert.match(localInterviewWorkerSource, /args\.record[\s\S]*type: 'transcription_started'/,
    'a completed formal capture must explicitly announce the transition into transcription');
  assert.match(workerGateSource, /message\.type === 'transcription_started'[\s\S]*sendToGuardian\(\{ type: 'transcription_started'/,
    'the owned worker gate must forward the capture-to-transcription transition');
  assert.match(guardianSource, /persistedCleanupDisposition\(\)[\s\S]*transcription_in_progress[\s\S]*derived-only/,
    'guardian recovery must retain recording.wav after a crash during transcription');
  assert.match(guardianSource, /abort_pending[\s\S]*cleanup_in_progress[\s\S]*return 'full'/,
    'explicit abort, consent withdrawal and lifecycle close must override preservation and fully delete');
  assert.match(shutdownSource, /ownedJob\.transcriptionStarted === true[\s\S]*ownedJob\.mode === 'record' && ownedJob\.stopRequested === true/,
    'application restart during formal transcription must preserve the already completed recording');
  assert.doesNotMatch(shutdownSource, /\[localChild,[\s\S]+waitForChildExit/,
    'shutdown must not put the local recording through parent-only exit waiting');
  assert.match(actionSource, /bindConsentId: consent\.id/,
    'formal record start must carry the exact active consent into auto-bind');
  const lifecycleWithdrawalHelperSource = actionSource.slice(
    actionSource.indexOf('function withdrawInterviewLifecycleAndStop('),
    actionSource.indexOf('function interviewLifecycleWithdrawalHttpResult('),
  );
  assert.match(lifecycleWithdrawalHelperSource, /candidateId: session\.candidate_id,[\s\S]*jobId: session\.job_id,/,
    'Session lifecycle withdrawal must stop the shared candidate/job recording scope');
  assert.doesNotMatch(lifecycleWithdrawalHelperSource, /round:\s*session\.round/,
    'Session lifecycle withdrawal must not leave another round running under the revoked shared consent');
  assert.match(actionSource, /候选人录音授权已撤回[\s\S]*candidateId,[\s\S]*jobId,[\s\S]*\}\);/,
    'candidate/job consent withdrawal must retain its broader all-round scope');

  const bindOrder = [];
  const bindingJob = {
    id: 'synthetic-binding-order',
    ownerToken: 'synthetic-owner',
    outDir: '/synthetic/out',
    persistentStateError: null,
  };
  const bindingResult = persistAndBindLocalInterviewResult({
    job: bindingJob,
    result: { summaryPath: '/synthetic/summary.json', mode: 'record' },
    bindCandidateId: 'synthetic-candidate',
    bindJobId: 7,
    bindRound: 1,
    bindConsentId: 9,
  }, {
    persistState: (job, state) => {
      bindOrder.push(`persist:${state}`);
      if (state === 'completed') {
        job.persistentStateError = 'synthetic completed marker fsync failure';
        return false;
      }
      job.persistentStateError = null;
      return true;
    },
    bindResult: () => {
      assert.deepEqual(bindOrder, ['persist:binding_in_progress'],
        'the durable binding transaction must exist before the first database write');
      bindOrder.push('database:auto_bind');
      return { id: 77 };
    },
  });
  assert.equal(bindingResult.ok, false);
  assert.equal(bindingResult.code, 'LOCAL_INTERVIEW_STATE_PERSIST_FAILED');
  assert.deepEqual(bindOrder, [
    'persist:binding_in_progress',
    'database:auto_bind',
    'persist:completed',
    'persist:bind_failed',
  ], 'a failed completed marker must fall back to a durable idempotent bind blocker');
  assert.equal(bindingJob.bindingPending, true);

  let forbiddenDatabaseWrites = 0;
  const bindingGateFailure = persistAndBindLocalInterviewResult({
    job: { persistentStateError: 'synthetic directory fsync failure' },
    result: { summaryPath: '/synthetic/summary.json', mode: 'record' },
  }, {
    persistState: () => false,
    bindResult: () => { forbiddenDatabaseWrites += 1; },
  });
  assert.equal(bindingGateFailure.ok, false);
  assert.equal(forbiddenDatabaseWrites, 0,
    'a binding_in_progress durability failure must prevent every database write');

  const lostProofJob = {
    guardianManaged: true,
    processGroup: true,
    processGroupId: 424244,
    groupQuiescent: false,
    groupQuiescenceProof: null,
    child: { exitCode: 0, signalCode: null },
  };
  assert.equal(localInterviewGuardianExitRequiresAbort(lostProofJob, {
    platform: 'darwin',
    kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
  }), false, 'a lost quiescence IPC frame plus exact same-runtime PGID ESRCH must preserve normal finalization');
  assert.equal(lostProofJob.abortRequested, undefined,
    'the lost-proof ESRCH path must not convert a completed result into abort cleanup');
  assert.equal(localInterviewGuardianExitRequiresAbort(lostProofJob, {
    platform: 'darwin',
    kill: () => true,
  }), true, 'a still-live PGID without trusted proof must fail closed into abort settlement');

  const durableOwnerSyncs = [];
  const durableOwnerJobId = 'synthetic-owner-durability-success';
  const durableOwnerToken = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const durableOwnerDir = localInterviewOutDir('owner-durability', {
    jobId: durableOwnerJobId,
    ownerToken: durableOwnerToken,
    root: MATERIAL_ROOT,
    syncDirectory: (directory) => {
      durableOwnerSyncs.push(path.resolve(directory));
      // Windows cannot fsync a directory handle, which is why
      // durable-atomic-file.js exempts win32 from its own directory sync. The
      // recorded call below is what this check actually asserts on.
      if (process.platform === 'win32') return;
      const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0));
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    },
  });
  assert.deepEqual(durableOwnerSyncs, [
    fs.realpathSync(durableOwnerDir),
    fs.realpathSync(MATERIAL_ROOT),
  ],
    'owner creation must fsync the owned directory and then its material root before state creation');
  assert.equal(cleanupAbortedLocalInterviewArtifacts(durableOwnerDir, {
    jobId: durableOwnerJobId,
    ownerToken: durableOwnerToken,
    root: MATERIAL_ROOT,
  }).ok, true);

  const beforeOwnerFault = new Set(fs.readdirSync(MATERIAL_ROOT));
  let ownerFaultSyncCount = 0;
  const ownerFaultJobId = 'synthetic-owner-durability-failure';
  const ownerFaultToken = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
  assert.throws(() => localInterviewOutDir('owner-root-fsync-failure', {
    jobId: ownerFaultJobId,
    ownerToken: ownerFaultToken,
    root: MATERIAL_ROOT,
    syncDirectory: () => {
      ownerFaultSyncCount += 1;
      if (ownerFaultSyncCount === 2) throw new Error('synthetic material-root fsync failure');
    },
  }), /synthetic material-root fsync failure/);
  assert.equal(ownerFaultSyncCount, 2,
    'the material-root durability fault must occur only after the owner directory barrier');
  const ownerFaultEntry = fs.readdirSync(MATERIAL_ROOT).find((name) => !beforeOwnerFault.has(name));
  assert.ok(ownerFaultEntry, 'a failed root fsync must retain a fail-closed owned directory for recovery');
  const ownerFaultDir = path.join(MATERIAL_ROOT, ownerFaultEntry);
  const ownerFaultBlocker = recoverPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT });
  assert.equal(ownerFaultBlocker.recoveredState, 'untrusted',
    'an owner directory whose root entry durability was not confirmed must block restart');
  assert.equal(cleanupAbortedLocalInterviewArtifacts(ownerFaultDir, {
    jobId: ownerFaultJobId,
    ownerToken: ownerFaultToken,
    root: MATERIAL_ROOT,
  }).ok, true);

  if (process.platform === 'win32') {
    console.log(
      'check-interview-recording-consent-withdrawal-001: SKIP directory-fsync fault injection on win32 (directory fsync is not supported)',
    );
  } else {
    const stateFaultFixture = createOwnedFixture('state-directory-fsync-failure');
    let stateFsyncCalls = 0;
    const fsWithStateFault = Object.create(fs);
    fsWithStateFault.fsyncSync = (descriptor) => {
      stateFsyncCalls += 1;
      if (stateFsyncCalls === 2) throw new Error('synthetic state-directory fsync failure');
      return fs.fsyncSync(descriptor);
    };
    assert.throws(() => writeLocalInterviewPersistentState({
      id: stateFaultFixture.jobId,
      ownerToken: stateFaultFixture.ownerToken,
      outDir: stateFaultFixture.dir,
      mode: 'record',
      topic: 'state-directory-fsync-failure',
      cleanupPending: false,
      bindingPending: false,
      terminationUnconfirmed: false,
    }, 'starting', {
      root: MATERIAL_ROOT,
      atomicWriteOptions: { fsImpl: fsWithStateFault },
    }), /synthetic state-directory fsync failure/);
    assert.equal(stateFsyncCalls, 2,
      'state durability must fsync the file before the owned directory entry');
    assert.ok(recoverPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT }),
      'a state directory-fsync fault must remain restart-visible and block worker startup');
    assert.equal(cleanupAbortedLocalInterviewArtifacts(stateFaultFixture.dir, {
      jobId: stateFaultFixture.jobId,
      ownerToken: stateFaultFixture.ownerToken,
      root: MATERIAL_ROOT,
    }).ok, true);
  }

  const formalFailureFixture = createOwnedFixture('formal-no-result-preserved');
  writeAbortArtifacts(formalFailureFixture.dir, [
    'recording.wav',
    'transcript.partial',
    'run.log',
  ]);
  writeLocalInterviewPersistentState({
    id: formalFailureFixture.jobId,
    ownerToken: formalFailureFixture.ownerToken,
    outDir: formalFailureFixture.dir,
    mode: 'record',
    topic: 'formal-no-result-preserved',
    cleanupPending: false,
    bindingPending: false,
    terminationUnconfirmed: false,
  }, 'transcription_failed', { root: MATERIAL_ROOT });
  const formalFailureCleanup = cleanupOwnedLocalInterviewDerivedArtifacts({
    outDir: formalFailureFixture.dir,
    root: MATERIAL_ROOT,
    jobId: formalFailureFixture.jobId,
    ownerToken: formalFailureFixture.ownerToken,
  });
  assert.equal(formalFailureCleanup.ok, true,
    'a formal recording/ASR failure may remove only derived partial transcription artifacts');
  assert.equal(fs.existsSync(path.join(formalFailureFixture.dir, 'recording.wav')), true,
    'a completed formal recording must survive ASR failure');
  assert.equal(fs.existsSync(path.join(formalFailureFixture.dir, 'transcript.partial')), false);
  assert.equal(fs.existsSync(path.join(formalFailureFixture.dir, 'run.log')), true);
  const recoveredFormalFailure = recoverPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT });
  assert.equal(recoveredFormalFailure.recoveredState, 'transcription_failed');
  assert.equal(recoveredFormalFailure.transcriptionRetryable, true);
  assert.equal(localInterviewJobBlocksStart(recoveredFormalFailure), true);
  assert.equal(cleanupAbortedLocalInterviewArtifacts(
    formalFailureFixture.dir,
    formalFailureFixture,
  ).ok, true, 'explicit discard must still remove the complete owned recording directory');

  const formalCleanupFailureFixture = createOwnedFixture('formal-no-result-cleanup-failure');
  writeAbortArtifacts(formalCleanupFailureFixture.dir, ['recording.wav', 'run.log']);
  writeLocalInterviewPersistentState({
    id: formalCleanupFailureFixture.jobId,
    ownerToken: formalCleanupFailureFixture.ownerToken,
    outDir: formalCleanupFailureFixture.dir,
    mode: 'record',
    topic: 'formal-no-result-cleanup-failure',
    cleanupPending: false,
    bindingPending: false,
    terminationUnconfirmed: false,
  }, 'running', { root: MATERIAL_ROOT });
  const formalCleanupStates = [];
  const formalCleanupFailure = cleanupFailedLocalInterviewResult({
    id: formalCleanupFailureFixture.jobId,
    ownerToken: formalCleanupFailureFixture.ownerToken,
    outDir: formalCleanupFailureFixture.dir,
    mode: 'record',
    groupQuiescent: true,
    groupQuiescenceProof: 'gate_worker_closed_pgid_empty',
  }, {
    root: MATERIAL_ROOT,
    groupState: 'gone',
    persistOptions: { root: MATERIAL_ROOT },
    persistState: (job, state, persistOptions) => {
      formalCleanupStates.push(state);
      try {
        writeLocalInterviewPersistentState(job, state, persistOptions);
        job.persistentStateFailed = false;
        return true;
      } catch (error) {
        job.persistentStateFailed = true;
        job.persistentStateError = error.message;
        return false;
      }
    },
    cleanupArtifacts: () => ({
      ok: false,
      removed: [],
      failures: [{ file: 'recording.wav', error: 'synthetic EPERM' }],
    }),
  });
  assert.equal(formalCleanupFailure.ok, false);
  assert.deepEqual(formalCleanupStates, ['cleanup_in_progress', 'cleanup_failed'],
    'a formal no-result deletion failure must transition through a durable cleanup blocker');
  assert.equal(recoverPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT }).recoveredState, 'cleanup_failed');
  assert.equal(cleanupAbortedLocalInterviewArtifacts(formalCleanupFailureFixture.dir, {
    jobId: formalCleanupFailureFixture.jobId,
    ownerToken: formalCleanupFailureFixture.ownerToken,
    root: MATERIAL_ROOT,
  }).ok, true);

  const restartLeaseFixture = createOwnedFixture('restart-guardian-cleanup-lease');
  writeAbortArtifacts(restartLeaseFixture.dir, ['recording.wav', 'run.log']);
  const restartGuardianId = '11111111-2222-4333-8444-555555555555';
  writeLocalInterviewPersistentState({
    id: restartLeaseFixture.jobId,
    ownerToken: restartLeaseFixture.ownerToken,
    outDir: restartLeaseFixture.dir,
    mode: 'record',
    topic: 'restart-guardian-cleanup-lease',
    processGroupId: 424245,
    guardianManaged: true,
    guardianInstanceId: restartGuardianId,
    cleanupPending: true,
    bindingPending: false,
    terminationUnconfirmed: true,
  }, 'termination_unconfirmed', { root: MATERIAL_ROOT });
  const guardianRegistryPath = path.join(ROOT, 'local-interview-guardian.v1.json');
  assert.throws(() => validateGuardianRegistry({
    schema_version: 'hrboss_local_interview_guardian_registry_v1',
    action_instance_id: 'previous-action-instance',
    guardian_instance_id: restartGuardianId,
    job_id: restartLeaseFixture.jobId,
    control_port: 43210,
    control_token: 'f'.repeat(64),
  }), /cannot be trusted/, 'guardian registry validation must require a positive guardian_pid');
  const writeRestartGuardianRegistry = ({
    guardianInstanceId = restartGuardianId,
    jobId = restartLeaseFixture.jobId,
    guardianPid = 424246,
  } = {}) => writeAtomicPrivateJson(guardianRegistryPath, {
    schema_version: 'hrboss_local_interview_guardian_registry_v1',
    action_instance_id: 'previous-action-instance',
    guardian_instance_id: guardianInstanceId,
    job_id: jobId,
    guardian_pid: guardianPid,
    control_port: 43210,
    control_token: 'f'.repeat(64),
    created_at: nowIsoForTest(),
  });
  writeRestartGuardianRegistry();
  const leasedRecovery = refreshPersistedLocalInterviewBlocker({
    root: MATERIAL_ROOT,
    guardianRegistryPath,
    platform: 'darwin',
    kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    guardianPidKill: (pid, signal) => {
      assert.equal(pid, 424246);
      assert.equal(signal, 0);
      return true;
    },
  });
  assert.equal(leasedRecovery.error, 'LOCAL_INTERVIEW_GUARDIAN_CLEANUP_ACTIVE');
  assert.equal(fs.existsSync(restartLeaseFixture.dir), true,
    'a restarted action must not race shared cleanup while the prior guardian lease exists');

  const unknownGuardianLease = refreshPersistedLocalInterviewBlocker({
    root: MATERIAL_ROOT,
    guardianRegistryPath,
    platform: 'darwin',
    kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    guardianPidKill: () => {
      throw Object.assign(new Error('synthetic guardian probe permission denial'), { code: 'EPERM' });
    },
  });
  assert.match(unknownGuardianLease.error, /^LOCAL_INTERVIEW_GUARDIAN_REGISTRY_INVALID:/);
  assert.equal(fs.existsSync(guardianRegistryPath), true,
    'EPERM or unknown guardian identity must retain the cleanup lease');
  assert.equal(fs.existsSync(restartLeaseFixture.dir), true);

  writeRestartGuardianRegistry({
    guardianInstanceId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    jobId: 'different-recovered-job',
    guardianPid: 424247,
  });
  const reusedPidLease = refreshPersistedLocalInterviewBlocker({
    root: MATERIAL_ROOT,
    guardianRegistryPath,
    platform: 'darwin',
    kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    guardianPidKill: (pid, signal) => {
      assert.equal(pid, 424247);
      assert.equal(signal, 0);
      return true;
    },
  });
  assert.match(reusedPidLease.error, /^LOCAL_INTERVIEW_GUARDIAN_REGISTRY_INVALID:/);
  assert.equal(fs.existsSync(guardianRegistryPath), true,
    'a live or PID-reused mismatched guardian must retain its fail-closed lease');
  assert.equal(fs.existsSync(restartLeaseFixture.dir), true);

  const staleGuardianWithLiveGroup = refreshPersistedLocalInterviewBlocker({
    root: MATERIAL_ROOT,
    guardianRegistryPath,
    platform: 'darwin',
    kill: (pid, signal) => {
      assert.equal(pid, -424245);
      assert.equal(signal, 0);
      return true;
    },
    guardianPidKill: (pid, signal) => {
      assert.equal(pid, 424247);
      assert.equal(signal, 0);
      throw Object.assign(new Error('stale guardian pid'), { code: 'ESRCH' });
    },
  });
  assert.equal(fs.existsSync(guardianRegistryPath), false,
    'an explicit guardian PID ESRCH must conditionally retire the stale registry instance');
  assert.equal(staleGuardianWithLiveGroup.error, 'LOCAL_INTERVIEW_TERMINATION_UNCONFIRMED');
  assert.equal(fs.existsSync(restartLeaseFixture.dir), true,
    'a dead guardian is not proof that its recorder PGID is gone');

  assert.equal(refreshPersistedLocalInterviewBlocker({
    root: MATERIAL_ROOT,
    guardianRegistryPath,
    platform: 'darwin',
    kill: () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
    guardianPidKill: () => {
      throw new Error('guardian PID must not be probed after its registry was retired');
    },
  }), null, 'after both stale lease retirement and PGID ESRCH, recovery may safely finish cleanup');
  assert.equal(fs.existsSync(restartLeaseFixture.dir), false);

  let parentOnlyFallbacks = 0;
  assert.equal(signalLocalInterviewProcessTree({
    child: { pid: 424242, exitCode: null, signalCode: null, kill: () => { parentOnlyFallbacks += 1; } },
    processGroup: true,
    processGroupId: 424242,
  }, 'SIGTERM', {
    platform: 'darwin',
    kill: () => { throw Object.assign(new Error('synthetic process group failure'), { code: 'EPERM' }); },
  }), false, 'an unconfirmed process-group stop must fail closed');
  assert.equal(parentOnlyFallbacks, 0, 'process-group failure must not fall back to a parent-only kill');

  const roundTwoActiveJob = {
    status: 'running',
    mode: 'record',
    child: {},
    bindCandidateId: 'candidate-cross-round',
    bindJobId: 42,
    bindRound: 2,
  };
  assert.equal(localInterviewStopMatches(roundTwoActiveJob, {
    abort: true,
    candidateId: 'candidate-cross-round',
    jobId: 42,
    round: 1,
  }), false, 'an explicitly exact round-one stop must not target round two');
  assert.equal(localInterviewStopMatches(roundTwoActiveJob, {
    abort: true,
    candidateId: 'candidate-cross-round',
    jobId: 42,
    round: 2,
  }), true, 'Session withdrawal must stop the exact active round');
  assert.equal(localInterviewStopMatches(roundTwoActiveJob, {
    abort: true,
    candidateId: 'candidate-cross-round',
    jobId: 42,
  }), true, 'candidate/job-level consent withdrawal must continue to stop any active round for that pair');
  assert.equal(localInterviewStopMatches({
    ...roundTwoActiveJob,
    status: 'starting',
  }, {
    abort: true,
    candidateId: 'candidate-cross-round',
    jobId: 42,
    round: 2,
  }), true, 'withdrawal must also match the pre-microphone starting window');

  const uniqueA = createOwnedFixture('same-topic');
  const uniqueB = createOwnedFixture('same-topic');
  assert.notEqual(uniqueA.dir, uniqueB.dir,
    'same-topic jobs must receive unpredictable exclusive directories instead of timestamp collisions');
  const privacyPath = createOwnedFixture('候选人张三-高级工程师');
  assert.match(path.basename(privacyPath.dir), /^[a-f0-9]{32}$/,
    'local interview task directories must use an opaque random basename');
  assert.doesNotMatch(privacyPath.dir, /张三|高级工程师|候选人/,
    'candidate names, titles and topics must never appear in filesystem paths');
  assert.equal(cleanupAbortedLocalInterviewArtifacts(privacyPath.dir, privacyPath).ok, true);
  assert.equal(fs.existsSync(privacyPath.dir), false);

  const recordingPhase = createOwnedFixture('abort-during-recording');
  const recordingArtifacts = ['recording.wav', 'run.log'];
  writeAbortArtifacts(recordingPhase.dir, [...recordingArtifacts, 'fixture-sentinel.json', 'source.fixture']);
  const siblingTask = createOwnedFixture('other-task');
  writeAbortArtifacts(siblingTask.dir, ['recording.wav']);
  let cleanup = cleanupAbortedLocalInterviewArtifacts(recordingPhase.dir, recordingPhase);
  assert.equal(cleanup.ok, false,
    'unknown regular files must block cleanup instead of being silently retained behind an ok result');
  assert.ok(cleanup.failures.some((item) => item.file === 'fixture-sentinel.json'));
  assert.ok(cleanup.failures.some((item) => item.file === 'source.fixture'));
  assert.equal(fs.existsSync(path.join(recordingPhase.dir, 'recording.wav')), true,
    'cleanup must validate the entire directory before deleting any known artifact');
  assert.equal(fs.existsSync(path.join(recordingPhase.dir, 'fixture-sentinel.json')), true,
    'unknown entries must never be deleted by broad recursive cleanup');
  assert.equal(fs.existsSync(path.join(recordingPhase.dir, 'source.fixture')), true,
    'broad source.* matching must not delete an unknown completed or fixture material');
  assert.equal(fs.existsSync(path.join(siblingTask.dir, 'recording.wav')), true,
    'withdrawal must not delete another task directory');
  fs.rmSync(path.join(recordingPhase.dir, 'fixture-sentinel.json'));
  fs.rmSync(path.join(recordingPhase.dir, 'source.fixture'));
  cleanup = cleanupAbortedLocalInterviewArtifacts(recordingPhase.dir, recordingPhase);
  assert.equal(cleanup.ok, true);
  assert.equal(fs.existsSync(recordingPhase.dir), false,
    'successful cleanup must remove known files, markers and the now-empty task directory');

  const completedOwner = createOwnedFixture('completed-owner');
  writeAbortArtifacts(completedOwner.dir, ['recording.wav', 'transcript.txt', 'summary.json', 'codex-input.md']);
  cleanup = cleanupAbortedLocalInterviewArtifacts(completedOwner.dir, uniqueB);
  assert.equal(cleanup.ok, false, 'a new task owner must not clean a prior task directory');
  assert.equal(fs.existsSync(path.join(completedOwner.dir, 'summary.json')), true,
    'existing completed materials must survive an owner-token mismatch');
  assert.equal(fs.existsSync(path.join(completedOwner.dir, 'recording.wav')), true,
    'owner validation must happen before any completed material is removed');
  for (const fixture of [uniqueA, uniqueB, siblingTask, completedOwner]) {
    cleanup = cleanupAbortedLocalInterviewArtifacts(fixture.dir, fixture);
    assert.equal(cleanup.ok, true);
    assert.equal(fs.existsSync(fixture.dir), false);
  }

  const transcribingPhase = createOwnedFixture('abort-during-transcribing');
  const transcribingArtifacts = [
    'recording.wav',
    'transcript.txt',
    'transcript.srt',
    'transcript.json',
    'transcript.partial',
    'summary.json',
    'codex-input.md',
    'run.log',
  ];
  writeAbortArtifacts(transcribingPhase.dir, transcribingArtifacts);
  cleanup = cleanupAbortedLocalInterviewArtifacts(transcribingPhase.dir, transcribingPhase);
  assert.equal(cleanup.ok, true);
  assertRemoved(transcribingPhase.dir, transcribingArtifacts);
  assert.equal(fs.existsSync(transcribingPhase.dir), false,
    'withdrawal during transcription must remove the complete task directory');

  const cleanupFailure = createOwnedFixture('abort-cleanup-failure');
  writeAbortArtifacts(cleanupFailure.dir, ['recording.wav']);
  fs.mkdirSync(path.join(cleanupFailure.dir, 'transcript.partial'));
  cleanup = cleanupAbortedLocalInterviewArtifacts(cleanupFailure.dir, cleanupFailure);
  assert.equal(cleanup.ok, false, 'a non-file artifact target must make cleanup fail closed');
  assert.ok(cleanup.failures.some((item) => item.file === 'transcript.partial'));
  assert.equal(fs.existsSync(path.join(cleanupFailure.dir, 'transcript.partial')), true,
    'cleanup must never recursively delete an unexpected directory');
  assert.equal(fs.existsSync(path.join(cleanupFailure.dir, 'recording.wav')), true,
    'a known non-file blocker must be detected before any regular artifact is deleted');
  fs.rmdirSync(path.join(cleanupFailure.dir, 'transcript.partial'));
  cleanup = cleanupAbortedLocalInterviewArtifacts(cleanupFailure.dir, cleanupFailure);
  assert.equal(cleanup.ok, true);

  const unknownDirectory = createOwnedFixture('unknown-directory-blocker');
  writeAbortArtifacts(unknownDirectory.dir, ['recording.wav']);
  fs.mkdirSync(path.join(unknownDirectory.dir, 'unexpected-directory'));
  cleanup = cleanupAbortedLocalInterviewArtifacts(unknownDirectory.dir, unknownDirectory);
  assert.equal(cleanup.ok, false, 'an unknown directory must fail closed');
  assert.ok(cleanup.failures.some((item) => item.file === 'unexpected-directory'));
  assert.equal(fs.existsSync(path.join(unknownDirectory.dir, 'recording.wav')), true);
  fs.rmdirSync(path.join(unknownDirectory.dir, 'unexpected-directory'));
  cleanup = cleanupAbortedLocalInterviewArtifacts(unknownDirectory.dir, unknownDirectory);
  assert.equal(cleanup.ok, true);

  if (process.platform !== 'win32') {
    const unknownSymlink = createOwnedFixture('unknown-symlink-blocker');
    const outsideSymlinkTarget = path.join(ROOT, 'outside-symlink-target.txt');
    fs.writeFileSync(outsideSymlinkTarget, 'outside symlink sentinel\n', { mode: 0o600 });
    writeAbortArtifacts(unknownSymlink.dir, ['recording.wav']);
    fs.symlinkSync(outsideSymlinkTarget, path.join(unknownSymlink.dir, 'unexpected-link'), 'file');
    cleanup = cleanupAbortedLocalInterviewArtifacts(unknownSymlink.dir, unknownSymlink);
    assert.equal(cleanup.ok, false, 'an unknown symlink must fail closed');
    assert.ok(cleanup.failures.some((item) => item.file === 'unexpected-link'));
    assert.equal(fs.readFileSync(outsideSymlinkTarget, 'utf8'), 'outside symlink sentinel\n',
      'cleanup must never follow an unknown symlink');
    assert.equal(fs.existsSync(path.join(unknownSymlink.dir, 'recording.wav')), true);
    fs.unlinkSync(path.join(unknownSymlink.dir, 'unexpected-link'));
    cleanup = cleanupAbortedLocalInterviewArtifacts(unknownSymlink.dir, unknownSymlink);
    assert.equal(cleanup.ok, true);
  }

  const ownerOnlyFixture = createOwnedFixture('owner-only-crash-window');
  const ownerOnlyBlocker = recoverPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT });
  assert.equal(ownerOnlyBlocker.recoveredState, 'untrusted',
    'an owned directory without a durable state marker must block restart instead of being ignored');
  assert.equal(fs.realpathSync(ownerOnlyBlocker.outDir), fs.realpathSync(ownerOnlyFixture.dir));
  cleanup = cleanupAbortedLocalInterviewArtifacts(ownerOnlyFixture.dir, ownerOnlyFixture);
  assert.equal(cleanup.ok, true);
  assert.equal(recoverPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT }), null);

  const interruptedCleanup = createOwnedFixture('interrupted-cleanup');
  const interruptedCleanupJob = {
    id: interruptedCleanup.jobId,
    ownerToken: interruptedCleanup.ownerToken,
    outDir: interruptedCleanup.dir,
    mode: 'record',
    topic: 'interrupted-cleanup',
    cleanupPending: true,
    terminationUnconfirmed: false,
  };
  writeAbortArtifacts(interruptedCleanup.dir, ['recording.wav', 'run.log']);
  writeLocalInterviewPersistentState(interruptedCleanupJob, 'cleanup_in_progress', { root: MATERIAL_ROOT });
  cleanup = cleanupAbortedLocalInterviewArtifacts(interruptedCleanup.dir, {
    ...interruptedCleanup,
    removeFile: (target) => {
      if (path.basename(target) === 'run.log') {
        throw Object.assign(new Error('synthetic unlink interruption'), { code: 'EIO' });
      }
      fs.rmSync(target, { force: true });
    },
  });
  assert.equal(cleanup.ok, false);
  assert.equal(
    fs.existsSync(path.join(interruptedCleanup.dir, '.hrboss-local-interview-state.json')),
    true,
    'an interrupted material unlink must leave the durable cleanup blocker in place',
  );
  const interruptedCleanupBlocker = recoverPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT });
  assert.equal(interruptedCleanupBlocker.recoveredState, 'cleanup_in_progress');
  assert.equal(interruptedCleanupBlocker.cleanupPending, true);
  assert.equal(refreshPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT }), null,
    'restart recovery must retry and complete a cleanup interrupted before marker deletion');
  assert.equal(fs.existsSync(interruptedCleanup.dir), false);

  const outsideDirectory = path.join(ROOT, 'outside-interview-task');
  writeAbortArtifacts(outsideDirectory, ['recording.wav']);
  if (process.platform !== 'win32') {
    const linkedOutDir = path.join(MATERIAL_ROOT, 'linked-out-dir');
    fs.symlinkSync(outsideDirectory, linkedOutDir, 'dir');
    cleanup = cleanupAbortedLocalInterviewArtifacts(linkedOutDir, recordingPhase);
    assert.equal(cleanup.ok, false, 'a symlinked outDir must be rejected');
    assert.equal(fs.existsSync(path.join(outsideDirectory, 'recording.wav')), true,
      'symlink rejection must not delete its external target');
  }

  const outside = path.join(ROOT, 'outside-recording.wav');
  fs.writeFileSync(outside, 'synthetic outside file\n', { mode: 0o600 });
  cleanup = cleanupAbortedLocalInterviewArtifacts(path.dirname(outside), recordingPhase);
  assert.equal(cleanup.ok, false, 'cleanup must fail closed outside the controlled interview root');
  assert.equal(fs.existsSync(outside), true, 'cleanup must not touch files outside the controlled interview root');

  const micArtifacts = [
    'audio.wav',
    'transcript.txt',
    'transcript.srt',
    'transcript.json',
    'summary.json',
    'codex-input.md',
    'run.log',
  ];
  const micSuccessFixture = createOwnedFixture('合成候选人-麦克风预检');
  const micSuccessJob = {
    id: micSuccessFixture.jobId,
    ownerToken: micSuccessFixture.ownerToken,
    outDir: micSuccessFixture.dir,
    logPath: path.join(micSuccessFixture.dir, 'run.log'),
    status: 'running',
    mode: 'mic-check',
    topic: 'HRBOSS-mic-check',
    startedAt: nowIsoForTest(),
  };
  writeAbortArtifacts(micSuccessFixture.dir, micArtifacts);
  writeLocalInterviewPersistentState(micSuccessJob, 'running', { root: MATERIAL_ROOT });
  const micSuccess = finalizeLocalInterviewMicCheck(micSuccessJob, {
    success: true,
    root: MATERIAL_ROOT,
    result: {
      mode: 'mic-check',
      wavPath: path.join(micSuccessFixture.dir, 'audio.wav'),
      summaryPath: path.join(micSuccessFixture.dir, 'summary.json'),
      transcriptTxt: path.join(micSuccessFixture.dir, 'transcript.txt'),
      transcriptText: '合成麦克风测试短句',
      audioStats: {
        lengthSeconds: 8,
        maximumAmplitude: 0.3,
        rmsAmplitude: 0.08,
      },
      audioQuality: { level: 'pass', label: '可用', message: '合成测试通过' },
      micCheck: {
        level: 'pass',
        passed: true,
        transcriptText: '合成麦克风测试短句',
        message: '麦克风预检通过',
        recommendation: '可以开始面试',
      },
    },
  });
  assert.equal(micSuccess.status, 'done');
  assert.equal(micSuccess.cleanupPending, false);
  assert.equal(fs.existsSync(micSuccessFixture.dir), false,
    'successful mic-check finalization must delete audio, transcripts, summary, Codex packet, log, markers and task directory');
  assert.equal(micSuccess.outDir, null);
  assert.equal(micSuccess.logPath, null);
  assert.equal(micSuccess.result.ephemeral, true);
  assert.equal(micSuccess.result.micCheck.level, 'pass');
  assert.equal(micSuccess.result.micCheck.passed, true);
  assert.doesNotMatch(
    JSON.stringify(micSuccess.result),
    /wavPath|summaryPath|transcriptTxt|codexInput|transcriptText|roughFrequency|rmsAmplitude/,
    'the in-memory mic-check result must retain only a generic pass/level conclusion, never paths, transcript or detailed voice metrics',
  );

  const sanitizedMicCheck = sanitizeLocalInterviewMicCheckResult({
    wavPath: '/private/candidate-name/audio.wav',
    transcriptText: '合成短句',
    micCheck: { level: 'warn', recommendation: '重试', transcriptText: '合成短句' },
  });
  assert.equal(sanitizedMicCheck.ephemeral, true);
  assert.doesNotMatch(JSON.stringify(sanitizedMicCheck), /candidate-name|wavPath|合成短句/,
    'mic-check result sanitization must allowlist a generic conclusion rather than copy paths or recognized speech');

  const micFailureFixture = createOwnedFixture('合成失败预检');
  const micFailureJob = {
    id: micFailureFixture.jobId,
    ownerToken: micFailureFixture.ownerToken,
    outDir: micFailureFixture.dir,
    logPath: path.join(micFailureFixture.dir, 'run.log'),
    status: 'running',
    mode: 'mic-check',
    topic: 'HRBOSS-mic-check',
    startedAt: nowIsoForTest(),
  };
  writeAbortArtifacts(micFailureFixture.dir, micArtifacts);
  writeLocalInterviewPersistentState(micFailureJob, 'running', { root: MATERIAL_ROOT });
  const micFailure = finalizeLocalInterviewMicCheck(micFailureJob, {
    success: false,
    processError: 'synthetic local ASR failure',
    root: MATERIAL_ROOT,
  });
  assert.equal(micFailure.status, 'error');
  assert.equal(micFailure.error, 'synthetic local ASR failure');
  assert.equal(micFailure.result, null);
  assert.equal(fs.existsSync(micFailureFixture.dir), false,
    'failed mic-check finalization must delete the same complete temporary material set');

  const bindProvenanceFixture = createOwnedFixture('bind-provenance-restart');
  const bindProvenanceJob = {
    id: bindProvenanceFixture.jobId,
    ownerToken: bindProvenanceFixture.ownerToken,
    outDir: bindProvenanceFixture.dir,
    status: 'error',
    mode: 'record',
    topic: 'bind-provenance-restart',
    bindCandidateId: 'candidate-provenance',
    bindJobId: 7788,
    bindRound: 4,
    bindConsentId: 9911,
    bindingPending: true,
    cleanupPending: false,
    terminationUnconfirmed: false,
  };
  writeAbortArtifacts(bindProvenanceFixture.dir, ['recording.wav', 'summary.json', 'run.log']);
  writeLocalInterviewPersistentState(bindProvenanceJob, 'bind_failed', { root: MATERIAL_ROOT });
  const persistedBindState = JSON.parse(fs.readFileSync(
    path.join(bindProvenanceFixture.dir, '.hrboss-local-interview-state.json'),
    'utf8',
  ));
  assert.equal(persistedBindState.bind_round, 4);
  assert.equal(persistedBindState.bind_consent_id, 9911);
  assert.equal(persistedBindState.binding_pending, true);
  const recoveredBindProvenance = recoverPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT });
  assert.equal(recoveredBindProvenance.recoveredState, 'bind_failed');
  assert.equal(recoveredBindProvenance.bindCandidateId, 'candidate-provenance');
  assert.equal(recoveredBindProvenance.bindJobId, 7788);
  assert.equal(recoveredBindProvenance.bindRound, 4);
  assert.equal(recoveredBindProvenance.bindConsentId, 9911);
  assert.equal(recoveredBindProvenance.bindingPending, true);
  assert.equal(localInterviewJobBlocksStart(recoveredBindProvenance), true,
    'a failed formal recording bind must remain a durable new-recording blocker after restart');
  cleanup = cleanupAbortedLocalInterviewArtifacts(bindProvenanceFixture.dir, bindProvenanceFixture);
  assert.equal(cleanup.ok, true);
  assert.equal(recoverPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT }), null);

  const revokedConsent = { id: 77, status: 'revoked', valid: false };
  const stopFailure = interviewConsentStopHttpResult({
    confirmed: false,
    consent: revokedConsent,
    policy: { storage: 'local_only' },
    stopResult: {
      matched: true,
      stopped: false,
      job: { status: 'error', cleanup_pending: true, termination_unconfirmed: true },
    },
  });
  assert.equal(stopFailure.status, 503);
  assert.equal(stopFailure.body.ok, false);
  assert.equal(stopFailure.body.code, 'INTERVIEW_RECORDING_STOP_FAILED');
  assert.equal(stopFailure.body.stop_failed, true);
  assert.equal(stopFailure.body.recording_stopped, false);
  assert.equal(stopFailure.body.consent.status, 'revoked',
    'stop delivery failure must not roll consent back to active');
  const stopPending = interviewConsentStopHttpResult({
    confirmed: false,
    consent: revokedConsent,
    policy: {},
    stopResult: { matched: true, stopped: true, job: { status: 'running', cleanup_pending: true } },
  });
  assert.equal(stopPending.status, 202);
  assert.equal(stopPending.body.recording_stop_requested, true);
  assert.equal(stopPending.body.recording_stopped, false,
    'successful signal delivery is only a pending stop request, not confirmed termination');

  const manualStopFixture = createOwnedFixture('manual-stop-failure');
  const manualStopJob = {
    id: manualStopFixture.jobId,
    ownerToken: manualStopFixture.ownerToken,
    outDir: manualStopFixture.dir,
    status: 'running',
    mode: 'record',
    topic: 'manual-stop-failure',
    startedAt: new Date().toISOString(),
    child: { pid: 565656, exitCode: null, signalCode: null, kill: () => true },
    processGroup: true,
    processGroupId: 565656,
  };
  writeLocalInterviewPersistentState(manualStopJob, 'running', { root: MATERIAL_ROOT });
  const manualStopFailure = requestOwnedLocalInterviewManualStop(manualStopJob, '', {
    platform: 'darwin',
    kill: () => { throw Object.assign(new Error('synthetic manual stop failure'), { code: 'EPERM' }); },
  });
  assert.equal(manualStopFailure.stopped, false);
  assert.equal(manualStopJob.stopRequested, false,
    'failed manual stop delivery must restore the retryable stop-button state');
  assert.equal(manualStopJob.stopFailed, true);
  assert.equal(manualStopFailure.job.status, 'running',
    'manual stop delivery failure must continue to report that recording may be active');
  const manualStopResponse = localInterviewManualStopHttpResult(manualStopFailure);
  assert.equal(manualStopResponse.status, 503);
  assert.equal(manualStopResponse.body.code, 'INTERVIEW_RECORDING_STOP_FAILED');
  assert.equal(manualStopResponse.body.recording_stop_requested, false);
  cleanup = cleanupAbortedLocalInterviewArtifacts(manualStopFixture.dir, manualStopFixture);
  assert.equal(cleanup.ok, true);

  const persistFailureFixture = createOwnedFixture('abort-marker-write-failure');
  const stateMarkerPath = path.join(persistFailureFixture.dir, '.hrboss-local-interview-state.json');
  fs.mkdirSync(stateMarkerPath);
  let abortSettlementStarted = 0;
  const persistFailureJob = {
    id: persistFailureFixture.jobId,
    ownerToken: persistFailureFixture.ownerToken,
    outDir: persistFailureFixture.dir,
    status: 'running',
    mode: 'record',
    topic: 'abort-marker-write-failure',
    startedAt: new Date().toISOString(),
    child: { pid: 575757, exitCode: null, signalCode: null, kill: () => true },
    processGroup: true,
    processGroupId: 575757,
    beginAbortSettlement: () => {
      abortSettlementStarted += 1;
      return Promise.resolve({ confirmed: false });
    },
  };
  const persistFailureStop = abortLocalInterviewJob(persistFailureJob, '', {
    signalOptions: { platform: 'darwin', kill: () => true },
  });
  assert.equal(persistFailureStop.stopped, false,
    'abort must be non-success when its restart blocker cannot be persisted');
  assert.equal(persistFailureJob.persistentStateFailed, true);
  assert.equal(abortSettlementStarted, 1,
    'marker persistence failure must not skip owned process-group settlement');
  const persistFailureResponse = interviewConsentStopHttpResult({
    confirmed: false,
    consent: revokedConsent,
    policy: {},
    stopResult: persistFailureStop,
  });
  assert.equal(persistFailureResponse.status, 503);
  fs.rmdirSync(stateMarkerPath);
  cleanup = cleanupAbortedLocalInterviewArtifacts(persistFailureFixture.dir, persistFailureFixture);
  assert.equal(cleanup.ok, true);

  if (process.platform !== 'win32') {
    const atomicStateFixture = createOwnedFixture('atomic-state-marker');
    const outsideStateTarget = path.join(ROOT, 'outside-state-target.json');
    fs.writeFileSync(outsideStateTarget, 'outside sentinel\n', { mode: 0o600 });
    const atomicStatePath = path.join(atomicStateFixture.dir, '.hrboss-local-interview-state.json');
    fs.symlinkSync(outsideStateTarget, atomicStatePath, 'file');
    writeLocalInterviewPersistentState({
      id: atomicStateFixture.jobId,
      ownerToken: atomicStateFixture.ownerToken,
      outDir: atomicStateFixture.dir,
      mode: 'record',
      topic: 'atomic-state-marker',
    }, 'completed', { root: MATERIAL_ROOT });
    assert.equal(fs.lstatSync(atomicStatePath).isSymbolicLink(), false,
      'persistent state updates must atomically replace, not follow, a marker symlink');
    assert.equal(fs.readFileSync(outsideStateTarget, 'utf8'), 'outside sentinel\n',
      'state marker replacement must not write through to an external symlink target');
  }

  const interruptedStateFixture = createOwnedFixture('interrupted-state-transaction');
  const interruptedStateTemp = path.join(
    interruptedStateFixture.dir,
    `.hrboss-local-interview-state.json.${'a'.repeat(32)}.tmp`,
  );
  const interruptedStateTarget = path.join(
    interruptedStateFixture.dir,
    '.hrboss-local-interview-state.json',
  );
  fs.writeFileSync(interruptedStateTemp, `${JSON.stringify({
    schema_version: 'hrboss_local_interview_state_v1',
    job_id: interruptedStateFixture.jobId,
    state: 'completed',
    mode: 'record',
    topic: 'interrupted-state-transaction',
    updated_at: new Date().toISOString(),
  })}\n`, { mode: 0o600 });
  assert.equal(recoverPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT }), null,
    'a completed atomic state transaction must not block a later recording');
  assert.equal(fs.existsSync(interruptedStateTemp), false,
    'restart recovery must finish an interrupted atomic state-marker rename');
  assert.equal(fs.existsSync(interruptedStateTarget), true,
    'restart recovery must retain the committed non-blocking marker');

  const recoveredProbeJob = {
    processGroup: true,
    processGroupId: 626262,
  };
  const aliveProbes = [];
  assert.equal(recoveredLocalInterviewProcessGroupState(recoveredProbeJob, {
    platform: 'darwin',
    kill: (pid, signal) => aliveProbes.push({ pid, signal }),
  }), 'alive');
  assert.deepEqual(aliveProbes, [{ pid: -626262, signal: 0 }],
    'restart recovery may only perform an exact, non-signalling process-group liveness probe');
  assert.equal(recoveredLocalInterviewProcessGroupState(recoveredProbeJob, {
    platform: 'darwin',
    kill: () => {
      throw Object.assign(new Error('synthetic permission denial'), { code: 'EPERM' });
    },
  }), 'unknown', 'EPERM must remain blocked instead of being treated as terminated');
  let missingPgidProbeCalled = false;
  assert.equal(recoveredLocalInterviewProcessGroupState({
    processGroup: true,
    processGroupId: null,
  }, {
    platform: 'darwin',
    kill: () => { missingPgidProbeCalled = true; },
  }), 'unknown', 'a missing persisted PGID must remain blocked');
  assert.equal(missingPgidProbeCalled, false);

  const staleProcessGroupFixture = createOwnedFixture('stale-process-group-after-restart');
  const staleStatePath = path.join(staleProcessGroupFixture.dir, '.hrboss-local-interview-state.json');
  writeAbortArtifacts(staleProcessGroupFixture.dir, ['recording.wav', 'run.log']);
  writeLocalInterviewPersistentState({
    id: staleProcessGroupFixture.jobId,
    ownerToken: staleProcessGroupFixture.ownerToken,
    outDir: staleProcessGroupFixture.dir,
    mode: 'record',
    topic: 'stale-process-group-after-restart',
    processGroupId: 636363,
    cleanupPending: true,
    terminationUnconfirmed: true,
  }, 'termination_unconfirmed', { root: MATERIAL_ROOT });
  const staleProbes = [];
  assert.equal(refreshPersistedLocalInterviewBlocker({
    root: MATERIAL_ROOT,
    platform: 'darwin',
    kill: (pid, signal) => {
      staleProbes.push({ pid, signal });
      throw Object.assign(new Error('synthetic process group absent'), { code: 'ESRCH' });
    },
  }), null, 'an absent persisted process group must be safely reconciled and cleaned after restart');
  assert.deepEqual(staleProbes, [{ pid: -636363, signal: 0 }]);
  assertRemoved(staleProcessGroupFixture.dir, ['recording.wav', 'run.log']);
  assert.equal(fs.existsSync(staleStatePath), false,
    'the restart blocker must clear only after exact PGID absence and owned-artifact cleanup');

  assert.deepEqual(localInterviewShutdownSafety({
    status: 'error',
    child: null,
    finalized: true,
    cleanupPending: true,
    terminationUnconfirmed: false,
  }), {
    ok: false,
    termination_confirmed: true,
    cleanup_complete: false,
  }, 'cleanup failure must produce a non-success shutdown result');
  assert.deepEqual(localInterviewShutdownSafety({
    status: 'error',
    child: null,
    finalized: false,
    cleanupPending: true,
    terminationUnconfirmed: true,
  }), {
    ok: false,
    termination_confirmed: false,
    cleanup_complete: false,
  }, 'unconfirmed termination must block guardian exit');
  assert.deepEqual(localInterviewShutdownSafety({
    status: 'cancelled',
    child: null,
    finalized: true,
    cleanupPending: false,
    terminationUnconfirmed: false,
  }), {
    ok: true,
    termination_confirmed: true,
    cleanup_complete: true,
  });

  const restartBlocker = createOwnedFixture('restart-cleanup-blocker');
  const restartBlockerJob = {
    id: restartBlocker.jobId,
    ownerToken: restartBlocker.ownerToken,
    outDir: restartBlocker.dir,
    status: 'error',
    mode: 'record',
    topic: 'restart-cleanup-blocker',
    cleanupPending: true,
    terminationUnconfirmed: false,
    stopFailed: true,
  };
  writeAbortArtifacts(restartBlocker.dir, ['recording.wav']);
  fs.mkdirSync(path.join(restartBlocker.dir, 'transcript.partial'));
  writeLocalInterviewPersistentState(restartBlockerJob, 'cleanup_failed', { root: MATERIAL_ROOT });
  const recoveredBlocker = recoverPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT });
  assert.equal(recoveredBlocker.id, restartBlocker.jobId);
  assert.equal(recoveredBlocker.cleanupPending, true);
  assert.equal(localInterviewJobBlocksStart(recoveredBlocker), true);
  const blockedStart = runLocalInterviewJob({ mode: 'record', topic: 'must-not-start' });
  assert.equal(blockedStart.status, 409,
    'a persisted cleanup failure must continue blocking new recordings after restart recovery');
  fs.rmdirSync(path.join(restartBlocker.dir, 'transcript.partial'));
  assert.equal(refreshPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT }), null,
    'safe cleanup retry must clear the persisted blocker only after all owned artifacts are removed');
  assert.equal(recoverPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT }), null);

  const candidateMainSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/candidate-main.js"), 'utf8');
  const supervisorStopSource = candidateMainSource.slice(
    candidateMainSource.indexOf('async function stopServers()'),
    candidateMainSource.indexOf('function healthRequest'),
  );
  assert.match(supervisorStopSource, /stopChild\(actionChild, 15_000, \{ forceKill: false \}\)/,
    'desktop supervisor must preserve the action-server guardian until it reports a safe exit');
  assert.doesNotMatch(supervisorStopSource, /actionChild\.kill\('SIGKILL'\)/,
    'desktop supervisor must never parent-kill the recording guardian');
  const runSource = actionSource.slice(
    actionSource.indexOf('function runLocalInterviewJob('),
    actionSource.indexOf('function freshActiveProgress'),
  );
  assert.match(runSource, /if \(shuttingDown\) \{\s*return \{ ok: false, status: 503/,
    'an in-flight shutdown must gate every new detached local interview start');

  const frontendApiSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/api.js'), 'utf8');
  const frontendPanelSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/InterviewReviewPanel.jsx'), 'utf8');
  const fallbackPanelSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/LocalInterviewPanel.jsx'), 'utf8');
  const settingsPanelSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/SettingsPanel.jsx'), 'utf8');
  assert.match(frontendApiSource, /error\.data = data \|\| null/,
    'frontend API errors must preserve the revoked-consent and stop-failure payload');
  assert.match(frontendPanelSource, /err\.code === 'INTERVIEW_RECORDING_STOP_FAILED'/,
    'frontend must handle stop failure without restoring consent');
  assert.match(frontendPanelSource, /job\.cleanup_pending === true[\s\S]+job\.termination_unconfirmed === true/,
    'frontend must keep polling through termination and cleanup confirmation');
  assert.match(frontendApiSource, /localInterviewMicCheck:[\s\S]*micCheckConsentConfirmed = false,[\s\S]*round = null,[\s\S]*clientRequestId = null[\s\S]*\/local-interview\/mic-check[\s\S]*micCheckConsentConfirmed,[\s\S]*round,[\s\S]*clientRequestId,/,
    'every mic-check request must carry an explicit local-consent acknowledgement and optional round provenance');
  assert.match(frontendPanelSource, /localInterviewMicCheck\([\s\S]*'HRBOSS-mic-check',[\s\S]*candidateId,[\s\S]*jobId,[\s\S]*true,[\s\S]*candidateRound,/,
    'candidate mic-check must use an opaque generic topic, stored consent gate and current round');
  assert.match(frontendPanelSource, /麦克风预检必须绑定当前面试的正整数轮次/,
    'candidate mic-check must fail closed instead of starting without round provenance');
  assert.match(frontendPanelSource, /disabled=\{readOnly \|\| !!busyAction \|\| consentRevocationPending \|\| !candidateId \|\| !jobId \|\| !consentChecked \|\| !selectedRecordingSession\}/,
    'candidate mic-check must stay disabled until consent and a canonical current Session are present');
  assert.match(frontendPanelSource, /aria-label="选择已创建的面试轮次"/);
  assert.doesNotMatch(frontendPanelSource, /name="interview-review-round"/,
    'candidate mic-check must not recover a free-form round input');
  assert.match(fallbackPanelSource, /localInterviewMicCheck\('HRBOSS-mic-check', 8, null, null, micCheckConsent, null\)/,
    'the standalone fallback mic-check must remain explicitly unbound from candidate and round');
  assert.match(settingsPanelSource, /localInterviewMicCheck\([\s\S]*'HRBOSS-mic-check',[\s\S]*8,[\s\S]*null,[\s\S]*null,[\s\S]*micCheckConsent,[\s\S]*null,[\s\S]*clientRequestId,[\s\S]*\)/,
    'the settings mic-check must remain explicitly unbound from candidate and round while carrying exact startup correlation');
  assert.match(fallbackPanelSource, /local-interview-mic-check-consent[\s\S]*!micCheckConsent/,
    'the fallback mic-check must require an explicit in-place consent confirmation');
  assert.match(settingsPanelSource, /已确认在场说话人知情[\s\S]*!micCheckConsent/,
    'settings mic-check must require an explicit in-place consent confirmation');
  assert.match(actionSource, /body\.micCheckConsentConfirmed !== true[\s\S]*code: 'mic_check_consent_required'/,
    'the action service must reject direct mic-check calls that bypass the renderer consent gate');
  assert.match(actionSource, /const candidateRound = bindCandidateId \? Number\(body\.round\) : null;[\s\S]*code: 'interview_round_required'[\s\S]*bindRound: candidateRound,/,
    'the action service must reject candidate mic-check calls that omit exact round provenance');
  assert.match(actionSource, /mode: 'mic-check',[\s\S]*topic: 'HRBOSS-mic-check'/,
    'the action service must ignore candidate-bearing mic-check topics');
  assert.match(actionSource, /\['record', 'mic-check', 'from-file', 'retry-transcription'\]\.includes\(job && job\.mode\)/,
    'consent withdrawal must terminate formal recording, candidate mic-check and bound file processing');
  assert.match(actionSource, /mode === 'retry-transcription'[\s\S]*--retry-recording/,
    'the preserved formal recording must have a same-recording transcription retry worker path');
  assert.match(frontendPanelSource, /转写失败，原录音已安全保留[\s\S]*重试转写[\s\S]*永久丢弃原录音/,
    'the candidate workbench must expose explicit retry and irreversible discard actions');
  assert.match(frontendPanelSource, /const \[consentRevocationPending, setConsentRevocationPending\] = useState\(false\)/,
    'candidate recording UI must model pending revocation explicitly');
  assert.match(frontendPanelSource, /message="录音授权撤回仍待完成"[\s\S]*重试完成撤回/,
    'pending revocation must show a fail-closed retry path');
  assert.match(frontendPanelSource, /consentRevocationPending[\s\S]*disabled=\{[\s\S]*consentRevocationPending/,
    'pending revocation must lock re-authorization and capture starts');
  assert.match(actionSource, /err && err\.code === 'INTERVIEW_CONSENT_REVOCATION_PENDING'[\s\S]*sendInterviewReportError\(res, err\)/,
    'candidate record and mic-check start routes must preserve the pending-gate 409 contract');
  assert.deepEqual(localInterviewTerminationUiState({
    status: 'running',
    stop_requested: true,
    cleanup_pending: true,
    termination_unconfirmed: false,
  }), {
    pending: true,
    blocking: false,
    label: '正在安全停止并清理',
  }, 'a successful stop request must not be mislabeled as transcript generation or already stopped');
  assert.deepEqual(localInterviewTerminationUiState({
    status: 'error',
    stop_failed: true,
    cleanup_pending: true,
    termination_unconfirmed: true,
  }), {
    pending: true,
    blocking: true,
    label: '录音停止未确认，已阻止继续操作',
  }, 'unconfirmed termination must render a blocking state');
  assert.deepEqual(localInterviewTerminationUiState({
    status: 'error',
    stop_failed: true,
    cleanup_pending: true,
    termination_unconfirmed: false,
  }), {
    pending: true,
    blocking: true,
    label: '未完成材料清理失败，已阻止继续操作',
  }, 'confirmed termination with deletion failure must not claim the recording stop is unconfirmed');
  assert.deepEqual(localInterviewTerminationUiState({
    status: 'error',
    persistent_state_failed: true,
  }), {
    pending: true,
    blocking: true,
    label: '录音安全状态保存失败，已阻止继续操作',
  }, 'persistent blocker failures must disable new recording actions in the UI');
  assert.deepEqual(localInterviewTerminationUiState({
    status: 'error',
    binding_pending: true,
  }), {
    pending: true,
    blocking: true,
    label: '录音材料归档待重试，已阻止新录音',
  }, 'a failed exact Session bind must remain visibly blocking until restart retry succeeds');
  assert.deepEqual(localInterviewRecordingFinalizationUiState({
    status: 'running',
    mode: 'record',
    stop_requested: true,
    cleanup_pending: true,
    termination_unconfirmed: false,
  }), {
    finalizing: true,
    discarding: true,
    transcribing: false,
    mode: 'discarding',
    buttonLabel: '正在停止并清理…',
  }, 'consent withdrawal must never present abort cleanup as transcript generation');
  assert.deepEqual(localInterviewRecordingFinalizationUiState({
    status: 'running',
    mode: 'record',
    stop_requested: true,
    cleanup_pending: false,
    termination_unconfirmed: false,
  }), {
    finalizing: true,
    discarding: false,
    transcribing: true,
    mode: 'transcribing',
    buttonLabel: '正在生成转写…',
  }, 'the transcript-generation label must remain exclusive to ordinary manual stop');

  await checkOwnedProcessGroupTermination();

  const { job, candidate } = seedJobAndCandidate();
  const consent = db.recordInterviewConsent({
    candidateId: candidate.internal_id,
    jobId: job.id,
    confirmed: true,
    recordedBy: 'HR-SYNTHETIC',
    source: 'candidate_interview_ui',
  });
  assert.equal(consent.status, 'active');

  const failedBind = writeCompletedSummary('failed-auto-bind');
  assert.throws(() => autoBindLocalInterviewResult({
    result: { summaryPath: failedBind.summaryPath, mode: 'record' },
    bindCandidateId: candidate.internal_id,
    bindJobId: job.id,
    bindRound: 2,
    bindConsentId: 999999,
  }), /interview consent not found/, 'consent-link failure must reject the whole auto-bind transaction');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_recording WHERE summary_path = ?')
    .get(fs.realpathSync(failedBind.summaryPath)).n, 0,
  'a failed consent link must roll back the recording row');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_pending_assignment').get().n, 0,
    'a failed consent link must roll back its pending assignment');
  assert.equal(db.listInterviewSessions({
    candidateId: candidate.internal_id,
    jobId: job.id,
    round: 2,
  }).length, 0, 'a failed consent link must roll back the assigned session and material');

  const retryBindFixture = createOwnedFixture('restart-bind-retry');
  writeCompletedSummaryAt(retryBindFixture.dir, 'restart-bind-retry');
  writeLocalInterviewPersistentState({
    id: retryBindFixture.jobId,
    ownerToken: retryBindFixture.ownerToken,
    outDir: retryBindFixture.dir,
    status: 'error',
    mode: 'record',
    topic: 'restart-bind-retry',
    bindCandidateId: candidate.internal_id,
    bindJobId: job.id,
    bindRound: 3,
    bindConsentId: consent.id,
    bindingPending: true,
    cleanupPending: false,
    terminationUnconfirmed: false,
  }, 'bind_failed', { root: MATERIAL_ROOT });
  const restartBindBlocker = recoverPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT });
  assert.equal(restartBindBlocker.recoveredState, 'bind_failed');
  assert.equal(restartBindBlocker.bindRound, 3);
  assert.equal(restartBindBlocker.bindConsentId, consent.id);
  assert.equal(retryRecoveredLocalInterviewBinding(restartBindBlocker, { root: MATERIAL_ROOT }), true,
    'restart recovery must idempotently retry the exact failed formal bind');
  assert.equal(recoverPersistedLocalInterviewBlocker({ root: MATERIAL_ROOT }), null,
    'a successful exact bind retry must persist completed and release the recording blocker');
  const retryBindSession = db.listInterviewSessions({
    candidateId: candidate.internal_id,
    jobId: job.id,
    round: 3,
  })[0];
  assert.ok(retryBindSession, 'bind retry must restore the originally requested interview round');
  assert.equal(db.getInterviewSession(retryBindSession.id).consents[0].consent_id, consent.id,
    'bind retry must link the exact originally persisted consent record');
  assert.equal(
    JSON.parse(fs.readFileSync(
      path.join(retryBindFixture.dir, '.hrboss-local-interview-state.json'),
      'utf8',
    )).state,
    'completed',
  );

  const completed = writeCompletedSummary('completed-auto-bind');
  const bindInput = {
    result: { summaryPath: completed.summaryPath, mode: 'record' },
    bindCandidateId: candidate.internal_id,
    bindJobId: job.id,
    bindRound: 1,
    bindConsentId: consent.id,
  };
  const first = autoBindLocalInterviewResult(bindInput);
  const firstSession = db.listInterviewSessions({
    candidateId: candidate.internal_id,
    jobId: job.id,
    round: 1,
  })[0];
  const firstConsentLink = database.prepare(`
    SELECT * FROM interview_session_consent WHERE session_id = ? AND consent_id = ?
  `).get(firstSession.id, consent.id);
  const second = autoBindLocalInterviewResult(bindInput);
  const secondConsentLink = database.prepare(`
    SELECT * FROM interview_session_consent WHERE session_id = ? AND consent_id = ?
  `).get(firstSession.id, consent.id);
  assert.equal(second.id, first.id, 'replayed completion callback must reuse the recording');
  assert.equal(secondConsentLink.id, firstConsentLink.id,
    'replayed completion callback must reuse the consent link');
  assert.equal(secondConsentLink.linked_at, firstConsentLink.linked_at,
    'replayed completion callback must preserve the original audit timestamp');

  const sessions = db.listInterviewSessions({
    candidateId: candidate.internal_id,
    jobId: job.id,
    round: 1,
  });
  assert.equal(sessions.length, 1);
  const session = db.getInterviewSession(sessions[0].id);
  assert.equal(session.materials.length, 1);
  assert.equal(session.consents.length, 1, 'the active recording consent must be linked to the assigned session');
  assert.equal(session.consents[0].consent_id, consent.id);
  assert.equal(session.consents[0].linked_by, 'local-primary-operator');
  assert.ok(session.consents[0].linked_at);

  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM interview_session_consent WHERE session_id = ? AND consent_id = ?
  `).get(sessions[0].id, consent.id).n, 1, 'consent link must be idempotent');
  const auditRows = database.prepare(`
    SELECT who, detail_json FROM audit_log
    WHERE action = '面试录音授权关联 Session' AND target = ?
  `).all(String(sessions[0].id));
  assert.equal(auditRows.length, 1, 'idempotent replay must not duplicate the consent-link audit event');
  assert.equal(auditRows[0].who, 'local-primary-operator');
  assert.deepEqual(JSON.parse(auditRows[0].detail_json), {
    session_id: sessions[0].id,
    consent_id: consent.id,
  });

  const completedRoundTwo = writeCompletedSummary('completed-auto-bind-round-2');
  const roundTwoRecording = autoBindLocalInterviewResult({
    result: { summaryPath: completedRoundTwo.summaryPath, mode: 'record' },
    bindCandidateId: candidate.internal_id,
    bindJobId: job.id,
    bindRound: 2,
    bindConsentId: consent.id,
  });
  assert.notEqual(roundTwoRecording.id, first.id,
    'a second formal interview round must create its own recording');
  const roundTwoSessions = db.listInterviewSessions({
    candidateId: candidate.internal_id,
    jobId: job.id,
    round: 2,
  });
  assert.equal(roundTwoSessions.length, 1,
    'the same still-active 24-hour consent must not roll back second-round auto-bind');
  const roundTwoSession = db.getInterviewSession(roundTwoSessions[0].id);
  assert.equal(roundTwoSession.materials.length, 1);
  assert.equal(roundTwoSession.materials[0].interview_recording_id, roundTwoRecording.id);
  assert.equal(roundTwoSession.consents.length, 1);
  assert.equal(roundTwoSession.consents[0].consent_id, consent.id,
    'each actual interview Session must retain the exact consent used to start its recording');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM audit_log
    WHERE action = '面试录音授权关联 Session' AND target = ?
  `).get(String(roundTwoSession.id)).n, 1,
  'second-round consent reuse must write exactly one Session-specific audit event');

  database.prepare(`
    DELETE FROM interview_session_consent WHERE session_id = ? AND consent_id = ?
  `).run(roundTwoSession.id, consent.id);
  database.prepare(`
    DELETE FROM interview_session_consent WHERE session_id = ? AND consent_id = ?
  `).run(retryBindSession.id, consent.id);
  database.exec(`
    ALTER TABLE interview_session_consent RENAME TO interview_session_consent_current;
    CREATE TABLE interview_session_consent (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES interview_session(id) ON DELETE CASCADE,
      consent_id INTEGER NOT NULL UNIQUE REFERENCES interview_recording_consent(id) ON DELETE RESTRICT,
      linked_by TEXT NOT NULL CHECK(LENGTH(TRIM(linked_by)) > 0),
      linked_at TEXT NOT NULL,
      UNIQUE(session_id, consent_id)
    );
    INSERT INTO interview_session_consent (id, session_id, consent_id, linked_by, linked_at)
    SELECT id, session_id, consent_id, linked_by, linked_at
    FROM interview_session_consent_current;
    DROP TABLE interview_session_consent_current;
  `);
  database.close();
  const recoveryRoot = path.join(ROOT, 'migration-recovery');
  const migrationBackup = await db.prepareDatabaseMigrationBackup(DB_PATH, {
    recoveryRoot,
    recoveryId: 'pre-consent-reuse-upgrade',
    createdAt: '2026-07-23T03:00:00.000Z',
  });
  assert.equal(migrationBackup.backup_required, true,
    'legacy UNIQUE(consent_id) must enter the pre-migration recovery backup gate');
  const backupDatabasePath = path.join(recoveryRoot, 'pre-consent-reuse-upgrade', 'database.db');
  assert.equal(fs.existsSync(backupDatabasePath), true);
  const backupDatabase = new Database(backupDatabasePath, { readonly: true });
  assert.equal(backupDatabase.prepare(`
    SELECT COUNT(*) AS n FROM interview_session_consent
    WHERE session_id = ? AND consent_id = ?
  `).get(sessions[0].id, consent.id).n, 1,
  'the recovery point must be readable and retain the pre-upgrade consent relation');
  backupDatabase.close();
  const upgradedDatabase = db.openDb(DB_PATH);
  assert.equal(upgradedDatabase.prepare(`
    SELECT COUNT(*) AS n FROM interview_session_consent
    WHERE session_id = ? AND consent_id = ?
  `).get(sessions[0].id, consent.id).n, 1,
  'the consent relation must survive the backed-up schema rebuild');
  const upgradedConsentUniqueIndexes = upgradedDatabase.prepare(
    "PRAGMA index_list('interview_session_consent')",
  ).all().filter((item) => Number(item.unique) === 1)
    .map((item) => upgradedDatabase.prepare(
      `PRAGMA index_info('${String(item.name).replaceAll("'", "''")}')`,
    ).all().map((column) => column.name));
  assert.equal(upgradedConsentUniqueIndexes.some((columns) => (
    columns.length === 1 && columns[0] === 'consent_id'
  )), false, 'post-backup migration must remove the legacy single-column consent uniqueness');
  upgradedDatabase.close();

  console.log('check-interview-recording-consent-withdrawal-001 ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
