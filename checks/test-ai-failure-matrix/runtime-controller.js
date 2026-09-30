'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAW_PII = Object.freeze([
  '13812345678',
  'synthetic-b11@example.test',
  '110101199001011234',
  'wx_b11privacy',
]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installRuntimeController({
  app,
  BrowserWindow,
  syntheticRoot,
  confirmationQueue,
  wasSecretInjected,
  providerBaseUrl,
}) {
  const providerUrl = new URL(providerBaseUrl);
  assert.equal(providerUrl.protocol, 'https:');
  assert.equal(providerUrl.hostname, '127.0.0.1', 'the synthetic provider must remain on loopback');
  const resultPath = path.join(syntheticRoot, 'runtime-result.json');
  const seed = JSON.parse(fs.readFileSync(path.join(syntheticRoot, 'seed.json'), 'utf8'));

  async function waitForWindow(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      if (win) return win;
      await delay(100);
    }
    throw new Error('timed out waiting for the Zhaocai Guan main window');
  }

  async function evaluate(win, source) {
    return win.webContents.executeJavaScript(source, true);
  }

  async function waitForBridge(win, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const ready = await evaluate(win, `Boolean(
          window.localApi?.request
          && window.llmCredential?.configure
          && window.llmCredential?.refreshModels
          && window.llmCredential?.testModel
          && window.llmApproval?.confirm
        )`);
        if (ready) return;
      } catch {}
      await delay(120);
    }
    throw new Error('timed out waiting for the trusted renderer bridges');
  }

  async function invoke(win, expression) {
    return evaluate(win, `(async () => (${expression}))()`);
  }

  async function localPost(win, requestPath, body) {
    return invoke(win, `window.localApi.request(${JSON.stringify({
      service: 'action',
      method: 'POST',
      requestPath,
      body,
    })})`);
  }

  async function preview(win, requestId) {
    const response = await localPost(win, '/interview-report/llm/preview', {
      sessionId: seed.session_id,
      materialIds: seed.material_ids,
      requestId,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.ok, true);
    assert.ok(response.body.preview);
    assert.equal(response.body.preview.provider, 'synthetic');
    assert.equal(response.body.preview.baseUrl, providerBaseUrl);
    return response.body.preview;
  }

  async function nativeConfirm(win, currentPreview) {
    const approved = await invoke(
      win,
      `window.llmApproval.confirm(${JSON.stringify({ ...currentPreview, userConfirmed: true })})`,
    );
    assert.equal(approved.ok, true);
    assert.equal(approved.approved, true);
    assert.ok(approved.userApproval);
    return approved.userApproval;
  }

  async function analyze(win, currentPreview, userApproval, requestHash = currentPreview.requestHash) {
    return localPost(win, '/interview-report/llm/analyze', {
      sessionId: currentPreview.sessionId,
      materialIds: currentPreview.materialIds,
      requestHash,
      expectedVersion: 0,
      requestId: currentPreview.requestId,
      userApproval,
    });
  }

  async function approvedFailure(win, requestId, expectedStatus, expectedCode) {
    const currentPreview = await preview(win, requestId);
    const userApproval = await nativeConfirm(win, currentPreview);
    const response = await analyze(win, currentPreview, userApproval);
    assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
    assert.equal(response.body.ok, false);
    assert.equal(response.body.code, expectedCode, JSON.stringify(response.body));
    return {
      preview: currentPreview,
      result: {
        request_id: requestId,
        status: response.status,
        code: response.body.code,
        path: response.body.path,
        error: response.body.error,
      },
    };
  }

  async function runJourney() {
    const win = await waitForWindow();
    await waitForBridge(win);
    const configure = await invoke(win, `window.llmCredential.configure(${JSON.stringify({
      provider: 'synthetic',
      baseUrl: providerBaseUrl,
      enabled: false,
      apiKey: 'synthetic-b11-api-key',
      model: '',
      timeoutMs: 5_000,
    })})`);
    assert.equal(configure.status, 200, JSON.stringify(configure.body));
    assert.equal(configure.body.config.enabled, false, 'saving credentials must not enable external AI');
    const models = await invoke(win, 'window.llmCredential.refreshModels()');
    assert.equal(models.status, 200, JSON.stringify(models.body));
    assert.deepEqual(models.body.models.map((item) => item.id), ['gpt-b11-synthetic']);
    const modelTest = await invoke(win, `window.llmCredential.testModel(${JSON.stringify({
      model: 'gpt-b11-synthetic',
    })})`);
    assert.equal(modelTest.status, 200, JSON.stringify(modelTest.body));
    assert.equal(modelTest.body.model.id, 'gpt-b11-synthetic');
    assert.equal(modelTest.body.model.verified, true);
    assert.equal(modelTest.body.config.enabled, false, 'a model test must not enable external AI');
    const configuredModel = await invoke(win, `window.llmCredential.configure(${JSON.stringify({
      enabled: true,
    })})`);
    assert.equal(configuredModel.status, 200, JSON.stringify(configuredModel.body));
    assert.equal(configuredModel.body.config.modelVerified, true);
    assert.equal(configuredModel.body.config.operational, true);
    assert.equal(configuredModel.body.config.timeoutMs, 5_000);

    const httpPreview = await preview(win, 'b11-provider-500');
    const serializedPreview = JSON.stringify(httpPreview);
    for (const token of RAW_PII) assert.equal(serializedPreview.includes(token), false, `preview leaked ${token}`);
    assert.match(serializedPreview, /█{8,}/);
    assert.equal(
      httpPreview.units.reduce((total, unit) => total + unit.text.length, 0),
      seed.source_text_length,
      'PII masking must preserve the original evidence offsets',
    );
    assert.match(httpPreview.notice, /手机号、邮箱、身份证和微信式标识已等长掩码/);
    const httpApproval = await nativeConfirm(win, httpPreview);
    const mismatch = await analyze(win, httpPreview, httpApproval, '0'.repeat(64));
    assert.equal(mismatch.status, 409, JSON.stringify(mismatch.body));
    assert.equal(mismatch.body.code, 'PREVIEW_HASH_MISMATCH');
    const httpFailure = await analyze(win, httpPreview, httpApproval);
    assert.equal(httpFailure.status, 502, JSON.stringify(httpFailure.body));
    assert.equal(httpFailure.body.code, 'PROVIDER_HTTP_ERROR');

    const nonJson = await approvedFailure(win, 'b11-provider-non-json', 502, 'PROVIDER_INVALID_JSON');
    const forgedEvidence = await approvedFailure(win, 'b11-forged-evidence', 502, 'EVIDENCE_UNIT_NOT_ALLOWED');
    const timeoutStartedAt = Date.now();
    const timeout = await approvedFailure(win, 'b11-timeout', 504, 'REQUEST_TIMEOUT');
    const timeoutElapsedMs = Date.now() - timeoutStartedAt;
    assert.ok(timeoutElapsedMs >= 4_800, `timeout returned too early: ${timeoutElapsedMs}ms`);
    assert.ok(timeoutElapsedMs < 15_000, `timeout returned too late: ${timeoutElapsedMs}ms`);
    await delay(2_000);

    assert.equal(confirmationQueue.remaining(), 0);
    assert.equal(wasSecretInjected(), true, 'the test-only deterministic approval secret was not injected');
    return {
      ok: true,
      evidence_level: 'E4',
      synthetic_data_only: true,
      external_provider: providerBaseUrl,
      provider_transport: 'direct-https',
      pii: {
        raw_tokens_absent_from_preview: true,
        mask_preserves_evidence_offsets: true,
        covered_types: ['mobile', 'email', 'identity_card', 'wechat_identifier'],
      },
      native_confirmation: {
        contract: 'Electron dialog.showMessageBox',
        approvals: 4,
        remaining: confirmationQueue.remaining(),
      },
      preview_hash_mismatch: {
        status: mismatch.status,
        code: mismatch.body.code,
        same_approval_succeeded_at_transport_boundary: httpFailure.body.code === 'PROVIDER_HTTP_ERROR',
      },
      failure_matrix: [
        {
          request_id: httpPreview.requestId,
          status: httpFailure.status,
          code: httpFailure.body.code,
          path: httpFailure.body.path,
          error: httpFailure.body.error,
        },
        nonJson.result,
        forgedEvidence.result,
        { ...timeout.result, elapsed_ms: timeoutElapsedMs },
      ],
      previews: [httpPreview, nonJson.preview, forgedEvidence.preview, timeout.preview],
    };
  }

  app.whenReady().then(async () => {
    let result;
    try {
      result = await runJourney();
    } catch (error) {
      result = {
        ok: false,
        error: error && error.stack ? error.stack : String(error),
        native_confirmations_remaining: confirmationQueue.remaining(),
        f009_secret_injected: wasSecretInjected(),
      };
    }
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(resultPath, 0o600);
    process.exitCode = result.ok ? 0 : 1;
    app.quit();
  });
}

module.exports = {
  installRuntimeController,
};
