'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildReleaseReadiness,
  sha256Bytes,
  stableJson,
} = require('./release/build-windows-release-readiness');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-formal-release-contract-'));
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
const EMPTY_HASH = sha256Bytes('');
const SOURCE_COMMIT = 'a'.repeat(40);
const PUBLISHER = 'CN=Zhaocai Guan Synthetic Release Test';
const THUMBPRINT = 'B'.repeat(40);

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJson(name, value) {
  const filePath = path.join(ROOT, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function withSelfHash(value) {
  const result = { ...value };
  delete result.manifest_sha256;
  result.manifest_sha256 = sha256Bytes(stableJson(result));
  return result;
}

const testedExecutablePath = path.join(ROOT, 'ZhaocaiGuan.exe');
fs.writeFileSync(testedExecutablePath, 'synthetic signed package executable; no candidate content');
const testedExecutableHash = hashFile(testedExecutablePath);
const distributionArtifactPath = path.join(ROOT, 'ZhaocaiGuan-Setup.exe');
fs.writeFileSync(distributionArtifactPath, 'synthetic signed distribution artifact; no candidate content');
const distributionArtifactHash = hashFile(distributionArtifactPath);

const candidate = {
  schema_version: 'hrboss_windows_candidate_v1',
  candidate_type: 'unsigned-technical-candidate',
  production_release_allowed: false,
  signing_state: 'unsigned-candidate',
  application: { name: '招才官', version: '1.1.0' },
  target: { electron: '42.5.1', platform: 'win32', arch: 'x64' },
  source: {
    head: SOURCE_COMMIT,
    worktree_state: 'clean',
    tracked_diff_sha256: EMPTY_HASH,
    untracked_path_count: 0,
    untracked_paths_sha256: EMPTY_HASH,
    status_sha256: EMPTY_HASH,
  },
  package: {
    package_tree_sha256: 'c'.repeat(64),
    payload_tree_sha256: 'f'.repeat(64),
    unsigned_executable_sha256: 'd'.repeat(64),
    native_module_sha256: 'e'.repeat(64),
  },
};
const candidatePath = writeJson('candidate.json', candidate);

const f015 = {
  schema_version: 'hrboss_windows_acceptance_v1',
  run_id: 'synthetic-f015-pass',
  technical_result: 'PASS',
  failure_count: 0,
  require_authenticode: true,
  checks: [{ status: 'PASS', code: 'SYNTHETIC' }],
  package: {
    version: '1.1.0',
    executable_sha256: testedExecutableHash,
    native_module_sha256: candidate.package.native_module_sha256,
    payload_tree_sha256: candidate.package.payload_tree_sha256,
    authenticode_status: 'Valid',
    signer_subject: PUBLISHER,
    signer_thumbprint: THUMBPRINT,
  },
};
const f015Path = writeJson('f015-summary.json', f015);

const testedAuthenticodePath = writeJson('tested-authenticode.json', {
  schema_version: 'hrboss_windows_authenticode_v1',
  collected_at: '2026-07-12T12:00:00.000Z',
  artifact_name: path.basename(testedExecutablePath),
  artifact_sha256: testedExecutableHash,
  status: 'Valid',
  signer_subject: PUBLISHER,
  signer_thumbprint: THUMBPRINT,
});
const distributionAuthenticodePath = writeJson('distribution-authenticode.json', {
  schema_version: 'hrboss_windows_authenticode_v1',
  collected_at: '2026-07-12T12:05:00.000Z',
  artifact_name: path.basename(distributionArtifactPath),
  artifact_sha256: distributionArtifactHash,
  status: 'Valid',
  signer_subject: PUBLISHER,
  signer_thumbprint: THUMBPRINT,
});

const previous = withSelfHash({
  schema_version: 'hrboss_windows_external_stable_release_v1',
  release_id: 'windows-1.0.0-previous',
  release_status: 'PRODUCTION_APPROVED_EXTERNAL',
  version: '1.0.0',
  created_at: '2026-07-01T00:00:00.000Z',
  source_commit: '9'.repeat(40),
  update_mode: 'manual-controlled',
  distribution_artifact: { sha256: '8'.repeat(64) },
});
const previousPath = writeJson('previous-external-stable.json', previous);

const rollbackDirectory = path.join(ROOT, 'rollback');
fs.mkdirSync(rollbackDirectory);
const rollbackDatabasePath = path.join(rollbackDirectory, 'database.db');
fs.writeFileSync(rollbackDatabasePath, 'opaque synthetic backup bytes; never parsed as candidate rows');
const rollback = withSelfHash({
  format_version: 1,
  recovery_id: 'synthetic-rollback-1',
  app_version: '1.0.0',
  policy_version: 'f011-v1',
  created_at: '2026-07-12T11:00:00.000Z',
  backup_retention_days: 30,
  database: {
    relative_path: 'database.db',
    bytes: fs.statSync(rollbackDatabasePath).size,
    sha256: hashFile(rollbackDatabasePath),
    schema_fingerprint: '7'.repeat(64),
    user_version: 1,
  },
});
const rollbackPath = writeJson('rollback/manifest.json', rollback);

const releaseApproval = {
  schema_version: 'hrboss_windows_release_approval_v1',
  result: 'PASS',
  distribution_sha256: distributionArtifactHash,
  F015_summary_sha256: hashFile(f015Path),
  rollback_manifest_sha256: hashFile(rollbackPath),
  checks: [
    'INSTALL',
    'UPGRADE',
    'UNINSTALL',
    'ROLLBACK',
    'MIC_ASR',
    'BOSS_LIMITED',
    'SECURITY_LEGAL',
  ].map((code) => ({ code, result: 'PASS' })),
  approvals: {
    engineering: { decision: 'APPROVED', actor: 'synthetic-engineer', signed_at: '2026-07-12T12:10:00.000Z' },
    hr: { decision: 'APPROVED', actor: 'synthetic-hr', signed_at: '2026-07-12T12:11:00.000Z' },
    security_legal: { decision: 'APPROVED', actor: 'synthetic-security-legal', signed_at: '2026-07-12T12:12:00.000Z' },
  },
};
const releaseApprovalPath = writeJson('release-approval.json', releaseApproval);

function inputs(outputName) {
  return {
    version: '1.1.0',
    testedPackageExecutablePath: testedExecutablePath,
    testedPackageAuthenticodeEvidencePath: testedAuthenticodePath,
    distributionArtifactPath,
    distributionAuthenticodeEvidencePath: distributionAuthenticodePath,
    candidateManifestPath: candidatePath,
    f015SummaryPath: f015Path,
    approvedPublisher: PUBLISHER,
    approvedThumbprint: THUMBPRINT,
    previousStableManifestPath: previousPath,
    rollbackBackupManifestPath: rollbackPath,
    releaseApprovalEvidencePath: releaseApprovalPath,
    outputPath: path.join(ROOT, outputName),
  };
}

const sourceState = { head: SOURCE_COMMIT, clean: true };
const manifest = buildReleaseReadiness(inputs('readiness.json'), {
  sourceState,
  now: '2026-07-12T12:30:00.000Z',
});
assert.equal(manifest.schema_version, 'hrboss_windows_release_readiness_v1');
assert.equal(manifest.evidence_consistency, 'PASS');
assert.equal(manifest.production_release_allowed, false);
assert.equal(manifest.manual_go_no_go_required, true);
assert.equal(manifest.distribution_payload_binding, 'UNVERIFIED_EXTERNAL');
assert.deepEqual(manifest.open_gates, [
  'REAL_WINDOWS_ATTESTATION',
  'AUTHENTIC_APPROVAL',
  'DISTRIBUTION_PAYLOAD_BINDING',
]);
assert.equal(manifest.update_mode, 'manual-controlled');
assert.equal(manifest.tested_package_executable.sha256, testedExecutableHash);
assert.equal(manifest.distribution_artifact.sha256, distributionArtifactHash);
assert.equal(manifest.f015.technical_result, 'PASS');
assert.equal(manifest.previous_stable.manifest_sha256, previous.manifest_sha256);
assert.equal(manifest.rollback_backup.database_sha256, rollback.database.sha256);
assert.equal(manifest.release_approval_evidence_sha256, hashFile(releaseApprovalPath));
assert.match(manifest.manifest_sha256, /^[0-9a-f]{64}$/);
assert.throws(() => buildReleaseReadiness(inputs('readiness.json'), { sourceState }), /EEXIST|exist/i, 'readiness manifest must not be overwritten');

assert.throws(
  () => buildReleaseReadiness(inputs('dirty.json'), { sourceState: { head: SOURCE_COMMIT, clean: false } }),
  (error) => error.code === 'DIRTY_OR_FLOATING_SOURCE',
);

writeJson('f015-summary.json', { ...f015, technical_result: 'FAIL', failure_count: 1 });
assert.throws(
  () => buildReleaseReadiness(inputs('failed-f015.json'), { sourceState }),
  (error) => error.code === 'F015_NOT_PASSED',
);
writeJson('f015-summary.json', f015);

assert.throws(
  () => buildReleaseReadiness({ ...inputs('wrong-signer.json'), approvedThumbprint: 'C'.repeat(40) }, { sourceState }),
  (error) => error.code === 'SIGNER_NOT_APPROVED',
);
assert.throws(
  () => {
    const sameVersionPrevious = withSelfHash({ ...previous, version: '1.1.0' });
    const sameVersionPath = writeJson('same-version-previous.json', sameVersionPrevious);
    return buildReleaseReadiness({ ...inputs('old-version.json'), previousStableManifestPath: sameVersionPath }, { sourceState });
  },
  (error) => error.code === 'VERSION_NOT_INCREMENTED',
);
assert.throws(
  () => buildReleaseReadiness({ ...inputs('missing-previous.json'), previousStableManifestPath: path.join(ROOT, 'missing.json') }, { sourceState }),
  (error) => error.code === 'INVALID_EVIDENCE',
);

const missingApprovalCheck = {
  ...releaseApproval,
  checks: releaseApproval.checks.filter((check) => check.code !== 'ROLLBACK'),
};
const missingApprovalCheckPath = writeJson('release-approval-missing-check.json', missingApprovalCheck);
assert.throws(
  () => buildReleaseReadiness({ ...inputs('missing-approval-check.json'), releaseApprovalEvidencePath: missingApprovalCheckPath }, { sourceState }),
  (error) => error.code === 'RELEASE_APPROVAL_INCOMPLETE',
);

const mismatchedApproval = { ...releaseApproval, distribution_sha256: '2'.repeat(64) };
const mismatchedApprovalPath = writeJson('release-approval-hash-mismatch.json', mismatchedApproval);
assert.throws(
  () => buildReleaseReadiness({ ...inputs('approval-hash-mismatch.json'), releaseApprovalEvidencePath: mismatchedApprovalPath }, { sourceState }),
  (error) => error.code === 'RELEASE_APPROVAL_HASH_MISMATCH',
);

const placeholderApproval = {
  ...releaseApproval,
  approvals: {
    ...releaseApproval.approvals,
    engineering: { ...releaseApproval.approvals.engineering, actor: '<负责人>' },
  },
};
const placeholderApprovalPath = writeJson('release-approval-placeholder.json', placeholderApproval);
assert.throws(
  () => buildReleaseReadiness({ ...inputs('approval-placeholder.json'), releaseApprovalEvidencePath: placeholderApprovalPath }, { sourceState }),
  (error) => error.code === 'RELEASE_APPROVAL_INCOMPLETE',
);

const invalidTimeApproval = {
  ...releaseApproval,
  approvals: {
    ...releaseApproval.approvals,
    hr: { ...releaseApproval.approvals.hr, signed_at: '<ISO 时间>' },
  },
};
const invalidTimeApprovalPath = writeJson('release-approval-invalid-time.json', invalidTimeApproval);
assert.throws(
  () => buildReleaseReadiness({ ...inputs('approval-invalid-time.json'), releaseApprovalEvidencePath: invalidTimeApprovalPath }, { sourceState }),
  (error) => error.code === 'RELEASE_APPROVAL_INCOMPLETE',
);

writeJson('f015-summary.json', { ...f015, package: { ...f015.package, payload_tree_sha256: '1'.repeat(64) } });
assert.throws(
  () => buildReleaseReadiness(inputs('payload-mismatch.json'), { sourceState }),
  (error) => error.code === 'PACKAGE_HASH_MISMATCH',
);
writeJson('f015-summary.json', f015);

const wrongRollback = withSelfHash({ ...rollback, app_version: '0.9.0' });
const wrongRollbackPath = writeJson('wrong-rollback/manifest.json', wrongRollback);
fs.copyFileSync(rollbackDatabasePath, path.join(ROOT, 'wrong-rollback', 'database.db'));
assert.throws(
  () => buildReleaseReadiness({ ...inputs('wrong-rollback.json'), rollbackBackupManifestPath: wrongRollbackPath }, { sourceState }),
  (error) => error.code === 'ROLLBACK_VERSION_MISMATCH',
);

fs.appendFileSync(distributionArtifactPath, 'tamper');
assert.throws(
  () => buildReleaseReadiness(inputs('tampered-distribution.json'), { sourceState }),
  (error) => error.code === 'AUTHENTICODE_INVALID',
);

const collector = fs.readFileSync(path.join(__dirname, 'release', 'collect-windows-authenticode-evidence.ps1'));
assert.deepEqual([...collector.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'PowerShell 5.1 collector requires UTF-8 BOM');
const collectorText = collector.toString('utf8');
assert.match(collectorText, /Get-AuthenticodeSignature/);
assert.doesNotMatch(collectorText, /pfx|password|certutil/i, 'collector must not handle keys or passwords');

const readinessSource = fs.readFileSync(path.join(__dirname, 'release', 'build-windows-release-readiness.js'), 'utf8');
assert.doesNotMatch(readinessSource, /production_release_allowed\s*:\s*true/, 'readiness source must never authorize production');

console.log('check-windows-release-readiness-contract ok');
