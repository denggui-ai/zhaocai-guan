'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const vm = require('node:vm');
process.env.SQLITE_USE_URI = '1';
const Database = require('better-sqlite3');
const db = require('./db');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-g0-d2-readonly-'));
const DB_PATH = path.join(ROOT, 'operational.db');
const MISSING_DB_PATH = path.join(ROOT, 'missing-assessment-schema.db');
const GUARD_PATH = path.join(ROOT, 'readonly-runtime-guard.js');
const TOKEN = 'synthetic-g0-d2-operational-readonly-token-0001';
const children = new Set();

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `missing production function ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated production function ${name}`);
}

function frontendSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return frontendSourceFiles(target);
    return /\.(?:js|jsx)$/.test(entry.name) ? [target] : [];
  });
}

function runRendererPreferenceScenario(appSource, readOnly) {
  const writes = [];
  const stored = new Map([['sentinel', 'unchanged']]);
  const brandNames = [];
  const brandMarks = [];
  const sandbox = {
    READONLY_UI: readOnly,
    window: {
      localStorage: {
        setItem(key, value) {
          writes.push([key, value]);
          stored.set(key, value);
        },
      },
    },
    BRAND_NAME_STORAGE_KEY: 'hrboss.ui.brandName.v1',
    BRAND_MARK_STORAGE_KEY: 'hrboss.ui.brandMark.v1',
    APP_NAV_COLLAPSED_STORAGE_KEY: 'hrboss.ui.appNavCollapsed.v1',
    CANDIDATE_LIST_COLLAPSED_STORAGE_KEY: 'hrboss.ui.candidateListCollapsed.v1',
    CURRENT_JOB_ID_STORAGE_KEY: 'hrboss.ui.currentJobId.v1',
    DEFAULT_BRAND_NAME: '招才官',
    DEFAULT_BRAND_MARK: '招',
    setBrandName: (value) => brandNames.push(value),
    setBrandMark: (value) => brandMarks.push(value),
  };
  const names = [
    'normalizeBrandName',
    'normalizeBrandMark',
    'persistUiPreference',
    'writeStoredBoolean',
    'writeStoredJobId',
    'handleBrandNameChange',
    'handleBrandMarkChange',
  ];
  const declarations = names.map((name) => extractFunction(appSource, name)).join('\n');
  vm.runInNewContext(`${declarations}\nthis.production = { ${names.join(', ')} };`, sandbox);
  const production = sandbox.production;
  const results = [
    production.writeStoredBoolean(sandbox.APP_NAV_COLLAPSED_STORAGE_KEY, false),
    production.writeStoredBoolean(sandbox.CANDIDATE_LIST_COLLAPSED_STORAGE_KEY, false),
    production.writeStoredJobId(101),
    production.writeStoredJobId(202),
    production.handleBrandMarkChange('abc'),
    production.handleBrandNameChange(' 测试品牌 '),
    production.handleBrandMarkChange(sandbox.DEFAULT_BRAND_MARK),
    production.handleBrandNameChange(sandbox.DEFAULT_BRAND_NAME),
  ].map((result) => (typeof result === 'object' ? result.persisted : result));
  return { writes, stored, brandNames, brandMarks, results };
}

function runNoWindowPreferenceScenario(appSource) {
  const sandbox = { READONLY_UI: false };
  vm.runInNewContext(
    `${extractFunction(appSource, 'persistUiPreference')}\nthis.persist = persistUiPreference;`,
    sandbox,
  );
  return sandbox.persist('synthetic-key', 'synthetic-value');
}

