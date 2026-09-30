'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { ensurePrivateDir, ensurePrivateFile, hardenPrivateDir } = require('./secure-fs');
const { spawnAssessmentParser } = require('./assessment-parser-runner');

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_STDIO_LIMIT = 64 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
const MAX_PAGES = 200;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class AssessmentRasterPreviewError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AssessmentRasterPreviewError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AssessmentRasterPreviewError(code, message);
}

function requireAbsolute(value, code) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    fail(code, 'Assessment 栅格预览受控路径无效。');
  }
  return path.resolve(value);
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function checkedDirectory(input, code) {
  const resolved = requireAbsolute(input, code);
  try {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('invalid directory');
    return fs.realpathSync(resolved);
  } catch {
    fail(code, 'Assessment 栅格预览受控目录无效。');
  }
}

function checkedFile(input, controlledRoot) {
  const resolved = requireAbsolute(input, 'ASSESSMENT_PREVIEW_FILE_INVALID');
  let pathStat;
  let real;
  let stat;
  try {
    pathStat = fs.lstatSync(resolved);
    if (pathStat.isSymbolicLink()) fail('ASSESSMENT_PREVIEW_FILE_SYMLINK', 'Assessment 栅格预览拒绝符号链接。');
    if (!pathStat.isFile()) fail('ASSESSMENT_PREVIEW_FILE_NOT_REGULAR', 'Assessment 栅格预览只接受普通文件。');
    real = fs.realpathSync(resolved);
    stat = fs.statSync(real);
  } catch (error) {
    if (error instanceof AssessmentRasterPreviewError) throw error;
    fail('ASSESSMENT_PREVIEW_FILE_UNAVAILABLE', 'Assessment 栅格预览输入不可访问。');
  }
  if (!within(controlledRoot, real)) fail('ASSESSMENT_PREVIEW_FILE_OUTSIDE_ROOT', 'Assessment 栅格预览输入越过受控边界。');
  return {
    path: resolved,
    real,
    snapshot: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    },
  };
}

function sameSnapshot(file) {
  try {
    const lstat = fs.lstatSync(file.path);
    const real = fs.realpathSync(file.path);
    const stat = fs.statSync(real);
    return !lstat.isSymbolicLink() && lstat.isFile() && real === file.real
      && stat.dev === file.snapshot.dev && stat.ino === file.snapshot.ino
      && stat.size === file.snapshot.size && stat.mtimeMs === file.snapshot.mtimeMs
      && stat.ctimeMs === file.snapshot.ctimeMs;
  } catch {
    return false;
  }
}

function checkedExecutable(input) {
  const resolved = requireAbsolute(input, 'ASSESSMENT_PREVIEW_TOOL_UNAVAILABLE');
  try {
    const real = fs.realpathSync(resolved);
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new Error('not file');
    fs.accessSync(real, fs.constants.X_OK);
    return real;
  } catch {
    fail('ASSESSMENT_PREVIEW_TOOL_UNAVAILABLE', 'Assessment 栅格预览工具不可用。');
  }
}

function positiveLimit(value, fallback, maximum, code) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    fail(code, 'Assessment 栅格预览资源限制无效。');
  }
  return value;
}

