'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const {
  AssessmentRasterPreviewError,
  readAssessmentRasterPage,
  renderAssessmentRasterPreview,
} = require("../src/assessment-raster-preview");
const { spawnAssessmentParser } = require("../src/assessment-parser-runner");

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'ascii');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

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
  throw new Error(`system ${executableName} executable not found for assessment raster check`);
}

const SYNTHETIC_RUNNER = process.platform === 'darwin' ? {} : {
  parserRunner: (executablePath, args, options) => {
    const nodeExecutable = findSystemNodeExecutable();
    if (process.platform === 'win32') {
      return spawnAssessmentParser(nodeExecutable, [executablePath, ...args], options);
    }
    const child = spawn(nodeExecutable, [executablePath, ...args], {
      cwd: options.workingDirectory,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { child, kill: () => child.kill('SIGKILL'), finish: () => null };
  },
};

function executable(directory, name, body) {
  const target = path.join(directory, name);
  fs.writeFileSync(target, `#!${findSystemNodeExecutable()}\n${body}\n`, { mode: 0o700 });
  fs.chmodSync(target, 0o700);
  return target;
}

async function expectCode(promise, code, forbiddenRoot) {
  let caught;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught instanceof AssessmentRasterPreviewError, `expected ${code}, got ${caught && caught.stack}`);
  assert.strictEqual(caught.code, code);
  assert.strictEqual(caught.message.includes(forbiddenRoot), false);
}

async function run() {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss assessment raster '));
  assert.match(temporaryRoot, /\s/, 'synthetic raster path must cover spaces');
  const controlledRoot = path.join(temporaryRoot, 'assessment');
  const stagingRoot = path.join(controlledRoot, 'staging');
  const outputRoot = path.join(controlledRoot, 'preview-work');
  const toolsRoot = path.join(temporaryRoot, 'tools');
  fs.mkdirSync(stagingRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outputRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(toolsRoot, { recursive: true, mode: 0o700 });
  const stagedPdf = path.join(stagingRoot, 'synthetic.pdf');
  fs.writeFileSync(stagedPdf, PDF, { mode: 0o600 });

  try {
    const passTool = executable(toolsRoot, 'pdftoppm-pass', `
      const fs = require('fs');
      const prefix = process.argv[process.argv.length - 1];
      const last = Number(process.argv[process.argv.indexOf('-l') + 1]);
      const png = Buffer.from(${JSON.stringify([...PNG])});
      for (let page = 1; page <= last; page += 1) fs.writeFileSync(prefix + '-' + page + '.png', png);
    `);
    const rendered = await renderAssessmentRasterPreview(stagedPdf, {
      ...SYNTHETIC_RUNNER,
      controlledRoot,
      outputRoot,
      pdftoppmExecutablePath: passTool,
      pageCount: 2,
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    assert.deepStrictEqual({
      state: rendered.state,
      format: rendered.format,
      page_count: rendered.page_count,
      total_bytes: rendered.total_bytes,
      page_files: rendered.page_files,
    }, {
      state: 'raster_preview_ready',
      format: 'png',
      page_count: 2,
      total_bytes: PNG.length * 2,
      page_files: ['page-1.png', 'page-2.png'],
    });
    assert.strictEqual(rendered.work_dir.startsWith(fs.realpathSync(outputRoot) + path.sep), true);

    const hash = 'a'.repeat(64);
    const previewTarget = path.join(controlledRoot, 'previews', 'sha256', 'aa', hash);
    fs.mkdirSync(path.dirname(previewTarget), { recursive: true });
    fs.renameSync(rendered.work_dir, previewTarget);
    assert.deepStrictEqual(readAssessmentRasterPage({
      previewRoot: path.join(controlledRoot, 'previews'),
      contentSha256: hash,
      page: 2,
    }), PNG);

    const paddedTool = executable(toolsRoot, 'pdftoppm-padded', `
      const fs = require('fs');
      const prefix = process.argv[process.argv.length - 1];
      const last = Number(process.argv[process.argv.indexOf('-l') + 1]);
      const width = String(last).length;
      const png = Buffer.from(${JSON.stringify([...PNG])});
      for (let page = 1; page <= last; page += 1) {
        fs.writeFileSync(prefix + '-' + String(page).padStart(width, '0') + '.png', png);
      }
    `);
    for (const pages of [12, 200]) {
      const padded = await renderAssessmentRasterPreview(stagedPdf, {
        ...SYNTHETIC_RUNNER,
        controlledRoot,
        outputRoot,
        pdftoppmExecutablePath: paddedTool,
        pageCount: pages,
        timeoutMs: 10000,
        maxOutputBytes: 1024 * 1024,
      });
      assert.strictEqual(padded.page_files.length, pages);
      assert.strictEqual(padded.page_files[0], 'page-1.png');
      assert.strictEqual(padded.page_files[pages - 1], `page-${pages}.png`);
      assert.strictEqual(fs.existsSync(path.join(padded.work_dir, `page-${pages}.png`)), true);
      assert.strictEqual(fs.readdirSync(padded.work_dir).some((name) => /^page-0/.test(name)), false);
      fs.rmSync(padded.work_dir, { recursive: true, force: true });
    }

    const invalidTool = executable(toolsRoot, 'pdftoppm-invalid', `
      const fs = require('fs');
      const prefix = process.argv[process.argv.length - 1];
      fs.writeFileSync(prefix + '-1.png', Buffer.from('not png'));
    `);
    await expectCode(renderAssessmentRasterPreview(stagedPdf, {
      ...SYNTHETIC_RUNNER,
      controlledRoot, outputRoot, pdftoppmExecutablePath: invalidTool, pageCount: 1,
    }), 'ASSESSMENT_PREVIEW_OUTPUT_INVALID', temporaryRoot);

    const limitTool = executable(toolsRoot, 'pdftoppm-limit', `
      const fs = require('fs');
      const prefix = process.argv[process.argv.length - 1];
      const head = Buffer.from(${JSON.stringify([...PNG])});
      fs.writeFileSync(prefix + '-1.png', Buffer.concat([head, Buffer.alloc(2048)]));
      setInterval(() => {}, 1000);
    `);
    await expectCode(renderAssessmentRasterPreview(stagedPdf, {
      ...SYNTHETIC_RUNNER,
      controlledRoot, outputRoot, pdftoppmExecutablePath: limitTool, pageCount: 1, maxOutputBytes: 64,
    }), 'ASSESSMENT_PREVIEW_OUTPUT_LIMIT', temporaryRoot);

    const timeoutTool = executable(toolsRoot, 'pdftoppm-timeout', 'setInterval(() => {}, 1000);');
    await expectCode(renderAssessmentRasterPreview(stagedPdf, {
      ...SYNTHETIC_RUNNER,
      controlledRoot, outputRoot, pdftoppmExecutablePath: timeoutTool, pageCount: 1, timeoutMs: 60,
    }), 'ASSESSMENT_PREVIEW_TIMEOUT', temporaryRoot);

    const outsidePdf = path.join(temporaryRoot, 'outside.pdf');
    fs.writeFileSync(outsidePdf, PDF);
    await expectCode(Promise.resolve().then(() => renderAssessmentRasterPreview(outsidePdf, {
      ...SYNTHETIC_RUNNER,
      controlledRoot, outputRoot, pdftoppmExecutablePath: passTool, pageCount: 1,
    })), 'ASSESSMENT_PREVIEW_FILE_OUTSIDE_ROOT', temporaryRoot);

    assert.deepStrictEqual(fs.readdirSync(outputRoot), [], 'failed renders must clean all work directories');
    console.log('check-assessment-raster-preview: PASS');
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
