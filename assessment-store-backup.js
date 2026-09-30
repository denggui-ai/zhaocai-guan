'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const FORMAT_VERSION = 2;
const INCLUDED_LIFECYCLE_STATES = Object.freeze(['active', 'frozen', 'deletion_pending']);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DAY_MS = 24 * 60 * 60 * 1000;
const PURGE_QUARANTINE_PREFIX = '.assessment-purge-';

class AssessmentStoreBackupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AssessmentStoreBackupError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new AssessmentStoreBackupError(code, message);
}

function assertDatabase(database, { backup = false } = {}) {
  if (!database || typeof database.prepare !== 'function' || (backup && typeof database.backup !== 'function')) {
    fail('DATABASE_REQUIRED', 'An open Assessment SQLite database is required.');
  }
}

function canonicalTimestamp(value, code, label) {
  if (typeof value !== 'string') fail(code, `${label} is invalid.`);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    fail(code, `${label} is invalid.`);
  }
  return value;
}

function policyContract(policyVersion, retentionDays) {
  if (typeof policyVersion !== 'string' || !TOKEN.test(policyVersion)) {
    fail('POLICY_CONTRACT_REQUIRED', 'An approved Assessment backup policy version is required.');
  }
  if (!Number.isSafeInteger(retentionDays) || retentionDays <= 0 || retentionDays > 36500) {
    fail('POLICY_CONTRACT_REQUIRED', 'An approved Assessment backup retention period is required.');
  }
  return Object.freeze({ policyVersion, retentionDays });
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function privateDirectory(directoryPath, { create = false } = {}) {
  if (typeof directoryPath !== 'string' || !path.isAbsolute(directoryPath) || directoryPath.includes('\0')) {
    fail('ROOT_INVALID', 'Assessment backup root is invalid.');
  }
  if (create && !fs.existsSync(directoryPath)) fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  let stat;
  try { stat = fs.lstatSync(directoryPath); } catch { fail('ROOT_INVALID', 'Assessment backup root is invalid.'); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('ROOT_INVALID', 'Assessment backup root is invalid.');
  fs.chmodSync(directoryPath, 0o700);
  return fs.realpathSync(directoryPath);
}

function directChild(root, name) {
  if (typeof name !== 'string' || !TOKEN.test(name)) fail('RECOVERY_ID_INVALID', 'Assessment recovery identifier is invalid.');
  const target = path.join(root, name);
  if (path.dirname(target) !== root) fail('PATH_OUTSIDE_ROOT', 'Assessment backup path is invalid.');
  return target;
}

function normalizeRelpath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value)
      || value.includes('\\') || /^[A-Za-z]:/.test(value)) {
    fail('STORAGE_RELPATH_INVALID', 'Assessment storage reference is invalid.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    fail('STORAGE_RELPATH_INVALID', 'Assessment storage reference is invalid.');
  }
  return segments.join('/');
}

function resolveInside(root, relpath) {
  const normalized = normalizeRelpath(relpath);
  const target = path.join(root, ...normalized.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('PATH_OUTSIDE_ROOT', 'Assessment storage reference escapes its root.');
  }
  return target;
}

function assertNoSymlinkPath(root, relpath) {
  let cursor = root;
  for (const segment of normalizeRelpath(relpath).split('/')) {
    cursor = path.join(cursor, segment);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch { fail('ARTIFACT_MISSING', 'Assessment backup artifact is missing.'); }
    if (stat.isSymbolicLink()) fail('ARTIFACT_UNSAFE', 'Assessment backup artifact path contains a symbolic link.');
  }
}

