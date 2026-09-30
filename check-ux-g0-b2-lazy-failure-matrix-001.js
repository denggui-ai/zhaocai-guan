#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const appPath = path.join(__dirname, 'frontend/src/App.jsx');
const boundaryPath = path.join(__dirname, 'frontend/src/components/FeatureErrorBoundary.jsx');
const appSource = fs.readFileSync(appPath, 'utf8');
const boundarySource = fs.readFileSync(boundaryPath, 'utf8');

const featureCases = [
  {
    id: 'CandidateList',
    label: '候选人列表',
    keyToken: 'candidate-list:',
    components: ['CandidateList'],
    lazyModules: ['CandidateList'],
    exitLabel: '返回工作台',
  },
  {
    id: 'CandidateDetail',
    label: '候选人详情',
    keyToken: 'candidate-detail:',
    components: ['CandidateDetail'],
    lazyModules: ['CandidateDetail'],
    exitLabel: '返回工作台',
  },
  {
    id: 'JobLedgerPanel',
    label: '岗位台账',
    keyToken: 'jobs:',
    components: ['JobLedgerPanel'],
    lazyModules: ['JobLedgerPanel'],
    exitLabel: '返回工作台',
  },
  {
    id: 'JobManagementDemo',
    label: '职位管理',
    keyToken: 'jobs:',
    components: ['JobManagementDemo'],
    lazyModules: ['JobManagementDemo'],
    exitLabel: '返回岗位台账',
  },
  {
    id: 'JobManagementPanel',
    label: '职位管理',
    keyToken: 'jobs:',
    components: ['JobManagementPanel'],
    lazyModules: ['JobManagementPanel'],
    exitLabel: '返回岗位台账',
  },
  {
    id: 'TalentPoolDemo',
    label: '人才库',
    keyToken: 'talent:',
    components: ['TalentPoolDemo'],
    lazyModules: ['TalentPoolDemo'],
    exitLabel: '返回工作台',
  },
  {
    id: 'SettingsPanel',
    label: '设置',
    keyToken: 'settings',
    components: ['SettingsPanel'],
    lazyModules: ['SettingsPanel'],
    exitLabel: '返回上一模块',
  },
  {
    id: 'DeepProfileModal',
    label: '深度岗位画像',
    keyToken: 'deep-profile:',
    components: ['DeepProfileModal'],
    lazyModules: ['DeepProfileModal'],
    exitLabel: '关闭',
  },
  {
    id: 'ScreenshotOcrReviewModal',
    label: '截图识别复核',
    keyToken: 'screenshot-review:',
    components: ['ScreenshotOcrReviewModal'],
    lazyModules: ['ScreenshotOcrReviewModal'],
    exitLabel: '关闭',
  },
  {
    id: 'InterviewSchedulePanel',
    label: '面试安排',
    keyToken: 'interviews:',
    components: ['InterviewSchedulePanel'],
    lazyModules: ['InterviewSchedulePanel'],
    exitLabel: '返回工作台',
  },
  {
    id: 'InterviewScheduleCanonical',
    label: '面试安排',
    keyToken: 'interviews:',
    components: ['InterviewScheduleCanonical'],
    lazyModules: ['InterviewScheduleCanonical'],
    exitLabel: '返回工作台',
  },
];

function featureBoundarySlice(featureCase) {
  const featureKeyNeedle = featureCase.keyToken === 'settings'
    ? 'featureKey="settings"'
    : `featureKey={\`${featureCase.keyToken}`;
  const tokenIndex = appSource.indexOf(featureKeyNeedle);
  assert.ok(tokenIndex >= 0, `missing production feature key: ${featureCase.keyToken}`);
  const boundaryStart = appSource.lastIndexOf('<FeatureErrorBoundary', tokenIndex);
  const boundaryEnd = appSource.indexOf('</FeatureErrorBoundary>', tokenIndex);
  assert.ok(boundaryStart >= 0 && boundaryEnd > tokenIndex,
    `missing production boundary block: ${featureCase.id}`);
  return appSource.slice(boundaryStart, boundaryEnd + '</FeatureErrorBoundary>'.length);
}

