
const { PROJECT_ROOT } = require("../src/paths");
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  RULE_SOURCE,
  MANUAL_SOURCE,
  REVIEW_LABEL,
  buildRuleHaystack,
  decideRuleTier,
  applyRuleRating,
} = require("../src/rule-rating");
const { parseSalaryCapK } = require("../src/rating-engine");

const PROFILE = {
  hard_bars: {
    degree: { enabled: true, allowed: ['本科', '硕士', '博士'] },
    city: { enabled: true, allowed: ['上海'] },
    salary: { enabled: true, cap_k: 35 },
  },
  rule_rating: {
    required_fields: ['degree', 'city', 'salary', 'work'],
    tiers: [
      { tier: 'S', all: ['大模型'], any: ['rag', 'agent'], min_any: 1, reason: '有大模型项目证据' },
      { tier: 'A', any: ['node.js', 'react', '全栈'], min_any: 2, reason: '工程能力匹配' },
      { tier: 'B', any: ['javascript', '项目交付'], min_any: 1, reason: '有基础项目经验' },
      { tier: 'C', any: ['无相关经验', '频繁跳槽'], min_any: 1, reason: '明确负向规则' },
    ],
  },
};

function sections(overrides = {}) {
  return {
    basic: [{ degree: overrides.degree === undefined ? '本科' : overrides.degree }],
    expect: [{ city: overrides.city === undefined ? '上海' : overrides.city, salary: overrides.salary === undefined ? '25-30K' : overrides.salary }],
    edu: [{ school: '测试大学', major: '软件工程', degree: overrides.degree === undefined ? '本科' : overrides.degree }],
    work: overrides.work === undefined ? [{ company: '测试公司', title: '工程师', desc: '负责 Node.js React 全栈项目交付' }] : overrides.work,
    proj: overrides.proj || [],
    skill: overrides.skill || [],
  };
}

const strongButModelLow = {
  sections: sections({
    work: [{ company: '测试公司', title: 'AI 工程师', desc: '落地大模型 RAG Agent 平台，负责召回和评估链路' }],
  }),
  geek_desc: '做过企业知识库和 Agent 工具',
  quality_score: 5,
  verdict_label: '不太合适',
  expert_comment: '模型意见不应影响规则定档',
};

const strongButModelHigh = {
  ...strongButModelLow,
  quality_score: 100,
  verdict_label: '很合适',
  expert_comment: '同一份简历只改模型输出，规则结果必须不变',
};

const strongLow = decideRuleTier(PROFILE, strongButModelLow);
const strongHigh = decideRuleTier(PROFILE, strongButModelHigh);
assert.deepEqual(strongLow, strongHigh, 'model score/verdict/comment must not affect rule tier');
assert.equal(strongLow.tier, 'S');
assert.equal(strongLow.source, RULE_SOURCE);
assert.equal(strongLow.label, '推荐面试');
assert.equal(strongLow.auto_write, false, 'rule rating never authorizes Boss writes');

const weakButModelHigh = {
  sections: sections({
    work: [{ company: '测试公司', title: '助理', desc: '无相关经验，频繁跳槽' }],
  }),
  quality_score: 100,
  verdict_label: '很合适',
};
const weak = decideRuleTier(PROFILE, weakButModelHigh);
assert.equal(weak.tier, 'C', 'negative rule wins even when model score is high');
assert.equal(weak.label, '不建议');
assert.equal(weak.auto_write, false);

const missingDegree = decideRuleTier(PROFILE, {
  sections: sections({ degree: '', work: [{ company: '测试公司', title: 'AI 工程师', desc: '大模型 RAG Agent 平台' }] }),
  quality_score: 100,
  verdict_label: '很合适',
});
assert.equal(missingDegree.tier, null, 'missing required information must not be forced into S/A/B/C');
assert.equal(missingDegree.label, REVIEW_LABEL);
assert.equal(missingDegree.requires_human_review, true);
assert.ok(missingDegree.reasons.some((reason) => reason.includes('学历信息缺失')));

const hardFail = decideRuleTier(PROFILE, {
  sections: sections({ degree: '大专', work: [{ company: '测试公司', title: 'AI 工程师', desc: '大模型 RAG Agent 平台' }] }),
  quality_score: 100,
  verdict_label: '很合适',
});
assert.equal(hardFail.tier, 'C', 'objective hard-bar fail becomes not-recommended, not model-driven');
assert.equal(hardFail.hard_bar_pass, false);

const manual = applyRuleRating(PROFILE, {
  sections: weakButModelHigh.sections,
  sabc: 'A',
  sabc_source: MANUAL_SOURCE,
  quality_score: 1,
  verdict_label: '不太合适',
});
assert.equal(manual.tier, 'A');
assert.equal(manual.source, MANUAL_SOURCE);
assert.equal(manual.preserved, true);
assert.equal(manual.skipped, true);
assert.ok(manual.reasons.some((reason) => reason.includes('不覆盖')));

const first = decideRuleTier(PROFILE, strongButModelLow);
for (let i = 0; i < 5; i += 1) {
  assert.deepEqual(decideRuleTier(PROFILE, strongButModelLow), first, 'rule tier must be deterministic');
}

const haystack = buildRuleHaystack(strongButModelLow);
assert.ok(haystack.includes('大模型'));
assert.ok(!haystack.includes('不太合适'), 'model verdict must be absent from rule haystack');
assert.ok(!haystack.includes('模型意见不应影响规则定档'), 'expert comment must be absent from rule haystack');

assert.equal(parseSalaryCapK({ expect: [{ salary: '1.2-1.5万元' }] }), 15);
assert.equal(parseSalaryCapK({ expect: [{ salary: '12-15K' }] }), 15);
assert.equal(parseSalaryCapK({ expect: [{ salary: '12000-15000元' }] }), 15);
assert.equal(parseSalaryCapK({ expect: [{ salary: '20K·14薪' }] }), null, '13/14 salary periods must not be inferred');
assert.equal(parseSalaryCapK({ expect: [{ salary: '' }] }), null);
assert.equal(parseSalaryCapK({ expect: [{ salary_raw: '原始显示', salary_normalized: { status: 'normalized', max_k: 15 } }] }), 15);

const source = fs.readFileSync(path.join(PROJECT_ROOT, "src/rule-rating.js"), 'utf8');
assert.doesNotMatch(source, /rating-llm|scoreCandidate|parseExpertReply/, 'rule-rating must not import or call LLM rating code');

console.log('check-rule-rating ok');
