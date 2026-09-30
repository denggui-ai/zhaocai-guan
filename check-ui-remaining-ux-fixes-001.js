'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const app = read('frontend/src/App.jsx');
const candidate = read('frontend/src/components/CandidateDetail.jsx');
const dashboard = read('frontend/src/components/DashboardPanel.jsx');
const interviews = read('frontend/src/components/InterviewScheduleCanonical.jsx');
const ledger = read('frontend/src/components/JobLedgerPanel.jsx');

assert.match(candidate, /尚未选择候选人[\s\S]*从候选人列表选择后[\s\S]*前往候选人列表/,
  'candidate empty detail must explain the state and provide an explicit next action');
assert.match(candidate, /onChooseCandidate[\s\S]*<Button type="primary" onClick=\{onChooseCandidate\}>/,
  'candidate empty detail CTA must be wired to a callback');
assert.match(app, /function focusCandidateChooser\(\)[\s\S]*CANDIDATE_LIST_PANEL_ID[\s\S]*role="option"[\s\S]*input\[aria-label="搜索候选人"\]/,
  'the candidate empty-state CTA must restore the list and move focus to a usable chooser');
assert.match(app, /candidate=\{null\}[\s\S]*onChooseCandidate=\{focusCandidateChooser\}/,
  'the App candidate empty branch must provide the chooser callback');

assert.match(dashboard, /title="仅重新读取当前工作台"[\s\S]*onClick=\{onRetry\}>刷新工作台<\/Button>/,
  'page refresh must name its current-workbench scope');
assert.equal((ledger.match(/暂无变更记录/g) || []).length, 2,
  'job table and compact cards must explain an empty recent-change value');
assert.match(ledger, /className="job-ledger-hero-title" aria-hidden="true">职位管理<\/Title>/,
  'the visible duplicate job title must defer heading semantics to the module H1');

assert.match(interviews, /key: 'session-create',[\s\S]*label: '新建面试'/,
  'creating an interview must have its own task disclosure');
assert.match(interviews, /key: 'interviewer-directory',[\s\S]*label: '管理面试官'/,
  'interviewer administration must have its own task disclosure');
assert.match(interviews, /label: '面试资料与录音工具'/,
  'secondary interview tools must use HR task language');
assert.doesNotMatch(interviews, /新建 Session 与面试官名录|二级工具：本地录音与音视频导入|当前 Session|历史 Session|正式 Session/,
  'visible interview copy must not expose internal Session hierarchy language');

console.log(JSON.stringify({
  ok: true,
  contract: 'UI-REMAINING-UX-FIXES-001',
  candidate_empty_state_actionable: true,
  workbench_refresh_scoped: true,
  job_empty_change_explained: true,
  interview_tasks_split: true,
  internal_session_copy_removed: true,
}));
