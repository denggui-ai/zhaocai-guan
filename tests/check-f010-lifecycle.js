'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const {
  POLICY_VERSION,
  InterviewMaterialLifecycleError,
  applyInterviewMaterialLifecycleSchema,
  createLifecycleSession,
  registerLifecycleMaterial,
  assertSessionProcessingAllowed,
  closeRecruitment,
  withdrawSession,
  applyLegalHold,
  releaseLegalHold,
  createDeletionDryRun,
  confirmDeletion,
  recoverStagedDeletions,
  purgeExpiredTombstones,
} = require("../src/interview-material-lifecycle");

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f010-'));
const MATERIAL_ROOT = path.join(TEMP_ROOT, 'controlled-materials');
const OUTSIDE_ROOT = path.join(TEMP_ROOT, 'outside');
const DB_PATH = path.join(TEMP_ROOT, 'synthetic.db');
const SENSITIVE_NAME = '合成候选人甲';
const SENSITIVE_FILENAME = `${SENSITIVE_NAME}-原始面试.mp4`;

process.on('exit', () => fs.rmSync(TEMP_ROOT, { recursive: true, force: true }));

function errorCode(fn, code) {
  assert.throws(fn, (error) => error instanceof InterviewMaterialLifecycleError && error.code === code);
}

function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function writeMaterial(directory, filename, content = 'synthetic-only') {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, filename);
  fs.writeFileSync(file, content, { mode: 0o600 });
  return file;
}

function register(database, sessionId, materialId, artifactClass, filePath, createdAt) {
  return registerLifecycleMaterial({
    database,
    root: MATERIAL_ROOT,
    sessionId,
    materialId,
    artifactClass,
    filePath,
    createdAt,
  });
}

function assertNoSensitivePayload(value) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(SENSITIVE_NAME), false, 'public payload must not contain a name');
  assert.equal(serialized.includes(SENSITIVE_FILENAME), false, 'public payload must not contain an original filename');
  assert.equal(serialized.includes(MATERIAL_ROOT), false, 'public payload must not contain an absolute path');
  assert.equal(serialized.includes('synthetic-only'), false, 'public payload must not contain material content');
}

