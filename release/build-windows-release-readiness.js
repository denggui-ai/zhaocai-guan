'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const THUMBPRINT = /^[0-9A-F]{40}$/;
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
const REQUIRED_RELEASE_CHECKS = Object.freeze([
  'INSTALL',
  'UPGRADE',
  'UNINSTALL',
  'ROLLBACK',
  'MIC_ASR',
  'BOSS_LIMITED',
  'SECURITY_LEGAL',
]);
const REQUIRED_APPROVALS = Object.freeze(['engineering', 'hr', 'security_legal']);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function readJson(filePath, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    fail('INVALID_EVIDENCE', `${label} is missing or is not valid JSON`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') fail('INVALID_EVIDENCE', `${label} must be an object`);
  return parsed;
}

function runGit(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail('SOURCE_STATE_UNAVAILABLE', 'cannot resolve the local source state');
  return String(result.stdout || '').trim();
}

function captureSourceState() {
  const head = runGit(['rev-parse', 'HEAD']).toLowerCase();
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all']);
  return { head, clean: status.length === 0 };
}

function parseVersion(value, label) {
  const match = typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) fail('INVALID_VERSION', `${label} must be a stable major.minor.patch version`);
  return { text: value, parts: match.slice(1).map(Number) };
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left.parts[index] !== right.parts[index]) return left.parts[index] - right.parts[index];
  }
  return 0;
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) fail('INVALID_HASH', `${label} must be a lowercase SHA-256`);
  return value;
}

function assertPreviousManifest(manifest) {
  if (manifest.schema_version !== 'hrboss_windows_external_stable_release_v1'
    || manifest.release_status !== 'PRODUCTION_APPROVED_EXTERNAL'
    || manifest.update_mode !== 'manual-controlled') {
    fail('INVALID_PREVIOUS_RELEASE', 'previous stable manifest must describe an externally approved production release');
  }
  assertHash(manifest.manifest_sha256, 'previous manifest self hash');
  const unsigned = { ...manifest };
  delete unsigned.manifest_sha256;
  if (sha256Bytes(stableJson(unsigned)) !== manifest.manifest_sha256) {
    fail('PREVIOUS_MANIFEST_HASH_MISMATCH', 'previous stable manifest self hash does not match');
  }
  assertHash(manifest.distribution_artifact && manifest.distribution_artifact.sha256, 'previous distribution artifact hash');
  return parseVersion(manifest.version, 'previous release version');
}

function assertAuthenticodeEvidence(evidence, artifactHash, approvedPublisher, approvedThumbprint, label) {
  if (evidence.schema_version !== 'hrboss_windows_authenticode_v1'
    || evidence.status !== 'Valid'
    || evidence.artifact_sha256 !== artifactHash) {
    fail('AUTHENTICODE_INVALID', `${label} Authenticode evidence is invalid or belongs to another artifact`);
  }
  const evidenceThumbprint = String(evidence.signer_thumbprint || '').replace(/\s/g, '').toUpperCase();
  if (evidence.signer_subject !== approvedPublisher || evidenceThumbprint !== approvedThumbprint) {
    fail('SIGNER_NOT_APPROVED', `${label} signer is not the explicitly approved publisher and thumbprint`);
  }
}

