const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const Database = require('better-sqlite3');

const PORT = 17933 + (process.pid % 1000);
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'action-server-guard-'));
const SCREENSHOT_PROGRESS_FILE = path.join(TEST_ROOT, 'screenshot-progress.json');
const ACTION_DB = path.join(TEST_ROOT, 'data', 'recruiting.db');
const SCREENSHOT_DIR = path.join(TEST_ROOT, 'screenshots');
const DATA_DIR = path.join(TEST_ROOT, 'data');
const LOCAL_API_TOKEN = 'test-local-api-token-action-server-guard-0001';
const F009_APPROVAL_SECRET = 'test-external-ai-approval-secret-action-server-guard-0001';
const { issueExternalAiUserApproval } = require('./external-ai-user-approval');
const { LOCAL_PRINCIPAL } = require('./local-principal');
let APPROVED_CANDIDATE_ID = '';

process.on('exit', () => {
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
});

{
  const db = require('./db');
  const database = db.openDb(ACTION_DB);
  database.prepare(`
    INSERT INTO job (id, encrypt_job_id, numeric_job_id, name, hr_owner, created_at)
    VALUES (2, 'fixture-job-002', '100000000000000002', 'Fixture HR Offline Test Job', 'Fixture HR', ?)
  `).run(new Date().toISOString());
  const candidate = db.upsertCandidate({
    job_id: 2,
    geek_id: 'fixture-ai-approval-candidate',
    source: '推荐',
    name: '合成授权候选人',
  });
  APPROVED_CANDIDATE_ID = candidate.internal_id;
  db.insertResumeOnline({
    candidate_id: APPROVED_CANDIDATE_ID,
    sections_json: { work: [{ title: '合成岗位', description: '仅用于本地授权回归' }] },
    is_paywalled: false,
  });
  database.close();
}

function post(pathname, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: 'POST',
      headers: {
        'x-hrboss-token': LOCAL_API_TOKEN,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      timeout: 3000,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end(payload);
  });
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method: 'GET',
      headers: { 'x-hrboss-token': LOCAL_API_TOKEN },
      timeout: 3000,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

function rawRequest(method, pathname, body = '', headers = {}) {
  const payload = typeof body === 'string' ? body : '';
  const requestHeaders = { ...headers };
  if (payload) requestHeaders['content-length'] = Buffer.byteLength(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: pathname,
      method,
      headers: requestHeaders,
      timeout: 3000,
    }, (res) => {
      let responseText = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { responseText += chunk; });
      res.on('end', () => {
        let bodyValue = null;
        try { bodyValue = responseText ? JSON.parse(responseText) : null; } catch { bodyValue = responseText; }
        resolve({ status: res.statusCode, headers: res.headers, body: bodyValue });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end(payload);
  });
}

async function waitForServer(child) {
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk.toString(); });
  child.stderr.on('data', (chunk) => { log += chunk.toString(); });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (log.includes(`http://127.0.0.1:${PORT}`)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`action-server did not start: ${log}`);
}

