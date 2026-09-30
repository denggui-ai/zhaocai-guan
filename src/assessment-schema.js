const ASSESSMENT_TABLES = Object.freeze([
  'assessment_document',
  'assessment_binding',
  'assessment_event',
  'assessment_deletion_request',
]);

const ASSESSMENT_DELETION_INDEXES = Object.freeze([
  'assessment_deletion_request_document_state_idx',
  'assessment_deletion_request_one_unfinished_per_document',
]);

const ASSESSMENT_DELETION_TRIGGERS = Object.freeze([
  'assessment_event_append_only_update_guard',
  'assessment_event_append_only_delete_guard',
  'assessment_deletion_request_identity_update_guard',
  'assessment_deletion_request_delete_guard',
]);

const ASSESSMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS assessment_document (
  id TEXT PRIMARY KEY NOT NULL CHECK(LENGTH(TRIM(id)) > 0),
  content_sha256 TEXT,
  storage_relpath TEXT,
  byte_size INTEGER,
  page_count INTEGER,
  mime_detected TEXT,
  security_state TEXT NOT NULL DEFAULT 'pending'
    CHECK(security_state IN ('pending', 'accepted', 'quarantined', 'rejected')),
  report_type TEXT NOT NULL DEFAULT 'unknown'
    CHECK(report_type IN ('career_potential', 'workplace_style', 'team_role', 'unknown')),
  assessment_date TEXT,
  analysis_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(analysis_status IN ('pending', 'ready', 'failed')),
  analysis_schema_version TEXT,
  analysis_json TEXT,
  analysis_error_code TEXT,
  review_state TEXT NOT NULL DEFAULT 'pending'
    CHECK(review_state IN ('pending', 'ready', 'rejected', 'superseded')),
  dispute_state TEXT NOT NULL DEFAULT 'none'
    CHECK(dispute_state IN ('none', 'open', 'resolved')),
  lifecycle_state TEXT NOT NULL DEFAULT 'active'
    CHECK(lifecycle_state IN ('active', 'frozen', 'deletion_pending', 'deleted')),
  retention_policy_version TEXT,
  delete_after TEXT,
  legal_hold_state TEXT NOT NULL DEFAULT 'none'
    CHECK(legal_hold_state IN ('none', 'active', 'released')),
  supersedes_document_id TEXT REFERENCES assessment_document(id) ON DELETE RESTRICT,
  created_by TEXT NOT NULL CHECK(LENGTH(TRIM(created_by)) > 0),
  version INTEGER NOT NULL DEFAULT 1
    CHECK(typeof(version) = 'integer' AND version > 0),
  created_at TEXT NOT NULL CHECK(LENGTH(TRIM(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK(LENGTH(TRIM(updated_at)) > 0),
  deleted_at TEXT,
  CHECK(
    content_sha256 IS NULL
    OR (
      LENGTH(content_sha256) = 64
      AND content_sha256 = LOWER(content_sha256)
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK(storage_relpath IS NULL OR LENGTH(TRIM(storage_relpath)) > 0),
  CHECK(
    byte_size IS NULL
    OR (typeof(byte_size) = 'integer' AND byte_size > 0 AND byte_size <= 26214400)
  ),
  CHECK(
    page_count IS NULL
    OR (typeof(page_count) = 'integer' AND page_count > 0 AND page_count <= 200)
  ),
  CHECK(mime_detected IS NULL OR mime_detected = 'application/pdf'),
  CHECK(review_state <> 'ready' OR security_state = 'accepted'),
  CHECK(dispute_state <> 'open' OR lifecycle_state = 'frozen'),
  CHECK(delete_after IS NULL OR retention_policy_version IS NOT NULL),
  CHECK(supersedes_document_id IS NULL OR supersedes_document_id <> id),
  CHECK(
    security_state <> 'accepted'
    OR lifecycle_state = 'deleted'
    OR (
      content_sha256 IS NOT NULL
      AND storage_relpath IS NOT NULL
      AND byte_size IS NOT NULL
      AND page_count IS NOT NULL
      AND mime_detected IS NOT NULL
    )
  ),
  CHECK(
    (lifecycle_state = 'deleted'
      AND content_sha256 IS NULL
      AND storage_relpath IS NULL
      AND byte_size IS NULL
      AND page_count IS NULL
      AND mime_detected IS NULL
      AND assessment_date IS NULL
      AND analysis_json IS NULL
      AND deleted_at IS NOT NULL
      AND LENGTH(TRIM(deleted_at)) > 0)
    OR
    (lifecycle_state <> 'deleted' AND deleted_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS assessment_document_content_sha256_unique
ON assessment_document(content_sha256)
WHERE content_sha256 IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS assessment_document_storage_relpath_unique
ON assessment_document(storage_relpath)
WHERE storage_relpath IS NOT NULL;

CREATE INDEX IF NOT EXISTS assessment_document_state_idx
ON assessment_document(security_state, review_state, lifecycle_state);

CREATE TABLE IF NOT EXISTS assessment_binding (
  id TEXT PRIMARY KEY NOT NULL CHECK(LENGTH(TRIM(id)) > 0),
  document_id TEXT NOT NULL REFERENCES assessment_document(id) ON DELETE RESTRICT,
  candidate_id TEXT NOT NULL REFERENCES candidate(internal_id) ON DELETE RESTRICT,
  job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL DEFAULT 'candidate_job_archive'
    CHECK(scope = 'candidate_job_archive'),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending', 'active', 'revoked', 'superseded')),
  conflict_state TEXT NOT NULL DEFAULT 'none'
    CHECK(conflict_state IN ('none', 'active_report_type_conflict')),
  identity_basis TEXT NOT NULL
    CHECK(identity_basis IN ('current_candidate_context', 'same_source_identity', 'manual_cross_source')),
  actor_id TEXT NOT NULL CHECK(LENGTH(TRIM(actor_id)) > 0),
  reason_code TEXT NOT NULL CHECK(LENGTH(TRIM(reason_code)) > 0),
  request_id TEXT NOT NULL UNIQUE CHECK(LENGTH(TRIM(request_id)) > 0),
  version INTEGER NOT NULL DEFAULT 1
    CHECK(typeof(version) = 'integer' AND version > 0),
  created_at TEXT NOT NULL CHECK(LENGTH(TRIM(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK(LENGTH(TRIM(updated_at)) > 0),
  revoked_at TEXT,
  CHECK(
    (state IN ('pending', 'active') AND revoked_at IS NULL)
    OR
    (state IN ('revoked', 'superseded')
      AND revoked_at IS NOT NULL
      AND LENGTH(TRIM(revoked_at)) > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS assessment_binding_one_active_per_document
ON assessment_binding(document_id)
WHERE state = 'active';

CREATE INDEX IF NOT EXISTS assessment_binding_candidate_job_state_idx
ON assessment_binding(candidate_id, job_id, scope, state);

CREATE INDEX IF NOT EXISTS assessment_binding_document_state_idx
ON assessment_binding(document_id, state);

CREATE TABLE IF NOT EXISTS assessment_event (
  id TEXT PRIMARY KEY NOT NULL CHECK(LENGTH(TRIM(id)) > 0),
  object_type TEXT NOT NULL
    CHECK(object_type IN ('document', 'binding', 'import_request')),
  object_id TEXT NOT NULL CHECK(LENGTH(TRIM(object_id)) > 0),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'uploaded',
    'security_rejected',
    'duplicate_seen',
    'metadata_confirmed',
    'binding_confirmed',
    'binding_revoked',
    'binding_rebound',
    'document_superseded',
    'viewed',
    'delete_requested',
    'dispute_opened',
    'dispute_resolved',
    'legal_hold_applied',
    'legal_hold_released',
    'deleted_by_policy'
  )),
  actor_id TEXT NOT NULL CHECK(LENGTH(TRIM(actor_id)) > 0),
  actor_type TEXT NOT NULL
    CHECK(actor_type = 'local_os_subject' AND LENGTH(TRIM(actor_type)) > 0),
  actor_source TEXT NOT NULL
    CHECK(actor_source = 'server_local_instance' AND LENGTH(TRIM(actor_source)) > 0),
  actor_session_id TEXT NOT NULL CHECK(LENGTH(TRIM(actor_session_id)) > 0),
  actor_assurance TEXT NOT NULL
    CHECK(actor_assurance = 'local_instance_only' AND LENGTH(TRIM(actor_assurance)) > 0),
  request_id TEXT NOT NULL UNIQUE CHECK(LENGTH(TRIM(request_id)) > 0),
  reason_code TEXT NOT NULL CHECK(
    LENGTH(reason_code) BETWEEN 1 AND 80
    AND reason_code NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND SUBSTR(reason_code, 1, 1) GLOB '[A-Za-z0-9]'
  ),
  before_version INTEGER
    CHECK(before_version IS NULL OR (typeof(before_version) = 'integer' AND before_version > 0)),
  after_version INTEGER
    CHECK(after_version IS NULL OR (typeof(after_version) = 'integer' AND after_version > 0)),
  policy_version TEXT,
  created_at TEXT NOT NULL CHECK(LENGTH(TRIM(created_at)) > 0),
  CHECK(before_version IS NULL OR after_version IS NULL OR after_version >= before_version)
);

CREATE INDEX IF NOT EXISTS assessment_event_object_created_idx
ON assessment_event(object_type, object_id, created_at);

CREATE TABLE IF NOT EXISTS assessment_deletion_request (
  request_id TEXT PRIMARY KEY NOT NULL CHECK(
    LENGTH(request_id) BETWEEN 1 AND 128
    AND request_id NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND SUBSTR(request_id, 1, 1) GLOB '[A-Za-z0-9]'
  ),
  document_id TEXT NOT NULL REFERENCES assessment_document(id) ON DELETE RESTRICT,
  expected_version INTEGER NOT NULL
    CHECK(typeof(expected_version) = 'integer' AND expected_version > 0),
  reason_code TEXT NOT NULL CHECK(
    LENGTH(reason_code) BETWEEN 1 AND 80
    AND reason_code NOT GLOB '*[^A-Za-z0-9_.:-]*'
    AND SUBSTR(reason_code, 1, 1) GLOB '[A-Za-z0-9]'
  ),
  policy_version TEXT NOT NULL CHECK(LENGTH(TRIM(policy_version)) BETWEEN 1 AND 80),
  effective_at TEXT NOT NULL CHECK(LENGTH(TRIM(effective_at)) > 0),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending', 'retryable_failed', 'completed')),
  last_error_code TEXT CHECK(
    last_error_code IS NULL
    OR (
      LENGTH(last_error_code) BETWEEN 1 AND 80
      AND last_error_code NOT GLOB '*[^A-Z0-9_]*'
    )
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(attempt_count) = 'integer' AND attempt_count >= 0),
  actor_id TEXT NOT NULL CHECK(LENGTH(TRIM(actor_id)) > 0),
  actor_type TEXT NOT NULL CHECK(actor_type = 'local_os_subject'),
  actor_source TEXT NOT NULL CHECK(actor_source = 'server_local_instance'),
  actor_session_id TEXT NOT NULL CHECK(LENGTH(TRIM(actor_session_id)) > 0),
  actor_assurance TEXT NOT NULL CHECK(actor_assurance = 'local_instance_only'),
  created_at TEXT NOT NULL CHECK(LENGTH(TRIM(created_at)) > 0),
  updated_at TEXT NOT NULL CHECK(LENGTH(TRIM(updated_at)) > 0),
  physical_deleted_at TEXT,
  completed_at TEXT,
  CHECK(
    (state = 'pending' AND last_error_code IS NULL AND completed_at IS NULL)
    OR
    (state = 'retryable_failed' AND last_error_code IS NOT NULL
      AND physical_deleted_at IS NULL AND completed_at IS NULL)
    OR
    (state = 'completed' AND last_error_code IS NULL
      AND physical_deleted_at IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS assessment_deletion_request_document_state_idx
ON assessment_deletion_request(document_id, state);

CREATE UNIQUE INDEX IF NOT EXISTS assessment_deletion_request_one_unfinished_per_document
ON assessment_deletion_request(document_id)
WHERE state IN ('pending', 'retryable_failed');
`;

const ASSESSMENT_GUARDS = `
CREATE TRIGGER IF NOT EXISTS assessment_document_dispute_insert_guard
BEFORE INSERT ON assessment_document
WHEN NEW.dispute_state = 'open' AND NEW.lifecycle_state <> 'frozen'
BEGIN
  SELECT RAISE(ABORT, 'assessment dispute requires frozen lifecycle');
END;

CREATE TRIGGER IF NOT EXISTS assessment_document_dispute_update_guard
BEFORE UPDATE OF dispute_state, lifecycle_state ON assessment_document
WHEN NEW.dispute_state = 'open' AND NEW.lifecycle_state <> 'frozen'
BEGIN
  SELECT RAISE(ABORT, 'assessment dispute requires frozen lifecycle');
END;

CREATE TRIGGER IF NOT EXISTS assessment_event_reason_insert_guard
BEFORE INSERT ON assessment_event
WHEN LENGTH(NEW.reason_code) NOT BETWEEN 1 AND 80
  OR NEW.reason_code GLOB '*[^A-Za-z0-9_.:-]*'
  OR SUBSTR(NEW.reason_code, 1, 1) NOT GLOB '[A-Za-z0-9]'
BEGIN
  SELECT RAISE(ABORT, 'assessment event reason code is invalid');
END;

CREATE TRIGGER IF NOT EXISTS assessment_event_reason_update_guard
BEFORE UPDATE OF reason_code ON assessment_event
WHEN LENGTH(NEW.reason_code) NOT BETWEEN 1 AND 80
  OR NEW.reason_code GLOB '*[^A-Za-z0-9_.:-]*'
  OR SUBSTR(NEW.reason_code, 1, 1) NOT GLOB '[A-Za-z0-9]'
BEGIN
  SELECT RAISE(ABORT, 'assessment event reason code is invalid');
END;

CREATE TRIGGER IF NOT EXISTS assessment_event_append_only_update_guard
BEFORE UPDATE ON assessment_event
BEGIN
  SELECT RAISE(ABORT, 'assessment event is append-only');
END;

CREATE TRIGGER IF NOT EXISTS assessment_event_append_only_delete_guard
BEFORE DELETE ON assessment_event
BEGIN
  SELECT RAISE(ABORT, 'assessment event is append-only');
END;

CREATE TRIGGER IF NOT EXISTS assessment_deletion_request_identity_update_guard
BEFORE UPDATE ON assessment_deletion_request
WHEN NEW.request_id <> OLD.request_id
  OR NEW.document_id <> OLD.document_id
  OR NEW.expected_version <> OLD.expected_version
  OR NEW.reason_code <> OLD.reason_code
  OR NEW.policy_version <> OLD.policy_version
  OR NEW.effective_at <> OLD.effective_at
  OR NEW.actor_id <> OLD.actor_id
  OR NEW.actor_type <> OLD.actor_type
  OR NEW.actor_source <> OLD.actor_source
  OR NEW.actor_session_id <> OLD.actor_session_id
  OR NEW.actor_assurance <> OLD.actor_assurance
  OR NEW.created_at <> OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'assessment deletion request identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS assessment_deletion_request_delete_guard
BEFORE DELETE ON assessment_deletion_request
BEGIN
  SELECT RAISE(ABORT, 'assessment deletion request cannot be deleted');
END;
`;

function applyAssessmentSchemaMigration(database) {
  if (!database || typeof database.exec !== 'function' || typeof database.transaction !== 'function') {
    throw new Error('database is required');
  }

  database.transaction(() => {
    database.exec(ASSESSMENT_SCHEMA);
    const documentColumns = new Set(
      database.prepare("PRAGMA table_info('assessment_document')").all().map((row) => row.name),
    );
    if (!documentColumns.has('dispute_state')) {
      database.exec(`
        ALTER TABLE assessment_document
        ADD COLUMN dispute_state TEXT NOT NULL DEFAULT 'none'
          CHECK(dispute_state IN ('none', 'open', 'resolved'))
      `);
    }
    if (!documentColumns.has('analysis_status')) {
      database.exec(`
        ALTER TABLE assessment_document
        ADD COLUMN analysis_status TEXT NOT NULL DEFAULT 'pending'
          CHECK(analysis_status IN ('pending', 'ready', 'failed'))
      `);
    }
    if (!documentColumns.has('analysis_schema_version')) {
      database.exec('ALTER TABLE assessment_document ADD COLUMN analysis_schema_version TEXT');
    }
    if (!documentColumns.has('analysis_json')) {
      database.exec('ALTER TABLE assessment_document ADD COLUMN analysis_json TEXT');
    }
    if (!documentColumns.has('analysis_error_code')) {
      database.exec('ALTER TABLE assessment_document ADD COLUMN analysis_error_code TEXT');
    }
    const bindingColumns = new Set(
      database.prepare("PRAGMA table_info('assessment_binding')").all().map((row) => row.name),
    );
    if (!bindingColumns.has('conflict_state')) {
      database.exec(`
        ALTER TABLE assessment_binding
        ADD COLUMN conflict_state TEXT NOT NULL DEFAULT 'none'
          CHECK(conflict_state IN ('none', 'active_report_type_conflict'))
      `);
    }
    // Legacy builds treated one active document per report type as a conflict.
    // A candidate may have multiple reports, including repeated types over time.
    database.exec("UPDATE assessment_binding SET conflict_state = 'none' WHERE conflict_state <> 'none'");
    database.exec(ASSESSMENT_GUARDS);
  })();

  return { tables: [...ASSESSMENT_TABLES] };
}

module.exports = {
  ASSESSMENT_DELETION_INDEXES,
  ASSESSMENT_DELETION_TRIGGERS,
  ASSESSMENT_TABLES,
  ASSESSMENT_SCHEMA,
  applyAssessmentSchemaMigration,
};
