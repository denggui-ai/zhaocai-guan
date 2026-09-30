'use strict';

const {
  CATALOG_SCHEMA_VERSION,
  CATALOG_VERSION,
  ECOMMERCE_JOB_TEMPLATE_CATALOG,
} = require('./ecommerce-job-template-catalog');

const ALLOWED_INPUT_KEYS = new Set([
  'templateKey',
  'variantKey',
  'name',
  'hrOwner',
  'plannedHires',
  'department',
  'location',
  'hrFields',
]);
const HR_FIELD_MAX_LENGTH = 2000;
const HR_FIELDS_TOTAL_MAX_LENGTH = 20000;

function flowError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, '\n').trim();
}

function requiredText(value, field, maxLength) {
  if (typeof value !== 'string') {
    throw flowError('JOB_TEMPLATE_INPUT_INVALID', `${field}必须是文本。`);
  }
  const normalized = normalizeLineEndings(value);
  if (!normalized) throw flowError('JOB_TEMPLATE_INPUT_INVALID', `${field}不能为空。`);
  if (normalized.length > maxLength) {
    throw flowError('JOB_TEMPLATE_INPUT_INVALID', `${field}不能超过 ${maxLength} 个字符。`);
  }
  return normalized;
}

function optionalText(value, field, maxLength) {
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    throw flowError('JOB_TEMPLATE_INPUT_INVALID', `${field}必须是文本。`);
  }
  const normalized = normalizeLineEndings(value);
  if (normalized.length > maxLength) {
    throw flowError('JOB_TEMPLATE_INPUT_INVALID', `${field}不能超过 ${maxLength} 个字符。`);
  }
  return normalized || null;
}

function resolveTemplate(templateKey, variantKey) {
  const normalizedTemplateKey = requiredText(templateKey, 'templateKey', 120);
  const normalizedVariantKey = requiredText(variantKey, 'variantKey', 120);
  const family = ECOMMERCE_JOB_TEMPLATE_CATALOG.families
    .find((item) => item.family_key === normalizedTemplateKey);
  if (!family) {
    throw flowError('JOB_TEMPLATE_NOT_FOUND', `找不到预置岗位族：${normalizedTemplateKey}`, 404);
  }
  const variant = family.variants.find((item) => item.variant_key === normalizedVariantKey);
  if (!variant) {
    throw flowError(
      'JOB_TEMPLATE_VARIANT_NOT_FOUND',
      `岗位变体 ${normalizedVariantKey} 不属于岗位族 ${normalizedTemplateKey}。`,
      404,
    );
  }
  return { family, variant };
}

function normalizeHrFields(value, variant, location) {
  if (value !== undefined && !isPlainObject(value)) {
    throw flowError('JOB_TEMPLATE_INPUT_INVALID', 'hrFields 必须是普通对象。');
  }
  const allowed = new Set(variant.hr_variables);
  const normalized = {};
  let totalLength = 0;
  for (const [key, raw] of Object.entries(value || {})) {
    if (!allowed.has(key)) {
      throw flowError('JOB_TEMPLATE_HR_FIELD_INVALID', `岗位模板不接受 HR 字段：${key}`);
    }
    if (typeof raw !== 'string') {
      throw flowError('JOB_TEMPLATE_HR_FIELD_INVALID', `HR 字段 ${key} 必须是文本。`);
    }
    const text = normalizeLineEndings(raw);
    if (text.length > HR_FIELD_MAX_LENGTH) {
      throw flowError('JOB_TEMPLATE_HR_FIELD_INVALID', `HR 字段 ${key} 不能超过 ${HR_FIELD_MAX_LENGTH} 个字符。`);
    }
    totalLength += text.length;
    if (totalLength > HR_FIELDS_TOTAL_MAX_LENGTH) {
      throw flowError('JOB_TEMPLATE_HR_FIELD_INVALID', `HR 补充字段总长度不能超过 ${HR_FIELDS_TOTAL_MAX_LENGTH} 个字符。`);
    }
    if (text) normalized[key] = text;
  }
  if (allowed.has('work_location') && !normalized.work_location && location) {
    normalized.work_location = location;
  }
  return normalized;
}

