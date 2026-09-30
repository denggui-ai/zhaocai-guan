'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CURRENT_JOB_ID_STORAGE_KEY = 'hrboss.ui.currentJobId.v1';
const FINAL_SUMMARY = 'B-12 合成人工终评：岗位画像、面试报告与测评材料相互印证，继续由 HR 人工推进。';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installRuntimeController({
  app,
  BrowserWindow,
  clipboard,
  originalClipboardText,
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
  }

  async function fill(win, ariaLabel, value) {
    const changed = await evaluate(win, `(() => {
      const target = document.querySelector(${JSON.stringify(`[aria-label="${ariaLabel}"]`)});
      if (!target || target.offsetParent === null || target.disabled) return false;
      const prototype = target.tagName === 'TEXTAREA'
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
      setter.call(target, ${JSON.stringify(value)});
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    assert.equal(changed, true, `cannot fill visible field: ${ariaLabel}`);
  }

  async function capture(win, name, focusSelector = '') {
    if (focusSelector) {
      await evaluate(win, `document.querySelector(${JSON.stringify(focusSelector)})?.scrollIntoView({ block: 'center', inline: 'nearest' })`);
      await delay(180);
    }
    win.setMinimumSize(900, 650);
    win.setContentSize(1280, 800);
    await delay(180);
    const image = await win.webContents.capturePage();
    const target = path.join(evidenceDir, `${name}.png`);
    fs.writeFileSync(target, image.toPNG(), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
    return path.basename(target);
  }

  async function setJobAndReload(win, jobId) {
    await evaluate(win, `(() => {
      window.localStorage.setItem(${JSON.stringify(CURRENT_JOB_ID_STORAGE_KEY)}, ${JSON.stringify(String(jobId))});
      window.location.reload();
      return true;
    })()`);
    await waitFor(win, "document.readyState === 'complete' && Boolean(document.querySelector('#root'))", 'renderer reload');
    await waitFor(win, "[...document.querySelectorAll('button.nav-item')].some((el) => (el.textContent || '').trim() === '候选人')", 'main navigation');
  }

  async function openNav(win, label) {
    await clickExact(win, 'button.nav-item', label);
    await waitFor(
      win,
      `[...document.querySelectorAll('main, .workspace, #main-workspace')].some((element) => element.offsetParent !== null && (element.textContent || '').includes(${JSON.stringify(label)}))`,
      `${label} navigation`,
      60_000,
    );
  }

  async function selectDomain(win, label, expectedAriaLabel) {
    await clickContaining(win, '.candidate-domain-navigation .ant-segmented-item', label);
    await waitFor(
      win,
      `document.querySelector('.candidate-domain-panel')?.getAttribute('aria-label') === ${JSON.stringify(expectedAriaLabel)}`,
      `${label} domain`,
      60_000,
    );
  }

  async function localPost(win, requestPath, body) {
    return evaluate(win, `(async () => window.localApi.request(${JSON.stringify({
      service: 'action',
      method: 'POST',
      requestPath,
      body,
    })}))()`);
  }

  async function runJourney() {
    const win = await waitForWindow();
    win.webContents.setBackgroundThrottling(false);
    win.setContentSize(1280, 800);
    win.show();
    win.focus();
    await waitFor(win, "document.readyState === 'complete' && Boolean(document.querySelector('#root'))", 'renderer load');
    await waitFor(win, "[...document.querySelectorAll('button.nav-item')].some((el) => (el.textContent || '').trim() === '人才库')", 'main navigation');

    await setJobAndReload(win, seed.formal_job_id);
    await openNav(win, '人才库');
    await waitFor(win, "(document.querySelector('.talent-pool-page')?.textContent || '').includes('B-12 合成终评候选人')", 'formal talent pool');
    const formalTalent = await evaluate(win, `(() => {
      const area = document.querySelector('textarea[aria-label="人才库再触达草稿"]');
      const alert = document.querySelector('.talent-pool-outreach-alert');
      const copy = [...document.querySelectorAll('.talent-pool-draft-actions button')]
        .find((button) => (button.textContent || '').trim() === '复制');
      return {
        alert: alert?.textContent || '',
        textarea_disabled: area?.disabled === true,
        copy_disabled: copy?.disabled === true,
        page_source: document.querySelector('.talent-pool-hero')?.textContent || '',
      };
    })()`);
    assert.match(formalTalent.alert, /授权状态未确认，禁止再触达/);
    assert.match(formalTalent.alert, /退订\/删除请求或再触达授权尚未确认/);
    assert.equal(formalTalent.textarea_disabled, true);
    assert.equal(formalTalent.copy_disabled, true);
    assert.match(formalTalent.page_source, /历史证据只读/);
    const formalTalentScreenshot = await capture(
      win,
      'B-12-formal-talent-outreach-fail-closed-1280x800',
      'textarea[aria-label="人才库再触达草稿"]',
    );

    await setJobAndReload(win, seed.fixture_job_id);
    await openNav(win, '人才库');
    await waitFor(win, "(document.querySelector('.talent-pool-page')?.textContent || '').includes('样例数据 · 无真实候选人数据')", 'fixture talent pool');
    await waitFor(win, "document.querySelector('textarea[aria-label=\"人才库再触达草稿\"]')?.disabled === false", 'fixture outreach draft');
    const fixtureDraft = 'B-12 合成本地再触达草稿：仅复制到剪贴板，不发送消息。';
    await fill(win, '人才库再触达草稿', fixtureDraft);
    await nativeClickExact(win, '.talent-pool-draft-actions button', '复制');
    await waitFor(
      win,
      "[...document.querySelectorAll('.ant-message-notice')].some((el) => /草稿已复制|复制失败，可手动选中文本复制/.test(el.textContent || ''))",
      'copy result',
    );
    const copyMessage = await evaluate(win, `[...document.querySelectorAll('.ant-message-notice')]
      .map((element) => (element.textContent || '').trim())
      .find((text) => /草稿已复制|复制失败，可手动选中文本复制/.test(text)) || ''`);
    const clipboardCopied = copyMessage.includes('草稿已复制');
    if (clipboardCopied) {
      assert.equal(clipboard.readText(), fixtureDraft, 'successful production copy action must write the exact local draft');
    } else {
      assert.equal(copyMessage, '复制失败，可手动选中文本复制');
      assert.equal(clipboard.readText(), originalClipboardText, 'failed clipboard permission must not corrupt prior clipboard content');
    }
    const fixtureState = await evaluate(win, `(() => ({
      text: document.querySelector('textarea[aria-label="人才库再触达草稿"]')?.value || '',
      helper: document.querySelector('.talent-pool-draft-actions')?.textContent || '',
      source: document.querySelector('.talent-pool-hero')?.textContent || '',
    }))()`);
    assert.equal(fixtureState.text, fixtureDraft);
    assert.match(fixtureState.helper, /本地可编辑草稿 · 不发送/);
    assert.match(fixtureState.source, /样例数据 · 无真实候选人数据/);
    const fixtureTalentScreenshot = await capture(
      win,
      'B-12-fixture-local-outreach-draft-1280x800',
      'textarea[aria-label="人才库再触达草稿"]',
    );

    await setJobAndReload(win, seed.formal_job_id);
    await openNav(win, '候选人');
    await waitFor(win, "Boolean(document.querySelector('.candidate-card'))", 'candidate list', 60_000);
    await clickContaining(win, '.candidate-card', 'B-12 合成终评候选人');
    await waitFor(win, "(document.querySelector('.candidate-focus-identity')?.textContent || '').includes('B-12 合成终评候选人')", 'selected candidate');

    const blockedBeforeReview = await localPost(win, '/candidate-journey/offer-status', {
      candidate_id: seed.candidate_id,
      job_id: seed.formal_job_id,
      status: 'ready_to_offer',
      request_id: 'b12-offer-before-final-review',
    });
    assert.equal(blockedBeforeReview.status, 409);
    assert.equal(blockedBeforeReview.body?.code, 'OFFER_FINAL_REVIEW_REQUIRED');

    await selectDomain(win, '终评', '候选人结构化终评工作区');
    await waitFor(win, "Boolean(document.querySelector('textarea[aria-label=\"人工终评摘要\"]'))", 'final review draft form', 60_000);
    const prerequisiteState = await evaluate(win, `(() => ({
      text: document.querySelector('.candidate-domain-panel')?.textContent || '',
      assessment_tags: [...document.querySelectorAll('.candidate-domain-panel .ant-tag')]
        .map((element) => (element.textContent || '').trim()),
    }))()`);
    assert.match(prerequisiteState.text, /已纳入终评的测评证据/);
    assert.ok(prerequisiteState.assessment_tags.some((text) => text.includes(seed.assessment_document_id)));
    await fill(win, '人工终评摘要', FINAL_SUMMARY);
    await fill(win, '岗位相关优势证据', 'B-12 合成优势：岗位画像要求与面试事实一致。');
    await fill(win, '风险与反证', 'B-12 合成风险：仍需 HR 复核预计到岗安排。');
    await fill(win, '限制与待核实项', 'B-12 合成限制：所有材料仅供本次人工终评。');
    await clickExact(win, '.candidate-domain-panel button', '保存终评草稿');
    await waitFor(
      win,
      "[...document.querySelectorAll('.candidate-domain-panel button')].some((el) => (el.textContent || '').trim() === '确认终评卡' && !el.disabled)",
      'saved final review draft',
      60_000,
    );
    const finalReviewDraftRequest = telemetry.localApiRequests.find((item) => (
      item.method === 'POST' && item.request_path === '/f018/final-review/draft' && item.response_status === 200
    ));
    assert.ok(finalReviewDraftRequest, 'final review draft must traverse the trusted local API');
    assert.deepEqual(finalReviewDraftRequest.body.review_json.evidence_refs, [
      { source_type: 'job_profile', source_id: seed.job_profile_version_id },
      { source_type: 'interview_report', source_id: seed.interview_report_id },
      { source_type: 'assessment_document', source_id: seed.assessment_document_id },
    ]);
    const finalDraftScreenshot = await capture(
      win,
      'B-12-final-review-three-source-draft-1280x800',
      'textarea[aria-label="人工终评摘要"]',
    );

    await clickExact(win, '.candidate-domain-panel button', '确认终评卡');
    await waitFor(win, "[...document.querySelectorAll('.ant-modal')].some((el) => el.offsetParent !== null && (el.textContent || '').includes('确认终评卡？'))", 'final review confirmation modal');
    const reviewModal = await evaluate(win, `(() => {
      const modal = [...document.querySelectorAll('.ant-modal')]
        .find((element) => element.offsetParent !== null && (element.textContent || '').includes('确认终评卡？'));
      return modal?.textContent || '';
    })()`);
    assert.match(reviewModal, /候选人处置仍不会改变/);
    assert.match(reviewModal, /处置必须再次单独确认/);
    await clickExact(win, '.ant-modal-confirm-btns button', '确认执行');
    await waitFor(win, "(document.querySelector('.candidate-domain-panel')?.textContent || '').includes('终评确认尚未改变处置，必须再次显式确认。')", 'confirmed review awaiting disposition', 60_000);
    const confirmedReviewState = await evaluate(win, `(() => ({
      text: document.querySelector('.candidate-domain-panel')?.textContent || '',
      disposition_value: document.querySelector('[aria-label="终评处置"] .ant-select-selection-item')?.textContent || '',
    }))()`);
    assert.match(confirmedReviewState.text, /终评已确认 · 版本 2/);
    assert.match(confirmedReviewState.text, /终评确认尚未改变处置，必须再次显式确认/);
    assert.equal(confirmedReviewState.disposition_value, '继续流程');

    await selectDomain(win, '流程', '候选人流程工作区');
    await waitFor(win, "(document.querySelector('.candidate-domain-panel')?.textContent || '').includes('完成终评并人工确认“继续流程”后，才会开放 Offer 跟进。')", 'Offer remains locked after review confirmation', 60_000);
    const lockedOfferScreenshot = await capture(
      win,
      'B-12-confirmed-review-offer-still-locked-1280x800',
      '[aria-label="候选人流程工作区"]',
    );

    await selectDomain(win, '终评', '候选人结构化终评工作区');
    await clickExact(win, '.candidate-domain-panel button', '确认处置');
    await waitFor(win, "[...document.querySelectorAll('.ant-modal')].some((el) => el.offsetParent !== null && (el.textContent || '').includes('确认执行“继续流程”？'))", 'separate disposition modal');
    const dispositionModal = await evaluate(win, `(() => {
      const modal = [...document.querySelectorAll('.ant-modal')]
        .find((element) => element.offsetParent !== null && (element.textContent || '').includes('确认执行“继续流程”？'));
      return modal?.textContent || '';
    })()`);
    assert.match(dispositionModal, /第二个独立人工动作/);
    assert.match(dispositionModal, /系统不会写入“已入职”/);
    await clickExact(win, '.ant-modal-confirm-btns button', '确认执行');
    await waitFor(win, "(document.querySelector('.candidate-domain-panel')?.textContent || '').includes('处置已记录：continue_process')", 'final disposition persisted', 60_000);

    await selectDomain(win, '流程', '候选人流程工作区');
    await waitFor(win, "(document.querySelector('.candidate-domain-panel')?.textContent || '').includes('终评已允许继续流程，可由 HR 开始 Offer 跟进。')", 'Offer eligibility');
    const invalidInitialOffer = await localPost(win, '/candidate-journey/offer-status', {
      candidate_id: seed.candidate_id,
      job_id: seed.formal_job_id,
      status: 'accepted',
      expected_start_date: '2026-08-18',
      request_id: 'b12-offer-invalid-initial-status',
    });
    assert.equal(invalidInitialOffer.status, 409);
    assert.equal(invalidInitialOffer.body?.code, 'OFFER_INITIAL_STATUS_INVALID');
    const eligibleOfferScreenshot = await capture(
      win,
      'B-12-separate-disposition-unlocks-offer-1280x800',
      '[aria-label="Offer 下一状态"]',
    );

    const offerSelection = await evaluate(win, `(() => ({
      value: document.querySelector('[aria-label="Offer 下一状态"] .ant-select-selection-item')?.textContent || '',
      disabled: document.querySelector('[aria-label="Offer 下一状态"]')?.getAttribute('aria-disabled') === 'true',
    }))()`);
    assert.equal(offerSelection.value, '准备发 Offer');
    assert.equal(offerSelection.disabled, false);
    await fill(win, 'Offer 跟进备注', 'B-12 合成 Offer 跟进，仅记录人工状态，不发送消息。');
    const offerCardClicked = await evaluate(win, `(() => {
      const select = document.querySelector('[aria-label="Offer 下一状态"]');
      const card = select?.closest('.ant-card');
      const button = [...(card?.querySelectorAll('button') || [])]
        .find((element) => (element.textContent || '').trim() === '确认更新');
      if (!button || button.disabled) return false;
      button.scrollIntoView({ block: 'center', inline: 'nearest' });
      button.click();
      return true;
    })()`);
    assert.equal(offerCardClicked, true, 'Offer card must expose an enabled confirm action');
    await waitFor(win, "(document.querySelector('.candidate-domain-panel')?.textContent || '').includes('当前状态：准备发 Offer')", 'ready_to_offer state', 60_000);
    const offerReadyScreenshot = await capture(
      win,
      'B-12-offer-ready-manual-status-1280x800',
      '[aria-label="候选人流程工作区"]',
    );

    const finalReviewRequests = telemetry.localApiRequests.filter((item) => (
      item.method === 'POST' && /^\/f018\//.test(item.request_path)
    ));
    assert.deepEqual(finalReviewRequests.map((item) => item.request_path), [
      '/f018/final-review/draft',
      '/f018/final-review/confirm',
      '/f018/disposition',
    ]);
    assert.ok(finalReviewRequests.every((item) => item.response_status === 200));
    const offerWrites = telemetry.localApiRequests.filter((item) => (
      item.method === 'POST' && item.request_path === '/candidate-journey/offer-status'
    ));
    assert.deepEqual(offerWrites.map((item) => [item.response_status, item.response_code]), [
      [409, 'OFFER_FINAL_REVIEW_REQUIRED'],
      [409, 'OFFER_INITIAL_STATUS_INVALID'],
      [200, null],
    ]);

    return {
      ok: true,
      evidence_level: 'E4',
      viewport: [1280, 800],
      talent: {
        formal_fail_closed: formalTalent,
        fixture_local_draft_only: {
          source_labeled_fixture: true,
          exact_clipboard_copy: clipboardCopied,
          safe_manual_copy_fallback: !clipboardCopied,
          copy_message: copyMessage,
          local_only_label: fixtureState.helper,
          draft: fixtureDraft,
        },
      },
      final_review: {
        exact_evidence_refs: finalReviewDraftRequest.body.review_json.evidence_refs,
        explicit_confirmation_modal: true,
        separate_disposition_modal: true,
        confirmed_without_disposition_offer_locked: true,
      },
      offer: {
        guards: {
          before_final_review: blockedBeforeReview.body.code,
          invalid_initial_after_disposition: invalidInitialOffer.body.code,
        },
        final_status: 'ready_to_offer',
        writes: offerWrites.map((item) => ({
          status: item.response_status,
          code: item.response_code,
          requested_status: item.body?.status,
        })),
      },
      api_requests: telemetry.localApiRequests,
      screenshots: [
        formalTalentScreenshot,
        fixtureTalentScreenshot,
        finalDraftScreenshot,
        lockedOfferScreenshot,
        eligibleOfferScreenshot,
        offerReadyScreenshot,
      ],
      renderer_console: telemetry.rendererConsole,
      external_services_accessed: false,
    };
  }

  app.whenReady().then(async () => {
    let exitCode = 0;
    let result;
    try {
      result = await runJourney();
    } catch (error) {
      exitCode = 1;
      result = {
        ok: false,
        error: error && error.stack ? error.stack : String(error),
        api_requests: telemetry.localApiRequests,
        renderer_console: telemetry.rendererConsole,
      };
    } finally {
      clipboard.writeText(originalClipboardText);
    }
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(resultPath, 0o600);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.destroy();
    }
    app.exit(exitCode);
  });
}

module.exports = { installRuntimeController };
