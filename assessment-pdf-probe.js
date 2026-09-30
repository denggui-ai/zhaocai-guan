const fs = require('fs');
const path = require('path');
const { spawnAssessmentParser } = require('./assessment-parser-runner');

const DEFAULT_TIMEOUT_MS = 60 * 1000;
const DEFAULT_STDOUT_LIMIT = 64 * 1024;
const DEFAULT_STDERR_LIMIT = 64 * 1024;
const MAX_PAGES = 200;
const MAX_OUTPUT_LIMIT = 1024 * 1024;

class AssessmentPdfProbeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AssessmentPdfProbeError';
    this.code = code;
  }
}

function probeError(code, message) {
  return new AssessmentPdfProbeError(code, message);
}

function normalizeLimit(value, fallback, code) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_OUTPUT_LIMIT) {
    throw probeError(code, 'PDF 基础探针资源限制无效。');
  }
  return value;
}

function normalizeTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 10 || value > DEFAULT_TIMEOUT_MS) {
    throw probeError('ASSESSMENT_PDF_PROBE_TIMEOUT_INVALID', 'PDF 基础探针超时限制无效。');
  }
  return value;
}

function requireAbsolutePath(value, code, message) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) {
    throw probeError(code, message);
  }
  return path.resolve(value);
}

function inspectStagedFile(stagedInput, rootInput) {
  const stagedPath = requireAbsolutePath(
    stagedInput,
    'ASSESSMENT_PDF_PROBE_FILE_INVALID',
    'PDF 基础探针输入无效。',
  );
  const rootPath = requireAbsolutePath(
    rootInput,
    'ASSESSMENT_PDF_PROBE_ROOT_INVALID',
    'PDF 基础探针受控目录无效。',
  );

  let rootStat;
  let rootRealPath;
  try {
    rootStat = fs.lstatSync(rootPath);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error('invalid root');
    }
    rootRealPath = fs.realpathSync(rootPath);
  } catch {
    throw probeError('ASSESSMENT_PDF_PROBE_ROOT_INVALID', 'PDF 基础探针受控目录无效。');
  }

  let pathStat;
  let realPath;
  let descriptorStat;
  try {
    pathStat = fs.lstatSync(stagedPath);
    if (pathStat.isSymbolicLink()) {
      throw probeError('ASSESSMENT_PDF_PROBE_FILE_SYMLINK', 'PDF 基础探针拒绝符号链接。');
    }
    if (!pathStat.isFile()) {
      throw probeError('ASSESSMENT_PDF_PROBE_FILE_NOT_REGULAR', 'PDF 基础探针只接受普通文件。');
    }
    realPath = fs.realpathSync(stagedPath);
    descriptorStat = fs.statSync(realPath);
  } catch (error) {
    if (error instanceof AssessmentPdfProbeError) throw error;
    throw probeError('ASSESSMENT_PDF_PROBE_FILE_UNAVAILABLE', 'PDF 基础探针输入不可访问。');
  }

  const relative = path.relative(rootRealPath, realPath);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw probeError('ASSESSMENT_PDF_PROBE_FILE_OUTSIDE_ROOT', 'PDF 基础探针输入不在受控目录内。');
  }
  if (!descriptorStat.isFile()) {
    throw probeError('ASSESSMENT_PDF_PROBE_FILE_NOT_REGULAR', 'PDF 基础探针只接受普通文件。');
  }

  return {
    stagedPath,
    realPath,
    rootRealPath,
    snapshot: {
      dev: descriptorStat.dev,
      ino: descriptorStat.ino,
      size: descriptorStat.size,
      mtimeMs: descriptorStat.mtimeMs,
      ctimeMs: descriptorStat.ctimeMs,
    },
  };
}

function resolveExecutable(executableInput) {
  const executablePath = requireAbsolutePath(
    executableInput,
    'ASSESSMENT_PDF_PROBE_TOOL_UNAVAILABLE',
    'PDF 基础探针工具不可用。',
  );
  try {
    const executableRealPath = fs.realpathSync(executablePath);
    const stat = fs.statSync(executableRealPath);
    if (!stat.isFile()) throw new Error('not a file');
    fs.accessSync(executableRealPath, fs.constants.X_OK);
    return executableRealPath;
  } catch {
    throw probeError('ASSESSMENT_PDF_PROBE_TOOL_UNAVAILABLE', 'PDF 基础探针工具不可用。');
  }
}

