'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ensurePrivateDir, writePrivateFile } = require('./secure-fs');
const { scanAssessmentPdf } = require('./assessment-pdf-probe');
const { renderAssessmentRasterPreview } = require('./assessment-raster-preview');
const { recognizeImageFiles } = require('./local-document-ocr');
const { RESUME_STRUCTURE_SCHEMA_VERSION, parseResumeStructure } = require('./resume-structure');

const MAX_RESUME_BYTES = 25 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 60_000;
const ALLOWED_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.rtf', '.txt']);

class ManualResumeImportError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'ManualResumeImportError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fail(code, message, statusCode) {
  throw new ManualResumeImportError(code, message, statusCode);
}

function resolveExecutable(configured, candidates) {
  const explicit = String(configured || '').trim();
  if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);
  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function pdfTextExecutable(configured) {
  return resolveExecutable(configured, process.platform === 'win32'
    ? []
    : ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', '/usr/bin/pdftotext']);
}

function normalizedExtractedText(value) {
  return String(value || '')
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
    .slice(0, MAX_EXTRACTED_CHARS);
}

function extractPdfText(sourcePath, options = {}) {
  const executable = pdfTextExecutable(options.pdftotextExecutablePath);
  if (!executable) return { text: '', failureCode: 'RESUME_PDF_TOOL_UNAVAILABLE' };
  const result = spawnSync(executable, ['-layout', sourcePath, '-'], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
  });
  const failureCode = result.error?.code === 'ETIMEDOUT'
    ? 'RESUME_OCR_TIMEOUT'
    : ['ENOENT', 'EACCES', 'ENOEXEC'].includes(result.error?.code) || result.signal
      ? 'RESUME_PDF_TOOL_UNAVAILABLE'
      : null;
  return {
    text: result.status === 0 ? normalizedExtractedText(result.stdout) : '',
    failureCode,
  };
}

function extractText(sourcePath, extension, options = {}) {
  if (extension === '.txt') return normalizedExtractedText(fs.readFileSync(sourcePath, 'utf8'));
  if (extension === '.pdf') return extractPdfText(sourcePath, options).text;
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/bin/textutil', ['-convert', 'txt', '-stdout', sourcePath], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    });
    return result.status === 0 ? normalizedExtractedText(result.stdout) : '';
  }
  return '';
}

function resumeOcrErrorCode(error) {
  const code = String(error && error.code || '');
  if (code === 'LOCAL_OCR_UNAVAILABLE') return 'RESUME_OCR_UNAVAILABLE';
  if (/TOOL_UNAVAILABLE/.test(code)) return 'RESUME_PDF_TOOL_UNAVAILABLE';
  if (code === 'LOCAL_OCR_TEXT_EMPTY') return 'RESUME_OCR_EMPTY';
  if (code === 'LOCAL_OCR_PAGE_LIMIT') return 'RESUME_OCR_PAGE_LIMIT';
  if (code === 'LOCAL_OCR_TIMEOUT' || /TIMEOUT/.test(code)) return 'RESUME_OCR_TIMEOUT';
  return 'RESUME_OCR_FAILED';
}

