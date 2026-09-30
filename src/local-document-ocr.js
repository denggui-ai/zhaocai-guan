'use strict';
const { PROJECT_ROOT } = require("./paths");


const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DEFAULT_MAX_PAGES = 80;
const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60 * 1000;

class LocalDocumentOcrError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalDocumentOcrError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new LocalDocumentOcrError(code, message);
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function checkedRoot(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) {
    fail('LOCAL_OCR_ROOT_INVALID', '本地 OCR 受控目录无效。');
  }
  try {
    const stat = fs.lstatSync(input);
    const real = fs.realpathSync(input);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('invalid root');
    return real;
  } catch {
    fail('LOCAL_OCR_ROOT_INVALID', '本地 OCR 受控目录无效。');
  }
}

function checkedPng(input, root) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) {
    fail('LOCAL_OCR_IMAGE_INVALID', '本地 OCR 图片无效。');
  }
  try {
    const stat = fs.lstatSync(input);
    const real = fs.realpathSync(input);
    if (stat.isSymbolicLink() || !stat.isFile() || !within(root, real)) throw new Error('invalid image');
    const descriptor = fs.openSync(real, 'r');
    try {
      const header = Buffer.alloc(PNG_MAGIC.length);
      fs.readSync(descriptor, header, 0, header.length, 0);
      if (!header.equals(PNG_MAGIC)) throw new Error('not png');
    } finally {
      fs.closeSync(descriptor);
    }
    return { path: real, stat };
  } catch {
    fail('LOCAL_OCR_IMAGE_INVALID', '本地 OCR 图片无效。');
  }
}

function normalizePositive(value, fallback, maximum, code) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) fail(code, '本地 OCR 资源限制无效。');
  return value;
}

function normalizeText(value, maxBytes) {
  const source = String(value || '')
    .replace(/\0/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  const bytes = Buffer.from(source, 'utf8');
  if (bytes.length <= maxBytes) return source;
  return bytes.subarray(0, maxBytes).toString('utf8').replace(/\uFFFD+$/g, '').trim();
}

function checkedExecutable(input) {
  const value = String(input || '').trim();
  if (!value || !path.isAbsolute(value) || value.includes('\0')) return '';
  try {
    const real = fs.realpathSync(value);
    const stat = fs.statSync(real);
    if (!stat.isFile()) return '';
    fs.accessSync(real, fs.constants.X_OK);
    return real;
  } catch {
    return '';
  }
}

function linesFromVisionRows(rows) {
  const pages = Array.isArray(rows) ? rows : [];
  const pageTexts = [];
  let lineCount = 0;
  let confidenceTotal = 0;
  let confidenceCount = 0;
  for (const page of pages) {
    if (page && page.error) fail('LOCAL_OCR_PROCESS_FAILED', '本地 OCR 无法读取部分 PDF 页面。');
    const lines = Array.isArray(page && page.lines) ? page.lines : [];
    const texts = [];
    for (const line of lines) {
      const text = String(line && line.text || '').trim();
      if (!text) continue;
      texts.push(text);
      lineCount += 1;
      const confidence = Number(line && line.confidence);
      if (Number.isFinite(confidence)) {
        confidenceTotal += confidence;
        confidenceCount += 1;
      }
    }
    pageTexts.push(texts.join('\n'));
  }
  return {
    text: pageTexts.filter(Boolean).join('\n\n'),
    line_count: lineCount,
    average_confidence: confidenceCount ? Math.round((confidenceTotal / confidenceCount) * 1000) / 1000 : null,
  };
}

function runMacVision(images, options) {
  const swift = checkedExecutable(options.visionOcrExecutablePath || '/usr/bin/swift');
  const script = String(options.visionOcrScriptPath || path.join(PROJECT_ROOT, "native/vision-ocr.swift"));
  if (!swift || !path.isAbsolute(script) || !fs.existsSync(script)) return null;
  const result = spawnSync(swift, [script, ...images.map((item) => item.path)], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs,
    maxBuffer: options.maxTextBytes + (512 * 1024),
  });
  if (result.error || result.status !== 0) return null;
  try {
    return { ...linesFromVisionRows(JSON.parse(result.stdout)), engine: 'macos_vision' };
  } catch {
    return null;
  }
}

