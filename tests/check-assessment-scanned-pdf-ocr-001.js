'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-assessment-scan-ocr-'));
const dataRoot = path.join(root, 'data');
process.env.BOSS_DB_PATH = path.join(root, 'assessment-scan.db');
process.env.HRBOSS_DATA_DIR = dataRoot;
process.env.HRBOSS_ASSESSMENT_PHASE_A_ENABLED = '1';
process.env.HRBOSS_F018_ENABLED = '0';

const db = require("../src/db");
const archive = require("../src/assessment-archive-service");
const { importAssessmentPdf } = require("../src/assessment-controlled-store");

process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

function minimalPdf(marker) {
  return Buffer.from(`%PDF-1.4\n% ${marker}\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n`, 'ascii');
}

function executable(directory, name, body) {
  const target = path.join(directory, name);
  fs.writeFileSync(target, `#!/usr/bin/env node\n${body}\n`, { mode: 0o700 });
  fs.chmodSync(target, 0o700);
  return target;
}

function parserRunner(executablePath, args, options) {
  const child = spawn(executablePath, args, {
    cwd: options.workingDirectory,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { child, kill: () => child.kill('SIGKILL'), finish: () => null };
}

function auditContext() {
  return {
    actor_id: 'local-primary-operator',
    actor_type: 'local_os_subject',
    actor_source: 'server_local_instance',
    actor_session_id: 'synthetic-scan-session',
    assurance: 'local_instance_only',
  };
}

async function run() {
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const tools = path.join(root, 'tools');
  fs.mkdirSync(tools, { mode: 0o700 });
  const pdfinfo = executable(tools, 'pdfinfo', `
    if (process.argv[2] === '-js') process.exit(0);
    process.stdout.write('Pages: 1\\nEncrypted: no\\nJavaScript: no\\nPDF version: 1.4\\n');
  `);
  const pdftotext = executable(tools, 'pdftotext', `process.stdout.write('');`);
  const pdftoppm = executable(tools, 'pdftoppm', `
    const fs = require('fs');
    const prefix = process.argv[process.argv.length - 1];
    fs.writeFileSync(prefix + '-1.png', Buffer.from([137,80,78,71,13,10,26,10,1]));
  `);
  db.openDb(process.env.BOSS_DB_PATH);

  const recognizedText = [
    '职业潜能测评报告',
    '姓名：合成测评对象 性别：未知',
    '岗位：合成测试工程师',
    '测评日期：2026-07-15',
    '信效度：高',
  ].join('\n');
  const source = path.join(root, 'synthetic-scanned-assessment.pdf');
  fs.writeFileSync(source, minimalPdf('scanned assessment recognized'));
  let intake;
  const stored = await importAssessmentPdf(source, {
    dataRoot,
    pdfinfoExecutablePath: pdfinfo,
    pdftotextExecutablePath: pdftotext,
    pdftoppmExecutablePath: pdftoppm,
    parserRunner,
    ocrRunner: async () => recognizedText,
    commitDocument: (record) => {
      intake = archive.recordAssessmentDocumentIntake({
        database: db.conn(),
        auditContext: auditContext(),
        command: { ...record, security_state: 'accepted', request_id: 'assessment-scan-ocr-ready' },
      });
    },
  });
  assert.equal(stored.analysis.source, 'supplier_pdf_local_ocr');
  assert.equal(stored.analysis.report_type, 'career_potential');
  assert.equal(stored.analysis.subject_name, '合成测评对象');
  const ready = db.conn().prepare('SELECT analysis_status, analysis_error_code, analysis_json FROM assessment_document WHERE id = ?').get(intake.document_id);
  assert.equal(ready.analysis_status, 'ready');
  assert.equal(ready.analysis_error_code, null);
  assert.equal(JSON.parse(ready.analysis_json).source, 'supplier_pdf_local_ocr');

  const unavailableSource = path.join(root, 'synthetic-scanned-assessment-no-ocr.pdf');
  fs.writeFileSync(unavailableSource, minimalPdf('scanned assessment ocr unavailable'));
  let unavailableIntake;
  const unavailable = await importAssessmentPdf(unavailableSource, {
    dataRoot,
    pdfinfoExecutablePath: pdfinfo,
    pdftotextExecutablePath: pdftotext,
    pdftoppmExecutablePath: pdftoppm,
    parserRunner,
    visionOcrExecutablePath: path.join(root, 'missing-swift'),
    tesseractExecutablePath: path.join(root, 'missing-tesseract'),
    commitDocument: (record) => {
      unavailableIntake = archive.recordAssessmentDocumentIntake({
        database: db.conn(),
        auditContext: auditContext(),
        command: { ...record, security_state: 'accepted', request_id: 'assessment-scan-ocr-unavailable' },
      });
    },
  });
  assert.equal(unavailable.analysis, undefined);
  assert.equal(unavailable.analysis_error_code, 'ASSESSMENT_REPORT_OCR_UNAVAILABLE');
  const failed = db.conn().prepare('SELECT analysis_status, analysis_error_code FROM assessment_document WHERE id = ?').get(unavailableIntake.document_id);
  assert.equal(failed.analysis_status, 'failed');
  assert.equal(failed.analysis_error_code, 'ASSESSMENT_REPORT_OCR_UNAVAILABLE');

  const panel = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/AssessmentArchivePanel.jsx'), 'utf8');
  assert.match(panel, /扫描 PDF · 本地 OCR/);
  assert.match(panel, /扫描型 PDF 已安全保存/);
  assert.match(panel, /listAssessmentAiAnalyses\(candidateId, jobId\)\.catch/);

  console.log(JSON.stringify({
    ok: true,
    contract: 'assessment-scanned-pdf-ocr-001',
    scanned_pdf_imported: true,
    local_ocr_analysis_ready: true,
    ocr_unavailable_remains_viewable: true,
    explicit_failure_state: true,
    synthetic_only: true,
  }));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
