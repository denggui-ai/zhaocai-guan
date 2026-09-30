'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'darwin') {
  process.stdout.write(`${JSON.stringify({ ok: false, status: 'NOT_APPLICABLE' })}\n`);
  process.exit(0);
}

const syntheticRoot = fs.realpathSync(path.resolve(process.argv[2] || ''));
const mode = process.argv[3] || 'seed';
const dataRoot = path.join(syntheticRoot, 'data');
const interviewRoot = path.join(syntheticRoot, 'interviews');
const sourcePath = path.join(syntheticRoot, 'b6-synthetic-candidate.aiff');
process.env.BOSS_DB_PATH = path.join(dataRoot, 'recruiting.db');
process.env.HRBOSS_DATA_DIR = dataRoot;
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = interviewRoot;
process.env.HRBOSS_INTERVIEW_WHISPER_CLI_PATH = '/usr/bin/false';
process.env.HRBOSS_LOCAL_API_TOKEN = 'b6-synthetic-local-api-token-20260729';
process.env.HRBOSS_LOCAL_API_INSTANCE_ID = 'b6-synthetic-asr-runtime-db';
process.env.HRBOSS_EXTERNAL_AI_ENABLED = '0';
process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED = '0';
process.env.HRBOSS_F018_ENABLED = '0';

const db = require('../../db');
const actionServer = require('../../action-server');

fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(interviewRoot, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') {
  fs.chmodSync(dataRoot, 0o700);
  fs.chmodSync(interviewRoot, 0o700);
}
db.openDb(process.env.BOSS_DB_PATH);

const EXPECTED = Object.freeze({
  job_name: 'B-6 合成录音转写岗位',
  candidate_name: 'B-6 合成候选人',
  topic: 'B-6 synthetic local ASR failure recovery',
});

