const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SELF_CHECK_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'talent-pool-selfcheck-'));
const SELF_CHECK_DB = path.join(SELF_CHECK_ROOT, 'recruiting.db');
process.env.BOSS_DB_PATH = SELF_CHECK_DB;
process.on('exit', () => fs.rmSync(SELF_CHECK_ROOT, { recursive: true, force: true }));

const dbmod = require("../src/db");

const FORBIDDEN_KEYS = [
  'boss_id',
  'geek_id',
  'security_id',
  'encrypt_job_id',
  'expect_id',
  'lid',
  'chat_uid',
  'numeric_uid',
  'value_encrypted',
  'value_hash',
  'raw_json',
];
const SCHOOL_TAG_PATTERN = /985|双一流|重点院校|名校|(^|[^\d])211($|[^\d])/;
const SALARY_VALUE_PATTERN = /12000\s*元|1\.5\s*万元|20\s*[-~～—至到]\s*30\s*[kK]|18\s*千|36\s*万/i;
const REGION_VALUE_PATTERN = /杭州|上海|北京|深圳|苏州|浙江/;
const BOSS_VALUE_PATTERN = /sec-public-leak|gid-public-leak|expect-public-leak|lid-public-leak/;

function walk(value, visitor, pathName = '$') {
  visitor(value, pathName);
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visitor, `${pathName}[${index}]`));
    return;
  }
  Object.entries(value).forEach(([key, child]) => walk(child, visitor, `${pathName}.${key}`));
}

function assertNoSensitiveFields(value) {
  walk(value, (node, pathName) => {
    const key = pathName.split('.').pop().replace(/\[\d+\]$/, '');
    assert.ok(!FORBIDDEN_KEYS.includes(key), `talent pool leaked forbidden key: ${pathName}`);
    if (typeof node === 'string') {
      assert.ok(!/(?:\+?86[-\s]?)?1[3-9]\d{9}/.test(node), `talent pool leaked phone-like text at ${pathName}`);
      assert.ok(!/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(node), `talent pool leaked email-like text at ${pathName}`);
      assert.ok(!/sec-shared|gid-shared|jid-|expect-shared|lid-shared/.test(node), `talent pool leaked Boss key value at ${pathName}`);
      assert.ok(!BOSS_VALUE_PATTERN.test(node), `talent pool leaked injected Boss key value at ${pathName}`);
      assert.ok(!/\d{1,2}\s*岁/.test(node), `talent pool leaked age-like text at ${pathName}`);
      assert.ok(!SALARY_VALUE_PATTERN.test(node), `talent pool leaked salary-like text at ${pathName}`);
      assert.ok(!REGION_VALUE_PATTERN.test(node), `talent pool leaked region-like text at ${pathName}`);
      // ISO 时间戳的毫秒段可能随机包含 211/985；院校标签只检查业务文本，不检查 *_at 元数据。
      if (!/_at$/.test(key)) assert.ok(!SCHOOL_TAG_PATTERN.test(node), `talent pool leaked school tag at ${pathName}`);
    }
  });
}

fs.rmSync(SELF_CHECK_DB, { force: true });
fs.mkdirSync(path.dirname(SELF_CHECK_DB), { recursive: true });

const db = dbmod.openDb(SELF_CHECK_DB);
const now = '2026-07-10T08:00:00.000Z';
const old = '2026-01-01T08:00:00.000Z';

const job1 = dbmod.upsertJob({
  encrypt_job_id: 'jid-history-001',
  numeric_job_id: '1001',
  name: '历史电商运营（上海，20-30K）',
  hr_owner: 'HR',
  created_at: old,
}).id;
const job2 = dbmod.upsertJob({
  encrypt_job_id: 'jid-current-002',
  numeric_job_id: '1002',
  name: 'AI Agent 运营（工作地：杭州，月薪12000元）',
  hr_owner: 'HR',
  created_at: now,
}).id;

