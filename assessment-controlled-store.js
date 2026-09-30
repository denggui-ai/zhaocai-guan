'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DEFAULT_MAX_BYTES, stageAssessmentPdf } = require('./assessment-file-intake');
const { scanAssessmentPdf } = require('./assessment-pdf-probe');
const { analyzeAssessmentReportPdf, analyzeAssessmentReportText } = require('./assessment-report-analysis');
const { DEFAULT_MAX_OUTPUT_BYTES, renderAssessmentRasterPreview } = require('./assessment-raster-preview');
const { recognizeImageFiles } = require('./local-document-ocr');
const { ensurePrivateDir, ensurePrivateFile, hardenPrivateDir, writePrivateFile } = require('./secure-fs');

const DEFAULT_STORE_QUOTA_BYTES = 512 * 1024 * 1024;
const MAX_STORE_QUOTA_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const MIN_ORPHAN_GRACE_MS = 60 * 60 * 1000;
const DEFAULT_IMPORT_TIMEOUT_MS = 60 * 1000;
const WINDOWS_REPARSE_RELEASE_GATE = 'external_windows_validation_required';

let importInProgress = false;

class AssessmentControlledStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AssessmentControlledStoreError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AssessmentControlledStoreError(code, message);
}

function requireAbsolute(value, code) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    fail(code, 'Assessment 私有数据目录无效。');
  }
  return path.resolve(value);
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeDirectory(input, code) {
  const resolved = requireAbsolute(input, code);
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('invalid directory');
    return fs.realpathSync(resolved);
  } catch {
    fail(code, 'Assessment 私有数据目录无效。');
  }
}

function ensureChildDirectory(parent, name) {
  const target = path.join(parent, name);
  try {
    let stat;
    try { stat = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error('invalid child');
    ensurePrivateDir(target);
    hardenPrivateDir(target);
    const real = fs.realpathSync(target);
    if (!within(parent, real)) throw new Error('outside parent');
    return real;
  } catch {
    fail('ASSESSMENT_STORE_ROOT_INVALID', 'Assessment 受控存储目录无效。');
  }
}

function prepareStore(dataRootInput) {
  const dataRoot = safeDirectory(dataRootInput, 'ASSESSMENT_DATA_ROOT_INVALID');
  const assessmentRoot = ensureChildDirectory(dataRoot, 'assessment');
  const stagingRoot = ensureChildDirectory(assessmentRoot, 'staging');
  const previewWorkRoot = ensureChildDirectory(assessmentRoot, 'preview-work');
  const acceptedRoot = ensureChildDirectory(assessmentRoot, 'accepted');
  const previewsRoot = ensureChildDirectory(assessmentRoot, 'previews');
  const orphanRoot = ensureChildDirectory(assessmentRoot, 'orphans');
  const acceptedShaRoot = ensureChildDirectory(acceptedRoot, 'sha256');
  const previewShaRoot = ensureChildDirectory(previewsRoot, 'sha256');
  return {
    dataRoot,
    assessmentRoot,
    stagingRoot,
    previewWorkRoot,
    acceptedRoot,
    previewsRoot,
    orphanRoot,
    acceptedShaRoot,
    previewShaRoot,
  };
}

function normalizeQuota(value) {
  if (value === undefined) return DEFAULT_STORE_QUOTA_BYTES;
  if (!Number.isSafeInteger(value) || value < DEFAULT_MAX_BYTES || value > MAX_STORE_QUOTA_BYTES) {
    fail('ASSESSMENT_STORE_QUOTA_INVALID', 'Assessment 受控存储配额无效。');
  }
  return value;
}

function normalizeImportTimeout(value) {
  if (value === undefined) return DEFAULT_IMPORT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 10 || value > DEFAULT_IMPORT_TIMEOUT_MS) {
    fail('ASSESSMENT_STORE_TIMEOUT_INVALID', 'Assessment 导入超时限制无效。');
  }
  return value;
}

