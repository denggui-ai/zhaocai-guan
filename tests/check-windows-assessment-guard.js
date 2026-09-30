'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertWindowsAssessmentPathSafe,
  defaultReparseProbe,
  normalizeLocalWindowsPath,
} = require("../src/windows-assessment-guard");

function stat(type, symbolic = false) {
  return {
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
    isSymbolicLink: () => symbolic,
  };
}

const source = 'C:\\Users\\HR\\synthetic-assessment.pdf';
const assessmentRoot = 'C:\\HRBOSS\\data\\assessment';
const directories = new Set([
  'C:\\', 'C:\\Users', 'C:\\Users\\HR', 'C:\\HRBOSS', 'C:\\HRBOSS\\data', assessmentRoot,
]);
const fileSystem = {
  lstatSync(target) {
    if (target === source) return stat('file');
    if (directories.has(target)) return stat('directory');
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  },
};

assert.equal(assertWindowsAssessmentPathSafe(
  { sourcePath: source, assessmentRoot },
  { fileSystem, reparseProbe: () => false },
), true);
assert.equal(normalizeLocalWindowsPath(source), source);
assert.throws(
  () => assertWindowsAssessmentPathSafe(
    { sourcePath: source, assessmentRoot },
    { fileSystem, reparseProbe: (target) => target === 'C:\\Users\\HR' },
  ),
  (error) => error.code === 'ASSESSMENT_WINDOWS_REPARSE_POINT_BLOCKED',
);
assert.throws(
  () => normalizeLocalWindowsPath('\\\\server\\share\\assessment.pdf'),
  (error) => error.code === 'ASSESSMENT_WINDOWS_PATH_UNSAFE',
);
assert.throws(
  () => normalizeLocalWindowsPath('C:\\Users\\HR\\assessment.pdf:secret'),
  (error) => error.code === 'ASSESSMENT_WINDOWS_PATH_UNSAFE',
);
assert.throws(
  () => normalizeLocalWindowsPath('C:relative\\assessment.pdf'),
  (error) => error.code === 'ASSESSMENT_WINDOWS_PATH_UNSAFE',
);
assert.throws(
  () => normalizeLocalWindowsPath('//server/share/assessment.pdf'),
  (error) => error.code === 'ASSESSMENT_WINDOWS_PATH_UNSAFE',
);
assert.throws(
  () => assertWindowsAssessmentPathSafe(
    { sourcePath: source, assessmentRoot },
    {
      fileSystem: {
        ...fileSystem,
        lstatSync(target) {
          if (target === source) return stat('file', true);
          return fileSystem.lstatSync(target);
        },
      },
      reparseProbe: () => false,
    },
  ),
  (error) => error.code === 'ASSESSMENT_WINDOWS_REPARSE_POINT_BLOCKED',
);

let fsutilInvocation = null;
assert.equal(defaultReparseProbe(source, {
  spawnSyncProcess(command, args, options) {
    fsutilInvocation = { command, args, options };
    return { status: 0, signal: null, error: null };
  },
}), true);
assert.equal(fsutilInvocation.command, 'fsutil.exe');
assert.deepEqual(fsutilInvocation.args, ['reparsepoint', 'query', source]);
assert.equal(fsutilInvocation.options.timeout, 3000);
assert.equal(defaultReparseProbe(source, {
  spawnSyncProcess: () => ({ status: 1, signal: null, error: null }),
}), false);
for (const result of [
  { status: 2, signal: null, error: null },
  { status: null, signal: 'SIGTERM', error: null },
  { status: null, signal: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }) },
]) {
  assert.throws(
    () => defaultReparseProbe(source, { spawnSyncProcess: () => result }),
    (error) => error.code === 'ASSESSMENT_WINDOWS_REPARSE_GATE_UNAVAILABLE',
  );
}
assert.throws(
  () => defaultReparseProbe(source, {
    spawnSyncProcess() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }),
  (error) => error.code === 'ASSESSMENT_WINDOWS_REPARSE_GATE_UNAVAILABLE',
);

if (process.platform === 'win32') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-windows-guard-'));
  try {
    const controlledRoot = path.join(root, 'assessment');
    const sourcePath = path.join(root, 'source.pdf');
    fs.mkdirSync(controlledRoot, { mode: 0o700 });
    fs.writeFileSync(sourcePath, '%PDF-1.4\nsynthetic only\n%%EOF\n', { mode: 0o600 });
    assert.equal(assertWindowsAssessmentPathSafe({ sourcePath, assessmentRoot: controlledRoot }), true);

    const junction = path.join(root, 'assessment-junction');
    fs.symlinkSync(controlledRoot, junction, 'junction');
    assert.equal(defaultReparseProbe(junction), true);
    assert.throws(
      () => assertWindowsAssessmentPathSafe({ sourcePath, assessmentRoot: junction }),
      (error) => error.code === 'ASSESSMENT_WINDOWS_REPARSE_POINT_BLOCKED',
    );
    console.log('check-windows-assessment-guard: Windows real fsutil/junction checks PASS');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('check-windows-assessment-guard ok');
