
const { PROJECT_ROOT } = require("../src/paths");
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const { openDb } = require("../src/db");
const {
  ASSESSMENT_TABLES,
  applyAssessmentSchemaMigration,
} = require("../src/assessment-schema");

const FIXED_CHAIN_TABLES = Object.freeze([
  'candidate',
  'interview_session',
  'interview_pending_assignment',
  'interview_pending_assignment_classification_audit',
  'interview_report_v1',
  'interview_report_fact_review',
  'interview_report_action_request',
  'interview_report_source_snapshot',
  'interview_report_confirmed_projection',
  'interview_session_manual_note',
  'interview_session_manual_note_revision',
  'interview_llm_request_audit',
  'job_jd_version',
  'job_profile_version',
]);
const EXPECTED_OPEN_DB_SEQUENCE = Object.freeze([
  'F006',
  'F007',
  'F006',
  'F008',
  'F009',
  'F012',
]);

let tempRoot;
const openHandles = new Set();

function syntheticPath(file) {
  assert.ok(tempRoot, 'synthetic temp root must be initialized');
  const root = path.resolve(tempRoot);
  const target = path.resolve(file);
  assert.ok(target.startsWith(`${root}${path.sep}`), `test path escaped synthetic temp root: ${target}`);
  return target;
}

function hashSyntheticFile(file) {
  const target = syntheticPath(file);
  if (!fs.existsSync(target)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
}

function schemaFingerprint(database) {
  const schema = database.prepare(`
    SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
  return crypto.createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

function tableNames(database) {
  return database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name);
}

function assertTables(database, expected, present = true) {
  const actual = new Set(tableNames(database));
  for (const name of expected) {
    assert.equal(actual.has(name), present, `${name} presence mismatch`);
  }
}

function assertHealthy(database) {
  assert.deepEqual(database.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
  assert.deepEqual(database.pragma('foreign_key_check'), []);
}

function closeTracked(database) {
  if (!database) return;
  try {
    if (database.open) database.close();
  } finally {
    openHandles.delete(database);
  }
}

function track(database) {
  openHandles.add(database);
  return database;
}

function verifyOpenDbSequence() {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, "src/db.js"), 'utf8');
  const start = source.indexOf('function openDb(');
  const end = source.indexOf('function openReadonly(', start);
  assert.ok(start >= 0 && end > start, 'openDb source block must be discoverable');
  const sequence = [...source.slice(start, end).matchAll(/apply(F00[6-9]|F012)[A-Za-z]+Migration\(db\)/g)]
    .map((match) => match[1]);
  assert.deepEqual(sequence, EXPECTED_OPEN_DB_SEQUENCE);
  return sequence;
}

function createSyntheticLegacyDb(file) {
  const legacy = track(new Database(file));
  legacy.pragma('foreign_keys = ON');
  legacy.exec(`
    CREATE TABLE job (
      id INTEGER PRIMARY KEY,
      encrypt_job_id TEXT NOT NULL,
      numeric_job_id TEXT,
      name TEXT,
      hr_owner TEXT,
      created_at TEXT
    );

    INSERT INTO job (
      id, encrypt_job_id, numeric_job_id, name, hr_owner, created_at
    ) VALUES (
      1, 'synthetic-marker-job', 'synthetic-001',
      'Synthetic Migration Marker', 'synthetic-actor', '2026-07-12T00:00:00.000Z'
    );
  `);
  closeTracked(legacy);
}

function openReadonly(file) {
  return track(new Database(file, { readonly: true, fileMustExist: true }));
}

function restoreVerified(source, expectedHash, destination) {
  const sourcePath = syntheticPath(source);
  const destinationPath = syntheticPath(destination);
  const actualHash = hashSyntheticFile(sourcePath);
  if (!expectedHash || actualHash !== expectedHash) {
    const error = new Error('recovery hash mismatch');
    error.code = 'RECOVERY_HASH_MISMATCH';
    throw error;
  }
  fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
  return actualHash;
}

async function run() {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-assessment-recovery-'));
  const workingPath = path.join(tempRoot, 'synthetic-working.db');
  const recoveryPath = path.join(tempRoot, 'pre-assessment-recovery.db');
  const restoredPath = path.join(tempRoot, 'restored-generation.db');
  const truncatedPath = path.join(tempRoot, 'truncated-recovery.db');
  const rejectedRestorePath = path.join(tempRoot, 'must-not-exist.db');
  const failurePath = path.join(tempRoot, 'synthetic-failure.db');

  let working;
  let failureDb;
  try {
    const observedSequence = verifyOpenDbSequence();
    createSyntheticLegacyDb(workingPath);

    working = track(openDb(workingPath));
    assertHealthy(working);
    assertTables(working, FIXED_CHAIN_TABLES);
    assertTables(working, ASSESSMENT_TABLES, false);
    assert.equal(
      working.prepare('SELECT COUNT(*) AS n FROM job WHERE encrypt_job_id = ?').get('synthetic-marker-job').n,
      1,
    );
    assert.ok(
      working.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'interview_session_material_insert_guard'").get(),
      'second F006 pass must restore material guards after F007 rebuild',
    );
    const pendingColumns = new Set(
      working.prepare("PRAGMA table_info('interview_pending_assignment')").all().map((row) => row.name),
    );
    for (const column of ['source_key', 'payload_hash', 'interview_recording_id', 'version']) {
      assert.ok(pendingColumns.has(column), `F007 column missing: ${column}`);
    }

    await working.backup(recoveryPath);
    const recoveryHash = hashSyntheticFile(recoveryPath);
    assert.ok(recoveryHash);

    let recoveryCheck = openReadonly(recoveryPath);
    assertHealthy(recoveryCheck);
    assertTables(recoveryCheck, FIXED_CHAIN_TABLES);
    assertTables(recoveryCheck, ASSESSMENT_TABLES, false);
    const recoveryFingerprint = schemaFingerprint(recoveryCheck);
    closeTracked(recoveryCheck);

    applyAssessmentSchemaMigration(working);
    assertHealthy(working);
    assertTables(working, [...FIXED_CHAIN_TABLES, ...ASSESSMENT_TABLES]);
    const assessmentFingerprint = schemaFingerprint(working);
    applyAssessmentSchemaMigration(working);
    assert.equal(schemaFingerprint(working), assessmentFingerprint, 'assessment migration must be idempotent');

    working.exec('DROP TABLE assessment_event;');
    working.prepare(`
      INSERT INTO job (encrypt_job_id, numeric_job_id, name, hr_owner, is_fixture, source_type, created_at)
      VALUES (?, ?, ?, ?, 1, 'fixture', ?)
    `).run('synthetic-post-migration-write', 'synthetic-002', 'Synthetic Damage Marker', 'synthetic-actor', '2026-07-12T00:01:00.000Z');
    assertTables(working, ['assessment_event'], false);
    closeTracked(working);
    working = null;

    assert.equal(restoreVerified(recoveryPath, recoveryHash, restoredPath), recoveryHash);
    const restored = openReadonly(restoredPath);
    assertHealthy(restored);
    assert.equal(schemaFingerprint(restored), recoveryFingerprint);
    assertTables(restored, FIXED_CHAIN_TABLES);
    assertTables(restored, ASSESSMENT_TABLES, false);
    assert.equal(
      restored.prepare('SELECT COUNT(*) AS n FROM job WHERE encrypt_job_id = ?').get('synthetic-marker-job').n,
      1,
    );
    assert.equal(
      restored.prepare('SELECT COUNT(*) AS n FROM job WHERE encrypt_job_id = ?').get('synthetic-post-migration-write').n,
      0,
    );
    const restoredTableCount = tableNames(restored).length;
    closeTracked(restored);

    const recoveryBytes = fs.readFileSync(recoveryPath);
    fs.writeFileSync(truncatedPath, recoveryBytes.subarray(0, Math.max(1, Math.floor(recoveryBytes.length / 3))));
    assert.throws(
      () => restoreVerified(truncatedPath, recoveryHash, rejectedRestorePath),
      (error) => error && error.code === 'RECOVERY_HASH_MISMATCH',
    );
    assert.equal(fs.existsSync(rejectedRestorePath), false, 'bad recovery must be rejected before restore output exists');

    failureDb = track(openDb(failurePath));
    failureDb.exec('CREATE TABLE assessment_binding (conflict_marker TEXT);');
    assert.throws(() => applyAssessmentSchemaMigration(failureDb));
    assertTables(failureDb, ['assessment_document', 'assessment_event'], false);
    assertTables(failureDb, ['assessment_binding']);
    assert.equal(
      failureDb.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('assessment_binding') WHERE name = 'conflict_marker'").get().n,
      1,
    );
    assertHealthy(failureDb);
    closeTracked(failureDb);
    failureDb = null;

    return {
      status: 'ok',
      task: 'P0-IMPL-002-B',
      scope: 'synthetic-only',
      open_db_sequence: observedSequence,
      fixed_chain_table_count: FIXED_CHAIN_TABLES.length,
      assessment_table_count: ASSESSMENT_TABLES.length,
      restored_table_count: restoredTableCount,
      recovery_sha256: recoveryHash,
      assessment_schema_sha256: assessmentFingerprint,
      real_database_accessed: false,
      recovery_hash_rejection: 'ok',
      assessment_failure_atomicity: 'ok',
    };
  } finally {
    closeTracked(working);
    closeTracked(failureDb);
    for (const handle of [...openHandles]) closeTracked(handle);
  }
}

(async () => {
  let result;
  try {
    result = await run();
  } catch (error) {
    result = {
      status: 'failed',
      task: 'P0-IMPL-002-B',
      error_code: error && error.code ? String(error.code) : 'ASSERTION_FAILED',
      real_database_accessed: false,
    };
    process.exitCode = 1;
  } finally {
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    result = { ...result, temporary_files_cleaned: !tempRoot || !fs.existsSync(tempRoot) };
    console.log(JSON.stringify(result));
  }
})();
