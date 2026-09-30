const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  APPROVAL_TTL_MS,
  approvalBinding,
  issueExternalAiUserApproval,
  consumeExternalAiUserApproval,
} = require('./external-ai-user-approval');

const secret = 'external-ai-user-approval-synthetic-secret-0000000001';
const nowMs = Date.parse('2026-07-12T08:00:00.000Z');
const input = {
  purpose: 'candidate-assessment',
  targetId: 'C-2026-SYNTHETIC-001',
  requestId: 'candidate-assessment-request-001',
  actor: 'local-primary-operator',
  materialSha256: 'a'.repeat(64),
  provider: 'synthetic',
  baseUrl: 'https://ai.example.test/v1',
  model: 'claude-sonnet-5',
};

assert.deepEqual(approvalBinding(input), {
  purpose: 'candidate-assessment',
  target_id: 'C-2026-SYNTHETIC-001',
  request_id: 'candidate-assessment-request-001',
  actor: 'local-primary-operator',
  material_sha256: 'a'.repeat(64),
  provider: 'synthetic',
  base_url: 'https://ai.example.test/v1',
  model: 'claude-sonnet-5',
});
assert.throws(() => approvalBinding({ ...input, purpose: 'interview-report' }), /用途无效/);
assert.equal(approvalBinding({ ...input, purpose: 'assessment-ai-analysis' }).purpose, 'assessment-ai-analysis');
assert.equal(approvalBinding({ ...input, purpose: 'job-jd-optimization' }).purpose, 'job-jd-optimization');
assert.throws(() => approvalBinding({ ...input, targetId: 'bad\ntarget' }), /目标无效/);
assert.throws(() => approvalBinding({ ...input, requestId: 'bad request' }), /requestId 无效/);
assert.throws(() => approvalBinding({ ...input, materialSha256: 'bad' }), /材料哈希无效/);
assert.throws(() => approvalBinding({ ...input, provider: '' }), /Provider 无效/);
assert.throws(() => approvalBinding({ ...input, baseUrl: 'http://ai.example.test/v1' }), /服务地址无效/);
assert.throws(() => approvalBinding({ ...input, baseUrl: 'https://user:secret@ai.example.test/v1' }), /服务地址无效/);
assert.throws(() => approvalBinding({ ...input, model: '' }), /模型无效/);

const consumed = new Set();
const token = issueExternalAiUserApproval(secret, input, { nowMs });
const result = consumeExternalAiUserApproval(secret, token, input, consumed, { nowMs: nowMs + 1000 });
assert.equal(result.binding.purpose, input.purpose);
assert.equal(result.binding.target_id, input.targetId);
assert.equal(consumed.size, 1);
assert.throws(() => consumeExternalAiUserApproval(secret, token, input, consumed, { nowMs: nowMs + 2000 }), /已使用/);

const mismatchToken = issueExternalAiUserApproval(secret, input, { nowMs });
assert.throws(() => consumeExternalAiUserApproval(secret, mismatchToken, { ...input, targetId: 'C-OTHER' }, new Set(), { nowMs }), /不一致/);
assert.throws(() => consumeExternalAiUserApproval(secret, mismatchToken, { ...input, requestId: 'candidate-assessment-request-002' }, new Set(), { nowMs }), /不一致/);
assert.throws(() => consumeExternalAiUserApproval(secret, mismatchToken, { ...input, actor: 'renderer-forged-actor' }, new Set(), { nowMs }), /不一致/);
assert.throws(() => consumeExternalAiUserApproval(secret, mismatchToken, { ...input, materialSha256: 'b'.repeat(64) }, new Set(), { nowMs }), /不一致/);
assert.throws(() => consumeExternalAiUserApproval(secret, mismatchToken, { ...input, provider: 'other' }, new Set(), { nowMs }), /不一致/);
assert.throws(() => consumeExternalAiUserApproval(secret, mismatchToken, { ...input, baseUrl: 'https://other.example.com' }, new Set(), { nowMs }), /不一致/);
assert.throws(() => consumeExternalAiUserApproval(secret, mismatchToken, { ...input, model: 'claude-opus-5' }, new Set(), { nowMs }), /不一致/);
assert.throws(() => consumeExternalAiUserApproval(secret, mismatchToken, {
  purpose: 'deep-profile', targetId: input.targetId, requestId: input.requestId, actor: input.actor,
  materialSha256: input.materialSha256, provider: input.provider, baseUrl: input.baseUrl, model: input.model,
}, new Set(), { nowMs }), /不一致/);

const expired = issueExternalAiUserApproval(secret, {
  purpose: 'deep-profile', targetId: 99, requestId: 'deep-profile-request-001', actor: input.actor,
  materialSha256: input.materialSha256, provider: input.provider, baseUrl: input.baseUrl, model: input.model,
}, { nowMs });
assert.throws(() => consumeExternalAiUserApproval(secret, expired, {
  purpose: 'deep-profile', targetId: 99, requestId: 'deep-profile-request-001', actor: input.actor,
  materialSha256: input.materialSha256, provider: input.provider, baseUrl: input.baseUrl, model: input.model,
}, new Set(), { nowMs: nowMs + APPROVAL_TTL_MS + 1 }), /过期/);

