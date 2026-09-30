#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
}

const app = read('frontend/src/App.jsx');
const boundary = read('frontend/src/components/FeatureErrorBoundary.jsx');
const jobs = read('frontend/src/components/JobManagementPanel.jsx');

// Every lazy feature surface is below a feature-scoped boundary. Related
// fixture/formal implementations intentionally share their navigation boundary.
assert.match(app, /import FeatureErrorBoundary, \{ createRetryableLazy \} from '.\/components\/FeatureErrorBoundary\.jsx'/);
[
  'workbench:',
  'guide:',
  'jobs:',
  'interviews:',
  'talent:',
  'settings',
  'candidate-list:',
  'candidate-detail:',
  'deep-profile:',
  'screenshot-review:',
].forEach((featureKey) => assert.ok(app.includes(`featureKey={\`` + featureKey)
  || app.includes(`featureKey="${featureKey}"`), `missing feature boundary: ${featureKey}`));
assert.ok((app.match(/<FeatureErrorBoundary/g) || []).length >= 10);
[
  'CandidateList',
  'CandidateDetail',
  'JobLedgerPanel',
  'JobManagementDemo',
  'JobManagementPanel',
  'TalentPoolDemo',
  'SettingsPanel',
  'DeepProfileModal',
  'ScreenshotOcrReviewModal',
  'InterviewSchedulePanel',
  'InterviewScheduleCanonical',
].forEach((componentName) => {
  assert.match(app, new RegExp(`<${componentName}\\b`));
  assert.match(app, new RegExp(`const\\s+${componentName}\\s*=\\s*createRetryableLazy\\(`));
});

// Recovery is explicit, keyboard reachable, isolated, and resets when the
// selected feature context changes. No raw exception or external reporting is exposed.
assert.match(boundary, /static getDerivedStateFromError\(error\)/);
assert.match(boundary, /componentDidCatch\(\)[\s\S]*focusErrorHeading/);
assert.match(boundary, /previousProps\.featureKey !== this\.props\.featureKey/);
assert.match(boundary,
  /previousProps\.featureKey !== this\.props\.featureKey[\s\S]{0,180}this\.setState\(\{ error: null, retryKey: 0, retryToken: \{\} \}\)/,
  'feature-key recovery must replace the rejected lazy retry token');
assert.match(boundary, /this\.props\.focusOnError === false/);
assert.match(boundary, /retryKey: current\.retryKey \+ 1/);
assert.match(boundary, /<React\.Fragment key=\{retryKey\}>/);
assert.match(boundary, /export function createRetryableLazy\(loader\)/);
assert.match(boundary, /const LazyRetryContext = React\.createContext\(null\)/);
assert.match(boundary, /const lazyByRetryToken = new WeakMap\(\)/);
assert.match(boundary, /LazyComponent = React\.lazy\(loader\)/);
assert.match(boundary, /this\.state = \{ error: null, retryKey: 0, retryToken: null \}/,
  'the first lazy mount must use the stable unscoped lazy component');
