'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ScreenshotAiImportStateStore,
  assertApprovedScreenshotInput,
  prepareScreenshotAiBatch,
  publicApprovalPreview,
  publicScreenshotAiState,
} = require('./screenshot-ai-import-state');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-ai-state-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
const source = path.join(tmp, 'selected');
fs.mkdirSync(source);
fs.writeFileSync(path.join(source, '01.png'), Buffer.from('synthetic-image-one'));
fs.writeFileSync(path.join(source, '02.jpg'), Buffer.from('synthetic-image-two'));

const snapshot = prepareScreenshotAiBatch(source);
assert.equal(snapshot.items.length, 2);
const connection = { provider: 'synthetic', baseUrl: 'https://ai.example.test/v1', model: 'synthetic-model' };
const preview = publicApprovalPreview(snapshot, connection);
assert.equal(preview.imageCount, 2);
assert.deepEqual(preview.items.map((item) => item.fileName), ['01.png', '02.jpg']);
assert.ok(preview.items.every((item) => /^[0-9a-f]{12}$/.test(item.contentHashPrefix)));
assert.doesNotMatch(JSON.stringify(preview), new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), '公开预览不得泄露本地路径');
assert.equal(assertApprovedScreenshotInput(snapshot.items[0], {
  dataUri: `data:image/png;base64,${fs.readFileSync(snapshot.items[0].source_path).toString('base64')}`,
}), true);
assert.throws(() => assertApprovedScreenshotInput(snapshot.items[0], {
  dataUri: `data:image/png;base64,${Buffer.from('replacement-after-approval').toString('base64')}`,
}), (error) => error && error.code === 'SCREENSHOT_SOURCE_CHANGED');
const changedPublic = publicScreenshotAiState({
  run_id: 'changed-run', status: 'done', phase: 'complete', created_at: null, updated_at: null, finished_at: null,
  items: [{ image_id: 'changed-image', ordinal: 1, status: 'failed', attempts: 1, error_code: 'SCREENSHOT_SOURCE_CHANGED' }],
});
assert.equal(changedPublic.retryable_count, 0);
assert.equal(changedPublic.items[0].retryable, false, '内容已变化必须重新导入并授权，不得提供必失败的重试');

const statePath = path.join(tmp, 'private', 'state.json');
const store = new ScreenshotAiImportStateStore({
  statePath,
  idFactory: () => 'run-synthetic-001',
  clock: () => new Date('2026-08-14T08:00:00.000Z'),
});
const run = store.create(snapshot, connection);
const successRead = {
  file: snapshot.items[0].source_path,
  page_type: 'detail',
  skipped: false,
  name: '张三',
  facts: { age: '28岁' },
  candidate_group_index: 0,
};
const failedRead = {
  file: snapshot.items[1].source_path,
  page_type: null,
  skipped: true,
  failed: true,
  reason: 'provider detail must remain private',
  name: null,
  facts: null,
};
store.recordSettled(run.run_id, snapshot.items[0].image_id, successRead);
store.recordSettled(run.run_id, snapshot.items[1].image_id, failedRead);
store.finalize(run.run_id, { reads: [successRead, failedRead] });

let publicState = publicScreenshotAiState(store.requireRun(run.run_id));
assert.equal(publicState.counts.succeeded_count, 1);
assert.equal(publicState.counts.failed_count, 1);
assert.equal(publicState.items.length, 1);
assert.equal(publicState.items[0].image_id, snapshot.items[1].image_id);
assert.doesNotMatch(JSON.stringify(publicState), /provider detail|selected|02\.jpg/, '公开任务摘要不得泄露路径、文件名或底层错误');
if (process.platform !== 'win32') assert.equal(fs.statSync(statePath).mode & 0o777, 0o600, '任务状态必须是私有文件');

const retrySnapshot = store.prepareRetry(run.run_id, [snapshot.items[1].image_id]);
assert.equal(retrySnapshot.items.length, 1);
assert.match(retrySnapshot.target_id, /^screenshot-retry:/);
store.beginRetry(run.run_id, [snapshot.items[1].image_id]);
const retryRead = {
  file: snapshot.items[1].source_path,
  page_type: 'detail',
  skipped: false,
  name: '李四',
  facts: { degree: '本科' },
  candidate_group_index: 0,
};
store.recordSettled(run.run_id, snapshot.items[1].image_id, retryRead);
store.finalize(run.run_id, { reads: [retryRead] }, [snapshot.items[1].image_id]);
publicState = publicScreenshotAiState(store.requireRun(run.run_id));
assert.equal(publicState.failed_count, 0);
assert.equal(publicState.succeeded_count, 2);
assert.equal(publicScreenshotAiState(store.requireRun(run.run_id), {
  progress: { run_id: run.run_id, status: 'running', stage: 'staging_review' },
}).status, 'running', '读图完成不等于草稿暂存完成');
assert.equal(publicScreenshotAiState(store.requireRun(run.run_id), {
  progress: { run_id: run.run_id, status: 'done', result: { pending_review: 2 } },
}).pending_review_count, 2);

const interruptedPath = path.join(tmp, 'private', 'interrupted.json');
const interruptedStore = new ScreenshotAiImportStateStore({ statePath: interruptedPath, idFactory: () => 'run-interrupted' });
interruptedStore.create(snapshot, connection);
const recovered = interruptedStore.recoverInterrupted();
assert.equal(recovered.status, 'done');
assert.equal(recovered.outcome, 'completed_with_issues');
assert.ok(recovered.items.every((item) => item.error_code === 'SCREENSHOT_AI_INTERRUPTED'));

console.log(JSON.stringify({
  ok: true,
  contract: 'SCREENSHOT-AI-IMPORT-STATE-001',
  persistent_per_image_state: true,
  safe_public_problem_list: true,
  retry_failed_and_unrecognized_items: true,
  interrupted_run_recovered: true,
  approved_bytes_reused_and_source_drift_blocked: true,
  network: 'not-used',
}));