async function extractResumeDocumentText(sourcePath, extension, options = {}) {
  const pdfExtraction = extension === '.pdf' ? extractPdfText(sourcePath, options) : null;
  const directText = pdfExtraction ? pdfExtraction.text : extractText(sourcePath, extension, options);
  if (directText) {
    return Object.freeze({
      text: directText,
      extraction_source: extension === '.pdf' ? 'embedded_pdf_text' : 'document_text',
      ocr: null,
      ocr_error_code: null,
    });
  }
  if (extension !== '.pdf') {
    return Object.freeze({ text: '', extraction_source: 'none', ocr: null, ocr_error_code: null });
  }
  const controlledRoot = path.resolve(String(options.controlledRoot || options.dataRoot || ''));
  if (!options.controlledRoot && !options.dataRoot) {
    return Object.freeze({ text: '', extraction_source: 'none', ocr: null, ocr_error_code: pdfExtraction.failureCode || 'RESUME_OCR_UNAVAILABLE' });
  }
  const outputRoot = ensurePrivateDir(path.resolve(String(options.ocrWorkRoot || path.join(controlledRoot, 'resume-ocr-work'))));
  let previewDirectory = '';
  try {
    const scan = await scanAssessmentPdf(sourcePath, {
      stagingRoot: path.dirname(sourcePath),
      pdfinfoExecutablePath: options.pdfinfoExecutablePath,
      timeoutMs: options.scanTimeoutMs,
      parserRunner: options.parserRunner,
    });
    const preview = await renderAssessmentRasterPreview(sourcePath, {
      controlledRoot,
      outputRoot,
      pdftoppmExecutablePath: options.pdftoppmExecutablePath,
      pageCount: scan.pages,
      timeoutMs: options.renderTimeoutMs,
      parserRunner: options.parserRunner,
    });
    previewDirectory = preview.work_dir;
    const ocr = await recognizeImageFiles(
      preview.page_files.map((name) => path.join(preview.work_dir, name)),
      {
        controlledRoot: preview.work_dir,
        visionOcrExecutablePath: options.visionOcrExecutablePath,
        visionOcrScriptPath: options.visionOcrScriptPath,
        tesseractExecutablePath: options.tesseractExecutablePath,
        ocrRunner: options.ocrRunner,
        maxPages: options.ocrMaxPages,
        timeoutMs: options.ocrTimeoutMs,
      },
    );
    return Object.freeze({
      text: normalizedExtractedText(ocr.text),
      extraction_source: 'local_pdf_ocr',
      ocr: {
        engine: ocr.engine,
        page_count: ocr.page_count,
        line_count: ocr.line_count,
        average_confidence: ocr.average_confidence,
      },
      ocr_error_code: null,
    });
  } catch (error) {
    const ocrErrorCode = resumeOcrErrorCode(error);
    return Object.freeze({
      text: '',
      extraction_source: 'none',
      ocr: null,
      ocr_error_code: pdfExtraction.failureCode && ocrErrorCode === 'RESUME_OCR_UNAVAILABLE'
        ? pdfExtraction.failureCode
        : ocrErrorCode,
    });
  } finally {
    if (previewDirectory) {
      try { fs.rmSync(previewDirectory, { recursive: true, force: true }); } catch {}
    }
  }
}

function resumeSections(text, fileName, existingValue, structuredValue = null) {
  let existing = {};
  try {
    const parsed = typeof existingValue === 'string' ? JSON.parse(existingValue) : existingValue;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed;
  } catch {}
  const structure = structuredValue && structuredValue.schema_version === RESUME_STRUCTURE_SCHEMA_VERSION
    ? structuredValue
    : parseResumeStructure(text, { source: 'manual_attachment', file_name: fileName });
  const manualWork = structure.work.map((item) => ({ ...item, source: 'manual_attachment' }));
  const manualEducation = structure.education.map((item) => ({ ...item, source: 'manual_attachment' }));
  const manualProject = structure.project.map((item) => ({ ...item, source: 'manual_attachment' }));
  const oldWork = Array.isArray(existing.work)
    ? existing.work.filter((item) => !item || item.source !== 'manual_attachment')
    : [];
  const oldEducation = Array.isArray(existing.edu)
    ? existing.edu.filter((item) => !item || item.source !== 'manual_attachment')
    : [];
  const oldProject = Array.isArray(existing.proj)
    ? existing.proj.filter((item) => !item || item.source !== 'manual_attachment')
    : [];
  const oldBasic = Array.isArray(existing.basic) && existing.basic[0] && typeof existing.basic[0] === 'object'
    ? existing.basic[0]
    : {};
  // Re-importing the same locally uploaded resume must apply this round's HR
  // corrections.  Basic data from another source remains authoritative, but a
  // stale manual projection must not overwrite the corrected unified shape.
  const retainedBasic = oldBasic.source === 'manual_attachment' ? {} : oldBasic;
  return {
    ...existing,
    basic: [{ ...structure.basic, ...retainedBasic, description: text.slice(0, 3000), source: 'manual_attachment' }],
    work: [...manualWork, ...oldWork],
    proj: [...manualProject, ...oldProject],
    edu: [...manualEducation, ...oldEducation],
    expect: Array.isArray(existing.expect) ? existing.expect : [],
    skill: Array.isArray(existing.skill) ? existing.skill : [],
    resume_structure: structure,
    manual_attachment: {
      file_name: fileName,
      imported_at: new Date().toISOString(),
      structure_schema_version: structure.schema_version,
    },
  };
}

