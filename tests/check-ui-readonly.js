
const { PROJECT_ROOT } = require("../src/paths");
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { assertUiFixtureEnvironment } = require("../src/ui-fixture-safety");

assertUiFixtureEnvironment();

const db = require("../src/db");
const Database = require('better-sqlite3');
const { routeCapability } = require("../src/local-principal");
db.useReadonly();

const READONLY_FILES = ["src/legacy/candidate.html", "src/db-server.js", "src/candidate-main.js", "src/start-candidate-ui.js", "src/preload.js"];
const WRITE_TOKENS = ['changeStatus', 'upsertJob', 'upsertCandidate', 'writeAuditLog', 'writeRunLog', 'gateTrip', 'enqueueWriteAction', 'finishWriteAction'];
const KEY_FIELDS = ['boss_id', 'geek_id', 'security_id', 'lid', 'encrypt_job_id', 'expect_id'];
const LOCAL_API_TOKEN = 'test-local-api-token-ui-readonly-guard-0001';
const READONLY_TEST_PORT = 19032 + (process.pid % 500);
const READ_AUDIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-read-audit-'));
process.on('exit', () => fs.rmSync(READ_AUDIT_ROOT, { recursive: true, force: true }));

function read(file) {
  return fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
}

function declaredStatusStates(source, suffix) {
  return [...source.matchAll(new RegExp(`\\bconst\\s+([A-Za-z_$][\\w$]*${suffix})\\s*=`, 'g'))]
    .map((match) => match[1]);
}

function statusStatePosition(projection, state, group) {
  const matches = [...projection.matchAll(new RegExp(`\\b${state}\\b`, 'g'))];
  assert.strictEqual(matches.length, 1, `TopBar ${group} state ${state} must appear exactly once in statusText`);
  return matches[0].index;
}

function assertStatusPriorityProjection(projection, { activeStates, errorStates, doneStates }) {
  assert.ok(activeStates.length > 0, 'TopBar statusText must expose at least one active state');
  assert.ok(errorStates.length > 0, 'TopBar statusText must expose at least one error state');
  assert.ok(doneStates.length > 0, 'TopBar statusText must expose at least one done state');
  const activePositions = activeStates.map((state) => statusStatePosition(projection, state, 'active'));
  const errorPositions = errorStates.map((state) => statusStatePosition(projection, state, 'error'));
  const donePositions = doneStates.map((state) => statusStatePosition(projection, state, 'done'));
  assert.ok(
    Math.max(...activePositions) < Math.min(...errorPositions),
    'all active status branches must precede every error branch',
  );
  assert.ok(
    Math.max(...errorPositions) < Math.min(...donePositions),
    'all error status branches must precede every done branch',
  );
}

// 递归列出 frontend/src 下所有源码文件，逐个套用同一条"只读面绝不写、绝不碰 Boss"红线。
function listFrontendSourceFiles() {
  const root = path.join(PROJECT_ROOT, 'frontend', 'src');
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|jsx)$/.test(entry.name)) out.push(full);
    }
  })(root);
  return out;
}

