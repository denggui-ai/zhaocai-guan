
const { PROJECT_ROOT } = require("../src/paths");
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  LOCAL_PRINCIPAL,
  authorizePrincipalRequest,
  routeCapability,
  sanitizeClientBody,
} = require("../src/local-principal");
const principalModule = require("../src/local-principal");

assert.deepEqual(LOCAL_PRINCIPAL, {
  actor_id: 'local-primary-operator',
  role: 'hr_admin',
});
assert.equal(Object.isFrozen(LOCAL_PRINCIPAL), true);
assert.equal(principalModule.ROLE_CAPABILITIES, undefined, 'mutable role capability collections must stay private');
assert.equal(principalModule.CLIENT_IDENTITY_FIELDS, undefined, 'identity denylist must stay private');
assert.equal(authorizePrincipalRequest(LOCAL_PRINCIPAL, 'POST', '/api/candidate-status').capability, 'recruiting.write');
assert.equal(authorizePrincipalRequest(LOCAL_PRINCIPAL, 'POST', '/api/interview-session').capability, 'interview.write');
assert.equal(authorizePrincipalRequest(LOCAL_PRINCIPAL, 'POST', '/api/local-interview/abort').capability, 'interview.write');
assert.equal(authorizePrincipalRequest(LOCAL_PRINCIPAL, 'GET', '/api/interview-session/manual-note').capability, 'interview.read');
for (const route of [
  '/api/interview-session/manual-note',
  '/api/interview-session/manual-note/revoke',
  '/api/local-interview/transcription/retry',
  '/api/interview-report/manual',
]) {
  assert.equal(authorizePrincipalRequest(LOCAL_PRINCIPAL, 'POST', route).capability, 'interview.write');
}
assert.throws(
  () => authorizePrincipalRequest(null, 'POST', '/api/candidate-status'),
  (error) => error.code === 'LOCAL_PRINCIPAL_REQUIRED',
);
assert.throws(
  () => authorizePrincipalRequest({ actor_id: 'synthetic', role: 'unknown' }, 'POST', '/api/candidate-status'),
  (error) => error.code === 'UNKNOWN_LOCAL_ROLE',
);
assert.throws(
  () => authorizePrincipalRequest(LOCAL_PRINCIPAL, 'POST', '/api/unregistered-write'),
  (error) => error.code === 'UNREGISTERED_ACTION_ROUTE',
);

const clean = sanitizeClientBody({
  candidateId: 'SYNTHETIC-CANDIDATE',
  actor: 'forged',
  actorRole: 'super_admin',
  confirmedBy: 'forged-confirmer',
  linkedBy: 'forged-linker',
  recordedBy: 'forged-recorder',
  requestedBy: 'forged-requester',
});
assert.deepEqual(clean, { candidateId: 'SYNTHETIC-CANDIDATE' });

// Every action-server route must be deliberately present in the matrix. This keeps
// future writes fail-closed instead of silently inheriting hr_admin access.
const source = fs.readFileSync(path.join(PROJECT_ROOT, "src/action-server.js"), 'utf8');
for (const match of source.matchAll(/req\.method === '([^']+)'\s*&&\s*url\.pathname === '([^']+)'/g)) {
  assert.ok(routeCapability(match[1], match[2]), `route missing from capability matrix: ${match[1]} ${match[2]}`);
}
assert.equal(routeCapability('GET', '/api/screenshot-ocr-drafts/12/audit'), 'recruiting.read');
for (const action of ['edit', 'confirm', 'reject']) {
  assert.equal(routeCapability('POST', `/api/screenshot-ocr-drafts/12/${action}`), 'recruiting.write');
}
assert.equal(routeCapability('GET', '/api/assessment/preview/00000000-0000-4000-8000-000000000000/page/1'), 'assessment.archive');
assert.equal(routeCapability('POST', '/api/assessment/deletion/request'), 'assessment.archive');
assert.equal(routeCapability('POST', '/api/assessment/deletion/confirm'), 'assessment.archive');
assert.equal(routeCapability('POST', '/api/assessment/duplicate/resolve'), 'assessment.archive');
assert.equal(routeCapability('POST', '/api/assessment/metadata/confirm'), 'assessment.archive');
assert.equal(routeCapability('GET', '/api/f018/status'), 'final_review.manage');
assert.equal(routeCapability('POST', '/api/f018/final-review/confirm'), 'final_review.manage');
assert.equal(routeCapability('POST', '/api/f018/disposition'), 'final_review.manage');

assert.match(source, /authorizePrincipalRequest\(LOCAL_PRINCIPAL, req\.method, url\.pathname\)/);
assert.doesNotMatch(source, /body\.(actor|actorRole|confirmedBy|linkedBy|recordedBy|requestedBy)/);

const candidateMainSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/candidate-main.js"), 'utf8');
assert.match(candidateMainSource, /const input = request && typeof request === 'object' \? request : \{\}[\s\S]*input\.userConfirmed !== true[\s\S]*approvalBinding\(\{ \.\.\.input, actor: LOCAL_PRINCIPAL\.actor_id \}\)/);
assert.match(
  candidateMainSource,
  /external-ai-approval:confirm[\s\S]*requestedBinding = \{ \.\.\.\(request \|\| \{\}\), actor: LOCAL_PRINCIPAL\.actor_id \}[\s\S]*requestPath: '\/external-ai\/material-hash'[\s\S]*externalAiApprovalBinding\(\{[\s\S]*materialSha256: materialResponse\.body\.materialHash/,
);

console.log('local principal, capability matrix and forged renderer identity checks passed');
