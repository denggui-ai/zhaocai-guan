'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (relativePath) => fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');

const settings = read('frontend/src/components/SettingsPanel.jsx');
const assessment = read('frontend/src/components/AssessmentArchivePanel.jsx');
const app = read('frontend/src/App.jsx');
const localPrincipal = read("src/local-principal.js");

const overviewStart = settings.indexOf("activeSection === 'settings-overview'");
const overviewEnd = settings.indexOf("activeSection === 'settings-brand'", overviewStart);
const overview = settings.slice(overviewStart, overviewEnd);
assert.ok(overviewStart >= 0 && overviewEnd > overviewStart, 'settings overview must remain an isolated section');
assert.equal((overview.match(/<StateCard\b/g) || []).length, 2,
  'overview must contain only interview-device and data/AI status cards');
assert.doesNotMatch(overview, /本地工作台|返回本地工作台/,
  'settings overview must not duplicate the workspace state or expose a cross-domain CTA');
assert.equal((settings.match(/className="settings-boundary-note/g) || []).length, 1,
  'the data boundary explanation belongs in the data section, not above every settings section');

assert.match(settings, /const returnDestination = returnNav && returnNav !== '设置' \? returnNav : '工作台'/);
assert.match(settings, /const returnActionLabel = `返回\$\{returnDestination\}`/);
assert.match(settings, /aria-label=\{returnActionLabel\}[\s\S]*?title=\{returnActionLabel\}[\s\S]*?\{returnActionLabel\}/,
  'the single return action must expose its source context consistently in visible and accessible names');
assert.doesNotMatch(settings, /<Title level=\{2\}[^>]*>设置<\/Title>/,
  'Settings must rely on the App-owned module h1 instead of announcing a duplicate page title');
assert.doesNotMatch(settings, />返回候选人<|>回工作台<|onOpenNav\('工作台'\)/,
  'settings must not add source-specific or cross-domain actions');
assert.match(settings, /llmNextStep\.state === 'ready' && hasAiReturnContext[\s\S]*?onReturnToAiOperation\?\.\(\)/,
  'AI readiness must return to the preserved source operation when settings were opened from an AI action');
assert.match(settings, /llmNextStep\.state === 'ready'[\s\S]*?onOpenNav\?\.\('工作台'\)/,
  'AI readiness without source context must offer the lightweight workbench return required by first-use onboarding');
assert.match(settings, /import \{[^}]*\bSelect\b[^}]*\} from 'antd'/,
  'the compact settings category control must import the antd Select it renders');
assert.ok(settings.includes("event.target?.closest?.('.nav-primary .nav-item, .nav-utility [data-nav-target]')"),
  'unsaved settings drafts must continue to guard direct primary navigation');