function remainingTimeout(deadline, requested) {
  const remaining = deadline - Date.now();
  if (remaining < 10) fail('ASSESSMENT_STORE_TIMEOUT', 'Assessment 文件导入执行超时。');
  if (requested === undefined) return remaining;
  if (!Number.isSafeInteger(requested) || requested < 10 || requested > DEFAULT_IMPORT_TIMEOUT_MS) {
    fail('ASSESSMENT_STORE_TIMEOUT_INVALID', 'Assessment 导入超时限制无效。');
  }
  return Math.min(remaining, requested);
}

function directoryBytes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment 受控存储包含不安全对象。');
      if (stat.isDirectory()) stack.push(target);
      else if (stat.isFile()) total += stat.size;
      else fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment 受控存储包含不安全对象。');
    }
  }
  return total;
}

function assertQuota(paths, quotaBytes) {
  if (directoryBytes(paths.assessmentRoot) > quotaBytes) {
    fail('ASSESSMENT_STORE_QUOTA_EXCEEDED', 'Assessment 受控存储配额不足。');
  }
}

function hashFile(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function canonicalPaths(paths, hash) {
  const acceptedShard = ensureChildDirectory(paths.acceptedShaRoot, hash.slice(0, 2));
  const previewShard = ensureChildDirectory(paths.previewShaRoot, hash.slice(0, 2));
  return {
    blob: path.join(acceptedShard, `${hash}.pdf`),
    preview: path.join(previewShard, hash),
    marker: path.join(paths.orphanRoot, `${hash}.json`),
    storageRelpath: path.relative(paths.assessmentRoot, path.join(acceptedShard, `${hash}.pdf`)),
    previewRelpath: path.relative(paths.assessmentRoot, path.join(previewShard, hash)),
  };
}

function inspectExistingBlob(target, expectedHash, expectedBytes) {
  let stat;
  try { stat = fs.lstatSync(target); } catch (error) {
    if (error.code === 'ENOENT') return false;
    fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment 受控存储对象无效。');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== expectedBytes || hashFile(target) !== expectedHash) {
    fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment 受控存储对象无效。');
  }
  return true;
}

function verifyStagedForCommit(target, expectedHash, expectedBytes) {
  let stat;
  try { stat = fs.lstatSync(target); } catch { fail('ASSESSMENT_STORE_STAGING_CHANGED', 'Assessment staging 文件发生变化。'); }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== expectedBytes || hashFile(target) !== expectedHash) {
    fail('ASSESSMENT_STORE_STAGING_CHANGED', 'Assessment staging 文件发生变化。');
  }
}

function inspectCanonicalPreview(target, expectedPageCount) {
  let stat;
  let names;
  try {
    stat = fs.lstatSync(target);
    names = fs.readdirSync(target);
  } catch {
    fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment 受控存储对象无效。');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()
    || (expectedPageCount !== undefined && names.length !== expectedPageCount)) {
    fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment 受控存储对象无效。');
  }
  const pageNumbers = [];
  for (const name of names) {
    const match = name.match(/^page-(\d+)\.png$/);
    if (!match) fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment 受控存储对象无效。');
    const page = Number(match[1]);
    const pagePath = path.join(target, name);
    const pageStat = fs.lstatSync(pagePath);
    if (pageStat.isSymbolicLink() || !pageStat.isFile() || pageStat.size < 8) {
      fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment 受控存储对象无效。');
    }
    const descriptor = fs.openSync(pagePath, 'r');
    try {
      const header = Buffer.alloc(8);
      fs.readSync(descriptor, header, 0, header.length, 0);
      if (!header.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment 受控存储对象无效。');
      }
    } finally {
      fs.closeSync(descriptor);
    }
    pageNumbers.push(page);
  }
  pageNumbers.sort((left, right) => left - right);
  if (!pageNumbers.length || pageNumbers.some((page, index) => page !== index + 1)) {
    fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment 受控存储对象无效。');
  }
  return pageNumbers.length;
}

