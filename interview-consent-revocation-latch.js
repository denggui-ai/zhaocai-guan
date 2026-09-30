'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { durableAtomicWriteFile, fsyncDirectory } = require('./durable-atomic-file');
const { hardenPrivateDir } = require('./secure-fs');

const MARKER_SCHEMA = 'hrboss_interview_consent_revocation_v1';
const MARKER_MAX_BYTES = 2048;
const inMemoryBlockers = new Set();
let activeDatabasePath = '';

function setActiveDatabasePath(filePath) {
  activeDatabasePath = filePath ? path.resolve(filePath) : '';
  return activeDatabasePath;
}

function scopeHash(candidateId, jobId, scope) {
  return crypto.createHash('sha256')
    .update(`${String(candidateId || '').trim()}\u0000${Number(jobId)}\u0000${String(scope || '')}`, 'utf8')
    .digest('hex');
}

function markerRoot() {
  if (process.env.HRBOSS_CONSENT_REVOCATION_GATE_DIR) {
    return path.resolve(process.env.HRBOSS_CONSENT_REVOCATION_GATE_DIR);
  }
  const dataRoot = activeDatabasePath
    ? path.dirname(activeDatabasePath)
    : (process.env.BOSS_DB_PATH
    ? path.dirname(path.resolve(process.env.BOSS_DB_PATH))
    : (process.env.HRBOSS_DATA_DIR
      ? path.resolve(process.env.HRBOSS_DATA_DIR)
      : path.join(__dirname, 'data')));
  return path.join(dataRoot, 'security', 'interview-consent-revocations');
}

function validateScopeHash(value) {
  const normalized = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('invalid interview consent revocation scope hash');
  return normalized;
}

function markerPath(scopeHashValue) {
  return path.join(markerRoot(), `${validateScopeHash(scopeHashValue)}.json`);
}

function ensureMarkerRoot() {
  const root = markerRoot();
  const parent = path.dirname(root);
  const parentExisted = fs.existsSync(parent);
  if (parentExisted) {
    const existingParentStat = fs.lstatSync(parent);
    if (existingParentStat.isSymbolicLink() || !existingParentStat.isDirectory()) {
      throw new Error('interview consent revocation marker parent is not a private directory');
    }
  }
  hardenPrivateDir(parent);
  const parentStat = fs.lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new Error('interview consent revocation marker parent is not a private directory');
  }
  if (!parentExisted) {
    fsyncDirectory(parent);
    fsyncDirectory(path.dirname(parent));
  }
  const existed = fs.existsSync(root);
  if (existed) {
    const existingRootStat = fs.lstatSync(root);
    if (existingRootStat.isSymbolicLink() || !existingRootStat.isDirectory()) {
      throw new Error('interview consent revocation marker root is not a private directory');
    }
  }
  hardenPrivateDir(root);
  const stat = fs.lstatSync(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('interview consent revocation marker root is not a private directory');
  }
  if (!existed) {
    fsyncDirectory(root);
    fsyncDirectory(parent);
  }
  return root;
}

function writeDurableMarker({
  scope_hash: rawScopeHash,
  requested_at: requestedAt,
  updated_at: updatedAt,
} = {}) {
  const hash = validateScopeHash(rawScopeHash);
  const timestamp = String(requestedAt || new Date().toISOString());
  const root = ensureMarkerRoot();
  const target = path.join(root, `${hash}.json`);
  const payload = {
    schema_version: MARKER_SCHEMA,
    scope_hash: hash,
    status: 'pending',
    requested_at: timestamp,
    updated_at: String(updatedAt || timestamp),
  };
  durableAtomicWriteFile(target, `${JSON.stringify(payload)}\n`, {
    mode: 0o600,
  });
  return { ...payload, path: target };
}

function inspectMarkerDirectories() {
  const root = markerRoot();
  const parent = path.dirname(root);
  let parentStat;
  try {
    parentStat = fs.lstatSync(parent);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { trusted: true, missing: true, root, parent };
    return { trusted: false, root, parent, error };
  }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    return { trusted: false, root, parent, error: new Error('revocation marker parent is not a real directory') };
  }
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { trusted: true, missing: true, root, parent };
    return { trusted: false, root, parent, error };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { trusted: false, root, parent, error: new Error('revocation marker root is not a real directory') };
  }
  return { trusted: true, missing: false, root, parent };
}

function readDurableMarker(scopeHashValue) {
  const hash = validateScopeHash(scopeHashValue);
  const directories = inspectMarkerDirectories();
  if (!directories.trusted) {
    return {
      scope_hash: hash,
      status: 'pending',
      invalid: true,
      error: directories.error && directories.error.message,
    };
  }
  if (directories.missing) return null;
  const target = path.join(directories.root, `${hash}.json`);
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return { scope_hash: hash, status: 'pending', invalid: true, error: error.message };
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > MARKER_MAX_BYTES) {
    return { scope_hash: hash, status: 'pending', invalid: true };
  }
  let descriptor;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const parsed = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (parsed.schema_version !== MARKER_SCHEMA
        || parsed.scope_hash !== hash
        || parsed.status !== 'pending'
        || !parsed.requested_at
        || !parsed.updated_at) {
      return { scope_hash: hash, status: 'pending', invalid: true };
    }
    return {
      scope_hash: hash,
      status: 'pending',
      requested_at: String(parsed.requested_at),
      updated_at: String(parsed.updated_at),
      durable_fallback: true,
    };
  } catch (error) {
    return { scope_hash: hash, status: 'pending', invalid: true, error: error.message };
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
  }
}

function removeDurableMarker(scopeHashValue) {
  const hash = validateScopeHash(scopeHashValue);
  const directories = inspectMarkerDirectories();
  if (!directories.trusted) {
    const error = new Error('interview consent revocation marker directory cannot be trusted');
    error.code = 'INTERVIEW_CONSENT_REVOCATION_MARKER_UNSAFE';
    error.cause = directories.error;
    throw error;
  }
  if (directories.missing) return true;
  const target = path.join(directories.root, `${hash}.json`);
  let targetStat;
  try {
    targetStat = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    throw error;
  }
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    const error = new Error('interview consent revocation marker target cannot be trusted');
    error.code = 'INTERVIEW_CONSENT_REVOCATION_MARKER_UNSAFE';
    throw error;
  }
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return true;
    throw error;
  }
  fsyncDirectory(directories.root);
  return true;
}

function blockInMemory(scopeHashValue) {
  inMemoryBlockers.add(validateScopeHash(scopeHashValue));
}

function clearInMemory(scopeHashValue) {
  inMemoryBlockers.delete(validateScopeHash(scopeHashValue));
}

function hasInMemoryBlocker(scopeHashValue) {
  return inMemoryBlockers.has(validateScopeHash(scopeHashValue));
}

function pendingState(scopeHashValue) {
  const hash = validateScopeHash(scopeHashValue);
  const marker = readDurableMarker(hash);
  if (marker) return marker;
  if (hasInMemoryBlocker(hash)) {
    return {
      scope_hash: hash,
      status: 'pending',
      in_memory_fallback: true,
    };
  }
  return null;
}

module.exports = {
  MARKER_SCHEMA,
  blockInMemory,
  clearInMemory,
  hasInMemoryBlocker,
  markerPath,
  markerRoot,
  inspectMarkerDirectories,
  pendingState,
  readDurableMarker,
  removeDurableMarker,
  setActiveDatabasePath,
  scopeHash,
  writeDurableMarker,
};