const [encoded, signature] = mismatchToken.split('.');
const tampered = `${encoded}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
assert.throws(() => consumeExternalAiUserApproval(secret, tampered, input, new Set(), { nowMs }), /缺少/);
assert.throws(() => issueExternalAiUserApproval('short', input), /密钥未就绪/);

const candidateMainSource = fs.readFileSync(path.join(__dirname, 'candidate-main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
const apiSource = fs.readFileSync(path.join(__dirname, 'frontend/src/api.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, 'frontend/src/App.jsx'), 'utf8');
const deepSource = fs.readFileSync(path.join(__dirname, 'frontend/src/components/DeepProfileModal.jsx'), 'utf8');
const assessmentSource = fs.readFileSync(path.join(__dirname, 'frontend/src/components/AssessmentArchivePanel.jsx'), 'utf8');
const actionServerSource = fs.readFileSync(path.join(__dirname, 'action-server.js'), 'utf8');

assert.match(candidateMainSource, /external-ai-approval:confirm[\s\S]*dialog\.showMessageBox[\s\S]*issueExternalAiUserApproval/);
assert.match(candidateMainSource, /external-ai\/material-hash[\s\S]*materialSha256/);
assert.match(candidateMainSource, /externalAiApprovalBinding\(\{[\s\S]*provider: materialResponse\.body\.provider[\s\S]*baseUrl: materialResponse\.body\.baseUrl[\s\S]*model: materialResponse\.body\.model/);
assert.match(preloadSource, /externalAiApproval[\s\S]*external-ai-approval:confirm/);
assert.match(apiSource, /confirmExternalAiApproval[\s\S]*userApproval/);
assert.doesNotMatch(apiSource, /externalAiApproved/);
assert.match(appSource, /confirmExternalAiApproval\('candidate-assessment'/);
assert.match(deepSource, /confirmExternalAiApproval\('deep-profile'/);
assert.match(assessmentSource, /confirmExternalAiApproval\(\s*'assessment-ai-analysis'/);
assert.doesNotMatch(appSource, /api\.assess\([^\n]*true/);
assert.doesNotMatch(deepSource, /generateDeepProfile\([^\n]*true/);
assert.match(actionServerSource, /consumeExternalAiUserApproval\([\s\S]*purpose: 'deep-profile'[\s\S]*purpose: 'candidate-assessment'/);
assert.match(actionServerSource, /ASSESSMENT_AI_PURPOSE[\s\S]*consumeExternalAiUserApproval/);
assert.doesNotMatch(actionServerSource, /externalAiApproved/);

async function checkNativeRecipientDetails() {
  const handlerSource = candidateMainSource.slice(
    candidateMainSource.indexOf("ipcMain.handle('external-ai-approval:confirm'"),
    candidateMainSource.indexOf("ipcMain.handle('screenshot-import:select-directory'"),
  );
  const boundConnection = {
    provider: 'Looks like your trusted service',
    baseUrl: 'https://actual-recipient.example.test:8443/private-connection-path/v1',
    model: 'synthetic-model',
  };
  const trustedEvent = {};
  let handler;
  let shownDialog;
  let trustedChecks = 0;
  vm.runInNewContext(handlerSource, {
    URL,
    ipcMain: { handle: (channel, callback) => {
      assert.equal(channel, 'external-ai-approval:confirm');
      handler = callback;
    } },
    assertTrustedRenderer: (event) => { assert.equal(event, trustedEvent); trustedChecks += 1; },
    READONLY_UI: false,
    LOCAL_PRINCIPAL: { actor_id: input.actor },
    requestLocalApi: async () => ({ status: 200, body: {
      ok: true,
      materialHash: input.materialSha256,
      ...boundConnection,
      apiKey: 'synthetic-server-secret-not-for-dialog',
      preview: { text: 'Synthetic material only.', characterCount: 24, exclusions: [] },
    } }),
    externalAiApprovalBinding: approvalBinding,
    dialog: { showMessageBox: async (_win, options) => { shownDialog = options; return { response: 1 }; } },
    win: {},
    issueExternalAiUserApproval,
    f009ApprovalSecret: secret,
  });
  for (const purpose of ['candidate-assessment', 'assessment-ai-analysis', 'deep-profile', 'job-jd-optimization']) {
    const result = await handler(trustedEvent, {
      ...input,
      purpose,
      provider: 'Renderer spoofed service',
      baseUrl: 'https://renderer.invalid/hidden?apiKey=synthetic-renderer-secret',
      apiKey: 'synthetic-renderer-secret',
    });
    assert.equal(result.approved, true);
    assert.ok(shownDialog.detail.includes(boundConnection.provider));
    assert.ok(shownDialog.detail.includes('服务地址：actual-recipient.example.test:8443'),
      `${purpose}: native confirmation must show the bound recipient, not only its friendly provider label`);
    assert.doesNotMatch(shownDialog.detail, /private-connection-path|renderer\.invalid|synthetic-renderer-secret|synthetic-server-secret|apiKey=/);
    consumeExternalAiUserApproval(secret, result.userApproval, {
      ...input, purpose, ...boundConnection,
    }, new Set());
  }
  assert.equal(trustedChecks, 4);
}

checkNativeRecipientDetails().then(() => {
  console.log('external AI native user approval binding, expiry, replay, bound recipient details and renderer bridge checks passed');
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
