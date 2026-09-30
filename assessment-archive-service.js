'use strict';

const crypto = require('crypto');

const ACTOR_CONTRACT = Object.freeze({
  actor_id: 'local-primary-operator',
  actor_type: 'local_os_subject',
  actor_source: 'server_local_instance',
  assurance: 'local_instance_only',
});

const REPORT_TYPES = new Set(['career_potential', 'workplace_style', 'team_role', 'unknown']);
const IDENTITY_BASES = new Set([
  'current_candidate_context',
  'same_source_identity',
  'manual_cross_source',
]);
const ARCHIVE_SCOPE = 'candidate_job_archive';
const SECURITY_STATES = new Set(['accepted', 'quarantined', 'rejected']);

class AssessmentArchiveError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'AssessmentArchiveError';
    this.code = code;
    this.path = path;
  }
}

function fail(code, path, message) {
  throw new AssessmentArchiveError(code, path, message);
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('DATABASE_REQUIRED', '$.database', 'Assessment database is required.');
  }
}

function requiredText(value, path, code, maxLength = 160) {
  const normalized = String(value === undefined || value === null ? '' : value).trim();
  if (!normalized || normalized.length > maxLength) {
    fail(code, path, 'A required Assessment identifier is invalid.');
  }
  return normalized;
}

function requiredRequestId(value) {
  const requestId = requiredText(value, '$.command.request_id', 'REQUEST_ID_REQUIRED', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) {
    fail('REQUEST_ID_INVALID', '$.command.request_id', 'The Assessment request identifier is invalid.');
  }
  return requestId;
}

function requiredReasonCode(value) {
  const reasonCode = requiredText(value, '$.command.reason_code', 'REASON_CODE_REQUIRED', 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(reasonCode)) {
    fail('REASON_CODE_INVALID', '$.command.reason_code', 'Assessment reason code must be a controlled ASCII token.');
  }
  return reasonCode;
}

function normalizedAssessmentDate(value) {
  if (value === undefined || value === null) return null;
  const assessmentDate = requiredText(value, '$.command.assessment_date', 'ASSESSMENT_DATE_INVALID', 10);
  const match = assessmentDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    fail('ASSESSMENT_DATE_INVALID', '$.command.assessment_date', 'Assessment date must be a valid calendar date in YYYY-MM-DD.');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    fail('ASSESSMENT_DATE_INVALID', '$.command.assessment_date', 'Assessment date must be a valid calendar date in YYYY-MM-DD.');
  }
  return assessmentDate;
}

function requiredVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version <= 0) {
    fail('EXPECTED_VERSION_REQUIRED', '$.command.expected_version', 'A positive expected version is required.');
  }
  return version;
}

function requiredJobId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    fail('JOB_ID_REQUIRED', '$.command.job_id', 'A valid job context is required.');
  }
  return id;
}

function requiredSha256(value) {
  const hash = requiredText(value, '$.command.content_sha256', 'CONTENT_SHA256_REQUIRED', 64);
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    fail('CONTENT_SHA256_INVALID', '$.command.content_sha256', 'Assessment content hash is invalid.');
  }
  return hash;
}

function requiredPositiveInteger(value, path, code, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > maximum) {
    fail(code, path, 'Assessment file metadata is invalid.');
  }
  return number;
}

function requiredStorageRelpath(value) {
  const relpath = requiredText(value, '$.command.storage_relpath', 'STORAGE_RELPATH_REQUIRED', 240);
  if (relpath.includes('\\') || relpath.includes('\0') || relpath.startsWith('/')
      || /^[A-Za-z]:/.test(relpath) || relpath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    fail('STORAGE_RELPATH_INVALID', '$.command.storage_relpath', 'Assessment storage reference is invalid.');
  }
  return relpath;
}

function optionalPolicyVersion(value, path = '$.command.policy_version') {
  if (value === undefined || value === null) return null;
  return requiredText(value, path, 'POLICY_VERSION_INVALID', 80);
}

function requiredCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    fail('COMMAND_REQUIRED', '$.command', 'An Assessment command is required.');
  }
  return command;
}

