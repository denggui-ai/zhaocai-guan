'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  legacyScreenshotTask,
  recoverInterruptedLegacyScreenshotProgress,
} = require('./screenshot-import-task-public');

const task = legacyScreenshotTask({
  status: 'done',
  stage: 'done',
  run_id: 'screenshot-local-synthetic',
  image_count: 10,
  ocr_done: 10,
  ocr_total: 10,
  detail_draft_count: 4,
  unrecognized_items: [{ image_id: 'local-unrecognized-1', ordinal: 9, status: 'unrecognized', retryable: false }],
  result: {
    image_count: 10,
    skipped_list_count: 2,
    unrecognized_count: 1,
    failed_count: 1,
    pending_review: 4,
    total: 4,
  },
});
assert.equal(task.status, 'done');
assert.equal(task.engine, 'macos_vision');
assert.equal(task.counts.processed_count, 10);
assert.equal(task.counts.recognized_image_count, 6, '成功图片数必须扣除列表页、未识别和失败项');
assert.equal(task.counts.detail_draft_count, 4, '候选人组数不得与成功图片数混用');
assert.equal(task.counts.pending_review_count, 4);
assert.equal(task.items[0].retryable, false, 'Mac Vision 未识别项只展示入口，不得伪装为外部 AI 重试');
const actionSource = fs.readFileSync(path.join(__dirname, 'action-server.js'), 'utf8');
const staleStaging = recoverInterruptedLegacyScreenshotProgress({
  status: 'running',
  stage: 'staging_review',
  run_id: 'stale-finalized-ai-child',
  started_at: '2020-01-01T00:00:00.000Z',
}, { aiWasActive: false, at: '2026-08-15T00:00:00.000Z' });
assert.equal(staleStaging.status, 'error', 'stale active child progress must not survive a cold start');
assert.doesNotMatch(staleStaging.message, /失败项中重试/, 'AI 已 finalize 后的 child 中断不得伪称有失败项可重试');
const interruptedAiRead = recoverInterruptedLegacyScreenshotProgress({ status: 'running' }, { aiWasActive: true });
assert.match(interruptedAiRead.message, /失败项中重试/, '只有启动前仍在读图的 AI run 才提示逐项重试');
assert.match(actionSource, /const legacyProgress = screenshotImportProgress\.readProgress\(\);[\s\S]*if \(ACTIVE_PROGRESS_STATUSES\.includes\(legacyProgress\.status\)\)[\s\S]*recoverInterruptedLegacyScreenshotProgress/,
  '冷启动必须统一终止 AI 已 finalize/仍读取或 Mac child 遗留的 active progress');
assert.ok((actionSource.match(/SCREENSHOT_IMPORT_STILL_RUNNING/g) || []).length >= 2,
  'retry preflight 和 retry 执行都必须阻止暂存期并发');
assert.ok((actionSource.match(/failOnPrematureExit: true/g) || []).length >= 2,
  'Mac Vision 与外部 AI 暂存 child 都必须监控异常退出');
const driverSource = fs.readFileSync(path.join(__dirname, 'start-screenshot-import.js'), 'utf8');
assert.match(driverSource, /SCREENSHOT_IMPORT_RUN_SUPERSEDED[\s\S]*assertProgressRunOwnership[\s\S]*current\.run_id === activeProgressRunId/,
  '旧 child 失去 run_id 所有权后必须停止写 progress');

console.log(JSON.stringify({
  ok: true,
  contract: 'SCREENSHOT-TASK-PROJECTION-001',
  processed_and_pending_are_image_counts: true,
  recognized_excludes_list_unrecognized_failed: true,
  candidate_draft_and_review_counts_are_separate: true,
  interrupted_legacy_progress_is_recovered: true,
  retry_blocked_during_staging: true,
  child_exit_and_run_ownership_guarded: true,
  network: 'not-used',
}));
