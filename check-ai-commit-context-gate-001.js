'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-ai-commit-context-'));
process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
process.env.BOSS_DB_PATH = path.join(ROOT, 'synthetic.db');
process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED = '0';

const db = require('./db');
const ACTOR = 'AUDIT-SYNTHETIC-AI-COMMIT';

function setupJob(key) {
  const job = db.upsertJob({
    encrypt_job_id: `synthetic-${key}`,
    numeric_job_id: `synthetic-${key}`,
    name: `合成岗位 ${key}`,
    hr_owner: ACTOR,
  });
  const jd = db.createJobJdVersion({ jobId: job.id, jdText: `合成 JD ${key}`, actor: ACTOR });
  db.activateJobJdVersion({ jdVersionId: jd.id, expectedVersion: jd.version, actor: ACTOR });
  const profile = db.createJobProfileVersion({
    jobId: job.id,
    jdVersionId: jd.id,
    actor: ACTOR,
    config: { rubric: `合成画像 ${key}` },
  });
  db.confirmJobProfileVersion({ profileVersionId: profile.id, expectedVersion: profile.version, actor: ACTOR });
  return job;
}

function setupCandidate(job, key) {
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: `synthetic-candidate-${key}`,
    source: 'synthetic_ai_commit_context',
    name: `合成候选人 ${key}`,
  });
  db.insertResumeOnline({
    candidate_id: candidate.internal_id,
    sections_json: { work: [{ description: `合成简历 ${key}` }] },
    is_paywalled: 0,
    raw_json: '{}',
  });
  return candidate;
}

;(async () => {
  try {
    db.openDb(process.env.BOSS_DB_PATH);

    const closedDeepJob = setupJob('deep-close');
    db.insertInterview({ job_id: closedDeepJob.id, transcript: '合成负责人访谈 deep-close' });
    await assert.rejects(
      db.generateDeepProfileForJob(closedDeepJob.id, {
        generator: async () => {
          db.updateJobStatus({ jobId: closedDeepJob.id, status: 'closed', closeReason: 'other', actor: ACTOR });
          return { mission: '关闭岗位后不得保存' };
        },
      }),
      (error) => error && error.code === 'JOB_CLOSED' && error.statusCode === 409,
    );
    assert.equal(db.getJobProfile(closedDeepJob.id).deep_profile, undefined);

    const closedAssessJob = setupJob('assess-close');
    const closedCandidate = setupCandidate(closedAssessJob, 'assess-close');
    await assert.rejects(
      db.runSecondOpinion(closedCandidate.internal_id, {
        assessor: async () => {
          db.updateJobStatus({ jobId: closedAssessJob.id, status: 'closed', closeReason: 'other', actor: ACTOR });
          return { schema_version: 'synthetic_v1', candidate_summary: {}, overall: '不得保存' };
        },
      }),
      (error) => error && error.code === 'JOB_CLOSED' && error.statusCode === 409,
    );
    assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM ai_review WHERE candidate_id = ?').get(closedCandidate.internal_id).n, 0);

    const changedDeepJob = setupJob('deep-material-change');
    db.insertInterview({ job_id: changedDeepJob.id, transcript: '合成负责人访谈 v1' });
    await assert.rejects(
      db.generateDeepProfileForJob(changedDeepJob.id, {
        generator: async () => {
          db.insertInterview({ job_id: changedDeepJob.id, transcript: '生成期间新增的合成负责人访谈 v2' });
          return { mission: '旧输入结果不得保存' };
        },
      }),
      (error) => error && error.code === 'JOB_PROFILE_CONTEXT_CHANGED' && error.statusCode === 409,
    );
    assert.equal(db.getJobProfile(changedDeepJob.id).deep_profile, undefined);

    const changedAssessJob = setupJob('assess-material-change');
    const changedCandidate = setupCandidate(changedAssessJob, 'assess-material-change');
    await assert.rejects(
      db.runSecondOpinion(changedCandidate.internal_id, {
        assessor: async () => {
          db.insertResumeOnline({
            candidate_id: changedCandidate.internal_id,
            sections_json: { work: [{ description: '评估期间更新的合成简历' }] },
            is_paywalled: 0,
            raw_json: '{}',
          });
          return { schema_version: 'synthetic_v1', candidate_summary: {}, overall: '旧输入结果不得保存' };
        },
      }),
      (error) => error && error.code === 'CANDIDATE_ASSESSMENT_CONTEXT_CHANGED' && error.statusCode === 409,
    );
    assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM ai_review WHERE candidate_id = ?').get(changedCandidate.internal_id).n, 0);

    console.log(JSON.stringify({
      ok: true,
      contract: 'AI-COMMIT-CONTEXT-GATE-001',
      synthetic_only: true,
      network_used: false,
      closed_deep_profile_write_blocked: true,
      closed_assessment_write_blocked: true,
      changed_interview_context_blocked: true,
      changed_resume_context_blocked: true,
    }));
  } finally {
    try { db.conn().close(); } catch {}
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
