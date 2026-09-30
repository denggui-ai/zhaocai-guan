
const { PROJECT_ROOT } = require("./paths");
const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require('electron');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { pathToFileURL } = require('url');
const { APP_NAME, applyAppBranding, applyDockBranding, createAppIcon } = require('./desktop-branding');
const { hardenPrivateDir } = require('./secure-fs');
const { approvalBinding, issueF009UserApproval } = require('./f009-user-approval');
const {
  approvalBinding: externalAiApprovalBinding,
  issueExternalAiUserApproval,
} = require('./external-ai-user-approval');
const { LOCAL_PRINCIPAL } = require('./local-principal');
const { issueAssessmentFileSelection } = require('./assessment-file-selection');
const { getInterviewMaterialRoot, validateInterviewMaterialFile } = require('./interview-material-paths');
const { resolveSelectedDirectory } = require('./local-directory-selection');
const {
  PendingScreenshotApprovalVault,
  screenshotApprovalBinding,
  screenshotApprovalDialog,
} = require('./screenshot-ai-native-approval');
const { issueResumeFileSelection } = require('./resume-file-selection');
const { NEW_CANDIDATE_BINDING } = require('./resume-candidate-intake');
const { importAssessmentFileBatch } = require('./assessment-batch-import');
const { requestGuardianEmergencyStop } = require('./local-interview-guardian-protocol');
const {
  loadLegacyRatingState,
  loadSecureLlmState,
  saveSecureLlmState,
  resolveLlmStartupBinding,
} = require('./secure-llm-config-store');
const {
  DEFAULT_PROVIDER,
  canonicalBaseUrl,
  normalizeProviderId,
  sameExternalAiConnection,
  publicConfigFields,
  normalizeVerifiedModels,
} = require('./external-ai-policy');

let win;
let server;
let actionServer;
let localApiSession;
let runtimeLocalPaths = null;
let rendererEntryUrl;
let f009ApprovalSecret = '';
let assessmentSelectionSecret = '';
let resumeSelectionSecret = '';
let shutdownStarted = false;
let shutdownFinished = false;
let llmStorePath = '';
let persistedLlmApiKey = '';
let persistedLlmModels = [];
let persistedLlmConfig = null;
let llmOperationQueue = Promise.resolve();
let externalAiSettingsDirty = false;
let settingsCloseCoordinator = null;
let interviewMaterialRoot = '';
let localInterviewGuardianRegistryPath = '';
const pendingScreenshotApprovals = new PendingScreenshotApprovalVault();
const READONLY_UI = process.env.BOSS_READONLY_UI === '1';
// Assessment reports are a normal HR workflow capability. Keep an explicit
// emergency rollback (`0`) without requiring a hidden pilot launcher.
const ASSESSMENT_ENABLED = process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED !== '0';
const DEFAULT_ASSESSMENT_RETENTION_POLICY_VERSION = 'hrboss-internal-assessment-v1';
const DEFAULT_ASSESSMENT_RETENTION_DAYS = '365';

require('./desktop-user-data').preserveLegacyUserDataPath(app);
applyAppBranding(app);
const singleInstanceLockAcquired = app.requestSingleInstanceLock();

function stopChild(child, timeoutMs = 5000, options = {}) {
  const forceKill = options.forceKill !== false;
  return new Promise((resolve) => {
    if (!child) return resolve({ exited: true, code: null, signal: null, timed_out: false });
    if (child.exitCode != null || child.signalCode) {
      return resolve({
        exited: true,
        code: child.exitCode,
        signal: child.signalCode || null,
        timed_out: false,
      });
    }
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      child.removeListener('exit', finish);
      resolve({ exited: true, code, signal: signal || null, timed_out: false });
    };
    const forceTimer = setTimeout(() => {
      child.removeListener('exit', finish);
      if (!forceKill) {
        settled = true;
        resolve({ exited: false, code: null, signal: null, timed_out: true });
        return;
      }
      try { child.kill('SIGKILL'); } catch {}
      settled = true;
      resolve({ exited: true, code: child.exitCode, signal: 'SIGKILL', timed_out: true });
    }, timeoutMs);
    child.once('exit', finish);
    try {
      child.kill('SIGTERM');
    } catch (error) {
      if (!forceKill) {
        settled = true;
        clearTimeout(forceTimer);
        child.removeListener('exit', finish);
        resolve({
          exited: false,
          code: null,
          signal: null,
          timed_out: true,
          error: error.message,
        });
        return;
      }
      finish(child.exitCode, child.signalCode);
    }
  });
}

async function stopServers() {
  const readonlyChild = server;
  const actionChild = actionServer;
  const [readonlyResult, actionResult] = await Promise.all([
    stopChild(readonlyChild),
    // The action server owns a detached recording process group. Never
    // parent-kill its guardian: it exits 0 only after PGID/streams/cleanup are safe.
    stopChild(actionChild, 15_000, { forceKill: false }),
  ]);
  if (!readonlyChild || readonlyResult.exited) server = null;
  if (!actionChild || actionResult.exited) actionServer = null;
  return {
    ok: !actionChild || (actionResult.exited && actionResult.code === 0),
    readonly: readonlyResult,
    action: actionResult,
  };
}

function healthRequest(port, token, instanceId, service) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/health',
      method: 'GET',
      headers: { 'x-hrboss-token': token },
      timeout: 500,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (res.statusCode !== 200 || data.instance_id !== instanceId || data.service !== service) {
            throw new Error(`${service} service instance mismatch`);
          }
          resolve(data);
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`${service} service health timeout`)));
    req.end();
  });
}

function availableLocalPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      probe.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error('无法分配本地服务端口。'));
        else resolve(port);
      });
    });
  });
}

async function waitForService(child, port, token, instanceId, service) {
  // The writable service may create a verified SQLite recovery point before a
  // schema migration. Give that fail-closed startup enough time without
  // weakening the normal readonly readiness timeout.
  const deadline = Date.now() + (service === 'action' ? 60_000 : 6000);
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.spawnError) throw child.spawnError;
    if (child.exitCode != null) throw new Error(`${service} service exited before readiness`);
    try {
      await healthRequest(port, token, instanceId, service);
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError || new Error(`${service} service failed readiness check`);
}

