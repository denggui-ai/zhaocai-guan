
const { PROJECT_ROOT } = require("../src/paths");
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
  buildDrafts,
  classifyImage,
  extractFacts,
  extractName,
} = require("../src/import-boss-screenshots");
const { assertSupportedOcrRoute } = require("../src/start-screenshot-import");

async function checkVisionPrerequisites() {
  const unavailable = Object.assign(new Error('本地 Swift 不可用；请运行 xcode-select --install，完成后重试。'), {
    code: 'SCREENSHOT_OCR_VISION_UNAVAILABLE',
  });
  let checked = 0;
  const checkLocalVision = async () => { checked++; throw unavailable; };
  await assert.rejects(
    Promise.resolve().then(() => assertSupportedOcrRoute({ platform: 'darwin', checkLocalVision })),
    (error) => error === unavailable,
    'macOS must verify runnable local tools before starting screenshot import',
  );
  assert.equal(checked, 1);
  await assertSupportedOcrRoute({ platform: 'darwin', checkLocalVision: async () => {} });
  await assertSupportedOcrRoute({ platform: 'win32', aiReadsPath: '/tmp/approved-ai-reads.json', checkLocalVision });
  assert.equal(checked, 1, 'approved AI handoffs must not need the local Swift toolchain');
  await assert.rejects(
    Promise.resolve().then(() => assertSupportedOcrRoute({ platform: 'win32' })),
    (error) => error.code === 'SCREENSHOT_EXTERNAL_AI_APPROVAL_REQUIRED' && /逐图预览/.test(error.message),
    'non-macOS direct imports must retain per-image approval instead of falling back',
  );

  const { probeLocalVisionReadiness, assertLocalVisionReady } = require("../src/local-vision-preflight");
  const commands = [];
  let failure = 'developer-tools';
  const run = async (command, args, options) => {
    commands.push([command, args]);
    assert.equal(options.timeout, 3000);
    assert.equal(options.shell, false);
    if (failure === 'developer-tools' && command === '/usr/bin/xcode-select') return { status: 1, stdout: '' };
    if (command === '/usr/bin/xcode-select') return { status: 0, stdout: '/synthetic/CommandLineTools\n' };
    if (args.includes('--find')) return { status: failure === 'swift-missing' ? 1 : 0, stdout: '/synthetic/usr/bin/swift\n' };
    if (command === '/usr/bin/swift') {
      if (failure === 'timeout') throw Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' });
      return { status: failure === 'swift-broken' ? 1 : 0, stdout: 'Apple Swift version 6.2\n' };
    }
    return { status: failure === 'sdk-missing' ? 1 : 0, stdout: '/synthetic/MacOSX.sdk\n' };
  };
  for (failure of ['developer-tools', 'swift-missing', 'swift-broken', 'timeout', 'sdk-missing']) {
    commands.length = 0;
    const result = await probeLocalVisionReadiness({ platform: 'darwin', run });
    assert.equal(result.available, false, failure);
    assert.equal(result.code, 'SCREENSHOT_OCR_VISION_UNAVAILABLE');
    assert.match(result.message, /xcode-select --install/);
    assert.match(result.message, /重试/);
    assert.ok(!commands.some(([, args]) => args.includes('--install')), 'preflight cannot open an installation prompt');
    assert.ok(!commands.some(([, args]) => args.includes('-e') || args.some((arg) => arg.endsWith('.swift'))), 'preflight must not recompile OCR');
    if (failure === 'developer-tools') assert.equal(commands.length, 1, 'missing CLT must not invoke the Swift installation shim');
  }
  await assert.rejects(assertLocalVisionReady({ platform: 'darwin', run }), { code: 'SCREENSHOT_OCR_VISION_UNAVAILABLE' });
  failure = '';
  assert.equal((await probeLocalVisionReadiness({ platform: 'darwin', run })).available, true, 'retry after repairing tools must succeed');

  // Execute the real production route branches with side effects replaced; no HTTP port/GUI/AI.
  const actionSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/action-server.js"), 'utf8');
  const routeBlock = (name, next) => {
    const from = actionSource.indexOf(`    if (req.method === 'POST' && url.pathname === '/api/screenshot-import/${name}') {`);
    const to = actionSource.indexOf(`    if (req.method === 'POST' && url.pathname === '/api/screenshot-import/${next}') {`, from);
    assert.ok(from >= 0 && to > from);
    return `(async () => {${actionSource.slice(from, to)}\n})()`;
  };
  let ready = false, spawned = 0, progressWrites = 0;
  const context = { req: { method: 'POST' }, res: {}, url: {}, path,
    crypto: { randomUUID: () => 'synthetic-preflight' }, nowIso: () => '2026-09-30T00:00:00.000Z',
    readBody: async () => ({ dir: '/synthetic/screenshots' }), send: (_res, status, body) => ({ status, body }),
    screenshotImportEngine: () => 'macos_vision', assertLocalVisionReady: async () => { if (!ready) throw unavailable; },
    screenshotImportProgress: { readProgress: () => ({}), writeProgress: () => { progressWrites++; } },
    freshActiveProgress: () => false, resolveSelectedDirectory: () => ({ path: '/synthetic/screenshots' }),
    spawnDetached: () => { spawned++; return 123; },
    f009Runtime: { externalAiStatus: () => { throw new Error('must not choose AI when local tools are unavailable'); } },
  };
  for (const [name, next] of [['preflight','start'],['start','retry-preflight']]) {
    context.url = { pathname: `/api/screenshot-import/${name}` };
    const result = await vm.runInNewContext(routeBlock(name,next), context);
    assert.equal(result.status, 400, `${name} must reject missing tools`);
    assert.equal(result.body.code, unavailable.code);
    assert.match(result.body.error, /xcode-select --install/);
  }
  assert.equal(spawned, 0); assert.equal(progressWrites, 0);
  ready = true;
  context.url = { pathname: '/api/screenshot-import/preflight' };
  const preview = await vm.runInNewContext(routeBlock('preflight','start'), context);
  assert.equal(preview.status, 200); assert.equal(preview.body.preview.requires_external_ai, false);
  context.url = { pathname: '/api/screenshot-import/start' };
  assert.equal((await vm.runInNewContext(routeBlock('start','retry-preflight'), context)).status, 200);
  assert.equal(spawned, 1); assert.equal(progressWrites, 1);
  let progressReads = 0;
  context.screenshotImportProgress.readProgress = () => ({ active: ++progressReads > 1 });
  context.freshActiveProgress = (value) => value.active;
  context.publicScreenshotImportProgress = (value) => value;
  assert.equal((await vm.runInNewContext(routeBlock('start','retry-preflight'), context)).status, 409,
    'a second request must not start another importer after waiting on the tool probe');
  assert.equal(spawned, 1); assert.equal(progressWrites, 1);
}

