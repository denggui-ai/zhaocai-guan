'use strict';

const INTERVIEW_LOGISTICS_TABLES = Object.freeze([
  'interview_interviewer',
  'interview_session_interviewer',
]);

const INTERVIEW_SESSION_LOGISTICS_COLUMNS = Object.freeze([
  'interview_format',
  'duration_minutes',
  'meeting_platform',
  'meeting_link',
  'location_address',
  'location_room',
  'logistics_note',
  'invitation_status',
  'invitation_sent_by',
  'invitation_sent_at',
  'candidate_confirmation_status',
  'candidate_confirmation_recorded_by',
  'candidate_confirmation_recorded_at',
  'logistics_version',
]);

const SCHEDULE_LOGISTICS_COLUMNS = Object.freeze([
  'logistics_snapshot_json',
  'logistics_snapshot_sha256',
]);

const INTERVIEW_LOGISTICS_INDEXES = Object.freeze([
  'interview_interviewer_active_name_idx',
  'interview_session_interviewer_session_idx',
  'interview_session_interviewer_unique',
  'interview_session_single_lead',
]);

const INTERVIEW_LOGISTICS_TRIGGERS = Object.freeze([
  'interview_session_logistics_insert_guard',
  'interview_session_logistics_update_guard',
  'interview_session_interviewer_session_match_guard',
  'interview_session_schedule_confirmation_immutable',
]);

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnNames(database, table) {
  if (!tableExists(database, table)) return new Set();
  return new Set(database.prepare(`PRAGMA table_info('${String(table).replaceAll("'", "''")}')`).all().map((row) => row.name));
}

