const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const ICACLS_MAX_BUFFER = 4 * 1024 * 1024;

// 所有含候选人、访谈或登录态的子进程都默认以最小权限创建文件。
if (process.platform !== 'win32') process.umask(0o077);

let cachedWindowsIdentity;

const WINDOWS_REPARSE_SCANNER = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$inputPath = [Environment]::GetEnvironmentVariable('HRBOSS_PRIVATE_PATH_SCAN_TARGET')
if ([string]::IsNullOrWhiteSpace($inputPath)) {
    throw 'HRBOSS_PRIVATE_PATH_SCAN_TARGET is missing.'
}

$fullPath = [System.IO.Path]::GetFullPath($inputPath)
$reparseFlag = [System.IO.FileAttributes]::ReparsePoint
$chain = New-Object 'System.Collections.Generic.List[string]'
$current = $fullPath
while ($true) {
    $chain.Add($current)
    $parent = [System.IO.Directory]::GetParent($current)
    if ($null -eq $parent -or $parent.FullName -eq $current) { break }
    $current = $parent.FullName
}

$reparsePath = $null
$existingChain = New-Object 'System.Collections.Generic.List[object]'
$targetItem = $null
for ($index = 0; $index -lt $chain.Count; $index += 1) {
    try {
        $item = Get-Item -LiteralPath $chain[$index] -Force -ErrorAction Stop
        if ($index -eq 0) { $targetItem = $item }
        $existingChain.Add($item)
    } catch [System.Management.Automation.ItemNotFoundException] {}
}
for ($index = $existingChain.Count - 1; $index -ge 0; $index -= 1) {
    $item = $existingChain[$index]
    if (($item.Attributes -band $reparseFlag) -ne 0) {
        $reparsePath = $item.FullName
        break
    }
}

$targetExists = $null -ne $targetItem
$isDirectory = $false
if ($targetExists) {
    $isDirectory = [bool]$targetItem.PSIsContainer
}
if ($null -eq $reparsePath -and $isDirectory) {
    $pending = New-Object 'System.Collections.Generic.Stack[string]'
    $pending.Push($fullPath)
    while ($pending.Count -gt 0 -and $null -eq $reparsePath) {
        $directory = $pending.Pop()
        foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
            if (($child.Attributes -band $reparseFlag) -ne 0) {
                $reparsePath = $child.FullName
                break
            }
            if ($child.PSIsContainer) { $pending.Push($child.FullName) }
        }
    }
}

