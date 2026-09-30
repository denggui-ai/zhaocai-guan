'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = __dirname;
const distRoot = path.resolve(process.env.HRBOSS_JOB_PRIORITY_DIST || '');
const userData = path.resolve(process.env.HRBOSS_JOB_PRIORITY_USER_DATA || '');
const evidenceDir = path.resolve(process.env.HRBOSS_JOB_PRIORITY_EVIDENCE || '');
const resultPath = path.resolve(process.env.HRBOSS_JOB_PRIORITY_RESULT || '');

const ACTION_SCHEMA_IDS = Object.freeze([
  'navigate-section',
  'edit-draft',
  'reset-draft',
  'optimize-jd',
  'copy-jd',
  'save-jd-draft',
  'activate-jd-version',
  'save-profile-draft',
  'confirm-profile-version',
  'refresh-data',
]);

if (!distRoot || !userData || !evidenceDir || !resultPath) throw new Error('isolated runtime paths are required');
app.setPath('userData', userData);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(win, expression, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await delay(80);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function clickExactText(win, selector, text) {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((element) => (element.textContent || '').trim() === ${JSON.stringify(text)});
    if (!target) return false;
    target.focus();
    target.click();
    return true;
  })()`);
  assert.equal(clicked, true, `missing control: ${text}`);
}

async function capture(win, name) {
  await delay(120);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const image = await win.capturePage();
      const target = path.join(evidenceDir, `${name}.png`);
      fs.writeFileSync(target, image.toPNG(), { mode: 0o600 });
      return target;
    } catch (error) {
      lastError = error;
      await delay(160);
    }
  }
  throw new Error(`capture ${name} failed: ${lastError?.stack || lastError?.message || lastError}`);
}

async function inspectWorkspace(win) {
  return win.webContents.executeJavaScript(`(() => {
    const workspace = document.querySelector('.job-management-shell[data-job-management-action-schema]');
    const tabs = workspace?.querySelector('.job-management-section-tabs');
    const box = workspace?.getBoundingClientRect();
    const tabsBox = tabs?.getBoundingClientRect();
    const editorHeading = workspace?.querySelector('[data-job-editor-heading]');
    const editorControls = [...(workspace?.querySelectorAll('.job-management-local-edit-card input, .job-management-local-edit-card textarea') || [])];
    const jdActionButtons = [...(workspace?.querySelectorAll('.job-management-jd-actions button') || [])];
    return {
      viewport: [innerWidth, innerHeight],
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      workspaceOverflow: workspace ? workspace.scrollWidth - workspace.clientWidth : null,
      bounds: box ? { left: box.left, right: box.right } : null,
      tabsBounds: tabsBox ? { left: tabsBox.left, right: tabsBox.right } : null,
      bodyTitles: [...(workspace?.querySelectorAll('h3') || [])].map((heading) => (heading.textContent || '').trim()),
      editorHeadingText: (editorHeading?.textContent || '').trim(),
      editorHeadingFocused: document.activeElement === editorHeading,
      routeAnnouncement: (document.querySelector('.module-route-announcer')?.textContent || '').trim(),
      actionSchema: String(workspace?.dataset.jobManagementActionSchema || '').split(',').filter(Boolean),
      sectionLabels: [...(tabs?.querySelectorAll('label') || [])].map((label) => (label.textContent || '').trim()),
      selectedSection: (tabs?.querySelector('input:checked')?.closest('label')?.textContent || '').trim(),
      returnCount: [...(workspace?.querySelectorAll('button') || [])]
        .filter((button) => (button.textContent || '').trim() === '返回岗位台账').length,
      fixtureLabelVisible: (workspace?.textContent || '').includes('Fixture · 隔离模拟'),
      readOnlyLabelVisible: (workspace?.textContent || '').includes('只读'),
      jdVisible: Boolean(workspace?.querySelector('.job-management-jd-workspace')),
      profileVisible: Boolean(workspace?.querySelector('.job-management-profile-workspace')),
      editorControlCount: editorControls.length,
      editorControlsDisabled: editorControls.every((control) => control.disabled),
      jdActionLabels: jdActionButtons.map((button) => (button.textContent || '').trim()),
      jdActionsDisabled: jdActionButtons.every((button) => button.disabled),
    };
  })()`);
}

async function localStorageSnapshot(win) {
  return win.webContents.executeJavaScript(`Object.fromEntries(
    Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter(Boolean)
      .sort()
      .map((key) => [key, localStorage.getItem(key)])
  )`);
}

function assertHorizontalFit(layout) {
  assert.ok(layout.documentOverflow <= 1, `document horizontal overflow: ${layout.documentOverflow}px`);
  assert.ok(layout.workspaceOverflow <= 1, `workspace horizontal overflow: ${layout.workspaceOverflow}px`);
  assert.ok(layout.bounds.left >= -1 && layout.bounds.right <= layout.viewport[0] + 1,
    `workspace bounds ${JSON.stringify(layout.bounds)} exceed viewport ${JSON.stringify(layout.viewport)}`);
  assert.ok(layout.tabsBounds.left >= -1 && layout.tabsBounds.right <= layout.viewport[0] + 1,
    `section navigation bounds ${JSON.stringify(layout.tabsBounds)} exceed viewport ${JSON.stringify(layout.viewport)}`);
}

async function run() {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(ROOT, 'check-ui-visual-runtime-preload.js'),
      additionalArguments: ['--hrboss-runtime-scenario=job-priority'],
    },
  });
  win.setContentSize(1100, 720);
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event && (event.level === 'error' || Number(event.level) >= 3)) errors.push(event.message);
  });
  try {
    await win.loadFile(path.join(distRoot, 'index.html'));
    win.webContents.focus();
    await waitFor(win, "document.querySelector('button.nav-item')", 'navigation');
    await clickExactText(win, 'button.nav-item', '职位管理');
    await waitFor(win, "document.querySelector('.job-ledger-page')", 'job ledger');
    const keyboardSource = await win.webContents.executeJavaScript(`(() => {
      const target = [...document.querySelectorAll('[data-job-ledger-focus-action="manage"]')]
        .find((element) => element.offsetParent !== null);
      if (!target) return null;
      target.focus();
      return {
        jobId: target.dataset.jobLedgerFocusJobId,
        action: target.dataset.jobLedgerFocusAction,
        focused: document.activeElement === target,
      };
    })()`);
    assert.ok(keyboardSource?.jobId, 'visible keyboard job-management source must expose its job id');
    assert.equal(keyboardSource.action, 'manage');
    assert.equal(keyboardSource.focused, true);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await waitFor(win,
      "document.querySelector('.job-management-shell[data-job-management-action-schema]')",
      'shared fixture job workspace');
    await waitFor(win,
      "document.activeElement === document.querySelector('[data-job-editor-heading]')",
      'keyboard-opened editor heading focus');

    const runtimeBefore = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
    const storageBefore = await localStorageSnapshot(win);
    const initial = await inspectWorkspace(win);
    assert.deepEqual(initial.viewport, [1100, 720]);
    assert.deepEqual(initial.bodyTitles.length, 1, 'shared workspace must own one body job title');
    assert.ok(initial.bodyTitles[0], 'the single body job title must be visible');
    assert.equal(initial.editorHeadingFocused, true, 'keyboard entry must focus the visible job editor heading');
    assert.equal(initial.editorHeadingText, initial.bodyTitles[0]);
    assert.equal(initial.routeAnnouncement, `已进入岗位“${initial.editorHeadingText}”的 JD 与画像编辑视图`);
    assert.deepEqual(initial.actionSchema, ACTION_SCHEMA_IDS);
    assert.deepEqual(initial.sectionLabels, ['JD 与版本', '岗位画像']);
    assert.equal(initial.selectedSection, 'JD 与版本');
    assert.equal(initial.returnCount, 1);
    assert.equal(initial.fixtureLabelVisible, true);
    assert.equal(initial.readOnlyLabelVisible, true);
    assert.equal(initial.jdVisible, true);
    assert.equal(initial.profileVisible, false);
    assert.equal(initial.editorControlCount, 7);
    assert.equal(initial.editorControlsDisabled, true);
    assert.deepEqual(initial.jdActionLabels, [
      '模拟优化 JD',
      '一键复制',
      '模拟填入内容下方',
      '模拟替换原内容',
      '生成模拟手工发布稿',
    ]);
    assert.equal(initial.jdActionsDisabled, true);
    assertHorizontalFit(initial);

    const focusedSection = await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.job-management-section-tabs input:checked');
      input?.focus();
      return document.activeElement === input;
    })()`);
    assert.equal(focusedSection, true, 'JD section control must be keyboard focusable');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Right' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Right' });
    await waitFor(win, "document.querySelector('.job-management-profile-workspace')", 'keyboard-switched profile section');

    const profile = await win.webContents.executeJavaScript(`(() => {
      const workspace = document.querySelector('.job-management-shell[data-job-management-action-schema]');
      const buttons = [...workspace.querySelectorAll('.job-management-profile-workspace button')]
        .filter((button) => ['模拟保存岗位画像草稿', '模拟确认岗位画像版本'].includes((button.textContent || '').trim()));
      return {
        selectedSection: (workspace.querySelector('.job-management-section-tabs input:checked')?.closest('label')?.textContent || '').trim(),
        jdVisible: Boolean(workspace.querySelector('.job-management-jd-workspace')),
        profileVisible: Boolean(workspace.querySelector('.job-management-profile-workspace')),
        mutatingLabels: buttons.map((button) => (button.textContent || '').trim()),
        mutatingDisabled: buttons.every((button) => button.disabled),
        focusedSection: workspace.querySelector('.job-management-section-tabs input:checked') === document.activeElement,
      };
    })()`);
    assert.equal(profile.selectedSection, '岗位画像');
    assert.equal(profile.jdVisible, false);
    assert.equal(profile.profileVisible, true);
    assert.deepEqual(profile.mutatingLabels, ['模拟保存岗位画像草稿', '模拟确认岗位画像版本']);
    assert.equal(profile.mutatingDisabled, true);
    assert.equal(profile.focusedSection, true, 'keyboard section switch must retain focus in the section control');
    const evidence1100 = await capture(win, 'job-workspace-readonly-1100x720');

    win.setContentSize(1360, 768);
    win.webContents.setZoomFactor(1.25);
    await delay(240);
    const windows125 = await inspectWorkspace(win);
    assert.ok(Math.abs(windows125.viewport[0] - 1088) <= 1 && Math.abs(windows125.viewport[1] - 614) <= 1,
      `unexpected 125% effective viewport: ${JSON.stringify(windows125.viewport)}`);
    assertHorizontalFit(windows125);
    assert.equal(windows125.returnCount, 1);
    assert.deepEqual(windows125.actionSchema, ACTION_SCHEMA_IDS);
    const evidence125 = await capture(win, 'job-workspace-readonly-1360x768-windows125');

    win.webContents.setZoomFactor(1.5);
    await delay(240);
    const windows150 = await inspectWorkspace(win);
    assert.ok(Math.abs(windows150.viewport[0] - 906) <= 1 && Math.abs(windows150.viewport[1] - 512) <= 1,
      `unexpected 150% effective viewport: ${JSON.stringify(windows150.viewport)}`);
    assertHorizontalFit(windows150);
    assert.equal(windows150.returnCount, 1);
    assert.deepEqual(windows150.actionSchema, ACTION_SCHEMA_IDS);
    const evidence150 = await capture(win, 'job-workspace-readonly-1360x768-windows150');

    const storageAfter = await localStorageSnapshot(win);
    assert.deepEqual(storageAfter, storageBefore, 'fixture section navigation must not write localStorage');
    const keyboardReturnFocused = await win.webContents.executeJavaScript(`(() => {
      const target = [...document.querySelectorAll('.job-management-shell button')]
        .find((button) => (button.textContent || '').trim() === '返回岗位台账');
      target?.focus();
      return document.activeElement === target;
    })()`);
    assert.equal(keyboardReturnFocused, true, 'return-to-ledger control must accept keyboard focus');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await waitFor(win, "document.querySelector('.job-ledger-page') && !document.querySelector('.job-management-shell')", 'return to job ledger');
    await waitFor(win,
      `document.activeElement?.dataset.jobLedgerFocusJobId === ${JSON.stringify(keyboardSource.jobId)}
        && document.activeElement?.dataset.jobLedgerFocusAction === ${JSON.stringify(keyboardSource.action)}
        && document.activeElement?.offsetParent !== null`,
      'keyboard return focus to the same visible job action');
    const returnedToLedger = await win.webContents.executeJavaScript(`(() => ({
      ledgerVisible: Boolean(document.querySelector('.job-ledger-page')),
      manageEntryCount: [...document.querySelectorAll('.job-ledger-page button')]
        .filter((button) => (button.textContent || '').trim() === '管理 JD/画像' && button.getClientRects().length > 0).length,
      focusedJobId: document.activeElement?.dataset.jobLedgerFocusJobId || '',
      focusedAction: document.activeElement?.dataset.jobLedgerFocusAction || '',
      focusIsBody: document.activeElement === document.body,
      routeAnnouncement: (document.querySelector('.module-route-announcer')?.textContent || '').trim(),
    }))()`);
    assert.equal(returnedToLedger.ledgerVisible, true);
    assert.equal(returnedToLedger.manageEntryCount, 1);
    assert.equal(returnedToLedger.focusedJobId, keyboardSource.jobId);
    assert.equal(returnedToLedger.focusedAction, keyboardSource.action);
    assert.equal(returnedToLedger.focusIsBody, false);
    assert.equal(returnedToLedger.routeAnnouncement, '已返回岗位台账');

    const mouseSource = await win.webContents.executeJavaScript(`(() => {
      const target = [...document.querySelectorAll('[data-job-ledger-focus-action="name"]')]
        .find((element) => element.offsetParent !== null);
      if (!target) return null;
      const descriptor = {
        jobId: target.dataset.jobLedgerFocusJobId,
        action: target.dataset.jobLedgerFocusAction,
      };
      target.click();
      return descriptor;
    })()`);
    assert.ok(mouseSource?.jobId, 'visible mouse job-name source must expose its job id');
    assert.equal(mouseSource.action, 'name');
    await waitFor(win, "document.querySelector('.job-management-shell[data-job-management-action-schema]')", 'mouse-opened job editor');
    await waitFor(win,
      "document.activeElement === document.querySelector('[data-job-editor-heading]')",
      'mouse-opened editor heading focus');
    const mouseEditorFocus = await win.webContents.executeJavaScript(`(() => ({
      focusIsHeading: document.activeElement === document.querySelector('[data-job-editor-heading]'),
      focusIsBody: document.activeElement === document.body,
      editorHeadingText: (document.querySelector('[data-job-editor-heading]')?.textContent || '').trim(),
      routeAnnouncement: (document.querySelector('.module-route-announcer')?.textContent || '').trim(),
    }))()`);
    assert.equal(mouseEditorFocus.focusIsHeading, true);
    assert.equal(mouseEditorFocus.focusIsBody, false);
    assert.equal(mouseEditorFocus.routeAnnouncement,
      `已进入岗位“${mouseEditorFocus.editorHeadingText}”的 JD 与画像编辑视图`);

    const mouseReturnClicked = await win.webContents.executeJavaScript(`(() => {
      const target = [...document.querySelectorAll('.job-management-shell button')]
        .find((button) => (button.textContent || '').trim() === '返回岗位台账');
      if (!target) return false;
      target.click();
      return true;
    })()`);
    assert.equal(mouseReturnClicked, true);
    await waitFor(win, "document.querySelector('.job-ledger-page') && !document.querySelector('.job-management-shell')", 'mouse return to job ledger');
    await waitFor(win,
      `document.activeElement?.dataset.jobLedgerFocusJobId === ${JSON.stringify(mouseSource.jobId)}
        && document.activeElement?.dataset.jobLedgerFocusAction === ${JSON.stringify(mouseSource.action)}
        && document.activeElement?.offsetParent !== null`,
      'mouse return focus to the same visible job-name action');

    await win.webContents.executeJavaScript('window.runtimeInfo.failNextCandidateListRead()');
    const failedOpenSource = await win.webContents.executeJavaScript(`(() => {
      const target = [...document.querySelectorAll('[data-job-ledger-focus-action="manage"]')]
        .find((element) => element.offsetParent !== null);
      if (!target) return null;
      target.focus();
      return {
        jobId: target.dataset.jobLedgerFocusJobId,
        action: target.dataset.jobLedgerFocusAction,
        announcement: (document.querySelector('.module-route-announcer')?.textContent || '').trim(),
      };
    })()`);
    assert.ok(failedOpenSource?.jobId, 'failed-open source must be present');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await waitFor(win,
      "document.querySelector('.job-ledger-page [role=\"alert\"]')?.textContent.includes('岗位上下文未能完成切换')",
      'failed job open alert');
    const failedOpen = await win.webContents.executeJavaScript(`(() => ({
      ledgerVisible: Boolean(document.querySelector('.job-ledger-page')),
      editorVisible: Boolean(document.querySelector('.job-management-shell')),
      focusedJobId: document.activeElement?.dataset.jobLedgerFocusJobId || '',
      focusedAction: document.activeElement?.dataset.jobLedgerFocusAction || '',
      focusIsBody: document.activeElement === document.body,
      routeAnnouncement: (document.querySelector('.module-route-announcer')?.textContent || '').trim(),
    }))()`);
    assert.equal(failedOpen.ledgerVisible, true);
    assert.equal(failedOpen.editorVisible, false);
    assert.equal(failedOpen.focusedJobId, failedOpenSource.jobId);
    assert.equal(failedOpen.focusedAction, failedOpenSource.action);
    assert.equal(failedOpen.focusIsBody, false);
    assert.equal(failedOpen.routeAnnouncement, failedOpenSource.announcement,
      'failed open must not announce a route that was not entered');

    const runtimeAfter = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
    assert.equal(runtimeBefore.actionWriteCalls, 0);
    assert.equal(runtimeAfter.actionWriteCalls, 0, 'readonly fixture journey must not call production action writes');
    assert.deepEqual(errors, []);
    return {
      ok: true,
      actionSchema: ACTION_SCHEMA_IDS,
      initial,
      profile,
      windows125,
      windows150,
      returnedToLedger,
      mouseEditorFocus,
      failedOpen,
      productionActionWriteCalls: runtimeAfter.actionWriteCalls,
      fixtureStorageChanged: false,
      evidence: { at1100: evidence1100, windows125: evidence125, windows150: evidence150 },
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

app.whenReady().then(async () => {
  try {
    const result = await run();
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result));
  } catch (error) {
    fs.writeFileSync(resultPath, JSON.stringify({ ok: false, error: error.stack || error.message }, null, 2), { mode: 0o600 });
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
