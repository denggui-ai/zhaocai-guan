'use strict';

const crypto = require('crypto');
const path = require('path');
const { weakFields } = require('./screenshot-field-ai');
const { resolveScreenshotDraftPreview } = require('./screenshot-draft-preview');

function parseJson(value) {
  try { return JSON.parse(value || '{}'); } catch { return {}; }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function prepareScreenshotAiFillBatch(database, jobId) {
  const normalizedJobId = Number(jobId);
  if (!Number.isSafeInteger(normalizedJobId) || normalizedJobId <= 0) throw new Error('job_id required。');
  const rows = database.prepare(`
    SELECT id, current_json, field_evidence_json
    FROM screenshot_ocr_draft
    WHERE status = 'pending_review' AND job_id = ?
    ORDER BY id
  `).all(normalizedJobId);
  const items = [];
  for (const row of rows) {
    const current = parseJson(row.current_json);
    const evidence = parseJson(row.field_evidence_json);
    const fields = weakFields(current.facts || {}, evidence || {});
    if (!fields.length) continue;
    const preview = resolveScreenshotDraftPreview(database, row.id);
    const bytes = preview.bytes;
    const sourceSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const sourceName = path.basename(String(Array.isArray(current.files) ? current.files[0] || '' : ''));
    items.push({
      image_id: `draft-${row.id}-${sourceSha256.slice(0, 12)}`,
      ordinal: items.length + 1,
      draft_id: row.id,
      source_name: sourceName,
      extension: path.extname(sourceName).toLowerCase(),
      size_bytes: bytes.length,
      source_sha256: sourceSha256,
      weak_fields: [...fields].sort(),
    });
  }
  if (!items.length) throw new Error('当前岗位没有可外部 AI 补全的待校对截图草稿。');
  const materialSha256 = crypto.createHash('sha256').update(stableJson({
    schema_version: 'screenshot_ai_fill_material_v1',
    job_id: normalizedJobId,
    items: items.map((item) => ({
      draft_id: item.draft_id,
      source_name: item.source_name,
      size_bytes: item.size_bytes,
      source_sha256: item.source_sha256,
      weak_fields: item.weak_fields,
    })),
  }), 'utf8').digest('hex');
  return {
    job_id: normalizedJobId,
    items,
    material_sha256: materialSha256,
    target_id: `screenshot-ai-fill:${normalizedJobId}:${materialSha256.slice(0, 24)}`,
  };
}

module.exports = { prepareScreenshotAiFillBatch };
