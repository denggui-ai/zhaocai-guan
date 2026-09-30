// P0 validator for the interview -> Feishu meeting/minutes -> transcript path.
// It intentionally does not store secrets or write to the product database.
//
// Typical flow:
//   FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx FEISHU_OWNER_ID=ou_xxx \
//     node feishu-interview-p0.js --reserve
//   node feishu-interview-p0.js --recording <meeting_id>
//   node feishu-interview-p0.js --transcript <minutes_url_or_token> --format srt --out /tmp/interview.srt

const path = require('path');
const { writePrivateFile } = require('./secure-fs');

const DEFAULT_BASE_URL = 'https://open.feishu.cn/open-apis';

function usage() {
  return `
Usage:
  node feishu-interview-p0.js --help
  node feishu-interview-p0.js --dry-run --reserve
  node feishu-interview-p0.js --reserve
  node feishu-interview-p0.js --recording <meeting_id>
  node feishu-interview-p0.js --minute <minutes_url_or_token>
  node feishu-interview-p0.js --transcript <minutes_url_or_token> [--format srt|txt] [--out file]

Env:
  FEISHU_APP_ID                 Custom app id, for tenant_access_token.
  FEISHU_APP_SECRET             Custom app secret, for tenant_access_token.
  FEISHU_TENANT_ACCESS_TOKEN    Optional; if set, skips app_id/app_secret token request.
  FEISHU_OWNER_ID               Required for --reserve with tenant token, usually an open_id.
  FEISHU_HOST_OPEN_IDS          Optional comma list for assign_host_list; defaults to FEISHU_OWNER_ID.
  FEISHU_USER_ID_TYPE           open_id | user_id | union_id. Default: open_id.
  FEISHU_MEETING_TOPIC          Optional meeting topic. Default includes HRBOSS-P0 timestamp.
  FEISHU_RESERVE_END_TIME       Optional unix seconds. Default: now + 24h.
  FEISHU_MEETING_PASSWORD       Optional 4-9 digit meeting password.
  FEISHU_BASE_URL               Optional. Default: ${DEFAULT_BASE_URL}

Notes:
  --reserve creates an OpenAPI reservation with auto_record=true.
  Recording-ready callbacks only apply reliably to meetings reserved through OpenAPI.
  Transcript export works after Feishu Minutes is ready; before that Feishu returns "minute not ready".
`.trim();
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    if (['help', 'dry-run', 'reserve'].includes(key)) {
      args[key] = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    args[key] = value;
    i += 1;
  }
  return args;
}

function env(name, fallback = '') {
  return process.env[name] == null ? fallback : String(process.env[name]).trim();
}

function baseUrl() {
  return env('FEISHU_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function requireFetch() {
  if (typeof fetch !== 'function') {
    throw new Error('This script needs Node.js 18+ with global fetch.');
  }
}

function extractMinuteToken(input) {
  const raw = String(input || '').trim();
  if (/^[A-Za-z0-9]{10,80}$/.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const token = segments[segments.length - 1] || '';
    return /^[A-Za-z0-9]{10,80}$/.test(token) ? token : '';
  } catch {
    return '';
  }
}

async function requestJson(url, options = {}) {
  requireFetch();
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Non-JSON response ${res.status}: ${text.slice(0, 300)}`);
  }
  if (!res.ok || data.code !== 0) {
    throw new Error(`Feishu API failed ${res.status}, code=${data.code}, msg=${data.msg || data.error || 'unknown'}`);
  }
  return data;
}

async function tenantAccessToken() {
  const existing = env('FEISHU_TENANT_ACCESS_TOKEN');
  if (existing) return existing;
  const appId = env('FEISHU_APP_ID');
  const appSecret = env('FEISHU_APP_SECRET');
  if (!appId || !appSecret) {
    throw new Error('FEISHU_TENANT_ACCESS_TOKEN or FEISHU_APP_ID/FEISHU_APP_SECRET is required.');
  }
  const data = await requestJson(`${baseUrl()}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  return data.tenant_access_token;
}

function authHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json; charset=utf-8',
  };
}

