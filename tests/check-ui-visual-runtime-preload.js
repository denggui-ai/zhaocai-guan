'use strict';

const { contextBridge } = require('electron');

const RUNTIME_SCENARIO = process.argv
  .find((argument) => argument.startsWith('--hrboss-runtime-scenario='))
  ?.split('=')[1] || 'normal';
const W4_GUIDE_INITIAL_MODE = process.argv
  .find((argument) => argument.startsWith('--hrboss-w4-guide-mode='))
  ?.split('=')[1] || 'ready';
const W4B_MODE = process.argv
  .find((argument) => argument.startsWith('--hrboss-w4b-mode='))
  ?.split('=')[1] || '';
const FORCE_EMPTY_JOBS_INITIAL = process.argv.includes('--hrboss-force-empty-jobs=1');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const JOB = Object.freeze({
  id: 9901,
  name: '合成岗位 · 运行态视觉门禁',
  status: 'open',
  department: '合成业务部',
  location: '杭州',
  hr_owner: '合成 HR',
  planned_hires: 2,
  hired_count: 0,
  remaining_hires: 2,
  candidate_count: 10,
  is_fixture: ['job-priority', 'w3-fixture'].includes(RUNTIME_SCENARIO) ? 1 : 0,
});

const W4_JOBS = Object.freeze([
  JOB,
  Object.freeze({
    ...JOB,
    id: 9902,
    name: '合成岗位 · 第二业务线运营负责人长名称回归',
    status: 'paused',
    department: '合成增长业务部',
    location: '上海',
    hr_owner: '合成 HR 二号',
    planned_hires: 3,
    hired_count: 1,
    remaining_hires: 2,
    candidate_count: 4,
    is_fixture: 0,
  }),
  Object.freeze({
    ...JOB,
    id: 9903,
    name: '合成岗位 · 已关闭历史岗位',
    status: 'closed',
    department: '合成历史业务部',
    location: '深圳',
    hr_owner: '合成 HR 三号',
    planned_hires: 1,
    hired_count: 1,
    remaining_hires: 0,
    candidate_count: 2,
    is_fixture: 0,
  }),
]);

const W4B_HISTORY_DEEP_PROFILE = Object.freeze({
  version: 3,
  status: 'confirmed',
  generated_at: '2026-07-18T08:00:00Z',
  confirmed_at: '2026-07-18T09:00:00Z',
  confirmed_by: '合成负责人',
  doc: Object.freeze({
    position_mission: Object.freeze({
      content: 'W4-B 旧版历史画像，仅用于验证恢复期间不丢失历史。',
      source: 'stated',
      quotes: Object.freeze(['合成历史原话']),
    }),
    hard_requirements: Object.freeze([
      Object.freeze({ item: '合成历史要求', detail: '恢复前的可追溯内容', source: 'stated', quotes: Object.freeze([]) }),
    ]),
    core_competencies: Object.freeze([]),
    plus_points: Object.freeze([]),
    minus_points: Object.freeze([]),
    deal_breakers: Object.freeze([]),
    implicit_preferences: Object.freeze([]),
    followup_questions: Object.freeze([]),
  }),
});

const W4B_LATEST_DEEP_PROFILE = Object.freeze({
  version: 4,
  status: 'draft',
  generated_at: '2026-07-21T12:00:00Z',
  doc: Object.freeze({
    position_mission: Object.freeze({
      content: 'W4-B 新版画像已从同一生成任务自动接管并读取。',
      source: 'stated',
      quotes: Object.freeze(['合成新版原话']),
    }),
    hard_requirements: Object.freeze([
      Object.freeze({ item: 'W4-B 新版硬性要求', detail: '轮询 done 后从本地最新状态重读', source: 'stated', quotes: Object.freeze([]) }),
    ]),
    core_competencies: Object.freeze([]),
    plus_points: Object.freeze([]),
    minus_points: Object.freeze([]),
    deal_breakers: Object.freeze([]),
    implicit_preferences: Object.freeze([]),
    followup_questions: Object.freeze([]),
  }),
});

const W4B_INTERVIEWS = Object.freeze([
  Object.freeze({
    id: 'SYN-W4B-INTERVIEW-1',
    job_id: JOB.id,
    source_type: 'manual_transcript',
    note: 'W4-B 合成负责人访谈',
    transcript: '这是仅存于 preload 内存的合成访谈文本，不读取真实文件。',
    created_at: '2026-07-18T07:00:00Z',
  }),
]);

const SYNTHETIC_PNG_BYTES = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
));

const CANDIDATE = Object.freeze({
  internal_id: 'SYN-VISUAL-1',
  job_id: JOB.id,
  name: '合成候选人 · 超长中文名称用于运行态布局回归',
  source: 'manual_resume',
  sabc: 'A',
  comm_status: '待沟通',
  disposition_status: 'new',
  workflow_status: 'contact_pending',
  rec_position: JOB.name,
  degree: '本科',
  school: '合成大学',
  work_years: '8 年',
  updated_at: '2026-07-19T00:00:00Z',
});

const CANDIDATES = Object.freeze([
  CANDIDATE,
  ...Array.from({ length: 9 }, (_, index) => Object.freeze({
    ...CANDIDATE,
    internal_id: `SYN-VISUAL-${index + 2}`,
    name: `合成候选人 ${String(index + 2).padStart(2, '0')} · 中文长名称回归`,
    sabc: ['S', 'A', 'B', 'C'][index % 4],
  })),
]);

const JOB_CONTEXT_RACE_JOBS = Object.freeze([
  Object.freeze({
    ...JOB,
    id: 9911,
    name: '合成竞态岗位 A',
    candidate_count: 1,
    is_fixture: 0,
  }),
  Object.freeze({
    ...JOB,
    id: 9912,
    name: '合成竞态岗位 B',
    candidate_count: 1,
    is_fixture: 0,
  }),
]);

const JOB_CONTEXT_RACE_CANDIDATES = Object.freeze({
  9911: Object.freeze([Object.freeze({
    ...CANDIDATE,
    internal_id: 'SYN-RACE-A-1',
    job_id: 9911,
    name: '合成竞态候选人 A',
    rec_position: '合成竞态岗位 A',
  })]),
  9912: Object.freeze([Object.freeze({
    ...CANDIDATE,
    internal_id: 'SYN-RACE-B-1',
    job_id: 9912,
    name: '合成竞态候选人 B',
    rec_position: '合成竞态岗位 B',
  })]),
});