const detail = {
  file: '/tmp/IMG_1.PNG',
  width: 1290,
  height: 2796,
  lines: [
    { text: 'BOSS直聘', left: 540, top: 40, width: 200, height: 40 },
    { text: '李英男', left: 60, top: 390, width: 230, height: 76 },
    { text: '广州市柴记商贸•投放主管', left: 60, top: 520, width: 520, height: 42 },
    { text: '离职-随时到岗', left: 60, top: 700, width: 240, height: 44 },
    { text: '7年', left: 60, top: 795, width: 80, height: 40 },
    { text: '大专', left: 300, top: 795, width: 80, height: 40 },
    { text: '31岁', left: 430, top: 795, width: 80, height: 40 },
    { text: '最近关注', left: 60, top: 1320, width: 180, height: 50 },
    { text: '信息流优化师，广州', left: 60, top: 1480, width: 420, height: 42 },
    { text: '1.2-1.5万元', left: 960, top: 1480, width: 260, height: 42 },
    { text: '工作经历', left: 60, top: 1700, width: 180, height: 50 },
    { text: '广州市柴记商贸有限公司', left: 60, top: 1900, width: 460, height: 42 },
    { text: '投放主管 新媒体电商', left: 60, top: 2000, width: 420, height: 42 },
    { text: '立即沟通', left: 500, top: 2600, width: 260, height: 50 },
  ],
};
detail.lines = detail.lines.map((line) => ({
  ...line,
  confidence: line.text === '1.2-1.5万元' ? 0.62 : 0.96,
}));

assert.equal(classifyImage(detail), 'detail');
assert.equal(extractName(detail.lines, detail.height), '李英男');
const facts = extractFacts(detail.lines);
assert.equal(facts.work_years, '7年');
assert.equal(facts.degree, '大专');
assert.equal(facts.age, '31岁');
assert.equal(facts.salary, '1.2-1.5万元');
assert.match(facts.recent_focus, /信息流优化师/);
assert.match(facts.work_experience_text, /广州市柴记商贸/);

const conflictingDetail = {
  ...detail,
  file: '/tmp/IMG_2.PNG',
  lines: detail.lines.map((line) => (line.text === '大专' ? { ...line, text: '本科', confidence: 0.91 } : line)),
};
const drafts = buildDrafts([detail, conflictingDetail]);
assert.equal(drafts.length, 1);
assert.equal(drafts[0].name, '李英男');
assert.equal(drafts[0].facts.degree, '大专');
assert.equal(drafts[0].field_evidence.salary.confidence, 0.62, 'field confidence must retain the lowest supporting span confidence');
assert.deepEqual(drafts[0].field_evidence.degree.conflict_values, ['大专', '本科']);
assert.equal(drafts[0].field_evidence.name.source_spans[0].source_file, 'IMG_1.PNG');
assert.equal(drafts[0].field_evidence.name.trusted, true);
assert.equal(drafts[0].field_evidence.name.extraction_method, 'relative_header_geometry_v2');
assert.ok(drafts[0].field_evidence.work_experience_text.source_spans.length > 0, 'section facts must retain source spans');

