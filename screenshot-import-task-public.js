'use strict';

const ACTIVE_SCREENSHOT_PROGRESS_STATUSES = new Set([
  'running', 'waiting_login', 'awaiting_manual_city', 'staging', 'ingesting', 'stopping',
]);

function recoverInterruptedLegacyScreenshotProgress(progress = {}, options = {}) {
  if (!ACTIVE_SCREENSHOT_PROGRESS_STATUSES.has(String(progress.status || ''))) return progress;
  const at = options.at || new Date().toISOString();
  const retryableAiRead = options.aiWasActive === true;
  return {
    ...progress,
    status: 'error',
    stage: 'error',
    message: retryableAiRead
      ? '上次截图 AI 读取因应用中断而停止，可在失败项中重试。'
      : '上次截图导入在草稿暂存前中断，请检查待校对列表后重新发起导入。',
    error: '上次截图导入已中断。',
    finished_at: at,
  };
}

function legacyScreenshotTask(progress = {}) {
  const imageCount = Number(progress.image_count) || Number(progress.result && progress.result.image_count) || 0;
  const processed = Number.isFinite(Number(progress.ocr_done)) ? Math.min(imageCount, Number(progress.ocr_done)) : 0;
  const pendingReview = progress.result ? Number(progress.result.pending_review) || 0 : null;
  const detailDraftCount = Number(progress.detail_draft_count)
    || Number(progress.result && progress.result.total)
    || 0;
  const terminalStatus = progress.status === 'error' ? 'error'
    : progress.status === 'done' ? 'done'
      : progress.status === 'idle' ? 'idle' : 'running';
  const items = Array.isArray(progress.unrecognized_items) ? progress.unrecognized_items : [];
  const skippedListCount = Number(progress.result && progress.result.skipped_list_count) || 0;
  const unrecognizedCount = items.length || Number(progress.result && progress.result.unrecognized_count) || 0;
  const failedCount = Number(progress.result && progress.result.failed_count)
    || Number(progress.failed_count)
    || (progress.status === 'error' ? 1 : 0);
  const counts = {
    image_count: imageCount,
    pending_count: Math.max(0, imageCount - processed),
    processing_image_count: Math.max(0, imageCount - processed),
    processed_count: processed,
    recognized_image_count: Math.max(0, imageCount - skippedListCount - unrecognizedCount - failedCount),
    skipped_list_count: skippedListCount,
    unrecognized_count: unrecognizedCount,
    failed_count: failedCount,
    retryable_count: 0,
    detail_draft_count: detailDraftCount,
    pending_review_count: pendingReview,
  };
  return {
    run_id: progress.run_id || null,
    engine: 'macos_vision',
    status: terminalStatus,
    outcome: terminalStatus === 'done' ? (unrecognizedCount || failedCount ? 'completed_with_issues' : 'completed') : null,
    phase: progress.stage || null,
    ...counts,
    counts,
    items,
    failed_items: [],
    unrecognized_items: items,
    result: { detail_draft_count: detailDraftCount, pending_review_count: pendingReview },
    created_at: progress.started_at || null,
    updated_at: progress.updated_at || null,
    finished_at: progress.finished_at || null,
  };
}

module.exports = { legacyScreenshotTask, recoverInterruptedLegacyScreenshotProgress };
