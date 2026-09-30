'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { issueExternalAiAuthorization } = require('./external-ai-authorization');
const { REPORT_DISCLAIMER: CANDIDATE_DISCLAIMER } = require('./candidate-report-v1');
const { REPORT_DISCLAIMER: INTERVIEW_DISCLAIMER } = require('./interview-report-v1');
const { createF009LlmRuntime } = require('./f009-interview-llm');
const { describeModel } = require('./external-ai-policy');
const { loadLegacyRatingState } = require('./secure-llm-config-store');

const MODEL = 'gpt-5.6-synthetic-unified';
const PROVIDER = 'synthetic';
const BASE_URL = 'https://ai.example.test/v1';
const chatCalls = [];

function response(content) {
  return { model: MODEL, choices: [{ message: { content: JSON.stringify(content) } }] };
}

const replies = [
  {
    full_text: '岗位职责：负责合成测试。\n任职要求：能完成复盘。',
    job_title: '合成岗位',
    responsibilities: ['负责合成测试'],
    requirements: ['能完成复盘'],
  },
  {
    position_mission: { content: '完成合成招聘任务', source: 'stated', quotes: ['完成任务'], inference_basis: '' },
    hard_requirements: [],
    core_competencies: [],
    plus_points: [],
    minus_points: [],
    deal_breakers: [],
    implicit_preferences: [],
    followup_questions: [],
  },
  {
    schema_version: 'candidate_evaluation_report_v1',
    job_understanding: { title: '合成岗位', goal: '完成任务', core_requirements: ['项目能力'], source: 'rubric' },
    candidate_summary: { name: '隐去姓名', education: 'Unknown', work_experience: 'Unknown', summary: '存在一条合成项目证据。' },
    dimension_matches: [{
      dimension: '项目能力',
      state: 'Match',
      score: 7,
      confidence: 0.6,
      evidence: [{ id: 'proj.0.desc', section: 'proj', index: 0, field: 'desc', text: '完成合成项目' }],
      explanation: { fact: '材料记载完成合成项目。', judgment: '与项目能力相关。', impact: '可进入人工核实。' },
      risk: '结果细节待核实。',
    }],
    radar: [],
    strengths: [],
    risks: [],
    unknowns: [],
    interview_questions: [],
    overall: '仅供 HR 参考的合成初评。',
    disclaimer: CANDIDATE_DISCLAIMER,
  },
  {
    schema_version: 'assessment_ai_analysis_v1',
    fit_score: 66,
    confidence: 'medium',
    overall: '合成测评材料与岗位存在部分匹配。',
    strengths: [{ point: '岗位目标匹配', evidence_refs: ['J1'] }],
    risks: [],
    contradictions: [],
    interview_questions: [{ question: '请说明完成方式。', listen_for: '个人贡献', evidence_refs: ['J1'] }],
    decision_support: { recommendation: 'hold', reason: '仍需 HR 核实。' },
  },
];

const runtime = createF009LlmRuntime({
  env: {
    HRBOSS_EXTERNAL_AI_PROVIDER: PROVIDER,
    HRBOSS_EXTERNAL_AI_BASE_URL: BASE_URL,
  },
  initialSupportedModels: [describeModel(MODEL, { verified: true })],
  transport: async (request) => {
    if (request.path === '/v1/models') return { data: [{ id: MODEL }] };
    assert.equal(request.path, '/v1/chat/completions');
    if (String(request.body?.messages?.[0]?.content || '').includes('hrboss_model_compatibility')) {
      return response({ ok: true, purpose: 'hrboss_model_compatibility' });
    }
    chatCalls.push(request);
    const next = replies.shift();
    if (next) return response(next);
    const preview = runtime.__testPreview;
    const unit = preview.units[0];
    return response({
      schema_version: 'interview_report_v1',
      summary: {
        id: 'summary.main',
        status: 'supported',
        text: '候选人描述了合成项目经历。',
        evidence_refs: [{ material_id: unit.materialId, span: unit.span }],
      },
      match_points: [],
      risks: [],
      unknowns: [{ id: 'unknown.team', status: 'unknown', text: '团队规模未提及。', reason_code: 'not_mentioned', evidence_refs: [] }],
      followup_questions: [],
      key_facts: [],
      hard_requirements: [],
      competency_evidence: [{
        id: 'competency.project',
        label: '项目能力',
        status: 'supported',
        text: '候选人描述了合成项目经历。',
        evidence_refs: [{ material_id: unit.materialId, span: unit.span }],
      }],
      motivation: {
        id: 'motivation.main',
        label: '求职动机',
        status: 'unknown',
        text: '材料未提及求职动机。',
        reason_code: 'not_mentioned',
        evidence_refs: [],
      },
      contradictions: [],
      assessment_cross_checks: [],
      ai_reference: {
        id: 'ai_reference.main',
        label: 'AI 参考分析',
        status: 'supported',
        text: '仅归集项目证据，需 HR 核对。',
        evidence_refs: [{ material_id: unit.materialId, span: unit.span }],
      },
      human_confirm_required: true,
      disclaimer: INTERVIEW_DISCLAIMER,
    });
  },
});