function inspectOutput(workDirectory, pageCount, maxOutputBytes, requireComplete) {
  let names;
  try {
    names = fs.readdirSync(workDirectory);
  } catch {
    fail('ASSESSMENT_PREVIEW_OUTPUT_INVALID', 'Assessment 栅格预览输出无效。');
  }
  const pages = [];
  let totalBytes = 0;
  for (const name of names) {
    const match = name.match(/^page-(\d+)\.png$/);
    if (!match) fail('ASSESSMENT_PREVIEW_OUTPUT_INVALID', 'Assessment 栅格预览输出无效。');
    const page = Number(match[1]);
    if (!Number.isSafeInteger(page) || page < 1 || page > pageCount) {
      fail('ASSESSMENT_PREVIEW_OUTPUT_INVALID', 'Assessment 栅格预览输出无效。');
    }
    const filePath = path.join(workDirectory, name);
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('ASSESSMENT_PREVIEW_OUTPUT_INVALID', 'Assessment 栅格预览输出无效。');
    }
    totalBytes += stat.size;
    if (totalBytes > maxOutputBytes) fail('ASSESSMENT_PREVIEW_OUTPUT_LIMIT', 'Assessment 栅格预览输出超过限制。');
    pages.push({ page, name, bytes: stat.size });
  }
  pages.sort((left, right) => left.page - right.page);
  if (requireComplete) {
    if (pages.length !== pageCount || pages.some((entry, index) => entry.page !== index + 1)) {
      fail('ASSESSMENT_PREVIEW_PAGE_SET_INVALID', 'Assessment 栅格预览页集合无效。');
    }
    for (const entry of pages) {
      const descriptor = fs.openSync(path.join(workDirectory, entry.name), 'r');
      try {
        const header = Buffer.alloc(PNG_MAGIC.length);
        if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length || !header.equals(PNG_MAGIC)) {
          fail('ASSESSMENT_PREVIEW_OUTPUT_INVALID', 'Assessment 栅格预览输出无效。');
        }
      } finally {
        fs.closeSync(descriptor);
      }
      ensurePrivateFile(path.join(workDirectory, entry.name));
    }
  }
  return { pages, totalBytes };
}

function normalizePageFilenames(workDirectory, pages) {
  const nonce = crypto.randomUUID();
  const stagedNames = [];
  for (const entry of pages) {
    const temporaryName = `.normalize-${nonce}-${entry.page}`;
    fs.renameSync(path.join(workDirectory, entry.name), path.join(workDirectory, temporaryName));
    stagedNames.push({ page: entry.page, temporaryName });
  }
  for (const entry of stagedNames) {
    fs.renameSync(
      path.join(workDirectory, entry.temporaryName),
      path.join(workDirectory, `page-${entry.page}.png`),
    );
  }
}

