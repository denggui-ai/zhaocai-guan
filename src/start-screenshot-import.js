
const { PROJECT_ROOT } = require("./paths");
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const progress = require('./screenshot-import-progress');
const { createTaskObserver } = require('./task-observer');
const { STATE_BASENAME } = require('./task-run-state');
const { assertLocalVisionReady } = require('./local-vision-preflight');
const {
  abortEvidenceBatch,
  beginEvidenceBatch,
  commitEvidenceBatch,
  sha256File,
} = require('./screenshot-evidence-store');

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const DATA_DIR = process.env.HRBOSS_DATA_DIR ? path.resolve(process.env.HRBOSS_DATA_DIR) : path.join(PROJECT_ROOT, 'data');
const DEFAULT_TASK_STATE_PATH = path.join(DATA_DIR, 'screenshot-import-task', STATE_BASENAME);

let taskObserver = null;
let activeTaskRun = null;
let activeProgressRunId = '';
const SUPERSEDED_RUN_CODE = 'SCREENSHOT_IMPORT_RUN_SUPERSEDED';

function createScreenshotImportObserver(options = {}) {
  return createTaskObserver({
    statePath: options.statePath || process.env.BOSS_SCREENSHOT_IMPORT_TASK_STATE_FILE || DEFAULT_TASK_STATE_PATH,
    taskType: 'local_write',
    operationClass: 'write',
    ...(options.clock ? { clock: options.clock } : {}),
    ...(options.idFactory ? { idFactory: options.idFactory } : {}),
  });
}

function screenshotImportFailurePolicy() {
  return { operation_class: 'local_write', platform: 'local', error_kind: 'unknown' };
}

function startTaskObservation() {
  taskObserver = createScreenshotImportObserver();
  taskObserver.recoverInterrupted();
  activeTaskRun = taskObserver.startRun();
}

function finishTaskObservationSucceeded() {
  if (!taskObserver || !activeTaskRun) return;
  try {
    taskObserver.finishSucceeded(activeTaskRun);
  } catch {
    console.error('截图导入可观测状态写入失败。');
  } finally {
    activeTaskRun = null;
  }
}

function finishTaskObservationFailed() {
  if (!taskObserver || !activeTaskRun) return;
  try {
    taskObserver.finishFailed(activeTaskRun, screenshotImportFailurePolicy());
  } catch {
    console.error('截图导入可观测状态写入失败。');
  } finally {
    activeTaskRun = null;
  }
}

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function listImages(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && IMAGE_EXTS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans', { numeric: true }));
}

// Stitching composes the per-candidate review image. It needs Python and Pillow,
// which is a fair assumption on the machine this was written on and none at all
// on Windows, where `python3` is usually not even a command. The step is
// genuinely optional — ingest treats a missing stitched row as null throughout —
// so the interpreter is resolved rather than assumed, and a batch that cannot
// stitch loses the review image instead of failing outright.
//
// Pillow is checked too, not just the interpreter: without it the script dies on
// import, which would turn a degradable gap into a failed import.
function resolvePythonForStitching() {
  const candidates = process.env.HRBOSS_PYTHON
    ? [{ command: process.env.HRBOSS_PYTHON, args: [] }]
    : [
      { command: 'python3', args: [] },
      { command: 'python', args: [] },
      { command: 'py', args: ['-3'] },
    ];
  const rejected = [];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [...candidate.args, '-c', 'import PIL'], {
      encoding: 'utf8',
      timeout: 20000,
    });
    if (probe.status === 0) return { ...candidate, ok: true };
    const why = probe.error
      ? probe.error.code || probe.error.message
      : String(probe.stderr || '').trim().split('\n').pop() || `exit ${probe.status}`;
    rejected.push(`${candidate.command}: ${why}`);
  }
  return { ok: false, rejected };
}

