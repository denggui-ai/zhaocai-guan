'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const {
  INTERVIEW_LOGISTICS_INDEXES,
  INTERVIEW_LOGISTICS_TRIGGERS,
  applyInterviewLogisticsDataMigration,
} = require('./interview-logistics-data-migration');
const { routeCapability } = require('./local-principal');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `hrboss-interview-logistics-${process.pid}-`));
const DB_PATH = path.join(ROOT, 'logistics.db');
const PORT = 20200 + (process.pid % 500);
const TOKEN = 'interview-logistics-local-api-token-000000000001';
// The schedule API rejects times that are not in the future, so fixtures cannot use fixed calendar dates.
const SCHEDULE_YEAR = new Date().getUTCFullYear() + 1;

process.env.BOSS_DB_PATH = DB_PATH;
process.env.BOSS_ACTION_PORT = String(PORT);
process.env.HRBOSS_LOCAL_API_TOKEN = TOKEN;
process.env.HRBOSS_LOCAL_API_INSTANCE_ID = 'interview-logistics-check';
process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
process.env.HRBOSS_RECOVERY_ROOT = path.join(ROOT, 'recovery');
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = path.join(ROOT, 'interviews');
process.env.HRBOSS_SENSITIVE_READ_AUDIT_FILE = path.join(ROOT, 'sensitive-read-audit.jsonl');

const db = require('./db');
const actionServer = require('./action-server');

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
  if (errors.length) throw new AggregateError(errors, 'check-interview-logistics-data-001 cleanup failed');
}

function request(method, pathname, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method,
      headers: {
        'x-hrboss-token': TOKEN,
        ...(payload === null ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        }),
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
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
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('action server did not become ready');
}

function completeLogistics(format, leadId, participantId = null, overrides = {}) {
  const interviewerAssignments = [
    { interviewerId: leadId, role: 'lead' },
    ...(participantId ? [{ interviewerId: participantId, role: 'participant' }] : []),
  ];
  const base = {
    interviewFormat: format,
    durationMinutes: 45,
    logisticsNote: '请提前十分钟准备',
    interviewerAssignments,
  };
  if (format === 'online') Object.assign(base, { meetingPlatform: '飞书', meetingLink: 'https://meeting.invalid/first' });
  if (format === 'offline') Object.assign(base, { locationAddress: '合成测试园区 1 号楼', locationRoom: 'A-101' });
  return { ...base, ...overrides };
}

function assertSnapshotHash(row) {
  assert.equal(
    crypto.createHash('sha256').update(row.logistics_snapshot_json, 'utf8').digest('hex'),
    row.logistics_snapshot_sha256,
  );
}

