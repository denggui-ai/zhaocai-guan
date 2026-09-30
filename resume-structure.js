'use strict';

// One deterministic resume shape for every local intake path.  The existing
// product-facing sections_json keeps its historical basic/work/edu/proj names;
// this schema is the parser contract shared by screenshot OCR and uploaded
// documents before those values are projected into sections_json.

const RESUME_STRUCTURE_SCHEMA_VERSION = 'resume_structure_v1';
const DEGREE_PATTERN = /(博士|硕士|本科|大专|专科|高中|中专)/;
const AGE_MIN = 16;
const AGE_MAX = 69;
const WORK_YEARS_MAX = 50;

const SECTION_PATTERNS = [
  ['work', /^(?:工作经历|工作经验|职业经历|任职经历)\s*[：:]?\s*(.*)$/i],
  ['education', /^(?:教育经历|教育背景|学习经历)\s*[：:]?\s*(.*)$/i],
  ['project', /^(?:项目经历|项目经验)\s*[：:]?\s*(.*)$/i],
  ['other', /^(?:个人优势|自我评价|求职期望|期望职位|技能(?:特长)?|专业技能|资格证书|培训经历|联系方式)\s*[：:]?\s*(.*)$/i],
];

function clean(value, maximum = 4000) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\0/g, '')
    .replace(/[\t ]+/g, ' ')
    .trim()
    .slice(0, maximum);
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function normalizedAge(value) {
  const match = clean(value, 30).match(/(\d{1,2})/);
  const years = Number(match && match[1]);
  return Number.isInteger(years) && years >= AGE_MIN && years <= AGE_MAX ? `${years}岁` : '';
}

function inspectWorkYears(value, age) {
  const raw = clean(value, 40);
  if (!raw) return { value: null, rejected: null, reason: null };
  if (/应届/.test(raw)) return { value: '应届生', rejected: null, reason: null };
  const match = raw.match(/^(\d{1,2})\s*年/);
  if (!match) return { value: null, rejected: raw, reason: '工作年限格式无法确认' };
  const years = Number(match[1]);
  const normalized = `${years}年`;
  const ageYears = Number((normalizedAge(age).match(/\d+/) || [])[0]);
  if (!Number.isInteger(years) || years < 0 || years > WORK_YEARS_MAX) {
    return { value: null, rejected: normalized, reason: `识别到的工作年限超过 ${WORK_YEARS_MAX} 年，疑似看错` };
  }
  // Do not impose the former 15-year ceiling: it erased valid senior resumes.
  // Age still gives us a candidate-specific plausibility boundary.
  if (Number.isFinite(ageYears) && ageYears > 0 && years > ageYears - 14) {
    return { value: null, rejected: normalized, reason: `识别到的工作年限与年龄 ${ageYears} 岁不符` };
  }
  return { value: normalized, rejected: null, reason: null };
}

function workYearCandidates(source) {
  const text = String(source || '');
  if (/应届生?/.test(text)) return ['应届生'];
  const values = [];
  const addMatches = (pattern) => {
    for (const match of text.matchAll(pattern)) {
      const value = match[1] || match[2];
      if (value) values.push(`${Number(value)}年`);
    }
  };
  // A non-digit boundary is what stops the tail of 2021年 from becoming 21年.
  addMatches(/(?:^|[^\d])(?:工作年限|工作经验|从业年限)\s*[：:]?\s*(\d{1,2})\s*年/gim);
  addMatches(/(?:^|[^\d])(\d{1,2})\s*年(?:以上)?\s*(?:工作|从业)(?:经验)?(?=$|[^\d])/gim);
  addMatches(/(?:^|[^\d])(\d{1,2})\s*年(?=$|[^\d])/gim);
  return [...new Set(values)];
}

function inspectWorkYearsFromText(source, age) {
  let firstRejected = null;
  for (const candidate of workYearCandidates(source)) {
    const inspected = inspectWorkYears(candidate, age);
    if (inspected.value) return inspected;
    if (!firstRejected && inspected.rejected) firstRejected = inspected;
  }
  return firstRejected || { value: null, rejected: null, reason: null };
}

function explicitValue(source, labels, maximum = 120) {
  const labelPattern = labels.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const match = String(source || '').match(new RegExp(`(?:${labelPattern})\\s*[：:]\\s*([^\\n]{1,${maximum}})`, 'i'));
  return clean(match && match[1], maximum);
}

