'use strict';

const crypto = require('crypto');
const workflow = require('./workflow-projection');

const ACTOR_CONTRACT = Object.freeze({
  actor_id: 'local-primary-operator',
  actor_type: 'local_os_subject',
  actor_source: 'server_local_instance',
  assurance: 'local_instance_only',
});

const REVIEW_STATUSES = new Set(['draft', 'reopened', 'confirmed', 'superseded']);
const EDITABLE_REVIEW_STATUSES = new Set(['draft', 'reopened']);
const DISPOSITION_ACTIONS = new Set(['continue_process', 'hold', 'reject', 'talent_pool']);
const DISPOSITION_PROJECTION = Object.freeze({
  continue_process: Object.freeze({ code: 'under_review', label: workflow.DISPOSITION_CODE_TO_LABEL.under_review }),
  hold: Object.freeze({ code: 'under_review', label: workflow.DISPOSITION_CODE_TO_LABEL.under_review }),
  reject: Object.freeze({ code: 'rejected', label: workflow.DISPOSITION_CODE_TO_LABEL.rejected }),
  talent_pool: Object.freeze({ code: 'talent_pool', label: workflow.DISPOSITION_CODE_TO_LABEL.talent_pool }),
});
const MAX_REVIEW_JSON_BYTES = 64 * 1024;
const REVIEW_EVIDENCE_TYPES = new Set(['job_profile', 'interview_report', 'assessment_document']);
// Assessment reports may be cited as HR-confirmed evidence. Numeric scoring,
// ranking and automatic-decision language remain forbidden in FinalReview.
const FORBIDDEN_REVIEW_KEY = /(?:score|评分|percentage|百分比|percent|weight|权重|rank|排序|auto(?:hire|reject|decision|action)|自动(?:录用|淘汰|决策|处置))/i;
const FORBIDDEN_REVIEW_TEXT = /(?:得分|评分|百分比|\d+(?:\.\d+)?\s*%|权重|排名|排序|auto(?:matic)?\s*(?:hire|reject|decision|action)|自动(?:录用|淘汰|决策|处置)|建议(?:录用|淘汰))/i;

class FinalReviewError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'FinalReviewError';
    this.code = code;
    this.path = path || '$';
    this.statusCode = ['STALE_VERSION', 'IDEMPOTENCY_CONFLICT', 'CURRENT_REVIEW_CONFLICT', 'JOB_CLOSED'].includes(code) ? 409 : 400;
  }
}

function fail(code, path, message) {
  throw new FinalReviewError(code, path, message);
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('DATABASE_REQUIRED', '$.database', 'F018 database is required.');
  }
}

function requiredCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    fail('COMMAND_REQUIRED', '$.command', 'F018 command is required.');
  }
  return command;
}

function requiredText(value, path, code, maximum = 160) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  if (!text || text.length > maximum || /[\0\r\n]/.test(text)) fail(code, path, 'F018 value is invalid.');
  return text;
}

function requiredId(value, path, code) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) fail(code, path, 'F018 identifier is invalid.');
  return id;
}

function requiredRequestId(value) {
  const requestId = requiredText(value, '$.command.request_id', 'REQUEST_ID_REQUIRED', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) {
    fail('REQUEST_ID_INVALID', '$.command.request_id', 'F018 request id is invalid.');
  }
  return requestId;
}

function requiredReasonCode(value) {
  const reasonCode = requiredText(value, '$.command.reason_code', 'REASON_CODE_REQUIRED', 80);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(reasonCode)) {
    fail('REASON_CODE_INVALID', '$.command.reason_code', 'F018 reason code must be a controlled token.');
  }
  return reasonCode;
}

function requiredVersion(value, { allowZero = false, path = '$.command.expected_version' } = {}) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < (allowZero ? 0 : 1)) {
    fail('EXPECTED_VERSION_REQUIRED', path, 'F018 expected version is invalid.');
  }
  return version;
}

function assertAuditContext(auditContext) {
  if (!auditContext || typeof auditContext !== 'object' || Array.isArray(auditContext)) {
    fail('AUDIT_CONTEXT_REQUIRED', '$.auditContext', 'Server-owned F018 audit context is required.');
  }
  for (const [key, expected] of Object.entries(ACTOR_CONTRACT)) {
    if (auditContext[key] !== expected) {
      fail('AUDIT_CONTEXT_INVALID', `$.auditContext.${key}`, 'Server-owned F018 audit context is invalid.');
    }
  }
  const actorSessionId = requiredText(
    auditContext.actor_session_id,
    '$.auditContext.actor_session_id',
    'AUDIT_CONTEXT_INVALID',
    160,
  );
  return Object.freeze({ ...ACTOR_CONTRACT, actor_session_id: actorSessionId });
}

function nowIso() {
  return new Date().toISOString();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : stableJson(value), 'utf8').digest('hex');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizedEvidenceRef(value, path) {
  if (!isPlainObject(value)) fail('REVIEW_EVIDENCE_INVALID', path, 'FinalReview evidence reference is invalid.');
  const keys = Object.keys(value).sort();
  if (keys.join('|') !== 'source_id|source_type') {
    fail('REVIEW_EVIDENCE_INVALID', path, 'FinalReview evidence reference fields are invalid.');
  }
  const sourceType = requiredText(value.source_type, `${path}.source_type`, 'REVIEW_EVIDENCE_INVALID', 40);
  if (!REVIEW_EVIDENCE_TYPES.has(sourceType)) {
    fail('REVIEW_EVIDENCE_TYPE_FORBIDDEN', `${path}.source_type`, 'FinalReview evidence source is not allowed.');
  }
  const sourceId = sourceType === 'assessment_document'
    ? requiredText(value.source_id, `${path}.source_id`, 'REVIEW_EVIDENCE_INVALID', 160)
    : requiredId(value.source_id, `${path}.source_id`, 'REVIEW_EVIDENCE_INVALID');
  if (sourceType === 'assessment_document' && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(sourceId)) {
    fail('REVIEW_EVIDENCE_INVALID', `${path}.source_id`, 'Assessment evidence identifier is invalid.');
  }
  return Object.freeze({ source_type: sourceType, source_id: sourceId });
}

