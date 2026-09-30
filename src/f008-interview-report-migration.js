const F008_TABLES = Object.freeze([
  'interview_report_v1',
  'interview_report_fact_review',
  'interview_report_action_request',
  'interview_report_source_snapshot',
  'interview_report_confirmed_projection',
  'interview_session_manual_note',
  'interview_session_manual_note_revision',
]);

const F008_SCHEMA = `
CREATE TABLE IF NOT EXISTS interview_report_v1 (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL UNIQUE REFERENCES interview_session(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL CHECK(schema_version = 'interview_report_v1'),
  status TEXT NOT NULL CHECK(status IN ('draft', 'confirmed', 'rejected')),
  report_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  created_by TEXT NOT NULL CHECK(LENGTH(TRIM(created_by)) > 0),
  updated_by TEXT NOT NULL CHECK(LENGTH(TRIM(updated_by)) > 0),
  confirmed_by TEXT,
  confirmed_at TEXT,
  rejected_by TEXT,
  rejected_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(
    (status = 'draft' AND confirmed_by IS NULL AND confirmed_at IS NULL AND rejected_by IS NULL AND rejected_at IS NULL)
    OR (status = 'confirmed' AND confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL AND rejected_by IS NULL AND rejected_at IS NULL)
    OR (status = 'rejected' AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND confirmed_by IS NULL AND confirmed_at IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS interview_report_fact_review (
  id INTEGER PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES interview_report_v1(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL,
  fact_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending_review', 'confirmed', 'corrected', 'unknown', 'rejected')),
  corrected_value TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(report_id, field_key),
  CHECK(
    (status = 'pending_review' AND reviewed_by IS NULL AND reviewed_at IS NULL)
    OR (status <> 'pending_review' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS interview_report_action_request (
  request_id TEXT PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES interview_report_v1(id) ON DELETE RESTRICT,
  session_id INTEGER NOT NULL REFERENCES interview_session(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action IN ('save', 'fact_review', 'confirm', 'reject')),
  payload_hash TEXT NOT NULL,
  response_version INTEGER NOT NULL,
  response_status TEXT NOT NULL CHECK(response_status IN ('draft', 'confirmed', 'rejected')),
  actor TEXT NOT NULL CHECK(LENGTH(TRIM(actor)) > 0),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS interview_report_v1_status_session_idx
ON interview_report_v1(status, session_id);

CREATE INDEX IF NOT EXISTS interview_report_fact_review_report_status_idx
ON interview_report_fact_review(report_id, status);

CREATE TABLE IF NOT EXISTS interview_report_source_snapshot (
  report_id INTEGER PRIMARY KEY REFERENCES interview_report_v1(id) ON DELETE CASCADE,
  session_id INTEGER NOT NULL REFERENCES interview_session(id) ON DELETE RESTRICT,
  material_ids_json TEXT NOT NULL,
  source_json TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK(LENGTH(source_hash) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interview_report_confirmed_projection (
  report_id INTEGER PRIMARY KEY REFERENCES interview_report_v1(id) ON DELETE RESTRICT,
  session_id INTEGER NOT NULL UNIQUE REFERENCES interview_session(id) ON DELETE RESTRICT,
  source_report_version INTEGER NOT NULL CHECK(source_report_version > 0),
  projection_json TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK(LENGTH(content_hash) = 64),
  created_by TEXT NOT NULL CHECK(LENGTH(TRIM(created_by)) > 0),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interview_session_manual_note (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL UNIQUE REFERENCES interview_session(id) ON DELETE RESTRICT,
  job_interview_id INTEGER NOT NULL UNIQUE REFERENCES job_interview(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'revoked')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_by TEXT NOT NULL CHECK(LENGTH(TRIM(created_by)) > 0),
  updated_by TEXT NOT NULL CHECK(LENGTH(TRIM(updated_by)) > 0),
  revoked_by TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(
    (status = 'active' AND revoked_by IS NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS interview_session_manual_note_revision (
  id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES interview_session_manual_note(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK(version > 0),
  body TEXT NOT NULL CHECK(LENGTH(TRIM(body)) > 0),
  author TEXT NOT NULL CHECK(LENGTH(TRIM(author)) > 0),
  created_at TEXT NOT NULL,
  UNIQUE(note_id, version)
);

CREATE INDEX IF NOT EXISTS interview_report_source_snapshot_session_idx
ON interview_report_source_snapshot(session_id);

CREATE INDEX IF NOT EXISTS interview_session_manual_note_revision_note_idx
ON interview_session_manual_note_revision(note_id, version);

DROP TRIGGER IF EXISTS interview_session_material_insert_guard;
CREATE TRIGGER interview_session_material_insert_guard
BEFORE INSERT ON interview_session_material
FOR EACH ROW
WHEN (
  NEW.material_kind = 'online_minutes'
  AND NOT EXISTS (
    SELECT 1
    FROM interview_session session
    JOIN job_interview legacy ON legacy.id = NEW.job_interview_id
    WHERE session.id = NEW.session_id
      AND (session.mode = 'online' OR legacy.source_type = 'manual_transcript')
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

DROP TRIGGER IF EXISTS interview_session_material_update_guard;
CREATE TRIGGER interview_session_material_update_guard
BEFORE UPDATE OF session_id, material_kind, job_interview_id, interview_recording_id ON interview_session_material
FOR EACH ROW
WHEN (
  NEW.material_kind = 'online_minutes'
  AND NOT EXISTS (
    SELECT 1
    FROM interview_session session
    JOIN job_interview legacy ON legacy.id = NEW.job_interview_id
    WHERE session.id = NEW.session_id
      AND (session.mode = 'online' OR legacy.source_type = 'manual_transcript')
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
`;

function applyF008InterviewReportMigration(database) {
  if (!database || typeof database.exec !== 'function') throw new Error('database is required');
  database.exec(F008_SCHEMA);
  return { tables: [...F008_TABLES] };
}

module.exports = {
  F008_TABLES,
  F008_SCHEMA,
  applyF008InterviewReportMigration,
};
