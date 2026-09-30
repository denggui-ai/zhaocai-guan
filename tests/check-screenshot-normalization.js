const assert = require('assert');
const { buildScreenshotIdentity, normalizeMonthlySalary } = require("../src/screenshot-normalization");

for (const [raw, minK, maxK, normalized] of [
  ['12-15K', 12, 15, '12-15K'],
  ['12K-15K', 12, 15, '12-15K'],
  ['1.2-1.5万元', 12, 15, '12-15K'],
  ['1.2万元-1.5万元', 12, 15, '12-15K'],
  ['12000-15000元', 12, 15, '12-15K'],
  ['15K', 15, 15, '15K'],
  ['1.5万', 15, 15, '15K'],
  ['15000元', 15, 15, '15K'],
]) {
  const result = normalizeMonthlySalary(raw);
  assert.equal(result.status, 'normalized', raw);
  assert.equal(result.min_k, minK, raw);
  assert.equal(result.max_k, maxK, raw);
  assert.equal(result.normalized_text, normalized, raw);
  assert.equal(result.raw, raw, 'raw salary must remain traceable');
}

assert.equal(normalizeMonthlySalary('').status, 'unknown');
assert.equal(normalizeMonthlySalary('面议').status, 'unknown');
assert.equal(normalizeMonthlySalary('20万年薪').status, 'unsupported');
assert.equal(normalizeMonthlySalary('20K·14薪').status, 'unsupported');
assert.equal(normalizeMonthlySalary('15-12K').status, 'invalid');
assert.equal(normalizeMonthlySalary('未知文本').status, 'invalid');

const baseFacts = {
  age: '31岁',
  degree: '大专',
  work_years: '7年',
  salary: '1.2-1.5万元',
  work_experience_text: '合成甲公司\n负责直播投放',
  education_text: '合成职业学院\n电子商务',
};
const renamedA = buildScreenshotIdentity({
  name: '合成人员甲',
  facts: baseFacts,
  sourceHashes: ['a'.repeat(64), 'b'.repeat(64)],
});
const renamedB = buildScreenshotIdentity({
  name: '合成人员甲',
  facts: { ...baseFacts, salary: '12-15K' },
  sourceHashes: ['b'.repeat(64), 'a'.repeat(64)],
});
assert.equal(renamedA.source_fingerprint, renamedB.source_fingerprint, 'source order/path must not affect fingerprint');
assert.equal(renamedA.content_fingerprint, renamedB.content_fingerprint, 'equivalent salary units must share content fingerprint');
assert.equal(renamedA.identity_key, renamedB.identity_key, 'equivalent confirmed facts must share identity key');

const differentSameName = buildScreenshotIdentity({
  name: '合成人员甲',
  facts: { ...baseFacts, work_experience_text: '合成乙公司\n负责客服运营' },
  sourceHashes: ['c'.repeat(64)],
});
assert.notEqual(renamedA.content_fingerprint, differentSameName.content_fingerprint);
assert.notEqual(renamedA.identity_key, differentSameName.identity_key, 'same name with different content must not auto-merge');

const sparse = buildScreenshotIdentity({ name: '合成人员甲', facts: { salary: '12-15K' } });
assert.equal(sparse.status, 'insufficient');
assert.equal(sparse.identity_key, null, 'name/salary alone must not become an automatic identity');

console.log('check-screenshot-normalization ok');
