const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { PRIVATE_FILE_MODE, ensurePrivateDir, ensurePrivateFile, hardenPrivateDir } = require('./secure-fs');

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const PDF_MAGIC = Buffer.from('%PDF-', 'ascii');
const COPY_BUFFER_BYTES = 64 * 1024;

class AssessmentFileIntakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AssessmentFileIntakeError';
    this.code = code;
  }
}

function intakeError(code, message) {
  return new AssessmentFileIntakeError(code, message);
}

function normalizeMaxBytes(value) {
  if (value === undefined) return DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_MAX_BYTES) {
    throw intakeError('ASSESSMENT_FILE_LIMIT_INVALID', 'Assessment 文件大小限制无效。');
  }
  return value;
}

function resolveRequiredPath(value, code, message) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw intakeError(code, message);
  }
  return path.resolve(value.trim());
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function inspectSource(sourcePath, maxBytes) {
  let stat;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch {
    throw intakeError('ASSESSMENT_FILE_SOURCE_UNAVAILABLE', 'Assessment 源文件不存在或不可访问。');
  }
  if (stat.isSymbolicLink()) {
    throw intakeError('ASSESSMENT_FILE_SOURCE_SYMLINK', 'Assessment 源文件不能是符号链接。');
  }
  if (!stat.isFile()) {
    throw intakeError('ASSESSMENT_FILE_SOURCE_NOT_FILE', 'Assessment 源对象必须是普通文件。');
  }
  if (stat.size <= 0 || stat.size > maxBytes) {
    throw intakeError('ASSESSMENT_FILE_SOURCE_SIZE_INVALID', 'Assessment 源文件大小不符合限制。');
  }
  return stat;
}

function prepareStagingRoot(rootInput) {
  const root = resolveRequiredPath(
    rootInput,
    'ASSESSMENT_STAGING_ROOT_REQUIRED',
    'Assessment staging 目录无效。',
  );
  try {
    let stat = null;
    try {
      stat = fs.lstatSync(root);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw intakeError('ASSESSMENT_STAGING_ROOT_INVALID', 'Assessment staging 目录不可用。');
    }
    ensurePrivateDir(root);
    stat = fs.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw intakeError('ASSESSMENT_STAGING_ROOT_INVALID', 'Assessment staging 目录不可用。');
    }
    hardenPrivateDir(root);
    return fs.realpathSync(root);
  } catch (error) {
    if (error instanceof AssessmentFileIntakeError) throw error;
    throw intakeError('ASSESSMENT_STAGING_ROOT_INVALID', 'Assessment staging 目录不可用。');
  }
}

function openRandomStagingFile(root) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const filename = `${crypto.randomUUID()}.pdf`;
    const targetPath = path.join(root, filename);
    try {
      const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
      const descriptor = fs.openSync(targetPath, flags, PRIVATE_FILE_MODE);
      return { descriptor, filename, targetPath };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw intakeError('ASSESSMENT_STAGING_NAME_UNAVAILABLE', '无法分配 Assessment staging 文件。');
}

function writeAll(descriptor, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(descriptor, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error('short write');
    offset += written;
  }
}

function assertStableSource(sourcePath, initialPathStat, initialDescriptorStat, finalDescriptorStat, copiedBytes) {
  if (!sameSnapshot(initialDescriptorStat, finalDescriptorStat)
    || copiedBytes !== initialDescriptorStat.size
    || copiedBytes !== finalDescriptorStat.size) {
    throw intakeError('ASSESSMENT_FILE_SOURCE_CHANGED', 'Assessment 源文件在接收期间发生变化。');
  }

  let finalPathStat;
  try {
    finalPathStat = fs.lstatSync(sourcePath);
  } catch {
    throw intakeError('ASSESSMENT_FILE_SOURCE_CHANGED', 'Assessment 源文件在接收期间发生变化。');
  }
  if (finalPathStat.isSymbolicLink() || !finalPathStat.isFile()
    || !sameSnapshot(initialPathStat, finalPathStat)
    || !sameIdentity(finalPathStat, finalDescriptorStat)) {
    throw intakeError('ASSESSMENT_FILE_SOURCE_CHANGED', 'Assessment 源文件在接收期间发生变化。');
  }
}

