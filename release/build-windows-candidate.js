'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PACKAGE_JSON = require(path.join(ROOT, 'package.json'));
const APP_DIRECTORY_NAME = `${PACKAGE_JSON.productName}-win32-x64`;
const ACCEPTANCE_FILES = Object.freeze([
  'windows-release-self-test.ps1',
  'windows-release-acceptance-checklist.md',
  'PORTABLE-README.md',
]);

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || ROOT,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: options.capture ? 'utf8' : undefined,
    maxBuffer: options.capture ? 64 * 1024 * 1024 : undefined,
    env: { ...process.env, ...options.env },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stderr || result.stdout || ''}`.trim() : '';
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})${detail ? `: ${detail}` : ''}`);
  }
  return options.capture ? String(result.stdout || '').trim() : '';
}

function walkFiles(root) {
  const files = [];
  function visit(current, relativeDirectory) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const absolute = path.join(current, entry.name);
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`candidate package contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) files.push({ absolute, relative });
      else throw new Error(`candidate package contains an unsupported entry: ${relative}`);
    }
  }
  visit(root, '');
  // Match .NET StringComparer.Ordinal used by the Windows evidence collector.
  return files.sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0));
}

function readPeMachine(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return 'not-mz';
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset + 6 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x00004550) return 'not-pe';
  const machine = bytes.readUInt16LE(peOffset + 4);
  if (machine === 0x8664) return 'x64';
  if (machine === 0x014c) return 'x86';
  if (machine === 0xaa64) return 'arm64';
  return `0x${machine.toString(16).padStart(4, '0')}`;
}

function inspectWindowsPackage(packageDirectory) {
  const executable = path.join(packageDirectory, 'ZhaocaiGuan.exe');
  const nativeModule = path.join(
    packageDirectory,
    'resources',
    'app',
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  for (const required of [executable, nativeModule]) {
    if (!fs.existsSync(required) || !fs.statSync(required).isFile()) {
      throw new Error(`Windows candidate is missing required file: ${path.relative(packageDirectory, required)}`);
    }
  }

  for (const forbiddenDirectory of [
    path.join(packageDirectory, 'resources', 'app', 'data'),
    path.join(packageDirectory, 'resources', 'app', 'release'),
  ]) {
    if (fs.existsSync(forbiddenDirectory)) {
      throw new Error(`Windows candidate contains forbidden directory: ${path.relative(packageDirectory, forbiddenDirectory)}`);
    }
  }

  const files = walkFiles(packageDirectory);
  const forbidden = [];
  for (const file of files) {
    const relative = file.relative.replaceAll('\\', '/');
    const lower = relative.toLowerCase();
    if (/^resources\/app\/data(?:\/|$)/i.test(relative)
      || /^resources\/app\/release(?:\/|$)/i.test(relative)
      || /^resources\/app\/(?:.*\/)?\.env(?:\..*)?$/i.test(relative)
      || /^resources\/app\/(?:.*\/)?check-[^/]+\.js$/i.test(relative)
      || /^resources\/app\/rating-config\.json$/i.test(relative)
      || /(?:^|\/)[^/]+\.(?:pem|key|p12|pfx|crt|cer|mobileprovision)$/i.test(relative)
      || /(?:^|\/)node\.exe$/i.test(relative)
      || /\.(?:db|db-wal|db-shm|sqlite|sqlite3)$/i.test(lower)) {
      forbidden.push(relative);
    }
  }
  if (forbidden.length) throw new Error(`Windows candidate contains forbidden files: ${forbidden.join(', ')}`);

  const executableMachine = readPeMachine(executable);
  const nativeModuleMachine = readPeMachine(nativeModule);
  if (executableMachine !== 'x64') throw new Error(`main executable is not PE x64: ${executableMachine}`);
  if (nativeModuleMachine !== 'x64') throw new Error(`better_sqlite3.node is not PE x64: ${nativeModuleMachine}`);

  const hashLines = files.map((file) => `${sha256File(file.absolute)}  ${file.relative}`);
  const payloadHashLines = hashLines.filter((line) => !line.endsWith('  ZhaocaiGuan.exe'));
  return {
    package_file_count: files.length,
    package_tree_sha256: sha256Bytes(`${hashLines.join('\n')}\n`),
    payload_tree_sha256: sha256Bytes(`${payloadHashLines.join('\n')}\n`),
    executable_sha256: sha256File(executable),
    native_module_sha256: sha256File(nativeModule),
    package_hash_lines: hashLines,
    pe_checks: [
      { file: 'ZhaocaiGuan.exe', format: 'PE', architecture: executableMachine },
      { file: 'resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node', format: 'PE', architecture: nativeModuleMachine },
    ],
    forbidden_file_count: 0,
  };
}

function captureSourceState() {
  const head = run('git', ['rev-parse', 'HEAD'], { capture: true });
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=all'], { capture: true });
  const trackedDiff = run('git', ['diff', '--binary', 'HEAD'], { capture: true });
  const untrackedPaths = status.split(/\r?\n/)
    .filter((line) => line.startsWith('?? '))
    .map((line) => line.slice(3))
    .sort();
  return {
    head,
    worktree_state: status ? 'dirty' : 'clean',
    tracked_diff_sha256: sha256Bytes(trackedDiff),
    untracked_path_count: untrackedPaths.length,
    untracked_paths_sha256: sha256Bytes(`${untrackedPaths.join('\n')}${untrackedPaths.length ? '\n' : ''}`),
    status_sha256: sha256Bytes(status),
  };
}

function assertStableSourceState(before, after) {
  const fields = [
    'head',
    'worktree_state',
    'tracked_diff_sha256',
    'untracked_path_count',
    'untracked_paths_sha256',
    'status_sha256',
  ];
  if (fields.some((field) => before?.[field] !== after?.[field])) {
    throw new Error('source state changed during Windows packaging; candidate was not generated');
  }
}

function assertEquivalentInspection(before, after) {
  const fields = [
    'package_tree_sha256',
    'payload_tree_sha256',
    'executable_sha256',
    'native_module_sha256',
  ];
  if (fields.some((field) => before?.[field] !== after?.[field])) {
    throw new Error('candidate copy hash mismatch; candidate was removed and was not archived');
  }
}

function createZip(sourceDirectory, destinationZip) {
  fs.rmSync(destinationZip, { force: true });
  const parent = path.dirname(sourceDirectory);
  const name = path.basename(sourceDirectory);
  if (process.platform === 'win32') {
    const escapedSource = sourceDirectory.replaceAll("'", "''");
    const escapedDestination = destinationZip.replaceAll("'", "''");
    run('powershell.exe', ['-NoLogo', '-NoProfile', '-Command',
      `Compress-Archive -LiteralPath '${escapedSource}' -DestinationPath '${escapedDestination}' -CompressionLevel Optimal -Force`]);
  } else if (process.platform === 'darwin') {
    run('/usr/bin/tar', [
      '--format', 'zip', '--options', 'zip:hdrcharset=UTF-8',
      '--no-xattrs', '--no-acls', '--no-mac-metadata', '--uid', '0', '--gid', '0',
      '-cf', destinationZip, '-C', path.dirname(sourceDirectory), path.basename(sourceDirectory),
    ]);
  } else {
    run('zip', ['-q', '-r', destinationZip, name], { cwd: parent });
  }
}

function writeCandidateReadme(destination) {
  fs.writeFileSync(destination, `# Zhaocai Guan Windows x64 unsigned candidate\n\n`
    + `This archive is an **unsigned technical candidate**, not a production release.\n\n`
    + `- Package: \`app/\`\n`
    + `- Machine-readable build evidence: \`CANDIDATE-MANIFEST.json\`\n`
    + `- Package file hashes: \`PACKAGE-SHA256SUMS.txt\`\n`
    + `- Windows isolated self-test: \`release/windows-release-self-test.ps1\`\n`
    + `- Manual acceptance and signature gate: \`release/windows-release-acceptance-checklist.md\`\n\n`
    + `A real Windows x64 machine must still complete the self-test and every applicable P0 manual gate. `
    + `Do not infer Windows PASS, Authenticode PASS, microphone/ASR PASS, or Boss account PASS from this build.\n`, 'utf8');
}

