'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-profile-truth-'));
process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
process.env.BOSS_DB_PATH = path.join(ROOT, 'profile-truth.db');
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const db = require("../src/db");
const { externalAiMaterialHash } = require("../src/external-ai-material-hash");

;(async () => {
const database = db.openDb(process.env.BOSS_DB_PATH);
const actor = 'HR-PROFILE-TRUTH';
const job = db.upsertJob({
  encrypt_job_id: 'profile-truth-job',
  numeric_job_id: '202607160001',
  name: '画像真值纯合成岗位',
  hr_owner: actor,
});
const candidate = db.upsertCandidate({
  job_id: job.id,
  geek_id: 'profile-truth-candidate',
  source: 'synthetic_profile_truth',
  name: '纯合成候选人',
  geek_desc: '负责电商运营与直播增长',
});
db.insertResumeOnline({
  candidate_id: candidate.internal_id,
  sections_json: JSON.stringify({
    basic: [{ description: '本科，5 年电商运营经验' }],
    work: [{ company: 'Synthetic Co', title: '运营', description: '负责纯合成店铺增长' }],
    project: [], education: [], skill: [], expect: [],
  }),
  is_paywalled: 0,
  raw_json: '{}',
});

const jd1 = db.createJobJdVersion({ jobId: job.id, jdText: 'JD1：负责电商增长', actor });
db.activateJobJdVersion({ jdVersionId: jd1.id, expectedVersion: jd1.version, actor });
const forgedDeep = { status: 'confirmed', version: 999, hacked: true, doc: { mission: '伪造画像' } };
const profile1 = db.createJobProfileVersion({
  jobId: job.id,
  jdVersionId: jd1.id,
  actor,
  config: { rubric: 'JD1 已确认简版画像', hard_bars: {}, deep_profile: forgedDeep },
});
assert.equal(db.listJobProfileVersions(job.id).find((row) => row.id === profile1.id).config.deep_profile, undefined);
db.confirmJobProfileVersion({ profileVersionId: profile1.id, expectedVersion: profile1.version, actor });
assert.equal(db.getJobProfile(job.id).deep_profile, undefined, '客户端伪造 deep_profile 不得进入兼容投影');

const interview = db.insertInterview({
  job_id: job.id,
  transcript: '负责人：需要能独立负责电商增长并解释数据变化的人。',
});
const oldDeepDoc = { mission: 'JD1 深度画像', evidence: ['纯合成访谈'] };
const generated1 = await db.generateDeepProfileForJob(job.id, {
  generator: async ({ previousProfile }) => {
    assert.equal(previousProfile, null);
    return oldDeepDoc;
  },
});
assert.equal(generated1.bound_profile_version_id, profile1.id);
assert.equal(generated1.bound_jd_version_id, jd1.id);
assert.equal(generated1.stale_for_active_jd, false);
db.confirmDeepProfile(job.id, actor);

let assessorCalls = 0;
let assessorInput = null;
const assessor = async (input) => {
  assessorCalls += 1;
  assessorInput = input;
  return { schema_version: 'synthetic_candidate_report_v1', candidate_summary: {}, overall: '纯合成报告' };
};
await db.rateJob(job.id);
await db.runSecondOpinion(candidate.internal_id, { assessor });
assert.deepEqual(assessorInput.deepProfile, oldDeepDoc);
const materialHash1 = externalAiMaterialHash({
  database,
  dbApi: db,
  purpose: 'candidate-assessment',
  targetId: candidate.internal_id,
});

const script1 = {
  schema_version: 'interview_script_p0_v1',
  source_jd_version_id: jd1.id,
  source_profile_version_id: profile1.id,
  title: 'JD1 纯合成脚本',
};
db.saveInterviewScript({
  jobId: job.id,
  source: 'local_rule_from_jd_profile',
  script_json: JSON.stringify(script1),
  script_text: '# JD1 纯合成脚本',
});
assert.equal(db.getInterviewScript(job.id).current_for_active_jd, true);

const jd2 = db.createJobJdVersion({ jobId: job.id, jdText: 'JD2：负责直播电商增长', actor });
db.activateJobJdVersion({ jdVersionId: jd2.id, expectedVersion: jd2.version, actor });

assert.throws(
  () => db.getCurrentJobProfileContext(job.id),
  (error) => error && error.code === 'JOB_CURRENT_PROFILE_REQUIRED',
);
assert.throws(
  () => db.confirmJobProfileVersion({ profileVersionId: profile1.id, expectedVersion: profile1.version, actor }),
  /profile JD version is no longer active/,
);
assert.throws(
  () => externalAiMaterialHash({
    database,
    dbApi: db,
    purpose: 'candidate-assessment',
    targetId: candidate.internal_id,
  }),
  (error) => error && error.code === 'JOB_CURRENT_PROFILE_REQUIRED',
);
const workbenchAfterJdSwitch = db.getJobWorkbench(job.id);
assert.equal(workbenchAfterJdSwitch.jd.active.id, jd2.id);
assert.equal(workbenchAfterJdSwitch.profile.confirmed, null);
assert.equal(workbenchAfterJdSwitch.profile.stale_confirmed.id, profile1.id);
const projectedStaleDeep = db.getJobProfile(job.id).deep_profile;
assert.equal(projectedStaleDeep.stale_for_active_jd, true);
assert.equal(projectedStaleDeep.bound_profile_version_id, profile1.id);
assert.equal(projectedStaleDeep.bound_jd_version_id, jd1.id);
assert.deepEqual(projectedStaleDeep.doc, oldDeepDoc);
const historicalProfile1 = db.listJobProfileVersions(job.id).find((row) => row.id === profile1.id);
assert.equal(historicalProfile1.status, 'confirmed');
assert.equal(historicalProfile1.config.deep_profile.stale_for_active_jd, true);
assert.deepEqual(historicalProfile1.config.deep_profile.doc, oldDeepDoc);

const ratingBeforeBlockedRun = database.prepare(`
  SELECT sabc, sabc_source, verdict_label, updated_at FROM candidate WHERE internal_id = ?
`).get(candidate.internal_id);
await assert.rejects(
  db.rateJob(job.id),
  (error) => error && error.code === 'JOB_CURRENT_PROFILE_REQUIRED',
);
assert.deepEqual(database.prepare(`
  SELECT sabc, sabc_source, verdict_label, updated_at FROM candidate WHERE internal_id = ?
`).get(candidate.internal_id), ratingBeforeBlockedRun);

const callsBeforeBlock = assessorCalls;
await assert.rejects(
  db.runSecondOpinion(candidate.internal_id, { assessor }),
  (error) => error && error.code === 'JOB_CURRENT_PROFILE_REQUIRED',
);
assert.equal(assessorCalls, callsBeforeBlock, '画像不匹配时不得调用第二意见评估器');
let deepGeneratorCalls = 0;
await assert.rejects(
  db.generateDeepProfileForJob(job.id, { generator: async () => { deepGeneratorCalls += 1; return {}; } }),
  (error) => error && error.code === 'JOB_CURRENT_PROFILE_REQUIRED',
);
assert.equal(deepGeneratorCalls, 0, '画像不匹配时不得调用深画像生成器');
assert.throws(
  () => db.confirmDeepProfile(job.id, actor),
  (error) => error && error.code === 'JOB_CURRENT_PROFILE_REQUIRED',
);
assert.throws(
  () => db.saveInterviewScript({
    jobId: job.id,
    source: 'local_rule_from_jd_profile',
    script_json: JSON.stringify(script1),
    script_text: '# stale',
  }),
  (error) => error && error.code === 'JOB_CURRENT_PROFILE_REQUIRED',
);
assert.equal(db.getInterviewScript(job.id).stale_for_active_jd, true);
const blockedStatus = db.getAssessStatus(candidate.internal_id, {
  enabled: true, policy_valid: true, config_present: true, blockers: [], provider: 'local-mock', host: 'local',
});
assert.equal(blockedStatus.current_profile_ready, false);
assert.equal(blockedStatus.can_real_assess, false);
assert.equal(blockedStatus.can_local_demo, false);
assert.ok(blockedStatus.blockers.some((item) => item.includes('当前 JD')));

const profile2 = db.createJobProfileVersion({
  jobId: job.id,
  jdVersionId: jd2.id,
  actor,
  config: { rubric: 'JD2 已确认新画像', hard_bars: {}, deep_profile: forgedDeep },
});
assert.equal(db.listJobProfileVersions(job.id).find((row) => row.id === profile2.id).config.deep_profile, undefined);
db.confirmJobProfileVersion({ profileVersionId: profile2.id, expectedVersion: profile2.version, actor });
const current2 = db.getCurrentJobProfileContext(job.id);
assert.equal(current2.activeJd.id, jd2.id);
assert.equal(current2.profileVersion.id, profile2.id);
assert.equal(current2.config.rubric, 'JD2 已确认新画像');
assert.equal(current2.config.deep_profile, undefined, '旧深画像只能作为 stale 历史，不能叠加到新画像');
assert.equal(db.getJobProfile(job.id).deep_profile.stale_for_active_jd, true, '兼容投影继续保留 stale 深画像供追溯');
assert.deepEqual(
  db.listJobProfileVersions(job.id).find((row) => row.id === profile1.id).config.deep_profile.doc,
  oldDeepDoc,
);
const materialHash2 = externalAiMaterialHash({
  database,
  dbApi: db,
  purpose: 'candidate-assessment',
  targetId: candidate.internal_id,
});
assert.notEqual(materialHash2, materialHash1, '活动 JD/确认画像变化必须改变第二意见材料指纹');

await db.rateJob(job.id);
assessorInput = null;
const result2 = await db.runSecondOpinion(candidate.internal_id, { assessor });
assert.equal(assessorInput.rubric, 'JD2 已确认新画像');
assert.equal(assessorInput.deepProfile, null);
assert.equal(result2.report.deep_profile_missing, true);

const script2 = {
  schema_version: 'interview_script_p0_v1',
  source_jd_version_id: jd2.id,
  source_profile_version_id: profile2.id,
  title: 'JD2 纯合成脚本',
};
db.saveInterviewScript({
  jobId: job.id,
  source: 'local_rule_from_jd_profile',
  script_json: JSON.stringify(script2),
  script_text: '# JD2 纯合成脚本',
});
assert.equal(db.getInterviewScript(job.id).current_for_active_jd, true);

// Third-generation transition: the compatibility projection still contains
// p1's stale deep profile. Archiving p2/JD2 must not make p2 claim that deep.
const jd3 = db.createJobJdVersion({ jobId: job.id, jdText: 'JD3：负责全域电商增长', actor });
db.activateJobJdVersion({ jdVersionId: jd3.id, expectedVersion: jd3.version, actor });
assert.throws(
  () => db.getCurrentJobProfileContext(job.id),
  (error) => error && error.code === 'JOB_CURRENT_PROFILE_REQUIRED',
);
let versionsAfterJd3 = db.listJobProfileVersions(job.id);
assert.equal(
  versionsAfterJd3.find((row) => row.id === profile2.id).config.deep_profile,
  undefined,
  'p2 不得冒领仍绑定 p1/JD1 的 stale deep profile',
);
assert.deepEqual(
  versionsAfterJd3
    .filter((row) => row.config.deep_profile && row.config.deep_profile.doc && row.config.deep_profile.doc.mission === oldDeepDoc.mission)
    .map((row) => row.id),
  [profile1.id],
  'p1 deep profile 在版本历史中只能归属于 p1',
);
assert.equal(db.getJobProfile(job.id).deep_profile.bound_profile_version_id, profile1.id);
const callsBeforeJd3Block = assessorCalls;
await assert.rejects(
  db.rateJob(job.id),
  (error) => error && error.code === 'JOB_CURRENT_PROFILE_REQUIRED',
);
await assert.rejects(
  db.runSecondOpinion(candidate.internal_id, { assessor }),
  (error) => error && error.code === 'JOB_CURRENT_PROFILE_REQUIRED',
);
assert.equal(assessorCalls, callsBeforeJd3Block, 'JD3 未确认画像时不得调用第二意见评估器');
assert.equal(db.getInterviewScript(job.id).stale_for_active_jd, true);

const profile3 = db.createJobProfileVersion({
  jobId: job.id,
  jdVersionId: jd3.id,
  actor,
  config: { rubric: 'JD3 已确认新画像', hard_bars: {} },
});
db.confirmJobProfileVersion({ profileVersionId: profile3.id, expectedVersion: profile3.version, actor });
versionsAfterJd3 = db.listJobProfileVersions(job.id);
assert.equal(versionsAfterJd3.find((row) => row.id === profile2.id).config.deep_profile, undefined);
assert.deepEqual(
  versionsAfterJd3
    .filter((row) => row.config.deep_profile && row.config.deep_profile.doc && row.config.deep_profile.doc.mission === oldDeepDoc.mission)
    .map((row) => row.id),
  [profile1.id],
);

let newDeepPrevious = 'not-called';
const newDeepDoc = { mission: 'JD3 深度画像', evidence: ['新画像纯合成材料'] };
const generated3 = await db.generateDeepProfileForJob(job.id, {
  generator: async ({ previousProfile }) => {
    newDeepPrevious = previousProfile;
    return newDeepDoc;
  },
});
assert.equal(newDeepPrevious, null, '生成新 JD 深画像不得把 stale 深画像继续当当前迭代输入');
assert.equal(generated3.bound_profile_version_id, profile3.id);
assert.equal(generated3.bound_jd_version_id, jd3.id);
assert.equal(generated3.stale_for_active_jd, false);
db.confirmDeepProfile(job.id, actor);
assert.deepEqual(db.getCurrentJobProfileContext(job.id).config.deep_profile.doc, newDeepDoc);
assert.deepEqual(
  db.listJobProfileVersions(job.id).find((row) => row.id === profile1.id).config.deep_profile.doc,
  oldDeepDoc,
  '生成新深画像后，旧深画像仍应在旧 profile version 中可追溯',
);

const actionSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/action-server.js"), 'utf8');
assert.match(actionSource, /JOIN job_jd_version jd[\s\S]*jd\.status = 'active'/);
assert.match(actionSource, /const profileContext = db\.getCurrentJobProfileContext\(jobId\)/);
assert.match(actionSource, /source_profile_version_id = Number\(profileContext\.profileVersion\.id\)/);
assert.ok(
  actionSource.indexOf('const profileStatus = db.getAssessStatus')
    < actionSource.indexOf("currentExternalAiMaterialHash('candidate-assessment'"),
  '画像真值预检必须发生在第二意见一次性授权消费前',
);
const modalSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/DeepProfileModal.jsx'), 'utf8');
assert.match(modalSource, /历史画像 · 已因 JD\/画像切换失效/);
assert.match(modalSource, /不再参与当前评分、AI 第二意见或面试脚本/);
assert.match(modalSource, /!confirmed && !stale/);

assert.equal(interview.id > 0, true);
database.close();
console.log(JSON.stringify({
  ok: true,
  contract: 'profile-truth-001',
  stale_deep_profile_traceable: true,
  stale_profile_consumers_blocked: true,
  forged_deep_profile_ignored: true,
}));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