function checkedFile(root, relpath, { expectedBytes, expectedHash, png = false } = {}) {
  assertNoSymlinkPath(root, relpath);
  const target = resolveInside(root, relpath);
  let stat;
  try { stat = fs.lstatSync(target); } catch { fail('ARTIFACT_MISSING', 'Assessment backup artifact is missing.'); }
  if (stat.isSymbolicLink() || !stat.isFile()) fail('ARTIFACT_UNSAFE', 'Assessment backup artifact is unsafe.');
  const real = fs.realpathSync(target);
  const relative = path.relative(root, real);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail('PATH_OUTSIDE_ROOT', 'Assessment backup artifact escapes its root.');
  }
  if (expectedBytes !== undefined && stat.size !== expectedBytes) fail('ARTIFACT_SIZE_MISMATCH', 'Assessment backup artifact size does not match.');
  if (expectedHash !== undefined && sha256File(real) !== expectedHash) fail('ARTIFACT_HASH_MISMATCH', 'Assessment backup artifact hash does not match.');
  if (png) {
    const descriptor = fs.openSync(real, 'r');
    try {
      const signature = Buffer.alloc(PNG_SIGNATURE.length);
      fs.readSync(descriptor, signature, 0, signature.length, 0);
      if (!signature.equals(PNG_SIGNATURE)) fail('PREVIEW_INVALID', 'Assessment preview is invalid.');
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return { path: real, bytes: stat.size, sha256: expectedHash || sha256File(real) };
}

function ensureParent(root, relpath) {
  const target = resolveInside(root, relpath);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  let cursor = parent;
  while (cursor !== root) {
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('ARTIFACT_UNSAFE', 'Assessment backup directory is unsafe.');
    fs.chmodSync(cursor, 0o700);
    cursor = path.dirname(cursor);
  }
  return target;
}

function copyExclusive(source, destinationRoot, relpath) {
  const target = ensureParent(destinationRoot, relpath);
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(target, 0o600);
  return target;
}

function assessmentRows(database) {
  const columns = new Set(database.prepare("PRAGMA table_info('assessment_document')").all().map((row) => row.name));
  const disputeState = columns.has('dispute_state') ? 'dispute_state' : "'none' AS dispute_state";
  return database.prepare(`
    SELECT id, content_sha256, storage_relpath, byte_size, page_count,
           lifecycle_state, legal_hold_state, ${disputeState}, version
    FROM assessment_document
    WHERE lifecycle_state IN ('active', 'frozen', 'deletion_pending')
    ORDER BY id
  `).all();
}

function expectedPreviewRelpaths(hash, pageCount) {
  if (!Number.isInteger(Number(pageCount)) || Number(pageCount) <= 0 || Number(pageCount) > 200) {
    fail('DOCUMENT_METADATA_INVALID', 'Assessment document page metadata is invalid.');
  }
  return Array.from({ length: Number(pageCount) }, (_, index) => (
    `previews/sha256/${hash.slice(0, 2)}/${hash}/page-${index + 1}.png`
  ));
}

function collectExpectedArtifacts(database, dataRoot) {
  const root = privateDirectory(dataRoot);
  const assessmentRoot = privateDirectory(path.join(root, 'assessment'));
  const documents = [];
  for (const row of assessmentRows(database)) {
    if (!SHA256.test(String(row.content_sha256 || '')) || !Number.isSafeInteger(Number(row.byte_size)) || Number(row.byte_size) <= 0) {
      fail('DOCUMENT_METADATA_INVALID', 'Assessment document storage metadata is invalid.');
    }
    const storageRelpath = normalizeRelpath(row.storage_relpath);
    const blob = checkedFile(assessmentRoot, storageRelpath, {
      expectedBytes: Number(row.byte_size), expectedHash: row.content_sha256,
    });
    const previews = expectedPreviewRelpaths(row.content_sha256, row.page_count).map((previewRelpath) => {
      const preview = checkedFile(assessmentRoot, previewRelpath, { png: true });
      return { relative_path: previewRelpath, bytes: preview.bytes, sha256: preview.sha256 };
    });
    documents.push({
      id: row.id,
      content_sha256: row.content_sha256,
      storage_relpath: storageRelpath,
      byte_size: Number(row.byte_size),
      page_count: Number(row.page_count),
      lifecycle_state: row.lifecycle_state,
      legal_hold_state: row.legal_hold_state,
      dispute_state: row.dispute_state,
      version: Number(row.version),
      blob_source: blob.path,
      previews,
    });
  }
  return { assessmentRoot, documents };
}

function walkFiles(root, relativeRoot) {
  const start = resolveInside(root, relativeRoot);
  let startStat;
  try { startStat = fs.lstatSync(start); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (startStat.isSymbolicLink() || !startStat.isDirectory()) fail('ARTIFACT_UNSAFE', 'Assessment store directory is unsafe.');
  const files = [];
  const stack = [{ absolute: start, relative: normalizeRelpath(relativeRoot) }];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current.absolute, { withFileTypes: true })) {
      const absolute = path.join(current.absolute, entry.name);
      const relative = `${current.relative}/${entry.name}`;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fail('ARTIFACT_UNSAFE', 'Assessment store contains a symbolic link.');
      if (stat.isDirectory()) stack.push({ absolute, relative });
      else if (stat.isFile()) files.push(normalizeRelpath(relative));
      else fail('ARTIFACT_UNSAFE', 'Assessment store contains an unsafe object.');
    }
  }
  return files.sort();
}

function verifyAssessmentDbStoreConsistency({ database, dataRoot } = {}) {
  assertDatabase(database);
  const { assessmentRoot, documents } = collectExpectedArtifacts(database, dataRoot);
  const expectedBlobs = new Set(documents.map((document) => document.storage_relpath));
  const expectedPreviews = new Set(documents.flatMap((document) => document.previews.map((preview) => preview.relative_path)));
  const actualBlobs = walkFiles(assessmentRoot, 'accepted');
  const actualPreviews = walkFiles(assessmentRoot, 'previews');
  const orphanBlobs = actualBlobs.filter((relpath) => !expectedBlobs.has(relpath));
  const orphanPreviews = actualPreviews.filter((relpath) => !expectedPreviews.has(relpath));
  return Object.freeze({
    ok: orphanBlobs.length === 0 && orphanPreviews.length === 0,
    document_count: documents.length,
    blob_count: actualBlobs.length,
    preview_file_count: actualPreviews.length,
    orphan_blob_count: orphanBlobs.length,
    orphan_preview_count: orphanPreviews.length,
  });
}

