'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  requestAssessmentDeletion,
  tombstoneAssessmentDocumentByPolicy,
} = require('./assessment-archive-service');

const ACTOR_CONTRACT = Object.freeze({
  actor_id: 'local-primary-operator',
  actor_type: 'local_os_subject',
  actor_source: 'server_local_instance',
  assurance: 'local_instance_only',
});

class AssessmentPhysicalDeleteError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AssessmentPhysicalDeleteError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AssessmentPhysicalDeleteError(code, message);
}

function requiredText(value, code, maximum = 160) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized || normalized.length > maximum) fail(code, 'Assessment physical deletion request is invalid.');
  return normalized;
}

function normalizeBaseCommand(raw, confirm) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('COMMAND_REQUIRED', 'Assessment physical deletion request is required.');
  }
  const allowed = new Set([
    'document_id', 'expected_version', 'request_id', 'reason_code', 'policy_version',
    'effective_at', ...(confirm ? ['physical_delete_confirmed'] : []),
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    fail('COMMAND_FIELD_FORBIDDEN', 'Assessment physical deletion request contains an unsupported field.');
  }
  const expectedVersion = Number(raw.expected_version);
  if (!Number.isInteger(expectedVersion) || expectedVersion <= 0) {
    fail('EXPECTED_VERSION_REQUIRED', 'Assessment document version is required.');
  }
  const requestId = requiredText(raw.request_id, 'REQUEST_ID_REQUIRED', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) {
    fail('REQUEST_ID_INVALID', 'Assessment physical deletion request identifier is invalid.');
  }
  const reasonCode = requiredText(raw.reason_code, 'REASON_CODE_REQUIRED', 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(reasonCode)) {
    fail('REASON_CODE_INVALID', 'Assessment physical deletion reason code is invalid.');
  }
  const policyVersion = requiredText(raw.policy_version, 'RETENTION_POLICY_NOT_CONFIGURED', 80);
  const effectiveAt = requiredText(raw.effective_at, 'EFFECTIVE_AT_REQUIRED', 40);
  if (!Number.isFinite(Date.parse(effectiveAt))) {
    fail('EFFECTIVE_AT_INVALID', 'Assessment physical deletion time is invalid.');
  }
  if (confirm && raw.physical_delete_confirmed !== true) {
    fail('PHYSICAL_DELETE_CONFIRMATION_REQUIRED', 'Assessment physical deletion confirmation is required.');
  }
  return Object.freeze({
    documentId: requiredText(raw.document_id, 'DOCUMENT_ID_REQUIRED'),
    expectedVersion,
    requestId,
    reasonCode,
    policyVersion,
    effectiveAt,
    raw: Object.freeze({
      document_id: requiredText(raw.document_id, 'DOCUMENT_ID_REQUIRED'),
      expected_version: expectedVersion,
      request_id: requestId,
      reason_code: reasonCode,
      policy_version: policyVersion,
      effective_at: effectiveAt,
      ...(confirm ? { physical_delete_confirmed: true } : {}),
    }),
  });
}

function normalizeRequestCommand(raw) {
  return normalizeBaseCommand(raw, false);
}

function normalizeConfirmCommand(raw) {
  return normalizeBaseCommand(raw, true);
}

function eventRequestId(requestId, phase, attempt = 0) {
  const digest = crypto.createHash('sha256')
    .update(`${requestId}:${phase}:${attempt}`, 'utf8')
    .digest('hex');
  return `f019:${phase}:${attempt}:${digest.slice(0, 36)}`;
}

function assertDependencies(database, fileSystem) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('DATABASE_REQUIRED', 'Assessment database is unavailable.');
  }
  for (const method of [
    'lstatSync', 'realpathSync', 'readdirSync', 'openSync', 'fstatSync',
    'readSync', 'closeSync', 'unlinkSync', 'rmdirSync',
  ]) {
    if (!fileSystem || typeof fileSystem[method] !== 'function') {
      fail('FILESYSTEM_REQUIRED', 'Assessment controlled storage is unavailable.');
    }
  }
}

