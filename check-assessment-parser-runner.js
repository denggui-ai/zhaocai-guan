'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assertMacSandboxAvailable,
  assertWindowsParserPath,
  killWindowsParserTree,
  spawnMacSandboxedParser,
  spawnWindowsConstrainedParser,
} = require('./assessment-parser-runner');

function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (check()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('synthetic parser process-group check timed out'));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
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
  throw new Error(`system ${executableName} executable not found for parser runner check`);
}

function syntheticStat(type, symbolic = false) {
  return {
    isDirectory: () => type === 'directory',
    isFile: () => type === 'file',
    isSymbolicLink: () => symbolic,
  };
}

function windowsFileSystem(entries) {
  const realpathSync = (target) => target;
  realpathSync.native = realpathSync;
  return {
    lstatSync(target) {
      if (!entries.has(target)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return entries.get(target);
    },
    realpathSync,
  };
}

function runWindowsPureChecks() {
  const executable = 'C:\\Tools\\parser.exe';
  const input = 'C:\\HRBOSS\\staged assessment.pdf';
  const workingDirectory = 'C:\\HRBOSS\\parser work';
  const outputRoot = 'C:\\HRBOSS\\parser output';
  const entries = new Map([
    [executable, syntheticStat('file')],
    [input, syntheticStat('file')],
    [workingDirectory, syntheticStat('directory')],
    [outputRoot, syntheticStat('directory')],
  ]);
  const fileSystem = windowsFileSystem(entries);
  const pathOptions = { platform: 'win32', fileSystem, reparseProbe: () => false };

  assert.equal(assertWindowsParserPath(input, 'file', pathOptions), input);
  assert.throws(
    () => assertWindowsParserPath('\\\\server\\share\\assessment.pdf', 'file', pathOptions),
    (error) => error.code === 'ASSESSMENT_PARSER_SANDBOX_INPUT_INVALID',
  );
  assert.throws(
    () => assertWindowsParserPath('C:\\HRBOSS\\assessment.pdf:secret', 'file', pathOptions),
    (error) => error.code === 'ASSESSMENT_PARSER_SANDBOX_INPUT_INVALID',
  );
  assert.throws(
    () => assertWindowsParserPath(input, 'file', { ...pathOptions, reparseProbe: () => true }),
    (error) => error.code === 'ASSESSMENT_WINDOWS_REPARSE_POINT_BLOCKED',
  );
  assert.throws(
    () => assertWindowsParserPath(input, 'file', {
      platform: 'win32',
      fileSystem,
      spawnSyncProcess: () => ({
        status: null,
        signal: null,
        error: Object.assign(new Error('missing'), { code: 'ENOENT' }),
      }),
    }),
    (error) => error.code === 'ASSESSMENT_WINDOWS_REPARSE_GATE_UNAVAILABLE',
  );
  assert.throws(
    () => assertWindowsParserPath(input, 'file', { ...pathOptions, platform: 'darwin' }),
    (error) => error.code === 'ASSESSMENT_PARSER_SANDBOX_PLATFORM_GATE',
  );

  let spawnCall = null;
  let taskkillCall = null;
  const child = {
    pid: 43210,
    exitCode: null,
    kill() { throw new Error('parent-only fallback must not run after successful taskkill'); },
  };
  const runner = spawnWindowsConstrainedParser(executable, ['--input', input], {
    inputPath: input,
    workingDirectory,
    outputRoot,
  }, {
    platform: 'win32',
    fileSystem,
    reparseProbe: () => false,
    environment: { SystemRoot: 'D:\\Windows' },
    spawnProcess(command, args, options) {
      spawnCall = { command, args, options };
      return child;
    },
    spawnSyncProcess(command, args, options) {
      taskkillCall = { command, args, options };
      return { status: 0, signal: null, error: null };
    },
  });
  assert.equal(spawnCall.command, executable);
  assert.deepEqual(spawnCall.args, ['--input', input]);
  assert.equal(spawnCall.options.cwd, workingDirectory);
  assert.equal(spawnCall.options.shell, false);
  assert.equal(spawnCall.options.env.TEMP, outputRoot);
  assert.equal(spawnCall.options.env.SystemRoot, 'D:\\Windows');
  runner.kill();
  assert.equal(taskkillCall.command, 'taskkill.exe');
  assert.deepEqual(taskkillCall.args, ['/PID', '43210', '/T', '/F']);
  assert.equal(runner.finish(), null);

  const fallbackSignals = [];
  const failedTermination = killWindowsParserTree({
    pid: 54321,
    exitCode: null,
    kill(signal) { fallbackSignals.push(signal); },
  }, {
    spawnSyncProcess: () => ({ status: 5, signal: null, error: null }),
  });
  assert.equal(failedTermination.code, 'ASSESSMENT_PARSER_TERMINATION_UNCONFIRMED');
  assert.deepEqual(failedTermination.diagnostic, { error_code: null, signal: null, status: 5 });
  assert.deepEqual(fallbackSignals, ['SIGKILL']);

  const thrownTermination = killWindowsParserTree({
    pid: 65432,
    exitCode: null,
    kill() {},
  }, {
    spawnSyncProcess() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  assert.equal(thrownTermination.code, 'ASSESSMENT_PARSER_TERMINATION_UNCONFIRMED');
  assert.equal(thrownTermination.diagnostic.error_code, 'ENOENT');

  const failedRunner = spawnWindowsConstrainedParser(executable, [input], {
    inputPath: input,
    workingDirectory,
  }, {
    platform: 'win32',
    fileSystem,
    reparseProbe: () => false,
    spawnProcess: () => ({ pid: 76543, exitCode: null, kill() {} }),
    spawnSyncProcess: () => ({ status: 5, signal: null, error: null }),
  });
  failedRunner.kill();
  assert.equal(failedRunner.finish().code, 'ASSESSMENT_PARSER_TERMINATION_UNCONFIRMED');
  console.log('check-assessment-parser-runner: Windows pure path/taskkill checks PASS');
}

async function runWindowsProcessTreeCheck() {
  const nodeExecutable = findSystemNodeExecutable();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss parser windows '));
  let descendantPid = null;
  try {
    const input = path.join(root, 'synthetic assessment.pdf');
    const script = path.join(root, 'spawn-descendant.js');
    const pidFile = path.join(root, 'descendant.pid');
    fs.writeFileSync(input, '%PDF-1.4\nsynthetic process tree only\n%%EOF\n', { mode: 0o600 });
    fs.writeFileSync(script, `'use strict';\n`
      + `const fs = require('fs');\n`
      + `const { spawn } = require('child_process');\n`
      + `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\n`
      + `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n`
      + `setInterval(() => {}, 1000);\n`, { mode: 0o600 });
    const runner = spawnWindowsConstrainedParser(nodeExecutable, [script, input], {
      inputPath: input,
      workingDirectory: root,
      outputRoot: root,
    });
    let parserClosed = false;
    runner.child.once('close', () => { parserClosed = true; });
    await waitFor(() => fs.existsSync(pidFile) || parserClosed);
    assert.equal(parserClosed, false, 'Windows synthetic parser exited before creating its descendant');
    descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.equal(processExists(descendantPid), true);
    runner.kill();
    if (!parserClosed) await new Promise((resolve) => runner.child.once('close', resolve));
    assert.equal(runner.finish(), null, 'taskkill /T /F result must be confirmed');
    await waitFor(() => !processExists(descendantPid));
    descendantPid = null;
    console.log('check-assessment-parser-runner: Windows real process-tree kill PASS');
  } finally {
    if (descendantPid && processExists(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runMacProcessGroupCheck() {
  assertMacSandboxAvailable();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss parser group '));
  fs.chmodSync(root, 0o700);
  let descendantPid = null;
  try {
    const input = path.join(root, 'synthetic assessment.pdf');
    const pidFile = path.join(root, 'descendant.pid');
    fs.writeFileSync(input, '%PDF-1.4\nsynthetic process group only\n%%EOF\n', { mode: 0o600 });
    const nodeExecutable = findSystemNodeExecutable();
    const tool = path.join(root, 'spawn-descendant');
    const source = `#!${nodeExecutable}\n`
      + `'use strict';\n`
      + `const fs = require('fs');\n`
      + `const { spawn } = require('child_process');\n`
      + `const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });\n`
      + `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n`
      + `setInterval(() => {}, 1000);\n`;
    fs.writeFileSync(tool, source, { mode: 0o700 });
    const runner = spawnMacSandboxedParser(tool, [input], {
      inputPath: input,
      workingDirectory: root,
      outputRoot: root,
    });
    let parserClosed = false;
    let parserExitCode = null;
    let parserStderr = '';
    runner.child.stderr.on('data', (chunk) => { parserStderr += chunk.toString('utf8'); });
    runner.child.once('close', (code) => { parserClosed = true; parserExitCode = code; });
    await waitFor(() => fs.existsSync(pidFile) || parserClosed);
    if (!fs.existsSync(pidFile)) {
      assert.notEqual(parserExitCode, 0);
      assert.match(parserStderr, /spawn EPERM/,
        'sandbox must deny descendant creation when it cannot keep the descendant in the parser process group');
      runner.finish();
      console.log('check-assessment-parser-runner: spaced temp path and descendant spawn denied PASS');
      return;
    }
    descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.equal(processExists(descendantPid), true);
    runner.kill();
    if (!parserClosed) await new Promise((resolve) => runner.child.once('close', resolve));
    runner.finish();
    await waitFor(() => !processExists(descendantPid));
    descendantPid = null;
    console.log('check-assessment-parser-runner: spaced temp path and process-group kill PASS');
  } finally {
    if (descendantPid && processExists(descendantPid)) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function run() {
  runWindowsPureChecks();
  if (process.platform === 'win32') {
    await runWindowsProcessTreeCheck();
    return;
  }
  if (process.platform !== 'darwin') {
    assert.throws(() => assertMacSandboxAvailable(),
      (error) => error.code === 'ASSESSMENT_PARSER_SANDBOX_PLATFORM_GATE');
    console.log('check-assessment-parser-runner: platform gate PASS');
    return;
  }
  await runMacProcessGroupCheck();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