// This manifest is deliberately checked against App.jsx instead of being a free-standing
// synthetic list. If a production lazy import or boundary mapping changes, this check fails.
const lazyImportPattern = /const\s+(\w+)\s*=\s*createRetryableLazy\(\(\)\s*=>\s*import\('\.\/components\/([^']+\.jsx)'\)\);/g;
const actualLazyImports = new Map();
for (const match of appSource.matchAll(lazyImportPattern)) actualLazyImports.set(match[1], match[2]);
const expectedLazyModules = featureCases.flatMap((featureCase) => featureCase.lazyModules).sort();
assert.deepEqual([...actualLazyImports.keys()].sort(), expectedLazyModules,
  'production lazy module set is not fully assigned to the eleven-case failure matrix');
expectedLazyModules.forEach((componentName) => {
  assert.equal(actualLazyImports.get(componentName), `${componentName}.jsx`,
    `unexpected production lazy import target for ${componentName}`);
});

assert.match(appSource, /import FeatureErrorBoundary, \{ createRetryableLazy \} from '.\/components\/FeatureErrorBoundary\.jsx'/);
assert.equal(featureCases.length, 11);
featureCases.forEach((featureCase) => {
  const block = featureBoundarySlice(featureCase);
  featureCase.components.forEach((componentName) => {
    assert.match(block, new RegExp(`<${componentName}\\b`),
      `${componentName} is no longer inside ${featureCase.id} boundary`);
  });
  if (featureCase.keyToken === 'jobs:') {
    assert.match(block, /featureLabel=\{jobManagementView === 'ledger' \? '岗位台账' : '职位管理'\}/);
  } else {
    assert.ok(block.includes(`featureLabel="${featureCase.label}"`),
      `localized production feature label missing for ${featureCase.id}`);
  }
  assert.match(block, /\bonExit=/, `missing production exit action for ${featureCase.id}`);
  if (featureCase.keyToken === 'jobs:') {
    assert.match(block, /exitLabel=\{jobManagementView === 'ledger' \? '返回工作台' : '返回岗位台账'\}/);
  } else if (!['返回工作台'].includes(featureCase.exitLabel)) {
    assert.ok(block.includes(`exitLabel="${featureCase.exitLabel}"`),
      `missing production exit label for ${featureCase.id}`);
  }
});

assert.match(boundarySource, /previousProps\.featureKey !== this\.props\.featureKey/);
assert.match(boundarySource,
  /previousProps\.featureKey !== this\.props\.featureKey[\s\S]{0,180}this\.setState\(\{ error: null, retryKey: 0, retryToken: \{\} \}\)/,
  'feature-key recovery must replace the rejected lazy retry token');
assert.match(boundarySource, /export function createRetryableLazy\(loader\)/);
assert.match(boundarySource, /const LazyRetryContext = React\.createContext\(null\)/);
assert.match(boundarySource, /const lazyByRetryToken = new WeakMap\(\)/);
assert.match(boundarySource, /LazyComponent = React\.lazy\(loader\)/);
assert.match(boundarySource, /this\.state = \{ error: null, retryKey: 0, retryToken: null \}/,
  'the first lazy mount must use the stable unscoped lazy component');
