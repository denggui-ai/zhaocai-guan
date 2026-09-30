// Guards the handoff file that carries model-read drafts into the import.
//
// The reads happen in the process that holds the API key; this pipeline runs in
// a child that must never see it, so the drafts arrive as a file. That file is
// an input like any other: a draft pointing at a screenshot outside the folder
// the run was given would sail past here and be refused much later by the
// evidence manifest, with a complaint that says nothing about why.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { stageAiReads } = require("../src/start-screenshot-import");
const { abortEvidenceBatch, beginEvidenceBatch } = require("../src/screenshot-evidence-store");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-reads-handoff-check-'));
// Windows keeps the SQLite handle open until the process is gone, so the
// temp tree cannot always be removed here. Losing a temp directory is not
// a reason to fail a check.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const dir = path.join(tmp, 'shots');
fs.mkdirSync(dir, { recursive: true });
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
['a.png', 'b.png'].forEach((name) => fs.writeFileSync(path.join(dir, name), png));
const outside = path.join(tmp, 'elsewhere.png');
fs.writeFileSync(outside, png);

const batch = {
  draftsPath: path.join(tmp, 'drafts.json'),
  ocrPath: path.join(tmp, 'ocr.json'),
  sources: [1, 2].map((occurrence) => ({
    source_ref: `sha256:${crypto.createHash('sha256').update(png).digest('hex')}#${occurrence}`,
    source_sha256: crypto.createHash('sha256').update(png).digest('hex'),
    size_bytes: png.length,
  })),
};
const files = ['a.png', 'b.png'];
const sourceManifest = (names = files) => names.map((fileName) => {
  const bytes = fs.readFileSync(path.join(dir, fileName));
  return {
    file_name: fileName,
    source_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size_bytes: bytes.length,
  };
});

const draftFor = (file) => ({
  draft_id: `screenshot-ai-${path.basename(file)}`,
  name: '张三',
  files: [file],
  facts: { work_years: '8年', degree: '大专', age: '28岁', salary: null, availability: null },
  field_evidence: { name: { field_key: 'name', extracted_value: '张三', confidence: null, source_spans: [] } },
});

const write = (payload) => {
  const file = path.join(tmp, 'ai-reads.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  return file;
};

assert.throws(
  () => stageAiReads(write({ source_manifest: sourceManifest(), summary: {} }), dir, files, batch),
  /缺少 drafts/,
  '缺少 drafts 的交接文件必须被拒绝',
);

assert.throws(
  () => stageAiReads(write({ source_manifest: sourceManifest(), drafts: [draftFor(outside)] }), dir, files, batch),
  /本次文件夹以外/,
  '引用文件夹以外截图的草稿必须被拒绝，且报清楚原因',
);

assert.throws(
  () => stageAiReads(write({ source_manifest: sourceManifest(), drafts: [{ ...draftFor(path.join(dir, 'a.png')), files: [] }] }), dir, files, batch),
  /没有对应截图/,
  '没有截图的草稿必须被拒绝',
);

const counts = stageAiReads(write({
  source_manifest: sourceManifest(),
  drafts: [draftFor(path.join(dir, 'a.png'))],
  summary: { skipped_list_count: 1, unrecognized_count: 2, failed_count: 3 },
}), dir, files, batch);

assert.equal(counts.image_count, 2, '张数以本次文件夹为准，不听交接文件的');
assert.equal(counts.detail_draft_count, 1);
assert.equal(counts.skipped_list_count, 1, '跳过的列表页必须计数，否则会显示成未识别');
assert.equal(counts.unrecognized_count, 2);
assert.equal(counts.failed_count, 3, '调用失败必须单独计数，不能混进未识别');

const staged = JSON.parse(fs.readFileSync(batch.draftsPath, 'utf8'));
assert.equal(staged.source_dir, dir);
assert.equal(staged.drafts.length, 1);
assert.equal(staged.reader, 'external_ai_vision_v1', '草稿必须标明是模型读出来的');
// There is no recognised text behind an AI-read draft, and claiming otherwise
// would put invented text into the evidence trail.
assert.deepEqual(JSON.parse(fs.readFileSync(batch.ocrPath, 'utf8')), [],
  'AI 路径没有 OCR 文本，sidecar 必须为空而不是伪造');

assert.throws(
  () => stageAiReads(write({ drafts: [draftFor(path.join(dir, 'a.png'))] }), dir, files, batch),
  /内容清单/,
  '没有逐图内容身份的旧 handoff 必须 fail closed',
);

const driftDir = path.join(tmp, 'drift-shots');
const driftDataDir = path.join(tmp, 'drift-data');
fs.mkdirSync(driftDir);
const driftFile = path.join(driftDir, 'candidate.png');
const approvedBytes = Buffer.from('approved-image-bytes');
fs.writeFileSync(driftFile, approvedBytes);
const driftPayload = {
  source_files: ['candidate.png'],
  source_manifest: [{
    file_name: 'candidate.png',
    source_sha256: crypto.createHash('sha256').update(approvedBytes).digest('hex'),
    size_bytes: approvedBytes.length,
  }],
  drafts: [draftFor(driftFile)],
  summary: {},
};
fs.writeFileSync(driftFile, Buffer.from('replacement-before-child-evidence'));
const driftBatch = beginEvidenceBatch({ dataDir: driftDataDir, sourceFiles: [driftFile], batchScope: 'drift.synthetic' });
const driftHandoff = write(driftPayload);
assert.throws(
  () => stageAiReads(driftHandoff, driftDir, ['candidate.png'], driftBatch),
  (error) => error && error.code === 'SCREENSHOT_AI_HANDOFF_SOURCE_CHANGED',
  '读图后、证据批次前替换原图必须在写 drafts/ingest 前停止',
);
assert.equal(fs.existsSync(driftBatch.draftsPath), false, '材料漂移不得产生任何待 ingest 草稿');
abortEvidenceBatch(driftBatch);

console.log(JSON.stringify({
  ok: true,
  contract: 'SCREENSHOT-AI-READS-HANDOFF-001',
  rejects_missing_drafts: true,
  rejects_screenshots_outside_the_selected_folder: true,
  rejects_draft_without_screenshot: true,
  image_count_comes_from_the_folder: true,
  skipped_and_failed_counted_separately: true,
  ocr_sidecar_is_empty_not_fabricated: true,
  approved_source_manifest_required: true,
  source_drift_before_child_has_zero_ingest: true,
  network: 'not-used',
}));
