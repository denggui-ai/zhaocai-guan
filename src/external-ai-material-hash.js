'use strict';

const crypto = require('crypto');
const {
  ASSESSMENT_AI_PURPOSE,
  ASSESSMENT_AI_SYSTEM_PROMPT,
  buildAssessmentAiInput,
  buildAssessmentAiUserPrompt,
  redactKnownName,
} = require('./assessment-ai-analysis');
const {
  JOB_JD_OPTIMIZATION_PURPOSE,
  JOB_JD_OPTIMIZATION_SYSTEM_PROMPT,
  buildJobJdOptimizationUserPrompt,
} = require('./job-jd-ai');
const {
  DEEP_PROFILE_SYSTEM_PROMPT,
  buildDeepProfileUserPrompt,
} = require('./rating-llm');
const {
  REPORT_SYSTEM_PROMPT,
  buildCandidateReportUserPrompt,
  buildEvidenceProfile,
  buildReportDimensions,
  scrubSensitive,
} = require('./candidate-report-v1');

const MATERIAL_HASH_SCHEMA_VERSION = 'external_ai_material_hash_v1';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(stableJson(value), 'utf8').digest('hex');
}

function requiredTarget(value) {
  const targetId = String(value || '').trim();
  if (!targetId || targetId.length > 160 || /[\r\n\0]/.test(targetId)) throw new Error('外部 AI 材料目标无效。');
  return targetId;
}

function requireJob(dbApi, jobId) {
  const job = dbApi.getJobForFetch(jobId);
  if (!job) throw new Error('岗位不存在。');
  return job;
}

function jobJdFingerprint(dbApi, targetId, materialInput) {
  const jobId = Number(targetId);
  const job = requireJob(dbApi, jobId);
  return {
    job: { id: Number(job.id), name: job.name || '', status: job.status || '' },
    brief: String(materialInput.brief || '').trim(),
    current_jd: String(materialInput.currentJd || materialInput.current_jd || '').trim(),
  };
}

function deepProfileFingerprint(dbApi, targetId) {
  const jobId = Number(targetId);
  const job = requireJob(dbApi, jobId);
  const profileContext = dbApi.getCurrentJobProfileContext(jobId);
  const config = profileContext.config || {};
  const interviews = dbApi.listInterviews(jobId).map((row) => ({
    id: Number(row.id),
    note: row.note || '',
    source_type: row.source_type || '',
    created_at: row.created_at || '',
    transcript: row.transcript || '',
  }));
  if (!interviews.length) throw new Error('该岗位还没有访谈记录。');
  return {
    job: { id: Number(job.id), name: job.name || '', status: job.status || '' },
    jd_version_id: Number(profileContext.activeJd && profileContext.activeJd.id),
    profile_version_id: Number(profileContext.profileVersion && profileContext.profileVersion.id),
    profile_content_hash: profileContext.profileVersion && profileContext.profileVersion.content_hash,
    rubric: config.rubric || '',
    previous_profile: config.deep_profile ? config.deep_profile.doc || null : null,
    interviews,
  };
}

function candidateAssessmentFingerprint(database, dbApi, targetId) {
  const candidate = database.prepare(`
    SELECT candidate.internal_id, candidate.job_id, candidate.name, candidate.updated_at,
           job.name AS job_name, job.status AS job_status, job.updated_at AS job_updated_at
    FROM candidate JOIN job ON job.id = candidate.job_id
    WHERE candidate.internal_id = ?
  `).get(targetId);
  if (!candidate) throw new Error('候选人不存在。');
  const resume = database.prepare(`
    SELECT id, sections_json, is_paywalled, fetched_at
    FROM resume_online WHERE candidate_id = ?
  `).get(targetId) || null;
  if (!resume) throw new Error('该候选人还没有在线简历。');
  const profileContext = dbApi.getCurrentJobProfileContext(candidate.job_id);
  return {
    candidate,
    resume,
    active_jd: {
      id: Number(profileContext.activeJd && profileContext.activeJd.id),
      content_hash: profileContext.activeJd && profileContext.activeJd.content_hash,
    },
    confirmed_profile: {
      id: Number(profileContext.profileVersion && profileContext.profileVersion.id),
      content_hash: profileContext.profileVersion && profileContext.profileVersion.content_hash,
      config: profileContext.config,
    },
  };
}

function assessmentFingerprint(database, targetId, materialInput) {
  const jobId = Number(materialInput.jobId === undefined ? materialInput.job_id : materialInput.jobId);
  const input = buildAssessmentAiInput(database, targetId, jobId);
  return { job_id: jobId, assessment_input_sha256: input.input_sha256 };
}

function previewMessages(system, user) {
  const messages = [
    { role: 'system', content: String(system || '') },
    { role: 'user', content: String(user || '') },
  ];
  const text = messages
    .map((message) => `【${message.role === 'system' ? '模型系统规则' : '本次发送材料'}】\n${message.content}`)
    .join('\n\n');
  return { messages, text, characterCount: text.length };
}

