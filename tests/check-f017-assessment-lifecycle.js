'use strict';

const assert = require('assert');
const Database = require('better-sqlite3');

const { ASSESSMENT_SCHEMA, applyAssessmentSchemaMigration } = require("../src/assessment-schema");
const {
  applyAssessmentLegalHold,
  confirmAssessmentBinding,
  confirmAssessmentMetadata,
  createPendingAssessmentBinding,
  listAssessmentArchives,
  listAssessmentQueue,
  openAssessmentDispute,
  prepareAssessmentExport,
  prepareAssessmentView,
  rebindAssessmentDocument,
  recordAssessmentDocumentIntake,
  releaseAssessmentLegalHold,
  requestAssessmentDeletion,
  resolveAssessmentDispute,
  revokeAssessmentBinding,
  supersedeAssessmentDocument,
  tombstoneAssessmentDocumentByPolicy,
} = require("../src/assessment-archive-service");

const ACTOR = Object.freeze({
  actor_id: 'local-primary-operator',
  actor_type: 'local_os_subject',
  actor_source: 'server_local_instance',
  actor_session_id: 'synthetic-f017-lifecycle',
  assurance: 'local_instance_only',
});

function fixture() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE job (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE candidate (
      internal_id TEXT PRIMARY KEY,
      job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE RESTRICT
    );
    INSERT INTO job VALUES (1, '合成岗位一'), (2, '合成岗位二');
    INSERT INTO candidate VALUES ('C-SYNTH-1', 1), ('C-SYNTH-2', 2);
  `);
  applyAssessmentSchemaMigration(database);
  return database;
}

function envelope(database, command) {
  return { database, auditContext: ACTOR, command };
}

function expectCode(work, code) {
  let caught;
  try { work(); } catch (error) { caught = error; }
  assert.ok(caught, `expected ${code}`);
  assert.equal(caught.code, code, caught.stack);
  return caught;
}

let hashCounter = 0;
function intake(database, requestId, options = {}) {
  hashCounter += 1;
  return recordAssessmentDocumentIntake(envelope(database, {
    content_sha256: (options.hashCharacter || hashCounter.toString(16)).repeat(64),
    storage_relpath: `assessment/${requestId}.pdf`,
    byte_size: 512,
    page_count: 2,
    mime_detected: 'application/pdf',
    security_state: options.securityState || 'accepted',
    retention_policy_version: options.policyVersion,
    delete_after: options.deleteAfter,
    request_id: requestId,
  }));
}

function ready(database, documentId, requestId, reportType = 'career_potential', expectedVersion = 1) {
  return confirmAssessmentMetadata(envelope(database, {
    document_id: documentId,
    report_type: reportType,
    assessment_date: '2026-07-01',
    expected_version: expectedVersion,
    request_id: requestId,
  }));
}

function pending(database, documentId, requestId, expectedVersion, candidateId = 'C-SYNTH-1', jobId = 1) {
  return createPendingAssessmentBinding(envelope(database, {
    document_id: documentId,
    candidate_id: candidateId,
    job_id: jobId,
    scope: 'candidate_job_archive',
    identity_basis: 'current_candidate_context',
    reason_code: 'explicit_context_review',
    expected_version: expectedVersion,
    request_id: requestId,
  }));
}

function confirm(database, bindingId, requestId, expectedVersion = 1) {
  return confirmAssessmentBinding(envelope(database, {
    binding_id: bindingId,
    expected_version: expectedVersion,
    reason_code: 'human_confirmation',
    request_id: requestId,
  }));
}

function transition(database, fn, documentId, expectedVersion, requestId, extra = {}) {
  return fn(envelope(database, {
    document_id: documentId,
    expected_version: expectedVersion,
    reason_code: 'controlled_lifecycle_reason',
    request_id: requestId,
    ...extra,
  }));
}

function seedSyntheticPhysicalDeleteEvidence(database, documentId, expectedVersion, requestId) {
  database.prepare(`
    INSERT INTO assessment_deletion_request (
      request_id, document_id, expected_version, reason_code, policy_version, effective_at,
      state, last_error_code, attempt_count,
      actor_id, actor_type, actor_source, actor_session_id, actor_assurance,
      created_at, updated_at, physical_deleted_at, completed_at
    ) VALUES (
      ?, ?, ?, 'controlled_lifecycle_reason', 'assessment-retention-v1',
      '2026-07-13T00:00:00.000Z', 'pending', NULL, 1,
      'local-primary-operator', 'local_os_subject', 'server_local_instance',
      'synthetic-f017-lifecycle', 'local_instance_only',
      '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z',
      '2026-07-13T00:00:00.000Z', NULL
    )
  `).run(requestId, documentId, expectedVersion);
}

function checkFoundationUpgrade() {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE job (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE candidate (internal_id TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id));
  `);
  const legacy = ASSESSMENT_SCHEMA
    .replace(/  dispute_state TEXT NOT NULL DEFAULT 'none'\n    CHECK\(dispute_state IN \('none', 'open', 'resolved'\)\),\n/, '')
    .replace(/  CHECK\(dispute_state <> 'open' OR lifecycle_state = 'frozen'\),\n/, '')
    .replace(/  conflict_state TEXT NOT NULL DEFAULT 'none'\n    CHECK\(conflict_state IN \('none', 'active_report_type_conflict'\)\),\n/, '');
  database.exec(legacy);
  applyAssessmentSchemaMigration(database);
  applyAssessmentSchemaMigration(database);
  assert.ok(database.prepare("PRAGMA table_info('assessment_document')").all().some((row) => row.name === 'dispute_state'));
  assert.ok(database.prepare("PRAGMA table_info('assessment_binding')").all().some((row) => row.name === 'conflict_state'));
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM sqlite_master
    WHERE type = 'trigger' AND name IN (
      'assessment_document_dispute_insert_guard', 'assessment_document_dispute_update_guard',
      'assessment_event_reason_insert_guard', 'assessment_event_reason_update_guard',
      'assessment_event_append_only_update_guard', 'assessment_event_append_only_delete_guard',
      'assessment_deletion_request_identity_update_guard', 'assessment_deletion_request_delete_guard'
    )
  `).get().n, 8);
  database.close();
}

function checkIntakeDuplicateAndSecurityGates() {
  const database = fixture();
  const accepted = intake(database, 'REQ-INTAKE-ACCEPTED', { hashCharacter: 'a' });
  const duplicate = recordAssessmentDocumentIntake(envelope(database, {
    content_sha256: 'a'.repeat(64), storage_relpath: 'assessment/duplicate.pdf', byte_size: 512,
    page_count: 2, mime_detected: 'application/pdf', security_state: 'accepted', request_id: 'REQ-DUPLICATE',
  }));
  assert.equal(duplicate.operation, 'duplicate_seen');
  assert.equal(duplicate.document_id, accepted.document_id);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM assessment_document').get().n, 1);
  assert.equal(recordAssessmentDocumentIntake(envelope(database, {
    content_sha256: 'a'.repeat(64), storage_relpath: 'assessment/duplicate-replay.pdf', byte_size: 512,
    page_count: 2, mime_detected: 'application/pdf', security_state: 'accepted', request_id: 'REQ-DUPLICATE',
  })).idempotent_replay, true);

  for (const [state, hashCharacter] of [['quarantined', 'b'], ['rejected', 'c']]) {
    const rejected = intake(database, `REQ-${state.toUpperCase()}`, { securityState: state, hashCharacter });
    const row = database.prepare('SELECT review_state, lifecycle_state FROM assessment_document WHERE id = ?').get(rejected.document_id);
    assert.deepEqual(row, { review_state: 'rejected', lifecycle_state: 'frozen' });
    expectCode(() => ready(database, rejected.document_id, `REQ-CONFIRM-${state}`), 'DOCUMENT_FROZEN');
  }
  database.close();
}

function checkUnknownRequiresClassification() {
  const database = fixture();
  const document = intake(database, 'REQ-DOC-UNKNOWN', { hashCharacter: '7' });
  expectCode(
    () => ready(database, document.document_id, 'REQ-READY-UNKNOWN', 'unknown'),
    'REPORT_TYPE_CLASSIFICATION_REQUIRED',
  );
  assert.deepEqual(database.prepare(`
    SELECT report_type, review_state, version
    FROM assessment_document WHERE id = ?
  `).get(document.document_id), {
    report_type: 'unknown',
    review_state: 'pending',
    version: 1,
  });
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM assessment_event WHERE event_type = 'metadata_confirmed'").get().n, 0);

  const queued = pending(database, document.document_id, 'REQ-PENDING-UNKNOWN', document.version);
  assert.equal(queued.state, 'pending');
  expectCode(() => confirm(database, queued.binding_id, 'REQ-CONFIRM-UNKNOWN'), 'DOCUMENT_NOT_READY');

  const classified = ready(
    database,
    document.document_id,
    'REQ-READY-CLASSIFIED',
    'career_potential',
    queued.document_version,
  );
  assert.equal(classified.review_state, 'ready');
  assert.equal(confirm(database, queued.binding_id, 'REQ-CONFIRM-CLASSIFIED').state, 'active');
  database.close();
}

function checkMultipleReportsAndLifecycle() {
  const database = fixture();
  const first = intake(database, 'REQ-DOC-FIRST', { hashCharacter: '1' });
  const firstReady = ready(database, first.document_id, 'REQ-READY-FIRST');
  const firstPending = pending(database, first.document_id, 'REQ-PENDING-FIRST', firstReady.version);
  assert.equal(firstPending.state, 'pending');
  assert.equal(firstPending.event_id, null);
  assert.equal(pending(database, first.document_id, 'REQ-PENDING-FIRST', firstReady.version).idempotent_replay, true);
  expectCode(() => confirm(database, firstPending.binding_id, 'REQ-PENDING-FIRST'), 'IDEMPOTENCY_CONFLICT');
  const firstActive = confirm(database, firstPending.binding_id, 'REQ-CONFIRM-FIRST');
  assert.equal(firstActive.state, 'active');
  assert.equal(confirm(database, firstPending.binding_id, 'REQ-CONFIRM-FIRST').idempotent_replay, true);

  const second = intake(database, 'REQ-DOC-SECOND', { hashCharacter: '2' });
  const secondReady = ready(database, second.document_id, 'REQ-READY-SECOND');
  const secondPending = pending(database, second.document_id, 'REQ-PENDING-SECOND', secondReady.version);
  assert.equal(secondPending.conflict_state, 'none');
  assert.deepEqual(database.prepare(`
    SELECT state, conflict_state FROM assessment_binding WHERE id = ?
  `).get(secondPending.binding_id), { state: 'pending', conflict_state: 'none' });
  database.prepare("UPDATE assessment_binding SET conflict_state = 'active_report_type_conflict' WHERE id = ?")
    .run(secondPending.binding_id);
  applyAssessmentSchemaMigration(database);
  assert.equal(database.prepare('SELECT conflict_state FROM assessment_binding WHERE id = ?')
    .get(secondPending.binding_id).conflict_state, 'none', 'legacy type conflicts must be cleared');
  const archives = listAssessmentArchives(envelope(database, { candidate_id: 'C-SYNTH-1', job_id: 1 }));
  assert.equal(archives.length, 2);
  assert.ok(archives.some((row) => row.binding_state === 'active'));
  assert.ok(archives.every((row) => row.conflict_state === 'none'));
  assert.equal(JSON.stringify(archives).includes('storage_relpath'), false);
  assert.equal(JSON.stringify(archives).includes('content_sha256'), false);
  assert.deepEqual(listAssessmentQueue(envelope(database, { job_id: 1 })).map((row) => row.binding_id), [secondPending.binding_id]);
  assert.deepEqual(listAssessmentQueue(envelope(database, { job_id: 2 })), []);
  assert.deepEqual(listAssessmentArchives(envelope(database, { candidate_id: 'C-SYNTH-2', job_id: 2 })), []);
  expectCode(() => listAssessmentArchives(envelope(database, { candidate_id: 'C-SYNTH-1', job_id: 2 })),
    'CANDIDATE_JOB_MISMATCH');
  const secondActive = confirm(database, secondPending.binding_id, 'REQ-CONFIRM-SECOND');
  assert.equal(secondActive.state, 'active');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS n FROM assessment_binding
    WHERE candidate_id = 'C-SYNTH-1' AND job_id = 1 AND state = 'active'
  `).get().n, 2, 'one candidate may have multiple active reports of the same type');
  assert.deepEqual(listAssessmentQueue(envelope(database, { job_id: 1 })), []);

  const revoked = revokeAssessmentBinding(envelope(database, {
    binding_id: firstPending.binding_id, expected_version: firstActive.version,
    reason_code: 'archive_correction', request_id: 'REQ-REVOKE-FIRST',
  }));
  assert.equal(revoked.state, 'revoked');
  assert.equal(revokeAssessmentBinding(envelope(database, {
    binding_id: firstPending.binding_id, expected_version: firstActive.version,
    reason_code: 'archive_correction', request_id: 'REQ-REVOKE-FIRST',
  })).idempotent_replay, true);
  expectCode(() => revokeAssessmentBinding(envelope(database, {
    binding_id: firstPending.binding_id, expected_version: firstActive.version,
    reason_code: 'different_reason', request_id: 'REQ-REVOKE-FIRST',
  })), 'IDEMPOTENCY_CONFLICT');
  const opened = transition(database, openAssessmentDispute, second.document_id, secondPending.document_version, 'REQ-DISPUTE-OPEN');
  assert.equal(opened.lifecycle_state, 'frozen');
  assert.equal(transition(database, openAssessmentDispute, second.document_id, secondPending.document_version,
    'REQ-DISPUTE-OPEN').idempotent_replay, true);
  expectCode(() => prepareAssessmentView(envelope(database, {
    binding_id: secondPending.binding_id, document_id: second.document_id,
    candidate_id: 'C-SYNTH-1', job_id: 1, request_id: 'REQ-VIEW-FROZEN',
  })), 'DOCUMENT_FROZEN');
  const resolved = transition(database, resolveAssessmentDispute, second.document_id, opened.version, 'REQ-DISPUTE-RESOLVE');
  assert.equal(resolved.lifecycle_state, 'active');
  assert.equal(transition(database, resolveAssessmentDispute, second.document_id, opened.version,
    'REQ-DISPUTE-RESOLVE').idempotent_replay, true);
  database.close();
}

