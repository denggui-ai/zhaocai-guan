const SCHEMA_VERSION = 'interview_report_v1';
const REPORT_DISCLAIMER = '本报告仅基于已关联面试材料生成，须经 HR 人工确认，不代表自动录用、淘汰、排序或处置。';
const { redactTranscriptForExternalAi } = require('./interview-transcript-cues');

const UNKNOWN_REASON_CODES = new Set([
  'not_mentioned',
  'unclear',
  'conflict',
  'not_applicable',
]);

const FORBIDDEN_FIELD_ALIASES = new Set([
  'age', 'candidateage', '年龄',
  'dateofbirth', 'birthdate', 'birthday', 'birthyear', 'dob', '出生日期', '出生年月', '出生年份', '出生时间', '生日',
  'gender', 'genderidentity', 'biologicalsex', 'sex', '性别', '生理性别',
  'maritalstatus', 'marriagestatus', 'maritalhistory', 'marriage', 'married', 'familystatus', '婚姻', '婚姻状况', '婚姻状态', '婚育', '婚配',
  'pregnancystatus', 'pregnancy', 'pregnant', 'fertility', 'reproductivestatus', 'childbearing', 'maternity', 'childstatus', '孕育', '怀孕', '生育', '备孕', '子女情况',
  'ethnicity', 'raceethnicity', 'ethnicgroup', 'race', '民族', '民族信息', '族裔', '种族',
  'religion', 'religiousbelief', 'religiousaffiliation', 'faith', '宗教', '宗教信仰', '信仰',
  'health', 'healthstatus', 'healthcondition', 'medical', 'medicalhistory', 'medicalcondition', 'disability', 'disabilitystatus', 'disabled', '健康', '健康状况', '身体状况', '身心健康', '病史', '疾病史', '残疾', '残障', '伤残',
  'politicalaffiliation', 'politicalstatus', 'politicalview', 'partymembership', '政治面貌', '政治身份', '党派', '党员',
]);

const FORBIDDEN_DECISION_ALIASES = new Set([
  'fitscore', 'overallscore', 'totalscore', 'qualityscore', 'sabc', 'tier',
  'rank', 'ranking', 'candidateorder', 'hire', 'hiringdecision', 'reject',
  'autoreject', 'autohire', 'decision', 'decisionsupport', 'recommendation',
  'disposition', 'action', 'autoaction', '处置', '录用决定', '淘汰决定', '候选人排序', '综合分',
]);

class InterviewReportValidationError extends Error {
  constructor(code, path, message = '面试报告校验失败。') {
    super(message);
    this.name = 'InterviewReportValidationError';
    this.code = code;
    this.path = path || '$';
    this.statusCode = ['STALE_VERSION', 'REPORT_SOURCES_STALE'].includes(code) ? 409 : 400;
  }

  toPublicError() {
    return { code: this.code, path: this.path, error: this.message };
  }
}

function fail(code, path, message) {
  throw new InterviewReportValidationError(code, path, message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fieldAlias(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-./\\:：()（）\[\]{}]+/g, '');
}

function assertNoForbiddenFields(value, path = '$') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFields(item, `${path}[${index}]`));
    return;
  }
  Object.entries(value).forEach(([key, child]) => {
    const nextPath = `${path}.${key}`;
    const alias = fieldAlias(key);
    if (FORBIDDEN_FIELD_ALIASES.has(alias)) {
      fail('FORBIDDEN_FIELD', nextPath, '面试报告包含不允许的人事字段。');
    }
    if (FORBIDDEN_DECISION_ALIASES.has(alias)) {
      fail('FORBIDDEN_DECISION_FIELD', nextPath, '面试报告不得包含评分、排序、处置或自动决策字段。');
    }
    assertNoForbiddenFields(child, nextPath);
  });
}