function linesSection(title, items) {
  if (!Array.isArray(items) || !items.length) return [];
  return [`## ${title}`, ...items.map((item) => `- ${item}`), ''];
}

function hrFactLines(variant, hrFields) {
  return variant.hr_variables
    .filter((key) => hrFields[key])
    .map((key) => `- ${ECOMMERCE_JOB_TEMPLATE_CATALOG.hr_variable_definitions[key].label}：${hrFields[key]}`);
}

function missingHrFieldLabels(variant, hrFields) {
  return variant.hr_variables
    .filter((key) => !hrFields[key])
    .map((key) => ({
      key,
      ...ECOMMERCE_JOB_TEMPLATE_CATALOG.hr_variable_definitions[key],
    }));
}

function buildJdText(jobName, variant, hrFields, missingFields) {
  const lines = [
    `# ${jobName}`,
    '',
    '## 岗位目标',
    variant.profile_draft.role_mission,
    '',
    ...linesSection('核心职责', variant.core_responsibilities_draft),
    ...linesSection('可选职责（请由 HR 确认是否纳入）', variant.optional_responsibilities_draft),
    ...linesSection('建议必须项（请由 HR 核实，不会自动成为系统硬门槛）', variant.job_requirements_draft.must_have),
    ...linesSection('加分项', variant.job_requirements_draft.nice_to_have),
  ];
  const facts = hrFactLines(variant, hrFields);
  if (facts.length) lines.push('## HR 已补充的业务事实', ...facts, '');
  if (missingFields.length) {
    lines.push(
      '## 正式使用前待 HR 补充',
      ...missingFields.map((item) => `- ${item.label}：${item.prompt}`),
      '',
    );
  }
  lines.push('> 本文是本地预置草稿，需由 HR 核对、编辑并单独启用；不会自动发布到 Boss。');
  return lines.join('\n').trim();
}

function buildProfileConfig(variant, hrFields, missingFields) {
  const facts = hrFactLines(variant, hrFields).map((line) => line.replace(/^- /, ''));
  const rubricSections = [
    `岗位目标：${variant.profile_draft.role_mission}`,
    `建议关注的证据：${variant.profile_draft.suggested_positive_signals.join('；')}`,
    `待核实：${variant.profile_draft.points_to_verify.join('；')}`,
    `面试关注点：${variant.interview_focus.join('；')}`,
  ];
  if (facts.length) rubricSections.push(`HR 已补充事实：${facts.join('；')}`);
  if (missingFields.length) rubricSections.push(`待 HR 补充：${missingFields.map((item) => item.label).join('、')}`);

  return {
    schema_version: 'manual_job_profile_v1',
    responsibilities: [...variant.core_responsibilities_draft],
    must_haves: [...variant.job_requirements_draft.must_have],
    nice_to_haves: [...variant.job_requirements_draft.nice_to_have],
    deal_breakers: [],
    rubric: rubricSections.join('\n'),
    suggested_positive_signals: [...variant.profile_draft.suggested_positive_signals],
    points_to_verify: [...variant.profile_draft.points_to_verify],
    interview_focus: [...variant.interview_focus],
    hr_context: { ...hrFields },
    missing_hr_fields: missingFields.map((item) => item.key),
    hard_bars: {
      degree: { enabled: false, allowed: ['本科', '硕士', '博士', '研究生'] },
      salary: { enabled: false, cap_k: 30 },
      city: { enabled: false, allowed: [] },
    },
  };
}

