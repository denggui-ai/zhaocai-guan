'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const panelPath = path.join(__dirname, 'frontend/src/components/InterviewReviewPanel.jsx');
const panel = fs.readFileSync(panelPath, 'utf8');

const helperStart = panel.indexOf('const INTERVIEW_FORMAT_PRESENTATION');
const helperEnd = panel.indexOf('\n\nfunction pick(', helperStart);
assert.notEqual(helperStart, -1, 'InterviewReview must define one shared interview-format presentation map');
assert.notEqual(helperEnd, -1, 'InterviewReview must keep the interview-format helper independently testable');

const helperSource = panel
  .slice(helperStart, helperEnd)
  .replace('const INTERVIEW_FORMAT_PRESENTATION', 'var INTERVIEW_FORMAT_PRESENTATION');

function present(input) {
  const context = { input, result: null };
  vm.runInNewContext(`${helperSource}\nresult = sessionInterviewFormat(input);`, context);
  return { value: context.result.value, label: context.result.label, color: context.result.color };
}

assert.deepEqual(present({ interview_format: 'online', mode: 'offline' }), { value: 'online', label: '线上', color: 'blue' });
assert.deepEqual(present({ interview_format: 'offline', mode: 'online' }), { value: 'offline', label: '线下', color: 'cyan' });
assert.deepEqual(present({ interview_format: 'phone', mode: 'offline' }), { value: 'phone', label: '电话', color: 'purple' });
assert.deepEqual(present({ mode: 'online' }), { value: 'online', label: '线上', color: 'blue' });
assert.deepEqual(present({ mode: 'offline' }), { value: 'offline', label: '线下', color: 'cyan' });
assert.deepEqual(present({ interview_format: 'unexpected', mode: 'online' }), { value: '', label: '未登记', color: 'default' }, 'a present but invalid canonical value must not silently fall back to legacy mode');

assert.equal(
  (panel.match(/const interviewFormat = sessionInterviewFormat\(session\);/g) || []).length,
  2,
  'both session-only reports and linked-recording timeline items must use the shared format truth',
);
assert.doesNotMatch(panel, /session\.mode\s*===\s*['"]online['"]/, 'Review must not classify session logistics directly from legacy mode');
assert.match(panel, /interviewFormat\.label}\u9762\u8bd5/, 'session-only report title and tag must render the canonical label');
assert.match(panel, /material\.source_type === 'lark_minutes' \? '线上妙记' : '线下录音'/, 'material-source labels must remain based on source_type, not session logistics');
assert.match(panel, /interview_recording_id/, 'legacy F007 recording linkage must remain intact');

console.log(JSON.stringify({
  ok: true,
  contract: 'INTERVIEW-PHONE-TRUTH-001',
  canonical_formats: ['online', 'offline', 'phone'],
  legacy_fallbacks: ['online', 'offline'],
  phone_legacy_mode: 'offline',
  material_source_truth_unchanged: true,
}));
