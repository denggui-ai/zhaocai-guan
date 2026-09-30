'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-jd-profile-binding-'));
const DB_PATH = path.join(ROOT, 'binding.db');
process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
process.env.BOSS_DB_PATH = DB_PATH;
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

const db = require("../src/db");
const { buildAssessmentAiInput } = require("../src/assessment-ai-analysis");

const database = db.openDb(DB_PATH, { assessmentEnabled: true });
const job = db.upsertJob({
  encrypt_job_id: 'jd-profile-binding-job',
  numeric_job_id: '202607140099',
  name: 'JD 画像绑定纯合成岗位',
  hr_owner: 'HR-BINDING',
});
const candidate = db.upsertCandidate({
  job_id: job.id,
  geek_id: 'jd-profile-binding-candidate',
  source: 'synthetic_jd_profile_binding',
  name: '纯合成候选人',
  rec_position: '运营',
});

database.prepare(`
  INSERT INTO assessment_document (
    id, content_sha256, storage_relpath, byte_size, page_count, mime_detected,
    security_state, report_type, assessment_date, analysis_status,
    analysis_schema_version, analysis_json, review_state, lifecycle_state,
    legal_hold_state, created_by, version, created_at, updated_at
  ) VALUES (
    'DOC-JD-PROFILE-BINDING', ?, 'accepted/jd-profile-binding.pdf', 128, 1, 'application/pdf',
    'accepted', 'career_potential', '2026-07-14', 'ready',
    'assessment_report_analysis_v2', ?, 'ready', 'active',
    'none', 'HR-BINDING', 1, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
  )
`).run('a'.repeat(64), JSON.stringify({
  schema_version: 'assessment_report_analysis_v2',
  report_type: 'career_potential',
  summary: '纯合成测评证据',
  career_matches: [{ category: '市场类', name: '运营', percentage: 80 }],
}));
database.prepare(`
  INSERT INTO assessment_binding (
    id, document_id, candidate_id, job_id, scope, state, conflict_state,
    identity_basis, actor_id, reason_code, request_id, version, created_at, updated_at
  ) VALUES (
    'BIND-JD-PROFILE', 'DOC-JD-PROFILE-BINDING', ?, ?, 'candidate_job_archive',
    'active', 'none', 'current_candidate_context', 'HR-BINDING', 'synthetic_test',
    'REQ-JD-PROFILE-BINDING', 1, '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:00.000Z'
  )
`).run(candidate.internal_id, job.id);

const jd1 = db.createJobJdVersion({
  jobId: job.id,
  jdText: 'JD1 纯合成职责',
  actor: 'HR-BINDING',
});
db.activateJobJdVersion({ jdVersionId: jd1.id, expectedVersion: jd1.version, actor: 'HR-BINDING' });
const profile1 = db.createJobProfileVersion({
  jobId: job.id,
  jdVersionId: jd1.id,
  config: { rubric: 'JD1 纯合成画像' },
  actor: 'HR-BINDING',
});
db.confirmJobProfileVersion({ profileVersionId: profile1.id, expectedVersion: profile1.version, actor: 'HR-BINDING' });
const oldDraft = db.createJobProfileVersion({
  jobId: job.id,
  jdVersionId: jd1.id,
  config: { rubric: 'JD1 未确认草稿' },
  actor: 'HR-BINDING',
});

let workbench = db.getJobWorkbench(job.id);
assert.equal(workbench.profile.confirmed.id, profile1.id);
assert.equal(workbench.profile.confirmed.jd_version_id, jd1.id);
const input1 = buildAssessmentAiInput(database, candidate.internal_id, job.id);
assert.equal(input1.payload.job.jd_text, 'JD1 纯合成职责');
assert.equal(input1.payload.job.rubric, 'JD1 纯合成画像');
assert.equal(input1.input_sha256.length, 64);

const jd2 = db.createJobJdVersion({
  jobId: job.id,
  jdText: 'JD2 纯合成新职责',
  actor: 'HR-BINDING',
});
db.activateJobJdVersion({ jdVersionId: jd2.id, expectedVersion: jd2.version, actor: 'HR-BINDING' });