function schemaSnapshot(file) {
  const database = new Database(`${pathToFileURL(path.resolve(file)).href}?immutable=1`, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      ORDER BY type, name
    `).all();
  } finally {
    database.close();
  }
}

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

function request(port, token, method, pathname) {
  return new Promise((resolve, reject) => {
    const body = method === 'GET' ? '' : '{}';
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: pathname,
      headers: {
        'x-hrboss-token': token,
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
      },
      timeout: 3000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new Error('request timeout')));
    req.end(body);
  });
}

async function startReadonlyServer(databasePath, label) {
  const port = await freePort();
  const auditDir = path.join(ROOT, `audit-${label}`);
  const auditFile = path.join(auditDir, 'sensitive-read-audit.jsonl');
  fs.mkdirSync(auditDir, { mode: 0o700 });
  fs.writeFileSync(auditFile, '', { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(__dirname, 'db-server.js')], {
    cwd: __dirname,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || '1',
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${GUARD_PATH}`.trim(),
      BOSS_DB_PATH: databasePath,
      BOSS_READONLY_PORT: String(port),
      BOSS_READONLY_UI: '1',
      HRBOSS_ASSESSMENT_PHASE_A_ENABLED: '1',
      HRBOSS_LOCAL_API_TOKEN: TOKEN,
      HRBOSS_LOCAL_API_INSTANCE_ID: `synthetic-g0-d2-${label}`,
      HRBOSS_SENSITIVE_READ_AUDIT_FILE: auditFile,
      HRBOSS_ALLOWED_AUDIT_FILE: auditFile,
      HRBOSS_EXTERNAL_AI_ENABLED: '0',
      HRBOSS_EXTERNAL_AI_API_KEY: '',
      HRBOSS_MAIBAO_API_KEY: '',
    },
  });
  children.add(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`readonly server exited early: ${stderr}`);
    try {
      const health = await request(port, TOKEN, 'GET', '/api/health');
      if (health.status === 200) return { child, port, auditFile, stderr: () => stderr };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`readonly server did not become healthy: ${stderr}`);
}

async function stopReadonlyServer(server) {
  if (!server || server.child.exitCode !== null) return;
  const exited = new Promise((resolve) => server.child.once('exit', resolve));
  server.child.kill('SIGTERM');
  await exited;
  children.delete(server.child);
}

function expectOk(result, label) {
  assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.ok, true, label);
  return result.body;
}

function seedFixture() {
  const database = db.openDb(DB_PATH, { assessmentEnabled: true, f018Enabled: false });
  const job = db.upsertJob({
    encrypt_job_id: 'g0-d2-operational-readonly-job',
    name: '操作只读合成岗位',
    source_type: 'fixture',
    is_fixture: true,
  });
  const candidate = db.upsertCandidate({
    job_id: job.id,
    geek_id: 'g0-d2-operational-readonly-candidate',
    name: '只读合成候选人',
    source: 'fixture',
  });
  db.insertInterview({
    job_id: job.id,
    transcript: '这是仅用于 D2 回归的合成负责人访谈。',
    note: '合成历史访谈',
    source_type: 'manual_transcript',
  });
  const session = db.createInterviewSession({
    candidateId: candidate.internal_id,
    jobId: job.id,
    round: 1,
    interviewFormat: 'offline',
  });
  database.close();
  fs.chmodSync(DB_PATH, 0o600);
  return { jobId: job.id, candidateId: candidate.internal_id, sessionId: session.id };
}

function installChildRuntimeGuard() {
  fs.writeFileSync(GUARD_PATH, `
'use strict';
const childProcess = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => { throw new Error('G0_D2_FORBIDDEN_SUBPROCESS:' + name); };
}
process.kill = () => { throw new Error('G0_D2_FORBIDDEN_PROCESS_KILL'); };
const http = require('node:http');
const https = require('node:https');
http.request = http.get = () => { throw new Error('G0_D2_FORBIDDEN_OUTBOUND_HTTP'); };
https.request = https.get = () => { throw new Error('G0_D2_FORBIDDEN_OUTBOUND_HTTPS'); };
const net = require('node:net');
const tls = require('node:tls');
net.connect = net.createConnection = () => { throw new Error('G0_D2_FORBIDDEN_OUTBOUND_NET'); };
tls.connect = () => { throw new Error('G0_D2_FORBIDDEN_OUTBOUND_TLS'); };
globalThis.fetch = () => Promise.reject(new Error('G0_D2_FORBIDDEN_FETCH'));

const fs = require('node:fs');
const path = require('node:path');
const allowedAuditFile = path.resolve(process.env.HRBOSS_ALLOWED_AUDIT_FILE || '');
const writableAuditFds = new Set();
const originalOpenSync = fs.openSync;
const originalWriteSync = fs.writeSync;
const originalFsyncSync = fs.fsyncSync;
const originalCloseSync = fs.closeSync;
function writesWithFlags(flags) {
  if (typeof flags === 'string') return /[wa+]/.test(flags);
  const mask = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT
    | fs.constants.O_TRUNC | fs.constants.O_APPEND;
  return (Number(flags) & mask) !== 0;
}
fs.openSync = (target, flags, ...args) => {
  if (!writesWithFlags(flags)) return originalOpenSync(target, flags, ...args);
  if (path.resolve(String(target)) !== allowedAuditFile) throw new Error('G0_D2_FORBIDDEN_FILE_OPEN:' + target);
  const fd = originalOpenSync(target, flags, ...args);
  writableAuditFds.add(fd);
  return fd;
};
fs.writeSync = (fd, ...args) => {
  if (!writableAuditFds.has(fd)) throw new Error('G0_D2_FORBIDDEN_FILE_WRITE');
  return originalWriteSync(fd, ...args);
};
fs.fsyncSync = (fd) => {
  if (!writableAuditFds.has(fd)) throw new Error('G0_D2_FORBIDDEN_FILE_FSYNC');
  return originalFsyncSync(fd);
};
fs.closeSync = (fd) => {
  writableAuditFds.delete(fd);
  return originalCloseSync(fd);
};
for (const name of [
  'appendFileSync', 'chmodSync', 'chownSync', 'copyFileSync', 'createWriteStream',
  'fchmodSync', 'fchownSync', 'ftruncateSync', 'futimesSync', 'linkSync', 'mkdirSync',
  'renameSync', 'rmSync', 'rmdirSync', 'symlinkSync', 'truncateSync', 'unlinkSync',
  'utimesSync', 'writeFileSync',
]) {
  fs[name] = () => { throw new Error('G0_D2_FORBIDDEN_FILE_MUTATION:' + name); };
}
`, { mode: 0o600 });
}