function checkRebindAtomicityAndSupersede() {
  const database = fixture();
  const source = intake(database, 'REQ-REBIND-DOC', { hashCharacter: '3' });
  const sourceReady = ready(database, source.document_id, 'REQ-REBIND-READY', 'team_role');
  const sourcePending = pending(database, source.document_id, 'REQ-REBIND-PENDING', sourceReady.version);
  const sourceActive = confirm(database, sourcePending.binding_id, 'REQ-REBIND-CONFIRM');
  expectCode(() => rebindAssessmentDocument(envelope(database, {
    binding_id: sourcePending.binding_id, candidate_id: 'C-SYNTH-1', job_id: 2,
    identity_basis: 'manual_cross_source', reason_code: 'wrong_archive_context',
    expected_version: sourceActive.version, request_id: 'REQ-REBIND-MISMATCH',
  })), 'CANDIDATE_JOB_MISMATCH');
  assert.equal(database.prepare('SELECT state FROM assessment_binding WHERE id = ?').get(sourcePending.binding_id).state, 'active');

  database.exec(`
    CREATE TRIGGER fail_rebind_event BEFORE INSERT ON assessment_event
    WHEN NEW.request_id = 'REQ-REBIND-ROLLBACK'
    BEGIN SELECT RAISE(ABORT, 'synthetic rebind event failure'); END;
  `);
  assert.throws(() => rebindAssessmentDocument(envelope(database, {
    binding_id: sourcePending.binding_id, candidate_id: 'C-SYNTH-2', job_id: 2,
    identity_basis: 'manual_cross_source', reason_code: 'wrong_archive_context',
    expected_version: sourceActive.version, request_id: 'REQ-REBIND-ROLLBACK',
  })), /synthetic rebind event failure/);
  assert.equal(database.prepare('SELECT state FROM assessment_binding WHERE id = ?').get(sourcePending.binding_id).state, 'active');
  database.exec('DROP TRIGGER fail_rebind_event');
  const rebound = rebindAssessmentDocument(envelope(database, {
    binding_id: sourcePending.binding_id, candidate_id: 'C-SYNTH-2', job_id: 2,
    identity_basis: 'manual_cross_source', reason_code: 'wrong_archive_context',
    expected_version: sourceActive.version, request_id: 'REQ-REBIND-SUCCESS',
  }));
  assert.equal(rebound.state, 'active');
  assert.equal(rebindAssessmentDocument(envelope(database, {
    binding_id: sourcePending.binding_id, candidate_id: 'C-SYNTH-2', job_id: 2,
    identity_basis: 'manual_cross_source', reason_code: 'wrong_archive_context',
    expected_version: sourceActive.version, request_id: 'REQ-REBIND-SUCCESS',
  })).idempotent_replay, true);

  const replacement = intake(database, 'REQ-SUPERSEDE-DOC', { hashCharacter: '4' });
  const replacementReady = ready(database, replacement.document_id, 'REQ-SUPERSEDE-READY', 'team_role');
  const superseded = supersedeAssessmentDocument(envelope(database, {
    document_id: source.document_id, replacement_document_id: replacement.document_id,
    expected_version: sourcePending.document_version, replacement_expected_version: replacementReady.version,
    reason_code: 'verified_new_report_version', request_id: 'REQ-SUPERSEDE',
  }));
  assert.equal(superseded.replacement_document_id, replacement.document_id);
  assert.equal(supersedeAssessmentDocument(envelope(database, {
    document_id: source.document_id, replacement_document_id: replacement.document_id,
    expected_version: sourcePending.document_version, replacement_expected_version: replacementReady.version,
    reason_code: 'verified_new_report_version', request_id: 'REQ-SUPERSEDE',
  })).idempotent_replay, true);
  assert.deepEqual(database.prepare('SELECT review_state FROM assessment_document WHERE id = ?').get(source.document_id), {
    review_state: 'superseded',
  });
  database.close();
}

