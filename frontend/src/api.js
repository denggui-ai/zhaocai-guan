export const READONLY_UI = import.meta.env.VITE_READONLY_UI === '1';

const LOCAL_DATA_SERVICE_UNAVAILABLE_MESSAGE = '本地数据服务已停止，界面显示的是上次成功读取的数据。请退出并重新打开招才官；若仍然失败，请检查本机是否有残留的招才官进程。';
const LOCAL_DATA_SERVICE_UNAVAILABLE_PATTERN = /(?:\bECONNREFUSED\b|\bECONNRESET\b|\bEPIPE\b|socket hang up|Local API session is not ready|No handler registered for ['"]local-api:request|Error invoking remote method ['"]local-api:request)/i;

function userFacingLocalApiError(error) {
  const technicalDetails = String(error instanceof Error ? error.message : error || '').trim();
  if (!LOCAL_DATA_SERVICE_UNAVAILABLE_PATTERN.test(technicalDetails)) {
    return error instanceof Error ? error : new Error(technicalDetails || '本地数据服务请求失败');
  }
  const mapped = new Error(LOCAL_DATA_SERVICE_UNAVAILABLE_MESSAGE);
  mapped.code = 'LOCAL_DATA_SERVICE_UNAVAILABLE';
  mapped.technicalDetails = technicalDetails;
  return mapped;
}

async function localApiRequest(service, method, path, body, responseType = 'json') {
  if (!window.localApi || !window.localApi.request) {
    throw new Error('本地 API 安全代理不可用；请通过招才官桌面应用启动。');
  }
  let response;
  try {
    response = await window.localApi.request({ service, method, requestPath: path, body, responseType });
  } catch (error) {
    throw userFacingLocalApiError(error);
  }
  if (responseType === 'binary') {
    if (response.status < 200 || response.status >= 300) throw new Error('本地二进制资源读取失败');
    return response;
  }
  const data = response.body;
  if (!data || !data.ok) {
    const error = new Error((data && data.error) || path);
    error.code = data && data.code ? data.code : '';
    error.status = response.status;
    error.data = data || null;
    throw error;
  }
  return data;
}

async function get(path) {
  return localApiRequest('readonly', 'GET', path);
}

async function getLocalPaths() {
  if (typeof window.settingsState?.getLocalPaths !== 'function') {
    throw new Error('本机目录安全桥接不可用；请通过招才官桌面应用启动。');
  }
  const result = await window.settingsState.getLocalPaths();
  const keys = ['dataDir', 'databasePath', 'interviewDir', 'screenshotDir'];
  if (result?.ok !== true || !keys.every((key) => typeof result.paths?.[key] === 'string' && result.paths[key].trim())) {
    throw new Error('本机目录信息不可读，请退出并重新打开桌面应用。');
  }
  return Object.fromEntries(keys.map((key) => [key, result.paths[key]]));
}

async function actionGet(path) {
  if (READONLY_UI) throw new Error('只读 UI 模式已禁用动作接口');
  return localApiRequest('action', 'GET', path);
}

const OPERATIONAL_READONLY_GET_EXACT_PATHS = new Set([
  '/assessment/status',
  '/assessment/archive',
  '/assessment/queue',
  '/assessment/ai-analysis',
  '/assess/status',
  '/profile',
  '/candidate-journey-operations',
  '/interview/import-lark/status',
  '/interview',
  '/interview-session',
  '/interview-recording',
  '/interview-script',
  '/interview-assignment',
  '/interview-report',
  '/interview-lifecycle/status',
  '/interview-recording/report',
  '/interview-recording/confirmations',
  '/interview-recording/transcript',
  '/interview-consent',
  '/llm/config',
]);

async function operationalReadGet(path) {
  const pathname = new URL(path, 'http://hrboss.local').pathname;
  if (!OPERATIONAL_READONLY_GET_EXACT_PATHS.has(pathname)) {
    const error = new Error(`操作只读查询未在精确允许列表中：${pathname}`);
    error.code = 'OPERATIONAL_READONLY_ROUTE_NOT_ALLOWED';
    throw error;
  }
  return READONLY_UI
    ? localApiRequest('readonly', 'GET', path)
    : localApiRequest('action', 'GET', path);
}

async function actionPost(path, body) {
  if (READONLY_UI) throw new Error('只读 UI 模式已禁用动作接口');
  return localApiRequest('action', 'POST', path, body || {});
}

async function configureLlmCredential(body) {
  if (READONLY_UI) throw new Error('只读 UI 模式已禁用 AI 配置');
  if (!window.llmCredential || typeof window.llmCredential.configure !== 'function') {
    throw new Error('AI 凭据安全桥接不可用；请通过招才官桌面应用启动。');
  }
  const response = await window.llmCredential.configure(body || {});
  const data = response && response.body ? response.body : response;
  if (!data || !data.ok) throw new Error((data && data.error) || 'AI 凭据配置失败');
  return data;
}

async function refreshLlmModels() {
  if (READONLY_UI) throw new Error('只读 UI 模式已禁用 AI 配置');
  if (!window.llmCredential || typeof window.llmCredential.refreshModels !== 'function') {
    throw new Error('AI 凭据安全桥接不可用；请通过招才官桌面应用启动。');
  }
  const response = await window.llmCredential.refreshModels();
  const data = response && response.body ? response.body : response;
  if (!data || !data.ok) throw new Error((data && data.error) || '模型列表刷新失败');
  return data;
}

async function testLlmModel(model) {
  if (READONLY_UI) throw new Error('只读 UI 模式已禁用 AI 配置');
  if (!window.llmCredential || typeof window.llmCredential.testModel !== 'function') {
    throw new Error('AI 模型测试安全桥接不可用；请通过招才官桌面应用启动。');
  }
  const response = await window.llmCredential.testModel({ model });
  const data = response && response.body ? response.body : response;
  if (!data || !data.ok) {
    const error = new Error((data && data.error) || '模型兼容性测试失败');
    error.code = data && data.code ? data.code : '';
    throw error;
  }
  return data;
}

async function confirmLlmApproval(preview) {
  if (READONLY_UI) throw new Error('只读 UI 模式已禁用外部 AI');
  if (!window.llmApproval || typeof window.llmApproval.confirm !== 'function') {
    throw new Error('AI 一次性授权桥接不可用；请通过招才官桌面应用启动。');
  }
  const response = await window.llmApproval.confirm(preview);
  if (!response || response.ok !== true) throw new Error((response && response.error) || 'AI 一次性授权失败');
  return response;
}

async function confirmExternalAiApproval(purpose, targetId, requestId, materialInput = {}) {
  if (READONLY_UI) throw new Error('只读 UI 模式已禁用外部 AI');
  if (!window.externalAiApproval || typeof window.externalAiApproval.confirm !== 'function') {
    throw new Error('外部 AI 原生确认桥接不可用；请通过招才官桌面应用启动。');
  }
  const response = await window.externalAiApproval.confirm({ purpose, targetId, requestId, materialInput });
  if (!response || response.ok !== true) throw new Error((response && response.error) || '外部 AI 原生确认失败');
  return response;
}

export async function actionRequest(method, path, body) {
  return method === 'GET' ? actionGet(path) : actionPost(path, body);
}

export async function candidateScreenshotUrl(id) {
  const response = await localApiRequest('readonly', 'GET', `/candidates/${encodeURIComponent(id)}/screenshot`, null, 'binary');
  return URL.createObjectURL(new Blob([response.body], { type: response.contentType }));
}

export async function screenshotOcrDraftPreviewUrl(id) {
  if (READONLY_UI) throw new Error('操作只读模式不读取 OCR 草稿原图');
  const response = await localApiRequest(
    'action',
    'GET',
    `/screenshot-ocr-drafts/${encodeURIComponent(id)}/preview`,
    null,
    'binary',
  );
  if (response.status < 200 || response.status >= 300) throw new Error('OCR 草稿原图读取失败');
  return URL.createObjectURL(new Blob([response.body], { type: response.contentType || 'image/png' }));
}

async function approveScreenshotImportRetry(runId, itemIds) {
  if (READONLY_UI) throw new Error('只读 UI 模式已禁用截图重试');
  if (!window.screenshotImport || typeof window.screenshotImport.approveRetry !== 'function') {
    throw new Error('截图重试原生确认桥接不可用；请通过招才官桌面应用启动。');
  }
  const response = await window.screenshotImport.approveRetry({
    run_id: runId,
    item_ids: itemIds,
  });
  if (!response || response.ok === false) throw new Error((response && response.error) || '截图重试确认失败');
  return response;
}

async function approveScreenshotOcrAiFill(jobId) {
  if (READONLY_UI) throw new Error('只读 UI 模式已禁用 OCR 草稿 AI 补全');
  if (!window.screenshotImport || typeof window.screenshotImport.approveAiFill !== 'function') {
    throw new Error('OCR 草稿 AI 补全确认桥接不可用；请通过招才官桌面应用启动。');
  }
  const response = await window.screenshotImport.approveAiFill({ job_id: jobId });
  if (!response || response.ok === false) throw new Error((response && response.error) || 'OCR 草稿 AI 补全确认失败');
  return response;
}

export async function assessmentPreviewUrl(previewId, page) {
  if (READONLY_UI) throw new Error('操作只读模式不生成或读取动态测评预览');
  const response = await localApiRequest(
    'action',
    'GET',
    `/assessment/preview/${encodeURIComponent(previewId)}/page/${encodeURIComponent(page)}`,
    null,
    'binary',
  );
  if (response.status < 200 || response.status >= 300) throw new Error('PDF 测评栅格预览读取失败');
  return URL.createObjectURL(new Blob([response.body], { type: 'image/png' }));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeConfirmationStatus(status) {
  return status === 'discarded' ? 'rejected' : status;
}

function normalizeConfirmationItems(items) {
  return (items || []).map((item) => ({
    recording_id: item.recording_id || item.recordingId,
    field_key: item.field_key || item.fieldKey || item.id || item.key,
    field_label: item.field_label || item.fieldLabel || item.label || item.title || item.name,
    extracted_value: item.extracted_value ?? item.extractedValue ?? item.value ?? item.default_value ?? item.defaultValue,
    corrected_value: item.corrected_value ?? item.correctedValue ?? item.correction,
    status: normalizeConfirmationStatus(item.status || 'pending'),
    evidence: item.evidence || item.source_text || item.sourceText || item.quote,
    note: item.note || item.notes || item.remark || item.comment,
  }));
}

export const api = {
  getLocalPaths,
  getF018Status: () => actionGet('/f018/status'),
  getF018State: (candidateId, jobId) => actionGet(`/f018/final-review?candidateId=${encodeURIComponent(candidateId)}&jobId=${encodeURIComponent(jobId)}`),
  openF018Application: (input) => actionPost('/f018/application/open', input),
  transitionF018Application: (action, input) => actionPost(`/f018/application/${action}`, input),
  createF018FinalReview: (input) => actionPost('/f018/final-review/draft', input),
  updateF018FinalReview: (input) => actionPost('/f018/final-review/update', input),
  confirmF018FinalReview: (input) => actionPost('/f018/final-review/confirm', input),
  reopenF018FinalReview: (input) => actionPost('/f018/final-review/reopen', input),
  recordF018Disposition: (input) => actionPost('/f018/disposition', input),
  importResumeAttachment: async (candidateId, jobId) => {
    if (READONLY_UI) throw new Error('只读 UI 模式已禁用手动上传简历');
    if (!window.resumeAttachment || typeof window.resumeAttachment.selectAndImport !== 'function') {
      throw new Error('本地简历原生文件选择桥接不可用；请通过桌面应用启动。');
    }
    const response = await window.resumeAttachment.selectAndImport({
      candidate_id: candidateId,
      job_id: jobId,
    });
    if (!response || response.ok !== true) throw new Error((response && response.error) || '手动上传简历失败');
    return response;
  },
  prepareCandidateFromResume: async (jobId) => {
    if (READONLY_UI) throw new Error('只读 UI 模式已禁用简历建档');
    if (!window.resumeAttachment || typeof window.resumeAttachment.selectCandidateDraft !== 'function') {
      throw new Error('本地简历建档桥接不可用；请通过桌面应用启动。');
    }
    const response = await window.resumeAttachment.selectCandidateDraft({ job_id: jobId });
    if (!response || response.ok !== true) throw new Error((response && response.error) || '简历建档预处理失败');
    return response;
  },
  commitCandidateFromResume: (input) => actionPost('/candidate/resume-intake/commit', input),
  getAssessmentStatus: () => operationalReadGet('/assessment/status'),
  listAssessmentArchives: (candidateId, jobId) => operationalReadGet(`/assessment/archive?candidateId=${encodeURIComponent(candidateId)}&jobId=${encodeURIComponent(jobId)}`),
  listAssessmentQueue: (jobId) => operationalReadGet(`/assessment/queue?jobId=${encodeURIComponent(jobId)}`),
  listAssessmentAiAnalyses: (candidateId, jobId) => operationalReadGet(`/assessment/ai-analysis?candidateId=${encodeURIComponent(candidateId)}&jobId=${encodeURIComponent(jobId)}`),
  generateAssessmentAiAnalysis: (candidateId, jobId, approval = {}) => actionPost('/assessment/ai-analysis/generate', {
    candidate_id: candidateId,
    job_id: jobId,
    request_id: approval.requestId,
    userApproval: approval.userApproval,
  }),
  importAssessmentPdf: async (input) => {
    if (READONLY_UI) throw new Error('只读 UI 模式已禁用 PDF 测评存档');
    if (!window.assessmentArchive || typeof window.assessmentArchive.selectAndImport !== 'function') {
      throw new Error('PDF 测评原生文件选择桥接不可用；请通过招才官桌面应用启动。');
    }
    const response = await window.assessmentArchive.selectAndImport(input || {});
    if (!response || response.ok !== true) throw new Error((response && response.error) || 'PDF 测评导入失败');
    return response;
  },
  watchAssessmentImportProgress: (callback) => {
    if (!window.assessmentArchive || typeof window.assessmentArchive.onImportProgress !== 'function') return () => {};
    return window.assessmentArchive.onImportProgress(callback);
  },
  confirmAssessmentBinding: (bindingId, expectedVersion, requestId, candidateId, jobId, options = {}) => actionPost('/assessment/binding/confirm', {
    binding_id: bindingId,
    expected_version: expectedVersion,
    request_id: requestId,
    candidate_id: candidateId,
    job_id: jobId,
    identity_mismatch_acknowledged: options.identityMismatchAcknowledged === true,
    reason_code: options.identityMismatchAcknowledged === true
      ? 'manual_identity_mismatch_confirmed'
      : 'manual_archive_confirmed',
  }),
  confirmAssessmentMetadata: (archive, reportType, requestId) => actionPost('/assessment/metadata/confirm', {
    binding_id: archive.binding_id,
    document_id: archive.document_id,
    candidate_id: archive.candidate_id,
    job_id: archive.job_id,
    report_type: reportType,
    assessment_date: archive.assessment_date || null,
    expected_version: archive.document_version,
    request_id: requestId,
  }),
  revokeAssessmentBinding: (bindingId, expectedVersion, requestId, candidateId, jobId) => actionPost('/assessment/binding/revoke', {
    binding_id: bindingId,
    expected_version: expectedVersion,
    request_id: requestId,
    candidate_id: candidateId,
    job_id: jobId,
    reason_code: 'manual_archive_revoked',
  }),
  requestAssessmentDeletion: (archive, requestId, effectiveAt) => actionPost('/assessment/deletion/request', {
    document_id: archive.document_id,
    candidate_id: archive.candidate_id,
    job_id: archive.job_id,
    expected_version: archive.document_version,
    request_id: requestId,
    reason_code: 'retention_due',
    policy_version: archive.retention_policy_version,
    effective_at: effectiveAt,
  }),
  confirmAssessmentDeletion: (archive, expectedVersion, requestId, effectiveAt) => actionPost('/assessment/deletion/confirm', {
    document_id: archive.document_id,
    candidate_id: archive.candidate_id,
    job_id: archive.job_id,
    expected_version: expectedVersion,
    request_id: requestId,
    reason_code: archive.deletion_reason_code || 'retention_due',
    policy_version: archive.deletion_policy_version || archive.retention_policy_version,
    effective_at: archive.deletion_effective_at || effectiveAt,
    physical_delete_confirmed: true,
  }),
  resolveAssessmentDuplicate: (documentId, candidateId, jobId, requestId, options = {}) => actionPost('/assessment/duplicate/resolve', {
    document_id: documentId,
    candidate_id: candidateId,
    job_id: jobId,
    request_id: requestId,
    confirmed: true,
    identity_mismatch_acknowledged: options.identityMismatchAcknowledged === true,
  }),
  createAssessmentPreview: (archive, requestId) => actionPost('/assessment/preview', {
    binding_id: archive.binding_id,
    document_id: archive.document_id,
    candidate_id: archive.candidate_id,
    job_id: archive.job_id,
    request_id: requestId,
  }),
  listJobs: () => get('/jobs'),
  listEcommerceJobTemplates: () => actionGet('/job-templates/ecommerce'),
  createLocalJob: (input) => actionPost('/jobs', input),
  createJobFromTemplate: (input) => actionPost('/jobs/from-template', input),
  updateJobDetails: (jobId, input) => actionPost(`/jobs/${encodeURIComponent(jobId)}/details`, input),
  copyJob: (jobId, input = {}) => actionPost(
    `/jobs/${encodeURIComponent(jobId)}/copy`,
    typeof input === 'string' ? { name: input } : input,
  ),
  updateJobStatus: (jobId, status, options = {}) => actionPost(`/jobs/${encodeURIComponent(jobId)}/status`, {
    status,
    close_reason_code: options.closeReason || options.close_reason_code,
    close_note: options.closeNote || options.close_note,
  }),
  latestRun: (type) => get(`/run/latest${type ? `?type=${encodeURIComponent(type)}` : ''}`),
  listTalentPool: (jobId, options = {}) => {
    const params = new URLSearchParams();
    if (jobId) params.set('jobId', jobId);
    if (options.fixture || options.demo) params.set('fixture', '1');
    const query = params.toString();
    return get(`/talent-pool${query ? `?${query}` : ''}`);
  },
  addTalentToJob: (sourceCandidateId, jobId) => actionPost('/talent-pool/add-to-job', {
    source_candidate_id: sourceCandidateId,
    job_id: jobId,
  }),
  listCandidates: (jobId) => get(`/candidates?jobId=${jobId}`),
  getWorkbench: (jobId) => get(`/workbench?jobId=${encodeURIComponent(jobId)}`),
  getCandidateTimeline: (candidateId) => get(`/candidate-timeline?candidateId=${encodeURIComponent(candidateId)}`),
  getCandidateJourneyOperations: (candidateId, jobId) => operationalReadGet(`/candidate-journey-operations?candidateId=${encodeURIComponent(candidateId)}&jobId=${encodeURIComponent(jobId)}`),
  setCandidateNextAction: (input) => actionPost('/candidate-journey/next-action', input),
  recordHiringManagerFeedback: (input) => actionPost('/candidate-journey/manager-feedback', input),
  setCandidateOfferStatus: (input) => actionPost('/candidate-journey/offer-status', input),
  getCandidate: (id) => get(`/candidates/${encodeURIComponent(id)}`),
  getChildren: (id) => get(`/candidates/${encodeURIComponent(id)}/children`),
  getWriteActions: (id) => get(`/candidates/${encodeURIComponent(id)}/write-actions`),
  createJobJdVersion: (jobId, jdText, source = 'manual') => actionPost('/job-jd-version', { jobId, jdText, source }),
  activateJobJdVersion: (jdVersionId, expectedVersion) => actionPost('/job-jd-version/activate', { jdVersionId, expectedVersion }),
  optimizeJobJd: (jobId, brief, currentJd, approval = {}) => actionPost('/job-jd/optimize', {
    jobId,
    brief,
    currentJd,
    requestId: approval.requestId,
    userApproval: approval.userApproval,
  }),
  createJobProfileVersion: (jobId, config, jdVersionId, sourceKind = 'manual') => actionPost('/job-profile-version', { jobId, config, jdVersionId, sourceKind }),
  confirmJobProfileVersion: (profileVersionId, expectedVersion) => actionPost('/job-profile-version/confirm', { profileVersionId, expectedVersion }),
  changeCandidateStatus: (candidateId, layer, code, reason = '', source = 'manual') => actionPost('/candidate-status', { candidateId, layer, code, reason, source }),
  applyManualCandidateAction: (candidateId, jobId, action, reason = '', requestId = '') => actionPost('/candidate-status', {
    candidateId,
    jobId,
    layer: 'disposition',
    action,
    reason,
    requestId,
    source: 'manual',
  }),
  createInterviewSession: ({ candidateId, jobId, interviewFormat, mode }) => actionPost('/interview-session', {
    candidateId,
    jobId,
    interviewFormat: interviewFormat || mode,
  }),
  getInterviewManualNote: (sessionId) => operationalReadGet(`/interview-session/manual-note?sessionId=${encodeURIComponent(sessionId)}`),
  saveInterviewManualNote: (sessionId, body, expectedVersion) => actionPost('/interview-session/manual-note', {
    sessionId,
    body,
    expectedVersion,
  }),
  revokeInterviewManualNote: (sessionId, expectedVersion) => actionPost('/interview-session/manual-note/revoke', {
    sessionId,
    expectedVersion,
    confirmed: true,
  }),
  confirmInterviewSchedule: (sessionId, scheduledAt, requestId, logistics = undefined) => actionPost('/interview-session/schedule', {
    sessionId,
    scheduledAt,
    confirmed: true,
    requestId,
    ...(logistics === undefined ? {} : { logistics }),
  }),
  listInterviewers: (includeInactive = false) => actionGet(`/interviewers${includeInactive ? '?includeInactive=1' : ''}`),
  saveInterviewInterviewer: (input) => actionPost('/interviewers', { ...(input || {}), confirmed: true }),
  markInterviewInvitationSent: (sessionId) => actionPost('/interview-session/invitation-sent', { sessionId, confirmed: true }),
  recordInterviewCandidateConfirmation: (sessionId, status) => actionPost('/interview-session/candidate-confirmation', {
    sessionId,
    status,
    confirmed: true,
  }),
  getInterviewLifecycleStatus: (sessionId) => operationalReadGet(`/interview-lifecycle/status?sessionId=${encodeURIComponent(sessionId)}`),
  withdrawInterviewLifecycle: (sessionId, reasonCode) => actionPost('/interview-lifecycle/withdraw', {
    sessionId,
    reasonCode,
    confirmed: true,
  }),
  closeInterviewLifecycle: (sessionId, reasonCode) => actionPost('/interview-lifecycle/close', {
    sessionId,
    reasonCode,
    confirmed: true,
  }),
  applyInterviewLegalHold: (sessionId, reasonCode, expiresAt) => actionPost('/interview-lifecycle/legal-hold/apply', {
    sessionId,
    reasonCode,
    expiresAt,
  }),
  releaseInterviewLegalHold: (holdId, reasonCode) => actionPost('/interview-lifecycle/legal-hold/release', {
    holdId,
    reasonCode,
    confirmed: true,
  }),
  previewInterviewDeletion: (sessionId) => actionPost('/interview-lifecycle/deletion/dry-run', { sessionId }),
  confirmInterviewDeletion: (manifestId, confirmationToken, reasonCode) => actionPost('/interview-lifecycle/deletion/confirm', {
    manifestId,
    confirmationToken,
    reasonCode,
    confirmed: true,
  }),

  listCandidateInterviewRecordings: (candidateId, jobId) => {
    const params = new URLSearchParams();
    if (candidateId) params.set('candidateId', candidateId);
    if (jobId) params.set('jobId', jobId);
    return operationalReadGet(`/interview-recording?${params.toString()}`);
  },
  listUnmatchedInterviewRecordings: (jobId) => {
    const params = new URLSearchParams({ unmatched: '1' });
    if (jobId) params.set('jobId', jobId);
    return operationalReadGet(`/interview-recording?${params.toString()}`);
  },
  selectInterviewRecordingSummary: async () => {
    if (READONLY_UI) throw new Error('只读 UI 模式已禁用面试录音摘要导入');
    if (!window.localInterview || typeof window.localInterview.selectSummaryFile !== 'function') {
      throw new Error('面试录音摘要原生文件选择桥接不可用；请通过招才官桌面应用启动。');
    }
    const response = await window.localInterview.selectSummaryFile();
    if (!response || response.ok !== true) throw new Error((response && response.error) || '选择面试录音摘要失败');
    return response;
  },
  importInterviewRecordingSummary: (summaryPath) => actionPost('/interview-recording/import-summary', { summaryPath }),
  bindInterviewRecording: (id, candidateId, jobId) => actionPost('/interview-recording/bind', { id, candidateId, jobId }),
  saveInterviewAiReport: (recordingId, report, expectedVersion, requestId) => actionPost('/interview-recording/report', {
    recordingId,
    report,
    expectedVersion,
    requestId,
  }),
  getInterviewAiReport: (recordingId) => operationalReadGet(`/interview-recording/report?recordingId=${encodeURIComponent(recordingId)}`),
  getInterviewTranscript: (recordingId) => operationalReadGet(`/interview-recording/transcript?recordingId=${encodeURIComponent(recordingId)}`),
  getInterviewConfirmations: (recordingId) => operationalReadGet(`/interview-recording/confirmations?recordingId=${encodeURIComponent(recordingId)}`),
  saveInterviewConfirmations: (recordingId, items, expectedVersion, requestId) => actionPost('/interview-recording/confirmations', {
    recordingId,
    items: normalizeConfirmationItems(items),
    expectedVersion,
    requestId,
  }),
  confirmInterviewRecording: (id, expectedVersion, requestId) => actionPost('/interview-recording/confirm', {
    id,
    confirmed: true,
    expectedVersion,
    requestId,
  }),
  listInterviewSessions: (candidateId, jobId) => {
    const params = new URLSearchParams();
    if (candidateId) params.set('candidateId', candidateId);
    if (jobId) params.set('jobId', jobId);
    return operationalReadGet(`/interview-session?${params.toString()}`);
  },
  listInterviewAssignments: (jobId, status = null) => {
    const params = new URLSearchParams();
    if (jobId) params.set('jobId', jobId);
    if (status) params.set('status', status);
    return operationalReadGet(`/interview-assignment?${params.toString()}`);
  },
  classifyInterviewAssignment: (pendingAssignmentId, purpose, expectedVersion, reason, requestId) => actionPost('/interview-assignment/classify', {
    pendingAssignmentId,
    purpose,
    expectedVersion,
    reason,
    requestId,
  }),
  assignInterviewMaterial: (pendingAssignmentId, candidateId, jobId, round, expectedVersion, reason, requestId) => actionPost('/interview-assignment/assign', {
    pendingAssignmentId,
    candidateId,
    jobId,
    round,
    expectedVersion,
    reason,
    requestId,
  }),
  getInterviewScript: (jobId) => operationalReadGet(`/interview-script?jobId=${encodeURIComponent(jobId)}`),
  generateInterviewScript: (jobId) => actionPost('/interview-script/generate', { jobId }),
  saveInterviewScript: (jobId, script, scriptText, status = 'draft') => actionPost('/interview-script', { jobId, script, scriptText, status }),
  getInterviewConsent: (candidateId, jobId) => operationalReadGet(`/interview-consent?candidateId=${encodeURIComponent(candidateId)}&jobId=${encodeURIComponent(jobId)}`),
  saveInterviewConsent: (candidateId, jobId, confirmed, requestId = '') => actionPost('/interview-consent', {
    candidateId,
    jobId,
    confirmed: confirmed === true,
    requestId,
  }),

  getInterviewReport: (sessionId) => operationalReadGet(`/interview-report?sessionId=${encodeURIComponent(sessionId)}`),
  saveInterviewReport: (sessionId, report, expectedVersion, requestId, sourceMaterialIds = undefined) => actionPost('/interview-report', {
    sessionId,
    report,
    expectedVersion,
    requestId,
    ...(Array.isArray(sourceMaterialIds) ? { sourceMaterialIds } : {}),
  }),
  saveStructuredManualInterviewReport: (sessionId, materialIds, form, expectedVersion, requestId) => actionPost('/interview-report/manual', {
    sessionId,
    materialIds,
    form,
    expectedVersion,
    requestId,
  }),
  reviewInterviewReportFacts: (sessionId, items, expectedVersion, requestId) => actionPost('/interview-report/facts', {
    sessionId,
    items: normalizeConfirmationItems(items),
    expectedVersion,
    requestId,
  }),
  confirmInterviewReport: (sessionId, expectedVersion, requestId) => actionPost('/interview-report/confirm', {
    sessionId,
    confirmed: true,
    expectedVersion,
    requestId,
  }),

  getLlmConfig: () => operationalReadGet('/llm/config'),
  saveLlmConfig: (config) => configureLlmCredential(config),
  saveLlmCredential: (config) => configureLlmCredential(config),
  refreshLlmModels: () => refreshLlmModels(),
  testLlmModel: (model) => testLlmModel(model),
  previewInterviewLlm: (sessionId, materialIds, requestId) => actionPost('/interview-report/llm/preview', {
    sessionId,
    ...(Array.isArray(materialIds) && materialIds.length ? { materialIds } : {}),
    requestId,
  }),
  confirmInterviewLlmApproval: (preview) => confirmLlmApproval({ ...preview, userConfirmed: true }),
  analyzeInterviewLlm: ({ sessionId, materialIds, requestHash, expectedVersion, requestId, userApproval }) => actionPost('/interview-report/llm/analyze', {
    sessionId,
    ...(Array.isArray(materialIds) && materialIds.length ? { materialIds } : {}),
    requestHash,
    userApproval,
    expectedVersion,
    requestId,
  }),
  cancelInterviewLlm: (requestId) => actionPost('/interview-report/llm/cancel', {
    requestId,
  }),

  getProfile: (jobId) => operationalReadGet(`/profile?jobId=${jobId}`),
  saveProfile: (jobId, config) => actionPost('/profile', { jobId, config }),

  listInterviews: (jobId) => operationalReadGet(`/interview?jobId=${jobId}`),
  getLarkImportStatus: () => operationalReadGet('/interview/import-lark/status'),
  saveInterview: (jobId, transcript, sourceUrl, note) => actionPost('/interview', { jobId, transcript, sourceUrl, note }),
  localInterviewDoctor: () => actionGet('/local-interview/doctor'),
  localInterviewProgress: () => actionGet('/local-interview/progress'),
  localInterviewMicCheck: (
    topic,
    duration = 8,
    candidateId = null,
    jobId = null,
    micCheckConsentConfirmed = false,
    round = null,
    clientRequestId = null,
  ) => actionPost('/local-interview/mic-check', {
    topic,
    duration,
    candidateId,
    jobId,
    micCheckConsentConfirmed,
    round,
    clientRequestId,
  }),
  startLocalInterviewRecord: (topic, duration = null, candidateId = null, jobId = null, round = null) => actionPost('/local-interview/record/start', {
    topic,
    duration,
    candidateId,
    jobId,
    round,
  }),
  stopLocalInterviewRecord: (
    taskId,
    candidateId = null,
    jobId = null,
    round = null,
  ) => actionPost('/local-interview/record/stop', {
    taskId,
    candidateId,
    jobId,
    round,
  }),
  retryLocalInterviewTranscription: (
    taskId,
    candidateId,
    jobId,
    round,
  ) => actionPost('/local-interview/transcription/retry', {
    taskId,
    candidateId,
    jobId,
    round,
  }),
  abortLocalInterviewTask: (taskId, jobId = null) => actionPost('/local-interview/abort', {
    taskId,
    jobId,
  }),
  importLocalInterviewFile: (filePath, topic, candidateId = null, jobId = null, materialConsentConfirmed = false, round = null) => actionPost('/local-interview/from-file', {
    filePath,
    topic,
    candidateId,
    jobId,
    round,
    materialConsentConfirmed: materialConsentConfirmed === true,
  }),

  confirmExternalAiApproval,
  generateDeepProfile: (jobId, approval = {}) => actionPost('/deep-profile/generate', {
    jobId,
    requestId: approval.requestId,
    userApproval: approval.userApproval,
  }),
  deepProfileProgress: (jobId) => actionGet(`/deep-profile/progress?jobId=${jobId}`),
  confirmDeepProfile: (jobId) => actionPost('/deep-profile/confirm', { jobId }),

  assessStatus: (candidateId) => operationalReadGet(`/assess/status?candidateId=${encodeURIComponent(candidateId)}`),
  assess: (candidateId, approval = {}) => actionPost('/assess', {
    candidateId,
    requestId: approval.requestId,
    userApproval: approval.userApproval,
  }),
  assessLocalDemo: (candidateId) => actionPost('/assess/local-demo', { candidateId }),

  startRate: (jobId) => actionPost('/rate', { jobId }),
  rateProgress: (jobId) => actionGet(`/rate/progress?jobId=${jobId}`),

  importScreenshots: (dir, approval = {}) => actionPost('/screenshot-import/start', {
    dir,
    ...(approval.requestId ? { requestId: approval.requestId } : {}),
    ...(approval.userApproval ? { userApproval: approval.userApproval } : {}),
  }),
  screenshotImportProgress: () => actionGet('/screenshot-import/progress'),
  screenshotImportTask: (runId = '') => actionGet(`/screenshot-import/task${runId ? `?run_id=${encodeURIComponent(runId)}` : ''}`),
  screenshotImportRetryPreflight: (runId, itemIds, requestId) => actionPost('/screenshot-import/retry-preflight', {
    run_id: runId,
    ...(itemIds && itemIds.length ? { item_ids: itemIds } : {}),
    requestId,
  }),
  approveScreenshotImportRetry,
  retryScreenshotImportItems: (runId, itemIds, approval = {}) => actionPost('/screenshot-import/retry', {
    run_id: runId,
    ...(itemIds && itemIds.length ? { item_ids: itemIds } : {}),
    requestId: approval.requestId,
    userApproval: approval.userApproval,
  }),
  approveScreenshotOcrAiFill,
  listScreenshotOcrDrafts: (status = 'pending_review', jobId = '') => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (jobId) params.set('jobId', jobId);
    return actionGet(`/screenshot-ocr-drafts?${params.toString()}`);
  },
  getScreenshotOcrDraftAudit: (id) => actionGet(`/screenshot-ocr-drafts/${encodeURIComponent(id)}/audit`),
  editScreenshotOcrDraft: (id, changes) => actionPost(`/screenshot-ocr-drafts/${encodeURIComponent(id)}/edit`, { changes }),
  confirmScreenshotOcrDraft: (id, confirmation = {}) => actionPost(`/screenshot-ocr-drafts/${encodeURIComponent(id)}/confirm`, {
    name_verified_by_hr: confirmation.name_verified_by_hr === true,
  }),
  rejectScreenshotOcrDraft: (id) => actionPost(`/screenshot-ocr-drafts/${encodeURIComponent(id)}/reject`, {}),
  aiFillScreenshotOcrDrafts: (jobId, approval = {}) => actionPost('/screenshot-ocr-drafts/ai-fill', {
    job_id: jobId,
    requestId: approval.requestId,
    userApproval: approval.userApproval,
  }),
};

export const clean = (value) => (value == null ? '' : String(value).trim());
export const has = (value) => clean(value) !== '';

export function fmtTime(value) {
  if (!has(value)) return '未知时间';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? clean(value) : date.toLocaleString('zh-CN');
}

export function recLabel(raw) {
  const text = clean(raw);
  const match = text.match(/index=(\d+)/);
  return match ? `推荐·第${match[1]}位` : '';
}

export function joinParts(parts) {
  return parts.filter(has).join(' · ');
}

export function parseSections(row) {
  try {
    return row && row.sections_json ? JSON.parse(row.sections_json) : null;
  } catch {
    return null;
  }
}

export function soReport(row) {
  try {
    return JSON.parse(row.report_json);
  } catch {
    return null;
  }
}

export const FU_KIND = { gap: '没聊到', conflict: '前后矛盾', vague: '太模糊' };
