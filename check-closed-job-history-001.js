'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `hrboss-closed-job-history-${process.pid}-`));
const DB_PATH = path.join(ROOT, 'history.db');
const MATERIAL_ROOT = path.join(ROOT, 'interviews');
const PORT = 20800 + (process.pid % 600);
const TOKEN = 'closed-job-history-local-token-0000000000001';

process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
process.env.BOSS_DB_PATH = DB_PATH;
process.env.HRBOSS_RECOVERY_ROOT = path.join(ROOT, 'recovery');
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = MATERIAL_ROOT;
process.env.BOSS_ACTION_PORT = String(PORT);
process.env.HRBOSS_LOCAL_API_TOKEN = TOKEN;
process.env.HRBOSS_LOCAL_API_INSTANCE_ID = 'closed-job-history-check';

const db = require('./db');
const adapters = require('./interview-source-adapters');
const actionServer = require('./action-server');
const { REPORT_DISCLAIMER } = require('./interview-report-v1');

process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

function offlineMaterial(name, transcript) {
  const dir = path.join(MATERIAL_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, 'source.wav');
  const txt = path.join(dir, 'transcript.txt');
  const srt = path.join(dir, 'transcript.srt');
  const json = path.join(dir, 'transcript.json');
  const codex = path.join(dir, 'codex-input.md');
  const summary = path.join(dir, 'summary.json');
  fs.writeFileSync(source, 'RIFF synthetic closed-job history');
  fs.writeFileSync(txt, transcript);
  fs.writeFileSync(srt, `1\n00:00:00,000 --> 00:00:03,000\n${transcript}\n`);
  fs.writeFileSync(json, JSON.stringify({ text: transcript }));
  fs.writeFileSync(codex, '# synthetic closed-job history');
  const payload = {
    createdAt: '2026-07-16T09:00:00.000Z',
    topic: name,
    sourcePath: source,
    wavPath: source,
    transcriptTxt: txt,
    transcriptSrt: srt,
    transcriptJson: json,
    codexInput: codex,
  };
  fs.writeFileSync(summary, JSON.stringify(payload));
  return {
    summary_path: summary,
    source_path: source,
    wav_path: source,
    transcript_txt_path: txt,
    transcript_srt_path: srt,
    transcript_json_path: json,
    codex_input_path: codex,
    topic: name,
    raw_summary_json: payload,
    created_at: payload.createdAt,
  };
}

function reportFixture(materialId) {
  const refs = [{ material_id: materialId, span: { type: 'text_span', start: 0, end: 12 } }];
  return {
    schema_version: 'interview_report_v1',
    summary: { id: 'summary.main', status: 'supported', text: '候选人给出了纯合成项目事实。', evidence_refs: refs },
    match_points: [{ id: 'match.project', status: 'supported', text: '有项目事实。', evidence_refs: refs }],
    risks: [],
    unknowns: [{ id: 'unknown.team', status: 'unknown', text: '团队规模未知。', reason_code: 'not_mentioned', evidence_refs: [] }],
    followup_questions: [{ id: 'question.team', status: 'supported', question: '请补充团队规模。', evidence_refs: refs }],
    key_facts: [{ field_key: 'project_result', label: '项目结果', status: 'supported', value: '纯合成上线', evidence_refs: refs }],
    human_confirm_required: true,
    disclaimer: REPORT_DISCLAIMER,
  };
}

function request(method, pathname, body = null) {
  const payload = body === null ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method,
      headers: {
        'x-hrboss-token': TOKEN,
        ...(body === null ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        }),
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

async function waitForHealth() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await request('GET', '/api/health');
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('action server did not become ready');
}

function assertClosed(response, label) {
  assert.equal(response.status, 409, `${label}: expected 409, got ${response.status}`);
  assert.equal(response.body.code, 'JOB_CLOSED', `${label}: expected JOB_CLOSED`);
}