function seedFailureState() {
  const rendered = spawnSync('/usr/bin/say', [
    '-o',
    sourcePath,
    'Synthetic candidate confirms the interview recording recovery journey is ready for careful human review.',
  ], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(rendered.status, 0, rendered.stderr || 'synthetic speech rendering failed');
  assert.ok(fs.statSync(sourcePath).size > 0);

  const job = db.upsertJob({
    encrypt_job_id: 'b6-synthetic-asr-recovery-job',
    numeric_job_id: '960260729001',
    name: EXPECTED.job_name,
    hr_owner: 'B-6 合成 HR',
    department: 'B-6 合成研发部',
    location: 'B-6 合成上海',
    source_type: 'local_manual',
    created_at: '2026-07-29T10:00:00.000Z',
  });
  db.conn().prepare("UPDATE job SET status = 'open', updated_at = ? WHERE id = ?")
    .run('2026-07-29T10:00:00.000Z', job.id);
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'b6-synthetic-asr-recovery-candidate',
    source: 'synthetic_b6',
    name: EXPECTED.candidate_name,
    degree: '本科',
    school: 'B-6 合成大学',
    work_years: '5',
    geek_desc: '纯合成候选人，仅用于本地录音转写失败恢复与低置信提示旅程。',
    sabc: 'B',
    sabc_source: 'manual_fixture',
  }, '2026-07-29T10:01:00.000Z');
  const consent = db.recordInterviewConsent({
    candidateId: candidate.internal_id,
    jobId: job.id,
    confirmed: true,
    recordedBy: 'local-primary-operator',
    source: 'candidate_interview_ui',
  });

  const formalJobId = `b6-synthetic-formal-${process.pid}`;
  const ownerToken = 'b'.repeat(64);
  const formalDir = actionServer.localInterviewOutDir(EXPECTED.topic, {
    jobId: formalJobId,
    ownerToken,
    root: interviewRoot,
  });
  const recordingPath = path.join(formalDir, 'recording.wav');
  const converted = spawnSync('/usr/bin/afconvert', [
    '-f',
    'WAVE',
    '-d',
    'LEI16@16000',
    sourcePath,
    recordingPath,
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(converted.status, 0, converted.stderr || 'synthetic formal WAV conversion failed');
  fs.chmodSync(recordingPath, 0o600);
  assert.ok(fs.statSync(recordingPath).size > 0);

  const formalJob = {
    id: formalJobId,
    ownerToken,
    outDir: formalDir,
    mode: 'record',
    topic: EXPECTED.topic,
    bindCandidateId: candidate.internal_id,
    bindJobId: job.id,
    bindRound: 1,
    bindConsentId: consent.id,
    cleanupPending: false,
    bindingPending: false,
    terminationUnconfirmed: false,
  };
  actionServer.writeLocalInterviewPersistentState(formalJob, 'transcription_in_progress', {
    root: interviewRoot,
  });
  const failedWorker = spawnSync(process.execPath, [
    path.join(__dirname, '..', '..', 'local-interview-p0.js'),
    '--retry-recording',
    recordingPath,
    '--topic',
    formalJob.topic,
    '--out-dir',
    formalDir,
  ], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  assert.notEqual(failedWorker.status, 0, 'synthetic formal recording must hit forced local ASR failure');
  const preserved = actionServer.preserveFailedLocalInterviewTranscription(
    formalJob,
    'B-6 synthetic forced ASR failure',
    { root: interviewRoot },
  );
  assert.ok(preserved?.persisted, 'formal ASR failure must durably enter retryable state');
  assert.equal(fs.existsSync(recordingPath), true);
  assert.ok(fs.statSync(recordingPath).size > 0);

  const seed = {
    job_id: job.id,
    candidate_id: candidate.internal_id,
    job_name: EXPECTED.job_name,
    candidate_name: EXPECTED.candidate_name,
    topic: EXPECTED.topic,
    formal_job_id: formalJobId,
    consent_id: consent.id,
    preparation: {
      synthetic_audio: true,
      real_microphone_used: false,
      external_network_used: false,
      forced_whisper_path: '/usr/bin/false',
      failed_worker_exit_nonzero: failedWorker.status !== 0,
      retryable_state_persisted: preserved.persisted === true,
      recording_preserved: fs.existsSync(recordingPath) && fs.statSync(recordingPath).size > 0,
    },
  };
  const target = path.join(syntheticRoot, 'seed.json');
  fs.writeFileSync(target, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  return { ok: true, ...seed };
}

function verifyDatabase() {
  const seed = JSON.parse(fs.readFileSync(path.join(syntheticRoot, 'seed.json'), 'utf8'));
  const recordings = db.listInterviewRecordings({
    candidateId: seed.candidate_id,
    jobId: seed.job_id,
  });
  assert.equal(recordings.length, 1, 'retry recovery must create exactly one bound recording');
  const recording = recordings[0];
  assert.equal(recording.candidate_id, seed.candidate_id);
  assert.equal(recording.job_id, seed.job_id);
  assert.equal(recording.status, 'matched');
  assert.ok(recording.transcript_json_path);
  assert.equal(fs.existsSync(recording.transcript_json_path), true);
  const transcript = JSON.parse(fs.readFileSync(recording.transcript_json_path, 'utf8'));
  assert.equal(transcript.schema_version, 'hrboss_asr_transcript_v1');
  assert.equal(transcript.review_status, 'unreviewed');
  assert.match(transcript.accuracy_label, /ASR 转写草稿/);
  assert.ok(Array.isArray(transcript.cues) && transcript.cues.length > 0);
  assert.ok(transcript.cues.every((cue) => (
    /^cue-\d{6}$/.test(cue.cue_id)
    && Number.isInteger(cue.start_ms)
    && Number.isInteger(cue.end_ms)
    && cue.end_ms > cue.start_ms
    && typeof cue.text === 'string'
    && cue.text.trim()
  )));
  assert.ok(transcript.low_confidence_cue_count > 0);
  assert.equal(
    transcript.cues.filter((cue) => cue.low_confidence === true).length,
    transcript.low_confidence_cue_count,
  );

  const sessions = db.listInterviewSessions({
    candidateId: seed.candidate_id,
    jobId: seed.job_id,
    round: 1,
  });
  assert.equal(sessions.length, 1, 'same-recording retry must bind exactly one interview session');
  const session = db.getInterviewSession(sessions[0].id);
  assert.equal(session.round, 1);
  assert.equal(session.interview_format, 'offline');
  assert.equal(session.materials.length, 1);
  assert.equal(session.materials[0].material_kind, 'offline_recording');
  assert.equal(session.materials[0].interview_recording_id, recording.id);
  assert.equal(session.consents.length, 1);
  assert.equal(session.consents[0].consent_id, seed.consent_id);

  const audit = db.conn().prepare(`
    SELECT action, target, who, result, detail_json
    FROM audit_log
    WHERE action = '本地面试转写人工重试' AND target = ?
    ORDER BY id
  `).all(seed.candidate_id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].target, seed.candidate_id);
  assert.equal(audit[0].who, 'local-primary-operator');
  assert.equal(audit[0].result, '成功');
  const detail = JSON.parse(audit[0].detail_json);
  assert.equal(detail.local_job_id, seed.formal_job_id);
  assert.equal(detail.job_id, seed.job_id);
  assert.equal(detail.round, 1);
  assert.equal(detail.consent_id, seed.consent_id);

  return {
    ok: true,
    synthetic_data_only: true,
    recording: {
      count: recordings.length,
      id: recording.id,
      status: recording.status,
      candidate_bound: recording.candidate_id === seed.candidate_id,
      job_bound: recording.job_id === seed.job_id,
    },
    transcript: {
      schema_version: transcript.schema_version,
      review_status: transcript.review_status,
      cue_count: transcript.cue_count,
      low_confidence_cue_count: transcript.low_confidence_cue_count,
      all_cues_timestamped: transcript.cues.every((cue) => (
        Number.isInteger(cue.start_ms) && Number.isInteger(cue.end_ms) && cue.end_ms > cue.start_ms
      )),
    },
    session: {
      count: sessions.length,
      id: session.id,
      round: session.round,
      format: session.interview_format,
      material_count: session.materials.length,
      consent_link_count: session.consents.length,
    },
    audit: {
      retry_count: audit.length,
      actor: audit[0].who,
      result: audit[0].result,
    },
  };
}

try {
  const result = mode === 'verify' ? verifyDatabase() : seedFailureState();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  db.conn().close();
}
