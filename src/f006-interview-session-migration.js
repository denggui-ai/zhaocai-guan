const F006_TABLES = Object.freeze([
  'interview_session',
  'interview_session_schedule_confirmation',
  'interview_session_material',
  'interview_session_report',
  'interview_session_consent',
  'interview_session_confirmation',
  'interview_pending_assignment',
  'interview_pending_assignment_classification_audit',
]);

const PENDING_ASSIGNMENT_TABLE_SCHEMA = `
CREATE TABLE IF NOT EXISTS interview_pending_assignment (
  id INTEGER PRIMARY KEY,
  job_interview_id INTEGER NOT NULL UNIQUE REFERENCES job_interview(id) ON DELETE RESTRICT,
  job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL DEFAULT 'lark_minutes' CHECK(source_type = 'lark_minutes'),
  purpose TEXT NOT NULL DEFAULT 'unknown'
    CHECK(purpose IN ('unknown', 'candidate_interview', 'hiring_manager_profile_interview')),
  status TEXT NOT NULL DEFAULT 'pending_classification'
    CHECK(status IN ('pending_classification', 'pending_assignment', 'assigned', 'excluded')),
  reason TEXT NOT NULL DEFAULT 'purpose_unclassified'
    CHECK(reason IN ('purpose_unclassified', 'missing_candidate', 'hiring_manager_profile_interview')),
  assigned_session_id INTEGER REFERENCES interview_session(id) ON DELETE RESTRICT,
  assigned_by TEXT,
  assigned_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(
    (purpose = 'unknown' AND status = 'pending_classification' AND reason = 'purpose_unclassified'
      AND assigned_session_id IS NULL AND assigned_by IS NULL AND assigned_at IS NULL)
    OR
    (purpose = 'candidate_interview' AND status = 'pending_assignment' AND reason = 'missing_candidate'
      AND assigned_session_id IS NULL AND assigned_by IS NULL AND assigned_at IS NULL)
    OR
    (purpose = 'candidate_interview' AND status = 'assigned' AND reason = 'missing_candidate'
      AND assigned_session_id IS NOT NULL
      AND assigned_by IS NOT NULL AND LENGTH(TRIM(assigned_by)) > 0
      AND assigned_at IS NOT NULL AND LENGTH(TRIM(assigned_at)) > 0)
    OR
    (purpose = 'hiring_manager_profile_interview' AND status = 'excluded'
      AND reason = 'hiring_manager_profile_interview'
      AND assigned_session_id IS NULL AND assigned_by IS NULL AND assigned_at IS NULL)
  )
);
`;

const PENDING_ASSIGNMENT_AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS interview_pending_assignment_classification_audit (
  id INTEGER PRIMARY KEY,
  pending_assignment_id INTEGER NOT NULL REFERENCES interview_pending_assignment(id) ON DELETE CASCADE,
  before_purpose TEXT NOT NULL
    CHECK(before_purpose IN ('unknown', 'candidate_interview', 'hiring_manager_profile_interview')),
  before_status TEXT NOT NULL
    CHECK(before_status IN ('pending_classification', 'pending_assignment', 'assigned', 'excluded')),
  after_purpose TEXT NOT NULL
    CHECK(after_purpose IN ('unknown', 'candidate_interview', 'hiring_manager_profile_interview')),
  after_status TEXT NOT NULL
    CHECK(after_status IN ('pending_classification', 'pending_assignment', 'assigned', 'excluded')),
  actor TEXT NOT NULL CHECK(LENGTH(TRIM(actor)) > 0),
  classified_at TEXT NOT NULL CHECK(LENGTH(TRIM(classified_at)) > 0),
  created_at TEXT NOT NULL
);
`;

const INTERVIEW_SESSION_CONSENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS interview_session_consent (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES interview_session(id) ON DELETE CASCADE,
  consent_id INTEGER NOT NULL REFERENCES interview_recording_consent(id) ON DELETE RESTRICT,
  linked_by TEXT NOT NULL CHECK(LENGTH(TRIM(linked_by)) > 0),
  linked_at TEXT NOT NULL,
  UNIQUE(session_id, consent_id)
);
`;

