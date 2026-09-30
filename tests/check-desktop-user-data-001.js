'use strict';
const { PROJECT_ROOT } = require("../src/paths");


const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { preserveLegacyUserDataPath } = require("../src/desktop-user-data");

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'talentbench-user-data-'));
try {
  function application(userData, explicit = false) {
    return {
      commandLine: { hasSwitch: (name) => name === 'user-data-dir' && explicit },
      getPath: (name) => name === 'appData' ? root : userData,
      setPath(name, value) { assert.equal(name, 'userData'); userData = value; },
    };
  }
  const legacy = path.join(root, 'HRBOSS');
  fs.mkdirSync(legacy);
  const marker = path.join(legacy, 'existing-profile.txt');
  fs.writeFileSync(marker, 'synthetic saved profile');
  const brandedDefaultNames = ['TalentBench', 'TalentBench 识才台', 'talentbench', '招才官', 'ZhaocaiGuan', 'zhaocai-guan'];
  for (const name of brandedDefaultNames) {
    const app = application(path.join(root, name));
    assert.equal(preserveLegacyUserDataPath(app), legacy);
    assert.equal(app.getPath('userData'), legacy);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'synthetic saved profile');
  }
  for (const name of brandedDefaultNames) {
    const explicitDefault = path.join(root, name);
    const explicitApp = application(explicitDefault, true);
    assert.equal(preserveLegacyUserDataPath(explicitApp), explicitDefault);
    assert.equal(explicitApp.getPath('userData'), explicitDefault);
  }
  const isolated = path.join(root, 'synthetic fixture', 'user-data');
  assert.equal(preserveLegacyUserDataPath(application(isolated)), isolated);
  assert.equal(fs.existsSync(isolated), false, 'a preconfigured test or user path is not created or overwritten');
  assert.equal(preserveLegacyUserDataPath(application(legacy)), legacy);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function sourceFunction(source, name) {
  const declaration = source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n\\}`))?.[0];
  assert.ok(declaration, `missing runtime function ${name}`);
  return declaration;
}

async function checkRuntimePaths() {
  const mainSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/candidate-main.js"), 'utf8');
  const functions = ['startServer', 'handleLocalPathsRequest', 'assertTrustedRenderer', 'getLiveMainWebContents', 'isDestroyed', 'sameRendererLocation'];
  const declarations = functions.map((name) => sourceFunction(mainSource, name)).join('\n');
  const appDir = path.join(os.tmpdir(), 'synthetic-app');
  const userData = path.join(os.tmpdir(), 'synthetic-user-data');
  for (const env of [
    {},
    { HRBOSS_DATA_DIR: path.join(os.tmpdir(), 'custom-data') },
    { HRBOSS_DATA_DIR: 'synthetic-data', BOSS_DB_PATH: 'synthetic-db/recruiting.db', HRBOSS_INTERVIEW_OUTPUT_DIR: 'synthetic-interviews' },
    { BOSS_DB_PATH: path.join(os.tmpdir(), 'custom-db', 'recruiting.db'), HRBOSS_INTERVIEW_OUTPUT_DIR: path.join(os.tmpdir(), 'custom-interviews') },
  ]) {
    for (const readOnly of [false, true]) {
      const spawned = [];
      const frame = { url: 'file:///synthetic-app/frontend/dist/index.html' };
      const contents = { mainFrame: frame, isDestroyed: () => false };
      const context = vm.createContext({ PROJECT_ROOT: appDir,
        path, URL, __dirname: appDir, console: { log() {} },
        process: { env: { ...env, SYNTHETIC_PRIVATE_VALUE: 'must-not-leak' }, execPath: '/synthetic-electron' },
        app: { getPath: () => userData, isPackaged: true },
        prepareRuntimeDir: (dir) => dir,
        crypto: { randomBytes: () => ({ toString: () => 'synthetic-token' }), randomUUID: () => 'synthetic-instance' },
        availableLocalPort: async () => 12345,
        resolveStartupLlmState: () => ({ state: null, faultCode: '' }), safeStorage: {},
        resolveLlmStartupBinding: () => ({ config: { provider: 'synthetic', baseUrl: 'https://ai.example.test/v1', enabled: false }, apiKey: 'synthetic-private-key', models: [] }),
        READONLY_UI: readOnly, ASSESSMENT_ENABLED: true,
        DEFAULT_ASSESSMENT_RETENTION_POLICY_VERSION: 'synthetic-policy', DEFAULT_ASSESSMENT_RETENTION_DAYS: '365',
        spawnService: (script, serviceEnv) => { spawned.push({ script, env: serviceEnv }); return {}; },
        waitForService: async () => {}, attachActionServerExitWatchdog: () => {},
        runtimeLocalPaths: null, shutdownStarted: false,
        rendererEntryUrl: frame.url, win: { webContents: contents, isDestroyed: () => false },
      });
      vm.runInContext(`${declarations}\nthis.runStart = startServer; this.readPaths = handleLocalPathsRequest;`, context);
      const trusted = { sender: contents, senderFrame: frame };
      assert.throws(() => context.readPaths(trusted), /目录.*未就绪/, 'startup failure must not invent a data path');
      await context.runStart();
      const dataDir = env.HRBOSS_DATA_DIR ? path.resolve(env.HRBOSS_DATA_DIR) : path.join(userData, 'data');
      const expected = {
        dataDir,
        databasePath: env.BOSS_DB_PATH ? path.resolve(env.BOSS_DB_PATH) : path.join(dataDir, 'recruiting.db'),
        interviewDir: path.resolve(appDir, env.HRBOSS_INTERVIEW_OUTPUT_DIR || path.join(dataDir, 'interviews')),
        screenshotDir: path.join(dataDir, 'import'),
      };
      const result = JSON.parse(JSON.stringify(context.readPaths(trusted)));
      assert.deepEqual(result, { ok: true, paths: expected }, 'only the four actual startup locations may be exposed');
      assert.equal(spawned.length, readOnly ? 1 : 2);
      for (const service of spawned) {
        assert.equal(result.paths.dataDir, service.env.HRBOSS_DATA_DIR);
        assert.equal(result.paths.databasePath, service.env.BOSS_DB_PATH);
        assert.equal(result.paths.interviewDir, path.resolve(appDir, service.env.HRBOSS_INTERVIEW_OUTPUT_DIR));
        assert.equal(result.paths.screenshotDir, path.join(service.env.HRBOSS_DATA_DIR, 'import'));
      }
      assert.throws(() => context.readPaths({ sender: { ...contents }, senderFrame: frame }), /拒绝/);
      assert.throws(() => context.readPaths({ sender: contents, senderFrame: { ...frame } }), /拒绝/);
      frame.url = 'https://untrusted.example.test/';
      assert.throws(() => context.readPaths(trusted), /拒绝/);
      frame.url = context.rendererEntryUrl;
      context.shutdownStarted = true;
      assert.throws(() => context.readPaths(trusted), /关闭/);
    }
  }
  assert.match(mainSource, /ipcMain\.handle\('settings-state:local-paths', handleLocalPathsRequest\)/);
  // Both the current evidence batches and legacy stitched images live under import/.
  const dbSource = fs.readFileSync(path.join(PROJECT_ROOT, "src/db.js"), 'utf8');
  assert.match(dbSource, /SCREENSHOT_STITCHED_DIR = path\.join\(DEFAULT_DATA_DIR, 'import', 'stitched-candidates'\)/);
  assert.match(dbSource, /SCREENSHOT_EVIDENCE_BATCHES_DIR = path\.join\(DEFAULT_DATA_DIR, 'import', 'screenshot-evidence', 'batches'\)/);
  assert.match(fs.readFileSync(path.join(PROJECT_ROOT, "src/screenshot-evidence-store.js"), 'utf8'), /path\.posix\.join\('import', 'screenshot-evidence', 'batches', batchId\)/);

  const bridges = {};
  const invocations = [];
  vm.runInNewContext(fs.readFileSync(path.join(PROJECT_ROOT, "src/preload.js"), 'utf8'), {
    require: (name) => {
      assert.equal(name, 'electron');
      return { contextBridge: { exposeInMainWorld: (name, value) => { bridges[name] = value; } }, ipcRenderer: { invoke: (...args) => { invocations.push(args); } } };
    },
  });
  await bridges.settingsState.getLocalPaths({ path: '/must-not-accept-arbitrary-paths' });
  assert.deepEqual(invocations, [['settings-state:local-paths']], 'the bridge must accept no filesystem target or credentials');
  const apiSource = fs.readFileSync(path.join(PROJECT_ROOT, 'frontend/src/api.js'), 'utf8');
  const apiContext = vm.createContext({ window: { settingsState: bridges.settingsState }, READONLY_UI: true });
  const readPaths = vm.runInContext(`(${sourceFunction(apiSource, 'getLocalPaths')})`, apiContext);
  const paths = { dataDir: '/synthetic/data', databasePath: '/synthetic/data/db', interviewDir: '/synthetic/interviews', screenshotDir: '/synthetic/data/import' };
  apiContext.window.settingsState.getLocalPaths = async () => ({ ok: true, paths });
  assert.deepEqual(JSON.parse(JSON.stringify(await readPaths())), paths, 'directory reads must remain available in operational readonly mode');
  for (const invalid of [null, { ok: false }, { ok: true, paths: {} }, { ok: true, paths: { ...paths, databasePath: '' } }]) {
    apiContext.window.settingsState.getLocalPaths = async () => invalid;
    await assert.rejects(readPaths, /目录/);
  }
  apiContext.window.settingsState.getLocalPaths = async () => { throw new Error('synthetic IPC failure'); };
  await assert.rejects(readPaths, /synthetic IPC failure/);
  delete apiContext.window.settingsState;
  await assert.rejects(readPaths, /桌面应用/);
  assert.match(apiSource, /getLocalPaths,/, 'the UI API must use the verified bridge helper');
  console.log('check-desktop-user-data-001: PASS (legacy migration; actual default/override paths; trusted IPC; readonly and failure handling)');
}

checkRuntimePaths().catch((error) => { console.error(error); process.exitCode = 1; });