function checkLegacyMigration() {
  const legacy = new Database(':memory:');
  try {
    legacy.exec(`
      CREATE TABLE candidate (
        internal_id TEXT PRIMARY KEY,
        job_id INTEGER NOT NULL
      );
      CREATE TABLE interview_session (
        id INTEGER PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        job_id INTEGER NOT NULL,
        round INTEGER NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        scheduled_at TEXT,
        scheduled_confirmed_by TEXT,
        scheduled_confirmed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE interview_session_schedule_confirmation (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL REFERENCES interview_session(id) ON DELETE CASCADE,
        scheduled_at TEXT NOT NULL,
        confirmed_by TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        source TEXT NOT NULL,
        request_id TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO candidate (internal_id, job_id) VALUES
        ('legacy-online', 1),
        ('legacy-offline', 1);
      INSERT INTO interview_session (
        id, candidate_id, job_id, round, mode, status,
        scheduled_at, scheduled_confirmed_by, scheduled_confirmed_at, created_at, updated_at
      ) VALUES
        (1, 'legacy-online', 1, 1, 'online', 'scheduled', '2026-09-01T02:00:00.000Z', 'legacy-hr', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        (2, 'legacy-offline', 1, 1, 'offline', 'draft', NULL, NULL, NULL, '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z');
      INSERT INTO interview_session_schedule_confirmation (
        id, session_id, scheduled_at, confirmed_by, confirmed_at, source, request_id, created_at
      ) VALUES (1, 1, '2026-09-01T02:00:00.000Z', 'legacy-hr', '2026-07-01T00:00:00.000Z', 'manual', 'legacy-request', '2026-07-01T00:00:00.000Z');
    `);
    const before = legacy.prepare('SELECT * FROM interview_session ORDER BY id').all();
    applyInterviewLogisticsDataMigration(legacy);
    applyInterviewLogisticsDataMigration(legacy);
    const after = legacy.prepare('SELECT * FROM interview_session ORDER BY id').all();
    assert.equal(after[0].interview_format, 'online');
    assert.equal(after[1].interview_format, 'offline');
    assert.equal(after[0].scheduled_at, before[0].scheduled_at);
    assert.equal(after[0].scheduled_confirmed_by, before[0].scheduled_confirmed_by);
    assert.equal(after[0].duration_minutes, null, 'migration must not guess duration');
    assert.equal(legacy.prepare('SELECT COUNT(*) AS n FROM interview_interviewer').get().n, 0, 'migration must not guess interviewers');
    const oldConfirmation = legacy.prepare('SELECT * FROM interview_session_schedule_confirmation WHERE id = 1').get();
    assert.equal(oldConfirmation.logistics_snapshot_json, null, 'existing history rows may stay without a guessed snapshot');
    assert.throws(
      () => legacy.prepare('UPDATE interview_session SET interview_format = NULL WHERE id = 1').run(),
      /invalid interview session logistics/,
      'authoritative format must fail closed against direct SQL NULL',
    );
    assert.throws(
      () => legacy.prepare('UPDATE interview_session SET invitation_status = NULL WHERE id = 1').run(),
      /invalid interview session logistics/,
      'manual status columns must fail closed against direct SQL NULL',
    );
    assert.throws(
      () => legacy.prepare('UPDATE interview_session SET mode = \'offline\' WHERE id = 1').run(),
      /invalid interview session logistics/,
      'legacy mode must stay consistent with authoritative format',
    );
  } finally {
    legacy.close();
  }
}

function checkMigrationRollback() {
  const broken = new Database(':memory:');
  try {
    broken.exec(`
      CREATE TABLE interview_session (
        id INTEGER PRIMARY KEY,
        candidate_id TEXT NOT NULL,
        job_id INTEGER NOT NULL,
        round INTEGER NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        scheduled_at TEXT,
        scheduled_confirmed_by TEXT,
        scheduled_confirmed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE interview_session_schedule_confirmation (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL,
        scheduled_at TEXT NOT NULL,
        confirmed_by TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        source TEXT NOT NULL,
        request_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE interview_interviewer (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        active INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE interview_session_interviewer (
        id INTEGER PRIMARY KEY,
        session_id INTEGER NOT NULL,
        interviewer_id INTEGER NOT NULL,
        interviewer_name_snapshot TEXT NOT NULL,
        role TEXT NOT NULL,
        assigned_at TEXT NOT NULL
      );
      INSERT INTO interview_session (
        id, candidate_id, job_id, round, mode, status, created_at, updated_at
      ) VALUES (1, 'migration-rollback', 1, 1, 'online', 'draft', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
      INSERT INTO interview_interviewer (id, name, active, created_at, updated_at) VALUES
        (1, '迁移失败注入甲', 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'),
        (2, '迁移失败注入乙', 1, '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
      INSERT INTO interview_session_interviewer (
        session_id, interviewer_id, interviewer_name_snapshot, role, assigned_at
      ) VALUES
        (1, 1, '迁移失败注入甲', 'lead', '2026-07-01T00:00:00.000Z'),
        (1, 2, '迁移失败注入乙', 'lead', '2026-07-01T00:00:00.000Z');
    `);
    assert.throws(
      () => applyInterviewLogisticsDataMigration(broken),
      /UNIQUE constraint failed/,
      'synthetic duplicate lead rows must abort migration while creating the unique lead index',
    );
    const sessionColumns = new Set(broken.prepare("PRAGMA table_info('interview_session')").all().map((row) => row.name));
    const historyColumns = new Set(broken.prepare("PRAGMA table_info('interview_session_schedule_confirmation')").all().map((row) => row.name));
    assert.equal(sessionColumns.has('interview_format'), false, 'failed migration must roll back added session columns');
    assert.equal(historyColumns.has('logistics_snapshot_json'), false, 'failed migration must roll back added history columns');
    const objects = new Set(broken.prepare("SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger')").all().map((row) => row.name));
    assert.ok(
      [...INTERVIEW_LOGISTICS_INDEXES, ...INTERVIEW_LOGISTICS_TRIGGERS].every((name) => !objects.has(name)),
      'failed migration must not leave partial indexes or triggers',
    );
    assert.equal(broken.prepare('SELECT COUNT(*) AS n FROM interview_session_interviewer').get().n, 2, 'pre-existing rows must remain intact after rollback');
  } finally {
    broken.close();
  }
}