function checkHoldDeletionTombstoneAndExportGate() {
  const database = fixture();
  const noPolicy = intake(database, 'REQ-NO-POLICY', { hashCharacter: '5' });
  expectCode(() => prepareAssessmentExport(envelope(database, { document_id: noPolicy.document_id })), 'RETENTION_POLICY_NOT_CONFIGURED');
  expectCode(() => transition(database, requestAssessmentDeletion, noPolicy.document_id, 1,
    'REQ-NO-POLICY-DELETE'), 'RETENTION_POLICY_NOT_CONFIGURED');
  expectCode(() => transition(database, tombstoneAssessmentDocumentByPolicy, noPolicy.document_id, 1,
    'REQ-NO-POLICY-TOMBSTONE', {
      policy_version: null, physical_delete_confirmed: true, effective_at: '2026-07-13T00:00:00.000Z',
    }), 'RETENTION_POLICY_NOT_CONFIGURED');

  const managed = intake(database, 'REQ-MANAGED', {
    hashCharacter: '6', policyVersion: 'assessment-retention-v1', deleteAfter: '2026-07-12T00:00:00.000Z',
  });
  const hold = transition(database, applyAssessmentLegalHold, managed.document_id, 1, 'REQ-HOLD-APPLY');
  assert.equal(transition(database, applyAssessmentLegalHold, managed.document_id, 1,
    'REQ-HOLD-APPLY').idempotent_replay, true);
  expectCode(() => transition(database, requestAssessmentDeletion, managed.document_id, hold.version,
    'REQ-MANAGED-DELETE-HOLD', {
      policy_version: 'assessment-retention-v1', effective_at: '2026-07-13T00:00:00.000Z',
    }), 'LEGAL_HOLD_ACTIVE');
  const released = transition(database, releaseAssessmentLegalHold, managed.document_id, hold.version, 'REQ-HOLD-RELEASE');
  assert.equal(transition(database, releaseAssessmentLegalHold, managed.document_id, hold.version,
    'REQ-HOLD-RELEASE').idempotent_replay, true);
  const deleteRequest = transition(database, requestAssessmentDeletion, managed.document_id, released.version,
    'REQ-MANAGED-DELETE', {
      policy_version: 'assessment-retention-v1', effective_at: '2026-07-13T00:00:00.000Z',
    });
  assert.equal(transition(database, requestAssessmentDeletion, managed.document_id, released.version,
    'REQ-MANAGED-DELETE', {
      policy_version: 'assessment-retention-v1', effective_at: '2026-07-13T00:00:00.000Z',
    }).idempotent_replay, true);
  expectCode(() => transition(database, tombstoneAssessmentDocumentByPolicy, managed.document_id, deleteRequest.version,
    'REQ-TOMBSTONE-BLOCKED', {
      policy_version: 'assessment-retention-v1', physical_delete_confirmed: true,
      effective_at: '2026-07-13T00:00:00.000Z',
    }), 'PHYSICAL_DELETE_COORDINATOR_REQUIRED');
  seedSyntheticPhysicalDeleteEvidence(database, managed.document_id, deleteRequest.version, 'REQ-TOMBSTONE');
  const tombstone = transition(database, tombstoneAssessmentDocumentByPolicy, managed.document_id, deleteRequest.version,
    'REQ-TOMBSTONE', {
      policy_version: 'assessment-retention-v1', physical_delete_confirmed: true,
      effective_at: '2026-07-13T00:00:00.000Z',
    });
  assert.equal(tombstone.tombstone, true);
  assert.equal(transition(database, tombstoneAssessmentDocumentByPolicy, managed.document_id, deleteRequest.version,
    'REQ-TOMBSTONE', {
      policy_version: 'assessment-retention-v1', physical_delete_confirmed: true,
      effective_at: '2026-07-13T00:00:00.000Z',
    }).idempotent_replay, true);
  assert.deepEqual(database.prepare(`
    SELECT content_sha256, storage_relpath, byte_size, page_count, mime_detected,
           assessment_date, lifecycle_state, deleted_at
    FROM assessment_document WHERE id = ?
  `).get(managed.document_id), {
    content_sha256: null, storage_relpath: null, byte_size: null, page_count: null,
    mime_detected: null, assessment_date: null, lifecycle_state: 'deleted',
    deleted_at: '2026-07-13T00:00:00.000Z',
  });
  database.close();
}

