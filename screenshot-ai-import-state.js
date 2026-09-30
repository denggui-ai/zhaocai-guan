'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { durableAtomicWriteFile } = require('./durable-atomic-file');
const { ensurePrivateDir, ensurePrivateFile } = require('./secure-fs');

const SCHEMA_VERSION = 'screenshot_ai_import_state_v1';
const SCREENSHOT_IMPORT_PURPOSE = 'screenshot-import';
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function imageFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_EXTS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans', { numeric: true }));
}

function snapshotItem(file, ordinal) {
  const bytes = fs.readFileSync(file);
  const sourceSha256 = sha256Bytes(bytes);
  return {
    image_id: `image-${String(ordinal).padStart(3, '0')}-${sourceSha256.slice(0, 12)}`,
    ordinal,
    source_path: path.resolve(file),
    source_name: path.basename(file),
    extension: path.extname(file).toLowerCase(),
    size_bytes: bytes.length,
    source_sha256: sourceSha256,
  };
}

function materialForItems(items, scope = 'initial') {
  return sha256Bytes(Buffer.from(stableJson({
    schema_version: SCHEMA_VERSION,
    scope,
    images: items.map((item) => ({
      ordinal: item.ordinal,
      source_name: item.source_name,
      extension: item.extension,
      size_bytes: item.size_bytes,
      source_sha256: item.source_sha256,
    })),
  }), 'utf8'));
}

function prepareScreenshotAiBatch(dir) {
  const resolved = path.resolve(dir);
  const names = imageFiles(resolved);
  if (!names.length) throw new Error('文件夹里没有 PNG/JPG/WebP 截图。');
  const items = names.map((name, index) => snapshotItem(path.join(resolved, name), index + 1));
  const materialSha256 = materialForItems(items);
  return {
    source_dir: resolved,
    source_dir_name: path.basename(resolved),
    items,
    material_sha256: materialSha256,
    target_id: `screenshot-import:${materialSha256.slice(0, 32)}`,
  };
}

function assertConnection(connection = {}) {
  const provider = String(connection.provider || '').trim();
  const baseUrl = String(connection.baseUrl || connection.base_url || '').trim();
  const model = String(connection.model || '').trim();
  if (!provider || !baseUrl || !model) throw new Error('外部 AI 连接信息不完整。');
  return { provider, base_url: baseUrl, model };
}

function extensionCounts(items) {
  const counts = {};
  for (const item of items) {
    const label = item.extension.replace(/^\./, '').toUpperCase() || 'IMAGE';
    counts[label] = (counts[label] || 0) + 1;
  }
  return counts;
}

function safeDisplayFileName(value) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, '�').trim();
  return text.length > 180 ? `${text.slice(0, 177)}…` : text;
}

function publicApprovalPreview(snapshot, connection, options = {}) {
  const bound = assertConnection(connection);
  return {
    requires_external_ai: true,
    purpose: options.purpose || SCREENSHOT_IMPORT_PURPOSE,
    operation: options.operation || 'initial_import',
    targetId: snapshot.target_id,
    materialHash: snapshot.material_sha256,
    imageCount: snapshot.items.length,
    totalBytes: snapshot.items.reduce((sum, item) => sum + item.size_bytes, 0),
    extensionCounts: extensionCounts(snapshot.items),
    items: snapshot.items.map((item) => ({
      image_id: item.image_id,
      ordinal: item.ordinal,
      fileName: safeDisplayFileName(item.source_name),
      sizeBytes: item.size_bytes,
      contentHashPrefix: item.source_sha256.slice(0, 12),
      ...(Array.isArray(item.weak_fields) ? { fieldKeys: item.weak_fields } : {}),
    })),
    provider: bound.provider,
    baseUrl: bound.base_url,
    model: bound.model,
  };
}

function classifyRead(read) {
  if (!read || read.failed) return {
    status: 'failed',
    error_code: read && read.error_code === 'SCREENSHOT_SOURCE_CHANGED'
      ? 'SCREENSHOT_SOURCE_CHANGED'
      : 'SCREENSHOT_AI_READ_FAILED',
  };
  if (read.skipped && read.page_type === 'list') return { status: 'skipped_list', error_code: null };
  if (read.skipped || !Number.isInteger(read.candidate_group_index)) {
    return { status: 'unrecognized', error_code: 'SCREENSHOT_AI_UNRECOGNIZED' };
  }
  return { status: 'succeeded', error_code: null };
}

function assertApprovedScreenshotInput(item, input) {
  const match = input && typeof input.dataUri === 'string'
    ? input.dataUri.match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/)
    : null;
  if (!item || !match) throw new Error('截图外发材料格式无法核验。');
  const bytes = Buffer.from(match[1], 'base64');
  const actualHash = sha256Bytes(bytes);
  if (bytes.length !== Number(item.size_bytes) || actualHash !== String(item.source_sha256 || '')) {
    const error = new Error('批准后截图内容已变化，已阻止该图外发。');
    error.code = 'SCREENSHOT_SOURCE_CHANGED';
    throw error;
  }
  return true;
}