workbench = db.getJobWorkbench(job.id);
assert.equal(workbench.jd.active.id, jd2.id);
assert.equal(workbench.profile.confirmed, null, '旧 JD 的 confirmed profile 不得算当前有效');
assert.equal(workbench.profile.stale, true);
assert.equal(workbench.profile.stale_confirmed.id, profile1.id);
assert.equal(workbench.profile.versions.find((row) => row.id === profile1.id).stale_for_active_jd, true);
assert.equal(workbench.profile.versions.find((row) => row.id === oldDraft.id).stale_for_active_jd, true);
const profileTodo = workbench.todos.find((todo) => todo.code === 'job_profile_confirmation_required');
assert.ok(profileTodo, '切换 JD 后必须有重新确认画像待办');
assert.equal(profileTodo.priority, 'high');
assert.equal(profileTodo.blocking, true);
assert.equal(profileTodo.source.status, 'stale_for_active_jd');
assert.throws(
  () => db.confirmJobProfileVersion({ profileVersionId: oldDraft.id, expectedVersion: oldDraft.version, actor: 'HR-BINDING' }),
  /profile JD version is no longer active/,
);
assert.throws(
  () => buildAssessmentAiInput(database, candidate.internal_id, job.id),
  (error) => error.code === 'ASSESSMENT_AI_CURRENT_PROFILE_REQUIRED',
  '测评 AI 不得将 active JD2 与 JD1 画像混用',
);

const profile2 = db.createJobProfileVersion({
  jobId: job.id,
  jdVersionId: jd2.id,
  config: { rubric: 'JD2 纯合成新画像' },
  actor: 'HR-BINDING',
});
db.confirmJobProfileVersion({ profileVersionId: profile2.id, expectedVersion: profile2.version, actor: 'HR-BINDING' });
workbench = db.getJobWorkbench(job.id);
assert.equal(workbench.profile.confirmed.id, profile2.id);
assert.equal(workbench.profile.confirmed.jd_version_id, jd2.id);
assert.equal(workbench.profile.stale, false);
assert.equal(workbench.todos.some((todo) => todo.code === 'job_profile_confirmation_required'), false);
assert.equal(db.listJobProfileVersions(job.id).find((row) => row.id === profile1.id).status, 'superseded');
assert.equal(db.listJobProfileVersions(job.id).find((row) => row.id === oldDraft.id).status, 'draft', '旧草稿保留可恢复');

const input2 = buildAssessmentAiInput(database, candidate.internal_id, job.id);
assert.equal(input2.payload.job.jd_text, 'JD2 纯合成新职责');
assert.equal(input2.payload.job.rubric, 'JD2 纯合成新画像');
assert.notEqual(input2.input_sha256, input1.input_sha256, '切换 JD/画像必须使旧 AI 输入指纹失效');

const panelSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/JobManagementPanel.jsx'), 'utf8');
assert.match(panelSource, /当前 JD 还没有已确认的岗位画像/);
assert.match(panelSource, /row\.status === 'draft' && !row\.stale_for_active_jd/);
assert.match(panelSource, /绑定的不是当前 JD，请载入后另存新草稿/);
assert.match(panelSource, /jdText\.trim\(\) === lastSavedJdText/);
assert.match(panelSource, /profileDraftSignature !== lastSavedProfileSignature/);
assert.match(panelSource, /setLastSavedJdText\(null\)/);
assert.match(panelSource, /setLastSavedProfileSignature\(null\)/);
assert.match(panelSource, /当前针对千川\/电商岗位提示，其他岗位仅作基础检查/);
assert.match(panelSource, /const operationEpochRef = useRef\(0\)/);
assert.match(panelSource, /if \(!operationIsCurrent\(operation\)\) return false/);
assert.match(panelSource, /if \(!operationIsCurrent\(operation\)\) return;/);
assert.match(panelSource, /if \(operationIsCurrent\(operation\)\) setBusy\(''\)/);

database.close();
console.log(JSON.stringify({
  ok: true,
  contract: 'active-jd-confirmed-profile-binding-v1',
  stale_history_recoverable: true,
  assessment_ai_mixing_blocked: true,
}));
