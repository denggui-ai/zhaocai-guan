
const { PROJECT_ROOT } = require("../src/paths");
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const settingsSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/SettingsPanel.jsx'), 'utf8');

function checkStoredWorkspaceBrandMigration() {
  const appSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/App.jsx'), 'utf8');
  const constants = ['BRAND_NAME_STORAGE_KEY', 'BRAND_MARK_STORAGE_KEY', 'DEFAULT_BRAND_NAME', 'DEFAULT_BRAND_MARK']
    .map((name) => appSource.match(new RegExp(`const ${name} = '[^']*';`))?.[0]).join('\n');
  const readers = appSource.slice(appSource.indexOf('function normalizeBrandName('), appSource.indexOf('function readStoredBoolean('));
  const nameKey = 'hrboss.ui.brandName.v1';
  const markKey = 'hrboss.ui.brandMark.v1';
  assert.match(constants, /BRAND_NAME_STORAGE_KEY = 'hrboss\.ui\.brandName\.v1'/);
  assert.match(constants, /BRAND_MARK_STORAGE_KEY = 'hrboss\.ui\.brandMark\.v1'/);
  const legacyNames = ['', 'TalentBench 识才台', 'TalentBench', '识才台', '招聘工作台', 'Boss 招聘'];
  const cases = [
    ...legacyNames.map((name) => [name, 'TB', '招才官', '招']),
    [' TalentBench 识才台 ', ' TB ', '招才官', '招'],
    ['', '', '招才官', '招'],
    ['TalentBench', 'HR', '招才官', 'HR'],
    ['招才官', '招', '招才官', '招'],
    ['我的招聘团队', 'TB', '我的招聘团队', 'TB'],
    ['TalentBench 团队', 'ABC', 'TalentBench 团队', 'ABC'],
    ['识才台客户组', '客', '识才台客户组', '客'],
    ['  自定义工作区  ', 'abc', '自定义工作区', 'ABC'],
    ['合'.repeat(40), 'TEAMX', '合'.repeat(32), 'TEAM'],
  ];
  for (const readOnly of [false, true]) {
    for (const [name, mark, expectedName, expectedMark] of cases) {
      const stored = new Map([[nameKey, name], [markKey, mark]]);
      const before = [...stored];
      let writes = 0;
      const context = vm.createContext({
        READONLY_UI: readOnly,
        window: { localStorage: { getItem: (key) => stored.get(key), setItem: () => { writes += 1; } } },
      });
      const result = vm.runInContext(`${constants}\n${readers}\n[readBrandName(), readBrandMark()]`, context);
      assert.equal(result[0], expectedName, `stored workspace name must migrate only an exact old default: ${name}`);
      assert.equal(result[1], expectedMark, `stored workspace mark must preserve custom workspaces: ${name}`);
      assert.equal(writes, 0, 'reading a default must not write storage, including operational readonly mode');
      assert.deepEqual([...stored], before);
    }
  }
  for (const globals of [{}, { window: { localStorage: { getItem() { throw new Error('synthetic unavailable storage'); } } } }]) {
    const result = vm.runInNewContext(`${constants}\n${readers}\n[readBrandName(), readBrandMark()]`, globals);
    assert.equal(result[0], '招才官');
    assert.equal(result[1], '招');
  }
}

async function checkLocalPathLoading() {
  const effect = settingsSource.match(/  useEffect\(\(\) => \{\n    let active = true;\n    setLocalPaths\(null\);[\s\S]*?\n  \}, \[localPathsLoadAttempt\]\);/)?.[0];
  assert.ok(effect, 'settings must load actual paths and clear stale values before each attempt');
  const paths = { dataDir: '/synthetic/data', databasePath: '/synthetic/data/db', interviewDir: '/synthetic/interviews', screenshotDir: '/synthetic/data/import' };
  for (const scenario of ['success', 'failure', 'unmounted']) {
    const observed = { paths: { dataDir: '/stale' }, error: 'stale error' };
    let resolve;
    let reject;
    let cleanup;
    const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
    vm.runInNewContext(effect, {
      localPathsLoadAttempt: 0,
      useEffect: (fn) => { cleanup = fn(); },
      api: { getLocalPaths: () => pending },
      setLocalPaths: (value) => { observed.paths = value; },
      setLocalPathsError: (value) => { observed.error = value; },
    });
    assert.equal(observed.paths, null);
    assert.equal(observed.error, '');
    if (scenario === 'unmounted') cleanup();
    if (scenario === 'failure') reject(new Error('synthetic directory read failure'));
    else resolve(paths);
    await new Promise((done) => setImmediate(done));
    if (scenario === 'success') assert.equal(observed.paths, paths);
    else assert.equal(observed.paths, null, 'failed or unmounted reads must never restore a placeholder or stale path');
    assert.equal(observed.error, scenario === 'failure' ? 'synthetic directory read failure' : '');
  }
}

