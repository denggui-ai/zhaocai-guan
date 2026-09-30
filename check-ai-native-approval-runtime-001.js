#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { buildChatBody } = require('./f009-interview-llm');
const { REPORT_DISCLAIMER } = require('./interview-report-v1');
const {
  ENV_KEYS,
  PLAN_MARKER,
  encodePlan,
} = require('./checks/test-ai-native-approval/signed-plan');

const ROOT = __dirname;

function writePrivate(target, bytes) {
  fs.writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
  if (process.platform !== 'win32') fs.chmodSync(target, 0o600);
}

function runSyncChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with ${result.signal || result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'));
  }
  return result;
}

function processTable() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('cannot snapshot the process table');
  return result.stdout.trim().split('\n').map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter(Boolean);
}

function descendantPids(rootPid, rows) {
  const owned = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (owned.has(row.ppid) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
    }
  }
  owned.delete(rootPid);
  return owned;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopExactPids(pids) {
  const targets = [...pids].filter((pid) => Number.isInteger(pid) && pid > 1 && isAlive(pid)).sort((a, b) => b - a);
  for (const pid of targets) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && targets.some(isAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  for (const pid of targets.filter(isAlive)) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

async function runElectron(electronPath, args, env, timeoutMs, baselinePids) {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, args, {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const ownedPids = new Set([child.pid]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const monitor = setInterval(() => {
      for (const pid of descendantPids(child.pid, processTable())) {
        if (!baselinePids.has(pid)) ownedPids.add(pid);
      }
    }, 250);
    const timeout = setTimeout(async () => {
      clearInterval(monitor);
      await stopExactPids(ownedPids);
      reject(new Error(`real Electron native AI confirmation journey timed out\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.once('error', async (error) => {
      clearTimeout(timeout);
      clearInterval(monitor);
      await stopExactPids(ownedPids);
      reject(error);
    });
    child.once('exit', async (code, signal) => {
      clearTimeout(timeout);
      clearInterval(monitor);
      await new Promise((done) => setTimeout(done, 600));
      const survivors = [...ownedPids].filter((pid) => !baselinePids.has(pid) && isAlive(pid));
      await stopExactPids(survivors);
      resolve({ code, signal, stdout, stderr, survivors });
    });
  });
}

function generateTls(tlsRoot) {
  fs.mkdirSync(tlsRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(tlsRoot, 0o700);
  runSyncChecked('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1',
    '-subj', '/CN=HRBOSS B2 Synthetic CA',
    '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout', path.join(tlsRoot, 'ca.key'),
    '-out', path.join(tlsRoot, 'ca.crt'),
  ], { stdio: 'pipe' });
  runSyncChecked('openssl', [
    'req', '-newkey', 'rsa:2048', '-nodes', '-sha256',
    '-subj', '/CN=127.0.0.1',
    '-keyout', path.join(tlsRoot, 'server.key'),
    '-out', path.join(tlsRoot, 'server.csr'),
  ], { stdio: 'pipe' });
  const extensionsPath = path.join(tlsRoot, 'server.ext');
  fs.writeFileSync(extensionsPath, [
    'subjectAltName=IP:127.0.0.1',
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    '',
  ].join('\n'), { mode: 0o600 });
  runSyncChecked('openssl', [
    'x509', '-req', '-sha256', '-days', '1',
    '-in', path.join(tlsRoot, 'server.csr'),
    '-CA', path.join(tlsRoot, 'ca.crt'),
    '-CAkey', path.join(tlsRoot, 'ca.key'),
    '-CAcreateserial',
    '-extfile', extensionsPath,
    '-out', path.join(tlsRoot, 'server.crt'),
  ], { stdio: 'pipe' });
  for (const name of ['ca.key', 'ca.crt', 'server.key', 'server.csr', 'server.ext', 'server.crt', 'ca.srl']) {
    if (process.platform !== 'win32') fs.chmodSync(path.join(tlsRoot, name), 0o600);
  }
}

function providerReport(body) {
  const user = JSON.parse(body.messages[1].content);
  const evidenceRef = user.allowed_evidence_refs[0];
  return {
    schema_version: 'interview_report_v1',
    summary: {
      id: 'summary.main',
      status: 'supported',
      text: '合成材料描述了一次项目交付。',
      evidence_refs: [evidenceRef],
    },
    match_points: [],
    risks: [],
    unknowns: [{
      id: 'unknown.team',
      status: 'unknown',
      text: '团队规模未提及。',
      reason_code: 'not_mentioned',
      evidence_refs: [],
    }],
    followup_questions: [],
    key_facts: [],
    hard_requirements: (user.minimal_context.hard_requirements || []).map((item) => ({
      id: item.id,
      label: item.label,
      status: 'unknown',
      text: `${item.label}未在材料中明确核对。`,
      reason_code: 'not_mentioned',
      evidence_refs: [],
    })),
    competency_evidence: [{
      id: 'competency.delivery',
      label: '项目交付',
      status: 'supported',
      text: '合成材料提到一次项目交付。',
      evidence_refs: [evidenceRef],
    }],
    motivation: {
      id: 'motivation.main',
      label: '求职动机',
      status: 'unknown',
      text: '材料未提及求职动机。',
      reason_code: 'not_mentioned',
      evidence_refs: [],
    },
    contradictions: [],
    assessment_cross_checks: (user.minimal_context.confirmed_assessments || []).map((item, index) => ({
      id: `assessment_cross_check.${index + 1}`,
      assessment_document_id: item.document_id,
      label: `${item.report_type}交叉验证`,
      status: 'not_covered',
      text: '面试材料未覆盖该测评。',
      reason_code: item.summary_status === 'unavailable' ? 'unclear' : 'not_mentioned',
      evidence_refs: [],
    })),
    ai_reference: {
      id: 'ai_reference.main',
      label: 'AI 参考分析',
      status: 'supported',
      text: '归集到一条合成项目交付证据，待 HR 核对。',
      evidence_refs: [evidenceRef],
    },
    human_confirm_required: true,
    disclaimer: REPORT_DISCLAIMER,
  };
}

async function startSyntheticProvider(tlsRoot) {
  const requests = [];
  const server = https.createServer({
    key: fs.readFileSync(path.join(tlsRoot, 'server.key')),
    cert: fs.readFileSync(path.join(tlsRoot, 'server.crt')),
  }, (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/models')) {
        res.writeHead(200);
        res.end(JSON.stringify({ data: [{ id: 'gpt-b2-synthetic' }] }));
        return;
      }
      if (req.url.endsWith('/chat/completions')) {
        const parsed = JSON.parse(body);
        const compatibilityTest = (parsed.messages || []).some((message) => (
          String(message && message.content || '').includes('hrboss_model_compatibility')
        ));
        res.writeHead(200);
        res.end(JSON.stringify({
          model: 'gpt-b2-synthetic',
          choices: [{
            message: {
              content: compatibilityTest
                ? JSON.stringify({ ok: true, purpose: 'hrboss_model_compatibility' })
                : JSON.stringify(providerReport(parsed)),
            },
          }],
          usage: { prompt_tokens: 77, completion_tokens: 33 },
        }));
        return;
      }
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'synthetic route not found' }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  return { server, requests, port: address.port };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function run() {
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0', 'the journey requires real TLS certificate verification');
  const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-b2-native-ai-'));
  const syntheticRoot = fs.realpathSync(createdRoot);
  if (process.platform !== 'win32') fs.chmodSync(syntheticRoot, 0o700);
  const keepArtifacts = process.env.HRBOSS_KEEP_B2_ARTIFACTS === '1';
  let provider;
  try {
    for (const dir of ['data', 'profile', 'user-data']) {
      fs.mkdirSync(path.join(syntheticRoot, dir), { recursive: true, mode: 0o700 });
      if (process.platform !== 'win32') fs.chmodSync(path.join(syntheticRoot, dir), 0o700);
    }
    const tlsRoot = path.join(syntheticRoot, 'tls');
    generateTls(tlsRoot);
    provider = await startSyntheticProvider(tlsRoot);
    const providerBaseUrl = `https://127.0.0.1:${provider.port}/openai/v1`;
    const electronPath = require('electron');
    const electronNodeEnv = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HRBOSS_TEST_RUNTIME: 'electron-node',
    };
    runSyncChecked(electronPath, [
      path.join(ROOT, 'checks/test-ai-native-approval/runtime-db.js'),
      syntheticRoot,
    ], { env: electronNodeEnv, timeout: 60_000 });
    runSyncChecked(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', 'frontend', 'run', 'build'], {
      timeout: 120_000,
    });

    const signingSecret = crypto.randomBytes(48).toString('base64url');
    const f009ApprovalSecret = crypto.randomBytes(32).toString('hex');
    const signedPlan = encodePlan(signingSecret, {
      synthetic_root: syntheticRoot,
      f009_approval_secret: f009ApprovalSecret,
    });
    const planPath = path.join(syntheticRoot, 'native-ai-confirmation-plan.json');
    writePrivate(planPath, JSON.stringify(signedPlan));
    const baselinePids = new Set(processTable().map((row) => row.pid));
    const runtimeEnv = {
      ...process.env,
      [ENV_KEYS.marker]: PLAN_MARKER,
      [ENV_KEYS.plan]: planPath,
      [ENV_KEYS.secret]: signingSecret,
      HRBOSS_B2_PROVIDER_BASE_URL: providerBaseUrl,
      NODE_EXTRA_CA_CERTS: path.join(tlsRoot, 'ca.crt'),
      HRBOSS_DATA_DIR: path.join(syntheticRoot, 'data'),
      BOSS_DB_PATH: path.join(syntheticRoot, 'data', 'recruiting.db'),
      BOSS_PROFILE_DATA_DIR: path.join(syntheticRoot, 'profile'),
      HRBOSS_EXTERNAL_AI_ENABLED: '0',
      BOSS_ACTION_AUTOMATION_ENABLED: '0',
    };
    delete runtimeEnv.ELECTRON_RUN_AS_NODE;
    const runtime = await runElectron(
      electronPath,
      [path.join(ROOT, 'checks/test-ai-native-approval/bootstrap.js')],
      runtimeEnv,
      4 * 60 * 1000,
      baselinePids,
    );
    const resultPath = path.join(syntheticRoot, 'runtime-result.json');
    assert.equal(fs.existsSync(resultPath), true, `runtime must write a result\n${runtime.stdout}\n${runtime.stderr}`);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(result.ok, true, result.error || runtime.stderr);
    assert.equal(runtime.code, 0, `Electron exited with ${runtime.signal || runtime.code}\n${runtime.stderr}`);
    assert.equal(runtime.survivors.length, 0, `spawned PID survivors: ${runtime.survivors.join(', ')}`);

    const modelRequests = provider.requests.filter((item) => item.url.endsWith('/models'));
    const chatRequests = provider.requests.filter((item) => item.url.endsWith('/chat/completions'));
    const compatibilityRequests = chatRequests.filter((item) => item.body.includes('hrboss_model_compatibility'));
    const materialRequests = chatRequests.filter((item) => !item.body.includes('hrboss_model_compatibility'));
    assert.ok(modelRequests.every((item) => item.url === '/openai/v1/models'), 'model catalog must use the configured API root');
    assert.ok(chatRequests.every((item) => item.url === '/openai/v1/chat/completions'), 'chat requests must use the configured API root');
    assert.equal(modelRequests.length, 1, 'synthetic model setup must make one explicit catalog request');
    assert.equal(compatibilityRequests.length, 1, 'model setup must perform one explicit synthetic compatibility test');
    assert.equal(materialRequests.length, 1, 'only the approved request may send candidate material');
    assert.equal(compatibilityRequests[0].body.includes('13812345678'), false);
    assert.equal(compatibilityRequests[0].body.includes('synthetic@example.test'), false);
    const actualBody = JSON.parse(materialRequests[0].body);
    const expectedBody = buildChatBody(result.success_preview);
    assert.deepEqual(actualBody, expectedBody, 'Provider request body must exactly equal the confirmed preview body');
    assert.equal(materialRequests[0].headers.authorization, 'Bearer synthetic-b2-api-key');
    assert.equal(JSON.stringify(actualBody).includes('13812345678'), false);
    assert.equal(JSON.stringify(actualBody).includes('synthetic@example.test'), false);

    const manifest = {
      ...result,
      provider: {
        bind_address: '127.0.0.1',
        tls: true,
        ip_san: '127.0.0.1',
        model_setup_requests: modelRequests.length,
        model_compatibility_requests: compatibilityRequests.length,
        candidate_material_requests: materialRequests.length,
        request_body_matches_confirmed_preview: true,
        request_body_sha256: crypto.createHash('sha256').update(materialRequests[0].body).digest('hex'),
      },
      spawned_pid_survivors: runtime.survivors,
    };
    if (process.env.HRBOSS_B2_EVIDENCE_DIR) {
      const evidenceRoot = path.resolve(process.env.HRBOSS_B2_EVIDENCE_DIR);
      fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(evidenceRoot, 'B-2-runtime-evidence.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(path.join(evidenceRoot, 'B-2-runtime-evidence.json'), 0o600);
    }
    console.log(JSON.stringify({
      ok: true,
      evidence_level: 'E4',
      invalid_or_unapproved_provider_requests: materialRequests.length - 1,
      approved_provider_requests: materialRequests.length,
      request_body_matches_confirmed_preview: true,
      replay_status: result.replay.status,
      native_confirmations_remaining: result.native_confirmation.remaining,
      spawned_pid_survivors: runtime.survivors,
    }, null, 2));
  } finally {
    if (provider) await closeServer(provider.server);
    if (keepArtifacts) console.log(`[B-2] synthetic evidence retained at ${syntheticRoot}`);
    else fs.rmSync(syntheticRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