function assertAuditContext(auditContext) {
  if (!auditContext || typeof auditContext !== 'object' || Array.isArray(auditContext)) {
    fail('AUDIT_CONTEXT_REQUIRED', 'Server-owned Assessment audit context is required.');
  }
  for (const [key, value] of Object.entries(ACTOR_CONTRACT)) {
    if (auditContext[key] !== value) fail('AUDIT_CONTEXT_INVALID', 'Server-owned Assessment audit context is invalid.');
  }
  if (!String(auditContext.actor_session_id || '').trim()) {
    fail('AUDIT_CONTEXT_INVALID', 'Server-owned Assessment audit context is invalid.');
  }
}

function assertAbsoluteDataRoot(dataRootInput, fileSystem) {
  if (typeof dataRootInput !== 'string' || !dataRootInput || dataRootInput.includes('\0')
      || !path.isAbsolute(dataRootInput)) {
    fail('ASSESSMENT_DATA_ROOT_INVALID', 'Assessment controlled storage root is invalid.');
  }
  try {
    const resolved = path.resolve(dataRootInput);
    const stat = fileSystem.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('unsafe root');
    return fileSystem.realpathSync(resolved);
  } catch {
    fail('ASSESSMENT_DATA_ROOT_INVALID', 'Assessment controlled storage root is invalid.');
  }
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function lstatIfPresent(fileSystem, target) {
  try {
    return fileSystem.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment controlled storage object is unsafe.');
  }
}

function assertDirectory(fileSystem, root, target, allowMissing = false) {
  if (!isWithin(root, target)) fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment controlled storage object is unsafe.');
  const stat = lstatIfPresent(fileSystem, target);
  if (!stat && allowMissing) return false;
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment controlled storage object is unsafe.');
  }
  let real;
  try { real = fileSystem.realpathSync(target); } catch {
    fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment controlled storage object is unsafe.');
  }
  if (real !== target || !isWithin(root, real)) {
    fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment controlled storage object is unsafe.');
  }
  return true;
}

function assertSafeAncestors(fileSystem, assessmentRoot, segments) {
  let current = assessmentRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!assertDirectory(fileSystem, assessmentRoot, current, true)) return false;
  }
  return true;
}

function hashFile(fileSystem, target) {
  let descriptor;
  try {
    const constants = fileSystem.constants || fs.constants;
    descriptor = fileSystem.openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fileSystem.fstatSync(descriptor).isFile()) throw new Error('not a regular file');
  } catch {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch {}
    }
    fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment controlled storage object does not match its archive record.');
  }
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const count = fileSystem.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } catch {
    fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment controlled storage object does not match its archive record.');
  } finally {
    try { fileSystem.closeSync(descriptor); } catch {}
  }
  return hash.digest('hex');
}

function canonicalArtifactSet(document, dataRoot, fileSystem) {
  const hash = String(document.content_sha256 || '');
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment controlled storage object does not match its archive record.');
  }
  const expectedRelpath = `accepted/sha256/${hash.slice(0, 2)}/${hash}.pdf`;
  if (document.storage_relpath !== expectedRelpath) {
    fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment controlled storage reference is invalid.');
  }
  const assessmentRoot = path.join(dataRoot, 'assessment');
  if (!assertDirectory(fileSystem, dataRoot, assessmentRoot)) {
    fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment controlled storage root is invalid.');
  }
  const blobParents = ['accepted', 'sha256', hash.slice(0, 2)];
  const previewParents = ['previews', 'sha256', hash.slice(0, 2)];
  assertSafeAncestors(fileSystem, assessmentRoot, blobParents);
  assertSafeAncestors(fileSystem, assessmentRoot, previewParents);
  const blob = path.join(assessmentRoot, ...blobParents, `${hash}.pdf`);
  const previewDirectory = path.join(assessmentRoot, ...previewParents, hash);
  if (!isWithin(assessmentRoot, blob) || !isWithin(assessmentRoot, previewDirectory)) {
    fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment controlled storage reference is invalid.');
  }
  return { assessmentRoot, blob, previewDirectory, hash };
}

function inspectBlob(fileSystem, artifacts, document) {
  const stat = lstatIfPresent(fileSystem, artifacts.blob);
  if (!stat) return false;
  if (stat.isSymbolicLink() || !stat.isFile() || Number(stat.size) !== Number(document.byte_size)
      || hashFile(fileSystem, artifacts.blob) !== artifacts.hash) {
    fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment controlled storage object does not match its archive record.');
  }
  return true;
}