const emptyPool = dbmod.listTalentPool({ jobId: job2 });
assert.equal(emptyPool.source, 'local_db_empty', 'empty DB should show a real empty state, not fixture candidates');
assert.equal(emptyPool.talents.length, 0, 'empty DB should not mix demo candidates into local view');
const demoPool = dbmod.listTalentPool({ jobId: job2, fixture: true });
assert.equal(demoPool.source, 'fixture_fallback', 'fixture fallback should require an explicit flag');
assert.ok(demoPool.talents.length > 0, 'explicit fixture fallback should still provide demo talents');
const demoContactReview = demoPool.overview.find((item) => item.key === 'reactivable');
assert.equal(demoContactReview.label, '可进入联系复核', 'overview must not present reviewable talent as directly contactable');
assert.equal(demoContactReview.value, 2, 'fixture should expose reactivable and silver talent as review candidates');
assert.match(demoContactReview.hint, /其中 1 人已满足联系前置条件/, 'overview must disclose the stricter contact-ready subset');
const demoReadyTalent = demoPool.talents.find((item) => item.contact_state.contact_ready);
assert.equal(demoReadyTalent?.pool_status, 'reactivable', 'fixture contact readiness must be explicit and status-gated');
assert.equal(demoReadyTalent.contact_state.consent_confirmed, true);
assert.equal(demoReadyTalent.contact_state.opt_out_status_confirmed, true);
assert.equal(demoReadyTalent.contact_state.has_valid_contact_method, true);
assert.equal(
  demoPool.talents.find((item) => item.pool_status === 'do_not_contact').contact_state.contact_ready,
  false,
  'DNC talent must never become contact-ready even when a contact record exists',
);

const first = dbmod.upsertCandidate({
  job_id: job1,
  geek_id: 'shared-geek-001',
  numeric_uid: '900001',
  boss_id: 'gid-shared-001',
  security_id: 'sec-shared-001',
  encrypt_job_id: 'jid-history-001',
  expect_id: 'expect-shared-001',
  lid: 'lid-shared-001',
  source: 'synthetic_talent',
  name: 'Shared Talent',
  rec_position: '电商运营',
  comm_status: '未打招呼',
  disposition_status: '待处理',
  match_point: '做过 AI Agent 商品运营项目；期望薪资12000元；工作地：杭州；年龄28岁；985；微信号：talent_test_wx；security_id=sec-public-leak-001',
  risk_point: '薪资区间20-30K，现居上海，期望地：深圳，年薪36万，手机：13800000000，boss_id=gid-public-leak-001',
  created_at: old,
}, old).internal_id;

const second = dbmod.upsertCandidate({
  job_id: job2,
  geek_id: 'shared-geek-001',
  numeric_uid: '900001',
  boss_id: 'gid-shared-002',
  security_id: 'sec-shared-002',
  encrypt_job_id: 'jid-current-002',
  expect_id: 'expect-shared-002',
  lid: 'lid-shared-002',
  source: 'synthetic_talent',
  name: 'Shared Talent',
  rec_position: 'AI Agent 运营',
  comm_status: '未打招呼',
  disposition_status: '新入库',
  created_at: now,
}, now).internal_id;

const missing = dbmod.upsertCandidate({
  job_id: job1,
  geek_id: 'missing-geek-001',
  boss_id: 'gid-missing-001',
  security_id: 'sec-missing-001',
  encrypt_job_id: 'jid-history-001',
  expect_id: 'expect-missing-001',
  lid: 'lid-missing-001',
  source: 'synthetic_talent',
  name: 'Missing Evidence',
  rec_position: '未知',
  comm_status: '未打招呼',
  disposition_status: '新入库',
  created_at: now,
}, now).internal_id;

const roleMismatch = dbmod.upsertCandidate({
  job_id: job1,
  geek_id: 'role-mismatch-geek-001',
  boss_id: 'gid-role-mismatch-001',
  security_id: 'sec-role-mismatch-001',
  encrypt_job_id: 'jid-history-001',
  expect_id: 'expect-role-mismatch-001',
  lid: 'lid-role-mismatch-001',
  source: 'synthetic_talent',
  name: 'Role Mismatch',
  rec_position: '电商运营',
  match_point: '做过 AI Agent 运营项目',
  comm_status: '未打招呼',
  disposition_status: '淘汰',
  risk_point: '当时岗位不合适，可转岗复核。',
  created_at: now,
}, now).internal_id;