function parseReportJson(value) {
  if (typeof value === 'string') {
    if (!value.trim()) fail('INVALID_JSON', '$', '面试报告不是合法 JSON。');
    try {
      return JSON.parse(value);
    } catch {
      fail('INVALID_JSON', '$', '面试报告不是合法 JSON。');
    }
  }
  if (!isPlainObject(value)) fail('TYPE_MISMATCH', '$', '面试报告顶层必须是 JSON 对象。');
  return value;
}

function assertObject(value, path) {
  if (!isPlainObject(value)) fail('TYPE_MISMATCH', path, '字段类型不符合 interview_report_v1。');
}

function assertArray(value, path, maxItems = 20) {
  if (!Array.isArray(value)) fail('TYPE_MISMATCH', path, '字段类型不符合 interview_report_v1。');
  if (value.length > maxItems) fail('ARRAY_TOO_LARGE', path, '数组超过 interview_report_v1 上限。');
}

function assertString(value, path, options = {}) {
  if (typeof value !== 'string') fail('TYPE_MISMATCH', path, '字段类型不符合 interview_report_v1。');
  const min = options.min === undefined ? 1 : options.min;
  const max = options.max === undefined ? 1000 : options.max;
  if (value.trim().length < min || value.length > max) {
    fail('STRING_LENGTH_INVALID', path, '文本长度不符合 interview_report_v1。');
  }
}

function assertInteger(value, path) {
  if (!Number.isInteger(value)) fail('TYPE_MISMATCH', path, '字段类型不符合 interview_report_v1。');
}

function assertExactKeys(value, path, required, optional = []) {
  assertObject(value, path);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('ADDITIONAL_PROPERTY', `${path}.${key}`, '字段不属于 interview_report_v1。');
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail('REQUIRED_FIELD', `${path}.${key}`, '缺少 interview_report_v1 必填字段。');
  }
}

function assertId(value, path) {
  assertString(value, path, { max: 96 });
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(value)) {
    fail('ID_FORMAT_INVALID', path, '标识符格式不符合 interview_report_v1。');
  }
}

function mergedContinuousTimeRanges(value) {
  const ranges = Array.isArray(value) ? value : [];
  const valid = ranges
    .filter((range) => (
      range
      && Number.isInteger(range.start_ms)
      && Number.isInteger(range.end_ms)
      && range.start_ms >= 0
      && range.end_ms > range.start_ms
    ))
    .map((range) => ({ start_ms: range.start_ms, end_ms: range.end_ms }))
    .sort((left, right) => left.start_ms - right.start_ms || left.end_ms - right.end_ms);
  const merged = [];
  valid.forEach((range) => {
    const current = merged[merged.length - 1];
    if (!current || range.start_ms > current.end_ms) {
      merged.push(range);
      return;
    }
    current.end_ms = Math.max(current.end_ms, range.end_ms);
  });
  return merged;
}

function validateSpan(span, path, material) {
  assertObject(span, path);
  if (span.type === 'text_span') {
    assertExactKeys(span, path, ['type', 'start', 'end']);
    assertInteger(span.start, `${path}.start`);
    assertInteger(span.end, `${path}.end`);
    if (span.start < 0 || span.end <= span.start) {
      fail('EVIDENCE_SPAN_INVALID', path, '证据区间无效。');
    }
    if (typeof material.text !== 'string' || span.end > material.text.length) {
      fail('EVIDENCE_SPAN_OUT_OF_RANGE', path, '证据区间超出材料边界。');
    }
    return;
  }
  if (span.type === 'time_span') {
    assertExactKeys(span, path, ['type', 'start_ms', 'end_ms']);
    assertInteger(span.start_ms, `${path}.start_ms`);
    assertInteger(span.end_ms, `${path}.end_ms`);
    if (span.start_ms < 0 || span.end_ms <= span.start_ms) {
      fail('EVIDENCE_SPAN_INVALID', path, '证据区间无效。');
    }
    const ranges = Array.isArray(material.time_ranges) ? material.time_ranges : [];
    if (!ranges.length) fail('EVIDENCE_TIME_UNAVAILABLE', path, '该材料没有可验证时间轴。');
    const continuousRanges = mergedContinuousTimeRanges(ranges);
    const fullyCovered = continuousRanges.some((range) => (
      span.start_ms >= range.start_ms && span.end_ms <= range.end_ms
    ));
    if (!fullyCovered) {
      fail('EVIDENCE_SPAN_OUT_OF_RANGE', path, '证据区间超出材料边界。');
    }
    return;
  }
  fail('ENUM_INVALID', `${path}.type`, '证据区间类型不受支持。');
}

