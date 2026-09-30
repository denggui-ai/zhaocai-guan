const assert = require('assert');
const Database = require('better-sqlite3');
const {
  ASSESSMENT_TABLES,
  applyAssessmentSchemaMigration,
} = require('./assessment-schema');

const NOW = '2026-07-12T00:00:00.000Z';
const LATER = '2026-07-12T00:01:00.000Z';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function createSyntheticDatabase() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE job (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE candidate (
      internal_id TEXT PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT
    );

    INSERT INTO job (id, name) VALUES
      (1, '合成岗位一'),
      (2, '合成岗位二');
    INSERT INTO candidate (internal_id, job_id) VALUES
      ('C-SYNTHETIC-1', 1),
      ('C-SYNTHETIC-2', 2);
  `);
  return database;
}

function tableNames(database) {
  return database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'assessment_%'
    ORDER BY name
  `).all().map((row) => row.name);
}

function insertAcceptedDocument(database, {
  id,
  hash,
  reportType = 'career_potential',
  reviewState = 'ready',
} = {}) {
  database.prepare(`
    INSERT INTO assessment_document (
      id, content_sha256, storage_relpath, byte_size, page_count, mime_detected,
      security_state, report_type, review_state, lifecycle_state,
      legal_hold_state, created_by, version, created_at, updated_at
    ) VALUES (
      @id, @hash, @storageRelpath, 128, 1, 'application/pdf',
      'accepted', @reportType, @reviewState, 'active',
      'none', 'local-primary-operator', 1, @now, @now
    )
  `).run({
    id,
    hash,
    storageRelpath: `accepted/${id}.pdf`,
    reportType,
    reviewState,
    now: NOW,
  });
}

function insertBinding(database, {
  id,
  documentId,
  candidateId = 'C-SYNTHETIC-1',
  jobId = 1,
  state = 'active',
  requestId,
  revokedAt = null,
} = {}) {
  database.prepare(`
    INSERT INTO assessment_binding (
      id, document_id, candidate_id, job_id, scope, state, identity_basis,
      actor_id, reason_code, request_id, version, created_at, updated_at, revoked_at
    ) VALUES (
      @id, @documentId, @candidateId, @jobId, 'candidate_job_archive', @state,
      'current_candidate_context', 'local-primary-operator', 'synthetic_test',
      @requestId, 1, @now, @now, @revokedAt
    )
  `).run({
    id,
    documentId,
    candidateId,
    jobId,
    state,
    requestId,
    revokedAt,
    now: NOW,
  });
}

function insertEvent(database, {
  id,
  requestId,
  eventType = 'uploaded',
  actorType = 'local_os_subject',
  actorSource = 'server_local_instance',
  actorSessionId = 'INSTANCE-SYNTHETIC-1',
  actorAssurance = 'local_instance_only',
}) {
  database.prepare(`
    INSERT INTO assessment_event (
      id, object_type, object_id, event_type, actor_id,
      actor_type, actor_source, actor_session_id, actor_assurance,
      request_id, reason_code, before_version, after_version, created_at
    ) VALUES (
      @id, 'document', 'DOC-SYNTHETIC-1', @eventType, 'local-primary-operator',
      @actorType, @actorSource, @actorSessionId, @actorAssurance,
      @requestId, 'synthetic_test', NULL, 1, @now
    )
  `).run({
    id,
    eventType,
    actorType,
    actorSource,
    actorSessionId,
    actorAssurance,
    requestId,
    now: NOW,
  });
}

function checkCreationAndIdempotency() {
  const database = createSyntheticDatabase();
  const result = applyAssessmentSchemaMigration(database);
  assert.deepEqual(result.tables, ASSESSMENT_TABLES);
  assert.deepEqual(tableNames(database), [...ASSESSMENT_TABLES].sort());

  const firstSchema = database.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE name LIKE 'assessment_%'
    ORDER BY type, name
  `).all();
  const secondResult = applyAssessmentSchemaMigration(database);
  const secondSchema = database.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE name LIKE 'assessment_%'
    ORDER BY type, name
  `).all();
  assert.deepEqual(secondResult.tables, ASSESSMENT_TABLES);
  assert.deepEqual(secondSchema, firstSchema, 'repeated migration must not change schema objects');
  database.close();
}

