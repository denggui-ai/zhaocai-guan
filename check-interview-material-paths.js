const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f004-'));
const MATERIAL_ROOT = path.join(TEMP_ROOT, 'controlled', 'interviews');
const OUTSIDE_ROOT = path.join(TEMP_ROOT, 'outside');
const DB_PATH = path.join(TEMP_ROOT, 'data', 'fixture.db');

process.env.HRBOSS_DATA_DIR = path.join(TEMP_ROOT, 'data');
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = MATERIAL_ROOT;
process.env.BOSS_DB_PATH = DB_PATH;
process.env.HRBOSS_EXTERNAL_AI_ENABLED = '0';

const {
  InterviewMaterialPathError,
  prepareInterviewMaterialDirectory,
  prepareInterviewMaterialFileTarget,
  readAndValidateInterviewSummary,
  readControlledTextFile,
  validateInterviewMaterialFile,
  validateInterviewRecordingPaths,
} = require('./interview-material-paths');

process.on('exit', () => fs.rmSync(TEMP_ROOT, { recursive: true, force: true }));

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writeFixture(name, overrides = {}) {
  const dir = prepareInterviewMaterialDirectory(path.join(MATERIAL_ROOT, name), { root: MATERIAL_ROOT });
  const sourcePath = write(path.join(dir, 'source.mp4'), 'synthetic-video');
  const wavPath = write(path.join(dir, 'audio.wav'), 'RIFF-synthetic-audio');
  const transcriptTxt = write(path.join(dir, 'transcript.txt'), '合成候选人转写，不含真实材料。\n');
  const transcriptSrt = write(path.join(dir, 'transcript.srt'), '1\n00:00:00,000 --> 00:00:01,000\n合成转写\n');
  const transcriptJson = write(path.join(dir, 'transcript.json'), '{"text":"合成转写"}\n');
  const codexInput = write(path.join(dir, 'codex-input.md'), '# synthetic report input\n');
  const reportPath = write(path.join(dir, 'report.json'), '{"schema_version":"synthetic"}\n');
  const summaryPath = path.join(dir, 'summary.json');
  const summary = {
    createdAt: '2026-07-11T00:00:00.000Z',
    topic: name,
    sourcePath,
    wavPath,
    transcriptTxt,
    transcriptSrt,
    transcriptJson,
    summaryPath,
    codexInput,
    reportPath,
    ...overrides,
  };
  write(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { dir, summaryPath, summary, reportPath };
}

function expectSafeError(fn, code) {
  let caught;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof InterviewMaterialPathError, `expected InterviewMaterialPathError, got ${caught}`);
  if (code) assert.equal(caught.code, code);
  assert.ok(!caught.message.includes(TEMP_ROOT), 'safe error must not expose the synthetic absolute root');
  assert.ok(!caught.message.includes(OUTSIDE_ROOT), 'safe error must not expose an outside absolute path');
  return caught;
}