function spawnService(script, env, options = {}) {
  // 正式包不依赖目标电脑另装 node.exe；Electron 自带的 Node 运行时负责执行本地服务脚本。
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, script)], {
    cwd: PROJECT_ROOT,
    stdio: options.parentDeathIpc === true
      ? ['inherit', 'inherit', 'inherit', 'ipc']
      : 'inherit',
    windowsHide: true,
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
    },
  });
  child.spawnError = null;
  child.once('error', (error) => { child.spawnError = error; });
  return child;
}

function attachActionServerExitWatchdog(child, options = {}) {
  if (!child || child.actionExitWatchdogAttached) return false;
  child.actionExitWatchdogAttached = true;
  const registryPath = path.resolve(options.registryPath || '');
  const instanceId = String(options.instanceId || '');
  const handleUnexpectedExit = async (code, signal) => {
    if (actionServer === child) actionServer = null;
    if (shutdownStarted || shutdownFinished) return;
    if (localApiSession) localApiSession = { ...localApiSession, actionBase: null };
    let guardianResult;
    try {
      guardianResult = await requestGuardianEmergencyStop({
        registryPath,
        expectedActionInstanceId: instanceId,
        reason: `action_server_unexpected_exit:${code == null ? 'null' : code}:${signal || 'none'}`,
        waitForRegistryMs: 2000,
        timeoutMs: 1500,
      });
    } catch (error) {
      dialog.showErrorBox(
        '本地录音守护仍在核对',
        `动作服务异常退出，系统未能确认安全守护已接收停止请求。招才官 将保持运行且不会重启录音服务，请勿继续面试或强制退出。\n\n${error.message}`,
      );
      return;
    }
    const readonlyResult = await stopChild(server);
    if (readonlyResult.exited) server = null;
    shutdownFinished = true;
    dialog.showErrorBox(
      '本地动作服务异常退出',
      guardianResult.active
        ? '已通过认证的本地安全守护请求停止录音。应用将退出；重新打开后会先核对并清理未完成材料。'
        : '未发现当前实例仍在运行的录音守护。应用将退出；重新打开后仍会检查持久状态。',
    );
    app.exit(1);
  };
  child.once('exit', (code, signal) => {
    void handleUnexpectedExit(code, signal);
  });
  if (child.exitCode != null || child.signalCode) {
    void handleUnexpectedExit(child.exitCode, child.signalCode);
  }
  return true;
}

function shouldAttemptLegacyLlmMigration(secureStorePath, storedState, lstatSync = fs.lstatSync) {
  if (storedState) return false;
  try {
    lstatSync(secureStorePath);
    return false;
  } catch (error) {
    return !!error && error.code === 'ENOENT';
  }
}

const EXTERNAL_AI_CONFIG_STARTUP_FAULT = 'EXTERNAL_AI_CONFIG_UNREADABLE';

function llmStartupResolution(state = null, fault = false) {
  return {
    state: state || null,
    faultCode: fault ? EXTERNAL_AI_CONFIG_STARTUP_FAULT : '',
  };
}

function legacyLlmConfigPaths({ dataDir, appDir = PROJECT_ROOT, explicitPath = '' } = {}) {
  if (explicitPath) return [path.resolve(explicitPath)];
  return [...new Set([
    dataDir ? path.join(path.resolve(dataDir), 'rating-config.json') : '',
    path.join(path.resolve(appDir), 'rating-config.json'),
  ].filter(Boolean))];
}

function legacyLlmConfigPresence(legacyOptions, lstatSync = fs.lstatSync) {
  for (const candidate of legacyLlmConfigPaths(legacyOptions)) {
    try {
      lstatSync(candidate);
      return 'present';
    } catch (error) {
      if (!error || error.code !== 'ENOENT') return 'fault';
    }
  }
  return 'absent';
}

function resolveStartupLlmState({
  secureStorePath,
  safeStorageAdapter,
  legacyOptions,
  allowMigration = true,
  lstatSync = fs.lstatSync,
  legacyLstatSync = fs.lstatSync,
  loadSecure = loadSecureLlmState,
  loadLegacy = loadLegacyRatingState,
  saveSecure = saveSecureLlmState,
}) {
  let storedState;
  try {
    storedState = loadSecure(secureStorePath, safeStorageAdapter);
  } catch {
    return llmStartupResolution(null, true);
  }
  if (storedState) return llmStartupResolution(storedState);
  try {
    lstatSync(secureStorePath);
    return llmStartupResolution(null, true);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') return llmStartupResolution(null, true);
  }

  // Global operational-readonly startup may read the already-secured state,
  // but must never migrate a legacy config or create a replacement file.
  if (allowMigration === false) return llmStartupResolution();

  const legacyPresence = legacyLlmConfigPresence(legacyOptions, legacyLstatSync);
  if (legacyPresence === 'absent') return llmStartupResolution();
  if (legacyPresence !== 'present') return llmStartupResolution(null, true);

  let legacyState;
  let migratedState;
  try {
    legacyState = loadLegacy(legacyOptions);
    if (!legacyState) return llmStartupResolution(null, true);
    saveSecure(secureStorePath, safeStorageAdapter, {
      config: legacyState.config,
      apiKey: legacyState.apiKey,
      models: legacyState.models,
    });
    migratedState = loadSecure(secureStorePath, safeStorageAdapter);
  } catch {
    return llmStartupResolution(null, true);
  }
  return migratedState ? llmStartupResolution(migratedState) : llmStartupResolution(null, true);
}

function requireExistingPrivateDir(dir) {
  const resolved = path.resolve(dir);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    const error = new Error(`操作只读目录必须是已存在的普通目录：${resolved}`);
    error.code = 'OPERATIONAL_READONLY_DIRECTORY_INVALID';
    throw error;
  }
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    const error = new Error(`操作只读目录权限不安全；请先在正常模式修复：${resolved}`);
    error.code = 'OPERATIONAL_READONLY_DIRECTORY_PERMISSIONS_UNSAFE';
    throw error;
  }
  return resolved;
}

function prepareRuntimeDir(dir) {
  return READONLY_UI ? requireExistingPrivateDir(dir) : hardenPrivateDir(dir);
}