function validateEvidenceRefs(refs, path, context) {
  assertArray(refs, path, 12);
  refs.forEach((ref, index) => {
    const refPath = `${path}[${index}]`;
    assertExactKeys(ref, refPath, ['material_id', 'span'], ['cue_id', 'quote']);
    assertInteger(ref.material_id, `${refPath}.material_id`);
    if (ref.material_id <= 0) fail('EVIDENCE_MATERIAL_INVALID', `${refPath}.material_id`, '证据材料标识无效。');
    let material;
    try {
      material = context.resolveMaterial(ref.material_id);
    } catch (error) {
      if (error instanceof InterviewReportValidationError) throw error;
      fail('EVIDENCE_MATERIAL_UNAVAILABLE', `${refPath}.material_id`, '证据材料不可验证。');
    }
    if (!material) fail('EVIDENCE_MATERIAL_DANGLING', `${refPath}.material_id`, '证据材料不存在。');
    if (Number(material.session_id) !== Number(context.sessionId)) {
      fail('EVIDENCE_CROSS_SESSION', `${refPath}.material_id`, '证据材料不属于当前面试 session。');
    }
    validateSpan(ref.span, `${refPath}.span`, material);
    const hasCueId = Object.hasOwn(ref, 'cue_id');
    const hasQuote = Object.hasOwn(ref, 'quote');
    if (hasCueId !== hasQuote) {
      fail('EVIDENCE_CUE_INCOMPLETE', refPath, '时间戳证据必须同时提供 cue_id 与原文。');
    }
    if (hasCueId) {
      assertString(ref.cue_id, `${refPath}.cue_id`, { max: 64 });
      assertString(ref.quote, `${refPath}.quote`, { max: 4000 });
      if (ref.span.type !== 'time_span') {
        fail('EVIDENCE_CUE_SPAN_REQUIRED', `${refPath}.span`, 'cue 证据必须使用时间区间。');
      }
      const cue = Array.isArray(material.cues)
        ? material.cues.find((item) => item && item.cue_id === ref.cue_id)
        : null;
      if (!cue
          || cue.start_ms !== ref.span.start_ms
          || cue.end_ms !== ref.span.end_ms
          || redactTranscriptForExternalAi(cue.text) !== ref.quote) {
        fail('EVIDENCE_CUE_MISMATCH', refPath, 'cue、时间戳与脱敏原文不一致。');
      }
    }
  });
}

function validateEvidenceState(value, path, context, allowedStatuses) {
  if (!allowedStatuses.has(value.status)) fail('ENUM_INVALID', `${path}.status`, '状态不符合 interview_report_v1。');
  validateEvidenceRefs(value.evidence_refs, `${path}.evidence_refs`, context);
  if (value.status === 'unknown') {
    if (!Object.hasOwn(value, 'reason_code')) fail('UNKNOWN_REASON_REQUIRED', `${path}.reason_code`, 'Unknown 必须提供原因代码。');
    if (!UNKNOWN_REASON_CODES.has(value.reason_code)) fail('UNKNOWN_REASON_INVALID', `${path}.reason_code`, 'Unknown 原因代码不受支持。');
    if (value.evidence_refs.length !== 0) fail('UNKNOWN_EVIDENCE_FORBIDDEN', `${path}.evidence_refs`, 'Unknown 不得携带推断性证据。');
  } else {
    if (Object.hasOwn(value, 'reason_code')) fail('ADDITIONAL_PROPERTY', `${path}.reason_code`, '已证实结论不得携带 Unknown 原因。');
    if (value.evidence_refs.length === 0) fail('EVIDENCE_REQUIRED', `${path}.evidence_refs`, '结论必须有同 session 可验证证据。');
  }
}

