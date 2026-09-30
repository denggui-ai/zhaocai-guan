'use strict';

const crypto = require('crypto');
const { buildEvidenceProfile } = require('./candidate-report-v1');
const { buildConfirmedInterviewProjection } = require('./interview-report-authority');

const ASSESSMENT_AI_SCHEMA_VERSION = 'assessment_ai_analysis_v1';
const ASSESSMENT_AI_INPUT_VERSION = 'assessment_ai_input_v1';
const ASSESSMENT_AI_PURPOSE = 'assessment-ai-analysis';

const ASSESSMENT_AI_SYSTEM_PROMPT = [
  '你是一位资深招聘测评分析师。你会收到同一候选人在当前岗位下的结构化材料：岗位要求、简历证据、HR 已确认绑定的供应商测评，以及可能存在的已确认面试报告。',
  '你的任务是把多份材料交叉分析成一份可直接供 HR 使用的岗位匹配结论。',
  '',
  '分析要求：',
  '1. fit_score 给 0-100 的当前岗位匹配分。必须结合岗位要求，不能把供应商百分比直接照抄成总分。证据不足时仍可给保守分，但 confidence 必须为 low；low 或 insufficient_evidence 不会进入候选人排序。',
  '2. strengths、risks、contradictions 中的每一条都必须引用输入里真实存在的 evidence ref；不得编造引用。',
  '3. 同一候选人的多份报告可以互补，也可以互相矛盾。要明确指出矛盾以及面试如何验证。',
  '4. 供应商测评是证据之一，不是唯一真相。简历、岗位和已确认面试事实应参与交叉判断。',
  '5. 不得根据姓名、性别、年龄、民族、婚育、籍贯等非岗位因素判断。',
  '6. recommendation 允许 advance / hold / reject / insufficient_evidence，但只表示给 HR 的决策建议，不代表自动录用或淘汰。',
  '',
  '只输出一个 JSON，不要代码块和额外文字：',
  '{',
  `  "schema_version": "${ASSESSMENT_AI_SCHEMA_VERSION}",`,
  '  "fit_score": 0,',
  '  "confidence": "high|medium|low",',
  '  "overall": "岗位匹配综合结论",',
  '  "strengths": [{"point":"优势", "evidence_refs":["A1","R1","J1"]}],',
  '  "risks": [{"point":"风险", "evidence_refs":["A1","R1","J1"]}],',
  '  "contradictions": [{"point":"矛盾或需要核实之处", "evidence_refs":["A1","A2"]}],',
  '  "interview_questions": [{"question":"面试问题", "listen_for":"什么回答支持或否定当前判断", "evidence_refs":["A1","R1"]}],',
  '  "decision_support": {"recommendation":"advance|hold|reject|insufficient_evidence", "reason":"建议理由"}',
  '}',
].join('\n');

function tableExists(database, name) {
  return Boolean(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function redactKnownName(value, candidateName) {
  const name = String(candidateName || '').replace(/\s+/g, '').trim();
  if (!name || name.length < 2) return value;
  if (typeof value === 'string') {
    const pattern = [...name]
      .map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('\\s*');
    return value.replace(new RegExp(pattern, 'g'), '候选人');
  }
  if (Array.isArray(value)) return value.map((item) => redactKnownName(item, name));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactKnownName(item, name)]));
  }
  return value;
}

function stripAssessmentIdentity(analysis, candidateName) {
  if (!analysis || typeof analysis !== 'object') return {};
  const { subject_name: _subjectName, ...rest } = analysis;
  return redactKnownName(rest, candidateName);
}