function availableTesseractLanguages(executable, timeoutMs) {
  const result = spawnSync(executable, ['--list-langs'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: Math.min(timeoutMs, 10_000),
    maxBuffer: 256 * 1024,
  });
  if (result.error || result.status !== 0) return new Set();
  return new Set(String(result.stdout || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean));
}

function runTesseract(images, options) {
  const executable = checkedExecutable(options.tesseractExecutablePath);
  if (!executable) return null;
  const languages = availableTesseractLanguages(executable, options.timeoutMs);
  const selected = languages.has('chi_sim') && languages.has('eng')
    ? 'chi_sim+eng'
    : languages.has('chi_sim') ? 'chi_sim' : languages.has('eng') ? 'eng' : '';
  if (!selected) return null;
  // The budget is per page, not per document. Spending one allowance across the
  // whole batch meant a scanned resume was rationed by its length: past roughly
  // twenty pages the later ones were guaranteed to run out, and the failure read
  // as "OCR timed out" rather than "this document is longer than the budget".
  // Page count is already bounded separately by maxPages.
  const perPageMs = options.timeoutMs;
  const pages = [];
  for (const image of images) {
    const result = spawnSync(executable, [image.path, 'stdout', '-l', selected, '--psm', '6'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: perPageMs,
      maxBuffer: options.maxTextBytes + (256 * 1024),
    });
    // spawnSync reports a killed child through error, so a page that overran its
    // own budget is still named as a timeout rather than a generic failure.
    if (result.error && result.error.code === 'ETIMEDOUT') {
      fail('LOCAL_OCR_TIMEOUT', `本地 OCR 单页超时（每页上限 ${Math.round(perPageMs / 1000)} 秒）。`);
    }
    if (result.error || result.status !== 0) fail('LOCAL_OCR_PROCESS_FAILED', '本地 OCR 执行失败。');
    pages.push(String(result.stdout || '').trim());
  }
  return {
    engine: 'tesseract',
    text: pages.filter(Boolean).join('\n\n'),
    line_count: pages.reduce((count, page) => count + page.split(/\r?\n/).filter(Boolean).length, 0),
    average_confidence: null,
  };
}

async function recognizeImageFiles(imagePaths, options = {}) {
  const root = checkedRoot(options.controlledRoot);
  const maxPages = normalizePositive(options.maxPages, DEFAULT_MAX_PAGES, 200, 'LOCAL_OCR_PAGE_LIMIT_INVALID');
  const maxTextBytes = normalizePositive(options.maxTextBytes, DEFAULT_MAX_TEXT_BYTES, 8 * 1024 * 1024, 'LOCAL_OCR_TEXT_LIMIT_INVALID');
  const timeoutMs = normalizePositive(options.timeoutMs, DEFAULT_TIMEOUT_MS, 5 * 60 * 1000, 'LOCAL_OCR_TIMEOUT_INVALID');
  if (!Array.isArray(imagePaths) || !imagePaths.length) fail('LOCAL_OCR_IMAGE_REQUIRED', '没有可识别的 PDF 页面。');
  if (imagePaths.length > maxPages) fail('LOCAL_OCR_PAGE_LIMIT', `扫描 PDF 超过本地 OCR 的 ${maxPages} 页限制。`);
  const images = imagePaths.map((item) => checkedPng(item, root));
  let result;
  if (typeof options.ocrRunner === 'function') {
    const injected = await options.ocrRunner(images.map((item) => item.path));
    result = typeof injected === 'string'
      ? { text: injected, engine: 'injected', line_count: String(injected).split(/\r?\n/).filter(Boolean).length, average_confidence: null }
      : injected;
  } else {
    result = process.platform === 'darwin' ? runMacVision(images, { ...options, timeoutMs, maxTextBytes }) : null;
    if (!result) result = runTesseract(images, { ...options, timeoutMs, maxTextBytes });
  }
  if (!result) fail('LOCAL_OCR_UNAVAILABLE', '本机没有可用的本地 OCR 引擎。');
  const text = normalizeText(result.text, maxTextBytes);
  if (!text) fail('LOCAL_OCR_TEXT_EMPTY', '本地 OCR 未识别到可用文字。');
  return Object.freeze({
    text,
    engine: String(result.engine || 'local_ocr'),
    page_count: images.length,
    line_count: Number(result.line_count || 0),
    average_confidence: result.average_confidence == null ? null : Number(result.average_confidence),
  });
}

module.exports = {
  DEFAULT_MAX_PAGES,
  LocalDocumentOcrError,
  recognizeImageFiles,
};
