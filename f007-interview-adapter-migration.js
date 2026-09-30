const crypto = require('crypto');

const F007_PENDING_COLUMNS = Object.freeze([
  'interview_recording_id',
  'source_key',
  'payload_hash',
  'version',
]);

const PENDING_SCHEMA = `
CREATE TABLE interview_pending_assignment (
  id INTEGER PRIMARY KEY,
  job_interview_id INTEGER UNIQUE REFERENCES job_interview(id) ON DELETE RESTRICT,
  interview_recording_id INTEGER UNIQUE REFERENCES interview_recording(id) ON DELETE RESTRICT,
  job_id INTEGER REFERENCES job(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL
    CHECK(source_type IN ('lark_minutes', 'offline_recording')),
  source_key TEXT,
  payload_hash TEXT,
  purpose TEXT NOT NULL DEFAULT 'unknown'
    CHECK(purpose IN ('unknown', 'candidate_interview', 'hiring_manager_profile_interview')),
  status TEXT NOT NULL DEFAULT 'pending_classification'
    CHECK(status IN ('pending_classification', 'pending_assignment', 'assigned', 'excluded')),
  reason TEXT NOT NULL DEFAULT 'purpose_unclassified'
    CHECK(reason IN ('purpose_unclassified', 'missing_candidate', 'hiring_manager_profile_interview')),
  assigned_session_id INTEGER REFERENCES interview_session(id) ON DELETE RESTRICT,
  assigned_by TEXT,
  assigned_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
    CHECK(typeof(version) = 'integer' AND version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(
    (source_type = 'lark_minutes' AND job_interview_id IS NOT NULL AND interview_recording_id IS NULL)
    OR
    (source_type = 'offline_recording' AND job_interview_id IS NULL AND interview_recording_id IS NOT NULL)
  ),
  CHECK(
    (purpose = 'unknown' AND status = 'pending_classification' AND reason = 'purpose_unclassified'
      AND assigned_session_id IS NULL AND assigned_by IS NULL AND assigned_at IS NULL)
    OR
    (purpose = 'candidate_interview' AND status = 'pending_assignment' AND reason = 'missing_candidate'
      AND assigned_session_id IS NULL AND assigned_by IS NULL AND assigned_at IS NULL)
    OR
    (purpose = 'candidate_interview' AND status = 'assigned' AND reason = 'missing_candidate'
      AND job_id IS NOT NULL
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

const AUDIT_SCHEMA = `
CREATE TABLE interview_pending_assignment_classification_audit (
  id INTEGER PRIMARY KEY,
  pending_assignment_id INTEGER NOT NULL REFERENCES interview_pending_assignment(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL DEFAULT 'classification'
    CHECK(action_type IN ('classification', 'assignment', 'correction', 'explicit_context')),
  before_purpose TEXT NOT NULL
    CHECK(before_purpose IN ('unknown', 'candidate_interview', 'hiring_manager_profile_interview')),
  before_status TEXT NOT NULL
    CHECK(before_status IN ('pending_classification', 'pending_assignment', 'assigned', 'excluded')),
  before_assigned_session_id INTEGER,
  before_version INTEGER NOT NULL DEFAULT 1,
  after_purpose TEXT NOT NULL
    CHECK(after_purpose IN ('unknown', 'candidate_interview', 'hiring_manager_profile_interview')),
  after_status TEXT NOT NULL
    CHECK(after_status IN ('pending_classification', 'pending_assignment', 'assigned', 'excluded')),
  after_assigned_session_id INTEGER,
  after_version INTEGER NOT NULL DEFAULT 1,
  actor TEXT NOT NULL CHECK(LENGTH(TRIM(actor)) > 0),
  reason TEXT NOT NULL DEFAULT 'legacy_f006' CHECK(LENGTH(TRIM(reason)) > 0),
  request_id TEXT,
  classified_at TEXT NOT NULL CHECK(LENGTH(TRIM(classified_at)) > 0),
  created_at TEXT NOT NULL
);
`;

const F007_INDEXES_AND_TRIGGERS = `
CREATE INDEX IF NOT EXISTS interview_pending_assignment_status_idx
ON interview_pending_assignment(status, job_id, id);

CREATE INDEX IF NOT EXISTS interview_pending_assignment_purpose_idx
ON interview_pending_assignment(purpose, status, job_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS interview_pending_assignment_source_key_unique
ON interview_pending_assignment(source_type, source_key)
WHERE source_key IS NOT NULL AND TRIM(source_key) <> '';

CREATE INDEX IF NOT EXISTS interview_pending_assignment_payload_hash_idx
ON interview_pending_assignment(source_type, payload_hash)
WHERE payload_hash IS NOT NULL AND TRIM(payload_hash) <> '';

CREATE INDEX IF NOT EXISTS interview_pending_assignment_classification_audit_idx
ON interview_pending_assignment_classification_audit(pending_assignment_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS interview_pending_assignment_request_unique
ON interview_pending_assignment_classification_audit(pending_assignment_id, request_id)
WHERE request_id IS NOT NULL AND TRIM(request_id) <> '';

CREATE TRIGGER IF NOT EXISTS interview_pending_assignment_assignment_guard
BEFORE UPDATE OF status, assigned_session_id, job_id ON interview_pending_assignment
FOR EACH ROW
WHEN NEW.status = 'assigned' AND (
  NEW.purpose <> 'candidate_interview'
  OR NOT (
    OLD.status IN ('pending_assignment', 'assigned')
    OR EXISTS (
      SELECT 1
      FROM interview_pending_assignment_classification_audit audit
      WHERE audit.pending_assignment_id = NEW.id
        AND audit.action_type = 'explicit_context'
        AND audit.before_status = OLD.status
        AND audit.after_status = 'assigned'
        AND audit.classified_at = NEW.updated_at
    )
  )
  OR NOT EXISTS (
    SELECT 1
    FROM interview_session session
    WHERE session.id = NEW.assigned_session_id
      AND session.job_id = NEW.job_id
      AND session.mode = CASE NEW.source_type WHEN 'lark_minutes' THEN 'online' ELSE 'offline' END
  )
)
BEGIN
  SELECT RAISE(ABORT, 'pending assignment does not match interview session context');
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
  AND OLD.status IN ('pending_assignment', 'assigned')
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

function tableColumns(database, name) {
  if (!tableExists(database, name)) return [];
  return database.prepare(`PRAGMA table_info('${name.replaceAll("'", "''")}')`).all().map((row) => row.name);
}

function hashed(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function legacyLarkSourceKey(sourceUrl, id) {
  try {
    const parsed = new URL(String(sourceUrl || '').trim());
    const token = parsed.pathname.split('/').filter(Boolean).at(-1) || '';
    if (/^[A-Za-z0-9]+$/.test(token)) return `lark_minutes:${hashed(token)}`;
  } catch {}
  return `legacy_job_interview:${id}`;
}

function dropF006PendingObjects(database) {
  database.exec(`
    DROP TRIGGER IF EXISTS interview_pending_assignment_classification_guard;
    DROP TRIGGER IF EXISTS interview_pending_assignment_assignment_guard;
    DROP INDEX IF EXISTS interview_pending_assignment_request_unique;
    DROP INDEX IF EXISTS interview_pending_assignment_classification_audit_idx;
    DROP INDEX IF EXISTS interview_pending_assignment_payload_hash_idx;
    DROP INDEX IF EXISTS interview_pending_assignment_source_key_unique;
    DROP INDEX IF EXISTS interview_pending_assignment_purpose_idx;
    DROP INDEX IF EXISTS interview_pending_assignment_status_idx;
  `);
}

function rebuildPendingAssignment(database) {
  dropF006PendingObjects(database);
  database.exec(`
    DROP TRIGGER IF EXISTS interview_session_material_update_guard;
    DROP TRIGGER IF EXISTS interview_session_material_insert_guard;
  `);
  database.exec(`
    ALTER TABLE interview_pending_assignment_classification_audit
      RENAME TO interview_pending_assignment_classification_audit_f007_legacy;
    ALTER TABLE interview_pending_assignment
      RENAME TO interview_pending_assignment_f007_legacy;
  `);
  database.exec(PENDING_SCHEMA);
  database.exec(AUDIT_SCHEMA);

  const legacyRows = database.prepare(`
    SELECT pending.*, legacy.source_url
    FROM interview_pending_assignment_f007_legacy pending
    JOIN job_interview legacy ON legacy.id = pending.job_interview_id
    ORDER BY pending.id
  `).all();
  const insertPending = database.prepare(`
    INSERT INTO interview_pending_assignment (
      id, job_interview_id, interview_recording_id, job_id, source_type,
      source_key, payload_hash, purpose, status, reason,
      assigned_session_id, assigned_by, assigned_at, version, created_at, updated_at
    ) VALUES (
      @id, @job_interview_id, NULL, @job_id, 'lark_minutes',
      @source_key, NULL, @purpose, @status, @reason,
      @assigned_session_id, @assigned_by, @assigned_at, 1, @created_at, @updated_at
    )
  `);
  for (const row of legacyRows) {
    insertPending.run({
      ...row,
      source_key: legacyLarkSourceKey(row.source_url, row.job_interview_id),
    });
  }

  database.exec(`
    INSERT INTO interview_pending_assignment_classification_audit (
      id, pending_assignment_id, action_type,
      before_purpose, before_status, before_assigned_session_id, before_version,
      after_purpose, after_status, after_assigned_session_id, after_version,
      actor, reason, request_id, classified_at, created_at
    )
    SELECT
      id, pending_assignment_id, 'classification',
      before_purpose, before_status, NULL, 1,
      after_purpose, after_status, NULL, 1,
      actor, 'legacy_f006', NULL, classified_at, created_at
    FROM interview_pending_assignment_classification_audit_f007_legacy;

    DROP TABLE interview_pending_assignment_classification_audit_f007_legacy;
    DROP TABLE interview_pending_assignment_f007_legacy;
  `);
}

function fillMissingLegacySourceKeys(database) {
  const rows = database.prepare(`
    SELECT pending.id, pending.job_interview_id, legacy.source_url
    FROM interview_pending_assignment pending
    JOIN job_interview legacy ON legacy.id = pending.job_interview_id
    WHERE pending.source_type = 'lark_minutes'
      AND (pending.source_key IS NULL OR TRIM(pending.source_key) = '')
  `).all();
  const update = database.prepare('UPDATE interview_pending_assignment SET source_key = ? WHERE id = ?');
  for (const row of rows) update.run(legacyLarkSourceKey(row.source_url, row.job_interview_id), row.id);
}

function applyF007InterviewAdapterMigration(database) {
  return database.transaction(() => {
    const columns = tableColumns(database, 'interview_pending_assignment');
    const needsRebuild = F007_PENDING_COLUMNS.some((column) => !columns.includes(column));
    if (needsRebuild) rebuildPendingAssignment(database);
    dropF006PendingObjects(database);
    database.exec(F007_INDEXES_AND_TRIGGERS);
    fillMissingLegacySourceKeys(database);
    return { upgraded: needsRebuild };
  })();
}

module.exports = {
  applyF007InterviewAdapterMigration,
  legacyLarkSourceKey,
};