(async () => {
  checkLegacyMigration();
  checkMigrationRollback();
  trackDatabase(db.openDb(DB_PATH));
  applyInterviewLogisticsDataMigration(db.conn());
  applyInterviewLogisticsDataMigration(db.conn());
  const readonlyDatabase = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  try {
    applyInterviewLogisticsDataMigration(readonlyDatabase);
  } finally {
    readonlyDatabase.close();
  }

  const job = db.upsertJob({ encrypt_job_id: 'logistics-synthetic-job', name: '合成面试物流岗位' });
  const candidates = ['online', 'offline', 'phone', 'rollback', 'legacy'].map((suffix) => db.upsertCandidate({
    job_id: job.id,
    geek_id: `logistics-${suffix}-candidate`,
    name: `合成${suffix}候选人`,
  }));
  const otherJob = db.upsertJob({ encrypt_job_id: 'logistics-synthetic-other-job', name: '合成其他岗位' });
  const directInsert = db.conn().prepare(`
    INSERT INTO interview_session (
      candidate_id, job_id, round, mode, status, created_at, updated_at
    ) VALUES (?, ?, ?, 'online', 'draft', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z')
  `);
  assert.throws(
    () => directInsert.run(candidates[0].internal_id, otherJob.id, 80),
    /candidate\/job mismatch/,
    'F006 candidate/job truth guard must retain priority over missing logistics',
  );
  assert.throws(
    () => directInsert.run(candidates[0].internal_id, job.id, -1),
    /CHECK constraint/,
    'F006 core round constraint must retain priority over missing logistics',
  );
  assert.throws(
    () => db.conn().prepare(`
      INSERT INTO interview_session (
        candidate_id, job_id, round, mode, status, created_at, updated_at
      ) VALUES (?, ?, 82, 'online', 'scheduled', '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z')
    `).run(candidates[0].internal_id, job.id),
    /CHECK constraint/,
    'F006 scheduled/status combination must retain priority over missing logistics',
  );
  assert.throws(
    () => directInsert.run(candidates[0].internal_id, job.id, 81),
    /invalid interview session logistics/,
    'valid F006 core fields with missing authoritative logistics must fail closed at the logistics guard',
  );

  await actionServer.startHttpServer();
  trackDatabase(db.conn());
  await waitForHealth();

  let response = await request('POST', '/api/interviewers', {
    name: '主面试官（合成）',
    actor: 'forged-client-actor',
    recordedBy: 'forged-client-recorder',
  });
  assert.equal(response.status, 201);
  const lead = response.body.interviewer;
  response = await request('POST', '/api/interviewers', { name: '协同面试官（合成）' });
  assert.equal(response.status, 201);
  const participant = response.body.interviewer;
  response = await request('POST', '/api/interviewers', { name: '候补面试官（合成）' });
  assert.equal(response.status, 201);
  const observer = response.body.interviewer;

  response = await request('POST', '/api/interviewers', { id: participant.id, active: false });
  assert.equal(response.status, 200, 'active-only interviewer update must not require name');
  assert.equal(response.body.interviewer.active, 0);
  response = await request('POST', '/api/interviewers', { id: participant.id, active: true });
  assert.equal(response.status, 200);
  response = await request('GET', '/api/interviewers?includeInactive=1');
  assert.equal(response.status, 200);
  assert.equal(response.body.interviewers.length, 3);
  assert.equal(
    db.conn().prepare("SELECT who FROM audit_log WHERE action = 'interview_interviewer_created' ORDER BY id LIMIT 1").get().who,
    'local-primary-operator',
    'route actor must come from local principal',
  );

  const sessions = {};
  for (let index = 0; index < 3; index += 1) {
    const format = ['online', 'offline', 'phone'][index];
    response = await request('POST', '/api/interview-session', {
      candidateId: candidates[index].internal_id,
      jobId: job.id,
      interviewFormat: format,
    });
    assert.equal(response.status, 200);
    sessions[format] = response.body.session;
    assert.equal(response.body.session.interview_format, format);
    assert.equal(response.body.session.mode, format === 'online' ? 'online' : 'offline');
  }

  const invalidCases = [
    [sessions.online.id, completeLogistics('online', lead.id, null, { durationMinutes: 4 }), 'INTERVIEW_DURATION_INVALID'],
    [sessions.online.id, completeLogistics('online', lead.id, null, { meetingLink: '' }), 'INTERVIEW_MEETING_LINK_REQUIRED'],
    [sessions.online.id, completeLogistics('online', lead.id, null, { locationAddress: '不应混入' }), 'INTERVIEW_LOGISTICS_FORMAT_CONFLICT'],
    [sessions.offline.id, completeLogistics('offline', lead.id, null, { locationAddress: '' }), 'INTERVIEW_LOCATION_REQUIRED'],
    [sessions.offline.id, completeLogistics('offline', lead.id, null, { meetingLink: 'https://meeting.invalid/mixed' }), 'INTERVIEW_LOGISTICS_FORMAT_CONFLICT'],
    [sessions.phone.id, completeLogistics('phone', lead.id, null, { meetingLink: 'https://meeting.invalid/phone' }), 'INTERVIEW_LOGISTICS_FORMAT_CONFLICT'],
    [sessions.online.id, completeLogistics('online', lead.id, participant.id, {
      interviewerAssignments: [
        { interviewerId: lead.id, role: 'participant' },
        { interviewerId: participant.id, role: 'participant' },
      ],
    }), 'INTERVIEWER_LEAD_REQUIRED'],
    [sessions.online.id, completeLogistics('online', lead.id, participant.id, {
      interviewerAssignments: [
        { interviewerId: lead.id, role: 'lead' },
        { interviewerId: participant.id, role: 'lead' },
      ],
    }), 'INTERVIEWER_LEAD_REQUIRED'],
  ];
  for (let index = 0; index < invalidCases.length; index += 1) {
    const [sessionId, logistics, code] = invalidCases[index];
    response = await request('POST', '/api/interview-session/schedule', {
      sessionId,
      scheduledAt: `${SCHEDULE_YEAR}-09-${String(index + 10).padStart(2, '0')}T10:00:00+08:00`,
      confirmed: true,
      requestId: `invalid-logistics-${index}`,
      logistics,
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, code);
  }
  assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM interview_session_schedule_confirmation').get().n, 0);

  const firstScheduledAt = `${SCHEDULE_YEAR}-09-20T02:00:00.000Z`;
  response = await request('POST', '/api/interview-session/schedule', {
    sessionId: sessions.online.id,
    scheduledAt: `${SCHEDULE_YEAR}-09-20T10:00:00+08:00`,
    confirmed: true,
    confirmedBy: 'forged-schedule-actor',
    requestId: 'online-first-schedule',
    logistics: completeLogistics('online', lead.id, participant.id),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.session.interview_format, 'online');
  assert.equal(response.body.session.duration_minutes, 45);
  assert.equal(response.body.session.interviewer_assignments.length, 2);
  assert.equal(response.body.session.schedule_confirmations[0].confirmed_by, 'local-primary-operator');
  assert.equal(response.body.session.schedule_confirmations[0].logistics_snapshot.previous_schedule, null);
  assert.equal(response.body.session.schedule_confirmations[0].logistics_snapshot.snapshot_kind, 'complete');
  assertSnapshotHash(response.body.session.schedule_confirmations[0]);

  response = await request('POST', '/api/interviewers', { id: lead.id, name: '主面试官已改名（合成）' });
  assert.equal(response.status, 200);
  assert.equal(
    db.getInterviewSession(sessions.online.id).interviewer_assignments[0].interviewer_name_snapshot,
    lead.name,
    'current assignment must retain the name snapshot from assignment time',
  );

  assert.throws(
    () => db.conn().prepare(`
      INSERT INTO interview_session_interviewer (
        session_id, interviewer_id, interviewer_name_snapshot, role, assigned_at
      ) VALUES (?, ?, ?, 'lead', ?)
    `).run(sessions.online.id, observer.id, '另一主面试官', new Date().toISOString()),
    /UNIQUE constraint failed/,
    'database must enforce one lead per session',
  );

  response = await request('POST', '/api/interview-session/schedule', {
    sessionId: sessions.offline.id,
    scheduledAt: `${SCHEDULE_YEAR}-09-21T10:00:00+08:00`,
    confirmed: true,
    requestId: 'offline-first-schedule',
    logistics: completeLogistics('offline', lead.id),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.session.location_address, '合成测试园区 1 号楼');
  assert.equal(response.body.session.meeting_link, null);

  response = await request('POST', '/api/interview-session/schedule', {
    sessionId: sessions.phone.id,
    scheduledAt: `${SCHEDULE_YEAR}-09-22T10:00:00+08:00`,
    confirmed: true,
    requestId: 'phone-first-schedule',
    logistics: completeLogistics('phone', lead.id),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.session.interview_format, 'phone');
  assert.equal(response.body.session.mode, 'offline');
  assert.equal(response.body.session.meeting_link, null);
  assert.equal(response.body.session.location_address, null);

  response = await request('POST', '/api/interview-session', {
    candidateId: candidates[4].internal_id,
    jobId: job.id,
    mode: 'online',
  });
  assert.equal(response.status, 200);
  const legacyCompatibleSessionId = response.body.session.id;
  response = await request('POST', '/api/interview-session/schedule', {
    sessionId: legacyCompatibleSessionId,
    scheduledAt: `${SCHEDULE_YEAR}-09-22T16:00:00+08:00`,
    confirmed: true,
    requestId: 'legacy-compatible-schedule',
  });
  assert.equal(response.status, 200, 'existing schedule callers without logistics must remain compatible');
  assert.equal(response.body.session.schedule_confirmations[0].logistics_snapshot.snapshot_kind, 'legacy_compatible');
  assert.equal(response.body.session.schedule_confirmations[0].logistics_snapshot.duration_minutes, null);
  assert.deepEqual(response.body.session.schedule_confirmations[0].logistics_snapshot.interviewers, []);
  assertSnapshotHash(response.body.session.schedule_confirmations[0]);

  response = await request('POST', '/api/interview-session/invitation-sent', {
    sessionId: sessions.online.id,
    confirmed: true,
    sentBy: 'forged-sender',
    actor: 'forged-actor',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.session.invitation_status, 'sent');
  assert.equal(response.body.session.invitation_sent_by, 'local-primary-operator');
  const statusBeforeCandidateConfirmation = response.body.session.status;
  response = await request('POST', '/api/interview-session/candidate-confirmation', {
    sessionId: sessions.online.id,
    status: 'confirmed',
    confirmed: true,
    recordedBy: 'forged-recorder',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.session.candidate_confirmation_status, 'confirmed');
  assert.equal(response.body.session.candidate_confirmation_recorded_by, 'local-primary-operator');
  assert.equal(response.body.session.status, statusBeforeCandidateConfirmation, 'manual candidate confirmation must not advance session status');
  assert.equal(response.body.session.scheduled_at, firstScheduledAt, 'manual candidate confirmation must not change schedule');

  const secondScheduledAt = `${SCHEDULE_YEAR}-09-23T06:30:00.000Z`;
  response = await request('POST', '/api/interview-session/schedule', {
    sessionId: sessions.online.id,
    scheduledAt: `${SCHEDULE_YEAR}-09-23T14:30:00+08:00`,
    confirmed: true,
    requestId: 'online-reschedule',
    logistics: completeLogistics('online', participant.id, lead.id, {
      durationMinutes: 60,
      meetingPlatform: '腾讯会议',
      meetingLink: 'https://meeting.invalid/rescheduled',
      logisticsNote: '改期后的合成备注',
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.session.scheduled_at, secondScheduledAt);
  assert.equal(response.body.session.invitation_status, 'draft', 'reschedule must invalidate old invitation state');
  assert.equal(response.body.session.invitation_sent_by, null);
  assert.equal(response.body.session.candidate_confirmation_status, 'pending', 'reschedule must invalidate old candidate confirmation');
  assert.equal(response.body.session.candidate_confirmation_recorded_by, null);
  assert.equal(response.body.session.schedule_confirmations.length, 2);
  const [firstHistory, secondHistory] = response.body.session.schedule_confirmations;
  assert.equal(firstHistory.logistics_snapshot.meeting_link, 'https://meeting.invalid/first');
  assert.equal(secondHistory.logistics_snapshot.meeting_link, 'https://meeting.invalid/rescheduled');
  assert.equal(secondHistory.logistics_snapshot.invitation_status, 'draft');
  assert.equal(secondHistory.logistics_snapshot.candidate_confirmation_status, 'pending');
  assert.equal(secondHistory.logistics_snapshot.previous_schedule.scheduled_at, firstScheduledAt);
  assert.equal(secondHistory.logistics_snapshot.previous_schedule.meeting_link, 'https://meeting.invalid/first');
  assert.equal(secondHistory.logistics_snapshot.previous_schedule.invitation_status, 'sent');
  assert.equal(secondHistory.logistics_snapshot.previous_schedule.candidate_confirmation_status, 'confirmed');
  assert.equal(secondHistory.logistics_snapshot.previous_schedule.interviewers[0].interviewer_id, lead.id);
  assert.equal(secondHistory.logistics_snapshot.previous_schedule.interviewers[0].interviewer_name_snapshot, lead.name);
  assertSnapshotHash(secondHistory);
  assert.throws(
    () => db.conn().prepare('UPDATE interview_session_schedule_confirmation SET scheduled_at = ? WHERE id = ?')
      .run('2026-10-01T00:00:00.000Z', firstHistory.id),
    /history is immutable/,
  );

  response = await request('POST', '/api/interview-session/invitation-copy', {
    sessionId: sessions.online.id,
    text: 'copy only must stay renderer-local',
  });
  assert.equal(response.status, 404, 'copying invitation text must have no write endpoint');
  assert.equal(routeCapability('POST', '/api/interview-session/invitation-copy'), null);

  response = await request('POST', '/api/interview-session', {
    candidateId: candidates[3].internal_id,
    jobId: job.id,
    interviewFormat: 'online',
  });
  assert.equal(response.status, 200);
  const rollbackSessionId = response.body.session.id;
  const beforeRollback = {
    history: db.conn().prepare('SELECT COUNT(*) AS n FROM interview_session_schedule_confirmation WHERE session_id = ?').get(rollbackSessionId).n,
    assignments: db.conn().prepare('SELECT COUNT(*) AS n FROM interview_session_interviewer WHERE session_id = ?').get(rollbackSessionId).n,
    current: db.getInterviewSession(rollbackSessionId),
  };
  db.conn().exec(`
    CREATE TEMP TRIGGER synthetic_logistics_transaction_abort
    BEFORE UPDATE OF meeting_link ON interview_session
    FOR EACH ROW WHEN NEW.id = ${Number(rollbackSessionId)}
    BEGIN SELECT RAISE(ABORT, 'synthetic logistics update abort'); END;
  `);
  response = await request('POST', '/api/interview-session/schedule', {
    sessionId: rollbackSessionId,
    scheduledAt: `${SCHEDULE_YEAR}-09-25T10:00:00+08:00`,
    confirmed: true,
    requestId: 'rollback-schedule',
    logistics: completeLogistics('online', lead.id, participant.id),
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /synthetic logistics update abort/);
  db.conn().exec('DROP TRIGGER synthetic_logistics_transaction_abort');
  assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM interview_session_schedule_confirmation WHERE session_id = ?').get(rollbackSessionId).n, beforeRollback.history);
  assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM interview_session_interviewer WHERE session_id = ?').get(rollbackSessionId).n, beforeRollback.assignments);
  assert.equal(db.getInterviewSession(rollbackSessionId).scheduled_at, beforeRollback.current.scheduled_at);

  db.updateJobStatus({ jobId: job.id, status: 'closed', closeReason: 'other', actor: 'synthetic-owner' });
  response = await request('GET', `/api/interview-session?jobId=${job.id}`);
  assert.equal(response.status, 200, 'closed job history must remain readable');
  const closedOnline = response.body.sessions.find((item) => item.id === sessions.online.id);
  assert.equal(closedOnline.interview_format, 'online');
  assert.equal(closedOnline.duration_minutes, 60);
  assert.equal(closedOnline.interviewer_assignments.length, 2);
  assert.equal(closedOnline.schedule_confirmations.length, 2);
  assert.equal(closedOnline.schedule_confirmations[1].logistics_snapshot.previous_schedule.invitation_status, 'sent');

  const closedPosts = [
    ['/api/interview-session', { candidateId: candidates[3].internal_id, jobId: job.id, interviewFormat: 'offline' }],
    ['/api/interview-session/schedule', {
      sessionId: sessions.online.id,
      scheduledAt: `${SCHEDULE_YEAR}-09-26T10:00:00+08:00`,
      confirmed: true,
      requestId: 'closed-schedule',
      logistics: completeLogistics('online', lead.id),
    }],
    ['/api/interview-session/invitation-sent', { sessionId: sessions.online.id, confirmed: true }],
    ['/api/interview-session/candidate-confirmation', { sessionId: sessions.online.id, status: 'declined', confirmed: true }],
  ];
  for (const [pathname, body] of closedPosts) {
    response = await request('POST', pathname, body);
    assert.equal(response.status, 409, `${pathname} must be blocked after job closes`);
    assert.equal(response.body.code, 'JOB_CLOSED');
  }

  const actorRows = db.conn().prepare(`
    SELECT action, who FROM audit_log
    WHERE action IN ('interview_invitation_marked_sent', 'interview_candidate_confirmation_recorded')
    ORDER BY id
  `).all();
  assert.equal(actorRows.length, 2);
  assert.ok(actorRows.every((row) => row.who === 'local-primary-operator'));

  return JSON.stringify({
    ok: true,
    contract: 'INTERVIEW-LOGISTICS-DATA-001',
    legacy_backfill_truthful: true,
    migration_idempotent: true,
    migration_failure_left_partial_schema: false,
    f006_core_guard_priority_preserved: true,
    valid_core_null_logistics_fail_closed: true,
    formats_validated: ['online', 'offline', 'phone'],
    interviewer_cardinality: 'one_or_many_exactly_one_lead',
    immutable_schedule_snapshots: 2,
    reschedule_invalidates_old_manual_status: true,
    route_actor: 'local-primary-operator',
    closed_job_history_readable: true,
    closed_job_posts_blocked: closedPosts.length,
    rollback_left_partial_records: false,
    network_boss_ai_called: false,
  });
})().then(async (message) => {
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