function inspectPreviewFiles(fileSystem, artifacts, pageCount) {
  const directoryStat = lstatIfPresent(fileSystem, artifacts.previewDirectory);
  if (!directoryStat) return [];
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment controlled storage preview is unsafe.');
  }
  let names;
  try { names = fileSystem.readdirSync(artifacts.previewDirectory); } catch {
    fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment controlled storage preview is unsafe.');
  }
  const pages = [];
  for (const name of names) {
    const match = name.match(/^page-([1-9][0-9]*)\.png$/);
    if (!match || Number(match[1]) > pageCount) {
      fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment controlled storage preview is unsafe.');
    }
    const target = path.join(artifacts.previewDirectory, name);
    const stat = lstatIfPresent(fileSystem, target);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
      fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment controlled storage preview is unsafe.');
    }
    pages.push({ page: Number(match[1]), target });
  }
  pages.sort((left, right) => left.page - right.page);
  return pages;
}

function removeArtifacts(fileSystem, artifacts, document) {
  inspectBlob(fileSystem, artifacts, document);
  const pages = inspectPreviewFiles(fileSystem, artifacts, Number(document.page_count));
  try {
    for (const page of pages) fileSystem.unlinkSync(page.target);
    if (lstatIfPresent(fileSystem, artifacts.previewDirectory)) fileSystem.rmdirSync(artifacts.previewDirectory);
    if (lstatIfPresent(fileSystem, artifacts.blob)) fileSystem.unlinkSync(artifacts.blob);
  } catch {
    fail('PHYSICAL_DELETE_INCOMPLETE', 'Assessment physical deletion did not complete and may be retried.');
  }
  if (lstatIfPresent(fileSystem, artifacts.previewDirectory) || lstatIfPresent(fileSystem, artifacts.blob)) {
    fail('PHYSICAL_DELETE_INCOMPLETE', 'Assessment physical deletion did not complete and may be retried.');
  }
}

function documentForDeletion(database, documentId) {
  const document = database.prepare(`
    SELECT id, content_sha256, storage_relpath, byte_size, page_count,
           dispute_state, lifecycle_state, retention_policy_version, delete_after,
           legal_hold_state, version
    FROM assessment_document WHERE id = ?
  `).get(documentId);
  if (!document) fail('DOCUMENT_NOT_FOUND', 'Assessment document was not found.');
  return document;
}

function assertDeletionDocumentVersion(database, document, input, lifecycleState) {
  if (Number(document.version) === input.expectedVersion) return;
  if (lifecycleState !== 'deletion_pending' || Number(document.version) < input.expectedVersion) {
    fail('STALE_VERSION', 'Assessment document version has changed.');
  }
  const events = database.prepare(`
    SELECT event_type, before_version, after_version
    FROM assessment_event
    WHERE object_type = 'document' AND object_id = ?
      AND event_type IN ('legal_hold_applied', 'legal_hold_released')
      AND before_version >= ? AND after_version <= ?
    ORDER BY before_version, after_version
  `).all(input.documentId, input.expectedVersion, Number(document.version));
  let version = input.expectedVersion;
  let holdState = 'released';
  for (const event of events) {
    const beforeVersion = Number(event.before_version);
    const afterVersion = Number(event.after_version);
    const expectedType = holdState === 'active' ? 'legal_hold_released' : 'legal_hold_applied';
    if (event.event_type !== expectedType || beforeVersion !== version || afterVersion !== version + 1) {
      fail('STALE_VERSION', 'Assessment document version has changed.');
    }
    version = afterVersion;
    holdState = event.event_type === 'legal_hold_applied' ? 'active' : 'released';
  }
  if (version !== Number(document.version) || holdState !== document.legal_hold_state) {
    fail('STALE_VERSION', 'Assessment document version has changed.');
  }
}

