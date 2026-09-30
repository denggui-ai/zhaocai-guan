'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  f018FeatureEnabled,
  openDb,
  prepareDatabaseMigrationBackup,
  upsertCandidate,
} = require('./db');

const TABLES = ['application_episode', 'application_event', 'final_review', 'final_disposition'];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f018-migration-gate-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

function hasTable(database, name) {
  return Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

async function run() {
  assert.equal(f018FeatureEnabled({ f018Enabled: false }), false);
  assert.equal(f018FeatureEnabled({ f018Enabled: true }), true);
  const file = path.join(root, 'synthetic.db');
  let database = openDb(file, { f018Enabled: false, assessmentEnabled: false });
  database.prepare(`INSERT INTO job (id, encrypt_job_id, name, created_at) VALUES (1, 'F018-JOB', '合成岗位', ?)`)
    .run('2026-07-12T00:00:00.000Z');
  database.prepare(`
    INSERT INTO candidate (
      internal_id, job_id, geek_id, source, disposition_status, disposition_code,
      workflow_version, created_at, updated_at
    ) VALUES (?, 1, ?, 'fixture', ?, ?, 1, ?, ?)
  `).run('C-F018-ACTIVE', 'G-F018-ACTIVE', '待处理', 'under_review',
    '2026-07-12T00:00:00.000Z', '2026-07-12T00:00:00.000Z');
  database.prepare(`
    INSERT INTO candidate (
      internal_id, job_id, geek_id, source, disposition_status, disposition_code,
      workflow_version, created_at, updated_at
    ) VALUES (?, 1, ?, 'fixture', ?, ?, 1, ?, ?)
  `).run('C-F018-CLOSED', 'G-F018-CLOSED', '淘汰', 'rejected',
    '2026-07-12T00:00:00.000Z', '2026-07-12T01:00:00.000Z');
  for (const table of TABLES) assert.equal(hasTable(database, table), false);
  const candidateBefore = database.prepare(`
    SELECT internal_id, disposition_status, disposition_code, workflow_version, created_at, updated_at
    FROM candidate ORDER BY internal_id
  `).all();
  database.close();

  const recoveryRoot = path.join(root, 'recovery');
  const backup = await prepareDatabaseMigrationBackup(file, {
    f018Enabled: true,
    assessmentEnabled: false,
    recoveryRoot,
    recoveryId: 'synthetic-before-f018',
    createdAt: '2026-07-12T02:00:00.000Z',
  });
  assert.equal(backup.backup_required, true);
  assert.ok(fs.existsSync(path.join(recoveryRoot, 'synthetic-before-f018', 'database.db')));

  database = openDb(file, { f018Enabled: true, assessmentEnabled: false });
  for (const table of TABLES) assert.equal(hasTable(database, table), true);
  assert.deepEqual(database.prepare(`
    SELECT candidate_id, episode_no, status, version
    FROM application_episode ORDER BY candidate_id
  `).all(), [
    { candidate_id: 'C-F018-ACTIVE', episode_no: 1, status: 'active', version: 1 },
    { candidate_id: 'C-F018-CLOSED', episode_no: 1, status: 'closed', version: 2 },
  ]);
  assert.deepEqual(database.prepare(`
    SELECT internal_id, disposition_status, disposition_code, workflow_version, created_at, updated_at
    FROM candidate ORDER BY internal_id
  `).all(), candidateBefore, 'F018 backfill must not mutate candidate fields');

  const inserted = upsertCandidate({
    job_id: 1,
    geek_id: 'G-F018-NEW',
    source: 'fixture',
    name: '合成候选人',
  }, '2026-07-12T03:00:00.000Z');
  assert.equal(inserted.inserted, true);
  assert.deepEqual(database.prepare(`
    SELECT episode_no, status FROM application_episode WHERE candidate_id = ?
  `).get(inserted.internal_id), { episode_no: 1, status: 'active' });
  database.exec('DROP TRIGGER final_review_confirmed_update_guard');
  database.close();

  const missingTrigger = await prepareDatabaseMigrationBackup(file, {
    f018Enabled: true,
    assessmentEnabled: false,
    recoveryRoot,
    recoveryId: 'synthetic-missing-f018-trigger',
    createdAt: '2026-07-12T04:00:00.000Z',
  });
  assert.equal(missingTrigger.backup_required, true, 'a missing F018 trigger must require migration backup');

  database = openDb(file, { f018Enabled: true, assessmentEnabled: false });
  database.exec('DROP INDEX final_review_one_current_confirmed');
  database.close();

  const missingIndex = await prepareDatabaseMigrationBackup(file, {
    f018Enabled: true,
    assessmentEnabled: false,
    recoveryRoot,
    recoveryId: 'synthetic-missing-f018-index',
    createdAt: '2026-07-12T05:00:00.000Z',
  });
  assert.equal(missingIndex.backup_required, true, 'a missing F018 index must require migration backup');

  database = openDb(file, { f018Enabled: true, assessmentEnabled: false });
  database.close();

  const current = await prepareDatabaseMigrationBackup(file, {
    f018Enabled: true, assessmentEnabled: false, recoveryRoot,
  });
  assert.equal(current.backup_required, false);
  assert.equal(current.reason, 'schema_current');
  console.log('check-f018-migration-gate ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
