'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = PROJECT_ROOT;
const distRoot = path.resolve(process.env.HRBOSS_CANDIDATE_DISPOSITION_TABS_DIST || '');
const userData = path.resolve(process.env.HRBOSS_CANDIDATE_DISPOSITION_TABS_USER_DATA || '');
const evidenceDir = path.resolve(process.env.HRBOSS_CANDIDATE_DISPOSITION_TABS_EVIDENCE || '');
const resultPath = path.resolve(process.env.HRBOSS_CANDIDATE_DISPOSITION_TABS_RESULT || '');

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

async function clickExactText(win, selector, value) {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((element) => (element.textContent || '').trim() === ${JSON.stringify(value)});
    if (!target) return false;
    target.focus();
    target.click();
    return true;
  })()`);
  assert.equal(clicked, true, `missing control: ${value}`);
}

async function clickTextContaining(win, selector, value) {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((element) => (element.textContent || '').includes(${JSON.stringify(value)}));
    if (!target) return false;
    target.focus();
    target.click();
    return true;
  })()`);
  assert.equal(clicked, true, `missing control containing: ${value}`);
}

async function clickVisibleButtonNormalized(win, value) {
  const state = await win.webContents.executeJavaScript(`(() => {
    const normalize = (text) => String(text || '').replace(/\\s+/g, '');
    const buttons = [...document.querySelectorAll('button')].filter((element) => element.offsetParent !== null);
    const target = buttons.find((element) => normalize(element.textContent) === ${JSON.stringify(value)});
    if (target) {
      target.focus();
      target.click();
    }
    return {
      clicked: Boolean(target),
      labels: buttons.map((element) => (element.textContent || '').trim()).filter(Boolean),
    };
  })()`);
  assert.equal(state.clicked, true, `missing visible button ${value}; visible buttons=${JSON.stringify(state.labels)}`);
  return state;
}

async function capture(win, name) {
  await delay(120);
  const image = await win.capturePage();
  const target = path.join(evidenceDir, `${name}.png`);
  fs.writeFileSync(target, image.toPNG(), { mode: 0o600 });
  return target;
}

async function openDispositionMenu(win, label) {
  const prepared = await win.webContents.executeJavaScript(`(() => {
    const trigger = document.querySelector('.candidate-disposition-more-trigger');
    if (!trigger) return false;
    trigger.scrollIntoView({ block: 'center', inline: 'nearest' });
    trigger.focus();
    trigger.click();
    return true;
  })()`);
  assert.equal(prepared, true, `${label} must expose the candidate disposition trigger`);
  await waitFor(win,
    "[...document.querySelectorAll('.candidate-disposition-more-menu')].some((element) => element.offsetParent !== null)",
    `${label} disposition menu`);
  await delay(180);
}

async function inspectDispositionMenu(win) {
  return win.webContents.executeJavaScript(`(() => {
    const menu = [...document.querySelectorAll('.candidate-disposition-more-menu')]
      .find((element) => element.offsetParent !== null);
    const popup = menu?.closest('.candidate-disposition-more-dropdown');
    const items = [...(menu?.querySelectorAll('.candidate-disposition-more-item') || [])];
    const dangerItems = items.filter((item) => item.classList.contains('candidate-disposition-more-item-danger'));
    const divider = menu?.querySelector('.candidate-disposition-more-divider');
    const rect = menu?.getBoundingClientRect();
    const focused = document.activeElement;
    return {
      viewport: [innerWidth, innerHeight],
      role: menu?.getAttribute('role') || '',
      popupOwned: Boolean(popup),
      labels: items.map((item) => (item.textContent || '').trim()),
      allItemsOwned: items.length === 4 && items.every((item) => item.classList.contains('candidate-disposition-more-item')),
      dangerLabels: dangerItems.map((item) => (item.textContent || '').trim()),
      dangerColors: dangerItems.map((item) => getComputedStyle(item).color),
      dividerOwned: Boolean(divider),
      dividerColor: divider ? getComputedStyle(divider).backgroundColor : '',
      focusWithinMenu: Boolean(menu && focused && menu.contains(focused)),
      focusedLabel: (focused?.textContent || '').trim(),
      rect: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width } : null,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      menuOverflow: menu ? menu.scrollWidth - menu.clientWidth : null,
    };
  })()`);
}