function getJson(pathname, token = LOCAL_API_TOKEN) {
  return new Promise((resolve, reject) => {
    const req = require('http').get({
      host: '127.0.0.1',
      port: READONLY_TEST_PORT,
      path: pathname,
      headers: token ? { 'x-hrboss-token': token } : {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('request timeout')));
  });
}

async function main() {
  const jobs = db.listJobs();
  assert.strictEqual(jobs.length, 1, 'listJobs should return the one seeded job');

  const candidates = db.listCandidates(2);
  assert.ok(candidates.length > 0, 'listCandidates(2) should return candidates');
  for (const field of KEY_FIELDS) {
    assert.ok(!Object.hasOwn(candidates[0], field), `listCandidates leaked ${field}`);
  }

  const candidate = db.getCandidate(candidates[0].internal_id);
  assert.ok(candidate && candidate.internal_id, 'getCandidate should return a candidate');
  assert.ok(!Object.hasOwn(candidate, 'geek_id'), 'getCandidate leaked geek_id');

  const children = db.getCandidateChildren(candidate.internal_id);
  assert.deepStrictEqual(Object.keys(children).sort(), [
    'ai_review',
    'comment',
    'contact',
    'resume_attachment',
    'resume_online',
    'status_history',
  ]);

	  const latestRun = db.getLatestRun();
	  assert.ok(latestRun && latestRun.id, 'getLatestRun should return the latest run');
	  assert.equal(latestRun.run_type, '规则评级', 'fixture should keep a newer non-recommend run to catch summary regressions');
	  const latestRecommendRun = db.getLatestRunByType('推荐流抓取');
	  assert.ok(latestRecommendRun && latestRecommendRun.id, 'getLatestRunByType should return the latest recommend run');
	  assert.equal(latestRecommendRun.run_type, '推荐流抓取');

  const serverSource = read("src/db-server.js");
  const dbSource = read("src/db.js");
  assert.ok(!serverSource.includes('getCandidateKeys'), 'db-server must not expose candidate keys over HTTP');
  assert.ok(!serverSource.includes("'keys'") && !serverSource.includes('"keys"'), 'db-server must not route candidate keys');
  assert.ok(!serverSource.includes('gateTrip') && !serverSource.includes('enqueueWriteAction') && !serverSource.includes('finishWriteAction'), 'db-server must not expose write gate/actions');
  assert.ok(
    serverSource.includes("useReadonly({ operational: process.env.BOSS_READONLY_UI === '1' })"),
    'db-server must switch db.js to readonly mode and reserve immutable semantics for global operational readonly',
  );
  assert.ok(!serverSource.includes('rateJob'), 'db-server must not expose rateJob (writes belong to action-server)');
  assert.ok(!serverSource.includes('upsertJobProfile'), 'db-server must not expose upsertJobProfile (writes belong to action-server)');
  for (const token of ['insertInterview', 'insertAiReview', 'generateDeepProfileForJob', 'confirmDeepProfile', 'runSecondOpinion']) {
    assert.ok(!serverSource.includes(token), `db-server must not expose write token ${token} (writes belong to action-server)`);
  }
  assert.ok(!serverSource.includes('minutes-fetch') && !serverSource.includes('fetchMinutesTranscript'), 'db-server must not touch minutes fetching (belongs to action-server)');
  assert.ok(dbSource.includes('readonly: true'), 'db.js must open sqlite with readonly: true');

  // 前端页面绝不直接碰命令行工具：妙记拉取只能走 action-server → minutes-fetch。
  const uiSource = read("src/legacy/candidate.html");
  assert.ok(!uiSource.includes('lark-cli') && !uiSource.includes('spawn('), 'candidate.html must not spawn or mention lark-cli');
  assert.ok(!uiSource.includes('write-worker') && !uiSource.includes('start-auto-greet') && !/zhipin/i.test(uiSource), 'candidate.html must not mention worker scripts or Boss domains');

	  // action-server 是唯一可写服务；候选人状态只能走显式 canonical 端点，禁止候选人主体和简历数据直接覆写。
  const actionSource = read("src/action-server.js");
	  assert.ok(actionSource.includes('createJobProfileVersion') && actionSource.includes('confirmJobProfileVersion') && actionSource.includes('rateJob'), 'action-server should expose canonical versioned profile save + rate');
  assert.ok(actionSource.includes('spawnDetached'), 'action-server automation endpoints should only spawn orchestration scripts');
  assert.ok(!actionSource.includes("require('./auto-greet')") && !actionSource.includes("require('./request-resume')"), 'action-server must not import write orchestrators directly');
  for (const token of ['insertInterview', 'generateDeepProfileForJob', 'confirmDeepProfile', 'runSecondOpinion']) {
    assert.ok(actionSource.includes(token), `action-server should expose ${token}`);
  }
	  assert.ok(!/req\.method === 'POST'[^\n]+\/api\/profile/.test(actionSource), 'legacy direct profile overwrite route must remain removed');
	  assert.ok(actionSource.includes("'/api/candidate-status'") && actionSource.includes('db.changeStatus'), 'candidate status changes must stay behind the explicit action endpoint');
	  assert.ok(!actionSource.includes('insertResumeOnline'), 'action-server must not expose direct online-resume overwrite');
	  const resumeIntakeAdapterStart = actionSource.indexOf('function getResumeCandidateIntakeService()');
	  const resumeIntakeAdapterEnd = actionSource.indexOf('function currentExternalAiMaterialHash', resumeIntakeAdapterStart);
	  assert.ok(resumeIntakeAdapterStart >= 0 && resumeIntakeAdapterEnd > resumeIntakeAdapterStart, 'controlled resume-intake service adapter must exist');
	  const resumeIntakeAdapter = actionSource.slice(resumeIntakeAdapterStart, resumeIntakeAdapterEnd);
	  assert.match(
	    resumeIntakeAdapter,
	    /createResumeCandidateIntakeService\(\{[\s\S]*upsertCandidate: \(input\) => db\.upsertCandidate\(input\)/,
	    'candidate upsert may only be injected into the controlled resume-intake service',
	  );
	  assert.strictEqual((resumeIntakeAdapter.match(/upsertCandidate/g) || []).length, 2, 'resume-intake adapter should contain exactly one property and one db writer reference');
	  const actionSourceWithoutResumeIntakeAdapter = `${actionSource.slice(0, resumeIntakeAdapterStart)}${actionSource.slice(resumeIntakeAdapterEnd)}`;
	  assert.ok(!actionSourceWithoutResumeIntakeAdapter.includes('upsertCandidate'), 'action-server must not use candidate upsert outside the controlled resume-intake adapter');
	  for (const directRoute of ['/api/candidate', '/api/candidates', '/api/candidate/upsert', '/api/candidates/upsert']) {
	    assert.ok(!actionSource.includes(`url.pathname === '${directRoute}'`), `action-server must not expose direct candidate write route ${directRoute}`);
	  }
	  assert.match(
	    actionSource,
	    /req\.method === 'POST' && url\.pathname === '\/api\/candidate\/resume-intake\/commit'[\s\S]{0,300}getResumeCandidateIntakeService\(\)\.commit\(body\)/,
	    'resume candidate creation must stay behind the canonical commit route',
	  );
	  assert.strictEqual(routeCapability('POST', '/api/candidate/resume-intake/commit'), 'recruiting.write', 'resume-intake commit must retain the recruiting.write capability gate');
  const ro = new Database(db.DB_PATH, { readonly: true, fileMustExist: true });
  assert.throws(() => ro.exec('CREATE TABLE readonly_probe (id INTEGER)'), /readonly/i, 'sqlite readonly handle must reject writes');
  ro.close();

  for (const file of READONLY_FILES) {
    const source = read(file);
    for (const token of WRITE_TOKENS) {
      assert.ok(!source.includes(token), `${file} must not mention write token ${token}`);
    }
    assert.ok(!/https?:\/\/[^'"]*zhipin\.com/.test(source), `${file} must not request recruiting platform endpoints`);
  }
  assert.ok(read("src/candidate-main.js").includes('frontend') && read("src/candidate-main.js").includes('dist'), 'candidate-main.js must load the built frontend/dist output');
	  const topBarSource = read('frontend/src/components/TopBar.jsx');
	  const appSource = read('frontend/src/App.jsx');
	  const apiSource = read('frontend/src/api.js');
	  const interviewScheduleSource = read('frontend/src/components/InterviewSchedulePanel.jsx');
	  const interviewScheduleCanonicalSource = read('frontend/src/components/InterviewScheduleCanonical.jsx');
	  const statusTextDeclaration = /\bconst\s+statusText\s*=/.exec(topBarSource);
	  const statusTextStart = statusTextDeclaration ? statusTextDeclaration.index : -1;
	  const statusToneDeclaration = /\bconst\s+statusTone\s*=/.exec(topBarSource.slice(Math.max(statusTextStart, 0)));
	  const statusTextEnd = statusToneDeclaration ? Math.max(statusTextStart, 0) + statusToneDeclaration.index : -1;
	  assert.ok(statusTextStart >= 0 && statusTextEnd > statusTextStart,
	    'TopBar must compute one ordered local task status projection');
	  const statusTextProjection = topBarSource.slice(statusTextStart, statusTextEnd);
	  const priorityStates = {
	    activeStates: declaredStatusStates(topBarSource, 'Active'),
	    errorStates: declaredStatusStates(topBarSource, 'ErrorVisible'),
	    doneStates: declaredStatusStates(topBarSource, 'DoneVisible'),
	  };
	  assertStatusPriorityProjection(statusTextProjection, priorityStates);
	  for (const misplacedActive of priorityStates.activeStates) {
	    const syntheticRegression = [
	      ...priorityStates.activeStates.filter((state) => state !== misplacedActive),
	      ...priorityStates.errorStates,
	      misplacedActive,
	      ...priorityStates.doneStates,
	    ].map((state) => `${state} ? 'state' :`).join(' ');
	    assert.throws(
	      () => assertStatusPriorityProjection(syntheticRegression, priorityStates),
	      /all active status branches must precede every error branch/,
	      `priority contract must reject ${misplacedActive} after an error branch`,
	    );
	  }
  assert.ok(topBarSource.includes('DONE_STATUS_VISIBLE_MS') && topBarSource.includes('recentlyFinished') && topBarSource.includes('screenshotErrorVisible'), 'TopBar must ignore stale progress when rendering status text or disabling actions');
  assert.ok(topBarSource.includes('{statusText}'), 'TopBar must render the computed statusText');
  assert.ok(topBarSource.includes('currentJobIsFixture') && topBarSource.includes('测试数据'), 'TopBar must mark fixture jobs as test data');
  assert.ok(!topBarSource.includes('VITE_WRITE_ACTIONS_VISIBLE'), 'TopBar must not allow an environment flag to restore write actions');
  assert.ok(!topBarSource.includes('onStartGreet') && !topBarSource.includes('onStartRequestResume'), 'TopBar must not expose greeting or resume-request actions');
  assert.ok(!apiSource.includes('startGreet') && !apiSource.includes('startRequestResume'), 'frontend API must not expose write endpoints removed from the public build');
	  assert.ok(appSource.includes('function pickPreferredJob') && appSource.includes('preferReal'), 'App must prefer real jobs over fixture jobs after boot/sync');
	  assert.ok(appSource.includes('screenshotImportDoneRef') && appSource.includes('progressDoneKey'), 'App must refresh once per completed screenshot import progress, not on every poll');
	  assert.ok(dbSource.includes('skipped_missing_resume') && appSource.includes('人缺在线简历'), 'rating summary must distinguish missing online resumes from paywalls');
	  assert.ok(
	    /ORDER BY\s+job\.is_fixture ASC,[\s\S]*?job\.id/.test(dbSource),
	    'listJobs must return real jobs before fixture jobs while preserving deterministic ordering',
	  );
  assert.ok(appSource.includes('className={`nav-item') && appSource.includes('handleOpenNav(item)'), 'sidebar nav items must be real clickable controls with feedback');
  assert.ok(
    appSource.includes('PRIMARY_NAV_ITEMS') && appSource.includes('MOBILE_NAV_ITEMS') && !appSource.includes('PLANNED_NAV_ITEMS'),
    'sidebar and mobile navigation must expose the same available HR modules without planned-module noise',
  );
  assert.ok(!appSource.includes('nav-badge') && !appSource.includes('未开放'), 'sidebar should avoid unfinished-looking unavailable badges in the primary impression');
  assert.ok(appSource.includes('candidateListCollapsed') && appSource.includes('candidate-focus-bar') && appSource.includes('展开候选人列表'), 'candidate detail should support focused review mode with one explicit restore affordance');
  assert.ok(
    interviewScheduleSource.includes("import InterviewScheduleCanonical from './InterviewScheduleCanonical.jsx'")
      && interviewScheduleSource.includes('dataAdapter={fixtureAdapter}')
      && interviewScheduleSource.includes('fixtureMode'),
    'fixture interviews must reuse the canonical workspace through an isolated adapter',
  );
  assert.ok(
    !/from '\.\.\/api\.js'|\bapi\.|window\.|localStorage|sessionStorage|fetch\(/.test(interviewScheduleSource),
    'fixture interviews must not call production APIs, persistence or external services',
  );
  assert.ok(
    interviewScheduleCanonicalSource.includes('const canonicalWritesBlocked = !canonicalPartitionReady')
      && interviewScheduleCanonicalSource.includes('面试资料与录音工具')
      && interviewScheduleCanonicalSource.includes('fixtureMode={fixtureMode}'),
    'canonical interviews must preserve the authority write lock and secondary local-only tools',
  );

  // 新 React 前端源码：跟 candidate.html 一样是只读面，套同一条红线（不写库、不碰 Boss 域名）。
  for (const file of listFrontendSourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(PROJECT_ROOT, file);
    for (const token of WRITE_TOKENS) {
      assert.ok(!source.includes(token), `${rel} must not mention write token ${token}`);
    }
    assert.ok(!/zhipin/i.test(source), `${rel} must not mention Boss domain`);
  }

  const server = require('child_process').spawn(process.execPath, [path.join(PROJECT_ROOT, "src/db-server.js")], {
    cwd: PROJECT_ROOT,
    stdio: 'ignore',
    env: {
      ...process.env,
      HRBOSS_LOCAL_API_TOKEN: LOCAL_API_TOKEN,
      HRBOSS_LOCAL_API_INSTANCE_ID: 'check-ui-readonly',
      HRBOSS_SENSITIVE_READ_AUDIT_FILE: path.join(READ_AUDIT_ROOT, 'sensitive-read-audit.jsonl'),
      BOSS_READONLY_PORT: String(READONLY_TEST_PORT),
    },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
	    const unauthenticated = await getJson('/api/jobs', '');
	    assert.strictEqual(unauthenticated.status, 401, 'readonly local API must reject missing session token');
	    const childrenResponse = await getJson(`/api/candidates/${encodeURIComponent(candidate.internal_id)}/children`);
	    assert.strictEqual(childrenResponse.status, 200, 'authenticated sensitive read should succeed when its audit can be persisted');
	    const auditFile = path.join(READ_AUDIT_ROOT, 'sensitive-read-audit.jsonl');
	    const auditLines = fs.readFileSync(auditFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
	    assert.ok(auditLines.some((line) => line.action === 'candidate_children_read'), 'sensitive candidate read must be audited');
	    assert.ok(!fs.readFileSync(auditFile, 'utf8').includes(candidate.internal_id), 'sensitive read audit must hash the candidate target');
	    const response = await getJson(`/api/candidates/${encodeURIComponent(candidate.internal_id)}/keys`);
    assert.strictEqual(response.status, 404, '/api/candidates/:id/keys must return 404');
  } finally {
    server.kill();
  }

  console.log('check-ui-readonly ok');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