function renderAssessmentRasterPreview(stagedInput, options = {}) {
  const pageCount = positiveLimit(options.pageCount, undefined, MAX_PAGES, 'ASSESSMENT_PREVIEW_PAGE_COUNT_INVALID');
  const timeoutMs = positiveLimit(options.timeoutMs, DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 'ASSESSMENT_PREVIEW_TIMEOUT_INVALID');
  const maxOutputBytes = positiveLimit(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES, 'ASSESSMENT_PREVIEW_OUTPUT_LIMIT_INVALID');
  const maxStdoutBytes = positiveLimit(options.maxStdoutBytes, DEFAULT_STDIO_LIMIT, 1024 * 1024, 'ASSESSMENT_PREVIEW_STDOUT_LIMIT_INVALID');
  const maxStderrBytes = positiveLimit(options.maxStderrBytes, DEFAULT_STDIO_LIMIT, 1024 * 1024, 'ASSESSMENT_PREVIEW_STDERR_LIMIT_INVALID');
  const controlledRoot = checkedDirectory(options.controlledRoot, 'ASSESSMENT_PREVIEW_ROOT_INVALID');
  const outputParent = checkedDirectory(options.outputRoot, 'ASSESSMENT_PREVIEW_OUTPUT_ROOT_INVALID');
  if (!within(controlledRoot, outputParent)) fail('ASSESSMENT_PREVIEW_OUTPUT_ROOT_INVALID', 'Assessment 栅格预览受控目录无效。');
  const file = checkedFile(stagedInput, controlledRoot);
  const executable = checkedExecutable(options.pdftoppmExecutablePath);
  const workDirectory = path.join(outputParent, crypto.randomUUID());
  ensurePrivateDir(workDirectory);
  hardenPrivateDir(workDirectory);
  const outputPrefix = path.join(workDirectory, 'page');
  const parserRunner = options.parserRunner || spawnAssessmentParser;

  return new Promise((resolve, reject) => {
    let child;
    let runner;
    let terminalError = null;
    let spawnError = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer;
    let monitor;
    let complete = false;

    function cleanup() {
      if (!complete) {
        try { fs.rmSync(workDirectory, { recursive: true, force: true }); } catch {}
      }
    }
    function stopWith(error) {
      if (terminalError) return;
      terminalError = error;
      runner.kill();
    }
    function monitorOutput() {
      try {
        inspectOutput(workDirectory, pageCount, maxOutputBytes, false);
      } catch (error) {
        stopWith(error instanceof AssessmentRasterPreviewError
          ? error
          : new AssessmentRasterPreviewError('ASSESSMENT_PREVIEW_OUTPUT_INVALID', 'Assessment 栅格预览输出无效。'));
      }
    }

    try {
      const parserArgs = [
        '-png', '-r', '144', '-f', '1', '-l', String(pageCount), file.real, outputPrefix,
      ];
      runner = parserRunner(executable, parserArgs, {
        inputPath: file.real,
        workingDirectory: workDirectory,
        outputRoot: workDirectory,
        maxFileBytes: maxOutputBytes,
      });
      child = runner.child;
    } catch (error) {
      cleanup();
      reject(new AssessmentRasterPreviewError(
        (error && error.code) || 'ASSESSMENT_PARSER_SANDBOX_UNAVAILABLE',
        'Assessment 栅格预览隔离 runner 不可用。',
      ));
      return;
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) stopWith(new AssessmentRasterPreviewError('ASSESSMENT_PREVIEW_STDOUT_LIMIT', 'Assessment 栅格预览输出超过限制。'));
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxStderrBytes) stopWith(new AssessmentRasterPreviewError('ASSESSMENT_PREVIEW_STDERR_LIMIT', 'Assessment 栅格预览诊断输出超过限制。'));
    });
    child.on('error', (error) => { spawnError = error; });
    timer = setTimeout(() => stopWith(new AssessmentRasterPreviewError('ASSESSMENT_PREVIEW_TIMEOUT', 'Assessment 栅格预览执行超时。')), timeoutMs);
    timer.unref?.();
    monitor = setInterval(monitorOutput, 25);
    monitor.unref?.();
    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(monitor);
      try {
        const resourceError = runner.finish();
        if (resourceError) throw new AssessmentRasterPreviewError(resourceError.code, resourceError.message);
        if (terminalError) throw terminalError;
        if (spawnError || code !== 0) throw new AssessmentRasterPreviewError('ASSESSMENT_PREVIEW_PROCESS_FAILED', 'Assessment 栅格预览执行失败。');
        if (!sameSnapshot(file)) throw new AssessmentRasterPreviewError('ASSESSMENT_PREVIEW_FILE_CHANGED', 'Assessment 栅格预览输入在执行期间发生变化。');
        const output = inspectOutput(workDirectory, pageCount, maxOutputBytes, true);
        // Poppler pads page numbers according to the final page (for example
        // page-01.png or page-001.png). Canonicalize so later reads never need
        // to guess the renderer's padding convention.
        normalizePageFilenames(workDirectory, output.pages);
        complete = true;
        resolve({
          state: 'raster_preview_ready',
          format: 'png',
          page_count: pageCount,
          total_bytes: output.totalBytes,
          work_dir: workDirectory,
          page_files: output.pages.map((entry) => `page-${entry.page}.png`),
        });
      } catch (error) {
        reject(error instanceof AssessmentRasterPreviewError
          ? error
          : new AssessmentRasterPreviewError('ASSESSMENT_PREVIEW_OUTPUT_INVALID', 'Assessment 栅格预览输出无效。'));
      } finally {
        cleanup();
      }
    });
  });
}

function readAssessmentRasterPage(options = {}) {
  const previewRoot = checkedDirectory(options.previewRoot, 'ASSESSMENT_PREVIEW_ROOT_INVALID');
  const hash = String(options.contentSha256 || '');
  const page = Number(options.page);
  if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(page) || page < 1 || page > MAX_PAGES) {
    fail('ASSESSMENT_PREVIEW_PAGE_INVALID', 'Assessment 栅格预览页无效。');
  }
  const target = path.join(previewRoot, 'sha256', hash.slice(0, 2), hash, `page-${page}.png`);
  const file = checkedFile(target, previewRoot);
  const bytes = fs.readFileSync(file.real);
  if (!sameSnapshot(file) || bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    fail('ASSESSMENT_PREVIEW_OUTPUT_INVALID', 'Assessment 栅格预览输出无效。');
  }
  return bytes;
}

module.exports = {
  AssessmentRasterPreviewError,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  MAX_PAGES,
  readAssessmentRasterPage,
  renderAssessmentRasterPreview,
};