function retryableItem(item) {
  return item && (item.status === 'unrecognized'
    || (item.status === 'failed' && item.error_code !== 'SCREENSHOT_SOURCE_CHANGED'));
}

class ScreenshotAiImportStateStore {
  constructor(options = {}) {
    const dataDir = path.resolve(options.dataDir || process.env.HRBOSS_DATA_DIR || path.join(__dirname, 'data'));
    this.statePath = path.resolve(options.statePath || path.join(dataDir, 'import', 'screenshot-ai-import-state.json'));
    this.clock = options.clock || (() => new Date());
    this.idFactory = options.idFactory || (() => crypto.randomUUID());
  }

  now() { return this.clock().toISOString(); }

  read() {
    if (!fs.existsSync(this.statePath)) return null;
    ensurePrivateFile(this.statePath);
    const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    if (!state || state.schema_version !== SCHEMA_VERSION) throw new Error('截图 AI 任务状态格式无效。');
    return state;
  }

  requireRun(runId) {
    const state = this.read();
    if (!state || state.run_id !== String(runId || '')) throw new Error('截图 AI 任务不存在。');
    return state;
  }

  write(state) {
    state.updated_at = this.now();
    ensurePrivateDir(path.dirname(this.statePath));
    durableAtomicWriteFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    ensurePrivateFile(this.statePath);
    return state;
  }

  create(snapshot, connection) {
    const now = this.now();
    const state = {
      schema_version: SCHEMA_VERSION,
      run_id: this.idFactory(),
      status: 'running',
      phase: 'recognizing',
      source_dir: snapshot.source_dir,
      source_dir_name: snapshot.source_dir_name,
      material_sha256: snapshot.material_sha256,
      target_id: snapshot.target_id,
      connection: assertConnection(connection),
      created_at: now,
      updated_at: now,
      finished_at: null,
      items: snapshot.items.map((item) => ({
        ...item,
        status: 'pending',
        attempts: 0,
        error_code: null,
        read: null,
      })),
    };
    return this.write(state);
  }

  recoverInterrupted() {
    const state = this.read();
    if (!state || !['running', 'retrying'].includes(state.status)) return state;
    state.items.forEach((item) => {
      if (!['pending', 'read_complete'].includes(item.status)) return;
      item.status = 'failed';
      item.error_code = 'SCREENSHOT_AI_INTERRUPTED';
    });
    state.status = 'done';
    state.outcome = 'completed_with_issues';
    state.phase = 'complete';
    state.finished_at = this.now();
    return this.write(state);
  }

  failRun(runId, errorCode = 'SCREENSHOT_AI_BATCH_FAILED') {
    const state = this.requireRun(runId);
    state.items.forEach((item) => {
      if (!['pending', 'read_complete'].includes(item.status)) return;
      item.status = 'failed';
      item.error_code = errorCode;
    });
    state.status = 'done';
    state.outcome = 'completed_with_issues';
    state.phase = 'complete';
    state.finished_at = this.now();
    return this.write(state);
  }

  recordSettled(runId, imageId, read) {
    const state = this.requireRun(runId);
    const item = state.items.find((candidate) => candidate.image_id === String(imageId || ''));
    if (!item) throw new Error('截图 AI 任务项不存在。');
    item.attempts += 1;
    item.status = 'read_complete';
    item.error_code = read && read.failed ? 'SCREENSHOT_AI_READ_FAILED' : null;
    item.read = read || null;
    return this.write(state);
  }

  finalize(runId, result, selectedImageIds = null) {
    const state = this.requireRun(runId);
    const selected = selectedImageIds ? new Set(selectedImageIds) : null;
    const readsByPath = new Map((result.reads || []).map((read) => [path.resolve(read.file), read]));
    state.items.forEach((item) => {
      if (selected && !selected.has(item.image_id)) return;
      const read = readsByPath.get(path.resolve(item.source_path)) || item.read;
      const outcome = classifyRead(read);
      item.status = outcome.status;
      item.error_code = outcome.error_code;
      item.read = read || null;
    });
    const hasIssues = state.items.some((item) => ['failed', 'unrecognized'].includes(item.status));
    state.status = 'done';
    state.outcome = hasIssues ? 'completed_with_issues' : 'completed';
    state.phase = 'complete';
    state.detail_draft_count = Number(result.summary && result.summary.detail_draft_count) || 0;
    state.finished_at = this.now();
    return this.write(state);
  }

