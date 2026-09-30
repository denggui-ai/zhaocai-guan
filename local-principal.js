// F-013 minimal local authorization boundary.
// The renderer can request actions through the authenticated localhost bridge, but it
// never gets to select the audit actor or role. Multi-user login/IdP is intentionally
// outside the single-operator desktop scope.
const LOCAL_PRINCIPAL = Object.freeze({
  actor_id: 'local-primary-operator',
  role: 'hr_admin',
});

const ROLE_CAPABILITIES = Object.freeze({
  hr_admin: Object.freeze([
    'service.health',
    'recruiting.read',
    'recruiting.write',
    'interview.read',
    'interview.write',
    'interview.lifecycle',
    'assessment.archive',
    'final_review.manage',
    'external_ai.configure',
    'external_ai.execute',
  ]),
});

const EXACT_ROUTE_CAPABILITIES = new Map();

function register(capability, method, paths) {
  for (const pathname of paths) EXACT_ROUTE_CAPABILITIES.set(`${method} ${pathname}`, capability);
}

register('service.health', 'GET', ['/api/health']);
register('recruiting.read', 'GET', [
  '/api/profile', '/api/assess/status', '/api/deep-profile/progress', '/api/rate/progress',
  '/api/screenshot-ocr-drafts', '/api/screenshot-import/progress', '/api/screenshot-import/task',
  '/api/job-templates/ecommerce',
  '/api/candidate-journey-operations',
]);
register('recruiting.write', 'POST', [
  '/api/jobs', '/api/jobs/from-template',
  '/api/talent-pool/add-to-job',
  '/api/job-jd-version', '/api/job-jd-version/activate', '/api/job-profile-version',
  '/api/job-profile-version/confirm', '/api/candidate-status', '/api/deep-profile/confirm',
  '/api/assess/local-demo', '/api/rate', '/api/screenshot-import/start',
  '/api/screenshot-ocr-drafts/ai-fill',
  '/api/candidate/resume-attachment/import',
  '/api/candidate/resume-intake/preview', '/api/candidate/resume-intake/commit',
  '/api/candidate-journey/next-action',
  '/api/candidate-journey/manager-feedback',
  '/api/candidate-journey/offer-status',
]);
register('interview.read', 'GET', [
  '/api/interview-lifecycle/status', '/api/interview/import-lark/status', '/api/interview',
  '/api/interview-session', '/api/interview-session/manual-note',
  '/api/interviewers', '/api/interview-assignment', '/api/interview-assignment/audit',
  '/api/local-interview/doctor', '/api/local-interview/progress', '/api/interview-consent',
  '/api/interview-recording', '/api/interview-recording/report', '/api/interview-recording/transcript',
  '/api/interview-recording/confirmations', '/api/interview-report', '/api/interview-script',
]);
register('interview.write', 'POST', [
  '/api/interview-session', '/api/interview-session/manual-note', '/api/interview-session/manual-note/revoke',
  '/api/interview-session/schedule',
  '/api/interview-session/invitation-sent', '/api/interview-session/candidate-confirmation',
  '/api/interviewers', '/api/interview', '/api/interview/import-lark',
  '/api/interview-assignment/classify', '/api/interview-assignment/assign', '/api/interview-consent',
  '/api/local-interview/record/start', '/api/local-interview/mic-check',
  '/api/local-interview/record/stop', '/api/local-interview/transcription/retry', '/api/local-interview/abort',
  '/api/local-interview/from-file', '/api/interview-recording/import-summary', '/api/interview-recording/bind',
  '/api/interview-recording/report', '/api/interview-report', '/api/interview-report/manual', '/api/interview-report/facts',
  '/api/interview-report/confirm', '/api/interview-report/reject', '/api/interview-recording/confirmations',
  '/api/interview-recording/confirm', '/api/interview-recording/report/reject',
  '/api/interview-script/generate', '/api/interview-script',
]);
register('interview.lifecycle', 'POST', [
  '/api/interview-lifecycle/withdraw', '/api/interview-lifecycle/close',
  '/api/interview-lifecycle/legal-hold/apply', '/api/interview-lifecycle/legal-hold/release',
  '/api/interview-lifecycle/deletion/dry-run', '/api/interview-lifecycle/deletion/confirm',
]);
register('assessment.archive', 'GET', [
  '/api/assessment/status', '/api/assessment/archive', '/api/assessment/queue',
  '/api/assessment/ai-analysis',
]);
register('assessment.archive', 'POST', [
  '/api/assessment/import', '/api/assessment/binding/confirm',
  '/api/assessment/metadata/confirm', '/api/assessment/binding/revoke',
  '/api/assessment/duplicate/resolve', '/api/assessment/preview',
  '/api/assessment/deletion/request', '/api/assessment/deletion/confirm',
]);
register('final_review.manage', 'GET', [
  '/api/f018/status', '/api/f018/application', '/api/f018/final-review',
]);
register('final_review.manage', 'POST', [
  '/api/f018/application/open', '/api/f018/application/withdraw',
  '/api/f018/application/close', '/api/f018/application/reenter',
  '/api/f018/final-review/draft', '/api/f018/final-review/update',
  '/api/f018/final-review/confirm', '/api/f018/final-review/reopen',
  '/api/f018/disposition',
]);
register('external_ai.configure', 'GET', ['/api/llm/config']);
register('external_ai.configure', 'POST', [
  '/api/llm/config', '/api/llm/models/refresh', '/api/llm/models/test',
]);
register('external_ai.execute', 'POST', [
  '/api/interview-report/llm/preview', '/api/interview-report/llm/analyze',
  '/api/interview-report/llm/cancel', '/api/deep-profile/generate', '/api/assess',
  '/api/assessment/ai-analysis/generate', '/api/job-jd/optimize', '/api/external-ai/material-hash',
  '/api/screenshot-import/preflight', '/api/screenshot-import/retry-preflight', '/api/screenshot-import/retry',
  '/api/screenshot-ocr-drafts/ai-fill-preflight',
]);
const DYNAMIC_ROUTE_CAPABILITIES = Object.freeze([
  { method: 'POST', pattern: /^\/api\/jobs\/\d+\/(copy|details|status)$/, capability: 'recruiting.write' },
  { method: 'GET', pattern: /^\/api\/screenshot-ocr-drafts\/\d+\/audit$/, capability: 'recruiting.read' },
  { method: 'GET', pattern: /^\/api\/screenshot-ocr-drafts\/\d+\/preview$/, capability: 'recruiting.read' },
  { method: 'POST', pattern: /^\/api\/screenshot-ocr-drafts\/\d+\/(edit|confirm|reject)$/, capability: 'recruiting.write' },
  { method: 'GET', pattern: /^\/api\/assessment\/preview\/[0-9a-f-]{36}\/page\/\d+$/, capability: 'assessment.archive' },
]);

