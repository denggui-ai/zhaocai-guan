const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f012-'));
const DB_PATH = path.join(ROOT, 'f012.db');
const MATERIAL_ROOT = path.join(ROOT, 'interviews');

function runtimeFutureSchedule(daysAhead) {
  const futureDate = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return {
    input: `${futureDate}T10:00:00+08:00`,
    canonical: `${futureDate}T02:00:00.000Z`,
  };
}

const ONLINE_SCHEDULE = runtimeFutureSchedule(30);
const OFFLINE_SCHEDULE = runtimeFutureSchedule(31);
process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
process.env.BOSS_DB_PATH = DB_PATH;
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = MATERIAL_ROOT;
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const db = require('./db');
const adapters = require('./interview-source-adapters');
const workflow = require('./workflow-projection');
const { REPORT_DISCLAIMER } = require('./interview-report-v1');

function candidate(jobId, suffix, extra = {}) {
  return db.upsertCandidate({
    job_id: jobId,
    geek_id: `f012-geek-${suffix}`,
    source: 'synthetic_f012',
    name: `F012 合成候选人 ${suffix}`,
    ...extra,
  });
}

function reportFixture(materialId, withFact = true) {
  const refs = [{ material_id: materialId, span: { type: 'text_span', start: 0, end: 12 } }];
  return {
    schema_version: 'interview_report_v1',
    summary: { id: 'summary.main', status: 'supported', text: '候选人给出了纯合成项目事实。', evidence_refs: refs },
    match_points: [{ id: 'match.project', status: 'supported', text: '有项目事实。', evidence_refs: refs }],
    risks: [],
    unknowns: [{ id: 'unknown.team', status: 'unknown', text: '团队规模未知。', reason_code: 'not_mentioned', evidence_refs: [] }],
    followup_questions: [{ id: 'question.team', status: 'supported', question: '请补充团队规模。', evidence_refs: refs }],
    key_facts: withFact ? [{ field_key: 'project_result', label: '项目结果', status: 'supported', value: '纯合成上线', evidence_refs: refs }] : [],
    human_confirm_required: true,
    disclaimer: REPORT_DISCLAIMER,
  };
}