function manifestDocument(document) {
  return {
    id: document.id,
    content_sha256: document.content_sha256,
    storage_relpath: document.storage_relpath,
    byte_size: document.byte_size,
    page_count: document.page_count,
    lifecycle_state: document.lifecycle_state,
    legal_hold_state: document.legal_hold_state,
    dispute_state: document.dispute_state,
    version: document.version,
    previews: document.previews,
  };
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || ![1, FORMAT_VERSION].includes(manifest.format_version)) {
    fail('MANIFEST_INVALID', 'Assessment backup manifest is invalid.');
  }
  const keys = manifest.format_version === FORMAT_VERSION
    ? ['backup_retention_days', 'created_at', 'database', 'documents', 'format_version',
      'manifest_sha256', 'policy_version', 'recovery_id']
    : ['created_at', 'database', 'documents', 'format_version', 'manifest_sha256', 'recovery_id'];
  if (Object.keys(manifest).sort().join('|') !== keys.join('|')) fail('MANIFEST_INVALID', 'Assessment backup manifest fields are invalid.');
  if (!TOKEN.test(String(manifest.recovery_id || '')) || !Array.isArray(manifest.documents)) {
    fail('MANIFEST_INVALID', 'Assessment backup manifest is invalid.');
  }
  canonicalTimestamp(manifest.created_at, 'MANIFEST_INVALID', 'Assessment backup timestamp');
  if (manifest.format_version === FORMAT_VERSION
      && (!TOKEN.test(String(manifest.policy_version || ''))
        || !Number.isSafeInteger(manifest.backup_retention_days)
        || manifest.backup_retention_days <= 0 || manifest.backup_retention_days > 36500)) {
    fail('MANIFEST_INVALID', 'Assessment backup policy contract is invalid.');
  }
  if (!manifest.database || Object.keys(manifest.database).sort().join('|') !== 'bytes|relative_path|sha256') {
    fail('MANIFEST_INVALID', 'Assessment backup database manifest is invalid.');
  }
  if (manifest.database.relative_path !== 'database.db' || !Number.isSafeInteger(manifest.database.bytes)
      || manifest.database.bytes <= 0 || !SHA256.test(String(manifest.database.sha256 || ''))) {
    fail('MANIFEST_INVALID', 'Assessment backup database manifest is invalid.');
  }
  const seenIds = new Set();
  const seenArtifacts = new Set();
  for (const document of manifest.documents) {
    const documentKeys = ['byte_size', 'content_sha256', 'dispute_state', 'id', 'legal_hold_state',
      'lifecycle_state', 'page_count', 'previews', 'storage_relpath', 'version'];
    if (!document || Object.keys(document).sort().join('|') !== documentKeys.sort().join('|')
        || seenIds.has(document.id) || !SHA256.test(String(document.content_sha256 || ''))
        || !INCLUDED_LIFECYCLE_STATES.includes(document.lifecycle_state)
        || !Number.isSafeInteger(document.byte_size) || document.byte_size <= 0
        || !Number.isSafeInteger(document.page_count) || document.page_count <= 0 || document.page_count > 200
        || !Number.isSafeInteger(document.version) || document.version <= 0 || !Array.isArray(document.previews)) {
      fail('MANIFEST_INVALID', 'Assessment backup document manifest is invalid.');
    }
    const storageRelpath = normalizeRelpath(document.storage_relpath);
    if (!storageRelpath.startsWith('accepted/') || !storageRelpath.endsWith('.pdf') || seenArtifacts.has(storageRelpath)) {
      fail('MANIFEST_INVALID', 'Assessment backup storage reference is invalid.');
    }
    seenArtifacts.add(storageRelpath);
    seenIds.add(document.id);
    const expectedPreviews = expectedPreviewRelpaths(document.content_sha256, document.page_count);
    if (document.previews.length !== document.page_count) {
      fail('MANIFEST_INVALID', 'Assessment backup preview count is invalid.');
    }
    for (let index = 0; index < document.previews.length; index += 1) {
      const preview = document.previews[index];
      if (!preview || Object.keys(preview).sort().join('|') !== 'bytes|relative_path|sha256'
          || !Number.isSafeInteger(preview.bytes) || preview.bytes <= 0 || !SHA256.test(String(preview.sha256 || ''))) {
        fail('MANIFEST_INVALID', 'Assessment backup preview manifest is invalid.');
      }
      const previewRelpath = normalizeRelpath(preview.relative_path);
      if (previewRelpath !== expectedPreviews[index] || seenArtifacts.has(previewRelpath)) {
        fail('MANIFEST_INVALID', 'Assessment backup preview reference is invalid.');
      }
      seenArtifacts.add(previewRelpath);
    }
  }
  if (!SHA256.test(String(manifest.manifest_sha256 || ''))) fail('MANIFEST_INVALID', 'Assessment backup manifest hash is invalid.');
  const unsigned = { ...manifest };
  delete unsigned.manifest_sha256;
  if (sha256Buffer(Buffer.from(stableJson(unsigned))) !== manifest.manifest_sha256) {
    fail('MANIFEST_HASH_MISMATCH', 'Assessment backup manifest hash does not match.');
  }
  return manifest;
}