function assertDispositionMenu(state, label) {
  assert.equal(state.role, 'menu', `${label} must preserve Menu semantics`);
  assert.equal(state.popupOwned, true, `${label} must remain inside the documented Dropdown portal root`);
  assert.deepEqual(state.labels, ['进入人才库', '淘汰', '主动放弃', '标记录用'],
    `${label} must preserve manual disposition order and copy`);
  assert.equal(state.allItemsOwned, true, `${label} must expose owned public item classes`);
  assert.deepEqual(state.dangerLabels, ['淘汰', '主动放弃'],
    `${label} must mark exactly the dispositions MANUAL_ACTIONS flags as destructive; 标记录用 is a positive outcome`);
  assert.ok(state.dangerColors.every((color) => color === 'rgb(177, 63, 67)'),
    `${label} danger items must consume the AntD Menu danger token`);
  assert.equal(state.dividerOwned, true, `${label} must expose the public divider class`);
  assert.equal(state.dividerColor, 'rgb(215, 220, 226)', `${label} divider must consume the semantic border color`);
  assert.equal(state.focusWithinMenu, true, `${label} autoFocus must move focus into the menu`);
  assert.ok(state.rect && state.rect.width >= 210, `${label} must retain its minimum width`);
  assert.ok(state.rect.left >= -1 && state.rect.right <= state.viewport[0] + 1
    && state.rect.top >= -1 && state.rect.bottom <= state.viewport[1] + 1,
  `${label} must remain inside the viewport`);
  assert.ok(state.documentOverflow <= 1 && state.menuOverflow <= 1, `${label} must not introduce horizontal overflow`);
}

async function closeDispositionMenuWithEscape(win, label) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(win,
    "![...document.querySelectorAll('.candidate-disposition-more-menu')].some((element) => element.offsetParent !== null)",
    `${label} Escape close`);
  await waitFor(win,
    "document.activeElement?.classList.contains('candidate-disposition-more-trigger')",
    `${label} focus restoration`);
  return win.webContents.executeJavaScript(`(() => ({
    tag: document.activeElement?.tagName || '',
    label: (document.activeElement?.textContent || '').trim(),
    expanded: document.activeElement?.getAttribute('aria-expanded') || '',
  }))()`);
}

