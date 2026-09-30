'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { EventEmitter } = require('events');

const mainSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/candidate-main.js"), 'utf8');
const launcherSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/start-candidate-ui.js"), 'utf8');
const desktopLauncherSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/desktop-launcher.js"), 'utf8');
const runnerSource = fs.readFileSync(path.join(PROJECT_ROOT, "tests/check-suite-runner.js"), 'utf8');
const uiRunnerSource = fs.readFileSync(path.join(PROJECT_ROOT, "tests/check-ui-suite.js"), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing ${name}`);
  const paramsStart = source.indexOf('(', start);
  let paramsDepth = 0;
  let bodyStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    if (source[index] === '(') paramsDepth += 1;
    else if (source[index] === ')') {
      paramsDepth -= 1;
      if (paramsDepth === 0) {
        bodyStart = source.indexOf('{', index);
        break;
      }
    }
  }
  assert.notEqual(bodyStart, -1, `missing body for ${name}`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

const lockStatement = 'const singleInstanceLockAcquired = app.requestSingleInstanceLock();';
const lockIndex = mainSource.indexOf(lockStatement);
const lifecycleSource = extractFunction(mainSource, 'registerPrimaryApplicationLifecycle');
const lifecycleIndex = mainSource.indexOf(lifecycleSource);
const startServerInvocation = mainSource.indexOf('await startServer();');

assert.ok(lockIndex >= 0, 'main process must request the Electron single-instance lock');
assert.ok(lockIndex < lifecycleIndex, 'lock must be decided before primary lifecycle registration');
assert.ok(lockIndex < startServerInvocation, 'lock must be decided before local services and SQLite writers start');
assert.equal((mainSource.match(/app\.whenReady\(\)/g) || []).length, 1,
  'there must be exactly one guarded whenReady startup path');
assert.match(lifecycleSource, /app\.on\('second-instance',\s*focusPrimaryWindow\);/,
  'the primary instance must handle later launches');
assert.match(lifecycleSource, /app\.whenReady\(\)[\s\S]*?await startServer\(\);[\s\S]*?createWindow\(\);/,
  'the guarded primary path must own service startup and window creation');
assert.match(mainSource,
  /if \(!singleInstanceLockAcquired\) \{[\s\S]*?HRBOSS_LAUNCH_REQUIRE_PRIMARY[\s\S]*?app\.exit\(2\);[\s\S]*?app\.quit\(\);[\s\S]*?\} else \{\s*registerPrimaryApplicationLifecycle\(\);\s*\}/,
  'a secondary development launch must report failure while ordinary secondary launches quit without registering startup');

const focusSource = extractFunction(mainSource, 'focusPrimaryWindow');
const calls = [];
const context = vm.createContext({
  win: {
    isMinimized: () => true,
    isVisible: () => false,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  },
  isDestroyed: (target) => !target,
});
vm.runInContext(`${focusSource}\nthis.focusPrimaryWindow = focusPrimaryWindow;`, context);
assert.equal(context.focusPrimaryWindow(), true);
assert.deepEqual(calls, ['restore', 'show', 'focus'],
  'a later launch must restore, show and focus the existing main window');
context.win = null;
assert.equal(context.focusPrimaryWindow(), false, 'a launch arriving before window creation must remain harmless');

function probeLauncher(eventName, eventArgs, options = {}) {
  const child = new EventEmitter();
  const spawnCalls = [];
  const exits = [];
  const errors = [];
  const runtimeInputs = [];
  const syntheticLocalDependencyRoot = path.join(path.parse(PROJECT_ROOT).root, 'synthetic', 'local-node-modules');
  const syntheticLocalElectronRoot = path.join(syntheticLocalDependencyRoot, 'electron');
  const syntheticLocalPackagePath = path.join(syntheticLocalElectronRoot, 'package.json');
  const syntheticLocalExecutable = path.join(syntheticLocalElectronRoot, 'dist', 'Electron');
  const syntheticExternalDependencyRoot = '/synthetic/external-node-modules';
  const syntheticExternalElectronRoot = path.join(syntheticExternalDependencyRoot, 'electron');
  const syntheticExternalPackagePath = path.join(syntheticExternalElectronRoot, 'package.json');
  const syntheticExternalExecutable = path.join(syntheticExternalElectronRoot, 'dist', 'Electron');
  const syntheticPrimaryRoot = path.join(path.parse(PROJECT_ROOT).root, 'synthetic', 'repository');
  const syntheticCommonDir = path.join(syntheticPrimaryRoot, '.git');
  const syntheticDependencyRoot = path.join(syntheticPrimaryRoot, 'node_modules');
  const syntheticElectronRoot = path.join(syntheticDependencyRoot, 'electron');
  const syntheticSharedPackagePath = path.join(syntheticElectronRoot, 'package.json');
  const syntheticSharedExecutable = path.join(syntheticElectronRoot, 'dist', 'Electron');
  const externalCandidate = options.externalElectron || null;
  const selectedPackagePath = externalCandidate
    ? syntheticExternalPackagePath
    : syntheticLocalPackagePath;
  const selectedExecutable = externalCandidate
    ? syntheticExternalExecutable
    : syntheticLocalExecutable;
  const selectedVersion = externalCandidate ? externalCandidate.version : '42.5.1';
  const selectedExecutableExists = externalCandidate
    ? externalCandidate.executableExists !== false
    : true;
  const selectedExecutableIsFile = externalCandidate
    ? externalCandidate.executableIsFile !== false
    : true;
  const selectedExecutableIsExecutable = externalCandidate
    ? externalCandidate.executableIsExecutable !== false
    : true;
  const expectsSharedFallback = options.usePrimaryWorktree === true
    || (externalCandidate && (
      externalCandidate.version !== '42.5.1'
      || externalCandidate.executableExists === false
      || externalCandidate.executableIsFile === false
      || externalCandidate.executableIsExecutable === false
    ));
  const processMock = {
    env: { NODE_PATH: syntheticExternalDependencyRoot, ELECTRON_RUN_AS_NODE: '1' },
    platform: 'darwin',
    pid: 4321,
    exit: (code) => exits.push(code),
    kill: () => {},
  };
  const requireMock = (request) => {
    if (request === 'fs') {
      return {
        constants: { X_OK: 1 },
        existsSync: (target) => {
          if (path.normalize(target) === path.normalize(selectedExecutable)) {
            return selectedExecutableExists;
          }
          if (path.normalize(target) === path.normalize(syntheticSharedExecutable)) return true;
          return false;
        },
        readFileSync: (target) => {
          const normalized = path.normalize(target);
          if (normalized === path.normalize(selectedPackagePath)) {
            return JSON.stringify({ version: selectedVersion });
          }
          if (normalized === path.normalize(syntheticSharedPackagePath)) {
            return JSON.stringify({ version: options.installedElectronVersion || '42.5.1' });
          }
          throw new Error(`unexpected package read: ${target}`);
        },
        statSync: (target) => {
          const normalized = path.normalize(target);
          if (normalized === path.normalize(selectedExecutable)) {
            if (!selectedExecutableExists) throw new Error('ENOENT');
            return { isFile: () => selectedExecutableIsFile };
          }
          if (normalized === path.normalize(syntheticSharedExecutable)) {
            return { isFile: () => true };
          }
          throw new Error(`unexpected executable stat: ${target}`);
        },
        accessSync: (target) => {
          const normalized = path.normalize(target);
          if (normalized === path.normalize(selectedExecutable)) {
            if (!selectedExecutableIsExecutable) throw new Error('EACCES');
            return;
          }
          if (normalized === path.normalize(syntheticSharedExecutable)) return;
          throw new Error(`unexpected executable access: ${target}`);
        },
      };
    }
    if (request === 'child_process') {
      return {
        execFileSync: (command, args) => {
          assert.equal(expectsSharedFallback, true,
            'git dependency lookup must only run after both local Electron candidates fail validation');
          assert.equal(command, 'git');
          assert.deepEqual(Array.from(args), ['rev-parse', '--git-common-dir']);
          return `${syntheticCommonDir}\n`;
        },
        spawn: (...args) => {
          spawnCalls.push(args);
          return child;
        },
      };
    }
    if (request === 'path') return path;
    if (request === './paths') return { PROJECT_ROOT };
    if (request === 'electron') {
      assert.notEqual(options.usePrimaryWorktree, true,
        'a missing local Electron package must fail during package resolution before executing module code');
      return selectedExecutable;
    }
    if (request === '../electron-spike/node_modules/electron') {
      throw new Error('synthetic bundled Electron module must not execute when its package is absent');
    }
    if (request === '../package.json') {
      return { devDependencies: { electron: '42.5.1' } };
    }
    if (request === syntheticElectronRoot) return syntheticSharedExecutable;
    if (request === './desktop-launcher') {
      return {
        getDesktopRuntimeExecutable: (electron) => {
          runtimeInputs.push(electron);
          return '/synthetic/runtime-electron';
        },
      };
    }
    throw new Error(`unexpected launcher dependency: ${request}`);
  };
  requireMock.resolve = (request) => {
    if (request === 'electron/package.json') {
      if (options.usePrimaryWorktree) throw new Error('synthetic local Electron package missing');
      return selectedPackagePath;
    }
    if (request === '../electron-spike/node_modules/electron/package.json') {
      throw new Error('synthetic bundled Electron package missing');
    }
    if (request === syntheticSharedPackagePath) return syntheticSharedPackagePath;
    throw new Error(`unexpected launcher resolution: ${request}`);
  };
  const context = vm.createContext({ PROJECT_ROOT,
    __dirname: PROJECT_ROOT,
    console: { error: (message) => errors.push(String(message)) },
    module: { exports: {} },
    process: processMock,
    require: requireMock,
  });
  requireMock.main = context.module;
  vm.runInContext(launcherSource, context);
  child.emit(eventName, ...eventArgs);
  return {
    spawnCalls,
    exits,
    errors,
    runtimeInputs,
    syntheticLocalDependencyRoot,
    syntheticDependencyRoot,
    syntheticSharedExecutable,
  };
}

const missingRuntimeProbe = probeLauncher('error', [Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })]);
assert.equal(missingRuntimeProbe.spawnCalls.length, 1);
const [, , spawnedOptions] = missingRuntimeProbe.spawnCalls[0];
assert.equal(spawnedOptions.env.ELECTRON_RUN_AS_NODE, undefined);
assert.equal(spawnedOptions.env.HRBOSS_LAUNCH_REQUIRE_PRIMARY, '1');
assert.deepEqual(spawnedOptions.env.NODE_PATH.split(path.delimiter), [
  path.join(PROJECT_ROOT, 'node_modules'),
  path.join(PROJECT_ROOT, 'electron-spike', 'node_modules'),
  missingRuntimeProbe.syntheticLocalDependencyRoot,
  '/synthetic/external-node-modules',
], 'launcher must preserve externally resolved dependencies after local dependency roots');
assert.deepEqual(missingRuntimeProbe.exits, [1], 'spawn ENOENT must fail the npm ui launcher');
assert.match(missingRuntimeProbe.errors.join('\n'), /招才官 Electron 启动失败：spawn ENOENT/);

const secondaryProbe = probeLauncher('exit', [2, null]);
assert.deepEqual(secondaryProbe.exits, [2],
  'a launcher whose Electron process did not establish the primary window must fail instead of reporting success');

const sharedWorktreeProbe = probeLauncher('exit', [2, null], { usePrimaryWorktree: true });
assert.deepEqual(sharedWorktreeProbe.runtimeInputs, [sharedWorktreeProbe.syntheticSharedExecutable],
  'a linked worktree without local dependencies must reuse the primary worktree locked Electron runtime');
const [, , sharedSpawnOptions] = sharedWorktreeProbe.spawnCalls[0];
assert.deepEqual(sharedSpawnOptions.env.NODE_PATH.split(path.delimiter), [
  path.join(PROJECT_ROOT, 'node_modules'),
  path.join(PROJECT_ROOT, 'electron-spike', 'node_modules'),
  sharedWorktreeProbe.syntheticDependencyRoot,
  '/synthetic/external-node-modules',
], 'the primary worktree dependency root must be available to Electron child services');
assert.throws(
  () => probeLauncher('exit', [2, null], {
    usePrimaryWorktree: true,
    installedElectronVersion: '41.0.0',
  }),
  /Electron 版本不匹配：需要 42\.5\.1，实际为 41\.0\.0/,
  'the launcher must reject a primary worktree Electron version that differs from package.json',
);
const staleNodePathProbe = probeLauncher('exit', [2, null], {
  externalElectron: { version: '41.0.0', executableExists: true },
});
assert.deepEqual(staleNodePathProbe.runtimeInputs, [staleNodePathProbe.syntheticSharedExecutable],
  'a stale Electron from NODE_PATH must be rejected before module execution and fall back to the locked runtime');
const missingExecutableProbe = probeLauncher('exit', [2, null], {
  externalElectron: { version: '42.5.1', executableExists: false },
});
assert.deepEqual(missingExecutableProbe.runtimeInputs, [missingExecutableProbe.syntheticSharedExecutable],
  'a version-matched Electron package with a missing executable must fall back to the locked runtime');
const directoryExecutableProbe = probeLauncher('exit', [2, null], {
  externalElectron: {
    version: '42.5.1',
    executableExists: true,
    executableIsFile: false,
  },
});
assert.deepEqual(directoryExecutableProbe.runtimeInputs, [directoryExecutableProbe.syntheticSharedExecutable],
  'a version-matched Electron package that exports a directory must fall back to the locked runtime');
const nonExecutableProbe = probeLauncher('exit', [2, null], {
  externalElectron: {
    version: '42.5.1',
    executableExists: true,
    executableIsFile: true,
    executableIsExecutable: false,
  },
});
assert.deepEqual(nonExecutableProbe.runtimeInputs, [nonExecutableProbe.syntheticSharedExecutable],
  'a version-matched Electron package without execute permission must fall back to the locked runtime');
assert.match(desktopLauncherSource,
  /resolvedExecutable[\s\S]*?resolvedApp[\s\S]*?fs\.existsSync\(resolvedInfo\) \? resolvedApp : bundledApp/,
  'macOS branding must reuse the Electron executable that the launcher actually resolved');

assert.ok(require('./check-suite-runner').SUITES.precheck.includes('tests/check-macos-single-instance-001.js'),
  'single-instance regression must be part of the standard npm check lifecycle');
assert.match(runnerSource,
  /require\(['"]\.\.\/src\/start-candidate-ui['"]\)[\s\S]*?resolveElectronRuntime\(\)[\s\S]*?buildElectronNodePath\(resolvedElectron\.dependencyRoot,\s*env\.NODE_PATH\)/,
  'the standard check runner must reuse the validated launcher runtime and dependency path');
assert.doesNotMatch(runnerSource, /require\(['"]electron['"]\)/,
  'the check runner must not bypass the validated linked-worktree Electron resolver');
assert.match(uiRunnerSource,
  /resolveElectronRuntime\(\)[\s\S]*?buildElectronNodePath\(resolvedElectron\.dependencyRoot,\s*env\.NODE_PATH\)[\s\S]*?spawnSync\(resolvedElectron\.electron/,
  'the native UI runner must reuse the validated launcher runtime and dependency path');
assert.doesNotMatch(uiRunnerSource, /require\(['"]electron['"]\)/,
  'the native UI runner must not bypass the validated linked-worktree Electron resolver');

console.log(JSON.stringify({
  ok: true,
  contract: 'MACOS-SINGLE-INSTANCE-001',
  lock_before_services: true,
  secondary_skips_startup: true,
  launcher_spawn_error_is_nonzero: true,
  launcher_secondary_is_nonzero: true,
  launcher_dependency_path_preserved: true,
  launcher_primary_worktree_fallback: true,
  launcher_primary_worktree_version_locked: true,
  launcher_all_sources_version_locked: true,
  launcher_missing_executable_rejected: true,
  launcher_directory_executable_rejected: true,
  launcher_non_executable_rejected: true,
  launcher_resolved_runtime_reused: true,
  runner_shared_runtime_resolution: true,
  runner_dependency_path_preserved: true,
  ui_runner_shared_runtime_resolution: true,
  ui_runner_dependency_path_preserved: true,
  focus_sequence: calls,
  standard_gate: 'precheck',
}));
