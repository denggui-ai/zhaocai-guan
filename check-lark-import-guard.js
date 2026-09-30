const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = __dirname;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-lark-import-'));
const CALL_LOG = path.join(TMP_DIR, 'minutes-fetch-calls.log');
const LOCAL_API_TOKEN = 'test-local-api-token-lark-import-guard-0001';

process.on('exit', () => fs.rmSync(TMP_DIR, { recursive: true, force: true }));

function request(port, method, pathname, body) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: {
        'x-hrboss-token': LOCAL_API_TOKEN,
        ...(method === 'POST' ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        } : {}),
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

function post(port, pathname, body) {
  return request(port, 'POST', pathname, body);
}

function get(port, pathname) {
  return request(port, 'GET', pathname);
}

async function startServer({ port, dbPath, enabled }) {
  const loader = `
    const Module = require('module');
    const fs = require('fs');
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === './minutes-fetch' && parent && /action-server\\.js$/.test(parent.filename)) {
        return { fetchMinutesTranscript: async (sourceUrl) => {
          fs.appendFileSync(process.env.LARK_IMPORT_CALL_LOG, sourceUrl + '\\n');
          return '本地假转写：只用于验证显式导入边界。';
        } };
      }
      return originalLoad.apply(this, arguments);
    };
    require(process.env.ACTION_SERVER_PATH).startHttpServer();
  `;
  const child = spawn(process.execPath, ['-e', loader], {
    cwd: ROOT,
    env: {
      ...process.env,
      ACTION_SERVER_PATH: path.join(ROOT, 'action-server.js'),
      BOSS_ACTION_PORT: String(port),
      BOSS_DB_PATH: dbPath,
      ENABLE_LARK_IMPORT: enabled ? '1' : '',
      LARK_IMPORT_CALL_LOG: CALL_LOG,
      HRBOSS_LOCAL_API_TOKEN: LOCAL_API_TOKEN,
      HRBOSS_LOCAL_API_INSTANCE_ID: 'check-lark-import-guard',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk.toString(); });
  child.stderr.on('data', (chunk) => { log += chunk.toString(); });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (log.includes(`http://127.0.0.1:${port}`)) return child;
    if (child.exitCode != null) throw new Error(`action-server exited early: ${log}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill('SIGTERM');
  throw new Error(`action-server did not start: ${log}`);
}

function callCount() {
  if (!fs.existsSync(CALL_LOG)) return 0;
  return fs.readFileSync(CALL_LOG, 'utf8').split('\n').filter(Boolean).length;
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    child.once('exit', resolve);
    setTimeout(resolve, 2000);
  });
}

async function runBoundary(enabled, offset) {
  const port = 18800 + (process.pid % 500) * 2 + offset;
  const dbPath = path.join(TMP_DIR, `lark-${enabled ? 'enabled' : 'disabled'}.db`);
  const db = require('./db');
  const database = db.openDb(dbPath);
  database.prepare(`
    INSERT INTO job (id, encrypt_job_id, numeric_job_id, name, hr_owner, created_at)
    VALUES (1, 'local-lark-boundary', '100000000000000099', '本地会议导入边界测试', 'Fixture HR', ?)
  `).run(new Date().toISOString());
  database.close();

  const child = await startServer({ port, dbPath, enabled });
  try {
    let res = await get(port, '/api/interview/import-lark/status');
    assert.equal(res.status, 200, '能力状态端点应始终只读可用');
    assert.equal(res.body.enabled, enabled, '能力状态必须反映 ENABLE_LARK_IMPORT');
    assert.equal(res.body.status, enabled ? 'enabled' : 'disabled');
    assert.equal(res.body.source_type, 'lark_minutes');
    assert.equal(res.body.requires_explicit_action, true);
    assert.equal(callCount(), 0, '读取能力状态不得调用转写拉取器');

    res = await post(port, '/api/interview', {
      jobId: 1,
      sourceUrl: 'https://example.test/minutes/ShouldNeverAutoImport',
    });
    assert.equal(res.status, 400, '普通保存只有链接时必须拒绝');
    assert.match(res.body.error, /不会自动拉取/);
    assert.equal(callCount(), 0, '普通保存不得调用转写拉取器');

    res = await post(port, '/api/interview', {
      jobId: 1,
      transcript: '本地已有转写',
      sourceType: 'offline_recording',
      note: '线下录音转写',
    });
    assert.equal(res.status, 200, '线下录音转写应可直接保存');
    assert.equal(res.body.source_type, 'offline_recording');
    assert.equal(callCount(), 0, '保存已有转写不得调用转写拉取器');
    let persisted = new Database(dbPath, { readonly: true });
    let persistedRows = persisted.prepare('SELECT source_type FROM job_interview ORDER BY id').all();
    persisted.close();
    assert.deepEqual(persistedRows.map((row) => row.source_type), ['offline_recording'], '线下来源必须写入真实 source_type 列');

    res = await post(port, '/api/interview/import-lark', {
      jobId: 1,
      sourceUrl: 'https://example.test/minutes/ExplicitImportOnly',
    });
    if (!enabled) {
      assert.equal(res.status, 403, '默认关闭时显式导入也必须无副作用地拒绝');
      assert.equal(res.body.code, 'lark_import_disabled');
      assert.equal(res.body.status, 'disabled');
      assert.equal(callCount(), 0, '开关关闭时不得调用转写拉取器');
    } else {
      assert.equal(res.status, 200, '开启后显式导入动作应进入转写拉取器');
      assert.equal(res.body.source_type, 'lark_minutes');
      assert.equal(callCount(), 1, '开启后也只能由显式导入动作调用一次');
      persisted = new Database(dbPath, { readonly: true });
      persistedRows = persisted.prepare('SELECT source_type FROM job_interview ORDER BY id').all();
      persisted.close();
      assert.deepEqual(persistedRows.map((row) => row.source_type), ['offline_recording', 'lark_minutes'], '线上导入来源必须写入真实 source_type 列');
    }

    res = await get(port, '/api/interview?jobId=1');
    assert.equal(res.status, 200);
    const sourceTypes = res.body.interviews.map((row) => row.source_type);
    assert.ok(sourceTypes.includes('offline_recording'), '列表响应应返回线下录音 source_type');
    if (enabled) assert.ok(sourceTypes.includes('lark_minutes'), '列表响应应返回线上导入 source_type');
  } finally {
    await stopServer(child);
  }
}

(async () => {
  await runBoundary(false, 0);
  await runBoundary(true, 1);
  console.log('check-lark-import-guard ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
