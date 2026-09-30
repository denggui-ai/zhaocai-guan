'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const archive = require('./assessment-archive-service');
const { importAssessmentPdf } = require('./assessment-controlled-store');
const { ANALYSIS_SCHEMA_VERSION, analyzeAssessmentReportPdf, analyzeAssessmentReportText } = require('./assessment-report-analysis');
const {
  executeAssessmentPhysicalDeletion,
  requestAssessmentPhysicalDeletion,
} = require('./assessment-physical-delete');
const { readAssessmentRasterPage } = require('./assessment-raster-preview');
const { consumeAssessmentFileSelection } = require('./assessment-file-selection');
const ratingLlm = require('./rating-llm');
const { describeExternalAiAuthorization } = require('./external-ai-authorization');
const {
  ASSESSMENT_AI_PURPOSE,
  ASSESSMENT_AI_SCHEMA_VERSION,
  buildAssessmentAiInput,
  parseAssessmentAiReply,
} = require('./assessment-ai-analysis');
const { assessmentAiRankingEligible } = require('./assessment-fit-ranking');
const { recognizeImageFiles } = require('./local-document-ocr');

const PREVIEW_TTL_MS = 5 * 60 * 1000;
const RETENTION_DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_POLICY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ASSESSMENT_AI_RECORD_VERSION = 'assessment_ai_analysis_record_v1';
const ASSESSMENT_AI_READINESS_CODES = new Set([
  'ASSESSMENT_AI_JOB_CLOSED',
  'ASSESSMENT_AI_ACTIVE_JD_REQUIRED',
  'ASSESSMENT_AI_CURRENT_PROFILE_REQUIRED',
  'ASSESSMENT_AI_CONFIRMED_REPORT_REQUIRED',
]);

class AssessmentProductError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'AssessmentProductError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode = 400) {
  throw new AssessmentProductError(code, message, statusCode);
}

function normalizeAssessmentRetentionPolicy(input) {
  if (!input) return null;
  const version = String(input.version || input.policyVersion || '').trim();
  const days = Number(input.days || input.retentionDays);
  if (!RETENTION_POLICY_TOKEN.test(version)) {
    fail('RETENTION_POLICY_INVALID', 'Assessment retention policy version is invalid.');
  }
  if (!Number.isSafeInteger(days) || days < 1 || days > 36500) {
    fail('RETENTION_POLICY_INVALID', 'Assessment retention days must be between 1 and 36500.');
  }
  return Object.freeze({ version, days });
}

function assessmentRetentionPolicyFromEnv(env = process.env) {
  const version = String(env.HRBOSS_ASSESSMENT_RETENTION_POLICY_VERSION || '').trim();
  const days = String(env.HRBOSS_ASSESSMENT_RETENTION_DAYS || '').trim();
  if (!version && !days) return null;
  if (!version || !days) {
    fail(
      'RETENTION_POLICY_INVALID',
      'HRBOSS_ASSESSMENT_RETENTION_POLICY_VERSION and HRBOSS_ASSESSMENT_RETENTION_DAYS must be configured together.',
    );
  }
  return normalizeAssessmentRetentionPolicy({ version, days: Number(days) });
}

function subRequestId(requestId, operation) {
  const digest = crypto.createHash('sha256').update(`${requestId}:${operation}`, 'utf8').digest('hex');
  return `f017:${operation}:${digest.slice(0, 40)}`;
}

function assertCandidateJob(database, candidateId, jobId) {
  const row = database.prepare('SELECT 1 AS present FROM candidate WHERE internal_id = ? AND job_id = ?').get(candidateId, jobId);
  if (!row) fail('CANDIDATE_JOB_MISMATCH', 'Assessment candidate and job context do not match.');
}

function assertJobAcceptsAssessmentMaterial(database, jobId) {
  const row = database.prepare('SELECT id, name, status FROM job WHERE id = ?').get(Number(jobId));
  if (!row) fail('JOB_NOT_FOUND', 'Assessment job does not exist.');
  if (row.status === 'closed') {
    fail('JOB_CLOSED', `岗位“${row.name || row.id}”已关闭，请重新开启后再新增或确认测评材料。`, 409);
  }
}

function assertBindingContext(database, command) {
  const candidateId = String(command.candidate_id || '').trim();
  const jobId = Number(command.job_id);
  if (!candidateId || !Number.isSafeInteger(jobId) || jobId <= 0) {
    fail('BINDING_CONTEXT_REQUIRED', 'Assessment binding candidate and job context are required.');
  }
  const row = database.prepare(`
    SELECT 1 AS present FROM assessment_binding
    WHERE id = ? AND candidate_id = ? AND job_id = ?
  `).get(command.binding_id, candidateId, jobId);
  if (!row) fail('BINDING_CONTEXT_MISMATCH', 'Assessment binding context does not match the current candidate.');
  assertCandidateJob(database, candidateId, jobId);
}

