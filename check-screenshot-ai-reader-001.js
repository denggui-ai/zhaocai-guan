// Guards the Windows screenshot reader, where the model reads the whole page.
//
// Two things must hold no matter what the model returns. A page it did not
// clearly call a detail page contributes nothing — that is what keeps one
// candidate's row off another's record when a list page goes through. And the
// evidence on a draft it does produce carries no confidence and no source
// spans, which is what keeps the draft out of a candidate record until a human
// has checked it (AI-AUTHORED-DRAFT-GATE-001 covers the gate side).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readScreenshots, readPageType, PROMPT } = require('./screenshot-ai-reader');

// Real files, because the reader base64s them into the request itself.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-reader-check-'));
// Windows keeps the SQLite handle open until the process is gone, so the
// temp tree cannot always be removed here. Losing a temp directory is not
// a reason to fail a check.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
const shot = (name) => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return file;
};
const A = shot('a.png');
const B = shot('b.png');
const C = shot('c.png');

const DETAIL = {
  page_type: 'detail', name: '张三', work_years: '8年', degree: '大专',
  age: '28岁', salary: '6000-8000元', availability: '离职-随时到岗',
};

function reader(answers) {
  const queue = [...answers];
  return async () => {
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next;
  };
}

(async () => {
  // A list page that still came back with a full set of fields is the exact
  // failure this module exists to absorb: the fields are dropped, not merged.
  const listLeak = { ...DETAIL, page_type: 'list' };
  const leaked = await readScreenshots(reader([listLeak]), [A]);
  assert.equal(leaked.drafts.length, 0, '列表页即使带回了完整字段也不得产出草稿');
  assert.equal(leaked.summary.skipped_list_count, 1, '列表页必须计入已跳过，而不是消失');

  // An unrecognised or missing label is treated as not-a-detail-page, because
  // guessing wrong costs a candidate's record.
  assert.equal(readPageType({ page_type: 'DETAIL PAGE' }), 'other', '无法识别的页面类型必须当作非详情页');
  assert.equal(readPageType({}), 'other', '缺失的页面类型必须当作非详情页');
  assert.equal(readPageType({ page_type: 'detail' }), 'detail');

  const unlabelled = await readScreenshots(reader([{ ...DETAIL, page_type: null }]), [A]);
  assert.equal(unlabelled.drafts.length, 0, '未标注页面类型时不得产出草稿');

  // A detail page with no name cannot become a candidate — the draft could
  // never be confirmed — so it is counted, not staged.
  const nameless = await readScreenshots(reader([{ ...DETAIL, name: null }]), [A]);
  assert.equal(nameless.drafts.length, 0, '读不出姓名的详情页不得产出草稿');
  assert.equal(nameless.summary.unrecognized_count, 1, '读不出姓名必须计入未识别');

  const ok = await readScreenshots(reader([DETAIL]), [A]);
  assert.equal(ok.drafts.length, 1);
  const draft = ok.drafts[0];
  assert.equal(draft.name, '张三');
  assert.equal(draft.facts.work_years, '8年');
  assert.equal(draft.facts.salary, '6000-8000元');
  assert.notEqual(draft.field_evidence.name.trusted, true, '模型读出的姓名不得被标记为可信');
  assert.equal(draft.field_evidence.name.confidence, null, '模型答案不得伪装成有置信度的证据');
  assert.deepEqual(draft.field_evidence.name.source_spans, [], '模型答案不得携带截图坐标');
  assert.deepEqual(draft.field_evidence.salary.source_spans, [], '字段证据同样不得携带坐标');

  // One unreadable screen costs that screen, not the batch.
  const mixed = await readScreenshots(
    reader([DETAIL, Object.assign(new Error('中转网络请求失败。'), { code: 'PROVIDER_NETWORK_ERROR' }), DETAIL]),
    [A, B, C],
    { concurrency: 1 },
  );
  assert.equal(mixed.drafts.length, 2, '失败页必须断开分组连续性，后续显式姓名页再开组');
  assert.equal(mixed.summary.failed_count, 1, '失败必须计数');
  assert.ok(mixed.reads.some((read) => read.failed && /中转网络请求失败/.test(read.reason)),
    '失败必须带上可诊断的原因');

  const grouped = await readScreenshots(reader([
    { ...DETAIL, recent_focus: '运营，杭州' },
    {
      ...DETAIL,
      name: null,
      work_years: null,
      degree: '本科',
      work_experience_text: '甲公司\n电商运营',
      education_text: '乙大学\n市场营销',
    },
    { ...DETAIL, name: '李四', work_years: '3年', recent_focus: '电商，上海' },
  ]), [A, B, C], { concurrency: 1 });
  assert.equal(grouped.drafts.length, 2, '新姓名开组，无姓名详情页应续入当前组');
  assert.deepEqual(grouped.drafts[0].files, [A, B]);
  assert.equal(grouped.drafts[0].facts.recent_focus, '运营，杭州');
  assert.match(grouped.drafts[0].facts.work_experience_text, /甲公司/);
  assert.match(grouped.drafts[0].facts.education_text, /乙大学/);
  assert.deepEqual(grouped.drafts[0].field_evidence.degree.conflict_values, ['大专', '本科']);
  assert.equal(grouped.summary.detail_draft_count, 2, 'detail_draft_count 必须是候选人组数');

  const boundary = await readScreenshots(reader([
    DETAIL,
    { ...DETAIL, page_type: 'list' },
    { ...DETAIL, name: null, work_experience_text: '可能属于下一人' },
  ]), [A, B, C], { concurrency: 1 });
  assert.equal(boundary.drafts.length, 1);
  assert.deepEqual(boundary.drafts[0].files, [A], '无姓名续页不得跨列表/失败/未知页污染上一候选人');
  assert.equal(boundary.summary.unrecognized_count, 1);

  assert.match(PROMPT, /page_type 不是 detail 时，其余字段一律填 null/, '提示词必须要求非详情页不填字段');
  assert.match(PROMPT, /最近关注/, '提示词必须继续排除岗位薪资');

  console.log(JSON.stringify({
    ok: true,
    contract: 'SCREENSHOT-AI-READER-001',
    non_detail_page_contributes_nothing: true,
    unknown_page_type_is_not_detail: true,
    nameless_detail_is_not_staged: true,
    ai_evidence_has_no_confidence_or_spans: true,
    per_image_failure_is_isolated: true,
    ordered_candidate_grouping: true,
    unsafe_continuity_is_broken: true,
    continuation_fields_are_merged: true,
    failure_reason_is_preserved: true,
    job_salary_exclusion_in_prompt: true,
    network: 'not-used',
  }));
})().catch((error) => { console.error(error.message); process.exit(1); });
