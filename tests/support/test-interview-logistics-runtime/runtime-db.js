'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const syntheticRoot = fs.realpathSync(path.resolve(process.argv[2] || ''));
const mode = process.argv[3] || 'seed';
const dataRoot = path.join(syntheticRoot, 'data');
process.env.BOSS_DB_PATH = path.join(dataRoot, 'recruiting.db');
process.env.HRBOSS_DATA_DIR = dataRoot;
process.env.HRBOSS_EXTERNAL_AI_ENABLED = '0';
process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED = '0';
process.env.HRBOSS_F018_ENABLED = '0';

const db = require("../../../src/db");

fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') fs.chmodSync(dataRoot, 0o700);
db.openDb(process.env.BOSS_DB_PATH);

const SCHEDULE_YEAR = new Date().getUTCFullYear() + 1;
const EXPECTED = Object.freeze({
  job_name: 'B-5 合成面试物流岗位',
  primary_name: 'B-5 合成候选人甲',
  secondary_name: 'B-5 合成候选人乙',
  interviewers: ['B-5 主面试官（合成）', 'B-5 技术面试官（合成）', 'B-5 观察员（合成）'],
  first_schedule: `${SCHEDULE_YEAR}-09-20T02:00:00.000Z`,
  second_schedule: `${SCHEDULE_YEAR}-09-23T06:30:00.000Z`,
  phone_schedule: `${SCHEDULE_YEAR}-09-24T03:00:00.000Z`,
  online_link: 'https://meeting.invalid/b5-synthetic-room',
  offline_address: 'B-5 合成园区 1 号楼',
  offline_room: 'B-5 合成会议室 502',
});