function validateClaim(value, path, context, statuses = new Set(['supported', 'unknown'])) {
  assertExactKeys(value, path, ['id', 'status', 'text', 'evidence_refs'], ['reason_code']);
  assertId(value.id, `${path}.id`);
  assertString(value.text, `${path}.text`, { max: 1200 });
  validateEvidenceState(value, path, context, statuses);
}

function validateQuestion(value, path, context) {
  assertExactKeys(value, path, ['id', 'status', 'question', 'evidence_refs'], ['reason_code']);
  assertId(value.id, `${path}.id`);
  assertString(value.question, `${path}.question`, { max: 800 });
  validateEvidenceState(value, path, context, new Set(['supported', 'unknown']));
}

function validateKeyFact(value, path, context) {
  assertExactKeys(value, path, ['field_key', 'label', 'status', 'evidence_refs'], ['value', 'reason_code']);
  assertId(value.field_key, `${path}.field_key`);
  const semanticField = fieldAlias(value.field_key);
  if (FORBIDDEN_FIELD_ALIASES.has(semanticField)) {
    fail('FORBIDDEN_FIELD', `${path}.field_key`, '面试报告包含不允许的人事字段。');
  }
  if (FORBIDDEN_DECISION_ALIASES.has(semanticField)) {
    fail('FORBIDDEN_DECISION_FIELD', `${path}.field_key`, '面试报告不得包含评分、排序、处置或自动决策字段。');
  }
  assertString(value.label, `${path}.label`, { max: 120 });
  const semanticLabel = fieldAlias(value.label);
  if (FORBIDDEN_FIELD_ALIASES.has(semanticLabel)) {
    fail('FORBIDDEN_FIELD', `${path}.label`, '面试报告包含不允许的人事字段。');
  }
  if (FORBIDDEN_DECISION_ALIASES.has(semanticLabel)) {
    fail('FORBIDDEN_DECISION_FIELD', `${path}.label`, '面试报告不得包含评分、排序、处置或自动决策字段。');
  }
  if (value.status === 'supported') {
    if (!Object.hasOwn(value, 'value')) fail('REQUIRED_FIELD', `${path}.value`, '已证实关键事实必须提供值。');
    assertString(value.value, `${path}.value`, { max: 600 });
  } else if (Object.hasOwn(value, 'value')) {
    fail('ADDITIONAL_PROPERTY', `${path}.value`, 'Unknown 关键事实不得补全值。');
  }
  validateEvidenceState(value, path, context, new Set(['supported', 'unknown']));
}

function validateLabeledClaim(value, path, context, statuses = new Set(['supported', 'unknown'])) {
  assertExactKeys(value, path, ['id', 'label', 'status', 'text', 'evidence_refs'], ['reason_code']);
  assertId(value.id, `${path}.id`);
  assertString(value.label, `${path}.label`, { max: 160 });
  assertString(value.text, `${path}.text`, { max: 1200 });
  validateEvidenceState(value, path, context, statuses);
}

