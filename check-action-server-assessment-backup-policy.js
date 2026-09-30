'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const db = require('./db');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-action-assessment-backup-policy-'));
const children = new Set();
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('synthetic-action-startup-preview', 'ascii'),
]);

process.on('exit', () => {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch {}
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function seedMigrationDatabase(name, { withAssessmentDocument }) {
  const scenarioRoot = privateDirectory(path.join(root, name));
  const dataRoot = privateDirectory(path.join(scenarioRoot, 'data'));
  const databasePath = path.join(dataRoot, 'recruiting.db');
  const database = db.openDb(databasePath, { assessmentEnabled: true });
  let storageRelpath = null;
  if (withAssessmentDocument) {
    const pdf = Buffer.from(`%PDF-1.4\nsynthetic-${name}\n%%EOF\n`);
    const hash = crypto.createHash('sha256').update(pdf).digest('hex');
    storageRelpath = `accepted/sha256/${hash.slice(0, 2)}/${hash}.pdf`;
    const now = '2026-07-14T00:00:00.000Z';
    database.prepare(`
      INSERT INTO assessment_document (
        id, content_sha256, storage_relpath, byte_size, page_count,
        mime_detected, security_state, report_type, analysis_status,
        review_state, dispute_state, lifecycle_state, legal_hold_state,
        created_by, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 1, 'application/pdf', 'accepted', 'career_potential',
                'pending', 'ready', 'none', 'active', 'none', 'synthetic-test', 1, ?, ?)
    `).run(`DOC-${name}`, hash, storageRelpath, pdf.length, now, now);
    const assessmentRoot = privateDirectory(path.join(dataRoot, 'assessment'));
    const blobPath = path.join(assessmentRoot, storageRelpath);
    privateDirectory(path.dirname(blobPath));
    fs.writeFileSync(blobPath, pdf, { mode: 0o600 });
    const previewPath = path.join(
      assessmentRoot, 'previews', 'sha256', hash.slice(0, 2), hash, 'page-1.png',
    );
    privateDirectory(path.dirname(previewPath));
    fs.writeFileSync(previewPath, PNG, { mode: 0o600 });
  }
  // Make startup migration necessary without weakening the Assessment schema.
  database.exec('DROP TABLE interview_pending_assignment');
  database.close();
  return {
    scenarioRoot,
    dataRoot,
    databasePath,
    storageRelpath,
    assessmentRecoveryRoot: path.join(scenarioRoot, 'assessment-recovery'),
    recoveryRoot: path.join(scenarioRoot, 'recovery'),
  };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function requestHealth(port, token) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/api/health',
      method: 'GET',
      headers: { 'x-hrboss-token': token },
      timeout: 1000,
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.once('timeout', () => request.destroy(new Error('health request timed out')));
    request.end();
  });
}