function seedDatabase() {
  const job = db.upsertJob({
    encrypt_job_id: 'b5-synthetic-interview-logistics',
    numeric_job_id: '950260729001',
    name: EXPECTED.job_name,
    hr_owner: 'B-5 合成 HR',
    department: 'B-5 合成研发部',
    location: 'B-5 合成上海',
    source_type: 'local_manual',
    created_at: '2026-07-29T09:00:00.000Z',
  });
  db.conn().prepare("UPDATE job SET status = 'open', updated_at = ? WHERE id = ?")
    .run('2026-07-29T09:00:00.000Z', job.id);
  const primary = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'b5-synthetic-candidate-primary',
    source: 'synthetic_b5',
    name: EXPECTED.primary_name,
    degree: '本科',
    school: 'B-5 合成大学甲',
    work_years: '6',
    geek_desc: '纯合成面试物流候选人甲，仅用于本地排期、改期、邀约确认与爽约旅程。',
    sabc: 'C',
    sabc_source: 'manual_fixture',
  }, '2026-07-29T09:01:00.000Z');
  const secondary = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'b5-synthetic-candidate-secondary',
    source: 'synthetic_b5',
    name: EXPECTED.secondary_name,
    degree: '硕士',
    school: 'B-5 合成大学乙',
    work_years: '4',
    geek_desc: '纯合成面试物流候选人乙，仅用于本地电话面试与取消旅程。',
    sabc: 'B',
    sabc_source: 'manual_fixture',
  }, '2026-07-29T09:02:00.000Z');
  const seed = {
    job_id: job.id,
    candidates: {
      primary: primary.internal_id,
      secondary: secondary.internal_id,
    },
    expected: EXPECTED,
  };
  const target = path.join(syntheticRoot, 'seed.json');
  fs.writeFileSync(target, `${JSON.stringify(seed, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
  return { ok: true, ...seed };
}

function snapshotHash(history) {
  return crypto.createHash('sha256').update(history.logistics_snapshot_json).digest('hex');
}

function cancellationReason(sessionId) {
  return db.conn().prepare(`
    SELECT reason_code
    FROM interview_lifecycle_event
    WHERE session_id = ? AND event_type = 'session_withdrawn'
    ORDER BY id DESC LIMIT 1
  `).get(String(sessionId))?.reason_code || null;
}

function verifyDatabase() {
  const seed = JSON.parse(fs.readFileSync(path.join(syntheticRoot, 'seed.json'), 'utf8'));
  const expected = seed.expected;
  const sessions = db.listInterviewSessions({ jobId: seed.job_id });
  assert.equal(sessions.length, 2);
  const primaryRow = sessions.find((session) => session.candidate_id === seed.candidates.primary);
  const secondaryRow = sessions.find((session) => session.candidate_id === seed.candidates.secondary);
  assert.ok(primaryRow);
  assert.ok(secondaryRow);
  const primary = db.getInterviewSession(primaryRow.id);
  const secondary = db.getInterviewSession(secondaryRow.id);

  assert.equal(primary.status, 'cancelled');
  assert.equal(primary.interview_format, 'offline');
  assert.equal(primary.scheduled_at, expected.second_schedule);
  assert.equal(primary.duration_minutes, 60);
  assert.equal(primary.meeting_platform, null);
  assert.equal(primary.meeting_link, null);
  assert.equal(primary.location_address, EXPECTED.offline_address);
  assert.equal(primary.location_room, EXPECTED.offline_room);
  assert.equal(primary.invitation_status, 'draft');
  assert.equal(primary.invitation_sent_by, null);
  assert.equal(primary.candidate_confirmation_status, 'pending');
  assert.equal(primary.candidate_confirmation_recorded_by, null);
  assert.equal(primary.interviewer_assignments.length, 3);
  assert.equal(primary.interviewer_assignments.filter((item) => item.role === 'lead').length, 1);
  assert.equal(primary.interviewer_assignments.filter((item) => item.role === 'participant').length, 2);
  assert.equal(primary.schedule_confirmations.length, 2);
  assert.ok(primary.schedule_confirmations.every((history) => history.confirmed_by === 'local-primary-operator'));
  assert.ok(primary.schedule_confirmations.every((history) => snapshotHash(history) === history.logistics_snapshot_sha256));
  const [firstHistory, secondHistory] = primary.schedule_confirmations;
  assert.equal(firstHistory.scheduled_at, expected.first_schedule);
  assert.equal(firstHistory.logistics_snapshot.interview_format, 'online');
  assert.equal(firstHistory.logistics_snapshot.meeting_link, EXPECTED.online_link);
  assert.equal(firstHistory.logistics_snapshot.interviewers.length, 3);
  assert.equal(secondHistory.scheduled_at, expected.second_schedule);
  assert.equal(secondHistory.logistics_snapshot.interview_format, 'offline');
  assert.equal(secondHistory.logistics_snapshot.location_address, EXPECTED.offline_address);
  assert.equal(secondHistory.logistics_snapshot.previous_schedule.scheduled_at, expected.first_schedule);
  assert.equal(secondHistory.logistics_snapshot.previous_schedule.meeting_link, EXPECTED.online_link);
  assert.equal(secondHistory.logistics_snapshot.previous_schedule.invitation_status, 'sent');
  assert.equal(secondHistory.logistics_snapshot.previous_schedule.candidate_confirmation_status, 'confirmed');
  assert.equal(secondHistory.logistics_snapshot.invitation_status, 'draft');
  assert.equal(secondHistory.logistics_snapshot.candidate_confirmation_status, 'pending');
  assert.equal(cancellationReason(primary.id), 'candidate_no_show');
  assert.equal(db.getInterviewLifecycleStatus({ sessionId: primary.id }).state, 'withdrawn');

  assert.equal(secondary.status, 'cancelled');
  assert.equal(secondary.interview_format, 'phone');
  assert.equal(secondary.scheduled_at, expected.phone_schedule);
  assert.equal(secondary.meeting_link, null);
  assert.equal(secondary.location_address, null);
  assert.equal(secondary.interviewer_assignments.length, 2);
  assert.equal(secondary.interviewer_assignments.filter((item) => item.role === 'lead').length, 1);
  assert.equal(secondary.schedule_confirmations.length, 1);
  assert.equal(secondary.schedule_confirmations[0].logistics_snapshot.interview_format, 'phone');
  assert.equal(cancellationReason(secondary.id), 'candidate_cancelled');
  assert.equal(db.getInterviewLifecycleStatus({ sessionId: secondary.id }).state, 'withdrawn');

  const interviewers = db.listInterviewInterviewers({ includeInactive: true });
  assert.deepEqual(interviewers.map((item) => item.name).sort(), [...EXPECTED.interviewers].sort());
  const actorRows = db.conn().prepare(`
    SELECT action, who
    FROM audit_log
    WHERE action IN (
      'interview_interviewer_created',
      'interview_invitation_marked_sent',
      'interview_candidate_confirmation_recorded'
    )
    ORDER BY id
  `).all();
  assert.equal(actorRows.length, 5);
  assert.ok(actorRows.every((row) => row.who === 'local-primary-operator'));

  return {
    ok: true,
    synthetic_data_only: true,
    formats: ['online', 'offline', 'phone'],
    primary: {
      session_id: primary.id,
      final_status: primary.status,
      final_format: primary.interview_format,
      interviewer_assignments: primary.interviewer_assignments.length,
      schedule_history: primary.schedule_confirmations.length,
      invitation_confirmation_reset: primary.invitation_status === 'draft'
        && primary.candidate_confirmation_status === 'pending',
      cancellation_reason: cancellationReason(primary.id),
      lifecycle_state: db.getInterviewLifecycleStatus({ sessionId: primary.id }).state,
    },
    secondary: {
      session_id: secondary.id,
      final_status: secondary.status,
      final_format: secondary.interview_format,
      interviewer_assignments: secondary.interviewer_assignments.length,
      schedule_history: secondary.schedule_confirmations.length,
      cancellation_reason: cancellationReason(secondary.id),
      lifecycle_state: db.getInterviewLifecycleStatus({ sessionId: secondary.id }).state,
    },
    cancellation_reasons: [cancellationReason(primary.id), cancellationReason(secondary.id)],
    audit_actions: actorRows.map((row) => row.action),
  };
}

try {
  const result = mode === 'verify' ? verifyDatabase() : seedDatabase();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  db.conn().close();
}
