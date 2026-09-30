const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ensurePrivateDir, writePrivateFile } = require('./secure-fs');

const SCHEMA_VERSION = 'screenshot_evidence_batch_v1';
const BATCH_ID_RE = /^sha256-[a-f0-9]{64}$/;
const BATCH_SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function toPosix(value) {
  return String(value).split(path.sep).join('/');
}

function isControlledRelativePath(value) {
  if (!value || path.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(toPosix(value));
  return normalized !== '..' && !normalized.startsWith('../') && normalized === toPosix(value);
}

function assertControlledRelativePath(value, label) {
  if (!isControlledRelativePath(value)) throw new Error(`${label}必须是受控相对路径。`);
  return value;
}

function describeSources(sourceFiles) {
  const counted = new Map();
  const rows = sourceFiles.map((file) => {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('截图来源必须是普通文件。');
    return { sha256: sha256File(file), size_bytes: stat.size };
  }).sort((a, b) => `${a.sha256}:${a.size_bytes}`.localeCompare(`${b.sha256}:${b.size_bytes}`));

  return rows.map((row) => {
    const key = `${row.sha256}:${row.size_bytes}`;
    const occurrence = (counted.get(key) || 0) + 1;
    counted.set(key, occurrence);
    return {
      source_ref: `sha256:${row.sha256}#${occurrence}`,
      source_sha256: row.sha256,
      size_bytes: row.size_bytes,
    };
  });
}

function batchIdForSources(sources, batchScope = '') {
  const identity = sources.map(({ source_sha256, size_bytes }) => ({ source_sha256, size_bytes }));
  const payload = { schema_version: SCHEMA_VERSION, sources: identity };
  if (batchScope) payload.batch_scope = batchScope;
  return `sha256-${sha256Buffer(JSON.stringify(payload))}`;
}

function batchRelativeDir(batchId) {
  if (!BATCH_ID_RE.test(batchId)) throw new Error('截图证据 batch id 格式错误。');
  return path.posix.join('import', 'screenshot-evidence', 'batches', batchId);
}

function absoluteFromBatch(batchDir, batchRelative, storedPath, label) {
  assertControlledRelativePath(storedPath, label);
  const prefix = `${batchRelative}/`;
  if (!storedPath.startsWith(prefix)) throw new Error(`${label}不属于当前批次。`);
  const insideBatch = storedPath.slice(prefix.length);
  const absolute = path.resolve(batchDir, ...insideBatch.split('/'));
  const root = path.resolve(batchDir);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) throw new Error(`${label}越出批次目录。`);
  return absolute;
}

function artifactPaths(dataDir, manifest) {
  const batchDir = path.join(dataDir, ...manifest.paths.batch_dir.split('/'));
  const resolveStored = (storedPath, label) => absoluteFromBatch(batchDir, manifest.paths.batch_dir, storedPath, label);
  return {
    batchDir,
    manifestPath: path.join(batchDir, 'manifest.json'),
    draftsPath: resolveStored(manifest.paths.drafts, 'drafts path'),
    ocrPath: resolveStored(manifest.paths.ocr, 'ocr path'),
    stitchedIndexPath: resolveStored(manifest.paths.stitched_index, 'stitched index path'),
    indexMarkdownPath: resolveStored(manifest.paths.index_markdown, 'index markdown path'),
  };
}