function markerData(hash) {
  return `${JSON.stringify({
    version: 1,
    content_sha256: hash,
    created_at: new Date().toISOString(),
    state: 'stored_pending_reference',
  })}\n`;
}

function confirmAssessmentBlobReference(dataRootInput, contentSha256) {
  const hash = String(contentSha256 || '');
  if (!/^[0-9a-f]{64}$/.test(hash)) fail('ASSESSMENT_STORE_HASH_INVALID', 'Assessment 内容标识无效。');
  const paths = prepareStore(dataRootInput);
  const canonical = canonicalPaths(paths, hash);
  try {
    const blobStat = fs.lstatSync(canonical.blob);
    if (blobStat.isSymbolicLink() || !blobStat.isFile()
      || !inspectExistingBlob(canonical.blob, hash, blobStat.size)) throw new Error('invalid blob');
    inspectCanonicalPreview(canonical.preview);
    fs.rmSync(canonical.marker, { force: true });
  } catch {
    fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment 受控存储对象无效。');
  }
  return { state: 'referenced', content_sha256: hash };
}

function verifyStoredArtifact(canonical, expectedHash, expectedBytes, pageCount) {
  if (!inspectExistingBlob(canonical.blob, expectedHash, expectedBytes)) {
    fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment 受控存储对象无效。');
  }
  inspectCanonicalPreview(canonical.preview, pageCount);
}