async function inspectTabs(win) {
  return win.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('.interview-workflow-tabs');
    const nav = root?.firstElementChild;
    const tabList = root?.querySelector('[role="tablist"]');
    const tabs = [...(tabList?.querySelectorAll('[role="tab"]') || [])];
    const active = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
    const activeLabel = active?.querySelector('.interview-tab-label');
    const tabItem = active?.parentElement;
    const rect = root?.getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight],
      tabListRole: tabList?.getAttribute('role') || '',
      labels: tabs.map((tab) => (tab.textContent || '').trim()),
      selectedCount: tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').length,
      selectedLabel: (active?.textContent || '').trim(),
      selectedColor: activeLabel ? getComputedStyle(activeLabel).color : '',
      navMarginBottom: nav ? getComputedStyle(nav).marginBottom : '',
      itemPaddingTop: tabItem ? getComputedStyle(tabItem).paddingTop : '',
      itemPaddingBottom: tabItem ? getComputedStyle(tabItem).paddingBottom : '',
      rect: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rootOverflow: root ? root.scrollWidth - root.clientWidth : null,
    };
  })()`);
}

function assertTabs(state, label) {
  assert.equal(state.tabListRole, 'tablist', `${label} must preserve tablist semantics`);
  assert.deepEqual(state.labels, ['当前面试轮次0', '面试准备', '录音与转写', '材料与历史0'],
    `${label} must preserve workflow labels and order`);
  assert.equal(state.selectedCount, 1, `${label} must expose exactly one selected tab`);
  assert.equal(state.navMarginBottom, '12px', `${label} must consume the 12px Tabs horizontalMargin token`);
  assert.equal(state.itemPaddingTop, '8px', `${label} must consume the 8px Tabs item padding token`);
  assert.equal(state.itemPaddingBottom, '8px', `${label} must consume the 8px Tabs item padding token`);
  assert.equal(state.selectedColor, 'rgb(0, 75, 145)', `${label} selected tab must consume the Tabs selected token`);
  assert.ok(state.rect && state.rect.left >= -1 && state.rect.right <= state.viewport[0] + 1,
    `${label} must remain inside the horizontal viewport`);
  assert.ok(state.documentOverflow <= 1 && state.rootOverflow <= 1, `${label} must not introduce horizontal overflow`);
}

async function inspectCandidateDomain(win) {
  return win.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('.candidate-domain-tabs');
    if (!root) return { error: 'missing candidate domain control' };
    const group = root.querySelector('.ant-segmented-group');
    const antItems = [...root.querySelectorAll('.ant-segmented-item')];
    const options = [...root.querySelectorAll('.candidate-domain-tab-option')];
    const sample = (element) => {
      if (!element) return null;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName,
        className: element.className,
        text: (element.textContent || '').trim(),
        style: {
          minWidth: style.minWidth,
          flex: style.flex,
          borderRadius: style.borderRadius,
          background: style.background,
          color: style.color,
          boxShadow: style.boxShadow,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          display: style.display,
          whiteSpace: style.whiteSpace,
        },
        rect: {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
      };
    };
    const optionSamples = options.map((option) => {
      const input = option.querySelector('input[type="radio"]');
      return {
        selected: Boolean(input?.checked),
        disabled: Boolean(input?.disabled),
        option: sample(option),
        strong: sample(option.querySelector('strong')),
        em: sample(option.querySelector('em')),
      };
    });
    const rootRect = root.getBoundingClientRect();
    const groupRect = group?.getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight],
      root: sample(root),
      group: sample(group),
      optionCount: optionSamples.length,
      antItemCount: antItems.length,
      allOptionsOwned: antItems.length > 0
        && antItems.every((item) => item.classList.contains('candidate-domain-tab-option')),
      selectedCount: optionSamples.filter((option) => option.selected).length,
      selected: optionSamples.find((option) => option.selected) || null,
      options: optionSamples,
      containment: {
        groupInsideRoot: Boolean(groupRect
          && groupRect.left >= rootRect.left - 1
          && groupRect.right <= rootRect.right + 1),
        optionsInsideGroup: Boolean(groupRect && optionSamples.every(({ option }) => option?.rect
          && option.rect.left >= groupRect.left - 1
          && option.rect.right <= groupRect.right + 1)),
      },
      overflow: {
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
        root: root.scrollWidth - root.clientWidth,
        group: group ? group.scrollWidth - group.clientWidth : null,
      },
    };
  })()`);
}