function likelyName(source, fileName = '') {
  const explicit = String(source || '').match(/(?:姓名|候选人)\s*[：:]\s*([\u4e00-\u9fff·]{2,12}|[A-Za-z][A-Za-z .'-]{1,38})/i);
  if (explicit) return clean(explicit[1], 40);
  const forbidden = /简历|个人|求职|工作|教育|经历|项目|技能|联系方式|电话|邮箱|应聘|岗位|resume|curriculum|vitae/i;
  const lines = normalizeText(source).split('\n').map((item) => clean(item, 80)).filter(Boolean).slice(0, 12);
  const candidate = lines.find((line) => !forbidden.test(line)
    && (/^[\u4e00-\u9fff·]{2,6}$/.test(line) || /^[A-Za-z][A-Za-z .'-]{1,38}$/.test(line)));
  if (candidate) return candidate;
  const stem = clean(pathBasenameWithoutExtension(fileName).replace(/[_-]+/g, ' '), 40);
  return forbidden.test(stem) ? '' : stem;
}

// Kept local instead of importing path so this pure parser stays usable in the
// packaged renderer-free checks as well as the Electron main process.
function pathBasenameWithoutExtension(fileName) {
  const normalized = String(fileName || '').replace(/\\/g, '/').split('/').pop() || '';
  const dot = normalized.lastIndexOf('.');
  return dot > 0 ? normalized.slice(0, dot) : normalized;
}

function inferBasic(source, fileName = '') {
  const text = normalizeText(source);
  const explicitAge = explicitValue(text, ['年龄', 'Age'], 20);
  const ageMatch = explicitAge.match(/\d{1,2}/)
    || text.split('\n').slice(0, 20).join('\n').match(/(?:^|[^\d])((?:1[6-9]|[2-6]\d))\s*岁(?:$|[^\d])/m);
  const age = normalizedAge(ageMatch && (ageMatch[1] || ageMatch[0]));
  const explicitDegree = explicitValue(text, ['学历', '最高学历'], 30);
  const degree = clean((explicitDegree.match(DEGREE_PATTERN) || text.match(DEGREE_PATTERN) || [])[1], 30);
  const explicitSchool = explicitValue(text, ['学校', '毕业院校', '院校'], 120);
  const schoolLine = text.split('\n').map((line) => clean(line, 160))
    .find((line) => /大学|学院|学校/.test(line) && !/教育经历|教育背景/.test(line));
  const school = extractSchoolName(explicitSchool || schoolLine);
  const inspectedYears = inspectWorkYearsFromText(text, age);
  const salary = explicitValue(text, ['期望薪资', '薪资期望'], 40);
  return {
    name: likelyName(text, fileName),
    age,
    degree,
    school,
    work_years: inspectedYears.value || '',
    salary,
  };
}

function sectionTexts(source) {
  const out = { work: [], education: [], project: [] };
  let current = null;
  for (const rawLine of normalizeText(source).split('\n')) {
    const line = clean(rawLine);
    if (!line) {
      if (current && out[current] && out[current][out[current].length - 1] !== '') out[current].push('');
      continue;
    }
    // A candidate-level tenure summary is metadata, not the start of a work
    // section. Otherwise its value and following salary become the first job.
    if (/^(?:工作经验|工作年限|从业年限)\s*[：:]?\s*(?:\d{1,2}\s*年(?:以上)?(?:\s*\d{1,2}\s*个月)?|应届(?:生)?|无(?:工作)?经验)\s*$/.test(line)) {
      continue;
    }
    const heading = SECTION_PATTERNS.map(([key, pattern]) => {
      const match = line.match(pattern);
      return match ? { key, tail: clean(match[1]) } : null;
    }).find(Boolean);
    if (heading) {
      current = heading.key === 'other' ? null : heading.key;
      if (current && heading.tail) out[current].push(heading.tail);
      continue;
    }
    if (current) out[current].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([key, lines]) => [key, lines.join('\n').trim()]));
}

const DATE_TOKEN = '(?:19|20)\\d{2}(?:[./年-]\\d{1,2}月?)?';
const DATE_RANGE_RE = new RegExp(`(${DATE_TOKEN})\\s*(?:[-–—~至到]|--)\\s*(${DATE_TOKEN}|至今|现在|Present)`, 'i');

function normalizeDate(value) {
  return clean(value, 24)
    .replace(/年/, '.')
    .replace(/月/, '')
    .replace(/[/-]/g, '.');
}

function dateRange(lines) {
  const match = lines.join(' ').match(DATE_RANGE_RE);
  return match ? { start: normalizeDate(match[1]), end: /present/i.test(match[2]) ? '至今' : normalizeDate(match[2]) } : { start: '', end: '' };
}

function hasDateRange(value) {
  return DATE_RANGE_RE.test(String(value || ''));
}

function looksLikeEntityStart(line, kind) {
  if (kind === 'work') return /公司|集团|事务所|工作室|中心|医院|学校|科技|传媒|商贸/.test(line);
  if (kind === 'education') return /大学|学院|学校/.test(line);
  return /(?:项目名称|项目)\s*[：:]|项目$/.test(line);
}

function splitEntryBlocks(value, kind) {
  const blocks = [];
  let current = [];
  const flush = () => {
    const lines = current.map((line) => clean(line)).filter(Boolean);
    if (lines.length) blocks.push(lines);
    current = [];
  };
  for (const rawLine of normalizeText(value).split('\n')) {
    const line = clean(rawLine);
    if (!line) {
      // OCR/layout extraction often leaves a blank line between a standalone
      // date range and its company/school.  A date is not an entry by itself.
      if (current.some((item) => clean(withoutDate(item)))) flush();
      continue;
    }
    const currentHasDate = current.some(hasDateRange);
    const currentHasContent = current.some((item) => clean(withoutDate(item)));
    // A second dated row is a stable entry boundary.  Do not split merely
    // because the company/school follows a standalone date on the next line.
    if (current.length && hasDateRange(line) && currentHasDate && currentHasContent) flush();
    current.push(line);
  }
  flush();
  return blocks;
}

function withoutDate(value) {
  return clean(String(value || '').replace(DATE_RANGE_RE, ''), 240).replace(/^[|｜·•\s-]+|[|｜·•\s-]+$/g, '');
}

function extractSchoolName(value) {
  const row = withoutDate(clean(value, 180))
    .replace(/^(?:学校|毕业院校|院校)\s*[：:]\s*/i, '')
    .trim();
  const match = row.match(/([^|｜·•，,；;]{2,120}?(?:大学|学院|学校))/);
  return clean(match ? match[1] : row, 120);
}

function labelled(lines, labels, maximum = 160) {
  const source = lines.join('\n');
  return explicitValue(source, labels, maximum);
}

function remainingDescription(lines, excluded = []) {
  const excludedValues = new Set(excluded.map((item) => clean(item)).filter(Boolean));
  return lines
    .filter((line) => !excludedValues.has(clean(line)) && !(/^\s*$/.test(withoutDate(line)) && hasDateRange(line)))
    .map((line) => clean(line, 600))
    .filter(Boolean)
    .join('\n')
    .slice(0, 4000);
}

function parseWorkEntry(lines) {
  const range = dateRange(lines);
  let company = labelled(lines, ['公司', '单位', '雇主'], 160);
  let title = labelled(lines, ['职位', '岗位', '职务'], 120);
  const headerParts = lines.flatMap((line) => withoutDate(line).split(/[|｜·•]/))
    .map((item) => clean(item, 160))
    .filter(Boolean);
  if (!company) company = headerParts.find((item) => looksLikeEntityStart(item, 'work'))
    || lines.map(withoutDate).find((item) => looksLikeEntityStart(item, 'work')) || '';
  if (!title) title = headerParts.find((item) => item !== company)
    || lines.map(withoutDate).find((item) => item && item !== company && item.length <= 40 && !/负责|职责|业绩|内容|描述/.test(item)) || '';
  const desc = remainingDescription(lines, [company, title]);
  return {
    company: clean(company, 160),
    title: clean(title, 120),
    start: range.start,
    end: range.end,
    // Header-only OCR snippets still need visible evidence in legacy resume
    // views, which historically read `work[].desc`.
    desc: desc || lines.join('\n').slice(0, 4000),
  };
}

function parseEducationEntry(lines) {
  const range = dateRange(lines);
  const source = lines.join('\n');
  const headerParts = lines.flatMap((line) => withoutDate(line).split(/[|｜·•]/))
    .map((item) => clean(item, 160))
    .filter(Boolean);
  let school = labelled(lines, ['学校', '毕业院校', '院校'], 160)
    || headerParts.find((line) => /大学|学院|学校/.test(line)) || '';
  school = extractSchoolName(school).replace(/\s+(博士|硕士|本科|大专|专科|高中|中专).*$/, '');
  const degree = clean((source.match(DEGREE_PATTERN) || [])[1], 30);
  let major = labelled(lines, ['专业', '主修'], 120);
  if (!major) {
    major = headerParts.find((line) => line && line !== school && !DEGREE_PATTERN.test(line)
      && line.length <= 80 && !/^教育/.test(line)) || '';
  }
  return {
    school: clean(school, 160),
    major: clean(major, 120),
    degree,
    start: range.start,
    end: range.end,
    tags: [],
    desc: remainingDescription(lines, [school, major, degree]),
  };
}

function parseProjectEntry(lines) {
  const range = dateRange(lines);
  const name = labelled(lines, ['项目名称'], 160) || withoutDate(lines[0]);
  const role = labelled(lines, ['项目角色', '角色', '职责'], 120)
    || lines.map(withoutDate).find((line) => line && line !== name && line.length <= 50 && /负责人|经理|开发|设计|运营|测试|顾问/.test(line)) || '';
  return {
    name: clean(name, 160),
    role: clean(role, 120),
    start: range.start,
    end: range.end,
    desc: remainingDescription(lines, [name, role]),
  };
}

function parseEntries(value, kind) {
  if (!clean(value)) return [];
  const parser = kind === 'work' ? parseWorkEntry : kind === 'education' ? parseEducationEntry : parseProjectEntry;
  return splitEntryBlocks(value, kind)
    .map(parser)
    .filter((item) => Object.values(item).some((value) => Array.isArray(value) ? value.length : clean(value)));
}

function basicHints(input = {}) {
  return {
    name: clean(input.name, 80),
    age: normalizedAge(input.age),
    degree: clean(input.degree, 30),
    school: clean(input.school, 160),
    work_years: inspectWorkYears(input.work_years, input.age).value || '',
    salary: clean(input.salary, 40),
  };
}

function parseResumeStructure(source, options = {}) {
  const text = normalizeText(source);
  const extractedSections = sectionTexts(text);
  const suppliedSections = options.section_texts || {};
  const parsedBasic = inferBasic(text, options.file_name || '');
  const hints = basicHints(options.basic_hints || {});
  const basic = Object.fromEntries(Object.keys(parsedBasic).map((key) => [key, hints[key] || parsedBasic[key] || '']));
  const workText = clean(suppliedSections.work, 30_000) || extractedSections.work;
  const educationText = clean(suppliedSections.education, 30_000) || extractedSections.education;
  const projectText = clean(suppliedSections.project, 30_000) || extractedSections.project;
  const work = parseEntries(workText, 'work');
  const education = parseEntries(educationText, 'education');
  const project = parseEntries(projectText, 'project');
  if (education[0] && education[0].school) basic.school = education[0].school;
  if (!basic.degree && education[0]) basic.degree = education[0].degree || '';
  return {
    schema_version: RESUME_STRUCTURE_SCHEMA_VERSION,
    source: clean(options.source || 'local_resume', 80),
    basic,
    work,
    education,
    project,
    // Keep the exact section-level input beside the normalized entries.  It is
    // evidence for manual correction and prevents a best-effort split from
    // becoming a lossy replacement for the OCR/document text.
    raw_sections: {
      work: workText,
      education: educationText,
      project: projectText,
    },
  };
}

function withBasicOverrides(structure, overrides = {}) {
  const current = structure && structure.schema_version === RESUME_STRUCTURE_SCHEMA_VERSION
    ? structure
    : parseResumeStructure('', {});
  const nextBasic = { ...current.basic };
  for (const key of ['name', 'age', 'degree', 'school', 'work_years', 'salary']) {
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
    if (key === 'age') nextBasic.age = normalizedAge(overrides.age);
    else if (key === 'work_years') nextBasic.work_years = inspectWorkYears(overrides.work_years, overrides.age || nextBasic.age).value || clean(overrides.work_years, 30);
    else nextBasic[key] = clean(overrides[key], key === 'school' ? 160 : 80);
  }
  return { ...current, basic: nextBasic };
}

module.exports = {
  RESUME_STRUCTURE_SCHEMA_VERSION,
  inferBasic,
  inspectWorkYears,
  inspectWorkYearsFromText,
  normalizedAge,
  parseResumeStructure,
  sectionTexts,
  withBasicOverrides,
};
