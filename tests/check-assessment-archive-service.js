'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');

const { applyAssessmentSchemaMigration } = require("../src/assessment-schema");
const {
  bindAssessmentDocument,
  confirmAssessmentMetadata,
  prepareAssessmentView,
  recordAssessmentViewed,
} = require("../src/assessment-archive-service");

const NOW = '2026-07-12T00:00:00.000Z';
const ACTOR = Object.freeze({
  actor_id: 'local-primary-operator',
  actor_type: 'local_os_subject',
  actor_source: 'server_local_instance',
  actor_session_id: 'synthetic-assessment-session',
  assurance: 'local_instance_only',
});

function databaseFixture() {
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
    INSERT INTO job (id, name) VALUES (1, '合成岗位一'), (2, '合成岗位二');
    INSERT INTO candidate (internal_id, job_id) VALUES
      ('C-SYNTHETIC-1', 1),
      ('C-SYNTHETIC-2', 2);
  `);
  applyAssessmentSchemaMigration(database);
  return database;
}

function insertDocument(database, {
  id,
  hashCharacter = 'a',
  securityState = 'accepted',
  reviewState = 'pending',
  lifecycleState = 'active',
  reportType = 'unknown',
  version = 1,
} = {}) {
  const accepted = securityState === 'accepted' && lifecycleState !== 'deleted';
  const deleted = lifecycleState === 'deleted';
  database.prepare(`
    INSERT INTO assessment_document (
      id, content_sha256, storage_relpath, byte_size, page_count, mime_detected,
      security_state, report_type, assessment_date, review_state, lifecycle_state,
      legal_hold_state, created_by, version, created_at, updated_at, deleted_at
    ) VALUES (
      @id, @hash, @relpath, @byte_size, @page_count, @mime,
      @security_state, @report_type, NULL, @review_state, @lifecycle_state,
      'none', 'local-primary-operator', @version, @now, @now, @deleted_at
    )
  `).run({
    id,
    hash: accepted ? hashCharacter.repeat(64) : null,
    relpath: accepted ? `accepted/${id}.pdf` : null,
    byte_size: accepted ? 128 : null,
    page_count: accepted ? 1 : null,
    mime: accepted ? 'application/pdf' : null,
    security_state: securityState,
    report_type: deleted ? 'unknown' : reportType,
    review_state: reviewState,
    lifecycle_state: lifecycleState,
    version,
    now: NOW,
    deleted_at: deleted ? NOW : null,
  });
}

function envelope(database, command) {
  return { database, auditContext: ACTOR, command };
}

function confirmCommand(documentId, requestId, expectedVersion = 1) {
  return {
    document_id: documentId,
    report_type: 'career_potential',
    assessment_date: '2026-07-01',
    expected_version: expectedVersion,
    request_id: requestId,
  };
}

function bindCommand(documentId, requestId, expectedVersion, candidateId = 'C-SYNTHETIC-1', jobId = 1) {
  return {
    document_id: documentId,
    candidate_id: candidateId,
    job_id: jobId,
    scope: 'candidate_job_archive',
    identity_basis: 'current_candidate_context',
    reason_code: 'explicit_candidate_context',
    expected_version: expectedVersion,
    request_id: requestId,
  };
}

function viewCommand(binding, requestId, overrides = {}) {
  return {
    binding_id: binding.binding_id,
    document_id: binding.document_id,
    candidate_id: binding.candidate_id,
    job_id: binding.job_id,
    request_id: requestId,
    ...overrides,
  };
}

function expectCode(callback, code) {
  let thrown = null;
  try {
    callback();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, `expected ${code}`);
  assert.strictEqual(thrown.code, code, thrown.stack);
  const serialized = `${thrown.message}|${thrown.code}|${thrown.path || ''}`;
  for (const forbidden of ['SYNTHETIC PERSON NAME', '/Users/private', 'original-resume.pdf', 'PDF SECRET BODY']) {
    assert.strictEqual(serialized.includes(forbidden), false, `error leaked forbidden value: ${forbidden}`);
  }
  return thrown;
}

function checkNormalFlowAndReplay() {
  const database = databaseFixture();
  insertDocument(database, { id: 'DOC-NORMAL' });

  const confirmed = confirmAssessmentMetadata(envelope(
    database,
    confirmCommand('DOC-NORMAL', 'REQ-METADATA-NORMAL'),
  ));
  assert.deepStrictEqual({
    operation: confirmed.operation,
    document_id: confirmed.document_id,
    report_type: confirmed.report_type,
    review_state: confirmed.review_state,
    version: confirmed.version,
  }, {
    operation: 'metadata_confirmed',
    document_id: 'DOC-NORMAL',
    report_type: 'career_potential',
    review_state: 'ready',
    version: 2,
  });

  const binding = bindAssessmentDocument(envelope(
    database,
    bindCommand('DOC-NORMAL', 'REQ-BIND-NORMAL', confirmed.version),
  ));
  assert.strictEqual(binding.state, 'active');
  assert.strictEqual(binding.scope, 'candidate_job_archive');
  assert.strictEqual(binding.document_version, 3);

  const viewInput = viewCommand(binding, 'REQ-VIEW-NORMAL');
  const prepared = prepareAssessmentView(envelope(
    database,
    viewInput,
  ));
  assert.strictEqual(prepared.internal_only, true);
  assert.strictEqual(prepared.api_dto, false);
  assert.strictEqual(prepared.storage_relpath, 'accepted/DOC-NORMAL.pdf');
  assert.strictEqual(prepared.content_sha256, 'a'.repeat(64));
  assert.strictEqual(prepared.byte_size, 128);
  assert.strictEqual(database.prepare("SELECT COUNT(*) AS n FROM assessment_event WHERE event_type = 'viewed'").get().n, 0,
    'prepare must not record viewed');

  const viewed = recordAssessmentViewed(envelope(database, viewInput));
  assert.strictEqual(viewed.authorized, true);
  assert.strictEqual(Object.hasOwn(viewed, 'storage_relpath'), false, 'API-facing authorization must omit storage path');
  assert.strictEqual(JSON.stringify(viewed).includes('accepted/'), false, 'authorization must not leak an internal path');

  const confirmedReplay = confirmAssessmentMetadata(envelope(
    database,
    confirmCommand('DOC-NORMAL', 'REQ-METADATA-NORMAL'),
  ));
  assert.strictEqual(confirmedReplay.idempotent_replay, true);
  assert.strictEqual(confirmedReplay.event_id, confirmed.event_id);
  assert.strictEqual(confirmedReplay.version, confirmed.version, 'replay must preserve the committed response version');

  const bindingReplay = bindAssessmentDocument(envelope(
    database,
    bindCommand('DOC-NORMAL', 'REQ-BIND-NORMAL', confirmed.version),
  ));
  assert.strictEqual(bindingReplay.idempotent_replay, true);
  assert.strictEqual(bindingReplay.binding_id, binding.binding_id);

  const viewedReplay = recordAssessmentViewed(envelope(
    database,
    viewInput,
  ));
  assert.strictEqual(viewedReplay.idempotent_replay, true);
  assert.strictEqual(viewedReplay.event_id, viewed.event_id);
  assert.strictEqual(database.prepare('SELECT COUNT(*) AS n FROM assessment_event').get().n, 3);

  const viewEvent = database.prepare(`
    SELECT event_type, actor_id, actor_type, actor_source,
           actor_session_id, actor_assurance, request_id
    FROM assessment_event WHERE request_id = 'REQ-VIEW-NORMAL'
  `).get();
  assert.deepStrictEqual(viewEvent, {
    event_type: 'viewed',
    actor_id: 'local-primary-operator',
    actor_type: 'local_os_subject',
    actor_source: 'server_local_instance',
    actor_session_id: 'synthetic-assessment-session',
    actor_assurance: 'local_instance_only',
    request_id: 'REQ-VIEW-NORMAL',
  });

  database.prepare("UPDATE assessment_document SET lifecycle_state = 'frozen' WHERE id = 'DOC-NORMAL'").run();
  expectCode(() => recordAssessmentViewed(envelope(database, viewInput)), 'DOCUMENT_FROZEN');
  assert.strictEqual(database.prepare("SELECT COUNT(*) AS n FROM assessment_event WHERE event_type = 'viewed'").get().n, 1,
    'a frozen replay must not append another event');

  database.close();
}

function checkDocumentGates() {
  const database = databaseFixture();
  insertDocument(database, { id: 'DOC-PENDING-SECURITY', securityState: 'pending', hashCharacter: 'b' });
  insertDocument(database, { id: 'DOC-NOT-READY', reviewState: 'pending', hashCharacter: 'c' });
  insertDocument(database, {
    id: 'DOC-FROZEN', reviewState: 'ready', lifecycleState: 'frozen', reportType: 'career_potential', hashCharacter: 'd',
  });
  insertDocument(database, {
    id: 'DOC-DELETED', securityState: 'accepted', reviewState: 'superseded', lifecycleState: 'deleted', hashCharacter: 'e',
  });

  expectCode(() => confirmAssessmentMetadata(envelope(
    database,
    confirmCommand('DOC-PENDING-SECURITY', 'REQ-PENDING-SECURITY'),
  )), 'DOCUMENT_SECURITY_NOT_ACCEPTED');
  expectCode(() => bindAssessmentDocument(envelope(
    database,
    bindCommand('DOC-NOT-READY', 'REQ-NOT-READY', 1),
  )), 'DOCUMENT_NOT_READY');
  expectCode(() => bindAssessmentDocument(envelope(
    database,
    bindCommand('DOC-FROZEN', 'REQ-FROZEN', 1),
  )), 'DOCUMENT_FROZEN');
  expectCode(() => confirmAssessmentMetadata(envelope(
    database,
    confirmCommand('DOC-DELETED', 'REQ-DELETED'),
  )), 'DOCUMENT_DELETED');
  assert.strictEqual(database.prepare('SELECT COUNT(*) AS n FROM assessment_event').get().n, 0);
  database.close();
}

function checkContextVersionAndBindingGates() {
  const database = databaseFixture();
  insertDocument(database, { id: 'DOC-GATES', hashCharacter: 'f' });

  expectCode(() => confirmAssessmentMetadata({
    database,
    command: confirmCommand('DOC-GATES', 'REQ-NO-ACTOR'),
  }), 'AUDIT_CONTEXT_REQUIRED');
  expectCode(() => confirmAssessmentMetadata({
    database,
    auditContext: { ...ACTOR, actor_type: 'authenticated_user' },
    command: confirmCommand('DOC-GATES', 'REQ-FORGED-ACTOR'),
  }), 'AUDIT_CONTEXT_INVALID');
  expectCode(() => confirmAssessmentMetadata({
    database,
    auditContext: { ...ACTOR, actor_session_id: ' ' },
    command: confirmCommand('DOC-GATES', 'REQ-BLANK-SESSION'),
  }), 'AUDIT_CONTEXT_INVALID');
  expectCode(() => confirmAssessmentMetadata(envelope(
    database,
    confirmCommand('DOC-GATES', 'REQ-STALE', 2),
  )), 'STALE_VERSION');

  const confirmed = confirmAssessmentMetadata(envelope(
    database,
    confirmCommand('DOC-GATES', 'REQ-GATES-CONFIRM'),
  ));
  expectCode(() => bindAssessmentDocument(envelope(
    database,
    bindCommand('DOC-GATES', 'REQ-CANDIDATE-JOB-MISMATCH', confirmed.version, 'C-SYNTHETIC-1', 2),
  )), 'CANDIDATE_JOB_MISMATCH');
  expectCode(() => bindAssessmentDocument(envelope(
    database,
    { ...bindCommand('DOC-GATES', 'REQ-SCOPE', confirmed.version), scope: 'application_evidence' },
  )), 'SCOPE_INVALID');
  expectCode(() => prepareAssessmentView(envelope(database, {
    binding_id: 'BINDING-MISSING',
    document_id: 'DOC-GATES',
    candidate_id: 'C-SYNTHETIC-1',
    job_id: 1,
    request_id: 'REQ-VIEW-WITHOUT-BINDING',
  })), 'ACTIVE_BINDING_REQUIRED');

  const binding = bindAssessmentDocument(envelope(
    database,
    bindCommand('DOC-GATES', 'REQ-GATES-BIND', confirmed.version),
  ));
  expectCode(() => bindAssessmentDocument(envelope(
    database,
    bindCommand('DOC-GATES', 'REQ-DOUBLE-ACTIVE', binding.document_version),
  )), 'DOCUMENT_ALREADY_BOUND');
  expectCode(() => prepareAssessmentView(envelope(
    database,
    viewCommand(binding, 'REQ-VIEW-CONTEXT-MISMATCH', { candidate_id: 'C-SYNTHETIC-2', job_id: 2 }),
  )), 'BINDING_CONTEXT_MISMATCH');

  const preparedButNotRecorded = viewCommand(binding, 'REQ-VIEW-FROZEN');
  prepareAssessmentView(envelope(database, preparedButNotRecorded));
  assert.strictEqual(database.prepare("SELECT COUNT(*) AS n FROM assessment_event WHERE request_id = 'REQ-VIEW-FROZEN'").get().n, 0,
    'prepare must remain audit-event free');
  database.prepare(`
    UPDATE assessment_document SET lifecycle_state = 'frozen'
    WHERE id = 'DOC-GATES'
  `).run();
  expectCode(() => recordAssessmentViewed(envelope(database, preparedButNotRecorded)), 'DOCUMENT_FROZEN');
  assert.strictEqual(database.prepare("SELECT COUNT(*) AS n FROM assessment_event WHERE request_id = 'REQ-VIEW-FROZEN'").get().n, 0,
    'freeze between prepare and record must not create viewed');
  database.prepare(`
    UPDATE assessment_document
    SET lifecycle_state = 'deleted', review_state = 'superseded',
        content_sha256 = NULL, storage_relpath = NULL, byte_size = NULL,
        page_count = NULL, mime_detected = NULL, assessment_date = NULL,
        deleted_at = @now
    WHERE id = 'DOC-GATES'
  `).run({ now: NOW });
  expectCode(() => recordAssessmentViewed(envelope(
    database,
    viewCommand(binding, 'REQ-VIEW-DELETED'),
  )), 'DOCUMENT_DELETED');

  database.close();
}

function checkIdempotencyConflicts() {
  const database = databaseFixture();
  insertDocument(database, { id: 'DOC-IDEMPOTENCY-A', hashCharacter: '1' });
  insertDocument(database, { id: 'DOC-IDEMPOTENCY-B', hashCharacter: '2' });
  const confirmed = confirmAssessmentMetadata(envelope(
    database,
    confirmCommand('DOC-IDEMPOTENCY-A', 'REQ-IDEMPOTENCY'),
  ));

  expectCode(() => confirmAssessmentMetadata(envelope(database, {
    ...confirmCommand('DOC-IDEMPOTENCY-A', 'REQ-IDEMPOTENCY'),
    report_type: 'team_role',
  })), 'IDEMPOTENCY_CONFLICT');
  expectCode(() => confirmAssessmentMetadata(envelope(database, {
    ...confirmCommand('DOC-IDEMPOTENCY-A', 'REQ-IDEMPOTENCY'),
    assessment_date: '2026-07-02',
  })), 'IDEMPOTENCY_CONFLICT');
  expectCode(() => confirmAssessmentMetadata(envelope(
    database,
    confirmCommand('DOC-IDEMPOTENCY-B', 'REQ-IDEMPOTENCY'),
  )), 'IDEMPOTENCY_CONFLICT');
  expectCode(() => bindAssessmentDocument(envelope(
    database,
    bindCommand('DOC-IDEMPOTENCY-A', 'REQ-IDEMPOTENCY', 2),
  )), 'IDEMPOTENCY_CONFLICT');

  expectCode(() => bindAssessmentDocument(envelope(database, {
    ...bindCommand('DOC-IDEMPOTENCY-A', 'REQ-REASON-FREE-TEXT', confirmed.version),
    reason_code: 'SYNTHETIC PERSON NAME requested this binding',
  })), 'REASON_CODE_INVALID');
  const binding = bindAssessmentDocument(envelope(
    database,
    bindCommand('DOC-IDEMPOTENCY-A', 'REQ-BIND-PAYLOAD', confirmed.version),
  ));
  expectCode(() => bindAssessmentDocument(envelope(database, {
    ...bindCommand('DOC-IDEMPOTENCY-A', 'REQ-BIND-PAYLOAD', confirmed.version),
    identity_basis: 'same_source_identity',
  })), 'IDEMPOTENCY_CONFLICT');
  expectCode(() => bindAssessmentDocument(envelope(database, {
    ...bindCommand('DOC-IDEMPOTENCY-A', 'REQ-BIND-PAYLOAD', confirmed.version),
    reason_code: 'different_controlled_reason',
  })), 'IDEMPOTENCY_CONFLICT');
  assert.ok(binding.binding_id);
  database.close();
}

function checkCalendarDateValidation() {
  const database = databaseFixture();
  insertDocument(database, { id: 'DOC-INVALID-DATE', hashCharacter: '4' });
  expectCode(() => confirmAssessmentMetadata(envelope(database, {
    ...confirmCommand('DOC-INVALID-DATE', 'REQ-INVALID-DATE'),
    assessment_date: '2026-02-30',
  })), 'ASSESSMENT_DATE_INVALID');
  assert.strictEqual(database.prepare("SELECT COUNT(*) AS n FROM assessment_event WHERE request_id = 'REQ-INVALID-DATE'").get().n, 0);
  database.close();
}

function checkAtomicRollback() {
  const database = databaseFixture();
  insertDocument(database, { id: 'DOC-ATOMIC', hashCharacter: '3' });
  database.exec(`
    CREATE TRIGGER synthetic_fail_metadata_event
    BEFORE INSERT ON assessment_event
    WHEN NEW.request_id = 'REQ-ATOMIC-FAIL'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic event failure');
    END;
  `);

  assert.throws(() => confirmAssessmentMetadata(envelope(
    database,
    confirmCommand('DOC-ATOMIC', 'REQ-ATOMIC-FAIL'),
  )), /synthetic event failure/);
  assert.deepStrictEqual(database.prepare(`
    SELECT review_state, report_type, assessment_date, version
    FROM assessment_document WHERE id = 'DOC-ATOMIC'
  `).get(), {
    review_state: 'pending',
    report_type: 'unknown',
    assessment_date: null,
    version: 1,
  });
  assert.strictEqual(database.prepare(`
    SELECT COUNT(*) AS n FROM assessment_event WHERE request_id = 'REQ-ATOMIC-FAIL'
  `).get().n, 0);

  database.exec('DROP TRIGGER synthetic_fail_metadata_event;');
  const confirmed = confirmAssessmentMetadata(envelope(
    database,
    confirmCommand('DOC-ATOMIC', 'REQ-ATOMIC-PREPARE'),
  ));
  database.exec(`
    CREATE TRIGGER synthetic_fail_binding_event
    BEFORE INSERT ON assessment_event
    WHEN NEW.request_id = 'REQ-BIND-ATOMIC-FAIL'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic binding event failure');
    END;
  `);
  assert.throws(() => bindAssessmentDocument(envelope(
    database,
    bindCommand('DOC-ATOMIC', 'REQ-BIND-ATOMIC-FAIL', confirmed.version),
  )), /synthetic binding event failure/);
  assert.strictEqual(database.prepare(`
    SELECT version FROM assessment_document WHERE id = 'DOC-ATOMIC'
  `).get().version, confirmed.version, 'failed binding must roll back document version bump');
  assert.strictEqual(database.prepare(`
    SELECT COUNT(*) AS n FROM assessment_binding WHERE document_id = 'DOC-ATOMIC'
  `).get().n, 0, 'failed binding must not leave a binding row');
  database.close();
}

checkNormalFlowAndReplay();
checkDocumentGates();
checkContextVersionAndBindingGates();
checkIdempotencyConflicts();
checkCalendarDateValidation();
checkAtomicRollback();

console.log(JSON.stringify({
  ok: true,
  task: 'P0-IMPL-002-A',
  synthetic_only: true,
  operations: ['metadata_confirmed', 'binding_confirmed', 'viewed'],
}));
