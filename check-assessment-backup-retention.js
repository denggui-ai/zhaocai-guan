'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { purgeExpiredAssessmentStoreBackups } = require('./assessment-store-backup');

const POLICY_VERSION = 'assessment-retention-synthetic-v1';
const RETENTION_DAYS = 30;
const CREATED_AT = '2026-07-01T00:00:00.000Z';
const EXPIRY = '2026-07-31T00:00:00.000Z';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function privateDirectory(parent, name) {
  const target = path.join(parent, name);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.chmodSync(target, 0o700);
  return target;
}

function writePrivateFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, content, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function signManifest(manifest) {
  const unsigned = { ...manifest };
  delete unsigned.manifest_sha256;
  return { ...unsigned, manifest_sha256: sha256(Buffer.from(stableJson(unsigned))) };
}

function writeManifest(packageRoot, manifest) {
  writePrivateFile(path.join(packageRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

function createSyntheticPackage(backupRoot, recoveryId, {
  createdAt = CREATED_AT,
  policyVersion = POLICY_VERSION,
  retentionDays = RETENTION_DAYS,
} = {}) {
  const packageRoot = privateDirectory(backupRoot, recoveryId);
  privateDirectory(packageRoot, 'files');
  const database = Buffer.from(`synthetic-assessment-database:${recoveryId}`);
  const pdf = Buffer.from('%PDF-1.4\nsynthetic assessment only\n%%EOF\n');
  const contentHash = sha256(pdf);
  const preview = Buffer.concat([PNG_SIGNATURE, Buffer.from('synthetic preview only')]);
  const previewHash = sha256(preview);
  const storageRelpath = `accepted/sha256/${contentHash.slice(0, 2)}/${contentHash}.pdf`;
  const previewRelpath = `previews/sha256/${contentHash.slice(0, 2)}/${contentHash}/page-1.png`;
  writePrivateFile(path.join(packageRoot, 'database.db'), database);
  writePrivateFile(path.join(packageRoot, 'files', ...storageRelpath.split('/')), pdf);
  writePrivateFile(path.join(packageRoot, 'files', ...previewRelpath.split('/')), preview);
  const manifest = signManifest({
    format_version: 2,
    recovery_id: recoveryId,
    created_at: createdAt,
    policy_version: policyVersion,
    backup_retention_days: retentionDays,
    database: {
      relative_path: 'database.db',
      bytes: database.length,
      sha256: sha256(database),
    },
    documents: [{
      id: `assessment-${recoveryId}`,
      content_sha256: contentHash,
      storage_relpath: storageRelpath,
      byte_size: pdf.length,
      page_count: 1,
      lifecycle_state: 'active',
      legal_hold_state: 'none',
      dispute_state: 'none',
      version: 1,
      previews: [{ relative_path: previewRelpath, bytes: preview.length, sha256: previewHash }],
    }],
  });
  writeManifest(packageRoot, manifest);
  return { packageRoot, manifest };
}

function expectCode(code) {
  return (error) => error && error.code === code;
}

function purge(backupRoot, overrides = {}) {
  return purgeExpiredAssessmentStoreBackups({
    backupRoot,
    policyVersion: POLICY_VERSION,
    retentionDays: RETENTION_DAYS,
    now: EXPIRY,
    ...overrides,
  });
}

function withScenario(root, name, callback) {
  const backupRoot = privateDirectory(root, name);
  callback(backupRoot);
}

function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-assessment-retention-'));
  fs.chmodSync(root, 0o700);
  try {
    assert.throws(
      () => purgeExpiredAssessmentStoreBackups({ backupRoot: path.join(root, 'missing') }),
      expectCode('POLICY_CONTRACT_REQUIRED'),
    );
    assert.throws(
      () => purgeExpiredAssessmentStoreBackups({
        backupRoot: path.join(root, 'missing'),
        policyVersion: POLICY_VERSION,
        retentionDays: RETENTION_DAYS,
      }),
      expectCode('PURGE_TIME_INVALID'),
    );
    assert.deepEqual(
      purge(path.join(root, 'not-created')),
      { purged_count: 0, purged_recovery_ids: [] },
    );

    withScenario(root, 'not-expired', (backupRoot) => {
      const item = createSyntheticPackage(backupRoot, 'not-expired');
      assert.deepEqual(
        purge(backupRoot, { now: '2026-07-30T23:59:59.999Z' }),
        { purged_count: 0, purged_recovery_ids: [] },
      );
      assert.equal(fs.existsSync(item.packageRoot), true);
    });

    withScenario(root, 'exact-expiry', (backupRoot) => {
      const item = createSyntheticPackage(backupRoot, 'exact-expiry');
      assert.deepEqual(
        purge(backupRoot),
        { purged_count: 1, purged_recovery_ids: ['exact-expiry'] },
      );
      assert.equal(fs.existsSync(item.packageRoot), false);
      assert.deepEqual(
        purge(backupRoot),
        { purged_count: 0, purged_recovery_ids: [] },
      );
    });

    withScenario(root, 'manifest-hash', (backupRoot) => {
      const item = createSyntheticPackage(backupRoot, 'bad-manifest-hash');
      const tampered = { ...item.manifest, created_at: '2026-06-30T00:00:00.000Z' };
      writeManifest(item.packageRoot, tampered);
      assert.throws(() => purge(backupRoot), expectCode('MANIFEST_HASH_MISMATCH'));
      assert.equal(fs.existsSync(item.packageRoot), true);
    });

    withScenario(root, 'v1-format', (backupRoot) => {
      const item = createSyntheticPackage(backupRoot, 'v1-format');
      const legacy = { ...item.manifest, format_version: 1 };
      delete legacy.policy_version;
      delete legacy.backup_retention_days;
      writeManifest(item.packageRoot, signManifest(legacy));
      assert.throws(() => purge(backupRoot), expectCode('LEGACY_POLICY_UNBOUND'));
      assert.equal(fs.existsSync(item.packageRoot), true);
    });

    const danglingRoot = path.join(root, 'dangling-backup-root');
    fs.symlinkSync(path.join(root, 'missing-backup-target'), danglingRoot);
    assert.throws(() => purge(danglingRoot), expectCode('BACKUP_UNSAFE'));

    withScenario(root, 'wrong-policy', (backupRoot) => {
      const item = createSyntheticPackage(backupRoot, 'wrong-policy', { policyVersion: 'unapproved-policy' });
      assert.throws(() => purge(backupRoot), expectCode('POLICY_CONTRACT_MISMATCH'));
      assert.equal(fs.existsSync(item.packageRoot), true);
    });

    withScenario(root, 'wrong-retention', (backupRoot) => {
      const item = createSyntheticPackage(backupRoot, 'wrong-retention', { retentionDays: 31 });
      assert.throws(() => purge(backupRoot), expectCode('POLICY_CONTRACT_MISMATCH'));
      assert.equal(fs.existsSync(item.packageRoot), true);
    });

    withScenario(root, 'artifact-hash', (backupRoot) => {
      const item = createSyntheticPackage(backupRoot, 'bad-artifact-hash');
      fs.appendFileSync(path.join(item.packageRoot, 'database.db'), 'tampered');
      assert.throws(() => purge(backupRoot), expectCode('ARTIFACT_SIZE_MISMATCH'));
      assert.equal(fs.existsSync(item.packageRoot), true);
    });

    withScenario(root, 'preview-signature', (backupRoot) => {
      const item = createSyntheticPackage(backupRoot, 'bad-preview-signature');
      const tampered = JSON.parse(JSON.stringify(item.manifest));
      const preview = tampered.documents[0].previews[0];
      const invalidPng = Buffer.alloc(preview.bytes, 0x61);
      writePrivateFile(path.join(item.packageRoot, 'files', ...preview.relative_path.split('/')), invalidPng);
      preview.sha256 = sha256(invalidPng);
      writeManifest(item.packageRoot, signManifest(tampered));
      assert.throws(() => purge(backupRoot), expectCode('PREVIEW_INVALID'));
      assert.equal(fs.existsSync(item.packageRoot), true);
    });

    withScenario(root, 'path-traversal', (backupRoot) => {
      const item = createSyntheticPackage(backupRoot, 'path-traversal');
      const tampered = JSON.parse(JSON.stringify(item.manifest));
      tampered.documents[0].storage_relpath = '../outside.pdf';
      writeManifest(item.packageRoot, signManifest(tampered));
      assert.throws(() => purge(backupRoot), expectCode('STORAGE_RELPATH_INVALID'));
      assert.equal(fs.existsSync(item.packageRoot), true);
    });

    withScenario(root, 'artifact-symlink', (backupRoot) => {
      const item = createSyntheticPackage(backupRoot, 'artifact-symlink');
      const databasePath = path.join(item.packageRoot, 'database.db');
      const external = path.join(root, 'external-synthetic.db');
      writePrivateFile(external, Buffer.from('external synthetic only'));
      fs.rmSync(databasePath);
      fs.symlinkSync(external, databasePath);
      assert.throws(() => purge(backupRoot), expectCode('ARTIFACT_UNSAFE'));
      assert.equal(fs.existsSync(item.packageRoot), true);
      assert.equal(fs.existsSync(external), true);
    });

    withScenario(root, 'package-symlink', (backupRoot) => {
      const external = privateDirectory(root, 'external-package-target');
      fs.symlinkSync(external, path.join(backupRoot, 'linked-package'));
      assert.throws(() => purge(backupRoot), expectCode('BACKUP_UNSAFE'));
      assert.equal(fs.existsSync(external), true);
    });

    withScenario(root, 'preflight', (backupRoot) => {
      const valid = createSyntheticPackage(backupRoot, 'a-valid-expired');
      const invalid = createSyntheticPackage(backupRoot, 'z-invalid-expired');
      fs.appendFileSync(path.join(invalid.packageRoot, 'database.db'), 'tampered');
      assert.throws(() => purge(backupRoot), expectCode('ARTIFACT_SIZE_MISMATCH'));
      assert.equal(fs.existsSync(valid.packageRoot), true, 'preflight must finish before any delete');
      assert.equal(fs.existsSync(invalid.packageRoot), true);
    });

    withScenario(root, 'path-swap', (backupRoot) => {
      const item = createSyntheticPackage(backupRoot, 'swap-target');
      const hiddenOriginal = path.join(backupRoot, '.moved-original');
      const realBackupRoot = fs.realpathSync(backupRoot);
      const originalRenameSync = fs.renameSync;
      let swapped = false;
      fs.renameSync = function syntheticSwap(source, destination) {
        if (!swapped && path.dirname(source) === realBackupRoot && path.basename(source) === 'swap-target') {
          swapped = true;
          originalRenameSync.call(fs, source, hiddenOriginal);
          createSyntheticPackage(backupRoot, 'swap-target');
        }
        return originalRenameSync.call(fs, source, destination);
      };
      try {
        assert.throws(() => purge(backupRoot), expectCode('BACKUP_CHANGED'));
      } finally {
        fs.renameSync = originalRenameSync;
      }
      assert.equal(fs.existsSync(hiddenOriginal), true, 'the original package must not be reported purged');
    });

    withScenario(root, 'raw-error-redaction', (backupRoot) => {
      createSyntheticPackage(backupRoot, 'raw-error-redaction');
      const realRoot = fs.realpathSync(backupRoot);
      const originalReaddirSync = fs.readdirSync;
      fs.readdirSync = function syntheticReadFailure(target, options) {
        if (target === realRoot) {
          const error = new Error(`synthetic EACCES at ${realRoot}`);
          error.code = 'EACCES';
          throw error;
        }
        return originalReaddirSync.call(fs, target, options);
      };
      try {
        assert.throws(
          () => purge(backupRoot),
          (error) => error && error.code === 'PURGE_FAILED'
            && error.message === 'Assessment backup purge failed and must be retried.'
            && !error.message.includes(realRoot) && error.cause === undefined,
        );
      } finally {
        fs.readdirSync = originalReaddirSync;
      }
    });

    withScenario(root, 'retry', (backupRoot) => {
      const item = createSyntheticPackage(backupRoot, 'retry-after-failure');
      const originalRmSync = fs.rmSync;
      fs.rmSync = function syntheticFailure(target, options) {
        if (path.dirname(target) === fs.realpathSync(backupRoot)
            && path.basename(target).startsWith('.assessment-purge-')) {
          const error = new Error('synthetic removal failure');
          error.code = 'EACCES';
          throw error;
        }
        return originalRmSync.call(fs, target, options);
      };
      try {
        assert.throws(
          () => purge(backupRoot),
          (error) => error && error.code === 'PURGE_FAILED'
            && error.message === 'Assessment backup purge failed and must be retried.'
            && error.cause === undefined && error.recovery_id === undefined
            && !error.message.includes(root) && !error.message.includes(item.packageRoot),
        );
      } finally {
        fs.rmSync = originalRmSync;
      }
      assert.equal(fs.existsSync(item.packageRoot), false);
      assert.equal(fs.readdirSync(backupRoot).filter((name) => name.startsWith('.assessment-purge-')).length, 1);
      assert.deepEqual(
        purge(backupRoot),
        { purged_count: 1, purged_recovery_ids: ['retry-after-failure'] },
      );
      assert.equal(fs.existsSync(item.packageRoot), false);
      assert.deepEqual(fs.readdirSync(backupRoot), []);
    });

    console.log(JSON.stringify({
      gate: 'F019-GATE-001-B2',
      synthetic_only: true,
      policy_required: true,
      exact_expiry_purge: true,
      unsafe_package_fail_closed: true,
      purge_failure_visible_and_retryable: true,
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run();
