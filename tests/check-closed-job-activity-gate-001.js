'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-closed-activity-gate-'));
const DATA_DIR = path.join(ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'recruiting.db');
const PORT = 19000 + (process.pid % 10000);
const LOCAL_TOKEN = 'synthetic-local-action-token-closed-job-gate-001';
const APPROVAL_SECRET = 'synthetic-external-ai-approval-secret-closed-job-gate-001';
const ACTOR = 'local-primary-operator';
const EXTERNAL_AI_CONNECTION = {
  provider: 'synthetic',
  baseUrl: 'https://ai.example.test/v1',
  model: 'synthetic-closed-job-model',
};

fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.HRBOSS_DATA_DIR = DATA_DIR;
process.env.BOSS_DB_PATH = DB_PATH;

const db = require("../src/db");
const { externalAiMaterialHash } = require("../src/external-ai-material-hash");
const { issueExternalAiUserApproval } = require("../src/external-ai-user-approval");

let closedJobId;
let candidateId;
let deepApproval;
let candidateApproval;

function setJobStatus(database, jobId, status) {
  database.prepare('UPDATE job SET status = ? WHERE id = ?').run(status, jobId);
}

function setupSyntheticDatabase() {
  const database = db.openDb(DB_PATH);
  const currentJob = db.upsertJob({
    encrypt_job_id: 'synthetic-current-job-closed-gate-001',
    numeric_job_id: '100000000000000901',
    name: '合成当前直播运营岗',
    source_type: 'boss_sync',
  });
  const historyJob = db.upsertJob({
    encrypt_job_id: 'synthetic-history-job-closed-gate-001',
    numeric_job_id: '100000000000000902',
    name: '合成历史电商运营岗',
    source_type: 'boss_sync',
  });
  closedJobId = Number(currentJob.id);

  const jd = db.createJobJdVersion({
    jobId: closedJobId,
    jdText: '负责直播运营、复盘转化数据和优化排期。',
    actor: ACTOR,
  });
  db.activateJobJdVersion({ jdVersionId: jd.id, expectedVersion: jd.version, actor: ACTOR });
  const profile = db.createJobProfileVersion({
    jobId: closedJobId,
    jdVersionId: jd.id,
    config: { rubric: '直播运营；数据复盘；排期协作' },
    actor: ACTOR,
  });
  db.confirmJobProfileVersion({ profileVersionId: profile.id, expectedVersion: profile.version, actor: ACTOR });
  db.insertInterview({
    job_id: closedJobId,
    transcript: '合成负责人访谈：需要候选人独立负责直播排期并复盘转化数据。',
    note: '负责人访谈',
  });

  const currentCandidate = db.upsertCandidate({
    job_id: closedJobId,
    geek_id: 'synthetic-current-candidate-closed-gate-001',
    source: '推荐',
    name: '合成当前候选人',
    rec_position: '直播运营',
    geek_desc: '有直播排期与数据复盘经历',
  });
  candidateId = currentCandidate.internal_id;
  db.insertResumeOnline({
    candidate_id: candidateId,
    sections_json: { work: [{ title: '直播运营', description: '合成数据：负责排期和转化复盘' }] },
    is_paywalled: false,
  });

  const historyCandidate = db.upsertCandidate({
    job_id: Number(historyJob.id),
    geek_id: 'synthetic-history-candidate-closed-gate-001',
    source: '推荐',
    name: '合成历史候选人',
    rec_position: '电商运营',
    geek_desc: '有直播运营和数据复盘经历',
  });
  db.insertResumeOnline({
    candidate_id: historyCandidate.internal_id,
    sections_json: { work: [{ title: '电商运营', description: '合成数据：直播运营和数据复盘' }] },
    is_paywalled: false,
  });

  const deepRequestId = 'REQ-CLOSED-DEEP-PROFILE-001';
  const deepHash = externalAiMaterialHash({
    database,
    dbApi: db,
    purpose: 'deep-profile',
    targetId: String(closedJobId),
  });
  deepApproval = {
    requestId: deepRequestId,
    token: issueExternalAiUserApproval(APPROVAL_SECRET, {
      purpose: 'deep-profile',
      targetId: String(closedJobId),
      requestId: deepRequestId,
      actor: ACTOR,
      materialSha256: deepHash,
      ...EXTERNAL_AI_CONNECTION,
    }),
  };

  const candidateRequestId = 'REQ-CLOSED-CANDIDATE-ASSESSMENT-001';
  const candidateHash = externalAiMaterialHash({
    database,
    dbApi: db,
    purpose: 'candidate-assessment',
    targetId: candidateId,
  });
  candidateApproval = {
    requestId: candidateRequestId,
    token: issueExternalAiUserApproval(APPROVAL_SECRET, {
      purpose: 'candidate-assessment',
      targetId: candidateId,
      requestId: candidateRequestId,
      actor: ACTOR,
      materialSha256: candidateHash,
      ...EXTERNAL_AI_CONNECTION,
    }),
  };

  const openPool = db.listTalentPool({ jobId: closedJobId });
  assert.ok(openPool.talents.length >= 2, 'open job must retain readable synthetic talent history');
  assert.ok(openPool.job_recommendations.length >= 1, 'open job must retain dynamic current-job recommendations');
  assert.ok(openPool.talents.some((talent) => talent.recommendation?.outreach_draft), 'open job must retain existing draft derivation');

  setJobStatus(database, closedJobId, 'closed');
  const closedPool = db.listTalentPool({ jobId: closedJobId });
  assert.ok(closedPool.talents.length >= 2, 'closed job must keep talent and history reads available');
  assert.equal(closedPool.job_recommendations.length, 0, 'closed job must not derive current-job recommendations');
  assert.equal(closedPool.talents.every((talent) => talent.recommendation === null), true,
    'closed job must not return current-job recommendation or outreach draft objects');
  assert.ok(closedPool.talents.every((talent) => Array.isArray(talent.history) && talent.history.length >= 1));

  setJobStatus(database, closedJobId, 'open');
  const reopenedPool = db.listTalentPool({ jobId: closedJobId });
  assert.ok(reopenedPool.job_recommendations.length >= 1, 'reopening must restore the existing dynamic recommendation path');
  setJobStatus(database, closedJobId, 'closed');
  database.close();
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
        'x-hrboss-token': LOCAL_TOKEN,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
      timeout: 5000,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        body: text ? JSON.parse(text) : null,
      }));
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('request timeout')));
    request.end(payload);
  });
}

