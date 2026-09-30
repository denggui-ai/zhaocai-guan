#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  CATALOG_SCHEMA_VERSION,
  CATALOG_VERSION,
  ECOMMERCE_JOB_TEMPLATE_CATALOG: catalog,
} = require('./ecommerce-job-template-catalog');

const EXPECTED_FAMILIES = [
  ['content-new-media', '内容与新媒体运营', ['C1', 'C2', 'C4', 'C5']],
  ['ecommerce-customer-service', '电商客服序列', ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'H4']],
  ['domestic-ecommerce-operations', '国内电商运营', ['E1', 'E4', 'E5', 'E6', 'E7']],
  ['cross-border-ecommerce-operations', '跨境电商运营', ['E2', 'E8']],
  ['user-community-operations', '用户与社群运营', ['B3', 'B6']],
  ['general-operations-leadership', '综合运营职级序列', ['B1', 'H1', 'H2', 'H3']],
  ['live-operations-support', '直播运营与支持', ['C3', 'LS1', 'LS2']],
  ['commerce-live-host', '带货主播', ['A1']],
  ['ecommerce-visual-design', '电商视觉设计', ['V2', 'V5', 'V9']],
  ['human-resources', '人力资源', ['F1']],
  ['administration', '行政', ['F2']],
  ['accounting', '会计', ['M1']],
];

const EXPECTED_VARIANTS = [
  ['video-operations', '视频运营', ['C1']],
  ['new-media-operations', '新媒体运营', ['C2']],
  ['content-operations', '内容运营', ['C4']],
  ['wechat-operations', '微信运营', ['C5']],
  ['customer-service-specialist', '客服专员', ['S1']],
  ['customer-service-supervisor', '客服主管', ['S2']],
  ['customer-service-manager', '客服经理', ['S3']],
  ['online-customer-service', '网络客服', ['S4']],
  ['telephone-customer-service', '电话客服', ['S5']],
  ['after-sales-customer-service', '售后客服', ['S6']],
  ['pre-sales-customer-service', '售前客服', ['S7']],
  ['customer-service-director', '客服总监', ['H4']],
  ['domestic-ecommerce-operations-general', '国内电商运营', ['E1']],
  ['taobao-operations', '淘宝运营', ['E4']],
  ['tmall-operations', '天猫运营', ['E5']],
  ['jd-operations', '京东运营', ['E6']],
  ['pinduoduo-operations', '拼多多运营', ['E7']],
  ['cross-border-ecommerce-operations-general', '跨境电商运营', ['E2']],
  ['amazon-operations', '亚马逊运营', ['E8']],
  ['user-operations', '用户运营', ['B3']],
  ['community-operations', '社群运营', ['B6']],
  ['operations-assistant-specialist', '运营助理/专员', ['B1']],
  ['operations-manager-supervisor', '运营经理/主管', ['H1']],
  ['operations-director', '运营总监', ['H2']],
  ['chief-operating-officer', 'COO', ['H3']],
  ['live-operations', '直播运营', ['C3', 'LS1']],
  ['live-control-floor-assistant', '中控/场控/助播', ['LS2']],
  ['commerce-live-host', '带货主播', ['A1']],
  ['ecommerce-art-designer', '美工', ['V2']],
  ['visual-designer', '视觉设计师', ['V5']],
  ['packaging-designer', '包装设计', ['V9']],
  ['human-resources', '人力资源', ['F1']],
  ['administration', '行政', ['F2']],
  ['accounting', '会计', ['M1']],
];

function assertDeepFrozen(value, reference = 'catalog') {
  if (!value || typeof value !== 'object') return;
  assert.equal(Object.isFrozen(value), true, `${reference} must be read-only`);
  for (const [key, child] of Object.entries(value)) assertDeepFrozen(child, `${reference}.${key}`);
}

function draftText(variant) {
  return [
    ...variant.core_responsibilities_draft,
    ...variant.optional_responsibilities_draft,
    ...variant.job_requirements_draft.must_have,
    ...variant.job_requirements_draft.nice_to_have,
    variant.profile_draft.role_mission,
    ...variant.profile_draft.suggested_positive_signals,
    ...variant.profile_draft.points_to_verify,
    ...variant.interview_focus,
  ].join('');
}

assert.equal(CATALOG_SCHEMA_VERSION, 'ecommerce_job_template_catalog_v1');
assert.match(CATALOG_VERSION, /^\d{4}\.\d{2}\.\d{2}\.\d+$/);
assert.equal(catalog.schema_version, CATALOG_SCHEMA_VERSION);
assert.equal(catalog.catalog_version, CATALOG_VERSION);
assert.match(catalog.usage_notice, /HR 编辑确认/);
assert.match(catalog.usage_notice, /不生成评分、档位、硬门槛或候选人处置/);
assertDeepFrozen(catalog);

assert.equal(catalog.families.length, 12, 'owner selected exactly 12 families');
assert.deepEqual(
  catalog.families.map((family) => [family.family_key, family.display_name, family.source_codes]),
  EXPECTED_FAMILIES,
  'family grouping must match the owner-approved selection',
);

const variants = catalog.families.flatMap((family) => family.variants);
assert.equal(variants.length, 34, 'C3 and LS1 must merge into one live-operations variant');
assert.deepEqual(
  variants.map((item) => [item.variant_key, item.job_title, item.source_codes]),
  EXPECTED_VARIANTS,
  'variant catalog must preserve all selected Boss labels and only merge C3/LS1',
);