function checkDocumentConstraints() {
  const database = createSyntheticDatabase();
  applyAssessmentSchemaMigration(database);

  assert.throws(() => database.prepare(`
    INSERT INTO assessment_document (
      id, security_state, report_type, review_state, lifecycle_state,
      legal_hold_state, created_by, created_at, updated_at
    ) VALUES (
      NULL, 'pending', 'unknown', 'pending', 'active',
      'none', 'local-primary-operator', ?, ?
    )
  `).run(NOW, NOW), /NOT NULL constraint failed/);

  assert.throws(() => database.prepare(`
    INSERT INTO assessment_document (
      id, security_state, report_type, review_state, lifecycle_state,
      legal_hold_state, created_by, created_at, updated_at
    ) VALUES (
      'DOC-BAD-ENUM', 'unsafe', 'unknown', 'pending', 'active',
      'none', 'local-primary-operator', ?, ?
    )
  `).run(NOW, NOW), /CHECK constraint failed/);

  assert.throws(() => database.prepare(`
    INSERT INTO assessment_document (
      id, security_state, report_type, review_state, lifecycle_state,
      legal_hold_state, created_by, created_at, updated_at
    ) VALUES (
      'DOC-READY-TOO-EARLY', 'pending', 'unknown', 'ready', 'active',
      'none', 'local-primary-operator', ?, ?
    )
  `).run(NOW, NOW), /CHECK constraint failed/);

  assert.throws(() => database.prepare(`
    INSERT INTO assessment_document (
      id, security_state, report_type, review_state, lifecycle_state,
      legal_hold_state, created_by, created_at, updated_at
    ) VALUES (
      'DOC-INCOMPLETE-ACCEPTED', 'accepted', 'unknown', 'pending', 'active',
      'none', 'local-primary-operator', ?, ?
    )
  `).run(NOW, NOW), /CHECK constraint failed/);

  insertAcceptedDocument(database, { id: 'DOC-SYNTHETIC-1', hash: HASH_A });
  assert.throws(() => insertAcceptedDocument(database, {
    id: 'DOC-DUPLICATE-HASH',
    hash: HASH_A,
  }), /UNIQUE constraint failed/);

  assert.throws(() => database.prepare(`
    INSERT INTO assessment_document (
      id, security_state, report_type, review_state, lifecycle_state,
      legal_hold_state, supersedes_document_id, created_by, created_at, updated_at
    ) VALUES (
      'DOC-DANGLING', 'pending', 'unknown', 'pending', 'active',
      'none', 'DOC-MISSING', 'local-primary-operator', ?, ?
    )
  `).run(NOW, NOW), /FOREIGN KEY constraint failed/);
  database.close();
}

