
const { PROJECT_ROOT } = require("./paths");
// 可写动作服务：只暴露白名单端点——画像读写、批量重评、访谈入库、深度画像生成/确认、
// 单人第二意见，以及本地截图导入这类不访问 Boss 的本地动作。
// 与 db-server.js（纯只读浏览）分开跑，写操作绝不混进只读服务。
// 红线：这里没有任何端点能改 candidate.SABC / quality_score / 自动处置。
// 测评 AI 以独立 schema 写入既有 ai_review，并作为同一 SABC 档内的排序信号。
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const {
  ensurePrivateDir,
  ensurePrivateFile,
  hardenPrivateDir,
  writePrivateFile,
  privateAppendStream,
} = require('./secure-fs');
const { resolveSelectedDirectory } = require('./local-directory-selection');
const { assertLocalVisionReady } = require('./local-vision-preflight');
const { resolveScreenshotDraftPreview } = require('./screenshot-draft-preview');
const {
  legacyScreenshotTask,
  recoverInterruptedLegacyScreenshotProgress,
} = require('./screenshot-import-task-public');
const { durableAtomicWriteFile, fsyncDirectory } = require('./durable-atomic-file');
const {
  cleanupOwnedLocalInterviewArtifacts,
  cleanupOwnedLocalInterviewDerivedArtifacts,
} = require('./local-interview-artifact-cleanup');
const db = require('./db');
const { fetchMinutesTranscript } = require('./minutes-fetch');
const screenshotImportProgress = require('./screenshot-import-progress');
const {
  readScreenshots: readScreenshotsWithAi,
} = require('./screenshot-ai-reader');
const {
  SCREENSHOT_IMPORT_PURPOSE,
  ScreenshotAiImportStateStore,
  assertApprovedScreenshotInput,
  prepareScreenshotAiBatch,
  publicApprovalPreview,
  publicScreenshotAiState,
} = require('./screenshot-ai-import-state');
const {
  applyAiFieldFill,
  confirmScreenshotOcrDraft,
  editScreenshotOcrDraft,
  listScreenshotOcrDrafts,
  listScreenshotOcrReviewAudit,
  rejectScreenshotOcrDraft,
} = require('./ingest-screenshot-drafts');
const { fillPendingDraftsWithAi } = require('./screenshot-ai-fill-runner');
const { prepareScreenshotAiFillBatch } = require('./screenshot-ai-fill-approval');
const { issueExternalAiAuthorization } = require('./external-ai-authorization');
const { consumeExternalAiUserApproval } = require('./external-ai-user-approval');
const {
  externalAiMaterialHash,
  externalAiMaterialSnapshot,
} = require('./external-ai-material-hash');
const { JOB_JD_OPTIMIZATION_PURPOSE } = require('./job-jd-ai');
const { consumeF009UserApproval } = require('./f009-user-approval');
const { consumeResumeFileSelection } = require('./resume-file-selection');
const { importManualResumeAttachment } = require('./manual-resume-import');
const { createResumeCandidateIntakeService } = require('./resume-candidate-intake');
const { createF009LlmRuntime, sha256: f009Sha256, SCREENSHOT_FIELD_PURPOSE } = require('./f009-interview-llm');
const { publicEcommerceTemplateCatalog } = require('./ecommerce-job-template-flow');
const { prepareAssessmentIngress } = require('./assessment-actor-context');
const { assessmentRetentionPolicyFromEnv, createAssessmentProductService } = require('./assessment-product-service');
const { ASSESSMENT_AI_PURPOSE } = require('./assessment-ai-analysis');
const { createF018ApplicationService } = require('./f018-application-service');
const { createHrManualDispositionService } = require('./hr-manual-disposition-service');
const { assertWindowsAssessmentPathSafe } = require('./windows-assessment-guard');
const {
  confirmFinalReview,
  createFinalReview,
  recordFinalDisposition,
  reopenFinalReview,
  updateFinalReview,
} = require('./f018-final-review-service');
const { reconcileAssessmentOrphans } = require('./assessment-controlled-store');
const {
  LIVE_AUDIO_TELEMETRY_PREFIX,
  localInterviewCapability,
  parseLiveAudioTelemetryLine,
  resolveLocalInterviewTool,
  sanitizeLiveAudioTelemetry,
} = require('./local-interview-p0');
const { authorizeLocalRequest, handleLocalPreflight, healthPayload, requireLocalApiToken } = require('./local-api-security');
const {
  LOCAL_PRINCIPAL,
  authorizePrincipalRequest,
  sanitizeClientBody,
} = require('./local-principal');
const interviewAdapters = require('./interview-source-adapters');
const {
  getInterviewMaterialRoot,
  prepareInterviewMaterialDirectory,
  prepareInterviewMaterialFileTarget,
  readAndValidateInterviewSummary,
  readControlledTextFile,
  validateImportedMediaSource,
  validateInterviewMaterialFile,
} = require('./interview-material-paths');
const {
  ASR_TRANSCRIPT_ACCURACY_LABEL,
  buildCanonicalTranscript,
  readCanonicalTranscript,
} = require('./interview-transcript-cues');
const {
  GUARDIAN_IPC_SCHEMA,
  readGuardianRegistry,
  removeGuardianRegistry,
} = require('./local-interview-guardian-protocol');

const HOST = '127.0.0.1';
const PORT = Number(process.env.BOSS_ACTION_PORT || 17733);
const LOCAL_API_TOKEN = requireLocalApiToken();
const INSTANCE_ID = process.env.HRBOSS_LOCAL_API_INSTANCE_ID || 'standalone';
const EXTERNAL_AI_CONFIG_STARTUP_FAULT_CODE = 'EXTERNAL_AI_CONFIG_UNREADABLE';
const EXTERNAL_AI_CONFIG_STARTUP_FAULT = String(process.env.HRBOSS_EXTERNAL_AI_CONFIG_STARTUP_FAULT || '') === EXTERNAL_AI_CONFIG_STARTUP_FAULT_CODE
  ? EXTERNAL_AI_CONFIG_STARTUP_FAULT_CODE
  : '';
const ACTIVE_PROGRESS_STALE_MS = 15 * 60 * 1000;
const ACTIVE_PROGRESS_STATUSES = ['running', 'staging', 'ingesting', 'stopping'];
const LOCAL_INTERVIEW_OUTPUT_ROOT = getInterviewMaterialRoot();
const LOCAL_INTERVIEW_INCOMPLETE_ARTIFACTS = Object.freeze(new Set([
  'recording.wav',
  'audio.wav',
  'transcript.txt',
  'transcript.srt',
  'transcript.json',
  'summary.json',
  'codex-input.md',
  'run.log',
  '.hrboss-local-interview-state.json',
]));
const LOCAL_INTERVIEW_TRANSCRIPT_ARTIFACT = /^transcript\.(?:txt|srt|json|vtt|partial)$/;
const LOCAL_INTERVIEW_SOURCE_ARTIFACT = /^source\.(?:wav|aiff|aif|m4a|mp3|aac|flac|ogg|mp4|mov|m4v)$/i;
const LOCAL_INTERVIEW_OWNER_MARKER = '.hrboss-local-interview-owner.json';
const LOCAL_INTERVIEW_STATE_MARKER = '.hrboss-local-interview-state.json';
const LOCAL_INTERVIEW_STATE_TEMP_ARTIFACT = /^\.hrboss-local-interview-state\.json\.[a-f0-9]{32}\.tmp$/;
const LOCAL_INTERVIEW_OWNER_SCHEMA = 'hrboss_local_interview_owner_v1';
const LOCAL_INTERVIEW_STATE_SCHEMA = 'hrboss_local_interview_state_v1';
const LOCAL_INTERVIEW_GUARDIAN_REGISTRY = path.resolve(
  process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_REGISTRY
    || path.join(path.dirname(LOCAL_INTERVIEW_OUTPUT_ROOT), 'local-interview-guardian.v1.json'),
);
const LOCAL_INTERVIEW_BLOCKING_STATES = Object.freeze(new Set([
  'starting',
  'running',
  'abort_pending',
  'manual_stop_failed',
  'stopping',
  'termination_unconfirmed',
  'cleanup_in_progress',
  'cleanup_failed',
  'binding_in_progress',
  'bind_failed',
  'transcription_in_progress',
  'transcription_retry_starting',
  'transcription_retry_running',
  'transcription_failed',
]));
const LOCAL_INTERVIEW_TERM_GRACE_MS = 1200;
const LOCAL_INTERVIEW_KILL_GRACE_MS = 2500;
const LOCAL_INTERVIEW_TERMINATION_POLL_MS = 25;
const INTERVIEW_SOURCE_TYPES = new Set(['manual_transcript', 'offline_recording', 'lark_minutes']);
const INTERVIEW_SOURCE_MARKER = /^\[source_type:([a-z_]+)\]\s*/;
const f009Runtime = createF009LlmRuntime();
const f009ApprovalSecret = String(process.env.HRBOSS_F009_APPROVAL_SECRET || '');
const consumedF009ApprovalNonces = new Set();
const consumedExternalAiApprovalNonces = new Set();
const screenshotAiImportState = new ScreenshotAiImportStateStore();
try {
  const interruptedAiState = screenshotAiImportState.read();
  const aiWasActive = Boolean(interruptedAiState && ['running', 'retrying'].includes(interruptedAiState.status));
  if (aiWasActive) {
    screenshotAiImportState.recoverInterrupted();
  }
  // This module has just started, so it cannot own a live screenshot-import
  // child yet. Any persisted active progress is therefore interrupted even if
  // the AI read state had already finalized (child staging) or never existed
  // (the macOS Vision path).
  const legacyProgress = screenshotImportProgress.readProgress();
  if (ACTIVE_PROGRESS_STATUSES.includes(legacyProgress.status)) {
    screenshotImportProgress.writeProgress(recoverInterruptedLegacyScreenshotProgress(legacyProgress, {
      aiWasActive: aiWasActive && legacyProgress.run_id === interruptedAiState.run_id,
      at: nowIso(),
    }));
  }
} catch (error) {
  console.error(`截图 AI 中断状态恢复失败：${error.message}`);
}
const consumedResumeSelectionNonces = new Set();
const ASSESSMENT_PHASE_A_ENABLED = process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED === '1';
const ASSESSMENT_INTERNAL_AVAILABLE = ASSESSMENT_PHASE_A_ENABLED;
const ASSESSMENT_RETENTION_POLICY = assessmentRetentionPolicyFromEnv(process.env);
const ASSESSMENT_SELECTION_SECRET = String(process.env.HRBOSS_ASSESSMENT_SELECTION_SECRET || '');
const RESUME_SELECTION_SECRET = String(process.env.HRBOSS_RESUME_SELECTION_SECRET || '');
const ASSESSMENT_BACKUP_POLICY_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const F018_ENABLED = process.env.HRBOSS_F018_ENABLED === '1';
let assessmentProductService = null;
let f018ApplicationService = null;
let resumeCandidateIntakeService = null;

function assessmentBackupPolicyError(message) {
  const error = new Error(message);
  error.code = 'POLICY_CONTRACT_REQUIRED';
  return error;
}

function assessmentBackupPolicyOptionsFromEnv(env = process.env) {
  const policyVersion = String(env.HRBOSS_ASSESSMENT_BACKUP_POLICY_VERSION || '').trim();
  const retentionText = String(env.HRBOSS_ASSESSMENT_BACKUP_RETENTION_DAYS || '').trim();
  if (policyVersion && !ASSESSMENT_BACKUP_POLICY_TOKEN.test(policyVersion)) {
    throw assessmentBackupPolicyError('HRBOSS_ASSESSMENT_BACKUP_POLICY_VERSION is invalid.');
  }
  let retentionDays;
  if (retentionText) {
    if (!/^[1-9][0-9]*$/.test(retentionText)) {
      throw assessmentBackupPolicyError('HRBOSS_ASSESSMENT_BACKUP_RETENTION_DAYS must be a positive integer.');
    }
    retentionDays = Number(retentionText);
    if (!Number.isSafeInteger(retentionDays) || retentionDays > 36500) {
      throw assessmentBackupPolicyError('HRBOSS_ASSESSMENT_BACKUP_RETENTION_DAYS must be between 1 and 36500.');
    }
  }
  return {
    assessmentBackupPolicyVersion: policyVersion || undefined,
    assessmentBackupRetentionDays: retentionDays,
  };
}

function f018AuditContext() {
  return Object.freeze({
    actor_id: LOCAL_PRINCIPAL.actor_id,
    actor_type: 'local_os_subject',
    actor_source: 'server_local_instance',
    actor_session_id: INSTANCE_ID,
    assurance: 'local_instance_only',
  });
}

function requireF018Service() {
  if (!F018_ENABLED) {
    const error = new Error('Application 与独立终评基础尚未启用。');
    error.code = 'F018_DISABLED';
    error.statusCode = 404;
    throw error;
  }
  if (!f018ApplicationService) {
    f018ApplicationService = createF018ApplicationService({
      database: db.conn(),
      actorContext: f018AuditContext(),
    });
  }
  return f018ApplicationService;
}

function firstAssessmentTool(envName, executableName) {
  const configured = String(process.env[envName] || '').trim();
  if (configured) return path.resolve(configured);
  const executableFile = process.platform === 'win32' ? `${executableName}.exe` : executableName;
  const candidates = process.platform === 'darwin'
    ? [`/opt/homebrew/bin/${executableName}`, `/usr/local/bin/${executableName}`, `/usr/bin/${executableName}`]
    : process.platform === 'linux'
      ? [`/usr/bin/${executableName}`, `/usr/local/bin/${executableName}`]
      : (() => {
        // These are pdfinfo and pdftoppm, which ship with poppler. Looking for
        // them under Tesseract-OCR was looking in the wrong product's folder —
        // the where.exe fallback below was carrying the whole Windows case.
        const programFiles = String(process.env.ProgramFiles || 'C:\\Program Files');
        const programFilesX86 = String(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)');
        const userProfile = String(process.env.USERPROFILE || '').trim();
        return [
          path.join(PROJECT_ROOT, 'runtime-tools', executableFile),
          path.join(programFiles, 'poppler', 'bin', executableFile),
          path.join(programFiles, 'poppler', 'Library', 'bin', executableFile),
          path.join(programFilesX86, 'poppler', 'bin', executableFile),
          // Chocolatey and scoop are the usual ways poppler arrives on Windows.
          path.join('C:\\ProgramData', 'chocolatey', 'bin', executableFile),
          ...(userProfile ? [path.join(userProfile, 'scoop', 'shims', executableFile)] : []),
        ];
      })();
  const known = candidates.find((candidate) => fs.existsSync(candidate));
  if (known) return known;
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [executableName], {
    encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 64 * 1024,
  });
  const discovered = lookup.status === 0
    ? String(lookup.stdout || '').split(/\r?\n/).map((item) => item.trim()).find((item) => path.isAbsolute(item) && fs.existsSync(item))
    : '';
  return discovered || path.resolve(PROJECT_ROOT, '.unavailable-assessment-tool');
}

function assessmentToolCapabilities() {
  const tools = {
    pdfinfo: firstAssessmentTool('HRBOSS_PDFINFO_PATH', 'pdfinfo'),
    pdftoppm: firstAssessmentTool('HRBOSS_PDFTOPPM_PATH', 'pdftoppm'),
    pdftotext: firstAssessmentTool('HRBOSS_PDFTOTEXT_PATH', 'pdftotext'),
    tesseract: firstAssessmentTool('HRBOSS_TESSERACT_PATH', 'tesseract'),
    vision_ocr: process.platform === 'darwin' ? '/usr/bin/swift' : '',
  };
  const available = Object.fromEntries(Object.entries(tools).map(([name, executablePath]) => [
    name,
    Boolean(executablePath && fs.existsSync(executablePath)),
  ]));
  const missingRequired = ['pdfinfo', 'pdftoppm'].filter((name) => !available[name]);
  const textAnalysisAvailable = available.pdftotext || available.tesseract || available.vision_ocr;
  return Object.freeze({
    available,
    missing_required: missingRequired,
    archive_import_available: missingRequired.length === 0,
    text_analysis_available: textAnalysisAvailable,
    text_analysis_mode: available.pdftotext
      ? 'local_pdf_text'
      : available.vision_ocr
        ? 'local_vision_ocr'
        : available.tesseract
          ? 'local_tesseract_ocr'
          : 'manual_metadata_only',
  });
}

function getAssessmentProductService() {
  if (!ASSESSMENT_PHASE_A_ENABLED) {
    const error = new Error('PDF 测评行政存档尚未启用。');
    error.code = 'ASSESSMENT_PHASE_A_DISABLED';
    error.statusCode = 404;
    throw error;
  }
  if (!assessmentProductService) {
    const database = db.conn();
    const dataRoot = path.resolve(process.env.HRBOSS_DATA_DIR || path.join(PROJECT_ROOT, 'data'));
    reconcileAssessmentOrphans({ database, dataRoot });
    assessmentProductService = createAssessmentProductService({
      database,
      dataRoot,
      selectionSecret: ASSESSMENT_SELECTION_SECRET,
      pdfinfoExecutablePath: firstAssessmentTool('HRBOSS_PDFINFO_PATH', 'pdfinfo'),
      pdftoppmExecutablePath: firstAssessmentTool('HRBOSS_PDFTOPPM_PATH', 'pdftoppm'),
      pdftotextExecutablePath: firstAssessmentTool('HRBOSS_PDFTOTEXT_PATH', 'pdftotext'),
      tesseractExecutablePath: firstAssessmentTool('HRBOSS_TESSERACT_PATH', 'tesseract'),
      visionOcrExecutablePath: process.platform === 'darwin' ? '/usr/bin/swift' : '',
      visionOcrScriptPath: path.join(PROJECT_ROOT, "native/vision-ocr.swift"),
      assessmentAiAssessor: (input, authorization) => f009Runtime.analyzeAssessmentPortfolio(input, authorization),
      assessmentAiStatus: () => f009Runtime.externalAiStatus(),
      assessmentAiUsesExternal: true,
      retentionPolicy: ASSESSMENT_RETENTION_POLICY,
      writeAuditLog: (entry) => db.writeAuditLog(entry),
      windowsReparsePointGuard: assertWindowsAssessmentPathSafe,
    });
  }
  return assessmentProductService;
}

function getResumeCandidateIntakeService() {
  if (!resumeCandidateIntakeService) {
    resumeCandidateIntakeService = createResumeCandidateIntakeService({
      database: db.conn(),
      dataRoot: path.resolve(process.env.HRBOSS_DATA_DIR || path.join(PROJECT_ROOT, 'data')),
      selectionSecret: RESUME_SELECTION_SECRET,
      upsertCandidate: (input) => db.upsertCandidate(input),
      writeAuditLog: (entry) => db.writeAuditLog(entry),
      pdfinfoExecutablePath: firstAssessmentTool('HRBOSS_PDFINFO_PATH', 'pdfinfo'),
      pdftoppmExecutablePath: firstAssessmentTool('HRBOSS_PDFTOPPM_PATH', 'pdftoppm'),
      pdftotextExecutablePath: firstAssessmentTool('HRBOSS_PDFTOTEXT_PATH', 'pdftotext'),
      tesseractExecutablePath: firstAssessmentTool('HRBOSS_TESSERACT_PATH', 'tesseract'),
      visionOcrExecutablePath: process.platform === 'darwin' ? '/usr/bin/swift' : '',
      visionOcrScriptPath: path.join(PROJECT_ROOT, "native/vision-ocr.swift"),
    });
  }
  return resumeCandidateIntakeService;
}

function currentExternalAiMaterialHash(purpose, targetId, materialInput = {}) {
  return externalAiMaterialHash({
    database: db.conn(),
    dbApi: db,
    purpose,
    targetId,
    materialInput,
  });
}

function currentExternalAiConnectionBinding() {
  const config = f009Runtime.publicConfig();
  return {
    provider: config.provider,
    base_url: config.baseUrl,
    model: config.model,
  };
}

function currentExternalAiMaterialSnapshot(purpose, targetId, materialInput = {}) {
  return externalAiMaterialSnapshot({
    database: db.conn(),
    dbApi: db,
    purpose,
    targetId,
    materialInput,
  });
}

function normalizeInterviewSourceType(value, fallback = 'manual_transcript') {
  const sourceType = typeof value === 'string' ? value.trim() : '';
  return INTERVIEW_SOURCE_TYPES.has(sourceType) ? sourceType : fallback;
}

function interviewSourceLabel(sourceType) {
  if (sourceType === 'offline_recording') return '线下录音转写';
  if (sourceType === 'lark_minutes') return '线上会议导入 · 飞书妙记';
  return '手动粘贴转写';
}

function taggedInterviewNote(note, sourceType) {
  const cleanNote = typeof note === 'string' ? note.trim().replace(INTERVIEW_SOURCE_MARKER, '') : '';
  return cleanNote || interviewSourceLabel(sourceType);
}

function publicInterview(row) {
  const rawNote = typeof row.note === 'string' ? row.note : '';
  const marker = rawNote.match(INTERVIEW_SOURCE_MARKER);
  const inferredType = row.source_url ? 'lark_minutes' : /线下.*录音/.test(rawNote) ? 'offline_recording' : 'manual_transcript';
  const sourceType = normalizeInterviewSourceType(row.source_type, normalizeInterviewSourceType(marker && marker[1], inferredType));
  return {
    ...row,
    note: rawNote.replace(INTERVIEW_SOURCE_MARKER, '') || interviewSourceLabel(sourceType),
    source_type: sourceType,
  };
}

