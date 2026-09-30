
const { PROJECT_ROOT } = require("../src/paths");
const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

const settings = read('frontend/src/components/SettingsPanel.jsx');
const app = read('frontend/src/App.jsx');
const topBar = read('frontend/src/components/TopBar.jsx');
const styles = read('frontend/src/styles.css');
const settingsState = read('frontend/src/settings-state.mjs');
const candidateMain = read("src/candidate-main.js");
const desktopBranding = read("src/desktop-branding.js");
const desktopLauncher = read("src/desktop-launcher.js");
const packageMetadata = JSON.parse(read('package.json'));
const preload = read("src/preload.js");
const frontendApi = read('frontend/src/api.js');
assert.match(read('frontend/index.html'), /<title>招才官<\/title>/);
assert.match(read('frontend/index.html'), /name="description" content="招才官，HR 的招聘桌面助手"/);

for (const section of [
  ['settings-overview', '本机状态'],
  ['settings-integrations', 'AI 与外部连接'],
  ['settings-interview-tools', '面试工具'],
  ['settings-data', '数据与隐私'],
  ['settings-brand', '界面显示'],
  ['settings-advanced', '关于与诊断'],
]) {
  assert.ok(settings.includes("['" + section[0] + "', '" + section[1] + "']"), 'settings navigation must label ' + section[1]);
  assert.ok(settings.includes('id="' + section[0] + '"'), 'settings page must expose ' + section[1]);
  assert.ok(settings.includes("activeSection === '" + section[0] + "'"), 'settings must isolate panel ' + section[1]);
}
assert.doesNotMatch(settings, /href="#settings-/);
assert.match(settings, /aria-current=\{activeSection === sectionId \? 'page' : undefined\}/);
assert.doesNotMatch(settings, /role="tablist"|role="tab"|role="tabpanel"/);
const navigationDefinition = settings.slice(
  settings.indexOf('const SETTINGS_SECTIONS'),
  settings.indexOf(']);', settings.indexOf('const SETTINGS_SECTIONS')),
);
const navigationOrder = [
  'settings-overview',
  'settings-integrations',
  'settings-interview-tools',
  'settings-data',
  'settings-brand',
  'settings-advanced',
].map((id) => navigationDefinition.indexOf("'" + id + "'"));
assert.deepEqual([...navigationOrder].sort((a, b) => a - b), navigationOrder, 'settings navigation must follow the HR-first order');
const sectionPosition = Object.fromEntries([
  'settings-overview',
  'settings-brand',
  'settings-integrations',
  'settings-interview-tools',
  'settings-data',
  'settings-advanced',
].map((id) => [id, settings.indexOf('id="' + id + '"')]));
const integrations = settings.slice(sectionPosition['settings-integrations'], sectionPosition['settings-interview-tools']);
assert.match(integrations, /可选加速与外部来源/);
assert.match(integrations, /高级设置：服务地址、访问密钥与模型/);
assert.doesNotMatch(integrations, /settings-protection-grid/);
assert.match(integrations, /settings-llm-connection/);
assert.match(integrations, /name="settings-llm-provider"/);
assert.match(integrations, /name="settings-llm-base-url"/);
assert.match(integrations, /llmFieldErrors\.provider/);
assert.match(integrations, /llmFieldErrors\.baseUrl/);
assert.match(integrations, /更换服务后须重新填写密钥并测试模型/);
assert.match(settings, /llmConnectionHasUnsavedChanges/);
assert.match(settings, /hasLlmConnectionChanges\(llmConfig, llmPersistedConfigRef\.current\)/);
assert.match(integrations, /<Select[\s\S]*?aria-label="AI 模型"[\s\S]*?options=\{llmModelGroups\}[\s\S]*?showSearch[\s\S]*?optionFilterProp="label"[\s\S]*?listHeight=\{240\}/);
assert.match(integrations, /手动输入模型 ID/);
assert.match(integrations, /aria-label="手动输入 AI 模型 ID"/);
assert.match(integrations, /settings-llm-model-row[\s\S]*刷新列表[\s\S]*测试并使用/);
assert.match(settings, /可选模型（须通过兼容性测试）/);
assert.match(integrations, /可选择服务返回的模型，也可手动输入模型 ID/);
assert.match(integrations, /严格 JSON 测试/);
assert.doesNotMatch(integrations, /settings-llm-steps|统一 AI 配置能力状态|OpenAI-compatible API/);
const interview = settings.slice(sectionPosition['settings-interview-tools'], sectionPosition['settings-data']);
assert.doesNotMatch(interview, /settings-inline-diagnostics|whisperModel|info\.path/);
const data = settings.slice(sectionPosition['settings-data'], sectionPosition['settings-advanced']);
assert.match(data, /招才官本地副本保存在本机/);
assert.match(data, /当前岗位“\$\{job\.name\}”共 \$\{candidates\.length\} 名候选人/);
assert.doesNotMatch(data, /当前共 \{jobs\.length\} 个岗位、\{candidates\.length\} 名候选人/);
assert.match(data, /备份与换机/);
assert.match(data, /换机前检查/);
assert.match(data, /查看路径与步骤/);
assert.match(data, /HR_MIGRATION_ITEMS\.map/);
assert.doesNotMatch(data, /localPathRows\.map|ADVANCED_MIGRATION_ITEMS\.map|MODULES\.map/);
const advanced = settings.slice(sectionPosition['settings-advanced']);
assert.match(advanced, /最近任务进度/);
assert.match(advanced, /模块开放状态/);
assert.match(advanced, /localPathRows\.map/);
assert.doesNotMatch(settings, /<PROJECT_ROOT>|app\/data|迁移交接文档/);
assert.match(advanced, /localPathsError \? \(/);
assert.match(advanced, /本机目录读取失败/);
assert.match(advanced, /setLocalPathsLoadAttempt\(\(attempt\) => attempt \+ 1\)/);
assert.match(advanced, /\) : localPaths \? \(/);
assert.match(advanced, /role="status">正在读取本机目录/);
assert.match(settings, /退出应用后，按本页实际路径备份/);
assert.match(settings, /数据库或面试目录位于数据目录之外/);
assert.match(advanced, /ADVANCED_MIGRATION_ITEMS\.map/);
assert.match(advanced, /面试工具路径与模型诊断/);
assert.doesNotMatch(advanced, /HR_MIGRATION_ITEMS\.map/);

for (const label of ['面试设备', '外部 AI 辅助']) {
  assert.ok(settings.includes('label="' + label + '"'), 'overview must show ' + label);
}
for (const action of ['查看面试工具']) {
  assert.ok(settings.includes('>' + action + '</Button>'), 'overview must expose next action ' + action);
}
assert.match(settings, /overviewAiNeedsConfiguration \? '按需启用外部 AI' : '查看外部 AI 状态'/);
assert.match(settings, /title: '本地招聘可用'/);
assert.match(settings, /当前可以建立岗位、完善 JD、导入候选人并继续本地流程/);
assert.match(settings, /text: '未启用（默认）'/);
assert.match(settings, /value: '使用本地录音\/转写前检查'/);
assert.match(settings, /settingsBusinessReturn\(\{/);
assert.match(settings, /message=\{businessReturn\.label\}/);
assert.match(settings, /description=\{businessReturn\.description\}/);
assert.match(settingsState, /返回工作台新建岗位/);
assert.match(settingsState, /返回工作台处理 \$\{preparationCodes\.size\} 项岗位准备/);
assert.match(settingsState, /返回工作台继续招聘/);
assert.match(settings, /jobsLoadState === 'error'[\s\S]*workbenchState === 'error'/);
assert.doesNotMatch(settings.match(/const coreStateError[\s\S]*?const coreStateLoading/)?.[0] || '', /boss|llm|doctor/i);
assert.match(settings, /function beginLlmDraftEdit\(\)/);
assert.match(settings, /const llmConfigurationLocked = isLlmConfigurationLocked\(readOnly, llmLoadError\)/);
assert.match(settings, /state: llmLoadRecovery\.retryable \? 'load-error' : 'startup-fault'/);
assert.match(settings, /llmConfigLoadRecovery\(llmLoadErrorCode\)/);
assert.match(settings, /setLlmLoadErrorCode\(err\.code \|\| ''\)/);
assert.match(settings, /llmLoadRecovery\.action \? \{ action: llmLoadRecovery\.action \}/);
assert.match(settings, /本次启动中重复读取无法恢复；请重启招才官/);
assert.match(settings, /配置读取失败，高级设置已锁定/);
assert.match(settings, /llmPersistedConfigRef\.current = null/);
assert.doesNotMatch(settings, /llmPersistedConfigRef\.current = current/);
assert.doesNotMatch(settings, /label="只读 UI"|label="动作接口"|label="写动作菜单"/);

assert.doesNotMatch(settings, /gateCanWrite|WRITE_ACTIONS_VISIBLE|access\.canWrite|人工确认后可用/);
assert.doesNotMatch(settings, /status\.gateCanRead \? '可读'|status\.gateCanWrite \? '可写'/);
assert.doesNotMatch(`${settings}\n${app}`, /bossLoginStatus|bossDisplay|bossAccess|bossEffectiveAccess|refreshBossLogin/,
  'the removed platform connection status must not resurface in settings or the app shell');

assert.match(settings, /enabled: false/);
const saveLlmSettings = settings.slice(settings.indexOf('async function saveLlmSettings'), settings.indexOf('async function refreshLlmModels'));
assert.doesNotMatch(saveLlmSettings, /governanceApproved/);
assert.doesNotMatch(settings, /governanceApproved|治理未批准|HRBOSS_EXTERNAL_AI_GOVERNANCE_APPROVED/);
assert.match(settings, /const llmHasUnsavedChanges = hasUnsavedLlmChanges\(llmConfig, llmPersistedConfigRef\.current, llmApiKey\)/);
assert.match(settings, /!!llmApiKey\.trim\(\) \|\| llmHasUnsavedChanges/);
assert.doesNotMatch(settings, /llmConnectionDirty|llmSettingsDirty/);
assert.match(settings, /外部 AI 有未保存修改，当前生效状态没有改变/);
assert.match(settings, /外部 AI 有未保存修改/);
assert.match(settings, /title="设置有未保存修改"/);
assert.match(settings, /离开设置会丢失本页草稿/);
assert.match(settings, /设置内切换分区不会丢失草稿/);
assert.match(settings, /\.nav-primary \.nav-item/);
assert.match(settings, /\.mobile-module-field select/);
assert.match(settings, /window\.addEventListener\('beforeunload', guardWindowClose\)/);
assert.match(settings, /const destination = pendingSection/);
assert.match(settings, /destination\.startsWith\('nav:'\)/);
assert.match(settings, /<Modal[\s\S]*open=\{Boolean\(pendingSection\)\}[\s\S]*autoFocus[\s\S]*放弃草稿并离开/);
assert.match(settings, /maskClosable=\{false\}/);
assert.match(settings, /pendingNavigationTriggerRef\.current = button/);
assert.match(settings, /afterClose=\{\(\) => \{[\s\S]*trigger\.focus\(\)/);
assert.doesNotMatch(settings, /settings-unsaved-switch-alert/);
assert.doesNotMatch(settings, /activeSection !== 'settings-integrations' \|\| !llmHasUnsavedChanges/);
assert.match(settings, /保存外部 AI 修改/);
assert.match(settings, /刷新可用模型/);
assert.match(settings, /async function testLlmModel\(\)[\s\S]*api\.testLlmModel\(model\)/);
assert.match(settings, /模型测试通过/);
assert.match(settings, /测试仅发送合成文本，不含候选人材料/);
assert.match(settings, /启用人工 AI 分析/);
assert.match(settings, /不发送候选人材料，也不要求先启用 AI/);
assert.match(settings, /保存并启用/);
assert.match(settings, /const returnDestination = returnNav && returnNav !== '设置' \? returnNav : '工作台'/);
assert.match(settings, /const returnActionLabel = `返回\$\{returnDestination\}`/);
assert.match(settings, /aria-label=\{returnActionLabel\}[\s\S]*?title=\{returnActionLabel\}[\s\S]*?\{returnActionLabel\}/,
  'Settings return button must expose the same destination in visible text, accessible name and tooltip');
assert.doesNotMatch(settings, /<Title level=\{2\}[^>]*>设置<\/Title>/,
  'the visible Settings chrome must not duplicate App semantic h1');
assert.match(settings, /<span className="settings-page-title">设置<\/span>/);
assert.doesNotMatch(settings, /returnNav === '候选人' \? \{ action: '返回候选人' \}/);
assert.match(settings, /<Input\.Password/);
assert.match(settings, /visibilityToggle=\{false\}/);
assert.match(settings, /若只能在本次会话生效，保存后会明确警告/);
assert.match(settings, /优先写入系统安全存储；若不可用则仅在本次会话生效并明确警告/);
assert.doesNotMatch(settings, /密钥只进入系统安全存储/);
assert.match(settings, /不写入 localStorage、SQLite 或日志/);
assert.match(settings, /settings-llm-clear-confirm/);
assert.match(settings, /确定清除本机 API Key/);
assert.match(settings, /清除并关闭/);
assert.match(settings, /本机 API Key 已清除/);
assert.match(settings, /外部 AI 仅在本次会话关闭/);
assert.match(settings, /重启后原访问密钥可能恢复/);
assert.match(settings, /const llmPersistedConfigRef = useRef\(null\)/);
assert.match(settings, /const persistedConfig = llmPersistedConfigRef\.current \|\| llmConfig/);
assert.match(settings, /本页未保存修改也会放弃/);
assert.match(settings, /aria-label="允许人工发起外部 AI 分析"/);
assert.match(settings, /启用不等于自动发送/);
assert.match(settings, /const llmEnableUnavailable = llmConfig\.enabled !== true && llmConfig\.modelVerified !== true/);
assert.match(settings, /disabled=\{llmConfigurationLocked \|\| !!llmBusy \|\| llmEnableUnavailable\}/);
assert.doesNotMatch(settings, /if \(readOnly\) return \(\) => \{ active = false; \};/);
assert.match(settings, /只读模式仍读取已保存的外部 AI 状态/);
assert.match(settings, /if \(llmBusy === 'load'\)/);
assert.match(settings, /if \(llmLoadError\)/);
assert.match(settings, /llmOperationError\.title/);
assert.match(settings, /if \(llmConfig\.enabled !== true\)/);
assert.match(settings, /外部 AI 已开启但配置未完成，当前不可调用/);
assert.match(settings, /const llmOperational = llmConfig\.operational === true[\s\S]*!llmHasUnsavedChanges/);
assert.match(settings, /if \(!llmOperational\)[\s\S]*AI 配置尚未完全生效[\s\S]*检查高级设置/,
  'enabled but non-operational AI must not be presented as ready');
assert.match(settings, /AI 可用：同一配置已驱动/);
for (const capability of ['JD', '深度画像', '候选人初评', '测评分析', '面试复盘']) {
  assert.ok(settings.includes("'" + capability + "'"), 'settings must show unified AI capability ' + capability);
}

for (const capability of ['录音工具', '本地转写', '音频导入']) {
  assert.ok(settings.includes("capability('" + capability + "'"), 'doctor must expose ' + capability);
}
assert.match(settings, /'视频导入'/);
assert.match(settings, /const ffmpegReady = tools\.ffmpeg\?\.runnable === true/);
assert.match(settings, /const videoImportReady = afconvertReady \|\| ffmpegReady/);
assert.match(settings, /videoCapability\.status = '有限可用'/);
assert.match(settings, /settings-capability-grid/);
assert.match(settings, /settings-advanced-card/);
assert.match(settings, /interviewDeviceSummary/);
assert.match(settings, /doctorError \? '状态未知'/);
assert.doesNotMatch(settings, /disabled=\{readOnly \|\| doctorDegraded\}/);
assert.match(settings, /开始检查软件依赖/);
assert.match(settings, /开始 8 秒麦克风测试/);
assert.match(settings, /api\.localInterviewMicCheck/);
assert.match(settings, /不会自动访问麦克风/);
assert.match(settings, /const doctorMicCheckReady = localInterviewMicCheckReady\(doctor\)/);
assert.match(settings, /micCheckRunIdRef\.current = ''/,
  'rerunning software discovery must invalidate a previous microphone conclusion');
assert.match(settings, /micCheckRunIdRef\.current = String\(nextJob\?\.id \|\| ''\)/,
  'a microphone result must be tied to the test launched in this settings session');
assert.match(settings, /micCheckJob\?\.status === 'done'[\s\S]*micCheckJob\?\.mode === 'mic-check'[\s\S]*micCheckRunIdRef\.current/,
  'only a completed matching mic-check job may drive device readiness');
assert.match(settings, /\['starting', 'running'\]\.includes\(nextJob\?\.status\)[\s\S]*setMicCheckNotice\(/,
  'a starting or running mic check must remain pending instead of becoming a false failure');
const micCheckRunningBranch = settings.match(/if \(\['starting', 'running'\]\.includes\(nextJob\?\.status\)\) \{([\s\S]*?)\} else if/)?.[1] || '';
assert.doesNotMatch(micCheckRunningBranch, /setMicCheckError\(/,
  'only a terminal error may set the mic-check failure state');
assert.match(settings, /micCheckLoading \|\| micCheckInProgress/,
  'a pending test must keep duplicate microphone starts disabled');
assert.match(settings, /async function resumeMicCheckPolling\(\)[\s\S]*继续读取结果/,
  'a long-running local transcription must offer an explicit result refresh without starting a second recording');
assert.doesNotMatch(settings, /Windows 本地录音与 ASR 暂不可用/);
assert.match(styles, /\.settings-state-grid\.settings-overview-grid\s*\{\s*grid-template-columns:\s*1fr;/);
assert.match(styles, /\.settings-section-nav button:focus-visible[\s\S]*outline:\s*2px solid/);
assert.match(styles, /\.settings-section-nav button\.active/);
assert.match(styles, /\.settings-admin-config-body/);
assert.match(styles, /small\.settings-field-error[\s\S]*var\(--hb-error-text\)/);
assert.match(styles, /\.settings-llm-connection \{[\s\S]*grid-template-columns: minmax\(160px, 1fr\) minmax\(0, 2fr\);[\s\S]*background: #f1f3f5;/);
assert.match(styles, /\.settings-llm-model-row \{[\s\S]*grid-template-columns: minmax\(260px, 1fr\) auto auto;/);
assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.settings-llm-key-row,[\s\S]*\.settings-llm-model-row \{[\s\S]*grid-template-columns: 1fr;/);
assert.match(styles, /\.settings-state-card\.neutral > span/);
assert.match(styles, /\.external-ai-first-use-boundary/);

assert.match(candidateMain, /canonicalBaseUrl\(rawBaseUrl\)/);
assert.match(candidateMain, /queueLlmOperation/);
assert.match(candidateMain, /sameExternalAiConnection\(config, persistedLlmConfig/);
assert.doesNotMatch(candidateMain, /external-navigation:/);
assert.match(candidateMain, /llm-model:test[\s\S]*requestPath: '\/llm\/models\/test'/);
assert.match(candidateMain, /minWidth: 1024/);
assert.doesNotMatch(preload, /externalNavigation|external-navigation:/);
assert.match(preload, /llmCredential[\s\S]*testModel[\s\S]*llm-model:test/);
assert.match(frontendApi, /async function testLlmModel\(model\)[\s\S]*window\.llmCredential\.testModel/);
assert.match(preload, /sendSync\('settings-state:external-ai-dirty', dirty === true\) === true/);
assert.match(settings, /useLayoutEffect\(\(\) => \{[\s\S]*?setExternalAiDirty/);

assert.match(settings, /role="status" aria-live="polite"/);
assert.match(app, /showJobContext=\{activeNav !== '设置'\}/);
assert.match(app, /showSabcFilter=\{activeNav === '候选人'\}/);
assert.match(topBar, /showJobContext = true/);
assert.match(topBar, /showSabcFilter = false/);
assert.match(topBar, /\{showJobContext && \(/);
assert.match(topBar, /aria-label=\{showSabcFilter \? '岗位与评级筛选' : '岗位上下文'\}/);
assert.match(topBar, /\{showSabcFilter && \(/);

assert.match(app, /const PRIMARY_NAV_ITEMS = \['工作台', '职位管理', '候选人', '面试安排', '人才库'\];/);
assert.match(app, /const UTILITY_NAV_ITEMS = \['使用指南', '设置', '关于\/版本', '本机状态'\];/);
assert.match(app, /const SETTINGS_UTILITY_SECTIONS = Object\.freeze\(\{[\s\S]*?'关于\/版本': 'settings-advanced'[\s\S]*?本机状态: 'settings-overview'/);
assert.match(app, /const MOBILE_NAV_ITEMS = \[\.\.\.PRIMARY_NAV_ITEMS, \.\.\.UTILITY_NAV_ITEMS\];/);
assert.doesNotMatch(app, /PLANNED_NAV_ITEMS|nav-planned|规划中模块|流程管理|数据分析/);
assert.match(app, /const DESKTOP_UTILITY_MENU_ITEMS = Object\.freeze\(\[[\s\S]*?key: 'guide',[\s\S]*?label: '使用指南',[\s\S]*?description: '流程说明与操作帮助',[\s\S]*?navigation: '使用指南'[\s\S]*?key: 'settings-center',[\s\S]*?label: '设置中心',[\s\S]*?description: '状态、连接、面试与数据'[\s\S]*?key: 'local-status',[\s\S]*?label: '本机状态',[\s\S]*?description: '服务、数据和运行检查'[\s\S]*?sectionId: 'settings-overview'[\s\S]*?key: 'about',[\s\S]*?label: '关于招才官',[\s\S]*?description: '版本与本机诊断'[\s\S]*?sectionId: 'settings-advanced'[\s\S]*?focusTargetId: 'settings-about-title'/);
assert.match(app, /const CONFIGURABLE_SETTINGS_SECTIONS = new Set\(\[[\s\S]*?'settings-brand'[\s\S]*?'settings-integrations'[\s\S]*?'settings-interview-tools'[\s\S]*?'settings-data'/);
assert.match(app, /className="nav-utility app-nav-footer" aria-label="帮助与设置"/);
assert.match(app, /DESKTOP_UTILITY_MENU_ITEMS\.map\(\(item\) =>/);
assert.match(app, /className: 'app-nav-utility-menu-item'/);
assert.match(app, /id: APP_NAV_UTILITY_MENU_ID,[\s\S]*?selectedKeys: activeNav === '使用指南'[\s\S]*?\['guide'\][\s\S]*?selectable: true/);
assert.match(app, /onClick: \(\{ key \}\) => \{[\s\S]*?handleOpenDesktopUtility\(key\)/);
assert.match(app, /className="app-nav-footer-label">设置与帮助<\/span>/);
assert.match(app, /aria-label="打开设置与帮助菜单"[\s\S]*?aria-haspopup="menu"[\s\S]*?aria-expanded=\{utilityMenuOpen\}[\s\S]*?aria-controls=\{APP_NAV_UTILITY_MENU_ID\}/);
assert.match(app, /className=\{`app-nav-footer-disclosure \$\{utilityMenuOpen \? 'open' : ''\}`\}/);
assert.match(app, /onKeyDown=\{\(event\) => \{[\s\S]*?\['Enter', ' ', 'Spacebar'\][\s\S]*?setUtilityMenuOpen\(\(open\) => !open\)/);
assert.match(app, /event\.key !== 'Escape'[\s\S]*?setUtilityMenuOpen\(false\)[\s\S]*?utilityMenuTriggerRef\.current\?\.focus/);
assert.match(app, /document\.addEventListener\('keydown', closeMenuOnEscape, true\)/);
assert.match(app, /if \(descriptor\.navigation\) \{[\s\S]*?confirmDiscardSettingsChanges\(\)[\s\S]*?handleOpenNav\(descriptor\.navigation\)/);
assert.match(app, /onDirtyChange=\{setSettingsDirty\}/);
assert.doesNotMatch(app, /HRboss工作台|app-nav-help-button/);
assert.match(app, /className="brand-mark" role="img" title=\{`当前工作区：\$\{brandName\}`\} aria-label=\{`当前工作区：\$\{brandName\}`\}/);
assert.doesNotMatch(app, /className="nav-utility-label"|nav-item nav-utility-item/,
  'desktop sidebar must not retain the former utility heading or four persistent rows');
assert.match(app, /function handleOpenUtilityNav\(item\)[\s\S]*?handleOpenSettings\(settingsSection, returnNav\)/);
assert.match(app, /descriptor\.key === 'settings-center'[\s\S]*?'settings-overview'/);
assert.doesNotMatch(app, /lastConfigurableSettingsSection|setLastConfigurableSettingsSection/);
assert.match(app, /if \(opened\) setActiveDesktopUtilityKey\(descriptor\.key\)/);
assert.match(settings, /onSectionChange\?\.\(nextSection\);[\s\S]*?document\.getElementById\(`\$\{nextSection\}-title`\)\?\.focus/);
assert.match(app, /replaceSettingsRoute\(sectionId, normalizedReturnNav\);[\s\S]*?window\.dispatchEvent\(new Event\('hashchange'\)\)/);
assert.match(app, /const settingsHashWriteInProgressRef = useRef\(false\)/);
assert.match(app, /settingsHashWriteInProgressRef\.current = true[\s\S]*?finally \{[\s\S]*?settingsHashWriteInProgressRef\.current = false/);
assert.match(
  app,
  /const syncExternalSettingsHash = \(\) => \{[\s\S]*?readSettingsSectionFromHash\(\)[\s\S]*?settingsHashWriteInProgressRef\.current[\s\S]*?handleOpenSettings\(sectionId, activeNav\)[\s\S]*?clearSettingsRoute\(\)/,
  'a valid settings hash received while the app is running must enter Settings through the unsaved-draft guard and restore the URL if navigation is canceled',
);
assert.match(app, /window\.addEventListener\('hashchange', syncExternalSettingsHash\)/);
assert.match(app, /useState\(\(\) => \(readSettingsSectionFromHash\(\) \? '设置' : '工作台'\)\)/);
assert.match(app, /if \(activeNav === '设置' && nav !== '设置'\) \{[\s\S]*?clearSettingsRoute\(\);[\s\S]*?setAiSettingsReturnContext\(null\);[\s\S]*?\}/);
assert.match(settings, /window\.history\.replaceState\(window\.history\.state, '', `#\$\{nextSection\}`\)/);
assert.match(app, /returnNav=\{settingsReturnNav\}/);
assert.match(app, /onSectionChange=\{handleSettingsSectionChange\}/);
assert.doesNotMatch(app, /className="nav-tools"|nav-tool-item|nav-footer-setting|nav-footer-status|navUserState|navUserTone/);
assert.match(settings, /保存配置不会访问外部服务/);
assert.match(settings, /“刷新列表”只读取 已保存服务的模型目录/);
assert.match(settings, /“测试并使用”只发送合成测试文本/);
assert.match(settings, /id="settings-about-title" tabIndex=\{-1\}>招才官<\/Title>/);
assert.match(settings, /<Text>HR 的招聘桌面助手<\/Text>/);
assert.match(settings, /id="settings-about-title" tabIndex=\{-1\}/);
assert.match(settings, /不会自动发邀约、约面、淘汰或推进/);
assert.match(settings, /const \[brandMarkDraft, setBrandMarkDraft\] = useState\(committedBrandMark\)/);
assert.match(settings, /const \[brandNameDraft, setBrandNameDraft\] = useState\(committedBrandName\)/);
assert.match(settings, /function saveBrandDisplay\(\)[\s\S]*?onBrandMarkChange\?\.\(nextMark\)[\s\S]*?onBrandNameChange\?\.\(nextName\)/);
const restoreBrandDefaults = settings.slice(settings.indexOf('function restoreBrandDefaults'), settings.indexOf('function discardBrandDraft'));
assert.match(restoreBrandDefaults, /setBrandMarkDraft\(defaultBrandMark\)[\s\S]*?setBrandNameDraft\(defaultBrandName\)/);
assert.match(restoreBrandDefaults, /点击“保存显示设置”后生效/);
assert.doesNotMatch(restoreBrandDefaults, /onBrandMarkChange|onBrandNameChange/,
  '恢复默认只能载入草稿，必须由保存按钮提交');
assert.match(settings, /value=\{brandMarkDraft\}[\s\S]*?setBrandMarkDraft\(event\.target\.value\)/);
assert.match(settings, /value=\{brandNameDraft\}[\s\S]*?setBrandNameDraft\(event\.target\.value\)/);
assert.match(settings, /保存显示设置[\s\S]*?撤销未保存修改/);
assert.match(settings, /aria-describedby="settings-brand-feedback"/);
assert.match(settings, /name="settings-brand-mark"[\s\S]*?maxLength=\{4\}[\s\S]*?showCount/);
assert.match(settings, /name="settings-brand-name"[\s\S]*?maxLength=\{32\}[\s\S]*?showCount/);
assert.match(settings, /className="settings-brand-preview" role="img" aria-label="浅色侧栏工作区标识预览"[\s\S]*?className="brand-mark settings-brand-preview-mark"/,
  'Settings preview must reuse the same work-area brand primitive as the light sidebar');
assert.match(styles, /\.settings-brand-preview \{[\s\S]*?background: var\(--hb-shell\);/);
assert.doesNotMatch(styles.match(/\.settings-brand-preview \{[\s\S]*?\n\}/)?.[0] || '', /linear-gradient|#07131e|#0b2630/);
assert.match(settings, /产品名称始终为招才官，开发者为 Zhaocai Guan contributors/);
assert.match(settings, /<dt>产品<\/dt><dd>招才官<\/dd>[\s\S]*?<dt>当前工作区<\/dt><dd>\{committedBrandName\}<\/dd>[\s\S]*?<dt>开发商<\/dt><dd>Zhaocai Guan contributors<\/dd>/);
assert.doesNotMatch(settings, /更改会自动保存/);

assert.match(desktopBranding, /const APP_NAME = '招才官';/,
  'native app and BrowserWindow title must use the stable 招才官 product name');
assert.match(desktopLauncher, /const APP_NAME = '招才官';/,
  'the local macOS launcher bundle must expose the same stable 招才官 name');
assert.match(desktopBranding, /const DEVELOPER_NAME = 'Zhaocai Guan contributors';/);
assert.match(desktopBranding, /applicationName: APP_NAME[\s\S]*?copyright: `© \$\{DEVELOPER_NAME\}`/);
assert.match(candidateMain, /title: APP_NAME[\s\S]*?page-title-updated[\s\S]*?win\.setTitle\(APP_NAME\)/,
  'renderer page titles must not overwrite the native 招才官 product title');
assert.match(candidateMain, /title: '存在未保存的设置修改'[\s\S]*?关闭\s*招才官\s*将丢失设置页中未保存的草稿/,
  'native close warning must cover brand and external-AI drafts without mislabeling either one');
assert.equal(packageMetadata.productName, '招才官');
assert.equal(packageMetadata.build?.productName, '招才官');
assert.equal(packageMetadata.description, '招才官，HR 的招聘桌面助手');
assert.equal(packageMetadata.author, 'Zhaocai Guan contributors');

console.log(JSON.stringify({
  ok: true,
  contract: 'settings-ux-001-v1',
  sections: 6,
  overview_cards: 2,
  external_ai_gates_preserved: true,
}));
