'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const {
  assertWindowsPathEntrySafe,
  normalizeLocalWindowsPath,
} = require('./windows-assessment-guard');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const PS_EXEC = '/bin/ps';
const DEFAULT_MEMORY_BYTES = 512 * 1024 * 1024;
const MAX_MEMORY_BYTES = DEFAULT_MEMORY_BYTES;
// How long the memory cap may go unmeasured before the parse is stopped. The
// budget is in time rather than sample count so that the exposure is the same
// whether samples fail instantly or only after the /bin/ps timeout.
const MAX_UNMEASURED_MS = 500;

class AssessmentParserRunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AssessmentParserRunnerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AssessmentParserRunnerError(code, message);
}

function schemeString(value) {
  return JSON.stringify(String(value));
}

function requireRegularExecutable(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) {
    fail('ASSESSMENT_PARSER_SANDBOX_UNAVAILABLE', 'Assessment PDF 隔离 runner 不可用。');
  }
  try {
    const real = fs.realpathSync(input);
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new Error('not file');
    fs.accessSync(real, fs.constants.X_OK);
    return real;
  } catch {
    fail('ASSESSMENT_PARSER_SANDBOX_UNAVAILABLE', 'Assessment PDF 隔离 runner 不可用。');
  }
}

function interpreterFor(executable) {
  const descriptor = fs.openSync(executable, 'r');
  try {
    const header = Buffer.alloc(512);
    const count = fs.readSync(descriptor, header, 0, header.length, 0);
    const text = header.subarray(0, count).toString('utf8');
    if (!text.startsWith('#!')) return null;
    const firstLine = text.split(/\r?\n/, 1)[0].slice(2).trim();
    const interpreter = firstLine.split(/\s+/, 1)[0];
    return interpreter && path.isAbsolute(interpreter) ? requireRegularExecutable(interpreter) : null;
  } finally {
    fs.closeSync(descriptor);
  }
}

function trustedDependencyRoots(executable, interpreter) {
  const roots = new Set();
  for (const candidate of [executable, interpreter]) {
    if (!candidate) continue;
    for (const prefix of ['/opt/homebrew', '/usr/local']) {
      if (candidate === prefix || candidate.startsWith(`${prefix}${path.sep}`)) roots.add(prefix);
    }
  }
  return [...roots];
}

function profileFor({ executable, interpreter, inputPath, outputRoot }) {
  const readLiterals = [executable, inputPath, interpreter].filter(Boolean);
  const readSubpaths = [
    '/System', '/usr/lib', '/usr/share', '/private/var/db/timezone',
    ...trustedDependencyRoots(executable, interpreter),
  ];
  const lines = [
    '(version 1)',
    '(import "dyld-support.sb")',
    '(deny default)',
    '(deny network*)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    // Metadata-only traversal is required by dyld/getcwd. File contents remain
    // restricted to the explicit literals/subpaths below.
    '(allow file-read-metadata)',
    `(allow file-read* ${readLiterals.map((item) => `(literal ${schemeString(item)})`).join(' ')})`,
    `(allow file-read* ${readSubpaths.map((item) => `(subpath ${schemeString(item)})`).join(' ')})`,
    '(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
  ];
  if (outputRoot) lines.push(`(allow file-write* (subpath ${schemeString(outputRoot)}))`);
  return `${lines.join('\n')}\n`;
}

function normalizeResource(value, fallback, maximum, code) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) fail(code, 'Assessment PDF 隔离资源限制无效。');
  return value;
}

function processTreeRss(rootPid) {
  const result = spawnSync(PS_EXEC, ['-axo', 'pid=,ppid=,rss='], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 2000,
  });
  if (result.status !== 0 || result.error) fail('ASSESSMENT_PARSER_SANDBOX_UNAVAILABLE', 'Assessment PDF 隔离 runner 不可用。');
  const children = new Map();
  const rss = new Map();
  for (const line of String(result.stdout || '').split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    rss.set(pid, Number(match[3]) * 1024);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  let total = 0;
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += rss.get(pid) || 0;
    stack.push(...(children.get(pid) || []));
  }
  return total;
}

function assertMacSandboxAvailable() {
  if (process.platform !== 'darwin') {
    fail('ASSESSMENT_PARSER_SANDBOX_PLATFORM_GATE', 'Assessment PDF 隔离 runner 尚未通过当前平台门禁。');
  }
  for (const executable of [SANDBOX_EXEC, PS_EXEC]) requireRegularExecutable(executable);
}