function send(res, code, data) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendBinary(res, code, bytes, contentType = 'application/octet-stream') {
  res.writeHead(code, {
    'content-type': contentType,
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(bytes);
}

function sendAssessmentError(res, error) {
  const conflictCodes = new Set([
    'STALE_VERSION', 'IDEMPOTENCY_CONFLICT',
    'DOCUMENT_ALREADY_BOUND', 'ASSESSMENT_SELECTION_REPLAYED',
  ]);
  const status = Number(error && error.statusCode)
    || (conflictCodes.has(error && error.code) ? 409 : 400);
  return send(res, status, {
    ok: false,
    code: (error && error.code) || 'ASSESSMENT_ARCHIVE_ERROR',
    error: (error && error.message) || 'PDF 测评行政存档处理失败。',
  });
}

function sendF018Error(res, error) {
  const conflict = new Set([
    'STALE_VERSION', 'REQUEST_ID_REUSED', 'IDEMPOTENCY_CONFLICT',
    'ACTIVE_APPLICATION_EXISTS', 'CURRENT_REVIEW_CONFLICT',
    'FINAL_DISPOSITION_ALREADY_RECORDED',
  ]);
  const status = Number(error && error.statusCode)
    || (conflict.has(error && error.code) ? 409 : 400);
  return send(res, status, {
    ok: false,
    code: (error && error.code) || 'F018_ERROR',
    error: (error && error.message) || 'Application 或终评处理失败。',
  });
}

function f018Command(body) {
  return sanitizeClientBody(body || {});
}

function assertF018Context(database, command, applicationId = command.application_id) {
  const candidateId = String(command.candidate_id || '').trim();
  const jobId = Number(command.job_id);
  if (!candidateId || !Number.isSafeInteger(jobId) || jobId <= 0) {
    const error = new Error('Application candidate/job context is required.');
    error.code = 'APPLICATION_CONTEXT_REQUIRED';
    throw error;
  }
  const application = applicationId
    ? database.prepare(`
      SELECT id, candidate_id, job_id FROM application_episode
      WHERE id = ? AND candidate_id = ? AND job_id = ?
    `).get(Number(applicationId), candidateId, jobId)
    : null;
  if (applicationId && !application) {
    const error = new Error('Application context does not match the current candidate.');
    error.code = 'APPLICATION_CONTEXT_MISMATCH';
    throw error;
  }
  if (!database.prepare('SELECT 1 FROM candidate WHERE internal_id = ? AND job_id = ?').get(candidateId, jobId)) {
    const error = new Error('Candidate and job context do not match.');
    error.code = 'CANDIDATE_JOB_MISMATCH';
    throw error;
  }
  return { candidateId, jobId, application };
}

function withoutF018Context(command) {
  const { candidate_id: ignoredCandidate, job_id: ignoredJob, ...clean } = command;
  return clean;
}

function publicFinalReview(row) {
  if (!row) return null;
  let reviewJson = {};
  try { reviewJson = JSON.parse(row.review_json); } catch {}
  return {
    id: row.id,
    application_id: row.application_id,
    job_profile_version_id: row.job_profile_version_id,
    interview_report_id: row.interview_report_id,
    interview_report_ref_id: row.interview_report_ref_id,
    interview_report_content_hash: row.interview_report_content_hash,
    interview_report_version: row.interview_report_version == null ? null : Number(row.interview_report_version),
    status: row.status,
    review_json: reviewJson,
    content_hash: row.content_hash,
    version: Number(row.version),
    reopened_from_final_review_id: row.reopened_from_final_review_id,
    reopen_reason: row.reopen_reason,
    created_by: row.created_by,
    updated_by: row.updated_by,
    confirmed_by: row.confirmed_by,
    confirmed_at: row.confirmed_at,
    superseded_at: row.superseded_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function readF018State(command) {
  const service = requireF018Service();
  const database = db.conn();
  const context = assertF018Context(database, command, null);
  const applications = service.listApplications({
    candidate_id: context.candidateId,
    job_id: context.jobId,
  });
  const active = applications.find((row) => row.status === 'active') || null;
  const reviewHistory = database.prepare(`
    SELECT review.*
    FROM final_review review
    JOIN application_episode application ON application.id = review.application_id
    WHERE application.candidate_id = ? AND application.job_id = ?
    ORDER BY review.created_at DESC, review.id DESC
  `).all(context.candidateId, context.jobId).map(publicFinalReview);
  const activeReviews = active
    ? reviewHistory.filter((row) => Number(row.application_id) === Number(active.id))
    : [];
  const currentReview = activeReviews.find((row) => ['draft', 'reopened'].includes(row.status))
    || activeReviews.find((row) => row.status === 'confirmed') || null;
  const confirmedReview = activeReviews.find((row) => row.status === 'confirmed') || null;
  const dispositionHistory = database.prepare(`
    SELECT disposition.id, disposition.application_id, disposition.final_review_id,
           disposition.action, disposition.reason_code, disposition.actor_id, disposition.created_at
    FROM final_disposition disposition
    JOIN application_episode application ON application.id = disposition.application_id
    WHERE application.candidate_id = ? AND application.job_id = ?
    ORDER BY disposition.created_at DESC, disposition.id DESC
  `).all(context.candidateId, context.jobId);
  const disposition = active
    ? dispositionHistory.find((row) => Number(row.application_id) === Number(active.id)) || null
    : null;
  const profile = database.prepare(`
    SELECT profile.id, profile.config_json
    FROM job_profile_version profile
    JOIN job_jd_version jd
      ON jd.id = profile.jd_version_id
      AND jd.job_id = profile.job_id
      AND jd.status = 'active'
    WHERE profile.job_id = ? AND profile.status = 'confirmed'
    ORDER BY profile.version DESC, profile.id DESC LIMIT 1
  `).get(context.jobId) || null;
  let profileConfig = {};
  try { profileConfig = profile?.config_json ? JSON.parse(profile.config_json) : {}; } catch {}
  const assessmentPolicy = ['required', 'recommended', 'not_required']
    .includes(profileConfig?.assessment_policy)
    ? profileConfig.assessment_policy
    : 'not_required';
  const report = database.prepare(`
    SELECT report.id
    FROM interview_report_v1 report
    JOIN interview_session session ON session.id = report.session_id
    WHERE session.candidate_id = ? AND session.job_id = ? AND report.status = 'confirmed'
    ORDER BY report.confirmed_at DESC, report.id DESC LIMIT 1
  `).get(context.candidateId, context.jobId) || null;
  const assessmentTables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('assessment_document', 'assessment_binding')
  `).all();
  const confirmedAssessments = assessmentTables.length === 2 ? database.prepare(`
    SELECT document.id, document.report_type, document.assessment_date,
           document.analysis_status, document.content_sha256, document.version
    FROM assessment_document document
    JOIN assessment_binding binding ON binding.document_id = document.id
    WHERE binding.candidate_id = ?
      AND binding.job_id = ?
      AND binding.state = 'active'
      AND document.security_state = 'accepted'
      AND document.review_state = 'ready'
      AND document.report_type <> 'unknown'
      AND document.lifecycle_state = 'active'
    ORDER BY document.updated_at DESC, document.id DESC
  `).all(context.candidateId, context.jobId) : [];
  let currentAssessmentAiAnalysis = null;
  if (ASSESSMENT_PHASE_A_ENABLED && confirmedAssessments.length > 0) {
    try {
      const analyses = getAssessmentProductService().listAiAnalyses(prepareAssessmentIngress({
        candidate_id: context.candidateId,
        job_id: context.jobId,
      }));
      currentAssessmentAiAnalysis = analyses.find((item) => item.current === true) || null;
    } catch {
      // The terminal review remains usable when AI is unavailable or its
      // current material fingerprint cannot be rebuilt.
    }
  }
  return {
    applications,
    active_application: active,
    reviews: activeReviews,
    review_history: reviewHistory,
    current_review: currentReview,
    confirmed_review: confirmedReview,
    disposition,
    disposition_history: dispositionHistory,
    prerequisites: {
      confirmed_job_profile_id: profile && profile.id,
      confirmed_interview_report_id: report && report.id,
      assessment_policy: assessmentPolicy,
      confirmed_assessments: confirmedAssessments,
      assessment_requirement_met: assessmentPolicy !== 'required' || confirmedAssessments.length > 0,
      current_assessment_ai_analysis: currentAssessmentAiAnalysis,
    },
  };
}

function auditSensitiveRead(action, target) {
  const targetHash = crypto.createHash('sha256').update(String(target || 'unknown'), 'utf8').digest('hex');
  db.writeAuditLog({
    action,
    target: targetHash,
    who: LOCAL_PRINCIPAL.actor_id,
    auto: 0,
    result: '成功',
    detail_json: JSON.stringify({ instance_id: INSTANCE_ID }),
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        const error = new Error('body too large');
        error.code = 'BODY_TOO_LARGE';
        error.path = '$';
        error.statusCode = 413;
        reject(error);
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(sanitizeClientBody(JSON.parse(body))); } catch {
        const error = new Error('body 不是合法 JSON。');
        error.code = 'INVALID_JSON';
        error.path = '$';
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function readLocalInterviewSummary(summaryPath) {
  const loaded = readAndValidateInterviewSummary(summaryPath, { root: LOCAL_INTERVIEW_OUTPUT_ROOT });
  return { resolved: loaded.path, summary: loaded.summary };
}

function normalizeReportJson(report) {
  if (report == null) throw new Error('report required');
  if (typeof report === 'string') {
    const raw = report.trim();
    if (!raw) throw new Error('report required');
    try { JSON.parse(raw); } catch { throw new Error('report 字符串不是合法 JSON。'); }
    return raw;
  }
  if (typeof report === 'object') return JSON.stringify(report);
  throw new Error('report 必须是对象或 JSON 字符串');
}

function sendInterviewReportError(res, error) {
  const status = Number(error && error.statusCode) || (error && error.code === 'STALE_VERSION' ? 409 : 400);
  return send(res, status, {
    ok: false,
    code: (error && error.code) || 'INTERVIEW_REPORT_ERROR',
    path: (error && error.path) || '$',
    error: (error && error.message) || '面试报告处理失败。',
  });
}

function externalAiStartupConfigFaultResponse(faultCode = EXTERNAL_AI_CONFIG_STARTUP_FAULT) {
  if (faultCode !== EXTERNAL_AI_CONFIG_STARTUP_FAULT_CODE) return null;
  return {
    status: 503,
    body: {
      ok: false,
      code: EXTERNAL_AI_CONFIG_STARTUP_FAULT_CODE,
      error: '本机外部 AI 配置读取失败。为避免覆盖已有配置，管理员写入已锁定；请重启 招才官，若仍失败请联系部署人员。',
    },
  };
}

function readJsonMaybe(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function compactForPrompt(value, max = 240) {
  const textValue = value == null ? '' : String(value).replace(/\s+/g, ' ').trim();
  return textValue.length > max ? `${textValue.slice(0, max)}...` : textValue;
}

function scriptMarkdown(script) {
  const lines = [`# ${script.title || '面试结构化脚本'}`];
  if (script.positioning) lines.push('', `> ${script.positioning}`);
  for (const section of script.sections || []) {
    lines.push('', `## ${section.title}`);
    if (section.goal) lines.push(`目标：${section.goal}`);
    for (const item of section.items || []) {
      const tags = [item.required ? '必问' : '', item.type === 'followup' ? '追问' : '', item.type === 'confirm' ? '确认' : ''].filter(Boolean).join('/');
      lines.push(`- ${tags ? `【${tags}】` : ''}${item.question}`);
      if (item.why) lines.push(`  - 追问意图：${item.why}`);
      if (item.expected_signal) lines.push(`  - 观察信号：${item.expected_signal}`);
    }
  }
  if (Array.isArray(script.closing_checklist) && script.closing_checklist.length) {
    lines.push('', '## 结束前确认清单');
    script.closing_checklist.forEach((item) => lines.push(`- ${item}`));
  }
  return lines.join('\n');
}

function pickProfileText(profile) {
  if (!profile || typeof profile !== 'object') return '';
  const pieces = [
    profile.rubric,
    profile.position_mission && profile.position_mission.content,
    profile.deep_profile && profile.deep_profile.position_mission && profile.deep_profile.position_mission.content,
    profile.deep_profile && profile.deep_profile.summary,
    profile.deep_profile && profile.deep_profile.must_have,
    profile.deep_profile && profile.deep_profile.must_haves,
    profile.deep_profile && profile.deep_profile.key_competencies,
  ];
  return pieces
    .flatMap((item) => {
      if (!item) return [];
      if (Array.isArray(item)) return item.map((value) => compactForPrompt(typeof value === 'object' ? JSON.stringify(value) : value, 180));
      if (typeof item === 'object') return [compactForPrompt(JSON.stringify(item), 240)];
      return [compactForPrompt(item, 240)];
    })
    .filter(Boolean)
    .join('；');
}

function buildInterviewScript({ job, profile }) {
  const jobName = (job && job.name) || '当前岗位';
  const profileText = pickProfileText(profile);
  const hardBars = profile && profile.hard_bars && typeof profile.hard_bars === 'object' ? profile.hard_bars : {};
  const salaryRequired = !!hardBars.salary;
  const degreeRequired = !!hardBars.degree;
  const cityRequired = !!hardBars.city;
  const domainHints = [
    /直播|抖音|店播|主播|投流|GMV|ROI/.test(`${jobName} ${profileText}`) ? '直播运营' : '',
    /电商|淘宝|天猫|拼多多|商品|货盘/.test(`${jobName} ${profileText}`) ? '电商运营' : '',
    /销售|客户|BD|商务/.test(`${jobName} ${profileText}`) ? '销售增长' : '',
  ].filter(Boolean);
  const domain = domainHints[0] || '岗位核心能力';
  const projectQuestion = domain === '直播运营'
    ? '请讲一个你最近亲自负责的直播间增长项目，说明起始 GMV、当前 GMV、转化率、ROI 和你本人负责的动作。'
    : '请讲一个你最近亲自负责、最能代表岗位能力的项目，说明目标、你的职责、关键动作和量化结果。';
  const script = {
    schema_version: 'interview_script_p0_v1',
    title: `${jobName} 面试结构化脚本`,
    job_id: job && job.id,
    source: 'local_rule_from_jd_profile',
    generated_at: nowIso(),
    positioning: profileText ? `根据岗位画像生成：${compactForPrompt(profileText, 180)}` : '当前岗位画像较少，先使用通用 HR 结构化脚本，面试前建议 HR 补充岗位要求。',
    sections: [
      {
        id: 'opening',
        title: '开场与基本信息',
        goal: '确认候选人身份、当前状态和面试记录前提。',
        items: [
          { id: 'self_intro', type: 'must', required: true, question: '请先做一个 1 分钟自我介绍，重点讲和本岗位最相关的经历。', why: '建立候选人主线，观察其表达重点。', expected_signal: '经历和岗位方向是否一致。' },
          { id: 'current_status', type: 'must', required: true, question: '你目前是在职、离职还是看机会？现在主要看什么类型的岗位？', why: '确认求职动机和机会匹配度。', expected_signal: '动机清晰，岗位方向稳定。' },
        ],
      },
      {
        id: 'hard_bars',
        title: '硬性条件确认',
        goal: '把薪资、到岗、地点、学历等容易漏问的硬条件问清楚。',
        items: [
          { id: 'salary', type: 'confirm', required: true, question: salaryRequired ? '请确认当前薪资、期望薪资和可接受范围。' : '请确认当前薪资、期望薪资和薪资可谈空间。', why: '避免后续推进才发现预算不匹配。', expected_signal: '薪资口径明确，可进入关键事实确认。' },
          { id: 'arrival', type: 'confirm', required: true, question: '如果双方合适，你最快什么时候可以到岗？是否需要交接期？', why: '确认招聘节奏可行性。', expected_signal: '到岗周期明确。' },
          { id: 'location', type: 'confirm', required: cityRequired, question: '工作地点、通勤或城市安排上是否有硬性限制？', why: '确认地点约束。', expected_signal: '地点条件不阻塞。' },
          { id: 'degree', type: 'confirm', required: degreeRequired, question: '请确认学历、专业以及 JD 要求的证书或资质情况。', why: '确认硬门槛，不做过度推断。', expected_signal: '硬性资格可核验。' },
        ],
      },
      {
        id: 'competency',
        title: `${domain}能力深挖`,
        goal: '围绕 JD 核心能力验证候选人是否真的做过、做深、做出结果。',
        items: [
          { id: 'project_case', type: 'must', required: true, question: projectQuestion, why: '验证真实项目经验和量化结果。', expected_signal: '能说清目标、动作、数据、个人贡献。' },
          { id: 'personal_role', type: 'followup', required: true, question: '这个项目里哪些是你本人直接负责，哪些是团队共同完成？', why: '拆清个人贡献，避免把团队结果当个人能力。', expected_signal: '边界清楚，有具体动作。' },
          { id: 'methodology', type: 'followup', required: true, question: '如果重新做一遍，你会保留什么动作，调整什么动作？', why: '验证复盘能力，而不只是描述经历。', expected_signal: '能从结果反推方法。' },
        ],
      },
      {
        id: 'risk',
        title: '风险与稳定性验证',
        goal: '验证离职原因、短板、数据真实性和协作风险。',
        items: [
          { id: 'leave_reason', type: 'must', required: true, question: '你为什么考虑离开上一段工作，下一份工作最看重什么？', why: '识别稳定性和真实诉求。', expected_signal: '动机合理，与岗位供给匹配。' },
          { id: 'data_proof', type: 'followup', required: true, question: '刚才提到的关键数据是否有复盘表、后台截图或业务口径可以二面补充？', why: '避免项目数据无法核验。', expected_signal: '愿意提供材料，口径稳定。' },
          { id: 'collaboration', type: 'followup', required: false, question: '遇到业务、主播、投手或团队成员不配合时，你通常怎么推动？', why: '验证跨角色协同和推动力。', expected_signal: '有具体沟通策略。' },
        ],
      },
    ],
    closing_checklist: [
      '候选人姓名是否确认',
      '当前薪资、期望薪资是否确认',
      '到岗时间是否确认',
      '关键项目数据是否重复确认',
      '个人职责与团队成果是否拆清',
      '下一轮需要追问的问题是否说明',
    ],
  };
  script.script_text = scriptMarkdown(script);
  return script;
}

function safeTranscriptPayload(recording) {
  if (!recording) throw new Error('interview recording not found');
  const transcriptPath = recording.transcript_txt_path;
  if (!transcriptPath) throw new Error('该录音没有 transcript.txt 路径。');
  const loaded = readControlledTextFile(transcriptPath, 'transcript_txt', { root: LOCAL_INTERVIEW_OUTPUT_ROOT });
  let canonical = null;
  if (recording.transcript_json_path) {
    const json = readControlledTextFile(
      recording.transcript_json_path,
      'transcript_json',
      { root: LOCAL_INTERVIEW_OUTPUT_ROOT },
    );
    canonical = readCanonicalTranscript(json.text);
  }
  if (!canonical && recording.transcript_srt_path) {
    const srt = readControlledTextFile(
      recording.transcript_srt_path,
      'transcript_srt',
      { root: LOCAL_INTERVIEW_OUTPUT_ROOT },
    );
    try { canonical = buildCanonicalTranscript({ srt: srt.text }); } catch {}
  }
  return {
    path: loaded.path,
    text: loaded.text,
    size: loaded.stat.size,
    updated_at: loaded.stat.mtime.toISOString(),
    source_kind: 'asr',
    review_status: canonical ? canonical.review_status : 'unreviewed',
    accuracy_label: canonical ? canonical.accuracy_label : ASR_TRANSCRIPT_ACCURACY_LABEL,
    cue_count: canonical ? canonical.cue_count : 0,
    low_confidence_cue_count: canonical ? canonical.low_confidence_cue_count : 0,
    cues: canonical ? canonical.cues : [],
  };
}

// 批量评级进度（内存里存，进程重启即清空——重启后重跑即可）。
// jobId -> { status:'running'|'done'|'error', done, total, summary, error, startedAt, finishedAt }
const rateProgress = new Map();

// 深度画像生成进度（同 rateProgress 模式：后台异步跑，前端轮询）。
// jobId -> { status:'running'|'done'|'error', error, startedAt, finishedAt }
const deepProgress = new Map();

// 单人评估防重复点：正在评的 candidateId。
const assessRunning = new Set();
const assessmentAiRunning = new Set();
let localInterviewJob = null;
const backgroundChildren = new Set();
let shuttingDown = false;
let shutdownPromise = null;

// Reads a folder of screenshots with the model and hands the result to the
// import pipeline as a file.
//
// The key lives in this process and the pipeline runs in a child that must
// never see it, so the reads happen here and travel as data. Nothing is spawned
// until every screenshot has been read: a child started earlier would have
// nothing to do but wait, and a failure midway would leave a half-populated
// batch behind.
async function runAiScreenshotReads(snapshot, state, actorId, options = {}) {
  const dir = snapshot.source_dir;
  const files = snapshot.items.map((item) => item.source_path);
  const selectedImageIds = snapshot.items.map((item) => item.image_id);
  const approvedItemsByPath = new Map(snapshot.items.map((item) => [path.resolve(item.source_path), item]));
  let done = 0;
  const note = () => screenshotImportProgress.writeProgress({
    ...screenshotImportProgress.readProgress(),
    status: 'running',
    stage: 'ocr',
    image_count: files.length,
    ocr_done: done,
    ocr_total: files.length,
    message: `正在识别第 ${Math.min(done + 1, files.length)}/${files.length} 张截图。`,
  });
  note();

  const result = await readScreenshotsWithAi(async (input) => {
    const approvedItem = approvedItemsByPath.get(path.resolve(String(input.sourceFile || '')));
    assertApprovedScreenshotInput(approvedItem, input);
    const authorizationBinding = {
      provider: state.connection.provider,
      base_url: state.connection.base_url,
      model: state.connection.model,
      operation: options.retry ? 'retry' : 'initial_import',
      target_id: snapshot.target_id,
      material_sha256: snapshot.material_sha256,
      image_id: approvedItem.image_id,
      source_sha256: approvedItem.source_sha256,
      size_bytes: approvedItem.size_bytes,
    };
    // A grant per read, because each is single-use and the reads run
    // concurrently.
    return f009Runtime.readImageJson(input, issueExternalAiAuthorization({
      purpose: SCREENSHOT_FIELD_PURPOSE,
      confirmed: true,
      requestedBy: actorId,
      binding: authorizationBinding,
    }), authorizationBinding);
  }, files, {
    onItemSettled: (read, index) => {
      screenshotAiImportState.recordSettled(
        state.run_id,
        snapshot.items[index].image_id,
        read,
      );
      done += 1;
      note();
    },
  });
  let assembled = result;
  let handoffFiles = files;
  let evidenceScope = `ai.${state.run_id}.${snapshot.material_sha256.slice(0, 24)}`;
  if (options.retry) {
    evidenceScope = `retry.${state.run_id}.${snapshot.material_sha256.slice(0, 24)}`;
  }
  // Retry stages only the explicitly selected, freshly approved pages. Folding
  // historical succeeded reads back in would create a second combined draft
  // while the original pending draft remains reviewable. HR can select a failed
  // first page together with its following unrecognized continuation pages.
  screenshotAiImportState.finalize(state.run_id, result, selectedImageIds);
  const { drafts, summary } = assembled;

  const readsPath = path.join(
    path.resolve(process.env.HRBOSS_DATA_DIR || path.join(PROJECT_ROOT, 'data')),
    'import',
    `ai-screenshot-reads-${state.run_id}-${options.retry ? 'retry' : 'initial'}.json`,
  );
  writePrivateFile(readsPath, `${JSON.stringify({
    drafts,
    summary,
    source_files: handoffFiles.map((file) => path.basename(file)),
    source_manifest: snapshot.items.map((item) => ({
      file_name: item.source_name,
      source_sha256: item.source_sha256,
      size_bytes: item.size_bytes,
    })),
    evidence_scope: evidenceScope,
  }, null, 2)}\n`);

  if (!drafts.length) {
    // Every screenshot was a list page, unreadable, or nameless. Saying so beats
    // handing the pipeline an empty batch and letting it report a bare zero.
    screenshotImportProgress.writeProgress({
      ...screenshotImportProgress.readProgress(),
      status: 'done',
      stage: 'done',
      image_count: files.length,
      detail_draft_count: 0,
      message: `${files.length} 张截图里没有可导入的候选人详情页：跳过列表页 ${summary.skipped_list_count} 张，未识别 ${summary.unrecognized_count} 张，调用失败 ${summary.failed_count} 张。`,
      finished_at: nowIso(),
      error: null,
      result: null,
    });
    try { fs.rmSync(readsPath, { force: true }); } catch {}
    return publicScreenshotAiState(screenshotAiImportState.requireRun(state.run_id), { progress: screenshotImportProgress.readProgress() });
  }

  screenshotImportProgress.writeProgress({
    ...screenshotImportProgress.readProgress(),
    stage: 'staging_review',
    image_count: files.length,
    detail_draft_count: drafts.length,
    message: `已识别 ${drafts.length} 个候选人，正在暂存草稿。`,
  });
  spawnDetached(
    "src/start-screenshot-import.js",
    [`--dir=${dir}`, `--ai-reads=${readsPath}`, `--run-id=${state.run_id}`],
    {
      progressStore: screenshotImportProgress,
      runId: state.run_id,
      failOnPrematureExit: true,
      failureMessage: '截图草稿暂存子进程异常退出，请重新发起导入。',
    },
  );
  return publicScreenshotAiState(screenshotAiImportState.requireRun(state.run_id), { progress: screenshotImportProgress.readProgress() });
}

function screenshotImportEngine(platform = process.platform) {
  return platform === 'darwin' ? 'macos_vision' : 'external_ai';
}

function spawnDetached(script, args = [], options = {}) {
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, script), ...args], {
    cwd: PROJECT_ROOT,
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  backgroundChildren.add(child);
  if (options.progressStore) {
    options.progressStore.writeProgress({
      ...options.progressStore.readProgress(),
      outer_pid: child.pid,
    });
  }
  child.once('error', (error) => {
    console.error(`${script} 启动失败：${error.message}`);
    backgroundChildren.delete(child);
    if (options.progressStore) {
      const current = options.progressStore.readProgress();
      if (ACTIVE_PROGRESS_STATUSES.includes(current.status)
          && (!current.outer_pid || Number(current.outer_pid) === Number(child.pid))) {
        options.progressStore.writeProgress({
          ...current,
          status: 'error',
          error: `${script} 启动失败。`,
          message: '后台任务启动失败；不会自动重试。',
          finished_at: nowIso(),
        });
      }
    }
  });
  child.once('exit', () => {
    if (options.failOnPrematureExit && options.progressStore) {
      const current = options.progressStore.readProgress();
      if (ACTIVE_PROGRESS_STATUSES.includes(current.status)
          && (!options.runId || current.run_id === options.runId)) {
        options.progressStore.writeProgress({
          ...current,
          status: 'error',
          stage: 'error',
          error: options.failureMessage || `${script} 未完成即退出。`,
          message: options.failureMessage || '后台子进程异常退出，请重试。',
          finished_at: nowIso(),
        });
      }
    }
    backgroundChildren.delete(child);
  });
  child.unref();
  return child.pid;
}

function nowIso() {
  return new Date().toISOString();
}

function createLiveAudioStderrDemux({ onTelemetry, onLog }) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let ended = false;

  const consumeLine = (lineWithEnding) => {
    const line = lineWithEnding.replace(/\r?\n$/, '');
    if (line.startsWith(LIVE_AUDIO_TELEMETRY_PREFIX)) {
      const telemetry = parseLiveAudioTelemetryLine(line);
      if (telemetry) {
        try { onTelemetry(telemetry); } catch {}
      }
      // Telemetry protocol lines are never persisted, including malformed
      // frames. They contain no useful operator diagnostics.
      return;
    }
    try { onLog(lineWithEnding); } catch {}
  };

  const drain = () => {
    let newlineIndex = pending.indexOf('\n');
    while (newlineIndex >= 0) {
      consumeLine(pending.slice(0, newlineIndex + 1));
      pending = pending.slice(newlineIndex + 1);
      newlineIndex = pending.indexOf('\n');
    }
  };

  return {
    push(chunk) {
      if (ended) return;
      pending += decoder.write(chunk);
      drain();
      // Normal stderr lines and telemetry frames are short. Bound a malformed
      // line so a noisy child cannot make the action server retain it forever.
      if (pending.length > 256 * 1024) {
        if (!pending.startsWith(LIVE_AUDIO_TELEMETRY_PREFIX)) {
          try { onLog(pending); } catch {}
        }
        pending = '';
      }
    },
    end() {
      if (ended) return;
      ended = true;
      pending += decoder.end();
      drain();
      if (pending) consumeLine(pending);
      pending = '';
    },
  };
}

function compactLiveAudio(job) {
  if (!job || job.status !== 'running' || !['record', 'mic-check'].includes(job.mode)) return null;
  const telemetry = sanitizeLiveAudioTelemetry(job.liveAudio);
  if (!telemetry) return null;
  return {
    ...telemetry,
    active: telemetry.active && !job.stopRequested,
  };
}

function compactLocalInterviewJob(job) {
  if (!job) return { status: 'idle' };
  const startedMs = job.startedAt ? Date.parse(job.startedAt) : NaN;
  const finishedMs = job.finishedAt ? Date.parse(job.finishedAt) : NaN;
  const elapsedSeconds = Number.isFinite(startedMs)
    ? Math.max(0, Math.round(((Number.isFinite(finishedMs) ? finishedMs : Date.now()) - startedMs) / 1000))
    : null;
  return {
    id: job.id,
    client_request_id: job.clientRequestId || null,
    status: job.status,
    mode: job.mode,
    topic: job.topic,
    source_path: job.sourcePath || null,
    out_dir: job.outDir,
    log_path: job.logPath,
    started_at: job.startedAt,
    finished_at: job.finishedAt || null,
    elapsed_seconds: elapsedSeconds,
    planned_duration_seconds: job.duration || null,
    stop_requested: !!job.stopRequested,
    stop_failed: !!job.stopFailed,
    cleanup_pending: !!job.cleanupPending,
    binding_pending: !!job.bindingPending,
    transcription_retryable: job.transcriptionRetryable === true,
    termination_unconfirmed: !!job.terminationUnconfirmed,
    persistent_state_failed: !!job.persistentStateFailed,
    live_audio: compactLiveAudio(job),
    bind_candidate_id: job.bindCandidateId || null,
    bind_job_id: job.bindJobId || null,
    bind_round: Number.isInteger(Number(job.bindRound)) && Number(job.bindRound) > 0
      ? Number(job.bindRound)
      : null,
    bind_consent_id: Number.isInteger(Number(job.bindConsentId)) && Number(job.bindConsentId) > 0
      ? Number(job.bindConsentId)
      : null,
    mic_check_consent_confirmed: job.micCheckConsentConfirmed === true,
    message: job.message || '',
    error: job.error || null,
    result: job.result || null,
  };
}

function localInterviewOutDir(_topic, options = {}) {
  const jobId = String(options.jobId || '').trim();
  const ownerToken = String(options.ownerToken || '').trim();
  if (!jobId || !/^[a-f0-9-]{16,100}$/i.test(ownerToken)) {
    throw new Error('local interview output ownership is required');
  }
  const root = path.resolve(options.root || LOCAL_INTERVIEW_OUTPUT_ROOT);
  const realRoot = prepareInterviewMaterialDirectory(root, { root });
  const syncDirectory = options.syncDirectory || fsyncDirectory;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const nonce = crypto.randomBytes(16).toString('hex');
    // Keep the filesystem path opaque. Candidate names, job titles and interview
    // topics belong in consent-governed content, never in directory metadata.
    const candidate = path.join(realRoot, nonce);
    try {
      fs.mkdirSync(candidate, { recursive: false, mode: 0o700 });
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    const outDir = hardenPrivateDir(prepareInterviewMaterialDirectory(candidate, { root }));
    const ownerPath = path.join(outDir, LOCAL_INTERVIEW_OWNER_MARKER);
    const ownerPayload = `${JSON.stringify({
      schema_version: LOCAL_INTERVIEW_OWNER_SCHEMA,
      job_id: jobId,
      owner_token: ownerToken,
      created_at: nowIso(),
    })}\n`;
    let descriptor;
    try {
      descriptor = fs.openSync(
        ownerPath,
        fs.constants.O_WRONLY
          | fs.constants.O_CREAT
          | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      fs.writeFileSync(descriptor, ownerPayload, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      ensurePrivateFile(ownerPath);
      // The owner file and both directory entries are part of the durable
      // starting marker. A state file is never written, and no worker can be
      // spawned, unless all three barriers succeed.
      syncDirectory(outDir);
      syncDirectory(realRoot);
    } catch (error) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch {}
      }
      throw error;
    }
    return outDir;
  }
  throw new Error('could not allocate a unique local interview output directory');
}

function verifyLocalInterviewOutDirOwner(outDir, options = {}) {
  const jobId = String(options.jobId || '').trim();
  const ownerToken = String(options.ownerToken || '').trim();
  const root = path.resolve(options.root || LOCAL_INTERVIEW_OUTPUT_ROOT);
  if (!jobId || !ownerToken || !outDir || !fs.existsSync(outDir)) {
    return { ok: false, error: 'local interview output ownership is missing' };
  }
  let controlledDir;
  try {
    controlledDir = prepareInterviewMaterialDirectory(outDir, { root });
    const markerPath = path.join(controlledDir, LOCAL_INTERVIEW_OWNER_MARKER);
    const markerStat = fs.lstatSync(markerPath);
    if (markerStat.isSymbolicLink() || !markerStat.isFile() || markerStat.size <= 0 || markerStat.size > 4096) {
      throw new Error('local interview output ownership marker is invalid');
    }
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    const descriptor = fs.openSync(markerPath, fs.constants.O_RDONLY | noFollow);
    let marker;
    try {
      marker = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    } finally {
      fs.closeSync(descriptor);
    }
    if (marker.schema_version !== LOCAL_INTERVIEW_OWNER_SCHEMA
        || marker.job_id !== jobId
        || marker.owner_token !== ownerToken) {
      throw new Error('local interview output owner does not match this job');
    }
    return { ok: true, outDir: controlledDir, markerPath };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function writeLocalInterviewPersistentState(job, state, options = {}) {
  if (!job || !job.outDir || !job.id || !job.ownerToken) {
    throw new Error('local interview job ownership is required for persistent state');
  }
  const ownership = verifyLocalInterviewOutDirOwner(job.outDir, {
    jobId: job.id,
    ownerToken: job.ownerToken,
    root: options.root,
  });
  if (!ownership.ok) throw new Error(ownership.error);
  const target = path.join(ownership.outDir, LOCAL_INTERVIEW_STATE_MARKER);
  if (fs.existsSync(target)) {
    const targetStat = fs.lstatSync(target);
    if (targetStat.isDirectory()) throw new Error('local interview state marker cannot be a directory');
  }
  const payload = `${JSON.stringify({
    schema_version: LOCAL_INTERVIEW_STATE_SCHEMA,
    job_id: job.id,
    state,
    mode: job.mode || null,
    topic: job.topic || null,
    bind_candidate_id: job.bindCandidateId || null,
    bind_job_id: job.bindJobId || null,
    bind_round: Number.isInteger(Number(job.bindRound)) && Number(job.bindRound) > 0
      ? Number(job.bindRound)
      : null,
    bind_consent_id: Number.isInteger(Number(job.bindConsentId)) && Number(job.bindConsentId) > 0
      ? Number(job.bindConsentId)
      : null,
    process_group_id: Number.isSafeInteger(job.processGroupId) ? job.processGroupId : null,
    guardian_managed: job.guardianManaged === true,
    guardian_instance_id: job.guardianInstanceId || null,
    cleanup_pending: !!job.cleanupPending,
    binding_pending: !!job.bindingPending,
    transcription_retryable: job.transcriptionRetryable === true,
    termination_unconfirmed: !!job.terminationUnconfirmed,
    updated_at: nowIso(),
  })}\n`;
  const temporary = path.join(ownership.outDir, localInterviewStateTempArtifactName());
  durableAtomicWriteFile(target, payload, {
    mode: 0o600,
    temporaryName: path.basename(temporary),
    ...(options.atomicWriteOptions || {}),
  });
  return target;
}

function localInterviewStateTempArtifactName(nonce = crypto.randomBytes(16).toString('hex')) {
  if (!/^[a-f0-9]{32}$/.test(String(nonce))) {
    throw new Error('local interview state transaction nonce is invalid');
  }
  return `${LOCAL_INTERVIEW_STATE_MARKER}.${nonce}.tmp`;
}

function persistLocalInterviewState(job, state, options = {}) {
  try {
    writeLocalInterviewPersistentState(job, state, options);
    job.persistentStateFailed = false;
    job.persistentStateError = null;
    return true;
  } catch (error) {
    job.persistentStateFailed = true;
    job.persistentStateError = error.message;
    return false;
  }
}

function readLocalInterviewPersistentJson(filePath, maxBytes = 8192) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > maxBytes) {
    throw new Error('local interview persistent marker is invalid');
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } finally {
    fs.closeSync(descriptor);
  }
}

function recoverPersistedLocalInterviewBlocker(options = {}) {
  const root = path.resolve(options.root || LOCAL_INTERVIEW_OUTPUT_ROOT);
  if (!fs.existsSync(root)) return null;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`cannot inspect persisted local interview state: ${error.message}`);
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const outDir = path.join(root, entry.name);
    const statePath = path.join(outDir, LOCAL_INTERVIEW_STATE_MARKER);
    try {
      const childEntries = fs.readdirSync(outDir);
      const temporaryStates = childEntries.filter((name) => LOCAL_INTERVIEW_STATE_TEMP_ARTIFACT.test(name));
      if (temporaryStates.length > 1) throw new Error('multiple local interview state transactions are unresolved');
      let persistentStatePath = statePath;
      if (temporaryStates.length === 1) {
        persistentStatePath = path.join(outDir, temporaryStates[0]);
      } else if (!fs.existsSync(statePath)) {
        if (childEntries.includes(LOCAL_INTERVIEW_OWNER_MARKER)) {
          throw new Error('owned local interview directory is missing its persistent state marker');
        }
        continue;
      }
      const state = readLocalInterviewPersistentJson(persistentStatePath);
      if (state.schema_version !== LOCAL_INTERVIEW_STATE_SCHEMA
          || !state.job_id) {
        throw new Error('local interview persistent state cannot be trusted');
      }
      const owner = readLocalInterviewPersistentJson(path.join(outDir, LOCAL_INTERVIEW_OWNER_MARKER), 4096);
      const ownership = verifyLocalInterviewOutDirOwner(outDir, {
        jobId: state.job_id,
        ownerToken: owner.owner_token,
        root,
      });
      if (!ownership.ok) throw new Error(ownership.error);
      if (persistentStatePath !== statePath) {
        fs.renameSync(persistentStatePath, statePath);
        ensurePrivateFile(statePath);
      }
      if (!LOCAL_INTERVIEW_BLOCKING_STATES.has(state.state)) continue;
      const cleanupReady = state.state === 'cleanup_failed' || state.state === 'cleanup_in_progress';
      const bindingPending = state.state === 'binding_in_progress' || state.state === 'bind_failed';
      const transcriptionRetryable = state.state === 'transcription_failed';
      const transcriptionPending = [
        'transcription_in_progress',
        'transcription_retry_starting',
        'transcription_retry_running',
      ].includes(state.state);
      return {
        id: state.job_id,
        status: 'error',
        mode: state.mode || 'record',
        topic: state.topic || 'recovered-local-interview',
        outDir: ownership.outDir,
        logPath: path.join(ownership.outDir, 'run.log'),
        startedAt: state.updated_at || nowIso(),
        finishedAt: null,
        bindCandidateId: state.bind_candidate_id || '',
        bindJobId: state.bind_job_id || null,
        bindRound: Number.isInteger(Number(state.bind_round)) && Number(state.bind_round) > 0
          ? Number(state.bind_round)
          : null,
        bindConsentId: Number.isInteger(Number(state.bind_consent_id)) && Number(state.bind_consent_id) > 0
          ? Number(state.bind_consent_id)
          : null,
        micCheckConsentConfirmed: state.mic_check_consent_confirmed === true,
        ownerToken: owner.owner_token,
        processGroup: true,
        processGroupId: Number.isSafeInteger(state.process_group_id) ? state.process_group_id : null,
        guardianManaged: state.guardian_managed === true,
        guardianInstanceId: state.guardian_instance_id || null,
        childStreamsClosed: cleanupReady || bindingPending || transcriptionRetryable,
        logClosed: cleanupReady || bindingPending || transcriptionRetryable,
        cleanupPending: cleanupReady,
        bindingPending,
        transcriptionRetryable,
        terminationUnconfirmed: transcriptionPending
          || (!cleanupReady && !bindingPending && !transcriptionRetryable),
        stopRequested: true,
        stopFailed: !bindingPending && !transcriptionRetryable,
        abortRequested: !bindingPending && !transcriptionRetryable,
        finalized: cleanupReady || bindingPending || transcriptionRetryable,
        recoveredPersistentBlocker: true,
        recoveredState: state.state,
        message: transcriptionRetryable
          ? '上次录音已完成，但本地转写失败；原录音已安全保留，可由 HR 手动重试转写或明确丢弃。'
          : (transcriptionPending
            ? '检测到录音停止后的转写任务被中断；正在确认本地进程已经结束，原录音不会被自动删除。'
            : bindingPending
          ? '检测到已完成录音尚未成功绑定到对应面试 Session；已保留材料并阻止新录音，系统将按原授权与轮次重试。'
          : (cleanupReady
            ? '检测到上次退出前未完成材料删除失败；已阻止新录音，系统将安全重试清理。'
            : '检测到上次退出时本地录音终止状态未确认；已阻止新录音，请勿继续面试。')),
        error: transcriptionRetryable
          ? 'LOCAL_INTERVIEW_TRANSCRIPTION_FAILED'
          : (transcriptionPending
            ? 'LOCAL_INTERVIEW_TRANSCRIPTION_INTERRUPTED'
            : bindingPending
          ? 'LOCAL_INTERVIEW_BIND_PENDING'
          : (cleanupReady
            ? 'LOCAL_INTERVIEW_CLEANUP_PENDING'
            : 'LOCAL_INTERVIEW_TERMINATION_UNCONFIRMED')),
        result: null,
        liveAudio: null,
        child: null,
      };
    } catch (error) {
      return {
        id: `recovery-blocker:${entry.name}`,
        status: 'error',
        mode: 'record',
        topic: 'untrusted-local-interview-state',
        outDir,
        logPath: path.join(outDir, 'run.log'),
        startedAt: nowIso(),
        finishedAt: null,
        cleanupPending: true,
        terminationUnconfirmed: true,
        stopRequested: true,
        stopFailed: true,
        abortRequested: true,
        finalized: false,
        recoveredPersistentBlocker: true,
        recoveredState: 'untrusted',
        message: '检测到无法验证的本地录音残留状态；已阻止新录音，未执行自动删除。',
        error: `LOCAL_INTERVIEW_PERSISTENT_STATE_INVALID: ${error.message}`,
        result: null,
        liveAudio: null,
        child: null,
      };
    }
  }
  return null;
}

function retryRecoveredLocalInterviewCleanup(job, options = {}) {
  if (!job || !job.recoveredPersistentBlocker
      || !['cleanup_in_progress', 'cleanup_failed'].includes(job.recoveredState)
      || !job.cleanupPending || job.terminationUnconfirmed) return false;
  if (!persistLocalInterviewState(job, 'cleanup_in_progress', options)) {
    job.stopFailed = true;
    job.cleanupPending = true;
    job.message = '无法持久记录材料清理状态；未继续删除，新的录音任务保持阻止。';
    return false;
  }
  const cleanup = cleanupAbortedLocalInterviewArtifacts(job.outDir, {
    jobId: job.id,
    ownerToken: job.ownerToken,
    root: options.root,
  });
  if (!cleanup.ok) {
    job.stopFailed = true;
    job.cleanupPending = true;
    job.message = '上次录音进程已停止，但删除未完成材料仍失败；新录音保持阻止。';
    job.error = `incomplete interview artifact cleanup failed: ${cleanup.failures.map((item) => item.file || item.error).join(', ')}`;
    persistLocalInterviewState(job, 'cleanup_failed', options);
    return false;
  }
  localInterviewJob = {
    ...job,
    status: 'cancelled',
    cleanupPending: false,
    terminationUnconfirmed: false,
    stopFailed: false,
    persistentStateFailed: false,
    persistentStateError: null,
    finishedAt: nowIso(),
    message: '已完成上次退出遗留的未完成材料清理。',
    error: null,
  };
  return true;
}

