'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-fill-approval-'));
process.env.HRBOSS_DATA_DIR = tmp;
process.env.BOSS_DB_PATH = path.join(tmp, 'check.db');
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const db = require('./db');
const { ingestScreenshotDrafts } = require('./ingest-screenshot-drafts');
const { prepareScreenshotAiFillBatch } = require('./screenshot-ai-fill-approval');
const { fillPendingDraftsWithAi } = require('./screenshot-ai-fill-runner');
const { publicApprovalPreview } = require('./screenshot-ai-import-state');
const { issueExternalAiAuthorization } = require('./external-ai-authorization');
const { createF009LlmRuntime, SCREENSHOT_FIELD_PURPOSE } = require('./f009-interview-llm');
const { describeModel } = require('./external-ai-policy');
const {
  consumeExternalAiUserApproval,
  issueExternalAiUserApproval,
} = require('./external-ai-user-approval');

const shotsDir = path.join(tmp, 'shots');
fs.mkdirSync(shotsDir);
const shotPath = path.join(shotsDir, 'candidate-detail.png');
const originalBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
fs.writeFileSync(shotPath, originalBytes);
const draftsPath = path.join(tmp, 'drafts.json');
fs.writeFileSync(draftsPath, JSON.stringify({
  source_dir: shotsDir,
  image_count: 1,
  detail_draft_count: 1,
  drafts: [{
    draft_id: 'fill-approval-draft',
    name: '合成候选人',
    files: [shotPath],
    facts: { work_years: null, degree: '本科', age: null, salary: null, availability: null, recent_focus: '', work_experience_text: '', education_text: '' },
    field_evidence: {
      name: { field_key: 'name', extracted_value: '合成候选人', confidence: 1, trusted: true, source_spans: [{ source_file: 'candidate-detail.png', line_index: 0, text: '合成候选人', confidence: 1, bbox: {} }], conflict_values: [] },
      degree: { field_key: 'facts.degree', extracted_value: '本科', confidence: 1, source_spans: [], conflict_values: [] },
    },
    ocr_text: '合成候选人',
  }],
}));
fs.writeFileSync(path.join(tmp, 'index.json'), '{"rows":[]}');
fs.writeFileSync(path.join(tmp, 'ocr.json'), '[]');
const ingested = ingestScreenshotDrafts({
  draftsPath,
  stitchedIndexPath: path.join(tmp, 'index.json'),
  ocrPath: path.join(tmp, 'ocr.json'),
});
const row = db.conn().prepare('SELECT id, context_json FROM screenshot_ocr_draft WHERE job_id = ?').get(ingested.job_id);
const context = JSON.parse(row.context_json);
context.evidence = {
  derived: {
    source_hashes: [crypto.createHash('sha256').update(originalBytes).digest('hex')],
    source_sizes: [originalBytes.length],
  },
};
db.conn().prepare('UPDATE screenshot_ocr_draft SET context_json = ? WHERE id = ?').run(JSON.stringify(context), row.id);

const snapshot = prepareScreenshotAiFillBatch(db.conn(), ingested.job_id);
assert.equal(snapshot.items.length, 1);
const connection = { provider: 'synthetic', baseUrl: 'https://ai.example.test/v1', model: 'synthetic-model' };
const preview = publicApprovalPreview(snapshot, connection, { purpose: 'screenshot-field-fill', operation: 'ai_fill' });
assert.equal(preview.purpose, 'screenshot-field-fill');
assert.equal(preview.items[0].fileName, 'candidate-detail.png');

const binding = {
  purpose: 'screenshot-field-fill',
  targetId: snapshot.target_id,
  requestId: 'fill-request-001',
  actor: 'local-primary-operator',
  materialSha256: snapshot.material_sha256,
  ...connection,
};
const secret = 'screenshot-fill-approval-secret-000000000000000001';
assert.throws(() => consumeExternalAiUserApproval(secret, undefined, binding, new Set()), /缺少/);
const consumed = new Set();
const token = issueExternalAiUserApproval(secret, binding);
consumeExternalAiUserApproval(secret, token, binding, consumed);
assert.throws(() => consumeExternalAiUserApproval(secret, token, binding, consumed), /已使用/);
assert.throws(() => consumeExternalAiUserApproval(
  secret,
  issueExternalAiUserApproval(secret, binding),
  { ...binding, materialSha256: 'f'.repeat(64) },
  new Set(),
), /不一致/);
assert.throws(() => consumeExternalAiUserApproval(
  secret,
  issueExternalAiUserApproval(secret, binding),
  { ...binding, model: 'drifted-model' },
  new Set(),
), /不一致/);