function requireDeletionCandidate(database, input, lifecycleState) {
  const document = documentForDeletion(database, input.documentId);
  assertDeletionDocumentVersion(database, document, input, lifecycleState);
  if (!document.retention_policy_version) {
    fail('RETENTION_POLICY_NOT_CONFIGURED', 'Assessment physical deletion is disabled.');
  }
  if (document.retention_policy_version !== input.policyVersion) {
    fail('RETENTION_POLICY_MISMATCH', 'Assessment retention policy version does not match.');
  }
  if (document.dispute_state === 'open') fail('DISPUTE_OPEN', 'Assessment deletion is blocked by an open dispute.');
  if (document.legal_hold_state === 'active') fail('LEGAL_HOLD_ACTIVE', 'Assessment deletion is blocked by legal hold.');
  if (document.lifecycle_state !== lifecycleState) {
    if (document.lifecycle_state === 'frozen') fail('DOCUMENT_FROZEN', 'Assessment deletion is blocked while the document is frozen.');
    if (lifecycleState === 'deletion_pending') {
      fail('DELETION_REQUEST_REQUIRED', 'Assessment deletion must be requested first.');
    }
    fail('DOCUMENT_NOT_ACTIVE', 'Assessment document is not active.');
  }
  if (!document.delete_after || Date.parse(document.delete_after) > Date.parse(input.effectiveAt)) {
    fail('RETENTION_NOT_DUE', 'Assessment retention deadline has not been reached.');
  }
  if (database.prepare("SELECT 1 AS present FROM assessment_binding WHERE document_id = ? AND state = 'active'")
    .get(input.documentId)) {
    fail('ACTIVE_BINDING_EXISTS', 'Assessment deletion is blocked by an active binding.');
  }
  if (!Number.isInteger(Number(document.page_count)) || Number(document.page_count) <= 0
      || !Number.isInteger(Number(document.byte_size)) || Number(document.byte_size) <= 0) {
    fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment controlled storage object does not match its archive record.');
  }
  const hash = String(document.content_sha256 || '');
  const canonicalRelpath = /^[0-9a-f]{64}$/.test(hash)
    ? `accepted/sha256/${hash.slice(0, 2)}/${hash}.pdf`
    : '';
  if (!canonicalRelpath || document.storage_relpath !== canonicalRelpath) {
    fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment controlled storage reference is invalid.');
  }
  return document;
}

function deletionRequest(database, requestId) {
  return database.prepare(`
    SELECT request_id, document_id, expected_version, reason_code, policy_version,
           effective_at, state, last_error_code, attempt_count, physical_deleted_at
    FROM assessment_deletion_request WHERE request_id = ?
  `).get(requestId);
}

function assertRequestMatches(row, input) {
  if (!row || row.document_id !== input.documentId
      || Number(row.expected_version) !== input.expectedVersion
      || row.reason_code !== input.reasonCode
      || row.policy_version !== input.policyVersion
      || row.effective_at !== input.effectiveAt) {
    fail('IDEMPOTENCY_CONFLICT', 'Assessment physical deletion request identifier is already in use.');
  }
  return row;
}

function assertRequestCreationMatches(row, input) {
  if (!row || row.document_id !== input.documentId
      || Number(row.expected_version) !== input.expectedVersion + 1
      || row.reason_code !== input.reasonCode
      || row.policy_version !== input.policyVersion
      || row.effective_at !== input.effectiveAt) {
    fail('IDEMPOTENCY_CONFLICT', 'Assessment physical deletion request identifier is already in use.');
  }
  return row;
}

function runImmediate(database, work) {
  const transaction = database.transaction(work);
  return typeof transaction.immediate === 'function' ? transaction.immediate() : transaction();
}