function retryRecoveredLocalInterviewBinding(job, options = {}) {
  if (!job
      || !job.recoveredPersistentBlocker
      || !['binding_in_progress', 'bind_failed'].includes(job.recoveredState)
      || !job.bindingPending
      || job.terminationUnconfirmed) return false;
  if (!persistLocalInterviewState(job, 'binding_in_progress', options)) {
    job.status = 'error';
    job.bindingPending = true;
    job.error = `LOCAL_INTERVIEW_STATE_PERSIST_FAILED: ${job.persistentStateError}`;
    job.message = '无法持久记录录音绑定事务；未写入面试 Session，新的录音任务保持阻止。';
    return false;
  }
  job.recoveredState = 'binding_in_progress';
  try {
    const summaryPath = path.join(job.outDir, 'summary.json');
    const result = readLocalInterviewSummary(summaryPath).summary;
    const boundRecording = autoBindLocalInterviewResult({
      result,
      bindCandidateId: job.bindCandidateId,
      bindJobId: job.bindJobId,
      bindRound: job.bindRound,
      bindConsentId: job.bindConsentId,
    });
    job.bindingPending = false;
    if (!persistLocalInterviewState(job, 'completed', options)) {
      job.bindingPending = true;
      job.status = 'error';
      job.error = `LOCAL_INTERVIEW_STATE_PERSIST_FAILED: ${job.persistentStateError}`;
      job.message = '录音已绑定到原面试轮次，但无法持久记录完成状态；新的录音任务保持阻止，系统将安全重试。';
      persistLocalInterviewState(job, 'bind_failed', options);
      return false;
    }
    localInterviewJob = {
      ...job,
      status: 'done',
      bindingPending: false,
      cleanupPending: false,
      terminationUnconfirmed: false,
      persistentStateFailed: false,
      persistentStateError: null,
      finishedAt: nowIso(),
      message: '已按原候选人、岗位、轮次和授权记录完成录音材料绑定。',
      error: null,
      result: {
        ...result,
        autoBoundRecording: boundRecording || null,
      },
    };
    return true;
  } catch (error) {
    if (terminalLocalInterviewBindingError(error)) {
      const discarded = discardTerminalLocalInterviewBinding(job, error, options);
      localInterviewJob = {
        ...job,
        status: discarded.cleanup.ok ? 'cancelled' : 'error',
        bindingPending: false,
        cleanupPending: !discarded.cleanup.ok,
        terminationUnconfirmed: false,
        stopFailed: !discarded.cleanup.ok,
        persistentStateFailed: false,
        persistentStateError: null,
        finishedAt: nowIso(),
        message: discarded.cleanup.ok
          ? '原面试轮次已关闭或撤回；重启恢复时已删除未绑定的录音与转写材料。'
          : '原面试轮次已关闭或撤回，但未绑定材料删除失败；新的本地任务保持阻止。',
        error: discarded.cleanup.ok
          ? null
          : `LOCAL_INTERVIEW_TERMINAL_CLEANUP_FAILED: ${error.message}`,
        outDir: discarded.cleanup.ok ? null : job.outDir,
        logPath: discarded.cleanup.ok ? null : job.logPath,
        result: discarded.result,
      };
      return discarded.cleanup.ok;
    }
    job.status = 'error';
    job.bindingPending = true;
    job.cleanupPending = false;
    job.terminationUnconfirmed = false;
    job.error = `LOCAL_INTERVIEW_BIND_FAILED: ${error.message}`;
    job.message = '录音材料仍未绑定到原面试轮次；材料已保留，新的录音任务保持阻止。';
    persistLocalInterviewState(job, 'bind_failed', options);
    return false;
  }
}

function retainedLocalInterviewContextValid(job) {
  if (!job
      || !job.bindCandidateId
      || !Number.isSafeInteger(Number(job.bindJobId))
      || !Number.isSafeInteger(Number(job.bindRound))
      || !Number.isSafeInteger(Number(job.bindConsentId))) return false;
  try {
    db.assertInterviewRoundRecordingWritable({
      candidateId: job.bindCandidateId,
      jobId: job.bindJobId,
      round: job.bindRound,
    });
    const consent = db.getInterviewConsent({
      candidateId: job.bindCandidateId,
      jobId: job.bindJobId,
    });
    return !!consent
      && consent.status === 'active'
      && consent.revocation_pending !== true;
  } catch {
    return false;
  }
}

function preservedLocalInterviewRecording(job, options = {}) {
  if (!job || !job.outDir || !job.id || !job.ownerToken) return null;
  const ownership = verifyLocalInterviewOutDirOwner(job.outDir, {
    jobId: job.id,
    ownerToken: job.ownerToken,
    root: options.root,
  });
  if (!ownership.ok) return null;
  const recordingPath = path.join(ownership.outDir, 'recording.wav');
  try {
    return validateInterviewMaterialFile(recordingPath, 'audio', {
      root: options.root || LOCAL_INTERVIEW_OUTPUT_ROOT,
    }).path;
  } catch {
    return null;
  }
}

function preserveFailedLocalInterviewTranscription(job, processError, options = {}) {
  const recordingPath = preservedLocalInterviewRecording(job, options);
  if (!recordingPath || !retainedLocalInterviewContextValid(job)) return null;
  const cleanup = cleanupOwnedLocalInterviewDerivedArtifacts({
    outDir: job.outDir,
    root: options.root || LOCAL_INTERVIEW_OUTPUT_ROOT,
    jobId: job.id,
    ownerToken: job.ownerToken,
  });
  job.transcriptionRetryable = true;
  job.cleanupPending = false;
  job.bindingPending = false;
  job.terminationUnconfirmed = false;
  job.stopFailed = false;
  const persisted = persistLocalInterviewState(job, 'transcription_failed', options);
  return {
    ok: cleanup.ok && persisted,
    cleanup,
    persisted,
    recordingPath,
    processError,
  };
}

function discardPreservedLocalInterviewRecording(job, reason = '', options = {}) {
  if (!job
      || job.transcriptionRetryable !== true
      || !localInterviewTaskScopeMatches(job, options.scope || {})) {
    return { matched: false, stopped: false, job: compactLocalInterviewJob(job) };
  }
  const cleanup = cleanupFailedLocalInterviewResult(job, {
    groupState: 'gone',
    root: options.root,
  });
  if (!cleanup.ok) {
    job.status = 'error';
    job.cleanupPending = true;
    job.stopFailed = true;
    job.message = '保留录音的删除未能完成；系统继续阻止新录音，请重试明确丢弃。';
    job.error = `preserved recording cleanup failed: ${cleanup.failures.map((item) => item.file || item.error).join(', ')}`;
    return { matched: true, stopped: false, cleanup, job: compactLocalInterviewJob(job) };
  }
  localInterviewJob = {
    ...job,
    status: 'cancelled',
    transcriptionRetryable: false,
    cleanupPending: false,
    bindingPending: false,
    terminationUnconfirmed: false,
    persistentStateFailed: false,
    persistentStateError: null,
    stopFailed: false,
    abortRequested: true,
    finalized: true,
    finishedAt: nowIso(),
    outDir: null,
    logPath: null,
    message: reason || 'HR 已明确丢弃转写失败后保留的原录音。',
    error: null,
    result: null,
  };
  return { matched: true, stopped: true, cleanup, job: compactLocalInterviewJob(localInterviewJob) };
}

function recoveredLocalInterviewProcessGroupState(job, options = {}) {
  const platform = options.platform || process.platform;
  const processGroupId = Number(job && job.processGroupId);
  if (platform === 'win32'
      || !job
      || job.processGroup !== true
      || !Number.isSafeInteger(processGroupId)
      || processGroupId <= 0) return 'unknown';
  const kill = options.kill || process.kill;
  try {
    // Probe only. Recovery must never signal a PID/PGID that could have been
    // reused after a crash or restart.
    kill(-processGroupId, 0);
    return 'alive';
  } catch (error) {
    if (error && error.code === 'ESRCH') return 'gone';
    return 'unknown';
  }
}

function reconcileRecoveredLocalInterviewTranscription(job, options = {}) {
  if (!job
      || !job.recoveredPersistentBlocker
      || ![
        'transcription_in_progress',
        'transcription_retry_starting',
        'transcription_retry_running',
      ].includes(job.recoveredState)
      || !job.terminationUnconfirmed) return false;
  if (recoveredLocalInterviewProcessGroupState(job, options) !== 'gone') return false;

  job.childStreamsClosed = true;
  job.logClosed = true;
  job.terminationUnconfirmed = false;
  job.cleanupPending = false;
  job.bindingPending = false;
  job.transcriptionRetryable = true;
  job.stopFailed = false;
  job.abortRequested = false;
  job.finalized = true;
  job.recoveredState = 'transcription_failed';
  if (!preservedLocalInterviewRecording(job, options) || !retainedLocalInterviewContextValid(job)) {
    job.transcriptionRetryable = false;
    job.cleanupPending = true;
    job.recoveredState = 'cleanup_failed';
    if (!persistLocalInterviewState(job, 'cleanup_failed', options)) return false;
    return retryRecoveredLocalInterviewCleanup(job, options);
  }
  cleanupOwnedLocalInterviewDerivedArtifacts({
    outDir: job.outDir,
    root: options.root || LOCAL_INTERVIEW_OUTPUT_ROOT,
    jobId: job.id,
    ownerToken: job.ownerToken,
  });
  if (!persistLocalInterviewState(job, 'transcription_failed', options)) {
    job.stopFailed = true;
    job.message = '已确认转写进程结束并保留原录音，但无法持久化可重试状态；新录音保持阻止。';
    return false;
  }
  localInterviewJob = {
    ...job,
    status: 'error',
    finishedAt: nowIso(),
    message: '上次转写被中断；原录音已安全保留，可由 HR 手动重试转写或明确丢弃。',
    error: 'LOCAL_INTERVIEW_TRANSCRIPTION_INTERRUPTED',
  };
  return false;
}

function reconcileRecoveredLocalInterviewTermination(job, options = {}) {
  if (!job
      || !job.recoveredPersistentBlocker
      || job.recoveredState === 'cleanup_failed'
      || job.recoveredState === 'untrusted'
      || !job.terminationUnconfirmed) return false;
  if (recoveredLocalInterviewProcessGroupState(job, options) !== 'gone') return false;

  job.childStreamsClosed = true;
  job.logClosed = true;
  job.terminationUnconfirmed = false;
  job.cleanupPending = true;
  job.finalized = true;
  job.recoveredState = 'cleanup_failed';
  job.message = '已确认上次录音进程组不存在；正在清理其未完成本地材料。';
  job.error = null;
  if (!persistLocalInterviewState(job, 'cleanup_failed', options)) {
    job.stopFailed = true;
    job.message = '已确认上次录音进程组不存在，但无法持久化清理状态；新录音保持阻止。';
    return false;
  }
  return retryRecoveredLocalInterviewCleanup(job, options);
}

function guardianRegistryProcessState(registry, options = {}) {
  const guardianPid = Number(registry && registry.guardian_pid);
  if (!Number.isSafeInteger(guardianPid) || guardianPid <= 0) return 'unknown';
  const signalProcess = options.guardianPidKill || process.kill;
  try {
    // This PID probe is intentionally independent from the negative-PGID
    // recorder probe. PID reuse, EPERM and every ambiguous result retain the
    // cleanup lease; only an explicit ESRCH can retire it.
    signalProcess(guardianPid, 0);
    return 'alive';
  } catch (error) {
    if (error && error.code === 'ESRCH') return 'gone';
    return 'unknown';
  }
}

function refreshPersistedLocalInterviewBlocker(options = {}) {
  const maxPasses = Math.max(1, Number(options.maxPasses) || 100);
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const recovered = recoverPersistedLocalInterviewBlocker(options);
    if (!recovered) {
      if (localInterviewJob && localInterviewJob.recoveredPersistentBlocker) {
        localInterviewJob = {
          ...localInterviewJob,
          status: 'cancelled',
          cleanupPending: false,
          bindingPending: false,
          terminationUnconfirmed: false,
          stopFailed: false,
          abortRequested: false,
          finalized: true,
          recoveredPersistentBlocker: false,
          finishedAt: nowIso(),
          message: '上一实例的本地录音安全清理已完成。',
          error: null,
          result: null,
          outDir: null,
          logPath: null,
        };
      }
      return null;
    }
    localInterviewJob = recovered;
    let guardianLease = null;
    if (recovered.guardianManaged === true) {
      const registryPath = path.resolve(
        options.guardianRegistryPath || LOCAL_INTERVIEW_GUARDIAN_REGISTRY,
      );
      try {
        const registry = readGuardianRegistry(registryPath);
        if (registry) {
          const guardianState = guardianRegistryProcessState(registry, options);
          if (guardianState === 'gone') {
            const staleRemoved = removeGuardianRegistry(
              registryPath,
              registry.guardian_instance_id,
            );
            if (!staleRemoved) {
              guardianLease = {
                active: true,
                trusted: false,
                error: 'stale guardian registry changed or could not be removed',
              };
            }
          } else {
            guardianLease = {
              active: true,
              trusted: guardianState === 'alive'
                && registry.job_id === recovered.id
                && registry.guardian_instance_id === recovered.guardianInstanceId,
              error: guardianState === 'unknown'
                ? 'guardian process identity cannot be confirmed'
                : null,
            };
          }
        }
      } catch (error) {
        guardianLease = { active: true, trusted: false, error: error.message };
      }
    }
    if (guardianLease && guardianLease.active) {
      localInterviewJob = {
        ...recovered,
        cleanupPending: true,
        terminationUnconfirmed: true,
        stopRequested: true,
        stopFailed: !guardianLease.trusted,
        abortRequested: true,
        finalized: false,
        message: guardianLease.trusted
          ? '检测到上一实例的安全守护仍在终止进程并清理材料；新录音保持阻止，等待其释放清理租约。'
          : '检测到无法验证的本地录音守护租约；未并发清理材料，新录音保持阻止。',
        error: guardianLease.trusted
          ? 'LOCAL_INTERVIEW_GUARDIAN_CLEANUP_ACTIVE'
          : `LOCAL_INTERVIEW_GUARDIAN_REGISTRY_INVALID: ${guardianLease.error || 'guardian identity mismatch'}`,
      };
      return localInterviewJob;
    }
    const transcriptionPending = [
      'transcription_in_progress',
      'transcription_retry_starting',
      'transcription_retry_running',
    ].includes(recovered.recoveredState);
    if (recovered.recoveredState === 'transcription_failed') return recovered;
    const cleared = ['cleanup_in_progress', 'cleanup_failed'].includes(recovered.recoveredState)
      ? retryRecoveredLocalInterviewCleanup(recovered, options)
      : (['binding_in_progress', 'bind_failed'].includes(recovered.recoveredState)
        ? retryRecoveredLocalInterviewBinding(recovered, options)
        : (transcriptionPending
          ? reconcileRecoveredLocalInterviewTranscription(recovered, options)
          : reconcileRecoveredLocalInterviewTermination(recovered, options)));
    if (!cleared) {
      return recovered;
    }
  }
  throw new Error('too many persisted local interview cleanup blockers');
}

function recoverLocalInterviewResult({ outDir, mode, topic, sourcePath }) {
  const txtPath = path.join(outDir, 'transcript.txt');
  const srtPath = path.join(outDir, 'transcript.srt');
  const jsonPath = path.join(outDir, 'transcript.json');
  const recordingPath = path.join(outDir, 'recording.wav');
  const audioPath = path.join(outDir, 'audio.wav');
  const wavPath = fs.existsSync(recordingPath) ? recordingPath : audioPath;
  try {
    validateInterviewMaterialFile(txtPath, 'transcript_txt', { root: LOCAL_INTERVIEW_OUTPUT_ROOT });
    validateInterviewMaterialFile(wavPath, 'audio', { root: LOCAL_INTERVIEW_OUTPUT_ROOT });
  } catch {
    return null;
  }

  const summaryPath = prepareInterviewMaterialFileTarget(
    path.join(outDir, 'summary.json'),
    'summary',
    { root: LOCAL_INTERVIEW_OUTPUT_ROOT },
  );
  const packetPath = prepareInterviewMaterialFileTarget(
    path.join(outDir, 'codex-input.md'),
    'report',
    { root: LOCAL_INTERVIEW_OUTPUT_ROOT },
  );
  const transcriptText = readControlledTextFile(txtPath, 'transcript_txt', { root: LOCAL_INTERVIEW_OUTPUT_ROOT }).text;
  const transcriptSrt = fs.existsSync(srtPath)
    ? readControlledTextFile(srtPath, 'transcript_srt', { root: LOCAL_INTERVIEW_OUTPUT_ROOT }).text
    : '';
  const sourceExtension = path.extname(sourcePath || '').toLowerCase();
  const copiedSourcePath = sourceExtension ? path.join(outDir, `source${sourceExtension}`) : '';
  const controlledSourcePath = copiedSourcePath && fs.existsSync(copiedSourcePath)
    ? validateInterviewMaterialFile(copiedSourcePath, 'source_media', { root: LOCAL_INTERVIEW_OUTPUT_ROOT }).path
    : '';
  const payload = {
    createdAt: nowIso(),
    topic: topic || '',
    sourcePath: controlledSourcePath,
    wavPath: validateInterviewMaterialFile(wavPath, 'audio', { root: LOCAL_INTERVIEW_OUTPUT_ROOT }).path,
    transcriptTxt: txtPath,
    transcriptSrt: fs.existsSync(srtPath) ? srtPath : '',
    transcriptJson: fs.existsSync(jsonPath)
      ? validateInterviewMaterialFile(jsonPath, 'transcript_json', { root: LOCAL_INTERVIEW_OUTPUT_ROOT }).path
      : '',
    summaryPath,
    codexInput: packetPath,
    mode,
    recovered: true,
    recoveryReason: 'transcript files existed but summary.json was missing after process interruption',
  };
  if (!fs.existsSync(packetPath)) {
    writePrivateFile(packetPath, `# 招才官 Local Interview Codex Input

> Generated: ${payload.createdAt}
> Source: \`${controlledSourcePath || wavPath}\`
> Transcript TXT: \`${txtPath}\`
> Recovery: transcript files existed but summary.json was missing after process interruption.

## Transcript TXT

\`\`\`text
${transcriptText}
\`\`\`

## Transcript SRT

\`\`\`srt
${transcriptSrt.slice(0, 20000)}
\`\`\`
`);
  }
  if (!fs.existsSync(summaryPath)) {
    writePrivateFile(summaryPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
  return readLocalInterviewSummary(summaryPath).summary;
}

function localAudioStats(wavPath) {
  if (!wavPath || !fs.existsSync(wavPath)) return null;
  const sox = resolveLocalInterviewTool('sox');
  if (!sox) return null;
  const result = spawnSync(sox, [wavPath, '-n', 'stat'], { encoding: 'utf8' });
  const raw = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.status !== 0 && !raw.trim()) return null;
  const fields = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z ()]+):\s+(-?\d+(?:\.\d+)?)/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    fields[key] = Number(match[2]);
  }
  return {
    lengthSeconds: fields.length_seconds ?? null,
    maximumAmplitude: fields.maximum_amplitude ?? null,
    minimumAmplitude: fields.minimum_amplitude ?? null,
    meanNorm: fields.mean_norm ?? null,
    rmsAmplitude: fields.rms_amplitude ?? null,
    roughFrequency: fields.rough_frequency ?? null,
  };
}

function localAudioQuality(stats) {
  const duration = stats && Number.isFinite(stats.lengthSeconds) ? stats.lengthSeconds : null;
  const rms = stats && Number.isFinite(stats.rmsAmplitude) ? stats.rmsAmplitude : null;
  const max = stats && Number.isFinite(stats.maximumAmplitude) ? Math.abs(stats.maximumAmplitude) : null;
  if (!stats) return { level: 'unknown', label: '未知', message: '未能读取音频统计。' };
  if ((duration != null && duration < 5) || (rms != null && rms < 0.003) || (max != null && max < 0.03)) {
    return { level: 'warn', label: '偏弱', message: '录音时长较短或音量偏低。' };
  }
  if (max != null && max >= 0.98) {
    return { level: 'warn', label: '可能爆音', message: '检测到峰值接近满幅，可能存在爆音或削波。' };
  }
  return { level: 'pass', label: '可用', message: '录音音量和时长处于可用范围。' };
}

function adaptRecordingFromLocalSummary(resolved, summary, context = {}) {
  const transcript = readControlledTextFile(summary.transcriptTxt, 'transcript_txt', { root: LOCAL_INTERVIEW_OUTPUT_ROOT }).text;
  const adapted = interviewAdapters.ingestOfflineRecording({
    recording: {
      summary_path: resolved,
      wav_path: summary.wavPath,
      transcript_txt_path: summary.transcriptTxt,
      transcript_srt_path: summary.transcriptSrt,
      transcript_json_path: summary.transcriptJson,
      codex_input_path: summary.codexInput,
      source_path: summary.sourcePath,
      topic: summary.topic,
      created_at: summary.createdAt,
      raw_summary_json: summary,
    },
    sourceKey: interviewAdapters.sourceKeyForOfflineSummary(resolved),
    payloadHash: interviewAdapters.payloadHash(transcript),
    candidateId: context.candidateId,
    jobId: context.jobId,
    round: context.round,
    actor: LOCAL_PRINCIPAL.actor_id,
    reason: context.reason,
    requestId: context.requestId,
  });
  return {
    adapted,
    recording: db.getInterviewRecording(adapted.assignment.interview_recording_id),
  };
}

function autoBindLocalInterviewResult({ result, bindCandidateId, bindJobId, bindRound, bindConsentId = null }) {
  if (!result || !result.summaryPath || result.mode === 'mic-check') return null;
  return db.conn().transaction(() => {
    const { resolved, summary } = readLocalInterviewSummary(result.summaryPath);
    const completeContext = !!bindCandidateId && !!bindJobId && Number.isInteger(Number(bindRound)) && Number(bindRound) > 0;
    const adapted = adaptRecordingFromLocalSummary(resolved, summary, completeContext ? {
      candidateId: bindCandidateId,
      jobId: bindJobId,
      round: Number(bindRound),
      actor: LOCAL_PRINCIPAL.actor_id,
      reason: 'explicit_candidate_context',
      requestId: `local-interview:${interviewAdapters.sourceKeyForOfflineSummary(resolved)}`,
    } : {});
    if (!completeContext && bindCandidateId && bindJobId) {
      return db.bindInterviewRecording({
        id: adapted.recording.id,
        candidateId: bindCandidateId,
        jobId: bindJobId,
      });
    }
    if (bindConsentId != null) {
      const consentId = Number(bindConsentId);
      const assignedSession = adapted.adapted && adapted.adapted.session;
      if (!completeContext || !Number.isInteger(consentId) || consentId <= 0 || !assignedSession?.id) {
        throw new Error('formal local interview consent cannot be linked without its assigned interview session');
      }
      if (assignedSession.candidate_id !== bindCandidateId
          || Number(assignedSession.job_id) !== Number(bindJobId)
          || Number(assignedSession.round) !== Number(bindRound)) {
        throw new Error('formal local interview session does not match the consented candidate/job/round');
      }
      db.linkInterviewSessionConsent({
        sessionId: assignedSession.id,
        consentId,
        linkedBy: LOCAL_PRINCIPAL.actor_id,
      });
    }
    return adapted.recording;
  })();
}

function terminalLocalInterviewBindingError(error) {
  return new Set([
    'JOB_CLOSED',
    'INTERVIEW_SESSION_CLOSED',
    'INTERVIEW_SESSION_WITHDRAWN',
    'PROCESSING_CLOSED',
    'PROCESSING_WITHDRAWN',
  ]).has(String(error && error.code ? error.code : ''));
}

function discardTerminalLocalInterviewBinding(job, error, options = {}) {
  job.bindingPending = false;
  job.cleanupPending = true;
  const cleanup = cleanupFailedLocalInterviewResult(job, {
    groupState: 'gone',
    root: options.root,
    persistState: options.persistState || persistLocalInterviewState,
    cleanupArtifacts: options.cleanupTerminalArtifacts || cleanupAbortedLocalInterviewArtifacts,
    persistOptions: options,
  });
  return {
    cleanup,
    result: {
      mode: job.mode,
      discarded: cleanup.ok,
      terminal_error_code: error && error.code ? error.code : 'INTERVIEW_CONTEXT_TERMINAL',
    },
  };
}

function persistAndBindLocalInterviewResult({
  job,
  result,
  bindCandidateId,
  bindJobId,
  bindRound,
  bindConsentId = null,
}, options = {}) {
  if (!job || !result) throw new Error('local interview binding requires a job and result');
  const persistState = options.persistState || persistLocalInterviewState;
  const bindResult = options.bindResult || autoBindLocalInterviewResult;
  job.bindingPending = true;
  if (persistState(job, 'binding_in_progress', options) !== true) {
    return {
      ok: false,
      code: 'LOCAL_INTERVIEW_STATE_PERSIST_FAILED',
      error: job.persistentStateError || 'binding transaction persistence failed',
      result,
    };
  }

  let nextResult = result;
  try {
    const boundRecording = bindResult({
      result,
      bindCandidateId,
      bindJobId,
      bindRound,
      bindConsentId,
    });
    if (boundRecording) nextResult = { ...result, autoBoundRecording: boundRecording };
  } catch (error) {
    if (terminalLocalInterviewBindingError(error)) {
      const discarded = discardTerminalLocalInterviewBinding(job, error, options);
      return {
        ok: false,
        code: discarded.cleanup.ok
          ? 'LOCAL_INTERVIEW_BIND_TERMINAL_DISCARDED'
          : 'LOCAL_INTERVIEW_TERMINAL_CLEANUP_FAILED',
        error: error.message,
        terminal: true,
        discarded: discarded.cleanup.ok,
        cleanup: discarded.cleanup,
        result: discarded.result,
      };
    }
    nextResult = { ...result, autoBindError: error.message };
    job.bindingPending = true;
    persistState(job, 'bind_failed', options);
    return {
      ok: false,
      code: 'LOCAL_INTERVIEW_BIND_FAILED',
      error: error.message,
      result: nextResult,
    };
  }

  job.bindingPending = false;
  if (persistState(job, 'completed', options) !== true) {
    const completionError = job.persistentStateError || 'completion state persistence failed';
    job.bindingPending = true;
    persistState(job, 'bind_failed', options);
    return {
      ok: false,
      code: 'LOCAL_INTERVIEW_STATE_PERSIST_FAILED',
      error: completionError,
      result: nextResult,
    };
  }
  return { ok: true, result: nextResult };
}

function cleanupAbortedLocalInterviewArtifacts(outDir, options = {}) {
  return cleanupOwnedLocalInterviewArtifacts({
    outDir,
    root: options.root || LOCAL_INTERVIEW_OUTPUT_ROOT,
    jobId: options.jobId,
    ownerToken: options.ownerToken,
    removeFile: options.removeFile,
    removeDirectory: options.removeDirectory,
    syncDirectory: options.syncDirectory,
  });
}

function cleanupFailedLocalInterviewResult(job, options = {}) {
  if (!job || !job.outDir || !job.id || !job.ownerToken) {
    return {
      ok: false,
      terminationUnconfirmed: true,
      removed: [],
      failures: [{ file: '', error: 'failed local interview cleanup requires owned job identity' }],
    };
  }
  const groupState = options.groupState
    || localInterviewProcessGroupState(job, options.processStateOptions || {});
  if (groupState !== 'gone') {
    job.cleanupPending = true;
    job.terminationUnconfirmed = true;
    job.stopFailed = true;
    return {
      ok: false,
      terminationUnconfirmed: true,
      removed: [],
      failures: [{ file: '', error: 'local interview process-group termination is unconfirmed' }],
    };
  }
  const persistState = options.persistState || persistLocalInterviewState;
  const cleanupArtifacts = options.cleanupArtifacts || cleanupAbortedLocalInterviewArtifacts;
  job.cleanupPending = true;
  job.terminationUnconfirmed = false;
  if (persistState(job, 'cleanup_in_progress', options.persistOptions || {}) !== true) {
    job.stopFailed = true;
    return {
      ok: false,
      terminationUnconfirmed: false,
      removed: [],
      failures: [{
        file: LOCAL_INTERVIEW_STATE_MARKER,
        error: job.persistentStateError || 'cleanup state persistence failed',
      }],
    };
  }
  const cleanup = cleanupArtifacts(job.outDir, {
    jobId: job.id,
    ownerToken: job.ownerToken,
    root: options.root,
  });
  if (!cleanup.ok) {
    job.cleanupPending = true;
    job.stopFailed = true;
    persistState(job, 'cleanup_failed', options.persistOptions || {});
    return { ...cleanup, terminationUnconfirmed: false };
  }
  job.cleanupPending = false;
  job.stopFailed = false;
  return { ...cleanup, terminationUnconfirmed: false };
}

function sanitizeLocalInterviewMicCheckResult(result) {
  if (!result || typeof result !== 'object') return null;
  const micSource = result.micCheck && typeof result.micCheck === 'object'
    ? result.micCheck
    : {};
  return {
    mode: 'mic-check',
    ephemeral: true,
    micCheck: {
      level: String(micSource.level || 'unknown'),
      passed: micSource.passed === true,
      message: String(micSource.message || '麦克风预检已完成。'),
      recommendation: String(micSource.recommendation || '请根据通过状态决定是否重新测试。'),
    },
  };
}

function finalizeLocalInterviewMicCheck(job, {
  result = null,
  success = false,
  processError = '',
  root,
} = {}) {
  if (!job || job.mode !== 'mic-check') {
    throw new Error('mic-check finalization requires an owned mic-check job');
  }
  job.cleanupPending = true;
  job.terminationUnconfirmed = false;
  job.stopFailed = false;
  // Persist a restart blocker before deletion. The successful cleanup removes
  // this marker together with every temporary mic-check material.
  const cleanupStatePersisted = persistLocalInterviewState(job, 'cleanup_in_progress', { root });
  const cleanup = cleanupStatePersisted
    ? cleanupAbortedLocalInterviewArtifacts(job.outDir, {
      jobId: job.id,
      ownerToken: job.ownerToken,
      root,
    })
    : {
      ok: false,
      removed: [],
      failures: [{ file: LOCAL_INTERVIEW_STATE_MARKER, error: job.persistentStateError || 'cleanup state persistence failed' }],
    };
  if (!cleanup.ok) {
    job.cleanupPending = true;
    job.stopFailed = true;
    persistLocalInterviewState(job, 'cleanup_failed', { root });
    return {
      ...job,
      child: null,
      finalized: true,
      status: 'error',
      cleanupPending: true,
      terminationUnconfirmed: false,
      stopFailed: true,
      finishedAt: nowIso(),
      message: '麦克风预检进程已结束，但临时材料删除失败；已阻止新的录音任务。',
      error: `mic-check artifact cleanup failed: ${cleanup.failures.map((item) => item.file || item.error).join(', ')}`,
      result: null,
      liveAudio: null,
    };
  }
  return {
    ...job,
    child: null,
    finalized: true,
    status: success ? 'done' : 'error',
    cleanupPending: false,
    terminationUnconfirmed: false,
    stopFailed: false,
    persistentStateFailed: false,
    persistentStateError: null,
    finishedAt: nowIso(),
    message: success
      ? '麦克风预检完成；临时音频、转写和分析文件已删除。'
      : '麦克风预检未完成；临时音频、转写和分析文件已删除。',
    error: success ? null : (processError || '麦克风预检进程失败。'),
    result: success ? sanitizeLocalInterviewMicCheckResult(result) : null,
    // Do not expose stale paths to an ephemeral directory that no longer exists.
    outDir: null,
    logPath: null,
    liveAudio: null,
  };
}

function sendLocalInterviewGuardianCommand(job, message) {
  const child = job && job.child;
  if (!job
      || job.guardianManaged !== true
      || !child
      || child.exitCode != null
      || child.signalCode
      || child.connected !== true
      || typeof child.send !== 'function') return false;
  try {
    child.send({
      schema_version: GUARDIAN_IPC_SCHEMA,
      action_instance_id: INSTANCE_ID,
      guardian_instance_id: job.guardianInstanceId,
      job_id: job.id,
      ...message,
    });
    return true;
  } catch {
    return false;
  }
}

