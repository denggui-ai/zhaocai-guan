'use strict';

const db = require('./db');
const assessmentArchive = require('./assessment-archive-service');
const { prepareAssessmentIngress } = require('./assessment-actor-context');
const {
  assessmentRetentionPolicyFromEnv,
  listAssessmentAiAnalyses,
} = require('./assessment-product-service');
const interviewAdapters = require('./interview-source-adapters');
const { createF009LlmRuntime } = require('./f009-interview-llm');
const {
  getInterviewMaterialRoot,
  readControlledTextFile,
} = require('./interview-material-paths');

const OPERATIONAL_READONLY_EXACT_PATHS = Object.freeze([
  '/api/assessment/status',
  '/api/assessment/archive',
  '/api/assessment/queue',
  '/api/assessment/ai-analysis',
  '/api/assess/status',
  '/api/profile',
  '/api/candidate-journey-operations',
  '/api/interview/import-lark/status',
  '/api/interview',
  '/api/interview-session',
  '/api/interview-recording',
  '/api/interview-script',
  '/api/interview-assignment',
  '/api/interview-report',
  '/api/interview-lifecycle/status',
  '/api/interview-recording/report',
  '/api/interview-recording/confirmations',
  '/api/interview-recording/transcript',
  '/api/interview-consent',
  '/api/llm/config',
]);

const ALLOWED_PATHS = new Set(OPERATIONAL_READONLY_EXACT_PATHS);
const INTERVIEW_SOURCE_TYPES = new Set(['manual_transcript', 'offline_recording', 'lark_minutes']);
const INTERVIEW_SOURCE_MARKER = /^\[source_type:([a-z_]+)\]\s*/;
const ASSESSMENT_PHASE_A_ENABLED = process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED === '1';
const ASSESSMENT_RETENTION_POLICY = assessmentRetentionPolicyFromEnv(process.env);
const LOCAL_INTERVIEW_OUTPUT_ROOT = getInterviewMaterialRoot();
const llmRuntime = createF009LlmRuntime();
const projectionSchemaChecks = new Set();

