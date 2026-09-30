const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const {
  hardenPrivateDir,
  ensurePrivateFile,
  writePrivateFile,
} = require('./secure-fs');

const FORMAT_VERSION = 1;
const BACKUP_RETENTION_DAYS = 30;
const BACKUP_RETENTION_MS = BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function assertToken(value, name) {
  if (typeof value !== 'string' || !TOKEN.test(value)) fail('INVALID_ARGUMENT', `${name} is invalid`);
  return value;
}

function assertPrivateRoot(root, { create = false } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('INVALID_ROOT', 'root must be absolute');
  if (!create && !fs.existsSync(root)) fail('INVALID_ROOT', 'root does not exist');
  if (create && !fs.existsSync(root)) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_ROOT', 'root must be a real directory');
  hardenPrivateDir(root);
  if (process.platform !== 'win32' && (fs.statSync(root).mode & 0o077) !== 0) {
    fail('INSECURE_ROOT', 'root must not be accessible by group or others');
  }
  return fs.realpathSync(root);
}

function assertDirectChild(root, target) {
  if (path.dirname(target) !== root) fail('PATH_OUTSIDE_ROOT', 'path must be a direct child of root');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function schemaFingerprint(database) {
  const schema = database.prepare(`
    SELECT type, name, tbl_name, COALESCE(sql, '') AS sql
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
  return sha256Buffer(Buffer.from(JSON.stringify(schema)));
}

function availableBytes(root) {
  if (typeof fs.statfsSync !== 'function') return Number.MAX_SAFE_INTEGER;
  const stat = fs.statfsSync(root);
  return Number(stat.bavail) * Number(stat.bsize);
}

function requiredDatabaseBytes(database) {
  const pageCount = Number(database.pragma('page_count', { simple: true }));
  const pageSize = Number(database.pragma('page_size', { simple: true }));
  return Math.max(pageCount * pageSize, 4096);
}

function assertSpace(root, required) {
  if (!Number.isSafeInteger(required) || required <= 0) fail('INVALID_ARGUMENT', 'required bytes are invalid');
  if (availableBytes(root) < required) fail('INSUFFICIENT_SPACE', 'insufficient free space');
}

function assertDatabase(database) {
  if (!database || !database.open || typeof database.backup !== 'function') {
    fail('INVALID_DATABASE', 'an open better-sqlite3 database is required');
  }
}

function validateManifest(manifest) {
  if (!manifest || manifest.format_version !== FORMAT_VERSION) fail('INCOMPATIBLE_FORMAT', 'unsupported format');
  const topKeys = ['app_version', 'backup_retention_days', 'created_at', 'database', 'format_version', 'manifest_sha256', 'policy_version', 'recovery_id'];
  const databaseKeys = ['bytes', 'relative_path', 'schema_fingerprint', 'sha256', 'user_version'];
  if (Object.keys(manifest).sort().join('|') !== topKeys.join('|')) fail('INVALID_MANIFEST', 'manifest fields are invalid');
  if (!manifest.database || Object.keys(manifest.database).sort().join('|') !== databaseKeys.join('|')) {
    fail('INVALID_MANIFEST', 'database manifest fields are invalid');
  }
  assertToken(manifest.recovery_id, 'recovery_id');
  assertToken(manifest.app_version, 'app_version');
  assertToken(manifest.policy_version, 'policy_version');
  assertIsoTimestamp(manifest.created_at, 'created_at');
  if (manifest.backup_retention_days !== BACKUP_RETENTION_DAYS) {
    fail('INVALID_MANIFEST', 'backup retention is invalid');
  }
  if (!manifest.database || manifest.database.relative_path !== 'database.db') {
    fail('INVALID_MANIFEST', 'database path is invalid');
  }
  if (!Number.isSafeInteger(manifest.database.bytes) || manifest.database.bytes <= 0) {
    fail('INVALID_MANIFEST', 'database size is invalid');
  }
  if (!Number.isSafeInteger(manifest.database.user_version) || manifest.database.user_version < 0) {
    fail('INVALID_MANIFEST', 'database user_version is invalid');
  }
  for (const value of [manifest.database.sha256, manifest.database.schema_fingerprint, manifest.manifest_sha256]) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('INVALID_MANIFEST', 'manifest hash is invalid');
  }
  const unsigned = { ...manifest };
  delete unsigned.manifest_sha256;
  if (sha256Buffer(Buffer.from(stableJson(unsigned))) !== manifest.manifest_sha256) {
    fail('MANIFEST_HASH_MISMATCH', 'manifest hash mismatch');
  }
}

function assertIsoTimestamp(value, name) {
  if (typeof value !== 'string') fail('INVALID_ARGUMENT', `${name} must be an ISO timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail('INVALID_ARGUMENT', `${name} must be a canonical ISO timestamp`);
  }
  return value;
}

function readManifest(recoveryRoot, recoveryId) {
  const packagePath = path.join(recoveryRoot, assertToken(recoveryId, 'recoveryId'));
  assertDirectChild(recoveryRoot, packagePath);
  const packageStat = fs.lstatSync(packagePath);
  if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) fail('INVALID_PACKAGE', 'recovery package is invalid');
  hardenPrivateDir(packagePath);
  const manifestPath = path.join(packagePath, 'manifest.json');
  const databasePath = path.join(packagePath, 'database.db');
  for (const file of [manifestPath, databasePath]) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('INVALID_PACKAGE', 'recovery file is invalid');
    ensurePrivateFile(file);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    fail('INVALID_MANIFEST', 'manifest is not valid JSON');
  }
  validateManifest(manifest);
  if (manifest.recovery_id !== recoveryId) fail('INVALID_MANIFEST', 'recovery id mismatch');
  return { manifest, databasePath };
}