function safeRemove(target, recursive = false) {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(target);
      return;
    }
    fs.rmSync(target, { recursive, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function assessmentOcrErrorCode(error) {
  const code = String(error && error.code || '');
  if (code === 'LOCAL_OCR_UNAVAILABLE') return 'ASSESSMENT_REPORT_OCR_UNAVAILABLE';
  if (code === 'LOCAL_OCR_TEXT_EMPTY') return 'ASSESSMENT_REPORT_OCR_EMPTY';
  if (code === 'LOCAL_OCR_PAGE_LIMIT') return 'ASSESSMENT_REPORT_OCR_PAGE_LIMIT';
  if (code === 'LOCAL_OCR_TIMEOUT') return 'ASSESSMENT_REPORT_OCR_TIMEOUT';
  return 'ASSESSMENT_REPORT_OCR_FAILED';
}

async function importAssessmentPdf(sourcePath, options = {}) {
  if (importInProgress) fail('ASSESSMENT_STORE_BUSY', 'Assessment 文件导入正在进行。');
  importInProgress = true;
  let stagedPath;
  let previewWorkDirectory;
  let createdBlob = false;
  let createdPreview = false;
  let createdMarker = false;
  let referencePending = false;
  let canonical;
  try {
    const deadline = Date.now() + normalizeImportTimeout(options.importTimeoutMs);
    if (process.platform === 'win32' && typeof options.windowsReparsePointGuard !== 'function') {
      fail('ASSESSMENT_WINDOWS_REPARSE_GATE_REQUIRED', 'Assessment Windows reparse point 专项门禁尚未提供。');
    }
    const paths = prepareStore(options.dataRoot);
    const quotaBytes = normalizeQuota(options.quotaBytes);
    assertQuota(paths, quotaBytes);
    if (process.platform === 'win32') {
      const guarded = options.windowsReparsePointGuard({ sourcePath, assessmentRoot: paths.assessmentRoot });
      if (guarded !== true) fail('ASSESSMENT_WINDOWS_REPARSE_GATE_REQUIRED', 'Assessment Windows reparse point 专项门禁未通过。');
    }

    const staged = stageAssessmentPdf(sourcePath, {
      stagingRoot: paths.stagingRoot,
      maxBytes: options.maxBytes,
    });
    stagedPath = path.join(paths.stagingRoot, staged.staging_relpath);
    assertQuota(paths, quotaBytes);

    const scan = await scanAssessmentPdf(stagedPath, {
      stagingRoot: paths.stagingRoot,
      pdfinfoExecutablePath: options.pdfinfoExecutablePath,
      timeoutMs: remainingTimeout(deadline, options.scanTimeoutMs),
      maxStdoutBytes: options.maxToolStdoutBytes,
      maxStderrBytes: options.maxToolStderrBytes,
      parserRunner: options.parserRunner,
    });
    let analysis = null;
    let analysisErrorCode = null;
    let shouldRunOcr = !options.pdftotextExecutablePath;
    if (options.pdftotextExecutablePath) {
      try {
        analysis = await analyzeAssessmentReportPdf(stagedPath, {
          controlledRoot: paths.assessmentRoot,
          pdftotextExecutablePath: options.pdftotextExecutablePath,
          timeoutMs: remainingTimeout(deadline, options.analysisTimeoutMs),
          parserRunner: options.parserRunner,
        });
      } catch (error) {
        const code = String(error && error.code || '');
        if (['ASSESSMENT_REPORT_TEXT_EMPTY', 'ASSESSMENT_REPORT_TOOL_UNAVAILABLE', 'ASSESSMENT_REPORT_PROCESS_FAILED'].includes(code)) {
          shouldRunOcr = true;
        } else {
          throw error;
        }
      }
    }
    const preview = await renderAssessmentRasterPreview(stagedPath, {
      controlledRoot: paths.assessmentRoot,
      outputRoot: paths.previewWorkRoot,
      pdftoppmExecutablePath: options.pdftoppmExecutablePath,
      pageCount: scan.pages,
      timeoutMs: remainingTimeout(deadline, options.renderTimeoutMs),
      maxOutputBytes: options.maxPreviewOutputBytes,
      maxStdoutBytes: options.maxToolStdoutBytes,
      maxStderrBytes: options.maxToolStderrBytes,
      parserRunner: options.parserRunner,
    });
    previewWorkDirectory = preview.work_dir;
    if (!analysis && shouldRunOcr) {
      try {
        const ocr = await recognizeImageFiles(
          preview.page_files.map((name) => path.join(preview.work_dir, name)),
          {
            controlledRoot: preview.work_dir,
            visionOcrExecutablePath: options.visionOcrExecutablePath,
            visionOcrScriptPath: options.visionOcrScriptPath,
            tesseractExecutablePath: options.tesseractExecutablePath,
            ocrRunner: options.ocrRunner,
            timeoutMs: remainingTimeout(deadline, options.ocrTimeoutMs),
            maxPages: options.ocrMaxPages,
          },
        );
        analysis = analyzeAssessmentReportText(ocr.text, {
          source: 'supplier_pdf_local_ocr',
          ocr: {
            engine: ocr.engine,
            page_count: ocr.page_count,
            line_count: ocr.line_count,
            average_confidence: ocr.average_confidence,
          },
        });
      } catch (error) {
        analysisErrorCode = assessmentOcrErrorCode(error);
      }
    }
    assertQuota(paths, quotaBytes);

    canonical = canonicalPaths(paths, staged.content_sha256);
    if (inspectExistingBlob(canonical.blob, staged.content_sha256, staged.byte_size)) {
      verifyStoredArtifact(canonical, staged.content_sha256, staged.byte_size, scan.pages);
      const duplicateRecord = Object.freeze({
        state: 'duplicate_seen',
        duplicate: true,
        content_sha256: staged.content_sha256,
        byte_size: staged.byte_size,
        page_count: scan.pages,
        mime_detected: 'application/pdf',
        storage_relpath: canonical.storageRelpath,
        preview_relpath: canonical.previewRelpath,
        ...(analysis ? { analysis } : {}),
        ...(analysisErrorCode ? { analysis_error_code: analysisErrorCode } : {}),
      });
      if (options.onDuplicate !== undefined) {
        if (typeof options.onDuplicate !== 'function') {
          fail('ASSESSMENT_STORE_DUPLICATE_CALLBACK_INVALID', 'Assessment 重复提示回调无效。');
        }
        try {
          await options.onDuplicate(duplicateRecord);
        } catch {
          fail('ASSESSMENT_STORE_DUPLICATE_RECORD_FAILED', 'Assessment 重复提示记录失败。');
        }
      }
      // The public result deliberately omits the existing physical location;
      // the server-owned event callback above is the only integration surface.
      return {
        state: duplicateRecord.state,
        duplicate: duplicateRecord.duplicate,
        content_sha256: duplicateRecord.content_sha256,
        byte_size: duplicateRecord.byte_size,
        page_count: duplicateRecord.page_count,
      };
    }
    if (fs.existsSync(canonical.preview)) fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment 受控存储对象无效。');

    verifyStagedForCommit(stagedPath, staged.content_sha256, staged.byte_size);
    writePrivateFile(canonical.marker, markerData(staged.content_sha256), { flag: 'wx' });
    createdMarker = true;
    fs.linkSync(stagedPath, canonical.blob);
    createdBlob = true;
    if (!inspectExistingBlob(canonical.blob, staged.content_sha256, staged.byte_size)) {
      fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment 受控存储对象无效。');
    }
    ensurePrivateFile(canonical.blob);
    fs.renameSync(previewWorkDirectory, canonical.preview);
    previewWorkDirectory = undefined;
    createdPreview = true;
    safeRemove(stagedPath);
    stagedPath = undefined;
    referencePending = true;

    const stored = {
      state: 'stored_pending_reference',
      duplicate: false,
      content_sha256: staged.content_sha256,
      byte_size: staged.byte_size,
      page_count: scan.pages,
      mime_detected: 'application/pdf',
      storage_relpath: canonical.storageRelpath,
      preview_relpath: canonical.previewRelpath,
      preview_page_count: preview.page_count,
      preview_byte_size: preview.total_bytes,
      original_viewer_enabled: false,
      ...(analysis ? { analysis } : {}),
      ...(analysisErrorCode ? { analysis_error_code: analysisErrorCode } : {}),
    };
    if (options.commitDocument !== undefined) {
      if (typeof options.commitDocument !== 'function') fail('ASSESSMENT_STORE_COMMIT_INVALID', 'Assessment 引用提交回调无效。');
      try {
        await options.commitDocument(Object.freeze({ ...stored }));
      } catch {
        fail('ASSESSMENT_STORE_REFERENCE_COMMIT_FAILED', 'Assessment 引用提交失败，文件等待延迟补偿。');
      }
      // Re-verify the exact hash, byte count and canonical preview set after
      // the DB callback but before clearing the orphan compensation marker.
      verifyStoredArtifact(canonical, stored.content_sha256, stored.byte_size, stored.page_count);
      if (canonical.storageRelpath !== stored.storage_relpath
        || canonical.previewRelpath !== stored.preview_relpath) {
        fail('ASSESSMENT_STORE_BLOB_INVALID', 'Assessment 受控存储对象无效。');
      }
      confirmAssessmentBlobReference(paths.dataRoot, staged.content_sha256);
      referencePending = false;
      return { ...stored, state: 'stored_referenced' };
    }
    return stored;
  } catch (error) {
    if (error instanceof AssessmentControlledStoreError) throw error;
    // Upstream modules already expose deliberately redacted, stable codes.
    if (error && typeof error.code === 'string' && /^ASSESSMENT_/.test(error.code)) throw error;
    fail('ASSESSMENT_STORE_IMPORT_FAILED', 'Assessment 受控存储导入失败。');
  } finally {
    importInProgress = false;
    if (stagedPath) {
      try { safeRemove(stagedPath); } catch {}
    }
    if (previewWorkDirectory) {
      try { safeRemove(previewWorkDirectory, true); } catch {}
    }
    if (!referencePending && canonical) {
      if (createdPreview) {
        // Referenced content and successful returns set referencePending false only
        // after the marker is removed; those assets must remain immutable.
        const markerExists = fs.existsSync(canonical.marker);
        if (markerExists) {
          try { safeRemove(canonical.preview, true); } catch {}
          try { safeRemove(canonical.blob); } catch {}
          try { safeRemove(canonical.marker); } catch {}
        }
      } else if (createdBlob) {
        try { safeRemove(canonical.blob); } catch {}
        try { safeRemove(canonical.marker); } catch {}
      } else if (createdMarker) {
        try { safeRemove(canonical.marker); } catch {}
      }
    }
  }
}

function collectAssessmentOrphans(options = {}) {
  const paths = prepareStore(options.dataRoot);
  const graceMs = options.graceMs === undefined ? DEFAULT_ORPHAN_GRACE_MS : options.graceMs;
  if (!Number.isSafeInteger(graceMs) || graceMs < MIN_ORPHAN_GRACE_MS) {
    fail('ASSESSMENT_ORPHAN_GRACE_INVALID', 'Assessment 孤儿清理延迟无效。');
  }
  const nowMs = options.nowMs === undefined ? Date.now() : options.nowMs;
  if (!Number.isFinite(nowMs) || nowMs < 0) fail('ASSESSMENT_ORPHAN_CLOCK_INVALID', 'Assessment 孤儿清理时钟无效。');
  const referencedHashes = options.referencedHashes instanceof Set
    ? options.referencedHashes
    : new Set(options.referencedHashes || []);
  for (const hash of referencedHashes) {
    if (!/^[0-9a-f]{64}$/.test(String(hash))) fail('ASSESSMENT_STORE_HASH_INVALID', 'Assessment 内容标识无效。');
  }

  let removed = 0;
  let retained = 0;
  let reconciled = 0;
  for (const name of fs.readdirSync(paths.orphanRoot)) {
    const match = name.match(/^([0-9a-f]{64})\.json$/);
    if (!match) fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment 孤儿标记无效。');
    const marker = path.join(paths.orphanRoot, name);
    const markerStat = fs.lstatSync(marker);
    if (markerStat.isSymbolicLink() || !markerStat.isFile()) fail('ASSESSMENT_STORE_PATH_UNSAFE', 'Assessment 孤儿标记无效。');
    const hash = match[1];
    if (referencedHashes.has(hash)) {
      safeRemove(marker);
      reconciled += 1;
      continue;
    }
    if (nowMs - markerStat.mtimeMs < graceMs) {
      retained += 1;
      continue;
    }
    const canonical = canonicalPaths(paths, hash);
    safeRemove(canonical.preview, true);
    safeRemove(canonical.blob);
    safeRemove(marker);
    removed += 1;
  }
  return { state: 'orphan_gc_complete', removed, retained, reconciled };
}

function reconcileAssessmentOrphans({ database, dataRoot, nowMs, graceMs } = {}) {
  if (!database || typeof database.prepare !== 'function') {
    fail('ASSESSMENT_ORPHAN_DATABASE_REQUIRED', 'Assessment 孤儿对账数据库不可用。');
  }
  const referencedHashes = new Set(database.prepare(`
    SELECT content_sha256
    FROM assessment_document
    WHERE content_sha256 IS NOT NULL AND lifecycle_state <> 'deleted'
  `).all().map((row) => row.content_sha256));
  return collectAssessmentOrphans({ dataRoot, referencedHashes, nowMs, graceMs });
}

module.exports = {
  AssessmentControlledStoreError,
  DEFAULT_ORPHAN_GRACE_MS,
  DEFAULT_IMPORT_TIMEOUT_MS,
  DEFAULT_STORE_QUOTA_BYTES,
  MIN_ORPHAN_GRACE_MS,
  WINDOWS_REPARSE_RELEASE_GATE,
  collectAssessmentOrphans,
  confirmAssessmentBlobReference,
  importAssessmentPdf,
  reconcileAssessmentOrphans,
};
