'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = PROJECT_ROOT;
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const main = read("src/candidate-main.js");
const preload = read("src/preload.js");
const api = read('frontend/src/api.js');
const app = read('frontend/src/App.jsx');
const review = read('frontend/src/components/InterviewReviewPanel.jsx');
const canonical = read('frontend/src/components/InterviewScheduleCanonical.jsx');
const fixture = read('frontend/src/components/InterviewSchedulePanel.jsx');
const localInterview = read('frontend/src/components/LocalInterviewPanel.jsx');
const liveWaveform = read('frontend/src/components/LiveRecordingWaveform.jsx');
const styles = read('frontend/src/styles.css');

function functionSlice(source, signature, nextSignature = '\n  async function ') {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing ${signature}`);
  const end = source.indexOf(nextSignature, start + signature.length);
  return source.slice(start, end === -1 ? source.length : end);
}

const selectorStart = main.indexOf("ipcMain.handle('local-interview:select-summary-file'");
assert.notEqual(selectorStart, -1, 'summary selector IPC handler must exist');
const selectorEnd = main.indexOf('\nipcMain.handle(', selectorStart + 1);
const selectorHandler = main.slice(selectorStart, selectorEnd === -1 ? main.length : selectorEnd);

assert.match(selectorHandler, /assertTrustedRenderer\(event\)/, 'summary selector must reject untrusted renderers');
assert.match(selectorHandler, /if \(READONLY_UI\) return \{ ok: false, error:/, 'operational readonly must fail before opening a picker');
assert.ok(
  selectorHandler.indexOf('if (READONLY_UI)') < selectorHandler.indexOf('interviewMaterialRoot'),
  'readonly return must occur before the handler touches the material root',
);
assert.match(selectorHandler, /getInterviewMaterialRoot\(interviewMaterialRoot\)/,
  'the picker must use the output root resolved by the running service');
assert.doesNotMatch(selectorHandler, /getInterviewMaterialRoot\(\)|DEFAULT_INTERVIEW_MATERIAL_ROOT|__dirname[\s\S]*data[\s\S]*interviews/,
  'the handler must not fall back to the source-tree default root');
assert.match(main, /HRBOSS_INTERVIEW_OUTPUT_DIR: process\.env\.HRBOSS_INTERVIEW_OUTPUT_DIR \|\| path\.join\(runtimeDataDir, 'interviews'\)/);
assert.match(main, /interviewMaterialRoot = path\.resolve\(sharedEnv\.HRBOSS_INTERVIEW_OUTPUT_DIR\)/,
  'main and action services must share the startServer-resolved interview output root');
assert.match(selectorHandler, /filters: \[\{ name: '面试录音摘要', extensions: \['json'\] \}\]/,
  'native picker must restrict its visible file type to JSON');
assert.match(selectorHandler, /validateInterviewMaterialFile\(result\.filePaths\[0\], 'summary', \{ root: materialRoot \}\)/,
  'selection must pass the existing summary basename, containment, symlink and size validator');

assert.match(preload, /selectSummaryFile: \(\) => ipcRenderer\.invoke\('local-interview:select-summary-file'\)/,
  'preload must expose one narrow summary selector method');
assert.match(api, /selectInterviewRecordingSummary: async \(\) => \{[\s\S]*if \(READONLY_UI\)[\s\S]*window\.localInterview\.selectSummaryFile\(\)[\s\S]*response\.ok !== true/,
  'renderer API helper must preserve readonly and bridge failures');

const importHandler = functionSlice(review, 'async function importLegacySummaryFromPicker()');
const selectIndex = importHandler.indexOf('api.selectInterviewRecordingSummary()');
const cancelIndex = importHandler.indexOf('if (selection?.canceled) return false;');
const importIndex = importHandler.indexOf('api.importInterviewRecordingSummary(selection.path)');
assert.ok(selectIndex >= 0 && cancelIndex > selectIndex && importIndex > cancelIndex,
  'picker cancellation must return before the only import call');
assert.equal((importHandler.match(/api\.importInterviewRecordingSummary/g) || []).length, 1,
  'one picker result may trigger at most one import');
assert.match(importHandler, /setSummaryImportError\(importError\?\.message \|\| '旧录音摘要导入失败'\)/,
  'picker/import errors must remain inline');
assert.match(importHandler, /finally \{[\s\S]*summaryImportFocusPendingRef\.current = true;[\s\S]*setBusyKey\(''\)/,
  'cancel, success and failure must request focus restoration after clearing the busy state');
assert.match(review, /useEffect\(\(\) => \{[\s\S]*if \(busyKey \|\| !summaryImportFocusPendingRef\.current\) return undefined;[\s\S]*window\.requestAnimationFrame[\s\S]*summaryImportTriggerRef\.current[\s\S]*!trigger\.disabled[\s\S]*trigger\.focus\(\{ preventScroll: true \}\)[\s\S]*\}, \[busyKey\]\)/,
  'focus restoration must run only after React commits the picker button back to enabled');
assert.match(review, /ref=\{summaryImportTriggerRef\}[\s\S]*onClick=\{importLegacySummaryFromPicker\}/);
assert.doesNotMatch(review, /const \[summaryPath, setSummaryPath\]|name="interview-review-summary-path"|placeholder="summaryPath/,
  'ordinary HR UI must not expose a summary path text field');

assert.equal((review.match(/<Tabs\b/g) || []).length, 1, 'candidate review must have one first-level navigation control');
assert.match(review, /const primaryTabItems = \['review', 'prepare', 'start', 'evidence'\]/,
  'the selected Session must remain the default primary workspace');
assert.doesNotMatch(review, /WORKFLOW_STEPS|aria-pressed=/,
  'workflow status and the page checklist must not masquerade as extra navigation');
assert.match(review, /<section className="interview-todo-strip"[^>]*role="list"[\s\S]*role="listitem"/,
  'page todo cards must expose list semantics without replacing their button semantics');
assert.match(review, /const actionableItems = actionableInterviewTodoItems\(items\)/,
  'the visible todo strip must contain actions rather than completed or idle status cards');
assert.match(review, /className="interview-todo-complete" role="status" aria-label="面试流程已处理完成"/,
  'an action-free workflow must collapse to one compact completion summary');
assert.match(review, /accordion[\s\S]*activeKey=\{expandedSessionKey \|\| undefined\}/,
  'the current candidate Session must default open while history stays collapsible');
assert.match(review, /生成 AI 草稿（可选）|AI 草稿（可选）/,
  'AI assistance must remain visibly optional');
assert.match(review, /人工结构化复盘（无需 AI）[\s\S]*保存人工结构化草稿/,
  'AI-off HRs must have an ordinary structured report path');
assert.match(review, /高级 JSON 导入 \/ 调试/,
  'raw JSON must remain an advanced path rather than the ordinary workflow');
assert.match(review, /HR 人工笔记（非 ASR）[\s\S]*无录音时的 HR 人工笔记|无录音时的 HR 人工笔记[\s\S]*人工材料，不会标记为 ASR/,
  'human notes must remain explicitly distinct from ASR transcripts');
assert.match(review, /草稿来源已变化，当前不可确认/,
  'stale report sources must have a visible confirmation-blocking state');
assert.match(review, /aria-label="选择已创建的面试轮次"/);
assert.match(review, /创建首轮 Session/);
assert.match(review, /创建下一轮 Session/,
  'recording must select or canonically create a Session');
assert.match(review, /aria-label="待归属材料选择面试轮次"/,
  'pending material assignment must select an existing Session');
assert.doesNotMatch(review, /name="interview-review-round"|name="interview-review-assignment-round"/,
  'free-form interview rounds must not return');
assert.match(review, /planned_duration_seconds[\s\S]*<progress aria-label="录音计划进度" value=\{progressPercent\} max="100" \/>[\s\S]*<progress aria-label="录音进行中，等待手动停止" \/>/,
  'unplanned candidate recording must use indeterminate progress');

assert.match(canonical, /data-interview-workspace="canonical"/);
assert.match(canonical, /accordion[\s\S]*activeKey=\{expandedSessionId \|\| undefined\}/,
  'formal and fixture schedules must share the accessible Session accordion');
assert.match(canonical, /当前面试[\s\S]*历史面试[\s\S]*当前待办：\{sessionCurrentTodo\(session\)\}/,
  'interview headers must group candidate, date/status and the current todo');
assert.match(canonical, /label: '邀请、物流与历史'[\s\S]*LogisticsSnapshot[\s\S]*InterviewInvitationEditor[\s\S]*ScheduleConfirmationHistory/,
  'invitation, logistics and history must stay in secondary disclosure');
assert.match(canonical, /const canonicalPartitionReady = Array\.isArray\(canonicalSessions\) && !canonicalLoadError[\s\S]*const canonicalWritesBlocked = !canonicalPartitionReady/);
assert.match(canonical, /if \(!Array\.isArray\(response\?\.sessions\)\) throw new Error\('正式面试记录返回格式无效'\)/,
  'a malformed successful response must retain cached visibility and keep the authority write lock closed');
const canonicalLoadHandler = functionSlice(canonical, 'async function loadCanonicalSessions(context)');
assert.ok(
  canonicalLoadHandler.indexOf("throw new Error('正式面试记录返回格式无效')")
    < canonicalLoadHandler.indexOf('setCanonicalSessions(response.sessions)'),
  'malformed payload validation must happen before canonical state can be replaced',
);
assert.doesNotMatch(canonicalLoadHandler.slice(canonicalLoadHandler.indexOf('catch (loadCanonicalError)')), /setCanonicalSessions/,
  'authority read failure must preserve the last canonical/workbench cache');
for (const handler of ['createSession', 'schedule', 'cancelSession', 'markInvitationSent', 'recordCandidateConfirmation']) {
  const body = functionSlice(canonical, `async function ${handler}`);
  assert.match(body, /if \(!requireCanonicalWritePartition\(\)\) return;/, `${handler} must keep the authority partition lock`);
}
assert.match(canonical, /面试资料与录音工具[\s\S]*fixtureMode=\{fixtureMode\}/);

assert.match(fixture, /import InterviewScheduleCanonical from '.\/InterviewScheduleCanonical\.jsx'/);
assert.match(fixture, /dataAdapter=\{fixtureAdapter\}[\s\S]*fixtureMode/,
  'fixture must be a thin in-memory adapter over the canonical skeleton');
assert.match(fixture, /navigationTarget=\{navigationTarget\}[\s\S]*onNavigationTargetConsumed=\{onNavigationTargetConsumed\}/,
  'fixture must forward canonical open-session/open-report navigation without inventing another route');
assert.doesNotMatch(fixture, /from '\.\.\/api\.js'|\bapi\.|window\.|localStorage|sessionStorage|fetch\(/,
  'fixture mode must not call production APIs, browser persistence or external services');
assert.match(fixture, /data_class: 'fixture'/);
assert.match(fixture, /listInterviewers: async \(includeInactive\) => \(\{[\s\S]*includeInactive[\s\S]*\? interviewersRef\.current[\s\S]*: interviewersRef\.current\.filter\(\(item\) => Number\(item\.active\) === 1\)/,
  'fixture must preserve the production includeInactive=true contract so disabled interviewers can be re-enabled');
assert.match(canonical, /const scheduleAdapter = dataAdapter \|\| DEFAULT_SCHEDULE_ADAPTER/,
  'formal mode must keep the production adapter while fixture mode injects only its narrow substitute');

const interviewBranchStart = app.indexOf("{job?.is_fixture ? <InterviewSchedulePanel");
assert.notEqual(interviewBranchStart, -1, 'App must retain explicit fixture/formal interview branches');
const interviewBranch = app.slice(interviewBranchStart, app.indexOf('</Suspense>', interviewBranchStart));
for (const component of ['InterviewSchedulePanel', 'InterviewScheduleCanonical']) {
  const componentStart = interviewBranch.indexOf(`<${component}`);
  assert.notEqual(componentStart, -1, `${component} must be mounted by App`);
  const componentEnd = interviewBranch.indexOf('/>', componentStart);
  const props = interviewBranch.slice(componentStart, componentEnd);
  assert.match(props, /onOpenSettings=\{\(\) => handleOpenSettings\('settings-interview-tools', '面试安排'\)\}/,
    `${component} must retain the local-tools settings route`);
  assert.match(props, /navigationTarget=\{workbenchNavigationTarget\}/,
    `${component} must receive the canonical open-session/open-report target`);
  assert.match(props, /onNavigationTargetConsumed=\{handleWorkbenchNavigationConsumed\}/,
    `${component} must consume canonical navigation exactly once`);
}

assert.match(localInterview, /if \(fixtureMode\) \{[\s\S]*Fixture 隔离模拟，不检查真实设备/,
  'fixture local tools must short-circuit dependency polling');
assert.match(localInterview, /if \(!fixtureMode\) return api\.localInterviewMicCheck/);
assert.match(localInterview, /if \(!fixtureMode\) return api\.importLocalInterviewFile/);
assert.match(localInterview, /if \(!fixtureMode\) \{[\s\S]*api\.stopLocalInterviewRecord\([\s\S]*job\.id,[\s\S]*job\.bind_candidate_id,[\s\S]*job\.bind_job_id,[\s\S]*job\.bind_round,/,
  'formal stop must carry immutable task and candidate/job/round scope');
assert.match(localInterview, /if \(!fixtureMode\) return api\.abortLocalInterviewTask\(job\.id, job\.bind_job_id\)/,
  'starting, mic-check and file tasks must use exact task abort');
assert.match(localInterview, /planned_duration_seconds[\s\S]*<progress aria-label="录音计划进度" value=\{progressPercent\} max="100" \/>[\s\S]*<progress aria-label="录音进行中，等待手动停止" \/>/,
  'unplanned fallback recording must use indeterminate progress');

for (const [label, source] of [
  ['candidate interview launcher', review],
  ['fallback local interview panel', localInterview],
]) {
  assert.match(source, /import LiveRecordingWaveform(?:,\s*\{[^}]+\})?\s+from ['"]\.\/LiveRecordingWaveform\.jsx['"]/,
    `${label} must reuse the shared truthful live-audio visualization`);
  assert.match(source, /<LiveRecordingWaveform[\s\S]{0,180}liveAudio=\{job\.live_audio\}[\s\S]{0,180}stopping=\{stopping\}/,
    `${label} must render backend telemetry and the stopping state through the shared component`);
  assert.match(source, /<LiveRecordingWaveform[\s\S]{0,260}discarding=\{discarding\}/,
    `${label} must distinguish consent-withdrawal cleanup from transcription`);
}
assert.match(review, /currentRecordingRunning\s*&&\s*\([\s\S]{0,240}<LiveRecordingWaveform/,
  'candidate waveform must be scoped to the current candidate recording');
assert.match(localInterview, /running\s*&&\s*job\.mode\s*===\s*['"]record['"]\s*&&\s*\([\s\S]{0,240}<LiveRecordingWaveform/,
  'fallback panel must expose the same waveform only for an actual recording task');

assert.match(liveWaveform, /const BAR_COUNT\s*=\s*20/,
  'the waveform must keep a bounded, stable 20-bar layout');
assert.match(liveWaveform, /AUDIO_LEVEL_WARNING_ENTER\s*=\s*0\.9/,
  'high-volume color must begin at the truthful -6 dBFS visual boundary');
assert.match(liveWaveform, /AUDIO_LEVEL_CLIPPING_ENTER\s*=\s*0\.995/,
  'near-clipping color must be reserved for a peak close to 0 dBFS');
assert.match(liveWaveform, /previousState === 'warning'[\s\S]{0,120}AUDIO_LEVEL_WARNING_EXIT/,
  'high-volume color must use hysteresis instead of flickering at one threshold');
assert.match(liveWaveform, /previousState === 'clipping'[\s\S]{0,120}AUDIO_LEVEL_CLIPPING_EXIT/,
  'near-clipping color must use hysteresis instead of flickering at one threshold');
assert.match(liveWaveform, /silentMilliseconds\s*>=\s*3_000/,
  'a single zero sample must not trigger the sustained-silence warning');
assert.match(liveWaveform, /sampleAge[\s\S]{0,120}<=\s*1_800/,
  'old telemetry must expire instead of masquerading as live microphone input');
assert.match(liveWaveform, /data-audio-state=\{audioState\}/);
assert.match(liveWaveform, /data-strength-state=\{displayedStrengthState\}/,
  'strength color must remain orthogonal to the recording lifecycle state');
assert.match(liveWaveform, /data-finalization-mode=\{discarding \? 'discarding'/,
  'waveform must expose discard cleanup separately from transcript generation');
assert.match(liveWaveform, /不会生成本次转写或复盘/,
  'consent withdrawal must not claim that a transcript is being generated');
for (const state of ['active', 'inactive', 'silent', 'waiting', 'stale', 'stopping']) {
  assert.match(liveWaveform, new RegExp(`['"]${state}['"]`), `waveform must expose the ${state} state`);
}
assert.match(liveWaveform, /className="live-recording-bars"[\s\S]{0,120}role="meter"/,
  'real audio strength must retain meter semantics');
assert.match(liveWaveform, /强度 \$\{displayedStrength\}%[\s\S]{0,220}峰值过高[\s\S]{0,220}收音较强[\s\S]{0,220}正常/,
  'normal, high and near-clipping colors must each have a visible text equivalent');
assert.match(liveWaveform, /aria-valuetext=\{audioState === 'active' \? `\$\{strengthText\}。\$\{statusText\}`/,
  'the meter must expose strength meaning without relying on color');
assert.match(liveWaveform, /renderedValues\.map\([\s\S]*aria-hidden="true"/,
  'individual decorative bars must stay out of the accessibility tree');
assert.match(liveWaveform, /if \(reducedMotion\) \{[\s\S]{0,220}setRenderedValues\(targetValuesRef\.current\)/,
  'reduced motion must update directly without requestAnimationFrame interpolation');
assert.match(liveWaveform, /frozenValuesRef[\s\S]*stopping[\s\S]*波形已冻结/,
  'stop-and-transcribe must freeze the last truthful frame');
assert.doesNotMatch(`${review}\n${localInterview}\n${liveWaveform}`,
  /getUserMedia|MediaRecorder|AudioContext|webkitAudioContext/,
  'renderer visualization must not open a second microphone or request another media permission');
assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.live-recording-waveform\s*\{[\s\S]{0,100}transition:\s*none/,
  'CSS motion must also be disabled for users who prefer reduced motion');
assert.match(styles, /linear-gradient\(180deg, #0f8b7b 0%, var\(--hb-primary\) 100%\)/,
  'normal recording bars must use the restrained brand blue-teal gradient');
assert.match(styles, /\.live-recording-bars i\.is-strength-warning[\s\S]{0,120}#b54708/,
  'high-volume samples must use the semantic orange gradient');
assert.match(styles, /\.live-recording-bars i\.is-strength-clipping[\s\S]{0,120}#b42318/,
  'near-clipping samples must use the semantic red gradient');
assert.match(styles, /@media \(forced-colors: active\)[\s\S]*\.live-recording-bars i[\s\S]{0,220}background:\s*CanvasText/,
  'forced-colors users must retain visible bars while text carries the strength meaning');

console.log(JSON.stringify({
  ok: true,
  contract: 'UX-W3-A-INTERVIEW-WORKSPACE',
  canonical_skeleton_shared: true,
  fixture_production_calls: 0,
  summary_picker_cancel_imports: 0,
  summary_picker_focus_restored: true,
  authority_partition_preserved: true,
  ai_is_optional: true,
  unplanned_progress: 'indeterminate',
  live_audio_waveform: {
    shared_entries: 2,
    bar_count: 20,
    stale_after_ms: 1800,
    sustained_silence_after_ms: 3000,
    strength_warning_percent: 90,
    strength_clipping_percent: 99.5,
    strength_hysteresis: true,
    second_microphone_opened: false,
    reduced_motion: true,
  },
}, null, 2));