const pagedHeader = {
  file: '/tmp/合成分页/profile-alpha_page1.jpg',
  width: 779,
  height: 826,
  lines: [
    { text: '李英男 刚刚活跃', left: 132, top: 40, width: 180, height: 24, confidence: 0.98 },
    { text: '工作经历', left: 52, top: 300, width: 90, height: 20, confidence: 0.99 },
  ],
};
const pagedList = {
  file: '/tmp/合成分页/profile-alpha_page2.jpg',
  width: 779,
  height: 826,
  lines: [{ text: '推荐 最新', left: 20, top: 20, width: 120, height: 18, confidence: 0.99 }],
};
const pagedUnknown = {
  file: '/tmp/合成分页/profile-alpha_page3.jpg',
  width: 779,
  height: 826,
  lines: [{ text: '合成分页正文', left: 100, top: 300, width: 180, height: 18, confidence: 0.99 }],
};
const pagedDrafts = buildDrafts([pagedHeader, pagedList, pagedUnknown]);
assert.equal(pagedDrafts.length, 1, '明确且连续的分页文件组应只生成一条草稿');
assert.equal(pagedDrafts[0].files.length, 3, 'list/unknown 续页不得被丢弃');
assert.equal(pagedDrafts[0].name, '李英男', '页头活跃状态不得混入姓名');
assert.equal(pagedDrafts[0].grouping.strategy, 'filename_page_sequence');

assert.equal(extractName([{
  text: '医药指标生产及使用 Oracle 批量插入指标数据',
  left: 40,
  top: 40,
  width: 650,
  height: 40,
  confidence: 0.99,
}], 826, 779), null, '混合中文正文不得仅凭其中的拉丁词被识别为姓名');

const incompletePageDrafts = buildDrafts([
  { ...pagedHeader, file: '/tmp/不连续/profile-beta_page1.jpg' },
  { ...pagedUnknown, file: '/tmp/不连续/profile-beta_page3.jpg' },
]);
assert.equal(incompletePageDrafts.length, 1);
assert.equal(incompletePageDrafts[0].files.length, 1, '不连续页码不得仅凭同前缀合并');

const boundaryDrafts = buildDrafts([
  { ...detail, file: '/tmp/boundary-candidate-a.png' },
  {
    file: '/tmp/boundary-list.png',
    width: 1290,
    height: 2796,
    lines: [{ text: '推荐 最新', left: 20, top: 20, width: 160, height: 40, confidence: 0.99 }],
  },
  {
    file: '/tmp/boundary-nameless-detail.png',
    width: 1290,
    height: 2796,
    lines: [
      { text: '工作经历', left: 60, top: 180, width: 180, height: 50, confidence: 0.99 },
      { text: '另一位候选人的公司经历', left: 60, top: 360, width: 420, height: 42, confidence: 0.98 },
    ],
  },
]);
assert.equal(boundaryDrafts.length, 1);
assert.deepEqual(boundaryDrafts[0].files, ['/tmp/boundary-candidate-a.png'],
  'list/unknown boundary 后的无名详情页不得串入上一位候选人');

const renamedDraft = buildDrafts([{ ...detail, file: '/different/folder/renamed.png' }])[0];
const originalDraft = buildDrafts([detail])[0];
assert.equal(renamedDraft.draft_id, originalDraft.draft_id, 'draft identity must not depend on file path/name');
const differentContent = buildDrafts([{
  ...detail,
  file: '/tmp/IMG_DIFFERENT.PNG',
  lines: detail.lines.map((line) => (line.text === '广州市柴记商贸有限公司' ? { ...line, text: '合成乙公司有限公司' } : line)),
}])[0];
assert.notEqual(differentContent.draft_id, originalDraft.draft_id, 'same name with different OCR content must remain separate');

const kSalaryFacts = extractFacts(detail.lines.map((line) => (line.text === '1.2-1.5万元' ? { ...line, text: '12-15K' } : line)));
assert.equal(kSalaryFacts.salary, '12-15K');

const seniorFacts = extractFacts([
  { text: '18年', confidence: 0.98 },
  { text: '本科', confidence: 0.98 },
  { text: '45岁', confidence: 0.98 },
]);
assert.equal(seniorFacts.work_years, '18年', '超过 15 年的真实资深经历不得被硬上限误伤');

const calendarOnlyFacts = extractFacts([
  { text: '2018年-2021年 合成科技有限公司', confidence: 0.98 },
  { text: '30岁', confidence: 0.98 },
]);
assert.equal(calendarOnlyFacts.work_years, null, '2021 年的尾两位不得误判为 21 年工作经验');

const rejectedYearsFacts = extractFacts([
  { text: '工作经验：19年', confidence: 0.98 },
  { text: '30岁', confidence: 0.98 },
]);
assert.equal(rejectedYearsFacts.work_years, null);
assert.equal(rejectedYearsFacts.work_years_rejected, '19年');
assert.match(rejectedYearsFacts.work_years_rejection_reason, /年龄 30 岁不符/);

checkVisionPrerequisites().then(() => console.log('check-screenshot-import ok'), (error) => {
  console.error(error); process.exitCode = 1;
});
