'use strict';

const assert = require('node:assert/strict');
const {
  externalAiMaterialHash,
  externalAiMaterialSnapshot,
} = require('./external-ai-material-hash');

function assertPreview(options, expectedText, excludedText = []) {
  const snapshot = externalAiMaterialSnapshot(options);
  assert.equal(snapshot.materialHash, externalAiMaterialHash(options));
  assert.equal(snapshot.preview.characterCount, snapshot.preview.text.length);
  assert.match(snapshot.preview.text, /【模型系统规则】[\s\S]*【本次发送材料】/);
  assert.match(snapshot.preview.text, expectedText);
  excludedText.forEach((text) => {
    assert.equal(snapshot.preview.text.includes(text), false, `preview leaked excluded text: ${text}`);
  });
  assert.ok(snapshot.preview.exclusions.length >= 2);
  return snapshot;
}

const job = { id: 21, name: '合成数据分析岗位', status: 'open' };
const profileConfig = {
  rubric: '需要能核验数据证据',
  deep_profile: {
    status: 'confirmed',
    doc: {
      core_competencies: [{
        name: '证据核验',
        what: '能核验来源',
        source: 'stated',
        resume_evidence: ['描述核验过程'],
        fake_signals: ['只写熟悉'],
      }],
    },
  },
};
const profileContext = {
  activeJd: { id: 31, content_hash: 'a'.repeat(64) },
  profileVersion: { id: 41, content_hash: 'b'.repeat(64) },
  config: profileConfig,
};
const candidate = {
  internal_id: 'synthetic-candidate-1',
  job_id: job.id,
  name: '合成甲乙',
  updated_at: '2026-07-31T00:00:00.000Z',
  job_name: job.name,
  job_status: 'open',
  job_updated_at: '2026-07-31T00:00:00.000Z',
};
const resume = {
  id: 51,
  sections_json: JSON.stringify({
    basic: [{
      name: candidate.name,
      description: `${candidate.name} 完成过合成分析，电话 13812345678，邮箱 synthetic@example.test。`,
      work_years: '3年',
    }],
    work: [{ title: '分析师', desc: '建立数据核验流程并记录来源。' }],
  }),
  is_paywalled: 0,
  fetched_at: '2026-07-31T00:00:00.000Z',
};

const candidateDatabase = {
  prepare(sql) {
    if (sql.includes('FROM candidate JOIN job')) return { get: () => candidate };
    if (sql.includes('FROM resume_online')) return { get: () => resume };
    throw new Error(`unexpected candidate preview SQL: ${sql}`);
  },
};
const candidateDbApi = {
  getCurrentJobProfileContext: () => profileContext,
};
assertPreview({
  database: candidateDatabase,
  dbApi: candidateDbApi,
  purpose: 'candidate-assessment',
  targetId: candidate.internal_id,
}, /建立数据核验流程并记录来源/, [candidate.name, '13812345678', 'synthetic@example.test']);

const deepDbApi = {
  getJobForFetch: () => job,
  getCurrentJobProfileContext: () => profileContext,
  listInterviews: () => [{
    id: 61,
    note: '岗位访谈',
    source_type: 'manual_transcript',
    created_at: '2026-07-31T00:00:00.000Z',
    transcript: '负责人要求核验数据来源。电话 13812345678，邮箱 synthetic@example.test。',
  }],
};
assertPreview({
  database: { prepare() { throw new Error('deep preview must not query candidate tables'); } },
  dbApi: deepDbApi,
  purpose: 'deep-profile',
  targetId: String(job.id),
}, /负责人要求核验数据来源/, ['13812345678', 'synthetic@example.test']);

const assessmentTables = new Set([
  'job_jd_version',
  'job_profile_version',
  'resume_online',
]);
const assessmentDatabase = {
  prepare(sql) {
    if (sql.includes("FROM sqlite_master WHERE type = 'table' AND name = ?")) {
      return { get: (name) => (assessmentTables.has(name) ? { present: 1 } : undefined) };
    }
    if (sql.includes('candidate.rec_position')) {
      return {
        get: () => ({
          internal_id: candidate.internal_id,
          job_id: job.id,
          name: candidate.name,
          rec_position: job.name,
          job_name: job.name,
          job_status: 'open',
        }),
      };
    }
    if (sql.includes('FROM job_jd_version')) {
      return { get: () => ({ id: 31, version: 1, jd_text: '负责合成数据核验。' }) };
    }
    if (sql.includes('FROM job_profile_version')) {
      return {
        get: () => ({
          id: 41,
          version: 1,
          jd_version_id: 31,
          config_json: JSON.stringify(profileConfig),
        }),
      };
    }
    if (sql.includes('FROM resume_online')) return { get: () => resume };
    if (sql.includes('FROM assessment_binding binding')) {
      return {
        all: () => [{
          id: 'assessment-document-1',
          version: 1,
          report_type: 'synthetic',
          assessment_date: '2026-07-30',
          analysis_schema_version: 'synthetic-v1',
          analysis_json: JSON.stringify({
            subject_name: candidate.name,
            summary: `${candidate.name} 在合成报告中完成证据核验。`,
          }),
          binding_id: 'assessment-binding-1',
          binding_version: 1,
        }],
      };
    }
    throw new Error(`unexpected assessment preview SQL: ${sql}`);
  },
};
assertPreview({
  database: assessmentDatabase,
  dbApi: {},
  purpose: 'assessment-ai-analysis',
  targetId: candidate.internal_id,
  materialInput: { jobId: job.id },
}, /合成报告中完成证据核验/, [candidate.name, 'subject_name', '13812345678', 'synthetic@example.test']);

console.log(JSON.stringify({
  ok: true,
  contract: 'external-ai-material-preview-001',
  purposes: [
    'candidate-assessment',
    'deep-profile',
    'assessment-ai-analysis',
  ],
  synthetic_data_only: true,
  exact_character_count: true,
  excluded_material_absent: true,
}));
