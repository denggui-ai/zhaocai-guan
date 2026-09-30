'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(PROJECT_ROOT, 'frontend/src/components/DeepProfileModal.jsx'),
  'utf8',
);

function functionSource(name, nextName) {
  const start = source.indexOf(`  async function ${name}`);
  const end = nextName ? source.indexOf(`  async function ${nextName}`, start + 1) : source.length;
  assert.ok(start >= 0, `${name} must exist`);
  assert.ok(end > start, `${name} must have a bounded source range`);
  return source.slice(start, end);
}

function selfClosingTagWithAttribute(componentName, attributeSource) {
  const anchor = source.indexOf(attributeSource);
  assert.ok(anchor >= 0, `${componentName} must include ${attributeSource}`);
  const start = source.lastIndexOf(`<${componentName}`, anchor);
  const end = source.indexOf('/>', anchor);
  assert.ok(start >= 0 && end > anchor, `${componentName} must have a bounded self-closing tag`);
  return source.slice(start, end + 2);
}

// Static component contract: reads have explicit loading/error/ready truth and
// empty states are unreachable until the first successful read for this job.
assert.match(source, /const \[loadState, setLoadState\] = useState\('idle'\)/);
assert.match(source, /const \[loadError, setLoadError\] = useState\(''\)/);
assert.match(source, /const \[hasLoadedSuccessfully, setHasLoadedSuccessfully\] = useState\(false\)/);
assert.match(source, /setLoadState\('loading'\)/);
assert.match(source, /setLoadState\('error'\)/);
assert.match(source, /setLoadState\('ready'\)/);
assert.match(source, /const displayReady = hasLoadedSuccessfully && loadedContextRef\.current === contextKey/);
assert.match(source, /\{displayReady && <>[\s\S]*?访谈材料（\{interviews\.length\} 条）/);
assert.match(source, /\{displayReady && <>[\s\S]*?还没有访谈材料/);
assert.match(source, /\{displayReady && <>[\s\S]*?还没生成过画像/);
assert.match(source, /访谈与深度画像读取失败/);
assert.match(source, /当前状态未知，未将它显示为空数据/);
assert.match(source, /action=\{<Button loading=\{loadState === 'loading'\} onClick=\{retryRead\}>重试读取<\/Button>\}/);

// Unknown, refreshing, stale and committed-refresh states all fail closed.
assert.match(source, /const writeLocked = readOnly \|\| READONLY_UI \|\| !displayReady \|\| loadState !== 'ready' \|\| !!committedForContext/);
assert.match(source, /<Segmented[\s\S]*?disabled=\{writeLocked\}/);
assert.match(source, /disabled=\{writeLocked \|\| !larkEnabled\}[\s\S]*?从飞书妙记导入转写/);
const interviewMaterialTextArea = selfClosingTagWithAttribute(
  'TextArea',
  'aria-label={`${MATERIAL_SOURCES[sourceType].label}内容`}',
);
assert.match(interviewMaterialTextArea, /aria-label=\{`\$\{MATERIAL_SOURCES\[sourceType\]\.label\}内容`\}/);
assert.match(interviewMaterialTextArea, /name="deep-profile-interview-material"/);
assert.match(interviewMaterialTextArea, /autoComplete="off"/);
assert.match(interviewMaterialTextArea, /rows=\{6\}/);
assert.match(interviewMaterialTextArea, /placeholder=\{MATERIAL_SOURCES\[sourceType\]\.placeholder\}/);
assert.match(interviewMaterialTextArea, /value=\{ivText\}/);
assert.match(interviewMaterialTextArea, /disabled=\{writeLocked\}/);
assert.match(interviewMaterialTextArea, /onChange=\{\(e\) => setIvText\(e\.target\.value\)\}/);
assert.match(source, /<Button disabled=\{writeLocked\} loading=\{savingIv\}[\s\S]*?保存\{MATERIAL_SOURCES\[sourceType\]\.label\}/);
assert.match(source, /const generationLocked = writeLocked \|\| generationReadiness\?\.ready !== true[\s\S]*?\|\| generationProgressLocked/);
assert.match(source, /<Button[\s\S]*?type="primary"[\s\S]*?disabled=\{generationLocked\}[\s\S]*?loading=\{generating \|\| aiCapabilityChecking\}/);
assert.match(source, /disabled=\{writeLocked \|\| !!busyAction\}[\s\S]*?标记负责人已确认/);
assert.match(source, /disabled=\{writeLocked \|\| !!busyAction\}[\s\S]*?保存补答/);

// A committed mutation and its read-back are separate phases. Failed read-back
// must keep stale data, lock writes and expose a GET-only retry.
assert.match(source, /async function refreshAfterCommittedAction/);
assert.match(source, /kind: 'committed'/);
assert.match(source, /当前保留上次成功数据，请勿重复提交/);
assert.match(source, /“重试读取”只会读取最新状态，不会重放原操作/);
const retryRead = functionSource('retryRead', 'handleSaveInterview');
assert.match(retryRead, /api\.deepProfileProgress/);
assert.match(retryRead, /await reload\(context\)/);
assert.doesNotMatch(retryRead, /postInterviewAction|generateDeepProfile|confirmDeepProfile|saveInterview/);

const saveInterview = functionSource('handleSaveInterview', 'handleImportLark');
assert.match(saveInterview, /committed = true/);
assert.match(saveInterview, /refreshAfterCommittedAction/);
assert.match(saveInterview, /&& !committed\) message\.error/);
const importLark = functionSource('handleImportLark', 'handleGenerate');
assert.match(importLark, /committed = true/);
assert.match(importLark, /refreshAfterCommittedAction/);
assert.match(importLark, /&& !committed\)/);
const generate = functionSource('handleGenerate');
assert.match(generate, /if \(p\.status === 'done'\) \{[\s\S]*?generationCommitted = true/);
assert.match(generate, /refreshAfterCommittedAction\(context, '深度画像已生成'/);
assert.match(generate, /if \(generationCommitted\)[\s\S]*?kind: 'committed'/);
assert.match(generate, /generationStarted && !terminalFailure/);

// Synthetic state projection for the user-visible invariants.
function project({ ready, loadState, committedRefresh }) {
  return {
    showEmptyTruth: ready,
    showPersistentError: loadState === 'error',
    writesLocked: !ready || loadState !== 'ready' || committedRefresh,
    retryOperation: committedRefresh ? 'read-only-refresh' : 'read',
  };
}

assert.deepStrictEqual(project({ ready: false, loadState: 'loading', committedRefresh: false }), {
  showEmptyTruth: false,
  showPersistentError: false,
  writesLocked: true,
  retryOperation: 'read',
});
assert.deepStrictEqual(project({ ready: false, loadState: 'error', committedRefresh: false }), {
  showEmptyTruth: false,
  showPersistentError: true,
  writesLocked: true,
  retryOperation: 'read',
});
assert.deepStrictEqual(project({ ready: true, loadState: 'error', committedRefresh: true }), {
  showEmptyTruth: true,
  showPersistentError: true,
  writesLocked: true,
  retryOperation: 'read-only-refresh',
});
assert.deepStrictEqual(project({ ready: true, loadState: 'ready', committedRefresh: false }), {
  showEmptyTruth: true,
  showPersistentError: false,
  writesLocked: false,
  retryOperation: 'read',
});

console.log('check-deep-profile-ui-truth-001 ok');
