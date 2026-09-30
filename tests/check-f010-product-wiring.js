const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `f010-product-${process.pid}-`));
const DB_PATH = path.join(ROOT, 'product.db');
const LEGACY_DB_PATH = path.join(ROOT, 'legacy.db');
const MATERIAL_ROOT = path.join(ROOT, 'interviews');
const RECOVERY_ROOT = path.join(ROOT, 'recovery');
const PORT = 18800 + (process.pid % 800);
const TOKEN = 'f010-product-wiring-local-api-token-0000000000000001';

fs.mkdirSync(MATERIAL_ROOT, { recursive: true, mode: 0o700 });
process.env.BOSS_DB_PATH = DB_PATH;
process.env.HRBOSS_INTERVIEW_OUTPUT_DIR = MATERIAL_ROOT;
process.env.HRBOSS_RECOVERY_ROOT = RECOVERY_ROOT;
process.env.BOSS_ACTION_PORT = String(PORT);
process.env.HRBOSS_LOCAL_API_TOKEN = TOKEN;
process.env.HRBOSS_LOCAL_API_INSTANCE_ID = 'f010-product-wiring';

const db = require("../src/db");
const actionServer = require("../src/action-server");

const databases = new Set();
const trackDatabase = (database) => (databases.add(database), database);

function closeTrackedDatabases() {
  const errors = [];
  for (const database of [...databases].reverse()) {
    try {
      if (database && database.open) database.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'failed to close tracked fixture databases');
}

async function cleanup() {
  const errors = [];
  if (databases.size) {
    try { trackDatabase(db.conn()); } catch (error) { errors.push(error); }
  }
  try { await actionServer.shutdown(); } catch (error) { errors.push(error); }
  try { closeTrackedDatabases(); } catch (error) { errors.push(error); }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'check-f010-product-wiring cleanup failed');
}

function writeMaterial(directory, name, body) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, name);
  fs.writeFileSync(file, body, { mode: 0o600 });
  return file;
}

function post(pathname, body) {
  const payload = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: 'POST',
      headers: {
        'x-hrboss-token': TOKEN,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        body: responseBody ? JSON.parse(responseBody) : null,
      }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      headers: { 'x-hrboss-token': TOKEN },
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        body: responseBody ? JSON.parse(responseBody) : null,
      }));
    });
    request.on('error', reject);
  });
}

async function waitForHealth() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await new Promise((resolve, reject) => {
        const request = http.get({
          host: '127.0.0.1',
          port: PORT,
          path: '/api/health',
          headers: { 'x-hrboss-token': TOKEN },
        }, resolve);
        request.on('error', reject);
      });
      response.resume();
      if (response.statusCode === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('action server did not become ready');
}

function seedRecording(database, session, candidateId, jobId, suffix) {
  const directory = path.join(MATERIAL_ROOT, suffix);
  const source = writeMaterial(directory, 'source.mp4', `video-${suffix}`);
  const wav = writeMaterial(directory, 'recording.wav', `audio-${suffix}`);
  const transcript = writeMaterial(directory, 'transcript.txt', `transcript-${suffix}`);
  const draft = writeMaterial(directory, 'codex-input.md', `draft-${suffix}`);
  const timestamp = new Date().toISOString();
  const info = database.prepare(`
    INSERT INTO interview_recording (
      summary_path, topic, source_path, wav_path, transcript_txt_path,
      codex_input_path, candidate_id, job_id, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'matched', ?, ?)
  `).run(path.join(directory, 'summary.json'), suffix, source, wav, transcript, draft, candidateId, jobId, timestamp, timestamp);
  const recordingId = Number(info.lastInsertRowid);
  db.linkInterviewSessionRecording({ sessionId: session.id, recordingId, linkedBy: 'hr-admin-local' });
  db.linkInterviewSessionRecording({ sessionId: session.id, recordingId, linkedBy: 'hr-admin-local' });
  return { recordingId, source, wav, transcript, draft, directory };
}