function assertReleaseApprovalEvidence(evidence, expected) {
  if (evidence.schema_version !== 'hrboss_windows_release_approval_v1' || evidence.result !== 'PASS') {
    fail('RELEASE_APPROVAL_NOT_PASSED', 'release approval evidence must use the approved schema and result PASS');
  }
  for (const [field, hash] of Object.entries(expected)) {
    if (evidence[field] !== hash) {
      fail('RELEASE_APPROVAL_HASH_MISMATCH', `release approval ${field} does not match the frozen evidence`);
    }
  }
  if (!Array.isArray(evidence.checks)) fail('RELEASE_APPROVAL_INCOMPLETE', 'release approval checks are required');
  const checkResults = new Map();
  for (const check of evidence.checks) {
    if (!check || typeof check.code !== 'string' || checkResults.has(check.code)) {
      fail('RELEASE_APPROVAL_INCOMPLETE', 'release approval checks must have unique codes');
    }
    if (check.result !== 'PASS') fail('RELEASE_APPROVAL_INCOMPLETE', `${check.code} is not PASS`);
    checkResults.set(check.code, check.result);
  }
  for (const code of REQUIRED_RELEASE_CHECKS) {
    if (checkResults.get(code) !== 'PASS') fail('RELEASE_APPROVAL_INCOMPLETE', `${code} must be explicitly PASS`);
  }
  if (!evidence.approvals || typeof evidence.approvals !== 'object') {
    fail('RELEASE_APPROVAL_INCOMPLETE', 'release approvals are required');
  }
  for (const role of REQUIRED_APPROVALS) {
    const approval = evidence.approvals[role];
    const actor = approval && approval.actor;
    const signedAt = approval && approval.signed_at;
    let canonicalSignedAt = false;
    if (typeof signedAt === 'string') {
      const parsed = new Date(signedAt);
      canonicalSignedAt = Number.isFinite(parsed.getTime()) && parsed.toISOString() === signedAt;
    }
    if (!approval
      || approval.decision !== 'APPROVED'
      || typeof actor !== 'string'
      || actor !== actor.trim()
      || actor.length < 1
      || actor.length > 128
      || /[<>\u0000-\u001f\u007f-\u009f]/.test(actor)
      || !canonicalSignedAt) {
      fail('RELEASE_APPROVAL_INCOMPLETE', `${role} approval must be APPROVED with actor and signed_at`);
    }
  }
}

function assertRollbackBackup(manifestPath) {
  const manifest = readJson(manifestPath, 'rollback backup manifest');
  if (manifest.format_version !== 1 || !manifest.database || typeof manifest.recovery_id !== 'string') {
    fail('INVALID_ROLLBACK_BACKUP', 'rollback backup manifest schema is invalid');
  }
  assertHash(manifest.manifest_sha256, 'rollback manifest self hash');
  assertHash(manifest.database.sha256, 'rollback database hash');
  const unsigned = { ...manifest };
  delete unsigned.manifest_sha256;
  if (sha256Bytes(stableJson(unsigned)) !== manifest.manifest_sha256) {
    fail('ROLLBACK_MANIFEST_HASH_MISMATCH', 'rollback backup manifest self hash does not match');
  }
  const databasePath = path.join(path.dirname(manifestPath), manifest.database.relative_path || '');
  if (manifest.database.relative_path !== 'database.db' || !fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
    fail('ROLLBACK_BACKUP_MISSING', 'rollback database file is missing');
  }
  if (sha256File(databasePath) !== manifest.database.sha256) {
    fail('ROLLBACK_DATABASE_HASH_MISMATCH', 'rollback database hash does not match its manifest');
  }
  return manifest;
}

