'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {
  createF009LlmRuntime,
  normalizeBaseUrl,
  providerRequestUrl,
  normalizeModelList,
} = require("../src/f009-interview-llm");
const { describeModel, sameExternalAiConnection, publicConfigFields, normalizeVerifiedModels } = require("../src/external-ai-policy");
const { saveSecureLlmState, loadSecureLlmState, resolveLlmStartupBinding } = require("../src/secure-llm-config-store");

const A = 'https://ai.example.test/v1';
const B = 'https://other.example.test/compatible';
const MODEL = 'vendor/synthetic-model:free';
const KEY = 'synthetic-key-for-gateway-regression';
const reply = (model) => ({ model, choices: [{ message: { content: '{"ok":true,"purpose":"hrboss_model_compatibility"}' } }] });
function deferred() {
  let resolve;
  return { promise: new Promise((done) => { resolve = done; }), resolve: (value) => resolve(value) };
}

async function main() {
  const defaults = createF009LlmRuntime({ env: {} });
  assert.equal(defaults.publicConfig().baseUrl, '', 'fresh installs must not select an external destination');
  assert.equal(defaults.publicConfig().enabled, false);
  for (const [input, expected] of [
    ['https://example.test', 'https://example.test/v1'],
    ['https://example.test/v1/', 'https://example.test/v1'],
    ['https://example.test/openai/v1', 'https://example.test/openai/v1'],
    ['https://example.test/v1beta/openai/', 'https://example.test/v1beta/openai'],
    ['https://example.test:9443/custom', 'https://example.test:9443/custom'],
  ]) {
    assert.equal(normalizeBaseUrl(input), expected);
    assert.equal(providerRequestUrl(input, '/v1/models').toString(), `${expected}/models`);
    assert.equal(providerRequestUrl(input, '/v1/chat/completions').toString(), `${expected}/chat/completions`);
  }
  for (const input of ['', 'http://example.test', 'https://user:pass@example.test', 'https://example.test?q=key', 'https://example.test/#x', `https://example.test/${'x'.repeat(2048)}`]) {
    assert.throws(() => normalizeBaseUrl(input), { code: 'BASE_URL_INVALID' });
  }
  const ids = ['deepseek-synthetic', 'qwen-synthetic', 'llama-synthetic', MODEL, 'gpt-mini-synthetic', ...Array.from({ length: 12 }, (_, n) => `custom-${n}`)];
  assert.deepEqual(normalizeModelList({ data: ids.map((id) => ({ id })) }).map((row) => row.id).sort(), [...ids].sort());
  assert.ok(normalizeModelList({ data: ids }).every((row) => row.verified === false));

  const calls = [];
  const runtime = createF009LlmRuntime({ env: {}, transport: async (request) => { calls.push(request); return reply(request.body.model); } });
  runtime.configure({ provider: 'synthetic', baseUrl: A, apiKey: KEY });
  await runtime.testModel({ model: MODEL });
  runtime.configure({ enabled: true });
  assert.equal(runtime.publicConfig().modelVerified, true);
  runtime.configure({ baseUrl: `${A}/` });
  assert.equal(runtime.publicConfig().modelVerified, true, 'equivalent URL spelling preserves the binding');
  const before = runtime.publicConfig();
  assert.throws(() => runtime.configure({ clearApiKey: true, apiKey: KEY }), { code: 'API_KEY_INVALID' });
  assert.throws(() => runtime.configure({ baseUrl: B, timeoutMs: 1 }));
  assert.deepEqual(runtime.publicConfig(), before, 'invalid config cannot partially clear the connection');
  runtime.configure({ baseUrl: B, enabled: true });
  assert.equal(runtime.publicConfig().apiKeyConfigured, false, 'A credential must never follow an endpoint change');
  assert.equal(runtime.publicConfig().modelVerified, false);
  assert.equal(runtime.publicConfig().enabled, false);
  await assert.rejects(runtime.testModel({ model: MODEL }), { code: 'API_KEY_REQUIRED' });
  assert.equal(calls.length, 1, 'unconfigured B receives no request');
  runtime.configure({ apiKey: KEY });
  await runtime.testModel({ model: MODEL });
  runtime.configure({ provider: 'another', apiKey: 'synthetic-explicit-b-key' });
  assert.equal(runtime.publicConfig().apiKeyConfigured, true);
  assert.equal(runtime.publicConfig().modelVerified, false);
  assert.deepEqual(runtime.publicConfig().availableModels, []);

  for (const operation of ['refreshModels', 'testModel']) {
    for (const change of [{ baseUrl: B }, { apiKey: 'synthetic-new-key' }, { clearApiKey: true }]) {
      const pending = deferred();
      const racing = createF009LlmRuntime({ env: {}, transport: () => pending.promise });
      racing.configure({ provider: 'synthetic', baseUrl: A, apiKey: KEY });
      const old = racing[operation]({ model: MODEL });
      racing.configure(change);
      const rejection = assert.rejects(old, { code: 'CONFIG_CHANGED' });
      pending.resolve(operation === 'testModel' ? reply(MODEL) : { data: [{ id: MODEL }] });
      await rejection;
      assert.equal(racing.publicConfig().modelVerified, false);
      assert.deepEqual(racing.publicConfig().availableModels, []);
    }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'talentbench-gateway-'));
  try {
    const storage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(`encrypted:${value}`), decryptString: (value) => value.toString().slice(10) };
    const state = { config: { provider: 'synthetic', baseUrl: A, enabled: true, model: MODEL, timeoutMs: 120000 }, apiKey: KEY, models: [describeModel(MODEL, { verified: true })] };
    const file = path.join(root, 'config.json');
    saveSecureLlmState(file, storage, state);
    assert.deepEqual(loadSecureLlmState(file, storage), state);
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...payload, config: { ...payload.config, baseUrl: B } }));
    assert.equal(loadSecureLlmState(file, storage), null, 'changing plaintext endpoint cannot rebind an encrypted credential or model proof');
    fs.writeFileSync(file, JSON.stringify({ ...payload, models: [describeModel('injected-model', { verified: true })] }));
    assert.deepEqual(loadSecureLlmState(file, storage).models, state.models, 'verified models come from the encrypted connection envelope');
    for (const [label, encryptedApiKey] of [
      ['version 1 endpoint tampering', storage.encryptString(KEY).toString('base64')],
      ['version 2 downgraded to version 1', payload.encryptedApiKey],
    ]) {
      const tamperedConfig = { ...payload.config, provider: 'another', baseUrl: B };
      fs.writeFileSync(file, JSON.stringify({ ...payload, version: 1, config: tamperedConfig, encryptedApiKey }));
      const legacy = loadSecureLlmState(file, storage);
      assert.ok(legacy, `${label}: retain a readable connection for manual credential reentry`);
      const startup = resolveLlmStartupBinding({ storedState: legacy, env: {} });
      const outbound = [];
      const restarted = createF009LlmRuntime({
        env: {
          HRBOSS_EXTERNAL_AI_PROVIDER: startup.config.provider,
          HRBOSS_EXTERNAL_AI_BASE_URL: startup.config.baseUrl,
          HRBOSS_EXTERNAL_AI_API_KEY: startup.apiKey,
          HRBOSS_EXTERNAL_AI_ENABLED: startup.config.enabled ? '1' : '0',
          HRBOSS_EXTERNAL_AI_MODEL: startup.config.model,
        },
        initialSupportedModels: startup.models,
        transport: async (request) => {
          outbound.push(request);
          return request.body ? reply(request.body.model) : { data: [{ id: MODEL }] };
        },
      });
      const results = await Promise.allSettled([restarted.refreshModels(), restarted.testModel({ model: MODEL })]);
      assert.equal(outbound.length, 0, `${label}: refresh and test must not send an unbound legacy credential`);
      for (const result of results) {
        assert.equal(result.status, 'rejected', `${label}: credential reentry is required`);
        assert.equal(result.reason.code, 'API_KEY_REQUIRED');
      }
      assert.equal(legacy.apiKey, '');
      assert.deepEqual(legacy.models, []);
      assert.equal(legacy.config.provider, tamperedConfig.provider);
      assert.equal(legacy.config.baseUrl, tamperedConfig.baseUrl);
      assert.equal(legacy.config.enabled, false);
      assert.equal(legacy.config.model, '');
    }
    assert.deepEqual(resolveLlmStartupBinding({ storedState: state, env: {} }), state);
    const changed = resolveLlmStartupBinding({ storedState: state, env: { HRBOSS_EXTERNAL_AI_BASE_URL: B } });
    assert.equal(changed.apiKey, '');
    assert.deepEqual(changed.models, []);
    assert.equal(changed.config.enabled, false);
    const changedKey = resolveLlmStartupBinding({ storedState: state, env: { HRBOSS_EXTERNAL_AI_API_KEY: 'synthetic-env-key' } });
    assert.equal(changedKey.apiKey, 'synthetic-env-key');
    assert.deepEqual(changedKey.models, []);
    assert.equal(changedKey.config.model, '');
    const explicit = resolveLlmStartupBinding({ storedState: state, env: { HRBOSS_EXTERNAL_AI_BASE_URL: B, HRBOSS_EXTERNAL_AI_API_KEY: 'synthetic-env-b-key' } });
    assert.equal(explicit.config.baseUrl, B);
    assert.equal(explicit.apiKey, 'synthetic-env-b-key');
    assert.deepEqual(explicit.models, []);

    // Exercise the actual main-process persister without booting Electron or
    // inspecting any real user data. Its separate secret cache must clear too.
    const mainSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/candidate-main.js"), 'utf8');
    const persister = mainSource.slice(mainSource.indexOf('function persistLlmResponse('), mainSource.indexOf("ipcMain.handle('llm-credential:configure'"));
    const saved = [];
    const context = {
      llmStorePath: file, safeStorage: storage,
      persistedLlmApiKey: KEY, persistedLlmModels: state.models, persistedLlmConfig: state.config,
      sameExternalAiConnection, publicConfigFields, normalizeVerifiedModels,
      saveSecureLlmState: (_file, _storage, value) => saved.push(value),
      llmOperationQueue: Promise.resolve(),
    };
    vm.createContext(context);
    vm.runInContext(persister, context);
    context.persistLlmResponse({ body: { config: { ...state.config, baseUrl: B, model: null, apiKeyConfigured: false, availableModels: [] } } });
    assert.equal(saved.at(-1).apiKey, '');
    assert.deepEqual(saved.at(-1).models, []);
    context.persistLlmResponse({ body: { config: { ...state.config, baseUrl: B, model: null, apiKeyConfigured: true, availableModels: [] } } }, { apiKey: 'synthetic-main-b-key' });
    assert.equal(saved.at(-1).apiKey, 'synthetic-main-b-key');
    const held = deferred();
    const order = [];
    const first = context.queueLlmOperation(async () => { order.push('first-start'); await held.promise; order.push('first-end'); });
    const second = context.queueLlmOperation(async () => { order.push('second'); });
    await Promise.resolve();
    assert.deepEqual(order, ['first-start']);
    held.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first-start', 'first-end', 'second']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('check-external-ai-gateway-001: PASS (HTTPS roots, open model IDs, atomic binding, stale response rejection, secure/env binding)');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
