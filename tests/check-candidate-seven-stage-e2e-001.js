'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-candidate-seven-stage-'));
const DB_PATH = path.join(ROOT, 'recruiting.db');
const DATA_ROOT = path.join(ROOT, 'data');
const INTERVIEW_ROOT = path.join(ROOT, 'interviews');
const RESUME_PATH = path.join(ROOT, 'synthetic-candidate-resume.txt');
const PORT = 23000 + (process.pid % 1000);
const TOKEN = 'synthetic-local-api-token-seven-stage';
const RESUME_SECRET = 'r'.repeat(64);

process.env.BOSS_DB_PATH = DB_PATH;
process.env.BOSS_ACTION_PORT = String(PORT);
process.env.HRBOSS_DATA_DIR = DATA_ROOT;
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = INTERVIEW_ROOT;
process.env.HRBOSS_LOCAL_API_TOKEN = TOKEN;
process.env.HRBOSS_LOCAL_API_INSTANCE_ID = 'check-candidate-seven-stage-e2e';
process.env.HRBOSS_RESUME_SELECTION_SECRET = RESUME_SECRET;
process.env.HRBOSS_F018_ENABLED = '1';

const db = require("../src/db");
const actionServer = require("../src/action-server");
const { issueResumeFileSelection } = require("../src/resume-file-selection");
const { NEW_CANDIDATE_BINDING } = require("../src/resume-candidate-intake");

const databases = new Set();
const trackDatabase = (database) => (databases.add(database), database);

function closeTrackedDatabases() {
  const errors = [];
  for (const database of [...databases].reverse()) {
    try {
      if (database && database.open) database.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'failed to close tracked fixture databases');
}

async function cleanup() {
  const errors = [];
  if (databases.size) {
    try { trackDatabase(db.conn()); } catch (error) { errors.push(error); }
  }
  try { await actionServer.shutdown(); } catch (error) { errors.push(error); }
  try { closeTrackedDatabases(); } catch (error) { errors.push(error); }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'check-candidate-seven-stage-e2e-001 cleanup failed');
}

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