function verifyManifest(dataDir, manifest, expectedBatchId = '') {
  if (!manifest || manifest.schema_version !== SCHEMA_VERSION) throw new Error('截图证据 manifest 版本错误。');
  if (!BATCH_ID_RE.test(manifest.batch_id) || (expectedBatchId && manifest.batch_id !== expectedBatchId)) {
    throw new Error('截图证据 manifest batch id 不匹配。');
  }
  const expectedBatchDir = batchRelativeDir(manifest.batch_id);
  if (!manifest.paths || manifest.paths.batch_dir !== expectedBatchDir) throw new Error('截图证据 manifest 批次路径错误。');
  Object.entries(manifest.paths).forEach(([key, value]) => assertControlledRelativePath(value, `manifest.paths.${key}`));
  const sources = Array.isArray(manifest.sources) ? manifest.sources : [];
  const batchScope = String(manifest.batch_scope || '');
  if (batchScope && !BATCH_SCOPE_RE.test(batchScope)) throw new Error('截图证据 batch scope 无效。');
  if (!sources.length || batchIdForSources(sources, batchScope) !== manifest.batch_id) {
    throw new Error('截图证据 manifest 来源内容 hash 与 batch id 不匹配。');
  }
  const paths = artifactPaths(dataDir, manifest);
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  if (!artifacts.length) throw new Error('截图证据 manifest 缺少 artifacts。');
  const artifactMap = new Map();
  for (const artifact of artifacts) {
    const file = absoluteFromBatch(paths.batchDir, expectedBatchDir, artifact.relative_path, 'artifact path');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('截图证据 artifact 缺失。');
    if (fs.statSync(file).size !== artifact.size_bytes || sha256File(file) !== artifact.sha256) {
      throw new Error('截图证据 artifact hash 校验失败。');
    }
    artifactMap.set(artifact.relative_path, artifact);
  }
  for (const requiredPath of [manifest.paths.drafts, manifest.paths.ocr, manifest.paths.stitched_index, manifest.paths.index_markdown]) {
    if (!artifactMap.has(requiredPath)) throw new Error('截图证据 manifest 缺少必需 artifact。');
  }
  const sourceHashes = new Set(sources.map((row) => row.source_sha256));
  const sourceRefs = new Set(sources.map((row) => row.source_ref));
  for (const derived of (Array.isArray(manifest.derived) ? manifest.derived : [])) {
    const artifact = artifactMap.get(derived.relative_path);
    if (!artifact || artifact.sha256 !== derived.derived_sha256 || artifact.size_bytes !== derived.size_bytes) {
      throw new Error('截图证据派生 hash 与 artifact 不匹配。');
    }
    if (!(derived.source_hashes || []).every((value) => sourceHashes.has(value))
      || !(derived.source_refs || []).every((value) => sourceRefs.has(value))) {
      throw new Error('截图证据派生来源引用不属于当前批次。');
    }
  }
  return paths;
}

