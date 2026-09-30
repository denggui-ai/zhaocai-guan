
const { PROJECT_ROOT } = require("../src/paths");
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-ingest-check-'));
const dbPath = path.join(tmp, 'check.db');
process.env.HRBOSS_DATA_DIR = tmp;
process.env.BOSS_DB_PATH = dbPath;
const db = require("../src/db");
const {
  confirmScreenshotOcrDraft,
  editScreenshotOcrDraft,
  ingestScreenshotDrafts,
  listScreenshotOcrDrafts,
  listScreenshotOcrReviewAudit,
  rejectScreenshotOcrDraft,
} = require("../src/ingest-screenshot-drafts");

const draftsPath = path.join(tmp, 'drafts.json');
const stitchedIndexPath = path.join(tmp, 'index.json');
const ocrPath = path.join(tmp, 'ocr.json');
const manifestPath = path.join(tmp, 'manifest.json');
const syntheticBatchId = `sha256-${'a'.repeat(64)}`;
const probeImage = path.join(tmp, 'import', 'screenshot-evidence', 'batches', syntheticBatchId, 'derived', 'check-screenshot-ingest-probe.jpg');
const legacyProbeImage = path.join(tmp, 'import', 'stitched-candidates', 'check-screenshot-ingest-legacy.jpg');
const probeStoredPath = path.posix.join('import', 'screenshot-evidence', 'batches', syntheticBatchId, 'derived', path.basename(probeImage));
const LOCAL_API_TOKEN = 'test-local-api-token-screenshot-ingest-0001';

// Windows keeps the SQLite handle open until the process is gone, so the
// temp tree cannot always be removed here. Losing a temp directory is not
// a reason to fail a check.
process.on('exit', () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function getBuffer(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = require('http').get({
      host: '127.0.0.1',
      port,
      path: pathname,
      headers: { 'x-hrboss-token': LOCAL_API_TOKEN },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('request timeout')));
  });
}

