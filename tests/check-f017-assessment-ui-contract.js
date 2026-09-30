'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const path = require('path');

const component = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/AssessmentArchivePanel.jsx'), 'utf8');
const detail = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/CandidateDetail.jsx'), 'utf8');
const interview = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/InterviewReviewPanel.jsx'), 'utf8');
const app = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/App.jsx'), 'utf8');
const candidateList = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/CandidateList.jsx'), 'utf8');
const api = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/api.js'), 'utf8');
const preload = fs.readFileSync(path.join(PROJECT_ROOT, "src/preload.js"), 'utf8');
const main = fs.readFileSync(path.join(PROJECT_ROOT, "src/candidate-main.js"), 'utf8');
const server = fs.readFileSync(path.join(PROJECT_ROOT, "src/action-server.js"), 'utf8');
const database = fs.readFileSync(path.join(PROJECT_ROOT, "src/db.js"), 'utf8');

assert.match(component, /PDF 测评供 HR 人工判断参考/);
assert.match(component, /HR 确认绑定后，可生成联合岗位、简历和面试材料的 AI 综合分析/);
assert.match(component, /报告姓名/);
assert.match(component, /不一致/);
assert.match(component, /当前 HR 明确确认姓名不一致后才能绑定/);
assert.match(component, /已核对，确认绑定/);
assert.match(component, /identityMismatchAcknowledged/);
assert.match(component, /自动识别（推荐）/);
assert.match(component, /未识别报告类型/);
assert.match(component, /不会进入组合分析或外部 AI 证据/);
assert.match(component, /CLASSIFIABLE_REPORT_OPTIONS = REPORT_OPTIONS\.filter\(\(item\) => item\.value !== 'unknown'\)/);
assert.match(component, /确认报告类型/);
assert.match(component, /请继续核对并确认候选人绑定/);
assert.match(component, /api\.confirmAssessmentMetadata/);
assert.match(component, /row\.binding_state === 'pending' && row\.report_type !== 'unknown' && row\.review_state === 'ready'/);
assert.match(component, /row\.analysis_status === 'ready' && row\.report_type !== 'unknown' && row\.analysis/);
assert.match(component, /候选人测评组合报告/);
assert.match(interview, /候选人测评核验题/);
assert.match(interview, /api\.listAssessmentArchives\(candidateId, jobId\)/);
assert.match(interview, /api\.listAssessmentAiAnalyses\(candidateId, jobId\)/);
assert.match(interview, /不进入自动评分、排序或处置/);
assert.match(interview, /已按次批准且当前有效的 AI 核验题/);
assert.match(interview, /生成当前候选人临时核验稿/);
assert.match(interview, /切换候选人会清空，未保存到岗位面试脚本模板/);
assert.match(interview, /复制临时核验稿/);
assert.match(interview, /assessmentQuestionDraftState\.contextKey === assessmentQuestionContextKey/);
assert.match(interview, /setAssessmentQuestionDraftState\(\{ contextKey: assessmentQuestionContextKey, text: '' \}\)/);
const assessmentQuestionHandler = interview.slice(
  interview.indexOf('function prepareApprovedAssessmentQuestions'),
  interview.indexOf('async function copyApprovedAssessmentQuestions'),
);
assert.ok(assessmentQuestionHandler.length > 0, 'current-candidate assessment question handler must exist');
assert.doesNotMatch(
  assessmentQuestionHandler,
  /setScriptDraft|setScriptEditing|scriptEditingRef|saveInterviewScript|saveScript/,
  'candidate assessment questions must never enter the job-level interview script draft/save path',
);
assert.match(interview, /测评证据读取失败/);
assert.match(interview, /当前不会把读取失败解释为“没有测评报告”/);
assert.match(interview, /load_error:/);
assert.doesNotMatch(interview, /\.catch\(\(\) => \(\{ archives: \[\] \}\)\)/);
assert.doesNotMatch(interview, /\.catch\(\(\) => \(\{ analyses: \[\] \}\)\)/);
assert.match(interview, /onBusyChange\?\.\(writeBusy\)/);
assert.match(interview, /const writeBusy = Boolean\(\s*busyKey\s*&& !busyKey\.startsWith\('llm-preview:'\)/);
assert.doesNotMatch(
  interview.match(/const writeBusy = Boolean\([\s\S]*?\n  \);/)?.[0] || '',
  /lifecycle-dry-run/,
  'lifecycle deletion dry-run must block candidate/domain navigation because it yields a destructive confirmation token',
);
const lifecycleDeletionHandler = interview.slice(
  interview.indexOf('async function previewLifecycleDeletion'),
  interview.indexOf('function startEdit'),
);
assert.match(lifecycleDeletionHandler, /contextKey: interviewContextKey/);
assert.match(lifecycleDeletionHandler, /isCurrentDeletionContext/);
assert.match(lifecycleDeletionHandler, /if \(!isCurrentDeletionContext\(\)\)/);
assert.ok(
  (lifecycleDeletionHandler.match(/if \(!isCurrentDeletionContext\(\)\)/g) || []).length >= 2,
  'deletion context must be checked after dry-run and again before confirmation',
);
assert.match(lifecycleDeletionHandler, /候选人：\{deletionContext\.candidateLabel\}/);
assert.match(lifecycleDeletionHandler, /岗位：\{deletionContext\.jobLabel\}/);
assert.match(lifecycleDeletionHandler, /api\.confirmInterviewDeletion/);
assert.ok(
  lifecycleDeletionHandler.lastIndexOf('if (!isCurrentDeletionContext())')
    < lifecycleDeletionHandler.indexOf('api.confirmInterviewDeletion'),
  'service-side deletion call must be guarded by the captured candidate/job context',
);
assert.match(component, /证据覆盖与限制/);
assert.match(component, /限制与风险/);
assert.match(component, /需核验问题/);
assert.match(component, /供应商数值参考（次级）/);
assert.match(component, /确认绑定后才会进入候选人组合画像和岗位匹配辅助材料，不改变列表排序/);
assert.match(component, /binding_state === 'active'/);
assert.match(component, /PNG 栅格预览/);
assert.match(component, /可一次选择同一候选人的多份报告/);
assert.match(component, /选择 PDF（可多选）并导入/);
assert.match(component, /正在逐份分析/);
assert.match(component, /single_file_retry: retryingSingleFile/);
assert.match(component, /重新选择这一份/);
assert.match(component, /无需重选整批/);
assert.match(component, /系统不会保存或显示原文件路径/);
assert.match(component, /生成 AI 综合分析/);
assert.match(component, /API Key 已配置；还需验证可用模型/);
assert.match(component, /模型已验证；还需启用外部 AI/);
assert.match(component, /去完成 AI 配置/);
assert.match(component, /api\.getLlmConfig/);
assert.match(component, /confirmExternalAiApproval\(\s*'assessment-ai-analysis'/);
assert.match(component, /证据覆盖、置信度与缺失材料/);
assert.match(component, /当前结论未引用/);
assert.match(component, /限制与需核验项/);
assert.match(component, /AI 匹配分（次级参考）/);
assert.match(component, /HR 决策参考（证据核验后阅读）/);
assert.match(component, /测评缺失不降级/);
assert.match(component, /ranking_eligible/);
assert.match(component, /优势证据/);
assert.match(component, /材料矛盾/);
assert.match(component, /AI 面试核验题/);
assert.match(component, /仅供 HR 人工参考/);
assert.match(component, /api\.listAssessmentQueue/);
assert.match(component, /api\.resolveAssessmentDuplicate/);
assert.match(component, /确认纠正绑定/);
assert.match(component, /notifyChanged/);
assert.match(component, /background: true/);
assert.match(component, /loadSequence/);
assert.match(component, /contextRef/);
assert.match(component, /contextIsCurrent/);
assert.match(component, /visibleArchives/);
assert.match(component, /assessmentMaintenanceAllowed/);
assert.match(component, /administrativeReadOnly = readOnly && !assessmentMaintenanceAllowed/);
assert.match(component, /disabled=\{administrativeReadOnly \|\| busy\}[\s\S]*?撤销绑定/);
assert.match(component, /disabled=\{administrativeReadOnly \|\| busy\}[\s\S]*?永久删除/);
assert.match(component, /disabled=\{administrativeReadOnly \|\| busy\}[\s\S]*?重试物理删除/);
assert.match(component, /disabled=\{readOnly \|\| busy\}[\s\S]*?人工确认绑定/);
assert.match(component, /loadError/);
assert.match(component, /hasLoadedSuccessfully/);
assert.match(component, /测评档案读取失败/);
assert.match(component, /刷新失败，当前显示上次成功数据/);
assert.match(component, /当前保留上次成功数据，请重试刷新，勿重复提交/);
assert.match(component, /operationNotice/);
assert.match(component, /重试刷新/);
assert.match(component, /expectedContext !== contextRef\.current/);
assert.match(component, /URL\.revokeObjectURL\(nextUrl\)/);
assert.match(component, /onBusyChange\?\.\(writeBusy\)/);
assert.match(component, /function beginWrite\(\)/);
assert.match(component, /function endWrite\(\)/);
const assessmentLoadStart = component.indexOf('async function load(');
const assessmentLoadHandler = component.slice(
  assessmentLoadStart,
  component.indexOf('\n\n  useEffect(() => {', assessmentLoadStart),
);
assert.doesNotMatch(assessmentLoadHandler, /beginWrite|setWriteBusy/,
  'assessment authority reads must not lock candidate/domain navigation');
const assessmentPreviewHandler = component.slice(
  component.indexOf('async function changePreviewPage'),
  component.indexOf('function closePreview'),
);
assert.doesNotMatch(assessmentPreviewHandler, /beginWrite|setWriteBusy/,
  'assessment PNG page preview must not lock candidate/domain navigation');
assert.doesNotMatch(component, /测评权重/);
assert.match(component, /不会自动录用或淘汰/);
assert.doesNotMatch(component, /fontSize:\s*34|#087f5b|strokeColor="#087f5b"|trailColor="#e8f5ef"/);
assert.doesNotMatch(component, /decision_support\?\.recommendation === 'advance' \? 'green'/);
assert.ok(component.indexOf('证据覆盖与限制') < component.indexOf('供应商数值参考（次级）'),
  'supplier evidence coverage must precede its score');
assert.ok(component.indexOf('证据覆盖、置信度与缺失材料') < component.indexOf('AI 匹配分（次级参考）'),
  'AI evidence coverage must precede its score');
assert.ok(component.indexOf('AI 面试核验题') < component.indexOf('HR 决策参考（证据核验后阅读）'),
  'verification questions must precede AI decision support');
assert.ok(component.indexOf('AI 匹配分（次级参考）') < component.indexOf('HR 决策参考（证据核验后阅读）'),
  'secondary AI score must precede, not dominate, the final decision reference');
assert.match(detail, /assessmentStatus/);
assert.doesNotMatch(detail, /if \(readOnly && !assessmentMaintenanceAllowed\)/,
  'readonly candidate view must still read assessment status/history; only writes stay locked');
assert.match(detail, /api\.getAssessmentStatus\(\)/);
assert.match(detail, /查看简历材料/);
assert.match(detail, /value:\s*'assessment'/);
assert.doesNotMatch(detail, /value:\s*'assessment'[\s\S]{0,500}disabled:/);
assert.match(detail, /状态读取失败不会被解释为“没有测评报告”/);
assert.doesNotMatch(detail, /!assessmentStatus\.enabled && activeDomain === 'assessment'[\s\S]*setActiveDomain\('profile'\)/);
assert.match(detail, /readOnly=\{readOnly \|\| assessmentStatus\.phase !== 'ready'\}/);
assert.match(detail, /assessmentMaintenanceAllowed=\{assessmentStatus\.phase === 'ready' && assessmentMaintenanceAllowed\}/);
assert.match(detail, /手动绑定 · AI 综合分析/);
assert.match(detail, /onAssessmentChanged/);
assert.match(detail, /onOpenAiSettings/);
assert.match(detail, /onBusyChange=\{setInterviewWriteBusy\}/);
assert.match(detail, /onBusyChange=\{setAssessmentWriteBusy\}/);
assert.match(detail, /interviewWriteBusy/);
assert.match(detail, /assessmentWriteBusy/);
assert.match(detail, /const anyWriteBusy = hrFlowBusy[\s\S]*assessmentWriteBusy/);
assert.match(detail, /if \(anyWriteBusy\)/);
assert.match(detail, /当前操作正在提交/);
assert.match(app, /handleAssessmentChanged/);
assert.match(app, /assessmentMaintenanceAllowed=\{jobClosed && !READONLY_UI\}/);
assert.match(app, /handleOpenAiSettings\(\{[\s\S]*returnNav:\s*'候选人'/);
assert.match(app, /loadCandidates\(candidateJobId\)/);
const assessmentRefreshHandler = app.match(/async function handleAssessmentChanged[\s\S]*?\n  \}/)?.[0] || '';
assert.doesNotMatch(assessmentRefreshHandler, /handleSelectCandidate/, 'assessment mutations must not remount candidate detail or reset the active tab');
assert.match(database, /assessment_ai_analysis_record_v1/);
assert.match(candidateList, /AI 测评匹配/);
assert.match(candidateList, /测评为可选辅助材料，缺失不降级/);
assert.match(candidateList, /测评、AI 和面试分均不参与默认排序/);
assert.match(api, /window\.assessmentArchive\.selectAndImport/);
assert.match(api, /window\.assessmentArchive\.onImportProgress/);
assert.match(api, /generateAssessmentAiAnalysis/);
assert.match(api, /resolveAssessmentDuplicate/);
assert.match(api, /confirmAssessmentMetadata/);
assert.match(api, /\/assessment\/metadata\/confirm/);
assert.match(api, /identity_mismatch_acknowledged/);
assert.match(preload, /assessment:select-and-import/);
assert.match(preload, /assessment:import-progress/);
assert.match(main, /dialog\.showOpenDialog/);
assert.match(main, /multiSelections/);
assert.match(main, /singleFileRetry \? \['openFile'\] : \['openFile', 'multiSelections'\]/);
assert.match(main, /重新选择一份失败的 PDF 测评报告/);
assert.match(main, /importAssessmentFileBatch/);
assert.match(main, /issueAssessmentFileSelection/);
assert.match(main, /source_path: undefined/);
assert.doesNotMatch(preload, /source_path|filePaths|selectionToken/);
assert.match(server, /scope: 'hr_manual_assessment_reference'/);
assert.match(server, /decision_use: ASSESSMENT_INTERNAL_AVAILABLE/);
assert.match(server, /decision_use_mode: ASSESSMENT_INTERNAL_AVAILABLE \? 'hr_confirmed_assessment_reference' : 'disabled'/);
assert.match(server, /automated_decision_use: false/);
assert.match(server, /automatic_scoring_enabled: false/);
assert.match(server, /ai_requires_per_use_hr_approval: true/);
assert.match(server, /automatic_ranking_enabled: false/);
assert.match(server, /ranking_requires_hr_confirmed_binding: true/);
assert.match(server, /\/api\/assessment\/duplicate\/resolve/);
assert.match(server, /\/api\/assessment\/metadata\/confirm/);
assert.match(server, /getAssessmentProductService\(\)\.confirmMetadata\(prepareAssessmentIngress\(body\)\)/);
assert.match(server, /automatic_disposition_enabled: false/);
assert.match(server, /real_pdf_pilot_allowed: false/);
assert.match(server, /internal_feature_available: ASSESSMENT_INTERNAL_AVAILABLE/);
assert.match(server, /original_pdf_view_enabled: false/);
assert.match(server, /retention_policy_configured: retentionPolicyConfigured/);
assert.match(server, /delete_enabled: retentionPolicyConfigured/);
assert.match(server, /missing_required_dependencies: capabilities\.missing_required/);
assert.match(component, /assessmentStatus\?\.import_enabled !== true/);
assert.match(server, /export_enabled: false/);
assert.match(main, /DEFAULT_ASSESSMENT_RETENTION_POLICY_VERSION = 'hrboss-internal-assessment-v1'/);
assert.match(main, /DEFAULT_ASSESSMENT_RETENTION_DAYS = '365'/);
assert.match(component, /当前测评留存策略/);
assert.match(component, /assessmentStatus\.retention_policy_version/);
assert.match(component, /assessmentStatus\.retention_days/);
assert.doesNotMatch(component, /没有隐藏默认|无隐藏默认/);
assert.doesNotMatch(component, /HRBOSS_ASSESSMENT_RETENTION_POLICY_VERSION|HRBOSS_ASSESSMENT_RETENTION_DAYS/);
assert.match(component, /永久删除/);
assert.match(server, /sendBinary\(res, 200, bytes, 'image\/png'\)/);
assert.doesNotMatch(server, /application\/pdf/);

console.log('check-f017-assessment-ui-contract ok');
