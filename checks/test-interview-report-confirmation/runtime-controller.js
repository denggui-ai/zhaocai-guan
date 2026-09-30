'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installRuntimeController({ app, BrowserWindow, syntheticRoot, telemetry }) {
  const resultPath = path.join(syntheticRoot, 'runtime-result.json');
  const evidenceDir = path.join(syntheticRoot, 'evidence');
  const seed = JSON.parse(fs.readFileSync(path.join(syntheticRoot, 'seed.json'), 'utf8'));

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
    while (Date.now() < deadline) {
      try {
        if (await evaluate(win, `Boolean(${expression})`)) return;
      } catch {}
      await delay(100);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async function waitForRequest(requestPath, previousCount, label, expectedStatus) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const rows = telemetry.reportRequests.filter((item) => item.request_path === requestPath);
      if (rows.length === previousCount + 1 && rows[previousCount].completed_at) {
        assert.equal(
          rows[previousCount].response_status,
          expectedStatus,
          `${label}: ${JSON.stringify(rows[previousCount])}`,
        );
        return rows[previousCount];
      }
      await delay(50);
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  async function clickExactText(win, selector, value) {
    const state = await evaluate(win, `(() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.offsetParent !== null && (element.textContent || '').trim() === ${JSON.stringify(value)});
      if (target) {
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
        target.focus();
        target.click();
      }
      return {
        clicked: Boolean(target),
        labels: [...document.querySelectorAll(${JSON.stringify(selector)})]
          .filter((element) => element.offsetParent !== null)
          .map((element) => (element.textContent || '').trim()),
      };
    })()`);
    assert.equal(state.clicked, true, `missing visible control ${value}; labels=${JSON.stringify(state.labels)}`);
  }

  async function setControlValue(win, selector, value) {
    const changed = await evaluate(win, `(() => {
      const input = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.offsetParent !== null);
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return false;
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (!setter) return false;
      input.focus();
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(value)} }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value === ${JSON.stringify(value)};
    })()`);
    assert.equal(changed, true, `could not set ${selector}`);
  }

  async function capture(win, name) {
    await delay(180);
    const image = await win.capturePage();
    const target = path.join(evidenceDir, `${name}.png`);
    fs.writeFileSync(target, image.toPNG(), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
    return path.basename(target);
  }

  async function scrollTextIntoView(win, selector, value) {
    const scrolled = await evaluate(win, `(() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.offsetParent !== null && element.textContent.includes(${JSON.stringify(value)}));
      target?.scrollIntoView({ block: 'start', inline: 'nearest' });
      return Boolean(target);
    })()`);
    assert.equal(scrolled, true, `could not scroll ${value} into view`);
    await delay(120);
  }

  async function localPost(win, requestPath, body) {
    return evaluate(win, `(async () => window.localApi.request(${JSON.stringify({
      service: 'action',
      method: 'POST',
      requestPath,
      body,
    })}))()`);
  }

  async function selectCandidate(win) {
    await setControlValue(win, 'input[aria-label="搜索候选人"]', seed.candidate_name);
    await waitFor(
      win,
      `[...document.querySelectorAll('.candidate-card .candidate-name')]
        .some((element) => element.textContent.trim() === ${JSON.stringify(seed.candidate_name)})`,
      'synthetic report confirmation candidate',
    );
    await clickExactText(win, '.candidate-card .candidate-name', seed.candidate_name);
    await waitFor(
      win,
      `document.querySelector('.candidate-hero h2')?.textContent.trim() === ${JSON.stringify(seed.candidate_name)}`,
      'selected report confirmation candidate',
    );
  }

  async function reportUiState(win) {
    return evaluate(win, `(() => {
      const card = document.querySelector('.interview-session-only-card');
      const confirmButton = [...card?.querySelectorAll('button') || []]
        .find((element) => element.textContent.trim() === '人工确认报告');
      const structured = [...card?.querySelectorAll('textarea') || []]
        .filter((element) => [
          '人工复盘摘要', '硬性条件核对', '胜任力证据', '求职动机', '风险与矛盾',
          '材料矛盾', '待核实事项', '下一轮追问', '关键事实',
        ].includes(element.getAttribute('aria-label')));
      const statusSelects = [...card?.querySelectorAll('.interview-confirmations .ant-select') || []];
      const correctionInputs = [...card?.querySelectorAll('input[name^="interview-review-confirmation-correction-"]') || []];
      const saveFacts = [...card?.querySelectorAll('button') || []]
        .find((element) => element.textContent.trim() === '保存确认项');
      const structuredSave = [...card?.querySelectorAll('button') || []]
        .find((element) => element.textContent.trim() === '保存人工结构化草稿');
      const advanced = [...card?.querySelectorAll('button') || []]
        .find((element) => element.textContent.trim() === '打开高级 JSON');
      const ai = [...card?.querySelectorAll('button') || []]
        .find((element) => element.textContent.trim() === '生成 AI 草稿（可选）');
      return {
        viewport: [innerWidth, innerHeight],
        report_text: card?.textContent || '',
        fact_progress: card?.querySelector('.interview-confirmations .interview-section-title em')?.textContent.trim() || '',
        fact_tags: [...card?.querySelectorAll('.interview-confirmations .ant-tag') || []]
          .map((element) => element.textContent.trim()),
        correction: card?.querySelector('input[name="interview-review-confirmation-correction-fact.01"]')?.value || '',
        confirm_button: confirmButton ? { disabled: confirmButton.disabled, text: confirmButton.textContent.trim() } : null,
        structured_textarea_count: structured.length,
        structured_textareas_disabled: structured.every((element) => element.disabled),
        status_select_count: statusSelects.length,
        status_selects_disabled: statusSelects.every((element) => element.classList.contains('ant-select-disabled')),
        correction_input_count: correctionInputs.length,
        correction_inputs_disabled: correctionInputs.every((element) => element.disabled),
        save_facts_disabled: saveFacts?.disabled ?? null,
        structured_save_disabled: structuredSave?.disabled ?? null,
        advanced_json_disabled: advanced?.disabled ?? null,
        ai_disabled: ai?.disabled ?? null,
      };
    })()`);
  }

  function databaseSeparationState() {
    const db = require('../../db');
    const database = db.conn();
    function count(tableName, where, params) {
      const exists = database.prepare(`
        SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(tableName);
      assert.ok(exists, `${tableName} schema must exist before formal confirmation`);
      return database.prepare(`SELECT COUNT(*) AS n FROM ${tableName} ${where}`).get(...params).n;
    }
    const candidate = db.getCandidate(seed.candidate_id);
    return {
      captured_immediately_before_ui_confirmation: true,
      candidate: {
        disposition_code: candidate.disposition_code,
        disposition_status: candidate.disposition_status,
        workflow_version: candidate.workflow_version,
      },
      counts: {
        application_episode_count: count(
          'application_episode',
          'WHERE candidate_id = ? AND job_id = ?',
          [seed.candidate_id, seed.job_id],
        ),
        final_review_count: count(
          'final_review',
          `WHERE application_id IN (
            SELECT id FROM application_episode WHERE candidate_id = ? AND job_id = ?
          )`,
          [seed.candidate_id, seed.job_id],
        ),
        final_disposition_count: count(
          'final_disposition',
          `WHERE application_id IN (
            SELECT id FROM application_episode WHERE candidate_id = ? AND job_id = ?
          )`,
          [seed.candidate_id, seed.job_id],
        ),
      },
    };
  }

  async function runJourney() {
    const win = await waitForWindow();
    win.webContents.setBackgroundThrottling(false);
    win.setContentSize(1280, 800);
    win.show();
    win.focus();
    await waitFor(win, "Boolean(window.localApi?.request)", 'trusted local API bridge', 45_000);
    await waitFor(win, "document.querySelector('button.nav-item')", 'main navigation', 45_000);
    await clickExactText(win, 'button.nav-item', '候选人');
    await waitFor(win, "document.querySelector('input[aria-label=\"搜索候选人\"]')", 'candidate workspace', 45_000);
    await selectCandidate(win);
    await clickExactText(win, '.candidate-domain-option strong', '面试');
    await waitFor(
      win,
      `document.querySelector('.interview-session-only-card')
        && document.querySelector('.interview-confirmations')?.textContent.includes('3/3')
        && [...document.querySelectorAll('button')].some((element) => element.offsetParent !== null
          && element.textContent.trim() === '人工确认报告' && !element.disabled)`,
      'reviewed report ready for explicit confirmation',
      45_000,
    );

    const before = await reportUiState(win);
    assert.deepEqual(before.viewport, [1280, 800]);
    assert.equal(before.fact_progress, '3/3');
    assert.deepEqual(before.fact_tags, ['已修正', '未知', '废弃']);
    assert.equal(before.correction, seed.expected.corrected_value);
    assert.deepEqual(before.confirm_button, { disabled: false, text: '人工确认报告' });
    win.webContents.setZoomFactor(0.7);
    await scrollTextIntoView(win, '.interview-session-only-card', seed.expected.summary);
    const beforeScreenshot = await capture(win, 'B-9-reviewed-report-before-confirmation-1280x800');
    win.webContents.setZoomFactor(1);

    const separationBefore = databaseSeparationState();
    assert.deepEqual(separationBefore.candidate, seed.candidate_before);
    fs.writeFileSync(
      path.join(syntheticRoot, 'separation-before.json'),
      `${JSON.stringify(separationBefore, null, 2)}\n`,
      { mode: 0o600 },
    );
    if (process.platform !== 'win32') {
      fs.chmodSync(path.join(syntheticRoot, 'separation-before.json'), 0o600);
    }
    const confirmCount = telemetry.reportRequests.filter((item) => item.request_path === '/interview-report/confirm').length;
    await clickExactText(win, 'button', '人工确认报告');
    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-modal-confirm-title')]
        .some((element) => element.offsetParent !== null && element.textContent.trim() === '确认正式归档这份面试报告？')`,
      'explicit formal archive confirmation dialog',
    );
    const dialog = await evaluate(win, `(() => {
      const modal = [...document.querySelectorAll('.ant-modal-confirm')]
        .find((element) => element.offsetParent !== null);
      return {
        title: modal?.querySelector('.ant-modal-confirm-title')?.textContent.trim() || '',
        content: modal?.querySelector('.ant-modal-confirm-content')?.textContent.replace(/\\s+/g, ' ').trim() || '',
        buttons: [...modal?.querySelectorAll('button') || []].map((element) => ({
          text: element.textContent.trim(),
          danger: element.classList.contains('ant-btn-dangerous'),
        })),
      };
    })()`);
    assert.equal(dialog.title, '确认正式归档这份面试报告？');
    assert.match(dialog.content, new RegExp(seed.candidate_name));
    assert.match(dialog.content, new RegExp(`岗位：ID ${seed.job_id}`));
    assert.match(dialog.content, /第 1 轮/);
    assert.match(dialog.content, /后续修改需走新版本/);
    assert.deepEqual(dialog.buttons.map((item) => item.text), ['取消', '确认并正式归档']);
    assert.equal(dialog.buttons[1].danger, true);
    const dialogScreenshot = await capture(win, 'B-9-explicit-confirmation-dialog-1280x800');
    await clickExactText(win, '.ant-modal-confirm button', '确认并正式归档');
    const confirmRequest = await waitForRequest(
      '/interview-report/confirm',
      confirmCount,
      'formal report confirmation',
      200,
    );
    assert.equal(confirmRequest.body.sessionId, seed.session_id);
    assert.equal(confirmRequest.body.expectedVersion, 2);
    assert.equal(confirmRequest.body.confirmed, true);
    assert.match(confirmRequest.body.requestId, /^ui-session-report-confirm-/);
    assert.equal(confirmRequest.response_report_status, 'confirmed');
    assert.equal(confirmRequest.response_report_version, 3);

    await waitFor(
      win,
      `(() => {
        const card = document.querySelector('.interview-session-only-card');
        const confirmedTags = [...card?.querySelectorAll('.ant-tag') || []]
          .filter((element) => element.textContent.trim() === '已确认');
        const button = [...card?.querySelectorAll('button') || []]
          .find((element) => element.textContent.trim() === '人工确认报告');
        return confirmedTags.length >= 2 && button?.disabled;
      })()`,
      'confirmed report reloaded as read-only archive',
      45_000,
    );
    await clickExactText(win, '.ant-collapse-header-text', '高级 JSON 导入 / 调试');
    await waitFor(
      win,
      `[...document.querySelectorAll('.interview-session-only-card button')]
        .some((element) => element.textContent.trim() === '打开高级 JSON' && element.disabled)`,
      'advanced JSON entry locked after confirmation',
    );
    const after = await reportUiState(win);
    assert.deepEqual(after.viewport, [1280, 800]);
    assert.equal(after.fact_progress, '3/3');
    assert.deepEqual(after.fact_tags, ['已修正', '未知', '废弃']);
    assert.equal(after.structured_textarea_count, 9);
    assert.equal(after.structured_textareas_disabled, true);
    assert.equal(after.status_select_count, 3);
    assert.equal(after.status_selects_disabled, true);
    assert.equal(after.correction_input_count, 3);
    assert.equal(after.correction_inputs_disabled, true);
    assert.equal(after.confirm_button.disabled, true);
    assert.equal(after.save_facts_disabled, true);
    assert.equal(after.structured_save_disabled, true);
    assert.equal(after.advanced_json_disabled, true);
    assert.equal(after.ai_disabled, true);

    win.webContents.setZoomFactor(0.65);
    await scrollTextIntoView(win, '.interview-session-only-card', seed.expected.summary);
    const archiveScreenshot = await capture(win, 'B-9-confirmed-read-only-archive-1280x800');
    await scrollTextIntoView(win, '.interview-confirmations', '关键事实确认');
    const projectionScreenshot = await capture(win, 'B-9-confirmed-projection-fact-audit-1280x800');
    win.webContents.setZoomFactor(1);

    const bypassCount = telemetry.reportRequests.filter((item) => item.request_path === '/interview-report/manual').length;
    const bypassResponse = await localPost(win, '/interview-report/manual', {
      sessionId: seed.session_id,
      materialIds: seed.material_ids,
      form: {
        summary: 'B-9 确认后绕过 UI 的写入不得成功。',
        keyFacts: [{ label: '到岗周期', value: '一天' }],
      },
      expectedVersion: 3,
      requestId: 'b9-readonly-bypass-must-not-persist',
    });
    const bypassRequest = await waitForRequest(
      '/interview-report/manual',
      bypassCount,
      'post-confirm read-only API rejection',
      400,
    );
    assert.equal(bypassResponse.status, 400);
    assert.equal(bypassResponse.body.code, 'REPORT_READ_ONLY');
    assert.equal(bypassRequest.response_code, 'REPORT_READ_ONLY');

    return {
      ok: true,
      evidence_level: 'E4',
      synthetic_data_only: true,
      runtime_boundary: 'real HRBOSS Electron + trusted preload + authenticated local API + SQLite',
      viewport: [1280, 800],
      separation_baseline: separationBefore,
      confirmation_dialog: dialog,
      confirmation_request: confirmRequest,
      ui_before_confirmation: before,
      ui_after_confirmation: after,
      post_confirmation_bypass: {
        response_status: bypassResponse.status,
        response_code: bypassResponse.body.code,
        request: bypassRequest,
      },
      screenshots: [
        beforeScreenshot,
        dialogScreenshot,
        archiveScreenshot,
        projectionScreenshot,
      ],
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
        telemetry,
      };
    }
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(resultPath, 0o600);
    process.exitCode = result.ok ? 0 : 1;
    app.quit();
  });
}

module.exports = { installRuntimeController };
