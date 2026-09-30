'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installRuntimeController({
  app,
  BrowserWindow,
  syntheticRoot,
  selectionQueue,
  telemetry,
}) {
  const resultPath = path.join(syntheticRoot, 'runtime-result.json');
  const evidenceDir = path.join(syntheticRoot, 'evidence');

  async function waitForWindow(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const win = BrowserWindow.getAllWindows().find((item) => !item.isDestroyed());
      if (win) return win;
      await delay(100);
    }
    throw new Error('timed out waiting for the HRBOSS main window');
  }

  async function evaluate(win, source) {
    return win.webContents.executeJavaScript(source, true);
  }

  async function waitFor(win, expression, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    while (Date.now() < deadline) {
      try {
        if (await evaluate(win, `Boolean(${expression})`)) return;
      } catch (error) {
        lastError = error.message;
      }
      await delay(120);
    }
    throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError}` : ''}`);
  }

  async function clickExact(win, selector, text) {
    const clicked = await evaluate(win, `(() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.offsetParent !== null && (element.textContent || '').trim() === ${JSON.stringify(text)});
      if (!target) return false;
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      target.focus();
      target.click();
      return true;
    })()`);
    assert.equal(clicked, true, `missing visible clickable text: ${text}`);
  }

  async function clickContaining(win, selector, text) {
    const clicked = await evaluate(win, `(() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.offsetParent !== null && (element.textContent || '').includes(${JSON.stringify(text)}));
      if (!target) return false;
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      target.focus();
      target.click();
      return true;
    })()`);
    assert.equal(clicked, true, `missing visible clickable text containing: ${text}`);
  }

  async function nativeClickExact(win, selector, text) {
    const point = await evaluate(win, `(() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.offsetParent !== null && (element.textContent || '').trim() === ${JSON.stringify(text)});
      if (!target) return null;
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      target.focus();
      const rect = target.getBoundingClientRect();
      return {
        x: Math.round(rect.left + (rect.width / 2)),
        y: Math.round(rect.top + (rect.height / 2)),
      };
    })()`);
    assert.ok(point, `missing visible native-click target: ${text}`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    return point;
  }

  async function capture(win, name) {
    win.setMinimumSize(900, 650);
    win.setContentSize(1280, 800);
    await delay(180);
    const image = await win.webContents.capturePage();
    const target = path.join(evidenceDir, `${name}.png`);
    fs.writeFileSync(target, image.toPNG(), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
    return path.basename(target);
  }

  async function selectDomain(win, label) {
    await clickContaining(win, '.candidate-domain-navigation .ant-segmented-item', label);
    await waitFor(
      win,
      `document.querySelector('.candidate-domain-panel')?.getAttribute('aria-label') === ${JSON.stringify(`候选人${label}工作区`)}`,
      `${label} domain`,
    );
  }

  async function openInterviewPreparation(win) {
    await selectDomain(win, '面试');
    await waitFor(win, "Boolean(document.querySelector('.interview-review-panel'))", 'interview workbench', 60_000);
    await waitFor(win, "Boolean(document.querySelector('.interview-workflow-tabs .ant-tabs-tab-btn'))", 'interview tabs', 60_000);
    const point = await nativeClickExact(win, '.interview-workflow-tabs .ant-tabs-tab-btn', '面试准备');
    await delay(500);
    const tabState = await evaluate(win, `(() => {
      const tabs = [...document.querySelectorAll('.interview-workflow-tabs [role="tab"]')];
      const hit = document.elementFromPoint(${point.x}, ${point.y});
      return {
        tabs: tabs.map((element) => ({
          text: (element.textContent || '').trim(),
          selected: element.getAttribute('aria-selected'),
          disabled: element.getAttribute('aria-disabled'),
          rect: element.getBoundingClientRect().toJSON(),
        })),
        hit: hit ? {
          tag: hit.tagName,
          class_name: hit.className,
          text: (hit.textContent || '').trim(),
        } : null,
        dialogs: [...document.querySelectorAll('[role="dialog"]')]
          .filter((element) => element.offsetParent !== null)
          .map((element) => (element.textContent || '').trim().slice(0, 300)),
      };
    })()`);
    const preparationTab = tabState.tabs.find((item) => item.text.includes('面试准备'));
    assert.equal(
      preparationTab?.selected,
      'true',
      `native click must select interview preparation: ${JSON.stringify(tabState)}`,
    );
    await waitFor(win, "Boolean(document.querySelector('#interview-script-panel')?.offsetParent)", 'interview preparation panel');
  }

  async function runJourney() {
    const win = await waitForWindow();
    win.webContents.setBackgroundThrottling(false);
    win.setContentSize(1280, 800);
    win.show();
    win.focus();
    await waitFor(win, "document.readyState === 'complete' && Boolean(document.querySelector('#root'))", 'renderer load');
    await waitFor(win, "[...document.querySelectorAll('button.nav-item')].some((el) => (el.textContent || '').trim() === '候选人')", 'candidate navigation');
    await clickExact(win, 'button.nav-item', '候选人');
    await waitFor(win, "Boolean(document.querySelector('.candidate-card'))", 'candidate list', 60_000);
    await clickContaining(win, '.candidate-card', '合成简历候选人');
    await waitFor(win, "(document.querySelector('.candidate-focus-identity')?.textContent || '').includes('合成简历候选人')", 'selected synthetic candidate');

    await selectDomain(win, '测评');
    await waitFor(win, "[...document.querySelectorAll('.assessment-archive-panel button')].some((el) => (el.textContent || '').trim() === '批量导入 PDF' && !el.disabled)", 'assessment import readiness', 60_000);
    await clickExact(win, '.assessment-archive-panel button', '批量导入 PDF');
    await waitFor(win, "[...document.querySelectorAll('.ant-modal')].some((el) => el.offsetParent !== null && (el.textContent || '').includes('批量导入 PDF 测评报告'))", 'assessment import modal');
    const importContract = await evaluate(win, `(() => {
      const modal = [...document.querySelectorAll('.ant-modal')].find((element) => (
        element.offsetParent !== null && (element.textContent || '').includes('批量导入 PDF 测评报告')
      ));
      return {
        selected_type: modal?.querySelector('.ant-select-selection-item')?.textContent.trim() || '',
        assessment_date: modal?.querySelector('input[aria-label="批量导入测评日期"]')?.value || '',
        warning: modal?.textContent || '',
      };
    })()`);
    assert.equal(importContract.selected_type, '自动识别（推荐）');
    assert.equal(importContract.assessment_date, '');
    assert.match(importContract.warning, /逐份识别报告类型、受测者、日期和主要结论/);
    await clickExact(win, '.ant-modal-footer button', '选择 PDF（可多选）并导入');
    await waitFor(win, "[...document.querySelectorAll('.assessment-archive-panel button')].some((el) => (el.textContent || '').trim() === '人工确认绑定')", 'parsed pending assessment', 180_000);

    const parsedPanel = await evaluate(win, `(() => {
      const panel = document.querySelector('.assessment-archive-panel');
      return {
        text: panel?.textContent || '',
        has_manual_type_confirmation: [...(panel?.querySelectorAll('button') || [])]
          .some((button) => (button.textContent || '').trim() === '确认报告类型'),
      };
    })()`);
    assert.match(parsedPanel.text, /职业潜力报告/);
    assert.match(parsedPanel.text, /分析 ready/);
    assert.match(parsedPanel.text, /学习能力/);
    assert.match(parsedPanel.text, /合成简历候选人/);
    assert.equal(parsedPanel.has_manual_type_confirmation, false, 'automatic parser must classify the report without manual type correction');
    const parsedEvidence = await capture(win, 'B-10-auto-parsed-pending-binding-1280x800');

    await clickExact(win, '.assessment-archive-panel button', '人工确认绑定');
    await waitFor(win, "[...document.querySelectorAll('.assessment-archive-panel button')].some((el) => (el.textContent || '').trim() === '查看 PNG 预览')", 'active assessment binding', 60_000);
    const activeEvidence = await capture(win, 'B-10-hr-confirmed-active-binding-1280x800');

    await clickExact(win, '.assessment-archive-panel button', '查看 PNG 预览');
    await waitFor(
      win,
      "Boolean(document.querySelector('img[alt^=\"PDF 测评第\"]')?.complete && document.querySelector('img[alt^=\"PDF 测评第\"]')?.naturalWidth > 0)",
      'controlled PNG preview image',
      60_000,
    );
    const preview = await evaluate(win, `(() => {
      const image = document.querySelector('img[alt^="PDF 测评第"]');
      const modal = image?.closest('.ant-modal');
      return {
        title: modal?.querySelector('.ant-modal-title')?.textContent.trim() || '',
        alt: image?.getAttribute('alt') || '',
        natural_width: image?.naturalWidth || 0,
        natural_height: image?.naturalHeight || 0,
        pager: modal?.textContent || '',
      };
    })()`);
    assert.equal(preview.title, 'PDF 测评 PNG 预览');
    assert.equal(preview.alt, 'PDF 测评第 1 页栅格预览');
    assert.ok(preview.natural_width > 0 && preview.natural_height > 0);
    assert.match(preview.pager, /1 \/ 1/);
    const previewEvidence = await capture(win, 'B-10-controlled-png-preview-1280x800');
    const previewCloseClicked = await evaluate(win, `(() => {
      const modal = [...document.querySelectorAll('.ant-modal')]
        .find((element) => element.offsetParent !== null && (element.textContent || '').includes('PDF 测评 PNG 预览'));
      const close = modal?.querySelector('.ant-modal-close');
      if (!close) return false;
      close.click();
      return true;
    })()`);
    assert.equal(previewCloseClicked, true, 'the visible controlled preview must expose its close action');
    await waitFor(
      win,
      "![...document.querySelectorAll('.ant-modal')].some((element) => element.offsetParent !== null && (element.textContent || '').includes('PDF 测评 PNG 预览'))",
      'preview close',
    );

    await openInterviewPreparation(win);
    await waitFor(
      win,
      "[...document.querySelectorAll('.ant-card-head-title')].some((element) => element.offsetParent !== null && (element.textContent || '').trim() === '候选人测评核验题')",
      'assessment cross-validation card',
      60_000,
    );
    const beforeCrossValidation = await evaluate(win, `(() => {
      const title = [...document.querySelectorAll('.ant-card-head-title')]
        .find((element) => element.offsetParent !== null && (element.textContent || '').trim() === '候选人测评核验题');
      const card = title?.closest('.ant-card');
      const text = card?.textContent || '';
      return {
        visible: Boolean(card),
        text,
        questions: [...(card?.querySelectorAll('.ant-typography') || [])]
          .map((element) => (element.textContent || '').trim())
          .filter((value) => /^\\d+\\. 请举例说明/.test(value)),
      };
    })()`);
    assert.equal(beforeCrossValidation.visible, true);
    assert.match(beforeCrossValidation.text, /已读取 1 份 HR 确认测评报告/);
    assert.match(beforeCrossValidation.text, /本地报告提取的核验题/);
    assert.equal(beforeCrossValidation.questions.length, 3);
    assert.ok(beforeCrossValidation.questions.some((item) => item.includes('学习能力')));
    await evaluate(win, `(() => {
      const title = [...document.querySelectorAll('.ant-card-head-title')]
        .find((element) => element.offsetParent !== null && (element.textContent || '').trim() === '候选人测评核验题');
      title?.closest('.ant-card')?.scrollIntoView({ block: 'center', inline: 'nearest' });
    })()`);
    await delay(180);
    const beforeCrossValidationEvidence = await capture(win, 'B-10-interview-cross-validation-before-revoke-1280x800');

    await selectDomain(win, '测评');
    await waitFor(win, "[...document.querySelectorAll('.assessment-archive-panel button')].some((el) => (el.textContent || '').trim() === '撤销绑定')", 'assessment revoke action');
    await clickExact(win, '.assessment-archive-panel button', '撤销绑定');
    await waitFor(
      win,
      "[...document.querySelectorAll('.ant-modal-confirm')].some((element) => element.offsetParent !== null && (element.textContent || '').includes('确认撤销 PDF 测评报告绑定？'))",
      'explicit assessment revoke confirmation',
    );
    const revokeDialog = await evaluate(win, `(() => {
      const dialog = [...document.querySelectorAll('.ant-modal-confirm')]
        .find((element) => element.offsetParent !== null && (element.textContent || '').includes('确认撤销 PDF 测评报告绑定？'));
      return {
        title: dialog?.querySelector('.ant-modal-confirm-title')?.textContent.trim() || '',
        content: dialog?.querySelector('.ant-modal-confirm-content')?.textContent.trim() || '',
        buttons: [...(dialog?.querySelectorAll('button') || [])].map((button) => ({
          text: (button.textContent || '').replace(/\\s+/g, ''),
          danger: button.classList.contains('ant-btn-dangerous'),
        })),
      };
    })()`);
    assert.equal(revokeDialog.title, '确认撤销 PDF 测评报告绑定？');
    assert.match(revokeDialog.content, /不再作为当前候选人和岗位的有效测评参考/);
    assert.match(revokeDialog.content, /不会因此自动改变候选人评分或流程状态/);
    assert.deepEqual(revokeDialog.buttons.map((item) => item.text), ['取消', '确认撤销']);
    assert.equal(revokeDialog.buttons[1].danger, true);
    const revokeDialogEvidence = await capture(win, 'B-10-explicit-revoke-confirmation-1280x800');
    await clickExact(win, '.ant-modal-confirm button', '确认撤销');
    await waitFor(
      win,
      "(document.querySelector('.assessment-archive-panel')?.textContent || '').includes('绑定 revoked')",
      'revoked assessment binding',
      60_000,
    );
    const revokedPanel = await evaluate(win, `(() => {
      const panel = document.querySelector('.assessment-archive-panel');
      const text = panel?.textContent || '';
      const buttons = [...(panel?.querySelectorAll('button') || [])].map((button) => (button.textContent || '').trim());
      return { text, buttons };
    })()`);
    assert.match(revokedPanel.text, /生命周期 active/);
    assert.match(revokedPanel.text, /分析 ready/);
    assert.equal(revokedPanel.buttons.includes('查看 PNG 预览'), false);
    assert.equal(revokedPanel.buttons.includes('撤销绑定'), false);
    const revokedEvidence = await capture(win, 'B-10-revoked-archive-preserved-1280x800');

    const previewRequest = telemetry.assessmentRequests.find((item) => (
      item.method === 'POST' && item.request_path === '/assessment/preview' && item.response_preview?.preview_id
    ));
    assert.ok(previewRequest, 'preview creation must traverse the authenticated local API');
    const afterRevokePreview = await evaluate(win, `(async () => {
      const response = await window.localApi.request({
        service: 'action',
        method: 'GET',
        requestPath: ${JSON.stringify(`/assessment/preview/${previewRequest.response_preview.preview_id}/page/1`)},
        responseType: 'json',
      });
      return {
        status: response.status,
        code: response.body?.code || null,
        ok: response.body?.ok === true,
      };
    })()`);
    assert.equal(afterRevokePreview.status, 400);
    assert.equal(afterRevokePreview.ok, false);
    assert.equal(afterRevokePreview.code, 'ASSESSMENT_PREVIEW_TICKET_INVALID');

    await openInterviewPreparation(win);
    await delay(600);
    const afterCrossValidation = await evaluate(win, `(() => {
      const visibleCard = [...document.querySelectorAll('.ant-card-head-title')]
        .find((element) => element.offsetParent !== null && (element.textContent || '').trim() === '候选人测评核验题')
        ?.closest('.ant-card');
      return {
        visible: Boolean(visibleCard),
        body_has_confirmed_count: (document.body.textContent || '').includes('已读取 1 份 HR 确认测评报告'),
        preparation_loaded: Boolean(document.querySelector('#interview-script-panel')?.offsetParent),
      };
    })()`);
    assert.equal(afterCrossValidation.preparation_loaded, true);
    assert.equal(afterCrossValidation.visible, false);
    assert.equal(afterCrossValidation.body_has_confirmed_count, false);
    const afterCrossValidationEvidence = await capture(win, 'B-10-interview-cross-validation-after-revoke-1280x800');

    assert.equal(selectionQueue.remaining(), 0, 'the signed native assessment dialog result must be consumed exactly once');
    assert.equal(telemetry.importRequests.length, 1);
    assert.deepEqual(
      {
        response_ok: telemetry.importRequests[0].response_ok,
        selected_count: telemetry.importRequests[0].selected_count,
        succeeded: telemetry.importRequests[0].succeeded,
        failed: telemetry.importRequests[0].failed,
      },
      { response_ok: true, selected_count: 1, succeeded: 1, failed: 0 },
    );

    const confirmRequest = telemetry.assessmentRequests.find((item) => item.request_path === '/assessment/binding/confirm');
    const revokeRequest = telemetry.assessmentRequests.find((item) => item.request_path === '/assessment/binding/revoke');
    assert.ok(confirmRequest && revokeRequest);
    assert.equal(confirmRequest.response_status, 200);
    assert.equal(confirmRequest.body.expected_version, 1);
    assert.equal(confirmRequest.response_result.version, 2);
    assert.equal(revokeRequest.response_status, 200);
    assert.equal(revokeRequest.body.expected_version, 2);
    assert.equal(revokeRequest.response_result.version, 3);

    return {
      ok: true,
      evidence: [
        parsedEvidence,
        activeEvidence,
        previewEvidence,
        beforeCrossValidationEvidence,
        revokeDialogEvidence,
        revokedEvidence,
        afterCrossValidationEvidence,
      ],
      import_contract: importContract,
      parsing: {
        automatic_type_recognition: true,
        parsed_panel: parsedPanel,
      },
      binding: {
        confirm_expected_version: confirmRequest.body.expected_version,
        confirm_response_version: confirmRequest.response_result.version,
        revoke_dialog: revokeDialog,
        revoke_expected_version: revokeRequest.body.expected_version,
        revoke_response_version: revokeRequest.response_result.version,
        revoked_panel: revokedPanel,
      },
      preview: {
        ...preview,
        preview_id: previewRequest.response_preview.preview_id,
        after_revoke_status: afterRevokePreview.status,
        after_revoke_code: afterRevokePreview.code,
      },
      cross_validation: {
        before_revoke: beforeCrossValidation,
        after_revoke: afterCrossValidation,
      },
      telemetry,
      signed_dialog_entries_remaining: selectionQueue.remaining(),
    };
  }

  app.whenReady().then(async () => {
    let result;
    try {
      result = await runJourney();
    } catch (error) {
      result = {
        ok: false,
        error: [
          error && error.stack ? error.stack : String(error),
          `renderer console: ${JSON.stringify((telemetry.rendererConsole || []).slice(-20))}`,
        ].join('\n'),
        telemetry,
        signed_dialog_entries_remaining: selectionQueue.remaining(),
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
