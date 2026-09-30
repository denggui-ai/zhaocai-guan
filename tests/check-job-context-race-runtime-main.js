'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = PROJECT_ROOT;
const distRoot = path.resolve(process.env.HRBOSS_JOB_CONTEXT_RACE_DIST || '');
const userData = path.resolve(process.env.HRBOSS_JOB_CONTEXT_RACE_USER_DATA || '');
const resultPath = path.resolve(process.env.HRBOSS_JOB_CONTEXT_RACE_RESULT || '');
const JOB_A = Object.freeze({ id: '9911', name: '合成竞态岗位 A', candidate: '合成竞态候选人 A' });
const JOB_B = Object.freeze({ id: '9912', name: '合成竞态岗位 B', candidate: '合成竞态候选人 B' });
const CURRENT_JOB_STORAGE_KEY = 'hrboss.ui.currentJobId.v1';

if (!distRoot || !userData || !resultPath) throw new Error('isolated runtime paths are required');
app.setPath('userData', userData);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(win, expression, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(`Boolean(${expression})`)) return;
    await delay(40);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForRuntime(win, predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
    if (predicate(runtime)) return runtime;
    await delay(40);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function clickExactText(win, selector, text) {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((element) => element.offsetParent !== null
        && (element.textContent || '').trim() === ${JSON.stringify(text)});
    if (!target) return false;
    target.click();
    return true;
  })()`);
  assert.equal(clicked, true, `missing visible control: ${text}`);
}

async function readContext(win) {
  return win.webContents.executeJavaScript(`(() => ({
    selectedJobText: (document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent || '').trim(),
    persistedJobId: localStorage.getItem(${JSON.stringify(CURRENT_JOB_STORAGE_KEY)}),
    editorHeading: (document.querySelector('[data-job-editor-heading]')?.textContent || '').trim(),
    editorFocused: document.activeElement === document.querySelector('[data-job-editor-heading]'),
    announcement: (document.querySelector('.module-route-announcer')?.textContent || '').trim(),
  }))()`);
}

async function run() {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(ROOT, "tests/check-ui-visual-runtime-preload.js"),
      additionalArguments: ['--hrboss-runtime-scenario=job-context-race'],
    },
  });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event && (event.level === 'error' || Number(event.level) >= 3)) errors.push(event.message);
  });
  try {
    await win.loadFile(path.join(distRoot, 'index.html'));
    win.webContents.focus();
    await waitFor(win, "document.querySelector('button.nav-item')", 'main navigation');
    await clickExactText(win, 'button.nav-item', '职位管理');
    await waitFor(win,
      "document.querySelectorAll('.job-ledger-open-link').length >= 2",
      'two synthetic race jobs');

    const initial = await readContext(win);
    assert.match(initial.selectedJobText, new RegExp(JOB_A.name));
    assert.equal(initial.persistedJobId, JOB_A.id);

    await win.webContents.executeJavaScript(`window.runtimeInfo.configureJobContextRace({
      ${JSON.stringify(JOB_B.id)}: 700,
      ${JSON.stringify(JOB_A.id)}: 80
    })`);

    await clickExactText(win, '.job-ledger-open-link', JOB_B.name);
    await waitForRuntime(win,
      (runtime) => runtime.jobContextRace.requests.some((request) => String(request.jobId) === JOB_B.id),
      'slow B request start');
    await waitFor(win,
      `document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent.includes(${JSON.stringify(JOB_B.name)})
        && localStorage.getItem(${JSON.stringify(CURRENT_JOB_STORAGE_KEY)}) === ${JSON.stringify(JOB_B.id)}`,
      'intermediate B context and persistence');

    await clickExactText(win, '.job-ledger-open-link', JOB_A.name);
    await waitForRuntime(win,
      (runtime) => runtime.jobContextRace.requests.some((request) => String(request.jobId) === JOB_A.id),
      'fast A request start');
    await waitFor(win,
      `document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent.includes(${JSON.stringify(JOB_A.name)})
        && localStorage.getItem(${JSON.stringify(CURRENT_JOB_STORAGE_KEY)}) === ${JSON.stringify(JOB_A.id)}`,
      'final A context and persistence');
    await waitFor(win,
      `document.querySelector('[data-job-editor-heading]')?.textContent.trim() === ${JSON.stringify(JOB_A.name)}`,
      'A editor after the fast response');

    const runtime = await waitForRuntime(win,
      (snapshot) => snapshot.jobContextRace.requests.length === 2
        && snapshot.jobContextRace.requests.every((request) => request.completedSequence != null),
      'both inverse-order responses');
    const responseOrder = [...runtime.jobContextRace.requests]
      .sort((left, right) => left.completedSequence - right.completedSequence)
      .map((request) => String(request.jobId));
    assert.deepEqual(responseOrder, [JOB_A.id, JOB_B.id],
      'the later A request must complete before the older B request');
    await delay(120);

    const settled = await readContext(win);
    assert.match(settled.selectedJobText, new RegExp(JOB_A.name));
    assert.equal(settled.persistedJobId, JOB_A.id);
    assert.equal(settled.editorHeading, JOB_A.name);
    assert.equal(settled.editorFocused, true);
    assert.equal(settled.announcement, `已进入岗位“${JOB_A.name}”的 JD 与画像编辑视图`);

    await clickExactText(win, '.job-management-shell button', '返回岗位台账');
    await waitFor(win, "document.querySelector('.job-ledger-page')", 'return to ledger');
    await waitFor(win,
      `document.activeElement?.dataset.jobLedgerFocusJobId === ${JSON.stringify(JOB_A.id)}
        && document.activeElement?.dataset.jobLedgerFocusAction === 'name'`,
      'return focus descriptor from the winning A request');

    await clickExactText(win, 'button.nav-item', '候选人');
    await waitFor(win, "document.querySelector('.candidate-card')", 'candidate list after race');
    const candidates = await win.webContents.executeJavaScript(`(() => ({
      names: [...document.querySelectorAll('.candidate-card .candidate-name')]
        .map((element) => (element.textContent || '').trim()),
      selectedJobText: (document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent || '').trim(),
      persistedJobId: localStorage.getItem(${JSON.stringify(CURRENT_JOB_STORAGE_KEY)}),
    }))()`);
    assert.deepEqual(candidates.names, [JOB_A.candidate]);
    assert.doesNotMatch(candidates.names.join(' '), new RegExp(JOB_B.candidate));
    assert.match(candidates.selectedJobText, new RegExp(JOB_A.name));
    assert.equal(candidates.persistedJobId, JOB_A.id);
    assert.deepEqual(errors, []);

    return {
      ok: true,
      requestSequence: [JOB_A.id, JOB_B.id, JOB_A.id],
      responseOrder,
      settled,
      candidates,
      returnFocus: { jobId: JOB_A.id, action: 'name' },
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
