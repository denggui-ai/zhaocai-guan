const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const Database = require('better-sqlite3');
const {
  F006_TABLES,
  applyF006InterviewSessionMigration,
  rollbackF006InterviewSessionMigration,
} = require('./f006-interview-session-migration');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f006-'));
const MIGRATION_DB = path.join(ROOT, 'migration.db');
const RECOVERY_POINT_DB = path.join(ROOT, 'migration.pre-f006.recovery-point.db');
const FAILURE_DB = path.join(ROOT, 'migration-failure.db');
const REJECTED_MIGRATION_UPGRADE_DB = path.join(ROOT, 'rejected-migration-upgrade.db');
const LEGACY_CONSENT_UPGRADE_DB = path.join(ROOT, 'legacy-consent-upgrade.db');
const API_DB = path.join(ROOT, 'api.db');
const CLI_ROLLBACK_DB = path.join(ROOT, 'cli-rollback.db');
const CLI_RECOVERY_POINT_DB = path.join(ROOT, 'cli-rollback.recovery-point.db');

function runtimeFutureSchedule(daysAhead = 30) {
  const futureDate = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return {
    input: `${futureDate}T10:00:00+08:00`,
    canonical: `${futureDate}T02:00:00.000Z`,
  };
}

const FUTURE_SCHEDULE = runtimeFutureSchedule();
const PAST_SCHEDULE = new Date(Date.now() - 60 * 1000).toISOString();

process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
process.env.BOSS_DB_PATH = API_DB;
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = path.join(ROOT, 'interviews');
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

