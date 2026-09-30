'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
}

const ocrReview = read('frontend/src/components/ScreenshotOcrReviewModal.jsx');
const candidateDetail = read('frontend/src/components/CandidateDetail.jsx');
const candidateList = read('frontend/src/components/CandidateList.jsx');
const app = read('frontend/src/App.jsx');
const applicationFinalReview = read('frontend/src/components/ApplicationFinalReviewPanel.jsx');
const assessmentArchive = read('frontend/src/components/AssessmentArchivePanel.jsx');
const dashboard = read('frontend/src/components/DashboardPanel.jsx');
const deepProfile = read('frontend/src/components/DeepProfileModal.jsx');
const jobLedger = read('frontend/src/components/JobLedgerPanel.jsx');
const jobManagement = read('frontend/src/components/JobManagementDemo.jsx');
const jobManagementWorkspace = read('frontend/src/components/job-management-workspace.jsx');
const interviewReview = read('frontend/src/components/InterviewReviewPanel.jsx');
const interviewSchedule = read('frontend/src/components/InterviewScheduleCanonical.jsx');
const interviewScheduleFixture = read('frontend/src/components/InterviewSchedulePanel.jsx');
const localInterview = read('frontend/src/components/LocalInterviewPanel.jsx');
const settings = read('frontend/src/components/SettingsPanel.jsx');
const talentPool = read('frontend/src/components/TalentPoolDemo.jsx');
const topBar = read('frontend/src/components/TopBar.jsx');
const styles = read('frontend/src/styles.css');
const decisionUi = read('frontend/src/decision-ui.css');

