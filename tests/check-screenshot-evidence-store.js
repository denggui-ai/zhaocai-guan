
const { PROJECT_ROOT } = require("../src/paths");
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  abortEvidenceBatch,
  beginEvidenceBatch,
  commitEvidenceBatch,
  sha256File,
  verifyManifest,
} = require("../src/screenshot-evidence-store");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'screenshot-evidence-check-'));
const dataDir = path.join(tmp, 'controlled-data');
const sourceDir = path.join(tmp, 'outside-source');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(sourceDir, { recursive: true });
process.env.HRBOSS_DATA_DIR = dataDir;
process.env.BOSS_DB_PATH = path.join(tmp, 'synthetic-import.db');
const db = require("../src/db");
const { confirmScreenshotOcrDraft, editScreenshotOcrDraft, ingestScreenshotDrafts } = require("../src/ingest-screenshot-drafts");
const { resolvePythonForStitching } = require("../src/start-screenshot-import");

// Windows keeps the SQLite handle open until the process is gone, so the
// temp tree cannot always be removed here. Losing a temp directory is not
// a reason to fail a check.
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

function writeSyntheticBatch(batch, draftId, sourceFile, imageBytes) {
  assert.equal(batch.state, 'staging');
  fs.writeFileSync(batch.draftsPath, JSON.stringify({
    source_dir: sourceDir,
    image_count: 1,
    detail_draft_count: 1,
    drafts: [{
      draft_id: draftId,
      name: `合成候选人-${draftId}`,
      files: [sourceFile],
      facts: {},
      field_evidence: {},
      ocr_text: '',
    }],
  }));
  fs.writeFileSync(batch.ocrPath, '[]');
  const imageName = `${draftId}.jpg`;
  const imagePath = path.join(batch.stitchedDir, imageName);
  fs.writeFileSync(imagePath, imageBytes);
  fs.writeFileSync(batch.stitchedIndexPath, JSON.stringify({
    count: 1,
    rows: [{
      draft_id: draftId,
      stitched_file: path.posix.join(batch.storedDerivedPrefix, imageName),
    }],
  }));
  fs.writeFileSync(batch.indexMarkdownPath, '# synthetic screenshot evidence\n');
  return imagePath;
}

function assertNoAbsoluteStrings(value) {
  if (Array.isArray(value)) return value.forEach(assertNoAbsoluteStrings);
  if (value && typeof value === 'object') return Object.values(value).forEach(assertNoAbsoluteStrings);
  if (typeof value === 'string') {
    assert.ok(!path.isAbsolute(value), `manifest contains POSIX absolute path: ${value}`);
    assert.ok(!path.win32.isAbsolute(value), `manifest contains Windows absolute path: ${value}`);
    assert.ok(!value.includes(sourceDir), 'manifest must not expose the external source directory');
  }
}

const sourceA = path.join(sourceDir, 'batch-a.png');
const sourceB = path.join(sourceDir, 'batch-b.png');
const sourceC = path.join(sourceDir, 'batch-c.png');
fs.writeFileSync(sourceA, Buffer.from('synthetic-source-a'));
fs.writeFileSync(sourceB, Buffer.from('synthetic-source-b'));
fs.writeFileSync(sourceC, Buffer.from('synthetic-source-c'));

let batchA = beginEvidenceBatch({ dataDir, sourceFiles: [sourceA] });
writeSyntheticBatch(batchA, 'draft-a', sourceA, Buffer.from('derived-a'));
batchA = commitEvidenceBatch(batchA);
const batchAImage = path.join(batchA.batchDir, 'derived', 'draft-a.jpg');
const batchAImageHash = sha256File(batchAImage);
const batchAManifestHash = sha256File(batchA.manifestPath);

let batchB = beginEvidenceBatch({ dataDir, sourceFiles: [sourceB] });
writeSyntheticBatch(batchB, 'draft-b', sourceB, Buffer.from('derived-b'));
batchB = commitEvidenceBatch(batchB);

db.openDb(process.env.BOSS_DB_PATH);
const importedA = ingestScreenshotDrafts({
  draftsPath: batchA.draftsPath,
  stitchedIndexPath: batchA.stitchedIndexPath,
  ocrPath: batchA.ocrPath,
  manifestPath: batchA.manifestPath,
  importedAt: '2026-07-11T01:00:00.000Z',
});
assert.equal(importedA.inserted, 0, 'F-002 staging must not insert official candidate facts');
editScreenshotOcrDraft(importedA.rows[0].id, {
  changes: { name: '合成人工校对A' },
  actor: 'F-001合成回归HR',
  at: '2026-07-11T01:00:20.000Z',
});
const confirmedA = confirmScreenshotOcrDraft(importedA.rows[0].id, {
  actor: 'F-001合成回归HR',
  at: '2026-07-11T01:00:30.000Z',
});
const firstCandidateId = confirmedA.candidate_id;
const firstResolvedBeforeBatchB = db.resolveCandidateScreenshot(firstCandidateId);
assert.ok(firstResolvedBeforeBatchB, 'first batch evidence must resolve after the first synthetic import');
const importedB = ingestScreenshotDrafts({
  draftsPath: batchB.draftsPath,
  stitchedIndexPath: batchB.stitchedIndexPath,
  ocrPath: batchB.ocrPath,
  manifestPath: batchB.manifestPath,
  importedAt: '2026-07-11T01:01:00.000Z',
});
assert.equal(importedB.inserted, 0);
editScreenshotOcrDraft(importedB.rows[0].id, {
  changes: { name: '合成人工校对B' },
  actor: 'F-001合成回归HR',
  at: '2026-07-11T01:01:20.000Z',
});
confirmScreenshotOcrDraft(importedB.rows[0].id, {
  actor: 'F-001合成回归HR',
  at: '2026-07-11T01:01:30.000Z',
});
const firstResolvedAfterBatchB = db.resolveCandidateScreenshot(firstCandidateId);
assert.ok(firstResolvedAfterBatchB, 'second synthetic import must not break the first database evidence reference');
assert.equal(firstResolvedAfterBatchB.path, firstResolvedBeforeBatchB.path);