function createSyntheticLegacySchema(database) {
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE job (
      id INTEGER PRIMARY KEY,
      encrypt_job_id TEXT NOT NULL,
      name TEXT,
      created_at TEXT
    );

    CREATE TABLE candidate (
      internal_id TEXT PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES job(id),
      geek_id TEXT NOT NULL,
      name TEXT
    );

    CREATE TABLE job_interview (
      id INTEGER PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES job(id),
      source_url TEXT,
      transcript TEXT NOT NULL,
      note TEXT,
      source_type TEXT NOT NULL DEFAULT 'manual_transcript',
      created_at TEXT
    );

    CREATE TABLE interview_recording (
      id INTEGER PRIMARY KEY,
      candidate_id TEXT REFERENCES candidate(internal_id) ON DELETE SET NULL,
      job_id INTEGER REFERENCES job(id) ON DELETE SET NULL
    );

    CREATE TABLE interview_ai_report (
      id INTEGER PRIMARY KEY,
      recording_id INTEGER NOT NULL REFERENCES interview_recording(id) ON DELETE CASCADE,
      candidate_id TEXT REFERENCES candidate(internal_id) ON DELETE SET NULL,
      job_id INTEGER REFERENCES job(id) ON DELETE SET NULL,
      status TEXT,
      confirmed_at TEXT
    );

    CREATE TABLE interview_recording_consent (
      id INTEGER PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      status TEXT NOT NULL,
      consented_at TEXT NOT NULL,
      recorded_by TEXT NOT NULL
    );

    CREATE TABLE interview_recording_confirmation (
      id INTEGER PRIMARY KEY,
      recording_id INTEGER NOT NULL REFERENCES interview_recording(id) ON DELETE CASCADE,
      field_key TEXT NOT NULL,
      status TEXT,
      confirmed_at TEXT
    );

    INSERT INTO job VALUES (1, 'synthetic-job-1', '合成岗位一', '2026-07-01T00:00:00.000Z');
    INSERT INTO candidate VALUES ('C-SYNTHETIC-1', 1, 'geek-synthetic-1', '合成候选人一');
    INSERT INTO job_interview VALUES (
      1, 1, 'https://example.test/minutes/candidate-zhang-san', '候选人张三面试：纯合成妙记转写', '张三候选人面试记录',
      'lark_minutes', '2026-07-01T01:00:00.000Z'
    );
    INSERT INTO job_interview VALUES (
      2, 1, NULL, '纯合成手工转写', '合成手工记录',
      'manual_transcript', '2026-07-01T02:00:00.000Z'
    );
  `);
}

function tableNames(database) {
  return database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
}

function checkMigrationAndRollback() {
  let database = new Database(MIGRATION_DB);
  createSyntheticLegacySchema(database);
  database.close();

  // 明确的恢复点：迁移前关闭连接并复制整个纯合成 SQLite 文件。
  fs.copyFileSync(MIGRATION_DB, RECOVERY_POINT_DB);
  assert.ok(fs.statSync(RECOVERY_POINT_DB).size > 0, 'pre-F006 recovery point must exist before migration');

  database = new Database(MIGRATION_DB);
  database.pragma('foreign_keys = ON');
  let result = applyF006InterviewSessionMigration(database, { timestamp: '2026-07-11T00:00:00.000Z' });
  assert.equal(result.pending_classifications_added, 1);
  for (const table of F006_TABLES) assert.ok(tableNames(database).includes(table), `${table} should be created`);
  assert.deepEqual(database.prepare(`
    SELECT job_interview_id, job_id, source_type, purpose, status, reason, assigned_session_id
    FROM interview_pending_assignment
  `).all(), [{
    job_interview_id: 1,
    job_id: 1,
    source_type: 'lark_minutes',
    purpose: 'unknown',
    status: 'pending_classification',
    reason: 'purpose_unclassified',
    assigned_session_id: null,
  }]);
  assert.equal(
    database.prepare('SELECT transcript FROM job_interview WHERE id = 1').get().transcript,
    '候选人张三面试：纯合成妙记转写',
    'candidate-looking content must remain uninspected and unclassified',
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session').get().n, 0, 'migration must not invent a candidate session');

  result = applyF006InterviewSessionMigration(database, { timestamp: '2026-07-11T00:01:00.000Z' });
  assert.equal(result.pending_classifications_added, 0, 'migration must be idempotent');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_pending_assignment').get().n, 1);

  rollbackF006InterviewSessionMigration(database);
  for (const table of F006_TABLES) assert.ok(!tableNames(database).includes(table), `${table} should be removed by rollback`);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM job_interview').get().n, 2, 'rollback must preserve legacy rows');
  assert.equal(database.prepare('SELECT transcript FROM job_interview WHERE id = 1').get().transcript, '候选人张三面试：纯合成妙记转写');

  result = applyF006InterviewSessionMigration(database, { timestamp: '2026-07-11T00:02:00.000Z' });
  assert.equal(result.pending_classifications_added, 1, 'migration must be re-applicable after rollback');
  database.close();

  fs.copyFileSync(MIGRATION_DB, CLI_ROLLBACK_DB);
  const rollbackRun = spawnSync(process.execPath, [
    path.join(__dirname, 'f006-interview-session-rollback.js'),
    '--db', CLI_ROLLBACK_DB,
    '--recovery-point', CLI_RECOVERY_POINT_DB,
  ], { encoding: 'utf8' });
  assert.equal(rollbackRun.status, 0, rollbackRun.stderr || rollbackRun.stdout);
  const rolledBack = new Database(CLI_ROLLBACK_DB, { readonly: true });
  for (const table of F006_TABLES) assert.ok(!tableNames(rolledBack).includes(table), 'rollback CLI must remove only F006 tables');
  assert.equal(rolledBack.prepare('SELECT COUNT(*) AS n FROM job_interview').get().n, 2);
  rolledBack.close();
  const cliRecovery = new Database(CLI_RECOVERY_POINT_DB, { readonly: true });
  for (const table of F006_TABLES) assert.ok(tableNames(cliRecovery).includes(table), 'rollback CLI recovery point must retain pre-rollback F006 state');
  cliRecovery.close();

  const recovery = new Database(RECOVERY_POINT_DB, { readonly: true });
  assert.equal(recovery.prepare('SELECT COUNT(*) AS n FROM job_interview').get().n, 2);
  for (const table of F006_TABLES) assert.ok(!tableNames(recovery).includes(table), 'recovery point must remain pre-F006');
  recovery.close();
}

function checkRejectedMigrationUpgrade() {
  const database = new Database(REJECTED_MIGRATION_UPGRADE_DB);
  createSyntheticLegacySchema(database);
  database.exec(`
    CREATE TABLE interview_session (
      id INTEGER PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE RESTRICT,
      job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
      round INTEGER NOT NULL DEFAULT 1,
      mode TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      scheduled_at TEXT,
      scheduled_confirmed_by TEXT,
      scheduled_confirmed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(candidate_id, job_id, round)
    );
    CREATE TABLE interview_pending_assignment (
      id INTEGER PRIMARY KEY,
      job_interview_id INTEGER NOT NULL UNIQUE REFERENCES job_interview(id) ON DELETE RESTRICT,
      job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
      source_type TEXT NOT NULL DEFAULT 'lark_minutes' CHECK(source_type = 'lark_minutes'),
      status TEXT NOT NULL DEFAULT 'pending_assignment' CHECK(status IN ('pending_assignment', 'assigned')),
      reason TEXT NOT NULL DEFAULT 'missing_candidate' CHECK(reason = 'missing_candidate'),
      assigned_session_id INTEGER,
      assigned_by TEXT,
      assigned_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO interview_session (
      id, candidate_id, job_id, round, mode, status, created_at, updated_at
    ) VALUES (
      1, 'C-SYNTHETIC-1', 1, 1, 'online', 'draft',
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z'
    );
    INSERT INTO job_interview VALUES (
      3, 1, 'https://example.test/minutes/explicit-assignment',
      '纯合成已显式归属妙记', '已显式归属', 'lark_minutes', '2026-07-11T00:05:00.000Z'
    );
    INSERT INTO interview_pending_assignment (
      job_interview_id, job_id, source_type, status, reason, created_at, updated_at
    ) VALUES (
      1, 1, 'lark_minutes', 'pending_assignment', 'missing_candidate',
      '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z'
    );
    INSERT INTO interview_pending_assignment (
      job_interview_id, job_id, source_type, status, reason,
      assigned_session_id, assigned_by, assigned_at, created_at, updated_at
    ) VALUES (
      3, 1, 'lark_minutes', 'assigned', 'missing_candidate',
      1, 'HR-旧显式操作者', '2026-07-11T00:06:00.000Z',
      '2026-07-11T00:05:00.000Z', '2026-07-11T00:06:00.000Z'
    );
  `);
  const result = applyF006InterviewSessionMigration(database, { timestamp: '2026-07-11T00:10:00.000Z' });
  assert.equal(result.classification_rows_upgraded, 2);
  assert.deepEqual(database.prepare(`
    SELECT purpose, status, reason, assigned_session_id
    FROM interview_pending_assignment WHERE job_interview_id = 1
  `).get(), {
    purpose: 'unknown',
    status: 'pending_classification',
    reason: 'purpose_unclassified',
    assigned_session_id: null,
  });
  assert.deepEqual(database.prepare(`
    SELECT purpose, status, reason, assigned_session_id, assigned_by
    FROM interview_pending_assignment WHERE job_interview_id = 3
  `).get(), {
    purpose: 'candidate_interview',
    status: 'assigned',
    reason: 'missing_candidate',
    assigned_session_id: 1,
    assigned_by: 'HR-旧显式操作者',
  });
  assert.deepEqual(database.prepare(`
    SELECT before_purpose, before_status, after_purpose, after_status, actor, classified_at
    FROM interview_pending_assignment_classification_audit
  `).all(), [{
    before_purpose: 'unknown',
    before_status: 'pending_classification',
    after_purpose: 'candidate_interview',
    after_status: 'pending_assignment',
    actor: 'HR-旧显式操作者',
    classified_at: '2026-07-11T00:06:00.000Z',
  }]);
  database.close();
}

function checkLegacyConsentLinkUpgrade() {
  const database = new Database(LEGACY_CONSENT_UPGRADE_DB);
  createSyntheticLegacySchema(database);
  database.exec(`
    CREATE TABLE interview_session (
      id INTEGER PRIMARY KEY,
      candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE RESTRICT,
      job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
      round INTEGER NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      scheduled_at TEXT,
      scheduled_confirmed_by TEXT,
      scheduled_confirmed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(candidate_id, job_id, round)
    );
    CREATE TABLE interview_session_consent (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES interview_session(id) ON DELETE CASCADE,
      consent_id INTEGER NOT NULL UNIQUE REFERENCES interview_recording_consent(id) ON DELETE RESTRICT,
      linked_by TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      UNIQUE(session_id, consent_id)
    );
    INSERT INTO interview_recording_consent (
      id, candidate_id, job_id, scope, status, consented_at, recorded_by
    ) VALUES (
      1, 'C-SYNTHETIC-1', 1, 'synthetic_scope', 'active',
      '2026-07-11T00:00:00.000Z', 'HR-旧授权记录人'
    );
    INSERT INTO interview_session (
      id, candidate_id, job_id, round, mode, status, created_at, updated_at
    ) VALUES
      (1, 'C-SYNTHETIC-1', 1, 1, 'offline', 'draft',
       '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z'),
      (2, 'C-SYNTHETIC-1', 1, 2, 'offline', 'draft',
       '2026-07-11T00:01:00.000Z', '2026-07-11T00:01:00.000Z');
    INSERT INTO interview_session_consent (
      id, session_id, consent_id, linked_by, linked_at
    ) VALUES (
      11, 1, 1, 'HR-旧关联人', '2026-07-11T00:02:00.000Z'
    );
  `);

  let result = applyF006InterviewSessionMigration(database, { timestamp: '2026-07-11T00:03:00.000Z' });
  assert.equal(result.consent_links_upgraded, 1, 'legacy consent links must be rebuilt exactly once');
  assert.deepEqual(database.prepare(`
    SELECT id, session_id, consent_id, linked_by, linked_at
    FROM interview_session_consent
  `).all(), [{
    id: 11,
    session_id: 1,
    consent_id: 1,
    linked_by: 'HR-旧关联人',
    linked_at: '2026-07-11T00:02:00.000Z',
  }], 'legacy consent links must be preserved byte-for-byte');

  const uniqueIndexes = database.prepare("PRAGMA index_list('interview_session_consent')").all()
    .filter((item) => Number(item.unique) === 1)
    .map((item) => database.prepare(`PRAGMA index_info('${String(item.name).replaceAll("'", "''")}')`).all()
      .sort((left, right) => Number(left.seqno) - Number(right.seqno))
      .map((column) => column.name));
  assert.ok(
    !uniqueIndexes.some((columns) => columns.length === 1 && columns[0] === 'consent_id'),
    'upgraded schema must remove the legacy column-level UNIQUE(consent_id)',
  );
  assert.ok(
    uniqueIndexes.some((columns) => columns.join(',') === 'session_id,consent_id'),
    'upgraded schema must retain UNIQUE(session_id, consent_id)',
  );

  database.prepare(`
    INSERT INTO interview_session_consent (
      session_id, consent_id, linked_by, linked_at
    ) VALUES (2, 1, 'HR-新一轮关联人', '2026-07-11T00:04:00.000Z')
  `).run();
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM interview_session_consent WHERE consent_id = 1').get().n,
    2,
    'one active consent must be reusable across distinct interview rounds',
  );
  assert.throws(() => database.prepare(`
    INSERT INTO interview_session_consent (
      session_id, consent_id, linked_by, linked_at
    ) VALUES (2, 1, 'HR-重复关联人', '2026-07-11T00:05:00.000Z')
  `).run(), /UNIQUE constraint/);

  result = applyF006InterviewSessionMigration(database, { timestamp: '2026-07-11T00:06:00.000Z' });
  assert.equal(result.consent_links_upgraded, 0, 'consent-link schema rebuild must be idempotent');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session_consent').get().n, 2);
  assert.deepEqual(database.pragma('foreign_key_check'), []);
  database.close();
}