function run() {
  fs.mkdirSync(MATERIAL_ROOT, { recursive: true, mode: 0o700 });
  fs.mkdirSync(OUTSIDE_ROOT, { recursive: true, mode: 0o700 });
  const database = new Database(DB_PATH);
  database.pragma('foreign_keys = ON');
  applyInterviewMaterialLifecycleSchema(database);
  assert.equal(applyInterviewMaterialLifecycleSchema(database).policy_version, POLICY_VERSION, 'schema is idempotent');

  const openedAt = '2026-01-01T00:00:00.000Z';
  const policySession = createLifecycleSession({ database, sessionId: 'session-policy', createdAt: openedAt });
  assert.deepEqual(policySession, {
    session_id: 'session-policy',
    purpose: 'recruitment_interview',
    state: 'active',
    policy_version: POLICY_VERSION,
  });

  const policyDir = path.join(MATERIAL_ROOT, 'policy');
  const raw = register(database, 'session-policy', 'material-raw', 'raw_video',
    writeMaterial(policyDir, SENSITIVE_FILENAME), openedAt);
  const transcript = register(database, 'session-policy', 'material-transcript', 'transcript',
    writeMaterial(policyDir, 'transcript.txt'), openedAt);
  const draft = register(database, 'session-policy', 'material-draft', 'draft',
    writeMaterial(policyDir, 'draft.json'), openedAt);
  const report = register(database, 'session-policy', 'material-report', 'confirmed_report',
    writeMaterial(policyDir, 'confirmed-report.json'), openedAt);
  assert.equal(raw.delete_after, addDays(openedAt, 30));
  assert.equal(transcript.delete_after, addDays(openedAt, 90));
  assert.equal(draft.delete_after, addDays(openedAt, 90));
  assert.equal(report.delete_after, null);
  assertNoSensitivePayload([raw, transcript, draft, report]);
  assert.deepEqual(assertSessionProcessingAllowed({ database, sessionId: 'session-policy' }), {
    session_id: 'session-policy', processing_allowed: true,
  });

  const closedAt = '2026-02-01T00:00:00.000Z';
  const closed = closeRecruitment({
    database,
    sessionId: 'session-policy',
    actorRole: 'hr_admin',
    reasonCode: 'recruitment_complete',
    closedAt,
  });
  assert.equal(closed.confirmed_report_delete_after, addDays(closedAt, 180));
  assert.equal(database.prepare('SELECT delete_after FROM interview_lifecycle_material WHERE id = ?').get('material-report').delete_after,
    addDays(closedAt, 180));
  errorCode(() => assertSessionProcessingAllowed({ database, sessionId: 'session-policy' }), 'PROCESSING_CLOSED');

  const withdrawalSession = createLifecycleSession({ database, sessionId: 'session-withdrawal', createdAt: openedAt });
  assertNoSensitivePayload(withdrawalSession);
  const withdrawalFile = writeMaterial(path.join(MATERIAL_ROOT, 'withdrawal'), 'raw.mp4');
  register(database, 'session-withdrawal', 'material-withdrawal', 'raw_video', withdrawalFile, openedAt);
  const withdrawnAt = '2026-01-02T00:00:00.000Z';
  const withdrawn = withdrawSession({
    database,
    sessionId: 'session-withdrawal',
    actorRole: 'hr_admin',
    reasonCode: 'candidate_withdrawal',
    withdrawnAt,
  });
  assert.equal(withdrawn.delete_after, addDays(withdrawnAt, 7));
  assert.equal(database.prepare('SELECT delete_after FROM interview_lifecycle_material WHERE id = ?').get('material-withdrawal').delete_after,
    addDays(withdrawnAt, 7));
  errorCode(() => assertSessionProcessingAllowed({ database, sessionId: 'session-withdrawal' }), 'PROCESSING_WITHDRAWN');
  errorCode(() => register(database, 'session-withdrawal', 'material-after-withdrawal', 'draft',
    writeMaterial(path.join(MATERIAL_ROOT, 'withdrawal'), 'after.json'), withdrawnAt), 'PROCESSING_WITHDRAWN');

  createLifecycleSession({ database, sessionId: 'session-withdrawal-late', createdAt: openedAt });
  const withdrawalLateFile = writeMaterial(path.join(MATERIAL_ROOT, 'withdrawal-late'), 'raw.mp4');
  register(database, 'session-withdrawal-late', 'material-withdrawal-late', 'raw_video', withdrawalLateFile, openedAt);
  withdrawSession({
    database,
    sessionId: 'session-withdrawal-late',
    actorRole: 'hr_admin',
    reasonCode: 'candidate_withdrawal',
    withdrawnAt: '2026-02-01T00:00:00.000Z',
  });
  assert.equal(
    database.prepare('SELECT delete_after FROM interview_lifecycle_material WHERE id = ?').get('material-withdrawal-late').delete_after,
    addDays(openedAt, 30),
    'withdrawal must not extend an earlier retention deadline',
  );

  const outsideFile = writeMaterial(OUTSIDE_ROOT, 'outside.mp4');
  createLifecycleSession({ database, sessionId: 'session-boundary', createdAt: openedAt });
  errorCode(() => register(database, 'session-boundary', 'outside', 'raw_video', outsideFile, openedAt), 'MATERIAL_FILE_INVALID');
  const symlink = path.join(MATERIAL_ROOT, 'linked.mp4');
  fs.symlinkSync(outsideFile, symlink);
  errorCode(() => register(database, 'session-boundary', 'linked', 'raw_video', symlink, openedAt), 'MATERIAL_FILE_INVALID');

  const deleteSession = createLifecycleSession({ database, sessionId: 'session-delete', createdAt: openedAt });
  assertNoSensitivePayload(deleteSession);
  const deleteFile = writeMaterial(path.join(MATERIAL_ROOT, 'delete'), SENSITIVE_FILENAME);
  register(database, 'session-delete', 'material-delete', 'raw_video', deleteFile, openedAt);
  errorCode(() => applyLegalHold({
    database,
    sessionId: 'session-delete',
    holdId: 'hold-forbidden',
    actorRole: 'recruiter',
    reasonCode: 'litigation',
    appliedAt: '2026-02-01T00:00:00.000Z',
    expiresAt: '2026-04-01T00:00:00.000Z',
  }), 'ACTOR_ROLE_FORBIDDEN');
  const hold = applyLegalHold({
    database,
    sessionId: 'session-delete',
    holdId: 'hold-1',
    actorRole: 'legal',
    reasonCode: 'litigation',
    appliedAt: '2026-02-01T00:00:00.000Z',
    expiresAt: '2026-04-01T00:00:00.000Z',
  });
  assert.deepEqual(hold, {
    hold_id: 'hold-1', session_id: 'session-delete', state: 'active', expires_at: '2026-04-01T00:00:00.000Z',
  });
  errorCode(() => createDeletionDryRun({
    database, sessionId: 'session-delete', now: '2026-02-15T00:00:00.000Z',
  }), 'LEGAL_HOLD_ACTIVE');
  errorCode(() => releaseLegalHold({
    database,
    holdId: 'hold-1',
    actorRole: 'recruiter',
    reasonCode: 'not_authorized',
    releasedAt: '2026-02-16T00:00:00.000Z',
  }), 'ACTOR_ROLE_FORBIDDEN');
  releaseLegalHold({
    database,
    holdId: 'hold-1',
    actorRole: 'hr_admin',
    reasonCode: 'matter_closed',
    releasedAt: '2026-02-16T00:00:00.000Z',
  });
  const manifest = createDeletionDryRun({
    database, sessionId: 'session-delete', now: '2026-02-17T00:00:00.000Z',
  });
  assert.equal(manifest.item_count, 1);
  assert.equal(Object.hasOwn(manifest, 'item_ids'), false, 'dry-run must not expose material identifiers');
  assert.equal(
    database.prepare('SELECT material_id FROM interview_lifecycle_manifest_item WHERE manifest_id = ?').get(manifest.manifest_id).material_id,
    'material-delete',
    'opaque identifiers remain internal to the manifest',
  );
  assertNoSensitivePayload(manifest);
  errorCode(() => confirmDeletion({
    database,
    root: MATERIAL_ROOT,
    manifestId: manifest.manifest_id,
    confirmationToken: 'wrong-token',
    actorRole: 'hr_admin',
    reasonCode: 'retention_confirmed',
    now: '2026-02-17T00:00:00.000Z',
  }), 'CONFIRMATION_INVALID');
  assert.equal(fs.existsSync(deleteFile), true, 'invalid confirmation must not move the file');

  database.exec(`
    CREATE TRIGGER synthetic_f010_abort_delete
    BEFORE UPDATE OF state ON interview_lifecycle_material
    WHEN NEW.id = 'material-delete'
    BEGIN SELECT RAISE(ABORT, 'synthetic transaction failure'); END;
  `);
  assert.throws(() => confirmDeletion({
    database,
    root: MATERIAL_ROOT,
    manifestId: manifest.manifest_id,
    confirmationToken: manifest.confirmation_token,
    actorRole: 'hr_admin',
    reasonCode: 'retention_confirmed',
    now: '2026-02-17T00:00:00.000Z',
  }), /synthetic transaction failure/);
  assert.equal(fs.existsSync(deleteFile), true, 'transaction failure must restore the file from staging');
  assert.equal(database.prepare('SELECT state FROM interview_lifecycle_material WHERE id = ?').get('material-delete').state,
    'active');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM interview_lifecycle_tombstone').get().count, 0);
  database.exec('DROP TRIGGER synthetic_f010_abort_delete');

  const deleted = confirmDeletion({
    database,
    root: MATERIAL_ROOT,
    manifestId: manifest.manifest_id,
    confirmationToken: manifest.confirmation_token,
    actorRole: 'hr_admin',
    reasonCode: 'retention_confirmed',
    now: '2026-02-17T00:00:00.000Z',
  });
  assert.equal(deleted.deleted_count, 1);
  assert.equal(Object.hasOwn(deleted, 'deleted_item_ids'), false, 'confirmation must not expose material identifiers');
  assert.equal(deleted.staging_cleanup_pending, 0);
  assert.equal(fs.existsSync(deleteFile), false);
  assertNoSensitivePayload(deleted);

  const tombstone = database.prepare('SELECT * FROM interview_lifecycle_tombstone WHERE material_id = ?').get('material-delete');
  assert.deepEqual(Object.keys(tombstone).sort(), [
    'db_entity_id', 'db_entity_type', 'deleted_at', 'material_id',
    'policy_version', 'purge_after', 'session_id', 'storage_kind',
  ]);
  assert.equal(tombstone.storage_kind, 'file');
  assert.equal(tombstone.db_entity_type, null);
  assert.equal(tombstone.db_entity_id, null);
  assert.equal(tombstone.purge_after, addDays('2026-02-17T00:00:00.000Z', 30));
  assertNoSensitivePayload(tombstone);
  const events = database.prepare('SELECT * FROM interview_lifecycle_event ORDER BY created_at').all();
  assertNoSensitivePayload(events);
  assert.equal(events.every((event) => !Object.keys(event).some((key) => /path|name|content|body/i.test(key))), true,
    'event schema must not contain sensitive payload columns');

  const deletedStageName = crypto.createHash('sha256').update('hrboss-delete:material-delete').digest('hex');
  const stagingDir = path.join(MATERIAL_ROOT, '.delete-staging');
  fs.writeFileSync(path.join(stagingDir, deletedStageName), 'synthetic-staged-copy', { mode: 0o600 });
  assert.deepEqual(recoverStagedDeletions({ database, root: MATERIAL_ROOT }), {
    restored_count: 0, removed_count: 1,
  });

  createLifecycleSession({ database, sessionId: 'session-recover', createdAt: openedAt });
  const recoverFile = writeMaterial(path.join(MATERIAL_ROOT, 'recover'), 'material.bin');
  register(database, 'session-recover', 'material-recover', 'draft', recoverFile, openedAt);
  const recoverStageName = crypto.createHash('sha256').update('hrboss-delete:material-recover').digest('hex');
  fs.renameSync(recoverFile, path.join(stagingDir, recoverStageName));
  assert.deepEqual(recoverStagedDeletions({ database, root: MATERIAL_ROOT }), {
    restored_count: 1, removed_count: 0,
  });
  assert.equal(fs.existsSync(recoverFile), true, 'pre-commit staging must be restored');

  assert.deepEqual(purgeExpiredTombstones({ database, now: '2026-03-18T23:59:59.999Z' }), { purged_count: 0 });
  assert.deepEqual(purgeExpiredTombstones({ database, now: '2026-03-19T00:00:00.000Z' }), { purged_count: 1 });

  database.close();
  console.log(JSON.stringify({
    check: 'f010_interview_material_lifecycle',
    status: 'passed',
    policy_version: POLICY_VERSION,
    synthetic_only: true,
  }));
}

run();
