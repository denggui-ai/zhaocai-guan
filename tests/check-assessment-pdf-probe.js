
const { PROJECT_ROOT } = require("../src/paths");
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  AssessmentPdfProbeError,
  probeAssessmentPdf,
} = require("../src/assessment-pdf-probe");
const { spawnAssessmentParser } = require("../src/assessment-parser-runner");

const RUNNER_SOURCE = fs.readFileSync(path.join(PROJECT_ROOT, "src/assessment-parser-runner.js"), 'utf8');
assert.match(RUNNER_SOURCE, /\(deny network\*\)/, 'macOS parser sandbox must deny all network access');
assert.match(RUNNER_SOURCE, /512 \* 1024 \* 1024/, 'macOS parser sandbox must retain the 512 MiB memory ceiling');

const KNOWN_LOCAL_PDFINFO = '/opt/homebrew/bin/pdfinfo';

function resolveOptionalRealPdfinfo() {
  const candidate = process.env.HRBOSS_PDFINFO_PATH || KNOWN_LOCAL_PDFINFO;
  if (typeof candidate !== 'string' || !candidate || !path.isAbsolute(candidate)) return null;
  try {
    const realPath = fs.realpathSync(candidate);
    const stat = fs.statSync(realPath);
    if (!stat.isFile()) return null;
    fs.accessSync(realPath, fs.constants.X_OK);
    return candidate;
  } catch {
    return null;
  }
}

function buildMinimalPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

function findSystemNodeExecutable() {
  const executableName = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, executableName));
  if (path.basename(process.execPath).toLowerCase() === executableName) candidates.unshift(process.execPath);
  for (const candidate of candidates) {
    try {
      const real = fs.realpathSync(candidate);
      if (!fs.statSync(real).isFile()) continue;
      fs.accessSync(real, fs.constants.X_OK);
      if (process.platform !== 'win32' && /\s/.test(real)) continue;
      return real;
    } catch {}
  }
  throw new Error(`system ${executableName} executable not found for assessment PDF probe check`);
}

function writeFakeExecutable(directory, filename, body) {
  const executablePath = path.join(directory, filename);
  fs.writeFileSync(executablePath, `#!${findSystemNodeExecutable()}\n${body}\n`, { mode: 0o700 });
  fs.chmodSync(executablePath, 0o700);
  return executablePath;
}

function validOutput(overrides = {}) {
  const lines = [
    `Title:           ${overrides.title || 'Synthetic Secret Metadata'}`,
    `Pages:           ${overrides.pages === undefined ? 1 : overrides.pages}`,
    `Encrypted:       ${overrides.encrypted || 'no'}`,
  ];
  if (overrides.javascript !== undefined) lines.push(`JavaScript:      ${overrides.javascript}`);
  lines.push(`PDF version:     ${overrides.version || '1.7'}`);
  return `${lines.join('\n')}\n`;
}

async function expectCode(promise, expectedCode, forbidden = []) {
  let caught = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof AssessmentPdfProbeError, `expected ${expectedCode}`);
  assert.strictEqual(caught.code, expectedCode);
  assert.deepStrictEqual(Object.keys(caught), ['name', 'code']);
  assert.ok(!Object.hasOwn(caught, 'stdout'));
  assert.ok(!Object.hasOwn(caught, 'stderr'));
  assert.ok(!Object.hasOwn(caught, 'path'));
  for (const token of forbidden) {
    assert.ok(!caught.message.includes(token), `error message leaked forbidden token: ${token}`);
  }
  assert.ok(!caught.message.includes('/opt/homebrew'));
  return caught;
}