function requestAssessmentPhysicalDeletion(options = {}) {
  const database = options.database;
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('DATABASE_REQUIRED', 'Assessment database is unavailable.');
  }
  assertAuditContext(options.auditContext);
  const input = normalizeRequestCommand(options.command);
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const createdAt = String(now());
  if (!Number.isFinite(Date.parse(createdAt))) fail('CLOCK_INVALID', 'Assessment deletion clock is invalid.');
  if (Date.parse(input.effectiveAt) > Date.parse(createdAt)) {
    fail('EFFECTIVE_AT_FUTURE', 'Assessment deletion effective time cannot be later than the server clock.');
  }
  try {
    return runImmediate(database, () => {
    const existing = deletionRequest(database, input.requestId);
    if (existing) {
      assertRequestCreationMatches(existing, input);
      const document = documentForDeletion(database, input.documentId);
      const event = database.prepare(`
        SELECT id FROM assessment_event WHERE request_id = ? AND event_type = 'delete_requested'
      `).get(eventRequestId(input.requestId, 'requested'));
      if (!event) fail('DELETION_REQUEST_STATE_INVALID', 'Assessment deletion request audit is unavailable.');
      return Object.freeze({
        operation: 'delete_requested',
        document_id: input.documentId,
        lifecycle_state: document.lifecycle_state,
        version: Number(existing.expected_version),
        physical_delete_enabled: existing.state !== 'completed',
        event_id: event.id,
        idempotent_replay: true,
        deletion_request_state: existing.state,
      });
    }
    if (database.prepare('SELECT 1 AS present FROM assessment_binding WHERE request_id = ?')
      .get(input.requestId)) {
      fail('IDEMPOTENCY_CONFLICT', 'Assessment physical deletion request identifier is already in use.');
    }
    const unfinished = database.prepare(`
      SELECT request_id FROM assessment_deletion_request
      WHERE document_id = ? AND state IN ('pending', 'retryable_failed')
    `).get(input.documentId);
    if (unfinished) {
      fail('DELETION_REQUEST_IN_PROGRESS', 'Another Assessment deletion request is already in progress.');
    }
    requireDeletionCandidate(database, input, 'active');
    try {
      database.prepare(`
      INSERT INTO assessment_deletion_request (
        request_id, document_id, expected_version, reason_code, policy_version, effective_at,
        state, last_error_code, attempt_count,
        actor_id, actor_type, actor_source, actor_session_id, actor_assurance,
        created_at, updated_at, physical_deleted_at, completed_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, 'pending', NULL, 0,
        ?, ?, ?, ?, ?, ?, ?, NULL, NULL
      )
      `).run(
      input.requestId, input.documentId, input.expectedVersion + 1, input.reasonCode,
      input.policyVersion, input.effectiveAt,
      options.auditContext.actor_id, options.auditContext.actor_type, options.auditContext.actor_source,
      String(options.auditContext.actor_session_id).trim(), options.auditContext.assurance,
      createdAt, createdAt,
      );
    } catch (error) {
      if (error && /^SQLITE_CONSTRAINT/.test(String(error.code || ''))) {
        fail('DELETION_REQUEST_IN_PROGRESS', 'Another Assessment deletion request is already in progress.');
      }
      throw error;
    }
    const requested = requestAssessmentDeletion({
      database,
      auditContext: options.auditContext,
      command: {
        ...input.raw,
        request_id: eventRequestId(input.requestId, 'requested'),
      },
    });
    if (Number(requested.version) !== input.expectedVersion + 1) {
      fail('DELETION_REQUEST_STATE_INVALID', 'Assessment deletion request state is invalid.');
    }
    return Object.freeze({
      ...requested,
      deletion_request_state: 'pending',
    });
    });
  } catch (error) {
    throw redactedDeleteError(error);
  }
}

function stableErrorCode(error) {
  const controlled = error instanceof AssessmentPhysicalDeleteError
    || (error && error.name === 'AssessmentArchiveError');
  const code = String(controlled && error.code ? error.code : 'PHYSICAL_DELETE_FAILED');
  return /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : 'PHYSICAL_DELETE_FAILED';
}

function redactedDeleteError(error) {
  return new AssessmentPhysicalDeleteError(
    stableErrorCode(error),
    'Assessment deletion operation failed.',
  );
}