(async () => {
  db.openDb(DB_PATH);
  const job = db.upsertJob({
    encrypt_job_id: 'closed-history-job',
    numeric_job_id: '7100000000000001',
    name: '关闭岗位历史合成岗',
    hr_owner: '合成 HR',
  });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'closed-history-candidate',
    source: 'synthetic_closed_history',
    name: '关闭岗位历史合成候选人',
  });
  const jd = db.createJobJdVersion({
    jobId: job.id,
    jdText: '关闭岗位历史合成 JD',
    source: 'manual',
    actor: 'HR-CLOSED-HISTORY',
  });
  db.activateJobJdVersion({ jdVersionId: jd.id, expectedVersion: jd.version, actor: 'HR-CLOSED-HISTORY' });
  const profile = db.createJobProfileVersion({
    jobId: job.id,
    jdVersionId: jd.id,
    config: { rubric: '关闭岗位历史合成画像' },
    actor: 'HR-CLOSED-HISTORY',
  });
  db.confirmJobProfileVersion({ profileVersionId: profile.id, expectedVersion: profile.version, actor: 'HR-CLOSED-HISTORY' });
  const ingested = adapters.ingestOfflineRecording({
    recording: offlineMaterial('closed-history-recording', '纯合成项目事实用于关闭岗位历史读取验证。'),
    candidateId: candidate.internal_id,
    jobId: job.id,
    round: 1,
    actor: 'HR-CLOSED-HISTORY',
    reason: 'explicit_candidate_context',
    requestId: 'closed-history-ingest',
  });
  const sessionId = Number(ingested.session.id);
  const recordingId = Number(ingested.assignment.interview_recording_id);
  let session = db.confirmInterviewSessionSchedule({
    sessionId,
    scheduledAt: '2027-01-10T10:00:00+08:00',
    confirmedBy: 'HR-CLOSED-HISTORY',
    confirmed: true,
    requestId: 'closed-history-schedule-1',
  });
  session = db.confirmInterviewSessionSchedule({
    sessionId,
    scheduledAt: '2027-01-11T14:00:00+08:00',
    confirmedBy: 'HR-CLOSED-HISTORY',
    confirmed: true,
    requestId: 'closed-history-schedule-2',
  });
  db.setInterviewSessionStatus({ sessionId, status: 'pending_review' });
  const material = db.conn().prepare('SELECT id FROM interview_session_material WHERE session_id = ?').get(sessionId);
  let report = db.saveInterviewReportV1({
    sessionId,
    report: reportFixture(material.id),
    actor: 'HR-CLOSED-HISTORY',
    expectedVersion: 0,
    requestId: 'closed-history-report-save',
  });
  report = db.reviewInterviewReportFacts({
    sessionId,
    items: [{ field_key: 'project_result', status: 'confirmed' }],
    actor: 'HR-CLOSED-HISTORY',
    expectedVersion: report.version,
    requestId: 'closed-history-report-facts',
  }).report;
  report = db.confirmInterviewReportV1({
    sessionId,
    confirmed: true,
    actor: 'HR-CLOSED-HISTORY',
    expectedVersion: report.version,
    requestId: 'closed-history-report-confirm',
  });
  db.saveInterviewScript({
    jobId: job.id,
    source: 'manual',
    status: 'draft',
    script_json: JSON.stringify({ schema_version: 'interview_script_p0_v1', script_text: '纯合成历史脚本' }),
    script_text: '纯合成历史脚本',
  });

  await actionServer.startHttpServer();
  await waitForHealth();

  db.updateJobStatus({ jobId: job.id, status: 'paused', actor: 'HR-CLOSED-HISTORY' });
  db.updateJobStatus({ jobId: job.id, status: 'closed', closeReason: 'other', actor: 'HR-CLOSED-HISTORY' });

  const workbench = db.getJobWorkbench(job.id);
  const workbenchSession = workbench.interview_sessions.find((item) => Number(item.id) === sessionId);
  assert.ok(workbenchSession, 'closed job workbench must retain the original session');
  assert.equal(workbenchSession.report_status, 'confirmed');
  assert.equal(workbenchSession.schedule_confirmations.length, 2, 'workbench must retain reschedule history');

  const sessionRes = await request('GET', `/api/interview-session?candidateId=${encodeURIComponent(candidate.internal_id)}&jobId=${job.id}`);
  assert.equal(sessionRes.status, 200);
  assert.equal(sessionRes.body.sessions.length, 1);
  assert.equal(Number(sessionRes.body.sessions[0].id), sessionId);
  assert.equal(sessionRes.body.sessions[0].materials.length, 1);
  assert.equal(sessionRes.body.sessions[0].schedule_confirmations.length, 2);

  const recordingsRes = await request('GET', `/api/interview-recording?candidateId=${encodeURIComponent(candidate.internal_id)}&jobId=${job.id}`);
  assert.equal(recordingsRes.status, 200);
  assert.ok(recordingsRes.body.recordings.some((item) => Number(item.id) === recordingId));

  const reportRes = await request('GET', `/api/interview-report?sessionId=${sessionId}`);
  assert.equal(reportRes.status, 200);
  assert.equal(reportRes.body.report.status, 'confirmed');
  assert.equal(reportRes.body.facts.length, 1);
  assert.equal(reportRes.body.facts[0].status, 'confirmed');

  const confirmationsRes = await request('GET', `/api/interview-recording/confirmations?recordingId=${recordingId}`);
  assert.equal(confirmationsRes.status, 200);
  assert.equal(confirmationsRes.body.confirmation_source, 'interview_report_v1');
  assert.equal(confirmationsRes.body.confirmations[0].status, 'confirmed');

  const transcriptRes = await request('GET', `/api/interview-recording/transcript?recordingId=${recordingId}`);
  assert.equal(transcriptRes.status, 200);
  assert.match(JSON.stringify(transcriptRes.body.transcript), /纯合成项目事实/);

  assertClosed(await request('POST', '/api/interview-session/schedule', {
    sessionId,
    scheduledAt: '2027-01-12T10:00:00+08:00',
    confirmed: true,
    requestId: 'closed-history-blocked-reschedule',
  }), 'reschedule');
  assertClosed(await request('POST', '/api/interview-lifecycle/withdraw', {
    sessionId,
    reasonCode: 'candidate_cancelled',
    confirmed: true,
  }), 'cancel');
  assertClosed(await request('POST', '/api/interview-recording/bind', {
    id: recordingId,
    candidateId: candidate.internal_id,
    jobId: job.id,
  }), 'recording bind');
  assertClosed(await request('POST', '/api/interview-script', {
    jobId: job.id,
    script: { schema_version: 'interview_script_p0_v1', script_text: '关闭后不得保存' },
    scriptText: '关闭后不得保存',
  }), 'script save');
  assertClosed(await request('POST', '/api/interview-script/generate', {
    jobId: job.id,
  }), 'script generate');

  const reviewSource = fs.readFileSync(path.join(__dirname, 'frontend/src/components/InterviewReviewPanel.jsx'), 'utf8');
  const scheduleSource = fs.readFileSync(path.join(__dirname, 'frontend/src/components/InterviewScheduleCanonical.jsx'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, 'frontend/src/App.jsx'), 'utf8');
  assert.doesNotMatch(reviewSource, /if \(!candidateId \|\| readOnly\)/, 'readOnly must not suppress interview history GET/load');
  assert.match(reviewSource, /if \(!candidateId\)/, 'missing candidate remains the only load short circuit');
  assert.match(reviewSource, /刷新只读面试历史/, 'readOnly UI must retain an explicit refresh action');
  assert.match(scheduleSource, /人工排期历史/);
  assert.match(scheduleSource, /岗位已关闭，面试历史只读/);
  assert.match(scheduleSource, /!readOnly && canSchedule/);
  assert.match(appSource, /<InterviewScheduleCanonical[\s\S]*readOnly=\{jobReadOnly\}/);
  assert.match(appSource, /<CandidateDetail[\s\S]*readOnly=\{jobReadOnly \|\| candidateAuthorityWriteBlocked\}/);

  console.log(JSON.stringify({
    ok: true,
    contract: 'CLOSED-JOB-HISTORY-001',
    job_status: workbench.job.status,
    session_id: sessionId,
    recording_id: recordingId,
    schedule_history_count: workbenchSession.schedule_confirmations.length,
    report_status: report.status,
    closed_write_code: 'JOB_CLOSED',
    ui_read_load_enabled: true,
  }));
  await actionServer.shutdown();
})().catch(async (error) => {
  try { await actionServer.shutdown(); } catch {}
  console.error(error);
  process.exitCode = 1;
});