function candidateAssessmentPromptInput(material) {
  if (Number(material.resume && material.resume.is_paywalled)) {
    throw new Error('该候选人简历未公开（付费墙），没有内容可评估。');
  }
  let sections = null;
  try {
    sections = JSON.parse(String((material.resume && material.resume.sections_json) || ''));
  } catch {
    sections = null;
  }
  const config = (material.confirmed_profile && material.confirmed_profile.config) || {};
  const deep = config.deep_profile || null;
  return {
    jobName: material.candidate.job_name,
    candidateName: '候选人（本地已隐去姓名）',
    deepProfile: deep ? deep.doc : null,
    rubric: config.rubric || '',
    evidenceProfile: redactKnownName(buildEvidenceProfile(sections), material.candidate.name),
    dimensions: buildReportDimensions(config),
  };
}

function previewForPurpose({ database, purpose, material, materialInput }) {
  if (purpose === JOB_JD_OPTIMIZATION_PURPOSE) {
    return {
      ...previewMessages(
        JOB_JD_OPTIMIZATION_SYSTEM_PROMPT,
        buildJobJdOptimizationUserPrompt({
          jobName: material.job.name,
          brief: material.brief,
          currentJd: material.current_jd,
        }),
      ),
      exclusions: [
        '候选人、简历、测评和面试材料',
        'Boss 登录信息、API Key 和本机文件路径',
      ],
    };
  }
  if (purpose === 'deep-profile') {
    const followupAnswers = material.interviews
      .filter((row) => row.note === '追问补答')
      .map((row) => ({ created_at: row.created_at, text: scrubSensitive(row.transcript) }));
    const transcripts = material.interviews
      .filter((row) => row.note !== '追问补答')
      .map((row) => ({
        note: row.note,
        created_at: row.created_at,
        text: scrubSensitive(row.transcript),
      }));
    return {
      ...previewMessages(
        DEEP_PROFILE_SYSTEM_PROMPT,
        buildDeepProfileUserPrompt({
          jobName: material.job.name,
          rubric: material.rubric,
          transcripts,
          previousProfile: material.previous_profile,
          followupAnswers,
        }),
      ),
      exclusions: [
        '访谈中的手机号、邮箱、微信号、身份证号和银行卡号会在本机替换为占位符',
        '候选人简历、Boss 登录信息、API Key 和本机文件路径',
      ],
    };
  }
  if (purpose === 'candidate-assessment') {
    return {
      ...previewMessages(
        REPORT_SYSTEM_PROMPT,
        buildCandidateReportUserPrompt(candidateAssessmentPromptInput(material)),
      ),
      exclusions: [
        '候选人姓名在本机替换为“候选人”，联系方式和敏感号码会在本机替换为占位符',
        '历史 AI 评论、历史评分、SABC、quality_score、expert_comment、Boss 登录信息和 API Key',
      ],
    };
  }
  if (purpose === ASSESSMENT_AI_PURPOSE) {
    const jobId = Number(materialInput.jobId === undefined ? materialInput.job_id : materialInput.jobId);
    const input = buildAssessmentAiInput(database, material.target_id, jobId);
    return {
      ...previewMessages(
        ASSESSMENT_AI_SYSTEM_PROMPT,
        buildAssessmentAiUserPrompt(input),
      ),
      exclusions: [
        '候选人姓名和测评 subject_name 在本机移除或替换',
        '未确认测评、未确认面试、Boss 登录信息、API Key 和本机文件路径',
      ],
    };
  }
  throw new Error('外部 AI 材料用途无效。');
}

function externalAiMaterialSnapshot({ database, dbApi, purpose, targetId, materialInput = {} } = {}) {
  if (!database || typeof database.prepare !== 'function') throw new Error('外部 AI 材料数据库不可用。');
  if (!dbApi) throw new Error('外部 AI 材料服务不可用。');
  const target = requiredTarget(targetId);
  let material;
  if (purpose === JOB_JD_OPTIMIZATION_PURPOSE) material = jobJdFingerprint(dbApi, target, materialInput);
  else if (purpose === 'deep-profile') material = deepProfileFingerprint(dbApi, target);
  else if (purpose === 'candidate-assessment') material = candidateAssessmentFingerprint(database, dbApi, target);
  else if (purpose === ASSESSMENT_AI_PURPOSE) material = assessmentFingerprint(database, target, materialInput);
  else throw new Error('外部 AI 材料用途无效。');
  const materialHash = sha256({
    schema_version: MATERIAL_HASH_SCHEMA_VERSION,
    purpose,
    target_id: target,
    material,
  });
  const preview = previewForPurpose({
    database,
    purpose,
    material: { ...material, target_id: target },
    materialInput,
  });
  return {
    materialHash,
    preview: {
      text: preview.text,
      characterCount: preview.characterCount,
      exclusions: preview.exclusions,
    },
  };
}

function externalAiMaterialHash(options = {}) {
  return externalAiMaterialSnapshot(options).materialHash;
}

module.exports = {
  MATERIAL_HASH_SCHEMA_VERSION,
  externalAiMaterialHash,
  externalAiMaterialSnapshot,
  sha256,
  stableJson,
};