function assertAuditContext(auditContext) {
  if (!auditContext || typeof auditContext !== 'object' || Array.isArray(auditContext)) {
    fail('AUDIT_CONTEXT_REQUIRED', '$.auditContext', 'Server-owned Assessment audit context is required.');
  }
  for (const [key, expected] of Object.entries(ACTOR_CONTRACT)) {
    if (auditContext[key] !== expected) {
      fail('AUDIT_CONTEXT_INVALID', `$.auditContext.${key}`, 'Server-owned Assessment audit context is invalid.');
    }
  }
  if (!String(auditContext.actor_session_id || '').trim()) {
    fail('AUDIT_CONTEXT_INVALID', '$.auditContext.actor_session_id', 'Server-owned Assessment session is required.');
  }
  return Object.freeze({
    ...ACTOR_CONTRACT,
    actor_session_id: String(auditContext.actor_session_id).trim(),
  });
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function eventByRequestId(database, requestId) {
  return database.prepare(`
    SELECT id, object_type, object_id, event_type, request_id, reason_code, policy_version,
           before_version, after_version, created_at
    FROM assessment_event
    WHERE request_id = ?
  `).get(requestId);
}

function idempotencyConflict() {
  fail('IDEMPOTENCY_CONFLICT', '$.command.request_id', 'The request identifier belongs to another Assessment operation or object.');
}

function insertEvent(database, auditContext, input) {
  database.prepare(`
    INSERT INTO assessment_event (
      id, object_type, object_id, event_type,
      actor_id, actor_type, actor_source, actor_session_id, actor_assurance,
      request_id, reason_code, before_version, after_version, policy_version, created_at
    ) VALUES (
      @id, @object_type, @object_id, @event_type,
      @actor_id, @actor_type, @actor_source, @actor_session_id, @actor_assurance,
      @request_id, @reason_code, @before_version, @after_version, @policy_version, @created_at
    )
  `).run({
    id: input.id,
    object_type: input.object_type,
    object_id: input.object_id,
    event_type: input.event_type,
    actor_id: auditContext.actor_id,
    actor_type: auditContext.actor_type,
    actor_source: auditContext.actor_source,
    actor_session_id: auditContext.actor_session_id,
    actor_assurance: auditContext.assurance,
    request_id: input.request_id,
    reason_code: input.reason_code,
    before_version: input.before_version,
    after_version: input.after_version,
    policy_version: input.policy_version || null,
    created_at: input.created_at,
  });
}

function documentById(database, documentId) {
  return database.prepare(`
    SELECT id, content_sha256, storage_relpath, byte_size, page_count,
           security_state, report_type, assessment_date, review_state,
           analysis_status, analysis_schema_version, analysis_json, analysis_error_code,
           dispute_state, lifecycle_state, retention_policy_version, delete_after,
           legal_hold_state, supersedes_document_id, version, deleted_at
    FROM assessment_document
    WHERE id = ?
  `).get(documentId);
}

function requireDocument(database, documentId) {
  const row = documentById(database, documentId);
  if (!row) fail('DOCUMENT_NOT_FOUND', '$.command.document_id', 'Assessment document was not found.');
  return row;
}

function assertDocumentAccessible(document, { requireReady = true } = {}) {
  if (document.lifecycle_state === 'deleted') {
    fail('DOCUMENT_DELETED', '$.command.document_id', 'Assessment document is not available.');
  }
  if (document.lifecycle_state === 'frozen' || document.lifecycle_state === 'deletion_pending') {
    fail('DOCUMENT_FROZEN', '$.command.document_id', 'Assessment document is not available in its current lifecycle state.');
  }
  if (document.lifecycle_state !== 'active') {
    fail('DOCUMENT_NOT_ACTIVE', '$.command.document_id', 'Assessment document is not active.');
  }
  if (document.security_state !== 'accepted') {
    fail('DOCUMENT_SECURITY_NOT_ACCEPTED', '$.command.document_id', 'Assessment document has not passed security review.');
  }
  if (requireReady && document.review_state !== 'ready') {
    fail('DOCUMENT_NOT_READY', '$.command.document_id', 'Assessment document metadata is not ready.');
  }
}

function candidateBelongsToJob(database, candidateId, jobId) {
  return Boolean(database.prepare(`
    SELECT 1 AS present
    FROM candidate
    WHERE internal_id = ? AND job_id = ?
  `).get(candidateId, jobId));
}

function runImmediate(database, work) {
  const transaction = database.transaction(work);
  return typeof transaction.immediate === 'function' ? transaction.immediate() : transaction();
}

function bindingById(database, bindingId) {
  return database.prepare(`
    SELECT id, document_id, candidate_id, job_id, scope, state, conflict_state,
           identity_basis, reason_code, request_id, version, revoked_at
    FROM assessment_binding
    WHERE id = ?
  `).get(bindingId);
}

function requireBinding(database, bindingId) {
  const row = bindingById(database, bindingId);
  if (!row) fail('BINDING_NOT_FOUND', '$.command.binding_id', 'Assessment binding was not found.');
  return row;
}

function assertRequestNotOwnedByBinding(database, requestId) {
  if (database.prepare('SELECT 1 FROM assessment_binding WHERE request_id = ?').get(requestId)) {
    idempotencyConflict();
  }
}

function assertExpectedVersion(row, expectedVersion, path = '$.command.expected_version') {
  if (Number(row.version) !== expectedVersion) {
    fail('STALE_VERSION', path, 'Assessment object version has changed.');
  }
}

function recordAssessmentDocumentIntake({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = requiredCommand(command);
  const requestId = requiredRequestId(input.request_id);
  const contentSha256 = requiredSha256(input.content_sha256);
  const storageRelpath = requiredStorageRelpath(input.storage_relpath);
  const byteSize = requiredPositiveInteger(input.byte_size, '$.command.byte_size', 'BYTE_SIZE_INVALID', 25 * 1024 * 1024);
  const pageCount = requiredPositiveInteger(input.page_count, '$.command.page_count', 'PAGE_COUNT_INVALID', 200);
  if (input.mime_detected !== 'application/pdf') {
    fail('MIME_DETECTED_INVALID', '$.command.mime_detected', 'Assessment MIME type is invalid.');
  }
  const securityState = requiredText(input.security_state, '$.command.security_state', 'SECURITY_STATE_REQUIRED', 20);
  if (!SECURITY_STATES.has(securityState)) {
    fail('SECURITY_STATE_INVALID', '$.command.security_state', 'Assessment security state is invalid.');
  }
  const retentionPolicyVersion = optionalPolicyVersion(input.retention_policy_version, '$.command.retention_policy_version');
  const deleteAfter = input.delete_after === undefined || input.delete_after === null
    ? null
    : requiredText(input.delete_after, '$.command.delete_after', 'DELETE_AFTER_INVALID', 40);
  if (deleteAfter && (!retentionPolicyVersion || !Number.isFinite(Date.parse(deleteAfter)))) {
    fail('DELETE_AFTER_INVALID', '$.command.delete_after', 'Assessment retention deadline is invalid.');
  }
  let analysisJson = null;
  let analysisSchemaVersion = null;
  let analysisErrorCode = null;
  if (input.analysis !== undefined && input.analysis !== null) {
    if (!input.analysis || typeof input.analysis !== 'object' || Array.isArray(input.analysis)) {
      fail('ANALYSIS_INVALID', '$.command.analysis', 'Assessment analysis is invalid.');
    }
    analysisSchemaVersion = requiredText(
      input.analysis.schema_version,
      '$.command.analysis.schema_version',
      'ANALYSIS_SCHEMA_VERSION_INVALID',
      80,
    );
    analysisJson = JSON.stringify(input.analysis);
    if (Buffer.byteLength(analysisJson, 'utf8') > 65536) {
      fail('ANALYSIS_INVALID', '$.command.analysis', 'Assessment analysis exceeds the storage limit.');
    }
  }
  if (!analysisJson && input.analysis_error_code !== undefined && input.analysis_error_code !== null) {
    analysisErrorCode = requiredText(
      input.analysis_error_code,
      '$.command.analysis_error_code',
      'ANALYSIS_ERROR_CODE_INVALID',
      80,
    );
    if (!/^ASSESSMENT_REPORT_[A-Z0-9_]+$/.test(analysisErrorCode)) {
      fail('ANALYSIS_ERROR_CODE_INVALID', '$.command.analysis_error_code', 'Assessment analysis error code is invalid.');
    }
  }

  return runImmediate(database, () => {
    const replay = eventByRequestId(database, requestId);
    if (replay) {
      if (replay.object_type !== 'document'
          || !['uploaded', 'security_rejected', 'duplicate_seen'].includes(replay.event_type)) {
        idempotencyConflict();
      }
      const current = requireDocument(database, replay.object_id);
      if (current.content_sha256 !== contentSha256) idempotencyConflict();
      if (replay.event_type !== 'duplicate_seen' && current.security_state !== securityState) idempotencyConflict();
      return {
        operation: replay.event_type,
        document_id: current.id,
        security_state: current.security_state,
        review_state: current.review_state,
        version: Number(replay.after_version),
        duplicate: replay.event_type === 'duplicate_seen',
        event_id: replay.id,
        idempotent_replay: true,
      };
    }

    const duplicate = database.prepare(`
      SELECT id FROM assessment_document WHERE content_sha256 = ?
    `).get(contentSha256);
    const createdAt = nowIso();
    if (duplicate) {
      const eventId = newId('assessment-event');
      insertEvent(database, actor, {
        id: eventId,
        object_type: 'document',
        object_id: duplicate.id,
        event_type: 'duplicate_seen',
        request_id: requestId,
        reason_code: 'same_content_hash',
        before_version: null,
        after_version: null,
        created_at: createdAt,
      });
      return {
        operation: 'duplicate_seen',
        document_id: duplicate.id,
        duplicate: true,
        event_id: eventId,
        idempotent_replay: false,
      };
    }
    if (database.prepare('SELECT 1 FROM assessment_document WHERE storage_relpath = ?').get(storageRelpath)) {
      fail('STORAGE_RELPATH_CONFLICT', '$.command.storage_relpath', 'Assessment storage reference is already in use.');
    }

    const documentId = newId('assessment-document');
    database.prepare(`
      INSERT INTO assessment_document (
        id, content_sha256, storage_relpath, byte_size, page_count, mime_detected,
        security_state, report_type, assessment_date,
        analysis_status, analysis_schema_version, analysis_json, analysis_error_code,
        review_state, dispute_state,
        lifecycle_state, retention_policy_version, delete_after, legal_hold_state,
        supersedes_document_id, created_by, version, created_at, updated_at, deleted_at
      ) VALUES (
        ?, ?, ?, ?, ?, 'application/pdf',
        ?, 'unknown', NULL, ?, ?, ?, ?, ?, 'none',
        ?, ?, ?, 'none',
        NULL, ?, 1, ?, ?, NULL
      )
    `).run(
      documentId, contentSha256, storageRelpath, byteSize, pageCount,
      securityState,
      analysisJson ? 'ready' : analysisErrorCode ? 'failed' : 'pending', analysisSchemaVersion, analysisJson, analysisErrorCode,
      securityState === 'accepted' ? 'pending' : 'rejected',
      securityState === 'accepted' ? 'active' : 'frozen',
      retentionPolicyVersion, deleteAfter, actor.actor_id, createdAt, createdAt,
    );
    const eventType = securityState === 'accepted' ? 'uploaded' : 'security_rejected';
    const eventId = newId('assessment-event');
    insertEvent(database, actor, {
      id: eventId,
      object_type: 'document',
      object_id: documentId,
      event_type: eventType,
      request_id: requestId,
      reason_code: securityState === 'accepted' ? 'security_accepted' : `security_${securityState}`,
      before_version: null,
      after_version: 1,
      policy_version: retentionPolicyVersion,
      created_at: createdAt,
    });
    return {
      operation: eventType,
      document_id: documentId,
      security_state: securityState,
      review_state: securityState === 'accepted' ? 'pending' : 'rejected',
      version: 1,
      duplicate: false,
      event_id: eventId,
      idempotent_replay: false,
    };
  });
}

function confirmAssessmentMetadata({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = requiredCommand(command);
  const documentId = requiredText(input.document_id, '$.command.document_id', 'DOCUMENT_ID_REQUIRED');
  const requestId = requiredRequestId(input.request_id);
  const expectedVersion = requiredVersion(input.expected_version);
  const reportType = requiredText(input.report_type, '$.command.report_type', 'REPORT_TYPE_REQUIRED', 40);
  if (!REPORT_TYPES.has(reportType)) {
    fail('REPORT_TYPE_INVALID', '$.command.report_type', 'Assessment report type is invalid.');
  }
  if (reportType === 'unknown') {
    fail(
      'REPORT_TYPE_CLASSIFICATION_REQUIRED',
      '$.command.report_type',
      'Assessment report type must be classified before metadata can be confirmed.',
    );
  }
  const assessmentDate = normalizedAssessmentDate(input.assessment_date);

  return runImmediate(database, () => {
    const replay = eventByRequestId(database, requestId);
    if (replay) {
      if (replay.event_type !== 'metadata_confirmed' || replay.object_type !== 'document' || replay.object_id !== documentId) {
        idempotencyConflict();
      }
      const current = requireDocument(database, documentId);
      if (current.report_type !== reportType || current.assessment_date !== assessmentDate) {
        idempotencyConflict();
      }
      return {
        operation: 'metadata_confirmed',
        document_id: current.id,
        report_type: current.report_type,
        assessment_date: current.assessment_date,
        review_state: current.review_state,
        version: Number(replay.after_version),
        event_id: replay.id,
        idempotent_replay: true,
      };
    }

    const current = requireDocument(database, documentId);
    assertDocumentAccessible(current, { requireReady: false });
    if (Number(current.version) !== expectedVersion) {
      fail('STALE_VERSION', '$.command.expected_version', 'Assessment document version has changed.');
    }
    if (current.review_state !== 'pending') {
      fail('DOCUMENT_REVIEW_STATE_INVALID', '$.command.document_id', 'Assessment document metadata cannot be confirmed from its current state.');
    }

    const createdAt = nowIso();
    const afterVersion = expectedVersion + 1;
    const update = database.prepare(`
      UPDATE assessment_document
      SET report_type = ?, assessment_date = ?, review_state = 'ready',
          version = ?, updated_at = ?
      WHERE id = ? AND version = ? AND security_state = 'accepted'
        AND review_state = 'pending' AND lifecycle_state = 'active'
    `).run(reportType, assessmentDate, afterVersion, createdAt, documentId, expectedVersion);
    if (update.changes !== 1) {
      fail('STALE_VERSION', '$.command.expected_version', 'Assessment document version has changed.');
    }
    const eventId = newId('assessment-event');
    insertEvent(database, actor, {
      id: eventId,
      object_type: 'document',
      object_id: documentId,
      event_type: 'metadata_confirmed',
      request_id: requestId,
      reason_code: 'metadata_confirmed',
      before_version: expectedVersion,
      after_version: afterVersion,
      created_at: createdAt,
    });
    return {
      operation: 'metadata_confirmed',
      document_id: documentId,
      report_type: reportType,
      assessment_date: assessmentDate,
      review_state: 'ready',
      version: afterVersion,
      event_id: eventId,
      idempotent_replay: false,
    };
  });
}

function normalizeBindingCommand(command, { requireDocumentVersion = true } = {}) {
  const input = requiredCommand(command);
  if (input.scope !== ARCHIVE_SCOPE) {
    fail('SCOPE_INVALID', '$.command.scope', 'Assessment binding scope must be candidate_job_archive.');
  }
  const identityBasis = requiredText(input.identity_basis, '$.command.identity_basis', 'IDENTITY_BASIS_REQUIRED', 80);
  if (!IDENTITY_BASES.has(identityBasis)) {
    fail('IDENTITY_BASIS_INVALID', '$.command.identity_basis', 'Assessment identity basis is invalid.');
  }
  return Object.freeze({
    documentId: requiredText(input.document_id, '$.command.document_id', 'DOCUMENT_ID_REQUIRED'),
    candidateId: requiredText(input.candidate_id, '$.command.candidate_id', 'CANDIDATE_ID_REQUIRED'),
    jobId: requiredJobId(input.job_id),
    requestId: requiredRequestId(input.request_id),
    expectedVersion: requireDocumentVersion ? requiredVersion(input.expected_version) : null,
    identityBasis,
    reasonCode: requiredReasonCode(input.reason_code),
  });
}

function createPendingAssessmentBinding({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = normalizeBindingCommand(command);

  return runImmediate(database, () => {
    const replay = eventByRequestId(database, input.requestId);
    if (replay) idempotencyConflict();
    const existing = database.prepare('SELECT id FROM assessment_binding WHERE request_id = ?').get(input.requestId);
    if (existing) {
      const binding = requireBinding(database, existing.id);
      if (binding.document_id !== input.documentId || binding.candidate_id !== input.candidateId
          || Number(binding.job_id) !== input.jobId || binding.identity_basis !== input.identityBasis
          || binding.reason_code !== input.reasonCode) idempotencyConflict();
      return {
        operation: 'binding_pending',
        binding_id: binding.id,
        document_id: binding.document_id,
        candidate_id: binding.candidate_id,
        job_id: Number(binding.job_id),
        state: 'pending',
        conflict_state: binding.conflict_state,
        version: Number(binding.version),
        event_id: null,
        idempotent_replay: true,
      };
    }

    const document = requireDocument(database, input.documentId);
    assertDocumentAccessible(document, { requireReady: false });
    if (document.review_state !== 'pending' && document.review_state !== 'ready') {
      fail('DOCUMENT_REVIEW_STATE_INVALID', '$.command.document_id', 'Assessment document cannot be queued from its current review state.');
    }
    assertExpectedVersion(document, input.expectedVersion);
    if (!candidateBelongsToJob(database, input.candidateId, input.jobId)) {
      fail('CANDIDATE_JOB_MISMATCH', '$.command.candidate_id', 'Candidate and job context do not match.');
    }
    if (database.prepare(`
      SELECT 1 FROM assessment_binding
      WHERE document_id = ? AND state IN ('pending', 'active')
    `).get(input.documentId)) {
      fail('DOCUMENT_ALREADY_BOUND', '$.command.document_id', 'Assessment document already has a pending or active binding.');
    }
    const createdAt = nowIso();
    const documentVersion = input.expectedVersion + 1;
    const bump = database.prepare(`
      UPDATE assessment_document SET version = ?, updated_at = ?
      WHERE id = ? AND version = ? AND security_state = 'accepted'
        AND review_state IN ('pending', 'ready') AND lifecycle_state = 'active'
    `).run(documentVersion, createdAt, input.documentId, input.expectedVersion);
    if (bump.changes !== 1) fail('STALE_VERSION', '$.command.expected_version', 'Assessment document version has changed.');

    const bindingId = newId('assessment-binding');
    database.prepare(`
      INSERT INTO assessment_binding (
        id, document_id, candidate_id, job_id, scope, state, conflict_state, identity_basis,
        actor_id, reason_code, request_id, version, created_at, updated_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 1, ?, ?, NULL)
    `).run(
      bindingId, input.documentId, input.candidateId, input.jobId, ARCHIVE_SCOPE,
      'none',
      input.identityBasis, actor.actor_id, input.reasonCode, input.requestId, createdAt, createdAt,
    );
    return {
      operation: 'binding_pending',
      binding_id: bindingId,
      document_id: input.documentId,
      candidate_id: input.candidateId,
      job_id: input.jobId,
      scope: ARCHIVE_SCOPE,
      state: 'pending',
      conflict_state: 'none',
      version: 1,
      document_version: documentVersion,
      event_id: null,
      idempotent_replay: false,
    };
  });
}

function confirmAssessmentBinding({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = requiredCommand(command);
  const bindingId = requiredText(input.binding_id, '$.command.binding_id', 'BINDING_ID_REQUIRED');
  const expectedVersion = requiredVersion(input.expected_version);
  const requestId = requiredRequestId(input.request_id);
  const reasonCode = requiredReasonCode(input.reason_code);

  return runImmediate(database, () => {
    const replay = eventByRequestId(database, requestId);
    if (replay) {
      if (replay.event_type !== 'binding_confirmed' || replay.object_type !== 'binding' || replay.object_id !== bindingId) {
        idempotencyConflict();
      }
      if (replay.reason_code !== reasonCode) idempotencyConflict();
      return {
        operation: 'binding_confirmed',
        binding_id: bindingId,
        state: 'active',
        version: Number(replay.after_version),
        event_id: replay.id,
        idempotent_replay: true,
      };
    }
    assertRequestNotOwnedByBinding(database, requestId);

    const binding = requireBinding(database, bindingId);
    assertExpectedVersion(binding, expectedVersion);
    if (binding.state !== 'pending') {
      fail('BINDING_STATE_INVALID', '$.command.binding_id', 'Assessment binding cannot be confirmed from its current state.');
    }
    if (!candidateBelongsToJob(database, binding.candidate_id, Number(binding.job_id))) {
      fail('CANDIDATE_JOB_MISMATCH', '$.command.candidate_id', 'Candidate and job context do not match.');
    }
    const document = requireDocument(database, binding.document_id);
    assertDocumentAccessible(document);
    const createdAt = nowIso();
    const afterVersion = expectedVersion + 1;
    const update = database.prepare(`
      UPDATE assessment_binding
      SET state = 'active', conflict_state = 'none', reason_code = ?, version = ?, updated_at = ?
      WHERE id = ? AND state = 'pending' AND version = ?
    `).run(reasonCode, afterVersion, createdAt, bindingId, expectedVersion);
    if (update.changes !== 1) fail('STALE_VERSION', '$.command.expected_version', 'Assessment binding version has changed.');
    const eventId = newId('assessment-event');
    insertEvent(database, actor, {
      id: eventId,
      object_type: 'binding',
      object_id: bindingId,
      event_type: 'binding_confirmed',
      request_id: requestId,
      reason_code: reasonCode,
      before_version: expectedVersion,
      after_version: afterVersion,
      created_at: createdAt,
    });
    return {
      operation: 'binding_confirmed',
      binding_id: bindingId,
      document_id: binding.document_id,
      candidate_id: binding.candidate_id,
      job_id: Number(binding.job_id),
      state: 'active',
      version: afterVersion,
      event_id: eventId,
      idempotent_replay: false,
    };
  });
}

// Compatibility entry point for the earlier foundation API. It no longer inserts an
// active binding directly: the same explicit command is applied as pending -> confirm
// inside one outer transaction, so every current product rule is still enforced.
function bindAssessmentDocument({ database, auditContext, command } = {}) {
  assertDatabase(database);
  assertAuditContext(auditContext);
  const raw = requiredCommand(command);
  const requestId = requiredRequestId(raw.request_id);
  const pendingRequestId = `pending-${crypto.createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`;
  return runImmediate(database, () => {
    const replay = eventByRequestId(database, requestId);
    if (replay && replay.event_type !== 'binding_confirmed') idempotencyConflict();
    const pendingResult = createPendingAssessmentBinding({
      database,
      auditContext,
      command: { ...raw, request_id: pendingRequestId },
    });
    const confirmed = confirmAssessmentBinding({
      database,
      auditContext,
      command: {
        binding_id: pendingResult.binding_id,
        expected_version: pendingResult.version,
        reason_code: raw.reason_code,
        request_id: requestId,
      },
    });
    return {
      ...confirmed,
      document_id: pendingResult.document_id,
      candidate_id: pendingResult.candidate_id,
      job_id: pendingResult.job_id,
      scope: ARCHIVE_SCOPE,
      document_version: pendingResult.document_version,
    };
  });
}

function revokeAssessmentBinding({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = requiredCommand(command);
  const bindingId = requiredText(input.binding_id, '$.command.binding_id', 'BINDING_ID_REQUIRED');
  const expectedVersion = requiredVersion(input.expected_version);
  const requestId = requiredRequestId(input.request_id);
  const reasonCode = requiredReasonCode(input.reason_code);

  return runImmediate(database, () => {
    const replay = eventByRequestId(database, requestId);
    if (replay) {
      if (replay.event_type !== 'binding_revoked' || replay.object_type !== 'binding' || replay.object_id !== bindingId) {
        idempotencyConflict();
      }
      if (replay.reason_code !== reasonCode) idempotencyConflict();
      return {
        operation: 'binding_revoked', binding_id: bindingId, state: 'revoked',
        version: Number(replay.after_version), event_id: replay.id, idempotent_replay: true,
      };
    }
    assertRequestNotOwnedByBinding(database, requestId);
    const binding = requireBinding(database, bindingId);
    assertExpectedVersion(binding, expectedVersion);
    if (!['pending', 'active'].includes(binding.state)) {
      fail('BINDING_STATE_INVALID', '$.command.binding_id', 'Assessment binding cannot be revoked from its current state.');
    }
    const createdAt = nowIso();
    const afterVersion = expectedVersion + 1;
    const update = database.prepare(`
      UPDATE assessment_binding
      SET state = 'revoked', reason_code = ?, version = ?, updated_at = ?, revoked_at = ?
      WHERE id = ? AND state IN ('pending', 'active') AND version = ?
    `).run(reasonCode, afterVersion, createdAt, createdAt, bindingId, expectedVersion);
    if (update.changes !== 1) fail('STALE_VERSION', '$.command.expected_version', 'Assessment binding version has changed.');
    const eventId = newId('assessment-event');
    insertEvent(database, actor, {
      id: eventId, object_type: 'binding', object_id: bindingId, event_type: 'binding_revoked',
      request_id: requestId, reason_code: reasonCode, before_version: expectedVersion,
      after_version: afterVersion, created_at: createdAt,
    });
    return {
      operation: 'binding_revoked', binding_id: bindingId, document_id: binding.document_id,
      state: 'revoked', version: afterVersion, event_id: eventId, idempotent_replay: false,
    };
  });
}

function rebindAssessmentDocument({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = requiredCommand(command);
  const oldBindingId = requiredText(input.binding_id, '$.command.binding_id', 'BINDING_ID_REQUIRED');
  const candidateId = requiredText(input.candidate_id, '$.command.candidate_id', 'CANDIDATE_ID_REQUIRED');
  const jobId = requiredJobId(input.job_id);
  const expectedVersion = requiredVersion(input.expected_version);
  const requestId = requiredRequestId(input.request_id);
  const identityBasis = requiredText(input.identity_basis, '$.command.identity_basis', 'IDENTITY_BASIS_REQUIRED', 80);
  if (!IDENTITY_BASES.has(identityBasis)) {
    fail('IDENTITY_BASIS_INVALID', '$.command.identity_basis', 'Assessment identity basis is invalid.');
  }
  const reasonCode = requiredReasonCode(input.reason_code);

  return runImmediate(database, () => {
    const replay = eventByRequestId(database, requestId);
    if (replay) {
      if (replay.event_type !== 'binding_rebound' || replay.object_type !== 'binding'
          || replay.object_id !== oldBindingId || replay.reason_code !== reasonCode) idempotencyConflict();
      const replacement = database.prepare(`
        SELECT id, document_id, candidate_id, job_id, state, version
        FROM assessment_binding WHERE request_id = ?
      `).get(requestId);
      if (!replacement || replacement.candidate_id !== candidateId || Number(replacement.job_id) !== jobId) {
        idempotencyConflict();
      }
      return {
        operation: 'binding_rebound', old_binding_id: oldBindingId, binding_id: replacement.id,
        document_id: replacement.document_id, candidate_id: replacement.candidate_id,
        job_id: Number(replacement.job_id), state: 'active', version: Number(replacement.version),
        event_id: replay.id, idempotent_replay: true,
      };
    }
    assertRequestNotOwnedByBinding(database, requestId);
    const oldBinding = requireBinding(database, oldBindingId);
    assertExpectedVersion(oldBinding, expectedVersion);
    if (oldBinding.state !== 'active') {
      fail('BINDING_STATE_INVALID', '$.command.binding_id', 'Only an active Assessment binding can be rebound.');
    }
    if (oldBinding.candidate_id === candidateId && Number(oldBinding.job_id) === jobId) {
      fail('REBIND_CONTEXT_UNCHANGED', '$.command.binding_id', 'Assessment binding target has not changed.');
    }
    if (!candidateBelongsToJob(database, candidateId, jobId)) {
      fail('CANDIDATE_JOB_MISMATCH', '$.command.candidate_id', 'Candidate and job context do not match.');
    }
    const document = requireDocument(database, oldBinding.document_id);
    assertDocumentAccessible(document);
    const createdAt = nowIso();
    const oldAfterVersion = expectedVersion + 1;
    const revoked = database.prepare(`
      UPDATE assessment_binding
      SET state = 'revoked', reason_code = ?, version = ?, updated_at = ?, revoked_at = ?
      WHERE id = ? AND state = 'active' AND version = ?
    `).run(reasonCode, oldAfterVersion, createdAt, createdAt, oldBindingId, expectedVersion);
    if (revoked.changes !== 1) fail('STALE_VERSION', '$.command.expected_version', 'Assessment binding version has changed.');
    const bindingId = newId('assessment-binding');
    database.prepare(`
      INSERT INTO assessment_binding (
        id, document_id, candidate_id, job_id, scope, state, identity_basis,
        actor_id, reason_code, request_id, version, created_at, updated_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 1, ?, ?, NULL)
    `).run(
      bindingId, document.id, candidateId, jobId, ARCHIVE_SCOPE, identityBasis,
      actor.actor_id, reasonCode, requestId, createdAt, createdAt,
    );
    const eventId = newId('assessment-event');
    insertEvent(database, actor, {
      id: eventId, object_type: 'binding', object_id: oldBindingId, event_type: 'binding_rebound',
      request_id: requestId, reason_code: reasonCode, before_version: expectedVersion,
      after_version: oldAfterVersion, created_at: createdAt,
    });
    return {
      operation: 'binding_rebound', old_binding_id: oldBindingId, binding_id: bindingId,
      document_id: document.id, candidate_id: candidateId, job_id: jobId,
      state: 'active', version: 1, old_binding_version: oldAfterVersion,
      event_id: eventId, idempotent_replay: false,
    };
  });
}

function supersedeAssessmentDocument({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = requiredCommand(command);
  const documentId = requiredText(input.document_id, '$.command.document_id', 'DOCUMENT_ID_REQUIRED');
  const replacementDocumentId = requiredText(
    input.replacement_document_id, '$.command.replacement_document_id', 'REPLACEMENT_DOCUMENT_ID_REQUIRED',
  );
  if (documentId === replacementDocumentId) {
    fail('REPLACEMENT_DOCUMENT_INVALID', '$.command.replacement_document_id', 'Assessment replacement document is invalid.');
  }
  const expectedVersion = requiredVersion(input.expected_version);
  const replacementExpectedVersion = requiredVersion(input.replacement_expected_version);
  const requestId = requiredRequestId(input.request_id);
  const reasonCode = requiredReasonCode(input.reason_code);

  return runImmediate(database, () => {
    const replay = eventByRequestId(database, requestId);
    if (replay) {
      if (replay.event_type !== 'document_superseded' || replay.object_type !== 'document'
          || replay.object_id !== documentId || replay.reason_code !== reasonCode) idempotencyConflict();
      const replacement = requireDocument(database, replacementDocumentId);
      if (replacement.supersedes_document_id !== documentId) idempotencyConflict();
      const binding = database.prepare(`SELECT id, candidate_id, job_id, version FROM assessment_binding WHERE request_id = ?`).get(requestId);
      return {
        operation: 'document_superseded', document_id: documentId,
        replacement_document_id: replacementDocumentId, binding_id: binding && binding.id,
        version: Number(replay.after_version), replacement_version: Number(replacement.version),
        event_id: replay.id, idempotent_replay: true,
      };
    }
    assertRequestNotOwnedByBinding(database, requestId);
    const current = requireDocument(database, documentId);
    const replacement = requireDocument(database, replacementDocumentId);
    assertDocumentAccessible(current);
    assertDocumentAccessible(replacement);
    assertExpectedVersion(current, expectedVersion);
    assertExpectedVersion(replacement, replacementExpectedVersion, '$.command.replacement_expected_version');
    if (current.content_sha256 === replacement.content_sha256) {
      fail('REPLACEMENT_CONTENT_DUPLICATE', '$.command.replacement_document_id', 'Assessment replacement must contain different bytes.');
    }
    if (current.report_type !== replacement.report_type) {
      fail('REPLACEMENT_REPORT_TYPE_MISMATCH', '$.command.replacement_document_id', 'Assessment replacement report type does not match.');
    }
    if (replacement.supersedes_document_id) {
      fail('REPLACEMENT_ALREADY_LINKED', '$.command.replacement_document_id', 'Assessment replacement already belongs to another version chain.');
    }
    if (database.prepare(`SELECT 1 FROM assessment_binding WHERE document_id = ? AND state IN ('pending', 'active')`).get(replacementDocumentId)) {
      fail('REPLACEMENT_ALREADY_BOUND', '$.command.replacement_document_id', 'Assessment replacement already has a binding.');
    }
    const oldBinding = database.prepare(`
      SELECT id, candidate_id, job_id, identity_basis, version
      FROM assessment_binding WHERE document_id = ? AND state = 'active'
    `).get(documentId);
    if (!oldBinding) {
      fail('ACTIVE_BINDING_REQUIRED', '$.command.document_id', 'An active Assessment binding is required for replacement.');
    }
    if (!candidateBelongsToJob(database, oldBinding.candidate_id, Number(oldBinding.job_id))) {
      fail('CANDIDATE_JOB_MISMATCH', '$.command.document_id', 'Candidate and job context do not match.');
    }

    const createdAt = nowIso();
    const afterVersion = expectedVersion + 1;
    const replacementAfterVersion = replacementExpectedVersion + 1;
    const oldBindingAfterVersion = Number(oldBinding.version) + 1;
    const supersedeBinding = database.prepare(`
      UPDATE assessment_binding
      SET state = 'superseded', reason_code = ?, version = ?, updated_at = ?, revoked_at = ?
      WHERE id = ? AND state = 'active' AND version = ?
    `).run(reasonCode, oldBindingAfterVersion, createdAt, createdAt, oldBinding.id, oldBinding.version);
    if (supersedeBinding.changes !== 1) {
      fail('STALE_VERSION', '$.command.expected_version', 'Assessment binding version has changed.');
    }
    const supersedeCurrent = database.prepare(`
      UPDATE assessment_document
      SET review_state = 'superseded', version = ?, updated_at = ?
      WHERE id = ? AND version = ? AND review_state = 'ready' AND lifecycle_state = 'active'
    `).run(afterVersion, createdAt, documentId, expectedVersion);
    if (supersedeCurrent.changes !== 1) {
      fail('STALE_VERSION', '$.command.expected_version', 'Assessment document version has changed.');
    }
    const linkReplacement = database.prepare(`
      UPDATE assessment_document
      SET supersedes_document_id = ?, version = ?, updated_at = ?
      WHERE id = ? AND version = ? AND review_state = 'ready' AND lifecycle_state = 'active'
        AND supersedes_document_id IS NULL
    `).run(documentId, replacementAfterVersion, createdAt, replacementDocumentId, replacementExpectedVersion);
    if (linkReplacement.changes !== 1) {
      fail('STALE_VERSION', '$.command.replacement_expected_version', 'Assessment replacement version has changed.');
    }
    const bindingId = newId('assessment-binding');
    database.prepare(`
      INSERT INTO assessment_binding (
        id, document_id, candidate_id, job_id, scope, state, identity_basis,
        actor_id, reason_code, request_id, version, created_at, updated_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 1, ?, ?, NULL)
    `).run(
      bindingId, replacementDocumentId, oldBinding.candidate_id, oldBinding.job_id, ARCHIVE_SCOPE,
      oldBinding.identity_basis, actor.actor_id, reasonCode, requestId, createdAt, createdAt,
    );
    const eventId = newId('assessment-event');
    insertEvent(database, actor, {
      id: eventId, object_type: 'document', object_id: documentId, event_type: 'document_superseded',
      request_id: requestId, reason_code: reasonCode, before_version: expectedVersion,
      after_version: afterVersion, created_at: createdAt,
    });
    return {
      operation: 'document_superseded', document_id: documentId,
      replacement_document_id: replacementDocumentId, binding_id: bindingId,
      candidate_id: oldBinding.candidate_id, job_id: Number(oldBinding.job_id),
      version: afterVersion, replacement_version: replacementAfterVersion,
      event_id: eventId, idempotent_replay: false,
    };
  });
}

function normalizeDocumentTransition(command) {
  const input = requiredCommand(command);
  return Object.freeze({
    documentId: requiredText(input.document_id, '$.command.document_id', 'DOCUMENT_ID_REQUIRED'),
    expectedVersion: requiredVersion(input.expected_version),
    requestId: requiredRequestId(input.request_id),
    reasonCode: requiredReasonCode(input.reason_code),
  });
}

function replayDocumentTransition(database, input, eventType, operation) {
  const replay = eventByRequestId(database, input.requestId);
  if (!replay) {
    assertRequestNotOwnedByBinding(database, input.requestId);
    return null;
  }
  if (replay.event_type !== eventType || replay.object_type !== 'document'
      || replay.object_id !== input.documentId || replay.reason_code !== input.reasonCode) {
    idempotencyConflict();
  }
  return {
    operation, document_id: input.documentId, version: Number(replay.after_version),
    policy_version: replay.policy_version, event_id: replay.id, idempotent_replay: true,
  };
}

function openAssessmentDispute({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = normalizeDocumentTransition(command);
  return runImmediate(database, () => {
    const replay = replayDocumentTransition(database, input, 'dispute_opened', 'dispute_opened');
    if (replay) return { ...replay, dispute_state: 'open', lifecycle_state: 'frozen' };
    const document = requireDocument(database, input.documentId);
    assertExpectedVersion(document, input.expectedVersion);
    if (document.lifecycle_state === 'deleted') fail('DOCUMENT_DELETED', '$.command.document_id', 'Assessment document is not available.');
    if (document.dispute_state === 'open') fail('DISPUTE_ALREADY_OPEN', '$.command.document_id', 'Assessment dispute is already open.');
    if (document.lifecycle_state === 'deletion_pending') {
      fail('DOCUMENT_DELETION_PENDING', '$.command.document_id', 'Assessment document is already pending deletion.');
    }
    const createdAt = nowIso();
    const afterVersion = input.expectedVersion + 1;
    const update = database.prepare(`
      UPDATE assessment_document
      SET dispute_state = 'open', lifecycle_state = 'frozen', version = ?, updated_at = ?
      WHERE id = ? AND version = ? AND lifecycle_state IN ('active', 'frozen') AND dispute_state <> 'open'
    `).run(afterVersion, createdAt, input.documentId, input.expectedVersion);
    if (update.changes !== 1) fail('STALE_VERSION', '$.command.expected_version', 'Assessment document version has changed.');
    const eventId = newId('assessment-event');
    insertEvent(database, actor, {
      id: eventId, object_type: 'document', object_id: input.documentId, event_type: 'dispute_opened',
      request_id: input.requestId, reason_code: input.reasonCode, before_version: input.expectedVersion,
      after_version: afterVersion, created_at: createdAt,
    });
    return {
      operation: 'dispute_opened', document_id: input.documentId, dispute_state: 'open',
      lifecycle_state: 'frozen', version: afterVersion, event_id: eventId, idempotent_replay: false,
    };
  });
}

function resolveAssessmentDispute({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = normalizeDocumentTransition(command);
  return runImmediate(database, () => {
    const replay = replayDocumentTransition(database, input, 'dispute_resolved', 'dispute_resolved');
    if (replay) return { ...replay, dispute_state: 'resolved', lifecycle_state: 'active' };
    const document = requireDocument(database, input.documentId);
    assertExpectedVersion(document, input.expectedVersion);
    if (document.dispute_state !== 'open' || document.lifecycle_state !== 'frozen') {
      fail('DISPUTE_NOT_OPEN', '$.command.document_id', 'Assessment dispute is not open.');
    }
    const createdAt = nowIso();
    const afterVersion = input.expectedVersion + 1;
    const update = database.prepare(`
      UPDATE assessment_document
      SET dispute_state = 'resolved', lifecycle_state = 'active', version = ?, updated_at = ?
      WHERE id = ? AND version = ? AND dispute_state = 'open' AND lifecycle_state = 'frozen'
    `).run(afterVersion, createdAt, input.documentId, input.expectedVersion);
    if (update.changes !== 1) fail('STALE_VERSION', '$.command.expected_version', 'Assessment document version has changed.');
    const eventId = newId('assessment-event');
    insertEvent(database, actor, {
      id: eventId, object_type: 'document', object_id: input.documentId, event_type: 'dispute_resolved',
      request_id: input.requestId, reason_code: input.reasonCode, before_version: input.expectedVersion,
      after_version: afterVersion, created_at: createdAt,
    });
    return {
      operation: 'dispute_resolved', document_id: input.documentId, dispute_state: 'resolved',
      lifecycle_state: 'active', version: afterVersion, event_id: eventId, idempotent_replay: false,
    };
  });
}

function changeAssessmentLegalHold({ database, auditContext, command, apply }) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = normalizeDocumentTransition(command);
  const eventType = apply ? 'legal_hold_applied' : 'legal_hold_released';
  const targetState = apply ? 'active' : 'released';
  return runImmediate(database, () => {
    const replay = replayDocumentTransition(database, input, eventType, eventType);
    if (replay) return { ...replay, legal_hold_state: targetState };
    const document = requireDocument(database, input.documentId);
    assertExpectedVersion(document, input.expectedVersion);
    if (document.lifecycle_state === 'deleted') fail('DOCUMENT_DELETED', '$.command.document_id', 'Assessment document is not available.');
    if (apply && document.legal_hold_state === 'active') fail('LEGAL_HOLD_ALREADY_ACTIVE', '$.command.document_id', 'Assessment legal hold is already active.');
    if (!apply && document.legal_hold_state !== 'active') fail('LEGAL_HOLD_NOT_ACTIVE', '$.command.document_id', 'Assessment legal hold is not active.');
    const createdAt = nowIso();
    const afterVersion = input.expectedVersion + 1;
    const update = database.prepare(`
      UPDATE assessment_document SET legal_hold_state = ?, version = ?, updated_at = ?
      WHERE id = ? AND version = ? AND lifecycle_state <> 'deleted'
    `).run(targetState, afterVersion, createdAt, input.documentId, input.expectedVersion);
    if (update.changes !== 1) fail('STALE_VERSION', '$.command.expected_version', 'Assessment document version has changed.');
    const eventId = newId('assessment-event');
    insertEvent(database, actor, {
      id: eventId, object_type: 'document', object_id: input.documentId, event_type: eventType,
      request_id: input.requestId, reason_code: input.reasonCode, before_version: input.expectedVersion,
      after_version: afterVersion, policy_version: document.retention_policy_version, created_at: createdAt,
    });
    return {
      operation: eventType, document_id: input.documentId, legal_hold_state: targetState,
      version: afterVersion, event_id: eventId, idempotent_replay: false,
    };
  });
}

function applyAssessmentLegalHold(options = {}) {
  return changeAssessmentLegalHold({ ...options, apply: true });
}

function releaseAssessmentLegalHold(options = {}) {
  return changeAssessmentLegalHold({ ...options, apply: false });
}

function requestAssessmentDeletion({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const raw = requiredCommand(command);
  const input = normalizeDocumentTransition(raw);
  const policyVersion = optionalPolicyVersion(raw.policy_version);
  if (!policyVersion) fail('RETENTION_POLICY_NOT_CONFIGURED', '$.command.policy_version', 'Assessment deletion is disabled until a retention policy is configured.');
  const effectiveAt = requiredText(raw.effective_at, '$.command.effective_at', 'EFFECTIVE_AT_REQUIRED', 40);
  if (!Number.isFinite(Date.parse(effectiveAt))) fail('EFFECTIVE_AT_INVALID', '$.command.effective_at', 'Assessment deletion time is invalid.');
  return runImmediate(database, () => {
    const document = requireDocument(database, input.documentId);
    if (!document.retention_policy_version) {
      fail('RETENTION_POLICY_NOT_CONFIGURED', '$.command.document_id', 'Assessment deletion is disabled until a retention policy is configured.');
    }
    if (document.retention_policy_version !== policyVersion) {
      fail('RETENTION_POLICY_MISMATCH', '$.command.policy_version', 'Assessment retention policy version does not match.');
    }
    const replay = replayDocumentTransition(database, input, 'delete_requested', 'delete_requested');
    if (replay) return { ...replay, lifecycle_state: 'deletion_pending' };
    assertExpectedVersion(document, input.expectedVersion);
    if (document.lifecycle_state === 'deleted') fail('DOCUMENT_DELETED', '$.command.document_id', 'Assessment document is not available.');
    if (document.legal_hold_state === 'active') fail('LEGAL_HOLD_ACTIVE', '$.command.document_id', 'Assessment deletion is blocked by legal hold.');
    if (document.dispute_state === 'open') fail('DISPUTE_OPEN', '$.command.document_id', 'Assessment deletion is blocked by an open dispute.');
    if (document.lifecycle_state === 'frozen') fail('DOCUMENT_FROZEN', '$.command.document_id', 'Assessment deletion is blocked while the document is frozen.');
    if (!document.delete_after || Date.parse(document.delete_after) > Date.parse(effectiveAt)) {
      fail('RETENTION_NOT_DUE', '$.command.effective_at', 'Assessment retention deadline has not been reached.');
    }
    if (database.prepare("SELECT 1 FROM assessment_binding WHERE document_id = ? AND state = 'active'").get(input.documentId)) {
      fail('ACTIVE_BINDING_EXISTS', '$.command.document_id', 'Assessment deletion is blocked by an active binding.');
    }
    const createdAt = nowIso();
    const afterVersion = input.expectedVersion + 1;
    const update = database.prepare(`
      UPDATE assessment_document
      SET lifecycle_state = 'deletion_pending', version = ?, updated_at = ?
      WHERE id = ? AND version = ? AND lifecycle_state = 'active'
        AND legal_hold_state <> 'active' AND dispute_state <> 'open'
    `).run(afterVersion, createdAt, input.documentId, input.expectedVersion);
    if (update.changes !== 1) fail('STALE_VERSION', '$.command.expected_version', 'Assessment document version has changed.');
    const eventId = newId('assessment-event');
    insertEvent(database, actor, {
      id: eventId, object_type: 'document', object_id: input.documentId, event_type: 'delete_requested',
      request_id: input.requestId, reason_code: input.reasonCode, before_version: input.expectedVersion,
      after_version: afterVersion, policy_version: policyVersion, created_at: createdAt,
    });
    return {
      operation: 'delete_requested', document_id: input.documentId, lifecycle_state: 'deletion_pending',
      version: afterVersion, physical_delete_enabled: true,
      event_id: eventId, idempotent_replay: false,
    };
  });
}

function requirePhysicalDeletionEvidence(
  database,
  input,
  policyVersion,
  effectiveAt,
  deletionRequestId,
  deletionRequestExpectedVersion,
) {
  const evidence = database.prepare(`
    SELECT document_id, expected_version, reason_code, policy_version, effective_at, state
    FROM assessment_deletion_request
    WHERE request_id = ?
  `).get(deletionRequestId);
  if (!evidence || evidence.document_id !== input.documentId
      || Number(evidence.expected_version) !== deletionRequestExpectedVersion
      || evidence.reason_code !== input.reasonCode
      || evidence.policy_version !== policyVersion
      || evidence.effective_at !== effectiveAt
      || !database.prepare(`
        SELECT 1 AS present
        FROM assessment_deletion_request
        WHERE request_id = ?
          AND ((state = 'pending' AND physical_deleted_at IS NOT NULL) OR state = 'completed')
      `).get(deletionRequestId)) {
    fail(
      'PHYSICAL_DELETE_COORDINATOR_REQUIRED',
      '$.command.request_id',
      'Assessment tombstone requires verified completion by the controlled file deletion coordinator.',
    );
  }
}

function tombstoneAssessmentDocumentByPolicy({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const raw = requiredCommand(command);
  const input = normalizeDocumentTransition(raw);
  const deletionRequestId = raw.deletion_request_id === undefined
    ? input.requestId
    : requiredRequestId(raw.deletion_request_id);
  const deletionRequestExpectedVersion = raw.deletion_request_expected_version === undefined
    ? input.expectedVersion
    : requiredVersion(raw.deletion_request_expected_version);
  const policyVersion = optionalPolicyVersion(raw.policy_version);
  if (!policyVersion) fail('RETENTION_POLICY_NOT_CONFIGURED', '$.command.policy_version', 'Assessment physical deletion is disabled.');
  if (raw.physical_delete_confirmed !== true) {
    fail('PHYSICAL_DELETE_CONFIRMATION_REQUIRED', '$.command.physical_delete_confirmed', 'Assessment physical deletion confirmation is required.');
  }
  const effectiveAt = requiredText(raw.effective_at, '$.command.effective_at', 'EFFECTIVE_AT_REQUIRED', 40);
  if (!Number.isFinite(Date.parse(effectiveAt))) fail('EFFECTIVE_AT_INVALID', '$.command.effective_at', 'Assessment deletion time is invalid.');

  return runImmediate(database, () => {
    // A caller-provided boolean is not physical deletion evidence. The
    // coordinator records this state only after the canonical PDF and every
    // derived preview have been verified absent under the controlled root.
    requirePhysicalDeletionEvidence(
      database,
      input,
      policyVersion,
      effectiveAt,
      deletionRequestId,
      deletionRequestExpectedVersion,
    );
    const replay = replayDocumentTransition(database, input, 'deleted_by_policy', 'deleted_by_policy');
    if (replay) {
      if (replay.policy_version && replay.policy_version !== policyVersion) idempotencyConflict();
      return { ...replay, lifecycle_state: 'deleted', tombstone: true };
    }
    const document = requireDocument(database, input.documentId);
    assertExpectedVersion(document, input.expectedVersion);
    if (!document.retention_policy_version) {
      fail('RETENTION_POLICY_NOT_CONFIGURED', '$.command.document_id', 'Assessment physical deletion is disabled.');
    }
    if (document.retention_policy_version !== policyVersion) {
      fail('RETENTION_POLICY_MISMATCH', '$.command.policy_version', 'Assessment retention policy version does not match.');
    }
    if (document.lifecycle_state !== 'deletion_pending') {
      fail('DELETION_REQUEST_REQUIRED', '$.command.document_id', 'Assessment deletion must be requested first.');
    }
    if (document.legal_hold_state === 'active') fail('LEGAL_HOLD_ACTIVE', '$.command.document_id', 'Assessment deletion is blocked by legal hold.');
    if (!document.delete_after || Date.parse(document.delete_after) > Date.parse(effectiveAt)) {
      fail('RETENTION_NOT_DUE', '$.command.effective_at', 'Assessment retention deadline has not been reached.');
    }
    if (database.prepare(`SELECT 1 FROM assessment_binding WHERE document_id = ? AND state = 'active'`).get(input.documentId)) {
      fail('ACTIVE_BINDING_EXISTS', '$.command.document_id', 'Assessment deletion is blocked by an active binding.');
    }
    const afterVersion = input.expectedVersion + 1;
    const update = database.prepare(`
      UPDATE assessment_document
      SET content_sha256 = NULL, storage_relpath = NULL, byte_size = NULL, page_count = NULL,
          mime_detected = NULL, report_type = 'unknown', assessment_date = NULL,
          analysis_status = 'pending', analysis_schema_version = NULL,
          analysis_json = NULL, analysis_error_code = NULL,
          review_state = 'superseded', dispute_state = 'resolved', lifecycle_state = 'deleted',
          version = ?, updated_at = ?, deleted_at = ?
      WHERE id = ? AND version = ? AND lifecycle_state = 'deletion_pending'
        AND legal_hold_state <> 'active'
    `).run(afterVersion, effectiveAt, effectiveAt, input.documentId, input.expectedVersion);
    if (update.changes !== 1) fail('STALE_VERSION', '$.command.expected_version', 'Assessment document version has changed.');
    const eventId = newId('assessment-event');
    insertEvent(database, actor, {
      id: eventId, object_type: 'document', object_id: input.documentId, event_type: 'deleted_by_policy',
      request_id: input.requestId, reason_code: input.reasonCode, before_version: input.expectedVersion,
      after_version: afterVersion, policy_version: policyVersion, created_at: effectiveAt,
    });
    return {
      operation: 'deleted_by_policy', document_id: input.documentId, lifecycle_state: 'deleted',
      tombstone: true, version: afterVersion, event_id: eventId, idempotent_replay: false,
    };
  });
}

function prepareAssessmentExport({ database, auditContext, command } = {}) {
  assertDatabase(database);
  assertAuditContext(auditContext);
  const input = requiredCommand(command);
  const documentId = requiredText(input.document_id, '$.command.document_id', 'DOCUMENT_ID_REQUIRED');
  const document = requireDocument(database, documentId);
  if (!document.retention_policy_version) {
    fail('RETENTION_POLICY_NOT_CONFIGURED', '$.command.document_id', 'Assessment export is disabled.');
  }
  fail('ASSESSMENT_EXPORT_DISABLED', '$.command.document_id', 'Assessment export is not enabled for this foundation service.');
}

const ASSESSMENT_ARCHIVE_ADMIN_SELECT = `
  SELECT binding.id AS binding_id, binding.document_id,
         binding.candidate_id, binding.job_id, binding.scope,
         binding.state AS binding_state, binding.conflict_state,
         binding.version AS binding_version,
         document.report_type, document.assessment_date,
         document.analysis_status, document.analysis_schema_version,
         document.analysis_json, document.analysis_error_code,
         document.security_state, document.review_state, document.dispute_state,
         document.lifecycle_state, document.legal_hold_state,
         document.retention_policy_version, document.delete_after,
         document.version AS document_version,
         (SELECT request_id FROM assessment_deletion_request
          WHERE document_id = document.id AND state IN ('pending', 'retryable_failed')
          ORDER BY created_at DESC LIMIT 1) AS deletion_request_id,
         (SELECT reason_code FROM assessment_deletion_request
          WHERE document_id = document.id AND state IN ('pending', 'retryable_failed')
          ORDER BY created_at DESC LIMIT 1) AS deletion_reason_code,
         (SELECT policy_version FROM assessment_deletion_request
          WHERE document_id = document.id AND state IN ('pending', 'retryable_failed')
          ORDER BY created_at DESC LIMIT 1) AS deletion_policy_version,
         (SELECT effective_at FROM assessment_deletion_request
          WHERE document_id = document.id AND state IN ('pending', 'retryable_failed')
          ORDER BY created_at DESC LIMIT 1) AS deletion_effective_at,
         (SELECT state FROM assessment_deletion_request
          WHERE document_id = document.id AND state IN ('pending', 'retryable_failed')
          ORDER BY created_at DESC LIMIT 1) AS deletion_request_state,
         binding.created_at, binding.updated_at
  FROM assessment_binding binding
  JOIN assessment_document document ON document.id = binding.document_id
`;

function adminArchiveDto(row) {
  let analysis = null;
  if (row.analysis_status === 'ready' && row.analysis_json) {
    try { analysis = JSON.parse(row.analysis_json); } catch { analysis = null; }
  }
  return Object.freeze({
    binding_id: row.binding_id,
    document_id: row.document_id,
    candidate_id: row.candidate_id,
    job_id: Number(row.job_id),
    scope: row.scope,
    binding_state: row.binding_state,
    conflict_state: row.conflict_state,
    binding_version: Number(row.binding_version),
    report_type: row.report_type,
    assessment_date: row.assessment_date,
    analysis_status: analysis ? 'ready' : row.analysis_status,
    analysis_schema_version: row.analysis_schema_version,
    analysis_error_code: row.analysis_error_code,
    analysis,
    security_state: row.security_state,
    review_state: row.review_state,
    dispute_state: row.dispute_state,
    lifecycle_state: row.lifecycle_state,
    legal_hold_state: row.legal_hold_state,
    retention_policy_version: row.retention_policy_version,
    delete_after: row.delete_after,
    document_version: Number(row.document_version),
    deletion_request_id: row.deletion_request_id || null,
    deletion_reason_code: row.deletion_reason_code || null,
    deletion_policy_version: row.deletion_policy_version || null,
    deletion_effective_at: row.deletion_effective_at || null,
    deletion_request_state: row.deletion_request_state || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

function listAssessmentArchives({ database, auditContext, command } = {}) {
  assertDatabase(database);
  assertAuditContext(auditContext);
  const input = requiredCommand(command);
  const candidateId = requiredText(input.candidate_id, '$.command.candidate_id', 'CANDIDATE_ID_REQUIRED');
  const jobId = requiredJobId(input.job_id);
  if (!candidateBelongsToJob(database, candidateId, jobId)) {
    fail('CANDIDATE_JOB_MISMATCH', '$.command.candidate_id', 'Candidate and job context do not match.');
  }
  return database.prepare(`${ASSESSMENT_ARCHIVE_ADMIN_SELECT}
    WHERE binding.candidate_id = ? AND binding.job_id = ? AND binding.scope = ?
    ORDER BY binding.created_at DESC, binding.id DESC
  `).all(candidateId, jobId, ARCHIVE_SCOPE).map(adminArchiveDto);
}

function listAssessmentQueue({ database, auditContext, command } = {}) {
  assertDatabase(database);
  assertAuditContext(auditContext);
  const input = requiredCommand(command);
  const jobId = requiredJobId(input.job_id);
  if (!database.prepare('SELECT 1 FROM job WHERE id = ?').get(jobId)) {
    fail('JOB_NOT_FOUND', '$.command.job_id', 'Assessment job context was not found.');
  }
  return database.prepare(`${ASSESSMENT_ARCHIVE_ADMIN_SELECT}
    WHERE binding.job_id = ? AND binding.scope = ?
      AND binding.state = 'pending'
    ORDER BY binding.created_at, binding.id
  `).all(jobId, ARCHIVE_SCOPE).map(adminArchiveDto);
}

function normalizeViewCommand(command) {
  const input = requiredCommand(command);
  return Object.freeze({
    bindingId: requiredText(input.binding_id, '$.command.binding_id', 'BINDING_ID_REQUIRED'),
    documentId: requiredText(input.document_id, '$.command.document_id', 'DOCUMENT_ID_REQUIRED'),
    candidateId: requiredText(input.candidate_id, '$.command.candidate_id', 'CANDIDATE_ID_REQUIRED'),
    jobId: requiredJobId(input.job_id),
    requestId: requiredRequestId(input.request_id),
  });
}

function resolveViewContext(database, input) {
  const binding = database.prepare(`
    SELECT id, document_id, candidate_id, job_id, scope, state, version
    FROM assessment_binding WHERE id = ?
  `).get(input.bindingId);
  if (!binding || binding.state !== 'active' || binding.scope !== ARCHIVE_SCOPE) {
    fail('ACTIVE_BINDING_REQUIRED', '$.command.binding_id', 'An active Assessment archive binding is required.');
  }
  if (binding.document_id !== input.documentId || binding.candidate_id !== input.candidateId
      || Number(binding.job_id) !== input.jobId) {
    fail('BINDING_CONTEXT_MISMATCH', '$.command.binding_id', 'Assessment binding context does not match.');
  }
  if (!candidateBelongsToJob(database, input.candidateId, input.jobId)) {
    fail('CANDIDATE_JOB_MISMATCH', '$.command.candidate_id', 'Candidate and job context do not match.');
  }
  const document = requireDocument(database, input.documentId);
  assertDocumentAccessible(document);
  return { binding, document };
}

function assertViewReplayMatches(replay, input) {
  if (replay.event_type !== 'viewed' || replay.object_type !== 'binding' || replay.object_id !== input.bindingId) {
    idempotencyConflict();
  }
}

function prepareAssessmentView({ database, auditContext, command } = {}) {
  assertDatabase(database);
  assertAuditContext(auditContext);
  const input = normalizeViewCommand(command);

  return runImmediate(database, () => {
    const replay = eventByRequestId(database, input.requestId);
    if (replay) assertViewReplayMatches(replay, input);
    const { document } = resolveViewContext(database, input);
    return Object.freeze({
      internal_only: true,
      api_dto: false,
      binding_id: input.bindingId,
      document_id: input.documentId,
      storage_relpath: document.storage_relpath,
      content_sha256: document.content_sha256,
      byte_size: Number(document.byte_size),
      page_count: Number(document.page_count),
    });
  });
}

function recordAssessmentViewed({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = normalizeViewCommand(command);

  return runImmediate(database, () => {
    const replay = eventByRequestId(database, input.requestId);
    if (replay) assertViewReplayMatches(replay, input);

    // Recheck after the file layer has opened and verified the prepared file.
    // A freeze, deletion, revoke, or context change between phases fails closed.
    const { binding } = resolveViewContext(database, input);
    if (replay) {
      return {
        operation: 'view_recorded',
        binding_id: input.bindingId,
        document_id: input.documentId,
        candidate_id: input.candidateId,
        job_id: input.jobId,
        authorized: true,
        event_id: replay.id,
        idempotent_replay: true,
      };
    }

    const createdAt = nowIso();
    const eventId = newId('assessment-event');
    insertEvent(database, actor, {
      id: eventId,
      object_type: 'binding',
      object_id: input.bindingId,
      event_type: 'viewed',
      request_id: input.requestId,
      reason_code: 'authorized_archive_view',
      before_version: Number(binding.version),
      after_version: Number(binding.version),
      created_at: createdAt,
    });

    return {
      operation: 'view_recorded',
      binding_id: input.bindingId,
      document_id: input.documentId,
      candidate_id: input.candidateId,
      job_id: input.jobId,
      authorized: true,
      event_id: eventId,
      idempotent_replay: false,
    };
  });
}

module.exports = {
  AssessmentArchiveError,
  applyAssessmentLegalHold,
  bindAssessmentDocument,
  confirmAssessmentBinding,
  confirmAssessmentMetadata,
  createPendingAssessmentBinding,
  listAssessmentArchives,
  listAssessmentQueue,
  openAssessmentDispute,
  prepareAssessmentView,
  prepareAssessmentExport,
  rebindAssessmentDocument,
  recordAssessmentViewed,
  recordAssessmentDocumentIntake,
  releaseAssessmentLegalHold,
  requestAssessmentDeletion,
  resolveAssessmentDispute,
  revokeAssessmentBinding,
  supersedeAssessmentDocument,
  tombstoneAssessmentDocumentByPolicy,
};
