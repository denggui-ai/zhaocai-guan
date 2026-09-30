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

  async function capture(win, name) {
    await delay(120);
    const image = await win.capturePage();
    const target = path.join(evidenceDir, `${name}.png`);
    fs.writeFileSync(target, image.toPNG(), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
    return path.basename(target);
  }

  async function localPost(win, requestPath, body) {
    return evaluate(win, `(async () => window.localApi.request(${JSON.stringify({
      service: 'action',
      method: 'POST',
      requestPath,
      body,
    })}))()`);
  }

  async function pageSnapshot(win) {
    return evaluate(win, `(() => ({
      viewport: [innerWidth, innerHeight],
      meta: document.querySelector('.candidate-list-meta')?.textContent.trim() || '',
      names: [...document.querySelectorAll('.candidate-card .candidate-name')]
        .map((element) => (element.textContent || '').trim()),
      selected: document.querySelector('.candidate-card[aria-selected="true"] .candidate-name')?.textContent.trim() || '',
    }))()`);
  }

  async function selectedIdentity(win) {
    return evaluate(win, `(() => ({
      card: document.querySelector('.candidate-card[aria-selected="true"] .candidate-name')?.textContent.trim() || '',
      focus_bar: document.querySelector('.candidate-focus-identity strong')?.textContent.trim() || '',
      detail: document.querySelector('.candidate-hero h2')?.textContent.trim() || '',
      facts_heading: document.querySelector('#candidate-facts-title')?.textContent.trim() || '',
      selected_count: document.querySelectorAll('.candidate-card[aria-selected="true"]').length,
    }))()`);
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

  async function selectCandidate(win, name) {
    await setSearch(win, name);
    await waitFor(
      win,
      `[...document.querySelectorAll('.candidate-card .candidate-name')]
        .some((element) => (element.textContent || '').trim() === ${JSON.stringify(name)})`,
      `search result ${name}`,
    );
    await clickExactText(win, '.candidate-card .candidate-name', name);
    await waitFor(
      win,
      `document.querySelector('.candidate-hero h2')?.textContent.trim() === ${JSON.stringify(name)}
        && document.querySelector('.candidate-card[aria-selected="true"] .candidate-name')?.textContent.trim() === ${JSON.stringify(name)}`,
      `selected detail ${name}`,
    );
    await waitFor(win, "document.querySelector('.candidate-disposition-card')", `manual disposition panel ${name}`);
  }

  async function openDispositionMenu(win) {
    await clickExactText(win, '.candidate-disposition-more-trigger', '更多处置');
    await waitFor(
      win,
      "[...document.querySelectorAll('.candidate-disposition-more-menu')].some((element) => element.offsetParent !== null)",
      'candidate disposition menu',
    );
  }

  async function inspectDispositionMenu(win) {
    return evaluate(win, `(() => {
      const menu = [...document.querySelectorAll('.candidate-disposition-more-menu')]
        .find((element) => element.offsetParent !== null);
      const items = [...(menu?.querySelectorAll('.candidate-disposition-more-item') || [])];
      return {
        labels: items.map((item) => (item.textContent || '').trim()),
        danger_labels: items
          .filter((item) => item.classList.contains('candidate-disposition-more-item-danger'))
          .map((item) => (item.textContent || '').trim()),
        contains_do_not_contact: items.some((item) => (item.textContent || '').includes('不再联系')),
      };
    })()`);
  }

  async function closeMenu(win) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor(
      win,
      "![...document.querySelectorAll('.candidate-disposition-more-menu')].some((element) => element.offsetParent !== null)",
      'candidate disposition menu close',
    );
  }

  async function inspectConfirmation(win, candidateName) {
    return evaluate(win, `(() => {
      const dialog = [...document.querySelectorAll('.ant-modal-confirm')]
        .find((element) => element.offsetParent !== null);
      const buttons = [...(dialog?.querySelectorAll('.ant-modal-confirm-btns button') || [])];
      const ok = buttons.find((button) => (button.textContent || '').trim().startsWith('确认'));
      return {
        title: dialog?.querySelector('.ant-modal-confirm-title')?.textContent.trim() || '',
        content: dialog?.querySelector('.ant-modal-confirm-content')?.textContent.trim() || '',
        ok_text: (ok?.textContent || '').trim(),
        ok_danger: Boolean(ok?.classList.contains('ant-btn-dangerous')),
        candidate_bound: Boolean(dialog && (dialog.textContent || '').includes(${JSON.stringify(candidateName)})),
      };
    })()`);
  }

  async function inspectBusyLock(win) {
    return evaluate(win, `(() => {
      const panel = document.querySelector('.candidate-disposition-card');
      const panelButtons = [...(panel?.querySelectorAll('button') || [])]
        .filter((button) => button.offsetParent !== null);
      const dialog = [...document.querySelectorAll('.ant-modal-confirm')]
        .find((element) => element.offsetParent !== null);
      const ok = [...(dialog?.querySelectorAll('.ant-modal-confirm-btns button') || [])]
        .find((button) => (button.textContent || '').trim().startsWith('确认'));
      return {
        panel_button_count: panelButtons.length,
        panel_disabled_count: panelButtons.filter((button) => button.disabled).length,
        all_panel_actions_disabled: panelButtons.length > 0 && panelButtons.every((button) => button.disabled),
        confirmation_visible: Boolean(dialog),
        confirmation_ok_loading: Boolean(ok?.classList.contains('ant-btn-loading')),
        confirmation_ok_disabled: Boolean(ok?.disabled),
        observed: panelButtons.length > 0
          && panelButtons.every((button) => button.disabled)
          && Boolean(dialog)
          && Boolean(ok?.classList.contains('ant-btn-loading')),
      };
    })()`);
  }

  async function performAction(win, input) {
    await selectCandidate(win, input.candidateName);
    if (input.menu) {
      await openDispositionMenu(win);
      await clickExactText(win, '.candidate-disposition-more-item', input.label);
    } else {
      await clickExactText(win, '.candidate-disposition-action', input.label);
    }
    await waitFor(
      win,
      "[...document.querySelectorAll('.ant-modal-confirm')].some((element) => element.offsetParent !== null)",
      `${input.action} confirmation`,
    );
    const confirmation = await inspectConfirmation(win, input.candidateName);
    assert.equal(confirmation.candidate_bound, true, `${input.action} confirmation must bind the selected candidate`);
    assert.equal(confirmation.ok_danger, input.danger, `${input.action} danger contract`);
    const previousRequestCount = telemetry.candidateStatusRequests.length;
    await clickExactText(win, '.ant-modal-confirm-btns button', input.okText);
    await waitForMain(
      () => telemetry.candidateStatusRequests.length === previousRequestCount + 1,
      `${input.action} local action request`,
    );
    const request = telemetry.candidateStatusRequests[previousRequestCount];
    await waitForMain(
      () => Boolean(request.backend_completed_at) && !request.released_at,
      `${input.action} delayed committed response`,
    );
    await waitFor(
      win,
      `(() => {
        const panel = document.querySelector('.candidate-disposition-card');
        const panelButtons = [...(panel?.querySelectorAll('button') || [])].filter((button) => button.offsetParent !== null);
        const dialog = [...document.querySelectorAll('.ant-modal-confirm')].find((element) => element.offsetParent !== null);
        const ok = [...(dialog?.querySelectorAll('.ant-modal-confirm-btns button') || [])]
          .find((button) => (button.textContent || '').trim().startsWith('确认'));
        return panelButtons.length > 0
          && panelButtons.every((button) => button.disabled)
          && Boolean(dialog)
          && Boolean(ok?.classList.contains('ant-btn-loading'));
      })()`,
      `${input.action} UI busy lock`,
    );
    const busyLock = await inspectBusyLock(win);
    assert.equal(busyLock.observed, true, `${input.action} must expose a real write busy lock`);
    let screenshot = null;
    if (input.screenshot) screenshot = await capture(win, input.screenshot);
    await waitForMain(() => Boolean(request.released_at), `${input.action} delayed response release`);
    await delay(5_000);
    const postRelease = await evaluate(win, `(() => {
      const dialog = [...document.querySelectorAll('.ant-modal-confirm')]
        .find((element) => element.offsetParent !== null);
      const wrap = dialog?.closest('.ant-modal-wrap');
      const buttons = [...(dialog?.querySelectorAll('button') || [])];
      return {
        visible: Boolean(dialog),
        dialog_text: dialog?.textContent.trim() || '',
        dialog_class: dialog?.className || '',
        wrap_class: wrap?.className || '',
        wrap_display: wrap ? getComputedStyle(wrap).display : '',
        buttons: buttons.map((button) => ({
          text: (button.textContent || '').trim(),
          disabled: button.disabled,
          class_name: button.className,
        })),
        action_error: document.querySelector('.candidate-command-error')?.textContent.trim() || '',
        refresh_alert: document.querySelector('.candidate-detail-recovery-alert')?.textContent.trim() || '',
      };
    })()`);
    assert.equal(
      postRelease.visible,
      false,
      `${input.action} confirmation remained open after response release: ${JSON.stringify(postRelease)}`,
    );
    await waitFor(
      win,
      "!document.querySelector('.candidate-disposition-card .ant-btn-loading')",
      `${input.action} busy lock release`,
      45_000,
    );
    const actionError = await evaluate(
      win,
      "document.querySelector('.candidate-command-error')?.textContent.trim() || ''",
    );
    assert.equal(actionError, '', `${input.action} must not show an action error`);
    assert.equal(request.action, input.action);
    assert.equal(request.candidate_id, seed.actions[input.action]);
    assert.equal(request.response_status, 200);
    return {
      action: input.action,
      candidate_name: input.candidateName,
      confirmation,
      busy_lock: busyLock,
      post_release: postRelease,
      request,
      screenshot,
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
    await waitFor(
      win,
      "document.querySelector('.candidate-list-meta')?.textContent.includes('15 人')"
        + " && document.querySelector('.candidate-list-meta')?.textContent.includes('第 1/2 页')"
        + " && document.querySelectorAll('.candidate-card').length === 10",
      'candidate page one',
      45_000,
    );
    const pageOne = await pageSnapshot(win);
    assert.deepEqual(pageOne.viewport, [1280, 800]);
    assert.equal(pageOne.names.length, 10);
    const pageOneScreenshot = await capture(win, 'B-3-page-1-1280x800');

    await clickExactText(win, '.ant-pagination-item-2', '2');
    await waitFor(
      win,
      "document.querySelector('.candidate-list-meta')?.textContent.includes('第 2/2 页')"
        + " && document.querySelectorAll('.candidate-card').length === 5",
      'candidate page two',
    );
    const pageTwo = await pageSnapshot(win);
    assert.equal(pageTwo.names.length, 5);
    assert.equal(pageOne.names.some((name) => pageTwo.names.includes(name)), false);
    const selectedName = pageTwo.names[0];
    await clickExactText(win, '.candidate-card .candidate-name', selectedName);
    await waitFor(
      win,
      `document.querySelector('.candidate-hero h2')?.textContent.trim() === ${JSON.stringify(selectedName)}`,
      'selected candidate detail',
    );
    const identity = await selectedIdentity(win);
    assert.equal(identity.selected_count, 1);
    assert.equal(identity.card, selectedName);
    assert.equal(identity.focus_bar, selectedName);
    assert.equal(identity.detail, selectedName);
    assert.equal(identity.facts_heading, '候选人事实');
    const pageTwoScreenshot = await capture(win, 'B-3-page-2-selected-1280x800');

    await openDispositionMenu(win);
    const menu = await inspectDispositionMenu(win);
    assert.deepEqual(menu.labels, ['进入人才库', '淘汰', '主动放弃', '标记录用']);
    assert.deepEqual(menu.danger_labels, ['淘汰', '主动放弃', '标记录用']);
    assert.equal(menu.contains_do_not_contact, false);
    const actionsScreenshot = await capture(win, 'B-3-selected-actions-1280x800');
    await closeMenu(win);

    const doNotContact = await localPost(win, '/candidate-status', {
      candidateId: seed.actions.do_not_contact_probe,
      jobId: seed.job_id,
      layer: 'disposition',
      action: '不再联系',
      reason: 'B-3 合成运行期验证：全局不再联系不得伪装为岗位人工处置',
      requestId: 'b3-runtime-global-dnc-rejected',
    });
    assert.equal(doNotContact.status, 400, JSON.stringify(doNotContact.body));
    assert.equal(doNotContact.body.code, 'MANUAL_ACTION_INVALID');

    const names = Object.fromEntries(
      Object.entries(seed.actions).map(([key, candidateId]) => {
        const suffix = Object.entries(seed.candidates).find(([, id]) => id === candidateId)?.[0];
        return [key, `B-3 合成候选人 ${suffix}`];
      }),
    );
    const actions = [];
    actions.push(await performAction(win, {
      action: 'continue_process',
      candidateName: names.continue_process,
      label: '继续推进',
      okText: '确认继续推进',
      menu: false,
      danger: false,
    }));
    actions.push(await performAction(win, {
      action: 'hold',
      candidateName: names.hold,
      label: '暂缓',
      okText: '确认暂缓',
      menu: false,
      danger: false,
      screenshot: 'B-3-hold-busy-1280x800',
    }));
    actions.push(await performAction(win, {
      action: 'talent_pool',
      candidateName: names.talent_pool,
      label: '进入人才库',
      okText: '确认进入人才库',
      menu: true,
      danger: false,
    }));
    actions.push(await performAction(win, {
      action: 'reject',
      candidateName: names.reject,
      label: '淘汰',
      okText: '确认淘汰',
      menu: true,
      danger: true,
      screenshot: 'B-3-reject-busy-1280x800',
    }));
    actions.push(await performAction(win, {
      action: 'withdraw',
      candidateName: names.withdraw,
      label: '主动放弃',
      okText: '确认主动放弃',
      menu: true,
      danger: true,
    }));

    return {
      ok: true,
      evidence_level: 'E4',
      synthetic_data_only: true,
      runtime_boundary: 'real HRBOSS Electron + trusted preload + authenticated local API + SQLite',
      pagination: {
        total_candidates: 15,
        page_size: 10,
        total_pages: 2,
        page_one: pageOne,
        page_two: pageTwo,
      },
      selection: {
        selected_name: selectedName,
        ...identity,
        same_candidate: identity.card === identity.focus_bar && identity.card === identity.detail,
      },
      disposition_menu: menu,
      global_do_not_contact: {
        product_action_available: false,
        api_probe_status: doNotContact.status,
        api_probe_code: doNotContact.body.code,
        semantic_boundary: 'global historical state; not a job-level manual disposition',
      },
      actions,
      screenshots: [
        pageOneScreenshot,
        pageTwoScreenshot,
        actionsScreenshot,
        ...actions.map((item) => item.screenshot).filter(Boolean),
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