function checkMigrationFailureAtomicity() {
  const database = new Database(FAILURE_DB);
  createSyntheticLegacySchema(database);
  // 让迁移在已创建部分对象后失败，验证同一事务会撤销本卡全部新对象。
  database.exec('CREATE VIEW interview_session_material AS SELECT 1 AS id');
  assert.throws(
    () => applyF006InterviewSessionMigration(database),
    /view|index|table/i,
  );
  assert.ok(!tableNames(database).includes('interview_session'), 'failed migration must not leave interview_session behind');
  assert.ok(!tableNames(database).includes('interview_session_schedule_confirmation'));
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM job_interview').get().n, 2, 'failed migration must preserve old records');
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'view' AND name = 'interview_session_material'").get().n, 1);
  database.close();
}

function seedJobAndCandidate(db, suffix, jobId = null) {
  const job = jobId
    ? { id: jobId }
    : db.upsertJob({
      encrypt_job_id: `f006-job-${suffix}`,
      numeric_job_id: `960000000000${suffix}`,
      name: `F006 合成岗位 ${suffix}`,
      hr_owner: 'HR',
    });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: `f006-geek-${suffix}`,
    source: 'fixture',
    name: `F006 合成候选人 ${suffix}`,
  });
  return { job, candidate };
}

function checkSessionModelAndRelations() {
  const db = require('./db');
  const database = db.openDb(API_DB);
  const first = seedJobAndCandidate(db, '101');
  const second = seedJobAndCandidate(db, '202');
  const sameJobOtherCandidate = seedJobAndCandidate(db, '103', first.job.id);

  const beforeInvalidCreate = database.prepare('SELECT COUNT(*) AS n FROM interview_session').get().n;
  assert.throws(
    () => db.createInterviewSession({ candidateId: first.candidate.internal_id, jobId: second.job.id, round: 1, mode: 'online' }),
    /does not belong/,
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session').get().n, beforeInvalidCreate, 'failed create must be atomic');
  assert.throws(() => db.createInterviewSession({ candidateId: first.candidate.internal_id, jobId: first.job.id, round: 0, mode: 'online' }), /positive integer/);
  assert.throws(() => db.createInterviewSession({ candidateId: first.candidate.internal_id, jobId: first.job.id, round: 1.5, mode: 'online' }), /positive integer/);
  assert.throws(() => db.createInterviewSession({ candidateId: first.candidate.internal_id, jobId: first.job.id, round: 1, mode: 'phone' }), /unsupported.*mode/);
  assert.throws(() => db.createInterviewSession({ candidateId: first.candidate.internal_id, jobId: first.job.id, round: 1, mode: 'online', status: 'ready' }), /unsupported.*status/);
  assert.throws(() => db.createInterviewSession({ candidateId: first.candidate.internal_id, jobId: first.job.id, round: 1, mode: 'online', status: 'scheduled' }), /manual schedule confirmation/);
  assert.throws(() => db.createInterviewSession({
    candidateId: first.candidate.internal_id,
    jobId: first.job.id,
    round: 1,
    mode: 'online',
    scheduledAt: FUTURE_SCHEDULE.canonical,
  }), /explicit manual schedule confirmation/);

  let session = db.createInterviewSession({
    candidateId: first.candidate.internal_id,
    jobId: first.job.id,
    round: 1,
    mode: 'online',
    status: 'draft',
  });
  assert.equal(session.round, 1);
  assert.equal(session.mode, 'online');
  assert.equal(session.status, 'draft');
  assert.equal(session.scheduled_at, null);
  const sessionId = session.id;
  assert.equal(db.createInterviewSession({
    candidateId: first.candidate.internal_id,
    jobId: first.job.id,
    round: 1,
    mode: 'online',
    status: 'draft',
  }).id, sessionId, 'same candidate/job/round create must be idempotent');
  assert.throws(() => db.createInterviewSession({
    candidateId: first.candidate.internal_id,
    jobId: first.job.id,
    round: 1,
    mode: 'offline',
    status: 'draft',
  }), /already exists/);

  assert.equal(db.listInterviewSessions({
    candidateId: first.candidate.internal_id,
    jobId: first.job.id,
    round: 1,
    mode: 'online',
    status: 'draft',
  }).length, 1, 'candidate/job/round/mode/status must be stably queryable');
  assert.throws(() => db.setInterviewSessionStatus({ sessionId, status: 'scheduled' }), /manual schedule confirmation/);
  assert.throws(() => db.setInterviewSessionStatus({ sessionId, status: 'unknown' }), /unsupported.*status/);
  assert.throws(() => database.prepare(`
    UPDATE interview_session
    SET scheduled_at = '${FUTURE_SCHEDULE.canonical}',
        scheduled_confirmed_by = 'model',
        scheduled_confirmed_at = '2026-07-11T00:00:00.000Z'
    WHERE id = ?
  `).run(sessionId), /manual confirmation/);
  assert.equal(db.getInterviewSession(sessionId).scheduled_at, null);
  assert.throws(() => db.confirmInterviewSessionSchedule({ sessionId, scheduledAt: FUTURE_SCHEDULE.canonical, confirmedBy: 'HR' }), /confirmed=true/);
  assert.throws(() => db.confirmInterviewSessionSchedule({ sessionId, scheduledAt: 'not-a-date', confirmedBy: 'HR', confirmed: true }), /valid explicit date-time/);
  assert.throws(() => db.confirmInterviewSessionSchedule({ sessionId, scheduledAt: FUTURE_SCHEDULE.canonical, confirmedBy: '', confirmed: true }), /confirmedBy/);
  assert.throws(
    () => db.confirmInterviewSessionSchedule({ sessionId, scheduledAt: PAST_SCHEDULE, confirmedBy: 'HR-合成人员', confirmed: true }),
    (error) => error.code === 'INTERVIEW_SCHEDULE_IN_PAST',
    'the data layer must reject an explicitly confirmed schedule in the past',
  );

  session = db.confirmInterviewSessionSchedule({
    sessionId,
    scheduledAt: FUTURE_SCHEDULE.input,
    confirmedBy: 'HR-合成人员',
    confirmed: true,
  });
  assert.equal(session.status, 'scheduled');
  assert.equal(session.scheduled_at, FUTURE_SCHEDULE.canonical, 'the +08:00 input must retain stable UTC serialization');
  assert.equal(session.scheduled_confirmed_by, 'HR-合成人员');
  assert.equal(session.schedule_confirmations.length, 1);
  assert.equal(session.schedule_confirmations[0].source, 'manual');

  assert.throws(() => database.prepare(`
    INSERT INTO interview_session (
      candidate_id, job_id, round, mode, status, created_at, updated_at
    ) VALUES (?, ?, 2, 'online', 'draft', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z')
  `).run(first.candidate.internal_id, second.job.id), /candidate\/job mismatch/);
  assert.throws(() => database.prepare(`
    INSERT INTO interview_session (
      candidate_id, job_id, round, mode, status, created_at, updated_at
    ) VALUES (?, ?, -1, 'online', 'draft', '2026-07-11T00:00:00.000Z', '2026-07-11T00:00:00.000Z')
  `).run(first.candidate.internal_id, first.job.id), /CHECK constraint/);

  const insertLegacy = database.prepare(`
    INSERT INTO job_interview (job_id, source_url, transcript, note, source_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const onlineFirstId = Number(insertLegacy.run(
    first.job.id,
    'https://example.test/minutes/candidate-li-lei',
    '候选人李雷面试表现很好，纯合成文本',
    '李雷候选人面试',
    'lark_minutes',
    '2026-07-11T01:00:00.000Z',
  ).lastInsertRowid);
  const onlineSecondId = Number(insertLegacy.run(
    second.job.id,
    'https://example.test/minutes/f006-second',
    '纯合成线上妙记内容二',
    '不含姓名推断逻辑',
    'lark_minutes',
    '2026-07-11T02:00:00.000Z',
  ).lastInsertRowid);
  const profileInterviewId = Number(insertLegacy.run(
    first.job.id,
    'https://example.test/minutes/profile-manager',
    '用人负责人讨论岗位画像，纯合成文本',
    '岗位画像访谈',
    'lark_minutes',
    '2026-07-11T02:30:00.000Z',
  ).lastInsertRowid);
  insertLegacy.run(
    first.job.id,
    null,
    '纯合成手工转写',
    '手工材料',
    'manual_transcript',
    '2026-07-11T03:00:00.000Z',
  );
  const pending = db.listInterviewPendingAssignments({ purpose: 'unknown', status: 'pending_classification' });
  assert.deepEqual(
    pending.map((item) => item.job_interview_id).sort((a, b) => a - b),
    [onlineFirstId, onlineSecondId, profileInterviewId],
    'all legacy lark minutes must wait for manual purpose classification regardless of content/title/url',
  );
  assert.equal(db.listInterviewPendingAssignments({ status: 'pending_assignment' }).length, 0, 'migration must never auto-enter pending_assignment');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session').get().n, 1, 'legacy online rows must not create pseudo sessions');
  const pendingColumns = database.prepare("PRAGMA table_info('interview_pending_assignment')").all().map((item) => item.name);
  assert.ok(!pendingColumns.includes('candidate_id') && !pendingColumns.includes('candidate_name'), 'pending assignment must carry no guessed candidate identity');

  const pendingFirst = pending.find((item) => item.job_interview_id === onlineFirstId);
  const pendingSecond = pending.find((item) => item.job_interview_id === onlineSecondId);
  const pendingProfile = pending.find((item) => item.job_interview_id === profileInterviewId);
  assert.throws(() => db.assignInterviewPendingAssignment({
    pendingAssignmentId: pendingFirst.id,
    sessionId,
    assignedBy: 'HR-合成人员',
  }), /explicitly classified as candidate_interview/);
  assert.throws(() => db.classifyInterviewPendingAssignment({
    pendingAssignmentId: pendingFirst.id,
    purpose: 'candidate_interview',
  }), /actor/);
  assert.throws(() => db.classifyInterviewPendingAssignment({
    pendingAssignmentId: pendingFirst.id,
    purpose: 'unknown',
    actor: 'HR-合成人员',
  }), /unsupported manual interview purpose/);
  assert.throws(() => database.prepare(`
    UPDATE interview_pending_assignment
    SET purpose = 'candidate_interview', status = 'pending_assignment',
        reason = 'missing_candidate', updated_at = '2026-07-11T03:10:00.000Z'
    WHERE id = ?
  `).run(pendingFirst.id), /explicit audit/);

  let classified = db.classifyInterviewPendingAssignment({
    pendingAssignmentId: pendingSecond.id,
    purpose: 'candidate_interview',
    actor: 'HR-合成人员',
  });
  assert.equal(classified.status, 'pending_assignment');
  assert.throws(() => db.assignInterviewPendingAssignment({
    pendingAssignmentId: pendingSecond.id,
    sessionId,
    assignedBy: 'HR-合成人员',
  }), /another job/);
  assert.equal(database.prepare('SELECT status FROM interview_pending_assignment WHERE id = ?').get(pendingSecond.id).status, 'pending_assignment');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session_material WHERE job_interview_id = ?').get(onlineSecondId).n, 0, 'failed assignment must leave no partial mapping');

  classified = db.classifyInterviewPendingAssignment({
    pendingAssignmentId: pendingFirst.id,
    purpose: 'candidate_interview',
    actor: 'HR-合成人员',
  });
  assert.equal(classified.purpose, 'candidate_interview');
  assert.equal(classified.status, 'pending_assignment');
  let classificationAudits = db.listInterviewPendingAssignmentClassificationAudits(pendingFirst.id);
  assert.deepEqual(classificationAudits.map((item) => ({
    before_purpose: item.before_purpose,
    before_status: item.before_status,
    after_purpose: item.after_purpose,
    after_status: item.after_status,
    actor: item.actor,
  })), [{
    before_purpose: 'unknown',
    before_status: 'pending_classification',
    after_purpose: 'candidate_interview',
    after_status: 'pending_assignment',
    actor: 'HR-合成人员',
  }]);
  assert.ok(classificationAudits[0].classified_at);
  classified = db.classifyInterviewPendingAssignment({
    pendingAssignmentId: pendingFirst.id,
    purpose: 'candidate_interview',
    actor: 'HR-合成人员',
  });
  assert.equal(classified.status, 'pending_assignment');
  assert.equal(db.listInterviewPendingAssignmentClassificationAudits(pendingFirst.id).length, 1, 'duplicate classification must be idempotent');
  assert.throws(() => db.classifyInterviewPendingAssignment({
    pendingAssignmentId: pendingFirst.id,
    purpose: 'hiring_manager_profile_interview',
    actor: 'HR-合成人员',
  }), /illegal interview purpose transition/);

  classified = db.classifyInterviewPendingAssignment({
    pendingAssignmentId: pendingProfile.id,
    purpose: 'hiring_manager_profile_interview',
    actor: 'HR-合成人员',
  });
  assert.equal(classified.status, 'excluded');
  classificationAudits = db.listInterviewPendingAssignmentClassificationAudits(pendingProfile.id);
  assert.equal(classificationAudits.length, 1);
  assert.equal(classificationAudits[0].before_purpose, 'unknown');
  assert.equal(classificationAudits[0].before_status, 'pending_classification');
  assert.equal(classificationAudits[0].after_purpose, 'hiring_manager_profile_interview');
  assert.equal(classificationAudits[0].after_status, 'excluded');
  assert.throws(() => db.assignInterviewPendingAssignment({
    pendingAssignmentId: pendingProfile.id,
    sessionId,
    assignedBy: 'HR-合成人员',
  }), /explicitly classified as candidate_interview/);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session_material WHERE job_interview_id = ?').get(profileInterviewId).n, 0);
  assert.equal(
    database.prepare('SELECT transcript FROM job_interview WHERE id = ?').get(profileInterviewId).transcript,
    '用人负责人讨论岗位画像，纯合成文本',
    'excluded profile interview must remain in the legacy profile-interview chain',
  );
  assert.throws(() => db.classifyInterviewPendingAssignment({
    pendingAssignmentId: pendingProfile.id,
    purpose: 'candidate_interview',
    actor: 'HR-合成人员',
  }), /illegal interview purpose transition/);

  let assignment = db.assignInterviewPendingAssignment({
    pendingAssignmentId: pendingFirst.id,
    sessionId,
    assignedBy: 'HR-合成人员',
  });
  assert.equal(assignment.status, 'assigned');
  assignment = db.assignInterviewPendingAssignment({
    pendingAssignmentId: pendingFirst.id,
    sessionId,
    assignedBy: 'HR-合成人员',
  });
  assert.equal(assignment.assigned_session_id, sessionId);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session_material WHERE job_interview_id = ?').get(onlineFirstId).n, 1, 'duplicate online mapping must be idempotent');

  const offlineSession = db.createInterviewSession({
    candidateId: first.candidate.internal_id,
    jobId: first.job.id,
    round: 2,
    mode: 'offline',
    status: 'draft',
  });

  const recordingId = Number(database.prepare(`
    INSERT INTO interview_recording (candidate_id, job_id, status, created_at, updated_at)
    VALUES (?, ?, 'matched', ?, ?)
  `).run(
    first.candidate.internal_id,
    first.job.id,
    '2026-07-11T04:00:00.000Z',
    '2026-07-11T04:00:00.000Z',
  ).lastInsertRowid);
  assert.throws(() => db.linkInterviewSessionRecording({
    sessionId,
    recordingId,
    linkedBy: 'HR-合成人员',
  }), /offline interview session/);
  let recordingLink = db.linkInterviewSessionRecording({ sessionId: offlineSession.id, recordingId, linkedBy: 'HR-合成人员' });
  assert.equal(recordingLink.material_kind, 'offline_recording');
  recordingLink = db.linkInterviewSessionRecording({ sessionId: offlineSession.id, recordingId, linkedBy: 'HR-合成人员' });
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session_material WHERE interview_recording_id = ?').get(recordingId).n, 1, 'duplicate recording mapping must be idempotent');

  const otherSession = db.createInterviewSession({
    candidateId: sameJobOtherCandidate.candidate.internal_id,
    jobId: first.job.id,
    round: 1,
    mode: 'offline',
  });
  assert.throws(() => db.linkInterviewSessionRecording({
    sessionId: otherSession.id,
    recordingId,
    linkedBy: 'HR-合成人员',
  }), /another candidate|already linked/);
  const otherOnlineSession = db.createInterviewSession({
    candidateId: sameJobOtherCandidate.candidate.internal_id,
    jobId: first.job.id,
    round: 2,
    mode: 'online',
  });
  assert.throws(() => db.assignInterviewPendingAssignment({
    pendingAssignmentId: pendingFirst.id,
    sessionId: otherOnlineSession.id,
    assignedBy: 'HR-合成人员',
  }), /already assigned/);

  const reportId = Number(database.prepare(`
    INSERT INTO interview_ai_report (
      recording_id, candidate_id, job_id, status, report_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'draft', '{}', ?, ?)
  `).run(
    recordingId,
    first.candidate.internal_id,
    first.job.id,
    '2026-07-11T05:00:00.000Z',
    '2026-07-11T05:00:00.000Z',
  ).lastInsertRowid);
  const consentId = Number(database.prepare(`
    INSERT INTO interview_recording_consent (
      candidate_id, job_id, scope, status, consented_at, recorded_by, source,
      created_at, updated_at
    ) VALUES (?, ?, 'synthetic_scope', 'active', ?, 'HR-合成人员', 'synthetic', ?, ?)
  `).run(
    first.candidate.internal_id,
    first.job.id,
    '2026-07-11T05:10:00.000Z',
    '2026-07-11T05:10:00.000Z',
    '2026-07-11T05:10:00.000Z',
  ).lastInsertRowid);
  const confirmationId = Number(database.prepare(`
    INSERT INTO interview_recording_confirmation (
      recording_id, field_key, status, confirmed_at, created_at, updated_at
    ) VALUES (?, 'synthetic_field', 'confirmed', ?, ?, ?)
  `).run(
    recordingId,
    '2026-07-11T05:20:00.000Z',
    '2026-07-11T05:20:00.000Z',
    '2026-07-11T05:20:00.000Z',
  ).lastInsertRowid);

  db.linkInterviewSessionReport({ sessionId: offlineSession.id, reportId, linkedBy: 'HR-合成人员' });
  db.linkInterviewSessionReport({ sessionId: offlineSession.id, reportId, linkedBy: 'HR-合成人员' });
  const consentAuditCountBefore = database.prepare(`
    SELECT COUNT(*) AS n FROM audit_log WHERE action = '面试录音授权关联 Session'
  `).get().n;
  const firstConsentLink = db.linkInterviewSessionConsent({
    sessionId: offlineSession.id,
    consentId,
    linkedBy: 'HR-合成人员',
  });
  const replayedConsentLink = db.linkInterviewSessionConsent({
    sessionId: offlineSession.id,
    consentId,
    linkedBy: 'HR-重复请求不应覆盖',
  });
  assert.equal(replayedConsentLink.id, firstConsentLink.id, 'same session consent replay must be idempotent');
  assert.equal(replayedConsentLink.linked_by, 'HR-合成人员', 'same session replay must preserve the original link');
  const consentReuseSession = db.createInterviewSession({
    candidateId: first.candidate.internal_id,
    jobId: first.job.id,
    round: 3,
    mode: 'offline',
    status: 'draft',
  });
  const secondConsentLink = db.linkInterviewSessionConsent({
    sessionId: consentReuseSession.id,
    consentId,
    linkedBy: 'HR-第二轮合成人员',
  });
  const replayedSecondConsentLink = db.linkInterviewSessionConsent({
    sessionId: consentReuseSession.id,
    consentId,
    linkedBy: 'HR-第二轮重复请求',
  });
  assert.notEqual(secondConsentLink.id, firstConsentLink.id, 'a new session must receive its own consent link');
  assert.equal(replayedSecondConsentLink.id, secondConsentLink.id);
  assert.equal(
    database.prepare(`
      SELECT COUNT(*) AS n FROM audit_log
      WHERE action = '面试录音授权关联 Session'
    `).get().n - consentAuditCountBefore,
    2,
    'each distinct session link must write one audit while replays write none',
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM interview_session_consent WHERE consent_id = ?').get(consentId).n,
    2,
    'the same consent must link to multiple distinct interview sessions',
  );
  assert.equal(db.getInterviewSession(consentReuseSession.id).consents.length, 1);
  db.linkInterviewSessionConfirmation({ sessionId: offlineSession.id, confirmationId, linkedBy: 'HR-合成人员' });
  db.linkInterviewSessionConfirmation({ sessionId: offlineSession.id, confirmationId, linkedBy: 'HR-合成人员' });
  session = db.getInterviewSession(offlineSession.id);
  assert.equal(session.materials.length, 1);
  assert.equal(session.reports.length, 1);
  assert.equal(session.consents.length, 1);
  assert.equal(session.confirmations.length, 1);

  const wrongConsentId = Number(database.prepare(`
    INSERT INTO interview_recording_consent (
      candidate_id, job_id, scope, status, consented_at, recorded_by, source,
      created_at, updated_at
    ) VALUES (?, ?, 'synthetic_scope', 'active', ?, 'HR-合成人员', 'synthetic', ?, ?)
  `).run(
    second.candidate.internal_id,
    second.job.id,
    '2026-07-11T05:30:00.000Z',
    '2026-07-11T05:30:00.000Z',
    '2026-07-11T05:30:00.000Z',
  ).lastInsertRowid);
  assert.throws(() => db.linkInterviewSessionConsent({
    sessionId: offlineSession.id,
    consentId: wrongConsentId,
    linkedBy: 'HR-合成人员',
  }), /does not match/);

  assert.throws(() => database.prepare('DELETE FROM candidate WHERE internal_id = ?').run(first.candidate.internal_id), /FOREIGN KEY constraint/);
  assert.throws(() => database.prepare('DELETE FROM job WHERE id = ?').run(first.job.id), /FOREIGN KEY constraint/);

  const deletable = seedJobAndCandidate(db, '303');
  const deletableSession = db.createInterviewSession({
    candidateId: deletable.candidate.internal_id,
    jobId: deletable.job.id,
    round: 1,
    mode: 'offline',
  });
  const deletableRecordingId = Number(database.prepare(`
    INSERT INTO interview_recording (candidate_id, job_id, status, created_at, updated_at)
    VALUES (?, ?, 'matched', ?, ?)
  `).run(
    deletable.candidate.internal_id,
    deletable.job.id,
    '2026-07-11T06:00:00.000Z',
    '2026-07-11T06:00:00.000Z',
  ).lastInsertRowid);
  db.linkInterviewSessionRecording({
    sessionId: deletableSession.id,
    recordingId: deletableRecordingId,
    linkedBy: 'HR-合成人员',
  });
  database.prepare('DELETE FROM interview_session WHERE id = ?').run(deletableSession.id);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session_material WHERE session_id = ?').get(deletableSession.id).n, 0, 'session-owned mappings must cascade on session delete');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_recording WHERE id = ?').get(deletableRecordingId).n, 1, 'session delete must preserve old material rows');
  assert.deepEqual(database.pragma('foreign_key_check'), [], 'F006 synthetic database must have no foreign-key violations');

  database.close();
}

checkMigrationAndRollback();
checkRejectedMigrationUpgrade();
checkLegacyConsentLinkUpgrade();
checkMigrationFailureAtomicity();
checkSessionModelAndRelations();
console.log('check-f006-interview-session ok');