async function startServer() {
  const dataDir = prepareRuntimeDir(path.join(app.getPath('userData'), 'data'));
  const runtimeDataDir = process.env.HRBOSS_DATA_DIR ? prepareRuntimeDir(path.resolve(process.env.HRBOSS_DATA_DIR)) : dataDir;
  const token = crypto.randomBytes(32).toString('hex');
  f009ApprovalSecret = crypto.randomBytes(32).toString('hex');
  assessmentSelectionSecret = crypto.randomBytes(32).toString('hex');
  resumeSelectionSecret = crypto.randomBytes(32).toString('hex');
  const instanceId = crypto.randomUUID();
  const [readonlyPort, actionPort] = await Promise.all([availableLocalPort(), availableLocalPort()]);
  llmStorePath = path.join(runtimeDataDir, 'external-ai-config.v1.json');
  const startupLlmResolution = resolveStartupLlmState({
    secureStorePath: llmStorePath,
    safeStorageAdapter: safeStorage,
    allowMigration: !READONLY_UI,
    legacyOptions: {
      dataDir: runtimeDataDir,
      appDir: PROJECT_ROOT,
      explicitPath: process.env.HRBOSS_RATING_CONFIG_PATH || '',
    },
  });
  const configuredLlmState = startupLlmResolution.state;
  if (configuredLlmState?.gatewayReset === true && !READONLY_UI && !startupLlmResolution.faultCode) {
    try {
      saveSecureLlmState(llmStorePath, safeStorage, {
        config: publicConfigFields({ enabled: false, model: '' }),
        apiKey: '',
        models: [],
      });
    } catch {
      // Runtime still fails closed with an empty credential. A later successful
      // administrator save will replace the obsolete encrypted gateway state.
    }
  }
  const startupBinding = resolveLlmStartupBinding({ storedState: configuredLlmState, env: process.env });
  persistedLlmApiKey = startupBinding.apiKey;
  persistedLlmModels = startupBinding.models;
  persistedLlmConfig = startupBinding.config;
  const persistedConfig = startupBinding.config;
  const sharedEnv = {
    ...process.env,
    HRBOSS_PRODUCT_ELECTRON_PATH: process.execPath,
    HRBOSS_PRODUCT_APP_DIR: PROJECT_ROOT,
    HRBOSS_PRODUCT_IS_PACKAGED: app.isPackaged ? '1' : '0',
    HRBOSS_LOCAL_API_TOKEN: token,
    HRBOSS_LOCAL_API_INSTANCE_ID: instanceId,
    HRBOSS_F009_APPROVAL_SECRET: f009ApprovalSecret,
    HRBOSS_ASSESSMENT_SELECTION_SECRET: assessmentSelectionSecret,
    HRBOSS_RESUME_SELECTION_SECRET: resumeSelectionSecret,
    HRBOSS_ASSESSMENT_PHASE_A_ENABLED: ASSESSMENT_ENABLED ? '1' : '0',
    HRBOSS_ASSESSMENT_RETENTION_POLICY_VERSION:
      process.env.HRBOSS_ASSESSMENT_RETENTION_POLICY_VERSION
      || DEFAULT_ASSESSMENT_RETENTION_POLICY_VERSION,
    HRBOSS_ASSESSMENT_RETENTION_DAYS:
      process.env.HRBOSS_ASSESSMENT_RETENTION_DAYS
      || DEFAULT_ASSESSMENT_RETENTION_DAYS,
    // Internal-only product baseline: every candidate action must keep the current
    // candidate projection aligned with an application episode.
    HRBOSS_F018_ENABLED: '1',
    HRBOSS_DATA_DIR: runtimeDataDir,
    BOSS_DB_PATH: process.env.BOSS_DB_PATH ? path.resolve(process.env.BOSS_DB_PATH) : path.join(runtimeDataDir, 'recruiting.db'),
    BOSS_SCREENSHOT_IMPORT_PROGRESS_FILE: process.env.BOSS_SCREENSHOT_IMPORT_PROGRESS_FILE || path.join(runtimeDataDir, 'screenshot-import-progress.json'),
    BOSS_SCREENSHOT_IMPORT_TASK_STATE_FILE: process.env.BOSS_SCREENSHOT_IMPORT_TASK_STATE_FILE || path.join(runtimeDataDir, 'screenshot-import-task', 'task-run-state.json'),
    HRBOSS_TASK_DIAGNOSTICS_ROOT: process.env.HRBOSS_TASK_DIAGNOSTICS_ROOT || path.join(runtimeDataDir, 'task-diagnostics'),
    HRBOSS_SENSITIVE_READ_AUDIT_FILE: process.env.HRBOSS_SENSITIVE_READ_AUDIT_FILE || path.join(runtimeDataDir, 'sensitive-read-audit.jsonl'),
    HRBOSS_INTERVIEW_OUTPUT_DIR: process.env.HRBOSS_INTERVIEW_OUTPUT_DIR || path.join(runtimeDataDir, 'interviews'),
    HRBOSS_LOCAL_INTERVIEW_GUARDIAN_REGISTRY: process.env.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_REGISTRY
      || path.join(runtimeDataDir, 'local-interview-guardian.v1.json'),
    HRBOSS_EXTERNAL_AI_PROVIDER: persistedConfig.provider,
    HRBOSS_EXTERNAL_AI_BASE_URL: persistedConfig.baseUrl,
    HRBOSS_EXTERNAL_AI_ENABLED: persistedConfig.enabled ? '1' : '0',
    HRBOSS_EXTERNAL_AI_API_KEY: persistedLlmApiKey,
    HRBOSS_EXTERNAL_AI_MODEL: persistedConfig.model || '',
    HRBOSS_EXTERNAL_AI_VERIFIED_MODELS: JSON.stringify(persistedLlmModels),
    HRBOSS_EXTERNAL_AI_CONFIG_STARTUP_FAULT: startupLlmResolution.faultCode,
  };
  // Whitelist the locations passed to this instance's services. Relative
  // interview overrides resolve in the service cwd, not the launcher cwd.
  runtimeLocalPaths = Object.freeze({
    dataDir: sharedEnv.HRBOSS_DATA_DIR,
    databasePath: sharedEnv.BOSS_DB_PATH,
    interviewDir: path.resolve(PROJECT_ROOT, sharedEnv.HRBOSS_INTERVIEW_OUTPUT_DIR),
    screenshotDir: path.join(sharedEnv.HRBOSS_DATA_DIR, 'import'),
  });
  interviewMaterialRoot = path.resolve(sharedEnv.HRBOSS_INTERVIEW_OUTPUT_DIR);
  localInterviewGuardianRegistryPath = path.resolve(sharedEnv.HRBOSS_LOCAL_INTERVIEW_GUARDIAN_REGISTRY);
  server = spawnService(
    "src/db-server.js",
    { ...sharedEnv, BOSS_READONLY_PORT: String(readonlyPort) },
    { parentDeathIpc: true },
  );
  if (READONLY_UI) {
    console.log('readonly UI mode: action-server disabled');
    await waitForService(server, readonlyPort, token, instanceId, 'readonly');
    localApiSession = {
      token,
      instanceId,
      readonlyBase: `http://127.0.0.1:${readonlyPort}/api`,
      actionBase: null,
    };
    return localApiSession;
  }
  actionServer = spawnService(
    "src/action-server.js",
    { ...sharedEnv, BOSS_ACTION_PORT: String(actionPort) },
    { parentDeathIpc: true },
  );
  await Promise.all([
    waitForService(server, readonlyPort, token, instanceId, 'readonly'),
    waitForService(actionServer, actionPort, token, instanceId, 'action'),
  ]);
  attachActionServerExitWatchdog(actionServer, {
    registryPath: localInterviewGuardianRegistryPath,
    instanceId,
  });
  localApiSession = {
    token,
    instanceId,
    readonlyBase: `http://127.0.0.1:${readonlyPort}/api`,
    actionBase: `http://127.0.0.1:${actionPort}/api`,
  };
  return localApiSession;
}