function inputError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function buildAssessmentAiInput(database, candidateIdInput, jobIdInput) {
  const candidateId = String(candidateIdInput || '').trim();
  const jobId = Number(jobIdInput);
  if (!candidateId || !Number.isSafeInteger(jobId) || jobId <= 0) {
    throw inputError('ASSESSMENT_AI_CONTEXT_REQUIRED', '候选人和岗位上下文不能为空。');
  }
  const candidate = database.prepare(`
    SELECT candidate.internal_id, candidate.job_id, candidate.name, candidate.rec_position,
           job.name AS job_name, job.status AS job_status
    FROM candidate
    JOIN job ON job.id = candidate.job_id
    WHERE candidate.internal_id = ? AND candidate.job_id = ?
  `).get(candidateId, jobId);
  if (!candidate) throw inputError('ASSESSMENT_AI_CONTEXT_MISMATCH', '候选人和岗位上下文不匹配。');
  if (candidate.job_status === 'closed') {
    throw inputError('ASSESSMENT_AI_JOB_CLOSED', '岗位已关闭，请重新开启后再生成测评 AI 分析。');
  }

  let jd = null;
  if (tableExists(database, 'job_jd_version')) {
    jd = database.prepare(`
      SELECT id, version, jd_text
      FROM job_jd_version
      WHERE job_id = ? AND status = 'active'
      ORDER BY version DESC, id DESC LIMIT 1
    `).get(jobId) || null;
  }

  let profile = null;
  let profileVersion = null;
  const hasVersionedProfiles = tableExists(database, 'job_profile_version');
  if (hasVersionedProfiles) {
    if (!jd) {
      throw inputError('ASSESSMENT_AI_ACTIVE_JD_REQUIRED', '请先启用当前 JD，再生成测评 AI 分析。');
    }
    profileVersion = database.prepare(`
      SELECT id, version, jd_version_id, config_json
      FROM job_profile_version
      WHERE job_id = ? AND status = 'confirmed' AND jd_version_id = ?
      ORDER BY version DESC, id DESC LIMIT 1
    `).get(jobId, jd.id) || null;
    if (!profileVersion) {
      throw inputError(
        'ASSESSMENT_AI_CURRENT_PROFILE_REQUIRED',
        '当前 JD 还没有已确认的岗位画像。请基于当前 JD 保存并确认新画像后再试。',
      );
    }
    profile = parseJson(profileVersion.config_json);
  } else if (tableExists(database, 'job_profile')) {
    // Legacy-only databases have no JD/profile version relation to validate.
    // Keep their prior behavior without allowing a versioned database to fall
    // back to the unbound compatibility row after an active-JD switch.
    const row = database.prepare('SELECT config_json, updated_at FROM job_profile WHERE job_id = ?').get(jobId);
    profile = parseJson(row && row.config_json);
    if (row) profileVersion = { id: null, version: null, jd_version_id: null, updated_at: row.updated_at || null };
  }

  let resumePayload = null;
  let resumeFingerprint = null;
  if (tableExists(database, 'resume_online')) {
    const resume = database.prepare(`
      SELECT id, sections_json, is_paywalled, fetched_at
      FROM resume_online WHERE candidate_id = ?
      ORDER BY id DESC LIMIT 1
    `).get(candidateId) || null;
    if (resume && !Number(resume.is_paywalled)) {
      const sections = parseJson(resume.sections_json);
      if (sections) {
        const evidence = redactKnownName(buildEvidenceProfile(sections), candidate.name);
        resumePayload = { ref: 'R1', evidence };
        resumeFingerprint = { id: resume.id, fetched_at: resume.fetched_at || null, evidence };
      }
    }
  }

  const assessmentRows = database.prepare(`
    SELECT document.id, document.version, document.report_type, document.assessment_date,
           document.analysis_schema_version, document.analysis_json,
           binding.id AS binding_id, binding.version AS binding_version
    FROM assessment_binding binding
    JOIN assessment_document document ON document.id = binding.document_id
    WHERE binding.candidate_id = ? AND binding.job_id = ?
      AND binding.scope = 'candidate_job_archive'
      AND binding.state = 'active'
      AND document.security_state = 'accepted'
      AND document.review_state = 'ready'
      AND document.lifecycle_state = 'active'
      AND document.analysis_status = 'ready'
      AND document.report_type <> 'unknown'
      AND document.analysis_json IS NOT NULL
    ORDER BY COALESCE(document.assessment_date, binding.created_at), document.id
  `).all(candidateId, jobId);
  if (!assessmentRows.length) {
    throw inputError('ASSESSMENT_AI_CONFIRMED_REPORT_REQUIRED', '请先人工确认至少一份已完成解析的测评报告。');
  }
  const assessments = assessmentRows.map((row, index) => ({
    ref: `A${index + 1}`,
    report_type: row.report_type,
    assessment_date: row.assessment_date || null,
    analysis: stripAssessmentIdentity(parseJson(row.analysis_json), candidate.name),
  }));

  const interviews = [];
  const interviewFingerprint = [];
  if (tableExists(database, 'interview_report_v1') && tableExists(database, 'interview_session')) {
    const hasProjection = tableExists(database, 'interview_report_confirmed_projection');
    const rows = database.prepare(`
      SELECT report.id, report.session_id, report.version, report.report_json,
             report.content_hash, report.confirmed_by, report.confirmed_at
             ${hasProjection ? `,
             projection.projection_json, projection.content_hash AS projection_hash,
             projection.source_report_version` : ''}
      FROM interview_report_v1 report
      JOIN interview_session session ON session.id = report.session_id
      ${hasProjection ? 'LEFT JOIN interview_report_confirmed_projection projection ON projection.report_id = report.id' : ''}
      WHERE session.candidate_id = ? AND session.job_id = ? AND report.status = 'confirmed'
      ORDER BY report.confirmed_at DESC, report.id DESC
      LIMIT 3
    `).all(candidateId, jobId);
    rows.forEach((row, index) => {
      let projection = parseJson(row.projection_json);
      if (!projection) {
        const factReviews = tableExists(database, 'interview_report_fact_review')
          ? database.prepare(`
            SELECT field_key, status, corrected_value, reviewed_by, reviewed_at
            FROM interview_report_fact_review
            WHERE report_id = ? ORDER BY id
          `).all(row.id)
          : [];
        projection = buildConfirmedInterviewProjection({
          reportRow: row,
          factReviews,
        }).projection;
      }
      const report = parseJson(projection && projection.report);
      if (!report) return;
      const ref = `I${index + 1}`;
      const redacted = redactKnownName(report, candidate.name);
      interviews.push({ ref, report: redacted });
      interviewFingerprint.push({
        id: row.id,
        version: row.version,
        source_report_version: projection.source_report_version,
        projection_hash: row.projection_hash || crypto.createHash('sha256').update(stableJson(projection), 'utf8').digest('hex'),
        confirmed_at: row.confirmed_at,
        report: redacted,
      });
    });
  }

  const jobPayload = redactKnownName({
    ref: 'J1',
    job_name: candidate.job_name || candidate.rec_position || '当前岗位',
    candidate_position: candidate.rec_position || null,
    jd_text: jd ? jd.jd_text : null,
    rubric: profile && profile.rubric ? profile.rubric : null,
    hard_bars: profile && profile.hard_bars ? profile.hard_bars : null,
    deep_profile: profile && profile.deep_profile ? profile.deep_profile : null,
  }, candidate.name);
  const payload = {
    schema_version: ASSESSMENT_AI_INPUT_VERSION,
    job: jobPayload,
    resume: resumePayload,
    assessments,
    confirmed_interviews: interviews,
  };
  const fingerprint = {
    payload,
    local_versions: {
      job_id: jobId,
      profile: profileVersion,
      jd: jd ? { id: jd.id, version: jd.version } : null,
      resume: resumeFingerprint,
      assessments: assessmentRows.map((row) => ({
        document_id: row.id,
        document_version: row.version,
        binding_id: row.binding_id,
        binding_version: row.binding_version,
        analysis_schema_version: row.analysis_schema_version,
      })),
      interviews: interviewFingerprint,
    },
  };
  const inputSha256 = crypto.createHash('sha256').update(stableJson(fingerprint), 'utf8').digest('hex');
  const allowedEvidenceRefs = [
    'J1',
    ...(resumePayload ? ['R1'] : []),
    ...assessments.map((item) => item.ref),
    ...interviews.map((item) => item.ref),
  ];
  return Object.freeze({
    candidate_id: candidateId,
    job_id: jobId,
    payload,
    input_sha256: inputSha256,
    source_document_ids: assessmentRows.map((row) => row.id),
    allowed_evidence_refs: allowedEvidenceRefs,
  });
}