const WORKBENCH_TODOS = Object.freeze([
  {
    todo_id: 'SYN-TODO-SCHEDULE',
    code: 'schedule_confirmation_required',
    candidate_id: CANDIDATES[0].internal_id,
    job_id: JOB.id,
    priority: 'normal',
    blocking: true,
    action: { type: 'open_candidate', target_id: CANDIDATES[0].internal_id },
  },
  {
    todo_id: 'SYN-TODO-REPORT',
    code: 'report_draft_required',
    candidate_id: CANDIDATES[1].internal_id,
    job_id: JOB.id,
    priority: 'normal',
    blocking: false,
    action: { type: 'open_candidate', target_id: CANDIDATES[1].internal_id },
  },
  ...CANDIDATES.map((candidate, index) => ({
    todo_id: `SYN-TODO-RATING-${index + 1}`,
    code: 'candidate_rating_required',
    candidate_id: candidate.internal_id,
    job_id: JOB.id,
    priority: 'normal',
    blocking: false,
    action: { type: 'open_candidate', target_id: candidate.internal_id },
  })),
].map((todo) => Object.freeze({
  ...todo,
  source: {
    entity_type: 'candidate',
    entity_id: todo.candidate_id,
    status: 'synthetic',
    time: CANDIDATE.updated_at,
  },
})));

const RESUME_INTAKE_DRAFT = Object.freeze({
  draft_id: 'SYN-RESUME-INTAKE-EMPTY-NAME',
  job_id: JOB.id,
  job_name: JOB.name,
  file_name: '合成简历-缺少姓名.pdf',
  extraction_source: 'attachment_only',
  text_extracted: false,
  fields: Object.freeze({ name: '', degree: '本科', school: '合成大学', work_years: '5 年', salary: '' }),
  text_preview: '合成简历正文：本样本故意缺少姓名，用于验证必填错误聚焦。',
});

const ASSESSMENT_ARCHIVE = Object.freeze({
  binding_id: 'SYN-ASSESSMENT-BINDING-1',
  binding_version: 1,
  document_id: 'SYN-ASSESSMENT-DOCUMENT-1',
  document_version: 1,
  candidate_id: CANDIDATE.internal_id,
  job_id: JOB.id,
  report_type: 'career_potential',
  analysis_status: 'ready',
  binding_state: 'active',
  lifecycle_state: 'active',
  legal_hold_state: 'none',
  review_state: 'ready',
  created_at: '2026-07-18T08:00:00Z',
  analysis: Object.freeze({
    subject_name: CANDIDATE.name,
    assessed_job: JOB.name,
    validity: '中',
    summary: '合成供应商报告用于验证证据优先布局，不代表真实候选人结论。',
    source: 'synthetic_runtime_fixture',
    highlights: Object.freeze([
      Object.freeze({ label: '项目推进', value: '在合成材料中表现出结构化推进倾向' }),
      Object.freeze({ label: '协作方式', value: '需要通过面试核验跨团队沟通细节' }),
    ]),
    career_matches: Object.freeze([
      Object.freeze({ category: '技术类', name: '交付协同', percentage: 78.6 }),
      Object.freeze({ category: '研发类', name: '方案设计', percentage: 71.2 }),
    ]),
    watchouts: Object.freeze(['供应商自陈材料不能替代实际项目证据。']),
    interview_questions: Object.freeze(['请用一个完整项目说明本人动作、结果与复盘。']),
  }),
});

const ASSESSMENT_AI_ANALYSIS = Object.freeze({
  current: true,
  ranking_eligible: true,
  created_at: '2026-07-19T08:00:00Z',
  analysis: Object.freeze({
    fit_score: 76.3,
    confidence: 'medium',
    overall: '合成证据显示岗位方向基本匹配，但缺少已确认面试引用，需由 HR 继续核验。',
    strengths: Object.freeze([
      Object.freeze({ point: '岗位要求与合成项目经历存在交叉证据。', evidence_refs: Object.freeze(['J1', 'R1']) }),
    ]),
    risks: Object.freeze([
      Object.freeze({ point: '供应商材料中的协作结论仍需事实验证。', evidence_refs: Object.freeze(['A1']) }),
    ]),
    contradictions: Object.freeze([]),
    interview_questions: Object.freeze([
      Object.freeze({ question: '请复盘一次跨团队交付。', listen_for: '本人动作、量化结果与复盘', evidence_refs: Object.freeze(['J1', 'R1', 'A1']) }),
    ]),
    decision_support: Object.freeze({ recommendation: 'hold', reason: '先补齐面试证据，再由 HR 决定是否推进。' }),
  }),
});

const MODULE_STATE_INTERVIEW_SESSION = Object.freeze({
  id: 8801,
  candidate_id: CANDIDATE.internal_id,
  candidate_name: CANDIDATE.name,
  job_id: JOB.id,
  round: 1,
  status: 'draft',
  interview_format: 'online',
  mode: 'online',
  scheduled_at: null,
  interviewer_assignments: Object.freeze([]),
  schedule_confirmations: Object.freeze([]),
  invitation_status: 'not_sent',
  candidate_confirmation_status: 'pending',
});

const W3_INTERVIEW_SESSIONS = Object.freeze([
  Object.freeze({
    id: 8811,
    candidate_id: CANDIDATE.internal_id,
    candidate_name: CANDIDATE.name,
    job_id: JOB.id,
    round: 2,
    status: 'scheduled',
    interview_format: 'online',
    mode: 'online',
    scheduled_at: '2026-08-03T02:00:00Z',
    duration_minutes: 45,
    interviewer_assignments: Object.freeze([
      Object.freeze({ interviewer_id: 7701, interviewer_name_snapshot: '合成面试官', role: 'lead' }),
    ]),
    meeting_platform: '合成会议',
    meeting_link: 'https://fixture.invalid/w3-current',
    logistics_note: '合成当前面试，仅用于运行态验收。',
    invitation_status: 'not_sent',
    candidate_confirmation_status: 'pending',
    schedule_confirmations: Object.freeze([]),
    logistics_version: 1,
    materials: Object.freeze([
      Object.freeze({
        id: 18811,
        source_kind: 'manual_note',
        source_status: 'active',
        text_preview: '合成面试材料，仅用于验证首次启用与返回，不包含真实候选人数据。',
      }),
    ]),
  }),
  Object.freeze({
    id: 8810,
    candidate_id: CANDIDATE.internal_id,
    candidate_name: CANDIDATE.name,
    job_id: JOB.id,
    round: 1,
    status: 'confirmed',
    report_status: 'confirmed',
    interview_format: 'online',
    mode: 'online',
    scheduled_at: '2026-07-10T02:00:00Z',
    duration_minutes: 45,
    interviewer_assignments: Object.freeze([
      Object.freeze({ interviewer_id: 7701, interviewer_name_snapshot: '合成面试官', role: 'lead' }),
    ]),
    meeting_platform: '合成会议',
    meeting_link: 'https://fixture.invalid/w3-history',
    logistics_note: '合成历史面试，仅用于运行态验收。',
    invitation_status: 'sent',
    invitation_sent_by: '合成 HR',
    invitation_sent_at: '2026-07-09T02:00:00Z',
    candidate_confirmation_status: 'confirmed',
    candidate_confirmation_recorded_by: '合成 HR',
    candidate_confirmation_recorded_at: '2026-07-09T03:00:00Z',
    schedule_confirmations: Object.freeze([]),
    logistics_version: 1,
  }),
]);