function inspectReviewValue(value, path, references) {
  if (typeof value === 'string') {
    if (FORBIDDEN_REVIEW_TEXT.test(value.normalize('NFKC'))) {
      fail('FORBIDDEN_REVIEW_CONTENT', path, 'FinalReview text contains forbidden scoring, ranking or automatic-decision content.');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectReviewValue(item, `${path}[${index}]`, references));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (FORBIDDEN_REVIEW_KEY.test(String(key).normalize('NFKC'))) {
      fail('FORBIDDEN_REVIEW_FIELD', childPath, 'FinalReview contains a forbidden scoring, ranking or automatic-decision field.');
    }
    if (key === 'evidence_refs') {
      if (!Array.isArray(child)) fail('REVIEW_EVIDENCE_INVALID', childPath, 'FinalReview evidence_refs must be an array.');
      child.forEach((entry, index) => references.push(normalizedEvidenceRef(entry, `${childPath}[${index}]`)));
    } else if (key === 'source_type') {
      const sourceType = String(child || '').trim();
      if (!REVIEW_EVIDENCE_TYPES.has(sourceType)) {
        fail('REVIEW_EVIDENCE_TYPE_FORBIDDEN', childPath, 'FinalReview evidence source is not allowed.');
      }
      fail('REVIEW_EVIDENCE_INVALID', childPath, 'FinalReview evidence must use an evidence_refs array.');
    } else {
      inspectReviewValue(child, childPath, references);
    }
  }
}

function normalizeReviewJson(input, expectedEvidence) {
  let review;
  try {
    review = typeof input === 'string' ? JSON.parse(input) : input;
  } catch {
    fail('REVIEW_JSON_INVALID', '$.command.review_json', 'FinalReview JSON is invalid.');
  }
  if (!isPlainObject(review) || Object.keys(review).length === 0) {
    fail('REVIEW_JSON_INVALID', '$.command.review_json', 'FinalReview must be a non-empty JSON object.');
  }
  const serialized = stableJson(review);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REVIEW_JSON_BYTES) {
    fail('REVIEW_JSON_TOO_LARGE', '$.command.review_json', 'FinalReview JSON exceeds the size limit.');
  }
  const references = [];
  inspectReviewValue(review, '$.command.review_json', references);
  const expected = new Map([
    ['job_profile', String(expectedEvidence.jobProfileVersionId)],
    ...(expectedEvidence.interviewReportId == null
      ? []
      : [['interview_report', String(expectedEvidence.interviewReportId)]]),
  ]);
  const expectedAssessmentIds = new Set(
    (expectedEvidence.assessmentDocumentIds || []).map((item) => String(item)),
  );
  for (const reference of references) {
    const matches = reference.source_type === 'assessment_document'
      ? expectedAssessmentIds.has(String(reference.source_id))
      : expected.get(reference.source_type) === String(reference.source_id);
    if (!matches) {
      fail('REVIEW_EVIDENCE_MISMATCH', '$.command.review_json.evidence_refs', 'FinalReview evidence does not match its version references.');
    }
  }
  return Object.freeze({ value: review, json: serialized, hash: sha256(serialized), references: Object.freeze(references) });
}

function requireConfirmationEvidence(
  references,
  jobProfileVersionId,
  interviewReportId,
  assessmentDocumentIds = [],
  assessmentRequired = false,
) {
  const present = new Set(references.map((reference) => `${reference.source_type}:${reference.source_id}`));
  if (!present.has(`job_profile:${jobProfileVersionId}`)
      || !present.has(`interview_report:${interviewReportId}`)) {
    fail('REVIEW_EVIDENCE_REQUIRED', '$.command.review_json.evidence_refs', 'FinalReview confirmation requires exact job profile and interview report evidence references.');
  }
  const assessmentPresent = assessmentDocumentIds
    .some((documentId) => present.has(`assessment_document:${documentId}`));
  if (assessmentRequired && !assessmentPresent) {
    fail('ASSESSMENT_EVIDENCE_REQUIRED', '$.command.review_json.evidence_refs', 'This job requires at least one HR-confirmed assessment report before FinalReview confirmation.');
  }
}

function hasHumanReviewContent(value, parentKey = '') {
  if (parentKey === 'evidence_refs') return false;
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.some((item) => hasHumanReviewContent(item, parentKey));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => hasHumanReviewContent(child, key));
}

function applicationRow(database, applicationId) {
  return database.prepare('SELECT * FROM application_episode WHERE id = ?').get(applicationId);
}

function requireApplication(database, applicationId, { requireActive = true } = {}) {
  const row = applicationRow(database, applicationId);
  if (!row) fail('APPLICATION_NOT_FOUND', '$.command.application_id', 'F018 application was not found.');
  if (requireActive && row.status !== 'active') {
    fail('APPLICATION_NOT_ACTIVE', '$.command.application_id', 'F018 application is not active.');
  }
  return row;
}