function isSameSnapshot(fileInfo) {
  try {
    const currentPathStat = fs.lstatSync(fileInfo.stagedPath);
    const currentRealPath = fs.realpathSync(fileInfo.stagedPath);
    const currentStat = fs.statSync(currentRealPath);
    return !currentPathStat.isSymbolicLink()
      && currentRealPath === fileInfo.realPath
      && currentStat.isFile()
      && currentStat.dev === fileInfo.snapshot.dev
      && currentStat.ino === fileInfo.snapshot.ino
      && currentStat.size === fileInfo.snapshot.size
      && currentStat.mtimeMs === fileInfo.snapshot.mtimeMs
      && currentStat.ctimeMs === fileInfo.snapshot.ctimeMs;
  } catch {
    return false;
  }
}

function parseProbeOutput(stdout) {
  if (stdout.includes('\uFFFD')) {
    throw probeError('ASSESSMENT_PDF_PROBE_OUTPUT_INVALID', 'PDF 基础探针返回格式无效。');
  }

  const pagesMatch = stdout.match(/^Pages:\s*([^\r\n]+)\s*$/mi);
  const encryptedMatch = stdout.match(/^Encrypted:\s*([^\r\n]+)\s*$/mi);
  const versionMatch = stdout.match(/^PDF version:\s*([^\r\n]+)\s*$/mi);
  const javascriptMatch = stdout.match(/^JavaScript:\s*([^\r\n]+)\s*$/mi);
  if (!pagesMatch || !encryptedMatch || !versionMatch) {
    throw probeError('ASSESSMENT_PDF_PROBE_OUTPUT_INVALID', 'PDF 基础探针返回格式无效。');
  }

  const encryptedValue = encryptedMatch[1].trim().toLowerCase();
  if (encryptedValue !== 'no') {
    if (encryptedValue.startsWith('yes')) {
      throw probeError('ASSESSMENT_PDF_PROBE_ENCRYPTED', 'PDF 基础探针拒绝加密文件。');
    }
    throw probeError('ASSESSMENT_PDF_PROBE_OUTPUT_INVALID', 'PDF 基础探针返回格式无效。');
  }

  if (javascriptMatch) {
    const javascriptValue = javascriptMatch[1].trim().toLowerCase();
    if (javascriptValue === 'yes') {
      throw probeError('ASSESSMENT_PDF_PROBE_JAVASCRIPT', 'PDF 基础探针拒绝活动脚本。');
    }
    if (javascriptValue !== 'no') {
      throw probeError('ASSESSMENT_PDF_PROBE_OUTPUT_INVALID', 'PDF 基础探针返回格式无效。');
    }
  }

  const pagesText = pagesMatch[1].trim();
  if (!/^\d+$/.test(pagesText)) {
    throw probeError('ASSESSMENT_PDF_PROBE_OUTPUT_INVALID', 'PDF 基础探针返回格式无效。');
  }
  const pages = Number(pagesText);
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > MAX_PAGES) {
    throw probeError('ASSESSMENT_PDF_PROBE_PAGE_COUNT', 'PDF 基础探针页数不符合限制。');
  }

  const pdfVersion = versionMatch[1].trim();
  if (!/^\d+\.\d+$/.test(pdfVersion)) {
    throw probeError('ASSESSMENT_PDF_PROBE_OUTPUT_INVALID', 'PDF 基础探针返回格式无效。');
  }

  return {
    pages,
    encrypted: false,
    pdf_version: pdfVersion,
    state: 'basic_probe_passed',
  };
}

