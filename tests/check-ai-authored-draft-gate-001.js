// Pins the safety property the Windows all-AI path depends on.
//
// tesseract was rejected on quality, so the plan for Windows is to have the
// model read the screenshot outright — the name included, because there is no
// local reader left to produce one. The name is what the confirm gate weighs,
// and a model answer carries no screenshot coordinates, so the question is
// whether such a draft can reach a candidate record without a human looking.
//
// It cannot, and that is enforced by the gate itself rather than by anything
// the Windows path would have to add: a draft whose name has no positional
// evidence is refused at confirm until the HR explicitly verifies that name.
// This check exists so that guarantee cannot be quietly removed later — from
// either side, the gate or the shape of an AI-authored draft.
//
// It does not license AI-written names on the fill path. applyAiFieldFill still
// rejects those outright, and check-screenshot-ai-fill covers that.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-authored-draft-check-'));
process.env.HRBOSS_DATA_DIR = tmp;
process.env.BOSS_DB_PATH = path.join(tmp, 'check.db');
// Windows keeps the SQLite handle open until the process is gone, so the
// temp tree cannot always be removed here. Losing a temp directory is not
// a reason to fail a check.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

const {
  assertConfirmableName,
  ingestScreenshotDrafts,
  listScreenshotOcrDrafts,
  listScreenshotOcrReviewAudit,
  editScreenshotOcrDraft,
  confirmScreenshotOcrDraft,
} = require("../src/ingest-screenshot-drafts");
const db = require("../src/db");
const { resolveScreenshotDraftPreview } = require("../src/screenshot-draft-preview");

