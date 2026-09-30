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

  async function waitForRequest(requestPath, previousCount, label) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const rows = telemetry.reportRequests.filter((item) => item.request_path === requestPath);
      if (rows.length === previousCount + 1 && rows[previousCount].completed_at) {
        assert.equal(rows[previousCount].response_status, 200, `${label}: ${JSON.stringify(rows[previousCount])}`);
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
      return { clicked: Boolean(target), labels: [...document.querySelectorAll(${JSON.stringify(selector)})]
        .filter((element) => element.offsetParent !== null).map((element) => (element.textContent || '').trim()) };
    })()`);
    assert.equal(state.clicked, true, `missing visible control ${value}; labels=${JSON.stringify(state.labels)}`);
  }

  async function setControlValue(win, selector, value) {
    const changed = await evaluate(win, `(() => {
      const input = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.offsetParent !== null);
      if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return false;
      input.scrollIntoView({ block: 'center', inline: 'nearest' });
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

  async function chooseSelectOption(win, ariaLabel, optionText) {
    const opened = await evaluate(win, `(() => {
      const input = [...document.querySelectorAll(${JSON.stringify(`[aria-label="${ariaLabel}"]`)})]
        .find((element) => element.offsetParent !== null);
      if (!input) return false;
      const selector = input.closest('.ant-select')?.querySelector('.ant-select-selector') || input;
      selector.scrollIntoView({ block: 'center', inline: 'nearest' });
      selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
      selector.click();
      return true;
    })()`);
    assert.equal(opened, true, `missing select ${ariaLabel}`);
    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-select-dropdown')]
        .filter((element) => element.offsetParent !== null).at(-1)
        ?.textContent.includes(${JSON.stringify(optionText)})`,
      `${ariaLabel} option ${optionText}`,
    );
    const selected = await evaluate(win, `(() => {
      const dropdown = [...document.querySelectorAll('.ant-select-dropdown')]
        .filter((element) => element.offsetParent !== null).at(-1);
      const option = [...dropdown?.querySelectorAll('.ant-select-item-option') || []]
        .find((element) => element.offsetParent !== null && element.textContent.trim() === ${JSON.stringify(optionText)});
      if (!option) return false;
      option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
      option.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, buttons: 0 }));
      option.click();
      return true;
    })()`);
    assert.equal(selected, true, `could not select ${optionText} in ${ariaLabel}`);
    await waitFor(
      win,
      `(() => {
        const input = [...document.querySelectorAll(${JSON.stringify(`[aria-label="${ariaLabel}"]`)})]
          .find((element) => element.offsetParent !== null);
        return input?.closest('.ant-select')?.querySelector('.ant-select-selection-item')?.textContent.trim()
          === ${JSON.stringify(optionText)};
      })()`,
      `${ariaLabel} selected value ${optionText}`,
    );
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

  async function selectCandidate(win) {
    await setControlValue(win, 'input[aria-label="搜索候选人"]', seed.candidate_name);
    await waitFor(
      win,
      `[...document.querySelectorAll('.candidate-card .candidate-name')]
        .some((element) => element.textContent.trim() === ${JSON.stringify(seed.candidate_name)})`,
      'synthetic report review candidate',
    );
    await clickExactText(win, '.candidate-card .candidate-name', seed.candidate_name);
    await waitFor(
      win,
      `document.querySelector('.candidate-hero h2')?.textContent.trim() === ${JSON.stringify(seed.candidate_name)}`,
      'selected report review candidate',
    );
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
      "document.querySelector('.interview-session-only-card') && document.querySelector('textarea[aria-label=\"人工复盘摘要\"]')",
      'session-only structured report card',
      45_000,
    );

    const form = {
      summary: 'B-7 合成人工复盘：候选人具备交付经验，仍需人工核对关键事实。',
      hard_requirements: '[符合] 城市：可在上海到岗\n[待核实] 薪资：下一轮确认',
      competencies: '独立完成合成项目交付\n能说明复盘方法',
      motivation: '希望承担更完整的项目责任',
      risks: '团队规模信息需要复核',
      contradictions: '简历年限与口述年限存在合成差异',
      unknowns: '离职日期尚未确认',
      followups: '请补充最近一次项目的团队规模',
      facts: '所在城市：上海\n薪资期望：25k\n到岗时间：两周\n团队规模：8 人',
    };
    await setControlValue(win, 'textarea[aria-label="人工复盘摘要"]', form.summary);
    await setControlValue(win, 'textarea[aria-label="硬性条件核对"]', form.hard_requirements);
    await setControlValue(win, 'textarea[aria-label="胜任力证据"]', form.competencies);
    await setControlValue(win, 'textarea[aria-label="求职动机"]', form.motivation);
    await setControlValue(win, 'textarea[aria-label="风险与矛盾"]', form.risks);
    await setControlValue(win, 'textarea[aria-label="材料矛盾"]', form.contradictions);
    await setControlValue(win, 'textarea[aria-label="待核实事项"]', form.unknowns);
    await setControlValue(win, 'textarea[aria-label="下一轮追问"]', form.followups);
    await setControlValue(win, 'textarea[aria-label="关键事实"]', form.facts);
    const manualCount = telemetry.reportRequests.filter((item) => item.request_path === '/interview-report/manual').length;
    await clickExactText(win, 'button', '保存人工结构化草稿');
    const manualRequest = await waitForRequest('/interview-report/manual', manualCount, 'manual structured report save');
    assert.equal(manualRequest.body.sessionId, seed.session_id);
    assert.deepEqual(manualRequest.body.materialIds, seed.material_ids);
    assert.equal(manualRequest.body.expectedVersion, 0);

    await waitFor(
      win,
      `document.querySelector('.interview-session-only-card')?.textContent.includes(${JSON.stringify(form.summary)})
        && document.querySelector('.interview-confirmations')?.textContent.includes('0/4')
        && [...document.querySelectorAll('button')].some((element) => element.offsetParent !== null
          && element.textContent.trim() === '保存人工结构化草稿'
          && !element.disabled
          && !element.classList.contains('ant-btn-loading'))`,
      'completed manual report refresh with four pending facts',
      45_000,
    );
    await scrollTextIntoView(win, '.interview-session-only-card', form.summary);
    const manualScreenshot = await capture(win, 'B-7-manual-structured-draft-1280x800');

    await chooseSelectOption(win, '所在城市（第 1 项）确认状态', '已确认');
    await chooseSelectOption(win, '薪资期望（第 2 项）确认状态', '已修正');
    await setControlValue(
      win,
      'input[name="interview-review-confirmation-correction-fact.02"]',
      '26k（B-7 人工修正）',
    );
    await chooseSelectOption(win, '到岗时间（第 3 项）确认状态', '未知');
    await chooseSelectOption(win, '团队规模（第 4 项）确认状态', '废弃');
    const factCount = telemetry.reportRequests.filter((item) => item.request_path === '/interview-report/facts').length;
    await clickExactText(win, 'button', '保存确认项');
    await delay(600);
    if (telemetry.reportRequests.filter((item) => item.request_path === '/interview-report/facts').length === factCount) {
      const diagnostic = await evaluate(win, `(() => ({
        tags: [...document.querySelectorAll('.interview-confirmations .ant-tag')].map((element) => element.textContent.trim()),
        correction: document.querySelector('input[name="interview-review-confirmation-correction-fact.02"]')?.value || '',
        selects: [...document.querySelectorAll('.interview-confirmations .ant-select-selection-item')]
          .map((element) => element.textContent.trim()),
        messages: [...document.querySelectorAll('.ant-message-notice-content, .ant-alert-message')]
          .filter((element) => element.offsetParent !== null).map((element) => element.textContent.trim()),
        save_buttons: [...document.querySelectorAll('button')]
          .filter((element) => element.offsetParent !== null && /保存/.test(element.textContent || ''))
          .map((element) => ({
            text: element.textContent.trim(),
            disabled: element.disabled,
            loading: element.classList.contains('ant-btn-loading'),
          })),
      }))()`);
      throw new Error(`fact review click produced no request: ${JSON.stringify(diagnostic)}`);
    }
    const factRequest = await waitForRequest('/interview-report/facts', factCount, 'fact review save');
    assert.equal(factRequest.body.sessionId, seed.session_id);
    assert.equal(factRequest.body.expectedVersion, 1);
    assert.deepEqual(factRequest.body.items.map((item) => ({
      field_key: item.field_key,
      status: item.status,
      ...(item.corrected_value ? { corrected_value: item.corrected_value } : {}),
    })), [
      { field_key: 'fact.01', status: 'confirmed' },
      { field_key: 'fact.02', status: 'corrected', corrected_value: '26k（B-7 人工修正）' },
      { field_key: 'fact.03', status: 'unknown' },
      { field_key: 'fact.04', status: 'rejected' },
    ]);
    await waitFor(
      win,
      `document.querySelector('.interview-confirmations')?.textContent.includes('4/4')
        && [...document.querySelectorAll('button')].some((element) => element.offsetParent !== null
          && element.textContent.trim() === '人工确认报告' && !element.disabled)`,
      'all fact statuses saved while formal confirmation remains separate',
      45_000,
    );
    const factsState = await evaluate(win, `(() => ({
      progress: document.querySelector('.interview-confirmations .interview-section-title em')?.textContent.trim() || '',
      tags: [...document.querySelectorAll('.interview-confirmations .ant-tag')].map((element) => element.textContent.trim()),
      correction: document.querySelector('input[name="interview-review-confirmation-correction-fact.02"]')?.value || '',
      formal_confirmation_enabled: [...document.querySelectorAll('button')].some((element) => element.offsetParent !== null
        && element.textContent.trim() === '人工确认报告' && !element.disabled),
    }))()`);
    assert.equal(factsState.progress, '4/4');
    assert.deepEqual(factsState.tags, ['已确认', '已修正', '未知', '废弃']);
    assert.equal(factsState.correction, '26k（B-7 人工修正）');
    assert.equal(factsState.formal_confirmation_enabled, true);
    win.webContents.setZoomFactor(0.65);
    await delay(180);
    await scrollTextIntoView(win, '.interview-confirmations', '关键事实确认');
    const factsScreenshot = await capture(win, 'B-7-fact-review-four-statuses-1280x800');
    win.webContents.setZoomFactor(1);

    return {
      ok: true,
      evidence_level: 'E4',
      synthetic_data_only: true,
      runtime_boundary: 'real HRBOSS Electron + trusted preload + authenticated local API + SQLite',
      viewport: [1280, 800],
      manual_report_request: manualRequest,
      fact_review_request: factRequest,
      fact_review_ui: factsState,
      formal_confirmation_intentionally_deferred: true,
      screenshots: [manualScreenshot, factsScreenshot],
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
