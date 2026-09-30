'use strict';

const assert = require('assert');
const { analyzeAssessmentReportText } = require('./assessment-report-analysis');

const common = `
岗位：合成运营岗位
信效度：高
测试日期：2026-07-14
姓名：合成候选人 性别：女 测评日期：2026-07-14 测试用时：8分
`;

const career = analyzeAssessmentReportText(`${common}
职业潜能测评报告
潜能排列
言行谨慎 5
效率导向 4
职业匹配-总览
销售类
41.80% 31.96% 57.74%
说服型 推销型 竞争型
市场类
79.41% 53.51% 80.14%
战略型 变革型 勇闯型
`);
assert.equal(career.report_type, 'career_potential');
assert.equal(career.schema_version, 'assessment_report_analysis_v2');
assert.equal(career.subject_name, '合成候选人');
assert.equal(career.assessed_job, '合成运营岗位');
assert.equal(career.assessment_date, '2026-07-14');
assert.equal(career.validity, '高');
assert.deepEqual(career.strengths.slice(0, 2), [{ name: '言行谨慎', level: 5 }, { name: '效率导向', level: 4 }]);
assert.equal(career.career_matches[0].name, '勇闯型');
assert.ok(career.interview_questions.length >= 2);
assert.equal(career.decision_support.score, 80.14);

const style = analyzeAssessmentReportText(`${common}
职场风格测评报告
在职场中较常展现的行为是
潜心分析 5级
解决问题 4级
注意！
适应模式：CD
自然模式：SDC
综合模式：CD
一致性分析：调整适应
压力源：灵活 可能影响：较高
`);
assert.equal(style.report_type, 'workplace_style');
assert.equal(style.details.combined_mode, 'CD');
assert.equal(style.details.pressure_source, '灵活');
assert.equal(style.strengths[0].name, '潜心分析');
assert.ok(style.interview_questions.some((item) => item.includes('灵活')));

const team = analyzeAssessmentReportText(`${common}
团队角色测评报告
在自然放松状态下，合成候选人的团队角色呈现为：矛盾的实干者
期待的管理方式：耐心与一致性
角色转变方向：典型的实施者
目前状态：调整适应
在职场中/他人眼中，呈现为：典型的实施者
`);
assert.equal(team.report_type, 'team_role');
assert.equal(team.details.natural_role, '矛盾的实干者');
assert.equal(team.details.management_style, '耐心与一致性');
assert.equal(team.details.current_role, '典型的实施者');
assert.ok(team.interview_questions.length >= 2);

assert.throws(() => analyzeAssessmentReportText(''), (error) => error.code === 'ASSESSMENT_REPORT_TEXT_EMPTY');
assert.ok(Buffer.byteLength(JSON.stringify(career), 'utf8') < 65536);

console.log('check-assessment-report-analysis ok');