const MODULE_STATE_TALENTS = Object.freeze([
  Object.freeze({
    pool_id: 'SYN-TALENT-1',
    primary_candidate_id: CANDIDATES[0].internal_id,
    name: '合成人才甲',
    pool_status: 'reactivable',
    pool_status_label: '可再激活',
    pool_status_reason: '合成历史证据完整，可由 HR 人工复核。',
    recommendation: Object.freeze({
      group: 'strong',
      group_label: '强推荐',
      outreach_draft: '合成再触达草稿甲',
      reasons: Object.freeze([]),
      unknowns: Object.freeze([]),
      risks: Object.freeze([]),
      uncertainties: Object.freeze([]),
    }),
    latest_job: Object.freeze({ job_id: 9801, name: '合成历史岗位甲' }),
    historical_job_count: 1,
    last_interaction_at: '2026-07-18T08:00:00Z',
    data_observed_at: '2026-07-18T08:00:00Z',
    core_tags: Object.freeze(['合成标签甲']),
    contact_state: Object.freeze({
      label: '授权已核验',
      has_record: true,
      has_valid_contact_method: true,
      consent_confirmed: true,
      opt_out_status_confirmed: true,
      needs_consent_check: false,
      contact_ready: true,
    }),
    evidence_completeness: Object.freeze({ percent: 80, known_items: Object.freeze(['岗位经历']), unknown_items: Object.freeze([]) }),
    history: Object.freeze([]),
  }),
  Object.freeze({
    pool_id: 'SYN-TALENT-2',
    primary_candidate_id: CANDIDATES[1].internal_id,
    name: '合成人才乙',
    pool_status: 'need_info',
    pool_status_label: '待补信息',
    pool_status_reason: '合成材料仍需 HR 补充核验。',
    recommendation: Object.freeze({
      group: 'cultivate',
      group_label: '可培养',
      outreach_draft: '合成再触达草稿乙',
      reasons: Object.freeze([]),
      unknowns: Object.freeze(['近期意愿']),
      risks: Object.freeze([]),
      uncertainties: Object.freeze([]),
    }),
    latest_job: Object.freeze({ job_id: 9802, name: '合成历史岗位乙' }),
    historical_job_count: 1,
    last_interaction_at: '2026-07-17T08:00:00Z',
    data_observed_at: '2026-07-17T08:00:00Z',
    core_tags: Object.freeze(['合成标签乙']),
    contact_state: Object.freeze({
      label: '授权已核验',
      has_record: true,
      has_valid_contact_method: true,
      consent_confirmed: true,
      opt_out_status_confirmed: true,
      needs_consent_check: false,
      contact_ready: true,
    }),
    evidence_completeness: Object.freeze({ percent: 60, known_items: Object.freeze(['基础资料']), unknown_items: Object.freeze(['近期意愿']) }),
    history: Object.freeze([]),
  }),
]);

const MODULE_STATE_TALENT_POOL = Object.freeze({
  source: 'local_db',
  active_job: JOB,
  overview: Object.freeze([]),
  statuses: Object.freeze([
    Object.freeze({ key: 'reactivable', label: '可再激活', color: 'green' }),
    Object.freeze({ key: 'need_info', label: '待补信息', color: 'gold' }),
  ]),
  status_counts: Object.freeze({ reactivable: 1, need_info: 1 }),
  job_recommendations: Object.freeze(MODULE_STATE_TALENTS.map((talent) => Object.freeze({ pool_id: talent.pool_id }))),
  talents: MODULE_STATE_TALENTS,
  compliance_notes: Object.freeze([]),
});

let resumeCommitCalls = 0;
let actionWriteCalls = 0;
let candidateListReads = 0;
let forceEmptyJobs = FORCE_EMPTY_JOBS_INITIAL;
let forceJobsError = false;
let failNextCandidateListRead = false;
let jobContextRaceDelays = {};
let jobContextRaceRequests = [];
let jobContextRaceSequence = 0;
let jobContextRaceCompletionSequence = 0;
let resumeDraftSelectionCalls = 0;
let screenshotDirectorySelectionCalls = 0;
let screenshotDirectoryDelayMs = 0;
const candidateAuthorityWriteCalls = {
  resumeCommit: 0,
  screenshotImport: 0,
  screenshotOcr: 0,
  rate: 0,
};
let moduleStateJobReads = 0;
let moduleStateInterviewSessionReads = 0;
let moduleStateTalentPoolReads = 0;
let moduleStateTalentWorkspaceRefreshes = 0;
let moduleStateTalentAddCommitted = false;
let summarySelectionMode = 'cancel';
let summarySelectorCalls = 0;
let summaryImportCalls = 0;
let w3LiveAudioMode = 'live-low';
let w3ProgressGets = 0;
let w3StopPosts = 0;
let w3StopProgressGets = 0;
let w3StopRequested = false;
let w3RecordingStopped = false;
let w3LastStopRequest = null;
let w4GuideMode = ['ready', 'error', 'stale'].includes(W4_GUIDE_INITIAL_MODE)
  ? W4_GUIDE_INITIAL_MODE
  : 'ready';
let w4AssessmentImportCalls = 0;
let w4PreviewPage1Reads = 0;
let w4PreviewPage2Reads = 0;
let w4bProgressGets = 0;
let w4bProfileGets = 0;
let w4bInterviewGets = 0;
let w4bPreflightGets = 0;
let w4bApprovalCalls = 0;
let w4bInterviewPreviewCalls = 0;
let w4bGeneratePosts = 0;
let w4bTaskStarts = 0;
let w4bExternalTransportCalls = 0;
let w4bGenerationStarted = false;
let w4bLatestProfileReady = false;
let w4bBootstrapObserved = false;
let w4bPostStartProgressGets = 0;
let w4bLastApproval = null;
let w4bLastGenerate = null;
let w4bAiProvider = 'openai-compatible';
let w4bAiBaseUrl = '';
let w4bAiKeyConfigured = false;
let w4bAiModelVerified = false;
let w4bAiConfigured = false;
const w4bProgressByJob = Object.create(null);

function w4bActive() {
  return RUNTIME_SCENARIO === 'w4-runtime' && Boolean(W4B_MODE);
}

function w4bJobId(requestPath) {
  try {
    return Number(new URL(requestPath, 'http://hrboss.synthetic').searchParams.get('jobId')) || null;
  } catch {
    return null;
  }
}

