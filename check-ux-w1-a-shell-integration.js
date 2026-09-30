'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
}

function cssBlock(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing CSS block: ${selector}`);
  return match[1];
}

function sourceSection(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  assert.ok(endIndex > startIndex, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

const app = read('frontend/src/App.jsx');
const topBar = read('frontend/src/components/TopBar.jsx');
const settings = read('frontend/src/components/SettingsPanel.jsx');
const guide = read('frontend/src/components/WorkflowGuidePanel.jsx');
const styles = read('frontend/src/styles.css');

// Module changes move programmatic focus and announce the new page, while the
// low-frequency navigation remains after the primary modules in DOM order.
assert.match(app, /<Content id="main-workspace" tabIndex=\{-1\}/);
assert.match(app, /previousActiveNavRef\.current === activeNav[\s\S]*?document\.getElementById\('main-workspace'\)[\s\S]*?workspace\.querySelector\('\[data-module-heading\]'\)[\s\S]*?focusTarget\.focus\(\{ preventScroll: true \}\)[\s\S]*?new MutationObserver\(focusWorkspace\)/);
assert.match(app, /data-module-heading tabIndex=\{-1\}/);
assert.match(app, /className="module-route-announcer" role="status" aria-live="polite" aria-atomic="true"/);
assert.ok(app.indexOf('className="nav-primary"') < app.indexOf('className="nav-utility app-nav-footer"'));
assert.match(cssBlock(styles, '.nav-utility'), /margin-top:\s*auto/);
assert.match(app, /UTILITY_NAV_ITEMS = \['使用指南', '设置', '关于\/版本', '本机状态'\]/);
assert.match(app, /'关于\/版本': 'settings-advanced'/);
assert.match(app, /本机状态: 'settings-overview'/);
assert.match(settings, /招才官/);
assert.match(settings, /APP_RUNTIME_STACK/);
assert.doesNotMatch(guide, /顶部操作菜单/);
assert.match(guide, /候选人 → 候选人操作 → 导入 Boss App 截图/);
assert.match(guide, /职位管理 → 管理 JD\/画像 → 查看深度画像/);
assert.match(settings, /settings-section-announcer" role="status" aria-live="polite"/);
assert.match(settings, /document\.getElementById\(`\$\{activeSection\}-title`\)\?\.focus\(\{ preventScroll: true \}\)/);

// TopBar is global recovery only and every required App prop is wired.
assert.doesNotMatch(app, /extraActions=/);
assert.doesNotMatch(topBar, /Dropdown|操作菜单|onOpenBossLogin/);
const recoveryCss = cssBlock(styles, '.topbar-global-recovery');
assert.match(recoveryCss, /display:\s*flex/);
assert.match(recoveryCss, /flex-wrap:\s*wrap/);
assert.doesNotMatch(recoveryCss, /overflow(?:-x)?:\s*(?:auto|scroll|hidden)/);
const topbarActionsLayout = styles.slice(
  styles.indexOf('.topbar-actions {\n  display: grid'),
  styles.indexOf('.topbar-actions {\n  display: grid') + 320,
);
assert.match(topbarActionsLayout, /overflow:\s*visible/);
assert.match(styles, /@media \(min-width: 901px\) and \(max-width: 1180px\)[\s\S]*?\.topbar-actions\s*\{[\s\S]*?grid-column:\s*1 \/ -1/);

// Every action removed from TopBar has a visible module-owned destination.
[
  '导入 Boss App 截图',
  '校对 OCR 草稿',
  '批量规则评级',
  '查看深度画像',
].forEach((label) => assert.match(app, new RegExp(label.replace(/[（）]/g, (value) => `\\${value}`))));
assert.match(app, /className="job-module-action-strip" role="group" aria-label="职位模块操作"/);
assert.match(app, /className="candidate-module-actions"/);

// Readonly/closed/fixture and stale candidate-authority paths keep module writes locked.
assert.match(app, /const candidateAuthorityWriteBlocked = !\['ready', 'empty'\]\.includes\(candidateListState\)/);
assert.match(sourceSection(app, "key: 'import-screenshots'", "key: 'review-screenshot-ocr'"), /disabled: jobReadOnly \|\| candidateAuthorityWriteBlocked \|\| !jobId \|\| screenshotImportBusy/);
assert.match(sourceSection(app, "key: 'review-screenshot-ocr'", "key: 'rate'"), /disabled: jobReadOnly \|\| candidateAuthorityWriteBlocked \|\| !jobId/);
assert.match(sourceSection(app, "key: 'rate'", 'function handleCandidateAction'), /disabled: jobReadOnly \|\| candidateAuthorityWriteBlocked \|\| !jobId \|\| rateBusy/);
assert.match(app, /disabled=\{jobReadOnly \|\| candidateAuthorityWriteBlocked \|\| !jobId\}[\s\S]*?onClick=\{handlePrepareCandidateFromResume\}/);
assert.match(sourceSection(app, 'function handleCandidateAction({ key })', 'function handleOpenDeepProfileFromGuide()'), /if \(candidateAuthorityWriteBlocked[\s\S]*?\['import-screenshots', 'review-screenshot-ocr', 'rate'\]\.includes\(key\)\)[\s\S]*?return;[\s\S]*?if \(key === 'import-screenshots'\) handleImportScreenshots\(\)/);
assert.match(sourceSection(app, 'async function handlePrepareCandidateFromResume()', 'async function handleCommitCandidateFromResume(fields)'), /if \(candidateAuthorityWriteBlocked\) \{[\s\S]*?return;[\s\S]*?setResumeIntakeBusy\(true\)/);
assert.match(sourceSection(app, 'async function handleCommitCandidateFromResume(fields)', 'async function handleOpenSettings('), /if \(candidateAuthorityWriteBlocked\) \{[\s\S]*?return;[\s\S]*?setResumeIntakeBusy\(true\)/);
assert.match(sourceSection(app, 'async function handleRunRate()', 'async function pollRate(context)'), /if \(candidateAuthorityWriteBlocked\) \{[\s\S]*?return;[\s\S]*?setRateBusy\(true\)/);
assert.match(sourceSection(app, 'async function handleImportScreenshots()', 'async function refreshJobs('), /if \(candidateAuthorityWriteBlocked\) \{[\s\S]*?return;[\s\S]*?setScreenshotImportBusy\(true\)/);
assert.match(app, /readOnly=\{jobReadOnly \|\| currentJobIsFixture\}/);
assert.equal((app.match(/onReturnLedger=\{handleReturnJobLedger\}/g) || []).length, 2);
assert.doesNotMatch(app, /className="job-editor-toolbar"/);

console.log(JSON.stringify({
  ok: true,
  contract: 'UX-W1-A-SHELL-INTEGRATION',
  navigation_focus_and_announcement: true,
  utility_navigation_bottom_anchored: true,
  topbar_global_recovery_only: true,
  module_action_migration_complete: true,
  responsive_recovery_not_scroll_hidden: true,
  readonly_and_fixture_locks_preserved: true,
  candidate_authority_writes_fail_closed: true,
}));