function checkBindingAndForeignKeys() {
  const database = createSyntheticDatabase();
  applyAssessmentSchemaMigration(database);
  insertAcceptedDocument(database, { id: 'DOC-SYNTHETIC-1', hash: HASH_A });
  insertAcceptedDocument(database, {
    id: 'DOC-SYNTHETIC-2',
    hash: HASH_B,
    reportType: 'workplace_style',
  });

  assert.throws(() => insertBinding(database, {
    id: 'BIND-DANGLING-DOCUMENT',
    documentId: 'DOC-MISSING',
    requestId: 'REQ-BIND-DANGLING-DOCUMENT',
  }), /FOREIGN KEY constraint failed/);
  assert.throws(() => insertBinding(database, {
    id: 'BIND-DANGLING-CANDIDATE',
    documentId: 'DOC-SYNTHETIC-1',
    candidateId: 'C-MISSING',
    requestId: 'REQ-BIND-DANGLING-CANDIDATE',
  }), /FOREIGN KEY constraint failed/);
  assert.throws(() => insertBinding(database, {
    id: 'BIND-DANGLING-JOB',
    documentId: 'DOC-SYNTHETIC-1',
    jobId: 999,
    requestId: 'REQ-BIND-DANGLING-JOB',
  }), /FOREIGN KEY constraint failed/);

  assert.throws(() => database.prepare(`
    INSERT INTO assessment_binding (
      id, document_id, candidate_id, job_id, scope, state, identity_basis,
      actor_id, reason_code, request_id, version, created_at, updated_at
    ) VALUES (
      'BIND-BAD-SCOPE', 'DOC-SYNTHETIC-1', 'C-SYNTHETIC-1', 1,
      'application_evidence', 'pending', 'current_candidate_context',
      'local-primary-operator', 'synthetic_test', 'REQ-BAD-SCOPE', 1, ?, ?
    )
  `).run(NOW, NOW), /CHECK constraint failed/);

  insertBinding(database, {
    id: 'BIND-ACTIVE-1',
    documentId: 'DOC-SYNTHETIC-1',
    requestId: 'REQ-BIND-ACTIVE-1',
  });
  assert.throws(() => insertBinding(database, {
    id: 'BIND-ACTIVE-2',
    documentId: 'DOC-SYNTHETIC-1',
    requestId: 'REQ-BIND-ACTIVE-2',
  }), /UNIQUE constraint failed/);

  database.prepare(`
    UPDATE assessment_binding
    SET state = 'revoked', revoked_at = ?, updated_at = ?, version = version + 1
    WHERE id = 'BIND-ACTIVE-1'
  `).run(LATER, LATER);
  insertBinding(database, {
    id: 'BIND-ACTIVE-2',
    documentId: 'DOC-SYNTHETIC-1',
    candidateId: 'C-SYNTHETIC-2',
    jobId: 2,
    requestId: 'REQ-BIND-ACTIVE-2',
  });
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n
    FROM assessment_binding
    WHERE document_id = 'DOC-SYNTHETIC-1' AND state = 'active'
  `).get().n, 1, 'a legal revoke must permit one new active binding');

  insertBinding(database, {
    id: 'BIND-PENDING-REQUEST',
    documentId: 'DOC-SYNTHETIC-2',
    state: 'pending',
    requestId: 'REQ-BIND-PENDING',
  });
  assert.throws(() => insertBinding(database, {
    id: 'BIND-DUPLICATE-REQUEST',
    documentId: 'DOC-SYNTHETIC-2',
    state: 'pending',
    requestId: 'REQ-BIND-PENDING',
  }), /UNIQUE constraint failed/);

  // candidate -> job membership remains an explicit service-layer transaction rule.
  assert.doesNotThrow(() => insertBinding(database, {
    id: 'BIND-MISMATCH-SERVICE-GATE',
    documentId: 'DOC-SYNTHETIC-2',
    candidateId: 'C-SYNTHETIC-1',
    jobId: 2,
    state: 'pending',
    requestId: 'REQ-MISMATCH-SERVICE-GATE',
  }));
  database.close();
}

function checkEventConstraintsAndRequestId() {
  const database = createSyntheticDatabase();
  applyAssessmentSchemaMigration(database);
  insertEvent(database, { id: 'EVENT-1', requestId: 'REQ-EVENT-1' });
  assert.deepEqual(database.prepare(`
    SELECT actor_type, actor_source, actor_session_id, actor_assurance
    FROM assessment_event
    WHERE id = 'EVENT-1'
  `).get(), {
    actor_type: 'local_os_subject',
    actor_source: 'server_local_instance',
    actor_session_id: 'INSTANCE-SYNTHETIC-1',
    actor_assurance: 'local_instance_only',
  });
  assert.throws(() => insertEvent(database, {
    id: 'EVENT-2',
    requestId: 'REQ-EVENT-1',
    eventType: 'metadata_confirmed',
  }), /UNIQUE constraint failed/);
  assert.throws(() => insertEvent(database, {
    id: 'EVENT-BAD-TYPE',
    requestId: 'REQ-EVENT-BAD-TYPE',
    eventType: 'assessment_scored',
  }), /CHECK constraint failed/);

  for (const [field, patch] of Object.entries({
    actor_type: { actorType: '' },
    actor_source: { actorSource: '' },
    actor_session_id: { actorSessionId: '' },
    actor_assurance: { actorAssurance: '' },
  })) {
    assert.throws(() => insertEvent(database, {
      id: `EVENT-EMPTY-${field}`,
      requestId: `REQ-EVENT-EMPTY-${field}`,
      ...patch,
    }), /CHECK constraint failed/, `${field} must reject an empty value`);
  }

  assert.throws(() => insertEvent(database, {
    id: 'EVENT-NULL-SESSION',
    requestId: 'REQ-EVENT-NULL-SESSION',
    actorSessionId: null,
  }), /NOT NULL constraint failed/);
  database.close();
}

function checkAtomicFailure() {
  const database = createSyntheticDatabase();
  database.exec('CREATE VIEW assessment_event AS SELECT 1 AS id;');
  assert.throws(() => applyAssessmentSchemaMigration(database), /views may not be indexed/);
  assert.deepEqual(
    tableNames(database),
    [],
    'a failed schema migration must roll back every newly created assessment table',
  );
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n
    FROM sqlite_master
    WHERE type = 'view' AND name = 'assessment_event'
  `).get().n, 1, 'the pre-existing synthetic failure fixture must be preserved');
  database.close();
}

assert.throws(() => applyAssessmentSchemaMigration(null), /database is required/);
checkCreationAndIdempotency();
checkDocumentConstraints();
checkBindingAndForeignKeys();
checkEventConstraintsAndRequestId();
checkAtomicFailure();

console.log(JSON.stringify({
  ok: true,
  task: 'P0-IMPL-001-A',
  tables: ASSESSMENT_TABLES,
  synthetic_only: true,
}));