function buildReleaseReadiness(input, options = {}) {
  const sourceState = options.sourceState || captureSourceState();
  if (!sourceState.clean || !COMMIT.test(sourceState.head || '')) {
    fail('DIRTY_OR_FLOATING_SOURCE', 'formal release requires a clean source worktree at an exact commit');
  }

  const version = parseVersion(input.version, 'release version');
  const candidate = readJson(input.candidateManifestPath, 'candidate manifest');
  const f015 = readJson(input.f015SummaryPath, 'F015 summary');
  const testedAuthenticode = readJson(input.testedPackageAuthenticodeEvidencePath, 'tested package Authenticode evidence');
  const distributionAuthenticode = readJson(input.distributionAuthenticodeEvidencePath, 'distribution Authenticode evidence');
  const previous = readJson(input.previousStableManifestPath, 'previous stable manifest');
  const rollback = assertRollbackBackup(input.rollbackBackupManifestPath);

  if (candidate.schema_version !== 'hrboss_windows_candidate_v1'
    || candidate.signing_state !== 'unsigned-candidate'
    || candidate.production_release_allowed !== false
    || candidate.source?.head !== sourceState.head
    || candidate.source?.worktree_state !== 'clean'
    || candidate.source?.tracked_diff_sha256 !== EMPTY_SHA256
    || candidate.source?.untracked_path_count !== 0
    || candidate.source?.untracked_paths_sha256 !== EMPTY_SHA256
    || candidate.source?.status_sha256 !== EMPTY_SHA256
    || candidate.target?.platform !== 'win32'
    || candidate.target?.arch !== 'x64') {
    fail('CANDIDATE_SOURCE_MISMATCH', 'candidate manifest is not a clean win32/x64 build of the current source commit');
  }
  assertHash(candidate.package?.package_tree_sha256, 'candidate package tree hash');
  assertHash(candidate.package?.payload_tree_sha256, 'candidate payload tree hash');
  assertHash(candidate.package?.native_module_sha256, 'candidate native module hash');
  if (candidate.application?.version !== version.text) fail('VERSION_MISMATCH', 'candidate version differs from the release version');

  if (f015.schema_version !== 'hrboss_windows_acceptance_v1'
    || f015.technical_result !== 'PASS'
    || f015.failure_count !== 0
    || f015.require_authenticode !== true
    || !Array.isArray(f015.checks)
    || f015.checks.some((check) => check?.status === 'FAIL')) {
    fail('F015_NOT_PASSED', 'F015 evidence must be a PASS with zero failures and the Authenticode hard gate enabled');
  }
  if (f015.package?.version !== version.text) fail('VERSION_MISMATCH', 'F015 package version differs from the release version');
  const f015ExecutableHash = assertHash(f015.package?.executable_sha256, 'F015 executable hash');
  const f015NativeHash = assertHash(f015.package?.native_module_sha256, 'F015 native module hash');
  const f015PayloadTreeHash = assertHash(f015.package?.payload_tree_sha256, 'F015 payload tree hash');
  if (f015NativeHash !== candidate.package.native_module_sha256) {
    fail('PACKAGE_HASH_MISMATCH', 'F015 native module hash differs from the candidate package');
  }
  if (f015PayloadTreeHash !== candidate.package.payload_tree_sha256) {
    fail('PACKAGE_HASH_MISMATCH', 'F015 payload tree hash differs from the candidate package');
  }

  const testedExecutableHash = sha256File(input.testedPackageExecutablePath);
  if (testedExecutableHash !== f015ExecutableHash) fail('PACKAGE_HASH_MISMATCH', 'tested executable hash differs from the package exercised by F015');
  const distributionArtifactHash = sha256File(input.distributionArtifactPath);
  const approvedPublisher = String(input.approvedPublisher || '').trim();
  const approvedThumbprint = String(input.approvedThumbprint || '').replace(/\s/g, '').toUpperCase();
  if (!approvedPublisher || !THUMBPRINT.test(approvedThumbprint)) {
    fail('SIGNER_APPROVAL_REQUIRED', 'an explicit approved publisher and certificate thumbprint are required');
  }
  assertAuthenticodeEvidence(testedAuthenticode, testedExecutableHash, approvedPublisher, approvedThumbprint, 'tested package executable');
  assertAuthenticodeEvidence(distributionAuthenticode, distributionArtifactHash, approvedPublisher, approvedThumbprint, 'distribution artifact');
  if (f015.package?.authenticode_status !== 'Valid'
    || f015.package?.signer_subject !== approvedPublisher
    || String(f015.package?.signer_thumbprint || '').replace(/\s/g, '').toUpperCase() !== approvedThumbprint) {
    fail('SIGNER_NOT_APPROVED', 'F015 signer is not the explicitly approved publisher and thumbprint');
  }

  const previousVersion = assertPreviousManifest(previous);
  if (compareVersions(version, previousVersion) <= 0) fail('VERSION_NOT_INCREMENTED', 'release version must be greater than the previous stable version');
  if (rollback.app_version !== previous.version) {
    fail('ROLLBACK_VERSION_MISMATCH', 'rollback backup app version must equal the previous stable version');
  }

  const f015SummaryFileHash = sha256File(input.f015SummaryPath);
  const rollbackManifestFileHash = sha256File(input.rollbackBackupManifestPath);
  const releaseApproval = readJson(input.releaseApprovalEvidencePath, 'release approval evidence');
  assertReleaseApprovalEvidence(releaseApproval, {
    distribution_sha256: distributionArtifactHash,
    F015_summary_sha256: f015SummaryFileHash,
    rollback_manifest_sha256: rollbackManifestFileHash,
  });

  const createdAt = options.now || new Date().toISOString();
  const manifest = {
    schema_version: 'hrboss_windows_release_readiness_v1',
    readiness_id: `windows-${version.text}-${sourceState.head.slice(0, 12)}`,
    version: version.text,
    created_at: createdAt,
    source_commit: sourceState.head,
    update_mode: 'manual-controlled',
    evidence_consistency: 'PASS',
    production_release_allowed: false,
    manual_go_no_go_required: true,
    distribution_payload_binding: 'UNVERIFIED_EXTERNAL',
    open_gates: [
      'REAL_WINDOWS_ATTESTATION',
      'AUTHENTIC_APPROVAL',
      'DISTRIBUTION_PAYLOAD_BINDING',
    ],
    tested_package_executable: {
      file_name: path.basename(input.testedPackageExecutablePath),
      sha256: testedExecutableHash,
      authenticode_status: 'Valid',
      signer_subject: approvedPublisher,
      signer_thumbprint: approvedThumbprint,
      evidence_sha256: sha256File(input.testedPackageAuthenticodeEvidencePath),
    },
    distribution_artifact: {
      file_name: path.basename(input.distributionArtifactPath),
      sha256: distributionArtifactHash,
      authenticode_status: 'Valid',
      signer_subject: approvedPublisher,
      signer_thumbprint: approvedThumbprint,
      evidence_sha256: sha256File(input.distributionAuthenticodeEvidencePath),
    },
    candidate: {
      manifest_file_sha256: sha256File(input.candidateManifestPath),
      unsigned_package_tree_sha256: candidate.package.package_tree_sha256,
      payload_tree_sha256: candidate.package.payload_tree_sha256,
      native_module_sha256: candidate.package.native_module_sha256,
    },
    f015: {
      summary_file_sha256: f015SummaryFileHash,
      run_id: f015.run_id,
      technical_result: 'PASS',
      failure_count: 0,
    },
    previous_stable: {
      version: previous.version,
      manifest_file_sha256: sha256File(input.previousStableManifestPath),
      manifest_sha256: previous.manifest_sha256,
      distribution_artifact_sha256: previous.distribution_artifact.sha256,
    },
    rollback_backup: {
      recovery_id: rollback.recovery_id,
      app_version: rollback.app_version,
      manifest_file_sha256: rollbackManifestFileHash,
      manifest_sha256: rollback.manifest_sha256,
      database_sha256: rollback.database.sha256,
    },
    release_approval_evidence_sha256: sha256File(input.releaseApprovalEvidencePath),
  };
  manifest.manifest_sha256 = sha256Bytes(stableJson(manifest));

  const outputPath = path.resolve(input.outputPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return manifest;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) fail('INVALID_ARGUMENT', 'arguments must be --name value pairs');
    values[name.slice(2)] = value;
  }
  const names = [
    'version', 'tested-package-executable', 'tested-package-authenticode-evidence',
    'distribution-artifact', 'distribution-authenticode-evidence', 'candidate-manifest', 'f015-summary',
    'approved-publisher', 'approved-thumbprint', 'previous-stable-manifest', 'rollback-backup-manifest', 'output',
    'release-approval-evidence',
  ];
  for (const name of names) if (!values[name]) fail('INVALID_ARGUMENT', `--${name} is required`);
  return {
    version: values.version,
    testedPackageExecutablePath: path.resolve(values['tested-package-executable']),
    testedPackageAuthenticodeEvidencePath: path.resolve(values['tested-package-authenticode-evidence']),
    distributionArtifactPath: path.resolve(values['distribution-artifact']),
    distributionAuthenticodeEvidencePath: path.resolve(values['distribution-authenticode-evidence']),
    candidateManifestPath: path.resolve(values['candidate-manifest']),
    f015SummaryPath: path.resolve(values['f015-summary']),
    approvedPublisher: values['approved-publisher'],
    approvedThumbprint: values['approved-thumbprint'],
    previousStableManifestPath: path.resolve(values['previous-stable-manifest']),
    rollbackBackupManifestPath: path.resolve(values['rollback-backup-manifest']),
    releaseApprovalEvidencePath: path.resolve(values['release-approval-evidence']),
    outputPath: path.resolve(values.output),
  };
}

module.exports = { buildReleaseReadiness, compareVersions, parseVersion, sha256Bytes, stableJson };

if (require.main === module) {
  try {
    const manifest = buildReleaseReadiness(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify({ ok: true, evidence_consistency: 'PASS', production_release_allowed: false, output: process.argv[process.argv.indexOf('--output') + 1], manifest_sha256: manifest.manifest_sha256 })}\n`);
  } catch (error) {
    console.error(`${error.code || 'RELEASE_GATE_FAILED'}: ${error.message}`);
    process.exit(1);
  }
}