const familyKeys = catalog.families.map((family) => family.family_key);
const variantKeys = variants.map((item) => item.variant_key);
assert.equal(new Set(familyKeys).size, 12, 'family keys must be unique');
assert.equal(new Set(variantKeys).size, 34, 'variant keys must be unique');
assert.equal(variants.flatMap((item) => item.source_codes).length, 35, 'all 35 owner-selected source codes must remain traceable');
assert.equal(new Set(variants.map((item) => item.job_title)).size, 34, 'the duplicate live-operations title must be merged');

const variableDefinitions = catalog.hr_variable_definitions;
assert.ok(Object.keys(variableDefinitions).length >= 20, 'shared HR question dictionary must cover common merchant contexts');
for (const [key, definition] of Object.entries(variableDefinitions)) {
  assert.deepEqual(Object.keys(definition).sort(), ['label', 'prompt'], `${key} must contain questions, not preset facts`);
  assert.ok(definition.label.length >= 2 && definition.prompt.length >= 8, `${key} must be understandable to HR`);
}

const contentFingerprints = new Set();
const firstResponsibilityFingerprints = new Set();
const UNIVERSAL_HR_VARIABLES = [
  'team_context',
  'key_kpis',
  'salary_structure',
  'work_location',
  'work_schedule',
  'experience_expectation',
  'tool_stack',
  'must_have_preferences',
  'nice_to_have_preferences',
];
let draftCharacters = 0;
let minimumDraftCharacters = Infinity;
for (const item of variants) {
  assert.match(item.variant_key, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(Array.isArray(item.boss_category_hint) && item.boss_category_hint.length >= 2, `${item.variant_key} needs a Boss category path`);
  assert.equal(item.boss_category_hint.at(-1), item.job_title, `${item.variant_key} Boss hint must end at the selected job label`);
  assert.ok(item.core_responsibilities_draft.length >= 3, `${item.variant_key} needs distinct core responsibilities`);
  assert.ok(item.optional_responsibilities_draft.length >= 2, `${item.variant_key} must keep optional work separate`);
  assert.ok(item.job_requirements_draft.must_have.length >= 2, `${item.variant_key} needs editable must-have suggestions`);
  assert.ok(item.job_requirements_draft.nice_to_have.length >= 2, `${item.variant_key} must keep bonus items separate`);
  assert.ok(item.profile_draft.role_mission.length >= 20, `${item.variant_key} needs a usable profile mission`);
  assert.ok(item.profile_draft.suggested_positive_signals.length >= 3, `${item.variant_key} needs evidence-oriented profile signals`);
  assert.ok(item.profile_draft.points_to_verify.length >= 3, `${item.variant_key} needs explicit verification points`);
  assert.ok(item.interview_focus.length >= 3, `${item.variant_key} needs interview focus questions`);
  assert.ok(item.hr_variables.length >= 10, `${item.variant_key} must expose enough missing business facts`);
  assert.equal(new Set(item.hr_variables).size, item.hr_variables.length, `${item.variant_key} HR variables must not repeat`);
  for (const key of item.hr_variables) assert.ok(variableDefinitions[key], `${item.variant_key} references unknown HR variable ${key}`);
  for (const key of UNIVERSAL_HR_VARIABLES) {
    assert.ok(item.hr_variables.includes(key), `${item.variant_key} must ask HR to confirm ${key}`);
  }

  const text = draftText(item);
  draftCharacters += text.length;
  minimumDraftCharacters = Math.min(minimumDraftCharacters, text.length);
  assert.doesNotMatch(text, /\d+\s*(?:K|k|元|万元|千元)\b/, `${item.variant_key} must not invent salary facts`);
  assert.doesNotMatch(text, /(?:自动|直接)(?:淘汰|录用|推进|定档)|SABC|[SABC]档/, `${item.variant_key} must not contain automated decisions or rating rules`);
  const contentFingerprint = JSON.stringify({
    core: item.core_responsibilities_draft,
    optional: item.optional_responsibilities_draft,
    requirements: item.job_requirements_draft,
    profile: item.profile_draft,
    interview: item.interview_focus,
  });
  assert.equal(contentFingerprints.has(contentFingerprint), false, `${item.variant_key} must not copy another variant wholesale`);
  contentFingerprints.add(contentFingerprint);
  const firstResponsibility = item.core_responsibilities_draft[0];
  assert.equal(firstResponsibilityFingerprints.has(firstResponsibility), false, `${item.variant_key} must open with a role-specific responsibility`);
  firstResponsibilityFingerprints.add(firstResponsibility);

  const forbiddenKeys = new Set(['score', 'rating', 'sabc', 'auto_disposition', 'auto_reject', 'auto_advance', 'default_salary', 'default_location']);
  function assertNoForbiddenKey(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key.toLowerCase()), false, `${item.variant_key} contains forbidden automatic field ${key}`);
      assertNoForbiddenKey(child);
    }
  }
  assertNoForbiddenKey(item);
}

assert.equal(contentFingerprints.size, 34, 'every role variant must have independent content');
assert.ok(minimumDraftCharacters >= 250, 'every role needs a substantive draft, not a placeholder');

console.log(JSON.stringify({
  ok: true,
  contract: 'ECOM-TEMPLATE-CATALOG-001',
  schema_version: catalog.schema_version,
  catalog_version: catalog.catalog_version,
  family_count: catalog.families.length,
  variant_count: variants.length,
  owner_selected_source_code_count: variants.flatMap((item) => item.source_codes).length,
  unique_content_fingerprints: contentFingerprints.size,
  draft_characters: draftCharacters,
  minimum_variant_draft_characters: minimumDraftCharacters,
  deeply_frozen: true,
  database_access: false,
  network_access: false,
  automatic_rating_or_disposition: false,
}));
