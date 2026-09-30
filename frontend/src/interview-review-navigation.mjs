function normalizedContextKey(value) {
  return String(value ?? '');
}

function sameCandidateJob(left, right) {
  return normalizedContextKey(left?.candidateId) === normalizedContextKey(right?.candidateId)
    && normalizedContextKey(left?.jobId) === normalizedContextKey(right?.jobId);
}

function immutableCompletionIdentity(context = {}) {
  const sessionId = Number(
    context.sessionId
    || context.recording?.session_id
    || context.recording?.session_consent_link?.session_id,
  );
  const recordingId = Number(context.recordingId || context.recording?.id);
  return {
    sessionId: Number.isInteger(sessionId) && sessionId > 0 ? sessionId : null,
    recordingId: Number.isInteger(recordingId) && recordingId > 0 ? recordingId : null,
  };
}

export function localInterviewTerminationUiState(job = {}) {
  const persistenceFailed = job.persistent_state_failed === true;
  const bindingPending = job.binding_pending === true;
  const terminationUnconfirmed = job.termination_unconfirmed === true;
  const cleanupFailed = job.cleanup_pending === true
    && job.stop_failed === true
    && !terminationUnconfirmed;
  const pending = job.cleanup_pending === true
    || job.termination_unconfirmed === true
    || persistenceFailed
    || bindingPending;
  const blocking = pending && (
    job.stop_failed === true || terminationUnconfirmed || persistenceFailed || bindingPending
  );
  return {
    pending,
    blocking,
    label: !pending
      ? ''
      : (bindingPending
        ? '录音材料归档待重试，已阻止新录音'
        : (persistenceFailed
        ? '录音安全状态保存失败，已阻止继续操作'
        : (terminationUnconfirmed
          ? '录音停止未确认，已阻止继续操作'
          : (cleanupFailed
            ? '未完成材料清理失败，已阻止继续操作'
            : '正在安全停止并清理')))),
  };
}

export function localInterviewRecordingFinalizationUiState(job = {}) {
  const recordingRunning = job.status === 'running' && job.mode === 'record';
  const discarding = recordingRunning && (
    job.cleanup_pending === true || job.termination_unconfirmed === true
  );
  const plannedDuration = Number(job.planned_duration_seconds);
  const elapsedDuration = Number(job.elapsed_seconds);
  const plannedStopReached = Number.isFinite(plannedDuration)
    && plannedDuration > 0
    && Number.isFinite(elapsedDuration)
    && elapsedDuration >= plannedDuration;
  const transcribing = recordingRunning
    && !discarding
    && (job.stop_requested === true || plannedStopReached);
  return {
    finalizing: discarding || transcribing,
    discarding,
    transcribing,
    mode: discarding ? 'discarding' : (transcribing ? 'transcribing' : ''),
    buttonLabel: discarding
      ? '正在停止并清理…'
      : (transcribing ? '正在生成转写…' : '停止并转写'),
  };
}

export function sessionForCompletedRecording(sessions, context = {}) {
  const rows = Array.isArray(sessions) ? sessions : [];
  const identity = immutableCompletionIdentity(context);
  if (identity.sessionId) {
    const exactSession = rows.find((session) => Number(session?.id) === identity.sessionId);
    if (exactSession) return exactSession;
  }
  if (identity.recordingId) {
    const linkedSession = rows.find((session) => (
      Array.isArray(session?.materials)
      && session.materials.some((material) => (
        Number(material?.interview_recording_id) === identity.recordingId
      ))
    ));
    if (linkedSession) return linkedSession;
  }
  return null;
}