function requireWritableApplication(database, applicationId) {
  const row = requireApplication(database, applicationId, { requireActive: false });
  assertJobRecruitingWritable(database, row);
  if (row.status !== 'active') {
    fail('APPLICATION_NOT_ACTIVE', '$.command.application_id', 'F018 application is not active.');
  }
  return row;
}

function finalReviewRow(database, reviewId) {
  return database.prepare('SELECT * FROM final_review WHERE id = ?').get(reviewId);
}

function requireFinalReview(database, reviewId) {
  const row = finalReviewRow(database, reviewId);
  if (!row) fail('FINAL_REVIEW_NOT_FOUND', '$.command.final_review_id', 'FinalReview was not found.');
  if (!REVIEW_STATUSES.has(row.status)) fail('FINAL_REVIEW_STATE_INVALID', '$.command.final_review_id', 'FinalReview state is invalid.');
  return row;
}

function requireConfirmedJobProfile(database, application, profileId) {
  const includesConfig = tableColumns(database, 'job_profile_version').has('config_json');
  const row = database.prepare(`
    SELECT id, job_id, version, status, content_hash
           ${includesConfig ? ', config_json' : ''}
    FROM job_profile_version WHERE id = ?
  `).get(profileId);
  if (!row || row.status !== 'confirmed') {
    fail('CONFIRMED_JOB_PROFILE_REQUIRED', '$.command.job_profile_version_id', 'A confirmed job profile version is required.');
  }
  if (Number(row.job_id) !== Number(application.job_id)) {
    fail('JOB_PROFILE_CONTEXT_MISMATCH', '$.command.job_profile_version_id', 'Job profile does not belong to the application job.');
  }
  return row;
}

function assessmentPolicyFromProfile(profile) {
  if (!profile || !profile.config_json) return 'not_required';
  try {
    const value = String(JSON.parse(profile.config_json)?.assessment_policy || '').trim();
    return ['required', 'recommended', 'not_required'].includes(value) ? value : 'not_required';
  } catch {
    return 'not_required';
  }
}

function assessmentDocumentIdsFromReviewJson(reviewJson) {
  let review = reviewJson;
  if (typeof reviewJson === 'string') {
    try { review = JSON.parse(reviewJson); } catch { review = null; }
  }
  const refs = Array.isArray(review?.evidence_refs) ? review.evidence_refs : [];
  return [...new Set(refs
    .filter((item) => item?.source_type === 'assessment_document')
    .map((item) => requiredText(
      item.source_id,
      '$.command.review_json.evidence_refs',
      'REVIEW_EVIDENCE_INVALID',
      160,
    )))].sort();
}

function normalizedAssessmentDocumentIds(value, current) {
  if (value === undefined) return assessmentDocumentIdsFromReviewJson(current?.review_json);
  if (!Array.isArray(value)) {
    fail('ASSESSMENT_EVIDENCE_INVALID', '$.command.assessment_document_ids', 'Assessment evidence ids must be an array.');
  }
  return [...new Set(value.map((item, index) => {
    const id = requiredText(
      item,
      `$.command.assessment_document_ids[${index}]`,
      'ASSESSMENT_EVIDENCE_INVALID',
      160,
    );
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)) {
      fail('ASSESSMENT_EVIDENCE_INVALID', `$.command.assessment_document_ids[${index}]`, 'Assessment evidence identifier is invalid.');
    }
    return id;
  }))].sort();
}