function killParserProcessGroup(child) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function killWindowsParserTree(child, options = {}) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0
      || (child.exitCode !== undefined && child.exitCode !== null)) return null;
  const spawnSyncProcess = options.spawnSyncProcess || spawnSync;
  let result;
  try {
    result = spawnSyncProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 5000,
      stdio: 'ignore',
    });
  } catch (error) {
    result = { error, status: null, signal: null };
  }
  result = result || { error: new Error('taskkill returned no result'), status: null, signal: null };
  if (!result.error && result.status === 0 && !result.signal) return null;
  try { child.kill('SIGKILL'); } catch {}
  const error = new AssessmentParserRunnerError(
    'ASSESSMENT_PARSER_TERMINATION_UNCONFIRMED',
    'Assessment PDF Windows 解析进程树终止未确认。',
  );
  error.diagnostic = {
    error_code: result.error && result.error.code ? String(result.error.code) : null,
    signal: result.signal ? String(result.signal) : null,
    status: Number.isInteger(result.status) ? result.status : null,
  };
  return error;
}

function assertWindowsParserPath(input, expectedType, options = {}) {
  if ((options.platform || process.platform) !== 'win32') {
    fail('ASSESSMENT_PARSER_SANDBOX_PLATFORM_GATE', 'Assessment PDF Windows runner 尚未通过当前平台门禁。');
  }
  const fileSystem = options.fileSystem || fs;
  try {
    const requested = normalizeLocalWindowsPath(input);
    assertWindowsPathEntrySafe(requested, expectedType, options);
    const realpath = fileSystem.realpathSync.native || fileSystem.realpathSync;
    return normalizeLocalWindowsPath(realpath(requested));
  } catch (error) {
    if (error && [
      'ASSESSMENT_WINDOWS_REPARSE_GATE_UNAVAILABLE',
      'ASSESSMENT_WINDOWS_REPARSE_POINT_BLOCKED',
    ].includes(error.code)) throw error;
    fail('ASSESSMENT_PARSER_SANDBOX_INPUT_INVALID', 'Assessment PDF Windows runner 输入无效。');
  }
}

function spawnWindowsConstrainedParser(executableInput, args, options = {}, dependencies = {}) {
  const pathOptions = {
    platform: dependencies.platform,
    fileSystem: dependencies.fileSystem,
    reparseProbe: dependencies.reparseProbe,
    spawnSyncProcess: dependencies.spawnSyncProcess,
  };
  const executable = assertWindowsParserPath(executableInput, 'file', pathOptions);
  const inputPath = assertWindowsParserPath(String(options.inputPath || ''), 'file', pathOptions);
  const workingDirectory = assertWindowsParserPath(String(options.workingDirectory || ''), 'directory', pathOptions);
  const outputRoot = options.outputRoot
    ? assertWindowsParserPath(String(options.outputRoot), 'directory', pathOptions)
    : null;
  const normalizedArgs = args.map((argument) => (
    path.win32.normalize(String(argument)) === path.win32.normalize(String(options.inputPath || ''))
      ? inputPath
      : String(argument)
  ));
  const environment = dependencies.environment || process.env;
  const systemRoot = String(environment.SystemRoot || environment.WINDIR || 'C:\\Windows');
  const spawnProcess = dependencies.spawnProcess || spawn;
  const child = spawnProcess(executable, normalizedArgs, {
    cwd: workingDirectory,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
      TEMP: outputRoot || workingDirectory,
      TMP: outputRoot || workingDirectory,
      LANG: 'C',
    },
  });
  let terminationError = null;
  let terminationRequested = false;
  return {
    child,
    kill() {
      if (terminationRequested) return;
      terminationRequested = true;
      terminationError = killWindowsParserTree(child, dependencies);
    },
    finish() { return terminationError; },
  };
}

function spawnAssessmentParser(executableInput, args, options = {}) {
  if (process.platform === 'darwin') return spawnMacSandboxedParser(executableInput, args, options);
  if (process.platform === 'win32') return spawnWindowsConstrainedParser(executableInput, args, options);
  fail('ASSESSMENT_PARSER_SANDBOX_PLATFORM_GATE', 'Assessment PDF 隔离 runner 尚未通过当前平台门禁。');
}

