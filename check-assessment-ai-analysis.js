'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');
const { applyAssessmentSchemaMigration } = require('./assessment-schema');
const {
  buildAssessmentAiInput,
  buildAssessmentAiUserPrompt,
  parseAssessmentAiReply,
} = require('./assessment-ai-analysis');
const { createAssessmentProductService } = require('./assessment-product-service');
const { attachAssessmentFitSignals } = require('./assessment-fit-ranking');
const { createF009LlmRuntime } = require('./f009-interview-llm');
const { issueExternalAiAuthorization } = require('./external-ai-authorization');
const { issueExternalAiUserApproval, consumeExternalAiUserApproval } = require('./external-ai-user-approval');
const { externalAiMaterialHash } = require('./external-ai-material-hash');
const { prepareAssessmentIngress } = require('./assessment-actor-context');

const database = new Database(':memory:');
database.pragma('foreign_keys = ON');
database.exec(`
  CREATE TABLE job (id INTEGER PRIMARY KEY, name TEXT, status TEXT NOT NULL DEFAULT 'open');
  CREATE TABLE candidate (
    internal_id TEXT PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES job(id),
    name TEXT,
    rec_position TEXT,
    sabc TEXT,
    created_at TEXT
  );
  CREATE TABLE resume_online (
    id INTEGER PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidate(internal_id),
    sections_json TEXT,
    is_paywalled INTEGER,
    fetched_at TEXT
  );
  CREATE TABLE job_profile (
    id INTEGER PRIMARY KEY,
    job_id INTEGER NOT NULL REFERENCES job(id),
    config_json TEXT,
    updated_at TEXT
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    action TEXT, target TEXT, who TEXT, auto INTEGER, result TEXT, detail_json TEXT, created_at TEXT
  );
  CREATE TABLE ai_review (
    id INTEGER PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidate(internal_id),
    job_id INTEGER NOT NULL REFERENCES job(id),
    profile_confirmed INTEGER,
    report_json TEXT NOT NULL,
    created_at TEXT
  );
  CREATE TABLE interview_session (
    id INTEGER PRIMARY KEY,
    candidate_id TEXT NOT NULL,
    job_id INTEGER NOT NULL,
    round INTEGER NOT NULL
  );
  CREATE TABLE interview_report_v1 (
    id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    version INTEGER NOT NULL,
    report_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    confirmed_by TEXT,
    confirmed_at TEXT
  );
  CREATE TABLE interview_report_confirmed_projection (
    report_id INTEGER PRIMARY KEY,
    session_id INTEGER NOT NULL,
    source_report_version INTEGER NOT NULL,
    projection_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT INTO job (id, name, status) VALUES (1, '合成运营岗位', 'open');
  INSERT INTO candidate VALUES ('C-AI-1', 1, '合成张三', '抖音运营', 'A', '2026-07-14');
  INSERT INTO resume_online VALUES (
    1, 'C-AI-1',
    '{"basic":[{"description":"合成张三负责直播运营"}],"work":[{"title":"运营","desc":"合成张三把转化率提升到 8%"}]}',
    0, '2026-07-14T01:00:00.000Z'
  );
  INSERT INTO job_profile VALUES (
    1, 1,
    '{"rubric":"需要直播运营和数据复盘能力","hard_bars":{"city":false}}',
    '2026-07-14T01:00:00.000Z'
  );
  INSERT INTO interview_session VALUES (1, 'C-AI-1', 1, 1);
`);
const sourceInterview = {
  schema_version: 'interview_report_v1',
  key_facts: [{ field_key: 'arrival', status: 'supported', value: '原始 AI 值' }],
};
const confirmedInterviewProjection = {
  schema_version: 'confirmed_interview_report_projection_v1',
  report_id: 1,
  session_id: 1,
  source_report_version: 2,
  source_report_hash: 'c'.repeat(64),
  confirmed_by: 'local-primary-operator',
  confirmed_at: '2026-07-14T01:30:00.000Z',
  report: {
    ...sourceInterview,
    key_facts: [{ field_key: 'arrival', status: 'supported', value: 'HR 修正后的三周' }],
  },
  fact_reviews: [{
    field_key: 'arrival',
    status: 'corrected',
    corrected_value: 'HR 修正后的三周',
    reviewed_by: 'local-primary-operator',
    reviewed_at: '2026-07-14T01:29:00.000Z',
  }],
};
applyAssessmentSchemaMigration(database);