const keywordOnly = dbmod.upsertCandidate({
  job_id: job1,
  geek_id: 'keyword-only-geek-001',
  boss_id: 'gid-keyword-only-001',
  security_id: 'sec-keyword-only-001',
  encrypt_job_id: 'jid-history-001',
  expect_id: 'expect-keyword-only-001',
  lid: 'lid-keyword-only-001',
  source: 'synthetic_talent',
  name: 'Keyword Only',
  rec_position: 'AI Agent 运营',
  comm_status: '未打招呼',
  disposition_status: '新入库',
  created_at: now,
}, now).internal_id;

const noTouchByComment = dbmod.upsertCandidate({
  job_id: job1,
  geek_id: 'comment-dnc-geek-001',
  boss_id: 'gid-comment-dnc-001',
  security_id: 'sec-comment-dnc-001',
  encrypt_job_id: 'jid-history-001',
  expect_id: 'expect-comment-dnc-001',
  lid: 'lid-comment-dnc-001',
  source: 'synthetic_talent',
  name: 'Comment DNC',
  rec_position: 'AI Agent 运营',
  comm_status: '未打招呼',
  disposition_status: '新入库',
  created_at: now,
}, now).internal_id;

const staleWithFreshUpdate = dbmod.upsertCandidate({
  job_id: job1,
  geek_id: 'stale-geek-001',
  boss_id: 'gid-stale-001',
  security_id: 'sec-stale-001',
  encrypt_job_id: 'jid-history-001',
  expect_id: 'expect-stale-001',
  lid: 'lid-stale-001',
  source: 'synthetic_talent',
  name: 'Stale Fresh Update',
  rec_position: 'AI Agent 运营',
  comm_status: '未打招呼',
  disposition_status: '新入库',
  created_at: '2025-01-01T08:00:00.000Z',
}, now).internal_id;

const boundaryOnly = dbmod.upsertCandidate({
  job_id: job1,
  geek_id: 'boundary-only-geek-001',
  boss_id: 'gid-boundary-only-001',
  security_id: 'sec-boundary-only-001',
  encrypt_job_id: 'jid-history-001',
  expect_id: 'expect-boundary-only-001',
  lid: 'lid-boundary-only-001',
  source: 'synthetic_talent',
  name: 'Boundary Only',
  rec_position: '未知',
  comm_status: '未打招呼',
  disposition_status: '新入库',
  created_at: now,
}, now).internal_id;

for (const candidateId of [first, second, roleMismatch, keywordOnly, noTouchByComment, staleWithFreshUpdate]) {
  dbmod.insertResumeOnline({
    candidate_id: candidateId,
    sections_json: JSON.stringify({
      basic: [{ description: '负责 AI Agent 运营工具落地，参与商品数据复盘。28岁，期望薪资12000元，所在地杭州，985背景。' }],
      work: [{ company: 'Fixture Co', title: '运营', desc: '主导 AI Agent 商品运营项目，沉淀 SOP 和数据看板。当前月薪1.5万元，坐标上海，security_id=sec-public-leak-002。' }],
      proj: [{ name: 'Agent 商品助手', role: '负责人', desc: '串联运营流程、数据复盘和自动化提醒。期望地：深圳，学校层级：211，邮箱：talent@example.com。' }],
      skill: [{ text: 'AI Agent / SQL / 电商运营' }],
    }),
    is_paywalled: 0,
    raw_json: JSON.stringify({ fixture: true }),
    fetched_at: candidateId === staleWithFreshUpdate ? '2025-01-01T08:00:00.000Z' : now,
  });
}

dbmod.insertResumeOnline({
  candidate_id: boundaryOnly,
  sections_json: JSON.stringify({
    basic: [{ description: '期望薪资12000元，当前月薪1.5万元，薪资区间20-30K，年薪36万；所在地杭州，坐标上海，期望地：苏州；28岁；985；微信号：boundary_test；expect_id=expect-public-leak-001。' }],
  }),
  is_paywalled: 0,
  raw_json: JSON.stringify({ fixture: true }),
  fetched_at: now,
});

