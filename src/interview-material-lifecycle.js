'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const POLICY_VERSION = 'interview-material-v1-20260712';
const PURPOSE = 'recruitment_interview';
const ARTIFACT_DAYS = Object.freeze({
  raw_audio: 30,
  raw_video: 30,
  transcript: 90,
  draft: 90,
  confirmed_report: null,
});
const HOLD_ROLES = new Set(['hr_admin', 'legal']);
const CONFIRM_ROLES = new Set(['hr_admin', 'legal']);
const STAGING_DIR = '.delete-staging';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS interview_lifecycle_session (
  id TEXT PRIMARY KEY NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose = 'recruitment_interview'),
  state TEXT NOT NULL CHECK(state IN ('active', 'closed', 'withdrawn')),
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  recruitment_closed_at TEXT,
  withdrawn_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0)
);

CREATE TABLE IF NOT EXISTS interview_lifecycle_material (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES interview_lifecycle_session(id) ON DELETE RESTRICT,
  purpose TEXT NOT NULL CHECK(purpose = 'recruitment_interview'),
  artifact_class TEXT NOT NULL
    CHECK(artifact_class IN ('raw_audio', 'raw_video', 'transcript', 'draft', 'confirmed_report')),
  storage_kind TEXT NOT NULL DEFAULT 'file' CHECK(storage_kind IN ('file', 'sqlite')),
  internal_relpath TEXT,
  db_entity_type TEXT CHECK(db_entity_type IS NULL OR db_entity_type IN (
    'job_interview', 'interview_report_v1', 'interview_ai_report',
    'interview_recording_confirmations', 'interview_recording_metadata'
  )),
  db_entity_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('active', 'deleted')),
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delete_after TEXT,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  CHECK((state = 'active' AND internal_relpath IS NOT NULL AND deleted_at IS NULL)
     OR (state = 'deleted' AND internal_relpath IS NULL AND deleted_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS interview_lifecycle_material_due_idx
ON interview_lifecycle_material(session_id, state, delete_after);

CREATE TABLE IF NOT EXISTS interview_lifecycle_hold (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES interview_lifecycle_session(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('hr_admin', 'legal')),
  reason_code TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  released_at TEXT,
  release_reason_code TEXT
);
CREATE INDEX IF NOT EXISTS interview_lifecycle_hold_active_idx
ON interview_lifecycle_hold(session_id, released_at, expires_at);

CREATE TABLE IF NOT EXISTS interview_lifecycle_manifest (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES interview_lifecycle_session(id) ON DELETE RESTRICT,
  confirmation_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS interview_lifecycle_manifest_item (
  manifest_id TEXT NOT NULL REFERENCES interview_lifecycle_manifest(id) ON DELETE RESTRICT,
  material_id TEXT NOT NULL REFERENCES interview_lifecycle_material(id) ON DELETE RESTRICT,
  expected_version INTEGER NOT NULL,
  PRIMARY KEY(manifest_id, material_id)
);

CREATE TABLE IF NOT EXISTS interview_lifecycle_tombstone (
  material_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  storage_kind TEXT NOT NULL DEFAULT 'file' CHECK(storage_kind IN ('file', 'sqlite')),
  db_entity_type TEXT,
  db_entity_id TEXT,
  deleted_at TEXT NOT NULL,
  purge_after TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interview_lifecycle_event (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  material_id TEXT,
  event_type TEXT NOT NULL,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('system', 'hr_admin', 'legal')),
  reason_code TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS interview_lifecycle_event_session_idx
ON interview_lifecycle_event(session_id, created_at);
`;

class InterviewMaterialLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InterviewMaterialLifecycleError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new InterviewMaterialLifecycleError(code, message);
}

function assertDatabase(database) {
  if (!database || typeof database.prepare !== 'function' || typeof database.transaction !== 'function') {
    fail('DATABASE_REQUIRED', 'A caller-provided SQLite connection is required.');
  }
}

function requiredToken(value, code, maxLength = 128) {
  const token = String(value == null ? '' : value).trim();
  if (!token || token.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(token)) {
    fail(code, 'A controlled identifier is invalid.');
  }
  return token;
}

function iso(value, code) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) fail(code, 'A valid timestamp is required.');
  return date.toISOString();
}

function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function runImmediate(database, work) {
  // Reuse a caller-owned transaction when lifecycle registration is part of a
  // larger business write (for example linking a recording to a session).
  // Starting another BEGIN IMMEDIATE inside SQLite would fail and break the
  // atomic parent operation.
  if (database.inTransaction) return work();
  const transaction = database.transaction(work);
  return typeof transaction.immediate === 'function' ? transaction.immediate() : transaction();
}

function addEvent(database, {
  sessionId,
  materialId = null,
  eventType,
  actorRole = 'system',
  reasonCode,
  createdAt,
}) {
  database.prepare(`
    INSERT INTO interview_lifecycle_event (
      id, session_id, material_id, event_type, actor_role, reason_code, policy_version, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    newId('ile'), sessionId, materialId, eventType, actorRole, reasonCode, POLICY_VERSION, createdAt,
  );
}

function applyInterviewMaterialLifecycleSchema(database) {
  assertDatabase(database);
  database.transaction(() => database.exec(SCHEMA))();
  const materialColumns = new Set(database.prepare("PRAGMA table_info('interview_lifecycle_material')").all().map((row) => row.name));
  const tombstoneColumns = new Set(database.prepare("PRAGMA table_info('interview_lifecycle_tombstone')").all().map((row) => row.name));
  database.transaction(() => {
    if (!materialColumns.has('storage_kind')) database.exec("ALTER TABLE interview_lifecycle_material ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'file'");
    if (!materialColumns.has('db_entity_type')) database.exec('ALTER TABLE interview_lifecycle_material ADD COLUMN db_entity_type TEXT');
    if (!materialColumns.has('db_entity_id')) database.exec('ALTER TABLE interview_lifecycle_material ADD COLUMN db_entity_id TEXT');
    if (!tombstoneColumns.has('storage_kind')) database.exec("ALTER TABLE interview_lifecycle_tombstone ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'file'");
    if (!tombstoneColumns.has('db_entity_type')) database.exec('ALTER TABLE interview_lifecycle_tombstone ADD COLUMN db_entity_type TEXT');
    if (!tombstoneColumns.has('db_entity_id')) database.exec('ALTER TABLE interview_lifecycle_tombstone ADD COLUMN db_entity_id TEXT');
  })();
  return { policy_version: POLICY_VERSION };
}

function createLifecycleSession({ database, sessionId, purpose = PURPOSE, createdAt } = {}) {
  assertDatabase(database);
  const id = requiredToken(sessionId, 'SESSION_ID_INVALID');
  if (purpose !== PURPOSE) fail('PURPOSE_INVALID', 'The lifecycle purpose is invalid.');
  const at = iso(createdAt, 'CREATED_AT_INVALID');
  runImmediate(database, () => {
    database.prepare(`
      INSERT INTO interview_lifecycle_session (
        id, purpose, state, policy_version, created_at, version
      ) VALUES (?, ?, 'active', ?, ?, 1)
    `).run(id, PURPOSE, POLICY_VERSION, at);
    addEvent(database, {
      sessionId: id,
      eventType: 'session_created',
      reasonCode: 'session_created',
      createdAt: at,
    });
  });
  return { session_id: id, purpose: PURPOSE, state: 'active', policy_version: POLICY_VERSION };
}

function controlledRoot(root) {
  if (!path.isAbsolute(String(root || ''))) fail('ROOT_INVALID', 'A controlled absolute root is required.');
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch {
    fail('ROOT_INVALID', 'The controlled root is unavailable.');
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('ROOT_INVALID', 'The controlled root is invalid.');
  return fs.realpathSync(root);
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function controlledFile(root, filePath) {
  const resolvedRoot = controlledRoot(root);
  let stat;
  let real;
  try {
    stat = fs.lstatSync(filePath);
    real = fs.realpathSync(filePath);
  } catch {
    fail('MATERIAL_FILE_INVALID', 'The material file is unavailable.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || !isWithin(resolvedRoot, real)) {
    fail('MATERIAL_FILE_INVALID', 'The material file is outside the controlled boundary.');
  }
  return { root: resolvedRoot, absolute: real, relative: path.relative(resolvedRoot, real), stat };
}

function materialPublic(row) {
  return {
    material_id: row.id,
    session_id: row.session_id,
    purpose: row.purpose,
    artifact_class: row.artifact_class,
    state: row.state,
    delete_after: row.delete_after,
    policy_version: row.policy_version,
    version: Number(row.version),
  };
}

function session(database, sessionId) {
  const row = database.prepare('SELECT * FROM interview_lifecycle_session WHERE id = ?').get(sessionId);
  if (!row) fail('SESSION_NOT_FOUND', 'The lifecycle session was not found.');
  return row;
}

function registerLifecycleMaterial({
  database,
  root,
  sessionId,
  materialId,
  artifactClass,
  filePath,
  createdAt,
} = {}) {
  assertDatabase(database);
  const sessionIdValue = requiredToken(sessionId, 'SESSION_ID_INVALID');
  const materialIdValue = requiredToken(materialId, 'MATERIAL_ID_INVALID');
  if (!Object.hasOwn(ARTIFACT_DAYS, artifactClass)) fail('ARTIFACT_CLASS_INVALID', 'The artifact class is invalid.');
  const at = iso(createdAt, 'CREATED_AT_INVALID');
  const file = controlledFile(root, filePath);
  let deleteAfter;
  runImmediate(database, () => {
    const currentSession = session(database, sessionIdValue);
    if (currentSession.state === 'withdrawn') fail('PROCESSING_WITHDRAWN', 'Processing is disabled for a withdrawn session.');
    if (currentSession.state === 'closed') fail('PROCESSING_CLOSED', 'Processing is disabled for a closed session.');
    deleteAfter = ARTIFACT_DAYS[artifactClass] == null ? null : addDays(at, ARTIFACT_DAYS[artifactClass]);
    database.prepare(`
      INSERT INTO interview_lifecycle_material (
        id, session_id, purpose, artifact_class, internal_relpath, state,
        policy_version, created_at, delete_after, version
      ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, 1)
    `).run(
      materialIdValue, sessionIdValue, PURPOSE, artifactClass, file.relative,
      POLICY_VERSION, at, deleteAfter,
    );
    addEvent(database, {
      sessionId: sessionIdValue,
      materialId: materialIdValue,
      eventType: 'material_registered',
      reasonCode: 'material_registered',
      createdAt: at,
    });
  });
  return materialPublic(database.prepare('SELECT * FROM interview_lifecycle_material WHERE id = ?').get(materialIdValue));
}

const DB_ENTITY_TYPES = new Set([
  'job_interview',
  'interview_report_v1',
  'interview_ai_report',
  'interview_recording_confirmations',
  'interview_recording_metadata',
]);

function registerLifecycleDatabaseMaterial({
  database,
  sessionId,
  materialId,
  artifactClass,
  entityType,
  entityId,
  createdAt,
} = {}) {
  assertDatabase(database);
  const sessionIdValue = requiredToken(sessionId, 'SESSION_ID_INVALID');
  const materialIdValue = requiredToken(materialId, 'MATERIAL_ID_INVALID');
  const entityIdValue = requiredToken(entityId, 'DB_ENTITY_ID_INVALID');
  if (!/^[1-9][0-9]*$/.test(entityIdValue)) fail('DB_ENTITY_ID_INVALID', 'The database entity id is invalid.');
  if (!Object.hasOwn(ARTIFACT_DAYS, artifactClass)) fail('ARTIFACT_CLASS_INVALID', 'The artifact class is invalid.');
  if (!DB_ENTITY_TYPES.has(entityType)) fail('DB_ENTITY_TYPE_INVALID', 'The database entity type is invalid.');
  const at = iso(createdAt, 'CREATED_AT_INVALID');
  const locator = `@sqlite/${entityType}/${entityIdValue}`;
  runImmediate(database, () => {
    const currentSession = session(database, sessionIdValue);
    if (currentSession.state === 'withdrawn') fail('PROCESSING_WITHDRAWN', 'Processing is disabled for a withdrawn session.');
    if (currentSession.state === 'closed') fail('PROCESSING_CLOSED', 'Processing is disabled for a closed session.');
    const existing = database.prepare('SELECT * FROM interview_lifecycle_material WHERE id = ?').get(materialIdValue);
    if (existing) {
      if (existing.session_id !== sessionIdValue || existing.storage_kind !== 'sqlite'
          || existing.db_entity_type !== entityType || existing.db_entity_id !== entityIdValue) {
        fail('MATERIAL_ID_CONFLICT', 'The lifecycle material identity conflicts with an existing material.');
      }
      if (existing.state === 'deleted') fail('MATERIAL_DELETED', 'The lifecycle material was deleted.');
      if (existing.artifact_class !== artifactClass) {
        const deleteAfter = ARTIFACT_DAYS[artifactClass] == null ? null : addDays(at, ARTIFACT_DAYS[artifactClass]);
        database.prepare(`
          UPDATE interview_lifecycle_material
          SET artifact_class = ?, delete_after = ?, version = version + 1
          WHERE id = ? AND state = 'active'
        `).run(artifactClass, deleteAfter, materialIdValue);
        addEvent(database, {
          sessionId: sessionIdValue,
          materialId: materialIdValue,
          eventType: 'material_class_updated',
          reasonCode: 'material_class_updated',
          createdAt: at,
        });
      }
      return;
    }
    const deleteAfter = ARTIFACT_DAYS[artifactClass] == null ? null : addDays(at, ARTIFACT_DAYS[artifactClass]);
    database.prepare(`
      INSERT INTO interview_lifecycle_material (
        id, session_id, purpose, artifact_class, storage_kind, internal_relpath,
        db_entity_type, db_entity_id, state, policy_version, created_at, delete_after, version
      ) VALUES (?, ?, ?, ?, 'sqlite', ?, ?, ?, 'active', ?, ?, ?, 1)
    `).run(materialIdValue, sessionIdValue, PURPOSE, artifactClass, locator,
      entityType, entityIdValue, POLICY_VERSION, at, deleteAfter);
    addEvent(database, {
      sessionId: sessionIdValue,
      materialId: materialIdValue,
      eventType: 'material_registered',
      reasonCode: 'material_registered',
      createdAt: at,
    });
  });
  return materialPublic(database.prepare('SELECT * FROM interview_lifecycle_material WHERE id = ?').get(materialIdValue));
}

function assertSessionProcessingAllowed({ database, sessionId } = {}) {
  assertDatabase(database);
  const row = session(database, requiredToken(sessionId, 'SESSION_ID_INVALID'));
  if (row.state === 'withdrawn') fail('PROCESSING_WITHDRAWN', 'Processing is disabled for a withdrawn session.');
  if (row.state !== 'active') fail('PROCESSING_CLOSED', 'Processing is disabled for a closed session.');
  return { session_id: row.id, processing_allowed: true };
}

function closeRecruitment({ database, sessionId, actorRole = 'hr_admin', reasonCode, closedAt } = {}) {
  assertDatabase(database);
  const id = requiredToken(sessionId, 'SESSION_ID_INVALID');
  if (!CONFIRM_ROLES.has(actorRole)) fail('ACTOR_ROLE_FORBIDDEN', 'The actor role is not allowed.');
  const reason = requiredToken(reasonCode, 'REASON_CODE_INVALID', 80);
  const at = iso(closedAt, 'CLOSED_AT_INVALID');
  runImmediate(database, () => {
    const current = session(database, id);
    if (current.state !== 'active') fail('SESSION_STATE_INVALID', 'The session cannot be closed from its current state.');
    database.prepare(`
      UPDATE interview_lifecycle_session
      SET state = 'closed', recruitment_closed_at = ?, version = version + 1
      WHERE id = ?
    `).run(at, id);
    database.prepare(`
      UPDATE interview_lifecycle_material
      SET delete_after = ?, version = version + 1
      WHERE session_id = ? AND artifact_class = 'confirmed_report' AND state = 'active'
    `).run(addDays(at, 180), id);
    addEvent(database, { sessionId: id, eventType: 'recruitment_closed', actorRole, reasonCode: reason, createdAt: at });
  });
  return { session_id: id, state: 'closed', confirmed_report_delete_after: addDays(at, 180) };
}

function withdrawSession({ database, sessionId, actorRole = 'hr_admin', reasonCode, withdrawnAt } = {}) {
  assertDatabase(database);
  const id = requiredToken(sessionId, 'SESSION_ID_INVALID');
  if (!CONFIRM_ROLES.has(actorRole)) fail('ACTOR_ROLE_FORBIDDEN', 'The actor role is not allowed.');
  const reason = requiredToken(reasonCode, 'REASON_CODE_INVALID', 80);
  const at = iso(withdrawnAt, 'WITHDRAWN_AT_INVALID');
  const deleteAfter = addDays(at, 7);
  runImmediate(database, () => {
    const current = session(database, id);
    if (current.state === 'withdrawn') fail('SESSION_STATE_INVALID', 'The session is already withdrawn.');
    database.prepare(`
      UPDATE interview_lifecycle_session
      SET state = 'withdrawn', withdrawn_at = ?, version = version + 1
      WHERE id = ?
    `).run(at, id);
    database.prepare(`
      UPDATE interview_lifecycle_material
      SET delete_after = CASE
            WHEN delete_after IS NULL OR delete_after > ? THEN ?
            ELSE delete_after
          END,
          version = version + 1
      WHERE session_id = ? AND state = 'active'
    `).run(deleteAfter, deleteAfter, id);
    addEvent(database, { sessionId: id, eventType: 'session_withdrawn', actorRole, reasonCode: reason, createdAt: at });
  });
  return { session_id: id, state: 'withdrawn', delete_after: deleteAfter };
}

function applyLegalHold({ database, sessionId, holdId, actorRole, reasonCode, appliedAt, expiresAt } = {}) {
  assertDatabase(database);
  const sessionIdValue = requiredToken(sessionId, 'SESSION_ID_INVALID');
  const holdIdValue = requiredToken(holdId, 'HOLD_ID_INVALID');
  if (!HOLD_ROLES.has(actorRole)) fail('ACTOR_ROLE_FORBIDDEN', 'Only HR administrators or Legal may manage a legal hold.');
  const reason = requiredToken(reasonCode, 'REASON_CODE_INVALID', 80);
  const at = iso(appliedAt, 'APPLIED_AT_INVALID');
  const expiry = iso(expiresAt, 'EXPIRES_AT_INVALID');
  if (expiry <= at) fail('EXPIRES_AT_INVALID', 'The legal hold expiry must be after its start.');
  session(database, sessionIdValue);
  runImmediate(database, () => {
    database.prepare(`
      INSERT INTO interview_lifecycle_hold (
        id, session_id, actor_role, reason_code, applied_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(holdIdValue, sessionIdValue, actorRole, reason, at, expiry);
    addEvent(database, { sessionId: sessionIdValue, eventType: 'legal_hold_applied', actorRole, reasonCode: reason, createdAt: at });
  });
  return { hold_id: holdIdValue, session_id: sessionIdValue, state: 'active', expires_at: expiry };
}

function releaseLegalHold({ database, holdId, actorRole, reasonCode, releasedAt } = {}) {
  assertDatabase(database);
  const holdIdValue = requiredToken(holdId, 'HOLD_ID_INVALID');
  if (!HOLD_ROLES.has(actorRole)) fail('ACTOR_ROLE_FORBIDDEN', 'Only HR administrators or Legal may manage a legal hold.');
  const reason = requiredToken(reasonCode, 'REASON_CODE_INVALID', 80);
  const at = iso(releasedAt, 'RELEASED_AT_INVALID');
  return runImmediate(database, () => {
    const hold = database.prepare('SELECT * FROM interview_lifecycle_hold WHERE id = ?').get(holdIdValue);
    if (!hold) fail('HOLD_NOT_FOUND', 'The legal hold was not found.');
    if (hold.released_at) fail('HOLD_ALREADY_RELEASED', 'The legal hold is already released.');
    database.prepare(`
      UPDATE interview_lifecycle_hold SET released_at = ?, release_reason_code = ? WHERE id = ?
    `).run(at, reason, holdIdValue);
    addEvent(database, { sessionId: hold.session_id, eventType: 'legal_hold_released', actorRole, reasonCode: reason, createdAt: at });
    return { hold_id: holdIdValue, session_id: hold.session_id, state: 'released' };
  });
}

function activeHold(database, sessionId, at) {
  return database.prepare(`
    SELECT id FROM interview_lifecycle_hold
    WHERE session_id = ? AND released_at IS NULL AND applied_at <= ? AND expires_at > ?
    LIMIT 1
  `).get(sessionId, at, at);
}

function createDeletionDryRun({ database, sessionId, now } = {}) {
  assertDatabase(database);
  const id = requiredToken(sessionId, 'SESSION_ID_INVALID');
  const at = iso(now, 'NOW_INVALID');
  session(database, id);
  if (activeHold(database, id, at)) fail('LEGAL_HOLD_ACTIVE', 'Deletion is blocked by an active legal hold.');
  const items = database.prepare(`
    SELECT id, version FROM interview_lifecycle_material
    WHERE session_id = ? AND state = 'active' AND delete_after IS NOT NULL AND delete_after <= ?
    ORDER BY id
  `).all(id, at);
  if (!items.length) fail('NO_MATERIAL_DUE', 'No material is currently due for deletion.');
  const manifestId = newId('ilm');
  const confirmationToken = crypto.randomBytes(24).toString('hex');
  const confirmationHash = crypto.createHash('sha256').update(confirmationToken).digest('hex');
  runImmediate(database, () => {
    database.prepare(`
      INSERT INTO interview_lifecycle_manifest (
        id, session_id, confirmation_hash, policy_version, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(manifestId, id, confirmationHash, POLICY_VERSION, at);
    const insertItem = database.prepare(`
      INSERT INTO interview_lifecycle_manifest_item (manifest_id, material_id, expected_version)
      VALUES (?, ?, ?)
    `);
    for (const item of items) insertItem.run(manifestId, item.id, item.version);
    addEvent(database, { sessionId: id, eventType: 'deletion_dry_run', reasonCode: 'retention_due', createdAt: at });
  });
  return {
    manifest_id: manifestId,
    session_id: id,
    item_count: items.length,
    confirmation_token: confirmationToken,
    policy_version: POLICY_VERSION,
  };
}

function stagingRoot(root) {
  const resolvedRoot = controlledRoot(root);
  const directory = path.join(resolvedRoot, STAGING_DIR);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory) {
      fail('STAGING_INVALID', 'The deletion staging area is invalid.');
    }
    fs.chmodSync(directory, 0o700);
  } catch (error) {
    if (error instanceof InterviewMaterialLifecycleError) throw error;
    fail('STAGING_INVALID', 'The deletion staging area is unavailable.');
  }
  return { root: resolvedRoot, directory };
}

function stageName(materialId) {
  return crypto.createHash('sha256').update(`hrboss-delete:${materialId}`).digest('hex');
}

function stageMaterial(staging, row) {
  const source = path.resolve(staging.root, row.internal_relpath);
  if (!isWithin(staging.root, source)) fail('MATERIAL_FILE_INVALID', 'The material file is outside the controlled boundary.');
  const checked = controlledFile(staging.root, source);
  const target = path.join(staging.directory, stageName(row.id));
  if (fs.existsSync(target)) fail('STAGING_CONFLICT', 'A staged deletion already exists.');
  fs.renameSync(checked.absolute, target);
  const stagedStat = fs.lstatSync(target);
  if (!stagedStat.isFile() || stagedStat.isSymbolicLink()
      || stagedStat.dev !== checked.stat.dev || stagedStat.ino !== checked.stat.ino) {
    try {
      if (fs.existsSync(target) && !fs.existsSync(checked.absolute)) fs.renameSync(target, checked.absolute);
    } catch {
      fail('STAGING_RECOVERY_REQUIRED', 'Deletion staging requires recovery before retry.');
    }
    fail('STAGING_INVALID', 'The staged material failed validation.');
  }
  return { materialId: row.id, source: checked.absolute, target };
}

function restoreMoves(moves) {
  let failed = false;
  for (const move of [...moves].reverse()) {
    try {
      if (fs.existsSync(move.target) && !fs.existsSync(move.source)) fs.renameSync(move.target, move.source);
    } catch {
      failed = true;
    }
  }
  if (failed) fail('STAGING_RECOVERY_REQUIRED', 'Deletion staging requires recovery before retry.');
}

function deleteSqliteMaterial(database, row, { allowMissing = false } = {}) {
  if (row.storage_kind !== 'sqlite') return;
  if (!/^[1-9][0-9]*$/.test(String(row.db_entity_id || ''))) {
    fail('DB_ENTITY_ID_INVALID', 'The database entity id is invalid.');
  }
  const entityId = Number(row.db_entity_id);
  if (!Number.isSafeInteger(entityId) || entityId <= 0) fail('DB_ENTITY_ID_INVALID', 'The database entity id is invalid.');
  if (row.db_entity_type === 'job_interview') {
    const result = database.prepare(`
      UPDATE job_interview
      SET transcript = '', source_url = NULL, note = '[material deleted]'
      WHERE id = ?
    `).run(entityId);
    if (result.changes !== 1 && !allowMissing) fail('DB_ENTITY_MISSING', 'The database material is unavailable.');
    return;
  }
  if (row.db_entity_type === 'interview_report_v1') {
    database.prepare('UPDATE interview_llm_request_audit SET report_id = NULL WHERE report_id = ?').run(entityId);
    database.prepare('DELETE FROM interview_report_action_request WHERE report_id = ?').run(entityId);
    database.prepare('DELETE FROM interview_report_fact_review WHERE report_id = ?').run(entityId);
    const result = database.prepare('DELETE FROM interview_report_v1 WHERE id = ?').run(entityId);
    if (result.changes !== 1 && !allowMissing) fail('DB_ENTITY_MISSING', 'The database material is unavailable.');
    return;
  }
  if (row.db_entity_type === 'interview_ai_report') {
    database.prepare('DELETE FROM interview_session_report WHERE report_id = ?').run(entityId);
    const result = database.prepare('DELETE FROM interview_ai_report WHERE id = ?').run(entityId);
    if (result.changes !== 1 && !allowMissing) fail('DB_ENTITY_MISSING', 'The database material is unavailable.');
    return;
  }
  if (row.db_entity_type === 'interview_recording_confirmations') {
    const exists = database.prepare('SELECT 1 FROM interview_recording WHERE id = ?').get(entityId);
    if (!exists && !allowMissing) fail('DB_ENTITY_MISSING', 'The database material is unavailable.');
    database.prepare(`
      UPDATE interview_recording_confirmation
      SET extracted_value = NULL, corrected_value = NULL, evidence = NULL, note = NULL
      WHERE recording_id = ?
    `).run(entityId);
    return;
  }
  if (row.db_entity_type === 'interview_recording_metadata') {
    const result = database.prepare(`
      UPDATE interview_recording SET topic = NULL, raw_summary_json = '{"state":"deleted"}' WHERE id = ?
    `).run(entityId);
    if (result.changes !== 1 && !allowMissing) fail('DB_ENTITY_MISSING', 'The database material is unavailable.');
    return;
  }
  fail('DB_ENTITY_TYPE_INVALID', 'The database entity type is invalid.');
}

const RECORDING_PATH_COLUMNS = Object.freeze({
  source: 'source_path',
  wav: 'wav_path',
  'transcript-txt': 'transcript_txt_path',
  'transcript-srt': 'transcript_srt_path',
  'transcript-json': 'transcript_json_path',
  draft: 'codex_input_path',
  report: 'report_path',
});

function clearDeletedRecordingPath(database, row) {
  if ((row.storage_kind || 'file') !== 'file') return;
  const match = String(row.id || '').match(/^recording-([1-9][0-9]*)-(source|wav|transcript-txt|transcript-srt|transcript-json|draft|report)$/);
  if (!match) return;
  const column = RECORDING_PATH_COLUMNS[match[2]];
  database.prepare(`UPDATE interview_recording SET ${column} = NULL WHERE id = ?`).run(Number(match[1]));
}

function confirmDeletion({ database, root, manifestId, confirmationToken, actorRole, reasonCode, now } = {}) {
  assertDatabase(database);
  const id = requiredToken(manifestId, 'MANIFEST_ID_INVALID');
  if (!CONFIRM_ROLES.has(actorRole)) fail('ACTOR_ROLE_FORBIDDEN', 'The actor role is not allowed to confirm deletion.');
  const reason = requiredToken(reasonCode, 'REASON_CODE_INVALID', 80);
  const at = iso(now, 'NOW_INVALID');
  const manifest = database.prepare('SELECT * FROM interview_lifecycle_manifest WHERE id = ?').get(id);
  if (!manifest) fail('MANIFEST_NOT_FOUND', 'The deletion manifest was not found.');
  if (manifest.confirmed_at) fail('MANIFEST_ALREADY_CONFIRMED', 'The deletion manifest is already confirmed.');
  const suppliedHash = crypto.createHash('sha256').update(String(confirmationToken || '')).digest('hex');
  const expected = Buffer.from(manifest.confirmation_hash, 'hex');
  const supplied = Buffer.from(suppliedHash, 'hex');
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    fail('CONFIRMATION_INVALID', 'The deletion confirmation is invalid.');
  }
  if (activeHold(database, manifest.session_id, at)) fail('LEGAL_HOLD_ACTIVE', 'Deletion is blocked by an active legal hold.');
  const rows = database.prepare(`
    SELECT m.*, i.expected_version
    FROM interview_lifecycle_manifest_item i
    JOIN interview_lifecycle_material m ON m.id = i.material_id
    WHERE i.manifest_id = ? ORDER BY m.id
  `).all(id);
  if (!rows.length) fail('MANIFEST_EMPTY', 'The deletion manifest is empty.');
  for (const row of rows) {
    if (row.state !== 'active' || Number(row.version) !== Number(row.expected_version)
        || !row.delete_after || row.delete_after > at) {
      fail('MANIFEST_STALE', 'The deletion manifest is stale.');
    }
  }

  const fileRows = rows.filter((row) => (row.storage_kind || 'file') === 'file');
  const staging = fileRows.length ? stagingRoot(root) : null;
  const moves = [];
  try {
    for (const row of fileRows) moves.push(stageMaterial(staging, row));
    runImmediate(database, () => {
      if (activeHold(database, manifest.session_id, at)) fail('LEGAL_HOLD_ACTIVE', 'Deletion is blocked by an active legal hold.');
      const update = database.prepare(`
        UPDATE interview_lifecycle_material
        SET internal_relpath = NULL, state = 'deleted', deleted_at = ?, version = version + 1
        WHERE id = ? AND state = 'active' AND version = ?
      `);
      const tombstone = database.prepare(`
        INSERT INTO interview_lifecycle_tombstone (
          material_id, session_id, policy_version, storage_kind,
          db_entity_type, db_entity_id, deleted_at, purge_after
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        deleteSqliteMaterial(database, row);
        clearDeletedRecordingPath(database, row);
        const result = update.run(at, row.id, row.expected_version);
        if (result.changes !== 1) fail('MANIFEST_STALE', 'The deletion manifest is stale.');
        tombstone.run(
          row.id,
          row.session_id,
          POLICY_VERSION,
          row.storage_kind || 'file',
          row.storage_kind === 'sqlite' ? row.db_entity_type : null,
          row.storage_kind === 'sqlite' ? row.db_entity_id : null,
          at,
          addDays(at, 30),
        );
        addEvent(database, {
          sessionId: row.session_id,
          materialId: row.id,
          eventType: 'material_deleted',
          actorRole,
          reasonCode: reason,
          createdAt: at,
        });
      }
      database.prepare('UPDATE interview_lifecycle_manifest SET confirmed_at = ? WHERE id = ?').run(at, id);
    });
  } catch (error) {
    restoreMoves(moves);
    throw error;
  }

  let cleanupPending = 0;
  for (const move of moves) {
    try {
      fs.unlinkSync(move.target);
    } catch {
      cleanupPending += 1;
    }
  }
  return {
    manifest_id: id,
    session_id: manifest.session_id,
    deleted_count: rows.length,
    staging_cleanup_pending: cleanupPending,
  };
}

function replayLifecycleTombstones({ database, tombstones } = {}) {
  assertDatabase(database);
  if (!Array.isArray(tombstones)) fail('TOMBSTONES_INVALID', 'Lifecycle tombstones are required.');
  return runImmediate(database, () => {
    const insert = database.prepare(`
      INSERT OR REPLACE INTO interview_lifecycle_tombstone (
        material_id, session_id, policy_version, storage_kind,
        db_entity_type, db_entity_id, deleted_at, purge_after
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of tombstones) {
      const materialId = requiredToken(row.material_id, 'MATERIAL_ID_INVALID');
      const sessionId = requiredToken(row.session_id, 'SESSION_ID_INVALID');
      const storageKind = row.storage_kind === 'sqlite' ? 'sqlite' : row.storage_kind === 'file' ? 'file' : null;
      if (!storageKind) fail('STORAGE_KIND_INVALID', 'The tombstone storage kind is invalid.');
      const deletedAt = iso(row.deleted_at, 'DELETED_AT_INVALID');
      const purgeAfter = iso(row.purge_after, 'PURGE_AFTER_INVALID');
      if (storageKind === 'sqlite') {
        const entityType = String(row.db_entity_type || '');
        const entityId = String(row.db_entity_id || '');
        if (!DB_ENTITY_TYPES.has(entityType) || !/^[1-9][0-9]*$/.test(entityId)) {
          fail('DB_ENTITY_INVALID', 'The tombstone database entity is invalid.');
        }
        deleteSqliteMaterial(database, {
          storage_kind: 'sqlite', db_entity_type: entityType, db_entity_id: entityId,
        }, { allowMissing: true });
      }
      database.prepare('DELETE FROM interview_lifecycle_material WHERE id = ?').run(materialId);
      insert.run(materialId, sessionId, POLICY_VERSION, storageKind,
        storageKind === 'sqlite' ? row.db_entity_type : null,
        storageKind === 'sqlite' ? String(row.db_entity_id) : null,
        deletedAt, purgeAfter);
    }
    return { replayed_count: tombstones.length };
  });
}

function recoverStagedDeletions({ database, root } = {}) {
  assertDatabase(database);
  const staging = stagingRoot(root);
  const rows = database.prepare(`
    SELECT id, internal_relpath, state FROM interview_lifecycle_material
  `).all();
  let restored = 0;
  let removed = 0;
  for (const row of rows) {
    const staged = path.join(staging.directory, stageName(row.id));
    if (!fs.existsSync(staged)) continue;
    const stat = fs.lstatSync(staged);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('STAGING_INVALID', 'The staged material is invalid.');
    if (row.state === 'deleted') {
      fs.unlinkSync(staged);
      removed += 1;
      continue;
    }
    if (!row.internal_relpath) fail('STAGING_INVALID', 'The staged material has no recovery target.');
    const target = path.resolve(staging.root, row.internal_relpath);
    if (!isWithin(staging.root, target) || fs.existsSync(target)) {
      fail('STAGING_INVALID', 'The staged material cannot be restored safely.');
    }
    const parent = path.dirname(target);
    let parentStat;
    let realParent;
    try {
      parentStat = fs.lstatSync(parent);
      realParent = fs.realpathSync(parent);
    } catch {
      fail('STAGING_INVALID', 'The staged material recovery directory is unavailable.');
    }
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
        || (realParent !== staging.root && !isWithin(staging.root, realParent))) {
      fail('STAGING_INVALID', 'The staged material recovery directory is invalid.');
    }
    fs.renameSync(staged, target);
    restored += 1;
  }
  return { restored_count: restored, removed_count: removed };
}

function purgeExpiredTombstones({ database, now } = {}) {
  assertDatabase(database);
  const at = iso(now, 'NOW_INVALID');
  const result = database.prepare(`
    DELETE FROM interview_lifecycle_tombstone WHERE purge_after <= ?
  `).run(at);
  return { purged_count: Number(result.changes) };
}

module.exports = {
  POLICY_VERSION,
  InterviewMaterialLifecycleError,
  applyInterviewMaterialLifecycleSchema,
  createLifecycleSession,
  registerLifecycleMaterial,
  registerLifecycleDatabaseMaterial,
  assertSessionProcessingAllowed,
  closeRecruitment,
  withdrawSession,
  applyLegalHold,
  releaseLegalHold,
  createDeletionDryRun,
  confirmDeletion,
  recoverStagedDeletions,
  purgeExpiredTombstones,
  replayLifecycleTombstones,
};
