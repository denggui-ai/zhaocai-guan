const ACTIVE_SCREENSHOT_TASK_STATUSES = new Set([
  'queued',
  'starting',
  'running',
  'recognizing',
  'processing',
  'staging',
  'staging_review',
  'retrying',
]);

const DONE_SCREENSHOT_TASK_STATUSES = new Set([
  'done',
  'complete',
  'completed',
  'success',
  'succeeded',
  'partial',
  'partial_success',
  'completed_with_failures',
]);

const ERROR_SCREENSHOT_TASK_STATUSES = new Set([
  'error',
  'failed',
  'hard_stopped',
  'interrupted',
]);

function countValue(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return Math.floor(number);
  }
  return 0;
}

function optionalNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function canonicalStatus(value) {
  const raw = String(value || 'idle').trim().toLowerCase();
  if (ACTIVE_SCREENSHOT_TASK_STATUSES.has(raw)) return 'running';
  if (DONE_SCREENSHOT_TASK_STATUSES.has(raw)) return 'done';
  if (ERROR_SCREENSHOT_TASK_STATUSES.has(raw)) return 'error';
  return raw || 'idle';
}

function basename(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.split(/[\\/]/).filter(Boolean).pop() || text;
}

function issueItem(item, kind, index) {
  const row = item && typeof item === 'object' ? item : { file_name: item };
  const idValue = row.item_id ?? row.image_id ?? row.id ?? row.file_id ?? row.retry_id ?? '';
  const id = idValue === null || idValue === undefined ? '' : String(idValue);
  const fileName = basename(row.file_name || row.filename || row.source_file || row.file || row.path)
    || (Number.isFinite(Number(row.ordinal)) && Number(row.ordinal) > 0
      ? `第 ${Number(row.ordinal)} 张截图`
      : `${kind === 'failed' ? '失败项' : '未识别项'} ${index + 1}`);
  return {
    ...row,
    id,
    kind,
    fileName,
    reason: String(row.reason || row.error || row.message || row.error_code
      || (kind === 'failed' ? '识别调用失败' : '未识别为候选人详情页')),
    retryable: row.retryable !== false && Boolean(id),
  };
}

function issueRows(task, kind) {
  const result = task.result && typeof task.result === 'object' ? task.result : {};
  const nestedItems = task.items && typeof task.items === 'object' ? task.items : {};
  const resultItems = result.items && typeof result.items === 'object' ? result.items : {};
  const flatTaskItems = Array.isArray(task.items)
    ? task.items.filter((item) => String(item?.status || '').toLowerCase() === kind)
    : null;
  const flatResultItems = Array.isArray(result.items)
    ? result.items.filter((item) => String(item?.status || '').toLowerCase() === kind)
    : null;
  const aliases = kind === 'failed'
    ? [flatTaskItems, flatResultItems, nestedItems.failed, resultItems.failed, task.failed_items, result.failed_items]
    : [flatTaskItems, flatResultItems, nestedItems.unrecognized, resultItems.unrecognized, task.unrecognized_items, result.unrecognized_items];
  const rows = aliases.find((value) => Array.isArray(value) && value.length > 0)
    || aliases.find(Array.isArray)
    || [];
  return rows.map((item, index) => issueItem(item, kind, index));
}

