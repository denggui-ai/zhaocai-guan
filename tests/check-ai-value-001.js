'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(file) {
  return fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
}

const app = read('frontend/src/App.jsx');
const dashboard = read('frontend/src/components/DashboardPanel.jsx');
const guide = read('frontend/src/components/WorkflowGuidePanel.jsx');
const styles = read('frontend/src/styles.css');
const prompt = read('frontend/src/components/ExternalAiFirstUsePrompt.jsx');
const jobManagement = read('frontend/src/components/JobManagementPanel.jsx');
const deepProfile = read('frontend/src/components/DeepProfileModal.jsx');
const candidateDetail = read('frontend/src/components/CandidateDetail.jsx');
const assessment = read('frontend/src/components/AssessmentArchivePanel.jsx');
const interview = read('frontend/src/components/InterviewReviewPanel.jsx');

[
  'AI 优化 JD',
  '深度岗位画像',
  '候选人 AI 初评',
  '测评综合分析',
  '面试 AI 复盘',
].forEach((label) => assert.ok(guide.includes(`title: '${label}'`), `missing AI capability: ${label}`));

assert.match(guide, /系统亮点 · AI 招聘助手/);
assert.match(guide, /AI 不替你做决定，而是提供有证据的第二意见/);
assert.match(guide, /AI 在招聘流程中如何帮助你/);
assert.match(guide, /在哪里用/);
assert.match(guide, /你会得到/);
assert.match(guide, /AI 辅助/);
assert.match(guide, /HR 确认/);
assert.doesNotMatch(guide, /ai-value-privacy|外部 AI 默认关闭；启用后每次发送前仍需 HR 确认/);
assert.match(guide, /S\/A\/B\/C、HC 统计和人才库反查不是 AI 自动决策/);
assert.match(guide, /deriveAiValueSuggestion/);
assert.match(guide, /INTERVIEW_TODO_CODES\.has\(code\)/);
for (const label of ['打开职位管理', '打开候选人', '打开面试安排']) {
  assert.match(guide, new RegExp(`action: '${label}'`),
    `guide actions must describe their real module-level destination: ${label}`);
}
assert.doesNotMatch(guide, /action: '(?:去优化 JD|去看测评|去面试复盘|去岗位台账|完善 JD\/画像|处理候选人|查看面试安排|回到候选人)'/,
  'guide must not promise an in-module deep link when only module navigation occurs');

assert.match(dashboard, /import \{ AiValueSummary, WorkflowGuideSummary \}/);
assert.ok((dashboard.match(/<AiValueSummary/g) || []).length >= 5, 'AI value summary must survive dashboard loading and empty states');
assert.match(app, /onOpenDeepProfile=\{handleOpenDeepProfileFromGuide\}/);
assert.match(app, /PRIMARY_NAV_ITEMS = \['工作台', '职位管理', '候选人', '面试安排', '人才库'\]/);
assert.match(app, /UTILITY_NAV_ITEMS = \['使用指南', '设置', '关于\/版本', '本机状态'\]/);
assert.doesNotMatch(guide, /Tour|driver\.js|intro\.js|localStorage/);
assert.match(styles, /\.ai-value-summary/);
assert.match(styles, /\.ai-capability-grid/);
const emptyState = dashboard.slice(
  dashboard.indexOf("if (!jobId || loadState === 'idle')"),
  dashboard.indexOf("if (loadState === 'loading'", dashboard.indexOf("if (!jobId || loadState === 'idle')")),
);
assert.ok(
  emptyState.indexOf('dashboard-first-job-card') < emptyState.indexOf('可选：了解 5 项 AI 辅助能力'),
  'new-job CTA must precede optional AI guidance in the empty workbench',
);
assert.equal((emptyState.match(/type="primary"/g) || []).length, 1, 'new job must be the only primary CTA in the empty workbench');
assert.match(emptyState, /<Alert type="success" showIcon message="本地工作台可用"/);

for (const label of ['启用并继续', '继续手动处理', '查看发送边界']) {
  assert.match(prompt, new RegExp(label));
}
for (const capability of ['job_jd', 'deep_profile', 'candidate_assessment', 'assessment_analysis', 'interview_review']) {
  assert.match(prompt, new RegExp(`${capability}: \\{`), `shared first-use prompt must define ${capability}`);
}
for (const [source, capability] of [
  [jobManagement, 'job_jd'],
  [deepProfile, 'deep_profile'],
  [candidateDetail, 'candidate_assessment'],
  [assessment, 'assessment_analysis'],
  [interview, 'interview_review'],
]) {
  assert.match(source, /ExternalAiFirstUsePrompt/);
  assert.match(source, new RegExp(`capability="${capability}"`));
}

console.log(JSON.stringify({
  ok: true,
  contract: 'AI-VALUE-001',
  real_ai_capabilities_presented: 5,
  contextual_dashboard_recommendation: true,
  hr_confirmation_boundary: true,
  workbench_warning_noise_removed: true,
  new_navigation: false,
  new_backend: false,
  new_data_model: false,
  new_dependency: false,
}));