function validateHardRequirement(value, path, context) {
  assertExactKeys(value, path, ['id', 'label', 'status', 'text', 'evidence_refs'], ['reason_code']);
  assertId(value.id, `${path}.id`);
  assertString(value.label, `${path}.label`, { max: 200 });
  assertString(value.text, `${path}.text`, { max: 1200 });
  const statuses = new Set(['met', 'not_met', 'unknown']);
  if (!statuses.has(value.status)) fail('ENUM_INVALID', `${path}.status`, '硬性条件状态必须是 met/not_met/unknown。');
  validateEvidenceRefs(value.evidence_refs, `${path}.evidence_refs`, context);
  if (value.status === 'unknown') {
    if (!Object.hasOwn(value, 'reason_code') || !UNKNOWN_REASON_CODES.has(value.reason_code)) {
      fail('UNKNOWN_REASON_REQUIRED', `${path}.reason_code`, 'Unknown 必须提供受支持的原因代码。');
    }
    if (value.evidence_refs.length) fail('UNKNOWN_EVIDENCE_FORBIDDEN', `${path}.evidence_refs`, 'Unknown 不得携带推断性证据。');
  } else {
    if (Object.hasOwn(value, 'reason_code')) fail('ADDITIONAL_PROPERTY', `${path}.reason_code`, '已核对硬性条件不得携带 Unknown 原因。');
    if (!value.evidence_refs.length) fail('EVIDENCE_REQUIRED', `${path}.evidence_refs`, '硬性条件核对必须有可验证证据。');
  }
}

function validateAssessmentCrossCheck(value, path, context) {
  assertExactKeys(
    value,
    path,
    ['id', 'assessment_document_id', 'label', 'status', 'text', 'evidence_refs'],
    ['reason_code'],
  );
  assertId(value.id, `${path}.id`);
  assertString(value.assessment_document_id, `${path}.assessment_document_id`, { max: 160 });
  assertString(value.label, `${path}.label`, { max: 200 });
  assertString(value.text, `${path}.text`, { max: 1200 });
  if (!new Set(['consistent', 'conflict', 'not_covered']).has(value.status)) {
    fail('ENUM_INVALID', `${path}.status`, '测评交叉验证状态必须是 consistent/conflict/not_covered。');
  }
  validateEvidenceRefs(value.evidence_refs, `${path}.evidence_refs`, context);
  if (value.status === 'not_covered') {
    if (!Object.hasOwn(value, 'reason_code') || !UNKNOWN_REASON_CODES.has(value.reason_code)) {
      fail('UNKNOWN_REASON_REQUIRED', `${path}.reason_code`, '未覆盖项必须提供受支持的原因代码。');
    }
    if (value.evidence_refs.length) fail('UNKNOWN_EVIDENCE_FORBIDDEN', `${path}.evidence_refs`, '未覆盖项不得携带推断性证据。');
  } else {
    if (Object.hasOwn(value, 'reason_code')) fail('ADDITIONAL_PROPERTY', `${path}.reason_code`, '一致或冲突结论不得携带 Unknown 原因。');
    if (!value.evidence_refs.length) fail('EVIDENCE_REQUIRED', `${path}.evidence_refs`, '测评交叉验证结论必须有面试证据。');
  }
}

function assertUniqueIds(items, path, key) {
  const seen = new Set();
  items.forEach((item, index) => {
    const value = item[key];
    if (seen.has(value)) fail('DUPLICATE_ID', `${path}[${index}].${key}`, '报告标识符必须唯一。');
    seen.add(value);
  });
}