async function waitForChildExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopChild(child, timeoutMs = 15_000) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, timeoutMs)) return;
  child.kill('SIGKILL');
  if (!(await waitForChildExit(child, 5_000))) throw new Error('action-server exit timed out after SIGKILL');
  throw new Error('action-server ignored SIGTERM and required SIGKILL');
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'action-server.js')], {
    cwd: __dirname,
    env: {
      ...process.env,
      BOSS_ACTION_PORT: String(PORT),
      BOSS_DB_PATH: ACTION_DB,
      HRBOSS_DATA_DIR: DATA_DIR,
      BOSS_SCREENSHOT_IMPORT_PROGRESS_FILE: SCREENSHOT_PROGRESS_FILE,
      HRBOSS_LOCAL_API_TOKEN: LOCAL_API_TOKEN,
      HRBOSS_LOCAL_API_INSTANCE_ID: 'check-action-server-guard',
      HRBOSS_F009_APPROVAL_SECRET: F009_APPROVAL_SECRET,
      HRBOSS_EXTERNAL_AI_PROVIDER: 'synthetic',
      HRBOSS_EXTERNAL_AI_BASE_URL: 'https://ai.example.test/v1',
      HRBOSS_EXTERNAL_AI_ENABLED: '0',
      HRBOSS_EXTERNAL_AI_API_KEY: '',
      HRBOSS_EXTERNAL_AI_MODEL: 'synthetic-action-guard-unverified-model',
      HRBOSS_EXTERNAL_AI_VERIFIED_MODELS: '[]',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let primaryError = null;
  try {
    await waitForServer(child);

    let securityRes = await rawRequest('GET', '/api/health');
    assert.equal(securityRes.status, 401, 'local API must reject missing session token');
    assert.equal(securityRes.body.code, 'invalid_local_token');

    securityRes = await rawRequest('GET', '/api/health', '', {
      host: 'evil.example',
      'x-hrboss-token': LOCAL_API_TOKEN,
    });
    assert.equal(securityRes.status, 403, 'local API must reject a non-loopback Host header');
    assert.equal(securityRes.body.code, 'invalid_host');

    securityRes = await rawRequest('GET', '/api/health', '', {
      origin: 'https://evil.example',
      'x-hrboss-token': LOCAL_API_TOKEN,
    });
    assert.equal(securityRes.status, 403, 'local API must reject a non-local Origin');
    assert.equal(securityRes.body.code, 'invalid_origin');

    securityRes = await rawRequest('GET', '/api/health', '', {
      origin: 'null',
      'x-hrboss-token': LOCAL_API_TOKEN,
    });
    assert.equal(securityRes.status, 403, 'opaque file:// origins must be rejected even when a token is present');
    assert.equal(securityRes.body.code, 'invalid_origin');

    securityRes = await rawRequest('POST', '/api/assess', '{}', {
      'content-type': 'text/plain',
      'x-hrboss-token': LOCAL_API_TOKEN,
    });
    assert.equal(securityRes.status, 415, 'mutations must require application/json');
    assert.equal(securityRes.body.code, 'json_required');

    securityRes = await rawRequest('OPTIONS', '/api/health', '', {
      origin: 'http://127.0.0.1:5173',
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'x-hrboss-token',
    });
    assert.equal(securityRes.status, 204, 'local preflight should allow the authenticated local UI');
    assert.equal(securityRes.headers['access-control-allow-origin'], 'http://127.0.0.1:5173');

    securityRes = await get('/api/health');
    assert.equal(securityRes.status, 200);
    assert.equal(securityRes.body.instance_id, 'check-action-server-guard');

    securityRes = await get('/api/not-registered');
    assert.equal(securityRes.status, 404, 'unregistered action routes must fail closed without exposing permissions');
    assert.equal(securityRes.body.code, 'NOT_FOUND');

    let principalRes = await post('/api/job-jd-version', {
      jobId: 2,
      jdText: 'Synthetic JD for local principal injection test',
      source: 'manual',
      actor: 'renderer-forged-actor',
      actorRole: 'super_admin',
      confirmedBy: 'renderer-forged-confirmer',
    });
    assert.equal(principalRes.status, 200);
    assert.equal(principalRes.body.version.created_by, LOCAL_PRINCIPAL.actor_id);
    assert.notEqual(principalRes.body.version.created_by, 'renderer-forged-actor');

    let res = await post('/api/deep-profile/generate', { jobId: 2 });
    assert.equal(res.status, 403, 'deep profile generation must require per-call external AI confirmation');
    assert.equal(res.body.code, 'external_ai_confirmation_required');

    res = await post('/api/job-jd/optimize', { jobId: 2, brief: '需要一名能做投放和复盘的同事' });
    assert.equal(res.status, 403, 'JD optimization must require per-call external AI confirmation');
    assert.equal(res.body.code, 'external_ai_confirmation_required');

    res = await post('/api/assess', { candidateId: 'candidate-does-not-matter' });
    assert.equal(res.status, 403, 'candidate assessment must require per-call external AI confirmation');
    assert.equal(res.body.code, 'external_ai_confirmation_required');

    const requestId = 'candidate-assessment-action-route-001';
    const material = await post('/api/external-ai/material-hash', {
      purpose: 'candidate-assessment',
      targetId: APPROVED_CANDIDATE_ID,
      materialInput: { candidateId: APPROVED_CANDIDATE_ID },
    });
    assert.equal(material.status, 200);
    assert.equal(material.body.provider, 'synthetic');
    assert.equal(material.body.baseUrl, 'https://ai.example.test/v1');
    const staleApproval = issueExternalAiUserApproval(F009_APPROVAL_SECRET, {
      purpose: 'candidate-assessment',
      targetId: APPROVED_CANDIDATE_ID,
      requestId,
      actor: LOCAL_PRINCIPAL.actor_id,
      materialSha256: material.body.materialHash,
      provider: material.body.provider,
      baseUrl: material.body.baseUrl,
      model: material.body.model,
    });
    const mutationDb = new Database(ACTION_DB);
    mutationDb.prepare('UPDATE resume_online SET sections_json = ?, fetched_at = ? WHERE candidate_id = ?').run(
      JSON.stringify({ work: [{ title: '合成岗位', description: '材料已在确认后变化' }] }),
      new Date().toISOString(),
      APPROVED_CANDIDATE_ID,
    );
    mutationDb.close();
    res = await post('/api/assess', { candidateId: APPROVED_CANDIDATE_ID, requestId, userApproval: staleApproval });
    assert.equal(res.status, 403, 'material changes after confirmation must invalidate the old approval');
    const currentMaterial = await post('/api/external-ai/material-hash', {
      purpose: 'candidate-assessment',
      targetId: APPROVED_CANDIDATE_ID,
      materialInput: { candidateId: APPROVED_CANDIDATE_ID },
    });
    assert.equal(currentMaterial.status, 200);
    assert.notEqual(currentMaterial.body.materialHash, material.body.materialHash);
    const userApproval = issueExternalAiUserApproval(F009_APPROVAL_SECRET, {
      purpose: 'candidate-assessment',
      targetId: APPROVED_CANDIDATE_ID,
      requestId,
      actor: LOCAL_PRINCIPAL.actor_id,
      materialSha256: currentMaterial.body.materialHash,
      provider: currentMaterial.body.provider,
      baseUrl: currentMaterial.body.baseUrl,
      model: currentMaterial.body.model,
    });
    res = await post('/api/assess', { candidateId: APPROVED_CANDIDATE_ID, requestId, userApproval });
    assert.notEqual(res.status, 403, 'a valid material-bound native approval may proceed to AI readiness validation');
    res = await post('/api/assess', { candidateId: APPROVED_CANDIDATE_ID, requestId, userApproval });
    assert.equal(res.status, 403, 'native approval must be single-use at the action route');

    for (const endpoint of ['/api/automation/greet/start', '/api/automation/request-resume/start']) {
      res = await post(endpoint, undefined);
      assert.equal(res.status, 404, `${endpoint} must be unreachable`);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.code, 'NOT_FOUND');
    }

    const actionServerSource = fs.readFileSync(path.join(__dirname, 'action-server.js'), 'utf8');
    const principalSource = fs.readFileSync(path.join(__dirname, 'local-principal.js'), 'utf8');
    assert.ok(!actionServerSource.includes("spawnDetached('start-auto-greet.js'"), 'greet worker must not be reachable from action server');
    assert.ok(!actionServerSource.includes("spawnDetached('start-request-resume.js'"), 'request-resume worker must not be reachable from action server');
    assert.ok(!principalSource.includes("'/api/automation/greet/start'"));
    assert.ok(!principalSource.includes("'/api/automation/request-resume/start'"));

    res = await get('/api/screenshot-import/progress');
    assert.equal(res.status, 200, 'screenshot import progress endpoint should be readable');
    assert.equal(res.body.ok, true);
    assert.equal(res.body.progress.status, 'idle');

    res = await post('/api/screenshot-import/start', {});
    assert.equal(res.status, 400, 'screenshot import missing dir must be rejected');
    assert.match(res.body.error, /dir required/);

    res = await post('/api/screenshot-import/start', { dir: path.join(os.tmpdir(), 'not-exists-action-server-screenshots') });
    assert.equal(res.status, 400, 'screenshot import missing folder must be rejected');
    assert.match(res.body.error, /截图文件夹/);

    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    fs.writeFileSync(SCREENSHOT_PROGRESS_FILE, JSON.stringify({
      status: 'running',
      stage: 'ocr',
      source_dir_name: path.basename(SCREENSHOT_DIR),
      updated_at: new Date().toISOString(),
      message: '正在识别截图。',
    }));
    res = await post('/api/screenshot-import/start', { dir: SCREENSHOT_DIR });
    assert.equal(res.status, 409, 'screenshot import must reject duplicate starts while fresh progress is active');
    assert.match(res.body.error, /截图导入正在运行中/);
    assert.equal(res.body.progress.source_dir_name, path.basename(SCREENSHOT_DIR));
    assert.equal(Object.hasOwn(res.body.progress, 'dir'), false, 'screenshot import progress must not expose full folder paths');
    fs.writeFileSync(SCREENSHOT_PROGRESS_FILE, JSON.stringify({ status: 'idle' }));
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = [];
  try { await stopChild(child); } catch (error) { cleanupErrors.push(error); }
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (primaryError) {
    if (cleanupErrors.length) {
      primaryError.cleanupError = new AggregateError(cleanupErrors, 'check-action-server-guard cleanup failed');
    }
    throw primaryError;
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'check-action-server-guard cleanup failed');
  console.log('check-action-server-guard ok');
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
