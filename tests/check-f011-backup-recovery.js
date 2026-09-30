
const { PROJECT_ROOT } = require("../src/paths");
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const {
  createSqliteBackup,
  restoreSqliteBackup,
  purgeExpiredRecoveryPackages,
  schemaFingerprint,
} = require("../src/sqlite-backup-recovery");

function expectCode(code) {
  return (error) => error && error.code === code;
}

function privateDir(root, name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

function dotRestoreFiles(root) {
  return fs.readdirSync(root).filter((name) => name.startsWith('.restore-'));
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f011-'));
  fs.chmodSync(root, 0o700);
  const sourcePath = path.join(root, 'synthetic-source.db');
  const recoveryRoot = privateDir(root, 'recovery');
  const restoreRoot = privateDir(root, 'restore');
  const database = new Database(sourcePath);

  try {
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.pragma('user_version = 17');
    database.exec(`
      CREATE TABLE synthetic_item (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        marker TEXT NOT NULL
      );
      CREATE TABLE synthetic_tombstone (
        object_id TEXT PRIMARY KEY,
        deleted_at TEXT NOT NULL
      );
      INSERT INTO synthetic_item VALUES ('keep-1', 'active', 'pre-backup');
    `);
    database.pragma('wal_checkpoint(TRUNCATE)');
    database.prepare('INSERT INTO synthetic_item VALUES (?, ?, ?)').run('delete-1', 'active', 'wal-only');
    assert.ok(fs.existsSync(`${sourcePath}-wal`), 'WAL file should exist during backup');
    const sourceFingerprint = schemaFingerprint(database);

    const backup = await createSqliteBackup({
      database,
      recoveryRoot,
      recoveryId: 'recovery-good',
      appVersion: '1.0.0',
      policyVersion: 'retention-2026-07-12',
      createdAt: '2026-07-12T00:00:00.000Z',
    });
    assert.equal(backup.manifest.database.schema_fingerprint, sourceFingerprint);
    assert.equal(backup.manifest.database.user_version, 17);
    assert.match(backup.manifest.database.sha256, /^[0-9a-f]{64}$/);
    assert.match(backup.manifest.manifest_sha256, /^[0-9a-f]{64}$/);
    assert.equal(backup.manifest.backup_retention_days, 30);
    const packagePath = path.join(recoveryRoot, 'recovery-good');
    if (process.platform === 'win32') {
      console.log('SKIP POSIX mode-bit assertions on Windows (private ACLs are validated separately)');
    } else {
      assert.equal(fs.statSync(packagePath).mode & 0o077, 0);
      assert.equal(fs.statSync(path.join(packagePath, 'database.db')).mode & 0o077, 0);
      assert.equal(fs.statSync(path.join(packagePath, 'manifest.json')).mode & 0o077, 0);
    }
    const serviceSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/sqlite-backup-recovery.js"), 'utf8');
    for (const secureFsCall of ['hardenPrivateDir', 'ensurePrivateFile', 'writePrivateFile']) {
      assert.ok(serviceSource.includes(secureFsCall), `secure-fs contract missing: ${secureFsCall}`);
    }

    await assert.rejects(
      createSqliteBackup({
        database,
        recoveryRoot,
        recoveryId: 'invalid-created-at',
        appVersion: '1.0.0',
        policyVersion: 'retention-2026-07-12',
        createdAt: 'candidate free text',
      }),
      expectCode('INVALID_ARGUMENT'),
    );
    assert.equal(fs.existsSync(path.join(recoveryRoot, 'invalid-created-at')), false);

    database.exec('DROP TABLE synthetic_item; CREATE TABLE damaged_only (id INTEGER);');

    await assert.rejects(
      restoreSqliteBackup({
        recoveryRoot,
        recoveryId: 'recovery-good',
        restoreRoot,
        destinationName: 'unconfirmed.db',
        appVersion: '1.0.0',
        policyVersion: 'retention-2026-07-12',
        now: '2026-07-13T00:00:00.000Z',
        confirmed: false,
        criticalQueries: [{ sql: 'SELECT 1' }],
      }),
      expectCode('RESTORE_NOT_CONFIRMED'),
    );
    assert.equal(fs.existsSync(path.join(restoreRoot, 'unconfirmed.db')), false);

    await assert.rejects(
      restoreSqliteBackup({
        recoveryRoot,
        recoveryId: 'recovery-good',
        restoreRoot,
        destinationName: 'wrong-version.db',
        appVersion: '2.0.0',
        policyVersion: 'retention-2026-07-12',
        now: '2026-07-13T00:00:00.000Z',
        confirmed: true,
        criticalQueries: [{ sql: 'SELECT 1' }],
      }),
      expectCode('INCOMPATIBLE_VERSION'),
    );
    assert.equal(fs.existsSync(path.join(restoreRoot, 'wrong-version.db')), false);

    await assert.rejects(
      restoreSqliteBackup({
        recoveryRoot,
        recoveryId: 'recovery-good',
        restoreRoot,
        destinationName: 'multi-statement.db',
        appVersion: '1.0.0',
        policyVersion: 'retention-2026-07-12',
        now: '2026-07-13T00:00:00.000Z',
        confirmed: true,
        criticalQueries: [{ sql: 'SELECT 1; SELECT 2' }],
      }),
      expectCode('INVALID_ARGUMENT'),
    );
    assert.equal(fs.existsSync(path.join(restoreRoot, 'multi-statement.db')), false);

    await assert.rejects(
      restoreSqliteBackup({
        recoveryRoot,
        recoveryId: 'recovery-good',
        restoreRoot,
        destinationName: 'invalid-now.db',
        appVersion: '1.0.0',
        policyVersion: 'retention-2026-07-12',
        now: 'not-a-time',
        confirmed: true,
        criticalQueries: [{ sql: 'SELECT 1' }],
      }),
      expectCode('INVALID_ARGUMENT'),
    );
    assert.equal(fs.existsSync(path.join(restoreRoot, 'invalid-now.db')), false);

    await restoreSqliteBackup({
      recoveryRoot,
      recoveryId: 'recovery-good',
      restoreRoot,
      destinationName: 'pre-expiry.db',
      appVersion: '1.0.0',
      policyVersion: 'retention-2026-07-12',
      now: '2026-08-10T23:59:59.999Z',
      confirmed: true,
      criticalQueries: [{ sql: 'SELECT id FROM synthetic_item WHERE id = ?', params: ['keep-1'] }],
    });
    assert.ok(fs.existsSync(path.join(restoreRoot, 'pre-expiry.db')));

    await assert.rejects(
      restoreSqliteBackup({
        recoveryRoot,
        recoveryId: 'recovery-good',
        restoreRoot,
        destinationName: 'expired.db',
        appVersion: '1.0.0',
        policyVersion: 'retention-2026-07-12',
        now: '2026-08-11T00:00:00.000Z',
        confirmed: true,
        criticalQueries: [{ sql: 'SELECT 1' }],
      }),
      expectCode('BACKUP_EXPIRED'),
    );
    assert.equal(fs.existsSync(path.join(restoreRoot, 'expired.db')), false);
    assert.deepEqual(dotRestoreFiles(restoreRoot), []);

    await assert.rejects(
      restoreSqliteBackup({
        recoveryRoot,
        recoveryId: 'recovery-good',
        restoreRoot,
        destinationName: 'missing-tombstone-callback.db',
        appVersion: '1.0.0',
        policyVersion: 'retention-2026-07-12',
        now: '2026-07-13T00:00:00.000Z',
        confirmed: true,
        currentTombstones: [{ table: 'synthetic_item', idColumn: 'id', objectId: 'delete-1' }],
        allowedTombstoneTargets: [{ table: 'synthetic_item', idColumn: 'id' }],
        criticalQueries: [{ sql: 'SELECT 1' }],
      }),
      expectCode('TOMBSTONE_REPLAY_REQUIRED'),
    );
    assert.equal(fs.existsSync(path.join(restoreRoot, 'missing-tombstone-callback.db')), false);

    await assert.rejects(
      restoreSqliteBackup({
        recoveryRoot,
        recoveryId: 'recovery-good',
        restoreRoot,
        destinationName: 'failed-tombstone-callback.db',
        appVersion: '1.0.0',
        policyVersion: 'retention-2026-07-12',
        now: '2026-07-13T00:00:00.000Z',
        confirmed: true,
        currentTombstones: [{ table: 'synthetic_item', idColumn: 'id', objectId: 'delete-1' }],
        allowedTombstoneTargets: [{ table: 'synthetic_item', idColumn: 'id' }],
        replayCurrentTombstones() { throw new Error('synthetic callback failure'); },
        criticalQueries: [{ sql: 'SELECT 1' }],
      }),
      /synthetic callback failure/,
    );
    assert.equal(fs.existsSync(path.join(restoreRoot, 'failed-tombstone-callback.db')), false);
    assert.deepEqual(dotRestoreFiles(restoreRoot), []);

    const result = await restoreSqliteBackup({
      recoveryRoot,
      recoveryId: 'recovery-good',
      restoreRoot,
      destinationName: 'restored.db',
      appVersion: '1.0.0',
      policyVersion: 'retention-2026-07-12',
      now: '2026-07-13T00:00:00.000Z',
      confirmed: true,
      currentTombstones: [{ table: 'synthetic_item', idColumn: 'id', objectId: 'delete-1' }],
      allowedTombstoneTargets: [{ table: 'synthetic_item', idColumn: 'id' }],
      replayCurrentTombstones(restoringDatabase, tombstones) {
        const insert = restoringDatabase.prepare(`
          INSERT INTO synthetic_tombstone (object_id, deleted_at) VALUES (?, ?)
        `);
        for (const tombstone of tombstones) insert.run(tombstone.objectId, '2026-07-13T00:00:00.000Z');
      },
      criticalQueries: [
        { sql: 'SELECT id FROM synthetic_item WHERE id = ?', params: ['keep-1'] },
        { sql: 'SELECT object_id FROM synthetic_tombstone WHERE object_id = ?', params: ['delete-1'] },
        { sql: 'SELECT COUNT(*) AS n FROM synthetic_item' },
      ],
    });
    assert.equal(result.tombstones_replayed, 1);
    const restored = new Database(path.join(restoreRoot, 'restored.db'), { readonly: true });
    try {
      assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
      assert.deepEqual(restored.pragma('foreign_key_check'), []);
      assert.equal(restored.prepare('SELECT marker FROM synthetic_item WHERE id = ?').get('keep-1').marker, 'pre-backup');
      assert.equal(restored.prepare('SELECT 1 FROM synthetic_item WHERE id = ?').get('delete-1'), undefined);
      assert.equal(
        restored.prepare('SELECT deleted_at FROM synthetic_tombstone WHERE object_id = ?').get('delete-1').deleted_at,
        '2026-07-13T00:00:00.000Z',
      );
      assert.equal(restored.prepare("SELECT 1 FROM sqlite_master WHERE name = 'damaged_only'").get(), undefined);
    } finally {
      restored.close();
    }

    await createSqliteBackup({
      database,
      recoveryRoot,
      recoveryId: 'recovery-corrupt',
      appVersion: '1.0.0',
      policyVersion: 'retention-2026-07-12',
    });
    const corruptDb = path.join(recoveryRoot, 'recovery-corrupt', 'database.db');
    const bytes = fs.readFileSync(corruptDb);
    fs.writeFileSync(corruptDb, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
    await assert.rejects(
      restoreSqliteBackup({
        recoveryRoot,
        recoveryId: 'recovery-corrupt',
        restoreRoot,
        destinationName: 'corrupt.db',
        appVersion: '1.0.0',
        policyVersion: 'retention-2026-07-12',
        now: new Date().toISOString(),
        confirmed: true,
        criticalQueries: [{ sql: 'SELECT 1' }],
      }),
      expectCode('DATABASE_HASH_MISMATCH'),
    );
    assert.equal(fs.existsSync(path.join(restoreRoot, 'corrupt.db')), false);
    assert.deepEqual(dotRestoreFiles(restoreRoot), []);

    for (const [id, mutate] of [
      ['unknown-top-field', (manifest) => { manifest.unexpected = true; }],
      ['unknown-database-field', (manifest) => { manifest.database.unexpected = true; }],
    ]) {
      await createSqliteBackup({
        database,
        recoveryRoot,
        recoveryId: id,
        appVersion: '1.0.0',
        policyVersion: 'retention-2026-07-12',
      });
      const manifestPath = path.join(recoveryRoot, id, 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      mutate(manifest);
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await assert.rejects(
        restoreSqliteBackup({
          recoveryRoot,
          recoveryId: id,
          restoreRoot,
          destinationName: `${id}.db`,
          appVersion: '1.0.0',
          policyVersion: 'retention-2026-07-12',
          now: new Date().toISOString(),
          confirmed: true,
          criticalQueries: [{ sql: 'SELECT 1' }],
        }),
        expectCode('INVALID_MANIFEST'),
      );
      assert.equal(fs.existsSync(path.join(restoreRoot, `${id}.db`)), false);
    }

    await createSqliteBackup({
      database,
      recoveryRoot,
      recoveryId: 'recovery-query-failure',
      appVersion: '1.0.0',
      policyVersion: 'retention-2026-07-12',
    });
    await assert.rejects(
      restoreSqliteBackup({
        recoveryRoot,
        recoveryId: 'recovery-query-failure',
        restoreRoot,
        destinationName: 'query-failure.db',
        appVersion: '1.0.0',
        policyVersion: 'retention-2026-07-12',
        now: new Date().toISOString(),
        confirmed: true,
        criticalQueries: [{ sql: 'SELECT * FROM missing_critical_table' }],
      }),
    );
    assert.equal(fs.existsSync(path.join(restoreRoot, 'query-failure.db')), false);
    assert.deepEqual(dotRestoreFiles(restoreRoot), []);

    const insecureRoot = privateDir(root, 'insecure');
    fs.chmodSync(insecureRoot, 0o755);
    await createSqliteBackup({
      database,
      recoveryRoot: insecureRoot,
      recoveryId: 'hardened-backup',
      appVersion: '1.0.0',
      policyVersion: 'retention-2026-07-12',
    });
    if (process.platform !== 'win32') assert.equal(fs.statSync(insecureRoot).mode & 0o077, 0);
    assert.ok(fs.existsSync(path.join(insecureRoot, 'hardened-backup')));

    const purgeRoot = privateDir(root, 'purge-recovery');
    await createSqliteBackup({
      database,
      recoveryRoot: purgeRoot,
      recoveryId: 'purge-boundary',
      appVersion: '1.0.0',
      policyVersion: 'retention-2026-07-12',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(purgeExpiredRecoveryPackages({
      recoveryRoot: purgeRoot,
      now: '2026-01-30T23:59:59.999Z',
    }).purged_count, 0);
    assert.equal(purgeExpiredRecoveryPackages({
      recoveryRoot: purgeRoot,
      now: '2026-01-31T00:00:00.000Z',
    }).purged_count, 1);
    const outside = privateDir(root, 'purge-outside');
    if (process.platform !== 'win32') {
      fs.symlinkSync(outside, path.join(purgeRoot, 'symlink-package'));
      assert.throws(() => purgeExpiredRecoveryPackages({
        recoveryRoot: purgeRoot,
        now: '2026-02-01T00:00:00.000Z',
      }), expectCode('INVALID_PACKAGE'));
      assert.ok(fs.existsSync(outside), 'purge must never follow a recovery package symlink');
    }

    console.log(JSON.stringify({
      check: 'f011_backup_recovery',
      status: 'passed',
      wal_backup: true,
      tombstone_replay: true,
      destructive_restore: true,
      failure_cleanup: true,
      strict_manifest: true,
      secure_fs_contract: true,
      backup_expiry_boundary: true,
      persistent_tombstone_replay: true,
      expired_package_purge: true,
    }));
  } finally {
    if (database.open) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