function runProbeProcess(executablePath, fileInfo, limits, parserRunner) {
  return new Promise((resolve, reject) => {
    let child;
    let runner;
    try {
      runner = parserRunner(executablePath, [fileInfo.realPath], {
        inputPath: fileInfo.realPath,
        workingDirectory: fileInfo.rootRealPath,
        maxFileBytes: limits.maxStdoutBytes + limits.maxStderrBytes,
      });
      child = runner.child;
    } catch (error) {
      reject(probeError(
        (error && error.code) || 'ASSESSMENT_PARSER_SANDBOX_UNAVAILABLE',
        'PDF 基础探针隔离 runner 不可用。',
      ));
      return;
    }

    let terminalError = null;
    let spawnError = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer = null;
    const stdoutChunks = [];

    function stopWith(error) {
      if (terminalError) return;
      terminalError = error;
      runner.kill();
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > limits.maxStdoutBytes) {
        stopWith(probeError('ASSESSMENT_PDF_PROBE_STDOUT_LIMIT', 'PDF 基础探针输出超过限制。'));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > limits.maxStderrBytes) {
        stopWith(probeError('ASSESSMENT_PDF_PROBE_STDERR_LIMIT', 'PDF 基础探针诊断输出超过限制。'));
      }
    });

    child.on('error', (error) => {
      spawnError = error;
      clearTimeout(timer);
    });

    timer = setTimeout(() => {
      stopWith(probeError('ASSESSMENT_PDF_PROBE_TIMEOUT', 'PDF 基础探针执行超时。'));
    }, limits.timeoutMs);
    timer.unref?.();

    child.on('close', (code) => {
      clearTimeout(timer);
      const resourceError = runner.finish();
      if (resourceError) {
        reject(probeError(resourceError.code, resourceError.message));
        return;
      }
      if (terminalError) {
        reject(terminalError);
        return;
      }
      if (spawnError) {
        const codeName = spawnError && spawnError.code;
        reject(probeError(
          codeName === 'ENOENT' ? 'ASSESSMENT_PDF_PROBE_TOOL_UNAVAILABLE' : 'ASSESSMENT_PDF_PROBE_PROCESS_FAILED',
          codeName === 'ENOENT' ? 'PDF 基础探针工具不可用。' : 'PDF 基础探针执行失败。',
        ));
        return;
      }
      if (code !== 0) {
        reject(probeError('ASSESSMENT_PDF_PROBE_PROCESS_FAILED', 'PDF 基础探针执行失败。'));
        return;
      }
      if (!isSameSnapshot(fileInfo)) {
        reject(probeError('ASSESSMENT_PDF_PROBE_FILE_CHANGED', 'PDF 基础探针输入在执行期间发生变化。'));
        return;
      }
      try {
        resolve(parseProbeOutput(Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8')));
      } catch (error) {
        reject(error instanceof AssessmentPdfProbeError
          ? error
          : probeError('ASSESSMENT_PDF_PROBE_OUTPUT_INVALID', 'PDF 基础探针返回格式无效。'));
      }
    });
  });
}

function runJavascriptInspection(executablePath, fileInfo, limits, parserRunner) {
  return new Promise((resolve, reject) => {
    let child;
    let runner;
    try {
      runner = parserRunner(executablePath, ['-js', fileInfo.realPath], {
        inputPath: fileInfo.realPath,
        workingDirectory: fileInfo.rootRealPath,
        maxFileBytes: limits.maxStdoutBytes + limits.maxStderrBytes,
      });
      child = runner.child;
    } catch (error) {
      reject(probeError(
        (error && error.code) || 'ASSESSMENT_PARSER_SANDBOX_UNAVAILABLE',
        'PDF 基础探针隔离 runner 不可用。',
      ));
      return;
    }

    let terminalError = null;
    let spawnError = null;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timer = null;

    function stopWith(error) {
      if (terminalError) return;
      terminalError = error;
      runner.kill();
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > limits.maxStdoutBytes) {
        stopWith(probeError('ASSESSMENT_PDF_PROBE_STDOUT_LIMIT', 'PDF 基础探针输出超过限制。'));
      }
      // Any JavaScript bytes are enough to reject; their content is never kept.
      if (chunk.toString('utf8').trim()) {
        stopWith(probeError('ASSESSMENT_PDF_PROBE_JAVASCRIPT', 'PDF 基础探针拒绝活动脚本。'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > limits.maxStderrBytes) {
        stopWith(probeError('ASSESSMENT_PDF_PROBE_STDERR_LIMIT', 'PDF 基础探针诊断输出超过限制。'));
      }
    });
    child.on('error', (error) => {
      spawnError = error;
      clearTimeout(timer);
    });
    timer = setTimeout(() => {
      stopWith(probeError('ASSESSMENT_PDF_PROBE_TIMEOUT', 'PDF 基础探针执行超时。'));
    }, limits.timeoutMs);
    timer.unref?.();
    child.on('close', (code) => {
      clearTimeout(timer);
      const resourceError = runner.finish();
      if (resourceError) return reject(probeError(resourceError.code, resourceError.message));
      if (terminalError) return reject(terminalError);
      if (spawnError) {
        return reject(probeError(
          spawnError.code === 'ENOENT' ? 'ASSESSMENT_PDF_PROBE_TOOL_UNAVAILABLE' : 'ASSESSMENT_PDF_PROBE_PROCESS_FAILED',
          spawnError.code === 'ENOENT' ? 'PDF 基础探针工具不可用。' : 'PDF 基础探针执行失败。',
        ));
      }
      if (code !== 0) return reject(probeError('ASSESSMENT_PDF_PROBE_PROCESS_FAILED', 'PDF 基础探针执行失败。'));
      if (!isSameSnapshot(fileInfo)) return reject(probeError('ASSESSMENT_PDF_PROBE_FILE_CHANGED', 'PDF 基础探针输入在执行期间发生变化。'));
      return resolve();
    });
  });
}