async function withServer(port, fn) {
  const server = spawn(process.execPath, [path.join(PROJECT_ROOT, "src/db-server.js")], {
    cwd: PROJECT_ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      BOSS_DB_PATH: dbPath,
      HRBOSS_DATA_DIR: tmp,
      BOSS_READONLY_PORT: String(port),
      HRBOSS_LOCAL_API_TOKEN: LOCAL_API_TOKEN,
      HRBOSS_LOCAL_API_INSTANCE_ID: 'check-screenshot-ingest',
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fn();
  } finally {
    server.kill();
  }
}

fs.mkdirSync(path.dirname(probeImage), { recursive: true });
fs.mkdirSync(path.dirname(legacyProbeImage), { recursive: true });
fs.writeFileSync(probeImage, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
fs.writeFileSync(legacyProbeImage, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
fs.writeFileSync(manifestPath, JSON.stringify({
  schema_version: 'screenshot_evidence_batch_v1',
  batch_id: syntheticBatchId,
  sources: ['b', 'd', 'e'].map((char) => ({ source_sha256: char.repeat(64) })),
  derived: ['screenshot-check-001', 'screenshot-check-reject', 'screenshot-check-invalid'].map((draftId, index) => ({
    draft_id: draftId,
    relative_path: probeStoredPath,
    derived_sha256: 'c'.repeat(64),
    source_hashes: [['b', 'd', 'e'][index].repeat(64)],
  })),
}));

fs.writeFileSync(draftsPath, JSON.stringify({
  source_dir: '/tmp/boss-screenshots',
  generated_at: '2026-07-09T00:00:00.000Z',
  image_count: 2,
  detail_draft_count: 3,
  drafts: [{
    draft_id: 'screenshot-check-001',
    source: 'Boss App截图导入草稿',
    name: '李英男',
    files: ['/tmp/boss-screenshots/IMG_5005.PNG', '/tmp/boss-screenshots/IMG_5006.PNG'],
    facts: {
      work_years: null,
      degree: '大专',
      age: '31岁',
      salary: '1.2-1.5万元',
      availability: '离职-随时到岗',
      recent_focus: '信息流优化师，广州',
      work_experience_text: '广州市柴记商贸有限公司\n投放主管 新媒体电商',
      education_text: '广东职业技术学院\n大专•电子商务',
    },
    field_evidence: {
      name: {
        field_key: 'name',
        extracted_value: '李英男',
        confidence: 0.97,
        source_spans: [{ source_file: 'IMG_5005.PNG', line_index: 1, text: '李英男', confidence: 0.97, bbox: { left: 60, top: 390, width: 230, height: 76 } }],
        conflict_values: [],
        extraction_method: 'relative_header_geometry_v2',
        trusted: true,
      },
      salary: {
        field_key: 'facts.salary',
        extracted_value: '1.2-1.5万元',
        confidence: 0.61,
        source_spans: [{ source_file: 'IMG_5005.PNG', line_index: 9, text: '1.2-1.5万元', confidence: 0.61, bbox: { left: 960, top: 1480, width: 260, height: 42 } }],
        conflict_values: ['1.2-1.5万元', '1.3-1.6万元'],
      },
      work_years: {
        field_key: 'facts.work_years',
        extracted_value: null,
        confidence: 0.93,
        source_spans: [],
        conflict_values: [],
        rejected_value: '19年',
        rejected_reason: '识别到的工作年限与年龄 31 岁不符',
      },
    },
    ocr_text: [
      '李英男',
      '工作经历',
      '广州市柴记商贸有限公司',
      '投放主管 新媒体电商',
      '教育经历',
      '广东职业技术学院',
      '大专•电子商务',
      '项目经历',
      '项目名称：合成投放平台',
      '项目角色：负责人',
      '负责投放数据回收',
    ].join('\n'),
  }, {
    draft_id: 'screenshot-check-reject',
    source: 'Boss App截图导入草稿',
    name: '合成驳回样本',
    files: ['/tmp/boss-screenshots/IMG_6001.PNG'],
    facts: { degree: '本科', work_experience_text: '不进入正式档案' },
    field_evidence: {
      name: { field_key: 'name', extracted_value: '合成驳回样本', confidence: 0.95, source_spans: [], conflict_values: [] },
    },
    ocr_text: '合成驳回样本\n无关杂文',
  }, {
    draft_id: 'screenshot-check-invalid',
    source: 'Boss App截图导入草稿',
    name: '',
    files: ['/tmp/boss-screenshots/IMG_7001.PNG'],
    facts: { degree: '大专' },
    field_evidence: {},
    ocr_text: '姓名无法识别',
  }],
}, null, 2));

fs.writeFileSync(stitchedIndexPath, JSON.stringify({
  count: 3,
  rows: ['screenshot-check-001', 'screenshot-check-reject', 'screenshot-check-invalid'].map((draftId) => ({
    draft_id: draftId,
    stitched_file: probeStoredPath,
  })),
}, null, 2));

fs.writeFileSync(ocrPath, JSON.stringify([{
  file: '/tmp/boss-screenshots/IMG_5005.PNG',
  lines: [
    { text: '抖音运营（商品卡/千川投流）', top: 195, height: 70 },
  ],
}], null, 2));

function ingestSingleSynthetic({ key, batchChar, sourceHash, draft, sourceDir, importedAt, jobName }) {
  const oneDrafts = path.join(tmp, `${key}-drafts.json`);
  const oneIndex = path.join(tmp, `${key}-index.json`);
  const oneOcr = path.join(tmp, `${key}-ocr.json`);
  const oneManifest = path.join(tmp, `${key}-manifest.json`);
  const batchId = `sha256-${batchChar.repeat(64)}`;
  fs.writeFileSync(oneDrafts, JSON.stringify({ source_dir: sourceDir, drafts: [draft] }));
  fs.writeFileSync(oneIndex, JSON.stringify({ rows: [{ draft_id: draft.draft_id, stitched_file: probeStoredPath }] }));
  fs.writeFileSync(oneOcr, '[]');
  fs.writeFileSync(oneManifest, JSON.stringify({
    schema_version: 'screenshot_evidence_batch_v1',
    batch_id: batchId,
    sources: [{ source_sha256: sourceHash }],
    derived: [{
      draft_id: draft.draft_id,
      relative_path: probeStoredPath,
      derived_sha256: 'c'.repeat(64),
      source_hashes: [sourceHash],
    }],
  }));
  return ingestScreenshotDrafts({
    draftsPath: oneDrafts,
    stitchedIndexPath: oneIndex,
    ocrPath: oneOcr,
    manifestPath: oneManifest,
    sourceDir,
    importedAt,
    jobName,
  });
}

db.openDb(dbPath);
const first = ingestScreenshotDrafts({ draftsPath, stitchedIndexPath, ocrPath, manifestPath, importedAt: '2026-07-09T00:00:00.000Z' });
assert.equal(first.total, 3);
assert.equal(first.draft_created, 3);
assert.equal(first.pending_review, 3);
assert.equal(first.inserted, 0);
assert.equal(first.updated, 0);
assert.match(first.job_name, /截图导入 · 抖音运营/);
assert.equal(first.evidence_batch_id, syntheticBatchId);
assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM candidate').get().n, 0, 'pending OCR must not create candidates');
assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM resume_online').get().n, 0, 'pending OCR must not create resumes');

let pending = listScreenshotOcrDrafts({ status: 'pending_review' });
assert.equal(pending.length, 3);
const reviewDraft = pending.find((row) => row.draft_id === 'screenshot-check-001');
const rejectDraft = pending.find((row) => row.draft_id === 'screenshot-check-reject');
const invalidDraft = pending.find((row) => row.draft_id === 'screenshot-check-invalid');
assert.equal(reviewDraft.field_evidence.salary.confidence, 0.61, 'field confidence must survive staging');
assert.ok(reviewDraft.field_evidence.salary.source_spans[0].bbox, 'field source span must survive staging');
assert.ok(reviewDraft.review_flags.fields.some((flag) => flag.field_key === 'facts.salary' && flag.kind === 'low_confidence'));
assert.ok(reviewDraft.review_flags.fields.some((flag) => flag.field_key === 'facts.salary' && flag.kind === 'conflict'));
assert.equal(reviewDraft.field_evidence.work_years.rejected_value, '19年', 'rejected OCR value must survive staging');
assert.match(reviewDraft.field_evidence.work_years.rejected_reason, /年龄 31 岁不符/);
assert.ok(reviewDraft.review_flags.fields.some((flag) => flag.field_key === 'facts.work_years'
  && flag.kind === 'value_rejected' && flag.rejected_value === '19年'), 'rejected OCR value must be consumable through review flags');

const second = ingestScreenshotDrafts({ draftsPath, stitchedIndexPath, ocrPath, manifestPath, importedAt: '2026-07-09T00:01:00.000Z' });
assert.equal(second.total, 3);
assert.equal(second.draft_created, 0);
assert.equal(second.draft_reused, 3);
assert.equal(second.inserted, 0);
assert.equal(second.updated, 0);
assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM screenshot_ocr_draft').get().n, 3, 'same batch re-ingest must be idempotent');
assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM screenshot_ocr_review_audit WHERE action = ?').get('created').n, 3, 'idempotent re-ingest must not duplicate created audit');

const edited = editScreenshotOcrDraft(reviewDraft.id, {
  changes: { facts: { salary: '1.4-1.7万元' } },
  actor: '合成测试HR-001',
  at: '2026-07-09T00:02:00.000Z',
});
assert.equal(edited.current.facts.salary, '1.4-1.7万元');
const editAudit = listScreenshotOcrReviewAudit(reviewDraft.id).find((row) => row.action === 'edited');
assert.equal(editAudit.actor, '合成测试HR-001');
assert.equal(editAudit.before.facts.salary, '1.2-1.5万元');
assert.equal(editAudit.after.facts.salary, '1.4-1.7万元');
assert.equal(editAudit.created_at, '2026-07-09T00:02:00.000Z');

assert.throws(
  () => confirmScreenshotOcrDraft(rejectDraft.id, { actor: '合成测试HR-002', at: '2026-07-09T00:02:30.000Z' }),
  /确认失败：.*姓名未通过版式定位/,
  '非空姓名没有可信页头证据时也必须失败关闭',
);
assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM candidate').get().n, 0);
const rejected = rejectScreenshotOcrDraft(rejectDraft.id, { actor: '合成测试HR-002', at: '2026-07-09T00:03:00.000Z' });
assert.equal(rejected.status, 'rejected');
assert.equal(rejectScreenshotOcrDraft(rejectDraft.id, { actor: '合成测试HR-002' }).idempotent, true, 'reject retry must be idempotent');
assert.throws(() => confirmScreenshotOcrDraft(rejectDraft.id, { actor: '合成测试HR-002' }), /已驳回/);
assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM candidate').get().n, 0, 'rejected OCR must not create candidates');

assert.throws(
  () => confirmScreenshotOcrDraft(invalidDraft.id, { actor: '合成测试HR-003', at: '2026-07-09T00:04:00.000Z' }),
  /姓名为空/,
  'confirmation failure must keep the draft pending and roll back official writes',
);
assert.equal(listScreenshotOcrDrafts({ status: 'pending_review' }).some((row) => row.id === invalidDraft.id), true);
assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM candidate').get().n, 0);

const confirmed = confirmScreenshotOcrDraft(reviewDraft.id, { actor: '合成测试HR-001', at: '2026-07-09T00:05:00.000Z' });
assert.equal(confirmed.status, 'confirmed');
assert.equal(confirmed.inserted, true);
const confirmedAgain = confirmScreenshotOcrDraft(reviewDraft.id, { actor: '合成测试HR-001', at: '2026-07-09T00:06:00.000Z' });
assert.equal(confirmedAgain.idempotent, true, 'confirmation retry must not duplicate candidate/resume/audit');
assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM candidate').get().n, 1);
assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM resume_online').get().n, 1);
assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM screenshot_ocr_review_audit WHERE screenshot_draft_id = ? AND action = ?').get(reviewDraft.id, 'confirmed').n, 1);

const renamedImport = ingestSingleSynthetic({
  key: 'renamed',
  batchChar: 'f',
  sourceHash: 'b'.repeat(64),
  sourceDir: '/synthetic/moved-and-renamed-folder',
  importedAt: '2026-07-09T00:07:00.000Z',
  jobName: first.job_name,
  draft: {
    ...reviewDraft.original,
    draft_id: 'renamed-file-draft-id',
    files: ['completely-renamed.png'],
    facts: { ...reviewDraft.original.facts, salary: '12-15K' },
  },
});
assert.equal(renamedImport.job_id, first.job_id, 'moving/renaming screenshots must keep the same local job');
assert.equal(renamedImport.draft_created, 0, 'same source content under a new path/name must reuse the draft');
assert.equal(renamedImport.rows[0].id, reviewDraft.id);
assert.equal(renamedImport.rows[0].status, 'confirmed');
assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM candidate').get().n, 1, 'renamed screenshot must not duplicate candidate');

const sameNameDifferentContent = ingestSingleSynthetic({
  key: 'same-name-different-content',
  batchChar: '8',
  sourceHash: '9'.repeat(64),
  sourceDir: '/synthetic/different-person-folder',
  importedAt: '2026-07-09T00:08:00.000Z',
  jobName: first.job_name,
  draft: {
    ...reviewDraft.original,
    draft_id: 'same-name-different-content',
    files: ['different-person.png'],
    facts: {
      ...reviewDraft.original.facts,
      salary: '12-15K',
      work_experience_text: '合成乙公司\n负责客服运营',
      education_text: '合成第二学院\n客户服务',
    },
  },
});
assert.equal(sameNameDifferentContent.draft_created, 1);
const conflictDraft = listScreenshotOcrDrafts({ status: 'pending_review', jobId: first.job_id })
  .find((row) => row.draft_id === 'same-name-different-content');
assert.ok(conflictDraft, 'same-name/different-content record must remain a separate pending draft');
assert.equal(conflictDraft.identity.status, 'pending_manual_merge');
assert.ok(conflictDraft.review_flags.fields.some((flag) => flag.kind === 'same_name_different_content'));
assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM candidate').get().n, 1, 'same name must never auto-merge or auto-create a candidate');

const crossJob = ingestSingleSynthetic({
  key: 'cross-job-same-source',
  batchChar: '7',
  sourceHash: 'b'.repeat(64),
  sourceDir: '/synthetic/another-job',
  importedAt: '2026-07-09T00:09:00.000Z',
  jobName: '截图导入 · 另一个合成岗位',
  draft: {
    ...reviewDraft.original,
    draft_id: 'cross-job-same-source',
    files: ['same-source-another-job.png'],
  },
});
assert.notEqual(crossJob.job_id, first.job_id);
assert.equal(crossJob.draft_created, 1, 'identity dedupe must never cross job boundaries');
assert.notEqual(crossJob.rows[0].id, reviewDraft.id);

const candidate = db.conn().prepare('SELECT * FROM candidate WHERE source = ?').get('截图导入');
assert.ok(candidate, 'manually confirmed screenshot candidate should be inserted');
assert.equal(candidate.name, '李英男');
assert.equal(candidate.salary, '1.4-1.7万元', 'manual correction must be the confirmed fact');
assert.equal(candidate.keys_complete, 0, 'screenshot candidates must not be eligible for Boss actions');
assert.equal(candidate.geek_id, `screenshot:${confirmed.identity.identity_key}`);
assert.ok(!candidate.boss_id && !candidate.security_id && !candidate.lid, 'Boss key fields must stay empty');

const resume = db.conn().prepare('SELECT sections_json, raw_json FROM resume_online WHERE candidate_id = ?').get(candidate.internal_id);
assert.ok(resume, 'screenshot OCR content should be available in resume view');
const sections = JSON.parse(resume.sections_json);
assert.equal(sections.source, 'boss_app_screenshot');
assert.equal(sections.basic[0].age, '31岁');
assert.equal(sections.expect[0].city, '广州');
assert.equal(sections.expect[0].salary, '1.4-1.7万元');
assert.equal(sections.expect[0].salary_raw, '1.4-1.7万元');
assert.equal(sections.expect[0].salary_normalized.normalized_text, '14-17K');
assert.equal(sections.expect[0].salary_normalized.max_k, 17);
assert.match(sections.work[0].desc, /广州市柴记商贸/);
assert.equal(sections.resume_structure.schema_version, 'resume_structure_v1');
assert.equal(sections.work[0].company, '广州市柴记商贸有限公司');
assert.equal(sections.edu[0].school, '广东职业技术学院');
assert.equal(sections.proj[0].name, '合成投放平台');
assert.match(sections.resume_structure.raw_sections.work, /投放主管/);
assert.match(sections.resume_structure.raw_sections.project, /投放数据回收/);
assert.match(JSON.parse(resume.raw_json).stitched_file, /check-screenshot-ingest-probe/);
assert.equal(sections.evidence_batch_id, syntheticBatchId);
assert.deepEqual(sections.source_hashes, ['b'.repeat(64)]);
assert.equal(sections.derived_hash, 'c'.repeat(64));
assert.equal(sections.evidence_path, probeStoredPath);
assert.deepEqual(sections.skill, [], 'OCR prose must never be written into skill');
assert.equal(sections.ocr_review.status, 'confirmed');
assert.equal(sections.ocr_review.reviewed_by, '合成测试HR-001');
assert.equal(sections.ocr_review.field_evidence.salary.confidence, 0.61, 'confidence must remain traceable after confirmation');
assert.equal(sections.ocr_review.field_evidence.work_years.rejected_value, '19年');
assert.match(sections.ocr_review.field_evidence.work_years.rejected_reason, /年龄 31 岁不符/);
assert.ok(sections.ocr_review.review_flags.fields.some((flag) => flag.kind === 'conflict'));
assert.equal(sections.screenshot_identity.identity_key, confirmed.identity.identity_key);

const screenshot = db.resolveCandidateScreenshot(candidate.internal_id);
assert.ok(screenshot, 'safe stitched screenshot path should resolve');
assert.equal(screenshot.content_type, 'image/jpeg');
assert.equal(screenshot.path, fs.realpathSync(probeImage));

const legacySections = { ...sections, stitched_file: 'import/stitched-candidates/check-screenshot-ingest-legacy.jpg' };
db.conn().prepare('UPDATE resume_online SET sections_json = ? WHERE candidate_id = ?')
  .run(JSON.stringify(legacySections), candidate.internal_id);
const legacyScreenshot = db.resolveCandidateScreenshot(candidate.internal_id);
assert.ok(legacyScreenshot, 'legacy stitched-candidates path should remain readable');
assert.equal(legacyScreenshot.path, fs.realpathSync(legacyProbeImage));
db.conn().prepare('UPDATE resume_online SET sections_json = ? WHERE candidate_id = ?')
  .run(JSON.stringify(sections), candidate.internal_id);

const listed = db.listCandidates(candidate.job_id)[0];
assert.equal(listed.source, '截图导入', 'listCandidates should expose safe source label');
assert.ok(!Object.hasOwn(listed, 'geek_id'), 'listCandidates must still hide key fields');

assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM candidate WHERE geek_id = ?').get('screenshot:screenshot-check-reject').n, 0, 'rejected draft must not enter search/rules');
assert.equal(db.conn().prepare('SELECT COUNT(*) AS n FROM candidate WHERE geek_id = ?').get('screenshot:screenshot-check-invalid').n, 0, 'unconfirmed draft must not enter search/rules');

const manuallyNamed = editScreenshotOcrDraft(invalidDraft.id, {
  changes: { name: '王校对' },
  actor: '合成测试HR-003',
  at: '2026-07-09T00:10:00.000Z',
});
assert.equal(manuallyNamed.current.name, '王校对');
const manuallyConfirmed = confirmScreenshotOcrDraft(invalidDraft.id, {
  actor: '合成测试HR-003',
  at: '2026-07-09T00:11:00.000Z',
});
assert.equal(manuallyConfirmed.status, 'confirmed', '人工明确修改姓名后可继续确认');
assert.equal(manuallyConfirmed.current.name, '王校对');

const run = db.getLatestRunByType('截图 OCR 草稿暂存');
assert.equal(run.count_total, 1);
assert.ok(db.conn().prepare('SELECT COUNT(*) AS n FROM run_log WHERE run_type = ?').get('截图 OCR 草稿暂存').n >= 5);

if (process.env.HRBOSS_SKIP_LOCAL_SERVER === '1') {
  console.log('check-screenshot-ingest ok (local server skipped)');
} else withServer(19000 + (process.pid % 1000), async () => {
  const port = 19000 + (process.pid % 1000);
  const image = await getBuffer(port, `/api/candidates/${encodeURIComponent(candidate.internal_id)}/screenshot`);
  assert.equal(image.status, 200, 'screenshot endpoint should serve safe local image');
  assert.match(image.headers['content-type'], /image\/jpeg/);
  assert.equal(image.body.length, 4);
  const notFound = await getBuffer(port, '/api/candidates/not-found/screenshot');
  assert.equal(notFound.status, 404);
  console.log('check-screenshot-ingest ok');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
