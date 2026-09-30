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

  async function waitForTelemetry(rows, previousCount, label, expectedStatus) {
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
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
      'synthetic version conflict candidate',
    );
    await clickExactText(win, '.candidate-card .candidate-name', seed.candidate_name);
    await waitFor(
      win,
      `document.querySelector('.candidate-hero h2')?.textContent.trim() === ${JSON.stringify(seed.candidate_name)}`,
      'selected version conflict candidate',
    );
  }

  function injectCompetingReportWrite() {
    const db = require("../../../src/db");
    db.openDb(process.env.BOSS_DB_PATH);
    const current = db.getInterviewReportV1({ sessionId: seed.session_id });
    assert.equal(current.version, 1);
    const competingReport = JSON.parse(JSON.stringify(current.report));
    competingReport.summary.text = seed.expected.competing_summary;
    const written = db.saveInterviewReportV1({
      sessionId: seed.session_id,
      report: competingReport,
      sourceMaterialIds: current.source_snapshot.material_ids,
      expectedVersion: 1,
      requestId: 'b8-competing-report-v2',
      actor: 'b8-synthetic-competing-operator',
    });
    assert.equal(written.version, 2);
    const facts = db.listInterviewReportFactReviews({ sessionId: seed.session_id });
    assert.ok(facts.every((item) => item.status === 'pending_review'));
    const requestCount = db.conn().prepare(`
      SELECT COUNT(*) AS n
      FROM interview_report_action_request
      WHERE session_id = ?
    `).get(seed.session_id).n;
    assert.equal(requestCount, 2);
    const evidence = {
      injected_by_test_only_main_process: true,
      before_version: 1,
      after_version: written.version,
      actor: written.updated_by,
      summary: written.report.summary.text,
      pending_fact_count: facts.length,
      persisted_action_count: requestCount,
    };
    telemetry.concurrentWrites.push(evidence);
    return evidence;
  }

  function databaseState(label) {
    const db = require("../../../src/db");
    const report = db.getInterviewReportV1({ sessionId: seed.session_id });
    const facts = db.listInterviewReportFactReviews({ sessionId: seed.session_id });
    const requests = db.conn().prepare(`
      SELECT request_id, action, response_version, response_status, actor
      FROM interview_report_action_request
      WHERE session_id = ?
      ORDER BY response_version
    `).all(seed.session_id);
    return {
      label,
      report_version: report.version,
      report_status: report.status,
      report_summary: report.report.summary.text,
      fact_statuses: facts.map((item) => item.status),
      corrected_values: facts.map((item) => item.corrected_value),
      persisted_requests: requests,
    };
  }

  async function factUiState(win) {
    return evaluate(win, `(() => ({
      progress: document.querySelector('.interview-confirmations .interview-section-title em')?.textContent.trim() || '',
      tags: [...document.querySelectorAll('.interview-confirmations .ant-tag')].map((element) => element.textContent.trim()),
      correction: document.querySelector('input[name="interview-review-confirmation-correction-fact.01"]')?.value || '',
      conflict: [...document.querySelectorAll('.ant-alert')]
        .some((element) => element.offsetParent !== null && element.textContent.includes('面试数据版本冲突')),
      recovered: [...document.querySelectorAll('.ant-alert')]
        .some((element) => element.offsetParent !== null && element.textContent.includes('已重新读取服务端最新版本')),
    }))()`);
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
        && document.querySelector('.interview-confirmations')?.textContent.includes('0/2')
        && document.querySelector('.interview-session-only-card')?.textContent.includes(${JSON.stringify(seed.expected.initial_summary)})`,
      'initial report v1 with two pending facts',
      45_000,
    );

    await chooseSelectOption(win, '到岗时间（第 1 项）确认状态', '已修正');
    await setControlValue(
      win,
      'input[name="interview-review-confirmation-correction-fact.01"]',
      seed.expected.correction,
    );
    await waitFor(
      win,
      `document.querySelector('input[name="interview-review-confirmation-correction-fact.01"]')?.value
          === ${JSON.stringify(seed.expected.correction)}
        && document.querySelector('.interview-confirmations .ant-tag')?.textContent.trim() === '已修正'`,
      'local corrected fact draft',
    );
    const localBeforeConflict = await factUiState(win);
    assert.equal(localBeforeConflict.correction, seed.expected.correction);
    assert.deepEqual(localBeforeConflict.tags, ['已修正', '待确认']);

    const competingWrite = injectCompetingReportWrite();
    const beforeStaleSubmit = databaseState('before_stale_submit');
    assert.equal(beforeStaleSubmit.report_version, 2);
    assert.deepEqual(beforeStaleSubmit.fact_statuses, ['pending_review', 'pending_review']);
    assert.equal(beforeStaleSubmit.persisted_requests.length, 2);

    const staleCount = telemetry.reportRequests.length;
    await clickExactText(win, 'button', '保存确认项');
    const staleRequest = await waitForTelemetry(
      telemetry.reportRequests,
      staleCount,
      'stale fact review rejection',
      409,
    );
    assert.equal(staleRequest.response_code, 'STALE_VERSION');
    assert.equal(staleRequest.body.sessionId, seed.session_id);
    assert.equal(staleRequest.body.expectedVersion, 1);
    assert.deepEqual(staleRequest.body.items.map((item) => ({
      field_key: item.field_key,
      status: item.status,
      ...(item.corrected_value ? { corrected_value: item.corrected_value } : {}),
    })), [
      { field_key: 'fact.01', status: 'corrected', corrected_value: seed.expected.correction },
    ]);
    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-alert')]
        .some((element) => element.offsetParent !== null
          && element.textContent.includes('面试数据版本冲突，本次操作未写入')
          && element.textContent.includes('页面仍保留本地未保存修改'))`,
      'visible version conflict with local draft preservation',
      45_000,
    );
    const afterRejectedWrite = databaseState('after_stale_rejection');
    assert.equal(afterRejectedWrite.report_version, 2);
    assert.deepEqual(afterRejectedWrite.fact_statuses, ['pending_review', 'pending_review']);
    assert.equal(afterRejectedWrite.persisted_requests.length, 2, 'stale write must produce no partial action row');
    const localAfterRejection = await factUiState(win);
    assert.equal(localAfterRejection.correction, seed.expected.correction);
    assert.deepEqual(localAfterRejection.tags, ['已修正', '待确认']);
    assert.equal(localAfterRejection.conflict, true);

    await scrollTextIntoView(win, '.ant-alert', '面试数据版本冲突');
    const rejectedScreenshot = await capture(win, 'B-8-stale-version-rejected-1280x800');
    win.webContents.setZoomFactor(0.7);
    await delay(180);
    await scrollTextIntoView(win, '.interview-confirmations', '关键事实确认');
    const preservedScreenshot = await capture(win, 'B-8-local-draft-preserved-1280x800');
    win.webContents.setZoomFactor(1);

    const readCount = telemetry.reportReads.length;
    await clickExactText(win, 'button', '重新读取服务端版本');
    const refreshedRead = await waitForTelemetry(
      telemetry.reportReads,
      readCount,
      'latest report version refresh',
      200,
    );
    assert.equal(refreshedRead.report_version, 2);
    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-alert')]
        .some((element) => element.offsetParent !== null
          && element.textContent.includes('已重新读取服务端最新版本')
          && element.textContent.includes('本地未保存修改已保留'))
        && document.querySelector('input[name="interview-review-confirmation-correction-fact.01"]')?.value
          === ${JSON.stringify(seed.expected.correction)}
        && ![...document.querySelectorAll('button')].some((element) => element.classList.contains('ant-btn-loading'))`,
      'latest server version with local fact draft preserved',
      45_000,
    );
    const localAfterRefresh = await factUiState(win);
    assert.equal(localAfterRefresh.correction, seed.expected.correction);
    assert.deepEqual(localAfterRefresh.tags, ['已修正', '待确认']);
    assert.equal(localAfterRefresh.recovered, true);
    await scrollTextIntoView(win, '.ant-alert', '已重新读取服务端最新版本');
    const refreshedScreenshot = await capture(win, 'B-8-latest-version-reloaded-1280x800');

    const resubmitCount = telemetry.reportRequests.length;
    await clickExactText(win, 'button', '保存确认项');
    const resubmitRequest = await waitForTelemetry(
      telemetry.reportRequests,
      resubmitCount,
      'fact review resubmission with latest version',
      200,
    );
    assert.equal(resubmitRequest.body.sessionId, seed.session_id);
    assert.equal(resubmitRequest.body.expectedVersion, 2);
    assert.notEqual(resubmitRequest.body.requestId, staleRequest.body.requestId);
    await waitFor(
      win,
      `document.querySelector('.interview-confirmations')?.textContent.includes('1/2')
        && ![...document.querySelectorAll('.ant-alert')]
          .some((element) => element.offsetParent !== null
            && (element.textContent.includes('面试数据版本冲突')
              || element.textContent.includes('已重新读取服务端最新版本')))`,
      'successful latest-version resubmission',
      45_000,
    );
    const afterResubmit = databaseState('after_latest_version_resubmit');
    assert.equal(afterResubmit.report_version, 3);
    assert.deepEqual(afterResubmit.fact_statuses, ['corrected', 'pending_review']);
    assert.deepEqual(afterResubmit.corrected_values, [seed.expected.correction, null]);
    assert.equal(afterResubmit.persisted_requests.length, 3);
    assert.equal(
      afterResubmit.persisted_requests.some((item) => item.request_id === staleRequest.body.requestId),
      false,
    );
    win.webContents.setZoomFactor(0.7);
    await delay(180);
    await scrollTextIntoView(win, '.interview-confirmations', '关键事实确认');
    const resubmittedScreenshot = await capture(win, 'B-8-resubmitted-version-3-1280x800');
    win.webContents.setZoomFactor(1);

    return {
      ok: true,
      evidence_level: 'E4',
      synthetic_data_only: true,
      external_network_used: false,
      runtime_boundary: 'real HRBOSS Electron + trusted preload + authenticated local API + SQLite',
      conflict_injection_boundary: 'compile-time-excluded test main process performs one competing SQLite report write',
      viewport: [1280, 800],
      local_draft_before_conflict: localBeforeConflict,
      competing_write: competingWrite,
      stale_request: staleRequest,
      database_after_stale_rejection: afterRejectedWrite,
      local_draft_after_rejection: localAfterRejection,
      refresh_read: refreshedRead,
      local_draft_after_refresh: localAfterRefresh,
      resubmit_request: resubmitRequest,
      database_after_resubmit: afterResubmit,
      formal_confirmation_intentionally_deferred: true,
      screenshots: [
        rejectedScreenshot,
        preservedScreenshot,
        refreshedScreenshot,
        resubmittedScreenshot,
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
