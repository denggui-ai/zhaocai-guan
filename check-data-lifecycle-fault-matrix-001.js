'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const {
  createSqliteBackup,
  restoreSqliteBackup,
} = require('./sqlite-backup-recovery');

const APP_VERSION = '1.0.0';
const POLICY_VERSION = 'synthetic-b13-retention-v1';
const CREATED_AT = '2026-07-29T00:00:00.000Z';
const RESTORE_AT = '2026-07-30T00:00:00.000Z';

function privateDirectory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.chmodSync(target, 0o700);
  return target;
}

function errorCode(code) {
  return (error) => error && error.code === code;
}

function stagingEntries(root) {
  return fs.existsSync(root)
    ? fs.readdirSync(root).filter((name) => name.startsWith('.backup-') || name.startsWith('.restore-'))
    : [];
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-b13-lifecycle-faults-'));
  fs.chmodSync(root, 0o700);
  const sourceRoot = privateDirectory(path.join(root, 'source'));
  const recoveryRoot = privateDirectory(path.join(root, 'recovery'));
  const restoreRoot = path.join(root, 'restore-disappears-before-use');
  const sourcePath = path.join(sourceRoot, 'synthetic.db');
  const database = new Database(sourcePath);

  try {
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.pragma('user_version = 13');
    database.exec(`
      CREATE TABLE synthetic_candidate (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      INSERT INTO synthetic_candidate VALUES ('B13-CANDIDATE-001', 'B-13 合成候选人');
    `);
    database.pragma('wal_checkpoint(TRUNCATE)');
    database.prepare('INSERT INTO synthetic_candidate VALUES (?, ?)')
      .run('B13-CANDIDATE-WAL', 'B-13 WAL 合成候选人');
    assert.equal(fs.existsSync(`${sourcePath}-wal`), true);

    const originalStatfsSync = fs.statfsSync;
    fs.statfsSync = () => ({ bavail: 0, bsize: 4096 });
    try {
      await assert.rejects(
        createSqliteBackup({
          database,
          recoveryRoot,
          recoveryId: 'disk-full',
          appVersion: APP_VERSION,
          policyVersion: POLICY_VERSION,
          createdAt: CREATED_AT,
        }),
        errorCode('INSUFFICIENT_SPACE'),
      );
    } finally {
      fs.statfsSync = originalStatfsSync;
    }
    assert.equal(fs.existsSync(path.join(recoveryRoot, 'disk-full')), false);
    assert.deepEqual(stagingEntries(recoveryRoot), []);

    await createSqliteBackup({
      database,
      recoveryRoot,
      recoveryId: 'good',
      appVersion: APP_VERSION,
      policyVersion: POLICY_VERSION,
      createdAt: CREATED_AT,
    });
    await createSqliteBackup({
      database,
      recoveryRoot,
      recoveryId: 'corrupt',
      appVersion: APP_VERSION,
      policyVersion: POLICY_VERSION,
      createdAt: CREATED_AT,
    });
    database.close();

    fs.rmSync(sourceRoot, { recursive: true });
    assert.equal(fs.existsSync(sourceRoot), false);
    assert.equal(fs.existsSync(restoreRoot), false);

    const restored = await restoreSqliteBackup({
      recoveryRoot,
      recoveryId: 'good',
      restoreRoot,
      destinationName: 'restored.db',
      appVersion: APP_VERSION,
      policyVersion: POLICY_VERSION,
      now: RESTORE_AT,
      confirmed: true,
      criticalQueries: [
        { sql: 'SELECT id FROM synthetic_candidate WHERE id = ?', params: ['B13-CANDIDATE-001'] },
        { sql: 'SELECT id FROM synthetic_candidate WHERE id = ?', params: ['B13-CANDIDATE-WAL'] },
      ],
    });
    assert.equal(restored.destination_name, 'restored.db');
    assert.equal(fs.existsSync(restoreRoot), true);
    const restoredDatabase = new Database(path.join(restoreRoot, 'restored.db'), {
      readonly: true,
      fileMustExist: true,
    });
    try {
      assert.equal(restoredDatabase.pragma('integrity_check', { simple: true }), 'ok');
      assert.deepEqual(
        restoredDatabase.prepare('SELECT id FROM synthetic_candidate ORDER BY id').all(),
        [{ id: 'B13-CANDIDATE-001' }, { id: 'B13-CANDIDATE-WAL' }],
      );
    } finally {
      restoredDatabase.close();
    }

    const corruptPath = path.join(recoveryRoot, 'corrupt', 'database.db');
    const corruptBytes = fs.readFileSync(corruptPath);
    corruptBytes[corruptBytes.length - 1] ^= 0xff;
    fs.writeFileSync(corruptPath, corruptBytes, { mode: 0o600 });
    await assert.rejects(
      restoreSqliteBackup({
        recoveryRoot,
        recoveryId: 'corrupt',
        restoreRoot,
        destinationName: 'must-not-publish.db',
        appVersion: APP_VERSION,
        policyVersion: POLICY_VERSION,
        now: RESTORE_AT,
        confirmed: true,
        criticalQueries: [{ sql: 'SELECT 1' }],
      }),
      errorCode('DATABASE_HASH_MISMATCH'),
    );
    assert.equal(fs.existsSync(path.join(restoreRoot, 'must-not-publish.db')), false);
    assert.deepEqual(stagingEntries(restoreRoot), []);

    await assert.rejects(
      restoreSqliteBackup({
        recoveryRoot: path.join(root, 'missing-recovery-root'),
        recoveryId: 'good',
        restoreRoot,
        destinationName: 'missing-root-must-not-publish.db',
        appVersion: APP_VERSION,
        policyVersion: POLICY_VERSION,
        now: RESTORE_AT,
        confirmed: true,
        criticalQueries: [{ sql: 'SELECT 1' }],
      }),
      errorCode('INVALID_ROOT'),
    );
    assert.equal(fs.existsSync(path.join(restoreRoot, 'missing-root-must-not-publish.db')), false);

    console.log(JSON.stringify({
      ok: true,
      contract: 'B13-DATA-LIFECYCLE-FAULT-MATRIX-001',
      synthetic_only: true,
      real_sqlite_wal_backup: true,
      disk_full: {
        code: 'INSUFFICIENT_SPACE',
        package_published: false,
        staging_leaks: 0,
      },
      directory_disappearance: {
        source_removed_after_backup: true,
        missing_restore_root_recreated: true,
        missing_recovery_root_code: 'INVALID_ROOT',
      },
      real_backup_byte_corruption: {
        code: 'DATABASE_HASH_MISMATCH',
        destination_published: false,
        staging_leaks: 0,
      },
      restored_candidate_rows: 2,
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
