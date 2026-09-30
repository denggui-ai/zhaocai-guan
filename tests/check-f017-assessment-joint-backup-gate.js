'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { prepareDatabaseMigrationBackup } = require("../src/db");

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('synthetic-old-schema-preview', 'ascii'),
]);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f017-joint-backup-gate-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

async function run() {
  const dataRoot = privateDirectory(path.join(root, 'synthetic-data'));
  const file = path.join(dataRoot, 'synthetic.db');
  const pdf = Buffer.from('%PDF-1.4\nsynthetic-old-schema-only\n%%EOF\n');
  const hash = crypto.createHash('sha256').update(pdf).digest('hex');
  const storageRelpath = `accepted/sha256/${hash.slice(0, 2)}/${hash}.pdf`;
  const now = '2026-07-12T12:00:00.000Z';

  const database = new Database(file);
  database.exec(`
    CREATE TABLE assessment_document (
      id TEXT PRIMARY KEY, content_sha256 TEXT, storage_relpath TEXT,
      byte_size INTEGER, page_count INTEGER, lifecycle_state TEXT,
      legal_hold_state TEXT, version INTEGER
    );
  `);
  database.prepare(`
    INSERT INTO assessment_document (
      id, content_sha256, storage_relpath, byte_size, page_count,
      lifecycle_state, legal_hold_state, version
    ) VALUES (?, ?, ?, ?, 1, 'active', 'none', 1)
  `).run('DOC-SYNTHETIC-OLD-SCHEMA', hash, storageRelpath, pdf.length);
  database.close();

  const assessmentRoot = privateDirectory(path.join(dataRoot, 'assessment'));
  const blobPath = path.join(assessmentRoot, storageRelpath);
  privateDirectory(path.dirname(blobPath));
  fs.writeFileSync(blobPath, pdf, { mode: 0o600 });
  const previewPath = path.join(
    assessmentRoot, 'previews', 'sha256', hash.slice(0, 2), hash, 'page-1.png',
  );
  privateDirectory(path.dirname(previewPath));
  fs.writeFileSync(previewPath, PNG, { mode: 0o600 });

  const assessmentRecoveryRoot = path.join(root, 'assessment-recovery');
  const result = await prepareDatabaseMigrationBackup(file, {
    assessmentEnabled: true,
    assessmentDataRoot: dataRoot,
    assessmentRecoveryRoot,
    assessmentBackupPolicyVersion: 'assessment-backup-synthetic-v1',
    assessmentBackupRetentionDays: 30,
    recoveryId: 'synthetic-old-schema-joint-gate',
    createdAt: now,
  });

  assert.equal(result.backup_required, true);
  assert.equal(result.backup_kind, 'assessment_db_store');
  assert.equal(result.recovery_id, 'synthetic-old-schema-joint-gate');
  assert.equal(result.manifest.policy_version, 'assessment-backup-synthetic-v1');
  assert.equal(result.manifest.backup_retention_days, 30);
  assert.equal(result.manifest.documents.length, 1);
  assert.equal(result.manifest.documents[0].dispute_state, 'none');
  assert.ok(fs.existsSync(path.join(assessmentRecoveryRoot, result.recovery_id, 'database.db')));
  assert.ok(fs.existsSync(path.join(assessmentRecoveryRoot, result.recovery_id, 'files', storageRelpath)));
  console.log('check-f017-assessment-joint-backup-gate ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