function checkEventMinimization() {
  const database = fixture();
  const columns = database.prepare("PRAGMA table_info('assessment_event')").all().map((row) => row.name);
  for (const forbidden of ['body', 'name', 'filename', 'role', 'motive', 'pressure', 'percentage']) {
    assert.equal(columns.some((column) => column.toLowerCase().includes(forbidden)), false);
  }
  assert.throws(() => database.prepare(`
    INSERT INTO assessment_event (
      id, object_type, object_id, event_type, actor_id, actor_type, actor_source,
      actor_session_id, actor_assurance, request_id, reason_code, created_at
    ) VALUES (
      'EVENT-LEAK', 'document', 'DOC-1', 'uploaded', 'local-primary-operator',
      'local_os_subject', 'server_local_instance', 'synthetic', 'local_instance_only',
      'REQ-LEAK', 'SYNTHETIC PERSON NAME', '2026-07-12T00:00:00.000Z'
    )
  `).run(), /(CHECK constraint failed|assessment event reason code is invalid)/);
  database.prepare(`
    INSERT INTO assessment_event (
      id, object_type, object_id, event_type, actor_id, actor_type, actor_source,
      actor_session_id, actor_assurance, request_id, reason_code, created_at
    ) VALUES (
      'EVENT-APPEND-ONLY', 'document', 'DOC-SYNTHETIC', 'uploaded', 'local-primary-operator',
      'local_os_subject', 'server_local_instance', 'synthetic', 'local_instance_only',
      'REQ-APPEND-ONLY', 'synthetic_test', '2026-07-12T00:00:00.000Z'
    )
  `).run();
  assert.throws(() => database.prepare('UPDATE assessment_event SET created_at = ? WHERE id = ?')
    .run('2026-07-13T00:00:00.000Z', 'EVENT-APPEND-ONLY'), /assessment event is append-only/);
  assert.throws(() => database.prepare('DELETE FROM assessment_event WHERE id = ?')
    .run('EVENT-APPEND-ONLY'), /assessment event is append-only/);
  database.close();
}

checkFoundationUpgrade();
checkIntakeDuplicateAndSecurityGates();
checkUnknownRequiresClassification();
checkMultipleReportsAndLifecycle();
checkRebindAtomicityAndSupersede();
checkHoldDeletionTombstoneAndExportGate();
checkEventMinimization();

console.log(JSON.stringify({
  ok: true,
  task: 'F017-B-assessment-lifecycle',
  synthetic_only: true,
  real_database_read: false,
}));