export function createStableInterviewReviewRefresh() {
  let activeContextKey = '';
  let contextEpoch = 0;
  let inFlight = null;
  let latest = null;

  function setContext(nextContextKey) {
    const normalized = normalizedContextKey(nextContextKey);
    if (normalized === activeContextKey) return contextEpoch;
    activeContextKey = normalized;
    contextEpoch += 1;
    inFlight = null;
    latest = null;
    return contextEpoch;
  }

  function isCurrent(token) {
    return token.contextKey === activeContextKey && token.epoch === contextEpoch;
  }

  function start(contextKey, loader) {
    const token = { contextKey, epoch: contextEpoch };
    const entry = { token, promise: null };
    entry.promise = Promise.resolve()
      .then(loader)
      .then((value) => {
        if (!isCurrent(token) || value === undefined) {
          return { status: 'stale', value: null };
        }
        latest = { token, value };
        return { status: 'committed', value };
      })
      .catch((error) => {
        if (!isCurrent(token)) return { status: 'stale', value: null };
        throw error;
      })
      .finally(() => {
        if (inFlight === entry) inFlight = null;
      });
    inFlight = entry;
    return entry.promise;
  }

  async function refresh(nextContextKey, loader, options = {}) {
    const contextKey = normalizedContextKey(nextContextKey);
    if (contextKey !== activeContextKey) setContext(contextKey);
    if (typeof loader !== 'function') return { status: 'unavailable', value: null };
    const requestedEpoch = contextEpoch;

    if (options.afterCurrent === true && inFlight) {
      const observed = inFlight;
      try {
        await observed.promise;
      } catch {
        // A current failed refresh must not block the explicit follow-up refresh.
      }
      if (contextKey !== activeContextKey || requestedEpoch !== contextEpoch) {
        return { status: 'stale', value: null };
      }
      // If another caller already started a refresh after the observed one,
      // that newer request is the required follow-up and can be shared.
      if (inFlight && inFlight !== observed) return inFlight.promise;
      return start(contextKey, loader);
    }

    if (inFlight) return inFlight.promise;
    return start(contextKey, loader);
  }

  function latestValue(nextContextKey) {
    const contextKey = normalizedContextKey(nextContextKey);
    if (!latest || contextKey !== activeContextKey || !isCurrent(latest.token)) return null;
    return latest.value;
  }

  return {
    setContext,
    refresh,
    latestValue,
  };
}

export function createCompletedReviewNavigator(options = {}) {
  const scheduleFocus = options.scheduleFocus || ((callback) => globalThis.setTimeout(callback, 0));
  const cancelFocus = options.cancelFocus || ((handle) => globalThis.clearTimeout(handle));
  let navigationEpoch = 0;
  let focusHandle = null;

  function cancelScheduledFocus() {
    if (focusHandle == null) return;
    cancelFocus(focusHandle);
    focusHandle = null;
  }

  function invalidate() {
    navigationEpoch += 1;
    cancelScheduledFocus();
    return navigationEpoch;
  }

  function currentContextMatches(token, expected, getContext) {
    if (token !== navigationEpoch || typeof getContext !== 'function') return false;
    const current = getContext();
    return sameCandidateJob(current, expected) && current?.activeTab === 'review';
  }

  async function navigate(config = {}) {
    const identity = immutableCompletionIdentity(config.completion);
    if (!identity.sessionId && !identity.recordingId) {
      return { status: 'unavailable', sessionId: null };
    }
    if (
      typeof config.refresh !== 'function'
      || typeof config.selectReview !== 'function'
      || typeof config.expandSession !== 'function'
      || typeof config.getContext !== 'function'
    ) {
      return { status: 'unavailable', sessionId: null };
    }

    const expected = {
      candidateId: config.context?.candidateId,
      jobId: config.context?.jobId,
      activeTab: 'review',
    };
    const token = invalidate();
    config.selectReview();
    if (!currentContextMatches(token, expected, config.getContext)) {
      return { status: 'stale', sessionId: null };
    }

    let refreshResult;
    try {
      refreshResult = await config.refresh();
    } catch (error) {
      if (!currentContextMatches(token, expected, config.getContext)) {
        return { status: 'stale', sessionId: null };
      }
      throw error;
    }
    if (!currentContextMatches(token, expected, config.getContext)) {
      return { status: 'stale', sessionId: null };
    }
    if (refreshResult?.status !== 'committed') {
      return { status: refreshResult?.status === 'stale' ? 'stale' : 'unavailable', sessionId: null };
    }

    const snapshot = refreshResult.value;
    if (!snapshot?.ok) {
      throw new Error(snapshot?.error || '最新面试资料刷新失败');
    }
    if (!sameCandidateJob(snapshot, expected)) {
      return { status: 'stale', sessionId: null };
    }
    const targetSession = sessionForCompletedRecording(snapshot.sessions, config.completion);
    if (!targetSession) return { status: 'missing', sessionId: null };

    const targetSessionId = String(targetSession.id);
    config.expandSession(targetSessionId);
    if (!currentContextMatches(token, expected, config.getContext)) {
      return { status: 'stale', sessionId: null };
    }

    if (typeof config.focusSession === 'function') {
      focusHandle = scheduleFocus(() => {
        focusHandle = null;
        if (!currentContextMatches(token, expected, config.getContext)) return;
        config.focusSession(targetSessionId);
      });
    }
    return { status: 'navigated', sessionId: targetSessionId };
  }

  return {
    navigate,
    invalidate,
  };
}
