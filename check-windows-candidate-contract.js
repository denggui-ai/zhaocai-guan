'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-windows-candidate-contract-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

function fakePeX64() {
  const bytes = Buffer.alloc(256);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84);
  return bytes;
}

function write(relative, content) {
  const destination = path.join(ROOT, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}

const builderPath = path.join(__dirname, 'release', 'build-windows-candidate.js');
const builderSource = fs.readFileSync(builderPath, 'utf8');
const {
  ACCEPTANCE_FILES,
  assertEquivalentInspection,
  assertStableSourceState,
  inspectWindowsPackage,
  readPeMachine,
  sha256Bytes,
} = require(builderPath);

assert.ok(
  builderSource.indexOf("['run', 'verify']") < builderSource.indexOf("'package', '--platform=win32', '--arch=x64'"),
  'npm run verify must execute before Electron Forge packaging',
);
assert.match(builderSource, /signing_state: 'unsigned-candidate'/, 'candidate must not claim Authenticode signing');
assert.match(builderSource, /production_release_allowed: false/, 'candidate must explicitly prohibit production release');
assert.match(builderSource, /tracked_diff_sha256/, 'candidate must bind the tracked diff state');
assert.match(builderSource, /untracked_paths_sha256/, 'candidate must bind the untracked path list without archiving source data');
assert.match(builderSource, /package_tree_sha256/, 'candidate must include a canonical package hash');
assert.match(builderSource, /const sourceAfterPackage = captureSourceState\(\)/, 'builder must capture source state after package inspection');
assert.doesNotThrow(() => assertStableSourceState(
  { head: 'a', worktree_state: 'clean', tracked_diff_sha256: 'b', untracked_path_count: 0, untracked_paths_sha256: 'c', status_sha256: 'd' },
  { head: 'a', worktree_state: 'clean', tracked_diff_sha256: 'b', untracked_path_count: 0, untracked_paths_sha256: 'c', status_sha256: 'd' },
));
assert.throws(() => assertStableSourceState(
  { head: 'a', worktree_state: 'clean', tracked_diff_sha256: 'b', untracked_path_count: 0, untracked_paths_sha256: 'c', status_sha256: 'd' },
  { head: 'a', worktree_state: 'dirty', tracked_diff_sha256: 'changed', untracked_path_count: 1, untracked_paths_sha256: 'x', status_sha256: 'y' },
), /source state changed.*candidate was not generated/);
const inspectionHashes = {
  package_tree_sha256: 'a',
  payload_tree_sha256: 'b',
  executable_sha256: 'c',
  native_module_sha256: 'd',
};
assert.doesNotThrow(() => assertEquivalentInspection(inspectionHashes, { ...inspectionHashes }));
assert.throws(
  () => assertEquivalentInspection(inspectionHashes, { ...inspectionHashes, payload_tree_sha256: 'tampered' }),
  /candidate copy hash mismatch.*was not archived/,
);
assert.deepEqual(ACCEPTANCE_FILES, [
  'windows-release-self-test.ps1',
  'windows-release-acceptance-checklist.md',
  'PORTABLE-README.md',
]);

write('ZhaocaiGuan.exe', fakePeX64());
write('resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node', fakePeX64());
write('resources/app/package.json', '{"name":"synthetic"}\n');
write('z-last.txt', 'z\n');
write('a-directory/z-child.txt', 'child\n');
write('a-file.txt', 'a\n');
const inspected = inspectWindowsPackage(ROOT);
assert.equal(inspected.forbidden_file_count, 0);
assert.equal(inspected.pe_checks.length, 2);
assert.ok(/^[a-f0-9]{64}$/.test(inspected.package_tree_sha256));
assert.ok(/^[a-f0-9]{64}$/.test(inspected.payload_tree_sha256));
assert.notEqual(inspected.payload_tree_sha256, inspected.package_tree_sha256);
const expectedPayloadPaths = [
  'a-directory/z-child.txt',
  'a-file.txt',
  'resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node',
  'resources/app/package.json',
  'z-last.txt',
].sort();
const expectedPayloadLines = expectedPayloadPaths.map((relative) => `${sha256Bytes(fs.readFileSync(path.join(ROOT, relative)))}  ${relative}`);
assert.equal(
  inspected.payload_tree_sha256,
  sha256Bytes(`${expectedPayloadLines.join('\n')}\n`),
  'payload tree must globally sort relative paths before hashing lines',
);
assert.ok(/^[a-f0-9]{64}$/.test(inspected.executable_sha256));
assert.ok(/^[a-f0-9]{64}$/.test(inspected.native_module_sha256));
assert.equal(readPeMachine(path.join(ROOT, 'ZhaocaiGuan.exe')), 'x64');

write('resources/app/.env.production', 'SYNTHETIC_ONLY=true\n');
assert.throws(() => inspectWindowsPackage(ROOT), /forbidden files.*\.env\.production/);
fs.rmSync(path.join(ROOT, 'resources', 'app', '.env.production'));
write('resources/app/nested/check-synthetic.js', 'throw new Error();\n');
assert.throws(() => inspectWindowsPackage(ROOT), /forbidden files.*check-synthetic\.js/);
fs.rmSync(path.join(ROOT, 'resources', 'app', 'nested'), { recursive: true });
write('resources/app/private-key.pem', 'SYNTHETIC TEST KEY\n');
assert.throws(() => inspectWindowsPackage(ROOT), /forbidden files.*private-key\.pem/);
fs.rmSync(path.join(ROOT, 'resources', 'app', 'private-key.pem'));
fs.mkdirSync(path.join(ROOT, 'resources', 'app', 'data'));
assert.throws(() => inspectWindowsPackage(ROOT), /forbidden directory.*resources[\\/]app[\\/]data/);

console.log('check-windows-candidate-contract ok');
