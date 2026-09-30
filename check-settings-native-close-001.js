'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const mainSource = fs.readFileSync(path.join(__dirname, 'candidate-main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
const settingsSource = fs.readFileSync(
  path.join(__dirname, 'frontend', 'src', 'components', 'SettingsPanel.jsx'),
  'utf8',
);

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let bodyStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    if (source[index] === '(') paramsDepth += 1;
    else if (source[index] === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        bodyStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function loadFunctions(names, globals = {}) {
  const context = vm.createContext({ ...globals });
  const declarations = names.map((name) => extractFunction(mainSource, name)).join('\n');
  vm.runInContext(`${declarations}\nthis.testFunctions = { ${names.join(', ')} };`, context);
  return { context, testFunctions: context.testFunctions };
}

function loadFunction(name, globals = {}) {
  const loaded = loadFunctions([name], globals);
  return { context: loaded.context, testFunction: loaded.testFunctions[name] };
}

async function run() {
  const { testFunction: createCoordinator } = loadFunction('createSettingsCloseCoordinator');

  let dirty = false;
  let promptCalls = 0;
  let clearCalls = 0;
  let closeCalls = 0;
  let quitCalls = 0;
  const cleanCoordinator = createCoordinator({
    isDirty: () => dirty,
    clearDirty: () => { clearCalls += 1; dirty = false; },
    showPrompt: async () => { promptCalls += 1; return { response: 1 }; },
    closeWindow: () => { closeCalls += 1; },
    quitApplication: () => { quitCalls += 1; },
  });
  const cleanResult = await cleanCoordinator.request('window');
  assert.equal(cleanResult.prompted, false, 'clean close must not prompt');
  assert.equal(closeCalls, 1, 'clean close must close directly');
  assert.equal(promptCalls, 0);

  dirty = true;
  closeCalls = 0;
  const cancelCoordinator = createCoordinator({
    isDirty: () => dirty,
    clearDirty: () => { clearCalls += 1; dirty = false; },
    showPrompt: async () => ({ response: 0 }),
    closeWindow: () => { closeCalls += 1; },
    quitApplication: () => { quitCalls += 1; },
  });
  const cancelResult = await cancelCoordinator.request('window');
  assert.equal(cancelResult.confirmed, false, 'cancel must keep the application open');
  assert.equal(dirty, true, 'cancel must retain dirty state');
  assert.equal(closeCalls, 0);
  assert.equal(quitCalls, 0, 'cancel must not start application shutdown');

  const quitCancelCoordinator = createCoordinator({
    isDirty: () => dirty,
    clearDirty: () => { clearCalls += 1; dirty = false; },
    showPrompt: async () => ({ response: 0 }),
    closeWindow: () => { closeCalls += 1; },
    quitApplication: () => { quitCalls += 1; },
  });
  const quitCancelResult = await quitCancelCoordinator.request('application');
  assert.equal(quitCancelResult.confirmed, false);
  assert.equal(quitCalls, 0, 'canceled Cmd/Ctrl+Q must not start shutdown');

  clearCalls = 0;
  const confirmCoordinator = createCoordinator({
    isDirty: () => dirty,
    clearDirty: () => { clearCalls += 1; dirty = false; },
    showPrompt: async () => ({ response: 1 }),
    closeWindow: () => { closeCalls += 1; },
    quitApplication: () => { quitCalls += 1; },
  });
  const confirmResult = await confirmCoordinator.request('window');
  assert.equal(confirmResult.confirmed, true);
  assert.equal(dirty, false);
  assert.equal(clearCalls, 1, 'confirm must clear dirty state once');
  assert.equal(closeCalls, 1, 'red-X confirmation must really close the window');

  dirty = true;
  clearCalls = 0;
  closeCalls = 0;
  quitCalls = 0;
  promptCalls = 0;
  let resolvePrompt;
  const promptResult = new Promise((resolve) => { resolvePrompt = resolve; });
  const dedupCoordinator = createCoordinator({
    isDirty: () => dirty,
    clearDirty: () => { clearCalls += 1; dirty = false; },
    showPrompt: () => { promptCalls += 1; return promptResult; },
    closeWindow: () => { closeCalls += 1; },
    quitApplication: () => { quitCalls += 1; },
  });
  const windowRequest = dedupCoordinator.request('window');
  const appRequest = await dedupCoordinator.request('application');
  assert.equal(appRequest.deduplicated, true, 'concurrent close intents must share one prompt');
  resolvePrompt({ response: 1 });
  const promotedResult = await windowRequest;
  assert.equal(promotedResult.intent, 'application', 'app quit must supersede a pending window close');
  assert.equal(promptCalls, 1, 'only one native prompt may be shown');
  assert.equal(clearCalls, 1);
  assert.equal(closeCalls, 0);
  assert.equal(quitCalls, 1, 'confirmed application quit must run once');

  let resolveRepeatedClosePrompt;
  let repeatedClosePrompts = 0;
  let repeatedCloseCompletions = 0;
  let repeatedClosePreventions = 0;
  const repeatedClose = loadFunctions([
    'createSettingsCloseCoordinator',
    'handleCandidateWindowClose',
  ], {
    externalAiSettingsDirty: true,
    settingsCloseCoordinator: null,
  });
  const repeatedClosePrompt = new Promise((resolve) => { resolveRepeatedClosePrompt = resolve; });
  repeatedClose.context.settingsCloseCoordinator = repeatedClose.testFunctions.createSettingsCloseCoordinator({
    isDirty: () => repeatedClose.context.externalAiSettingsDirty,
    clearDirty: () => { repeatedClose.context.externalAiSettingsDirty = false; },
    showPrompt: () => { repeatedClosePrompts += 1; return repeatedClosePrompt; },
    closeWindow: () => { repeatedCloseCompletions += 1; },
    quitApplication: () => { throw new Error('unexpected application quit'); },
  });
  const repeatedCloseEvent = { preventDefault: () => { repeatedClosePreventions += 1; } };
  repeatedClose.testFunctions.handleCandidateWindowClose(repeatedCloseEvent);
  repeatedClose.testFunctions.handleCandidateWindowClose(repeatedCloseEvent);
  repeatedClose.testFunctions.handleCandidateWindowClose(repeatedCloseEvent);
  assert.equal(repeatedClosePreventions, 3);
  assert.equal(repeatedClosePrompts, 1, 'repeated red-X close must share one prompt');
  resolveRepeatedClosePrompt({ response: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(repeatedCloseCompletions, 1, 'repeated red-X close must complete once');

  let resolveConcurrentPrompt;
  let concurrentPrompts = 0;
  let concurrentWindowClose = 0;
  let concurrentApplicationQuit = 0;
  let concurrentPreventions = 0;
  const concurrentClose = loadFunctions([
    'createSettingsCloseCoordinator',
    'handleCandidateWindowClose',
    'handleApplicationBeforeQuit',
  ], {
    shutdownFinished: false,
    shutdownStarted: false,
    externalAiSettingsDirty: true,
    settingsCloseCoordinator: null,
  });
  const concurrentPrompt = new Promise((resolve) => { resolveConcurrentPrompt = resolve; });
  concurrentClose.context.settingsCloseCoordinator = concurrentClose.testFunctions.createSettingsCloseCoordinator({
    isDirty: () => concurrentClose.context.externalAiSettingsDirty,
    clearDirty: () => { concurrentClose.context.externalAiSettingsDirty = false; },
    showPrompt: () => { concurrentPrompts += 1; return concurrentPrompt; },
    closeWindow: () => { concurrentWindowClose += 1; },
    quitApplication: () => { concurrentApplicationQuit += 1; },
  });
  const concurrentEvent = { preventDefault: () => { concurrentPreventions += 1; } };
  concurrentClose.testFunctions.handleCandidateWindowClose(concurrentEvent);
  concurrentClose.testFunctions.handleApplicationBeforeQuit(concurrentEvent);
  assert.equal(concurrentPreventions, 2);
  assert.equal(concurrentPrompts, 1, 'window close and before-quit must share one prompt');
  resolveConcurrentPrompt({ response: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(concurrentWindowClose, 0, 'application intent must supersede window close');
  assert.equal(concurrentApplicationQuit, 1);

  dirty = true;
  closeCalls = 0;
  quitCalls = 0;
  let promptErrors = 0;
  const failedPromptCoordinator = createCoordinator({
    isDirty: () => dirty,
    clearDirty: () => { dirty = false; },
    showPrompt: async () => { throw new Error('dialog unavailable'); },
    closeWindow: () => { closeCalls += 1; },
    quitApplication: () => { quitCalls += 1; },
    reportError: () => { promptErrors += 1; },
  });
  const failedPromptResult = await failedPromptCoordinator.request('application');
  assert.equal(failedPromptResult.confirmed, false);
  assert.equal(dirty, true, 'dialog failure must fail closed');
  assert.equal(closeCalls + quitCalls, 0);
  assert.equal(promptErrors, 1);

  dirty = true;
  let synchronousPromptErrors = 0;
  const throwingPromptCoordinator = createCoordinator({
    isDirty: () => dirty,
    clearDirty: () => { dirty = false; },
    showPrompt: () => { throw new Error('dialog threw synchronously'); },
    closeWindow: () => { closeCalls += 1; },
    quitApplication: () => { quitCalls += 1; },
    reportError: () => { synchronousPromptErrors += 1; },
  });
  const throwingPromptResult = await throwingPromptCoordinator.request('window');
  assert.equal(throwingPromptResult.confirmed, false);
  assert.equal(dirty, true, 'synchronous dialog throw must fail closed');
  assert.equal(synchronousPromptErrors, 1);
  assert.equal(closeCalls + quitCalls, 0, 'synchronous dialog throw must not close or quit');

  dirty = true;
  clearCalls = 0;
  let completionErrors = 0;
  const failedWindowCompletion = createCoordinator({
    isDirty: () => dirty,
    clearDirty: () => { clearCalls += 1; dirty = false; },
    showPrompt: async () => ({ response: 1 }),
    closeWindow: () => { throw new Error('window destroy failed'); },
    quitApplication: () => { throw new Error('unexpected application quit'); },
    reportError: () => { completionErrors += 1; },
  });
  const failedWindowCompletionResult = await failedWindowCompletion.request('window');
  assert.equal(failedWindowCompletionResult.confirmed, false);
  assert.equal(dirty, true, 'failed window completion must retain dirty state');
  assert.equal(clearCalls, 0, 'failed window completion must not clear dirty state');
  assert.equal(completionErrors, 1);

  const failedApplicationCompletion = createCoordinator({
    isDirty: () => dirty,
    clearDirty: () => { clearCalls += 1; dirty = false; },
    showPrompt: async () => ({ response: 1 }),
    closeWindow: () => { throw new Error('unexpected window close'); },
    quitApplication: () => { throw new Error('shutdown start failed'); },
    reportError: () => { completionErrors += 1; },
  });
  const failedApplicationCompletionResult = await failedApplicationCompletion.request('application');
  assert.equal(failedApplicationCompletionResult.confirmed, false);
  assert.equal(dirty, true, 'failed application completion must retain dirty state');
  assert.equal(clearCalls, 0, 'failed application completion must not clear dirty state');
  assert.equal(completionErrors, 2);

  const windowRequests = [];
  let prevented = 0;
  const windowHandler = loadFunction('handleCandidateWindowClose', {
    externalAiSettingsDirty: false,
    settingsCloseCoordinator: { request: (intent) => windowRequests.push(intent) },
  });
  windowHandler.testFunction({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 0, 'clean native window close must not be intercepted');
  windowHandler.context.externalAiSettingsDirty = true;
  windowHandler.testFunction({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1, 'dirty native window close must be intercepted');
  assert.deepEqual(windowRequests, ['window']);

  const quitRequests = [];
  let shutdownCalls = 0;
  prevented = 0;
  const quitHandler = loadFunction('handleApplicationBeforeQuit', {
    shutdownFinished: false,
    shutdownStarted: false,
    externalAiSettingsDirty: true,
    settingsCloseCoordinator: { request: (intent) => quitRequests.push(intent) },
    beginGracefulShutdown: () => { shutdownCalls += 1; },
  });
  quitHandler.testFunction({ preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 1);
  assert.deepEqual(quitRequests, ['application']);
  assert.equal(shutdownCalls, 0, 'dirty before-quit must wait for confirmation');
  quitHandler.context.externalAiSettingsDirty = false;
  quitHandler.testFunction({ preventDefault: () => { prevented += 1; } });
  assert.equal(shutdownCalls, 1, 'clean before-quit must begin graceful shutdown');

  let immediateClosePreventions = 0;
  const immediateDirtyClose = loadFunctions([
    'handleExternalAiSettingsDirty',
    'handleCandidateWindowClose',
  ], {
    assertTrustedRenderer: () => {},
    externalAiSettingsDirty: false,
    settingsCloseCoordinator: { request: (intent) => assert.equal(intent, 'window') },
  });
  const syncIpcEvent = {};
  assert.equal(immediateDirtyClose.testFunctions.handleExternalAiSettingsDirty(syncIpcEvent, true), true);
  assert.equal(syncIpcEvent.returnValue, true, 'synchronous IPC must acknowledge after main state is updated');
  assert.equal(immediateDirtyClose.context.externalAiSettingsDirty, true);
  immediateDirtyClose.testFunctions.handleCandidateWindowClose({
    preventDefault: () => { immediateClosePreventions += 1; },
  });
  assert.equal(immediateClosePreventions, 1, 'the first native close after a dirty input must be guarded');
  immediateDirtyClose.context.assertTrustedRenderer = () => { throw new Error('untrusted'); };
  const rejectedSyncIpcEvent = {};
  assert.equal(immediateDirtyClose.testFunctions.handleExternalAiSettingsDirty(rejectedSyncIpcEvent, false), false);
  assert.equal(rejectedSyncIpcEvent.returnValue, false);
  assert.equal(immediateDirtyClose.context.externalAiSettingsDirty, true, 'untrusted synchronous IPC must not clear dirty state');

  const navigation = loadFunction('handleRendererNavigationStart', {
    externalAiSettingsDirty: true,
  });
  assert.equal(navigation.testFunction({ isMainFrame: true, isSameDocument: false }), true);
  assert.equal(navigation.context.externalAiSettingsDirty, false, 'main-frame full navigation must clear stale dirty state');
  navigation.context.externalAiSettingsDirty = true;
  assert.equal(navigation.testFunction({ isMainFrame: true, isSameDocument: true }), false);
  assert.equal(navigation.context.externalAiSettingsDirty, true, 'hash and History API navigation must retain dirty state');
  assert.equal(navigation.testFunction({ isMainFrame: false, isSameDocument: false }), false);
  assert.equal(navigation.context.externalAiSettingsDirty, true, 'subframe navigation must retain dirty state');
  assert.equal(navigation.testFunction({ isMainFrame: true }), false);
  assert.equal(navigation.context.externalAiSettingsDirty, true, 'missing navigation metadata must fail closed');

  const rendererGone = loadFunction('handleRendererProcessGone', {
    externalAiSettingsDirty: true,
  });
  rendererGone.testFunction();
  assert.equal(rendererGone.context.externalAiSettingsDirty, false, 'renderer exit must clear stale dirty state');

  const liveWindow = {};
  const windowCleanup = loadFunction('clearCandidateWindowReferences', {
    win: liveWindow,
    externalAiSettingsDirty: true,
    settingsCloseCoordinator: {},
  });
  assert.equal(windowCleanup.testFunction({}), false, 'an obsolete window must not clear current references');
  assert.equal(windowCleanup.context.externalAiSettingsDirty, true);
  assert.equal(windowCleanup.testFunction(liveWindow), true);
  assert.equal(windowCleanup.context.win, null);
  assert.equal(windowCleanup.context.settingsCloseCoordinator, null);
  assert.equal(windowCleanup.context.externalAiSettingsDirty, false);

  let stopCalls = 0;
  let exitCalls = 0;
  let resolveSlowStop;
  const slowStop = new Promise((resolve) => { resolveSlowStop = resolve; });
  const shutdown = loadFunction('beginGracefulShutdown', {
    shutdownStarted: false,
    shutdownFinished: false,
    stopServers: () => { stopCalls += 1; return slowStop; },
    app: { exit: (code) => { assert.equal(code, 0); exitCalls += 1; } },
  });
  assert.equal(shutdown.testFunction(), true);
  assert.equal(shutdown.testFunction(), false, 'graceful shutdown must be single-flight');
  assert.equal(stopCalls, 1);
  assert.equal(exitCalls, 0, 'slow stopServers must finish before app.exit');
  resolveSlowStop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(exitCalls, 1);

  let blockedExitCalls = 0;
  let blockedDialogCalls = 0;
  const blockedShutdown = loadFunction('beginGracefulShutdown', {
    shutdownStarted: false,
    shutdownFinished: false,
    stopServers: async () => ({
      ok: false,
      action: { exited: false, timed_out: true },
    }),
    app: { exit: () => { blockedExitCalls += 1; } },
    dialog: { showErrorBox: () => { blockedDialogCalls += 1; } },
  });
  assert.equal(blockedShutdown.testFunction(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(blockedExitCalls, 0,
    'an unconfirmed action-server guardian must block desktop process exit');
  assert.equal(blockedDialogCalls, 1);
  assert.equal(blockedShutdown.context.shutdownStarted, false,
    'operator must be able to retry graceful shutdown after the guardian becomes safe');

  let failedCleanupExitCode = null;
  const failedCleanupShutdown = loadFunction('beginGracefulShutdown', {
    shutdownStarted: false,
    shutdownFinished: false,
    stopServers: async () => ({
      ok: false,
      action: { exited: true, code: 2, timed_out: false },
    }),
    app: { exit: (code) => { failedCleanupExitCode = code; } },
    dialog: { showErrorBox: () => {} },
  });
  assert.equal(failedCleanupShutdown.testFunction(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failedCleanupExitCode, 1,
    'confirmed termination with failed cleanup must make the desktop exit non-zero');

  assert.match(preloadSource, /setExternalAiDirty:\s*\(dirty\)\s*=>\s*ipcRenderer\.sendSync\('settings-state:external-ai-dirty',\s*dirty === true\) === true/);
  const settingsBridge = preloadSource.match(/contextBridge\.exposeInMainWorld\('settingsState',[\s\S]*?\n\}\);/);
  assert.ok(settingsBridge, 'settingsState preload bridge must exist');
  assert.doesNotMatch(settingsBridge[0], /apiKey|baseUrl|provider|model|config/i, 'close bridge must expose no configuration or credential fields');
  assert.match(settingsSource, /window\.settingsState\?\.setExternalAiDirty/);
  assert.match(settingsSource, /useLayoutEffect\(\(\) => \{[\s\S]*?setExternalAiDirty/, 'dirty synchronization must finish in React layout phase');
  assert.match(settingsSource, /window\.addEventListener\('beforeunload', guardWindowClose\)/, 'browser fallback must remain');
  assert.match(mainSource, /ipcMain\.on\('settings-state:external-ai-dirty', handleExternalAiSettingsDirty\)/);
  assert.match(mainSource, /function handleExternalAiSettingsDirty[\s\S]*?assertTrustedRenderer\(event\)[\s\S]*?event\.returnValue = false;[\s\S]*?externalAiSettingsDirty = dirty === true;[\s\S]*?event\.returnValue = true;/);
  assert.match(mainSource, /win\.on\('close', handleCandidateWindowClose\)/);
  assert.match(mainSource, /win\.webContents\.on\('did-start-navigation', handleRendererNavigationStart\)/);
  assert.match(mainSource, /win\.webContents\.on\('render-process-gone', handleRendererProcessGone\)/);
  assert.match(mainSource, /win\.on\('closed', \(\) => clearCandidateWindowReferences\(candidateWindow\)\)/);
  assert.match(mainSource, /closeWindow:\s*\(\) => \{[\s\S]*?win\.destroy\(\)/, 'confirmed red-X close must bypass renderer beforeunload');
  assert.match(mainSource, /app\.on\('before-quit', handleApplicationBeforeQuit\)/);

  console.log('check-settings-native-close-001 ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
