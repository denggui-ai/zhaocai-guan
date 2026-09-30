'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') {
  console.log(JSON.stringify({
    ok: false,
    contract: 'MACOS-ASR-FAILURE-RECOVERY-001',
    status: 'NOT_APPLICABLE',
  }));
  process.exit(0);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-macos-asr-recovery-'));
const DB_PATH = path.join(ROOT, 'recruiting.db');
const DATA_ROOT = path.join(ROOT, 'data');
const INTERVIEW_ROOT = path.join(ROOT, 'interviews');
const SOURCE_PATH = path.join(ROOT, 'synthetic-candidate.aiff');
const PORT = 22000 + (process.pid % 1000);
const TOKEN = 'synthetic-local-api-token-asr-recovery';

process.env.BOSS_DB_PATH = DB_PATH;
process.env.BOSS_ACTION_PORT = String(PORT);
process.env.HRBOSS_DATA_DIR = DATA_ROOT;
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = INTERVIEW_ROOT;
process.env.HRBOSS_LOCAL_API_TOKEN = TOKEN;
process.env.HRBOSS_LOCAL_API_INSTANCE_ID = 'check-macos-asr-failure-recovery';
process.env.HRBOSS_INTERVIEW_WHISPER_CLI_PATH = '/usr/bin/false';

process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const db = require("../src/db");
const actionServer = require("../src/action-server");

function request(method, pathname, body = null) {
  const payload = body == null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method,
      headers: {
        'x-hrboss-token': TOKEN,
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        } : {}),
      },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        body: text ? JSON.parse(text) : null,
      }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await request('GET', '/api/health');
      if (response.status === 200 && response.body?.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('action server did not become ready');
}

async function waitForTerminalJob(expectedJobId = '', timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request('GET', '/api/local-interview/progress');
    assert.equal(response.status, 200);
    const job = response.body?.job;
    if ((!expectedJobId || job?.id === expectedJobId)
        && ['done', 'error', 'cancelled'].includes(job?.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('local interview task did not reach a terminal state');
}

function regularFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target);
      else if (entry.isFile()) files.push(target);
    }
  };
  visit(root);
  return files;
}

