'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = PROJECT_ROOT;
const electronPath = require('electron');
const CHECKS = Object.freeze([
  {
    file: "tests/check-data-lifecycle-fault-matrix-001.js",
    covers: ['disk_full', 'directory_disappearance', 'real_database_corruption', 'wal_restore'],
  },
  {
    file: "tests/check-f011-backup-recovery.js",
    covers: ['sqlite_backup', 'tombstone_replay', 'expiry', 'corrupt_database_rejection'],
  },
  {
    file: "tests/check-f010-lifecycle.js",
    covers: ['interview_material_retention', 'legal_hold', 'physical_delete'],
  },
  {
    file: "tests/check-f010-f011-integration.js",
    covers: ['restore_anti_resurrection', 'persistent_tombstone'],
  },
  {
    file: "tests/check-assessment-store-backup.js",
    covers: ['assessment_pdf_png_backup', 'store_restore', 'artifact_corruption', 'delete_write_lock'],
  },
  {
    file: "tests/check-assessment-backup-retention.js",
    covers: ['assessment_backup_expiry', 'purge_fail_closed', 'purge_retry'],
  },
  {
    file: "tests/check-assessment-physical-delete.js",
    covers: ['two_phase_physical_delete', 'partial_failure', 'safe_retry', 'legal_hold_gate'],
  },
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function privateDirectory(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  fs.chmodSync(target, 0o700);
  return target;
}

function runCheck(check) {
  const result = spawnSync(electronPath, [path.join(ROOT, check.file)], {
    cwd: ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HRBOSS_EXTERNAL_AI_ENABLED: '0',
      BOSS_ACTION_AUTOMATION_ENABLED: '0',
    },
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.error, undefined, `${check.file} failed to start`);
  assert.equal(result.signal, null, `${check.file} terminated by ${result.signal}`);
  assert.equal(result.status, 0, `${check.file} exited ${result.status}`);
  return {
    check: check.file,
    exit_code: result.status,
    covers: check.covers,
    stdout_sha256: sha256(result.stdout || ''),
    stderr_sha256: sha256(result.stderr || ''),
  };
}

function run() {
  const startedAt = new Date().toISOString();
  const checks = CHECKS.map(runCheck);
  const evidence = {
    ok: true,
    evidence_level: 'E4',
    scope: 'storage-service and real temporary filesystem/database runtime',
    ui_exercised: false,
    synthetic_data_only: true,
    real_candidate_files_read: false,
    external_services_accessed: false,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    checks,
    acceptance: {
      backup_and_restore: true,
      retention_expiry_and_purge: true,
      tombstone_anti_resurrection: true,
      legal_hold_blocks_delete: true,
      two_phase_physical_delete_and_retry: true,
      disk_full_fails_before_publish: true,
      missing_directory_is_safe: true,
      corrupted_real_files_fail_closed: true,
    },
  };
  const evidenceDirectory = process.env.HRBOSS_B13_EVIDENCE_DIR;
  if (evidenceDirectory) {
    const directory = privateDirectory(path.resolve(evidenceDirectory));
    const evidencePath = path.join(directory, 'B-13-data-lifecycle-runtime-evidence.json');
    fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: 'w',
      mode: 0o600,
    });
    fs.chmodSync(evidencePath, 0o600);
  }
  console.log(JSON.stringify({
    ok: evidence.ok,
    evidence_level: evidence.evidence_level,
    check_count: evidence.checks.length,
    acceptance: evidence.acceptance,
  }, null, 2));
}

try {
  run();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
