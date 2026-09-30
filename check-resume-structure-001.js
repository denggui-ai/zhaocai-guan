'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  RESUME_STRUCTURE_SCHEMA_VERSION,
  inspectWorkYears,
  inspectWorkYearsFromText,
  parseResumeStructure,
  withBasicOverrides,
} = require('./resume-structure');

const fixture = [
  '姓名：合成资深候选人',
  '年龄：45岁',
  '最高学历：本科',
  '工作年限：18年',
  '期望薪资：35-45K',
  '',
  '工作经历',
  '2019.03-2024.06 合成甲科技有限公司｜产品经理',
  '负责产品增长与团队管理',
  '',
  '2014.07-2019.02',
  '合成乙集团｜产品主管',
  '负责商业化平台',
  '',
  '教育经历',
  '2010.09-2014.06 合成测试大学｜计算机科学｜本科',
  '',
  '项目经历',
  '2022.01-2023.05 项目名称：增长平台',
  '项目角色：负责人',
  '负责项目落地',
].join('\n');

const structure = parseResumeStructure(fixture, { source: 'synthetic_resume' });
assert.equal(structure.schema_version, RESUME_STRUCTURE_SCHEMA_VERSION);
assert.deepEqual(structure.basic, {
  name: '合成资深候选人',
  age: '45岁',
  degree: '本科',
  school: '合成测试大学',
  work_years: '18年',
  salary: '35-45K',
});
assert.equal(structure.work.length, 2);
assert.equal(structure.work[0].company, '合成甲科技有限公司');
assert.equal(structure.work[0].title, '产品经理');
assert.equal(structure.work[0].start, '2019.03');
assert.equal(structure.work[0].end, '2024.06');
assert.equal(structure.work[1].company, '合成乙集团', '日期单独一行不得被拆成 date-only 经历');
assert.equal(structure.work[1].title, '产品主管');
assert.equal(structure.education.length, 1);
assert.equal(structure.education[0].school, '合成测试大学');
assert.equal(structure.education[0].major, '计算机科学');
assert.equal(structure.education[0].degree, '本科');
assert.equal(structure.project.length, 1);
assert.equal(structure.project[0].name, '增长平台');
assert.equal(structure.project[0].role, '负责人');
assert.match(structure.raw_sections.work, /负责产品增长/);
assert.match(structure.raw_sections.education, /计算机科学/);
assert.match(structure.raw_sections.project, /负责项目落地/);

const onboardingText = fs.readFileSync(path.join(__dirname, 'docs/examples/resumes/简历01-示例林禾-完全虚构.txt'), 'utf8');
const onboarding = parseResumeStructure(onboardingText);
assert.equal(onboarding.basic.work_years, '4年');
assert.equal(onboarding.basic.salary, '9-11K');
assert.deepEqual(onboarding.work.map(({ company, title, start, end }) => ({ company, title, start, end })), [
  { company: '虚构青禾商贸有限公司', title: '电商运营专员', start: '2024.07', end: '2026.06' },
  { company: '虚构微光商贸有限公司', title: '运营助理', start: '2022.07', end: '2024.06' },
], '公开入门样例的工作年限摘要不得被当作经历章节，覆盖真实首份工作的职位');
assert.doesNotMatch(onboarding.raw_sections.work, /4年|期望薪资|9-11K/);
assert.doesNotMatch(onboarding.work[0].desc, /期望薪资|9-11K|^4年/m);
assert.match(onboarding.work[0].desc, /负责每周整理商品信息/);
assert.match(onboarding.work[1].desc, /按既定模板汇总退款原因/);
assert.equal(onboarding.education[0].school, '虚构示例大学');
assert.equal(onboarding.project[0].name, '虚构秋季商品活动');

for (const heading of ['工作经历', '工作经验', '工作经验：2020.01-2024.06 合成保留科技有限公司｜运营主管']) {
  const lines = ['姓名：合成标题测试', '工作经验：4年', '期望薪资：9-11K', heading];
  if (!heading.includes('：')) lines.push('2020.01-2024.06 合成保留科技有限公司｜运营主管');
  lines.push('负责合成数据整理');
  const parsed = parseResumeStructure(lines.join('\n'));
  assert.equal(parsed.work.length, 1);
  assert.equal(parsed.work[0].company, '合成保留科技有限公司');
  assert.equal(parsed.work[0].title, '运营主管', '真正的工作经验章节和同一行的经历内容必须继续支持');
  assert.doesNotMatch(parsed.work[0].desc, /期望薪资|9-11K/);
}

const tenureInsideSection = parseResumeStructure([
  '姓名：合成章节候选人', '工作经历', '工作年限：4年',
  '2022.07-2026.06 合成科技有限公司｜工程师', '负责测试工具',
  '教育经历', '2018.09-2022.06 合成日期大学｜软件工程｜本科',
].join('\n'));
assert.equal(tenureInsideSection.work.length, 1, '已经进入工作章节时，年限摘要不得结束章节并丢掉后续经历');
assert.equal(tenureInsideSection.work[0].company, '合成科技有限公司');
assert.equal(tenureInsideSection.work[0].title, '工程师');
assert.match(tenureInsideSection.work[0].desc, /负责测试工具/);
assert.doesNotMatch(tenureInsideSection.raw_sections.work, /工作年限/);
assert.equal(tenureInsideSection.education.length, 1);

const leadingDateSchool = parseResumeStructure([
  '姓名：合成校友',
  '教育经历',
  '2018.09-2022.06 合成日期大学｜软件工程｜本科',
].join('\n'));
assert.equal(leadingDateSchool.basic.school, '合成日期大学', '院校行以日期开头时必须保留学校名');
assert.equal(leadingDateSchool.education[0].school, '合成日期大学');

assert.deepEqual(inspectWorkYears('18年', '45岁'), { value: '18年', rejected: null, reason: null },
  '资深候选人的真实工作年限不得再被 15 年硬上限误伤');
assert.deepEqual(inspectWorkYearsFromText('2018年-2021年 合成公司', '30岁'), { value: null, rejected: null, reason: null },
  '四位数年份的尾两位不得被误判为工作年限');
const implausible = inspectWorkYearsFromText('工作经验：19年\n年龄：30岁', '30岁');
assert.equal(implausible.value, null);
assert.equal(implausible.rejected, '19年');
assert.match(implausible.reason, /年龄 30 岁不符/);

const corrected = withBasicOverrides(structure, { age: '46', school: '人工确认大学' });
assert.equal(corrected.basic.age, '46岁');
assert.equal(corrected.basic.school, '人工确认大学');
assert.deepEqual(corrected.work, structure.work, '人工校对基础字段不得清空结构化经历');

console.log(JSON.stringify({
  ok: true,
  contract: 'resume-structure-001',
  unified_schema: RESUME_STRUCTURE_SCHEMA_VERSION,
  structured_work_education_project: true,
  raw_section_evidence_retained: true,
  senior_work_years_supported: true,
  four_digit_year_guard: true,
  onboarding_summary_does_not_pollute_work_entries: true,
  synthetic_only: true,
}));