function stageAssessmentPdf(sourceInput, options = {}) {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const sourcePath = resolveRequiredPath(
    sourceInput,
    'ASSESSMENT_FILE_SOURCE_REQUIRED',
    '请选择有效的 Assessment 源文件。',
  );
  const initialPathStat = inspectSource(sourcePath, maxBytes);

  let sourceDescriptor;
  let targetDescriptor;
  let targetPath;
  let completed = false;

  try {
    // O_NOFOLLOW is used when Node exposes it. Node core does not expose a complete
    // generic Windows reparse-point inspection API, so that release gate remains open.
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    sourceDescriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | noFollow);
    const initialDescriptorStat = fs.fstatSync(sourceDescriptor);
    if (!initialDescriptorStat.isFile()) {
      throw intakeError('ASSESSMENT_FILE_SOURCE_NOT_FILE', 'Assessment 源对象必须是普通文件。');
    }
    if (!sameSnapshot(initialPathStat, initialDescriptorStat)) {
      throw intakeError('ASSESSMENT_FILE_SOURCE_CHANGED', 'Assessment 源文件在接收期间发生变化。');
    }
    if (initialDescriptorStat.size <= 0 || initialDescriptorStat.size > maxBytes) {
      throw intakeError('ASSESSMENT_FILE_SOURCE_SIZE_INVALID', 'Assessment 源文件大小不符合限制。');
    }

    const header = Buffer.alloc(PDF_MAGIC.length);
    const headerBytes = fs.readSync(sourceDescriptor, header, 0, header.length, null);
    if (headerBytes !== PDF_MAGIC.length || !header.equals(PDF_MAGIC)) {
      throw intakeError('ASSESSMENT_FILE_PDF_MAGIC_INVALID', 'Assessment 源文件不是可接收的 PDF 字节流。');
    }

    const stagingRoot = prepareStagingRoot(options.stagingRoot);
    const openedTarget = openRandomStagingFile(stagingRoot);
    targetDescriptor = openedTarget.descriptor;
    targetPath = openedTarget.targetPath;

    const hash = crypto.createHash('sha256');
    hash.update(header);
    writeAll(targetDescriptor, header);
    let copiedBytes = header.length;
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);

    while (true) {
      const bytesRead = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      if (copiedBytes + bytesRead > maxBytes) {
        throw intakeError('ASSESSMENT_FILE_SOURCE_SIZE_INVALID', 'Assessment 源文件大小不符合限制。');
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      writeAll(targetDescriptor, chunk);
      copiedBytes += bytesRead;
    }

    const finalDescriptorStat = fs.fstatSync(sourceDescriptor);
    assertStableSource(
      sourcePath,
      initialPathStat,
      initialDescriptorStat,
      finalDescriptorStat,
      copiedBytes,
    );

    fs.fsyncSync(targetDescriptor);
    fs.closeSync(targetDescriptor);
    targetDescriptor = undefined;
    fs.closeSync(sourceDescriptor);
    sourceDescriptor = undefined;
    ensurePrivateFile(targetPath);

    completed = true;
    return {
      staging_relpath: openedTarget.filename,
      content_sha256: hash.digest('hex'),
      byte_size: copiedBytes,
      state: 'pending_scan',
    };
  } catch (error) {
    if (error instanceof AssessmentFileIntakeError) throw error;
    throw intakeError('ASSESSMENT_FILE_INTAKE_FAILED', 'Assessment 文件接收失败。');
  } finally {
    if (targetDescriptor !== undefined) {
      try { fs.closeSync(targetDescriptor); } catch {}
    }
    if (sourceDescriptor !== undefined) {
      try { fs.closeSync(sourceDescriptor); } catch {}
    }
    if (!completed && targetPath) {
      try { fs.rmSync(targetPath, { force: true }); } catch {}
    }
  }
}

module.exports = {
  AssessmentFileIntakeError,
  DEFAULT_MAX_BYTES,
  stageAssessmentPdf,
};