function assertResumeFile(sourcePath) {
  const input = String(sourcePath || '');
  if (!path.isAbsolute(input) || input.includes('\0')) fail('RESUME_FILE_NOT_FOUND', '选择的简历文件不存在。');
  const resolved = path.resolve(input);
  if (!fs.existsSync(resolved)) fail('RESUME_FILE_NOT_FOUND', '选择的简历文件不存在。');
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile()) fail('RESUME_FILE_INVALID', '请选择本机普通简历文件。');
  if (stat.size <= 0 || stat.size > MAX_RESUME_BYTES) fail('RESUME_FILE_SIZE_INVALID', '简历文件必须大于 0 且不超过 25MB。');
  const extension = path.extname(resolved).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) fail('RESUME_FILE_TYPE_INVALID', '仅支持 PDF、Word、RTF 或 TXT 简历。');
  const prefix = Buffer.alloc(8);
  const descriptor = fs.openSync(resolved, 'r');
  try { fs.readSync(descriptor, prefix, 0, prefix.length, 0); } finally { fs.closeSync(descriptor); }
  if (extension === '.pdf' && prefix.subarray(0, 5).toString('ascii') !== '%PDF-') {
    fail('RESUME_FILE_TYPE_INVALID', '所选 PDF 文件格式无效。');
  }
  if (extension === '.docx' && prefix.subarray(0, 2).toString('ascii') !== 'PK') {
    fail('RESUME_FILE_TYPE_INVALID', '所选 Word 文件格式无效。');
  }
  return { resolved, stat, extension };
}