const shotsDir = path.join(tmp, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });
const shot = 'ai-authored-1.png';
fs.writeFileSync(path.join(shotsDir, shot), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

// Everything a model can honestly report, and nothing it cannot: values without
// coordinates, without a confidence, without conflicts.
const draft = {
  draft_id: 'screenshot-ai-authored-1',
  source: 'Boss App截图导入草稿',
  name: '模型读出的姓名',
  files: [path.join(shotsDir, shot)],
  facts: {
    work_years: '8年', degree: '大专', age: '28岁', salary: null,
    availability: '离职-随时到岗', recent_focus: '', work_experience_text: '', education_text: '',
  },
  field_evidence: {
    name: {
      field_key: 'name',
      extracted_value: '模型读出的姓名',
      extraction_method: 'external_ai_vision_v1',
      confidence: null,
      source_spans: [],
      conflict_values: [],
    },
  },
  grouping: { strategy: 'external_ai_detail' },
  ocr_text: '模型读出的姓名\n8年 大专 28岁',
};
const unchangedVerification = assertConfirmableName({
  original_json: JSON.stringify({ name: draft.name }),
  field_evidence_json: JSON.stringify(draft.field_evidence),
}, { name: draft.name }, { nameVerifiedByHr: true });
assert.equal(unchangedVerification.method, 'explicit_hr_confirmation', '原 AI 姓名经显式原图核对后应可确认');

const draftsPath = path.join(tmp, 'drafts.json');
fs.writeFileSync(draftsPath, JSON.stringify({
  source_dir: shotsDir, generated_at: new Date().toISOString(),
  image_count: 1, detail_draft_count: 1, drafts: [draft],
}));
fs.writeFileSync(path.join(tmp, 'index.json'), JSON.stringify({ rows: [] }));
fs.writeFileSync(path.join(tmp, 'ocr.json'), JSON.stringify([]));

const ingest = ingestScreenshotDrafts({
  draftsPath, stitchedIndexPath: path.join(tmp, 'index.json'), ocrPath: path.join(tmp, 'ocr.json'),
});
assert.equal(ingest.pending_review, 1, '模型产出的草稿必须能正常进入待校对，否则 Windows 无路可走');

const row = listScreenshotOcrDrafts({ status: 'pending_review', jobId: ingest.job_id })[0];
assert.notEqual(row.field_evidence.name.trusted, true, '无坐标的姓名证据不得被标记为可信');
const originalBytes = fs.readFileSync(path.join(shotsDir, shot));
const storedRow = db.conn().prepare('SELECT context_json FROM screenshot_ocr_draft WHERE id = ?').get(row.id);
const storedContext = JSON.parse(storedRow.context_json);
storedContext.evidence = {
  derived: {
    source_hashes: [crypto.createHash('sha256').update(originalBytes).digest('hex')],
    source_sizes: [originalBytes.length],
  },
};
db.conn().prepare('UPDATE screenshot_ocr_draft SET context_json = ? WHERE id = ?')
  .run(JSON.stringify(storedContext), row.id);
const sourcePreview = resolveScreenshotDraftPreview(db.conn(), row.id);
assert.equal(sourcePreview.contentType, 'image/png');
assert.deepEqual(sourcePreview.bytes, originalBytes, '预览必须返回草稿第一张受控原图');
fs.writeFileSync(path.join(shotsDir, shot), Buffer.from('replaced-image'));
assert.throws(
  () => resolveScreenshotDraftPreview(db.conn(), row.id),
  /原图内容已变化/,
  '源图被替换后不得把新图当作原证据预览',
);
fs.writeFileSync(path.join(shotsDir, shot), originalBytes);

let refusal = null;
try {
  confirmScreenshotOcrDraft(row.id, { actor: 'HR' });
} catch (error) {
  refusal = error.message;
}
assert.ok(refusal, '未经人工核对的模型姓名必须被确认门禁拒绝');
assert.match(refusal, /外部 AI.*查看原图.*勾选/, '拒绝理由必须说明需查看原图并显式勾选');

const stillPending = listScreenshotOcrDrafts({ status: 'pending_review', jobId: ingest.job_id })
  .find((item) => item.id === row.id);
assert.ok(stillPending, '被拒绝的草稿必须仍留在待校对');
assert.equal(stillPending.reviewed_by, null, '被拒绝的草稿不得被标记为已复核');

editScreenshotOcrDraft(row.id, {
  changes: { name: '', facts: row.current.facts },
  actor: 'HR',
});
assert.throws(
  () => confirmScreenshotOcrDraft(row.id, { actor: 'HR', nameVerifiedByHr: true }),
  /候选人姓名为空/,
  '显式姓名确认不得绕过空姓名校验',
);
editScreenshotOcrDraft(row.id, {
  changes: { name: '人工纠正后的姓名', facts: row.current.facts },
  actor: 'HR',
});
assert.throws(
  () => confirmScreenshotOcrDraft(row.id, { actor: 'HR' }),
  /外部 AI.*勾选/,
  '修改外部 AI 姓名不得绕过显式原图核对',
);
const confirmed = confirmScreenshotOcrDraft(row.id, { actor: 'HR', nameVerifiedByHr: true });
assert.ok(confirmed, '人工查看原图、纠正姓名并显式确认后，Windows AI 姓名必须可以入库');
const confirmationAudit = listScreenshotOcrReviewAudit(row.id).find((entry) => entry.action === 'confirmed');
assert.equal(confirmationAudit.after.name_verification.method, 'explicit_hr_correction');
assert.equal(confirmationAudit.after.name_verification.verified_by, 'HR');
assert.equal(confirmationAudit.after.name_verification.original_ai_value, '模型读出的姓名');

console.log(JSON.stringify({
  ok: true,
  contract: 'AI-AUTHORED-DRAFT-GATE-001',
  ai_authored_draft_can_stage: true,
  ai_name_never_trusted: true,
  controlled_source_preview: true,
  replaced_source_preview_refused: true,
  one_click_confirm_refused: true,
  refusal_requires_explicit_image_verification: true,
  refused_draft_stays_pending_and_unreviewed: true,
  explicit_hr_name_verification_unlocks_confirmation: true,
  corrected_ai_name_still_requires_checkbox: true,
  empty_name_still_blocked: true,
  name_verification_is_audited: true,
  fill_path_name_rejection_unchanged: "tests/check-screenshot-ai-fill.js",
  network: 'not-used',
  data: 'synthetic-tmp-only',
}));