async function runLlmHandler(name, state, { persisted, draft = persisted, apiKey = '', response, error } = {}) {
  const source = settingsSource.match(new RegExp(`  async function ${name}\\(\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
  assert.ok(source, `the real settings ${name} handler must remain discoverable`);
  const observed = { requests: [], config: draft };
  const request = async (...args) => {
    observed.requests.push(args);
    if (error) throw error;
    return response;
  };
  const context = vm.createContext({
    llmBusyRef: { current: false }, llmLoadError: '', llmApiKey: apiKey, llmConfig: draft,
    llmPersistedConfigRef: { current: persisted },
    hasLlmConnectionChanges: state.hasLlmConnectionChanges,
    hasUnsavedLlmChanges: state.hasUnsavedLlmChanges,
    mergeRefreshedLlmConfig: state.mergeRefreshedLlmConfig,
    credentialPersistenceFeedback: state.credentialPersistenceFeedback,
    normalizeModelOptions: (models = []) => models.map((model) => ({ value: model.id, verified: model.verified })),
    api: { testLlmModel: request, refreshLlmModels: request },
    setLlmConfig: (value) => { observed.config = value; },
    setLlmNotice: (value) => { observed.notice = value; },
    setLlmOperationError: (value) => { observed.error = value; },
    setLlmBusy: () => {}, setLlmModels: () => {}, setLlmLoadError: () => {}, setLlmManualModelMode: () => {},
  });
  await vm.runInContext(`(${source})`, context)();
  return { ...observed, persisted: context.llmPersistedConfigRef.current };
}

async function checkLlmHandlerDrafts(state) {
  const saved = {
    provider: 'synthetic', baseUrl: 'https://ai.example.test/v1', apiKeyConfigured: true,
    model: 'vendor/saved-model', modelVerified: true, enabled: false, timeoutMs: 120000,
    availableModels: [{ id: 'vendor/saved-model', verified: true }],
  };
  const testedConfig = {
    ...saved, model: 'vendor/tested-model',
    availableModels: [...saved.availableModels, { id: 'vendor/tested-model', verified: true }],
  };
  const response = { config: testedConfig, model: { source: 'manual' }, credentialPersistence: 'system_encrypted' };
  const draft = { ...saved, model: testedConfig.model, modelVerified: false, enabled: true, timeoutMs: 180000 };
  const tested = await runLlmHandler('testLlmModel', state, { persisted: saved, draft, response });
  assert.deepEqual(tested.requests, [[testedConfig.model]]);
  assert.equal(tested.config.timeoutMs, 180000, 'model testing must preserve an unsaved timeout draft');
  assert.equal(tested.config.enabled, true, 'model testing must preserve an unsaved enable draft');
  assert.equal(tested.config.modelVerified, true);
  assert.deepEqual(tested.persisted, testedConfig, 'the persisted baseline must contain only the server state');
  assert.equal(state.hasUnsavedLlmChanges(tested.config, tested.persisted), true);
  assert.equal(tested.notice.type, 'success');

  for (const persistence of [
    { credentialPersistence: 'session_only' },
    { credentialPersistenceWarning: 'synthetic secure storage failure' },
  ]) {
    const sessionOnly = await runLlmHandler('testLlmModel', state, {
      persisted: saved, draft, response: { ...response, ...persistence },
    });
    assert.equal(sessionOnly.notice.type, 'warning', 'successful model testing must disclose failed persistence');
    assert.match(`${sessionOnly.notice.message} ${sessionOnly.notice.description}`, /模型测试通过/);
    assert.match(`${sessionOnly.notice.message} ${sessionOnly.notice.description}`, /会话|重启/);
    assert.match(sessionOnly.notice.description, /测试仅发送合成文本，不含候选人材料/);
  }

  const failed = await runLlmHandler('testLlmModel', state, { persisted: saved, draft, error: new Error('synthetic test failure') });
  assert.equal(failed.config, draft, 'failed model testing must leave the draft unchanged');
  assert.equal(failed.persisted, saved, 'failed model testing must not advance the baseline');
  assert.match(failed.error.message, /synthetic test failure/);

  for (const name of ['testLlmModel', 'refreshLlmModels']) {
    for (const changes of [{ provider: 'another' }, { baseUrl: 'https://other.example.test/v1' }]) {
      const blocked = await runLlmHandler(name, state, { persisted: saved, draft: { ...saved, ...changes }, response });
      assert.equal(blocked.requests.length, 0, `${name} must not send with an unsaved connection`);
      assert.equal(blocked.persisted, saved);
    }
    const keyDraft = await runLlmHandler(name, state, { persisted: saved, apiKey: 'synthetic-new-key', response });
    assert.equal(keyDraft.requests.length, 0, `${name} must not send with an unsaved key`);
  }
  for (const changes of [{ timeoutMs: 180000 }, { enabled: true }, { model: 'vendor/unsaved-model' }]) {
    const refreshDraft = { ...saved, ...changes };
    const blocked = await runLlmHandler('refreshLlmModels', state, { persisted: saved, draft: refreshDraft, response });
    assert.equal(blocked.requests.length, 0, 'refresh must enforce the same unsaved-draft gate as its button');
    assert.equal(blocked.config, refreshDraft);
    assert.equal(blocked.persisted, saved);
  }
  const refreshed = await runLlmHandler('refreshLlmModels', state, {
    persisted: saved,
    response: { config: saved, models: saved.availableModels, credentialPersistence: 'session_only' },
  });
  assert.equal(refreshed.requests.length, 1);
  assert.deepEqual(refreshed.persisted, saved);
  assert.equal(state.hasUnsavedLlmChanges(refreshed.config, refreshed.persisted), false);
  assert.equal(refreshed.notice.type, 'warning');
}

async function main() {
  checkStoredWorkspaceBrandMigration();
  await checkLocalPathLoading();
  const state = await import(pathToFileURL(path.join(PROJECT_ROOT, 'frontend/src/settings-state.mjs')).href);
  await checkLlmHandlerDrafts(state);
  const persisted = {
    provider: 'synthetic',
    baseUrl: 'https://ai.example.test/v1',
    enabled: false,
    model: 'claude-sonnet-4-20260730',
    modelVerified: true,
    timeoutMs: 120000,
  };
  const verifiedModels = [{ value: persisted.model, verified: true }];

  const changed = { ...persisted, provider: 'another', modelVerified: false };
  assert.equal(state.hasUnsavedLlmChanges(changed, persisted, ''), true);
  assert.equal(state.shouldGuardSettingsExit(true, 'inside-settings'), false);
  assert.equal(state.shouldGuardSettingsExit(true, 'outside-settings'), true);
  assert.equal(state.isLlmConfigurationLocked(false, 'synthetic load failure'), true);
  assert.equal(state.isLlmConfigurationLocked(false, ''), false);
  assert.equal(state.isLlmConfigurationLocked(true, ''), true);
  assert.equal(
    state.settingsBusinessReturn({ jobsLoadState: 'empty', jobs: [] }).label,
    '返回工作台新建岗位',
    'the native empty authority state must expose the unique create-job return',
  );
  assert.equal(
    state.settingsBusinessReturn({ jobsLoadState: 'ready', jobs: [] }).label,
    '返回工作台新建岗位',
    'a successful empty job list must expose the same create-job return',
  );
  assert.equal(
    state.settingsBusinessReturn({ jobsLoadState: 'loading', jobs: [] }).label,
    '返回工作台继续招聘',
    'an unknown job list must not be presented as a verified empty dataset',
  );
  assert.equal(
    state.settingsBusinessReturn({
      jobsLoadState: 'ready',
      jobs: [{ id: 7 }],
      job: { id: 7 },
      workbenchState: 'ready',
      workbench: {
        todos: [
          { code: 'job_jd_required' },
          { code: 'job_profile_confirmation_required' },
        ],
      },
    }).label,
    '返回工作台处理 2 项岗位准备',
  );

  const startupFaultRecovery = state.llmConfigLoadRecovery('EXTERNAL_AI_CONFIG_UNREADABLE');
  assert.equal(startupFaultRecovery.retryable, false);
  assert.equal(startupFaultRecovery.action, undefined);
  assert.match(startupFaultRecovery.title, /重启招才官/);
  assert.match(startupFaultRecovery.description, /重复读取无法恢复/);
  const transientRecovery = state.llmConfigLoadRecovery('TEMPORARY_UNAVAILABLE');
  assert.equal(transientRecovery.retryable, true);
  assert.equal(transientRecovery.action, '重新读取 AI 配置');

  assert.equal(state.DEFAULT_LLM_PROVIDER, 'openai-compatible');
  assert.equal(state.DEFAULT_LLM_BASE_URL, '');
  assert.deepEqual(state.validateLlmConnectionDraft(persisted, verifiedModels), {});
  assert.match(state.validateLlmConnectionDraft({ ...persisted, provider: '' }, verifiedModels).provider, /服务商标识/);
  assert.deepEqual(state.validateLlmConnectionDraft({ ...persisted, provider: 'another' }, verifiedModels), {});
  for (const baseUrl of ['', 'http://ai.example.test', 'https://user:pass@ai.example.test', 'https://ai.example.test?x=1', 'https://ai.example.test/#x']) {
    assert.match(state.validateLlmConnectionDraft({ ...persisted, baseUrl }, verifiedModels).baseUrl, /HTTPS/);
  }
  assert.equal(state.hasLlmConnectionChanges({ ...persisted, baseUrl: 'https://ai.example.test/' }, persisted), false);
  assert.equal(state.hasLlmConnectionChanges({ ...persisted, baseUrl: 'https://other.example.test/v1' }, persisted), true);
  assert.equal(state.reconcileDraftModelVerification({ ...persisted, baseUrl: 'https://other.example.test/v1' }, persisted, verifiedModels).modelVerified, false);
  assert.equal(state.validateLlmConnectionDraft({ ...persisted, model: '' }, verifiedModels).model, undefined, 'model may be empty before credential verification');
  assert.match(state.validateLlmConnectionDraft({ ...persisted, model: 'm'.repeat(161) }, verifiedModels).model, /160/);
  assert.match(
    state.validateLlmConnectionDraft({ ...persisted, model: 'codex-mini-latest' }, verifiedModels).model,
    /测试并使用/,
    'an untested manual model identifier must fail closed',
  );

  const reverted = state.reconcileDraftModelVerification(
    { ...changed, provider: persisted.provider },
    persisted,
    [{ value: persisted.model, verified: true }],
  );
  assert.equal(reverted.modelVerified, true);
  assert.equal(state.hasUnsavedLlmChanges(reverted, persisted, ''), false);
  assert.equal(state.hasUnsavedLlmChanges(persisted, persisted, 'synthetic-key-not-logged'), true);

  const unavailableModel = state.mergeRefreshedLlmConfig(
    persisted,
    { ...persisted, modelVerified: false },
    [{ value: 'gpt-5.6', verified: false }],
  );
  assert.equal(unavailableModel.model, persisted.model);
  assert.equal(unavailableModel.modelVerified, false);

  const sessionOnly = state.credentialPersistenceFeedback({
    credentialPersistence: 'session_only',
    credentialPersistenceWarning: 'synthetic secure store failure',
  }, true);
  assert.equal(sessionOnly.type, 'warning');
  assert.match(sessionOnly.message, /只在本次会话生效/);
  assert.match(sessionOnly.description, /本次新密钥仅当前会话使用/);
  assert.match(sessionOnly.description, /可能恢复保存前的配置或原访问密钥/);
  assert.match(sessionOnly.description, /重新确认当前状态，必要时重新保存/);
  assert.doesNotMatch(sessionOnly.description, /重启招才官后需要重新填写/);

  const sessionOnlyConfig = state.credentialPersistenceFeedback({ credentialPersistence: 'session_only' }, false);
  assert.equal(sessionOnlyConfig.type, 'warning');
  assert.match(sessionOnlyConfig.message, /当前会话生效/);
  assert.match(sessionOnlyConfig.description, /本次修改可能恢复为原来的配置/);

  const encrypted = state.credentialPersistenceFeedback({ credentialPersistence: 'system_encrypted' }, true);
  assert.equal(encrypted.type, 'success');
  assert.match(encrypted.description, /系统安全存储/);

  const doctor = {
    status: 'ready',
    ready: true,
    toolchainReady: true,
    capabilities: { micCheck: { ready: true } },
    readiness: { appDiscovery: { ready: true }, microphone: { ready: false, tested: false, status: 'untested' } },
    tools: {},
  };
  const micUntested = state.interviewDeviceSummary({ doctor, availableCapabilityCount: 4 });
  assert.equal(micUntested.ready, false);
  assert.match(micUntested.value, /麦克风未测试/);
  const micPassed = state.interviewDeviceSummary({
    doctor,
    availableCapabilityCount: 4,
    micCheck: { level: 'pass', passed: true },
  });
  assert.equal(micPassed.ready, true);
  assert.equal(micPassed.value, '面试设备可用');
  const toolchainMissing = state.interviewDeviceSummary({
    doctor: {
      ...doctor,
      ready: false,
      toolchainReady: false,
      capabilities: { micCheck: { ready: false } },
      readiness: { appDiscovery: { ready: false }, microphone: { ready: false, tested: false, status: 'untested' } },
    },
    availableCapabilityCount: 4,
    micCheck: { level: 'pass', passed: true },
  });
  assert.equal(toolchainMissing.ready, false);
  assert.match(toolchainMissing.value, /工具未就绪/);
  const conflictingMicResult = state.interviewDeviceSummary({
    doctor,
    availableCapabilityCount: 4,
    micCheck: { level: 'warn', passed: true },
  });
  assert.equal(conflictingMicResult.ready, false);
  assert.match(conflictingMicResult.value, /重新测试/);
  const falseCapabilityMustWin = state.interviewDeviceSummary({
    doctor: {
      ...doctor,
      capabilities: { micCheck: { ready: false } },
      readiness: { appDiscovery: { ready: true } },
    },
    micCheck: { level: 'pass', passed: true },
  });
  assert.equal(falseCapabilityMustWin.ready, false);
  assert.match(falseCapabilityMustWin.value, /工具未就绪/);
  const falseDiscoveryMustWin = state.interviewDeviceSummary({
    doctor: {
      ...doctor,
      capabilities: { micCheck: { ready: true } },
      readiness: { appDiscovery: { ready: false } },
    },
    micCheck: { level: 'pass', passed: true },
  });
  assert.equal(falseDiscoveryMustWin.ready, false);
  assert.match(falseDiscoveryMustWin.value, /工具未就绪/);

  const recordingUnavailableTranscriptionAvailable = {
    ...doctor,
    status: 'degraded',
    ready: false,
    toolchainReady: false,
    capabilities: {
      recording: { ready: false },
      transcription: { ready: true },
      micCheck: { ready: false },
    },
    readiness: {
      appDiscovery: { ready: false },
      microphone: { ready: false, tested: false, status: 'untested' },
    },
  };
  assert.equal(state.localInterviewMicCheckReady(recordingUnavailableTranscriptionAvailable), false);
  assert.equal(
    state.localInterviewTranscriptionReady(recordingUnavailableTranscriptionAvailable),
    true,
    'preserved WAV retry must remain available when transcription is ready but recording is unavailable',
  );

  const transcriptionUnavailable = {
    ...doctor,
    capabilities: {
      recording: { ready: true },
      transcription: { ready: false },
      micCheck: { ready: true },
    },
  };
  assert.equal(
    state.localInterviewTranscriptionReady(transcriptionUnavailable),
    false,
    'explicit transcription capability failure must disable retry even if legacy aggregate readiness is true',
  );

  const interviewPanelSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'frontend/src/components/InterviewReviewPanel.jsx'),
    'utf8',
  );
  assert.match(
    interviewPanelSource,
    /const transcriptionReady = localInterviewTranscriptionReady\(doctor\);/,
    'retry UI must derive a transcription-specific readiness flag',
  );
  const retryButtonSource = interviewPanelSource.match(
    /<Button\s+type="primary"\s+size="small"\s+loading=\{busyAction === 'retry'\}[\s\S]*?>[\s\S]*?重试转写[\s\S]*?<\/Button>/,
  )?.[0] || '';
  assert.ok(retryButtonSource, 'retry transcription button contract must remain discoverable');
  assert.match(
    retryButtonSource,
    /disabled=\{READONLY_UI \|\| readOnly \|\| !!busyAction \|\| abortBusy \|\| !transcriptionReady \|\| !!doctorError\}/,
    'retry must require transcription readiness while failing closed when doctor status is unknown',
  );
  assert.doesNotMatch(
    retryButtonSource,
    /!ready|environmentNeedsAttention/,
    'retry must not inherit recording, microphone-check, or aggregate degraded gates',
  );

  console.log(JSON.stringify({
    ok: true,
    contract: 'settings-state-001',
    dirty_revert: true,
    settings_internal_switch_preserves_draft: true,
    settings_exit_is_guarded: true,
    load_error_is_fail_closed: true,
    startup_fault_requires_restart: true,
    transient_load_error_is_retryable: true,
    https_connection_configurable: true,
    empty_model_is_persistable: true,
    session_only_is_warning: true,
    session_only_old_config_recovery_disclosed: true,
    model_test_preserves_unsaved_timeout_and_enabled: true,
    model_test_persistence_warning_visible: true,
    model_handlers_reject_unsaved_connection: true,
    model_refresh_rejects_unsaved_draft: true,
    unavailable_model_is_preserved: true,
    manual_model_entry_rejected: true,
    mic_must_be_tested: true,
    transcription_retry_uses_transcription_capability_only: true,
    empty_job_business_return_behavior: true,
    legacy_default_brand_migrated_without_overwriting_custom_workspace: true,
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
