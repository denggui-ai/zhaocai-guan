'use strict';

const assert = require('assert');
const path = require('path');
const {
  TOKEN_TTL_MS,
  consumeAssessmentFileSelection,
  issueAssessmentFileSelection,
} = require('./assessment-file-selection');

const secret = 'synthetic-assessment-selection-secret-'.repeat(2);
const now = Date.parse('2026-07-12T12:00:00.000Z');
const binding = {
  source_path: path.resolve('/synthetic-only/assessment.pdf'),
  candidate_id: 'C-SYNTHETIC-1',
  job_id: 1,
  report_type: 'career_potential',
  assessment_date: '2026-07-01',
  request_id: 'REQ-ASSESSMENT-IMPORT-1',
};

const token = issueAssessmentFileSelection(secret, binding, { now });
const consumed = new Set();
const result = consumeAssessmentFileSelection(secret, token, binding, consumed, { now: now + 1000 });
assert.equal(result.source_path, binding.source_path);
assert.equal(result.candidate_id, binding.candidate_id);
assert.equal(result.job_id, binding.job_id);
assert.equal(Object.hasOwn(result, 'actor'), false);
assert.throws(
  () => consumeAssessmentFileSelection(secret, token, binding, consumed, { now: now + 2000 }),
  (error) => error.code === 'ASSESSMENT_SELECTION_REPLAYED',
);

const wrongTarget = issueAssessmentFileSelection(secret, binding, { now });
assert.throws(
  () => consumeAssessmentFileSelection(secret, wrongTarget, { ...binding, candidate_id: 'C-SYNTHETIC-2' }, new Set(), { now }),
  (error) => error.code === 'ASSESSMENT_SELECTION_INVALID',
);
const expired = issueAssessmentFileSelection(secret, binding, { now });
assert.throws(
  () => consumeAssessmentFileSelection(secret, expired, binding, new Set(), { now: now + TOKEN_TTL_MS + 1 }),
  (error) => error.code === 'ASSESSMENT_SELECTION_INVALID',
);
const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
assert.throws(
  () => consumeAssessmentFileSelection(secret, tampered, binding, new Set(), { now }),
  (error) => error.code === 'ASSESSMENT_SELECTION_INVALID',
);
assert.throws(
  () => issueAssessmentFileSelection('short', binding, { now }),
  (error) => error.code === 'ASSESSMENT_SELECTION_SECRET_INVALID',
);
assert.throws(
  () => issueAssessmentFileSelection(secret, { ...binding, source_path: 'relative.pdf' }, { now }),
  (error) => error.code === 'ASSESSMENT_SELECTION_PATH_INVALID',
);
assert.throws(
  () => issueAssessmentFileSelection(secret, { ...binding, report_type: 'personality_score' }, { now }),
  (error) => error.code === 'ASSESSMENT_SELECTION_BINDING_INVALID',
);
assert.throws(
  () => issueAssessmentFileSelection(secret, { ...binding, assessment_date: '2026-02-31' }, { now }),
  (error) => error.code === 'ASSESSMENT_SELECTION_BINDING_INVALID',
);

console.log('check-assessment-file-selection ok');