fs.writeFileSync(shotPath, Buffer.from('replaced-after-approval'));
assert.throws(() => prepareScreenshotAiFillBatch(db.conn(), ingested.job_id), /内容已变化/);
let externalCalls = 0;
(async () => {
  const modelA = 'gpt-5.6-synthetic-a';
  const modelB = 'gpt-5.6-synthetic-b';
  const savedEnv = {
    enabled: process.env.HRBOSS_EXTERNAL_AI_ENABLED,
    key: process.env.HRBOSS_EXTERNAL_AI_API_KEY,
    model: process.env.HRBOSS_EXTERNAL_AI_MODEL,
  };
  process.env.HRBOSS_EXTERNAL_AI_ENABLED = '1';
  process.env.HRBOSS_EXTERNAL_AI_API_KEY = 'synthetic-model-drift-api-key';
  process.env.HRBOSS_EXTERNAL_AI_MODEL = modelA;
  let driftNetworkCalls = 0;
  const driftRuntime = createF009LlmRuntime({
    env: {
      HRBOSS_EXTERNAL_AI_PROVIDER: 'synthetic',
      HRBOSS_EXTERNAL_AI_BASE_URL: 'https://ai.example.test/v1',
      HRBOSS_EXTERNAL_AI_ENABLED: '1',
      HRBOSS_EXTERNAL_AI_API_KEY: 'synthetic-model-drift-api-key',
      HRBOSS_EXTERNAL_AI_MODEL: modelA,
    },
    initialSupportedModels: [
      describeModel(modelA, { verified: true }),
      describeModel(modelB, { verified: true }),
    ],
    transport: async () => { driftNetworkCalls += 1; return {}; },
  });
  if (savedEnv.enabled === undefined) delete process.env.HRBOSS_EXTERNAL_AI_ENABLED;
  else process.env.HRBOSS_EXTERNAL_AI_ENABLED = savedEnv.enabled;
  if (savedEnv.key === undefined) delete process.env.HRBOSS_EXTERNAL_AI_API_KEY;
  else process.env.HRBOSS_EXTERNAL_AI_API_KEY = savedEnv.key;
  if (savedEnv.model === undefined) delete process.env.HRBOSS_EXTERNAL_AI_MODEL;
  else process.env.HRBOSS_EXTERNAL_AI_MODEL = savedEnv.model;
  const frozenBinding = {
    provider: 'synthetic',
    base_url: 'https://ai.example.test/v1',
    model: modelA,
    operation: 'ai_fill',
    target_id: snapshot.target_id,
    material_sha256: snapshot.material_sha256,
    image_id: snapshot.items[0].image_id,
  };
  const frozenGrant = issueExternalAiAuthorization({
    purpose: SCREENSHOT_FIELD_PURPOSE,
    confirmed: true,
    requestedBy: 'synthetic-hr',
    binding: frozenBinding,
  });
  driftRuntime.configure({ model: modelB });
  await assert.rejects(
    () => driftRuntime.readImageJson({
      prompt: '只返回 {}',
      dataUri: `data:image/png;base64,${originalBytes.toString('base64')}`,
    }, frozenGrant, frozenBinding),
    (error) => error && error.code === 'IMAGE_AUTH_CONNECTION_CHANGED',
    '批次中途切换模型必须在网络调用前拒绝旧逐图授权',
  );
  assert.equal(driftNetworkCalls, 0, '模型设置漂移不得触达外部通道');

  await assert.rejects(
    () => fillPendingDraftsWithAi({
      database: db.conn(),
      jobId: ingested.job_id,
      status: { enabled: true, operational: true, model: 'synthetic-model', blockers: [] },
      approvedMaterials: snapshot.items,
      readImageJson: async () => { externalCalls += 1; return {}; },
      applyFill: () => {},
    }),
    /材料已变化/,
  );
  assert.equal(externalCalls, 0, '材料漂移必须在任何外部调用前拒绝');

  const candidateMain = fs.readFileSync(path.join(__dirname, 'candidate-main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, 'action-server.js'), 'utf8');
  assert.match(candidateMain, /screenshot-import:approve-ai-fill[\s\S]*issueExternalAiUserApproval/);
  assert.match(preload, /approveAiFill[\s\S]*screenshot-import:approve-ai-fill/);
  assert.match(server, /screenshot-ocr-drafts\/ai-fill-preflight[\s\S]*consumeExternalAiUserApproval[\s\S]*approvedMaterials: snapshot\.items/);

  console.log(JSON.stringify({
    ok: true,
    contract: 'SCREENSHOT-AI-FILL-APPROVAL-001',
    native_per_image_preview: true,
    no_token_rejected: true,
    replay_rejected: true,
    material_and_model_drift_rejected: true,
    per_image_connection_snapshot_enforced: true,
    verified_bytes_reused_for_send: true,
    network: 'not-used',
  }));
})().catch((error) => { console.error(error.message); process.exit(1); });
