#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const EXECUTABLE_NAME = 'ZhaocaiGuan';
const STARTUP_TIMEOUT_MS = 70_000;
const SHUTDOWN_TIMEOUT_MS = 25_000;

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--keep-test-data') {
      values.keepTestData = true;
      continue;
    }
    if (argument === '--app' || argument === '--evidence-root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      values[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(
        'Usage: node release/macos-candidate-self-test.js --app /path/to/招才官.app '
        + '[--evidence-root /path/to/evidence] [--keep-test-data]\n',
      );
      process.exit(0);
    }
    throw new Error(`unknown argument: ${argument}`);
  }
  return values;
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function command(file, args, options = {}) {
  const result = spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(
      `${path.basename(file)} ${args.join(' ')} failed (${result.status}): `
      + `${result.stderr || result.stdout || 'no output'}`,
    );
  }
  return result;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await wait(250);
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`);
}

function readPackageProcesses(appRoot) {
  const output = command('/bin/ps', ['-axo', 'pid=,ppid=,command=']).stdout;
  const packageExecutablePrefix = `${appRoot}${path.sep}Contents${path.sep}`;
  return output.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] } : null;
  }).filter((row) => row && row.command.includes(packageExecutablePrefix));
}

function readTcpEndpoints(processIds) {
  if (processIds.length === 0) return [];
  const result = command(
    '/usr/sbin/lsof',
    ['-nP', '-a', '-iTCP', `-p${processIds.join(',')}`, '-FpnT'],
    { allowFailure: true },
  );
  if (result.status !== 0 && !result.stdout.trim()) return [];
  let currentPid = null;
  let currentEndpoint = null;
  const endpoints = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (line.startsWith('p')) {
      currentPid = Number(line.slice(1));
    } else if (line.startsWith('n')) {
      currentEndpoint = { pid: currentPid, name: line.slice(1), state: '' };
      endpoints.push(currentEndpoint);
    } else if (line.startsWith('TST=') && currentEndpoint) {
      currentEndpoint.state = line.slice(4);
    }
  }
  return endpoints;
}

function isLoopbackAddress(endpoint) {
  return endpoint.startsWith('127.0.0.1:') || endpoint.startsWith('[::1]:');
}

function assertLoopbackOnly(endpoints) {
  for (const endpoint of endpoints) {
    const sides = endpoint.name.split('->');
    assert.ok(
      sides.every(isLoopbackAddress),
      `package opened a non-loopback TCP endpoint: ${endpoint.name}`,
    );
  }
}

function packageLayout(appInput) {
  const appRoot = fs.realpathSync(path.resolve(appInput));
  const contents = path.join(appRoot, 'Contents');
  const resources = path.join(contents, 'Resources', 'app');
  const executable = path.join(contents, 'MacOS', EXECUTABLE_NAME);
  const nativeModule = path.join(
    resources,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  const moduleDirectory = path.join(resources, 'node_modules', 'better-sqlite3');
  const releaseBuildPath = path.join(resources, 'release-build.json');
  const required = [
    executable,
    nativeModule,
    path.join(resources, "src/candidate-main.js"),
    path.join(resources, "src/preload.js"),
    path.join(resources, "src/resume-structure.js"),
    path.join(resources, "src/screenshot-ai-import-state.js"),
    path.join(resources, "src/screenshot-import-task-public.js"),
    releaseBuildPath,
    path.join(resources, 'frontend', 'dist', 'index.html'),
  ];
  for (const file of required) assert.ok(fs.statSync(file).isFile(), `package file missing: ${file}`);
  const releaseBuild = JSON.parse(fs.readFileSync(releaseBuildPath, 'utf8'));
  const packagedManifest = JSON.parse(fs.readFileSync(path.join(resources, 'package.json'), 'utf8'));
  assert.equal(releaseBuild.schema_version, 'hrboss_release_build_v1');
  assert.match(String(releaseBuild.source_commit || ''), /^[a-f0-9]{40}$/);
  assert.match(String(releaseBuild.source_tree || ''), /^[a-f0-9]{40}$/);
  assert.equal(releaseBuild.source_worktree_state, 'clean');
  assert.equal(releaseBuild.application_version, packagedManifest.version);
  assert.equal(releaseBuild.target, 'darwin-arm64');
  const frozenSourceRoot = path.resolve(__dirname, '..');
  assert.equal(
    releaseBuild.lockfiles?.root_package_lock_sha256,
    sha256File(path.join(frozenSourceRoot, 'package-lock.json')),
    'frozen source root lockfile does not match release-build identity',
  );
  assert.equal(
    releaseBuild.lockfiles?.frontend_package_lock_sha256,
    sha256File(path.join(frozenSourceRoot, 'frontend', 'package-lock.json')),
    'frozen source frontend lockfile does not match release-build identity',
  );
  return {
    appRoot,
    contents,
    resources,
    executable,
    nativeModule,
    moduleDirectory,
    releaseBuild,
  };
}

function inspectPackage(layout) {
  command('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', layout.appRoot]);
  const executableArch = command('/usr/bin/lipo', ['-archs', layout.executable]).stdout.trim();
  const nativeArch = command('/usr/bin/lipo', ['-archs', layout.nativeModule]).stdout.trim();
  assert.equal(executableArch, 'arm64', `main executable architecture is ${executableArch}`);
  assert.equal(nativeArch, 'arm64', `better_sqlite3 architecture is ${nativeArch}`);

  const checksumFile = path.join(path.dirname(layout.appRoot), 'SHA256SUMS.txt');
  assert.ok(fs.statSync(checksumFile).isFile(), 'candidate SHA256SUMS.txt is missing');
  const checksumRows = fs.readFileSync(checksumFile, 'utf8').trim().split(/\r?\n/).map((line) => {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/);
    assert.ok(match, `invalid checksum row: ${line}`);
    return { expected: match[1], relativePath: match[2] };
  });
  for (const row of checksumRows) {
    const target = path.resolve(path.dirname(layout.appRoot), row.relativePath);
    assert.ok(target.startsWith(`${path.dirname(layout.appRoot)}${path.sep}`), 'checksum target escaped candidate root');
    assert.equal(sha256File(target), row.expected, `checksum mismatch: ${row.relativePath}`);
  }

  const forbidden = [];
  const topLevelForbidden = [
    'data', 'tests', 'scripts', 'docs', '.superpowers', 'handoff', 'release', 'rating-config.json', '.env',
    '.github', '.impeccable', '.gitattributes', 'forge.config.js',
  ];
  for (const name of topLevelForbidden) {
    if (fs.existsSync(path.join(layout.resources, name))) forbidden.push(name);
  }
  const stack = [layout.resources];
  while (stack.length > 0) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (
        /^check-.*\.js$/i.test(entry.name)
        || /\.(?:db|sqlite|sqlite3)$/i.test(entry.name)
        || /^\.env(?:\.|$)/i.test(entry.name)
      ) {
        forbidden.push(path.relative(layout.resources, fullPath));
      }
    }
  }
  assert.deepEqual(forbidden, [], `package contains forbidden test/data files: ${forbidden.join(', ')}`);

  const signature = command('/usr/bin/codesign', ['-dv', '--verbose=4', layout.appRoot], { allowFailure: true });
  const signatureText = `${signature.stdout}\n${signature.stderr}`;
  return {
    executable_architecture: executableArch,
    native_module_architecture: nativeArch,
    executable_sha256: sha256File(layout.executable),
    native_module_sha256: sha256File(layout.nativeModule),
    checksum_count: checksumRows.length,
    signing: /Signature=adhoc/.test(signatureText) ? 'ad-hoc' : 'identity',
    build_identity: layout.releaseBuild,
  };
}

function probeSource() {
  return `
