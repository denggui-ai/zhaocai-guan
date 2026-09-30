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
  telemetry,
}) {
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

  async function waitForMain(predicate, label, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return;
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

  async function clickTextIncludes(win, selector, value) {
    const state = await evaluate(win, `(() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.offsetParent !== null && (element.textContent || '').includes(${JSON.stringify(value)}));
      if (target) {
        target.scrollIntoView({ block: 'center', inline: 'nearest' });
        target.focus();
        target.click();
      }
      return Boolean(target);
    })()`);
    assert.equal(state, true, `missing visible control containing ${value}`);
  }

  async function setSearch(win, value) {
    const changed = await evaluate(win, `(() => {
      const input = document.querySelector('input[aria-label="搜索候选人"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    assert.equal(changed, true, 'candidate search input must exist');
  }

  async function selectCandidate(win) {
    await setSearch(win, seed.candidate_name);
    await waitFor(
      win,
      `[...document.querySelectorAll('.candidate-card .candidate-name')]
        .some((element) => (element.textContent || '').trim() === ${JSON.stringify(seed.candidate_name)})`,
      'synthetic ASR candidate search result',
    );
    await clickExactText(win, '.candidate-card .candidate-name', seed.candidate_name);
    await waitFor(
      win,
      `document.querySelector('.candidate-hero h2')?.textContent.trim() === ${JSON.stringify(seed.candidate_name)}
        && document.querySelector('.candidate-card[aria-selected="true"] .candidate-name')?.textContent.trim() === ${JSON.stringify(seed.candidate_name)}`,
      'selected synthetic ASR candidate',
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
        .find((element) => element.offsetParent !== null && (element.textContent || '').includes(${JSON.stringify(value)}));
      target?.scrollIntoView({ block: 'start', inline: 'nearest' });
      return Boolean(target);
    })()`);
    assert.equal(scrolled, true, `could not scroll ${value} into view`);
    await delay(140);
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
    await waitFor(win, "document.querySelector('.interview-review-panel')", 'candidate interview workspace', 45_000);
    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-tabs-tab-btn')]
        .some((element) => element.offsetParent !== null && element.textContent.trim() === '录音与转写')`,
      'interview recording tab',
      45_000,
    );
    await clickExactText(win, '.ant-tabs-tab-btn', '录音与转写');

    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-alert')]
        .some((element) => element.offsetParent !== null && element.textContent.includes('转写失败，原录音已安全保留'))`,
      'retryable transcription failure',
      45_000,
    );
    await waitFor(
      win,
      `[...document.querySelectorAll('button')]
        .some((element) => element.offsetParent !== null
          && element.textContent.trim() === '重试转写'
          && !element.disabled)`,
      'enabled retry transcription action',
      45_000,
    );
    const failureState = await evaluate(win, `(() => {
      const alert = [...document.querySelectorAll('.ant-alert')]
        .find((element) => element.offsetParent !== null && element.textContent.includes('转写失败，原录音已安全保留'));
      const retry = [...document.querySelectorAll('button')]
        .find((element) => element.offsetParent !== null && element.textContent.trim() === '重试转写');
      const discard = [...document.querySelectorAll('button')]
        .find((element) => element.offsetParent !== null && element.textContent.trim() === '永久丢弃原录音');
      return {
        alert_text: alert?.textContent.trim() || '',
        retry_enabled: Boolean(retry && !retry.disabled),
        discard_enabled: Boolean(discard && !discard.disabled),
      };
    })()`);
    assert.equal(failureState.retry_enabled, true);
    assert.equal(failureState.discard_enabled, true);
    assert.ok(failureState.alert_text.includes('原录音已安全保留，可由 HR 手动重试转写或明确丢弃'));
    await scrollTextIntoView(win, '.ant-alert', '转写失败，原录音已安全保留');
    const failureScreenshot = await capture(win, 'B-6-asr-failure-preserved-1280x800');

    const previousRetryCount = telemetry.retryRequests.length;
    await clickExactText(win, 'button', '重试转写');
    await waitForMain(
      () => telemetry.retryRequests.length === previousRetryCount + 1
        && Boolean(telemetry.retryRequests[previousRetryCount].completed_at),
      'authenticated retry request',
      45_000,
    );
    const retryRequest = telemetry.retryRequests[previousRetryCount];
    assert.ok([200, 202].includes(retryRequest.response_status), JSON.stringify(retryRequest));
    assert.equal(retryRequest.body.taskId, seed.formal_job_id);
    assert.equal(retryRequest.body.candidateId, seed.candidate_id);
    assert.equal(Number(retryRequest.body.jobId), seed.job_id);
    assert.equal(Number(retryRequest.body.round), 1);

    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-alert')]
        .some((element) => element.offsetParent !== null && element.textContent.includes('录音与转写已归档到当前候选人'))`,
      'successful ASR retry archive',
      180_000,
    );
    await scrollTextIntoView(win, '.ant-alert', '录音与转写已归档到当前候选人');
    const successScreenshot = await capture(win, 'B-6-asr-retry-archived-1280x800');

    await clickExactText(win, 'button', '查看最新复盘');
    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-tabs-tab')]
        .some((element) => element.classList.contains('ant-tabs-tab-active')
          && element.textContent.includes('当前面试轮次'))`,
      'latest interview review tab',
      45_000,
    );
    await waitFor(
      win,
      `document.querySelector('.interview-session-timeline-item')
        && document.querySelector('.interview-session-timeline-item').textContent.includes('第 1 轮')`,
      'bound recording session review',
      45_000,
    );
    await waitFor(
      win,
      `![...document.querySelectorAll('[role="status"]')]
        .some((element) => element.offsetParent !== null && element.textContent.includes('正在刷新面试资料'))`,
      'latest review refresh completion',
      45_000,
    );
    await waitFor(
      win,
      `[...document.querySelectorAll('.interview-record-card')]
        .some((element) => element.offsetParent !== null && element.textContent.includes(${JSON.stringify(seed.topic)}))`,
      'bound recording review card',
      45_000,
    );
    await scrollTextIntoView(win, '.interview-record-card', seed.topic);
    const reviewScreenshot = await capture(win, 'B-6-latest-review-bound-1280x800');

    await clickTextIncludes(win, '.ant-tabs-tab-btn', '材料与历史');
    await waitFor(
      win,
      `[...document.querySelectorAll('.interview-evidence-collapse .ant-collapse-header-text')]
        .some((element) => element.offsetParent !== null && element.textContent.includes('ASR 转写草稿'))`,
      'ASR transcript evidence collapse',
      45_000,
    );
    await clickTextIncludes(win, '.interview-evidence-collapse .ant-collapse-header-text', 'ASR 转写草稿');
    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-alert')]
        .some((element) => element.offsetParent !== null && element.textContent.includes('段转写置信信号偏低'))`,
      'low confidence transcript warning',
      45_000,
    );
    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-tag')]
        .some((element) => element.offsetParent !== null && element.textContent.trim() === '低置信')`,
      'low confidence cue tag',
    );
    const transcriptState = await evaluate(win, `(() => {
      const warning = [...document.querySelectorAll('.ant-alert')]
        .find((element) => element.offsetParent !== null && element.textContent.includes('段转写置信信号偏低'));
      return {
        warning_text: warning?.textContent.trim() || '',
        cue_count: [...document.querySelectorAll('[aria-label="带时间戳的 ASR 转写 cue"] p')]
          .filter((element) => element.offsetParent !== null).length,
        low_confidence_tag_count: [...document.querySelectorAll('.ant-tag')]
          .filter((element) => element.offsetParent !== null && element.textContent.trim() === '低置信').length,
      };
    })()`);
    assert.ok(transcriptState.cue_count > 0);
    assert.ok(transcriptState.low_confidence_tag_count > 0);
    await scrollTextIntoView(win, '[aria-label="带时间戳的 ASR 转写 cue"] p', '低置信');
    const transcriptScreenshot = await capture(win, 'B-6-low-confidence-transcript-1280x800');

    assert.equal(telemetry.retryRequests.length, 1);
    return {
      ok: true,
      evidence_level: 'E4',
      synthetic_data_only: true,
      real_microphone_used: false,
      external_network_used: false,
      preparation_boundary: 'E2: local synthetic speech file + forced local ASR worker failure + persisted retry blocker',
      recovery_boundary: 'E4: real HRBOSS Electron + trusted preload + authenticated local API + SQLite + local whisper-cli',
      viewport: [1280, 800],
      failure_state: {
        ...failureState,
        recording_preserved: seed.preparation.recording_preserved,
        failed_worker_exit_nonzero: seed.preparation.failed_worker_exit_nonzero,
      },
      retry_request: retryRequest,
      transcript_ui: transcriptState,
      screenshots: [
        failureScreenshot,
        successScreenshot,
        reviewScreenshot,
        transcriptScreenshot,
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

module.exports = {
  installRuntimeController,
};
