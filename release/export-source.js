'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function forbiddenPath(file) {
  const parts = file.split('/');
  return parts.some(p => ['.git', 'node_modules', 'data', 'tmp', 'deliverables', 'out', 'dist', '.dev-data', '.runtime',
    'windows-acceptance-evidence', '__MACOSX'].includes(p))
    || parts.some(p => /^(?:\.env(?:\..*)?|\.npmrc|rating-config\.json|\.DS_Store|\._.*)$/.test(p))
    || /\.(?:(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?|log|pem|key|p12|pfx|crt|cer|mobileprovision)$/i.test(file);
}

// Inspect the final Git-generated ZIP without extracting untrusted paths. Git's
// ZIP writer uses stored/deflated entries and a central directory (no ZIP64).
function inspectZip(bytes) {
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (bytes.readUInt32LE(end) === 0x06054b50 && end + 22 + bytes.readUInt16LE(end + 20) === bytes.length) break;
  }
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw new Error('Invalid ZIP directory');
  const count = bytes.readUInt16LE(end + 10);
  if (count === 65535) throw new Error('ZIP64 source bundles are unsupported');
  let offset = bytes.readUInt32LE(end + 16);
  const files = [];
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    if (names.has(name) || name.startsWith('/') || name.includes('\\') || name.split('/').includes('..')) throw new Error('Unsafe ZIP path');
    names.add(name);
    const local = bytes.readUInt32LE(offset + 42);
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP local entry');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const raw = bytes.subarray(start, start + compressed);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data || data.length !== size) throw new Error('Invalid ZIP data');
    if (!name.endsWith('/')) files.push({ name, data });
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return { files, comment: bytes.subarray(end + 22).toString('utf8') };
}

function exportSource({ root, ref = 'HEAD', date = new Date().toISOString().slice(0, 10).replaceAll('-', '') }) {
  if (!/^[0-9]{8}$/.test(date)) throw new Error('HRBOSS_RELEASE_DATE must contain exactly 8 digits (YYYYMMDD).');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 128 * 1024 * 1024 });
  const commit = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).toString().trim();
  const tree = git('rev-parse', `${commit}^{tree}`).toString().trim();
  const version = JSON.parse(git('show', `${commit}:package.json`)).version;
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error('Unsafe source version');
  const basename = `ZhaocaiGuan-source-${version}-${date}`;
  const prefix = `${basename}/app/`;
  const output = path.join(root, 'dist');
  const zipPath = path.join(output, `${basename}.zip`);
  const manifestPath = path.join(output, `${basename}-manifest.json`);
  const hashPath = path.join(output, `${basename}-SHA256SUMS.txt`);
  for (const target of [zipPath, manifestPath, hashPath]) if (fs.existsSync(target)) throw new Error(`Refusing to overwrite: ${target}`);
  const entries = git('ls-tree', '-rz', '--full-tree', commit).toString('utf8').split('\0').filter(Boolean).map(line => {
    const match = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
    if (!match || !['100644', '100755'].includes(match[1])) throw new Error(`Unsupported source entry: ${line}`);
    if (forbiddenPath(match[4])) throw new Error(`Forbidden committed source path: ${match[4]}`);
    return { path: match[4], mode: match[1], git_blob: match[3] };
  });
  // Export committed bytes regardless of the host's checkout line-ending policy.
  const archive = git('-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=zip', `--prefix=${prefix}`, commit);
  const unpacked = inspectZip(archive);
  if (unpacked.comment !== commit || unpacked.files.length !== entries.length) throw new Error('Source ZIP identity/inventory mismatch');
  const expected = new Map(entries.map(entry => [prefix + entry.path, entry]));
  for (const file of unpacked.files) {
    const entry = expected.get(file.name);
    if (!entry || !file.data.equals(git('cat-file', 'blob', entry.git_blob))) throw new Error(`Source ZIP content mismatch: ${file.name}`);
    entry.sha256 = sha256(file.data);
    entry.bytes = file.data.length;
    expected.delete(file.name);
  }
  if (expected.size) throw new Error('Source ZIP missing committed files');
  const metadata = Buffer.from(JSON.stringify({ schema_version: 'hrboss_source_export_v1', source_commit: commit,
    source_tree: tree, application_version: version, archive_prefix: prefix, archive_sha256: sha256(archive), files: entries }, null, 2) + '\n');
  const hashes = `${sha256(archive)}  ${path.basename(zipPath)}\n${sha256(metadata)}  ${path.basename(manifestPath)}\n`;
  fs.mkdirSync(output, { recursive: true });
  const staging = fs.mkdtempSync(path.join(output, '.source-stage-'));
  const created = [];
  try {
    for (const [target, content] of [[zipPath, archive], [manifestPath, metadata], [hashPath, hashes]]) {
      const temporary = path.join(staging, path.basename(target));
      fs.writeFileSync(temporary, content);
      fs.linkSync(temporary, target); // Atomic no-clobber, including concurrent exports.
      created.push(target);
    }
  } catch (error) {
    for (const target of created) fs.unlinkSync(target);
    throw error;
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  return { zipPath, manifestPath, hashPath, commit, files: entries.length };
}
if (require.main === module) {
  try { console.log(JSON.stringify(exportSource({ root: path.resolve(__dirname, '..'), ref: process.argv[2] || 'HEAD', date: process.env.HRBOSS_RELEASE_DATE }), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { exportSource, inspectZip, forbiddenPath };
