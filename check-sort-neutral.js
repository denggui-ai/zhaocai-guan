'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-sort-neutral-'));
process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
process.env.BOSS_DB_PATH = path.join(ROOT, 'sort-neutral.db');
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const { buildAssessmentAiInput } = require('./assessment-ai-analysis');
const { compareCandidateDefaultPriority } = require('./assessment-fit-ranking');

const noAssessment = { internal_id: 'C-A-NEW-NONE', sabc: 'A', created_at: '2026-07-14T02:00:00.000Z' };
const highAssessment = { internal_id: 'C-A-OLD-HIGH', sabc: 'A', created_at: '2026-07-14T01:00:00.000Z', assessment_fit_score: 100 };
const postInterview = { internal_id: 'C-A-OLDER-INTERVIEW', sabc: 'A', created_at: '2026-07-14T00:00:00.000Z', assessment_fit_score: 99, workflow_status: 'report_confirmed' };
const lowerScoreHigherTier = { internal_id: 'C-S-OLDEST', sabc: 'S', created_at: '2026-01-01T00:00:00.000Z', assessment_fit_score: 0 };

const defaultOrder = [highAssessment, postInterview, lowerScoreHigherTier, noAssessment]
  .sort(compareCandidateDefaultPriority)
  .map((candidate) => candidate.internal_id);
assert.deepEqual(defaultOrder, ['C-S-OLDEST', 'C-A-NEW-NONE', 'C-A-OLD-HIGH', 'C-A-OLDER-INTERVIEW']);

const scorePermutationOrder = [
  { ...noAssessment, assessment_fit_score: 0 },
  { ...highAssessment, assessment_fit_score: null },
  { ...postInterview, assessment_fit_score: 100 },
  { ...lowerScoreHigherTier, assessment_fit_score: null },
].sort(compareCandidateDefaultPriority).map((candidate) => candidate.internal_id);
assert.deepEqual(scorePermutationOrder, defaultOrder, 'assessment score presence and value must not change default order');

const sameTier = [noAssessment, highAssessment, postInterview].sort(compareCandidateDefaultPriority);
assert.ok(compareCandidateDefaultPriority(sameTier[0], sameTier[1]) < 0);
assert.ok(compareCandidateDefaultPriority(sameTier[1], sameTier[2]) < 0);
assert.ok(compareCandidateDefaultPriority(sameTier[0], sameTier[2]) < 0, 'default comparator must remain transitive');

const candidateListSource = fs.readFileSync(path.join(__dirname, 'frontend/src/components/CandidateList.jsx'), 'utf8');
const comparatorSource = candidateListSource.match(/function compareCandidateDefaultPriority\([\s\S]*?\n\}/)?.[0] || '';
assert.ok(comparatorSource, 'frontend default comparator must be explicit');
assert.doesNotMatch(comparatorSource, /assessment|score|\?\?\s*-1/);
assert.doesNotMatch(candidateListSource, /assessmentFitScore\([^)]*\)\s*\?\?\s*-1/);
assert.match(candidateListSource, /默认排序仅按确定性 SABC 档位、入库时间和内部 ID/);
assert.match(candidateListSource, /测评为可选辅助材料，缺失不降级/);
assert.match(candidateListSource, /测评、AI 和面试分均不参与默认排序/);

const assessmentPanelSource = fs.readFileSync(path.join(__dirname, 'frontend/src/components/AssessmentArchivePanel.jsx'), 'utf8');
assert.doesNotMatch(assessmentPanelSource, /已更新同档排序信号/);
assert.doesNotMatch(assessmentPanelSource, /用于同档排序|参与同一 SABC 档内排序|进入候选人组合画像、岗位匹配分和列表排序/);
assert.match(assessmentPanelSource, /仅作为辅助材料，不改变默认排序/);
const ratingLlmSource = fs.readFileSync(path.join(__dirname, 'rating-llm.js'), 'utf8');
assert.doesNotMatch(ratingLlmSource, /fit_score[^。\n]*同档排序/);
assert.match(ratingLlmSource, /fit_score[^。\n]*不参与默认排序/);

const db = require('./db');
const database = db.openDb(process.env.BOSS_DB_PATH, { assessmentEnabled: true });
const job = db.upsertJob({
  encrypt_job_id: 'sort-neutral-job',
  numeric_job_id: '202607140002',
  name: 'SORT-NEUTRAL 纯合成运营岗位',
  hr_owner: 'HR-SORT-NEUTRAL',
});
const activeJd = db.createJobJdVersion({
  jobId: job.id,
  jdText: 'SORT-NEUTRAL 纯合成当前 JD',
  actor: 'HR-SORT-NEUTRAL',
});
db.activateJobJdVersion({
  jdVersionId: activeJd.id,
  expectedVersion: activeJd.version,
  actor: 'HR-SORT-NEUTRAL',
});
const confirmedProfile = db.createJobProfileVersion({
  jobId: job.id,
  jdVersionId: activeJd.id,
  config: { rubric: 'SORT-NEUTRAL 纯合成当前岗位画像' },
  actor: 'HR-SORT-NEUTRAL',
});
db.confirmJobProfileVersion({
  profileVersionId: confirmedProfile.id,
  expectedVersion: confirmedProfile.version,
  actor: 'HR-SORT-NEUTRAL',
});

function createCandidate(suffix, sabc, createdAt) {
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: `sort-neutral-${suffix}`,
    source: 'synthetic_sort_neutral',
    name: `SORT-NEUTRAL 纯合成候选人 ${suffix}`,
    rec_position: '品牌运营',
  });
  database.prepare(`
    UPDATE candidate SET sabc = ?, created_at = ?, updated_at = ? WHERE internal_id = ?
  `).run(sabc, createdAt, createdAt, candidate.internal_id);
  return candidate;
}