function spawnMacSandboxedParser(executableInput, args, options = {}) {
  assertMacSandboxAvailable();
  const executable = requireRegularExecutable(executableInput);
  const requestedInputPath = path.resolve(String(options.inputPath || ''));
  if (!path.isAbsolute(String(options.inputPath || '')) || !fs.statSync(requestedInputPath).isFile()) {
    fail('ASSESSMENT_PARSER_SANDBOX_INPUT_INVALID', 'Assessment PDF 隔离输入无效。');
  }
  const inputPath = fs.realpathSync(requestedInputPath);
  const requestedWorkingDirectory = path.resolve(String(options.workingDirectory || ''));
  if (!path.isAbsolute(String(options.workingDirectory || '')) || !fs.statSync(requestedWorkingDirectory).isDirectory()) {
    fail('ASSESSMENT_PARSER_SANDBOX_INPUT_INVALID', 'Assessment PDF 隔离目录无效。');
  }
  const workingDirectory = fs.realpathSync(requestedWorkingDirectory);
  const requestedOutputRoot = options.outputRoot ? path.resolve(String(options.outputRoot)) : null;
  if (requestedOutputRoot && (!path.isAbsolute(String(options.outputRoot)) || !fs.statSync(requestedOutputRoot).isDirectory())) {
    fail('ASSESSMENT_PARSER_SANDBOX_INPUT_INVALID', 'Assessment PDF 隔离输出目录无效。');
  }
  const outputRoot = requestedOutputRoot ? fs.realpathSync(requestedOutputRoot) : null;
  const maxMemoryBytes = normalizeResource(
    options.maxMemoryBytes,
    DEFAULT_MEMORY_BYTES,
    MAX_MEMORY_BYTES,
    'ASSESSMENT_PARSER_MEMORY_LIMIT_INVALID',
  );
  const interpreter = interpreterFor(executable);
  const profile = profileFor({ executable, interpreter, inputPath, outputRoot });
  const normalizedArgs = args.map((argument) => (
    path.resolve(String(argument)) === requestedInputPath ? inputPath : String(argument)
  ));
  const child = spawn(SANDBOX_EXEC, [
    '-p', profile, executable, ...normalizedArgs,
  ], {
    cwd: workingDirectory,
    // A separate process group lets every timeout/resource failure terminate
    // the parser and all descendants, including children that re-parent later.
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
  });

  let resourceError = null;
  let blindSince = null;
  const monitor = setInterval(() => {
    const attemptStartedAt = Date.now();
    try {
      if (processTreeRss(child.pid) > maxMemoryBytes) {
        resourceError = new AssessmentParserRunnerError(
          'ASSESSMENT_PARSER_MEMORY_LIMIT',
          'Assessment PDF 隔离进程超过内存限制。',
        );
        killParserProcessGroup(child);
        return;
      }
      blindSince = null;
    } catch (error) {
      // Sampling shells out to /bin/ps every 50ms and can fail transiently under
      // process pressure. One missed sample is not evidence the runner is
      // unusable — assertMacSandboxAvailable already proved /bin/ps exists at
      // spawn time — and treating it as fatal aborts an otherwise healthy parse.
      // Staying blind is different, because the memory cap is then unenforced,
      // so the parse is stopped once sampling has been failing for too long.
      //
      // The budget runs from the start of the first failing attempt, not from
      // the last success: time the event loop spent busy before this attempt is
      // not time the sampler was broken, and counting it would resurrect the
      // spurious failures under load that this budget exists to prevent. A
      // failure that burns the full ps timeout therefore exceeds the budget on
      // its own and still stops the parse immediately.
      if (blindSince === null) blindSince = attemptStartedAt;
      if (Date.now() - blindSince < MAX_UNMEASURED_MS) return;
      resourceError = error instanceof AssessmentParserRunnerError
        ? error
        : new AssessmentParserRunnerError('ASSESSMENT_PARSER_SANDBOX_UNAVAILABLE', 'Assessment PDF 隔离 runner 不可用。');
      killParserProcessGroup(child);
    }
  }, 50);
  monitor.unref?.();

  return {
    child,
    kill() {
      killParserProcessGroup(child);
    },
    finish() {
      clearInterval(monitor);
      return resourceError;
    },
  };
}

module.exports = {
  AssessmentParserRunnerError,
  DEFAULT_MEMORY_BYTES,
  assertMacSandboxAvailable,
  assertWindowsParserPath,
  killParserProcessGroup,
  killWindowsParserTree,
  spawnAssessmentParser,
  spawnMacSandboxedParser,
  spawnWindowsConstrainedParser,
};
