'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

class WindowsAssessmentGuardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WindowsAssessmentGuardError';
    this.code = code;
  }
}

function fail(code) {
  throw new WindowsAssessmentGuardError(code, 'Assessment Windows 路径门禁未通过。');
}

function defaultReparseProbe(target, options = {}) {
  const spawnSyncProcess = options.spawnSyncProcess || spawnSync;
  let result;
  try {
    result = spawnSyncProcess('fsutil.exe', ['reparsepoint', 'query', target], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    fail('ASSESSMENT_WINDOWS_REPARSE_GATE_UNAVAILABLE');
  }
  result = result || {};
  if (result.error || !Number.isInteger(result.status)) fail('ASSESSMENT_WINDOWS_REPARSE_GATE_UNAVAILABLE');
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  fail('ASSESSMENT_WINDOWS_REPARSE_GATE_UNAVAILABLE');
}

function normalizeLocalWindowsPath(value) {
  const raw = String(value || '');
  if (!raw || raw.includes('\0') || !path.win32.isAbsolute(raw) || /^\\\\/.test(raw)) {
    fail('ASSESSMENT_WINDOWS_PATH_UNSAFE');
  }
  const normalized = path.win32.normalize(raw);
  if (!/^[A-Za-z]:\\/.test(normalized) || normalized.slice(2).includes(':')) {
    fail('ASSESSMENT_WINDOWS_PATH_UNSAFE');
  }
  return normalized;
}

function ancestors(target) {
  const root = path.win32.parse(target).root;
  const relative = path.win32.relative(root, target);
  const items = [root];
  let current = root;
  for (const segment of relative.split(path.win32.sep).filter(Boolean)) {
    current = path.win32.join(current, segment);
    items.push(current);
  }
  return items;
}

function assertWindowsPathEntrySafe(target, expectedType, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const reparseProbe = options.reparseProbe || ((item) => defaultReparseProbe(item, options));
  let stat;
  try { stat = fileSystem.lstatSync(target); } catch { fail('ASSESSMENT_WINDOWS_PATH_UNSAFE'); }
  if (stat.isSymbolicLink() || reparseProbe(target)) fail('ASSESSMENT_WINDOWS_REPARSE_POINT_BLOCKED');
  if (expectedType === 'file' && !stat.isFile()) fail('ASSESSMENT_WINDOWS_PATH_UNSAFE');
  if (expectedType === 'directory' && !stat.isDirectory()) fail('ASSESSMENT_WINDOWS_PATH_UNSAFE');
  return true;
}

function inspectPath(target, expectedType, options) {
  const chain = ancestors(target);
  chain.forEach((item, index) => {
    assertWindowsPathEntrySafe(
      item,
      index < chain.length - 1 ? 'directory' : expectedType,
      options,
    );
  });
}

function assertWindowsAssessmentPathSafe(input = {}, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const reparseProbe = options.reparseProbe || ((target) => defaultReparseProbe(target, options));
  const sourcePath = normalizeLocalWindowsPath(input.sourcePath);
  const assessmentRoot = normalizeLocalWindowsPath(input.assessmentRoot);
  inspectPath(sourcePath, 'file', { fileSystem, reparseProbe });
  inspectPath(assessmentRoot, 'directory', { fileSystem, reparseProbe });
  return true;
}

module.exports = {
  WindowsAssessmentGuardError,
  assertWindowsPathEntrySafe,
  assertWindowsAssessmentPathSafe,
  defaultReparseProbe,
  normalizeLocalWindowsPath,
};