(async () => {
  const database = trackDatabase(db.openDb(DB_PATH));
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='interview_lifecycle_session'").get(), 'openDb must apply lifecycle schema');

  const realNamedFixture = db.upsertJob({
    encrypt_job_id: '31ae3929da9921860nF52ty0GFpT',
    name: 'Fixture Platform Engineer',
  });
  assert.equal(realNamedFixture.is_fixture, 0, 'a real job name must not imply fixture status');
  const job = db.upsertJob({ encrypt_job_id: 'real-job-f010', name: '合成面试岗位' });
  const candidateId = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'synthetic-f010-candidate',
    name: '合成候选人',
  }).internal_id;

  const session1 = db.createInterviewSession({ candidateId, jobId: job.id, round: 1, mode: 'offline' });
  const replay = db.createInterviewSession({ candidateId, jobId: job.id, round: 1, mode: 'offline' });
  assert.equal(replay.id, session1.id);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_lifecycle_session WHERE id = ?').get(String(session1.id)).n, 1, 'session lifecycle must be idempotent');
  const first = seedRecording(database, session1, candidateId, job.id, 'round-1');
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_lifecycle_material WHERE session_id = ?').get(String(session1.id)).n, 5, 'actual source/audio/transcript/draft files and safe recording metadata must be registered once');

  const firstMaterialId = `recording-${first.recordingId}-source`;
  const stagingDirectory = path.join(MATERIAL_ROOT, '.delete-staging');
  fs.mkdirSync(stagingDirectory, { recursive: true, mode: 0o700 });
  const staged = path.join(stagingDirectory, crypto.createHash('sha256').update(`hrboss-delete:${firstMaterialId}`).digest('hex'));
  fs.renameSync(first.source, staged);

  const session2 = db.createInterviewSession({ candidateId, jobId: job.id, round: 2, mode: 'offline' });
  const second = seedRecording(database, session2, candidateId, job.id, 'round-2');
  const legacyReport = database.prepare(`
    INSERT INTO interview_ai_report (
      recording_id, candidate_id, job_id, status, report_json, created_at, updated_at
    ) VALUES (?, ?, ?, 'draft', ?, ?, ?)
  `).run(second.recordingId, candidateId, job.id, JSON.stringify({ sensitive_legacy: 'must-delete' }), new Date().toISOString(), new Date().toISOString());
  database.prepare(`
    INSERT INTO interview_recording_confirmation (
      recording_id, field_key, field_label, extracted_value, corrected_value,
      status, evidence, note, created_at, updated_at
    ) VALUES (?, 'legacy-sensitive', 'Legacy', 'extract-secret', 'correct-secret',
      'corrected', 'evidence-secret', 'note-secret', ?, ?)
  `).run(second.recordingId, new Date().toISOString(), new Date().toISOString());
  db.linkInterviewSessionRecording({ sessionId: session2.id, recordingId: second.recordingId, linkedBy: 'hr-admin-local' });
  assert.ok(database.prepare('SELECT 1 FROM interview_lifecycle_material WHERE id = ?').get(`db-legacy-report-${legacyReport.lastInsertRowid}`));
  assert.ok(database.prepare('SELECT 1 FROM interview_lifecycle_material WHERE id = ?').get(`db-recording-confirmations-${second.recordingId}`));

  const session3 = db.createInterviewSession({ candidateId, jobId: job.id, round: 3, mode: 'offline' });
  const outside = writeMaterial(ROOT, 'outside.wav', 'outside-controlled-root');
  const invalidRecording = database.prepare(`
    INSERT INTO interview_recording (summary_path, wav_path, candidate_id, job_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'matched', ?, ?)
  `).run(path.join(ROOT, 'invalid-summary.json'), outside, candidateId, job.id, new Date().toISOString(), new Date().toISOString());
  assert.throws(
    () => db.linkInterviewSessionRecording({ sessionId: session3.id, recordingId: invalidRecording.lastInsertRowid, linkedBy: 'hr-admin-local' }),
    (error) => error && error.code === 'MATERIAL_FILE_INVALID',
  );
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM interview_session_material WHERE session_id = ?').get(session3.id).n, 0, 'material registration failure must roll back the outer session link transaction');

  const session4 = db.createInterviewSession({ candidateId, jobId: job.id, round: 4, mode: 'offline' });
  const wavOnly = writeMaterial(path.join(MATERIAL_ROOT, 'round-4'), 'recording.wav', 'synthetic-wav-only');
  const wavOnlyRecording = database.prepare(`
    INSERT INTO interview_recording (summary_path, source_path, wav_path, candidate_id, job_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'matched', ?, ?)
  `).run(path.join(MATERIAL_ROOT, 'round-4', 'summary.json'), wavOnly, wavOnly, candidateId, job.id, new Date().toISOString(), new Date().toISOString());
  db.linkInterviewSessionRecording({ sessionId: session4.id, recordingId: wavOnlyRecording.lastInsertRowid, linkedBy: 'hr-admin-local' });
  assert.ok(database.prepare('SELECT 1 FROM interview_lifecycle_material WHERE id = ?')
    .get(`recording-${wavOnlyRecording.lastInsertRowid}-source`), 'duplicate realpaths must be registered exactly once using stable suffix order');

  const session5 = db.createInterviewSession({ candidateId, jobId: job.id, round: 5, mode: 'offline' });
  const metadataOnlyRecording = database.prepare(`
    INSERT INTO interview_recording (summary_path, candidate_id, job_id, status, created_at, updated_at)
    VALUES (?, ?, ?, 'matched', ?, ?)
  `).run(path.join(MATERIAL_ROOT, 'round-5', 'summary.json'), candidateId, job.id, new Date().toISOString(), new Date().toISOString());
  db.linkInterviewSessionRecording({ sessionId: session5.id, recordingId: metadataOnlyRecording.lastInsertRowid, linkedBy: 'hr-admin-local' });
  const currentNoRepeat = await db.prepareDatabaseMigrationBackup(DB_PATH, { recoveryRoot: RECOVERY_ROOT });
  assert.equal(currentNoRepeat.backup_required, false, 'recordings without controlled material paths must not trigger a backup loop');

  await actionServer.startHttpServer();
  trackDatabase(db.conn());
  await waitForHealth();
  assert.equal(fs.existsSync(first.source), true, 'startup must restore an interrupted active material deletion');
  assert.equal(fs.existsSync(staged), false, 'startup recovery must consume the staged file');

  let response = await post('/api/profile', { jobId: job.id, config: { rubric: 'must not write' } });
  assert.equal(response.status, 404, 'legacy direct profile overwrite route must be removed');

  response = await post('/api/interview-lifecycle/legal-hold/apply', {
    sessionId: session2.id,
    reasonCode: 'litigation_review',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    actorRole: 'legal',
  });
  assert.equal(response.status, 200);
  const holdId = response.body.hold.hold_id;
  assert.equal(database.prepare('SELECT actor_role FROM interview_lifecycle_hold WHERE id = ?').get(holdId).actor_role, 'hr_admin', 'body.actorRole must not control the server role');
  response = await get(`/api/interview-lifecycle/status?sessionId=${session2.id}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.lifecycle.active_holds[0].hold_id, holdId, 'status route must expose the server-owned active hold after refresh');

  database.prepare('UPDATE interview_lifecycle_material SET delete_after = ? WHERE id = ?')
    .run('2000-01-01T00:00:00.000Z', `recording-${second.recordingId}-source`);
  response = await post('/api/interview-lifecycle/deletion/dry-run', { sessionId: session2.id });
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'LEGAL_HOLD_ACTIVE');

  response = await post('/api/interview-lifecycle/legal-hold/release', {
    holdId,
    reasonCode: 'review_complete',
    confirmed: true,
    actorRole: 'legal',
  });
  assert.equal(response.status, 200);
  assert.equal(database.prepare("SELECT actor_role FROM interview_lifecycle_event WHERE event_type = 'legal_hold_released' AND session_id = ? ORDER BY created_at DESC LIMIT 1").get(String(session2.id)).actor_role, 'hr_admin');

  response = await post('/api/interview-lifecycle/deletion/dry-run', { sessionId: session2.id });
  assert.equal(response.status, 200);
  const manifest = response.body.manifest;
  response = await post('/api/interview-lifecycle/deletion/confirm', {
    manifestId: manifest.manifest_id,
    confirmationToken: manifest.confirmation_token,
    reasonCode: 'retention_due',
  });
  assert.equal(response.status, 400, 'deletion must require explicit confirmation');
  response = await post('/api/interview-lifecycle/deletion/confirm', {
    manifestId: manifest.manifest_id,
    confirmationToken: manifest.confirmation_token,
    reasonCode: 'retention_due',
    confirmed: true,
    actorRole: 'legal',
  });
  assert.equal(response.status, 200);
  assert.equal(fs.existsSync(second.source), false, 'confirmed deletion must remove the registered file');
  assert.ok(db.getInterviewRecording(second.recordingId, { access: 'transcript' }).transcript_txt_path, 'raw expiry at 30 days must not shorten transcript retention');
  const linkedMaterialId = database.prepare('SELECT id FROM interview_session_material WHERE interview_recording_id = ?').get(second.recordingId).id;
  assert.equal(db.getF009InterviewMaterials({ sessionId: session2.id, materialIds: [linkedMaterialId] }).materials.length, 1);
  database.prepare("UPDATE interview_lifecycle_material SET delete_after = ? WHERE session_id = ? AND state = 'active'")
    .run('2000-01-01T00:00:00.000Z', String(session2.id));
  const remainingManifest = db.createInterviewDeletionDryRun({ sessionId: session2.id });
  db.confirmInterviewDeletion({
    manifestId: remainingManifest.manifest_id,
    confirmationToken: remainingManifest.confirmation_token,
    reasonCode: 'retention_due',
  });
  assert.equal(database.prepare('SELECT 1 FROM interview_ai_report WHERE id = ?').get(legacyReport.lastInsertRowid), undefined, 'legacy report payload must be physically deleted');
  assert.deepEqual(database.prepare(`
    SELECT extracted_value, corrected_value, evidence, note
    FROM interview_recording_confirmation WHERE recording_id = ?
  `).get(second.recordingId), { extracted_value: null, corrected_value: null, evidence: null, note: null });
  for (const [file, body] of [[second.source, 'rebuilt-video'], [second.wav, 'rebuilt-audio'], [second.transcript, 'rebuilt-transcript'], [second.draft, 'rebuilt-draft']]) {
    fs.writeFileSync(file, body, { mode: 0o600 });
  }
  const rebuiltSummary = path.join(second.directory, 'summary.json');
  fs.writeFileSync(rebuiltSummary, JSON.stringify({
    summaryPath: rebuiltSummary,
    sourcePath: second.source,
    wavPath: second.wav,
    transcriptTxt: second.transcript,
    codexInput: second.draft,
    transcript: 'must-not-persist',
    report: 'must-not-persist',
    contact: 'must-not-persist',
  }), { mode: 0o600 });
  assert.equal(database.prepare('SELECT id FROM interview_recording WHERE summary_path = ?').get(rebuiltSummary).id, second.recordingId);
  assert.equal(db.getInterviewRecording(second.recordingId).transcript_txt_path, null, 'generic metadata read may continue but deleted paths must be cleared');
  assert.throws(() => db.getInterviewRecording(second.recordingId, { access: 'transcript' }), (error) => error && error.code === 'MATERIAL_DELETED');
  response = await get(`/api/interview-recording/transcript?recordingId=${second.recordingId}`);
  assert.equal(response.body.code, 'MATERIAL_DELETED');
  assert.throws(
    () => db.getF009InterviewMaterials({ sessionId: session2.id, materialIds: [linkedMaterialId] }),
    (error) => error && error.code === 'MATERIAL_DELETED',
  );
  assert.throws(
    () => db.createInterviewRecording({ summary_path: rebuiltSummary }),
    (error) => error && error.code === 'MATERIAL_DELETED',
  );
  assert.equal(database.prepare('SELECT raw_summary_json FROM interview_recording WHERE id = ?').get(second.recordingId).raw_summary_json, '{"state":"deleted"}');

  response = await post('/api/interview-lifecycle/close', {
    sessionId: session2.id,
    reasonCode: 'recruitment_closed',
    confirmed: true,
    actorRole: 'legal',
  });
  assert.equal(response.status, 200);
  assert.throws(
    () => db.setInterviewSessionStatus({ sessionId: session2.id, status: 'pending_review' }),
    (error) => error && error.code === 'PROCESSING_CLOSED',
  );

  db.recordInterviewConsent({ candidateId, jobId: job.id, confirmed: true, recordedBy: 'synthetic-test' });
  assert.equal(db.getInterviewConsent({ candidateId, jobId: job.id }).valid, true);
  response = await post('/api/interview-lifecycle/withdraw', {
    sessionId: session1.id,
    reasonCode: 'candidate_withdrawal',
    confirmed: true,
    actorRole: 'legal',
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.lifecycle.consent_revoked, true);
  assert.equal(db.getInterviewConsent({ candidateId, jobId: job.id }).valid, false);
  assert.equal(database.prepare("SELECT actor_role FROM interview_lifecycle_event WHERE event_type = 'session_withdrawn' AND session_id = ?").get(String(session1.id)).actor_role, 'hr_admin');
  assert.throws(
    () => db.saveInterviewReportV1({ sessionId: session1.id, actor: 'hr', requestId: 'blocked-save', expectedVersion: 0, report: {} }),
    (error) => error && error.code === 'PROCESSING_WITHDRAWN',
  );

  await actionServer.shutdown();
  database.close();

  const legacy = trackDatabase(new Database(LEGACY_DB_PATH));
  legacy.exec(`
    CREATE TABLE legacy_marker (id INTEGER PRIMARY KEY);
    INSERT INTO legacy_marker (id) VALUES (1);
    CREATE TABLE job (
      id INTEGER PRIMARY KEY,
      encrypt_job_id TEXT NOT NULL,
      numeric_job_id TEXT,
      name TEXT,
      hr_owner TEXT,
      created_at TEXT
    );
    INSERT INTO job (id, encrypt_job_id, name, created_at)
    VALUES (1, '31ae3929da9921860nF52ty0GFpT', 'Fixture Platform Engineer', '2026-07-01T00:00:00.000Z');
  `);
  legacy.close();
  await assert.rejects(
    () => db.openDbWithMigrationBackup(LEGACY_DB_PATH, {
      force: true,
      recoveryRoot: RECOVERY_ROOT,
      createBackup: async () => { throw new Error('synthetic backup failure'); },
    }),
    /synthetic backup failure/,
  );
  const unchanged = trackDatabase(new Database(LEGACY_DB_PATH, { readonly: true }));
  assert.equal(unchanged.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='interview_lifecycle_session'").get().n, 0, 'backup failure must prevent migration');
  unchanged.close();

  const opened = await db.openDbWithMigrationBackup(LEGACY_DB_PATH, { recoveryRoot: RECOVERY_ROOT });
  trackDatabase(opened.database);
  assert.equal(opened.backup.backup_required, true);
  assert.ok(fs.existsSync(path.join(RECOVERY_ROOT, opened.backup.recovery_id, 'manifest.json')), 'startup migration must create an explicit recovery package');
  assert.ok(opened.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='interview_lifecycle_session'").get());
  assert.equal(opened.database.prepare('SELECT is_fixture FROM job WHERE id = 1').get().is_fixture, 0, 'migration must not infer fixture status from a real job name');
  const noRepeatBackup = await db.prepareDatabaseMigrationBackup(LEGACY_DB_PATH, { recoveryRoot: RECOVERY_ROOT });
  assert.equal(noRepeatBackup.backup_required, false, 'a fully backfilled database must not trigger a migration backup on every startup');
  opened.database.close();

  return 'check-f010-product-wiring ok';
})().then(async (message) => {
  try {
    await cleanup();
    console.log(message);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}, async (error) => {
  let cleanupError = null;
  try { await cleanup(); } catch (caught) { cleanupError = caught; }
  console.error(error);
  if (cleanupError) console.error(cleanupError);
  process.exitCode = 1;
});
