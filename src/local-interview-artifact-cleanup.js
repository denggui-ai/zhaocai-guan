'use strict';

const fs = require('fs');
const path = require('path');
const { fsyncDirectory } = require('./durable-atomic-file');
const { writePrivateFile } = require('./secure-fs');

const OWNER_MARKER = '.hrboss-local-interview-owner.json';
const STATE_MARKER = '.hrboss-local-interview-state.json';
const OWNER_SCHEMA = 'hrboss_local_interview_owner_v1';
const STATE_TEMP = /^\.hrboss-local-interview-state\.json\.[a-f0-9]{32}\.tmp$/;
const TRANSCRIPT = /^transcript\.(?:txt|srt|json|vtt|partial)$/;
const SOURCE = /^source\.(?:wav|aiff|aif|m4a|mp3|aac|flac|ogg|mp4|mov|m4v)$/i;
const MATERIALS = new Set([
  'recording.wav',
  'audio.wav',
  'transcript.txt',
  'transcript.srt',
  'transcript.json',
  'summary.json',
  'codex-input.md',
  'run.log',
]);
const DERIVED_TRANSCRIPTION_MATERIALS = new Set([
  'audio.wav',
  'transcript.txt',
  'transcript.srt',
  'transcript.json',
  'summary.json',
  'codex-input.md',
]);

function controlledOwnedDirectory(outDir, root) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  const resolvedDir = fs.realpathSync(path.resolve(outDir));
  const relative = path.relative(resolvedRoot, resolvedDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('local interview output is outside its controlled root');
  }
  const stat = fs.lstatSync(resolvedDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('local interview output is not a regular directory');
  }
  return resolvedDir;
}

function readOwnerMarker(outDir, jobId, ownerToken) {
  const markerPath = path.join(outDir, OWNER_MARKER);
  const stat = fs.lstatSync(markerPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > 4096) {
    throw new Error('local interview output ownership marker is invalid');
  }
  const descriptor = fs.openSync(markerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const marker = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    if (marker.schema_version !== OWNER_SCHEMA
        || marker.job_id !== jobId
        || marker.owner_token !== ownerToken) {
      throw new Error('local interview output owner does not match this job');
    }
    return { markerPath, payload: `${JSON.stringify(marker)}\n` };
  } finally {
    fs.closeSync(descriptor);
  }
}

