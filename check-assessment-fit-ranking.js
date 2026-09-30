'use strict';

const assert = require('assert');
const {
  assessmentAiRankingEligible,
  attachAssessmentFitSignals,
  buildAssessmentFitSignal,
  compareCandidateDefaultPriority,
  inferCareerCategory,
} = require('./assessment-fit-ranking');

assert.equal(assessmentAiRankingEligible({
  fit_score: 72,
  confidence: 'medium',
  decision_support: { recommendation: 'hold' },
}), true);
assert.equal(assessmentAiRankingEligible({
  fit_score: 92,
  confidence: 'low',
  decision_support: { recommendation: 'advance' },
}), false, 'low-confidence AI score must not affect ranking');
assert.equal(assessmentAiRankingEligible({
  fit_score: 92,
  confidence: 'high',
  decision_support: { recommendation: 'insufficient_evidence' },
}), false, 'insufficient-evidence AI score must not affect ranking');

assert.equal(inferCareerCategory('抖音运营（商品卡/千川投流）'), '市场类');
assert.equal(inferCareerCategory('Java 开发工程师'), '技术类');

const direct = buildAssessmentFitSignal(
  { rec_position: '品牌运营' },
  [
    { report_type: 'career_potential', analysis: { career_matches: [{ category: '市场类', name: '开拓型', percentage: 82 }] } },
    { report_type: 'career_potential', analysis: { career_matches: [{ category: '市场类', name: '开拓型', percentage: 78 }] } },
    { report_type: 'team_role', analysis: { highlights: [{ label: '角色', value: '实施者' }] } },
  ],
);
assert.equal(direct.assessment_fit_score, 80);
assert.equal(direct.assessment_fit_report_count, 2);
assert.equal(direct.assessment_report_count, 3);
assert.equal(direct.assessment_ranking_basis, 'HR已确认职业潜能报告');

const activeReports = [
  { candidate_id: 'C-A', report_type: 'career_potential', analysis_json: JSON.stringify({ career_matches: [{ category: '市场类', name: '开拓型', percentage: 82 }] }) },
  { candidate_id: 'C-A', report_type: 'career_potential', analysis_json: JSON.stringify({ career_matches: [{ category: '市场类', name: '开拓型', percentage: 78 }] }) },
  { candidate_id: 'C-A', report_type: 'team_role', analysis_json: JSON.stringify({ highlights: [{ label: '角色', value: '实施者' }] }) },
  { candidate_id: 'C-B', report_type: 'career_potential', analysis_json: JSON.stringify({ career_matches: [{ category: '市场类', name: '开拓型', percentage: 90 }] }) },
];
const database = {
  prepare(sql) {
    if (sql.includes('sqlite_master')) return { all: () => [{ name: 'assessment_document' }, { name: 'assessment_binding' }] };
    if (sql.includes('FROM assessment_binding')) return { all: (jobId) => jobId === 1 ? activeReports : [] };
    throw new Error(`unexpected SQL: ${sql}`);
  },
};

const candidates = [
  { internal_id: 'C-A', rec_position: '品牌运营', sabc: null, created_at: '2026-07-10' },
  { internal_id: 'C-B', rec_position: '品牌运营', sabc: null, created_at: '2026-07-09' },
  { internal_id: 'C-PENDING', rec_position: '品牌运营', sabc: null, created_at: '2026-07-11' },
];
const scored = attachAssessmentFitSignals(database, candidates, 1);
assert.equal(scored.find((row) => row.internal_id === 'C-A').assessment_fit_score, 80);
assert.equal(scored.find((row) => row.internal_id === 'C-A').assessment_report_count, 3);
assert.equal(scored.find((row) => row.internal_id === 'C-B').assessment_fit_score, 90);
assert.equal(scored.find((row) => row.internal_id === 'C-PENDING').assessment_fit_score, null, 'reports outside the active query must not affect ranking');
assert.deepEqual(
  [...scored].sort(compareCandidateDefaultPriority).map((row) => row.internal_id),
  ['C-PENDING', 'C-A', 'C-B'],
  'optional assessment scores must not change the default created-at order',
);

const sabcWins = [...scored, { internal_id: 'C-SABC', sabc: 'A', assessment_fit_score: 1, created_at: '2026-07-01' }]
  .sort(compareCandidateDefaultPriority);
assert.equal(sabcWins[0].internal_id, 'C-SABC', 'SABC tier remains the primary ranking key');

console.log('check-assessment-fit-ranking ok');
