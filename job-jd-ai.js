const JOB_JD_OPTIMIZATION_PURPOSE = 'job-jd-optimization';
const JOB_JD_OUTPUT_KEYS = new Set([
  'job_title',
  'job_goal',
  'responsibilities',
  'requirements',
  'nice_to_haves',
  'known_work_arrangements',
  'missing_information',
  'compliance_warnings',
  'boss_keywords',
  'full_text',
]);
const MAX_FULL_TEXT_LENGTH = 50000;
const MAX_LIST_ITEMS = 100;
const MAX_LIST_ITEM_LENGTH = 2000;

const DETERMINISTIC_COMPLIANCE_PATTERNS = [
  {
    pattern: /(?:仅限|只招|限招|只要|招聘|招募|要求候选人为)[^，。；\n]{0,20}(?:男性|女性|男士|女士|男生|女生)(?:候选人)?|(?:男性|女性|男士|女士|男生|女生)(?:候选人)?\s*(?:优先|限定|限招)|(?:男|女)性优先/i,
    issue: '草稿包含性别限制或偏好',
    suggestion: '删除与岗位履职无直接关系的性别要求，并由 HR 复核合法性。',
  },
  {
    pattern: /(?:年龄|年纪)[^，。；\n]{0,16}\d{1,2}\s*(?:周?岁)?\s*(?:以下|以内|以上|之间|至|到|-|—|~|～)|\d{1,2}\s*周?岁\s*(?:以下|以内|以上)/i,
    issue: '草稿包含年龄限制',
    suggestion: '删除年龄门槛，改为描述与岗位直接相关、可核验的经验或能力要求。',
  },
  {
    pattern: /未婚|已婚未育|婚育状况|计划生育|孕妇/i,
    issue: '草稿包含婚育相关条件',
    suggestion: '删除婚育相关条件；它们不应成为招聘要求。',
  },
];

const UNSOURCED_ARRANGEMENT_PATTERNS = [
  /五险一金|五险|公积金/i,
  /双休|单休|大小周/i,
  /年终奖|十三薪|13薪|十四薪|14薪/i,
  /带薪年假|包吃|包住|餐补|房补/i,
];

const JOB_JD_OPTIMIZATION_SYSTEM_PROMPT = [
  '你是一位招聘文案顾问。HR 会用自然语言描述招聘需求，你要把它整理成清楚、真实、适合招聘平台阅读的中文 JD 草稿。',
  '目标是让候选人快速理解岗位工作、任职要求和关键信息，同时保留 HR 的原意。',
  '',
  '严格规则：',
  '1. 不得虚构薪资、福利、团队规模、预算、汇报对象、工作时间、招聘人数、公司业绩或任何 HR 没提供的事实。',
  '2. 信息不完整时，在 missing_information 中提出具体问题；不要为了文案完整而猜测。',
  '3. 区分岗位职责、必须条件和加分项，避免把偏好写成硬门槛。',
  '4. 检查歧视性要求、夸大承诺、联系方式和其他不适合公开发布的内容，把问题放进 compliance_warnings，并给出修改建议。',
  '5. boss_keywords 只提取与岗位真实工作直接相关、候选人可能搜索的关键词；不得堆砌无关热词。',
  '6. full_text 必须是 HR 可以继续编辑的完整中文 JD 草稿；未知信息可不写，不要写“待补充”占位符。',
  '7. 不评分、不排序、不替 HR 作招聘决定，也不声称已经发布或同步到任何招聘平台。',
  '8. 顶层只能使用示例中的字段；数组必须保持数组类型，单项内容应简洁，full_text 不得超过 50000 字。',
  '',
  '只输出一个 JSON，不要代码块或其他文字：',
  '{',
  '  "job_title": "岗位名称",',
  '  "job_goal": "岗位目标",',
  '  "responsibilities": ["职责"],',
  '  "requirements": ["必须条件"],',
  '  "nice_to_haves": ["加分项"],',
  '  "known_work_arrangements": ["HR 已明确提供的薪资、地点、时间或福利；没有则空数组"],',
  '  "missing_information": [{"field": "缺失字段", "question": "给 HR 的具体问题"}],',
  '  "compliance_warnings": [{"issue": "问题", "suggestion": "修改建议"}],',
  '  "boss_keywords": ["真实相关关键词"],',
  '  "full_text": "完整、可编辑的中文 JD 草稿"',
  '}',
].join('\n');

function buildJobJdOptimizationUserPrompt({ jobName, brief, currentJd }) {
  const parts = [`【岗位名称】\n${String(jobName || '').trim() || '（未命名岗位）'}`];
  const need = String(brief || '').trim();
  const current = String(currentJd || '').trim();
  if (need) parts.push(`【HR 的自然语言需求】\n${need}`);
  if (current) parts.push(`【现有 JD（请在保留真实信息的前提下优化）】\n${current}`);
  return parts.join('\n\n');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value, field, maxLength, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`模型返回的 ${field} 不能为空`);
    return '';
  }
  if (typeof value !== 'string') throw new Error(`模型返回的 ${field} 必须是文本`);
  const text = value.trim();
  if (required && !text) throw new Error(`模型返回的 ${field} 不能为空`);
  if (text.length > maxLength) throw new Error(`模型返回的 ${field} 过长`);
  return text;
}

function toStringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`模型返回的 ${field} 必须是数组`);
  if (value.length > MAX_LIST_ITEMS) throw new Error(`模型返回的 ${field} 项目过多`);
  return value.map((item, index) => boundedString(
    item,
    `${field}[${index}]`,
    MAX_LIST_ITEM_LENGTH,
  )).filter(Boolean);
}

