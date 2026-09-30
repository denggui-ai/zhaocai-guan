'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const inheritedRoot = process.env.HRBOSS_REVOCATION_LATCH_TEST_ROOT || '';
const ROOT = inheritedRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-consent-revocation-latch-'));
const DB_PATH = path.join(ROOT, 'recruiting.db');
const GATE_ROOT = path.join(ROOT, 'private-gates');
const MATERIAL_ROOT = path.join(ROOT, 'interviews');
const RECOVERY_ROOT = path.join(ROOT, 'recovery');
const ownsRoot = !inheritedRoot;

process.env.BOSS_DB_PATH = DB_PATH;
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = MATERIAL_ROOT;
process.env.HRBOSS_CONSENT_REVOCATION_GATE_DIR = GATE_ROOT;
process.env.HRBOSS_LOCAL_API_TOKEN = 'synthetic-local-api-token-revocation-latch';
process.env.HRBOSS_LOCAL_API_INSTANCE_ID = 'check-interview-consent-revocation-latch';

if (ownsRoot) {
  process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));
}

const db = require("../src/db");
const latch = require("../src/interview-consent-revocation-latch");

function seed(jobKey, candidateKey) {
  const job = db.upsertJob({
    encrypt_job_id: jobKey,
    numeric_job_id: `${Date.now()}-${jobKey}`,
    name: `合成岗位-${jobKey}`,
    hr_owner: 'HR-SYNTHETIC',
  });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: candidateKey,
    source: 'fixture',
    name: `合成候选人-${candidateKey}`,
  });
  return { job, candidate };
}

function scopeHash(context) {
  return latch.scopeHash(
    context.candidate.internal_id,
    context.job.id,
    db.getInterviewConsentPolicy().scope,
  );
}

function markerPath(context) {
  return latch.markerPath(scopeHash(context));
}