assert.match(boundarySource,
  /handleRetry = \(\) => \{[\s\S]{0,180}retryToken: \{\}/,
  'manual retry must replace a rejected lazy component');
assert.match(boundarySource, /<LazyRetryContext\.Provider value=\{retryToken\}>/);
assert.match(boundarySource, /<h2 ref=\{this\.errorHeadingRef\} tabIndex=\{-1\}/);
assert.match(boundarySource, /\{featureLabel\}暂时无法显示/);
assert.match(boundarySource, /<Button onClick=\{this\.handleRetry\}>重试模块<\/Button>/);
assert.match(boundarySource, /\{onExit && <Button type="primary" onClick=\{onExit\}>\{exitLabel\}<\/Button>\}/);
assert.match(boundarySource, /Shell、岗位上下文和其他模块仍可使用/);

console.log(JSON.stringify({
  ok: true,
  contract: 'UX-G0-B2-LAZY-FAILURE-MATRIX-001',
  productionFeatureCases: featureCases.map(({ id, label, keyToken, components, lazyModules, exitLabel, exitSemantics }) => ({
    id,
    label,
    keyToken,
    components,
    lazyModules,
    exitLabel,
    exitSemantics: exitSemantics || 'keyboard-exit',
  })),
  productionLazyModules: [...actualLazyImports.keys()].sort(),
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

function runRuntimeMatrix() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-ux-g0-b2-matrix-'));
  fs.chmodSync(tempRoot, 0o700);
  const distRoot = path.join(tempRoot, 'dist');
  const resultPath = path.join(tempRoot, 'result.json');
  const screenshotPath = path.join(tempRoot, 'lazy-failure-matrix.png');
  const userDataPath = path.join(tempRoot, 'electron-user-data');
  const frontendRoot = path.join(__dirname, 'frontend');
  fs.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  fs.symlinkSync(path.join(frontendRoot, 'node_modules'), path.join(tempRoot, 'node_modules'));

  fs.writeFileSync(path.join(tempRoot, 'vite.config.mjs'), `
import { defineConfig } from 'vite';
export default defineConfig({});
`, { mode: 0o600 });

  fs.writeFileSync(path.join(tempRoot, 'index.html'), [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>UX-G0-B2 matrix</title></head>',
    '<body><div id="root"></div><script type="module" src="/src.jsx"></script></body>',
    '</html>',
  ].join('\n'), { mode: 0o600 });

  fs.writeFileSync(path.join(tempRoot, 'src.jsx'), `
import React, { Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import FeatureErrorBoundary, { createRetryableLazy } from ${JSON.stringify(boundaryPath)};

const CASES = ${JSON.stringify(featureCases.map(({ id, label, keyToken, exitLabel, exitSemantics }) => ({
    id, label, keyToken, exitLabel, exitSemantics: exitSemantics || 'keyboard-exit',
  })))};
window.__renderAttempts = {};
window.__chunkAttempts = {};
window.__chunkRecoveryAllowed = {};
window.__exitEvents = [];
window.__firstMountLoaderAttempts = 0;

function FirstMountHealthyChunk() {
  return <section id="first-mount-chunk">首次分块挂载已完成</section>;
}
const FirstMountChunk = createRetryableLazy(() => {
  window.__firstMountLoaderAttempts += 1;
  return new Promise((resolve) => globalThis.setTimeout(
    () => resolve({ default: FirstMountHealthyChunk }),
    60,
  ));
});

const RetryableChunks = Object.fromEntries(CASES.map((featureCase) => [
  featureCase.id,
  createRetryableLazy(() => {
    window.__chunkAttempts[featureCase.id] = (window.__chunkAttempts[featureCase.id] || 0) + 1;
    return window.__chunkRecoveryAllowed[featureCase.id]
      ? Promise.resolve({ default: () => <HealthyFeature featureId={featureCase.id} /> })
      : Promise.reject(new Error('synthetic local chunk rejection: ' + featureCase.id));
  }),
]));

function RenderThrower({ featureId }) {
  window.__renderAttempts[featureId] = (window.__renderAttempts[featureId] || 0) + 1;
  throw new Error('synthetic local render failure: ' + featureId);
}

function HealthyFeature({ featureId }) {
  return <section id="healthy-feature" data-feature-id={featureId}>模块已恢复：{featureId}</section>;
}

function Harness() {
  const initialCase = CASES[0];
  const [scenario, setScenario] = useState({
    caseIndex: 0,
    mode: 'render',
    healthy: false,
    featureKey: initialCase.keyToken + 'synthetic-render-initial',
    boundaryInstance: 0,
  });
  const featureCase = CASES[scenario.caseIndex];
  const RetryableChunk = RetryableChunks[featureCase.id];

  useEffect(() => {
    window.__matrix = {
      cases: CASES,
      stage(caseIndex, mode, suffix) {
        const next = CASES[caseIndex];
        if (mode === 'chunk') window.__chunkRecoveryAllowed[next.id] = false;
        setScenario((current) => ({
          caseIndex,
          mode: 'healthy',
          healthy: true,
          featureKey: next.keyToken + 'synthetic-' + mode + '-' + suffix,
          boundaryInstance: current.boundaryInstance,
        }));
      },
      resetBoundary(caseIndex, mode, suffix) {
        const next = CASES[caseIndex];
        if (mode === 'chunk') window.__chunkRecoveryAllowed[next.id] = false;
        setScenario((current) => ({
          caseIndex,
          mode: 'healthy',
          healthy: true,
          featureKey: next.keyToken + 'synthetic-' + mode + '-' + suffix,
          boundaryInstance: current.boundaryInstance + 1,
        }));
      },
      fail(mode) {
        setScenario((current) => ({ ...current, mode, healthy: false }));
      },
      setHealthy() {
        setScenario((current) => ({ ...current, healthy: true }));
      },
      routeRecover(suffix) {
        setScenario((current) => {
          const currentCase = CASES[current.caseIndex];
          return {
            ...current,
            mode: 'healthy',
            healthy: true,
            featureKey: currentCase.keyToken + 'synthetic-route-' + suffix,
          };
        });
      },
      retryRejectedChunkWithFeatureKey(suffix) {
        setScenario((current) => {
          const currentCase = CASES[current.caseIndex];
          return {
            ...current,
            featureKey: currentCase.keyToken + 'synthetic-chunk-feature-key-' + suffix,
          };
        });
      },
    };
  }, []);

  const handleExit = featureCase.exitLabel
    ? () => window.__exitEvents.push(featureCase.id)
    : undefined;
  const content = scenario.healthy || scenario.mode === 'healthy'
    ? <HealthyFeature featureId={featureCase.id} />
    : scenario.mode === 'chunk'
      ? <RetryableChunk />
      : <RenderThrower featureId={featureCase.id} />;

  return (
    <main>
      <nav id="shell-navigation" aria-label="主导航">
        <button>工作台</button><button>职位管理</button><button>候选人</button><button>面试安排</button>
      </nav>
      <div id="job-context">当前岗位：本地合成岗位（无真实数据）</div>
      <output id="active-case">{featureCase.id}</output>
      <Suspense fallback={<div id="first-mount-loading">首次分块正在加载</div>}>
        <FeatureErrorBoundary featureKey="first-mount" featureLabel="首次分块">
          <FirstMountChunk />
        </FeatureErrorBoundary>
      </Suspense>
      <FeatureErrorBoundary
        key={scenario.boundaryInstance}
        featureKey={scenario.featureKey}
        featureLabel={featureCase.label}
        onExit={handleExit}
        exitLabel={featureCase.exitLabel || '返回工作台'}
        modal={['DeepProfileModal', 'ScreenshotOcrReviewModal'].includes(featureCase.id)}
      >
        <Suspense fallback={<div id="module-loading">正在加载合成模块</div>}>
          {content}
        </Suspense>
      </FeatureErrorBoundary>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
`, { mode: 0o600 });

  fs.writeFileSync(path.join(tempRoot, 'main.cjs'), `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const cases = ${JSON.stringify(featureCases.map(({ id, label, keyToken, exitLabel, exitSemantics }) => ({
    id, label, keyToken, exitLabel, exitSemantics: exitSemantics || 'keyboard-exit',
  })))};
const distRoot = ${JSON.stringify(distRoot)};
const resultPath = ${JSON.stringify(resultPath)};
const screenshotPath = ${JSON.stringify(screenshotPath)};
app.setPath('userData', ${JSON.stringify(userDataPath)});

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
const QUIET_WINDOW_MS = 250;
async function waitFor(win, expression, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript('Boolean(' + expression + ')')) return;
    await delay(40);
  }
  throw new Error('timed out waiting for ' + label);
}
async function pressButton(win, label, keyCode = 'Space') {
  const focusState = await win.webContents.executeJavaScript(\`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons
      .find((element) => (element.textContent || '').replace(/\\\\s+/g, '') === \${JSON.stringify(label.split(' ').join(''))});
    if (!button) return { found: false, texts: buttons.map((element) => element.textContent || '') };
    button.focus();
    return {
      found: true,
      focused: document.activeElement === button,
      matchedText: button.textContent || '',
      activeText: document.activeElement?.textContent || '',
    };
  })()\`);
  if (!focusState.focused) throw new Error('missing or unfocusable button: ' + label + ' ' + JSON.stringify(focusState));
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
}
async function startFailure(win, caseIndex, mode, suffix) {
  await win.webContents.executeJavaScript(
    'window.__matrix.stage(' + caseIndex + ',' + JSON.stringify(mode) + ',' + JSON.stringify(suffix) + ')',
  );
  await waitFor(win,
    \`document.querySelector('#healthy-feature')?.dataset.featureId === \${JSON.stringify(cases[caseIndex].id)}\`,
    cases[caseIndex].id + ' ' + mode + ' staged route');
  await win.webContents.executeJavaScript('window.__matrix.fail(' + JSON.stringify(mode) + ')');
  const expected = cases[caseIndex].label + '暂时无法显示';
  await waitFor(win,
    \`document.querySelector('[role=alert] h2')?.textContent === \${JSON.stringify(expected)}\`,
    cases[caseIndex].id + ' ' + mode + ' localized fallback');
  await waitFor(win,
    "document.activeElement === document.querySelector('[role=alert] h2')",
    cases[caseIndex].id + ' ' + mode + ' error focus');
}
async function failureSnapshot(win) {
  return win.webContents.executeJavaScript(\`(() => ({
    heading: document.querySelector('[role=alert] h2')?.textContent || '',
    focusedHeading: document.activeElement === document.querySelector('[role=alert] h2'),
    shellVisible: Boolean(document.querySelector('#shell-navigation')),
    jobContextVisible: document.querySelector('#job-context')?.textContent.includes('本地合成岗位') || false,
    retryVisible: [...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '重试模块'),
  }))()\`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1180,
    height: 760,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const matrix = [];
  try {
    await win.loadFile(path.join(distRoot, 'index.html'));
    win.webContents.focus();
    await waitFor(win, 'window.__matrix', 'matrix harness');
    await waitFor(win, "document.querySelector('#first-mount-chunk')", 'first lazy mount recovery');
    await delay(QUIET_WINDOW_MS);
    const firstMount = await win.webContents.executeJavaScript(\`(() => ({
      loaderAttempts: window.__firstMountLoaderAttempts,
      healthyContentVisible: Boolean(document.querySelector('#first-mount-chunk')),
      fallbackVisible: Boolean(document.querySelector('#first-mount-loading')),
    }))()\`);

    for (let caseIndex = 0; caseIndex < cases.length; caseIndex += 1) {
      const featureCase = cases[caseIndex];
      const caseResult = { id: featureCase.id, label: featureCase.label, modes: {} };
      for (const mode of ['render', 'chunk']) {
        const token = featureCase.id + '-' + mode + '-' + Date.now();
        const attemptCounter = mode === 'chunk' ? '__chunkAttempts' : '__renderAttempts';
        const attemptsBeforeFailure = await win.webContents.executeJavaScript(
          'window.' + attemptCounter + '[' + JSON.stringify(featureCase.id) + '] || 0',
        );
        await startFailure(win, caseIndex, mode, token + '-a');
        const initial = await failureSnapshot(win);
        const attemptsAtFallback = await win.webContents.executeJavaScript(
          'window.' + attemptCounter + '[' + JSON.stringify(featureCase.id) + '] || 0',
        );
        await delay(QUIET_WINDOW_MS);
        const attemptsAfterFailureQuietWindow = await win.webContents.executeJavaScript(
          'window.' + attemptCounter + '[' + JSON.stringify(featureCase.id) + '] || 0',
        );
        await delay(QUIET_WINDOW_MS);
        const attemptsAfterFailureSecondQuietWindow = await win.webContents.executeJavaScript(
          'window.' + attemptCounter + '[' + JSON.stringify(featureCase.id) + '] || 0',
        );

        let exitKeyboard;
        if (featureCase.exitLabel) {
          const exitCount = await win.webContents.executeJavaScript('window.__exitEvents.length');
          await pressButton(win, featureCase.exitLabel);
          await waitFor(win, 'window.__exitEvents.length === ' + (exitCount + 1), featureCase.id + ' keyboard exit');
          exitKeyboard = 'triggered';
        } else {
          const unexpectedExit = await win.webContents.executeJavaScript(\`[...document.querySelectorAll('button')]
            .some((button) => button.textContent.trim() !== '重试模块' && button.closest('[role=alert]'))\`);
          if (unexpectedExit) throw new Error('unexpected circular workbench exit control');
          exitKeyboard = featureCase.exitSemantics;
        }

        let retryStayedContained;
        let retryRecovered;
        let attemptsBeforeRetryAction = attemptsAfterFailureSecondQuietWindow;
        let attemptsAfterRetryAction = null;
        let attemptsAfterRetryQuietWindow = null;
        let chunkAttemptsBeforeRetry = null;
        let chunkAttemptsAfterRetry = null;
        let featureKeyChunkRecovery = null;
        if (mode === 'render') {
          await pressButton(win, '重试模块');
          await waitFor(win,
            '((window.__renderAttempts[' + JSON.stringify(featureCase.id) + '] || 0) > ' + attemptsBeforeRetryAction + ')',
            featureCase.id + ' explicit render retry attempt');
          await waitFor(win, "document.querySelector('[role=alert] h2')", featureCase.id + ' retry containment');
          await waitFor(win,
            "document.activeElement === document.querySelector('[role=alert] h2')",
            featureCase.id + ' retry error focus');
          await delay(QUIET_WINDOW_MS);
          attemptsAfterRetryAction = await win.webContents.executeJavaScript(
            'window.__renderAttempts[' + JSON.stringify(featureCase.id) + '] || 0',
          );
          await delay(QUIET_WINDOW_MS);
          attemptsAfterRetryQuietWindow = await win.webContents.executeJavaScript(
            'window.__renderAttempts[' + JSON.stringify(featureCase.id) + '] || 0',
          );
          retryStayedContained = await win.webContents.executeJavaScript(
            "Boolean(document.querySelector('#shell-navigation') && document.querySelector('[role=alert] h2'))",
          );
          await win.webContents.executeJavaScript('window.__matrix.setHealthy()');
          await delay(60);
          await pressButton(win, '重试模块');
          await waitFor(win,
            \`document.querySelector('#healthy-feature')?.dataset.featureId === \${JSON.stringify(featureCase.id)}\`,
            featureCase.id + ' retry recovery');
          retryRecovered = true;
          await startFailure(win, caseIndex, mode, token + '-b');
        } else {
          chunkAttemptsBeforeRetry = attemptsBeforeRetryAction;
          await win.webContents.executeJavaScript(
            'window.__chunkRecoveryAllowed[' + JSON.stringify(featureCase.id) + '] = true',
          );
          await pressButton(win, '重试模块');
          await waitFor(win,
            \`document.querySelector('#healthy-feature')?.dataset.featureId === \${JSON.stringify(featureCase.id)}\`,
            featureCase.id + ' chunk retry recovery');
          await delay(QUIET_WINDOW_MS);
          chunkAttemptsAfterRetry = await win.webContents.executeJavaScript(
            'window.__chunkAttempts[' + JSON.stringify(featureCase.id) + '] || 0',
          );
          attemptsAfterRetryAction = chunkAttemptsAfterRetry;
          await delay(QUIET_WINDOW_MS);
          attemptsAfterRetryQuietWindow = await win.webContents.executeJavaScript(
            'window.__chunkAttempts[' + JSON.stringify(featureCase.id) + '] || 0',
          );
          retryStayedContained = await win.webContents.executeJavaScript(
            "Boolean(document.querySelector('#shell-navigation')"
              + " && document.querySelector('#job-context')?.textContent.includes('本地合成岗位')"
              + " && document.querySelector('#healthy-feature') && !document.querySelector('[role=alert]'))",
          );
          retryRecovered = chunkAttemptsAfterRetry - chunkAttemptsBeforeRetry === 1;

          await win.webContents.executeJavaScript(
            'window.__matrix.resetBoundary(' + caseIndex + ',"chunk",' + JSON.stringify(token + '-feature-key') + ')',
          );
          await waitFor(win,
            \`document.querySelector('#healthy-feature')?.dataset.featureId === \${JSON.stringify(featureCase.id)}\`,
            featureCase.id + ' isolated feature-key recovery staging');
          const beforeFeatureKeyFailure = await win.webContents.executeJavaScript(
            'window.__chunkAttempts[' + JSON.stringify(featureCase.id) + '] || 0',
          );
          await win.webContents.executeJavaScript('window.__matrix.fail("chunk")');
          await waitFor(win,
            \`document.querySelector('[role=alert] h2')?.textContent === \${JSON.stringify(featureCase.label + '暂时无法显示')}\`,
            featureCase.id + ' isolated feature-key chunk failure');
          await waitFor(win,
            "document.activeElement === document.querySelector('[role=alert] h2')",
            featureCase.id + ' isolated feature-key failure focus');
          const atFeatureKeyFallback = await win.webContents.executeJavaScript(
            'window.__chunkAttempts[' + JSON.stringify(featureCase.id) + '] || 0',
          );
          await delay(QUIET_WINDOW_MS);
          const beforeFeatureKeyRecovery = await win.webContents.executeJavaScript(
            'window.__chunkAttempts[' + JSON.stringify(featureCase.id) + '] || 0',
          );
          await delay(QUIET_WINDOW_MS);
          const afterFeatureKeyFailureQuietWindow = await win.webContents.executeJavaScript(
            'window.__chunkAttempts[' + JSON.stringify(featureCase.id) + '] || 0',
          );
          await win.webContents.executeJavaScript(
            'window.__chunkRecoveryAllowed[' + JSON.stringify(featureCase.id) + '] = true',
          );
          await win.webContents.executeJavaScript(
            'window.__matrix.retryRejectedChunkWithFeatureKey(' + JSON.stringify(token + '-feature-key-recovery') + ')',
          );
          await waitFor(win,
            \`document.querySelector('#healthy-feature')?.dataset.featureId === \${JSON.stringify(featureCase.id)}\`,
            featureCase.id + ' feature-key-only chunk recovery');
          await delay(QUIET_WINDOW_MS);
          const afterFeatureKeyRecovery = await win.webContents.executeJavaScript(
            'window.__chunkAttempts[' + JSON.stringify(featureCase.id) + '] || 0',
          );
          await delay(QUIET_WINDOW_MS);
          const afterFeatureKeyRecoveryQuietWindow = await win.webContents.executeJavaScript(
            'window.__chunkAttempts[' + JSON.stringify(featureCase.id) + '] || 0',
          );
          featureKeyChunkRecovery = {
            beforeFailure: beforeFeatureKeyFailure,
            atFallback: atFeatureKeyFallback,
            beforeRecovery: beforeFeatureKeyRecovery,
            afterFailureQuietWindow: afterFeatureKeyFailureQuietWindow,
            afterRecovery: afterFeatureKeyRecovery,
            afterRecoveryQuietWindow: afterFeatureKeyRecoveryQuietWindow,
            recovered: await win.webContents.executeJavaScript(
              "Boolean(document.querySelector('#shell-navigation')"
                + " && document.querySelector('#job-context')?.textContent.includes('本地合成岗位')"
                + " && document.querySelector('#healthy-feature') && !document.querySelector('[role=alert]'))",
            ),
          };
        }

        await win.webContents.executeJavaScript('window.__matrix.routeRecover(' + JSON.stringify(token + '-route') + ')');
        await waitFor(win,
          \`document.querySelector('#healthy-feature')?.dataset.featureId === \${JSON.stringify(featureCase.id)}\`,
          featureCase.id + ' feature key reset');
        const cleanRouteVisible = await win.webContents.executeJavaScript(
          "Boolean(document.querySelector('#shell-navigation') && !document.querySelector('[role=alert]'))",
        );
        const routeKeyResetRecovered = mode === 'chunk'
          ? featureKeyChunkRecovery?.recovered === true
          : cleanRouteVisible;

        caseResult.modes[mode] = {
          initial,
          attemptsBeforeFailure,
          attemptsAtFallback,
          attemptsAfterFailureQuietWindow,
          attemptsAfterFailureSecondQuietWindow,
          attemptsBeforeRetryAction,
          attemptsAfterRetryAction,
          attemptsAfterRetryQuietWindow,
          retryStayedContained,
          retryRecovered,
          chunkAttemptsBeforeRetry,
          chunkAttemptsAfterRetry,
          featureKeyChunkRecovery,
          exitKeyboard,
          routeKeyResetRecovered,
        };
      }
      matrix.push(caseResult);
    }

    const image = await win.capturePage();
    fs.writeFileSync(screenshotPath, image.toPNG(), { mode: 0o600 });
    const result = {
      ok: true,
      contract: 'UX-G0-B2-LAZY-FAILURE-MATRIX-RUNTIME-001',
      caseCount: matrix.length,
      scenarioCount: matrix.length * 2,
      firstMount,
      matrix,
      renderAttempts: await win.webContents.executeJavaScript('window.__renderAttempts'),
      chunkAttempts: await win.webContents.executeJavaScript('window.__chunkAttempts'),
      exitEvents: await win.webContents.executeJavaScript('window.__exitEvents'),
      screenshotPath,
    };
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), { mode: 0o600 });
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(resultPath, JSON.stringify({ ok: false, error: error?.stack || String(error), matrix }, null, 2), { mode: 0o600 });
    app.exit(1);
  }
});
`, { mode: 0o600 });

  const vite = path.join(frontendRoot, 'node_modules/.bin/vite');
  runChecked(vite, ['build', '--base', './', '--outDir', distRoot, '--emptyOutDir'], {
    cwd: tempRoot,
    timeout: 120000,
  });
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
  assert.equal(result.caseCount, 11);
  assert.equal(result.scenarioCount, 22);
  assert.deepEqual(result.matrix.map((entry) => entry.id), featureCases.map((entry) => entry.id));
  result.matrix.forEach((caseResult) => {
    const manifestCase = featureCases.find((entry) => entry.id === caseResult.id);
    ['render', 'chunk'].forEach((mode) => {
      const scenario = caseResult.modes[mode];
      assert.equal(scenario.initial.heading, `${manifestCase.label}暂时无法显示`);
      assert.equal(scenario.initial.focusedHeading, true);
      assert.equal(scenario.initial.shellVisible, true);
      assert.equal(scenario.initial.jobContextVisible, true);
      assert.equal(scenario.initial.retryVisible, true);
      assert.ok(scenario.attemptsAtFallback > scenario.attemptsBeforeFailure);
      assert.equal(scenario.attemptsAfterFailureQuietWindow, scenario.attemptsAtFallback);
      assert.equal(scenario.attemptsAfterFailureSecondQuietWindow, scenario.attemptsAtFallback);
      assert.ok(scenario.attemptsAfterRetryAction > scenario.attemptsBeforeRetryAction);
      assert.equal(scenario.attemptsAfterRetryQuietWindow, scenario.attemptsAfterRetryAction);
      assert.equal(scenario.retryStayedContained, true);
      assert.equal(scenario.retryRecovered, true);
      assert.equal(scenario.routeKeyResetRecovered, true);
      if (mode === 'chunk') {
        assert.equal(scenario.attemptsAtFallback - scenario.attemptsBeforeFailure, 1);
        assert.equal(scenario.chunkAttemptsBeforeRetry, 1);
        assert.equal(scenario.chunkAttemptsAfterRetry, 2);
        assert.equal(scenario.chunkAttemptsAfterRetry - scenario.chunkAttemptsBeforeRetry, 1);
        assert.equal(scenario.featureKeyChunkRecovery.beforeFailure, 2);
        assert.equal(scenario.featureKeyChunkRecovery.atFallback - scenario.featureKeyChunkRecovery.beforeFailure, 1);
        assert.equal(scenario.featureKeyChunkRecovery.beforeRecovery, scenario.featureKeyChunkRecovery.atFallback);
        assert.equal(scenario.featureKeyChunkRecovery.afterFailureQuietWindow, scenario.featureKeyChunkRecovery.atFallback);
        assert.equal(scenario.featureKeyChunkRecovery.afterRecovery - scenario.featureKeyChunkRecovery.beforeRecovery, 1);
        assert.equal(scenario.featureKeyChunkRecovery.afterRecoveryQuietWindow, scenario.featureKeyChunkRecovery.afterRecovery);
        assert.equal(scenario.featureKeyChunkRecovery.recovered, true);
      }
      if (manifestCase.exitLabel) assert.equal(scenario.exitKeyboard, 'triggered');
      else assert.equal(scenario.exitKeyboard, 'retry-only-safe-destination');
    });
    assert.ok(result.renderAttempts[caseResult.id] >= 2, `${caseResult.id} render failure was not independent`);
    assert.equal(result.chunkAttempts[caseResult.id], 4,
      `${caseResult.id} chunk loader did not run exactly once for failure, manual retry, isolated failure, and feature-key recovery`);
  });
  console.log(JSON.stringify({ ...result, tempRoot }));
}

if (process.argv.includes('--runtime')) {
  if (process.platform === 'win32') {
    console.log('SKIP Windows GUI runtime matrix (static lazy-failure contract passed)');
  } else {
    runRuntimeMatrix();
  }
}