async function probeAssessmentPdf(stagedInput, options = {}) {
  const fileInfo = inspectStagedFile(stagedInput, options.stagingRoot);
  const executablePath = resolveExecutable(options.pdfinfoExecutablePath);
  const limits = {
    timeoutMs: normalizeTimeout(options.timeoutMs),
    maxStdoutBytes: normalizeLimit(
      options.maxStdoutBytes,
      DEFAULT_STDOUT_LIMIT,
      'ASSESSMENT_PDF_PROBE_STDOUT_LIMIT_INVALID',
    ),
    maxStderrBytes: normalizeLimit(
      options.maxStderrBytes,
      DEFAULT_STDERR_LIMIT,
      'ASSESSMENT_PDF_PROBE_STDERR_LIMIT_INVALID',
    ),
  };
  const parserRunner = options.parserRunner || spawnAssessmentParser;
  return runProbeProcess(executablePath, fileInfo, limits, parserRunner);
}

async function scanAssessmentPdf(stagedInput, options = {}) {
  const startedAt = Date.now();
  const fileInfo = inspectStagedFile(stagedInput, options.stagingRoot);
  const executablePath = resolveExecutable(options.pdfinfoExecutablePath);
  const limits = {
    timeoutMs: normalizeTimeout(options.timeoutMs),
    maxStdoutBytes: normalizeLimit(
      options.maxStdoutBytes,
      DEFAULT_STDOUT_LIMIT,
      'ASSESSMENT_PDF_PROBE_STDOUT_LIMIT_INVALID',
    ),
    maxStderrBytes: normalizeLimit(
      options.maxStderrBytes,
      DEFAULT_STDERR_LIMIT,
      'ASSESSMENT_PDF_PROBE_STDERR_LIMIT_INVALID',
    ),
  };
  const parserRunner = options.parserRunner || spawnAssessmentParser;
  const probe = await runProbeProcess(executablePath, fileInfo, limits, parserRunner);
  const remainingMs = limits.timeoutMs - (Date.now() - startedAt);
  if (remainingMs < 10) throw probeError('ASSESSMENT_PDF_PROBE_TIMEOUT', 'PDF 基础探针执行超时。');
  await runJavascriptInspection(executablePath, fileInfo, { ...limits, timeoutMs: remainingMs }, parserRunner);
  return {
    ...probe,
    activity_check: 'javascript_absent_raster_only',
    state: 'security_scan_passed',
  };
}

module.exports = {
  AssessmentPdfProbeError,
  DEFAULT_STDERR_LIMIT,
  DEFAULT_STDOUT_LIMIT,
  DEFAULT_TIMEOUT_MS,
  MAX_PAGES,
  scanAssessmentPdf,
  probeAssessmentPdf,
};