async function spawnScenario(scenario, policyEnv = {}) {
  const port = await freePort();
  const token = `synthetic-assessment-backup-policy-${path.basename(scenario.scenarioRoot)}-token`;
  const env = {
    ...process.env,
    BOSS_ACTION_PORT: String(port),
    BOSS_DB_PATH: scenario.databasePath,
    BOSS_PROFILE_DATA_DIR: path.join(scenario.scenarioRoot, 'profile'),
    BOSS_RECOMMEND_PROGRESS_FILE: path.join(scenario.scenarioRoot, 'recommend-progress.json'),
    BOSS_JOB_SYNC_PROGRESS_FILE: path.join(scenario.scenarioRoot, 'job-progress.json'),
    BOSS_RESUME_PROGRESS_FILE: path.join(scenario.scenarioRoot, 'resume-progress.json'),
    BOSS_SCREENSHOT_IMPORT_PROGRESS_FILE: path.join(scenario.scenarioRoot, 'screenshot-progress.json'),
    HRBOSS_DATA_DIR: scenario.dataRoot,
    HRBOSS_INTERVIEW_OUTPUT_DIR: path.join(scenario.scenarioRoot, 'interviews'),
    HRBOSS_RECOVERY_ROOT: scenario.recoveryRoot,
    HRBOSS_ASSESSMENT_RECOVERY_ROOT: scenario.assessmentRecoveryRoot,
    HRBOSS_LOCAL_API_TOKEN: token,
    HRBOSS_LOCAL_API_INSTANCE_ID: `synthetic-${path.basename(scenario.scenarioRoot)}`,
    HRBOSS_F009_APPROVAL_SECRET: 'synthetic-f009-approval-secret-for-backup-policy-check',
    HRBOSS_ASSESSMENT_SELECTION_SECRET: 'synthetic-assessment-selection-secret-for-backup-policy-check',
    HRBOSS_ASSESSMENT_PHASE_A_ENABLED: '1',
    ...policyEnv,
  };
  delete env.HRBOSS_ASSESSMENT_BACKUP_POLICY_VERSION;
  delete env.HRBOSS_ASSESSMENT_BACKUP_RETENTION_DAYS;
  Object.assign(env, policyEnv);
  const child = spawn(process.execPath, [path.join(__dirname, 'action-server.js')], {
    cwd: __dirname,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
  child.once('exit', () => children.delete(child));
  return { child, port, token, output: () => output };
}

async function waitForHealthy(runtime) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null) {
      throw new Error(`action server exited before health check: ${runtime.output()}`);
    }
    try {
      if (await requestHealth(runtime.port, runtime.token) === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`action server did not become healthy: ${runtime.output()}`);
}

function waitForExit(child, timeoutMs = 15_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('action server exit timed out')), timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function stopHealthy(runtime) {
  runtime.child.kill('SIGTERM');
  assert.equal(await waitForExit(runtime.child), 0, runtime.output());
}

function hasTable(databasePath, tableName) {
  const database = require('better-sqlite3')(databasePath, { readonly: true });
  try {
    return Boolean(database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(tableName));
  } finally {
    database.close();
  }
}

async function run() {
  const configured = seedMigrationDatabase('configured', { withAssessmentDocument: true });
  const configuredRuntime = await spawnScenario(configured, {
    HRBOSS_ASSESSMENT_BACKUP_POLICY_VERSION: 'p1-internal-30d-v1',
    HRBOSS_ASSESSMENT_BACKUP_RETENTION_DAYS: '30',
  });
  await waitForHealthy(configuredRuntime);
  await stopHealthy(configuredRuntime);
  assert.equal(hasTable(configured.databasePath, 'interview_pending_assignment'), true);
  const packages = fs.readdirSync(configured.assessmentRecoveryRoot);
  assert.equal(packages.length, 1);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(configured.assessmentRecoveryRoot, packages[0], 'manifest.json'), 'utf8',
  ));
  assert.equal(manifest.policy_version, 'p1-internal-30d-v1');
  assert.equal(manifest.backup_retention_days, 30);
  assert.equal(manifest.documents.length, 1);
  assert.ok(fs.existsSync(path.join(
    configured.assessmentRecoveryRoot, packages[0], 'files', configured.storageRelpath,
  )));

  const missing = seedMigrationDatabase('missing', { withAssessmentDocument: true });
  const missingRuntime = await spawnScenario(missing);
  const missingExit = await waitForExit(missingRuntime.child);
  assert.notEqual(missingExit, 0);
  assert.match(missingRuntime.output(), /approved Assessment backup policy version is required/);
  assert.equal(hasTable(missing.databasePath, 'interview_pending_assignment'), false);
  assert.equal(fs.existsSync(missing.assessmentRecoveryRoot), false);

  const invalid = seedMigrationDatabase('invalid', { withAssessmentDocument: false });
  const invalidRuntime = await spawnScenario(invalid, {
    HRBOSS_ASSESSMENT_BACKUP_POLICY_VERSION: 'p1-internal-30d-v1',
    HRBOSS_ASSESSMENT_BACKUP_RETENTION_DAYS: '30 days',
  });
  const invalidExit = await waitForExit(invalidRuntime.child);
  assert.notEqual(invalidExit, 0);
  assert.match(invalidRuntime.output(), /HRBOSS_ASSESSMENT_BACKUP_RETENTION_DAYS must be a positive integer/);
  assert.equal(hasTable(invalid.databasePath, 'interview_pending_assignment'), false);

  const withoutDocuments = seedMigrationDatabase('without-documents', { withAssessmentDocument: false });
  const withoutDocumentsRuntime = await spawnScenario(withoutDocuments);
  await waitForHealthy(withoutDocumentsRuntime);
  await stopHealthy(withoutDocumentsRuntime);
  assert.equal(hasTable(withoutDocuments.databasePath, 'interview_pending_assignment'), true);
  assert.equal(fs.existsSync(withoutDocuments.assessmentRecoveryRoot), false);

  console.log('check-action-server-assessment-backup-policy ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
