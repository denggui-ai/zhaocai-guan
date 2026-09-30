
const { PROJECT_ROOT } = require("./paths");
const fs = require('fs');
const path = require('path');
const { writePrivateFile } = require('./secure-fs');

const FILE = process.env.BOSS_SCREENSHOT_IMPORT_PROGRESS_FILE || path.join(PROJECT_ROOT, 'data', 'screenshot-import-progress.json');
// Written by the recognizer itself, one update per page. The import driver is
// blocked in spawnSync while that runs, so this is the only channel that can
// report page-level progress before the OCR stage ends.
const OCR_FILE = process.env.BOSS_SCREENSHOT_IMPORT_OCR_PROGRESS_FILE || path.join(PROJECT_ROOT, 'data', 'screenshot-import-ocr-progress.json');

function nowIso() {
  return new Date().toISOString();
}

function readProgress() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { status: 'idle' };
  }
}

function writeProgress(progress) {
  const next = { ...progress, updated_at: nowIso() };
  writePrivateFile(FILE, JSON.stringify(next, null, 2));
  return next;
}

function patchProgress(patch) {
  return writeProgress({ ...readProgress(), ...patch });
}

function readOcrProgress() {
  try {
    const parsed = JSON.parse(fs.readFileSync(OCR_FILE, 'utf8'));
    const done = Number(parsed && parsed.done);
    const total = Number(parsed && parsed.total);
    if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
    return { done: Math.max(0, Math.min(done, total)), total };
  } catch {
    return null;
  }
}

module.exports = {
  FILE,
  OCR_FILE,
  readProgress,
  readOcrProgress,
  writeProgress,
  patchProgress,
};