// Places drafts the model produced elsewhere into this batch, in the same shape
// the local reader writes.
//
// The handoff file is trusted no further than any other input: every draft has
// to point at a screenshot from the folder this run was given, or the evidence
// manifest would later refuse the batch with a far less specific complaint. The
// OCR sidecar is written empty because there is genuinely no recognised text
// behind an AI-read draft — the job name falls back to its default, which is
// what an import with no readable heading does anyway.
function assertAiHandoffSources(payload, dir, files, batch) {
  const rows = payload && Array.isArray(payload.source_manifest) ? payload.source_manifest : null;
  if (!rows || rows.length !== files.length) {
    const error = new Error('AI 识别结果缺少完整的已批准截图内容清单。');
    error.code = 'SCREENSHOT_AI_HANDOFF_SOURCE_MISMATCH';
    throw error;
  }
  const expected = rows.map((row, index) => {
    const fileName = String(row && row.file_name || '');
    const sourceSha256 = String(row && row.source_sha256 || '');
    const sizeBytes = Number(row && row.size_bytes);
    if (fileName !== files[index] || path.basename(fileName) !== fileName
        || !/^[0-9a-f]{64}$/.test(sourceSha256)
        || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      const error = new Error('AI 识别结果的已批准截图内容清单无效。');
      error.code = 'SCREENSHOT_AI_HANDOFF_SOURCE_MISMATCH';
      throw error;
    }
    const sourceFile = path.join(dir, fileName);
    const stat = fs.statSync(sourceFile);
    if (!stat.isFile() || stat.size !== sizeBytes || sha256File(sourceFile) !== sourceSha256) {
      const error = new Error('AI 识别完成后截图内容已变化，已停止暂存，请重新导入并授权。');
      error.code = 'SCREENSHOT_AI_HANDOFF_SOURCE_CHANGED';
      throw error;
    }
    return { source_sha256: sourceSha256, size_bytes: sizeBytes };
  });
  const actualBatchSources = (Array.isArray(batch && batch.sources) ? batch.sources : [])
    .map(({ source_sha256: sourceSha256, size_bytes: sizeBytes }) => ({
      source_sha256: String(sourceSha256 || ''), size_bytes: Number(sizeBytes),
    }))
    .sort((left, right) => `${left.source_sha256}:${left.size_bytes}`.localeCompare(`${right.source_sha256}:${right.size_bytes}`));
  const expectedBatchSources = expected
    .sort((left, right) => `${left.source_sha256}:${left.size_bytes}`.localeCompare(`${right.source_sha256}:${right.size_bytes}`));
  if (JSON.stringify(actualBatchSources) !== JSON.stringify(expectedBatchSources)) {
    const error = new Error('截图证据批次与已批准的 AI 识别材料不一致，已停止暂存。');
    error.code = 'SCREENSHOT_AI_HANDOFF_SOURCE_CHANGED';
    throw error;
  }
  return true;
}

function stageAiReads(aiReadsPath, dir, files, batch, options = {}) {
  let payload = options.payload;
  if (!payload) {
    try {
      payload = readJson(aiReadsPath);
    } catch (error) {
      throw new Error(`读取 AI 识别结果失败：${error.message}`);
    }
  }
  if (options.sourcesValidated !== true) assertAiHandoffSources(payload, dir, files, batch);
  const drafts = payload && Array.isArray(payload.drafts) ? payload.drafts : null;
  if (!drafts) throw new Error('AI 识别结果格式错误：缺少 drafts。');
  const allowed = new Set(files.map((file) => path.resolve(dir, file)));
  drafts.forEach((draft) => {
    const draftFiles = Array.isArray(draft && draft.files) ? draft.files : [];
    if (!draftFiles.length) throw new Error('AI 识别结果里有草稿没有对应截图。');
    draftFiles.forEach((file) => {
      if (!allowed.has(path.resolve(file))) {
        throw new Error(`AI 识别结果引用了本次文件夹以外的截图：${path.basename(String(file))}`);
      }
    });
  });
  const summary = (payload && payload.summary) || {};
  const counts = {
    image_count: files.length,
    detail_draft_count: drafts.length,
    skipped_list_count: Number(summary.skipped_list_count) || 0,
    unrecognized_count: Number(summary.unrecognized_count) || 0,
    failed_count: Number(summary.failed_count) || 0,
  };
  fs.writeFileSync(batch.draftsPath, `${JSON.stringify({
    source_dir: dir,
    generated_at: new Date().toISOString(),
    ...counts,
    reader: 'external_ai_vision_v1',
    drafts,
  }, null, 2)}\n`);
  fs.writeFileSync(batch.ocrPath, '[]\n');
  return counts;
}