db.prepare(`
  INSERT INTO contact (candidate_id, type, value_encrypted, value_hash, source, confidence, created_at)
  VALUES (?, 'mobile', 'encrypted-13800000000', 'hash-13800000000', 'fixture', 'low', ?)
`).run(first, now);
db.prepare(`
  INSERT INTO comment (candidate_id, body, purpose_tag, is_persona_signal, polarity, author, created_at)
  VALUES (?, '候选人明确表示不要联系，并要求删除后续触达。', '合规备注', 0, 'negative', 'Fixture HR', ?)
`).run(noTouchByComment, now);
dbmod.changeStatus(noTouchByComment, 'disposition', 'do_not_contact', 'manual', 'HR', '合成结构化禁触达');
dbmod.changeStatus(first, 'disposition', '备选', 'fixture', 'HR', '历史表现可复用');
dbmod.insertAiReview({
  candidate_id: keywordOnly,
  job_id: job1,
  profile_confirmed: 0,
  report_json: JSON.stringify({
    schema_version: 'candidate_evaluation_report_v1',
    dimension_matches: [{
      dimension: 'AI Agent运营',
      state: 'Match',
      score: 8,
      evidence: [{ id: 'work.0.desc', text: 'AI Agent 运营项目，期望薪资1.5万元，坐标上海，年龄32岁，211。' }],
      explanation: {
        fact: '历史资料有 AI Agent 运营项目；期望薪资1.5万元；坐标上海；年龄32岁；211；lid=lid-public-leak-001。',
        judgment: '仅依据 AI Agent 项目判断；工作地北京、20-30K 不进入判断。',
        impact: '仅供复核；期望城市深圳、电话010-12345678不进入影响。',
      },
    }],
    radar: [{ dimension: 'AI Agent运营', score: 8, state: 'Match' }],
    risks: [{ point: '当前薪资18千，期望地浙江，学校层级：双一流，geek_id=gid-public-leak-002。' }],
  }),
  created_at: now,
});

const pool = dbmod.listTalentPool({ jobId: job2 });
assert.equal(pool.schema_version, 'talent_pool_p0_v1');
assert.equal(pool.source, 'local_db');
assert.ok(Array.isArray(pool.talents) && pool.talents.length >= 2, 'talent pool should derive local candidates');
assertNoSensitiveFields(pool);

for (const key of ['reactivable', 'silver', 'role_mismatch', 'cooling', 'do_not_contact', 'need_info', 'data_stale']) {
  assert.ok(Object.hasOwn(pool.status_counts, key), `status_counts should expose ${key}`);
}

const shared = pool.talents.find((talent) => talent.name === 'Shared Talent');
assert.ok(shared, 'same geek fixture should produce one aggregated talent');
assert.ok(shared.historical_job_count >= 2, 'same geek across jobs should aggregate into cross-job history');
assert.ok(shared.history.length >= 2, 'aggregated talent should keep both job records');
assert.equal(shared.contact_state.has_record, true, 'encrypted contact record should be represented as state only');
assert.equal(shared.contact_state.has_valid_contact_method, true, 'recognized encrypted mobile channel should count as a valid method');
assert.equal(shared.contact_state.consent_confirmed, false, 'formal data must fail closed without consent evidence');
assert.equal(shared.contact_state.opt_out_status_confirmed, false, 'formal data must fail closed without opt-out verification');
assert.equal(shared.contact_state.contact_ready, false, 'a contact record alone must never make talent contact-ready');
assert.ok(shared.recommendation.unknowns.some((item) => /没有 V1|V1/.test(item)), 'missing V1 should stay Unknown');
assert.ok(!JSON.stringify(shared.recommendation.reasons).includes('历史V1报告'), 'missing V1 must not fabricate historical V1 evidence');
assert.match(JSON.stringify(shared), /\[薪资已隐藏\]/, 'redacted salary should use the unified placeholder');
assert.match(JSON.stringify(shared), /\[地域已隐藏\]/, 'redacted region should use the unified placeholder');

