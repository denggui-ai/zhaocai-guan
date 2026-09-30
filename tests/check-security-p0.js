
const { PROJECT_ROOT } = require("../src/paths");
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ensurePrivateDir,
  hardenPrivateDir,
  writePrivateFile,
} = require("../src/secure-fs");

const ROOT = path.join(os.tmpdir(), `hrboss-security-p0-${process.pid}-${Date.now()}`);
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

function posixMode(target) {
  return fs.statSync(target).mode & 0o777;
}

ensurePrivateDir(ROOT);
const privateFile = path.join(ROOT, 'candidate-private.json');
writePrivateFile(privateFile, JSON.stringify({ candidate: 'sensitive' }));

if (process.platform !== 'win32') {
  assert.equal(posixMode(ROOT), 0o700, 'private data directories must be 0700');
  assert.equal(posixMode(privateFile), 0o600, 'private data files must be 0600');
  fs.chmodSync(privateFile, 0o644);
  writePrivateFile(privateFile, 'hardened');
  assert.equal(posixMode(privateFile), 0o600, 'rewriting an existing file must repair permissive mode bits');
}

assert.throws(
  () => hardenPrivateDir(os.tmpdir()),
  /拒绝把共享目录当作私密数据目录/,
  'security helper must never chmod the shared temp root',
);

const db = require("../src/db");
const dbPath = path.join(ROOT, 'private.db');
const database = db.openDb(dbPath);
database.close();
if (process.platform !== 'win32') {
  assert.equal(posixMode(dbPath), 0o600, 'SQLite database must be 0600');
}

const helperSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/secure-fs.js"), 'utf8');
assert.match(helperSource, /icacls/, 'Windows path must enforce a current-user ACL');
assert.match(helperSource, /\/inheritance:r/, 'Windows ACL must remove inherited access');
assert.match(helperSource, /\/inheritance:d/, 'Windows descendants must copy private inherited ACEs before disabling inheritance');
assert.match(helperSource, /inspectWindowsPathTree/, 'Windows recursive ACL hardening must reject reparse points before mutation');
assert.doesNotMatch(helperSource, /['"]\/C['"]/, 'Windows ACL hardening must not continue after recursive mutation errors');

const hardenStart = helperSource.indexOf('function hardenPath(');
const ensureDirStart = helperSource.indexOf('function ensurePrivateDir(');
assert.ok(hardenStart >= 0 && ensureDirStart > hardenStart, 'secure-fs must expose the expected hardenPath/ensurePrivateDir boundaries');
const hardenSource = helperSource.slice(hardenStart, ensureDirStart);
const hardenPreflightIndex = hardenSource.indexOf('inspectWindowsPathTree(target)');
const firstAclMutationIndex = hardenSource.indexOf('runIcacls(');
assert.ok(
  hardenPreflightIndex >= 0 && firstAclMutationIndex > hardenPreflightIndex,
  'Windows reparse preflight must run before the first ACL mutation',
);
const descendantsReset = "runIcacls(descendants, ['/reset', '/T', '/L', '/Q']";
const descendantsFreeze = "runIcacls(descendants, ['/inheritance:d', '/T', '/L', '/Q']";
assert.ok(hardenSource.indexOf(descendantsReset) >= 0, 'Windows descendants must be reset from the private root without /C');
assert.ok(
  hardenSource.indexOf(descendantsFreeze) > hardenSource.indexOf(descendantsReset),
  'Windows descendants must copy inherited private ACEs only after reset',
);

const hardenDirStart = helperSource.indexOf('function hardenPrivateDir(');
assert.ok(hardenDirStart > ensureDirStart, 'secure-fs must expose the expected hardenPrivateDir boundary');
const ensureDirSource = helperSource.slice(ensureDirStart, hardenDirStart);
assert.ok(
  ensureDirSource.indexOf("if (process.platform === 'win32') inspectWindowsPathTree(dir)") >= 0
    && ensureDirSource.indexOf('inspectWindowsPathTree(dir)') < ensureDirSource.indexOf('fs.mkdirSync('),
  'every Windows private directory must inspect its path tree before mkdir or a caller write',
);

console.log('check-security-p0 ok');
