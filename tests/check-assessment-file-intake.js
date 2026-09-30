const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  AssessmentFileIntakeError,
  DEFAULT_MAX_BYTES,
  stageAssessmentPdf,
} = require("../src/assessment-file-intake");

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-assessment-intake-'));
process.on('exit', () => fs.rmSync(TEMP_ROOT, { recursive: true, force: true }));

const MINIMAL_PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'ascii');

function writeFixture(relativePath, bytes) {
  const target = path.join(TEMP_ROOT, 'sources', relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
}

function freshStagingRoot(name) {
  const root = path.join(TEMP_ROOT, 'staging', name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function expectSafeError(fn, code, sourcePath = '') {
  let caught;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AssessmentFileIntakeError, `expected safe intake error, got ${caught}`);
  assert.equal(caught.code, code);
  assert.ok(!caught.message.includes(TEMP_ROOT), 'error must not expose the temporary absolute path');
  if (sourcePath) {
    assert.ok(!caught.message.includes(path.basename(sourcePath)), 'error must not expose the original filename');
    assert.ok(!caught.message.includes(sourcePath), 'error must not expose the original path');
  }
  return caught;
}

function assertEmptyDirectory(root) {
  assert.deepEqual(fs.readdirSync(root), [], 'failed intake must not leave a staged file');
}

function run() {
  assert.equal(DEFAULT_MAX_BYTES, 25 * 1024 * 1024);

  const originalName = 'synthetic-person-name-report.pdf';
  const validSource = writeFixture(originalName, MINIMAL_PDF);
  const validRoot = freshStagingRoot('valid');
  const valid = stageAssessmentPdf(validSource, { stagingRoot: validRoot });
  assert.deepEqual(Object.keys(valid).sort(), ['byte_size', 'content_sha256', 'staging_relpath', 'state']);
  assert.equal(valid.state, 'pending_scan');
  assert.equal(valid.byte_size, MINIMAL_PDF.length);
  assert.equal(valid.content_sha256, crypto.createHash('sha256').update(MINIMAL_PDF).digest('hex'));
  assert.match(valid.staging_relpath, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.pdf$/);
  assert.ok(!JSON.stringify(valid).includes(originalName), 'result must not expose the original filename');
  assert.ok(!JSON.stringify(valid).includes(validSource), 'result must not expose the original path');
  assert.deepEqual(fs.readFileSync(path.join(validRoot, valid.staging_relpath)), MINIMAL_PDF);

  const disguisedSource = writeFixture('extension-is-not-security.txt', MINIMAL_PDF);
  const disguisedRoot = freshStagingRoot('disguised');
  const disguised = stageAssessmentPdf(disguisedSource, { stagingRoot: disguisedRoot });
  assert.equal(disguised.state, 'pending_scan');
  assert.equal(disguised.content_sha256, valid.content_sha256);

  const repeatRoot = freshStagingRoot('repeat');
  const firstRepeat = stageAssessmentPdf(validSource, { stagingRoot: repeatRoot });
  const secondRepeat = stageAssessmentPdf(validSource, { stagingRoot: repeatRoot });
  assert.notEqual(firstRepeat.staging_relpath, secondRepeat.staging_relpath);
  assert.equal(firstRepeat.content_sha256, secondRepeat.content_sha256);
  assert.equal(fs.readdirSync(repeatRoot).length, 2);

  expectSafeError(
    () => stageAssessmentPdf('', { stagingRoot: freshStagingRoot('blank') }),
    'ASSESSMENT_FILE_SOURCE_REQUIRED',
  );
  expectSafeError(
    () => stageAssessmentPdf('bad\0path', { stagingRoot: freshStagingRoot('nul') }),
    'ASSESSMENT_FILE_SOURCE_REQUIRED',
  );

  const emptySource = writeFixture('empty.pdf', Buffer.alloc(0));
  expectSafeError(
    () => stageAssessmentPdf(emptySource, { stagingRoot: freshStagingRoot('empty') }),
    'ASSESSMENT_FILE_SOURCE_SIZE_INVALID',
    emptySource,
  );

  const notPdfSource = writeFixture('not-a-pdf.pdf', Buffer.from('plain synthetic bytes', 'ascii'));
  const notPdfRoot = freshStagingRoot('not-pdf');
  expectSafeError(
    () => stageAssessmentPdf(notPdfSource, { stagingRoot: notPdfRoot }),
    'ASSESSMENT_FILE_PDF_MAGIC_INVALID',
    notPdfSource,
  );
  assertEmptyDirectory(notPdfRoot);

  const oversizedSource = writeFixture('oversized.pdf', Buffer.concat([MINIMAL_PDF, Buffer.alloc(32)]));
  const oversizedRoot = freshStagingRoot('oversized');
  expectSafeError(
    () => stageAssessmentPdf(oversizedSource, { stagingRoot: oversizedRoot, maxBytes: MINIMAL_PDF.length }),
    'ASSESSMENT_FILE_SOURCE_SIZE_INVALID',
    oversizedSource,
  );
  assertEmptyDirectory(oversizedRoot);
  expectSafeError(
    () => stageAssessmentPdf(validSource, { stagingRoot: freshStagingRoot('limit-loosen'), maxBytes: DEFAULT_MAX_BYTES + 1 }),
    'ASSESSMENT_FILE_LIMIT_INVALID',
    validSource,
  );

  const directorySource = path.join(TEMP_ROOT, 'sources', 'directory-source');
  fs.mkdirSync(directorySource, { recursive: true });
  expectSafeError(
    () => stageAssessmentPdf(directorySource, { stagingRoot: freshStagingRoot('directory') }),
    'ASSESSMENT_FILE_SOURCE_NOT_FILE',
    directorySource,
  );

  const symlinkSource = path.join(TEMP_ROOT, 'sources', 'source-link.pdf');
  try {
    fs.symlinkSync(validSource, symlinkSource, 'file');
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    const junctionTarget = path.join(TEMP_ROOT, 'sources', 'junction-target');
    fs.mkdirSync(junctionTarget);
    fs.symlinkSync(junctionTarget, symlinkSource, 'junction');
  }
  expectSafeError(
    () => stageAssessmentPdf(symlinkSource, { stagingRoot: freshStagingRoot('symlink') }),
    'ASSESSMENT_FILE_SOURCE_SYMLINK',
    symlinkSource,
  );

  const realStagingTarget = freshStagingRoot('staging-root-symlink-target');
  const symlinkStagingRoot = path.join(TEMP_ROOT, 'staging', 'staging-root-link');
  let stagingRootSymlinkCovered = false;
  try {
    fs.symlinkSync(realStagingTarget, symlinkStagingRoot, 'dir');
    stagingRootSymlinkCovered = true;
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    console.log('check-assessment-file-intake: SKIP stagingRoot symlink (Windows symlink permission unavailable)');
  }
  if (stagingRootSymlinkCovered) {
    expectSafeError(
      () => stageAssessmentPdf(validSource, { stagingRoot: symlinkStagingRoot }),
      'ASSESSMENT_STAGING_ROOT_INVALID',
      validSource,
    );
    assertEmptyDirectory(realStagingTarget);
  }

  const writeFailureRoot = freshStagingRoot('write-failure');
  const originalWriteSync = fs.writeSync;
  fs.writeSync = () => {
    const error = new Error('synthetic write failure');
    error.code = 'EIO';
    throw error;
  };
  try {
    expectSafeError(
      () => stageAssessmentPdf(validSource, { stagingRoot: writeFailureRoot }),
      'ASSESSMENT_FILE_INTAKE_FAILED',
      validSource,
    );
  } finally {
    fs.writeSync = originalWriteSync;
  }
  assertEmptyDirectory(writeFailureRoot);

  const validationFailureRoot = freshStagingRoot('validation-failure');
  const originalFstatSync = fs.fstatSync;
  let fstatCalls = 0;
  fs.fstatSync = (...args) => {
    const stat = originalFstatSync(...args);
    fstatCalls += 1;
    if (fstatCalls !== 2) return stat;
    return new Proxy(stat, {
      get(target, property) {
        if (property === 'size') return target.size + 1;
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  try {
    expectSafeError(
      () => stageAssessmentPdf(validSource, { stagingRoot: validationFailureRoot }),
      'ASSESSMENT_FILE_SOURCE_CHANGED',
      validSource,
    );
  } finally {
    fs.fstatSync = originalFstatSync;
  }
  assertEmptyDirectory(validationFailureRoot);

  console.log('check-assessment-file-intake: PASS');
}

try {
  run();
} finally {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
}
