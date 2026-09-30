'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
const operations = read('frontend/src/components/CandidateJourneyOperationsPanel.jsx');
const candidateDetail = read('frontend/src/components/CandidateDetail.jsx');
const dashboard = read('frontend/src/components/DashboardPanel.jsx');
const jobLedger = read('frontend/src/components/JobLedgerPanel.jsx');
const app = read('frontend/src/App.jsx');
const api = read('frontend/src/api.js');
const finalReview = read('frontend/src/components/ApplicationFinalReviewPanel.jsx');

[
  '下一步与日期',
  '用人负责人反馈',
  'Offer 与入职交接',
  '不会自动联系候选人',
  '不会自动生成薪酬、自动发送消息、自动录用',
].forEach((text) => assert.ok(operations.includes(text), `missing journey operations copy: ${text}`));

assert.ok(candidateDetail.includes('<CandidateJourneyOperationsPanel'));
assert.ok(candidateDetail.includes('onDirtyChange={setJourneyOperationsDirty}'));
assert.ok(candidateDetail.includes('onBusyChange={setJourneyOperationsBusy}'));
assert.ok(operations.includes('loadSequenceRef'));
assert.ok(operations.includes('activeContextRef'));
assert.ok(operations.includes('draftTouchedRef'));
assert.ok(operations.includes('authorityLoaded'));
assert.ok(operations.includes('authorityLoadFailed'));
assert.ok(operations.includes('成功前不会提交默认表单'));
assert.ok(operations.includes('retryAuthorityLoad'));
assert.ok(operations.includes('stableDraftRequest'));
assert.ok(operations.includes('直接重试会复用同一请求 ID'));
assert.ok(operations.includes('preserveEditedGeneratedDraft'));
assert.equal((operations.match(/request_id: draftRequest\.request_id/g) || []).length, 3);
assert.equal((operations.match(/request_id: requestId\(/g) || []).length, 0);
assert.ok(operations.includes('操作已经保存，但最新记录读取失败'));
assert.ok(operations.includes('请勿重复提交'));
assert.ok(operations.includes("const status = state?.offer?.status;"));
assert.ok(operations.includes('state.offer_history.map'));
assert.ok(operations.includes('Offer 变更记录'));
assert.ok(!operations.includes('offerDraft.status || state?.offer?.status'));
assert.ok(operations.includes('aria-label="Offer 沟通草稿"'));
assert.ok(!operations.includes('<Input.TextArea value={offerCopy} readOnly'));
assert.ok(api.includes("'/candidate-journey-operations'"));
assert.ok(api.includes("operationalReadGet(`/candidate-journey-operations"));
assert.ok(api.includes("actionPost('/candidate-journey/next-action'"));
assert.ok(api.includes("actionPost('/candidate-journey/manager-feedback'"));
assert.ok(api.includes("actionPost('/candidate-journey/offer-status'"));
assert.ok(app.includes("open_candidate_flow: { domain: 'flow'"));
[
  'candidate_next_action_due',
  'candidate_next_action_overdue',
  'offer_send_followup_required',
  'offer_response_followup_required',
  'offer_negotiation_followup_required',
  'onboarding_handoff_required',
].forEach((code) => {
  assert.ok(candidateDetail.includes(`${code}: '`), `missing flow todo label: ${code}`);
  assert.ok(
    candidateDetail.includes(`${code}: { kind: 'domain', domain: 'flow'`),
    `missing flow primary action: ${code}`,
  );
});
assert.ok(dashboard.includes('candidate_next_action_overdue'));
assert.ok(dashboard.includes('onboarding_handoff_required'));
assert.ok(jobLedger.includes('JOB_CLOSE_REASON_OPTIONS'));
assert.ok(jobLedger.includes('已接受 Offer'));
assert.ok(jobLedger.includes('已移交入职'));
assert.ok(jobLedger.includes('onboarding_handoff_count'));
assert.ok(jobLedger.includes('jobReachedHiringTarget'));
assert.ok(jobLedger.includes('招聘达标，关闭岗位'));
assert.ok(jobLedger.includes('不会自动关闭'));
assert.ok(jobLedger.includes('jobCloseReasonLabel'));
assert.ok(jobLedger.includes('close_reason_code'));
assert.ok(jobLedger.includes('close_note'));
assert.ok(jobLedger.includes('<Form form={closeForm}'));
assert.ok(jobLedger.includes("rules={[{ required: true, message: '请选择关闭原因后再确认。' }]}"));
assert.ok(jobLedger.includes('closeForm.validateFields()'));
assert.ok(jobLedger.includes('关闭原因：'));
assert.ok(!jobLedger.includes("setError('关闭岗位前请选择关闭原因。')"));
assert.ok(finalReview.includes('复用当前已获批的 AI 测评分析'));
assert.ok(finalReview.includes('不含分数和自动处置建议'));

console.log('check-hr-journey-operations-ui-001: ok');
