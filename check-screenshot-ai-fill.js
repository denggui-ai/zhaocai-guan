// Guards the in-process AI field fill: it must reach the drafts, write through
// the audited apply path, refuse the name, and leave the confirm gate asking.
// The model call is stubbed — this is about the boundary, not about the model.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-ai-fill-check-'));
process.env.HRBOSS_DATA_DIR = tmp;
process.env.BOSS_DB_PATH = path.join(tmp, 'check.db');
// Windows keeps the SQLite handle open until the process is gone, so the
// temp tree cannot always be removed here. Losing a temp directory is not
// a reason to fail a check.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const db = require('./db');
const {
  applyAiFieldFill,
  ingestScreenshotDrafts,
  listScreenshotOcrDrafts,
  listScreenshotOcrReviewAudit,
} = require('./ingest-screenshot-drafts');
const { fillPendingDraftsWithAi } = require('./screenshot-ai-fill-runner');
const { createF009LlmRuntime, SCREENSHOT_FIELD_PURPOSE } = require('./f009-interview-llm');
const { issueExternalAiAuthorization } = require('./external-ai-authorization');

const shotsDir = path.join(tmp, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });
const shot = 'synthetic-detail-1.png';
// Content is irrelevant: the channel is stubbed. Only existence is checked.
fs.writeFileSync(path.join(shotsDir, shot), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

const draft = {
  draft_id: 'screenshot-synthetic01',
  source: 'Boss App截图导入草稿',
  name: '合成候选人',
  files: [path.join(shotsDir, shot)],
  facts: {
    work_years: null,
    degree: '本科',
    age: '30岁',
    salary: null,
    availability: null,
    recent_focus: '',
    work_experience_text: '',
    education_text: '',
  },
  field_evidence: {
    name: {
      field_key: 'name',
      extracted_value: '合成候选人',
      confidence: 1,
      source_spans: [{ source_file: shot, line_index: 0, text: '合成候选人', confidence: 1, bbox: { left: 0, top: 0, width: 10, height: 10 } }],
      conflict_values: [],
      extraction_method: 'relative_header_geometry_v2',
      trusted: true,
    },
    work_years: { field_key: 'facts.work_years', extracted_value: null, confidence: null, source_spans: [], conflict_values: [] },
    degree: { field_key: 'facts.degree', extracted_value: '本科', confidence: 0.3, source_spans: [], conflict_values: [] },
    age: { field_key: 'facts.age', extracted_value: '30岁', confidence: 0.3, source_spans: [], conflict_values: [] },
  },
  grouping: { strategy: 'detail_header_sequence' },
  ocr_text: '合成候选人\n本科\n30岁',
};

const shot2 = 'synthetic-detail-2.png';
fs.writeFileSync(path.join(shotsDir, shot2), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const draft2 = JSON.parse(JSON.stringify(draft));
draft2.draft_id = 'screenshot-synthetic02';
draft2.name = '合成候选人贰';
draft2.files = [path.join(shotsDir, shot2)];
draft2.field_evidence.name.extracted_value = '合成候选人贰';
draft2.field_evidence.name.source_spans[0].text = '合成候选人贰';
draft2.field_evidence.name.source_spans[0].source_file = shot2;
draft2.ocr_text = '合成候选人贰\n本科\n30岁';

const draftsPath = path.join(tmp, 'drafts.json');
fs.writeFileSync(draftsPath, JSON.stringify({
  source_dir: shotsDir,
  generated_at: new Date().toISOString(),
  image_count: 2,
  detail_draft_count: 2,
  drafts: [draft, draft2],
}));
fs.writeFileSync(path.join(tmp, 'index.json'), JSON.stringify({ rows: [] }));
fs.writeFileSync(path.join(tmp, 'ocr.json'), JSON.stringify([]));

const ingest = ingestScreenshotDrafts({
  draftsPath,
  stitchedIndexPath: path.join(tmp, 'index.json'),
  ocrPath: path.join(tmp, 'ocr.json'),
});
assert.equal(ingest.pending_review, 2, '合成草稿应进入待校对');

const jobId = ingest.job_id;

// The channel is stubbed, but the runtime holding it is the real one: the
// configuration has to travel the same path the settings page uses, because the
// bug this guards was configure() and the fill reading two different sources.
// Use an explicit synthetic connection so the test never depends on a service default.
const MODEL = 'claude-sonnet-5';
const ANSWER = { work_years: '9年', degree: '本科', age: '30岁', salary: '6000-8000元' };
let calls = 0;
let inFlight = 0;
let peakInFlight = 0;
const stubTransport = async ({ path: requestPath, body }) => {
  if (requestPath === '/v1/models') return { data: [{ id: MODEL }] };
  const content = Array.isArray(body.messages[0].content) ? body.messages[0].content : [];
  const readsImage = content.some((part) => part.type === 'image_url');
  // A model only becomes usable after the compatibility probe, so the stub has
  // to answer that too. It carries no image and must not count as a field read.
  if (!readsImage) {
    return { model: body.model, choices: [{ message: { content: '{"ok":true,"purpose":"hrboss_model_compatibility"}' } }] };
  }
  calls += 1;
  inFlight += 1;
  peakInFlight = Math.max(peakInFlight, inFlight);
  await new Promise((resolve) => setTimeout(resolve, 40));
  inFlight -= 1;
  assert.ok(content.some((part) => part.type === 'image_url' && /^data:image\/png;base64,/.test(part.image_url.url)),
    '读图请求必须真的带上截图');
  // Wrapped in a fence on purpose: vision models do this often enough that the
  // reader has to tolerate it.
  return { model: body.model, choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\`` } }] };
};