function reservationBody() {
  const ownerId = env('FEISHU_OWNER_ID');
  if (!ownerId) throw new Error('FEISHU_OWNER_ID is required for --reserve.');
  const hostIds = env('FEISHU_HOST_OPEN_IDS', ownerId).split(',').map((item) => item.trim()).filter(Boolean);
  const endTime = env('FEISHU_RESERVE_END_TIME', String(Math.floor(Date.now() / 1000) + 24 * 60 * 60));
  const topic = env('FEISHU_MEETING_TOPIC', `HRBOSS-P0-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const settings = {
    topic,
    meeting_initial_type: 1,
    auto_record: true,
    assign_host_list: hostIds.map((id) => ({ user_type: 1, id })),
  };
  const password = env('FEISHU_MEETING_PASSWORD');
  if (password) settings.password = password;
  return {
    end_time: endTime,
    owner_id: ownerId,
    meeting_settings: settings,
  };
}

async function createReservation({ dryRun = false } = {}) {
  const userIdType = env('FEISHU_USER_ID_TYPE', 'open_id');
  const body = reservationBody();
  const url = `${baseUrl()}/vc/v1/reserves/apply?user_id_type=${encodeURIComponent(userIdType)}`;
  if (dryRun) {
    return { dryRun: true, method: 'POST', url, body };
  }
  const token = await tenantAccessToken();
  return requestJson(url, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
}

async function getRecording(meetingId) {
  if (!meetingId) throw new Error('meeting_id is required.');
  const token = await tenantAccessToken();
  return requestJson(`${baseUrl()}/vc/v1/meetings/${encodeURIComponent(meetingId)}/recording`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function getMinuteInfo(input) {
  const tokenValue = extractMinuteToken(input);
  if (!tokenValue) throw new Error('minutes URL/token is invalid.');
  const token = await tenantAccessToken();
  return requestJson(`${baseUrl()}/minutes/v1/minutes/${encodeURIComponent(tokenValue)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

async function getTranscript(input, { format = 'srt' } = {}) {
  const tokenValue = extractMinuteToken(input);
  if (!tokenValue) throw new Error('minutes URL/token is invalid.');
  const token = await tenantAccessToken();
  const url = new URL(`${baseUrl()}/minutes/v1/minutes/${encodeURIComponent(tokenValue)}/transcript`);
  url.searchParams.set('need_speaker', 'true');
  url.searchParams.set('need_timestamp', 'true');
  url.searchParams.set('file_format', format);
  requireFetch();
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get('content-type') || '';
  if (!res.ok || contentType.includes('application/json')) {
    let data = {};
    try { data = JSON.parse(buffer.toString('utf8')); } catch {}
    throw new Error(`Transcript export failed ${res.status}, code=${data.code || 'unknown'}, msg=${data.msg || buffer.toString('utf8').slice(0, 300)}`);
  }
  return buffer;
}

function printResult(value) {
  if (Buffer.isBuffer(value)) {
    process.stdout.write(value);
    return;
  }
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || process.argv.length <= 2) {
    console.log(usage());
    return;
  }
  if (args.reserve) {
    printResult(await createReservation({ dryRun: !!args['dry-run'] }));
    return;
  }
  if (args.recording) {
    printResult(await getRecording(args.recording));
    return;
  }
  if (args.minute) {
    printResult(await getMinuteInfo(args.minute));
    return;
  }
  if (args.transcript) {
    const format = args.format || 'srt';
    if (!['srt', 'txt'].includes(format)) throw new Error('--format must be srt or txt');
    const buffer = await getTranscript(args.transcript, { format });
    if (args.out) {
      const out = path.resolve(args.out);
      writePrivateFile(out, buffer);
      console.log(JSON.stringify({ ok: true, out, bytes: buffer.length }, null, 2));
      return;
    }
    printResult(buffer);
    return;
  }
  throw new Error('No action selected. Use --help.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`ERROR: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  extractMinuteToken,
  reservationBody,
};