runtime.configure({
  provider: PROVIDER,
  baseUrl: BASE_URL,
  enabled: true,
  apiKey: 'synthetic-unified-api-key',
});

function authorization(purpose, binding = null) {
  if (purpose !== 'interview-report' && binding === null) {
    const config = runtime.publicConfig();
    binding = {
      provider: config.provider,
      base_url: config.baseUrl,
      model: config.model,
    };
  }
  return issueExternalAiAuthorization({ purpose, confirmed: true, requestedBy: 'synthetic-hr', binding });
}

async function main() {
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-unified-ai-legacy-'));
  try {
    fs.writeFileSync(path.join(legacyRoot, 'rating-config.json'), JSON.stringify({
      provider: PROVIDER,
      base_url: BASE_URL,
      api_key: 'synthetic-legacy-api-key',
      model: MODEL,
      data_processing_approved: true,
      cost_acknowledged: true,
      allowed_hosts: ['synthetic.invalid'],
    }));
    const legacy = loadLegacyRatingState({ dataDir: legacyRoot, appDir: legacyRoot, env: {} });
    assert.equal(legacy.config.enabled, false, 'legacy list-only model state must require a real compatibility test');
    assert.equal(legacy.config.baseUrl, BASE_URL);
    assert.equal(legacy.apiKey, 'synthetic-legacy-api-key');
    assert.deepEqual(legacy.models, []);
    assert.equal(legacy.config.model, '');
  } finally {
    fs.rmSync(legacyRoot, { recursive: true, force: true });
  }

  await runtime.refreshModels();
  await runtime.testModel({ model: MODEL });
  runtime.configure({ enabled: true });
  const config = runtime.publicConfig();
  assert.equal(config.operational, true);
  assert.equal(config.availableCapabilityCount, 5);
  assert.deepEqual(Object.keys(config.capabilities).sort(), [
    'assessment_analysis', 'candidate_assessment', 'deep_profile', 'interview_review', 'job_jd',
  ]);
  assert.ok(Object.values(config.capabilities).every(Boolean));

  await runtime.optimizeJobDescription({ jobName: '合成岗位', brief: '完成任务', currentJd: '' }, authorization('job-jd-optimization'));
  await runtime.generateDeepProfile({ jobName: '合成岗位', rubric: '项目能力', transcripts: ['完成任务'] }, authorization('deep-profile'));
  await runtime.assessCandidateV1({
    jobName: '合成岗位',
    candidateName: '隐去姓名',
    rubric: '项目能力',
    dimensions: [{ name: '项目能力' }],
    evidenceProfile: {
      schema_version: 'evidence_profile_v1',
      evidence_items: [{ id: 'proj.0.desc', section: 'proj', index: 0, field: 'desc', text: '完成合成项目' }],
    },
  }, authorization('candidate-assessment'));
  await runtime.analyzeAssessmentPortfolio({
    schema_version: 'assessment_ai_input_v1',
    allowed_evidence_refs: ['J1'],
    job: { ref: 'J1', job_name: '合成岗位' },
  }, authorization('assessment-ai-analysis'));

  const preview = runtime.buildPreview({
    requestId: 'unified-ai-interview-001',
    sessionId: 1,
    materials: [{ id: 1, session_id: 1, text: '候选人描述了合成项目经历。' }],
  });
  runtime.__testPreview = preview;
  const binding = {
    actor: 'synthetic-hr',
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
  await runtime.analyze(preview, authorization('interview-report', binding), 'synthetic-hr');
  runtime.release(preview.requestId);

  assert.equal(chatCalls.length, 5);
  assert.ok(chatCalls.every((call) => call.provider === PROVIDER));
  assert.ok(chatCalls.every((call) => call.baseUrl === BASE_URL));
  assert.ok(chatCalls.every((call) => call.body.model === MODEL));

  const server = fs.readFileSync(path.join(__dirname, 'action-server.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, 'candidate-main.js'), 'utf8');
  const settings = fs.readFileSync(path.join(__dirname, 'frontend/src/components/SettingsPanel.jsx'), 'utf8');
  const interview = fs.readFileSync(path.join(__dirname, 'frontend/src/components/InterviewReviewPanel.jsx'), 'utf8');
  assert.match(server, /generator: \(input, grant\) => f009Runtime\.generateDeepProfile/);
  assert.match(server, /assessor: \(input, grant\) => f009Runtime\.assessCandidateV1/);
  assert.match(server, /analyzeAssessmentPortfolio/);
  assert.match(server, /optimizeJobDescription/);
  assert.match(server, /f009Runtime\.analyze\(/);
  assert.match(mainSource, /const startupLlmResolution = resolveStartupLlmState\(\{/);
  assert.match(mainSource, /lstatSync\(secureStorePath\);[\s\S]*?return llmStartupResolution\(null, true\);[\s\S]*?error\.code !== 'ENOENT'/, 'present or inaccessible secure state must become an explicit startup fault');
  assert.match(mainSource, /legacyLlmConfigPresence\(legacyOptions, legacyLstatSync\)[\s\S]*?legacyPresence === 'absent'[\s\S]*?legacyPresence !== 'present'/, 'only truly absent secure and legacy files may mean unconfigured');
  assert.match(mainSource, /saveSecure\(secureStorePath, safeStorageAdapter, \{[\s\S]*?apiKey: legacyState\.apiKey,[\s\S]*?\}\);[\s\S]*?migratedState = loadSecure\(secureStorePath, safeStorageAdapter\);[\s\S]*?migratedState \? llmStartupResolution\(migratedState\) : llmStartupResolution\(null, true\)/, 'legacy state must become active only after secure migration succeeds and reads back');
  assert.match(mainSource, /HRBOSS_EXTERNAL_AI_CONFIG_STARTUP_FAULT: startupLlmResolution\.faultCode/);
  assert.match(server, /GET'[\s\S]*?'\/api\/llm\/config'[\s\S]*?externalAiStartupConfigFaultResponse\(\)/, 'GET llm config must surface the startup fault to the settings page');
  assert.doesNotMatch(mainSource, /storedLlmState \? null : loadLegacyRatingState|storedLlmState \|\| legacyLlmState/);
  assert.match(settings, /const AI_CAPABILITY_LABELS = Object\.freeze\(\[/);
  assert.match(settings, /一套配置用于 5 项辅助能力/);
  assert.match(settings, /当前 \{llmCapabilityCount\}\/5 项已就绪/);
  assert.doesNotMatch(settings, /统一 AI 配置能力状态|settings-llm-steps/);
  assert.doesNotMatch(settings, /rating-config\.json/);
  assert.match(
    interview,
    /点击“确认发送并生成草稿”后，还需在系统原生对话框确认本次外发/,
    'unified AI wiring must retain the second trusted native confirmation',
  );
  assert.match(interview, /<summary>\s*<Space wrap>\s*<strong>高级材料管理<\/strong>/);
  assert.doesNotMatch(interview, /llmApproved|setLlmApproved/);

  console.log(JSON.stringify({
    ok: true,
    contract: 'internal-usability-001',
    unified_ai_capabilities: 5,
    provider_calls: chatCalls.length,
    network: 'mock-only',
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
