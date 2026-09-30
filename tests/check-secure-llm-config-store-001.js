'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');
const {
  loadLegacyRatingState,
  loadSecureLlmState,
  saveSecureLlmState,
} = require("../src/secure-llm-config-store");
const { describeModel } = require("../src/external-ai-policy");

const SYNTHETIC_CURRENT_KEY = 'synthetic-current-key-for-safe-store-test';
const SYNTHETIC_REPLACEMENT_KEY = 'synthetic-replacement-key-for-safe-store-test';
const SYNTHETIC_MODEL = 'claude-sonnet-4-20260730-synthetic';

function mockSafeStorage({ available = true, encryptError = null, decryptError = null } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString(value) {
      if (encryptError) throw encryptError;
      return Buffer.from(`encrypted:${String(value)}`, 'utf8');
    },
    decryptString(value) {
      if (decryptError) throw decryptError;
      const text = Buffer.from(value).toString('utf8');
      if (!text.startsWith('encrypted:')) throw new Error('synthetic bad ciphertext');
      return text.slice('encrypted:'.length);
    },
  };
}

function syntheticState(apiKey = SYNTHETIC_CURRENT_KEY) {
  return {
    config: {
      provider: 'synthetic',
      baseUrl: 'https://ai.example.test/v1',
      enabled: true,
      model: SYNTHETIC_MODEL,
      timeoutMs: 120000,
    },
    apiKey,
    models: [describeModel(SYNTHETIC_MODEL, { verified: true })],
  };
}

function readSource(name) {
  return fs.readFileSync(path.join(PROJECT_ROOT, name), 'utf8');
}

function pausedSaveWorker({ filePath, state, failRename = false }) {
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const workerSource = `
    'use strict';
    const fs = require('node:fs');
    const { parentPort, workerData } = require('node:worker_threads');
    const { saveSecureLlmState } = require(workerData.storeModulePath);
    const control = new Int32Array(workerData.controlBuffer);
    const originalWriteFileSync = fs.writeFileSync;
    const originalRenameSync = fs.renameSync;
    fs.writeFileSync = function interceptedWrite(file, ...args) {
      const result = originalWriteFileSync.call(fs, file, ...args);
      if (String(file).startsWith(workerData.filePath + '.') && String(file).endsWith('.tmp')) {
        parentPort.postMessage({ type: 'temp-written', tempPath: String(file), pid: process.pid });
        Atomics.wait(control, 0, 0);
      }
      return result;
    };
    if (workerData.failRename) {
      fs.renameSync = function interceptedRename() {
        throw new Error('synthetic interleaved rename failure');
      };
    }
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from('encrypted:' + String(value), 'utf8'),
    };
    try {
      saveSecureLlmState(workerData.filePath, safeStorage, workerData.state);
      parentPort.postMessage({ type: 'done', ok: true });
    } catch (error) {
      parentPort.postMessage({ type: 'done', ok: false, error: error.message });
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      fs.renameSync = originalRenameSync;
    }
  `;
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: {
      storeModulePath: path.join(PROJECT_ROOT, "src/secure-llm-config-store.js"),
      filePath,
      state,
      failRename,
      controlBuffer,
    },
  });
  return {
    worker,
    release() {
      const control = new Int32Array(controlBuffer);
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
    },
  };
}

function waitForWorkerMessage(worker, type) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code) => {
      if (code === 0) return;
      cleanup();
      reject(new Error(`synthetic save worker exited with ${code}`));
    };
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}

