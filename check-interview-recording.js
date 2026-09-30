const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { WINDOWS_LOCAL_ASR_REASON } = require('./local-interview-p0');

const ROOT = __dirname;
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'interview-recording-'));
const METHOD_DB = path.join(TEST_ROOT, 'methods', 'recruiting.db');
const ACTION_DB = path.join(TEST_ROOT, 'action', 'recruiting.db');
const SUMMARY_DIR = path.join(TEST_ROOT, 'summaries');
const PROFILE_DATA_DIR = path.join(TEST_ROOT, 'profile');
const RECOMMEND_PROGRESS_FILE = path.join(TEST_ROOT, 'recommend-progress.json');
const JOB_SYNC_PROGRESS_FILE = path.join(TEST_ROOT, 'job-sync-progress.json');
const RESUME_PROGRESS_FILE = path.join(TEST_ROOT, 'resume-progress.json');
const SCREENSHOT_PROGRESS_FILE = path.join(TEST_ROOT, 'screenshot-progress.json');
const PORT = 18033 + (process.pid % 1000);
const LOCAL_API_TOKEN = 'test-local-api-token-interview-recording-0001';

process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = SUMMARY_DIR;

process.on('exit', () => {
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

function writeSummary(name, overrides = {}) {
  const dir = path.join(SUMMARY_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const summaryPath = path.join(dir, 'summary.json');
  const summary = {
    createdAt: '2026-07-09T12:00:00.000Z',
    topic: name,
    sourcePath: path.join(dir, 'source.mp4'),
    wavPath: path.join(dir, 'audio.wav'),
    transcriptTxt: path.join(dir, 'transcript.txt'),
    transcriptSrt: path.join(dir, 'transcript.srt'),
    transcriptJson: path.join(dir, 'transcript.json'),
    codexInput: path.join(dir, 'codex-input.md'),
    ...overrides,
  };
  fs.writeFileSync(summary.sourcePath, 'synthetic video fixture\n');
  fs.writeFileSync(summary.wavPath, 'RIFF synthetic audio fixture\n');
  fs.writeFileSync(summary.transcriptTxt, `候选人林晨，当前薪资二十二K，期望薪资二十五K，两周到岗。\n${name}\n`);
  fs.writeFileSync(summary.transcriptSrt, '1\n00:00:00,000 --> 00:00:05,000\n候选人林晨，两周到岗。\n');
  fs.writeFileSync(summary.transcriptJson, `${JSON.stringify({ text: '候选人林晨，两周到岗。' }, null, 2)}\n`);
  fs.writeFileSync(summary.codexInput, '# codex input\n');
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { summaryPath, summary };
}

function seedJobAndCandidate(db, suffix) {
  const job = db.upsertJob({
    encrypt_job_id: `interview-recording-job-${suffix}`,
    numeric_job_id: `90000000000000${suffix}`,
    name: `面试录音岗位 ${suffix}`,
    hr_owner: 'HR',
  });
  const jd = db.createJobJdVersion({
    jobId: job.id,
    jdText: `面试录音岗位 ${suffix} 纯合成 JD`,
    actor: 'HR-SYNTHETIC',
  });
  db.activateJobJdVersion({ jdVersionId: jd.id, expectedVersion: jd.version, actor: 'HR-SYNTHETIC' });
  const profile = db.createJobProfileVersion({
    jobId: job.id,
    jdVersionId: jd.id,
    config: { rubric: `面试录音岗位 ${suffix} 纯合成画像` },
    actor: 'HR-SYNTHETIC',
  });
  db.confirmJobProfileVersion({ profileVersionId: profile.id, expectedVersion: profile.version, actor: 'HR-SYNTHETIC' });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: `interview-recording-geek-${suffix}`,
    source: 'fixture',
    name: `候选人 ${suffix}`,
  });
  return { job, candidate };
}

function strictInterviewReport(materialId) {
  const ref = [{ material_id: materialId, span: { type: 'text_span', start: 0, end: 12 } }];
  return {
    schema_version: 'interview_report_v1',
    summary: { id: 'summary.main', status: 'supported', text: '候选人说明了到岗周期。', evidence_refs: ref },
    match_points: [],
    risks: [],
    unknowns: [{ id: 'unknown.other', status: 'unknown', text: '其余信息未提及。', reason_code: 'not_mentioned', evidence_refs: [] }],
    followup_questions: [],
    key_facts: [],
    human_confirm_required: true,
    disclaimer: '本报告仅基于已关联面试材料生成，须经 HR 人工确认，不代表自动录用、淘汰、排序或处置。',
  };
}

function post(pathname, body) {
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: 'POST',
      headers: {
        'x-hrboss-token': LOCAL_API_TOKEN,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      timeout: 3000,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end(payload);
  });
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: 'GET',
      headers: { 'x-hrboss-token': LOCAL_API_TOKEN },
      timeout: 3000,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

async function waitForServer(child) {
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk.toString(); });
  child.stderr.on('data', (chunk) => { log += chunk.toString(); });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (log.includes(`http://127.0.0.1:${PORT}`)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`action-server did not start: ${log}`);
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopChild(child, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, timeoutMs)) return;
  child.kill('SIGKILL');
  if (!(await waitForChildExit(child, 5_000))) throw new Error('action-server exit timed out after SIGKILL');
  throw new Error('action-server ignored SIGTERM and required SIGKILL');
}