function readBackupPackageAt(root, packageName, expectedRecoveryId) {
  if (typeof packageName !== 'string' || !packageName || packageName.includes('\0')
      || path.basename(packageName) !== packageName || packageName === '.' || packageName === '..') {
    fail('BACKUP_UNSAFE', 'Assessment backup package is unsafe.');
  }
  const packageRoot = path.join(root, packageName);
  if (path.dirname(packageRoot) !== root) fail('PATH_OUTSIDE_ROOT', 'Assessment backup package escapes its root.');
  let stat;
  try { stat = fs.lstatSync(packageRoot); } catch { fail('BACKUP_NOT_FOUND', 'Assessment backup package was not found.'); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail('BACKUP_UNSAFE', 'Assessment backup package is unsafe.');
  const realPackageRoot = fs.realpathSync(packageRoot);
  const realStat = fs.lstatSync(realPackageRoot);
  if (realPackageRoot !== packageRoot || realStat.dev !== stat.dev || realStat.ino !== stat.ino) {
    fail('BACKUP_CHANGED', 'Assessment backup package changed during validation.');
  }
  const manifestFile = checkedFile(realPackageRoot, 'manifest.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile.path, 'utf8')); } catch { fail('MANIFEST_INVALID', 'Assessment backup manifest is invalid JSON.'); }
  validateManifest(manifest);
  if (expectedRecoveryId !== undefined && manifest.recovery_id !== expectedRecoveryId) {
    fail('MANIFEST_INVALID', 'Assessment backup recovery identifier does not match.');
  }
  const rootEntries = fs.readdirSync(realPackageRoot).sort();
  if (rootEntries.join('|') !== 'database.db|files|manifest.json') {
    fail('BACKUP_UNEXPECTED_ARTIFACT', 'Assessment backup package contains an unexpected artifact.');
  }
  const filesDirectoryStat = fs.lstatSync(path.join(realPackageRoot, 'files'));
  if (filesDirectoryStat.isSymbolicLink() || !filesDirectoryStat.isDirectory()) {
    fail('BACKUP_UNSAFE', 'Assessment backup package is unsafe.');
  }
  const databaseFile = checkedFile(realPackageRoot, manifest.database.relative_path, {
    expectedBytes: manifest.database.bytes, expectedHash: manifest.database.sha256,
  });
  for (const document of manifest.documents) {
    checkedFile(realPackageRoot, `files/${document.storage_relpath}`, {
      expectedBytes: document.byte_size, expectedHash: document.content_sha256,
    });
    for (const preview of document.previews) {
      checkedFile(realPackageRoot, `files/${preview.relative_path}`, {
        expectedBytes: preview.bytes, expectedHash: preview.sha256, png: true,
      });
    }
  }
  const expectedFiles = manifest.documents.flatMap((document) => [
    `files/${document.storage_relpath}`,
    ...document.previews.map((preview) => `files/${preview.relative_path}`),
  ]).sort();
  const actualFiles = walkFiles(realPackageRoot, 'files');
  if (stableJson(actualFiles) !== stableJson(expectedFiles)) {
    fail('BACKUP_UNEXPECTED_ARTIFACT', 'Assessment backup package file set does not match its manifest.');
  }
  return {
    packageRoot: realPackageRoot,
    packageStat: { device: realStat.dev, inode: realStat.ino },
    manifest,
    databaseFile: databaseFile.path,
  };
}

function readBackupPackage(backupRoot, recoveryId) {
  const root = privateDirectory(backupRoot);
  directChild(root, recoveryId);
  return readBackupPackageAt(root, recoveryId, recoveryId);
}

function assertManifestMatchesDatabase(database, manifest) {
  const rows = assessmentRows(database).map((row) => ({
    id: row.id,
    content_sha256: row.content_sha256,
    storage_relpath: normalizeRelpath(row.storage_relpath),
    byte_size: Number(row.byte_size),
    page_count: Number(row.page_count),
    lifecycle_state: row.lifecycle_state,
    legal_hold_state: row.legal_hold_state,
    dispute_state: row.dispute_state,
    version: Number(row.version),
  }));
  const manifestRows = manifest.documents.map((document) => ({
    id: document.id,
    content_sha256: document.content_sha256,
    storage_relpath: document.storage_relpath,
    byte_size: document.byte_size,
    page_count: document.page_count,
    lifecycle_state: document.lifecycle_state,
    legal_hold_state: document.legal_hold_state,
    dispute_state: document.dispute_state,
    version: document.version,
  }));
  if (stableJson(rows) !== stableJson(manifestRows)) fail('DB_MANIFEST_MISMATCH', 'Assessment database and manifest do not match.');
}

async function createAssessmentStoreBackupLocked({
  database, dataRoot, backupRoot, recoveryId, policyVersion, retentionDays,
  createdAt = new Date().toISOString(),
} = {}) {
  assertDatabase(database, { backup: true });
  const policy = policyContract(policyVersion, retentionDays);
  const root = privateDirectory(backupRoot, { create: true });
  const finalRoot = directChild(root, recoveryId);
  if (fs.existsSync(finalRoot)) fail('BACKUP_EXISTS', 'Assessment backup package already exists.');
  canonicalTimestamp(createdAt, 'CREATED_AT_INVALID', 'Assessment backup timestamp');
  const staging = fs.mkdtempSync(path.join(root, '.assessment-backup-'));
  fs.chmodSync(staging, 0o700);
  try {
    fs.mkdirSync(path.join(staging, 'files'), { mode: 0o700 });
    const databasePath = path.join(staging, 'database.db');
    await database.backup(databasePath);
    fs.chmodSync(databasePath, 0o600);
    const snapshot = new Database(databasePath, { readonly: true, fileMustExist: true });
    let expected;
    try {
      if (snapshot.pragma('integrity_check', { simple: true }) !== 'ok' || snapshot.pragma('foreign_key_check').length) {
        fail('DATABASE_BACKUP_INVALID', 'Assessment database backup is invalid.');
      }
      expected = collectExpectedArtifacts(snapshot, dataRoot);
      const consistency = verifyAssessmentDbStoreConsistency({ database: snapshot, dataRoot });
      if (!consistency.ok) fail('STORE_INCONSISTENT', 'Assessment store contains orphan artifacts.');
    } finally {
      snapshot.close();
    }
    for (const document of expected.documents) {
      const copiedBlob = copyExclusive(document.blob_source, staging, `files/${document.storage_relpath}`);
      checkedFile(staging, `files/${document.storage_relpath}`, {
        expectedBytes: document.byte_size, expectedHash: document.content_sha256,
      });
      fs.chmodSync(copiedBlob, 0o600);
      for (const preview of document.previews) {
        const source = checkedFile(expected.assessmentRoot, preview.relative_path, {
          expectedBytes: preview.bytes, expectedHash: preview.sha256, png: true,
        });
        copyExclusive(source.path, staging, `files/${preview.relative_path}`);
      }
    }
    const databaseStat = fs.statSync(databasePath);
    const unsigned = {
      format_version: FORMAT_VERSION,
      recovery_id: recoveryId,
      created_at: createdAt,
      policy_version: policy.policyVersion,
      backup_retention_days: policy.retentionDays,
      database: { relative_path: 'database.db', bytes: databaseStat.size, sha256: sha256File(databasePath) },
      documents: expected.documents.map(manifestDocument),
    };
    const manifest = { ...unsigned, manifest_sha256: sha256Buffer(Buffer.from(stableJson(unsigned))) };
    const manifestPath = path.join(staging, 'manifest.json');
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    validateManifest(manifest);
    checkedFile(staging, 'database.db', { expectedBytes: manifest.database.bytes, expectedHash: manifest.database.sha256 });
    for (const document of manifest.documents) {
      checkedFile(staging, `files/${document.storage_relpath}`, {
        expectedBytes: document.byte_size, expectedHash: document.content_sha256,
      });
      for (const preview of document.previews) {
        checkedFile(staging, `files/${preview.relative_path}`, {
          expectedBytes: preview.bytes, expectedHash: preview.sha256, png: true,
        });
      }
    }
    if (fs.existsSync(finalRoot)) fail('BACKUP_EXISTS', 'Assessment backup package already exists.');
    fs.renameSync(staging, finalRoot);
    return { recovery_id: recoveryId, manifest };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

async function createAssessmentStoreBackup(options = {}) {
  try {
    return await createAssessmentStoreBackupLocked(options);
  } catch (error) {
    if (error instanceof AssessmentStoreBackupError) throw error;
    fail('BACKUP_CREATE_FAILED', 'Assessment backup creation failed without publishing a package.');
  }
}

function tableColumns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name));
}

function hasTable(database, table) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function currentDeletionPropagation(currentDatabase, manifest) {
  assertDatabase(currentDatabase);
  const packageIds = new Set(manifest.documents.map((document) => document.id));
  let documents;
  let requests;
  try {
    if (!hasTable(currentDatabase, 'assessment_document')
        || !hasTable(currentDatabase, 'assessment_deletion_request')) {
      fail('DELETION_PROPAGATION_SCHEMA_INVALID', 'Current Assessment deletion state is unavailable.');
    }
    documents = currentDatabase.prepare(`
      SELECT id, content_sha256, storage_relpath, lifecycle_state,
             retention_policy_version, delete_after, legal_hold_state, version, updated_at, deleted_at
      FROM assessment_document
      ORDER BY id
    `).all().filter((row) => packageIds.has(row.id));
    requests = currentDatabase.prepare(`
      SELECT request_id, document_id, state
      FROM assessment_deletion_request
      ORDER BY request_id
    `).all().filter((row) => packageIds.has(row.document_id));
  } catch (error) {
    if (error instanceof AssessmentStoreBackupError) throw error;
    fail('DELETION_PROPAGATION_SCHEMA_INVALID', 'Current Assessment deletion state is unavailable.');
  }
  if (documents.length !== packageIds.size) {
    fail('DELETION_PROPAGATION_STATE_INVALID', 'Current Assessment state does not match the recovery package.');
  }
  const currentById = new Map(documents.map((document) => [document.id, document]));
  const requestsByDocument = new Map();
  for (const request of requests) {
    if (!requestsByDocument.has(request.document_id)) requestsByDocument.set(request.document_id, []);
    requestsByDocument.get(request.document_id).push(request);
    if (request.state === 'pending' || request.state === 'retryable_failed') {
      fail('DELETION_PROPAGATION_INCOMPLETE', 'Assessment restore is blocked by an unfinished deletion request.');
    }
    if (request.state !== 'completed') {
      fail('DELETION_PROPAGATION_STATE_INVALID', 'Current Assessment deletion state is invalid.');
    }
  }
  for (const document of documents) {
    const documentRequests = requestsByDocument.get(document.id) || [];
    if (document.lifecycle_state === 'active' || document.lifecycle_state === 'frozen') {
      if (documentRequests.length) {
        fail('DELETION_PROPAGATION_STATE_INVALID', 'Current Assessment deletion request is invalid.');
      }
      continue;
    }
    if (document.lifecycle_state === 'deletion_pending') {
      fail('DELETION_PROPAGATION_INCOMPLETE', 'Assessment restore is blocked by an unfinished deletion request.');
    }
    if (document.lifecycle_state !== 'deleted' || document.content_sha256 !== null
        || document.storage_relpath !== null || document.deleted_at === null) {
      fail('DELETION_PROPAGATION_STATE_INVALID', 'Current Assessment tombstone is invalid.');
    }
    if (documentRequests.some((request) => request.state !== 'completed')) {
      fail('DELETION_PROPAGATION_INCOMPLETE', 'Assessment restore is blocked by an unfinished deletion request.');
    }
  }
  for (const request of requests) {
    const document = currentById.get(request.document_id);
    if (!document || document.lifecycle_state !== 'deleted') {
      fail('DELETION_PROPAGATION_STATE_INVALID', 'Current Assessment deletion request is invalid.');
    }
  }
  return Object.freeze({
    tombstones: documents.filter((document) => document.lifecycle_state === 'deleted'),
    completedRequests: requests,
  });
}

function applyTombstone(database, tombstone) {
  const columns = tableColumns(database, 'assessment_document');
  for (const required of ['id', 'content_sha256', 'storage_relpath', 'lifecycle_state']) {
    if (!columns.has(required)) fail('DELETION_PROPAGATION_SCHEMA_INVALID', 'Restored Assessment schema cannot preserve tombstones.');
  }
  const values = {
    content_sha256: null,
    storage_relpath: null,
    byte_size: null,
    page_count: null,
    mime_detected: null,
    report_type: 'unknown',
    assessment_date: null,
    analysis_status: 'pending',
    analysis_schema_version: null,
    analysis_json: null,
    analysis_error_code: null,
    review_state: 'superseded',
    dispute_state: 'resolved',
    lifecycle_state: 'deleted',
    retention_policy_version: tombstone.retention_policy_version,
    delete_after: tombstone.delete_after,
    legal_hold_state: tombstone.legal_hold_state,
    version: Number(tombstone.version),
    updated_at: tombstone.updated_at,
    deleted_at: tombstone.deleted_at,
  };
  const assignments = Object.keys(values).filter((column) => columns.has(column));
  const update = database.prepare(`
    UPDATE assessment_document
    SET ${assignments.map((column) => `${column} = @${column}`).join(', ')}
    WHERE id = @id
  `).run({ id: tombstone.id, ...values });
  if (update.changes !== 1) {
    fail('DELETION_PROPAGATION_STATE_INVALID', 'Current Assessment tombstone does not match the recovery package.');
  }
}

function applyCurrentDeletionPropagation(database, propagation) {
  try {
    database.transaction(() => {
      for (const tombstone of propagation.tombstones) applyTombstone(database, tombstone);
    })();
  } catch (error) {
    if (error instanceof AssessmentStoreBackupError) throw error;
    fail('DELETION_PROPAGATION_APPLY_FAILED', 'Current Assessment deletion state could not be applied.');
  }
}

function restoreAssessmentStoreBackupLocked({
  backupRoot, recoveryId, restoreRoot, policyVersion, retentionDays, now, currentDatabase,
  allowLegacyV1 = false,
} = {}, publication = {}) {
  const policy = policyContract(policyVersion, retentionDays);
  const restoredAt = canonicalTimestamp(now, 'RESTORE_TIME_REQUIRED', 'Assessment restore time');
  assertDatabase(currentDatabase);
  const packageData = readBackupPackage(backupRoot, recoveryId);
  if (packageData.manifest.format_version === 1 && allowLegacyV1 !== true) {
    fail('LEGACY_RESTORE_CONFIRMATION_REQUIRED', 'Legacy Assessment restore requires explicit confirmation.');
  }
  if (packageData.manifest.format_version === FORMAT_VERSION
      && (packageData.manifest.policy_version !== policy.policyVersion
        || packageData.manifest.backup_retention_days !== policy.retentionDays)) {
    fail('POLICY_CONTRACT_MISMATCH', 'Assessment backup policy contract does not match.');
  }
  const expiresAt = new Date(packageData.manifest.created_at).getTime()
    + policy.retentionDays * 24 * 60 * 60 * 1000;
  if (new Date(restoredAt).getTime() >= expiresAt) {
    fail('BACKUP_EXPIRED', 'Assessment backup package has expired.');
  }
  const propagation = currentDeletionPropagation(currentDatabase, packageData.manifest);
  const suppressedIds = new Set(propagation.tombstones.map((document) => document.id));
  const requestedRestoreRoot = String(restoreRoot || '');
  if (!path.isAbsolute(requestedRestoreRoot) || requestedRestoreRoot.includes('\0')) {
    fail('RESTORE_ROOT_INVALID', 'Assessment restore root is invalid.');
  }
  const parent = privateDirectory(path.dirname(path.resolve(requestedRestoreRoot)), { create: true });
  const destination = directChild(parent, path.basename(requestedRestoreRoot));
  if (fs.existsSync(destination)) {
    fail('RESTORE_ROOT_EXISTS', 'Assessment restore root must be a new direct child.');
  }

  const backupDb = new Database(packageData.databaseFile, { readonly: true, fileMustExist: true });
  try {
    if (backupDb.pragma('integrity_check', { simple: true }) !== 'ok' || backupDb.pragma('foreign_key_check').length) {
      fail('DATABASE_BACKUP_INVALID', 'Assessment database backup is invalid.');
    }
    assertManifestMatchesDatabase(backupDb, packageData.manifest);
  } finally {
    backupDb.close();
  }

  const staging = fs.mkdtempSync(path.join(parent, '.assessment-restore-'));
  fs.chmodSync(staging, 0o700);
  try {
    fs.mkdirSync(path.join(staging, 'assessment', 'accepted'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(staging, 'assessment', 'previews'), { recursive: true, mode: 0o700 });
    copyExclusive(packageData.databaseFile, staging, 'database.db');
    for (const document of packageData.manifest.documents) {
      if (suppressedIds.has(document.id)) continue;
      copyExclusive(
        checkedFile(packageData.packageRoot, `files/${document.storage_relpath}`, {
          expectedBytes: document.byte_size, expectedHash: document.content_sha256,
        }).path,
        staging,
        `assessment/${document.storage_relpath}`,
      );
      for (const preview of document.previews) {
        copyExclusive(
          checkedFile(packageData.packageRoot, `files/${preview.relative_path}`, {
            expectedBytes: preview.bytes, expectedHash: preview.sha256, png: true,
          }).path,
          staging,
          `assessment/${preview.relative_path}`,
        );
      }
    }
    const restoredDb = new Database(path.join(staging, 'database.db'), { fileMustExist: true });
    try {
      restoredDb.pragma('foreign_keys = ON');
      if (restoredDb.pragma('integrity_check', { simple: true }) !== 'ok' || restoredDb.pragma('foreign_key_check').length) {
        fail('RESTORE_DATABASE_INVALID', 'Restored Assessment database is invalid.');
      }
      assertManifestMatchesDatabase(restoredDb, packageData.manifest);
      applyCurrentDeletionPropagation(restoredDb, propagation);
      if (restoredDb.pragma('integrity_check', { simple: true }) !== 'ok' || restoredDb.pragma('foreign_key_check').length) {
        fail('RESTORE_DATABASE_INVALID', 'Restored Assessment database is invalid after deletion propagation.');
      }
      const consistency = verifyAssessmentDbStoreConsistency({ database: restoredDb, dataRoot: staging });
      if (!consistency.ok) fail('RESTORE_STORE_INCONSISTENT', 'Restored Assessment store is inconsistent.');
    } finally {
      restoredDb.close();
    }
    const stagingStat = fs.lstatSync(staging);
    publication.destination = destination;
    publication.device = stagingStat.dev;
    publication.inode = stagingStat.ino;
    publication.attempted = true;
    fs.renameSync(staging, destination);
    publication.published = true;
    return {
      recovery_id: recoveryId,
      restore_root: destination,
      database_path: path.join(destination, 'database.db'),
      document_count: packageData.manifest.documents.length - propagation.tombstones.length,
      tombstones_replayed: propagation.tombstones.length,
      deletion_requests_reviewed: propagation.completedRequests.length,
    };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function restoreAssessmentStoreBackup(options = {}) {
  const currentDatabase = options && options.currentDatabase;
  assertDatabase(currentDatabase);
  if (currentDatabase.inTransaction) {
    fail('CURRENT_DATABASE_TRANSACTION_ACTIVE', 'Current Assessment database must not already be in a transaction.');
  }
  const publication = {};
  try {
    return currentDatabase.transaction(() => restoreAssessmentStoreBackupLocked(options, publication)).immediate();
  } catch (error) {
    if (publication.attempted && publication.destination && fs.existsSync(publication.destination)) {
      try {
        const destinationStat = fs.lstatSync(publication.destination);
        if (!destinationStat.isSymbolicLink() && destinationStat.isDirectory()
            && destinationStat.dev === publication.device && destinationStat.ino === publication.inode) {
          fs.rmSync(publication.destination, { recursive: true, force: false });
        }
      } catch {
        fail('RESTORE_CLEANUP_FAILED', 'Assessment restore cleanup failed and requires operator review.');
      }
    }
    if (error instanceof AssessmentStoreBackupError) throw error;
    fail('RESTORE_FAILED', 'Assessment restore failed without publishing a destination.');
  }
}

function purgeExpiredAssessmentStoreBackupsLocked({
  backupRoot, policyVersion, retentionDays, now,
} = {}) {
  const policy = policyContract(policyVersion, retentionDays);
  const purgeAt = canonicalTimestamp(now, 'PURGE_TIME_INVALID', 'Assessment backup purge time');
  if (typeof backupRoot !== 'string' || !path.isAbsolute(backupRoot) || backupRoot.includes('\0')) {
    fail('ROOT_INVALID', 'Assessment backup root is invalid.');
  }
  let suppliedRoot;
  try { suppliedRoot = fs.lstatSync(backupRoot); } catch (error) {
    if (error && error.code === 'ENOENT') return { purged_count: 0, purged_recovery_ids: [] };
    throw error;
  }
  if (suppliedRoot.isSymbolicLink() || !suppliedRoot.isDirectory()) {
    fail('BACKUP_UNSAFE', 'Assessment backup root is unsafe.');
  }
  const root = privateDirectory(backupRoot);
  const packages = [];
  const seenRecoveryIds = new Set();

  for (const entry of fs.readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      fail('BACKUP_UNSAFE', 'Assessment backup root contains an unsafe package.');
    }
    if (entry.name.startsWith('.assessment-backup-')) continue;
    const quarantined = entry.name.startsWith(PURGE_QUARANTINE_PREFIX);
    if (entry.name.startsWith('.') && !quarantined) {
      fail('BACKUP_UNSAFE', 'Assessment backup root contains an unknown hidden package.');
    }
    const packageData = quarantined
      ? readBackupPackageAt(root, entry.name)
      : readBackupPackage(root, entry.name);
    if (packageData.manifest.format_version !== FORMAT_VERSION) {
      fail('LEGACY_POLICY_UNBOUND', 'Legacy Assessment backup packages cannot be purged automatically.');
    }
    if (packageData.manifest.policy_version !== policy.policyVersion
        || packageData.manifest.backup_retention_days !== policy.retentionDays) {
      fail('POLICY_CONTRACT_MISMATCH', 'Assessment backup policy contract does not match.');
    }
    if (seenRecoveryIds.has(packageData.manifest.recovery_id)) {
      fail('BACKUP_CHANGED', 'Assessment backup package identity is duplicated.');
    }
    seenRecoveryIds.add(packageData.manifest.recovery_id);
    packages.push({
      recoveryId: packageData.manifest.recovery_id,
      packageRoot: packageData.packageRoot,
      createdAt: new Date(packageData.manifest.created_at).getTime(),
      device: packageData.packageStat.device,
      inode: packageData.packageStat.inode,
      quarantined,
    });
  }

  const nowMs = new Date(purgeAt).getTime();
  const expired = [];
  for (const item of packages) {
    const due = nowMs >= item.createdAt + policy.retentionDays * DAY_MS;
    if (item.quarantined && !due) {
      fail('BACKUP_CHANGED', 'Assessment purge quarantine is not eligible for deletion.');
    }
    if (due) expired.push(item);
  }
  const purged = [];
  for (const item of expired) {
    const quarantinePath = path.join(root, `${PURGE_QUARANTINE_PREFIX}${crypto.randomBytes(12).toString('hex')}`);
    if (path.dirname(quarantinePath) !== root || fs.existsSync(quarantinePath)) {
      fail('PURGE_FAILED', 'Assessment backup purge failed and must be retried.');
    }
    fs.renameSync(item.packageRoot, quarantinePath);
    const moved = fs.lstatSync(quarantinePath);
    if (moved.isSymbolicLink() || !moved.isDirectory()
        || moved.dev !== item.device || moved.ino !== item.inode) {
      fail('BACKUP_CHANGED', 'Assessment backup package changed before purge.');
    }
    try { fs.rmSync(quarantinePath, { recursive: true, force: false }); } catch {
      fail('PURGE_FAILED', 'Assessment backup purge failed and must be retried.');
    }
    if (fs.existsSync(quarantinePath) || (!item.quarantined && fs.existsSync(item.packageRoot))) {
      fail('BACKUP_CHANGED', 'Assessment backup package changed during purge.');
    }
    purged.push(item.recoveryId);
  }
  return { purged_count: purged.length, purged_recovery_ids: purged };
}

function purgeExpiredAssessmentStoreBackups(options = {}) {
  try {
    return purgeExpiredAssessmentStoreBackupsLocked(options);
  } catch (error) {
    if (error instanceof AssessmentStoreBackupError) throw error;
    fail('PURGE_FAILED', 'Assessment backup purge failed and must be retried.');
  }
}

module.exports = {
  AssessmentStoreBackupError,
  createAssessmentStoreBackup,
  purgeExpiredAssessmentStoreBackups,
  restoreAssessmentStoreBackup,
  verifyAssessmentDbStoreConsistency,
};
