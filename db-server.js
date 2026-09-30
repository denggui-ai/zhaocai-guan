const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const { authorizeLocalRequest, handleLocalPreflight, healthPayload, requireLocalApiToken } = require('./local-api-security');
const { projectOperationalReadonlyGet } = require('./operational-readonly-projection');
db.useReadonly({ operational: process.env.BOSS_READONLY_UI === '1' });

const HOST = '127.0.0.1';
const PORT = Number(process.env.BOSS_READONLY_PORT || 17732);
const LOCAL_API_TOKEN = requireLocalApiToken();
const INSTANCE_ID = process.env.HRBOSS_LOCAL_API_INSTANCE_ID || 'standalone';
const DATA_DIR = process.env.HRBOSS_DATA_DIR ? path.resolve(process.env.HRBOSS_DATA_DIR) : path.join(__dirname, 'data');
const SENSITIVE_READ_AUDIT_FILE = process.env.HRBOSS_SENSITIVE_READ_AUDIT_FILE
  ? path.resolve(process.env.HRBOSS_SENSITIVE_READ_AUDIT_FILE)
  : path.join(DATA_DIR, 'sensitive-read-audit.jsonl');
if (path.basename(SENSITIVE_READ_AUDIT_FILE) !== 'sensitive-read-audit.jsonl') {
  throw new Error('HRBOSS_SENSITIVE_READ_AUDIT_FILE 文件名无效。');
}
function validateSensitiveAuditStorage() {
  const directory = path.dirname(SENSITIVE_READ_AUDIT_FILE);
  const directoryStat = fs.lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('敏感读取审计目录必须是已存在的普通目录。');
  }
  if (process.platform !== 'win32' && (directoryStat.mode & 0o077) !== 0) {
    throw new Error('敏感读取审计目录权限不安全；请先在正常模式修复。');
  }
  try {
    const fileStat = fs.lstatSync(SENSITIVE_READ_AUDIT_FILE);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error('敏感读取审计文件必须是普通文件。');
    }
    if (process.platform !== 'win32' && (fileStat.mode & 0o077) !== 0) {
      throw new Error('敏感读取审计文件权限不安全；请先在正常模式修复。');
    }
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

function auditTarget(value) {
  return crypto.createHash('sha256').update(String(value || 'unknown'), 'utf8').digest('hex');
}

