#!/usr/bin/env node
'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function read(relative) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relative), 'utf8');
}

const ledger = read('frontend/src/components/JobLedgerPanel.jsx');
const manager = read('frontend/src/components/JobManagementPanel.jsx');
const api = read('frontend/src/api.js');

// The formal job ledger is the only template entry; readonly mode exposes no create control.
assert.match(ledger, /!readOnly && \(\s*<Space wrap>/);
assert.match(ledger, /空白新建/);
assert.match(ledger, /从预置岗位开始/);
assert.doesNotMatch(manager, /预置岗位族|createJobFromTemplate/);

// Catalog reads and atomic creation use the guarded action service routes.
assert.match(api, /listEcommerceJobTemplates: \(\) => actionGet\('\/job-templates\/ecommerce'\)/);
assert.match(api, /createJobFromTemplate: \(input\) => actionPost\('\/jobs\/from-template', input\)/);
assert.match(ledger, /api\.listEcommerceJobTemplates\(\)/);
assert.match(ledger, /api\.createJobFromTemplate\(\{/);

// The renderer only submits trusted keys plus HR facts; it cannot replace server-owned template content.
const createFlow = ledger.slice(
  ledger.indexOf('async function createTemplateJob'),
  ledger.indexOf('async function createJob'),
);
['templateKey', 'variantKey', 'name', 'hrOwner', 'plannedHires', 'department', 'location', 'hrFields']
  .forEach((field) => assert.match(createFlow, new RegExp(`${field}:`), `missing ${field}`));
assert.doesNotMatch(createFlow, /jdText|jd_text|profileConfig|profile_config|responsibilities_draft/);

// One grouped search covers all variants without making family/platform/level look like separate models.
assert.match(ledger, /templateVariantCount/);
assert.match(ledger, /templateFamilies\.map\(\(family\) => \(\{[\s\S]*options: family\.variants\.map/);
assert.match(ledger, /aria-label="搜索预置具体岗位"/);
assert.match(ledger, /岗位族只是查找分组，不是平台或职级/);
assert.doesNotMatch(ledger, /aria-label="预置岗位族"|aria-label="预置岗位变体"/);

// Basic facts stay visible while the remaining variant questions use progressive disclosure.
assert.match(ledger, /selectedTemplateVariant\?\.hr_variables/);
assert.match(ledger, /visibleTemplateVariables\.slice\(0, PRIMARY_TEMPLATE_FACT_COUNT\)/);
assert.match(ledger, /visibleTemplateVariables\.slice\(PRIMARY_TEMPLATE_FACT_COUNT\)/);
assert.match(ledger, /TemplateVariableFields fieldKeys=\{primaryTemplateVariables\}/);
assert.match(ledger, /TemplateVariableFields fieldKeys=\{deferredTemplateVariables\}/);
assert.match(ledger, /其余 \$\{deferredTemplateVariables\.length\} 项岗位事实（可创建后补充）/);
assert.match(ledger, /templateVariableDefinitions\.work_location\?\.prompt/);
assert.match(ledger, /尚未确定可以留空，服务端会标为待补充/);
assert.match(ledger, /预览职责、要求与画像草稿/);

// Switching variants removes every preserved dynamic HR fact instead of merging an empty object.
assert.match(ledger, /templateForm\.resetFields\(\['hrFields'\]\)/);
assert.match(ledger, /templateForm\.setFieldValue\('hrFields', undefined\)/);
assert.doesNotMatch(ledger, /function selectTemplateJob[\s\S]*?templateForm\.setFieldsValue\(\{[\s\S]*?hrFields: \{\}[\s\S]*?\}\);/);

// Draft semantics are explicit: creation has no AI, publishing, activation or confirmation side effect.
assert.match(ledger, /不会启用 JD、不会确认画像，也不会调用 AI/);
assert.match(ledger, /创建岗位和两份草稿/);
assert.match(ledger, /await onJobsChanged\(response\.job\.id\)/);
assert.doesNotMatch(createFlow, /optimizeJobJd|activateJobJdVersion|confirmJobProfileVersion|syncBossJobs/);

// After the committed write refreshes, HR gets an explicit next step and the existing guarded AI JD path remains intact.
assert.match(createFlow, /let refreshed = false[\s\S]*await onJobsChanged\(response\.job\.id\)[\s\S]*refreshed = true/);
assert.match(createFlow, /if \(refreshed\) offerJobSetupNextStep\(response\.job, 'template'\)/);
assert.match(ledger, /function offerJobSetupNextStep\(job, sourceKind\)[\s\S]*modal\.confirm\([\s\S]*继续完善 JD\/画像[\s\S]*onOk: \(\) => openJob\(job\)/);
assert.match(ledger, /AI 优化 JD 仍可使用，但只会生成可编辑草稿，并会在每次发送前要求你确认/);
assert.match(manager, /confirmExternalAiApproval\(\s*'job-jd-optimization'/);
assert.match(manager, /api\.optimizeJobJd/);
assert.match(manager, /只生成草稿，不保存、不启用/);

// Both entry points reuse a client request ID across an ambiguous failure/retry,
// focus the first invalid field, and never lead a newly closed job into a read-only dead end.
assert.match(ledger, /const createRequestIdRef = useRef\(''\)/);
assert.match(ledger, /const templateCreateRequestIdRef = useRef\(''\)/);
assert.match(createFlow, /createRequestId: templateCreateRequestIdRef\.current/);
assert.match(ledger, /values = \{[\s\S]*createRequestId: createRequestIdRef\.current[\s\S]*api\.createLocalJob\(values\)/);
assert.match(ledger, /function focusFirstValidationError[\s\S]*scrollToField\(firstInvalidName[\s\S]*getFieldInstance\(firstInvalidName\).*focus/);
assert.match(ledger, /if \(focusFirstValidationError\(templateForm, err\)\) return/);
assert.match(ledger, /if \(focusFirstValidationError\(form, err\)\) return/);
assert.match(ledger, /if \(job\.status === 'closed'\) return/);
assert.match(ledger, /if \(refreshed\) offerJobSetupNextStep\(response\.job, 'blank'\)/);
assert.match(ledger, /已新建岗位.*JOB_STATUS\[response\.job\.status\]/);
assert.match(ledger, /style=\{\{ minWidth: 0, width: '100%', maxWidth: '100%' \}\}/);

// Loading, empty/error and post-create refresh failures remain visible instead of masquerading as success.
assert.match(ledger, /templateCatalogState === 'loading'/);
assert.match(ledger, /templateCatalogState === 'error'/);
assert.match(ledger, /错误不会被当作空目录/);
assert.match(ledger, /草稿创建未完成/);
assert.match(ledger, /岗位已经创建，但台账自动刷新失败/);

// A paired profile draft waiting on its draft JD is not mislabeled as stale or forced to duplicate.
assert.match(manager, /linkedJd\?\.status === 'draft' && !jd\.active/);
assert.match(manager, /待启用对应 JD；启用后可直接确认这份画像草稿，不必另存/);
assert.match(manager, /waitsForLinkedDraftJd \? 'draft'/);
assert.match(manager, /loadProfileForEditing\(row, waitsForLinkedDraftJd\)/);
assert.match(manager, /绑定的是尚未启用的 JD 草稿；先启用对应 JD 后可直接确认这份画像草稿；若要编辑，请在启用 JD 后再保存/);
assert.match(manager, /row\.status === 'draft' && !row\.stale_for_active_jd && !waitsForLinkedDraftJd/);
assert.match(manager, /已有 JD 草稿待检查并启用/);
assert.match(manager, /已有岗位画像草稿待确认/);
assert.match(manager, /activeKey=\{jdHistoryActiveKeys\}/);
assert.match(manager, /activeKey=\{profileHistoryActiveKeys\}/);

console.log(JSON.stringify({
  ok: true,
  contract: 'ECOM-TEMPLATE-FLOW-001-ui',
  ledger_entry_only: true,
  readonly_hidden: true,
  trusted_template_keys_only: true,
  grouped_variant_search: true,
  progressive_hr_questions: true,
  variant_hr_facts_cleared: true,
  atomic_draft_copy: true,
  no_publish_activate_confirm_or_ai: true,
  ai_jd_path_preserved: true,
  explicit_post_create_next_step: true,
  create_request_id_reused_on_retry: true,
  invalid_field_focused: true,
  closed_job_dead_end_avoided: true,
  ledger_can_shrink_to_viewport: true,
  paired_draft_state_clear: true,
  premature_profile_confirmation_hidden: true,
  pending_template_history_expanded: true,
  loading_and_error_states_visible: true,
}));