function cleanupOwnedLocalInterviewArtifacts({
  outDir,
  root,
  jobId,
  ownerToken,
  removeFile = (target) => fs.rmSync(target, { force: true }),
  removeDirectory = (target) => fs.rmdirSync(target),
  syncDirectory = fsyncDirectory,
} = {}) {
  const removed = [];
  const failures = [];
  let controlledDir;
  let owner;
  try {
    controlledDir = controlledOwnedDirectory(outDir, root);
    owner = readOwnerMarker(controlledDir, String(jobId || ''), String(ownerToken || ''));
  } catch (error) {
    return { ok: false, removed, failures: [{ file: '', error: error.message }] };
  }
  let entries;
  try {
    entries = fs.readdirSync(controlledDir);
  } catch (error) {
    return { ok: false, removed, failures: [{ file: '', error: error.message }] };
  }

  const materials = [];
  const stateTransactions = [];
  let hasState = false;
  for (const basename of entries) {
    if (basename === OWNER_MARKER) continue;
    if (basename === STATE_MARKER) {
      hasState = true;
      continue;
    }
    if (STATE_TEMP.test(basename)) {
      stateTransactions.push(basename);
      continue;
    }
    if (MATERIALS.has(basename) || TRANSCRIPT.test(basename) || SOURCE.test(basename)) {
      materials.push(basename);
      continue;
    }
    failures.push({
      file: basename,
      error: 'refusing to clean an interview directory containing an unknown entry',
    });
  }
  for (const basename of [...materials, ...stateTransactions, ...(hasState ? [STATE_MARKER] : [])]) {
    try {
      const stat = fs.lstatSync(path.join(controlledDir, basename));
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('refusing to delete a non-regular interview artifact');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') failures.push({ file: basename, error: error.message });
    }
  }
  if (failures.length > 0) return { ok: false, removed, failures };

  // State is the restart blocker. Never remove it, or its transactions, until
  // every material has been deleted successfully.
  for (const basename of materials) {
    try {
      removeFile(path.join(controlledDir, basename));
      removed.push(basename);
    } catch (error) {
      failures.push({ file: basename, error: error.message });
      return { ok: false, removed, failures };
    }
  }
  try {
    syncDirectory(controlledDir);
  } catch (error) {
    failures.push({ file: '', error: `material deletion durability failed: ${error.message}` });
    return { ok: false, removed, failures };
  }
  for (const basename of stateTransactions) {
    try {
      removeFile(path.join(controlledDir, basename));
      removed.push(basename);
    } catch (error) {
      failures.push({ file: basename, error: error.message });
      return { ok: false, removed, failures };
    }
  }
  if (hasState) {
    try {
      removeFile(path.join(controlledDir, STATE_MARKER));
      removed.push(STATE_MARKER);
    } catch (error) {
      failures.push({ file: STATE_MARKER, error: error.message });
      return { ok: false, removed, failures };
    }
  }
  try {
    syncDirectory(controlledDir);
  } catch (error) {
    failures.push({ file: STATE_MARKER, error: `state deletion durability failed: ${error.message}` });
    return { ok: false, removed, failures };
  }

  try {
    removeFile(owner.markerPath);
    removed.push(OWNER_MARKER);
    removeDirectory(controlledDir);
    syncDirectory(path.dirname(controlledDir));
  } catch (error) {
    failures.push({ file: OWNER_MARKER, error: error.message });
    if (fs.existsSync(controlledDir) && !fs.existsSync(owner.markerPath)) {
      try {
        writePrivateFile(owner.markerPath, owner.payload, { flag: 'wx' });
        removed.splice(removed.indexOf(OWNER_MARKER), 1);
      } catch (restoreError) {
        failures.push({ file: OWNER_MARKER, error: `owner marker restore failed: ${restoreError.message}` });
      }
    }
  }
  return { ok: failures.length === 0, removed, failures };
}

function cleanupOwnedLocalInterviewDerivedArtifacts({
  outDir,
  root,
  jobId,
  ownerToken,
  removeFile = (target) => fs.rmSync(target, { force: true }),
  syncDirectory = fsyncDirectory,
} = {}) {
  const removed = [];
  const failures = [];
  let controlledDir;
  try {
    controlledDir = controlledOwnedDirectory(outDir, root);
    readOwnerMarker(controlledDir, String(jobId || ''), String(ownerToken || ''));
  } catch (error) {
    return { ok: false, removed, failures: [{ file: '', error: error.message }] };
  }
  let entries;
  try {
    entries = fs.readdirSync(controlledDir);
  } catch (error) {
    return { ok: false, removed, failures: [{ file: '', error: error.message }] };
  }

  const removable = entries.filter((basename) => (
    DERIVED_TRANSCRIPTION_MATERIALS.has(basename) || TRANSCRIPT.test(basename)
  ));
  for (const basename of removable) {
    try {
      const target = path.join(controlledDir, basename);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('refusing to delete a non-regular interview artifact');
      }
      removeFile(target);
      removed.push(basename);
    } catch (error) {
      if (error.code !== 'ENOENT') failures.push({ file: basename, error: error.message });
      return { ok: false, removed, failures };
    }
  }
  try {
    syncDirectory(controlledDir);
  } catch (error) {
    failures.push({ file: '', error: `derived material deletion durability failed: ${error.message}` });
  }
  return { ok: failures.length === 0, removed, failures };
}

module.exports = {
  DERIVED_TRANSCRIPTION_MATERIALS,
  MATERIALS,
  OWNER_MARKER,
  OWNER_SCHEMA,
  SOURCE,
  STATE_MARKER,
  STATE_TEMP,
  TRANSCRIPT,
  cleanupOwnedLocalInterviewDerivedArtifacts,
  cleanupOwnedLocalInterviewArtifacts,
};