function assertDocumentContext(database, command) {
  const candidateId = String(command.candidate_id || '').trim();
  const jobId = Number(command.job_id);
  const documentId = String(command.document_id || '').trim();
  if (!candidateId || !Number.isSafeInteger(jobId) || jobId <= 0 || !documentId) {
    fail('DOCUMENT_CONTEXT_REQUIRED', 'Assessment document, candidate and job context are required.');
  }
  const row = database.prepare(`
    SELECT 1 AS present FROM assessment_binding
    WHERE document_id = ? AND candidate_id = ? AND job_id = ?
  `).get(documentId, candidateId, jobId);
  if (!row) fail('DOCUMENT_CONTEXT_MISMATCH', 'Assessment document context does not match the current candidate.');
  assertCandidateJob(database, candidateId, jobId);
}

function publicDeletionResult(result) {
  return Object.freeze({
    operation: result.operation,
    document_id: result.document_id,
    lifecycle_state: result.lifecycle_state,
    version: result.version,
    event_id: result.event_id,
    idempotent_replay: result.idempotent_replay === true,
    ...(result.physical_delete_enabled === true ? { physical_delete_enabled: true } : {}),
    ...(result.tombstone === true ? { tombstone: true } : {}),
    ...(result.artifact_delete_state ? { artifact_delete_state: result.artifact_delete_state } : {}),
    ...(result.deletion_request_state ? { deletion_request_state: result.deletion_request_state } : {}),
  });
}

function normalizeIdentityName(value) {
  return String(value || '').replace(/\s+/g, '').trim().toLocaleLowerCase();
}

function assessmentIdentity(candidateName, reportName) {
  const normalizedCandidate = normalizeIdentityName(candidateName);
  const normalizedReport = normalizeIdentityName(reportName);
  return Object.freeze({
    candidate_name: String(candidateName || '').trim() || null,
    report_subject_name: String(reportName || '').trim() || null,
    name_mismatch: Boolean(normalizedCandidate && normalizedReport && normalizedCandidate !== normalizedReport),
  });
}

function documentIdentity(database, documentId, candidateId) {
  const row = database.prepare(`
    SELECT candidate.*, document.analysis_json
    FROM candidate
    JOIN assessment_document document ON document.id = ?
    WHERE candidate.internal_id = ?
  `).get(documentId, candidateId);
  const analysis = parseStoredJson(row && row.analysis_json);
  return assessmentIdentity(row && row.name, analysis && analysis.subject_name);
}

function bindingIdentity(database, bindingId) {
  const row = database.prepare(`
    SELECT candidate.*, document.analysis_json
    FROM assessment_binding binding
    JOIN candidate ON candidate.internal_id = binding.candidate_id
    JOIN assessment_document document ON document.id = binding.document_id
    WHERE binding.id = ?
  `).get(bindingId);
  const analysis = parseStoredJson(row && row.analysis_json);
  return assessmentIdentity(row && row.name, analysis && analysis.subject_name);
}

function requireIdentityMismatchAcknowledgement(command, identity) {
  if (identity.name_mismatch && command.identity_mismatch_acknowledged !== true) {
    fail(
      'IDENTITY_MISMATCH_CONFIRMATION_REQUIRED',
      `报告姓名“${identity.report_subject_name}”与候选人“${identity.candidate_name}”不一致，请由 HR 明确确认后继续。`,
    );
  }
}

function publicImportResult(intake, metadata, pending, duplicate, identity = null) {
  if (duplicate) {
    return Object.freeze({
      duplicate: true,
      document_id: intake.document_id,
      requires_manual_resolution: true,
      identity_name_mismatch: identity ? identity.name_mismatch : false,
      ...(identity && identity.report_subject_name ? { report_subject_name: identity.report_subject_name } : {}),
      notice: '相同文件已存在；请由 HR 明确确认是否纠正到当前候选人。',
    });
  }
  return Object.freeze({
    duplicate: false,
    document_id: intake.document_id,
    document_version: metadata.version,
    binding_id: pending.binding_id,
    binding_version: pending.version,
    binding_state: pending.state,
    conflict_state: pending.conflict_state,
    requires_manual_confirmation: true,
    report_type: metadata.report_type,
    assessment_date: metadata.assessment_date,
  });
}