function w4bProfileResponse() {
  const useLatest = W4B_MODE === 'seeded-done' || w4bLatestProfileReady;
  return ok({
    config: {
      schema_version: 'synthetic_w4b_profile_v1',
      deep_profile: useLatest ? W4B_LATEST_DEEP_PROFILE : W4B_HISTORY_DEEP_PROFILE,
    },
    generation_readiness: {
      ready: true,
      code: 'READY',
      message: 'W4-B 合成 JD、已确认画像与访谈材料已就绪。',
    },
  });
}

function ok(body = {}) {
  return { status: 200, body: { ok: true, ...body } };
}

async function request(input = {}) {
  const requestPath = String(input.requestPath || '');
  const method = String(input.method || 'GET').toUpperCase();
  if (input.service === 'action' && method !== 'GET') {
    actionWriteCalls += 1;
    if (requestPath === '/candidate/resume-intake/commit') candidateAuthorityWriteCalls.resumeCommit += 1;
    if (requestPath === '/screenshot-import/start') candidateAuthorityWriteCalls.screenshotImport += 1;
    if (/^\/screenshot-ocr-drafts\/[^/?]+\/(?:edit|confirm|reject)$/.test(requestPath)) candidateAuthorityWriteCalls.screenshotOcr += 1;
    if (requestPath === '/rate') candidateAuthorityWriteCalls.rate += 1;
  }
  if (w4bActive() && requestPath.startsWith('/deep-profile/progress?') && method === 'GET') {
    const jobId = w4bJobId(requestPath);
    w4bProgressGets += 1;
    w4bProgressByJob[jobId] = Number(w4bProgressByJob[jobId] || 0) + 1;
    if (W4B_MODE === 'idle-recovery') {
      if (!w4bGenerationStarted) {
        if (!w4bBootstrapObserved) w4bBootstrapObserved = true;
        else w4bPreflightGets += 1;
        return ok({ status: 'idle', job_id: jobId });
      }
      w4bPostStartProgressGets += 1;
      if (w4bPostStartProgressGets === 1) {
        await delay(400);
        return ok({ status: 'running', job_id: jobId });
      }
      if (w4bPostStartProgressGets === 2) {
        return ok({ status: 'running', job_id: jobId });
      }
      w4bLatestProfileReady = true;
      return ok({ status: 'done', job_id: jobId });
    }
    if (W4B_MODE === 'seeded-done') return ok({ status: 'done', job_id: jobId });
    if (W4B_MODE === 'seeded-error' || W4B_MODE === 'closed') {
      return ok({
        status: 'error',
        job_id: jobId,
        error: W4B_MODE === 'closed'
          ? '合成已关闭岗位的历史任务未完成。'
          : '合成任务失败：保留旧版画像等待 HR 显式重试。',
      });
    }
    if (W4B_MODE === 'unknown') return ok({ status: 'orphaned', job_id: jobId });
    return ok({ status: 'idle', job_id: jobId });
  }
  if (w4bActive() && requestPath === '/deep-profile/generate' && method === 'POST') {
    w4bGeneratePosts += 1;
    w4bLastGenerate = {
      jobId: Number(input.body?.jobId) || null,
      requestId: String(input.body?.requestId || ''),
      userApprovalPresent: Boolean(input.body?.userApproval),
    };
    if (W4B_MODE === 'approval-stale') {
      return {
        status: 403,
        body: {
          ok: false,
          code: 'external_ai_confirmation_required',
          error: '一次性确认已过期：当前材料已变化，授权与材料不一致。',
        },
      };
    }
    if (W4B_MODE === 'idle-recovery') {
      w4bGenerationStarted = true;
      w4bTaskStarts += 1;
      return ok({ started: true, job_id: Number(input.body?.jobId) || null });
    }
    return { status: 409, body: { ok: false, error: 'W4-B 合成模式不允许启动任务。' } };
  }
  if (w4bActive() && requestPath.startsWith('/profile?') && method === 'GET') {
    w4bProfileGets += 1;
    return w4bProfileResponse();
  }
  if (w4bActive() && requestPath.startsWith('/interview?') && method === 'GET') {
    w4bInterviewGets += 1;
    const jobId = w4bJobId(requestPath);
    return ok({ interviews: W4B_INTERVIEWS.map((item) => ({ ...item, job_id: jobId })) });
  }
  if (W4B_MODE === 'ai-unconfigured'
      && w4bAiConfigured
      && requestPath === '/interview-report/llm/preview'
      && method === 'POST') {
    w4bInterviewPreviewCalls += 1;
    const materialIds = Array.isArray(input.body?.materialIds)
      ? input.body.materialIds.map(Number).filter(Number.isSafeInteger)
      : [];
    return ok({
      preview: {
        provider: 'synthetic',
        baseUrl: 'https://ai.example.test/v1',
        model: 'synthetic-text-model',
        sessionId: Number(input.body?.sessionId) || 8811,
        materialIds,
        requestId: String(input.body?.requestId || 'SYN-W4B-INTERVIEW-PREVIEW'),
        requestHash: 'a'.repeat(64),
        units: materialIds.map((materialId) => ({
          materialId,
          text: '合成面试材料：仅用于验证配置后返回会停在发送预览，不含真实候选人数据。',
        })),
        context: {
          hard_requirements: [{ id: 'SYN-HARD-1', label: '能复盘合成业务过程' }],
          confirmed_resume_facts: [],
          confirmed_assessments: [],
        },
      },
    });
  }
  if (requestPath === '/interview-recording/import-summary' && method === 'POST') {
    summaryImportCalls += 1;
    return ok({ recording: { id: 8899 } });
  }
  if (RUNTIME_SCENARIO === 'w4-runtime' && requestPath === '/assessment/preview' && method === 'POST') {
    return ok({ preview: { preview_id: 'SYN-W4-PREVIEW', page_count: 2 } });
  }
  const w4PreviewMatch = requestPath.match(/^\/assessment\/preview\/SYN-W4-PREVIEW\/page\/(1|2)$/);
  if (RUNTIME_SCENARIO === 'w4-runtime' && w4PreviewMatch && method === 'GET') {
    if (w4PreviewMatch[1] === '1') w4PreviewPage1Reads += 1;
    else {
      w4PreviewPage2Reads += 1;
      await delay(700);
    }
    return { status: 200, body: SYNTHETIC_PNG_BYTES, contentType: 'image/png' };
  }
  if (requestPath === '/talent-pool/add-to-job' && method === 'POST') {
    if (RUNTIME_SCENARIO === 'module-states') await delay(700);
    if (RUNTIME_SCENARIO === 'module-states') moduleStateTalentAddCommitted = true;
    return ok({
      relation: {
        inserted: true,
        do_not_contact_preserved: false,
        candidate: { internal_id: CANDIDATES[1].internal_id },
      },
    });
  }
  if (requestPath === '/candidate/resume-intake/commit') {
    resumeCommitCalls += 1;
    if (RUNTIME_SCENARIO === 'normal') {
      await delay(500);
      if (resumeCommitCalls === 1) {
        return { status: 503, body: { ok: false, error: '合成简历建档拒绝，用于验证草稿保留与重试。' } };
      }
    }
    return ok({ result: { candidate_id: CANDIDATE.internal_id, duplicate: false } });
  }
  if (requestPath === '/jobs') {
    if (forceEmptyJobs) return ok({ jobs: [] });
    if (forceJobsError) return { status: 503, body: { ok: false, error: '合成岗位台账竞态错误。' } };
    if (RUNTIME_SCENARIO === 'module-states') {
      moduleStateJobReads += 1;
      if (moduleStateJobReads <= 4) {
        await delay(350);
        return { status: 503, body: { ok: false, error: '合成岗位台账读取失败，用于验证错误不等于空台账。' } };
      }
    }
    if (RUNTIME_SCENARIO === 'loading-error') await delay(500);
    return ok({
      jobs: RUNTIME_SCENARIO === 'w4-runtime'
        ? W4_JOBS
        : RUNTIME_SCENARIO === 'job-context-race'
          ? JOB_CONTEXT_RACE_JOBS
          : [JOB],
    });
  }
  if (requestPath.startsWith('/candidates?')) {
    candidateListReads += 1;
    if (RUNTIME_SCENARIO === 'job-context-race') {
      const requestedJobId = Number(new URL(requestPath, 'http://hrboss.fixture').searchParams.get('jobId'));
      const requestRecord = {
        sequence: ++jobContextRaceSequence,
        jobId: requestedJobId,
        delayMs: Number(jobContextRaceDelays[requestedJobId]) || 0,
        completedSequence: null,
      };
      jobContextRaceRequests.push(requestRecord);
      if (requestRecord.delayMs > 0) await delay(requestRecord.delayMs);
      requestRecord.completedSequence = ++jobContextRaceCompletionSequence;
      return ok({ candidates: JOB_CONTEXT_RACE_CANDIDATES[requestedJobId] || [] });
    }
    if (failNextCandidateListRead) {
      failNextCandidateListRead = false;
      return { status: 503, body: { ok: false, error: '合成候选人读取失败，用于验证岗位打开失败时保留焦点。' } };
    }
    if (RUNTIME_SCENARIO === 'loading-error') {
      if (candidateListReads === 1 || candidateListReads === 3) {
        await delay(candidateListReads === 1 ? 2400 : 500);
        return { status: 503, body: { ok: false, error: '合成候选人读取失败，用于验证错误不等于空数据。' } };
      }
    }
    if (RUNTIME_SCENARIO === 'normal' && resumeCommitCalls >= 2) await delay(700);
    if (RUNTIME_SCENARIO === 'module-states' && moduleStateTalentAddCommitted) {
      moduleStateTalentWorkspaceRefreshes += 1;
      if (moduleStateTalentWorkspaceRefreshes === 1) {
        return { status: 503, body: { ok: false, error: '合成候选人工作区刷新未应用。' } };
      }
      moduleStateTalentAddCommitted = false;
    }
    return ok({ candidates: CANDIDATES });
  }
  const candidatePathMatch = requestPath.match(/^\/candidates\/([^/?]+)(?:\/([^?]+))?/);
  const requestedCandidate = candidatePathMatch
    ? CANDIDATES.find((candidate) => candidate.internal_id === decodeURIComponent(candidatePathMatch[1]))
    : null;
  if (requestedCandidate && !candidatePathMatch[2]) return ok({ candidate: requestedCandidate });
  if (requestedCandidate && candidatePathMatch[2] === 'children') {
    const resume = RUNTIME_SCENARIO === 'candidate-resume-layout' ? [{
      id: 1,
      candidate_id: requestedCandidate.internal_id,
      is_paywalled: 0,
      sections_json: JSON.stringify({
        basic: [{ description: '完全虚构的简历，仅用于检查长经历在候选人窄详情栏中的可读性。' }],
        work: [{
          company: '虚构星河科技有限公司',
          title: 'Java 后端工程师 · 负责虚构订单系统的接口开发、数据建模和性能优化。',
          start: '202107', end: '202606',
          desc: '与测试人员协作补齐回归用例，整理部署与排错说明。',
        }],
        proj: [{
          name: '虚构电商订单服务',
          role: '使用Redis 缓存测试数据，建立请求日志与告警规则',
          start: '202107', end: '202606',
          desc: '基于 Spring Boot 与 MySQL 完成订单查询与状态管理。',
        }, {
          name: 'SYNTHETIC_PROJECT_IDENTIFIER_WITHOUT_SPACES_FOR_RESUME_WIDTH_REGRESSION',
          role: 'SyntheticRoleWithoutSpacesForTestingSafeWrappingAndReadableTitles',
          desc: '独立的完全虚构长标识符边界，不包含真实材料。',
        }],
        edu: [{ school: '虚构明理大学', major: '软件工程', degree: '本科', start: '201709', end: '202106' }],
        expect: [{ position: 'Java 后端工程师', salary: '18-25K' }],
        skill: [{ text: 'Java' }],
      }),
    }] : [];
    return ok({ children: { resume_online: resume, resume_attachment: [], ai_review: [], status_history: [], comment: [], contact: [] } });
  }
  if (requestedCandidate && candidatePathMatch[2] === 'write-actions') return ok({ actions: [] });
  if (requestPath.startsWith('/candidate-timeline?')) {
    return ok({
      timeline: {
        data_class: 'formal',
        workflow_status: 'contact_pending',
        pending_todos: [{
          todo_id: 'SYN-TODO-1',
          code: 'contact_required',
          source: { entity_type: 'candidate', entity_id: CANDIDATE.internal_id, status: 'contact_pending', time: CANDIDATE.updated_at },
        }],
        events: [
          {
            event_id: 'SYN-EVENT-1',
            summary: '候选人进入本地岗位候选池。',
            status_code: 'new',
            source_entity: { type: 'candidate', id: CANDIDATE.internal_id },
            occurred_at: CANDIDATE.updated_at,
          },
          {
            event_id: 'SYN-EVENT-2',
            summary: '人工确认一条用于验证长标题不会逐字竖排的招聘进展。',
            status_code: 'contact_pending',
            source_entity: { type: 'candidate', id: CANDIDATE.internal_id },
            occurred_at: CANDIDATE.updated_at,
          },
        ],
      },
    });
  }
  if (requestPath.startsWith('/workbench?')) {
    if (RUNTIME_SCENARIO === 'w4-runtime' && w4GuideMode !== 'ready') {
      await delay(900);
      return { status: 503, body: { ok: false, error: '合成使用指南状态读取失败；不代表空数据。' } };
    }
    const w3Runtime = RUNTIME_SCENARIO === 'w3-formal' || RUNTIME_SCENARIO === 'w3-fixture';
    const requestedWorkbenchJobId = Number(new URL(requestPath, 'http://hrboss.fixture').searchParams.get('jobId'));
    const workbenchCandidates = RUNTIME_SCENARIO === 'job-context-race'
      ? JOB_CONTEXT_RACE_CANDIDATES[requestedWorkbenchJobId] || []
      : CANDIDATES;
    return ok({
      workbench: {
        data_class: RUNTIME_SCENARIO === 'w3-fixture' ? 'fixture' : 'formal',
        metrics: {
          candidate_count: workbenchCandidates.length,
          rated_count: 0,
          workflow_counts: { interview_pending_schedule: 1, report_pending_confirmation: 1 },
        },
        candidates: workbenchCandidates,
        todos: RUNTIME_SCENARIO === 'job-context-race' ? [] : WORKBENCH_TODOS,
        interview_sessions: RUNTIME_SCENARIO === 'module-states'
          ? [MODULE_STATE_INTERVIEW_SESSION]
          : w3Runtime ? W3_INTERVIEW_SESSIONS : [],
      },
    });
  }
  if (requestPath.startsWith('/screenshot-ocr-drafts?')) return ok({ drafts: [] });
  if (requestPath === '/screenshot-import/progress') return ok({ progress: null });
  if (requestPath === '/assessment/status' || requestPath === '/assessment/capabilities') {
    return ok({
      enabled: true,
      scope: 'hr_manual_assessment_reference',
      decision_use: true,
      automated_decision_use: false,
      automatic_scoring_enabled: false,
      automatic_ranking_enabled: false,
      automatic_disposition_enabled: false,
      internal_feature_available: true,
      archive_read_enabled: true,
      import_enabled: true,
      local_tool_capabilities: ['synthetic_pdf_probe', 'synthetic_png_preview'],
      missing_required_dependencies: [],
      text_analysis_available: true,
      text_analysis_mode: 'synthetic_fixture',
      retention_policy_configured: true,
      retention_policy_version: 'hrboss-internal-assessment-v1',
      retention_days: 365,
      delete_enabled: true,
      export_enabled: false,
    });
  }
  if (requestPath.startsWith('/assessment/archive?')) return ok({ archives: [ASSESSMENT_ARCHIVE] });
  if (requestPath.startsWith('/assessment/queue?')) return ok({ queue: [] });
  if (requestPath.startsWith('/assessment/ai-analysis?')) return ok({ analyses: [ASSESSMENT_AI_ANALYSIS] });
  if (requestPath.startsWith('/assess/status?')) {
    return ok({
      status: {
        candidate_found: true,
        current_profile_ready: true,
        can_real_assess: W4B_MODE === 'ai-unconfigured' && w4bAiConfigured,
        can_local_demo: true,
        blockers: w4bAiConfigured ? [] : ['合成外部 AI 配置尚未完成。'],
      },
    });
  }
  if (requestPath === '/llm/config') {
    if (W4B_MODE) {
      if (W4B_MODE === 'ai-unconfigured' && !w4bAiConfigured) return ok({ config: w4bAiConfig() });
      return ok({
        config: w4bAiConfig({
          enabled: true,
          forceConfigured: W4B_MODE !== 'ai-unconfigured',
        }),
      });
    }
    return ok({
      config: {
        provider: 'synthetic',
        baseUrl: 'https://ai.example.test/v1',
        enabled: true,
        apiKeyConfigured: true,
        model: 'synthetic-text-model',
        modelVerified: true,
        availableModels: [{
          id: 'synthetic-text-model',
          family: 'other',
          label: 'synthetic-text-model',
          tier: '可选模型',
          recommendation: '',
          reason: '合成兼容性测试模型',
          verified: true,
          verification: 'chat-completions-strict-json-v1',
        }],
      },
    });
  }
  if (requestPath === '/config/ai') return ok({ enabled: false });
  if (requestPath.startsWith('/interview?')) return ok({ interviews: [] });
  if (requestPath.startsWith('/interview-session?')) {
    if (RUNTIME_SCENARIO === 'module-states') {
      moduleStateInterviewSessionReads += 1;
      if (moduleStateInterviewSessionReads === 1) {
        return { status: 503, body: { ok: false, error: '合成正式面试权威读取失败。' } };
      }
      return ok({ sessions: [MODULE_STATE_INTERVIEW_SESSION] });
    }
    if (RUNTIME_SCENARIO === 'w3-formal') return ok({ sessions: W3_INTERVIEW_SESSIONS });
    return ok({ sessions: [] });
  }
  if (requestPath.startsWith('/interviewers')) {
    return ok({ interviewers: [{ id: 7701, name: '合成面试官', active: 1 }] });
  }
  if (requestPath.startsWith('/profile?')) return ok({ config: null });
  if (requestPath === '/interview/import-lark/status') {
    return ok({ enabled: false, status: 'unavailable' });
  }
  if (requestPath === '/local-interview/record/stop'
      && RUNTIME_SCENARIO === 'w3-formal'
      && method === 'POST') {
    w3StopPosts += 1;
    w3LastStopRequest = {
      taskId: String(input.body?.taskId || ''),
      candidateId: String(input.body?.candidateId || ''),
      jobId: Number(input.body?.jobId) || null,
      round: Number(input.body?.round) || null,
    };
    if (w3RecordingStopped) {
      return { status: 409, body: { ok: false, error: '合成录音任务已经结束。' } };
    }
    if (w3StopRequested) {
      return ok({
        job: {
          id: 'SYN-W3-UNPLANNED-RECORDING',
          status: 'running',
          mode: 'record',
          bind_candidate_id: CANDIDATE.internal_id,
          bind_job_id: JOB.id,
          bind_round: 2,
          elapsed_seconds: 37,
          started_at: '2026-07-21T10:00:00Z',
          stop_requested: true,
        },
      });
    }
    w3StopRequested = true;
    w3StopProgressGets = 0;
    w3LiveAudioMode = 'stopping';
    return ok({
      job: {
        id: 'SYN-W3-UNPLANNED-RECORDING',
        status: 'running',
        mode: 'record',
        bind_candidate_id: CANDIDATE.internal_id,
        bind_job_id: JOB.id,
        bind_round: 2,
        elapsed_seconds: 37,
        started_at: '2026-07-21T10:00:00Z',
        stop_requested: true,
      },
    });
  }
  if (requestPath === '/local-interview/progress' && RUNTIME_SCENARIO === 'w3-formal') {
    w3ProgressGets += 1;
    if (w3RecordingStopped) {
      return ok({
        job: {
          id: 'SYN-W3-UNPLANNED-RECORDING',
          status: 'done',
          mode: 'record',
          bind_candidate_id: CANDIDATE.internal_id,
          bind_job_id: JOB.id,
          bind_round: 2,
          elapsed_seconds: 37,
          started_at: '2026-07-21T10:00:00Z',
          finished_at: new Date().toISOString(),
          stop_requested: true,
          message: '合成录音已停止并完成转写。',
          result: { transcriptText: '合成转写已完成。' },
        },
      });
    }
    if (w3StopRequested) {
      w3StopProgressGets += 1;
      if (w3StopProgressGets >= 6) {
        w3RecordingStopped = true;
        return ok({
          job: {
            id: 'SYN-W3-UNPLANNED-RECORDING',
            status: 'done',
            mode: 'record',
            bind_candidate_id: CANDIDATE.internal_id,
            bind_job_id: JOB.id,
            bind_round: 2,
            elapsed_seconds: 37,
            started_at: '2026-07-21T10:00:00Z',
            finished_at: new Date().toISOString(),
            stop_requested: true,
            message: '合成录音已停止并完成转写。',
            result: { transcriptText: '合成转写已完成。' },
          },
        });
      }
    }
    const highFrame = w3LiveAudioMode === 'live-high';
    const clippingFrame = w3LiveAudioMode === 'live-clipping';
    const stopping = w3LiveAudioMode === 'stopping';
    const stale = w3LiveAudioMode === 'stale';
    const waveform = clippingFrame
      ? [0.24, 0.39, 0.58, 0.73, 0.91, 0.998, 0.88, 0.62, 0.96, 0.77,
        0.45, 0.69, 0.93, 1, 0.84, 0.51, 0.97, 0.89, 0.66, 0.37]
      : highFrame
      ? [0.18, 0.34, 0.58, 0.82, 0.66, 0.42, 0.76, 0.94, 0.61, 0.39,
        0.24, 0.48, 0.72, 0.88, 0.57, 0.31, 0.69, 0.85, 0.52, 0.27]
      : [0.04, 0.07, 0.11, 0.16, 0.12, 0.08, 0.14, 0.19, 0.13, 0.06,
        0.05, 0.09, 0.15, 0.18, 0.1, 0.07, 0.12, 0.17, 0.11, 0.05];
    return ok({
      job: {
        id: 'SYN-W3-UNPLANNED-RECORDING',
        status: 'running',
        mode: 'record',
        bind_candidate_id: CANDIDATE.internal_id,
        bind_job_id: JOB.id,
        bind_round: 2,
        elapsed_seconds: 37,
        started_at: '2026-07-21T10:00:00Z',
        stop_requested: stopping || w3StopRequested,
        live_audio: {
          level: clippingFrame ? 0.91 : highFrame ? 0.76 : 0.13,
          peak: clippingFrame ? 1 : highFrame ? 0.94 : 0.19,
          active: !stopping && !w3StopRequested,
          silent_ms: 0,
          seq: w3ProgressGets,
          sampled_at: stale
            ? new Date(Date.now() - 10_000).toISOString()
            : new Date().toISOString(),
          waveform,
        },
      },
    });
  }
  if (requestPath.startsWith('/talent-pool')) {
    if (RUNTIME_SCENARIO === 'module-states') {
      moduleStateTalentPoolReads += 1;
      if (moduleStateTalentPoolReads === 1) {
        return { status: 503, body: { ok: false, error: '合成人才库读取失败，用于验证错误不等于空人才库。' } };
      }
      if (moduleStateTalentPoolReads >= 3) await delay(700);
      return ok({ talentPool: MODULE_STATE_TALENT_POOL });
    }
    return ok({ talentPool: { source: 'local_db_empty', active_job: JOB, overview: [], job_recommendations: [], talents: [], compliance_notes: [] } });
  }
  return ok({});
}