async function waitForServer(child) {
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const deadline = Date.now() + 7000;
  while (Date.now() < deadline) {
    if (output.includes(`http://127.0.0.1:${PORT}`)) return;
    if (child.exitCode !== null) throw new Error(`action server exited during startup: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`action server did not start: ${output}`);
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

async function runRouteChecks() {
  const child = spawn(process.execPath, [path.join(PROJECT_ROOT, "src/action-server.js")], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      BOSS_ACTION_PORT: String(PORT),
      BOSS_DB_PATH: DB_PATH,
      HRBOSS_DATA_DIR: DATA_DIR,
      HRBOSS_LOCAL_API_TOKEN: LOCAL_TOKEN,
      HRBOSS_LOCAL_API_INSTANCE_ID: 'check-closed-job-activity-gate-001',
      HRBOSS_F009_APPROVAL_SECRET: APPROVAL_SECRET,
      HRBOSS_EXTERNAL_AI_PROVIDER: EXTERNAL_AI_CONNECTION.provider,
      HRBOSS_EXTERNAL_AI_BASE_URL: EXTERNAL_AI_CONNECTION.baseUrl,
      HRBOSS_EXTERNAL_AI_ENABLED: '0',
      HRBOSS_EXTERNAL_AI_API_KEY: '',
      HRBOSS_MAIBAO_API_KEY: '',
      HRBOSS_EXTERNAL_AI_MODEL: EXTERNAL_AI_CONNECTION.model,
      HRBOSS_MAIBAO_MODEL: '',
      HRBOSS_EXTERNAL_AI_VERIFIED_MODELS: '[]',
      HRBOSS_ALLOW_INSECURE_LOCAL_AI: '0',
      HRBOSS_RATING_CONFIG_PATH: path.join(DATA_DIR, 'no-rating-config.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let primaryError = null;
  try {
    await waitForServer(child);

    let response = await post('/api/assessment/ai-analysis/generate', {
      candidate_id: candidateId,
      job_id: closedJobId,
      request_id: 'REQ-CLOSED-ASSESSMENT-AI-ROUTE-001',
    });
    assert.equal(response.status, 409, 'closed assessment AI route must reject before confirmation or assessor invocation');
    assert.equal(response.body.code, 'JOB_CLOSED');

    response = await post('/api/deep-profile/generate', {
      jobId: closedJobId,
      requestId: deepApproval.requestId,
      userApproval: deepApproval.token,
    });
    assert.equal(response.status, 409, 'closed deep-profile route must reject before consuming approval');
    assert.equal(response.body.code, 'JOB_CLOSED');

    response = await post('/api/assess', {
      candidateId,
      requestId: candidateApproval.requestId,
      userApproval: candidateApproval.token,
    });
    assert.equal(response.status, 409, 'closed candidate assessment route must reject before consuming approval');
    assert.equal(response.body.code, 'JOB_CLOSED');

    const mutation = new Database(DB_PATH);
    setJobStatus(mutation, closedJobId, 'open');
    mutation.close();

    response = await post('/api/deep-profile/generate', {
      jobId: closedJobId,
      requestId: deepApproval.requestId,
      userApproval: deepApproval.token,
    });
    assert.equal(response.status, 200, 'the same deep-profile approval must remain usable after reopen');
    assert.equal(response.body.started, true);

    response = await post('/api/assess', {
      candidateId,
      requestId: candidateApproval.requestId,
      userApproval: candidateApproval.token,
    });
    assert.notEqual(response.status, 403, 'the same candidate-assessment approval must not have been consumed by the closed-job rejection');
    assert.notEqual(response.status, 409, 'reopened candidate assessment must pass the closed-job preflight');
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try { await stopChild(child); } catch (error) { cleanupError = error; }
  if (primaryError) {
    if (cleanupError) primaryError.cleanupError = cleanupError;
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
}

function checkUiContract() {
  const app = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/App.jsx'), 'utf8');
  const talent = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/components/TalentPoolDemo.jsx'), 'utf8');
  assert.match(app, /<TalentPoolDemo[\s\S]*?readOnly=\{jobReadOnly\}/,
    'talent pool must receive the selected job read-only state');
  assert.match(talent, /const authorityReadPending = loading \|\| !!addingId/,
    'talent writes must remain locked during initial, refresh and committed-refresh authority reads');
  assert.match(talent, /const authorityMismatch = !pool \|\| String\(pool\.active_job\?\.id \?\? ''\) !== String\(jobId \?\? ''\)/,
    'talent writes must fail closed when the rendered pool does not match the selected job');
  assert.match(talent, /const writesLocked = readOnly \|\| authorityReadPending \|\| !!error \|\| authorityMismatch/,
    'talent writes must fail closed for read-only, pending, failed or mismatched authority');
  const copyDraftSource = talent.slice(
    talent.indexOf('async function copyDraft()'),
    talent.indexOf('function resetDraft()', talent.indexOf('async function copyDraft()')),
  );
  assert.match(copyDraftSource, /outreachGate\(selected, writesLocked\)/,
    'copy must recheck the combined write lock instead of relying only on visible controls');
  assert.match(talent, /pool\?\.active_job\?\.status !== 'closed' && \([\s\S]*?className="talent-pool-group-filter"/,
    'closed jobs must not render current-position recommendation filters');
  assert.match(talent, /\{!closedJob && \(\s*<>\s*<DetailBlock title="推荐依据"/,
    'only job closure, not generic staging read-only, may hide current recommendation evidence');
  assert.match(talent, /\{!closedJob && <DetailBlock title="再触达草稿"/,
    'closed jobs must not render a current outreach draft');
  assert.match(talent, /当前岗位推荐与再触达动作已停用；人才详情和历史岗位记录仍可查看/);
}

async function main() {
  let message = '';
  let primaryError = null;
  try {
    setupSyntheticDatabase();
    checkUiContract();
    await runRouteChecks();
    message = JSON.stringify({
      ok: true,
      contract: 'CLOSED-JOB-ACTIVITY-GATE-001',
      assessment_ai_route_closed_before_confirmation: true,
      approvals_reusable_after_closed_rejection: true,
      closed_talent_history_readable: true,
      closed_recommendations: 0,
      reopen_recommendations_restored: true,
      external_ai_forced_disabled: true,
    });
  } catch (error) {
    primaryError = error;
  }
  let cleanupError = null;
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (error) { cleanupError = error; }
  if (primaryError) {
    if (cleanupError) primaryError.cleanupError = cleanupError;
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
  console.log(message);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