const CLIENT_IDENTITY_FIELDS = Object.freeze([
  'actor', 'actorId', 'actor_id', 'actorRole', 'actor_role',
  'confirmedBy', 'confirmed_by', 'linkedBy', 'linked_by',
  'recordedBy', 'recorded_by', 'requestedBy', 'requested_by',
  'createdBy', 'created_by', 'reviewedBy', 'reviewed_by',
]);

function routeCapability(method, pathname) {
  const normalizedMethod = String(method || '').toUpperCase();
  const normalizedPath = String(pathname || '');
  const exact = EXACT_ROUTE_CAPABILITIES.get(`${normalizedMethod} ${normalizedPath}`);
  if (exact) return exact;
  const dynamic = DYNAMIC_ROUTE_CAPABILITIES.find((item) => item.method === normalizedMethod && item.pattern.test(normalizedPath));
  return dynamic ? dynamic.capability : null;
}

function authorizePrincipalRequest(principal, method, pathname) {
  if (!principal || typeof principal !== 'object' || !principal.actor_id || !principal.role) {
    const error = new Error('服务端本地主体缺失。');
    error.code = 'LOCAL_PRINCIPAL_REQUIRED';
    throw error;
  }
  const allowed = ROLE_CAPABILITIES[principal.role];
  if (!allowed) {
    const error = new Error('未知本地角色，已拒绝请求。');
    error.code = 'UNKNOWN_LOCAL_ROLE';
    throw error;
  }
  const capability = routeCapability(method, pathname);
  if (!capability) {
    const error = new Error('动作路由未登记权限，已拒绝请求。');
    error.code = 'UNREGISTERED_ACTION_ROUTE';
    throw error;
  }
  if (!allowed.includes(capability)) {
    const error = new Error('本地主体无此动作权限。');
    error.code = 'LOCAL_CAPABILITY_DENIED';
    throw error;
  }
  return Object.freeze({ ...principal, capability });
}

function sanitizeClientBody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !CLIENT_IDENTITY_FIELDS.includes(key)));
}

module.exports = {
  LOCAL_PRINCIPAL,
  authorizePrincipalRequest,
  routeCapability,
  sanitizeClientBody,
};