async function main() {
  installChildRuntimeGuard();
  const fixture = seedFixture();
  const before = {
    hash: sha256(DB_PATH),
    stat: fs.statSync(DB_PATH),
    schema: schemaSnapshot(DB_PATH),
  };
  for (const suffix of ['-wal', '-shm', '-journal']) {
    assert.equal(fs.existsSync(`${DB_PATH}${suffix}`), false, `fixture must start without SQLite sidecar ${suffix}`);
  }
  let server = await startReadonlyServer(DB_PATH, 'complete');
  let completeAuditFile;
  try {
    completeAuditFile = server.auditFile;
    const assessmentStatus = expectOk(await request(server.port, TOKEN, 'GET', '/api/assessment/status'), 'assessment status');
    assert.equal(assessmentStatus.operational_readonly, true);
    assert.deepEqual(expectOk(await request(server.port, TOKEN, 'GET', `/api/assessment/archive?candidateId=${encodeURIComponent(fixture.candidateId)}&jobId=${fixture.jobId}`), 'assessment archive').archives, []);
    assert.deepEqual(expectOk(await request(server.port, TOKEN, 'GET', `/api/assessment/queue?jobId=${fixture.jobId}`), 'assessment queue').queue, []);
    assert.deepEqual(expectOk(await request(server.port, TOKEN, 'GET', `/api/assessment/ai-analysis?candidateId=${encodeURIComponent(fixture.candidateId)}&jobId=${fixture.jobId}`), 'assessment AI history').analyses, []);
    const profile = expectOk(await request(server.port, TOKEN, 'GET', `/api/profile?jobId=${fixture.jobId}`), 'profile history');
    assert.ok(profile.config && typeof profile.config === 'object');
    assert.ok(profile.generation_readiness && typeof profile.generation_readiness.ready === 'boolean');
    const journeyOperations = expectOk(await request(
      server.port,
      TOKEN,
      'GET',
      `/api/candidate-journey-operations?candidateId=${encodeURIComponent(fixture.candidateId)}&jobId=${fixture.jobId}`,
    ), 'candidate journey operations');
    assert.equal(journeyOperations.candidate_id, fixture.candidateId);
    assert.equal(journeyOperations.next_action, null);
    assert.deepEqual(journeyOperations.manager_feedback, []);
    assert.deepEqual(journeyOperations.offer_history, []);
    assert.equal(expectOk(await request(server.port, TOKEN, 'GET', `/api/interview?jobId=${fixture.jobId}`), 'interview history').interviews.length, 1);
    assert.equal(expectOk(await request(server.port, TOKEN, 'GET', `/api/interview-session?candidateId=${encodeURIComponent(fixture.candidateId)}&jobId=${fixture.jobId}`), 'interview sessions').sessions.length, 1);
    assert.deepEqual(expectOk(await request(server.port, TOKEN, 'GET', `/api/interview-recording?candidateId=${encodeURIComponent(fixture.candidateId)}&jobId=${fixture.jobId}`), 'interview recordings').recordings, []);
    assert.deepEqual(expectOk(await request(server.port, TOKEN, 'GET', `/api/interview-assignment?jobId=${fixture.jobId}`), 'interview assignments').assignments, []);
    assert.equal(expectOk(await request(server.port, TOKEN, 'GET', `/api/interview-consent?candidateId=${encodeURIComponent(fixture.candidateId)}&jobId=${fixture.jobId}`), 'interview consent').consent, null);
    assert.equal(expectOk(await request(server.port, TOKEN, 'GET', `/api/interview-script?jobId=${fixture.jobId}`), 'interview script').script, null);
    assert.equal(expectOk(await request(server.port, TOKEN, 'GET', `/api/interview-report?sessionId=${fixture.sessionId}`), 'interview report').report, null);
    assert.equal(Number(expectOk(await request(server.port, TOKEN, 'GET', `/api/interview-lifecycle/status?sessionId=${fixture.sessionId}`), 'interview lifecycle').lifecycle.session_id), fixture.sessionId);
    expectOk(await request(server.port, TOKEN, 'GET', `/api/assess/status?candidateId=${encodeURIComponent(fixture.candidateId)}`), 'assessment decision status');
    expectOk(await request(server.port, TOKEN, 'GET', '/api/llm/config'), 'safe public AI config');
    assert.equal((await request(server.port, TOKEN, 'GET', '/api/local-interview/doctor')).status, 404);
    assert.equal((await request(server.port, TOKEN, 'GET', '/api/local-interview/progress')).status, 404);
    assert.equal((await request(server.port, TOKEN, 'POST', '/api/profile')).status, 405);
    assert.equal((await request(server.port, TOKEN, 'GET', `/api/rate/progress?jobId=${fixture.jobId}`)).status, 404);
    assert.equal((await request(server.port, TOKEN, 'GET', '/api/job-templates/ecommerce')).status, 404);
    assert.equal((await request(server.port, TOKEN, 'GET', '/api/interviewers?includeInactive=1')).status, 404);
    assert.equal((await request(server.port, TOKEN, 'GET', `/api/deep-profile/progress?jobId=${fixture.jobId}`)).status, 404);
  } finally {
    await stopReadonlyServer(server);
  }
  const after = { hash: sha256(DB_PATH), stat: fs.statSync(DB_PATH), schema: schemaSnapshot(DB_PATH) };
  assert.equal(after.hash, before.hash, 'operational reads must not change database bytes');
  assert.equal(after.stat.size, before.stat.size, 'operational reads must not change database size');
  assert.equal(after.stat.mtimeMs, before.stat.mtimeMs, 'operational reads must not change database mtime');
  assert.deepEqual(after.schema, before.schema, 'operational reads must not create or migrate schema');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    assert.equal(fs.existsSync(`${DB_PATH}${suffix}`), false, `operational reads must not create SQLite sidecar ${suffix}`);
  }
  const auditActions = fs.readFileSync(completeAuditFile, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line).action).sort();
  assert.deepEqual(auditActions, [
    'assessment_ai_history_read',
    'assessment_archive_read',
    'assessment_queue_read',
    'candidate_assess_status_read',
    'candidate_journey_operations_read',
    'interview_assignment_read',
    'interview_consent_read',
    'interview_lifecycle_status_read',
    'interview_list_read',
    'interview_recording_list_read',
    'interview_report_read',
    'interview_script_read',
    'interview_session_read',
    'job_profile_read',
  ].sort(), 'the only allowed file writes must be one append-only sensitive-read audit entry per sensitive projection');

  fs.copyFileSync(DB_PATH, MISSING_DB_PATH);
  fs.chmodSync(MISSING_DB_PATH, 0o600);
  const incomplete = new Database(MISSING_DB_PATH);
  incomplete.exec('DROP TABLE assessment_binding');
  incomplete.close();
  const missingBefore = { hash: sha256(MISSING_DB_PATH), schema: schemaSnapshot(MISSING_DB_PATH) };
  server = await startReadonlyServer(MISSING_DB_PATH, 'missing-schema');
  try {
    const rejected = await request(server.port, TOKEN, 'GET', `/api/assessment/archive?candidateId=${encodeURIComponent(fixture.candidateId)}&jobId=${fixture.jobId}`);
    assert.equal(rejected.status, 503);
    assert.equal(rejected.body.code, 'READONLY_SCHEMA_MIGRATION_REQUIRED');
  } finally {
    await stopReadonlyServer(server);
  }
  assert.equal(fs.statSync(server.auditFile).size, 0, 'failed schema reads must not append a success audit entry');
  assert.equal(sha256(MISSING_DB_PATH), missingBefore.hash, 'schema mismatch must not repair or rewrite the database');
  assert.deepEqual(schemaSnapshot(MISSING_DB_PATH), missingBefore.schema, 'schema mismatch must remain unmigrated');

  const sidecarFixture = path.join(ROOT, 'residual-sidecar.db');
  fs.copyFileSync(DB_PATH, sidecarFixture);
  fs.chmodSync(sidecarFixture, 0o600);
  fs.writeFileSync(`${sidecarFixture}-wal`, 'synthetic unresolved WAL', { mode: 0o600 });
  db.useReadonly({ operational: true });
  assert.throws(
    () => db.openReadonly(sidecarFixture),
    (error) => error && error.code === 'READONLY_DATABASE_RECOVERY_REQUIRED',
    'operational readonly must fail closed instead of opening a database with recovery sidecars',
  );

  const apiSource = fs.readFileSync(path.join(__dirname, 'frontend/src/api.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, 'frontend/src/App.jsx'), 'utf8');
  const settingsSource = fs.readFileSync(path.join(__dirname, 'frontend/src/components/SettingsPanel.jsx'), 'utf8');
  const candidateMainSource = fs.readFileSync(path.join(__dirname, 'candidate-main.js'), 'utf8');
  const projectionSource = fs.readFileSync(path.join(__dirname, 'operational-readonly-projection.js'), 'utf8');
  const projectionPaths = require('./operational-readonly-projection').OPERATIONAL_READONLY_EXACT_PATHS;
  const frontendAllowlistBody = apiSource.match(/const OPERATIONAL_READONLY_GET_EXACT_PATHS = new Set\(\[([\s\S]*?)\]\);/);
  assert.ok(frontendAllowlistBody, 'frontend operational readonly allowlist must remain explicit');
  const frontendPaths = [...frontendAllowlistBody[1].matchAll(/'([^']+)'/g)]
    .map((match) => `/api${match[1]}`);
  assert.deepEqual(frontendPaths, projectionPaths, 'frontend and backend operational readonly exact allowlists must match');
  assert.match(apiSource, /async function operationalReadGet\(path\)/);
  assert.match(apiSource, /OPERATIONAL_READONLY_GET_EXACT_PATHS/);
  assert.match(apiSource, /return READONLY_UI\s*\? localApiRequest\('readonly', 'GET', path\)\s*: localApiRequest\('action', 'GET', path\)/);
  assert.match(apiSource, /async function actionGet\(path\) \{\s*if \(READONLY_UI\) throw/);
  assert.match(candidateMainSource, /BOSS_READONLY_UI/);
  assert.match(candidateMainSource, /action-server disabled/);
  assert.match(candidateMainSource, /allowMigration:\s*!READONLY_UI/);
  assert.match(candidateMainSource, /if \(allowMigration === false\) return llmStartupResolution\(\);/);
  assert.match(candidateMainSource, /return READONLY_UI \? requireExistingPrivateDir\(dir\) : hardenPrivateDir\(dir\);/);
  assert.match(candidateMainSource, /const dataDir = prepareRuntimeDir\(path\.join\(app\.getPath\('userData'\), 'data'\)\);/);
  assert.match(candidateMainSource, /process\.env\.HRBOSS_DATA_DIR \? prepareRuntimeDir\(path\.resolve\(process\.env\.HRBOSS_DATA_DIR\)\) : dataDir/);
  assert.doesNotMatch(projectionSource, /require\(['"]child_process['"]\)|\bspawnSync?\(|\bexecFileSync?\(|process\.kill\(|https?\.request\(/);

  const frontendSources = frontendSourceFiles(path.join(__dirname, 'frontend/src'))
    .map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }));
  const rendererSetItemSites = frontendSources.flatMap(({ file, source }) => (
    [...source.matchAll(/\blocalStorage\.setItem\s*\(/g)].map(() => file)
  ));
  assert.deepEqual(rendererSetItemSites, [path.join(__dirname, 'frontend/src/App.jsx')], 'renderer must have one localStorage.setItem site in App.jsx');
  assert.equal((appSource.match(/\blocalStorage\.setItem\s*\(/g) || []).length, 1, 'App must centralize UI preference writes in one helper');
  assert.doesNotMatch(settingsSource, /\blocalStorage\.setItem\s*\(/, 'SettingsPanel must not write browser storage directly');
  for (const name of ['writeStoredBoolean', 'writeStoredJobId', 'handleBrandNameChange', 'handleBrandMarkChange']) {
    assert.match(extractFunction(appSource, name), /persistUiPreference\(/, `${name} must reuse the production preference helper`);
  }
  assert.match(appSource, /writeStoredBoolean\(CANDIDATE_LIST_COLLAPSED_STORAGE_KEY, candidateListCollapsed\)/, 'candidate collapse mount/toggle path must use the guarded wrapper');
  assert.match(appSource, /writeStoredJobId\(id\)/, 'job boot/switch path must use the guarded wrapper');
  assert.match(settingsSource, /onBrandMarkChange\?\.\(nextMark\)/, 'brand save action must keep its session update callback');
  assert.match(settingsSource, /onBrandNameChange\?\.\(nextName\)/, 'brand save action must keep its session update callback');
  assert.match(settingsSource, /value=\{brandNameDraft\}[\s\S]*?setBrandNameDraft\(event\.target\.value\)/,
    'brand typing must remain a local draft until the explicit save action');
  assert.match(settingsSource, /不写入本机偏好/, 'readonly brand feedback must explicitly disclose zero local persistence');

  const readonlyRenderer = runRendererPreferenceScenario(appSource, true);
  assert.equal(readonlyRenderer.writes.length, 0, 'seven readonly UI preference attempts must perform zero storage writes');
  assert.deepEqual([...readonlyRenderer.stored], [['sentinel', 'unchanged']], 'readonly attempts must leave existing storage unchanged');
  assert.deepEqual(readonlyRenderer.results, Array(8).fill(false), 'readonly wrappers must report that nothing persisted');
  assert.deepEqual(readonlyRenderer.brandMarks, ['ABC', '招'], 'readonly brand mark controls must still update React session state');
  assert.deepEqual(readonlyRenderer.brandNames, ['测试品牌', '招才官'], 'readonly brand name controls must still update React session state');

  const normalRenderer = runRendererPreferenceScenario(appSource, false);
  assert.deepEqual(normalRenderer.writes, [
    ['hrboss.ui.appNavCollapsed.v1', '0'],
    ['hrboss.ui.candidateListCollapsed.v1', '0'],
    ['hrboss.ui.currentJobId.v1', '101'],
    ['hrboss.ui.currentJobId.v1', '202'],
    ['hrboss.ui.brandMark.v1', 'ABC'],
    ['hrboss.ui.brandName.v1', '测试品牌'],
    ['hrboss.ui.brandMark.v1', '招'],
    ['hrboss.ui.brandName.v1', '招才官'],
  ], 'normal mode must perform exactly the eight expected production preference writes');
  assert.deepEqual(normalRenderer.results, Array(8).fill(true), 'normal wrappers must report successful persistence');
  assert.equal(normalRenderer.stored.get('sentinel'), 'unchanged', 'normal writes must not alter unrelated storage');
  assert.equal(normalRenderer.stored.get('hrboss.ui.appNavCollapsed.v1'), '0');
  assert.equal(normalRenderer.stored.get('hrboss.ui.candidateListCollapsed.v1'), '0');
  assert.equal(normalRenderer.stored.get('hrboss.ui.currentJobId.v1'), '202');
  assert.equal(normalRenderer.stored.get('hrboss.ui.brandMark.v1'), '招');
  assert.equal(normalRenderer.stored.get('hrboss.ui.brandName.v1'), '招才官');
  assert.equal(runNoWindowPreferenceScenario(appSource), false, 'non-renderer execution must fail closed without accessing storage');

  console.log(JSON.stringify({
    ok: true,
    contract: 'UX-G0-D2-OPERATIONAL-READONLY',
    operational_history_gets: true,
    exact_allowlist: true,
    non_get_405: true,
    unlisted_get_404: true,
    doctor_subprocess_disabled: true,
    outbound_http_guarded: true,
    outbound_net_and_fetch_guarded: true,
    file_writes_limited_to_append_only_sensitive_read_audit: true,
    database_bytes_unchanged: true,
    sqlite_sidecars_unchanged: true,
    schema_mismatch_fail_closed_without_migration: true,
    renderer_ui_preference_attempts_per_mode: 7,
    renderer_readonly_storage_writes: readonlyRenderer.writes.length,
    renderer_normal_storage_writes: normalRenderer.writes.length,
  }, null, 2));
}

process.on('exit', () => {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch {}
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