function assertProjectionTables(key, tableNames) {
  if (projectionSchemaChecks.has(key)) return;
  const database = db.conn();
  const rows = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (${tableNames.map(() => '?').join(', ')})
  `).all(...tableNames);
  const present = new Set(rows.map((row) => row.name));
  const missing = tableNames.filter((name) => !present.has(name));
  if (missing.length) {
    const error = new Error(`readonly projection schema is missing table(s): ${missing.join(',')}`);
    error.code = 'READONLY_SCHEMA_MIGRATION_REQUIRED';
    error.statusCode = 503;
    throw error;
  }
  projectionSchemaChecks.add(key);
}

function response(status, body, audit = null) {
  return { handled: true, status, body, audit };
}

function requiredPositiveInteger(url, name) {
  const value = Number(url.searchParams.get(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    const error = new Error(`${name} required`);
    error.code = 'READONLY_QUERY_INVALID';
    error.statusCode = 400;
    throw error;
  }
  return value;
}

function requiredText(url, name) {
  const value = String(url.searchParams.get(name) || '').trim();
  if (!value) {
    const error = new Error(`${name} required`);
    error.code = 'READONLY_QUERY_INVALID';
    error.statusCode = 400;
    throw error;
  }
  return value;
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

function safeTranscriptPayload(recording) {
  if (!recording) {
    const error = new Error('interview recording not found');
    error.statusCode = 404;
    throw error;
  }
  if (!recording.transcript_txt_path) throw new Error('该录音没有 transcript.txt 路径。');
  const loaded = readControlledTextFile(recording.transcript_txt_path, 'transcript_txt', {
    root: LOCAL_INTERVIEW_OUTPUT_ROOT,
  });
  return {
    path: loaded.path,
    text: loaded.text,
    size: loaded.stat.size,
    updated_at: loaded.stat.mtime.toISOString(),
  };
}

function assessmentStatus() {
  return {
    ok: true,
    enabled: ASSESSMENT_PHASE_A_ENABLED,
    scope: 'hr_manual_assessment_reference',
    decision_use: ASSESSMENT_PHASE_A_ENABLED,
    decision_use_mode: ASSESSMENT_PHASE_A_ENABLED ? 'hr_confirmed_assessment_reference' : 'disabled',
    automated_decision_use: false,
    automatic_scoring_enabled: false,
    automatic_ranking_enabled: false,
    ranking_requires_hr_confirmed_binding: true,
    automatic_disposition_enabled: false,
    scoring_source: 'assessment_ai_fit_score_with_supplier_percentage_fallback',
    supplier_numeric_reference_enabled: ASSESSMENT_PHASE_A_ENABLED,
    ai_assisted_analysis_enabled: ASSESSMENT_PHASE_A_ENABLED,
    ai_requires_per_use_hr_approval: true,
    ai_result_requires_hr_review: true,
    original_pdf_view_enabled: false,
    real_pdf_pilot_allowed: false,
    internal_feature_available: ASSESSMENT_PHASE_A_ENABLED,
    archive_read_enabled: ASSESSMENT_PHASE_A_ENABLED,
    windows_release_ready: false,
    retention_policy_configured: Boolean(ASSESSMENT_RETENTION_POLICY),
    retention_policy_version: ASSESSMENT_RETENTION_POLICY ? ASSESSMENT_RETENTION_POLICY.version : null,
    retention_days: ASSESSMENT_RETENTION_POLICY ? ASSESSMENT_RETENTION_POLICY.days : null,
    delete_enabled: Boolean(ASSESSMENT_RETENTION_POLICY),
    export_enabled: false,
    operational_readonly: true,
  };
}

function requireAssessmentEnabled() {
  if (ASSESSMENT_PHASE_A_ENABLED) return;
  const error = new Error('PDF 测评行政存档尚未启用。');
  error.code = 'ASSESSMENT_PHASE_A_DISABLED';
  error.statusCode = 404;
  throw error;
}

function assessmentIngress(command) {
  return prepareAssessmentIngress(command, process.env);
}

function publicLlmConfig() {
  if (String(process.env.HRBOSS_EXTERNAL_AI_CONFIG_STARTUP_FAULT || '') === 'EXTERNAL_AI_CONFIG_UNREADABLE') {
    return response(503, {
      ok: false,
      code: 'EXTERNAL_AI_CONFIG_UNREADABLE',
      error: '本机外部 AI 配置读取失败；只读模式未尝试修复或覆盖配置。',
    });
  }
  return response(200, { ok: true, config: llmRuntime.publicConfig(), operational_readonly: true });
}

function projectOperationalReadonlyGet(url) {
  if (!url || !ALLOWED_PATHS.has(url.pathname)) return { handled: false };

  if (url.pathname === '/api/assessment/status') return response(200, assessmentStatus());

  if (url.pathname === '/api/assessment/archive') {
    requireAssessmentEnabled();
    assertProjectionTables('assessment-archive', ['assessment_document', 'assessment_binding', 'assessment_deletion_request']);
    const candidateId = requiredText(url, 'candidateId');
    const jobId = requiredPositiveInteger(url, 'jobId');
    const ingress = assessmentIngress({ candidate_id: candidateId, job_id: jobId });
    const archives = assessmentArchive.listAssessmentArchives({ database: db.conn(), ...ingress });
    return response(200, { ok: true, archives }, { action: 'assessment_archive_read', target: `${candidateId}:${jobId}` });
  }

  if (url.pathname === '/api/assessment/queue') {
    requireAssessmentEnabled();
    assertProjectionTables('assessment-archive', ['assessment_document', 'assessment_binding', 'assessment_deletion_request']);
    const jobId = requiredPositiveInteger(url, 'jobId');
    const ingress = assessmentIngress({ job_id: jobId });
    const queue = assessmentArchive.listAssessmentQueue({ database: db.conn(), ...ingress });
    return response(200, { ok: true, queue }, { action: 'assessment_queue_read', target: jobId });
  }

  if (url.pathname === '/api/assessment/ai-analysis') {
    requireAssessmentEnabled();
    assertProjectionTables('assessment-ai-analysis', ['assessment_document', 'assessment_binding', 'ai_review']);
    const candidateId = requiredText(url, 'candidateId');
    const jobId = requiredPositiveInteger(url, 'jobId');
    const analyses = listAssessmentAiAnalyses({
      database: db.conn(),
      command: { candidate_id: candidateId, job_id: jobId },
    });
    return response(200, { ok: true, analyses }, { action: 'assessment_ai_history_read', target: `${candidateId}:${jobId}` });
  }

  if (url.pathname === '/api/profile') {
    const jobId = requiredPositiveInteger(url, 'jobId');
    return response(200, {
      ok: true,
      config: db.getJobProfile(jobId),
      generation_readiness: db.getDeepProfileGenerationReadiness(jobId),
    }, { action: 'job_profile_read', target: jobId });
  }

  if (url.pathname === '/api/candidate-journey-operations') {
    assertProjectionTables('candidate-journey-operations', [
      'candidate_next_action',
      'hiring_manager_feedback',
      'candidate_offer_status',
    ]);
    const candidateId = requiredText(url, 'candidateId');
    const jobId = requiredPositiveInteger(url, 'jobId');
    return response(200, {
      ok: true,
      ...db.getCandidateJourneyOperations({ candidateId, jobId }),
    }, {
      action: 'candidate_journey_operations_read',
      target: `${candidateId}:${jobId}`,
    });
  }

  if (url.pathname === '/api/interview/import-lark/status') {
    const enabled = process.env.ENABLE_LARK_IMPORT === '1';
    return response(200, {
      ok: true,
      enabled,
      status: enabled ? 'enabled' : 'disabled',
      source_type: 'lark_minutes',
      requires_explicit_action: true,
      operational_readonly: true,
    });
  }

  if (url.pathname === '/api/interview') {
    const jobId = requiredPositiveInteger(url, 'jobId');
    const interviews = db.listInterviews(jobId).map(publicInterview);
    return response(200, { ok: true, interviews }, { action: 'interview_list_read', target: jobId });
  }

  if (url.pathname === '/api/interview-session') {
    const candidateId = url.searchParams.get('candidateId') || null;
    const jobId = url.searchParams.get('jobId') || null;
    const sessions = interviewAdapters.listSessionTimeline({ candidateId, jobId });
    return response(200, { ok: true, sessions }, { action: 'interview_session_read', target: `${candidateId || 'all'}:${jobId || 'all'}` });
  }

  if (url.pathname === '/api/interview-assignment') {
    const jobId = url.searchParams.get('jobId') || null;
    const status = url.searchParams.get('status') || null;
    const assignments = interviewAdapters.listPendingMaterials({ jobId, status });
    return response(200, { ok: true, assignments }, { action: 'interview_assignment_read', target: `${jobId || 'all'}:${status || 'all'}` });
  }

  if (url.pathname === '/api/interview-lifecycle/status') {
    const sessionId = requiredPositiveInteger(url, 'sessionId');
    const lifecycle = db.getInterviewLifecycleStatus({ sessionId });
    return response(200, { ok: true, lifecycle }, { action: 'interview_lifecycle_status_read', target: sessionId });
  }

  if (url.pathname === '/api/interview-recording') {
    const candidateId = url.searchParams.get('candidateId') || null;
    const jobId = url.searchParams.get('jobId') || null;
    const unmatched = url.searchParams.get('unmatched') === '1';
    const recordings = db.listInterviewRecordings({ candidateId, jobId, unmatched });
    return response(200, { ok: true, recordings }, {
      action: 'interview_recording_list_read',
      target: `${candidateId || 'all'}:${jobId || 'all'}:${unmatched ? 'unmatched' : 'matched'}`,
    });
  }

  if (url.pathname === '/api/interview-recording/report') {
    const recordingId = requiredPositiveInteger(url, 'recordingId');
    const report = db.getInterviewReportForRecording(recordingId) || null;
    return response(200, { ok: true, report }, { action: 'interview_recording_report_read', target: recordingId });
  }

  if (url.pathname === '/api/interview-recording/confirmations') {
    const recordingId = requiredPositiveInteger(url, 'recordingId');
    const report = db.getInterviewReportForRecording(recordingId);
    if (report && report.schema_version === 'interview_report_v1') {
      const confirmations = db.listInterviewReportFactReviewsForRecording(recordingId);
      return response(200, { ok: true, confirmation_source: 'interview_report_v1', confirmations }, {
        action: 'interview_confirmations_read', target: recordingId,
      });
    }
    const confirmations = db.listInterviewRecordingConfirmations(recordingId);
    return response(200, { ok: true, confirmations }, { action: 'interview_confirmations_read', target: recordingId });
  }

  if (url.pathname === '/api/interview-recording/transcript') {
    const recordingId = requiredPositiveInteger(url, 'recordingId');
    const recording = db.getInterviewRecording(recordingId, { access: 'transcript' });
    const transcript = safeTranscriptPayload(recording);
    return response(200, { ok: true, transcript }, { action: 'interview_transcript_read', target: recordingId });
  }

  if (url.pathname === '/api/interview-consent') {
    const candidateId = requiredText(url, 'candidateId');
    const jobId = requiredPositiveInteger(url, 'jobId');
    const consent = db.getInterviewConsent({ candidateId, jobId });
    const policy = db.getInterviewConsentPolicy();
    return response(200, { ok: true, consent, policy }, { action: 'interview_consent_read', target: `${candidateId}:${jobId}` });
  }

  if (url.pathname === '/api/interview-report') {
    const sessionId = requiredPositiveInteger(url, 'sessionId');
    const report = db.getInterviewReportV1({ sessionId });
    const facts = db.listInterviewReportFactReviews({ sessionId });
    return response(200, { ok: true, report, facts }, { action: 'interview_report_read', target: sessionId });
  }

  if (url.pathname === '/api/interview-script') {
    const jobId = requiredPositiveInteger(url, 'jobId');
    const script = db.getInterviewScript(jobId);
    if (script && script.stale_for_active_jd === true) {
      return response(409, {
        ok: false,
        code: 'INTERVIEW_SCRIPT_STALE_FOR_ACTIVE_JD',
        error: '已有面试脚本不属于当前 JD/画像，请基于当前已确认画像重新生成。',
      });
    }
    return response(200, { ok: true, script }, { action: 'interview_script_read', target: jobId });
  }

  if (url.pathname === '/api/assess/status') {
    const candidateId = requiredText(url, 'candidateId');
    const status = db.getAssessStatus(candidateId, llmRuntime.externalAiStatus());
    if (!status.candidate_found) return response(404, { ok: false, error: 'candidate not found', status });
    return response(200, { ok: true, status }, { action: 'candidate_assess_status_read', target: candidateId });
  }

  if (url.pathname === '/api/llm/config') return publicLlmConfig();

  return { handled: false };
}

module.exports = {
  OPERATIONAL_READONLY_EXACT_PATHS,
  projectOperationalReadonlyGet,
};