function buildAssessmentAiUserPrompt(input) {
  const payload = input && input.payload ? input.payload : input;
  return [
    '【证据引用规则】每条结论只能使用下列 ref：',
    [
      payload && payload.job && payload.job.ref,
      payload && payload.resume && payload.resume.ref,
      ...((payload && payload.assessments) || []).map((item) => item.ref),
      ...((payload && payload.confirmed_interviews) || []).map((item) => item.ref),
    ].filter(Boolean).join(', '),
    '',
    '【结构化输入】',
    JSON.stringify(payload, null, 2),
  ].join('\n');
}

function extractJson(content) {
  if (content && typeof content === 'object' && !Array.isArray(content)) return content;
  let text = String(content || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

function stringValue(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function evidenceRefs(value, allowed) {
  const refs = Array.isArray(value) ? value.map((item) => stringValue(item, 20)).filter(Boolean) : [];
  return [...new Set(refs.filter((ref) => allowed.has(ref)))];
}

function evidenceItems(value, allowed) {
  return (Array.isArray(value) ? value : [])
    .map((item) => ({
      point: stringValue(item && item.point, 1200),
      evidence_refs: evidenceRefs(item && item.evidence_refs, allowed),
    }))
    .filter((item) => item.point && item.evidence_refs.length)
    .slice(0, 12);
}

function parseAssessmentAiReply(content, options = {}) {
  const obj = extractJson(content);
  if (!obj || typeof obj !== 'object') throw new Error('模型没有返回测评综合分析 JSON。');
  const score = Number(obj.fit_score);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error('模型返回的 fit_score 无效。');
  const overall = stringValue(obj.overall, 6000);
  if (!overall) throw new Error('模型没有返回 overall 综合结论。');
  const allowed = new Set(Array.isArray(options.allowedEvidenceRefs) ? options.allowedEvidenceRefs : []);
  if (!allowed.size) throw new Error('测评综合分析缺少可用证据引用。');
  const confidence = ['high', 'medium', 'low'].includes(obj.confidence) ? obj.confidence : 'low';
  const recommendation = ['advance', 'hold', 'reject', 'insufficient_evidence'].includes(obj.decision_support && obj.decision_support.recommendation)
    ? obj.decision_support.recommendation
    : 'insufficient_evidence';
  const questions = (Array.isArray(obj.interview_questions) ? obj.interview_questions : [])
    .map((item) => ({
      question: stringValue(item && item.question, 1200),
      listen_for: stringValue(item && item.listen_for, 1800),
      evidence_refs: evidenceRefs(item && item.evidence_refs, allowed),
    }))
    .filter((item) => item.question && item.evidence_refs.length)
    .slice(0, 12);
  return Object.freeze({
    schema_version: ASSESSMENT_AI_SCHEMA_VERSION,
    fit_score: Math.round(score * 10) / 10,
    confidence,
    overall,
    strengths: evidenceItems(obj.strengths, allowed),
    risks: evidenceItems(obj.risks, allowed),
    contradictions: evidenceItems(obj.contradictions, allowed),
    interview_questions: questions,
    decision_support: {
      recommendation,
      reason: stringValue(obj.decision_support && obj.decision_support.reason, 2400),
    },
  });
}

module.exports = {
  ASSESSMENT_AI_INPUT_VERSION,
  ASSESSMENT_AI_PURPOSE,
  ASSESSMENT_AI_SCHEMA_VERSION,
  ASSESSMENT_AI_SYSTEM_PROMPT,
  buildAssessmentAiInput,
  buildAssessmentAiUserPrompt,
  parseAssessmentAiReply,
  redactKnownName,
  stableJson,
};
