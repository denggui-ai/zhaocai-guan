'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-manual-resume-'));
const dataRoot = path.join(root, 'data');
process.env.HRBOSS_DATA_DIR = dataRoot;
process.env.BOSS_DB_PATH = path.join(root, 'manual-resume.db');
process.env.HRBOSS_F018_ENABLED = '0';

const db = require("../src/db");
const { buildEvidenceProfile } = require("../src/candidate-report-v1");
const { importManualResumeAttachment, extractResumeDocumentText, extractText } = require("../src/manual-resume-import");
const {
  consumeResumeFileSelection,
  issueResumeFileSelection,
} = require("../src/resume-file-selection");
const { routeCapability } = require("../src/local-principal");

process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

async function checkPdfToolRecovery() {
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const tools = path.join(root, 'pdf-tools');
  fs.mkdirSync(tools, { mode: 0o700 });
  function executable(name, body) {
    const target = path.join(tools, name);
    fs.writeFileSync(target, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
    return target;
  }
  const sourcePath = path.join(dataRoot, 'synthetic-text-layer.pdf');
  fs.writeFileSync(sourcePath, '%PDF-1.4\n% synthetic text layer resume fixture\n%%EOF\n');
  const expectedText = '姓名：合成依赖候选人\n工作经历\nJava 后端开发与本地工具验收';
  const textTool = executable('pdftotext-readable', `process.stdout.write(${JSON.stringify(expectedText)});`);
  const emptyTool = executable('pdftotext-scanned', 'process.stdout.write("");');
  const pdfinfo = executable('pdfinfo', 'if (process.argv[2] !== "-js") process.stdout.write("Pages: 1\\nEncrypted: no\\nJavaScript: no\\nPDF version: 1.4\\n");');
  const pdftoppm = executable('pdftoppm', 'require("fs").writeFileSync(process.argv.at(-1) + "-1.png", Buffer.from([137,80,78,71,13,10,26,10,1]));');
  const unavailableTextTool = path.join(tools, 'pdftotext-not-executable');
  fs.writeFileSync(unavailableTextTool, 'synthetic unavailable executable', { mode: 0o600 });
  const missing = path.join(tools, 'missing');
  const parserRunner = (executablePath, args, options) => {
    const child = spawn(executablePath, args, { cwd: options.workingDirectory, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    return { child, kill: () => child.kill('SIGKILL'), finish: () => null };
  };
  const options = {
    controlledRoot: dataRoot,
    pdfinfoExecutablePath: pdfinfo,
    pdftoppmExecutablePath: pdftoppm,
    parserRunner,
    visionOcrExecutablePath: missing,
    tesseractExecutablePath: missing,
  };
  const direct = await extractResumeDocumentText(sourcePath, '.pdf', {
    ...options, pdftotextExecutablePath: textTool, pdfinfoExecutablePath: missing,
    ocrRunner: () => { assert.fail('readable text PDFs must not require OCR or preview tools'); },
  });
  assert.equal(direct.text, expectedText);
  assert.equal(direct.extraction_source, 'embedded_pdf_text');
  assert.equal(direct.ocr_error_code, null);
  assert.equal(extractText(sourcePath, '.pdf', { pdftotextExecutablePath: textTool }), expectedText, 'the public string extractor remains compatible');

  const noTextTool = await extractResumeDocumentText(sourcePath, '.pdf', { ...options, pdftotextExecutablePath: unavailableTextTool });
  assert.equal(noTextTool.ocr_error_code, 'RESUME_PDF_TOOL_UNAVAILABLE', 'an unavailable PDF text tool must not be misreported as an absent OCR engine');
  assert.equal(noTextTool.text, '');
  assert.equal(noTextTool.extraction_source, 'none');

  // Simulate a clean host with no installed pdftotext, without moving any real tool.
  const sourcePathForVm = path.join(PROJECT_ROOT, 'src/manual-resume-import.js');
  const source = fs.readFileSync(sourcePathForVm, 'utf8');
  const sourceRequire = require('node:module').createRequire(sourcePathForVm);
  const context = vm.createContext({ PROJECT_ROOT,
    process, Buffer, __dirname: path.dirname(sourcePathForVm), module: { exports: {} },
    require: (name) => name === 'fs' ? {
      ...fs, existsSync: (file) => /[\\/]pdftotext$/.test(String(file)) ? false : fs.existsSync(file),
    } : sourceRequire(name),
  });
  vm.runInContext(source, context);
  const absentTextTool = await context.module.exports.extractResumeDocumentText(sourcePath, '.pdf', options);
  assert.equal(absentTextTool.ocr_error_code, 'RESUME_PDF_TOOL_UNAVAILABLE', 'a clean host must disclose the missing Poppler dependency');

  // Node terminates a timed-out child with a signal, too. Preserve that reason
  // instead of telling HR to install a tool that did run successfully.
  const timeoutContext = vm.createContext({ PROJECT_ROOT,
    process, Buffer, __dirname: path.dirname(sourcePathForVm), module: { exports: {} },
    require: (name) => name === 'child_process' ? {
      spawnSync: () => ({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: '' }),
    } : sourceRequire(name),
  });
  vm.runInContext(source, timeoutContext);
  for (const timeoutOptions of [{}, options]) {
    const result = await timeoutContext.module.exports.extractResumeDocumentText(sourcePath, '.pdf', {
      ...timeoutOptions, pdftotextExecutablePath: textTool,
    });
    assert.equal(result.ocr_error_code, 'RESUME_OCR_TIMEOUT', 'a PDF text timeout must not be reported as missing Poppler');
  }
  const timeoutRecovered = await timeoutContext.module.exports.extractResumeDocumentText(sourcePath, '.pdf', {
    ...options, pdftotextExecutablePath: textTool, ocrRunner: async () => expectedText,
  });
  assert.equal(timeoutRecovered.extraction_source, 'local_pdf_ocr', 'OCR may recover a timed-out PDF text extraction');
  assert.equal(timeoutRecovered.ocr_error_code, null);

  for (const missingField of ['pdfinfoExecutablePath', 'pdftoppmExecutablePath']) {
    const result = await extractResumeDocumentText(sourcePath, '.pdf', { ...options, pdftotextExecutablePath: emptyTool, [missingField]: missing });
    assert.equal(result.ocr_error_code, 'RESUME_PDF_TOOL_UNAVAILABLE', `${missingField} must identify a PDF tool dependency`);
  }
  const scannedNoOcr = await extractResumeDocumentText(sourcePath, '.pdf', { ...options, pdftotextExecutablePath: emptyTool });
  assert.equal(scannedNoOcr.ocr_error_code, 'RESUME_OCR_UNAVAILABLE', 'usable Poppler plus missing OCR must retain the OCR-specific recovery');
  const scanned = await extractResumeDocumentText(sourcePath, '.pdf', { ...options, pdftotextExecutablePath: emptyTool, ocrRunner: async () => expectedText });
  assert.equal(scanned.extraction_source, 'local_pdf_ocr');
  assert.equal(scanned.text, expectedText);
  assert.equal(scanned.ocr_error_code, null);
  const ocrFallback = await extractResumeDocumentText(sourcePath, '.pdf', { ...options, pdftotextExecutablePath: unavailableTextTool, ocrRunner: async () => expectedText });
  assert.equal(ocrFallback.extraction_source, 'local_pdf_ocr', 'working local OCR must remain a fallback when the text tool is unavailable');
  assert.equal(ocrFallback.ocr_error_code, null);
  const emptyOcr = await extractResumeDocumentText(sourcePath, '.pdf', { ...options, pdftotextExecutablePath: emptyTool, ocrRunner: async () => '' });
  assert.equal(emptyOcr.ocr_error_code, 'RESUME_OCR_EMPTY');
  const timeout = await extractResumeDocumentText(sourcePath, '.pdf', { ...options, pdftotextExecutablePath: emptyTool, ocrRunner: async () => { throw Object.assign(new Error('synthetic timeout'), { code: 'LOCAL_OCR_TIMEOUT' }); } });
  assert.equal(timeout.ocr_error_code, 'RESUME_OCR_TIMEOUT');
  const recovered = await extractResumeDocumentText(sourcePath, '.pdf', { ...options, pdftotextExecutablePath: textTool });
  assert.equal(recovered.extraction_source, 'embedded_pdf_text');
  assert.equal(recovered.ocr_error_code, null, 'retry with restored tools must not preserve a stale failure');
}

async function run() {
db.openDb(process.env.BOSS_DB_PATH);
await checkPdfToolRecovery();
const job = db.upsertJob({ encrypt_job_id: 'manual-resume-job', name: '手动简历合成岗位', status: 'open' });
const candidate = db.upsertCandidate({
  job_id: job.id,
  geek_id: 'manual-resume-candidate',
  source: 'local_manual_test',
  name: '合成候选人',
  sabc: 'A',
  sabc_source: '人工',
  disposition_status: '新入库',
});
const sourcePath = path.join(root, 'synthetic-resume.txt');
fs.writeFileSync(sourcePath, [
  '姓名：合成候选人',
  '年龄：32岁',
  '学历：本科',
  '工作年限：8年',
  '',
  '工作经历',
  '2020.01-2026.08 合成工具有限公司｜高级工程师',
  '负责 Electron、Node.js、React 和本地 SQLite 工具交付。',
  '',
  '教育经历',
  '2010.09-2014.06 合成本地大学｜计算机科学｜本科',
  '',
  '项目经历',
  '2022.03-2023.12 项目名称：合成验收平台',
  '项目角色：技术负责人',
  '定义验收标准，完成自动化测试和问题回归。',
].join('\n'));

const secret = 's'.repeat(64);
const binding = {
  source_path: sourcePath,
  candidate_id: candidate.internal_id,
  job_id: job.id,
  request_id: 'manual-resume-check-1',
};
const selectionToken = issueResumeFileSelection(secret, binding);
const consumed = new Set();
const selection = consumeResumeFileSelection(secret, selectionToken, binding, consumed);
assert.equal(selection.source_path, sourcePath);
assert.throws(
  () => consumeResumeFileSelection(secret, selectionToken, binding, consumed),
  (error) => error && error.code === 'RESUME_SELECTION_REPLAYED',
  'native file selection must be single-use',
);

const before = db.conn().prepare('SELECT sabc, sabc_source, disposition_status FROM candidate WHERE internal_id = ?').get(candidate.internal_id);
const imported = await importManualResumeAttachment({
  database: db.conn(),
  dataRoot,
  sourcePath: selection.source_path,
  candidateId: selection.candidate_id,
  jobId: selection.job_id,
  actor: 'synthetic-hr',
});
assert.equal(imported.text_extracted, true);
assert.equal(imported.ai_ready, true);
assert.equal(imported.attachment.file_type, 'txt');
assert.match(imported.attachment.download_status, /正文已提取/);
const children = db.getCandidateChildren(candidate.internal_id);
assert.equal(children.resume_attachment.length, 1);
assert.ok(fs.existsSync(children.resume_attachment[0].local_path));
if (process.platform !== 'win32') assert.equal(fs.statSync(children.resume_attachment[0].local_path).mode & 0o077, 0);
assert.equal(children.resume_online.length, 1);
const sections = JSON.parse(children.resume_online[0].sections_json);
assert.equal(sections.manual_attachment.file_name, 'synthetic-resume.txt');
assert.ok(sections.work.some((item) => item.source === 'manual_attachment'));
assert.equal(sections.work[0].company, '合成工具有限公司');
assert.equal(sections.edu[0].school, '合成本地大学');
assert.equal(sections.proj[0].name, '合成验收平台');
assert.equal(sections.resume_structure.schema_version, 'resume_structure_v1');
assert.equal(sections.resume_structure.basic.age, '32岁');
assert.match(sections.resume_structure.raw_sections.project, /自动化测试/);
assert.ok(buildEvidenceProfile(sections).evidence_items.some((item) => item.section === 'work'));
assert.equal(db.getAssessStatus(candidate.internal_id).has_resume, true, 'manual upload text must drive the existing candidate AI input');
assert.deepEqual(
  db.conn().prepare('SELECT sabc, sabc_source, disposition_status FROM candidate WHERE internal_id = ?').get(candidate.internal_id),
  before,
  'manual resume upload must not change SABC or HR disposition',
);

const duplicate = await importManualResumeAttachment({
  database: db.conn(),
  dataRoot,
  sourcePath,
  candidateId: candidate.internal_id,
  jobId: job.id,
  actor: 'synthetic-hr',
});
assert.equal(duplicate.idempotency_key, imported.idempotency_key);
assert.equal(db.getCandidateChildren(candidate.internal_id).resume_attachment.length, 1, 'same candidate and file must be idempotent');

const otherJob = db.upsertJob({ encrypt_job_id: 'manual-resume-other-job', name: '其他岗位', status: 'open' });
await assert.rejects(() => importManualResumeAttachment({
  database: db.conn(), dataRoot, sourcePath, candidateId: candidate.internal_id, jobId: otherJob.id,
}), (error) => error && error.code === 'RESUME_CANDIDATE_JOB_MISMATCH');
db.updateJobStatus({ jobId: job.id, status: 'closed', closeReason: 'other', actor: 'synthetic-hr' });
await assert.rejects(() => importManualResumeAttachment({
  database: db.conn(), dataRoot, sourcePath, candidateId: candidate.internal_id, jobId: job.id,
}), (error) => error && error.code === 'JOB_CLOSED');

assert.equal(routeCapability('POST', '/api/candidate/resume-attachment/import'), 'recruiting.write');
const mainSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/candidate-main.js"), 'utf8');
const preloadSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/preload.js"), 'utf8');
const apiSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/api.js'), 'utf8');
const detailSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/CandidateDetail.jsx'), 'utf8');
assert.match(mainSource, /resume-attachment:select-and-import/);
assert.match(mainSource, /extensions: \['pdf', 'doc', 'docx', 'rtf', 'txt'\]/);
assert.match(preloadSource, /resumeAttachment[\s\S]*selectAndImport/);
assert.match(apiSource, /importResumeAttachment/);
assert.match(detailSource, /手动上传简历/);
assert.match(detailSource, /不会改变评级、状态或人工处置/);

console.log(JSON.stringify({
  ok: true,
  contract: 'manual-resume-upload-001',
  native_file_picker: true,
  supported: ['pdf', 'doc', 'docx', 'rtf', 'txt'],
  controlled_local_copy: true,
  candidate_job_bound: true,
  ai_input_ready: true,
  unified_resume_structure: true,
  raw_section_evidence_retained: true,
  sabc_and_disposition_unchanged: true,
  synthetic_only: true,
  pdf_dependency_failure_is_distinct_from_ocr_failure: true,
  text_pdf_and_scanned_pdf_recovery: true,
}));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
