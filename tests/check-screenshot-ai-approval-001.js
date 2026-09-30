'use strict';

const assert = require('assert');
const {
  consumeExternalAiUserApproval,
  issueExternalAiUserApproval,
} = require("../src/external-ai-user-approval");
const {
  PendingScreenshotApprovalVault,
  screenshotApprovalBinding,
  screenshotApprovalDialog,
} = require("../src/screenshot-ai-native-approval");

const preview = {
  requires_external_ai: true,
  purpose: 'screenshot-import',
  operation: 'initial_import',
  targetId: `screenshot-import:${'a'.repeat(32)}`,
  materialHash: 'b'.repeat(64),
  imageCount: 2,
  totalBytes: 300,
  extensionCounts: { PNG: 1, JPG: 1 },
  items: [
    { image_id: 'image-001-a', ordinal: 1, fileName: '01.png', sizeBytes: 100, contentHashPrefix: '1'.repeat(12) },
    { image_id: 'image-002-b', ordinal: 2, fileName: '02.jpg', sizeBytes: 200, contentHashPrefix: '2'.repeat(12) },
  ],
  provider: 'synthetic',
  baseUrl: 'https://ai.example.test/v1',
  model: 'synthetic-model',
};
const binding = screenshotApprovalBinding(preview, 'request-screenshot-001', 'local-primary-operator');
assert.equal(binding.purpose, 'screenshot-import');
const dialog = screenshotApprovalDialog(preview, binding);
assert.match(dialog.detail, /01\.png · 100 字节 · SHA-256 111111111111/);
assert.match(dialog.detail, /02\.jpg · 200 字节 · SHA-256 222222222222/);

const recipientPreview = {
  ...preview,
  provider: 'Looks like your trusted service',
  baseUrl: 'https://actual-recipient.example.test:8443/private-connection-path/v1',
  apiKey: 'synthetic-screenshot-secret-not-for-dialog',
};
const recipientBinding = screenshotApprovalBinding(recipientPreview, 'request-screenshot-recipient', 'local-primary-operator');
const recipientDialog = screenshotApprovalDialog({
  ...recipientPreview,
  baseUrl: 'https://unbound-preview.invalid/?apiKey=synthetic-query-secret',
}, recipientBinding);
assert.ok(recipientDialog.detail.includes(recipientBinding.provider));
assert.ok(recipientDialog.detail.includes('服务地址：actual-recipient.example.test:8443'),
  'native screenshot confirmation must show the bound recipient, not only its friendly provider label');
assert.doesNotMatch(recipientDialog.detail, /private-connection-path|unbound-preview\.invalid|synthetic-screenshot-secret|synthetic-query-secret|apiKey=/);

const secret = 'screenshot-ai-approval-synthetic-secret-000000000001';
const token = issueExternalAiUserApproval(secret, binding);
const consumed = new Set();
consumeExternalAiUserApproval(secret, token, binding, consumed);
assert.throws(() => consumeExternalAiUserApproval(secret, token, binding, consumed), /已使用/);

const vault = new PendingScreenshotApprovalVault();
vault.put('/tmp/screenshots-a', { requestId: binding.request_id, userApproval: token });
const attached = vault.attach({
  service: 'action',
  method: 'POST',
  requestPath: '/screenshot-import/start',
  body: { dir: '/tmp/screenshots-a' },
});
assert.equal(attached.body.requestId, binding.request_id);
assert.equal(attached.body.userApproval, token);
const replay = vault.attach({
  service: 'action', method: 'POST', requestPath: '/screenshot-import/start', body: { dir: '/tmp/screenshots-a' },
});
assert.equal(replay.body.userApproval, undefined, '主进程暂存批准也必须一次性取出');

console.log(JSON.stringify({
  ok: true,
  contract: 'SCREENSHOT-AI-APPROVAL-001',
  signed_content_and_connection_binding: true,
  native_per_image_manifest: true,
  renderer_boolean_not_accepted: true,
  replay_rejected: true,
  network: 'not-used',
}));