function assessmentTablesAvailable(database) {
  const rows = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('assessment_document', 'assessment_binding')
  `).all();
  return rows.length === 2;
}

function requireAssessmentDocuments(database, application, documentIds, { required = false } = {}) {
  const ids = Array.isArray(documentIds) ? documentIds : [];
  if (!assessmentTablesAvailable(database)) {
    if (required || ids.length) {
      fail('ASSESSMENT_EVIDENCE_REQUIRED', '$.command.assessment_document_ids', 'Assessment evidence is required but the local assessment archive is unavailable.');
    }
    return [];
  }
  const documents = ids.map((documentId) => {
    const row = database.prepare(`
      SELECT document.id, document.content_sha256, document.version,
             document.report_type, document.analysis_status
      FROM assessment_document document
      JOIN assessment_binding binding ON binding.document_id = document.id
      WHERE document.id = ?
        AND binding.candidate_id = ?
        AND binding.job_id = ?
        AND binding.state = 'active'
        AND document.security_state = 'accepted'
        AND document.review_state = 'ready'
        AND document.report_type <> 'unknown'
        AND document.lifecycle_state = 'active'
      LIMIT 1
    `).get(documentId, application.candidate_id, application.job_id);
    if (!row) {
      fail('ASSESSMENT_EVIDENCE_INVALID', '$.command.assessment_document_ids', 'Assessment evidence is not an active HR-confirmed report for this candidate and job.');
    }
    return row;
  });
  if (required && documents.length === 0) {
    fail('ASSESSMENT_EVIDENCE_REQUIRED', '$.command.assessment_document_ids', 'This job requires at least one active HR-confirmed assessment report before FinalReview confirmation.');
  }
  return documents;
}

function requireConfirmedInterviewReport(database, application, reportId, { optional = false } = {}) {
  if (reportId === undefined || reportId === null || reportId === '') {
    if (optional) return null;
    fail('CONFIRMED_INTERVIEW_REPORT_REQUIRED', '$.command.interview_report_id', 'A confirmed interview report is required.');
  }
  const hasProjection = Boolean(database.prepare(`
    SELECT 1 AS present FROM sqlite_master
    WHERE type = 'table' AND name = 'interview_report_confirmed_projection'
  `).get());
  const row = database.prepare(`
    SELECT report.id, report.status, report.content_hash, report.version,
           session.candidate_id, session.job_id
           ${hasProjection ? `,
           projection.content_hash AS confirmed_projection_hash,
           projection.source_report_version` : ''}
    FROM interview_report_v1 report
    JOIN interview_session session ON session.id = report.session_id
    ${hasProjection ? `
    LEFT JOIN interview_report_confirmed_projection projection
      ON projection.report_id = report.id` : ''}
    WHERE report.id = ?
  `).get(reportId);
  if (!row || row.status !== 'confirmed') {
    fail('CONFIRMED_INTERVIEW_REPORT_REQUIRED', '$.command.interview_report_id', 'A confirmed interview report is required.');
  }
  if (row.candidate_id !== application.candidate_id || Number(row.job_id) !== Number(application.job_id)) {
    fail('INTERVIEW_REPORT_CONTEXT_MISMATCH', '$.command.interview_report_id', 'Interview report does not belong to the application context.');
  }
  return row;
}

function ensureCandidateContext(database, application) {
  const candidate = database.prepare(`
    SELECT internal_id, job_id, disposition_status, disposition_code, workflow_version
    FROM candidate WHERE internal_id = ?
  `).get(application.candidate_id);
  if (!candidate || Number(candidate.job_id) !== Number(application.job_id)) {
    fail('CANDIDATE_JOB_MISMATCH', '$.command.application_id', 'Candidate and application job do not match.');
  }
  return candidate;
}

function assertCandidateNotHired(candidate, path = '$.command.application_id') {
  const dispositionCode = workflow.dispositionCode(candidate.disposition_code, candidate.disposition_status);
  if (dispositionCode === 'hired') {
    fail('HIRED_FORBIDDEN', path, 'F018 cannot modify a hired candidate.');
  }
}

function assertJobRecruitingWritable(database, application) {
  const job = database.prepare('SELECT id, status FROM job WHERE id = ?').get(application.job_id);
  if (!job) fail('JOB_NOT_FOUND', '$.command.application_id', 'F018 application job was not found.');
  if (job.status === 'closed') {
    fail('JOB_CLOSED', '$.command.application_id', 'The job is closed; reopen it before continuing F018 recruiting work.');
  }
  return job;
}

function requireCandidateWriteContext(database, application) {
  const candidate = ensureCandidateContext(database, application);
  assertCandidateNotHired(candidate);
  return candidate;
}

function eventByRequestId(database, requestId) {
  return database.prepare('SELECT * FROM application_event WHERE request_id = ?').get(requestId);
}

function replayReviewEvent(database, input) {
  const event = eventByRequestId(database, input.requestId);
  if (!event) return null;
  if (Number(event.application_id) !== Number(input.applicationId) || event.event_type !== input.eventType
      || event.object_type !== input.objectType || event.request_hash !== input.payloadHash) {
    fail('IDEMPOTENCY_CONFLICT', '$.command.request_id', 'F018 request id belongs to another operation or payload.');
  }
  const row = input.objectType === 'final_review'
    ? finalReviewRow(database, event.object_id)
    : database.prepare('SELECT * FROM final_disposition WHERE id = ?').get(event.object_id);
  if (!row) fail('IDEMPOTENCY_STATE_INVALID', '$.command.request_id', 'F018 idempotent result is unavailable.');
  return { row, event, idempotent_replay: true };
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name));
}

function insertKnownColumns(database, table, values) {
  const columns = tableColumns(database, table);
  const names = Object.keys(values).filter((name) => columns.has(name) && values[name] !== undefined);
  if (!names.length) fail('F018_SCHEMA_INCOMPATIBLE', '$.database', `F018 ${table} schema is incompatible.`);
  const placeholders = names.map((name) => `@${name}`);
  const info = database.prepare(`INSERT INTO ${table} (${names.join(', ')}) VALUES (${placeholders.join(', ')})`).run(values);
  return values.id === undefined ? Number(info.lastInsertRowid) : values.id;
}

function insertApplicationEvent(database, actor, input) {
  return insertKnownColumns(database, 'application_event', {
    application_id: input.applicationId,
    object_type: input.objectType,
    object_id: input.objectId,
    event_type: input.eventType,
    actor_id: actor.actor_id,
    request_id: input.requestId,
    request_hash: input.payloadHash,
    reason_code: input.reasonCode,
    before_status: input.beforeStatus,
    after_status: input.afterStatus,
    before_version: input.beforeVersion,
    after_version: input.afterVersion,
    related_object_type: input.relatedObjectType,
    related_object_id: input.relatedObjectId,
    occurred_at: input.createdAt,
  });
}

function publicReview(row, options = {}) {
  let review = null;
  try { review = JSON.parse(row.review_json); } catch {}
  return Object.freeze({
    id: row.id,
    application_id: row.application_id,
    job_profile_version_id: row.job_profile_version_id,
    interview_report_id: row.interview_report_id,
    interview_report_ref_id: row.interview_report_ref_id,
    interview_report_content_hash: row.interview_report_content_hash,
    interview_report_version: row.interview_report_version == null ? null : Number(row.interview_report_version),
    status: row.status,
    review,
    version: Number(row.version),
    reopened_from_final_review_id: row.reopened_from_final_review_id,
    reopen_reason: row.reopen_reason,
    created_by: row.created_by,
    updated_by: row.updated_by,
    confirmed_by: row.confirmed_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    confirmed_at: row.confirmed_at,
    superseded_at: row.superseded_at,
    superseded_by_final_review_id: row.superseded_by_final_review_id,
    read_only: !EDITABLE_REVIEW_STATUSES.has(row.status),
    idempotent_replay: options.idempotentReplay === true,
  });
}

function assertCurrentReviewAvailable(database, applicationId) {
  const current = database.prepare(`
    SELECT id, status FROM final_review
    WHERE application_id = ? AND status IN ('draft', 'reopened', 'confirmed')
    LIMIT 1
  `).get(applicationId);
  if (current) fail('CURRENT_REVIEW_CONFLICT', '$.command.application_id', 'Application already has a current FinalReview.');
}

function reviewEvidenceFromCommand(command, current) {
  const jobProfileVersionId = command.job_profile_version_id === undefined
    ? current && current.job_profile_version_id
    : command.job_profile_version_id;
  const interviewReportId = command.interview_report_id === undefined
    ? current && current.interview_report_id
    : command.interview_report_id;
  const assessmentDocumentIds = normalizedAssessmentDocumentIds(
    command.assessment_document_ids,
    current,
  );
  return {
    jobProfileVersionId: requiredId(
      jobProfileVersionId,
      '$.command.job_profile_version_id',
      'JOB_PROFILE_VERSION_REQUIRED',
    ),
    interviewReportId: interviewReportId === undefined || interviewReportId === null || interviewReportId === ''
      ? null
      : requiredId(interviewReportId, '$.command.interview_report_id', 'INTERVIEW_REPORT_ID_INVALID'),
    assessmentDocumentIds,
  };
}

function createFinalReview({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = requiredCommand(command);
  const applicationId = requiredId(input.application_id, '$.command.application_id', 'APPLICATION_ID_REQUIRED');
  const requestId = requiredRequestId(input.request_id);
  const expectedVersion = requiredVersion(input.expected_version, { allowZero: true });
  if (expectedVersion !== 0) fail('STALE_VERSION', '$.command.expected_version', 'A new FinalReview must start at version zero.');
  const evidence = reviewEvidenceFromCommand(input, null);
  const normalized = normalizeReviewJson(input.review_json, evidence);
  const payloadHash = sha256({ action: 'create', applicationId, expectedVersion, evidence, contentHash: normalized.hash });
  return database.transaction(() => {
    const replay = replayReviewEvent(database, {
      requestId, applicationId, eventType: 'review_drafted', objectType: 'final_review', payloadHash,
    });
    if (replay) return publicReview(replay.row, { idempotentReplay: true });
    const application = requireWritableApplication(database, applicationId);
    requireCandidateWriteContext(database, application);
    requireConfirmedJobProfile(database, application, evidence.jobProfileVersionId);
    requireAssessmentDocuments(database, application, evidence.assessmentDocumentIds);
    const interviewReport = requireConfirmedInterviewReport(
      database,
      application,
      evidence.interviewReportId,
      { optional: true },
    );
    assertCurrentReviewAvailable(database, applicationId);
    const timestamp = nowIso();
    const reviewId = insertKnownColumns(database, 'final_review', {
      application_id: applicationId,
      job_profile_version_id: evidence.jobProfileVersionId,
      interview_report_id: evidence.interviewReportId,
      interview_report_ref_id: interviewReport && interviewReport.id,
      interview_report_content_hash: interviewReport && interviewReport.content_hash,
      interview_report_version: interviewReport && interviewReport.version,
      status: 'draft',
      review_json: normalized.json,
      content_hash: normalized.hash,
      version: 1,
      reopened_from_final_review_id: null,
      reopen_reason: null,
      created_by: actor.actor_id,
      updated_by: actor.actor_id,
      confirmed_by: null,
      created_at: timestamp,
      updated_at: timestamp,
      confirmed_at: null,
      superseded_at: null,
      superseded_by_final_review_id: null,
    });
    insertApplicationEvent(database, actor, {
      applicationId, objectType: 'final_review', objectId: reviewId,
      eventType: 'review_drafted', requestId, payloadHash, reasonCode: 'review_drafted',
      beforeStatus: null, afterStatus: 'draft',
      beforeVersion: null, afterVersion: 1, createdAt: timestamp,
    });
    return publicReview(requireFinalReview(database, reviewId));
  }).immediate();
}

function updateFinalReview({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = requiredCommand(command);
  const reviewId = requiredId(input.final_review_id, '$.command.final_review_id', 'FINAL_REVIEW_ID_REQUIRED');
  const applicationId = requiredId(input.application_id, '$.command.application_id', 'APPLICATION_ID_REQUIRED');
  const requestId = requiredRequestId(input.request_id);
  const expectedVersion = requiredVersion(input.expected_version);
  const preliminary = requireFinalReview(database, reviewId);
  const evidence = reviewEvidenceFromCommand(input, preliminary);
  const normalized = normalizeReviewJson(input.review_json, evidence);
  const payloadHash = sha256({ action: 'update', applicationId, reviewId, expectedVersion, evidence, contentHash: normalized.hash });
  return database.transaction(() => {
    const replay = replayReviewEvent(database, {
      requestId, applicationId, eventType: 'review_updated', objectType: 'final_review', payloadHash,
    });
    if (replay) return publicReview(replay.row, { idempotentReplay: true });
    const application = requireWritableApplication(database, applicationId);
    requireCandidateWriteContext(database, application);
    const current = requireFinalReview(database, reviewId);
    if (current.application_id !== applicationId) fail('FINAL_REVIEW_CONTEXT_MISMATCH', '$.command.final_review_id', 'FinalReview does not belong to the application.');
    if (!EDITABLE_REVIEW_STATUSES.has(current.status)) fail('FINAL_REVIEW_IMMUTABLE', '$.command.final_review_id', 'Confirmed or superseded FinalReview is immutable.');
    if (Number(current.version) !== expectedVersion) fail('STALE_VERSION', '$.command.expected_version', 'FinalReview version has changed.');
    requireConfirmedJobProfile(database, application, evidence.jobProfileVersionId);
    requireAssessmentDocuments(database, application, evidence.assessmentDocumentIds);
    const interviewReport = requireConfirmedInterviewReport(
      database,
      application,
      evidence.interviewReportId,
      { optional: true },
    );
    const timestamp = nowIso();
    const version = expectedVersion + 1;
    const update = database.prepare(`
      UPDATE final_review
      SET job_profile_version_id = ?, interview_report_id = ?,
          interview_report_ref_id = ?, interview_report_content_hash = ?, interview_report_version = ?,
          review_json = ?, content_hash = ?, version = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND application_id = ? AND version = ? AND status IN ('draft', 'reopened')
    `).run(
      evidence.jobProfileVersionId, evidence.interviewReportId,
      interviewReport && interviewReport.id,
      interviewReport && interviewReport.content_hash,
      interviewReport && interviewReport.version,
      normalized.json, normalized.hash,
      version, actor.actor_id, timestamp, reviewId, applicationId, expectedVersion,
    );
    if (update.changes !== 1) fail('STALE_VERSION', '$.command.expected_version', 'FinalReview version has changed.');
    insertApplicationEvent(database, actor, {
      applicationId, objectType: 'final_review', objectId: reviewId,
      eventType: 'review_updated', requestId, payloadHash, reasonCode: 'review_updated',
      beforeStatus: current.status, afterStatus: current.status,
      beforeVersion: expectedVersion, afterVersion: version, createdAt: timestamp,
    });
    return publicReview(requireFinalReview(database, reviewId));
  }).immediate();
}

function confirmFinalReview({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = requiredCommand(command);
  if (input.confirmed !== true) fail('EXPLICIT_CONFIRM_REQUIRED', '$.command.confirmed', 'FinalReview confirmation must be explicit.');
  const reviewId = requiredId(input.final_review_id, '$.command.final_review_id', 'FINAL_REVIEW_ID_REQUIRED');
  const applicationId = requiredId(input.application_id, '$.command.application_id', 'APPLICATION_ID_REQUIRED');
  const requestId = requiredRequestId(input.request_id);
  const expectedVersion = requiredVersion(input.expected_version);
  const payloadHash = sha256({ action: 'confirm', applicationId, reviewId, expectedVersion });
  return database.transaction(() => {
    const replay = replayReviewEvent(database, {
      requestId, applicationId, eventType: 'review_confirmed', objectType: 'final_review', payloadHash,
    });
    if (replay) return publicReview(replay.row, { idempotentReplay: true });
    const application = requireWritableApplication(database, applicationId);
    requireCandidateWriteContext(database, application);
    const current = requireFinalReview(database, reviewId);
    if (current.application_id !== applicationId) fail('FINAL_REVIEW_CONTEXT_MISMATCH', '$.command.final_review_id', 'FinalReview does not belong to the application.');
    if (!EDITABLE_REVIEW_STATUSES.has(current.status)) fail('FINAL_REVIEW_IMMUTABLE', '$.command.final_review_id', 'FinalReview is not confirmable.');
    if (Number(current.version) !== expectedVersion) fail('STALE_VERSION', '$.command.expected_version', 'FinalReview version has changed.');
    if (sha256(current.review_json) !== current.content_hash) fail('FINAL_REVIEW_HASH_MISMATCH', '$.command.final_review_id', 'FinalReview content integrity check failed.');
    let currentReview;
    try { currentReview = JSON.parse(current.review_json); } catch { currentReview = null; }
    if (!hasHumanReviewContent(currentReview)) {
      fail('FINAL_REVIEW_CONTENT_REQUIRED', '$.command.final_review_id', 'FinalReview confirmation requires human-authored review content.');
    }
    const confirmedProfile = requireConfirmedJobProfile(database, application, current.job_profile_version_id);
    const interviewReport = requireConfirmedInterviewReport(database, application, current.interview_report_id);
    const assessmentDocumentIds = assessmentDocumentIdsFromReviewJson(currentReview);
    const assessmentRequired = assessmentPolicyFromProfile(confirmedProfile) === 'required';
    requireAssessmentDocuments(database, application, assessmentDocumentIds, {
      required: assessmentRequired,
    });
    const normalizedCurrent = normalizeReviewJson(currentReview, {
      jobProfileVersionId: current.job_profile_version_id,
      interviewReportId: current.interview_report_id,
      assessmentDocumentIds,
    });
    requireConfirmationEvidence(
      normalizedCurrent.references,
      current.job_profile_version_id,
      current.interview_report_id,
      assessmentDocumentIds,
      assessmentRequired,
    );
    if (Number(current.interview_report_ref_id) !== Number(interviewReport.id)
        || current.interview_report_content_hash !== interviewReport.content_hash
        || Number(current.interview_report_version) !== Number(interviewReport.version)) {
      fail('INTERVIEW_REPORT_SNAPSHOT_MISMATCH', '$.command.interview_report_id', 'FinalReview interview report snapshot has changed.');
    }
    const timestamp = nowIso();
    const version = expectedVersion + 1;
    const update = database.prepare(`
      UPDATE final_review
      SET status = 'confirmed', version = ?, updated_by = ?, confirmed_by = ?, confirmed_at = ?, updated_at = ?
      WHERE id = ? AND application_id = ? AND version = ? AND status IN ('draft', 'reopened')
    `).run(version, actor.actor_id, actor.actor_id, timestamp, timestamp, reviewId, applicationId, expectedVersion);
    if (update.changes !== 1) fail('STALE_VERSION', '$.command.expected_version', 'FinalReview version has changed.');
    insertApplicationEvent(database, actor, {
      applicationId, objectType: 'final_review', objectId: reviewId,
      eventType: 'review_confirmed', requestId, payloadHash, reasonCode: 'review_confirmed',
      beforeStatus: current.status, afterStatus: 'confirmed',
      beforeVersion: expectedVersion, afterVersion: version, createdAt: timestamp,
    });
    return publicReview(requireFinalReview(database, reviewId));
  }).immediate();
}

function reopenFinalReview({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = requiredCommand(command);
  if (input.reopened !== true) fail('EXPLICIT_REOPEN_REQUIRED', '$.command.reopened', 'FinalReview reopen must be explicit.');
  const reviewId = requiredId(input.final_review_id, '$.command.final_review_id', 'FINAL_REVIEW_ID_REQUIRED');
  const applicationId = requiredId(input.application_id, '$.command.application_id', 'APPLICATION_ID_REQUIRED');
  const requestId = requiredRequestId(input.request_id);
  const reasonCode = requiredReasonCode(input.reason_code);
  const expectedVersion = requiredVersion(input.expected_version);
  const payloadHash = sha256({ action: 'reopen', applicationId, reviewId, expectedVersion, reasonCode });
  return database.transaction(() => {
    const replay = replayReviewEvent(database, {
      requestId, applicationId, eventType: 'review_reopened', objectType: 'final_review', payloadHash,
    });
    if (replay) return publicReview(replay.row, { idempotentReplay: true });
    const application = requireWritableApplication(database, applicationId);
    requireCandidateWriteContext(database, application);
    const current = requireFinalReview(database, reviewId);
    if (current.application_id !== applicationId) fail('FINAL_REVIEW_CONTEXT_MISMATCH', '$.command.final_review_id', 'FinalReview does not belong to the application.');
    if (current.status !== 'confirmed') fail('FINAL_REVIEW_NOT_CONFIRMED', '$.command.final_review_id', 'Only a confirmed FinalReview can be reopened.');
    if (database.prepare('SELECT 1 FROM final_disposition WHERE final_review_id = ?').get(reviewId)) {
      fail('DISPOSITION_REVERSAL_NOT_IMPLEMENTED', '$.command.final_review_id', 'A recorded disposition must be reversed by a separately governed workflow before reopening FinalReview.');
    }
    if (Number(current.version) !== expectedVersion) fail('STALE_VERSION', '$.command.expected_version', 'FinalReview version has changed.');
    if (sha256(current.review_json) !== current.content_hash) fail('FINAL_REVIEW_HASH_MISMATCH', '$.command.final_review_id', 'FinalReview content integrity check failed.');
    const timestamp = nowIso();
    const oldVersion = expectedVersion + 1;
    const reopenedId = insertKnownColumns(database, 'final_review', {
      application_id: applicationId,
      job_profile_version_id: current.job_profile_version_id,
      interview_report_id: current.interview_report_id,
      interview_report_ref_id: current.interview_report_ref_id,
      interview_report_content_hash: current.interview_report_content_hash,
      interview_report_version: current.interview_report_version,
      status: 'reopened',
      review_json: current.review_json,
      content_hash: current.content_hash,
      version: 1,
      reopened_from_final_review_id: reviewId,
      reopen_reason: reasonCode,
      created_by: actor.actor_id,
      updated_by: actor.actor_id,
      confirmed_by: null,
      created_at: timestamp,
      updated_at: timestamp,
      confirmed_at: null,
      superseded_at: null,
      superseded_by_final_review_id: null,
    });
    const supersede = database.prepare(`
      UPDATE final_review
      SET status = 'superseded', version = ?, updated_by = ?, updated_at = ?,
          superseded_by_final_review_id = ?, superseded_at = ?
      WHERE id = ? AND application_id = ? AND version = ? AND status = 'confirmed'
    `).run(oldVersion, actor.actor_id, timestamp, reopenedId, timestamp, reviewId, applicationId, expectedVersion);
    if (supersede.changes !== 1) fail('STALE_VERSION', '$.command.expected_version', 'FinalReview version has changed.');
    insertApplicationEvent(database, actor, {
      applicationId, objectType: 'final_review', objectId: reopenedId,
      eventType: 'review_reopened', requestId, payloadHash, reasonCode,
      beforeStatus: 'confirmed', afterStatus: 'reopened',
      beforeVersion: expectedVersion, afterVersion: 1, createdAt: timestamp,
      relatedObjectType: 'final_review', relatedObjectId: reviewId,
    });
    return publicReview(requireFinalReview(database, reopenedId));
  }).immediate();
}

function publicDisposition(row, options = {}) {
  return Object.freeze({
    id: row.id,
    application_id: row.application_id,
    final_review_id: row.final_review_id,
    action: row.action,
    reason_code: row.reason_code,
    actor_id: row.actor_id,
    request_id: row.request_id,
    created_at: row.created_at,
    idempotent_replay: options.idempotentReplay === true,
  });
}

function recordFinalDisposition({ database, auditContext, command } = {}) {
  assertDatabase(database);
  const actor = assertAuditContext(auditContext);
  const input = requiredCommand(command);
  if (input.confirmed !== true) fail('EXPLICIT_CONFIRM_REQUIRED', '$.command.confirmed', 'Final disposition must be an explicit second action.');
  const applicationId = requiredId(input.application_id, '$.command.application_id', 'APPLICATION_ID_REQUIRED');
  const reviewId = requiredId(input.final_review_id, '$.command.final_review_id', 'FINAL_REVIEW_ID_REQUIRED');
  const requestId = requiredRequestId(input.request_id);
  const reasonCode = requiredReasonCode(input.reason_code);
  const expectedVersion = requiredVersion(input.expected_version);
  const action = requiredText(input.action, '$.command.action', 'DISPOSITION_ACTION_REQUIRED', 40);
  if (action === 'hired' || !DISPOSITION_ACTIONS.has(action)) {
    fail(action === 'hired' ? 'HIRED_FORBIDDEN' : 'DISPOSITION_ACTION_INVALID', '$.command.action', 'Final disposition action is not allowed.');
  }
  const payloadHash = sha256({ action: 'disposition', applicationId, reviewId, expectedVersion, disposition: action, reasonCode });
  return database.transaction(() => {
    const replay = replayReviewEvent(database, {
      requestId, applicationId, eventType: 'disposition_recorded', objectType: 'disposition', payloadHash,
    });
    if (replay) return publicDisposition(replay.row, { idempotentReplay: true });
    const application = requireWritableApplication(database, applicationId);
    if (Number(application.version) !== expectedVersion) fail('STALE_VERSION', '$.command.expected_version', 'Application version has changed.');
    const candidate = requireCandidateWriteContext(database, application);
    const currentDispositionCode = workflow.dispositionCode(candidate.disposition_code, candidate.disposition_status);
    const review = requireFinalReview(database, reviewId);
    if (review.application_id !== applicationId || review.status !== 'confirmed') {
      fail('CONFIRMED_FINAL_REVIEW_REQUIRED', '$.command.final_review_id', 'Disposition requires the current confirmed FinalReview.');
    }
    if (database.prepare('SELECT 1 FROM final_disposition WHERE final_review_id = ?').get(reviewId)) {
      fail('FINAL_DISPOSITION_ALREADY_RECORDED', '$.command.final_review_id', 'FinalReview already has a disposition.');
    }
    const timestamp = nowIso();
    const closesApplication = action === 'reject' || action === 'talent_pool';
    const applicationAfterStatus = closesApplication ? 'closed' : 'active';
    const dispositionId = insertKnownColumns(database, 'final_disposition', {
      application_id: applicationId,
      final_review_id: reviewId,
      action,
      reason_code: reasonCode,
      actor_id: actor.actor_id,
      actor_type: actor.actor_type,
      actor_source: actor.actor_source,
      actor_session_id: actor.actor_session_id,
      actor_assurance: actor.assurance,
      request_id: requestId,
      request_hash: payloadHash,
      application_before_version: expectedVersion,
      application_after_version: expectedVersion + 1,
      created_at: timestamp,
    });
    const applicationUpdate = database.prepare(`
      UPDATE application_episode
      SET disposition_action = ?, status = ?, ended_by = ?, ended_at = ?,
          version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND status = 'active'
    `).run(
      action,
      applicationAfterStatus,
      closesApplication ? actor.actor_id : null,
      closesApplication ? timestamp : null,
      timestamp,
      applicationId,
      expectedVersion,
    );
    if (applicationUpdate.changes !== 1) fail('STALE_VERSION', '$.command.expected_version', 'Application version has changed.');
    const projection = DISPOSITION_PROJECTION[action];
    const fromCode = currentDispositionCode;
    const fromStatus = candidate.disposition_status || null;
    const candidateUpdate = database.prepare(`
      UPDATE candidate
      SET disposition_status = ?, disposition_code = ?, workflow_version = workflow_version + 1, updated_at = ?
      WHERE internal_id = ? AND job_id = ? AND COALESCE(disposition_code, '') <> 'hired'
    `).run(projection.label, projection.code, timestamp, application.candidate_id, application.job_id);
    if (candidateUpdate.changes !== 1) fail('CANDIDATE_JOB_MISMATCH', '$.command.application_id', 'Candidate disposition projection could not be updated.');
    database.prepare(`
      INSERT INTO status_history (
        candidate_id, layer, from_status, to_status, source, who, reason,
        from_code, to_code, created_at
      ) VALUES (?, 'disposition', ?, ?, 'f018_final_disposition', ?, ?, ?, ?, ?)
    `).run(
      application.candidate_id, fromStatus, projection.label, actor.actor_id,
      reasonCode, fromCode, projection.code, timestamp,
    );
    insertApplicationEvent(database, actor, {
      applicationId, objectType: 'disposition', objectId: dispositionId,
      eventType: 'disposition_recorded', requestId, payloadHash, reasonCode,
      beforeStatus: application.status, afterStatus: applicationAfterStatus,
      beforeVersion: expectedVersion, afterVersion: expectedVersion + 1, createdAt: timestamp,
      relatedObjectType: 'final_review', relatedObjectId: reviewId,
    });
    return publicDisposition(database.prepare('SELECT * FROM final_disposition WHERE id = ?').get(dispositionId));
  }).immediate();
}

module.exports = {
  ACTOR_CONTRACT,
  DISPOSITION_ACTIONS,
  FinalReviewError,
  MAX_REVIEW_JSON_BYTES,
  confirmFinalReview,
  createFinalReview,
  recordDisposition: recordFinalDisposition,
  recordFinalDisposition,
  reopenFinalReview,
  updateFinalReview,
};
