#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function main() {
  const state = await import(pathToFileURL(path.join(__dirname, 'frontend/src/interview-workflow-state.mjs')).href);
  const reviewNavigation = await import(pathToFileURL(path.join(__dirname, 'frontend/src/interview-review-navigation.mjs')).href);
  const reportResponse = await import(pathToFileURL(path.join(__dirname, 'frontend/src/interview-report-response.mjs')).href);
  const confirmationReview = await import(pathToFileURL(path.join(__dirname, 'frontend/src/interview-confirmation-review.mjs')).href);
  const versionConflict = await import(pathToFileURL(path.join(__dirname, 'frontend/src/interview-version-conflict.mjs')).href);
  const base = {
    records: [],
    recordCount: 0,
    reportCount: 0,
    confirmationStats: { total: 0, finished: 0 },
    confirmedCount: 0,
    localJob: { status: 'unknown' },
    candidateId: 'candidate-1',
  };

  for (const status of ['confirmed', 'completed', 'archived', 'cancelled']) {
    const result = state.deriveWorkflowState({ ...base, sessions: [{ status }] });
    assert.equal(result.tone, 'done', `${status} session must not regress to preparation`);
    assert.equal(result.step, 'archive');
  }
  assert.deepEqual(
    { ...state.deriveWorkflowState({ ...base, sessions: [{ status: 'in_progress' }] }) },
    {
      key: 'session-in-progress',
      label: '面试中',
      step: 'start',
      tone: 'processing',
      message: '面试轮次已开始；脚本缺失不会把流程回退到准备阶段。',
    },
  );
  assert.equal(
    state.deriveWorkflowState({ ...base, sessions: [{ status: 'pending_review' }] }).key,
    'review-pending',
  );
  assert.equal(
    state.deriveWorkflowState({ ...base, sessions: [{ status: 'pending_confirmation' }] }).key,
    'confirm-pending',
  );
  assert.equal(
    state.deriveWorkflowState({ ...base, sessions: [{ status: 'scheduled' }] }).key,
    'not-ready',
    'a prestart session without material must keep the preparation action',
  );
  assert.equal(
    state.deriveWorkflowState({ ...base, sessions: [{ status: 'confirmed' }, { status: 'scheduled' }] }).key,
    'not-ready',
    'historical completion must not hide preparation for a new scheduled session',
  );
  assert.equal(
    state.interviewLogisticsNeedsAttention({ status: 'scheduled', invitation_status: 'pending' }),
    true,
    'a scheduled session waiting for invitation must reveal logistics',
  );
  assert.equal(
    state.interviewLogisticsNeedsAttention({
      status: 'scheduled',
      invitation_status: 'sent',
      candidate_confirmation_status: 'pending',
    }),
    true,
    'a scheduled session waiting for candidate confirmation must reveal logistics',
  );
  assert.equal(
    state.interviewLogisticsNeedsAttention({
      status: 'scheduled',
      invitation_status: 'sent',
      candidate_confirmation_status: 'confirmed',
    }),
    false,
    'a completed logistics step must return disclosure control to the user',
  );
  assert.equal(
    state.interviewLogisticsNeedsAttention({ status: 'pending_review' }),
    false,
    'non-scheduling work must not force open secondary logistics history',
  );

  assert.deepEqual(
    state.actionableInterviewTodoItems([
      { key: 'idle', tone: 'idle' },
      { key: 'done', tone: 'done' },
      { key: 'warn', tone: 'warning' },
      { key: 'work', tone: 'processing' },
    ]).map((item) => item.key),
    ['warn', 'work'],
  );

  const source = fs.readFileSync(path.join(__dirname, 'frontend/src/components/InterviewReviewPanel.jsx'), 'utf8');
  const fallbackSource = fs.readFileSync(path.join(__dirname, 'frontend/src/components/LocalInterviewPanel.jsx'), 'utf8');
  const waveformSource = fs.readFileSync(path.join(__dirname, 'frontend/src/components/LiveRecordingWaveform.jsx'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, 'frontend/src/styles.css'), 'utf8');
  const candidateV2Styles = fs.readFileSync(path.join(__dirname, 'frontend/src/candidate-v2.css'), 'utf8');
  const actionServer = fs.readFileSync(path.join(__dirname, 'action-server.js'), 'utf8');
  for (const label of ['面试准备', '录音', '复盘', '事实确认', '入档', '材料归属']) {
    assert.ok(source.includes(`label: '${label}'`), `missing neutral todo label: ${label}`);
  }
  assert.match(source, /面试流程已处理完成/);
  assert.match(source, /actionableInterviewTodoItems\(items\)/);

  const durationContractStart = source.indexOf('const MIN_RECORDING_DURATION_SECONDS');
  const durationContractEnd = source.indexOf('\nfunction transcriptFromResponse', durationContractStart);
  assert.ok(durationContractStart >= 0 && durationContractEnd > durationContractStart,
    'recording duration validator must remain independently testable');
  const durationValidator = Function(
    `${source.slice(durationContractStart, durationContractEnd)}\nreturn recordingDurationError;`,
  )();
  assert.match(durationValidator(4), /5/);
  assert.equal(durationValidator(5), '');
  assert.equal(durationValidator(14_400), '');
  assert.match(durationValidator(14_401), /14400/);
  assert.match(durationValidator('5.5'), /整数/);
  assert.equal(durationValidator(''), '', 'blank duration must keep manual-stop mode');
  assert.match(source, /name="interview-review-duration-seconds"[\s\S]*min=\{MIN_RECORDING_DURATION_SECONDS\}[\s\S]*max=\{MAX_RECORDING_DURATION_SECONDS\}/);
  assert.match(source, /disabled=\{[^\r\n]*!!durationValidationError/,
    'invalid planned duration must disable recording start');
  assert.match(actionServer, /duration < 5 \|\| duration > 4 \* 60 \* 60/,
    'server and renderer must keep the same 5..14400 second recording boundary');
  assert.deepEqual(reviewNavigation.localInterviewRecordingFinalizationUiState({
    status: 'running',
    mode: 'record',
    stop_requested: true,
    cleanup_pending: true,
  }), {
    finalizing: true,
    discarding: true,
    transcribing: false,
    mode: 'discarding',
    buttonLabel: '正在停止并清理…',
  });
  assert.deepEqual(reviewNavigation.localInterviewRecordingFinalizationUiState({
    status: 'running',
    mode: 'record',
    stop_requested: true,
    cleanup_pending: false,
  }), {
    finalizing: true,
    discarding: false,
    transcribing: true,
    mode: 'transcribing',
    buttonLabel: '正在生成转写…',
  });
  assert.deepEqual(state.deriveWorkflowState({
    ...base,
    localJob: {
      status: 'running',
      mode: 'record',
      bind_candidate_id: 'candidate-1',
      stop_requested: true,
      cleanup_pending: true,
      termination_unconfirmed: false,
    },
  }), {
    key: 'discarding',
    label: '停止清理中',
    step: 'start',
    tone: 'processing',
    message: '授权已撤回；正在停止录音并删除未完成材料，不会生成本次转写或复盘。',
  }, 'workflow state must reuse the discard finalization truth instead of reporting transcription');
  assert.equal(state.deriveWorkflowState({
    ...base,
    localJob: {
      status: 'running',
      mode: 'record',
      bind_candidate_id: 'candidate-1',
      stop_requested: true,
      cleanup_pending: false,
    },
  }).key, 'transcribing', 'manual stop must remain the only recording finalization shown as transcription');
  assert.deepEqual(state.deriveWorkflowState({
    ...base,
    localJob: {
      status: 'starting',
      mode: 'record',
      bind_candidate_id: 'candidate-1',
    },
  }), {
    key: 'starting',
    label: '建立录音中',
    step: 'start',
    tone: 'processing',
    message: '正在确认安全守护与持久状态，尚未打开麦克风。',
  }, 'the durable guardian handshake window must remain an active non-microphone state');
  assert.match(source, /discarding\s*\?\s*recordingFinalizationUiState\.buttonLabel/,
    'candidate stop button must prioritize discard cleanup over a stale manual-stop busy label');
  assert.match(source, /<LiveRecordingWaveform[\s\S]*?discarding=\{discarding\}/,
    'candidate waveform must receive the consent-withdrawal discard state');
  assert.match(fallbackSource, /<LiveRecordingWaveform[\s\S]*?discarding=\{discarding\}/,
    'fallback waveform must not relabel a globally visible abort as transcription');
  assert.match(waveformSource, /正在停止录音并清理未完成材料；不会生成本次转写或复盘，波形已冻结。/,
    'discarding waveform copy must explicitly deny transcript/review generation');
  assert.match(waveformSource, /data-finalization-mode=\{discarding \? 'discarding'/,
    'waveform must expose a machine-verifiable discard lifecycle state');
  assert.match(source, /const recordingFinalization = localInterviewRecordingFinalizationUiState\(currentLocalJob \|\| \{\}\)/,
    'the todo card must reuse the canonical recording finalization helper');
  assert.match(source, /discardingRunning[\s\S]*?'停止清理中'[\s\S]*?transcribingRunning \? '转写中'/,
    'the todo card must never label consent-withdrawal cleanup as transcription');
  assert.match(source, /const starting = job && job\.status === 'starting';[\s\S]*const taskActive = starting \|\| running;[\s\S]*const taskBusy = taskActive \|\| terminationPending/,
    'the candidate launcher must keep actions blocked throughout the guardian handshake');
  assert.match(source, /job\.status === 'starting'[\s\S]*setInterval\(refreshProgress, recordingProgressActive \? 450 : 2500\)/,
    'the candidate launcher must poll the starting handshake at the active-task cadence');
  assert.match(fallbackSource, /const starting = job && job\.status === 'starting';[\s\S]*const taskActive = starting \|\| running/,
    'the fallback panel must also treat starting as active');
  assert.match(fallbackSource, /正在建立安全录音并确认本地守护状态，尚未打开麦克风/,
    'the fallback panel must explain the pre-microphone starting state');

  const scriptPanelStart = source.indexOf('function InterviewScriptPanel(');
  const scriptPanelEnd = source.indexOf('\nfunction MiniList(', scriptPanelStart);
  const scriptPanel = source.slice(scriptPanelStart, scriptPanelEnd);
  assert.match(scriptPanel, /interview-script-text-preview[\s\S]*<pre>\{previewText/,
    'saved script preview must render the same plain-text source used by the editor');
  assert.match(scriptPanel, /aria-label="面试脚本文本"/);
  assert.doesNotMatch(scriptPanel, /script\.sections|closing_checklist/,
    'the preview must not keep rendering stale structured fields after a text edit');
  assert.match(source, /function plainTextScriptPayload[\s\S]*delete next\.sections;[\s\S]*delete next\.closing_checklist;[\s\S]*next\.script_text = text;/);
  assert.match(source, /const nextScript = plainTextScriptPayload\(script, scriptDraft\)[\s\S]*api\.saveInterviewScript\(jobId, nextScript, scriptDraft\)/);
  const scriptPayloadStart = source.indexOf('function plainTextScriptPayload');
  const scriptPayloadEnd = source.indexOf('\nconst MIN_RECORDING_DURATION_SECONDS', scriptPayloadStart);
  const scriptPayload = Function(
    `${source.slice(scriptPayloadStart, scriptPayloadEnd)}\nreturn plainTextScriptPayload;`,
  )();
  assert.deepEqual(
    scriptPayload({ id: 7, sections: [{ id: 'old' }], closing_checklist: ['old'], script_text: 'old' }, 'new'),
    { id: 7, editor_format: 'plain_text', script_text: 'new' },
    'saving a text edit must remove stale structured preview sources',
  );

  assert.match(source, /function InterviewReviewPanel\(\{[\s\S]*candidate,[\s\S]*readOnly,[\s\S]*onOpenSettings,[\s\S]*onDirtyChange,[\s\S]*initialTab = 'review',[\s\S]*navigationRequestKey,[\s\S]*navigationTarget,[\s\S]*\}\)/);
  assert.match(source, /const scriptDraftDirty = scriptEditing && scriptDraft !== scriptText\(script\)/);
  assert.match(source, /const reportDraftDirty = !!editingId && draft !== draftBaseline;/);
  assert.match(source, /const sessionFactsDirty = draftMapChanged\(sessionFacts, sessionFactsBaseline\);/);
  assert.match(source, /const confirmationsDirty = draftMapChanged\(confirmations, confirmationsBaseline\);/);
  assert.match(source, /hasUnsavedChanges = scriptDraftDirty \|\| reportDraftDirty \|\| sessionFactsDirty \|\| confirmationsDirty/,
    'scripts, JSON reports, session facts, and recording confirmations must share one dirty guard');
  assert.match(source, /dirtyChangeRef\.current\(hasUnsavedChanges\)/);
  assert.match(source, /dirtyChangeRef\.current\(false\)/,
    'unmount must release the parent dirty guard');
  assert.match(source, /function requestRefresh\(\)[\s\S]*if \(!hasUnsavedChanges\) return load\(\);[\s\S]*脚本、报告或事实确认[\s\S]*放弃修改并刷新/,
    'local refresh must confirm before discarding any explicitly saved interview draft');
  assert.doesNotMatch(source, /on(?:Click|Retry|RetryReport|RetryConfirmations)=\{load\}/,
    'every user-triggered content refresh must pass through the dirty guard');
  assert.match(source, /if \(!scriptEditingRef\.current\) setScriptDraft\(scriptText\(nextScript\)\)/,
    'background refreshes must preserve an active script editor');
  assert.match(source, /beforeunload/,
    'window close/reload must also protect an edited interview draft');
  assert.match(source, /navigationTarget\?\.type[\s\S]*?session\.report_id[\s\S]*?setExpandedSessionKey\(String\(matchedSession\.id\)\)/,
    'report and session task targets must expand the exact candidate interview round');
  assert.match(source, /id=\{`candidate-interview-session-\$\{session\.id\}`\}[\s\S]*?tabIndex=\{-1\}/,
    'the exact target round must expose a programmatically focusable anchor');
  assert.match(source, /function selectWorkspaceTab\(key\)[\s\S]*?key !== 'start'[\s\S]*?candidate-interview-launcher[\s\S]*?scrollIntoView\(\{ behavior: 'auto', block: 'start' \}\)[\s\S]*?onChange=\{selectWorkspaceTab\}/,
    'opening recording must bring its primary action into the current viewport without another user scroll');

  const navigationSessions = [
    { id: 10, round: 1, status: 'confirmed', materials: [{ interview_recording_id: 44 }] },
    { id: 20, round: 2, status: 'cancelled', materials: [] },
    { id: 30, round: 3, status: 'pending_review', materials: [] },
  ];
  assert.equal(
    reviewNavigation.sessionForCompletedRecording(navigationSessions, { recordingId: 44 }).id,
    10,
    'the immutable recording binding must select its exact Session',
  );
  assert.equal(
    reviewNavigation.sessionForCompletedRecording(navigationSessions, {
      sessionId: 20,
      recordingId: 44,
    }).id,
    20,
    'an immutable auto-bound Session id must outrank the recording lookup',
  );
  assert.equal(
    reviewNavigation.sessionForCompletedRecording(navigationSessions, { recordingId: 999, round: 2 }),
    null,
    'a mutable form round must never downgrade navigation to an unrelated Session',
  );

  const sessionReportGetState = reportResponse.sessionInterviewReportStateFromGetResponse({
    ok: true,
    report: {
      id: 81,
      session_id: 20,
      version: 7,
      status: 'draft',
      stale: false,
      report: {
        schema_version: 'interview_report_v1',
        summary: { text: 'Fixture report summary' },
      },
    },
    facts: [
      { id: 91, field_key: 'availability', review_status: 'pending' },
    ],
  });
  assert.equal(sessionReportGetState.meta.version, 7,
    'the real GET response wrapper must preserve the public report version');
  assert.equal(sessionReportGetState.expectedVersion, 7,
    'fact review and report confirmation must use the version returned by GET /interview-report');
  assert.equal(sessionReportGetState.report.summary.text, 'Fixture report summary');
  assert.deepEqual(sessionReportGetState.facts, [
    { id: 91, field_key: 'availability', review_status: 'pending' },
  ]);

  const savedServerFact = confirmationReview.normalizeSavedConfirmationItem({
    field_key: 'fact.01',
    field_label: '到岗时间',
    status: 'pending_review',
    extracted_value: '待核实',
    source: 'interview_report_v1',
  }, 0, [
    { id: 'arrival_time', label: '到岗时间' },
  ]);
  assert.equal(savedServerFact.id, 'fact.01',
    'a server-issued field_key must outrank a label compatibility mapping');
  assert.equal(savedServerFact.status, 'pending');
  assert.deepEqual(
    confirmationReview.strictConfirmationReviewItems([
      { ...savedServerFact, status: 'corrected', corrected_value: '两周' },
    ], [
      { id: 'arrival_time', label: '到岗时间' },
    ]),
    [{ field_key: 'fact.01', status: 'corrected', corrected_value: '两周' }],
    'the normalized server fact key must remain unchanged in the fact-review request',
  );

  let serverVersion = 1;
  let uiVersion = serverVersion;
  const localFactDraft = { field_key: 'fact.01', status: 'corrected', corrected_value: '两周' };
  const submitFactReview = async (expectedVersion) => {
    if (expectedVersion !== serverVersion) {
      const error = new Error('报告版本已变化，请重新读取后再提交。');
      error.code = 'STALE_VERSION';
      throw error;
    }
    return { ok: true, version: serverVersion + 1 };
  };
  serverVersion += 1;
  let conflictState;
  try {
    await submitFactReview(uiVersion);
  } catch (error) {
    assert.equal(versionConflict.isInterviewVersionConflict(error), true);
    conflictState = versionConflict.createInterviewVersionConflict(error, {
      actionKey: 'confirmations:20',
      hasLocalChanges: true,
    });
  }
  assert.equal(conflictState.status, 'conflict');
  assert.equal(conflictState.hasLocalChanges, true);
  const recoveredConflict = await versionConflict.recoverInterviewVersionConflict(
    conflictState,
    async (options) => {
      assert.deepEqual(options, { afterCurrent: true });
      uiVersion = serverVersion;
      return { status: 'committed', value: { ok: true, version: uiVersion } };
    },
  );
  assert.equal(recoveredConflict.status, 'recovered');
  assert.equal(localFactDraft.field_key, 'fact.01', 'one-click refresh must not discard the local fact draft');
  assert.deepEqual(await submitFactReview(uiVersion), { ok: true, version: 3 },
    'resubmission with the freshly loaded server version must succeed');

  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, resolve, reject };
  };
  const flushMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  const refreshProtocol = reviewNavigation.createStableInterviewReviewRefresh();
  const contextA = 'candidate-1\u0000job-1';
  const contextB = 'candidate-2\u0000job-1';
  refreshProtocol.setContext(contextA);
  const firstRefreshGate = deferred();
  const ctaRefreshGate = deferred();
  let childRefreshCalls = 0;
  let parentRefreshCalls = 0;
  let ctaRefreshCalls = 0;
  let trailingRefreshCalls = 0;
  const childCompletionRefresh = refreshProtocol.refresh(contextA, () => {
    childRefreshCalls += 1;
    return firstRefreshGate.promise;
  });
  const parentPollingRefresh = refreshProtocol.refresh(contextA, () => {
    parentRefreshCalls += 1;
    return Promise.resolve({ ok: true, candidateId: 'candidate-1', jobId: 'job-1', sessions: [] });
  });
  const ctaRefresh = refreshProtocol.refresh(contextA, () => {
    ctaRefreshCalls += 1;
    return ctaRefreshGate.promise;
  }, { afterCurrent: true });
  await flushMicrotasks();
  assert.equal(childRefreshCalls, 1);
  assert.equal(parentRefreshCalls, 0, 'parent polling must reuse the child completion refresh');
  assert.equal(ctaRefreshCalls, 0, 'CTA must wait for an already-running completion refresh');

  firstRefreshGate.resolve({
    ok: true,
    candidateId: 'candidate-1',
    jobId: 'job-1',
    sessions: [{ id: 1, materials: [] }],
  });
  assert.equal((await childCompletionRefresh).status, 'committed');
  assert.equal((await parentPollingRefresh).status, 'committed');
  await flushMicrotasks();
  assert.equal(ctaRefreshCalls, 1, 'CTA must run one fresh read after the observed in-flight refresh');

  const trailingBackgroundRefresh = refreshProtocol.refresh(contextA, () => {
    trailingRefreshCalls += 1;
    return Promise.resolve({ ok: true, candidateId: 'candidate-1', jobId: 'job-1', sessions: [] });
  });
  await flushMicrotasks();
  assert.equal(trailingRefreshCalls, 0, 'a later background poll must reuse, not invalidate, the CTA refresh');
  ctaRefreshGate.resolve({
    ok: true,
    candidateId: 'candidate-1',
    jobId: 'job-1',
    sessions: [{ id: 9, materials: [{ interview_recording_id: 44 }] }],
  });
  const ctaRefreshResult = await ctaRefresh;
  const trailingRefreshResult = await trailingBackgroundRefresh;
  assert.equal(ctaRefreshResult.status, 'committed');
  assert.equal(trailingRefreshResult.value.sessions[0].id, 9,
    'all concurrent readers must receive the completed CTA snapshot instead of undefined/old Sessions');

  const staleRefreshGate = deferred();
  refreshProtocol.setContext(contextA);
  const staleRefresh = refreshProtocol.refresh(contextA, () => staleRefreshGate.promise);
  await flushMicrotasks();
  refreshProtocol.setContext(contextB);
  const freshContextRefresh = refreshProtocol.refresh(contextB, async () => ({
    ok: true,
    candidateId: 'candidate-2',
    jobId: 'job-1',
    sessions: [{ id: 200, materials: [] }],
  }));
  staleRefreshGate.reject(new Error('old candidate failed'));
  assert.equal((await staleRefresh).status, 'stale',
    'a stale failure must resolve as stale instead of escaping into the new candidate');
  assert.equal((await freshContextRefresh).value.sessions[0].id, 200);
  await assert.rejects(
    refreshProtocol.refresh(contextB, async () => { throw new Error('current refresh failed'); }),
    /current refresh failed/,
    'a current-context refresh error must remain actionable',
  );

  const scheduledFocus = new Map();
  let nextFocusHandle = 1;
  const navigator = reviewNavigation.createCompletedReviewNavigator({
    scheduleFocus(callback) {
      const handle = nextFocusHandle;
      nextFocusHandle += 1;
      scheduledFocus.set(handle, callback);
      return handle;
    },
    cancelFocus(handle) {
      scheduledFocus.delete(handle);
    },
  });
  const runScheduledFocus = () => {
    const callbacks = [...scheduledFocus.values()];
    scheduledFocus.clear();
    callbacks.forEach((callback) => callback());
  };
  let navigationContext = { candidateId: 'candidate-1', jobId: 'job-1', activeTab: 'start' };
  const expandedSessions = [];
  const focusedSessions = [];
  const navigationConfig = (refresh, recordingId = 44) => ({
    context: { candidateId: 'candidate-1', jobId: 'job-1' },
    completion: { recordingId },
    refresh,
    selectReview: () => { navigationContext.activeTab = 'review'; },
    expandSession: (sessionId) => expandedSessions.push(sessionId),
    focusSession: (sessionId) => focusedSessions.push(sessionId),
    getContext: () => navigationContext,
  });

  const successfulNavigation = await navigator.navigate(navigationConfig(async () => ({
    status: 'committed',
    value: {
      ok: true,
      candidateId: 'candidate-1',
      jobId: 'job-1',
      sessions: [{ id: 9, materials: [{ interview_recording_id: 44 }] }],
    },
  })));
  assert.deepEqual(successfulNavigation, { status: 'navigated', sessionId: '9' });
  assert.deepEqual(expandedSessions, ['9']);
  assert.equal(scheduledFocus.size, 1);
  navigationContext.activeTab = 'start';
  navigator.invalidate();
  runScheduledFocus();
  assert.deepEqual(focusedSessions, [], 'switching tabs must cancel deferred focus');

  const candidateSwitchGate = deferred();
  navigationContext = { candidateId: 'candidate-1', jobId: 'job-1', activeTab: 'start' };
  const candidateSwitchNavigation = navigator.navigate(navigationConfig(() => candidateSwitchGate.promise));
  await flushMicrotasks();
  navigationContext = { candidateId: 'candidate-2', jobId: 'job-1', activeTab: 'review' };
  navigator.invalidate();
  candidateSwitchGate.resolve({
    status: 'committed',
    value: {
      ok: true,
      candidateId: 'candidate-1',
      jobId: 'job-1',
      sessions: [{ id: 10, materials: [{ interview_recording_id: 44 }] }],
    },
  });
  assert.equal((await candidateSwitchNavigation).status, 'stale');
  assert.deepEqual(expandedSessions, ['9'],
    'a candidate switch during await must not expand the old candidate Session');

  const staleNavigationErrorGate = deferred();
  navigationContext = { candidateId: 'candidate-1', jobId: 'job-1', activeTab: 'start' };
  const staleNavigationError = navigator.navigate(navigationConfig(() => staleNavigationErrorGate.promise));
  await flushMicrotasks();
  navigationContext = { candidateId: 'candidate-2', jobId: 'job-1', activeTab: 'review' };
  navigator.invalidate();
  staleNavigationErrorGate.reject(new Error('old navigation failed'));
  assert.equal((await staleNavigationError).status, 'stale',
    'an old navigation error must not surface in the newly selected candidate');

  const supersededNavigationGate = deferred();
  navigationContext = { candidateId: 'candidate-1', jobId: 'job-1', activeTab: 'start' };
  const supersededNavigation = navigator.navigate(navigationConfig(() => supersededNavigationGate.promise));
  await flushMicrotasks();
  const newerNavigation = await navigator.navigate(navigationConfig(async () => ({
    status: 'committed',
    value: {
      ok: true,
      candidateId: 'candidate-1',
      jobId: 'job-1',
      sessions: [{ id: 55, materials: [{ interview_recording_id: 55 }] }],
    },
  }), 55));
  assert.deepEqual(newerNavigation, { status: 'navigated', sessionId: '55' });
  supersededNavigationGate.resolve({
    status: 'committed',
    value: {
      ok: true,
      candidateId: 'candidate-1',
      jobId: 'job-1',
      sessions: [{ id: 10, materials: [{ interview_recording_id: 44 }] }],
    },
  });
  assert.equal((await supersededNavigation).status, 'stale',
    'a newer explicit navigation must invalidate an older deferred navigation');
  assert.deepEqual(expandedSessions, ['9', '55']);
  navigator.invalidate();

  navigationContext = { candidateId: 'candidate-1', jobId: 'job-1', activeTab: 'start' };
  await assert.rejects(
    navigator.navigate(navigationConfig(async () => { throw new Error('navigation refresh failed'); })),
    /navigation refresh failed/,
  );
  navigationContext = { candidateId: 'candidate-2', jobId: 'job-1', activeTab: 'start' };
  assert.equal(
    (await navigator.navigate(navigationConfig(async () => ({
      status: 'committed',
      value: {
        ok: true,
        candidateId: 'candidate-1',
        jobId: 'job-1',
        sessions: navigationSessions,
      },
    })))).status,
    'stale',
    'a mismatched candidate/job epoch must fail closed before expanding or focusing',
  );

  const optionalActionStart = source.indexOf('function runOptionalActionOnce');
  const optionalActionEnd = source.indexOf('\nfunction restoreConsentTrigger', optionalActionStart);
  assert.ok(optionalActionStart >= 0 && optionalActionEnd > optionalActionStart,
    'optional completion navigation must keep an independently testable in-flight guard');
  const runOptionalActionOnce = Function(
    `${source.slice(optionalActionStart, optionalActionEnd)}\nreturn runOptionalActionOnce;`,
  )();
  const navigationLock = { current: false };
  let releaseNavigation;
  let navigationCalls = 0;
  const firstNavigation = runOptionalActionOnce(navigationLock, () => {
    navigationCalls += 1;
    return new Promise((resolve) => { releaseNavigation = resolve; });
  });
  assert.equal(await runOptionalActionOnce(navigationLock, () => { navigationCalls += 1; }), false,
    'a second click while navigation is busy must be ignored');
  assert.equal(navigationCalls, 1, 'busy navigation must not replay its callback');
  releaseNavigation();
  assert.equal(await firstNavigation, true);
  assert.equal(await runOptionalActionOnce(navigationLock, undefined), false,
    'a missing optional callback must be a safe no-op');
  assert.equal(navigationLock.current, null, 'completion navigation must always release its local busy guard');

  const launcherStart = source.indexOf('function CandidateInterviewLauncher(');
  const launcherEnd = source.indexOf('\nfunction RecordingCard(', launcherStart);
  const launcher = source.slice(launcherStart, launcherEnd);
  assert.match(launcher, /onViewLatestReview/);
  assert.match(launcher, /function openCompletedInterviewReview\(\)[\s\S]*runOptionalActionOnce\([\s\S]*onViewLatestReview\(\{[\s\S]*recordingId:[\s\S]*sessionId:/,
    'the completion CTA must pass only immutable recording/Session identity through its guarded callback');
  assert.doesNotMatch(
    launcher.slice(launcher.indexOf('function openCompletedInterviewReview'), launcher.indexOf('const ready =')),
    /round:/,
    'the completion CTA must not read the mutable round form after recording',
  );
  assert.match(launcher, /disabled=\{typeof onViewLatestReview !== 'function' \|\| viewLatestReviewBusy\}[\s\S]*loading=\{viewLatestReviewBusy\}[\s\S]*onClick=\{openCompletedInterviewReview\}/,
    'the completion CTA must disable itself for a missing callback and while its navigation is in flight');
  assert.doesNotMatch(launcher, /onClick=\{onCompleted\}/,
    'the visible completion CTA must not remain a refresh-only action');

  assert.match(source, /createStableInterviewReviewRefresh/);
  assert.match(source, /createCompletedReviewNavigator/);
  assert.match(source, /candidateJobContextRef\.current = \{[\s\S]*candidateId:[\s\S]*jobId:/,
    'navigation context must be synchronized during render rather than captured by an old async closure');
  assert.match(source, /function currentInterviewNavigationContext\(\)[\s\S]*\.\.\.candidateJobContextRef\.current[\s\S]*activeTab: activeTabRef\.current/,
    'post-await and focus checks must read the latest candidate/job/tab context refs');
  assert.match(source, /refresh: \(\) => load\(\{ afterCurrent: true \}\)/,
    'explicit completion navigation must wait for and follow any in-flight background refresh');
  assert.match(source, /key=\{`\$\{String\(candidateId \|\| ''\)\}:\$\{String\(jobId \|\| ''\)\}`\}/,
    'candidate/job switches must remount launcher-local busy and error state');
  assert.match(source, /onCompleted=\{load\}[\s\S]*onViewLatestReview=\{navigateToCompletedInterviewReview\}/,
    'background completion refresh and explicit review navigation must remain separate callbacks');

  const draftHelperStart = source.indexOf('function canonicalDraftValue');
  const draftHelperEnd = source.indexOf('\nconst INTERVIEW_WORKSPACE_TAB_KEYS', draftHelperStart);
  assert.ok(draftHelperStart >= 0 && draftHelperEnd > draftHelperStart,
    'fact and confirmation baselines must use a deterministic comparison helper');
  const draftHelpers = Function(
    `${source.slice(draftHelperStart, draftHelperEnd)}\nreturn { draftMapChanged, mergeServerDraftMap };`,
  )();
  assert.equal(
    draftHelpers.draftMapChanged({ 7: [{ note: 'same', status: 'confirmed' }] }, { 7: [{ status: 'confirmed', note: 'same' }] }),
    false,
    'object key order must not create a false dirty state',
  );
  assert.deepEqual(
    draftHelpers.mergeServerDraftMap(
      { 7: [{ status: 'corrected' }], 8: [{ status: 'confirmed' }] },
      { 7: [{ status: 'pending' }], 8: [{ status: 'confirmed' }] },
      { 7: [{ status: 'pending' }], 8: [{ status: 'rejected' }] },
    ),
    { 7: [{ status: 'corrected' }], 8: [{ status: 'rejected' }] },
    'background/server refresh must preserve only locally dirty fact entries',
  );
  assert.match(source, /function discardEditableDrafts\(\)[\s\S]*restoreConfirmationDraftBaselines\(\)/,
    'only an explicit discard path may restore fact and confirmation baselines');
  assert.match(source, /const ok = await run\([\s\S]*session-fact-review[\s\S]*if \(ok\) markSessionFactsSaved\(session\.id, items\)/,
    'session fact drafts must become clean only after a successful save');
  assert.match(source, /const ok = await run\([\s\S]*saveInterviewConfirmations[\s\S]*if \(ok\) markConfirmationsSaved\(id, items\)/,
    'recording confirmation drafts must become clean only after a successful save');
  assert.match(source, /<FactConfirmations[\s\S]*strictReview[\s\S]*onFactsSave/,
    'strict session facts must not expose fields that the F-008 save contract cannot persist');
  assert.match(source, /const reviewedItems = strictConfirmationReviewItems\(items, CONFIRMATION_FIELDS\)/,
    'session fact saves must send only the strict backend fields');
  assert.match(source, /recoverInterviewVersionConflict\([\s\S]*?\(options\) => load\(options\)/,
    'version conflict recovery must use the stable refresh path');
  assert.match(source, /重新读取服务端版本/);
  assert.match(source, /confirmationProgress\(records, reports, confirmationsBaseline\)/);
  assert.match(source, /sessionConfirmationProgress\(sessionOnlyUnits, sessionFactsBaseline\)/,
    'top-level progress must use server-confirmed fact baselines, not unsaved local choices');
  assert.match(source, /pendingFacts > 0 \|\| factsDirty/);
  assert.match(source, /confirmationPending \|\| confirmationsDirty/,
    'formal confirmation must remain blocked until edited facts are explicitly saved');

  const contextResetStart = source.indexOf("loadedCandidateIdRef.current = '';", source.indexOf('useEffect(() => {', source.indexOf('const refreshLocalJob')));
  const contextResetEnd = source.indexOf('\n\n  useEffect(() => {', contextResetStart);
  const contextReset = source.slice(contextResetStart, contextResetEnd);
  assert.match(contextReset, /resetConfirmationDraftMaps\(\)/);
  assert.match(contextReset, /\}, \[load\]\);/);
  assert.doesNotMatch(contextReset, /readOnly/,
    'a transient readOnly/loading change must not reset interview drafts');
  assert.match(source, /Object\.is\(navigationRequestKeyRef\.current, navigationRequestKey\)[\s\S]*setInterviewActiveTab\(initialTab\)/,
    'a new contextual navigation request must select a legal tab and invalidate stale completion navigation without resetting drafts');

  assert.match(source, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches/);
  assert.match(source, /target\.scrollIntoView\(\{ behavior: reduceMotion \? 'auto' : 'smooth'/);
  assert.match(source, /target\.focus\(\{ preventScroll: true \}\)/,
    'todo navigation must move keyboard focus to the revealed target');
  assert.match(source, /工具：\{doctorStatusText\}/);
  assert.match(source, /麦克风：\{microphoneStatusText\}/,
    'software discovery and microphone verification must remain separate status dimensions');
  assert.match(source, /const micCheckJobIdRef = useRef\(''\)/);
  assert.match(source, /String\(job\.id \|\| ''\) === micCheckJobIdRef\.current/,
    'candidate microphone status must belong to the test started in the current launcher session');
  assert.match(source, /job\.status === 'done' && isCurrentMicCheckRun/,
    'historical or incomplete microphone jobs must not be presented as verified results');
  assert.match(source, /\{taskStatusDimension\}：\{taskStatusText\}/);
  assert.match(source, /当前面试轮次/);

  assert.match(styles, /\.candidate-interview-controls\s*\{[\s\S]*grid-template-columns:\s*minmax\(112px, 0\.45fr\) minmax\(210px, 1fr\) max-content;/,
    'wide recording controls must keep the primary action in the same operation row');
  assert.match(styles, /@container candidate-detail \(max-width: 560px\)[\s\S]*\.candidate-interview-actions\s*\{[\s\S]*grid-column:\s*1 \/ -1;/,
    'narrow panes must reflow recording actions below the inputs');
  assert.doesNotMatch(candidateV2Styles,
    /@container candidate-workspace \(max-width: 720px\)\s*\{[\s\S]*?\.candidate-v2-detail \.candidate-interview-controls,/,
    'the generic candidate workspace breakpoint must not override the dedicated recording-control contract');

  console.log(JSON.stringify({
    ok: true,
    contract: 'INTERVIEW-WORKFLOW-UI-STATE-001',
    terminal_truth: true,
    prestart_action_preserved: true,
    actionable_only: true,
    dirty_guard: true,
    script_single_source: 'plain_text',
    recording_duration_bounds: [5, 14_400],
    recording_layout_contract: {
      wide_minimum_columns: [112, 210],
      narrow_breakpoint_px: 560,
      generic_candidate_override: false,
    },
    todo_focus_and_reduced_motion: true,
  }));
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
