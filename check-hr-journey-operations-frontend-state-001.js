'use strict';

const assert = require('assert');
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
  const state = await import(pathToFileURL(path.join(
    __dirname,
    'frontend/src/candidate-journey-operation-state.mjs',
  )).href);

  assert.equal(state.canWriteJourneyOperations({
    authorityLoaded: false,
  }), false, 'writes must remain locked before the first authority read succeeds');
  assert.equal(state.canWriteJourneyOperations({
    authorityLoaded: true,
  }), true, 'a successful authority read should unlock normal local writes');
  assert.equal(state.canWriteJourneyOperations({
    authorityLoaded: true,
    busy: true,
  }), false, 'an in-flight write must keep all operation writes locked');
  assert.equal(state.canWriteJourneyOperations({
    authorityLoaded: true,
    refreshRequired: true,
  }), false, 'a committed write with stale projection must not be submitted again');

  let sequence = 0;
  const createRequestId = (prefix) => `${prefix}:fixture-${++sequence}`;
  const payload = { candidate_id: 'C-FIXTURE-001', job_id: 1, note: '同一草稿' };
  const first = state.resolveStableDraftRequest(null, {
    prefix: 'manager-feedback',
    payload,
    createRequestId,
    createTimestamp: () => '2026-07-28T00:00:00.000Z',
  });
  const retry = state.resolveStableDraftRequest(first, {
    prefix: 'manager-feedback',
    payload: { ...payload },
    createRequestId,
    createTimestamp: () => '2026-07-28T00:01:00.000Z',
  });
  assert.strictEqual(retry, first, 'an unknown response retry must reuse the exact request envelope');
  assert.equal(retry.request_id, first.request_id);
  assert.equal(retry.created_at, first.created_at, 'feedback_at must remain stable with its request id');

  const edited = state.resolveStableDraftRequest(first, {
    prefix: 'manager-feedback',
    payload: { ...payload, note: '用户编辑后的草稿' },
    createRequestId,
  });
  assert.notEqual(edited.request_id, first.request_id, 'editing the payload must allocate a new request id');
  const clearedAfterSuccess = state.resolveStableDraftRequest(null, {
    prefix: 'manager-feedback',
    payload,
    createRequestId,
  });
  assert.notEqual(clearedAfterSuccess.request_id, first.request_id, 'known success must clear the stable request id');

  assert.equal(state.preserveEditedGeneratedDraft({
    currentDraft: 'HR 手工修改内容',
    generatedDraft: '新状态生成内容',
    touched: true,
  }), 'HR 手工修改内容', 'persisted Offer refresh must preserve an edited local copy');
  assert.equal(state.preserveEditedGeneratedDraft({
    currentDraft: '旧模板',
    generatedDraft: '新状态生成内容',
    touched: false,
  }), '新状态生成内容', 'untouched local copy should follow the persisted Offer state');

  console.log('check-hr-journey-operations-frontend-state-001: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
