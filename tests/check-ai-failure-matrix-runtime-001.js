#!/usr/bin/env node
'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { buildChatBody } = require("../src/f009-interview-llm");
const { REPORT_DISCLAIMER } = require("../src/interview-report-v1");
const {
  ENV_KEYS,
  PLAN_MARKER,
  encodePlan,
} = require("./support/test-ai-failure-matrix/signed-plan");

const ROOT = PROJECT_ROOT;
const RAW_PII = Object.freeze([
  '13812345678',
  'synthetic-b11@example.test',
  '110101199001011234',
  'wx_b11privacy',
]);

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
  const targets = [...pids]
    .filter((pid) => Number.isInteger(pid) && pid > 1 && isAlive(pid))
    .sort((left, right) => right - left);
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
      reject(new Error(`external AI failure matrix timed out\n${stdout}\n${stderr}`));
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
    '-subj', '/CN=HRBOSS B11 Synthetic CA',
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
  const events = [];
  let materialIndex = 0;
  const server = https.createServer({
    key: fs.readFileSync(path.join(tlsRoot, 'server.key')),
    cert: fs.readFileSync(path.join(tlsRoot, 'server.crt')),
  }, (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('aborted', () => events.push({ event: 'request_aborted', at_ms: Date.now(), material_index: materialIndex }));
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const row = {
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body,
        received_at_ms: Date.now(),
      };
      requests.push(row);
      if (req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-b11-synthetic' }] }));
        return;
      }
      if (!req.url.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'synthetic route not found' }));
        return;
      }
      const parsed = JSON.parse(body);
      const compatibilityTest = (parsed.messages || []).some((message) => (
        String(message && message.content || '').includes('hrboss_model_compatibility')
      ));
      if (compatibilityTest) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'gpt-b11-synthetic',
          choices: [{ message: { content: JSON.stringify({ ok: true, purpose: 'hrboss_model_compatibility' }) } }],
        }));
        return;
      }
      const scenarioIndex = materialIndex;
      materialIndex += 1;
      if (scenarioIndex === 0) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'B-11 synthetic provider failure' }));
        return;
      }
      if (scenarioIndex === 1) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('B-11 synthetic non-json response');
        return;
      }
      if (scenarioIndex === 2) {
        const report = providerReport(parsed);
        report.summary.evidence_refs[0].span.end -= 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'gpt-b11-synthetic',
          choices: [{ message: { content: JSON.stringify(report) } }],
          usage: { prompt_tokens: 71, completion_tokens: 29 },
        }));
        return;
      }
      if (scenarioIndex === 3) {
        setTimeout(() => {
          events.push({
            event: 'late_response_attempted',
            at_ms: Date.now(),
            material_index: scenarioIndex,
            writable_before_attempt: !res.destroyed && !res.writableEnded,
          });
          if (!res.destroyed && !res.writableEnded) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              model: 'gpt-b11-synthetic',
              choices: [{ message: { content: JSON.stringify(providerReport(parsed)) } }],
              usage: { prompt_tokens: 73, completion_tokens: 31 },
            }));
          }
        }, 6_200);
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unexpected B-11 material request' }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  return { server, requests, events, port: address.port };
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function run() {
  assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0', 'the journey requires real TLS certificate verification');
  const createdRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-b11-ai-failure-matrix-'));
  const syntheticRoot = fs.realpathSync(createdRoot);
  if (process.platform !== 'win32') fs.chmodSync(syntheticRoot, 0o700);
  const keepArtifacts = process.env.HRBOSS_KEEP_B11_ARTIFACTS === '1';
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
      path.join(ROOT, "tests/support/test-ai-failure-matrix/runtime-db.js"),
      syntheticRoot,
      'seed',
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
    const planPath = path.join(syntheticRoot, 'ai-failure-matrix-plan.json');
    writePrivate(planPath, JSON.stringify(signedPlan));
    const baselinePids = new Set(processTable().map((row) => row.pid));
    const runtimeEnv = {
      ...process.env,
      [ENV_KEYS.marker]: PLAN_MARKER,
      [ENV_KEYS.plan]: planPath,
      [ENV_KEYS.secret]: signingSecret,
      HRBOSS_B11_PROVIDER_BASE_URL: providerBaseUrl,
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
      [path.join(ROOT, "tests/support/test-ai-failure-matrix/bootstrap.js")],
      runtimeEnv,
      5 * 60 * 1000,
      baselinePids,
    );
    const resultPath = path.join(syntheticRoot, 'runtime-result.json');
    assert.equal(fs.existsSync(resultPath), true, `runtime must write a result\n${runtime.stdout}\n${runtime.stderr}`);
    const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    assert.equal(result.ok, true, result.error || runtime.stderr);
    assert.equal(runtime.code, 0, `Electron exited with ${runtime.signal || runtime.code}\n${runtime.stderr}`);
    assert.equal(runtime.survivors.length, 0, `spawned PID survivors: ${runtime.survivors.join(', ')}`);

    const lateEvent = await waitFor(
      () => provider.events.find((item) => item.event === 'late_response_attempted'),
      10_000,
      'the synthetic late provider response',
    );
    const modelRequests = provider.requests.filter((item) => item.url.endsWith('/models'));
    const chatRequests = provider.requests.filter((item) => item.url.endsWith('/chat/completions'));
    const compatibilityRequests = chatRequests.filter((item) => item.body.includes('hrboss_model_compatibility'));
    const materialRequests = chatRequests.filter((item) => !item.body.includes('hrboss_model_compatibility'));
    assert.ok(modelRequests.every((item) => item.url === '/openai/v1/models'), 'model catalog must use the configured API root');
    assert.ok(chatRequests.every((item) => item.url === '/openai/v1/chat/completions'), 'chat requests must use the configured API root');
    assert.equal(modelRequests.length, 1, 'model setup must make one explicit catalog request');
    assert.equal(compatibilityRequests.length, 1, 'model setup must perform one explicit synthetic compatibility test');
    for (const token of RAW_PII) assert.equal(compatibilityRequests[0].body.includes(token), false, `compatibility test leaked ${token}`);
    assert.equal(materialRequests.length, 4, 'hash mismatch must be zero-send and each approved failure scenario must send exactly once');
    assert.equal(result.previews.length, materialRequests.length);
    materialRequests.forEach((request, index) => {
      const actualBody = JSON.parse(request.body);
      assert.deepEqual(actualBody, buildChatBody(result.previews[index]), `request ${index + 1} must exactly match its preview`);
      assert.equal(request.headers.authorization, 'Bearer synthetic-b11-api-key');
      const serialized = JSON.stringify(actualBody);
      for (const token of RAW_PII) assert.equal(serialized.includes(token), false, `request ${index + 1} leaked ${token}`);
    });

    const verification = runSyncChecked(electronPath, [
      path.join(ROOT, "tests/support/test-ai-failure-matrix/runtime-db.js"),
      syntheticRoot,
      'verify',
    ], { env: electronNodeEnv, timeout: 60_000 });
    const database = JSON.parse(verification.stdout.trim().split('\n').pop());
    assert.equal(database.ok, true);

    const manifest = {
      ...result,
      provider: {
        bind_address: '127.0.0.1',
        tls: true,
        ip_san: '127.0.0.1',
        model_setup_requests: modelRequests.length,
        model_compatibility_requests: compatibilityRequests.length,
        candidate_material_requests: materialRequests.length,
        request_bodies_match_previews: true,
        raw_pii_absent_from_all_requests: true,
        request_body_sha256: materialRequests.map((item) => crypto.createHash('sha256').update(item.body).digest('hex')),
        late_response: lateEvent,
        events: provider.events,
      },
      database,
      spawned_pid_survivors: runtime.survivors,
    };
    if (process.env.HRBOSS_B11_EVIDENCE_DIR) {
      const evidenceRoot = path.resolve(process.env.HRBOSS_B11_EVIDENCE_DIR);
      fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
      const manifestPath = path.join(evidenceRoot, 'B-11-runtime-evidence.json');
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      if (process.platform !== 'win32') fs.chmodSync(manifestPath, 0o600);
    }
    console.log(JSON.stringify({
      ok: true,
      evidence_level: 'E4',
      pii_masked: result.pii,
      preview_hash_mismatch: result.preview_hash_mismatch,
      failure_matrix: result.failure_matrix,
      provider_material_requests: materialRequests.length,
      request_bodies_match_previews: true,
      late_response_attempted: true,
      draft_after_late_response: database.report_exists,
      audit_states: database.audits,
      spawned_pid_survivors: runtime.survivors,
    }, null, 2));
  } finally {
    if (provider) await closeServer(provider.server);
    if (keepArtifacts) console.log(`[B-11] synthetic evidence retained at ${syntheticRoot}`);
    else fs.rmSync(syntheticRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