contextBridge.exposeInMainWorld('localApi', { request });
contextBridge.exposeInMainWorld('localInterview', {
  selectMediaFile: async () => ({ ok: true, canceled: true }),
  selectSummaryFile: async () => {
    summarySelectorCalls += 1;
    if (summarySelectionMode === 'error') {
      return { ok: false, error: '合成 summary 选择失败；未访问真实文件。' };
    }
    return { ok: true, canceled: true };
  },
});
contextBridge.exposeInMainWorld('assessmentArchive', {
  selectAndImport: async () => {
    w4AssessmentImportCalls += 1;
    if (RUNTIME_SCENARIO !== 'w4-runtime') return { ok: false, error: 'synthetic disabled' };
    await delay(800);
    return { ok: true, canceled: true };
  },
  onImportProgress: () => () => {},
});
function w4bAiConfig({ enabled = false, forceConfigured = false } = {}) {
  const keyConfigured = forceConfigured || w4bAiKeyConfigured;
  const modelVerified = forceConfigured || w4bAiModelVerified;
  const operational = enabled === true && keyConfigured && modelVerified;
  return {
    provider: forceConfigured ? 'synthetic' : w4bAiProvider,
    baseUrl: forceConfigured ? 'https://ai.example.test/v1' : w4bAiBaseUrl,
    enabled: operational,
    apiKeyConfigured: keyConfigured,
    model: modelVerified ? 'synthetic-text-model' : '',
    modelVerified,
    availableModels: keyConfigured ? [{
      id: 'synthetic-text-model',
      family: 'other',
      label: 'synthetic-text-model',
      tier: '可选模型',
      source: 'provider',
      verified: modelVerified,
    }] : [],
    timeoutMs: 120000,
    operational,
    capabilities: {
      job_jd: operational,
      deep_profile: operational,
      candidate_assessment: operational,
      assessment_analysis: operational,
      interview_review: operational,
    },
    blockers: operational ? [] : ['合成配置尚未完成。'],
  };
}

