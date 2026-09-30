const fs = require('fs');
const path = require('path');
const { assertUiFixtureEnvironment } = require("../../src/ui-fixture-safety");

const { databasePath: dbPath } = assertUiFixtureEnvironment();

const Database = require('better-sqlite3');
const dbmod = require("../../src/db");

function removeSidecars(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
}

function existingDbIsFixture(file) {
  if (!fs.existsSync(file)) return true;
  let ro;
  try {
    ro = new Database(file, { readonly: true, fileMustExist: true });
    const required = ['job', 'candidate', 'resume_online', 'run_log'];
    for (const name of required) {
      const table = ro.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
      if (!table) return false;
    }
    const marker = ro.prepare("SELECT COUNT(*) AS n FROM run_log WHERE run_type = 'fixture-ui-check'").get();
    if (marker.n <= 0) return false;
    const nonFixtureJob = ro.prepare(`
      SELECT COUNT(*) AS n
      FROM job
      WHERE encrypt_job_id != 'fixture-job-002'
         OR name != 'Fixture HR Offline Test Job'
    `).get();
    if (nonFixtureJob.n > 0) return false;
    const nonFixtureCandidate = ro.prepare(`
      SELECT COUNT(*) AS n
      FROM candidate
      WHERE source != 'fixture'
         OR encrypt_job_id != 'fixture-job-002'
         OR geek_id NOT LIKE 'fixture-geek-%'
    `).get();
    return nonFixtureCandidate.n === 0;
  } catch {
    return false;
  } finally {
    if (ro) ro.close();
  }
}

if (!existingDbIsFixture(dbPath)) {
  throw new Error(`Refusing to overwrite non-fixture DB: ${dbPath}`);
}

removeSidecars(dbPath);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = dbmod.openDb(dbPath);
const now = '2026-07-08T10:00:00.000Z';
const fixtureAssetRoot = path.join(
  process.env.HRBOSS_INTERVIEW_OUTPUT_DIR || path.join(path.dirname(dbPath), 'interviews'),
  'fixture-interview-demo',
);

db.prepare(`
  INSERT INTO job (id, encrypt_job_id, numeric_job_id, name, hr_owner, is_fixture, source_type, created_at)
  VALUES (2, 'fixture-job-002', '100000000000000002', 'Fixture HR Offline Test Job', 'Fixture HR', 1, 'fixture', ?)
`).run(now);

function addCandidate(i, extra) {
  const row = dbmod.upsertCandidate({
    job_id: 2,
    geek_id: `fixture-geek-${i}`,
    numeric_uid: `90000${i}`,
    boss_id: `fixture-boss-${i}`,
    security_id: `fixture-sec-${i}`,
    encrypt_job_id: 'fixture-job-002',
    expect_id: `fixture-expect-${i}`,
    lid: `fixture-lid-${i}`,
    source: 'fixture',
    name: `Fixture Candidate ${i}`,
    rec_position: 'AI Agent Engineer',
    geek_desc: 'fixture only, no real candidate data',
    created_at: `2026-07-08T10:00:0${i}.000Z`,
    ...extra,
  }, now);
  return row.internal_id;
}

const c1 = addCandidate(1, {
  degree: '本科',
  school: 'Fixture 985 University',
  school_tier: '985',
  sabc: 'S',
  verdict_label: 'fixture strong match',
  comm_status: '未打招呼',
});
const c2 = addCandidate(2, {
  degree: '硕士',
  school: 'Fixture 211 University',
  school_tier: '211',
  sabc: 'A',
  verdict_label: 'fixture good match',
  comm_status: '已回复',
});
const c3 = addCandidate(3, {
  degree: '本科',
  school: 'Fixture Normal University',
  school_tier: '普通本科',
  sabc: 'B',
  verdict_label: 'fixture review needed',
});
const c4 = addCandidate(4, {
  degree: '未知',
  school: 'Fixture Unknown School',
  school_tier: '',
  sabc: null,
  verdict_label: 'fixture missing information',
});

for (const [candidateId, summary] of [
  [c1, 'AI Agent and RAG project fixture'],
  [c2, 'Backend platform fixture'],
  [c3, 'Business system fixture'],
  [c4, 'Missing information fixture'],
]) {
  dbmod.insertResumeOnline({
    candidate_id: candidateId,
    sections_json: JSON.stringify({ basic: { summary }, work: [], edu: [] }),
    is_paywalled: 0,
    raw_json: JSON.stringify({ fixture: true }),
    fetched_at: now,
  });
}

