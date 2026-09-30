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
const candidates = read('frontend/src/components/CandidateList.jsx');
const candidateDetail = read('frontend/src/components/CandidateDetail.jsx');
const finalReview = read('frontend/src/components/ApplicationFinalReviewPanel.jsx');
const interview = read('frontend/src/components/InterviewReviewPanel.jsx');
const styles = read('frontend/src/styles.css');

assert.match(app, /UTILITY_NAV_ITEMS = \['使用指南', '设置', '关于\/版本', '本机状态'\]/);
assert.match(app, /activeNav === '使用指南'/);
assert.match(app, /<WorkflowGuidePanel/);
assert.match(dashboard, /<WorkflowGuideSummary/);
assert.match(dashboard, /先建立一个岗位，工作台才会显示这个岗位的候选人和待办/);

[
  '建立招聘岗位',
  '启用 JD 并确认画像',
  '导入候选人',
  '筛选并人工处置',
  '安排面试并复盘',
  '完成 HR 决定',
].forEach((label) => assert.ok(guide.includes(`title: '${label}'`), `missing workflow step: ${label}`));
assert.match(guide, /let currentIndex = 0/);
assert.match(guide, /missingJobSetup/);
assert.match(guide, /hasInterviewTodo/);
assert.match(guide, /hasDecisionTodo/);
assert.match(guide, /所有推进、淘汰和录用决定都由 HR 完成/);
assert.match(guide, /按来源选择上传简历建档或导入 Boss App 截图/);
assert.match(guide, /候选人 → 候选人操作 → 导入 Boss App 截图/);
assert.match(guide, /职位管理 → 管理 JD\/画像 → 查看深度画像/);
assert.doesNotMatch(guide, /顶部操作菜单/);
assert.match(guide, /截图先生成 OCR 待人工校对草稿，顶部显示待校对数量/);
assert.match(guide, /上传简历经 HR 校对确认后进入候选人列表/);
assert.match(guide, /截图草稿也须 HR 确认后才入库/);
assert.match(guide, /可能属于专用截图岗位，系统不会自动切换当前岗位/);
assert.match(guide, /attention: 'S\/A\/B\/C 来自确定性规则或 HR 人工评级；AI 不自动评级，也不改变排序或替 HR 作决定。'/);
assert.match(guide, /系统会记住上次岗位，但操作前仍要核对/);
assert.match(guide, /由 HR 记录时间、地点或会议链接及候选人确认状态/);
assert.match(guide, /邀约话术只是可编辑草稿，不会自动发送/);
assert.match(guide, /S\/A\/B\/C 来自确定性规则或 HR 人工评级，AI 只辅助写草稿/);
assert.doesNotMatch(guide, /S\/A\/B\/C 只由规则产生/);
assert.doesNotMatch(guide, /尾空格|路径恢复|DIRECTORY_/);
assert.doesNotMatch(guide, /Tour|driver\.js|intro\.js|localStorage/);
assert.match(styles, /\.workflow-guide-rail/);
assert.match(styles, /grid-template-columns:\s*repeat\(6,/);

assert.match(candidates, /onSelectionInvalidated/);
assert.match(candidates, /selectedId && !selectedVisible/);
assert.match(app, /const clearCandidateSelection = useCallback/);
assert.match(app, /detailRequestRef\.current\.invalidate\(\)/);

assert.match(finalReview, /const \[loadError, setLoadError\] = useState\(''\)/);
assert.match(finalReview, /当前状态未知，为避免重复建立申请或错误处置，写入入口已暂停/);
assert.match(finalReview, /onWorkflowChanged\(candidate\.internal_id, candidate\.job_id\)/);
assert.match(candidateDetail, /if \(onWorkflowChanged\) await onWorkflowChanged\(candidate\.internal_id, candidate\.job_id\)/);
assert.match(candidateDetail, /title="HR 人工处置"/);
assert.match(candidateDetail, /import ApplicationFinalReviewPanel from/);
assert.match(candidateDetail, /final_review_required: \{ kind: 'domain', domain: 'final-review', label: '打开结构化终评' \}/);
assert.match(candidateDetail, /<ApplicationFinalReviewPanel/);

assert.match(interview, /function sessionOnlyReportUnits/);
assert.match(interview, /const reportUnitCount = records\.length \+ sessionOnlyUnits\.length/);
assert.match(interview, /sessionConfirmedCount/);
assert.match(interview, /recordCount: reportUnitCount/);
assert.match(interview, /报告 \$\{reportCount\}\/\$\{reportUnitCount\} 份/);

console.log(JSON.stringify({
  ok: true,
  contract: 'HR-WORKFLOW-GUIDE-001',
  workflow_steps: 6,
  first_run_empty_db_guidance: true,
  contextual_next_step: true,
  candidate_entry_points_documented: 2,
  screenshot_pending_review_boundary: true,
  deterministic_or_hr_rating_boundary: true,
  interview_logistics_and_manual_send_boundary: true,
  remembered_job_requires_recheck: true,
  stale_candidate_detail_guard: true,
  structured_final_review_reachable: true,
  manual_disposition_primary: true,
  session_report_summary_unified: true,
  new_data_model: false,
  new_dependency: false,
}));