function runStep(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 120,
  });
  if (result.status !== 0) {
    throw new Error(`${label}失败：${result.stderr || result.stdout || `exit ${result.status}`}`);
  }
  return result.stdout ? JSON.parse(result.stdout) : {};
}

function writeRunning(stage, message, patch = {}) {
  const current = progress.readProgress();
  assertProgressRunOwnership(current);
  return progress.writeProgress({
    ...current,
    status: 'running',
    stage,
    message,
    error: null,
    finished_at: null,
    ...patch,
  });
}

function assertProgressRunOwnership(current = progress.readProgress()) {
  if (!activeProgressRunId || current.run_id === activeProgressRunId) return current;
  const error = new Error('截图导入任务已被新的 run 取代，旧进程停止写入。');
  error.code = SUPERSEDED_RUN_CODE;
  throw error;
}

function writeOwnedProgress(value) {
  assertProgressRunOwnership();
  return progress.writeProgress(value);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function selectAiReadFiles(aiReadsPath, allFiles) {
  if (!aiReadsPath) return allFiles;
  const payload = readJson(aiReadsPath);
  if (!Array.isArray(payload.source_files) || !payload.source_files.length) return allFiles;
  const allowed = new Set(allFiles);
  const selected = [];
  for (const value of payload.source_files) {
    const name = String(value || '');
    if (!name || path.basename(name) !== name || !allowed.has(name) || selected.includes(name)) {
      throw new Error('AI 识别结果的截图清单无效。');
    }
    selected.push(name);
  }
  return selected;
}

async function assertSupportedOcrRoute({ platform = process.platform, aiReadsPath = '', checkLocalVision = assertLocalVisionReady } = {}) {
  if (aiReadsPath) return;
  if (platform === 'darwin') {
    await checkLocalVision();
    return;
  }
  const error = new Error('非 macOS 截图导入必须从桌面端发起，并在逐图预览后批准外部 AI 识别。');
  error.code = 'SCREENSHOT_EXTERNAL_AI_APPROVAL_REQUIRED';
  throw error;
}

async function main() {
  const dir = path.resolve(argValue('dir'));
  // Present when the model already read these screenshots in the process that
  // holds the API key; this one is never given the key.
  const aiReadsPath = argValue('ai-reads') ? path.resolve(argValue('ai-reads')) : '';
  const runId = argValue('run-id');
  activeProgressRunId = runId;
  await assertSupportedOcrRoute({ aiReadsPath });
  startTaskObservation();
  const aiPayload = aiReadsPath ? readJson(aiReadsPath) : null;
  const evidenceScope = aiPayload ? String(aiPayload.evidence_scope || '') : '';
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error('请选择存在的截图文件夹。');
  }
  const files = selectAiReadFiles(aiReadsPath, listImages(dir));
  if (!files.length) throw new Error('文件夹里没有 PNG/JPG/WebP 截图。');

  const startedAt = new Date().toISOString();
  writeOwnedProgress({
    status: 'running',
    stage: 'ocr',
    run_id: runId || null,
    source_dir_name: path.basename(dir),
    image_count: files.length,
    detail_draft_count: 0,
    message: `正在识别 ${files.length} 张截图。`,
    started_at: startedAt,
    finished_at: null,
    error: null,
    result: null,
  });

  let batch = null;
  let ocrResult;
  let stitchResult;
  let ingestResult;
  let stitchSkippedReason = null;
  let unrecognizedItems = [];
  try {
    batch = beginEvidenceBatch({
      dataDir: DATA_DIR,
      sourceFiles: files.map((file) => path.join(dir, file)),
      batchScope: evidenceScope,
    });
    if (aiPayload) assertAiHandoffSources(aiPayload, dir, files, batch);
    if (batch.state === 'staging') {
      if (aiReadsPath) {
        // The model read these screenshots in the process that holds the API
        // key, because this one must never see it. What arrives here is already
        // drafts; there is no OCR text behind them and no line data to group,
        // so the work left is to place them in the batch.
        writeRunning('ocr', `正在整理 ${files.length} 张截图的识别结果。`, { batch_id: batch.batchId });
        ocrResult = stageAiReads(aiReadsPath, dir, files, batch, {
          payload: aiPayload,
          sourcesValidated: true,
        });
        // The handoff carries names, ages and salaries. It exists only to cross
        // the process boundary, and the drafts now live in the batch, so it is
        // removed rather than left sitting in the data directory.
        try { fs.unlinkSync(aiReadsPath); } catch {}
      } else {
        writeRunning('ocr', `正在识别 ${files.length} 张截图。`, { batch_id: batch.batchId });
        ocrResult = runStep('OCR 识别', process.execPath, [
          path.join(PROJECT_ROOT, "src/import-boss-screenshots.js"),
          `--dir=${dir}`,
          `--out=${batch.draftsPath}`,
          `--ocr-out=${batch.ocrPath}`,
        ]);
        const localDraftPayload = readJson(batch.draftsPath);
        unrecognizedItems = (Array.isArray(localDraftPayload.unrecognized_files)
          ? localDraftPayload.unrecognized_files
          : []).map((fileName, index) => ({
          image_id: `local-unrecognized-${index + 1}`,
          ordinal: Math.max(1, files.indexOf(String(fileName || '')) + 1),
          file_name: path.basename(String(fileName || '')),
          status: 'unrecognized',
          retryable: false,
          error_code: 'LOCAL_VISION_UNRECOGNIZED',
        }));
      }

      const python = resolvePythonForStitching();
      if (python.ok) {
        writeRunning('stitching', `正在拼合 ${ocrResult.detail_draft_count || 0} 个候选人。`, {
          batch_id: batch.batchId,
          detail_draft_count: ocrResult.detail_draft_count || 0,
        });
        stitchResult = runStep('拼合截图', python.command, [
          ...python.args,
          path.join(PROJECT_ROOT, "native/stitch-screenshot-drafts.py"),
          `--drafts=${batch.draftsPath}`,
          `--out-dir=${batch.stitchedDir}`,
          `--stored-prefix=${batch.storedDerivedPrefix}`,
        ]);
      } else {
        // Say so rather than letting the batch look complete. The drafts and
        // their fields are unaffected; only the composed review image is gone.
        stitchSkippedReason = `未找到可用的 Python（需安装 Python 与 Pillow）：${python.rejected.join('；')}`;
        writeRunning('stitching', '跳过拼合：本机没有可用的 Python，草稿仍会照常暂存，只是没有拼合预览图。', {
          batch_id: batch.batchId,
          detail_draft_count: ocrResult.detail_draft_count || 0,
          stitch_skipped_reason: stitchSkippedReason,
        });
        // Both of these are required artifacts of the evidence manifest and are
        // normally written by the stitch script. They are produced here instead
        // of relaxing the manifest contract, and the markdown records why the
        // batch has no preview so the evidence trail says it rather than just
        // showing an empty index.
        fs.mkdirSync(batch.stitchedDir, { recursive: true });
        fs.writeFileSync(batch.stitchedIndexPath, `${JSON.stringify({ rows: [] }, null, 2)}\n`);
        fs.writeFileSync(batch.indexMarkdownPath,
          `# 拼合预览（本批次未生成）\n\n`
          + `原因：${stitchSkippedReason}\n\n`
          + '草稿与字段不受影响，人工校对时请直接查看原始截图。\n');
        stitchResult = { count: 0 };
      }
      batch = commitEvidenceBatch(batch);
    } else {
      const draftsPayload = readJson(batch.draftsPath);
      unrecognizedItems = (Array.isArray(draftsPayload.unrecognized_files) ? draftsPayload.unrecognized_files : [])
        .map((fileName, index) => ({
          image_id: `local-unrecognized-${index + 1}`,
          ordinal: Math.max(1, files.indexOf(String(fileName || '')) + 1),
          file_name: path.basename(String(fileName || '')),
          status: 'unrecognized',
          retryable: false,
          error_code: 'LOCAL_VISION_UNRECOGNIZED',
        }));
      ocrResult = {
        image_count: draftsPayload.image_count || files.length,
        detail_draft_count: draftsPayload.detail_draft_count || (draftsPayload.drafts || []).length,
        skipped_list_count: draftsPayload.skipped_list_count || 0,
        unrecognized_count: draftsPayload.unrecognized_count || 0,
      };
      stitchResult = { count: (readJson(batch.stitchedIndexPath).rows || []).length };
    }

    writeRunning('staging_review', `正在暂存 ${stitchResult.count || 0} 个 OCR 待校对草稿。`, {
      batch_id: batch.batchId,
      detail_draft_count: stitchResult.count || ocrResult.detail_draft_count || 0,
    });
    ingestResult = runStep('OCR 草稿暂存', process.execPath, [
      path.join(PROJECT_ROOT, "src/ingest-screenshot-drafts.js"),
      `--drafts=${batch.draftsPath}`,
      `--stitched-index=${batch.stitchedIndexPath}`,
      `--ocr=${batch.ocrPath}`,
      `--manifest=${batch.manifestPath}`,
    ]);
  } catch (error) {
    abortEvidenceBatch(batch);
    throw error;
  }

  const finishedAt = new Date().toISOString();
  writeOwnedProgress({
    status: 'done',
    stage: 'done',
    run_id: runId || null,
    source_dir_name: path.basename(dir),
    image_count: ocrResult.image_count || files.length,
    ocr_done: ocrResult.image_count || files.length,
    ocr_total: ocrResult.image_count || files.length,
    detail_draft_count: stitchResult.count || ingestResult.total || 0,
    message: `OCR 草稿已暂存：${ingestResult.pending_review || 0} 条待人工校对，尚未写入正式候选人事实。${
      stitchSkippedReason ? '本次没有拼合预览图（本机缺 Python），校对时请直接看原始截图。' : ''}`,
    started_at: startedAt,
    finished_at: finishedAt,
    error: null,
    result: {
      job_id: ingestResult.job_id,
      job_name: ingestResult.job_name,
      inserted: ingestResult.inserted || 0,
      updated: ingestResult.updated || 0,
      draft_created: ingestResult.draft_created || 0,
      draft_reused: ingestResult.draft_reused || 0,
      pending_review: ingestResult.pending_review || 0,
      total: ingestResult.total || 0,
      image_count: ocrResult.image_count || files.length,
      skipped_list_count: ocrResult.skipped_list_count || 0,
      unrecognized_count: ocrResult.unrecognized_count || 0,
      batch_id: batch.batchId,
      manifest: path.posix.join(batch.batchRelative, 'manifest.json'),
      index_md: batch.manifest.paths.index_markdown,
      stitch_skipped_reason: stitchSkippedReason,
    },
    unrecognized_items: unrecognizedItems,
  });
  finishTaskObservationSucceeded();
  console.log(JSON.stringify({ ok: true, result: progress.readProgress().result }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    const message = err.message || String(err);
    try {
      if (err.code !== SUPERSEDED_RUN_CODE) {
        const current = progress.readProgress();
        if (!activeProgressRunId || current.run_id === activeProgressRunId) {
          progress.writeProgress({
            ...current,
            status: 'error',
            stage: 'error',
            message,
            error: message,
            finished_at: new Date().toISOString(),
          });
        }
      }
    } finally {
      finishTaskObservationFailed();
    }
    console.error(message);
    process.exit(1);
  });
}

module.exports = {
  DEFAULT_TASK_STATE_PATH,
  SUPERSEDED_RUN_CODE,
  assertProgressRunOwnership,
  assertAiHandoffSources,
  assertSupportedOcrRoute,
  createScreenshotImportObserver,
  listImages,
  main,
  resolvePythonForStitching,
  screenshotImportFailurePolicy,
  selectAiReadFiles,
  stageAiReads,
};