const reportAnalysis = {
  schema_version: 'assessment_report_analysis_v2',
  report_type: 'career_potential',
  subject_name: '合成张三',
  summary: '市场类开拓型表现突出',
  strengths: ['主动开拓'],
  watchouts: ['稳定执行需核实'],
  career_matches: [{ category: '市场类', name: '开拓型', percentage: 82 }],
};
database.prepare(`
  INSERT INTO assessment_document (
    id, content_sha256, storage_relpath, byte_size, page_count, mime_detected,
    security_state, report_type, assessment_date, analysis_status,
    analysis_schema_version, analysis_json, review_state, lifecycle_state,
    legal_hold_state, created_by, version, created_at, updated_at
  ) VALUES (
    'DOC-AI-1', ?, 'accepted/ai.pdf', 128, 2, 'application/pdf',
    'accepted', 'career_potential', '2026-07-01', 'ready',
    'assessment_report_analysis_v2', ?, 'ready', 'active',
    'none', 'local-primary-operator', 1, '2026-07-14T01:00:00.000Z', '2026-07-14T01:00:00.000Z'
  )
`).run('a'.repeat(64), JSON.stringify(reportAnalysis));
database.prepare(`
  INSERT INTO assessment_binding (
    id, document_id, candidate_id, job_id, scope, state, conflict_state,
    identity_basis, actor_id, reason_code, request_id, version, created_at, updated_at
  ) VALUES (
    'BIND-AI-1', 'DOC-AI-1', 'C-AI-1', 1, 'candidate_job_archive', 'active', 'none',
    'current_candidate_context', 'local-primary-operator', 'synthetic_test', 'REQ-BIND-AI-1',
    1, '2026-07-14T01:00:00.000Z', '2026-07-14T01:00:00.000Z'
  )
`).run();
database.prepare(`
  INSERT INTO assessment_document (
    id, content_sha256, storage_relpath, byte_size, page_count, mime_detected,
    security_state, report_type, assessment_date, analysis_status,
    analysis_schema_version, analysis_json, review_state, lifecycle_state,
    legal_hold_state, created_by, version, created_at, updated_at
  ) VALUES (
    'DOC-AI-UNKNOWN', ?, 'accepted/unknown.pdf', 128, 1, 'application/pdf',
    'accepted', 'unknown', NULL, 'ready',
    'assessment_report_analysis_v2', ?, 'ready', 'active',
    'none', 'local-primary-operator', 1, '2026-07-14T01:00:00.000Z', '2026-07-14T01:00:00.000Z'
  )
`).run('b'.repeat(64), JSON.stringify({ ...reportAnalysis, report_type: 'unknown', summary: '未识别报告' }));
database.prepare(`
  INSERT INTO assessment_binding (
    id, document_id, candidate_id, job_id, scope, state, conflict_state,
    identity_basis, actor_id, reason_code, request_id, version, created_at, updated_at
  ) VALUES (
    'BIND-AI-UNKNOWN', 'DOC-AI-UNKNOWN', 'C-AI-1', 1, 'candidate_job_archive', 'active', 'none',
    'current_candidate_context', 'local-primary-operator', 'synthetic_test', 'REQ-BIND-AI-UNKNOWN',
    1, '2026-07-14T01:00:00.000Z', '2026-07-14T01:00:00.000Z'
  )
`).run();

const input = buildAssessmentAiInput(database, 'C-AI-1', 1);
assert.deepEqual(input.source_document_ids, ['DOC-AI-1']);
assert.equal(input.payload.assessments.some((item) => item.report_type === 'unknown'), false);
assert.deepEqual(input.allowed_evidence_refs, ['J1', 'R1', 'A1']);
assert.equal(input.payload.assessments[0].analysis.subject_name, undefined, 'candidate name must not be sent from assessment report');
assert.doesNotMatch(JSON.stringify(input.payload), /合成张三/, 'known candidate name must be redacted from external AI payload');
assert.doesNotMatch(buildAssessmentAiUserPrompt(input), /DOC-AI-1/, 'local document ids must not be sent to AI');