[ordered]@{
    target = $fullPath
    targetExists = [bool]$targetExists
    isDirectory = $isDirectory
    reparsePath = $reparsePath
} | ConvertTo-Json -Compress
`;

const WINDOWS_REPARSE_SCANNER_ENCODED = Buffer.from(WINDOWS_REPARSE_SCANNER, 'utf16le').toString('base64');

function windowsIdentity() {
  if (cachedWindowsIdentity) return cachedWindowsIdentity;
  const result = spawnSync('whoami', [], { encoding: 'utf8', windowsHide: true });
  const fallback = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME;
  const commandIdentity = !result.error && result.status === 0 ? result.stdout : '';
  cachedWindowsIdentity = String(commandIdentity || fallback || '').trim();
  if (!cachedWindowsIdentity) throw new Error('无法识别当前 Windows 用户，不能创建私密数据文件。');
  return cachedWindowsIdentity;
}

function runIcacls(target, args, action) {
  const result = spawnSync('icacls', [target, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: ICACLS_MAX_BUFFER,
  });
  if (result.error || result.status !== 0) {
    const detail = [
      result.error && result.error.message,
      String(result.stderr || '').trim(),
      String(result.stdout || '').trim(),
    ].filter(Boolean).join(' ');
    throw new Error(`${action}：${path.basename(target)}。${detail}`);
  }
}

function inspectWindowsPathTree(target) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    WINDOWS_REPARSE_SCANNER_ENCODED,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: ICACLS_MAX_BUFFER,
    env: { ...process.env, HRBOSS_PRIVATE_PATH_SCAN_TARGET: target },
  });
  if (result.error || result.status !== 0) {
    const detail = [
      result.error && result.error.message,
      String(result.stderr || '').trim(),
      String(result.stdout || '').trim(),
    ].filter(Boolean).join(' ');
    throw new Error(`无法核验 Windows 私密路径的重解析点边界：${path.basename(target)}。${detail}`);
  }
  let inspected;
  try {
    inspected = JSON.parse(String(result.stdout || '').replace(/^\uFEFF/, '').trim());
  } catch (error) {
    throw new Error(`无法解析 Windows 私密路径的重解析点结果：${path.basename(target)}。${error.message}`);
  }
  if (inspected.reparsePath) {
    throw new Error(`拒绝通过重解析点、符号链接或目录联接收紧私密路径：${inspected.reparsePath}`);
  }
  return {
    exists: inspected.targetExists === true,
    isDirectory: inspected.isDirectory === true,
  };
}

function hardenPath(target, mode) {
  if (process.platform !== 'win32') {
    fs.chmodSync(target, mode);
    return;
  }
  // 必须在第一条 ACL mutation 前检查目标、所有祖先与整棵后代，避免
  // 经 junction/mount point 越出私密根修改外部对象。
  const inspected = inspectWindowsPathTree(target);
  if (!inspected.exists) {
    const error = new Error(`Windows 私密路径不存在：${target}`);
    error.code = 'ENOENT';
    throw error;
  }
  const { isDirectory } = inspected;
  const identity = windowsIdentity();
  if (!isDirectory) {
    runIcacls(target, ['/reset', '/L', '/Q'], '无法重置 Windows 文件权限');
    runIcacls(
      target,
      ['/inheritance:r', '/grant:r', `${identity}:F`, '/L', '/Q'],
      '无法收紧 Windows 文件权限',
    );
    return;
  }

  // 先只收紧根目录，让它成为后代唯一可信的权限传播源。目录专用的
  // (OI)(CI) 权限绝不能再配合 /T 施加到普通文件，否则会留下空 DACL。
  runIcacls(target, ['/reset', '/L', '/Q'], '无法重置 Windows 目录权限');
  runIcacls(
    target,
    ['/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`, '/L', '/Q'],
    '无法收紧 Windows 目录权限',
  );

  // 空目录对 wildcard 调用 icacls 会被当成 no-match。已有后代先从已
  // 私有化的根继承当前用户权限，再禁用继承并复制 ACE 为显式权限；
  // 文件由此得到 F，目录则保留可传播的 F，且不会遗留其他主体。
  if (fs.readdirSync(target).length === 0) return;
  const descendants = path.join(target, '*');
  runIcacls(descendants, ['/reset', '/T', '/L', '/Q'], '无法重置 Windows 后代权限');
  runIcacls(descendants, ['/inheritance:d', '/T', '/L', '/Q'], '无法固化 Windows 后代权限');
}

function ensurePrivateDir(dir) {
  const existed = fs.existsSync(dir);
  // Existing directories need the same preflight: writePrivateFile and
  // privateAppendStream call this immediately before their write. Checking
  // only newly-created directories would detect a junction after data had
  // already escaped through it.
  if (process.platform === 'win32') inspectWindowsPathTree(dir);
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // 不改已有父目录（例如 /tmp）的权限；只收紧由本次调用新建的专用目录。
  if (!existed) hardenPath(dir, PRIVATE_DIR_MODE);
  return dir;
}

function hardenPrivateDir(dir) {
  const resolved = path.resolve(dir);
  const unsafeRoots = new Set([
    path.parse(resolved).root,
    path.resolve(os.tmpdir()),
    path.resolve(os.homedir()),
  ]);
  if (unsafeRoots.has(resolved)) throw new Error(`拒绝把共享目录当作私密数据目录：${resolved}`);
  ensurePrivateDir(dir);
  hardenPath(dir, PRIVATE_DIR_MODE);
  return dir;
}

function ensurePrivateFile(file) {
  if (fs.existsSync(file)) hardenPath(file, PRIVATE_FILE_MODE);
  return file;
}

function writePrivateFile(file, data, options = {}) {
  ensurePrivateDir(path.dirname(file));
  fs.writeFileSync(file, data, { ...options, mode: PRIVATE_FILE_MODE });
  ensurePrivateFile(file);
  return file;
}

function privateAppendStream(file) {
  ensurePrivateDir(path.dirname(file));
  const stream = fs.createWriteStream(file, { flags: 'a', mode: PRIVATE_FILE_MODE });
  stream.once('open', () => ensurePrivateFile(file));
  return stream;
}

module.exports = {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  ensurePrivateDir,
  hardenPrivateDir,
  ensurePrivateFile,
  writePrivateFile,
  privateAppendStream,
};