function prepareEcommerceTemplateDraft(input = {}) {
  if (!isPlainObject(input)) {
    throw flowError('JOB_TEMPLATE_INPUT_INVALID', '模板创建参数必须是普通对象。');
  }
  const unknownKeys = Object.keys(input).filter((key) => !ALLOWED_INPUT_KEYS.has(key));
  if (unknownKeys.length) {
    throw flowError('JOB_TEMPLATE_INPUT_INVALID', `模板创建不接受字段：${unknownKeys.join('、')}`);
  }

  const { family, variant } = resolveTemplate(input.templateKey, input.variantKey);
  const name = input.name === undefined
    ? variant.job_title
    : requiredText(input.name, '岗位名称', 120);
  const hrOwner = requiredText(input.hrOwner, 'HR 负责人', 80);
  const plannedHires = Number(input.plannedHires);
  if (!Number.isSafeInteger(plannedHires) || plannedHires < 1 || plannedHires > 10000) {
    throw flowError('JOB_TEMPLATE_INPUT_INVALID', '计划 HC 必须是 1 到 10000 之间的整数。');
  }
  const department = optionalText(input.department, '部门', 120);
  const location = optionalText(input.location, '工作地点', 120);
  const hrFields = normalizeHrFields(input.hrFields, variant, location);
  const missingFields = missingHrFieldLabels(variant, hrFields);
  const sourceRef = {
    kind: 'ecommerce_job_template',
    catalog_schema_version: CATALOG_SCHEMA_VERSION,
    catalog_version: CATALOG_VERSION,
    template_key: family.family_key,
    variant_key: variant.variant_key,
    source_codes: [...variant.source_codes],
    boss_category_hint: [...variant.boss_category_hint],
    provided_hr_fields: variant.hr_variables.filter((key) => Boolean(hrFields[key])),
    missing_hr_fields: missingFields.map((item) => item.key),
  };

  return {
    job: {
      name,
      hr_owner: hrOwner,
      planned_hires: plannedHires,
      department,
      location,
      status: 'draft',
      source_type: 'local_db',
    },
    jd_text: buildJdText(name, variant, hrFields, missingFields),
    profile_config: buildProfileConfig(variant, hrFields, missingFields),
    source_ref: sourceRef,
    template: {
      template_key: family.family_key,
      template_name: family.display_name,
      variant_key: variant.variant_key,
      variant_name: variant.job_title,
      catalog_version: CATALOG_VERSION,
      missing_hr_fields: missingFields,
    },
  };
}

function publicEcommerceTemplateCatalog() {
  return {
    schema_version: CATALOG_SCHEMA_VERSION,
    catalog_version: CATALOG_VERSION,
    usage_notice: ECOMMERCE_JOB_TEMPLATE_CATALOG.usage_notice,
    hr_variable_definitions: Object.fromEntries(
      Object.entries(ECOMMERCE_JOB_TEMPLATE_CATALOG.hr_variable_definitions)
        .map(([key, definition]) => [key, { label: definition.label, prompt: definition.prompt }]),
    ),
    families: ECOMMERCE_JOB_TEMPLATE_CATALOG.families.map((family) => ({
      family_key: family.family_key,
      display_name: family.display_name,
      variants: family.variants.map((variant) => ({
        variant_key: variant.variant_key,
        job_title: variant.job_title,
        source_codes: [...variant.source_codes],
        boss_category_hint: [...variant.boss_category_hint],
        core_responsibilities_draft: [...variant.core_responsibilities_draft],
        optional_responsibilities_draft: [...variant.optional_responsibilities_draft],
        job_requirements_draft: {
          must_have: [...variant.job_requirements_draft.must_have],
          nice_to_have: [...variant.job_requirements_draft.nice_to_have],
        },
        profile_draft: {
          role_mission: variant.profile_draft.role_mission,
          suggested_positive_signals: [...variant.profile_draft.suggested_positive_signals],
          points_to_verify: [...variant.profile_draft.points_to_verify],
        },
        interview_focus: [...variant.interview_focus],
        hr_variables: [...variant.hr_variables],
      })),
    })),
  };
}

module.exports = {
  prepareEcommerceTemplateDraft,
  publicEcommerceTemplateCatalog,
  resolveTemplate,
};