assert.match(boundary,
  /handleRetry = \(\) => \{[\s\S]{0,180}retryToken: \{\}/,
  'manual retry must replace a rejected lazy component');
assert.match(boundary, /<LazyRetryContext\.Provider value=\{retryToken\}>/);
assert.match(boundary, /<h2 ref=\{this\.errorHeadingRef\} tabIndex=\{-1\}/);
assert.match(boundary, /role="alert"/);
assert.match(boundary, /重试不会自动提交任何招聘操作/);
assert.doesNotMatch(boundary, /Sentry|fetch\(|XMLHttpRequest|console\.|error\.message/);
assert.match(app, /featureKey=\{`candidate-list:[\s\S]{0,180}focusOnError=\{!candidateListCollapsed\}/);

// The formal job editor fails closed whenever authority is loading, failed,
// or stale. Read-only and closed-job locks remain additive.
assert.match(jobs, /const authorityWriteLocked = \['loading', 'error', 'stale'\]\.includes\(loadState\)/);
assert.match(jobs, /const writesLocked = readOnly \|\| authorityWriteLocked/);
assert.doesNotMatch(jobs, /!readOnly/);
assert.ok((jobs.match(/!writesLocked/g) || []).length >= 6);

const runStart = jobs.indexOf('async function run');
const runEnd = jobs.indexOf('async function saveJdDraft');
const runSource = jobs.slice(runStart, runEnd);
assert.ok(runStart >= 0 && runEnd > runStart);
assert.ok(runSource.indexOf('blockLockedWrite()') < runSource.indexOf('await fn()'));

const aiStart = jobs.indexOf('async function optimizeJdWithAi');
const aiEnd = jobs.indexOf('function restoreJdBeforeAi');
const aiSource = jobs.slice(aiStart, aiEnd);
assert.ok(aiStart >= 0 && aiEnd > aiStart);
assert.ok(aiSource.indexOf('blockLockedWrite()') < aiSource.indexOf('confirmExternalAiApproval'));

['createJobJdVersion', 'activateJobJdVersion', 'createJobProfileVersion', 'confirmJobProfileVersion']
  .forEach((apiName) => assert.match(jobs, new RegExp(`api\\.${apiName}`)));
assert.match(jobs, /职位权威数据尚未就绪，写操作已锁定/);
assert.match(jobs, /旧 JD、岗位画像和版本记录仍可查看/);
assert.match(jobs, /重新读取职位数据/);

// Previously loaded facts and immutable history remain present while writes are locked.
assert.match(jobs, /const jdHistory = jdVersions\.length/);
assert.match(jobs, /row\.jd_text \|\| '该版本没有可显示的 JD 内容。'/);
assert.match(jobs, /const profileHistory = profileVersions\.length/);
assert.match(jobs, /<ProfileSummary config=\{row\.config\} \/>/);
assert.match(app, /loadState=\{workbenchState\}[\s\S]{0,180}loadError=\{workbenchError\}[\s\S]{0,180}readOnly=\{jobReadOnly\}/);

console.log(JSON.stringify({
  ok: true,
  contract: 'UX-G0-B-SHELL-SAFETY-001',
  feature_error_isolation: true,
  keyboard_recovery: true,
  job_authority_fail_closed: true,
  history_remains_readable: true,
}));

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with ${result.signal || result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}

function runRuntimeInjection() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-ux-g0-b-boundary-'));
  fs.chmodSync(tempRoot, 0o700);
  const distRoot = path.join(tempRoot, 'dist');
  const resultPath = path.join(tempRoot, 'result.json');
  const screenshotPath = path.join(tempRoot, 'feature-boundary-recovery.png');
  const userDataPath = path.join(tempRoot, 'electron-user-data');
  const frontendRoot = path.join(__dirname, 'frontend');
  const boundaryPath = path.join(frontendRoot, 'src/components/FeatureErrorBoundary.jsx');
  const jobPanelPath = path.join(frontendRoot, 'src/components/JobManagementPanel.jsx');
  fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  fs.symlinkSync(path.join(frontendRoot, 'node_modules'), path.join(tempRoot, 'node_modules'));

  fs.writeFileSync(path.join(tempRoot, 'api-mock.js'), `
export function fmtTime(value) { return String(value || ''); }
function record(name) {
  window.__jobApiCalls = window.__jobApiCalls || [];
  window.__jobApiCalls.push(name);
  return Promise.resolve({});
}
export const api = {
  createJobJdVersion: () => record('createJobJdVersion'),
  activateJobJdVersion: () => record('activateJobJdVersion'),
  createJobProfileVersion: () => record('createJobProfileVersion'),
  confirmJobProfileVersion: () => record('confirmJobProfileVersion'),
  confirmExternalAiApproval: () => record('confirmExternalAiApproval'),
  optimizeJobJd: () => record('optimizeJobJd'),
};
`, { mode: 0o600 });

  fs.writeFileSync(path.join(tempRoot, 'vite.config.mjs'), `
import { defineConfig } from 'vite';
export default defineConfig({
  resolve: {
    alias: [{ find: /^\\.\\.\\/api\\.js$/, replacement: ${JSON.stringify(path.join(tempRoot, 'api-mock.js'))} }],
  },
});
`, { mode: 0o600 });

  fs.writeFileSync(path.join(tempRoot, 'index.html'), [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>UX-G0-B injection</title></head>',
    '<body><div id="root"></div><script type="module" src="/src.jsx"></script></body>',
    '</html>',
  ].join('\n'), { mode: 0o600 });

  fs.writeFileSync(path.join(tempRoot, 'src.jsx'), `
import React, { Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import FeatureErrorBoundary, { createRetryableLazy } from ${JSON.stringify(boundaryPath)};
import JobManagementPanel from ${JSON.stringify(jobPanelPath)};

window.__chunkLoaderAttempts = 0;
window.__chunkRecoveryAllowed = false;
window.__firstMountLoaderAttempts = 0;
function HealthyChunk() {
  return <button id="chunk-content">分块模块已恢复</button>;
}
function FirstMountHealthyChunk() {
  return <div id="first-mount-chunk">首次分块挂载已完成</div>;
}
const FirstMountChunk = createRetryableLazy(() => {
  window.__firstMountLoaderAttempts += 1;
  return new Promise((resolve) => globalThis.setTimeout(
    () => resolve({ default: FirstMountHealthyChunk }),
    60,
  ));
});
const RetryableChunk = createRetryableLazy(() => {
  window.__chunkLoaderAttempts += 1;
  return window.__chunkRecoveryAllowed
    ? Promise.resolve({ default: HealthyChunk })
    : Promise.reject(new Error('synthetic chunk reject'));
});

function RenderThrower({ shouldThrow }) {
  if (shouldThrow) throw new Error('synthetic render throw');
  return <button id="feature-content">模块内容可用</button>;
}

function Harness() {
  const [featureKey, setFeatureKey] = useState('render-a');
  const [shouldThrow, setShouldThrow] = useState(true);
  const [mode, setMode] = useState('render');
  const [exitCount, setExitCount] = useState(0);
  const [authorityState, setAuthorityState] = useState('ready');
  const [jobReadOnly, setJobReadOnly] = useState(false);
  useEffect(() => {
    window.__boundaryHarness = { setFeatureKey, setShouldThrow, setMode };
    window.__authorityHarness = { setAuthorityState, setJobReadOnly };
    window.__jobApiCalls = [];
  }, []);
  const job = { id: 7001, name: '合成正式岗位', is_fixture: false };
  const activeJd = {
    id: 101, version: 1, status: 'active', source: 'manual',
    jd_text: '保留的 JD 事实', created_at: '2026-07-21', activated_at: '2026-07-21',
  };
  const draftJd = {
    id: 102, version: 2, status: 'draft', source: 'manual',
    jd_text: '保留的 JD 草稿历史', created_at: '2026-07-21',
  };
  const confirmedProfile = {
    id: 201, version: 1, status: 'confirmed', jd_version_id: 101,
    confirmed_at: '2026-07-21', created_at: '2026-07-21',
    config: { responsibilities: ['保留的画像职责'], must_haves: ['保留的画像条件'] },
  };
  const draftProfile = {
    id: 202, version: 2, status: 'draft', jd_version_id: 101,
    created_at: '2026-07-21', stale_for_active_jd: false,
    config: { responsibilities: ['保留的画像草稿历史'] },
  };
  const workbench = {
    data_class: 'formal',
    jd: { active: activeJd, versions: [activeJd, draftJd] },
    profile: { confirmed: confirmedProfile, stale: null, versions: [confirmedProfile, draftProfile] },
  };
  return (
    <main>
      <nav id="shell-navigation"><button>工作台</button><button>职位管理</button></nav>
      <div id="job-context">当前岗位：合成岗位</div>
      <output id="exit-count">{exitCount}</output>
      <Suspense fallback={<div id="first-mount-loading">首次分块正在加载</div>}>
        <FeatureErrorBoundary featureKey="first-mount" featureLabel="首次分块">
          <FirstMountChunk />
        </FeatureErrorBoundary>
      </Suspense>
      <FeatureErrorBoundary
        featureKey={featureKey}
        featureLabel="合成模块"
        onExit={() => setExitCount((count) => count + 1)}
      >
        <Suspense fallback={<div id="loading">正在加载</div>}>
          {mode === 'chunk'
            ? <RetryableChunk />
            : <RenderThrower shouldThrow={shouldThrow} />}
        </Suspense>
      </FeatureErrorBoundary>
      <section id="authority-panel">
        <JobManagementPanel
          job={job}
          workbench={workbench}
          loadState={authorityState}
          loadError={authorityState === 'ready' ? '' : '合成权威状态异常'}
          readOnly={jobReadOnly}
          onRefresh={() => Promise.resolve()}
        />
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
`, { mode: 0o600 });

  fs.writeFileSync(path.join(tempRoot, 'main.cjs'), `
'use strict';
const fs = require('node:fs');
const { app, BrowserWindow } = require('electron');
const distRoot = ${JSON.stringify(distRoot)};
const resultPath = ${JSON.stringify(resultPath)};
const screenshotPath = ${JSON.stringify(screenshotPath)};
app.setPath('userData', ${JSON.stringify(userDataPath)});

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
const QUIET_WINDOW_MS = 250;
async function waitFor(win, expression, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(\`Boolean(\${expression})\`)) return;
    await delay(50);
  }
  throw new Error(\`timed out waiting for \${label}\`);
}
async function clickButton(win, text) {
  const clicked = await win.webContents.executeJavaScript(\`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((element) => (element.textContent || '').trim() === \${JSON.stringify(text)});
    if (!button) return false;
    button.focus();
    button.click();
    return true;
  })()\`);
  if (!clicked) throw new Error(\`missing button: \${text}\`);
}
async function inspectJobSection(win, label, expectedText) {
  const clicked = await win.webContents.executeJavaScript(\`(() => {
    const option = [...document.querySelectorAll('#authority-panel .job-management-section-tabs .ant-segmented-item')]
      .find((element) => (element.textContent || '').trim() === \${JSON.stringify(label)});
    if (!option) return false;
    option.click();
    return true;
  })()\`);
  if (!clicked) throw new Error('missing job section: ' + label);
  await waitFor(win,
    \`[...document.querySelectorAll('#authority-panel .job-management-section-tabs .ant-segmented-item')]
      .some((element) => element.classList.contains('ant-segmented-item-selected')
        && (element.textContent || '').trim() === \${JSON.stringify(label)})\`,
    'job section ' + label);
  await waitFor(win,
    \`document.querySelector('#authority-panel')?.textContent.includes(\${JSON.stringify(expectedText)})\`,
    'job section content ' + label);
  await win.webContents.executeJavaScript(\`(() => {
    [...document.querySelectorAll('#authority-panel .ant-collapse-header')]
      .filter((header) => header.getAttribute('aria-expanded') !== 'true')
      .forEach((header) => header.click());
  })()\`);
  await delay(80);
  return win.webContents.executeJavaScript(\`(() => {
    const root = document.querySelector('#authority-panel');
    const writeLabels = ['保存 JD 草稿', '启用此版本', '保存岗位画像草稿', '确认此版本'];
    const buttons = [...root.querySelectorAll('button')].map((button) => button.textContent.trim());
    return {
      text: root.textContent || '',
      writeButtons: buttons.filter((buttonLabel) => writeLabels.includes(buttonLabel)),
      historyVisible: root.textContent.includes('版本记录（2）'),
    };
  })()\`);
}
async function setAuthority(win, state, readOnly = false) {
  await win.webContents.executeJavaScript(\`(() => {
    window.__authorityHarness.setAuthorityState(\${JSON.stringify(state)});
    window.__authorityHarness.setJobReadOnly(\${JSON.stringify(readOnly)});
  })()\`);
  const expectedMessage = state === 'loading'
    ? '正在刷新职位权威数据，写操作暂时锁定'
    : state === 'error'
    ? '职位数据读取失败，写操作已锁定'
    : state === 'stale'
    ? '当前显示上次成功读取的数据，写操作已锁定'
    : '';
  if (expectedMessage) {
    await waitFor(win,
      \`document.querySelector('#authority-panel')?.textContent.includes(\${JSON.stringify(expectedMessage)})\`,
      \`authority \${state}\`);
  }
  const jdSection = await inspectJobSection(win, 'JD 与版本', '保留的 JD 事实');
  const profileSection = await inspectJobSection(win, '岗位画像', '保留的画像职责');
  const apiCalls = await win.webContents.executeJavaScript('[...(window.__jobApiCalls || [])]');
  return {
    state,
    readOnly,
    writeButtons: [...new Set([...jdSection.writeButtons, ...profileSection.writeButtons])],
    oldJdVisible: jdSection.text.includes('保留的 JD 事实'),
    oldProfileVisible: profileSection.text.includes('保留的画像职责'),
    historyVisible: jdSection.historyVisible && profileSection.historyVisible,
    apiCalls,
  };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 640,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  try {
    await win.loadFile(require('node:path').join(distRoot, 'index.html'));
    win.webContents.focus();
    await waitFor(win, "document.querySelector('#first-mount-chunk')", 'first lazy mount recovery');
    await delay(QUIET_WINDOW_MS);
    const firstMount = await win.webContents.executeJavaScript(\`(() => ({
      loaderAttempts: window.__firstMountLoaderAttempts,
      healthyContentVisible: Boolean(document.querySelector('#first-mount-chunk')),
      fallbackVisible: Boolean(document.querySelector('#first-mount-loading')),
    }))()\`);
    await waitFor(win, "document.querySelector('[role=alert] h2')", 'initial render fallback');
    await waitFor(win, "document.activeElement === document.querySelector('[role=alert] h2')", 'error heading focus');
    const initial = await win.webContents.executeJavaScript(\`(() => ({
      shellVisible: Boolean(document.querySelector('#shell-navigation')),
      jobContext: document.querySelector('#job-context')?.textContent || '',
      heading: document.querySelector('[role=alert] h2')?.textContent || '',
      focusedHeading: document.activeElement === document.querySelector('[role=alert] h2'),
    }))()\`);

    await clickButton(win, '重试模块');
    await waitFor(win, "document.querySelector('[role=alert] h2')", 'repeat render fallback');
    const repeatedRenderStayedContained = await win.webContents.executeJavaScript(
      "Boolean(document.querySelector('#shell-navigation') && document.querySelector('[role=alert] h2'))",
    );

    await win.webContents.executeJavaScript("window.__boundaryHarness.setShouldThrow(false)");
    await clickButton(win, '重试模块');
    await waitFor(win, "document.querySelector('#feature-content')", 'render retry recovery');

    await win.webContents.executeJavaScript("window.__boundaryHarness.setShouldThrow(true)");
    await waitFor(win, "document.querySelector('[role=alert] h2')", 'second render fallback');
    await win.webContents.executeJavaScript("window.__boundaryHarness.setShouldThrow(false); window.__boundaryHarness.setFeatureKey('route-b')");
    await waitFor(win, "document.querySelector('#feature-content')", 'feature key reset');

    const chunkLoaderAttemptsBeforeFailure = await win.webContents.executeJavaScript('window.__chunkLoaderAttempts');
    await win.webContents.executeJavaScript("window.__boundaryHarness.setFeatureKey('chunk-a')");
    await waitFor(win, "document.querySelector('#feature-content')", 'chunk route staged');
    await win.webContents.executeJavaScript("window.__boundaryHarness.setMode('chunk')");
    await waitFor(win, "document.querySelector('[role=alert] h2')", 'chunk reject fallback');
    await delay(QUIET_WINDOW_MS);
    const chunkLoaderAttemptsBeforeRetry = await win.webContents.executeJavaScript('window.__chunkLoaderAttempts');
    await delay(QUIET_WINDOW_MS);
    const chunkLoaderAttemptsAfterFailureQuietWindow = await win.webContents.executeJavaScript('window.__chunkLoaderAttempts');
    await win.webContents.executeJavaScript("window.__chunkRecoveryAllowed = true");
    await clickButton(win, '重试模块');
    await waitFor(win, "document.querySelector('#chunk-content')", 'chunk retry recovery');
    await delay(QUIET_WINDOW_MS);
    const chunkLoaderAttemptsAfterRetry = await win.webContents.executeJavaScript('window.__chunkLoaderAttempts');
    await delay(QUIET_WINDOW_MS);
    const chunkLoaderAttemptsAfterRecoveryQuietWindow = await win.webContents.executeJavaScript('window.__chunkLoaderAttempts');
    const chunkRecovery = await win.webContents.executeJavaScript(\`(() => ({
      loaderAttempts: window.__chunkLoaderAttempts,
      shellVisible: Boolean(document.querySelector('#shell-navigation')),
      jobContextVisible: document.querySelector('#job-context')?.textContent.includes('合成岗位') || false,
      healthyContentVisible: Boolean(document.querySelector('#chunk-content')),
      fallbackVisible: Boolean(document.querySelector('[role=alert]')),
    }))()\`);

    chunkRecovery.loaderAttemptsBeforeFailure = chunkLoaderAttemptsBeforeFailure;
    chunkRecovery.loaderAttemptsBeforeRetry = chunkLoaderAttemptsBeforeRetry;
    chunkRecovery.loaderAttemptsAfterFailureQuietWindow = chunkLoaderAttemptsAfterFailureQuietWindow;
    chunkRecovery.loaderAttemptsAfterRetry = chunkLoaderAttemptsAfterRetry;
    chunkRecovery.loaderAttemptsAfterRecoveryQuietWindow = chunkLoaderAttemptsAfterRecoveryQuietWindow;

    await win.webContents.executeJavaScript("window.__boundaryHarness.setMode('render'); window.__boundaryHarness.setShouldThrow(false); window.__boundaryHarness.setFeatureKey('route-c')");
    await waitFor(win, "document.querySelector('#feature-content')", 'module switch recovery');
    await win.webContents.executeJavaScript("window.__boundaryHarness.setShouldThrow(true)");
    await waitFor(win, "document.querySelector('[role=alert] h2')", 'keyboard exit fallback');
    await waitFor(win,
      "document.activeElement === document.querySelector('[role=alert] h2')",
      'keyboard exit error heading focus');
    await win.webContents.executeJavaScript(\`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((element) => (element.textContent || '').trim() === '返回工作台');
      button.focus();
    })()\`);
    await waitFor(win,
      "document.activeElement?.tagName === 'BUTTON' && document.activeElement?.textContent.trim() === '返回工作台'",
      'keyboard exit focus');
    await delay(80);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
    await waitFor(win, "document.querySelector('#exit-count')?.textContent === '1'", 'keyboard exit action');
    await win.webContents.executeJavaScript("window.__boundaryHarness.setShouldThrow(false); window.__boundaryHarness.setFeatureKey('authority-tests')");
    await waitFor(win, "document.querySelector('#feature-content')", 'boundary recovery before authority tests');
    const authority = {};
    authority.loading = await setAuthority(win, 'loading');
    authority.error = await setAuthority(win, 'error');
    authority.stale = await setAuthority(win, 'stale');
    authority.ready = await setAuthority(win, 'ready');
    authority.readOnly = await setAuthority(win, 'ready', true);
    authority.readyRestored = await setAuthority(win, 'ready', false);
    const image = await win.capturePage();
    fs.writeFileSync(screenshotPath, image.toPNG(), { mode: 0o600 });

    const result = {
      ok: true,
      contract: 'UX-G0-B-FEATURE-BOUNDARY-RUNTIME-001',
      firstMount,
      initial,
      repeatedRenderStayedContained,
      chunkRecovery,
      renderRetryRecovered: true,
      chunkRetryRecovered: true,
      featureKeyResetRecovered: true,
      moduleSwitchRecovered: true,
      keyboardExitTriggered: true,
      authority,
      screenshotPath,
    };
    fs.writeFileSync(resultPath, JSON.stringify(result), { mode: 0o600 });
    app.exit(0);
  } catch (error) {
    const diagnostics = await win.webContents.executeJavaScript(\`(() => ({
      chunkLoaderAttempts: window.__chunkLoaderAttempts,
      chunkRecoveryAllowed: window.__chunkRecoveryAllowed,
      firstMountLoaderAttempts: window.__firstMountLoaderAttempts,
      firstMount: document.querySelector('#first-mount-chunk')?.textContent || '',
      firstMountLoading: document.querySelector('#first-mount-loading')?.textContent || '',
      alert: document.querySelector('[role=alert]')?.textContent || '',
      loading: document.querySelector('#loading')?.textContent || '',
      feature: document.querySelector('#feature-content')?.textContent || '',
      chunk: document.querySelector('#chunk-content')?.textContent || '',
      body: document.body.textContent || '',
    }))()\`).catch((diagnosticError) => ({ diagnosticError: String(diagnosticError) }));
    fs.writeFileSync(resultPath, JSON.stringify({ ok: false, error: error?.stack || String(error), diagnostics }), { mode: 0o600 });
    app.exit(1);
  }
});
`, { mode: 0o600 });

  const vite = path.join(frontendRoot, 'node_modules/.bin/vite');
  runChecked(vite, ['build', '--base', './', '--outDir', distRoot, '--emptyOutDir'], { cwd: tempRoot });
  const electron = require('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  runChecked(electron, [path.join(tempRoot, 'main.cjs')], {
    cwd: tempRoot,
    env,
    timeout: 120000,
  });
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.firstMount, {
    loaderAttempts: 1,
    healthyContentVisible: true,
    fallbackVisible: false,
  });
  assert.equal(result.initial.shellVisible, true);
  assert.match(result.initial.jobContext, /合成岗位/);
  assert.equal(result.initial.focusedHeading, true);
  assert.equal(result.repeatedRenderStayedContained, true);
  assert.equal(result.chunkRecovery.loaderAttemptsBeforeFailure, 0);
  assert.equal(result.chunkRecovery.loaderAttemptsBeforeRetry - result.chunkRecovery.loaderAttemptsBeforeFailure, 1);
  assert.equal(result.chunkRecovery.loaderAttemptsAfterFailureQuietWindow, result.chunkRecovery.loaderAttemptsBeforeRetry);
  assert.equal(result.chunkRecovery.loaderAttemptsAfterRetry - result.chunkRecovery.loaderAttemptsBeforeRetry, 1);
  assert.equal(result.chunkRecovery.loaderAttemptsAfterRecoveryQuietWindow, result.chunkRecovery.loaderAttemptsAfterRetry);
  assert.equal(result.chunkRecovery.loaderAttempts, 2);
  assert.equal(result.chunkRecovery.shellVisible, true);
  assert.equal(result.chunkRecovery.jobContextVisible, true);
  assert.equal(result.chunkRecovery.healthyContentVisible, true);
  assert.equal(result.chunkRecovery.fallbackVisible, false);
  assert.equal(result.chunkRetryRecovered, true);
  ['loading', 'error', 'stale'].forEach((state) => {
    assert.deepEqual(result.authority[state].writeButtons, []);
    assert.deepEqual(result.authority[state].apiCalls, []);
    assert.equal(result.authority[state].oldJdVisible, true);
    assert.equal(result.authority[state].oldProfileVisible, true);
    assert.equal(result.authority[state].historyVisible, true);
  });
  ['保存 JD 草稿', '启用此版本', '保存岗位画像草稿', '确认此版本']
    .forEach((label) => assert.ok(result.authority.ready.writeButtons.includes(label)));
  assert.deepEqual(result.authority.readOnly.writeButtons, []);
  assert.deepEqual(result.authority.readOnly.apiCalls, []);
  assert.deepEqual(result.authority.readyRestored.writeButtons.sort(), result.authority.ready.writeButtons.sort());
  console.log(JSON.stringify({ ...result, tempRoot }));
}

if (process.argv.includes('--runtime')) {
  if (process.platform === 'win32') {
    console.log('SKIP Windows GUI runtime injection harness (static shell-safety contract passed)');
  } else {
    runRuntimeInjection();
  }
}