const F006_SCHEMA = `
CREATE TABLE IF NOT EXISTS interview_session (
  id INTEGER PRIMARY KEY,
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE RESTRICT,
  job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
  round INTEGER NOT NULL DEFAULT 1
    CHECK(typeof(round) = 'integer' AND round > 0),
  mode TEXT NOT NULL
    CHECK(mode IN ('online', 'offline')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft', 'scheduled', 'in_progress', 'pending_review', 'confirmed', 'cancelled')),
  scheduled_at TEXT,
  scheduled_confirmed_by TEXT,
  scheduled_confirmed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(candidate_id, job_id, round),
  CHECK(status <> 'scheduled' OR scheduled_at IS NOT NULL),
  CHECK(
    (scheduled_at IS NULL AND scheduled_confirmed_by IS NULL AND scheduled_confirmed_at IS NULL)
    OR
    (scheduled_at IS NOT NULL AND LENGTH(TRIM(scheduled_at)) > 0
      AND scheduled_confirmed_by IS NOT NULL AND LENGTH(TRIM(scheduled_confirmed_by)) > 0
      AND scheduled_confirmed_at IS NOT NULL AND LENGTH(TRIM(scheduled_confirmed_at)) > 0)
  )
);

CREATE TABLE IF NOT EXISTS interview_session_schedule_confirmation (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES interview_session(id) ON DELETE CASCADE,
  scheduled_at TEXT NOT NULL CHECK(LENGTH(TRIM(scheduled_at)) > 0),
  confirmed_by TEXT NOT NULL CHECK(LENGTH(TRIM(confirmed_by)) > 0),
  confirmed_at TEXT NOT NULL CHECK(LENGTH(TRIM(confirmed_at)) > 0),
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source = 'manual'),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interview_session_material (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES interview_session(id) ON DELETE CASCADE,
  material_kind TEXT NOT NULL CHECK(material_kind IN ('online_minutes', 'offline_recording')),
  job_interview_id INTEGER REFERENCES job_interview(id) ON DELETE RESTRICT,
  interview_recording_id INTEGER REFERENCES interview_recording(id) ON DELETE RESTRICT,
  linked_by TEXT NOT NULL CHECK(LENGTH(TRIM(linked_by)) > 0),
  linked_at TEXT NOT NULL,
  CHECK(
    (material_kind = 'online_minutes' AND job_interview_id IS NOT NULL AND interview_recording_id IS NULL)
    OR
    (material_kind = 'offline_recording' AND job_interview_id IS NULL AND interview_recording_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS interview_session_report (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES interview_session(id) ON DELETE CASCADE,
  report_id INTEGER NOT NULL UNIQUE REFERENCES interview_ai_report(id) ON DELETE RESTRICT,
  linked_by TEXT NOT NULL CHECK(LENGTH(TRIM(linked_by)) > 0),
  linked_at TEXT NOT NULL,
  UNIQUE(session_id, report_id)
);

${INTERVIEW_SESSION_CONSENT_SCHEMA}

CREATE TABLE IF NOT EXISTS interview_session_confirmation (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES interview_session(id) ON DELETE CASCADE,
  confirmation_id INTEGER NOT NULL UNIQUE REFERENCES interview_recording_confirmation(id) ON DELETE RESTRICT,
  linked_by TEXT NOT NULL CHECK(LENGTH(TRIM(linked_by)) > 0),
  linked_at TEXT NOT NULL,
  UNIQUE(session_id, confirmation_id)
);

${PENDING_ASSIGNMENT_TABLE_SCHEMA}
${PENDING_ASSIGNMENT_AUDIT_SCHEMA}

CREATE INDEX IF NOT EXISTS interview_session_lookup_idx
ON interview_session(candidate_id, job_id, round, mode, status);

CREATE INDEX IF NOT EXISTS interview_session_job_status_idx
ON interview_session(job_id, status, round);

CREATE INDEX IF NOT EXISTS interview_session_schedule_confirmation_session_idx
ON interview_session_schedule_confirmation(session_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS interview_session_material_online_unique
ON interview_session_material(job_interview_id)
WHERE job_interview_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS interview_session_material_recording_unique
ON interview_session_material(interview_recording_id)
WHERE interview_recording_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS interview_pending_assignment_status_idx
ON interview_pending_assignment(status, job_id, id);

CREATE INDEX IF NOT EXISTS interview_pending_assignment_purpose_idx
ON interview_pending_assignment(purpose, status, job_id, id);

CREATE INDEX IF NOT EXISTS interview_pending_assignment_classification_audit_idx
ON interview_pending_assignment_classification_audit(pending_assignment_id, id);

CREATE TRIGGER IF NOT EXISTS interview_session_candidate_job_insert_guard
BEFORE INSERT ON interview_session
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM candidate
  WHERE internal_id = NEW.candidate_id AND job_id = NEW.job_id
)
BEGIN
  SELECT RAISE(ABORT, 'interview_session candidate/job mismatch');
END;

CREATE TRIGGER IF NOT EXISTS interview_session_candidate_job_update_guard
BEFORE UPDATE OF candidate_id, job_id ON interview_session
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1 FROM candidate
  WHERE internal_id = NEW.candidate_id AND job_id = NEW.job_id
)
BEGIN
  SELECT RAISE(ABORT, 'interview_session candidate/job mismatch');
END;

CREATE TRIGGER IF NOT EXISTS interview_session_schedule_insert_guard
BEFORE INSERT ON interview_session
FOR EACH ROW
WHEN NEW.scheduled_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'interview_session schedule requires manual confirmation');
END;

CREATE TRIGGER IF NOT EXISTS interview_session_schedule_update_guard
BEFORE UPDATE OF scheduled_at, scheduled_confirmed_by, scheduled_confirmed_at ON interview_session
FOR EACH ROW
WHEN NEW.scheduled_at IS NOT OLD.scheduled_at
  OR NEW.scheduled_confirmed_by IS NOT OLD.scheduled_confirmed_by
  OR NEW.scheduled_confirmed_at IS NOT OLD.scheduled_confirmed_at
BEGIN
  SELECT CASE WHEN NEW.scheduled_at IS NULL OR NOT EXISTS (
    SELECT 1
    FROM interview_session_schedule_confirmation confirmation
    WHERE confirmation.session_id = NEW.id
      AND confirmation.scheduled_at = NEW.scheduled_at
      AND confirmation.confirmed_by = NEW.scheduled_confirmed_by
      AND confirmation.confirmed_at = NEW.scheduled_confirmed_at
      AND confirmation.source = 'manual'
  ) THEN RAISE(ABORT, 'interview_session schedule requires manual confirmation') END;
END;

CREATE TRIGGER IF NOT EXISTS interview_session_material_insert_guard
BEFORE INSERT ON interview_session_material
FOR EACH ROW
WHEN (
  NEW.material_kind = 'online_minutes'
  AND NOT EXISTS (
    SELECT 1
    FROM interview_session session
    JOIN job_interview legacy ON legacy.id = NEW.job_interview_id
    WHERE session.id = NEW.session_id
      AND session.mode = 'online'
      AND session.job_id = legacy.job_id
  )
) OR (
  NEW.material_kind = 'offline_recording'
  AND NOT EXISTS (
    SELECT 1
    FROM interview_session session
    JOIN interview_recording recording ON recording.id = NEW.interview_recording_id
    WHERE session.id = NEW.session_id
      AND session.mode = 'offline'
      AND (recording.candidate_id IS NULL OR recording.candidate_id = session.candidate_id)
      AND (recording.job_id IS NULL OR recording.job_id = session.job_id)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'interview_session material does not match session mode/candidate/job');
END;

CREATE TRIGGER IF NOT EXISTS interview_session_material_update_guard
BEFORE UPDATE OF session_id, material_kind, job_interview_id, interview_recording_id ON interview_session_material
FOR EACH ROW
WHEN (
  NEW.material_kind = 'online_minutes'
  AND NOT EXISTS (
    SELECT 1
    FROM interview_session session
    JOIN job_interview legacy ON legacy.id = NEW.job_interview_id
    WHERE session.id = NEW.session_id
      AND session.mode = 'online'
      AND session.job_id = legacy.job_id
  )
) OR (
  NEW.material_kind = 'offline_recording'
  AND NOT EXISTS (
    SELECT 1
    FROM interview_session session
    JOIN interview_recording recording ON recording.id = NEW.interview_recording_id
    WHERE session.id = NEW.session_id
      AND session.mode = 'offline'
      AND (recording.candidate_id IS NULL OR recording.candidate_id = session.candidate_id)
      AND (recording.job_id IS NULL OR recording.job_id = session.job_id)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'interview_session material does not match session mode/candidate/job');
END;

CREATE TRIGGER IF NOT EXISTS interview_pending_assignment_assignment_guard
BEFORE UPDATE OF status, assigned_session_id ON interview_pending_assignment
FOR EACH ROW
WHEN NEW.status = 'assigned' AND (
  NEW.purpose <> 'candidate_interview'
  OR OLD.status <> 'pending_assignment'
  OR NOT EXISTS (
    SELECT 1
    FROM interview_session session
    WHERE session.id = NEW.assigned_session_id
      AND session.job_id = NEW.job_id
      AND session.mode = 'online'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'pending assignment does not match online session job');
END;

CREATE TRIGGER IF NOT EXISTS interview_pending_assignment_classification_guard
BEFORE UPDATE OF purpose, status, reason ON interview_pending_assignment
FOR EACH ROW
WHEN (
  NEW.purpose IS NOT OLD.purpose
  OR NEW.status IS NOT OLD.status
  OR NEW.reason IS NOT OLD.reason
)
AND NOT (
  OLD.purpose = 'candidate_interview'
  AND OLD.status = 'pending_assignment'
  AND NEW.purpose = 'candidate_interview'
  AND NEW.status = 'assigned'
  AND NEW.reason = 'missing_candidate'
)
AND NOT EXISTS (
  SELECT 1
  FROM interview_pending_assignment_classification_audit audit
  WHERE audit.pending_assignment_id = NEW.id
    AND audit.before_purpose = OLD.purpose
    AND audit.before_status = OLD.status
    AND audit.after_purpose = NEW.purpose
    AND audit.after_status = NEW.status
    AND audit.classified_at = NEW.updated_at
)
BEGIN
  SELECT RAISE(ABORT, 'pending assignment classification requires explicit audit');
END;
`;