async function createSqliteBackup(options) {
  const {
    database,
    recoveryRoot,
    recoveryId,
    appVersion,
    policyVersion,
    createdAt = new Date().toISOString(),
  } = options || {};
  assertDatabase(database);
  const root = assertPrivateRoot(recoveryRoot, { create: true });
  const id = assertToken(recoveryId, 'recoveryId');
  const app = assertToken(appVersion, 'appVersion');
  const policy = assertToken(policyVersion, 'policyVersion');
  const timestamp = assertIsoTimestamp(createdAt, 'createdAt');
  const finalPath = path.join(root, id);
  assertDirectChild(root, finalPath);
  if (fs.existsSync(finalPath)) fail('BACKUP_EXISTS', 'recovery package already exists');
  assertSpace(root, requiredDatabaseBytes(database) * 2 + 1024 * 1024);

  const staging = fs.mkdtempSync(path.join(root, '.backup-'));
  hardenPrivateDir(staging);
  const databasePath = path.join(staging, 'database.db');
  try {
    await database.backup(databasePath);
    ensurePrivateFile(databasePath);
    const verify = new Database(databasePath, { readonly: true, fileMustExist: true });
    let fingerprint;
    let userVersion;
    try {
      if (verify.pragma('integrity_check', { simple: true }) !== 'ok') fail('BACKUP_INVALID', 'backup integrity check failed');
      if (verify.pragma('foreign_key_check').length !== 0) fail('BACKUP_INVALID', 'backup foreign key check failed');
      fingerprint = schemaFingerprint(verify);
      userVersion = Number(verify.pragma('user_version', { simple: true }));
    } finally {
      verify.close();
    }
    const stat = fs.statSync(databasePath);
    const unsigned = {
      format_version: FORMAT_VERSION,
      recovery_id: id,
      created_at: timestamp,
      app_version: app,
      policy_version: policy,
      backup_retention_days: BACKUP_RETENTION_DAYS,
      database: {
        relative_path: 'database.db',
        bytes: stat.size,
        sha256: sha256File(databasePath),
        schema_fingerprint: fingerprint,
        user_version: userVersion,
      },
    };
    const manifest = {
      ...unsigned,
      manifest_sha256: sha256Buffer(Buffer.from(stableJson(unsigned))),
    };
    const manifestPath = path.join(staging, 'manifest.json');
    writePrivateFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(staging, finalPath);
    return { recovery_id: id, manifest };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function purgeExpiredRecoveryPackages({ recoveryRoot, now = new Date().toISOString() } = {}) {
  const restoreNow = assertIsoTimestamp(now, 'now');
  if (typeof recoveryRoot !== 'string' || !path.isAbsolute(recoveryRoot)) fail('INVALID_ROOT', 'root must be absolute');
  if (!fs.existsSync(recoveryRoot)) return { purged_count: 0 };
  const root = assertPrivateRoot(recoveryRoot);
  let purged = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) fail('INVALID_PACKAGE', 'recovery package symlinks are forbidden');
    if (!entry.isDirectory()) fail('INVALID_PACKAGE', 'recovery root contains an invalid package');
    const { manifest } = readManifest(root, entry.name);
    if (new Date(restoreNow).getTime() >= new Date(manifest.created_at).getTime() + BACKUP_RETENTION_MS) {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: false });
      purged += 1;
    }
  }
  return { purged_count: purged };
}