async function run() {
  const rendered = spawnSync('/usr/bin/say', [
    '-o',
    SOURCE_PATH,
    'Synthetic candidate says the local interview recovery test is complete and ready for human review.',
  ], {
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.equal(rendered.status, 0, rendered.stderr || 'synthetic speech rendering failed');
  assert.ok(fs.statSync(SOURCE_PATH).size > 0);

  db.openDb(DB_PATH);
  await actionServer.startHttpServer();
  await waitForHealth();

  let response = await request('POST', '/api/local-interview/from-file', {
    filePath: SOURCE_PATH,
    topic: 'synthetic-asr-failure',
    materialConsentConfirmed: true,
  });
  assert.ok([200, 202].includes(response.status), JSON.stringify(response.body));
  const failed = await waitForTerminalJob();
  assert.equal(failed.status, 'error');
  assert.equal(failed.cleanup_pending, false);
  assert.equal(failed.termination_unconfirmed, false);
  assert.equal(failed.out_dir, null);
  assert.equal(failed.result, null);
  assert.deepEqual(regularFiles(INTERVIEW_ROOT), [],
    'failed ASR processing must remove every owned temporary artifact');
  assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM interview_recording').get().n, 0);

  const job = db.upsertJob({
    encrypt_job_id: 'synthetic-formal-asr-recovery-job',
    numeric_job_id: '991000000000991',
    name: '合成正式录音恢复岗位',
    hr_owner: 'HR-SYNTHETIC',
  });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'synthetic-formal-asr-recovery-candidate',
    source: 'fixture',
    name: '合成候选人',
  });
  const consent = db.recordInterviewConsent({
    candidateId: candidate.internal_id,
    jobId: job.id,
    confirmed: true,
    recordedBy: 'HR-SYNTHETIC',
    source: 'fixture',
  });
  const formalJobId = `synthetic-formal-${process.pid}`;
  const ownerToken = 'a'.repeat(64);
  const formalDir = actionServer.localInterviewOutDir('synthetic-formal', {
    jobId: formalJobId,
    ownerToken,
    root: INTERVIEW_ROOT,
  });
  const recordingPath = path.join(formalDir, 'recording.wav');
  const converted = spawnSync('/usr/bin/afconvert', [
    '-f',
    'WAVE',
    '-d',
    'LEI16@16000',
    SOURCE_PATH,
    recordingPath,
  ], { encoding: 'utf8', timeout: 30000 });
  assert.equal(converted.status, 0, converted.stderr || 'synthetic formal WAV conversion failed');
  fs.chmodSync(recordingPath, 0o600);
  const formalJob = {
    id: formalJobId,
    ownerToken,
    outDir: formalDir,
    mode: 'record',
    topic: 'synthetic-formal-asr-recovery',
    bindCandidateId: candidate.internal_id,
    bindJobId: job.id,
    bindRound: 1,
    bindConsentId: consent.id,
    cleanupPending: false,
    bindingPending: false,
    terminationUnconfirmed: false,
  };
  actionServer.writeLocalInterviewPersistentState(formalJob, 'transcription_in_progress', {
    root: INTERVIEW_ROOT,
  });
  const failedFormalWorker = spawnSync(process.execPath, [
    path.join(PROJECT_ROOT, "src/local-interview-p0.js"),
    '--retry-recording',
    recordingPath,
    '--topic',
    formalJob.topic,
    '--out-dir',
    formalDir,
  ], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.notEqual(failedFormalWorker.status, 0,
    'the synthetic formal recording must hit the forced local ASR failure');
  const preserved = actionServer.preserveFailedLocalInterviewTranscription(
    formalJob,
    'synthetic forced ASR failure',
    { root: INTERVIEW_ROOT },
  );
  assert.ok(preserved?.persisted, 'formal ASR failure must durably enter a retryable state');
  assert.equal(fs.existsSync(recordingPath), true);
  assert.ok(fs.statSync(recordingPath).size > 0);
  // This action-server process still owns the terminal from-file job above.
  // Refresh explicitly so the persisted formal blocker becomes the HTTP route's live job.
  const restarted = actionServer.refreshPersistedLocalInterviewBlocker({ root: INTERVIEW_ROOT });
  assert.equal(restarted.recoveredState, 'transcription_failed');
  assert.equal(restarted.transcriptionRetryable, true);
  assert.equal(restarted.bindCandidateId, candidate.internal_id);
  assert.equal(restarted.bindJobId, job.id);
  assert.equal(restarted.bindRound, 1);
  assert.equal(restarted.bindConsentId, consent.id);

  process.env.HRBOSS_INTERVIEW_WHISPER_CLI_PATH = '/opt/homebrew/bin/whisper-cli';
  const retryScope = {
    taskId: formalJobId,
    candidateId: candidate.internal_id,
    jobId: job.id,
    round: 1,
  };
  response = await request('POST', '/api/local-interview/transcription/retry', retryScope);
  assert.ok([200, 202].includes(response.status), JSON.stringify(response.body));
  assert.notEqual(response.body?.code, 'NOT_FOUND', 'retry must reach the business handler through real action HTTP');
  assert.equal(response.body?.job?.id, formalJobId);
  assert.equal(response.body?.job?.mode, 'retry-transcription');
  const retried = await waitForTerminalJob(formalJobId);
  assert.equal(retried.status, 'done', retried.error || retried.message);
  assert.equal(retried.mode, 'retry-transcription');
  assert.equal(retried.transcription_retryable, false);
  assert.equal(retried.bind_candidate_id, candidate.internal_id);
  assert.equal(retried.bind_job_id, job.id);
  assert.equal(retried.bind_round, 1);
  assert.equal(retried.bind_consent_id, consent.id);
  const summaryPath = retried.result?.summaryPath;
  assert.ok(summaryPath, 'HTTP retry completion must expose the persisted summary');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const timestampedTranscript = JSON.parse(fs.readFileSync(summary.transcriptJson, 'utf8'));
  assert.equal(timestampedTranscript.schema_version, 'hrboss_asr_transcript_v1');
  assert.equal(timestampedTranscript.review_status, 'unreviewed');
  assert.match(timestampedTranscript.accuracy_label, /ASR 转写草稿/);
  assert.ok(timestampedTranscript.cues.length > 0, 'successful retry must produce timestamped cues');
  assert.ok(timestampedTranscript.cues.every((cue) => (
    /^cue-\d{6}$/.test(cue.cue_id)
    && Number.isInteger(cue.start_ms)
    && Number.isInteger(cue.end_ms)
    && cue.end_ms > cue.start_ms
    && typeof cue.text === 'string'
    && cue.text.trim()
  )));
  assert.equal(summary.cueCount, timestampedTranscript.cue_count);
  assert.equal(summary.lowConfidenceCueCount, timestampedTranscript.low_confidence_cue_count);
  assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM interview_recording').get().n, 1);
  const boundSessions = db.listInterviewSessions({
    candidateId: candidate.internal_id,
    jobId: job.id,
    round: 1,
  });
  assert.equal(boundSessions.length, 1, 'same-recording retry must not create a duplicate Session');
  const boundSession = db.getInterviewSession(boundSessions[0].id);
  assert.equal(boundSession.materials.length, 1, 'real HTTP retry must bind exactly one Session material');
  assert.equal(boundSession.materials[0].material_kind, 'offline_recording');
  assert.equal(
    boundSession.materials[0].interview_recording_id,
    retried.result?.autoBoundRecording?.id,
    'the Session material must reference the recording created by the HTTP retry',
  );
  assert.equal(boundSession.consents.length, 1, 'real HTTP retry must retain exactly one consent link');
  assert.equal(boundSession.consents[0].consent_id, consent.id);
  const duplicateRetry = await request('POST', '/api/local-interview/transcription/retry', retryScope);
  assert.equal(duplicateRetry.status, 409, JSON.stringify(duplicateRetry.body));
  assert.equal(duplicateRetry.body?.code, 'LOCAL_INTERVIEW_TRANSCRIPTION_NOT_RETRYABLE');
  assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM interview_recording').get().n, 1);
  const sessionAfterReplay = db.getInterviewSession(boundSession.id);
  assert.deepEqual(
    sessionAfterReplay.materials.map((material) => material.id),
    boundSession.materials.map((material) => material.id),
    'stale retry replay must not duplicate or replace the Session material link',
  );
  assert.deepEqual(
    sessionAfterReplay.consents.map((item) => item.id),
    boundSession.consents.map((item) => item.id),
    'stale retry replay must not duplicate or replace the consent link',
  );
  assert.equal(db.conn().prepare(`
    SELECT COUNT(*) AS n FROM audit_log
    WHERE action = '本地面试转写人工重试' AND target = ?
  `).get(candidate.internal_id).n, 1, 'only the accepted HTTP retry may write a retry audit event');

  const evidence = {
    ok: true,
    contract: 'MACOS-ASR-FAILURE-RECOVERY-001',
    source: 'local_synthetic_speech_file',
    real_microphone_used: false,
    external_network_used: false,
    first_attempt: {
      status: failed.status,
      cleanup_pending: failed.cleanup_pending,
      imported_temporary_file_count: 0,
    },
    retry: {
      status: retried.status,
      route: '/api/local-interview/transcription/retry',
      restarted_state: restarted.recoveredState,
      preserved_recording: fs.existsSync(recordingPath),
      transcript_nonempty: true,
      timestamped_cue_count: timestampedTranscript.cue_count,
      low_confidence_cue_count: timestampedTranscript.low_confidence_cue_count,
      recording_count: 1,
      session_material_count: sessionAfterReplay.materials.length,
      session_consent_count: sessionAfterReplay.consents.length,
      stale_replay_status: duplicateRetry.status,
    },
    cleanup: 'temporary root removed on process exit',
  };
  const shutdownResult = await actionServer.shutdown();
  assert.equal(shutdownResult.ok, true, 'terminal retry must allow a clean action-server shutdown');
  console.log(JSON.stringify(evidence, null, 2));
}

run().catch(async (error) => {
  try { await actionServer.shutdown(); } catch {}
  console.error(error);
  process.exitCode = 1;
});