assert.match(ocrReview, /<List\s+[\s\S]*?role="listbox"[\s\S]*?aria-label="待校对 OCR 草稿"/);
assert.match(ocrReview, /<List\.Item[\s\S]*?role="option"[\s\S]*?aria-selected=\{item\.id === selected\.id\}[\s\S]*?tabIndex=\{0\}/);
assert.match(ocrReview, /onKeyDown=\{\(event\) => \{[\s\S]*?event\.key === 'Enter'[\s\S]*?event\.key === ' '[\s\S]*?event\.preventDefault\(\);[\s\S]*?requestSelectDraft\(item\.id\);/);
assert.match(ocrReview, /<TextArea aria-label=\{label\}/);
assert.match(ocrReview, /<Input aria-label=\{label\}/);
assert.match(ocrReview, /destroyOnHidden/);
assert.doesNotMatch(ocrReview, /destroyOnClose/);

assert.match(candidateDetail, /fill="待补全"/);
assert.match(candidateDetail, /缺失项来自在线简历待补全，不会按默认值参与判断/);
assert.match(candidateDetail, /aria-label="已知候选人关键事实"/);
assert.match(candidateDetail, /aria-label="待补全候选人事实"/);
assert.match(candidateDetail, /label: `待补全资料（\$\{missingFactRows\.length\} 项）`/);
assert.match(candidateDetail, /只汇总已记录事实和统一时间线待办；不生成推荐或分数/);
assert.match(candidateDetail, /className="communication-backfill-idle">选择不同事实后填写备注并确认保存/);
assert.doesNotMatch(candidateDetail, /待02b补全/);
assert.doesNotMatch(candidateDetail, /<main\b/);
assert.match(candidateDetail, /<section className="candidate-v2-workspace" aria-label="候选人评估工作区">/);
assert.match(candidateDetail, /<img src=\{src\} alt=\{`\$\{candidate\.name \|\| '候选人'\}拼合截图`\} width=\{1200\} height=\{1600\}/);
assert.match(candidateDetail, /<Title level=\{2\}>\{c\.name \|\| '未命名候选人'\}<\/Title>/);
assert.match(candidateDetail, /<Segmented\s+block\s+name="candidate-workspace-domain"[\s\S]*?aria-label="候选人工作区分区"/);
assert.match(candidateDetail, /className="detail-tabs candidate-profile-tools"[\s\S]*?role="toolbar"[\s\S]*?aria-label=\{`候选人资料查看工具/);
assert.match(candidateDetail, /'aria-label': '切换简历材料'/);
assert.match(candidateDetail, /className: 'candidate-domain-tab-option'/);
assert.match(candidateDetail, /className: 'candidate-domain-tab-option candidate-final-review-domain-option'[\s\S]*?<strong>终评<\/strong>[\s\S]*?value: 'final-review'/);
assert.match(candidateDetail, /function handleSegmentedBoundaryKey\([\s\S]*?event\.key === 'Enter'[\s\S]*?event\.key === ' '[\s\S]*?event\.key !== 'Home'[\s\S]*?event\.key !== 'End'/);
assert.match(candidateDetail, /querySelectorAll\('input\[type="radio"\]'\)\[target\.index\]\?\.focus\(\)/);
assert.match(candidateDetail, /rootClassName="candidate-communication-drawer"[\s\S]*?closable=\{!communicationBusy\}[\s\S]*?keyboard=\{false\}[\s\S]*?maskClosable=\{!communicationBusy\}/);
assert.match(candidateDetail, /document\.addEventListener\('keydown', handleCommunicationDrawerEscape, true\)/);
assert.match(candidateDetail, /afterOpenChange=\{handleCommunicationDrawerOpenChange\}/);

assert.match(candidateList, /role="option"[\s\S]*?tabIndex=\{tabIndex\}[\s\S]*?aria-selected=\{active\}/);
assert.match(candidateList, /event\.key === 'Enter' \|\| event\.key === ' '/);
assert.match(candidateList, /\['ArrowDown', 'ArrowUp', 'Home', 'End'\]\.includes\(event\.key\)/);
assert.match(candidateList, /role=\{emptyState \? 'region' : 'listbox'\}/);
assert.match(candidateList, /const tabStopCandidateId = selectedPagedCandidate\?\.internal_id[\s\S]*?rovingPagedCandidate\?\.internal_id[\s\S]*?paged\[0\]\?\.internal_id/);
assert.match(candidateList, /tabIndex=\{c\.internal_id === tabStopCandidateId \? 0 : -1\}/);
assert.match(candidateList, /window\.requestAnimationFrame\(\(\) => candidateCardRefs\.current\.get\(nextId\)\?\.focus\(\)\)/);
assert.match(candidateList, /aria-label=\{accessibleLabel\}/);
assert.match(candidateList, /aria-haspopup="menu"/);
assert.match(candidateList, /'aria-label': '其他阶段候选人队列'/);
assert.match(candidateList, /aria-label="候选人队列筛选；全部待处理为聚合视图，其余为阶段筛选"/);
assert.match(candidateList, /const countsUnavailable = loadState === 'error' && candidates\.length === 0/);
assert.match(candidateList, /const overflowQueueAccessibleLabel = countsUnavailable[\s\S]*?数量未知[\s\S]*?`其他阶段，\$\{overflowQueueCategoryCount\} 个阶段有候选人`/);
assert.match(candidateList, /className="candidate-name" title=\{`完整姓名：\$\{fullName\}`\}/);
assert.match(candidateList, /className="candidate-row-disambiguator" title=\{stableReference\.full\}/);
assert.match(candidateList, /aria-expanded=\{showAdvancedFilters\}[\s\S]*?aria-controls="candidate-advanced-filters"/);
assert.match(candidateList, /详情已保留，不会静默切换到其他人/);
assert.match(candidateList, /aria-label=\{`SABC 评级 \$\{v\}`\}/);

assert.match(app, /candidateListCollapseButtonRef = useRef\(null\)/);
assert.match(app, /candidateListRestoreButtonRef = useRef\(null\)/);
assert.match(app, /candidateListFocusHandoffRef\.current = collapsed \? 'restore' : 'collapse'/);
assert.match(app, /focusTarget === 'restore'[\s\S]*?candidateListRestoreButtonRef\.current[\s\S]*?candidateListCollapseButtonRef\.current/);
assert.match(app, /const CANDIDATE_LIST_PANEL_ID = 'candidate-list-panel'/);
assert.match(app, /<Sider\s+id=\{CANDIDATE_LIST_PANEL_ID\}[\s\S]*?collapsed=\{candidateListCollapsed\}/);
assert.match(app, /className="candidate-sider-heading"[\s\S]*?ref=\{candidateListCollapseButtonRef\}[\s\S]*?MenuFoldOutlined[\s\S]*?aria-label="收起候选人列表"[\s\S]*?aria-controls=\{CANDIDATE_LIST_PANEL_ID\}[\s\S]*?aria-expanded=\{!candidateListCollapsed\}[\s\S]*?setCandidateListCollapsedWithFocus\(true\)/);
assert.match(app, /ref=\{candidateListRestoreButtonRef\}[\s\S]*?MenuUnfoldOutlined[\s\S]*?className="candidate-list-panel-toggle candidate-list-restore-control"[\s\S]*?aria-label="展开候选人列表"[\s\S]*?aria-controls=\{CANDIDATE_LIST_PANEL_ID\}[\s\S]*?aria-expanded=\{!candidateListCollapsed\}[\s\S]*?setCandidateListCollapsedWithFocus\(false\)/);
assert.match(app, /className=\{`candidate-focus-bar candidate-identity-anchor\$\{candidateListCollapsed \? ' is-list-collapsed' : ' is-list-open'\}`\}[\s\S]*?role="region"[\s\S]*?aria-label="当前候选人身份锚点"/);
assert.match(app, /<strong title=\{`完整姓名：\$\{focusCandidateName\}`\}>\{focusCandidateName\}<\/strong>/);
assert.match(app, /className="candidate-focus-job" title=\{`当前岗位：\$\{focusCandidateJob\}`\}/);
assert.match(app, /className="candidate-focus-reference" title=\{focusCandidateReference\.full\}/);
assert.match(app, /function handleCandidateListToggleKeyDown\(event, collapsed\)[\s\S]*?\['Enter', ' ', 'Spacebar'\][\s\S]*?setCandidateListCollapsedWithFocus\(collapsed\)/);
assert.doesNotMatch(app, /candidate-edge-toggle|candidate-edge-triangle|aria-label="显示候选人列表"/);
assert.doesNotMatch(jobManagement, /function JobList|job-management-edge-toggle|收起岗位列表/,
  'unused job-list collapse controls must not remain in the fixture implementation');
assert.match(app, /const \{ Header, Sider, Content \} = Layout;/);
assert.match(app, /<Content id="main-workspace" tabIndex=\{-1\}/);
assert.match(app, /function ModuleSemanticHeading\(\{ children \}\)[\s\S]*?<h1 className="module-semantic-heading" data-module-heading tabIndex=\{-1\}>\{children\}<\/h1>/);
assert.match(app, /className="module-route-announcer" role="status" aria-live="polite" aria-atomic="true"/);
assert.match(app, /const focusWorkspace = \(\) => \{[\s\S]*?document\.getElementById\('main-workspace'\)[\s\S]*?workspace\.querySelector\('\[data-module-heading\]'\)[\s\S]*?focusTarget\.focus\(\{ preventScroll: true \}\)/);
assert.match(app, /new MutationObserver\(focusWorkspace\)/);
assert.match(app, /const previousJobManagementRouteRef = useRef\('ledger'\)/);
assert.match(app, /jobManagementView === 'editor'[\s\S]*?\[data-job-editor-heading\]/);
assert.match(app, /data-job-ledger-focus-job-id[\s\S]*?dataset\.jobLedgerFocusJobId === String\(descriptor\.jobId\)[\s\S]*?dataset\.jobLedgerFocusAction === descriptor\.action/);
assert.match(app, /jobManagementView === 'ledger'[\s\S]*?setModuleAnnouncement\('已返回岗位台账'\)/);
assert.match(app, /const visibleJobName = String\(focusTarget\.textContent \|\| ''\)\.trim\(\) \|\| currentJobName;[\s\S]*?已进入岗位“\$\{visibleJobName\}”的 JD 与画像编辑视图/,
  'the editor route announcement must match the visible focused job title');
assert.match(app, /document\.querySelector\('\.job-ledger-page'\)[\s\S]*?#main-workspace \[data-module-heading\]/,
  'a removed job must fall back to the ledger heading instead of another job');
assert.match(app, /const returnFocusDescriptor = focusDescriptor[\s\S]*?jobManagementReturnFocusRef\.current === returnFocusDescriptor[\s\S]*?jobManagementReturnFocusRef\.current = null/,
  'a superseded job-open failure must not clear the winning request return-focus descriptor');
assert.match(jobManagementWorkspace, /<Title level=\{3\} tabIndex=\{-1\} data-job-editor-heading>/);
assert.match(jobLedger, /data-job-ledger-focus-job-id=\{String\(job\.id\)\}[\s\S]*?data-job-ledger-focus-action="manage"/);
assert.match(jobLedger, /data-job-ledger-focus-job-id=\{String\(job\.id\)\}[\s\S]*?data-job-ledger-focus-action="name"/);
assert.match(jobLedger, /data-job-ledger-focus-job-id=\{String\(ledgerJob\.id\)\}[\s\S]*?data-job-ledger-focus-action="name"/);
const moduleHeadings = [...app.matchAll(/<ModuleSemanticHeading>([^<]+)<\/ModuleSemanticHeading>/g)]
  .map((match) => match[1]);
assert.deepEqual(moduleHeadings, ['工作台', '使用指南', '职位管理', '面试安排', '人才库', '设置', '候选人']);
assert.match(app, /<Skeleton active title=\{\{ width: '32%' \}\}/);

// 17 个审计锁定控件必须有准确的 accessible name；文本输入同时锁住 name/autocomplete。
assert.match(applicationFinalReview, /<TextArea\s+aria-label="人工终评摘要"\s+name="application-final-review-summary"\s+autoComplete="off"/);
assert.match(applicationFinalReview, /<TextArea\s+aria-label="岗位相关优势证据"\s+name="application-final-review-strengths"\s+autoComplete="off"/);
assert.match(applicationFinalReview, /<TextArea\s+aria-label="风险与反证"\s+name="application-final-review-risks"\s+autoComplete="off"/);
assert.match(applicationFinalReview, /<TextArea\s+aria-label="限制与待核实项"\s+name="application-final-review-limitations"\s+autoComplete="off"/);
assert.match(applicationFinalReview, /<Select aria-label="终评处置"/);
assert.match(applicationFinalReview, /<Input\s+aria-label="处置理由代码"\s+name="application-final-review-disposition-reason"\s+autoComplete="off"/);
assert.match(assessmentArchive, /<Select\s+aria-label=\{`报告 \$\{row\.binding_id\} 的类型`\}/);
assert.match(assessmentArchive, /<Select aria-label="批量导入报告类型"/);
assert.match(assessmentArchive, /<Input\s+aria-label="批量导入测评日期"\s+name="assessment-archive-import-date"\s+autoComplete="off"/);
assert.match(deepProfile, /<TextArea\s+aria-label=\{`\$\{q\.question\}的回答`\}\s+name=\{`deep-profile-followup-answer-\$\{i\}`\}\s+autoComplete="off"/);
assert.match(deepProfile, /<Input\s+aria-label="飞书妙记链接"\s+name="deep-profile-lark-minutes-url"\s+autoComplete="off"/);
assert.match(deepProfile, /<TextArea\s+aria-label=\{`\$\{MATERIAL_SOURCES\[sourceType\]\.label\}内容`\}\s+name="deep-profile-interview-material"\s+autoComplete="off"/);
assert.match(interviewReview, /<Select\s+aria-label="待归属材料选择面试轮次"/);
assert.doesNotMatch(interviewReview, /aria-label="面试录音摘要文件路径"|name="interview-review-summary-path"|placeholder="summaryPath"/,
  'ordinary HR users must never type or see a local summaryPath field');
assert.match(interviewReview, /ref=\{summaryImportTriggerRef\}[\s\S]*?选择旧 summary\.json 并导入/,
  'legacy summary import must use the native picker trigger');
assert.match(interviewReview, /api\.selectInterviewRecordingSummary\(\)[\s\S]*?selection\?\.canceled[\s\S]*?api\.importInterviewRecordingSummary\(selection\.path\)/,
  'cancel must stop before the existing summary import write');
assert.match(interviewSchedule, /<Input\s+aria-label="新增面试官姓名"\s+name="interview-schedule-new-interviewer-name"\s+autoComplete="off"/);
assert.match(localInterview, /<Input\s+aria-label="本地音视频文件路径"\s+name="local-interview-media-file-path"\s+autoComplete="off"/);
assert.match(talentPool, /<Input\.TextArea\s+aria-label="人才库再触达草稿"\s+name="talent-pool-outreach-draft"\s+autoComplete="off"/);
assert.match(talentPool, /className="talent-pool-history-toggle"[\s\S]*?aria-expanded=\{historyExpanded\}[\s\S]*?aria-controls=\{historyRegionId\}/);

// 活跃工作区的自由文本/数字字段必须带稳定 name，并阻止密码管理器误填招聘数据。
assert.match(jobManagement, /aria-label="职位名称"\s+name="job-management-title"\s+autoComplete="off"/);
assert.match(jobManagement, /aria-label="HC"\s+name="job-management-headcount"\s+autoComplete="off"\s+inputMode="numeric"/);
assert.match(jobLedger, /role="search" aria-label="岗位筛选"[\s\S]*?aria-label="搜索岗位"\s+name="job-ledger-search"\s+autoComplete="off"/);
assert.match(jobLedger, /name="job-create-name" autoComplete="off"/);
assert.match(jobLedger, /name="job-edit-planned-hires" autoComplete="off" inputMode="numeric"/);
assert.match(interviewSchedule, /name=\{`interview-invitation-draft-\$\{session\.id\}`\}\s+autoComplete="off"/);
assert.match(interviewSchedule, /name=\{`interview-schedule-meeting-link-\$\{session\.id\}`\}[\s\S]*?type="url"[\s\S]*?autoComplete="off"/);
assert.match(interviewReview, /<Select\s+aria-label="选择已创建的面试轮次"/);
assert.doesNotMatch(interviewReview, /name="interview-review-round"|name="interview-review-assignment-round"/,
  'recording and material assignment must select canonical Sessions instead of accepting free-form rounds');
assert.match(interviewReview, /name="interview-review-duration-seconds"\s+autoComplete="off"\s+type="number"\s+inputMode="numeric"/);
assert.match(interviewReview, /name="interview-review-duration-seconds"[\s\S]*?min=\{MIN_RECORDING_DURATION_SECONDS\}[\s\S]*?max=\{MAX_RECORDING_DURATION_SECONDS\}[\s\S]*?aria-describedby="interview-recording-duration-hint"/);
assert.match(interviewReview, /id="interview-recording-duration-hint"[\s\S]*?role=\{durationValidationError \? 'alert' : undefined\}/);
assert.match(localInterview, /name="local-interview-topic"\s+autoComplete="off"/);
assert.match(talentPool, /aria-label="搜索人才库"\s+name="talent-pool-search"\s+autoComplete="off"/);
assert.match(talentPool, /role="listbox" aria-label="人才列表"/);
assert.match(talentPool, /role="option"[\s\S]*?aria-selected=\{selected\}[\s\S]*?tabIndex=\{tabIndex\}/);
assert.match(settings, /name="settings-brand-mark"\s+autoComplete="off"/);
assert.match(settings, /name="settings-brand-name"\s+autoComplete="off"/);
assert.match(settings, /name="settings-brand-mark"[\s\S]*?maxLength=\{4\}[\s\S]*?showCount/);
assert.match(settings, /name="settings-brand-name"[\s\S]*?maxLength=\{32\}[\s\S]*?showCount/);
assert.match(settings, /aria-label=\{returnActionLabel\}[\s\S]*?title=\{returnActionLabel\}[\s\S]*?\{returnActionLabel\}/);
assert.ok((settings.match(/aria-describedby="settings-brand-feedback"/g) || []).length >= 2,
  'both brand fields must reference the shared validation and persistence feedback');
assert.match(settings, /settings-llm-connection" aria-label="外部 AI 服务连接"/);
assert.match(settings, /label htmlFor="settings-llm-provider"[\s\S]*?id="settings-llm-provider"/);
assert.match(settings, /label htmlFor="settings-llm-base-url"[\s\S]*?id="settings-llm-base-url"/);
assert.doesNotMatch(settings, /固定 AI 服务|查看服务/);
assert.match(settings, /<Select[\s\S]*?aria-label="AI 模型"[\s\S]*?options=\{llmModelGroups\}[\s\S]*?showSearch[\s\S]*?optionFilterProp="label"/,
  'the automatic model picker must expose grouped searchable Provider options');
assert.match(settings, /aria-label="手动输入 AI 模型 ID"[\s\S]*?maxLength=\{160\}/,
  'advanced users must be able to enter a bounded manual model identifier');
assert.match(settings, /settings-llm-model-row[\s\S]*?刷新列表[\s\S]*?测试并使用/,
  'model selection, catalog refresh and compatibility test must stay in one action context');
assert.doesNotMatch(settings, /<AutoComplete[\s\S]*?aria-label="AI 模型"/,
  'the model picker must not silently accept arbitrary identifiers through AutoComplete');
assert.match(topBar, /className="topbar-left topbar-job-context" role="group" aria-label=/);

// 面试首载保持稳定几何；读取失败必须有明确重试，不能退化成空态。
assert.match(interviewSchedule, /function InterviewScheduleLoadingState\([\s\S]*?<Skeleton active/);
assert.match(interviewSchedule, /message="面试安排读取失败"[\s\S]*?action=\{<Button onClick=\{onRetry\}>重新读取<\/Button>\}/);
assert.match(interviewSchedule, /role="status"\s+aria-live="polite"\s+aria-label="正在加载面试安排"/);
assert.match(interviewSchedule, /function InterviewScheduleEmptyState\([\s\S]*?aria-label=\{hasJob \? '当前岗位暂无可用的面试安排数据' : '尚未选择岗位'\}/);
assert.match(interviewSchedule, /请先在顶部选择岗位；如果还没有岗位，请先前往职位管理创建。[\s\S]*?<Button type="primary" onClick=\{onOpenJobs\}>前往职位管理<\/Button>/);
assert.match(interviewSchedule, /if \(!job\) \{[\s\S]*?<InterviewScheduleEmptyState[\s\S]*?job=\{null\}/,
  'missing job context must render a recoverable empty state instead of an endless skeleton');
assert.match(interviewSchedule, /if \(loadState === 'loading'\) \{[\s\S]*?<InterviewScheduleLoadingState/,
  'the interview skeleton must be restricted to the real loading state');
assert.match(app, /<InterviewScheduleCanonical[\s\S]*?onOpenJobs=\{\(\) => handleOpenNav\('职位管理'\)\}/,
  'the missing-job empty state must provide a reachable job-management action');
assert.match(interviewScheduleFixture, /<InterviewScheduleCanonical[\s\S]*?dataAdapter=\{fixtureAdapter\}[\s\S]*?fixtureMode/,
  'fixture interviews must reuse the canonical skeleton through an isolated adapter');
assert.doesNotMatch(interviewScheduleFixture, /\bapi\.|fetch\(/,
  'fixture adapter must not call production APIs');
assert.doesNotMatch(interviewScheduleFixture, /<Spin\b/);
assert.match(interviewReview, /function InterviewReviewLoadingState\([\s\S]*?role="status"[\s\S]*?aria-live="polite"[\s\S]*?<Skeleton/);
assert.match(interviewReview, /initialLoadPending \? \([\s\S]*?<InterviewReviewLoadingState label="正在读取候选人面试资料"/);
assert.match(interviewReview, /message="面试复盘读取失败"[\s\S]*?不会把读取失败当作空数据[\s\S]*?重新读取/);
assert.match(interviewReview, /loading && contextIsCurrent[\s\S]*?现有内容会保留到本次读取完成/);
assert.match(interviewReview, /loadError \? \([\s\S]*?message="全文转写暂不可读"[\s\S]*?不会按“暂无全文转写”处理[\s\S]*?重新读取/);
assert.match(interviewReview, /message="面试轮次报告暂不可读，当前记录已锁定"[\s\S]*?不会按“尚无面试轮次报告”处理[\s\S]*?重新读取/);
assert.match(interviewReview, /message="面试报告暂不可读，当前记录已锁定"[\s\S]*?不会按“暂无报告”处理[\s\S]*?重新读取/);
assert.match(interviewReview, /message="面试脚本暂不可读"[\s\S]*?不会按“当前岗位还没有面试脚本”处理[\s\S]*?重新读取成功前已禁用生成和保存/);
assert.match(interviewReview, /message="可选 AI 配置状态暂不可读"[\s\S]*?人工复盘、事实确认和入档仍可继续[\s\S]*?不会把读取失败当作未配置，也不会自动重试/);
assert.match(interviewReview, /id=\{`interview-ai-review-action-[^`]+`\}[\s\S]*?disabled=\{readOnly \|\| !!busyKey \|\| reportLocked \|\| !!reportLoadError/);
assert.doesNotMatch(interviewReview, /disabled=\{[^}]*!llmAvailable/,
  'unconfigured AI must keep the task-level action discoverable so the first-use prompt can explain the boundary');
assert.match(interviewReview, /<ExternalAiFirstUsePrompt[\s\S]*?capability="interview_review"/);
assert.match(interviewReview, /setReportLoadErrors\(nextReportLoadErrors\)/);
assert.match(interviewReview, /setSessionReportLoadErrors\(nextSessionReportLoadErrors\)/);
assert.match(interviewReview, /if \(!hadCurrentSnapshot\) \{[\s\S]*?setRecords\(\[\]\);/);
assert.doesNotMatch(interviewReview, /<Spin\b/);

// 每个活动模块由 App 提供唯一 H1；可见页面标题保持原尺寸与层级。
assert.match(dashboard, /<Title className="dashboard-page-title" level=\{2\}>\{job\?\.name \|\| `岗位 \$\{jobId\}`\}<\/Title>/);
assert.match(jobLedger, /<Title level=\{2\} className="job-ledger-hero-title" aria-hidden="true">职位管理<\/Title>/,
  'the visible job title must not duplicate the focused module H1 for assistive technology');
assert.match(interviewSchedule, /<Title level=\{2\}>\{job\?\.name \|\| '当前岗位'\} · 面试安排<\/Title>/);
assert.match(interviewSchedule, /hasJob \? `\$\{job\.name \|\| `岗位 \$\{job\.id\}`\} · 面试安排` : '面试安排'/,
  'the missing-job empty state must not claim that a current job exists');
assert.match(interviewScheduleFixture, /import InterviewScheduleCanonical from '\.\/InterviewScheduleCanonical\.jsx'/);
assert.match(talentPool, /<Title level=\{2\}>历史候选人再发现<\/Title>/);
assert.match(settings, /<span className="settings-page-title">设置<\/span>/);
assert.doesNotMatch(settings, /<Title\b[^>]*>设置<\/Title>/,
  'the visible settings title must not duplicate the focused module H1 for assistive technology');
assert.match(candidateList, /function CandidateListSkeleton\(\)[\s\S]*?<Skeleton active/);
assert.doesNotMatch(candidateList, /candidate-empty-state" role="status"[\s\S]*?<Spin/);
assert.match(dashboard, /function DashboardLoadingSkeleton\(\{ label \}\)[\s\S]*?<Skeleton active/);
assert.match(talentPool, /className="talent-pool-loading-grid"[\s\S]*?<Skeleton active/);
assert.match(assessmentArchive, /function AssessmentArchiveSkeleton\(\)[\s\S]*?<Skeleton active/);

assert.match(assessmentArchive, /<img src=\{previewUrl\}[\s\S]*?width=\{1240\} height=\{1754\}/);

assert.match(jobLedger, /aria-label="搜索岗位"/);
assert.match(jobLedger, /aria-label="按岗位状态筛选"/);
assert.match(jobLedger, /aria-label=\{`管理 \$\{job\.name \|\| `岗位 \$\{job\.id\}`} 的 JD 和画像`\}/);
assert.match(jobLedger, /aria-label=\{`打开 \$\{job\.name \|\| `岗位 \$\{job\.id\}`} 的更多操作`\}/);

assert.match(interviewReview, /aria-label="面试脚本文本"\s+name="interview-review-script-text"\s+autoComplete="off"/);
assert.match(interviewReview, /className="interview-script-text-preview" aria-label="当前保存的面试脚本"/);
assert.match(interviewReview, /export default function InterviewReviewPanel\(\{[\s\S]*?candidate,[\s\S]*?readOnly,[\s\S]*?onOpenSettings,[\s\S]*?onDirtyChange,[\s\S]*?initialTab = 'review',[\s\S]*?navigationRequestKey,[\s\S]*?\}\)/);
assert.match(interviewReview, /const hasUnsavedChanges = scriptDraftDirty \|\| reportDraftDirty \|\| sessionFactsDirty \|\| confirmationsDirty;/);
assert.match(interviewReview, /window\.addEventListener\('beforeunload', protectWindowClose\)/);
assert.match(interviewReview, /function requestRefresh\(\)[\s\S]*?title: '放弃未保存的面试修改并刷新？'[\s\S]*?okText: '放弃修改并刷新'/);
assert.match(interviewReview, /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches[\s\S]*?target\.scrollIntoView\(\{ behavior: reduceMotion \? 'auto' : 'smooth'[\s\S]*?target\.focus\(\{ preventScroll: true \}\)/);
assert.match(interviewReview, /aria-label=\{`录音 \$\{id \|\| '当前'\} 的面试报告 JSON`\}/);
assert.match(interviewReview, /aria-label=\{`面试轮次记录 \$\{session\.id\} 报告 JSON`\}/);
assert.match(interviewReview, /aria-label=\{`\$\{item\.label \|\| item\.id \|\| '确认项'\}（第 \$\{index \+ 1\} 项）确认状态`\}/);

// Collapse headers carry role="tab" and tabIndex 0 — they are the only way into
// the schedule history by keyboard — but antd ships them with no focus
// indicator. This is pinned here rather than in the runtime gate because that
// gate's Electron window is never the OS focus window, so its document never
// satisfies :focus and no computed style there can prove the rule fires.
assert.match(styles,
  /\.ant-collapse > \.ant-collapse-item > \.ant-collapse-header:focus-visible \{[^}]*box-shadow: var\(--hb-focus-ring\)/,
  'collapse headers must show the shared focus ring when reached by keyboard');

// The deep profile dialog hands its opening focus to the introduction block.
// The reaudit's "bare paragraph bottom line" was confirmed real in a focused
// window on 2026-08-02: the block is the first child of the modal's
// overflow:auto body, so any outward ring (outline with positive offset, or
// the outer --hb-focus-ring shadow) is clipped on three container edges and
// only its bottom edge survives. The ring must therefore be inset. Pinned at
// source level because the gate window cannot witness :focus rendering.
assert.match(deepProfile,
  /ref=\{dialogInitialFocusRef\}\s+className="deep-profile-modal-introduction"\s+tabIndex=\{-1\}/,
  'the deep profile opening focus target must be the introduction block the focus CSS names');
assert.match(decisionUi,
  /\.deep-profile-modal-introduction:focus,\s*\.deep-profile-modal-introduction:focus-visible \{[^}]*outline: 2px solid var\(--hb-primary\);[^}]*outline-offset: -2px;/,
  'deep profile introduction focus must draw an inset ring — an outward ring is clipped by the modal body to a bottom-edge line');

console.log('check-ui-a11y-copy-001 ok');
