'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  APPROVAL_TTL_MS,
  issueF009UserApproval,
} = require("../../../src/f009-user-approval");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installRuntimeController({
  app,
  BrowserWindow,
  syntheticRoot,
  confirmationQueue,
  f009ApprovalSecret,
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
          && window.externalAiApproval?.confirm
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

  async function analyze(win, currentPreview, userApproval) {
    return localPost(win, '/interview-report/llm/analyze', {
      sessionId: currentPreview.sessionId,
      materialIds: currentPreview.materialIds,
      requestHash: currentPreview.requestHash,
      expectedVersion: 0,
      requestId: currentPreview.requestId,
      userApproval,
    });
  }

  function approvalInput(currentPreview) {
    return {
      ...currentPreview,
      actor: 'local-primary-operator',
    };
  }

  async function nativeConfirm(win, currentPreview) {
    return invoke(
      win,
      `window.llmApproval.confirm(${JSON.stringify({ ...currentPreview, userConfirmed: true })})`,
    );
  }

  async function runJourney() {
    const win = await waitForWindow();
    await waitForBridge(win);
    const configure = await invoke(win, `window.llmCredential.configure(${JSON.stringify({
      provider: 'synthetic',
      baseUrl: providerBaseUrl,
      enabled: false,
      apiKey: 'synthetic-b2-api-key',
      model: '',
      timeoutMs: 30_000,
    })})`);
    assert.equal(configure.status, 200, JSON.stringify(configure.body));
    assert.equal(configure.body.config.enabled, false, 'saving credentials must not enable external AI');
    const models = await invoke(win, 'window.llmCredential.refreshModels()');
    assert.equal(models.status, 200, JSON.stringify(models.body));
    assert.deepEqual(models.body.models.map((item) => item.id), ['gpt-b2-synthetic']);
    const modelTest = await invoke(win, `window.llmCredential.testModel(${JSON.stringify({
      model: 'gpt-b2-synthetic',
    })})`);
    assert.equal(modelTest.status, 200, JSON.stringify(modelTest.body));
    assert.equal(modelTest.body.model.id, 'gpt-b2-synthetic');
    assert.equal(modelTest.body.model.verified, true);
    assert.equal(modelTest.body.config.enabled, false, 'a model test must not enable external AI');
    const configuredModel = await invoke(win, `window.llmCredential.configure(${JSON.stringify({
      enabled: true,
    })})`);
    assert.equal(configuredModel.status, 200, JSON.stringify(configuredModel.body));
    assert.equal(configuredModel.body.config.modelVerified, true);
    assert.equal(configuredModel.body.config.operational, true);

    const genericApprovalInput = {
      purpose: 'job-jd-optimization',
      targetId: String(seed.job_id),
      materialInput: {
        brief: 'B-2 合成 JD 原生预览，只用于验证发送文本、排除项、模型和字符数。',
        currentJd: '负责合成验证；不含任何真实候选人材料。',
      },
    };
    const genericCanceled = await invoke(
      win,
      `window.externalAiApproval.confirm(${JSON.stringify({
        ...genericApprovalInput,
        requestId: 'b2-generic-native-cancel',
      })})`,
    );
    assert.deepEqual(genericCanceled, { ok: true, approved: false });
    const genericApproved = await invoke(
      win,
      `window.externalAiApproval.confirm(${JSON.stringify({
        ...genericApprovalInput,
        requestId: 'b2-generic-native-approve',
      })})`,
    );
    assert.equal(genericApproved.ok, true);
    assert.equal(genericApproved.approved, true);
    assert.ok(genericApproved.userApproval);

    const firstPreview = await preview(win, 'b2-native-preview-cancel');
    assert.equal(JSON.stringify(firstPreview).includes('13812345678'), false);
    assert.equal(JSON.stringify(firstPreview).includes('synthetic@example.test'), false);

    const invalidCases = [];
    const empty = await analyze(win, firstPreview, '');
    invalidCases.push({ case: 'empty', status: empty.status, code: empty.body.code });
    const forgedToken = issueF009UserApproval('b'.repeat(64), approvalInput(firstPreview));
    const forged = await analyze(win, firstPreview, forgedToken);
    invalidCases.push({ case: 'forged_signature', status: forged.status, code: forged.body.code });
    const expiredToken = issueF009UserApproval(f009ApprovalSecret, approvalInput(firstPreview), {
      nowMs: Date.now() - APPROVAL_TTL_MS - 1_000,
    });
    const expired = await analyze(win, firstPreview, expiredToken);
    invalidCases.push({ case: 'expired', status: expired.status, code: expired.body.code });
    invalidCases.forEach((item) => {
      assert.equal(item.status, 403, JSON.stringify(item));
      assert.equal(item.code, 'EXTERNAL_AI_CONFIRMATION_REQUIRED', JSON.stringify(item));
    });

    const canceled = await nativeConfirm(win, firstPreview);
    assert.deepEqual(canceled, { ok: true, approved: false });

    const successPreview = await preview(win, 'b2-native-preview-success');
    const approved = await nativeConfirm(win, successPreview);
    assert.equal(approved.ok, true);
    assert.equal(approved.approved, true);
    assert.ok(approved.userApproval);

    const mismatched = await analyze(win, firstPreview, approved.userApproval);
    assert.equal(mismatched.status, 403, JSON.stringify(mismatched.body));
    assert.equal(mismatched.body.code, 'EXTERNAL_AI_CONFIRMATION_REQUIRED');

    const success = await analyze(win, successPreview, approved.userApproval);
    assert.equal(success.status, 200, JSON.stringify(success.body));
    assert.equal(success.body.ok, true);
    assert.equal(success.body.audit.status, 'draft_saved');

    const replay = await analyze(win, successPreview, approved.userApproval);
    assert.equal(replay.status, 403, JSON.stringify(replay.body));
    assert.equal(replay.body.code, 'EXTERNAL_AI_CONFIRMATION_REQUIRED');

    assert.equal(confirmationQueue.remaining(), 0);
    assert.equal(wasSecretInjected(), true, 'the test-only deterministic approval secret was not injected');
    return {
      ok: true,
      evidence_level: 'E4',
      synthetic_data_only: true,
      external_provider: providerBaseUrl,
      provider_transport: 'direct-https',
      native_confirmation: {
        contract: 'Electron dialog.showMessageBox',
        signed_responses: ['generic-cancel', 'generic-approve', 'interview-cancel', 'interview-approve'],
        remaining: confirmationQueue.remaining(),
      },
      generic_native_confirmation: {
        canceled: genericCanceled.approved === false,
        approved: genericApproved.approved === true && Boolean(genericApproved.userApproval),
        preview_fields: ['actual_text', 'exclusions', 'model', 'character_count'],
      },
      rejected_before_provider: invalidCases,
      canceled_without_token: canceled.approved === false && !canceled.userApproval,
      mismatched_preview: {
        status: mismatched.status,
        code: mismatched.body.code,
      },
      replay: {
        status: replay.status,
        code: replay.body.code,
      },
      success_preview: successPreview,
      success: {
        status: success.status,
        audit_status: success.body.audit.status,
        report_status: success.body.report.status,
      },
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
