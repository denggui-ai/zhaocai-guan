'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shanghaiDatePickerValue(iso) {
  // The fixture uses Shanghai wall time (UTC+08:00), independent of the host TZ.
  return new Date(Date.parse(iso) + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
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
      const labelled = [...document.querySelectorAll(${JSON.stringify(selector)})]
        .find((element) => element.offsetParent !== null);
      const input = labelled instanceof HTMLInputElement || labelled instanceof HTMLTextAreaElement
        ? labelled
        : labelled?.closest('.ant-select')?.querySelector('input');
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

  async function setDatePicker(win, value) {
    await clickSelector(win, 'input[aria-label="面试时间"]', 'interview date picker');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['meta'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['meta'] });
    win.webContents.insertText(value);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
    await waitFor(
      win,
      `document.querySelector('input[aria-label="面试时间"]')?.value.includes(${JSON.stringify(value.slice(0, 16))})`,
      `date picker value ${value}`,
    );
  }

  async function chooseSelectOption(win, ariaLabel, optionText) {
    const opened = await evaluate(win, `(() => {
      const input = [...document.querySelectorAll(${JSON.stringify(`[aria-label="${ariaLabel}"]`)})]
        .find((element) => element.offsetParent !== null);
      if (!input) return { ok: false, reason: 'input-missing' };
      const visibleOption = [...document.querySelectorAll('.ant-select-item-option-content')]
        .find((element) => element.offsetParent !== null && (element.textContent || '').includes(${JSON.stringify(optionText)}));
      if (!visibleOption) {
        const selector = input.closest('.ant-select')?.querySelector('.ant-select-selector') || input;
        selector.scrollIntoView({ block: 'center', inline: 'nearest' });
        selector.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
        selector.click();
      }
      return { ok: true };
    })()`);
    assert.equal(opened.ok, true, `missing select ${ariaLabel}: ${opened.reason || ''}`);
    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-select-item-option-content')]
        .some((element) => element.offsetParent !== null && (element.textContent || '').includes(${JSON.stringify(optionText)}))`,
      `${ariaLabel} option ${optionText}`,
    );
    if (ariaLabel === '参与面试官') {
      await setControlValue(win, '[aria-label="参与面试官"]', optionText);
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ARROWDOWN' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ARROWDOWN' });
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
    } else {
      const clicked = await evaluate(win, `(() => {
        const content = [...document.querySelectorAll('.ant-select-item-option-content')]
          .find((element) => element.offsetParent !== null && (element.textContent || '').includes(${JSON.stringify(optionText)}));
        content?.click();
        return Boolean(content);
      })()`);
      assert.equal(clicked, true, `could not select ${ariaLabel} option ${optionText}`);
    }
    await waitFor(
      win,
      `(() => {
        const input = [...document.querySelectorAll(${JSON.stringify(`[aria-label="${ariaLabel}"]`)})]
          .find((element) => element.offsetParent !== null);
        return (input?.closest('.ant-select')?.textContent || '').includes(${JSON.stringify(optionText)});
      })()`,
      `${ariaLabel} selected value ${optionText}`,
    );
    if (ariaLabel === '参与面试官') {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESCAPE' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESCAPE' });
      await waitFor(
        win,
        "![...document.querySelectorAll('.ant-select-dropdown')].some((element) => element.offsetParent !== null)",
        'participant select dropdown closed',
      );
    }
    await delay(120);
  }

  async function ensurePanelExpanded(win, label, visibleSelector) {
    const alreadyVisible = await evaluate(
      win,
      `[...document.querySelectorAll(${JSON.stringify(visibleSelector)})].some((element) => element.offsetParent !== null)`,
    );
    if (!alreadyVisible) await clickExactText(win, '.ant-collapse-header-text', label);
    await waitFor(
      win,
      `[...document.querySelectorAll(${JSON.stringify(visibleSelector)})].some((element) => element.offsetParent !== null)`,
      `${label} panel`,
    );
  }

  async function ensureSessionExpanded(win, candidateName) {
    const state = await evaluate(win, `(() => {
      const header = [...document.querySelectorAll('.ant-collapse-header')]
        .find((element) => element.offsetParent !== null && (element.textContent || '').includes(${JSON.stringify(candidateName)}));
      const item = header?.closest('.ant-collapse-item');
      if (header && item && !item.classList.contains('ant-collapse-item-active')) {
        header.scrollIntoView({ block: 'center', inline: 'nearest' });
        header.click();
      }
      return { found: Boolean(header), active: Boolean(item?.classList.contains('ant-collapse-item-active')) };
    })()`);
    assert.equal(state.found, true, `missing session header for ${candidateName}`);
    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-collapse-item-active [data-session-id]')]
        .some((element) => element.offsetParent !== null && (element.textContent || '').includes(${JSON.stringify(candidateName)}))`,
      `expanded session ${candidateName}`,
    );
  }

  async function visibleSessionId(win, candidateName) {
    const value = await evaluate(win, `(() => {
      const card = [...document.querySelectorAll('[data-session-id]')]
        .find((element) => element.offsetParent !== null && (element.textContent || '').includes(${JSON.stringify(candidateName)}));
      return card?.getAttribute('data-session-id') || '';
    })()`);
    assert.match(String(value), /^\d+$/, `missing session id for ${candidateName}`);
    return Number(value);
  }

  async function ensureLogisticsExpanded(win) {
    const visible = await evaluate(
      win,
      "[...document.querySelectorAll('.ant-card-head-title')].some((element) => element.offsetParent !== null && element.textContent.trim() === '当前面试物流')",
    );
    if (!visible) await clickExactText(win, '.ant-collapse-header-text', '邀请、物流与历史');
    await waitFor(
      win,
      "[...document.querySelectorAll('.ant-card-head-title')].some((element) => element.offsetParent !== null && element.textContent.trim() === '当前面试物流')",
      'interview logistics details',
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

  async function confirmPopconfirm(win, buttonText, confirmationText, requestPath, label) {
    const previousCount = requestsFor(requestPath).length;
    await clickExactText(win, 'button', buttonText);
    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-popconfirm-buttons button')]
        .some((element) => element.offsetParent !== null && element.textContent.trim() === ${JSON.stringify(confirmationText)})`,
      `${label} confirmation`,
    );
    await clickExactText(win, '.ant-popconfirm-buttons button', confirmationText);
    return waitForRequest(requestPath, previousCount, label);
  }

  async function createSession(win, candidateName, candidateOption, formatLabel) {
    await ensurePanelExpanded(win, '新建面试', '[aria-label="创建面试候选人"]');
    await chooseSelectOption(win, '创建面试候选人', candidateOption);
    await chooseSelectOption(win, '创建面试形式', formatLabel);
    const previousCount = requestsFor('/interview-session').length;
    await clickExactText(win, 'button', '创建首轮面试');
    const request = await waitForRequest('/interview-session', previousCount, `create session for ${candidateName}`);
    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-collapse-header')]
        .some((element) => element.textContent.includes(${JSON.stringify(candidateName)})
          && element.textContent.includes('待排期'))`,
      `draft session for ${candidateName}`,
    );
    await ensureSessionExpanded(win, candidateName);
    return { request, sessionId: await visibleSessionId(win, candidateName) };
  }

  async function fillCommonSchedule(win, {
    date,
    formatLabel,
    duration,
    lead,
    participants,
    note,
  }) {
    await setDatePicker(win, date);
    await chooseSelectOption(win, '排期面试形式', formatLabel);
    await setControlValue(win, 'input[aria-label="面试时长（分钟）"]', String(duration));
    await chooseSelectOption(win, '主面试官', lead);
    for (const participant of participants) {
      await chooseSelectOption(win, '参与面试官', participant);
    }
    await setControlValue(win, 'textarea[aria-label="面试物流说明"]', note);
  }

  async function runJourney() {
    const win = await waitForWindow();
    win.webContents.setBackgroundThrottling(false);
    win.setContentSize(1280, 800);
    win.show();
    win.focus();
    await waitFor(win, "Boolean(window.localApi?.request)", 'trusted local API bridge', 45_000);
    await waitFor(win, "document.querySelector('button.nav-item')", 'main navigation', 45_000);
    await clickExactText(win, 'button.nav-item', '面试安排');
    await waitFor(
      win,
      `document.querySelector('.interview-schedule-canonical')?.textContent.includes(${JSON.stringify(expected.job_name)})`,
      'synthetic interview workspace',
      45_000,
    );

    await ensurePanelExpanded(win, '管理面试官', 'input[aria-label="新增面试官姓名"]');
    for (const interviewer of expected.interviewers) {
      await setControlValue(win, 'input[aria-label="新增面试官姓名"]', interviewer);
      const previousCount = requestsFor('/interviewers').length;
      await clickExactText(win, 'button', '新增面试官');
      const request = await waitForRequest('/interviewers', previousCount, `create interviewer ${interviewer}`);
      assert.equal(request.body.name, interviewer);
      await waitFor(
        win,
        `[...document.querySelectorAll('.ant-tag')]
          .some((element) => element.offsetParent !== null && element.textContent.includes(${JSON.stringify(interviewer)}))`,
        `interviewer tag ${interviewer}`,
      );
    }

    const primaryCreated = await createSession(
      win,
      expected.primary_name,
      expected.primary_name,
      '线上面试',
    );
    assert.equal(primaryCreated.request.body.candidateId, seed.candidates.primary);
    assert.equal(primaryCreated.request.body.interviewFormat, 'online');
    await scrollVisibleTextIntoView(win, '[data-session-id]', expected.primary_name);
    const draftScreenshot = await capture(win, 'B-5-interviewers-and-draft-1280x800');

    await fillCommonSchedule(win, {
      date: shanghaiDatePickerValue(expected.first_schedule),
      formatLabel: '线上面试',
      duration: 45,
      lead: expected.interviewers[0],
      participants: [expected.interviewers[1], expected.interviewers[2]],
      note: 'B-5 首次线上面试合成物流说明',
    });
    await setControlValue(win, 'input[aria-label="会议平台"]', 'B-5 合成会议平台');
    await setControlValue(win, 'input[aria-label="会议链接"]', expected.online_link);
    const firstScheduleCount = requestsFor('/interview-session/schedule').length;
    await clickExactText(win, 'button', '人工确认排期');
    const firstSchedule = await waitForRequest(
      '/interview-session/schedule',
      firstScheduleCount,
      'online interview schedule',
    );
    assert.equal(firstSchedule.body.sessionId, primaryCreated.sessionId);
    assert.equal(firstSchedule.body.logistics.interviewFormat, 'online');
    assert.equal(firstSchedule.body.logistics.interviewerAssignments.length, 3);
    assert.equal(firstSchedule.body.logistics.interviewerAssignments.filter((item) => item.role === 'lead').length, 1);
    assert.equal(firstSchedule.body.logistics.meetingLink, expected.online_link);
    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-collapse-header')]
        .some((element) => element.textContent.includes(${JSON.stringify(expected.primary_name)})
          && element.textContent.includes('已排期'))`,
      'online scheduled projection',
    );
    await ensureSessionExpanded(win, expected.primary_name);
    await ensureLogisticsExpanded(win);
    await scrollVisibleTextIntoView(win, '.ant-card', '当前面试物流');
    const onlineScreenshot = await capture(win, 'B-5-online-scheduled-multi-1280x800');

    const invitation = await confirmPopconfirm(
      win,
      '标记已手工发送',
      '确认已发送',
      '/interview-session/invitation-sent',
      'manual invitation fact',
    );
    assert.equal(invitation.body.sessionId, primaryCreated.sessionId);
    await chooseSelectOption(win, '候选人确认状态', '候选人已确认');
    const candidateConfirmation = await confirmPopconfirm(
      win,
      '记录候选人反馈',
      '确认记录',
      '/interview-session/candidate-confirmation',
      'candidate confirmation fact',
    );
    assert.equal(candidateConfirmation.body.status, 'confirmed');
    await waitFor(
      win,
      `document.querySelector('[data-session-id="${primaryCreated.sessionId}"]')?.textContent.includes('已发送')
        && document.querySelector('[data-session-id="${primaryCreated.sessionId}"]')?.textContent.includes('候选人已确认')`,
      'invitation sent and candidate confirmed projection',
    );
    await scrollVisibleTextIntoView(win, '.ant-card', '邀请发送与候选人反馈');
    const confirmationScreenshot = await capture(win, 'B-5-invitation-confirmed-1280x800');

    await scrollVisibleTextIntoView(win, '.ant-card', '人工改期与物流');
    await fillCommonSchedule(win, {
      date: shanghaiDatePickerValue(expected.second_schedule),
      formatLabel: '线下面试',
      duration: 60,
      lead: expected.interviewers[1],
      participants: [expected.interviewers[0]],
      note: 'B-5 线下改期后的合成物流说明',
    });
    await setControlValue(win, 'input[aria-label="面试地址"]', expected.offline_address);
    await setControlValue(win, 'input[aria-label="房间"]', expected.offline_room);
    const reschedule = await confirmPopconfirm(
      win,
      '人工确认改期',
      '确认改期',
      '/interview-session/schedule',
      'offline interview reschedule',
    );
    assert.equal(reschedule.body.sessionId, primaryCreated.sessionId);
    assert.equal(reschedule.body.logistics.interviewFormat, 'offline');
    assert.equal(reschedule.body.logistics.meetingLink, '');
    assert.equal(reschedule.body.logistics.locationAddress, expected.offline_address);
    await waitFor(
      win,
      `document.querySelector('[data-session-id="${primaryCreated.sessionId}"]')?.textContent.includes(${JSON.stringify(expected.offline_address)})
        && document.querySelector('[data-session-id="${primaryCreated.sessionId}"]')?.textContent.includes('未标记发送')
        && document.querySelector('[data-session-id="${primaryCreated.sessionId}"]')?.textContent.includes('待候选人确认')`,
      'reschedule reset projection',
    );
    await ensureLogisticsExpanded(win);
    await scrollVisibleTextIntoView(win, '.ant-card', '当前面试物流');
    const rescheduleScreenshot = await capture(win, 'B-5-offline-rescheduled-reset-1280x800');

    await chooseSelectOption(win, '取消原因', '候选人爽约');
    const noShow = await confirmPopconfirm(
      win,
      '取消本轮',
      '确认取消',
      '/interview-lifecycle/withdraw',
      'candidate no-show cancellation',
    );
    assert.equal(noShow.body.reasonCode, 'candidate_no_show');
    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-collapse-header')]
        .some((element) => element.textContent.includes(${JSON.stringify(expected.primary_name)})
          && element.textContent.includes('已取消'))`,
      'candidate no-show cancelled projection',
    );
    await ensureSessionExpanded(win, expected.primary_name);
    await ensureLogisticsExpanded(win);
    await scrollVisibleTextIntoView(win, '[data-session-id]', expected.primary_name);
    const noShowScreenshot = await capture(win, 'B-5-no-show-history-1280x800');

    const secondaryCreated = await createSession(
      win,
      expected.secondary_name,
      expected.secondary_name,
      '电话面试',
    );
    assert.equal(secondaryCreated.request.body.candidateId, seed.candidates.secondary);
    assert.equal(secondaryCreated.request.body.interviewFormat, 'phone');
    await ensureSessionExpanded(win, expected.secondary_name);
    await fillCommonSchedule(win, {
      date: shanghaiDatePickerValue(expected.phone_schedule),
      formatLabel: '电话面试',
      duration: 30,
      lead: expected.interviewers[0],
      participants: [expected.interviewers[1]],
      note: 'B-5 电话面试合成物流说明',
    });
    const phoneScheduleCount = requestsFor('/interview-session/schedule').length;
    await clickExactText(win, 'button', '人工确认排期');
    const phoneSchedule = await waitForRequest('/interview-session/schedule', phoneScheduleCount, 'phone interview schedule');
    assert.equal(phoneSchedule.body.sessionId, secondaryCreated.sessionId);
    assert.equal(phoneSchedule.body.logistics.interviewFormat, 'phone');
    assert.equal(phoneSchedule.body.logistics.meetingLink, '');
    assert.equal(phoneSchedule.body.logistics.locationAddress, '');
    await waitFor(
      win,
      `document.querySelector('[data-session-id="${secondaryCreated.sessionId}"]')?.textContent.includes('电话面试')
        && document.querySelector('[data-session-id="${secondaryCreated.sessionId}"]')?.textContent.includes('已排期')`,
      'phone scheduled projection',
    );
    await ensureLogisticsExpanded(win);
    await scrollVisibleTextIntoView(win, '.ant-card', '当前面试物流');
    const phoneScreenshot = await capture(win, 'B-5-phone-scheduled-1280x800');

    await chooseSelectOption(win, '取消原因', '候选人取消');
    const candidateCancelled = await confirmPopconfirm(
      win,
      '取消本轮',
      '确认取消',
      '/interview-lifecycle/withdraw',
      'candidate cancellation',
    );
    assert.equal(candidateCancelled.body.reasonCode, 'candidate_cancelled');
    await waitFor(
      win,
      `[...document.querySelectorAll('.ant-collapse-header')]
        .some((element) => element.textContent.includes(${JSON.stringify(expected.secondary_name)})
          && element.textContent.includes('已取消'))`,
      'candidate cancelled projection',
    );
    await ensureSessionExpanded(win, expected.secondary_name);
    await scrollVisibleTextIntoView(win, '[data-session-id]', expected.secondary_name);
    const candidateCancelledScreenshot = await capture(win, 'B-5-candidate-cancelled-1280x800');

    assert.deepEqual(telemetry.mutationRequests.map((request) => request.request_path), [
      '/interviewers',
      '/interviewers',
      '/interviewers',
      '/interview-session',
      '/interview-session/schedule',
      '/interview-session/invitation-sent',
      '/interview-session/candidate-confirmation',
      '/interview-session/schedule',
      '/interview-lifecycle/withdraw',
      '/interview-session',
      '/interview-session/schedule',
      '/interview-lifecycle/withdraw',
    ]);
    assert.ok(telemetry.mutationRequests.every((request) => [200, 201].includes(request.response_status)));

    return {
      ok: true,
      evidence_level: 'E4',
      synthetic_data_only: true,
      runtime_boundary: 'real HRBOSS Electron + trusted preload + authenticated local API + SQLite',
      viewport: [1280, 800],
      sessions: {
        primary: primaryCreated.sessionId,
        secondary: secondaryCreated.sessionId,
      },
      verified_actions: [
        'create_interview',
        'schedule_online',
        'multiple_interviewers',
        'mark_invitation_sent',
        'record_candidate_confirmation',
        'reschedule_offline',
        'invitation_confirmation_reset',
        'candidate_no_show',
        'schedule_phone',
        'candidate_cancelled',
      ],
      requests: telemetry.mutationRequests,
      screenshots: [
        draftScreenshot,
        onlineScreenshot,
        confirmationScreenshot,
        rescheduleScreenshot,
        noShowScreenshot,
        phoneScreenshot,
        candidateCancelledScreenshot,
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
