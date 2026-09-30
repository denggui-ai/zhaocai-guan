'use strict';

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { resolveSelectedDirectory } = require('./local-directory-selection');

function resolveScreenshotDraftPreview(database, id) {
  const row = database.prepare('SELECT current_json, context_json FROM screenshot_ocr_draft WHERE id = ?').get(Number(id));
  if (!row) {
    const error = new Error('OCR 草稿不存在。');
    error.code = 'SCREENSHOT_DRAFT_NOT_FOUND';
    throw error;
  }
  let current;
  let context;
  try {
    current = JSON.parse(row.current_json || '{}');
    context = JSON.parse(row.context_json || '{}');
  } catch {
    throw new Error('OCR 草稿原图上下文无效。');
  }
  const sourceDir = String(context.source_dir_path || '');
  const fileName = Array.isArray(current.files) ? String(current.files[0] || '') : '';
  if (!sourceDir || !fileName || path.basename(fileName) !== fileName) {
    throw new Error('OCR 草稿没有可安全预览的原图。');
  }
  const extension = path.extname(fileName).toLowerCase();
  const contentTypes = new Map([
    ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
  ]);
  if (!contentTypes.has(extension)) throw new Error('OCR 草稿原图格式不允许预览。');
  const selected = resolveSelectedDirectory(sourceDir, { label: 'OCR 草稿原图目录' });
  const root = fs.realpathSync(selected.path);
  const realFile = fs.realpathSync(path.join(root, fileName));
  const relative = path.relative(root, realFile);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.dirname(relative) !== '.') {
    throw new Error('OCR 草稿原图越出已选目录。');
  }
  const stat = fs.statSync(realFile);
  if (!stat.isFile() || stat.size > 24 * 1024 * 1024) throw new Error('OCR 草稿原图无法安全预览。');
  const derived = context.evidence && context.evidence.derived;
  const expectedHash = derived && Array.isArray(derived.source_hashes) ? String(derived.source_hashes[0] || '') : '';
  const expectedSize = derived && Array.isArray(derived.source_sizes) ? Number(derived.source_sizes[0]) : NaN;
  if (!/^[0-9a-f]{64}$/.test(expectedHash) || !Number.isSafeInteger(expectedSize) || expectedSize < 0) {
    const error = new Error('OCR 草稿缺少可核验的原图内容身份，已拒绝预览。');
    error.code = 'SCREENSHOT_DRAFT_SOURCE_IDENTITY_MISSING';
    throw error;
  }
  const bytes = fs.readFileSync(realFile);
  const actualHash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (stat.size !== expectedSize || actualHash !== expectedHash) {
    const error = new Error('OCR 草稿原图内容已变化，已拒绝预览。');
    error.code = 'SCREENSHOT_DRAFT_SOURCE_CHANGED';
    throw error;
  }
  return { bytes, contentType: contentTypes.get(extension) };
}

module.exports = { resolveScreenshotDraftPreview };