const boundaryOnlyTalent = pool.talents.find((talent) => talent.name === 'Boundary Only');
assert.ok(boundaryOnlyTalent, 'candidate with only boundary variables should still appear');
assert.equal(boundaryOnlyTalent.pool_status, 'need_info', 'salary, region, age and school tier must not count as capability evidence');
assert.equal(boundaryOnlyTalent.evidence_refs.length, 0, 'redaction-only resume text must not become public evidence');
assert.equal(boundaryOnlyTalent.recommendation.reasons.length, 0, 'redaction-only resume text must not create recommendation reasons');
assert.ok(boundaryOnlyTalent.recommendation.unknowns.some((item) => /缺少工作\/项目证据/.test(item)), 'redaction-only resume text should remain Unknown');

const missingTalent = pool.talents.find((talent) => talent.name === 'Missing Evidence');
assert.ok(missingTalent, 'candidate without resume should still appear');
assert.ok(missingTalent.recommendation.unknowns.some((item) => /缺少工作\/项目证据|V1|Unknown/.test(item)), 'missing evidence should surface Unknown');

const roleMismatchTalent = pool.talents.find((talent) => talent.name === 'Role Mismatch');
assert.ok(roleMismatchTalent, 'role mismatch candidate should still appear in talent pool');
assert.equal(roleMismatchTalent.pool_status, 'role_mismatch', 'plain 淘汰/不合适 should be reviewable for another role, not do_not_contact');
assert.notEqual(roleMismatchTalent.recommendation.group, 'not_recommended', 'role mismatch should not be blocked as no-touch');
assert.equal(roleMismatchTalent.recommendation.group, 'needs_evidence', 'role mismatch should require evidence review, not strong recommendation');

const keywordOnlyTalent = pool.talents.find((talent) => talent.name === 'Keyword Only');
assert.ok(keywordOnlyTalent, 'keyword-only candidate should still appear');
assert.equal(keywordOnlyTalent.pool_status, 'reactivable', 'readable resume evidence can be reactivable even without V1/contact');
assert.notEqual(keywordOnlyTalent.recommendation.group, 'strong', 'keyword-only evidence without V1/interview/positive signal must not become strong recommendation');
assert.ok(keywordOnlyTalent.has_v1_report, 'unconfirmed V1 should still be visible as a report');
assert.equal(keywordOnlyTalent.has_confirmed_v1_report, false, 'unconfirmed V1 must not count as confirmed V1');
assert.ok(keywordOnlyTalent.recommendation.unknowns.some((item) => /确认态不足/.test(item)), 'unconfirmed V1 should surface confirmation Unknown');
assertNoSensitiveFields(keywordOnlyTalent.recommendation);
assert.ok(keywordOnlyTalent.recommendation.reasons.some((item) => /AI Agent/.test(JSON.stringify(item))), 'capability evidence should remain after boundary variables are removed');

const commentDncTalent = pool.talents.find((talent) => talent.name === 'Comment DNC');
assert.ok(commentDncTalent, 'comment DNC candidate should appear');
assert.equal(commentDncTalent.pool_status, 'do_not_contact', 'canonical DNC must override resume evidence');
assert.equal(commentDncTalent.recommendation.group, 'not_recommended', 'canonical DNC must block rediscovery recommendation');

const staleTalent = pool.talents.find((talent) => talent.name === 'Stale Fresh Update');
assert.ok(staleTalent, 'stale candidate should appear');
assert.equal(staleTalent.pool_status, 'data_stale', 'fresh candidate.updated_at must not wash old data into reactivable');
assert.equal(staleTalent.contact_state.contact_ready, false, 'stale data must fail the contact-readiness gate');

const contactReviewOverview = pool.overview.find((item) => item.key === 'reactivable');
assert.equal(contactReviewOverview.label, '可进入联系复核');
assert.equal(
  contactReviewOverview.value,
  pool.talents.filter((item) => ['reactivable', 'silver'].includes(item.pool_status)).length,
  'overview review count may include consent-pending talent only under an explicit review label',
);
assert.match(contactReviewOverview.hint, /其中 0 人已满足联系前置条件/);
assert.equal(pool.overview.some((item) => item.label === '可重新联系'), false, 'overview must not claim unverified talent is contactable');

const recommendations = pool.job_recommendations || [];
assert.ok(recommendations.length > 0, 'current job reverse lookup should return recommendations');
assertNoSensitiveFields(recommendations);

db.close();
fs.rmSync(SELF_CHECK_ROOT, { recursive: true, force: true });
console.log('check-talent-pool ok');