async function importManualResumeAttachment(options = {}) {
  const database = options.database;
  if (!database || typeof database.prepare !== 'function') fail('RESUME_DATABASE_REQUIRED', '本地候选人数据库不可用。', 500);
  const dataRoot = path.resolve(String(options.dataRoot || ''));
  if (!options.dataRoot || !path.isAbsolute(String(options.dataRoot))) fail('RESUME_DATA_ROOT_INVALID', '本地简历存储目录不可用。', 500);
  const candidateId = String(options.candidateId || '').trim();
  const jobId = Number(options.jobId);
  if (!candidateId || !Number.isInteger(jobId) || jobId <= 0) fail('RESUME_BINDING_REQUIRED', '必须选择当前岗位候选人。');
  const candidate = database.prepare(`
    SELECT candidate.internal_id, candidate.job_id, candidate.sabc, candidate.disposition_status,
           job.status AS job_status
    FROM candidate JOIN job ON job.id = candidate.job_id
    WHERE candidate.internal_id = ?
  `).get(candidateId);
  if (!candidate || Number(candidate.job_id) !== jobId) fail('RESUME_CANDIDATE_JOB_MISMATCH', '简历与当前候选人岗位不一致。', 409);
  if (candidate.job_status === 'closed') fail('JOB_CLOSED', '岗位已关闭，请重新开启后再上传简历。', 409);

  const { resolved, stat, extension } = assertResumeFile(options.sourcePath);
  const bytes = fs.readFileSync(resolved);
  const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
  const candidateDir = ensurePrivateDir(path.join(dataRoot, 'resume-attachments', candidateId.replace(/[^A-Za-z0-9_.-]/g, '_')));
  const storedPath = path.join(candidateDir, `${contentHash}${extension}`);
  if (!fs.existsSync(storedPath)) writePrivateFile(storedPath, bytes);
  const extraction = options.preExtractedText !== undefined
    ? Object.freeze({
      text: normalizedExtractedText(options.preExtractedText),
      extraction_source: String(options.preExtractionSource || 'prepared_local_intake'),
      ocr: options.preOcr || null,
      ocr_error_code: options.preOcrErrorCode || null,
    })
    : await extractResumeDocumentText(storedPath, extension, {
      ...options,
      dataRoot,
      controlledRoot: dataRoot,
    });
  const extractedText = extraction.text;
  const requestedFileName = String(options.originalFileName || '').trim();
  const fileName = requestedFileName && path.basename(requestedFileName) === requestedFileName
    ? requestedFileName.slice(0, 255)
    : path.basename(resolved);
  const timestamp = new Date().toISOString();
  const resumeId = `manual:${contentHash}`;
  const hasContact = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?<!\d)1[3-9]\d{9}(?!\d)/i.test(extractedText) ? 1 : 0;

  const result = database.transaction(() => {
    database.prepare(`
      INSERT INTO resume_attachment (
        candidate_id, resume_id, file_name, file_type, local_path, download_status,
        is_paywalled, has_contact, source_mid, created_at, downloaded_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'manual_local_upload', ?, ?)
      ON CONFLICT(candidate_id, resume_id) DO UPDATE SET
        file_name = excluded.file_name,
        file_type = excluded.file_type,
        local_path = excluded.local_path,
        download_status = excluded.download_status,
        has_contact = excluded.has_contact,
        downloaded_at = excluded.downloaded_at
    `).run(
      candidateId, resumeId, fileName, extension.slice(1), storedPath,
      extractedText
        ? extraction.extraction_source === 'local_pdf_ocr' ? '本地上传 · PDF已OCR' : '本地上传 · 正文已提取'
        : extension === '.pdf' && extraction.ocr_error_code ? '本地上传 · PDF正文待提取' : '本地上传 · 仅附件存档',
      hasContact, timestamp, timestamp,
    );
    if (extractedText) {
      const current = database.prepare('SELECT sections_json, raw_json FROM resume_online WHERE candidate_id = ?').get(candidateId);
      const sections = resumeSections(
        extractedText,
        fileName,
        current && current.sections_json,
        options.preStructuredResume,
      );
      database.prepare(`
        INSERT INTO resume_online (candidate_id, sections_json, is_paywalled, raw_json, fetched_at)
        VALUES (?, ?, 0, ?, ?)
        ON CONFLICT(candidate_id) DO UPDATE SET
          sections_json = excluded.sections_json,
          is_paywalled = 0,
          raw_json = COALESCE(resume_online.raw_json, excluded.raw_json),
          fetched_at = excluded.fetched_at
      `).run(candidateId, JSON.stringify(sections), (current && current.raw_json) || JSON.stringify({ source: 'manual_local_upload' }), timestamp);
    }
    database.prepare(`
      INSERT INTO audit_log (action, target, who, auto, result, detail_json, created_at)
      VALUES ('手动上传简历', ?, ?, 0, '成功', ?, ?)
    `).run(candidateId, String(options.actor || 'local-primary-operator'), JSON.stringify({
      job_id: jobId,
      file_name: fileName,
      file_type: extension.slice(1),
      byte_size: stat.size,
      content_sha256: contentHash,
      text_extracted: Boolean(extractedText),
      extraction_source: extraction.extraction_source,
      ocr_error_code: extraction.ocr_error_code,
    }), timestamp);
    return database.prepare(`
      SELECT id, candidate_id, resume_id, file_name, file_type, download_status,
             is_paywalled, has_contact, created_at, downloaded_at
      FROM resume_attachment WHERE candidate_id = ? AND resume_id = ?
    `).get(candidateId, resumeId);
  })();

  return {
    attachment: result,
    candidate_id: candidateId,
    job_id: jobId,
    text_extracted: Boolean(extractedText),
    ai_ready: Boolean(extractedText),
    extraction_source: extraction.extraction_source,
    ocr: extraction.ocr,
    ocr_error_code: extraction.ocr_error_code,
    idempotency_key: resumeId,
  };
}

module.exports = {
  ALLOWED_EXTENSIONS,
  MAX_RESUME_BYTES,
  ManualResumeImportError,
  assertResumeFile,
  extractText,
  extractResumeDocumentText,
  importManualResumeAttachment,
  resumeSections,
};
