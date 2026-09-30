'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { exportSource, inspectZip, forbiddenPath } = require('../release/export-source');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-source-export-'));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
try {
  git('init', '-q'); git('config', 'core.autocrlf', 'true'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Synthetic Fixture');
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.2.3"}');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\ndist/\n');
  fs.writeFileSync(path.join(root, '说明.txt'), 'committed synthetic content\n');
  git('add', '.'); git('commit', '-qm', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(root, '说明.txt'), 'later commit');
  git('commit', '-qam', 'later');
  fs.writeFileSync(path.join(root, '说明.txt'), 'uncommitted change');
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"9.9.9"}');
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'must not ship');
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'must not ship');
  const result = exportSource({ root, ref: commit, date: '20260930' });
  const metadata = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
  assert.equal(metadata.source_commit, commit);
  assert.equal(metadata.source_tree, git('rev-parse', `${commit}^{tree}`));
  assert.equal(metadata.application_version, '1.2.3');
  const zip = inspectZip(fs.readFileSync(result.zipPath));
  assert.equal(zip.comment, commit);
  const content = zip.files.find(f => f.name.endsWith('/说明.txt'));
  assert.equal(content.data.toString(), 'committed synthetic content\n');
  assert.equal(zip.files.some(f => /(?:ignored|untracked)\.txt$/.test(f.name)), false);
  assert.deepEqual(zip.files.map(f => f.name).sort(), metadata.files.map(f => `${metadata.archive_prefix}${f.path}`).sort());
  assert.ok(fs.readFileSync(result.hashPath, 'utf8').includes(metadata.archive_sha256));
  assert.throws(() => exportSource({ root, ref: commit, date: '20260930' }), /overwrite/);
  assert.throws(() => exportSource({ root, ref: commit, date: '../bad' }), /exactly 8 digits/);
  for (const file of ['tmp/x', 'deliverables/x', 'data/x', 'out/x', 'dist/x', '.runtime/x', 'node_modules/a',
    'frontend/dist/x', '.npmrc', 'nested/.env.secret', 'a.db-wal', 'a.db-shm', 'a.sqlite-wal',
    'a.sqlite-shm', 'a.sqlite3-wal', 'a.sqlite3-shm', 'a.mobileprovision', 'a.pem', 'a.log']) {
    assert.equal(forbiddenPath(file), true, file);
  }
  fs.writeFileSync(path.join(root, '.env'), 'synthetic-secret'); git('add', '.env'); git('commit', '-qm', 'forbidden');
  assert.throws(() => exportSource({ root, ref: 'HEAD', date: '20261001' }), /Forbidden/);
  assert.equal(fs.existsSync(path.join(root, 'dist', 'ZhaocaiGuan-source-1.2.3-20261001.zip')), false);
  const corrupted = Buffer.from(fs.readFileSync(result.zipPath)); corrupted[0] = 0;
  assert.throws(() => inspectZip(corrupted), /ZIP/);
  console.log('check-source-export-001: PASS (frozen commit, dirty/untracked isolation, inventory, hashes, no-clobber, forbidden inputs)');
} finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