export function normalizeScreenshotImportTask(input) {
  const task = input && typeof input === 'object' ? input : {};
  const result = task.result && typeof task.result === 'object' ? task.result : {};
  const counts = task.counts && typeof task.counts === 'object' ? task.counts : {};
  const summary = task.summary && typeof task.summary === 'object' ? task.summary : {};
  const rawProgress = task.progress && typeof task.progress === 'object' ? task.progress : {};
  const status = canonicalStatus(task.status);
  const hasProcessingPending = [
    counts.processing_pending,
    counts.processing_pending_count,
    counts.pending_count,
    task.processing_pending,
    task.pending_count,
  ].some((value) => value !== null && value !== undefined && value !== '');
  const hasPendingReview = task.pending_review_known !== false && [
    counts.pendingReview,
    counts.pending_review,
    counts.pending_review_count,
    summary.pending_review,
    task.pending_review,
    task.pending_review_count,
    result.pending_review,
    result.pending_review_count,
  ].some((value) => value !== null && value !== undefined && value !== '');
  const hasRecognizedImages = [
    counts.recognized,
    counts.recognized_count,
    counts.recognized_image_count,
    counts.succeeded_count,
    task.recognized_count,
    task.recognized_image_count,
    task.succeeded_count,
    result.recognized_count,
    result.recognized_image_count,
    result.succeeded_count,
  ].some((value) => value !== null && value !== undefined && value !== '');
  const normalizedCounts = {
    input: countValue(
      counts.input,
      counts.input_count,
      counts.image_count,
      counts.total,
      summary.image_count,
      task.input_count,
      task.image_count,
      result.image_count,
      rawProgress.total,
      task.ocr_total,
    ),
    recognized: countValue(
      counts.recognized,
      counts.recognized_count,
      counts.recognized_image_count,
      counts.succeeded_count,
      task.recognized_count,
      task.recognized_image_count,
      task.succeeded_count,
      result.recognized_count,
      result.recognized_image_count,
      result.succeeded_count,
    ),
    drafts: countValue(
      counts.drafts,
      counts.detail_draft_count,
      summary.detail_draft_count,
      task.detail_draft_count,
      result.detail_draft_count,
      result.total,
    ),
    pendingReview: countValue(
      counts.pendingReview,
      counts.pending_review,
      counts.pending_review_count,
      summary.pending_review,
      task.pending_review,
      task.pending_review_count,
      result.pending_review,
      result.pending_review_count,
    ),
    processingPending: countValue(
      counts.processingPending,
      counts.processing_pending,
      counts.processing_pending_count,
      counts.pending_count,
      task.processing_pending,
      task.pending_count,
    ),
    unrecognized: countValue(
      counts.unrecognized,
      counts.unrecognized_count,
      summary.unrecognized_count,
      task.unrecognized_count,
      result.unrecognized_count,
    ),
    failed: countValue(
      counts.failed,
      counts.failed_count,
      summary.failed_count,
      task.failed_count,
      result.failed_count,
    ),
    skipped: countValue(
      counts.skipped,
      counts.skipped_count,
      counts.skipped_list,
      counts.skipped_list_count,
      summary.skipped_list_count,
      task.skipped_list_count,
      result.skipped_list_count,
    ),
    retryable: countValue(
      counts.retryable,
      counts.retryable_count,
      task.retryable_count,
      result.retryable_count,
    ),
  };
  if (!hasRecognizedImages && status === 'done' && normalizedCounts.input > 0) {
    normalizedCounts.recognized = Math.max(
      0,
      normalizedCounts.input
        - normalizedCounts.skipped
        - normalizedCounts.unrecognized
        - normalizedCounts.failed,
    );
  }
  const total = optionalNumber(rawProgress.total, task.ocr_total, normalizedCounts.input) || 0;
  let done = optionalNumber(
    rawProgress.done,
    task.processed_count,
    task.ocr_done,
    counts.processed_count,
  );
  if (done === null && hasProcessingPending && total > 0) {
    done = Math.max(0, total - normalizedCounts.processingPending);
  }
  if (done === null && total > 0) {
    const settled = normalizedCounts.recognized
      + normalizedCounts.skipped
      + normalizedCounts.unrecognized
      + normalizedCounts.failed;
    if (settled > 0) done = Math.min(settled, total);
  }
  if (done === null && status === 'done') done = total;
  if (done === null) done = 0;
  done = total > 0 ? Math.min(done, total) : done;
  const explicitPercent = optionalNumber(rawProgress.percent, task.percent);
  const percent = Math.max(0, Math.min(100, explicitPercent === null
    ? (total > 0 ? Math.round(done * 100 / total) : (status === 'done' ? 100 : 0))
    : explicitPercent));
  const unrecognized = issueRows(task, 'unrecognized');
  const failed = issueRows(task, 'failed');
  const taskId = task.task_id ?? task.id ?? task.run_id ?? '';
  const engine = String(task.engine || task.recognition_engine || result.engine || '').trim();

  return {
    ...task,
    task_id: taskId === null || taskId === undefined ? '' : String(taskId),
    raw_status: String(task.status || 'idle'),
    status,
    engine,
    pending_review_known: hasPendingReview,
    counts: normalizedCounts,
    progress: { done, total, percent },
    items: { unrecognized, failed },
    image_count: normalizedCounts.input,
    detail_draft_count: normalizedCounts.drafts,
    ocr_done: done,
    ocr_total: total,
    result: {
      ...result,
      pending_review: normalizedCounts.pendingReview,
      processing_pending: normalizedCounts.processingPending,
      unrecognized_count: normalizedCounts.unrecognized,
      failed_count: normalizedCounts.failed,
      skipped_list_count: normalizedCounts.skipped,
    },
  };
}

export function isScreenshotImportTaskActive(task) {
  return normalizeScreenshotImportTask(task).status === 'running';
}

export function screenshotImportTaskIssueCount(task) {
  const { counts } = normalizeScreenshotImportTask(task);
  return counts.unrecognized + counts.failed;
}

export function screenshotImportTaskNeedsAttention(task) {
  const normalized = normalizeScreenshotImportTask(task);
  return normalized.status === 'error'
    || normalized.counts.unrecognized > 0
    || normalized.counts.failed > 0;
}

export function screenshotImportTaskUsesExternalAi(task, items = []) {
  const normalized = normalizeScreenshotImportTask(task);
  if (normalized.requires_external_ai === true || normalized.retry_requires_external_ai === true) return true;
  if (String(normalized.engine).toLowerCase().includes('external_ai')) return true;
  return items.some((item) => item?.requires_external_ai === true || String(item?.engine || '').toLowerCase().includes('external_ai'));
}