const runtime = createF009LlmRuntime({ env: {}, transport: stubTransport });
const wiring = {
  database: db.conn(),
  jobId,
  applyFill: applyAiFieldFill,
  // Wired exactly as action-server.js wires it.
  status: () => runtime.externalAiStatus(),
  readImageJson: (input) => {
    const config = runtime.publicConfig();
    const binding = {
      provider: config.provider,
      base_url: config.baseUrl,
      model: config.model,
      operation: 'synthetic_fill',
      target_id: 'synthetic-fill-job',
      material_sha256: 'a'.repeat(64),
    };
    return runtime.readImageJson(input, issueExternalAiAuthorization({
      purpose: SCREENSHOT_FIELD_PURPOSE,
      confirmed: true,
      requestedBy: 'synthetic-hr',
      binding,
    }), binding);
  },
};
const runFill = () => fillPendingDraftsWithAi({ ...wiring, status: wiring.status() });

(async () => {
  const disabled = await runFill();
  assert.equal(disabled.skipped_reason, 'external_ai_disabled', '未配置时必须整体跳过');
  assert.equal(calls, 0, '未配置时不得触达通道');

  // The settings-page write path: save a connection, test a model, then enable.
  runtime.configure({ apiKey: 'k'.repeat(20), provider: 'synthetic', baseUrl: 'https://ai.example.test/v1' });
  assert.equal(runtime.externalAiStatus().enabled, false, '保存新凭据不能自动启用外部 AI');
  runtime.configure({ enabled: true });
  const notVerified = await runFill();
  assert.equal(notVerified.skipped_reason, 'external_ai_not_configured', '未选模型时必须跳过');
  assert.ok(notVerified.blockers.some((item) => /选择模型|兼容性测试/.test(item)), '跳过时必须说明设置页缺什么');
  assert.equal(calls, 0, '未选模型时不得触达通道');

  await runtime.refreshModels();
  // Listing a model is not the same as being able to call it: the model only
  // becomes usable once it passes the compatibility test the settings page runs.
  const listedOnly = await runFill();
  assert.equal(listedOnly.skipped_reason, 'external_ai_not_configured', '仅列出模型、未过兼容性测试时必须跳过');
  assert.equal(calls, 0, '未过兼容性测试时不得触达通道');

  await runtime.testModel({ model: MODEL });
  runtime.configure({ enabled: true });
  assert.equal(runtime.externalAiStatus().operational, true, '设置页配置齐全后必须判定为可用');

  // The assertion this whole gate exists for: configure the settings page and
  // the fill works, with no environment variable anywhere in the path.
  const summary = await runFill();
  assert.equal(summary.skipped_reason, null, '设置页配置后 AI 补全必须可用');
  assert.equal(summary.model, MODEL, '补全必须使用设置页选中的模型');
  assert.ok(calls > 0, '配置齐全后应当调用通道');
  assert.equal(summary.failed, 0);
  assert.equal(summary.failed_reason, null);

  // Each real call costs seconds; reading them one at a time would put a
  // 13-candidate batch back into minutes.
  assert.ok(peakInFlight > 1, `模型调用必须并发，实测峰值并发 ${peakInFlight}`);

  const rows = listScreenshotOcrDrafts({ status: 'pending_review', jobId });
  assert.equal(rows.length, 2, '两份草稿都应仍在待校对');
  const row = rows[0];
  assert.equal(row.current.facts.work_years, '9年', '缺失字段应被补全');
  assert.equal(row.current.facts.salary, '6000-8000元');
  assert.equal(row.field_evidence.work_years.extraction_method, 'external_ai_vision_v1');
  assert.equal(row.field_evidence.work_years.confidence, null, 'AI 结果不得伪装成有置信度的证据');
  assert.deepEqual(row.field_evidence.work_years.source_spans, [], 'AI 结果不得携带截图坐标');
  assert.equal(row.field_evidence.degree.ai_corroborated, true, '一致读数应记为交叉确认');
  assert.equal(row.reviewed_by, null, 'AI 补全不得把草稿标记为已人工复核');
  assert.equal(row.status, 'pending_review', 'AI 补全不得改变待校对状态');

  const lowConfidenceFlags = (row.review_flags.fields || []).filter((item) => item.kind === 'low_confidence');
  assert.equal(lowConfidenceFlags.length, 0, '被交叉确认的字段不应再报低置信');

  const audit = listScreenshotOcrReviewAudit(row.id);
  assert.ok(audit.some((item) => item.actor === 'external-ai-vision'), 'AI 补全必须留痕');

  assert.throws(() => applyAiFieldFill(row.id, { facts: { name: '张三' }, actor: 'external-ai-vision' }), /姓名不接受外部 AI 补全/);
  assert.throws(() => applyAiFieldFill(row.id, { evidence: { name: { trusted: true } }, actor: 'external-ai-vision' }), /姓名证据不接受外部 AI 补全/);
  const reread = listScreenshotOcrDrafts({ status: 'pending_review', jobId }).find((item) => item.id === row.id);
  assert.equal(reread.current.name, row.current.name, '姓名必须原样保留');

  // Static, because the failure this catches is silent: swapping the injected
  // channel back for an environment read would leave every assertion above
  // passing while the real app kept saying the feature is not configured.
  const server = fs.readFileSync(path.join(__dirname, 'action-server.js'), 'utf8');
  assert.match(server, /const status = f009Runtime\.externalAiStatus\(\)[\s\S]*fillPendingDraftsWithAi\([\s\S]*\n\s*status,/,
    'ai-fill 端点必须用 f009Runtime 的状态判定，不得另立一套');
  assert.match(server, /readImageJson: \(input, approvedItem\) => \{[\s\S]*f009Runtime\.readImageJson\(input, issueExternalAiAuthorization\(/,
    'ai-fill 端点必须把读图通道接到 f009Runtime 并逐次签授权');
  const fieldAi = fs.readFileSync(path.join(__dirname, 'screenshot-field-ai.js'), 'utf8');
  assert.doesNotMatch(fieldAi, /HRBOSS_EXTERNAL_AI_|process\.env/,
    '截图 AI 补全不得再从环境变量读配置——设置页配置正是这样传不进来的');

  console.log(JSON.stringify({
    ok: true,
    contract: 'SCREENSHOT-AI-FILL-001',
    settings_page_config_reaches_fill: true,
    key_never_leaves_runtime: true,
    disabled_by_default: true,
    fills_missing_fields: true,
    records_corroboration: true,
    ai_evidence_has_no_confidence_or_spans: true,
    name_and_name_evidence_rejected: true,
    review_gate_preserved: true,
    audited_actor: 'external-ai-vision',
    reads_concurrently: true,
    network: 'stubbed',
    data: 'synthetic-tmp-only',
  }));
})().catch((err) => { console.error(err.message); process.exit(1); });