function run() {
  fs.mkdirSync(OUTSIDE_ROOT, { recursive: true });
  const valid = writeFixture('valid');
  const loaded = readAndValidateInterviewSummary(valid.summaryPath, { root: MATERIAL_ROOT });
  assert.equal(loaded.path, fs.realpathSync(valid.summaryPath));
  assert.equal(loaded.summary.wavPath, fs.realpathSync(valid.summary.wavPath));
  assert.equal(readControlledTextFile(loaded.summary.transcriptTxt, 'transcript_txt', { root: MATERIAL_ROOT }).text.includes('合成候选人'), true);
  assert.equal(validateInterviewMaterialFile(valid.reportPath, 'report', { root: MATERIAL_ROOT }).path, fs.realpathSync(valid.reportPath));

  const outsideSummary = write(path.join(OUTSIDE_ROOT, 'summary.json'), '{"fixture":true}\n');
  expectSafeError(
    () => validateInterviewMaterialFile(outsideSummary, 'summary', { root: MATERIAL_ROOT }),
    'INTERVIEW_MATERIAL_OUTSIDE_ROOT',
  );
  expectSafeError(
    () => validateInterviewMaterialFile(path.join('..', '..', 'outside', 'summary.json'), 'summary', { root: MATERIAL_ROOT }),
    'INTERVIEW_MATERIAL_OUTSIDE_ROOT',
  );

  const outsideTranscript = write(path.join(OUTSIDE_ROOT, 'secret.txt'), 'synthetic outside text\n');
  const symlinkPath = path.join(MATERIAL_ROOT, 'escape.txt');
  fs.symlinkSync(outsideTranscript, symlinkPath);
  expectSafeError(
    () => validateInterviewMaterialFile(symlinkPath, 'transcript_txt', { root: MATERIAL_ROOT }),
    'INTERVIEW_MATERIAL_OUTSIDE_ROOT',
  );
  const symlinkTarget = path.join(MATERIAL_ROOT, 'write-target.txt');
  fs.symlinkSync(outsideTranscript, symlinkTarget);
  expectSafeError(
    () => prepareInterviewMaterialFileTarget(symlinkTarget, 'transcript_txt', { root: MATERIAL_ROOT }),
    'INTERVIEW_MATERIAL_SYMLINK',
  );
  const brokenSymlinkTarget = path.join(MATERIAL_ROOT, 'broken-target.txt');
  fs.symlinkSync(path.join(OUTSIDE_ROOT, 'not-created.txt'), brokenSymlinkTarget);
  expectSafeError(
    () => prepareInterviewMaterialFileTarget(brokenSymlinkTarget, 'transcript_txt', { root: MATERIAL_ROOT }),
    'INTERVIEW_MATERIAL_SYMLINK',
  );

  const wrongType = write(path.join(valid.dir, 'transcript.md'), 'wrong extension\n');
  expectSafeError(
    () => validateInterviewMaterialFile(wrongType, 'transcript_txt', { root: MATERIAL_ROOT }),
    'INTERVIEW_MATERIAL_EXTENSION_INVALID',
  );
  expectSafeError(
    () => validateInterviewMaterialFile(valid.dir, 'transcript_txt', { root: MATERIAL_ROOT }),
    'INTERVIEW_MATERIAL_NOT_FILE',
  );

  const oversized = path.join(valid.dir, 'oversized.txt');
  const descriptor = fs.openSync(oversized, 'w');
  fs.ftruncateSync(descriptor, 2_000_001);
  fs.closeSync(descriptor);
  expectSafeError(
    () => validateInterviewMaterialFile(oversized, 'transcript_txt', { root: MATERIAL_ROOT }),
    'INTERVIEW_MATERIAL_SIZE_INVALID',
  );
  expectSafeError(
    () => validateInterviewMaterialFile(path.join(valid.dir, 'missing.txt'), 'transcript_txt', { root: MATERIAL_ROOT }),
    'INTERVIEW_MATERIAL_MISSING',
  );

  const traversalSummary = writeFixture('traversal-summary', { transcriptTxt: '../../outside/secret.txt' });
  expectSafeError(
    () => readAndValidateInterviewSummary(traversalSummary.summaryPath, { root: MATERIAL_ROOT }),
    'INTERVIEW_MATERIAL_OUTSIDE_ROOT',
  );
  const aliasConfusion = writeFixture('alias-confusion', { transcript_txt_path: outsideTranscript });
  expectSafeError(
    () => readAndValidateInterviewSummary(aliasConfusion.summaryPath, { root: MATERIAL_ROOT }),
    'INTERVIEW_MATERIAL_OUTSIDE_ROOT',
  );
  const mismatch = writeFixture('mismatch');
  expectSafeError(
    () => validateInterviewRecordingPaths({
      summary_path: mismatch.summaryPath,
      transcript_txt_path: valid.summary.transcriptTxt,
    }, { root: MATERIAL_ROOT }),
    'INTERVIEW_MATERIAL_PATH_MISMATCH',
  );

  const db = require('./db');
  const database = db.openDb(DB_PATH);
  const recording = db.createInterviewRecording({
    summary_path: valid.summaryPath,
    ...valid.summary,
    raw_summary_json: valid.summary,
  });
  assert.equal(recording.summary_path, fs.realpathSync(valid.summaryPath));
  assert.equal(recording.transcript_txt_path, fs.realpathSync(valid.summary.transcriptTxt));
  assert.throws(
    () => db.createInterviewRecording({ summary_path: outsideSummary }),
    (error) => error instanceof InterviewMaterialPathError && !error.message.includes(TEMP_ROOT),
  );

  const registeredTranscript = recording.transcript_txt_path;
  fs.rmSync(registeredTranscript);
  fs.symlinkSync(outsideTranscript, registeredTranscript);
  expectSafeError(
    () => readControlledTextFile(registeredTranscript, 'transcript_txt', { root: MATERIAL_ROOT }),
    'INTERVIEW_MATERIAL_OUTSIDE_ROOT',
  );
  fs.rmSync(registeredTranscript);
  const replacedDescriptor = fs.openSync(registeredTranscript, 'w');
  fs.ftruncateSync(replacedDescriptor, 2_000_001);
  fs.closeSync(replacedDescriptor);
  expectSafeError(
    () => readControlledTextFile(registeredTranscript, 'transcript_txt', { root: MATERIAL_ROOT }),
    'INTERVIEW_MATERIAL_SIZE_INVALID',
  );
  fs.rmSync(registeredTranscript);
  expectSafeError(
    () => readControlledTextFile(registeredTranscript, 'transcript_txt', { root: MATERIAL_ROOT }),
    'INTERVIEW_MATERIAL_MISSING',
  );

  database.close();
  console.log('check-interview-material-paths: PASS');
}

run();