function validateCriticalQueries(queries) {
  if (!Array.isArray(queries) || queries.length === 0) fail('INVALID_ARGUMENT', 'criticalQueries are required');
  for (const query of queries) {
    if (!query || typeof query.sql !== 'string' || !/^\s*SELECT\b/i.test(query.sql) || query.sql.includes(';')) {
      fail('INVALID_ARGUMENT', 'critical queries must be SELECT statements');
    }
    if (query.params !== undefined && !Array.isArray(query.params)) fail('INVALID_ARGUMENT', 'query params must be an array');
    if (query.minRows !== undefined && (!Number.isSafeInteger(query.minRows) || query.minRows < 0)) {
      fail('INVALID_ARGUMENT', 'query minRows must be a non-negative integer');
    }
  }
}

function applyCurrentTombstones(database, tombstones, allowedTargets) {
  if (!Array.isArray(tombstones)) fail('INVALID_ARGUMENT', 'currentTombstones must be an array');
  if (!Array.isArray(allowedTargets)) fail('INVALID_ARGUMENT', 'allowedTombstoneTargets must be an array');
  const allowed = new Set(allowedTargets.map((item) => `${item.table}.${item.idColumn}`));
  const remove = database.transaction(() => {
    for (const tombstone of tombstones) {
      const table = tombstone && tombstone.table;
      const idColumn = tombstone && tombstone.idColumn;
      if (!IDENTIFIER.test(table || '') || !IDENTIFIER.test(idColumn || '') || !allowed.has(`${table}.${idColumn}`)) {
        fail('INVALID_TOMBSTONE_TARGET', 'tombstone target is not allowed');
      }
      if (typeof tombstone.objectId !== 'string' || tombstone.objectId.length === 0) {
        fail('INVALID_ARGUMENT', 'tombstone object id is invalid');
      }
      const exists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (!exists) continue;
      database.prepare(`DELETE FROM "${table}" WHERE "${idColumn}" = ?`).run(tombstone.objectId);
    }
  });
  remove();
}