function readCommittedBatch(dataDir, batchId) {
  const relative = batchRelativeDir(batchId);
  const batchDir = path.join(dataDir, ...relative.split('/'));
  const manifestPath = path.join(batchDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const paths = verifyManifest(dataDir, manifest, batchId);
  return { state: 'committed', batchId, batchRelative: relative, manifest, ...paths };
}

function beginEvidenceBatch({ dataDir, sourceFiles, batchScope = '' }) {
  const resolvedDataDir = path.resolve(dataDir);
  const normalizedScope = String(batchScope || '');
  if (normalizedScope && !BATCH_SCOPE_RE.test(normalizedScope)) throw new Error('截图证据 batch scope 无效。');
  const sources = describeSources(sourceFiles);
  const batchId = batchIdForSources(sources, normalizedScope);
  const committed = readCommittedBatch(resolvedDataDir, batchId);
  if (committed) return committed;

  const evidenceRoot = path.join(resolvedDataDir, 'import', 'screenshot-evidence');
  const stagingRoot = path.join(evidenceRoot, '.staging');
  const batchesRoot = path.join(evidenceRoot, 'batches');
  ensurePrivateDir(stagingRoot);
  ensurePrivateDir(batchesRoot);
  const stagingDir = path.join(stagingRoot, `${batchId}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  ensurePrivateDir(stagingDir);
  ensurePrivateDir(path.join(stagingDir, 'derived'));
  const batchRelative = batchRelativeDir(batchId);
  return {
    state: 'staging',
    dataDir: resolvedDataDir,
    batchId,
    batchRelative,
    sources,
    batchScope: normalizedScope,
    stagingDir,
    batchDir: path.join(batchesRoot, batchId),
    draftsPath: path.join(stagingDir, 'drafts.json'),
    ocrPath: path.join(stagingDir, 'ocr.json'),
    stitchedDir: path.join(stagingDir, 'derived'),
    stitchedIndexPath: path.join(stagingDir, 'derived', 'index.json'),
    indexMarkdownPath: path.join(stagingDir, 'derived', 'index.md'),
    storedDerivedPrefix: path.posix.join(batchRelative, 'derived'),
  };
}

function walkArtifacts(root, dir = root) {
  const rows = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error('截图证据批次禁止 symlink。');
    if (entry.isDirectory()) rows.push(...walkArtifacts(root, file));
    else if (entry.isFile() && entry.name !== 'manifest.json') {
      const relativeInsideBatch = toPosix(path.relative(root, file));
      rows.push({ file, relativeInsideBatch });
    }
  }
  return rows.sort((a, b) => a.relativeInsideBatch.localeCompare(b.relativeInsideBatch));
}

function buildManifest(batch) {
  const index = JSON.parse(fs.readFileSync(batch.stitchedIndexPath, 'utf8'));
  const draftsPayload = JSON.parse(fs.readFileSync(batch.draftsPath, 'utf8'));
  const draftsById = new Map((Array.isArray(draftsPayload.drafts) ? draftsPayload.drafts : [])
    .map((draft) => [String(draft.draft_id || ''), draft]));
  const sourceRefsByHash = new Map();
  for (const source of batch.sources) {
    if (!sourceRefsByHash.has(source.source_sha256)) sourceRefsByHash.set(source.source_sha256, []);
    sourceRefsByHash.get(source.source_sha256).push(source.source_ref);
  }
  const artifacts = walkArtifacts(batch.stagingDir).map(({ file, relativeInsideBatch }) => ({
    relative_path: path.posix.join(batch.batchRelative, relativeInsideBatch),
    sha256: sha256File(file),
    size_bytes: fs.statSync(file).size,
  }));
  const artifactMap = new Map(artifacts.map((row) => [row.relative_path, row]));
  const derived = (Array.isArray(index.rows) ? index.rows : []).map((row) => {
    const relativePath = assertControlledRelativePath(row.stitched_file, 'stitched_file');
    const artifact = artifactMap.get(relativePath);
    if (!artifact) throw new Error('拼合图不在当前批次 artifact 清单中。');
    const draft = draftsById.get(String(row.draft_id || '')) || {};
    const sourceHashes = (Array.isArray(draft.files) ? draft.files : []).map((file) => sha256File(file));
    const sourceRefs = sourceHashes.map((sourceHash) => {
      const refs = sourceRefsByHash.get(sourceHash) || [];
      if (!refs.length) throw new Error('草稿来源文件不属于当前批次。');
      return refs[0];
    });
    return {
      draft_id: String(row.draft_id || ''),
      source_refs: sourceRefs,
      source_hashes: sourceHashes,
      relative_path: relativePath,
      derived_sha256: artifact.sha256,
      size_bytes: artifact.size_bytes,
    };
  });
  return {
    schema_version: SCHEMA_VERSION,
    batch_id: batch.batchId,
    ...(batch.batchScope ? { batch_scope: batch.batchScope } : {}),
    source_set_sha256: batch.batchId.slice('sha256-'.length),
    paths: {
      batch_dir: batch.batchRelative,
      drafts: path.posix.join(batch.batchRelative, 'drafts.json'),
      ocr: path.posix.join(batch.batchRelative, 'ocr.json'),
      stitched_index: path.posix.join(batch.batchRelative, 'derived', 'index.json'),
      index_markdown: path.posix.join(batch.batchRelative, 'derived', 'index.md'),
    },
    sources: batch.sources,
    derived,
    artifacts,
  };
}

function commitEvidenceBatch(batch) {
  if (!batch || batch.state !== 'staging') throw new Error('只有 staging 批次可以提交。');
  const manifest = buildManifest(batch);
  writePrivateFile(path.join(batch.stagingDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (fs.existsSync(batch.batchDir)) {
    fs.rmSync(batch.stagingDir, { recursive: true, force: true });
    return readCommittedBatch(batch.dataDir, batch.batchId);
  }
  try {
    fs.renameSync(batch.stagingDir, batch.batchDir);
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code) || !fs.existsSync(batch.batchDir)) throw error;
    fs.rmSync(batch.stagingDir, { recursive: true, force: true });
  }
  const committed = readCommittedBatch(batch.dataDir, batch.batchId);
  batch.state = 'committed';
  return committed;
}

function abortEvidenceBatch(batch) {
  if (!batch || batch.state !== 'staging' || !batch.stagingDir) return;
  const stagingRoot = path.resolve(batch.dataDir, 'import', 'screenshot-evidence', '.staging');
  const target = path.resolve(batch.stagingDir);
  if (!target.startsWith(`${stagingRoot}${path.sep}`)) throw new Error('拒绝清理受控 staging 目录以外的路径。');
  fs.rmSync(target, { recursive: true, force: true });
  batch.state = 'aborted';
}

module.exports = {
  SCHEMA_VERSION,
  abortEvidenceBatch,
  beginEvidenceBatch,
  commitEvidenceBatch,
  readCommittedBatch,
  sha256File,
  verifyManifest,
};
