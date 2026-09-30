'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const {
  POLICY_VERSION,
  applyInterviewMaterialLifecycleSchema,
  confirmDeletion,
  createDeletionDryRun,
  createLifecycleSession,
  replayLifecycleTombstones,
  registerLifecycleMaterial,
  registerLifecycleDatabaseMaterial,
} = require("../src/interview-material-lifecycle");
const { createSqliteBackup, restoreSqliteBackup } = require("../src/sqlite-backup-recovery");

function privateDir(parent, name) {
  const target = path.join(parent, name);
  fs.mkdirSync(target, { mode: 0o700 });
  fs.chmodSync(target, 0o700);
  return target;
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f010-f011-'));
  fs.chmodSync(root, 0o700);
  const materialRoot = privateDir(root, 'materials');
  const recoveryRoot = privateDir(root, 'recovery');
  const restoreRoot = privateDir(root, 'restore');
  const sourcePath = path.join(root, 'source.db');
  const materialDir = privateDir(materialRoot, 'session');
  const materialFile = path.join(materialDir, 'synthetic-video.bin');
  fs.writeFileSync(materialFile, 'synthetic-only', { mode: 0o600 });
  const database = new Database(sourcePath);

  try {
    database.pragma('foreign_keys = ON');
    database.pragma('journal_mode = WAL');
    database.exec(`
      CREATE TABLE job_interview (id INTEGER PRIMARY KEY, transcript TEXT NOT NULL, source_url TEXT, note TEXT);
      CREATE TABLE interview_report_v1 (id INTEGER PRIMARY KEY, report_json TEXT NOT NULL);
      CREATE TABLE interview_report_action_request (id INTEGER PRIMARY KEY, report_id INTEGER);
      CREATE TABLE interview_report_fact_review (id INTEGER PRIMARY KEY, report_id INTEGER, corrected_value TEXT);
      CREATE TABLE interview_llm_request_audit (id INTEGER PRIMARY KEY, report_id INTEGER, request_hash TEXT);
      CREATE TABLE interview_recording (id INTEGER PRIMARY KEY, topic TEXT, raw_summary_json TEXT);
      CREATE TABLE interview_ai_report (id INTEGER PRIMARY KEY, recording_id INTEGER, report_json TEXT);
      CREATE TABLE interview_session_report (id INTEGER PRIMARY KEY, report_id INTEGER);
      CREATE TABLE interview_recording_confirmation (
        id INTEGER PRIMARY KEY, recording_id INTEGER, extracted_value TEXT,
        corrected_value TEXT, evidence TEXT, note TEXT
      );
      INSERT INTO job_interview VALUES (11, 'online-sensitive', 'https://sensitive.invalid', 'sensitive-note');
      INSERT INTO interview_report_v1 VALUES (12, '{"sensitive":"v1"}');
      INSERT INTO interview_report_action_request VALUES (1, 12);
      INSERT INTO interview_report_fact_review VALUES (1, 12, 'corrected-sensitive');
      INSERT INTO interview_llm_request_audit VALUES (1, 12, 'retained-hash');
      INSERT INTO interview_recording VALUES (14, 'legacy-topic', '{"sensitive":"metadata"}');
      INSERT INTO interview_ai_report VALUES (13, 14, '{"sensitive":"legacy"}');
      INSERT INTO interview_session_report VALUES (1, 13);
      INSERT INTO interview_recording_confirmation VALUES (1, 14, 'extract', 'correct', 'evidence', 'note');
    `);
    applyInterviewMaterialLifecycleSchema(database);
    createLifecycleSession({
      database,
      sessionId: 'session-integration',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    registerLifecycleMaterial({
      database,
      root: materialRoot,
      sessionId: 'session-integration',
      materialId: 'material-integration',
      artifactClass: 'raw_video',
      filePath: materialFile,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    for (const item of [
      ['db-online-11', 'transcript', 'job_interview', '11'],
      ['db-v1-12', 'draft', 'interview_report_v1', '12'],
      ['db-legacy-13', 'draft', 'interview_ai_report', '13'],
      ['db-confirmations-14', 'draft', 'interview_recording_confirmations', '14'],
      ['db-metadata-14', 'draft', 'interview_recording_metadata', '14'],
    ]) {
      registerLifecycleDatabaseMaterial({
        database,
        sessionId: 'session-integration',
        materialId: item[0],
        artifactClass: item[1],
        entityType: item[2],
        entityId: item[3],
        createdAt: '2025-01-01T00:00:00.000Z',
      });
    }

    await createSqliteBackup({
      database,
      recoveryRoot,
      recoveryId: 'pre-delete',
      appVersion: '1.0.0',
      policyVersion: POLICY_VERSION,
      createdAt: '2026-01-15T00:00:00.000Z',
    });

    const manifest = createDeletionDryRun({
      database,
      sessionId: 'session-integration',
      now: '2026-02-01T00:00:00.000Z',
    });
    confirmDeletion({
      database,
      root: materialRoot,
      manifestId: manifest.manifest_id,
      confirmationToken: manifest.confirmation_token,
      actorRole: 'hr_admin',
      reasonCode: 'retention_confirmed',
      now: '2026-02-01T00:00:00.000Z',
    });
    assert.equal(fs.existsSync(materialFile), false);

    const currentRows = database.prepare('SELECT * FROM interview_lifecycle_tombstone').all();
    const currentTombstones = currentRows.map((row) => ({
      ...row,
      table: 'interview_lifecycle_material',
      idColumn: 'id',
      objectId: row.material_id,
      materialId: row.material_id,
      sessionId: row.session_id,
      policyVersion: row.policy_version,
      deletedAt: row.deleted_at,
      purgeAfter: row.purge_after,
    }));

    await restoreSqliteBackup({
      recoveryRoot,
      recoveryId: 'pre-delete',
      restoreRoot,
      destinationName: 'restored.db',
      appVersion: '1.0.0',
      policyVersion: POLICY_VERSION,
      now: '2026-02-02T00:00:00.000Z',
      confirmed: true,
      currentTombstones,
      allowedTombstoneTargets: [{ table: 'interview_lifecycle_material', idColumn: 'id' }],
      replayCurrentTombstones(restored, tombstones) {
        replayLifecycleTombstones({ database: restored, tombstones });
      },
      criticalQueries: [
        { sql: 'SELECT id FROM interview_lifecycle_session WHERE id = ?', params: ['session-integration'] },
        { sql: 'SELECT material_id FROM interview_lifecycle_tombstone WHERE material_id = ?', params: ['material-integration'] },
        { sql: 'SELECT request_hash FROM interview_llm_request_audit WHERE id = ?', params: [1] },
      ],
    });

    const restored = new Database(path.join(restoreRoot, 'restored.db'), { readonly: true });
    try {
      assert.equal(restored.prepare('SELECT 1 FROM interview_lifecycle_material WHERE id = ?').get('material-integration'), undefined);
      assert.equal(restored.prepare('SELECT session_id FROM interview_lifecycle_tombstone WHERE material_id = ?')
        .get('material-integration').session_id, 'session-integration');
      assert.deepEqual(restored.prepare('SELECT transcript, source_url, note FROM job_interview WHERE id = 11').get(), {
        transcript: '', source_url: null, note: '[material deleted]',
      });
      assert.equal(restored.prepare('SELECT 1 FROM interview_report_v1 WHERE id = 12').get(), undefined);
      assert.deepEqual(restored.prepare('SELECT report_id, request_hash FROM interview_llm_request_audit WHERE id = 1').get(), {
        report_id: null, request_hash: 'retained-hash',
      });
      assert.equal(restored.prepare('SELECT 1 FROM interview_ai_report WHERE id = 13').get(), undefined);
      assert.deepEqual(restored.prepare(`
        SELECT extracted_value, corrected_value, evidence, note
        FROM interview_recording_confirmation WHERE recording_id = 14
      `).get(), { extracted_value: null, corrected_value: null, evidence: null, note: null });
      assert.equal(restored.prepare('SELECT raw_summary_json FROM interview_recording WHERE id = 14').get().raw_summary_json, '{"state":"deleted"}');
      assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok');
      assert.deepEqual(restored.pragma('foreign_key_check'), []);
    } finally {
      restored.close();
    }

    console.log(JSON.stringify({
      check: 'f010_f011_integration',
      status: 'passed',
      deleted_material_resurrected: false,
      tombstone_persisted: true,
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