async function post(pathname, body) {
  const response = await request('POST', pathname, body);
  assert.ok(response.body, `${pathname} returned no JSON body`);
  assert.equal(response.body.ok, true, `${pathname}: ${JSON.stringify(response.body)}`);
  return response.body;
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

function seedJobProfile() {
  const job = db.upsertJob({
    encrypt_job_id: 'synthetic-seven-stage-job',
    numeric_job_id: 'synthetic-seven-stage-001',
    name: '合成七阶段候选人岗位',
    hr_owner: 'Synthetic HR',
    status: 'open',
  });
  const jd = db.createJobJdVersion({
    jobId: job.id,
    jdText: '本岗位仅用于合成候选人七阶段本地回归。',
    actor: 'local-primary-operator',
  });
  db.activateJobJdVersion({
    jdVersionId: jd.id,
    expectedVersion: jd.version,
    actor: 'local-primary-operator',
  });
  const profile = db.createJobProfileVersion({
    jobId: job.id,
    jdVersionId: jd.id,
    config: {
      rubric: '只核对合成材料与人工流程，不自动评分或决策。',
    },
    actor: 'local-primary-operator',
  });
  const confirmedProfile = db.confirmJobProfileVersion({
    profileVersionId: profile.id,
    expectedVersion: profile.version,
    actor: 'local-primary-operator',
  });
  return { job, profile: confirmedProfile };
}

function writeSyntheticInterviewSummary() {
  const directory = path.join(INTERVIEW_ROOT, 'synthetic-seven-stage-material');
  fs.mkdirSync(directory, { recursive: true });
  const sourcePath = path.join(directory, 'source.mp4');
  const wavPath = path.join(directory, 'audio.wav');
  const transcriptTxt = path.join(directory, 'transcript.txt');
  const transcriptSrt = path.join(directory, 'transcript.srt');
  const transcriptJson = path.join(directory, 'transcript.json');
  const codexInput = path.join(directory, 'codex-input.md');
  const summaryPath = path.join(directory, 'summary.json');
  const transcript = '合成候选人说明可以两周到岗，本材料仅用于本地人工流程回归。';
  fs.writeFileSync(sourcePath, 'synthetic local video fixture\n');
  fs.writeFileSync(wavPath, 'RIFF synthetic local audio fixture\n');
  fs.writeFileSync(transcriptTxt, `${transcript}\n`);
  fs.writeFileSync(transcriptSrt, `1\n00:00:00,000 --> 00:00:05,000\n${transcript}\n`);
  fs.writeFileSync(transcriptJson, `${JSON.stringify({ text: transcript }, null, 2)}\n`);
  fs.writeFileSync(codexInput, '# 合成候选人本地复盘输入\n');
  fs.writeFileSync(summaryPath, `${JSON.stringify({
    createdAt: '2026-07-26T12:00:00.000Z',
    topic: '合成候选人七阶段面试',
    mode: 'from-file',
    sourcePath,
    wavPath,
    transcriptTxt,
    transcriptSrt,
    transcriptJson,
    codexInput,
  }, null, 2)}\n`);
  return summaryPath;
}

function interviewReport(materialId) {
  const evidence = [{
    material_id: materialId,
    span: { type: 'text_span', start: 0, end: 12 },
  }];
  return {
    schema_version: 'interview_report_v1',
    summary: {
      id: 'summary.synthetic',
      status: 'supported',
      text: '合成候选人说明了到岗周期。',
      evidence_refs: evidence,
    },
    match_points: [],
    risks: [],
    unknowns: [{
      id: 'unknown.synthetic',
      status: 'unknown',
      text: '其余岗位事实未在合成材料中提及。',
      reason_code: 'not_mentioned',
      evidence_refs: [],
    }],
    followup_questions: [],
    key_facts: [{
      field_key: 'arrival_time',
      label: '到岗时间',
      status: 'supported',
      value: '两周',
      evidence_refs: evidence,
    }],
    human_confirm_required: true,
    disclaimer: '本报告仅基于已关联面试材料生成，须经 HR 人工确认，不代表自动录用、淘汰、排序或处置。',
  };
}

function assertRendererRouteContracts() {
  const apiSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/api.js'), 'utf8');
  const contracts = [
    ['commitCandidateFromResume', '/candidate/resume-intake/commit'],
    ['changeCandidateStatus', '/candidate-status'],
    ['confirmInterviewSchedule', '/interview-session/schedule'],
    ['importInterviewRecordingSummary', '/interview-recording/import-summary'],
    ['saveInterviewReport', '/interview-report'],
    ['confirmF018FinalReview', '/f018/final-review/confirm'],
    ['recordF018Disposition', '/f018/disposition'],
  ];
  contracts.forEach(([method, route]) => {
    assert.match(
      apiSource,
      new RegExp(`${method}:[\\s\\S]{0,260}${route.replaceAll('/', '\\/')}`),
      `${method} must remain wired to ${route}`,
    );
  });
}

async function run() {
  assertRendererRouteContracts();
  trackDatabase(db.openDb(DB_PATH));
  const { job, profile } = seedJobProfile();
  fs.writeFileSync(RESUME_PATH, [
    '姓名：合成七阶段候选人',
    '学历：本科',
    '毕业院校：合成测试大学',
    '5年工作经验',
    '工作经历：本地 Electron、React 与 SQLite 合成项目。',
  ].join('\n'));

  await actionServer.startHttpServer();
  trackDatabase(db.conn());
  await waitForHealth();

  // 1. 简历建档：原生文件选择令牌进入 UI 对应 preview/commit API，
  // 最终只在当前隔离数据库建立一个合成候选人。
  const resumeBinding = {
    source_path: RESUME_PATH,
    candidate_id: NEW_CANDIDATE_BINDING,
    job_id: job.id,
    request_id: 'seven-stage-resume-preview',
  };
  const preview = await post('/api/candidate/resume-intake/preview', {
    ...resumeBinding,
    selection_token: issueResumeFileSelection(RESUME_SECRET, resumeBinding),
  });
  const committedResume = await post('/api/candidate/resume-intake/commit', {
    draft_id: preview.result.draft_id,
    job_id: job.id,
    ...preview.result.fields,
  });
  const candidateId = committedResume.result.candidate_id;
  assert.equal(db.getCandidate(candidateId).name, '合成七阶段候选人');

  // 2. 沟通事实。
  await post('/api/candidate-status', {
    candidateId,
    layer: 'comm',
    code: 'replied',
    reason: '合成候选人已回复',
    source: 'manual_communication_backfill',
  });
  assert.equal(db.getCandidate(candidateId).communication_code, 'replied');

  // 3. 安排面试。
  const createdSession = await post('/api/interview-session', {
    candidateId,
    jobId: job.id,
    interviewFormat: 'offline',
  });
  const sessionId = createdSession.session.id;
  const scheduled = await post('/api/interview-session/schedule', {
    sessionId,
    scheduledAt: '2030-08-01T10:00:00+08:00',
    confirmed: true,
    requestId: 'seven-stage-schedule-confirm',
  });
  assert.equal(scheduled.session.status, 'scheduled');

  // 4. 录音/记录：导入受控合成摘要，人工分类并归属到同一候选人/轮次。
  const imported = await post('/api/interview-recording/import-summary', {
    summaryPath: writeSyntheticInterviewSummary(),
  });
  const classified = await post('/api/interview-assignment/classify', {
    pendingAssignmentId: imported.assignment.id,
    purpose: 'candidate_interview',
    expectedVersion: imported.assignment.version,
    reason: 'manual_candidate_classification',
    requestId: 'seven-stage-material-classify',
  });
  const assigned = await post('/api/interview-assignment/assign', {
    pendingAssignmentId: classified.assignment.id,
    candidateId,
    jobId: job.id,
    round: scheduled.session.round,
    expectedVersion: classified.assignment.version,
    reason: 'manual_assignment',
    requestId: 'seven-stage-material-assign',
  });
  assert.equal(Number(assigned.session.id), Number(sessionId));
  const material = db.conn().prepare(`
    SELECT id
    FROM interview_session_material
    WHERE session_id = ? AND interview_recording_id = ?
  `).get(sessionId, imported.recording.id);
  assert.ok(material);

  // 5. 报告复核：保存、事实复核、人工确认三次独立写入。
  const savedReport = await post('/api/interview-report', {
    sessionId,
    report: interviewReport(material.id),
    expectedVersion: 0,
    requestId: 'seven-stage-report-save',
  });
  const reviewedFacts = await post('/api/interview-report/facts', {
    sessionId,
    items: [{ field_key: 'arrival_time', status: 'confirmed' }],
    expectedVersion: savedReport.report.version,
    requestId: 'seven-stage-report-facts',
  });
  const confirmedReport = await post('/api/interview-report/confirm', {
    sessionId,
    confirmed: true,
    expectedVersion: reviewedFacts.report.version,
    requestId: 'seven-stage-report-confirm',
  });
  assert.equal(confirmedReport.report.status, 'confirmed');

  // 6. 结构化终评：先建立申请，再保存并确认独立人工终评卡。
  const f018StateResponse = await request(
    'GET',
    `/api/f018/final-review?candidateId=${encodeURIComponent(candidateId)}&jobId=${job.id}`,
  );
  assert.equal(f018StateResponse.status, 200);
  assert.equal(f018StateResponse.body?.ok, true);
  const application = f018StateResponse.body.state.applications
    .find((item) => item.status === 'active');
  assert.ok(application, 'resume intake must leave the candidate in an active application episode');
  const draftReview = await post('/api/f018/final-review/draft', {
    application_id: application.id,
    job_profile_version_id: profile.id,
    interview_report_id: confirmedReport.report.id,
    review_json: {
      decision_summary: '仅基于合成材料完成结构化人工复核。',
      strengths: '到岗时间有已确认的材料证据。',
      risks: '没有真实候选人或真实业务结果。',
      limitations: '不得外推招聘结论。',
      evidence_refs: [
        { source_type: 'job_profile', source_id: profile.id },
        { source_type: 'interview_report', source_id: confirmedReport.report.id },
      ],
    },
    expected_version: 0,
    request_id: 'seven-stage-final-review-draft',
    candidate_id: candidateId,
    job_id: job.id,
  });
  const confirmedReview = await post('/api/f018/final-review/confirm', {
    application_id: application.id,
    final_review_id: draftReview.review.id,
    expected_version: draftReview.review.version,
    request_id: 'seven-stage-final-review-confirm',
    confirmed: true,
    candidate_id: candidateId,
    job_id: job.id,
  });
  assert.equal(confirmedReview.review.status, 'confirmed');

  // 7. 人工处置：终评确认后再执行第二个显式动作。
  const disposition = await post('/api/f018/disposition', {
    application_id: application.id,
    final_review_id: confirmedReview.review.id,
    action: 'talent_pool',
    reason_code: 'manual_final_disposition',
    expected_version: application.version,
    request_id: 'seven-stage-disposition',
    confirmed: true,
    candidate_id: candidateId,
    job_id: job.id,
  });
  assert.equal(disposition.disposition.action, 'talent_pool');
  assert.equal(db.getCandidate(candidateId).disposition_code, 'talent_pool');

  const counts = {
    candidates: db.conn().prepare('SELECT COUNT(*) AS n FROM candidate WHERE internal_id = ?').get(candidateId).n,
    communications: db.conn().prepare("SELECT COUNT(*) AS n FROM status_history WHERE candidate_id = ? AND layer = 'comm'").get(candidateId).n,
    sessions: db.conn().prepare('SELECT COUNT(*) AS n FROM interview_session WHERE candidate_id = ? AND job_id = ?').get(candidateId, job.id).n,
    materials: db.conn().prepare('SELECT COUNT(*) AS n FROM interview_session_material WHERE session_id = ?').get(sessionId).n,
    confirmed_reports: db.conn().prepare("SELECT COUNT(*) AS n FROM interview_report_v1 WHERE session_id = ? AND status = 'confirmed'").get(sessionId).n,
    confirmed_reviews: db.conn().prepare("SELECT COUNT(*) AS n FROM final_review WHERE application_id = ? AND status = 'confirmed'").get(application.id).n,
    dispositions: db.conn().prepare('SELECT COUNT(*) AS n FROM final_disposition WHERE application_id = ?').get(application.id).n,
  };
  assert.deepEqual(counts, {
    candidates: 1,
    communications: 1,
    sessions: 1,
    materials: 1,
    confirmed_reports: 1,
    confirmed_reviews: 1,
    dispositions: 1,
  });

  return JSON.stringify({
    ok: true,
    contract: 'CANDIDATE-SEVEN-STAGE-E2E-001',
    stages: [
      'resume_intake',
      'communication_fact',
      'interview_schedule',
      'local_interview_material',
      'interview_report_review',
      'structured_final_review',
      'manual_disposition',
    ],
    renderer_route_contracts: true,
    action_api_and_database: true,
    one_synthetic_candidate: true,
    real_microphone_used: false,
    external_network_used: false,
    counts,
    cleanup: 'temporary root removed after server and database shutdown',
  }, null, 2);
}

run().then(async (message) => {
  try {
    await cleanup();
    console.log(message);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}, async (error) => {
  let cleanupError = null;
  try { await cleanup(); } catch (caught) { cleanupError = caught; }
  console.error(error);
  if (cleanupError) console.error(cleanupError);
  process.exitCode = 1;
});