function configuredRendererUrl() {
  const configured = String(process.env.HRBOSS_RENDERER_URL || '').trim();
  if (!configured) return pathToFileURL(path.join(PROJECT_ROOT, 'frontend', 'dist', 'index.html')).toString();
  const url = new URL(configured);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('HRBOSS_RENDERER_URL 只允许本机 HTTP 开发地址。');
  }
  return url.toString();
}

function sameRendererLocation(actual, expected) {
  try {
    const left = new URL(actual);
    const right = new URL(expected);
    return left.protocol === right.protocol
      && left.hostname === right.hostname
      && left.port === right.port
      && decodeURIComponent(left.pathname) === decodeURIComponent(right.pathname);
  } catch {
    return false;
  }
}

function isDestroyed(target) {
  try {
    return !target || typeof target.isDestroyed !== 'function' || target.isDestroyed();
  } catch {
    return true;
  }
}

function focusPrimaryWindow() {
  if (isDestroyed(win)) return false;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return true;
}

function getLiveMainWebContents() {
  if (shutdownStarted || isDestroyed(win)) return null;
  try {
    const contents = win.webContents;
    return isDestroyed(contents) ? null : contents;
  } catch {
    return null;
  }
}

function sendToLiveRenderer(sender, channel, payload) {
  if (shutdownStarted || isDestroyed(sender)) return false;
  try {
    sender.send(channel, payload);
    return true;
  } catch (error) {
    if (isDestroyed(sender) || /Object has been destroyed/i.test(String(error && error.message))) return false;
    throw error;
  }
}

function assertTrustedRenderer(event) {
  const contents = getLiveMainWebContents();
  if (!contents) throw new Error('应用正在关闭，已拒绝迟到的 IPC 请求。');
  const frame = event && event.senderFrame;
  let mainFrame;
  try {
    mainFrame = contents.mainFrame;
  } catch {
    throw new Error('应用正在关闭，已拒绝迟到的 IPC 请求。');
  }
  if (!frame || event.sender !== contents || frame !== mainFrame) {
    throw new Error('拒绝非主窗口框架的特权 IPC 请求。');
  }
  let frameUrl;
  try {
    frameUrl = frame.url;
  } catch {
    throw new Error('应用正在关闭，已拒绝迟到的 IPC 请求。');
  }
  if (!sameRendererLocation(frameUrl, rendererEntryUrl)) {
    throw new Error('拒绝非受信任页面的特权 IPC 请求。');
  }
}

function createSettingsCloseCoordinator({
  isDirty,
  clearDirty,
  showPrompt,
  closeWindow,
  quitApplication,
  reportError = () => {},
}) {
  let promptInFlight = false;
  let pendingIntent = '';

  const mergeIntent = (current, next) => (current === 'application' || next === 'application' ? 'application' : 'window');
  const complete = (intent) => {
    if (intent === 'application') quitApplication();
    else closeWindow();
  };

  return {
    async request(intent) {
      const requestedIntent = intent === 'application' ? 'application' : 'window';
      if (!isDirty()) {
        complete(requestedIntent);
        return { prompted: false, confirmed: true, intent: requestedIntent };
      }
      pendingIntent = mergeIntent(pendingIntent, requestedIntent);
      if (promptInFlight) return { prompted: false, deduplicated: true, intent: pendingIntent };
      promptInFlight = true;
      try {
        const result = await showPrompt();
        const confirmedIntent = pendingIntent || requestedIntent;
        if (!result || result.response !== 1) {
          return { prompted: true, confirmed: false, intent: confirmedIntent };
        }
        complete(confirmedIntent);
        clearDirty();
        return { prompted: true, confirmed: true, intent: confirmedIntent };
      } catch (error) {
        reportError(error);
        return { prompted: true, confirmed: false, intent: pendingIntent || requestedIntent };
      } finally {
        promptInFlight = false;
        pendingIntent = '';
      }
    },
  };
}

