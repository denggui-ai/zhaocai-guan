export function canWriteJourneyOperations({
  readOnly = false,
  authorityLoaded = false,
  busy = false,
  refreshRequired = false,
} = {}) {
  return readOnly !== true
    && authorityLoaded === true
    && busy !== true
    && refreshRequired !== true;
}

export function resolveStableDraftRequest(current, {
  prefix,
  payload,
  createRequestId,
  createTimestamp,
} = {}) {
  const fingerprint = JSON.stringify(payload || {});
  if (current && current.fingerprint === fingerprint) return current;
  if (typeof createRequestId !== 'function') throw new TypeError('createRequestId is required');
  return {
    fingerprint,
    request_id: createRequestId(prefix),
    created_at: typeof createTimestamp === 'function' ? createTimestamp() : null,
  };
}

export function preserveEditedGeneratedDraft({
  currentDraft = '',
  generatedDraft = '',
  touched = false,
} = {}) {
  return touched ? currentDraft : generatedDraft;
}