function consentRow(database, context) {
  return database.prepare(`
    SELECT id, status, revoked_at
    FROM interview_recording_consent
    WHERE candidate_id = ? AND job_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(context.candidate.internal_id, context.job.id);
}

function databaseGateCount(database, context) {
  return Number(database.prepare(`
    SELECT COUNT(*) AS n
    FROM interview_recording_consent_revocation_gate
    WHERE scope_hash = ?
  `).get(scopeHash(context)).n);
}

function confirm(context) {
  return db.recordInterviewConsent({
    candidateId: context.candidate.internal_id,
    jobId: context.job.id,
    confirmed: true,
    recordedBy: 'HR-SYNTHETIC',
    source: 'synthetic_revocation_latch_check',
  });
}

let revokeRequestSequence = 0;

function revoke(context, requestId = '') {
  revokeRequestSequence += 1;
  return db.recordInterviewConsent({
    candidateId: context.candidate.internal_id,
    jobId: context.job.id,
    confirmed: false,
    recordedBy: 'HR-SYNTHETIC',
    source: 'synthetic_revocation_latch_check',
    requestId: requestId || `synthetic-revoke-${revokeRequestSequence}`,
  });
}

function assertPending(context, label) {
  const consent = db.getInterviewConsent({
    candidateId: context.candidate.internal_id,
    jobId: context.job.id,
  });
  assert.equal(consent.valid, false, `${label}: pending gate must invalidate consent`);
  assert.equal(consent.revocation_pending, true, `${label}: pending gate must be observable`);
  assert.throws(
    () => db.requireActiveInterviewConsent({
      candidateId: context.candidate.internal_id,
      jobId: context.job.id,
    }),
    (error) => error && error.code === 'INTERVIEW_CONSENT_REVOCATION_PENDING' && error.statusCode === 409,
    `${label}: capture preflight must preserve the pending-gate 409`,
  );
  assert.throws(
    () => confirm(context),
    (error) => error && error.code === 'INTERVIEW_CONSENT_REVOCATION_PENDING' && error.statusCode === 409,
    `${label}: ordinary re-authorization must not clear a pending gate`,
  );
}

function runRestartProbe(context) {
  const child = spawnSync(process.execPath, [
    __filename,
    '--probe-pending',
    context.candidate.internal_id,
    String(context.job.id),
  ], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HRBOSS_REVOCATION_LATCH_TEST_ROOT: ROOT,
      BOSS_DB_PATH: DB_PATH,
      HRBOSS_CONSENT_REVOCATION_GATE_DIR: GATE_ROOT,
      HRBOSS_INTERVIEW_OUTPUT_DIR: MATERIAL_ROOT,
    },
  });
  assert.equal(child.status, 0, `restart probe failed: ${child.stderr || child.stdout}`);
  const line = String(child.stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1);
  assert.deepEqual(JSON.parse(line), {
    ok: true,
    valid: false,
    revocation_pending: true,
    require_code: 'INTERVIEW_CONSENT_REVOCATION_PENDING',
    regrant_code: 'INTERVIEW_CONSENT_REVOCATION_PENDING',
  });
}

function runProbe() {
  const candidateId = String(process.argv[3] || '');
  const jobId = Number(process.argv[4]);
  db.openDb(DB_PATH);
  const consent = db.getInterviewConsent({ candidateId, jobId });
  let requireCode = '';
  let regrantCode = '';
  try {
    db.requireActiveInterviewConsent({ candidateId, jobId });
  } catch (error) {
    requireCode = error.code || '';
  }
  try {
    db.recordInterviewConsent({
      candidateId,
      jobId,
      confirmed: true,
      recordedBy: 'HR-RESTART-PROBE',
      source: 'synthetic_restart_probe',
    });
  } catch (error) {
    regrantCode = error.code || '';
  }
  db.conn().close();
  console.log(JSON.stringify({
    ok: true,
    valid: consent && consent.valid,
    revocation_pending: consent && consent.revocation_pending,
    require_code: requireCode,
    regrant_code: regrantCode,
  }));
}

async function main() {
  if (process.argv[2] === '--probe-pending') {
    runProbe();
    return;
  }

  const apiSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/api.js'), 'utf8');
  const panelSource = fs.readFileSync(
    path.join(PROJECT_ROOT, 'frontend/src/components/InterviewReviewPanel.jsx'),
    'utf8',
  );
  assert.match(apiSource, /saveInterviewConsent:[\s\S]{0,240}requestId/,
    'renderer consent API must carry the revocation requestId');
  assert.match(panelSource, /consentRevocationRequestIdRef[\s\S]{0,20000}uiRequestId\([\s\S]{0,2000}saveInterviewConsent\(/,
    'the UI must preserve one revocation requestId through the request lifecycle');

  let database = db.openDb(DB_PATH);
  const primary = seed('revocation-primary', 'candidate-primary-private-token');
  const other = seed('revocation-other', 'candidate-other-private-token');
  confirm(primary);
  confirm(other);

  // DB gate INSERT fault: the hash-only marker is the durable fallback and
  // survives a real child-process restart without affecting another scope.
  database.exec(`
    CREATE TRIGGER fail_revocation_gate_insert
    BEFORE INSERT ON interview_recording_consent_revocation_gate
    BEGIN
      SELECT RAISE(ABORT, 'synthetic gate insert failure');
    END;
  `);
  const fallbackGate = db.beginInterviewConsentRevocationGate({
    candidateId: primary.candidate.internal_id,
    jobId: primary.job.id,
  });
  assert.equal(fallbackGate.database_written, false);
  assert.equal(fallbackGate.fallback_written, true);
  assert.equal(databaseGateCount(database, primary), 0);
  assert.equal(fs.existsSync(markerPath(primary)), true);
  const markerText = fs.readFileSync(markerPath(primary), 'utf8');
  const marker = JSON.parse(markerText);
  assert.deepEqual(Object.keys(marker).sort(), [
    'requested_at', 'schema_version', 'scope_hash', 'status', 'updated_at',
  ]);
  assert.equal(marker.scope_hash, scopeHash(primary));
  assert.equal(marker.status, 'pending');
  assert.equal(markerText.includes(primary.candidate.internal_id), false);
  assert.equal(markerText.includes(primary.candidate.name), false);
  assert.equal(Object.hasOwn(marker, 'candidate_id'), false);
  assert.equal(Object.hasOwn(marker, 'job_id'), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(markerPath(primary)).mode & 0o077, 0, 'marker must be private 0600');
    assert.equal(fs.statSync(GATE_ROOT).mode & 0o077, 0, 'marker directory must be private 0700');
  }
  assertPending(primary, 'DB INSERT fallback');
  assert.equal(db.getInterviewConsent({
    candidateId: other.candidate.internal_id,
    jobId: other.job.id,
  }).valid, true, 'a pending hash must not affect another candidate/job scope');
  database.close();
  runRestartProbe(primary);
  database = db.openDb(DB_PATH);
  database.exec('DROP TRIGGER fail_revocation_gate_insert');
  revoke(primary);
  assert.equal(consentRow(database, primary).status, 'revoked');
  assert.equal(databaseGateCount(database, primary), 0);
  assert.equal(fs.existsSync(markerPath(primary)), false);
  assert.equal(db.getInterviewConsent({
    candidateId: primary.candidate.internal_id,
    jobId: primary.job.id,
  }).revocation_pending, false);
  assert.equal(confirm(primary).valid, true, 'fresh explicit consent is allowed only after completed revocation');

  // A fault before SQLite can be read must still leave the file marker before
  // conn()/schema access and remain restart-visible.
  database.close();
  const dbReadFallback = db.beginInterviewConsentRevocationGate({
    candidateId: primary.candidate.internal_id,
    jobId: primary.job.id,
  });
  assert.equal(dbReadFallback.database_written, false);
  assert.equal(dbReadFallback.fallback_written, true);
  assert.equal(fs.existsSync(markerPath(primary)), true);
  runRestartProbe(primary);
  database = db.openDb(DB_PATH);
  revoke(primary);
  assert.equal(fs.existsSync(markerPath(primary)), false);

  // UPDATE fault keeps the old row active but both gates pending.
  confirm(primary);
  database.exec(`
    CREATE TRIGGER fail_consent_revoke_update
    BEFORE UPDATE OF status ON interview_recording_consent
    WHEN OLD.status = 'active' AND NEW.status = 'revoked'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic revoke update failure');
    END;
  `);
  assert.throws(() => revoke(primary), /synthetic revoke update failure/);
  assert.equal(consentRow(database, primary).status, 'active');
  assert.equal(databaseGateCount(database, primary), 1);
  assert.equal(fs.existsSync(markerPath(primary)), true);
  assertPending(primary, 'UPDATE fault');
  database.exec('DROP TRIGGER fail_consent_revoke_update');
  revoke(primary);
  assert.equal(consentRow(database, primary).status, 'revoked');
  assert.equal(databaseGateCount(database, primary), 0);
  assert.equal(fs.existsSync(markerPath(primary)), false);

  // Audit fault occurs after the independent UPDATE commit: row remains
  // revoked while audit+gate-clear roll back together and restart stays locked.
  confirm(primary);
  const revokeAuditBefore = Number(database.prepare(`
    SELECT COUNT(*) AS n FROM audit_log WHERE action = '面试录音同意撤销'
  `).get().n);
  database.exec(`
    CREATE TRIGGER fail_consent_revoke_audit
    BEFORE INSERT ON audit_log
    WHEN NEW.action = '面试录音同意撤销'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic revoke audit failure');
    END;
  `);
  assert.throws(() => revoke(primary), /synthetic revoke audit failure/);
  assert.equal(consentRow(database, primary).status, 'revoked');
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS n FROM audit_log WHERE action = '面试录音同意撤销'
  `).get().n), revokeAuditBefore);
  assert.equal(databaseGateCount(database, primary), 1);
  assert.equal(fs.existsSync(markerPath(primary)), true);
  assertPending(primary, 'audit fault');
  database.close();
  runRestartProbe(primary);
  database = db.openDb(DB_PATH);
  database.exec('DROP TRIGGER fail_consent_revoke_audit');
  revoke(primary);
  assert.equal(databaseGateCount(database, primary), 0);
  assert.equal(fs.existsSync(markerPath(primary)), false);
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS n FROM audit_log WHERE action = '面试录音同意撤销'
  `).get().n), revokeAuditBefore + 1);

  // File fallback failure still leaves the SQLite gate. If both durable sinks
  // fail, the shared in-memory blocker keeps this process fail-closed.
  confirm(primary);
  const invalidParent = path.join(ROOT, 'not-a-directory');
  fs.writeFileSync(invalidParent, 'synthetic blocker\n', { mode: 0o600 });
  process.env.HRBOSS_CONSENT_REVOCATION_GATE_DIR = path.join(invalidParent, 'gate');
  const databaseOnlyGate = db.beginInterviewConsentRevocationGate({
    candidateId: primary.candidate.internal_id,
    jobId: primary.job.id,
  });
  assert.equal(databaseOnlyGate.database_written, true);
  assert.equal(databaseOnlyGate.fallback_written, false);
  process.env.HRBOSS_CONSENT_REVOCATION_GATE_DIR = GATE_ROOT;
  assertPending(primary, 'database-only fallback');
  revoke(primary);

  confirm(primary);
  process.env.HRBOSS_CONSENT_REVOCATION_GATE_DIR = path.join(invalidParent, 'gate');
  database.exec(`
    CREATE TRIGGER fail_both_gate_insert
    BEFORE INSERT ON interview_recording_consent_revocation_gate
    BEGIN
      SELECT RAISE(ABORT, 'synthetic both-sink gate failure');
    END;
  `);
  assert.throws(
    () => db.beginInterviewConsentRevocationGate({
      candidateId: primary.candidate.internal_id,
      jobId: primary.job.id,
    }),
    (error) => error && error.code === 'INTERVIEW_CONSENT_REVOCATION_GATE_FAILED',
  );
  process.env.HRBOSS_CONSENT_REVOCATION_GATE_DIR = GATE_ROOT;
  assertPending(primary, 'in-memory fallback');
  database.exec('DROP TRIGGER fail_both_gate_insert');
  revoke(primary);
  assert.equal(db.getInterviewConsent({
    candidateId: primary.candidate.internal_id,
    jobId: primary.job.id,
  }).revocation_pending, false);

  // A malformed marker or symlinked controlled directory is itself pending;
  // removal never follows either parent/root symlink.
  const syntheticHash = latch.scopeHash('synthetic-malformed', 999, db.getInterviewConsentPolicy().scope);
  latch.writeDurableMarker({ scope_hash: syntheticHash });
  fs.writeFileSync(latch.markerPath(syntheticHash), '{malformed', { mode: 0o600 });
  assert.equal(latch.readDurableMarker(syntheticHash).invalid, true);
  latch.removeDurableMarker(syntheticHash);
  const symlinkOutside = path.join(ROOT, 'symlink-outside');
  const symlinkParent = path.join(ROOT, 'symlink-parent');
  fs.mkdirSync(symlinkOutside, { mode: 0o700 });
  fs.mkdirSync(symlinkParent, { mode: 0o700 });
  const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(symlinkOutside, path.join(symlinkParent, 'gate'), directoryLinkType);
  process.env.HRBOSS_CONSENT_REVOCATION_GATE_DIR = path.join(symlinkParent, 'gate');
  assert.equal(latch.readDurableMarker(syntheticHash).invalid, true);
  assert.throws(() => latch.removeDurableMarker(syntheticHash), /cannot be trusted/);
  const parentLink = path.join(ROOT, 'security-link');
  fs.symlinkSync(symlinkOutside, parentLink, directoryLinkType);
  process.env.HRBOSS_CONSENT_REVOCATION_GATE_DIR = path.join(parentLink, 'gate');
  assert.equal(latch.readDurableMarker(syntheticHash).invalid, true);
  assert.throws(() => latch.removeDurableMarker(syntheticHash), /cannot be trusted/);
  process.env.HRBOSS_CONSENT_REVOCATION_GATE_DIR = GATE_ROOT;
  fs.unlinkSync(path.join(symlinkParent, 'gate'));
  fs.unlinkSync(parentLink);

  // unlink succeeded but directory fsync failed: completion exposes only a
  // generic code and installs an in-memory blocker until a safe retry.
  if (process.platform !== 'win32') {
    latch.writeDurableMarker({ scope_hash: scopeHash(primary) });
    const originalFsyncSync = fs.fsyncSync;
    fs.fsyncSync = () => {
      throw new Error(`/private/sensitive/${scopeHash(primary)} must never escape`);
    };
    try {
      assert.throws(
        () => db.completeInterviewConsentRevocationGate({
          candidateId: primary.candidate.internal_id,
          jobId: primary.job.id,
        }),
        (error) => error
          && error.code === 'INTERVIEW_CONSENT_REVOCATION_MARKER_CLEAR_FAILED'
          && !error.message.includes('/private/sensitive/'),
      );
    } finally {
      fs.fsyncSync = originalFsyncSync;
    }
    assertPending(primary, 'directory fsync fault');
    db.completeInterviewConsentRevocationGate({
      candidateId: primary.candidate.internal_id,
      jobId: primary.job.id,
    });
    assert.equal(db.getInterviewConsent({
      candidateId: primary.candidate.internal_id,
      jobId: primary.job.id,
    }).revocation_pending, false);
  }

  // A retry after the consent UPDATE and audit commit must reuse the original
  // request ID, finish latch cleanup, and preserve exactly one success audit.
  if (process.platform !== 'win32') {
    const idempotencyContext = seed('revocation-idempotency', 'candidate-idempotency-private-token');
    const requestId = 'synthetic-revoke-marker-clear-retry';
    confirm(idempotencyContext);
    const auditBefore = Number(database.prepare(`
      SELECT COUNT(*) AS n
      FROM audit_log
      WHERE action = '面试录音同意撤销' AND target = ?
    `).get(idempotencyContext.candidate.internal_id).n);
    const originalUnlinkSync = fs.unlinkSync;
    const originalFsyncSync = fs.fsyncSync;
    let failNextDirectoryFsync = false;
    fs.unlinkSync = (target) => {
      const result = originalUnlinkSync(target);
      if (path.resolve(target) === path.resolve(markerPath(idempotencyContext))) {
        failNextDirectoryFsync = true;
      }
      return result;
    };
    fs.fsyncSync = (descriptor) => {
      if (failNextDirectoryFsync) {
        failNextDirectoryFsync = false;
        throw new Error('synthetic marker directory fsync failure');
      }
      return originalFsyncSync(descriptor);
    };
    try {
      assert.throws(
        () => revoke(idempotencyContext, requestId),
        (error) => error && error.code === 'INTERVIEW_CONSENT_REVOCATION_MARKER_CLEAR_FAILED',
      );
    } finally {
      fs.unlinkSync = originalUnlinkSync;
      fs.fsyncSync = originalFsyncSync;
    }
    assertPending(idempotencyContext, 'idempotent marker-clear retry');
    assert.equal(Number(database.prepare(`
      SELECT COUNT(*) AS n
      FROM audit_log
      WHERE action = '面试录音同意撤销' AND target = ?
    `).get(idempotencyContext.candidate.internal_id).n), auditBefore + 1);
    revoke(idempotencyContext, requestId);
    assert.equal(db.getInterviewConsent({
      candidateId: idempotencyContext.candidate.internal_id,
      jobId: idempotencyContext.job.id,
    }).revocation_pending, false);
    const auditRows = database.prepare(`
      SELECT detail_json
      FROM audit_log
      WHERE action = '面试录音同意撤销' AND target = ?
    `).all(idempotencyContext.candidate.internal_id);
    assert.equal(auditRows.length, auditBefore + 1,
      'same-request retry must not duplicate the successful revocation audit');
    assert.equal(JSON.parse(auditRows.at(-1).detail_json).request_id, requestId);

    const conflictContext = seed('revocation-idempotency-conflict', 'candidate-idempotency-conflict-private-token');
    confirm(conflictContext);
    assert.throws(
      () => revoke(conflictContext, requestId),
      (error) => error && error.code === 'IDEMPOTENCY_CONFLICT',
      'reusing a revocation requestId for another scope must fail before any revocation side effect',
    );
    assert.equal(db.getInterviewConsent({
      candidateId: conflictContext.candidate.internal_id,
      jobId: conflictContext.job.id,
    }).valid, true);
    assert.equal(db.getInterviewConsent({
      candidateId: conflictContext.candidate.internal_id,
      jobId: conflictContext.job.id,
    }).revocation_pending, false);
  }

  // Candidate-bound record and mic-check startup handshakes both consult the
  // combined gate, while another candidate/job remains usable.
  confirm(primary);
  const activeConsent = db.getInterviewConsent({
    candidateId: primary.candidate.internal_id,
    jobId: primary.job.id,
  });
  db.beginInterviewConsentRevocationGate({
    candidateId: primary.candidate.internal_id,
    jobId: primary.job.id,
  });
  const { localInterviewStartConsentValid, withdrawInterviewLifecycleAndStop } = require("../src/action-server");
  assert.equal(localInterviewStartConsentValid({
    mode: 'record',
    bindCandidateId: primary.candidate.internal_id,
    bindJobId: primary.job.id,
    bindRound: 1,
    bindConsentId: activeConsent.id,
  }), false);
  assert.equal(localInterviewStartConsentValid({
    mode: 'mic-check',
    bindCandidateId: primary.candidate.internal_id,
    bindJobId: primary.job.id,
    bindRound: 1,
    bindConsentId: activeConsent.id,
    micCheckConsentConfirmed: true,
  }), false);
  revoke(primary);

  // Lifecycle fault leaves the shared candidate/job gate pending. A successful
  // retry revokes consent and clears both durable sinks.
  const lifecycleContext = seed('revocation-lifecycle', 'candidate-lifecycle-private-token');
  confirm(lifecycleContext);
  const createdSession = db.createInterviewSession({
    candidateId: lifecycleContext.candidate.internal_id,
    jobId: lifecycleContext.job.id,
    round: 1,
    mode: 'online',
    status: 'draft',
  });
  const session = db.getInterviewSession(createdSession.id);
  database.exec(`
    CREATE TRIGGER fail_lifecycle_withdraw
    BEFORE UPDATE OF state ON interview_lifecycle_session
    WHEN NEW.state = 'withdrawn'
    BEGIN
      SELECT RAISE(ABORT, 'synthetic lifecycle withdraw failure');
    END;
  `);
  const failedLifecycle = withdrawInterviewLifecycleAndStop(session, {
    sessionId: session.id,
    reasonCode: 'candidate_withdrew',
  }, {
    requestStop: () => ({ matched: false, stopped: false, job: null }),
  });
  assert.match(failedLifecycle.lifecycleError.message, /synthetic lifecycle withdraw failure/);
  assertPending(lifecycleContext, 'lifecycle fault');
  assert.equal(fs.existsSync(markerPath(lifecycleContext)), true);
  database.exec('DROP TRIGGER fail_lifecycle_withdraw');
  const completedLifecycle = withdrawInterviewLifecycleAndStop(session, {
    sessionId: session.id,
    reasonCode: 'candidate_withdrew',
  }, {
    requestStop: () => ({ matched: false, stopped: false, job: null }),
  });
  assert.equal(completedLifecycle.lifecycleError, null);
  assert.equal(completedLifecycle.lifecycle.state, 'withdrawn');
  assert.equal(consentRow(database, lifecycleContext).status, 'revoked');
  assert.equal(databaseGateCount(database, lifecycleContext), 0);
  assert.equal(fs.existsSync(markerPath(lifecycleContext)), false);

  // Removing the new table from an otherwise-current database must trigger the
  // migration backup gate before openDb repairs it.
  database.close();
  const raw = new Database(DB_PATH);
  raw.exec('DROP TABLE interview_recording_consent_revocation_gate');
  raw.close();
  const migration = await db.prepareDatabaseMigrationBackup(DB_PATH, {
    recoveryRoot: RECOVERY_ROOT,
    recoveryId: 'consent-revocation-gate-table-migration',
    createdAt: '2026-07-23T06:00:00.000Z',
  });
  assert.equal(migration.backup_required, true);
  database = db.openDb(DB_PATH);
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS n
    FROM sqlite_master
    WHERE type = 'table' AND name = 'interview_recording_consent_revocation_gate'
  `).get().n), 1);
  database.close();

  const dbSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/db.js"), 'utf8');
  const uiSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/InterviewReviewPanel.jsx'), 'utf8');
  assert.match(dbSource, /'interview_recording_consent_revocation_gate', 'interview_session'/,
    'migration preflight must require the revocation gate table');
  assert.match(uiSource, /err\?\.data\?\.lifecycle_write_failed[\s\S]*setConsentRefreshToken/,
    'lifecycle write failure must refresh the mounted consent gate');

  console.log(JSON.stringify({
    ok: true,
    contract: 'INTERVIEW-CONSENT-REVOCATION-LATCH-001',
    durable_db_gate: true,
    durable_hash_marker: true,
    child_restart_verified: true,
    update_and_audit_faults_verified: true,
    retry_audit_idempotency_verified: true,
    lifecycle_fault_verified: true,
    migration_backup_verified: true,
    symlink_and_malformed_fail_closed: true,
    no_real_microphone_used: true,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