  prepareRetry(runId, requestedIds) {
    const state = this.requireRun(runId);
    if (state.status === 'running' || state.status === 'retrying') throw new Error('截图 AI 任务正在运行。');
    if (requestedIds != null && !Array.isArray(requestedIds)) throw new Error('item_ids 必须是数组。');
    const requested = Array.isArray(requestedIds) && requestedIds.length ? new Set(requestedIds.map(String)) : null;
    const items = state.items.filter((item) => retryableItem(item)
      && (!requested || requested.has(item.image_id)));
    if (!items.length) throw new Error('没有可重试的失败或未识别截图。');
    if (requested && items.length !== requested.size) throw new Error('重试项包含不存在或非可重试状态的截图。');
    const current = items.map((item) => snapshotItem(item.source_path, item.ordinal));
    current.forEach((item, index) => {
      if (item.source_sha256 !== items[index].source_sha256 || item.size_bytes !== items[index].size_bytes) {
        throw new Error('截图内容已变化，请重新选择文件夹并授权。');
      }
      item.image_id = items[index].image_id;
    });
    const materialSha256 = materialForItems(current, `retry:${state.run_id}`);
    return {
      run_id: state.run_id,
      source_dir: state.source_dir,
      source_dir_name: state.source_dir_name,
      items: current,
      material_sha256: materialSha256,
      target_id: `screenshot-retry:${state.run_id}:${materialSha256.slice(0, 24)}`,
    };
  }

  beginRetry(runId, imageIds, connection = null) {
    const state = this.requireRun(runId);
    const selected = new Set(imageIds);
    state.status = 'retrying';
    state.phase = 'recognizing';
    state.finished_at = null;
    if (connection) state.connection = assertConnection(connection);
    state.items.forEach((item) => {
      if (!selected.has(item.image_id)) return;
      item.status = 'pending';
      item.error_code = null;
      item.read = null;
    });
    return this.write(state);
  }
}

function publicScreenshotAiState(state, options = {}) {
  if (!state) return null;
  const counts = Object.fromEntries([
    'pending', 'read_complete', 'succeeded', 'skipped_list', 'unrecognized', 'failed',
  ].map((status) => [status, state.items.filter((item) => item.status === status).length]));
  const publicItem = (item) => ({
    image_id: item.image_id,
    ordinal: item.ordinal,
    status: item.status,
    attempts: item.attempts,
    error_code: item.error_code,
    retryable: retryableItem(item),
  });
  const failedItems = state.items.filter((item) => item.status === 'failed').map(publicItem);
  const unrecognizedItems = state.items.filter((item) => item.status === 'unrecognized').map(publicItem);
  const progress = options.progress && typeof options.progress === 'object' ? options.progress : null;
  const matchingProgress = progress && progress.run_id === state.run_id ? progress : null;
  const pendingReviewCount = matchingProgress && matchingProgress.result
    && Number.isFinite(Number(matchingProgress.result.pending_review))
    ? Number(matchingProgress.result.pending_review)
    : null;
  const detailDraftCount = Number.isFinite(Number(state.detail_draft_count))
    ? Number(state.detail_draft_count)
    : 0;
  const countPayload = {
    image_count: state.items.length,
    pending_count: counts.pending,
    processing_image_count: counts.pending,
    processed_count: state.items.length - counts.pending,
    recognized_image_count: counts.succeeded,
    succeeded_count: counts.succeeded,
    skipped_list_count: counts.skipped_list,
    unrecognized_count: counts.unrecognized,
    failed_count: counts.failed,
    retryable_count: state.items.filter(retryableItem).length,
    detail_draft_count: detailDraftCount,
    pending_review_count: pendingReviewCount,
  };
  const progressStatus = matchingProgress ? String(matchingProgress.status || '') : '';
  const overallStatus = progressStatus === 'error' ? 'error'
    : (matchingProgress && !['done', 'error', 'idle'].includes(progressStatus))
      || ['running', 'retrying'].includes(state.status) ? 'running' : 'done';
  return {
    run_id: state.run_id,
    engine: 'external_ai',
    status: overallStatus,
    outcome: overallStatus === 'done' ? (state.outcome || 'completed') : null,
    phase: state.phase,
    ...countPayload,
    counts: countPayload,
    items: [...failedItems, ...unrecognizedItems].sort((a, b) => a.ordinal - b.ordinal),
    failed_items: failedItems,
    unrecognized_items: unrecognizedItems,
    result: {
      detail_draft_count: detailDraftCount,
      pending_review_count: pendingReviewCount,
    },
    created_at: state.created_at,
    updated_at: state.updated_at,
    finished_at: state.finished_at,
  };
}

module.exports = {
  SCHEMA_VERSION,
  SCREENSHOT_IMPORT_PURPOSE,
  ScreenshotAiImportStateStore,
  assertApprovedScreenshotInput,
  classifyRead,
  materialForItems,
  prepareScreenshotAiBatch,
  publicApprovalPreview,
  publicScreenshotAiState,
};