// One deterministic, fully synthetic interview loop for offline UI acceptance.
// These artifacts are generated in the configured controlled interview root and never represent real material.
fs.rmSync(fixtureAssetRoot, { recursive: true, force: true });
fs.mkdirSync(fixtureAssetRoot, { recursive: true });
const transcriptPath = path.join(fixtureAssetRoot, 'transcript.txt');
const transcriptSrtPath = path.join(fixtureAssetRoot, 'transcript.srt');
const transcriptJsonPath = path.join(fixtureAssetRoot, 'transcript.json');
const wavPath = path.join(fixtureAssetRoot, 'audio.wav');
const codexInputPath = path.join(fixtureAssetRoot, 'codex-input.md');
const summaryPath = path.join(fixtureAssetRoot, 'summary.json');
const transcript = [
  '【本地演示样本】以下内容为固定 fixture，不是真实候选人访谈。',
  '面试官：请说明一次需求梳理和协作推进的演示案例。',
  '演示候选人：我先整理验收标准，再按风险拆分任务，并用本地样例完成复核。',
  '面试官：这个案例还有哪些信息需要人工确认？',
  '演示候选人：业务结果与个人信息均未采集，不能据此作招聘判断；到岗字段仅用于演示，样本值为两周。',
].join('\n');
const recordingSummary = {
  schema_version: 'interview_recording_local_demo_v1',
  source: 'local_demo_fixture',
  source_type: 'fixture_recording',
  mode: 'local_demo',
  is_fixture: true,
  is_local_demo: true,
  external_services_called: false,
  disclaimer: '本地演示样本；未执行真实录音、转写或 AI 调用，不代表真实 AI 判断。',
  topic: '本地演示面试闭环',
  createdAt: now,
  wavPath,
  transcriptTxt: transcriptPath,
  transcriptSrt: transcriptSrtPath,
  transcriptJson: transcriptJsonPath,
  summaryPath,
  codexInput: codexInputPath,
};
fs.writeFileSync(wavPath, 'RIFF synthetic local demo audio\n');
fs.writeFileSync(transcriptPath, `${transcript}\n`, 'utf8');
fs.writeFileSync(transcriptSrtPath, `1\n00:00:00,000 --> 00:00:01,000\n${transcript.split('\n')[0]}\n`, 'utf8');
fs.writeFileSync(transcriptJsonPath, `${JSON.stringify({ text: transcript }, null, 2)}\n`, 'utf8');
fs.writeFileSync(codexInputPath, '# 本地演示样本\n\n未执行真实 AI 调用。\n', 'utf8');
fs.writeFileSync(summaryPath, `${JSON.stringify(recordingSummary, null, 2)}\n`, 'utf8');

const recording = dbmod.createInterviewRecording({
  summary_path: summaryPath,
  wav_path: wavPath,
  transcript_txt_path: transcriptPath,
  transcript_srt_path: transcriptSrtPath,
  transcript_json_path: transcriptJsonPath,
  codex_input_path: codexInputPath,
  topic: recordingSummary.topic,
  status: 'pending_match',
  created_at: now,
  raw_summary_json: recordingSummary,
});
dbmod.bindInterviewRecording({ id: recording.id, candidateId: c1, jobId: 2 });
const interviewSession = dbmod.createInterviewSession({
  candidateId: c1,
  jobId: 2,
  round: 1,
  mode: 'offline',
  status: 'pending_review',
});
const interviewMaterial = dbmod.linkInterviewSessionRecording({
  sessionId: interviewSession.id,
  recordingId: recording.id,
  linkedBy: 'Fixture-HR',
});
const structuredStart = transcript.indexOf('我先整理验收标准');
const structuredEnd = transcript.indexOf('。', structuredStart) + 1;
const riskStart = transcript.indexOf('业务结果与个人信息均未采集');
const riskEnd = transcript.indexOf('；', riskStart);
const arrivalStart = transcript.indexOf('到岗字段仅用于演示');
const arrivalEnd = transcript.indexOf('。', arrivalStart) + 1;
const evidenceRef = (start, end) => [{
  material_id: interviewMaterial.id,
  span: { type: 'text_span', start, end },
}];