async function restoreSqliteBackup(options) {
  const {
    recoveryRoot,
    recoveryId,
    restoreRoot,
    destinationName,
    appVersion,
    policyVersion,
    now,
    confirmed,
    criticalQueries,
    currentTombstones = [],
    allowedTombstoneTargets = [],
    replayCurrentTombstones,
  } = options || {};
  if (confirmed !== true) fail('RESTORE_NOT_CONFIRMED', 'restore requires explicit confirmation');
  const sourceRoot = assertPrivateRoot(recoveryRoot);
  const targetRoot = assertPrivateRoot(restoreRoot, { create: true });
  const destination = path.join(targetRoot, assertToken(destinationName, 'destinationName'));
  assertDirectChild(targetRoot, destination);
  if (fs.existsSync(destination)) fail('DESTINATION_EXISTS', 'restore destination already exists');
  const expectedApp = assertToken(appVersion, 'appVersion');
  const expectedPolicy = assertToken(policyVersion, 'policyVersion');
  const restoreNow = assertIsoTimestamp(now, 'now');
  validateCriticalQueries(criticalQueries);
  if (!Array.isArray(currentTombstones) || !Array.isArray(allowedTombstoneTargets)) {
    fail('INVALID_ARGUMENT', 'tombstone collections must be arrays');
  }
  if (currentTombstones.length > 0 && typeof replayCurrentTombstones !== 'function') {
    fail('TOMBSTONE_REPLAY_REQUIRED', 'current tombstones require a persistence callback');
  }
  const { manifest, databasePath } = readManifest(sourceRoot, recoveryId);
  if (manifest.app_version !== expectedApp || manifest.policy_version !== expectedPolicy) {
    fail('INCOMPATIBLE_VERSION', 'application or policy version is incompatible');
  }
  if (new Date(restoreNow).getTime() >= new Date(manifest.created_at).getTime() + BACKUP_RETENTION_MS) {
    fail('BACKUP_EXPIRED', 'recovery package has expired');
  }
  const sourceStat = fs.statSync(databasePath);
  if (sourceStat.size !== manifest.database.bytes || sha256File(databasePath) !== manifest.database.sha256) {
    fail('DATABASE_HASH_MISMATCH', 'database hash mismatch');
  }
  assertSpace(targetRoot, manifest.database.bytes * 2 + 1024 * 1024);

  const staging = path.join(targetRoot, `.restore-${crypto.randomUUID()}.db`);
  let restored;
  try {
    fs.copyFileSync(databasePath, staging, fs.constants.COPYFILE_EXCL);
    ensurePrivateFile(staging);
    restored = new Database(staging, { fileMustExist: true });
    restored.pragma('foreign_keys = ON');
    if (restored.pragma('integrity_check', { simple: true }) !== 'ok') fail('RESTORE_INVALID', 'integrity check failed');
    if (restored.pragma('foreign_key_check').length !== 0) fail('RESTORE_INVALID', 'foreign key check failed');
    if (schemaFingerprint(restored) !== manifest.database.schema_fingerprint) fail('SCHEMA_MISMATCH', 'schema fingerprint mismatch');
    if (Number(restored.pragma('user_version', { simple: true })) !== manifest.database.user_version) {
      fail('SCHEMA_MISMATCH', 'user_version mismatch');
    }
    applyCurrentTombstones(restored, currentTombstones, allowedTombstoneTargets);
    if (currentTombstones.length > 0) {
      const callbackResult = replayCurrentTombstones(restored, currentTombstones);
      if (callbackResult && typeof callbackResult.then === 'function') {
        fail('INVALID_TOMBSTONE_CALLBACK', 'tombstone persistence callback must be synchronous');
      }
    }
    if (restored.pragma('integrity_check', { simple: true }) !== 'ok') fail('RESTORE_INVALID', 'post-replay integrity failed');
    if (restored.pragma('foreign_key_check').length !== 0) fail('RESTORE_INVALID', 'post-replay foreign key check failed');
    for (const query of criticalQueries) {
      const rows = restored.prepare(query.sql).all(...(query.params || []));
      if (rows.length < (query.minRows === undefined ? 1 : query.minRows)) {
        fail('CRITICAL_QUERY_FAILED', 'critical query returned too few rows');
      }
    }
    restored.close();
    restored = null;
    fs.renameSync(staging, destination);
    return {
      recovery_id: manifest.recovery_id,
      destination_name: path.basename(destination),
      tombstones_replayed: currentTombstones.length,
    };
  } catch (error) {
    if (restored && restored.open) restored.close();
    fs.rmSync(staging, { force: true });
    throw error;
  }
}

module.exports = {
  FORMAT_VERSION,
  BACKUP_RETENTION_DAYS,
  createSqliteBackup,
  purgeExpiredRecoveryPackages,
  restoreSqliteBackup,
  schemaFingerprint,
};