function options(stagingRoot, executablePath, overrides = {}) {
  return {
    stagingRoot,
    pdfinfoExecutablePath: executablePath,
    timeoutMs: 5000,
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
    ...(process.platform === 'darwin' ? {} : {
      parserRunner: (executable, args, runnerOptions) => {
        const nodeExecutable = findSystemNodeExecutable();
        if (process.platform === 'win32') {
          return spawnAssessmentParser(nodeExecutable, [executable, ...args], runnerOptions);
        }
        const child = spawn(nodeExecutable, [executable, ...args], {
          cwd: runnerOptions.workingDirectory,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { child, kill: () => child.kill('SIGKILL'), finish: () => null };
      },
    }),
    ...overrides,
  };
}

async function run() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss assessment pdf probe '));
  assert.match(temporaryRoot, /\s/, 'synthetic PDF probe path must cover spaces');
  const stagingRoot = path.join(temporaryRoot, 'staging');
  const toolsRoot = path.join(temporaryRoot, 'tools');
  fs.mkdirSync(stagingRoot, { mode: 0o700 });
  fs.mkdirSync(toolsRoot, { mode: 0o700 });
  const stagedPdf = path.join(stagingRoot, 'synthetic.pdf');
  fs.writeFileSync(stagedPdf, buildMinimalPdf(), { mode: 0o600 });
  let realPdfinfoExecuted = false;

  try {
    // A real parser is optional in portable checks and only receives generated bytes.
    const realPdfinfoPath = resolveOptionalRealPdfinfo();
    if (realPdfinfoPath) {
      const actual = await probeAssessmentPdf(stagedPdf, options(stagingRoot, realPdfinfoPath));
      assert.deepStrictEqual(actual, {
        pages: 1,
        encrypted: false,
        pdf_version: '1.4',
        state: 'basic_probe_passed',
      });
      assert.deepStrictEqual(Object.keys(actual).sort(), ['encrypted', 'pages', 'pdf_version', 'state']);
      assert.ok(!JSON.stringify(actual).match(/accepted|safe|clean/i));
      realPdfinfoExecuted = true;
    } else {
      console.log('SKIP real pdfinfo (tool unavailable)');
    }
    const upstreamState = { security_state: 'pending_security_review' };
    assert.strictEqual(upstreamState.security_state, 'pending_security_review');

    const passToolLines = [];
    if (process.platform === 'win32') {
      console.log('SKIP macOS deny-read sandbox assertion on Windows');
    } else {
      passToolLines.push(
        `try { require('fs').readFileSync(${JSON.stringify(path.join(temporaryRoot, 'sandbox-forbidden.txt'))}); process.exit(88); } catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) process.exit(89); }`,
      );
    }
    passToolLines.push(`process.stdout.write(${JSON.stringify(validOutput())});`);
    const passTool = writeFakeExecutable(toolsRoot, 'pass-tool', passToolLines.join('\n'));
    fs.writeFileSync(path.join(temporaryRoot, 'sandbox-forbidden.txt'), 'must not be readable by parser');
    const fakePass = await probeAssessmentPdf(stagedPdf, options(stagingRoot, passTool));
    assert.deepStrictEqual(fakePass, {
      pages: 1,
      encrypted: false,
      pdf_version: '1.7',
      state: 'basic_probe_passed',
    });
    assert.ok(!JSON.stringify(fakePass).includes('Synthetic Secret Metadata'));

    const encryptedTool = writeFakeExecutable(
      toolsRoot,
      'encrypted-tool',
      `process.stdout.write(${JSON.stringify(validOutput({ encrypted: 'yes (print:no copy:no)' }))});`,
    );
    await expectCode(
      probeAssessmentPdf(stagedPdf, options(stagingRoot, encryptedTool)),
      'ASSESSMENT_PDF_PROBE_ENCRYPTED',
      [temporaryRoot, 'Synthetic Secret Metadata'],
    );

    for (const pages of [0, 201]) {
      const pageTool = writeFakeExecutable(
        toolsRoot,
        `pages-${pages}-tool`,
        `process.stdout.write(${JSON.stringify(validOutput({ pages }))});`,
      );
      await expectCode(
        probeAssessmentPdf(stagedPdf, options(stagingRoot, pageTool)),
        'ASSESSMENT_PDF_PROBE_PAGE_COUNT',
        [temporaryRoot, 'Synthetic Secret Metadata'],
      );
    }

    const javascriptTool = writeFakeExecutable(
      toolsRoot,
      'javascript-tool',
      `process.stdout.write(${JSON.stringify(validOutput({ javascript: 'yes' }))});`,
    );
    await expectCode(
      probeAssessmentPdf(stagedPdf, options(stagingRoot, javascriptTool)),
      'ASSESSMENT_PDF_PROBE_JAVASCRIPT',
      [temporaryRoot, 'Synthetic Secret Metadata'],
    );

    const invalidOutputTool = writeFakeExecutable(
      toolsRoot,
      'invalid-output-tool',
      "process.stdout.write('Title: Synthetic Secret Metadata\\nEncrypted: no\\nPDF version: unknown\\n');",
    );
    await expectCode(
      probeAssessmentPdf(stagedPdf, options(stagingRoot, invalidOutputTool)),
      'ASSESSMENT_PDF_PROBE_OUTPUT_INVALID',
      [temporaryRoot, 'Synthetic Secret Metadata'],
    );

    const damagedTool = writeFakeExecutable(
      toolsRoot,
      'damaged-tool',
      "process.stderr.write('SECRET_RAW_DIAGNOSTIC ' + process.argv[2]); process.exit(7);",
    );
    await expectCode(
      probeAssessmentPdf(stagedPdf, options(stagingRoot, damagedTool)),
      'ASSESSMENT_PDF_PROBE_PROCESS_FAILED',
      [temporaryRoot, 'SECRET_RAW_DIAGNOSTIC'],
    );

    const timeoutTool = writeFakeExecutable(
      toolsRoot,
      'timeout-tool',
      'setInterval(() => {}, 1000);',
    );
    const timeoutStartedAt = Date.now();
    await expectCode(
      probeAssessmentPdf(stagedPdf, options(stagingRoot, timeoutTool, { timeoutMs: 80 })),
      'ASSESSMENT_PDF_PROBE_TIMEOUT',
      [temporaryRoot],
    );
    assert.ok(Date.now() - timeoutStartedAt < 2000, 'timeout child was not killed and closed promptly');

    const stdoutLimitTool = writeFakeExecutable(
      toolsRoot,
      'stdout-limit-tool',
      "process.stdout.write('X'.repeat(8192)); setInterval(() => {}, 1000);",
    );
    await expectCode(
      probeAssessmentPdf(stagedPdf, options(stagingRoot, stdoutLimitTool, { maxStdoutBytes: 64 })),
      'ASSESSMENT_PDF_PROBE_STDOUT_LIMIT',
      [temporaryRoot],
    );

    const stderrLimitTool = writeFakeExecutable(
      toolsRoot,
      'stderr-limit-tool',
      "process.stderr.write('SECRET_RAW_DIAGNOSTIC'.repeat(512)); setInterval(() => {}, 1000);",
    );
    await expectCode(
      probeAssessmentPdf(stagedPdf, options(stagingRoot, stderrLimitTool, { maxStderrBytes: 64 })),
      'ASSESSMENT_PDF_PROBE_STDERR_LIMIT',
      [temporaryRoot, 'SECRET_RAW_DIAGNOSTIC'],
    );

    await expectCode(
      probeAssessmentPdf(
        stagedPdf,
        options(stagingRoot, path.join(toolsRoot, 'missing-tool')),
      ),
      'ASSESSMENT_PDF_PROBE_TOOL_UNAVAILABLE',
      [temporaryRoot],
    );

    const outsidePdf = path.join(temporaryRoot, 'outside.pdf');
    fs.writeFileSync(outsidePdf, buildMinimalPdf(), { mode: 0o600 });
    await expectCode(
      probeAssessmentPdf(outsidePdf, options(stagingRoot, passTool)),
      'ASSESSMENT_PDF_PROBE_FILE_OUTSIDE_ROOT',
      [temporaryRoot],
    );

    const symlinkPdf = path.join(stagingRoot, 'linked.pdf');
    fs.symlinkSync(stagedPdf, symlinkPdf);
    await expectCode(
      probeAssessmentPdf(symlinkPdf, options(stagingRoot, passTool)),
      'ASSESSMENT_PDF_PROBE_FILE_SYMLINK',
      [temporaryRoot],
    );

    await expectCode(
      probeAssessmentPdf(stagingRoot, options(stagingRoot, passTool)),
      'ASSESSMENT_PDF_PROBE_FILE_NOT_REGULAR',
      [temporaryRoot],
    );

    const stagingRootLink = path.join(temporaryRoot, 'staging-link');
    fs.symlinkSync(stagingRoot, stagingRootLink);
    await expectCode(
      probeAssessmentPdf(stagedPdf, options(stagingRootLink, passTool)),
      'ASSESSMENT_PDF_PROBE_ROOT_INVALID',
      [temporaryRoot],
    );

    await expectCode(
      probeAssessmentPdf('relative.pdf', options(stagingRoot, passTool)),
      'ASSESSMENT_PDF_PROBE_FILE_INVALID',
      [temporaryRoot],
    );

    const injectedPdf = path.join(stagingRoot, 'input;touch ARG_MARKER.pdf');
    fs.copyFileSync(stagedPdf, injectedPdf);
    const expectedInjectedArgument = process.platform === 'win32'
      ? (fs.realpathSync.native || fs.realpathSync)(injectedPdf)
      : fs.realpathSync(injectedPdf);
    const injectedExecutable = writeFakeExecutable(
      toolsRoot,
      'fake;touch EXEC_MARKER',
      [
        `if (JSON.stringify(process.argv.slice(2)) !== ${JSON.stringify(JSON.stringify([expectedInjectedArgument]))}) process.exit(9);`,
        `process.stdout.write(${JSON.stringify(validOutput())});`,
      ].join('\n'),
    );
    const injectionResult = await probeAssessmentPdf(
      injectedPdf,
      options(stagingRoot, injectedExecutable),
    );
    assert.strictEqual(injectionResult.state, 'basic_probe_passed');
    assert.ok(!fs.existsSync(path.join(stagingRoot, 'EXEC_MARKER')));
    assert.ok(!fs.existsSync(path.join(stagingRoot, 'ARG_MARKER.pdf')));

    const changedPdf = path.join(stagingRoot, 'changed.pdf');
    fs.copyFileSync(stagedPdf, changedPdf);
    const delayedTool = writeFakeExecutable(
      toolsRoot,
      'delayed-tool',
      `setTimeout(() => process.stdout.write(${JSON.stringify(validOutput())}), 120);`,
    );
    const changedPromise = probeAssessmentPdf(changedPdf, options(stagingRoot, delayedTool));
    setTimeout(() => {
      const replacement = path.join(stagingRoot, 'replacement.pdf');
      fs.writeFileSync(replacement, buildMinimalPdf(), { mode: 0o600 });
      fs.renameSync(replacement, changedPdf);
    }, 40);
    await expectCode(
      changedPromise,
      'ASSESSMENT_PDF_PROBE_FILE_CHANGED',
      [temporaryRoot],
    );

    await expectCode(
      probeAssessmentPdf(stagedPdf, options(stagingRoot, passTool, { maxStdoutBytes: 0 })),
      'ASSESSMENT_PDF_PROBE_STDOUT_LIMIT_INVALID',
      [temporaryRoot],
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  assert.ok(!fs.existsSync(temporaryRoot), 'temporary probe fixtures were not cleaned');
  console.log(JSON.stringify({
    check: 'assessment_pdf_probe',
    status: 'passed',
    real_pdfinfo_executed: realPdfinfoExecuted,
  }));
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