async function testInterleavedSaves(root, safeStorage) {
  const filePath = path.join(root, 'interleaved', 'external-ai-config.v1.json');
  saveSecureLlmState(filePath, safeStorage, syntheticState('synthetic-last-good-key'));
  const firstState = syntheticState('synthetic-first-interleaved-key');
  const secondState = syntheticState('synthetic-second-interleaved-key');
  const first = pausedSaveWorker({ filePath, state: firstState });
  const firstTemp = await waitForWorkerMessage(first.worker, 'temp-written');
  const second = pausedSaveWorker({ filePath, state: secondState });
  const secondTemp = await waitForWorkerMessage(second.worker, 'temp-written');

  assert.equal(firstTemp.pid, process.pid, 'worker threads must exercise the same process id');
  assert.equal(secondTemp.pid, process.pid, 'worker threads must exercise the same process id');
  assert.notEqual(firstTemp.tempPath, secondTemp.tempPath, 'same-process saves must never share a temporary path');
  assert.equal(path.dirname(firstTemp.tempPath), path.dirname(filePath), 'the first temporary file must stay beside the target');
  assert.equal(path.dirname(secondTemp.tempPath), path.dirname(filePath), 'the second temporary file must stay beside the target');
  assert.match(path.basename(firstTemp.tempPath), /^[^.].*\.[0-9]+\.[0-9a-f]{32}\.tmp$/);
  assert.match(path.basename(secondTemp.tempPath), /^[^.].*\.[0-9]+\.[0-9a-f]{32}\.tmp$/);
  assert.equal(fs.existsSync(firstTemp.tempPath), true);
  assert.equal(fs.existsSync(secondTemp.tempPath), true);

  const secondDonePromise = waitForWorkerMessage(second.worker, 'done');
  second.release();
  assert.deepEqual(await secondDonePromise, { type: 'done', ok: true });
  assert.equal(loadSecureLlmState(filePath, safeStorage).apiKey, secondState.apiKey, 'the first completed commit must be readable while the earlier call is paused');

  const firstDonePromise = waitForWorkerMessage(first.worker, 'done');
  first.release();
  assert.deepEqual(await firstDonePromise, { type: 'done', ok: true });
  assert.equal(loadSecureLlmState(filePath, safeStorage).apiKey, firstState.apiKey, 'the last completed atomic rename must define the final state');
  assert.equal(fs.existsSync(firstTemp.tempPath), false);
  assert.equal(fs.existsSync(secondTemp.tempPath), false);
}

