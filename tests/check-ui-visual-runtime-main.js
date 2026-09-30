'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const ROOT = PROJECT_ROOT;
const distRoot = path.resolve(process.env.HRBOSS_VISUAL_RUNTIME_DIST || '');
const resultPath = path.resolve(process.env.HRBOSS_VISUAL_RUNTIME_RESULT || '');
const userData = path.resolve(process.env.HRBOSS_VISUAL_RUNTIME_USER_DATA || '');
const evidenceDir = path.resolve(process.env.HRBOSS_VISUAL_RUNTIME_EVIDENCE_DIR || '');

if (!distRoot || !resultPath || !userData || !evidenceDir) throw new Error('visual runtime paths are required');
fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
app.setPath('userData', userData);
app.commandLine.appendSwitch('disable-features', 'LocalNetworkAccessChecks');

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

async function captureEvidence(win, name) {
  // Success notices may be deferred (a transactional confirm fires its toast
  // from afterClose, and refresh notices ride async chains), so a single
  // clear poll can land in the gap right before a late toast pops. Only
  // trust the all-clear once it has held for several consecutive polls.
  const overlayDeadline = Date.now() + 15_000;
  let quietPolls = 0;
  while (Date.now() < overlayDeadline) {
    const transientOverlayVisible = await win.webContents.executeJavaScript(`Boolean(
      [...document.querySelectorAll('.ant-message-notice, .ant-notification-notice')]
        .some((element) => element.offsetParent !== null)
    )`);
    if (transientOverlayVisible) {
      quietPolls = 0;
    } else {
      quietPolls += 1;
      if (quietPolls >= 5) break;
    }
    await delay(100);
  }
  const activeOverlays = await win.webContents.executeJavaScript(`[
    ...document.querySelectorAll('.ant-message-notice, .ant-notification-notice')
  ].filter((element) => element.offsetParent !== null)
    .map((element) => (element.textContent || '').trim())
    .filter(Boolean)`);
  assert.deepEqual(activeOverlays, [], `${name} screenshot must not be obscured by a transient message or notification`);
  const motionDeadline = Date.now() + 3_000;
  while (Date.now() < motionDeadline) {
    const overlayMotionRunning = await win.webContents.executeJavaScript(`document.getAnimations()
      .some((animation) => {
        const target = animation.effect && animation.effect.target;
        const style = target instanceof Element ? getComputedStyle(target) : null;
        return animation.playState === 'running'
          && target instanceof Element
          && target.getClientRects().length > 0
          && style?.display !== 'none'
          && style?.visibility !== 'hidden'
          && target.matches('.ant-modal, .ant-modal-content, .ant-modal-wrap, .ant-modal-mask, .ant-select-dropdown');
      })`);
    if (!overlayMotionRunning) break;
    await delay(50);
  }
  await delay(120);
  const image = await win.capturePage();
  const target = path.join(evidenceDir, `${name}.png`);
  fs.writeFileSync(target, image.toPNG(), { mode: 0o600 });
  return target;
}

async function captureChromiumAccessibilityTree(win) {
  const client = win.webContents.debugger;
  const attachedHere = !client.isAttached();
  if (attachedHere) client.attach('1.3');
  try {
    await client.sendCommand('Accessibility.enable');
    const { nodes = [] } = await client.sendCommand('Accessibility.getFullAXTree');
    const includedRoles = new Set([
      'alert',
      'button',
      'link',
      'listbox',
      'main',
      'menu',
      'menuitem',
      'navigation',
      'option',
      'region',
      'status',
      'tab',
      'tablist',
    ]);
    const semanticNodes = nodes
      .map((node) => {
        const role = String(node.role?.value || '').toLowerCase();
        const properties = Object.fromEntries((node.properties || []).map((property) => [
          property.name,
          property.value?.value ?? null,
        ]));
        return {
          role,
          name: String(node.name?.value || ''),
          description: String(node.description?.value || ''),
          ignored: Boolean(node.ignored),
          properties,
        };
      })
      .filter((node) => !node.ignored && includedRoles.has(node.role));
    const hasNode = (role, name) => semanticNodes.some((node) => node.role === role
      && (typeof name === 'string' ? node.name === name : name.test(node.name)));
    assert.equal(hasNode('link', '跳到主要内容'), true,
      'Chromium AX tree must expose the skip link to screen readers');
    assert.equal(hasNode('main', /.*/), true,
      'Chromium AX tree must expose the main landmark');
    assert.equal(hasNode('navigation', '主导航'), true,
      'Chromium AX tree must expose the primary navigation label');
    assert.equal(hasNode('listbox', '候选人列表'), true,
      'Chromium AX tree must expose the candidate listbox');
    assert.equal(hasNode('option', /内部候选人 ID/), true,
      'Chromium AX tree must expose a named candidate option with its stable identifier');
    assert.equal(hasNode('region', '当前候选人身份锚点'), true,
      'Chromium AX tree must expose the selected candidate identity landmark');
    assert.equal(hasNode('button', '收起候选人列表'), true,
      'Chromium AX tree must expose the candidate list collapse control');
    return {
      source: 'Chromium Accessibility.getFullAXTree',
      node_count: nodes.length,
      semantic_node_count: semanticNodes.length,
      required_nodes: {
        skip_link: true,
        main_landmark: true,
        primary_navigation: true,
        candidate_listbox: true,
        named_candidate_option: true,
        selected_candidate_identity: true,
        candidate_list_control: true,
      },
      nodes: semanticNodes,
    };
  } finally {
    try { await client.sendCommand('Accessibility.disable'); } catch {}
    if (attachedHere && client.isAttached()) client.detach();
  }
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
  assert.equal(clicked, true, `missing clickable text: ${text}`);
}

async function clickTextContaining(win, selector, text) {
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})]
      .find((element) => (element.textContent || '').includes(${JSON.stringify(text)}));
    if (!target) return false;
    target.click();
    return true;
  })()`);
  assert.equal(clicked, true, `missing clickable text containing: ${text}`);
}

async function clickDesktopUtilityItem(win, label) {
  await clickExactText(win, '.app-nav-footer-main', '设置与帮助');
  await waitFor(win,
    "[...document.querySelectorAll('.app-nav-utility-menu-item')].some((element) => element.offsetParent !== null)",
    'desktop utility menu');
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const title = [...document.querySelectorAll('.app-nav-utility-menu-title')]
      .find((element) => element.offsetParent !== null && element.textContent.trim() === ${JSON.stringify(label)});
    const item = title?.closest('.app-nav-utility-menu-item');
    if (!item) return false;
    item.click();
    return true;
  })()`);
  assert.equal(clicked, true, `missing desktop utility item: ${label}`);
}

async function verifyDesktopUtilityMenuContract(win) {
  const focusTrigger = await win.webContents.executeJavaScript(`(() => {
    const trigger = document.querySelector('.app-nav-footer-main');
    if (!trigger || !trigger.offsetParent) return false;
    trigger.focus();
    return document.activeElement === trigger;
  })()`);
  assert.equal(focusTrigger, true, 'desktop utility trigger must accept keyboard focus');

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(win,
    "[...document.querySelectorAll('.app-nav-utility-menu-item')].some((element) => element.offsetParent !== null)",
    'desktop utility menu opened with Enter');
  const contract = await win.webContents.executeJavaScript(`(() => {
    const items = [...document.querySelectorAll('.app-nav-utility-menu-item')]
      .filter((element) => element.offsetParent !== null);
    return {
      expanded: document.querySelector('.app-nav-footer-main')?.getAttribute('aria-expanded'),
      controls: document.querySelector('.app-nav-footer-main')?.getAttribute('aria-controls') || '',
      menuId: items[0]?.closest('[role="menu"]')?.id || '',
      labelVisible: (document.querySelector('.app-nav-footer-label')?.getBoundingClientRect().width || 0) > 0,
      triggerHeight: document.querySelector('.app-nav-footer-main')?.getBoundingClientRect().height || 0,
      oldHelpCount: document.querySelectorAll('.app-nav-help-button').length,
      disclosureOpen: document.querySelector('.app-nav-footer-disclosure')?.classList.contains('open') || false,
      labels: items.map((item) => (item.querySelector('.app-nav-utility-menu-title')?.textContent || '').trim()),
      descriptions: items.map((item) => (item.querySelector('.app-nav-utility-menu-description')?.textContent || '').trim()),
      uniqueKeys: new Set(items.map((item) => item.getAttribute('data-menu-id') || item.textContent.trim())).size,
      bodyPortal: items.every((item) => !document.getElementById('root')?.contains(item)),
    };
  })()`);
  assert.deepEqual(contract, {
    expanded: 'true',
    controls: 'app-nav-utility-menu',
    menuId: 'app-nav-utility-menu',
    labelVisible: true,
    triggerHeight: 44,
    oldHelpCount: 0,
    disclosureOpen: true,
    labels: ['使用指南', '设置中心', '本机状态', '关于招才官'],
    descriptions: ['流程说明与操作帮助', '状态、连接、面试与数据', '服务、数据和运行检查', '版本与本机诊断'],
    uniqueKeys: 4,
    bodyPortal: true,
  }, 'desktop utility popup must expose four deduplicated destinations through one visible trigger');

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(win,
    "document.querySelector('.app-nav-footer-main')?.getAttribute('aria-expanded') === 'false'",
    'desktop utility Escape close');
  await waitFor(win,
    "document.activeElement === document.querySelector('.app-nav-footer-main')",
    'desktop utility Escape focus restoration');

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await waitFor(win,
    "document.querySelector('.app-nav-footer-main')?.getAttribute('aria-expanded') === 'true'",
    'desktop utility menu opened with Space');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(win,
    "document.querySelector('.app-nav-footer-main')?.getAttribute('aria-expanded') === 'false'",
    'desktop utility Space cycle close');
}

async function clickDesktopGuide(win) {
  return clickDesktopUtilityItem(win, '使用指南');
}

async function getSurfaceLayout(win, selector) {
  return win.webContents.executeJavaScript(`(() => {
    const surface = document.querySelector(${JSON.stringify(selector)});
    const workspace = surface?.closest('.workspace') || document.querySelector('.workspace');
    const mainWorkspace = document.getElementById('main-workspace');
    const moduleHeading = mainWorkspace?.querySelector('[data-module-heading]');
    const activeElement = document.activeElement;
    const workspaceStyle = mainWorkspace ? getComputedStyle(mainWorkspace) : null;
    const documentElement = document.documentElement;
    const isVisible = (element) => Boolean(element && element.getClientRects().length
      && getComputedStyle(element).visibility !== 'hidden');
    const measure = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflow: element.scrollWidth - element.clientWidth,
        rect: {
          left: Math.round(box.left),
          right: Math.round(box.right),
          top: Math.round(box.top),
          bottom: Math.round(box.bottom),
        },
      };
    };
    return {
      cssViewport: [innerWidth, innerHeight],
      document: {
        clientWidth: documentElement.clientWidth,
        scrollWidth: documentElement.scrollWidth,
        overflow: documentElement.scrollWidth - documentElement.clientWidth,
      },
      workspace: measure(workspace),
      surface: measure(surface),
      activeNavigation: (() => {
        const primary = document.querySelector('button.nav-item.active');
        if (primary) return (primary.textContent || '').trim();
        const utility = document.querySelector('.app-nav-footer-main[data-active="true"]')?.getAttribute('data-active-nav');
        if (utility) return utility;
        return document.querySelector('.mobile-module-nav select')?.value || '';
      })(),
      semanticHeadings: [...document.querySelectorAll('#main-workspace h1')]
        .map((element) => (element.textContent || '').trim()),
      navigationFocus: {
        activeIsModuleHeading: activeElement === moduleHeading,
        activeIsWorkspace: activeElement === mainWorkspace,
        activeText: (activeElement?.textContent || '').trim(),
        headingHasTabIndex: moduleHeading?.hasAttribute('tabindex') || false,
        workspaceFocusVisible: Boolean(mainWorkspace?.matches(':focus-visible')),
        workspaceOutlineVisible: Boolean(workspaceStyle
          && workspaceStyle.outlineStyle !== 'none'
          && Number.parseFloat(workspaceStyle.outlineWidth) > 0),
      },
      landmarks: {
        visibleMainCount: [...document.querySelectorAll('main#main-workspace')].filter(isVisible).length,
        visibleMainTags: [...document.querySelectorAll('#main-workspace')]
          .filter(isVisible)
          .map((element) => element.tagName),
        primaryNavigationCount: [...document.querySelectorAll('nav[aria-label="主导航"]')].filter(isVisible).length,
        utilityNavigationCount: [...document.querySelectorAll('nav[aria-label="帮助与设置"]')].filter(isVisible).length,
        mobileNavigationCount: [...document.querySelectorAll('nav[aria-label="移动端主导航"]')].filter(isVisible).length,
        mobileCurrentValue: isVisible(document.querySelector('.mobile-module-nav select'))
          ? document.querySelector('.mobile-module-nav select')?.value || ''
          : '',
        currentPageLabels: [
          ...document.querySelectorAll('nav[aria-label="主导航"] [aria-current="page"], nav[aria-label="帮助与设置"] [aria-current="page"]'),
          ...document.querySelectorAll('nav[aria-label="帮助与设置"] .app-nav-footer-main[data-active="true"]'),
        ]
          .filter(isVisible)
          .map((element) => element.getAttribute('data-active-nav')
            || element.getAttribute('data-nav-target')
            || (element.textContent || '').trim()),
      },
    };
  })()`);
}

async function verifyCandidateActionMenu(win, evidenceName) {
  const restored = await win.webContents.executeJavaScript(`(() => {
    const trigger = document.querySelector('.candidate-module-actions button');
    if (trigger?.offsetParent) return 'already-visible';
    const restore = document.querySelector('button[aria-label="展开候选人列表"]');
    if (!restore) return 'missing';
    restore.click();
    return 'restored';
  })()`);
  assert.notEqual(restored, 'missing', `${evidenceName} candidate list controls must remain reachable`);
  await waitFor(win,
    "Boolean(document.querySelector('.candidate-module-actions button')?.offsetParent)",
    `${evidenceName} candidate action trigger`);
  await clickExactText(win, '.candidate-module-actions button', '候选人操作');
  await waitFor(win,
    "[...document.querySelectorAll('.ant-dropdown-menu')].some((menu) => menu.offsetParent !== null && (menu.textContent || '').includes('导入 Boss App 截图'))",
    `${evidenceName} candidate action menu`);
  await delay(120);
  const state = await win.webContents.executeJavaScript(`(() => {
    const menu = [...document.querySelectorAll('.ant-dropdown-menu')]
      .find((element) => element.offsetParent !== null
        && (element.textContent || '').includes('导入 Boss App 截图'));
    const items = [...(menu?.querySelectorAll('.ant-dropdown-menu-item') || [])];
    const disabledItems = items.filter((item) => item.getAttribute('aria-disabled') === 'true');
    const box = menu?.getBoundingClientRect();
    return {
      menuRole: menu?.getAttribute('role') || '',
      labels: items.map((item) => (item.textContent || '').trim()),
      itemRoles: items.map((item) => item.getAttribute('role') || ''),
      disabledLabels: disabledItems.map((item) => (item.textContent || '').trim()),
      dividerCount: menu?.querySelectorAll('.ant-dropdown-menu-item-divider').length || 0,
      rect: box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width } : null,
      viewport: [innerWidth, innerHeight],
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  assert.equal(state.menuRole, 'menu', `${evidenceName} candidate actions must retain native menu semantics`);
  assert.deepEqual(state.labels, [
    '导入 Boss App 截图',
    '校对 OCR 草稿',
    '批量规则评级',
  ], `${evidenceName} candidate-owned actions and order must remain explicit`);
  assert.ok(state.itemRoles.every((role) => role === 'menuitem'),
    `${evidenceName} candidate actions must remain keyboard menu items`);
  assert.deepEqual(state.disabledLabels, [],
    `${evidenceName} local candidate actions must stay enabled for a writable job`);
  assert.equal(state.dividerCount, 0, `${evidenceName} candidate actions no longer have a platform-read group to separate`);
  assert.ok(state.rect
    && state.rect.left >= -1 && state.rect.right <= state.viewport[0] + 1
    && state.rect.top >= -1 && state.rect.bottom <= state.viewport[1] + 1,
  `${evidenceName} candidate action menu must stay inside the viewport`);
  assert.ok(state.documentOverflow <= 1, `${evidenceName} candidate action menu must not create document overflow`);
  const evidence = await captureEvidence(win, evidenceName);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(win,
    "![...document.querySelectorAll('.ant-dropdown-menu')].some((menu) => menu.offsetParent !== null && (menu.textContent || '').includes('导入 Boss App 截图'))",
    `${evidenceName} candidate action menu Escape close`);
  const focus = await win.webContents.executeJavaScript(`(() => ({
    tag: document.activeElement?.tagName || '',
    label: document.activeElement?.getAttribute('aria-label') || '',
    text: (document.activeElement?.innerText || '').trim(),
    expanded: document.activeElement?.getAttribute('aria-expanded') || '',
  }))()`);
  assert.deepEqual(focus, {
    tag: 'BUTTON',
    label: '候选人模块操作',
    text: '候选人操作',
    expanded: '',
  }, `${evidenceName} Escape must return focus to the candidate action trigger`);
  return { ...state, focus, evidence };
}

async function verifyCandidateDispositionMenu(win, evidenceName) {
  await win.webContents.executeJavaScript(`document.querySelector('.candidate-disposition-more-trigger')?.scrollIntoView({ block: 'center' })`);
  await delay(100);
  await clickExactText(win, '.candidate-disposition-more-trigger', '更多处置');
  await waitFor(win,
    "[...document.querySelectorAll('.candidate-disposition-more-menu')].some((element) => element.offsetParent !== null)",
    `${evidenceName} candidate disposition menu`);
  await delay(120);
  const state = await win.webContents.executeJavaScript(`(() => {
    const menu = [...document.querySelectorAll('.candidate-disposition-more-menu')]
      .find((element) => element.offsetParent !== null);
    const popup = menu?.closest('.candidate-disposition-more-dropdown');
    const items = [...(menu?.querySelectorAll('.candidate-disposition-more-item') || [])];
    const dangerItems = items.filter((item) => item.classList.contains('candidate-disposition-more-item-danger'));
    const dividers = [...(menu?.querySelectorAll('.candidate-disposition-more-divider') || [])];
    const box = menu?.getBoundingClientRect();
    return {
      menuRole: menu?.getAttribute('role') || '',
      popupOwned: Boolean(popup),
      itemLabels: items.map((item) => (item.textContent || '').trim()),
      itemRoles: items.map((item) => item.getAttribute('role')),
      ownedLabelCount: menu?.querySelectorAll('.candidate-disposition-more-label').length || 0,
      dangerCount: dangerItems.length,
      dangerColors: dangerItems.map((item) => getComputedStyle(item).color),
      itemLayouts: items.map((item) => {
        const label = item.querySelector('.candidate-disposition-more-label');
        const labelBox = label?.getBoundingClientRect();
        const labelStyle = label ? getComputedStyle(label) : null;
        return {
          label: (label?.textContent || '').trim(),
          width: labelBox?.width || 0,
          height: labelBox?.height || 0,
          lineHeight: Number.parseFloat(labelStyle?.lineHeight || '0'),
          whiteSpace: labelStyle?.whiteSpace || '',
        };
      }),
      dividerCount: dividers.length,
      rect: box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width } : null,
      viewport: [innerWidth, innerHeight],
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  assert.equal(state.menuRole, 'menu', `${evidenceName} candidate disposition popup must retain menu semantics`);
  assert.equal(state.popupOwned, true, `${evidenceName} candidate disposition popup must retain its documented portal root`);
  assert.deepEqual(state.itemLabels, ['进入人才库', '淘汰', '主动放弃', '标记录用'],
    `${evidenceName} candidate disposition actions and order must remain unchanged`);
  assert.ok(state.itemRoles.every((role) => role === 'menuitem'),
    `${evidenceName} candidate disposition actions must remain native Menu items`);
  assert.equal(state.ownedLabelCount, state.itemLabels.length,
    `${evidenceName} every candidate disposition item must expose its owned label class`);
  assert.equal(state.dangerCount, 2, `${evidenceName} only the dispositions MANUAL_ACTIONS flags as destructive may render danger; 标记录用 is a positive outcome`);
  assert.ok(state.dangerColors.every((color) => color === 'rgb(177, 63, 67)'),
    `${evidenceName} destructive disposition color must come from the AntD 5 Menu danger token`);
  assert.ok(state.itemLayouts.every((item) => item.whiteSpace === 'nowrap'
    && item.width > 0 && item.height <= item.lineHeight + 1),
  `${evidenceName} candidate disposition labels must remain on one readable line`);
  assert.equal(state.dividerCount, 1, `${evidenceName} candidate disposition grouping divider must remain visible`);
  assert.ok(state.rect && state.rect.width >= 209
    && state.rect.left >= -1 && state.rect.right <= state.viewport[0] + 1
    && state.rect.top >= -1 && state.rect.bottom <= state.viewport[1] + 1,
  `${evidenceName} candidate disposition menu must stay inside the viewport`);
  assert.ok(state.documentOverflow <= 1, `${evidenceName} candidate disposition menu must not create document overflow`);
  const evidence = await captureEvidence(win, evidenceName);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(win,
    "![...document.querySelectorAll('.candidate-disposition-more-menu')].some((element) => element.offsetParent !== null)",
    `${evidenceName} candidate disposition menu Escape close`);
  const focus = await win.webContents.executeJavaScript(`(() => ({
    tag: document.activeElement?.tagName || '',
    label: document.activeElement?.getAttribute('aria-label') || '',
    expanded: document.activeElement?.getAttribute('aria-expanded') || '',
  }))()`);
  assert.deepEqual(focus, { tag: 'BUTTON', label: '打开更多 HR 人工处置', expanded: 'false' },
    `${evidenceName} Escape must restore focus to the closed candidate disposition trigger`);
  return { ...state, focus, evidence };
}

async function captureModuleSkeletons(win, width, height, options = {}) {
  const zoomFactor = Number(options.zoomFactor || 1);
  const viewportName = options.viewportName || `${width}x${height}`;
  const useMobileNavigation = width / zoomFactor <= 900;
  const modules = [
    { key: 'workbench', navigation: '工作台', selector: '.dashboard-v2-focus-grid' },
    { key: 'jobs', navigation: '职位管理', selector: '.job-ledger-page' },
    { key: 'candidates', navigation: '候选人', selector: '.candidate-detail-content' },
    { key: 'interviews', navigation: '面试安排', selector: '.interview-schedule-panel' },
    { key: 'talent_pool', navigation: '人才库', selector: '.talent-pool-page' },
    { key: 'settings', navigation: '设置', selector: '.settings-panel' },
  ];
  const results = {};

  win.webContents.setZoomFactor(zoomFactor);
  win.setContentSize(width, height);
  await delay(180);
  for (const [moduleIndex, module] of modules.entries()) {
    if (moduleIndex > 0) {
      await win.webContents.executeJavaScript(`(() => {
        const workspace = document.getElementById('main-workspace');
        window.scrollTo(0, document.documentElement.scrollHeight);
        if (workspace) {
          workspace.scrollTop = workspace.scrollHeight;
          workspace.scrollLeft = workspace.scrollWidth;
        }
      })()`);
    }
    if (useMobileNavigation) {
      await waitFor(win,
        "Boolean(document.querySelector('.mobile-module-nav select')?.offsetParent)",
        `${module.navigation} visible mobile module selector at ${viewportName}`);
      const selected = await win.webContents.executeJavaScript(`(() => {
        const select = document.querySelector('.mobile-module-nav select');
        if (!select || select.offsetParent === null) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
        setter?.call(select, ${JSON.stringify(module.navigation)});
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      assert.equal(selected, true, `${module.navigation} needs the visible mobile module selector at ${viewportName}`);
    } else if (module.navigation === '设置') await clickDesktopUtilityItem(win, '设置中心');
    else await clickExactText(win, 'button.nav-item', module.navigation);
    await waitFor(win, `document.querySelector(${JSON.stringify(module.selector)})`, `${module.navigation} module skeleton`);
    if (module.navigation !== '设置') {
      await waitFor(win,
        "document.activeElement === document.querySelector('#main-workspace [data-module-heading]')",
        `${module.navigation} module heading focus handoff`);
    }
    await delay(160);
    const layout = await getSurfaceLayout(win, module.selector);
    const navigationScroll = await win.webContents.executeJavaScript(`(() => {
      const workspace = document.getElementById('main-workspace');
      const heading = workspace?.querySelector('[data-module-heading]');
      const headingRect = heading?.getBoundingClientRect();
      return {
        windowY: window.scrollY,
        workspaceTop: workspace?.scrollTop ?? null,
        workspaceLeft: workspace?.scrollLeft ?? null,
        headingTop: headingRect?.top ?? null,
        viewportHeight: innerHeight,
      };
    })()`);
    const expectedCssViewport = [Math.round(width / zoomFactor), Math.round(height / zoomFactor)];
    assert.ok(Math.abs(layout.cssViewport[0] - expectedCssViewport[0]) <= 1
      && Math.abs(layout.cssViewport[1] - expectedCssViewport[1]) <= 1,
    `${module.navigation} must be sampled at ${viewportName}`);
    assert.equal(layout.activeNavigation, module.navigation, `${module.navigation} must remain the active module`);
    assert.deepEqual(layout.semanticHeadings, [module.navigation],
      `${module.navigation} must expose exactly one semantic H1`);
    if (module.navigation !== '设置') {
      assert.deepEqual(layout.navigationFocus, {
        activeIsModuleHeading: true,
        activeIsWorkspace: false,
        activeText: module.navigation,
        headingHasTabIndex: true,
        workspaceFocusVisible: false,
        workspaceOutlineVisible: false,
      }, `${module.navigation} navigation must focus its semantic heading without outlining the whole workspace`);
    }
    assert.deepEqual(layout.landmarks, useMobileNavigation ? {
      visibleMainCount: 1,
      visibleMainTags: ['MAIN'],
      primaryNavigationCount: 0,
      utilityNavigationCount: 0,
      mobileNavigationCount: 1,
      mobileCurrentValue: module.navigation,
      currentPageLabels: [],
    } : {
      visibleMainCount: 1,
      visibleMainTags: ['MAIN'],
      primaryNavigationCount: 1,
      utilityNavigationCount: 1,
      mobileNavigationCount: 0,
      mobileCurrentValue: '',
      currentPageLabels: [module.navigation],
    }, `${module.navigation} must expose one visible main and the correct responsive navigation landmark`);
    assert.ok(layout.surface, `${module.navigation} must expose its module surface`);
    assert.ok(layout.document.overflow <= 1, `${module.navigation} must not overflow the ${viewportName} document horizontally`);
    assert.ok(layout.workspace && layout.workspace.overflow <= 1,
      `${module.navigation} workspace must contain horizontal scrolling at ${viewportName}`);
    assert.ok(layout.surface.rect.left >= -1 && layout.surface.rect.right <= layout.cssViewport[0] + 1,
      `${module.navigation} module surface must stay inside the ${viewportName} viewport`);
    assert.ok(Math.abs(navigationScroll.windowY) <= 1
      && Math.abs(navigationScroll.workspaceTop) <= 1
      && Math.abs(navigationScroll.workspaceLeft) <= 1,
    `${module.navigation} navigation must reset document and workspace scroll at ${viewportName}`);
    assert.ok(navigationScroll.headingTop >= 0 && navigationScroll.headingTop < navigationScroll.viewportHeight,
      `${module.navigation} heading must begin inside the first viewport at ${viewportName}`);
    results[module.key] = {
      navigation: module.navigation,
      ...layout,
      navigationScroll,
      evidence: await captureEvidence(win, `${module.key}-${viewportName}`),
    };
  }
  return results;
}

async function getGlobalRecoveryLayout(win, viewportName) {
  await waitFor(win,
    "Boolean(document.querySelector('.topbar-refresh-local')?.offsetParent)",
    `${viewportName} global recovery controls`);
  const state = await win.webContents.executeJavaScript(`(() => {
    const container = document.querySelector('.topbar-global-recovery');
    const selectors = ['.topbar-refresh-local'];
    const buttons = selectors.map((selector) => {
      const button = document.querySelector(selector);
      const box = button?.getBoundingClientRect();
      const center = box ? { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) } : null;
      const hit = center ? document.elementFromPoint(center.x, center.y)?.closest('button') : null;
      return {
        selector,
        text: (button?.textContent || '').trim(),
        disabled: Boolean(button?.disabled),
        visible: Boolean(button?.offsetParent),
        rect: box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null,
        hitTarget: hit === button,
      };
    });
    const containerBox = container?.getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight],
      buttons,
      container: container ? {
        clientWidth: container.clientWidth,
        scrollWidth: container.scrollWidth,
        overflow: container.scrollWidth - container.clientWidth,
        overflowX: getComputedStyle(container).overflowX,
        rect: containerBox ? {
          left: containerBox.left,
          right: containerBox.right,
          top: containerBox.top,
          bottom: containerBox.bottom,
        } : null,
      } : null,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  assert.deepEqual(state.buttons.map((button) => button.text), [
    '刷新本地数据',
  ], `${viewportName} must expose refresh as the only global recovery action`);
  assert.ok(state.buttons.every((button) => button.visible && !button.disabled && button.hitTarget),
    `${viewportName} global recovery controls must be visible, enabled, and unobstructed`);
  assert.ok(state.buttons.every((button) => button.rect
    && button.rect.left >= -1 && button.rect.right <= state.viewport[0] + 1
    && button.rect.top >= -1 && button.rect.bottom <= state.viewport[1] + 1),
  `${viewportName} global recovery controls must stay inside the viewport`);
  assert.ok(state.container && state.container.overflow <= 1,
    `${viewportName} global recovery controls must wrap without horizontal scrolling`);
  assert.ok(state.documentOverflow <= 1,
    `${viewportName} global recovery controls must not create document overflow`);
  return state;
}

async function verifyGlobalRecoverySurface() {
  const preload = path.join(ROOT, "tests/check-ui-visual-runtime-preload.js");
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload,
    },
  });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event && (event.level === 'error' || Number(event.level) >= 3)) errors.push(event.message);
  });
  try {
    await win.loadFile(path.join(distRoot, 'index.html'));
    await waitFor(win,
      "document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent.includes('合成岗位')",
      'synthetic recovery job context');
    const desktop = await getGlobalRecoveryLayout(win, '1100x720');
    const desktopEvidence = await captureEvidence(win, 'topbar-global-recovery-1100x720');

    await clickExactText(win, '.topbar-refresh-local', '刷新本地数据');
    await waitFor(win,
      "[...document.querySelectorAll('.ant-message-notice-content')].some((notice) => (notice.textContent || '').includes('本地数据已刷新'))",
      'global refresh button activation');

    win.setContentSize(1360, 768);
    win.webContents.setZoomFactor(1.25);
    await delay(180);
    const windows125 = await getGlobalRecoveryLayout(win, '1360x768@125%');
    assert.ok(Math.abs(windows125.viewport[0] - 1088) <= 1
      && Math.abs(windows125.viewport[1] - 614) <= 1,
    'Windows 125% recovery sample must retain the expected CSS viewport');
    const windows125Evidence = await captureEvidence(win, 'topbar-global-recovery-1360x768-windows125');
    assert.deepEqual(errors, [], 'global recovery renderer must not emit console errors');
    return {
      '1100x720': { ...desktop, evidence: desktopEvidence },
      '1360x768@125%': { ...windows125, evidence: windows125Evidence },
    };
  } finally {
    win.destroy();
  }
}

async function getResumeModalLayout(win) {
  return win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#resume-candidate-name');
    const dialog = input?.closest('[role=dialog]');
    const content = input?.closest('.ant-modal-content');
    const body = content?.querySelector('.ant-modal-body');
    const footer = content?.querySelector('.ant-modal-footer');
    const fields = content?.querySelector('.resume-intake-fields');
    const preview = content?.querySelector('.resume-intake-preview');
    const rect = (element) => {
      const box = element?.getBoundingClientRect();
      return box ? { top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height) } : null;
    };
    const footerButtons = [...(footer?.querySelectorAll('button') || [])];
    return {
      viewport: [innerWidth, innerHeight],
      dialogVisible: Boolean(dialog?.offsetParent),
      content: rect(content),
      body: rect(body),
      footer: rect(footer),
      footerButtonBottom: Math.round(Math.max(0, ...footerButtons.map((button) => button.getBoundingClientRect().bottom))),
      bodyClientHeight: body?.clientHeight || 0,
      bodyScrollHeight: body?.scrollHeight || 0,
      bodyOverflowY: body ? getComputedStyle(body).overflowY : '',
      gridColumnCount: fields ? getComputedStyle(fields).gridTemplateColumns.split(' ').filter(Boolean).length : 0,
      previewMaxHeight: preview ? getComputedStyle(preview).maxHeight : '',
    };
  })()`);
}

async function inspectCandidateAuthorityWriteGate(win, { blocked, attemptWrites = false }) {
  const controls = await win.webContents.executeJavaScript(`(() => {
    const upload = [...document.querySelectorAll('.candidate-sider-toolbar button')]
      .find((button) => (button.textContent || '').trim() === '上传简历建档');
    const menuTrigger = document.querySelector('.candidate-module-actions button');
    if (${JSON.stringify(attemptWrites)}) upload?.click();
    return {
      uploadPresent: Boolean(upload),
      uploadDisabled: Boolean(upload?.disabled),
      menuTriggerPresent: Boolean(menuTrigger),
      menuTriggerDisabled: Boolean(menuTrigger?.disabled),
    };
  })()`);
  assert.equal(controls.uploadPresent, true, 'candidate resume intake entry must remain visible');
  assert.equal(controls.uploadDisabled, blocked,
    `candidate resume intake must be ${blocked ? 'locked' : 'available'} for the current authority state`);
  assert.equal(controls.menuTriggerPresent, true, 'candidate operation menu must remain reachable for safe reads');
  assert.equal(controls.menuTriggerDisabled, false, 'candidate operation menu trigger must not lock pure read actions');

  await clickExactText(win, '.candidate-module-actions button', '候选人操作');
  await waitFor(win,
    "[...document.querySelectorAll('.ant-dropdown-menu')].some((menu) => menu.offsetParent !== null && (menu.textContent || '').includes('导入 Boss App 截图'))",
    'candidate authority action menu');
  const menuState = await win.webContents.executeJavaScript(`(() => {
    const writeLabels = ['导入 Boss App 截图', '校对 OCR 草稿', '批量规则评级'];
    const menu = [...document.querySelectorAll('.ant-dropdown-menu')]
      .find((element) => element.offsetParent !== null
        && (element.textContent || '').includes('导入 Boss App 截图'));
    const items = [...(menu?.querySelectorAll('.ant-dropdown-menu-item') || [])];
    const writeItems = writeLabels.map((label) => {
      const item = items.find((entry) => (entry.textContent || '').trim() === label);
      return {
        label,
        present: Boolean(item),
        disabled: item?.getAttribute('aria-disabled') === 'true'
          || item?.classList.contains('ant-dropdown-menu-item-disabled'),
      };
    });
    if (${JSON.stringify(attemptWrites)}) {
      writeItems.forEach(({ label }) => {
        items.find((entry) => (entry.textContent || '').trim() === label)?.click();
      });
    }
    return { writeItems };
  })()`);
  assert.ok(menuState.writeItems.every((item) => item.present),
    'candidate write items must remain explicit in the operation menu');
  assert.ok(menuState.writeItems.every((item) => item.disabled === blocked),
    `candidate menu writes must be ${blocked ? 'locked' : 'available'} for the current authority state`);
  await delay(100);
  const runtime = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
  const reviewModalVisible = await win.webContents.executeJavaScript(
    "Boolean(document.querySelector('.screenshot-ocr-review-modal')?.offsetParent)",
  );
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(win,
    "![...document.querySelectorAll('.ant-dropdown-menu')].some((menu) => menu.offsetParent !== null && (menu.textContent || '').includes('导入 Boss App 截图'))",
    'candidate authority action menu close');
  return { ...controls, ...menuState, reviewModalVisible, runtime };
}

async function verifyLoadingAndErrorStates() {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(ROOT, "tests/check-ui-visual-runtime-preload.js"),
      additionalArguments: ['--hrboss-runtime-scenario=loading-error'],
    },
  });
  try {
    await win.loadFile(path.join(distRoot, 'index.html'));
    await waitFor(win, "document.querySelector('.dashboard-loading-skeleton .ant-skeleton')", 'dashboard loading skeleton');
    const dashboardLoading = await win.webContents.executeJavaScript(`(() => {
      const region = document.querySelector('.dashboard-loading-skeleton');
      return {
        role: region?.getAttribute('role') || '',
        live: region?.getAttribute('aria-live') || '',
        minHeight: region ? Number.parseFloat(getComputedStyle(region).minHeight) : 0,
        skeletonCount: region?.querySelectorAll('.ant-skeleton').length || 0,
      };
    })()`);
    assert.equal(dashboardLoading.role, 'status');
    assert.equal(dashboardLoading.live, 'polite');
    assert.ok(dashboardLoading.minHeight >= 260 && dashboardLoading.skeletonCount >= 3,
      'dashboard first load must preserve stable skeleton geometry');
    const dashboardEvidence = await captureEvidence(win, 'dashboard-loading-1100x720');

    await waitFor(win,
      "document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent.includes('合成岗位')",
      'synthetic job before candidate load state');
    await clickExactText(win, 'button.nav-item', '候选人');
    await waitFor(win, "document.querySelector('.candidate-list-skeleton .ant-skeleton')", 'candidate loading skeleton');
    const candidateLoading = await win.webContents.executeJavaScript(`(() => {
      const region = document.querySelector('.candidate-list-skeleton');
      const scroll = document.querySelector('.candidate-scroll');
      return {
        role: region?.getAttribute('role') || '',
        live: region?.getAttribute('aria-live') || '',
        busy: scroll?.getAttribute('aria-busy') || '',
        skeletonCount: region?.querySelectorAll('.ant-skeleton').length || 0,
        loadingCopy: (region?.textContent || '').trim(),
      };
    })()`);
    assert.deepEqual({ role: candidateLoading.role, live: candidateLoading.live, busy: candidateLoading.busy },
      { role: 'status', live: 'polite', busy: 'true' });
    assert.ok(candidateLoading.skeletonCount >= 4 && candidateLoading.loadingCopy.includes('不会把当前岗位判断为没有候选人'),
      'candidate first load must disclose that loading is not an empty result');
    const candidateLoadingGate = await inspectCandidateAuthorityWriteGate(win, { blocked: true, attemptWrites: true });
    assert.equal(candidateLoadingGate.reviewModalVisible, false,
      'candidate OCR review must not open while candidate authority is loading');
    assert.equal(candidateLoadingGate.runtime.resumeDraftSelectionCalls, 0,
      'candidate resume picker must not run while candidate authority is loading');
    assert.equal(candidateLoadingGate.runtime.screenshotDirectorySelectionCalls, 0,
      'candidate screenshot picker must not run while candidate authority is loading');
    assert.deepEqual(candidateLoadingGate.runtime.candidateAuthorityWriteCalls,
      { resumeCommit: 0, screenshotImport: 0, screenshotOcr: 0, rate: 0 },
      'candidate authority loading must produce zero candidate business writes');
    const candidateLoadingEvidence = await captureEvidence(win, 'candidate-loading-1100x720');

    await waitFor(win, "document.querySelector('.candidate-empty-title')?.textContent.includes('候选人读取失败')",
      'candidate error state', 5000);
    const candidateError = await win.webContents.executeJavaScript(`(() => ({
      title: document.querySelector('.candidate-empty-title')?.textContent.trim() || '',
      description: document.querySelector('.candidate-empty-desc')?.textContent.trim() || '',
      retryEnabled: !document.querySelector('.candidate-empty-actions button')?.disabled,
      claimsEmpty: (document.querySelector('.candidate-scroll')?.textContent || '').includes('暂无候选人'),
    }))()`);
    assert.equal(candidateError.title, '候选人读取失败');
    assert.equal(candidateError.retryEnabled, true);
    assert.equal(candidateError.claimsEmpty, false,
      'candidate read failures must not be rendered as an empty dataset');
    const candidateErrorGate = await inspectCandidateAuthorityWriteGate(win, { blocked: true, attemptWrites: true });
    assert.equal(candidateErrorGate.reviewModalVisible, false,
      'candidate OCR review must not open while candidate authority is failed');
    assert.equal(candidateErrorGate.runtime.resumeDraftSelectionCalls, 0,
      'candidate resume picker must not run while candidate authority is failed');
    assert.equal(candidateErrorGate.runtime.screenshotDirectorySelectionCalls, 0,
      'candidate screenshot picker must not run while candidate authority is failed');
    assert.deepEqual(candidateErrorGate.runtime.candidateAuthorityWriteCalls,
      { resumeCommit: 0, screenshotImport: 0, screenshotOcr: 0, rate: 0 },
      'candidate authority error must produce zero candidate business writes');
    const candidateErrorEvidence = await captureEvidence(win, 'candidate-error-1100x720');

    await clickExactText(win, '.candidate-empty-actions button', '重新读取');
    await waitFor(win, "Boolean(document.querySelector('.candidate-card'))", 'candidate authority recovery');
    const candidateRecoveredGate = await inspectCandidateAuthorityWriteGate(win, { blocked: false });
    assert.equal(candidateRecoveredGate.runtime.candidateListReads, 2,
      'candidate recovery must retry the failed authority read exactly once');
    await win.webContents.executeJavaScript("document.querySelector('.candidate-card')?.click()");
    await waitFor(win,
      "document.querySelector('.candidate-v2-detail')?.getAttribute('data-read-only') === 'false'",
      'candidate recovered detail writes');

    await clickExactText(win, '.topbar-refresh-local', '刷新本地数据');
    await waitFor(win,
      "[...document.querySelectorAll('.candidate-sider-toolbar button')].some((button) => (button.textContent || '').trim() === '上传简历建档' && button.disabled)",
      'candidate refreshing write lock');
    await waitFor(win,
      "[...document.querySelectorAll('.candidate-list .ant-alert')].some((alert) => (alert.textContent || '').includes('刷新失败，当前展示上次成功数据'))",
      'candidate stale state');
    const candidateStaleGate = await inspectCandidateAuthorityWriteGate(win, { blocked: true, attemptWrites: true });
    assert.equal(candidateStaleGate.reviewModalVisible, false,
      'candidate OCR review must not open while candidate authority is stale');
    assert.equal(candidateStaleGate.runtime.resumeDraftSelectionCalls, 0,
      'candidate resume picker must not run while candidate authority is stale');
    assert.equal(candidateStaleGate.runtime.screenshotDirectorySelectionCalls, 0,
      'candidate screenshot picker must not run while candidate authority is stale');
    assert.deepEqual(candidateStaleGate.runtime.candidateAuthorityWriteCalls,
      { resumeCommit: 0, screenshotImport: 0, screenshotOcr: 0, rate: 0 },
      'candidate authority stale state must produce zero candidate business writes');
    const staleDetailReadOnly = await win.webContents.executeJavaScript(
      "document.querySelector('.candidate-v2-detail')?.getAttribute('data-read-only') === 'true'",
    );
    assert.equal(staleDetailReadOnly, true,
      'candidate stale state must retain the readable detail while locking its writes');
    const candidateStaleEvidence = await captureEvidence(win, 'candidate-stale-1100x720');

    await clickExactText(win, '.candidate-list .ant-alert button', '重试');
    await waitFor(win,
      "[...document.querySelectorAll('.candidate-sider-toolbar button')].some((button) => (button.textContent || '').trim() === '上传简历建档' && !button.disabled)",
      'candidate stale recovery write unlock');
    await waitFor(win,
      "document.querySelector('.candidate-v2-detail')?.getAttribute('data-read-only') === 'false'",
      'candidate stale recovery detail writes');
    const candidateFinalRecoveryGate = await inspectCandidateAuthorityWriteGate(win, { blocked: false });
    assert.equal(candidateFinalRecoveryGate.runtime.candidateListReads, 4,
      'candidate error and stale recovery must each perform one authority retry');
    assert.deepEqual(candidateFinalRecoveryGate.runtime.candidateAuthorityWriteCalls,
      { resumeCommit: 0, screenshotImport: 0, screenshotOcr: 0, rate: 0 },
      'candidate authority recovery checks must not fabricate candidate writes');
    const candidateRecoveredEvidence = await captureEvidence(win, 'candidate-recovered-1100x720');
    const gateSummary = (gate) => ({
      uploadDisabled: gate.uploadDisabled,
      menuTriggerDisabled: gate.menuTriggerDisabled,
      writeItems: gate.writeItems,
      reviewModalVisible: gate.reviewModalVisible,
      calls: {
        candidateListReads: gate.runtime.candidateListReads,
        resumeDraftSelectionCalls: gate.runtime.resumeDraftSelectionCalls,
        screenshotDirectorySelectionCalls: gate.runtime.screenshotDirectorySelectionCalls,
        candidateAuthorityWriteCalls: gate.runtime.candidateAuthorityWriteCalls,
      },
    });
    return {
      dashboard_loading: dashboardLoading,
      candidate_loading: { ...candidateLoading, gate: gateSummary(candidateLoadingGate) },
      candidate_error: { ...candidateError, gate: gateSummary(candidateErrorGate) },
      candidate_recovered: gateSummary(candidateRecoveredGate),
      candidate_stale: { ...gateSummary(candidateStaleGate), detailReadOnly: staleDetailReadOnly },
      candidate_final_recovery: gateSummary(candidateFinalRecoveryGate),
      evidence: {
        dashboard_loading_1100x720: dashboardEvidence,
        candidate_loading_1100x720: candidateLoadingEvidence,
        candidate_error_1100x720: candidateErrorEvidence,
        candidate_stale_1100x720: candidateStaleEvidence,
        candidate_recovered_1100x720: candidateRecoveredEvidence,
      },
    };
  } finally {
    win.destroy();
  }
}

async function captureModuleStateBoundary(win, selector, name) {
  win.setContentSize(1360, 768);
  win.webContents.setZoomFactor(1.25);
  await delay(180);
  const layout = await win.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    const box = target?.getBoundingClientRect();
    const documentElement = document.documentElement;
    return {
      viewport: [innerWidth, innerHeight],
      rect: box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null,
      documentOverflow: documentElement.scrollWidth - documentElement.clientWidth,
    };
  })()`);
  assert.deepEqual(layout.viewport, [1088, 614], `${name} must use the Windows 125% equivalent CSS viewport`);
  assert.ok(layout.rect, `${name} must remain visible at Windows 125% equivalent`);
  assert.ok(layout.rect.left >= 0 && layout.rect.right <= layout.viewport[0], `${name} must stay inside the horizontal viewport`);
  assert.ok(layout.rect.top >= 0 && layout.rect.top < layout.viewport[1], `${name} must begin inside the vertical viewport`);
  assert.ok(layout.documentOverflow <= 1, `${name} must not create document-level horizontal overflow`);
  const evidence = await captureEvidence(win, `${name}-1360x768-windows125`);
  win.webContents.setZoomFactor(1);
  win.setContentSize(1100, 720);
  await delay(160);
  return { ...layout, evidence };
}

async function capturePopulatedTalentLayout(win, name) {
  await delay(180);
  const layout = await win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.talent-pool-list-panel');
    const panelRect = panel?.getBoundingClientRect();
    const visible = (element) => Boolean(element && element.offsetParent);
    const sampled = [
      document.querySelector('.talent-pool-panel-head'),
      document.querySelector('.talent-pool-list-tools'),
      ...document.querySelectorAll('.talent-pool-row'),
    ].filter(visible);
    const childRects = sampled.map((element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right };
    });
    return {
      viewport: [innerWidth, innerHeight],
      panel: panel ? {
        clientWidth: panel.clientWidth,
        scrollWidth: panel.scrollWidth,
        scrollLeft: panel.scrollLeft,
        overflowX: getComputedStyle(panel).overflowX,
      } : null,
      childrenContained: Boolean(panelRect) && childRects.every((rect) =>
        rect.left >= panelRect.left - 1 && rect.right <= panelRect.right + 1),
      segmentedVisible: visible(document.querySelector('.talent-pool-group-segmented')),
      selectVisible: visible(document.querySelector('.talent-pool-group-select')),
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  assert.ok(layout.panel, `${name} must expose the populated talent list panel`);
  assert.equal(layout.panel.overflowX, 'hidden', `${name} talent list must suppress horizontal scrolling`);
  assert.ok(layout.panel.scrollWidth <= layout.panel.clientWidth + 1,
    `${name} talent list contents must fit the master pane`);
  assert.ok(Math.abs(layout.panel.scrollLeft) <= 1, `${name} talent list must remain at its left edge`);
  assert.equal(layout.childrenContained, true, `${name} talent controls and rows must remain inside the master pane`);
  assert.equal(Number(layout.segmentedVisible) + Number(layout.selectVisible), 1,
    `${name} must expose exactly one responsive recommendation filter`);
  assert.ok(layout.documentOverflow <= 1, `${name} must not create document-level horizontal overflow`);
  const evidence = await captureEvidence(win, name);
  return { ...layout, evidence };
}

async function verifyModuleStateFailures() {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(ROOT, "tests/check-ui-visual-runtime-preload.js"),
      additionalArguments: ['--hrboss-runtime-scenario=module-states'],
    },
  });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event && (event.level === 'error' || Number(event.level) >= 3)) errors.push(event.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(`renderer gone: ${JSON.stringify(details)}`));
  try {
    await win.loadFile(path.join(distRoot, 'index.html'));
    await waitFor(win, "document.querySelector('button.nav-item')", 'module-state navigation');

    await clickExactText(win, 'button.nav-item', '职位管理');
    await waitFor(win, "document.querySelector('.job-ledger-authority-loading .ant-skeleton')", 'job ledger authority loading');
    const jobsLoading = await win.webContents.executeJavaScript(`(() => {
      const region = document.querySelector('.job-ledger-authority-loading');
      const buttons = [...document.querySelectorAll('.job-ledger-hero button')];
      return {
        role: region?.getAttribute('role') || '',
        live: region?.getAttribute('aria-live') || '',
        skeletonCount: region?.querySelectorAll('.ant-skeleton').length || 0,
        tableVisible: Boolean(document.querySelector('.job-ledger-table-card')),
        claimsEmpty: (document.querySelector('.job-ledger-page')?.textContent || '').includes('还没有岗位'),
        createControls: buttons.map((button) => ({ text: button.textContent.trim(), disabled: button.disabled })),
      };
    })()`);
    assert.deepEqual({ role: jobsLoading.role, live: jobsLoading.live }, { role: 'status', live: 'polite' });
    assert.ok(jobsLoading.skeletonCount >= 1, 'job authority load must expose stable skeleton geometry');
    assert.equal(jobsLoading.tableVisible, false, 'unknown jobs must not render a data table');
    assert.equal(jobsLoading.claimsEmpty, false, 'job authority loading must not claim an empty ledger');
    assert.deepEqual(jobsLoading.createControls, [
      { text: '空白新建', disabled: true },
      { text: '从预置岗位开始', disabled: true },
    ], 'job creation controls must remain locked while authority is loading');
    const jobsLoadingEvidence = await captureEvidence(win, 'jobs-loading-1100x720');

    await waitFor(win, "document.querySelector('.job-ledger-authority-error')", 'job ledger authority error');
    const jobsError = await win.webContents.executeJavaScript(`(async () => {
      const alert = document.querySelector('.job-ledger-authority-error');
      const retry = [...(alert?.querySelectorAll('button') || [])]
        .find((button) => button.textContent.trim() === '重新读取岗位台账');
      const runtime = await window.runtimeInfo.get();
      return {
        role: alert?.getAttribute('role') || '',
        text: alert?.textContent.trim() || '',
        retryEnabled: Boolean(retry && !retry.disabled),
        tableVisible: Boolean(document.querySelector('.job-ledger-table-card')),
        claimsEmpty: (document.querySelector('.job-ledger-page')?.textContent || '').includes('还没有岗位'),
        createControlsDisabled: [...document.querySelectorAll('.job-ledger-hero button')].every((button) => button.disabled),
        actionWriteCalls: runtime.actionWriteCalls,
        endpointReads: runtime.moduleStateJobReads,
      };
    })()`);
    assert.equal(jobsError.role, 'alert');
    assert.match(jobsError.text, /岗位台账读取失败/);
    assert.match(jobsError.text, /错误不会被当作空台账/);
    assert.equal(jobsError.retryEnabled, true);
    assert.equal(jobsError.tableVisible, false);
    assert.equal(jobsError.claimsEmpty, false, 'job read failure must not render the true-empty ledger copy');
    assert.equal(jobsError.createControlsDisabled, true, 'job writes must remain locked after authority failure');
    assert.equal(jobsError.actionWriteCalls, 0, 'job error rendering must perform zero action writes');
    assert.equal(jobsError.endpointReads, 4, 'job boot must exhaust only the existing bounded retry policy');
    const jobsErrorEvidence = await captureEvidence(win, 'jobs-error-1100x720');
    const jobsWindows125 = await captureModuleStateBoundary(win, '.job-ledger-authority-error', 'jobs-error');

    await clickExactText(win, '.job-ledger-authority-error button', '重新读取岗位台账');
    await waitFor(win, "document.querySelector('.job-ledger-table-card') && !document.querySelector('.job-ledger-authority-error')", 'job ledger retry recovery');
    await waitFor(win,
      "document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent.includes('合成岗位')",
      'job context after authority recovery');
    const jobsRecovered = await win.webContents.executeJavaScript(`(async () => {
      const runtime = await window.runtimeInfo.get();
      return {
        rows: document.querySelectorAll('.job-ledger-table-card tbody tr.ant-table-row').length,
        creationEnabled: [...document.querySelectorAll('.job-ledger-hero button')].every((button) => !button.disabled),
        endpointReads: runtime.moduleStateJobReads,
        actionWriteCalls: runtime.actionWriteCalls,
      };
    })()`);
    assert.deepEqual(jobsRecovered, { rows: 1, creationEnabled: true, endpointReads: 5, actionWriteCalls: 0 },
      'job retry must restore the authoritative ledger without replaying a write');

    await clickExactText(win, 'button.nav-item', '面试安排');
    await waitFor(win,
      "[...document.querySelectorAll('.interview-schedule-canonical .ant-alert')].some((alert) => alert.textContent.includes('正式面试权威数据读取失败'))",
      'canonical interview authority error');
    await clickExactText(
      win,
      '.interview-schedule-canonical .ant-collapse-header',
      '新建面试',
    );
    await waitFor(win,
      "[...document.querySelectorAll('.interview-schedule-canonical button')].some((button) => button.textContent.trim() === '创建首轮面试')",
      'locked interview creation control');
    const interviewError = await win.webContents.executeJavaScript(`(async () => {
      const alert = [...document.querySelectorAll('.interview-schedule-canonical .ant-alert')]
        .find((item) => item.textContent.includes('正式面试权威数据读取失败'));
      const buttons = [...document.querySelectorAll('.interview-schedule-canonical button')];
      const byText = (text) => buttons.find((button) => button.textContent.trim() === text);
      const runtime = await window.runtimeInfo.get();
      return {
        role: alert?.getAttribute('role') || '',
        text: alert?.textContent.trim() || '',
        retryEnabled: !byText('重新读取正式面试')?.disabled,
        cachedSessionCount: document.querySelectorAll('.interview-schedule-canonical [data-session-id]').length,
        emptyCount: document.querySelectorAll('.interview-schedule-canonical .ant-empty').length,
        createDisabled: byText('创建首轮面试')?.disabled === true,
        scheduleDisabled: byText('人工确认排期')?.disabled === true,
        actionWriteCalls: runtime.actionWriteCalls,
        endpointReads: runtime.moduleStateInterviewSessionReads,
      };
    })()`);
    assert.equal(interviewError.role, 'alert');
    assert.match(interviewError.text, /相关写操作已暂停/);
    assert.equal(interviewError.retryEnabled, true);
    assert.equal(interviewError.cachedSessionCount, 1, 'interview authority failure must retain the explicit cached session for viewing');
    assert.equal(interviewError.emptyCount, 0, 'interview authority failure must not render an empty-session state');
    assert.equal(interviewError.createDisabled, true, 'interview creation must remain locked while authority is unknown');
    assert.equal(interviewError.scheduleDisabled, true, 'interview scheduling must remain locked while authority is unknown');
    assert.equal(interviewError.actionWriteCalls, 0, 'interview error rendering must perform zero action writes');
    assert.equal(interviewError.endpointReads, 1);
    const interviewErrorEvidence = await captureEvidence(win, 'interviews-error-1100x720');
    const interviewWindows125 = await captureModuleStateBoundary(
      win,
      '.interview-schedule-canonical > .ant-alert-error',
      'interviews-error',
    );

    await clickExactText(win, '.interview-schedule-canonical button', '重新读取正式面试');
    await waitFor(win,
      "![...document.querySelectorAll('.interview-schedule-canonical .ant-alert')].some((alert) => alert.textContent.includes('正式面试权威数据读取失败'))",
      'canonical interview retry recovery');
    const interviewRecovered = await win.webContents.executeJavaScript(`(async () => {
      const schedule = [...document.querySelectorAll('.interview-schedule-canonical button')]
        .find((button) => button.textContent.trim() === '人工确认排期');
      const runtime = await window.runtimeInfo.get();
      return {
        scheduleEnabled: Boolean(schedule && !schedule.disabled),
        endpointReads: runtime.moduleStateInterviewSessionReads,
        actionWriteCalls: runtime.actionWriteCalls,
      };
    })()`);
    assert.deepEqual(interviewRecovered, { scheduleEnabled: true, endpointReads: 2, actionWriteCalls: 0 },
      'interview retry must restore authority without performing a write');

    await clickExactText(win, 'button.nav-item', '人才库');
    await waitFor(win, "document.querySelector('.talent-pool-load-error')", 'talent pool initial error');
    const talentError = await win.webContents.executeJavaScript(`(async () => {
      const alert = document.querySelector('.talent-pool-load-error');
      const retry = [...(alert?.querySelectorAll('button') || [])]
        .find((button) => button.textContent.trim() === '重新读取人才库');
      const runtime = await window.runtimeInfo.get();
      return {
        role: alert?.getAttribute('role') || '',
        live: alert?.getAttribute('aria-live') || '',
        text: alert?.textContent.trim() || '',
        retryEnabled: Boolean(retry && !retry.disabled),
        unifiedEmptyVisible: Boolean(document.querySelector('.talent-pool-empty-state')),
        workspaceVisible: Boolean(document.querySelector('.talent-pool-workspace')),
        emptyCount: document.querySelectorAll('.talent-pool-page .ant-empty').length,
        actionWriteCalls: runtime.actionWriteCalls,
        endpointReads: runtime.moduleStateTalentPoolReads,
      };
    })()`);
    assert.equal(talentError.role, 'alert');
    assert.equal(talentError.live, 'assertive');
    assert.match(talentError.text, /人才库读取失败/);
    assert.match(talentError.text, /错误不会被当作空人才库/);
    assert.equal(talentError.retryEnabled, true);
    assert.equal(talentError.unifiedEmptyVisible, false);
    assert.equal(talentError.workspaceVisible, false);
    assert.equal(talentError.emptyCount, 0, 'talent read failure must not render any true-empty illustration');
    assert.equal(talentError.actionWriteCalls, 0, 'talent error rendering must perform zero action writes');
    assert.equal(talentError.endpointReads, 1);
    const talentErrorEvidence = await captureEvidence(win, 'talent-error-1100x720');
    const talentWindows125 = await captureModuleStateBoundary(win, '.talent-pool-load-error', 'talent-error');

    await clickExactText(win, '.talent-pool-load-error button', '重新读取人才库');
    await waitFor(win, "document.querySelectorAll('.talent-pool-list .talent-pool-row').length === 2",
      'populated talent pool after authority recovery');
    const talentRecovered = await win.webContents.executeJavaScript(`(async () => {
      const runtime = await window.runtimeInfo.get();
      return {
        errorVisible: Boolean(document.querySelector('.talent-pool-load-error')),
        rowCount: document.querySelectorAll('.talent-pool-list .talent-pool-row').length,
        selectedCount: document.querySelectorAll('.talent-pool-row[aria-selected="true"]').length,
        tabStopCount: document.querySelectorAll('.talent-pool-row[tabindex="0"]').length,
        detailName: document.querySelector('.talent-pool-detail-name h3')?.textContent.trim() || '',
        endpointReads: runtime.moduleStateTalentPoolReads,
        actionWriteCalls: runtime.actionWriteCalls,
      };
    })()`);
    assert.deepEqual(talentRecovered, {
      errorVisible: false,
      rowCount: 2,
      selectedCount: 1,
      tabStopCount: 1,
      detailName: '合成人才甲',
      endpointReads: 2,
      actionWriteCalls: 0,
    }, 'talent retry must restore one selectable source of truth without replaying a write');

    win.setContentSize(1440, 900);
    await delay(180);
    const talentPopulatedWide = await capturePopulatedTalentLayout(win, 'talent-populated-1440x900');
    win.setContentSize(1360, 768);
    win.webContents.setZoomFactor(1.25);
    await delay(180);
    const talentPopulatedWindows125 = await capturePopulatedTalentLayout(
      win,
      'talent-populated-1360x768-windows125',
    );
    win.webContents.setZoomFactor(1);
    win.setContentSize(1100, 720);
    await delay(180);
    const talentPopulatedCompact = await capturePopulatedTalentLayout(win, 'talent-populated-1100x720');
    const talentPopulatedLayouts = {
      wide: talentPopulatedWide,
      windows125: talentPopulatedWindows125,
      compact: talentPopulatedCompact,
    };

    await win.webContents.executeJavaScript("document.querySelector('.talent-pool-row[tabindex=\"0\"]')?.focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
    await waitFor(win,
      "document.querySelector('.talent-pool-detail-name h3')?.textContent.trim() === '合成人才乙'"
        + " && document.querySelector('.talent-pool-row[aria-selected=\"true\"] strong')?.textContent.trim() === '合成人才乙'"
        + " && document.activeElement?.querySelector('strong')?.textContent.trim() === '合成人才乙'",
      'talent ArrowDown selection and focus');
    const talentKeyboardSelection = await win.webContents.executeJavaScript(`(() => ({
      selected: document.querySelector('.talent-pool-row[aria-selected="true"] strong')?.textContent.trim() || '',
      focused: document.activeElement?.querySelector('strong')?.textContent.trim() || '',
      tabStopCount: document.querySelectorAll('.talent-pool-row[tabindex="0"]').length,
    }))()`);
    assert.deepEqual(talentKeyboardSelection, {
      selected: '合成人才乙',
      focused: '合成人才乙',
      tabStopCount: 1,
    }, 'talent ArrowDown must synchronize focus, selection and detail');

    await clickTextContaining(win, '.talent-pool-group-segmented .ant-segmented-item-label', '强推荐');
    await waitFor(win,
      "Boolean(document.querySelector('.talent-pool-list-panel .ant-alert-info'))",
      'talent filtered-selection notice');
    const talentFilteredSelection = await win.webContents.executeJavaScript(`(() => ({
      rowCount: document.querySelectorAll('.talent-pool-list .talent-pool-row').length,
      detailName: document.querySelector('.talent-pool-detail-name h3')?.textContent.trim() || '',
      notice: document.querySelector('.talent-pool-list-panel .ant-alert-info')?.textContent.trim() || '',
    }))()`);
    assert.equal(talentFilteredSelection.rowCount, 1);
    assert.equal(talentFilteredSelection.detailName, '合成人才乙',
      'filter exclusion must preserve the selected talent detail');
    assert.match(talentFilteredSelection.notice, /不会静默切换到其他人才/);
    await clickExactText(win, '.talent-pool-list-panel button', '清除筛选');
    await waitFor(win,
      "document.querySelectorAll('.talent-pool-list .talent-pool-row').length === 2 && !document.querySelector('.talent-pool-list-panel .ant-alert-info')",
      'talent filters cleared without selection drift');
    assert.equal(await win.webContents.executeJavaScript(
      "document.querySelector('.talent-pool-detail-name h3')?.textContent.trim() || ''",
    ), '合成人才乙', 'clearing talent filters must retain the explicit selection');

    await clickExactText(win, '.talent-pool-hero button', '刷新人才库');
    await waitFor(win,
      "[...document.querySelectorAll('.talent-pool-hero button')].some((button) => button.textContent.trim() === '刷新人才库' && button.classList.contains('ant-btn-loading'))",
      'talent populated refresh loading state');
    const talentRefreshLock = await win.webContents.executeJavaScript(`(async () => {
      const buttons = [...document.querySelectorAll('.talent-pool-detail button')];
      const byText = (text) => buttons.find((button) => button.textContent.trim() === text);
      const runtime = await window.runtimeInfo.get();
      return {
        addDisabled: byText('加入当前岗位')?.disabled === true,
        resetDisabled: byText('重置')?.disabled === true,
        copyDisabled: byText('复制')?.disabled === true,
        draftDisabled: document.querySelector('textarea[aria-label="人才库再触达草稿"]')?.disabled === true,
        endpointReads: runtime.moduleStateTalentPoolReads,
        actionWriteCalls: runtime.actionWriteCalls,
      };
    })()`);
    assert.deepEqual(talentRefreshLock, {
      addDisabled: true,
      resetDisabled: true,
      copyDisabled: true,
      draftDisabled: true,
      endpointReads: 3,
      actionWriteCalls: 0,
    }, 'populated talent refresh must fail closed for every write surface');
    await waitFor(win,
      "[...document.querySelectorAll('.talent-pool-hero button')].some((button) => button.textContent.trim() === '刷新人才库' && !button.classList.contains('ant-btn-loading'))",
      'talent populated refresh completion');

    await clickExactText(win, '.talent-pool-detail button', '加入当前岗位');
    await waitFor(win, "Boolean(document.querySelector('.ant-modal-confirm'))", 'talent add confirmation');
    await clickExactText(win, '.ant-modal-confirm button', '确认加入');
    await waitFor(win,
      "[...document.querySelectorAll('.ant-modal-confirm button')].some((button) => button.textContent.trim() === '取消' && button.disabled)",
      'talent add confirmation busy lock');
    let committedRefreshRuntime = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      committedRefreshRuntime = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
      if (committedRefreshRuntime.moduleStateTalentPoolReads >= 4) break;
      await delay(50);
    }
    assert.ok(committedRefreshRuntime?.moduleStateTalentPoolReads >= 4,
      'talent add must reach committed refresh before the busy-lock assertion');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await delay(100);
    const talentCommittedRefreshLock = await win.webContents.executeJavaScript(`(async () => {
      const dialog = document.querySelector('.ant-modal-confirm');
      const buttons = [...(dialog?.querySelectorAll('button') || [])];
      const byText = (text) => buttons.find((button) => button.textContent.trim() === text);
      const pageButtons = [...document.querySelectorAll('.talent-pool-detail button')];
      const add = pageButtons.find((button) => button.textContent.trim() === '加入当前岗位');
      const runtime = await window.runtimeInfo.get();
      return {
        dialogVisible: Boolean(dialog),
        cancelDisabled: byText('取消')?.disabled === true,
        okDisabled: byText('确认加入')?.disabled === true,
        addDisabled: add?.disabled === true,
        draftDisabled: document.querySelector('textarea[aria-label="人才库再触达草稿"]')?.disabled === true,
        endpointReads: runtime.moduleStateTalentPoolReads,
        actionWriteCalls: runtime.actionWriteCalls,
      };
    })()`);
    assert.deepEqual(talentCommittedRefreshLock, {
      dialogVisible: true,
      cancelDisabled: true,
      okDisabled: true,
      addDisabled: true,
      draftDisabled: true,
      endpointReads: 4,
      actionWriteCalls: 1,
    }, 'committed refresh must keep the confirmation and every talent write surface locked');
    const talentBusyEvidence = await captureEvidence(win, 'talent-committed-refresh-lock-1100x720');
    await waitFor(win, "!document.querySelector('.ant-modal-confirm')", 'talent add completion');
    await waitFor(win, "Boolean(document.querySelector('.talent-pool-stale-warning'))",
      'resolved-false workspace refresh lock');
    const talentResolvedFalseLock = await win.webContents.executeJavaScript(`(async () => {
      const alert = document.querySelector('.talent-pool-stale-warning');
      const buttons = [...document.querySelectorAll('.talent-pool-detail button')];
      const byText = (text) => buttons.find((button) => button.textContent.trim() === text);
      const runtime = await window.runtimeInfo.get();
      return {
        alertText: alert?.textContent.trim() || '',
        addDisabled: byText('加入当前岗位')?.disabled === true,
        resetDisabled: byText('重置')?.disabled === true,
        copyDisabled: byText('复制')?.disabled === true,
        draftDisabled: document.querySelector('textarea[aria-label="人才库再触达草稿"]')?.disabled === true,
        workspaceRefreshes: runtime.moduleStateTalentWorkspaceRefreshes,
        actionWriteCalls: runtime.actionWriteCalls,
      };
    })()`);
    assert.match(talentResolvedFalseLock.alertText, /岗位关系已保存，但候选人工作区刷新未完成/);
    assert.deepEqual({
      addDisabled: talentResolvedFalseLock.addDisabled,
      resetDisabled: talentResolvedFalseLock.resetDisabled,
      copyDisabled: talentResolvedFalseLock.copyDisabled,
      draftDisabled: talentResolvedFalseLock.draftDisabled,
      workspaceRefreshes: talentResolvedFalseLock.workspaceRefreshes,
      actionWriteCalls: talentResolvedFalseLock.actionWriteCalls,
    }, {
      addDisabled: true,
      resetDisabled: true,
      copyDisabled: true,
      draftDisabled: true,
      workspaceRefreshes: 1,
      actionWriteCalls: 1,
    }, 'resolved-false workspace refresh must retain the visible error and every write lock');
    const talentResolvedFalseEvidence = await captureEvidence(win, 'talent-resolved-false-lock-1100x720');
    await clickExactText(win, '.talent-pool-stale-warning button', '重新读取人才库');
    await waitFor(win,
      "!document.querySelector('.talent-pool-stale-warning') && !document.querySelector('.talent-pool-hero .ant-btn-loading')",
      'resolved-false workspace refresh recovery');
    await delay(120);
    const talentRefreshRecovery = await win.webContents.executeJavaScript(`(async () => {
      const buttons = [...document.querySelectorAll('.talent-pool-detail button')];
      const byText = (text) => buttons.find((button) => button.textContent.trim() === text);
      const runtime = await window.runtimeInfo.get();
      return {
        addEnabled: byText('加入当前岗位')?.disabled === false,
        draftEnabled: document.querySelector('textarea[aria-label="人才库再触达草稿"]')?.disabled === false,
        endpointReads: runtime.moduleStateTalentPoolReads,
        workspaceRefreshes: runtime.moduleStateTalentWorkspaceRefreshes,
        actionWriteCalls: runtime.actionWriteCalls,
      };
    })()`);
    assert.deepEqual(talentRefreshRecovery, {
      addEnabled: true,
      draftEnabled: true,
      endpointReads: 5,
      workspaceRefreshes: 2,
      actionWriteCalls: 1,
    }, 'explicit retry must restore both talent authorities without repeating the committed write');

    assert.deepEqual(errors, [], 'module-state renderer must not emit console errors');
    return {
      jobs: {
        endpoint: 'GET /jobs',
        loading: jobsLoading,
        error: jobsError,
        recovered: jobsRecovered,
        windows125: jobsWindows125,
      },
      interviews: {
        endpoint: 'GET /interview-session?jobId=9901',
        error: interviewError,
        recovered: interviewRecovered,
        windows125: interviewWindows125,
      },
      talent_pool: {
        endpoint: 'GET /talent-pool?jobId=9901',
        error: talentError,
        recovered: talentRecovered,
        populated_layouts: talentPopulatedLayouts,
        keyboard_selection: talentKeyboardSelection,
        filtered_selection: talentFilteredSelection,
        refresh_lock: talentRefreshLock,
        committed_refresh_lock: talentCommittedRefreshLock,
        resolved_false_lock: talentResolvedFalseLock,
        refresh_recovery: talentRefreshRecovery,
        windows125: talentWindows125,
      },
      evidence: {
        jobs_loading_1100x720: jobsLoadingEvidence,
        jobs_error_1100x720: jobsErrorEvidence,
        interviews_error_1100x720: interviewErrorEvidence,
        talent_error_1100x720: talentErrorEvidence,
        talent_committed_refresh_lock_1100x720: talentBusyEvidence,
        talent_resolved_false_lock_1100x720: talentResolvedFalseEvidence,
      },
    };
  } finally {
    win.destroy();
  }
}

async function inspectCandidateRecordingControls(win) {
  return win.webContents.executeJavaScript(`(() => {
    const controls = document.querySelector('.candidate-interview-controls');
    const isVisible = (element) => Boolean(element?.getClientRects().length
      && getComputedStyle(element).visibility !== 'hidden');
    const visibleButtons = [...(controls?.querySelectorAll('button') || [])].filter(isVisible);
    const actionArea = controls?.querySelector('.candidate-interview-actions');
    const fieldLabels = [...(controls?.querySelectorAll(':scope > label') || [])].filter(isVisible);
    const toRect = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        width: rect.width, height: rect.height };
    };
    const controlsRect = toRect(controls);
    const actionRect = toRect(actionArea);
    const fieldRects = fieldLabels.map(toRect).filter(Boolean);
    const buttonRects = visibleButtons.map(toRect).filter(Boolean);
    const primaryAction = visibleButtons.find((button) => /开始录音|停止并转写/.test((button.textContent || '').trim()));
    const primaryActionRect = toRect(primaryAction);
    const fieldSpan = fieldRects.length ? {
      left: Math.min(...fieldRects.map((rect) => rect.left)),
      right: Math.max(...fieldRects.map((rect) => rect.right)),
    } : null;
    const fieldsShareRow = fieldRects.length >= 2
      && Math.min(fieldRects[0].bottom, fieldRects[1].bottom) - Math.max(fieldRects[0].top, fieldRects[1].top)
        >= Math.min(fieldRects[0].height, fieldRects[1].height) / 2;
    const actionSharesFieldRow = Boolean(actionRect && fieldRects.some((rect) => {
      const verticalOverlap = Math.min(actionRect.bottom, rect.bottom) - Math.max(actionRect.top, rect.top);
      return verticalOverlap >= Math.min(actionRect.height, rect.height) / 2;
    }));
    const buttonsShareRow = buttonRects.some((first, index) => buttonRects.slice(index + 1).some((second) => {
      const verticalOverlap = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
      const minimumHeight = Math.min(first.height, second.height);
      return verticalOverlap >= minimumHeight / 2
        && (first.right <= second.left || second.right <= first.left);
    }));
    const taskTags = [...(document.querySelectorAll('.candidate-interview-launcher .ant-tag') || [])]
      .filter(isVisible)
      .map((element) => (element.textContent || '').trim());
    return {
      taskTags,
      runningProgressVisible: Boolean(document.querySelector('.candidate-interview-launcher .recording-duration-bar progress')?.getClientRects().length),
      visibleButtonLabels: visibleButtons.map((button) => (button.textContent || '').trim()),
      disabledButtonLabels: visibleButtons.filter((button) => button.disabled)
        .map((button) => (button.textContent || '').trim()),
      controlsPresent: Boolean(controlsRect),
      actionAreaPresent: Boolean(actionRect),
      ownedActionAreaPresent: Boolean(actionArea?.classList.contains('candidate-interview-actions')),
      actionAreaInsideControls: Boolean(controlsRect && actionRect
        && actionRect.left >= controlsRect.left - 1 && actionRect.right <= controlsRect.right + 1),
      actionAreaCoversFieldSpan: Boolean(actionRect && fieldSpan
        && actionRect.left <= fieldSpan.left + 1 && actionRect.right >= fieldSpan.right - 1),
      actionSharesFieldRow,
      primaryActionInViewport: Boolean(primaryActionRect
        && primaryActionRect.top >= -1 && primaryActionRect.bottom <= innerHeight + 1),
      primaryActionRect,
      duration: (() => {
        const input = controls?.querySelector('input[name="interview-review-duration-seconds"]');
        const hint = document.querySelector('#interview-recording-duration-hint');
        return {
          present: Boolean(input),
          value: input?.value || '',
          invalid: input?.getAttribute('aria-invalid') || '',
          describedBy: input?.getAttribute('aria-describedby') || '',
          hintClass: hint?.className || '',
          hintText: (hint?.textContent || '').trim(),
        };
      })(),
      fieldsShareRow,
      buttonsShareRow,
      controlsRect,
      actionRect,
      fieldSpan,
      buttonRects,
    };
  })()`);
}

function createCandidateIdleRecordingPreload() {
  const sourcePath = path.join(ROOT, "tests/check-ui-visual-runtime-preload.js");
  let source = fs.readFileSync(sourcePath, 'utf8');
  const anchor = "  if (requestPath === '/local-interview/progress' && RUNTIME_SCENARIO === 'w3-formal') {";
  assert.ok(source.includes(anchor), 'candidate idle recording fixture anchor must remain available');
  source = source.replace(anchor, `  if (RUNTIME_SCENARIO === 'candidate-recording-idle' && requestPath === '/local-interview/doctor') {
    return ok({ doctor: { status: 'ready', ready: true, degraded: false } });
  }
  if (RUNTIME_SCENARIO === 'candidate-recording-idle' && requestPath === '/local-interview/progress') {
    return ok({ job: { status: 'idle' } });
  }
${anchor}`);
  const target = path.join(userData, 'candidate-recording-idle-preload.js');
  fs.writeFileSync(target, source, { mode: 0o600 });
  return target;
}

function createCandidateMicCheckFailPreload() {
  const sourcePath = path.join(ROOT, "tests/check-ui-visual-runtime-preload.js");
  let source = fs.readFileSync(sourcePath, 'utf8');
  const sessionAnchor = "    if (RUNTIME_SCENARIO === 'w3-formal') return ok({ sessions: W3_INTERVIEW_SESSIONS });";
  assert.ok(source.includes(sessionAnchor), 'mic-check fail fixture session anchor must remain available');
  source = source.replace(sessionAnchor, `    if (RUNTIME_SCENARIO === 'candidate-mic-check-fail') {
      const micSessionCandidateId = new URLSearchParams(requestPath.split('?')[1] || '').get('candidateId') || CANDIDATE.internal_id;
      return ok({ sessions: [{
        id: 9911,
        candidate_id: micSessionCandidateId,
        candidate_name: CANDIDATE.name,
        job_id: JOB.id,
        round: 1,
        status: 'scheduled',
        interview_format: 'offline',
        mode: 'offline',
        scheduled_at: '2026-08-03T02:00:00Z',
        duration_minutes: 45,
        interviewer_assignments: [],
        schedule_confirmations: [],
        logistics_version: 1,
        materials: [],
      }] });
    }
${sessionAnchor}`);
  const anchor = "  if (requestPath === '/local-interview/progress' && RUNTIME_SCENARIO === 'w3-formal') {";
  assert.ok(source.includes(anchor), 'mic-check fail fixture progress anchor must remain available');
  source = source.replace(anchor, `  if (RUNTIME_SCENARIO === 'candidate-mic-check-fail' && requestPath === '/local-interview/doctor') {
    return ok({ doctor: { status: 'ready', ready: true, degraded: false } });
  }
  if (RUNTIME_SCENARIO === 'candidate-mic-check-fail' && requestPath.startsWith('/interview-consent?')) {
    return ok({
      consent: { valid: true, consented_at: new Date().toISOString(), revocation_pending: false },
      policy: { max_age_hours: 24 },
    });
  }
  if (RUNTIME_SCENARIO === 'candidate-mic-check-fail' && requestPath === '/local-interview/mic-check' && method === 'POST') {
    globalThis.__hrbossMicCheckFail = {
      polls: 0,
      candidateId: input.body?.candidateId ?? CANDIDATE.internal_id,
      jobId: input.body?.jobId ?? JOB.id,
      round: input.body?.round ?? 1,
    };
    return ok({ job: {
      id: 'SYN-MIC-CHECK-FAIL',
      status: 'running',
      mode: 'mic-check',
      bind_candidate_id: globalThis.__hrbossMicCheckFail.candidateId,
      bind_job_id: globalThis.__hrbossMicCheckFail.jobId,
      bind_round: globalThis.__hrbossMicCheckFail.round,
      elapsed_seconds: 1,
      started_at: new Date().toISOString(),
    } });
  }
  if (RUNTIME_SCENARIO === 'candidate-mic-check-fail' && requestPath === '/local-interview/progress') {
    const micFailState = globalThis.__hrbossMicCheckFail;
    if (!micFailState) return ok({ job: { status: 'idle' } });
    micFailState.polls += 1;
    if (micFailState.polls < 3) {
      return ok({ job: {
        id: 'SYN-MIC-CHECK-FAIL',
        status: 'running',
        mode: 'mic-check',
        bind_candidate_id: micFailState.candidateId,
        bind_job_id: micFailState.jobId,
        bind_round: micFailState.round,
        elapsed_seconds: micFailState.polls,
        started_at: new Date().toISOString(),
      } });
    }
    return ok({ job: {
      id: 'SYN-MIC-CHECK-FAIL',
      status: 'done',
      mode: 'mic-check',
      bind_candidate_id: micFailState.candidateId,
      bind_job_id: micFailState.jobId,
      bind_round: micFailState.round,
      elapsed_seconds: 8,
      started_at: new Date(Date.now() - 8000).toISOString(),
      finished_at: new Date().toISOString(),
      message: '合成麦克风预检完成。',
      result: { micCheck: {
        level: 'fail',
        passed: false,
        message: '合成预检未通过：仅录到静音。',
        recommendation: '请检查系统输入设备后重新预检。',
      } },
    } });
  }
${anchor}`);
  const target = path.join(userData, 'candidate-mic-check-fail-preload.js');
  fs.writeFileSync(target, source, { mode: 0o600 });
  return target;
}

async function inspectW3Schedule(win) {
  return win.webContents.executeJavaScript(`(() => {
    const root = document.querySelector('[data-interview-workspace="canonical"]');
    const directCollapses = [...(root?.children || [])]
      .filter((element) => element.classList.contains('ant-collapse'));
    const sessionCollapse = directCollapses.find((element) => {
      const text = element.textContent || '';
      return text.includes('当前面试') && text.includes('历史面试');
    });
    const sessionItems = [...(sessionCollapse?.querySelectorAll(':scope > .ant-collapse-item') || [])];
    const rows = sessionItems.map((item) => {
      const header = item.querySelector(':scope > .ant-collapse-header');
      return {
        text: (header?.textContent || '').trim(),
        expanded: header?.getAttribute('aria-expanded') || '',
        rect: header ? (() => {
          const box = header.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
        })() : null,
        item,
      };
    });
    const current = rows.find((row) => row.text.includes('当前面试'));
    const histories = rows.filter((row) => row.text.includes('历史面试'));
    const secondary = [...(current?.item.querySelectorAll('.ant-collapse-header') || [])]
      .find((header) => (header.textContent || '').includes('邀请、物流与历史'));
    const localTools = directCollapses.find((element) => (element.textContent || '').includes('面试资料与录音工具'));
    const workspace = root?.closest('.workspace');
    return {
      canonical: root?.getAttribute('data-interview-workspace') || '',
      fixtureMode: root?.getAttribute('data-fixture-mode') || '',
      currentCount: rows.filter((row) => row.text.includes('当前面试')).length,
      currentExpanded: current?.expanded || '',
      currentNeedsLogisticsAttention: /当前待办：(待发送邀约|待候选人确认)/.test(current?.text || ''),
      currentVisible: Boolean(current?.rect && current.rect.top >= 0 && current.rect.bottom <= innerHeight),
      historyCount: histories.length,
      historiesCollapsed: histories.every((row) => row.expanded === 'false'),
      expandedSessionCount: rows.filter((row) => row.expanded === 'true').length,
      secondaryExpanded: secondary?.getAttribute('aria-expanded') || '',
      secondaryVisible: Boolean(secondary),
      localToolsVisible: Boolean(localTools),
      viewport: [innerWidth, innerHeight],
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      workspaceOverflow: workspace ? workspace.scrollWidth - workspace.clientWidth : null,
      rootOverflow: root ? root.scrollWidth - root.clientWidth : null,
    };
  })()`);
}

function assertW3ScheduleState(state, label, expectedFixtureMode) {
  assert.equal(state.canonical, 'canonical', `${label} must use the canonical interview workspace root`);
  assert.equal(state.fixtureMode, expectedFixtureMode, `${label} must disclose its fixture boundary`);
  assert.equal(state.currentCount, 1, `${label} must expose one current Session`);
  assert.equal(state.currentExpanded, 'true', `${label} current Session must default open`);
  assert.equal(state.currentVisible, true, `${label} current Session header must remain in the first viewport`);
  assert.ok(state.historyCount >= 1, `${label} must retain at least one historical Session`);
  assert.equal(state.historiesCollapsed, true, `${label} historical Sessions must default collapsed`);
  assert.equal(state.expandedSessionCount, 1, `${label} Session accordion must expose one expanded location`);
  assert.equal(state.secondaryVisible, true, `${label} must retain invitation, logistics and history details`);
  assert.equal(
    state.secondaryExpanded,
    state.currentNeedsLogisticsAttention ? 'true' : 'false',
    `${label} must auto-expand invitation details only for an invitation or candidate-confirmation todo`,
  );
  assert.equal(state.localToolsVisible, true, `${label} must retain local recording/import as a secondary tool`);
  assert.ok(state.documentOverflow <= 1, `${label} must not overflow the document horizontally`);
  assert.ok(state.workspaceOverflow <= 1, `${label} workspace must not overflow horizontally`);
  assert.ok(state.rootOverflow <= 1, `${label} canonical surface must not overflow horizontally`);
}

async function verifyW3ScheduleScenario(scenario, label, expectedFixtureMode) {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(ROOT, "tests/check-ui-visual-runtime-preload.js"),
      additionalArguments: [`--hrboss-runtime-scenario=${scenario}`],
    },
  });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event && (event.level === 'error' || Number(event.level) >= 3)) errors.push(event.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(`renderer gone: ${JSON.stringify(details)}`));
  try {
    await win.loadFile(path.join(distRoot, 'index.html'));
    win.webContents.setZoomFactor(1);
    await delay(80);
    await waitFor(win, "document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent.includes('合成岗位')", `${label} job context`);
    await clickExactText(win, 'button.nav-item', '面试安排');
    await waitFor(win,
      "Boolean(document.querySelector('[data-interview-workspace=\"canonical\"]') && [...document.querySelectorAll('[data-interview-workspace=\"canonical\"] .ant-collapse-header')].some((header) => (header.textContent || '').includes('当前面试')))",
      `${label} canonical Session workspace`);
    await delay(180);
    const desktop = await inspectW3Schedule(win);
    assert.ok(Math.abs(desktop.viewport[0] - 1100) <= 1 && Math.abs(desktop.viewport[1] - 688) <= 1,
      `${label} desktop sample must use the unscaled 1100px CSS viewport`);
    assertW3ScheduleState(desktop, `${label} 1100x720`, expectedFixtureMode);
    const desktopEvidence = await captureEvidence(win, `w3-schedule-${label}-1100x720`);

    const historyFocus = await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('[data-interview-workspace="canonical"]');
      const directCollapses = [...(root?.children || [])].filter((element) => element.classList.contains('ant-collapse'));
      const sessionCollapse = directCollapses.find((element) => (element.textContent || '').includes('当前面试') && (element.textContent || '').includes('历史面试'));
      const history = [...(sessionCollapse?.querySelectorAll(':scope > .ant-collapse-item > .ant-collapse-header') || [])]
        .find((header) => (header.textContent || '').includes('历史面试'));
      history?.focus();
      return {
        found: Boolean(history),
        focused: document.activeElement === history,
        role: history?.getAttribute('role') || '',
        tabIndex: history?.tabIndex ?? -1,
      };
    })()`);
    assert.deepEqual(historyFocus, { found: true, focused: true, role: 'tab', tabIndex: 0 },
      `${label} history header must be keyboard reachable`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await waitFor(win,
      "[...document.querySelectorAll('[data-interview-workspace=\"canonical\"] .ant-collapse-header')].some((header) => (header.textContent || '').includes('历史面试') && header.getAttribute('aria-expanded') === 'true')",
      `${label} history keyboard expansion`);
    const keyboardHistory = await inspectW3Schedule(win);
    assert.equal(keyboardHistory.currentExpanded, 'false', `${label} accordion must collapse current Session when history opens`);
    assert.equal(keyboardHistory.historiesCollapsed, false, `${label} keyboard activation must expand a historical Session`);
    assert.equal(keyboardHistory.expandedSessionCount, 1, `${label} accordion must retain one expanded Session after keyboard activation`);
    const keyboardHistoryEvidence = await captureEvidence(win, `w3-schedule-${label}-history-keyboard-1100x720`);
    await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('[data-interview-workspace="canonical"]');
      const current = [...root.querySelectorAll('.ant-collapse-header')]
        .find((header) => (header.textContent || '').includes('当前面试'));
      current?.focus();
    })()`);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await waitFor(win,
      "[...document.querySelectorAll('[data-interview-workspace=\"canonical\"] .ant-collapse-header')].some((header) => (header.textContent || '').includes('当前面试') && header.getAttribute('aria-expanded') === 'true')",
      `${label} current Session keyboard restore`);

    win.setContentSize(1360, 768);
    win.webContents.setZoomFactor(1.25);
    await delay(180);
    const windows125 = await inspectW3Schedule(win);
    assert.ok(Math.abs(windows125.viewport[0] - 1088) <= 1 && Math.abs(windows125.viewport[1] - 614) <= 1,
      `${label} must use the Windows 125% equivalent CSS viewport`);
    assert.ok(windows125.documentOverflow <= 1 && windows125.workspaceOverflow <= 1 && windows125.rootOverflow <= 1,
      `${label} must not overflow horizontally at Windows 125%`);
    const windows125Evidence = await captureEvidence(win, `w3-schedule-${label}-1360x768-windows125`);
    assert.deepEqual(errors, [], `${label} renderer must not emit console errors`);
    return {
      desktop: { ...desktop, evidence: desktopEvidence },
      keyboard_history: { ...keyboardHistory, focus: historyFocus, evidence: keyboardHistoryEvidence },
      windows125: { ...windows125, evidence: windows125Evidence },
    };
  } finally {
    win.destroy();
  }
}

async function verifyW3CandidateReview() {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(ROOT, "tests/check-ui-visual-runtime-preload.js"),
      additionalArguments: ['--hrboss-runtime-scenario=w3-formal'],
    },
  });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event && (event.level === 'error' || Number(event.level) >= 3)) errors.push(event.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(`renderer gone: ${JSON.stringify(details)}`));
  try {
    await win.loadFile(path.join(distRoot, 'index.html'));
    win.webContents.setZoomFactor(1);
    await delay(80);
    await waitFor(win, "document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent.includes('合成岗位')", 'W3 candidate job context');
    await clickExactText(win, 'button.nav-item', '候选人');
    await waitFor(win, "document.querySelector('.candidate-card')", 'W3 candidate list');
    const selectedSyntheticCandidate = await win.webContents.executeJavaScript(`(() => {
      const candidate = [...document.querySelectorAll('.candidate-card')]
        .find((card) => (card.getAttribute('aria-label') || '').startsWith('合成候选人 · 超长中文名称'));
      candidate?.click();
      return Boolean(candidate);
    })()`);
    assert.equal(selectedSyntheticCandidate, true, 'W3 runtime must select the candidate bound to the synthetic recording');
    await waitFor(win,
      "document.querySelector('.candidate-card[aria-selected=\"true\"]')?.getAttribute('aria-label')?.startsWith('合成候选人 · 超长中文名称')",
      'W3 recording-bound candidate selection');
    await waitFor(win, "document.querySelector('.candidate-domain-tab-option')", 'W3 candidate domain navigation');
    await clickTextContaining(win, '.candidate-domain-tab-option', '面试');
    await waitFor(win,
      "Boolean(document.querySelector('.interview-review-panel .interview-workflow-tabs') && [...document.querySelectorAll('.interview-review-records .ant-collapse-header')].some((header) => (header.textContent || '').includes('当前面试轮次')))",
      'W3 candidate interview workspace');
    await delay(180);
    const workspace = await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('.interview-review-panel');
      const primaryTabs = root?.querySelector('.interview-workflow-tabs');
      const primaryTablists = [...(primaryTabs?.querySelectorAll('[role="tablist"]') || [])]
        .filter((tablist) => Boolean(tablist.closest('.ant-tabs-nav')));
      const selectedPrimaryTabs = primaryTablists.flatMap((tablist) => [...tablist.querySelectorAll('[role="tab"][aria-selected="true"]')]);
      const sessionCollapse = document.querySelector('.interview-review-records > .ant-collapse');
      const sessionHeaders = [...(sessionCollapse?.querySelectorAll(':scope > .ant-collapse-item > .ant-collapse-header') || [])];
      const current = sessionHeaders.find((header) => (header.textContent || '').includes('当前面试轮次'));
      const histories = sessionHeaders.filter((header) => (header.textContent || '').includes('历史面试轮次'));
      const workspaceElement = root?.closest('.workspace');
      return {
        viewport: [innerWidth, innerHeight],
        tablistCount: primaryTablists.length,
        selectedTabCount: selectedPrimaryTabs.length,
        selectedTabText: (selectedPrimaryTabs[0]?.textContent || '').trim(),
        todoCount: root?.querySelectorAll('.interview-todo-strip [role="listitem"]').length || 0,
        nonActionableTodoCount: root?.querySelectorAll('.interview-todo-strip .interview-todo-item.done, .interview-todo-strip .interview-todo-item.idle').length || 0,
        completionSummary: Boolean(root?.querySelector('.interview-todo-complete')),
        todoAriaPressedCount: root?.querySelectorAll('.interview-todo-strip [aria-pressed]').length || 0,
        ariaCurrentCount: root?.querySelectorAll('[aria-current]').length || 0,
        currentExpanded: current?.getAttribute('aria-expanded') || '',
        historiesCollapsed: histories.length > 0 && histories.every((header) => header.getAttribute('aria-expanded') === 'false'),
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        workspaceOverflow: workspaceElement ? workspaceElement.scrollWidth - workspaceElement.clientWidth : null,
        rootOverflow: root ? root.scrollWidth - root.clientWidth : null,
      };
    })()`);
    assert.ok(Math.abs(workspace.viewport[0] - 1100) <= 1 && Math.abs(workspace.viewport[1] - 688) <= 1,
      'candidate interview desktop sample must use the unscaled 1100px CSS viewport');
    assert.equal(workspace.tablistCount, 1, 'candidate interview must expose one first-level Tabs control');
    assert.equal(workspace.selectedTabCount, 1, 'candidate interview must expose one selected first-level tab');
    assert.match(workspace.selectedTabText, /当前面试轮次/, 'current interview round must be the default candidate interview workspace');
    assert.ok(workspace.todoCount > 0 || workspace.completionSummary,
      'candidate interview must show actionable todos or one compact completion summary');
    assert.ok(workspace.todoCount <= 6, 'candidate interview todo strip must not exceed the six workflow domains');
    assert.equal(workspace.nonActionableTodoCount, 0, 'completed and idle domains must not remain in the actionable todo strip');
    assert.equal(workspace.todoAriaPressedCount, 0, 'candidate interview todos must not masquerade as selected tabs');
    assert.equal(workspace.ariaCurrentCount, 0, 'candidate interview status and todos must not expose a second aria-current location');
    assert.equal(workspace.currentExpanded, 'true', 'candidate current Session must default open');
    assert.equal(workspace.historiesCollapsed, true, 'candidate historical Sessions must default collapsed');
    assert.ok(workspace.documentOverflow <= 1 && workspace.workspaceOverflow <= 1 && workspace.rootOverflow <= 1,
      'candidate interview workspace must not overflow at 1100px');
    const workspaceEvidence = await captureEvidence(win, 'w3-candidate-review-1100x720');

    await clickTextContaining(win, '.interview-workflow-tabs [role="tab"]', '录音与转写');
    await waitFor(win,
      "document.querySelector('.candidate-interview-launcher progress[aria-label=\"录音进行中，等待手动停止\"]')",
      'W3 unplanned recording progress');
    const unplannedProgress = await win.webContents.executeJavaScript(`(() => {
      const progress = document.querySelector('.candidate-interview-launcher progress[aria-label="录音进行中，等待手动停止"]');
      return {
        present: Boolean(progress),
        valueAttribute: progress?.getAttribute('value') ?? null,
        ariaValueNow: progress?.getAttribute('aria-valuenow') ?? null,
        label: progress?.getAttribute('aria-label') || '',
      };
    })()`);
    assert.deepEqual(unplannedProgress, {
      present: true,
      valueAttribute: null,
      ariaValueNow: null,
      label: '录音进行中，等待手动停止',
    }, 'unplanned recording must expose indeterminate progress rather than 100%');
    const runningControls = await inspectCandidateRecordingControls(win);
    assert.equal(runningControls.runningProgressVisible, true,
      'running candidate recording controls must be measured against the active recording state');
    assert.deepEqual(runningControls.visibleButtonLabels, ['停止并转写'],
      'running candidate recording must expose only the stop-and-transcribe action');
    assert.deepEqual(runningControls.disabledButtonLabels, [],
      'the sole running candidate recording action must remain operable');
    assert.doesNotMatch(runningControls.visibleButtonLabels.join(' / '),
      /麦克风预检|测试麦克风|开始.*录音|(?:重新)?检查依赖|环境检查|检查环境/,
      'running candidate recording must hide preflight, start and environment-check actions');

    await waitFor(win,
      "document.querySelector('.candidate-interview-launcher .live-recording-waveform')?.getAttribute('data-audio-state') === 'active'",
      'W3 live recording waveform');
    await delay(420);
    const inspectLiveWaveform = () => win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('.candidate-interview-launcher .live-recording-waveform');
      const meter = root?.querySelector('.live-recording-bars[role="meter"]');
      const bars = [...(meter?.querySelectorAll('i') || [])];
      const scale = (bar) => {
        const match = (bar?.style?.transform || '').match(/scaleY\\(([^)]+)\\)/);
        return match ? Number(match[1]) : 0;
      };
      return {
        state: root?.getAttribute('data-audio-state') || '',
        strengthState: root?.getAttribute('data-strength-state') || '',
        rootLabel: root?.getAttribute('aria-label') || '',
        meterNow: Number(meter?.getAttribute('aria-valuenow')),
        meterText: meter?.getAttribute('aria-valuetext') || '',
        barCount: bars.length,
        barsHidden: bars.length > 0 && bars.every((bar) => bar.getAttribute('aria-hidden') === 'true'),
        maximumScale: Math.max(0, ...bars.map(scale)),
        transforms: bars.map((bar) => bar.style.transform),
        barClasses: bars.map((bar) => bar.className),
        barBackgrounds: bars.map((bar) => getComputedStyle(bar).backgroundImage),
        strengthText: (root?.querySelector('.live-recording-strength')?.textContent || '').trim(),
        statusText: (root?.querySelector('.live-recording-waveform-status[role="status"]')?.textContent || '').trim(),
      };
    })()`);
    const lowWaveform = await inspectLiveWaveform();
    assert.equal(lowWaveform.state, 'active');
    assert.equal(lowWaveform.strengthState, 'normal');
    assert.equal(lowWaveform.rootLabel, '实时录音波形');
    assert.equal(lowWaveform.barCount, 20, 'live audio visualization must use the fixed 20-bar contract');
    assert.equal(lowWaveform.barsHidden, true, 'decorative bars must stay hidden from assistive technology');
    assert.equal(lowWaveform.meterNow, 19, 'the meter must expose the real low-frame peak, not decorative motion');
    assert.match(lowWaveform.strengthText, /强度 19% · 正常/,
      'normal microphone input must have a visible non-color label');

    const beforeHigh = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
    await win.webContents.executeJavaScript("window.runtimeInfo.setW3LiveAudioMode('live-high')");
    await waitFor(win,
      "Number(document.querySelector('.candidate-interview-launcher .live-recording-bars')?.getAttribute('aria-valuenow')) === 94 && document.querySelector('.candidate-interview-launcher .live-recording-waveform')?.getAttribute('data-strength-state') === 'warning'",
      'W3 high live-audio frame');
    await delay(420);
    const highWaveform = await inspectLiveWaveform();
    const afterHigh = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
    assert.ok(afterHigh.w3ProgressGets > beforeHigh.w3ProgressGets,
      'active recording must poll for a new telemetry frame');
    assert.equal(highWaveform.state, 'active');
    assert.equal(highWaveform.strengthState, 'warning');
    assert.equal(highWaveform.meterNow, 94);
    assert.match(highWaveform.strengthText, /强度 94% · 收音较强/);
    assert.match(highWaveform.meterText, /强度 94% · 收音较强.*音量偏高/,
      'warning color must be reinforced by accessible text');
    assert.ok(highWaveform.barClasses.some((className) => className === 'is-strength-warning'),
      'high real samples must use the warning bar color');
    assert.ok(new Set(highWaveform.barBackgrounds).size >= 2,
      'normal and high samples must render distinct computed gradients');
    assert.ok(highWaveform.maximumScale > lowWaveform.maximumScale + 0.25,
      'bar geometry must respond materially to higher real telemetry');
    assert.notDeepEqual(highWaveform.transforms, lowWaveform.transforms,
      'live bars must derive from successive telemetry frames rather than a fixed animation');

    await win.webContents.executeJavaScript("window.runtimeInfo.setW3LiveAudioMode('live-clipping')");
    await waitFor(win,
      "Number(document.querySelector('.candidate-interview-launcher .live-recording-bars')?.getAttribute('aria-valuenow')) === 100 && document.querySelector('.candidate-interview-launcher .live-recording-waveform')?.getAttribute('data-strength-state') === 'clipping'",
      'W3 near-clipping live-audio frame');
    await delay(420);
    const clippingWaveform = await inspectLiveWaveform();
    assert.equal(clippingWaveform.strengthState, 'clipping');
    assert.match(clippingWaveform.strengthText, /强度 100% · 峰值过高/);
    assert.match(clippingWaveform.meterText, /音量接近爆音/,
      'near-clipping color must be reinforced by corrective text');
    assert.ok(clippingWaveform.barClasses.some((className) => className === 'is-strength-clipping'),
      'near-clipping real samples must use the critical bar color');
    assert.ok(new Set(clippingWaveform.barBackgrounds).size >= 3,
      'normal, warning and near-clipping samples must retain distinct computed gradients');

    await win.webContents.executeJavaScript("window.runtimeInfo.setW3LiveAudioMode('stale')");
    await waitFor(win,
      "document.querySelector('.candidate-interview-launcher .live-recording-waveform')?.getAttribute('data-audio-state') === 'stale'",
      'W3 stale live-audio state');
    const staleWaveform = await inspectLiveWaveform();
    assert.equal(staleWaveform.meterNow, 0, 'stale telemetry must not be presented as current microphone activity');
    assert.equal(staleWaveform.strengthState, 'unavailable');
    assert.ok(staleWaveform.barBackgrounds.every((background) => background === 'none'),
      'stale lifecycle styling must override prior strength gradients');
    assert.match(staleWaveform.statusText, /等待新的收音数据/);

    await win.webContents.executeJavaScript("window.runtimeInfo.setW3LiveAudioMode('live-high')");
    await waitFor(win,
      "document.querySelector('.candidate-interview-launcher .live-recording-waveform')?.getAttribute('data-audio-state') === 'active'",
      'W3 active live-audio state before stop');
    const beforeStop = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
    assert.equal(beforeStop.w3StopPosts, 0, 'the synthetic recording must not receive an implicit stop request');
    await clickExactText(win, '.candidate-interview-launcher button', '停止并转写');
    await waitFor(win,
      "document.querySelector('.candidate-interview-launcher .live-recording-waveform')?.getAttribute('data-audio-state') === 'stopping'",
      'W3 stopping live-audio state after the real stop button');
    const stopButtonState = await win.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('.candidate-interview-launcher button')]
        .find((item) => (item.textContent || '').includes('正在生成转写'));
      return button ? { label: button.textContent.trim(), disabled: button.disabled } : null;
    })()`);
    assert.deepEqual(stopButtonState, { label: '正在生成转写…', disabled: true },
      'one stop click must immediately lock the action while transcription is pending');
    const afterStop = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
    assert.equal(afterStop.w3StopPosts, 1, 'one stop-button click must produce exactly one stop POST');
    assert.deepEqual(afterStop.w3LastStopRequest, {
      taskId: 'SYN-W3-UNPLANNED-RECORDING',
      candidateId: 'SYN-VISUAL-1',
      jobId: 9901,
      round: 2,
    }, 'the stop request must exactly match the visible task, candidate, job and interview round');
    assert.equal(afterStop.w3StopRequested, true, 'the stop POST must change synthetic task truth');
    const stoppingWaveform = await inspectLiveWaveform();
    await delay(650);
    const stoppingWaveformLater = await inspectLiveWaveform();
    assert.equal(stoppingWaveform.strengthState, 'unavailable');
    assert.ok(stoppingWaveform.barBackgrounds.every((background) => background === 'none'),
      'stopping lifecycle styling must override prior strength gradients');
    assert.match(stoppingWaveform.statusText, /录音已停止.*波形已冻结/);
    assert.deepEqual(stoppingWaveformLater.transforms, stoppingWaveform.transforms,
      'stopping must freeze the final rendered frame instead of continuing decorative motion');
    const unplannedProgressEvidence = await captureEvidence(win, 'w3-unplanned-recording-1100x720');
    await waitFor(win,
      "!document.querySelector('.candidate-interview-launcher .live-recording-waveform') && ![...document.querySelectorAll('.candidate-interview-launcher button')].some((button) => (button.textContent || '').includes('停止并转写'))",
      'W3 synthetic recording completion after stop');
    const completedStop = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
    assert.equal(completedStop.w3StopPosts, 1, 'the disabled stopping action must prevent duplicate stop POSTs');
    assert.equal(completedStop.w3RecordingStopped, true, 'the synthetic stop flow must reach a terminal state');

    await clickTextContaining(win, '.interview-workflow-tabs [role="tab"]', '材料与历史');
    await waitFor(win, "[...document.querySelectorAll('.interview-evidence-workspace button')].some((button) => button.textContent.trim() === '选择旧 summary.json 并导入')", 'W3 summary picker trigger');
    await win.webContents.executeJavaScript("window.runtimeInfo.setSummarySelectionMode('cancel')");
    await clickExactText(win, '.interview-evidence-workspace button', '选择旧 summary.json 并导入');
    await delay(250);
    const cancelled = await win.webContents.executeJavaScript(`(async () => {
      const runtime = await window.runtimeInfo.get();
      const trigger = [...document.querySelectorAll('.interview-evidence-workspace button')]
        .find((button) => button.textContent.trim() === '选择旧 summary.json 并导入');
      return {
        selectorCalls: runtime.summarySelectorCalls,
        importCalls: runtime.summaryImportCalls,
        inlineErrorVisible: Boolean(document.querySelector('.interview-evidence-workspace .ant-alert-error')),
        activeTag: document.activeElement?.tagName || '',
        focusIsTrigger: document.activeElement === trigger,
        focusText: (document.activeElement?.textContent || '').trim(),
      };
    })()`);
    assert.deepEqual(cancelled, {
      selectorCalls: 1,
      importCalls: 0,
      inlineErrorVisible: false,
      activeTag: 'BUTTON',
      focusIsTrigger: true,
      focusText: '选择旧 summary.json 并导入',
    }, 'native summary cancellation must perform zero imports and restore trigger focus');

    await win.webContents.executeJavaScript("window.runtimeInfo.setSummarySelectionMode('error')");
    await clickExactText(win, '.interview-evidence-workspace button', '选择旧 summary.json 并导入');
    await waitFor(win,
      "document.querySelector('.interview-evidence-workspace .ant-alert-error')?.textContent.includes('合成 summary 选择失败')",
      'W3 summary inline error');
    await delay(250);
    const failed = await win.webContents.executeJavaScript(`(async () => {
      const runtime = await window.runtimeInfo.get();
      const alert = document.querySelector('.interview-evidence-workspace .ant-alert-error');
      const trigger = [...document.querySelectorAll('.interview-evidence-workspace button')]
        .find((button) => button.textContent.trim() === '选择旧 summary.json 并导入');
      return {
        selectorCalls: runtime.summarySelectorCalls,
        importCalls: runtime.summaryImportCalls,
        inlineErrorText: (alert?.textContent || '').trim(),
        activeTag: document.activeElement?.tagName || '',
        focusIsTrigger: document.activeElement === trigger,
        focusText: (document.activeElement?.textContent || '').trim(),
      };
    })()`);
    assert.equal(failed.selectorCalls, 2, 'summary error path must call the native selector once');
    assert.equal(failed.importCalls, 0, 'summary selector error must perform zero imports');
    assert.match(failed.inlineErrorText, /旧录音摘要导入失败/);
    assert.match(failed.inlineErrorText, /合成 summary 选择失败/);
    assert.equal(failed.activeTag, 'BUTTON');
    assert.equal(failed.focusIsTrigger, true);
    assert.equal(failed.focusText, '选择旧 summary.json 并导入');
    const errorEvidence = await captureEvidence(win, 'w3-summary-error-1100x720');

    win.setContentSize(1360, 768);
    win.webContents.setZoomFactor(1.25);
    await delay(180);
    const windows125 = await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('.interview-review-panel');
      const workspaceElement = root?.closest('.workspace');
      return {
        viewport: [innerWidth, innerHeight],
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        workspaceOverflow: workspaceElement ? workspaceElement.scrollWidth - workspaceElement.clientWidth : null,
        rootOverflow: root ? root.scrollWidth - root.clientWidth : null,
      };
    })()`);
    assert.ok(Math.abs(windows125.viewport[0] - 1088) <= 1 && Math.abs(windows125.viewport[1] - 614) <= 1,
      'candidate interview must use the Windows 125% equivalent CSS viewport');
    assert.ok(windows125.documentOverflow <= 1 && windows125.workspaceOverflow <= 1 && windows125.rootOverflow <= 1,
      'candidate interview workspace must not overflow horizontally at Windows 125%');
    const windows125Evidence = await captureEvidence(win, 'w3-candidate-review-1360x768-windows125');
    assert.deepEqual(errors, [], 'W3 candidate review renderer must not emit console errors');
    return {
      workspace: { ...workspace, evidence: workspaceEvidence },
      unplanned_progress: {
        ...unplannedProgress,
        controls: runningControls,
        live_audio: {
          low: lowWaveform,
          high: highWaveform,
          clipping: clippingWaveform,
          stale: staleWaveform,
          stopping: stoppingWaveformLater,
        },
        stop: {
          posts: completedStop.w3StopPosts,
          stop_requested: completedStop.w3StopRequested,
          terminal: completedStop.w3RecordingStopped,
        },
        evidence: unplannedProgressEvidence,
      },
      summary_cancel: cancelled,
      summary_error: { ...failed, evidence: errorEvidence },
      windows125: { ...windows125, evidence: windows125Evidence },
    };
  } finally {
    win.destroy();
  }
}

async function verifyCandidateIdleRecordingLayout() {
  const preloadPath = createCandidateIdleRecordingPreload();
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
      additionalArguments: ['--hrboss-runtime-scenario=candidate-recording-idle'],
    },
  });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event && (event.level === 'error' || Number(event.level) >= 3)) errors.push(event.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(`renderer gone: ${JSON.stringify(details)}`));
  try {
    await win.loadFile(path.join(distRoot, 'index.html'));
    win.webContents.setZoomFactor(1);
    await waitFor(win, "document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent.includes('合成岗位')", 'idle candidate recording job context');
    await clickExactText(win, 'button.nav-item', '候选人');
    await waitFor(win, "document.querySelector('.candidate-card')", 'idle candidate recording list');
    await win.webContents.executeJavaScript("document.querySelector('.candidate-card')?.click()");
    await waitFor(win, "document.querySelector('.candidate-domain-tab-option')", 'idle candidate recording domain navigation');
    await clickTextContaining(win, '.candidate-domain-tab-option', '面试');
    await waitFor(win, "document.querySelector('.interview-workflow-tabs')", 'idle candidate interview workspace');
    await clickTextContaining(win, '.interview-workflow-tabs [role="tab"]', '录音与转写');
    await waitFor(win,
      "[...document.querySelectorAll('.candidate-interview-launcher .ant-tag')].some((tag) => tag.textContent.trim() === '当前任务：需先取得候选人材料处理同意')",
      'idle candidate recording state');
    await waitFor(win,
      "[...document.querySelectorAll('.candidate-interview-actions button')].filter((button) => button.getClientRects().length).length === 2",
      'idle candidate recording actions');
    // The viewport assertion below looks the primary action up by its label, so
    // wait for that label rather than for a fixed delay. Two visible buttons is
    // not the same condition, and on a loaded machine 120ms was not enough for
    // the second one to finish rendering — the assertion then measured a button
    // that did not exist yet and reported it as unreachable.
    await waitFor(win,
      "[...document.querySelectorAll('.candidate-interview-controls button')].some((button) => button.getClientRects().length && /开始录音|停止并转写/.test((button.textContent || '').trim()))",
      'idle candidate recording primary action');
    await delay(120);
    const initialState = await inspectCandidateRecordingControls(win);
    // Carries the state for the same reason the row assertion below does: this
    // one fails intermittently, and "false !== true" cannot distinguish a
    // primary action that rendered below the fold from one the poll caught
    // before its label existed.
    assert.equal(initialState.primaryActionInViewport, true,
      `the 1440px recording primary action must be reachable without an extra page scroll: ${JSON.stringify(initialState)}`);
    assert.equal(initialState.actionSharesFieldRow, true,
      `the 1440px recording actions must share the current control row: ${JSON.stringify(initialState)}`);

    const durationBoundaries = {};
    for (const value of ['4', '5', '14400', '14401']) {
      const changed = await win.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('input[name="interview-review-duration-seconds"]');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!input || !setter) return false;
        setter.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
        return true;
      })()`);
      assert.equal(changed, true, `recording duration boundary ${value} must use the real input`);
      await delay(60);
      durationBoundaries[value] = (await inspectCandidateRecordingControls(win)).duration;
    }
    assert.equal(durationBoundaries['4'].invalid, 'true', '4 seconds must fail the frontend recording contract');
    assert.equal(durationBoundaries['5'].invalid, 'false', '5 seconds must satisfy the frontend recording contract');
    assert.equal(durationBoundaries['14400'].invalid, 'false', '14400 seconds must satisfy the frontend recording contract');
    assert.equal(durationBoundaries['14401'].invalid, 'true', '14401 seconds must fail the frontend recording contract');
    assert.match(durationBoundaries['4'].hintText, /5.*14400/,
      'invalid recording duration must expose the accepted boundary beside the field');
    assert.match(durationBoundaries['14401'].hintClass, /candidate-interview-field-error/,
      'invalid recording duration must use the owned inline error class');
    await win.webContents.executeJavaScript(
      "document.querySelector('#candidate-interview-launcher')?.scrollIntoView({ block: 'center' })",
    );
    await delay(120);
    const state = await inspectCandidateRecordingControls(win);
    assert.equal(state.runningProgressVisible, false,
      'idle recording action layout must be measured only after the fixture reports idle');
    assert.ok(state.taskTags.includes('当前任务：需先取得候选人材料处理同意'),
      'the idle fixture has no consent on file, so the current-task label must name that blocker rather than claim recording can start');
    assert.ok(state.taskTags.some((label) => label.startsWith('工具：')),
      'recording status must expose software discovery separately from task state');
    assert.ok(state.taskTags.some((label) => label.startsWith('麦克风：')),
      'recording status must not present tool discovery as a microphone verification result');
    assert.deepEqual(state.visibleButtonLabels, ['创建首轮 Session', '测试麦克风', '开始录音'],
      'a candidate without a Session must expose the required Session setup alongside the two recording actions');
    assert.doesNotMatch(state.visibleButtonLabels.join(' / '), /检查录音环境|重新检查录音环境/,
      'a healthy idle recording environment must not expose a recovery action');
    assert.equal(state.ownedActionAreaPresent, true,
      'idle recording buttons must use the candidate-owned action container');
    assert.equal(state.actionAreaInsideControls, true,
      'idle candidate recording actions must remain inside the controls grid');
    assert.equal(state.fieldsShareRow, true,
      'the 1440px idle fixture must exercise the two-column control layout');
    assert.equal(state.actionSharesFieldRow, true,
      'idle candidate recording action container must remain on the wide control row');
    assert.equal(state.buttonsShareRow, true,
      'idle candidate recording actions must share a row instead of stacking in one narrow column');
    assert.deepEqual(errors, [], 'idle candidate recording renderer must not emit console errors');
    const evidence = await captureEvidence(win, 'candidate-idle-recording-1440x900');
    return { ...state, initial: initialState, duration_boundaries: durationBoundaries, evidence };
  } finally {
    win.destroy();
    if (fs.existsSync(preloadPath)) fs.unlinkSync(preloadPath);
  }
}

async function verifyCandidateMicCheckFailure() {
  const preloadPath = createCandidateMicCheckFailPreload();
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
      additionalArguments: ['--hrboss-runtime-scenario=candidate-mic-check-fail'],
    },
  });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event && (event.level === 'error' || Number(event.level) >= 3)) errors.push(event.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(`renderer gone: ${JSON.stringify(details)}`));
  const inspectLauncher = () => win.webContents.executeJavaScript(`(() => {
    const tags = [...document.querySelectorAll('.candidate-interview-launcher .ant-tag')]
      .map((tag) => tag.textContent.trim());
    const buttons = [...document.querySelectorAll('.candidate-interview-actions button')]
      .filter((button) => button.getClientRects().length)
      .map((button) => ({ label: button.textContent.trim(), disabled: button.disabled }));
    const failResult = document.querySelector('.candidate-mic-check-result');
    const failAlert = failResult ? failResult.closest('.ant-alert') : null;
    return {
      tags,
      buttons,
      failAlertText: failAlert ? failAlert.textContent : '',
    };
  })()`);
  try {
    await win.loadFile(path.join(distRoot, 'index.html'));
    win.webContents.setZoomFactor(1);
    await waitFor(win, "document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent.includes('合成岗位')", 'mic-check fail job context');
    await clickExactText(win, 'button.nav-item', '候选人');
    await waitFor(win, "document.querySelector('.candidate-card')", 'mic-check fail candidate list');
    await win.webContents.executeJavaScript("document.querySelector('.candidate-card')?.click()");
    await waitFor(win, "document.querySelector('.candidate-domain-tab-option')", 'mic-check fail domain navigation');
    await clickTextContaining(win, '.candidate-domain-tab-option', '面试');
    await waitFor(win, "document.querySelector('.interview-workflow-tabs')", 'mic-check fail interview workspace');
    await clickTextContaining(win, '.interview-workflow-tabs [role="tab"]', '录音与转写');
    await waitFor(win,
      "[...document.querySelectorAll('.candidate-interview-actions button')].some((button) => button.textContent.trim() === '测试麦克风' && !button.disabled)",
      'mic-check fail idle actions ready');
    await delay(120);

    const before = await inspectLauncher();
    assert.ok(before.tags.includes('麦克风：未测试，建议先预检'),
      `an untested microphone must carry the pre-check suggestion in its status copy: ${JSON.stringify(before.tags)}`);
    assert.ok(before.tags.includes('当前任务：可以开始录音'),
      'with consent and a Session on file the idle task label must offer recording');
    const startBefore = before.buttons.find((button) => button.label === '开始录音');
    assert.ok(startBefore && startBefore.disabled === false,
      'an untested microphone must not disable recording — the status copy is a suggestion, not a gate');

    await clickTextContaining(win, '.candidate-interview-actions button', '测试麦克风');
    await waitFor(win,
      "[...document.querySelectorAll('.candidate-interview-launcher .ant-tag')].some((tag) => tag.textContent.trim() === '麦克风：预检未通过')",
      'mic-check failure state');
    await waitFor(win,
      "[...document.querySelectorAll('.candidate-interview-actions button')].some((button) => button.textContent.trim() === '测试麦克风' && !button.disabled)",
      'mic-check failure actions settled');
    await delay(120);

    const state = await inspectLauncher();
    assert.ok(state.tags.includes('麦克风：预检未通过'),
      'a failed pre-check must be named by the microphone status tag');
    assert.ok(state.tags.includes('最近任务：最近一次已完成'),
      'the task status line describes the task, not the device: a completed failing pre-check is still a completed task');
    assert.match(state.failAlertText, /仅录到静音/,
      'the failed pre-check must surface its own result panel with the failure detail');
    assert.match(state.failAlertText, /请检查系统输入设备后重新预检/,
      'the failed pre-check panel must carry the recovery recommendation');
    const startAfter = state.buttons.find((button) => button.label === '开始录音');
    assert.ok(startAfter && startAfter.disabled === true,
      'a failed microphone pre-check must disable 开始录音 until a new check clears it');
    const retest = state.buttons.find((button) => button.label === '测试麦克风');
    assert.ok(retest && retest.disabled === false,
      'a failed pre-check must leave the re-test action available');
    assert.deepEqual(errors, [], 'mic-check failure renderer must not emit console errors');
    const evidence = await captureEvidence(win, 'candidate-mic-check-fail-1440x900');
    return { before, ...state, evidence };
  } finally {
    win.destroy();
    if (fs.existsSync(preloadPath)) fs.unlinkSync(preloadPath);
  }
}

async function verifyW3InterviewRuntime() {
  const keepAlive = new BrowserWindow({ show: false, width: 1, height: 1 });
  try {
    await keepAlive.loadURL('about:blank');
    const formal = await verifyW3ScheduleScenario('w3-formal', 'formal', 'false');
    const fixture = await verifyW3ScheduleScenario('w3-fixture', 'fixture', 'true');
    for (const key of ['canonical', 'currentCount', 'currentExpanded', 'historiesCollapsed', 'expandedSessionCount', 'secondaryVisible', 'localToolsVisible']) {
      assert.deepEqual(fixture.desktop[key], formal.desktop[key], `formal and fixture schedules must share ${key}`);
    }
    const candidate = await verifyW3CandidateReview();
    const candidateIdle = await verifyCandidateIdleRecordingLayout();
    const micCheckFail = await verifyCandidateMicCheckFailure();
    return { formal, fixture, candidate, candidate_idle: candidateIdle, mic_check_fail: micCheckFail };
  } finally {
    keepAlive.destroy();
  }
}

function createRuntimeWindow(scenario, extraArguments = []) {
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(ROOT, "tests/check-ui-visual-runtime-preload.js"),
      additionalArguments: [`--hrboss-runtime-scenario=${scenario}`, ...extraArguments],
    },
  });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event && (event.level === 'error' || Number(event.level) >= 3)) errors.push(event.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(`renderer gone: ${JSON.stringify(details)}`));
  return { win, errors };
}

function createW4Window(extraArguments = []) {
  return createRuntimeWindow('w4-runtime', extraArguments);
}

function createW4BWindow(mode) {
  return createW4Window([`--hrboss-w4b-mode=${mode}`]);
}

async function readW4BRuntime(win) {
  return win.webContents.executeJavaScript('window.runtimeInfo.get()');
}

async function waitForW4BRuntime(win, predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = await readW4BRuntime(win);
    if (predicate(runtime.w4b, runtime)) return runtime;
    await delay(80);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function openW4BJobEditor(win, jobName = '合成岗位 · 运行态视觉门禁') {
  await clickExactText(win, 'button.nav-item', '职位管理');
  await waitFor(win, "Boolean(document.querySelector('.job-ledger-open-link'))", 'W4-B job ledger');
  const targetVisible = await win.webContents.executeJavaScript(`[
    ...document.querySelectorAll('.job-ledger-open-link'),
  ].some((element) => element.textContent.trim() === ${JSON.stringify(jobName)})`);
  if (!targetVisible) {
    const closedFilterCleared = await win.webContents.executeJavaScript(`(() => {
      const checkbox = document.querySelector('.job-ledger-filters input[type="checkbox"]');
      if (!checkbox?.checked) return false;
      checkbox.click();
      return true;
    })()`);
    assert.equal(closedFilterCleared, true, `W4-B hidden job must be reachable through the existing closed-job filter: ${jobName}`);
    await waitFor(win,
      `[...document.querySelectorAll('.job-ledger-open-link')].some((element) => element.textContent.trim() === ${JSON.stringify(jobName)})`,
      `W4-B visible job: ${jobName}`);
  }
  await clickExactText(win, '.job-ledger-open-link', jobName);
  await waitFor(win, "Boolean(document.querySelector('.job-module-action-strip'))", 'W4-B job editor');
}

async function openW4BDeepProfile(win, jobName = '合成岗位 · 运行态视觉门禁') {
  await openW4BJobEditor(win, jobName);
  await clickExactText(win, '.job-module-action-strip button', '查看深度画像');
  await waitFor(win, "Boolean(document.querySelector('.deep-profile-modal-introduction'))", 'W4-B deep-profile modal');
  await waitFor(win,
    "[...document.querySelectorAll('[role=dialog] button')].some((button) => /(?:生成深度画像|重新生成画像|重新确认并生成)/.test(button.textContent.trim()))",
    'W4-B deep-profile display-ready');
}

async function loadW4BJobEditor(win, jobName) {
  await win.loadFile(path.join(distRoot, 'index.html'));
  win.webContents.setZoomFactor(1);
  await delay(80);
  await waitFor(win, "Boolean(document.querySelector('button.nav-item'))", 'W4-B main navigation');
  await openW4BJobEditor(win, jobName);
}

// Regenerating voids a confirmed deep profile, so the button now opens a
// confirmation before anything is posted. Every W4-B path must pass through it,
// which is why this asserts the dialog appears rather than clicking blindly.
async function clickRegenerateDeepProfile(win, selector = '[role=dialog] button') {
  await clickExactText(win, selector, '重新生成画像（旧的确认状态会作废）');
  await waitFor(win, "Boolean(document.querySelector('.ant-modal-confirm'))",
    'W4-B regenerate confirmation dialog');
  await clickExactText(win, '.ant-modal-confirm button', '确认重新生成');
  await waitFor(win, "!document.querySelector('.ant-modal-confirm')",
    'W4-B regenerate confirmation dismissed');
}

async function loadAndOpenW4BDeepProfile(win, jobName) {
  await win.loadFile(path.join(distRoot, 'index.html'));
  win.webContents.setZoomFactor(1);
  await delay(80);
  await waitFor(win, "Boolean(document.querySelector('button.nav-item'))", 'W4-B main navigation');
  await openW4BDeepProfile(win, jobName);
}

async function reopenW4BDeepProfile(win) {
  await clickExactText(win, '.job-module-action-strip button', '查看深度画像');
  await waitFor(win, "Boolean(document.querySelector('.deep-profile-modal-introduction'))", 'W4-B reopened deep-profile modal');
}

async function verifyW4GuideAndDashboard() {
  const { win, errors } = createW4Window(['--hrboss-w4-guide-mode=error']);
  try {
    await win.loadFile(path.join(distRoot, 'index.html'));
    win.webContents.setZoomFactor(1);
    await delay(80);
    await waitFor(win, "document.querySelector('button.nav-item')", 'W4 guide navigation');
    await clickDesktopGuide(win);
    await waitFor(win, "document.querySelector('.workflow-guide-page')?.dataset.guideAuthority === 'loading'", 'W4 guide loading authority');
    const loading = await win.webContents.executeJavaScript(`(() => ({
      authority: document.querySelector('.workflow-guide-page')?.dataset.guideAuthority || '',
      deterministicCtaCount: document.querySelectorAll('.workflow-guide-next button, .workflow-guide-step-card button, .ai-value-current button').length,
      primaryButtonCount: document.querySelectorAll('.workflow-guide-page .ant-btn-primary').length,
      statusVisible: Boolean(document.querySelector('.workflow-guide-page [role="status"]')),
    }))()`);
    assert.deepEqual(loading, {
      authority: 'loading',
      deterministicCtaCount: 0,
      primaryButtonCount: 0,
      statusVisible: true,
    }, 'guide loading must not infer a deterministic recommendation CTA');
    const loadingEvidence = await captureEvidence(win, 'w4-guide-loading-1100x720');

    await waitFor(win, "document.querySelector('.workflow-guide-page')?.dataset.guideAuthority === 'error'", 'W4 guide authority error');
    const failed = await win.webContents.executeJavaScript(`(() => {
      const page = document.querySelector('.workflow-guide-page');
      return {
        authority: page?.dataset.guideAuthority || '',
        deterministicCtaCount: page?.querySelectorAll('.workflow-guide-next button, .workflow-guide-step-card button, .ai-value-current button').length || 0,
        buttonTexts: [...(page?.querySelectorAll('button') || [])].map((button) => button.textContent.trim()),
        alertText: (page?.querySelector('[role="alert"]')?.textContent || '').trim(),
      };
    })()`);
    assert.equal(failed.authority, 'error');
    assert.equal(failed.deterministicCtaCount, 0, 'guide error must not infer a deterministic recommendation CTA');
    assert.deepEqual(failed.buttonTexts, ['重新读取'], 'guide error may expose only the recovery action');
    assert.match(failed.alertText, /错误不会被当作空数据/);
    const errorEvidence = await captureEvidence(win, 'w4-guide-error-1100x720');

    await win.webContents.executeJavaScript("window.runtimeInfo.setW4GuideMode('ready')");
    await clickExactText(win, '.workflow-guide-page button', '重新读取');
    await waitFor(win, "document.querySelector('.workflow-guide-page')?.dataset.guideAuthority === 'ready'", 'W4 guide recovery');

    await clickExactText(win, 'button.nav-item', '工作台');
    await waitFor(win, "document.querySelector('.dashboard-panel.dashboard-v2')", 'W4 dashboard');
    const dashboard = await win.webContents.executeJavaScript(`(() => {
      const buttons = [...document.querySelectorAll('.dashboard-panel button')];
      const todoActions = [...document.querySelectorAll('.dashboard-todo-action')];
      return {
        genericCandidateCtaCount: buttons.filter((button) => button.textContent.trim() === '候选人队列').length,
        todoActionCount: todoActions.length,
        targetedTodoCount: todoActions.filter((button) => (button.getAttribute('aria-label') || '').includes('候选人：')).length,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    assert.equal(dashboard.genericCandidateCtaCount, 1, 'dashboard must expose exactly one generic candidate queue CTA');
    assert.ok(dashboard.todoActionCount >= 1 && dashboard.targetedTodoCount >= 1,
      'dashboard must retain candidate-targeted todo actions');
    assert.ok(dashboard.documentOverflow <= 1);
    const dashboardEvidence = await captureEvidence(win, 'w4-dashboard-candidate-entry-1100x720');

    await clickDesktopGuide(win);
    await waitFor(win, "document.querySelector('.workflow-guide-page')?.dataset.guideAuthority === 'ready'", 'W4 guide ready before stale refresh');
    await win.webContents.executeJavaScript("window.runtimeInfo.setW4GuideMode('stale')");
    await clickExactText(win, '.topbar-refresh-local', '刷新本地数据');
    await waitFor(win, "document.querySelector('.workflow-guide-page')?.dataset.guideAuthority === 'stale'", 'W4 guide stale authority');
    const stale = await win.webContents.executeJavaScript(`(() => {
      const page = document.querySelector('.workflow-guide-page');
      const text = (page?.textContent || '').trim();
      return {
        authority: page?.dataset.guideAuthority || '',
        oldContentExplicit: text.includes('旧内容') && text.includes('当前显示上次成功读取的指南内容'),
        retryCount: [...(page?.querySelectorAll('button') || [])].filter((button) => button.textContent.trim() === '重新读取').length,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    assert.deepEqual(stale, {
      authority: 'stale',
      oldContentExplicit: true,
      retryCount: 1,
      documentOverflow: 0,
    }, 'guide stale state must label old content and retain one retry');
    const staleEvidence = await captureEvidence(win, 'w4-guide-stale-1100x720');
    assert.deepEqual(errors, [], 'W4 guide/dashboard renderer must not emit console errors');
    return {
      loading: { ...loading, evidence: loadingEvidence },
      error: { ...failed, evidence: errorEvidence },
      stale: { ...stale, evidence: staleEvidence },
      dashboard: { ...dashboard, evidence: dashboardEvidence },
    };
  } finally {
    win.destroy();
  }
}

async function verifyW4Settings() {
  const { win, errors } = createW4Window();
  try {
    await win.loadFile(path.join(distRoot, 'index.html'));
    win.webContents.setZoomFactor(1);
    await delay(80);
    await waitFor(win, "document.querySelector('.app-nav-footer-main')", 'W4 settings navigation');
    await verifyDesktopUtilityMenuContract(win);
    await clickDesktopUtilityItem(win, '设置中心');
    await waitFor(win, "document.querySelector('.settings-panel')", 'W4 settings panel');
    await waitFor(win, "document.activeElement?.id === 'settings-overview-title'", 'W4 default settings center heading focus');
    await clickExactText(win, '.app-nav-footer-main', '设置与帮助');
    await waitFor(win,
      "[...document.querySelectorAll('.app-nav-utility-menu-item')].some((element) => element.offsetParent !== null)",
      'W4 selected Settings Center menu state');
    const selectedSettingsCenter = await win.webContents.executeJavaScript(`(() => {
      const current = document.querySelector('.app-nav-utility-menu-copy[aria-current="page"]');
      return {
        title: (current?.querySelector('.app-nav-utility-menu-title')?.textContent || '').trim(),
        selected: current?.closest('.app-nav-utility-menu-item')?.classList.contains('ant-dropdown-menu-item-selected') || false,
      };
    })()`);
    assert.deepEqual(selectedSettingsCenter, { title: '设置中心', selected: true },
      'desktop utility selectedKeys and aria-current must identify Settings Center');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor(win, "document.querySelector('.app-nav-footer-main')?.getAttribute('aria-expanded') === 'false'", 'W4 close selected utility state');

    await clickDesktopUtilityItem(win, '本机状态');
    await waitFor(win, "location.hash === '#settings-overview'", 'W4 fixed local status destination');
    await waitFor(win, "document.activeElement?.id === 'settings-overview-title'", 'W4 local status title focus');
    await clickDesktopUtilityItem(win, '设置中心');
    await waitFor(win, "location.hash === '#settings-overview'", 'W4 Settings Center overview destination');
    await waitFor(win, "document.activeElement?.id === 'settings-overview-title'", 'W4 Settings Center overview title focus');
    await clickExactText(win, '.settings-section-nav button', '界面显示');
    await waitFor(win, "location.hash === '#settings-brand'", 'W4 interface preference destination');
    await waitFor(win, "document.activeElement?.id === 'settings-brand-title'", 'W4 interface preference title focus');
    const brandDraftBefore = await win.webContents.executeJavaScript(`(() => ({
      sidebarMark: (document.querySelector('.brand-mark span')?.textContent || '').trim(),
      sidebarName: (document.querySelector('.brand-mark strong')?.textContent || '').trim(),
      storedMark: localStorage.getItem('hrboss.ui.brandMark.v1'),
      storedName: localStorage.getItem('hrboss.ui.brandName.v1'),
      nativeHeadingCount: document.querySelectorAll('#main-workspace h1').length,
      nativeHeadingText: (document.querySelector('#main-workspace h1')?.textContent || '').trim(),
      duplicateSettingsHeadingCount: [...document.querySelectorAll('.settings-head h1, .settings-head h2')]
        .filter((element) => (element.textContent || '').trim() === '设置').length,
      visibleSettingsTitleTag: document.querySelector('.settings-page-title')?.tagName || '',
      previewBackground: getComputedStyle(document.querySelector('.settings-brand-preview')).backgroundColor,
      sidebarBackground: getComputedStyle(document.querySelector('.app-nav')).backgroundColor,
      markMaxLength: document.querySelector('input[name="settings-brand-mark"]')?.maxLength || 0,
      nameMaxLength: document.querySelector('input[name="settings-brand-name"]')?.maxLength || 0,
    }))()`);
    assert.deepEqual({
      nativeHeadingCount: brandDraftBefore.nativeHeadingCount,
      nativeHeadingText: brandDraftBefore.nativeHeadingText,
      duplicateSettingsHeadingCount: brandDraftBefore.duplicateSettingsHeadingCount,
      visibleSettingsTitleTag: brandDraftBefore.visibleSettingsTitleTag,
      sameLightSurface: brandDraftBefore.previewBackground === brandDraftBefore.sidebarBackground,
      markMaxLength: brandDraftBefore.markMaxLength,
      nameMaxLength: brandDraftBefore.nameMaxLength,
    }, {
      nativeHeadingCount: 1,
      nativeHeadingText: '设置',
      duplicateSettingsHeadingCount: 0,
      visibleSettingsTitleTag: 'SPAN',
      sameLightSurface: true,
      markMaxLength: 4,
      nameMaxLength: 32,
    }, 'Settings must expose one module h1, a light-sidebar preview and explicit brand limits');
    const brandDraftEntered = await win.webContents.executeJavaScript(`(() => {
      const markInput = document.querySelector('input[name="settings-brand-mark"]');
      const nameInput = document.querySelector('input[name="settings-brand-name"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!markInput || !nameInput || !setter) return false;
      nameInput.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      setter.call(nameInput, '');
      nameInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward', isComposing: true }));
      setter.call(nameInput, '杭');
      nameInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: '杭', isComposing: true }));
      setter.call(nameInput, '合成工作区测试');
      nameInput.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '合成工作区测试' }));
      nameInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '合成工作区测试' }));
      setter.call(markInput, 'hrb');
      markInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'hrb' }));
      return true;
    })()`);
    assert.equal(brandDraftEntered, true, 'W4 must edit the brand through the real controlled fields');
    await waitFor(win,
      "document.querySelector('input[name=\"settings-brand-name\"]')?.value === '合成工作区测试' && document.querySelector('input[name=\"settings-brand-mark\"]')?.value === 'hrb'",
      'W4 Chinese IME brand draft remains complete');
    const brandBeforeSave = await win.webContents.executeJavaScript(`(() => ({
      sidebarMark: (document.querySelector('.brand-mark span')?.textContent || '').trim(),
      sidebarName: (document.querySelector('.brand-mark strong')?.textContent || '').trim(),
      storedMark: localStorage.getItem('hrboss.ui.brandMark.v1'),
      storedName: localStorage.getItem('hrboss.ui.brandName.v1'),
      previewMark: (document.querySelector('.settings-brand-preview span')?.textContent || '').trim(),
      previewName: (document.querySelector('.settings-brand-preview strong')?.textContent || '').trim(),
    }))()`);
    assert.deepEqual({
      sidebarMark: brandBeforeSave.sidebarMark,
      sidebarName: brandBeforeSave.sidebarName,
      storedMark: brandBeforeSave.storedMark,
      storedName: brandBeforeSave.storedName,
    }, {
      sidebarMark: brandDraftBefore.sidebarMark,
      sidebarName: brandDraftBefore.sidebarName,
      storedMark: brandDraftBefore.storedMark,
      storedName: brandDraftBefore.storedName,
    }, 'typing a brand draft must not update the sidebar or localStorage');
    assert.deepEqual({
      previewMark: brandBeforeSave.previewMark,
      previewName: brandBeforeSave.previewName,
    }, {
      previewMark: 'hrb',
      previewName: '合成工作区测试',
    }, 'the Settings preview must reflect the unsaved brand draft');
    await clickExactText(win, '.settings-brand-actions button', '保存显示设置');
    await waitFor(win,
      "document.querySelector('.brand-mark span')?.textContent.trim() === 'HRB' && document.querySelector('.brand-mark strong')?.textContent.trim() === '合成工作区测试'",
      'W4 explicit brand save updates the committed shell');
    const brandAfterSave = await win.webContents.executeJavaScript(`(() => ({
      storedMark: localStorage.getItem('hrboss.ui.brandMark.v1'),
      storedName: localStorage.getItem('hrboss.ui.brandName.v1'),
      feedback: (document.getElementById('settings-brand-feedback')?.textContent || '').trim(),
    }))()`);
    assert.deepEqual(brandAfterSave, {
      storedMark: 'HRB',
      storedName: '合成工作区测试',
      feedback: '界面已更新，并已保存为本机偏好。 不影响数据读取或业务动作。',
    }, 'the final composed value must persist only after explicit save');
    await clickExactText(win, '.settings-card-head button', '恢复默认');
    await waitFor(win,
      "document.querySelector('.settings-brand-preview span')?.textContent.trim() === '招' && document.querySelector('.settings-brand-preview strong')?.textContent.trim() === '招才官'",
      'W4 restore defaults loads a preview draft');
    const shellBeforeDefaultSave = await win.webContents.executeJavaScript(`(() => ({
      mark: (document.querySelector('.app-nav .brand-mark span')?.textContent || '').trim(),
      name: (document.querySelector('.app-nav .brand-mark strong')?.textContent || '').trim(),
    }))()`);
    assert.deepEqual(shellBeforeDefaultSave, { mark: 'HRB', name: '合成工作区测试' },
      'restoring defaults must not change the shell before explicit save');
    await clickExactText(win, '.settings-brand-actions button', '保存显示设置');
    await waitFor(win,
      "document.querySelector('.brand-mark span')?.textContent.trim() === '招' && document.querySelector('.brand-mark strong')?.textContent.trim() === '招才官'",
      'W4 explicit save commits restored defaults');
    const desktop = await getSurfaceLayout(win, '.settings-panel');
    assert.ok(Math.abs(desktop.cssViewport[0] - 1100) <= 1, 'settings desktop must use the unscaled 1100px viewport');
    assert.ok(desktop.document.overflow <= 1 && desktop.workspace.overflow <= 1 && desktop.surface.overflow <= 1,
      'settings must not overflow horizontally at 1100px');
    const desktopEvidence = await captureEvidence(win, 'w4-settings-1100x720');

    win.setContentSize(1360, 768);
    win.webContents.setZoomFactor(1.25);
    await delay(180);
    const windows125 = await getSurfaceLayout(win, '.settings-panel');
    assert.ok(Math.abs(windows125.cssViewport[0] - 1088) <= 1 && Math.abs(windows125.cssViewport[1] - 614) <= 1,
      'settings 125% sample must use the expected CSS viewport');
    assert.ok(windows125.document.overflow <= 1 && windows125.workspace.overflow <= 1 && windows125.surface.overflow <= 1,
      'settings must not overflow horizontally at Windows 125%');
    const windows125Evidence = await captureEvidence(win, 'w4-settings-1360x768-windows125');

    win.webContents.setZoomFactor(1);
    win.setContentSize(740, 720);
    await delay(180);
    await waitFor(win, "Boolean(document.querySelector('.settings-section-nav [role=\"combobox\"]'))", 'W4 compact settings category select');
    const compactInitial = await win.webContents.executeJavaScript(`(() => {
      const combo = document.querySelector('.settings-section-nav [role="combobox"]');
      combo?.focus();
      return {
        viewport: [innerWidth, innerHeight],
        activeSection: document.querySelector('.settings-panel-view')?.id || '',
        focused: document.activeElement === combo,
        returnCount: [...document.querySelectorAll('.settings-head button')].filter((button) => button.textContent.trim() === '返回工作台').length,
        returnLabel: [...document.querySelectorAll('.settings-head button')].find((button) => button.textContent.trim() === '返回工作台')?.getAttribute('aria-label') || '',
      };
    })()`);
    assert.deepEqual(compactInitial, {
      viewport: [740, 720],
      activeSection: 'settings-brand',
      focused: true,
      returnCount: 1,
      returnLabel: '返回工作台',
    }, 'compact settings must retain the default appearance destination with one explicit return control');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await waitFor(win, "[...document.querySelectorAll('.ant-select-dropdown')].some((dropdown) => dropdown.offsetParent !== null)", 'W4 compact settings category popup');
    let diagnosticsOptionActive = false;
    for (let index = 0; index < 7; index += 1) {
      diagnosticsOptionActive = await win.webContents.executeJavaScript(`(() => {
        const dropdown = [...document.querySelectorAll('.ant-select-dropdown')]
          .find((element) => element.offsetParent !== null);
        return (dropdown?.querySelector('.ant-select-item-option-active')?.textContent || '').trim() === '关于与诊断';
      })()`);
      if (diagnosticsOptionActive) break;
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
      await delay(100);
    }
    assert.equal(diagnosticsOptionActive, true, 'keyboard navigation must reach the diagnostics option before selection');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await waitFor(win, "Boolean(document.querySelector('#settings-advanced'))", 'W4 keyboard category switch to diagnostics');
    await waitFor(win, "document.activeElement?.id === 'settings-advanced-title'", 'W4 diagnostics heading focus');
    const diagnosticsDefault = await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('#settings-advanced');
      const details = [...(root?.querySelectorAll('.settings-advanced-card') || [])];
      return {
        activeSection: root?.id || '',
        headingFocused: document.activeElement?.id === 'settings-advanced-title',
        detailsCount: details.length,
        openCount: details.filter((item) => item.open).length,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        surfaceOverflow: document.querySelector('.settings-panel').scrollWidth - document.querySelector('.settings-panel').clientWidth,
      };
    })()`);
    assert.equal(diagnosticsDefault.activeSection, 'settings-advanced');
    assert.equal(diagnosticsDefault.headingFocused, true, 'keyboard category switch must focus the selected section heading');
    assert.ok(diagnosticsDefault.detailsCount >= 4);
    assert.equal(diagnosticsDefault.openCount, 0, 'development diagnostics details must default collapsed');
    assert.ok(diagnosticsDefault.documentOverflow <= 1 && diagnosticsDefault.surfaceOverflow <= 1,
      'compact settings must not overflow horizontally');
    const compactEvidence = await captureEvidence(win, 'w4-settings-740x720-keyboard-diagnostics');

    await clickExactText(win, '.settings-advanced-card > summary', '本机最近任务进度');
    await waitFor(win, "document.querySelector('.settings-progress-list')", 'W4 local task history');
    const localTasks = await win.webContents.executeJavaScript(`(() => {
      const list = document.querySelector('.settings-progress-list');
      return {
        rowCount: list?.querySelectorAll('.settings-progress-row').length || 0,
        cloudIconCount: list?.querySelectorAll('.anticon-cloud, svg[data-icon="cloud"]').length || 0,
      };
    })()`);
    assert.equal(localTasks.rowCount, 1);
    assert.equal(localTasks.cloudIconCount, 0, 'local task history must not use cloud iconography');
    const localTaskEvidence = await captureEvidence(win, 'w4-settings-local-tasks-740x720');

    await clickExactText(win, '.settings-head button', '返回工作台');
    await waitFor(win, "document.querySelector('button.nav-item.active')?.textContent.trim() === '工作台'", 'W4 settings return destination');

    win.setContentSize(1100, 720);
    await delay(180);
    await clickDesktopUtilityItem(win, '设置中心');
    await waitFor(win, "Boolean(document.querySelector('.settings-panel'))", 'W4 settings unsaved draft desktop entry');
    await clickExactText(win, '.settings-section-nav button', 'AI 与外部连接');
    await waitFor(win, "Boolean(document.querySelector('#settings-integrations'))", 'W4 settings integrations section');
    win.setMinimumSize(1024, 720);
    const connectionsEvidence = {};
    for (const [label, width, height] of [
      ['1280x800', 1280, 800],
      ['1024x768', 1024, 768],
    ]) {
      win.setSize(width, height);
      await delay(180);
      await win.webContents.executeJavaScript(`(() => {
        window.scrollTo(0, 0);
        for (const element of document.querySelectorAll('.app-content, .settings-panel, #main-workspace')) {
          element.scrollTop = 0;
        }
      })()`);
      const layout = await getSurfaceLayout(win, '.settings-panel');
      const outerSize = win.getSize();
      const contentSize = win.getContentSize();
      assert.deepEqual(outerSize, [width, height], `native settings outer window must reach ${label}`);
      assert.deepEqual(layout.cssViewport, contentSize, `settings renderer viewport must match native content size at ${label}`);
      assert.ok(layout.document.overflow <= 1 && layout.workspace.overflow <= 1 && layout.surface.overflow <= 1,
        `recruitment connections must not overflow horizontally at ${label}`);
      connectionsEvidence[label] = {
        outerSize,
        contentSize,
        layout,
        screenshot: await captureEvidence(win, `w4-settings-connections-${label}`),
      };
    }
    win.setSize(1100, 720);
    await delay(180);
    await clickExactText(win, '.settings-admin-config > summary', '高级设置：服务地址、访问密钥与模型');
    await waitFor(win,
      "Boolean(document.querySelector('input[name=\"settings-llm-api-key\"]')) && !document.querySelector('input[name=\"settings-llm-api-key\"]').disabled",
      'W4 editable external AI credential draft');
    const editableConnection = await win.webContents.executeJavaScript(`(() => ({
      cardLabel: document.querySelector('.settings-llm-connection')?.getAttribute('aria-label') || '',
      cardText: document.querySelector('.settings-llm-connection')?.textContent || '',
      editableGatewayFields: document.querySelectorAll('input[name="settings-llm-provider"], input[name="settings-llm-base-url"]').length,
      openGatewayAction: Boolean([...document.querySelectorAll('.settings-llm-connection button')].find((item) => item.textContent.trim() === '查看服务')),
      modelUsesSelect: Boolean(document.querySelector('[aria-label="AI 模型"][role="combobox"]')),
      modelActions: [...document.querySelectorAll('.settings-llm-model-row button')].map((item) => item.textContent.trim()),
    }))()`);
    assert.equal(editableConnection.cardLabel, '外部 AI 服务连接');
    assert.match(editableConnection.cardText, /服务商标识[\s\S]*HTTPS API 根地址/);
    assert.deepEqual({
      editableGatewayFields: editableConnection.editableGatewayFields,
      openGatewayAction: editableConnection.openGatewayAction,
      modelUsesSelect: editableConnection.modelUsesSelect,
      modelActions: editableConnection.modelActions,
    }, {
      editableGatewayFields: 2,
      openGatewayAction: false,
      modelUsesSelect: true,
      modelActions: ['刷新列表', '测试并使用'],
    }, 'W4 external AI settings must expose a editable HTTPS connection form and contextual model actions');
    const gatewayEvidence = {};
    for (const [label, width, height] of [
      ['1280x800', 1280, 800],
      ['1024x768', 1024, 768],
    ]) {
      win.setSize(width, height);
      await delay(180);
      await win.webContents.executeJavaScript(`document.querySelector('.settings-admin-config')?.scrollIntoView({ block: 'start' })`);
      await delay(120);
      const layout = await getSurfaceLayout(win, '.settings-panel');
      const outerSize = win.getSize();
      const contentSize = win.getContentSize();
      assert.deepEqual(outerSize, [width, height], `native AI settings outer window must reach ${label}`);
      assert.deepEqual(layout.cssViewport, contentSize, `AI settings renderer viewport must match native content size at ${label}`);
      assert.ok(layout.document.overflow <= 1 && layout.workspace.overflow <= 1 && layout.surface.overflow <= 1,
        `editable HTTPS settings must not overflow horizontally at ${label}`);
      const fieldsVisible = await win.webContents.executeJavaScript(`(() => {
        const selectors = [
          '.settings-llm-connection',
          'input[name="settings-llm-api-key"]',
          '[aria-label="AI 模型"][role="combobox"]',
          '.settings-llm-model-row',
        ];
        return selectors.every((selector) => {
          const element = document.querySelector(selector);
          const rect = element?.getBoundingClientRect();
          return Boolean(rect && rect.width > 0 && rect.top < innerHeight && rect.bottom > 0);
        });
      })()`);
      assert.equal(fieldsVisible, true, `gateway, Key and model action context must remain visible at ${label}`);
      gatewayEvidence[label] = {
        outerSize,
        contentSize,
        layout,
        screenshot: await captureEvidence(win, `w4-settings-https-configurable-${label}`),
      };
    }
    win.setSize(1100, 720);
    win.setMinimumSize(1, 1);
    await delay(180);
    const desktopDraftValue = 'synthetic-desktop-draft-key';
    const desktopDraftChanged = await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('input[name="settings-llm-api-key"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!input || !setter) return false;
      setter.call(input, ${JSON.stringify('synthetic-desktop-draft-key')});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      return true;
    })()`);
    assert.equal(desktopDraftChanged, true, 'W4 must create an unsaved external AI credential draft through the real password field');
    await waitFor(win,
      `document.querySelector('input[name="settings-llm-api-key"]')?.value === ${JSON.stringify('synthetic-desktop-draft-key')}`,
      'W4 external AI desktop credential draft value');

    await clickDesktopUtilityItem(win, '关于招才官');
    await waitFor(win, "Boolean(document.querySelector('#settings-advanced'))", 'W4 internal About settings section');
    await waitFor(win, "document.activeElement?.id === 'settings-about-title'", 'W4 About title focus');
    const internalAbout = await win.webContents.executeJavaScript(`(() => ({
      activeNav: document.querySelector('.app-nav-footer-main[data-active="true"]')?.getAttribute('data-active-nav') || '',
      hash: location.hash,
      modalVisible: [...document.querySelectorAll('.settings-unsaved-switch-modal')]
        .some((element) => element.getClientRects().length > 0 && getComputedStyle(element).display !== 'none'),
      section: document.querySelector('.settings-panel-view')?.id || '',
      headingFocused: document.activeElement?.id === 'settings-about-title',
    }))()`);
    assert.deepEqual(internalAbout, {
      activeNav: '设置',
      hash: '#settings-advanced',
      modalVisible: false,
      section: 'settings-advanced',
      headingFocused: true,
    }, 'Settings-owned About navigation must remain internal and must not prompt');
    const internalAboutEvidence = await captureEvidence(win, 'w4-settings-unsaved-internal-about-1100x720');

    await clickExactText(win, '.settings-section-nav button', 'AI 与外部连接');
    await waitFor(win,
      `document.querySelector('input[name="settings-llm-api-key"]')?.value === ${JSON.stringify('synthetic-desktop-draft-key')}`,
      'W4 draft retained after internal About navigation');
    await clickDesktopGuide(win);
    await waitFor(win,
      "[...document.querySelectorAll('.settings-unsaved-switch-modal')].some((element) => element.getClientRects().length > 0 && getComputedStyle(element).display !== 'none')",
      'W4 desktop Guide unsaved-draft guard');
    const desktopPrompt = await win.webContents.executeJavaScript(`(() => ({
      title: (document.querySelector('.settings-unsaved-switch-modal .ant-modal-title')?.textContent || '').trim(),
      activeNav: document.querySelector('.app-nav-footer-main[data-active="true"]')?.getAttribute('data-active-nav') || '',
      hash: location.hash,
      draft: document.querySelector('input[name="settings-llm-api-key"]')?.value || '',
    }))()`);
    assert.deepEqual(desktopPrompt, {
      title: '设置有未保存修改',
      activeNav: '设置',
      hash: '#settings-integrations',
      draft: desktopDraftValue,
    }, 'desktop Guide navigation must pause on the unsaved external AI draft');
    const desktopPromptEvidence = await captureEvidence(win, 'w4-settings-unsaved-desktop-guide-1100x720');
    await clickExactText(win, '.settings-unsaved-switch-modal button', '留在本页');
    await waitFor(win,
      "![...document.querySelectorAll('.settings-unsaved-switch-modal')].some((element) => element.getClientRects().length > 0 && getComputedStyle(element).display !== 'none')",
      'W4 desktop Guide guard cancellation');
    await waitFor(win,
      "document.activeElement?.matches('.app-nav-footer-main[aria-label=\"打开设置与帮助菜单\"]')",
      'W4 desktop Guide trigger focus restoration');
    const desktopStay = await win.webContents.executeJavaScript(`(() => ({
      activeNav: document.querySelector('.app-nav-footer-main[data-active="true"]')?.getAttribute('data-active-nav') || '',
      hash: location.hash,
      focusedTrigger: (document.activeElement?.textContent || '').trim(),
      draft: document.querySelector('input[name="settings-llm-api-key"]')?.value || '',
    }))()`);
    assert.deepEqual(desktopStay, {
      activeNav: '设置',
      hash: '#settings-integrations',
      focusedTrigger: '设置与帮助',
      draft: desktopDraftValue,
    }, 'cancelling desktop Guide navigation must retain Settings, draft, and trigger focus');

    await clickDesktopGuide(win);
    await waitFor(win,
      "[...document.querySelectorAll('.settings-unsaved-switch-modal')].some((element) => element.getClientRects().length > 0 && getComputedStyle(element).display !== 'none')",
      'W4 desktop Guide guard confirmation');
    await clickExactText(win, '.settings-unsaved-switch-modal button', '放弃草稿并离开');
    await waitFor(win, "Boolean(document.querySelector('.workflow-guide-page'))", 'W4 confirmed desktop Guide navigation');
    const desktopLeave = await win.webContents.executeJavaScript(`(() => ({
      activeNav: document.querySelector('.app-nav-footer-main[data-active="true"]')?.getAttribute('data-active-nav') || '',
      guideVisible: Boolean(document.querySelector('.workflow-guide-page')),
      settingsVisible: Boolean(document.querySelector('.settings-panel')),
    }))()`);
    assert.deepEqual(desktopLeave, {
      activeNav: '使用指南',
      guideVisible: true,
      settingsVisible: false,
    }, 'confirming draft discard must continue to Guide');

    await clickDesktopUtilityItem(win, '设置中心');
    await waitFor(win, "Boolean(document.querySelector('.settings-panel'))", 'W4 mobile guard settings re-entry');
    await waitFor(win, "Boolean(document.querySelector('#settings-overview'))", 'W4 Settings Center overview re-entry');
    await waitFor(win, "document.activeElement?.id === 'settings-overview-title'", 'W4 overview re-entry title focus');
    await clickExactText(win, '.settings-section-nav button', 'AI 与外部连接');
    await waitFor(win, "Boolean(document.querySelector('#settings-integrations'))", 'W4 mobile guard integrations section');
    await waitFor(win, "document.activeElement?.id === 'settings-integrations-title'", 'W4 same-section title focus');
    await clickExactText(win, '.settings-admin-config > summary', '高级设置：服务地址、访问密钥与模型');
    await waitFor(win,
      "Boolean(document.querySelector('input[name=\"settings-llm-api-key\"]')) && !document.querySelector('input[name=\"settings-llm-api-key\"]').disabled",
      'W4 editable mobile external AI credential draft');
    const mobileDraftValue = 'synthetic-mobile-draft-key';
    const mobileDraftChanged = await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('input[name="settings-llm-api-key"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!input || !setter) return false;
      setter.call(input, ${JSON.stringify('synthetic-mobile-draft-key')});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      return true;
    })()`);
    assert.equal(mobileDraftChanged, true, 'W4 must create a second unsaved draft for mobile navigation');
    await waitFor(win,
      `document.querySelector('input[name="settings-llm-api-key"]')?.value === ${JSON.stringify('synthetic-mobile-draft-key')}`,
      'W4 external AI mobile draft value');
    win.setContentSize(740, 720);
    await delay(180);
    await waitFor(win,
      "Boolean(document.querySelector('.mobile-module-field select[aria-label=\"\u5207\u6362\u6a21\u5757\"]')?.offsetParent)",
      'W4 mobile module selector');
    const mobileGuideSelected = await win.webContents.executeJavaScript(`(() => {
      const select = document.querySelector('.mobile-module-field select[aria-label="切换模块"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      if (!select || !setter) return false;
      select.focus();
      setter.call(select, '使用指南');
      select.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    assert.equal(mobileGuideSelected, true, 'W4 must exercise the real mobile module selector');
    await waitFor(win,
      "[...document.querySelectorAll('.settings-unsaved-switch-modal')].some((element) => element.getClientRects().length > 0 && getComputedStyle(element).display !== 'none')",
      'W4 mobile Guide unsaved-draft guard');
    const mobilePrompt = await win.webContents.executeJavaScript(`(() => ({
      title: (document.querySelector('.settings-unsaved-switch-modal .ant-modal-title')?.textContent || '').trim(),
      activeNav: document.querySelector('.app-nav-footer-main[data-active="true"]')?.getAttribute('data-active-nav') || '',
      selectedModule: document.querySelector('.mobile-module-field select')?.value || '',
      hash: location.hash,
      draft: document.querySelector('input[name="settings-llm-api-key"]')?.value || '',
    }))()`);
    assert.deepEqual(mobilePrompt, {
      title: '设置有未保存修改',
      activeNav: '设置',
      selectedModule: '设置',
      hash: '#settings-integrations',
      draft: mobileDraftValue,
    }, 'mobile Guide navigation must pause without changing the active module or draft');
    const mobilePromptEvidence = await captureEvidence(win, 'w4-settings-unsaved-mobile-guide-740x720');
    await clickExactText(win, '.settings-unsaved-switch-modal button', '留在本页');
    await waitFor(win,
      "![...document.querySelectorAll('.settings-unsaved-switch-modal')].some((element) => element.getClientRects().length > 0 && getComputedStyle(element).display !== 'none')",
      'W4 mobile Guide guard cancellation');
    await waitFor(win,
      "document.activeElement === document.querySelector('.mobile-module-field select')",
      'W4 mobile Guide trigger focus restoration');
    const mobileStay = await win.webContents.executeJavaScript(`(() => ({
      selectedModule: document.querySelector('.mobile-module-field select')?.value || '',
      focused: document.activeElement === document.querySelector('.mobile-module-field select'),
      draft: document.querySelector('input[name="settings-llm-api-key"]')?.value || '',
    }))()`);
    assert.deepEqual(mobileStay, {
      selectedModule: '设置',
      focused: true,
      draft: mobileDraftValue,
    }, 'cancelling mobile Guide navigation must retain Settings, draft, and selector focus');
    assert.deepEqual(errors, [], 'W4 settings renderer must not emit console errors');
    return {
      desktop: { ...desktop, evidence: desktopEvidence },
      windows125: { ...windows125, evidence: windows125Evidence },
      compact: { initial: compactInitial, diagnostics: diagnosticsDefault, evidence: compactEvidence },
      local_tasks: { ...localTasks, evidence: localTaskEvidence },
      connections: { evidence: connectionsEvidence },
      configurable_https_gateway: { ...editableConnection, evidence: gatewayEvidence },
      unsaved_navigation: {
        internal_about: { ...internalAbout, draftRetained: desktopDraftValue, evidence: internalAboutEvidence },
        desktop_guide: { prompt: desktopPrompt, stay: desktopStay, leave: desktopLeave, evidence: desktopPromptEvidence },
        mobile_guide: { prompt: mobilePrompt, stay: mobileStay, evidence: mobilePromptEvidence },
      },
    };
  } finally {
    win.destroy();
  }
}

async function verifyW4Assessment() {
  const { win, errors } = createW4Window();
  try {
    await win.loadFile(path.join(distRoot, 'index.html'));
    win.webContents.setZoomFactor(1);
    await delay(80);
    await win.webContents.executeJavaScript(`(() => {
      const originalCreate = URL.createObjectURL.bind(URL);
      const originalRevoke = URL.revokeObjectURL.bind(URL);
      const active = new Set();
      const tracker = {
        created: [],
        revoked: [],
        reset() { active.clear(); this.created.length = 0; this.revoked.length = 0; },
        snapshot() { return { activeCount: active.size, createdCount: this.created.length, revokedCount: this.revoked.length }; },
      };
      URL.createObjectURL = (blob) => {
        const next = originalCreate(blob);
        active.add(next);
        tracker.created.push(next);
        return next;
      };
      URL.revokeObjectURL = (url) => {
        active.delete(url);
        tracker.revoked.push(url);
        return originalRevoke(url);
      };
      window.__w4BlobTracker = tracker;
    })()`);
    await waitFor(win, "document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent.includes('合成岗位')", 'W4 assessment job context');
    await clickExactText(win, 'button.nav-item', '候选人');
    await waitFor(win, "document.querySelector('.candidate-card')", 'W4 assessment candidate list');
    const selected = await win.webContents.executeJavaScript(`(() => {
      const candidate = [...document.querySelectorAll('.candidate-card')]
        .find((card) => (card.getAttribute('aria-label') || '').startsWith('合成候选人 · 超长中文名称'));
      candidate?.click();
      return Boolean(candidate);
    })()`);
    assert.equal(selected, true);
    await waitFor(win, "document.querySelector('.candidate-card[aria-selected=\"true\"]')?.getAttribute('aria-label')?.startsWith('合成候选人 · 超长中文名称')", 'W4 assessment candidate selection');
    await clickTextContaining(win, '.candidate-domain-tab-option', '测评');
    await waitFor(win, "Boolean(document.querySelector('.assessment-archive-panel') && [...document.querySelectorAll('.assessment-archive-panel button')].some((button) => button.textContent.trim() === '查看 PNG 预览'))", 'W4 assessment archive');

    await clickExactText(win, '.assessment-archive-panel button', '批量导入 PDF');
    await waitFor(win, "[...document.querySelectorAll('.ant-modal-title')].some((title) => title.textContent.trim() === '批量导入 PDF 测评报告' && title.closest('.ant-modal')?.offsetParent !== null)", 'W4 assessment import modal');
    await clickExactText(win, '.ant-modal button', '选择 PDF（可多选）并导入');
    await waitFor(win, "[...document.querySelectorAll('.ant-modal button')].some((button) => button.textContent.trim() === '选择 PDF（可多选）并导入' && button.classList.contains('ant-btn-loading'))", 'W4 assessment import busy');
    const busyBefore = await win.webContents.executeJavaScript(`(async () => {
      const title = [...document.querySelectorAll('.ant-modal-title')].find((item) => item.textContent.trim() === '批量导入 PDF 测评报告');
      const modal = title?.closest('.ant-modal');
      const runtime = await window.runtimeInfo.get();
      return {
        visible: Boolean(modal?.offsetParent),
        cancelDisabled: [...(modal?.querySelectorAll('button') || [])].find((button) => button.textContent.trim() === '取消')?.disabled === true,
        closeButtonCount: modal?.querySelectorAll('.ant-modal-close').length || 0,
        importCalls: runtime.w4AssessmentImportCalls,
      };
    })()`);
    assert.deepEqual(busyBefore, { visible: true, cancelDisabled: true, closeButtonCount: 0, importCalls: 1 });
    const busyEvidence = await captureEvidence(win, 'w4-assessment-import-busy-1100x720');

    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await win.webContents.executeJavaScript(`(() => {
      const title = [...document.querySelectorAll('.ant-modal-title')].find((item) => item.textContent.trim() === '批量导入 PDF 测评报告');
      const modal = title?.closest('.ant-modal');
      modal?.closest('.ant-modal-root')?.querySelector('.ant-modal-mask')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      [...(modal?.querySelectorAll('button') || [])].find((button) => button.textContent.trim() === '取消')?.click();
    })()`);
    await delay(120);
    const locked = await win.webContents.executeJavaScript(`(async () => {
      const title = [...document.querySelectorAll('.ant-modal-title')].find((item) => item.textContent.trim() === '批量导入 PDF 测评报告');
      const modal = title?.closest('.ant-modal');
      const runtime = await window.runtimeInfo.get();
      return { visible: Boolean(modal?.offsetParent), importCalls: runtime.w4AssessmentImportCalls };
    })()`);
    assert.deepEqual(locked, { visible: true, importCalls: 1 }, 'busy import must ignore Escape, mask and disabled close attempts without duplicate selection');
    await waitFor(win, "[...document.querySelectorAll('.ant-modal button')].some((button) => button.textContent.trim() === '选择 PDF（可多选）并导入' && !button.classList.contains('ant-btn-loading'))", 'W4 assessment import cancellation return');
    await clickExactText(win, '.ant-modal button', '取消');
    await waitFor(win, "![...document.querySelectorAll('.ant-modal-title')].some((title) => title.textContent.trim() === '批量导入 PDF 测评报告' && title.closest('.ant-modal')?.offsetParent !== null)", 'W4 assessment import modal close');

    await win.webContents.executeJavaScript('window.__w4BlobTracker.reset()');
    await clickExactText(win, '.assessment-archive-panel button', '查看 PNG 预览');
    await waitFor(win, "Boolean(document.querySelector('img[alt=\"PDF 测评第 1 页栅格预览\"]'))", 'W4 assessment preview page one');
    const previewPageOne = await win.webContents.executeJavaScript(`(async () => {
      const runtime = await window.runtimeInfo.get();
      return { ...window.__w4BlobTracker.snapshot(), page1Reads: runtime.w4PreviewPage1Reads, page2Reads: runtime.w4PreviewPage2Reads };
    })()`);
    assert.deepEqual(previewPageOne, { activeCount: 1, createdCount: 1, revokedCount: 0, page1Reads: 1, page2Reads: 0 });
    const previewPageOneEvidence = await captureEvidence(win, 'w4-assessment-preview-page1-1100x720');
    await clickExactText(win, '.ant-modal button', '下一页');
    await delay(100);
    const pageTwoStarted = await win.webContents.executeJavaScript('(async () => (await window.runtimeInfo.get()).w4PreviewPage2Reads)()');
    assert.equal(pageTwoStarted, 1, 'page two preview request must start before immediate close');
    const previewClosed = await win.webContents.executeJavaScript(`(() => {
      const title = [...document.querySelectorAll('.ant-modal-title')].find((item) => item.textContent.trim() === 'PDF 测评 PNG 预览');
      const modal = title?.closest('.ant-modal');
      modal?.querySelector('.ant-modal-close')?.click();
      return Boolean(modal);
    })()`);
    assert.equal(previewClosed, true);
    await waitFor(win, "![...document.querySelectorAll('.ant-modal-title')].some((title) => title.textContent.trim() === 'PDF 测评 PNG 预览' && title.closest('.ant-modal')?.offsetParent !== null)", 'W4 assessment preview immediate close');
    await delay(850);
    const latePreview = await win.webContents.executeJavaScript(`(async () => {
      const runtime = await window.runtimeInfo.get();
      const previewImages = [...document.querySelectorAll('img[alt^="PDF 测评第"]')];
      const lateUrl = window.__w4BlobTracker.created[1] || '';
      return {
        ...window.__w4BlobTracker.snapshot(),
        page1Reads: runtime.w4PreviewPage1Reads,
        page2Reads: runtime.w4PreviewPage2Reads,
        visibleModal: [...document.querySelectorAll('.ant-modal-title')].some((title) => title.textContent.trim() === 'PDF 测评 PNG 预览' && title.closest('.ant-modal')?.offsetParent !== null),
        retainedPageOneImageCount: previewImages.filter((image) => image.alt === 'PDF 测评第 1 页栅格预览').length,
        pageTwoImageCount: previewImages.filter((image) => image.alt === 'PDF 测评第 2 页栅格预览').length,
        visiblePreviewImageCount: previewImages.filter((image) => image.offsetParent !== null).length,
        lateUrlWrittenToImage: Boolean(lateUrl && previewImages.some((image) => image.src === lateUrl)),
        pageTwoTextCount: [...document.querySelectorAll('.ant-modal')].filter((modal) => (modal.textContent || '').includes('2 / 2')).length,
      };
    })()`);
    assert.deepEqual(latePreview, {
      activeCount: 0,
      createdCount: 2,
      revokedCount: 2,
      page1Reads: 1,
      page2Reads: 1,
      visibleModal: false,
      retainedPageOneImageCount: 1,
      pageTwoImageCount: 0,
      visiblePreviewImageCount: 0,
      lateUrlWrittenToImage: false,
      pageTwoTextCount: 0,
    }, 'late page two URL must be revoked without reopening or writing hidden preview state');
    const latePreviewEvidence = await captureEvidence(win, 'w4-assessment-preview-late-close-1100x720');
    assert.deepEqual(errors, [], 'W4 assessment renderer must not emit console errors');
    return {
      import_busy: { ...busyBefore, locked, evidence: busyEvidence },
      preview_page_one: { ...previewPageOne, evidence: previewPageOneEvidence },
      preview_late_close: { ...latePreview, evidence: latePreviewEvidence },
    };
  } finally {
    win.destroy();
  }
}

async function verifyW4Ledger() {
  const { win, errors } = createW4Window();
  try {
    await win.loadFile(path.join(distRoot, 'index.html'));
    win.webContents.setZoomFactor(1);
    // 1720 sits above the 1679px card boundary: the table needs scroll.x
    // 1680+ before all data columns can exist, so this is the narrowest
    // window class that legitimately shows the table at all.
    win.setContentSize(1720, 900);
    await delay(180);
    await waitFor(win, "document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent.includes('合成岗位')", 'W4 ledger job context');
    await clickExactText(win, 'button.nav-item', '职位管理');
    await waitFor(win, "document.querySelector('.job-ledger-page')", 'W4 job ledger');
    const wide = await win.webContents.executeJavaScript(`(() => {
      const table = document.querySelector('.job-ledger-table-card');
      const cards = document.querySelector('.job-ledger-compact-list');
      return {
        viewport: [innerWidth, innerHeight],
        tableVisible: Boolean(table?.offsetParent),
        cardListVisible: Boolean(cards?.offsetParent),
        tableRows: table?.querySelectorAll('tbody tr.ant-table-row').length || 0,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    assert.deepEqual(wide, { viewport: [1720, 900], tableVisible: true, cardListVisible: false, tableRows: 2, documentOverflow: 0 },
      'wide ledger must retain its table without document overflow');
    const wideEvidence = await captureEvidence(win, 'w4-ledger-table-1720x900');

    win.setContentSize(1100, 720);
    win.webContents.setZoomFactor(1);
    await delay(180);
    const compact = await win.webContents.executeJavaScript(`(() => {
      const visible = (element) => Boolean(element?.offsetParent);
      const cards = [...document.querySelectorAll('.job-ledger-compact-item')].filter(visible);
      const filter = document.querySelector('input[aria-label="搜索岗位"]');
      const more = cards[0] ? [...cards[0].querySelectorAll('button')].find((button) => button.textContent.trim() === '更多') : null;
      const open = cards[0]?.querySelector('.job-ledger-open-link');
      return {
        viewport: [innerWidth, innerHeight],
        tableVisible: visible(document.querySelector('.job-ledger-table-card')),
        cardCount: cards.length,
        filterReachable: Boolean(filter && !filter.disabled),
        openReachable: Boolean(open && !open.disabled),
        moreReachable: Boolean(more && !more.disabled),
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    assert.deepEqual(compact, {
      viewport: [1100, 720],
      tableVisible: false,
      cardCount: 2,
      filterReachable: true,
      openReachable: true,
      moreReachable: true,
      documentOverflow: 0,
    }, '1100px ledger must expose readable cards and reachable controls');
    await win.webContents.executeJavaScript("document.querySelector('input[aria-label=\"搜索岗位\"]')?.focus()");
    await win.webContents.insertText('第二业务线');
    await waitFor(win, "[...document.querySelectorAll('.job-ledger-compact-item')].filter((item) => item.offsetParent !== null).length === 1", 'W4 ledger filtered card');
    await clickExactText(win, '.job-ledger-compact-item button', '更多');
    await waitFor(win, "[...document.querySelectorAll('.ant-dropdown-menu')].some((menu) => menu.offsetParent !== null && (menu.textContent || '').includes('编辑岗位信息'))", 'W4 ledger more menu');
    const filtered = await win.webContents.executeJavaScript(`(() => {
      const cards = [...document.querySelectorAll('.job-ledger-compact-item')].filter((item) => item.offsetParent !== null);
      const menu = [...document.querySelectorAll('.ant-dropdown-menu')].find((item) => item.offsetParent !== null);
      return {
        cardCount: cards.length,
        cardText: (cards[0]?.textContent || '').trim(),
        menuLabels: [...(menu?.querySelectorAll('[role="menuitem"]') || [])].map((item) => item.textContent.trim()),
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    assert.equal(filtered.cardCount, 1);
    assert.match(filtered.cardText, /第二业务线/);
    assert.ok(filtered.menuLabels.includes('编辑岗位信息') && filtered.menuLabels.includes('复制岗位'));
    assert.ok(filtered.documentOverflow <= 1);
    const compactEvidence = await captureEvidence(win, 'w4-ledger-cards-filter-menu-1100x720');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor(win, "![...document.querySelectorAll('.ant-dropdown-menu')].some((menu) => menu.offsetParent !== null)", 'W4 ledger more menu close');

    win.setContentSize(1360, 768);
    win.webContents.setZoomFactor(1.25);
    await delay(180);
    const windows125 = await win.webContents.executeJavaScript(`(() => {
      const visible = (element) => Boolean(element?.offsetParent);
      const cards = [...document.querySelectorAll('.job-ledger-compact-item')].filter(visible);
      return {
        viewport: [innerWidth, innerHeight],
        tableVisible: visible(document.querySelector('.job-ledger-table-card')),
        cardCount: cards.length,
        openReachable: Boolean(cards[0]?.querySelector('.job-ledger-open-link:not(:disabled)')),
        moreReachable: Boolean([...cards[0].querySelectorAll('button')].find((button) => button.textContent.trim() === '更多' && !button.disabled)),
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    assert.deepEqual(windows125, {
      viewport: [1088, 614],
      tableVisible: false,
      cardCount: 1,
      openReachable: true,
      moreReachable: true,
      documentOverflow: 0,
    }, 'Windows 125% ledger must retain the filtered card and reachable actions');
    const windows125Evidence = await captureEvidence(win, 'w4-ledger-cards-1360x768-windows125');
    await clickExactText(win, '.job-ledger-compact-item .job-ledger-open-link', '合成岗位 · 第二业务线运营负责人长名称回归');
    await waitFor(win, "[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '返回岗位台账')", 'W4 ledger open job');
    const openEvidence = await captureEvidence(win, 'w4-ledger-open-job-1360x768-windows125');
    assert.deepEqual(errors, [], 'W4 ledger renderer must not emit console errors');
    return {
      wide: { ...wide, evidence: wideEvidence },
      compact: { ...compact, filtered, evidence: compactEvidence },
      windows125: { ...windows125, evidence: windows125Evidence },
      open: { job: '合成岗位 · 第二业务线运营负责人长名称回归', evidence: openEvidence },
    };
  } finally {
    win.destroy();
  }
}

async function verifyW4BIdleRecovery() {
  const { win, errors } = createW4BWindow('idle-recovery');
  try {
    await loadAndOpenW4BDeepProfile(win);
    const initialRuntime = await readW4BRuntime(win);
    assert.deepEqual({
      progressGets: initialRuntime.w4b.progressGets,
      preflightGets: initialRuntime.w4b.preflightGets,
      approvalCalls: initialRuntime.w4b.approvalCalls,
      generatePosts: initialRuntime.w4b.generatePosts,
      taskStarts: initialRuntime.w4b.taskStarts,
      externalTransportCalls: initialRuntime.w4b.externalTransportCalls,
    }, {
      progressGets: 1,
      preflightGets: 0,
      approvalCalls: 0,
      generatePosts: 0,
      taskStarts: 0,
      externalTransportCalls: 0,
    }, 'W4-B idle open must only inspect existing progress and local history');

    await clickRegenerateDeepProfile(win);
    await waitFor(win,
      "document.querySelector('#deep-profile-generation-progress')?.textContent.includes('已恢复当前岗位正在生成的画像')",
      'W4-B explicit generation running state');
    const startedRuntime = await waitForW4BRuntime(win,
      (w4b) => w4b.approvalCalls === 1 && w4b.generatePosts === 1 && w4b.taskStarts === 1,
      'W4-B explicit generation counters');
    assert.deepEqual({
      progressGets: startedRuntime.w4b.progressGets,
      preflightGets: startedRuntime.w4b.preflightGets,
      approvalCalls: startedRuntime.w4b.approvalCalls,
      generatePosts: startedRuntime.w4b.generatePosts,
      taskStarts: startedRuntime.w4b.taskStarts,
      externalTransportCalls: startedRuntime.w4b.externalTransportCalls,
    }, {
      progressGets: 2,
      preflightGets: 1,
      approvalCalls: 1,
      generatePosts: 1,
      taskStarts: 1,
      externalTransportCalls: 0,
    }, 'W4-B explicit idle generation must preflight once, approve once, and POST once');
    assert.deepEqual({
      purpose: startedRuntime.w4b.lastApproval?.purpose,
      targetId: startedRuntime.w4b.lastApproval?.targetId,
      materialJobId: startedRuntime.w4b.lastApproval?.materialJobId,
      generatedJobId: startedRuntime.w4b.lastGenerate?.jobId,
      userApprovalPresent: startedRuntime.w4b.lastGenerate?.userApprovalPresent,
      requestIdsMatch: startedRuntime.w4b.lastApproval?.requestId === startedRuntime.w4b.lastGenerate?.requestId,
      requestIdPresent: Boolean(startedRuntime.w4b.lastApproval?.requestId),
    }, {
      purpose: 'deep-profile',
      targetId: '9901',
      materialJobId: 9901,
      generatedJobId: 9901,
      userApprovalPresent: true,
      requestIdsMatch: true,
      requestIdPresent: true,
    }, 'W4-B native approval and local generate request must bind to the current job and request');
    const runningEvidence = await captureEvidence(win, 'w4b-idle-running-1100x720');

    const inFlightRuntime = await waitForW4BRuntime(win,
      (w4b) => w4b.postStartProgressGets === 1,
      'W4-B delayed running progress GET',
      6000);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor(win, "!document.querySelector('.deep-profile-modal-introduction')", 'W4-B close during running');
    const progressGetsAtClose = inFlightRuntime.w4b.progressGets;
    await delay(2700);
    const afterLateClose = await readW4BRuntime(win);
    const lateCloseState = await win.webContents.executeJavaScript(`(() => ({
      modalVisible: Boolean(document.querySelector('.deep-profile-modal-introduction')),
      activeJob: (document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent || '').trim(),
      editorVisible: Boolean(document.querySelector('.job-module-action-strip')),
    }))()`);
    assert.equal(afterLateClose.w4b.progressGets, progressGetsAtClose,
      'closed W4-B component must not issue another progress GET after a late response and one poll interval');
    assert.deepEqual(lateCloseState, {
      modalVisible: false,
      activeJob: '合成岗位 · 运行态视觉门禁',
      editorVisible: true,
    }, 'late progress must not reopen or pollute the current job editor after close');
    const lateCloseEvidence = await captureEvidence(win, 'w4b-idle-late-close-1100x720');

    await reopenW4BDeepProfile(win);
    await waitFor(win,
      "document.querySelector('#deep-profile-generation-progress')?.textContent.includes('已恢复当前岗位正在生成的画像')",
      'W4-B reopen adopts running generation');
    const adoptedRuntime = await readW4BRuntime(win);
    assert.deepEqual({
      jobProgressGets: adoptedRuntime.w4b.progressByJob['9901'],
      approvalCalls: adoptedRuntime.w4b.approvalCalls,
      generatePosts: adoptedRuntime.w4b.generatePosts,
      taskStarts: adoptedRuntime.w4b.taskStarts,
    }, {
      jobProgressGets: 4,
      approvalCalls: 1,
      generatePosts: 1,
      taskStarts: 1,
    }, 'reopen must adopt the same job generation without another approval, POST, or task start');
    await waitFor(win,
      "document.body.textContent.includes('W4-B 新版画像已从同一生成任务自动接管并读取')",
      'W4-B recovered latest profile',
      7000);
    const finalRuntime = await readW4BRuntime(win);
    const recoveredState = await win.webContents.executeJavaScript(`(() => ({
      latestProfileVisible: document.body.textContent.includes('W4-B 新版画像已从同一生成任务自动接管并读取'),
      versionVisible: document.body.textContent.includes('画像 v4'),
      runningAlertVisible: Boolean(document.querySelector('#deep-profile-generation-progress')),
    }))()`);
    assert.deepEqual(recoveredState, {
      latestProfileVisible: true,
      versionVisible: true,
      runningAlertVisible: false,
    }, 'done recovery must replace history with the latest profile');
    assert.deepEqual({
      progressGets: finalRuntime.w4b.progressGets,
      progressByJob: finalRuntime.w4b.progressByJob,
      preflightGets: finalRuntime.w4b.preflightGets,
      approvalCalls: finalRuntime.w4b.approvalCalls,
      generatePosts: finalRuntime.w4b.generatePosts,
      taskStarts: finalRuntime.w4b.taskStarts,
      externalTransportCalls: finalRuntime.w4b.externalTransportCalls,
    }, {
      progressGets: 5,
      progressByJob: { 9901: 5 },
      preflightGets: 1,
      approvalCalls: 1,
      generatePosts: 1,
      taskStarts: 1,
      externalTransportCalls: 0,
    }, 'W4-B same-job recovery must finish without duplicate authorization or generation');
    const recoveredEvidence = await captureEvidence(win, 'w4b-idle-recovered-done-1100x720');
    assert.deepEqual(errors, [], 'W4-B idle recovery renderer must not emit console errors');
    return {
      initial_calls: initialRuntime.w4b,
      explicit_start_calls: startedRuntime.w4b,
      late_close: { progressGetsAtClose, progressGetsAfterWait: afterLateClose.w4b.progressGets, ...lateCloseState },
      adopted_calls: adoptedRuntime.w4b,
      final_calls: finalRuntime.w4b,
      recovered_state: recoveredState,
      evidence: { running: runningEvidence, late_close: lateCloseEvidence, recovered: recoveredEvidence },
    };
  } finally {
    win.destroy();
  }
}

async function verifyW4BSeededDone() {
  const { win, errors } = createW4BWindow('seeded-done');
  try {
    await loadAndOpenW4BDeepProfile(win);
    const state = await win.webContents.executeJavaScript(`(() => ({
      latestProfileVisible: document.body.textContent.includes('W4-B 新版画像已从同一生成任务自动接管并读取'),
      versionVisible: document.body.textContent.includes('画像 v4'),
    }))()`);
    assert.deepEqual(state, { latestProfileVisible: true, versionVisible: true },
      'seeded done must automatically reload the latest local profile');
    const runtime = await readW4BRuntime(win);
    assert.deepEqual({
      progressGets: runtime.w4b.progressGets,
      profileGets: runtime.w4b.profileGets,
      approvalCalls: runtime.w4b.approvalCalls,
      generatePosts: runtime.w4b.generatePosts,
      taskStarts: runtime.w4b.taskStarts,
      externalTransportCalls: runtime.w4b.externalTransportCalls,
    }, {
      progressGets: 1,
      profileGets: 1,
      approvalCalls: 0,
      generatePosts: 0,
      taskStarts: 0,
      externalTransportCalls: 0,
    }, 'seeded done recovery must remain read-only and local');
    const evidence = await captureEvidence(win, 'w4b-seeded-done-1100x720');
    assert.deepEqual(errors, [], 'W4-B seeded done renderer must not emit console errors');
    return { state, calls: runtime.w4b, evidence };
  } finally {
    win.destroy();
  }
}

async function verifyW4BSeededError() {
  const { win, errors } = createW4BWindow('seeded-error');
  try {
    await loadAndOpenW4BDeepProfile(win);
    await waitFor(win,
      "document.body.textContent.includes('上次深度画像生成未完成')",
      'W4-B seeded error recovery');
    const beforeWait = await readW4BRuntime(win);
    await delay(2200);
    const afterWait = await readW4BRuntime(win);
    const state = await win.webContents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('[role=dialog] button')]
        .find((element) => element.textContent.trim() === '重新确认并生成');
      const body = document.querySelector('[role=dialog]')?.textContent || '';
      return {
        historyVisible: body.includes('W4-B 旧版历史画像'),
        persistentRecoveryCopy: body.includes('不会自动重放材料或外部调用') && body.includes('重新确认并生成'),
        recoveryButtonVisible: Boolean(button),
        recoveryButtonDisabled: Boolean(button?.disabled),
      };
    })()`);
    assert.deepEqual(state, {
      historyVisible: true,
      persistentRecoveryCopy: true,
      recoveryButtonVisible: true,
      recoveryButtonDisabled: false,
    }, 'open-job seeded error must retain history and expose only explicit recovery');
    assert.deepEqual({
      progressBefore: beforeWait.w4b.progressGets,
      progressAfter: afterWait.w4b.progressGets,
      approvalCalls: afterWait.w4b.approvalCalls,
      generatePosts: afterWait.w4b.generatePosts,
      taskStarts: afterWait.w4b.taskStarts,
      externalTransportCalls: afterWait.w4b.externalTransportCalls,
    }, {
      progressBefore: 1,
      progressAfter: 1,
      approvalCalls: 0,
      generatePosts: 0,
      taskStarts: 0,
      externalTransportCalls: 0,
    }, 'seeded error must remain stable without automatic polling or replay');
    const evidence = await captureEvidence(win, 'w4b-seeded-error-1100x720');
    assert.deepEqual(errors, [], 'W4-B seeded error renderer must not emit console errors');
    return { state, calls: afterWait.w4b, evidence };
  } finally {
    win.destroy();
  }
}

async function verifyW4BUnknown() {
  const { win, errors } = createW4BWindow('unknown');
  try {
    await loadAndOpenW4BDeepProfile(win);
    await waitFor(win,
      "document.body.textContent.includes('生成任务状态暂时无法确认')",
      'W4-B unknown generation state');
    const beforeRetry = await readW4BRuntime(win);
    await clickExactText(win, '#deep-profile-generation-progress button', '重试读取任务状态');
    const afterRetry = await waitForW4BRuntime(win,
      (w4b) => w4b.progressGets === beforeRetry.w4b.progressGets + 1,
      'W4-B GET-only unknown retry');
    const state = await win.webContents.executeJavaScript(`(() => {
      const generate = [...document.querySelectorAll('[role=dialog] button')]
        .find((element) => element.textContent.includes('生成画像'));
      return {
        unknownVisible: document.body.textContent.includes('生成任务状态暂时无法确认'),
        getOnlyCopy: document.body.textContent.includes('重试只读取本机任务状态，不会重新生成'),
        generateDisabled: Boolean(generate?.disabled),
      };
    })()`);
    assert.deepEqual(state, { unknownVisible: true, getOnlyCopy: true, generateDisabled: true },
      'unknown progress must stay fail-closed after a GET-only retry');
    assert.deepEqual({
      progressBefore: beforeRetry.w4b.progressGets,
      progressAfter: afterRetry.w4b.progressGets,
      approvalCalls: afterRetry.w4b.approvalCalls,
      generatePosts: afterRetry.w4b.generatePosts,
      taskStarts: afterRetry.w4b.taskStarts,
      externalTransportCalls: afterRetry.w4b.externalTransportCalls,
    }, {
      progressBefore: 1,
      progressAfter: 2,
      approvalCalls: 0,
      generatePosts: 0,
      taskStarts: 0,
      externalTransportCalls: 0,
    }, 'unknown retry must increase only the real progress GET count');
    const evidence = await captureEvidence(win, 'w4b-unknown-get-only-retry-1100x720');
    assert.deepEqual(errors, [], 'W4-B unknown renderer must not emit console errors');
    return { state, calls: afterRetry.w4b, evidence };
  } finally {
    win.destroy();
  }
}

async function verifyW4BApprovalStale() {
  const { win, errors } = createW4BWindow('approval-stale');
  try {
    await loadAndOpenW4BDeepProfile(win);
    await clickRegenerateDeepProfile(win);
    await waitFor(win,
      "document.body.textContent.includes('当前材料未自动重放，请重新确认并生成')",
      'W4-B stale approval recovery');
    const beforeWait = await readW4BRuntime(win);
    await delay(2200);
    const afterWait = await readW4BRuntime(win);
    const state = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('[role=dialog]');
      const button = [...(dialog?.querySelectorAll('button') || [])]
        .find((element) => element.textContent.trim() === '重新确认并生成');
      const text = dialog?.textContent || '';
      return {
        staleReasonVisible: text.includes('一次性确认已过期') && text.includes('当前材料已变化'),
        noReplayVisible: text.includes('当前材料未自动重放，请重新确认并生成'),
        retryButtonEnabled: Boolean(button && !button.disabled),
      };
    })()`);
    assert.deepEqual(state, { staleReasonVisible: true, noReplayVisible: true, retryButtonEnabled: true },
      'expired approval/material change must persist explicit re-confirmation recovery');
    assert.deepEqual({
      progressGets: afterWait.w4b.progressGets,
      approvalCalls: afterWait.w4b.approvalCalls,
      generatePosts: afterWait.w4b.generatePosts,
      taskStarts: afterWait.w4b.taskStarts,
      externalTransportCalls: afterWait.w4b.externalTransportCalls,
      unchangedAfterWait: afterWait.w4b.approvalCalls === beforeWait.w4b.approvalCalls
        && afterWait.w4b.generatePosts === beforeWait.w4b.generatePosts,
    }, {
      progressGets: 2,
      approvalCalls: 1,
      generatePosts: 1,
      taskStarts: 0,
      externalTransportCalls: 0,
      unchangedAfterWait: true,
    }, 'stale authorization must not start or automatically replay a generation');
    const evidence = await captureEvidence(win, 'w4b-approval-stale-1100x720');
    assert.deepEqual(errors, [], 'W4-B stale approval renderer must not emit console errors');
    return { state, calls: afterWait.w4b, evidence };
  } finally {
    win.destroy();
  }
}

async function verifyW4BApprovalCancel() {
  const { win, errors } = createW4BWindow('approval-cancel');
  try {
    await loadAndOpenW4BDeepProfile(win);
    await clickRegenerateDeepProfile(win);
    const runtime = await waitForW4BRuntime(win,
      (w4b) => w4b.approvalCalls === 1,
      'W4-B canceled native approval');
    await waitFor(win,
      "[...document.querySelectorAll('[role=dialog] button')].some((button) => button.textContent.trim() === '重新生成画像（旧的确认状态会作废）' && !button.disabled && !button.classList.contains('ant-btn-loading'))",
      'W4-B approval cancel returns to retryable idle');
    const state = await win.webContents.executeJavaScript(`(() => ({
      retryableIdle: [...document.querySelectorAll('[role=dialog] button')]
        .some((button) => button.textContent.trim() === '重新生成画像（旧的确认状态会作废）' && !button.disabled),
      errorRecoveryVisible: document.body.textContent.includes('上次深度画像生成未完成'),
    }))()`);
    assert.deepEqual(state, { retryableIdle: true, errorRecoveryVisible: false },
      'canceling native approval must return to a retryable non-error state');
    assert.deepEqual({
      progressGets: runtime.w4b.progressGets,
      approvalCalls: runtime.w4b.approvalCalls,
      generatePosts: runtime.w4b.generatePosts,
      taskStarts: runtime.w4b.taskStarts,
      externalTransportCalls: runtime.w4b.externalTransportCalls,
    }, {
      progressGets: 2,
      approvalCalls: 1,
      generatePosts: 0,
      taskStarts: 0,
      externalTransportCalls: 0,
    }, 'canceled native approval must not POST, start a task, or use external transport');
    const evidence = await captureEvidence(win, 'w4b-approval-cancel-1100x720');
    assert.deepEqual(errors, [], 'W4-B approval cancel renderer must not emit console errors');
    return { state, calls: runtime.w4b, evidence };
  } finally {
    win.destroy();
  }
}

async function completeSyntheticAiSettings(win, {
  apiKey,
  evidenceName,
  labelPrefix = 'W4-B',
}) {
  await clickExactText(win, '.settings-admin-config > summary', '高级设置：服务地址、访问密钥与模型');
  await waitFor(win,
    "Boolean(document.querySelector('input[name=\"settings-llm-api-key\"]'))",
    `${labelPrefix} synthetic credential field`);
  for (const [name, value] of [['settings-llm-provider', 'synthetic'], ['settings-llm-base-url', 'https://ai.example.test/v1']]) {
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('input[name="' + ${JSON.stringify(name)} + '"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    })()`);
    await waitFor(win, `document.querySelector('input[name="' + ${JSON.stringify(name)} + '"]')?.value === ${JSON.stringify(value)}`, `${labelPrefix} synthetic connection ${name}`);
  }
  const credentialChanged = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('input[name="settings-llm-api-key"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!input || !setter) return false;
    setter.call(input, ${JSON.stringify(apiKey)});
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    return true;
  })()`);
  assert.equal(credentialChanged, true, `${labelPrefix} must fill only a synthetic credential`);
  await waitFor(win,
    "[...document.querySelectorAll('.settings-llm-key-row button')].some((button) => button.textContent.trim() === '保存密钥' && !button.disabled)",
    `${labelPrefix} synthetic credential action enabled`);
  await clickExactText(win, '.settings-llm-key-row button', '保存密钥');
  await waitFor(win,
    "document.querySelector('input[name=\"settings-llm-api-key\"]')?.value === '' && [...document.querySelectorAll('.settings-llm-model-row button')].some((button) => button.textContent.trim() === '刷新列表' && !button.disabled)",
    `${labelPrefix} synthetic credential save`);
  await clickExactText(win, '.settings-llm-model-row button', '刷新列表');
  await waitFor(win,
    "document.body.textContent.includes('已读取 1 个可选模型')",
    `${labelPrefix} synthetic model refresh`);
  const modelPickerPoint = await win.webContents.executeJavaScript(`(() => {
    const selector = document.querySelector('.settings-llm-model-row .ant-select-selector');
    selector?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
    const rect = selector?.getBoundingClientRect();
    return rect ? { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } : null;
  })()`);
  assert.ok(modelPickerPoint, `${labelPrefix} must locate the real Ant Design model picker`);
  win.webContents.sendInputEvent({ type: 'mouseDown', x: modelPickerPoint.x, y: modelPickerPoint.y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: modelPickerPoint.x, y: modelPickerPoint.y, button: 'left', clickCount: 1 });
  await waitFor(win,
    "[...document.querySelectorAll('.ant-select-item-option')].some((option) => option.offsetParent !== null && option.textContent.includes('synthetic-text-model'))",
    `${labelPrefix} synthetic model option`);
  await clickTextContaining(win, '.ant-select-item-option', 'synthetic-text-model');
  await waitFor(win,
    "![...document.querySelectorAll('.ant-select-dropdown')].some((dropdown) => dropdown.offsetParent !== null)",
    `${labelPrefix} synthetic model picker closed`);
  await clickExactText(win, '.settings-llm-model-row button', '测试并使用');
  await waitFor(win,
    "document.body.textContent.includes('模型测试通过：synthetic-text-model')",
    `${labelPrefix} synthetic model compatibility test`);
  await clickExactText(win, '.settings-llm-next-step button', '保存并启用');
  await waitFor(win,
    "[...document.querySelectorAll('.settings-llm-next-step button')].some((button) => button.textContent.trim() === '返回刚才的 AI 操作')",
    `${labelPrefix} enabled return action`);
  return captureEvidence(win, evidenceName);
}

async function verifyW4BAiSettingsContext() {
  const { win, errors } = createW4BWindow('ai-unconfigured');
  try {
    await loadAndOpenW4BDeepProfile(win);
    await waitFor(win, "Boolean(document.querySelector('#deep-profile-external-ai-prerequisite'))", 'W4-B external AI prerequisite');
    const prerequisite = await win.webContents.executeJavaScript(`(() => {
      const alert = document.querySelector('#deep-profile-external-ai-prerequisite');
      const generate = [...document.querySelectorAll('[role=dialog] button')]
        .find((button) => button.textContent.includes('生成画像'));
      return {
        unavailableVisible: (alert?.textContent || '').includes('外部 AI 尚未可用'),
        settingsButtonVisible: [...(alert?.querySelectorAll('button') || [])]
          .some((button) => button.textContent.trim() === '打开外部 AI 设置'),
        generateDisabled: Boolean(generate?.disabled),
      };
    })()`);
    assert.deepEqual(prerequisite, { unavailableVisible: true, settingsButtonVisible: true, generateDisabled: false },
      'AI-unconfigured state must explain the prerequisite while keeping the first-use action discoverable');

    await clickRegenerateDeepProfile(win, '#deep-profile-ai-action');
    await waitFor(win,
      "Boolean(document.querySelector('.external-ai-first-use-modal')?.offsetParent)",
      'W4-B first-use explanation');
    const firstUse = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.external-ai-first-use-modal');
      return {
        title: (dialog?.querySelector('.ant-modal-title')?.textContent || '').trim(),
        hasValue: (dialog?.textContent || '').includes('把已保存的负责人访谈整理为可核对的深度岗位画像'),
        hasMaterial: (dialog?.textContent || '').includes('岗位、已确认 JD/画像和负责人访谈文本'),
        hasNoAuto: (dialog?.textContent || '').includes('自动发送、自动评级、自动淘汰、自动写回'),
        actions: [...(dialog?.querySelectorAll('button') || [])].map((button) => button.textContent.trim()).filter(Boolean),
      };
    })()`);
    assert.deepEqual(firstUse, {
      title: '启用外部 AI 辅助',
      hasValue: true,
      hasMaterial: true,
      hasNoAuto: true,
      actions: ['查看发送边界', '继续手动处理', '启用并继续'],
    }, 'first-use explanation must expose value, send boundary and manual/enable choices');
    win.setSize(1024, 768);
    await delay(160);
    const firstUseSize = { outerSize: win.getSize(), contentSize: win.getContentSize() };
    assert.deepEqual(firstUseSize.outerSize, [1024, 768], 'native first-use prompt must fit a 1024x768 outer window');
    const firstUseEvidence = await captureEvidence(win, 'w4b-ai-first-use-1024x768');
    await clickExactText(win, '.external-ai-first-use-modal button', '继续手动处理');
    await waitFor(win,
      "!document.querySelector('.external-ai-first-use-modal')?.offsetParent",
      'W4-B manual fallback closes first-use explanation');
    await waitFor(win,
      "document.activeElement?.id === 'deep-profile-ai-action'",
      'W4-B manual fallback restores AI action focus');
    const manualRuntime = await readW4BRuntime(win);
    assert.deepEqual({
      approvalCalls: manualRuntime.w4b.approvalCalls,
      generatePosts: manualRuntime.w4b.generatePosts,
      externalTransportCalls: manualRuntime.w4b.externalTransportCalls,
    }, { approvalCalls: 0, generatePosts: 0, externalTransportCalls: 0 },
    'manual fallback must preserve content without approval or external work');

    await clickRegenerateDeepProfile(win, '#deep-profile-ai-action');
    await waitFor(win,
      "Boolean(document.querySelector('.external-ai-first-use-modal')?.offsetParent)",
      'W4-B repeated first-use explanation');
    await clickExactText(win, '.external-ai-first-use-modal button', '启用并继续');
    await waitFor(win, "Boolean(document.querySelector('#settings-integrations'))", 'W4-B AI settings route');
    await waitFor(win,
      "document.activeElement?.id === 'settings-external-ai-title'",
      'W4-B external AI settings heading focus');
    const settingsState = await win.webContents.executeJavaScript(`(() => ({
      activeNav: document.querySelector('.app-nav-footer-main[data-active="true"]')?.getAttribute('data-active-nav') || '',
      hash: location.hash,
      profileModalVisible: Boolean(document.querySelector('.deep-profile-modal-introduction')),
      returnLabel: document.querySelector('.settings-head button')?.getAttribute('aria-label') || '',
      externalAiHeadingFocused: document.activeElement?.id === 'settings-external-ai-title',
    }))()`);
    assert.deepEqual(settingsState, {
      activeNav: '设置',
      hash: '#settings-integrations',
      profileModalVisible: false,
      returnLabel: '返回职位管理',
      externalAiHeadingFocused: true,
    }, 'AI settings entry must reuse Settings integrations and close the profile modal');
    const settingsEvidence = await captureEvidence(win, 'w4b-ai-unconfigured-settings-1024x768');
    const enabledEvidence = await completeSyntheticAiSettings(win, {
      apiKey: 'synthetic-first-use-key',
      evidenceName: 'w4b-ai-configured-return-action-1024x768',
      labelPrefix: 'W4-B deep profile',
    });
    await clickExactText(win, '.settings-llm-next-step button', '返回刚才的 AI 操作');
    await waitFor(win, "!document.querySelector('.settings-panel')", 'W4-B leave AI settings through source return');
    await waitFor(win,
      "Boolean(document.querySelector('.deep-profile-modal-introduction'))",
      'W4-B restored deep-profile context');
    const runtime = await waitForW4BRuntime(win,
      (w4b) => w4b.approvalCalls === 1,
      'W4-B restored native send confirmation');
    await delay(180);
    const returnedContext = await win.webContents.executeJavaScript(`(() => ({
      activeNav: (document.querySelector('button.nav-item.active')?.textContent || '').trim(),
      hash: location.hash,
      activeJob: (document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent || '').trim(),
      editorVisible: Boolean(document.querySelector('.job-module-action-strip')),
      ledgerVisible: Boolean(document.querySelector('.job-ledger-page')),
      deepProfileVisible: Boolean(document.querySelector('.deep-profile-modal-introduction')),
      aiActionFocused: document.activeElement?.id === 'deep-profile-ai-action',
      workspaceText: (document.querySelector('#main-workspace')?.textContent || '').slice(0, 240),
    }))()`);
    assert.equal(returnedContext.activeNav, '职位管理',
      `returning from AI settings must restore the source module: ${JSON.stringify(returnedContext)}`);
    assert.equal(returnedContext.activeJob, '合成岗位 · 运行态视觉门禁',
      `returning from AI settings must preserve the active job: ${JSON.stringify(returnedContext)}`);
    assert.equal(returnedContext.editorVisible, true,
      `returning from AI settings must restore the existing job-editor source context: ${JSON.stringify(returnedContext)}`);
    assert.equal(returnedContext.ledgerVisible, false,
      `returning from AI settings must not replace the source editor with the generic ledger: ${JSON.stringify(returnedContext)}`);
    assert.equal(returnedContext.deepProfileVisible, true,
      `returning from AI settings must reopen the source deep-profile context: ${JSON.stringify(returnedContext)}`);
    assert.equal(returnedContext.aiActionFocused, true,
      `returning from AI settings must restore focus to the AI action before/while native confirmation resolves: ${JSON.stringify(returnedContext)}`);
    const returnedEvidence = await captureEvidence(win, 'w4b-ai-unconfigured-return-context-1024x768');
    assert.deepEqual({
      approvalCalls: runtime.w4b.approvalCalls,
      generatePosts: runtime.w4b.generatePosts,
      taskStarts: runtime.w4b.taskStarts,
      externalTransportCalls: runtime.w4b.externalTransportCalls,
    }, { approvalCalls: 1, generatePosts: 0, taskStarts: 0, externalTransportCalls: 0 },
    'source return must stop at the existing native confirmation and must not generate or call external transport after cancellation');
    assert.deepEqual(errors, [], 'W4-B AI settings renderer must not emit console errors');
    return {
      prerequisite,
      first_use: { ...firstUse, ...firstUseSize },
      settings: settingsState,
      returned_context: returnedContext,
      calls: runtime.w4b,
      evidence: {
        first_use: firstUseEvidence,
        settings: settingsEvidence,
        enabled: enabledEvidence,
        returned_context: returnedEvidence,
      },
    };
  } finally {
    win.destroy();
  }
}

async function verifyW4BJobJdAiSettingsContext() {
  const { win, errors } = createW4BWindow('ai-unconfigured');
  const syntheticBrief = '合成岗位招聘需求：负责本地商品运营复盘，所有内容仅用于隔离验收。';
  try {
    await loadW4BJobEditor(win);
    await waitFor(win, "Boolean(document.querySelector('#job-jd-editor'))", 'W4-B JD editor');
    const initialDraft = await win.webContents.executeJavaScript(`(() => {
      const brief = document.querySelector('#job-jd-editor');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (!brief || !setter) return null;
      setter.call(brief, ${JSON.stringify(syntheticBrief)});
      brief.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
      return {
        currentJd: document.querySelector('textarea[aria-label="JD 正文"]')?.value || '',
      };
    })()`);
    assert.ok(initialDraft, 'W4-B JD flow must fill only a synthetic recruitment brief');
    await waitFor(win,
      "!document.querySelector('#job-jd-ai-action')?.disabled",
      'W4-B JD AI action enabled');

    await clickExactText(win, '#job-jd-ai-action', 'AI 优化成 JD 草稿');
    await waitFor(win,
      "Boolean(document.querySelector('.external-ai-first-use-modal')?.offsetParent)",
      'W4-B JD first-use explanation');
    const firstUse = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.external-ai-first-use-modal');
      return {
        title: (dialog?.querySelector('.ant-modal-title')?.textContent || '').trim(),
        hasValue: (dialog?.textContent || '').includes('把自然语言招聘需求整理成可编辑 JD 草稿'),
        hasMaterial: (dialog?.textContent || '').includes('岗位名称、招聘需求和当前 JD 文本'),
        hasManualBoundary: (dialog?.textContent || '').includes('自动发送、自动评级、自动淘汰、自动写回'),
        actions: [...(dialog?.querySelectorAll('button') || [])].map((button) => button.textContent.trim()).filter(Boolean),
      };
    })()`);
    assert.deepEqual(firstUse, {
      title: '启用外部 AI 辅助',
      hasValue: true,
      hasMaterial: true,
      hasManualBoundary: true,
      actions: ['查看发送边界', '继续手动处理', '启用并继续'],
    }, 'JD first use must explain value, send boundary, manual fallback and opt-in');
    win.setSize(1024, 768);
    await delay(160);
    const firstUseSize = { outerSize: win.getSize(), contentSize: win.getContentSize() };
    assert.deepEqual(firstUseSize.outerSize, [1024, 768], 'native JD first-use flow must fit a 1024x768 outer window');
    const firstUseEvidence = await captureEvidence(win, 'hrboss-ai-settings-implementation-20260730-jd-first-use-1024x768');

    await clickExactText(win, '.external-ai-first-use-modal button', '继续手动处理');
    await waitFor(win,
      "document.activeElement?.id === 'job-jd-editor'",
      'W4-B JD manual fallback focus');
    const manualState = await win.webContents.executeJavaScript(`(() => ({
      brief: document.querySelector('#job-jd-editor')?.value || '',
      currentJd: document.querySelector('textarea[aria-label="JD 正文"]')?.value || '',
      notice: (document.querySelector('.job-management-shell')?.textContent || '').includes('可继续手动编辑、保存并启用'),
    }))()`);
    assert.deepEqual(manualState, {
      brief: syntheticBrief,
      currentJd: initialDraft.currentJd,
      notice: true,
    }, 'JD manual fallback must preserve both the brief and current JD');
    const afterManualRuntime = await readW4BRuntime(win);
    assert.deepEqual({
      approvalCalls: afterManualRuntime.w4b.approvalCalls,
      generatePosts: afterManualRuntime.w4b.generatePosts,
      externalTransportCalls: afterManualRuntime.w4b.externalTransportCalls,
    }, { approvalCalls: 0, generatePosts: 0, externalTransportCalls: 0 },
    'JD manual fallback must not approve or send');
    const manualEvidence = await captureEvidence(win, 'hrboss-ai-settings-implementation-20260730-jd-manual-1024x768');

    await clickExactText(win, '#job-jd-ai-action', 'AI 优化成 JD 草稿');
    await waitFor(win,
      "Boolean(document.querySelector('.external-ai-first-use-modal')?.offsetParent)",
      'W4-B JD repeated first-use explanation');
    await clickExactText(win, '.external-ai-first-use-modal button', '启用并继续');
    await waitFor(win,
      "Boolean(document.querySelector('#settings-integrations'))",
      'W4-B JD settings transition without a destructive source-draft guard');
    const draftGuardVisible = await win.webContents.executeJavaScript(
      "[...document.querySelectorAll('.ant-modal-confirm-title')].some((title) => title.offsetParent !== null && title.textContent.includes('JD 或岗位画像还有未保存草稿'))",
    );
    assert.equal(draftGuardVisible, false,
      'the AI settings route must carry the JD draft snapshot instead of asking HR to discard it');
    await waitFor(win, "Boolean(document.querySelector('#settings-integrations'))", 'W4-B JD AI settings route');
    await waitFor(win,
      "document.activeElement?.id === 'settings-external-ai-title'",
      'W4-B JD external AI settings heading focus');
    const settingsState = await win.webContents.executeJavaScript(`(() => ({
      activeNav: document.querySelector('.app-nav-footer-main[data-active="true"]')?.getAttribute('data-active-nav') || '',
      hash: location.hash,
      editorVisible: Boolean(document.querySelector('.job-management-shell')),
      returnLabel: document.querySelector('.settings-head button')?.getAttribute('aria-label') || '',
      externalAiHeadingFocused: document.activeElement?.id === 'settings-external-ai-title',
    }))()`);
    assert.deepEqual(settingsState, {
      activeNav: '设置',
      hash: '#settings-integrations',
      editorVisible: false,
      returnLabel: '返回职位管理',
      externalAiHeadingFocused: true,
    }, 'JD enable action must enter the existing AI settings section with source context');
    const settingsEvidence = await captureEvidence(win, 'hrboss-ai-settings-implementation-20260730-jd-settings-1024x768');

    await clickExactText(win, '.settings-head button', '返回职位管理');
    await waitFor(win, "Boolean(document.querySelector('#job-jd-ai-action'))", 'W4-B JD restore-only source return');
    await waitFor(win,
      "document.activeElement?.id === 'job-jd-ai-action'",
      'W4-B JD restore-only focus return');
    const restoreOnlyRuntime = await readW4BRuntime(win);
    const restoreOnlyContext = await win.webContents.executeJavaScript(`(() => ({
      brief: document.querySelector('#job-jd-editor')?.value || '',
      currentJd: document.querySelector('textarea[aria-label="JD 正文"]')?.value || '',
      aiActionFocused: document.activeElement?.id === 'job-jd-ai-action',
    }))()`);
    assert.deepEqual({
      ...restoreOnlyContext,
      approvalCalls: restoreOnlyRuntime.w4b.approvalCalls,
    }, {
      brief: syntheticBrief,
      currentJd: initialDraft.currentJd,
      approvalCalls: 0,
      aiActionFocused: true,
    }, 'settings top return must restore the exact JD draft and focus without opening native approval');
    const restoreOnlyEvidence = await captureEvidence(
      win,
      'hrboss-ai-settings-implementation-20260730-jd-restore-only-1024x768',
    );

    await clickExactText(win, '#job-jd-ai-action', 'AI 优化成 JD 草稿');
    await waitFor(win,
      "Boolean(document.querySelector('.external-ai-first-use-modal')?.offsetParent)",
      'W4-B JD first-use explanation after restore-only return');
    await clickExactText(win, '.external-ai-first-use-modal button', '启用并继续');
    await waitFor(win, "Boolean(document.querySelector('#settings-integrations'))", 'W4-B JD AI settings route after restore');
    const repeatedDraftGuardVisible = await win.webContents.executeJavaScript(
      "[...document.querySelectorAll('.ant-modal-confirm-title')].some((title) => title.offsetParent !== null && title.textContent.includes('JD 或岗位画像还有未保存草稿'))",
    );
    assert.equal(repeatedDraftGuardVisible, false,
      'repeated AI settings entry must preserve the carried JD draft without a discard prompt');

    const enabledEvidence = await completeSyntheticAiSettings(win, {
      apiKey: 'synthetic-jd-first-use-key',
      evidenceName: 'hrboss-ai-settings-implementation-20260730-jd-enabled-1024x768',
      labelPrefix: 'W4-B JD',
    });
    await clickExactText(win, '.settings-llm-next-step button', '返回刚才的 AI 操作');
    await waitFor(win, "Boolean(document.querySelector('#job-jd-ai-action'))", 'W4-B restored JD editor context');
    const runtime = await waitForW4BRuntime(win,
      (w4b) => w4b.approvalCalls === 1,
      'W4-B restored JD native send confirmation');
    await waitFor(win,
      "document.activeElement?.id === 'job-jd-ai-action'",
      'W4-B restored JD AI action focus');
    const returnedContext = await win.webContents.executeJavaScript(`(() => ({
      activeNav: (document.querySelector('button.nav-item.active')?.textContent || '').trim(),
      hash: location.hash,
      activeJob: (document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent || '').trim(),
      editorVisible: Boolean(document.querySelector('.job-management-shell')),
      ledgerVisible: Boolean(document.querySelector('.job-ledger-page')),
      aiActionFocused: document.activeElement?.id === 'job-jd-ai-action',
      brief: document.querySelector('#job-jd-editor')?.value || '',
      currentJd: document.querySelector('textarea[aria-label="JD 正文"]')?.value || '',
      canceledNotice: (document.querySelector('.job-management-shell')?.textContent || '').includes('已取消发送，现有 JD 内容没有变化'),
    }))()`);
    assert.deepEqual(returnedContext, {
      activeNav: '职位管理',
      hash: '',
      activeJob: '合成岗位 · 运行态视觉门禁',
      editorVisible: true,
      ledgerVisible: false,
      aiActionFocused: true,
      brief: syntheticBrief,
      currentJd: initialDraft.currentJd,
      canceledNotice: true,
    }, 'JD source return must preserve the exact editor context and stop after the native confirmation is canceled');
    const returnedEvidence = await captureEvidence(win, 'hrboss-ai-settings-implementation-20260730-jd-return-confirmation-1024x768');
    assert.deepEqual({
      approvalCalls: runtime.w4b.approvalCalls,
      generatePosts: runtime.w4b.generatePosts,
      taskStarts: runtime.w4b.taskStarts,
      externalTransportCalls: runtime.w4b.externalTransportCalls,
      actionWriteCalls: runtime.actionWriteCalls,
      approvalPurpose: runtime.w4b.lastApproval?.purpose,
    }, {
      approvalCalls: 1,
      generatePosts: 0,
      taskStarts: 0,
      externalTransportCalls: 0,
      actionWriteCalls: 0,
      approvalPurpose: 'job-jd-optimization',
    }, 'JD source return must reach the existing native confirmation without POST or external transport');
    assert.deepEqual(errors, [], 'W4-B JD AI settings renderer must not emit console errors');
    return {
      first_use: { ...firstUse, ...firstUseSize },
      manual: manualState,
      settings: settingsState,
      restore_only: restoreOnlyContext,
      returned_context: returnedContext,
      calls: runtime.w4b,
      evidence: {
        first_use: firstUseEvidence,
        manual: manualEvidence,
        settings: settingsEvidence,
        restore_only: restoreOnlyEvidence,
        enabled: enabledEvidence,
        returned_context: returnedEvidence,
      },
    };
  } finally {
    win.destroy();
  }
}

async function openSyntheticCandidate(win) {
  await win.loadFile(path.join(distRoot, 'index.html'));
  win.webContents.setZoomFactor(1);
  win.setSize(1024, 768);
  await waitFor(win,
    "document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent.includes('合成岗位')",
    'AI entry synthetic job context');
  await clickExactText(win, 'button.nav-item', '候选人');
  await waitFor(win, "Boolean(document.querySelector('.candidate-card'))", 'AI entry candidate list');
  const selected = await win.webContents.executeJavaScript(`(() => {
    const candidate = [...document.querySelectorAll('.candidate-card')]
      .find((card) => (card.getAttribute('aria-label') || '').startsWith('合成候选人 · 超长中文名称'));
    candidate?.click();
    return Boolean(candidate);
  })()`);
  assert.equal(selected, true, 'AI entry runtime must select the synthetic candidate');
  await waitFor(win,
    "document.querySelector('.candidate-card[aria-selected=\"true\"]')?.getAttribute('aria-label')?.startsWith('合成候选人 · 超长中文名称')",
    'AI entry selected candidate');
  await waitFor(win, "Boolean(document.querySelector('.candidate-domain-tab-option'))", 'AI entry candidate domains');
}

async function readUnifiedFirstUse(win, expectedTitle, expectedValue, expectedMaterial) {
  await waitFor(win,
    "Boolean(document.querySelector('.external-ai-first-use-modal')?.offsetParent)",
    `${expectedTitle} first-use modal`);
  const state = await win.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('.external-ai-first-use-modal');
    return {
      title: (dialog?.querySelector('.ant-modal-title')?.textContent || '').trim(),
      capability: (dialog?.querySelector('.external-ai-first-use-copy strong')?.textContent || '').trim(),
      hasValue: (dialog?.textContent || '').includes(${JSON.stringify(expectedValue)}),
      hasMaterial: (dialog?.textContent || '').includes(${JSON.stringify(expectedMaterial)}),
      hasNoAuto: (dialog?.textContent || '').includes('自动发送、自动评级、自动淘汰、自动写回'),
      actions: [...(dialog?.querySelectorAll('button') || [])]
        .map((button) => (button.textContent || '').trim())
        .filter(Boolean),
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  assert.deepEqual(state, {
    title: '启用外部 AI 辅助',
    capability: expectedTitle,
    hasValue: true,
    hasMaterial: true,
    hasNoAuto: true,
    actions: ['查看发送边界', '继续手动处理', '启用并继续'],
    documentOverflow: 0,
  }, `${expectedTitle} must reuse the unified first-use boundary`);
  return state;
}

async function verifyCandidateAssessmentFirstUseReturn() {
  const { win, errors } = createW4BWindow('ai-unconfigured');
  try {
    await openSyntheticCandidate(win);
    await clickTextContaining(win, '.candidate-profile-tools button', 'AI 初评');
    await waitFor(win, "Boolean(document.querySelector('#candidate-ai-assessment-action'))", 'candidate AI assessment action');
    await clickExactText(win, '#candidate-ai-assessment-action', '启用真实 AI 辅助');
    const firstUse = await readUnifiedFirstUse(
      win,
      '候选人 AI 初评',
      '按岗位要求整理候选人材料中的匹配、风险和信息不足',
      '岗位要求、候选人简历和已确认画像',
    );
    const firstUseEvidence = await captureEvidence(
      win,
      'hrboss-ai-settings-implementation-20260730-candidate-first-use-1024x768',
    );
    await clickExactText(win, '.external-ai-first-use-modal button', '继续手动处理');
    await waitFor(win,
      "document.activeElement?.id === 'candidate-ai-assessment-action'",
      'candidate AI manual fallback focus');
    const afterManual = await readW4BRuntime(win);
    assert.equal(afterManual.actionWriteCalls, 0, 'candidate AI manual fallback must not write or send');
    assert.equal(afterManual.w4b.approvalCalls, 0, 'candidate AI manual fallback must not request approval');

    await clickExactText(win, '#candidate-ai-assessment-action', '启用真实 AI 辅助');
    await readUnifiedFirstUse(
      win,
      '候选人 AI 初评',
      '按岗位要求整理候选人材料中的匹配、风险和信息不足',
      '岗位要求、候选人简历和已确认画像',
    );
    await clickExactText(win, '.external-ai-first-use-modal button', '启用并继续');
    await waitFor(win, "Boolean(document.querySelector('#settings-integrations'))", 'candidate AI settings route');
    await waitFor(win, "document.activeElement?.id === 'settings-external-ai-title'", 'candidate AI settings heading focus');
    const enabledEvidence = await completeSyntheticAiSettings(win, {
      apiKey: 'synthetic-candidate-first-use-key',
      evidenceName: 'hrboss-ai-settings-implementation-20260730-candidate-enabled-1024x768',
      labelPrefix: 'W4-B candidate assessment',
    });
    await clickExactText(win, '.settings-llm-next-step button', '返回刚才的 AI 操作');
    await waitFor(win, "Boolean(document.querySelector('#candidate-ai-assessment-action'))", 'candidate AI source return');
    let runtime;
    try {
      runtime = await waitForW4BRuntime(
        win,
        (w4b) => w4b.approvalCalls === 1,
        'candidate AI configured return native confirmation',
      );
    } catch (error) {
      const runtimeSnapshot = await readW4BRuntime(win);
      const debug = await win.webContents.executeJavaScript(`(() => ({
        activeNav: (document.querySelector('button.nav-item.active')?.textContent || '').trim(),
        actionText: (document.querySelector('#candidate-ai-assessment-action')?.textContent || '').trim(),
        actionDisabled: document.querySelector('#candidate-ai-assessment-action')?.disabled,
        actionFocused: document.activeElement?.id === 'candidate-ai-assessment-action',
        settingsVisible: Boolean(document.querySelector('#settings-integrations')),
        firstUseVisible: Boolean(document.querySelector('.external-ai-first-use-modal')?.offsetParent),
      }))()`);
      throw new Error(`${error.message}; runtime=${JSON.stringify(runtimeSnapshot)}; state=${JSON.stringify(debug)}`);
    }
    try {
      await waitFor(win,
        "document.activeElement?.id === 'candidate-ai-assessment-action'",
        'candidate AI source return focus');
    } catch (error) {
      const debug = await win.webContents.executeJavaScript(`(() => ({
        activeId: document.activeElement?.id || '',
        activeText: (document.activeElement?.textContent || '').trim(),
        actionPresent: Boolean(document.querySelector('#candidate-ai-assessment-action')),
        aiPanelSelected: document.querySelector('.candidate-profile-tools button[aria-pressed="true"]')?.textContent || '',
        selectedDomain: document.querySelector('.candidate-domain-tab-option input:checked')
          ?.closest('.candidate-domain-tab-option')?.textContent || '',
      }))()`);
      throw new Error(`${error.message}; state=${JSON.stringify(debug)}`);
    }
    const returned = await win.webContents.executeJavaScript(`(() => ({
      activeNav: (document.querySelector('button.nav-item.active')?.textContent || '').trim(),
      selectedCandidate: (document.querySelector('.candidate-card[aria-selected="true"]')?.getAttribute('aria-label') || ''),
      aiPanelSelected: document.querySelector('.candidate-profile-tools button[aria-pressed="true"]')?.textContent.includes('AI 初评') || false,
      actionFocused: document.activeElement?.id === 'candidate-ai-assessment-action',
    }))()`);
    assert.equal(returned.activeNav, '候选人');
    assert.match(returned.selectedCandidate, /^合成候选人/);
    assert.equal(returned.aiPanelSelected, true);
    assert.equal(returned.actionFocused, true);
    assert.equal(runtime.actionWriteCalls, 0, 'candidate AI canceled native confirmation must not write or send');
    assert.equal(runtime.w4b.approvalCalls, 1, 'candidate AI configured return must request exactly one native confirmation');
    assert.equal(runtime.w4b.externalTransportCalls, 0, 'candidate AI configured return must not use external transport after cancel');
    const returnedEvidence = await captureEvidence(
      win,
      'hrboss-ai-settings-implementation-20260730-candidate-return-1024x768',
    );
    assert.deepEqual(errors, [], 'candidate AI first-use renderer must not emit console errors');
    return {
      first_use: firstUse,
      manual: { action_focused: true, writes: afterManual.actionWriteCalls },
      returned,
      calls: runtime.w4b,
      evidence: { first_use: firstUseEvidence, enabled: enabledEvidence, returned: returnedEvidence },
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function verifyAssessmentAnalysisFirstUseReturn() {
  const { win, errors } = createW4BWindow('ai-unconfigured');
  try {
    await openSyntheticCandidate(win);
    await clickTextContaining(win, '.candidate-domain-tab-option', '测评');
    await waitFor(win, "Boolean(document.querySelector('#assessment-ai-analysis-action'))", 'assessment AI action');
    const actionText = await win.webContents.executeJavaScript(
      "(document.querySelector('#assessment-ai-analysis-action')?.textContent || '').trim()",
    );
    await clickExactText(win, '#assessment-ai-analysis-action', actionText);
    const firstUse = await readUnifiedFirstUse(
      win,
      '测评综合分析',
      '联合整理已确认测评、简历、岗位和已确认面试材料',
      '岗位、简历、已确认测评和已确认面试材料',
    );
    const firstUseEvidence = await captureEvidence(
      win,
      'hrboss-ai-settings-implementation-20260730-assessment-first-use-1024x768',
    );
    await clickExactText(win, '.external-ai-first-use-modal button', '继续手动处理');
    await waitFor(win,
      "document.activeElement?.id === 'assessment-ai-analysis-action'",
      'assessment AI manual fallback focus');
    const afterManual = await readW4BRuntime(win);
    assert.equal(afterManual.actionWriteCalls, 0, 'assessment AI manual fallback must not write or send');
    assert.equal(afterManual.w4b.approvalCalls, 0, 'assessment AI manual fallback must not request approval');

    await clickExactText(win, '#assessment-ai-analysis-action', actionText);
    await readUnifiedFirstUse(
      win,
      '测评综合分析',
      '联合整理已确认测评、简历、岗位和已确认面试材料',
      '岗位、简历、已确认测评和已确认面试材料',
    );
    await clickExactText(win, '.external-ai-first-use-modal button', '启用并继续');
    await waitFor(win, "Boolean(document.querySelector('#settings-integrations'))", 'assessment AI settings route');
    const enabledEvidence = await completeSyntheticAiSettings(win, {
      apiKey: 'synthetic-assessment-first-use-key',
      evidenceName: 'hrboss-ai-settings-implementation-20260730-assessment-enabled-1024x768',
      labelPrefix: 'W4-B assessment analysis',
    });
    await clickExactText(win, '.settings-llm-next-step button', '返回刚才的 AI 操作');
    await waitFor(win, "Boolean(document.querySelector('#assessment-ai-analysis-action'))", 'assessment AI source return');
    const runtime = await waitForW4BRuntime(
      win,
      (w4b) => w4b.approvalCalls === 1,
      'assessment AI configured return native confirmation',
    );
    await waitFor(win,
      "document.activeElement?.id === 'assessment-ai-analysis-action'",
      'assessment AI source return focus');
    const returned = await win.webContents.executeJavaScript(`(() => ({
      activeNav: (document.querySelector('button.nav-item.active')?.textContent || '').trim(),
      assessmentVisible: Boolean(document.querySelector('.assessment-archive-panel')),
      assessmentDomainSelected: document.querySelector('.candidate-domain-tab-option input:checked')
        ?.closest('.candidate-domain-tab-option')?.textContent.includes('测评') || false,
      actionFocused: document.activeElement?.id === 'assessment-ai-analysis-action',
    }))()`);
    assert.deepEqual(returned, {
      activeNav: '候选人',
      assessmentVisible: true,
      assessmentDomainSelected: true,
      actionFocused: true,
    });
    assert.equal(runtime.actionWriteCalls, 0, 'assessment AI canceled native confirmation must not write or send');
    assert.equal(runtime.w4b.approvalCalls, 1, 'assessment AI configured return must request exactly one native confirmation');
    assert.equal(runtime.w4b.externalTransportCalls, 0, 'assessment AI configured return must not use external transport after cancel');
    const returnedEvidence = await captureEvidence(
      win,
      'hrboss-ai-settings-implementation-20260730-assessment-return-1024x768',
    );
    assert.deepEqual(errors, [], 'assessment AI first-use renderer must not emit console errors');
    return {
      first_use: firstUse,
      manual: { action_focused: true, writes: afterManual.actionWriteCalls },
      returned,
      calls: runtime.w4b,
      evidence: { first_use: firstUseEvidence, enabled: enabledEvidence, returned: returnedEvidence },
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function verifyInterviewReviewFirstUseReturn() {
  const { win, errors } = createRuntimeWindow('w3-formal', ['--hrboss-w4b-mode=ai-unconfigured']);
  try {
    await openSyntheticCandidate(win);
    await clickTextContaining(win, '.candidate-domain-tab-option', '面试');
    await waitFor(win, "Boolean(document.querySelector('#interview-ai-review-action-8811'))", 'interview AI review action');
    await clickExactText(win, '#interview-ai-review-action-8811', '生成 AI 草稿（可选）');
    const firstUse = await readUnifiedFirstUse(
      win,
      '面试 AI 复盘',
      '把 HR 选择的面试材料整理为可复核的面试报告草稿',
      'HR 本次勾选的 1 份面试材料',
    );
    const firstUseEvidence = await captureEvidence(
      win,
      'hrboss-ai-settings-implementation-20260730-interview-first-use-1024x768',
    );
    await clickExactText(win, '.external-ai-first-use-modal button', '继续手动处理');
    await waitFor(win,
      "document.activeElement?.id === 'interview-ai-review-action-8811'",
      'interview AI manual fallback focus');
    const afterManual = await readW4BRuntime(win);
    assert.equal(afterManual.actionWriteCalls, 0, 'interview AI manual fallback must not write or send');
    assert.equal(afterManual.w4b.approvalCalls, 0, 'interview AI manual fallback must not request approval');

    await clickExactText(win, '#interview-ai-review-action-8811', '生成 AI 草稿（可选）');
    await readUnifiedFirstUse(
      win,
      '面试 AI 复盘',
      '把 HR 选择的面试材料整理为可复核的面试报告草稿',
      'HR 本次勾选的 1 份面试材料',
    );
    await clickExactText(win, '.external-ai-first-use-modal button', '启用并继续');
    await waitFor(win, "Boolean(document.querySelector('#settings-integrations'))", 'interview AI settings route');
    const enabledEvidence = await completeSyntheticAiSettings(win, {
      apiKey: 'synthetic-interview-first-use-key',
      evidenceName: 'hrboss-ai-settings-implementation-20260730-interview-enabled-1024x768',
      labelPrefix: 'W4-B interview review',
    });
    await clickExactText(win, '.settings-llm-next-step button', '返回刚才的 AI 操作');
    await waitFor(win, "Boolean(document.querySelector('#interview-ai-review-action-8811'))", 'interview AI source return');
    await waitFor(win,
      "[...document.querySelectorAll('.ant-modal-title')].some((title) => title.offsetParent !== null && title.textContent.trim() === '发送前预览')",
      'interview AI configured return send preview');
    const runtime = await waitForW4BRuntime(
      win,
      (w4b) => w4b.interviewPreviewCalls === 1,
      'interview AI configured return preview call',
    );
    await waitFor(
      win,
      "Boolean(document.activeElement?.closest('[role=dialog]'))",
      'interview AI send preview keyboard focus',
    );
    const returned = await win.webContents.executeJavaScript(`(() => ({
      activeNav: (document.querySelector('button.nav-item.active')?.textContent || '').trim(),
      interviewVisible: Boolean(document.querySelector('.interview-review-panel')),
      interviewDomainSelected: document.querySelector('.candidate-domain-tab-option input:checked')
        ?.closest('.candidate-domain-tab-option')?.textContent.includes('面试') || false,
      currentSessionExpanded: [...document.querySelectorAll('.interview-review-records > .ant-collapse > .ant-collapse-item > .ant-collapse-header')]
        .some((header) => header.textContent.includes('当前面试轮次') && header.getAttribute('aria-expanded') === 'true'),
      previewVisible: [...document.querySelectorAll('.ant-modal-title')]
        .some((title) => title.offsetParent !== null && title.textContent.trim() === '发送前预览'),
      previewModel: [...document.querySelectorAll('.interview-llm-preview-facts > div')]
        .find((row) => row.querySelector('span')?.textContent.trim() === '模型')?.querySelector('strong')?.textContent.trim() || '',
      sendActionVisible: [...document.querySelectorAll('[role=dialog] button')]
        .some((button) => button.offsetParent !== null && button.textContent.trim() === '确认发送并生成草稿'),
      focusInsidePreview: Boolean(document.activeElement?.closest('[role=dialog]')),
    }))()`);
    assert.deepEqual(returned, {
      activeNav: '候选人',
      interviewVisible: true,
      interviewDomainSelected: true,
      currentSessionExpanded: true,
      previewVisible: true,
      previewModel: 'synthetic-text-model',
      sendActionVisible: true,
      focusInsidePreview: true,
    });
    assert.equal(runtime.w4b.interviewPreviewCalls, 1, 'interview AI configured return must generate one local send preview');
    assert.equal(runtime.w4b.approvalCalls, 0, 'interview AI preview must stop before native send confirmation');
    assert.equal(runtime.w4b.externalTransportCalls, 0, 'interview AI preview must not use external transport');
    const returnedEvidence = await captureEvidence(
      win,
      'hrboss-ai-settings-implementation-20260730-interview-return-1024x768',
    );
    assert.deepEqual(errors, [], 'interview AI first-use renderer must not emit console errors');
    return {
      first_use: firstUse,
      manual: { action_focused: true, writes: afterManual.actionWriteCalls },
      returned,
      calls: runtime.w4b,
      evidence: { first_use: firstUseEvidence, enabled: enabledEvidence, returned: returnedEvidence },
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function verifyRemainingAiEntryFirstUseReturns() {
  const keepAlive = new BrowserWindow({ show: false, width: 1, height: 1 });
  try {
    await keepAlive.loadURL('about:blank');
    return {
      candidate_assessment: await verifyCandidateAssessmentFirstUseReturn(),
      assessment_analysis: await verifyAssessmentAnalysisFirstUseReturn(),
      interview_review: await verifyInterviewReviewFirstUseReturn(),
    };
  } finally {
    if (!keepAlive.isDestroyed()) keepAlive.destroy();
  }
}

async function verifyW4BClosedReadOnly() {
  const { win, errors } = createW4BWindow('closed');
  try {
    await loadAndOpenW4BDeepProfile(win, '合成岗位 · 已关闭历史岗位');
    await waitFor(win,
      "document.body.textContent.includes('上次深度画像生成未完成')",
      'W4-B closed job error history');
    const beforeWait = await readW4BRuntime(win);
    await delay(2200);
    const afterWait = await readW4BRuntime(win);
    const state = await win.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('[role=dialog]');
      const text = dialog?.textContent || '';
      const generate = [...(dialog?.querySelectorAll('button') || [])]
        .find((button) => button.textContent.trim() === '重新确认并生成');
      const saveInterview = [...(dialog?.querySelectorAll('button') || [])]
        .find((button) => button.textContent.includes('保存线下录音'));
      return {
        readOnlyVisible: text.includes('当前为只读查看'),
        historyVisible: text.includes('W4-B 旧版历史画像'),
        errorVisible: text.includes('上次深度画像生成未完成'),
        genericWritableGuidance: text.includes('请在可写的正式开放岗位中处理'),
        claimsClickableRecovery: text.includes('可点击“重新确认并生成”'),
        generateDisabled: Boolean(generate?.disabled),
        saveInterviewDisabled: Boolean(saveInterview?.disabled),
        materialDisabled: Boolean(document.querySelector('textarea[name="deep-profile-interview-material"]')?.disabled),
      };
    })()`);
    assert.deepEqual(state, {
      readOnlyVisible: true,
      historyVisible: true,
      errorVisible: true,
      genericWritableGuidance: true,
      claimsClickableRecovery: false,
      generateDisabled: true,
      saveInterviewDisabled: true,
      materialDisabled: true,
    }, 'closed/readOnly job must retain history and progress while all writes remain locked');
    assert.deepEqual({
      progressBefore: beforeWait.w4b.progressGets,
      progressAfter: afterWait.w4b.progressGets,
      progressByJob: afterWait.w4b.progressByJob,
      profileGets: afterWait.w4b.profileGets,
      approvalCalls: afterWait.w4b.approvalCalls,
      generatePosts: afterWait.w4b.generatePosts,
      taskStarts: afterWait.w4b.taskStarts,
      externalTransportCalls: afterWait.w4b.externalTransportCalls,
      actionWriteCalls: afterWait.actionWriteCalls,
    }, {
      progressBefore: 1,
      progressAfter: 1,
      progressByJob: { 9903: 1 },
      profileGets: 1,
      approvalCalls: 0,
      generatePosts: 0,
      taskStarts: 0,
      externalTransportCalls: 0,
      actionWriteCalls: 0,
    }, 'closed/readOnly job may read history and progress but must never write or approve');
    const evidence = await captureEvidence(win, 'w4b-closed-readonly-history-1100x720');
    assert.deepEqual(errors, [], 'W4-B closed/readOnly renderer must not emit console errors');
    return { state, calls: afterWait.w4b, actionWriteCalls: afterWait.actionWriteCalls, evidence };
  } finally {
    win.destroy();
  }
}

async function verifyW4BDeepProfileRecovery() {
  const idleRecovery = await verifyW4BIdleRecovery();
  const seededDone = await verifyW4BSeededDone();
  const seededError = await verifyW4BSeededError();
  const unknown = await verifyW4BUnknown();
  const approvalStale = await verifyW4BApprovalStale();
  const approvalCancel = await verifyW4BApprovalCancel();
  const jobJdAiSettings = await verifyW4BJobJdAiSettingsContext();
  const aiSettings = await verifyW4BAiSettingsContext();
  const closedReadOnly = await verifyW4BClosedReadOnly();
  return {
    idle_recovery: idleRecovery,
    seeded_done: seededDone,
    seeded_error: seededError,
    unknown_get_only_retry: unknown,
    approval_expired_or_material_changed: approvalStale,
    approval_cancel: approvalCancel,
    job_jd_ai_unconfigured_settings_context: jobJdAiSettings,
    ai_unconfigured_settings_context: aiSettings,
    closed_job_readonly: closedReadOnly,
    global_readonly_evidence_split: {
      runtime_fabricated: false,
      this_default_build: 'W4-B runtime covers the writable build plus an actual closed-job readOnly prop path.',
      compile_time_global_readonly: 'VITE_READONLY_UI is a separate build; check-ux-w4-b-deep-profile-recovery.js statically proves progress/approval/generate are skipped.',
      existing_electron_gate: 'The existing G0-D2 Electron evidence owns global operational-readonly zero-write runtime proof.',
    },
  };
}

async function verifyW4Runtime() {
  const keepAlive = new BrowserWindow({ show: false, width: 1, height: 1 });
  try {
    await keepAlive.loadURL('about:blank');
    const guideDashboard = await verifyW4GuideAndDashboard();
    const settings = await verifyW4Settings();
    const assessment = await verifyW4Assessment();
    const ledger = await verifyW4Ledger();
    const deepProfileRecovery = await verifyW4BDeepProfileRecovery();
    return {
      guide_dashboard: guideDashboard,
      settings,
      assessment,
      ledger,
      deep_profile_recovery: deepProfileRecovery,
    };
  } finally {
    keepAlive.destroy();
  }
}

async function verifyAdversarialStateFixes(win) {
  await clickExactText(win, 'button.nav-item', '职位管理');
  await waitFor(win, "document.querySelector('.job-ledger-page')", 'adversarial job ledger entry');
  const openedName = await win.webContents.executeJavaScript(`(() => {
    const link = [...document.querySelectorAll('[data-job-ledger-focus-action="name"]')]
      .find((element) => element.offsetParent !== null && element.dataset.jobLedgerFocusJobId === '9901');
    link?.focus();
    link?.click();
    return Boolean(link);
  })()`);
  assert.equal(openedName, true, 'adversarial focus check needs the visible job name link');
  await waitFor(win,
    "document.activeElement === document.querySelector('[data-job-editor-heading]')",
    'job editor heading focus from name link');

  const returnedToLedger = await win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((element) => element.offsetParent !== null && element.textContent.trim() === '返回岗位台账');
    button?.focus();
    button?.click();
    return Boolean(button);
  })()`);
  assert.equal(returnedToLedger, true, 'adversarial focus check needs the real return-to-ledger button');
  await waitFor(win,
    "document.activeElement?.dataset.jobLedgerFocusAction === 'name' && document.activeElement?.dataset.jobLedgerFocusJobId === '9901'",
    'job ledger name-link focus restoration');

  const openedManage = await win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('[data-job-ledger-focus-action="manage"]')]
      .find((element) => element.offsetParent !== null && element.dataset.jobLedgerFocusJobId === '9901');
    button?.focus();
    button?.click();
    return Boolean(button);
  })()`);
  assert.equal(openedManage, true, 'adversarial focus check needs the visible manage button');
  await waitFor(win,
    "document.activeElement === document.querySelector('[data-job-editor-heading]')",
    'job editor heading focus');
  const editorFocus = await win.webContents.executeJavaScript(`(() => ({
    tag: document.activeElement?.tagName || '',
    text: (document.activeElement?.textContent || '').trim(),
    announcement: (document.querySelector('.module-route-announcer')?.textContent || '').trim(),
  }))()`);
  assert.equal(editorFocus.tag, 'H3', 'job editor route must focus its visible heading');
  assert.match(editorFocus.text, /合成岗位/);
  assert.match(editorFocus.announcement, /JD 与画像编辑视图/);

  await win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((element) => element.offsetParent !== null && element.textContent.trim() === '返回岗位台账');
    button.focus();
    button.click();
  })()`);
  await waitFor(win,
    "document.activeElement?.dataset.jobLedgerFocusAction === 'manage' && document.activeElement?.dataset.jobLedgerFocusJobId === '9901'",
    'job ledger manage-button focus restoration');
  const ledgerFocus = await win.webContents.executeJavaScript(`(() => ({
    tag: document.activeElement?.tagName || '',
    action: document.activeElement?.dataset.jobLedgerFocusAction || '',
    jobId: document.activeElement?.dataset.jobLedgerFocusJobId || '',
    announcement: (document.querySelector('.module-route-announcer')?.textContent || '').trim(),
  }))()`);
  assert.deepEqual(ledgerFocus, {
    tag: 'BUTTON',
    action: 'manage',
    jobId: '9901',
    announcement: '已返回岗位台账',
  });

  await clickExactText(win, 'button.nav-item', '候选人');
  await waitFor(win, "Boolean(document.querySelector('.candidate-card'))", 'authority-race candidate workspace');
  const authorityRaceBefore = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
  await win.webContents.executeJavaScript('window.runtimeInfo.setScreenshotDirectoryDelay(1800)');
  await clickExactText(win, '.candidate-module-actions button', '候选人操作');
  await waitFor(win,
    "[...document.querySelectorAll('.ant-dropdown-menu-item')].some((element) => element.offsetParent !== null && element.textContent.trim() === '导入 Boss App 截图')",
    'authority-race screenshot import item');
  await win.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('.ant-dropdown-menu-item')]
      .find((element) => element.offsetParent !== null && element.textContent.trim() === '导入 Boss App 截图');
    item.click();
  })()`);
  await waitFor(win,
    `window.runtimeInfo.get().then((state) => state.screenshotDirectorySelectionCalls === ${authorityRaceBefore.screenshotDirectorySelectionCalls + 1})`,
    'authority-race delayed screenshot picker');

  await clickExactText(win, 'button.nav-item', '职位管理');
  await waitFor(win, "document.querySelector('.job-ledger-page')", 'authority-race job ledger');
  await win.webContents.executeJavaScript('window.runtimeInfo.setForceJobsError(true)');
  await clickExactText(win, '.job-ledger-row-actions button', '更多');
  await waitFor(win,
    "[...document.querySelectorAll('.ant-dropdown-menu-item')].some((element) => element.offsetParent !== null && element.textContent.trim() === '暂缓')",
    'authority-race job pause item');
  await win.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('.ant-dropdown-menu-item')]
      .find((element) => element.offsetParent !== null && element.textContent.trim() === '暂缓');
    item.click();
  })()`);
  await waitFor(win,
    "[...document.querySelectorAll('[role=\"dialog\"]')].some((element) => element.offsetParent !== null && element.textContent.includes('暂缓'))",
    'authority-race job pause confirmation');
  await win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('[role="dialog"] button')]
      .find((element) => element.offsetParent !== null && element.textContent.trim() === '暂缓');
    button.click();
  })()`);
  await waitFor(win,
    "document.querySelector('.job-ledger-authority-stale')?.textContent.includes('岗位台账读取失败')",
    'authority-race job authority error');
  await delay(1900);
  const authorityRaceAfter = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
  assert.equal(
    authorityRaceAfter.candidateAuthorityWriteCalls.screenshotImport,
    authorityRaceBefore.candidateAuthorityWriteCalls.screenshotImport,
    'a screenshot picker resolving after job authority failed must perform zero imports',
  );
  await win.webContents.executeJavaScript(`Promise.all([
    window.runtimeInfo.setForceJobsError(false),
    window.runtimeInfo.setScreenshotDirectoryDelay(0),
  ])`);
  await clickExactText(win, '.job-ledger-authority-stale button', '重新读取岗位台账');
  await waitFor(win,
    "!document.querySelector('.job-ledger-authority-stale') && document.querySelector('.job-ledger-page')",
    'authority-race job authority recovery');
  await waitFor(win,
    "[...document.querySelectorAll('.job-ledger-page button')].some((element) => element.offsetParent !== null && element.textContent.trim() === '重试刷新')",
    'authority-race committed refresh recovery');
  await clickExactText(win, '.job-ledger-page button', '重试刷新');
  await waitFor(win,
    "![...document.querySelectorAll('.job-ledger-page button')].some((element) => element.offsetParent !== null && element.textContent.trim() === '重试刷新')",
    'authority-race committed refresh cleared');

  await win.webContents.executeJavaScript('window.runtimeInfo.setForceEmptyJobs(true)');
  const openedMore = await win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((element) => element.offsetParent !== null && element.textContent.trim() === '更多');
    button?.click();
    return Boolean(button);
  })()`);
  assert.equal(openedMore, true, 'authoritative-empty check needs the visible job actions menu');
  await waitFor(win,
    "[...document.querySelectorAll('.ant-dropdown-menu-item')].some((element) => element.offsetParent !== null && element.textContent.trim() === '暂缓')",
    'job pause menu item');
  await win.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('.ant-dropdown-menu-item')]
      .find((element) => element.offsetParent !== null && element.textContent.trim() === '暂缓');
    item.click();
  })()`);
  await waitFor(win,
    "[...document.querySelectorAll('[role=\"dialog\"]')].some((element) => element.offsetParent !== null && element.textContent.includes('暂缓'))",
    'job pause confirmation');
  await win.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('[role="dialog"] button')]
      .find((element) => element.offsetParent !== null && element.textContent.trim() === '暂缓');
    button.click();
  })()`);
  await waitFor(win,
    "document.querySelector('.job-ledger-page')?.textContent.includes('还没有岗位')",
    'authoritative empty job ledger');

  const emptyLedger = await win.webContents.executeJavaScript(`(() => ({
    selectedJob: (document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent || '').trim(),
    contextTags: [...document.querySelectorAll('.job-ledger-page .ant-tag')]
      .filter((element) => element.textContent.trim() === '当前上下文').length,
    storedJobId: localStorage.getItem('hrboss.ui.currentJobId.v1'),
    oldJobVisible: document.querySelector('.job-ledger-page')?.textContent.includes('合成岗位 · 运行态视觉门禁') || false,
  }))()`);
  assert.deepEqual(emptyLedger, {
    selectedJob: '',
    contextTags: 0,
    storedJobId: null,
    oldJobVisible: false,
  }, 'authoritative empty list must clear every visible and persisted job context');

  await clickExactText(win, 'button.nav-item', '候选人');
  await waitFor(win, "document.querySelector('[data-module-heading]')?.textContent === '候选人'", 'empty-job candidate route');
  const beforeDisabledClick = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
  const emptyCandidate = await win.webContents.executeJavaScript(`(() => {
    const upload = [...document.querySelectorAll('button')]
      .find((element) => element.textContent.trim() === '上传简历建档');
    upload?.click();
    return {
      cards: document.querySelectorAll('.candidate-card').length,
      detailVisible: Boolean(document.querySelector('.candidate-v2-hero')),
      uploadPresent: Boolean(upload),
      uploadDisabled: Boolean(upload?.disabled),
      resumeModalVisible: [...document.querySelectorAll('[role="dialog"]')]
        .some((element) => element.offsetParent !== null && element.textContent.includes('确认简历建档')),
    };
  })()`);
  const afterDisabledClick = await win.webContents.executeJavaScript('window.runtimeInfo.get()');
  assert.deepEqual(emptyCandidate, {
    cards: 0,
    detailVisible: false,
    uploadPresent: true,
    uploadDisabled: true,
    resumeModalVisible: false,
  }, 'authoritative empty list must clear candidates and fail-close resume intake');
  assert.equal(afterDisabledClick.resumeDraftSelectionCalls, beforeDisabledClick.resumeDraftSelectionCalls,
    'disabled stale-context upload must not invoke the native file selector');

  await clickExactText(win, 'button.nav-item', '面试安排');
  await waitFor(win,
    "Boolean(document.querySelector('.interview-schedule-empty-state'))",
    'empty-job interview route');
  const emptyInterview = await win.webContents.executeJavaScript(`(() => {
    const state = document.querySelector('.interview-schedule-empty-state');
    const action = [...(state?.querySelectorAll('button') || [])]
      .find((element) => element.textContent.trim() === '前往职位管理');
    return {
      heading: (document.querySelector('.interview-schedule-head h2')?.textContent || '').trim(),
      ariaLabel: state?.getAttribute('aria-label') || '',
      promptVisible: Boolean(state?.textContent.includes('请先在顶部选择岗位')),
      actionVisible: Boolean(action?.offsetParent),
      loadingRegions: document.querySelectorAll('[aria-label="正在加载面试安排"]').length,
      skeletons: document.querySelectorAll('.interview-schedule-panel .ant-skeleton').length,
    };
  })()`);
  assert.deepEqual(emptyInterview, {
    heading: '面试安排',
    ariaLabel: '尚未选择岗位',
    promptVisible: true,
    actionVisible: true,
    loadingRegions: 0,
    skeletons: 0,
  }, 'missing job context must render a truthful, recoverable interview empty state');
  const emptyInterviewEvidence = await captureEvidence(win, 'interviews-empty-no-job-1100x720');
  await clickExactText(win, '.interview-schedule-empty-state button', '前往职位管理');
  await waitFor(win,
    "Boolean(document.querySelector('.job-ledger-page'))",
    'empty-job interview action returns to job management');

  await clickExactText(win, 'button.nav-item', '工作台');
  await waitFor(win,
    "Boolean(document.querySelector('.dashboard-first-job-card'))",
    'authoritative empty dashboard');
  const emptyDashboard = await win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.dashboard-v2-state');
    const primaryButtons = [...(panel?.querySelectorAll('.ant-btn-primary') || [])]
      .filter((element) => element.offsetParent !== null)
      .map((element) => element.textContent.trim());
    const aiGuide = [...(panel?.querySelectorAll('.ant-collapse-header') || [])]
      .find((element) => element.textContent.includes('可选：了解 5 项 AI 辅助能力'));
    return {
      primaryButtons,
      firstJobCopy: panel?.textContent.includes('先建立一个岗位') || false,
      aiGuidePresent: Boolean(aiGuide),
      aiGuideExpanded: aiGuide?.getAttribute('aria-expanded') || '',
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  assert.deepEqual(emptyDashboard.primaryButtons, ['去新建岗位'],
    'the authoritative empty dashboard must expose new-job as its only primary CTA');
  assert.equal(emptyDashboard.firstJobCopy, true);
  assert.equal(emptyDashboard.aiGuidePresent, true);
  assert.equal(emptyDashboard.aiGuideExpanded, 'false',
    'AI guidance must remain collapsed and secondary before the first job exists');
  assert.ok(emptyDashboard.documentOverflow <= 1,
    'the authoritative empty dashboard must not overflow horizontally');
  const emptyDashboardEvidence = await captureEvidence(
    win,
    'hrboss-ai-settings-implementation-20260730-empty-dashboard-1100x720',
  );

  await win.webContents.executeJavaScript("history.replaceState(null, '', '#settings-integrations')");
  win.webContents.reload();
  await waitFor(win, "Boolean(document.querySelector('#settings-integrations'))", 'settings deep link after reload');
  await waitFor(win, "document.activeElement?.id === 'settings-integrations-title'", 'settings deep-link heading focus');
  const settingsReload = await win.webContents.executeJavaScript(`(() => ({
    hash: location.hash,
    settingsVisible: Boolean(document.querySelector('.settings-panel')),
    section: document.querySelector('.settings-panel-view')?.id || '',
    returnLabel: document.querySelector('.settings-head button')?.getAttribute('aria-label') || '',
  }))()`);
  assert.deepEqual(settingsReload, {
    hash: '#settings-integrations',
    settingsVisible: true,
    section: 'settings-integrations',
    returnLabel: '返回工作台',
  }, 'direct settings hash must restore the settings module and exact section');

  await win.webContents.executeJavaScript(`(() => {
    const link = document.querySelector('.skip-link');
    link.focus();
    link.click();
  })()`);
  await waitFor(win, "document.activeElement?.id === 'main-workspace'", 'settings skip-link focus');
  const skipLinkRoute = await win.webContents.executeJavaScript(`(() => ({
    hash: location.hash,
    section: document.querySelector('.settings-panel-view')?.id || '',
  }))()`);
  assert.deepEqual(skipLinkRoute, {
    hash: '#settings-integrations',
    section: 'settings-integrations',
  }, 'skip link must not overwrite the settings route hash');

  await clickExactText(win, '.settings-head button', '返回工作台');
  await waitFor(win, "Boolean(document.querySelector('.dashboard-v2-focus-grid'))", 'leave restored settings route');
  const settingsLeave = await win.webContents.executeJavaScript(`(() => ({
    hash: location.hash,
    settingsVisible: Boolean(document.querySelector('.settings-panel')),
    activeNav: (document.querySelector('button.nav-item.active')?.textContent || '').trim(),
  }))()`);
  assert.deepEqual(settingsLeave, {
    hash: '',
    settingsVisible: false,
    activeNav: '工作台',
  }, 'leaving settings must clear the route hash so refresh cannot reopen it');

  await win.webContents.executeJavaScript(`(() => {
    history.replaceState(null, '', '#settings-data');
    window.dispatchEvent(new Event('hashchange'));
  })()`);
  await waitFor(win, "Boolean(document.querySelector('#settings-data'))", 'runtime settings hash navigation');
  await waitFor(win, "document.activeElement?.id === 'settings-data-title'", 'runtime settings hash heading focus');
  const settingsRuntimeHash = await win.webContents.executeJavaScript(`(() => ({
    hash: location.hash,
    settingsVisible: Boolean(document.querySelector('.settings-panel')),
    section: document.querySelector('.settings-panel-view')?.id || '',
    returnLabel: document.querySelector('.settings-head button')?.getAttribute('aria-label') || '',
  }))()`);
  assert.deepEqual(settingsRuntimeHash, {
    hash: '#settings-data',
    settingsVisible: true,
    section: 'settings-data',
    returnLabel: '返回工作台',
  }, 'a valid settings hash received while running must synchronize the visible module and return context');
  await clickExactText(win, '.settings-head button', '返回工作台');
  await waitFor(win, "Boolean(document.querySelector('.dashboard-v2-focus-grid')) && location.hash === ''",
    'runtime settings hash return');

  return {
    editor_focus: editorFocus,
    ledger_focus: ledgerFocus,
    authority_error_during_picker: {
      pickerCalls: authorityRaceAfter.screenshotDirectorySelectionCalls
        - authorityRaceBefore.screenshotDirectorySelectionCalls,
      screenshotImportWrites: authorityRaceAfter.candidateAuthorityWriteCalls.screenshotImport
        - authorityRaceBefore.candidateAuthorityWriteCalls.screenshotImport,
    },
    authoritative_empty: {
      ledger: emptyLedger,
      candidate: emptyCandidate,
      interview: emptyInterview,
      dashboard: emptyDashboard,
      interview_evidence: emptyInterviewEvidence,
      dashboard_evidence: emptyDashboardEvidence,
    },
    settings_reload: settingsReload,
    settings_skip_link: skipLinkRoute,
    settings_leave: settingsLeave,
    settings_runtime_hash: settingsRuntimeHash,
  };
}

async function verifyRendererRestartState(win) {
  const expected = {
    brandName: '合成长中文工作区名称 · Windows 重启恢复验证',
    visibleBrandName: '合成长中文工作区名称 · Windows 重启恢复验证'.slice(0, 32),
    currentJobId: '9901',
    candidateListCollapsed: '1',
  };
  await win.webContents.executeJavaScript(`(() => {
    localStorage.setItem('hrboss.ui.brandName.v1', ${JSON.stringify(expected.brandName)});
    localStorage.setItem('hrboss.ui.currentJobId.v1', ${JSON.stringify(expected.currentJobId)});
    localStorage.setItem('hrboss.ui.candidateListCollapsed.v1', ${JSON.stringify(expected.candidateListCollapsed)});
  })()`);

  const restartWin = new BrowserWindow({
    show: false,
    width: 1360,
    height: 768,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(ROOT, "tests/check-ui-visual-runtime-preload.js"),
    },
  });
  const errors = [];
  restartWin.webContents.on('console-message', (event) => {
    if (event && (event.level === 'error' || Number(event.level) >= 3)) errors.push(event.message);
  });
  restartWin.webContents.on('render-process-gone', (_event, details) => {
    errors.push(`renderer gone: ${JSON.stringify(details)}`);
  });

  try {
    await restartWin.loadFile(path.join(distRoot, 'index.html'));
    restartWin.setContentSize(1360, 768);
    restartWin.webContents.setZoomFactor(1.5);
    await delay(240);
    restartWin.webContents.focus();
    await waitFor(restartWin, 'document.hasFocus()', 'Windows 150% restarted renderer focus');
    await waitFor(restartWin, "document.querySelector('button.nav-item')", 'Windows 150% restarted navigation');
    await waitFor(restartWin,
      "document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent.includes('合成岗位')",
      'Windows 150% restarted job context');

    await clickExactText(restartWin, 'button.nav-item', '候选人');
    await waitFor(restartWin,
      "Boolean(document.querySelector('.candidate-sider-collapsed') && document.querySelector('button[aria-label=\"展开候选人列表\"]'))",
      'Windows 150% restarted candidate-list preference');
    await waitFor(restartWin,
      "document.activeElement === document.querySelector('#main-workspace [data-module-heading]')",
      'Windows 150% restarted candidate heading focus');

    const state = await restartWin.webContents.executeJavaScript(`(() => {
      const brand = document.querySelector('.brand-mark');
      const restore = document.querySelector('button[aria-label="展开候选人列表"]');
      const heading = document.querySelector('#main-workspace [data-module-heading]');
      const documentElement = document.documentElement;
      return {
        viewport: [innerWidth, innerHeight],
        stored: {
          brandName: localStorage.getItem('hrboss.ui.brandName.v1'),
          currentJobId: localStorage.getItem('hrboss.ui.currentJobId.v1'),
          candidateListCollapsed: localStorage.getItem('hrboss.ui.candidateListCollapsed.v1'),
        },
        brandText: (brand?.querySelector('strong')?.textContent || '').trim(),
        brandLabel: brand?.getAttribute('aria-label') || '',
        selectedJob: (document.querySelector('.topbar-job-select .ant-select-selection-item')?.textContent || '').trim(),
        collapsed: Boolean(document.querySelector('.candidate-sider-collapsed')),
        restoreVisible: Boolean(restore?.offsetParent),
        restoreWidth: restore?.getBoundingClientRect().width || 0,
        restoreHeight: restore?.getBoundingClientRect().height || 0,
        headingFocused: document.activeElement === heading,
        documentOverflow: documentElement.scrollWidth - documentElement.clientWidth,
      };
    })()`);
    assert.ok(Math.abs(state.viewport[0] - 907) <= 1 && Math.abs(state.viewport[1] - 512) <= 1,
      `unexpected restarted Windows 150% viewport: ${JSON.stringify(state.viewport)}`);
    assert.deepEqual(state.stored, {
      brandName: expected.brandName,
      currentJobId: expected.currentJobId,
      candidateListCollapsed: expected.candidateListCollapsed,
    },
      'a fresh renderer sharing the isolated userData must restore the persisted UI preferences');
    assert.equal(state.brandText, expected.visibleBrandName,
      'the restarted renderer must restore the documented 32-character brand projection');
    assert.equal(state.brandLabel, `当前工作区：${expected.visibleBrandName}`);
    assert.match(state.selectedJob, /合成岗位/);
    assert.equal(state.collapsed, true);
    assert.equal(state.restoreVisible, true);
    assert.ok(state.restoreWidth >= 44 && state.restoreHeight >= 44,
      'the restored candidate-list control must remain a reachable keyboard target');
    assert.equal(state.headingFocused, true);
    assert.ok(state.documentOverflow <= 1,
      'the restarted Windows 150% candidate workspace must not overflow horizontally');
    const evidence = await captureEvidence(restartWin, 'windows150-restart-state-recovery');
    assert.deepEqual(errors, [], 'the restarted renderer must not emit console errors');
    return { ...state, evidence };
  } finally {
    if (!restartWin.isDestroyed()) restartWin.destroy();
  }
}

async function inspectSettingsSectionsAtNativeSize(win, width, height) {
  win.setSize(width, height);
  win.webContents.setZoomFactor(1);
  await delay(180);
  const labels = ['本机状态', 'AI 与外部连接', '面试工具', '数据与隐私', '界面显示', '关于与诊断'];
  const expectedIds = [
    'settings-overview',
    'settings-integrations',
    'settings-interview-tools',
    'settings-data',
    'settings-brand',
    'settings-advanced',
  ];
  const nativeSize = {
    outer: win.getSize(),
    content: win.getContentSize(),
  };
  const navigation = await win.webContents.executeJavaScript(`(() => ({
    viewport: [innerWidth, innerHeight],
    labels: [...document.querySelectorAll('.settings-section-nav button')]
      .map((element) => (element.textContent || '').trim()),
    compactSelectCount: document.querySelectorAll('.settings-section-nav [role="combobox"]').length,
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  }))()`);
  assert.deepEqual(nativeSize.outer, [width, height], `${width}x${height} must be the real Electron outer size`);
  assert.deepEqual(nativeSize.content, navigation.viewport,
    `${width}x${height} renderer viewport must match Electron content size`);
  assert.deepEqual(navigation.labels, labels, `${width}x${height} must expose the six HR-first settings categories in order`);
  assert.equal(navigation.compactSelectCount, 0, `${width}x${height} must keep the six desktop settings controls visible`);
  assert.ok(navigation.documentOverflow <= 1, `${width}x${height} settings navigation must not overflow horizontally`);

  const sections = [];
  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];
    const sectionId = expectedIds[index];
    await clickExactText(win, '.settings-section-nav button', label);
    await waitFor(win, `Boolean(document.querySelector('#${sectionId}'))`, `${width}x${height} ${label} section`);
    await waitFor(win, `document.activeElement?.id === '${sectionId}-title'`, `${width}x${height} ${label} heading focus`);
    const state = await win.webContents.executeJavaScript(`(() => {
      const panel = document.querySelector('.settings-panel');
      const workspace = panel?.closest('.workspace');
      const current = document.querySelector('.settings-section-nav button[aria-current="page"]');
      const visibleButtons = [...document.querySelectorAll('#${sectionId} button')]
        .filter((element) => element.offsetParent !== null);
      return {
        id: document.querySelector('.settings-panel-view')?.id || '',
        currentLabel: (current?.textContent || '').trim(),
        headingFocused: document.activeElement?.id === '${sectionId}-title',
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        workspaceOverflow: workspace ? workspace.scrollWidth - workspace.clientWidth : null,
        panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : null,
        horizontallyClippedButtons: visibleButtons
          .map((button) => {
            const rect = button.getBoundingClientRect();
            return { text: (button.textContent || '').trim(), left: rect.left, right: rect.right };
          })
          .filter((button) => button.left < -1 || button.right > innerWidth + 1),
      };
    })()`);
    assert.equal(state.id, sectionId, `${width}x${height} must render ${label}`);
    assert.equal(state.currentLabel, label, `${width}x${height} must identify ${label} as active`);
    assert.equal(state.headingFocused, true, `${width}x${height} must focus the ${label} heading`);
    assert.ok(state.documentOverflow <= 1 && state.workspaceOverflow <= 1 && state.panelOverflow <= 1,
      `${width}x${height} ${label} must not overflow horizontally`);
    assert.deepEqual(state.horizontallyClippedButtons, [],
      `${width}x${height} ${label} must not hide visible action buttons horizontally`);
    sections.push(state);
  }
  return { ...nativeSize, ...navigation, sections };
}

async function verifyEmptyWorkbenchAndSettingsNativeSizes() {
  const { win, errors } = createW4Window([
    '--hrboss-force-empty-jobs=1',
    '--hrboss-w4b-mode=ai-unconfigured',
  ]);
  try {
    win.setSize(1024, 768);
    await win.loadFile(path.join(distRoot, 'index.html'));
    win.webContents.setZoomFactor(1);
    await waitFor(win, "Boolean(document.querySelector('.dashboard-first-job-card'))", 'empty workbench first-job action');
    await delay(180);
    const emptyWorkbench = await win.webContents.executeJavaScript(`(() => {
      const root = document.querySelector('.dashboard-panel');
      const firstJob = document.querySelector('.dashboard-first-job-card');
      const aiGuide = document.querySelector('.dashboard-secondary-guidance');
      const primaryButtons = [...root.querySelectorAll('.ant-btn-primary')]
        .filter((element) => element.offsetParent !== null);
      const primary = primaryButtons[0];
      primary?.focus();
      const primaryRect = primary?.getBoundingClientRect();
      const firstJobRect = firstJob?.getBoundingClientRect();
      const aiGuideRect = aiGuide?.getBoundingClientRect();
      return {
        viewport: [innerWidth, innerHeight],
        primaryLabels: primaryButtons.map((element) => (element.textContent || '').trim()),
        primaryFocused: document.activeElement === primary,
        primaryVisible: Boolean(primaryRect
          && primaryRect.left >= -1 && primaryRect.right <= innerWidth + 1
          && primaryRect.top >= -1 && primaryRect.bottom <= innerHeight + 1),
        aiGuideAfterPrimary: Boolean(firstJobRect && aiGuideRect && aiGuideRect.top >= firstJobRect.bottom),
        aiGuideCollapsed: aiGuide?.querySelector('.ant-collapse-header')?.getAttribute('aria-expanded') === 'false',
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        rootOverflow: root.scrollWidth - root.clientWidth,
      };
    })()`);
    assert.deepEqual(win.getSize(), [1024, 768], 'empty workbench must use a real 1024x768 Electron outer window');
    assert.deepEqual(win.getContentSize(), emptyWorkbench.viewport,
      'empty workbench renderer viewport must match the Electron content area');
    assert.deepEqual(emptyWorkbench.primaryLabels, ['去新建岗位'],
      'an empty workbench must expose new-job as its only visible primary action');
    assert.equal(emptyWorkbench.primaryFocused, true, 'the empty-workbench primary action must accept keyboard focus');
    assert.equal(emptyWorkbench.primaryVisible, true, 'the empty-workbench primary action must remain in the first viewport');
    assert.equal(emptyWorkbench.aiGuideAfterPrimary, true, 'optional AI guidance must follow the first-job action');
    assert.equal(emptyWorkbench.aiGuideCollapsed, true, 'optional AI guidance must default collapsed');
    assert.ok(emptyWorkbench.documentOverflow <= 1 && emptyWorkbench.rootOverflow <= 1,
      'empty workbench must not overflow horizontally at 1024x768');
    const emptyEvidence = await captureEvidence(
      win,
      'hrboss-ai-settings-implementation-20260730-empty-workbench-1024x768',
    );

    await clickDesktopUtilityItem(win, '设置中心');
    await waitFor(win, "Boolean(document.querySelector('#settings-overview'))", 'empty settings overview');
    await waitFor(win, "document.activeElement?.id === 'settings-overview-title'", 'empty settings overview heading focus');
    const emptyReturn = await win.webContents.executeJavaScript(`(() => {
      const alert = document.querySelector('.settings-business-return');
      const button = alert?.querySelector('button');
      const cards = [...document.querySelectorAll('.settings-overview-grid .settings-state-card')];
      return {
        label: (button?.textContent || '').trim(),
        message: (alert?.querySelector('.ant-alert-message')?.textContent || '').trim(),
        cardValues: cards.map((card) => (card.querySelector('strong')?.textContent || '').trim()),
      };
    })()`);
    assert.equal(emptyReturn.label, '返回工作台新建岗位');
    assert.equal(emptyReturn.message, '返回工作台新建岗位');
    assert.deepEqual(emptyReturn.cardValues, ['使用本地录音/转写前检查', '未启用（默认）'],
      'empty settings must keep device and AI in neutral default states');
    const settings1024 = await inspectSettingsSectionsAtNativeSize(win, 1024, 768);
    await clickExactText(win, '.settings-section-nav button', '本机状态');
    const overview1024Evidence = await captureEvidence(
      win,
      'hrboss-ai-settings-implementation-20260730-settings-overview-empty-1024x768',
    );
    await clickExactText(win, '.settings-section-nav button', 'AI 与外部连接');
    const integrations1024Evidence = await captureEvidence(
      win,
      'hrboss-ai-settings-implementation-20260730-settings-integrations-1024x768',
    );

    const settings1280 = await inspectSettingsSectionsAtNativeSize(win, 1280, 800);
    await clickExactText(win, '.settings-section-nav button', '本机状态');
    const overview1280Evidence = await captureEvidence(
      win,
      'hrboss-ai-settings-implementation-20260730-settings-overview-empty-1280x800',
    );
    await clickExactText(win, '.settings-section-nav button', 'AI 与外部连接');
    const integrations1280Evidence = await captureEvidence(
      win,
      'hrboss-ai-settings-implementation-20260730-settings-integrations-1280x800',
    );

    assert.deepEqual(errors, [], 'empty workbench/settings renderer must not emit console errors');
    return {
      empty_workbench: { ...emptyWorkbench, evidence: emptyEvidence },
      empty_business_return: emptyReturn,
      settings_1024x768: settings1024,
      settings_1280x800: settings1280,
      evidence: {
        settings_overview_1024x768: overview1024Evidence,
        settings_integrations_1024x768: integrations1024Evidence,
        settings_overview_1280x800: overview1280Evidence,
        settings_integrations_1280x800: integrations1280Evidence,
      },
    };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function verifyCandidateResumeLayout() {
  const { win, errors } = createRuntimeWindow('candidate-resume-layout');
  try {
    win.setContentSize(1360, 900);
    await win.loadFile(path.join(distRoot, 'index.html'));
    await waitFor(win, "document.querySelector('button.nav-item')", 'resume layout preference seed');
    win.webContents.setZoomFactor(1.5);
    await win.webContents.executeJavaScript("localStorage.setItem('hrboss.ui.candidateListCollapsed.v1', '1')");
    await win.loadFile(path.join(distRoot, 'index.html'));
    await waitFor(win, "document.querySelector('button.nav-item')", 'resume layout navigation');
    const initialCollapsedPreference = await win.webContents.executeJavaScript("localStorage.getItem('hrboss.ui.candidateListCollapsed.v1')");
    assert.equal(initialCollapsedPreference, '1', 'resume regression must start with the persisted collapsed-list preference');
    const initialZoomFactor = win.webContents.getZoomFactor();
    assert.equal(initialZoomFactor, 1.5, 'resume regression must cover the zoom left by the preceding restart scenario');
    win.webContents.setZoomFactor(1);
    win.setContentSize(1360, 900);
    await waitFor(win, 'innerWidth === 1360 && innerHeight === 900', 'resume layout unscaled desktop viewport');
    await clickExactText(win, 'button.nav-item', '候选人');
    await waitFor(win,
      "document.querySelector('.candidate-workspace .candidate-sider-collapsed') && document.querySelector('.candidate-workspace button[aria-label=\"展开候选人列表\"]')",
      'resume candidate workspace with restored collapsed preference');
    await clickExactText(win, '.candidate-workspace button[aria-label="展开候选人列表"]', '展开候选人列表');
    await waitFor(win,
      "document.querySelector('.candidate-sider-open .candidate-card') && localStorage.getItem('hrboss.ui.candidateListCollapsed.v1') === '0'",
      'resume candidate list actually expanded before selection');
    await win.webContents.executeJavaScript("document.querySelector('.candidate-sider-open .candidate-card').click()");
    await waitFor(win, "document.querySelectorAll('.resume-entry').length === 3", 'long synthetic resume entries');
    await win.webContents.executeJavaScript("document.querySelector('.resume-clean-layout')?.scrollIntoView({ block: 'start' })");

    async function inspect(name, expectListOpen) {
      await delay(160);
      const measurement = await win.webContents.executeJavaScript(`(() => {
        const layout = document.querySelector('.resume-clean-layout');
        const box = (element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
        };
        const textBounds = (element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return [...range.getClientRects()].map((rect) => ({ left: rect.left, right: rect.right, width: rect.width }));
        };
        return {
          viewport: [innerWidth, innerHeight],
          listOpen: Boolean(document.querySelector('.candidate-sider-open')),
          workspaceWidth: document.querySelector('.candidate-v2-workspace').getBoundingClientRect().width,
          layoutOverflow: layout.scrollWidth - layout.clientWidth,
          main: box(layout.querySelector('.resume-main-column')),
          side: box(layout.querySelector('.resume-side-column')),
          entries: [...layout.querySelectorAll('.resume-entry')].map((entry) => {
            const title = entry.querySelector('strong');
            const meta = entry.querySelector('.resume-entry-head span');
            return {
              box: box(entry), titleBox: box(title), text: title.textContent,
              titleFontSize: parseFloat(getComputedStyle(title).fontSize),
              textRects: [title, meta, ...entry.querySelectorAll('li')].filter(Boolean).flatMap(textBounds),
            };
          }),
        };
      })()`);
      const evidence = await captureEvidence(win, name);
      fs.writeFileSync(path.join(evidenceDir, `${name}.json`), `${JSON.stringify(measurement, null, 2)}\n`, { mode: 0o600 });
      assert.deepEqual(measurement.viewport, [1360, 900], `${name}: viewport must not inherit a previous scenario's zoom`);
      assert.equal(measurement.listOpen, expectListOpen);
      if (expectListOpen) assert.ok(measurement.workspaceWidth < 720,
        'open candidate list must exercise a narrow detail container in a wide desktop window');
      else assert.ok(measurement.workspaceWidth > 720,
        'focused detail must also exercise the wide resume layout');
      assert.ok(measurement.layoutOverflow <= 1, `${name}: resume content must not overflow its panel`);
      const { main, side } = measurement;
      assert.ok(side.left >= main.right - 1 || side.top >= main.bottom - 1,
        `${name}: resume main content and side facts must not overlap`);
      for (const entry of measurement.entries) {
        assert.ok(entry.titleBox.width >= Math.min(160, entry.box.width * 0.7),
          `${name}: long project title must not be squeezed into a single-character column`);
        assert.ok(entry.textRects.every((rect) => rect.left >= entry.box.left - 1 && rect.right <= entry.box.right + 1),
          `${name}: title, role/date and body text must remain inside their experience card`);
      }
      return { ...measurement, evidence };
    }

    const split = await inspect('candidate-resume-split-1360x900', true);
    await win.webContents.executeJavaScript("document.querySelector('button[aria-label=\"收起候选人列表\"]')?.click()");
    await waitFor(win, "!document.querySelector('.candidate-sider-open')", 'resume focused detail');
    const focused = await inspect('candidate-resume-focused-1360x900', false);
    assert.deepEqual(errors, [], 'resume layout renderer must not emit errors');
    return { initialCollapsedPreference, initialZoomFactor, split, focused };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function run() {
  if (process.env.HRBOSS_VISUAL_RUNTIME_RESUME_LAYOUT_ONLY === '1') {
    const result = { ok: true, contract: 'UI-VISUAL-RUNTIME-RESUME-LAYOUT', candidate_resume_layout: await verifyCandidateResumeLayout() };
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return result;
  }
  if (process.env.HRBOSS_VISUAL_RUNTIME_AI_ENTRIES_ONLY === '1') {
    const aiEntries = await verifyRemainingAiEntryFirstUseReturns();
    const result = {
      ok: true,
      contract: 'UI-VISUAL-RUNTIME-AI-ENTRIES',
      ai_entries: aiEntries,
    };
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return result;
  }
  if (process.env.HRBOSS_VISUAL_RUNTIME_EMPTY_SETTINGS_ONLY === '1') {
    const emptyAndSettings = await verifyEmptyWorkbenchAndSettingsNativeSizes();
    const result = {
      ok: true,
      contract: 'UI-VISUAL-RUNTIME-EMPTY-SETTINGS',
      empty_and_settings: emptyAndSettings,
    };
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return result;
  }
  if (process.env.HRBOSS_VISUAL_RUNTIME_W4B_DEEP_ONLY === '1') {
    const deepProfileAiSettings = await verifyW4BAiSettingsContext();
    const result = {
      ok: true,
      contract: 'UI-VISUAL-RUNTIME-W4B-DEEP',
      deep_profile_ai_settings: deepProfileAiSettings,
    };
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return result;
  }
  if (process.env.HRBOSS_VISUAL_RUNTIME_W4B_JD_ONLY === '1') {
    const jobJdAiSettings = await verifyW4BJobJdAiSettingsContext();
    const result = {
      ok: true,
      contract: 'UI-VISUAL-RUNTIME-W4B-JD',
      job_jd_ai_settings: jobJdAiSettings,
    };
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return result;
  }
  if (process.env.HRBOSS_VISUAL_RUNTIME_W4B_AI_ONLY === '1') {
    const keepAlive = new BrowserWindow({ show: false, width: 1, height: 1 });
    try {
      await keepAlive.loadURL('about:blank');
      const jobJdAiSettings = await verifyW4BJobJdAiSettingsContext();
      const deepProfileAiSettings = await verifyW4BAiSettingsContext();
      const result = {
        ok: true,
        contract: 'UI-VISUAL-RUNTIME-W4B-AI',
        job_jd_ai_settings: jobJdAiSettings,
        deep_profile_ai_settings: deepProfileAiSettings,
      };
      fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
      return result;
    } finally {
      if (!keepAlive.isDestroyed()) keepAlive.destroy();
    }
  }
  if (process.env.HRBOSS_VISUAL_RUNTIME_W4_ONLY === '1') {
    const w4Runtime = await verifyW4Runtime();
    const result = {
      ok: true,
      contract: 'UI-VISUAL-RUNTIME-W4',
      w4_runtime: w4Runtime,
    };
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return result;
  }
  if (process.env.HRBOSS_VISUAL_RUNTIME_W3_ONLY === '1') {
    const w3InterviewRuntime = await verifyW3InterviewRuntime();
    const result = {
      ok: true,
      contract: 'UI-VISUAL-RUNTIME-W3',
      w3_interview_runtime: w3InterviewRuntime,
    };
    fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    return result;
  }
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(ROOT, "tests/check-ui-visual-runtime-preload.js"),
    },
  });
  const errors = [];
  win.webContents.on('console-message', (event) => {
    if (event && (event.level === 'error' || Number(event.level) >= 3)) errors.push(event.message);
  });
  win.webContents.on('render-process-gone', (_event, details) => errors.push(`renderer gone: ${JSON.stringify(details)}`));
  await win.loadFile(path.join(distRoot, 'index.html'));
  win.webContents.focus();
  await waitFor(win, 'document.hasFocus()', 'focused visual runtime renderer');
  await waitFor(win, "document.querySelector('button.nav-item')", 'main navigation');

  const skipLinkInitialFocus = await win.webContents.executeJavaScript(`(() => ({
    tag: document.activeElement?.tagName || '',
    id: document.activeElement?.id || '',
  }))()`);
  assert.deepEqual(skipLinkInitialFocus, { tag: 'BODY', id: '' },
    'a fresh renderer must begin before the first keyboard focus target');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  await waitFor(win, "document.activeElement?.classList.contains('skip-link')", 'first Tab skip link focus');
  await delay(80);
  const skipLinkFocused = await win.webContents.executeJavaScript(`(() => {
    const link = document.activeElement;
    const box = link?.getBoundingClientRect();
    const style = link ? getComputedStyle(link) : null;
    return {
      tag: link?.tagName || '',
      text: (link?.textContent || '').trim(),
      href: link?.getAttribute('href') || '',
      focusVisible: Boolean(link?.matches(':focus-visible')),
      outlineStyle: style?.outlineStyle || '',
      outlineWidth: style?.outlineWidth || '',
      transform: style?.transform || '',
      rect: box ? { top: Math.round(box.top), left: Math.round(box.left), right: Math.round(box.right), bottom: Math.round(box.bottom) } : null,
      insideViewport: Boolean(box && box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth),
    };
  })()`);
  assert.deepEqual({ tag: skipLinkFocused.tag, text: skipLinkFocused.text, href: skipLinkFocused.href },
    { tag: 'A', text: '跳到主要内容', href: '#main-workspace' },
    'the first Tab must focus the skip link');
  assert.equal(skipLinkFocused.insideViewport, true,
    `the keyboard-focused skip link must be inside the viewport; state=${JSON.stringify(skipLinkFocused)}`);
  assert.notEqual(skipLinkFocused.outlineStyle, 'none', 'the keyboard-focused skip link must expose a visible outline');
  assert.notEqual(skipLinkFocused.outlineWidth, '0px', 'the keyboard-focused skip link outline must have width');
  assert.equal(skipLinkFocused.transform, 'none', 'the keyboard-focused skip link must not remain translated off-screen');
  const skipLinkEvidence = await captureEvidence(win, 'skip-link-keyboard-1100x720');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(win, "document.activeElement?.id === 'main-workspace'", 'skip link main focus target');
  const skipLinkActivation = await win.webContents.executeJavaScript(`(() => ({
    id: document.activeElement?.id || '',
    tag: document.activeElement?.tagName || '',
    visibleMainCount: [...document.querySelectorAll('main#main-workspace')]
      .filter((element) => element.getClientRects().length).length,
  }))()`);
  assert.deepEqual(skipLinkActivation, { id: 'main-workspace', tag: 'MAIN', visibleMainCount: 1 },
    'Enter on the skip link must focus the single visible main landmark');

  await clickExactText(win, 'button.nav-item', '工作台');
  await waitFor(win, "document.querySelector('.dashboard-v2-focus-grid')", 'workbench focus grid');
  const workbenchDesktopLayout = await win.webContents.executeJavaScript(`(() => {
    const resolveTokenBackground = (name) => {
      const probe = document.createElement('span');
      probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none';
      probe.style.backgroundColor = 'var(' + name + ')';
      document.body.appendChild(probe);
      const background = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return background;
    };
    const todo = document.querySelector('.dashboard-todo-card')?.getBoundingClientRect();
    const summary = document.querySelector('.dashboard-v2-summary')?.getBoundingClientRect();
    const grid = document.querySelector('.dashboard-v2-focus-grid');
    return {
      areas: grid ? getComputedStyle(grid).gridTemplateAreas : '',
      todoTop: todo?.top || 0,
      summaryTop: summary?.top || 0,
      sidebarWidth: document.querySelector('.app-nav')?.getBoundingClientRect().width || 0,
      sidebarBackground: getComputedStyle(document.querySelector('.app-nav')).backgroundColor,
      activeNavigationBackground: getComputedStyle(document.querySelector('.nav-item.active')).backgroundColor,
      primaryBackground: getComputedStyle(document.querySelector('.ant-btn-primary')).backgroundColor,
      primarySoftTokenBackground: resolveTokenBackground('--hb-primary-soft'),
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  assert.equal(workbenchDesktopLayout.areas, '"todos summary"',
    '1100px workbench must keep the decision queue beside the compact recruitment summary');
  assert.ok(Math.abs(workbenchDesktopLayout.todoTop - workbenchDesktopLayout.summaryTop) <= 1,
    '1100px workbench columns must share one top alignment');
  assert.ok(workbenchDesktopLayout.sidebarWidth >= 195 && workbenchDesktopLayout.sidebarWidth <= 197,
    'desktop shell must use the 196px macOS-style source-list width');
  assert.equal(workbenchDesktopLayout.sidebarBackground, 'rgb(238, 240, 243)',
    'desktop shell must use a light neutral sidebar');
  assert.equal(workbenchDesktopLayout.activeNavigationBackground, workbenchDesktopLayout.primarySoftTokenBackground,
    'selected navigation must consume the root primary-soft token');
  assert.equal(workbenchDesktopLayout.primaryBackground, 'rgb(0, 103, 197)',
    'primary actions must use the accessible system blue');
  assert.ok(workbenchDesktopLayout.horizontalOverflow <= 1, '1100px workbench must not overflow horizontally');
  win.setContentSize(1440, 900);
  await delay(180);
  const workbenchWideLayout = await win.webContents.executeJavaScript(`(() => {
    const todo = document.querySelector('.dashboard-todo-card')?.getBoundingClientRect();
    const summary = document.querySelector('.dashboard-v2-summary')?.getBoundingClientRect();
    const grid = document.querySelector('.dashboard-v2-focus-grid');
    return {
      areas: grid ? getComputedStyle(grid).gridTemplateAreas : '',
      aligned: Math.abs((todo?.top || 0) - (summary?.top || 0)) <= 1,
    };
  })()`);
  assert.equal(workbenchWideLayout.areas, '"todos summary"',
    '1440px workbench must keep the decision queue beside the compact recruitment summary');
  assert.equal(workbenchWideLayout.aligned, true, 'wide workbench columns must share one top alignment');
  const workbenchEvidence = await captureEvidence(win, 'workbench-1440x900');
  win.setContentSize(1100, 720);
  await delay(160);

  await clickExactText(win, 'button.nav-item', '候选人');
  await waitFor(win, "document.querySelector('.candidate-card')", 'candidate list');
  await clickExactText(win, 'button', '上传简历建档');
  await waitFor(win, "document.querySelector('[role=dialog] #resume-candidate-name')", 'resume intake dialog');
  await waitFor(win, "document.activeElement?.id === 'resume-candidate-name'", 'missing resume name initial focus');
  const resumeInitialFocus = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#resume-candidate-name');
    return {
      focused: document.activeElement === input,
      required: input?.getAttribute('aria-required') || '',
      invalid: input?.getAttribute('aria-invalid') || '',
    };
  })()`);
  assert.deepEqual(resumeInitialFocus, { focused: true, required: 'true', invalid: 'false' },
    'missing resume name must receive initial focus without claiming an error before submit');

  const resumeModal720 = await getResumeModalLayout(win);
  assert.equal(resumeModal720.dialogVisible, true);
  assert.equal(resumeModal720.bodyOverflowY, 'auto', 'resume modal body must own vertical scrolling');
  assert.equal(resumeModal720.gridColumnCount, 2, 'common desktop width must use the compact two-column field grid');
  assert.equal(resumeModal720.previewMaxHeight, '96px', 'resume preview must remain compact by default');
  assert.ok(resumeModal720.content.top >= 16 && resumeModal720.content.bottom <= resumeModal720.viewport[1] - 16,
    'resume modal content must fit inside a 720px-high viewport');
  assert.ok(resumeModal720.footerButtonBottom <= resumeModal720.viewport[1] - 16,
    'resume modal actions must remain visible at 720px height');
  const resumeModalEvidence = await captureEvidence(win, 'resume-intake-1100x720');

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(win, "document.querySelector('#resume-candidate-name')?.offsetParent === null", 'resume intake Escape close');
  await waitFor(win,
    "document.activeElement?.tagName === 'BUTTON' && document.activeElement?.textContent.includes('上传简历建档')",
    'resume intake Escape focus restore');
  const resumeEscapeFocus = await win.webContents.executeJavaScript(`(() => ({
    tag: document.activeElement?.tagName || '',
    text: document.activeElement?.textContent.trim() || '',
  }))()`);
  assert.equal(resumeEscapeFocus.tag, 'BUTTON', 'resume intake Escape must restore focus to its trigger button');
  assert.match(resumeEscapeFocus.text, /上传简历建档/, 'resume intake Escape must restore focus to the upload trigger');

  await clickExactText(win, 'button', '上传简历建档');
  await waitFor(win, "document.querySelector('[role=dialog] #resume-candidate-name')", 'reopened resume intake dialog');
  await waitFor(win, "document.activeElement?.id === 'resume-candidate-name'", 'reopened resume name initial focus');

  win.setContentSize(680, 720);
  await delay(160);
  const resumeModalNarrow = await getResumeModalLayout(win);
  assert.equal(resumeModalNarrow.gridColumnCount, 1, 'narrow resume modal fields must stack into one column');
  assert.ok(resumeModalNarrow.footerButtonBottom <= resumeModalNarrow.viewport[1] - 16,
    'narrow resume modal actions must remain visible');

  win.setContentSize(1100, 480);
  await delay(160);
  const resumeModalLowHeight = await getResumeModalLayout(win);
  assert.ok(resumeModalLowHeight.bodyScrollHeight > resumeModalLowHeight.bodyClientHeight,
    'low-height resume modal must scroll inside the body');
  assert.ok(resumeModalLowHeight.content.top >= 16 && resumeModalLowHeight.content.bottom <= resumeModalLowHeight.viewport[1] - 16,
    'low-height resume modal must remain fully inside the viewport');
  assert.ok(resumeModalLowHeight.footerButtonBottom <= resumeModalLowHeight.viewport[1] - 16,
    'low-height resume modal actions must remain visible');

  win.setContentSize(1100, 720);
  await delay(160);
  await clickExactText(win, '[role=dialog] button', '确认建档');
  await waitFor(win,
    "document.activeElement?.id === 'resume-candidate-name' && document.activeElement?.getAttribute('aria-invalid') === 'true'",
    'invalid resume name focus recovery');
  const resumeInvalidState = await win.webContents.executeJavaScript(`(async () => {
    const input = document.querySelector('#resume-candidate-name');
    const error = document.querySelector('#resume-candidate-name-error');
    const runtime = await window.runtimeInfo.get();
    return {
      focused: document.activeElement === input,
      describedBy: input?.getAttribute('aria-describedby') || '',
      errorRole: error?.getAttribute('role') || '',
      errorText: error?.textContent.trim() || '',
      resumeCommitCalls: runtime.resumeCommitCalls,
    };
  })()`);
  assert.deepEqual(resumeInvalidState, {
    focused: true,
    describedBy: 'resume-candidate-name-error',
    errorRole: 'alert',
    errorText: '请确认候选人姓名后再建档。',
    resumeCommitCalls: 0,
  }, 'invalid resume intake must expose the error, restore focus and perform zero writes');
  await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#resume-candidate-name');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, '合成候选人补录');
    input?.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(win,
    "document.querySelector('#resume-candidate-name')?.value === '合成候选人补录' && document.querySelector('#resume-candidate-name')?.getAttribute('aria-invalid') === 'false'",
    'corrected resume name');
  await clickExactText(win, '[role=dialog] button', '确认建档');
  await waitFor(win,
    "document.querySelector('.resume-intake-modal-footer .ant-btn-primary')?.classList.contains('ant-btn-loading')",
    'resume API submission busy state');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await delay(100);
  const resumeSubmitBusy = await win.webContents.executeJavaScript(`(async () => {
    const content = document.querySelector('#resume-candidate-name')?.closest('.ant-modal-content');
    const buttons = [...(content?.querySelectorAll('.ant-modal-footer button') || [])];
    const primary = buttons.find((button) => button.classList.contains('ant-btn-primary'));
    const cancel = buttons.find((button) => !button.classList.contains('ant-btn-primary'));
    const runtime = await window.runtimeInfo.get();
    return {
      dialogVisible: Boolean(content?.offsetParent),
      primaryLoading: primary?.classList.contains('ant-btn-loading') === true,
      primaryDisabled: primary?.disabled === true,
      cancelDisabled: cancel?.disabled === true,
      fieldsDisabled: [...content.querySelectorAll('.resume-intake-fields input')].every((input) => input.disabled),
      closeVisible: Boolean(content.querySelector('.ant-modal-close')),
      resumeCommitCalls: runtime.resumeCommitCalls,
    };
  })()`);
  assert.deepEqual(resumeSubmitBusy, {
    dialogVisible: true,
    primaryLoading: true,
    primaryDisabled: true,
    cancelDisabled: true,
    fieldsDisabled: true,
    closeVisible: false,
    resumeCommitCalls: 1,
  }, 'resume API submission must lock Escape, close, actions and editable fields');
  await waitFor(win,
    "document.activeElement?.getAttribute('role') === 'alert' && Boolean(document.querySelector('.resume-intake-submit-error'))",
    'resume API rejection summary');
  const resumeRejectedState = await win.webContents.executeJavaScript(`(async () => {
    const input = document.querySelector('#resume-candidate-name');
    const alert = document.querySelector('.resume-intake-submit-error');
    const runtime = await window.runtimeInfo.get();
    return {
      dialogVisible: Boolean(input?.offsetParent),
      retainedName: input?.value || '',
      inputEnabled: input?.disabled === false,
      focusedAlert: Boolean(document.activeElement?.contains(alert) || alert?.contains(document.activeElement)),
      errorText: alert?.textContent.trim() || '',
      resumeCommitCalls: runtime.resumeCommitCalls,
    };
  })()`);
  assert.equal(resumeRejectedState.dialogVisible, true);
  assert.equal(resumeRejectedState.retainedName, '合成候选人补录');
  assert.equal(resumeRejectedState.inputEnabled, true);
  assert.equal(resumeRejectedState.focusedAlert, true);
  assert.match(resumeRejectedState.errorText, /简历建档失败，草稿仍保留/);
  assert.match(resumeRejectedState.errorText, /合成简历建档拒绝/);
  assert.equal(resumeRejectedState.resumeCommitCalls, 1);
  const resumeRejectedEvidence = await captureEvidence(win, 'resume-intake-rejected-1100x720');

  await clickExactText(win, '[role=dialog] button', '确认建档');
  await waitFor(win,
    "document.querySelector('.resume-intake-modal-footer .ant-btn-primary')?.classList.contains('ant-btn-loading')",
    'resume retry busy state');
  await waitFor(win, "document.querySelector('#resume-candidate-name')?.offsetParent === null",
    'committed resume draft closes before refresh');
  const resumeCommittedRefresh = await win.webContents.executeJavaScript(`(async () => {
    const upload = [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === '上传简历建档');
    const runtime = await window.runtimeInfo.get();
    return {
      dialogVisible: Boolean(document.querySelector('#resume-candidate-name')?.offsetParent),
      uploadLoading: upload?.classList.contains('ant-btn-loading') === true,
      resumeCommitCalls: runtime.resumeCommitCalls,
    };
  })()`);
  assert.deepEqual(resumeCommittedRefresh, {
    dialogVisible: false,
    uploadLoading: true,
    resumeCommitCalls: 2,
  }, 'committed resume draft must close and keep intake locked during refresh');
  await waitFor(win,
    "[...document.querySelectorAll('button')].some((button) => button.textContent.trim() === '上传简历建档' && !button.classList.contains('ant-btn-loading'))",
    'resume committed refresh completion');
  await waitFor(win, `(() => {
    const workspaceElement = document.querySelector('.candidate-workspace');
    const workspace = workspaceElement?.getBoundingClientRect();
    const sider = document.querySelector('.candidate-sider')?.getBoundingClientRect();
    const hasSelection = workspaceElement?.classList.contains('candidate-workspace-has-selection') === true;
    const targetRatio = hasSelection ? 0.46 : 0.68;
    const minimumWidth = hasSelection ? 400 : 520;
    const maximumWidth = hasSelection ? 620 : 820;
    const expectedWidth = Math.min(
      maximumWidth,
      Math.max(minimumWidth, (workspace?.width || 0) * targetRatio),
    );
    return Boolean(workspace?.width && sider?.width && Math.abs(sider.width - expectedWidth) <= 1);
  })()`, 'candidate queue elastic width transition');
  const candidateQueueTypography = await win.webContents.executeJavaScript(`(() => {
    const selectors = [
      '.candidate-list-meta',
      '.candidate-queue-tab',
      '.assessment-ranking-banner',
      '.candidate-row-state',
      '.candidate-row-summary',
      '.candidate-row-next',
      '.candidate-row-meta',
    ];
    const fontSizes = selectors.map((selector) => {
      const element = document.querySelector(selector);
      return element ? Number.parseFloat(getComputedStyle(element).fontSize) : null;
    }).filter(Number.isFinite);
    const workspaceElement = document.querySelector('.candidate-workspace');
    const workspace = workspaceElement?.getBoundingClientRect();
    const sider = document.querySelector('.candidate-sider')?.getBoundingClientRect();
    const hasSelection = workspaceElement?.classList.contains('candidate-workspace-has-selection') === true;
    const targetRatio = hasSelection ? 0.46 : 0.68;
    const minimumWidth = hasSelection ? 400 : 520;
    const maximumWidth = hasSelection ? 620 : 820;
    const expectedSiderWidth = Math.min(
      maximumWidth,
      Math.max(minimumWidth, (workspace?.width || 0) * targetRatio),
    );
    return {
      minFontSize: Math.min(...fontSizes),
      workspaceWidth: workspace?.width || 0,
      siderWidth: sider?.width || 0,
      expectedSiderWidth,
      hasSelection,
      directQueueCount: document.querySelectorAll('.candidate-queue-tabs > button').length,
      candidateTabStopCount: document.querySelectorAll('.candidate-card[tabindex="0"]').length,
      candidateRovingOptionCount: document.querySelectorAll('.candidate-card[role="option"][tabindex="-1"]').length,
      moreQueueVisible: Boolean(document.querySelector('.candidate-queue-more')?.offsetParent),
      rowStatusTexts: [...document.querySelectorAll('.candidate-row-state')]
        .map((element) => (element.textContent || '').trim()),
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  assert.ok(candidateQueueTypography.minFontSize >= 12, 'candidate queue decision text must stay at or above 12px');
  assert.ok(candidateQueueTypography.workspaceWidth > 0, 'candidate workspace must expose a measurable width');
  assert.ok(Math.abs(candidateQueueTypography.siderWidth - candidateQueueTypography.expectedSiderWidth) <= 1,
    `candidate queue must follow the selected/unselected elastic width contract: ${JSON.stringify(candidateQueueTypography)}`);
  assert.ok(candidateQueueTypography.directQueueCount <= 4,
    'candidate queue must expose no more than three direct queues plus one overflow control');
  assert.equal(candidateQueueTypography.candidateTabStopCount, 1,
    'candidate queue must expose exactly one roving Tab stop');
  assert.ok(candidateQueueTypography.candidateRovingOptionCount >= 1,
    'remaining candidate options must leave the linear Tab path');
  assert.equal(candidateQueueTypography.moreQueueVisible, true, 'remaining queue projections must stay reachable from More');
  // Rows whose disposition is still the default render no status chip at all,
  // so presence of '新入库' can no longer stand in for "codes are localized".
  // Assert the underlying rule directly, over every code rather than just one.
  const RAW_DISPOSITION_CODES = ['new', 'under_review', 'continue_process', 'hold',
    'rejected', 'talent_pool', 'hired', 'candidate_withdrew', 'do_not_contact'];
  assert.ok(candidateQueueTypography.rowStatusTexts
    .every((text) => !RAW_DISPOSITION_CODES.some((code) => text.includes(code))),
  `candidate source list must never leak a raw disposition code: ${JSON.stringify(candidateQueueTypography.rowStatusTexts)}`);
  assert.ok(candidateQueueTypography.rowStatusTexts.every((label) => label.toLowerCase() !== 'new'),
    'candidate source list must not expose raw English disposition codes');
  assert.ok(candidateQueueTypography.horizontalOverflow <= 1, 'candidate queue must not introduce document overflow');
  const candidateActionMenu1100 = await verifyCandidateActionMenu(
    win,
    'candidate-action-menu-1100x720',
  );

  const moreQueueClicked = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('.candidate-queue-more');
    if (!button) return false;
    button.focus();
    button.click();
    return true;
  })()`);
  assert.equal(moreQueueClicked, true, 'candidate queue must expose a clickable More control');
  await waitFor(win, "[...document.querySelectorAll('.ant-dropdown-menu-item')].some((element) => element.offsetParent !== null)",
    'candidate overflow queue menu');
  const moreQueueItems = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.ant-dropdown-menu-item')]
    .filter((element) => element.offsetParent !== null)
    .map((element) => (element.textContent || '').trim())`);
  for (const label of ['暂缓', '新推荐', '待沟通', '已归档']) {
    assert.ok(moreQueueItems.some((item) => item.startsWith(label)), `candidate More menu must retain the ${label} queue`);
  }
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(win, "![...document.querySelectorAll('.ant-dropdown-menu-item')].some((element) => element.offsetParent !== null)",
    'candidate overflow queue menu close');

  const candidateListIdentity = await win.webContents.executeJavaScript(`(() => {
    const cards = [...document.querySelectorAll('.candidate-card')]
      .filter((card) => card.getClientRects().length > 0);
    return cards.map((card) => {
      const name = card.querySelector('.candidate-name');
      const disambiguator = card.querySelector('.candidate-row-disambiguator');
      return {
        name: (name?.textContent || '').trim(),
        fullNameTitle: name?.getAttribute('title') || '',
        disambiguator: (disambiguator?.textContent || '').trim(),
        disambiguatorTitle: disambiguator?.getAttribute('title') || '',
        truthTitle: card.getAttribute('title') || '',
      };
    });
  })()`);
  assert.ok(candidateListIdentity.length > 0, 'candidate list must expose at least one visible identity row');
  assert.ok(candidateListIdentity.every((row) => row.name
    && row.fullNameTitle === `完整姓名：${row.name}`
    && row.disambiguator
    && row.disambiguatorTitle
    && row.truthTitle.includes(`姓名：${row.name}`)),
  'every visible candidate row must retain full-name access and a stable disambiguator');

  await win.webContents.executeJavaScript("document.querySelector('.candidate-search-row input').focus()");
  let candidateKeyboardFocus = null;
  for (let index = 0; index < 12; index += 1) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await delay(24);
    candidateKeyboardFocus = await win.webContents.executeJavaScript(`(() => {
      const active = document.activeElement;
      const style = active ? getComputedStyle(active) : null;
      return {
        isCandidate: Boolean(active?.classList.contains('candidate-card')),
        focusVisible: Boolean(active?.matches(':focus-visible')),
        boxShadow: style?.boxShadow || '',
      };
    })()`);
    if (candidateKeyboardFocus.isCandidate) break;
  }
  await delay(180);
  candidateKeyboardFocus = await win.webContents.executeJavaScript(`(() => {
    const active = document.activeElement;
    const style = active ? getComputedStyle(active) : null;
    return {
      isCandidate: Boolean(active?.classList.contains('candidate-card')),
      focusVisible: Boolean(active?.matches(':focus-visible')),
      boxShadow: style?.boxShadow || '',
      label: active?.getAttribute('aria-label') || '',
      name: active?.querySelector('.candidate-name')?.textContent.trim() || '',
      tabStopCount: document.querySelectorAll('.candidate-card[tabindex="0"]').length,
    };
  })()`);
  assert.equal(candidateKeyboardFocus?.isCandidate, true, 'Tab must reach the first candidate card');
  assert.equal(candidateKeyboardFocus?.tabStopCount, 1, 'candidate list must retain a single Tab stop while focused');
  assert.notEqual(candidateKeyboardFocus?.boxShadow, 'none', 'keyboard focus on a candidate must expose a visible ring');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
  await waitFor(win,
    `document.activeElement?.classList.contains('candidate-card') && document.activeElement?.getAttribute('aria-label') !== ${JSON.stringify(candidateKeyboardFocus.label)}`,
    'candidate ArrowDown roving focus');
  const candidateRovingFocus = await win.webContents.executeJavaScript(`(() => ({
    label: document.activeElement?.getAttribute('aria-label') || '',
    name: document.activeElement?.querySelector('.candidate-name')?.textContent.trim() || '',
    role: document.activeElement?.getAttribute('role') || '',
    tabStopCount: document.querySelectorAll('.candidate-card[tabindex="0"]').length,
    selected: document.activeElement?.getAttribute('aria-selected') || '',
    focusVisible: Boolean(document.activeElement?.matches(':focus-visible')),
    boxShadow: document.activeElement ? getComputedStyle(document.activeElement).boxShadow : '',
  }))()`);
  assert.equal(candidateRovingFocus.role, 'option', 'ArrowDown must keep focus on a candidate option');
  assert.equal(candidateRovingFocus.tabStopCount, 1, 'ArrowDown must move, not multiply, the roving Tab stop');
  assert.notEqual(candidateRovingFocus.boxShadow, 'none', 'ArrowDown focus must retain a non-none focus ring');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Up' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Up' });
  await waitFor(win,
    `document.activeElement?.classList.contains('candidate-card') && document.activeElement?.getAttribute('aria-label') === ${JSON.stringify(candidateKeyboardFocus.label)}`,
    'candidate ArrowUp roving focus return');
  const candidateRovingReturnFocus = await win.webContents.executeJavaScript(`(() => ({
    label: document.activeElement?.getAttribute('aria-label') || '',
    role: document.activeElement?.getAttribute('role') || '',
    tabStopCount: document.querySelectorAll('.candidate-card[tabindex="0"]').length,
  }))()`);
  assert.deepEqual(candidateRovingReturnFocus, {
    label: candidateKeyboardFocus.label,
    role: 'option',
    tabStopCount: 1,
  }, 'ArrowUp must restore the original candidate without multiplying Tab stops');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
  await waitFor(win,
    `document.activeElement?.classList.contains('candidate-card') && document.activeElement?.getAttribute('aria-label') === ${JSON.stringify(candidateRovingFocus.label)}`,
    'candidate ArrowDown focus before Enter activation');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(win, "document.querySelector('.candidate-domain-tabs')", 'candidate detail');
  await delay(80);
  const candidateEnterTargetName = candidateRovingFocus.name;
  const candidateEnterActivation = await win.webContents.executeJavaScript(`(() => ({
    detailName: document.querySelector('.candidate-v2-hero h2')?.textContent.trim() || '',
    selectedLabels: [...document.querySelectorAll('.candidate-card[aria-selected="true"]')]
      .map((element) => element.getAttribute('aria-label') || ''),
  }))()`);
  assert.ok(candidateEnterTargetName && candidateEnterTargetName !== candidateKeyboardFocus.name,
    'ArrowDown must focus a different candidate before activation');
  assert.equal(candidateEnterActivation.detailName, candidateEnterTargetName,
    'Enter must render the exact focused candidate detail');
  assert.equal(candidateEnterActivation.selectedLabels.length, 1,
    'Enter must select exactly one candidate in the source list');
  assert.match(candidateEnterActivation.selectedLabels[0], new RegExp(candidateEnterTargetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'Enter must synchronize the source-list selection with the rendered detail');

  const listOpenForSpaceActivation = await win.webContents.executeJavaScript(
    "Boolean(document.querySelector('.candidate-sider-open'))",
  );
  assert.equal(listOpenForSpaceActivation, true,
    'candidate selection at 1100px must preserve the visible list for the retained Space activation check');
  await waitFor(win, "Boolean(document.querySelector('.candidate-sider-open'))", 'candidate list before Space activation');
  await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.candidate-card[tabindex="0"]');
    card?.focus();
  })()`);
  const candidateBeforeSpaceMove = await win.webContents.executeJavaScript(
    "document.activeElement?.getAttribute('aria-label') || ''",
  );
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' });
  await waitFor(win,
    `document.activeElement?.classList.contains('candidate-card') && document.activeElement?.getAttribute('aria-label') !== ${JSON.stringify(candidateBeforeSpaceMove)}`,
    'candidate Space activation target');
  const candidateSpaceTarget = await win.webContents.executeJavaScript(`(() => {
    const label = document.activeElement?.getAttribute('aria-label') || '';
    const name = document.activeElement?.querySelector('.candidate-name')?.textContent.trim() || '';
    return { label, name };
  })()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await waitFor(win,
    `document.querySelector('.candidate-v2-hero h2')?.textContent.trim() === ${JSON.stringify(candidateSpaceTarget.name)}`,
    'candidate Space activation');
  await delay(100);
  const candidateSpaceActivation = await win.webContents.executeJavaScript(`(() => ({
    detailName: document.querySelector('.candidate-v2-hero h2')?.textContent.trim() || '',
    selectedLabels: [...document.querySelectorAll('.candidate-card[aria-selected="true"]')]
      .map((element) => element.getAttribute('aria-label') || ''),
  }))()`);
  assert.equal(candidateSpaceActivation.detailName, candidateSpaceTarget.name,
    'Space must render the exact focused candidate detail');
  assert.equal(candidateSpaceActivation.selectedLabels.length, 1,
    'Space must preserve a single source-list selection');
  assert.equal(candidateSpaceActivation.selectedLabels[0], candidateSpaceTarget.label,
    'Space must synchronize the source-list selection with the rendered detail');

  const candidateDecisionLayout = await win.webContents.executeJavaScript(`(() => {
    const detail = document.querySelector('.candidate-detail-content');
    const facts = document.querySelector('.candidate-v2-facts-list');
    const taskbar = document.querySelector('.candidate-taskbar');
    const workspace = document.querySelector('.candidate-v2-workspace');
    const body = document.querySelector('.candidate-v2-body');
    const collapse = document.querySelector('button[aria-label="收起候选人列表"]');
    const candidateToolbar = document.querySelector('.candidate-sider-toolbar');
    const candidateTitle = document.querySelector('.candidate-sider-title');
    const upload = [...document.querySelectorAll('.candidate-sider-toolbar button')]
      .find((button) => (button.textContent || '').trim() === '上传简历建档');
    const operations = document.querySelector('.candidate-module-actions button');
    const workspaceHead = document.querySelector('.candidate-workspace-head');
    const domainNavigation = document.querySelector('.candidate-domain-navigation');
    const domainPanel = document.querySelector('.candidate-domain-panel');
    const identityAnchor = document.querySelector('.candidate-identity-anchor');
    const selectors = [
      '.candidate-eyebrow',
      '.candidate-source-meta',
      '.candidate-v2-fact .field-label',
      '.candidate-v2-fact dd',
      '.candidate-section-kicker',
      '.candidate-command-copy',
    ];
    const fontSizes = selectors.map((selector) => {
      const element = document.querySelector(selector);
      return element ? Number.parseFloat(getComputedStyle(element).fontSize) : null;
    }).filter(Number.isFinite);
    const overlaps = (left, right) => {
      if (!left || !right) return false;
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    };
    const collapseRect = collapse?.getBoundingClientRect();
    const toolbarRect = candidateToolbar?.getBoundingClientRect();
    return {
      detailWidth: detail?.getBoundingClientRect().width || 0,
      factsColumns: facts ? getComputedStyle(facts).gridTemplateColumns.split(/\\s+/).filter(Boolean).length : 0,
      bodyColumns: body ? getComputedStyle(body).gridTemplateColumns.split(/\\s+/).filter(Boolean).length : 0,
      taskbarTop: taskbar?.getBoundingClientRect().top || 0,
      workspaceTop: workspace?.getBoundingClientRect().top || 0,
      taskbarInsideWorkspace: Boolean(workspace && taskbar && workspace.contains(taskbar)),
      headingBeforeTaskbar: Boolean(workspaceHead && taskbar
        && (workspaceHead.compareDocumentPosition(taskbar) & Node.DOCUMENT_POSITION_FOLLOWING)),
      taskbarBeforeDomainNavigation: Boolean(taskbar && domainNavigation
        && (taskbar.compareDocumentPosition(domainNavigation) & Node.DOCUMENT_POSITION_FOLLOWING)),
      domainNavigationBeforePanel: Boolean(domainNavigation && domainPanel
        && (domainNavigation.compareDocumentPosition(domainPanel) & Node.DOCUMENT_POSITION_FOLLOWING)),
      listOpen: Boolean(document.querySelector('.candidate-sider-open')),
      identityAnchor: {
        count: document.querySelectorAll('.candidate-identity-anchor').length,
        visible: Boolean(identityAnchor?.getClientRects().length),
        role: identityAnchor?.getAttribute('role') || '',
        ariaLabel: identityAnchor?.getAttribute('aria-label') || '',
        openState: Boolean(identityAnchor?.classList.contains('is-list-open')),
        position: identityAnchor ? getComputedStyle(identityAnchor).position : '',
        name: (identityAnchor?.querySelector('.candidate-focus-identity strong')?.textContent || '').trim(),
        nameTitle: identityAnchor?.querySelector('.candidate-focus-identity strong')?.getAttribute('title') || '',
        job: (identityAnchor?.querySelector('.candidate-focus-job')?.textContent || '').trim(),
        reference: (identityAnchor?.querySelector('.candidate-focus-reference')?.textContent || '').trim(),
      },
      collapseWidth: collapse?.getBoundingClientRect().width || 0,
      collapseInToolbar: Boolean(collapse && collapse.closest('.candidate-sider-toolbar')),
      collapseWithinToolbar: Boolean(collapseRect && toolbarRect
        && collapseRect.left >= toolbarRect.left - 1 && collapseRect.right <= toolbarRect.right + 1
        && collapseRect.top >= toolbarRect.top - 1 && collapseRect.bottom <= toolbarRect.bottom + 1),
      collapseOverlapsControls: overlaps(collapse, candidateTitle)
        || overlaps(collapse, upload)
        || overlaps(collapse, operations),
      floatingCandidateEdgeCount: document.querySelectorAll('.candidate-edge-toggle').length,
      communicationActionVisible: Boolean([...document.querySelectorAll('.candidate-taskbar button')]
        .find((element) => (element.textContent || '').trim() === '记录沟通事实')?.offsetParent),
      backfillTextareaCount: document.querySelectorAll('.communication-backfill-form textarea').length,
      heroMetaText: document.querySelector('.hero-meta')?.textContent.trim() || '',
      decisionSummaryText: document.querySelector('.candidate-workspace-heading')?.textContent.trim() || '',
      missingFactsLabel: document.querySelector('.candidate-missing-facts .ant-collapse-header-text')?.textContent.trim() || '',
      dispositionLabelText: document.querySelector('.candidate-status-summary > div:last-child strong')?.textContent.trim() || '',
      manualDispositionStateText: document.querySelector('.candidate-disposition-card .candidate-command-state')?.textContent.trim() || '',
      dispositionActionLabels: [...document.querySelectorAll('.candidate-disposition-visible-actions .ant-btn')]
        .map((element) => (element.textContent || '').trim()),
      taskPrimaryLabel: document.querySelector('.candidate-task-primary-action')?.textContent.trim() || '',
      taskPrimaryIsPrimary: Boolean(document.querySelector('.candidate-task-primary-action.ant-btn-primary')),
      minFontSize: Math.min(...fontSizes),
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  assert.ok(candidateDecisionLayout.detailWidth > 0 && candidateDecisionLayout.detailWidth <= 500,
    '1100px selected split must keep the detail pane inside its narrow responsive range');
  assert.equal(candidateDecisionLayout.factsColumns, 2,
    '1100px narrow detail pane must wrap the fact band to two readable columns');
  assert.equal(candidateDecisionLayout.bodyColumns, 1, 'candidate detail must retain one main workspace column');
  assert.equal(candidateDecisionLayout.taskbarInsideWorkspace, true,
    'candidate taskbar must live inside the one main workspace');
  assert.equal(candidateDecisionLayout.headingBeforeTaskbar, true,
    'current task heading must precede the HR taskbar in DOM and keyboard order');
  assert.equal(candidateDecisionLayout.taskbarBeforeDomainNavigation, true,
    'the compact HR taskbar must precede candidate domain navigation');
  assert.equal(candidateDecisionLayout.domainNavigationBeforePanel, true,
    'candidate domain navigation must directly precede selected domain content');
  assert.ok(candidateDecisionLayout.workspaceTop <= candidateDecisionLayout.taskbarTop + 1,
    'candidate taskbar must remain part of the main workspace instead of a permanent side rail');
  assert.equal(candidateDecisionLayout.listOpen, true,
    'selecting a candidate at 1100px must preserve the visible candidate list');
  assert.deepEqual({
    count: candidateDecisionLayout.identityAnchor.count,
    visible: candidateDecisionLayout.identityAnchor.visible,
    role: candidateDecisionLayout.identityAnchor.role,
    ariaLabel: candidateDecisionLayout.identityAnchor.ariaLabel,
    openState: candidateDecisionLayout.identityAnchor.openState,
    position: candidateDecisionLayout.identityAnchor.position,
  }, {
    count: 1,
    visible: true,
    role: 'region',
    ariaLabel: '当前候选人身份锚点',
    openState: true,
    position: 'sticky',
  }, 'candidate identity anchor must remain present while the source list is open');
  assert.ok(candidateDecisionLayout.identityAnchor.name
    && candidateDecisionLayout.identityAnchor.nameTitle === `完整姓名：${candidateDecisionLayout.identityAnchor.name}`
    && candidateDecisionLayout.identityAnchor.job
    && candidateDecisionLayout.identityAnchor.reference,
  'candidate identity anchor must expose full name, job, and stable reference');
  assert.ok(candidateDecisionLayout.collapseWidth >= 44, 'visible candidate list must expose a 44px manual collapse target');
  assert.equal(candidateDecisionLayout.collapseInToolbar, true,
    'candidate collapse control must live in the list toolbar instead of the content boundary');
  assert.equal(candidateDecisionLayout.collapseWithinToolbar, true,
    'candidate collapse control must remain fully contained by the list toolbar');
  assert.equal(candidateDecisionLayout.collapseOverlapsControls, false,
    'candidate collapse control must not overlap the list title, upload, or candidate actions');
  assert.equal(candidateDecisionLayout.floatingCandidateEdgeCount, 0,
    'candidate workspace must not retain the former floating edge control');
  assert.equal(candidateDecisionLayout.communicationActionVisible, true,
    'low-frequency communication facts must remain reachable from the compact taskbar');
  assert.equal(candidateDecisionLayout.backfillTextareaCount, 0,
    'closed communication Drawer must not create a permanent form column');
  assert.doesNotMatch(candidateDecisionLayout.heroMetaText, /^(推荐|目标岗位待补全)$/,
    'manual candidates must not invent a recommendation label or missing target-job state');
  assert.match(candidateDecisionLayout.decisionSummaryText, /只汇总已记录事实和统一时间线待办/,
    'decision summary must disclose its deterministic fact-only boundary');
  assert.match(candidateDecisionLayout.missingFactsLabel, /^待补全资料（\d+ 项）$/,
    'missing facts must be aggregated behind one explicit disclosure control');
  assert.equal(candidateDecisionLayout.dispositionLabelText, '新入库',
    'stable disposition codes must render as localized product copy');
  assert.equal(candidateDecisionLayout.manualDispositionStateText, '新入库',
    'candidate summary and HR taskbar must use the same localized disposition label');
  assert.deepEqual(candidateDecisionLayout.dispositionActionLabels, ['记录沟通事实', '继续推进', '暂缓', '更多处置'],
    'candidate decision buttons must put the deterministic todo first without removing manual override actions');
  assert.deepEqual([candidateDecisionLayout.taskPrimaryLabel, candidateDecisionLayout.taskPrimaryIsPrimary], ['记录沟通事实', true],
    'contact_required must drive the unique primary CTA in the candidate taskbar');
  assert.ok(candidateDecisionLayout.minFontSize >= 12, 'candidate detail decision text must stay at or above 12px');
  assert.ok(candidateDecisionLayout.horizontalOverflow <= 1, 'candidate detail must not introduce document overflow');
  const candidateDispositionMenu1100 = await verifyCandidateDispositionMenu(
    win,
    'candidate-disposition-menu-1100x720',
  );
  await clickExactText(win, '.candidate-taskbar button', '记录沟通事实');
  await waitFor(win,
    "Boolean(document.querySelector('.candidate-communication-drawer .ant-drawer-content-wrapper')?.getClientRects().length)",
    'candidate communication Drawer');
  const candidateCommunicationDrawer = await win.webContents.executeJavaScript(`(() => {
    const drawer = document.querySelector('.candidate-communication-drawer');
    const box = drawer?.getBoundingClientRect();
    return {
      idleHint: document.querySelector('.candidate-communication-drawer .communication-backfill-idle')?.textContent.trim() || '',
      textareaCount: document.querySelectorAll('.candidate-communication-drawer textarea').length,
      rect: box ? { left: box.left, right: box.right, width: box.width } : null,
      viewportWidth: innerWidth,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  assert.match(candidateCommunicationDrawer.idleHint, /选择不同事实后填写备注并确认保存/,
    'communication Drawer must explain its progressive disclosure state');
  assert.equal(candidateCommunicationDrawer.textareaCount, 0,
    'unchanged communication facts must not render an inert textarea');
  assert.ok(candidateCommunicationDrawer.rect
    && candidateCommunicationDrawer.rect.left >= -1
    && candidateCommunicationDrawer.rect.right <= candidateCommunicationDrawer.viewportWidth + 1,
  'communication Drawer must remain inside the 1100px viewport');
  assert.ok(candidateCommunicationDrawer.horizontalOverflow <= 1,
    'communication Drawer must not create horizontal document overflow');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(win,
    "!document.querySelector('.candidate-communication-drawer .ant-drawer-content-wrapper')?.getClientRects().length",
    'candidate communication Drawer Escape close');
  await waitFor(win,
    "document.activeElement?.textContent?.trim() === '记录沟通事实'",
    'candidate communication Drawer trigger focus restoration');
  const communicationFocusRestored = await win.webContents.executeJavaScript(`(() => (
    document.activeElement?.textContent?.trim() === '记录沟通事实'
  ))()`);
  assert.equal(communicationFocusRestored, true,
    'closing the communication Drawer with one Escape must restore focus to its trigger');
  const candidateEvidence = await captureEvidence(win, 'candidate-detail-1100x720');

  const candidateSegmentedKeyboard = await win.webContents.executeJavaScript(`(async () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
    const getRoot = () => document.querySelector('.candidate-domain-tabs');
    const dispatch = (target, key) => target.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      code: key === ' ' ? 'Space' : key,
      bubbles: true,
      cancelable: true,
    }));
    const selectedText = () => document.querySelector('.candidate-domain-tab-option:has(> input:checked)')?.textContent.trim() || '';
    if (!getRoot()) return { error: 'missing candidate domain control' };

    let root = getRoot();
    root.focus();
    dispatch(root, 'End');
    await settle();
    const endText = selectedText();

    root = getRoot();
    root.focus();
    dispatch(root, 'Home');
    await settle();
    const homeText = selectedText();

    root = getRoot();
    const selectedInput = root.querySelector('input[type="radio"]:checked');
    selectedInput?.focus();
    dispatch(selectedInput, 'ArrowRight');
    await settle();
    const arrowText = selectedText();

    root = getRoot();
    dispatch(root, 'Home');
    await settle();
    const beforeActivation = selectedText();
    root = getRoot();
    const activationInput = root.querySelector('input[type="radio"]:checked');
    activationInput?.focus();
    const enterCanceled = !dispatch(activationInput, 'Enter');
    await settle();
    const enterText = selectedText();
    root = getRoot();
    root?.focus();
    const spaceCanceled = !dispatch(root, ' ');
    await settle();

    root = getRoot();
    const inputs = [...root.querySelectorAll('input[type="radio"]')];
    return {
      endText,
      homeText,
      arrowText,
      activationText: selectedText(),
      enterText,
      beforeActivation,
      enterCanceled,
      spaceCanceled,
      names: [...new Set(inputs.map((input) => input.name))],
      checkedCount: inputs.filter((input) => input.checked).length,
    };
  })()`);
  assert.match(candidateSegmentedKeyboard.endText, /流程/,
    'End must select the last candidate workspace radio');
  assert.match(candidateSegmentedKeyboard.homeText, /资料/,
    'Home must select the first candidate workspace radio');
  assert.match(candidateSegmentedKeyboard.arrowText, /面试/,
    'ArrowRight must move selection through the named native radio group');
  assert.equal(candidateSegmentedKeyboard.enterText, candidateSegmentedKeyboard.beforeActivation,
    'Enter on the focused radio must preserve and activate its current selection');
  assert.equal(candidateSegmentedKeyboard.activationText, candidateSegmentedKeyboard.beforeActivation,
    'Space on the focused group must preserve and activate its current selection');
  assert.equal(candidateSegmentedKeyboard.enterCanceled, true, 'Enter on the focused radio must activate without leaking to the page');
  assert.equal(candidateSegmentedKeyboard.spaceCanceled, true, 'Space activation must not scroll the page');
  assert.deepEqual(candidateSegmentedKeyboard.names, ['candidate-workspace-domain'],
    'candidate workspace radios must share one stable name');
  assert.equal(candidateSegmentedKeyboard.checkedCount, 1,
    'candidate workspace must expose exactly one checked radio');

  await clickTextContaining(win, '.candidate-domain-tab-option', '测评');
  await waitFor(win, "document.querySelector('.assessment-decision-support')", 'assessment evidence-first decision support');
  await delay(120);
  const assessmentEvidenceLayout = await win.webContents.executeJavaScript(`(() => {
    const overview = document.querySelector('#assessment-ai-evidence-title')?.closest('section');
    const verification = [...document.querySelectorAll('.assessment-evidence-block h3')]
      .find((heading) => (heading.textContent || '').includes('AI 面试核验题'))?.closest('section');
    const score = document.querySelector('section[aria-label="AI 匹配分次级参考"]');
    const decision = document.querySelector('.assessment-decision-support');
    const scoreValue = score?.querySelector('.assessment-secondary-score-value strong');
    const scoreStyle = scoreValue ? getComputedStyle(scoreValue) : null;
    const follows = (first, second) => Boolean(first && second
      && (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING));
    return {
      overviewBeforeVerification: follows(overview, verification),
      verificationBeforeScore: follows(verification, score),
      scoreBeforeDecision: follows(score, decision),
      scoreFontSize: scoreStyle ? Number.parseFloat(scoreStyle.fontSize) : 0,
      scoreColor: scoreStyle?.color || '',
      progressCount: document.querySelectorAll('.assessment-archive-panel .ant-progress').length,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  assert.equal(assessmentEvidenceLayout.overviewBeforeVerification, true,
    'assessment evidence coverage must precede verification questions');
  assert.equal(assessmentEvidenceLayout.verificationBeforeScore, true,
    'assessment verification questions must precede the AI score');
  assert.equal(assessmentEvidenceLayout.scoreBeforeDecision, true,
    'assessment score must remain secondary to the final HR decision reference');
  assert.ok(assessmentEvidenceLayout.scoreFontSize <= 20,
    'assessment score must not return to a large hero treatment');
  assert.notEqual(assessmentEvidenceLayout.scoreColor, 'rgb(47, 116, 88)',
    'assessment score must not reuse the success green');
  assert.equal(assessmentEvidenceLayout.progressCount, 0,
    'assessment decision surfaces must not visualize fit scores as progress');
  assert.ok(assessmentEvidenceLayout.horizontalOverflow <= 1,
    'assessment evidence surface must not introduce horizontal overflow');
  await win.webContents.executeJavaScript(
    "document.querySelector('#assessment-ai-evidence-title')?.scrollIntoView({ block: 'start', behavior: 'instant' })",
  );
  await delay(120);
  const assessmentEvidence = await captureEvidence(win, 'assessment-evidence-1100x720');
  await win.webContents.executeJavaScript(
    "document.querySelector('section[aria-label=\"AI 匹配分次级参考\"]')?.scrollIntoView({ block: 'center', behavior: 'instant' })",
  );
  await delay(120);
  const assessmentDecisionEvidence = await captureEvidence(win, 'assessment-score-decision-1100x720');
  await clickTextContaining(win, '.candidate-domain-tab-option', '资料');
  await waitFor(win, "document.querySelector('.detail-tabs')", 'candidate profile workspace restore');
  await win.webContents.executeJavaScript("document.querySelector('#main-workspace').scrollTop = 0");

  const missingFactDisclosure = await win.webContents.executeJavaScript(`(async () => {
    const header = document.querySelector('.candidate-missing-facts .ant-collapse-header');
    if (!header) return { error: 'missing disclosure' };
    header.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const label = document.querySelector('.candidate-missing-facts .ant-collapse-header-text')?.textContent.trim() || '';
    const labels = [...document.querySelectorAll('dl[aria-label="待补全候选人事实"] dt')]
      .map((element) => (element.textContent || '').trim());
    const values = [...document.querySelectorAll('dl[aria-label="待补全候选人事实"] dd')]
      .map((element) => (element.textContent || '').trim());
    header.click();
    return {
      declaredCount: Number(label.match(/（(\\d+) 项）/)?.[1] || 0),
      labels,
      values,
    };
  })()`);
  assert.equal(missingFactDisclosure.declaredCount, missingFactDisclosure.labels.length,
    'missing-fact disclosure count must match the rendered fact labels');
  assert.equal(new Set(missingFactDisclosure.labels).size, missingFactDisclosure.labels.length,
    'missing-fact disclosure must not duplicate fact labels');
  assert.ok(missingFactDisclosure.values.every((value) => value.includes('待从简历或人工资料补全')
    && !/(?:\d+(?:\.\d+)?\s*分|不合格|推荐)/.test(value)),
    'missing facts must explain the source needed instead of inventing a score or judgment');

  const collapseReady = await win.webContents.executeJavaScript(`(() => {
    const collapse = document.querySelector('button[aria-label="收起候选人列表"]');
    if (!collapse) return false;
    collapse?.focus();
    return document.activeElement === collapse;
  })()`);
  assert.equal(collapseReady, true, 'candidate collapse control must accept keyboard focus');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(win, "Boolean(document.querySelector('.candidate-sider-collapsed'))", 'candidate list keyboard collapse');
  await waitFor(win,
    "document.activeElement?.getAttribute('aria-label') === '展开候选人列表'",
    'candidate restore focus handoff');

  const collapsedControl = await win.webContents.executeJavaScript(`(() => {
    const restore = document.querySelector('button[aria-label="展开候选人列表"]');
    const identity = document.querySelector('.candidate-focus-identity');
    const anchor = document.querySelector('.candidate-identity-anchor');
    const restoreRect = restore?.getBoundingClientRect();
    const identityRect = identity?.getBoundingClientRect();
    return {
      restoreCount: document.querySelectorAll('button[aria-label="展开候选人列表"]').length,
      inFocusBar: Boolean(restore?.closest('.candidate-focus-bar')),
      anchorCollapsed: Boolean(anchor?.classList.contains('is-list-collapsed')),
      anchorRole: anchor?.getAttribute('role') || '',
      anchorLabel: anchor?.getAttribute('aria-label') || '',
      name: (identity?.querySelector('strong')?.textContent || '').trim(),
      job: (identity?.querySelector('.candidate-focus-job')?.textContent || '').trim(),
      reference: (identity?.querySelector('.candidate-focus-reference')?.textContent || '').trim(),
      width: restoreRect?.width || 0,
      height: restoreRect?.height || 0,
      overlapsIdentity: Boolean(restoreRect && identityRect
        && restoreRect.left < identityRect.right && restoreRect.right > identityRect.left
        && restoreRect.top < identityRect.bottom && restoreRect.bottom > identityRect.top),
      teamIconCount: restore?.querySelectorAll('[data-icon="team"]').length || 0,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  assert.equal(collapsedControl.restoreCount, 1,
    'collapsed candidate detail must expose exactly one primary restore control');
  assert.equal(collapsedControl.inFocusBar, true,
    'candidate restore control must stay in the stable focused-detail bar');
  assert.equal(collapsedControl.anchorCollapsed, true,
    'candidate identity anchor must persist when the source list is collapsed');
  assert.deepEqual([collapsedControl.anchorRole, collapsedControl.anchorLabel], ['region', '当前候选人身份锚点']);
  assert.ok(collapsedControl.name && collapsedControl.job && collapsedControl.reference,
    'collapsed identity anchor must retain name, job, and stable reference');
  assert.ok(collapsedControl.width >= 44 && collapsedControl.height >= 44,
    'candidate restore control must retain a 44px hit target');
  assert.equal(collapsedControl.overlapsIdentity, false,
    'candidate restore control must not overlap the candidate identity');
  assert.equal(collapsedControl.teamIconCount, 0,
    'candidate restore control must not retain the ambiguous Team icon');
  assert.ok(collapsedControl.horizontalOverflow <= 1,
    'collapsed candidate detail must not introduce horizontal overflow');

  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await waitFor(win, "Boolean(document.querySelector('.candidate-sider-open'))", 'candidate list keyboard restore');
  await waitFor(win,
    "document.activeElement?.getAttribute('aria-label') === '收起候选人列表'",
    'candidate collapse focus handoff');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await waitFor(win, "Boolean(document.querySelector('.candidate-sider-collapsed'))", 'candidate list second keyboard collapse');
  await waitFor(win,
    "document.activeElement?.getAttribute('aria-label') === '展开候选人列表'",
    'candidate second restore focus handoff');
  const candidateSiderFocus = {
    collapseFocused: collapseReady,
    restoreFocused: true,
    activeLabel: '展开候选人列表',
    enterCollapseOnce: true,
    spaceRestoreOnce: true,
  };

  await win.webContents.executeJavaScript("document.querySelector('button[aria-label=\"展开候选人列表\"]')?.focus()");
  const candidateTabJourney = [];
  let candidateTaskbarReached = false;
  for (let index = 0; index < 40; index += 1) {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await delay(20);
    const stop = await win.webContents.executeJavaScript(`(() => {
      const active = document.activeElement;
      const region = active?.closest('.candidate-taskbar') ? 'taskbar'
        : active?.closest('.candidate-v2-workspace') ? 'workspace' : 'other';
      return {
        region,
        label: (active?.getAttribute('aria-label') || active?.textContent || '').trim().slice(0, 80),
      };
    })()`);
    candidateTabJourney.push(stop);
    if (stop.region === 'taskbar') candidateTaskbarReached = true;
    if (candidateTaskbarReached && stop.region === 'workspace') break;
  }
  const firstWorkspaceTab = candidateTabJourney.findIndex((stop) => stop.region === 'workspace');
  const firstTaskbarTab = candidateTabJourney.findIndex((stop) => stop.region === 'taskbar');
  assert.ok(firstTaskbarTab >= 0, 'candidate keyboard journey must reach HR disposition controls');
  assert.ok(firstWorkspaceTab > firstTaskbarTab,
    'candidate keyboard journey must follow current task, HR disposition, domain navigation and domain content order');
  const keyboardEvidence = await captureEvidence(win, 'candidate-keyboard-journey-1100x720');

  win.setContentSize(1440, 900);
  await delay(160);
  const restoreAtWideBoundary = await win.webContents.executeJavaScript(`(() => {
    const restore = document.querySelector('button[aria-label="展开候选人列表"]');
    if (!restore) return false;
    restore.click();
    return true;
  })()`);
  assert.equal(restoreAtWideBoundary, true, '1440px layout must allow the user to restore the candidate list');
  await waitFor(win, "Boolean(document.querySelector('.candidate-sider-open'))", 'candidate list open at 1440px');
  await waitFor(win, "localStorage.getItem('hrboss.ui.candidateListCollapsed.v1') === '0'", 'manual list preference persistence');
  await win.webContents.executeJavaScript("document.querySelector('.candidate-card')?.click()");
  await delay(140);
  const boundaryWide = await win.webContents.executeJavaScript(`(() => ({
    width: innerWidth,
    listOpen: Boolean(document.querySelector('.candidate-sider-open')),
    storedPreference: localStorage.getItem('hrboss.ui.candidateListCollapsed.v1'),
  }))()`);
  assert.equal(boundaryWide.listOpen, true, 'selecting a candidate at 1440px must preserve the visible list');
  assert.equal(boundaryWide.storedPreference, '0', 'wide selection must preserve the manual visible-list preference');
  const candidateSplitEvidence = await captureEvidence(win, 'candidate-split-1440x900');

  win.setContentSize(1360, 768);
  win.webContents.setZoomFactor(1.25);
  await delay(180);
  const windows125CandidateToggle = await win.webContents.executeJavaScript(`(() => {
    const toolbar = document.querySelector('.candidate-sider-toolbar');
    const collapse = document.querySelector('button[aria-label="收起候选人列表"]');
    const toolbarRect = toolbar?.getBoundingClientRect();
    const collapseRect = collapse?.getBoundingClientRect();
    return {
      viewport: [innerWidth, innerHeight],
      inToolbar: Boolean(collapse?.closest('.candidate-sider-toolbar')),
      contained: Boolean(toolbarRect && collapseRect
        && collapseRect.left >= toolbarRect.left - 1 && collapseRect.right <= toolbarRect.right + 1
        && collapseRect.top >= toolbarRect.top - 1 && collapseRect.bottom <= toolbarRect.bottom + 1),
      toolbarOverflow: toolbar ? toolbar.scrollWidth - toolbar.clientWidth : null,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  assert.deepEqual(windows125CandidateToggle.viewport, [1088, 614],
    'candidate Windows 125% sample must use the expected CSS viewport');
  assert.equal(windows125CandidateToggle.inToolbar, true);
  assert.equal(windows125CandidateToggle.contained, true,
    'candidate collapse control must remain contained at Windows 125%');
  assert.ok(windows125CandidateToggle.toolbarOverflow <= 1 && windows125CandidateToggle.documentOverflow <= 1,
    'candidate toolbar must not overflow at Windows 125%');

  win.webContents.setZoomFactor(1);
  win.setContentSize(740, 620);
  await delay(180);
  const narrowCandidateToggle = await win.webContents.executeJavaScript(`(() => {
    const toolbar = document.querySelector('.candidate-sider-toolbar');
    const collapse = document.querySelector('button[aria-label="收起候选人列表"]');
    const toolbarRect = toolbar?.getBoundingClientRect();
    const collapseRect = collapse?.getBoundingClientRect();
    return {
      visible: Boolean(collapse?.offsetParent),
      contained: Boolean(toolbarRect && collapseRect
        && collapseRect.left >= toolbarRect.left - 1 && collapseRect.right <= toolbarRect.right + 1
        && collapseRect.top >= toolbarRect.top - 1 && collapseRect.bottom <= toolbarRect.bottom + 1),
      toolbarOverflow: toolbar ? toolbar.scrollWidth - toolbar.clientWidth : null,
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  assert.equal(narrowCandidateToggle.visible, true,
    'candidate collapse control must remain reachable in the narrow, low-height layout');
  assert.equal(narrowCandidateToggle.contained, true,
    'candidate collapse control must remain contained in the narrow list toolbar');
  assert.ok(narrowCandidateToggle.toolbarOverflow <= 1 && narrowCandidateToggle.documentOverflow <= 1,
    'candidate toolbar must not overflow in the narrow, low-height layout');

  win.setContentSize(1100, 720);
  await waitFor(win, "Boolean(document.querySelector('.candidate-sider-open'))", 'candidate list preserved at 1100px');
  await delay(100);
  const boundarySplit = await win.webContents.executeJavaScript(`(() => ({
    width: innerWidth,
    listOpen: Boolean(document.querySelector('.candidate-sider-open')),
    storedPreference: localStorage.getItem('hrboss.ui.candidateListCollapsed.v1'),
  }))()`);
  assert.equal(boundarySplit.listOpen, true, '1100px layout must retain the list plus one main workspace');
  assert.equal(boundarySplit.storedPreference, '0',
    'responsive layout changes must preserve the user\'s manual visible-list preference');
  await delay(120);

  await clickTextContaining(win, '.candidate-domain-tab-option', '面试');
  await waitFor(win, "document.querySelector('.interview-status-panel')", 'candidate interview workspace');
  await delay(120);
  const interview = await win.webContents.executeJavaScript(`(() => {
    const box = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return null;
      return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        columns: getComputedStyle(element).gridTemplateColumns };
    };
    const tabList = document.querySelector('.interview-workflow-tabs [role="tablist"]');
    const tabNav = tabList?.closest('.ant-tabs-nav');
    const activeTab = document.querySelector('.interview-workflow-tabs [role="tab"][aria-selected="true"]');
    const activeTabItem = activeTab?.parentElement;
    const activeLabel = activeTab?.querySelector('.interview-tab-label');
    const tabStyle = activeTabItem ? getComputedStyle(activeTabItem) : null;
    return { detail: box('.candidate-detail-content'), panel: box('.candidate-domain-panel'),
      status: box('.interview-status-panel'), tabs: tabNav && tabStyle && activeLabel ? {
        navMarginBottom: getComputedStyle(tabNav).marginBottom,
        paddingTop: tabStyle.paddingTop,
        paddingBottom: tabStyle.paddingBottom,
        selectedColor: getComputedStyle(activeLabel).color,
      } : null };
  })()`);
  for (const item of [interview.detail, interview.panel, interview.status]) {
    assert.ok(item && item.scrollWidth <= item.clientWidth + 1, 'candidate interview workspace must not overflow horizontally');
  }
  assert.ok(interview.status.columns.trim().split(/\s+/).length <= 2,
    'focused 1100px detail must use no more than two readable interview-status columns');
  assert.deepEqual(interview.tabs, {
    navMarginBottom: '12px',
    paddingTop: '8px',
    paddingBottom: '8px',
    selectedColor: 'rgb(0, 75, 145)',
  }, 'interview Tabs geometry and selected color must come from the AntD 5 component tokens');

  await clickTextContaining(win, '.candidate-domain-tab-option', '流程');
  await waitFor(win, "document.querySelector('.flow-grid')", 'candidate flow workspace');
  await delay(120);
  const flow = await win.webContents.executeJavaScript(`(() => {
    const grid = document.querySelector('.flow-grid');
    const heads = [...document.querySelectorAll('.flow-event-head strong')].map((element) => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    });
    return { clientWidth: grid.clientWidth, scrollWidth: grid.scrollWidth,
      columns: getComputedStyle(grid).gridTemplateColumns, heads };
  })()`);
  assert.ok(flow.scrollWidth <= flow.clientWidth + 1, 'candidate flow grid must not overflow');
  assert.ok(flow.columns.trim().split(/\s+/).length <= 2,
    'focused 1100px detail must use no more than two readable flow columns');
  assert.ok(flow.heads.slice(0, 2).every((item) => item.width >= 100 && item.height < 80), 'flow titles must remain readable');

  win.setContentSize(1360, 768);
  win.webContents.setZoomFactor(1.25);
  await delay(180);
  const scaledShell = await win.webContents.executeJavaScript(`(() => {
    const header = document.querySelector('.top-header').getBoundingClientRect();
    const workspace = document.querySelector('.workspace').getBoundingClientRect();
    const documentElement = document.documentElement;
    return {
      cssViewport: [innerWidth, innerHeight],
      devicePixelRatio,
      headerHeight: header.height,
      workspaceY: workspace.y,
      sourceDisplay: getComputedStyle(document.querySelector('.topbar-source')).display,
      document: {
        clientWidth: documentElement.clientWidth,
        scrollWidth: documentElement.scrollWidth,
        overflow: documentElement.scrollWidth - documentElement.clientWidth,
      },
    };
  })()`);
  scaledShell.electronContentSize = win.getContentSize();
  scaledShell.zoomFactor = win.webContents.getZoomFactor();
  assert.equal(scaledShell.zoomFactor, 1.25, 'Windows 125% equivalent must use Electron page zoom');
  assert.deepEqual(scaledShell.electronContentSize, [1360, 768], 'Windows 125% equivalent must use a 1360x768 content window');
  assert.ok(Math.abs(scaledShell.cssViewport[0] - 1088) <= 1 && Math.abs(scaledShell.cssViewport[1] - 614) <= 1,
    'Windows 125% equivalent must record the expected CSS viewport');
  assert.ok(scaledShell.document.overflow <= 1, 'Windows 125% equivalent must not overflow the document horizontally');
  assert.ok(scaledShell.headerHeight <= 112,
    `Windows 125% equivalent top header may use its intentional recovery row but must stay compact: ${scaledShell.headerHeight}`);
  assert.ok(scaledShell.workspaceY <= 125, 'Windows 125% equivalent workspace must remain visible');
  assert.equal(scaledShell.sourceDisplay, 'none', 'empty status row must not consume height');

  const candidateDispositionMenuWindows125 = await verifyCandidateDispositionMenu(
    win,
    'candidate-disposition-menu-1360x768-windows125',
  );
  const windows125Evidence = await captureEvidence(win, 'candidate-1360x768-windows125');
  const candidateAccessibilityTree = await captureChromiumAccessibilityTree(win);

  win.webContents.setZoomFactor(1);
  win.setContentSize(1100, 720);
  await delay(180);
  await clickExactText(win, 'button.nav-item', '工作台');
  await waitFor(win, "document.querySelector('.dashboard-todo-context')", 'todo identity');
  const initialTodos = await win.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#dashboard-todo-list');
    const rows = [...document.querySelectorAll('.dashboard-todo-row')];
    const actions = rows.map((row) => row.querySelector('.dashboard-todo-action'));
    const expand = document.querySelector('[aria-controls="dashboard-todo-list"]');
    return {
      listTag: list?.tagName || '',
      directChildTags: list ? [...list.children].map((element) => element.tagName) : [],
      rowCount: rows.length,
      ids: rows.map((row) => row.dataset.todoId),
      contexts: rows.map((row) => row.querySelector('.dashboard-todo-context')?.textContent.trim() || ''),
      actionTexts: actions.map((action) => action?.textContent.trim() || ''),
      actionLabels: actions.map((action) => action?.getAttribute('aria-label') || ''),
      filterRole: document.querySelector('.dashboard-todo-filters')?.getAttribute('role') || '',
      filterLabel: document.querySelector('.dashboard-todo-filters')?.getAttribute('aria-label') || '',
      status: document.querySelector('.dashboard-todo-result-status')?.textContent.trim() || '',
      expandText: expand?.textContent.trim() || '',
      expanded: expand?.getAttribute('aria-expanded') || '',
    };
  })()`);
  assert.equal(initialTodos.listTag, 'UL', 'dashboard todos must use list semantics');
  assert.ok(initialTodos.directChildTags.every((tag) => tag === 'LI'), 'dashboard todo list children must be list items');
  assert.equal(initialTodos.rowCount, 3, 'dashboard must default to a compact first-three preview');
  assert.deepEqual(initialTodos.ids, [
    'SYN-TODO-SCHEDULE',
    'SYN-TODO-REPORT',
    'SYN-TODO-RATING-1',
  ], 'compact preview must preserve the backend order');
  assert.ok(initialTodos.contexts.every(Boolean), 'every dashboard todo must identify its subject');
  assert.ok(initialTodos.actionTexts.every((text) => text && text !== '前往处理'), 'todo actions must describe their destination');
  assert.equal(new Set(initialTodos.actionLabels).size, initialTodos.actionLabels.length,
    'todo action accessible names must include a unique subject');
  assert.equal(initialTodos.filterRole, 'radiogroup', 'todo filters must expose a single keyboard group');
  assert.equal(initialTodos.filterLabel, '筛选待办事项');
  assert.match(initialTodos.status, /3\/12 条/);
  assert.equal(initialTodos.expandText, '查看其余 9 条');
  assert.equal(initialTodos.expanded, 'false');

  const ratingFilterClicked = await win.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('.dashboard-todo-filters input[value="rating"]');
    if (!input) return false;
    input.click();
    return true;
  })()`);
  assert.equal(ratingFilterClicked, true, 'rating filter must be available');
  await waitFor(win, "document.querySelector('.dashboard-todo-result-status')?.textContent.includes('3/10')", 'rating filter');
  const ratingPreview = await win.webContents.executeJavaScript(`(() => ({
    ids: [...document.querySelectorAll('.dashboard-todo-row')].map((row) => row.dataset.todoId),
    codes: [...document.querySelectorAll('.dashboard-todo-row')].map((row) => row.dataset.todoCode),
    expandText: document.querySelector('[aria-controls="dashboard-todo-list"]')?.textContent.trim() || '',
  }))()`);
  assert.ok(ratingPreview.codes.every((code) => code === 'candidate_rating_required'), 'rating filter must not leak other todo types');
  assert.deepEqual(ratingPreview.ids, Array.from({ length: 3 }, (_, index) => `SYN-TODO-RATING-${index + 1}`),
    'filtering must preserve the existing todo order');
  assert.equal(ratingPreview.expandText, '查看其余 7 条');

  const expandControl = await win.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[aria-controls="dashboard-todo-list"]');
    if (!button) return null;
    button.focus();
    return {
      focused: document.activeElement === button,
      tag: button.tagName,
      tabIndex: button.tabIndex,
    };
  })()`);
  assert.deepEqual(expandControl, { focused: true, tag: 'BUTTON', tabIndex: 0 },
    'todo expansion control must remain a native, keyboard-focusable button');
  await win.webContents.executeJavaScript("document.activeElement.click()");
  await waitFor(win, "document.querySelectorAll('.dashboard-todo-row').length === 10", 'focused todo expansion');
  const expandedRatingIds = await win.webContents.executeJavaScript(
    `[...document.querySelectorAll('.dashboard-todo-row')].map((row) => row.dataset.todoId)`,
  );
  assert.deepEqual(expandedRatingIds, Array.from({ length: 10 }, (_, index) => `SYN-TODO-RATING-${index + 1}`),
    'focused expansion must reveal every filtered todo without reordering');

  await win.webContents.executeJavaScript("document.querySelector('.dashboard-todo-filters input[value=\"all\"]').click()");
  await waitFor(win, "document.querySelector('.dashboard-todo-result-status')?.textContent.includes('3/12')", 'all todo filter reset');
  win.setContentSize(733, 480);
  await delay(180);
  const narrowTodos = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.dashboard-todo-card');
    const filters = document.querySelector('.dashboard-todo-filters');
    const rows = [...document.querySelectorAll('.dashboard-todo-row')];
    const actions = rows.map((row) => row.querySelector('.dashboard-todo-action'));
    return {
      card: { clientWidth: card.clientWidth, scrollWidth: card.scrollWidth },
      filters: { clientWidth: filters.clientWidth, scrollWidth: filters.scrollWidth },
      rowColumns: rows.map((row) => getComputedStyle(row).gridTemplateColumns.trim().split(/\\s+/).length),
      rowOverflow: rows.map((row) => row.scrollWidth - row.clientWidth),
      actionHeights: actions.map((action) => action?.getBoundingClientRect().height || 0),
    };
  })()`);
  assert.ok(narrowTodos.card.scrollWidth <= narrowTodos.card.clientWidth + 1, 'narrow todo card must not overflow horizontally');
  assert.ok(narrowTodos.filters.scrollWidth <= narrowTodos.filters.clientWidth + 1, 'narrow todo filters must wrap without overflow');
  assert.ok(narrowTodos.rowColumns.every((count) => count === 1), 'narrow todo rows must stack into one column');
  assert.ok(narrowTodos.rowOverflow.every((overflow) => overflow <= 1), 'narrow todo rows must not clip long Chinese names');
  assert.ok(narrowTodos.actionHeights.every((height) => height >= 32), 'todo action targets must remain at least 32px high');
  const narrowEvidence = await captureEvidence(win, 'workbench-narrow-733x480');
  win.setContentSize(1100, 720);
  await delay(180);

  await clickExactText(win, 'button.nav-item', '职位管理');
  await waitFor(win, "document.querySelector('.job-ledger-open-link')", 'job ledger before deep profile');
  await clickExactText(win, '.job-ledger-open-link', '合成岗位 · 运行态视觉门禁');
  await waitFor(win, "document.querySelector('.job-module-action-strip')", 'job module action strip');
  const jobModuleAction = await win.webContents.executeJavaScript(`(() => {
    const strip = document.querySelector('.job-module-action-strip');
    const buttons = [...(strip?.querySelectorAll('button') || [])];
    const box = strip?.getBoundingClientRect();
    return {
      labels: buttons.map((button) => (button.textContent || '').trim()),
      disabled: buttons.map((button) => button.disabled),
      rect: box ? { left: box.left, right: box.right, top: box.top, bottom: box.bottom } : null,
      viewport: [innerWidth, innerHeight],
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  assert.deepEqual(jobModuleAction.labels, ['查看深度画像'],
    'job editor must own the deep-profile action');
  assert.deepEqual(jobModuleAction.disabled, [false],
    'local deep-profile review stays available');
  assert.ok(jobModuleAction.rect
    && jobModuleAction.rect.left >= -1 && jobModuleAction.rect.right <= jobModuleAction.viewport[0] + 1,
  'job module action strip must stay inside the 1100px viewport');
  assert.ok(jobModuleAction.documentOverflow <= 1,
    'job module action strip must not create document overflow');
  await clickExactText(win, '.job-module-action-strip button', '查看深度画像');
  try {
    await waitFor(win, "[...document.querySelectorAll('[role=dialog]')].some((dialog) => dialog.offsetParent !== null)", 'deep profile dialog');
  } catch (error) {
    const debug = await win.webContents.executeJavaScript(`(() => ({
      active: (document.activeElement?.innerText || '').trim(),
      moduleActions: [...document.querySelectorAll('.job-module-action-strip button')].map((element) => (element.textContent || '').trim()),
      bodyTail: (document.body.innerText || '').slice(-600),
    }))()`);
    throw new Error(`${error.message}; state=${JSON.stringify(debug)}; console=${JSON.stringify(errors)}`);
  }
  await waitFor(win,
    "document.activeElement?.getAttribute('aria-label') === '访谈与深度画像说明'",
    'deep profile dialog focus trap');
  await delay(120);
  const deepProfileModalEvidence = await captureEvidence(win, 'deep-profile-keyboard-1100x720');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitFor(win, "![...document.querySelectorAll('[role=dialog]')].some((dialog) => dialog.offsetParent !== null)",
    'deep profile dialog Escape close');
  await delay(120);
  const focused = await win.webContents.executeJavaScript(`(() => ({
    tag: document.activeElement?.tagName || '',
    text: (document.activeElement?.innerText || document.activeElement?.getAttribute('aria-label') || '').trim(),
    inJobModuleActions: Boolean(document.activeElement?.closest('.job-module-action-strip')),
  }))()`);
  assert.deepEqual(focused, {
    tag: 'BUTTON',
    text: '查看深度画像',
    inJobModuleActions: true,
  }, 'deep-profile modal focus must return to its job-module trigger');

  const moduleSkeletons1440 = await captureModuleSkeletons(win, 1440, 900);
  const moduleSkeletons1360 = await captureModuleSkeletons(win, 1360, 768);
  const moduleSkeletons1100 = await captureModuleSkeletons(win, 1100, 720);
  const moduleSkeletonsWindows125 = await captureModuleSkeletons(win, 1360, 768, {
    zoomFactor: 1.25,
    viewportName: '1360x768-windows125',
  });
  const moduleSkeletonsWindows150 = await captureModuleSkeletons(win, 1360, 768, {
    zoomFactor: 1.5,
    viewportName: '1360x768-windows150',
  });
  const moduleSkeletonsZoom200 = await captureModuleSkeletons(win, 1440, 900, {
    zoomFactor: 2,
    viewportName: '1440x900-zoom200',
  });
  const asynchronousStates = await verifyLoadingAndErrorStates();
  const moduleStateFailures = await verifyModuleStateFailures();
  const globalRecovery = await verifyGlobalRecoverySurface();
  const w3InterviewRuntime = await verifyW3InterviewRuntime();
  const w4Runtime = await verifyW4Runtime();
  const adversarialStateFixes = await verifyAdversarialStateFixes(win);
  const windows150RestartState = await verifyRendererRestartState(win);
  const candidateResumeLayout = await verifyCandidateResumeLayout();

  assert.deepEqual(errors, [], 'renderer must not emit console errors');
  const result = {
    ok: true,
    contract: 'UI-VISUAL-RUNTIME-001',
    skip_link_keyboard: {
      initial_focus: skipLinkInitialFocus,
      focused: skipLinkFocused,
      activation: skipLinkActivation,
      evidence: skipLinkEvidence,
    },
    interview,
    flow,
    candidate_sider_focus: candidateSiderFocus,
    candidate_roving_focus: candidateRovingFocus,
    candidate_roving_return_focus: candidateRovingReturnFocus,
    candidate_enter_activation: candidateEnterActivation,
    candidate_space_target: candidateSpaceTarget,
    candidate_space_activation: candidateSpaceActivation,
    candidate_disposition_menu: {
      '1100x720': candidateDispositionMenu1100,
      '1360x768@125%': candidateDispositionMenuWindows125,
    },
    assessment_evidence_layout: assessmentEvidenceLayout,
    asynchronous_states: asynchronousStates,
    module_state_failures: moduleStateFailures,
    candidate_tab_journey: candidateTabJourney,
    candidate_boundary: { wide: boundaryWide, split: boundarySplit },
    candidate_more_queues: moreQueueItems,
    candidate_list_identity: candidateListIdentity,
    candidate_missing_facts: missingFactDisclosure,
    scaled_shell: scaledShell,
    windows_125_candidate_toggle: windows125CandidateToggle,
    chromium_accessibility_tree: candidateAccessibilityTree,
    module_skeletons: {
      '1440x900': moduleSkeletons1440,
      '1360x768': moduleSkeletons1360,
      '1100x720': moduleSkeletons1100,
      '1360x768@125%': moduleSkeletonsWindows125,
      '1360x768@150%': moduleSkeletonsWindows150,
      '1440x900@200%': moduleSkeletonsZoom200,
    },
    candidate_action_menu: {
      '1100x720': candidateActionMenu1100,
    },
    global_recovery: globalRecovery,
    w3_interview_runtime: w3InterviewRuntime,
    w4_runtime: w4Runtime,
    adversarial_state_fixes: adversarialStateFixes,
    windows150_restart_state: windows150RestartState,
    resume_intake: {
      initial_focus: resumeInitialFocus,
      escape_focus_restore: resumeEscapeFocus,
      invalid_state: resumeInvalidState,
      submit_busy: resumeSubmitBusy,
      rejected_state: resumeRejectedState,
      committed_refresh: resumeCommittedRefresh,
      layout_720: resumeModal720,
      layout_narrow: resumeModalNarrow,
      layout_low_height: resumeModalLowHeight,
      evidence: resumeModalEvidence,
      rejected_evidence: resumeRejectedEvidence,
    },
    dashboard_todos: {
      initial: initialTodos,
      rating_preview: ratingPreview,
      expand_control: expandControl,
      expanded_rating_ids: expandedRatingIds,
      narrow: narrowTodos,
    },
    job_module_action: jobModuleAction,
    modal_focus: focused,
    evidence: {
      workbench_1440x900: workbenchEvidence,
      candidate_split_1440x900: candidateSplitEvidence,
      candidate_detail_1100x720: candidateEvidence,
      assessment_evidence_1100x720: assessmentEvidence,
      assessment_score_decision_1100x720: assessmentDecisionEvidence,
      candidate_keyboard_1100x720: keyboardEvidence,
      workbench_narrow_733x480: narrowEvidence,
      candidate_windows_125_percent: windows125Evidence,
      deep_profile_keyboard_1100x720: deepProfileModalEvidence,
    },
  };
  result.candidate_resume_layout = candidateResumeLayout;
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  win.destroy();
  return result;
}

app.whenReady().then(async () => {
  try {
    const result = await run();
    console.log(JSON.stringify(result));
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(resultPath, `${JSON.stringify({ ok: false, error: error.stack || error.message }, null, 2)}\n`, { mode: 0o600 });
    console.error(error && error.stack ? error.stack : error);
    app.exit(1);
  }
});
