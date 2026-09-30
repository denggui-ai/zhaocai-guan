'use strict';

const assert = require('assert');
const path = require('path');
const { batchRequestId, importAssessmentFileBatch } = require('./assessment-batch-import');

assert.equal(batchRequestId('REQ-SINGLE', 0, 1), 'REQ-SINGLE');
assert.ok(batchRequestId('R'.repeat(128), 2, 3).length <= 128);
assert.notEqual(batchRequestId('REQ-BATCH', 0, 3), batchRequestId('REQ-BATCH', 1, 3));

async function run() {
  const bindings = [];
  const progress = [];
  const result = await importAssessmentFileBatch({
    filePaths: ['/synthetic/a.pdf', '/synthetic/b.pdf', '/synthetic/c.pdf'],
    input: {
      candidate_id: 'C-SYNTHETIC',
      job_id: 7,
      report_type: 'unknown',
      assessment_date: null,
      request_id: 'REQ-BATCH',
    },
    issueSelectionToken(binding) {
      bindings.push(binding);
      return `token-${binding.request_id}`;
    },
    async requestImport(binding, token) {
      assert.equal(token, `token-${binding.request_id}`);
      if (path.basename(binding.source_path) === 'b.pdf') return { ok: false, code: 'SYNTHETIC_REJECT', error: '合成失败' };
      return { ok: true, result: { report_type: 'career_potential', duplicate: false } };
    },
    onProgress(item) { progress.push(item); },
  });

  assert.equal(result.selected_count, 3);
  assert.equal(result.succeeded_count, 2);
  assert.equal(result.failed_count, 1);
  assert.deepEqual(result.items.map((item) => item.ok), [true, false, true]);
  assert.equal(result.items[1].code, 'SYNTHETIC_REJECT');
  assert.equal(bindings.length, 3);
  assert.equal(new Set(bindings.map((item) => item.request_id)).size, 3);
  assert.ok(bindings.every((item) => path.isAbsolute(item.source_path)));
  assert.equal(progress[0].current, 0);
  assert.equal(progress.at(-1).phase, 'complete');
  assert.equal(progress.at(-1).current, 3);
  assert.doesNotMatch(JSON.stringify(result), /synthetic\/a\.pdf|synthetic\/b\.pdf|synthetic\/c\.pdf/);
  console.log('check-assessment-batch-import ok');
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