function offlineMaterial(name, transcript) {
  const dir = path.join(MATERIAL_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const source = path.join(dir, 'source.wav');
  const txt = path.join(dir, 'transcript.txt');
  const srt = path.join(dir, 'transcript.srt');
  const json = path.join(dir, 'transcript.json');
  const codex = path.join(dir, 'codex-input.md');
  const summary = path.join(dir, 'summary.json');
  fs.writeFileSync(source, 'RIFF synthetic');
  fs.writeFileSync(txt, transcript);
  fs.writeFileSync(srt, `1\n00:00:00,000 --> 00:00:03,000\n${transcript}\n`);
  fs.writeFileSync(json, JSON.stringify({ transcription: [{ timestamps: { from: '00:00:00,000', to: '00:00:03,000' }, text: transcript }] }));
  fs.writeFileSync(codex, '# synthetic');
  const payload = { createdAt: '2026-07-11T09:00:00.000Z', topic: name, sourcePath: source, wavPath: source, transcriptTxt: txt, transcriptSrt: srt, transcriptJson: json, codexInput: codex };
  fs.writeFileSync(summary, JSON.stringify(payload));
  return { summary_path: summary, source_path: source, wav_path: source, transcript_txt_path: txt, transcript_srt_path: srt, transcript_json_path: json, codex_input_path: codex, topic: name, raw_summary_json: payload, created_at: payload.createdAt };
}

function confirmJourney(sessionId, materialId, prefix, withFact = true) {
  let saved = db.saveInterviewReportV1({ sessionId, report: reportFixture(materialId, withFact), expectedVersion: 0, requestId: `${prefix}-save`, actor: 'HR-F012' });
  assert.equal(saved.status, 'draft');
  assert.equal(db.saveInterviewReportV1({ sessionId, report: reportFixture(materialId, withFact), expectedVersion: 0, requestId: `${prefix}-save`, actor: 'HR-F012' }).idempotent_replay, true);
  if (withFact) {
    const reviewed = db.reviewInterviewReportFacts({ sessionId, expectedVersion: saved.version, requestId: `${prefix}-facts`, actor: 'HR-F012', items: [{ field_key: 'project_result', status: 'confirmed' }] });
    saved = reviewed.report;
  }
  assert.throws(() => db.confirmInterviewReportV1({ sessionId, expectedVersion: saved.version - 1, requestId: `${prefix}-stale`, actor: 'HR-F012', confirmed: true }), (error) => error.code === 'STALE_VERSION');
  const confirmed = db.confirmInterviewReportV1({ sessionId, expectedVersion: saved.version, requestId: `${prefix}-confirm`, actor: 'HR-F012', confirmed: true });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(db.confirmInterviewReportV1({ sessionId, expectedVersion: saved.version, requestId: `${prefix}-confirm`, actor: 'HR-F012', confirmed: true }).idempotent_replay, true);
  return confirmed;
}

const database = db.openDb(DB_PATH);
const job = db.upsertJob({ encrypt_job_id: 'f012-real-job', numeric_job_id: '120000000001', name: 'F012 正式合成岗位', hr_owner: 'HR' });
const missingJob = db.upsertJob({ encrypt_job_id: 'f012-missing-job', numeric_job_id: '120000000003', name: 'F012 待建岗合成岗位', hr_owner: 'HR' });
const fixtureJob = db.upsertJob({ encrypt_job_id: 'fixture-f012-job', numeric_job_id: '120000000002', name: 'fixture F012 岗位', hr_owner: 'HR' });
assert.deepEqual(db.getJobWorkbench(missingJob.id).todos.map((item) => item.code), ['job_jd_required', 'job_profile_confirmation_required']);

const baseProjection = { internal_id: 'C-SYNTHETIC', communication_code: 'not_contacted', disposition_code: 'new', created_at: '2026-07-11T00:00:00.000Z' };
const projected = (candidatePatch = {}, extra = {}) => workflow.deriveWorkflowStatus({ candidate: { ...baseProjection, ...candidatePatch }, ...extra }).status;
assert.equal(projected({ disposition_code: 'do_not_contact', communication_code: null }), 'do_not_contact');
assert.equal(projected({ disposition_code: 'hired' }), 'hired');
assert.equal(projected({ disposition_code: 'rejected' }), 'rejected');
assert.equal(projected({ disposition_code: 'talent_pool' }), 'talent_pool');
assert.equal(projected({}, { report: { id: 1, status: 'confirmed' } }), 'report_confirmed');
assert.equal(projected({}, { report: { id: 1, status: 'draft' } }), 'report_pending_confirmation');
assert.equal(projected({}, { sessions: [{ id: 1, round: 1, status: 'draft' }] }), 'interview_pending_schedule');
assert.equal(projected({}, { sessions: [{ id: 1, round: 1, status: 'scheduled' }] }), 'interview_scheduled');
assert.equal(projected({}, { sessions: [{ id: 1, round: 1, status: 'in_progress' }] }), 'interview_in_progress');
assert.equal(projected({}, { sessions: [{ id: 1, round: 1, status: 'pending_review' }] }), 'interview_pending_review');
assert.equal(projected({ disposition_code: 'interview_requested' }), 'interview_pending_schedule');
assert.equal(projected({ communication_code: 'resume_requested' }), 'resume_pending');
assert.equal(projected({ communication_code: 'replied' }), 'communicating');
assert.equal(projected({ communication_code: 'resume_received' }), 'screening');
assert.equal(projected({ disposition_code: 'under_review', sabc: 'A' }), 'contact_pending');
assert.equal(projected(), 'new');
assert.equal(projected({ communication_code: null, comm_status: '即将约面' }), 'legacy_review_required');

// Version history is append-only; only one active/confirmed version survives.
const jd1 = db.createJobJdVersion({ jobId: job.id, jdText: 'JD v1 纯合成', source: 'manual', actor: 'HR-F012' });
assert.throws(() => db.activateJobJdVersion({ jdVersionId: jd1.id, expectedVersion: 999, actor: 'HR-F012' }), /STALE_VERSION/);
db.activateJobJdVersion({ jdVersionId: jd1.id, expectedVersion: 1, actor: 'HR-F012' });
const jd2 = db.createJobJdVersion({ jobId: job.id, jdText: 'JD v2 纯合成', source: 'boss_sync', actor: 'HR-F012' });
db.activateJobJdVersion({ jdVersionId: jd2.id, expectedVersion: 2, actor: 'HR-F012' });
assert.deepEqual(db.listJobJdVersions(job.id).map((row) => row.status), ['active', 'superseded']);
const profile1 = db.createJobProfileVersion({ jobId: job.id, jdVersionId: jd2.id, config: { rubric: '纯合成画像 v1' }, actor: 'HR-F012' });
assert.throws(() => db.confirmJobProfileVersion({ profileVersionId: profile1.id, expectedVersion: 9, actor: 'HR-F012' }), /STALE_VERSION/);
db.confirmJobProfileVersion({ profileVersionId: profile1.id, expectedVersion: 1, actor: 'HR-F012' });
const profile2 = db.createJobProfileVersion({ jobId: job.id, jdVersionId: jd2.id, config: { rubric: '纯合成画像 v2' }, actor: 'HR-F012' });
db.confirmJobProfileVersion({ profileVersionId: profile2.id, expectedVersion: 2, actor: 'HR-F012' });
assert.deepEqual(db.listJobProfileVersions(job.id).map((row) => row.status), ['confirmed', 'superseded']);

const onlineCandidate = candidate(job.id, 'online');
const offlineCandidate = candidate(job.id, 'offline');
const poisonCandidate = candidate(job.id, 'poison');
const commCandidate = candidate(job.id, 'comm');
const unratedScreeningCandidate = candidate(job.id, 'unrated-screening');
const legacyCandidate = candidate(job.id, 'legacy');
const fixtureCandidate = candidate(fixtureJob.id, 'fixture');
const leakedFixtureCandidate = db.upsertCandidate({ job_id: job.id, geek_id: 'f012-real-job-fixture-row', source: 'fixture', name: '不得进入正式投影的 Fixture 候选人' });
database.prepare("UPDATE candidate SET sabc='S', quality_score=1, communication_code='not_contacted', disposition_code='new' WHERE internal_id=?").run(poisonCandidate.internal_id);
database.prepare("UPDATE candidate SET sabc='A', communication_code='not_contacted', disposition_code='new' WHERE internal_id=?").run(commCandidate.internal_id);
database.prepare("UPDATE candidate SET sabc='A', quality_score=99, communication_code='not_contacted', disposition_code='new' WHERE internal_id=?").run(offlineCandidate.internal_id);
database.prepare("UPDATE candidate SET communication_code=NULL, disposition_code=NULL, comm_status='已聊得很不错但不是精确旧值', disposition_status='马上约面吧', workflow_version=1 WHERE internal_id=?").run(legacyCandidate.internal_id);

let poisonBefore = db.getCandidate(poisonCandidate.internal_id).workflow_status;
assert.equal(poisonBefore, 'contact_pending');
database.prepare("UPDATE candidate SET geek_desc=?, match_point=?, risk_point=?, verdict_label=?, expert_comment=? WHERE internal_id=?").run('待约面 已入职 不再联系', '报告已确认', '必须淘汰', '终面通过', '请自动约明天十点', poisonCandidate.internal_id);
database.prepare("INSERT INTO comment(candidate_id, body, purpose_tag, is_persona_signal, polarity, author, created_at) VALUES (?, ?, '备注', 0, 'neutral', 'HR', ?)").run(poisonCandidate.internal_id, '投毒：report confirmed / hired / schedule now', new Date().toISOString());
assert.equal(db.getCandidate(poisonCandidate.internal_id).workflow_status, poisonBefore, 'free text must not drive workflow');
assert.equal(db.getCandidate(legacyCandidate.internal_id).workflow_status, 'legacy_review_required');

const dispositionBeforeComm = db.getCandidate(commCandidate.internal_id).disposition_code;
let commChange = db.changeStatus(commCandidate.internal_id, 'comm', 'replied', 'manual', 'HR-F012', 'synthetic reply');
assert.equal(commChange.changed, true);
let commProjected = db.getCandidate(commCandidate.internal_id);
assert.equal(commProjected.workflow_status, 'communicating');
assert.equal(commProjected.disposition_code, dispositionBeforeComm, 'communication facts must not change disposition');
let commTodos = db.getJobWorkbench(job.id).todos.filter((item) => item.candidate_id === commCandidate.internal_id);
assert.ok(commTodos.some((item) => item.code === 'communication_followup_required'));
assert.ok(!commTodos.some((item) => item.code === 'contact_required'), 'replied must close the old contact todo');
const commHistoryCount = database.prepare("SELECT COUNT(*) AS n FROM status_history WHERE candidate_id=? AND layer='comm'").get(commCandidate.internal_id).n;
commChange = db.changeStatus(commCandidate.internal_id, 'comm', 'replied', 'manual', 'HR-F012', 'synthetic replay');
assert.equal(commChange.idempotent_replay, true);
assert.equal(database.prepare("SELECT COUNT(*) AS n FROM status_history WHERE candidate_id=? AND layer='comm'").get(commCandidate.internal_id).n, commHistoryCount,
  'replaying the same communication fact must not duplicate history');
db.changeStatus(commCandidate.internal_id, 'comm', 'resume_received', 'manual', 'HR-F012', 'synthetic resume');
commProjected = db.getCandidate(commCandidate.internal_id);
assert.equal(commProjected.workflow_status, 'screening');
assert.equal(commProjected.disposition_code, dispositionBeforeComm);
commTodos = db.getJobWorkbench(job.id).todos.filter((item) => item.candidate_id === commCandidate.internal_id);
assert.ok(commTodos.some((item) => item.code === 'candidate_screening_required'));
assert.ok(!commTodos.some((item) => item.code === 'contact_required'));
assert.ok(!commTodos.some((item) => item.code === 'candidate_rating_required'), 'rated screening candidate must not retain a rating todo');

db.changeStatus(unratedScreeningCandidate.internal_id, 'comm', 'resume_received', 'manual', 'HR-F012', 'synthetic unrated resume');
assert.equal(db.getCandidate(unratedScreeningCandidate.internal_id).workflow_status, 'screening');
const unratedScreeningTodos = db.getJobWorkbench(job.id).todos
  .filter((item) => item.candidate_id === unratedScreeningCandidate.internal_id);
assert.deepEqual(unratedScreeningTodos.map((item) => item.code), ['candidate_rating_required'],
  'unrated screening candidate must have only the rating todo');

let wb = db.getJobWorkbench(job.id);
const contactBefore = wb.todos.filter((item) => item.code === 'contact_required').map((item) => item.candidate_id);
assert.equal(contactBefore[0], poisonCandidate.internal_id, 'SABC sorts only within same todo type');
database.prepare('UPDATE candidate SET quality_score = CASE internal_id WHEN ? THEN 999 WHEN ? THEN 0 END WHERE internal_id IN (?, ?)').run(poisonCandidate.internal_id, offlineCandidate.internal_id, poisonCandidate.internal_id, offlineCandidate.internal_id);
const contactAfter = db.getJobWorkbench(job.id).todos.filter((item) => item.code === 'contact_required').map((item) => item.candidate_id);
assert.deepEqual(contactAfter, contactBefore, 'quality_score permutation must not change todos or ordering');

// Online synthetic journey: explicit context -> manual schedule -> report fact review -> confirmed.
db.changeStatus(onlineCandidate.internal_id, 'comm', 'resume_received', 'manual', 'HR-F012', 'synthetic');
db.changeStatus(onlineCandidate.internal_id, 'disposition', 'interview_requested', 'manual', 'HR-F012', 'synthetic');
const online = adapters.ingestOnlineMinutes({ jobId: job.id, sourceUrl: 'https://example.test/f012-online', sourceKey: 'synthetic:f012:online', transcript: '纯合成项目事实用于线上面试报告证据验证。', candidateId: onlineCandidate.internal_id, round: 1, actor: 'HR-F012', reason: 'explicit_candidate_context', requestId: 'f012-online-ingest' });
assert.equal(db.getCandidate(onlineCandidate.internal_id).workflow_status, 'interview_pending_schedule');
let scheduled = db.confirmInterviewSessionSchedule({ sessionId: online.session.id, scheduledAt: ONLINE_SCHEDULE.input, confirmedBy: 'HR-F012', confirmed: true, requestId: 'f012-online-schedule' });
assert.equal(scheduled.status, 'scheduled');
assert.equal(scheduled.scheduled_at, ONLINE_SCHEDULE.canonical, 'the +08:00 online schedule must retain stable UTC serialization');
scheduled = db.confirmInterviewSessionSchedule({ sessionId: online.session.id, scheduledAt: ONLINE_SCHEDULE.input, confirmedBy: 'HR-F012', confirmed: true, requestId: 'f012-online-schedule' });
assert.equal(scheduled.idempotent_replay, true);
assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session_schedule_confirmation WHERE session_id=?').get(online.session.id).n, 1);
db.setInterviewSessionStatus({ sessionId: online.session.id, status: 'in_progress' });
assert.equal(db.getCandidate(onlineCandidate.internal_id).workflow_status, 'interview_in_progress');
db.setInterviewSessionStatus({ sessionId: online.session.id, status: 'pending_review' });
const onlineMaterial = database.prepare('SELECT id FROM interview_session_material WHERE session_id=?').get(online.session.id);
let draft = db.saveInterviewReportV1({ sessionId: online.session.id, report: reportFixture(onlineMaterial.id), expectedVersion: 0, requestId: 'f012-online-save', actor: 'HR-F012' });
assert.equal(db.getCandidate(onlineCandidate.internal_id).workflow_status, 'report_pending_confirmation');
assert.ok(db.getJobWorkbench(job.id).todos.some((item) => item.code === 'report_fact_review_required' && item.candidate_id === onlineCandidate.internal_id));
draft = db.reviewInterviewReportFacts({ sessionId: online.session.id, expectedVersion: draft.version, requestId: 'f012-online-facts', actor: 'HR-F012', items: [{ field_key: 'project_result', status: 'confirmed' }] }).report;
assert.ok(db.getJobWorkbench(job.id).todos.some((item) => item.code === 'report_confirmation_required' && item.candidate_id === onlineCandidate.internal_id));
db.confirmInterviewReportV1({ sessionId: online.session.id, expectedVersion: draft.version, requestId: 'f012-online-confirm', actor: 'HR-F012', confirmed: true });
assert.equal(db.getCandidate(onlineCandidate.internal_id).workflow_status, 'report_confirmed');

// Offline synthetic journey reaches the same confirmed report fact without an online adapter.
const offline = adapters.ingestOfflineRecording({ recording: offlineMaterial('f012-offline', '纯合成项目事实用于线下面试报告证据验证。'), candidateId: offlineCandidate.internal_id, jobId: job.id, round: 1, actor: 'HR-F012', reason: 'explicit_candidate_context', requestId: 'f012-offline-ingest' });
const offlineScheduled = db.confirmInterviewSessionSchedule({ sessionId: offline.session.id, scheduledAt: OFFLINE_SCHEDULE.input, confirmedBy: 'HR-F012', confirmed: true, requestId: 'f012-offline-schedule' });
assert.equal(offlineScheduled.scheduled_at, OFFLINE_SCHEDULE.canonical, 'the +08:00 offline schedule must retain stable UTC serialization');
db.setInterviewSessionStatus({ sessionId: offline.session.id, status: 'pending_review' });
const offlineMaterialRow = database.prepare('SELECT id FROM interview_session_material WHERE session_id=?').get(offline.session.id);
confirmJourney(offline.session.id, offlineMaterialRow.id, 'f012-offline-report', false);
assert.equal(db.getCandidate(offlineCandidate.internal_id).workflow_status, 'report_confirmed');

const timeline = db.getCandidateTimeline(onlineCandidate.internal_id);
assert.equal(timeline.schema_version, 'candidate_timeline_v1');
assert.equal(timeline.data_class, 'formal');
assert.ok(timeline.events.some((event) => event.event_type === 'schedule_confirmed'));
assert.ok(timeline.events.some((event) => event.event_type === 'report_confirmed'));
assert.ok(!JSON.stringify(timeline).includes('请自动约明天十点'));
assert.deepEqual(db.getCandidateTimeline(fixtureCandidate.internal_id).events, []);
assert.deepEqual(db.getCandidateTimeline(leakedFixtureCandidate.internal_id).events, []);
assert.ok(!db.listCandidates(job.id).some((item) => item.internal_id === leakedFixtureCandidate.internal_id));
assert.equal(db.getJobWorkbench(fixtureJob.id).metrics.candidate_count, 0);
assert.deepEqual(db.getJobWorkbench(fixtureJob.id).todos, []);
const formalTalent = db.listTalentPool({ jobId: job.id });
assert.ok(!formalTalent.talents.some((item) => item.history.some((row) => Number(row.job_id) === Number(fixtureJob.id))), 'formal talent pool excludes fixture jobs');
assert.ok(!formalTalent.talents.some((item) => item.name === '不得进入正式投影的 Fixture 候选人'), 'formal talent pool excludes fixture candidate rows');

db.writeRunLog({ run_type: '纯合成失败任务', account: 'local', job: String(job.id), status: 'error', count_new: 0, count_total: 0, error_summary: 'synthetic failure' });
wb = db.getJobWorkbench(job.id);
assert.ok(wb.todos.some((item) => item.code === 'task_failed_retryable'));
assert.ok(wb.todos.every((item) => workflow.TODO_CODES.includes(item.code) && item.source && Object.hasOwn(item.source, 'status') && Object.hasOwn(item.source, 'time')));
db.writeRunLog({ run_type: '纯合成恢复任务', account: 'local', job: String(job.id), status: '成功', count_new: 0, count_total: 0, error_summary: null });
assert.ok(!db.getJobWorkbench(job.id).todos.some((item) => item.code === 'task_failed_retryable'),
  'a later successful run must close the stale historical failure todo');
assert.ok(wb.candidates.every((item) => workflow.WORKFLOW_STATUSES.includes(item.workflow_status)));

database.close();
const readonly = db.openReadonly(DB_PATH);
assert.equal(db.getJobWorkbench(job.id).schema_version, 'hr_workbench_v1', 'readonly projection must not attempt migration writes');
readonly.close();

console.log(JSON.stringify({ ok: true, schema: wb.schema_version, candidates: wb.metrics.candidate_count, todos: wb.todos.length, timeline_events: timeline.events.length }));