function signalLocalInterviewProcessTree(job, signal, options = {}) {
  const child = job && job.child;
  const processGroupId = Number(job && (
    job.guardianManaged === true
      ? job.processGroupId
      : (job.processGroupId || (child && child.pid))
  ));
  if (job && job.guardianManaged === true) {
    const delivered = sendLocalInterviewGuardianCommand(job, {
      type: 'signal',
      signal,
      reason: String(options.reason || '').slice(0, 200),
    });
    if (delivered) return true;
    const platform = options.platform || process.platform;
    const kill = options.kill || process.kill;
    if (platform !== 'win32'
        && job.processGroup === true
        && Number.isSafeInteger(processGroupId)
        && processGroupId > 0) {
      try {
        kill(-processGroupId, signal);
        return true;
      } catch (error) {
        return !!(error && error.code === 'ESRCH');
      }
    }
    return false;
  }
  if (!child || !Number.isSafeInteger(processGroupId) || processGroupId <= 0) return false;
  const platform = options.platform || process.platform;
  const kill = options.kill || process.kill;
  if (platform !== 'win32' && job.processGroup === true) {
    try {
      kill(-processGroupId, signal);
      return true;
    } catch (error) {
      if (error && error.code === 'ESRCH') return true;
      // Parent-only fallback could orphan rec/whisper. Report failure so the
      // caller cannot claim that withdrawal stopped the owned worker tree.
      return false;
    }
  }
  if (child.exitCode != null || child.signalCode) return true;
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function localInterviewProcessGroupState(job, options = {}) {
  const child = job && job.child;
  if (job && job.guardianManaged === true) {
    if (job.groupQuiescent === true
        && ['gate_worker_closed_pgid_empty', 'gate_closed_verified_pgid_empty'].includes(job.groupQuiescenceProof)) {
      return 'gone';
    }
    const processGroupId = Number(job.processGroupId);
    const platform = options.platform || process.platform;
    if (platform === 'win32' || !Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
      return child && child.exitCode == null && !child.signalCode ? 'alive' : 'unknown';
    }
    const kill = options.kill || process.kill;
    try {
      kill(-processGroupId, 0);
      return 'alive';
    } catch (error) {
      if (error && error.code === 'ESRCH') return 'gone';
      return 'unknown';
    }
  }
  const processGroupId = Number(job && (job.processGroupId || (child && child.pid)));
  if (!child || !Number.isSafeInteger(processGroupId) || processGroupId <= 0) return 'gone';
  const platform = options.platform || process.platform;
  if (platform === 'win32' || job.processGroup !== true) {
    return child.exitCode != null || child.signalCode ? 'gone' : 'alive';
  }
  const kill = options.kill || process.kill;
  try {
    kill(-processGroupId, 0);
    return 'alive';
  } catch (error) {
    if (error && error.code === 'ESRCH') return 'gone';
    return 'unknown';
  }
}

function localInterviewGuardianExitRequiresAbort(job, options = {}) {
  if (job && job.groupQuiescent === true
      && ['gate_worker_closed_pgid_empty', 'gate_closed_verified_pgid_empty'].includes(
        job.groupQuiescenceProof,
      )) return false;
  return localInterviewProcessGroupState(job, options) !== 'gone';
}

function waitForLocalInterviewCondition(check, timeoutMs, pollMs = LOCAL_INTERVIEW_TERMINATION_POLL_MS) {
  const timeout = Math.max(0, Number(timeoutMs) || 0);
  const interval = Math.max(5, Number(pollMs) || LOCAL_INTERVIEW_TERMINATION_POLL_MS);
  const deadline = Date.now() + timeout;
  return new Promise((resolve) => {
    const poll = () => {
      let matched = false;
      try { matched = check() === true; } catch {}
      if (matched) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(poll, interval);
    };
    poll();
  });
}

async function settleLocalInterviewProcessTree(job, options = {}) {
  const platform = options.platform || process.platform;
  const kill = options.kill || process.kill;
  const graceMs = options.graceMs == null ? LOCAL_INTERVIEW_TERM_GRACE_MS : Number(options.graceMs);
  const killGraceMs = options.killGraceMs == null ? LOCAL_INTERVIEW_KILL_GRACE_MS : Number(options.killGraceMs);
  const pollMs = options.pollMs == null ? LOCAL_INTERVIEW_TERMINATION_POLL_MS : Number(options.pollMs);
  const confirmed = () => job.childStreamsClosed === true
    && job.logClosed === true
    && localInterviewProcessGroupState(job, { platform, kill }) === 'gone';
  if (await waitForLocalInterviewCondition(confirmed, graceMs, pollMs)) {
    return { confirmed: true, escalated: false, kill_sent: false, group_state: 'gone', streams_closed: true };
  }

  let killSent = false;
  let killError = null;
  const beforeKillState = localInterviewProcessGroupState(job, { platform, kill });
  if (beforeKillState !== 'gone') {
    if (job.guardianManaged === true) {
      killSent = signalLocalInterviewProcessTree(job, 'SIGKILL', {
        platform,
        kill,
        reason: 'action_server_termination_escalation',
      });
      if (!killSent) killError = new Error('guardian force-stop command could not be delivered');
    } else if (platform !== 'win32' && job.processGroup === true && Number.isSafeInteger(job.processGroupId)) {
      try {
        kill(-job.processGroupId, 'SIGKILL');
        killSent = true;
      } catch (error) {
        if (error && error.code === 'ESRCH') killSent = true;
        else killError = error;
      }
    } else if (job.child && job.child.exitCode == null && !job.child.signalCode) {
      try { killSent = job.child.kill('SIGKILL') === true; } catch (error) { killError = error; }
    }
  }

  const didConfirm = await waitForLocalInterviewCondition(confirmed, killGraceMs, pollMs);
  return {
    confirmed: didConfirm,
    escalated: beforeKillState !== 'gone',
    kill_sent: killSent,
    kill_error: killError ? (killError.code || killError.message) : null,
    group_state: localInterviewProcessGroupState(job, { platform, kill }),
    streams_closed: job.childStreamsClosed === true && job.logClosed === true,
  };
}

function interviewConsentStopHttpResult({ confirmed, consent, policy, stopResult }) {
  const matched = !!(stopResult && stopResult.matched);
  const stopRequested = !!(stopResult && stopResult.stopped);
  const base = {
    consent,
    policy,
    recording_stopped: false,
    recording_stop_requested: stopRequested,
    stop_failed: matched && !stopRequested,
    job: stopResult && stopResult.job ? stopResult.job : undefined,
  };
  if (confirmed !== true && matched && !stopRequested) {
    return {
      status: 503,
      body: {
        ok: false,
        code: 'INTERVIEW_RECORDING_STOP_FAILED',
        error: '候选人授权已撤回，但未能确认录音停止请求已送达。系统将持续核对；请勿继续面试或开始新录音。',
        ...base,
      },
    };
  }
  return {
    status: matched && stopRequested ? 202 : 200,
    body: { ok: true, ...base },
  };
}

function localInterviewManualStopHttpResult(stopResult) {
  const stopped = !!(stopResult && stopResult.stopped);
  const base = {
    recording_stopped: false,
    recording_stop_requested: stopped,
    stop_failed: !stopped,
    job: stopResult && stopResult.job ? stopResult.job : undefined,
  };
  if (!stopped) {
    return {
      status: 503,
      body: {
        ok: false,
        code: 'INTERVIEW_RECORDING_STOP_FAILED',
        error: '未能向本地录音进程组发送停止请求；录音可能仍在继续，请重试停止。',
        ...base,
      },
    };
  }
  return { status: 202, body: { ok: true, ...base } };
}

function localInterviewAbortHttpResult(abortResult) {
  const matched = !!(abortResult && abortResult.matched);
  const stopped = !!(abortResult && abortResult.stopped);
  const base = {
    recording_stopped: false,
    recording_stop_requested: stopped,
    cleanup_requested: stopped,
    stop_failed: matched && !stopped,
    job: abortResult && abortResult.job ? abortResult.job : undefined,
  };
  if (!matched) {
    return {
      status: 409,
      body: {
        ok: false,
        code: 'LOCAL_INTERVIEW_TASK_CHANGED',
        error: '本地任务已结束或已被其他任务替换；未向当前任务发送停止信号，请刷新状态。',
        ...base,
      },
    };
  }
  if (!stopped) {
    return {
      status: 503,
      body: {
        ok: false,
        code: 'INTERVIEW_RECORDING_STOP_FAILED',
        error: '未能确认本地任务停止请求已送达。系统将持续核对；请勿开始新任务。',
        ...base,
      },
    };
  }
  return { status: 202, body: { ok: true, ...base } };
}

function revokeInterviewConsentAndStop({
  candidateId,
  jobId,
  recordedBy,
  source = 'candidate_interview_ui',
  requestId,
} = {}, options = {}) {
  const beginRevocation = options.beginRevocation || db.beginInterviewConsentRevocationGate;
  const requestStop = options.requestStop || requestLocalInterviewStop;
  const recordConsent = options.recordConsent || db.recordInterviewConsent;
  let revocationGate = null;
  let gateError = null;
  let stopResult = { matched: false, stopped: false, job: compactLocalInterviewJob(localInterviewJob) };
  let stopError = null;
  let consent = null;
  let revokeError = null;
  // Establish the durable fail-closed latch before sending a stop signal. If
  // the process exits between stop and the consent UPDATE, a restart still
  // rejects the previously active consent.
  try {
    revocationGate = beginRevocation({ candidateId, jobId });
  } catch (error) {
    gateError = error;
    try {
      db.blockInterviewConsentRevocationInMemory({ candidateId, jobId });
    } catch {}
  }
  // Safety termination remains independent from DB health. Even when the latch
  // could not be written, always attempt to stop the matching local task.
  try {
    stopResult = requestStop({
      abort: true,
      reason: '候选人录音授权已撤回；正在请求停止录音并等待安全清理。',
      candidateId,
      jobId,
    });
  } catch (error) {
    stopError = error;
  }
  if (gateError) {
    revokeError = gateError;
  } else {
    try {
      consent = recordConsent({
        candidateId,
        jobId,
        confirmed: false,
        recordedBy,
        source,
        requestId,
      });
    } catch (error) {
      revokeError = error;
    }
  }
  return {
    consent,
    revocationGate,
    gateError,
    stopResult,
    stopError,
    revokeError,
  };
}

function interviewConsentRevocationHttpResult({
  consent,
  policy,
  gateError,
  stopResult,
  stopError,
  revokeError,
} = {}) {
  const matched = !!(stopResult && stopResult.matched);
  const stopRequested = !!(stopResult && stopResult.stopped);
  const base = {
    consent,
    policy,
    recording_stopped: false,
    recording_stop_requested: stopRequested,
    stop_failed: !!stopError || (matched && !stopRequested),
    revoke_failed: !!revokeError,
    revocation_gate_failed: !!gateError
      || (revokeError && revokeError.code === 'INTERVIEW_CONSENT_REVOCATION_GATE_FAILED'),
    job: stopResult && stopResult.job ? stopResult.job : undefined,
  };
  if (stopError || (matched && !stopRequested)) {
    return {
      status: 503,
      body: {
        ok: false,
        code: 'INTERVIEW_RECORDING_STOP_FAILED',
        error: revokeError
          ? '授权撤回记录与录音停止请求均未确认成功；系统已阻止继续操作，请勿继续面试或开始新录音。'
          : '候选人授权已撤回，但未能确认录音停止请求已送达。系统将持续核对；请勿继续面试或开始新录音。',
        revoke_error_code: revokeError && revokeError.code ? revokeError.code : undefined,
        ...base,
      },
    };
  }
  if (revokeError) {
    return {
      status: Number(revokeError.statusCode) || 500,
      body: {
        ok: false,
        code: revokeError.code || 'INTERVIEW_CONSENT_REVOKE_FAILED',
        error: `已发起匹配任务的安全停止，但授权撤回记录未能持久化：${revokeError.message || '数据库写入失败'}`,
        ...base,
      },
    };
  }
  return interviewConsentStopHttpResult({
    confirmed: false,
    consent,
    policy,
    stopResult,
  });
}

function withdrawInterviewLifecycleAndStop(session, {
  sessionId,
  reasonCode,
} = {}, options = {}) {
  const beginRevocation = options.beginRevocation || db.beginInterviewConsentRevocationGate;
  const requestStop = options.requestStop || requestLocalInterviewStop;
  const withdrawLifecycle = options.withdrawLifecycle || db.withdrawInterviewLifecycle;
  let revocationGate = null;
  let gateError = null;
  let stopResult = { matched: false, stopped: false, job: compactLocalInterviewJob(localInterviewJob) };
  let stopError = null;
  let lifecycle = null;
  let lifecycleError = null;
  try {
    revocationGate = beginRevocation({
      candidateId: session.candidate_id,
      jobId: session.job_id,
    });
  } catch (error) {
    gateError = error;
    try {
      db.blockInterviewConsentRevocationInMemory({
        candidateId: session.candidate_id,
        jobId: session.job_id,
      });
    } catch {}
  }
  try {
    stopResult = requestStop({
      abort: true,
      reason: '面试 Session 已撤回；正在请求停止录音并等待安全清理。',
      candidateId: session.candidate_id,
      jobId: session.job_id,
    });
  } catch (error) {
    stopError = error;
  }
  if (gateError) {
    lifecycleError = gateError;
  } else {
    try {
      lifecycle = withdrawLifecycle({ sessionId, reasonCode });
      db.completeInterviewConsentRevocationGate({
        candidateId: session.candidate_id,
        jobId: session.job_id,
      });
    } catch (error) {
      if (error && error.code === 'PROCESSING_WITHDRAWN') {
        try {
          db.completeInterviewConsentRevocationGate({
            candidateId: session.candidate_id,
            jobId: session.job_id,
          });
          lifecycle = db.getInterviewLifecycleStatus({ sessionId });
        } catch (completionError) {
          lifecycleError = completionError;
        }
      } else {
        lifecycleError = error;
      }
    }
  }
  return {
    lifecycle,
    revocationGate,
    gateError,
    stopResult,
    stopError,
    lifecycleError,
  };
}

function interviewLifecycleWithdrawalHttpResult({
  lifecycle,
  gateError,
  stopResult,
  stopError,
  lifecycleError,
} = {}) {
  const matched = !!(stopResult && stopResult.matched);
  const stopRequested = !!(stopResult && stopResult.stopped);
  const base = {
    lifecycle,
    recording_stopped: false,
    recording_stop_requested: stopRequested,
    stop_failed: !!stopError || (matched && !stopRequested),
    lifecycle_write_failed: !!lifecycleError,
    revocation_gate_failed: !!gateError,
    job: stopResult && stopResult.job ? stopResult.job : undefined,
  };
  if (stopError || (matched && !stopRequested)) {
    return {
      status: 503,
      body: {
        ok: false,
        code: 'INTERVIEW_RECORDING_STOP_FAILED',
        error: lifecycleError
          ? '面试撤回记录与录音停止请求均未确认成功；系统已阻止继续操作。'
          : '面试 Session 已撤回，但未能确认录音停止请求已送达。系统将持续核对；请勿继续面试或开始新录音。',
        lifecycle_error_code: lifecycleError && lifecycleError.code ? lifecycleError.code : undefined,
        ...base,
      },
    };
  }
  if (lifecycleError) {
    return {
      status: Number(lifecycleError.statusCode) || 500,
      body: {
        ok: false,
        code: lifecycleError.code || 'INTERVIEW_LIFECYCLE_WITHDRAW_FAILED',
        error: `已发起匹配任务的安全停止，但面试撤回记录未能持久化：${lifecycleError.message || '数据库写入失败'}`,
        ...base,
      },
    };
  }
  return {
    status: matched && stopRequested ? 202 : 200,
    body: {
      ok: true,
      ...base,
    },
  };
}

function localInterviewJobBlocksStart(job) {
  return !!(job && (
    job.status === 'starting'
    || job.status === 'running'
    || job.cleanupPending
    || job.bindingPending
    || job.transcriptionRetryable
    || job.terminationUnconfirmed
    || job.persistentStateFailed
  ));
}

function localInterviewStartConsentValid(job) {
  if (!job || !['record', 'mic-check', 'from-file', 'retry-transcription'].includes(job.mode)) return false;
  const hasAnyBinding = !!job.bindCandidateId || job.bindJobId != null || job.bindRound != null;
  const hasCompleteBinding = !!job.bindCandidateId
    && Number.isSafeInteger(Number(job.bindJobId))
    && Number(job.bindJobId) > 0
    && Number.isSafeInteger(Number(job.bindRound))
    && Number(job.bindRound) > 0;
  if (hasAnyBinding && !hasCompleteBinding) return false;
  if (hasCompleteBinding) {
    try {
      db.assertInterviewRoundRecordingWritable({
        candidateId: job.bindCandidateId,
        jobId: job.bindJobId,
        round: job.bindRound,
      });
    } catch {
      return false;
    }
  }
  if (job.mode === 'from-file') return !hasAnyBinding || hasCompleteBinding;
  if (job.mode === 'retry-transcription') {
    return hasCompleteBinding && retainedLocalInterviewContextValid(job);
  }
  if (job.mode === 'mic-check') {
    if (job.micCheckConsentConfirmed !== true) return false;
    if (!job.bindCandidateId && !job.bindJobId) return true;
  }
  const consentId = Number(job.bindConsentId);
  if (!job.bindCandidateId
      || !Number.isSafeInteger(Number(job.bindJobId))
      || !Number.isSafeInteger(consentId)
      || consentId <= 0) return false;
  try {
    const consent = db.getInterviewConsent({
      candidateId: job.bindCandidateId,
      jobId: job.bindJobId,
    });
    return !!consent
      && consent.valid === true
      && consent.status === 'active'
      && Number(consent.id) === consentId;
  } catch {
    return false;
  }
}

async function resolveLocalInterviewStartup(result) {
  if (!result || result.ok !== true || !result.startup) return result;
  return result.startup;
}

function runLocalInterviewJob({
  mode,
  topic,
  sourcePath = '',
  duration = null,
  bindCandidateId = '',
  bindJobId = null,
  bindRound = null,
  bindConsentId = null,
  micCheckConsentConfirmed = false,
  clientRequestId = '',
  retryJob = null,
}) {
  if (shuttingDown) {
    return { ok: false, status: 503, error: '应用正在安全退出，不能开始新的本地面试任务。' };
  }
  const retryingTranscription = mode === 'retry-transcription';
  if (retryingTranscription) {
    if (!retryJob
        || retryJob !== localInterviewJob
        || retryJob.transcriptionRetryable !== true
        || retryJob.status !== 'error'
        || retryJob.child) {
      return { ok: false, status: 409, code: 'LOCAL_INTERVIEW_TRANSCRIPTION_NOT_RETRYABLE', error: '当前没有可重试的保留录音。' };
    }
    if (!retainedLocalInterviewContextValid(retryJob)) {
      return { ok: false, status: 409, code: 'INTERVIEW_CONTEXT_NOT_WRITABLE', error: '候选人授权已撤回，或岗位/面试轮次已关闭；不能重试转写。' };
    }
  } else {
    if (!localInterviewJob || !localInterviewJobBlocksStart(localInterviewJob)) {
      refreshPersistedLocalInterviewBlocker();
    }
    if (localInterviewJobBlocksStart(localInterviewJob)) {
      return { ok: false, status: 409, error: '本地面试任务正在运行中，先停止或等它完成。' };
    }
  }
  const unavailable = localInterviewCapability(process.platform);
  if (unavailable) {
    return { ok: false, status: 501, code: unavailable.reason, error: unavailable.message };
  }
  const normalizedTopic = topic || retryJob?.topic || 'HRBOSS-P0-local';
  const localJobId = retryingTranscription
    ? retryJob.id
    : `${Date.now()}-${crypto.randomUUID()}`;
  const ownerToken = retryingTranscription
    ? retryJob.ownerToken
    : crypto.randomBytes(32).toString('hex');
  const guardianInstanceId = crypto.randomUUID();
  const guardianControlToken = crypto.randomBytes(32).toString('hex');
  const guardianStartToken = crypto.randomBytes(32).toString('hex');
  const guardianCaptureToken = crypto.randomBytes(32).toString('hex');
  const outDir = retryingTranscription
    ? retryJob.outDir
    : localInterviewOutDir(topic, { jobId: localJobId, ownerToken });
  if (retryingTranscription) {
    const recordingPath = preservedLocalInterviewRecording(retryJob);
    if (!recordingPath) {
      return { ok: false, status: 409, code: 'LOCAL_INTERVIEW_RECORDING_MISSING', error: '保留录音不存在或不再可信，不能重试转写。' };
    }
    const derivedCleanup = cleanupOwnedLocalInterviewDerivedArtifacts({
      outDir,
      root: LOCAL_INTERVIEW_OUTPUT_ROOT,
      jobId: localJobId,
      ownerToken,
    });
    if (!derivedCleanup.ok) {
      return {
        ok: false,
        status: 503,
        code: 'LOCAL_INTERVIEW_RETRY_PREPARE_FAILED',
        error: `无法安全准备转写重试：${derivedCleanup.failures.map((item) => item.file || item.error).join(', ')}`,
      };
    }
    sourcePath = recordingPath;
    bindCandidateId = retryJob.bindCandidateId;
    bindJobId = retryJob.bindJobId;
    bindRound = retryJob.bindRound;
    bindConsentId = retryJob.bindConsentId;
  }
  const persistentJobIdentity = {
    id: localJobId,
    ownerToken,
    outDir,
    mode,
    topic: normalizedTopic,
    bindCandidateId,
    bindJobId,
    bindRound,
    bindConsentId,
    micCheckConsentConfirmed,
    clientRequestId,
    guardianManaged: true,
    guardianInstanceId,
    cleanupPending: false,
    bindingPending: false,
    terminationUnconfirmed: false,
  };
  writeLocalInterviewPersistentState(
    persistentJobIdentity,
    retryingTranscription ? 'transcription_retry_starting' : 'starting',
  );
  const logPath = path.join(outDir, 'run.log');
  const args = ["src/local-interview-p0.js"];
  if (mode === 'record') {
    args.push('--record');
    if (duration) args.push('--duration', String(duration));
  } else if (mode === 'mic-check') {
    args.push('--mic-check');
    if (duration) args.push('--duration', String(duration));
  } else if (mode === 'from-file') {
    args.push('--from-file', sourcePath);
  } else if (mode === 'retry-transcription') {
    args.push('--retry-recording', sourcePath);
  } else {
    return { ok: false, status: 400, error: 'unknown local interview mode' };
  }
  args.push('--topic', normalizedTopic, '--out-dir', outDir);

  const startedAt = nowIso();
  let logDescriptor;
  let child;
  try {
    logDescriptor = fs.openSync(
      logPath,
      fs.constants.O_WRONLY
        | fs.constants.O_CREAT
        | fs.constants.O_APPEND
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    fs.fsyncSync(logDescriptor);
    ensurePrivateFile(logPath);
    child = spawn(process.execPath, ["src/local-interview-guardian.js"], {
      cwd: PROJECT_ROOT,
      // The guardian stays outside the detached worker group so it survives a
      // bounded group SIGKILL and can verify cleanup before exiting.
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
      env: {
        ...process.env,
        HRBOSS_LOCAL_INTERVIEW_ACTION_INSTANCE_ID: INSTANCE_ID,
        HRBOSS_LOCAL_INTERVIEW_GUARDIAN_CONTROL_TOKEN: guardianControlToken,
        HRBOSS_LOCAL_INTERVIEW_GUARDIAN_CAPTURE_TOKEN: guardianCaptureToken,
        HRBOSS_LOCAL_INTERVIEW_GUARDIAN_INSTANCE_ID: guardianInstanceId,
        HRBOSS_LOCAL_INTERVIEW_GUARDIAN_JOB_ID: localJobId,
        HRBOSS_LOCAL_INTERVIEW_GUARDIAN_OUT_DIR: outDir,
        HRBOSS_LOCAL_INTERVIEW_GUARDIAN_OWNER_TOKEN: ownerToken,
        HRBOSS_LOCAL_INTERVIEW_GUARDIAN_REGISTRY: LOCAL_INTERVIEW_GUARDIAN_REGISTRY,
        HRBOSS_LOCAL_INTERVIEW_GUARDIAN_START_TOKEN: guardianStartToken,
        HRBOSS_LOCAL_INTERVIEW_PRESERVE_RECORDING_ON_EMERGENCY:
          retryingTranscription ? '1' : '0',
        HRBOSS_LOCAL_INTERVIEW_GUARDIAN_WORKER_ARGS: JSON.stringify(args),
        HRBOSS_LOCAL_INTERVIEW_GUARDIAN_WORKER_CWD: PROJECT_ROOT,
      },
    });
  } catch (error) {
    if (logDescriptor !== undefined) {
      try { fs.closeSync(logDescriptor); } catch {}
    }
    const cleanup = retryingTranscription
      ? cleanupOwnedLocalInterviewDerivedArtifacts({
        outDir,
        root: LOCAL_INTERVIEW_OUTPUT_ROOT,
        jobId: localJobId,
        ownerToken,
      })
      : cleanupAbortedLocalInterviewArtifacts(outDir, {
        jobId: localJobId,
        ownerToken,
      });
    if (retryingTranscription) {
      persistLocalInterviewState({
        ...persistentJobIdentity,
        transcriptionRetryable: true,
      }, 'transcription_failed');
    }
    return {
      ok: false,
      status: 503,
      code: 'LOCAL_INTERVIEW_GUARDIAN_START_FAILED',
      error: `本地录音安全守护启动失败：${error.message}`,
      cleanup,
    };
  }
  localInterviewJob = {
    id: localJobId,
    status: 'starting',
    mode,
    topic: normalizedTopic,
    sourcePath,
    outDir,
    logPath,
    startedAt,
    finishedAt: null,
    duration,
    stopRequested: false,
    bindCandidateId,
    bindJobId,
    bindRound,
    bindConsentId,
    micCheckConsentConfirmed,
    clientRequestId,
    ownerToken,
    processGroup: process.platform !== 'win32',
    processGroupId: null,
    guardianManaged: true,
    guardianInstanceId,
    groupQuiescent: false,
    groupQuiescenceProof: null,
    childStreamsClosed: false,
    logClosed: false,
    cleanupPending: false,
    bindingPending: false,
    transcriptionRetryable: false,
    terminationUnconfirmed: false,
    stopFailed: false,
    finalized: false,
    message: '正在确认本地录音安全守护与持久状态，尚未打开麦克风。',
    error: null,
    result: null,
    liveAudio: null,
    child,
  };
  const guardianMessageQueue = [];
  let guardianMessageHandler = null;
  child.on('message', (message) => {
    if (guardianMessageHandler) guardianMessageHandler(message);
    else guardianMessageQueue.push(message);
  });
  const log = fs.createWriteStream(logPath, {
    fd: logDescriptor,
    autoClose: true,
  });
  const stderrDemux = createLiveAudioStderrDemux({
    onTelemetry: (telemetry) => {
      if (!localInterviewJob
          || localInterviewJob.child !== child
          || localInterviewJob.id !== localJobId
          || localInterviewJob.status !== 'running'
          || localInterviewJob.stopRequested) {
        return;
      }
      const currentSeq = Number(localInterviewJob.liveAudio && localInterviewJob.liveAudio.seq);
      if (Number.isSafeInteger(currentSeq) && telemetry.seq <= currentSeq) return;
      localInterviewJob.liveAudio = telemetry;
    },
    onLog: (text) => log.write(text),
  });
  let logFinished = false;
  const finishLog = () => {
    if (logFinished) return;
    logFinished = true;
    stderrDemux.end();
    log.end();
  };

  const currentJob = () => (
    localInterviewJob && localInterviewJob.id === localJobId ? localInterviewJob : null
  );
  let startupSettled = false;
  let resolveStartup;
  const startup = new Promise((resolve) => { resolveStartup = resolve; });
  const settleStartup = (result) => {
    if (startupSettled) return result;
    startupSettled = true;
    resolveStartup(result);
    return result;
  };

  const finalizeNormalJob = () => {
    const activeJob = currentJob();
    if (!activeJob || activeJob.finalized || activeJob.abortRequested
        || !activeJob.childStreamsClosed || !activeJob.logClosed) return;
    if (localInterviewProcessGroupState(activeJob) !== 'gone') {
      activeJob.stopRequested = true;
      activeJob.abortRequested = true;
      activeJob.cleanupPending = true;
      activeJob.terminationUnconfirmed = true;
      activeJob.stopFailed = true;
      if (retryingTranscription || activeJob.transcriptionStarted) {
        activeJob.preserveRecordingAfterAbort = true;
      }
      activeJob.message = '本地处理进程已退出，但录音进程组终止状态无法确认；未清理任何材料。';
      activeJob.error = 'LOCAL_INTERVIEW_TERMINATION_UNCONFIRMED';
      persistLocalInterviewState(
        activeJob,
        retryingTranscription ? 'transcription_retry_running' : 'termination_unconfirmed',
      );
      signalLocalInterviewProcessTree(activeJob, 'SIGTERM', {
        reason: 'normal_finalize_without_quiescence',
      });
      beginAbortSettlement();
      return;
    }
    const code = activeJob.exitCode;
    const signal = activeJob.exitSignal;
    const summaryPath = path.join(outDir, 'summary.json');
    let result = null;
    if (fs.existsSync(summaryPath)) {
      try { result = readLocalInterviewSummary(summaryPath).summary; } catch {}
    }
    if (!result) {
      result = recoverLocalInterviewResult({ outDir, mode, topic: normalizedTopic, sourcePath });
    }
    if (result && !result.audioStats) {
      const wavPath = result.wavPath || path.join(outDir, mode === 'record' ? 'recording.wav' : 'audio.wav');
      const stats = localAudioStats(wavPath);
      if (stats) {
        result = {
          ...result,
          audioStats: stats,
          audioQuality: result.audioQuality || localAudioQuality(stats),
        };
      }
    }
    const success = !activeJob.spawnError && !!result;
    if (mode === 'mic-check') {
      localInterviewJob = finalizeLocalInterviewMicCheck(activeJob, {
        result,
        success,
        processError: activeJob.spawnError
          || `process exited code=${code == null ? 'null' : code} signal=${signal || 'none'}`,
      });
      return;
    }
    if (!success) {
      const processError = activeJob.spawnError
        || `process exited code=${code == null ? 'null' : code} signal=${signal || 'none'}`;
      const preservation = ['record', 'retry-transcription'].includes(mode)
        ? preserveFailedLocalInterviewTranscription(activeJob, processError)
        : null;
      if (preservation) {
        localInterviewJob = {
          ...activeJob,
          child: null,
          finalized: true,
          status: 'error',
          transcriptionRetryable: true,
          cleanupPending: false,
          bindingPending: false,
          terminationUnconfirmed: false,
          stopFailed: !preservation.persisted,
          finishedAt: nowIso(),
          message: preservation.persisted
            ? '本地转写失败；原录音已安全保留。请由 HR 手动重试转写，或明确丢弃这条录音。'
            : '本地转写失败且可重试状态持久化异常；原录音仍保留，新的录音任务保持阻止。',
          error: preservation.persisted
            ? `LOCAL_INTERVIEW_TRANSCRIPTION_FAILED: ${processError}`
            : `LOCAL_INTERVIEW_STATE_PERSIST_FAILED: ${activeJob.persistentStateError || processError}`,
          result: {
            mode: 'record',
            recordingPath: preservation.recordingPath,
            transcription_failed: true,
          },
          liveAudio: null,
        };
        return;
      }
      const cleanup = cleanupFailedLocalInterviewResult(activeJob, { groupState: 'gone' });
      localInterviewJob = {
        ...activeJob,
        child: null,
        finalized: true,
        status: 'error',
        cleanupPending: !cleanup.ok,
        terminationUnconfirmed: false,
        stopFailed: !cleanup.ok,
        finishedAt: nowIso(),
        message: cleanup.ok
          ? '本地面试任务未生成可用结果；进程已确认终止，未完成材料已删除。'
          : '本地面试任务未生成可用结果，且未完成材料删除失败；新的录音任务保持阻止。',
        error: cleanup.ok
          ? processError
          : `incomplete interview artifact cleanup failed: ${cleanup.failures.map((item) => item.file || item.error).join(', ')}`,
        result: null,
        outDir: cleanup.ok ? null : activeJob.outDir,
        logPath: cleanup.ok ? null : activeJob.logPath,
        liveAudio: null,
      };
      return;
    }

    const binding = persistAndBindLocalInterviewResult({
      job: activeJob,
      result,
      bindCandidateId,
      bindJobId,
      bindRound,
      bindConsentId,
    });
    result = binding.result;
    if (!binding.ok) {
      if (binding.terminal) {
        localInterviewJob = {
          ...activeJob,
          child: null,
          finalized: true,
          status: binding.discarded ? 'cancelled' : 'error',
          cleanupPending: !binding.discarded,
          bindingPending: false,
          terminationUnconfirmed: false,
          stopFailed: !binding.discarded,
          finishedAt: nowIso(),
          message: binding.discarded
            ? '录音结束前招聘上下文已关闭或撤回；未生成归档，临时录音与转写材料已删除。'
            : '录音结束前招聘上下文已关闭或撤回，且临时材料删除失败；新的本地任务保持阻止。',
          error: binding.discarded ? null : `${binding.code}: ${binding.error}`,
          result,
          outDir: binding.discarded ? null : activeJob.outDir,
          logPath: binding.discarded ? null : activeJob.logPath,
          liveAudio: null,
        };
        return;
      }
      const bindingFailed = binding.code === 'LOCAL_INTERVIEW_BIND_FAILED';
      localInterviewJob = {
        ...activeJob,
        child: null,
        finalized: true,
        status: 'error',
        cleanupPending: false,
        bindingPending: true,
        finishedAt: nowIso(),
        message: bindingFailed
          ? `本地转写已完成，但未能绑定到原候选人面试轮次；材料已保留并阻止新录音：${binding.error}`
          : (activeJob.persistentStateFailed
            ? '无法持久记录录音绑定事务或完成状态；材料已保留并阻止新录音，系统将按相同来源幂等重试。'
            : '录音已写入原面试轮次，但完成状态需要幂等重试；材料已保留并阻止新录音。'),
        error: `${binding.code}: ${binding.error}`,
        result,
        liveAudio: null,
      };
      return;
    }
    localInterviewJob = {
      ...activeJob,
      child: null,
      finalized: true,
      status: 'done',
      cleanupPending: false,
      bindingPending: false,
      finishedAt: nowIso(),
      message: result && result.recovered ? '本地转写产物已恢复。' : '本地转写完成。',
      error: null,
      result,
      liveAudio: null,
    };
  };

  const finalizeAbortedJob = (settlement) => {
    const activeJob = currentJob();
    if (!activeJob || activeJob.finalized) return compactLocalInterviewJob(activeJob);
    if (!settlement || settlement.confirmed !== true) {
      activeJob.cleanupPending = true;
      activeJob.terminationUnconfirmed = true;
      activeJob.stopFailed = true;
      persistLocalInterviewState(activeJob, 'termination_unconfirmed');
      localInterviewJob = {
        ...activeJob,
        status: 'error',
        stopFailed: true,
        cleanupPending: true,
        terminationUnconfirmed: true,
        finishedAt: null,
        message: '候选人授权已撤回，但无法确认本地录音进程已停止；未执行材料清理。系统将持续核对，请勿继续面试或开始新录音。',
        error: 'LOCAL_INTERVIEW_TERMINATION_UNCONFIRMED',
        result: null,
        liveAudio: null,
      };
      return compactLocalInterviewJob(localInterviewJob);
    }
    activeJob.cleanupPending = true;
    activeJob.terminationUnconfirmed = false;
    if (activeJob.preserveRecordingAfterAbort === true) {
      const processError = activeJob.error || 'LOCAL_INTERVIEW_TRANSCRIPTION_RETRY_INTERRUPTED';
      const preservation = preserveFailedLocalInterviewTranscription(activeJob, processError);
      if (preservation) {
        localInterviewJob = {
          ...activeJob,
          child: null,
          finalized: true,
          status: 'error',
          transcriptionRetryable: true,
          stopFailed: !preservation.persisted,
          cleanupPending: false,
          bindingPending: false,
          terminationUnconfirmed: false,
          persistentStateFailed: !preservation.persisted,
          finishedAt: nowIso(),
          message: preservation.persisted
            ? '转写重试被中断；原录音已安全保留，可由 HR 再次手动重试或明确丢弃。'
            : '转写重试被中断；原录音仍保留，但可重试状态持久化失败，新的录音任务保持阻止。',
          error: preservation.persisted
            ? processError
            : `LOCAL_INTERVIEW_STATE_PERSIST_FAILED: ${activeJob.persistentStateError || processError}`,
          result: {
            mode: 'record',
            recordingPath: preservation.recordingPath,
            transcription_failed: true,
          },
          liveAudio: null,
        };
        return compactLocalInterviewJob(localInterviewJob);
      }
    }
    const guardianAlreadyCleaned = activeJob.guardianCleanupCompleted === true
      && !fs.existsSync(outDir);
    const cleanupStatePersisted = guardianAlreadyCleaned
      || persistLocalInterviewState(activeJob, 'cleanup_in_progress');
    const cleanup = guardianAlreadyCleaned
      ? { ok: true, removed: activeJob.guardianCleanupRemoved || [], failures: [] }
      : (cleanupStatePersisted
        ? cleanupAbortedLocalInterviewArtifacts(outDir, {
          jobId: activeJob.id,
          ownerToken: activeJob.ownerToken,
        })
        : {
          ok: false,
          removed: [],
          failures: [{ file: LOCAL_INTERVIEW_STATE_MARKER, error: activeJob.persistentStateError || 'cleanup state persistence failed' }],
        });
    const cleanupFailed = !cleanup.ok;
    if (cleanupFailed) {
      activeJob.cleanupPending = true;
      activeJob.terminationUnconfirmed = false;
      activeJob.stopFailed = true;
      persistLocalInterviewState(activeJob, 'cleanup_failed');
    }
    localInterviewJob = {
      ...activeJob,
      child: null,
      finalized: true,
      status: cleanupFailed ? 'error' : 'cancelled',
      stopFailed: cleanupFailed,
      cleanupPending: cleanupFailed,
      terminationUnconfirmed: false,
      persistentStateFailed: cleanupFailed ? !!activeJob.persistentStateFailed : false,
      persistentStateError: cleanupFailed ? activeJob.persistentStateError : null,
      finishedAt: nowIso(),
      message: cleanupFailed
        ? '录音进程已停止，但删除未完成材料时失败；请勿继续使用该任务。'
        : '候选人授权已撤回；录音进程已停止，未完成材料已删除。',
      error: cleanupFailed
        ? `incomplete interview artifact cleanup failed: ${cleanup.failures.map((item) => item.file || item.error).join(', ')}`
        : null,
      result: null,
      liveAudio: null,
    };
    return compactLocalInterviewJob(localInterviewJob);
  };

  const reconcileAbortedJob = () => {
    const activeJob = currentJob();
    if (!activeJob || !activeJob.abortRequested || activeJob.finalized) return false;
    const confirmed = activeJob.childStreamsClosed === true
      && activeJob.logClosed === true
      && localInterviewProcessGroupState(activeJob) === 'gone';
    if (!confirmed) return false;
    finalizeAbortedJob({
      confirmed: true,
      escalated: !!activeJob.terminationEscalated,
      group_state: 'gone',
      streams_closed: true,
    });
    return true;
  };

  const beginAbortSettlement = () => {
    const activeJob = currentJob();
    if (!activeJob) return Promise.resolve({ confirmed: false });
    if (activeJob.abortSettlementPromise) return activeJob.abortSettlementPromise;
    activeJob.cleanupPending = true;
    activeJob.message = activeJob.stopFailed
      ? '授权已撤回；停止请求未确认，正在安全终止本地录音任务。'
      : '授权已撤回；正在确认录音进程停止并清理未完成材料。';
    const settlementPromise = settleLocalInterviewProcessTree(activeJob).then((settlement) => {
      const latest = currentJob();
      if (latest) latest.terminationEscalated = settlement.escalated;
      finalizeAbortedJob(settlement);
      return settlement;
    }).catch((error) => {
      finalizeAbortedJob({ confirmed: false, error: error.message });
      return { confirmed: false, error: error.message };
    });
    activeJob.abortSettlementPromise = settlementPromise;
    return settlementPromise;
  };

  localInterviewJob.beginAbortSettlement = beginAbortSettlement;
  localInterviewJob.reconcileAbortedJob = reconcileAbortedJob;
  const cancelGuardedStartup = (code, error) => {
    const activeJob = currentJob();
    const response = {
      ok: false,
      status: 503,
      code,
      error,
      job: compactLocalInterviewJob(activeJob),
    };
    if (!activeJob || activeJob.startCancelled) return settleStartup(response);
    activeJob.startCancelled = true;
    if (retryingTranscription) activeJob.preserveRecordingAfterAbort = true;
    activeJob.stopRequested = true;
    activeJob.abortRequested = true;
    activeJob.cleanupPending = true;
    activeJob.status = 'starting';
    activeJob.message = `${error} 麦克风未获准启动，正在关闭安全守护并清理。`;
    const abortStatePersisted = persistLocalInterviewState(
      activeJob,
      retryingTranscription ? 'transcription_retry_running' : 'abort_pending',
    );
    const cancelDelivered = sendLocalInterviewGuardianCommand(activeJob, {
      type: 'cancel_before_start',
      reason: code,
    });
    activeJob.stopFailed = !cancelDelivered || !abortStatePersisted;
    activeJob.beginAbortSettlement();
    response.job = compactLocalInterviewJob(activeJob);
    return settleStartup(response);
  };

  guardianMessageHandler = (message) => {
    if (!message
        || message.schema_version !== GUARDIAN_IPC_SCHEMA
        || message.action_instance_id !== INSTANCE_ID
        || message.guardian_instance_id !== guardianInstanceId
        || message.job_id !== localJobId) return;
    const activeJob = currentJob();
    if (!activeJob) return;
    if (message.type === 'guardian_ready') {
      const processGroupId = Number(message.process_group_id);
      if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
        cancelGuardedStartup(
          'LOCAL_INTERVIEW_GUARDIAN_IDENTITY_INVALID',
          '本地录音安全守护未提供可信的进程组身份。',
        );
        return;
      }
      activeJob.processGroupId = processGroupId;
      if (activeJob.startCancelled
          || activeJob.abortRequested
          || activeJob.stopRequested
          || shuttingDown) {
        cancelGuardedStartup(
          'LOCAL_INTERVIEW_START_CANCELLED',
          '本地录音任务已进入停止或退出流程。',
        );
        return;
      }
      if (!localInterviewStartConsentValid(activeJob)) {
        cancelGuardedStartup(
          'INTERVIEW_RECORDING_CONSENT_REVOKED_BEFORE_START',
          '录音授权在安全启动握手期间已失效。',
        );
        return;
      }
      if (!persistLocalInterviewState(
        activeJob,
        retryingTranscription ? 'transcription_retry_running' : 'running',
      )) {
        cancelGuardedStartup(
          'LOCAL_INTERVIEW_STATE_PERSIST_FAILED',
          '无法持久记录本地录音运行状态。',
        );
        return;
      }
      activeJob.runningStatePersisted = true;
      const startDelivered = sendLocalInterviewGuardianCommand(activeJob, {
        type: 'start',
        start_token: guardianStartToken,
      });
      if (!startDelivered) {
        cancelGuardedStartup(
          'LOCAL_INTERVIEW_GUARDIAN_START_FAILED',
          '无法向本地录音安全守护确认启动。',
        );
        return;
      }
      activeJob.startCommandSent = true;
      activeJob.message = retryingTranscription
        ? '转写重试状态已安全落盘，正在等待本地处理进程确认。'
        : '录音运行状态已安全落盘，正在等待本地采集进程确认。';
      return;
    }
    if (message.type === 'worker_ready') {
      if (!activeJob.runningStatePersisted
          || !activeJob.startCommandSent
          || activeJob.startCancelled
          || activeJob.abortRequested
          || activeJob.stopRequested
          || shuttingDown
          || !localInterviewStartConsentValid(activeJob)) {
        cancelGuardedStartup(
          'LOCAL_INTERVIEW_START_ACK_INVALID',
          '本地采集进程就绪确认与授权或持久状态不一致。',
        );
        return;
      }
      const captureDelivered = sendLocalInterviewGuardianCommand(activeJob, {
        type: 'capture_authorize',
        capture_token: guardianCaptureToken,
      });
      if (!captureDelivered) {
        cancelGuardedStartup(
          'LOCAL_INTERVIEW_CAPTURE_AUTH_FAILED',
          '无法向本地采集进程送达一次性采集授权。',
        );
        return;
      }
      activeJob.captureAuthorizationSent = true;
      activeJob.message = ['from-file', 'retry-transcription'].includes(mode)
        ? '本地处理授权已确认，正在等待处理工具启动。'
        : '录音授权已再次确认，正在等待麦克风采集工具启动。';
      return;
    }
    if (message.type === 'capture_started' || message.type === 'processing_started') {
      const expectedType = ['from-file', 'retry-transcription'].includes(mode)
        ? 'processing_started'
        : 'capture_started';
      if (!activeJob.captureAuthorizationSent
          || message.type !== expectedType
          || activeJob.startCancelled
          || activeJob.abortRequested
          || activeJob.stopRequested
          || shuttingDown
          || !localInterviewStartConsentValid(activeJob)) {
        cancelGuardedStartup(
          'LOCAL_INTERVIEW_CAPTURE_ACK_INVALID',
          '本地采集工具启动确认与当前授权状态不一致。',
        );
        return;
      }
      activeJob.captureStartedAcknowledged = true;
      activeJob.status = 'running';
      activeJob.message = mode === 'record'
        ? '正在录音。'
        : (mode === 'mic-check'
          ? '正在进行麦克风预检。'
          : (mode === 'retry-transcription' ? '正在重试转写已保留的原录音。' : '正在转写本地音视频。'));
      settleStartup({
        ok: true,
        status: 200,
        job: compactLocalInterviewJob(activeJob),
      });
      return;
    }
    if (message.type === 'transcription_started') {
      if (mode !== 'record'
          || !activeJob.captureStartedAcknowledged
          || activeJob.abortRequested
          || shuttingDown) {
        activeJob.error = 'LOCAL_INTERVIEW_TRANSCRIPTION_ACK_INVALID';
        abortLocalInterviewJob(
          activeJob,
          '录音转写阶段确认与当前任务状态不一致；正在安全停止并保留已完成的原录音。',
          { preserveRecording: true },
        );
        return;
      }
      activeJob.transcriptionStarted = true;
      activeJob.preserveRecordingAfterAbort = true;
      if (!persistLocalInterviewState(activeJob, 'transcription_in_progress')) {
        activeJob.error = `LOCAL_INTERVIEW_STATE_PERSIST_FAILED: ${activeJob.persistentStateError}`;
        abortLocalInterviewJob(
          activeJob,
          '无法持久记录转写恢复状态；正在安全停止并保留已完成的原录音。',
          { preserveRecording: true },
        );
        return;
      }
      activeJob.message = '录音已结束，正在本地转写；若应用意外退出，原录音会保留供 HR 恢复。';
      return;
    }
    if (message.type === 'group_quiescent') {
      const proof = String(message.proof || '');
      if (!['gate_worker_closed_pgid_empty', 'gate_closed_verified_pgid_empty'].includes(proof)) {
        activeJob.terminationUnconfirmed = true;
        activeJob.error = 'LOCAL_INTERVIEW_GROUP_PROOF_INVALID';
        return;
      }
      activeJob.groupQuiescent = true;
      activeJob.groupQuiescenceProof = proof;
      reconcileAbortedJob();
      return;
    }
    if (message.type === 'guardian_exit') {
      if (message.cleanup && message.cleanup.ok === true) {
        activeJob.guardianCleanupCompleted = true;
        activeJob.guardianCleanupRemoved = Array.isArray(message.cleanup.removed)
          ? message.cleanup.removed.slice(0, 32)
          : [];
      }
      return;
    }
    if (['guardian_error', 'worker_error', 'guardian_force_failed'].includes(message.type)
        && !startupSettled) {
      cancelGuardedStartup(
        'LOCAL_INTERVIEW_GUARDIAN_START_FAILED',
        `本地录音安全守护启动失败：${message.error || message.type}`,
      );
    }
  };
  for (const queuedMessage of guardianMessageQueue.splice(0)) {
    guardianMessageHandler(queuedMessage);
  }
  const startupTimer = setTimeout(() => {
    cancelGuardedStartup(
      'LOCAL_INTERVIEW_GUARDIAN_START_TIMEOUT',
      '本地录音安全守护启动确认超时。',
    );
  }, 10_000);
  startup.finally(() => clearTimeout(startupTimer));

  child.stdout.on('data', (chunk) => log.write(chunk));
  child.stderr.on('data', (chunk) => stderrDemux.push(chunk));
  log.once('close', () => {
    const activeJob = currentJob();
    if (!activeJob) return;
    activeJob.logClosed = true;
    if (!reconcileAbortedJob()) finalizeNormalJob();
  });
  log.once('error', (error) => {
    const activeJob = currentJob();
    if (activeJob) activeJob.logError = error.message;
  });
  child.once('error', (error) => {
    const activeJob = currentJob();
    if (activeJob) activeJob.spawnError = error.message;
  });
  child.once('exit', (code, signal) => {
    const activeJob = currentJob();
    if (!activeJob) {
      return;
    }
    activeJob.exitCode = code;
    activeJob.exitSignal = signal || null;
    const guardianExitRequiresAbort = localInterviewGuardianExitRequiresAbort(activeJob);
    if (guardianExitRequiresAbort) {
      activeJob.unexpectedGuardianExit = true;
      activeJob.stopRequested = true;
      activeJob.abortRequested = true;
      activeJob.cleanupPending = true;
      activeJob.terminationUnconfirmed = true;
      if (retryingTranscription || activeJob.transcriptionStarted) {
        activeJob.preserveRecordingAfterAbort = true;
      }
      activeJob.message = '本地录音安全守护异常退出；正在直接核对并终止已验证的录音进程组。';
      activeJob.error = 'LOCAL_INTERVIEW_GUARDIAN_EXIT_UNCONFIRMED';
      persistLocalInterviewState(
        activeJob,
        retryingTranscription ? 'transcription_retry_running' : 'termination_unconfirmed',
      );
      signalLocalInterviewProcessTree(activeJob, 'SIGTERM', {
        reason: 'guardian_exited_unexpectedly',
      });
      beginAbortSettlement();
    } else if (!activeJob.groupQuiescent) {
      // The guardian may exit immediately after sending its proof. If that IPC
      // frame is lost, same-runtime ESRCH for the already verified gate PGID is
      // still a valid fail-safe termination proof. Preserve a completed result
      // for normal close/log finalization instead of converting it to an abort.
      activeJob.groupGoneAtGuardianExit = true;
    }
  });
  child.once('close', (code, signal) => {
    const activeJob = currentJob();
    if (!activeJob) {
      finishLog();
      return;
    }
    activeJob.exitCode = activeJob.exitCode == null ? code : activeJob.exitCode;
    activeJob.exitSignal = activeJob.exitSignal || signal || null;
    activeJob.childStreamsClosed = true;
    if (!startupSettled) {
      settleStartup({
        ok: false,
        status: 503,
        code: 'LOCAL_INTERVIEW_GUARDIAN_EXITED_BEFORE_START',
        error: '本地录音安全守护在采集确认前退出；麦克风未启动。',
        job: compactLocalInterviewJob(activeJob),
      });
    }
    finishLog();
    if (activeJob.abortRequested) {
      beginAbortSettlement();
      reconcileAbortedJob();
    } else {
      finalizeNormalJob();
    }
  });
  return {
    ok: true,
    status: 202,
    preparing: true,
    job: compactLocalInterviewJob(localInterviewJob),
    startup,
  };
}

function abortLocalInterviewJob(job, reason = '', options = {}) {
  if (!job || !job.child || job.finalized) {
    return { matched: false, stopped: false, job: compactLocalInterviewJob(job) };
  }
  if (job.abortRequested && job.abortSettlementPromise) {
    return {
      matched: true,
      stopped: !job.stopFailed,
      job: compactLocalInterviewJob(job),
      settlement: job.abortSettlementPromise,
    };
  }
  job.stopRequested = true;
  job.abortRequested = true;
  if (options.preserveRecording === true) job.preserveRecordingAfterAbort = true;
  job.cleanupPending = true;
  job.message = reason || '正在请求停止本地面试任务，并等待进程与数据流安全关闭。';
  const persistState = options.persistState || persistLocalInterviewState;
  const preserveRecording = options.preserveRecording === true
    || job.preserveRecordingAfterAbort === true;
  const abortState = preserveRecording
    ? (job.mode === 'retry-transcription'
      ? 'transcription_retry_running'
      : 'transcription_in_progress')
    : (job.mode === 'retry-transcription' ? 'cleanup_in_progress' : 'abort_pending');
  const statePersisted = persistState(job, abortState) === true;
  const stopped = signalLocalInterviewProcessTree(job, 'SIGTERM', options.signalOptions || {});
  job.stopFailed = !stopped || !statePersisted;
  const settlement = typeof job.beginAbortSettlement === 'function'
    ? job.beginAbortSettlement()
    : Promise.resolve({ confirmed: false, error: 'local interview abort controller is unavailable' });
  return {
    matched: true,
    stopped: stopped && statePersisted,
    job: compactLocalInterviewJob(job),
    settlement,
  };
}

function requestOwnedLocalInterviewManualStop(job, reason = '', options = {}) {
  job.abortRequested = false;
  job.cleanupPending = false;
  if (!persistLocalInterviewState(job, 'transcription_in_progress')) {
    job.stopRequested = false;
    job.stopFailed = true;
    job.message = '无法先持久记录转写恢复状态；未发送停止信号，请修复本机存储后重试停止。';
    return { matched: true, stopped: false, job: compactLocalInterviewJob(job) };
  }
  const stopped = signalLocalInterviewProcessTree(job, 'SIGINT', options);
  job.stopRequested = stopped;
  job.stopFailed = !stopped;
  job.message = stopped
    ? (reason || '已发送停止请求，正在结束录音并生成转写，请不要重复点击。')
    : '未能向本地录音进程组发送停止请求；录音可能仍在继续，请重试停止。';
  if (!stopped) persistLocalInterviewState(job, 'manual_stop_failed');
  return { matched: true, stopped, job: compactLocalInterviewJob(job) };
}

function localInterviewTaskScopeMatches(job, {
  taskId = '',
  candidateId = '',
  jobId = null,
  round = null,
} = {}) {
  if (!job) return false;
  if (taskId && String(job.id || '') !== String(taskId)) return false;
  if (candidateId && job.bindCandidateId !== candidateId) return false;
  if (jobId !== null && jobId !== '' && Number(job.bindJobId) !== Number(jobId)) return false;
  if (round != null && round !== '' && Number(job.bindRound) !== Number(round)) return false;
  return true;
}

function localInterviewStopMatches(job, {
  abort = false,
  taskId = '',
  candidateId = '',
  jobId = null,
  round = null,
} = {}) {
  const stoppableMode = abort
    ? ['record', 'mic-check', 'from-file', 'retry-transcription'].includes(job && job.mode)
    : job && job.mode === 'record';
  const stoppableStatus = abort
    ? ['starting', 'running'].includes(job && job.status)
    : job && job.status === 'running';
  if (!job || !stoppableStatus || !stoppableMode || !job.child) return false;
  return localInterviewTaskScopeMatches(job, {
    taskId,
    candidateId,
    jobId,
    round,
  });
}

function requestLocalInterviewStop({
  abort = false,
  reason = '',
  taskId = '',
  candidateId = '',
  jobId = null,
  round = null,
} = {}) {
  const job = localInterviewJob;
  if (abort
      && job
      && job.transcriptionRetryable === true
      && localInterviewTaskScopeMatches(job, { taskId, candidateId, jobId, round })) {
    return discardPreservedLocalInterviewRecording(
      job,
      reason || 'HR 已明确丢弃转写失败后保留的原录音。',
      { scope: { taskId, candidateId, jobId, round } },
    );
  }
  if (!localInterviewStopMatches(job, {
    abort,
    taskId,
    candidateId,
    jobId,
    round,
  })) return { matched: false, stopped: false, job: compactLocalInterviewJob(job) };
  if (abort) return abortLocalInterviewJob(job, reason);
  return requestOwnedLocalInterviewManualStop(job, reason);
}

function localInterviewLifecycleCloseBlocked(job, scope = {}) {
  return localInterviewTaskScopeMatches(job, scope) && localInterviewJobBlocksStart(job);
}

function localInterviewRecordStopDisposition(job, options = {}) {
  const assertRoundWritable = options.assertRoundWritable || db.assertInterviewRoundRecordingWritable;
  const assertJobWritable = options.assertJobWritable || db.assertJobRecruitingWritableById;
  if (job && job.bindCandidateId && job.bindJobId && job.bindRound) {
    try {
      assertRoundWritable({
        candidateId: job.bindCandidateId,
        jobId: job.bindJobId,
        round: job.bindRound,
      });
      return { mode: 'transcribe', reason: '' };
    } catch (error) {
      return {
        mode: 'discard',
        reason: error && error.code === 'JOB_CLOSED'
          ? '岗位已关闭'
          : '当前面试轮次已关闭、撤回或状态不可写',
        code: error && error.code ? error.code : 'INTERVIEW_CONTEXT_NOT_WRITABLE',
      };
    }
  }
  if (job && job.bindJobId) {
    try {
      assertJobWritable(job.bindJobId);
      return { mode: 'transcribe', reason: '' };
    } catch (error) {
      return {
        mode: 'discard',
        reason: '岗位状态不可写',
        code: error && error.code ? error.code : 'JOB_NOT_WRITABLE',
      };
    }
  }
  return { mode: 'transcribe', reason: '' };
}

function freshActiveProgress(progress) {
  if (!progress || !ACTIVE_PROGRESS_STATUSES.includes(progress.status)) return false;
  const raw = progress.updated_at || progress.started_at;
  if (!raw) return false;
  const time = Date.parse(raw);
  return Number.isFinite(time) && Date.now() - time <= ACTIVE_PROGRESS_STALE_MS;
}

function publicScreenshotImportProgress(raw) {
  const progress = raw || { status: 'idle' };
  const result = progress.result && typeof progress.result === 'object' ? {
    job_id: progress.result.job_id || null,
    job_name: progress.result.job_name || null,
    inserted: progress.result.inserted || 0,
    updated: progress.result.updated || 0,
    draft_created: progress.result.draft_created || 0,
    draft_reused: progress.result.draft_reused || 0,
    pending_review: progress.result.pending_review || 0,
    total: progress.result.total || 0,
    image_count: progress.result.image_count || 0,
    skipped_list_count: progress.result.skipped_list_count || 0,
    unrecognized_count: progress.result.unrecognized_count || 0,
    failed_count: progress.result.failed_count || 0,
  } : null;
  // Only trust the per-page counter while the OCR stage owns the run; a stale
  // file from an aborted batch must not decorate a later stage.
  const ocr = progress.status === 'running' && progress.stage === 'ocr'
    ? screenshotImportProgress.readOcrProgress()
    : null;
  return {
    status: progress.status || 'idle',
    run_id: progress.run_id || null,
    stage: progress.stage || null,
    source_dir_name: progress.source_dir_name || null,
    image_count: progress.image_count || 0,
    ocr_done: ocr ? ocr.done : (Number.isFinite(Number(progress.ocr_done)) ? Number(progress.ocr_done) : null),
    ocr_total: ocr ? ocr.total : (Number.isFinite(Number(progress.ocr_total)) ? Number(progress.ocr_total) : null),
    detail_draft_count: progress.detail_draft_count || 0,
    message: progress.message || '',
    error: progress.error || null,
    result,
    unrecognized_items: (Array.isArray(progress.unrecognized_items) ? progress.unrecognized_items : []).map((item, index) => ({
      image_id: String(item.image_id || `local-unrecognized-${index + 1}`),
      ordinal: Number.isSafeInteger(Number(item.ordinal)) ? Number(item.ordinal) : index + 1,
      file_name: path.basename(String(item.file_name || '')),
      status: 'unrecognized',
      retryable: false,
      error_code: 'LOCAL_VISION_UNRECOGNIZED',
    })),
    started_at: progress.started_at || null,
    finished_at: progress.finished_at || null,
    updated_at: progress.updated_at || null,
  };
}

function publicLegacyScreenshotTask(raw) {
  return legacyScreenshotTask(publicScreenshotImportProgress(raw));
}

function screenshotDraftPreview(id) {
  return resolveScreenshotDraftPreview(db.conn(), id);
}

async function route(req, res) {
  try {
    if (handleLocalPreflight(req, res)) return;
    if (!authorizeLocalRequest(req, res, LOCAL_API_TOKEN)) return;
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    let principal;
    try {
      principal = authorizePrincipalRequest(LOCAL_PRINCIPAL, req.method, url.pathname);
    } catch (authorizationError) {
      const unregistered = authorizationError.code === 'UNREGISTERED_ACTION_ROUTE';
      return send(res, unregistered ? 404 : 403, {
        ok: false,
        code: unregistered ? 'NOT_FOUND' : (authorizationError.code || 'LOCAL_AUTHORIZATION_DENIED'),
        error: unregistered ? 'not found' : authorizationError.message,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      db.listJobs();
      return send(res, 200, healthPayload('action', INSTANCE_ID));
    }

    if (req.method === 'GET' && url.pathname === '/api/assessment/status') {
      const capabilities = assessmentToolCapabilities();
      const retentionPolicyConfigured = Boolean(ASSESSMENT_RETENTION_POLICY);
      return send(res, 200, {
        ok: true,
        enabled: ASSESSMENT_PHASE_A_ENABLED,
        scope: 'hr_manual_assessment_reference',
        decision_use: ASSESSMENT_INTERNAL_AVAILABLE,
        decision_use_mode: ASSESSMENT_INTERNAL_AVAILABLE ? 'hr_confirmed_assessment_reference' : 'disabled',
        automated_decision_use: false,
        automatic_scoring_enabled: false,
        automatic_ranking_enabled: false,
        ranking_requires_hr_confirmed_binding: true,
        automatic_disposition_enabled: false,
        scoring_source: 'assessment_ai_fit_score_with_supplier_percentage_fallback',
        supplier_numeric_reference_enabled: ASSESSMENT_INTERNAL_AVAILABLE,
        ai_assisted_analysis_enabled: ASSESSMENT_INTERNAL_AVAILABLE,
        ai_requires_per_use_hr_approval: true,
        ai_result_requires_hr_review: true,
        original_pdf_view_enabled: false,
        real_pdf_pilot_allowed: false,
        internal_feature_available: ASSESSMENT_INTERNAL_AVAILABLE,
        archive_read_enabled: ASSESSMENT_INTERNAL_AVAILABLE,
        import_enabled: ASSESSMENT_INTERNAL_AVAILABLE
          && retentionPolicyConfigured
          && capabilities.archive_import_available,
        local_tool_capabilities: capabilities.available,
        missing_required_dependencies: capabilities.missing_required,
        text_analysis_available: capabilities.text_analysis_available,
        text_analysis_mode: capabilities.text_analysis_mode,
        windows_release_ready: process.platform !== 'win32' || capabilities.archive_import_available,
        retention_policy_configured: retentionPolicyConfigured,
        retention_policy_version: ASSESSMENT_RETENTION_POLICY ? ASSESSMENT_RETENTION_POLICY.version : null,
        retention_days: ASSESSMENT_RETENTION_POLICY ? ASSESSMENT_RETENTION_POLICY.days : null,
        delete_enabled: retentionPolicyConfigured,
        export_enabled: false,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/f018/status') {
      try {
        requireF018Service();
        return send(res, 200, {
          ok: true,
          enabled: true,
          scope: 'universal_application_and_manual_final_review',
          release_allowed: false,
          decision_use_allowed: false,
          assessment_evidence_allowed: true,
          assessment_influence_enabled: ASSESSMENT_INTERNAL_AVAILABLE,
          assessment_influence_mode: ASSESSMENT_INTERNAL_AVAILABLE
            ? 'hr_confirmed_reference_only'
            : 'disabled',
          assessment_automatic_decision_enabled: false,
          hired_enabled: false,
          automatic_disposition_enabled: false,
        });
      } catch (error) {
        return sendF018Error(res, error);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/f018/application') {
      try {
        const command = f018Command({
          candidate_id: url.searchParams.get('candidateId'),
          job_id: Number(url.searchParams.get('jobId')),
        });
        const state = readF018State(command);
        return send(res, 200, { ok: true, applications: state.applications });
      } catch (error) {
        return sendF018Error(res, error);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/f018/final-review') {
      try {
        const command = f018Command({
          candidate_id: url.searchParams.get('candidateId'),
          job_id: Number(url.searchParams.get('jobId')),
        });
        return send(res, 200, { ok: true, state: readF018State(command) });
      } catch (error) {
        return sendF018Error(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/f018/application/open') {
      const command = f018Command(await readBody(req));
      try {
        const service = requireF018Service();
        assertF018Context(db.conn(), command, null);
        return send(res, 200, { ok: true, application: service.openApplication(command) });
      } catch (error) {
        return sendF018Error(res, error);
      }
    }

    const f018ApplicationTransition = req.method === 'POST'
      ? url.pathname.match(/^\/api\/f018\/application\/(withdraw|close|reenter)$/)
      : null;
    if (f018ApplicationTransition) {
      const command = f018Command(await readBody(req));
      try {
        const service = requireF018Service();
        assertF018Context(db.conn(), command);
        const method = {
          withdraw: 'withdrawApplication',
          close: 'closeApplication',
          reenter: 'reenterApplication',
        }[f018ApplicationTransition[1]];
        return send(res, 200, {
          ok: true,
          application: service[method](withoutF018Context(command)),
        });
      } catch (error) {
        return sendF018Error(res, error);
      }
    }

    const f018ReviewAction = req.method === 'POST'
      ? url.pathname.match(/^\/api\/f018\/final-review\/(draft|update|confirm|reopen)$/)
      : null;
    if (f018ReviewAction) {
      const command = f018Command(await readBody(req));
      try {
        requireF018Service();
        assertF018Context(db.conn(), command);
        const operation = {
          draft: createFinalReview,
          update: updateFinalReview,
          confirm: confirmFinalReview,
          reopen: reopenFinalReview,
        }[f018ReviewAction[1]];
        const review = operation({
          database: db.conn(),
          auditContext: f018AuditContext(),
          command: withoutF018Context(command),
        });
        return send(res, 200, { ok: true, review });
      } catch (error) {
        return sendF018Error(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/f018/disposition') {
      const command = f018Command(await readBody(req));
      try {
        requireF018Service();
        assertF018Context(db.conn(), command);
        const disposition = recordFinalDisposition({
          database: db.conn(),
          auditContext: f018AuditContext(),
          command: withoutF018Context(command),
        });
        return send(res, 200, { ok: true, disposition });
      } catch (error) {
        return sendF018Error(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/assessment/import') {
      const body = await readBody(req);
      try {
        const ingress = prepareAssessmentIngress(body);
        const result = await getAssessmentProductService().importSelected(ingress);
        return send(res, 200, { ok: true, result });
      } catch (error) {
        return sendAssessmentError(res, error);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/assessment/archive') {
      try {
        const ingress = prepareAssessmentIngress({
          candidate_id: url.searchParams.get('candidateId'),
          job_id: url.searchParams.get('jobId'),
        });
        return send(res, 200, { ok: true, archives: await getAssessmentProductService().listArchives(ingress) });
      } catch (error) {
        return sendAssessmentError(res, error);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/assessment/ai-analysis') {
      try {
        const ingress = prepareAssessmentIngress({
          candidate_id: url.searchParams.get('candidateId'),
          job_id: url.searchParams.get('jobId'),
        });
        return send(res, 200, {
          ok: true,
          analyses: getAssessmentProductService().listAiAnalyses(ingress),
        });
      } catch (error) {
        return sendAssessmentError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/assessment/ai-analysis/generate') {
      const body = await readBody(req);
      const candidateId = String(body.candidate_id || body.candidateId || '').trim();
      const jobId = Number(body.job_id === undefined ? body.jobId : body.job_id);
      const requestId = String(body.request_id || body.requestId || '').trim();
      try {
        db.assertCandidateJobRecruitingWritable(candidateId);
      } catch (error) {
        return sendAssessmentError(res, error);
      }
      let connectionBinding;
      try {
        connectionBinding = currentExternalAiConnectionBinding();
        const materialSha256 = currentExternalAiMaterialHash(
          ASSESSMENT_AI_PURPOSE,
          candidateId,
          { jobId },
        );
        consumeExternalAiUserApproval(
          f009ApprovalSecret,
          body.userApproval,
          {
            purpose: ASSESSMENT_AI_PURPOSE,
            targetId: candidateId,
            requestId,
            actor: principal.actor_id,
            materialSha256,
            ...connectionBinding,
          },
          consumedExternalAiApprovalNonces,
        );
      } catch (approvalError) {
        return send(res, 403, {
          ok: false,
          code: 'external_ai_confirmation_required',
          error: approvalError.message,
        });
      }
      const runningKey = `${candidateId}:${jobId}`;
      if (assessmentAiRunning.has(runningKey)) {
        return send(res, 409, { ok: false, code: 'ASSESSMENT_AI_RUNNING', error: '这位候选人的测评 AI 分析正在生成中。' });
      }
      assessmentAiRunning.add(runningKey);
      try {
        const authorization = issueExternalAiAuthorization({
          purpose: ASSESSMENT_AI_PURPOSE,
          confirmed: true,
          requestedBy: principal.actor_id,
          binding: connectionBinding,
        });
        const analysis = await getAssessmentProductService().generateAiAnalysis({
          ...prepareAssessmentIngress({ ...body, candidate_id: candidateId, job_id: jobId, request_id: requestId }),
          externalAiAuthorization: authorization,
        });
        return send(res, 200, { ok: true, analysis });
      } catch (error) {
        return sendAssessmentError(res, error);
      } finally {
        assessmentAiRunning.delete(runningKey);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/assessment/queue') {
      try {
        const ingress = prepareAssessmentIngress({ job_id: url.searchParams.get('jobId') });
        return send(res, 200, { ok: true, queue: await getAssessmentProductService().listQueue(ingress) });
      } catch (error) {
        return sendAssessmentError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/assessment/binding/confirm') {
      const body = await readBody(req);
      try {
        return send(res, 200, {
          ok: true,
          result: getAssessmentProductService().confirmBinding(prepareAssessmentIngress(body)),
        });
      } catch (error) {
        return sendAssessmentError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/assessment/metadata/confirm') {
      const body = await readBody(req);
      try {
        return send(res, 200, {
          ok: true,
          result: getAssessmentProductService().confirmMetadata(prepareAssessmentIngress(body)),
        });
      } catch (error) {
        return sendAssessmentError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/assessment/binding/revoke') {
      const body = await readBody(req);
      try {
        return send(res, 200, {
          ok: true,
          result: getAssessmentProductService().revokeBinding(prepareAssessmentIngress(body)),
        });
      } catch (error) {
        return sendAssessmentError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/assessment/duplicate/resolve') {
      const body = await readBody(req);
      try {
        return send(res, 200, {
          ok: true,
          result: getAssessmentProductService().resolveDuplicateBinding(prepareAssessmentIngress(body)),
        });
      } catch (error) {
        return sendAssessmentError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/assessment/deletion/request') {
      const body = await readBody(req);
      try {
        return send(res, 200, {
          ok: true,
          result: getAssessmentProductService().requestDeletion(prepareAssessmentIngress(body)),
        });
      } catch (error) {
        return sendAssessmentError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/assessment/deletion/confirm') {
      const body = await readBody(req);
      try {
        return send(res, 200, {
          ok: true,
          result: getAssessmentProductService().confirmDeletion(prepareAssessmentIngress(body)),
        });
      } catch (error) {
        return sendAssessmentError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/assessment/preview') {
      const body = await readBody(req);
      try {
        return send(res, 200, {
          ok: true,
          preview: getAssessmentProductService().createPreview(prepareAssessmentIngress(body)),
        });
      } catch (error) {
        return sendAssessmentError(res, error);
      }
    }

    const assessmentPreviewPageMatch = req.method === 'GET'
      ? url.pathname.match(/^\/api\/assessment\/preview\/([0-9a-f-]{36})\/page\/(\d+)$/)
      : null;
    if (assessmentPreviewPageMatch) {
      try {
        const bytes = getAssessmentProductService().getPreviewPage(
          assessmentPreviewPageMatch[1],
          assessmentPreviewPageMatch[2],
        );
        return sendBinary(res, 200, bytes, 'image/png');
      } catch (error) {
        return sendAssessmentError(res, error);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/job-templates/ecommerce') {
      return send(res, 200, {
        ok: true,
        catalog: publicEcommerceTemplateCatalog(),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/candidate-journey-operations') {
      try {
        return send(res, 200, {
          ok: true,
          ...db.getCandidateJourneyOperations({
            candidateId: url.searchParams.get('candidateId'),
            jobId: url.searchParams.get('jobId'),
          }),
        });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, {
          ok: false,
          code: error && error.code ? error.code : 'CANDIDATE_JOURNEY_READ_FAILED',
          error: error.message,
        });
      }
    }

    const candidateJourneyAction = req.method === 'POST'
      ? url.pathname.match(/^\/api\/candidate-journey\/(next-action|manager-feedback|offer-status)$/)
      : null;
    if (candidateJourneyAction) {
      const body = await readBody(req);
      try {
        const operation = candidateJourneyAction[1];
        const result = operation === 'next-action'
          ? db.setCandidateNextAction({ ...body, actor: principal.actor_id })
          : operation === 'manager-feedback'
            ? db.recordHiringManagerFeedback({ ...body, actor: principal.actor_id })
            : db.setCandidateOfferStatus({ ...body, actor: principal.actor_id });
        return send(res, 200, { ok: true, ...result });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, {
          ok: false,
          code: error && error.code ? error.code : 'CANDIDATE_JOURNEY_WRITE_FAILED',
          error: error.message,
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/jobs/from-template') {
      const body = await readBody(req);
      try {
        return send(res, 201, {
          ok: true,
          ...db.createLocalJobFromEcommerceTemplate({
            ...body,
            actor: principal.actor_id,
            requireCreateRequestId: true,
          }),
        });
      } catch (error) {
        const publicCode = error && /^(JOB_TEMPLATE_|JOB_CREATE_)/.test(String(error.code || ''))
          ? error.code
          : 'JOB_TEMPLATE_CREATE_FAILED';
        return send(res, Number(error && error.statusCode) || 400, {
          ok: false,
          code: publicCode,
          error: error.message,
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/jobs') {
      const body = await readBody(req);
      try {
        return send(res, 201, {
          ok: true,
          job: db.createLocalJob({
            ...body,
            actor: principal.actor_id,
            requireCreateRequestId: true,
          }),
        });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, {
          ok: false,
          code: error && error.code ? error.code : 'JOB_CREATE_FAILED',
          error: error.message,
        });
      }
    }

    const jobLedgerActionMatch = req.method === 'POST'
      ? url.pathname.match(/^\/api\/jobs\/(\d+)\/(copy|details|status)$/)
      : null;
    if (jobLedgerActionMatch) {
      const body = await readBody(req);
      const jobId = Number(jobLedgerActionMatch[1]);
      try {
        if (jobLedgerActionMatch[2] === 'copy') {
          return send(res, 201, {
            ok: true,
            job: db.copyJob({
              ...body,
              jobId,
              actor: principal.actor_id,
              requireRequestId: true,
            }),
          });
        }
        if (jobLedgerActionMatch[2] === 'details') {
          const result = db.updateJobDetails({ ...body, jobId, actor: principal.actor_id });
          return send(res, 200, { ok: true, ...result });
        }
        if (
          String(body.status || '').trim().toLowerCase() === 'closed'
          && localInterviewJob?.transcriptionRetryable === true
        ) {
          const discarded = requestLocalInterviewStop({
            abort: true,
            reason: '岗位已明确关闭；转写失败后保留的未归档原录音已删除。',
            jobId,
          });
          if (discarded.matched && !discarded.stopped) {
            return send(res, 503, {
              ok: false,
              code: 'JOB_LOCAL_INTERVIEW_DISCARD_FAILED',
              error: '关闭岗位前未能删除转写失败后保留的原录音；岗位未关闭，请重试。',
              job: discarded.job,
            });
          }
        }
        if (
          String(body.status || '').trim().toLowerCase() === 'closed'
          && localInterviewLifecycleCloseBlocked(localInterviewJob, { jobId })
        ) {
          return send(res, 409, {
            ok: false,
            code: 'JOB_LOCAL_INTERVIEW_ACTIVE',
            error: '该岗位仍有正在启动、运行或清理中的本地面试任务；请先停止并完成安全清理，再关闭岗位。',
            job: compactLocalInterviewJob(localInterviewJob),
          });
        }
        const result = db.updateJobStatus({ ...body, jobId, actor: principal.actor_id });
        return send(res, 200, { ok: true, ...result });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, {
          ok: false,
          code: error && error.code ? error.code : 'JOB_UPDATE_FAILED',
          error: error.message,
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/talent-pool/add-to-job') {
      const body = await readBody(req);
      try {
        const relation = db.addTalentToJob({ ...body, actor: principal.actor_id });
        return send(res, relation.inserted ? 201 : 200, { ok: true, relation });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, {
          ok: false,
          code: error && error.code ? error.code : 'TALENT_ADD_TO_JOB_FAILED',
          error: error.message,
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/job-jd-version') {
      const body = await readBody(req);
      try {
        return send(res, 200, { ok: true, version: db.createJobJdVersion({ ...body, actor: principal.actor_id }) });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || (error.code === 'STALE_VERSION' ? 409 : 400), { ok: false, error: error.message, code: error.code || null });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/external-ai/material-hash') {
      const body = await readBody(req);
      const purpose = String(body.purpose || '').trim();
      const targetId = String(body.targetId || body.target_id || '').trim();
      const materialInput = body.materialInput && typeof body.materialInput === 'object' && !Array.isArray(body.materialInput)
        ? body.materialInput
        : {};
      try {
        const snapshot = currentExternalAiMaterialSnapshot(purpose, targetId, materialInput);
        const config = f009Runtime.publicConfig();
        return send(res, 200, {
          ok: true,
          materialHash: snapshot.materialHash,
          preview: snapshot.preview,
          provider: config.provider,
          baseUrl: config.baseUrl,
          model: config.model,
        });
      } catch (error) {
        return send(res, 400, { ok: false, code: 'EXTERNAL_AI_MATERIAL_NOT_READY', error: error.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/job-jd/optimize') {
      const body = await readBody(req);
      const jobId = Number(body.jobId);
      const brief = String(body.brief || '').trim();
      const currentJd = String(body.currentJd || '').trim();
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
      if (!brief && !currentJd) return send(res, 400, { ok: false, error: '请先填写自然语言招聘需求或现有 JD。' });
      if (brief.length > 20000 || currentJd.length > 50000) {
        return send(res, 400, { ok: false, error: 'JD 输入过长，请精简后重试。' });
      }
      const job = db.getJobForFetch(jobId);
      if (!job) return send(res, 404, { ok: false, error: '岗位不存在。' });
      if (job.status === 'closed') return send(res, 409, { ok: false, code: 'JOB_CLOSED', error: '岗位已关闭，请重新开启后再生成 JD 草稿。' });
      try {
        const connectionBinding = currentExternalAiConnectionBinding();
        const materialSha256 = currentExternalAiMaterialHash(
          JOB_JD_OPTIMIZATION_PURPOSE,
          String(jobId),
          { brief, currentJd },
        );
        consumeExternalAiUserApproval(
          f009ApprovalSecret,
          body.userApproval,
          {
            purpose: JOB_JD_OPTIMIZATION_PURPOSE,
            targetId: String(jobId),
            requestId: body.requestId,
            actor: principal.actor_id,
            materialSha256,
            ...connectionBinding,
          },
          consumedExternalAiApprovalNonces,
        );
      } catch (approvalError) {
        return send(res, 403, {
          ok: false,
          code: 'external_ai_confirmation_required',
          error: approvalError.message,
        });
      }
      try {
        const authorization = issueExternalAiAuthorization({
          purpose: JOB_JD_OPTIMIZATION_PURPOSE,
          confirmed: true,
          requestedBy: principal.actor_id,
          binding: currentExternalAiConnectionBinding(),
        });
        const draft = await f009Runtime.optimizeJobDescription({
          jobName: job.name,
          brief,
          currentJd,
        }, authorization);
        return send(res, 200, { ok: true, draft });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 502, {
          ok: false,
          code: error && error.code ? error.code : null,
          error: error.message,
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/job-jd-version/activate') {
      const body = await readBody(req);
      try {
        return send(res, 200, { ok: true, version: db.activateJobJdVersion({ ...body, actor: principal.actor_id }) });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || (error.message === 'STALE_VERSION' ? 409 : 400), { ok: false, error: error.message, code: error.code || (error.message === 'STALE_VERSION' ? 'STALE_VERSION' : null) });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/job-profile-version') {
      const body = await readBody(req);
      try {
        return send(res, 200, { ok: true, version: db.createJobProfileVersion({ ...body, actor: principal.actor_id }) });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, { ok: false, error: error.message, code: error.code || null });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/job-profile-version/confirm') {
      const body = await readBody(req);
      try {
        return send(res, 200, { ok: true, version: db.confirmJobProfileVersion({ ...body, actor: principal.actor_id }) });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || (error.message === 'STALE_VERSION' ? 409 : 400), { ok: false, error: error.message, code: error.code || (error.message === 'STALE_VERSION' ? 'STALE_VERSION' : null) });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/candidate-status') {
      const body = await readBody(req);
      try {
        const candidateId = String(body.candidateId || '').trim();
        db.assertCandidateJobRecruitingWritable(candidateId);
        if (body.layer === 'disposition' && body.action) {
          // Manual HR actions keep using the episode-aware service whenever the
          // application tables exist. The optional F018 final-review feature flag
          // must not disable this core HR entry point.
          const result = createHrManualDispositionService({
            database: db.conn(),
            actorContext: { actor_id: principal.actor_id },
          }).apply({
            candidate_id: candidateId,
            job_id: body.jobId,
            action: body.action || body.code,
            reason: body.reason,
            request_id: body.requestId,
          });
          return send(res, 200, {
            ok: true,
            ...result,
            candidate: db.getCandidate(candidateId),
          });
        }
        const statusChange = db.changeStatus(candidateId, body.layer, body.code, body.source || 'manual', principal.actor_id, body.reason || '');
        return send(res, 200, { ok: true, status_change: statusChange, candidate: db.getCandidate(candidateId) });
      } catch (error) {
        const status = Number(error && error.statusCode) || 400;
        return send(res, status, { ok: false, code: error && error.code, error: error.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-session') {
      const body = await readBody(req);
      try {
        return send(res, 200, {
          ok: true,
          session: db.createNextInterviewSession({
            candidateId: body.candidateId,
            jobId: body.jobId,
            mode: body.mode,
            interviewFormat: body.interviewFormat === undefined ? body.interview_format : body.interviewFormat,
          }),
        });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, { ok: false, code: error.code || null, error: error.message });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/interview-session/manual-note') {
      const sessionId = Number(url.searchParams.get('sessionId'));
      if (!sessionId) return send(res, 400, { ok: false, code: 'SESSION_REQUIRED', error: 'sessionId required' });
      try {
        const note = db.getInterviewManualNote({ sessionId });
        const revisions = db.listInterviewManualNoteRevisions({ sessionId });
        auditSensitiveRead('interview_manual_note_read', sessionId);
        return send(res, 200, { ok: true, note, revisions });
      } catch (error) {
        return sendInterviewReportError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-session/manual-note') {
      const body = await readBody(req);
      try {
        const note = db.saveInterviewManualNote({
          sessionId: body.sessionId,
          body: body.body,
          expectedVersion: body.expectedVersion,
          actor: principal.actor_id,
        });
        return send(res, 200, { ok: true, note });
      } catch (error) {
        return sendInterviewReportError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-session/manual-note/revoke') {
      const body = await readBody(req);
      try {
        const note = db.revokeInterviewManualNote({
          sessionId: body.sessionId,
          expectedVersion: body.expectedVersion,
          confirmed: body.confirmed,
          actor: principal.actor_id,
        });
        return send(res, 200, { ok: true, note });
      } catch (error) {
        return sendInterviewReportError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-session/schedule') {
      const body = await readBody(req);
      try {
        return send(res, 200, {
          ok: true,
          session: db.confirmInterviewSessionSchedule({
            ...body,
            confirmedBy: principal.actor_id,
            confirmed: body.confirmed === true,
          }),
        });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, { ok: false, code: error.code || null, error: error.message });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/interviewers') {
      try {
        return send(res, 200, {
          ok: true,
          interviewers: db.listInterviewInterviewers({
            includeInactive: url.searchParams.get('includeInactive') === '1',
          }),
        });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, { ok: false, code: error.code || null, error: error.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interviewers') {
      const body = await readBody(req);
      try {
        const interviewer = body.id === undefined && body.interviewerId === undefined
          ? db.createInterviewInterviewer({ name: body.name, active: body.active, actor: principal.actor_id })
          : db.updateInterviewInterviewer({
            id: body.id === undefined ? body.interviewerId : body.id,
            ...(Object.hasOwn(body, 'name') ? { name: body.name } : {}),
            ...(Object.hasOwn(body, 'active') ? { active: body.active } : {}),
            actor: principal.actor_id,
          });
        return send(res, body.id === undefined && body.interviewerId === undefined ? 201 : 200, { ok: true, interviewer });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, { ok: false, code: error.code || null, error: error.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-session/invitation-sent') {
      const body = await readBody(req);
      try {
        return send(res, 200, {
          ok: true,
          session: db.markInterviewInvitationSent({
            sessionId: body.sessionId === undefined ? body.session_id : body.sessionId,
            confirmed: body.confirmed === true,
            actor: principal.actor_id,
          }),
        });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, { ok: false, code: error.code || null, error: error.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-session/candidate-confirmation') {
      const body = await readBody(req);
      try {
        return send(res, 200, {
          ok: true,
          session: db.recordInterviewCandidateConfirmation({
            sessionId: body.sessionId === undefined ? body.session_id : body.sessionId,
            status: body.status === undefined
              ? (body.candidate_confirmation_status === undefined ? body.candidateConfirmationStatus : body.candidate_confirmation_status)
              : body.status,
            confirmed: body.confirmed === true,
            actor: principal.actor_id,
          }),
        });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, { ok: false, code: error.code || null, error: error.message });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/interview-lifecycle/status') {
      const sessionId = Number(url.searchParams.get('sessionId'));
      if (!sessionId) return send(res, 400, { ok: false, code: 'SESSION_REQUIRED', error: 'sessionId required' });
      try {
        const lifecycle = db.getInterviewLifecycleStatus({ sessionId });
        auditSensitiveRead('interview_lifecycle_status_read', sessionId);
        return send(res, 200, { ok: true, lifecycle });
      } catch (error) {
        return sendInterviewReportError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-lifecycle/withdraw') {
      const body = await readBody(req);
      if (body.confirmed !== true) return send(res, 400, { ok: false, code: 'EXPLICIT_CONFIRM_REQUIRED', error: '撤回必须显式 confirmed=true。' });
      try {
        const session = db.getInterviewSession(body.sessionId);
        if (!session) return send(res, 404, { ok: false, code: 'SESSION_NOT_FOUND', error: 'interview session not found' });
        const result = withdrawInterviewLifecycleAndStop(session, {
          sessionId: body.sessionId,
          reasonCode: body.reasonCode,
        });
        const response = interviewLifecycleWithdrawalHttpResult(result);
        return send(res, response.status, response.body);
      } catch (error) {
        return sendInterviewReportError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-lifecycle/close') {
      const body = await readBody(req);
      if (body.confirmed !== true) return send(res, 400, { ok: false, code: 'EXPLICIT_CONFIRM_REQUIRED', error: '关闭招聘必须显式 confirmed=true。' });
      try {
        const session = db.getInterviewSession(body.sessionId);
        if (!session) return send(res, 404, { ok: false, code: 'SESSION_NOT_FOUND', error: 'interview session not found' });
        if (localInterviewJob?.transcriptionRetryable === true
            && localInterviewTaskScopeMatches(localInterviewJob, {
              candidateId: session.candidate_id,
              jobId: session.job_id,
              round: session.round,
            })) {
          const discarded = requestLocalInterviewStop({
            abort: true,
            reason: '面试 Session 已明确关闭；转写失败后保留的未归档原录音已删除。',
            candidateId: session.candidate_id,
            jobId: session.job_id,
            round: session.round,
          });
          if (!discarded.stopped) {
            return send(res, 503, {
              ok: false,
              code: 'INTERVIEW_RECORDING_DISCARD_FAILED',
              error: '关闭面试前未能删除转写失败后保留的原录音；面试未关闭，请重试。',
              job: discarded.job,
            });
          }
        }
        if (localInterviewLifecycleCloseBlocked(localInterviewJob, {
          candidateId: session.candidate_id,
          jobId: session.job_id,
          round: session.round,
        })) {
          return send(res, 409, {
            ok: false,
            code: 'INTERVIEW_RECORDING_ACTIVE',
            error: '当前面试轮次仍有正在启动、运行、归档或清理中的本地任务；请先停止并完成安全清理，再关闭保留期。',
            job: compactLocalInterviewJob(localInterviewJob),
          });
        }
        const lifecycle = db.closeInterviewLifecycle({ sessionId: body.sessionId, reasonCode: body.reasonCode });
        return send(res, 200, { ok: true, lifecycle });
      } catch (error) {
        return sendInterviewReportError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-lifecycle/legal-hold/apply') {
      const body = await readBody(req);
      try {
        const hold = db.applyInterviewLegalHold({
          sessionId: body.sessionId,
          reasonCode: body.reasonCode,
          expiresAt: body.expiresAt,
        });
        return send(res, 200, { ok: true, hold });
      } catch (error) {
        return sendInterviewReportError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-lifecycle/legal-hold/release') {
      const body = await readBody(req);
      if (body.confirmed !== true) return send(res, 400, { ok: false, code: 'EXPLICIT_CONFIRM_REQUIRED', error: '解除 legal hold 必须显式 confirmed=true。' });
      try {
        const hold = db.releaseInterviewLegalHold({ holdId: body.holdId, reasonCode: body.reasonCode });
        return send(res, 200, { ok: true, hold });
      } catch (error) {
        return sendInterviewReportError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-lifecycle/deletion/dry-run') {
      const body = await readBody(req);
      try {
        const manifest = db.createInterviewDeletionDryRun({ sessionId: body.sessionId });
        return send(res, 200, { ok: true, manifest });
      } catch (error) {
        return sendInterviewReportError(res, error);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-lifecycle/deletion/confirm') {
      const body = await readBody(req);
      if (body.confirmed !== true) return send(res, 400, { ok: false, code: 'EXPLICIT_CONFIRM_REQUIRED', error: '删除必须显式 confirmed=true。' });
      try {
        const result = db.confirmInterviewDeletion({
          manifestId: body.manifestId,
          confirmationToken: body.confirmationToken,
          reasonCode: body.reasonCode,
        });
        return send(res, 200, { ok: true, result });
      } catch (error) {
        return sendInterviewReportError(res, error);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/profile') {
      const jobId = Number(url.searchParams.get('jobId'));
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
      return send(res, 200, {
        ok: true,
        config: db.getJobProfile(jobId),
        generation_readiness: db.getDeepProfileGenerationReadiness(jobId),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/interview/import-lark/status') {
      const enabled = process.env.ENABLE_LARK_IMPORT === '1';
      return send(res, 200, {
        ok: true,
        enabled,
        status: enabled ? 'enabled' : 'disabled',
        source_type: 'lark_minutes',
        requires_explicit_action: true,
      });
    }

    // 普通保存只接收已有转写，任何链接都不会在这个端点触发外部工具。
    if (req.method === 'POST' && url.pathname === '/api/interview') {
      const body = await readBody(req);
      const jobId = Number(body.jobId);
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
      const transcript = typeof body.transcript === 'string' ? body.transcript : '';
      const sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
      if (!transcript.trim()) return send(res, 400, { ok: false, error: '普通保存不会自动拉取会议链接。请粘贴转写文本，或使用“从飞书妙记导入转写”按钮。' });
      const sourceType = normalizeInterviewSourceType(body.sourceType);
      if (sourceType === 'lark_minutes') {
        return send(res, 400, { ok: false, error: '线上会议材料必须通过显式的飞书妙记导入动作保存。' });
      }
      const row = db.insertInterview({
        job_id: jobId,
        source_url: sourceUrl || null,
        transcript,
        note: taggedInterviewNote(body.note, sourceType),
        source_type: sourceType,
      });
      return send(res, 200, { ok: true, id: row.id, source_type: row.source_type });
    }

    // 飞书妙记只允许通过这个显式动作导入；P0 本地演示默认关闭且不会执行 lark-cli。
    if (req.method === 'POST' && url.pathname === '/api/interview/import-lark') {
      if (process.env.ENABLE_LARK_IMPORT !== '1') {
        return send(res, 403, {
          ok: false,
          status: 'disabled',
          code: 'lark_import_disabled',
          source_type: 'lark_minutes',
          error: '当前为 P0 本地演示边界：线上会议导入默认关闭。管理员设置 ENABLE_LARK_IMPORT=1 后才会执行；现在可改用线下录音转写或手动粘贴转写。',
        });
      }
      const body = await readBody(req);
      const jobId = Number(body.jobId);
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
      try {
        db.assertJobRecruitingWritableById(jobId);
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
      const sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
      if (!sourceUrl) return send(res, 400, { ok: false, error: '请先粘贴飞书妙记链接。' });
      const transcript = await fetchMinutesTranscript(sourceUrl);
      const sourceType = 'lark_minutes';
      const adapted = interviewAdapters.ingestOnlineMinutes({
        jobId,
        sourceUrl,
        transcript,
        note: taggedInterviewNote(body.note, sourceType),
        candidateId: typeof body.candidateId === 'string' ? body.candidateId.trim() : '',
        round: body.round,
        actor: principal.actor_id,
        reason: typeof body.reason === 'string' ? body.reason.trim() : '',
        requestId: typeof body.requestId === 'string' ? body.requestId.trim() : '',
      });
      return send(res, 200, {
        ok: true,
        id: adapted.assignment.job_interview_id,
        source_type: sourceType,
        assignment: adapted.assignment,
        session: adapted.session,
        idempotent_replay: adapted.idempotent_replay,
        duplicate_suspect: adapted.duplicate_suspect,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/interview') {
      const jobId = Number(url.searchParams.get('jobId'));
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
      const interviews = db.listInterviews(jobId).map(publicInterview);
      auditSensitiveRead('interview_list_read', jobId);
      return send(res, 200, { ok: true, interviews });
    }

    if (req.method === 'GET' && url.pathname === '/api/interview-session') {
      const candidateId = url.searchParams.get('candidateId') || null;
      const jobId = url.searchParams.get('jobId') || null;
      const sessions = interviewAdapters.listSessionTimeline({ candidateId, jobId });
      auditSensitiveRead('interview_session_read', `${candidateId || 'all'}:${jobId || 'all'}`);
      return send(res, 200, {
        ok: true,
        sessions,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/interview-assignment') {
      const jobId = url.searchParams.get('jobId') || null;
      const status = url.searchParams.get('status') || null;
      const assignments = interviewAdapters.listPendingMaterials({ jobId, status });
      auditSensitiveRead('interview_assignment_read', `${jobId || 'all'}:${status || 'all'}`);
      return send(res, 200, {
        ok: true,
        assignments,
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/interview-assignment/audit') {
      const pendingAssignmentId = Number(url.searchParams.get('pendingAssignmentId'));
      if (!pendingAssignmentId) return send(res, 400, { ok: false, error: 'pendingAssignmentId required' });
      const audits = interviewAdapters.listPendingMaterialAudits(pendingAssignmentId);
      auditSensitiveRead('interview_assignment_audit_read', pendingAssignmentId);
      return send(res, 200, {
        ok: true,
        audits,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-assignment/classify') {
      const body = await readBody(req);
      try {
        const assignment = interviewAdapters.classifyPendingMaterial({ ...body, actor: principal.actor_id });
        return send(res, 200, { ok: true, assignment });
      } catch (err) {
        return send(res, Number(err && err.statusCode) || (/stale/.test(err.message) ? 409 : 400), {
          ok: false,
          code: err && err.code,
          error: err.message,
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-assignment/assign') {
      const body = await readBody(req);
      try {
        const assigned = interviewAdapters.assignPendingMaterial({ ...body, actor: principal.actor_id });
        return send(res, 200, { ok: true, ...assigned });
      } catch (err) {
        return send(res, Number(err && err.statusCode) || (/stale/.test(err.message) ? 409 : 400), {
          ok: false,
          code: err && err.code,
          error: err.message,
        });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/local-interview/doctor') {
      const result = spawnSync(process.execPath, [path.join(PROJECT_ROOT, "src/local-interview-p0.js"), '--doctor'], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        env: process.env,
        timeout: 12_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      });
      let doctor = null;
      try { doctor = result.stdout ? JSON.parse(result.stdout) : null; } catch {}
      const diagnosticCompleted = !!doctor && typeof doctor === 'object';
      return send(res, diagnosticCompleted ? 200 : 500, {
        ok: diagnosticCompleted,
        doctor,
        error: diagnosticCompleted
          ? null
          : (result.error?.code === 'ETIMEDOUT'
            ? 'local interview doctor timed out'
            : (result.stderr || result.stdout || 'local interview doctor failed').trim()),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/interview-consent') {
      const candidateId = String(url.searchParams.get('candidateId') || '').trim();
      const jobId = Number(url.searchParams.get('jobId'));
      if (!candidateId || !jobId) return send(res, 400, { ok: false, error: 'candidateId and jobId required' });
      const consent = db.getInterviewConsent({ candidateId, jobId });
      const policy = db.getInterviewConsentPolicy();
      auditSensitiveRead('interview_consent_read', `${candidateId}:${jobId}`);
      return send(res, 200, {
        ok: true,
        consent,
        policy,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-consent') {
      const body = await readBody(req);
      const candidateId = typeof body.candidateId === 'string' ? body.candidateId.trim() : '';
      const jobId = Number(body.jobId);
      if (!candidateId || !jobId) return send(res, 400, { ok: false, error: 'candidateId and jobId required' });
      if (body.confirmed !== true) {
        const requestId = String(body.requestId || body.request_id || '').trim();
        if (!requestId) {
          return send(res, 400, {
            ok: false,
            code: 'INTERVIEW_CONSENT_REQUEST_ID_REQUIRED',
            error: '撤回录音授权必须提供 requestId。',
          });
        }
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(requestId)) {
          return send(res, 400, {
            ok: false,
            code: 'INTERVIEW_CONSENT_REQUEST_ID_INVALID',
            error: 'requestId 格式无效。',
          });
        }
        db.validateInterviewConsentRevocationRequest({
          candidateId,
          jobId,
          recordedBy: principal.actor_id,
          source: 'candidate_interview_ui',
          requestId,
        });
        const result = revokeInterviewConsentAndStop({
          candidateId,
          jobId,
          recordedBy: principal.actor_id,
          source: 'candidate_interview_ui',
          requestId,
        });
        const response = interviewConsentRevocationHttpResult({
          ...result,
          policy: db.getInterviewConsentPolicy(),
        });
        return send(res, response.status, response.body);
      }
      try {
        const consent = db.recordInterviewConsent({
          candidateId,
          jobId,
          confirmed: true,
          recordedBy: principal.actor_id,
          source: 'candidate_interview_ui',
        });
        const stopResponse = interviewConsentStopHttpResult({
          confirmed: true,
          consent,
          policy: db.getInterviewConsentPolicy(),
          stopResult: { matched: false, stopped: false },
        });
        return send(res, stopResponse.status, stopResponse.body);
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/local-interview/record/start') {
      const unavailable = localInterviewCapability(process.platform);
      if (unavailable) return send(res, 501, { ok: false, code: unavailable.reason, error: unavailable.message });
      const body = await readBody(req);
      const duration = body.duration == null || body.duration === '' ? null : Number(body.duration);
      if (duration != null && (!Number.isInteger(duration) || duration < 5 || duration > 4 * 60 * 60)) {
        return send(res, 400, { ok: false, error: 'duration 必须是 5 秒到 4 小时之间的整数。' });
      }
      const bindCandidateId = typeof body.candidateId === 'string' ? body.candidateId.trim() : '';
      const bindJobId = body.jobId == null || body.jobId === '' ? null : Number(body.jobId);
      if (body.jobId != null && body.jobId !== '' && !bindJobId) {
        return send(res, 400, { ok: false, error: 'jobId 必须是有效数字。' });
      }
      if (!bindCandidateId || !bindJobId) {
        return send(res, 400, { ok: false, error: '正式录音必须从候选人面试工作台启动，并绑定 candidateId/jobId。' });
      }
      try {
        db.assertJobRecruitingWritableById(bindJobId);
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
      const bindRound = Number(body.round);
      if (!Number.isInteger(bindRound) || bindRound <= 0) {
        return send(res, 400, { ok: false, error: '正式录音必须显式提供正整数 round。' });
      }
      try {
        db.assertInterviewRoundRecordingWritable({
          candidateId: bindCandidateId,
          jobId: bindJobId,
          round: bindRound,
        });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
      let consent;
      try {
        consent = db.requireActiveInterviewConsent({ candidateId: bindCandidateId, jobId: bindJobId });
      } catch (err) {
        if (err && err.code === 'INTERVIEW_CONSENT_REVOCATION_PENDING') {
          return sendInterviewReportError(res, err);
        }
        return send(res, 403, { ok: false, code: 'interview_consent_required', error: err.message });
      }
      const initialResult = runLocalInterviewJob({
        mode: 'record',
        topic: typeof body.topic === 'string' ? body.topic.trim() : 'HRBOSS-P0-local',
        duration,
        bindCandidateId,
        bindJobId,
        bindRound,
        bindConsentId: consent.id,
      });
      const result = await resolveLocalInterviewStartup(initialResult);
      if (result.ok) {
        db.writeAuditLog({
          action: '本地面试录音启动',
          target: bindCandidateId,
          who: principal.actor_id,
          auto: 0,
          result: '成功',
          detail_json: JSON.stringify({ job_id: bindJobId, consent_id: consent.id, local_job_id: result.job.id }),
        });
      }
      return send(res, result.status, result.ok
        ? { ok: true, job: result.job }
        : { ok: false, code: result.code, error: result.error, job: result.job });
    }

    if (req.method === 'POST' && url.pathname === '/api/local-interview/mic-check') {
      const unavailable = localInterviewCapability(process.platform);
      if (unavailable) return send(res, 501, { ok: false, code: unavailable.reason, error: unavailable.message });
      const body = await readBody(req);
      if (body.micCheckConsentConfirmed !== true) {
        return send(res, 403, {
          ok: false,
          code: 'mic_check_consent_required',
          error: '麦克风预检前必须明确确认在场说话人已知情，且临时材料仅在本机处理并于测试后删除。',
        });
      }
      const duration = body.duration == null || body.duration === '' ? 8 : Number(body.duration);
      if (!Number.isInteger(duration) || duration < 3 || duration > 20) {
        return send(res, 400, { ok: false, error: '麦克风预检 duration 必须是 3 到 20 秒之间的整数。' });
      }
      const bindCandidateId = typeof body.candidateId === 'string' ? body.candidateId.trim() : '';
      const clientRequestId = typeof body.clientRequestId === 'string' ? body.clientRequestId.trim() : '';
      if (clientRequestId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(clientRequestId)) {
        return send(res, 400, {
          ok: false,
          code: 'LOCAL_INTERVIEW_CLIENT_REQUEST_ID_INVALID',
          error: 'clientRequestId 格式无效。',
        });
      }
      const bindJobId = body.jobId == null || body.jobId === '' ? null : Number(body.jobId);
      if (body.jobId != null && body.jobId !== '' && !bindJobId) {
        return send(res, 400, { ok: false, error: 'jobId 必须是有效数字。' });
      }
      if (!!bindCandidateId !== !!bindJobId) {
        return send(res, 400, { ok: false, error: '候选人麦克风预检必须同时提供 candidateId 和 jobId。' });
      }
      const candidateRound = bindCandidateId ? Number(body.round) : null;
      if (bindCandidateId && (!Number.isInteger(candidateRound) || candidateRound <= 0)) {
        return send(res, 400, {
          ok: false,
          code: 'interview_round_required',
          error: '候选人麦克风预检必须绑定当前面试的正整数 round。',
        });
      }
      let candidateConsent = null;
      if (bindCandidateId && bindJobId) {
        try {
          db.assertInterviewRoundRecordingWritable({
            candidateId: bindCandidateId,
            jobId: bindJobId,
            round: candidateRound,
          });
        } catch (err) {
          return sendInterviewReportError(res, err);
        }
        try {
          candidateConsent = db.requireActiveInterviewConsent({ candidateId: bindCandidateId, jobId: bindJobId });
        } catch (err) {
          if (err && err.code === 'INTERVIEW_CONSENT_REVOCATION_PENDING') {
            return sendInterviewReportError(res, err);
          }
          return send(res, 403, { ok: false, code: 'interview_consent_required', error: err.message });
        }
      }
      const initialResult = runLocalInterviewJob({
        mode: 'mic-check',
        // Mic-check paths and temporary payload metadata must not carry a
        // candidate name supplied by the renderer.
        topic: 'HRBOSS-mic-check',
        duration,
        bindCandidateId,
        bindJobId,
        bindRound: candidateRound,
        bindConsentId: candidateConsent?.id || null,
        micCheckConsentConfirmed: true,
        clientRequestId,
      });
      const result = await resolveLocalInterviewStartup(initialResult);
      return send(res, result.status, result.ok
        ? { ok: true, job: result.job }
        : { ok: false, code: result.code, error: result.error, job: result.job });
    }

    if (req.method === 'POST' && url.pathname === '/api/local-interview/transcription/retry') {
      const unavailable = localInterviewCapability(process.platform);
      if (unavailable) return send(res, 501, { ok: false, code: unavailable.reason, error: unavailable.message });
      const body = await readBody(req);
      const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
      const candidateId = typeof body.candidateId === 'string' ? body.candidateId.trim() : '';
      const jobId = Number(body.jobId);
      const round = Number(body.round);
      if (!taskId || !candidateId || !Number.isInteger(jobId) || jobId <= 0
          || !Number.isInteger(round) || round <= 0) {
        return send(res, 400, {
          ok: false,
          code: 'LOCAL_INTERVIEW_RETRY_SCOPE_REQUIRED',
          error: '重试转写必须提供原 taskId、candidateId、jobId 和 round。',
        });
      }
      if (!localInterviewJob || localInterviewJob.recoveredPersistentBlocker) {
        refreshPersistedLocalInterviewBlocker();
      }
      if (!localInterviewJob
          || localInterviewJob.transcriptionRetryable !== true
          || !localInterviewTaskScopeMatches(localInterviewJob, {
            taskId,
            candidateId,
            jobId,
            round,
          })) {
        return send(res, 409, {
          ok: false,
          code: 'LOCAL_INTERVIEW_TRANSCRIPTION_NOT_RETRYABLE',
          error: '这条保留录音已变化、已丢弃或不属于当前候选人/岗位/轮次。',
          job: compactLocalInterviewJob(localInterviewJob),
        });
      }
      const initialResult = runLocalInterviewJob({
        mode: 'retry-transcription',
        topic: localInterviewJob.topic,
        retryJob: localInterviewJob,
      });
      const result = await resolveLocalInterviewStartup(initialResult);
      if (result.ok) {
        db.writeAuditLog({
          action: '本地面试转写人工重试',
          target: candidateId,
          who: principal.actor_id,
          auto: 0,
          result: '成功',
          detail_json: JSON.stringify({
            local_job_id: taskId,
            job_id: jobId,
            round,
            consent_id: localInterviewJob.bindConsentId,
          }),
        });
      }
      return send(res, result.status, result.ok
        ? { ok: true, job: result.job }
        : { ok: false, code: result.code, error: result.error, job: result.job });
    }

    if (req.method === 'POST' && url.pathname === '/api/local-interview/abort') {
      const body = await readBody(req);
      const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
      const expectedJobId = body.jobId == null || body.jobId === '' ? null : Number(body.jobId);
      if (!taskId) {
        return send(res, 400, { ok: false, code: 'LOCAL_INTERVIEW_TASK_ID_REQUIRED', error: 'taskId required' });
      }
      if (expectedJobId !== null && (!Number.isInteger(expectedJobId) || expectedJobId <= 0)) {
        return send(res, 400, { ok: false, code: 'LOCAL_INTERVIEW_JOB_ID_INVALID', error: 'jobId 必须是正整数。' });
      }
      const discardingPreservedRecording = localInterviewJob?.transcriptionRetryable === true;
      const result = requestLocalInterviewStop({
        abort: true,
        reason: discardingPreservedRecording
          ? 'HR 已明确丢弃转写失败后保留的原录音。'
          : '用户已请求取消本地面试任务；正在等待进程安全停止并清理未完成材料。',
        taskId,
        jobId: expectedJobId,
      });
      if (discardingPreservedRecording && result.matched && result.stopped) {
        db.writeAuditLog({
          action: '本地面试转写失败录音丢弃',
          target: String(localInterviewJob?.bindCandidateId || taskId),
          who: principal.actor_id,
          auto: 0,
          result: '成功',
          detail_json: JSON.stringify({ local_job_id: taskId, job_id: expectedJobId }),
        });
      }
      const response = localInterviewAbortHttpResult(result);
      return send(res, response.status, response.body);
    }

    if (req.method === 'POST' && url.pathname === '/api/local-interview/record/stop') {
      const body = await readBody(req);
      const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
      const expectedCandidateId = typeof body.candidateId === 'string' ? body.candidateId.trim() : '';
      const expectedJobId = body.jobId == null || body.jobId === '' ? null : Number(body.jobId);
      const expectedRound = body.round == null || body.round === '' ? null : Number(body.round);
      if (!taskId) {
        return send(res, 400, { ok: false, code: 'LOCAL_INTERVIEW_TASK_ID_REQUIRED', error: 'taskId required' });
      }
      if (expectedJobId !== null && (!Number.isInteger(expectedJobId) || expectedJobId <= 0)) {
        return send(res, 400, { ok: false, code: 'LOCAL_INTERVIEW_JOB_ID_INVALID', error: 'jobId 必须是正整数。' });
      }
      if (expectedRound !== null && (!Number.isInteger(expectedRound) || expectedRound <= 0)) {
        return send(res, 400, { ok: false, code: 'INTERVIEW_ROUND_INVALID', error: 'round 必须是正整数。' });
      }
      if (!localInterviewStopMatches(localInterviewJob, {
        taskId,
        candidateId: expectedCandidateId,
        jobId: expectedJobId,
        round: expectedRound,
      })) {
        return send(res, 409, {
          ok: false,
          code: 'LOCAL_INTERVIEW_TASK_CHANGED',
          error: '录音任务已结束或已被其他任务替换；未向当前任务发送停止信号，请刷新状态。',
          job: compactLocalInterviewJob(localInterviewJob),
        });
      }
      let discardInsteadOfTranscribe = false;
      let discardReason = '';
      if (localInterviewJob.bindCandidateId && localInterviewJob.bindJobId && localInterviewJob.bindRound) {
        try {
          db.assertInterviewRoundRecordingWritable({
            candidateId: localInterviewJob.bindCandidateId,
            jobId: localInterviewJob.bindJobId,
            round: localInterviewJob.bindRound,
          });
        } catch (error) {
          discardInsteadOfTranscribe = true;
          discardReason = error && error.code === 'JOB_CLOSED'
            ? '岗位已关闭'
            : '当前面试轮次已关闭、撤回或状态不可写';
        }
      } else if (localInterviewJob.bindJobId) {
        try {
          db.assertJobRecruitingWritableById(localInterviewJob.bindJobId);
        } catch {
          discardInsteadOfTranscribe = true;
          discardReason = '岗位状态不可写';
        }
      }
      if (discardInsteadOfTranscribe) {
        const result = requestLocalInterviewStop({
          abort: true,
          reason: `${discardReason}；正在停止录音并清理未完成材料，不会生成转写或归档。`,
          taskId,
          candidateId: expectedCandidateId,
          jobId: expectedJobId,
          round: expectedRound,
        });
        const response = localInterviewAbortHttpResult(result);
        return send(res, response.status, {
          ...response.body,
          discarded: response.body.ok === true,
        });
      }
      if (localInterviewJob.stopRequested) {
        localInterviewJob.message = '已收到停止请求，正在转写，请不要重复点击。';
        return send(res, 202, {
          ok: true,
          recording_stopped: false,
          recording_stop_requested: true,
          job: compactLocalInterviewJob(localInterviewJob),
        });
      }
      const result = requestLocalInterviewStop({
        taskId,
        candidateId: expectedCandidateId,
        jobId: expectedJobId,
        round: expectedRound,
      });
      const response = localInterviewManualStopHttpResult(result);
      return send(res, response.status, response.body);
    }

    if (req.method === 'POST' && url.pathname === '/api/local-interview/from-file') {
      const unavailable = localInterviewCapability(process.platform);
      if (unavailable) return send(res, 501, { ok: false, code: unavailable.reason, error: unavailable.message });
      const body = await readBody(req);
      if (body.materialConsentConfirmed !== true) {
        return send(res, 403, { ok: false, code: 'material_consent_required', error: '导入音视频前必须显式确认材料已取得相关人员授权。' });
      }
      const sourcePath = typeof body.filePath === 'string' ? body.filePath.trim() : '';
      if (!sourcePath) return send(res, 400, { ok: false, error: 'filePath required' });
      let resolved;
      try {
        resolved = validateImportedMediaSource(sourcePath).path;
      } catch (error) {
        return send(res, 400, { ok: false, error: error.message });
      }
      const bindCandidateId = typeof body.candidateId === 'string' ? body.candidateId.trim() : '';
      const bindJobId = body.jobId == null || body.jobId === '' ? null : Number(body.jobId);
      const bindRound = body.round == null || body.round === '' ? null : Number(body.round);
      if (body.jobId != null && body.jobId !== '' && !bindJobId) {
        return send(res, 400, { ok: false, error: 'jobId 必须是有效数字。' });
      }
      const hasAnyBinding = !!bindCandidateId || bindJobId !== null || bindRound !== null;
      const hasCompleteBinding = !!bindCandidateId
        && Number.isInteger(bindJobId) && bindJobId > 0
        && Number.isInteger(bindRound) && bindRound > 0;
      if (hasAnyBinding && !hasCompleteBinding) {
        return send(res, 400, {
          ok: false,
          code: 'INTERVIEW_BINDING_CONTEXT_INCOMPLETE',
          error: '绑定候选人的音视频导入必须同时提供 candidateId、jobId 和正整数 round。',
        });
      }
      if (hasCompleteBinding) {
        try {
          db.assertInterviewRoundRecordingWritable({
            candidateId: bindCandidateId,
            jobId: bindJobId,
            round: bindRound,
          });
        } catch (error) {
          return sendInterviewReportError(res, error);
        }
      }
      const initialResult = runLocalInterviewJob({
        mode: 'from-file',
        topic: typeof body.topic === 'string' ? body.topic.trim() : path.basename(resolved, path.extname(resolved)),
        sourcePath: resolved,
        bindCandidateId,
        bindJobId,
        bindRound,
      });
      const result = await resolveLocalInterviewStartup(initialResult);
      if (result.ok) {
        db.writeAuditLog({
          action: '本地面试材料导入启动',
          target: typeof body.candidateId === 'string' && body.candidateId.trim() ? body.candidateId.trim() : path.basename(resolved),
          who: principal.actor_id,
          auto: 0,
          result: '成功',
          detail_json: JSON.stringify({ job_id: bindJobId, source_file: path.basename(resolved), material_consent_confirmed: true }),
        });
      }
      return send(res, result.status, result.ok
        ? { ok: true, job: result.job }
        : { ok: false, code: result.code, error: result.error, job: result.job });
    }

    if (req.method === 'GET' && url.pathname === '/api/local-interview/progress') {
      if (!localInterviewJob || localInterviewJob.recoveredPersistentBlocker) {
        refreshPersistedLocalInterviewBlocker();
      }
      if (localInterviewJob
          && localInterviewJob.abortRequested
          && !localInterviewJob.finalized
          && typeof localInterviewJob.reconcileAbortedJob === 'function') {
        localInterviewJob.reconcileAbortedJob();
      }
      return send(res, 200, { ok: true, job: compactLocalInterviewJob(localInterviewJob) });
    }

    if (req.method === 'GET' && url.pathname === '/api/interview-recording') {
      const candidateId = url.searchParams.get('candidateId') || null;
      const jobId = url.searchParams.get('jobId') || null;
      const unmatched = url.searchParams.get('unmatched') === '1';
      const recordings = db.listInterviewRecordings({ candidateId, jobId, unmatched });
      auditSensitiveRead('interview_recording_list_read', `${candidateId || 'all'}:${jobId || 'all'}:${unmatched ? 'unmatched' : 'matched'}`);
      return send(res, 200, {
        ok: true,
        recordings,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-recording/import-summary') {
      const body = await readBody(req);
      const summaryPath = typeof body.summaryPath === 'string' ? body.summaryPath.trim() : '';
      if (!summaryPath) return send(res, 400, { ok: false, error: 'summaryPath required' });
      try {
        const { resolved, summary } = readLocalInterviewSummary(summaryPath);
        if (summary.mode === 'mic-check') {
          throw new Error('麦克风预检 summary.json 不能导入为候选人面试记录。请导入正式录音或本地音视频转写产物。');
        }
        const adapted = adaptRecordingFromLocalSummary(resolved, summary);
        return send(res, 200, {
          ok: true,
          recording: adapted.recording,
          assignment: adapted.adapted.assignment,
          session: adapted.adapted.session,
          idempotent_replay: adapted.adapted.idempotent_replay,
        });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-recording/bind') {
      const body = await readBody(req);
      if (!Number(body.id)) return send(res, 400, { ok: false, error: 'id required' });
      try {
        const recording = db.bindInterviewRecording({
          id: body.id,
          candidateId: typeof body.candidateId === 'string' ? body.candidateId.trim() : body.candidateId,
          jobId: body.jobId,
        });
        return send(res, 200, { ok: true, recording });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-recording/report') {
      const body = await readBody(req);
      const recordingId = Number(body.recordingId);
      if (!recordingId) return send(res, 400, { ok: false, error: 'recordingId required' });
      try {
        const report = db.saveInterviewReportForRecording({
          recordingId,
          report: body.report,
          actor: principal.actor_id,
          expectedVersion: body.expectedVersion,
          requestId: body.requestId,
        });
        return send(res, 200, { ok: true, report });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/interview-recording/report') {
      const recordingId = Number(url.searchParams.get('recordingId'));
      if (!recordingId) return send(res, 400, { ok: false, error: 'recordingId required' });
      try {
        const report = db.getInterviewReportForRecording(recordingId) || null;
        auditSensitiveRead('interview_recording_report_read', recordingId);
        return send(res, 200, { ok: true, report });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/llm/config') {
      const startupFault = externalAiStartupConfigFaultResponse();
      if (startupFault) return send(res, startupFault.status, startupFault.body);
      return send(res, 200, { ok: true, config: f009Runtime.publicConfig() });
    }

    if (req.method === 'POST' && url.pathname === '/api/llm/config') {
      const startupFault = externalAiStartupConfigFaultResponse();
      if (startupFault) return send(res, startupFault.status, startupFault.body);
      const body = await readBody(req);
      try {
        const config = f009Runtime.configure({
          ...(Object.hasOwn(body, 'provider') ? { provider: body.provider } : {}),
          ...(Object.hasOwn(body, 'enabled') ? { enabled: body.enabled } : {}),
          ...(Object.hasOwn(body, 'apiKey') ? { apiKey: body.apiKey } : {}),
          ...(body.clearApiKey === true ? { clearApiKey: true } : {}),
          ...(Object.hasOwn(body, 'model') ? { model: body.model } : {}),
          ...(Object.hasOwn(body, 'timeoutMs') ? { timeoutMs: body.timeoutMs } : {}),
          ...(Object.hasOwn(body, 'baseUrl') ? { baseUrl: body.baseUrl } : {}),
        });
        return send(res, 200, { ok: true, config });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/llm/models/refresh') {
      const startupFault = externalAiStartupConfigFaultResponse();
      if (startupFault) return send(res, startupFault.status, startupFault.body);
      await readBody(req);
      try {
        const models = await f009Runtime.refreshModels();
        return send(res, 200, { ok: true, models, config: f009Runtime.publicConfig() });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/llm/models/test') {
      const startupFault = externalAiStartupConfigFaultResponse();
      if (startupFault) return send(res, startupFault.status, startupFault.body);
      const body = await readBody(req);
      try {
        const result = await f009Runtime.testModel({ model: body.model });
        return send(res, 200, { ok: true, ...result });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-report/llm/preview') {
      const body = await readBody(req);
      try {
        const selected = db.getF009InterviewMaterials({ sessionId: body.sessionId, materialIds: body.materialIds });
        const preview = f009Runtime.buildPreview({
          requestId: body.requestId,
          sessionId: selected.sessionId,
          materials: selected.materials,
          context: selected.context,
        });
        db.createF009LlmPreviewAudit({
          requestId: preview.requestId,
          sessionId: preview.sessionId,
          materialIds: preview.materialIds,
          requestHash: preview.requestHash,
          provider: preview.provider,
          baseUrl: preview.baseUrl,
          model: preview.model,
          promptVersion: preview.promptVersion,
          promptHash: preview.promptHash,
          modelCatalogHash: preview.modelCatalogHash,
          sourceVersionHash: preview.sourceVersionHash,
          actor: principal.actor_id,
        });
        return send(res, 200, {
          ok: true,
          preview: {
            ...preview,
            notice: '仅发送所选转写证据单元；手机号、邮箱、身份证和微信式标识已等长掩码。姓名、地点等残余信息仍需 HR 在发送前人工检查。',
          },
        });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-report/llm/analyze') {
      const body = await readBody(req);
      let claimed = false;
      let responseMeta = null;
      const startedAt = Date.now();
      try {
        const selected = db.getF009InterviewMaterials({ sessionId: body.sessionId, materialIds: body.materialIds });
        const preview = f009Runtime.buildPreview({
          requestId: body.requestId,
          sessionId: selected.sessionId,
          materials: selected.materials,
          context: selected.context,
        });
        if (preview.requestHash !== String(body.requestHash || '')) {
          const error = new Error('发送内容与人工确认的预览不一致，请重新预览。');
          error.code = 'PREVIEW_HASH_MISMATCH';
          error.statusCode = 409;
          throw error;
        }
        const actor = principal.actor_id;
        const previewAudit = db.getF009LlmAudit(preview.requestId);
        if (!actor || !previewAudit || previewAudit.actor !== actor) {
          const error = new Error('本次发送操作者与人工预览记录不一致。');
          error.code = 'PREVIEW_ACTOR_MISMATCH';
          error.statusCode = 409;
          throw error;
        }
        const binding = {
          actor,
          provider: preview.provider,
          base_url: preview.baseUrl,
          model: preview.model,
          prompt_version: preview.promptVersion,
          prompt_hash: preview.promptHash,
          schema_version: preview.schemaVersion,
          model_catalog_hash: preview.modelCatalogHash,
          source_version_hash: preview.sourceVersionHash,
          session_id: preview.sessionId,
          material_ids: preview.materialIds,
          request_hash: preview.requestHash,
          request_id: preview.requestId,
        };
        try {
          consumeF009UserApproval(
            f009ApprovalSecret,
            body.userApproval,
            binding,
            consumedF009ApprovalNonces,
          );
        } catch (approvalError) {
          approvalError.code = 'EXTERNAL_AI_CONFIRMATION_REQUIRED';
          approvalError.statusCode = 403;
          throw approvalError;
        }
        db.claimF009LlmRequest({
          requestId: preview.requestId,
          requestHash: preview.requestHash,
          actor,
          sessionId: preview.sessionId,
          materialIds: preview.materialIds,
          model: preview.model,
          promptVersion: preview.promptVersion,
          promptHash: preview.promptHash,
          schemaVersion: preview.schemaVersion,
          modelCatalogHash: preview.modelCatalogHash,
          sourceVersionHash: preview.sourceVersionHash,
        });
        claimed = true;
        const authorization = issueExternalAiAuthorization({
          purpose: 'interview-report',
          confirmed: true,
          requestedBy: actor,
          binding,
          expiresInMs: 10 * 60 * 1000,
        });
        responseMeta = await f009Runtime.analyze(preview, authorization, actor);
        // active job 保留到 draft + audit 原子事务完成；取消成功后晚响应不得写库。
        f009Runtime.assertNotCancelled(preview.requestId);
        const saved = db.saveF009DraftAndFinishAudit({
          requestId: preview.requestId,
          sessionId: preview.sessionId,
          report: responseMeta.report,
          actor,
          expectedVersion: body.expectedVersion,
          saveRequestId: `f009-save-${f009Sha256(preview.requestId)}`,
          responseHash: responseMeta.responseHash,
          returnedModel: responseMeta.returnedModel,
          durationMs: responseMeta.durationMs,
          inputTokens: responseMeta.usage.inputTokens,
          outputTokens: responseMeta.usage.outputTokens,
        });
        f009Runtime.release(preview.requestId);
        return send(res, 200, { ok: true, report: saved.report, audit: saved.audit });
      } catch (err) {
        const safeMeta = responseMeta || (err && err.f009Meta) || null;
        if (claimed) {
          const code = String((err && err.code) || 'LLM_REQUEST_FAILED');
          const status = code === 'REQUEST_CANCELLED'
            ? 'cancelled'
            : code === 'REQUEST_TIMEOUT'
              ? 'timeout'
              : (safeMeta && safeMeta.responseHash)
                ? 'invalid_response'
                : 'failed';
          try {
            db.finishF009LlmRequest({
              requestId: body.requestId,
              status,
              responseHash: safeMeta && safeMeta.responseHash,
              returnedModel: safeMeta && safeMeta.returnedModel,
              durationMs: safeMeta ? safeMeta.durationMs : Date.now() - startedAt,
              inputTokens: safeMeta && safeMeta.usage && safeMeta.usage.inputTokens,
              outputTokens: safeMeta && safeMeta.usage && safeMeta.usage.outputTokens,
              errorCode: code,
            });
          } catch {}
        }
        f009Runtime.release(body.requestId);
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-report/llm/cancel') {
      const body = await readBody(req);
      db.assertF009LlmActor(body.requestId, principal.actor_id);
      const cancelled = f009Runtime.cancel(body.requestId);
      const audit = db.getF009LlmAudit(body.requestId);
      return send(res, 200, {
        ok: true,
        cancelled,
        status: cancelled ? 'cancelling' : (audit ? audit.status : 'not_found'),
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/interview-report') {
      const sessionId = Number(url.searchParams.get('sessionId'));
      if (!sessionId) return send(res, 400, { ok: false, code: 'SESSION_REQUIRED', path: '$.session_id', error: 'sessionId required' });
      try {
        const report = db.getInterviewReportV1({ sessionId });
        const facts = db.listInterviewReportFactReviews({ sessionId });
        auditSensitiveRead('interview_report_read', sessionId);
        return send(res, 200, {
          ok: true,
          report,
          facts,
        });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-report') {
      const body = await readBody(req);
      try {
        const report = db.saveInterviewReportV1({
          sessionId: body.sessionId,
          report: body.report,
          actor: principal.actor_id,
          expectedVersion: body.expectedVersion,
          requestId: body.requestId,
          sourceMaterialIds: body.sourceMaterialIds,
        });
        return send(res, 200, { ok: true, report });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-report/manual') {
      const body = await readBody(req);
      try {
        const report = db.saveStructuredManualInterviewReport({
          ...body.form,
          sessionId: body.sessionId,
          materialIds: body.materialIds,
          actor: principal.actor_id,
          expectedVersion: body.expectedVersion,
          requestId: body.requestId,
        });
        return send(res, 200, { ok: true, report });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-report/facts') {
      const body = await readBody(req);
      try {
        const result = db.reviewInterviewReportFacts({
          sessionId: body.sessionId,
          items: body.items,
          actor: principal.actor_id,
          expectedVersion: body.expectedVersion,
          requestId: body.requestId,
        });
        return send(res, 200, { ok: true, ...result });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-report/confirm') {
      const body = await readBody(req);
      try {
        const report = db.confirmInterviewReportV1({
          sessionId: body.sessionId,
          confirmed: body.confirmed,
          actor: principal.actor_id,
          expectedVersion: body.expectedVersion,
          requestId: body.requestId,
        });
        return send(res, 200, { ok: true, report });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-report/reject') {
      const body = await readBody(req);
      try {
        const report = db.rejectInterviewReportV1({
          sessionId: body.sessionId,
          rejected: body.rejected,
          actor: principal.actor_id,
          expectedVersion: body.expectedVersion,
          requestId: body.requestId,
        });
        return send(res, 200, { ok: true, report });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/interview-recording/transcript') {
      const recordingId = Number(url.searchParams.get('recordingId'));
      if (!recordingId) return send(res, 400, { ok: false, error: 'recordingId required' });
      try {
        const recording = db.getInterviewRecording(recordingId, { access: 'transcript' });
        const transcript = safeTranscriptPayload(recording);
        auditSensitiveRead('interview_transcript_read', recordingId);
        return send(res, 200, { ok: true, transcript });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/interview-recording/confirmations') {
      const recordingId = Number(url.searchParams.get('recordingId'));
      if (!recordingId) return send(res, 400, { ok: false, error: 'recordingId required' });
      try {
        const report = db.getInterviewReportForRecording(recordingId);
        if (report && report.schema_version === 'interview_report_v1') {
          const confirmations = db.listInterviewReportFactReviewsForRecording(recordingId);
          auditSensitiveRead('interview_confirmations_read', recordingId);
          return send(res, 200, {
            ok: true,
            confirmation_source: 'interview_report_v1',
            confirmations,
          });
        }
        const confirmations = db.listInterviewRecordingConfirmations(recordingId);
        auditSensitiveRead('interview_confirmations_read', recordingId);
        return send(res, 200, {
          ok: true,
          confirmations,
        });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-recording/confirmations') {
      const body = await readBody(req);
      const recordingId = Number(body.recordingId === undefined ? body.recording_id : body.recordingId);
      const items = Array.isArray(body.items) ? body.items : (body.item ? [body.item] : [body]);
      if (!recordingId && !items.some((item) => Number(item && (item.recordingId === undefined ? item.recording_id : item.recordingId)))) {
        return send(res, 400, { ok: false, error: 'recordingId required' });
      }
      try {
        const report = db.getInterviewReportForRecording(recordingId);
        if (report && report.schema_version === 'interview_report_v1') {
          const known = new Set(db.listInterviewReportFactReviewsForRecording(recordingId).map((item) => item.field_key));
          const reviewedItems = items
            .filter((item) => item && known.has(item.field_key || item.fieldKey || item.id))
            .filter((item) => item.status && item.status !== 'pending' && item.status !== 'pending_review');
          if (!reviewedItems.length) {
            return send(res, 200, {
              ok: true,
              saved: 0,
              confirmation_source: 'interview_report_v1',
              confirmations: db.listInterviewReportFactReviewsForRecording(recordingId),
            });
          }
          const result = db.reviewInterviewReportFactsForRecording({
            recordingId,
            items: reviewedItems,
            actor: principal.actor_id,
            expectedVersion: body.expectedVersion,
            requestId: body.requestId,
          });
          return send(res, 200, {
            ok: true,
            saved: reviewedItems.length,
            confirmation_source: 'interview_report_v1',
            confirmations: result.facts,
            report: result.report,
          });
        }
        const confirmations = db.saveInterviewRecordingConfirmations({ recordingId, items });
        return send(res, 200, {
          ok: true,
          saved: confirmations.length,
          confirmation: confirmations.length === 1 ? confirmations[0] : null,
          confirmations,
        });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-recording/confirm') {
      const body = await readBody(req);
      if (!Number(body.id)) return send(res, 400, { ok: false, error: 'id required' });
      try {
        const report = db.confirmInterviewReportForRecording({
          id: body.id,
          confirmed: body.confirmed,
          actor: principal.actor_id,
          expectedVersion: body.expectedVersion,
          requestId: body.requestId,
        });
        const recording = db.getInterviewRecording(body.id);
        return send(res, 200, { ok: true, recording, report });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-recording/report/reject') {
      const body = await readBody(req);
      if (!Number(body.id)) return send(res, 400, { ok: false, error: 'id required' });
      try {
        const report = db.rejectInterviewReportForRecording({
          id: body.id,
          rejected: body.rejected,
          actor: principal.actor_id,
          expectedVersion: body.expectedVersion,
          requestId: body.requestId,
        });
        return send(res, 200, { ok: true, report });
      } catch (err) {
        return sendInterviewReportError(res, err);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/interview-script') {
      const jobId = Number(url.searchParams.get('jobId'));
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
      try {
        const script = db.getInterviewScript(jobId);
        if (script && script.stale_for_active_jd === true) {
          return send(res, 409, {
            ok: false,
            code: 'INTERVIEW_SCRIPT_STALE_FOR_ACTIVE_JD',
            error: '已有面试脚本不属于当前 JD/画像，请基于当前已确认画像重新生成。',
          });
        }
        return send(res, 200, { ok: true, script });
      } catch (err) {
        return send(res, Number(err && err.statusCode) || 400, { ok: false, code: err && err.code, error: err.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-script/generate') {
      const body = await readBody(req);
      const jobId = Number(body.jobId);
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
      try {
        db.assertJobRecruitingWritableById(jobId);
        const job = db.getJobForFetch(jobId);
        if (!job) return send(res, 404, { ok: false, error: '岗位不存在。' });
        const profileContext = db.getCurrentJobProfileContext(jobId);
        const profile = profileContext.config;
        const script = buildInterviewScript({ job, profile });
        script.source_jd_version_id = Number(profileContext.activeJd.id);
        script.source_profile_version_id = Number(profileContext.profileVersion.id);
        script.source_profile_content_hash = profileContext.profileVersion.content_hash;
        script.script_text = scriptMarkdown(script);
        const saved = db.saveInterviewScript({
          jobId,
          source: 'local_rule_from_jd_profile',
          status: 'draft',
          script_json: JSON.stringify(script, null, 2),
          script_text: script.script_text,
        });
        return send(res, 200, { ok: true, script: saved });
      } catch (err) {
        return send(res, Number(err && err.statusCode) || 400, { ok: false, code: err && err.code, error: err.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/interview-script') {
      const body = await readBody(req);
      const jobId = Number(body.jobId);
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
      try {
        let scriptJson = normalizeReportJson(body.script || body.script_json || body.scriptJson);
        let script = readJsonMaybe(scriptJson);
        if (typeof body.scriptText === 'string') {
          script = script && typeof script === 'object' ? script : { schema_version: 'interview_script_p0_v1' };
          script.script_text = body.scriptText;
          script.updated_by_hr = true;
          script.updated_at = nowIso();
          scriptJson = JSON.stringify(script, null, 2);
        }
        const saved = db.saveInterviewScript({
          jobId,
          source: typeof body.source === 'string' ? body.source : 'hr_edited',
          status: typeof body.status === 'string' ? body.status : 'draft',
          script_json: scriptJson,
          script_text: typeof body.scriptText === 'string' ? body.scriptText : (script && script.script_text),
        });
        return send(res, 200, { ok: true, script: saved });
      } catch (err) {
        return send(res, Number(err && err.statusCode) || 400, { ok: false, code: err && err.code, error: err.message });
      }
    }

    // 生成/更新深度画像：要读全部访谈再产出大 JSON，可能要几分钟，后台异步跑 + 轮询进度。
    if (req.method === 'POST' && url.pathname === '/api/deep-profile/generate') {
      const body = await readBody(req);
      const jobId = Number(body.jobId);
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
      const cur = deepProgress.get(jobId);
      if (cur && cur.status === 'running') {
        return send(res, 409, { ok: false, error: '该岗位画像正在生成中，别重复点', progress: cur });
      }
      try {
        db.assertJobRecruitingWritableById(jobId);
        db.getCurrentJobProfileContext(jobId);
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 409, {
          ok: false,
          code: error && error.code,
          error: error.message,
        });
      }
      try {
        const connectionBinding = currentExternalAiConnectionBinding();
        const materialSha256 = currentExternalAiMaterialHash('deep-profile', String(jobId));
        consumeExternalAiUserApproval(
          f009ApprovalSecret,
          body.userApproval,
          {
            purpose: 'deep-profile',
            targetId: String(jobId),
            requestId: body.requestId,
            actor: principal.actor_id,
            materialSha256,
            ...connectionBinding,
          },
          consumedExternalAiApprovalNonces,
        );
      } catch (approvalError) {
        return send(res, 403, {
          ok: false,
          code: 'external_ai_confirmation_required',
          error: approvalError.message,
        });
      }
      deepProgress.set(jobId, { status: 'running', error: null, startedAt: Date.now(), finishedAt: null });
      const authorization = issueExternalAiAuthorization({
        purpose: 'deep-profile',
        confirmed: true,
        requestedBy: principal.actor_id,
        binding: currentExternalAiConnectionBinding(),
      });
      db.generateDeepProfileForJob(jobId, {
        generator: (input, grant) => f009Runtime.generateDeepProfile(input, grant),
        usesExternalAi: true,
        externalAiStatus: () => f009Runtime.externalAiStatus(),
        externalAiAuthorization: authorization,
      }).then(() => {
        deepProgress.set(jobId, { status: 'done', error: null, startedAt: (cur && cur.startedAt) || Date.now(), finishedAt: Date.now() });
      }).catch((err) => {
        deepProgress.set(jobId, { status: 'error', error: err.message, startedAt: (cur && cur.startedAt) || Date.now(), finishedAt: Date.now() });
      });
      return send(res, 200, { ok: true, started: true });
    }

    if (req.method === 'GET' && url.pathname === '/api/deep-profile/progress') {
      const jobId = Number(url.searchParams.get('jobId'));
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
      const p = deepProgress.get(jobId);
      if (!p) return send(res, 200, { ok: true, status: 'idle' });
      return send(res, 200, { ok: true, ...p });
    }

    // 标记「负责人已确认」（HR 代录，审计留痕）。
    if (req.method === 'POST' && url.pathname === '/api/deep-profile/confirm') {
      const body = await readBody(req);
      const jobId = Number(body.jobId);
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
      const deep = db.confirmDeepProfile(jobId);
      return send(res, 200, { ok: true, deep_profile: deep });
    }

    if (req.method === 'GET' && url.pathname === '/api/assess/status') {
      const candidateId = typeof url.searchParams.get('candidateId') === 'string' ? url.searchParams.get('candidateId').trim() : '';
      if (!candidateId) return send(res, 400, { ok: false, error: 'candidateId required' });
      const status = db.getAssessStatus(candidateId, f009Runtime.externalAiStatus());
      if (!status.candidate_found) return send(res, 404, { ok: false, error: 'candidate not found', status });
      return send(res, 200, { ok: true, status });
    }

    if (req.method === 'POST' && url.pathname === '/api/candidate/resume-intake/preview') {
      const body = await readBody(req);
      try {
        const result = await getResumeCandidateIntakeService().prepare({
          selectionToken: body.selection_token,
          command: body,
          actor: principal.actor_id,
        });
        return send(res, 200, { ok: true, result });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, {
          ok: false,
          code: error && error.code,
          error: (error && error.message) || '简历建档预处理失败。',
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/candidate/resume-intake/commit') {
      const body = await readBody(req);
      try {
        const result = await getResumeCandidateIntakeService().commit(body);
        return send(res, 200, { ok: true, result });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, {
          ok: false,
          code: error && error.code,
          error: (error && error.message) || '简历建档失败。',
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/candidate/resume-attachment/import') {
      const body = await readBody(req);
      try {
        const selection = consumeResumeFileSelection(
          RESUME_SELECTION_SECRET,
          body.selection_token,
          body,
          consumedResumeSelectionNonces,
        );
        const result = await importManualResumeAttachment({
          database: db.conn(),
          dataRoot: path.resolve(process.env.HRBOSS_DATA_DIR || path.join(PROJECT_ROOT, 'data')),
          sourcePath: selection.source_path,
          candidateId: selection.candidate_id,
          jobId: selection.job_id,
          actor: principal.actor_id,
          pdfinfoExecutablePath: firstAssessmentTool('HRBOSS_PDFINFO_PATH', 'pdfinfo'),
          pdftoppmExecutablePath: firstAssessmentTool('HRBOSS_PDFTOPPM_PATH', 'pdftoppm'),
          pdftotextExecutablePath: firstAssessmentTool('HRBOSS_PDFTOTEXT_PATH', 'pdftotext'),
          tesseractExecutablePath: firstAssessmentTool('HRBOSS_TESSERACT_PATH', 'tesseract'),
          visionOcrExecutablePath: process.platform === 'darwin' ? '/usr/bin/swift' : '',
          visionOcrScriptPath: path.join(PROJECT_ROOT, "native/vision-ocr.swift"),
        });
        return send(res, 200, { ok: true, result });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, {
          ok: false,
          code: (error && error.code) || 'MANUAL_RESUME_IMPORT_FAILED',
          error: (error && error.message) || '手动上传简历失败。',
        });
      }
    }

    // 单人 AI 评估（第二意见）：同步等结果返回；只写 ai_review，绝不动 SABC。
    if (req.method === 'POST' && url.pathname === '/api/assess') {
      const body = await readBody(req);
      const candidateId = typeof body.candidateId === 'string' ? body.candidateId.trim() : '';
      if (!candidateId) return send(res, 400, { ok: false, error: 'candidateId required' });
      const profileStatus = db.getAssessStatus(candidateId, f009Runtime.externalAiStatus());
      if (profileStatus.candidate_found) {
        try {
          db.assertCandidateJobRecruitingWritable(candidateId);
        } catch (error) {
          return send(res, Number(error && error.statusCode) || 409, {
            ok: false,
            code: error && error.code,
            error: error.message,
            status: profileStatus,
          });
        }
      }
      // Do not consume a valid one-time approval when the candidate exists but
      // the active JD has no matching confirmed profile. Other readiness errors
      // retain the confirmation-first API guard and are returned after consume.
      if (profileStatus.candidate_found && !profileStatus.current_profile_ready) {
        return send(res, 409, {
          ok: false,
          code: profileStatus.current_profile_error_code || 'JOB_CURRENT_PROFILE_REQUIRED',
          error: profileStatus.blockers.join('；') || '当前 JD 还没有已确认画像。',
          status: profileStatus,
        });
      }
      try {
        const connectionBinding = currentExternalAiConnectionBinding();
        const materialSha256 = currentExternalAiMaterialHash('candidate-assessment', candidateId);
        consumeExternalAiUserApproval(
          f009ApprovalSecret,
          body.userApproval,
          {
            purpose: 'candidate-assessment',
            targetId: candidateId,
            requestId: body.requestId,
            actor: principal.actor_id,
            materialSha256,
            ...connectionBinding,
          },
          consumedExternalAiApprovalNonces,
        );
      } catch (approvalError) {
        return send(res, 403, {
          ok: false,
          code: 'external_ai_confirmation_required',
          error: approvalError.message,
        });
      }
      const status = profileStatus;
      if (!status.candidate_found) return send(res, 404, { ok: false, error: 'candidate not found', status });
      if (!status.can_real_assess) {
        return send(res, 400, {
          ok: false,
          error: status.blockers.join('；') || '当前候选人暂不能生成真实 AI 匹配报告。',
          status,
        });
      }
      if (assessRunning.has(candidateId)) {
        return send(res, 409, { ok: false, error: '这位候选人正在评估中，别重复点' });
      }
      assessRunning.add(candidateId);
      try {
        const authorization = issueExternalAiAuthorization({
          purpose: 'candidate-assessment',
          confirmed: true,
          requestedBy: principal.actor_id,
          binding: currentExternalAiConnectionBinding(),
        });
        const result = await db.runSecondOpinion(candidateId, {
          assessor: (input, grant) => f009Runtime.assessCandidateV1(input, grant),
          usesExternalAi: true,
          externalAiStatus: () => f009Runtime.externalAiStatus(),
          externalAiAuthorization: authorization,
        });
        return send(res, 200, { ok: true, ...result });
      } finally {
        assessRunning.delete(candidateId);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/assess/local-demo') {
      const body = await readBody(req);
      const candidateId = typeof body.candidateId === 'string' ? body.candidateId.trim() : '';
      if (!candidateId) return send(res, 400, { ok: false, error: 'candidateId required' });
      const status = db.getAssessStatus(candidateId, f009Runtime.externalAiStatus());
      if (!status.candidate_found) return send(res, 404, { ok: false, error: 'candidate not found', status });
      if (!status.can_local_demo) {
        return send(res, 400, {
          ok: false,
          error: status.blockers.join('；') || '当前候选人暂不能生成本地样本报告。',
          status,
        });
      }
      if (assessRunning.has(candidateId)) {
        return send(res, 409, { ok: false, error: '这位候选人正在评估中，别重复点' });
      }
      assessRunning.add(candidateId);
      try {
        const result = db.runSecondOpinionLocalDemo(candidateId);
        return send(res, 200, { ok: true, ...result });
      } finally {
        assessRunning.delete(candidateId);
      }
    }

    // 启动批量评级：不等它跑完，立刻返回。评级在后台跑，进度另开端点查。
    if (req.method === 'POST' && url.pathname === '/api/rate') {
      const body = await readBody(req);
      const jobId = Number(body.jobId);
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
      const cur = rateProgress.get(jobId);
      if (cur && cur.status === 'running') {
        return send(res, 409, { ok: false, error: '该岗位正在评级中，别重复点', progress: cur });
      }
      rateProgress.set(jobId, { status: 'running', done: 0, total: null, summary: null, error: null, startedAt: Date.now(), finishedAt: null });
      // 后台异步跑；进度回调实时写内存。
      db.rateJob(jobId, {
        onProgress: (done, total) => {
          const p = rateProgress.get(jobId);
          if (p) { p.done = done; p.total = total; }
        },
      }).then((summary) => {
        rateProgress.set(jobId, { status: 'done', done: summary.rated + summary.pending, total: summary.rated + summary.pending, summary, error: null, startedAt: (cur && cur.startedAt) || Date.now(), finishedAt: Date.now() });
      }).catch((err) => {
        const p = rateProgress.get(jobId) || {};
        rateProgress.set(jobId, { status: 'error', done: p.done || 0, total: p.total || null, summary: null, error: err.message, startedAt: p.startedAt || Date.now(), finishedAt: Date.now() });
      });
      return send(res, 200, { ok: true, started: true });
    }

    // 查批量评级进度。
    if (req.method === 'GET' && url.pathname === '/api/rate/progress') {
      const jobId = Number(url.searchParams.get('jobId'));
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
      const p = rateProgress.get(jobId);
      if (!p) return send(res, 200, { ok: true, status: 'idle' });
      return send(res, 200, { ok: true, ...p });
    }

    if (req.method === 'GET' && url.pathname === '/api/screenshot-ocr-drafts') {
      try {
        const status = url.searchParams.get('status') || '';
        const jobId = url.searchParams.get('jobId') || '';
        return send(res, 200, { ok: true, drafts: listScreenshotOcrDrafts({ status, jobId }) });
      } catch (err) {
        return send(res, 400, { ok: false, error: err.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/screenshot-ocr-drafts/ai-fill-preflight') {
      const body = await readBody(req);
      const jobId = Number(body.job_id === undefined ? body.jobId : body.job_id);
      if (!Number.isSafeInteger(jobId) || jobId <= 0) {
        return send(res, 400, { ok: false, error: 'job_id required：AI 补全必须绑定当前岗位。' });
      }
      const status = f009Runtime.externalAiStatus();
      if (!status.operational) {
        return send(res, 400, { ok: false, code: 'SCREENSHOT_AI_FILL_REQUIRES_EXTERNAL_AI', error: status.blockers.join('') || '外部 AI 尚未配置。' });
      }
      try {
        const snapshot = prepareScreenshotAiFillBatch(db.conn(), jobId);
        return send(res, 200, {
          ok: true,
          preview: publicApprovalPreview(snapshot, currentExternalAiConnectionBinding(), {
            purpose: SCREENSHOT_FIELD_PURPOSE,
            operation: 'ai_fill',
          }),
        });
      } catch (error) {
        return send(res, 409, { ok: false, code: error.code || 'SCREENSHOT_AI_FILL_NOT_READY', error: error.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/screenshot-ocr-drafts/ai-fill') {
      const body = await readBody(req);
      const jobId = Number(body.job_id === undefined ? body.jobId : body.job_id);
      if (!Number.isSafeInteger(jobId) || jobId <= 0) {
        return send(res, 400, { ok: false, error: 'job_id required：AI 补全必须绑定当前岗位。' });
      }
      const status = f009Runtime.externalAiStatus();
      if (!status.operational) {
        return send(res, 400, { ok: false, code: 'SCREENSHOT_AI_FILL_REQUIRES_EXTERNAL_AI', error: status.blockers.join('') || '外部 AI 尚未配置。' });
      }
      let snapshot;
      let connection;
      try {
        snapshot = prepareScreenshotAiFillBatch(db.conn(), jobId);
        connection = currentExternalAiConnectionBinding();
        consumeExternalAiUserApproval(
          f009ApprovalSecret,
          body.userApproval,
          {
            purpose: SCREENSHOT_FIELD_PURPOSE,
            targetId: snapshot.target_id,
            requestId: body.requestId,
            actor: principal.actor_id,
            materialSha256: snapshot.material_sha256,
            ...connection,
          },
          consumedExternalAiApprovalNonces,
        );
      } catch (error) {
        return send(res, 403, { ok: false, code: 'SCREENSHOT_AI_FILL_APPROVAL_REQUIRED', error: error.message });
      }
      try {
        // Runs here rather than in the import subprocess so the API key stays
        // inside the process that owns the encrypted settings store. The state
        // and the channel both come from the settings-page runtime, so what the
        // HR configured there is what this button uses; a grant is signed per
        // read because each one is single-use and the reads run concurrently.
        const summary = await fillPendingDraftsWithAi({
          database: db.conn(),
          jobId,
          applyFill: applyAiFieldFill,
          status,
          approvedMaterials: snapshot.items,
          readImageJson: (input, approvedItem) => {
            const authorizationBinding = {
              ...connection,
              operation: 'ai_fill',
              target_id: snapshot.target_id,
              material_sha256: snapshot.material_sha256,
              image_id: approvedItem.image_id,
              draft_id: approvedItem.draft_id,
              source_sha256: approvedItem.source_sha256,
              size_bytes: approvedItem.size_bytes,
            };
            return f009Runtime.readImageJson(input, issueExternalAiAuthorization({
              purpose: SCREENSHOT_FIELD_PURPOSE,
              confirmed: true,
              requestedBy: principal.actor_id,
              binding: authorizationBinding,
            }), authorizationBinding);
          },
        });
        return send(res, 200, { ok: true, summary });
      } catch (err) {
        return send(res, 500, { ok: false, error: err.message });
      }
    }

    const screenshotPreviewMatch = req.method === 'GET'
      ? url.pathname.match(/^\/api\/screenshot-ocr-drafts\/(\d+)\/preview$/)
      : null;
    if (screenshotPreviewMatch) {
      try {
        const preview = screenshotDraftPreview(Number(screenshotPreviewMatch[1]));
        auditSensitiveRead('screenshot_ocr_draft_preview', screenshotPreviewMatch[1]);
        return sendBinary(res, 200, preview.bytes, preview.contentType);
      } catch (error) {
        return send(res, error.code === 'SCREENSHOT_DRAFT_NOT_FOUND' ? 404 : 409, {
          ok: false,
          code: error.code || 'SCREENSHOT_DRAFT_PREVIEW_UNAVAILABLE',
          error: error.message,
        });
      }
    }

    const screenshotAuditMatch = req.method === 'GET'
      ? url.pathname.match(/^\/api\/screenshot-ocr-drafts\/(\d+)\/audit$/)
      : null;
    if (screenshotAuditMatch) {
      return send(res, 200, { ok: true, audit: listScreenshotOcrReviewAudit(Number(screenshotAuditMatch[1])) });
    }

    const screenshotReviewMatch = req.method === 'POST'
      ? url.pathname.match(/^\/api\/screenshot-ocr-drafts\/(\d+)\/(edit|confirm|reject)$/)
      : null;
    if (screenshotReviewMatch) {
      const body = await readBody(req);
      const id = Number(screenshotReviewMatch[1]);
      const action = screenshotReviewMatch[2];
      try {
        const draft = action === 'edit'
          ? editScreenshotOcrDraft(id, { changes: body.changes, actor: principal.actor_id })
          : action === 'confirm'
            ? confirmScreenshotOcrDraft(id, {
              actor: principal.actor_id,
              nameVerifiedByHr: body.name_verified_by_hr === true || body.name_verified === true,
            })
            : rejectScreenshotOcrDraft(id, { actor: principal.actor_id });
        return send(res, 200, { ok: true, draft });
      } catch (err) {
        return send(res, /不存在/.test(err.message) ? 404 : 409, { ok: false, error: err.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/screenshot-import/preflight') {
      const body = await readBody(req);
      if (typeof body.dir !== 'string' || !body.dir.trim()) {
        return send(res, 400, { ok: false, error: 'dir required' });
      }
      if (screenshotImportEngine() === 'macos_vision') {
        try {
          await assertLocalVisionReady();
        } catch (error) {
          return send(res, 400, { ok: false, code: error.code, error: error.message });
        }
        return send(res, 200, { ok: true, preview: { requires_external_ai: false, engine: 'macos_vision' } });
      }
      const status = f009Runtime.externalAiStatus();
      if (!status.operational) {
        return send(res, 400, {
          ok: false,
          code: 'SCREENSHOT_IMPORT_REQUIRES_EXTERNAL_AI',
          error: `本机没有本地识别引擎，截图导入需要外部 AI。${status.blockers.join('')}`,
          blockers: status.blockers,
        });
      }
      try {
        const selected = resolveSelectedDirectory(body.dir, { label: '截图文件夹' });
        const snapshot = prepareScreenshotAiBatch(selected.path);
        return send(res, 200, {
          ok: true,
          preview: publicApprovalPreview(snapshot, currentExternalAiConnectionBinding()),
        });
      } catch (error) {
        return send(res, 400, {
          ok: false,
          code: 'SCREENSHOT_IMPORT_PREFLIGHT_FAILED',
          error: '无法读取所选截图，请确认文件仍存在且可读。',
        });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/screenshot-import/start') {
      const cur = screenshotImportProgress.readProgress();
      if (freshActiveProgress(cur)) return send(res, 409, { ok: false, error: '截图导入正在运行中，别重复点。', progress: publicScreenshotImportProgress(cur) });
      const body = await readBody(req);
      if (typeof body.dir !== 'string' || !body.dir.trim()) {
        return send(res, 400, { ok: false, error: 'dir required' });
      }
      let selected;
      try {
        selected = resolveSelectedDirectory(body.dir, { label: '截图文件夹' });
      } catch (error) {
        return send(res, 400, { ok: false, code: error.code, error: error.message });
      }
      const resolved = selected.path;
      if (screenshotImportEngine() === 'macos_vision') {
        try {
          await assertLocalVisionReady();
        } catch (error) {
          return send(res, 400, { ok: false, code: error.code, error: error.message });
        }
        // Another request may have started while the asynchronous tool probe ran.
        const latest = screenshotImportProgress.readProgress();
        if (freshActiveProgress(latest)) return send(res, 409, { ok: false, error: '截图导入正在运行中，别重复点。', progress: publicScreenshotImportProgress(latest) });
      }
      // Where there is no local recognition, the model reads the screenshots —
      // and it has to happen here, because this is the process that holds the
      // key and the import itself runs in a child that must never see it.
      if (screenshotImportEngine() === 'external_ai') {
        const status = f009Runtime.externalAiStatus();
        if (!status.operational) {
          // No falling back to tesseract: it was measured at 6 of 13 names and
          // invented candidates that do not exist. Telling the HR what to fix
          // beats importing something they would have to unpick.
          return send(res, 400, {
            ok: false,
            code: 'SCREENSHOT_IMPORT_REQUIRES_EXTERNAL_AI',
            error: `本机没有本地识别引擎，截图导入需要外部 AI。${status.blockers.join('')}`,
            blockers: status.blockers,
          });
        }
        let snapshot;
        let aiState;
        try {
          snapshot = prepareScreenshotAiBatch(resolved);
          const connection = currentExternalAiConnectionBinding();
          consumeExternalAiUserApproval(
            f009ApprovalSecret,
            body.userApproval,
            {
              purpose: SCREENSHOT_IMPORT_PURPOSE,
              targetId: snapshot.target_id,
              requestId: body.requestId,
              actor: principal.actor_id,
              materialSha256: snapshot.material_sha256,
              ...connection,
            },
            consumedExternalAiApprovalNonces,
          );
          aiState = screenshotAiImportState.create(snapshot, connection);
        } catch (error) {
          return send(res, 403, {
            ok: false,
            code: 'SCREENSHOT_EXTERNAL_AI_APPROVAL_REQUIRED',
            error: error.message,
          });
        }
        screenshotImportProgress.writeProgress({
          status: 'running',
          stage: 'ocr',
          source_dir_name: path.basename(resolved),
          run_id: aiState.run_id,
          image_count: snapshot.items.length,
          detail_draft_count: 0,
          message: `正在识别 ${snapshot.items.length} 张截图。`,
          started_at: nowIso(),
          finished_at: null,
          error: null,
          result: null,
        });
        // Reading takes minutes, so the response cannot wait on it. Progress is
        // written from here until the child takes over.
        runAiScreenshotReads(snapshot, aiState, principal.actor_id).catch((error) => {
          console.error(`截图 AI 识别失败：${error && error.message ? error.message : 'unknown'}`);
          try { screenshotAiImportState.failRun(aiState.run_id); } catch {}
          screenshotImportProgress.writeProgress({
            ...screenshotImportProgress.readProgress(),
            status: 'error',
            stage: 'ocr',
            message: '截图识别失败。',
            error: '截图识别失败，可在失败项中重试。',
            finished_at: nowIso(),
          });
        });
        return send(res, 200, {
          ok: true,
          engine: 'external_ai',
          run_id: aiState.run_id,
          task: publicScreenshotAiState(aiState, { progress: screenshotImportProgress.readProgress() }),
          path_recovered: selected.recoveredTrailingSpaces,
        });
      }
      const localRunId = `screenshot-local-${crypto.randomUUID()}`;
      screenshotImportProgress.writeProgress({
        status: 'running',
        stage: 'starting',
        run_id: localRunId,
        source_dir_name: path.basename(resolved),
        image_count: 0,
        detail_draft_count: 0,
        message: '正在启动截图导入。',
        started_at: nowIso(),
        finished_at: null,
        error: null,
        result: null,
      });
      const pid = spawnDetached(
        "src/start-screenshot-import.js",
        [`--dir=${resolved}`, `--run-id=${localRunId}`],
        {
          progressStore: screenshotImportProgress,
          runId: localRunId,
          failOnPrematureExit: true,
          failureMessage: '截图识别子进程异常退出，请重新发起导入。',
        },
      );
      return send(res, 200, { ok: true, engine: 'macos_vision', run_id: localRunId, pid, path_recovered: selected.recoveredTrailingSpaces });
    }

    if (req.method === 'POST' && url.pathname === '/api/screenshot-import/retry-preflight') {
      const body = await readBody(req);
      if (screenshotImportEngine() !== 'external_ai') {
        return send(res, 409, { ok: false, code: 'SCREENSHOT_RETRY_NOT_APPLICABLE', error: 'macOS 本地 Vision 导入不使用外部 AI 重试。' });
      }
      const activeProgress = screenshotImportProgress.readProgress();
      if (activeProgress.run_id === String(body.run_id || '') && freshActiveProgress(activeProgress)) {
        return send(res, 409, {
          ok: false,
          code: 'SCREENSHOT_IMPORT_STILL_RUNNING',
          error: '截图草稿仍在暂存，请等完整导入结束后再重试问题项。',
          progress: publicScreenshotImportProgress(activeProgress),
        });
      }
      const status = f009Runtime.externalAiStatus();
      if (!status.operational) return send(res, 400, { ok: false, code: 'SCREENSHOT_IMPORT_REQUIRES_EXTERNAL_AI', error: status.blockers.join('') || '外部 AI 尚未配置。' });
      try {
        const snapshot = screenshotAiImportState.prepareRetry(body.run_id, body.item_ids);
        return send(res, 200, {
          ok: true,
          preview: publicApprovalPreview(snapshot, currentExternalAiConnectionBinding(), { operation: 'retry' }),
        });
      } catch (error) {
        return send(res, /不存在/.test(error.message) ? 404 : 409, { ok: false, code: 'SCREENSHOT_RETRY_NOT_READY', error: error.message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/screenshot-import/retry') {
      const body = await readBody(req);
      if (screenshotImportEngine() !== 'external_ai') {
        return send(res, 409, { ok: false, code: 'SCREENSHOT_RETRY_NOT_APPLICABLE', error: 'macOS 本地 Vision 导入不使用外部 AI 重试。' });
      }
      const activeProgress = screenshotImportProgress.readProgress();
      if (activeProgress.run_id === String(body.run_id || '') && freshActiveProgress(activeProgress)) {
        return send(res, 409, {
          ok: false,
          code: 'SCREENSHOT_IMPORT_STILL_RUNNING',
          error: '截图草稿仍在暂存，请等完整导入结束后再重试问题项。',
          progress: publicScreenshotImportProgress(activeProgress),
        });
      }
      const externalAiStatus = f009Runtime.externalAiStatus();
      if (!externalAiStatus.operational) {
        return send(res, 400, {
          ok: false,
          code: 'SCREENSHOT_IMPORT_REQUIRES_EXTERNAL_AI',
          error: externalAiStatus.blockers.join('') || '外部 AI 尚未配置。',
        });
      }
      let snapshot;
      let state;
      let connection;
      try {
        snapshot = screenshotAiImportState.prepareRetry(body.run_id, body.item_ids);
        connection = currentExternalAiConnectionBinding();
        consumeExternalAiUserApproval(
          f009ApprovalSecret,
          body.userApproval,
          {
            purpose: SCREENSHOT_IMPORT_PURPOSE,
            targetId: snapshot.target_id,
            requestId: body.requestId,
            actor: principal.actor_id,
            materialSha256: snapshot.material_sha256,
            ...connection,
          },
          consumedExternalAiApprovalNonces,
        );
        state = screenshotAiImportState.beginRetry(
          snapshot.run_id,
          snapshot.items.map((item) => item.image_id),
          connection,
        );
      } catch (error) {
        return send(res, 403, { ok: false, code: 'SCREENSHOT_RETRY_APPROVAL_REQUIRED', error: error.message });
      }
      runAiScreenshotReads(snapshot, state, principal.actor_id, { retry: true }).catch((error) => {
        console.error(`截图 AI 重试失败：${error && error.message ? error.message : 'unknown'}`);
        try { screenshotAiImportState.failRun(state.run_id); } catch {}
        screenshotImportProgress.writeProgress({
          ...screenshotImportProgress.readProgress(),
          status: 'error',
          stage: 'ocr',
          message: '截图重试识别失败。',
          error: '截图重试识别失败，请查看失败项。',
          finished_at: nowIso(),
        });
      });
      return send(res, 200, { ok: true, run_id: state.run_id, task: publicScreenshotAiState(state, { progress: screenshotImportProgress.readProgress() }) });
    }

    if (req.method === 'GET' && url.pathname === '/api/screenshot-import/task') {
      try {
        const requestedRunId = url.searchParams.get('run_id');
        const legacyProgress = screenshotImportProgress.readProgress();
        if (screenshotImportEngine() === 'macos_vision'
            || (!screenshotAiImportState.read() && (!requestedRunId || requestedRunId === legacyProgress.run_id))) {
          const task = publicLegacyScreenshotTask(legacyProgress);
          if (requestedRunId && task.run_id !== requestedRunId) throw new Error('截图任务不存在。');
          return send(res, 200, { ok: true, task });
        }
        const state = requestedRunId ? screenshotAiImportState.requireRun(requestedRunId) : screenshotAiImportState.read();
        if (!state) return send(res, 200, { ok: true, task: publicLegacyScreenshotTask(legacyProgress) });
        return send(res, 200, { ok: true, task: publicScreenshotAiState(state, { progress: legacyProgress }) });
      } catch (error) {
        return send(res, 404, { ok: false, code: 'SCREENSHOT_AI_TASK_NOT_FOUND', error: error.message });
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/screenshot-import/progress') {
      let aiTask = null;
      try { aiTask = publicScreenshotAiState(screenshotAiImportState.read(), { progress: screenshotImportProgress.readProgress() }); } catch {}
      return send(res, 200, {
        ok: true,
        progress: { ...publicScreenshotImportProgress(screenshotImportProgress.readProgress()), ai_task: aiTask },
      });
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    if (error && error.statusCode && error.code) return sendInterviewReportError(res, error);
    return send(res, 500, { ok: false, error: error.message });
  }
}

let server = null;
let startupPromise = null;

function startHttpServer() {
  if (server) return Promise.resolve(server);
  if (startupPromise) return startupPromise;
  startupPromise = (async () => {
    const assessmentBackupPolicy = assessmentBackupPolicyOptionsFromEnv();
    await db.openDbWithMigrationBackup(undefined, {
      assessmentDataRoot: path.resolve(process.env.HRBOSS_DATA_DIR || path.join(PROJECT_ROOT, 'data')),
      ...assessmentBackupPolicy,
    });
    db.reconcileF009RunningRequests();
    if (!localInterviewJob) refreshPersistedLocalInterviewBlocker();
    server = http.createServer(route);
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`端口 ${PORT} 被占用，可能上次没退干净。先杀掉占用进程（mac 终端：lsof -ti :${PORT} | xargs kill），或重启电脑后再 npm run ui。`);
        process.exit(1);
      }
      throw err;
    });
    server.listen(PORT, HOST, () => {
      console.log(`action db server http://${HOST}:${PORT}`);
    });
    return server;
  })();
  return startupPromise;
}

function waitForChildExit(child, timeoutMs = 4000) {
  return new Promise((resolve) => {
    if (!child || child.exitCode != null || child.signalCode) return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.removeListener('exit', finish);
      resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish();
    }, timeoutMs);
    child.once('exit', finish);
  });
}

function closeActionHttpServer() {
  return new Promise((resolve) => {
    const activeServer = server;
    server = null;
    if (!activeServer) return resolve();
    const timer = setTimeout(resolve, 2000);
    activeServer.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function localInterviewShutdownSafety(job = localInterviewJob) {
  if (!job) {
    return { ok: true, termination_confirmed: true, cleanup_complete: true };
  }
  const terminationConfirmed = job.terminationUnconfirmed !== true
    && (!job.child || job.finalized === true || job.status === 'cancelled' || job.status === 'done');
  const cleanupComplete = job.cleanupPending !== true && job.persistentStateFailed !== true;
  return {
    ok: terminationConfirmed && cleanupComplete,
    termination_confirmed: terminationConfirmed,
    cleanup_complete: cleanupComplete,
  };
}

async function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    const ownedJob = localInterviewJob;
    let localSettlement = null;
    if (ownedJob && ownedJob.child && !ownedJob.finalized) {
      const stopResult = abortLocalInterviewJob(
        ownedJob,
        '应用正在退出；正在安全停止本地录音任务并清理未完成材料。',
        {
          preserveRecording: ownedJob.mode === 'retry-transcription'
            || ownedJob.transcriptionStarted === true
            || (ownedJob.mode === 'record' && ownedJob.stopRequested === true),
        },
      );
      localSettlement = await stopResult.settlement;
    }
    const children = [...backgroundChildren];
    for (const child of children) {
      try { if (child.exitCode == null) child.kill('SIGTERM'); } catch {}
    }
    await Promise.all(children.map((child) => waitForChildExit(child)));
    const latestJob = localInterviewJob;
    const safety = localInterviewShutdownSafety(latestJob);
    const terminationConfirmed = safety.termination_confirmed;
    if (terminationConfirmed) await closeActionHttpServer();
    return {
      ok: terminationConfirmed && safety.cleanup_complete,
      local_interview_termination_confirmed: terminationConfirmed,
      local_interview_cleanup_complete: safety.cleanup_complete,
      job: compactLocalInterviewJob(latestJob),
    };
  })();
  return shutdownPromise;
}

function beginActionProcessShutdown(trigger = 'signal') {
  shutdown().then((result) => {
    if (result && result.ok) {
      process.exit(0);
      return;
    }
    if (result && result.local_interview_termination_confirmed) {
      process.exit(2);
      return;
    }
    process.exitCode = 1;
    console.error(`action db server shutdown blocked after ${trigger}: local interview process-group termination is unconfirmed`);
    let confirmationCheckRunning = false;
    const confirmationPoll = setInterval(() => {
      if (confirmationCheckRunning) return;
      confirmationCheckRunning = true;
      if (localInterviewJob
          && typeof localInterviewJob.reconcileAbortedJob === 'function') {
        localInterviewJob.reconcileAbortedJob();
      }
      if (localInterviewJob && localInterviewJob.recoveredPersistentBlocker) {
        refreshPersistedLocalInterviewBlocker();
      }
      const safety = localInterviewShutdownSafety(localInterviewJob);
      if (safety.termination_confirmed) {
        clearInterval(confirmationPoll);
        closeActionHttpServer().finally(() => {
          process.exit(safety.cleanup_complete ? 0 : 2);
        });
        return;
      }
      confirmationCheckRunning = false;
    }, 250);
  }).catch((error) => {
    process.exitCode = 1;
    console.error(`action db server shutdown failed after ${trigger}: ${error.message}`);
  });
}

if (require.main === module) {
  startHttpServer().catch((error) => {
    console.error(`action db server startup failed: ${error.message}`);
    process.exit(1);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => beginActionProcessShutdown(signal));
  }
  if (process.connected) {
    process.once('disconnect', () => {
      beginActionProcessShutdown('candidate_main_ipc_disconnect');
    });
  }
}

module.exports = {
  autoBindLocalInterviewResult,
  abortLocalInterviewJob,
  cleanupAbortedLocalInterviewArtifacts,
  cleanupFailedLocalInterviewResult,
  compactLiveAudio,
  createLiveAudioStderrDemux,
  finalizeLocalInterviewMicCheck,
  route,
  startHttpServer,
  shutdown,
  f009Runtime,
  guardianRegistryProcessState,
  interviewConsentStopHttpResult,
  interviewConsentRevocationHttpResult,
  interviewLifecycleWithdrawalHttpResult,
  revokeInterviewConsentAndStop,
  withdrawInterviewLifecycleAndStop,
  discardTerminalLocalInterviewBinding,
  terminalLocalInterviewBindingError,
  localInterviewAbortHttpResult,
  localInterviewRecordStopDisposition,
  localInterviewManualStopHttpResult,
  localInterviewJobBlocksStart,
  localInterviewLifecycleCloseBlocked,
  localInterviewGuardianExitRequiresAbort,
  localInterviewOutDir,
  localInterviewProcessGroupState,
  localInterviewShutdownSafety,
  localInterviewStopMatches,
  localInterviewTaskScopeMatches,
  localInterviewStartConsentValid,
  persistAndBindLocalInterviewResult,
  recoveredLocalInterviewProcessGroupState,
  recoverPersistedLocalInterviewBlocker,
  refreshPersistedLocalInterviewBlocker,
  requestOwnedLocalInterviewManualStop,
  requestLocalInterviewStop,
  retryRecoveredLocalInterviewBinding,
  reconcileRecoveredLocalInterviewTranscription,
  discardPreservedLocalInterviewRecording,
  preserveFailedLocalInterviewTranscription,
  preservedLocalInterviewRecording,
  runLocalInterviewJob,
  sanitizeLocalInterviewMicCheckResult,
  writeLocalInterviewPersistentState,
  verifyLocalInterviewOutDirOwner,
  signalLocalInterviewProcessTree,
  settleLocalInterviewProcessTree,
  screenshotDraftPreview,
  screenshotImportEngine,
};
