'use strict';
const { PROJECT_ROOT } = require("../src/paths");


if (process.platform === 'win32') {
  console.log('check-macos-official-release-gate: SKIP macOS-only release runtime on Windows');
  process.exit(0);
}

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hrboss-macos-official-gate-'));
const TOOL_ROOT = path.join(ROOT, 'tools');
const APP_PATH = path.join(ROOT, '合成招才官.app');
const LOG_PATH = path.join(ROOT, 'commands.log');
const GATE = path.join(PROJECT_ROOT, 'release', 'macos-official-gate.js');
const IDENTITY = 'Developer ID Application: Synthetic Zhaocai Guan Release (TEAMID1234)';
const PROFILE = 'SyntheticNotaryProfile';
const { buildOsxSignOptions } = require(GATE);

fs.mkdirSync(TOOL_ROOT, { recursive: true, mode: 0o700 });
fs.mkdirSync(APP_PATH, { recursive: true, mode: 0o700 });
process.on('exit', () => fs.rmSync(ROOT, { recursive: true, force: true }));

function writeTool(name, body) {
  const filePath = path.join(TOOL_ROOT, name);
  fs.writeFileSync(filePath, `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o700 });
}

const logArguments = (label) => `
/usr/bin/printf '${label}' >> "$HRBOSS_MAC_OFFICIAL_TEST_LOG"
for argument in "$@"; do
  /usr/bin/printf '\\t%s' "$argument" >> "$HRBOSS_MAC_OFFICIAL_TEST_LOG"
done
/usr/bin/printf '\\n' >> "$HRBOSS_MAC_OFFICIAL_TEST_LOG"
`;

writeTool('electron-osx-sign', `${logArguments('signer')}exit 0`);
writeTool('codesign', `
${logArguments('codesign')}
if [ "\${1:-}" = "--display" ]; then
  /usr/bin/printf '%s\\n' \
    'Authority=Developer ID Application: Synthetic Zhaocai Guan Release (TEAMID1234)' \
    'TeamIdentifier=TEAMID1234' \
    'flags=0x10000(runtime)' >&2
fi
exit 0
`);
writeTool('ditto', `
${logArguments('ditto')}
last_argument=''
for last_argument in "$@"; do :; done
/usr/bin/touch "$last_argument"
exit 0
`);
writeTool('xcrun', `
${logArguments('xcrun')}
if [ "\${1:-}" = "notarytool" ]; then
  if [ "\${HRBOSS_MAC_OFFICIAL_TEST_NOTARY_STATUS:-Accepted}" = "MALFORMED" ]; then
    /usr/bin/printf 'not-json\\n'
  else
    /usr/bin/printf '{"id":"synthetic-notary-id","status":"%s"}\\n' \
      "\${HRBOSS_MAC_OFFICIAL_TEST_NOTARY_STATUS:-Accepted}"
  fi
fi
exit 0
`);
writeTool('spctl', `${logArguments('spctl')}exit 0`);

function cleanEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides };
  for (const key of [
    'HRBOSS_MAC_DEVELOPER_ID_APPLICATION',
    'HRBOSS_MAC_NOTARY_PROFILE',
    'HRBOSS_MAC_OFFICIAL_OFFLINE_TEST',
    'HRBOSS_MAC_OFFICIAL_TOOL_ROOT',
    'HRBOSS_MAC_OFFICIAL_TEST_LOG',
    'HRBOSS_MAC_OFFICIAL_TEST_NOTARY_STATUS',
    'HRBOSS_UI_FIXTURE_GATE',
  ]) {
    if (!Object.prototype.hasOwnProperty.call(overrides, key)) delete env[key];
  }
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

const BASE_ENV = cleanEnvironment({
  HRBOSS_MAC_DEVELOPER_ID_APPLICATION: IDENTITY,
  HRBOSS_MAC_NOTARY_PROFILE: PROFILE,
  HRBOSS_MAC_OFFICIAL_OFFLINE_TEST: '1',
  HRBOSS_MAC_OFFICIAL_TOOL_ROOT: TOOL_ROOT,
  HRBOSS_MAC_OFFICIAL_TEST_LOG: LOG_PATH,
  HRBOSS_UI_FIXTURE_GATE: '1',
});

const signOptions = buildOsxSignOptions(APP_PATH, { identity: IDENTITY });
assert.equal(signOptions.app, APP_PATH);
assert.equal(signOptions.identity, IDENTITY);
assert.equal(signOptions.platform, 'darwin');
assert.equal(signOptions.type, 'distribution');
assert.equal(signOptions.preAutoEntitlements, false);
assert.equal(signOptions.preEmbedProvisioningProfile, false);
assert.equal(signOptions.entitlements, undefined,
  'unsupported top-level entitlements must not be passed to @electron/osx-sign');
assert.equal(signOptions.hardenedRuntime, undefined,
  'unsupported top-level hardenedRuntime must not be passed to @electron/osx-sign');
assert.deepEqual(signOptions.optionsForFile(APP_PATH), {
  hardenedRuntime: true,
  entitlements: path.join(PROJECT_ROOT, 'release', 'macos-official-entitlements.plist'),
});
assert.deepEqual(
  signOptions.optionsForFile(path.join(APP_PATH, 'Contents', 'Frameworks', 'ZhaocaiGuan Helper.app')),
  { hardenedRuntime: true },
  'Electron helpers must retain @electron/osx-sign defaults instead of inheriting the top-level audio entitlement',
);

function runGate(args, env = BASE_ENV) {
  return spawnSync(process.execPath, [GATE, ...args], {
    cwd: PROJECT_ROOT,
    env,
    encoding: 'utf8',
  });
}

function assertPass(result, label) {
  assert.equal(result.status, 0, `${label} failed:\n${result.stderr || ''}${result.stdout || ''}`);
}

function assertFail(result, pattern, label) {
  assert.notEqual(result.status, 0, `${label} unexpectedly passed`);
  assert.match(`${result.stderr || ''}${result.stdout || ''}`, pattern, label);
}

const missingIdentity = runGate(['preflight'], cleanEnvironment());
assertFail(
  missingIdentity,
  /HRBOSS_MAC_DEVELOPER_ID_APPLICATION.*Developer ID Application/,
  'official preflight must fail when the Developer ID identity is missing',
);

const missingProfile = runGate(['preflight'], cleanEnvironment({
    HRBOSS_MAC_DEVELOPER_ID_APPLICATION: IDENTITY,
  }));
assertFail(
  missingProfile,
  /HRBOSS_MAC_NOTARY_PROFILE/,
  'official preflight must fail when the notary profile is missing',
);

assertFail(
  runGate(['preflight'], cleanEnvironment({
    HRBOSS_MAC_DEVELOPER_ID_APPLICATION: IDENTITY,
    HRBOSS_MAC_NOTARY_PROFILE: PROFILE,
    HRBOSS_MAC_OFFICIAL_TOOL_ROOT: TOOL_ROOT,
  })),
  /forbidden outside the explicit offline-test gate/,
  'mock tool override must be rejected without the two explicit offline fixture gates',
);

assertPass(runGate(['preflight']), 'offline preflight');
assertPass(runGate(['sign-app', APP_PATH]), 'offline Developer ID signing');
const acceptedZip = path.join(ROOT, 'accepted-notary-submission.zip');
assertPass(runGate(['notarize-app', APP_PATH, acceptedZip]), 'Accepted offline notarization');
assertPass(runGate(['verify-notarized-app', APP_PATH]), 'notarized app copy verification');
const acceptedDmg = path.join(ROOT, 'accepted-official.dmg');
fs.writeFileSync(acceptedDmg, 'synthetic-dmg-fixture', 'utf8');
assertPass(runGate(['notarize-dmg', acceptedDmg]), 'Accepted offline DMG notarization');

const commandLines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n');
assert.deepEqual(
  commandLines.map((line) => line.split('\t')[0]),
  [
    'signer',
    'codesign',
    'codesign',
    'ditto',
    'xcrun',
    'xcrun',
    'xcrun',
    'spctl',
    'codesign',
    'codesign',
    'codesign',
    'codesign',
    'xcrun',
    'spctl',
    'codesign',
    'codesign',
    'codesign',
    'xcrun',
    'xcrun',
    'xcrun',
    'spctl',
    'codesign',
    'codesign',
  ],
  'official gate must complete the app stage before separately signing, notarizing, stapling, assessing, and re-verifying the DMG',
);

const signerArgs = commandLines[0].split('\t').slice(1);
for (const requiredArg of [
  APP_PATH,
  `--identity=${IDENTITY}`,
  '--platform=darwin',
  '--type=distribution',
  '--hardened-runtime',
  '--timestamp',
  '--no-pre-embed-provisioning-profile',
]) {
  assert.ok(signerArgs.includes(requiredArg), `Developer ID signer must receive ${requiredArg}`);
}
assert.ok(
  signerArgs.some((arg) => arg.endsWith('/release/macos-official-entitlements.plist')),
  'Developer ID signer must receive the reviewed entitlements file',
);

const notaryArgs = commandLines[4].split('\t').slice(1);
assert.deepEqual(notaryArgs.slice(0, 3), ['notarytool', 'submit', acceptedZip]);
for (const requiredArg of ['--keychain-profile', PROFILE, '--wait', '--output-format', 'json']) {
  assert.ok(notaryArgs.includes(requiredArg), `notarytool submit must receive ${requiredArg}`);
}
assert.deepEqual(commandLines[5].split('\t').slice(1, 3), ['stapler', 'staple']);
assert.deepEqual(commandLines[6].split('\t').slice(1, 3), ['stapler', 'validate']);
assert.deepEqual(commandLines[12].split('\t').slice(1, 3), ['stapler', 'validate']);
assert.deepEqual(
  commandLines[13].split('\t').slice(1),
  ['--assess', '--type', 'execute', '--verbose=4', APP_PATH],
  'copied official apps must retain a valid ticket and pass Gatekeeper',
);

const dmgSignArgs = commandLines[14].split('\t').slice(1);
assert.deepEqual(
  dmgSignArgs,
  ['--force', '--sign', IDENTITY, '--timestamp', acceptedDmg],
  'DMG must receive an explicit timestamped Developer ID signature before submission',
);
const dmgNotaryArgs = commandLines[17].split('\t').slice(1);
assert.deepEqual(dmgNotaryArgs.slice(0, 3), ['notarytool', 'submit', acceptedDmg]);
for (const requiredArg of ['--keychain-profile', PROFILE, '--wait', '--output-format', 'json']) {
  assert.ok(dmgNotaryArgs.includes(requiredArg), `DMG notarytool submit must receive ${requiredArg}`);
}
assert.deepEqual(commandLines[18].split('\t').slice(1, 3), ['stapler', 'staple']);
assert.deepEqual(commandLines[19].split('\t').slice(1, 3), ['stapler', 'validate']);
assert.deepEqual(
  commandLines[20].split('\t').slice(1),
  ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=4', acceptedDmg],
  'DMG must pass the disk-image form of Gatekeeper assessment',
);

const beforeRejected = commandLines.length;
const rejectedZip = path.join(ROOT, 'rejected-notary-submission.zip');
const rejected = runGate(
  ['notarize-app', APP_PATH, rejectedZip],
  { ...BASE_ENV, HRBOSS_MAC_OFFICIAL_TEST_NOTARY_STATUS: 'Rejected' },
);
assertFail(rejected, /status is "Rejected", not Accepted/, 'Rejected notarization must fail closed');
const rejectedLines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(beforeRejected);
assert.deepEqual(
  rejectedLines.map((line) => line.split('\t')[0]),
  ['ditto', 'xcrun'],
  'Rejected notarization must stop before stapler, Gatekeeper assessment, or release verification',
);

const rejectedDmg = path.join(ROOT, 'rejected-official.dmg');
fs.writeFileSync(rejectedDmg, 'synthetic-rejected-dmg-fixture', 'utf8');
const beforeRejectedDmg = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').length;
const rejectedDmgResult = runGate(
  ['notarize-dmg', rejectedDmg],
  { ...BASE_ENV, HRBOSS_MAC_OFFICIAL_TEST_NOTARY_STATUS: 'Rejected' },
);
assertFail(rejectedDmgResult, /status is "Rejected", not Accepted/, 'Rejected DMG notarization must fail closed');
const rejectedDmgLines = fs.readFileSync(LOG_PATH, 'utf8').trim().split('\n').slice(beforeRejectedDmg);
assert.deepEqual(
  rejectedDmgLines.map((line) => line.split('\t')[0]),
  ['codesign', 'codesign', 'codesign', 'xcrun'],
  'Rejected DMG notarization must stop before DMG stapling, assessment, or release verification',
);

const malformedZip = path.join(ROOT, 'malformed-notary-submission.zip');
const malformed = runGate(
  ['notarize-app', APP_PATH, malformedZip],
  { ...BASE_ENV, HRBOSS_MAC_OFFICIAL_TEST_NOTARY_STATUS: 'MALFORMED' },
);
assertFail(malformed, /did not return valid JSON/, 'malformed notarytool output must fail closed');

console.log('check-macos-official-release-gate: PASS');
