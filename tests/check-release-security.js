
const { PROJECT_ROOT } = require("../src/paths");
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(os.tmpdir(), `hrboss-release-security-${process.pid}-${Date.now()}`);
const TOKEN = 'release-security-test-local-api-token-0001';
fs.mkdirSync(ROOT, { recursive: true, mode: 0o700 });
const DEFAULT_DB_SENTINEL = path.join(ROOT, 'default-main.db');
const DEFAULT_DB_SENTINEL_CONTENT = `synthetic-default-db-sentinel:${process.pid}:${Date.now()}`;
process.env.HRBOSS_DATA_DIR = path.join(ROOT, 'data');
process.env.BOSS_DB_PATH = DEFAULT_DB_SENTINEL;
fs.writeFileSync(DEFAULT_DB_SENTINEL, DEFAULT_DB_SENTINEL_CONTENT, 'utf8');
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

function source(file) {
  return fs.readFileSync(path.join(PROJECT_ROOT, file), 'utf8');
}

function waitForExit(child, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error('child process did not exit in time'));
    }, timeoutMs);
    child.once('exit', finish);
    child.once('error', reject);
  });
}

function getJson(port, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method: 'GET',
      headers: { 'x-hrboss-token': TOKEN },
      timeout: 2000,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

async function waitForServer(child, marker) {
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk.toString(); });
  child.stderr.on('data', (chunk) => { log += chunk.toString(); });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (log.includes(marker)) return;
    if (child.exitCode != null) throw new Error(`server exited early: ${log}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server did not start: ${log}`);
}