function validateInterviewReport(value, context = {}) {
  const report = parseReportJson(value);
  assertNoForbiddenFields(report);
  if (!Number.isInteger(Number(context.sessionId)) || Number(context.sessionId) <= 0) {
    fail('SESSION_REQUIRED', '$', '必须提供有效面试 session。');
  }
  if (typeof context.resolveMaterial !== 'function') {
    fail('EVIDENCE_RESOLVER_REQUIRED', '$', '服务端证据解析器不可用。');
  }
  assertExactKeys(report, '$', [
    'schema_version',
    'summary',
    'match_points',
    'risks',
    'unknowns',
    'followup_questions',
    'key_facts',
    'human_confirm_required',
    'disclaimer',
  ], [
    'hard_requirements',
    'competency_evidence',
    'motivation',
    'contradictions',
    'assessment_cross_checks',
    'ai_reference',
  ]);
  if (report.schema_version !== SCHEMA_VERSION) fail('SCHEMA_VERSION_INVALID', '$.schema_version', '仅支持 interview_report_v1。');
  if (report.human_confirm_required !== true) fail('HUMAN_CONFIRM_REQUIRED', '$.human_confirm_required', '报告必须要求人工确认。');
  if (report.disclaimer !== REPORT_DISCLAIMER) fail('DISCLAIMER_INVALID', '$.disclaimer', '报告声明不符合 interview_report_v1。');

  validateClaim(report.summary, '$.summary', context);
  assertArray(report.match_points, '$.match_points', 20);
  report.match_points.forEach((item, index) => validateClaim(item, `$.match_points[${index}]`, context, new Set(['supported'])));
  assertUniqueIds(report.match_points, '$.match_points', 'id');
  assertArray(report.risks, '$.risks', 20);
  report.risks.forEach((item, index) => validateClaim(item, `$.risks[${index}]`, context, new Set(['supported'])));
  assertUniqueIds(report.risks, '$.risks', 'id');
  assertArray(report.unknowns, '$.unknowns', 20);
  report.unknowns.forEach((item, index) => validateClaim(item, `$.unknowns[${index}]`, context, new Set(['unknown'])));
  assertUniqueIds(report.unknowns, '$.unknowns', 'id');
  assertArray(report.followup_questions, '$.followup_questions', 20);
  report.followup_questions.forEach((item, index) => validateQuestion(item, `$.followup_questions[${index}]`, context));
  assertUniqueIds(report.followup_questions, '$.followup_questions', 'id');
  assertArray(report.key_facts, '$.key_facts', 30);
  report.key_facts.forEach((item, index) => validateKeyFact(item, `$.key_facts[${index}]`, context));
  assertUniqueIds(report.key_facts, '$.key_facts', 'field_key');
  if (Object.hasOwn(report, 'hard_requirements')) {
    assertArray(report.hard_requirements, '$.hard_requirements', 40);
    report.hard_requirements.forEach((item, index) => validateHardRequirement(item, `$.hard_requirements[${index}]`, context));
    assertUniqueIds(report.hard_requirements, '$.hard_requirements', 'id');
  }
  if (Object.hasOwn(report, 'competency_evidence')) {
    assertArray(report.competency_evidence, '$.competency_evidence', 30);
    report.competency_evidence.forEach((item, index) => validateLabeledClaim(item, `$.competency_evidence[${index}]`, context));
    assertUniqueIds(report.competency_evidence, '$.competency_evidence', 'id');
  }
  if (Object.hasOwn(report, 'motivation')) {
    validateLabeledClaim(report.motivation, '$.motivation', context);
  }
  if (Object.hasOwn(report, 'contradictions')) {
    assertArray(report.contradictions, '$.contradictions', 30);
    report.contradictions.forEach((item, index) => validateLabeledClaim(item, `$.contradictions[${index}]`, context));
    assertUniqueIds(report.contradictions, '$.contradictions', 'id');
  }
  if (Object.hasOwn(report, 'assessment_cross_checks')) {
    assertArray(report.assessment_cross_checks, '$.assessment_cross_checks', 30);
    report.assessment_cross_checks.forEach((item, index) => validateAssessmentCrossCheck(item, `$.assessment_cross_checks[${index}]`, context));
    assertUniqueIds(report.assessment_cross_checks, '$.assessment_cross_checks', 'id');
  }
  if (Object.hasOwn(report, 'ai_reference')) {
    validateLabeledClaim(report.ai_reference, '$.ai_reference', context);
  }
  return report;
}

module.exports = {
  SCHEMA_VERSION,
  REPORT_DISCLAIMER,
  UNKNOWN_REASON_CODES,
  InterviewReportValidationError,
  assertNoForbiddenFields,
  parseReportJson,
  validateInterviewReport,
};