function checkDbMethods() {
  const db = require('./db');
  const database = db.openDb(METHOD_DB);
  const { job, candidate } = seedJobAndCandidate(db, '101');
  assert.equal(db.getInterviewConsent({ candidateId: candidate.internal_id, jobId: job.id }), null);
  assert.throws(
    () => db.requireActiveInterviewConsent({ candidateId: candidate.internal_id, jobId: job.id }),
    /知情同意/,
  );
  let consent = db.recordInterviewConsent({ candidateId: candidate.internal_id, jobId: job.id, confirmed: true });
  assert.equal(consent.valid, true, 'confirmed interview consent should be persisted and active');
  assert.ok(consent.consent_text_version, 'consent must record the server-owned text version');
  assert.match(consent.consent_text_sha256, /^[a-f0-9]{64}$/, 'consent must record the displayed text hash');
  const consentPolicy = db.getInterviewConsentPolicy();
  assert.equal(consent.consent_text_version, consentPolicy.text_version);
  assert.equal(consent.consent_text_sha256, consentPolicy.text_sha256);
  assert.equal(db.requireActiveInterviewConsent({ candidateId: candidate.internal_id, jobId: job.id }).id, consent.id);
  database.prepare('UPDATE interview_recording_consent SET consented_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', consent.id);
  assert.equal(db.getInterviewConsent({ candidateId: candidate.internal_id, jobId: job.id }).valid, false, 'consent older than 24 hours must expire');
  consent = db.recordInterviewConsent({ candidateId: candidate.internal_id, jobId: job.id, confirmed: true });
  assert.equal(consent.valid, true, 'a fresh explicit consent should replace an expired record');
  db.recordInterviewConsent({
    candidateId: candidate.internal_id,
    jobId: job.id,
    confirmed: false,
    requestId: 'check-interview-recording-revoke',
  });
  consent = db.getInterviewConsent({ candidateId: candidate.internal_id, jobId: job.id });
  assert.equal(consent.valid, false, 'revoked interview consent must not authorize recording');
  const { summaryPath, summary } = writeSummary('method-case', {
    transcript: 'unknown transcript must not persist',
    report: 'unknown report must not persist',
    contact: 'unknown contact must not persist',
  });

  let recording = db.createInterviewRecording({
    summary_path: summaryPath,
    ...summary,
    raw_summary_json: summary,
  });
  assert.equal(recording.status, 'pending_match');
  assert.equal(recording.wav_path, fs.realpathSync(summary.wavPath));
  assert.equal(recording.raw_summary_json.includes('must not persist'), false, 'raw summary must persist only fixed non-sensitive metadata');

  recording = db.createInterviewRecording({
    summary_path: summaryPath,
    ...summary,
    topic: 'method-case-updated',
    raw_summary_json: summary,
  });
  assert.equal(db.listInterviewRecordings({ unmatched: true }).length, 1, 'summary import must be idempotent');
  assert.equal(recording.topic, 'method-case-updated');

  const globalUnmatched = db.createInterviewRecording({
    summary_path: writeSummary('method-global-unmatched').summaryPath,
    topic: 'method-global-unmatched',
  });
  const jobUnmatched = db.createInterviewRecording({
    summary_path: writeSummary('method-job-unmatched').summaryPath,
    topic: 'method-job-unmatched',
  });
  db.bindInterviewRecording({ id: jobUnmatched.id, jobId: job.id });
  const currentJobUnmatchedIds = db.listInterviewRecordings({ unmatched: true, jobId: job.id }).map((row) => row.id);
  assert.ok(currentJobUnmatchedIds.includes(globalUnmatched.id), 'job-scoped unmatched query should include recordings with no job_id');
  assert.ok(currentJobUnmatchedIds.includes(jobUnmatched.id), 'job-scoped unmatched query should include recordings bound to the current job but no candidate');

  recording = db.bindInterviewRecording({ id: recording.id, candidateId: candidate.internal_id, jobId: job.id });
  assert.equal(recording.candidate_id, candidate.internal_id);
  assert.equal(recording.job_id, job.id);
  assert.equal(recording.status, 'matched');

  const session = db.createInterviewSession({
    candidateId: candidate.internal_id,
    jobId: job.id,
    round: 1,
    mode: 'offline',
    status: 'pending_review',
  });
  const material = db.linkInterviewSessionRecording({ sessionId: session.id, recordingId: recording.id, linkedBy: 'HR-SYNTHETIC' });
  const reportPayload = strictInterviewReport(material.id);
  let report = db.saveInterviewAiReport({
    recordingId: recording.id,
    report: reportPayload,
    actor: 'HR-SYNTHETIC',
    expectedVersion: 0,
    requestId: 'interview-recording-method-save-1',
  });
  assert.equal(report.report.summary.text, '候选人说明了到岗周期。');
  assert.equal(report.status, 'draft');

  let confirmations = db.saveInterviewRecordingConfirmations({
    recordingId: recording.id,
    items: [
      {
        field_key: 'salary_expectation',
        field_label: '期望薪资',
        extracted_value: '30k',
        status: 'pending',
        evidence: '候选人说期望 30k',
      },
      {
        field_key: 'notice_period',
        field_label: '到岗周期',
        extracted_value: '两周',
        status: 'confirmed',
        evidence: '候选人确认两周可到岗',
      },
    ],
  });
  assert.equal(confirmations.length, 2);
  assert.equal(confirmations[0].status, 'pending');
  assert.equal(confirmations[0].confirmed_at, null);
  assert.equal(confirmations[1].status, 'confirmed');
  assert.ok(confirmations[1].confirmed_at, 'confirmed status should set confirmed_at');
  const salaryConfirmationId = confirmations[0].id;

  confirmations = db.saveInterviewRecordingConfirmations({
    recordingId: recording.id,
    item: {
      fieldKey: 'salary_expectation',
      fieldLabel: '期望薪资',
      extractedValue: '30k',
      correctedValue: '32k',
      status: 'corrected',
      note: '人工核对后修正',
    },
  });
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].id, salaryConfirmationId, 'same field_key should upsert the existing confirmation');
  assert.equal(confirmations[0].corrected_value, '32k');
  assert.equal(confirmations[0].status, 'corrected');
  assert.ok(confirmations[0].confirmed_at, 'corrected status should set confirmed_at');

  confirmations = db.listInterviewRecordingConfirmations(recording.id);
  assert.equal(confirmations.length, 2, 'duplicate field_key should not create extra rows');
  assert.deepEqual(confirmations.map((item) => item.field_key), ['salary_expectation', 'notice_period']);

  report = db.confirmInterviewReportForRecording({
    id: recording.id,
    confirmed: true,
    actor: 'HR-SYNTHETIC',
    expectedVersion: 1,
    requestId: 'interview-recording-method-confirm-1',
  });
  recording = db.getInterviewRecording(recording.id);
  assert.equal(recording.status, 'confirmed');
  assert.ok(recording.confirmed_at);
  report = db.getLatestInterviewAiReport(recording.id);
  assert.equal(report.status, 'confirmed');
  assert.ok(report.confirmed_at);

  const columns = database.prepare("SELECT name FROM pragma_table_info('interview_recording')").all().map((row) => row.name);
  for (const name of ['summary_path', 'wav_path', 'candidate_id', 'job_id', 'status', 'confirmed_at']) {
    assert.ok(columns.includes(name), `interview_recording.${name} should exist`);
  }
  const confirmationColumns = database.prepare("SELECT name FROM pragma_table_info('interview_recording_confirmation')").all().map((row) => row.name);
  for (const name of ['recording_id', 'field_key', 'field_label', 'extracted_value', 'corrected_value', 'status', 'evidence', 'note', 'confirmed_at', 'created_at', 'updated_at']) {
    assert.ok(confirmationColumns.includes(name), `interview_recording_confirmation.${name} should exist`);
  }
  database.close();
}

