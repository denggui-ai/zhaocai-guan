
const { PROJECT_ROOT } = require("./paths");
const fs = require('fs');
const path = require('path');

const DEFAULT_INTERVIEW_MATERIAL_ROOT = path.join(PROJECT_ROOT, 'data', 'interviews');

const MATERIAL_POLICIES = Object.freeze({
  summary: { extensions: new Set(['.json']), maxBytes: 1_000_000, basename: 'summary.json' },
  source_media: { extensions: new Set(['.wav', '.aiff', '.aif', '.m4a', '.mp3', '.aac', '.flac', '.ogg', '.mp4', '.mov', '.m4v']), maxBytes: 2_000_000_000 },
  audio: { extensions: new Set(['.wav', '.aiff', '.aif', '.m4a', '.mp3', '.aac', '.flac', '.ogg']), maxBytes: 2_000_000_000 },
  transcript_txt: { extensions: new Set(['.txt']), maxBytes: 2_000_000 },
  transcript_srt: { extensions: new Set(['.srt']), maxBytes: 10_000_000 },
  transcript_json: { extensions: new Set(['.json']), maxBytes: 50_000_000 },
  report: { extensions: new Set(['.json', '.md']), maxBytes: 5_000_000 },
});

class InterviewMaterialPathError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InterviewMaterialPathError';
    this.code = code;
  }
}

function materialError(code, message) {
  return new InterviewMaterialPathError(code, message);
}

function getInterviewMaterialRoot(explicitRoot) {
  return path.resolve(explicitRoot || process.env.HRBOSS_INTERVIEW_OUTPUT_DIR || DEFAULT_INTERVIEW_MATERIAL_ROOT);
}

function isContained(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function ensureRoot(rootInput) {
  const root = getInterviewMaterialRoot(rootInput);
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const rootStat = fs.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw materialError('INTERVIEW_MATERIAL_ROOT_INVALID', '面试材料受控目录不可用。');
    }
    return { root, realRoot: fs.realpathSync(root) };
  } catch (error) {
    if (error instanceof InterviewMaterialPathError) throw error;
    throw materialError('INTERVIEW_MATERIAL_ROOT_INVALID', '面试材料受控目录不可用。');
  }
}

function resolveInputPath(value, baseDir) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw materialError('INTERVIEW_MATERIAL_PATH_REQUIRED', '面试材料路径无效。');
  }
  return path.resolve(baseDir, value.trim());
}

function prepareInterviewMaterialDirectory(directoryPath, options = {}) {
  const { root, realRoot } = ensureRoot(options.root);
  const resolved = resolveInputPath(directoryPath, root);
  if (!isContained(root, resolved) && !isContained(realRoot, resolved)) {
    throw materialError('INTERVIEW_MATERIAL_OUTSIDE_ROOT', '面试材料路径不在受控目录内。');
  }
  try {
    const lexicalRoot = isContained(root, resolved) ? root : realRoot;
    const relative = path.relative(lexicalRoot, resolved);
    let cursor = lexicalRoot;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      if (!fs.existsSync(cursor)) continue;
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        throw materialError('INTERVIEW_MATERIAL_SYMLINK', '面试材料路径不能经过符号链接。');
      }
    }
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const realDirectory = fs.realpathSync(resolved);
    if (!isContained(realRoot, realDirectory)) {
      throw materialError('INTERVIEW_MATERIAL_OUTSIDE_ROOT', '面试材料路径不在受控目录内。');
    }
    return realDirectory;
  } catch (error) {
    if (error instanceof InterviewMaterialPathError) throw error;
    throw materialError('INTERVIEW_MATERIAL_DIRECTORY_INVALID', '面试材料目录不可用。');
  }
}

