#!/usr/bin/env node
'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function pixelFontSizes(source) {
  return [...source.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
}

const theme = read('frontend/src/theme.js');
const styles = read('frontend/src/styles.css');
const foundation = read('frontend/src/v2-foundation.css');
const decisionUi = read('frontend/src/decision-ui.css');
const workbenchV2 = read('frontend/src/workbench-v2.css');
const candidateV2 = read('frontend/src/candidate-v2.css');
const mainEntry = read('frontend/src/main.jsx');
const viteConfig = read('frontend/vite.config.js');
const api = read('frontend/src/api.js');
const topbar = read('frontend/src/components/TopBar.jsx');
const jobLedger = read('frontend/src/components/JobLedgerPanel.jsx');
const jobManagementDemo = read('frontend/src/components/JobManagementDemo.jsx');
const jobManagementWorkspace = read('frontend/src/components/job-management-workspace.jsx');
const talentPool = read('frontend/src/components/TalentPoolDemo.jsx');
const settings = read('frontend/src/components/SettingsPanel.jsx');
const app = read('frontend/src/App.jsx');
const candidateDetail = read('frontend/src/components/CandidateDetail.jsx');
const candidateList = read('frontend/src/components/CandidateList.jsx');
const assessmentArchive = read('frontend/src/components/AssessmentArchivePanel.jsx');
const dashboard = read('frontend/src/components/DashboardPanel.jsx');
const interviewReview = read('frontend/src/components/InterviewReviewPanel.jsx');
const interviewSchedule = read('frontend/src/components/InterviewScheduleCanonical.jsx');
const ocrReview = read('frontend/src/components/ScreenshotOcrReviewModal.jsx');

assert.match(
  viteConfig,
  /antd\\\/\(\?:es\|lib\)\\\/table[\s\S]*?return 'antd-table-vendor'[\s\S]*?return 'antd-vendor'/,
  'the large Ant Design vendor bundle must keep Table in a stable separate chunk',
);

