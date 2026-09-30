'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const {
  applyAssessmentLegalHold,
  releaseAssessmentLegalHold,
  tombstoneAssessmentDocumentByPolicy,
} = require('./assessment-archive-service');
const {
  executeAssessmentPhysicalDeletion,
  requestAssessmentPhysicalDeletion,
} = require('./assessment-physical-delete');
const { applyAssessmentSchemaMigration } = require('./assessment-schema');

const ACTOR = Object.freeze({
  actor_id: 'local-primary-operator',
  actor_type: 'local_os_subject',
  actor_source: 'server_local_instance',
  actor_session_id: 'synthetic-physical-delete',
  assurance: 'local_instance_only',
});
const NOW = '2026-07-13T01:00:00.000Z';
const POLICY = 'assessment-retention-v1';
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('synthetic-preview', 'ascii'),
]);

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-assessment-physical-delete-'));
  fs.chmodSync(root, 0o700);
  const dataRoot = privateDirectory(path.join(root, 'data'));
  privateDirectory(path.join(dataRoot, 'assessment'));
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE job (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE candidate (internal_id TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id));
    INSERT INTO job VALUES (1, '合成岗位');
    INSERT INTO candidate VALUES ('C-SYNTHETIC-DELETE', 1);
  `);
  applyAssessmentSchemaMigration(database);
  return { root, dataRoot, database };
}

function insertDocument(database, dataRoot, id, options = {}) {
  const bytes = Buffer.from(`%PDF-1.4\nsynthetic-${id}\n%%EOF\n`, 'ascii');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const relpath = options.storageRelpath || `accepted/sha256/${hash.slice(0, 2)}/${hash}.pdf`;
  const policyVersion = options.policyVersion === undefined ? POLICY : options.policyVersion;
  database.prepare(`
    INSERT INTO assessment_document (
      id, content_sha256, storage_relpath, byte_size, page_count, mime_detected,
      security_state, report_type, assessment_date, review_state, dispute_state,
      lifecycle_state, retention_policy_version, delete_after, legal_hold_state,
      created_by, version, created_at, updated_at, deleted_at
    ) VALUES (
      @id, @hash, @relpath, @byte_size, @page_count, 'application/pdf',
      'accepted', 'career_potential', '2026-07-01', 'ready', @dispute_state,
      @lifecycle_state, @policy_version, @delete_after, @legal_hold_state,
      'local-primary-operator', @version, @now, @now, NULL
    )
  `).run({
    id,
    hash,
    relpath,
    byte_size: bytes.length,
    page_count: options.pageCount || 2,
    lifecycle_state: options.lifecycleState || 'active',
    dispute_state: options.disputeState || 'none',
    policy_version: policyVersion,
    delete_after: policyVersion ? (options.deleteAfter || '2026-07-12T00:00:00.000Z') : null,
    legal_hold_state: options.legalHoldState || 'none',
    version: options.version || 3,
    now: NOW,
  });
  const blob = path.join(dataRoot, 'assessment', 'accepted', 'sha256', hash.slice(0, 2), `${hash}.pdf`);
  privateDirectory(path.dirname(blob));
  fs.writeFileSync(blob, bytes, { mode: 0o600 });
  const previewDirectory = privateDirectory(path.join(
    dataRoot, 'assessment', 'previews', 'sha256', hash.slice(0, 2), hash,
  ));
  const previews = [];
  for (let page = 1; page <= (options.pageCount || 2); page += 1) {
    const preview = path.join(previewDirectory, `page-${page}.png`);
    fs.writeFileSync(preview, PNG, { mode: 0o600 });
    previews.push(preview);
  }
  return { id, bytes, hash, blob, previewDirectory, previews, version: options.version || 3 };
}

function command(document, requestId, overrides = {}) {
  return {
    document_id: document.id,
    expected_version: document.version,
    request_id: requestId,
    reason_code: 'retention_due',
    policy_version: POLICY,
    effective_at: NOW,
    physical_delete_confirmed: true,
    ...overrides,
  };
}

function envelope(context, document, requestId, overrides = {}) {
  return {
    database: context.database,
    dataRoot: context.dataRoot,
    auditContext: ACTOR,
    command: command(document, requestId, overrides),
    now: () => NOW,
  };
}

function requestEnvelope(context, document, requestId, overrides = {}) {
  const { physical_delete_confirmed: _confirmed, ...requestCommand } = command(document, requestId, overrides);
  return {
    database: context.database,
    auditContext: ACTOR,
    command: requestCommand,
    now: () => NOW,
  };
}

function requestThenConfirm(context, document, requestId) {
  const requested = requestAssessmentPhysicalDeletion(requestEnvelope(context, document, requestId));
  return {
    requested,
    confirm: envelope(context, document, requestId, { expected_version: requested.version }),
  };
}

function expectCode(work, code) {
  let error;
  try { work(); } catch (caught) { error = caught; }
  assert.ok(error, `expected ${code}`);
  assert.equal(error.code, code, error.stack);
  assert.equal(String(error.message).includes(os.tmpdir()), false, 'error must not expose a filesystem path');
  return error;
}

function deletionRequest(database, requestId) {
  return database.prepare(`
    SELECT state, last_error_code, attempt_count, physical_deleted_at, completed_at
    FROM assessment_deletion_request WHERE request_id = ?
  `).get(requestId);
}

function closeFixture(context) {
  context.database.close();
  fs.rmSync(context.root, { recursive: true, force: true });
}

function checkSuccessReplayAndNoBypass() {
  const context = fixture();
  try {
    const document = insertDocument(context.database, context.dataRoot, 'DOC-SUCCESS');
    const requestId = 'REQ-PHYSICAL-SUCCESS';
    expectCode(() => tombstoneAssessmentDocumentByPolicy({
      database: context.database,
      auditContext: ACTOR,
      command: command(document, requestId),
    }), 'PHYSICAL_DELETE_COORDINATOR_REQUIRED');
    assert.equal(fs.existsSync(document.blob), true);

    const flow = requestThenConfirm(context, document, requestId);
    assert.equal(flow.requested.lifecycle_state, 'deletion_pending');
    assert.equal(flow.requested.deletion_request_state, 'pending');
    const result = executeAssessmentPhysicalDeletion(flow.confirm);
    assert.equal(result.lifecycle_state, 'deleted');
    assert.equal(result.artifact_delete_state, 'physically_deleted');
    assert.equal(result.deletion_request_state, 'completed');
    assert.equal(result.idempotent_replay, false);
    assert.equal(fs.existsSync(document.blob), false);
    assert.equal(fs.existsSync(document.previewDirectory), false);
    assert.deepEqual(deletionRequest(context.database, requestId), {
      state: 'completed', last_error_code: null, attempt_count: 1,
      physical_deleted_at: NOW, completed_at: NOW,
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [context.dataRoot, document.hash, 'storage_relpath', 'content_sha256']) {
      assert.equal(serialized.includes(forbidden), false, `result leaks ${forbidden}`);
    }

    const replay = executeAssessmentPhysicalDeletion({
      ...flow.confirm,
      dataRoot: path.join(context.root, 'missing-after-completion'),
    });
    assert.equal(replay.idempotent_replay, true);
    assert.equal(replay.deletion_request_state, 'completed');
    assert.equal(deletionRequest(context.database, requestId).attempt_count, 1);
    const completedRequestReplay = requestAssessmentPhysicalDeletion(requestEnvelope(
      context, document, requestId,
    ));
    assert.equal(completedRequestReplay.deletion_request_state, 'completed');
    assert.equal(completedRequestReplay.version, flow.requested.version,
      'completed request replay must preserve the fixed pending version');
    expectCode(() => executeAssessmentPhysicalDeletion({ ...flow.confirm, command: {
      ...flow.confirm.command,
      reason_code: 'different_reason',
    } }), 'IDEMPOTENCY_CONFLICT');

    const event = context.database.prepare(`
      SELECT id FROM assessment_event
      WHERE object_id = ? AND event_type = 'deleted_by_policy'
    `).get(document.id);
    assert.ok(event);
    assert.throws(() => context.database.prepare('UPDATE assessment_event SET created_at = ? WHERE id = ?')
      .run('2026-07-14T00:00:00.000Z', event.id), /assessment event is append-only/);
    assert.throws(() => context.database.prepare('DELETE FROM assessment_event WHERE id = ?')
      .run(event.id), /assessment event is append-only/);
    assert.throws(() => context.database.prepare(`
      UPDATE assessment_deletion_request SET document_id = 'FORGED' WHERE request_id = ?
    `).run(requestId), /assessment deletion request identity is immutable/);
    assert.throws(() => context.database.prepare('DELETE FROM assessment_deletion_request WHERE request_id = ?')
      .run(requestId), /assessment deletion request cannot be deleted/);
  } finally {
    closeFixture(context);
  }
}

function checkPartialFailureAndSafeRetry() {
  const context = fixture();
  try {
    const document = insertDocument(context.database, context.dataRoot, 'DOC-PARTIAL');
    const requestId = 'REQ-PHYSICAL-PARTIAL';
    const flow = requestThenConfirm(context, document, requestId);
    let failed = false;
    const fileSystem = {
      ...fs,
      unlinkSync(target) {
        if (!failed && path.basename(target) === 'page-2.png') {
          failed = true;
          const error = new Error('synthetic deletion failure');
          error.code = 'EACCES';
          throw error;
        }
        return fs.unlinkSync(target);
      },
    };
    const error = expectCode(() => executeAssessmentPhysicalDeletion({
      ...flow.confirm, fileSystem,
    }), 'PHYSICAL_DELETE_INCOMPLETE');
    assert.equal(error.message.includes(document.previewDirectory), false);
    assert.equal(fs.existsSync(document.previews[0]), false);
    assert.equal(fs.existsSync(document.previews[1]), true);
    assert.equal(fs.existsSync(document.blob), true);
    assert.equal(context.database.prepare('SELECT lifecycle_state FROM assessment_document WHERE id = ?')
      .get(document.id).lifecycle_state, 'deletion_pending');
    assert.deepEqual(deletionRequest(context.database, requestId), {
      state: 'retryable_failed', last_error_code: 'PHYSICAL_DELETE_INCOMPLETE', attempt_count: 1,
      physical_deleted_at: null, completed_at: null,
    });
    assert.equal(context.database.prepare(`
      SELECT COUNT(*) AS n FROM assessment_event
      WHERE request_id = ? AND event_type = 'deleted_by_policy'
    `).get(requestId).n, 0, 'partial failure must not write deletion completion');
    const failureEvent = context.database.prepare(`
      SELECT event_type, reason_code, policy_version
      FROM assessment_event
      WHERE object_id = ? AND reason_code = 'PHYSICAL_DELETE_INCOMPLETE'
    `).get(document.id);
    assert.deepEqual(failureEvent, {
      event_type: 'delete_requested', reason_code: 'PHYSICAL_DELETE_INCOMPLETE', policy_version: POLICY,
    });
    assert.equal(JSON.stringify(failureEvent).includes(document.hash), false);
    expectCode(() => requestAssessmentPhysicalDeletion(requestEnvelope(
      context,
      { ...document, version: flow.requested.version },
      'REQ-PHYSICAL-PARTIAL-CONCURRENT',
    )), 'DELETION_REQUEST_IN_PROGRESS');

    const retried = executeAssessmentPhysicalDeletion(flow.confirm);
    assert.equal(retried.lifecycle_state, 'deleted');
    assert.equal(deletionRequest(context.database, requestId).attempt_count, 2);
    assert.equal(fs.existsSync(document.blob), false);
    assert.equal(fs.existsSync(document.previewDirectory), false);
  } finally {
    closeFixture(context);
  }
}

function checkFinalizeFailureAndMissingArtifactRetry() {
  const context = fixture();
  try {
    const document = insertDocument(context.database, context.dataRoot, 'DOC-FINALIZE-FAIL');
    const requestId = 'REQ-PHYSICAL-FINALIZE-FAIL';
    const flow = requestThenConfirm(context, document, requestId);
    context.database.exec(`
      CREATE TRIGGER synthetic_finalize_failure
      BEFORE INSERT ON assessment_event
      WHEN NEW.object_id = '${document.id}' AND NEW.event_type = 'deleted_by_policy'
      BEGIN SELECT RAISE(ABORT, 'synthetic finalize failure'); END;
    `);
    const finalizeError = expectCode(
      () => executeAssessmentPhysicalDeletion(flow.confirm),
      'PHYSICAL_DELETE_FAILED',
    );
    assert.equal(finalizeError instanceof Error, true);
    assert.equal(finalizeError.name, 'AssessmentPhysicalDeleteError');
    assert.equal(finalizeError.message, 'Assessment deletion operation failed.');
    assert.equal(finalizeError.message.includes('synthetic finalize failure'), false);
    assert.equal(finalizeError.message.includes(document.hash), false);
    assert.equal(fs.existsSync(document.blob), false);
    assert.equal(fs.existsSync(document.previewDirectory), false);
    assert.equal(context.database.prepare('SELECT lifecycle_state FROM assessment_document WHERE id = ?')
      .get(document.id).lifecycle_state, 'deletion_pending');
    assert.equal(deletionRequest(context.database, requestId).state, 'retryable_failed');
    assert.equal(deletionRequest(context.database, requestId).last_error_code, 'PHYSICAL_DELETE_FAILED');
    context.database.exec('DROP TRIGGER synthetic_finalize_failure');
    assert.equal(executeAssessmentPhysicalDeletion(flow.confirm).lifecycle_state, 'deleted');
  } finally {
    closeFixture(context);
  }
}

function checkPathAndPolicyGates() {
  const context = fixture();
  try {
    const symlinked = insertDocument(context.database, context.dataRoot, 'DOC-SYMLINK');
    const outside = path.join(context.root, 'outside.png');
    fs.writeFileSync(outside, PNG, { mode: 0o600 });
    fs.rmSync(symlinked.previews[0]);
    fs.symlinkSync(outside, symlinked.previews[0]);
    const symlinkFlow = requestThenConfirm(context, symlinked, 'REQ-PHYSICAL-SYMLINK');
    expectCode(() => executeAssessmentPhysicalDeletion(symlinkFlow.confirm), 'ASSESSMENT_STORE_PATH_UNSAFE');
    assert.equal(fs.existsSync(outside), true, 'unsafe symlink target must never be deleted');
    assert.equal(fs.existsSync(symlinked.blob), true);
    assert.deepEqual(deletionRequest(context.database, 'REQ-PHYSICAL-SYMLINK'), {
      state: 'retryable_failed', last_error_code: 'ASSESSMENT_STORE_PATH_UNSAFE', attempt_count: 1,
      physical_deleted_at: null, completed_at: null,
    });

    const hold = insertDocument(context.database, context.dataRoot, 'DOC-HOLD', { legalHoldState: 'active' });
    expectCode(() => requestAssessmentPhysicalDeletion(requestEnvelope(
      context, hold, 'REQ-PHYSICAL-HOLD',
    )), 'LEGAL_HOLD_ACTIVE');
    assert.equal(deletionRequest(context.database, 'REQ-PHYSICAL-HOLD'), undefined);
    assert.equal(fs.existsSync(hold.blob), true);

    const frozen = insertDocument(context.database, context.dataRoot, 'DOC-FROZEN', { lifecycleState: 'frozen' });
    expectCode(() => requestAssessmentPhysicalDeletion(requestEnvelope(
      context, frozen, 'REQ-PHYSICAL-FROZEN',
    )), 'DOCUMENT_FROZEN');
    assert.equal(deletionRequest(context.database, 'REQ-PHYSICAL-FROZEN'), undefined);
    assert.equal(fs.existsSync(frozen.blob), true);

    const wrongPolicy = insertDocument(context.database, context.dataRoot, 'DOC-POLICY');
    expectCode(() => requestAssessmentPhysicalDeletion(requestEnvelope(context, wrongPolicy, 'REQ-PHYSICAL-POLICY', {
      policy_version: 'unapproved-policy',
    })), 'RETENTION_POLICY_MISMATCH');
    assert.equal(deletionRequest(context.database, 'REQ-PHYSICAL-POLICY'), undefined);
    assert.equal(fs.existsSync(wrongPolicy.blob), true);

    const noPolicy = insertDocument(context.database, context.dataRoot, 'DOC-NO-POLICY', { policyVersion: null });
    expectCode(() => requestAssessmentPhysicalDeletion(requestEnvelope(
      context, noPolicy, 'REQ-PHYSICAL-NO-POLICY',
    )), 'RETENTION_POLICY_NOT_CONFIGURED');
    assert.equal(fs.existsSync(noPolicy.blob), true);

    const notDue = insertDocument(context.database, context.dataRoot, 'DOC-NOT-DUE', {
      deleteAfter: '2026-07-14T00:00:00.000Z',
    });
    expectCode(() => requestAssessmentPhysicalDeletion(requestEnvelope(
      context, notDue, 'REQ-PHYSICAL-NOT-DUE',
    )), 'RETENTION_NOT_DUE');
    assert.equal(fs.existsSync(notDue.blob), true);

    const futureEffective = insertDocument(context.database, context.dataRoot, 'DOC-FUTURE-EFFECTIVE');
    expectCode(() => requestAssessmentPhysicalDeletion(requestEnvelope(
      context, futureEffective, 'REQ-PHYSICAL-FUTURE-EFFECTIVE', { effective_at: '2099-01-01T00:00:00.000Z' },
    )), 'EFFECTIVE_AT_FUTURE');
    assert.equal(fs.existsSync(futureEffective.blob), true);

    const disputed = insertDocument(context.database, context.dataRoot, 'DOC-DISPUTE', {
      lifecycleState: 'frozen', disputeState: 'open',
    });
    expectCode(() => requestAssessmentPhysicalDeletion(requestEnvelope(
      context, disputed, 'REQ-PHYSICAL-DISPUTE',
    )), 'DISPUTE_OPEN');
    assert.equal(fs.existsSync(disputed.blob), true);

    const bound = insertDocument(context.database, context.dataRoot, 'DOC-ACTIVE-BINDING');
    context.database.prepare(`
      INSERT INTO assessment_binding (
        id, document_id, candidate_id, job_id, scope, state, conflict_state, identity_basis,
        actor_id, reason_code, request_id, version, created_at, updated_at, revoked_at
      ) VALUES (
        'BIND-ACTIVE-DELETE', ?, 'C-SYNTHETIC-DELETE', 1, 'candidate_job_archive',
        'active', 'none', 'current_candidate_context', 'local-primary-operator',
        'synthetic_test', 'REQ-BIND-ACTIVE-DELETE', 1, ?, ?, NULL
      )
    `).run(bound.id, NOW, NOW);
    expectCode(() => requestAssessmentPhysicalDeletion(requestEnvelope(
      context, bound, 'REQ-PHYSICAL-ACTIVE-BINDING',
    )), 'ACTIVE_BINDING_EXISTS');
    assert.equal(fs.existsSync(bound.blob), true);
  } finally {
    closeFixture(context);
  }
}

function checkConfirmRechecksGatesBeforeFileIo() {
  const context = fixture();
  try {
    const cases = [
      ['HOLD', "UPDATE assessment_document SET legal_hold_state = 'active' WHERE id = ?", 'LEGAL_HOLD_ACTIVE'],
      ['FROZEN', "UPDATE assessment_document SET lifecycle_state = 'frozen' WHERE id = ?", 'DOCUMENT_FROZEN'],
      ['DISPUTE', "UPDATE assessment_document SET lifecycle_state = 'frozen', dispute_state = 'open' WHERE id = ?", 'DISPUTE_OPEN'],
      ['POLICY', "UPDATE assessment_document SET retention_policy_version = 'changed-policy' WHERE id = ?", 'RETENTION_POLICY_MISMATCH'],
      ['NOT-DUE', "UPDATE assessment_document SET delete_after = '2026-07-14T00:00:00.000Z' WHERE id = ?", 'RETENTION_NOT_DUE'],
    ];
    for (const [suffix, mutation, code] of cases) {
      const document = insertDocument(context.database, context.dataRoot, `DOC-CONFIRM-${suffix}`);
      const requestId = `REQ-CONFIRM-${suffix}`;
      const flow = requestThenConfirm(context, document, requestId);
      context.database.prepare(mutation).run(document.id);
      expectCode(() => executeAssessmentPhysicalDeletion(flow.confirm), code);
      assert.equal(fs.existsSync(document.blob), true, `${suffix} must fail before PDF deletion`);
      assert.equal(fs.existsSync(document.previewDirectory), true, `${suffix} must fail before preview deletion`);
      assert.equal(deletionRequest(context.database, requestId).state, 'retryable_failed');
    }

    const bound = insertDocument(context.database, context.dataRoot, 'DOC-CONFIRM-BINDING');
    const boundFlow = requestThenConfirm(context, bound, 'REQ-CONFIRM-BINDING');
    context.database.prepare(`
      INSERT INTO assessment_binding (
        id, document_id, candidate_id, job_id, scope, state, conflict_state, identity_basis,
        actor_id, reason_code, request_id, version, created_at, updated_at, revoked_at
      ) VALUES (
        'BIND-CONFIRM-DELETE', ?, 'C-SYNTHETIC-DELETE', 1, 'candidate_job_archive',
        'active', 'none', 'current_candidate_context', 'local-primary-operator',
        'synthetic_test', 'REQ-BIND-CONFIRM-DELETE', 1, ?, ?, NULL
      )
    `).run(bound.id, NOW, NOW);
    expectCode(() => executeAssessmentPhysicalDeletion(boundFlow.confirm), 'ACTIVE_BINDING_EXISTS');
    assert.equal(fs.existsSync(bound.blob), true);
  } finally {
    closeFixture(context);
  }
}

function checkAuditedHoldVersionDriftRecovery() {
  const context = fixture();
  try {
    const document = insertDocument(context.database, context.dataRoot, 'DOC-HOLD-DRIFT');
    const requestId = 'REQ-HOLD-DRIFT';
    const flow = requestThenConfirm(context, document, requestId);
    const applied = applyAssessmentLegalHold({
      database: context.database,
      auditContext: ACTOR,
      command: {
        document_id: document.id,
        expected_version: flow.requested.version,
        request_id: 'REQ-HOLD-DRIFT-APPLY',
        reason_code: 'legal_hold_review',
      },
    });
    assert.equal(applied.version, flow.requested.version + 1);
    expectCode(() => executeAssessmentPhysicalDeletion(flow.confirm), 'LEGAL_HOLD_ACTIVE');
    assert.equal(fs.existsSync(document.blob), true);
    const released = releaseAssessmentLegalHold({
      database: context.database,
      auditContext: ACTOR,
      command: {
        document_id: document.id,
        expected_version: applied.version,
        request_id: 'REQ-HOLD-DRIFT-RELEASE',
        reason_code: 'legal_hold_released',
      },
    });
    assert.equal(released.version, applied.version + 1);
    const requestReplay = requestAssessmentPhysicalDeletion(requestEnvelope(context, document, requestId));
    assert.equal(requestReplay.idempotent_replay, true);
    assert.equal(requestReplay.version, flow.requested.version,
      'request replay must preserve the pending version after audited hold drift');
    const completed = executeAssessmentPhysicalDeletion(envelope(context, document, requestId, {
      expected_version: requestReplay.version,
    }));
    assert.equal(completed.lifecycle_state, 'deleted');
    assert.equal(completed.version, released.version + 1);
    assert.equal(deletionRequest(context.database, requestId).state, 'completed');

    const staleDocument = insertDocument(context.database, context.dataRoot, 'DOC-UNPROVEN-DRIFT');
    const staleFlow = requestThenConfirm(context, staleDocument, 'REQ-UNPROVEN-DRIFT');
    context.database.prepare('UPDATE assessment_document SET version = version + 1 WHERE id = ?')
      .run(staleDocument.id);
    expectCode(() => executeAssessmentPhysicalDeletion(staleFlow.confirm), 'STALE_VERSION');
    assert.equal(fs.existsSync(staleDocument.blob), true, 'unproven version drift must fail before file I/O');
  } finally {
    closeFixture(context);
  }
}

function checkRequestFailureRedactionAndRollback() {
  const context = fixture();
  try {
    const document = insertDocument(context.database, context.dataRoot, 'DOC-REQUEST-RAW-FAIL');
    context.database.exec(`
      CREATE TRIGGER synthetic_request_raw_failure
      BEFORE INSERT ON assessment_event
      WHEN NEW.object_id = '${document.id}' AND NEW.event_type = 'delete_requested'
      BEGIN SELECT RAISE(ABORT, 'raw path /private/synthetic/request.pdf'); END;
    `);
    const error = expectCode(
      () => requestAssessmentPhysicalDeletion(requestEnvelope(
        context, document, 'REQ-REQUEST-RAW-FAIL',
      )),
      'PHYSICAL_DELETE_FAILED',
    );
    assert.equal(error.name, 'AssessmentPhysicalDeleteError');
    assert.equal(error.message, 'Assessment deletion operation failed.');
    assert.equal(error.message.includes('/private/synthetic/request.pdf'), false);
    assert.equal(deletionRequest(context.database, 'REQ-REQUEST-RAW-FAIL'), undefined);
    assert.deepEqual(context.database.prepare(`
      SELECT lifecycle_state, version FROM assessment_document WHERE id = ?
    `).get(document.id), { lifecycle_state: 'active', version: document.version });
    assert.equal(fs.existsSync(document.blob), true);
  } finally {
    closeFixture(context);
  }
}

checkSuccessReplayAndNoBypass();
checkPartialFailureAndSafeRetry();
checkFinalizeFailureAndMissingArtifactRetry();
checkPathAndPolicyGates();
checkConfirmRechecksGatesBeforeFileIo();
checkAuditedHoldVersionDriftRecovery();
checkRequestFailureRedactionAndRollback();

console.log(JSON.stringify({
  ok: true,
  task: 'F019-GATE-001-A-physical-delete-core',
  synthetic_only: true,
  real_candidate_files_read: false,
}));
