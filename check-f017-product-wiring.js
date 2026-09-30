'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
const { issueAssessmentFileSelection } = require('./assessment-file-selection');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-f017-product-wiring-'));
const assessmentStatusParityFields = [
  'enabled',
  'scope',
  'decision_use',
  'decision_use_mode',
  'automated_decision_use',
  'automatic_scoring_enabled',
  'automatic_ranking_enabled',
  'ranking_requires_hr_confirmed_binding',
  'automatic_disposition_enabled',
  'scoring_source',
  'supplier_numeric_reference_enabled',
  'ai_assisted_analysis_enabled',
  'ai_requires_per_use_hr_approval',
  'ai_result_requires_hr_review',
  'original_pdf_view_enabled',
  'real_pdf_pilot_allowed',
  'internal_feature_available',
  'archive_read_enabled',
  'retention_policy_configured',
  'retention_policy_version',
  'retention_days',
  'delete_enabled',
  'export_enabled',
];
const selectAssessmentStatusParity = (status) => Object.fromEntries(
  assessmentStatusParityFields.map((field) => [field, status[field]]),
);
let child = null;
process.on('exit', () => {
  try { child?.kill('SIGKILL'); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function request(port, token, method, requestPath, body = null) {
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: requestPath, method,
      headers: {
        'x-hrboss-token': token,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForHealth(port, token) {
  const deadline = Date.now() + 15_000;
  let lastResponse = null;
  while (Date.now() < deadline) {
    try {
      const response = await request(port, token, 'GET', '/api/health');
      if (response.status === 200) return;
      lastResponse = response;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`synthetic F017 server did not become healthy: ${JSON.stringify(lastResponse)}`);
}

async function run() {
  const actionSource = fs.readFileSync(path.join(__dirname, 'action-server.js'), 'utf8');
  assert.match(actionSource, /openDbWithMigrationBackup\(undefined, \{[\s\S]*assessmentDataRoot:/,
    'action startup must pass HRBOSS_DATA_DIR into the joint Assessment migration backup gate');
  const port = await freePort();
  const token = 'synthetic-f017-local-api-token-'.repeat(2);
  const assessmentSelectionSecret = 'synthetic-assessment-selection-secret-for-wiring-check';
  const dbPath = path.join(root, 'synthetic.db');
  const childEnv = { ...process.env };
  childEnv.HRBOSS_ASSESSMENT_RETENTION_POLICY_VERSION = 'synthetic-f017-retention-v1';
  childEnv.HRBOSS_ASSESSMENT_RETENTION_DAYS = '30';
  child = spawn(process.execPath, [path.join(__dirname, 'action-server.js')], {
    cwd: __dirname,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...childEnv,
      BOSS_ACTION_PORT: String(port),
      BOSS_DB_PATH: dbPath,
      HRBOSS_DATA_DIR: root,
      HRBOSS_LOCAL_API_TOKEN: token,
      HRBOSS_LOCAL_API_INSTANCE_ID: 'synthetic-f017-instance',
      HRBOSS_F009_APPROVAL_SECRET: 'synthetic-f009-secret-for-wiring-check',
      HRBOSS_ASSESSMENT_SELECTION_SECRET: assessmentSelectionSecret,
      HRBOSS_ASSESSMENT_PHASE_A_ENABLED: '1',
    },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  await waitForHealth(port, token);

  const status = await request(port, token, 'GET', '/api/assessment/status');
  assert.equal(status.status, 200);
  assert.deepEqual({
    enabled: status.body.enabled,
    scope: status.body.scope,
    decision_use: status.body.decision_use,
    decision_use_mode: status.body.decision_use_mode,
    automated_decision_use: status.body.automated_decision_use,
    automatic_scoring_enabled: status.body.automatic_scoring_enabled,
    automatic_ranking_enabled: status.body.automatic_ranking_enabled,
    ranking_requires_hr_confirmed_binding: status.body.ranking_requires_hr_confirmed_binding,
    automatic_disposition_enabled: status.body.automatic_disposition_enabled,
    scoring_source: status.body.scoring_source,
    supplier_numeric_reference_enabled: status.body.supplier_numeric_reference_enabled,
    ai_assisted_analysis_enabled: status.body.ai_assisted_analysis_enabled,
    ai_requires_per_use_hr_approval: status.body.ai_requires_per_use_hr_approval,
    ai_result_requires_hr_review: status.body.ai_result_requires_hr_review,
    real_pdf_pilot_allowed: status.body.real_pdf_pilot_allowed,
    original_pdf_view_enabled: status.body.original_pdf_view_enabled,
    retention_policy_configured: status.body.retention_policy_configured,
    retention_policy_version: status.body.retention_policy_version,
    retention_days: status.body.retention_days,
    delete_enabled: status.body.delete_enabled,
    export_enabled: status.body.export_enabled,
  }, {
    enabled: true,
    scope: 'hr_manual_assessment_reference',
    decision_use: true,
    decision_use_mode: 'hr_confirmed_assessment_reference',
    automated_decision_use: false,
    automatic_scoring_enabled: false,
    automatic_ranking_enabled: false,
    ranking_requires_hr_confirmed_binding: true,
    automatic_disposition_enabled: false,
    scoring_source: 'assessment_ai_fit_score_with_supplier_percentage_fallback',
    supplier_numeric_reference_enabled: true,
    ai_assisted_analysis_enabled: true,
    ai_requires_per_use_hr_approval: true,
    ai_result_requires_hr_review: true,
    real_pdf_pilot_allowed: false,
    original_pdf_view_enabled: false,
    retention_policy_configured: true,
    retention_policy_version: 'synthetic-f017-retention-v1',
    retention_days: 30,
    delete_enabled: true,
    export_enabled: false,
  });

  const forged = await request(port, token, 'POST', '/api/assessment/import', {
    candidate_id: 'C-SYNTHETIC', job_id: 1, report_type: 'unknown', request_id: 'REQ-FORGED',
    selection_token: 'renderer-forged-token', actor: 'forged-admin', actorRole: 'super_admin',
  });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.ok, false);
  assert.equal(forged.body.code, 'ASSESSMENT_SELECTION_REQUIRED');
  assert.equal(JSON.stringify(forged.body).includes('forged-admin'), false);

  const crossContextClassification = await request(port, token, 'POST', '/api/assessment/metadata/confirm', {
    binding_id: 'BINDING-NOT-IN-CONTEXT',
    document_id: 'DOCUMENT-NOT-IN-CONTEXT',
    candidate_id: 'CANDIDATE-NOT-IN-CONTEXT',
    job_id: 999,
    report_type: 'career_potential',
    assessment_date: null,
    expected_version: 1,
    request_id: 'REQ-CLASSIFY-CROSS-CONTEXT',
  });
  assert.equal(crossContextClassification.status, 400);
  assert.equal(crossContextClassification.body.code, 'BINDING_CONTEXT_MISMATCH');

  const writable = new Database(dbPath);
  const insertedJob = writable.prepare(`
    INSERT INTO job (encrypt_job_id, numeric_job_id, name, status, is_fixture, source_type, created_at, updated_at)
    VALUES (?, ?, ?, 'closed', 0, 'local_db', ?, ?)
  `).run('synthetic-f017-closed-job', '17001', '合成已关闭测评岗位', new Date().toISOString(), new Date().toISOString());
  const closedJobId = Number(insertedJob.lastInsertRowid);
  writable.prepare(`
    INSERT INTO candidate (internal_id, job_id, geek_id, source, name, keys_complete, created_at, updated_at)
    VALUES (?, ?, ?, 'synthetic', ?, 1, ?, ?)
  `).run('C-F017-CLOSED-GATE', closedJobId, 'G-F017-CLOSED-GATE', '合成候选人', new Date().toISOString(), new Date().toISOString());
  writable.close();

  const closedBinding = {
    source_path: path.join(root, 'synthetic-never-read.pdf'),
    candidate_id: 'C-F017-CLOSED-GATE',
    job_id: closedJobId,
    report_type: 'career_potential',
    assessment_date: null,
    request_id: 'REQ-F017-CLOSED-GATE',
  };
  const closedSelectionToken = issueAssessmentFileSelection(assessmentSelectionSecret, closedBinding);
  const closedImport = await request(port, token, 'POST', '/api/assessment/import', {
    ...closedBinding,
    selection_token: closedSelectionToken,
  });
  assert.equal(closedImport.status, 409);
  assert.equal(closedImport.body.code, 'JOB_CLOSED');

  const reopenedDatabase = new Database(dbPath);
  reopenedDatabase.prepare("UPDATE job SET status = 'open' WHERE id = ?").run(closedJobId);
  reopenedDatabase.close();
  const reopenedImport = await request(port, token, 'POST', '/api/assessment/import', {
    ...closedBinding,
    selection_token: closedSelectionToken,
  });
  assert.notEqual(reopenedImport.body.code, 'JOB_CLOSED');
  assert.notEqual(reopenedImport.body.code, 'ASSESSMENT_SELECTION_REPLAYED',
    'closed-job rejection must not consume the native file selection');

  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  child = null;
  assert.equal(stderr.includes('forged-admin'), false);
  const database = new Database(dbPath);
  const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const name of ['assessment_document', 'assessment_binding', 'assessment_event']) assert.ok(tables.has(name));
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM assessment_document').get().n, 0);
  database.pragma('wal_checkpoint(TRUNCATE)');
  database.close();

  const readonlyPort = await freePort();
  const readonlyAuditDir = path.join(root, 'readonly-audit');
  const readonlyAuditFile = path.join(readonlyAuditDir, 'sensitive-read-audit.jsonl');
  fs.mkdirSync(readonlyAuditDir, { mode: 0o700 });
  fs.writeFileSync(readonlyAuditFile, '', { mode: 0o600 });
  child = spawn(process.execPath, [path.join(__dirname, 'db-server.js')], {
    cwd: __dirname,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...childEnv,
      BOSS_DB_PATH: dbPath,
      BOSS_READONLY_PORT: String(readonlyPort),
      BOSS_READONLY_UI: '1',
      HRBOSS_DATA_DIR: root,
      HRBOSS_LOCAL_API_TOKEN: token,
      HRBOSS_LOCAL_API_INSTANCE_ID: 'synthetic-f017-readonly-instance',
      HRBOSS_ASSESSMENT_PHASE_A_ENABLED: '1',
      HRBOSS_SENSITIVE_READ_AUDIT_FILE: readonlyAuditFile,
      HRBOSS_EXTERNAL_AI_ENABLED: '0',
      HRBOSS_EXTERNAL_AI_API_KEY: '',
      HRBOSS_MAIBAO_API_KEY: '',
    },
  });
  let readonlyStderr = '';
  child.stderr.on('data', (chunk) => { readonlyStderr += chunk.toString('utf8'); });
  try {
    await waitForHealth(readonlyPort, token);
  } catch (error) {
    throw new Error(`${error.message}: ${readonlyStderr}`);
  }
  const readonlyStatus = await request(readonlyPort, token, 'GET', '/api/assessment/status');
  assert.equal(readonlyStatus.status, 200, readonlyStderr);
  assert.equal(readonlyStatus.body.operational_readonly, true);
  assert.deepEqual(
    selectAssessmentStatusParity(readonlyStatus.body),
    selectAssessmentStatusParity(status.body),
    'readonly and action assessment status must expose the same decision and AI capability truth',
  );
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  child = null;
  console.log('check-f017-product-wiring ok');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
