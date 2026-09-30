'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-resume-candidate-intake-'));
const dataRoot = path.join(root, 'data');
process.env.BOSS_DB_PATH = path.join(root, 'resume-candidate.db');
process.env.HRBOSS_DATA_DIR = dataRoot;
process.env.HRBOSS_F018_ENABLED = '0';

const db = require("../src/db");
const { createResumeCandidateIntakeService, NEW_CANDIDATE_BINDING } = require("../src/resume-candidate-intake");
const { issueResumeFileSelection } = require("../src/resume-file-selection");
const { routeCapability } = require("../src/local-principal");

process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

async function run() {
  db.openDb(process.env.BOSS_DB_PATH);
  const job = db.upsertJob({ encrypt_job_id: 'local-resume-intake-job', name: '本地简历建档岗位', status: 'open' });
  const sourcePath = path.join(root, 'synthetic-scan.pdf');
  fs.writeFileSync(sourcePath, '%PDF-1.4\n% synthetic scanned resume fixture\n');
  const extractedText = [
    '姓名：合成建档候选人',
    '年龄：36岁',
    '学历：本科',
    '毕业院校：合成测试大学',
    '5年工作经验',
    '期望薪资：20-25K',
    '工作经历',
    '2021.01-2026.08 合成软件有限公司｜高级工程师',
    '负责 Electron、React 与本地 SQLite 工具交付。',
    '教育经历',
    '2008.09-2012.06 合成测试大学｜软件工程｜本科',
    '项目经历',
    '2023.01-2024.06 项目名称：本地工作台',
    '项目角色：技术负责人',
  ].join('\n');
  const secret = 'r'.repeat(64);
  const service = createResumeCandidateIntakeService({
    database: db.conn(),
    dataRoot,
    selectionSecret: secret,
    upsertCandidate: (input) => db.upsertCandidate(input),
    writeAuditLog: (entry) => db.writeAuditLog(entry),
    extractDocument: async () => ({
      text: extractedText,
      extraction_source: 'local_pdf_ocr',
      ocr: { engine: 'synthetic_local_ocr', page_count: 1, line_count: 6, average_confidence: 0.99 },
      ocr_error_code: null,
    }),
  });

  async function prepare(requestId) {
    const binding = {
      source_path: sourcePath,
      candidate_id: NEW_CANDIDATE_BINDING,
      job_id: job.id,
      request_id: requestId,
    };
    return service.prepare({
      selectionToken: issueResumeFileSelection(secret, binding),
      command: binding,
      actor: 'synthetic-hr',
    });
  }

  const draft = await prepare('resume-intake-1');
  assert.equal(draft.extraction_source, 'local_pdf_ocr');
  assert.equal(draft.fields.name, '合成建档候选人');
  assert.equal(draft.fields.age, '36岁');
  assert.equal(draft.fields.degree, '本科');
  assert.equal(draft.fields.school, '合成测试大学');
  assert.equal(db.listCandidates(job.id).length, 0, 'preview must not create a candidate');

  const committed = await service.commit({
    draft_id: draft.draft_id,
    job_id: job.id,
    name: draft.fields.name,
    age: draft.fields.age,
    degree: draft.fields.degree,
    school: draft.fields.school,
    work_years: draft.fields.work_years,
    salary: draft.fields.salary,
  });
  assert.equal(committed.inserted, true);
  assert.equal(committed.ai_ready, true);
  const candidate = db.getCandidate(committed.candidate_id);
  assert.equal(candidate.source, '本地简历');
  assert.equal(candidate.name, '合成建档候选人');
  assert.equal(candidate.age, '36岁');
  assert.equal(candidate.sabc, null, 'resume intake must not assign SABC');
  assert.equal(candidate.disposition_status, '新入库');
  assert.equal(candidate.comm_status, '未打招呼');
  const children = db.getCandidateChildren(committed.candidate_id);
  assert.equal(children.resume_attachment.length, 1);
  assert.equal(children.resume_attachment[0].file_name, 'synthetic-scan.pdf');
  assert.match(children.resume_attachment[0].download_status, /OCR/);
  assert.equal(children.resume_online.length, 1);
  const sections = JSON.parse(children.resume_online[0].sections_json);
  assert.equal(sections.resume_structure.schema_version, 'resume_structure_v1');
  assert.equal(sections.resume_structure.basic.age, '36岁');
  assert.equal(sections.work[0].company, '合成软件有限公司');
  assert.equal(sections.edu[0].school, '合成测试大学');
  assert.equal(sections.proj[0].name, '本地工作台');
  assert.match(sections.resume_structure.raw_sections.work, /本地 SQLite/);

  const duplicateDraft = await prepare('resume-intake-2');
  const duplicate = await service.commit({
    draft_id: duplicateDraft.draft_id,
    job_id: job.id,
    name: '不会覆盖原姓名',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.candidate_id, committed.candidate_id);
  assert.equal(duplicate.duplicate_corrections_applied, true);
  assert.deepEqual(duplicate.applied_correction_fields, ['name']);
  assert.deepEqual(duplicate.unapplied_correction_fields, []);
  assert.equal(db.listCandidates(job.id).length, 1);
  const correctedCandidate = db.getCandidate(committed.candidate_id);
  assert.equal(correctedCandidate.name, '不会覆盖原姓名');
  const correctedSections = JSON.parse(db.getCandidateChildren(committed.candidate_id).resume_online[0].sections_json);
  assert.equal(correctedSections.basic[0].name, '不会覆盖原姓名');
  assert.equal(correctedSections.resume_structure.basic.name, '不会覆盖原姓名');
  assert.equal(correctedCandidate.sabc, null);
  assert.equal(correctedCandidate.disposition_status, '新入库');
  assert.equal(correctedCandidate.comm_status, '未打招呼');
  assert.equal(db.conn().prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = '重复简历人工校对' AND target = ?").get(committed.candidate_id).n, 1);

  const unchangedDraft = await prepare('resume-intake-3');
  const unchangedDuplicate = await service.commit({
    draft_id: unchangedDraft.draft_id,
    job_id: job.id,
    ...unchangedDraft.fields,
  });
  assert.deepEqual(unchangedDuplicate.applied_correction_fields, []);
  assert.equal(db.getCandidate(committed.candidate_id).name, '不会覆盖原姓名', 'unchanged OCR defaults must not overwrite an existing HR correction');

  const unavailablePath = path.join(root, 'synthetic-text-pdf-missing-tools.pdf');
  fs.writeFileSync(unavailablePath, '%PDF-1.4\n% synthetic text PDF whose extraction tool is absent\n');
  const unavailableService = createResumeCandidateIntakeService({
    database: db.conn(), dataRoot, selectionSecret: secret,
    upsertCandidate: (input) => db.upsertCandidate(input),
    extractDocument: async () => ({ text: '', extraction_source: 'none', ocr: null, ocr_error_code: 'RESUME_PDF_TOOL_UNAVAILABLE' }),
  });
  const unavailableBinding = { source_path: unavailablePath, candidate_id: NEW_CANDIDATE_BINDING, job_id: job.id, request_id: 'missing-pdf-tools' };
  const countBeforePreview = db.listCandidates(job.id).length;
  const unavailableDraft = await unavailableService.prepare({ selectionToken: issueResumeFileSelection(secret, unavailableBinding), command: unavailableBinding, actor: 'synthetic-hr' });
  assert.equal(unavailableDraft.ocr_error_code, 'RESUME_PDF_TOOL_UNAVAILABLE');
  assert.equal(unavailableDraft.text_extracted, false);
  assert.equal(db.listCandidates(job.id).length, countBeforePreview, 'missing tools must not bypass HR confirmation');
  await assert.rejects(() => unavailableService.commit({ draft_id: unavailableDraft.draft_id, job_id: job.id, name: '' }), /姓名/);
  assert.equal(db.listCandidates(job.id).length, countBeforePreview, 'a missing name must still prevent creation');
  const manuallyConfirmed = await unavailableService.commit({ draft_id: unavailableDraft.draft_id, job_id: job.id, name: '人工确认合成人物' });
  assert.equal(manuallyConfirmed.ai_ready, false);
  assert.equal(manuallyConfirmed.ocr_error_code, 'RESUME_PDF_TOOL_UNAVAILABLE');
  const unavailableChildren = db.getCandidateChildren(manuallyConfirmed.candidate_id);
  assert.match(unavailableChildren.resume_attachment[0].download_status, /PDF正文待提取/);
  assert.doesNotMatch(unavailableChildren.resume_attachment[0].download_status, /扫描/);
  assert.equal(unavailableChildren.resume_online.length, 0, 'attachment-only import must not invent extracted evidence');
  assert.equal(db.getCandidate(manuallyConfirmed.candidate_id).sabc, null);
  assert.equal(db.getCandidate(manuallyConfirmed.candidate_id).comm_status, '未打招呼');

  assert.equal(routeCapability('POST', '/api/candidate/resume-intake/preview'), 'recruiting.write');
  assert.equal(routeCapability('POST', '/api/candidate/resume-intake/commit'), 'recruiting.write');
  const appSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/App.jsx'), 'utf8');
  const modalSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/ResumeCandidateImportModal.jsx'), 'utf8');
  const presentation = vm.runInNewContext(`${modalSource.slice(modalSource.indexOf('function extractionLabel('), modalSource.indexOf('export default function'))}\n({ extractionLabel, ocrFailureText })`);
  const dependencyText = presentation.ocrFailureText('RESUME_PDF_TOOL_UNAVAILABLE');
  assert.match(dependencyText, /Poppler/);
  assert.match(dependencyText, /重新选择/);
  assert.match(dependencyText, /人工确认姓名/);
  assert.doesNotMatch(dependencyText, /扫描/);
  assert.match(presentation.ocrFailureText('RESUME_OCR_UNAVAILABLE'), /本地 OCR/);
  assert.doesNotMatch(presentation.ocrFailureText('RESUME_OCR_UNAVAILABLE'), /Poppler|扫描/);
  assert.match(presentation.ocrFailureText('RESUME_OCR_TIMEOUT'), /PDF 正文提取超时/);
  assert.doesNotMatch(presentation.ocrFailureText('RESUME_OCR_TIMEOUT'), /Poppler|扫描/);
  assert.doesNotMatch(presentation.extractionLabel({ extraction_source: 'local_pdf_ocr' }).text, /扫描/, 'successful fallback OCR does not establish that a PDF was scanned');
  assert.match(modalSource, /message="PDF 正文提取未完成"/);
  const stylesSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/styles.css'), 'utf8');
  assert.match(appSource, /上传简历建档/);
  assert.match(modalSource, /确认简历建档/);
  assert.match(modalSource, /<Text>年龄<\/Text>/);
  assert.match(modalSource, /不会自动评级、改变状态、联系候选人或调用 AI/);
  assert.match(modalSource, /ref=\{nameInputRef\}/);
  assert.match(modalSource, /aria-invalid=\{Boolean\(error\)\}/);
  assert.match(modalSource, /aria-describedby=\{error \? NAME_ERROR_ID : undefined\}/);
  assert.match(modalSource, /id=\{NAME_ERROR_ID\} role="alert"/);
  assert.match(modalSource, /setError\('请确认候选人姓名后再建档。'\);[\s\S]*?focusNameInput\(\);/);
  assert.match(modalSource, /className="resume-intake-modal"/);
  assert.match(modalSource, /classNames=\{\{[\s\S]*?body: 'resume-intake-modal-body',[\s\S]*?content: 'resume-intake-modal-content',[\s\S]*?header: 'resume-intake-modal-header',[\s\S]*?footer: 'resume-intake-modal-footer'/);
  assert.match(modalSource, /<Descriptions[\s\S]*?classNames=\{\{[\s\S]*?label: 'resume-intake-meta-label',[\s\S]*?content: 'resume-intake-meta-content'/);
  assert.match(modalSource, /className="resume-intake-guidance resume-intake-alert"/);
  assert.match(modalSource, /className="resume-intake-warning resume-intake-alert"/);
  assert.match(modalSource, /afterOpenChange=[\s\S]*?keyboard[\s\S]*?focusTriggerAfterClose[\s\S]*?closable=\{!busy\}[\s\S]*?maskClosable=\{!busy\}/);
  assert.match(modalSource, /maxHeight: 'calc\(100dvh - 180px\)'/);
  assert.match(modalSource, /overflowY: 'auto'/);
  assert.match(stylesSource, /\.resume-intake-modal-body\s*\{[\s\S]*?overscroll-behavior: contain;[\s\S]*?scrollbar-gutter: stable;/);
  assert.doesNotMatch(stylesSource, /\.resume-intake[^,{\n]*\s+\.ant-(?:modal|descriptions|alert)/,
    'resume intake styling must use AntD 5 public semantic classNames or owned root classes');
  assert.match(stylesSource, /\.resume-intake-fields\s*\{[\s\S]*?grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(stylesSource, /@media \(max-width: 760px\)[\s\S]*?\.resume-intake-fields \{ grid-template-columns: 1fr; \}/);
  assert.match(stylesSource, /\.resume-intake-preview\s*\{[\s\S]*?max-height: 96px/);
  assert.match(appSource, /已打开原候选人并应用本次人工校对/);

  console.log(JSON.stringify({
    ok: true,
    contract: 'resume-candidate-intake-001',
    upload_creates_local_candidate: true,
    uploaded_resume_age_persisted: true,
    uploaded_resume_structured: true,
    scanned_pdf_ocr_ready: true,
    hr_confirmation_required: true,
    invalid_name_focus_recovery: true,
    invalid_name_accessible_error: true,
    public_antd_semantic_classes: true,
    escape_and_focus_restore_contract: true,
    low_height_modal_scroll: true,
    responsive_field_grid: true,
    compact_resume_preview: true,
    duplicate_same_job_idempotent: true,
    sabc_and_workflow_unchanged_by_ai: true,
    synthetic_only: true,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
