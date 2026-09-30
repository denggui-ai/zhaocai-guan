'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { applyAssessmentSchemaMigration } = require('./assessment-schema');
const {
  createAssessmentStoreBackup,
  restoreAssessmentStoreBackup,
  verifyAssessmentDbStoreConsistency,
} = require('./assessment-store-backup');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('synthetic-preview-only', 'ascii'),
]);
const CREATED_AT = '2026-07-12T08:00:00.000Z';
const RESTORE_NOW = '2026-07-13T08:00:00.000Z';
const POLICY_VERSION = 'assessment-backup-policy-v1';
const RETENTION_DAYS = 30;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function directoryDigest(root) {
  const entries = [];
  const stack = [{ absolute: root, relative: '' }];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current.absolute, { withFileTypes: true })) {
      const absolute = path.join(current.absolute, entry.name);
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) stack.push({ absolute, relative });
      else entries.push([relative, sha256(fs.readFileSync(absolute))]);
    }
  }
  return sha256(Buffer.from(JSON.stringify(entries.sort((left, right) => left[0].localeCompare(right[0])))));
}

function privateDirectory(directoryPath) {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(directoryPath, 0o700);
  return directoryPath;
}

function databaseFixture(file = ':memory:') {
  const database = new Database(file);
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE job (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE candidate (internal_id TEXT PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES job(id));
    INSERT INTO job VALUES (1, '合成岗位');
    INSERT INTO candidate VALUES ('C-SYNTHETIC-BACKUP', 1);
  `);
  applyAssessmentSchemaMigration(database);
  return database;
}

function insertDocument(database, {
  id, bytes, lifecycleState, legalHoldState = 'none', disputeState = 'none', deleted = false,
}) {
  const hash = deleted ? null : sha256(bytes);
  const storageRelpath = deleted ? null : `accepted/sha256/${hash.slice(0, 2)}/${hash}.pdf`;
  database.prepare(`
    INSERT INTO assessment_document (
      id, content_sha256, storage_relpath, byte_size, page_count, mime_detected,
      security_state, report_type, assessment_date, review_state, dispute_state,
      lifecycle_state, retention_policy_version, delete_after, legal_hold_state,
      created_by, version, created_at, updated_at, deleted_at
    ) VALUES (
      @id, @hash, @storage_relpath, @byte_size, @page_count, @mime,
      'accepted', @report_type, @assessment_date, @review_state, @dispute_state,
      @lifecycle_state, 'assessment-retention-v1', '2026-07-12T00:00:00.000Z', @legal_hold_state,
      'local-primary-operator', 3, @now, @now, @deleted_at
    )
  `).run({
    id,
    hash,
    storage_relpath: storageRelpath,
    byte_size: deleted ? null : bytes.length,
    page_count: deleted ? null : 1,
    mime: deleted ? null : 'application/pdf',
    report_type: deleted ? 'unknown' : 'career_potential',
    assessment_date: deleted ? null : '2026-07-01',
    review_state: deleted ? 'superseded' : 'ready',
    dispute_state: disputeState,
    lifecycle_state: lifecycleState,
    legal_hold_state: legalHoldState,
    now: CREATED_AT,
    deleted_at: deleted ? CREATED_AT : null,
  });
  return { id, hash, storageRelpath, bytes };
}

function writeArtifactSet(dataRoot, document) {
  const assessmentRoot = privateDirectory(path.join(dataRoot, 'assessment'));
  const blob = path.join(assessmentRoot, ...document.storageRelpath.split('/'));
  privateDirectory(path.dirname(blob));
  fs.writeFileSync(blob, document.bytes, { mode: 0o600 });
  const previewRelpath = `previews/sha256/${document.hash.slice(0, 2)}/${document.hash}/page-1.png`;
  const preview = path.join(assessmentRoot, ...previewRelpath.split('/'));
  privateDirectory(path.dirname(preview));
  fs.writeFileSync(preview, PNG, { mode: 0o600 });
  return { blob, preview, previewRelpath };
}

function expectCode(work, code) {
  return Promise.resolve().then(work).then(
    () => assert.fail(`expected ${code}`),
    (error) => assert.equal(error.code, code, error.stack),
  );
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-assessment-store-backup-'));
  fs.chmodSync(root, 0o700);
  const dataRoot = privateDirectory(path.join(root, 'synthetic-data-root'));
  const backupRoot = privateDirectory(path.join(root, 'backups'));
  const restoreParent = privateDirectory(path.join(root, 'restores'));
  const currentDatabasePath = path.join(root, 'synthetic-current.db');
  const database = databaseFixture(currentDatabasePath);
  const backupOptions = (recoveryId) => ({
    database,
    dataRoot,
    backupRoot,
    recoveryId,
    policyVersion: POLICY_VERSION,
    retentionDays: RETENTION_DAYS,
    createdAt: CREATED_AT,
  });
  const restoreOptions = (recoveryId, restoreRoot, overrides = {}) => ({
    backupRoot,
    recoveryId,
    restoreRoot,
    policyVersion: POLICY_VERSION,
    retentionDays: RETENTION_DAYS,
    now: RESTORE_NOW,
    currentDatabase: database,
    ...overrides,
  });
  try {
    const active = insertDocument(database, {
      id: 'DOC-ACTIVE', bytes: Buffer.from('%PDF-1.4\nsynthetic-active\n%%EOF\n'), lifecycleState: 'active',
    });
    const frozen = insertDocument(database, {
      id: 'DOC-FROZEN-HOLD', bytes: Buffer.from('%PDF-1.4\nsynthetic-frozen\n%%EOF\n'),
      lifecycleState: 'frozen', legalHoldState: 'active', disputeState: 'open',
    });
    const deletionPending = insertDocument(database, {
      id: 'DOC-DELETION-PENDING', bytes: Buffer.from('%PDF-1.4\nsynthetic-delete-pending\n%%EOF\n'),
      lifecycleState: 'deletion_pending',
    });
    insertDocument(database, {
      id: 'DOC-TOMBSTONE', bytes: Buffer.alloc(0), lifecycleState: 'deleted', deleted: true,
    });
    const artifacts = [active, frozen, deletionPending].map((document) => writeArtifactSet(dataRoot, document));

    assert.deepEqual(verifyAssessmentDbStoreConsistency({ database, dataRoot }), {
      ok: true, document_count: 3, blob_count: 3, preview_file_count: 3,
      orphan_blob_count: 0, orphan_preview_count: 0,
    });

    const orphanHash = 'f'.repeat(64);
    const orphanBlob = path.join(dataRoot, 'assessment', 'accepted', 'sha256', 'ff', `${orphanHash}.pdf`);
    privateDirectory(path.dirname(orphanBlob));
    fs.writeFileSync(orphanBlob, '%PDF-1.4\norphan\n', { mode: 0o600 });
    assert.equal(verifyAssessmentDbStoreConsistency({ database, dataRoot }).orphan_blob_count, 1);
    fs.rmSync(orphanBlob);

    const orphanPreview = path.join(dataRoot, 'assessment', 'previews', 'sha256', 'ff', orphanHash, 'page-1.png');
    privateDirectory(path.dirname(orphanPreview));
    fs.writeFileSync(orphanPreview, PNG, { mode: 0o600 });
    assert.equal(verifyAssessmentDbStoreConsistency({ database, dataRoot }).orphan_preview_count, 1);
    fs.rmSync(path.join(dataRoot, 'assessment', 'previews', 'sha256', 'ff'), { recursive: true });

    const originalActiveBytes = fs.readFileSync(artifacts[0].blob);
    fs.rmSync(artifacts[0].blob);
    await expectCode(() => verifyAssessmentDbStoreConsistency({ database, dataRoot }), 'ARTIFACT_MISSING');
    fs.writeFileSync(artifacts[0].blob, originalActiveBytes, { mode: 0o600 });

    const symlinkTarget = path.join(root, 'synthetic-symlink-target.pdf');
    fs.writeFileSync(symlinkTarget, originalActiveBytes, { mode: 0o600 });
    fs.rmSync(artifacts[0].blob);
    fs.symlinkSync(symlinkTarget, artifacts[0].blob);
    await expectCode(() => verifyAssessmentDbStoreConsistency({ database, dataRoot }), 'ARTIFACT_UNSAFE');
    fs.rmSync(artifacts[0].blob);
    fs.writeFileSync(artifacts[0].blob, originalActiveBytes, { mode: 0o600 });

    const hashWrongBytes = Buffer.from(originalActiveBytes);
    hashWrongBytes[hashWrongBytes.length - 2] ^= 1;
    fs.writeFileSync(artifacts[0].blob, hashWrongBytes, { mode: 0o600 });
    await expectCode(() => verifyAssessmentDbStoreConsistency({ database, dataRoot }), 'ARTIFACT_HASH_MISMATCH');
    fs.writeFileSync(artifacts[0].blob, originalActiveBytes, { mode: 0o600 });

    await expectCode(() => createAssessmentStoreBackup({
      database, dataRoot, backupRoot, recoveryId: 'assessment-policy-missing', createdAt: CREATED_AT,
    }), 'POLICY_CONTRACT_REQUIRED');
    await expectCode(() => createAssessmentStoreBackup({
      ...backupOptions('assessment-time-invalid'), createdAt: '2026-07-12T08:00:00Z',
    }), 'CREATED_AT_INVALID');
    const originalMkdtempSync = fs.mkdtempSync;
    fs.mkdtempSync = function syntheticBackupCreateFailure(prefix, options) {
      if (String(prefix).includes('.assessment-backup-')) {
        const error = new Error(`synthetic EACCES at ${prefix}`);
        error.code = 'EACCES';
        throw error;
      }
      return originalMkdtempSync.call(fs, prefix, options);
    };
    try {
      await assert.rejects(
        createAssessmentStoreBackup(backupOptions('assessment-create-io-failure')),
        (error) => error && error.code === 'BACKUP_CREATE_FAILED'
          && error.message === 'Assessment backup creation failed without publishing a package.'
          && !error.message.includes(root) && error.cause === undefined,
      );
    } finally {
      fs.mkdtempSync = originalMkdtempSync;
    }
    assert.equal(fs.existsSync(path.join(backupRoot, 'assessment-create-io-failure')), false);
    const primary = await createAssessmentStoreBackup(backupOptions('assessment-primary'));
    assert.equal(primary.manifest.documents.length, 3);
    assert.equal(primary.manifest.policy_version, POLICY_VERSION);
    assert.equal(primary.manifest.backup_retention_days, RETENTION_DAYS);
    assert.equal(primary.manifest.documents.some((row) => row.id === 'DOC-TOMBSTONE'), false);
    const primaryPackageRoot = path.join(backupRoot, 'assessment-primary');
    const primaryPackageDigest = directoryDigest(primaryPackageRoot);
    const legacyPackageRoot = path.join(backupRoot, 'assessment-legacy-v1');
    fs.cpSync(primaryPackageRoot, legacyPackageRoot, { recursive: true });
    const legacyManifestPath = path.join(legacyPackageRoot, 'manifest.json');
    const legacyManifest = JSON.parse(fs.readFileSync(legacyManifestPath, 'utf8'));
    legacyManifest.format_version = 1;
    legacyManifest.recovery_id = 'assessment-legacy-v1';
    delete legacyManifest.policy_version;
    delete legacyManifest.backup_retention_days;
    delete legacyManifest.manifest_sha256;
    legacyManifest.manifest_sha256 = sha256(Buffer.from(stableJson(legacyManifest)));
    fs.writeFileSync(legacyManifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, { mode: 0o600 });
    const legacyPackageDigest = directoryDigest(legacyPackageRoot);
    await expectCode(() => createAssessmentStoreBackup(backupOptions('assessment-primary')), 'BACKUP_EXISTS');

    await createAssessmentStoreBackup(backupOptions('assessment-bad-manifest'));
    await createAssessmentStoreBackup(backupOptions('assessment-bad-artifact'));
    await createAssessmentStoreBackup(backupOptions('assessment-symlink-package'));

    await expectCode(() => restoreAssessmentStoreBackup(restoreOptions(
      'assessment-primary', path.join(restoreParent, 'missing-current-state'), { currentDatabase: undefined },
    )), 'DATABASE_REQUIRED');
    await expectCode(() => restoreAssessmentStoreBackup(restoreOptions(
      'assessment-primary', path.join(restoreParent, 'missing-time'), { now: undefined },
    )), 'RESTORE_TIME_REQUIRED');
    await expectCode(() => restoreAssessmentStoreBackup(restoreOptions(
      'assessment-primary', path.join(restoreParent, 'wrong-policy'), { policyVersion: 'wrong-policy' },
    )), 'POLICY_CONTRACT_MISMATCH');
    await expectCode(() => restoreAssessmentStoreBackup(restoreOptions(
      'assessment-primary', path.join(restoreParent, 'expired'), { now: '2026-08-11T08:00:00.000Z' },
    )), 'BACKUP_EXPIRED');
    await expectCode(() => restoreAssessmentStoreBackup(restoreOptions(
      'assessment-primary', path.join(restoreParent, 'pending-without-request'),
    )), 'DELETION_PROPAGATION_INCOMPLETE');
    await expectCode(() => restoreAssessmentStoreBackup(restoreOptions(
      'assessment-legacy-v1', path.join(restoreParent, 'legacy-not-confirmed'),
    )), 'LEGACY_RESTORE_CONFIRMATION_REQUIRED');
    await expectCode(() => restoreAssessmentStoreBackup(restoreOptions(
      'assessment-legacy-v1', path.join(restoreParent, 'legacy-pending-without-request'),
      { allowLegacyV1: true },
    )), 'DELETION_PROPAGATION_INCOMPLETE');
    database.prepare(`
      INSERT INTO assessment_deletion_request (
        request_id, document_id, expected_version, reason_code, policy_version, effective_at,
        state, last_error_code, attempt_count,
        actor_id, actor_type, actor_source, actor_session_id, actor_assurance,
        created_at, updated_at, physical_deleted_at, completed_at
      ) VALUES (
        'REQ-DELETE-PENDING', 'DOC-DELETION-PENDING', 3, 'retention_due',
        'assessment-retention-v1', '2026-07-12T10:00:00.000Z',
        'pending', NULL, 0,
        'local-primary-operator', 'local_os_subject', 'server_local_instance',
        'synthetic-session', 'local_instance_only',
        '2026-07-12T09:00:00.000Z', '2026-07-12T09:00:00.000Z', NULL, NULL
      )
    `).run();
    const retryRestoreRoot = path.join(restoreParent, 'pending-deletion');
    await expectCode(() => restoreAssessmentStoreBackup(restoreOptions(
      'assessment-primary', retryRestoreRoot,
    )), 'DELETION_PROPAGATION_INCOMPLETE');
    assert.equal(fs.existsSync(retryRestoreRoot), false);
    database.prepare(`
      UPDATE assessment_deletion_request
      SET state = 'retryable_failed', last_error_code = 'SYNTHETIC_FAILURE',
          attempt_count = 1, updated_at = '2026-07-12T09:30:00.000Z'
      WHERE request_id = 'REQ-DELETE-PENDING'
    `).run();
    await expectCode(() => restoreAssessmentStoreBackup(restoreOptions(
      'assessment-primary', retryRestoreRoot,
    )), 'DELETION_PROPAGATION_INCOMPLETE');
    assert.equal(fs.existsSync(retryRestoreRoot), false);

    // Complete the deletion after the old package was created. Retrying the
    // same restore request must apply current state without resurrecting files.
    database.prepare(`
      UPDATE assessment_document
      SET content_sha256 = NULL, storage_relpath = NULL, byte_size = NULL, page_count = NULL,
          mime_detected = NULL, report_type = 'unknown', assessment_date = NULL,
          review_state = 'superseded', dispute_state = 'resolved', lifecycle_state = 'deleted',
          version = 4, updated_at = ?, deleted_at = ?
      WHERE id = 'DOC-ACTIVE'
    `).run('2026-07-12T09:45:00.000Z', '2026-07-12T09:45:00.000Z');
    database.prepare(`
      UPDATE assessment_document
      SET content_sha256 = NULL, storage_relpath = NULL, byte_size = NULL, page_count = NULL,
          mime_detected = NULL, report_type = 'unknown', assessment_date = NULL,
          review_state = 'superseded', dispute_state = 'resolved', lifecycle_state = 'deleted',
          version = 4, updated_at = ?, deleted_at = ?
      WHERE id = 'DOC-DELETION-PENDING'
    `).run('2026-07-12T10:00:00.000Z', '2026-07-12T10:00:00.000Z');
    database.prepare(`
      UPDATE assessment_deletion_request
      SET state = 'completed', last_error_code = NULL, attempt_count = 2,
          updated_at = '2026-07-12T10:00:00.000Z',
          physical_deleted_at = '2026-07-12T10:00:00.000Z',
          completed_at = '2026-07-12T10:00:00.000Z'
      WHERE request_id = 'REQ-DELETE-PENDING'
    `).run();

    // Destroy the original store after backup. Restore must depend only on the verified package.
    fs.rmSync(path.join(dataRoot, 'assessment'), { recursive: true });
    const restoreRoot = retryRestoreRoot;
    const realRestoreParent = fs.realpathSync(restoreParent);
    const originalRenameSync = fs.renameSync;
    fs.renameSync = function syntheticRestorePublishFailure(source, destination) {
      if (path.dirname(destination) === realRestoreParent
          && path.basename(destination) === path.basename(restoreRoot)) {
        const error = new Error(`synthetic EACCES at ${destination}`);
        error.code = 'EACCES';
        throw error;
      }
      return originalRenameSync.call(fs, source, destination);
    };
    try {
      assert.throws(
        () => restoreAssessmentStoreBackup(restoreOptions('assessment-primary', restoreRoot)),
        (error) => error && error.code === 'RESTORE_FAILED'
          && error.message === 'Assessment restore failed without publishing a destination.'
          && !error.message.includes(restoreRoot) && error.cause === undefined,
      );
    } finally {
      fs.renameSync = originalRenameSync;
    }
    assert.equal(fs.existsSync(restoreRoot), false);
    assert.deepEqual(fs.readdirSync(restoreParent).filter((name) => name.startsWith('.assessment-restore-')), []);

    const competingDatabase = new Database(currentDatabasePath);
    competingDatabase.pragma('busy_timeout = 0');
    const originalMkdirSync = fs.mkdirSync;
    let competingWriteBlocked = false;
    let competingWriteAttempted = false;
    fs.mkdirSync = function syntheticCompetingWrite(target, options) {
      const result = originalMkdirSync.call(fs, target, options);
      if (!competingWriteAttempted && String(target).includes('.assessment-restore-')
          && String(target).endsWith(path.join('assessment', 'accepted'))) {
        competingWriteAttempted = true;
        try {
          competingDatabase.prepare(`
            UPDATE assessment_document SET updated_at = '2026-07-12T10:30:00.000Z'
            WHERE id = 'DOC-FROZEN-HOLD'
          `).run();
        } catch (error) {
          competingWriteBlocked = error && error.code === 'SQLITE_BUSY';
        }
      }
      return result;
    };
    let restored;
    try {
      restored = restoreAssessmentStoreBackup(restoreOptions('assessment-primary', restoreRoot));
    } finally {
      fs.mkdirSync = originalMkdirSync;
      competingDatabase.close();
    }
    assert.equal(competingWriteAttempted, true);
    assert.equal(competingWriteBlocked, true, 'current deletion state must remain locked through publish');
    assert.equal(restored.document_count, 1);
    assert.equal(restored.tombstones_replayed, 2);
    assert.equal(restored.deletion_requests_reviewed, 1);
    const restoredDb = new Database(restored.database_path, { readonly: true, fileMustExist: true });
    try {
      assert.deepEqual(verifyAssessmentDbStoreConsistency({ database: restoredDb, dataRoot: restoreRoot }), {
        ok: true, document_count: 1, blob_count: 1, preview_file_count: 1,
        orphan_blob_count: 0, orphan_preview_count: 0,
      });
      assert.deepEqual(restoredDb.prepare(`
        SELECT lifecycle_state, legal_hold_state, dispute_state
        FROM assessment_document WHERE id = 'DOC-FROZEN-HOLD'
      `).get(), { lifecycle_state: 'frozen', legal_hold_state: 'active', dispute_state: 'open' });
      assert.deepEqual(restoredDb.prepare(`
        SELECT lifecycle_state, content_sha256, storage_relpath
        FROM assessment_document WHERE id = 'DOC-DELETION-PENDING'
      `).get(), { lifecycle_state: 'deleted', content_sha256: null, storage_relpath: null });
      assert.deepEqual(restoredDb.prepare(`
        SELECT lifecycle_state, content_sha256, storage_relpath
        FROM assessment_document WHERE id = 'DOC-ACTIVE'
      `).get(), { lifecycle_state: 'deleted', content_sha256: null, storage_relpath: null });
      assert.equal(restoredDb.prepare(`
        SELECT state FROM assessment_deletion_request WHERE request_id = 'REQ-DELETE-PENDING'
      `).get(), undefined);
      assert.equal(fs.existsSync(path.join(
        restoreRoot, 'assessment', ...deletionPending.storageRelpath.split('/'),
      )), false);
      assert.equal(fs.existsSync(path.join(
        restoreRoot, 'assessment', 'previews', 'sha256', deletionPending.hash.slice(0, 2),
        deletionPending.hash, 'page-1.png',
      )), false);
      assert.equal(fs.existsSync(path.join(
        restoreRoot, 'assessment', ...active.storageRelpath.split('/'),
      )), false);
    } finally {
      restoredDb.close();
    }
    assert.equal(directoryDigest(primaryPackageRoot), primaryPackageDigest);

    const legacyRestoreRoot = path.join(restoreParent, 'restored-legacy-v1');
    const legacyRestored = restoreAssessmentStoreBackup(restoreOptions(
      'assessment-legacy-v1', legacyRestoreRoot, { allowLegacyV1: true },
    ));
    assert.equal(legacyRestored.document_count, 1);
    assert.equal(legacyRestored.tombstones_replayed, 2);
    assert.equal(legacyRestored.deletion_requests_reviewed, 1);
    assert.equal(fs.existsSync(path.join(
      legacyRestoreRoot, 'assessment', ...active.storageRelpath.split('/'),
    )), false);
    assert.equal(fs.existsSync(path.join(
      legacyRestoreRoot, 'assessment', ...deletionPending.storageRelpath.split('/'),
    )), false);
    assert.equal(directoryDigest(legacyPackageRoot), legacyPackageDigest);

    const badManifestPath = path.join(backupRoot, 'assessment-bad-manifest', 'manifest.json');
    const badManifest = JSON.parse(fs.readFileSync(badManifestPath, 'utf8'));
    badManifest.created_at = '2026-07-12T09:00:00.000Z';
    fs.writeFileSync(badManifestPath, `${JSON.stringify(badManifest)}\n`, { mode: 0o600 });
    const badManifestRestore = path.join(restoreParent, 'bad-manifest');
    await expectCode(() => restoreAssessmentStoreBackup(restoreOptions(
      'assessment-bad-manifest', badManifestRestore,
    )), 'MANIFEST_HASH_MISMATCH');
    assert.equal(fs.existsSync(badManifestRestore), false);

    const badArtifactManifest = JSON.parse(fs.readFileSync(
      path.join(backupRoot, 'assessment-bad-artifact', 'manifest.json'), 'utf8',
    ));
    const badArtifactPath = path.join(
      backupRoot, 'assessment-bad-artifact', 'files',
      ...badArtifactManifest.documents[0].storage_relpath.split('/'),
    );
    fs.appendFileSync(badArtifactPath, 'corrupt');
    const badArtifactRestore = path.join(restoreParent, 'bad-artifact');
    await expectCode(() => restoreAssessmentStoreBackup(restoreOptions(
      'assessment-bad-artifact', badArtifactRestore,
    )), 'ARTIFACT_SIZE_MISMATCH');
    assert.equal(fs.existsSync(badArtifactRestore), false);

    const symlinkManifest = JSON.parse(fs.readFileSync(
      path.join(backupRoot, 'assessment-symlink-package', 'manifest.json'), 'utf8',
    ));
    const symlinkArtifact = path.join(
      backupRoot, 'assessment-symlink-package', 'files',
      ...symlinkManifest.documents[0].storage_relpath.split('/'),
    );
    fs.rmSync(symlinkArtifact);
    fs.symlinkSync(
      path.join(backupRoot, 'assessment-primary', 'files', ...symlinkManifest.documents[0].storage_relpath.split('/')),
      symlinkArtifact,
    );
    await expectCode(() => restoreAssessmentStoreBackup(restoreOptions(
      'assessment-symlink-package', path.join(restoreParent, 'symlink-package'),
    )), 'ARTIFACT_UNSAFE');

    const escapeDb = databaseFixture();
    const escapeRoot = privateDirectory(path.join(root, 'escape-data-root'));
    privateDirectory(path.join(escapeRoot, 'assessment'));
    try {
      const bytes = Buffer.from('%PDF-1.4\nescape\n%%EOF\n');
      escapeDb.prepare(`
        INSERT INTO assessment_document (
          id, content_sha256, storage_relpath, byte_size, page_count, mime_detected,
          security_state, report_type, review_state, lifecycle_state, legal_hold_state,
          created_by, version, created_at, updated_at
        ) VALUES (
          'DOC-ESCAPE', ?, '../escape.pdf', ?, 1, 'application/pdf',
          'accepted', 'unknown', 'ready', 'active', 'none',
          'local-primary-operator', 1, ?, ?
        )
      `).run(sha256(bytes), bytes.length, CREATED_AT, CREATED_AT);
      await expectCode(() => verifyAssessmentDbStoreConsistency({ database: escapeDb, dataRoot: escapeRoot }),
        'STORAGE_RELPATH_INVALID');
    } finally {
      escapeDb.close();
    }

    console.log(JSON.stringify({
      ok: true,
      task: 'F017-D-assessment-store-backup',
      synthetic_only: true,
      real_database_read: false,
      restored_documents: 1,
      tombstones_replayed: 2,
      deletion_requests_reviewed: 1,
      legacy_v1_restore_guarded: true,
      concurrent_delete_write_blocked: true,
      tombstone_not_restored_as_file: true,
    }));
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