function tableExists(database, name) {
  return !!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

function columnExists(database, table, column) {
  if (!tableExists(database, table)) return false;
  return database.prepare(`PRAGMA table_info('${table.replaceAll("'", "''")}')`).all()
    .some((item) => item.name === column);
}

function uniqueIndexColumns(database, table) {
  const escapedTable = table.replaceAll("'", "''");
  return database.prepare(`PRAGMA index_list('${escapedTable}')`).all()
    .filter((item) => Number(item.unique) === 1)
    .map((item) => {
      const escapedIndex = String(item.name).replaceAll("'", "''");
      return database.prepare(`PRAGMA index_info('${escapedIndex}')`).all()
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((column) => column.name);
    });
}

function migrateLegacyInterviewSessionConsent(database) {
  if (!tableExists(database, 'interview_session_consent')) return 0;
  const hasLegacyConsentUnique = uniqueIndexColumns(database, 'interview_session_consent')
    .some((columns) => columns.length === 1 && columns[0] === 'consent_id');
  if (!hasLegacyConsentUnique) return 0;
  const oldCount = database.prepare('SELECT COUNT(*) AS n FROM interview_session_consent').get().n;
  database.exec(`
    ALTER TABLE interview_session_consent RENAME TO interview_session_consent_f006_legacy;
  `);
  database.exec(INTERVIEW_SESSION_CONSENT_SCHEMA);
  database.exec(`
    INSERT INTO interview_session_consent (
      id, session_id, consent_id, linked_by, linked_at
    )
    SELECT id, session_id, consent_id, linked_by, linked_at
    FROM interview_session_consent_f006_legacy;
    DROP TABLE interview_session_consent_f006_legacy;
  `);
  return oldCount;
}

function migrateLegacyPendingAssignmentClassification(database, timestamp) {
  if (!tableExists(database, 'interview_pending_assignment')) return 0;
  if (columnExists(database, 'interview_pending_assignment', 'purpose')) return 0;
  const oldCount = database.prepare('SELECT COUNT(*) AS n FROM interview_pending_assignment').get().n;
  database.exec(`
    DROP TRIGGER IF EXISTS interview_pending_assignment_assignment_guard;
    DROP TRIGGER IF EXISTS interview_pending_assignment_classification_guard;
    DROP INDEX IF EXISTS interview_pending_assignment_status_idx;
    ALTER TABLE interview_pending_assignment RENAME TO interview_pending_assignment_f006_legacy;
  `);
  database.exec(PENDING_ASSIGNMENT_TABLE_SCHEMA);
  database.exec(PENDING_ASSIGNMENT_AUDIT_SCHEMA);
  database.prepare(`
    INSERT INTO interview_pending_assignment (
      id, job_interview_id, job_id, source_type, purpose, status, reason,
      assigned_session_id, assigned_by, assigned_at, created_at, updated_at
    )
    SELECT
      id, job_interview_id, job_id, source_type,
      CASE WHEN status = 'assigned' THEN 'candidate_interview' ELSE 'unknown' END,
      CASE WHEN status = 'assigned' THEN 'assigned' ELSE 'pending_classification' END,
      CASE WHEN status = 'assigned' THEN 'missing_candidate' ELSE 'purpose_unclassified' END,
      CASE WHEN status = 'assigned' THEN assigned_session_id ELSE NULL END,
      CASE WHEN status = 'assigned' THEN assigned_by ELSE NULL END,
      CASE WHEN status = 'assigned' THEN assigned_at ELSE NULL END,
      created_at,
      COALESCE(NULLIF(updated_at, ''), @timestamp)
    FROM interview_pending_assignment_f006_legacy
  `).run({ timestamp });
  database.prepare(`
    INSERT INTO interview_pending_assignment_classification_audit (
      pending_assignment_id, before_purpose, before_status,
      after_purpose, after_status, actor, classified_at, created_at
    )
    SELECT
      id, 'unknown', 'pending_classification',
      'candidate_interview', 'pending_assignment', assigned_by, assigned_at, assigned_at
    FROM interview_pending_assignment_f006_legacy
    WHERE status = 'assigned'
  `).run();
  database.exec('DROP TABLE interview_pending_assignment_f006_legacy;');
  return oldCount;
}

function applyF006InterviewSessionMigration(database, options = {}) {
  const timestamp = String(options.timestamp || new Date().toISOString());
  return database.transaction(() => {
    const classificationRowsUpgraded = migrateLegacyPendingAssignmentClassification(database, timestamp);
    const consentLinksUpgraded = migrateLegacyInterviewSessionConsent(database);
    database.exec(F006_SCHEMA);
    let pendingClassificationsAdded = 0;
    if (columnExists(database, 'job_interview', 'source_type')) {
      const result = database.prepare(`
        INSERT OR IGNORE INTO interview_pending_assignment (
          job_interview_id, job_id, source_type, purpose, status, reason,
          assigned_session_id, assigned_by, assigned_at, created_at, updated_at
        )
        SELECT
          id, job_id, 'lark_minutes', 'unknown', 'pending_classification', 'purpose_unclassified',
          NULL, NULL, NULL, COALESCE(NULLIF(created_at, ''), @timestamp), @timestamp
        FROM job_interview
        WHERE source_type = 'lark_minutes'
      `).run({ timestamp });
      pendingClassificationsAdded = result.changes;
    }
    return {
      tables: [...F006_TABLES],
      pending_classifications_added: pendingClassificationsAdded,
      classification_rows_upgraded: classificationRowsUpgraded,
      consent_links_upgraded: consentLinksUpgraded,
    };
  })();
}

function rollbackF006InterviewSessionMigration(database) {
  return database.transaction(() => {
    database.exec(`
      DROP TRIGGER IF EXISTS interview_pending_assignment_classification_guard;
      DROP TRIGGER IF EXISTS interview_pending_assignment_assignment_guard;
      DROP TRIGGER IF EXISTS interview_session_material_update_guard;
      DROP TRIGGER IF EXISTS interview_session_material_insert_guard;
      DROP TRIGGER IF EXISTS interview_session_schedule_update_guard;
      DROP TRIGGER IF EXISTS interview_session_schedule_insert_guard;
      DROP TRIGGER IF EXISTS interview_session_candidate_job_update_guard;
      DROP TRIGGER IF EXISTS interview_session_candidate_job_insert_guard;

      DROP INDEX IF EXISTS interview_pending_assignment_classification_audit_idx;
      DROP INDEX IF EXISTS interview_pending_assignment_purpose_idx;
      DROP INDEX IF EXISTS interview_pending_assignment_status_idx;
      DROP INDEX IF EXISTS interview_session_material_recording_unique;
      DROP INDEX IF EXISTS interview_session_material_online_unique;
      DROP INDEX IF EXISTS interview_session_schedule_confirmation_session_idx;
      DROP INDEX IF EXISTS interview_session_job_status_idx;
      DROP INDEX IF EXISTS interview_session_lookup_idx;

      DROP TABLE IF EXISTS interview_pending_assignment_classification_audit;
      DROP TABLE IF EXISTS interview_pending_assignment;
      DROP TABLE IF EXISTS interview_session_confirmation;
      DROP TABLE IF EXISTS interview_session_consent;
      DROP TABLE IF EXISTS interview_session_report;
      DROP TABLE IF EXISTS interview_session_material;
      DROP TABLE IF EXISTS interview_session_schedule_confirmation;
      DROP TABLE IF EXISTS interview_session;
    `);
    return { dropped_tables: [...F006_TABLES] };
  })();
}

module.exports = {
  F006_TABLES,
  applyF006InterviewSessionMigration,
  rollbackF006InterviewSessionMigration,
};