const sCandidate = createCandidate('s-oldest', 'S', '2026-01-01T00:00:00.000Z');
const noAssessmentCandidate = createCandidate('a-new-none', 'A', '2026-07-14T02:00:00.000Z');
const assessedCandidate = createCandidate('a-old-assessed', 'A', '2026-07-14T01:00:00.000Z');

const reportAnalysis = {
  schema_version: 'assessment_report_analysis_v2',
  report_type: 'career_potential',
  summary: '纯合成市场类职业潜能证据',
  career_matches: [{ category: '市场类', name: '开拓型', percentage: 95 }],
};
database.prepare(`
  INSERT INTO assessment_document (
    id, content_sha256, storage_relpath, byte_size, page_count, mime_detected,
    security_state, report_type, assessment_date, analysis_status,
    analysis_schema_version, analysis_json, review_state, lifecycle_state,
    legal_hold_state, created_by, version, created_at, updated_at
  ) VALUES (
    'DOC-SORT-NEUTRAL', ?, 'accepted/sort-neutral.pdf', 128, 2, 'application/pdf',
    'accepted', 'career_potential', '2026-07-01', 'ready',
    'assessment_report_analysis_v2', ?, 'ready', 'active',
    'none', 'local-primary-operator', 1, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
  )
`).run('e'.repeat(64), JSON.stringify(reportAnalysis));
database.prepare(`
  INSERT INTO assessment_binding (
    id, document_id, candidate_id, job_id, scope, state, conflict_state,
    identity_basis, actor_id, reason_code, request_id, version, created_at, updated_at
  ) VALUES (
    'BIND-SORT-NEUTRAL', 'DOC-SORT-NEUTRAL', ?, ?, 'candidate_job_archive', 'active', 'none',
    'current_candidate_context', 'local-primary-operator', 'synthetic_test', 'REQ-BIND-SORT-NEUTRAL',
    1, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
  )
`).run(assessedCandidate.internal_id, job.id);

function insertAiRecord(input, score, createdAt) {
  database.prepare(`
    INSERT INTO ai_review (candidate_id, job_id, profile_confirmed, report_json, created_at)
    VALUES (?, ?, 0, ?, ?)
  `).run(assessedCandidate.internal_id, job.id, JSON.stringify({
    schema_version: 'assessment_ai_analysis_record_v1',
    input_sha256: input.input_sha256,
    analysis: {
      fit_score: score,
      confidence: 'high',
      decision_support: { recommendation: 'advance' },
    },
  }), createdAt);
}

const preInterviewInput = buildAssessmentAiInput(database, assessedCandidate.internal_id, job.id);
assert.equal(preInterviewInput.payload.confirmed_interviews.length, 0);
insertAiRecord(preInterviewInput, 99, '2026-07-14T03:00:00.000Z');

let listed = db.listCandidates(job.id);
assert.deepEqual(
  listed.map((candidate) => candidate.internal_id),
  [sCandidate.internal_id, noAssessmentCandidate.internal_id, assessedCandidate.internal_id],
  'backend list must keep SABC and created-at order even when only the older candidate has a score',
);
assert.equal(listed.find((candidate) => candidate.internal_id === noAssessmentCandidate.internal_id).assessment_fit_score, null);
assert.equal(listed.find((candidate) => candidate.internal_id === assessedCandidate.internal_id).assessment_fit_score, 99);
assert.equal(listed.find((candidate) => candidate.internal_id === assessedCandidate.internal_id).assessment_fit_source, 'ai');

const interviewSession = db.createInterviewSession({
  candidateId: assessedCandidate.internal_id,
  jobId: job.id,
  round: 1,
  mode: 'online',
  status: 'confirmed',
});
database.prepare(`
  INSERT INTO interview_report_v1 (
    session_id, schema_version, status, report_json, content_hash, version,
    created_by, updated_by, confirmed_by, confirmed_at,
    rejected_by, rejected_at, created_at, updated_at
  ) VALUES (?, 'interview_report_v1', 'confirmed', '{}', ?, 1,
    'HR-SORT-NEUTRAL', 'HR-SORT-NEUTRAL', 'HR-SORT-NEUTRAL', '2026-07-14T04:00:00.000Z',
    NULL, NULL, '2026-07-14T04:00:00.000Z', '2026-07-14T04:00:00.000Z')
`).run(interviewSession.id, 'f'.repeat(64));

const postInterviewInput = buildAssessmentAiInput(database, assessedCandidate.internal_id, job.id);
assert.equal(postInterviewInput.payload.confirmed_interviews.length, 1);
insertAiRecord(postInterviewInput, 100, '2026-07-14T05:00:00.000Z');

listed = db.listCandidates(job.id);
const postInterviewCandidate = listed.find((candidate) => candidate.internal_id === assessedCandidate.internal_id);
assert.deepEqual(listed.map((candidate) => candidate.internal_id), [sCandidate.internal_id, noAssessmentCandidate.internal_id, assessedCandidate.internal_id]);
assert.equal(postInterviewCandidate.assessment_fit_score, 95, 'AI score containing interview evidence must not become the list assessment signal');
assert.equal(postInterviewCandidate.assessment_fit_source, 'supplier');

database.close();

console.log(JSON.stringify({
  ok: true,
  contract: 'sort-neutral-v1',
  default_order: ['sabc', 'created_at', 'internal_id'],
  assessment_optional: true,
  interview_evidence_isolated: true,
}));
