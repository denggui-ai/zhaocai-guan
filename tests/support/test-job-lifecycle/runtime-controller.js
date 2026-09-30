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
  const expected = seed.expected;

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

  async function clickSelector(win, selector, label) {
    const clicked = await evaluate(win, `(() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.offsetParent !== null);
      if (!target) return false;
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      target.focus();
      target.click();
      return true;
    })()`);
    assert.equal(clicked, true, `missing visible control ${label}`);
  }

  async function setControlValue(win, selector, value) {
    const changed = await evaluate(win, `(() => {
      const input = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.offsetParent !== null);
      if (!input) return false;
      const prototype = input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (!setter) return false;
      input.focus();
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: ${JSON.stringify(value)},
      }));
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

  function requestsFor(requestPath) {
    return telemetry.mutationRequests.filter((request) => request.request_path === requestPath);
  }

  async function waitForRequest(requestPath, previousCount, label) {
    await waitForMain(
      () => requestsFor(requestPath).length === previousCount + 1
        && Boolean(requestsFor(requestPath)[previousCount].completed_at),
      label,
    );
    const request = requestsFor(requestPath)[previousCount];
    assert.ok([200, 201].includes(request.response_status), `${label}: ${JSON.stringify(request)}`);
    return request;
  }

  async function openMoreMenu(win, jobName) {
    await clickSelector(
      win,
      `button[aria-label=${JSON.stringify(`打开 ${jobName} 的更多操作`)}]`,
      `more actions for ${jobName}`,
    );
    await waitFor(
      win,
      "[...document.querySelectorAll('.ant-dropdown-menu')].some((element) => element.offsetParent !== null)",
      `more menu for ${jobName}`,
    );
  }

  async function jobRowSnapshot(win, jobName) {
    return evaluate(win, `(() => {
      const action = [...document.querySelectorAll('button[aria-label]')]
        .find((element) => element.offsetParent !== null
          && element.getAttribute('aria-label') === ${JSON.stringify(`打开 ${jobName} 的更多操作`)});
      const row = action?.closest('tr, .job-ledger-compact-item');
      return {
        found: Boolean(row),
        text: (row?.textContent || '').replace(/\\s+/g, ' ').trim(),
        more_disabled: Boolean(action?.disabled),
      };
    })()`);
  }

  async function scrollVisibleTextIntoView(win, selector, value) {
    const scrolled = await evaluate(win, `(() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.offsetParent !== null && (element.textContent || '').includes(${JSON.stringify(value)}));
      target?.scrollIntoView({ block: 'start', inline: 'nearest' });
      return Boolean(target);
    })()`);
    assert.equal(scrolled, true, `could not scroll ${value} into view`);
    await delay(120);
  }

  async function readJobs(win) {
    return evaluate(win, `(async () => window.localApi.request(${JSON.stringify({
      service: 'readonly',
      method: 'GET',
      requestPath: '/jobs',
    })}))()`);
  }

  async function runJourney() {
    const win = await waitForWindow();
    win.webContents.setBackgroundThrottling(false);
    win.setContentSize(1280, 800);
    win.show();
    win.focus();
    await waitFor(win, "Boolean(window.localApi?.request)", 'trusted local API bridge', 45_000);
    await waitFor(win, "document.querySelector('button.nav-item')", 'main navigation', 45_000);
    await clickExactText(win, 'button.nav-item', '职位管理');
    await waitFor(
      win,
      `document.querySelector('button[aria-label=${JSON.stringify(`打开 ${expected.original_name} 的更多操作`)}]')`,
      'synthetic job ledger',
      45_000,
    );
    const initialRow = await jobRowSnapshot(win, expected.original_name);
    assert.equal(initialRow.found, true);
    assert.match(initialRow.text, /招聘中/);
    const initialScreenshot = await capture(win, 'B-4-ledger-before-1280x800');

    await openMoreMenu(win, expected.original_name);
    await clickExactText(win, '.ant-dropdown-menu-item', '编辑岗位信息');
    await waitFor(
      win,
      `document.querySelector('input[name="job-edit-name"]')?.value === ${JSON.stringify(expected.original_name)}`,
      'job edit modal',
    );
    await setControlValue(win, 'input[name="job-edit-name"]', expected.edited_name);
    await setControlValue(win, 'input[name="job-edit-hr-owner"]', expected.hr_owner);
    await setControlValue(win, 'input[name="job-edit-planned-hires"]', String(expected.planned_hires));
    await setControlValue(win, 'input[name="job-edit-department"]', expected.department);
    await setControlValue(win, 'input[name="job-edit-location"]', expected.location);
    const editPath = `/jobs/${seed.job_id}/details`;
    const editRequestCount = requestsFor(editPath).length;
    await clickExactText(win, '.ant-modal-footer button', '保存修改');
    const editRequest = await waitForRequest(editPath, editRequestCount, 'job details mutation');
    await waitFor(
      win,
      `document.querySelector('button[aria-label=${JSON.stringify(`打开 ${expected.edited_name} 的更多操作`)}]')`,
      'edited job ledger row',
    );
    const editedRow = await jobRowSnapshot(win, expected.edited_name);
    assert.match(editedRow.text, /修改：/);
    for (const label of ['岗位名称', 'HR 负责人', '计划 HC', '部门', '工作地点']) {
      assert.match(editedRow.text, new RegExp(label));
    }
    const editedScreenshot = await capture(win, 'B-4-ledger-edited-1280x800');

    await clickSelector(
      win,
      `button[aria-label=${JSON.stringify(`管理 ${expected.edited_name} 的 JD 和画像`)}]`,
      'manage edited job',
    );
    await waitFor(
      win,
      `document.querySelector('[data-job-editor-heading]')?.textContent.trim() === ${JSON.stringify(expected.edited_name)}
        && document.querySelector('textarea[aria-label="JD 正文"]')`,
      'job JD editor',
      45_000,
    );
    await setControlValue(win, 'textarea[aria-label="JD 正文"]', expected.jd_text);
    const jdCreatePath = '/job-jd-version';
    const jdCreateCount = requestsFor(jdCreatePath).length;
    await clickExactText(win, 'button', '保存 JD 草稿');
    const jdCreateRequest = await waitForRequest(jdCreatePath, jdCreateCount, 'JD draft mutation');
    await waitFor(
      win,
      "[...document.querySelectorAll('button')].some((element) => element.offsetParent !== null && element.textContent.trim() === '启用此版本')",
      'JD draft history action',
    );
    const jdActivatePath = '/job-jd-version/activate';
    const jdActivateCount = requestsFor(jdActivatePath).length;
    await clickExactText(win, 'button', '启用此版本');
    const jdActivateRequest = await waitForRequest(jdActivatePath, jdActivateCount, 'JD activation mutation');
    assert.equal(jdActivateRequest.body.expectedVersion, 1);
    await waitFor(
      win,
      `document.querySelector('.job-management-shell')?.textContent.includes('使用中')
        && document.querySelector('.job-management-shell')?.textContent.includes(${JSON.stringify(expected.jd_text)})`,
      'active JD projection',
    );
    await scrollVisibleTextIntoView(win, '.ant-card', '第一步：填写并保存 JD 草稿');
    const activeJdScreenshot = await capture(win, 'B-4-jd-active-1280x800');

    await clickExactText(win, '.ant-segmented-item-label', '岗位画像');
    await waitFor(
      win,
      "document.querySelector('textarea[aria-label=\"岗位职责\"]') && document.querySelector('textarea[aria-label=\"必须条件\"]')",
      'job profile editor',
    );
    await setControlValue(win, 'textarea[aria-label="岗位职责"]', expected.responsibilities.join('\n'));
    await setControlValue(win, 'textarea[aria-label="必须条件"]', expected.must_haves.join('\n'));
    const profileCreatePath = '/job-profile-version';
    const profileCreateCount = requestsFor(profileCreatePath).length;
    await clickExactText(win, 'button', '保存岗位画像草稿');
    const profileCreateRequest = await waitForRequest(profileCreatePath, profileCreateCount, 'profile draft mutation');
    await waitFor(
      win,
      "[...document.querySelectorAll('button')].some((element) => element.offsetParent !== null && element.textContent.trim() === '确认此版本')",
      'profile draft history action',
    );
    const profileConfirmPath = '/job-profile-version/confirm';
    const profileConfirmCount = requestsFor(profileConfirmPath).length;
    await clickExactText(win, 'button', '确认此版本');
    const profileConfirmRequest = await waitForRequest(profileConfirmPath, profileConfirmCount, 'profile confirmation mutation');
    assert.equal(profileConfirmRequest.body.expectedVersion, 1);
    await waitFor(
      win,
      `document.querySelector('.job-management-shell')?.textContent.includes('已确认')
        && document.querySelector('.job-management-shell')?.textContent.includes(${JSON.stringify(expected.responsibilities[0])})
        && document.querySelector('.job-management-shell')?.textContent.includes(${JSON.stringify(expected.must_haves[1])})`,
      'confirmed profile projection',
    );
    await scrollVisibleTextIntoView(win, '.ant-card', '第二步：填写并保存岗位画像草稿');
    const confirmedProfileScreenshot = await capture(win, 'B-4-profile-confirmed-1280x800');

    await clickExactText(win, 'button', '返回岗位台账');
    await waitFor(
      win,
      `document.querySelector('button[aria-label=${JSON.stringify(`打开 ${expected.edited_name} 的更多操作`)}]')`,
      'return to job ledger',
    );
    await openMoreMenu(win, expected.edited_name);
    await clickExactText(win, '.ant-dropdown-menu-item', '复制岗位');
    await waitFor(
      win,
      "[...document.querySelectorAll('.ant-modal-confirm')].some((element) => element.offsetParent !== null && element.textContent.includes('不会复制'))",
      'copy confirmation',
    );
    const copyPath = `/jobs/${seed.job_id}/copy`;
    const copyCount = requestsFor(copyPath).length;
    await clickExactText(win, '.ant-modal-confirm-btns button', '复制为新草稿');
    const copyRequest = await waitForRequest(copyPath, copyCount, 'job copy mutation');
    assert.match(String(copyRequest.body.requestId || ''), /\S/);
    const copiedName = `${expected.edited_name} - 副本`;
    await waitFor(
      win,
      `document.querySelector('button[aria-label=${JSON.stringify(`打开 ${copiedName} 的更多操作`)}]')`,
      'copied job ledger row',
      45_000,
    );
    const copiedRow = await jobRowSnapshot(win, copiedName);
    assert.match(copiedRow.text, /草稿/);
    const copiedScreenshot = await capture(win, 'B-4-copy-draft-1280x800');

    const hideClosedInitially = await evaluate(
      win,
      "Boolean([...document.querySelectorAll('.ant-checkbox-wrapper')].find((element) => element.textContent.trim() === '隐藏已关闭')?.querySelector('input')?.checked)",
    );
    assert.equal(hideClosedInitially, true, 'closed jobs must be hidden by default before HR changes the filter');
    await clickExactText(win, '.ant-checkbox-wrapper', '隐藏已关闭');
    await waitFor(
      win,
      "![...document.querySelectorAll('.ant-checkbox-wrapper')].find((element) => element.textContent.trim() === '隐藏已关闭')?.querySelector('input')?.checked",
      'show closed jobs filter',
    );
    await openMoreMenu(win, expected.edited_name);
    await clickExactText(win, '.ant-dropdown-menu-item', '关闭');
    await waitFor(
      win,
      "document.querySelector('[aria-label=\"岗位关闭原因\"]')",
      'close job confirmation',
    );
    const closeReasonOpened = await evaluate(win, `(() => {
      const labelled = document.querySelector('[aria-label="岗位关闭原因"]');
      const select = labelled?.closest('.ant-select') || labelled;
      const trigger = select?.querySelector('.ant-select-selector') || select;
      if (!trigger) return false;
      trigger.scrollIntoView({ block: 'center', inline: 'nearest' });
      trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
      trigger.click();
      return true;
    })()`);
    assert.equal(closeReasonOpened, true, 'job close reason select must open through its visible trigger');
    await waitFor(
      win,
      "[...document.querySelectorAll('.ant-select-dropdown')].some((element) => element.offsetParent !== null)",
      'job close reason options',
    );
    await clickExactText(
      win,
      '.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option',
      '岗位需求已变化',
    );
    const closeNote = 'B-4 合成运行期验证：保留 JD、画像与历史后重新开启。';
    await setControlValue(win, 'textarea[aria-label="岗位关闭备注"]', closeNote);
    const closeContract = await evaluate(win, `(() => {
      const dialog = [...document.querySelectorAll('.ant-modal-confirm')]
        .find((element) => element.offsetParent !== null);
      const ok = [...(dialog?.querySelectorAll('.ant-modal-confirm-btns button') || [])]
        .find((button) => (button.textContent || '').trim() === '关闭');
      return {
        visible: Boolean(dialog),
        text: (dialog?.textContent || '').replace(/\\s+/g, ' ').trim(),
        ok_danger: Boolean(ok?.classList.contains('ant-btn-dangerous')),
        selected_reason: dialog?.querySelector('.ant-select-selection-item')?.textContent.trim() || '',
        note: dialog?.querySelector('textarea[aria-label="岗位关闭备注"]')?.value || '',
      };
    })()`);
    assert.equal(closeContract.visible, true);
    assert.equal(closeContract.ok_danger, true);
    assert.equal(closeContract.selected_reason, '岗位需求已变化');
    assert.equal(closeContract.note, closeNote);
    assert.match(closeContract.text, /不会删除候选人、JD、画像、测评、面试、Offer 或招聘历史/);
    const closeConfirmationScreenshot = await capture(win, 'B-4-close-confirmation-1280x800');
    const statusPath = `/jobs/${seed.job_id}/status`;
    const closeRequestCount = requestsFor(statusPath).length;
    await clickExactText(win, '.ant-modal-confirm-btns button', '关闭');
    const closeRequest = await waitForRequest(statusPath, closeRequestCount, 'job close mutation');
    assert.equal(closeRequest.body.status, 'closed');
    assert.equal(closeRequest.body.close_reason_code, 'changed');
    assert.equal(closeRequest.body.close_note, closeNote);
    await waitFor(
      win,
      `(() => {
        const action = [...document.querySelectorAll('button[aria-label]')]
          .find((element) => element.offsetParent !== null
            && element.getAttribute('aria-label') === ${JSON.stringify(`打开 ${expected.edited_name} 的更多操作`)});
        const row = action?.closest('tr, .job-ledger-compact-item');
        return Boolean(row && row.textContent.includes('已关闭') && row.textContent.includes('岗位需求已变化'));
      })()`,
      'closed job ledger projection',
      45_000,
    );
    const closedApi = await readJobs(win);
    assert.equal(closedApi.status, 200);
    const closedAuthoritative = closedApi.body.jobs.find((job) => Number(job.id) === Number(seed.job_id));
    assert.equal(closedAuthoritative.status, 'closed');
    assert.equal(closedAuthoritative.close_reason_code, 'changed');
    assert.equal(closedAuthoritative.close_note, closeNote);

    await clickSelector(
      win,
      `button[aria-label=${JSON.stringify(`管理 ${expected.edited_name} 的 JD 和画像`)}]`,
      'manage closed job',
    );
    await waitFor(
      win,
      `document.querySelector('[data-job-editor-heading]')?.textContent.trim() === ${JSON.stringify(expected.edited_name)}
        && [...document.querySelectorAll('.job-management-hero .ant-tag')]
          .some((element) => element.textContent.trim() === '只读')`,
      'closed job read-only editor',
      45_000,
    );
    const closedEditor = await evaluate(win, `(() => ({
      title: document.querySelector('[data-job-editor-heading]')?.textContent.trim() || '',
      tags: [...document.querySelectorAll('.job-management-hero .ant-tag')].map((element) => element.textContent.trim()),
      jd_editor_present: Boolean(document.querySelector('textarea[aria-label="JD 正文"]')),
      save_jd_present: [...document.querySelectorAll('button')]
        .some((element) => element.offsetParent !== null && element.textContent.trim() === '保存 JD 草稿'),
      active_jd_visible: document.querySelector('.job-management-shell')?.textContent.includes(${JSON.stringify(expected.jd_text)}) || false,
    }))()`);
    assert.deepEqual(closedEditor.tags, ['已关闭', '正式数据', '只读']);
    assert.equal(closedEditor.jd_editor_present, false);
    assert.equal(closedEditor.save_jd_present, false);
    assert.equal(closedEditor.active_jd_visible, true);
    const closedReadOnlyScreenshot = await capture(win, 'B-4-closed-readonly-1280x800');

    await clickExactText(win, 'button', '返回岗位台账');
    await waitFor(
      win,
      "[...document.querySelectorAll('.ant-checkbox-wrapper')].some((element) => element.textContent.trim() === '隐藏已关闭')",
      'job ledger filter after read-only editor',
    );
    const hideClosedAfterReturn = await evaluate(
      win,
      "Boolean([...document.querySelectorAll('.ant-checkbox-wrapper')].find((element) => element.textContent.trim() === '隐藏已关闭')?.querySelector('input')?.checked)",
    );
    if (hideClosedAfterReturn) {
      await clickExactText(win, '.ant-checkbox-wrapper', '隐藏已关闭');
    }
    await waitFor(
      win,
      `document.querySelector('button[aria-label=${JSON.stringify(`打开 ${expected.edited_name} 的更多操作`)}]')`,
      'closed job ledger return',
    );
    await openMoreMenu(win, expected.edited_name);
    await clickExactText(win, '.ant-dropdown-menu-item', '重新开启');
    await waitFor(
      win,
      "[...document.querySelectorAll('.ant-modal-confirm')].some((element) => element.offsetParent !== null && element.textContent.includes('只恢复岗位为招聘中'))",
      'reopen confirmation',
    );
    const reopenRequestCount = requestsFor(statusPath).length;
    await clickExactText(win, '.ant-modal-confirm-btns button', '重新开启');
    const reopenRequest = await waitForRequest(statusPath, reopenRequestCount, 'job reopen mutation');
    assert.equal(reopenRequest.body.status, 'open');
    await waitFor(
      win,
      `(() => {
        const action = [...document.querySelectorAll('button[aria-label]')]
          .find((element) => element.offsetParent !== null
            && element.getAttribute('aria-label') === ${JSON.stringify(`打开 ${expected.edited_name} 的更多操作`)});
        const row = action?.closest('tr, .job-ledger-compact-item');
        return Boolean(row && row.textContent.includes('招聘中') && row.textContent.includes('已关闭 → 招聘中'));
      })()`,
      'reopened job ledger projection',
      45_000,
    );
    const reopenedRow = await jobRowSnapshot(win, expected.edited_name);
    assert.doesNotMatch(reopenedRow.text, /岗位需求已变化/);
    const reopenedScreenshot = await capture(win, 'B-4-reopened-with-copy-1280x800');

    assert.deepEqual(telemetry.mutationRequests.map((request) => request.request_path), [
      editPath,
      jdCreatePath,
      jdActivatePath,
      profileCreatePath,
      profileConfirmPath,
      copyPath,
      statusPath,
      statusPath,
    ]);
    assert.ok(telemetry.mutationRequests.every((request) => [200, 201].includes(request.response_status)));

    return {
      ok: true,
      evidence_level: 'E4',
      synthetic_data_only: true,
      runtime_boundary: 'real HRBOSS Electron + trusted preload + authenticated local API + SQLite',
      viewport: [1280, 800],
      before: {
        row: initialRow,
        name: expected.original_name,
        hr_owner: 'B-4 合成 HR',
        planned_hires: 2,
        department: 'B-4 合成研发部',
        location: 'B-4 合成杭州',
        jd_versions: 0,
        profile_versions: 0,
        job_count: 1,
      },
      after: {
        edited_row: editedRow,
        copied_row: copiedRow,
        reopened_row: reopenedRow,
        name: expected.edited_name,
        hr_owner: expected.hr_owner,
        planned_hires: expected.planned_hires,
        department: expected.department,
        location: expected.location,
        jd_status: 'active',
        profile_status: 'confirmed',
        original_status: 'open',
        copied_status: 'draft',
        job_count: 2,
      },
      version_contract: {
        jd_activation_expected_version: jdActivateRequest.body.expectedVersion,
        profile_confirmation_expected_version: profileConfirmRequest.body.expectedVersion,
      },
      close_contract: closeContract,
      closed_authoritative_projection: {
        status: closedAuthoritative.status,
        close_reason_code: closedAuthoritative.close_reason_code,
        close_note: closedAuthoritative.close_note,
      },
      closed_editor: closedEditor,
      requests: telemetry.mutationRequests,
      screenshots: [
        initialScreenshot,
        editedScreenshot,
        activeJdScreenshot,
        confirmedProfileScreenshot,
        copiedScreenshot,
        closeConfirmationScreenshot,
        closedReadOnlyScreenshot,
        reopenedScreenshot,
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
