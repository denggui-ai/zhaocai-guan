'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  AssessmentControlledStoreError,
  MIN_ORPHAN_GRACE_MS,
  WINDOWS_REPARSE_RELEASE_GATE,
  collectAssessmentOrphans,
  confirmAssessmentBlobReference,
  importAssessmentPdf: rawImportAssessmentPdf,
  reconcileAssessmentOrphans,
} = require('./assessment-controlled-store');

function importAssessmentPdf(sourcePath, options = {}) {
  if (process.platform === 'darwin') return rawImportAssessmentPdf(sourcePath, options);
  return rawImportAssessmentPdf(sourcePath, {
    ...options,
    parserRunner: (executablePath, args, runnerOptions) => {
      const child = spawn(executablePath, args, {
        cwd: runnerOptions.workingDirectory,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { child, finish: () => null };
    },
  });
}

function minimalPdf(extra = '') {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let pdf = `%PDF-1.4\n${extra}`;
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

function executable(directory, name, body) {
  const target = path.join(directory, name);
  fs.writeFileSync(target, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  fs.chmodSync(target, 0o700);
  return target;
}

async function expectCode(promise, code, forbidden = []) {
  let caught;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught, `expected ${code}`);
  assert.strictEqual(caught.code, code, caught.stack);
  for (const token of forbidden) assert.strictEqual(caught.message.includes(token), false);
  return caught;
}

function privateDataRoot(root, name) {
  const target = path.join(root, name);
  fs.mkdirSync(target, { mode: 0o700 });
  return target;
}

async function run() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-assessment-store-'));
  const sourceRoot = path.join(temporaryRoot, 'sources');
  const toolsRoot = path.join(temporaryRoot, 'tools');
  fs.mkdirSync(sourceRoot, { mode: 0o700 });
  fs.mkdirSync(toolsRoot, { mode: 0o700 });

  const pdfinfo = executable(toolsRoot, 'pdfinfo', `
    if (process.argv[2] === '-js') process.exit(0);
    process.stdout.write('Pages: 1\\nEncrypted: no\\nJavaScript: no\\nPDF version: 1.4\\n');
  `);
  const encryptedPdfinfo = executable(toolsRoot, 'pdfinfo-encrypted', `
    if (process.argv[2] === '-js') process.exit(0);
    process.stdout.write('Pages: 1\\nEncrypted: yes (print:no)\\nJavaScript: no\\nPDF version: 1.4\\n');
  `);
  const javascriptPdfinfo = executable(toolsRoot, 'pdfinfo-javascript', `
    if (process.argv[2] === '-js') process.stdout.write('synthetic script marker');
    else process.stdout.write('Pages: 1\\nEncrypted: no\\nJavaScript: no\\nPDF version: 1.4\\n');
  `);
  const pdftoppm = executable(toolsRoot, 'pdftoppm', `
    const fs = require('fs');
    const prefix = process.argv[process.argv.length - 1];
    fs.writeFileSync(prefix + '-1.png', Buffer.from([137,80,78,71,13,10,26,10,1]));
  `);

  try {
    assert.strictEqual(WINDOWS_REPARSE_RELEASE_GATE, 'external_windows_validation_required');
    if (process.platform === 'win32') {
      console.log('SKIP Windows controlled-store runtime (external reparse validation required)');
      return;
    }
    console.log('SKIP Windows reparse runtime gate (external Windows validation required)');

    const dataRoot = privateDataRoot(temporaryRoot, 'private-data');
    const originalName = 'SYNTHETIC PERSON NAME assessment.pdf';
    const source = path.join(sourceRoot, originalName);
    const bytes = minimalPdf();
    fs.writeFileSync(source, bytes, { mode: 0o600 });
    let commits = 0;
    const stored = await importAssessmentPdf(source, {
      dataRoot,
      pdfinfoExecutablePath: pdfinfo,
      pdftoppmExecutablePath: pdftoppm,
      scanTimeoutMs: 5000,
      renderTimeoutMs: 5000,
      commitDocument: (record) => {
        commits += 1;
        assert.strictEqual(record.state, 'stored_pending_reference');
        assert.strictEqual(record.original_viewer_enabled, false);
      },
    });
    const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex');
    assert.strictEqual(stored.state, 'stored_referenced');
    assert.strictEqual(stored.content_sha256, expectedHash);
    assert.strictEqual(stored.page_count, 1);
    assert.strictEqual(stored.original_viewer_enabled, false);
    assert.match(stored.storage_relpath, new RegExp(`^accepted\\${path.sep}sha256\\${path.sep}${expectedHash.slice(0, 2)}\\${path.sep}${expectedHash}\\.pdf$`));
    assert.strictEqual(JSON.stringify(stored).includes(originalName), false);
    assert.strictEqual(JSON.stringify(stored).includes(source), false);
    const storedFile = path.join(dataRoot, 'assessment', stored.storage_relpath);
    assert.deepStrictEqual(fs.readFileSync(storedFile), bytes);
    assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(storedFile)).digest('hex'), expectedHash);
    assert.strictEqual(fs.existsSync(path.join(dataRoot, 'assessment', 'orphans', `${expectedHash}.json`)), false);

    let duplicateEvents = 0;
    const duplicate = await importAssessmentPdf(source, {
      dataRoot,
      pdfinfoExecutablePath: pdfinfo,
      pdftoppmExecutablePath: pdftoppm,
      commitDocument: () => { commits += 1; },
      onDuplicate: (record) => {
        duplicateEvents += 1;
        assert.strictEqual(record.state, 'duplicate_seen');
        assert.strictEqual(record.content_sha256, expectedHash);
        assert.strictEqual(record.byte_size, bytes.length);
        assert.strictEqual(record.page_count, 1);
        assert.strictEqual(record.storage_relpath, stored.storage_relpath);
        assert.strictEqual(record.preview_relpath, stored.preview_relpath);
      },
    });
    assert.deepStrictEqual(duplicate, {
      state: 'duplicate_seen',
      duplicate: true,
      content_sha256: expectedHash,
      byte_size: bytes.length,
      page_count: 1,
    });
    assert.strictEqual(commits, 1, 'duplicate must only prompt and must not auto-create a reference');
    assert.strictEqual(duplicateEvents, 1, 'duplicate must offer a server-owned duplicate_seen event callback');
    await expectCode(importAssessmentPdf(source, {
      dataRoot,
      pdfinfoExecutablePath: pdfinfo,
      pdftoppmExecutablePath: pdftoppm,
      onDuplicate: () => { throw new Error('synthetic event transaction failure'); },
    }), 'ASSESSMENT_STORE_DUPLICATE_RECORD_FAILED', [temporaryRoot, originalName]);
    assert.deepStrictEqual(fs.readFileSync(storedFile), bytes, 'duplicate event failure must not alter the existing blob');
    assert.deepStrictEqual(fs.readdirSync(path.join(dataRoot, 'assessment', 'staging')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(dataRoot, 'assessment', 'preview-work')), []);

    const pendingSource = path.join(sourceRoot, 'pending.pdf');
    const pendingBytes = minimalPdf('% pending-reference\n');
    fs.writeFileSync(pendingSource, pendingBytes);
    const pending = await importAssessmentPdf(pendingSource, {
      dataRoot, pdfinfoExecutablePath: pdfinfo, pdftoppmExecutablePath: pdftoppm,
    });
    assert.strictEqual(pending.state, 'stored_pending_reference');
    const pendingMarker = path.join(dataRoot, 'assessment', 'orphans', `${pending.content_sha256}.json`);
    assert.strictEqual(fs.existsSync(pendingMarker), true);
    assert.deepStrictEqual(collectAssessmentOrphans({
      dataRoot,
      referencedHashes: [],
      graceMs: MIN_ORPHAN_GRACE_MS,
      nowMs: fs.lstatSync(pendingMarker).mtimeMs + MIN_ORPHAN_GRACE_MS - 1,
    }), { state: 'orphan_gc_complete', removed: 0, retained: 1, reconciled: 0 });
    assert.deepStrictEqual(reconcileAssessmentOrphans({
      database: { prepare: () => ({ all: () => [{ content_sha256: pending.content_sha256 }] }) },
      dataRoot,
      graceMs: MIN_ORPHAN_GRACE_MS,
    }), { state: 'orphan_gc_complete', removed: 0, retained: 0, reconciled: 1 });
    assert.deepStrictEqual(confirmAssessmentBlobReference(dataRoot, pending.content_sha256), {
      state: 'referenced', content_sha256: pending.content_sha256,
    });
    assert.strictEqual(fs.existsSync(pendingMarker), false);

    const failedSource = path.join(sourceRoot, 'commit-failed.pdf');
    fs.writeFileSync(failedSource, minimalPdf('% failed-reference\n'));
    const failedHash = crypto.createHash('sha256').update(fs.readFileSync(failedSource)).digest('hex');
    await expectCode(importAssessmentPdf(failedSource, {
      dataRoot, pdfinfoExecutablePath: pdfinfo, pdftoppmExecutablePath: pdftoppm,
      commitDocument: () => { throw new Error('synthetic DB failure'); },
    }), 'ASSESSMENT_STORE_REFERENCE_COMMIT_FAILED', [temporaryRoot, originalName]);
    const failedMarker = path.join(dataRoot, 'assessment', 'orphans', `${failedHash}.json`);
    assert.strictEqual(fs.existsSync(failedMarker), true, 'DB failure must leave a delayed orphan marker');
    const old = new Date(Date.now() - MIN_ORPHAN_GRACE_MS - 1000);
    fs.utimesSync(failedMarker, old, old);
    assert.deepStrictEqual(collectAssessmentOrphans({
      dataRoot, referencedHashes: [], graceMs: MIN_ORPHAN_GRACE_MS, nowMs: Date.now(),
    }), { state: 'orphan_gc_complete', removed: 1, retained: 0, reconciled: 0 });
    assert.strictEqual(fs.existsSync(failedMarker), false);

    const changedAfterCommitSource = path.join(sourceRoot, 'changed-after-commit.pdf');
    const changedAfterCommitBytes = minimalPdf('% changed-after-commit\n');
    fs.writeFileSync(changedAfterCommitSource, changedAfterCommitBytes);
    const changedAfterCommitHash = crypto.createHash('sha256').update(changedAfterCommitBytes).digest('hex');
    await expectCode(importAssessmentPdf(changedAfterCommitSource, {
      dataRoot, pdfinfoExecutablePath: pdfinfo, pdftoppmExecutablePath: pdftoppm,
      commitDocument: (record) => {
        fs.appendFileSync(path.join(dataRoot, 'assessment', record.storage_relpath), 'mutated');
      },
    }), 'ASSESSMENT_STORE_BLOB_INVALID', [temporaryRoot, 'changed-after-commit.pdf']);
    const changedMarker = path.join(dataRoot, 'assessment', 'orphans', `${changedAfterCommitHash}.json`);
    assert.strictEqual(fs.existsSync(changedMarker), true, 'post-commit verification failure must retain orphan compensation');
    const changedOld = new Date(Date.now() - MIN_ORPHAN_GRACE_MS - 1000);
    fs.utimesSync(changedMarker, changedOld, changedOld);
    assert.strictEqual(collectAssessmentOrphans({
      dataRoot, referencedHashes: [], graceMs: MIN_ORPHAN_GRACE_MS, nowMs: Date.now(),
    }).removed, 1);

    for (const [name, marker] of [
      ['literal-open-action.pdf', '/OpenAction 5 0 R\n'],
      ['literal-rendition.pdf', '/Rendition 5 0 R\n'],
      ['compressed-three-d-bytes.pdf', '/Subtype /3D\n'],
      ['literal-screen.pdf', '/Subtype /Screen\n'],
      ['literal-action-name.pdf', '/S /SyntheticAction\n'],
      ['object-stream-name.pdf', '/ObjStm\n'],
      ['escaped-name.pdf', '/Java#53cript\n'],
    ]) {
      const sourceWithRawToken = path.join(sourceRoot, name);
      fs.writeFileSync(sourceWithRawToken, minimalPdf(marker));
      const accepted = await importAssessmentPdf(sourceWithRawToken, {
        dataRoot, pdfinfoExecutablePath: pdfinfo, pdftoppmExecutablePath: pdftoppm,
      });
      assert.strictEqual(accepted.state, 'stored_pending_reference', 'raw compressed bytes must not override structural parser results');
    }

    const encryptedSource = path.join(sourceRoot, 'encrypted.pdf');
    fs.writeFileSync(encryptedSource, minimalPdf('% encrypted synthetic\n'));
    await expectCode(importAssessmentPdf(encryptedSource, {
      dataRoot, pdfinfoExecutablePath: encryptedPdfinfo, pdftoppmExecutablePath: pdftoppm,
    }), 'ASSESSMENT_PDF_PROBE_ENCRYPTED', [temporaryRoot, 'encrypted.pdf']);
    const javascriptSource = path.join(sourceRoot, 'javascript.pdf');
    fs.writeFileSync(javascriptSource, minimalPdf('% javascript tool signal\n'));
    await expectCode(importAssessmentPdf(javascriptSource, {
      dataRoot, pdfinfoExecutablePath: javascriptPdfinfo, pdftoppmExecutablePath: pdftoppm,
    }), 'ASSESSMENT_PDF_PROBE_JAVASCRIPT', [temporaryRoot, 'synthetic script marker']);
    assert.deepStrictEqual(fs.readdirSync(path.join(dataRoot, 'assessment', 'staging')), []);
    assert.deepStrictEqual(fs.readdirSync(path.join(dataRoot, 'assessment', 'preview-work')), []);

    const quotaRoot = privateDataRoot(temporaryRoot, 'quota-data');
    const fill = path.join(quotaRoot, 'assessment', 'accepted', 'fill.bin');
    fs.mkdirSync(path.dirname(fill), { recursive: true });
    fs.closeSync(fs.openSync(fill, 'w'));
    fs.truncateSync(fill, 25 * 1024 * 1024 + 1);
    await expectCode(importAssessmentPdf(source, {
      dataRoot: quotaRoot,
      quotaBytes: 25 * 1024 * 1024,
      pdfinfoExecutablePath: pdfinfo,
      pdftoppmExecutablePath: pdftoppm,
    }), 'ASSESSMENT_STORE_QUOTA_EXCEEDED', [temporaryRoot, originalName]);

    console.log('check-assessment-controlled-store: PASS');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