function persistRetryableFailure(database, auditContext, input, error, updatedAt) {
  try {
    runImmediate(database, () => {
      const row = deletionRequest(database, input.requestId);
      if (!row || row.state === 'completed') return;
      assertRequestMatches(row, input);
      const errorCode = stableErrorCode(error);
      const attempt = Number(row.attempt_count) + 1;
      database.prepare(`
        UPDATE assessment_deletion_request
        SET state = 'retryable_failed', last_error_code = ?,
            attempt_count = attempt_count + 1, updated_at = ?,
            physical_deleted_at = NULL, completed_at = NULL
        WHERE request_id = ? AND state <> 'completed'
      `).run(errorCode, updatedAt, input.requestId);
      database.prepare(`
        INSERT INTO assessment_event (
          id, object_type, object_id, event_type,
          actor_id, actor_type, actor_source, actor_session_id, actor_assurance,
          request_id, reason_code, before_version, after_version, policy_version, created_at
        ) VALUES (
          ?, 'document', ?, 'delete_requested',
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        `assessment-event-${crypto.randomUUID()}`, input.documentId,
        auditContext.actor_id, auditContext.actor_type, auditContext.actor_source,
        String(auditContext.actor_session_id).trim(), auditContext.assurance,
        eventRequestId(input.requestId, 'attempt_failed', attempt), errorCode,
        input.expectedVersion, input.expectedVersion, input.policyVersion, updatedAt,
      );
    });
  } catch {
    // Preserve the original redacted failure. A failure to persist retry state
    // must never be mistaken for physical deletion completion.
  }
}

function completeWithinTransaction(database, fileSystem, dataRootInput, auditContext, input, updatedAt) {
  const request = assertRequestMatches(deletionRequest(database, input.requestId), input);
  const completionCommand = (expectedVersion) => ({
    ...input.raw,
    expected_version: expectedVersion,
    request_id: eventRequestId(input.requestId, 'completed'),
    deletion_request_id: input.requestId,
    deletion_request_expected_version: input.expectedVersion,
  });
  if (request.state === 'completed') {
    const replay = tombstoneAssessmentDocumentByPolicy({
      database,
      auditContext,
      command: completionCommand(input.expectedVersion),
    });
    return Object.freeze({
      ...replay,
      artifact_delete_state: 'physically_deleted',
      deletion_request_state: 'completed',
    });
  }

  if (request.state !== 'pending' && request.state !== 'retryable_failed') {
    fail('PHYSICAL_DELETE_STATE_CONFLICT', 'Assessment physical deletion state changed.');
  }
  const document = requireDeletionCandidate(database, input, 'deletion_pending');
  if (!request.physical_deleted_at) {
    const dataRoot = assertAbsoluteDataRoot(dataRootInput, fileSystem);
    const artifacts = canonicalArtifactSet(document, dataRoot, fileSystem);
    removeArtifacts(fileSystem, artifacts, document);
    const evidence = database.prepare(`
      UPDATE assessment_deletion_request
      SET state = 'pending', last_error_code = NULL,
          attempt_count = attempt_count + 1, updated_at = ?, physical_deleted_at = ?
      WHERE request_id = ? AND state IN ('pending', 'retryable_failed')
    `).run(updatedAt, updatedAt, input.requestId);
    if (evidence.changes !== 1) {
      fail('PHYSICAL_DELETE_STATE_CONFLICT', 'Assessment physical deletion state changed.');
    }
  }

  const tombstone = tombstoneAssessmentDocumentByPolicy({
    database,
    auditContext,
    command: completionCommand(Number(document.version)),
  });
  const completed = database.prepare(`
    UPDATE assessment_deletion_request
    SET state = 'completed', last_error_code = NULL,
        updated_at = ?, completed_at = ?
    WHERE request_id = ? AND state = 'pending' AND physical_deleted_at IS NOT NULL
  `).run(updatedAt, updatedAt, input.requestId);
  if (completed.changes !== 1) {
    fail('PHYSICAL_DELETE_STATE_CONFLICT', 'Assessment physical deletion state changed.');
  }
  return Object.freeze({
    ...tombstone,
    artifact_delete_state: 'physically_deleted',
    deletion_request_state: 'completed',
  });
}

function executeAssessmentPhysicalDeletion(options = {}) {
  const database = options.database;
  const fileSystem = options.fileSystem || fs;
  assertDependencies(database, fileSystem);
  assertAuditContext(options.auditContext);
  const input = normalizeConfirmCommand(options.command);
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();
  const createdAt = String(now());
  if (!Number.isFinite(Date.parse(createdAt))) fail('CLOCK_INVALID', 'Assessment physical deletion clock is invalid.');
  try {
    const updatedAt = String(now());
    if (!Number.isFinite(Date.parse(updatedAt))) fail('CLOCK_INVALID', 'Assessment physical deletion clock is invalid.');
    return runImmediate(database, () => completeWithinTransaction(
      database, fileSystem, options.dataRoot, options.auditContext, input, updatedAt,
    ));
  } catch (error) {
    const failedAt = String(now());
    persistRetryableFailure(
      database,
      options.auditContext,
      input,
      error,
      Number.isFinite(Date.parse(failedAt)) ? failedAt : createdAt,
    );
    throw redactedDeleteError(error);
  }
}

module.exports = {
  AssessmentPhysicalDeleteError,
  executeAssessmentPhysicalDeletion,
  requestAssessmentPhysicalDeletion,
};