(async () => {
  const mainSource = source("src/candidate-main.js");
  const preloadSource = source("src/preload.js");
  const apiSource = source(path.join('frontend', 'src', 'api.js'));
  const viteSource = source(path.join('frontend', 'vite.config.js'));
  const actionSource = source("src/action-server.js");
  const llmSource = source("src/rating-llm.js");
  const secureSource = source("src/secure-fs.js");
  const forgeSource = source('forge.config.js');
  const forgeConfig = require("../forge.config");
  const macReleaseSource = source(path.join('release', 'build-macos-internal.sh'));
  const macCandidateSelfTestSource = source(path.join('release', 'macos-candidate-self-test.js'));
  const macInternalReadme = source(path.join('release', 'MACOS-README.md'));
  const macUatChecklist = source(path.join('release', 'MACOS-HR-UAT-CHECKLIST.md'));
  const macOfficialGateSource = source(path.join('release', 'macos-official-gate.js'));
  const macOfficialEntitlements = source(path.join('release', 'macos-official-entitlements.plist'));
  const macOfficialReadme = source(path.join('release', 'MACOS-OFFICIAL-README.md'));
  const developmentSourceRelease = source(path.join('release', 'build-development-source.sh'));
  const packageJson = JSON.parse(source('package.json'));
  const windowsAcceptanceBytes = fs.readFileSync(path.join(PROJECT_ROOT, 'release', 'windows-release-self-test.ps1'));
  const windowsAcceptanceSource = source(path.join('release', 'windows-release-self-test.ps1'));
  const windowsChecklist = source(path.join('release', 'windows-release-acceptance-checklist.md'));

  assert.equal(forgeConfig.outDir, path.join(PROJECT_ROOT, 'dist'), 'Forge output must stay in the repository dist directory');
  for (const releaseSource of [macReleaseSource, developmentSourceRelease]) {
    assert.match(releaseSource, /DELIVERABLES="\$APP_ROOT\/dist"/, 'release artifacts must stay in the repository dist directory');
  }

  assert.doesNotMatch(mainSource, /spawn\(['"]node['"]/, 'desktop services must not depend on a system node executable');
  assert.match(mainSource, /ELECTRON_RUN_AS_NODE/, 'desktop services must use the bundled Electron Node runtime');
  assert.match(mainSource, /availableLocalPort/, 'desktop services must avoid fixed-port launch collisions');
  assert.match(mainSource, /assertTrustedRenderer\(event\)/, 'every privileged IPC path must validate its sender');
  assert.match(mainSource, /setWindowOpenHandler/, 'main window must deny unexpected child windows');
  assert.match(mainSource, /will-navigate/, 'main window must restrict navigation');
  assert.doesNotMatch(preloadSource, /getSession|local-api:session/, 'preload must not expose the bearer session');
  assert.doesNotMatch(apiSource, /x-hrboss-token|getSession/, 'renderer must not receive or attach the bearer token');
  assert.doesNotMatch(viteSource, /proxy|x-hrboss-token|HRBOSS_LOCAL_API_TOKEN/, 'Vite must not proxy privileged local APIs or inject tokens');
  assert.match(actionSource, /backgroundChildren/, 'action server must track background children');
  assert.match(actionSource, /requestLocalInterviewStop\(\{\s*abort: true/,
    'consent revocation must abort the owned recording');
  assert.match(actionSource, /abortLocalInterviewJob\(\s*ownedJob,/,
    'shutdown must reuse the owned recording process-group abort controller');
  assert.match(llmSource, /MAX_RESPONSE_BYTES/, 'external AI responses must have a byte limit');
  assert.doesNotMatch(llmSource, /scoreCandidate/, 'legacy model scoring must not remain in the external AI adapter');
  assert.match(llmSource, /analyzeAssessmentPortfolio/, 'assessment AI scoring must use the isolated assessment portfolio path');
  assert.match(llmSource, /SABC \/ quality_score 仍只允许走本地规则/, 'assessment AI must not write the formal SABC or quality score');
  assert.match(secureSource, /\/reset/, 'Windows ACL hardening must remove pre-existing explicit grants');
  assert.match(forgeSource, /postPackage: installTargetNativeBinary/, 'Windows packaging must replace cross-platform native binaries');
  assert.match(forgeSource, /signature !== 'MZ'/, 'Windows packaging must fail if better-sqlite3 is not PE\/COFF');
  assert.match(forgeSource, /\^\\\/\\\.runtime/, 'packaging must exclude nested local Electron runtime builds');
  assert.match(forgeSource, /\^\\\/tmp/, 'packaging must exclude repository temporary materials');
  assert.match(forgeSource, /\^\\\/release/, 'release source materials must stay outside the packaged application resources');
  for (const forbiddenPackagePath of [
    '/data', '/data/recruiting.db', '/tmp', '/tmp/synthetic-material.txt',
    '/out', '/dist', '/dist/ZhaocaiGuan.zip', '/.runtime', '/deliverables', '/release', '/handoff', '/checks',
    '/frontend/src/App.jsx', '/frontend/package.json', '/create-ui-fixture-db.js',
    '/.npmrc', '/candidate.db', '/rating-config.json',
    '/.github/workflows/windows-check.yml', '/.impeccable/critique/example.md',
    '/.gitattributes', '/forge.config.js',
  ]) {
    assert.ok(
      forgeConfig.packagerConfig.ignore.some((pattern) => pattern.test(forbiddenPackagePath)),
      `packaging ignore rules must reject ${forbiddenPackagePath}`,
    );
  }
  assert.equal(
    forgeConfig.packagerConfig.ignore.some((pattern) => pattern.test('/frontend/dist/index.html')),
    false,
    'packaging must retain the production frontend/dist output',
  );
  assert.equal(packageJson.scripts['package:mac:arm64'], 'bash release/build-macos-internal.sh --candidate');
  assert.equal(packageJson.scripts['accept:mac:candidate'], 'node release/macos-candidate-self-test.js');
  assert.equal(packageJson.scripts['release:mac:internal'], 'bash release/build-macos-internal.sh --publish');
  assert.equal(packageJson.scripts['release:mac:official'], 'bash release/build-macos-internal.sh --official');
  assert.match(packageJson.scripts.postinstall, /frontend ci/, 'root installs must rebuild frontend dependencies from its lockfile');
  assert.match(packageJson.scripts.postinstall, /electron-spike ci/, 'root installs must rebuild spike dependencies from its lockfile');
  assert.equal(packageJson.devDependencies['@electron/osx-sign'], '1.3.3', 'official Mac signing must use a pinned direct dependency');
  assert.match(macReleaseSource, /MODE="\$\{1:---candidate\}"/, 'Mac release must remain candidate-only by default');
  assert.match(
    macReleaseSource,
    /Refusing to build or publish a Mac HR artifact from a dirty worktree/,
    'Mac candidates and publications must fail closed on a dirty source worktree',
  );
  assert.ok(
    macReleaseSource.indexOf('Refusing to build or publish a Mac HR artifact')
      < macReleaseSource.indexOf('VERSION="$(git -C'),
    'all Mac modes must reject a dirty tree before reading release metadata or running official preflight',
  );
  assert.match(macReleaseSource, /hrboss_release_build_v1/, 'Mac packages must embed versioned source-build identity');
  assert.match(macReleaseSource, /release-build\.json/, 'Mac packages must retain and validate their source-build identity');
  assert.match(macReleaseSource, /source_commit/, 'Mac source-build identity must include the frozen commit');
  assert.match(macReleaseSource, /source_tree/, 'Mac source-build identity must include the frozen tree');
  assert.match(macReleaseSource, /source_worktree_state/, 'Mac source-build identity must record clean or dirty state');
  assert.match(macReleaseSource, /build_toolchain/, 'Mac source-build identity must record the build toolchain');
  assert.match(macReleaseSource, /lockfiles/, 'Mac source-build identity must record lockfile hashes');
  assert.match(macReleaseSource, /resume-structure\.js/, 'Mac package validation must require the unified resume parser');
  assert.match(macReleaseSource, /screenshot-ai-import-state\.js/, 'Mac package validation must require persisted screenshot task state');
  assert.match(macReleaseSource, /screenshot-import-task-public\.js/, 'Mac package validation must require the public task projection');
  assert.match(macReleaseSource, /截图导入任务中心/, 'Mac package validation must prove the current task-center UI is bundled');
  assert.match(macReleaseSource, /我已对照原图确认姓名/, 'Mac package validation must prove the current name-review gate is bundled');
  assert.match(macReleaseSource, /MACOS-HR-UAT-CHECKLIST\.md/, 'unnotarized Mac archives must carry the governed HR checklist');
  assert.match(
    macReleaseSource,
    /if \[\[ "\$MODE" != --official \]\]; then[\s\S]*?MACOS-HR-UAT-CHECKLIST\.md/,
    'the HR checklist must accompany the unnotarized channel artifacts',
  );
  assert.match(macInternalReadme, new RegExp(`版本：${packageJson.version}`), 'Mac internal README version must match package.json');
  assert.match(macUatChecklist, /只准备虚构岗位.*合成 PDF\/Word\/TXT/, 'Mac HR UAT must prohibit real candidate data in the first round');
  assert.match(macUatChecklist, /GO WITH CONDITIONS/, 'Mac HR UAT must record an explicit conditional release decision');
  assert.match(macUatChecklist, /整个数据目录/, 'Mac HR UAT rollback must restore the full isolated data directory');
  assert.match(
    macReleaseSource,
    /"\$resources_root\/checks"/,
    'Mac package verification must reject nested development checks',
  );
  assert.match(macReleaseSource, /--candidate\|--publish\|--official/, 'the Developer ID and notarized Mac channel must use an explicit --official mode');
  assert.match(
    macReleaseSource,
    /BASENAME="ZhaocaiGuan-macOS-arm64-.*-official-notarized"/,
    'official output must be named separately from internal ad-hoc output',
  );
  assert.match(
    macReleaseSource,
    /BASENAME="ZhaocaiGuan-macOS-arm64-.*-internal"/,
    'unnotarized output must retain its existing -internal artifact name',
  );
  assert.match(macReleaseSource, /macos-official-gate\.js" preflight/, 'official release must fail closed before staging');
  assert.match(macReleaseSource, /macos-official-gate\.js" sign-app/, 'official release must use the Developer ID signing gate');
  assert.match(macReleaseSource, /macos-official-gate\.js" notarize-app/, 'official release must use the notarization/stapling gate');
  assert.match(macReleaseSource, /macos-official-gate\.js" notarize-dmg/, 'official DMG must have its own notarization/stapling gate');
  assert.match(macReleaseSource, /macos-official-gate\.js" verify-app/, 'official release copies must retain Developer ID/runtime verification');
  assert.match(
    macReleaseSource,
    /macos-official-gate\.js" verify-notarized-app/,
    'official release copies must retain stapler and Gatekeeper verification',
  );
  assert.match(macReleaseSource, /MACOS-OFFICIAL-README\.md/, 'official releases must not ship the internal ad-hoc README');
  assert.match(macOfficialGateSource, /HRBOSS_MAC_DEVELOPER_ID_APPLICATION/, 'official gate must require an explicit Developer ID identity');
  assert.match(macOfficialGateSource, /HRBOSS_MAC_NOTARY_PROFILE/, 'official gate must require an explicit notarytool profile');
  assert.match(
    macOfficialGateSource,
    /\^Developer ID Application: \.\+ \\\(\(\[A-Z0-9\]\{10\}\)\\\)\$/,
    'official gate must reject ad-hoc and non-Developer-ID identities',
  );
  assert.match(
    macOfficialGateSource,
    /signAsync\(buildOsxSignOptions\(appPath, config\)\)/,
    'official release must use the Electron-aware nested signer plan',
  );
  assert.match(
    macOfficialGateSource,
    /optionsForFile:[\s\S]*?hardenedRuntime: true[\s\S]*?fileOptions\.entitlements = ENTITLEMENTS/,
    'official signing must apply Hardened Runtime to every component and reviewed entitlements only to the top-level app',
  );
  assert.match(macOfficialGateSource, /preAutoEntitlements: false/, 'official signing must use only the reviewed entitlements');
  assert.match(
    macOfficialGateSource,
    /preEmbedProvisioningProfile: false/,
    'official signing must not discover or embed an unreviewed provisioning profile',
  );
  assert.match(macOfficialGateSource, /Authority=Developer ID Application:/, 'official verification must inspect the signed authority');
  assert.match(macOfficialGateSource, /TeamIdentifier=/, 'official verification must bind the signed Team ID');
  assert.match(macOfficialGateSource, /requireRuntime && !\/\(\?:flags=.*runtime.*Runtime Version=/s, 'official verification must prove Hardened Runtime');
  assert.match(macOfficialGateSource, /'notarytool',\s*'submit'/, 'official gate must submit with notarytool');
  assert.match(macOfficialGateSource, /'--keychain-profile'/, 'notarytool must use a named keychain profile, not raw secrets');
  assert.match(macOfficialGateSource, /'--wait'/, 'notarytool must wait for a terminal result');
  assert.match(macOfficialGateSource, /parsed\?\.status !== 'Accepted'/, 'official release must accept only an exact Accepted status');
  assert.match(macOfficialGateSource, /'stapler', 'staple'/, 'official release must staple the accepted ticket');
  assert.match(macOfficialGateSource, /'stapler', 'validate'/, 'official release must validate the stapled ticket');
  assert.match(macOfficialGateSource, /'--assess', '--type', 'execute'/, 'official release must pass a Gatekeeper assessment');
  assert.match(
    macOfficialGateSource,
    /'--force',\s*'--sign',\s*config\.identity,\s*'--timestamp',\s*dmgPath/s,
    'official DMG must receive a timestamped Developer ID signature before submission',
  );
  assert.match(
    macOfficialGateSource,
    /'--type',\s*'open',\s*'--context',\s*'context:primary-signature'/s,
    'official DMG must pass the disk-image Gatekeeper assessment',
  );
  assert.match(macOfficialGateSource, /HRBOSS_MAC_OFFICIAL_OFFLINE_TEST/, 'official mock tooling must be explicitly test-gated');
  assert.match(macOfficialGateSource, /HRBOSS_UI_FIXTURE_GATE/, 'official mock tooling must also require the UI fixture safety gate');
  assert.match(macOfficialGateSource, /fs\.realpathSync\(os\.tmpdir\(\)\)/, 'mock tooling must remain inside the system temporary root');
  assert.match(macOfficialGateSource, /codesign: '\/usr\/bin\/codesign'/, 'production codesign must use a fixed system path');
  assert.match(macOfficialGateSource, /xcrun: '\/usr\/bin\/xcrun'/, 'production notary/stapler must use a fixed system path');
  assert.match(macOfficialEntitlements, /com\.apple\.security\.cs\.allow-jit/, 'official Electron signing needs the reviewed JIT entitlement');
  assert.match(macOfficialEntitlements, /com\.apple\.security\.device\.audio-input/, 'official app must declare its local interview audio entitlement');
  assert.doesNotMatch(macOfficialEntitlements, /network\.client|network\.server/, 'official entitlements must not silently add network privileges');
  assert.match(macOfficialReadme, /Developer ID Application/, 'official README must identify the production signing guarantee');
  assert.match(macOfficialReadme, /Accepted/, 'official README must identify the notarization guarantee');
  assert.doesNotMatch(macOfficialReadme, /ad-hoc/, 'official README must never describe the artifact as ad-hoc');
  const signIndex = macReleaseSource.indexOf('sign-app "$PACKAGED_APP"');
  const submitIndex = macReleaseSource.indexOf('notarize-app "$CANDIDATE_APP"');
  assert.ok(signIndex >= 0 && submitIndex > signIndex, 'official release must sign and verify the app before notarization');
  const dmgNotaryIndex = macReleaseSource.indexOf('notarize-dmg "$TMP_DMG"');
  const dmgCreateIndex = macReleaseSource.indexOf('hdiutil create -volname');
  const artifactHashIndex = macReleaseSource.indexOf('shasum -a 256 "$(basename "$TMP_DMG")"');
  assert.ok(
    submitIndex < dmgCreateIndex && dmgCreateIndex < dmgNotaryIndex && dmgNotaryIndex < artifactHashIndex,
    'official release must finish app notarization, create the DMG, then finish DMG notarization before checksums or promotion',
  );
  const selfTestIndex = macReleaseSource.indexOf('node "$FROZEN_RELEASE_DIR/macos-candidate-self-test.js"');
  const promotionIndex = macReleaseSource.indexOf('promote_without_overwrite "$PACKAGE_STAGE"');
  assert.ok(
    selfTestIndex >= 0 && promotionIndex > selfTestIndex,
    'Mac package self-test must pass before any distribution artifact is promoted',
  );
  assert.match(
    macCandidateSelfTestSource,
    /path\.resolve\(__dirname, '\.\.'\)/,
    'Mac package self-test must verify release identity against its frozen source stage',
  );
  assert.doesNotMatch(
    macCandidateSelfTestSource,
    /path\.join\(resources, 'package-lock\.json'\)/,
    'Mac package self-test must not require a development lockfile inside the runtime app',
  );
  assert.match(macReleaseSource, /MACOS-CANDIDATE-SELF-TEST-SHA256SUMS/, 'Mac release must hash its package self-test summary');
  assert.match(macReleaseSource, /mktemp -d \/tmp\/hrboss-macos-candidate\./, 'Mac candidate must own a unique /tmp staging root');
  assert.match(macReleaseSource, /git -C "\$APP_ROOT" archive --format=tar "\$SOURCE_COMMIT"/, 'Mac source stage must come from the immutable commit tree');
  assert.doesNotMatch(
    macReleaseSource,
    /\$SCRIPT_DIR\/(?:macos-official-gate\.js|macos-candidate-self-test\.js|MACOS-(?:OFFICIAL-)?README\.md|MACOS-HR-UAT-CHECKLIST\.md)/,
    'Mac signing, self-test, and release documents must all come from the frozen source stage',
  );
  assert.match(
    macReleaseSource,
    /\$FROZEN_RELEASE_DIR\/macos-official-gate\.js" preflight/,
    'official preflight must use the lockfile-rebuilt frozen release gate',
  );
  assert.doesNotMatch(macReleaseSource, /rsync[\s\S]*?"\$APP_ROOT\/" "\$SOURCE_STAGE/,
    'Mac release must not copy a mutable worktree into its source stage');
  assert.ok(
    (macReleaseSource.match(/assert_source_snapshot_unchanged/g) || []).length >= 4,
    'Mac release must re-check the frozen source before staging, after staging, after packaging, and before promotion',
  );
  for (const excludedSensitiveName of [
    '.env', '.env.*', '.npmrc', 'rating-config.json', '*.db', '*.db-wal', '*.db-shm',
    '*.pem', '*.key', '*.p12', '*.pfx', '*.crt', '*.cer', '*.mobileprovision',
  ]) {
    assert.ok(
      macReleaseSource.includes(`-name '${excludedSensitiveName}'`),
      `Mac committed source scan must reject ${excludedSensitiveName}`,
    );
  }
  assert.match(macReleaseSource, /npm ci --no-audit --no-fund/, 'Mac release dependencies must be recreated from package-lock.json');
  assert.match(macReleaseSource, /electron-rebuild -f -w better-sqlite3/, 'Mac release must bind SQLite to the pinned Electron ABI');
  assert.match(macReleaseSource, /npm run verify/, 'Mac candidate must verify only inside its staged source');
  assert.match(macReleaseSource, /electron-forge package --platform=darwin --arch=arm64/, 'Mac candidate must run Forge inside staging');
  assert.equal(packageJson.productName, '招才官', 'packaged product identity must be 招才官');
  assert.equal(packageJson.build?.productName, '招才官', 'Electron build identity must be 招才官');
  assert.match(
    macReleaseSource,
    /PRODUCT_NAME="\$\(git -C "\$APP_ROOT" show "\$SOURCE_COMMIT:package\.json"[\s\S]*?\.productName/,
    'Mac release must derive the bundle name from frozen package metadata',
  );
  assert.match(macReleaseSource, /CANDIDATE_APP=.*PRODUCT_NAME\.app/, 'Mac release must preserve the 招才官 bundle name');
  assert.notEqual(packageJson.productName, packageJson.author, 'Mac bundle name must not use the developer identity');
  assert.doesNotMatch(macReleaseSource, /npm run package:mac:arm64/, 'Mac release builder must not recurse through the package script');
  assert.doesNotMatch(macReleaseSource, /APP_ROOT\/out/, 'Mac release must not use repository out');
  assert.match(macReleaseSource, /HRBOSS_RELEASE_DATE must contain exactly 8 digits/, 'Mac release filenames must reject path-like dates');
  assert.match(macReleaseSource, /HRBOSS_RELEASE_REVISION must be empty or match r1, r2/, 'Mac release revisions must reject path-like suffixes');
  for (const [label, releaseSource] of [
    ['development source', developmentSourceRelease],
  ]) {
    assert.match(releaseSource, /HRBOSS_RELEASE_DATE must contain exactly 8 digits/, `${label} filenames must reject path-like dates`);
    for (const excludedDirectory of ['tmp', 'deliverables', 'data', 'out', 'dist', '\\.runtime']) {
      assert.match(releaseSource, new RegExp(`--exclude='${excludedDirectory}/'`), `${label} must exclude ${excludedDirectory}`);
    }
    for (const excludedSensitiveName of [
      '.npmrc', '*.db-wal', '*.db-shm', '*.sqlite-wal', '*.sqlite-shm',
      '*.sqlite3-wal', '*.sqlite3-shm', '*.mobileprovision',
    ]) {
      assert.ok(
        releaseSource.includes(`--exclude='${excludedSensitiveName}'`),
        `${label} must exclude ${excludedSensitiveName}`,
      );
      assert.ok(
        releaseSource.includes(`-name '${excludedSensitiveName}'`),
        `${label} post-copy scan must reject ${excludedSensitiveName}`,
      );
    }
  }
  if (process.platform === 'win32') {
    console.log('SKIP POSIX release-shell runtime assertions on Windows');
  } else {
    const dirtyReleaseRoot = path.join(ROOT, 'dirty-mac-release');
    const dirtyReleaseApp = path.join(dirtyReleaseRoot, 'app');
    fs.mkdirSync(path.join(dirtyReleaseApp, 'release'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dirtyReleaseApp, 'frontend'), { recursive: true, mode: 0o700 });
    fs.copyFileSync(
      path.join(PROJECT_ROOT, 'release', 'build-macos-internal.sh'),
      path.join(dirtyReleaseApp, 'release', 'build-macos-internal.sh'),
    );
    fs.writeFileSync(path.join(dirtyReleaseApp, 'package.json'), JSON.stringify({
      version: '0.0.0-test',
      productName: '招才官',
      devDependencies: { electron: '42.5.1' },
    }));
    fs.writeFileSync(path.join(dirtyReleaseApp, 'package-lock.json'), '{"lockfileVersion":3}\n');
    fs.writeFileSync(path.join(dirtyReleaseApp, 'frontend', 'package-lock.json'), '{"lockfileVersion":3}\n');
    for (const args of [
      ['init', '-q'],
      ['add', '.'],
      ['-c', 'user.name=Zhaocai Guan Release Test', '-c', 'user.email=release-test@invalid', 'commit', '-qm', 'fixture'],
    ]) {
      const result = spawnSync('git', args, { cwd: dirtyReleaseApp, encoding: 'utf8' });
      assert.equal(result.status, 0, `dirty Mac release fixture setup failed: ${result.stderr || result.stdout}`);
    }
    fs.writeFileSync(path.join(dirtyReleaseApp, 'uncommitted-fixture.txt'), 'synthetic dirty state\n');
    for (const mode of ['--candidate', '--publish', '--official']) {
      const dirtyBuild = spawnSync('bash', [
        path.join(dirtyReleaseApp, 'release', 'build-macos-internal.sh'),
        mode,
      ], {
        cwd: dirtyReleaseApp,
        env: { ...process.env, HRBOSS_RELEASE_DATE: '20260815', HRBOSS_RELEASE_REVISION: 'r999' },
        encoding: 'utf8',
      });
      assert.notEqual(dirtyBuild.status, 0, `${mode} must reject a dirty source repository`);
      assert.match(
        `${dirtyBuild.stderr || ''}${dirtyBuild.stdout || ''}`,
        /Refusing to build or publish a Mac HR artifact from a dirty worktree/,
      );
    }
    assert.equal(
      fs.existsSync(path.join(dirtyReleaseApp, 'dist')),
      false,
      'dirty Mac publish must stop before creating staging or deliverable paths',
    );
    for (const [script, extraEnv] of [
      ['build-development-source.sh', {}],
    ]) {
      const invalid = spawnSync('bash', [path.join(PROJECT_ROOT, 'release', script)], {
        cwd: PROJECT_ROOT,
        env: { ...process.env, HRBOSS_RELEASE_DATE: '../../../escape', ...extraEnv },
        encoding: 'utf8',
      });
      assert.notEqual(invalid.status, 0, `${script} must reject path-like release inputs before writing artifacts`);
      assert.match(`${invalid.stderr || ''}${invalid.stdout || ''}`, /must contain exactly 8 digits/);
    }
  }
  assert.match(macReleaseSource, /lipo -archs/, 'Mac release must inspect packaged binary architectures');
  assert.match(macReleaseSource, /main_binary.*arm64/, 'Mac release must require an arm64 main executable');
  assert.match(macReleaseSource, /sqlite_binary.*arm64/, 'Mac release must require an arm64 better-sqlite3 binary');
  assert.match(macReleaseSource, /resources_root\/data/, 'Mac release must reject packaged data trees');
  assert.match(macReleaseSource, /resources_root\/tmp/, 'Mac release must reject packaged tmp trees');
  assert.match(macReleaseSource, /HRBOSS_PACKAGED_SQLITE_MODULE=.*ELECTRON_RUN_AS_NODE=1.*main_binary/, 'Mac release must load packaged SQLite with packaged Electron');
  assert.match(macReleaseSource, /absolute symlink/, 'Mac release must reject absolute package symlinks');
  assert.match(macReleaseSource, /symlink escapes Resources\/app/, 'Mac release must reject escaping package symlinks');
  assert.match(macReleaseSource, /ditto -x -k.*TMP_ZIP/, 'Mac release must extract and revalidate ZIP contents');
  assert.match(macReleaseSource, /hdiutil attach.*TMP_DMG/, 'Mac release must mount and revalidate DMG contents');
  assert.match(macReleaseSource, /mv -n.*PROMOTION_HIDDEN.*destination/, 'Mac publish promotion must not overwrite existing targets');
  assert.deepEqual([...windowsAcceptanceBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Windows PowerShell 5.1 requires a UTF-8 BOM for Chinese paths and messages');
  assert.match(packageJson.scripts['accept:win'], /windows-release-self-test\.ps1/, 'package scripts must expose the Windows acceptance entry point');
  assert.match(windowsAcceptanceSource, /hrboss_windows_acceptance_v1/, 'Windows evidence must use a versioned machine-readable schema');
  assert.match(windowsAcceptanceSource, /RequireAuthenticode/, 'formal Windows acceptance must support a hard Authenticode gate');
  assert.match(windowsAcceptanceSource, /S-1-1-0:\(OI\)\(CI\)F/, 'Windows acceptance must prove reset of a pre-existing Everyone ACL');
  assert.match(windowsAcceptanceSource, /Invoke-DatabaseProbe -Mode write/, 'Windows acceptance must write SQLite through the packaged Electron runtime');
  assert.match(windowsAcceptanceSource, /Invoke-DatabaseProbe -Mode read/, 'Windows acceptance must verify SQLite persistence after restart');
  assert.match(windowsAcceptanceSource, /Start-IsolatedApplication -Cycle 2/, 'Windows acceptance must perform a restart cycle');
  assert.match(windowsAcceptanceSource, /RUN-LOOPBACK-2/, 'Windows acceptance must re-check local-only service bindings after restart');
  assert.match(windowsAcceptanceSource, /HRBOSS_EXTERNAL_AI_ENABLED' -Value '0'/, 'Windows acceptance must disable external AI');
  assert.match(windowsAcceptanceSource, /BOSS_ACTION_AUTOMATION_ENABLED' -Value '0'/, 'Windows acceptance must disable Boss automation');
  assert.match(windowsChecklist, /不得为了测试主动制造真实 `code=36`/, 'real-account acceptance must not provoke Boss risk controls');
  assert.match(windowsChecklist, /整个数据目录备份/, 'release acceptance must cover migration backup and restore');
  assert.match(windowsChecklist, /GO WITH CONDITIONS/, 'release acceptance must record an explicit release decision');
  assert.equal(fs.existsSync(path.join(PROJECT_ROOT, 'release', 'PORTABLE-README.md')), true, 'portable Windows handoff instructions must exist');
  assert.equal(fs.existsSync(path.join(PROJECT_ROOT, 'release', 'START-ZhaocaiGuan.cmd')), true, 'portable Windows handoff must include a launcher');
  assert.equal(fs.existsSync(path.join(PROJECT_ROOT, '_smoke.js')), false, 'legacy paid scoring smoke script must be removed');

  const {
    issueExternalAiAuthorization,
    consumeExternalAiAuthorization,
  } = require("../src/external-ai-authorization");
  assert.throws(() => issueExternalAiAuthorization({ purpose: 'deep-profile', confirmed: false }), /明确/);
  const oneTime = issueExternalAiAuthorization({ purpose: 'deep-profile', confirmed: true });
  assert.equal(consumeExternalAiAuthorization(oneTime, 'deep-profile').purpose, 'deep-profile');
  assert.throws(() => consumeExternalAiAuthorization(oneTime, 'deep-profile'), /缺少/, 'authorization must be single use');
  const wrongPurpose = issueExternalAiAuthorization({ purpose: 'deep-profile', confirmed: true });
  assert.throws(() => consumeExternalAiAuthorization(wrongPurpose, 'candidate-assessment'), /缺少/);


  const db = require("../src/db");
  await assert.rejects(() => db.generateDeepProfileForJob(1), /一次性.*授权/);
  await assert.rejects(() => db.runSecondOpinion('candidate'), /一次性.*授权/);
  assert.equal(
    fs.readFileSync(DEFAULT_DB_SENTINEL, 'utf8'),
    DEFAULT_DB_SENTINEL_CONTENT,
    'unauthorized external-AI checks must reject before opening or modifying the injected default DB sentinel',
  );

  const { buildEvidenceProfile } = require("../src/candidate-report-v1");
  const evidence = db.redactKnownCandidateName(buildEvidenceProfile({
    basic: [{
      name: '张三',
      age: '28岁',
      description: '候选人张 三，28岁，期望薪资1-1.5万元，毕业于隐私测试大学，身份证110101199001011234，微信号 wx_abc123，住址杭州市西湖区。',
    }],
    expect: [{ salary: '1-1.5万元' }],
    edu: [{ school: '隐私测试大学', tags: ['双一流'] }],
    skill: [{ text: '张三，1-1.5万元，隐私测试大学，RPA 自动化。' }],
  }), '张三');
  const evidenceText = JSON.stringify(evidence);
  for (const forbidden of ['张 三', '1-1.5万元', '隐私测试大学', '110101199001011234', 'wx_abc123', '杭州市西湖区']) {
    assert.doesNotMatch(evidenceText, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `external evidence must remove ${forbidden}`);
  }

  // 健康接口不能在数据库不存在时伪报 200。
  const port = 18500 + (process.pid % 500);
  const missingDb = path.join(ROOT, 'missing', 'does-not-exist.db');
  fs.mkdirSync(path.dirname(missingDb), { recursive: true, mode: 0o700 });
  const dbServer = spawn(process.execPath, [path.join(PROJECT_ROOT, "src/db-server.js")], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      BOSS_DB_PATH: missingDb,
      BOSS_READONLY_PORT: String(port),
      HRBOSS_LOCAL_API_TOKEN: TOKEN,
      HRBOSS_LOCAL_API_INSTANCE_ID: 'release-security-health',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(dbServer, `http://127.0.0.1:${port}`);
    const health = await getJson(port, '/api/health');
    assert.equal(health.status, 500, 'health must fail when the database cannot be opened');
  } finally {
    dbServer.kill('SIGTERM');
    await waitForExit(dbServer).catch(() => {});
  }

  // POSIX 上用假的 rec 验证 SIGTERM 不会进入转写，且未完成录音被删除。
  if (process.platform !== 'win32') {
    const binDir = path.join(ROOT, 'bin');
    const outDir = path.join(ROOT, 'interview');
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
    const rec = path.join(binDir, 'rec');
    fs.writeFileSync(rec, '#!/bin/sh\ntrap "exit 0" INT TERM HUP\nwhile :; do sleep 1; done\n', { mode: 0o700 });
    const recorder = spawn(process.execPath, [
      path.join(PROJECT_ROOT, "src/local-interview-p0.js"),
      '--record',
      '--topic', 'release-security-abort',
      '--out-dir', outDir,
    ], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        HRBOSS_INTERVIEW_OUTPUT_DIR: outDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    recorder.kill('SIGTERM');
    const exit = await waitForExit(recorder);
    assert.equal(exit.code, 130, 'privacy abort should use a distinct non-success exit code');
    assert.equal(fs.existsSync(path.join(outDir, 'recording.wav')), false, 'privacy abort must remove incomplete audio');
    assert.equal(fs.existsSync(path.join(outDir, 'transcript.txt')), false, 'privacy abort must not transcribe');
  }

  console.log('check-release-security ok');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