assert.match(app, /if \(descriptor\.navigation\) \{[\s\S]*?confirmDiscardSettingsChanges\(\)[\s\S]*?handleOpenNav\(descriptor\.navigation\)/,
  'the portaled Guide menu item must use the App-level unsaved-settings guard');
assert.match(settings, /onDirtyChange\?\.\(settingsHasUnsavedChanges === true\)/,
  'Settings must publish combined AI and brand draft state to the portal-aware App guard');
assert.match(settings, /const SETTINGS_INTERNAL_NAV_ITEMS = new Set\(\['设置', '关于\/版本', '本机状态'\]\)/);
assert.ok((settings.match(/SETTINGS_INTERNAL_NAV_ITEMS\.has\(nextNav\)/g) || []).length >= 2,
  'desktop and mobile settings-internal utility targets must bypass the leave-settings draft warning');
assert.match(settings, /if \(destination\.startsWith\('nav:'\)\) onOpenNav\(destination\.slice\(4\)\)/,
  'confirmed desktop or mobile navigation must leave through the shared navigation prop');

const settingsRouteStart = app.indexOf('<SettingsPanel');
const settingsRouteEnd = app.indexOf('/>', settingsRouteStart);
const settingsRoute = app.slice(settingsRouteStart, settingsRouteEnd);
assert.ok(settingsRouteStart >= 0 && settingsRouteEnd > settingsRouteStart, 'App must render SettingsPanel');
assert.match(settingsRoute, /onOpenNav=\{handleOpenUtilityNav\}/,
  'Settings navigation must preserve App utility-to-section mapping after draft confirmation');
assert.match(settingsRoute, /onDirtyChange=\{setSettingsDirty\}/,
  'App must receive the combined Settings dirty state for portaled utility navigation');
const mobileNavigationStart = app.indexOf('className="mobile-module-nav"');
const mobileNavigationEnd = app.indexOf('</nav>', mobileNavigationStart);
const mobileNavigation = app.slice(mobileNavigationStart, mobileNavigationEnd);
assert.match(mobileNavigation, /handleOpenUtilityNav\(nextNav\)/,
  'mobile primary and utility values must use the same App navigation path');
assert.match(app, /'关于\/版本': 'settings-advanced'[\s\S]*?本机状态: 'settings-overview'/,
  'About/version and local-status utility entries must keep their settings section mapping');
assert.match(app, /const returnsToJobEditorFromSettings = activeNav === '设置'[\s\S]*?settingsReturnNav === '职位管理'[\s\S]*?jobManagementView === 'editor'/,
  'returning from Settings must preserve the source job editor instead of falling back to the ledger');
assert.match(app, /if \(nav === '职位管理' && !returnsToJobEditorFromSettings\) setJobManagementView\('ledger'\)/,
  'ordinary job navigation must still open the ledger while the Settings source return keeps its editor');

assert.match(settings, /const NARROW_SETTINGS_QUERY = '\(max-width: 760px\)'/);
assert.match(settings, /window\.matchMedia\(NARROW_SETTINGS_QUERY\)/);
assert.match(settings, /query\.addEventListener\('change', syncNavigationMode\)/);
assert.match(settings, /compactSectionNav \? \([\s\S]*?<Select[\s\S]*?aria-label="设置分类"[\s\S]*?onChange=\{activateSection\}/,
  'narrow settings navigation must use one keyboard-operable category selector');
assert.match(settings, /<details className="settings-advanced-card">/);
assert.doesNotMatch(settings.slice(settings.indexOf("activeSection === 'settings-advanced'")),
  /<details className="settings-advanced-card"\s+open/,
  'developer diagnostics must remain collapsed until the user expands an item');
assert.match(settings, /HistoryOutlined/);
assert.doesNotMatch(settings, /CloudSyncOutlined/);
assert.match(settings, /本机最近任务进度/);
assert.match(settings, /本地任务历史/);

const importModalStart = assessment.indexOf('title="批量导入 PDF 测评报告"');
const importModalEnd = assessment.indexOf('title="PDF 测评 PNG 预览"', importModalStart);
const importModal = assessment.slice(importModalStart, importModalEnd);
assert.ok(importModalStart >= 0 && importModalEnd > importModalStart, 'assessment import modal must exist');
assert.match(assessment, /const importBusyRef = useRef\(false\)/);
assert.match(assessment, /function closeImportModal\(\) \{\s*if \(importBusyRef\.current\) return;\s*setImportOpen\(false\);\s*\}/);
const importPdfStart = assessment.indexOf('async function importPdf(retryFailure = null)');
const importPdfEnd = assessment.indexOf('\n\n  async function performConfirm', importPdfStart);
const importPdf = assessment.slice(importPdfStart, importPdfEnd);
assert.ok(importPdfStart >= 0 && importPdfEnd > importPdfStart,
  'assessment import handler must accept an optional failed item for single-file retry');
assert.match(importPdf, /async function importPdf\(retryFailure = null\) \{\s*if \(importBusyRef\.current\) return;/,
  'initial import and single-file retry must share the same synchronous re-entry guard');
assert.match(importPdf, /const retryingSingleFile = retryFailure && Number\.isInteger\(Number\(retryFailure\.index\)\)/);
assert.match(importPdf, /single_file_retry: retryingSingleFile,\s*retry_item_index: retryingSingleFile \? Number\(retryFailure\.index\) : null,/,
  'the native picker request must explicitly distinguish single-file retry and preserve the failed item index');
assert.match(importPdf, /finally \{\s*importRequestRef\.current = null;\s*importBusyRef\.current = false;\s*endWrite\(\);\s*\}/,
  'all import outcomes must release both the request and write re-entry locks');
assert.match(importModal, /onCancel=\{closeImportModal\}/);
assert.match(importModal, /closable=\{!busy\}[\s\S]*?maskClosable=\{!busy\}[\s\S]*?keyboard=\{!busy\}/,
  'busy assessment import must lock close button, mask and Escape consistently');
assert.match(importModal, /aria-label="批量导入报告类型"[^>]*disabled=\{busy\}/);
assert.match(importModal, /aria-label="批量导入测评日期"[\s\S]*?disabled=\{busy\}/);
assert.match(importModal, /importFailures\.map\(\(item\) => \([\s\S]*?onClick=\{\(\) => importPdf\(item\)\}[\s\S]*?>\s*重新选择这一份\s*<\/Button>/,
  'each failed PDF must expose a scoped retry action that passes only that failed item');
assert.match(importModal, /无需重选整批。[\s\S]*?系统文件选择器中只重新选择这一份 PDF/,
  'the retry UI must explain that the user is not selecting the entire batch again');

assert.match(assessment, /const previewRequestRef = useRef\(0\)/);
assert.match(assessment, /const ownedPreviewUrlRef = useRef\(''\)/);
assert.match(assessment, /function replacePreviewUrl\(nextUrl = ''\)[\s\S]*?URL\.revokeObjectURL\(currentUrl\)[\s\S]*?ownedPreviewUrlRef\.current = nextUrl/);
assert.match(assessment, /expectedContext !== contextRef\.current \|\| requestSequence !== previewRequestRef\.current[\s\S]*?URL\.revokeObjectURL\(nextUrl\)[\s\S]*?return false/,
  'a late PNG response must be revoked before it can update hidden or stale preview state');
assert.ok((assessment.match(/if \(expectedContext === contextRef\.current && requestSequence === previewRequestRef\.current\) setBusy\(false\);/g) || []).length >= 2,
  'preview request finally blocks must not clear the busy state of a newer request or context');
const previewContextResetStart = assessment.indexOf('useEffect(() => {\n    contextRef.current = contextKey;');
const previewContextResetEnd = assessment.indexOf('}, [contextKey]);', previewContextResetStart);
const previewContextReset = assessment.slice(previewContextResetStart, previewContextResetEnd);
assert.ok(previewContextResetStart >= 0 && previewContextResetEnd > previewContextResetStart,
  'candidate context reset effect must remain explicit');
assert.match(previewContextReset, /previewRequestRef\.current \+= 1;\s*setBusy\(false\);/,
  'changing candidate context must invalidate preview work and end its visible busy state');
assert.match(assessment, /function closePreview\(\) \{\s*previewRequestRef\.current \+= 1;\s*setBusy\(false\);\s*replacePreviewUrl\(''\);\s*setPreview\(null\)/,
  'closing the preview must invalidate pending page requests, end busy and release the visible URL');
const previewUnmountStart = assessment.indexOf('useEffect(() => () => {');
const previewUnmountEnd = assessment.indexOf('}, []);', previewUnmountStart);
const previewUnmount = assessment.slice(previewUnmountStart, previewUnmountEnd);
assert.match(previewUnmount, /ownedPreviewUrlRef\.current = '';[\s\S]*?URL\.revokeObjectURL\(currentUrl\);/,
  'the final owned Blob URL must be released on unmount');
assert.doesNotMatch(previewUnmount, /setBusy\(/,
  'unmount cleanup must invalidate and revoke without setting React state');

assert.match(localPrincipal, /const LOCAL_PRINCIPAL = Object\.freeze\(\{\s*actor_id: 'local-primary-operator',\s*role: 'hr_admin',\s*\}\)/,
  'W4-A must preserve the fixed single-operator local principal');
assert.doesNotMatch(settings + assessment, /多租户管理|团队成员|云同步中心|遥测中心/);

console.log(JSON.stringify({
  ok: true,
  contract: 'UX-W4-A-SETTINGS-ASSESSMENT',
  overview_cards: 2,
  narrow_category_selector: true,
  import_busy_escape_locked: true,
  late_preview_response_revoked: true,
  blob_url_ownership_paired: true,
  local_principal_unchanged: true,
}));
