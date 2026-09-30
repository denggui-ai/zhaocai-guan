'use strict';

const crypto = require('crypto');
const path = require('path');

function clean(value, maximum = 300) {
  return String(value === undefined || value === null ? '' : value).replace(/[\0\r\n]+/g, ' ').trim().slice(0, maximum);
}

function batchRequestId(baseRequestId, index, total) {
  const base = clean(baseRequestId, 128);
  if (!base) throw new Error('assessment batch request_id required');
  if (total === 1) return base;
  const digest = crypto.createHash('sha256').update(`${base}:${index}`).digest('hex').slice(0, 12);
  const suffix = `:pdf-${index + 1}-${digest}`;
  return `${base.slice(0, Math.max(1, 128 - suffix.length))}${suffix}`;
}

function progressPayload(requestId, phase, current, total, succeeded, failed) {
  return Object.freeze({
    request_id: requestId,
    phase,
    current,
    total,
    succeeded,
    failed,
  });
}

async function importAssessmentFileBatch(options = {}) {
  const filePaths = Array.isArray(options.filePaths) ? options.filePaths : [];
  if (!filePaths.length) throw new Error('assessment batch requires at least one selected PDF');
  if (typeof options.issueSelectionToken !== 'function' || typeof options.requestImport !== 'function') {
    throw new Error('assessment batch import dependencies are unavailable');
  }
  const input = options.input && typeof options.input === 'object' ? options.input : {};
  const baseRequestId = clean(input.request_id, 128);
  if (!baseRequestId) throw new Error('assessment batch request_id required');
  const notify = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const items = [];
  let succeeded = 0;
  let failed = 0;

  notify(progressPayload(baseRequestId, 'importing', 0, filePaths.length, 0, 0));
  for (let index = 0; index < filePaths.length; index += 1) {
    const sourcePath = path.resolve(String(filePaths[index] || ''));
    const requestId = batchRequestId(baseRequestId, index, filePaths.length);
    try {
      const binding = {
        source_path: sourcePath,
        candidate_id: input.candidate_id,
        job_id: input.job_id,
        report_type: input.report_type,
        assessment_date: input.assessment_date || null,
        request_id: requestId,
      };
      const selectionToken = options.issueSelectionToken(binding);
      const body = await options.requestImport(binding, selectionToken);
      if (!body || body.ok !== true) {
        const error = new Error(clean(body && body.error) || 'PDF 测评导入失败。');
        error.code = clean(body && body.code, 80) || 'ASSESSMENT_IMPORT_FAILED';
        throw error;
      }
      succeeded += 1;
      items.push(Object.freeze({ index: index + 1, ok: true, result: body.result || null }));
    } catch (error) {
      failed += 1;
      items.push(Object.freeze({
        index: index + 1,
        ok: false,
        code: clean(error && error.code, 80) || 'ASSESSMENT_IMPORT_FAILED',
        error: clean(error && error.message) || 'PDF 测评导入失败。',
      }));
    }
    notify(progressPayload(baseRequestId, 'importing', index + 1, filePaths.length, succeeded, failed));
  }
  notify(progressPayload(baseRequestId, 'complete', filePaths.length, filePaths.length, succeeded, failed));
  return Object.freeze({
    selected_count: filePaths.length,
    succeeded_count: succeeded,
    failed_count: failed,
    items: Object.freeze(items),
  });
}

module.exports = {
  batchRequestId,
  importAssessmentFileBatch,
};