function auditSensitiveRead(action, target) {
  try {
    validateSensitiveAuditStorage();
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0);
    const descriptor = fs.openSync(SENSITIVE_READ_AUDIT_FILE, flags, 0o600);
    try {
      const descriptorStat = fs.fstatSync(descriptor);
      if (!descriptorStat.isFile()) {
        throw new Error('敏感读取审计文件必须是普通文件。');
      }
      if (process.platform !== 'win32' && (descriptorStat.mode & 0o077) !== 0) {
        throw new Error('敏感读取审计文件权限不安全；请先在正常模式修复。');
      }
      fs.writeSync(descriptor, `${JSON.stringify({
        schema_version: 1,
        action,
        target_hash: auditTarget(target),
        actor: 'local-primary-operator',
        instance_id: INSTANCE_ID,
        created_at: new Date().toISOString(),
      })}\n`, null, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    throw new Error(`本地数据目录 ${path.dirname(SENSITIVE_READ_AUDIT_FILE)} 无法写入访问审计，已拒绝返回数据。请确认该目录存在且仅当前用户可读写后重试。`);
  }
}

function send(res, code, data) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendFile(res, file, audit) {
  const body = fs.readFileSync(file.path);
  if (audit) auditSensitiveRead(audit.action, audit.target);
  res.writeHead(200, {
    'content-type': file.content_type,
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}

function route(req, res) {
  try {
    if (handleLocalPreflight(req, res)) return;
    if (!authorizeLocalRequest(req, res, LOCAL_API_TOKEN)) return;
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'GET only' });

    if (url.pathname === '/api/health') {
      // readiness 必须验证数据库可打开，而不是只证明 HTTP 端口活着。
      db.listJobs();
      return send(res, 200, healthPayload('readonly', INSTANCE_ID));
    }

    const operationalProjection = projectOperationalReadonlyGet(url);
    if (operationalProjection.handled) {
      if (operationalProjection.audit) {
        auditSensitiveRead(operationalProjection.audit.action, operationalProjection.audit.target);
      }
      return send(res, operationalProjection.status, operationalProjection.body);
    }

    if (url.pathname === '/api/jobs') return send(res, 200, { ok: true, jobs: db.listJobs() });
    if (url.pathname === '/api/talent-pool') {
      const jobId = url.searchParams.get('jobId');
      const fixture = url.searchParams.get('fixture') === '1' || url.searchParams.get('demo') === '1';
      const talentPool = db.listTalentPool({ jobId, fixture });
      auditSensitiveRead('talent_pool_read', jobId || (fixture ? 'fixture' : 'all'));
      return send(res, 200, { ok: true, talentPool });
    }
    if (url.pathname === '/api/run/latest') {
      const runType = url.searchParams.get('type');
      const run = runType ? db.getLatestRunByType(runType) : db.getLatestRun();
      return send(res, 200, { ok: true, run: run || null });
    }
    if (url.pathname === '/api/circuit-breakers') return send(res, 200, { ok: true, breakers: db.getCircuitBreakers() });

    if (url.pathname === '/api/candidates') {
      const jobId = Number(url.searchParams.get('jobId'));
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
      const candidates = db.listCandidates(jobId);
      auditSensitiveRead('candidate_list_read', jobId);
      return send(res, 200, { ok: true, candidates });
    }

    if (url.pathname === '/api/workbench') {
      const jobId = Number(url.searchParams.get('jobId'));
      if (!jobId) return send(res, 400, { ok: false, error: 'jobId required' });
      const workbench = db.getJobWorkbench(jobId);
      auditSensitiveRead('workbench_read', jobId);
      return send(res, 200, { ok: true, workbench });
    }

    if (url.pathname === '/api/candidate-timeline') {
      const candidateId = String(url.searchParams.get('candidateId') || '').trim();
      if (!candidateId) return send(res, 400, { ok: false, error: 'candidateId required' });
      const timeline = db.getCandidateTimeline(candidateId);
      auditSensitiveRead('candidate_timeline_read', candidateId);
      return send(res, 200, { ok: true, timeline });
    }

    if (url.pathname === '/api/candidate-journey-operations') {
      const candidateId = String(url.searchParams.get('candidateId') || '').trim();
      const jobId = Number(url.searchParams.get('jobId'));
      if (!candidateId || !Number.isSafeInteger(jobId) || jobId <= 0) {
        return send(res, 400, {
          ok: false,
          code: 'CANDIDATE_JOB_INVALID',
          error: 'candidateId and jobId required',
        });
      }
      try {
        const operations = db.getCandidateJourneyOperations({ candidateId, jobId });
        auditSensitiveRead('candidate_journey_operations_read', `${candidateId}:${jobId}`);
        return send(res, 200, { ok: true, ...operations });
      } catch (error) {
        return send(res, Number(error && error.statusCode) || 400, {
          ok: false,
          code: error && error.code ? error.code : 'CANDIDATE_JOURNEY_READ_FAILED',
          error: error.message,
        });
      }
    }

    const actions = url.pathname.match(/^\/api\/candidates\/([^/]+)\/write-actions$/);
    if (actions) {
      const id = decodeURIComponent(actions[1]);
      return send(res, 200, { ok: true, actions: db.getWriteActions(id) });
    }

    const screenshot = url.pathname.match(/^\/api\/candidates\/([^/]+)\/screenshot$/);
    if (screenshot) {
      const id = decodeURIComponent(screenshot[1]);
      const file = db.resolveCandidateScreenshot(id);
      if (!file) return send(res, 404, { ok: false, error: 'screenshot not found' });
      return sendFile(res, file, { action: 'candidate_screenshot_read', target: id });
    }

    const match = url.pathname.match(/^\/api\/candidates\/([^/]+)(?:\/(children))?$/);
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (match[2] === 'children') {
        const children = db.getCandidateChildren(id);
        auditSensitiveRead('candidate_children_read', id);
        return send(res, 200, { ok: true, children });
      }
      const candidate = db.getCandidate(id) || null;
      auditSensitiveRead('candidate_detail_read', id);
      return send(res, 200, { ok: true, candidate });
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    return send(res, Number(error && error.statusCode) || 500, {
      ok: false,
      code: (error && error.code) || 'READONLY_PROJECTION_ERROR',
      error: error.message,
    });
  }
}

const server = http.createServer(route);
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 17732 被占用，可能上次没退干净。先杀掉占用进程（mac 终端：lsof -ti :17732 | xargs kill），或重启电脑后再 npm run ui。');
    process.exit(1);
  }
  throw err;
});
server.listen(PORT, HOST, () => {
  console.log(`readonly db server http://${HOST}:${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));

// 主进程异常退出（强制退出/崩溃）时 IPC 通道断开；只读服务必须随之退出，
// 不能留下仍持有 SQLite 句柄和监听端口的孤儿进程。
process.once('disconnect', () => {
  try {
    server.close(() => process.exit(0));
  } catch {
    process.exit(0);
  }
  // close 回调可能因存在长连接而不触发，兜底强制退出。
  setTimeout(() => process.exit(0), 2000).unref();
});