function assertCandidateDomain(state, label) {
  assert.equal(state.error, undefined, `${label} must render the candidate domain control`);
  assert.ok(state.root && state.group, `${label} must retain the Segmented root and group`);
  assert.ok(state.optionCount > 0, `${label} must render candidate domain options`);
  assert.equal(state.antItemCount, state.optionCount,
    `${label} must expose the public option class on every Segmented item`);
  assert.equal(state.allOptionsOwned, true,
    `${label} must use candidate-domain-tab-option instead of private item selectors`);
  assert.equal(state.selectedCount, 1, `${label} must expose exactly one selected candidate domain`);
  assert.ok(state.options.every(({ option, strong, em }) => option && strong && em),
    `${label} must retain the owned option label structure`);
  assert.equal(state.containment.groupInsideRoot, true, `${label} group must remain inside the root`);
  assert.equal(state.containment.optionsInsideGroup, true, `${label} options must remain inside the group`);
  assert.ok(Object.values(state.overflow).every((value) => value !== null && value <= 1),
    `${label} must not introduce horizontal overflow`);
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
      preload: path.join(ROOT, "tests/check-ui-visual-runtime-preload.js"),
      additionalArguments: ['--hrboss-runtime-scenario=candidate-disposition-tabs'],
    },
  });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event && (event.level === 'error' || Number(event.level) >= 3)) errors.push(event.message);
  });
  try {
    win.setContentSize(1100, 720);
    await win.loadFile(path.join(distRoot, 'index.html'));
    win.webContents.focus();
    await waitFor(win, "document.querySelector('button.nav-item')", 'navigation');
    await clickExactText(win, 'button.nav-item', '候选人');
    await waitFor(win, "document.querySelector('.candidate-card')", 'synthetic candidate list');
    await clickTextContaining(win, '.candidate-card', '合成候选人');
    await waitFor(win, "document.querySelector('.candidate-disposition-more-trigger')", 'candidate detail disposition controls');

    await openDispositionMenu(win, '1100x720 candidate disposition menu');
    const menu1100 = await inspectDispositionMenu(win);
    assert.deepEqual(menu1100.viewport, [1100, 720], '1100x720 must use the exact Electron content viewport');
    assertDispositionMenu(menu1100, '1100x720 candidate disposition menu');
    const menuEvidence1100 = await capture(win, 'candidate-disposition-menu-1100x720');
    const escape1100 = await closeDispositionMenuWithEscape(win, '1100x720 candidate disposition menu');
    assert.deepEqual(escape1100, { tag: 'BUTTON', label: '更多处置', expanded: 'false' });

    await openDispositionMenu(win, '1100x720 destructive disposition confirmation');
    await clickExactText(win, '.candidate-disposition-more-item-danger', '淘汰');
    await waitFor(win,
      "[...document.querySelectorAll('[role=dialog]')].some((element) => element.offsetParent !== null)",
      'destructive disposition confirmation');
    const confirmationButtons = await clickVisibleButtonNormalized(win, '取消');
    await waitFor(win,
      "![...document.querySelectorAll('[role=dialog]')].some((element) => element.offsetParent !== null)",
      'destructive disposition confirmation cancel');
    await waitFor(win,
      "document.activeElement?.classList.contains('candidate-disposition-more-trigger')",
      'destructive disposition focus restoration');
    const runtimeAfterCancel = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
    assert.equal(runtimeAfterCancel.actionWriteCalls, 0,
      'opening and cancelling a destructive disposition must not invoke the synthetic action API');

    await clickTextContaining(win, '.candidate-domain-tab-option', '面试');
    await waitFor(win, "document.querySelector('.interview-workflow-tabs')", 'interview workflow tabs');
    await win.webContents.executeJavaScript("document.querySelector('.candidate-domain-tabs')?.scrollIntoView({ block: 'center' })");
    await delay(180);
    const candidateDomain1100 = await inspectCandidateDomain(win);
    assert.deepEqual(candidateDomain1100.viewport, [1100, 720],
      '1100x720 candidate domain must use the exact Electron content viewport');
    assertCandidateDomain(candidateDomain1100, '1100x720 candidate domain');
    const candidateDomainEvidence1100 = await capture(win, 'candidate-domain-1100x720');
    await win.webContents.executeJavaScript("document.querySelector('.interview-workflow-tabs')?.scrollIntoView({ block: 'center' })");
    await delay(180);
    const tabs1100 = await inspectTabs(win);
    assertTabs(tabs1100, '1100x720 interview workflow tabs');
    const tabsEvidence1100 = await capture(win, 'interview-tabs-1100x720');

    win.setContentSize(1360, 768);
    win.webContents.setZoomFactor(1.25);
    await delay(240);
    await win.webContents.executeJavaScript("document.querySelector('.candidate-domain-tabs')?.scrollIntoView({ block: 'center' })");
    await delay(180);
    const candidateDomain125 = await inspectCandidateDomain(win);
    assert.ok(Math.abs(candidateDomain125.viewport[0] - 1088) <= 1
      && Math.abs(candidateDomain125.viewport[1] - 614) <= 1,
    'Windows 125% candidate domain must expose the expected 1088x614 CSS viewport');
    assertCandidateDomain(candidateDomain125, 'Windows 125% candidate domain');
    const candidateDomainEvidence125 = await capture(win, 'candidate-domain-1360x768-windows125');
    await openDispositionMenu(win, 'Windows 125% candidate disposition menu');
    const menu125 = await inspectDispositionMenu(win);
    assert.ok(Math.abs(menu125.viewport[0] - 1088) <= 1 && Math.abs(menu125.viewport[1] - 614) <= 1,
      'Windows 125% must expose the expected 1088x614 CSS viewport');
    assertDispositionMenu(menu125, 'Windows 125% candidate disposition menu');
    const menuEvidence125 = await capture(win, 'candidate-disposition-menu-1360x768-windows125');
    const escape125 = await closeDispositionMenuWithEscape(win, 'Windows 125% candidate disposition menu');
    assert.deepEqual(escape125, { tag: 'BUTTON', label: '更多处置', expanded: 'false' });

    await win.webContents.executeJavaScript("document.querySelector('.interview-workflow-tabs')?.scrollIntoView({ block: 'center' })");
    await delay(180);
    const tabs125 = await inspectTabs(win);
    assert.ok(Math.abs(tabs125.viewport[0] - 1088) <= 1 && Math.abs(tabs125.viewport[1] - 614) <= 1,
      'Windows 125% Tabs must expose the expected 1088x614 CSS viewport');
    assertTabs(tabs125, 'Windows 125% interview workflow tabs');
    const tabsEvidence125 = await capture(win, 'interview-tabs-1360x768-windows125');

    win.webContents.setZoomFactor(1.5);
    await delay(240);
    await win.webContents.executeJavaScript("document.querySelector('.candidate-domain-tabs')?.scrollIntoView({ block: 'center' })");
    await delay(180);
    const candidateDomain150 = await inspectCandidateDomain(win);
    assert.ok(Math.abs(candidateDomain150.viewport[0] - 907) <= 1
      && Math.abs(candidateDomain150.viewport[1] - 512) <= 1,
    'Windows 150% candidate domain must expose the expected 907x512 CSS viewport');
    assertCandidateDomain(candidateDomain150, 'Windows 150% candidate domain');
    const candidateDomainEvidence150 = await capture(win, 'candidate-domain-1360x768-windows150');
    await openDispositionMenu(win, 'Windows 150% candidate disposition menu');
    const menu150 = await inspectDispositionMenu(win);
    assert.ok(Math.abs(menu150.viewport[0] - 907) <= 1 && Math.abs(menu150.viewport[1] - 512) <= 1,
      'Windows 150% must expose the expected 907x512 CSS viewport');
    assertDispositionMenu(menu150, 'Windows 150% candidate disposition menu');
    const menuEvidence150 = await capture(win, 'candidate-disposition-menu-1360x768-windows150');
    const escape150 = await closeDispositionMenuWithEscape(win, 'Windows 150% candidate disposition menu');
    assert.deepEqual(escape150, { tag: 'BUTTON', label: '更多处置', expanded: 'false' });

    await win.webContents.executeJavaScript("document.querySelector('.interview-workflow-tabs')?.scrollIntoView({ block: 'center' })");
    await delay(180);
    const tabs150 = await inspectTabs(win);
    assert.ok(Math.abs(tabs150.viewport[0] - 907) <= 1 && Math.abs(tabs150.viewport[1] - 512) <= 1,
      'Windows 150% Tabs must expose the expected 907x512 CSS viewport');
    assertTabs(tabs150, 'Windows 150% interview workflow tabs');
    const tabsEvidence150 = await capture(win, 'interview-tabs-1360x768-windows150');

    const finalRuntime = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
    assert.equal(finalRuntime.actionWriteCalls, 0, 'scoped runtime must not write candidate disposition state');
    assert.deepEqual(errors, [], 'renderer must not emit console errors');
    return {
      ok: true,
      menu: {
        at1100: menu1100,
        escape1100,
        windows125: menu125,
        escape125,
        windows150: menu150,
        escape150,
      },
      tabs: { at1100: tabs1100, windows125: tabs125, windows150: tabs150 },
      candidateDomain: {
        at1100: candidateDomain1100,
        windows125: candidateDomain125,
        windows150: candidateDomain150,
      },
      confirmationButtons,
      runtime: finalRuntime,
      evidence: {
        menu1100: menuEvidence1100,
        tabs1100: tabsEvidence1100,
        candidateDomain1100: candidateDomainEvidence1100,
        menu125: menuEvidence125,
        tabs125: tabsEvidence125,
        candidateDomain125: candidateDomainEvidence125,
        menu150: menuEvidence150,
        tabs150: tabsEvidence150,
        candidateDomain150: candidateDomainEvidence150,
      },
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