async function checkActionEndpoints() {
  const db = require('./db');
  const database = db.openDb(ACTION_DB);
  const { job, candidate } = seedJobAndCandidate(db, '202');
  const { job: otherJob } = seedJobAndCandidate(db, '203');
  database.close();
  const { summaryPath } = writeSummary('endpoint-case');
  const currentJobUnmatchedSummary = writeSummary('endpoint-current-job-unmatched');
  const otherJobUnmatchedSummary = writeSummary('endpoint-other-job-unmatched');
  const micCheck = writeSummary('mic-check-case', {
    mode: 'mic-check',
    micCheck: { level: 'pass', passed: true },
  });

  const child = spawn(process.execPath, [path.join(ROOT, 'action-server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      BOSS_ACTION_PORT: String(PORT),
      BOSS_DB_PATH: ACTION_DB,
      BOSS_PROFILE_DATA_DIR: PROFILE_DATA_DIR,
      BOSS_RECOMMEND_PROGRESS_FILE: RECOMMEND_PROGRESS_FILE,
      BOSS_JOB_SYNC_PROGRESS_FILE: JOB_SYNC_PROGRESS_FILE,
      BOSS_RESUME_PROGRESS_FILE: RESUME_PROGRESS_FILE,
      BOSS_SCREENSHOT_IMPORT_PROGRESS_FILE: SCREENSHOT_PROGRESS_FILE,
      HRBOSS_LOCAL_API_TOKEN: LOCAL_API_TOKEN,
      HRBOSS_LOCAL_API_INSTANCE_ID: 'check-interview-recording',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let primaryError = null;
  try {
    await waitForServer(child);

    let res = await get('/api/interview-recording');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.deepEqual(res.body.recordings, []);

    res = await post('/api/local-interview/record/start', {
      candidateId: candidate.internal_id,
      jobId: job.id,
      round: 1,
      duration: 5,
    });
    if (process.platform === 'win32') {
      assert.equal(res.status, 501, 'Windows recording capability gate must run before consent validation');
      assert.equal(res.body.code, WINDOWS_LOCAL_ASR_REASON);
    } else {
      assert.equal(res.status, 403, 'record start must be rejected without persisted consent');
      assert.equal(res.body.code, 'interview_consent_required');
    }

    res = await post('/api/interview-consent', {
      candidateId: candidate.internal_id,
      jobId: job.id,
      confirmed: false,
    });
    assert.equal(res.status, 400, 'consent revocation must require an idempotency requestId');
    assert.equal(res.body.code, 'INTERVIEW_CONSENT_REQUEST_ID_REQUIRED');

    res = await post('/api/interview-consent', {
      candidateId: candidate.internal_id,
      jobId: job.id,
      confirmed: true,
    });
    assert.equal(res.status, 200, 'explicit consent endpoint should persist HR attestation');
    assert.equal(res.body.consent.valid, true);
    assert.equal(res.body.consent.consent_text_sha256, res.body.policy.text_sha256);
    assert.match(res.body.policy.display_text, /撤回同意后.*立即中止/);
    res = await get(`/api/interview-consent?candidateId=${encodeURIComponent(candidate.internal_id)}&jobId=${job.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.consent.valid, true);

    res = await post('/api/local-interview/from-file', { filePath: '/tmp/not-used-without-consent.wav' });
    if (process.platform === 'win32') {
      assert.equal(res.status, 501, 'Windows import capability gate must run before material consent validation');
      assert.equal(res.body.code, WINDOWS_LOCAL_ASR_REASON);
    } else {
      assert.equal(res.status, 403, 'media import must require explicit material consent before checking the path');
      assert.equal(res.body.code, 'material_consent_required');
    }

    res = await post('/api/interview-recording/import-summary', { summaryPath });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    let recording = res.body.recording;
    const pendingAssignment = res.body.assignment;
    assert.equal(recording.status, 'pending_match');
    assert.equal(pendingAssignment.status, 'pending_classification');

    res = await get(`/api/interview-recording/transcript?recordingId=${recording.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.transcript.text, /林晨/);

    res = await post('/api/interview-recording/import-summary', { summaryPath: micCheck.summaryPath });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /麦克风预检/);

    res = await post('/api/interview-recording/import-summary', { summaryPath: currentJobUnmatchedSummary.summaryPath });
    assert.equal(res.status, 200);
    const currentJobUnmatched = res.body.recording;
    res = await post('/api/interview-recording/bind', { id: currentJobUnmatched.id, jobId: job.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.recording.job_id, job.id);
    assert.equal(res.body.recording.candidate_id, null);

    res = await post('/api/interview-recording/import-summary', { summaryPath: otherJobUnmatchedSummary.summaryPath });
    assert.equal(res.status, 200);
    const otherJobUnmatched = res.body.recording;
    res = await post('/api/interview-recording/bind', { id: otherJobUnmatched.id, jobId: otherJob.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.recording.job_id, otherJob.id);
    assert.equal(res.body.recording.candidate_id, null);

    res = await get('/api/interview-recording?unmatched=1');
    assert.equal(res.status, 200);
    assert.equal(res.body.recordings.length, 3);

    res = await get(`/api/interview-recording?unmatched=1&jobId=${job.id}`);
    assert.equal(res.status, 200);
    const scopedUnmatchedIds = res.body.recordings.map((item) => item.id);
    assert.ok(scopedUnmatchedIds.includes(recording.id), 'job-scoped unmatched endpoint should include recordings with no job_id');
    assert.ok(scopedUnmatchedIds.includes(currentJobUnmatched.id), 'job-scoped unmatched endpoint should include current job unmatched recordings');
    assert.ok(!scopedUnmatchedIds.includes(otherJobUnmatched.id), 'job-scoped unmatched endpoint should exclude other job unmatched recordings');

    res = await post('/api/interview-recording/bind', { id: recording.id, candidateId: candidate.internal_id, jobId: job.id });
    assert.equal(res.status, 200);
    recording = res.body.recording;
    assert.equal(recording.candidate_id, candidate.internal_id);
    assert.equal(recording.job_id, job.id);

    res = await post('/api/interview-assignment/classify', {
      pendingAssignmentId: pendingAssignment.id,
      purpose: 'candidate_interview',
      actor: 'HR-SYNTHETIC',
      expectedVersion: pendingAssignment.version,
      reason: 'manual_candidate_classification',
      requestId: 'interview-recording-endpoint-classify-1',
    });
    assert.equal(res.status, 200);
    const classifiedAssignment = res.body.assignment;
    res = await post('/api/interview-assignment/assign', {
      pendingAssignmentId: classifiedAssignment.id,
      candidateId: candidate.internal_id,
      jobId: job.id,
      round: 1,
      actor: 'HR-SYNTHETIC',
      expectedVersion: classifiedAssignment.version,
      reason: 'manual_assignment',
      requestId: 'interview-recording-endpoint-assign-1',
    });
    assert.equal(res.status, 200);
    const assignedSession = res.body.session;
    const reportDb = new Database(ACTION_DB, { readonly: true });
    const reportMaterial = reportDb.prepare(`
      SELECT id FROM interview_session_material
      WHERE session_id = ? AND interview_recording_id = ?
    `).get(assignedSession.id, recording.id);
    reportDb.close();
    assert.ok(reportMaterial, 'explicit assignment must create the report evidence link');

    res = await post('/api/interview-recording/report', {
      recordingId: recording.id,
      report: strictInterviewReport(reportMaterial.id),
      actor: 'HR-SYNTHETIC',
      expectedVersion: 0,
      requestId: 'interview-recording-endpoint-report-1',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.report.report.summary.text, '候选人说明了到岗周期。');

    res = await get(`/api/interview-recording/report?recordingId=${recording.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.report.session_id, assignedSession.id);
    assert.equal(res.body.report.schema_version, 'interview_report_v1');

    res = await get(`/api/interview-recording/confirmations?recordingId=${recording.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.confirmation_source, 'interview_report_v1');
    assert.deepEqual(res.body.confirmations, []);

    res = await post('/api/interview-recording/confirmations', {
      recordingId: recording.id,
      field_key: 'candidate_age',
      field_label: '年龄',
      extracted_value: '28',
      status: 'confirmed',
      evidence: '候选人自述 28 岁',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.saved, 0, 'strict report compatibility endpoint must ignore fields absent from key_facts');
    assert.equal(res.body.confirmation_source, 'interview_report_v1');

    res = await post('/api/interview-recording/confirmations', {
      recordingId: recording.id,
      items: [
        {
          fieldKey: 'candidate_age',
          correctedValue: '29',
          status: 'corrected',
          note: '身份证信息修正',
        },
        {
          field_key: 'current_salary',
          field_label: '当前薪资',
          extracted_value: '25k',
          status: 'unknown',
        },
      ],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.saved, 0, 'legacy free-form confirmations must not bypass strict report facts');
    assert.deepEqual(res.body.confirmations, []);

    res = await get(`/api/interview-recording/confirmations?recordingId=${recording.id}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.confirmations, []);

    res = await post('/api/interview-recording/confirm', {
      id: recording.id,
      confirmed: true,
      actor: 'HR-SYNTHETIC',
      expectedVersion: 1,
      requestId: 'interview-recording-endpoint-confirm-1',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.recording.status, 'confirmed');
    assert.ok(res.body.recording.confirmed_at);

    res = await get(`/api/interview-script?jobId=${job.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.script, null);

    res = await post('/api/interview-script/generate', { jobId: job.id });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.match(res.body.script.script_text, /结束前确认清单/);
    assert.match(res.body.script.script_json, /interview_script_p0_v1/);

    const script = JSON.parse(res.body.script.script_json);
    script.script_text = `${res.body.script.script_text}\n- HR 已修改的问题`;
    res = await post('/api/interview-script', {
      jobId: job.id,
      script,
      scriptText: script.script_text,
      status: 'draft',
    });
    assert.equal(res.status, 200);
    assert.match(res.body.script.script_text, /HR 已修改/);
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try { await stopChild(child); } catch (error) { cleanupError = error; }
  if (primaryError) {
    if (cleanupError) primaryError.cleanupError = cleanupError;
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
}

(async () => {
  let primaryError = null;
  try {
    fs.mkdirSync(SUMMARY_DIR, { recursive: true });
    checkDbMethods();
    if (process.env.HRBOSS_SKIP_LOCAL_SERVER !== '1') await checkActionEndpoints();
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch (error) { cleanupError = error; }
  if (primaryError) {
    if (cleanupError) primaryError.cleanupError = cleanupError;
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  console.log('check-interview-recording ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