const parsed = parseAssessmentAiReply({
  schema_version: 'ignored-model-version',
  fit_score: 76.25,
  confidence: 'medium',
  overall: '岗位匹配较好，但需核实执行稳定性。',
  strengths: [{ point: '开拓和转化能力有交叉证据', evidence_refs: ['A1', 'R1', 'FORGED'] }],
  risks: [{ point: '执行稳定性待核实', evidence_refs: ['A1'] }],
  contradictions: [{ point: '无证据引用的内容应被丢弃', evidence_refs: ['FORGED'] }],
  interview_questions: [{ question: '请复盘一次直播项目', listen_for: '本人动作和数据链路', evidence_refs: ['R1', 'J1'] }],
  decision_support: { recommendation: 'advance', reason: '可进入下一轮核实。' },
}, { allowedEvidenceRefs: input.allowed_evidence_refs });
assert.equal(parsed.fit_score, 76.3);
assert.deepEqual(parsed.strengths[0].evidence_refs, ['A1', 'R1']);
assert.equal(parsed.contradictions.length, 0, 'claims with forged-only refs must not survive validation');

let capturedInput = null;
let assessmentAiCallCount = 0;
const service = createAssessmentProductService({
  database,
  dataRoot: path.resolve('/synthetic-only/assessment-ai'),
  selectionSecret: 'synthetic-assessment-ai-selection-secret-'.repeat(2),
  now: () => Date.parse('2026-07-14T02:00:00.000Z'),
  assessmentAiAssessor: async (assessmentInput) => {
    assessmentAiCallCount += 1;
    capturedInput = assessmentInput;
    return {
      fit_score: 77,
      confidence: 'high',
      overall: '合成 AI 综合结论。',
      strengths: [{ point: '匹配岗位方向', evidence_refs: ['J1', 'A1'] }],
      risks: [{ point: '执行稳定性待核实', evidence_refs: ['A1'] }],
      contradictions: [],
      interview_questions: [{ question: '如何稳定复盘？', listen_for: '方法和数据', evidence_refs: ['J1', 'A1'] }],
      decision_support: { recommendation: 'advance', reason: '合成证据支持推进。' },
    };
  },
});
const auditContext = {
  actor_id: 'local-primary-operator',
  actor_type: 'local_os_subject',
  actor_source: 'server_local_instance',
  actor_session_id: 'synthetic-session',
  assurance: 'local_instance_only',
};

