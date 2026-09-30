const fs = require('fs');
const { execFileSync, spawn } = require('child_process');
const path = require('path');
const { getDesktopRuntimeExecutable } = require('./desktop-launcher');

const projectPackage = require('./package.json');
const expectedElectronVersion = String(
  (projectPackage.devDependencies && projectPackage.devDependencies.electron)
    || (projectPackage.dependencies && projectPackage.dependencies.electron)
    || '',
).trim();

function resolveElectronCandidate(request, dependencyRoot = '') {
  const packageRequest = path.isAbsolute(request)
    ? path.join(request, 'package.json')
    : `${request}/package.json`;
  const packagePath = require.resolve(packageRequest);
  const installedPackage = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  if (!expectedElectronVersion || installedPackage.version !== expectedElectronVersion) {
    throw new Error(
      `Electron 版本不匹配：需要 ${expectedElectronVersion || 'package.json 中的锁定版本'}，`
      + `实际为 ${installedPackage.version || '未知'}`,
    );
  }
  const electron = require(request);
  if (typeof electron !== 'string') {
    throw new Error(`Electron 可执行文件不存在：${String(electron || '未提供路径')}`);
  }
  let executableStat;
  try {
    executableStat = fs.statSync(electron);
  } catch (_error) {
    throw new Error(`Electron 可执行文件不存在：${electron}`);
  }
  if (!executableStat.isFile()) {
    throw new Error(`Electron 路径不是可执行文件：${electron}`);
  }
  if (process.platform !== 'win32') {
    try {
      fs.accessSync(electron, fs.constants.X_OK);
    } catch (_error) {
      throw new Error(`Electron 文件没有执行权限：${electron}`);
    }
  }
  return {
    electron,
    dependencyRoot: dependencyRoot || path.dirname(path.dirname(packagePath)),
  };
}

function resolvePrimaryWorktreeElectron() {
  const commonDirOutput = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: __dirname,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const commonDir = path.resolve(__dirname, String(commonDirOutput || '').trim());
  const primaryWorktreeRoot = path.dirname(commonDir);
  const dependencyRoot = path.join(primaryWorktreeRoot, 'node_modules');
  const electronModuleRoot = path.join(dependencyRoot, 'electron');
  return resolveElectronCandidate(electronModuleRoot, dependencyRoot);
}

function resolveElectronRuntime() {
  const failures = [];
  try {
    return resolveElectronCandidate('electron');
  } catch (error) {
    failures.push(error);
  }
  try {
    return resolveElectronCandidate(
      './electron-spike/node_modules/electron',
      path.join(__dirname, 'electron-spike', 'node_modules'),
    );
  } catch (error) {
    failures.push(error);
  }
  try {
    return resolvePrimaryWorktreeElectron();
  } catch (error) {
    failures.push(error);
  }
  const detail = failures.map((error) => error && error.message).filter(Boolean).join('；');
  throw new Error(
    `未找到 招才官 锁定的 Electron 运行时。请先运行 npm ci，`
    + `或确认同一 Git 仓库的主工作树已安装依赖。${detail ? ` ${detail}` : ''}`,
  );
}

function buildElectronNodePath(dependencyRoot, existingNodePath = '') {
  return [
    path.join(__dirname, 'node_modules'),
    path.join(__dirname, 'electron-spike', 'node_modules'),
    dependencyRoot,
    existingNodePath,
  ].filter((entry, index, entries) => entry && entries.indexOf(entry) === index).join(path.delimiter);
}

function launchCandidateUi() {
  const resolvedElectron = resolveElectronRuntime();
  const runtime = getDesktopRuntimeExecutable(resolvedElectron.electron);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.NODE_PATH = buildElectronNodePath(resolvedElectron.dependencyRoot, env.NODE_PATH);
  env.HRBOSS_LAUNCH_REQUIRE_PRIMARY = '1';

  const child = spawn(runtime, [__dirname], {
    stdio: 'inherit',
    env,
  });

  let settled = false;
  child.on('error', (error) => {
    if (settled) return;
    settled = true;
    console.error(`招才官 Electron 启动失败：${error.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (settled) return;
    settled = true;
    if (signal) process.kill(process.pid, signal);
    process.exit(code == null ? 1 : code);
  });
}

if (require.main === module) launchCandidateUi();

module.exports = {
  buildElectronNodePath,
  launchCandidateUi,
  resolveElectronCandidate,
  resolveElectronRuntime,
  resolvePrimaryWorktreeElectron,
};