function prepareInterviewMaterialFileTarget(filePath, kind, options = {}) {
  const policy = MATERIAL_POLICIES[kind];
  if (!policy) throw materialError('INTERVIEW_MATERIAL_KIND_INVALID', '面试材料类型不受支持。');
  const { root, realRoot } = ensureRoot(options.root);
  const baseDir = options.baseDir ? path.resolve(options.baseDir) : root;
  const resolved = resolveInputPath(filePath, baseDir);
  if (!isContained(root, resolved) && !isContained(realRoot, resolved)) {
    throw materialError('INTERVIEW_MATERIAL_OUTSIDE_ROOT', '面试材料路径不在受控目录内。');
  }
  const extension = path.extname(resolved).toLowerCase();
  if (!policy.extensions.has(extension) || (policy.basename && path.basename(resolved) !== policy.basename)) {
    throw materialError('INTERVIEW_MATERIAL_EXTENSION_INVALID', '面试材料文件类型不受支持。');
  }
  const parent = prepareInterviewMaterialDirectory(path.dirname(resolved), { root });
  const target = path.join(parent, path.basename(resolved));
  if (!isContained(realRoot, target)) {
    throw materialError('INTERVIEW_MATERIAL_OUTSIDE_ROOT', '面试材料路径不在受控目录内。');
  }
  try {
    let stat = null;
    try {
      stat = fs.lstatSync(target);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (stat) {
      if (stat.isSymbolicLink()) {
        throw materialError('INTERVIEW_MATERIAL_SYMLINK', '面试材料写入目标不能是符号链接。');
      }
      if (!stat.isFile()) {
        throw materialError('INTERVIEW_MATERIAL_NOT_FILE', '面试材料必须是普通文件。');
      }
    }
    return target;
  } catch (error) {
    if (error instanceof InterviewMaterialPathError) throw error;
    throw materialError('INTERVIEW_MATERIAL_TARGET_INVALID', '面试材料写入目标不可用。');
  }
}

function validateInterviewMaterialFile(filePath, kind, options = {}) {
  const policy = MATERIAL_POLICIES[kind];
  if (!policy) throw materialError('INTERVIEW_MATERIAL_KIND_INVALID', '面试材料类型不受支持。');
  const { root, realRoot } = ensureRoot(options.root);
  const baseDir = options.baseDir ? path.resolve(options.baseDir) : root;
  const resolved = resolveInputPath(filePath, baseDir);
  if (!isContained(root, resolved) && !isContained(realRoot, resolved)) {
    throw materialError('INTERVIEW_MATERIAL_OUTSIDE_ROOT', '面试材料路径不在受控目录内。');
  }
  try {
    const realFile = fs.realpathSync(resolved);
    if (!isContained(realRoot, realFile)) {
      throw materialError('INTERVIEW_MATERIAL_OUTSIDE_ROOT', '面试材料路径不在受控目录内。');
    }
    const stat = fs.statSync(realFile);
    if (!stat.isFile()) {
      throw materialError('INTERVIEW_MATERIAL_NOT_FILE', '面试材料必须是普通文件。');
    }
    const extension = path.extname(realFile).toLowerCase();
    if (!policy.extensions.has(extension) || (policy.basename && path.basename(realFile) !== policy.basename)) {
      throw materialError('INTERVIEW_MATERIAL_EXTENSION_INVALID', '面试材料文件类型不受支持。');
    }
    const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : policy.maxBytes;
    if (stat.size <= 0 || stat.size > maxBytes) {
      throw materialError('INTERVIEW_MATERIAL_SIZE_INVALID', '面试材料大小不符合限制。');
    }
    return { path: realFile, stat, kind };
  } catch (error) {
    if (error instanceof InterviewMaterialPathError) throw error;
    throw materialError('INTERVIEW_MATERIAL_MISSING', '面试材料不存在或已失效。');
  }
}

function validateImportedMediaSource(filePath, options = {}) {
  const policy = MATERIAL_POLICIES.source_media;
  if (typeof filePath !== 'string' || !filePath.trim() || filePath.includes('\0')) {
    throw materialError('INTERVIEW_IMPORT_SOURCE_INVALID', '请选择有效的音视频文件。');
  }
  try {
    const resolved = path.resolve(filePath.trim());
    const linkStat = fs.lstatSync(resolved);
    if (linkStat.isSymbolicLink()) {
      throw materialError('INTERVIEW_IMPORT_SOURCE_SYMLINK', '导入的音视频不能是符号链接。');
    }
    const realFile = fs.realpathSync(resolved);
    const stat = fs.statSync(realFile);
    if (!stat.isFile()) throw materialError('INTERVIEW_IMPORT_SOURCE_NOT_FILE', '请选择有效的音视频文件。');
    if (!policy.extensions.has(path.extname(realFile).toLowerCase())) {
      throw materialError('INTERVIEW_IMPORT_SOURCE_EXTENSION_INVALID', '导入文件类型不受支持。');
    }
    if (stat.size <= 0 || stat.size > policy.maxBytes) {
      throw materialError('INTERVIEW_IMPORT_SOURCE_SIZE_INVALID', '导入文件大小不符合限制。');
    }
    return { path: realFile, stat };
  } catch (error) {
    if (error instanceof InterviewMaterialPathError) throw error;
    throw materialError('INTERVIEW_IMPORT_SOURCE_MISSING', '请选择存在的音视频文件。');
  }
}

function readControlledTextFile(filePath, kind, options = {}) {
  const validated = validateInterviewMaterialFile(filePath, kind, options);
  let descriptor;
  try {
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    descriptor = fs.openSync(validated.path, fs.constants.O_RDONLY | noFollow);
    const stat = fs.fstatSync(descriptor);
    const policy = MATERIAL_POLICIES[kind];
    const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : policy.maxBytes;
    if (!stat.isFile()) throw materialError('INTERVIEW_MATERIAL_NOT_FILE', '面试材料必须是普通文件。');
    if (stat.size <= 0 || stat.size > maxBytes) {
      throw materialError('INTERVIEW_MATERIAL_SIZE_INVALID', '面试材料大小不符合限制。');
    }
    return { ...validated, stat, text: fs.readFileSync(descriptor, 'utf8') };
  } catch (error) {
    if (error instanceof InterviewMaterialPathError) throw error;
    throw materialError('INTERVIEW_MATERIAL_MISSING', '面试材料不存在或已失效。');
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function materialAliasPath(object, keys, kind, options, required = false) {
  const values = keys
    .map((key) => object[key])
    .filter((value) => typeof value === 'string' && value.trim());
  if (!values.length) {
    if (required) throw materialError('INTERVIEW_MATERIAL_PATH_REQUIRED', '面试材料路径无效。');
    return '';
  }
  const canonical = values.map((value) => validateInterviewMaterialFile(value, kind, options).path);
  if (canonical.some((value) => value !== canonical[0])) {
    throw materialError('INTERVIEW_MATERIAL_PATH_MISMATCH', '面试材料路径登记不一致。');
  }
  return canonical[0];
}

function readAndValidateInterviewSummary(summaryPath, options = {}) {
  const root = getInterviewMaterialRoot(options.root);
  const loaded = readControlledTextFile(summaryPath, 'summary', { root });
  let summary;
  try {
    summary = JSON.parse(loaded.text);
  } catch {
    throw materialError('INTERVIEW_SUMMARY_JSON_INVALID', 'summary.json 内容无效。');
  }
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    throw materialError('INTERVIEW_SUMMARY_JSON_INVALID', 'summary.json 内容无效。');
  }
  const baseDir = path.dirname(loaded.path);
  const shared = { root, baseDir };
  const pathKeys = [
    'summaryPath', 'summary_path', 'sourcePath', 'source_path', 'wavPath', 'wav_path',
    'transcriptTxt', 'transcript_txt_path', 'transcriptSrt', 'transcript_srt_path',
    'transcriptJson', 'transcript_json_path', 'codexInput', 'codex_input_path',
    'reportPath', 'report_path',
  ];
  const normalized = {
    ...summary,
    summaryPath: loaded.path,
    sourcePath: materialAliasPath(summary, ['sourcePath', 'source_path'], 'source_media', shared),
    wavPath: materialAliasPath(summary, ['wavPath', 'wav_path'], 'audio', shared, true),
    transcriptTxt: materialAliasPath(summary, ['transcriptTxt', 'transcript_txt_path'], 'transcript_txt', shared, true),
    transcriptSrt: materialAliasPath(summary, ['transcriptSrt', 'transcript_srt_path'], 'transcript_srt', shared),
    transcriptJson: materialAliasPath(summary, ['transcriptJson', 'transcript_json_path'], 'transcript_json', shared),
    codexInput: materialAliasPath(summary, ['codexInput', 'codex_input_path'], 'report', shared),
    reportPath: materialAliasPath(summary, ['reportPath', 'report_path'], 'report', shared),
  };
  for (const key of pathKeys) {
    if (key.includes('_')) delete normalized[key];
  }
  if (summary.summaryPath || summary.summary_path) {
    const declared = materialAliasPath(summary, ['summaryPath', 'summary_path'], 'summary', shared);
    if (declared !== loaded.path) {
      throw materialError('INTERVIEW_SUMMARY_PATH_MISMATCH', 'summary.json 自身路径登记不一致。');
    }
  }
  return { path: loaded.path, summary: normalized, stat: loaded.stat };
}

function validateInterviewRecordingPaths(input, options = {}) {
  const root = getInterviewMaterialRoot(options.root);
  const summaryValue = input.summary_path || input.summaryPath;
  const loaded = readAndValidateInterviewSummary(summaryValue, { root });
  const summary = loaded.summary;
  const comparisons = [
    ['source_path', 'sourcePath', 'source_media'],
    ['wav_path', 'wavPath', 'audio'],
    ['transcript_txt_path', 'transcriptTxt', 'transcript_txt'],
    ['transcript_srt_path', 'transcriptSrt', 'transcript_srt'],
    ['transcript_json_path', 'transcriptJson', 'transcript_json'],
    ['codex_input_path', 'codexInput', 'report'],
  ];
  for (const [snakeKey, camelKey, kind] of comparisons) {
    for (const supplied of [input[snakeKey], input[camelKey]]) {
      if (typeof supplied !== 'string' || !supplied.trim()) continue;
      const canonical = validateInterviewMaterialFile(supplied, kind, { root, baseDir: path.dirname(loaded.path) }).path;
      if (canonical !== summary[camelKey]) {
        throw materialError('INTERVIEW_MATERIAL_PATH_MISMATCH', '面试材料登记与 summary.json 不一致。');
      }
    }
  }
  return {
    summary_path: loaded.path,
    source_path: summary.sourcePath,
    wav_path: summary.wavPath,
    transcript_txt_path: summary.transcriptTxt,
    transcript_srt_path: summary.transcriptSrt,
    transcript_json_path: summary.transcriptJson,
    codex_input_path: summary.codexInput,
    report_path: summary.reportPath,
    summary,
  };
}

module.exports = {
  DEFAULT_INTERVIEW_MATERIAL_ROOT,
  MATERIAL_POLICIES,
  InterviewMaterialPathError,
  getInterviewMaterialRoot,
  prepareInterviewMaterialDirectory,
  prepareInterviewMaterialFileTarget,
  readAndValidateInterviewSummary,
  readControlledTextFile,
  validateImportedMediaSource,
  validateInterviewMaterialFile,
  validateInterviewRecordingPaths,
};