async function testFailedSaveDoesNotDeletePeerTemp(root, safeStorage) {
  const filePath = path.join(root, 'interleaved-failure', 'external-ai-config.v1.json');
  const lastGoodState = syntheticState('synthetic-failure-last-good-key');
  const failedState = syntheticState('synthetic-failed-interleaved-key');
  const peerState = syntheticState('synthetic-peer-interleaved-key');
  saveSecureLlmState(filePath, safeStorage, lastGoodState);

  const failed = pausedSaveWorker({ filePath, state: failedState, failRename: true });
  const failedTemp = await waitForWorkerMessage(failed.worker, 'temp-written');
  const peer = pausedSaveWorker({ filePath, state: peerState });
  const peerTemp = await waitForWorkerMessage(peer.worker, 'temp-written');
  assert.notEqual(failedTemp.tempPath, peerTemp.tempPath, 'a failing save and its peer must own different temporary files');

  const failedDonePromise = waitForWorkerMessage(failed.worker, 'done');
  failed.release();
  const failedDone = await failedDonePromise;
  assert.equal(failedDone.ok, false);
  assert.match(failedDone.error, /synthetic interleaved rename failure/);
  assert.equal(fs.existsSync(failedTemp.tempPath), false, 'the failing call must remove only its own temporary file');
  assert.equal(fs.existsSync(peerTemp.tempPath), true, 'the failing call must not delete a paused peer save');
  assert.equal(loadSecureLlmState(filePath, safeStorage).apiKey, lastGoodState.apiKey, 'last-good state must remain until the peer actually commits');

  const peerDonePromise = waitForWorkerMessage(peer.worker, 'done');
  peer.release();
  assert.deepEqual(await peerDonePromise, { type: 'done', ok: true });
  assert.equal(loadSecureLlmState(filePath, safeStorage).apiKey, peerState.apiKey, 'the surviving peer commit must become the final readable state');
  assert.equal(fs.existsSync(peerTemp.tempPath), false, 'the successful peer rename must consume its temporary file');
  assert.deepEqual(fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith('.tmp')), [], 'interleaved completion must leave no temporary ciphertext');
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-secure-llm-store-'));
  const filePath = path.join(root, 'private', 'external-ai-config.v1.json');
  const safeStorage = mockSafeStorage();
  const capturedLogs = [];
  const originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  try {
    console.log = (...args) => capturedLogs.push(args.join(' '));
    console.warn = (...args) => capturedLogs.push(args.join(' '));
    console.error = (...args) => capturedLogs.push(args.join(' '));

    saveSecureLlmState(filePath, safeStorage, syntheticState());
    const persistedBytes = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(persistedBytes, new RegExp(SYNTHETIC_CURRENT_KEY), 'the persisted file must not contain a plaintext API key');
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600, 'the secure state file must be owner-only');
    assert.deepEqual(loadSecureLlmState(filePath, safeStorage), syntheticState(), 'encrypted state must round-trip through safeStorage');
    assert.equal(capturedLogs.join('\n').includes(SYNTHETIC_CURRENT_KEY), false, 'secure store operations must not log the API key');

    const untestedCatalogPath = path.join(root, 'untested-catalog', 'external-ai-config.v1.json');
    fs.mkdirSync(path.dirname(untestedCatalogPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(untestedCatalogPath, JSON.stringify({
      version: 1,
      config: syntheticState().config,
      models: [{ id: SYNTHETIC_MODEL, family: 'claude' }],
      encryptedApiKey: safeStorage.encryptString(SYNTHETIC_CURRENT_KEY).toString('base64'),
    }), { mode: 0o600 });
    assert.deepEqual(loadSecureLlmState(untestedCatalogPath, safeStorage), {
      config: {
        provider: 'synthetic',
        baseUrl: 'https://ai.example.test/v1',
        enabled: false,
        model: '',
        timeoutMs: 120000,
      },
      apiKey: '',
      models: [],
    }, 'a version 1 store must require credential reentry because its key has no encrypted connection binding');

    const obsoleteGatewayPath = path.join(root, 'obsolete-gateway', 'external-ai-config.v1.json');
    fs.mkdirSync(path.dirname(obsoleteGatewayPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(obsoleteGatewayPath, JSON.stringify({
      version: 1,
      config: {
        provider: 'invalid provider',
        baseUrl: 'http://invalid.example.test',
        enabled: true,
        model: 'gpt-legacy',
        timeoutMs: 120000,
      },
      models: [{ id: 'gpt-legacy' }],
      encryptedApiKey: safeStorage.encryptString('synthetic-invalid-connection-key').toString('base64'),
    }), { mode: 0o600 });
    assert.deepEqual(loadSecureLlmState(obsoleteGatewayPath, safeStorage), {
      config: { provider: 'openai-compatible', baseUrl: '', enabled: false, model: '', timeoutMs: 120000 },
      apiKey: '', models: [], gatewayReset: true,
    }, 'invalid stored connection must not be rebound to any destination');

    const unavailablePath = path.join(root, 'unavailable', 'external-ai-config.v1.json');
    assert.throws(
      () => saveSecureLlmState(unavailablePath, mockSafeStorage({ available: false }), syntheticState()),
      /仅在本次运行中有效/,
      'saving a credential must fail closed when system encryption is unavailable',
    );
    assert.equal(fs.existsSync(unavailablePath), false, 'safeStorage unavailability must not create a plaintext fallback file');
    assert.equal(
      loadSecureLlmState(filePath, mockSafeStorage({ available: false })),
      null,
      'an encrypted credential must not load while system decryption is unavailable',
    );

    const encryptFailurePath = path.join(root, 'encrypt-failure', 'external-ai-config.v1.json');
    assert.throws(
      () => saveSecureLlmState(
        encryptFailurePath,
        mockSafeStorage({ encryptError: new Error('synthetic encrypt failure') }),
        syntheticState(SYNTHETIC_REPLACEMENT_KEY),
      ),
      /synthetic encrypt failure/,
    );
    assert.equal(fs.existsSync(encryptFailurePath), false, 'encryption failure must not create a target state file');

    assert.equal(
      loadSecureLlmState(filePath, mockSafeStorage({ decryptError: new Error('synthetic decrypt failure') })),
      null,
      'decryption failure must not expose partial public configuration as trusted state',
    );
    const badCipherPath = path.join(root, 'bad-cipher.json');
    fs.writeFileSync(badCipherPath, JSON.stringify({
      version: 1,
      config: syntheticState().config,
      models: syntheticState().models,
      encryptedApiKey: Buffer.from('not-a-valid-synthetic-cipher').toString('base64'),
    }), { mode: 0o600 });
    assert.equal(loadSecureLlmState(badCipherPath, safeStorage), null, 'bad ciphertext must fail closed');

    const beforeAtomicFailure = fs.readFileSync(filePath);
    const originalRenameSync = fs.renameSync;
    const originalWriteFileSync = fs.writeFileSync;
    let failedTemporaryPath = '';
    try {
      fs.writeFileSync = (targetPath, ...args) => {
        if (String(targetPath).startsWith(`${filePath}.`) && String(targetPath).endsWith('.tmp')) {
          failedTemporaryPath = String(targetPath);
        }
        return originalWriteFileSync.call(fs, targetPath, ...args);
      };
      fs.renameSync = () => { throw new Error('synthetic atomic rename failure'); };
      assert.throws(
        () => saveSecureLlmState(filePath, safeStorage, syntheticState(SYNTHETIC_REPLACEMENT_KEY)),
        /synthetic atomic rename failure/,
      );
    } finally {
      fs.renameSync = originalRenameSync;
      fs.writeFileSync = originalWriteFileSync;
    }
    assert.deepEqual(fs.readFileSync(filePath), beforeAtomicFailure, 'a failed atomic rename must leave the last good state byte-for-byte intact');
    assert.equal(loadSecureLlmState(filePath, safeStorage).apiKey, SYNTHETIC_CURRENT_KEY, 'a failed replacement must not partially clear or replace the stored key');
    assert.equal(
      fs.existsSync(failedTemporaryPath),
      false,
      'a failed write must not leave a new encrypted credential in a stale temporary file',
    );

    await testInterleavedSaves(root, safeStorage);
    await testFailedSaveDoesNotDeletePeerTemp(root, safeStorage);

    const legacyPath = path.join(root, 'rating-config.json');
    fs.writeFileSync(legacyPath, JSON.stringify({
      provider: 'synthetic-legacy-provider',
      base_url: 'https://legacy.synthetic.invalid/openai/v1',
      api_key: 'synthetic-legacy-key',
      model: 'synthetic-legacy-model',
      enabled: true,
    }), { mode: 0o600 });
    assert.equal(loadSecureLlmState(badCipherPath, safeStorage), null);
    const obsoleteLegacy = loadLegacyRatingState({ dataDir: root, appDir: root, env: {} });
    assert.equal(obsoleteLegacy.apiKey, 'synthetic-legacy-key', 'legacy migration must keep the credential at its original endpoint');
    assert.equal(obsoleteLegacy.config.provider, 'synthetic-legacy-provider');
    assert.equal(obsoleteLegacy.config.baseUrl, 'https://legacy.synthetic.invalid/openai/v1');
    assert.equal(obsoleteLegacy.config.enabled, false);
    assert.deepEqual(obsoleteLegacy.models, []);

    const settingsState = await import(`${pathToFileURL(path.join(PROJECT_ROOT, 'frontend/src/settings-state.mjs')).href}?secure-store-test=1`);
    const newCredentialWarning = settingsState.credentialPersistenceFeedback({
      credentialPersistence: 'session_only',
      credentialPersistenceWarning: 'synthetic secure storage failure',
    }, true);
    assert.equal(newCredentialWarning.type, 'warning', 'session-only credential persistence must never render as success');
    assert.match(newCredentialWarning.message, /只在本次会话生效/);
    assert.match(newCredentialWarning.description, /本次新密钥仅当前会话使用/);
    assert.match(newCredentialWarning.description, /可能恢复保存前的配置或原访问密钥/);
    assert.match(newCredentialWarning.description, /重新确认当前状态，必要时重新保存/);
    const configWarning = settingsState.credentialPersistenceFeedback({ credentialPersistence: 'session_only' }, false);
    assert.equal(configWarning.type, 'warning', 'session-only config persistence must never render as success');
    assert.match(configWarning.description, /恢复为原来的配置/);

    const settingsPanel = readSource('frontend/src/components/SettingsPanel.jsx');
    const clearCredential = settingsPanel.slice(
      settingsPanel.indexOf('async function clearLlmCredential'),
      settingsPanel.indexOf('function beginLlmDraftEdit'),
    );
    const clearFailureWarning = clearCredential.slice(
      clearCredential.indexOf("if (result.credentialPersistence === 'session_only'"),
      clearCredential.indexOf('} else {', clearCredential.indexOf("if (result.credentialPersistence === 'session_only'")),
    );
    assert.match(clearFailureWarning, /外部 AI 仅在本次会话关闭/);
    assert.match(clearFailureWarning, /重启后原访问密钥可能恢复/);
    assert.doesNotMatch(clearFailureWarning, /已清除|永久清除/, 'a failed persistent clear must not claim the stored key was cleared');

    const candidateMain = readSource("src/candidate-main.js");
    const preload = readSource("src/preload.js");
    const actionServer = readSource("src/action-server.js");
    const database = readSource("src/db.js");
    const runtime = readSource("src/f009-interview-llm.js");
    const publicConfig = runtime.slice(runtime.indexOf('function publicConfig()'), runtime.indexOf('function configure(input'));
    assert.match(candidateMain, /function shouldAttemptLegacyLlmMigration\(/, 'the main process must distinguish an absent secure store from an unreadable one');
    assert.match(candidateMain, /error\.code === 'ENOENT'/, 'only an explicitly absent secure store may enable legacy migration');
    assert.match(candidateMain, /const startupLlmResolution = resolveStartupLlmState\(\{/, 'startup must retain both secure state and an explicit fault code');
    assert.match(candidateMain, /HRBOSS_EXTERNAL_AI_CONFIG_STARTUP_FAULT: startupLlmResolution\.faultCode/, 'the main process must forward a non-sensitive startup fault to the local action service');
    assert.match(actionServer, /GET'[\s\S]*?'\/api\/llm\/config'[\s\S]*?externalAiStartupConfigFaultResponse\(\)/, 'the config read route must surface the startup fault');
    assert.doesNotMatch(candidateMain, /storedLlmState \? null : loadLegacyRatingState/, 'a corrupt secure store must not reactivate a legacy credential');
    assert.doesNotMatch(publicConfig, /apiKey\s*:/, 'the renderer-facing public config must not include an API key value');
    assert.doesNotMatch(candidateMain, /console\.(?:log|warn|error)\([^\n]*(?:apiKey|API Key|credential)/, 'the main process must not log credentials');
    assert.doesNotMatch(actionServer, /console\.(?:log|warn|error)\([^\n]*(?:apiKey|API Key|credential)/, 'the action service must not log credentials');
    assert.doesNotMatch(database, /(?:api_key|apiKey|encryptedApiKey)/, 'SQLite code must not define or persist external AI credentials');
    assert.doesNotMatch(settingsPanel, /localStorage\.(?:setItem|getItem|removeItem)\([^\n]*(?:apiKey|API Key|credential)/, 'settings must not persist the API key in localStorage');
    assert.doesNotMatch(preload, /getLlmCredential|readLlmCredential|apiKey\s*:/, 'preload must not expose a credential-reading bridge');
  } finally {
    console.log = originalConsole.log;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    ok: true,
    contract: 'secure-llm-config-store-001',
    safe_storage_unavailable: 'session-only-no-plaintext-fallback',
    encrypt_failure: 'fail-closed',
    decrypt_failure: 'fail-closed-at-store-layer',
    bad_ciphertext: 'fail-closed-at-store-layer',
    corrupt_secure_store_legacy_fallback: 'blocked-by-main-process',
    atomic_write_failure: 'last-good-state-preserved-and-temp-removed',
    interleaved_same_process_saves: 'unique-temp-and-last-commit-wins',
    failed_interleaved_save: 'peer-temp-preserved-and-no-temp-left',
    clear_failure_copy: 'session-only-and-old-key-may-recover',
    credential_surfaces: 'no-log-no-sqlite-no-localstorage-no-read-bridge',
    network: 'not-used',
    data: 'synthetic-tmp-only',
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