'use strict';
const fs = require('fs');
const path = require('path');
const Database = require(process.argv[2]);
const databasePath = process.argv[3];
const mode = process.argv[4];
const marker = process.argv[5];
const resources = process.argv[6];
const recoveryRoot = process.argv[7];
const restoreRoot = process.argv[8];

async function main() {
  if (mode === 'seed') {
    const db = new Database(databasePath);
    try {
      db.exec(\`
        CREATE TABLE job (
          id INTEGER PRIMARY KEY,
          encrypt_job_id TEXT NOT NULL,
          numeric_job_id TEXT,
          name TEXT,
          hr_owner TEXT,
          created_at TEXT
        );
        CREATE TABLE job_interview (
          id INTEGER PRIMARY KEY,
          job_id INTEGER NOT NULL REFERENCES job(id),
          source_url TEXT,
          transcript TEXT NOT NULL,
          note TEXT,
          created_at TEXT
        );
        CREATE TABLE screenshot_ocr_draft (
          id INTEGER PRIMARY KEY,
          draft_key TEXT NOT NULL UNIQUE,
          draft_id TEXT NOT NULL,
          evidence_batch_id TEXT,
          job_id INTEGER NOT NULL REFERENCES job(id),
          job_name TEXT,
          status TEXT NOT NULL DEFAULT 'pending_review'
            CHECK(status IN ('pending_review', 'confirmed', 'rejected')),
          original_json TEXT NOT NULL,
          current_json TEXT NOT NULL,
          field_evidence_json TEXT NOT NULL,
          review_flags_json TEXT NOT NULL,
          context_json TEXT NOT NULL,
          candidate_id TEXT,
          reviewed_by TEXT,
          reviewed_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO job VALUES (
          1, 'synthetic-legacy-job', 'fixture-1001', '合成迁移岗位', 'HR-FIXTURE',
          '2026-07-01T00:00:00.000Z'
        );
        INSERT INTO job_interview VALUES (
          1, 1, NULL, '合成访谈转写，仅用于候选包迁移测试。', '合成测试',
          '2026-07-01T01:00:00.000Z'
        );
        INSERT INTO screenshot_ocr_draft (
          id, draft_key, draft_id, evidence_batch_id, job_id, job_name, status,
          original_json, current_json, field_evidence_json, review_flags_json, context_json,
          created_at, updated_at
        ) VALUES (
          1, 'synthetic-legacy-draft', 'fixture-draft', NULL, 1, '合成迁移岗位', 'pending_review',
          '{}', '{}', '{}', '{}', '{}',
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z'
        );
      \`);
    } finally {
      db.close();
    }
    process.stdout.write(JSON.stringify({ ok: true, mode }));
    return;
  }

  if (mode === 'restore') {
    const recoveryIds = fs.readdirSync(recoveryRoot)
      .filter((name) => !name.startsWith('.'))
      .filter((name) => fs.statSync(path.join(recoveryRoot, name)).isDirectory());
    if (recoveryIds.length !== 1) throw new Error(\`expected one recovery package, got \${recoveryIds.length}\`);
    const recoveryId = recoveryIds[0];
    const manifest = JSON.parse(fs.readFileSync(path.join(recoveryRoot, recoveryId, 'manifest.json'), 'utf8'));
    const { restoreSqliteBackup } = require(path.join(resources, 'src', 'sqlite-backup-recovery'));
    const result = await restoreSqliteBackup({
      recoveryRoot,
      recoveryId,
      restoreRoot,
      destinationName: 'restored-legacy.db',
      appVersion: manifest.app_version,
      policyVersion: manifest.policy_version,
      now: new Date().toISOString(),
      confirmed: true,
      criticalQueries: [{ sql: 'SELECT id FROM job WHERE id = ?', params: [1], minRows: 1 }],
    });
    const restoredPath = path.join(restoreRoot, result.destination_name);
    const restored = new Database(restoredPath, { readonly: true, fileMustExist: true });
    try {
      const row = restored.prepare('SELECT id, name FROM job WHERE id = 1').get();
      const columns = restored.prepare("PRAGMA table_info('job')").all().map((column) => column.name);
      if (!row || row.name !== '合成迁移岗位') throw new Error('restored legacy row mismatch');
      if (columns.includes('is_fixture')) throw new Error('recovery point was not captured before migration');
      process.stdout.write(JSON.stringify({
        ok: true,
        mode,
        recoveryId,
        restoredPath,
        preMigrationSnapshot: true,
      }));
    } finally {
      restored.close();
    }
    return;
  }

  const db = new Database(databasePath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all().map((row) => row.name);
    for (const table of [
      'audit_log', 'candidate', 'assessment_document', 'application_episode',
      'candidate_offer_status',
    ]) {
      if (!tables.includes(table)) throw new Error(\`required table missing: \${table}\`);
    }
    const legacyRow = db.prepare('SELECT id, name, is_fixture, source_type FROM job WHERE id = 1').get();
    if (!legacyRow || legacyRow.name !== '合成迁移岗位') throw new Error('legacy row did not survive migration');
    if (mode === 'write') {
      db.prepare(\`
        INSERT INTO audit_log(action, target, who, auto, result, detail_json, created_at)
        VALUES (?, ?, ?, 0, 'ok', ?, ?)
      \`).run(
        'macos_candidate_acceptance_probe',
        marker,
        'macos-candidate-self-test',
        JSON.stringify({ marker }),
        new Date().toISOString(),
      );
      process.stdout.write(JSON.stringify({ ok: true, mode, marker, tableCount: tables.length, legacyRow }));
      return;
    }
    if (mode === 'read') {
      const row = db.prepare(\`
        SELECT id, action, target, result
        FROM audit_log
        WHERE action = 'macos_candidate_acceptance_probe' AND target = ?
        ORDER BY id DESC LIMIT 1
      \`).get(marker);
      if (!row) throw new Error('persistence marker was not found after restart');
      process.stdout.write(JSON.stringify({ ok: true, mode, marker, tableCount: tables.length, row, legacyRow }));
      return;
    }
    throw new Error(\`unknown mode: \${mode}\`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  process.stderr.write(\`\${error.stack || error.message}\n\`);
  process.exit(1);
});
`;
}

function runDatabaseProbe(layout, runtime, mode, marker = '') {
  const result = command(
    layout.executable,
    [
      runtime.probeScript,
      layout.moduleDirectory,
      runtime.databasePath,
      mode,
      marker,
      layout.resources,
      runtime.recoveryRoot,
      runtime.restoreRoot,
    ],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        HRBOSS_EXTERNAL_AI_ENABLED: '0',
        HRBOSS_EXTERNAL_AI_API_KEY: '',
        BOSS_ACTION_AUTOMATION_ENABLED: '0',
        HRBOSS_BOSS_ACTIVE_SEARCH_ENABLED: '0',
        ENABLE_LARK_IMPORT: '0',
      },
    },
  );
  return JSON.parse(result.stdout);
}

function isolatedEnvironment(runtime) {
  const environment = {
    ...process.env,
    HRBOSS_UI_FIXTURE_GATE: '1',
    HRBOSS_UI_FIXTURE_ROOT: runtime.root,
    HRBOSS_UI_FIXTURE_TEMP_PARENT: fs.realpathSync(os.tmpdir()),
    HRBOSS_EXTERNAL_AI_ENABLED: '0',
    HRBOSS_EXTERNAL_AI_API_KEY: '',
    BOSS_ACTION_AUTOMATION_ENABLED: '0',
    HRBOSS_BOSS_ACTIVE_SEARCH_ENABLED: '0',
    ENABLE_LARK_IMPORT: '0',
    BOSS_READONLY_UI: '0',
    HRBOSS_DATA_DIR: runtime.dataDirectory,
    BOSS_DB_PATH: runtime.databasePath,
    BOSS_PROFILE_DATA_DIR: runtime.profileDirectory,
    HRBOSS_INTERVIEW_OUTPUT_DIR: runtime.interviewDirectory,
    HRBOSS_RECOVERY_ROOT: runtime.recoveryRoot,
    HRBOSS_ASSESSMENT_RECOVERY_ROOT: runtime.assessmentRecoveryRoot,
    HRBOSS_SENSITIVE_READ_AUDIT_FILE: path.join(runtime.dataDirectory, 'sensitive-read-audit.jsonl'),
    HRBOSS_RATING_CONFIG_PATH: path.join(runtime.dataDirectory, 'nonexistent-rating-config.json'),
    TMPDIR: runtime.root,
    TMP: runtime.root,
    TEMP: runtime.root,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.HRBOSS_RENDERER_URL;
  return environment;
}

async function startApplication(layout, runtime, evidenceDirectory, cycle) {
  const stdoutPath = path.join(evidenceDirectory, `cycle-${cycle}-stdout.log`);
  const stderrPath = path.join(evidenceDirectory, `cycle-${cycle}-stderr.log`);
  const child = spawn(
    layout.executable,
    [`--user-data-dir=${runtime.userDataDirectory}`, '--disable-gpu'],
    {
      cwd: path.dirname(layout.executable),
      env: isolatedEnvironment(runtime),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    fs.appendFileSync(stdoutPath, chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    fs.appendFileSync(stderrPath, chunk);
  });
  const exit = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  try {
    const ready = await waitUntil(() => {
      if (child.exitCode !== null || child.signalCode) {
        throw new Error(`application exited before readiness: ${stderr || stdout}`);
      }
      if (!stdout.includes('readonly db server http://127.0.0.1:')) return false;
      if (!stdout.includes('action db server http://127.0.0.1:')) return false;
      if (!fs.existsSync(runtime.databasePath) || fs.statSync(runtime.databasePath).size <= 0) return false;
      const processes = readPackageProcesses(layout.appRoot);
      const endpoints = readTcpEndpoints(processes.map((process) => process.pid));
      const listeners = endpoints.filter((endpoint) => endpoint.state === 'LISTEN');
      if (listeners.length !== 2) return false;
      return { processes, endpoints, listeners };
    }, STARTUP_TIMEOUT_MS, `cycle ${cycle} packaged application readiness`);
    await wait(1500);
    assert.equal(child.exitCode, null, `cycle ${cycle} application exited after readiness`);
    assertLoopbackOnly(ready.endpoints);
    assert.equal(ready.listeners.length, 2, `cycle ${cycle} must have exactly two TCP listeners`);
    return { child, exit, ready, stdoutPath, stderrPath };
  } catch (error) {
    try { child.kill('SIGTERM'); } catch {}
    throw error;
  }
}

async function stopApplication(layout, running, cycle) {
  assert.equal(running.child.exitCode, null, `cycle ${cycle} exited before normal quit`);
  // A previously installed copy may share the bundle ID; quit only this child.
  const quit = command(
    '/usr/bin/swift',
    [path.join(__dirname, 'quit-macos-candidate.swift'), String(running.child.pid), layout.appRoot],
    { allowFailure: true },
  );
  if (quit.status !== 0) {
    try { running.child.kill('SIGTERM'); } catch {}
    throw new Error(`cycle ${cycle} normal quit failed: ${quit.stderr || quit.stdout}`);
  }
  const exit = await Promise.race([
    running.exit,
    wait(SHUTDOWN_TIMEOUT_MS).then(() => null),
  ]);
  if (!exit) {
    try { running.child.kill('SIGTERM'); } catch {}
    throw new Error(`cycle ${cycle} application did not exit after normal quit`);
  }
  assert.equal(exit.code, 0, `cycle ${cycle} application exit code ${exit.code}, signal ${exit.signal}`);
  await waitUntil(
    () => readPackageProcesses(layout.appRoot).length === 0,
    SHUTDOWN_TIMEOUT_MS,
    `cycle ${cycle} residual package processes`,
  );
}

function createRuntimeRoot() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hrboss-macos-candidate-runtime-'));
  fs.chmodSync(root, 0o700);
  const userDataDirectory = privateDirectory(path.join(root, 'user-data'));
  const dataDirectory = privateDirectory(path.join(userDataDirectory, 'data'));
  const restoreRoot = privateDirectory(path.join(root, 'restored'));
  const runtime = {
    root,
    userDataDirectory,
    dataDirectory,
    databasePath: path.join(dataDirectory, 'recruiting.db'),
    profileDirectory: privateDirectory(path.join(dataDirectory, 'boss-profile')),
    interviewDirectory: privateDirectory(path.join(dataDirectory, 'interviews')),
    recoveryRoot: path.join(dataDirectory, 'recovery'),
    assessmentRecoveryRoot: path.join(dataDirectory, 'assessment-recovery'),
    restoreRoot,
    probeScript: path.join(root, 'database-probe.js'),
  };
  fs.writeFileSync(runtime.probeScript, probeSource(), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return runtime;
}

function renderSummary(summary) {
  const lines = [
    '# 招才官 macOS arm64 候选包自动反向验收',
    '',
    `- 自动技术结果：**${summary.technical_result}**`,
    `- 自动验收建议：**${summary.release_decision}**（不替代负责人发布决定）`,
    `- 候选包：${summary.package.app}`,
    `- 运行边界：fixture gate 开启；外部 AI、Boss 自动化、主动搜索、飞书导入均关闭`,
    `- 签名：${summary.package.signing}（本项不证明 Developer ID 身份或 Apple 公证）`,
    '',
    '| 状态 | 编号 | 检查 | 证据 |',
    '|---|---|---|---|',
    ...summary.checks.map((check) => (
      `| ${check.status} | ${check.code} | ${check.title} | ${String(check.detail).replaceAll('|', '\\|')} |`
    )),
    '',
    '## 结论',
    '',
    summary.decision_note,
  ];
  return `${lines.join('\n')}\n`;
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error(`real macOS arm64 host required; got ${process.platform}/${process.arch}`);
  }
  const options = parseArgs(process.argv.slice(2));
  const appInput = options.app || process.env.HRBOSS_MAC_CANDIDATE_APP;
  if (!appInput) throw new Error('--app or HRBOSS_MAC_CANDIDATE_APP is required');
  const evidenceDirectory = options['evidence-root']
    ? privateDirectory(path.resolve(options['evidence-root']))
    : fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hrboss-macos-candidate-evidence-'));
  fs.chmodSync(evidenceDirectory, 0o700);
  const layout = packageLayout(appInput);
  assert.deepEqual(readPackageProcesses(layout.appRoot), [], 'candidate package is already running');
  const runtime = createRuntimeRoot();
  const checks = [];
  let activeApplication = null;

  const addCheck = (status, code, title, detail) => {
    const check = { status, code, title, detail };
    checks.push(check);
    process.stdout.write(`[${status}] ${code} ${title}: ${detail}\n`);
  };

  try {
    const packageEvidence = inspectPackage(layout);
    addCheck('PASS', 'PKG-INTEGRITY', '候选包结构、哈希与深度签名', 'SHA256 清单和 codesign --deep --strict 均通过。');
    addCheck('PASS', 'PKG-ARM64', '主程序与 SQLite 原生模块架构', '两者均为 arm64。');
    addCheck('PASS', 'PKG-CLEAN', '包内无测试脚本与历史数据', '未发现 data、数据库、.env、handoff、release 或 check-*.js。');
    addCheck(
      packageEvidence.signing === 'ad-hoc' ? 'WARN' : 'PASS',
      'PKG-SIGN',
      'macOS 分发身份',
      packageEvidence.signing === 'ad-hoc'
        ? '当前为 ad-hoc 本地签名，未取得 Developer ID 身份或 Apple 公证；首版允许未公证分发，但仍须完成人工验收并由负责人明确决定发布。'
        : '检测到非 ad-hoc 签名；若声明 Developer ID 身份或已公证，仍须由对应签名与公证门禁验证。',
    );

    const seeded = runDatabaseProbe(layout, runtime, 'seed');
    assert.equal(seeded.ok, true);
    addCheck('PASS', 'MIGRATION-SEED', '合成旧库准备', '只写入隔离临时目录，不含真实候选人或 Boss 数据。');

    activeApplication = await startApplication(layout, runtime, evidenceDirectory, 1);
    addCheck(
      'PASS',
      'RUN-START-1',
      '打包 App 首次启动',
      `${activeApplication.ready.processes.length} 个包进程；两个动态本地服务已就绪。`,
    );
    addCheck(
      'PASS',
      'RUN-LOOPBACK-1',
      '首次启动无外部网络连接',
      activeApplication.ready.listeners.map((endpoint) => endpoint.name).join(', '),
    );
    assert.ok(path.resolve(runtime.databasePath).startsWith(`${path.resolve(runtime.userDataDirectory)}${path.sep}`));
    assert.equal(fs.statSync(runtime.databasePath).mode & 0o077, 0, 'database permissions are not private');
    addCheck('PASS', 'DATA-PRIVATE', '数据库隔离与私有权限', `${runtime.databasePath}; mode=${(fs.statSync(runtime.databasePath).mode & 0o777).toString(8)}`);
    await stopApplication(layout, activeApplication, 1);
    activeApplication = null;
    addCheck('PASS', 'RUN-QUIT-1', '首次正常退出无残留', '主进程和本地服务均以退出码 0 结束。');

    const restored = runDatabaseProbe(layout, runtime, 'restore');
    assert.equal(restored.preMigrationSnapshot, true);
    addCheck(
      'PASS',
      'MIGRATION-BACKUP-RESTORE',
      '迁移前备份与独立恢复',
      `恢复包 ${restored.recoveryId} 已校验哈希、完整性和迁移前旧字段。`,
    );

    const marker = crypto.randomUUID();
    const writeProbe = runDatabaseProbe(layout, runtime, 'write', marker);
    assert.equal(writeProbe.ok, true);
    addCheck(
      'PASS',
      'MIGRATION-UPGRADE',
      '打包运行时迁移完整',
      `${writeProbe.tableCount} 张表；旧岗位与访谈仍可读，测评、Application、Offer 表均存在。`,
    );

    activeApplication = await startApplication(layout, runtime, evidenceDirectory, 2);
    addCheck(
      'PASS',
      'RUN-START-2',
      '同一隔离数据目录重启',
      `${activeApplication.ready.processes.length} 个包进程；两个动态回环服务重新就绪。`,
    );
    addCheck(
      'PASS',
      'RUN-LOOPBACK-2',
      '重启后仍无外部网络连接',
      activeApplication.ready.listeners.map((endpoint) => endpoint.name).join(', '),
    );
    await stopApplication(layout, activeApplication, 2);
    activeApplication = null;
    addCheck('PASS', 'RUN-QUIT-2', '第二次正常退出无残留', '重启后再次正常退出，未留下候选包进程。');

    const readProbe = runDatabaseProbe(layout, runtime, 'read', marker);
    assert.equal(readProbe.row.target, marker);
    addCheck(
      'PASS',
      'DB-PERSIST',
      '数据跨重启持久化',
      `audit_log id=${readProbe.row.id}; 合成旧岗位与迁移后表结构均保留。`,
    );
    assert.equal(readPackageProcesses(layout.appRoot).length, 0);
    addCheck('PASS', 'RUN-RESIDUAL', '最终无进程残留', '两轮启动和正常退出后未发现候选包进程。');

    const summary = {
      schema_version: 'hrboss_macos_candidate_acceptance_v1',
      created_at: new Date().toISOString(),
      technical_result: 'PASS',
      release_decision: 'GO WITH CONDITIONS',
      decision_note:
        '自动技术检查通过，可继续 macOS arm64 人工 HR 业务与安装验收；本结果不授权公开发布。'
        + '既定首版允许未公证包，须如实说明签名、公证、安装放行方法及未验证范围，并由负责人对最终产物明确作出发布决定。'
        + 'Developer ID 与 Apple 公证属于后续发布渠道；选用该渠道时必须通过其全部签名、公证门禁。',
      package: {
        app: layout.appRoot,
        ...packageEvidence,
      },
      safety: {
        fixture_gate: true,
        external_ai_enabled: false,
        boss_action_automation_enabled: false,
        boss_active_search_enabled: false,
        lark_import_enabled: false,
        real_data_used: false,
      },
      checks,
    };
    fs.writeFileSync(path.join(evidenceDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(evidenceDirectory, 'summary.md'), renderSummary(summary), { mode: 0o600 });
    process.stdout.write(`Evidence: ${evidenceDirectory}\n`);
  } finally {
    if (activeApplication) {
      try { activeApplication.child.kill('SIGTERM'); } catch {}
    }
    for (const processInfo of readPackageProcesses(layout.appRoot)) {
      try { process.kill(processInfo.pid, 'SIGTERM'); } catch {}
    }
    if (!options.keepTestData) fs.rmSync(runtime.root, { recursive: true, force: true });
    else process.stdout.write(`Runtime data retained: ${runtime.root}\n`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = { probeSource };