function normalizeObjectList(value, field, fields) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`模型返回的 ${field} 必须是数组`);
  if (value.length > MAX_LIST_ITEMS) throw new Error(`模型返回的 ${field} 项目过多`);
  return value.map((item, index) => {
    if (!isPlainObject(item)) throw new Error(`模型返回的 ${field}[${index}] 必须是对象`);
    const unknown = Object.keys(item).filter((key) => !fields.includes(key));
    if (unknown.length) throw new Error(`模型返回的 ${field}[${index}] 含未知字段：${unknown.join('、')}`);
    return Object.fromEntries(fields.map((name) => [
      name,
      boundedString(item[name], `${field}[${index}].${name}`, MAX_LIST_ITEM_LENGTH),
    ]));
  }).filter((item) => item[fields[0]]);
}

function numericFactTokens(value) {
  const tokens = [];
  const pattern = /(?:薪资|月薪|年薪|底薪|提成|奖金|预算|团队|招聘人数|工作时间|经验)[^，。；\n]{0,24}?(\d+(?:\.\d+)?\s*(?:[kK]|元|万|%|年|人|名|小时|天|个月))/g;
  for (const match of String(value || '').matchAll(pattern)) tokens.push(match[1].replace(/\s+/g, '').toLowerCase());
  return [...new Set(tokens)];
}

function deterministicComplianceWarnings(fullText, sourceInput = {}) {
  const warnings = [];
  const add = (issue, suggestion) => {
    if (!warnings.some((item) => item.issue === issue)) warnings.push({ issue, suggestion });
  };
  for (const rule of DETERMINISTIC_COMPLIANCE_PATTERNS) {
    if (rule.pattern.test(fullText)) add(rule.issue, rule.suggestion);
  }

  const sourceText = [sourceInput.jobName, sourceInput.brief, sourceInput.currentJd]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join('\n');
  if (sourceText) {
    const unsourcedArrangements = UNSOURCED_ARRANGEMENT_PATTERNS
      .filter((pattern) => pattern.test(fullText) && !pattern.test(sourceText));
    if (unsourcedArrangements.length) {
      add('草稿出现 HR 原始材料未提供的福利或工作安排', '删除未确认内容，或由 HR 提供真实依据后再写入。');
    }
    const sourceNumbers = new Set(numericFactTokens(sourceText));
    const unsourcedNumbers = numericFactTokens(fullText).filter((token) => !sourceNumbers.has(token));
    if (unsourcedNumbers.length) {
      add(
        `草稿出现原始材料未提供的数字事实：${unsourcedNumbers.slice(0, 6).join('、')}`,
        '逐项核对薪资、经验、人数、预算或工作时间；无法确认的数字应删除。',
      );
    }
  }
  return warnings;
}

function parseJobJdOptimizationReply(value, sourceInput = {}) {
  let obj = value;
  if (typeof value === 'string') {
    let text = value.trim();
    const fence = text.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    if (fence) text = fence[1].trim();
    obj = JSON.parse(text);
  }
  if (!isPlainObject(obj)) throw new Error('模型没返回 JD 优化 JSON');
  const unknownKeys = Object.keys(obj).filter((key) => !JOB_JD_OUTPUT_KEYS.has(key));
  if (unknownKeys.length) throw new Error(`模型返回了未知 JD 字段：${unknownKeys.join('、')}`);
  if (typeof obj.full_text !== 'string' || !obj.full_text.trim()) {
    throw new Error('模型没给出可编辑的 JD 草稿');
  }
  const fullText = boundedString(obj.full_text, 'full_text', MAX_FULL_TEXT_LENGTH, true);
  const modelWarnings = normalizeObjectList(
    obj.compliance_warnings,
    'compliance_warnings',
    ['issue', 'suggestion'],
  );
  const normalizedDraft = {
    job_title: boundedString(obj.job_title, 'job_title', 120),
    job_goal: boundedString(obj.job_goal, 'job_goal', 4000),
    responsibilities: toStringArray(obj.responsibilities, 'responsibilities'),
    requirements: toStringArray(obj.requirements, 'requirements'),
    nice_to_haves: toStringArray(obj.nice_to_haves, 'nice_to_haves'),
    known_work_arrangements: toStringArray(obj.known_work_arrangements, 'known_work_arrangements'),
    missing_information: normalizeObjectList(obj.missing_information, 'missing_information', ['field', 'question']),
    boss_keywords: toStringArray(obj.boss_keywords, 'boss_keywords'),
  };
  const deterministicWarnings = deterministicComplianceWarnings([
    fullText,
    normalizedDraft.job_title,
    normalizedDraft.job_goal,
    ...normalizedDraft.responsibilities,
    ...normalizedDraft.requirements,
    ...normalizedDraft.nice_to_haves,
    ...normalizedDraft.known_work_arrangements,
    ...normalizedDraft.boss_keywords,
  ].join('\n'), sourceInput);
  return {
    ...normalizedDraft,
    compliance_warnings: [...modelWarnings, ...deterministicWarnings]
      .filter((item, index, rows) => rows.findIndex((candidate) => candidate.issue === item.issue) === index),
    full_text: fullText,
  };
}

module.exports = {
  JOB_JD_OPTIMIZATION_PURPOSE,
  JOB_JD_OPTIMIZATION_SYSTEM_PROMPT,
  buildJobJdOptimizationUserPrompt,
  deterministicComplianceWarnings,
  parseJobJdOptimizationReply,
};
