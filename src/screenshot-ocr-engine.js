'use strict';
const { PROJECT_ROOT } = require("./paths");


// Screenshot recognition for the Boss App import path.
//
// macOS reads screenshots with Vision; every other platform reads them with
// tesseract. Both produce the same line shape — text, confidence and a pixel
// bounding box — because the name extractor downstream is geometric: it scores
// candidate lines by where they sit on the page. An engine that returned plain
// text would silently break that scoring rather than fail loudly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_PSM = '6';
const MAX_BUFFER = 1024 * 1024 * 80;

class ScreenshotOcrError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScreenshotOcrError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ScreenshotOcrError(code, message);
}

function selectedEngine() {
  const forced = String(process.env.HRBOSS_SCREENSHOT_OCR_ENGINE || '').trim().toLowerCase();
  if (forced) return forced;
  return process.platform === 'darwin' ? 'macos_vision' : 'tesseract';
}

function writeProgress(progressFile, done, total) {
  if (!progressFile) return;
  try {
    fs.writeFileSync(progressFile, JSON.stringify({ done, total }));
  } catch {
    // Progress is advisory; never let it interrupt recognition.
  }
}

// ---------------------------------------------------------------- macOS Vision

function runMacVision(files, progressFile) {
  const scriptArgs = [path.join(PROJECT_ROOT, "native/vision-ocr.swift")];
  if (progressFile) scriptArgs.push(`--progress=${progressFile}`);
  const swift = spawnSync('/usr/bin/swift', [...scriptArgs, ...files], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  if (swift.error && swift.error.code === 'ENOENT') {
    fail('SCREENSHOT_OCR_VISION_UNAVAILABLE', '本机没有可用的 Vision 识别环境（缺少 /usr/bin/swift）。');
  }
  if (swift.status !== 0) {
    fail('SCREENSHOT_OCR_VISION_FAILED', `Vision 识别失败：${swift.stderr || swift.stdout || `exit ${swift.status}`}`);
  }
  try {
    return JSON.parse(swift.stdout);
  } catch {
    return fail('SCREENSHOT_OCR_VISION_FAILED', 'Vision 识别返回了无法解析的结果。');
  }
}

// ------------------------------------------------------------------ tesseract

function executableCandidates() {
  const configured = String(process.env.HRBOSS_TESSERACT_PATH || '').trim();
  if (configured) return [path.resolve(configured)];
  const name = process.platform === 'win32' ? 'tesseract.exe' : 'tesseract';
  const bundled = path.join(PROJECT_ROOT, 'runtime-tools', name);
  if (process.platform === 'win32') {
    return [
      bundled,
      path.join(String(process.env.ProgramFiles || 'C:\\Program Files'), 'Tesseract-OCR', name),
      path.join(String(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'), 'Tesseract-OCR', name),
    ];
  }
  return [bundled, '/opt/homebrew/bin/tesseract', '/usr/local/bin/tesseract', '/usr/bin/tesseract'];
}

function resolveTesseract() {
  for (const candidate of executableCandidates()) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['tesseract'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 64 * 1024,
  });
  if (lookup.status !== 0) return '';
  return String(lookup.stdout || '')
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item && path.isAbsolute(item) && fs.existsSync(item)) || '';
}

// The recognition models ship beside the executable so a packaged build does
// not depend on whatever tessdata the host happens to have installed. The
// accuracy gap between the fast and best Chinese models decides whether this
// engine is usable at all, so the directory is explicit rather than inherited.
function tessdataArgs() {
  const configured = String(process.env.HRBOSS_TESSDATA_DIR || '').trim();
  const bundled = path.join(PROJECT_ROOT, 'runtime-tools', 'tessdata');
  const directory = configured || (fs.existsSync(bundled) ? bundled : '');
  return directory ? ['--tessdata-dir', directory] : [];
}

function resolveLanguages(executable) {
  const result = spawnSync(executable, [...tessdataArgs(), '--list-langs'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 256 * 1024,
  });
  const available = new Set(result.status === 0
    ? String(result.stdout || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
    : []);
  if (available.has('chi_sim') && available.has('eng')) return 'chi_sim+eng';
  if (available.has('chi_sim')) return 'chi_sim';
  if (available.has('eng')) return 'eng';
  return '';
}

// tesseract splits CJK into one "word" per glyph cluster, so rejoining with a
// space would turn 金亮 into "金 亮" and break the name matcher. Only keep a
// separator where both sides are latin.
function joinWords(words) {
  let text = '';
  for (const word of words) {
    if (!text) {
      text = word;
      continue;
    }
    const needsSpace = /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(word);
    text += needsSpace ? ` ${word}` : word;
  }
  return text;
}

function parseTsv(tsv, file) {
  const rows = String(tsv || '').split(/\r?\n/);
  if (!/^level\tpage_num\t/.test(rows[0] || '')) {
    fail('SCREENSHOT_OCR_TESSERACT_NOT_TSV', 'tesseract 未返回 TSV 结构化输出，无法定位文字位置。');
  }
  const groups = new Map();
  let width = 0;
  let height = 0;
  for (let index = 1; index < rows.length; index += 1) {
    const columns = rows[index].split('\t');
    if (columns.length < 12) continue;
    const level = Number(columns[0]);
    const left = Number(columns[6]);
    const top = Number(columns[7]);
    const boxWidth = Number(columns[8]);
    const boxHeight = Number(columns[9]);
    if (level === 1) {
      width = boxWidth;
      height = boxHeight;
      continue;
    }
    if (level !== 5) continue;
    const text = columns.slice(11).join('\t').trim();
    const confidence = Number(columns[10]);
    if (!text || !Number.isFinite(confidence) || confidence < 0) continue;
    const key = `${columns[1]}|${columns[2]}|${columns[3]}|${columns[4]}`;
    if (!groups.has(key)) groups.set(key, { words: [], confidences: [], left, top, right: left + boxWidth, bottom: top + boxHeight });
    const group = groups.get(key);
    group.words.push(text);
    group.confidences.push(confidence);
    group.left = Math.min(group.left, left);
    group.top = Math.min(group.top, top);
    group.right = Math.max(group.right, left + boxWidth);
    group.bottom = Math.max(group.bottom, top + boxHeight);
  }
  const lines = [...groups.values()]
    .map((group) => ({
      text: joinWords(group.words),
      // Word-level confidence is already continuous here, so a mean describes
      // the line without one weak glyph dominating it.
      confidence: group.confidences.reduce((sum, value) => sum + value, 0) / group.confidences.length / 100,
      left: group.left,
      top: group.top,
      width: group.right - group.left,
      height: group.bottom - group.top,
    }))
    .filter((line) => line.text)
    .sort((a, b) => (Math.abs(a.top - b.top) > 10 ? a.top - b.top : a.left - b.left));
  return { file, width, height, lines, error: null };
}

function runTesseract(files, progressFile) {
  const executable = resolveTesseract();
  if (!executable) {
    fail('SCREENSHOT_OCR_TESSERACT_UNAVAILABLE', '本机没有可用的截图识别引擎：未找到 tesseract。');
  }
  const languages = resolveLanguages(executable);
  if (!languages) {
    fail('SCREENSHOT_OCR_TESSERACT_LANG_MISSING', 'tesseract 缺少中文或英文语言包，无法识别截图。');
  }
  const psm = String(process.env.HRBOSS_TESSERACT_PSM || DEFAULT_PSM);
  const results = [];
  writeProgress(progressFile, 0, files.length);
  for (const file of files) {
    // Request TSV through the parameter rather than the `tsv` config file:
    // the config lives in <tessdata>/configs, which a bundled models-only
    // directory does not carry, and a missing config silently degrades to
    // plain text that this parser would read as zero lines.
    const args = [...tessdataArgs(), file, 'stdout', '-l', languages, '--psm', psm, '-c', 'tessedit_create_tsv=1'];
    const result = spawnSync(executable, args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
    });
    if (result.status !== 0) {
      results.push({ file, width: 0, height: 0, lines: [], error: String(result.stderr || `exit ${result.status}`).trim() });
    } else {
      results.push(parseTsv(result.stdout, file));
    }
    writeProgress(progressFile, results.length, files.length);
  }
  return results;
}

function recognizeScreenshots(files, options = {}) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) fail('SCREENSHOT_OCR_NO_INPUT', '没有可识别的截图。');
  const engine = selectedEngine();
  const progressFile = String(options.progressFile || '');
  if (engine === 'macos_vision') return runMacVision(list, progressFile);
  if (engine === 'tesseract') return runTesseract(list, progressFile);
  return fail('SCREENSHOT_OCR_ENGINE_UNKNOWN', `未知的截图识别引擎：${engine}`);
}

module.exports = {
  ScreenshotOcrError,
  joinWords,
  parseTsv,
  recognizeScreenshots,
  selectedEngine,
};