function addColumn(database, table, definition) {
  const name = definition.trim().split(/\s+/)[0];
  if (!columnNames(database, table).has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function migrationResult() {
  return {
    tables: [...INTERVIEW_LOGISTICS_TABLES],
    interview_session_columns: [...INTERVIEW_SESSION_LOGISTICS_COLUMNS],
    schedule_confirmation_columns: [...SCHEDULE_LOGISTICS_COLUMNS],
  };
}

function interviewLogisticsSchemaCurrent(database) {
  if (INTERVIEW_LOGISTICS_TABLES.some((name) => !tableExists(database, name))) return false;
  const sessionColumns = columnNames(database, 'interview_session');
  const historyColumns = columnNames(database, 'interview_session_schedule_confirmation');
  if (INTERVIEW_SESSION_LOGISTICS_COLUMNS.some((name) => !sessionColumns.has(name))
      || SCHEDULE_LOGISTICS_COLUMNS.some((name) => !historyColumns.has(name))) return false;
  const objects = database.prepare(`
    SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger')
  `).all();
  const indexes = new Set(objects.filter((row) => row.type === 'index').map((row) => row.name));
  const triggers = new Set(objects.filter((row) => row.type === 'trigger').map((row) => row.name));
  const insertGuard = objects.find((row) => row.type === 'trigger' && row.name === 'interview_session_logistics_insert_guard');
  return INTERVIEW_LOGISTICS_INDEXES.every((name) => indexes.has(name))
    && INTERVIEW_LOGISTICS_TRIGGERS.every((name) => triggers.has(name))
    && String(insertGuard && insertGuard.sql || '').includes('core_candidate.internal_id')
    && String(insertGuard && insertGuard.sql || '').includes("NEW.status <> 'scheduled'");
}

function applyInterviewLogisticsDataMigration(database) {
  if (!database || typeof database.exec !== 'function') throw new Error('database is required');
  if (!tableExists(database, 'interview_session') || !tableExists(database, 'interview_session_schedule_confirmation')) {
    throw new Error('F006 interview session schema is required before interview logistics migration');
  }
  if (interviewLogisticsSchemaCurrent(database)) return migrationResult();

  return database.transaction(() => {
    addColumn(database, 'interview_session', 'interview_format TEXT');
    addColumn(database, 'interview_session', 'duration_minutes INTEGER');
    addColumn(database, 'interview_session', 'meeting_platform TEXT');
    addColumn(database, 'interview_session', 'meeting_link TEXT');
    addColumn(database, 'interview_session', 'location_address TEXT');
    addColumn(database, 'interview_session', 'location_room TEXT');
    addColumn(database, 'interview_session', 'logistics_note TEXT');
    addColumn(database, 'interview_session', "invitation_status TEXT NOT NULL DEFAULT 'draft'");
    addColumn(database, 'interview_session', 'invitation_sent_by TEXT');
    addColumn(database, 'interview_session', 'invitation_sent_at TEXT');
    addColumn(database, 'interview_session', "candidate_confirmation_status TEXT NOT NULL DEFAULT 'pending'");
    addColumn(database, 'interview_session', 'candidate_confirmation_recorded_by TEXT');
    addColumn(database, 'interview_session', 'candidate_confirmation_recorded_at TEXT');
    addColumn(database, 'interview_session', 'logistics_version INTEGER NOT NULL DEFAULT 0');
    addColumn(database, 'interview_session_schedule_confirmation', 'logistics_snapshot_json TEXT');
    addColumn(database, 'interview_session_schedule_confirmation', 'logistics_snapshot_sha256 TEXT');

  // Existing F006 rows only expose online/offline mode. This deterministic copy is
  // the only truthful backfill available; no duration, people or address is guessed.
    database.exec(`
    UPDATE interview_session
    SET interview_format = CASE mode WHEN 'online' THEN 'online' ELSE 'offline' END
    WHERE interview_format IS NULL OR TRIM(interview_format) = '';

    CREATE TABLE IF NOT EXISTS interview_interviewer (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL CHECK(LENGTH(TRIM(name)) > 0),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS interview_session_interviewer (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES interview_session(id) ON DELETE CASCADE,
      interviewer_id INTEGER NOT NULL REFERENCES interview_interviewer(id) ON DELETE RESTRICT,
      interviewer_name_snapshot TEXT NOT NULL CHECK(LENGTH(TRIM(interviewer_name_snapshot)) > 0),
      role TEXT NOT NULL CHECK(role IN ('lead', 'participant')),
      assigned_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS interview_interviewer_active_name_idx
    ON interview_interviewer(active, name, id);

    CREATE INDEX IF NOT EXISTS interview_session_interviewer_session_idx
    ON interview_session_interviewer(session_id, role, id);

    CREATE UNIQUE INDEX IF NOT EXISTS interview_session_interviewer_unique
    ON interview_session_interviewer(session_id, interviewer_id);

    CREATE UNIQUE INDEX IF NOT EXISTS interview_session_single_lead
    ON interview_session_interviewer(session_id)
    WHERE role = 'lead';

    DROP TRIGGER IF EXISTS interview_session_logistics_insert_guard;
    DROP TRIGGER IF EXISTS interview_session_logistics_update_guard;
    DROP TRIGGER IF EXISTS interview_session_interviewer_session_match_guard;
    DROP TRIGGER IF EXISTS interview_session_schedule_confirmation_immutable;

    CREATE TRIGGER interview_session_logistics_insert_guard
    BEFORE INSERT ON interview_session
    FOR EACH ROW
    WHEN NEW.created_at IS NOT NULL
      AND NEW.updated_at IS NOT NULL
      AND typeof(NEW.round) = 'integer' AND NEW.round > 0
      AND NEW.mode IN ('online', 'offline')
      AND NEW.status IN ('draft', 'scheduled', 'in_progress', 'pending_review', 'confirmed', 'cancelled')
      AND NEW.status <> 'scheduled'
      AND NEW.scheduled_at IS NULL
      AND NEW.scheduled_confirmed_by IS NULL
      AND NEW.scheduled_confirmed_at IS NULL
      AND EXISTS (
        SELECT 1 FROM candidate core_candidate
        WHERE core_candidate.internal_id = NEW.candidate_id
          AND core_candidate.job_id = NEW.job_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM interview_session core_session
        WHERE core_session.candidate_id = NEW.candidate_id
          AND core_session.job_id = NEW.job_id
          AND core_session.round = NEW.round
      )
      AND (NEW.id IS NULL OR NOT EXISTS (
        SELECT 1 FROM interview_session core_id WHERE core_id.id = NEW.id
      ))
      AND (
        NEW.interview_format IS NULL OR TRIM(NEW.interview_format) = ''
      OR NEW.interview_format NOT IN ('online', 'offline', 'phone')
      OR (NEW.interview_format = 'online' AND NEW.mode <> 'online')
      OR (NEW.interview_format IN ('offline', 'phone') AND NEW.mode <> 'offline')
      OR NEW.invitation_status IS NULL OR NEW.invitation_status NOT IN ('draft', 'sent')
      OR (NEW.invitation_status = 'draft' AND (NEW.invitation_sent_by IS NOT NULL OR NEW.invitation_sent_at IS NOT NULL))
      OR (NEW.invitation_status = 'sent' AND (
        NEW.invitation_sent_by IS NULL OR TRIM(NEW.invitation_sent_by) = ''
        OR NEW.invitation_sent_at IS NULL OR TRIM(NEW.invitation_sent_at) = ''
      ))
      OR NEW.candidate_confirmation_status IS NULL
      OR NEW.candidate_confirmation_status NOT IN ('pending', 'confirmed', 'declined', 'reschedule_requested')
      OR ((NEW.candidate_confirmation_recorded_by IS NULL) <> (NEW.candidate_confirmation_recorded_at IS NULL))
      OR (NEW.candidate_confirmation_status <> 'pending' AND (
        NEW.candidate_confirmation_recorded_by IS NULL OR TRIM(NEW.candidate_confirmation_recorded_by) = ''
        OR NEW.candidate_confirmation_recorded_at IS NULL OR TRIM(NEW.candidate_confirmation_recorded_at) = ''
      ))
      OR NEW.logistics_version IS NULL OR typeof(NEW.logistics_version) <> 'integer' OR NEW.logistics_version < 0
      OR (NEW.duration_minutes IS NOT NULL AND (typeof(NEW.duration_minutes) <> 'integer' OR NEW.duration_minutes < 5 OR NEW.duration_minutes > 480))
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid interview session logistics');
    END;

    CREATE TRIGGER interview_session_logistics_update_guard
    BEFORE UPDATE OF mode, interview_format, duration_minutes,
      invitation_status, invitation_sent_by, invitation_sent_at,
      candidate_confirmation_status, candidate_confirmation_recorded_by,
      candidate_confirmation_recorded_at, logistics_version ON interview_session
    FOR EACH ROW
    WHEN NEW.interview_format IS NULL OR TRIM(NEW.interview_format) = ''
      OR NEW.interview_format NOT IN ('online', 'offline', 'phone')
      OR (NEW.interview_format = 'online' AND NEW.mode <> 'online')
      OR (NEW.interview_format IN ('offline', 'phone') AND NEW.mode <> 'offline')
      OR NEW.invitation_status IS NULL OR NEW.invitation_status NOT IN ('draft', 'sent')
      OR (NEW.invitation_status = 'draft' AND (NEW.invitation_sent_by IS NOT NULL OR NEW.invitation_sent_at IS NOT NULL))
      OR (NEW.invitation_status = 'sent' AND (
        NEW.invitation_sent_by IS NULL OR TRIM(NEW.invitation_sent_by) = ''
        OR NEW.invitation_sent_at IS NULL OR TRIM(NEW.invitation_sent_at) = ''
      ))
      OR NEW.candidate_confirmation_status IS NULL
      OR NEW.candidate_confirmation_status NOT IN ('pending', 'confirmed', 'declined', 'reschedule_requested')
      OR ((NEW.candidate_confirmation_recorded_by IS NULL) <> (NEW.candidate_confirmation_recorded_at IS NULL))
      OR (NEW.candidate_confirmation_status <> 'pending' AND (
        NEW.candidate_confirmation_recorded_by IS NULL OR TRIM(NEW.candidate_confirmation_recorded_by) = ''
        OR NEW.candidate_confirmation_recorded_at IS NULL OR TRIM(NEW.candidate_confirmation_recorded_at) = ''
      ))
      OR NEW.logistics_version IS NULL OR typeof(NEW.logistics_version) <> 'integer' OR NEW.logistics_version < 0
      OR (NEW.duration_minutes IS NOT NULL AND (typeof(NEW.duration_minutes) <> 'integer' OR NEW.duration_minutes < 5 OR NEW.duration_minutes > 480))
    BEGIN
      SELECT RAISE(ABORT, 'invalid interview session logistics');
    END;

    CREATE TRIGGER interview_session_interviewer_session_match_guard
    BEFORE INSERT ON interview_session_interviewer
    FOR EACH ROW
    WHEN NOT EXISTS (
      SELECT 1
      FROM interview_session session
      JOIN interview_interviewer interviewer ON interviewer.id = NEW.interviewer_id
      WHERE session.id = NEW.session_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'interview session or interviewer not found');
    END;

    CREATE TRIGGER interview_session_schedule_confirmation_immutable
    BEFORE UPDATE ON interview_session_schedule_confirmation
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'interview schedule confirmation history is immutable');
    END;
  `);

    return migrationResult();
  })();
}

module.exports = {
  INTERVIEW_LOGISTICS_INDEXES,
  INTERVIEW_LOGISTICS_TABLES,
  INTERVIEW_LOGISTICS_TRIGGERS,
  INTERVIEW_SESSION_LOGISTICS_COLUMNS,
  SCHEDULE_LOGISTICS_COLUMNS,
  applyInterviewLogisticsDataMigration,
};