const interviewDemoReport = {
  schema_version: 'interview_report_v1',
  summary: {
    id: 'summary.fixture',
    status: 'supported',
    text: '固定演示报告：材料中出现了结构化拆解表述；真实性与业务结果仍需人工核验。',
    evidence_refs: evidenceRef(structuredStart, structuredEnd),
  },
  match_points: [
    {
      id: 'match.structured_expression',
      status: 'supported',
      text: '能够按验收标准、风险和任务拆分描述演示案例。',
      evidence_refs: evidenceRef(structuredStart, structuredEnd),
    },
  ],
  risks: [
    {
      id: 'risk.fixture_not_verified',
      status: 'supported',
      text: '当前仅为固定 fixture，不能外推候选人能力。',
      evidence_refs: evidenceRef(riskStart, riskEnd),
    },
  ],
  unknowns: [{
    id: 'unknown.fixture_scope',
    status: 'unknown',
    text: '业务结果、个人贡献和背景信息均未采集。',
    reason_code: 'not_mentioned',
    evidence_refs: [],
  }],
  followup_questions: [{
    id: 'question.fixture_evidence',
    status: 'unknown',
    question: '真实面试中应补充哪些可核验的项目证据与个人贡献边界？',
    reason_code: 'not_mentioned',
    evidence_refs: [],
  }],
  key_facts: [
    { field_key: 'salary_expectation', label: '薪资期望', status: 'unknown', reason_code: 'not_mentioned', evidence_refs: [] },
    { field_key: 'business_scale', label: 'GMV/营收数字', status: 'unknown', reason_code: 'not_mentioned', evidence_refs: [] },
    { field_key: 'efficiency_metric', label: 'ROI/转化率', status: 'unknown', reason_code: 'not_mentioned', evidence_refs: [] },
    { field_key: 'work_years', label: '工作年限', status: 'unknown', reason_code: 'not_mentioned', evidence_refs: [] },
    { field_key: 'team_size', label: '团队规模', status: 'unknown', reason_code: 'not_mentioned', evidence_refs: [] },
    { field_key: 'arrival_time', label: '到岗时间', status: 'supported', value: '两周', evidence_refs: evidenceRef(arrivalStart, arrivalEnd) },
  ],
  human_confirm_required: true,
  disclaimer: '本报告仅基于已关联面试材料生成，须经 HR 人工确认，不代表自动录用、淘汰、排序或处置。',
};
dbmod.saveInterviewAiReport({
  recordingId: recording.id,
  report: interviewDemoReport,
  actor: 'Fixture-HR',
  expectedVersion: 0,
  requestId: 'fixture-report-save-v1',
});

dbmod.reviewInterviewReportFacts({
  sessionId: interviewSession.id,
  actor: 'Fixture-HR',
  expectedVersion: 1,
  requestId: 'fixture-report-fact-review-v1',
  items: [
    { field_key: 'salary_expectation', status: 'unknown' },
    { field_key: 'business_scale', status: 'unknown' },
    { field_key: 'efficiency_metric', status: 'unknown' },
    { field_key: 'work_years', status: 'unknown' },
    { field_key: 'team_size', status: 'unknown' },
    { field_key: 'arrival_time', status: 'confirmed' },
  ],
});
dbmod.confirmInterviewReportForRecording({
  id: recording.id,
  confirmed: true,
  actor: 'Fixture-HR',
  expectedVersion: 2,
  requestId: 'fixture-report-confirm-v1',
});

dbmod.changeStatus(c2, 'comm', '已回复', 'fixture', 'Fixture HR', 'UI check fixture');
dbmod.writeRunLog({
  run_type: 'fixture-ui-check',
  account: 'fixture-local',
  job: '2',
  status: '成功',
  count_new: 4,
  count_total: 4,
  error_summary: null,
  started_at: now,
  finished_at: now,
});
dbmod.writeRunLog({
  run_type: '推荐流抓取',
  account: 'fixture-local',
  job: '2',
  status: '成功',
  count_new: 4,
  count_total: 4,
  error_summary: null,
  started_at: '2026-07-08T10:10:00.000Z',
  finished_at: '2026-07-08T10:10:00.000Z',
});
dbmod.writeRunLog({
  run_type: '规则评级',
  account: 'fixture-local',
  job: '2',
  status: '成功',
  count_new: 0,
  count_total: 4,
  error_summary: null,
  started_at: '2026-07-08T10:20:00.000Z',
  finished_at: '2026-07-08T10:20:00.000Z',
});

db.close();
console.log(`fixture db ready: ${dbPath}`);