function showSettingsClosePrompt() {
  return dialog.showMessageBox(win, {
    type: 'warning',
    title: '存在未保存的设置修改',
    message: '关闭 招才官 将丢失设置页中未保存的草稿。',
    detail: '已保存的工作区显示和外部 AI 配置不会受影响。请选择取消关闭，或明确丢弃草稿并关闭。',
    buttons: ['取消关闭', '丢弃草稿并关闭'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
}

function beginGracefulShutdown() {
  if (shutdownStarted) return false;
  shutdownStarted = true;
  stopServers().then((result) => {
    if (result && result.action && result.action.timed_out && !result.action.exited) {
      shutdownStarted = false;
      dialog.showErrorBox(
        '本地录音仍在安全停止',
        '招才官 尚未确认本地录音进程组已结束，因此已阻止应用强制退出。请稍后再次关闭；系统不会只终止守护进程而遗留录音。',
      );
      return;
    }
    shutdownFinished = true;
    app.exit(result && result.ok === false ? 1 : 0);
  }).catch((error) => {
    shutdownStarted = false;
    dialog.showErrorBox('本地服务停止失败', `招才官 已阻止未确认的强制退出。\n\n${error.message}`);
  });
  return true;
}

function handleCandidateWindowClose(event) {
  if (!externalAiSettingsDirty) return;
  event.preventDefault();
  if (settingsCloseCoordinator) void settingsCloseCoordinator.request('window');
}

function handleApplicationBeforeQuit(event) {
  if (shutdownFinished) return;
  event.preventDefault();
  if (shutdownStarted) return;
  if (externalAiSettingsDirty) {
    if (settingsCloseCoordinator) void settingsCloseCoordinator.request('application');
    return;
  }
  beginGracefulShutdown();
}

function handleRendererNavigationStart(details) {
  if (!details || details.isMainFrame !== true || details.isSameDocument !== false) return false;
  externalAiSettingsDirty = false;
  return true;
}

function handleRendererProcessGone() {
  externalAiSettingsDirty = false;
}

function clearCandidateWindowReferences(closedWindow) {
  if (win !== closedWindow) return false;
  externalAiSettingsDirty = false;
  settingsCloseCoordinator = null;
  win = null;
  return true;
}

function requestLocalApi({ service, method = 'GET', requestPath, body = null, responseType = 'json' }) {
  if (!localApiSession) return Promise.reject(new Error('Local API session is not ready.'));
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const isAction = service === 'action';
  if (!isAction && service !== 'readonly') return Promise.reject(new Error('unknown local API service'));
  if ((!isAction && normalizedMethod !== 'GET') || !['GET', 'POST'].includes(normalizedMethod)) {
    return Promise.reject(new Error('local API method is not allowed'));
  }
  if (isAction && !localApiSession.actionBase) return Promise.reject(new Error('动作服务未启用'));
  const rawPath = String(requestPath || '');
  if (!rawPath.startsWith('/') || rawPath.includes('\\') || rawPath.includes('\0')) {
    return Promise.reject(new Error('invalid local API path'));
  }
  const base = isAction ? localApiSession.actionBase : localApiSession.readonlyBase;
  const target = new URL(`${base}${rawPath}`);
  const baseUrl = new URL(base);
  if (target.origin !== baseUrl.origin || !target.pathname.startsWith('/api/')) {
    return Promise.reject(new Error('local API path escaped its service boundary'));
  }
  const payload = normalizedMethod === 'POST' ? JSON.stringify(body || {}) : '';
  const binary = responseType === 'binary';
  const maxBytes = binary ? 25 * 1024 * 1024 : 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: normalizedMethod,
      headers: {
        'x-hrboss-token': localApiSession.token,
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        } : {}),
      },
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy(new Error('local API response too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        if (binary) {
          return resolve({
            status: res.statusCode,
            contentType: String(res.headers['content-type'] || 'application/octet-stream'),
            body: new Uint8Array(responseBody),
          });
        }
        try {
          resolve({ status: res.statusCode, body: responseBody.length ? JSON.parse(responseBody.toString('utf8')) : null });
        } catch (error) {
          reject(new Error(`本地服务返回了非法 JSON：${error.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(isAction ? 6 * 60 * 1000 : 30 * 1000, () => req.destroy(new Error('本地服务请求超时')));
    if (payload) req.write(payload);
    req.end();
  });
}

function createWindow() {
  const icon = createAppIcon();
  rendererEntryUrl = configuredRendererUrl();
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    title: APP_NAME,
    icon,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      preload: path.join(PROJECT_ROOT, "src/preload.js"),
    },
  });
  externalAiSettingsDirty = false;
  settingsCloseCoordinator = createSettingsCloseCoordinator({
    isDirty: () => externalAiSettingsDirty,
    clearDirty: () => {
      externalAiSettingsDirty = false;
    },
    showPrompt: showSettingsClosePrompt,
    closeWindow: () => {
      if (!isDestroyed(win)) win.destroy();
    },
    quitApplication: beginGracefulShutdown,
    reportError: (error) => console.error(`关闭确认流程失败：${error.message}`),
  });
  win.on('close', handleCandidateWindowClose);
  win.on('page-title-updated', (event) => {
    event.preventDefault();
    win.setTitle(APP_NAME);
  });
  const candidateWindow = win;
  win.webContents.on('did-start-navigation', handleRendererNavigationStart);
  win.webContents.on('render-process-gone', handleRendererProcessGone);
  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (!sameRendererLocation(targetUrl, rendererEntryUrl)) event.preventDefault();
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  win.on('closed', () => clearCandidateWindowReferences(candidateWindow));
  win.loadURL(rendererEntryUrl);
  win.setTitle(APP_NAME);
}

ipcMain.handle('local-api:request', (event, request) => {
  assertTrustedRenderer(event);
  return requestLocalApi(pendingScreenshotApprovals.attach(request || {}));
});

function handleExternalAiSettingsDirty(event, dirty) {
  try {
    assertTrustedRenderer(event);
  } catch {
    event.returnValue = false;
    return false;
  }
  externalAiSettingsDirty = dirty === true;
  event.returnValue = true;
  return true;
}

ipcMain.on('settings-state:external-ai-dirty', handleExternalAiSettingsDirty);

function handleLocalPathsRequest(event) {
  assertTrustedRenderer(event);
  if (!runtimeLocalPaths) throw new Error('本机目录信息尚未就绪，请退出并重新打开应用。');
  return { ok: true, paths: runtimeLocalPaths };
}

ipcMain.handle('settings-state:local-paths', handleLocalPathsRequest);

function persistLlmResponse(response, options = {}) {
  const config = response && response.body && response.body.config;
  if (!config || !llmStorePath) return response;
  if (!config.apiKeyConfigured || options.clearApiKey === true) persistedLlmApiKey = '';
  else if (options.apiKey) persistedLlmApiKey = options.apiKey;
  else if (!sameExternalAiConnection(config, persistedLlmConfig || {})) persistedLlmApiKey = '';
  persistedLlmModels = normalizeVerifiedModels(config.availableModels);
  persistedLlmConfig = publicConfigFields(config);
  try {
    saveSecureLlmState(llmStorePath, safeStorage, {
      config,
      apiKey: persistedLlmApiKey,
      models: persistedLlmModels,
    });
    response.body.credentialPersistence = 'system_encrypted';
  } catch (error) {
    response.body.credentialPersistence = 'session_only';
    response.body.credentialPersistenceWarning = error.message;
  }
  return response;
}

function queueLlmOperation(operation) {
  // Keep runtime responses and the main process's encrypted credential snapshot
  // in the same order, even when multiple trusted-renderer IPCs arrive together.
  const result = llmOperationQueue.then(operation);
  llmOperationQueue = result.catch(() => {});
  return result;
}

ipcMain.handle('llm-credential:configure', async (event, request) => {
  assertTrustedRenderer(event);
  const body = request && typeof request === 'object' ? { ...request } : {};
  const provider = normalizeProviderId(body.provider || DEFAULT_PROVIDER);
  const rawBaseUrl = String(body.baseUrl || '').trim();
  const baseUrl = canonicalBaseUrl(rawBaseUrl);
  if (!provider || (rawBaseUrl && !baseUrl)) throw new Error('请输入有效服务商标识与 HTTPS API 根地址。');
  const hasApiKey = typeof body.apiKey === 'string' && body.apiKey.trim() !== '';
  const apiKey = hasApiKey ? body.apiKey.trim() : '';
  if (hasApiKey && (apiKey.length > 4096 || /[\r\n\0]/.test(apiKey) || !baseUrl)) throw new Error('API Key 或 HTTPS API 根地址格式无效。');
  return queueLlmOperation(async () => {
    const response = await requestLocalApi({
      service: 'action',
      method: 'POST',
      requestPath: '/llm/config',
      body: {
        ...(Object.hasOwn(body, 'provider') ? { provider } : {}),
        ...(Object.hasOwn(body, 'baseUrl') ? { baseUrl } : {}),
        ...(Object.hasOwn(body, 'enabled') ? { enabled: body.enabled === true } : {}),
        ...(hasApiKey ? { apiKey } : {}),
        ...(body.clearApiKey === true ? { clearApiKey: true } : {}),
        ...(Object.hasOwn(body, 'timeoutMs') ? { timeoutMs: Number(body.timeoutMs) } : {}),
        ...(Object.hasOwn(body, 'model') ? { model: String(body.model || '').trim() } : {}),
      },
    });
    return persistLlmResponse(response, { apiKey, clearApiKey: body.clearApiKey === true });
  });
});

ipcMain.handle('llm-models:refresh', async (event) => {
  assertTrustedRenderer(event);
  return queueLlmOperation(async () => {
    const response = await requestLocalApi({ service: 'action', method: 'POST', requestPath: '/llm/models/refresh', body: {} });
    return persistLlmResponse(response);
  });
});

ipcMain.handle('llm-model:test', async (event, request) => {
  assertTrustedRenderer(event);
  const model = String(request?.model || '').trim();
  return queueLlmOperation(async () => {
    const response = await requestLocalApi({ service: 'action', method: 'POST', requestPath: '/llm/models/test', body: { model } });
    return persistLlmResponse(response);
  });
});

ipcMain.handle('llm-approval:confirm', async (event, request) => {
  assertTrustedRenderer(event);
  if (READONLY_UI) throw new Error('只读 UI 模式已禁用外部 AI。');
  const input = request && typeof request === 'object' ? request : {};
  if (input.userConfirmed !== true) throw new Error('必须由发送预览中的确认按钮发起本次授权。');
  const binding = approvalBinding({ ...input, actor: LOCAL_PRINCIPAL.actor_id });
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    title: '确认发送面试材料到外部 AI',
    message: '这是一次会产生外部数据传输和潜在费用的操作。',
    detail: `面试 ${binding.session_id}；材料 ${binding.material_ids.join(', ')}；请求 ${binding.request_id}；内容 ${binding.request_hash.slice(0, 12)}…。\nProvider ${binding.provider}（${new URL(binding.base_url).host}）；模型 ${binding.model}。确认令牌绑定当前预览，十分钟内一次有效。`,
    buttons: ['取消', '确认发送'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (result.response !== 1) return { ok: true, approved: false };
  return {
    ok: true,
    approved: true,
    userApproval: issueF009UserApproval(f009ApprovalSecret, binding),
  };
});

ipcMain.handle('external-ai-approval:confirm', async (event, request) => {
  assertTrustedRenderer(event);
  if (READONLY_UI) throw new Error('只读 UI 模式已禁用外部 AI。');
  const requestedBinding = { ...(request || {}), actor: LOCAL_PRINCIPAL.actor_id };
  const materialResponse = await requestLocalApi({
    service: 'action',
    method: 'POST',
    requestPath: '/external-ai/material-hash',
    body: {
      purpose: requestedBinding.purpose,
      targetId: requestedBinding.targetId || requestedBinding.target_id,
      materialInput: requestedBinding.materialInput || {},
    },
  });
  if (materialResponse.status !== 200 || !materialResponse.body?.ok || !materialResponse.body.materialHash) {
    throw new Error(materialResponse.body?.error || '当前外部 AI 材料尚未准备完成。');
  }
  const materialPreview = materialResponse.body.preview;
  if (!materialPreview
      || typeof materialPreview.text !== 'string'
      || !Number.isSafeInteger(materialPreview.characterCount)
      || !Array.isArray(materialPreview.exclusions)) {
    throw new Error('当前外部 AI 发送预览不完整，已阻止授权。');
  }
  const binding = externalAiApprovalBinding({
    ...requestedBinding,
    materialSha256: materialResponse.body.materialHash,
    provider: materialResponse.body.provider,
    baseUrl: materialResponse.body.baseUrl,
    model: materialResponse.body.model,
  });
  const candidateAssessment = binding.purpose === 'candidate-assessment';
  const assessmentAiAnalysis = binding.purpose === 'assessment-ai-analysis';
  const jobJdOptimization = binding.purpose === 'job-jd-optimization';
  const title = jobJdOptimization
    ? '确认发送岗位需求到外部 AI'
    : assessmentAiAnalysis
    ? '确认发送测评、简历和岗位材料到外部 AI'
    : candidateAssessment ? '确认发送候选人评估材料到外部 AI' : '确认发送岗位画像材料到外部 AI';
  const targetLabel = assessmentAiAnalysis ? '测评候选人' : candidateAssessment ? '候选人' : '岗位';
  const provider = binding.provider;
  const model = binding.model;
  const exclusions = materialPreview.exclusions
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    title,
    message: '这是一次会产生外部数据传输和潜在费用的操作。',
    detail: [
      `${targetLabel} ${binding.target_id}；请求 ${binding.request_id}；材料 ${binding.material_sha256.slice(0, 12)}…。`,
      `Provider：${provider}；服务地址：${new URL(binding.base_url).host}；模型：${model}；发送文本字符数：${materialPreview.characterCount}。`,
      `排除项：${exclusions.length ? exclusions.join('；') : '无额外排除项'}`,
      '',
      '—— 实际发送文本开始 ——',
      materialPreview.text,
      '—— 实际发送文本结束 ——',
      '',
      '确认令牌绑定本次用途、目标、请求、当前材料、Provider、服务地址和模型，十分钟内一次有效；任一项变化后旧令牌会被拒绝。',
    ].join('\n'),
    buttons: ['取消', '确认发送'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (result.response !== 1) return { ok: true, approved: false };
  return {
    ok: true,
    approved: true,
    requestId: binding.request_id,
    userApproval: issueExternalAiUserApproval(f009ApprovalSecret, binding),
  };
});

ipcMain.handle('screenshot-import:select-directory', async (event) => {
  assertTrustedRenderer(event);
  if (READONLY_UI) return { ok: false, error: '只读 UI 模式已禁用截图导入。' };
  const result = await dialog.showOpenDialog(win, {
    title: '选择 Boss App 截图文件夹',
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { ok: true, canceled: true };
  try {
    const selected = resolveSelectedDirectory(result.filePaths[0], { label: '截图文件夹' });
    if (process.platform !== 'darwin') {
      const requestId = crypto.randomUUID();
      const previewResponse = await requestLocalApi({
        service: 'action',
        method: 'POST',
        requestPath: '/screenshot-import/preflight',
        body: { dir: selected.path, requestId },
      });
      if (previewResponse.status !== 200 || !previewResponse.body?.ok) {
        throw new Error(previewResponse.body?.error || '截图外部 AI 发送预检失败。');
      }
      const preview = previewResponse.body.preview;
      const binding = screenshotApprovalBinding(preview, requestId, LOCAL_PRINCIPAL.actor_id);
      const approval = await dialog.showMessageBox(win, screenshotApprovalDialog(preview, binding));
      if (approval.response !== 1) return { ok: true, canceled: true };
      pendingScreenshotApprovals.put(selected.path, {
        requestId: binding.request_id,
        userApproval: issueExternalAiUserApproval(f009ApprovalSecret, binding),
      });
    }
    return {
      ok: true,
      path: selected.path,
      pathRecovered: selected.recoveredTrailingSpaces,
    };
  } catch (error) {
    return { ok: false, code: error.code, error: error.message };
  }
});

// Exposed for the failed-item UI: preview first, then a native one-shot
// approval. The renderer receives a signed token but never the signing secret.
ipcMain.handle('screenshot-import:approve-retry', async (event, request = {}) => {
  assertTrustedRenderer(event);
  if (READONLY_UI) throw new Error('只读 UI 模式已禁用截图导入。');
  const requestId = crypto.randomUUID();
  const previewResponse = await requestLocalApi({
    service: 'action',
    method: 'POST',
    requestPath: '/screenshot-import/retry-preflight',
    body: { run_id: request.run_id, item_ids: request.item_ids, requestId },
  });
  if (previewResponse.status !== 200 || !previewResponse.body?.ok) {
    throw new Error(previewResponse.body?.error || '截图重试发送预检失败。');
  }
  const binding = screenshotApprovalBinding(previewResponse.body.preview, requestId, LOCAL_PRINCIPAL.actor_id);
  const approval = await dialog.showMessageBox(win, screenshotApprovalDialog(previewResponse.body.preview, binding));
  if (approval.response !== 1) return { ok: true, approved: false };
  return {
    ok: true,
    approved: true,
    requestId: binding.request_id,
    userApproval: issueExternalAiUserApproval(f009ApprovalSecret, binding),
  };
});

ipcMain.handle('screenshot-import:approve-ai-fill', async (event, request = {}) => {
  assertTrustedRenderer(event);
  if (READONLY_UI) throw new Error('只读 UI 模式已禁用截图 AI 补全。');
  const requestId = crypto.randomUUID();
  const previewResponse = await requestLocalApi({
    service: 'action',
    method: 'POST',
    requestPath: '/screenshot-ocr-drafts/ai-fill-preflight',
    body: { job_id: request.job_id, requestId },
  });
  if (previewResponse.status !== 200 || !previewResponse.body?.ok) {
    throw new Error(previewResponse.body?.error || '截图 AI 补全发送预检失败。');
  }
  const binding = screenshotApprovalBinding(previewResponse.body.preview, requestId, LOCAL_PRINCIPAL.actor_id);
  const approval = await dialog.showMessageBox(win, screenshotApprovalDialog(previewResponse.body.preview, binding));
  if (approval.response !== 1) return { ok: true, approved: false };
  return {
    ok: true,
    approved: true,
    requestId: binding.request_id,
    userApproval: issueExternalAiUserApproval(f009ApprovalSecret, binding),
  };
});

ipcMain.handle('local-interview:select-media-file', async (event) => {
  assertTrustedRenderer(event);
  if (READONLY_UI) return { ok: false, error: '只读 UI 模式已禁用本地面试导入。' };
  const result = await dialog.showOpenDialog(win, {
    title: '选择面试录音或录屏文件',
    properties: ['openFile'],
    filters: [
      { name: '音视频文件', extensions: ['mp4', 'mov', 'm4v', 'wav', 'm4a', 'mp3', 'aac', 'flac', 'ogg'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { ok: true, canceled: true };
  return { ok: true, path: result.filePaths[0] };
});

ipcMain.handle('local-interview:select-summary-file', async (event) => {
  assertTrustedRenderer(event);
  if (READONLY_UI) return { ok: false, error: '只读 UI 模式已禁用面试录音摘要导入。' };
  if (!interviewMaterialRoot) return { ok: false, error: '面试材料目录尚未就绪，请稍后重试。' };
  const materialRoot = getInterviewMaterialRoot(interviewMaterialRoot);
  const result = await dialog.showOpenDialog(win, {
    title: '选择面试录音 summary.json',
    defaultPath: materialRoot,
    properties: ['openFile'],
    filters: [{ name: '面试录音摘要', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths.length) return { ok: true, canceled: true };
  try {
    const selected = validateInterviewMaterialFile(result.filePaths[0], 'summary', { root: materialRoot });
    return { ok: true, canceled: false, path: selected.path };
  } catch (error) {
    return { ok: false, code: error.code, error: error.message };
  }
});

ipcMain.handle('resume-candidate:select-and-preview', async (event, request) => {
  assertTrustedRenderer(event);
  if (READONLY_UI) return { ok: false, error: '只读 UI 模式已禁用简历建档。' };
  const input = request && typeof request === 'object' ? request : {};
  const jobId = Number(input.job_id);
  if (!Number.isInteger(jobId) || jobId <= 0) return { ok: false, error: '请先选择当前岗位。' };
  const selection = await dialog.showOpenDialog(win, {
    title: '上传简历并创建候选人',
    properties: ['openFile'],
    filters: [
      { name: '简历文件', extensions: ['pdf', 'doc', 'docx', 'rtf', 'txt'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (selection.canceled || !selection.filePaths.length) return { ok: true, canceled: true };
  const requestId = `resume-candidate-${crypto.randomUUID()}`;
  const binding = {
    source_path: selection.filePaths[0],
    candidate_id: NEW_CANDIDATE_BINDING,
    job_id: jobId,
    request_id: requestId,
  };
  const selectionToken = issueResumeFileSelection(resumeSelectionSecret, binding);
  const response = await requestLocalApi({
    service: 'action',
    method: 'POST',
    requestPath: '/candidate/resume-intake/preview',
    body: {
      candidate_id: NEW_CANDIDATE_BINDING,
      job_id: jobId,
      request_id: requestId,
      selection_token: selectionToken,
    },
  });
  if (response.status < 200 || response.status >= 300 || !response.body || response.body.ok !== true) {
    return { ok: false, code: response.body && response.body.code, error: (response.body && response.body.error) || '简历建档预处理失败。' };
  }
  return { ok: true, result: response.body.result };
});

ipcMain.handle('resume-attachment:select-and-import', async (event, request) => {
  assertTrustedRenderer(event);
  if (READONLY_UI) return { ok: false, error: '只读 UI 模式已禁用手动上传简历。' };
  const input = request && typeof request === 'object' ? request : {};
  const candidateId = String(input.candidate_id || '').trim();
  const jobId = Number(input.job_id);
  if (!candidateId || !Number.isInteger(jobId) || jobId <= 0) {
    return { ok: false, error: '请先选择当前岗位中的候选人。' };
  }
  const selection = await dialog.showOpenDialog(win, {
    title: '手动上传候选人简历',
    properties: ['openFile'],
    filters: [
      { name: '简历文件', extensions: ['pdf', 'doc', 'docx', 'rtf', 'txt'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (selection.canceled || !selection.filePaths.length) return { ok: true, canceled: true };
  const sourcePath = selection.filePaths[0];
  const requestId = `manual-resume-${crypto.randomUUID()}`;
  const binding = {
    source_path: sourcePath,
    candidate_id: candidateId,
    job_id: jobId,
    request_id: requestId,
  };
  const selectionToken = issueResumeFileSelection(resumeSelectionSecret, binding);
  const response = await requestLocalApi({
    service: 'action',
    method: 'POST',
    requestPath: '/candidate/resume-attachment/import',
    body: {
      candidate_id: candidateId,
      job_id: jobId,
      request_id: requestId,
      selection_token: selectionToken,
    },
  });
  if (response.status < 200 || response.status >= 300 || !response.body || response.body.ok !== true) {
    return { ok: false, code: response.body && response.body.code, error: (response.body && response.body.error) || '手动上传简历失败。' };
  }
  return { ok: true, result: response.body.result };
});

ipcMain.handle('assessment:select-and-import', async (event, request) => {
  assertTrustedRenderer(event);
  if (READONLY_UI) return { ok: false, error: '只读 UI 模式已禁用 PDF 测评存档。' };
  if (!ASSESSMENT_ENABLED) {
    return { ok: false, code: 'ASSESSMENT_PHASE_A_DISABLED', error: '测评报告功能尚未启用。' };
  }
  const input = request && typeof request === 'object' ? request : {};
  const singleFileRetry = input.single_file_retry === true;
  const selection = await dialog.showOpenDialog(win, {
    title: singleFileRetry ? '重新选择一份失败的 PDF 测评报告' : '选择一份或多份 PDF 测评报告',
    properties: singleFileRetry ? ['openFile'] : ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
  });
  if (selection.canceled || !selection.filePaths.length) return { ok: true, canceled: true };
  const batch = await importAssessmentFileBatch({
    filePaths: selection.filePaths,
    input,
    issueSelectionToken: (binding) => issueAssessmentFileSelection(assessmentSelectionSecret, binding),
    requestImport: async (binding, selectionToken) => {
      const response = await requestLocalApi({
        service: 'action',
        method: 'POST',
        requestPath: '/assessment/import',
        body: { ...binding, source_path: undefined, selection_token: selectionToken },
      });
      return response.body || { ok: false, error: 'PDF 测评行政存档没有返回结果。' };
    },
    onProgress: (progress) => {
      sendToLiveRenderer(event.sender, 'assessment:import-progress', progress);
    },
  });
  const firstSuccess = batch.items.find((item) => item.ok);
  return {
    ok: true,
    ...batch,
    ...(batch.selected_count === 1 && firstSuccess ? { result: firstSuccess.result } : {}),
  };
});

function registerPrimaryApplicationLifecycle() {
  app.on('second-instance', focusPrimaryWindow);
  app.whenReady().then(async () => {
    applyDockBranding(app);
    await startServer();
    createWindow();
  }).catch((error) => {
    dialog.showErrorBox('本地服务启动失败', `招才官 已安全停止，未连接未知服务。\n\n${error.message}`);
    stopServers().then((result) => {
      if (result && result.action && result.action.timed_out && !result.action.exited) {
        dialog.showErrorBox('本地服务仍在安全停止', '已阻止强制退出，避免遗留本地录音进程。');
        return;
      }
      shutdownFinished = true;
      app.exit(1);
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', handleApplicationBeforeQuit);
}

if (!singleInstanceLockAcquired) {
  if (process.env.HRBOSS_LAUNCH_REQUIRE_PRIMARY === '1') {
    console.error('招才官 开发启动未获得主实例锁；已有 招才官 实例正在运行，本次启动未建立可验收窗口。');
    app.exit(2);
  } else {
    app.quit();
  }
} else {
  registerPrimaryApplicationLifecycle();
}