assert.match(theme, /colorPrimary: '#0067c5'/);
assert.match(theme, /colorPrimaryHover: '#0058aa'/);
assert.match(theme, /colorPrimaryActive: '#004b91'/);
assert.match(theme, /colorBgLayout: '#f5f6f8'/);
assert.match(theme, /colorBorder: '#d7dce2'/);
assert.match(theme, /colorTextTertiary: '#5d6976'/);
assert.match(theme, /colorTextQuaternary: '#5d6976'/);
assert.match(theme, /colorTextPlaceholder: '#5d6976'/);
assert.match(theme, /fontSizeHeading1: 28/);
assert.match(theme, /fontSizeHeading2: 21/);
assert.match(theme, /fontSizeHeading3: 17/);
assert.match(theme, /fontSizeHeading4: 15/);
assert.match(theme, /fontSizeHeading5: 13/);
assert.match(theme, /fontWeightStrong: 600/);
assert.match(theme, /controlHeight: 34/);
assert.match(theme, /controlHeightSM: 30/);
assert.match(theme, /controlHeightLG: 38/);
assert.match(theme, /controlOutlineWidth: 3/);
assert.match(theme, /controlBorder: '#83909c'/);
assert.match(theme, /defaultBorderColor: hbSemanticTokens\.controlBorder/);
assert.match(theme, /Input: \{[\s\S]*?colorBorder: hbSemanticTokens\.controlBorder/);
assert.match(theme, /Select: \{[\s\S]*?colorBorder: hbSemanticTokens\.controlBorder/);
assert.match(theme, /Skeleton: \{[\s\S]*?gradientFromColor:[\s\S]*?gradientToColor:[\s\S]*?paragraphLiHeight: 12/);
assert.match(theme, /primaryShadow: '0 1px 1px rgba\(0, 57, 112, 0\.16\)'/);
assert.match(theme, /export const HB_CSS_VARIABLES = Object\.freeze\(\{/);
assert.match(theme, /export function applyHbCssVariables/);
assert.match(theme, /export const SABC_COLOR = hbSemanticTokens\.grade/);
assert.match(interviewSchedule, /data-interview-workspace="canonical"[\s\S]*?data-fixture-mode=\{fixtureMode \? 'true' : 'false'\}/,
  'formal and fixture interview schedules must share one visually owned workspace');
assert.match(interviewSchedule, /isCurrentSession \? '当前面试' : '历史面试'[\s\S]*?当前待办：\{sessionCurrentTodo\(session\)\}/,
  'interview headers must own the current/history and next-task hierarchy');
assert.match(app, /job\?\.is_fixture \? <InterviewSchedulePanel[\s\S]*?: <InterviewScheduleCanonical/);
assert.match(mainEntry, /import \{ applyHbCssVariables, themeConfig \} from '\.\/theme\.js';/);
assert.ok(
  mainEntry.indexOf('applyHbCssVariables();') < mainEntry.indexOf('ReactDOM.createRoot'),
  'HB CSS variables must be installed before React renders',
);
assert.ok(
  mainEntry.indexOf("import './v2-foundation.css';") > mainEntry.indexOf("import './styles.css';"),
  'the V2 foundation must load after legacy styles',
);
assert.ok(
  mainEntry.indexOf("import './decision-ui.css';") > mainEntry.indexOf("import './v2-foundation.css';"),
  'the decision UI system must load after the shared foundation',
);
for (const source of [styles, foundation, decisionUi]) {
  assert.doesNotMatch(source, /--hb-[a-z0-9-]+\s*:/i, 'CSS must consume, not redefine, HB semantic tokens');
}
const hbVariableDefinitions = new Set(
  [...theme.matchAll(/'(--hb-[a-z0-9-]+)':/gi)].map((match) => match[1]),
);
const hbVariableUses = new Set(
  [styles, foundation, decisionUi, workbenchV2, candidateV2]
    .flatMap((source) => [...source.matchAll(/var\((--hb-[a-z0-9-]+)/gi)].map((match) => match[1])),
);
const missingHbVariables = [...hbVariableUses].filter((name) => !hbVariableDefinitions.has(name));
assert.deepEqual(missingHbVariables, [], 'every consumed HB variable must come from theme.js');
assert.match(theme, /'--hb-type-caption': px\(themeConfig\.token\.fontSizeSM\)/);
assert.match(theme, /compactFontSize: 12/);
assert.match(theme, /'--hb-type-compact': px\(hbSemanticTokens\.compactFontSize\)/);
assert.match(theme, /'--hb-type-body': px\(themeConfig\.token\.fontSize\)/);
assert.match(theme, /'--hb-type-section': px\(themeConfig\.token\.fontSizeHeading3\)/);
assert.match(theme, /'--hb-type-title': px\(themeConfig\.token\.fontSizeHeading2\)/);
assert.match(theme, /'--hb-type-display': px\(themeConfig\.token\.fontSizeHeading1\)/);
assert.match(theme, /'--hb-v2-brand': themeConfig\.token\.colorPrimary/);
assert.match(theme, /'--hb-v2-brand-hover': themeConfig\.token\.colorPrimaryHover/);
assert.match(theme, /'--hb-v2-brand-active': themeConfig\.token\.colorPrimaryActive/);
assert.match(theme, /'--hb-v2-control-border': hbSemanticTokens\.controlBorder/);
assert.match(foundation, /body \{[\s\S]*?letter-spacing: 0;/);
assert.doesNotMatch(foundation, /letter-spacing:\s*-\d/);
assert.match(foundation, /font-family: var\(--hb-font-family\)/);
assert.doesNotMatch(foundation, /\.ant-/,
  'shared foundation must not target Ant Design internal DOM');
assert.doesNotMatch(foundation, /!important/,
  'shared foundation must not override component precedence');
assert.doesNotMatch(decisionUi, /!important/,
  'active decision UI layer must not require important overrides');
assert.doesNotMatch(candidateV2, /!important/,
  'candidate V2 layer must not require important overrides');
assert.doesNotMatch(styles, /!important/,
  'loaded legacy CSS must not override AntD 5 or semantic feature styles with important');
for (const source of [decisionUi, workbenchV2, candidateV2]) {
  assert.doesNotMatch(source, /#[0-9a-f]{3,8}|rgba?\([^)]*\)/i,
    'active feature CSS must consume colors from theme.js');
}
assert.doesNotMatch(decisionUi, /\.ant-/,
  'decision UI must use owned classes and AntD public semantic APIs');
assert.doesNotMatch(workbenchV2, /\.ant-/,
  'workbench V2 must use owned classes and AntD public semantic APIs');
assert.doesNotMatch(candidateV2, /\.ant-[a-z0-9_-]+/i,
  'candidate V2 must style Segmented through public root/option classes and component tokens');
assert.match(api, /function recLabel\(raw\)[\s\S]*?return match \? `推荐·第\$\{match\[1\]\}位` : '';/);

assert.match(theme, /Button: \{[\s\S]*?defaultBorderColor: hbSemanticTokens\.controlBorder/);
assert.match(theme, /Segmented: \{[\s\S]*?trackBg: '#eceff2'/);
assert.match(theme, /Pagination: \{[\s\S]*?itemActiveBg: '#eef6ff'[\s\S]*?itemActiveColor: '#004b91'[\s\S]*?itemActiveColorHover: '#0058aa'[\s\S]*?itemLinkBg: 'transparent'[\s\S]*?itemSizeSM: 30/);
assert.match(mainEntry, /button=\{\{ autoInsertSpace: false \}\}/);
assert.match(app, /id="app-primary-navigation"[\s\S]*?width=\{196\}[\s\S]*?collapsedWidth=\{0\}[\s\S]*?collapsed=\{appNavCollapsed\}[\s\S]*?trigger=\{null\}/,
  'desktop app navigation must collapse completely instead of leaving an icon rail');
assert.match(app, /APP_NAV_COLLAPSED_STORAGE_KEY = 'hrboss\.ui\.appNavCollapsed\.v1'/);
assert.match(app, /writeStoredBoolean\(APP_NAV_COLLAPSED_STORAGE_KEY, appNavCollapsed\)/,
  'desktop app navigation preference must use the guarded UI preference helper');
assert.match(app, /aria-label="收起主侧栏"[\s\S]*?aria-controls="app-primary-navigation"[\s\S]*?aria-expanded="true"/);
assert.match(app, /aria-label="展开主侧栏"[\s\S]*?aria-controls="app-primary-navigation"[\s\S]*?aria-expanded="false"/);
assert.match(app, /className=\{`app-nav-footer-main \$\{\['设置', '使用指南'\]\.includes\(activeNav\) \? 'active' : ''\}`\}/,
  'the unified desktop utility trigger must identify Settings and Guide as active destinations');
assert.match(app, /trigger=\{\['click'\]\}[\s\S]*?autoFocus[\s\S]*?open=\{utilityMenuOpen\}[\s\S]*?onOpenChange=\{setUtilityMenuOpen\}/,
  'the desktop utility menu must retain controlled keyboard and Escape state');
assert.match(app, /appNavFocusHandoffRef\.current = collapsed \? 'restore' : 'collapse'[\s\S]*?setAppNavCollapsed\(collapsed\)/,
  'desktop app navigation toggle must declare the focus handoff before changing visibility');
assert.match(app, /!appNavCollapsed && \([\s\S]*?className="app-nav-content"/,
  'collapsed navigation content must be removed from the keyboard tab order');
assert.match(decisionUi, /\.app-nav \{[\s\S]*?transition:[\s\S]*?180ms cubic-bezier/,
  'desktop navigation transition must remain brief and state-driven');
assert.match(decisionUi, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.app-nav,\s*\.app-nav-footer-disclosure,[\s\S]*?\{\s*transition: none;/,
  'desktop navigation transition must honor reduced motion');
assert.match(decisionUi, /@media \(max-width: 900px\) \{[\s\S]*?\.app-nav-restore-toggle \{\s*display: none;/,
  'mobile module navigation must not expose the desktop sidebar toggle');
assert.match(app, /const CANDIDATE_LIST_SELECTED_WIDTH = 'clamp\(400px, 46%, 620px\)'/);
assert.match(app, /const CANDIDATE_LIST_EMPTY_WIDTH = 'clamp\(520px, 68%, 820px\)'/);
assert.match(app, /<Sider[\s\S]*?id=\{CANDIDATE_LIST_PANEL_ID\}[\s\S]*?width=\{selectedId \? CANDIDATE_LIST_SELECTED_WIDTH : CANDIDATE_LIST_EMPTY_WIDTH\}/);
assert.doesNotMatch(app, /<Sider[\s\S]*?id=\{CANDIDATE_LIST_PANEL_ID\}[\s\S]*?width=\{300\}/);
assert.match(app, /className="skip-link"\s+href="#main-workspace"/);
assert.match(app, /globalThis\.scrollTo\?\.\(\{ top: 0, left: 0, behavior: 'auto' \}\)[\s\S]*?workspace\.scrollTop = 0[\s\S]*?workspace\.scrollLeft = 0[\s\S]*?focusTarget\.focus\(\{ preventScroll: true \}\)/,
  'module navigation must reset document and workspace scroll before handing focus to the new heading');
assert.match(app, /PRIMARY_NAV_ITEMS = \['工作台', '职位管理', '候选人', '面试安排', '人才库'\]/);
assert.match(app, /UTILITY_NAV_ITEMS = \['使用指南', '设置', '关于\/版本', '本机状态'\]/);
assert.match(app, /DESKTOP_UTILITY_MENU_ITEMS = Object\.freeze\(\[[\s\S]*?使用指南[\s\S]*?设置中心[\s\S]*?本机状态[\s\S]*?关于招才官/);
assert.match(app, /className="app-nav-footer-label">设置与帮助<\/span>/);
assert.match(app, /aria-label="打开设置与帮助菜单"[\s\S]*?aria-controls=\{APP_NAV_UTILITY_MENU_ID\}/);
assert.doesNotMatch(app, /HRboss工作台|app-nav-help-button/);
assert.doesNotMatch(app, /className="nav-utility-label"|nav-item nav-utility-item/);
assert.match(decisionUi, /\.nav-utility \{[\s\S]*?min-height: 62px;[\s\S]*?margin-top: auto;/);
assert.match(decisionUi, /\.app-nav-footer-main \{[\s\S]*?display: flex;[\s\S]*?min-height: 44px;[\s\S]*?height: 44px;[\s\S]*?border-radius: 6px;/);
assert.doesNotMatch(decisionUi, /\.app-nav-footer-main > span:last-child|\.app-nav-help-button/);
assert.match(app, /showSabcFilter=\{activeNav === '候选人'\}/);
assert.doesNotMatch(app, /CANDIDATE_DETAIL_FOCUS_BREAKPOINT_PX|shouldFocusDetail|candidateListAutoCollapseRef|narrowDetailQuery/,
  'candidate selection and viewport changes must not auto-hide the list');
assert.match(app, /writeStoredBoolean\(CANDIDATE_LIST_COLLAPSED_STORAGE_KEY, candidateListCollapsed\)/,
  'manual candidate list collapse remains a user preference');
assert.doesNotMatch(topbar, /Dropdown|操作菜单|topbar-operation-/,
  'TopBar must not retain the cross-domain operation menu');
assert.doesNotMatch(styles, /\.topbar-operation-/,
  'global styles must not retain dead cross-domain operation menu selectors');
assert.doesNotMatch(styles, /\.detail-tabs(?:\.ant-segmented|\s+\.ant-segmented)/,
  'the current detail-tabs Space toolbar must not retain dead Segmented descendant selectors');
assert.match(topbar, /className="topbar-global-recovery" role="group" aria-label="全局状态与恢复"/);
assert.match(topbar, /className="topbar-refresh-local"/);
assert.match(styles, /\.topbar-global-recovery \{[\s\S]*?display: flex;[\s\S]*?flex-wrap: wrap;/);
assert.match(theme, /Menu: \{[\s\S]*?dropdownWidth: 238[\s\S]*?groupTitleFontSize: 12[\s\S]*?itemDisabledColor: '#7a8792'[\s\S]*?iconSize: 14/);
assert.match(theme, /Tabs: \{[\s\S]*?itemSelectedColor: '#004b91'[\s\S]*?horizontalItemPadding: '8px 0'[\s\S]*?horizontalMargin: '0 0 12px 0'/,
  'the single interview Tabs instance must consume its final spacing and selected color from AntD 5 component tokens');
assert.match(theme, /Menu: \{[\s\S]*?dangerItemColor: '#b13f43'[\s\S]*?dangerItemHoverColor: '#9e373b'[\s\S]*?dangerItemActiveBg: '#fff1f1'[\s\S]*?dangerItemSelectedColor: '#9e373b'[\s\S]*?dangerItemSelectedBg: '#fff1f1'/,
  'candidate destructive dispositions must consume the public AntD 5 Menu danger tokens');
assert.match(styles, /\.topbar-actions \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) max-content;[\s\S]*?overflow: visible;/);
assert.match(styles, /@media \(min-width: 901px\) and \(max-width: 1180px\)[\s\S]*?\.topbar-actions \{[\s\S]*?grid-column: 1 \/ -1;/);
assert.match(styles, /@media \(max-width: 900px\) \{[\s\S]*?\.topbar \{\s*grid-template-columns: minmax\(0, 1fr\) minmax\(112px, 42%\);/);
assert.match(styles, /\.topbar-source\.empty \{\s*display: none;/);
assert.match(styles, /\.candidate-detail-content \{[\s\S]*?container-name: candidate-detail;[\s\S]*?container-type: inline-size;/);
assert.match(decisionUi, /\.candidate-list-panel-toggle \{[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px;[\s\S]*?height: 44px;/);
assert.match(decisionUi, /\.candidate-list-panel-toggle:focus-visible \{[\s\S]*?outline: 2px solid var\(--hb-primary\)/);
assert.match(decisionUi, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.candidate-list-panel-toggle,[\s\S]*?\.candidate-list-panel-toggle-icon \{\s*transition: none;/);
assert.match(decisionUi, /\.app-nav-toggle \{[\s\S]*?width: 44px;[\s\S]*?min-width: 44px;[\s\S]*?height: 44px;/);
assert.doesNotMatch(`${app}\n${styles}\n${decisionUi}`, /candidate-edge-toggle|candidate-edge-triangle|candidate-list-restore-inline/);
assert.doesNotMatch(`${styles}\n${decisionUi}`, /candidate-(?:list-panel-toggle|list-collapse-toolbar|list-restore-control)[^}]*animation:\s*[^;}]*(?:infinite|pulse|breath)/i);
assert.doesNotMatch(`${jobManagementDemo}\n${jobManagementWorkspace}\n${styles}\n${decisionUi}`,
  /job-management-(?:edge-toggle|edge-triangle|shell-collapsed|list-shell|list-card|job-list|job-row)/,
  'statically unreferenced job-list collapse implementation and styles must be removed together');
assert.match(styles, /@container candidate-detail \(max-width: 860px\) \{[\s\S]*?\.interview-status-panel,[\s\S]*?\.flow-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/);
assert.match(styles, /\.flow-event-head \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
assert.match(decisionUi, /\.app-nav \{[\s\S]*?border-right: 1px solid var\(--hb-border\);[\s\S]*?background: var\(--hb-shell\);/);
assert.match(decisionUi, /\.nav-item\.active \{[\s\S]*?background: var\(--hb-primary-soft\);[\s\S]*?color: var\(--hb-primary-active\);[\s\S]*?box-shadow: none;/);
assert.match(decisionUi, /\.nav-item\.active::before,[\s\S]*?\.nav-item\.active::after \{[\s\S]*?display: none;[\s\S]*?animation: none;/);
assert.match(decisionUi, /\.top-header \{[\s\S]*?min-height: 54px;[\s\S]*?background: var\(--hb-surface-soft\);[\s\S]*?backdrop-filter: none;/);
assert.doesNotMatch(decisionUi, /(?:linear|radial|conic|repeating-linear)-gradient\(/);
assert.doesNotMatch(decisionUi, /\.nav-item[^}]*border-left:\s*[234]px\s+solid/);
assert.match(styles, /\.candidate-queue-tab\.active \{[\s\S]*?background: var\(--hb-primary-soft\)/);
assert.doesNotMatch(styles, /\.candidate-pagination \.ant-pagination-item,[\s\S]*?\.candidate-pagination \.ant-pagination-next/,
  'candidate pagination geometry must come from the AntD 5 Pagination itemSizeSM token');
assert.doesNotMatch(styles, /\.candidate-pagination \.ant-pagination-item-active\s+a/,
  'candidate pagination active text color must come from public Pagination tokens');
assert.match(styles, /\.candidate-pagination \.ant-pagination-item-active \{\s*box-shadow: inset 0 0 0 1px var\(--hb-primary-border-subtle\);\s*\}/);
assert.match(styles, /\.candidate-pagination \.ant-pagination-prev:hover,[\s\S]*?background: var\(--hb-control-item-hover-bg\);/);
assert.match(styles, /\.ant-btn:focus-visible \{\s*box-shadow: var\(--hb-focus-ring\);\s*\}/);
assert.match(styles, /\.ant-btn:disabled,[\s\S]*?background: #f1f3f5;[\s\S]*?color: #9aa4b2;/);
assert.doesNotMatch(styles, /@keyframes\s+(nav-active-shimmer|nav-active-sheen|candidate-edge-breathe)/);
assert.doesNotMatch(topbar, /gateCanWrite|写入受限/);
assert.doesNotMatch(topbar, /bossLoginStatus|bossLoginLabel|operationButtonRef|extraActions|operationalReadOnly|runningTask/);
assert.match(jobLedger, /width: readOnly \? 164 : 216/);
assert.match(jobLedger, /className="job-ledger-compact-list"[\s\S]*?filteredJobs\.map/);
assert.match(workbenchV2, /@media \(max-width: 1679px\) \{[\s\S]*?\.job-ledger-table-card\s*\{[\s\S]*?display:\s*none;[\s\S]*?\.job-ledger-compact-list\s*\{[\s\S]*?display:\s*grid;/);
for (const removedClass of [
  'job-management-jd-card',
  'job-management-jd-layout',
  'job-management-jd-input',
  'job-management-jd-output',
  'job-management-jd-checks',
  'job-management-jd-tags',
  'job-management-generated-jd',
  'job-management-generated-section',
  'job-management-jd-check-grid',
  'job-management-check-list',
  'job-management-check-item',
  'dashboard-safety-strip',
  'candidate-disposition-groups',
  'candidate-disposition-group',
  'nav-footer',
  'nav-footer-icon',
  'dashboard-job-facts',
  'dashboard-gate-grid',
  'dashboard-rating-row',
  'dashboard-boss-card',
  'dashboard-module-grid',
  'dashboard-module-card',
  'dashboard-module-head',
  'dashboard-module-foot',
]) {
  assert.doesNotMatch(styles, new RegExp(`\\.${removedClass}(?![a-z0-9-])`, 'i'),
    `${removedClass} was removed only after static references and runtime coverage both proved it dead`);
}
assert.match(jobManagementDemo, /className="job-management-jd-section-grid"/);
assert.match(jobManagementDemo, /className="job-management-jd-review-grid"/);
assert.match(jobManagementDemo, /className="job-management-jd-actions"/);
assert.match(jobManagementWorkspace, /className="job-management-shell"/);
assert.match(styles, /\.job-management-shell \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
assert.match(jobManagementWorkspace, /data-job-management-action-schema=\{Object\.values\(JOB_MANAGEMENT_ACTION_SCHEMA\)/);
assert.match(jobManagementWorkspace, /className="job-management-hero"/);
assert.match(jobManagementWorkspace, /className="job-management-section-tabs"[\s\S]*?<Segmented/);
assert.equal((jobManagementWorkspace.match(/<Title level=\{3\}[^>]*>/g) || []).length, 1,
  'the shared job workspace must own the single body job title');
assert.deepEqual(
  [...jobManagementWorkspace.matchAll(/\{ label: '([^']+)', value: '([^']+)' \}/g)].map((match) => [match[1], match[2]]),
  [['JD 与版本', 'jd'], ['岗位画像', 'profile']],
  'the shared workspace must expose only the current JD and profile sections',
);
const jobManagementFixtureRender = jobManagementDemo.slice(jobManagementDemo.indexOf('export default function JobManagementDemo'));
assert.match(jobManagementFixtureRender, /<JobManagementWorkspace[\s\S]*?activeSection === 'jd'[\s\S]*?className="job-management-section-panel job-management-jd-workspace"/);
assert.match(jobManagementFixtureRender, /activeSection === 'profile'[\s\S]*?className="job-management-section-panel job-management-profile-workspace"/);
assert.doesNotMatch(jobManagementFixtureRender, /<PriorityStrip|<SectionTabs|<JobOperationPanel/,
  'fixture runtime must not render the retired priority strip, duplicate tabs, or local operation panel');
assert.match(styles, /\.job-management-hero \{[\s\S]*?display: flex;[\s\S]*?justify-content: space-between;/);
assert.match(styles, /\.job-management-section-tabs \{[\s\S]*?display: flex;[\s\S]*?flex-wrap: wrap;/);
assert.match(styles, /\.job-management-section-panel \{[\s\S]*?min-width: 0;/);
assert.match(candidateDetail, /className=\{`candidate-disposition-visible-actions\$\{contextualTaskAction \? ' has-contextual-primary' : ''\}`\}/);
const jobLedgerPriorityColumns = ['岗位', '状态', '剩余 HC', '最近变更', 'HR 负责人', '计划 HC', '已录用', '候选人数', '操作'];
let previousJobLedgerColumn = -1;
for (const title of jobLedgerPriorityColumns) {
  const nextColumn = jobLedger.indexOf(`title: '${title}'`);
  assert.ok(nextColumn > previousJobLedgerColumn, `job ledger column ${title} must preserve the evidence-first priority order`);
  previousJobLedgerColumn = nextColumn;
}
assert.match(talentPool, /className="talent-pool-kicker">人才库</);
assert.match(talentPool, /role="status" aria-live="polite"[\s\S]*?正在读取本地人才库…/);
assert.match(talentPool, /enterButton="搜索"/);
assert.match(talentPool, /<Select aria-label="筛选人才状态"/);
assert.match(talentPool, /aria-label=\{`打开\$\{talent\.name/);
for (const label of ['职位名称', '城市', '薪资', 'HC', '开放天数', 'JD 简单需求', '当前职位描述']) {
  assert.match(jobManagementDemo, new RegExp(`aria-label="${label}"`));
}
assert.match(interviewReview, /aria-label=\{readOnly \? '刷新只读面试历史' : '刷新录音记录'\}/);
assert.match(interviewSchedule, /onClick=\{\(\) => onOpenCandidate\(session\.candidate_id, 'interview'\)\}>打开候选人<\/Button>/);
assert.match(interviewSchedule, /<section aria-label="面试安排页内待办清单">[\s\S]*?role="list"[\s\S]*?role="listitem"/);
assert.match(interviewSchedule, /aria-label=\{`\$\{session\.candidate_name \|\| '候选人'\}面试邀约话术`\}/);
assert.match(app, /modalReturnFocusRef/);
assert.match(app, /returnTarget\?\.isConnected[\s\S]*?returnTarget\.focus\(\)/);
assert.match(dashboard, /todoContextLabel[\s\S]*?dashboard-todo-context/);
assert.match(dashboard, /const TODO_PREVIEW_LIMIT = 3/);
assert.match(dashboard, /const visibleTodos = todosExpanded \? filteredTodos : filteredTodos\.slice\(0, TODO_PREVIEW_LIMIT\)/);
assert.doesNotMatch(dashboard, /filteredTodos\.sort|todos\.sort/);
assert.match(dashboard, /<Radio\.Group[\s\S]*?aria-label="筛选待办事项"/);
assert.match(dashboard, /<ul id="dashboard-todo-list"[\s\S]*?<li[\s\S]*?key=\{item\.todo_id\}/);
assert.match(dashboard, /aria-expanded=\{todosExpanded\}[\s\S]*?aria-controls="dashboard-todo-list"/);
assert.match(dashboard, /aria-label=\{`\$\{actionLabel\}：\$\{contextLabel\}`\}/);
assert.match(dashboard, /TODO_ACTION_LABELS\[item\.code\] \|\| '查看详情'/);
assert.doesNotMatch(dashboard, />前往处理<|失败任务可重试/);
assert.match(dashboard, /Array\.isArray\(workbench\?\.candidates\)/);
assert.match(dashboard, /className="dashboard-channel-head"/);
assert.match(dashboard, /className="dashboard-metric-item"/);
assert.doesNotMatch(styles, /\.dashboard-metrics[^,{\n]*\.ant-card/,
  'dashboard metrics no longer render AntD Card internals');
assert.doesNotMatch(styles, /\.candidate-fact-strip[^,{\n]*\.ant-col/,
  'candidate facts no longer render AntD Row or Col internals');
assert.doesNotMatch(styles, /\.candidate-disposition[^,{\n]*\.ant-space(?:-item)?/,
  'candidate disposition actions no longer render AntD Space internals');
assert.doesNotMatch(dashboard, />HR 工作台<|>岗位快照<|>需要人工判断<|>本地招聘链路<|>本地主流程</);
assert.match(dashboard, /id="dashboard-todo-heading"[^>]*>待办事项/);
assert.match(dashboard, /id="dashboard-progress-heading">招聘进度/);
assert.match(dashboard, /import '\.\.\/workbench-v2\.css';/);
assert.match(dashboard, /className="dashboard-progress-section dashboard-v2-summary"/);
assert.match(dashboard, /className=\{`dashboard-card dashboard-todo-card \$\{todos\.length \? '' : 'is-empty'\}`\}/);
assert.match(dashboard, /className="dashboard-todo-clear" role="status"/);
assert.match(workbenchV2, /\.dashboard-v2-focus-grid\.is-clear \{[\s\S]*?"summary"[\s\S]*?"todos";/);
assert.match(workbenchV2, /\.dashboard-todo-card\.is-empty \{[\s\S]*?min-height: 0;/);
assert.match(workbenchV2, /grid-template-areas: "todos summary";/);
assert.match(workbenchV2, /grid-template-columns: minmax\(0, 1fr\) minmax\(290px, 320px\);/);
assert.match(workbenchV2, /@media \(max-width: 1020px\) \{[\s\S]*?grid-template-areas:[\s\S]*?"todos"[\s\S]*?"summary";/);
assert.match(workbenchV2, /\.dashboard-todo-card \{[\s\S]*?box-shadow: none;/);
assert.match(workbenchV2, /\.dashboard-todo-row\.attention,[\s\S]*?border: 1px solid var\(--hb-v2-warning-border\);/);
assert.doesNotMatch(workbenchV2, /font-size:\s*clamp\(/);
assert.ok(Math.min(...pixelFontSizes(workbenchV2)) >= 12, 'workbench V2 text must stay on the 12px-and-up type scale');
assert.match(styles, /@media \(max-width: 760px\) \{[\s\S]*?\.dashboard-todo-row \{\s*grid-template-columns: minmax\(0, 1fr\);/);
assert.match(candidateDetail, /candidateSourceLabel\(c\)/);
assert.match(candidateDetail, /function candidateDispositionLabel\(candidate\)[\s\S]*?new: '新入库'/);
assert.match(candidateDetail, /function manualActionLabel\(application, candidate\)[\s\S]*?new: '新入库'/);
assert.match(candidateDetail, /className="detail-shell candidate-v2-detail"/);
assert.match(candidateDetail, /className=\{`candidate-v2-body/);
assert.doesNotMatch(candidateDetail, /candidate-v2-decision-rail|<aside\b/);
assert.match(candidateDetail, /className="detail-card candidate-overview-card"/);
assert.match(candidateDetail, /className="detail-card candidate-overview-card"[\s\S]*?classNames=\{\{ body: 'candidate-overview-card-body' \}\}/);
assert.match(candidateDetail, /className="detail-card candidate-command-card candidate-disposition-card candidate-taskbar"/);
assert.match(candidateDetail, /rootClassName="candidate-communication-drawer"/);
assert.match(candidateDetail, /className="candidate-workspace-head"/);
assert.match(candidateDetail, /className="detail-card candidate-workspace-card"[\s\S]*?classNames=\{\{ body: 'candidate-workspace-card-body' \}\}/);
assert.match(candidateDetail, /className=\{`candidate-disposition-visible-actions\$\{contextualTaskAction \? ' has-contextual-primary' : ''\}`\}/);
assert.match(candidateDetail, /has\(c\.rec_position\) \? recLabel\(c\.rec_position\) : ''/);
assert.match(candidateDetail, /\{heroMeta && <div className="hero-meta">\{heroMeta\}<\/div>\}/);
assert.doesNotMatch(candidateDetail, /目标岗位待补全/);
assert.match(candidateDetail, /unchanged \? \([\s\S]*?communication-backfill-idle[\s\S]*?: \([\s\S]*?沟通事实备注/);
assert.match(candidateDetail, />\s*更多处置\s*<\/Button>/);
assert.match(candidateDetail, /moreActions = \['talent_pool', 'reject', 'withdraw', 'hired'\]/);
assert.match(candidateDetail, /aria-label="打开更多 HR 人工处置"/);
assert.match(candidateDetail, /focusDispositionReturnTarget/);
assert.match(candidateDetail, /type: 'divider',[\s\S]*?className: 'candidate-disposition-more-divider',[\s\S]*?style: \{ margin: '5px 7px', background: 'var\(--hb-border\)' \}/);
assert.match(candidateDetail, /label: <span className="candidate-disposition-more-label">\{item\.label\}<\/span>/);
assert.match(candidateDetail, /className: `candidate-disposition-more-item\$\{/);
assert.match(candidateDetail, /className: 'candidate-disposition-more-menu'/);
assert.match(candidateDetail, /minWidth: 210,[\s\S]*?border: '1px solid var\(--hb-border\)'[\s\S]*?boxShadow: 'var\(--hb-shadow-popover\)'/);
assert.match(candidateDetail, /<Dropdown[\s\S]*?autoFocus[\s\S]*?disabled=\{blocked\}[\s\S]*?aria-expanded=\{moreActionsOpen\}/,
  'candidate disposition menu must preserve auto focus, disabled state and expanded semantics');
assert.match(styles, /\.candidate-disposition-more-item \{[\s\S]*?min-height: 36px;[\s\S]*?font-size: var\(--hb-type-caption\);/);
assert.doesNotMatch(styles, /\.candidate-disposition-more-dropdown\s+\.ant-dropdown-menu/,
  'candidate disposition Dropdown must not target AntD internal menu DOM');
assert.equal((interviewReview.match(/<Tabs\b/g) || []).length, 1,
  'interview workflow must retain exactly one actual AntD Tabs instance');
assert.doesNotMatch(styles, /\.interview-workflow-tabs\s+\.ant-tabs-/,
  'interview workflow spacing and selected state must use public AntD 5 Tabs tokens');
assert.doesNotMatch(candidateDetail, />V1 报告<|待 V1 报告/);
assert.match(candidateList, /className="candidate-card-head candidate-row-head"/);
assert.match(candidateList, /import '\.\.\/candidate-v2\.css';/);
assert.match(candidateList, /candidate-card candidate-v2-row/);
assert.doesNotMatch(candidateList, /className="candidate-desc candidate-row-summary"/);
assert.doesNotMatch(candidateList, /className="candidate-source-line candidate-row-meta"/);
assert.match(candidateList, /const truthMeta = `姓名：\$\{fullName\}；\$\{stableReference\.full\}；队列：\$\{work\.queueLabel\}；流程阶段：\$\{work\.workflowLabel\}；来源：\$\{sourceLabel\}；资料更新：\$\{updatedLabel\}`/);
assert.match(candidateList, /function candidateStableReference\(candidate\)[\s\S]*?候选人编号[\s\S]*?内部候选人 ID[\s\S]*?学校[\s\S]*?身份信息待补全/);
assert.match(candidateList, /className="candidate-row-disambiguator" title=\{stableReference\.full\}/);
assert.match(candidateList, /overflowQueueCategoryCount = countPopulatedQueueCategories\(overflowQueueOptions\)/);
assert.match(candidateList, /`\$\{overflowQueueCategoryCount\} 类`/);
assert.match(candidateList, /DEFAULT_RANKING_EXPLANATION = '默认排序仅按确定性 SABC 档位、入库时间和内部 ID/);
assert.match(candidateList, /aria-label=\{`\$\{coverageExplanation\} \$\{DEFAULT_RANKING_EXPLANATION\}`\}/);
assert.match(candidateList, /按 SABC、入库时间排序/);
assert.match(candidateList, /PRIMARY_QUEUE_KEYS = new Set\(\['mine', 'interview', 'review'\]\)/);
assert.match(candidateList, /function candidateDispositionLabel\(candidate\)[\s\S]*?new: '新入库'/);
assert.match(candidateList, /className=\{`candidate-queue-tab candidate-queue-more/);
assert.match(candidateList, /aria-expanded=\{showAdvancedFilters\}[\s\S]*?aria-controls="candidate-advanced-filters"/);
assert.match(candidateList, /const showAdvancedFilters = filtersOpen;/);
assert.doesNotMatch(candidateList, /className="candidate-avatar"/);
assert.doesNotMatch(candidateList, /className="candidate-tags-muted"/);
assert.match(candidateV2, /\.candidate-card\.candidate-v2-row \{[\s\S]*?min-height: 86px;[\s\S]*?padding: 12px 11px 11px 13px;/);
assert.match(candidateV2, /\.candidate-card\.candidate-v2-row \{[\s\S]*?transition: background-color 150ms ease;/);
assert.match(candidateV2, /\.candidate-card\.candidate-v2-row:focus,[\s\S]*?\.candidate-card\.candidate-v2-row:focus-visible \{[\s\S]*?box-shadow: inset 0 0 0 2px var\(--candidate-brand\)/);
assert.match(candidateV2, /\.assessment-ranking-banner,[\s\S]*?\.so-banner \{[\s\S]*?background: var\(--hb-neutral-soft\);[\s\S]*?color: var\(--hb-muted\);/);
assert.doesNotMatch(candidateV2, /inset 3px 0 0|border-left: 2px solid #8db7b3|border-left: 2px solid #c89238/);
assert.match(candidateV2, /\.candidate-row-identity \{[\s\S]*?flex-wrap: nowrap;/);
assert.match(candidateV2, /\.candidate-row-next \{[\s\S]*?grid-template-columns: 46px minmax\(0, 1fr\);/);
assert.match(candidateV2, /\.candidate-v2-body \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
assert.match(candidateV2, /\.candidate-v2-workspace \{[\s\S]*?container-name: candidate-workspace;[\s\S]*?container-type: inline-size;/);
assert.match(candidateV2, /\.candidate-v2-detail \.candidate-workspace-card-body \{\s*display: grid;\s*gap: 12px;\s*padding: 16px 20px 22px;\s*\}/,
  'candidate workspace Card body geometry must live on the public Card body classNames slot');
for (const legacyCardInternal of [
  /\.candidate-overview-card\s*>\s*\.ant-card-body/,
  /\.candidate-workspace-card\s+\.ant-card-body/,
  /\.candidate-workspace-card\s*>\s*\.ant-card-body/,
  /\.candidate-taskbar\s+\.ant-card-head/,
  /\.candidate-taskbar\s+\.ant-card-body/,
]) {
  assert.doesNotMatch(styles, legacyCardInternal,
    'candidate Card geometry must use public Card classNames slots instead of AntD internal nodes');
}
assert.match(styles, /\.candidate-overview-card\.ant-card \{\s*overflow: hidden;/,
  'overview clipping remains an explicitly deferred root behavior');
assert.doesNotMatch(styles, /\.candidate-command-grid/,
  'removed permanent command grid must not leave active global selectors');
assert.match(styles, /\.detail-card \.ant-card-body \{\s*padding: 12px 14px;/,
  'the broader detail-card fallback remains outside this scoped migration');
assert.match(candidateV2, /@container candidate-workspace \(max-width: 720px\) \{[\s\S]*?\.interview-status-panel,[\s\S]*?\.flow-grid \{\s*grid-template-columns: minmax\(0, 1fr\);/);
assert.match(candidateV2, /\.candidate-taskbar \{[\s\S]*?border: 1px solid var\(--candidate-border\);[\s\S]*?border-radius: 7px;/);
assert.match(candidateV2, /\.candidate-domain-tab-option:hover:not\(:has\(> input:disabled\)\) \{[\s\S]*?box-shadow: none;/);
assert.match(candidateV2, /\.candidate-domain-tab-option:has\(> input:checked\),[\s\S]*?box-shadow: inset 0 -2px 0 var\(--candidate-brand\);/);
assert.doesNotMatch(candidateV2, /\.ant-|\[class[^\]]*ant-/,
  'candidate V2 must use AntD public props, component tokens and owned classes instead of internal selectors');
assert.match(candidateV2, /\.candidate-disposition-visible-actions \{[\s\S]*?grid-template-columns: minmax\(92px, 1\.15fr\) minmax\(62px, 0\.78fr\) minmax\(88px, 0\.9fr\);/);
assert.match(candidateV2, /\.candidate-disposition-visible-actions\.has-contextual-primary \{[\s\S]*?grid-template-columns: minmax\(132px, 1\.3fr\) minmax\(92px, 0\.9fr\) minmax\(62px, 0\.68fr\) minmax\(88px, 0\.82fr\);/);
assert.match(candidateV2, /\.candidate-disposition-more-trigger \{[\s\S]*?border-color: transparent;[\s\S]*?background: var\(--hb-neutral-soft\);/);
assert.match(candidateDetail, /classNames=\{\{[\s\S]*?candidate-command-card-header[\s\S]*?candidate-command-card-body/);
assert.match(candidateDetail, /classNames=\{\{\s*header: 'candidate-command-card-header',\s*body: 'candidate-command-card-body',\s*title: 'candidate-command-card-title',\s*extra: 'candidate-command-card-extra',\s*\}\}/,
  'command Cards must expose all rendered Card semantic slots');
assert.match(topbar, /aria-label="选择岗位"[\s\S]*?variant="borderless"/);
assert.match(interviewReview, /interview-evidence-collapse-header[\s\S]*?interview-evidence-collapse-body/);
assert.match(interviewSchedule, /label: '面试资料与录音工具'[\s\S]*?<LocalInterviewPanel[\s\S]*?fixtureMode=\{fixtureMode\}/,
  'the canonical interview workspace must keep local recording as one task-oriented disclosure');
assert.match(candidateV2, /\.candidate-v2-facts-list \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(120px, 1fr\)\);/);
assert.doesNotMatch(candidateV2, /grid-template-columns: repeat\(8,/);
assert.doesNotMatch(candidateV2, /candidate-v2-decision-rail|candidate-command-grid/);
assert.doesNotMatch(candidateV2, /order:\s*-1/);
assert.ok(
  candidateDetail.indexOf('className="candidate-v2-workspace"') < candidateDetail.indexOf('<ManualDispositionPanel'),
  'the HR taskbar must live inside the single evidence workspace in DOM order',
);
assert.ok(
  candidateDetail.indexOf('<ManualDispositionPanel') < candidateDetail.indexOf('className="candidate-domain-navigation"')
    && candidateDetail.indexOf('className="candidate-domain-navigation"') < candidateDetail.indexOf('className="candidate-domain-panel"'),
  'the compact HR taskbar must precede domain navigation and selected content',
);
assert.match(candidateDetail, /<span>当前任务<\/span>[\s\S]*?<h2>\{decisionSummary\.task\}<\/h2>/);
assert.match(candidateDetail, /const TASK_PRIMARY_ACTIONS = Object\.freeze\(\{[\s\S]*?contact_required:[\s\S]*?记录沟通事实[\s\S]*?schedule_confirmation_required:[\s\S]*?确认面试时间[\s\S]*?report_confirmation_required:[\s\S]*?确认面试报告[\s\S]*?final_review_required:[\s\S]*?打开结构化终评/);
assert.match(candidateDetail, /className="candidate-disposition-action candidate-task-primary-action"[\s\S]*?\{contextualTaskAction\.label\}/);
assert.match(candidateDetail, /const finalReviewVisible = activeDomain === 'final-review'[\s\S]*?initialDomain === 'final-review'[\s\S]*?final_review_required/);
assert.match(candidateDetail, /candidate-final-review-domain-option[\s\S]*?<strong>终评<\/strong>[\s\S]*?value: 'final-review'/);
assert.match(candidateDetail, /className="candidate-missing-facts"/);
assert.match(candidateDetail, /不生成推荐或分数/);
assert.match(candidateV2, /@container candidate-detail \(max-width: 500px\) \{[\s\S]*?\.candidate-v2-facts-list \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
assert.match(candidateV2, /@container candidate-detail \(max-width: 500px\) \{[\s\S]*?\.candidate-disposition-visible-actions \{\s*grid-template-columns: minmax\(0, 1fr\);/);
assert.doesNotMatch(candidateV2, /font-size:\s*clamp\(/);
assert.ok(Math.min(...pixelFontSizes(candidateV2)) >= 12, 'candidate V2 text must stay on the 12px-and-up type scale');
assert.match(candidateV2, /\.candidate-identity-anchor \{[\s\S]*?min-height: 46px;/);
assert.match(candidateV2, /\.candidate-identity-anchor \.candidate-focus-identity \{[\s\S]*?grid-template-columns: minmax\(150px, 1\.2fr\) minmax\(120px, 0\.9fr\) max-content;/);
assert.match(candidateV2, /\.candidate-identity-anchor \.candidate-focus-job,[\s\S]*?\.candidate-focus-reference \{[\s\S]*?font-size: 12px;[\s\S]*?text-overflow: ellipsis;/);
assert.doesNotMatch(styles, /font-size:\s*10\.5px|#72808e/i,
  'ordinary product copy must not regress to the low-contrast 10.5px tier');
for (const selectorPattern of [
  /\.interview-todo-copy small \{[\s\S]*?font-size: var\(--hb-type-compact\);/,
  /\.interview-todo-status small \{[\s\S]*?font-size: var\(--hb-type-compact\);/,
  /\.mobile-module-field \{[\s\S]*?font-size: var\(--hb-type-compact\);/,
]) {
  assert.match(styles, selectorPattern,
    'runtime-visible compact ordinary text must use the shared 12px floor');
}
assert.match(interviewReview, /function plainTextScriptPayload\(script, text\)[\s\S]*?delete next\.sections;[\s\S]*?delete next\.closing_checklist;[\s\S]*?next\.editor_format = 'plain_text';[\s\S]*?next\.script_text = text;/);
assert.match(interviewReview, /className="interview-script-text-preview"[\s\S]*?<pre>\{previewText \|\| '当前脚本内容为空。'\}<\/pre>/);
assert.match(interviewReview, /const nextScript = plainTextScriptPayload\(script, scriptDraft\);[\s\S]*?api\.saveInterviewScript\(jobId, nextScript, scriptDraft\)/);
assert.match(interviewReview, /const hasUnsavedChanges = scriptDraftDirty \|\| reportDraftDirty \|\| sessionFactsDirty \|\| confirmationsDirty;[\s\S]*?dirtyChangeRef\.current\(hasUnsavedChanges\)/);
assert.match(interviewReview, /function requestRefresh\(\)[\s\S]*?放弃未保存的面试修改并刷新？[\s\S]*?放弃修改并刷新/);
assert.match(interviewReview, /const MIN_RECORDING_DURATION_SECONDS = 5;[\s\S]*?const MAX_RECORDING_DURATION_SECONDS = 14_400;[\s\S]*?function recordingDurationError/);
assert.match(interviewReview, /name="interview-review-duration-seconds"[\s\S]*?min=\{MIN_RECORDING_DURATION_SECONDS\}[\s\S]*?max=\{MAX_RECORDING_DURATION_SECONDS\}[\s\S]*?status=\{durationValidationError \? 'error' : undefined\}/);
assert.match(interviewReview, /window\.matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches[\s\S]*?target\.scrollIntoView\(\{ behavior: reduceMotion \? 'auto' : 'smooth'[\s\S]*?target\.focus\(\{ preventScroll: true \}\)/);
assert.match(interviewReview, /<span className="interview-tab-label">\s*当前面试轮次/);
assert.match(styles, /\.candidate-interview-controls \{\s*grid-template-columns: minmax\(112px, 0\.45fr\) minmax\(210px, 1fr\) max-content;[\s\S]*?align-items: end;/);
assert.match(styles, /\.candidate-interview-actions \{\s*grid-column: auto;[\s\S]*?justify-content: flex-end;[\s\S]*?margin-top: 21px;/);
assert.match(styles, /@container candidate-detail \(max-width: 560px\) \{[\s\S]*?\.candidate-interview-actions \{\s*grid-column: 1 \/ -1;[\s\S]*?margin-top: 0;/);
assert.doesNotMatch(candidateV2,
  /@container candidate-workspace \(max-width: 720px\)\s*\{[\s\S]*?\.candidate-v2-detail \.candidate-interview-controls,/,
  'generic candidate workspace reflow must not override the dedicated recording-control breakpoint');
assert.match(styles, /\.candidate-interview-field-hint,[\s\S]*?\.candidate-interview-field-error \{[\s\S]*?font-size: 12px;/);
assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.interview-review-panel,[\s\S]*?scroll-behavior: auto;/);
assert.match(styles, /\.interview-todo-item \{[^}]*border: 1px solid var\(--hb-border\);/);
assert.match(styles, /\.interview-todo-icon \{[^}]*background: var\(--hb-neutral-soft\);/);
assert.match(styles, /\.interview-todo-item\.blocked \.interview-todo-icon \{\s*background: var\(--hb-error-soft\);/);
assert.match(styles, /\.interview-todo-item:focus-visible \{[\s\S]*?border-color: var\(--hb-primary\);[\s\S]*?outline: 2px solid var\(--hb-primary\);[\s\S]*?box-shadow: var\(--hb-focus-ring\);/,
  'todo focus treatment must be declared after tone borders and remain token-driven');
assert.doesNotMatch(styles, /\.interview-todo-item \{[^}]*border: 1px solid #dfe5e8;/,
  'active interview todo borders must not bypass theme.js');
assert.match(styles, /\.ant-btn:disabled:not\(\.ant-btn-loading\),[\s\S]*?border-color: var\(--hb-border\);[\s\S]*?background: var\(--hb-neutral-soft\);[\s\S]*?color: var\(--hb-faint\);/);
assert.match(candidateList, /role="option"[\s\S]*?tabIndex=\{tabIndex\}[\s\S]*?aria-selected=\{active\}/);
assert.match(candidateList, /\['ArrowDown', 'ArrowUp', 'Home', 'End'\]/);
assert.match(candidateList, /function CandidateListSkeleton\(\)[\s\S]*?<Skeleton active/);
assert.match(dashboard, /function DashboardLoadingSkeleton\(\{ label \}\)[\s\S]*?<Skeleton active/);
assert.match(talentPool, /className="talent-pool-loading-grid"[\s\S]*?<Skeleton active/);
assert.match(assessmentArchive, /证据覆盖、置信度与缺失材料[\s\S]*?AI 匹配分（次级参考）[\s\S]*?HR 决策参考（证据核验后阅读）/);
assert.doesNotMatch(assessmentArchive, /fontSize:\s*34|#087f5b|strokeColor="#087f5b"/);
assert.match(decisionUi, /@container candidate-workspace \(max-width: 620px\) \{[\s\S]*?\.assessment-evidence-grid,[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/);
assert.match(ocrReview, /centered/);
assert.match(ocrReview, /maxHeight: 'calc\(100vh - 220px\)'/);
assert.match(ocrReview, /footer=\{selected \? \[/);
assert.match(ocrReview, /key="confirm"[\s\S]*?人工确认并入库/);
assert.match(settings, /function normalizeSettingsSection\(sectionId\)[\s\S]*?'settings-overview'/);
assert.match(settings, /const \[activeSection, setActiveSection\] = useState\(\(\) => normalizeSettingsSection/);
assert.match(settings, /\['settings-overview', '本机状态'\]/);
assert.ok(contrastRatio('#5d6976', '#ffffff') >= 4.5, 'weak text must meet 4.5:1 on white');
assert.ok(contrastRatio('#5d6976', '#f5f6f8') >= 4.5, 'weak text must meet 4.5:1 on the app background');
assert.ok(contrastRatio('#5d6976', '#eef6ff') >= 4.5, 'weak text must meet 4.5:1 on the primary soft surface');
assert.ok(contrastRatio('#5d6976', '#ffffff') >= 4.5, 'placeholder and subtle desktop text must meet 4.5:1 on white');
for (const background of ['#f4f5f7', '#eef6ff', '#fffbf2', '#fff1f1', '#edf7f1']) {
  assert.ok(contrastRatio('#4b5866', background) >= 4.5,
    `compact interview todo copy must meet 4.5:1 on ${background}`);
}
assert.ok(contrastRatio('#5d6976', '#eef0f3') >= 4.5,
  'compact mobile module copy must meet 4.5:1 on the responsive shell');
assert.ok(contrastRatio('#0067c5', '#ffffff') >= 4.5, 'primary button must meet 4.5:1 with white text');
const controlBorder = theme.match(/controlBorder: '(#[0-9a-f]{6})'/i)?.[1];
assert.ok(controlBorder, 'control border token must be a static hex color');
assert.ok(contrastRatio(controlBorder, '#ffffff') >= 3, 'control borders must meet 3:1 on white');
assert.ok(contrastRatio(controlBorder, '#f5f6f8') >= 3, 'control borders must meet 3:1 on the app background');
const gradeColors = Object.fromEntries(
  [...theme.matchAll(/([SABCD]): Object\.freeze\(\{ bg: '(#[0-9a-f]{6})', fg: '(#[0-9a-f]{6})' \}\)/gi)]
    .map((match) => [match[1], { bg: match[2], fg: match[3] }]),
);
assert.deepEqual(Object.keys(gradeColors), ['S', 'A', 'B', 'C', 'D']);
for (const [grade, colors] of Object.entries(gradeColors)) {
  assert.ok(contrastRatio(colors.fg, colors.bg) >= 4.5, `${grade} grade text must meet 4.5:1`);
}
const semanticStateColors = new Set(['#0067c5', '#2f7458', '#9b6319', '#b13f43']);
for (const grade of ['A', 'B', 'C', 'D']) {
  assert.ok(!semanticStateColors.has(gradeColors[grade].fg), `${grade} must not reuse a semantic state color`);
}
assert.ok(contrastRatio('#4b5866', '#eceff2') >= 4.5, 'ranking explanation text must meet 4.5:1');

console.log(JSON.stringify({
  ok: true,
  contract: 'UI-VISUAL-POLISH-001',
  unified_tokens: true,
  v2_foundation_last: true,
  typography_tiers: [13, 15, 17, 21, 28],
  global_chinese_negative_tracking: false,
  control_size_tiers: [30, 34, 38],
  decorative_navigation_effects: false,
  reduced_motion_fallback: true,
  softened_selection_state: true,
  focus_disabled_contract: true,
  candidate_keyboard_focus_ring: true,
  fixture_sabc_uses_grade_tokens: true,
  readable_weak_text: true,
  contrast_ratios: {
    weak_text_on_white: Number(contrastRatio('#5d6976', '#ffffff').toFixed(2)),
    weak_text_on_app_background: Number(contrastRatio('#5d6976', '#f5f6f8').toFixed(2)),
    weak_text_on_primary_soft: Number(contrastRatio('#5d6976', '#eef6ff').toFixed(2)),
    white_on_primary: Number(contrastRatio('#0067c5', '#ffffff').toFixed(2)),
    control_border_on_white: Number(contrastRatio(controlBorder, '#ffffff').toFixed(2)),
    control_border_on_app_background: Number(contrastRatio(controlBorder, '#f5f6f8').toFixed(2)),
    ranking_explanation: Number(contrastRatio('#4b5866', '#eceff2').toFixed(2)),
    sabc_minimum: Number(Math.min(
      ...Object.values(gradeColors).map(({ fg, bg }) => contrastRatio(fg, bg)),
    ).toFixed(2)),
  },
  readonly_job_table_density: true,
  job_ledger_priority_columns: jobLedgerPriorityColumns,
  settings_entry_orientation_preserved: true,
  localized_talent_loading_state: true,
  ordered_todo_filters: true,
  compact_todo_preview_limit: 3,
  semantic_todo_list: true,
  contextual_todo_actions: true,
  narrow_todo_rows_stack: true,
  topbar_global_recovery_non_scroll: true,
  workbench_min_font_px: Math.min(...pixelFontSizes(workbenchV2)),
  candidate_min_font_px: Math.min(...pixelFontSizes(candidateV2)),
  candidate_queue_width_policy: {
    selected: 'clamp(400px, 46%, 620px)',
    unselected: 'clamp(520px, 68%, 820px)',
  },
  v2_workbench_decision_first: true,
  v2_candidate_workspace_split: true,
  antd_table_vendor_split: true,
}));
