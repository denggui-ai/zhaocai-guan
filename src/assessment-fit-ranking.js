'use strict';

const { buildAssessmentAiInput } = require('./assessment-ai-analysis');

const SABC_RANK = Object.freeze({ S: 0, A: 1, B: 2, C: 3, D: 4 });
const ASSESSMENT_AI_RECORD_VERSION = 'assessment_ai_analysis_record_v1';

function clean(value) {
  return String(value || '').trim();
}

function inferCareerCategory(...values) {
  const title = values.map(clean).filter(Boolean).join(' ');
  if (/销售|商务|客户开发|渠道/.test(title)) return '销售类';
  if (/运营|投放|市场|推广|增长|媒介|品牌/.test(title)) return '市场类';
  if (/客服|服务|人事|招聘|行政|支持/.test(title)) return '服务类';
  if (/研发|研究|产品|设计/.test(title)) return '研发类';
  if (/技术|工程|开发|数据|运维|测试/.test(title)) return '技术类';
  return null;
}

function parseAnalysis(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function finitePercentage(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 100 ? number : null;
}

function assessmentAiRankingEligible(analysis) {
  if (!analysis || typeof analysis !== 'object') return false;
  if (!['high', 'medium'].includes(clean(analysis.confidence).toLowerCase())) return false;
  if (analysis.decision_support?.recommendation === 'insufficient_evidence') return false;
  return finitePercentage(analysis.fit_score) !== null;
}

function buildAssessmentFitSignal(candidate, reportRows = []) {
  const category = inferCareerCategory(candidate?.rec_position, candidate?.job_name, candidate?.position_name);
  const usableReports = reportRows
    .map((row) => ({ ...row, analysis: parseAnalysis(row.analysis || row.analysis_json) }))
    .filter((row) => row.analysis);
  const contributions = [];

  if (category) {
    for (const row of usableReports) {
      if ((row.report_type || row.analysis.report_type) !== 'career_potential') continue;
      const matches = (row.analysis.career_matches || [])
        .filter((item) => item && item.category === category)
        .map((item) => ({ ...item, percentage: finitePercentage(item.percentage) }))
        .filter((item) => item.percentage !== null)
        .sort((left, right) => right.percentage - left.percentage);
      if (matches[0]) contributions.push(matches[0]);
    }
  }

  if (!contributions.length) {
    return Object.freeze({
      assessment_fit_score: null,
      assessment_fit_category: category,
      assessment_fit_direction: null,
      assessment_fit_report_count: 0,
      assessment_report_count: usableReports.length,
      assessment_ranking_basis: null,
      assessment_fit_source: null,
      assessment_ai_fit_score: null,
    });
  }

  const score = Math.round((contributions.reduce((sum, item) => sum + item.percentage, 0) / contributions.length) * 10) / 10;
  const directions = new Set(contributions.map((item) => `${item.category}${item.name || ''}`));
  const direction = directions.size === 1 ? [...directions][0] : `${category}综合`;
  return Object.freeze({
    assessment_fit_score: score,
    assessment_fit_category: category,
    assessment_fit_direction: direction,
    assessment_fit_report_count: contributions.length,
    assessment_report_count: usableReports.length,
    assessment_ranking_basis: 'HR已确认职业潜能报告',
    assessment_fit_source: 'supplier',
    assessment_ai_fit_score: null,
  });
}

function assessmentTableNames(database) {
  return new Set(database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('assessment_document', 'assessment_binding', 'ai_review')
  `).all().map((row) => row.name));
}

function hasAssessmentTables(database) {
  const names = assessmentTableNames(database);
  return names.has('assessment_document') && names.has('assessment_binding');
}

function attachAssessmentFitSignals(database, candidates, jobId) {
  const rows = Array.isArray(candidates) ? candidates : [];
  if (!rows.length || !hasAssessmentTables(database)) {
    return rows.map((candidate) => ({ ...candidate, ...buildAssessmentFitSignal(candidate, []) }));
  }
  const names = assessmentTableNames(database);
  const reportRows = database.prepare(`
    SELECT binding.candidate_id, document.id AS document_id,
           document.report_type, document.analysis_json
    FROM assessment_binding binding
    JOIN assessment_document document ON document.id = binding.document_id
    WHERE binding.job_id = ?
      AND binding.scope = 'candidate_job_archive'
      AND binding.state = 'active'
      AND document.security_state = 'accepted'
      AND document.review_state = 'ready'
      AND document.lifecycle_state = 'active'
      AND document.analysis_status = 'ready'
      AND document.analysis_json IS NOT NULL
    ORDER BY COALESCE(document.assessment_date, binding.created_at) DESC, binding.id DESC
  `).all(Number(jobId));
  const byCandidate = new Map();
  for (const report of reportRows) {
    const current = byCandidate.get(report.candidate_id) || [];
    current.push(report);
    byCandidate.set(report.candidate_id, current);
  }
  const aiByCandidate = new Map();
  if (names.has('ai_review')) {
    const reviewRows = database.prepare(`
      SELECT candidate_id, report_json, created_at, id
      FROM ai_review
      WHERE job_id = ?
      ORDER BY created_at DESC, id DESC
    `).all(Number(jobId));
    for (const row of reviewRows) {
      const record = parseAnalysis(row.report_json);
      if (!record || record.schema_version !== ASSESSMENT_AI_RECORD_VERSION || !record.analysis) continue;
      if (!aiByCandidate.has(row.candidate_id)) {
        aiByCandidate.set(row.candidate_id, {
          ...row,
          fit_score: record.analysis.fit_score,
          confidence: record.analysis.confidence,
          recommendation: record.analysis.decision_support?.recommendation,
          input_sha256: record.input_sha256,
        });
      }
    }
  }
  return rows.map((candidate) => {
    const supplier = buildAssessmentFitSignal(candidate, byCandidate.get(candidate.internal_id) || []);
    const aiRow = aiByCandidate.get(candidate.internal_id);
    if (!aiRow) return { ...candidate, ...supplier };
    let current = false;
    let includesInterviewEvidence = false;
    try {
      const input = buildAssessmentAiInput(database, candidate.internal_id, Number(jobId));
      current = input.input_sha256 === aiRow.input_sha256;
      includesInterviewEvidence = Array.isArray(input.payload?.confirmed_interviews)
        && input.payload.confirmed_interviews.length > 0;
    } catch {
      current = false;
    }
    const aiScore = current && !includesInterviewEvidence && assessmentAiRankingEligible({
      fit_score: aiRow.fit_score,
      confidence: aiRow.confidence,
      decision_support: { recommendation: aiRow.recommendation },
    }) ? finitePercentage(aiRow.fit_score) : null;
    if (aiScore === null) return { ...candidate, ...supplier };
    return {
      ...candidate,
      ...supplier,
      assessment_supplier_fit_score: supplier.assessment_fit_score,
      assessment_fit_score: aiScore,
      assessment_ai_fit_score: aiScore,
      assessment_fit_source: 'ai',
      assessment_ranking_basis: 'AI综合分析（已确认测评、岗位与候选人证据）',
    };
  });
}

function compareTextDescending(left, right) {
  const leftText = clean(left);
  const rightText = clean(right);
  if (leftText === rightText) return 0;
  return leftText < rightText ? 1 : -1;
}

function compareCandidateDefaultPriority(left, right) {
  const leftTier = SABC_RANK[clean(left?.sabc).toUpperCase()] ?? 5;
  const rightTier = SABC_RANK[clean(right?.sabc).toUpperCase()] ?? 5;
  if (leftTier !== rightTier) return leftTier - rightTier;
  const createdDiff = compareTextDescending(left?.created_at, right?.created_at);
  if (createdDiff !== 0) return createdDiff;
  return compareTextDescending(left?.internal_id, right?.internal_id);
}

module.exports = {
  assessmentAiRankingEligible,
  attachAssessmentFitSignals,
  buildAssessmentFitSignal,
  compareCandidateDefaultPriority,
  inferCareerCategory,
};
