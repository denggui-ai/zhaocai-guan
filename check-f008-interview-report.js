const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f008-'));
const DB_PATH = path.join(ROOT, 'f008.db');
const MATERIAL_ROOT = path.join(ROOT, 'interviews');
process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
process.env.BOSS_DB_PATH = DB_PATH;
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = MATERIAL_ROOT;
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const db = require('./db');
const adapters = require('./interview-source-adapters');
const {
  REPORT_DISCLAIMER,
  InterviewReportValidationError,
  validateInterviewReport,
} = require('./interview-report-v1');
const { buildConfirmedInterviewProjection } = require('./interview-report-authority');
const { applyF008InterviewReportMigration } = require('./f008-interview-report-migration');

function expectCode(fn, code, pathPrefix = null) {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof InterviewReportValidationError, `expected InterviewReportValidationError ${code}`);
  assert.equal(caught.code, code);
  if (pathPrefix) assert.ok(caught.path.startsWith(pathPrefix), `${caught.path} should start with ${pathPrefix}`);
  return caught;
}

function writeOfflineMaterial(name, transcriptText) {
  const dir = path.join(MATERIAL_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const sourcePath = path.join(dir, 'source.wav');
  const transcriptTxt = path.join(dir, 'transcript.txt');
  const transcriptSrt = path.join(dir, 'transcript.srt');
  const transcriptJson = path.join(dir, 'transcript.json');
  const codexInput = path.join(dir, 'codex-input.md');
  const summaryPath = path.join(dir, 'summary.json');
  fs.writeFileSync(sourcePath, 'RIFF synthetic audio\n');
  fs.writeFileSync(transcriptTxt, `${transcriptText}\n`);
  fs.writeFileSync(transcriptSrt, `1\n00:00:00,000 --> 00:00:03,000\n${transcriptText}\n`);
  fs.writeFileSync(transcriptJson, `${JSON.stringify({ transcription: [{ timestamps: { from: '00:00:00,000', to: '00:00:03,000' }, text: transcriptText }] })}\n`);
  fs.writeFileSync(codexInput, '# synthetic F008 input\n');
  const summary = {
    createdAt: '2026-07-11T09:00:00.000Z',
    topic: name,
    sourcePath,
    wavPath: sourcePath,
    transcriptTxt,
    transcriptSrt,
    transcriptJson,
    codexInput,
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return {
    summary_path: summaryPath,
    source_path: sourcePath,
    wav_path: sourcePath,
    transcript_txt_path: transcriptTxt,
    transcript_srt_path: transcriptSrt,
    transcript_json_path: transcriptJson,
    codex_input_path: codexInput,
    topic: name,
    raw_summary_json: summary,
    created_at: summary.createdAt,
  };
}

function evidence(materialId, start = 0, end = 8) {
  return [{ material_id: materialId, span: { type: 'text_span', start, end } }];
}

const authorityFixture = buildConfirmedInterviewProjection({
  reportRow: {
    id: 1001,
    session_id: 2001,
    version: 3,
    content_hash: 'synthetic-authority-source-hash',
  },
  report: {
    schema_version: 'interview_report_v1',
    key_facts: [
      {
        field_key: 'supported.confirmed',
        label: '已确认事实',
        status: 'supported',
        value: '已确认值',
        evidence_refs: evidence(1),
      },
      {
        field_key: 'unknown.confirmed',
        label: '仍未知事实',
        status: 'unknown',
        reason_code: 'not_mentioned',
        evidence_refs: [],
      },
      {
        field_key: 'unknown.rejected',
        label: '已拒绝事实',
        status: 'unknown',
        reason_code: 'unclear',
        evidence_refs: [],
      },
    ],
  },
  factReviews: [
    { field_key: 'supported.confirmed', status: 'confirmed' },
    { field_key: 'unknown.confirmed', status: 'confirmed' },
    { field_key: 'unknown.rejected', status: 'rejected' },
  ],
}).projection;
assert.equal(authorityFixture.report.key_facts.length, 2);
const confirmedUnknown = authorityFixture.report.key_facts.find((fact) => fact.field_key === 'unknown.confirmed');
assert.equal(confirmedUnknown.status, 'unknown');
assert.deepEqual(confirmedUnknown.evidence_refs, []);
assert.equal(confirmedUnknown.reason_code, 'not_mentioned');
assert.equal(
  authorityFixture.report.key_facts.some((fact) => fact.field_key === 'unknown.rejected'),
  false,
);
assert.equal(authorityFixture.fact_reviews.length, 3);

function reportFixture(materialId, options = {}) {
  const withFact = options.withFact !== false;
  return {
    schema_version: 'interview_report_v1',
    summary: {
      id: 'summary.main',
      status: 'supported',
      text: '候选人描述了可核验的项目经历。',
      evidence_refs: evidence(materialId),
    },
    match_points: [{
      id: 'match.project',
      status: 'supported',
      text: '有项目复盘证据。',
      evidence_refs: evidence(materialId, 2, 12),
    }],
    risks: [{
      id: 'risk.metric',
      status: 'supported',
      text: '结果指标仍需进一步核实。',
      evidence_refs: evidence(materialId, 4, 16),
    }],
    unknowns: [{
      id: 'unknown.team',
      status: 'unknown',
      text: '团队规模未提及。',
      reason_code: 'not_mentioned',
      evidence_refs: [],
    }],
    followup_questions: [{
      id: 'question.metric',
      status: 'supported',
      question: '请补充说明项目结果指标的计算口径。',
      evidence_refs: evidence(materialId, 4, 16),
    }],
    key_facts: withFact ? [{
      field_key: 'project_result',
      label: '项目结果',
      status: 'supported',
      value: '完成项目上线',
      evidence_refs: evidence(materialId, 0, 20),
    }] : [],
    human_confirm_required: true,
    disclaimer: REPORT_DISCLAIMER,
  };
}

function validateSyntheticTimeSpan(ranges, startMs, endMs) {
  const report = reportFixture(1, { withFact: false });
  report.summary.evidence_refs = [{
    material_id: 1,
    span: { type: 'time_span', start_ms: startMs, end_ms: endMs },
  }];
  return validateInterviewReport(report, {
    sessionId: 1,
    resolveMaterial: () => ({
      session_id: 1,
      text: '用于严格时间轴覆盖校验的纯合成长文本材料。',
      time_ranges: ranges,
    }),
  });
}

assert.doesNotThrow(() => validateSyntheticTimeSpan(
  [{ start_ms: 100, end_ms: 900 }],
  100,
  900,
), 'a span fully covered by one cue must pass');
assert.doesNotThrow(() => validateSyntheticTimeSpan(
  [{ start_ms: 100, end_ms: 500 }, { start_ms: 500, end_ms: 900 }],
  200,
  800,
), 'head-to-tail continuous cues must merge into one coverage interval');
assert.doesNotThrow(() => validateSyntheticTimeSpan(
  [{ start_ms: 500, end_ms: 1000 }, { start_ms: 100, end_ms: 600 }],
  200,
  900,
), 'sorted overlapping cues must merge into one coverage interval');
expectCode(() => validateSyntheticTimeSpan([], 100, 200), 'EVIDENCE_TIME_UNAVAILABLE', '$.summary.evidence_refs[0].span');
expectCode(() => validateSyntheticTimeSpan(
  [{ start_ms: 100, end_ms: 900 }],
  50,
  150,
), 'EVIDENCE_SPAN_OUT_OF_RANGE', '$.summary.evidence_refs[0].span');
expectCode(() => validateSyntheticTimeSpan(
  [{ start_ms: 100, end_ms: 900 }],
  800,
  950,
), 'EVIDENCE_SPAN_OUT_OF_RANGE', '$.summary.evidence_refs[0].span');
expectCode(() => validateSyntheticTimeSpan(
  [{ start_ms: 100, end_ms: 400 }, { start_ms: 600, end_ms: 900 }],
  450,
  550,
), 'EVIDENCE_SPAN_OUT_OF_RANGE', '$.summary.evidence_refs[0].span');
expectCode(() => validateSyntheticTimeSpan(
  [{ start_ms: 100, end_ms: 400 }, { start_ms: 600, end_ms: 900 }],
  300,
  700,
), 'EVIDENCE_SPAN_OUT_OF_RANGE', '$.summary.evidence_refs[0].span');
expectCode(() => validateSyntheticTimeSpan(
  [{ start_ms: 100, end_ms: 400 }],
  50,
  450,
), 'EVIDENCE_SPAN_OUT_OF_RANGE', '$.summary.evidence_refs[0].span');
expectCode(() => validateSyntheticTimeSpan(
  [
    { start_ms: 0, end_ms: 1000.5 },
    { start_ms: 900, end_ms: 400 },
    { start_ms: '0', end_ms: 2000 },
    { start_ms: -100, end_ms: 500 },
    { start_ms: 3000, end_ms: 3500 },
  ],
  100,
  200,
), 'EVIDENCE_SPAN_OUT_OF_RANGE', '$.summary.evidence_refs[0].span');

const database = db.openDb(DB_PATH);
applyF008InterviewReportMigration(database);
applyF008InterviewReportMigration(database);

const job = db.upsertJob({
  encrypt_job_id: 'f008-job',
  numeric_job_id: '980000000001',
  name: 'F008 合成岗位',
  hr_owner: 'HR-SYNTHETIC',
});
const candidate = db.upsertCandidate({
  job_id: job.id,
  geek_id: 'f008-geek-1',
  source: 'synthetic_f008',
  name: 'F008 合成候选人',
});
const otherCandidate = db.upsertCandidate({
  job_id: job.id,
  geek_id: 'f008-geek-2',
  source: 'synthetic_f008',
  name: 'F008 另一合成候选人',
});
const noteCandidate = db.upsertCandidate({
  job_id: job.id,
  geek_id: 'f008-geek-3',
  source: 'synthetic_f008',
  name: 'F008 无录音笔记候选人',
});
database.prepare(`UPDATE candidate SET sabc = 'A', quality_score = 88, disposition_status = '待面试' WHERE internal_id = ?`).run(candidate.internal_id);
const protectedBefore = database.prepare('SELECT sabc, quality_score, disposition_status FROM candidate WHERE internal_id = ?').get(candidate.internal_id);

const offlineText = '候选人说明完成项目上线并复盘指标口径，团队规模没有在本次面试中提到。';
const recording = db.createInterviewRecording(writeOfflineMaterial('offline-main', offlineText));
db.bindInterviewRecording({ id: recording.id, candidateId: candidate.internal_id, jobId: job.id });
const offlineSession = db.createInterviewSession({
  candidateId: candidate.internal_id,
  jobId: job.id,
  round: 1,
  mode: 'offline',
  status: 'pending_review',
});
const offlineMaterial = db.linkInterviewSessionRecording({
  sessionId: offlineSession.id,
  recordingId: recording.id,
  linkedBy: 'HR-SYNTHETIC',
});

const online = adapters.ingestOnlineMinutes({
  jobId: job.id,
  sourceUrl: 'https://example.test/minutes/F008Online001',
  transcript: '另一场合成面试材料，用于跨 session 和驳回查询测试。',
  candidateId: otherCandidate.internal_id,
  round: 1,
  actor: 'HR-SYNTHETIC',
  reason: 'explicit_candidate_context',
  requestId: 'f008-online-assign-1',
});
const onlineMaterial = database.prepare('SELECT * FROM interview_session_material WHERE session_id = ?').get(online.session.id);

const validReport = reportFixture(offlineMaterial.id);
let saved = db.saveInterviewReportV1({
  sessionId: offlineSession.id,
  report: validReport,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 0,
  requestId: 'f008-save-valid-1',
});
assert.equal(saved.status, 'draft');
assert.equal(saved.version, 1);
assert.equal(saved.schema_version, 'interview_report_v1');
assert.equal(saved.report.summary.text, validReport.summary.text);
assert.equal(db.listInterviewReportFactReviews({ sessionId: offlineSession.id })[0].status, 'pending_review');

const saveReplay = db.saveInterviewReportV1({
  sessionId: offlineSession.id,
  report: validReport,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 0,
  requestId: 'f008-save-valid-1',
});
assert.equal(saveReplay.idempotent_replay, true);
assert.equal(saveReplay.version, 1);
expectCode(() => db.saveInterviewReportV1({
  sessionId: offlineSession.id,
  report: { ...validReport, summary: { ...validReport.summary, text: '不同请求正文' } },
  actor: 'HR-SYNTHETIC',
  expectedVersion: 0,
  requestId: 'f008-save-valid-1',
}), 'IDEMPOTENCY_CONFLICT', '$.request_id');
expectCode(() => db.saveInterviewReportV1({
  sessionId: offlineSession.id,
  report: validReport,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 0,
  requestId: 'f008-save-stale-1',
}), 'STALE_VERSION', '$.expected_version');

const invalidCases = [
  ['INVALID_JSON', '{not json', '$'],
  ['ADDITIONAL_PROPERTY', { ...validReport, extra: true }, '$.extra'],
  ['TYPE_MISMATCH', { ...validReport, risks: 'wrong' }, '$.risks'],
  ['UNKNOWN_REASON_REQUIRED', { ...validReport, unknowns: [{ id: 'unknown.x', status: 'unknown', text: '未知', evidence_refs: [] }] }, '$.unknowns[0].reason_code'],
  ['UNKNOWN_REASON_INVALID', { ...validReport, unknowns: [{ id: 'unknown.x', status: 'unknown', text: '未知', reason_code: 'model_guess', evidence_refs: [] }] }, '$.unknowns[0].reason_code'],
  ['EVIDENCE_REQUIRED', { ...validReport, summary: { ...validReport.summary, evidence_refs: [] } }, '$.summary.evidence_refs'],
  ['EVIDENCE_MATERIAL_DANGLING', { ...validReport, summary: { ...validReport.summary, evidence_refs: evidence(999999) } }, '$.summary.evidence_refs[0].material_id'],
  ['EVIDENCE_CROSS_SESSION', { ...validReport, summary: { ...validReport.summary, evidence_refs: evidence(onlineMaterial.id) } }, '$.summary.evidence_refs[0].material_id'],
  ['EVIDENCE_SPAN_OUT_OF_RANGE', { ...validReport, summary: { ...validReport.summary, evidence_refs: evidence(offlineMaterial.id, 0, 99999) } }, '$.summary.evidence_refs[0].span'],
  ['FORBIDDEN_FIELD', { ...validReport, nested: { 婚育: 'SECRET-SENSITIVE-VALUE' } }, '$.nested.婚育'],
  ['FORBIDDEN_FIELD', { ...validReport, summary: { ...validReport.summary, date_of_birth: 'SECRET-SENSITIVE-VALUE' } }, '$.summary.date_of_birth'],
  ['FORBIDDEN_FIELD', { ...validReport, summary: { ...validReport.summary, disability_status: 'SECRET-SENSITIVE-VALUE' } }, '$.summary.disability_status'],
  ['FORBIDDEN_FIELD', { ...validReport, summary: { ...validReport.summary, political_affiliation: 'SECRET-SENSITIVE-VALUE' } }, '$.summary.political_affiliation'],
  ['FORBIDDEN_FIELD', { ...validReport, key_facts: [{ field_key: 'candidate_age', label: '不当字段', status: 'unknown', reason_code: 'not_mentioned', evidence_refs: [] }] }, '$.key_facts[0].field_key'],
  ['FORBIDDEN_FIELD', { ...validReport, key_facts: [{ field_key: 'other_fact', label: '性别', status: 'unknown', reason_code: 'not_mentioned', evidence_refs: [] }] }, '$.key_facts[0].label'],
  ['FORBIDDEN_DECISION_FIELD', { ...validReport, quality_score: 99 }, '$.quality_score'],
];
for (const [code, report, pathPrefix] of invalidCases) {
  const error = expectCode(() => db.saveInterviewReportV1({
    sessionId: offlineSession.id,
    report,
    actor: 'HR-SYNTHETIC',
    expectedVersion: 1,
    requestId: `f008-invalid-${code}-${pathPrefix}`.replace(/[^A-Za-z0-9_.:-]/g, '-'),
  }), code, pathPrefix);
  assert.equal(`${error.message}:${error.code}:${error.path}`.includes('SECRET-SENSITIVE-VALUE'), false, 'errors must not echo sensitive values');
}
assert.equal(database.prepare('SELECT version FROM interview_report_v1 WHERE session_id = ?').get(offlineSession.id).version, 1, 'failed saves must be atomic');

expectCode(() => db.confirmInterviewReportV1({
  sessionId: offlineSession.id,
  confirmed: true,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 1,
  requestId: 'f008-confirm-pending-report-fact',
}), 'PENDING_FACTS', '$.key_facts');
assert.equal(db.getInterviewReportV1({ sessionId: offlineSession.id }).status, 'draft');

expectCode(() => db.reviewInterviewReportFacts({
  sessionId: offlineSession.id,
  items: [
    { field_key: 'project_result', status: 'confirmed' },
    { field_key: 'missing_fact', status: 'confirmed' },
  ],
  actor: 'HR-SYNTHETIC',
  expectedVersion: 1,
  requestId: 'f008-review-fact-atomic-failure',
}), 'FACT_NOT_FOUND', '$.items[1].field_key');
assert.equal(db.listInterviewReportFactReviews({ sessionId: offlineSession.id })[0].status, 'pending_review', 'failed fact-review batch must roll back earlier updates');

let reviewed = db.reviewInterviewReportFacts({
  sessionId: offlineSession.id,
  items: [{ field_key: 'project_result', status: 'confirmed' }],
  actor: 'HR-SYNTHETIC',
  expectedVersion: 1,
  requestId: 'f008-review-fact-1',
});
assert.equal(reviewed.report.version, 2);
assert.equal(reviewed.facts[0].status, 'confirmed');
const reviewReplay = db.reviewInterviewReportFacts({
  sessionId: offlineSession.id,
  items: [{ field_key: 'project_result', status: 'confirmed' }],
  actor: 'HR-SYNTHETIC',
  expectedVersion: 1,
  requestId: 'f008-review-fact-1',
});
assert.equal(reviewReplay.report.idempotent_replay, true);

const reviewedFactRow = database.prepare('SELECT * FROM interview_report_fact_review WHERE report_id = ?').get(saved.id);
database.prepare('DELETE FROM interview_report_fact_review WHERE id = ?').run(reviewedFactRow.id);
expectCode(() => db.confirmInterviewReportV1({
  sessionId: offlineSession.id,
  confirmed: true,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 2,
  requestId: 'f008-confirm-missing-fact-review',
}), 'FACT_REVIEW_MISSING', '$.key_facts');
database.prepare(`
  INSERT INTO interview_report_fact_review (
    id, report_id, field_key, fact_hash, status, corrected_value,
    reviewed_by, reviewed_at, version, created_at, updated_at
  ) VALUES (
    @id, @report_id, @field_key, @fact_hash, @status, @corrected_value,
    @reviewed_by, @reviewed_at, @version, @created_at, @updated_at
  )
`).run(reviewedFactRow);

db.saveInterviewRecordingConfirmations({
  recordingId: recording.id,
  items: [{
    field_key: 'legacy_arrival_time',
    field_label: '到岗时间',
    extracted_value: '两周',
    status: 'pending',
  }],
});
expectCode(() => db.confirmInterviewReportV1({
  sessionId: offlineSession.id,
  confirmed: true,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 2,
  requestId: 'f008-confirm-pending-legacy-fact',
}), 'PENDING_FACTS', '$.key_facts');
db.saveInterviewRecordingConfirmations({
  recordingId: recording.id,
  items: [{
    field_key: 'legacy_arrival_time',
    field_label: '到岗时间',
    extracted_value: '两周',
    status: 'confirmed',
  }],
});

const storedJson = database.prepare('SELECT report_json FROM interview_report_v1 WHERE session_id = ?').get(offlineSession.id).report_json;
const hashMismatch = JSON.parse(storedJson);
hashMismatch.summary.text = '仍然符合 Schema、但没有推进版本的篡改。';
database.prepare('UPDATE interview_report_v1 SET report_json = ? WHERE session_id = ?').run(JSON.stringify(hashMismatch), offlineSession.id);
expectCode(() => db.confirmInterviewReportV1({
  sessionId: offlineSession.id,
  confirmed: true,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 2,
  requestId: 'f008-confirm-content-hash-mismatch',
}), 'REPORT_CONTENT_HASH_MISMATCH', '$');
database.prepare('UPDATE interview_report_v1 SET report_json = ? WHERE session_id = ?').run(storedJson, offlineSession.id);
const corrupted = JSON.parse(storedJson);
corrupted.summary.gender = 'SECRET-SENSITIVE-VALUE';
database.prepare('UPDATE interview_report_v1 SET report_json = ? WHERE session_id = ?').run(JSON.stringify(corrupted), offlineSession.id);
const independentError = expectCode(() => db.confirmInterviewReportV1({
  sessionId: offlineSession.id,
  confirmed: true,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 2,
  requestId: 'f008-confirm-independent-validation',
}), 'FORBIDDEN_FIELD', '$.summary.gender');
assert.equal(independentError.message.includes('SECRET-SENSITIVE-VALUE'), false);
database.prepare('UPDATE interview_report_v1 SET report_json = ? WHERE session_id = ?').run(storedJson, offlineSession.id);

let confirmed = db.confirmInterviewReportV1({
  sessionId: offlineSession.id,
  confirmed: true,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 2,
  requestId: 'f008-confirm-valid-1',
});
assert.equal(confirmed.status, 'confirmed');
assert.equal(confirmed.version, 3);
assert.equal(db.getInterviewSession(offlineSession.id).status, 'confirmed');
assert.equal(db.getInterviewRecording(recording.id).status, 'confirmed');
const officialReports = db.listOfficialInterviewReports({ sessionId: offlineSession.id });
assert.equal(officialReports.length, 1);
assert.equal(officialReports[0].fact_reviews[0].status, 'confirmed', 'official query must carry the human-reviewed key fact state');
confirmed = db.confirmInterviewReportV1({
  sessionId: offlineSession.id,
  confirmed: true,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 2,
  requestId: 'f008-confirm-valid-1',
});
assert.equal(confirmed.idempotent_replay, true);
expectCode(() => db.saveInterviewReportV1({
  sessionId: offlineSession.id,
  report: validReport,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 3,
  requestId: 'f008-save-after-confirm',
}), 'REPORT_READ_ONLY', '$.status');

const onlineReport = reportFixture(onlineMaterial.id, { withFact: false });
const onlineSaved = db.saveInterviewReportV1({
  sessionId: online.session.id,
  report: onlineReport,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 0,
  requestId: 'f008-save-online-1',
});
const rejected = db.rejectInterviewReportV1({
  sessionId: online.session.id,
  rejected: true,
  actor: 'HR-SYNTHETIC',
  expectedVersion: onlineSaved.version,
  requestId: 'f008-reject-online-1',
});
assert.equal(rejected.status, 'rejected');
assert.equal(db.listOfficialInterviewReports({ sessionId: online.session.id }).length, 0, 'rejected reports must not enter official queries');

const timedRecording = db.createInterviewRecording(writeOfflineMaterial('offline-timed', '时间轴证据用于纯合成校验，并确保文本区间长度足够。'));
db.bindInterviewRecording({ id: timedRecording.id, candidateId: otherCandidate.internal_id, jobId: job.id });
const timedSession = db.createInterviewSession({
  candidateId: otherCandidate.internal_id,
  jobId: job.id,
  round: 2,
  mode: 'offline',
  status: 'pending_review',
});
const timedMaterial = db.linkInterviewSessionRecording({ sessionId: timedSession.id, recordingId: timedRecording.id, linkedBy: 'HR-SYNTHETIC' });
const timedReport = reportFixture(timedMaterial.id, { withFact: false });
timedReport.summary.evidence_refs = [{ material_id: timedMaterial.id, span: { type: 'time_span', start_ms: 200, end_ms: 1800 } }];
const timedSaved = db.saveInterviewReportV1({
  sessionId: timedSession.id,
  report: timedReport,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 0,
  requestId: 'f008-save-timed-1',
});
assert.equal(timedSaved.status, 'draft');
const timeUnavailable = reportFixture(onlineMaterial.id, { withFact: false });
timeUnavailable.summary.evidence_refs = [{ material_id: onlineMaterial.id, span: { type: 'time_span', start_ms: 0, end_ms: 1000 } }];
expectCode(() => db.saveInterviewReportV1({
  sessionId: online.session.id,
  report: timeUnavailable,
  actor: 'HR-SYNTHETIC',
  expectedVersion: rejected.version,
  requestId: 'f008-online-time-unavailable',
}), 'EVIDENCE_TIME_UNAVAILABLE', '$.summary.evidence_refs[0].span');

const legacyMaterial = writeOfflineMaterial('offline-legacy', '纯合成 legacy 报告材料。');
const legacyRecording = db.createInterviewRecording(legacyMaterial);
db.bindInterviewRecording({ id: legacyRecording.id, candidateId: candidate.internal_id, jobId: job.id });
const legacySession = db.createInterviewSession({
  candidateId: candidate.internal_id,
  jobId: job.id,
  round: 2,
  mode: 'offline',
  status: 'pending_review',
});
db.linkInterviewSessionRecording({ sessionId: legacySession.id, recordingId: legacyRecording.id, linkedBy: 'HR-SYNTHETIC' });
database.prepare(`
  INSERT INTO interview_ai_report (
    recording_id, candidate_id, job_id, status, report_json,
    confirmed_at, created_at, updated_at
  ) VALUES (?, ?, ?, 'confirmed', ?, ?, ?, ?)
`).run(
  legacyRecording.id,
  candidate.internal_id,
  job.id,
  JSON.stringify({ summary: 'legacy loose report', quality_score: 100 }),
  '2026-07-11T09:10:00.000Z',
  '2026-07-11T09:10:00.000Z',
  '2026-07-11T09:10:00.000Z',
);
const legacy = db.getInterviewReportForRecording(legacyRecording.id);
assert.equal(legacy.status, 'legacy_unvalidated');
assert.equal(legacy.schema_version, 'legacy_unvalidated');
assert.equal(legacy.read_only, true);
assert.equal(legacy.confirmed_at, null);
expectCode(() => db.confirmInterviewReportForRecording({
  id: legacyRecording.id,
  confirmed: true,
  actor: 'HR-SYNTHETIC',
  expectedVersion: 0,
  requestId: 'f008-confirm-legacy-blocked',
}), 'REPORT_NOT_FOUND', '$.session_id');

const noteSession = db.createInterviewSession({
  candidateId: noteCandidate.internal_id,
  jobId: job.id,
  round: 1,
  mode: 'offline',
  status: 'draft',
});
let manualNote = db.saveInterviewManualNote({
  sessionId: noteSession.id,
  body: '候选人说明可以两周到岗，曾独立完成合成项目复盘；薪资仍待下一轮核实。',
  actor: 'HR-SYNTHETIC',
  expectedVersion: 0,
});
assert.equal(manualNote.source_type, 'manual_note');
assert.equal(manualNote.accuracy_label, 'HR 人工面试笔记（非 ASR）');
assert.equal(manualNote.version, 1);
assert.equal(db.getInterviewSession(noteSession.id).materials.length, 1, 'manual note must become a selectable session material without fake recording');

let manualDraft = db.saveStructuredManualInterviewReport({
  sessionId: noteSession.id,
  materialIds: [manualNote.material_id],
  summary: '候选人提供了到岗与项目复盘信息。',
  hardRequirements: [{ label: '到岗周期', status: 'met', text: '可以两周到岗' }],
  competencies: ['能够独立完成项目复盘'],
  motivation: '希望继续承担完整项目',
  risks: ['薪资尚未核实'],
  contradictions: ['薪资口径缺少材料确认'],
  unknowns: ['最终薪资期望'],
  followupQuestions: ['请确认最终薪资期望'],
  keyFacts: [
    { label: '到岗周期', value: '两周' },
    { label: '薪资期望', value: '待补充' },
    { label: '项目角色', value: '独立负责' },
  ],
  actor: 'HR-SYNTHETIC',
  expectedVersion: 0,
  requestId: 'f008-manual-structured-save-1',
});
assert.equal(manualDraft.status, 'draft');
assert.equal(manualDraft.source_snapshot.tracked, true);
assert.equal(manualDraft.stale, false);

manualNote = db.saveInterviewManualNote({
  sessionId: noteSession.id,
  body: '候选人更正：可以三周到岗，曾独立完成合成项目复盘；薪资仍待下一轮核实。',
  actor: 'HR-SYNTHETIC',
  expectedVersion: 1,
});
assert.equal(manualNote.version, 2);
assert.equal(db.getInterviewReportV1({ sessionId: noteSession.id }).stale, true, 'material change must mark existing draft stale');
expectCode(() => db.confirmInterviewReportV1({
  sessionId: noteSession.id,
  confirmed: true,
  actor: 'HR-SYNTHETIC',
  expectedVersion: manualDraft.version,
  requestId: 'f008-manual-stale-confirm-blocked',
}), 'REPORT_SOURCES_STALE', '$.source_snapshot');

manualDraft = db.saveStructuredManualInterviewReport({
  sessionId: noteSession.id,
  materialIds: [manualNote.material_id],
  summary: '候选人更正了到岗周期，并提供项目复盘信息。',
  hardRequirements: [{ label: '到岗周期', status: 'met', text: '可以三周到岗' }],
  competencies: ['能够独立完成项目复盘'],
  motivation: '希望继续承担完整项目',
  risks: ['薪资尚未核实'],
  contradictions: ['薪资口径缺少材料确认'],
  unknowns: ['最终薪资期望'],
  followupQuestions: ['请确认最终薪资期望'],
  keyFacts: [
    { label: '到岗周期', value: '三周' },
    { label: '薪资期望', value: '待补充' },
    { label: '项目角色', value: '独立负责' },
  ],
  actor: 'HR-SYNTHETIC',
  expectedVersion: manualDraft.version,
  requestId: 'f008-manual-structured-save-2',
});
assert.equal(manualDraft.stale, false, 'regeneration must refresh the source snapshot');
database.prepare(`
  INSERT INTO field_annotation (
    candidate_id, target_ref, kind, value, author_role, author, created_at
  ) VALUES (?, '到岗周期', 'confirmed_fact', 'HR 新确认了候选人到岗上下文', 'HR', 'HR-SYNTHETIC', ?)
`).run(noteCandidate.internal_id, new Date().toISOString());
assert.equal(db.getInterviewReportV1({ sessionId: noteSession.id }).stale, true, 'confirmed context change must mark the draft stale');
expectCode(() => db.confirmInterviewReportV1({
  sessionId: noteSession.id,
  confirmed: true,
  actor: 'HR-SYNTHETIC',
  expectedVersion: manualDraft.version,
  requestId: 'f008-manual-context-stale-confirm-blocked',
}), 'REPORT_SOURCES_STALE', '$.source_snapshot');
manualDraft = db.saveInterviewReportV1({
  sessionId: noteSession.id,
  report: manualDraft.report,
  sourceMaterialIds: [manualNote.material_id],
  actor: 'HR-SYNTHETIC',
  expectedVersion: manualDraft.version,
  requestId: 'f008-manual-context-refresh',
});
assert.equal(manualDraft.stale, false, 'saving against current confirmed context must recover the draft');
let manualReview = db.reviewInterviewReportFacts({
  sessionId: noteSession.id,
  items: [
    { field_key: 'fact.01', status: 'corrected', corrected_value: '三周（HR 已电话核对）' },
    { field_key: 'fact.02', status: 'unknown' },
    { field_key: 'fact.03', status: 'rejected' },
  ],
  actor: 'HR-SYNTHETIC',
  expectedVersion: manualDraft.version,
  requestId: 'f008-manual-fact-corrected',
});
const manualConfirmed = db.confirmInterviewReportV1({
  sessionId: noteSession.id,
  confirmed: true,
  actor: 'HR-SYNTHETIC',
  expectedVersion: manualReview.report.version,
  requestId: 'f008-manual-confirmed',
});
assert.equal(manualConfirmed.report.key_facts.length, 1);
assert.equal(manualConfirmed.report.key_facts[0].value, '三周（HR 已电话核对）', 'authoritative projection must use corrected_value');
assert.equal(manualConfirmed.confirmed_projection.fact_reviews[0].status, 'corrected');
assert.deepEqual(
  manualConfirmed.confirmed_projection.fact_reviews.map((item) => item.status),
  ['corrected', 'unknown', 'rejected'],
  'projection audit must retain every HR review while excluding non-authoritative facts',
);
assert.ok(database.prepare('SELECT 1 FROM interview_report_confirmed_projection WHERE report_id = ?').get(manualConfirmed.id));
const manualOfficial = db.listOfficialInterviewReports({ sessionId: noteSession.id })[0];
assert.equal(manualOfficial.report.key_facts[0].value, '三周（HR 已电话核对）', 'official downstream query must use authoritative projection');
manualNote = db.revokeInterviewManualNote({
  sessionId: noteSession.id,
  expectedVersion: manualNote.version,
  confirmed: true,
  actor: 'HR-SYNTHETIC',
});
assert.equal(manualNote.status, 'revoked');
assert.equal(manualNote.body.includes('三周到岗'), true, 'revocation must preserve the last human-authored body');
assert.equal(db.listInterviewManualNoteRevisions({ sessionId: noteSession.id }).length, 3);

assert.deepEqual(
  database.prepare('SELECT sabc, quality_score, disposition_status FROM candidate WHERE internal_id = ?').get(candidate.internal_id),
  protectedBefore,
  'report save/review/confirm/reject must not mutate SABC, quality_score, or candidate disposition',
);
const talentPool = db.listTalentPool({ jobId: job.id });
const confirmedTalent = talentPool.talents.find((item) => item.name === 'F008 合成候选人');
const rejectedTalent = talentPool.talents.find((item) => item.name === 'F008 另一合成候选人');
assert.ok(confirmedTalent.history.some((item) => item.has_interview_report), 'confirmed v1 report must enter the formal talent timeline');
assert.equal(rejectedTalent.history.some((item) => item.has_interview_report), false, 'rejected/draft reports must not become formal timeline conclusions');
assert.deepEqual(database.pragma('foreign_key_check'), []);
database.close();
console.log('check-f008-interview-report ok');
