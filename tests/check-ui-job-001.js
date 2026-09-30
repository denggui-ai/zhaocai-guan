'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const path = require('path');

const panel = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/JobManagementPanel.jsx'), 'utf8');
const app = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/App.jsx'), 'utf8');

// HR uses Chinese fields and explicit draft actions instead of raw JSON/version-state jargon.
['岗位职责', '必须条件', '加分项', '淘汰项'].forEach((label) => assert.match(panel, new RegExp(label)));
assert.match(panel, /保存 JD 草稿/);
assert.match(panel, /保存岗位画像草稿/);
assert.match(panel, /保存不会自动启用/);
assert.match(panel, /保存不会自动确认/);
assert.doesNotMatch(panel, /保存并启用 JD|保存并确认岗位画像/);

// Natural-language HR input is optimized into an editable draft only after native confirmation.
assert.match(panel, /先用平常说话描述招聘需求/);
assert.match(panel, /AI 优化成 JD 草稿/);
assert.match(panel, /confirmExternalAiApproval\(\s*'job-jd-optimization'/);
assert.match(panel, /api\.optimizeJobJd/);
assert.match(panel, /只生成草稿，不保存、不启用/);
assert.match(panel, /候选人搜索关键词建议/);
assert.match(panel, /非任何招聘渠道官方权重或排名承诺/);
assert.match(panel, /analyzeJdRecommendationRisk/);
assert.match(panel, /AI 改写可能漏掉了原始要求/);
assert.match(panel, /恢复 AI 前文本/);
assert.match(panel, /setJdBeforeAi\(jdTextRef\.current\)/);
assert.match(panel, /setJdText\(jdBeforeAi\)/);
assert.match(panel, /复制 JD/);
assert.doesNotMatch(panel, /profileText|JSON\.parse\(profile|新建 draft|设为 active/);

// Saving creates a draft only. Activation/confirmation remain separate, recoverable history actions.
const jdSave = panel.slice(panel.indexOf('async function saveJdDraft'), panel.indexOf('async function saveProfileDraft'));
assert.match(jdSave, /api\.createJobJdVersion/);
assert.doesNotMatch(jdSave, /activateJobJdVersion/);
const profileSave = panel.slice(panel.indexOf('async function saveProfileDraft'), panel.indexOf('function loadJdForEditing'));
assert.match(profileSave, /api\.createJobProfileVersion/);
assert.doesNotMatch(profileSave, /confirmJobProfileVersion/);
assert.match(panel, /api\.activateJobJdVersion/);
assert.match(panel, /api\.confirmJobProfileVersion/);
assert.match(panel, /载入查看\/修改/);
assert.match(panel, /创建新草稿，不覆盖历史/);

// Empty profiles are blocked; four readable fields and a Chinese rubric are retained.
assert.match(panel, /profileHasContent\(profileForm\)/);
assert.match(panel, /岗位画像至少填写一项/);
assert.match(panel, /responsibilities: textLines/);
assert.match(panel, /must_haves: textLines/);
assert.match(panel, /nice_to_haves: textLines/);
assert.match(panel, /deal_breakers: textLines/);
assert.match(panel, /rubric: preserved\.rubric \|\| profileRubric/);

// Editing a template profile retains its assessment policy and system-authored
// supplements, while the client still cannot carry the system-owned deep
// profile projection.
[
  'suggested_positive_signals',
  'points_to_verify',
  'interview_focus',
  'hr_context',
  'missing_hr_fields',
].forEach((field) => assert.match(panel, new RegExp(field)));
assert.match(panel, /preservedProfileMetadata\(row\.config\)/);
assert.match(panel, /buildProfileConfig\(profileForm, hardBarForm, assessmentPolicy, profileBaseConfig\)/);
assert.match(panel, /模板原始补充说明/);
assert.doesNotMatch(panel, /PRESERVED_PROFILE_METADATA_FIELDS[\s\S]{0,300}deep_profile/);

// Objective bars are structured Chinese inputs, default off, and unknown facts stay manual-review only.
['客观门槛（默认关闭）', '学历门槛', '薪资门槛', '城市门槛'].forEach((label) => assert.match(panel, new RegExp(label)));
assert.match(panel, /mode="multiple"/);
assert.match(panel, /mode="tags"/);
assert.match(panel, /Unknown 时只提示人工确认，不判不符合/);
assert.match(panel, /hardBarValidation/);
assert.equal((panel.match(/enabled: false/g) || []).length, 3);

// Advisory deal breakers must not become automatic rating or disposition gates.
assert.match(panel, /仅供 HR 判断，不自动淘汰/);
assert.doesNotMatch(panel, /applyManualCandidateAction|changeCandidateStatus|recordF018Disposition/);

// Failed loads/actions stay visible, and version recovery remains available in a secondary area.
assert.match(panel, /职位数据读取失败/);
assert.match(panel, /错误不会被当作空数据/);
assert.match(panel, /操作未完成/);
assert.match(panel, /<Collapse\s+ghost[\s\S]{0,180}items=\{jdHistory\}/);
assert.match(panel, /<Collapse\s+ghost[\s\S]{0,180}items=\{profileHistory\}/);
assert.match(panel, /activeKey=\{jdHistoryActiveKeys\}/);
assert.match(panel, /activeKey=\{profileHistoryActiveKeys\}/);
assert.doesNotMatch(panel, /defaultActiveKey=\{pending(?:Jd|Profile)Draft/);
assert.match(panel, /waitingProfileDraft/);
assert.match(panel, /linkedJd\?\.status === 'draft'/);
assert.match(panel, /岗位画像草稿正在等待对应 JD/);
assert.match(panel, /启用此版本/);
assert.match(panel, /确认此版本/);
assert.match(panel, /草稿/);
assert.match(panel, /使用中/);
assert.match(panel, /已确认/);
assert.match(panel, /历史版本/);

// Leaving the editor through every user-facing route is guarded by one
// explicit confirmation; saved version actions inside the editor stay direct.
assert.match(panel, /onDirtyChange\(editorDirty\)/);
assert.match(app, /confirmDiscardJobEditorChanges/);
assert.match(app, /JD 或岗位画像/);
assert.match(app, /title: `\$\{scopeLabel\}还有未保存草稿`/);
const jobChangeGuard = app.slice(
  app.indexOf('async function handleJobChange'),
  app.indexOf('async function handleOpenTalentCandidate'),
);
assert.match(jobChangeGuard, /confirmDiscardUnsavedChanges/);
const openSettingsGuard = app.slice(
  app.indexOf('async function handleOpenSettings'),
  app.indexOf('async function handleOpenDesktopUtility'),
);
assert.match(openSettingsGuard, /confirmDiscardUnsavedChanges/);
const openNavGuard = app.slice(
  app.indexOf('async function handleOpenNav'),
  app.indexOf('async function handleReturnJobLedger'),
);
assert.match(openNavGuard, /confirmDiscardUnsavedChanges/);
const returnLedgerGuard = app.slice(
  app.indexOf('async function handleReturnJobLedger'),
  app.indexOf('async function handleOpenCandidateTaskTodo'),
);
assert.match(returnLedgerGuard, /confirmDiscardJobEditorChanges/);
assert.equal(
  (app.match(/onReturnLedger=\{handleReturnJobLedger\}/g) || []).length,
  2,
  '正式与 fixture 职位工作区都必须接入同一返回台账守卫',
);
assert.match(app, /onDirtyChange=\{handleJobEditorDirtyChange\}/);

console.log('check-ui-job-001 ok');