contextBridge.exposeInMainWorld('llmCredential', {
  configure: async (request = {}) => {
    if (W4B_MODE !== 'ai-unconfigured') return ok();
    const provider = String(request.provider || w4bAiProvider).trim();
    const baseUrl = String(request.baseUrl || w4bAiBaseUrl).trim().replace(/\/+$/, '');
    if (provider !== w4bAiProvider || baseUrl !== w4bAiBaseUrl || String(request.apiKey || '').trim()) {
      w4bAiKeyConfigured = false;
      w4bAiModelVerified = false;
      w4bAiConfigured = false;
    }
    w4bAiProvider = provider;
    w4bAiBaseUrl = baseUrl;
    if (String(request.apiKey || '').trim() && /^https:\/\//.test(baseUrl)) w4bAiKeyConfigured = true;
    if (request.clearApiKey === true) {
      w4bAiKeyConfigured = false;
      w4bAiModelVerified = false;
      w4bAiConfigured = false;
    }
    if (request.enabled === true && w4bAiKeyConfigured && w4bAiModelVerified) w4bAiConfigured = true;
    return ok({
      config: w4bAiConfig({ enabled: w4bAiConfigured }),
      credentialPersistence: 'system_encrypted',
    });
  },
  refreshModels: async () => {
    if (W4B_MODE !== 'ai-unconfigured') return ok({ models: [] });
    const config = w4bAiConfig();
    return ok({ models: config.availableModels, config });
  },
  testModel: async ({ model } = {}) => {
    if (W4B_MODE !== 'ai-unconfigured') return { ok: false, error: 'synthetic disabled' };
    if (!w4bAiKeyConfigured || model !== 'synthetic-text-model') return { ok: false, error: '合成模型测试前置不满足' };
    w4bAiModelVerified = true;
    const config = w4bAiConfig();
    return ok({
      config,
      model: { id: 'synthetic-text-model', source: 'provider' },
    });
  },
});
contextBridge.exposeInMainWorld('llmApproval', { confirm: async () => ({ ok: false, error: 'synthetic disabled' }) });
contextBridge.exposeInMainWorld('externalAiApproval', {
  confirm: async (payload = {}) => {
    if (!W4B_MODE) return { ok: false, error: 'synthetic disabled' };
    w4bApprovalCalls += 1;
    w4bLastApproval = {
      purpose: String(payload.purpose || ''),
      targetId: String(payload.targetId || ''),
      requestId: String(payload.requestId || ''),
      materialJobId: Number(payload.materialInput?.jobId) || null,
    };
    if (W4B_MODE === 'approval-cancel') return { ok: true, approved: false };
    if (W4B_MODE === 'ai-unconfigured') return { ok: true, approved: false };
    return {
      ok: true,
      approved: true,
      userApproval: {
        token: `SYN-W4B-APPROVAL-${w4bApprovalCalls}`,
        synthetic: true,
      },
    };
  },
});
contextBridge.exposeInMainWorld('runtimeInfo', {
  get: async () => ({
    ok: true,
    platform: 'synthetic',
    resumeCommitCalls,
    actionWriteCalls,
    candidateListReads,
    forceEmptyJobs,
    forceJobsError,
    failNextCandidateListRead,
    jobContextRace: {
      requests: jobContextRaceRequests.map((request) => ({ ...request })),
    },
    resumeDraftSelectionCalls,
    screenshotDirectorySelectionCalls,
    screenshotDirectoryDelayMs,
    candidateAuthorityWriteCalls: { ...candidateAuthorityWriteCalls },
    moduleStateJobReads,
    moduleStateInterviewSessionReads,
    moduleStateTalentPoolReads,
    moduleStateTalentWorkspaceRefreshes,
    summarySelectionMode,
    summarySelectorCalls,
    summaryImportCalls,
    w3LiveAudioMode,
    w3ProgressGets,
    w3StopPosts,
    w3StopProgressGets,
    w3StopRequested,
    w3RecordingStopped,
    w3LastStopRequest,
    w4GuideMode,
    w4AssessmentImportCalls,
    w4PreviewPage1Reads,
    w4PreviewPage2Reads,
    w4b: {
      mode: W4B_MODE,
      progressGets: w4bProgressGets,
      progressByJob: { ...w4bProgressByJob },
      profileGets: w4bProfileGets,
      interviewGets: w4bInterviewGets,
      preflightGets: w4bPreflightGets,
      approvalCalls: w4bApprovalCalls,
      interviewPreviewCalls: w4bInterviewPreviewCalls,
      generatePosts: w4bGeneratePosts,
      taskStarts: w4bTaskStarts,
      externalTransportCalls: w4bExternalTransportCalls,
      postStartProgressGets: w4bPostStartProgressGets,
      lastApproval: w4bLastApproval,
      lastGenerate: w4bLastGenerate,
    },
  }),
  setSummarySelectionMode: async (mode) => {
    summarySelectionMode = mode === 'error' ? 'error' : 'cancel';
    return { ok: true, mode: summarySelectionMode };
  },
  setForceEmptyJobs: async (enabled = true) => {
    forceEmptyJobs = enabled === true;
    return { ok: true, forceEmptyJobs };
  },
  setForceJobsError: async (enabled = true) => {
    forceJobsError = enabled === true;
    return { ok: true, forceJobsError };
  },
  failNextCandidateListRead: async () => {
    failNextCandidateListRead = true;
    return { ok: true, failNextCandidateListRead };
  },
  configureJobContextRace: async (delays = {}) => {
    jobContextRaceDelays = Object.fromEntries(Object.entries(delays)
      .map(([jobId, delayMs]) => [Number(jobId), Math.max(0, Number(delayMs) || 0)]));
    jobContextRaceRequests = [];
    jobContextRaceSequence = 0;
    jobContextRaceCompletionSequence = 0;
    return { ok: true, delays: { ...jobContextRaceDelays } };
  },
  setScreenshotDirectoryDelay: async (delayMs = 0) => {
    screenshotDirectoryDelayMs = Math.max(0, Number(delayMs) || 0);
    return { ok: true, screenshotDirectoryDelayMs };
  },
  setW3LiveAudioMode: async (mode) => {
    if (w3StopRequested || w3RecordingStopped) {
      return { ok: false, mode: w3LiveAudioMode, reason: 'recording_stopped' };
    }
    w3LiveAudioMode = ['live-low', 'live-high', 'live-clipping', 'stale', 'stopping'].includes(mode)
      ? mode
      : 'live-low';
    return { ok: true, mode: w3LiveAudioMode };
  },
  setW4GuideMode: async (mode) => {
    w4GuideMode = ['ready', 'error', 'stale'].includes(mode) ? mode : 'ready';
    return { ok: true, mode: w4GuideMode };
  },
});
contextBridge.exposeInMainWorld('nativeDialog', { openFile: async () => ({ canceled: true, filePaths: [] }) });
contextBridge.exposeInMainWorld('settingsState', {
  setExternalAiDirty: () => true,
  getLocalPaths: async () => ({
    ok: true,
    paths: {
      dataDir: '/tmp/hrboss-synthetic-data',
      databasePath: '/tmp/hrboss-synthetic-data/recruiting.db',
      interviewDir: '/tmp/hrboss-synthetic-data/interviews',
      screenshotDir: '/tmp/hrboss-synthetic-data/import',
    },
  }),
});
contextBridge.exposeInMainWorld('screenshotImport', {
  selectDirectory: async () => {
    screenshotDirectorySelectionCalls += 1;
    if (screenshotDirectoryDelayMs > 0) await delay(screenshotDirectoryDelayMs);
    return { ok: true, canceled: false, path: '/tmp/hrboss-synthetic-screenshots' };
  },
});
contextBridge.exposeInMainWorld('resumeAttachment', {
  selectCandidateDraft: async () => {
    resumeDraftSelectionCalls += 1;
    return { ok: true, canceled: false, result: RESUME_INTAKE_DRAFT };
  },
  selectAndImport: async () => ({ ok: false, error: 'synthetic disabled' }),
});