assert.ok(fs.existsSync(batchAImage), 'second batch must not delete the first batch evidence');
assert.equal(sha256File(batchAImage), batchAImageHash, 'first batch evidence hash must remain unchanged');
assert.equal(sha256File(batchA.manifestPath), batchAManifestHash, 'first batch manifest must remain unchanged');
assert.notEqual(batchA.batchId, batchB.batchId, 'different content must have different batch ids');

const batchARerun = beginEvidenceBatch({ dataDir, sourceFiles: [sourceA] });
assert.equal(batchARerun.state, 'committed', 'same content rerun must reuse the committed batch');
assert.equal(batchARerun.batchId, batchA.batchId);
assert.equal(sha256File(batchARerun.manifestPath), batchAManifestHash);
const renamedSourceA = path.join(sourceDir, 'renamed-batch-a.png');
fs.copyFileSync(sourceA, renamedSourceA);
const renamedRerun = beginEvidenceBatch({ dataDir, sourceFiles: [renamedSourceA] });
assert.equal(renamedRerun.batchId, batchA.batchId, 'batch identity must be content-addressed, not path-addressed');
assert.equal(sha256File(renamedRerun.manifestPath), batchAManifestHash);
const scopedRetryBatch = beginEvidenceBatch({
  dataDir,
  sourceFiles: [sourceA],
  batchScope: 'retry.synthetic-run.aaaaaaaaaaaaaaaaaaaaaaaa',
});
assert.notEqual(scopedRetryBatch.batchId, batchA.batchId, '重试合并草稿必须保留同一源图但使用新的受控证据批次');
abortEvidenceBatch(scopedRetryBatch);

const batchC = beginEvidenceBatch({ dataDir, sourceFiles: [sourceC] });
fs.writeFileSync(batchC.draftsPath, '{"synthetic":"failure-before-commit"}');
abortEvidenceBatch(batchC);
assert.ok(fs.existsSync(batchAImage), 'aborting a staging batch must not delete committed batch A');
assert.ok(fs.existsSync(batchB.manifestPath), 'aborting a staging batch must not delete committed batch B');

abortEvidenceBatch(batchB);
assert.ok(fs.existsSync(batchB.manifestPath), 'failure after commit must not delete the committed batch');

assertNoAbsoluteStrings(batchA.manifest);
assertNoAbsoluteStrings(batchB.manifest);
verifyManifest(dataDir, batchA.manifest, batchA.batchId);
verifyManifest(dataDir, batchB.manifest, batchB.batchId);
assert.equal(batchA.manifest.derived[0].derived_sha256, batchAImageHash);
assert.equal(batchA.manifest.sources[0].source_sha256, sha256File(sourceA));

const committedDirs = fs.readdirSync(path.join(dataDir, 'import', 'screenshot-evidence', 'batches'));
assert.deepEqual(committedDirs.sort(), [batchA.batchId, batchB.batchId].sort(), 'only two committed content batches should exist');

const stitchSource = path.join(tmp, 'stitch-source.ppm');
const stitchDrafts = path.join(tmp, 'stitch-drafts.json');
const stitchOut = path.join(tmp, 'stitch-output');
const storedPrefix = path.posix.join('import', 'screenshot-evidence', 'batches', `sha256-${'d'.repeat(64)}`, 'derived');
fs.writeFileSync(stitchSource, Buffer.concat([Buffer.from('P6\n1 1\n255\n'), Buffer.from([255, 255, 255])]));
fs.writeFileSync(stitchDrafts, JSON.stringify({
  drafts: [{ draft_id: 'stitch-check', name: '合成样本', files: [stitchSource], facts: {} }],
}));
const python = resolvePythonForStitching();
if (python.ok) {
  const stitch = spawnSync(python.command, [
    ...python.args,
    path.join(PROJECT_ROOT, "native/stitch-screenshot-drafts.py"),
    `--drafts=${stitchDrafts}`,
    `--out-dir=${stitchOut}`,
    `--stored-prefix=${storedPrefix}`,
  ], { encoding: 'utf8' });
  assert.equal(stitch.status, 0, stitch.stderr || stitch.stdout);
  const stitchedIndex = JSON.parse(fs.readFileSync(path.join(stitchOut, 'index.json'), 'utf8'));
  assert.ok(stitchedIndex.rows[0].stitched_file.startsWith(`${storedPrefix}/`));
  assert.ok(!path.isAbsolute(stitchedIndex.rows[0].stitched_file));
} else {
  console.log(`SKIP screenshot stitch subprocess (Python/Pillow unavailable): ${python.rejected.join('; ')}`);
}

console.log('check-screenshot-evidence-store ok');