async function checkApprovedGenerationRoute(runtime, getTransportCalls) {
  // Execute the shipped POST branch, including both approval stages, against
  // the real in-memory product service/runtime. Only HTTP framing and the
  // writable-candidate guard are supplied by this isolated fixture.
  const source = fs.readFileSync(path.join(__dirname, 'action-server.js'), 'utf8');
  const start = source.indexOf("    if (req.method === 'POST' && url.pathname === '/api/assessment/ai-analysis/generate') {");
  const end = source.indexOf("    if (req.method === 'GET' && url.pathname === '/api/assessment/queue') {", start);
  assert.ok(start >= 0 && end > start, 'the real assessment generation route must be tested');
  const config = runtime.publicConfig();
  const connection = { provider: config.provider, base_url: config.baseUrl, model: config.model };
  const secret = 'synthetic-assessment-route-approval-secret-0001';
  const purpose = 'assessment-ai-analysis';
  const materialHash = () => externalAiMaterialHash({
    database, dbApi: {}, purpose, targetId: 'C-AI-1', materialInput: { jobId: 1 },
  });
  const routedService = createAssessmentProductService({
    database, dataRoot: path.resolve('/synthetic-only/assessment-ai-route'),
    selectionSecret: secret, assessmentAiUsesExternal: true,
    assessmentAiAssessor: (input, authorization) => runtime.analyzeAssessmentPortfolio(input, authorization),
    assessmentAiStatus: () => runtime.externalAiStatus(),
  });
  let body;
  let bindingReads = 0;
  let serviceCalls = 0;
  let afterConsume = () => {};
  const running = new Set();
  const context = vm.createContext({
    ASSESSMENT_AI_PURPOSE: purpose,
    db: { assertCandidateJobRecruitingWritable(candidateId) {
      const row = database.prepare('SELECT job.status FROM candidate JOIN job ON job.id=candidate.job_id WHERE internal_id=?').get(candidateId);
      assert.equal(row?.status, 'open');
    } },
    principal: { actor_id: auditContext.actor_id }, f009ApprovalSecret: secret,
    consumedExternalAiApprovalNonces: new Set(), assessmentAiRunning: running,
    readBody: async () => body,
    currentExternalAiConnectionBinding() {
      bindingReads += 1;
      // A second read would capture a different connection than the approved
      // snapshot, even if it happened synchronously before the transport.
      return bindingReads === 1 ? connection : { ...connection, base_url: 'https://changed.example.test/v1' };
    },
    currentExternalAiMaterialHash: materialHash,
    consumeExternalAiUserApproval(...args) {
      const result = consumeExternalAiUserApproval(...args);
      afterConsume();
      return result;
    },
    issueExternalAiAuthorization,
    prepareAssessmentIngress: (dto) => prepareAssessmentIngress(dto, { HRBOSS_LOCAL_API_INSTANCE_ID: 'synthetic-assessment-route-instance' }),
    getAssessmentProductService: () => ({ generateAiAnalysis(options) {
      serviceCalls += 1;
      return routedService.generateAiAnalysis(options);
    } }),
    send: (_res, status, payload) => ({ status, ...payload }),
    sendAssessmentError: (_res, error) => ({ status: error.statusCode || 400, ok: false, error: error.message }),
  });
  const route = vm.runInContext(`(async (req, res, url) => {${source.slice(start, end)}})`, context);
  const approval = (requestId, binding = connection) => issueExternalAiUserApproval(secret, {
    purpose, targetId: 'C-AI-1', requestId, actor: auditContext.actor_id,
    materialSha256: materialHash(), ...binding,
  });
  const request = async (requestId, userApproval) => {
    body = { candidate_id: 'C-AI-1', job_id: 1, request_id: requestId, userApproval };
    bindingReads = 0;
    return route({ method: 'POST' }, {}, { pathname: '/api/assessment/ai-analysis/generate' });
  };
  const beforeCalls = getTransportCalls();
  const beforeReviews = database.prepare('SELECT COUNT(*) AS n FROM ai_review').get().n;
  const beforeRating = database.prepare('SELECT sabc FROM candidate WHERE internal_id=?').get('C-AI-1').sabc;
  const requestId = 'REQ-ASSESSMENT-ROUTE-APPROVED';
  const token = approval(requestId);
  const success = await request(requestId, token);
  assert.equal(success.status, 200, `valid native approval must reach generation: ${success.error || ''}`);
  assert.equal(success.analysis.fit_score, 71);
  assert.equal(bindingReads, 1, 'the consumed connection snapshot must be reused without recapturing config');
  assert.equal(getTransportCalls(), beforeCalls + 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM ai_review').get().n, beforeReviews + 1);
  assert.equal(database.prepare('SELECT sabc FROM candidate WHERE internal_id=?').get('C-AI-1').sabc, beforeRating);
  assert.equal(running.size, 0);
  assert.equal((await request(requestId, token)).status, 403, 'one-time approval cannot be replayed');
  assert.equal((await request('REQ-ROUTE-WRONG-ENDPOINT', approval('REQ-ROUTE-WRONG-ENDPOINT', {
    ...connection, base_url: 'https://wrong.example.test/v1',
  }))).status, 403, 'a token for another endpoint must fail before generation');
  assert.equal(getTransportCalls(), beforeCalls + 1);
  assert.equal(serviceCalls, 1);
  // If the active connection changes after consume, its old grant cannot be
  // reused by the new runtime configuration, and the running latch clears.
  afterConsume = () => runtime.configure({ baseUrl: 'https://changed.example.test/v1' });
  const changed = await request('REQ-ROUTE-CHANGED-AFTER-CONSUME', approval('REQ-ROUTE-CHANGED-AFTER-CONSUME'));
  assert.equal(changed.ok, false);
  assert.equal(bindingReads, 1);
  assert.equal(getTransportCalls(), beforeCalls + 1, 'changed connection must not send candidate material');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM ai_review').get().n, beforeReviews + 1);
  assert.equal(running.size, 0);
  afterConsume = () => {};
  runtime.configure({ baseUrl: connection.base_url, apiKey: 'synthetic-api-key' });
  await runtime.testModel({ model: connection.model });
  runtime.configure({ enabled: true });
  const recoveredId = 'REQ-ROUTE-RECOVERED';
  assert.equal((await request(recoveredId, approval(recoveredId))).status, 200,
    'a new approval can retry the same candidate/job after an earlier generation failure');
  assert.equal(bindingReads, 1);
  assert.equal(getTransportCalls(), beforeCalls + 2);
  assert.equal(running.size, 0);
  console.log('assessment approved route: PASS (generation, exact binding, replay, endpoint mismatch, changed connection, retry recovery)');
}

async function run() {
  const generated = await service.generateAiAnalysis({
    auditContext,
    command: { candidate_id: 'C-AI-1', job_id: 1, request_id: 'REQ-ASSESSMENT-AI-1' },
  });
  assert.equal(generated.fit_score, 77);
  assert.equal(generated.current, true);
  assert.equal(generated.ranking_eligible, true);
  assert.equal(assessmentAiCallCount, 1);
  assert.ok(capturedInput && capturedInput.payload.assessments.length === 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM ai_review').get().n, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = '测评AI综合分析'").get().n, 1);

  const listed = service.listAiAnalyses({
    auditContext,
    command: { candidate_id: 'C-AI-1', job_id: 1 },
  });
  assert.equal(listed[0].current, true);

  const ranked = attachAssessmentFitSignals(database, [{
    internal_id: 'C-AI-1', rec_position: '抖音运营', sabc: 'A', created_at: '2026-07-14',
  }], 1)[0];
  assert.equal(ranked.assessment_fit_score, 77);
  assert.equal(ranked.assessment_supplier_fit_score, 82);
  assert.equal(ranked.assessment_fit_source, 'ai');

  database.prepare(`
    INSERT INTO interview_report_v1 (
      id, session_id, status, version, report_json, content_hash, confirmed_by, confirmed_at
    ) VALUES (1, 1, 'confirmed', 3, ?, ?, 'local-primary-operator', '2026-07-14T01:30:00.000Z')
  `).run(JSON.stringify(sourceInterview), 'c'.repeat(64));
  database.prepare(`
    INSERT INTO interview_report_confirmed_projection (
      report_id, session_id, source_report_version, projection_json,
      content_hash, created_by, created_at
    ) VALUES (1, 1, 2, ?, ?, 'local-primary-operator', '2026-07-14T01:30:00.000Z')
  `).run(JSON.stringify(confirmedInterviewProjection), 'd'.repeat(64));
  const projectedInput = buildAssessmentAiInput(database, 'C-AI-1', 1);
  assert.deepEqual(projectedInput.allowed_evidence_refs, ['J1', 'R1', 'A1', 'I1']);
  assert.equal(projectedInput.payload.confirmed_interviews[0].report.key_facts[0].value, 'HR 修正后的三周');
  assert.doesNotMatch(JSON.stringify(projectedInput.payload.confirmed_interviews), /原始 AI 值/, 'assessment AI must consume the HR-authoritative projection');
  database.prepare('DELETE FROM interview_report_confirmed_projection WHERE report_id = 1').run();
  database.prepare('DELETE FROM interview_report_v1 WHERE id = 1').run();

  database.prepare(`
    INSERT INTO ai_review (candidate_id, job_id, profile_confirmed, report_json, created_at)
    VALUES ('C-AI-1', 1, 0, ?, '2026-07-14T02:01:00.000Z')
  `).run(JSON.stringify({
    schema_version: 'assessment_ai_analysis_record_v1',
    input_sha256: input.input_sha256,
    analysis: {
      fit_score: 99,
      confidence: 'low',
      decision_support: { recommendation: 'advance' },
    },
  }));
  const lowConfidenceFallback = attachAssessmentFitSignals(database, [{
    internal_id: 'C-AI-1', rec_position: '抖音运营', sabc: 'A', created_at: '2026-07-14',
  }], 1)[0];
  assert.equal(lowConfidenceFallback.assessment_fit_score, 82, 'low-confidence AI must fall back to supplier score');
  assert.equal(lowConfidenceFallback.assessment_fit_source, 'supplier');
  database.prepare("DELETE FROM ai_review WHERE created_at = '2026-07-14T02:01:00.000Z'").run();

  database.prepare("UPDATE assessment_document SET analysis_json = ?, version = 2 WHERE id = 'DOC-AI-1'")
    .run(JSON.stringify({ ...reportAnalysis, summary: '材料已经变化' }));
  const stale = service.listAiAnalyses({
    auditContext,
    command: { candidate_id: 'C-AI-1', job_id: 1 },
  });
  assert.equal(stale[0].current, false);
  const fallback = attachAssessmentFitSignals(database, [{
    internal_id: 'C-AI-1', rec_position: '抖音运营', sabc: 'A', created_at: '2026-07-14',
  }], 1)[0];
  assert.equal(fallback.assessment_fit_score, 82, 'stale AI analysis must fall back to current supplier evidence');
  assert.equal(fallback.assessment_fit_source, 'supplier');

  database.prepare("UPDATE job SET status = 'closed' WHERE id = 1").run();
  await assert.rejects(
    () => service.generateAiAnalysis({
      auditContext,
      command: { candidate_id: 'C-AI-1', job_id: 1, request_id: 'REQ-ASSESSMENT-AI-CLOSED' },
    }),
    (error) => error.code === 'ASSESSMENT_AI_JOB_CLOSED',
  );
  assert.equal(assessmentAiCallCount, 1, 'closed jobs must be rejected before the assessment AI mock is invoked');
  const closedHistory = service.listAiAnalyses({
    auditContext,
    command: { candidate_id: 'C-AI-1', job_id: 1 },
  });
  assert.equal(closedHistory.length >= 1, true, 'closed jobs must retain readable assessment AI history');
  assert.equal(closedHistory[0].current, false, 'closed-job assessment AI history must not be presented as a current runnable analysis');
  database.prepare("UPDATE job SET status = 'open' WHERE id = 1").run();

  let sentChatBody = null;
  let portfolioTransportCalls = 0;
  const syntheticModel = 'gpt-5.6-synthetic';
  const runtime = createF009LlmRuntime({
    env: {
      HRBOSS_EXTERNAL_AI_PROVIDER: 'synthetic',
      HRBOSS_EXTERNAL_AI_BASE_URL: 'https://ai.example.test/v1',
    },
    transport: async (request) => {
      assert.equal(request.provider, 'synthetic');
      assert.equal(request.baseUrl, 'https://ai.example.test/v1');
      if (request.path === '/v1/models') return { data: [{ id: syntheticModel }] };
      if (String(request.body?.messages?.[0]?.content || '').includes('hrboss_model_compatibility')) {
        return {
          model: syntheticModel,
          choices: [{ message: { content: JSON.stringify({ ok: true, purpose: 'hrboss_model_compatibility' }) } }],
        };
      }
      sentChatBody = request.body;
      portfolioTransportCalls += 1;
      return {
        model: syntheticModel,
        choices: [{ message: { content: JSON.stringify({
          fit_score: 71,
          confidence: 'medium',
          overall: '复用设置页凭据链路的合成结论。',
          strengths: [{ point: '岗位方向匹配', evidence_refs: ['J1', 'A1'] }],
          risks: [],
          contradictions: [],
          interview_questions: [],
          decision_support: { recommendation: 'hold', reason: '继续核实。' },
        }) } }],
      };
    },
  });
  runtime.configure({ enabled: true, apiKey: 'synthetic-api-key' });
  await runtime.refreshModels();
  await runtime.testModel({ model: syntheticModel });
  runtime.configure({ enabled: true });
  const externalAiConnection = runtime.publicConfig();
  const runtimeResult = await runtime.analyzeAssessmentPortfolio(
    buildAssessmentAiInput(database, 'C-AI-1', 1),
    issueExternalAiAuthorization({
      purpose: 'assessment-ai-analysis',
      confirmed: true,
      binding: {
        provider: externalAiConnection.provider,
        base_url: externalAiConnection.baseUrl,
        model: externalAiConnection.model,
      },
    }),
  );
  assert.equal(runtimeResult.fit_score, 71);
  assert.equal(sentChatBody.model, syntheticModel);
  assert.match(sentChatBody.messages[0].content, /同一候选人/);
  assert.doesNotMatch(JSON.stringify(sentChatBody), /合成张三|DOC-AI-1/);

  await checkApprovedGenerationRoute(runtime, () => portfolioTransportCalls);

  database.close();
  console.log(JSON.stringify({
    ok: true,
    contract: 'assessment-ai-analysis',
    open_job_mock_calls: assessmentAiCallCount,
    closed_job_mock_call_delta: 0,
    closed_job_history_readable: true,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
