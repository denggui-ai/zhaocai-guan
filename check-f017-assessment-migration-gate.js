'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assessmentPhaseAEnabled,
  openDb,
  prepareDatabaseMigrationBackup,
} = require('./db');
const {
  ASSESSMENT_DELETION_INDEXES,
  ASSESSMENT_DELETION_TRIGGERS,
  ASSESSMENT_TABLES,
} = require('./assessment-schema');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f017-migration-gate-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

function tables(database) {
  return new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
}

async function run() {
  assert.equal(assessmentPhaseAEnabled({ assessmentEnabled: false }), false);
  assert.equal(assessmentPhaseAEnabled({ assessmentEnabled: true }), true);
  const file = path.join(root, 'synthetic.db');
  assert.equal(path.dirname(file), root, 'migration fixture must remain a direct child of the temporary root');
  let database = openDb(file, { assessmentEnabled: false });
  for (const name of ASSESSMENT_TABLES) {
    assert.equal(tables(database).has(name), false, `${name} must remain absent while Phase A is disabled`);
  }
  database.close();

  const recoveryRoot = path.join(root, 'recovery');
  assert.equal(path.dirname(recoveryRoot), root, 'recovery fixture must remain under the temporary root');
  const backup = await prepareDatabaseMigrationBackup(file, {
    assessmentEnabled: true,
    recoveryRoot,
    recoveryId: 'synthetic-pre-f017',
    createdAt: '2026-07-12T12:00:00.000Z',
  });
  assert.equal(backup.backup_required, true, 'enabling F017 on an existing DB must create a recovery point');
  assert.ok(fs.existsSync(path.join(recoveryRoot, 'synthetic-pre-f017', 'database.db')));

  database = openDb(file, { assessmentEnabled: true });
  for (const name of ASSESSMENT_TABLES) {
    assert.equal(tables(database).has(name), true, `${name} must exist when Phase A is explicitly enabled`);
  }
  assert.ok(database.prepare("PRAGMA table_info('assessment_document')").all().some((row) => row.name === 'dispute_state'));
  assert.ok(database.prepare("PRAGMA table_info('assessment_binding')").all().some((row) => row.name === 'conflict_state'));
  database.close();

  const current = await prepareDatabaseMigrationBackup(file, { assessmentEnabled: true, recoveryRoot });
  assert.equal(current.backup_required, false);
  assert.equal(current.reason, 'schema_current');

  database = openDb(file, { assessmentEnabled: true });
  database.exec(`DROP INDEX ${ASSESSMENT_DELETION_INDEXES[0]}`);
  database.close();
  const missingIndex = await prepareDatabaseMigrationBackup(file, {
    assessmentEnabled: true,
    recoveryRoot,
    recoveryId: 'synthetic-pre-f019-a-index',
    createdAt: '2026-07-13T01:00:00.000Z',
  });
  assert.equal(missingIndex.backup_required, true, 'missing A index must require a recovery point');

  database = openDb(file, { assessmentEnabled: true });
  database.exec(`DROP TRIGGER ${ASSESSMENT_DELETION_TRIGGERS[0]}`);
  database.close();
  const missingTrigger = await prepareDatabaseMigrationBackup(file, {
    assessmentEnabled: true,
    recoveryRoot,
    recoveryId: 'synthetic-pre-f019-a-trigger',
    createdAt: '2026-07-13T01:01:00.000Z',
  });
  assert.equal(missingTrigger.backup_required, true, 'missing A trigger must require a recovery point');
  console.log('check-f017-assessment-migration-gate ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