function main() {
  const outputRootArgument = process.argv.indexOf('--output-root');
  const outputRoot = outputRootArgument >= 0
    ? path.resolve(process.argv[outputRootArgument + 1] || '')
    : path.join(ROOT, 'dist', 'windows-candidates');
  if (outputRootArgument >= 0 && !process.argv[outputRootArgument + 1]) throw new Error('--output-root requires a path');

  // Verification is intentionally first. There is no skip flag for release candidates.
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'verify']);
  const source = captureSourceState();

  const forgeCli = path.join(ROOT, 'node_modules', '@electron-forge', 'cli', 'dist', 'electron-forge.js');
  if (!fs.existsSync(forgeCli)) throw new Error('Electron Forge is not installed; run npm ci first');
  run(process.execPath, [forgeCli, 'package', '--platform=win32', '--arch=x64']);

  const packageDirectory = path.join(ROOT, 'dist', APP_DIRECTORY_NAME);
  const inspection = inspectWindowsPackage(packageDirectory);
  const sourceAfterPackage = captureSourceState();
  assertStableSourceState(source, sourceAfterPackage);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const candidateName = `ZhaocaiGuan-${PACKAGE_JSON.version}-${source.head.slice(0, 12)}-${source.worktree_state}-${timestamp}-win32-x64-unsigned`;
  const candidateDirectory = path.join(outputRoot, candidateName);
  const archivePath = `${candidateDirectory}.zip`;
  if (fs.existsSync(candidateDirectory) || fs.existsSync(archivePath)) throw new Error(`candidate output already exists: ${candidateName}`);

  fs.mkdirSync(candidateDirectory, { recursive: true, mode: 0o700 });
  let stagedInspection;
  try {
    const stagedAppDirectory = path.join(candidateDirectory, 'app');
    fs.cpSync(packageDirectory, stagedAppDirectory, { recursive: true, dereference: true });
    stagedInspection = inspectWindowsPackage(stagedAppDirectory);
    assertEquivalentInspection(inspection, stagedInspection);
    assertStableSourceState(source, captureSourceState());
  } catch (error) {
    fs.rmSync(candidateDirectory, { recursive: true, force: true });
    throw error;
  }
  fs.mkdirSync(path.join(candidateDirectory, 'release'), { recursive: true, mode: 0o700 });
  for (const file of ACCEPTANCE_FILES) {
    fs.copyFileSync(path.join(ROOT, 'release', file), path.join(candidateDirectory, 'release', file));
  }
  fs.copyFileSync(path.join(ROOT, 'release', 'START-ZhaocaiGuan.cmd'), path.join(candidateDirectory, 'START-ZhaocaiGuan.cmd'));
  fs.writeFileSync(path.join(candidateDirectory, 'PACKAGE-SHA256SUMS.txt'), `${stagedInspection.package_hash_lines.join('\n')}\n`, 'utf8');
  writeCandidateReadme(path.join(candidateDirectory, 'CANDIDATE-README.md'));

  const manifest = {
    schema_version: 'hrboss_windows_candidate_v1',
    candidate_type: 'unsigned-technical-candidate',
    production_release_allowed: false,
    signing_state: 'unsigned-candidate',
    built_at: new Date().toISOString(),
    application: { name: PACKAGE_JSON.productName, version: PACKAGE_JSON.version },
    target: { electron: String(PACKAGE_JSON.devDependencies.electron).replace(/^[^\d]*/, ''), platform: 'win32', arch: 'x64' },
    source,
    verification: { command: 'npm run verify', result: 'PASS' },
    package: {
      directory: 'app',
      package_file_count: stagedInspection.package_file_count,
      package_tree_sha256: stagedInspection.package_tree_sha256,
      payload_tree_sha256: stagedInspection.payload_tree_sha256,
      unsigned_executable_sha256: stagedInspection.executable_sha256,
      native_module_sha256: stagedInspection.native_module_sha256,
      forbidden_file_count: stagedInspection.forbidden_file_count,
      pe_checks: stagedInspection.pe_checks,
    },
    acceptance: {
      automated_script: 'release/windows-release-self-test.ps1',
      manual_checklist: 'release/windows-release-acceptance-checklist.md',
      real_windows_result: 'NOT_RUN',
      authenticode_result: 'NOT_RUN_UNSIGNED_CANDIDATE',
    },
  };
  fs.writeFileSync(path.join(candidateDirectory, 'CANDIDATE-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  createZip(candidateDirectory, archivePath);
  const archiveHash = sha256File(archivePath);
  fs.writeFileSync(`${archivePath}.sha256`, `${archiveHash}  ${path.basename(archivePath)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ candidateDirectory, archivePath, archiveSha256: archiveHash, manifest }, null, 2)}\n`);
}

module.exports = {
  ACCEPTANCE_FILES,
  assertEquivalentInspection,
  assertStableSourceState,
  captureSourceState,
  inspectWindowsPackage,
  readPeMachine,
  sha256Bytes,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  }
}