function parseStoredJson(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function analysisFailureCode(error) {
  const code = String(error && error.code || '');
  if (code === 'LOCAL_OCR_UNAVAILABLE') return 'ASSESSMENT_REPORT_OCR_UNAVAILABLE';
  if (code === 'LOCAL_OCR_TEXT_EMPTY') return 'ASSESSMENT_REPORT_OCR_EMPTY';
  if (code === 'LOCAL_OCR_PAGE_LIMIT') return 'ASSESSMENT_REPORT_OCR_PAGE_LIMIT';
  if (code === 'LOCAL_OCR_TIMEOUT') return 'ASSESSMENT_REPORT_OCR_TIMEOUT';
  return String(code || 'ASSESSMENT_REPORT_ANALYSIS_FAILED')
    .replace(/[^A-Z0-9_]/g, '').slice(0, 80) || 'ASSESSMENT_REPORT_ANALYSIS_FAILED';
}

function publicAiAnalysis(row, currentInputSha256 = null) {
  if (!row) return null;
  const record = parseStoredJson(row.report_json);
  if (!record || record.schema_version !== ASSESSMENT_AI_RECORD_VERSION || !record.analysis) return null;
  const analysis = record.analysis;
  return Object.freeze({
    id: row.id,
    candidate_id: row.candidate_id,
    job_id: Number(row.job_id),
    status: 'ready',
    schema_version: analysis.schema_version,
    fit_score: Number(analysis.fit_score),
    confidence: analysis.confidence,
    analysis,
    provider: record.provider || null,
    model: record.model || null,
    created_at: row.created_at,
    current: Boolean(currentInputSha256 && record.input_sha256 === currentInputSha256),
    ranking_eligible: assessmentAiRankingEligible(analysis),
  });
}

function listAssessmentAiAnalyses({ database, command } = {}) {
  if (!database || typeof database.prepare !== 'function') {
    fail('DATABASE_REQUIRED', 'Assessment database is unavailable.');
  }
  const input = command && typeof command === 'object' ? command : {};
  const candidateId = String(input.candidate_id || '').trim();
  const jobId = Number(input.job_id);
  assertCandidateJob(database, candidateId, jobId);
  let currentInputSha256 = null;
  try {
    currentInputSha256 = buildAssessmentAiInput(database, candidateId, jobId).input_sha256;
  } catch (error) {
    // Historical drafts remain readable when current materials are incomplete.
    if (!error || !ASSESSMENT_AI_READINESS_CODES.has(error.code)) throw error;
  }
  return database.prepare(`
    SELECT id, candidate_id, job_id, report_json, created_at
    FROM ai_review
    WHERE candidate_id = ? AND job_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 50
  `).all(candidateId, jobId)
    .map((row) => publicAiAnalysis(row, currentInputSha256))
    .filter(Boolean)
    .slice(0, 10);
}

function createAssessmentProductService(options = {}) {
  const database = options.database;
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('DATABASE_REQUIRED', 'Assessment database is unavailable.');
  }
  const dataRoot = path.resolve(String(options.dataRoot || ''));
  if (!options.dataRoot || !path.isAbsolute(String(options.dataRoot))) fail('ASSESSMENT_DATA_ROOT_INVALID', 'Assessment data root is invalid.');
  const selectionSecret = String(options.selectionSecret || '');
  const consumedSelections = new Set();
  const previewTickets = new Map();
  const importPdf = options.importPdf || importAssessmentPdf;
  const requestPhysicalDeletion = options.requestPhysicalDeletion || requestAssessmentPhysicalDeletion;
  const deletePhysicalArtifacts = options.executePhysicalDeletion || executeAssessmentPhysicalDeletion;
  const readPreviewPage = options.readPreviewPage || readAssessmentRasterPage;
  const now = options.now || (() => Date.now());
  const retentionPolicy = normalizeAssessmentRetentionPolicy(options.retentionPolicy);
  const usesExternalAssessmentAi = options.assessmentAiUsesExternal === undefined
    ? !options.assessmentAiAssessor
    : options.assessmentAiUsesExternal === true;
  const assessmentAiAssessor = options.assessmentAiAssessor || ratingLlm.analyzeAssessmentPortfolio;
  const assessmentAiStatus = options.assessmentAiStatus || ratingLlm.externalAiStatus;
  let analysisBackfillComplete = false;
  let analysisBackfillPromise = null;

  function retentionDeadline(baseTime = now()) {
    const timestamp = typeof baseTime === 'number' ? baseTime : Date.parse(String(baseTime));
    if (!Number.isFinite(timestamp)) fail('CLOCK_INVALID', 'Assessment retention clock is invalid.');
    return new Date(timestamp + retentionPolicy.days * RETENTION_DAY_MS).toISOString();
  }

  function requireRetentionPolicy() {
    if (!retentionPolicy) {
      fail(
        'RETENTION_POLICY_NOT_CONFIGURED',
        '请先同时配置 HRBOSS_ASSESSMENT_RETENTION_POLICY_VERSION 与 HRBOSS_ASSESSMENT_RETENTION_DAYS，再导入测评。',
      );
    }
    return retentionPolicy;
  }

  function applyExplicitRetentionPolicyToLegacyDocuments() {
    if (!retentionPolicy) return 0;
    const rows = database.prepare(`
      SELECT id, version, created_at
      FROM assessment_document
      WHERE retention_policy_version IS NULL AND lifecycle_state <> 'deleted'
      ORDER BY created_at, id
    `).all();
    if (!rows.length) return 0;
    const updatedIds = database.transaction(() => rows.filter((row) => {
      const updatedAt = new Date(now()).toISOString();
      const update = database.prepare(`
        UPDATE assessment_document
        SET retention_policy_version = ?, delete_after = ?,
            version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND retention_policy_version IS NULL
      `).run(retentionPolicy.version, retentionDeadline(row.created_at), updatedAt, row.id, row.version);
      return update.changes === 1;
    }).map((row) => row.id)).immediate();
    if (typeof options.writeAuditLog === 'function') {
      for (const documentId of updatedIds) {
        options.writeAuditLog({
          action: '配置测评留存策略',
          target: documentId,
          who: 'local-primary-operator',
          auto: 0,
          result: '成功',
          detail_json: JSON.stringify({ policy_version: retentionPolicy.version, retention_days: retentionPolicy.days }),
        });
      }
    }
    return updatedIds.length;
  }

  async function analyzeStoredReport(row) {
    const assessmentRoot = path.join(dataRoot, 'assessment');
    const storedPath = path.join(assessmentRoot, row.storage_relpath);
    if (!fs.existsSync(storedPath)) throw Object.assign(new Error('missing'), { code: 'ASSESSMENT_REPORT_FILE_INVALID' });
    try {
      return await analyzeAssessmentReportPdf(storedPath, {
        controlledRoot: assessmentRoot,
        pdftotextExecutablePath: options.pdftotextExecutablePath,
      });
    } catch (error) {
      const code = String(error && error.code || '');
      if (!['ASSESSMENT_REPORT_TEXT_EMPTY', 'ASSESSMENT_REPORT_TOOL_UNAVAILABLE', 'ASSESSMENT_REPORT_PROCESS_FAILED'].includes(code)) throw error;
    }
    const previewRoot = path.join(
      assessmentRoot,
      'previews',
      'sha256',
      String(row.content_sha256).slice(0, 2),
      String(row.content_sha256),
    );
    const pageCount = Number(row.page_count);
    const ocr = await recognizeImageFiles(
      Array.from({ length: pageCount }, (_, index) => path.join(previewRoot, `page-${index + 1}.png`)),
      {
        controlledRoot: previewRoot,
        visionOcrExecutablePath: options.visionOcrExecutablePath,
        visionOcrScriptPath: options.visionOcrScriptPath,
        tesseractExecutablePath: options.tesseractExecutablePath,
        ocrRunner: options.ocrRunner,
        maxPages: options.ocrMaxPages,
      },
    );
    return analyzeAssessmentReportText(ocr.text, {
      source: 'supplier_pdf_local_ocr',
      ocr: {
        engine: ocr.engine,
        page_count: ocr.page_count,
        line_count: ocr.line_count,
        average_confidence: ocr.average_confidence,
      },
    });
  }

  async function ensureAnalysisBackfill() {
    const backfillAvailable = Boolean(
      options.pdftotextExecutablePath
      || options.ocrRunner
      || options.tesseractExecutablePath
      || options.visionOcrExecutablePath,
    );
    if (analysisBackfillComplete || !backfillAvailable) return;
    if (analysisBackfillPromise) return analysisBackfillPromise;
    analysisBackfillPromise = (async () => {
      const rows = database.prepare(`
        SELECT id, storage_relpath, content_sha256, page_count
        FROM assessment_document
        WHERE security_state = 'accepted' AND lifecycle_state <> 'deleted'
          AND storage_relpath IS NOT NULL
          AND (analysis_status <> 'ready' OR analysis_schema_version IS NULL OR analysis_schema_version <> ?)
        ORDER BY created_at, id
      `).all(ANALYSIS_SCHEMA_VERSION);
      for (const row of rows) {
        try {
          const analysis = await analyzeStoredReport(row);
          const analysisJson = JSON.stringify(analysis);
          database.prepare(`
            UPDATE assessment_document
            SET analysis_status = 'ready', analysis_schema_version = ?, analysis_json = ?,
                analysis_error_code = NULL,
                report_type = CASE WHEN report_type = 'unknown' AND ? <> 'unknown' THEN ? ELSE report_type END,
                assessment_date = COALESCE(assessment_date, ?),
                version = version + 1, updated_at = ?
            WHERE id = ? AND lifecycle_state <> 'deleted'
          `).run(
            analysis.schema_version, analysisJson, analysis.report_type, analysis.report_type,
            analysis.assessment_date, new Date(now()).toISOString(), row.id,
          );
        } catch (error) {
          const code = analysisFailureCode(error);
          database.prepare(`
            UPDATE assessment_document
            SET analysis_status = 'failed', analysis_error_code = ?,
                version = version + 1, updated_at = ?
            WHERE id = ? AND lifecycle_state <> 'deleted'
          `).run(code, new Date(now()).toISOString(), row.id);
        }
      }
      analysisBackfillComplete = true;
    })();
    try { await analysisBackfillPromise; } finally { analysisBackfillPromise = null; }
  }

  function prunePreviewTickets() {
    const timestamp = now();
    for (const [id, ticket] of previewTickets) if (ticket.expires_at <= timestamp) previewTickets.delete(id);
  }

  function invalidateDocumentPreviews(documentId) {
    for (const [id, ticket] of previewTickets) {
      if (ticket.command.document_id === documentId) previewTickets.delete(id);
    }
  }

  async function importSelected({ auditContext, command }) {
    const policy = requireRetentionPolicy();
    const deleteAfter = retentionDeadline();
    const selectionTime = now();
    // Validate against a clone first so a closed-job rejection does not consume
    // the native single-use file selection. Reopening the job can then resume
    // the same explicit HR action while forged/replayed selections retain their
    // original validation precedence.
    const selection = consumeAssessmentFileSelection(
      selectionSecret,
      command.selection_token,
      command,
      new Set(consumedSelections),
      { now: selectionTime },
    );
    assertCandidateJob(database, selection.candidate_id, selection.job_id);
    assertJobAcceptsAssessmentMaterial(database, selection.job_id);
    applyExplicitRetentionPolicyToLegacyDocuments();
    consumeAssessmentFileSelection(
      selectionSecret,
      command.selection_token,
      command,
      consumedSelections,
      { now: selectionTime },
    );
    let intake = null;
    let metadata = null;
    let pending = null;
    const requestId = selection.request_id;
    const storeResult = await importPdf(selection.source_path, {
      dataRoot,
      pdfinfoExecutablePath: options.pdfinfoExecutablePath,
      pdftoppmExecutablePath: options.pdftoppmExecutablePath,
      pdftotextExecutablePath: options.pdftotextExecutablePath,
      visionOcrExecutablePath: options.visionOcrExecutablePath,
      visionOcrScriptPath: options.visionOcrScriptPath,
      tesseractExecutablePath: options.tesseractExecutablePath,
      ocrRunner: options.ocrRunner,
      ocrMaxPages: options.ocrMaxPages,
      quotaBytes: options.quotaBytes,
      windowsReparsePointGuard: options.windowsReparsePointGuard,
      commitDocument: (stored) => {
        assertCandidateJob(database, selection.candidate_id, selection.job_id);
        assertJobAcceptsAssessmentMaterial(database, selection.job_id);
        database.transaction(() => {
          intake = archive.recordAssessmentDocumentIntake({
            database,
            auditContext,
            command: {
              ...stored,
              security_state: 'accepted',
              retention_policy_version: policy.version,
              delete_after: deleteAfter,
              request_id: subRequestId(requestId, 'intake'),
            },
          });
          const reportType = selection.report_type === 'unknown' && stored.analysis
            ? stored.analysis.report_type
            : selection.report_type;
          if (reportType === 'unknown') {
            metadata = {
              document_id: intake.document_id,
              report_type: 'unknown',
              assessment_date: null,
              review_state: 'pending',
              version: intake.version,
            };
          } else {
            metadata = archive.confirmAssessmentMetadata({
              database,
              auditContext,
              command: {
                document_id: intake.document_id,
                report_type: reportType,
                assessment_date: selection.assessment_date || (stored.analysis && stored.analysis.assessment_date),
                expected_version: intake.version,
                request_id: subRequestId(requestId, 'metadata'),
              },
            });
          }
          pending = archive.createPendingAssessmentBinding({
            database,
            auditContext,
            command: {
              document_id: intake.document_id,
              candidate_id: selection.candidate_id,
              job_id: selection.job_id,
              scope: 'candidate_job_archive',
              identity_basis: 'current_candidate_context',
              reason_code: 'native_current_candidate_context',
              expected_version: metadata.version,
              request_id: subRequestId(requestId, 'pending'),
            },
          });
        }).immediate();
      },
      onDuplicate: (stored) => {
        assertCandidateJob(database, selection.candidate_id, selection.job_id);
        assertJobAcceptsAssessmentMaterial(database, selection.job_id);
        intake = archive.recordAssessmentDocumentIntake({
          database,
          auditContext,
          command: {
            ...stored,
            security_state: 'accepted',
            retention_policy_version: policy.version,
            delete_after: deleteAfter,
            request_id: subRequestId(requestId, 'duplicate'),
          },
        });
      },
    });
    if (!intake) fail('ASSESSMENT_IMPORT_INCOMPLETE', 'Assessment import did not create an archive record.');
    const duplicate = storeResult.duplicate === true || intake.duplicate === true;
    if (duplicate) {
      const identity = documentIdentity(database, intake.document_id, selection.candidate_id);
      return publicImportResult(intake, null, null, true, identity);
    }
    if (!metadata || !pending) fail('ASSESSMENT_IMPORT_INCOMPLETE', 'Assessment import did not create a recoverable pending archive.');
    return publicImportResult(intake, metadata, pending, false);
  }

  async function listArchives({ auditContext, command }) {
    await ensureAnalysisBackfill();
    return archive.listAssessmentArchives({ database, auditContext, command });
  }

  async function listQueue({ auditContext, command }) {
    await ensureAnalysisBackfill();
    return archive.listAssessmentQueue({ database, auditContext, command });
  }

  function currentAiInput(command) {
    return buildAssessmentAiInput(database, command.candidate_id, command.job_id);
  }

  function listAiAnalyses({ command }) {
    return listAssessmentAiAnalyses({ database, command });
  }

  function recordAiAudit(result, input, auditContext, metadata = {}) {
    const table = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'").get();
    if (!table) return;
    database.prepare(`
      INSERT INTO audit_log (action, target, who, auto, result, detail_json, created_at)
      VALUES (?, ?, ?, 0, ?, ?, ?)
    `).run(
      '测评AI综合分析', input.candidate_id, auditContext.actor_id, result,
      JSON.stringify({
        job_id: input.job_id,
        source_document_count: input.source_document_ids.length,
        provider: metadata.provider || null,
        model: metadata.model || null,
        authorization_id: metadata.authorization_id || null,
        error_type: metadata.error_type || null,
      }),
      new Date(now()).toISOString(),
    );
  }

  async function generateAiAnalysis({ auditContext, command, externalAiAuthorization }) {
    const requestId = String(command.request_id || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) {
      fail('ASSESSMENT_AI_REQUEST_ID_INVALID', '测评 AI 请求标识无效。');
    }
    const input = currentAiInput(command);
    const replay = database.prepare(`
      SELECT id, candidate_id, job_id, report_json, created_at
      FROM ai_review ORDER BY id DESC
    `).all().find((row) => {
      const record = parseStoredJson(row.report_json);
      return record && record.schema_version === ASSESSMENT_AI_RECORD_VERSION && record.request_id === requestId;
    });
    if (replay) {
      if (replay.candidate_id !== input.candidate_id || Number(replay.job_id) !== input.job_id) {
        fail('IDEMPOTENCY_CONFLICT', '测评 AI 请求标识已用于其他候选人或岗位。');
      }
      return publicAiAnalysis(replay, input.input_sha256);
    }

    const authorizationMeta = usesExternalAssessmentAi
      ? describeExternalAiAuthorization(externalAiAuthorization)
      : null;
    if (usesExternalAssessmentAi && (!authorizationMeta || authorizationMeta.purpose !== ASSESSMENT_AI_PURPOSE)) {
      fail('ASSESSMENT_AI_AUTHORIZATION_REQUIRED', '测评 AI 分析缺少本次一次性外部调用授权。');
    }
    const aiStatus = usesExternalAssessmentAi ? assessmentAiStatus() : {};
    let raw;
    try {
      raw = await assessmentAiAssessor(input, externalAiAuthorization);
    } catch (error) {
      recordAiAudit('失败', input, auditContext, {
        provider: aiStatus.provider,
        model: aiStatus.model,
        authorization_id: authorizationMeta && authorizationMeta.id,
        error_type: error && error.name ? error.name : 'Error',
      });
      throw error;
    }
    const analysis = parseAssessmentAiReply(raw, { allowedEvidenceRefs: input.allowed_evidence_refs });
    const createdAt = new Date(now()).toISOString();
    const row = database.transaction(() => {
      const record = {
        schema_version: ASSESSMENT_AI_RECORD_VERSION,
        analysis_schema_version: ASSESSMENT_AI_SCHEMA_VERSION,
        request_id: requestId,
        input_sha256: input.input_sha256,
        source_document_ids: input.source_document_ids,
        provider: aiStatus.provider || 'test-assessor',
        model: aiStatus.model || null,
        created_by: auditContext.actor_id,
        analysis,
      };
      const inserted = database.prepare(`
        INSERT INTO ai_review (candidate_id, job_id, profile_confirmed, report_json, created_at)
        VALUES (?, ?, 0, ?, ?)
      `).run(input.candidate_id, input.job_id, JSON.stringify(record), createdAt);
      recordAiAudit('成功', input, auditContext, {
        provider: aiStatus.provider || 'test-assessor',
        model: aiStatus.model,
        authorization_id: authorizationMeta && authorizationMeta.id,
      });
      return database.prepare(`
        SELECT id, candidate_id, job_id, report_json, created_at
        FROM ai_review WHERE id = ?
      `).get(inserted.lastInsertRowid);
    }).immediate();
    return publicAiAnalysis(row, input.input_sha256);
  }

  function confirmBinding({ auditContext, command }) {
    assertBindingContext(database, command);
    assertJobAcceptsAssessmentMaterial(database, command.job_id);
    const identity = bindingIdentity(database, command.binding_id);
    requireIdentityMismatchAcknowledgement(command, identity);
    return archive.confirmAssessmentBinding({
      database,
      auditContext,
      command: identity.name_mismatch
        ? { ...command, reason_code: 'manual_identity_mismatch_confirmed' }
        : command,
    });
  }

  function confirmMetadata({ auditContext, command }) {
    assertBindingContext(database, command);
    assertJobAcceptsAssessmentMaterial(database, command.job_id);
    const documentId = String(command.document_id || '').trim();
    if (!documentId) fail('DOCUMENT_ID_REQUIRED', 'Assessment document is required for report classification.');
    const binding = database.prepare(`
      SELECT document_id, state
      FROM assessment_binding
      WHERE id = ?
    `).get(command.binding_id);
    if (!binding || binding.document_id !== documentId) {
      fail('DOCUMENT_CONTEXT_MISMATCH', 'Assessment document does not match the current candidate binding.');
    }
    if (binding.state !== 'pending') {
      fail('BINDING_STATE_INVALID', 'Only a pending Assessment binding can be classified.');
    }
    return archive.confirmAssessmentMetadata({
      database,
      auditContext,
      command: {
        document_id: documentId,
        report_type: command.report_type,
        assessment_date: command.assessment_date,
        expected_version: command.expected_version,
        request_id: command.request_id,
      },
    });
  }

  function resolveDuplicateBinding({ auditContext, command }) {
    const documentId = String(command.document_id || '').trim();
    const candidateId = String(command.candidate_id || '').trim();
    const jobId = Number(command.job_id);
    const requestId = String(command.request_id || '').trim();
    if (!documentId) fail('DOCUMENT_ID_REQUIRED', 'Assessment duplicate document is required.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) {
      fail('REQUEST_ID_INVALID', 'Assessment duplicate resolution request identifier is invalid.');
    }
    if (command.confirmed !== true) {
      fail('DUPLICATE_RESOLUTION_CONFIRMATION_REQUIRED', 'HR must explicitly confirm duplicate report correction.');
    }
    assertCandidateJob(database, candidateId, jobId);
    assertJobAcceptsAssessmentMaterial(database, jobId);
    const document = database.prepare(`
      SELECT id, version FROM assessment_document WHERE id = ?
    `).get(documentId);
    if (!document) fail('DOCUMENT_NOT_FOUND', 'Assessment duplicate document does not exist.');
    const identity = documentIdentity(database, documentId, candidateId);
    requireIdentityMismatchAcknowledgement(command, identity);
    const reasonCode = identity.name_mismatch
      ? 'manual_duplicate_rebind_identity_mismatch_confirmed'
      : 'manual_duplicate_rebind_confirmed';
    const liveBinding = database.prepare(`
      SELECT id, candidate_id, job_id, state, version, request_id
      FROM assessment_binding
      WHERE document_id = ? AND state IN ('active', 'pending')
      ORDER BY CASE state WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC, id DESC
      LIMIT 1
    `).get(documentId);

    if (liveBinding && liveBinding.candidate_id === candidateId && Number(liveBinding.job_id) === jobId) {
      if (liveBinding.state === 'active') {
        return Object.freeze({
          operation: 'duplicate_already_current',
          document_id: documentId,
          binding_id: liveBinding.id,
          candidate_id: candidateId,
          job_id: jobId,
          state: 'active',
          version: Number(liveBinding.version),
          idempotent_replay: liveBinding.request_id === subRequestId(requestId, 'duplicate-rebind'),
        });
      }
      return archive.confirmAssessmentBinding({
        database,
        auditContext,
        command: {
          binding_id: liveBinding.id,
          expected_version: Number(liveBinding.version),
          request_id: subRequestId(requestId, 'duplicate-confirm'),
          reason_code: reasonCode,
        },
      });
    }

    if (liveBinding && liveBinding.state === 'active') {
      return archive.rebindAssessmentDocument({
        database,
        auditContext,
        command: {
          binding_id: liveBinding.id,
          candidate_id: candidateId,
          job_id: jobId,
          expected_version: Number(liveBinding.version),
          request_id: subRequestId(requestId, 'duplicate-rebind'),
          identity_basis: 'manual_cross_source',
          reason_code: reasonCode,
        },
      });
    }

    return database.transaction(() => {
      if (liveBinding) {
        archive.revokeAssessmentBinding({
          database,
          auditContext,
          command: {
            binding_id: liveBinding.id,
            expected_version: Number(liveBinding.version),
            request_id: subRequestId(requestId, 'duplicate-revoke-pending'),
            reason_code: reasonCode,
          },
        });
      }
      const currentDocument = database.prepare('SELECT version FROM assessment_document WHERE id = ?').get(documentId);
      return archive.bindAssessmentDocument({
        database,
        auditContext,
        command: {
          document_id: documentId,
          candidate_id: candidateId,
          job_id: jobId,
          scope: 'candidate_job_archive',
          identity_basis: 'manual_cross_source',
          reason_code: reasonCode,
          expected_version: Number(currentDocument.version),
          request_id: subRequestId(requestId, 'duplicate-bind'),
        },
      });
    }).immediate();
  }

  function revokeBinding({ auditContext, command }) {
    assertBindingContext(database, command);
    return archive.revokeAssessmentBinding({ database, auditContext, command });
  }

  function requestDeletion({ auditContext, command }) {
    requireRetentionPolicy();
    applyExplicitRetentionPolicyToLegacyDocuments();
    assertDocumentContext(database, command);
    const { candidate_id: _candidateId, job_id: _jobId, ...deletionCommand } = command;
    const result = requestPhysicalDeletion({ database, auditContext, command: deletionCommand });
    invalidateDocumentPreviews(result.document_id);
    return publicDeletionResult(result);
  }

  function confirmDeletion({ auditContext, command }) {
    requireRetentionPolicy();
    assertDocumentContext(database, command);
    const { candidate_id: _candidateId, job_id: _jobId, ...deletionCommand } = command;
    const result = deletePhysicalArtifacts({ database, dataRoot, auditContext, command: deletionCommand });
    invalidateDocumentPreviews(result.document_id);
    return publicDeletionResult(result);
  }

  function createPreview({ auditContext, command }) {
    prunePreviewTickets();
    const prepared = archive.prepareAssessmentView({ database, auditContext, command });
    const previewRoot = path.join(dataRoot, 'assessment', 'previews');
    // Verify that the first raster page is readable before recording the view event.
    readPreviewPage({ previewRoot, contentSha256: prepared.content_sha256, page: 1 });
    const viewed = archive.recordAssessmentViewed({ database, auditContext, command });
    const versions = database.prepare(`
      SELECT binding.version AS binding_version, document.version AS document_version
      FROM assessment_binding binding
      JOIN assessment_document document ON document.id = binding.document_id
      WHERE binding.id = ? AND document.id = ?
    `).get(prepared.binding_id, prepared.document_id);
    if (!versions) fail('ASSESSMENT_PREVIEW_TICKET_INVALID', 'Assessment preview context is unavailable.');
    const previewId = crypto.randomUUID();
    previewTickets.set(previewId, Object.freeze({
      content_sha256: prepared.content_sha256,
      page_count: prepared.page_count,
      binding_version: Number(versions.binding_version),
      document_version: Number(versions.document_version),
      audit_context: auditContext,
      command: Object.freeze({
        binding_id: command.binding_id,
        document_id: command.document_id,
        candidate_id: command.candidate_id,
        job_id: command.job_id,
        request_id: command.request_id,
      }),
      expires_at: now() + PREVIEW_TTL_MS,
    }));
    return Object.freeze({
      preview_id: previewId,
      page_count: prepared.page_count,
      expires_in_seconds: PREVIEW_TTL_MS / 1000,
      view_event_id: viewed.event_id,
    });
  }

  function getPreviewPage(previewId, pageInput) {
    prunePreviewTickets();
    const ticketId = String(previewId || '');
    const ticket = previewTickets.get(ticketId);
    const page = Number(pageInput);
    if (!ticket || !Number.isInteger(page) || page < 1 || page > ticket.page_count) {
      fail('ASSESSMENT_PREVIEW_TICKET_INVALID', 'Assessment preview is unavailable or expired.');
    }
    try {
      const prepared = archive.prepareAssessmentView({
        database,
        auditContext: ticket.audit_context,
        command: ticket.command,
      });
      const versions = database.prepare(`
        SELECT binding.version AS binding_version, document.version AS document_version
        FROM assessment_binding binding
        JOIN assessment_document document ON document.id = binding.document_id
        WHERE binding.id = ? AND document.id = ?
      `).get(prepared.binding_id, prepared.document_id);
      if (!versions || Number(versions.binding_version) !== ticket.binding_version
          || Number(versions.document_version) !== ticket.document_version
          || prepared.content_sha256 !== ticket.content_sha256) {
        fail('ASSESSMENT_PREVIEW_TICKET_INVALID', 'Assessment preview context has changed.');
      }
      return readPreviewPage({
        previewRoot: path.join(dataRoot, 'assessment', 'previews'),
        contentSha256: ticket.content_sha256,
        page,
      });
    } catch {
      previewTickets.delete(ticketId);
      fail('ASSESSMENT_PREVIEW_TICKET_INVALID', 'Assessment preview is unavailable or expired.');
    }
  }

  applyExplicitRetentionPolicyToLegacyDocuments();

  return Object.freeze({
    confirmBinding,
    confirmMetadata,
    confirmDeletion,
    createPreview,
    getPreviewPage,
    importSelected,
    generateAiAnalysis,
    listAiAnalyses,
    listArchives,
    listQueue,
    requestDeletion,
    resolveDuplicateBinding,
    revokeBinding,
  });
}

module.exports = {
  AssessmentProductError,
  PREVIEW_TTL_MS,
  assessmentRetentionPolicyFromEnv,
  createAssessmentProductService,
  listAssessmentAiAnalyses,
  normalizeAssessmentRetentionPolicy,
};
