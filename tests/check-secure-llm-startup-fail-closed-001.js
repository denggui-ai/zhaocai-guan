'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { loadLegacyRatingState, loadSecureLlmState, saveSecureLlmState } = require("../src/secure-llm-config-store");

const source = fs.readFileSync(path.join(PROJECT_ROOT, "src/candidate-main.js"), 'utf8');
const actionSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/action-server.js"), 'utf8');
const frontendApiSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/api.js'), 'utf8');
const settingsSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/SettingsPanel.jsx'), 'utf8');
const STARTUP_FAULT_CODE = 'EXTERNAL_AI_CONFIG_UNREADABLE';

function extractFunction(name, sourceText = source) {
  const start = sourceText.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const paramsStart = sourceText.indexOf('(', start);
  let paramsDepth = 0;
  let bodyStart = -1;
  for (let index = paramsStart; index < sourceText.length; index += 1) {
    if (sourceText[index] === '(') paramsDepth += 1;
    else if (sourceText[index] === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        bodyStart = sourceText.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < sourceText.length; index += 1) {
    if (sourceText[index] === '{') depth += 1;
    else if (sourceText[index] === '}') {
      depth -= 1;
      if (depth === 0) return sourceText.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

const context = vm.createContext({ PROJECT_ROOT,
  fs,
  path,
  __dirname: PROJECT_ROOT,
  loadLegacyRatingState,
  loadSecureLlmState,
  saveSecureLlmState,
  EXTERNAL_AI_CONFIG_STARTUP_FAULT: STARTUP_FAULT_CODE,
});
vm.runInContext([
  extractFunction('shouldAttemptLegacyLlmMigration'),
  extractFunction('llmStartupResolution'),
  extractFunction('legacyLlmConfigPaths'),
  extractFunction('legacyLlmConfigPresence'),
  extractFunction('resolveStartupLlmState'),
  'this.helpers = { shouldAttemptLegacyLlmMigration, resolveStartupLlmState, legacyLlmConfigPresence };',
].join('\n'), context);

const { shouldAttemptLegacyLlmMigration, resolveStartupLlmState, legacyLlmConfigPresence } = context.helpers;

const actionContext = vm.createContext({ EXTERNAL_AI_CONFIG_STARTUP_FAULT_CODE: STARTUP_FAULT_CODE });
vm.runInContext([
  extractFunction('externalAiStartupConfigFaultResponse', actionSource),
  'this.faultResponse = externalAiStartupConfigFaultResponse;',
].join('\n'), actionContext);
const externalAiStartupConfigFaultResponse = actionContext.faultResponse;

function assertReady(resolution, expectedKey) {
  assert.equal(resolution.faultCode, '');
  assert.equal(resolution.state.apiKey, expectedKey);
}

function assertUnconfigured(resolution) {
  assert.equal(resolution.faultCode, '');
  assert.equal(resolution.state, null);
}

function assertFault(resolution) {
  assert.equal(resolution.faultCode, STARTUP_FAULT_CODE);
  assert.equal(resolution.state, null);
  assert.deepEqual(Object.keys(resolution).sort(), ['faultCode', 'state']);
}

function probeActionServerFaultRoutes(tempRoot) {
  const electronPath = require('electron');
  const token = 'synthetic-local-api-token-0000000000000000';
  const actionServerPath = path.join(PROJECT_ROOT, "src/action-server.js");
  const probeScript = `
    const { route } = require(${JSON.stringify(actionServerPath)});
    const token = ${JSON.stringify(token)};
    async function request(method) {
      let status = 0;
      let body = '';
      const req = {
        method,
        url: '/api/llm/config',
        headers: {
          host: '127.0.0.1',
          'x-hrboss-token': token,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
      };
      const res = {
        setHeader() {},
        writeHead(nextStatus) { status = nextStatus; },
        end(chunk = '') { body += String(chunk); },
      };
      await route(req, res);
      return { method, status, body: JSON.parse(body) };
    }
    Promise.all([request('GET'), request('POST')])
      .then((results) => process.stdout.write(JSON.stringify(results)))
      .catch((error) => { process.stderr.write(error.stack || error.message); process.exit(1); });
  `;
  const child = spawnSync(electronPath, ['-e', probeScript], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH || '',
      NODE_PATH: process.env.NODE_PATH || '',
      TMPDIR: os.tmpdir(),
      ELECTRON_RUN_AS_NODE: '1',
      HRBOSS_LOCAL_API_TOKEN: token,
      HRBOSS_LOCAL_API_INSTANCE_ID: 'synthetic-startup-fault-probe',
      HRBOSS_EXTERNAL_AI_CONFIG_STARTUP_FAULT: STARTUP_FAULT_CODE,
      HRBOSS_EXTERNAL_AI_API_KEY: '',
      HRBOSS_MAIBAO_API_KEY: '',
      HRBOSS_EXTERNAL_AI_ENABLED: '0',
      HRBOSS_DATA_DIR: tempRoot,
      BOSS_DB_PATH: path.join(tempRoot, 'unused-route-probe.db'),
    },
  });
  assert.equal(child.status, 0, child.stderr || 'action server fault route probe failed');
  const responses = JSON.parse(child.stdout);
  assert.deepEqual(responses.map(({ method, status }) => ({ method, status })), [
    { method: 'GET', status: 503 },
    { method: 'POST', status: 503 },
  ]);
  for (const response of responses) {
    assert.equal(response.body.ok, false);
    assert.equal(response.body.code, STARTUP_FAULT_CODE);
    assert.match(response.body.error, /写入已锁定/);
  }
  return responses;
}

const syntheticSecureState = { config: { enabled: false }, apiKey: 'synthetic-secure-key', models: [] };
let lstatCalls = 0;
assert.equal(shouldAttemptLegacyLlmMigration('/synthetic/secure.json', syntheticSecureState, () => {
  lstatCalls += 1;
}), false);
assert.equal(lstatCalls, 0, 'valid secure state must not probe legacy eligibility');
assert.equal(shouldAttemptLegacyLlmMigration('/synthetic/secure.json', null, () => ({})), false, 'present secure store must block legacy fallback');
assert.equal(shouldAttemptLegacyLlmMigration('/synthetic/secure.json', null, () => {
  const error = new Error('permission denied');
  error.code = 'EACCES';
  throw error;
}), false, 'unknown secure-store status must fail closed');
assert.equal(shouldAttemptLegacyLlmMigration('/synthetic/secure.json', null, () => {
  const error = new Error('missing');
  error.code = 'ENOENT';
  throw error;
}), true, 'only an explicitly missing secure store may use legacy migration');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-secure-llm-startup-'));
try {
  const makeLegacyFixture = (name, {
    provider = 'synthetic',
    baseUrl = 'https://ai.example.test/v1',
  } = {}) => {
    const fixtureRoot = path.join(tempRoot, name);
    fs.mkdirSync(fixtureRoot, { recursive: true });
    const secureStorePath = path.join(fixtureRoot, 'external-ai-config.v1.json');
    const legacyPath = path.join(fixtureRoot, 'rating-config.json');
    const legacyRaw = JSON.stringify({
      provider,
      baseUrl,
      apiKey: 'synthetic-legacy-key',
      model: 'claude-sonnet-4-20260730-startup',
      enabled: true,
    });
    fs.writeFileSync(legacyPath, legacyRaw);
    return {
      secureStorePath,
      legacyPath,
      legacyRaw,
      legacyOptions: { dataDir: fixtureRoot, appDir: fixtureRoot, env: {} },
    };
  };
  const unavailableSafeStorage = {
    isEncryptionAvailable: () => false,
    decryptString: () => { throw new Error('must not decrypt'); },
  };
  const failingDecryptSafeStorage = {
    isEncryptionAvailable: () => true,
    decryptString: () => { throw new Error('synthetic decrypt failure'); },
  };
  const workingSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`sealed:${Buffer.from(value, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (value) => Buffer.from(value.toString('utf8').replace(/^sealed:/, ''), 'base64').toString('utf8'),
  };

  const routeResponses = probeActionServerFaultRoutes(path.join(tempRoot, 'route-probe'));
  const serializedRouteResponses = JSON.stringify(routeResponses);
  for (const sensitiveFragment of [tempRoot, 'synthetic-legacy-key', 'synthetic-ciphertext', 'encryptedApiKey']) {
    assert.equal(serializedRouteResponses.includes(sensitiveFragment), false, `route fault must not expose ${sensitiveFragment}`);
  }

  const neverConfiguredRoot = path.join(tempRoot, 'never-configured');
  fs.mkdirSync(neverConfiguredRoot, { recursive: true });
  const neverConfigured = resolveStartupLlmState({
    secureStorePath: path.join(neverConfiguredRoot, 'external-ai-config.v1.json'),
    safeStorageAdapter: workingSafeStorage,
    legacyOptions: { dataDir: neverConfiguredRoot, appDir: neverConfiguredRoot, env: {} },
  });
  assertUnconfigured(neverConfigured);

  const successFixture = makeLegacyFixture('success');
  const migrated = resolveStartupLlmState({
    secureStorePath: successFixture.secureStorePath,
    safeStorageAdapter: workingSafeStorage,
    legacyOptions: successFixture.legacyOptions,
  });
  assertReady(migrated, 'synthetic-legacy-key');
  assert.equal(fs.existsSync(successFixture.secureStorePath), true, 'successful migration must create the secure store');
  const secureRaw = fs.readFileSync(successFixture.secureStorePath, 'utf8');
  assert.doesNotMatch(secureRaw, /synthetic-legacy-key/, 'migrated secure store must not contain the plaintext key');
  const restoredMigration = loadSecureLlmState(successFixture.secureStorePath, workingSafeStorage);
  assert.equal(restoredMigration.apiKey, 'synthetic-legacy-key', 'migrated secure state must be readable');
  assert.equal(fs.readFileSync(successFixture.legacyPath, 'utf8'), successFixture.legacyRaw, 'migration must not modify the legacy file');
  let repeatLegacyLoads = 0;
  let repeatSecureWrites = 0;
  const restoredWithoutLegacy = resolveStartupLlmState({
    secureStorePath: successFixture.secureStorePath,
    safeStorageAdapter: workingSafeStorage,
    legacyOptions: successFixture.legacyOptions,
    loadLegacy: () => { repeatLegacyLoads += 1; return null; },
    saveSecure: () => { repeatSecureWrites += 1; },
  });
  assertReady(restoredWithoutLegacy, 'synthetic-legacy-key');
  assert.equal(repeatLegacyLoads, 0, 'a successful migration must not reread legacy on the next start');
  assert.equal(repeatSecureWrites, 0, 'a successful migration must not rewrite the secure store on the next start');

  const alternateProviderFixture = makeLegacyFixture('alternate-provider', {
    provider: 'synthetic-alternate', baseUrl: 'https://alternate.example.test/openai',
  });
  const alternateProviderMigration = resolveStartupLlmState({
    secureStorePath: alternateProviderFixture.secureStorePath,
    safeStorageAdapter: workingSafeStorage,
    legacyOptions: alternateProviderFixture.legacyOptions,
  });
  assertReady(alternateProviderMigration, 'synthetic-legacy-key');
  assert.equal(alternateProviderMigration.state.config.provider, 'synthetic-alternate');
  assert.equal(alternateProviderMigration.state.config.baseUrl, 'https://alternate.example.test/openai',
    'migration must preserve the credential endpoint instead of retargeting it');
  assert.equal(alternateProviderMigration.state.config.enabled, false);
  assert.equal(alternateProviderMigration.state.config.model, '');
  assert.deepEqual(alternateProviderMigration.state.models, []);
  const alternateSecureRaw = fs.readFileSync(alternateProviderFixture.secureStorePath, 'utf8');
  assert.doesNotMatch(alternateSecureRaw, /synthetic-legacy-key/);
  assert.ok(JSON.parse(alternateSecureRaw).encryptedApiKey, 'valid credentials must migrate only through secure storage');
  assert.equal(fs.readFileSync(alternateProviderFixture.legacyPath, 'utf8'), alternateProviderFixture.legacyRaw);

  const invalidEndpointFixture = makeLegacyFixture('insecure-endpoint', {
    baseUrl: 'http://ai.example.test/v1',
  });
  const invalidEndpointMigration = resolveStartupLlmState({
    secureStorePath: invalidEndpointFixture.secureStorePath,
    safeStorageAdapter: workingSafeStorage,
    legacyOptions: invalidEndpointFixture.legacyOptions,
  });
  assertFault(invalidEndpointMigration);
  assert.equal(fs.existsSync(invalidEndpointFixture.secureStorePath), false,
    'an invalid endpoint must not migrate its key to a default or replacement endpoint');
  assert.equal(fs.readFileSync(invalidEndpointFixture.legacyPath, 'utf8'), invalidEndpointFixture.legacyRaw);

  const readonlyFixture = makeLegacyFixture('operational-readonly-no-migration');
  let readonlyLegacyStats = 0;
  let readonlyLegacyLoads = 0;
  let readonlySecureWrites = 0;
  const readonlyResolution = resolveStartupLlmState({
    secureStorePath: readonlyFixture.secureStorePath,
    safeStorageAdapter: workingSafeStorage,
    legacyOptions: readonlyFixture.legacyOptions,
    allowMigration: false,
    legacyLstatSync: () => { readonlyLegacyStats += 1; return fs.lstatSync(readonlyFixture.legacyPath); },
    loadLegacy: () => { readonlyLegacyLoads += 1; return { apiKey: 'must-not-load' }; },
    saveSecure: () => { readonlySecureWrites += 1; },
  });
  assertUnconfigured(readonlyResolution);
  assert.equal(readonlyLegacyStats, 0, 'operational readonly must not probe legacy migration inputs');
  assert.equal(readonlyLegacyLoads, 0, 'operational readonly must not load legacy config for migration');
  assert.equal(readonlySecureWrites, 0, 'operational readonly must not create the secure store');
  assert.equal(fs.existsSync(readonlyFixture.secureStorePath), false);
  assert.equal(fs.readFileSync(readonlyFixture.legacyPath, 'utf8'), readonlyFixture.legacyRaw);

  const unavailableFixture = makeLegacyFixture('safe-storage-unavailable');
  const unavailableMigration = resolveStartupLlmState({
    secureStorePath: unavailableFixture.secureStorePath,
    safeStorageAdapter: unavailableSafeStorage,
    legacyOptions: unavailableFixture.legacyOptions,
  });
  assertFault(unavailableMigration);
  assert.equal(fs.existsSync(unavailableFixture.secureStorePath), false);
  assert.equal(fs.readFileSync(unavailableFixture.legacyPath, 'utf8'), unavailableFixture.legacyRaw);

  const encryptionFailureFixture = makeLegacyFixture('encryption-failure');
  const encryptionFailureStorage = {
    isEncryptionAvailable: () => true,
    encryptString: () => { throw new Error('synthetic encryption failure'); },
  };
  const encryptionFailedMigration = resolveStartupLlmState({
    secureStorePath: encryptionFailureFixture.secureStorePath,
    safeStorageAdapter: encryptionFailureStorage,
    legacyOptions: encryptionFailureFixture.legacyOptions,
  });
  assertFault(encryptionFailedMigration);
  assert.equal(fs.existsSync(encryptionFailureFixture.secureStorePath), false);
  assert.equal(fs.readFileSync(encryptionFailureFixture.legacyPath, 'utf8'), encryptionFailureFixture.legacyRaw);

  const unreadableWriteFixture = makeLegacyFixture('unreadable-encryption-result');
  const unreadableWriteStorage = {
    isEncryptionAvailable: () => true,
    encryptString: () => Buffer.from('synthetic-unreadable-ciphertext'),
    decryptString: () => { throw new Error('synthetic read-back failure'); },
  };
  const unreadableWriteMigration = resolveStartupLlmState({
    secureStorePath: unreadableWriteFixture.secureStorePath,
    safeStorageAdapter: unreadableWriteStorage,
    legacyOptions: unreadableWriteFixture.legacyOptions,
  });
  assertFault(unreadableWriteMigration);
  assert.equal(fs.existsSync(unreadableWriteFixture.secureStorePath), true, 'failed read-back keeps the secure sentinel that blocks future legacy fallback');
  assert.equal(fs.readFileSync(unreadableWriteFixture.legacyPath, 'utf8'), unreadableWriteFixture.legacyRaw);

  const brokenCipherFixture = makeLegacyFixture('broken-cipher');
  fs.writeFileSync(brokenCipherFixture.secureStorePath, JSON.stringify({
    version: 1,
    config: { provider: 'secure-provider', enabled: true },
    encryptedApiKey: Buffer.from('synthetic-ciphertext').toString('base64'),
  }));
  let brokenCipherLegacyLoads = 0;
  let brokenCipherSecureWrites = 0;
  const decryptFailed = resolveStartupLlmState({
    secureStorePath: brokenCipherFixture.secureStorePath,
    safeStorageAdapter: failingDecryptSafeStorage,
    legacyOptions: brokenCipherFixture.legacyOptions,
    loadLegacy: () => { brokenCipherLegacyLoads += 1; return { apiKey: 'must-not-load' }; },
    saveSecure: () => { brokenCipherSecureWrites += 1; },
  });
  assertFault(decryptFailed);
  assert.equal(brokenCipherLegacyLoads, 0);
  assert.equal(brokenCipherSecureWrites, 0);
  assert.equal(fs.readFileSync(brokenCipherFixture.legacyPath, 'utf8'), brokenCipherFixture.legacyRaw);

  const malformedFixture = makeLegacyFixture('malformed-secure-store');
  fs.writeFileSync(malformedFixture.secureStorePath, '{invalid-json');
  const malformed = resolveStartupLlmState({
    secureStorePath: malformedFixture.secureStorePath,
    safeStorageAdapter: unavailableSafeStorage,
    legacyOptions: malformedFixture.legacyOptions,
  });
  assertFault(malformed);

  const invalidLegacyFixture = makeLegacyFixture('invalid-legacy');
  fs.writeFileSync(invalidLegacyFixture.legacyPath, '{invalid-json');
  const invalidLegacy = resolveStartupLlmState({
    secureStorePath: invalidLegacyFixture.secureStorePath,
    safeStorageAdapter: workingSafeStorage,
    legacyOptions: invalidLegacyFixture.legacyOptions,
  });
  assertFault(invalidLegacy);

  const thrownSecureRead = resolveStartupLlmState({
    secureStorePath: path.join(tempRoot, 'synthetic-eacces-secure.json'),
    safeStorageAdapter: workingSafeStorage,
    legacyOptions: { dataDir: neverConfiguredRoot, appDir: neverConfiguredRoot, env: {} },
    loadSecure: () => { throw new Error('synthetic path and key must stay private'); },
  });
  assertFault(thrownSecureRead);

  let legacyLoads = 0;
  const unknownPresence = resolveStartupLlmState({
    secureStorePath: malformedFixture.secureStorePath,
    safeStorageAdapter: unavailableSafeStorage,
    legacyOptions: malformedFixture.legacyOptions,
    loadSecure: () => null,
    lstatSync: () => {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    },
    loadLegacy: () => { legacyLoads += 1; return { apiKey: 'must-not-load' }; },
  });
  assertFault(unknownPresence);
  assert.equal(legacyLoads, 0, 'permission/stat failures must not reach the legacy loader');

  const legacyPresenceFault = legacyLlmConfigPresence(
    { explicitPath: path.join(tempRoot, 'private-rating-config.json') },
    () => {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    },
  );
  assert.equal(legacyPresenceFault, 'fault');
  const legacyEacces = resolveStartupLlmState({
    secureStorePath: path.join(tempRoot, 'missing-secure-for-legacy-eacces.json'),
    safeStorageAdapter: workingSafeStorage,
    legacyOptions: { explicitPath: path.join(tempRoot, 'private-rating-config.json') },
    legacyLstatSync: () => {
      const error = new Error('permission denied');
      error.code = 'EACCES';
      throw error;
    },
  });
  assertFault(legacyEacces);

  const secureWins = resolveStartupLlmState({
    secureStorePath: malformedFixture.secureStorePath,
    safeStorageAdapter: unavailableSafeStorage,
    legacyOptions: malformedFixture.legacyOptions,
    loadSecure: () => syntheticSecureState,
    lstatSync: () => { throw new Error('must not stat a valid secure state'); },
    loadLegacy: () => { throw new Error('must not load legacy'); },
  });
  assertReady(secureWins, 'synthetic-secure-key');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const faultPayload = externalAiStartupConfigFaultResponse(STARTUP_FAULT_CODE);
assert.equal(faultPayload.status, 503);
assert.equal(faultPayload.body.ok, false);
assert.equal(faultPayload.body.code, STARTUP_FAULT_CODE);
assert.match(faultPayload.body.error, /读取失败/);
assert.match(faultPayload.body.error, /写入已锁定/);
const serializedFault = JSON.stringify(faultPayload);
for (const sensitiveFragment of ['/private/', 'synthetic-legacy-key', 'synthetic-ciphertext', 'API Key']) {
  assert.equal(serializedFault.includes(sensitiveFragment), false, `startup fault must not expose ${sensitiveFragment}`);
}
assert.equal(externalAiStartupConfigFaultResponse(''), null);

assert.match(source, /const startupLlmResolution = resolveStartupLlmState\(\{/);
assert.match(source, /HRBOSS_EXTERNAL_AI_CONFIG_STARTUP_FAULT: startupLlmResolution\.faultCode/);
assert.doesNotMatch(source, /storedLlmState \? null : loadLegacyRatingState/);
assert.match(actionSource, /if \(req\.method === 'GET' && url\.pathname === '\/api\/llm\/config'\) \{[\s\S]*?externalAiStartupConfigFaultResponse\(\)[\s\S]*?send\(res, startupFault\.status, startupFault\.body\)/);
assert.match(actionSource, /if \(req\.method === 'POST' && url\.pathname === '\/api\/llm\/config'\) \{[\s\S]*?externalAiStartupConfigFaultResponse\(\)/);
assert.match(frontendApiSource, /if \(!data \|\| !data\.ok\) \{[\s\S]*?throw error;/, 'the API client must reject the startup fault response');
assert.match(settingsSource, /\.catch\(\(err\) => \{[\s\S]*?llmPersistedConfigRef\.current = null;[\s\S]*?setLlmLoadError\(/, 'settings must retain an explicit load error instead of treating the fault as unconfigured');
assert.match(settingsSource, /const llmConfigurationLocked = isLlmConfigurationLocked\(readOnly, llmLoadError\)/, 'the existing settings write lock must consume the startup load error');

console.log('check-secure-llm-startup-fail-closed-001 ok');
